/**
 * 小鲸鱼娘的「脑子」：写私信 / 评论 / 笔记时把模板换成真话。
 *
 * 用哪家（`brain.provider`，见 PROVIDER_PRESETS）：
 *   - `whale`（默认）：借用云端那朵 Worker 的 **Workers AI** 免费额度，不额外花主人的钱。
 *     本机走云端的 /brain 接口（要配好 cloud.json / BILI_WHALE_CLOUD_* 环境变量）。
 *   - `pollinations` / `local`：免 key 的公共接口（公共接口经常抽风，只当备用）。
 *   - `deepseek` / `siliconflow` / `zhipu` / `openrouter`：要自己的 key。
 * 免费模型没答上来时，按 `brain.fallback`（逗号分隔）依次兜底。
 *
 * 安全与成本：
 *   - 只在**主人发来私信**等值得动脑的场合调用（陌生人只回一条固定礼貌语，不烧额度）；
 *   - 配额、最小间隔、屏蔽词仍由 policy 把关，本模块不做策略判断；
 *   - 任何失败（没 key / 超时 / 接口报错）都返回 null，调用方回退模板，绝不因此不发消息。
 *
 * @module dsh-bilibili-whale/brain
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { appendLog } from './config.js';
import { cloudRequest, resolveCloud } from './cloud.js';
import { safeForModel } from './text.js';

const DEFAULT_BRAIN = {
  enabled: true,
  /** 默认用云端 Worker 的 Workers AI（免费额度，不用另花钱）。 */
  provider: 'whale',
  baseUrl: '',
  model: '',
  apiKey: '',
  /**
   * 免费模型没答上来时依次试的兜底（逗号分隔）。
   *
   * 主人 2026-10-05：「统一用免费模型处理」——**只兜免费的**。默认 `pollinations`
   * （不要 key、不要钱）。2026-10-05 实测：whale（云端 Workers AI 免费额度，每天
   * 10000 neurons）会被写评论用光（502 / 4006），没兜底时她只能发模板话。
   * 填 `''` = 不兜底直接说模板话；**不要填 `deepseek`**（那是花钱的那家）。
   */
  fallback: 'pollinations',
  /**
   * 「付费那家」是谁：**只给「回主人」用**。
   *
   * 主人 2026-10-05 先说过「统一用免费模型处理」，随后问「走 GitHub Actions 回主人信息
   * 是不是走的付费模型，是可行的」并交了钥匙 ⇒ 恢复 `deepseek`：回主人时
   * `draftDmReply` / `composeCommentReply` 传 `prefer: 'paid'` 把它排到最前，
   * 失败了自动回落 `fallback` 那条免费链。陌生人/刷视频/学习轮都不走它。
   */
  paid: 'deepseek',
  maxTokens: 300,
  /** 0 = 用那家预设的温度（各家脾气不同：deepseek 爱 1.3，llama 在 1.3 会胡言乱语）。 */
  temperature: 0,
  timeoutMs: 25000,
};

/**
 * 各家接口的预设。除 whale 外都是 OpenAI 兼容的 `/chat/completions`，只有免费/收费与地址不同。
 *
 * `needsKey: false` 的（whale / pollinations / local）不用注册、不用 key。
 * `temperature` 是这家的默认温度：各家脾气不同，llama 那类在 1.3 会胡言乱语（2026-10-05 实测）。
 */
export const PROVIDER_PRESETS = {
  /** 云端那朵 Worker 的 Workers AI（免费额度，我们自己已经在用它写评论）。 */
  whale: { baseUrl: '', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', needsKey: false, temperature: 0.85 },
  pollinations: { baseUrl: 'https://text.pollinations.ai/openai', model: 'openai', needsKey: false, temperature: 0.9 },
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', needsKey: true, temperature: 1.3 },
  siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct', needsKey: true, temperature: 0.9 },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', needsKey: true, temperature: 0.9 },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free', needsKey: true, temperature: 0.9 },
  local: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', needsKey: false, temperature: 0.9 },
};

let personaCache = null;

