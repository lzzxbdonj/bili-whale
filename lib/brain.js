/**
 * 小鲸鱼娘的「脑子」：在本机调用 DeepSeek，把私信回复从模板升级成真话。
 *
 * 为什么放在本机而不是云端：B 站风控把 Cloudflare 机房 IP 整段拦死（-412），
 * 所以「读私信 / 发私信」必须由这台机器做；而机器上现成就有主人的 API Key，
 * 于是让本机既动嘴（发送）也动脑（生成）。
 *
 * 安全与成本：
 *   - 只在**主人发来私信**时调用（陌生人只回一条固定礼貌语，不烧 API）；
 *   - 配额、最小间隔、屏蔽词仍由 policy 把关，本模块不做策略判断；
 *   - 任何失败（没 key / 超时 / 接口报错）都返回 null，调用方回退模板，绝不因此不发消息。
 *
 * @module dsh-bilibili-whale/brain
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { appendLog } from './config.js';

const DEFAULT_BRAIN = {
  enabled: true,
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: '',
  maxTokens: 300,
  temperature: 1.3,
  timeoutMs: 25000,
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

/** 归一化 brain 配置（配置里给什么覆盖什么）。 */
export function brainConfig(cfg = {}) {
  const merged = { ...DEFAULT_BRAIN, ...(cfg.brain ?? {}) };
  merged.apiKey = resolveApiKey(merged);
  merged.enabled = merged.enabled !== false && merged.apiKey !== '';
  merged.baseUrl = String(merged.baseUrl ?? DEFAULT_BRAIN.baseUrl).replace(/\/+$/, '');
  merged.model = String(merged.model ?? DEFAULT_BRAIN.model);
  return merged;
}

/**
 * 问一次模型，返回纯文本。
 *
 * @returns {Promise<string|null>} 失败一律 null（调用方回退模板）。
 */
export async function askBrain(cfg, { system, user, maxTokens, temperature } = {}) {
  const brain = brainConfig(cfg);
  if (brain.enabled !== true) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), brain.timeoutMs);
  try {
    const response = await fetch(`${brain.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${brain.apiKey}`,
      },
      body: JSON.stringify({
        model: brain.model,
        messages: [
          { role: 'system', content: String(system ?? '') },
          { role: 'user', content: String(user ?? '') },
        ],
        max_tokens: Number(maxTokens ?? brain.maxTokens),
        temperature: Number(temperature ?? brain.temperature),
        stream: false,
      }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (response.ok !== true) {
      appendLog('brain.log', `askBrain http ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
      return null;
    }
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || text.trim() === '') {
      appendLog('brain.log', `askBrain 空回复：${JSON.stringify(body).slice(0, 300)}`);
      return null;
    }
    return text.trim();
  } catch (error) {
    appendLog('brain.log', `askBrain 失败：${error.message}`);
    return null;
  } finally {
    clearTimeout(timer);
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
export async function draftDmReply({ cfg, messages = [], talkerName = '主人', extra = '' } = {}) {
  const history = messages
    .slice(-10)
    .map((item) => `${item.fromMe === true ? '人家' : String(item.uname ?? talkerName)}：${String(item.text ?? '').trim()}`)
    .filter((line) => line.replace(/^(人家|.+?)：/, '').trim() !== '')
    .join('\n');
  if (history === '') return null;
  const lastIncoming = [...messages].reverse().find((item) => item.fromMe !== true);
  const system = [
    loadPersona(cfg?.persona ?? 'whale-maid'),
    '',
    '## 现在的任务：回一条 B 站私信',
    `- 对方是**主人**（B 站昵称 ${talkerName}），这是私信窗口，不是评论区。`,
    '- 只输出**要发出去的那一条正文**，不要引号、不要解释、不要 Markdown、不要分行。',
    `- 长度不超过 ${Number(cfg?.policy?.maxCommentChars ?? 200)} 字，像真人发微信一样短、自然、接得上对方上一句。`,
    '- 主人问什么就先答什么，答完可以带一点点撒娇或邀功，但不要反问连篇。',
    extra === '' ? '' : `- 补充上下文：${extra}`,
  ].join('\n');
  const user = [
    '最近的这会话记录（时间正序）：',
    history,
    '',
    `主人刚说的是：「${String(lastIncoming?.text ?? '').trim()}」`,
    '现在写你要回的那条私信正文。',
  ].join('\n');
  const text = await askBrain(cfg, { system, user });
  if (text === null) return null;
  const tidy = tidyReply(text, cfg?.policy?.maxCommentChars ?? 200);
  return tidy === '' ? null : tidy;
}