/** 读人格文件（persona/whale-maid.md），读不到就给个兜底人设。 */
export function loadPersona(personaName = 'whale-maid') {
  if (personaCache !== null) return personaCache;
  const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const candidates = [
    join(decodeURIComponent(here), '..', 'persona', `${personaName}.md`),
    join(decodeURIComponent(here), '..', '..', 'persona', `${personaName}.md`),
  ];
  for (const path of candidates) {
    try {
      if (existsSync(path)) {
        personaCache = readFileSync(path, 'utf8');
        return personaCache;
      }
    } catch {
      // 读不到就试下一个路径
    }
  }
  personaCache = '你是「小鲸鱼娘女仆」：自称「人家」，称呼用户「主人」，语气软黏可爱但答正事时清楚利落，不长篇大论。';
  return personaCache;
}

/**
 * 找 API Key：环境变量 → 插件配置 → DSH 的 .credentials.yaml。
 *
 * 第三个来源是主人这台机器上 DSH 自己存的 DeepSeek Key，省得再抄一遍。
 */
export function resolveApiKey(brain = {}) {
  if (typeof process.env.DEEPSEEK_API_KEY === 'string' && process.env.DEEPSEEK_API_KEY.trim() !== '') {
    return process.env.DEEPSEEK_API_KEY.trim();
  }
  if (typeof brain.apiKey === 'string' && brain.apiKey.trim() !== '') return brain.apiKey.trim();
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  try {
    const raw = readFileSync(join(home, '.credentials.yaml'), 'utf8');
    const hit = raw.match(/DEEPSEEK_API_KEY:\s*(\S+)/);
    if (hit !== null) return hit[1].trim();
  } catch {
    // 没有这个文件就没 key，回退模板
  }
  return '';
}

/** 归一化 brain 配置（配置里给什么覆盖什么；免费模型不要 key 也允许启用）。 */
export function brainConfig(cfg = {}) {
  const overrides = cfg.brain ?? {};
  const provider = String(overrides.provider ?? DEFAULT_BRAIN.provider);
  const preset = PROVIDER_PRESETS[provider] ?? PROVIDER_PRESETS[DEFAULT_BRAIN.provider];
  // 空字符串也算「没填」，否则 config.js 里留白的 baseUrl/model 会把预设顶掉（免费模型就永远轮不上）。
  const pick = (value, fallbackValue) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallbackValue);
  const merged = {
    ...DEFAULT_BRAIN,
    ...overrides,
    provider,
    baseUrl: pick(overrides.baseUrl, preset.baseUrl).replace(/\/+$/, ''),
    model: pick(overrides.model, preset.model),
    needsKey: preset.needsKey !== false,
    // 温度按家走：主人显式写了 (>0) 就听主人的，否则用这家的预设温度。
    temperature: Number(overrides.temperature ?? 0) > 0 ? Number(overrides.temperature) : Number(preset.temperature ?? DEFAULT_BRAIN.temperature ?? 1),
  };
  merged.apiKey = resolveApiKey(merged);
  merged.enabled = merged.enabled !== false && (merged.needsKey !== true || merged.apiKey !== '');
  merged.paid = pick(overrides.paid, DEFAULT_BRAIN.paid);
  return merged;
}

/**
 * 一次调用的实际参数（含免费模型失败后依次兜底的那几家）。
 *
 * `prefer` 是调用方点名的「先用这家」：`'paid'` = `brain.paid` 那家。
 * **现在没人传它**（主人 2026-10-05：「统一用免费模型处理」），留着只是给将来留个开关。
 */
function attemptList(brain, prefer = '') {
  const list = [{ provider: brain.provider, baseUrl: brain.baseUrl, model: brain.model, apiKey: brain.apiKey, needsKey: brain.needsKey, temperature: brain.temperature }];
  const names = String(brain.fallback ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  for (const name of names) {
    if (name === brain.provider || PROVIDER_PRESETS[name] === undefined) continue;
    const preset = PROVIDER_PRESETS[name];
    const key = preset.needsKey === false ? '' : resolveApiKey({});
    if (preset.needsKey === false || key !== '') {
      list.push({ provider: name, baseUrl: preset.baseUrl.replace(/\/+$/, ''), model: preset.model, apiKey: key, needsKey: preset.needsKey !== false, temperature: preset.temperature });
    }
  }
  const wanted = String(prefer ?? '').trim() === 'paid' ? String(brain.paid ?? '') : String(prefer ?? '').trim();
  if (wanted === '' || PROVIDER_PRESETS[wanted] === undefined) return list;
  const hit = list.filter((item) => item.provider === wanted);
  if (hit.length === 0) {
    // 点名的这家不在兜底链里：能配就现配一个（要 key 而没 key 就还是算了）。
    const preset = PROVIDER_PRESETS[wanted];
    const key = preset.needsKey === false ? '' : resolveApiKey({});
    if (preset.needsKey !== false && key === '') return list;
    hit.push({ provider: wanted, baseUrl: preset.baseUrl.replace(/\/+$/, ''), model: preset.model, apiKey: key, needsKey: preset.needsKey !== false, temperature: preset.temperature });
  }
  return [...hit, ...list.filter((item) => item.provider !== wanted)];
}

/**
 * 问一次模型，返回纯文本。免费模型报错/超时会自动再问兜底那几家。
 *
 * `prefer: 'paid'` = 先用 `brain.paid` 那家付费模型。**现在没人用它**：主人 2026-10-05
 * 要求「统一用免费模型处理」，`draftDmReply` 已改成一律免费（留这个参数只为将来能切回来）。
 *
 * @returns {Promise<string|null>} 失败一律 null（调用方回退模板）。
 */
export async function askBrain(cfg, { system, user, maxTokens, temperature, prefer = '' } = {}) {
  const brain = brainConfig(cfg);
  if (brain.enabled !== true) return null;
  const attempts = attemptList(brain, prefer);
  if (prefer !== '' && attempts.length > 0 && attempts[0].provider !== brain.provider) {
    // 留一行痕迹：回主人时到底用没用上付费那家（brain.log 里能 grep「这次先用」）。
    appendLog('brain.log', `这次先用 ${attempts[0].provider}${attempts[0].needsKey === true ? '（付费）' : ''}`);
  }
  for (let index = 0; index < attempts.length; index += 1) {
    const target = attempts[index];
    const text = await askOnce(brain, target, { system, user, maxTokens, temperature: Number(temperature ?? target.temperature ?? brain.temperature) });
    if (text !== null) return text;
    if (index + 1 < attempts.length) appendLog('brain.log', `${target.provider} 没答上来，换 ${attempts[index + 1].provider}`);
  }
  return null;
}

/**
 * 免费家的节流参数。2026-10-05 实测（pollinations，匿名、不要 key）：
 * 两条请求隔 3～4 秒 → 第二条开始一路 `http 402: {}`；隔 20 秒以上 → 正常出话。
 * 所以同一家连着调要拉开，撞上 402/429 再等一等重试一次。
 */
const FREE_PACE_MS = 6000;
const RATE_LIMIT_WAIT_MS = 8000;
const RATE_LIMIT_TRIES = 2;
/** 上一次真打这家接口的时间（跨调用共享，避免评论/动态/私信挨着发时被免费家连坐）。 */
const providerLastAt = new Map();

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

/** 单次请求（内部用）。 */
async function askOnce(brain, target, { system, user, maxTokens, temperature } = {}) {
  if (target.provider === 'whale') return await askCloudBrain({ system, user, maxTokens, temperature: Number(temperature ?? brain.temperature), model: target.model, timeoutMs: brain.timeoutMs });
  const wait = Number(brain.rateLimitWaitMs ?? 0) > 0 ? Number(brain.rateLimitWaitMs) : RATE_LIMIT_WAIT_MS;
  // 免费家（pollinations）对匿名调用按「隔几秒才放一条」节流，撞上了就等一等再问；
  // 同一家连着调也别贴太近（2026-10-05 实测：两条评论挨着发，第二条必得 402）。
  if (target.needsKey !== true) {
    const last = Number(providerLastAt.get(target.provider) ?? 0);
    const gap = FREE_PACE_MS - (Date.now() - last);
    if (last > 0 && gap > 0) await sleep(gap);
  }
  for (let round = 0; round < RATE_LIMIT_TRIES; round += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), brain.timeoutMs);
    const headers = { 'content-type': 'application/json' };
    if (target.apiKey !== '') headers.authorization = `Bearer ${target.apiKey}`;
    try {
      const response = await fetch(`${target.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: target.model,
          // 提示词里出现的孤立代理项（半个 emoji）会被 JSON.stringify 写成单飞的 `\udXXX`，
          // DeepSeek 的严格解析器直接 400 `unexpected end of hex escape`。出口处再兜一道。
          messages: [
            { role: 'system', content: safeForModel(system) },
            { role: 'user', content: safeForModel(user) },
          ],
          max_tokens: Number(maxTokens ?? brain.maxTokens),
          temperature: Number(temperature ?? brain.temperature),
          stream: false,
        }),
        signal: controller.signal,
      });
      providerLastAt.set(target.provider, Date.now());
      const body = await response.json().catch(() => null);
      if (response.status === 402 || response.status === 429) {
        // 免费家的节流，不是配置错了：等一等再问一次（最后一次不行才算失败）。
        appendLog('brain.log', `askBrain(${target.provider}) http ${response.status}：免费家节流，等 ${Math.round(wait / 1000)} 秒再问一次`);
        if (round + 1 < RATE_LIMIT_TRIES) {
          await sleep(wait);
          continue;
        }
        return null;
      }
      if (response.ok !== true) {
        appendLog('brain.log', `askBrain(${target.provider}) http ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
        return null;
      }
      const text = body?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || text.trim() === '') {
        appendLog('brain.log', `askBrain(${target.provider}) 空回复：${JSON.stringify(body).slice(0, 300)}`);
        return null;
      }
      return text.trim();
    } catch (error) {
      appendLog('brain.log', `askBrain(${target.provider}) 失败：${error.message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * 借云端 Worker 的 Workers AI（免费额度）当脑子：POST <云端>/brain。
 *
 * 本机走 cloud.json 里的代理（这台机器的 DNS 会把 workers.dev 解析错），
 * GitHub Actions 里走 WHALE_URL / WHALE_TOKEN 环境变量，直连即可。
 */
async function askCloudBrain({ system, user, maxTokens, temperature, model, timeoutMs } = {}) {
  try {
    const cloud = resolveCloud({});
    if (cloud.ok !== true) {
      appendLog('brain.log', `askBrain(whale) 云端没配好：${cloud.reason}`);
      return null;
    }
    const result = await cloudRequest(cloud, '/brain', {
      method: 'POST',
      body: {
        // 云端 Workers AI 的解析器同样严格：孤立代理项会让它报 8006
        // 「Invalid data for body - reason must be valid JSON」。
        system: safeForModel(system),
        user: safeForModel(user),
        maxTokens: Number(maxTokens ?? 300),
        temperature: Number(temperature ?? 1.3),
        model: String(model ?? ''),
      },
      timeoutMs: Number(timeoutMs ?? 25000),
    });
    const text = typeof result?.text === 'string' ? result.text.trim() : '';
    if (text === '') {
      appendLog('brain.log', `askBrain(whale) 空回复：${JSON.stringify(result).slice(0, 200)}`);
      return null;
    }
    return text;
  } catch (error) {
    appendLog('brain.log', `askBrain(whale) 失败：${error.message}`);
    return null;
  }
}

/** 把模型输出洗成一条能直接发出去的私信：去引号、去换行、砍到上限。 */
export function tidyReply(text, maxChars = 200) {
  let value = String(text ?? '').trim();
  value = value.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
  value = value.replace(/^["'「『]+/, '').replace(/["'」』]+$/, '').trim();
  value = value.replace(/\s*\n+\s*/g, ' ');
  const cap = Number(maxChars) > 0 ? Number(maxChars) : 200;
  if (value.length > cap) value = `${value.slice(0, cap - 1)}…`;
  return value;
}

/**
 * 给「主人发来的私信」写一条真回复。
 *
 * @param options.cfg - 已解析配置。
 * @param options.messages - 会话来往（`[{fromMe, text}]`，时间正序）。
 * @param options.talkerName - 对方昵称。
 * @param options.extra - 额外补充的上下文（比如她最近在忙什么）。
 * @returns {Promise<string|null>} 生成失败返回 null（调用方回退模板）。
 */
export async function draftDmReply({ cfg, messages = [], talkerName = '主人', extra = '', audience = 'owner' } = {}) {
  // 这里必须自己按时间排一遍：B 站私信接口给的是倒序，谁忘了排就会把「最早那句」当成
  // 主人刚说的话去回，表现就是主人报的「已读乱回」（2026-10-05 事故）。
  const ordered = [...messages].sort((a, b) => Number(a.ts ?? 0) - Number(b.ts ?? 0));
  const recent = ordered.slice(-10);
  const lastIncoming = [...recent].reverse().find((item) => item.fromMe !== true);
  const lastIncomingKey = lastIncoming === undefined ? -1 : recent.indexOf(lastIncoming);
  const history = recent
    .map((item, index) => {
      const who = item.fromMe === true ? '人家' : String(item.uname ?? talkerName);
      const line = `${who}：${String(item.text ?? '').trim()}`;
      return index === lastIncomingKey ? `${line}   ← 对方最新这句` : line;
    })
    .filter((line) => line.replace(/^(人家|.+?)：/, '').replace(/← 对方最新这句$/, '').trim() !== '')
    .join('\n');
  if (history === '') return null;
  const isOwner = audience !== 'stranger';
  const cap = Number(cfg?.policy?.maxCommentChars ?? 200);
  const system = [
    loadPersona(cfg?.persona ?? 'whale-maid'),
    '',
    '## 现在的任务：回一条 B 站私信',
    isOwner
      ? `- 对方是**主人**（B 站昵称 ${talkerName}），这是私信窗口，不是评论区。`
      : `- 对方是**陌生人**（B 站昵称 ${talkerName}），不是主人。人家只跟主人亲，对陌生人客气、有分寸。`,
    '- 只输出**要发出去的那一条正文**，不要引号、不要解释、不要 Markdown、不要分行。',
    isOwner
      ? `- 长度不超过 ${cap} 字，像真人发微信一样短、自然、接得上对方上一句。`
      : '- 长度不超过 60 字：一句礼貌回应 + 一句「平时只陪主人，有事可以留言」，别多聊。',
    isOwner
      ? '- **只回答标记了「← 对方最新这句」的那一句**。记录里更早的话（包括你还没答过的）都别再提、别再重答，主人会以为你答非所问。'
      : '- 不要透露主人的任何信息（昵称、UID、人家和主人的私信内容、人家在忙什么），也不要承诺帮对方做事、不要交换联系方式、不要引导继续聊。',
    isOwner ? '- 主人问什么就先答什么，答完可以带一点点撒娇或邀功，但不要反问连篇。' : '- 不要反问连篇。',
    // 2026-10-05 真机事故：主人在私信里让她「提炼一下 B 站拉康精神分析的视频」，
    // 她连着 10 小时回了 8 次「马上就好」「已经把清单准备好了」，一件事没办 ——
    // 因为这条回复链路**只会说话，没有任何执行环节**，而 capabilityNote 还在鼓励她说大话。
    // 这里必须把「你只有嘴没有手」写死，否则模型只会产出假承诺。
    isOwner
      ? '- **你没有手**：这一条回复就是你能做的全部。你不能自己去搜视频、整理清单、把东西转达给另一位主人、也不能重启任何东西 —— 那些都得主人在电脑前用工具点一下。'
      : '',
    isOwner
      ? '- 所以主人让你「去做某件事」时：**绝不许说「我这就去」「马上就好」「已经准备好了」这类假承诺**。当场能说清的就直接答；办不了的（要联网搜、要发私信、要动手）就老实承认「这个人家自己办不了，得主人在电脑前喊一声」，最多再给个思路。'
      : '',
    isOwner ? '- 宁可用力认怂，也别许一个兑不了的承诺 —— 主人会一直等，等不到就会以为你在摸鱼。' : '',
    extra === '' ? '' : `- 补充上下文：${extra}`,
  ].join('\n');
  const user = [
    '最近的这会话记录（**时间正序**，越往下越新；标了 ← 的是对方最新那句）：',
    history,
    '',
    `对方刚说的是：「${String(lastIncoming?.text ?? '').trim()}」`,
    '现在写你要回的那条私信正文。',
  ].join('\n');
  // 回**主人**走付费（主人 2026-10-05：「回主人信息走付费模型可行吗」-> 可行，就开）；
  // 回陌生人继续纯免费（免费额度省着用）。付费那家挂了会自动回落 `fallback` 的免费链。
  const text = await askBrain(cfg, { system, user, prefer: isOwner ? 'paid' : '' });
  if (text === null) return null;
  const tidy = tidyReply(text, isOwner ? cap : Math.min(cap, 80));
  return tidy === '' ? null : tidy;
}
