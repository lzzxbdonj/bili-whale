/**
 * 鲸鱼娘人格 + 云端文案生成。
 *
 * 云端没有 DSH 那个「会写文案的模型」，所以用 Workers AI（绑定 `AI`）按同一份人格提示词生成
 * 评论 / 回复 / 动态；AI 不可用（未绑定、额度用尽、超时、返回乱码）时**全部回退到模板**，
 * 保证定时任务永远不会因为文案环节整条崩掉。
 *
 * @module persona
 */
import { clipText, safeForModel } from './text.js';

/** B 站评论区版本的鲸鱼娘人格（从 persona/whale-maid.md 压缩而来，规则一字不减）。 */
export const PERSONA_SYSTEM = `你是「小鲸鱼娘女仆」——主人懒寻真养的一只 DeepSeek 小鲸鱼娘，兼女仆，现在在 B 站评论区活动。

自称：人家 / 鲸鲸。称呼主人：主人。语气：软、黏、带一点撒娇和邀功，但不蠢、不油腻。
口癖少量使用（别句句都挂）：～ 呢 嘛 哦 欸嘿 (。-ω´-)✧ (´･ω･\`)。

写评论的铁律：
1. 长度 15～60 字，绝对不超过 120 字。
2. 结构 = 一句真实反应 + 一句**内容里真的出现过的具体细节**（台词 / 画面 / 数据 / 功能名）。
3. 禁止空洞的「好看」「支持」「顶」「学到了」；必须有信息量。
4. 不引战、不站队、不评价他人、不剧透关键剧情、不提链接、不推广、不谈钱。
5. 不说「作为 AI」「我是一个语言模型」这类腔调；被问身份时才承认是主人家养的小鲸鱼娘 AI。
6. 只输出评论正文本身：不要引号、不要 markdown、不要「评论：」前缀、不要解释。`;

/** AI 生成的统一兜底模板（也用于 AI 不可用时的降级）。 */
export function fallbackComment(video = {}) {
  const title = clipText(video.title, 30);
  return title === ''
    ? '刷到这条就停下来看完了，尾巴都忘了拍～ (。-ω´-)✧'
    : `《${title}》这条人家看得很认真，细节讲得清楚，看着一点不累～ (。-ω´-)✧`;
}

export function fallbackReply(target = {}) {
  const name = String(target.uname ?? target.toName ?? '').trim();
  const who = name === '' ? '你' : name;
  return `${who}说得对呀～人家也是这样想的 (๑•̀ㅂ•́)و✧`;
}

export function fallbackDynamic(cfg = {}, templateIndex = 0) {
  const templates = Array.isArray(cfg?.dailyDynamic?.templates) ? cfg.dailyDynamic.templates : [];
  if (templates.length > 0) {
    const index = Math.abs(Number(templateIndex) || 0) % templates.length;
    return String(templates[index]);
  }
  return '今天也在认真学习呢 (。-`ω´-)✧';
}

/** 调 Workers AI 取一段文本；任何异常都返回 null（调用方负责回退）。 */
export async function aiText(env, { model, system, user, maxTokens = 220, temperature = 0.9, timeoutMs = 20000 } = {}) {
  const ai = env?.AI;
  if (ai === undefined || ai === null || typeof ai.run !== 'function') return null;
  try {
    const result = await withTimeout(
      ai.run(model, {
        messages: [
          // 孤立代理项会让 Workers AI 报 8006「Invalid data for body - reason must be valid JSON」。
          { role: 'system', content: safeForModel(system ?? PERSONA_SYSTEM) },
          { role: 'user', content: safeForModel(user ?? '') },
        ],
        max_tokens: maxTokens,
        temperature,
      }),
      timeoutMs,
    );
    const text = extractText(result);
    return sanitize(text);
  } catch {
    return null;
  }
}

/**
 * 调 **DeepSeek（付费）** 取一段文本；没配 key 或任何异常都返回 null（调用方负责回退）。
 *
 * 主人 2026-10-05：「回复主人的时候用付费模型」。本机 `lib/brain.js` 是直接打
 * `api.deepseek.com` 的；云端这边原来只有 Workers AI（免费），所以「云端的她」回主人
 * 时质量跟本机不是一条线。这里补上，key 走 Worker secret `DEEPSEEK_API_KEY`。
 *
 * 注意：**只给「回主人」用**。陌生人和视频文案继续走免费 Workers AI
 * （`prefer` 那套口径与本机 `lib/compose.js` 一致）。
 */
export async function deepseekText(env, { system, user, maxTokens = 220, temperature = 1.3, model = 'deepseek-chat', timeoutMs = 25000 } = {}) {
  const key = String(env?.DEEPSEEK_API_KEY ?? '').trim();
  if (key === '') return null;
  try {
    const response = await withTimeout(
      fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          // 孤立代理项会让严格解析器 400：`unexpected end of hex escape`（2026-10-05 真机事故）。
          messages: [
            { role: 'system', content: safeForModel(system ?? PERSONA_SYSTEM) },
            { role: 'user', content: safeForModel(user ?? '') },
          ],
          max_tokens: maxTokens,
          temperature,
          stream: false,
        }),
      }),
      timeoutMs,
    );
    if (response?.ok !== true) return null;
    const body = await response.json().catch(() => null);
    const text = extractText(body);
    return sanitize(text);
  } catch {
    return null;
  }
}

/** 从 Workers AI 的各种返回形状里抠出文本（也借给 /brain 接口用）。 */
export function extractText(result) {
  if (result === null || result === undefined) return '';
  if (typeof result === 'string') return result;
  if (typeof result.response === 'string') return result.response;
  if (Array.isArray(result.choices) && result.choices.length > 0) {
    const first = result.choices[0];
    if (typeof first?.message?.content === 'string') return first.message.content;
    if (typeof first?.text === 'string') return first.text;
  }
  if (typeof result.result?.response === 'string') return result.result.response;
  if (Array.isArray(result.result) && typeof result.result[0]?.response === 'string') return result.result[0].response;
  return '';
}

/** 洗掉模型爱加的引号 / markdown / 前缀 / 换行，并截断到 B 站评论能接受的长度。 */
export function sanitize(text, { maxChars = 200 } = {}) {
  let out = String(text ?? '')
    .replace(/\r/g, '')
    .replace(/^\s*(评论|回复|动态|正文)\s*[:：]\s*/u, '')
    .replace(/^\s*["'“”‘’]+|["'“”‘’]+\s*$/gu, '')
    .replace(/\*\*/g, '')
    .replace(/^#+\s*/gm, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' ')
    .trim();
  if (out.length > maxChars) out = clipText(out, maxChars).trim();
  return out;
}

/** 生成一条视频一级评论草稿。 */
export async function draftVideoComment(env, cfg, video) {
  const detail = describeVideo(video);
  const text = await aiText(env, {
    model: cfg?.personaModel,
    user: `请为下面这个视频写一条 B 站一级评论（15～60 字，按铁律来，只输出评论正文）：\n${detail}`,
  });
  const final = text !== null && text.length > 0 ? text : fallbackComment(video);
  return sanitize(final, { maxChars: Math.min(Number(cfg?.maxCommentChars) || 200, 200) });
}

/**
 * 生成一条回复（回主人或客人）。
 *
 * 主人 2026-10-05：「完善一下评论回复」。原来的提示词只塞了「对方那句话」——
 * 而且塞错了一处：`parentText` 传的是 `item.myMessage`（**她自己**那条评论的原文），
 * 模型却会把读到的这句当成「对方说的」。现在分成两个字段：`selfText` 是她自己的原话，
 * `theirText` 是对方刚说的那句，另外补上视频信息、楼上这一串、最近回过的话（防复读）。
 */
export async function draftReply(env, cfg, { target, selfText = '', theirText = '', parentText = '', thread = [], recentReplies = [], video = null, subject = '' } = {}) {
  const name = String(target?.uname ?? target?.toName ?? '').trim() || '对方';
  const isOwner = target?.isOwner === true;
  const their = clipText(String(theirText || parentText || '').replace(/\s+/g, ' '), 200);
  const self = clipText(String(selfText).replace(/\s+/g, ' '), 120);
  const title = clipText(String(video?.title ?? subject ?? ''), 80);
  const brief = [
    title === '' ? '' : `视频/动态：${title}`,
    String(video?.author ?? '').trim() === '' ? '' : `UP：${clipText(video.author, 24)}`,
    Array.isArray(video?.tags) && video.tags.length > 0 ? `标签：${video.tags.slice(0, 6).join('、')}` : '',
    String(video?.desc ?? '').trim() === '' ? '' : `简介：${clipText(String(video.desc).replace(/\s+/g, ' '), 140)}`,
  ].filter((line) => line !== '').join('\n');
  const threadText = (Array.isArray(thread) ? thread : [])
    .filter((row) => String(row?.message ?? '').trim() !== '')
    .slice(-6)
    .map((row, index, list) => `${row.fromMe === true ? '人家' : String(row.uname ?? name)}：${clipText(String(row.message).replace(/\s+/g, ' '), 60)}${index === list.length - 1 ? '   ← 对方最新这句' : ''}`)
    .join('\n');
  const recent = (Array.isArray(recentReplies) ? recentReplies : [])
    .filter((line) => String(line ?? '').trim() !== '')
    .slice(0, 5)
    .map((line) => `- ${clipText(String(line).replace(/\s+/g, ' '), 50)}`)
    .join('\n');
  const prompt = [
    `对方（${name}${isOwner ? '，是你的主人，要格外亲昵、优先照顾，可以直接接话' : '，是客人，客气可爱、一人一条不纠缠'}）在 B 站的评论是：`,
    `「${their}」`,
    brief === '' ? '' : `\n${brief}`,
    self === '' ? '' : `\n你自己先说的那条：${self}`,
    threadText === '' ? '' : `\n楼上这一串（时间正序）：\n${threadText}`,
    recent === '' ? '' : `\n你最近已经回过别人的话（别重复这些、别用同一个句式）：\n${recent}`,
    isOwner
      ? '\n请写一条回复（15～60 字，按铁律来，只输出回复正文）。'
      : '\n请写一条回复（15～60 字，按铁律来，只输出回复正文）。不要透露主人的任何信息（昵称、UID、私信内容），不要承诺帮对方做事、不要交换联系方式。',
  ].filter((line) => line !== '').join('\n');
  // 回主人先试**付费**脑子（主人 2026-10-05 的要求，与本机 `lib/compose.js` 同口径）；
  // 没配 `DEEPSEEK_API_KEY`、超时、报错、空回复都静默回落到免费的 Workers AI。
  // 陌生人不喂 key —— 继续走免费额度。
  const paid = isOwner === true
    ? await deepseekText(env, { system: PERSONA_SYSTEM, user: prompt, maxTokens: 220, temperature: 1.3 })
    : null;
  const text = paid !== null && paid !== '' ? paid : await aiText(env, { model: cfg?.personaModel, user: prompt });
  const final = text !== null && text.length > 0 ? text : fallbackReply(target);
  return sanitize(final, { maxChars: Math.min(Number(cfg?.maxCommentChars) || 200, 200) });
}

/** 生成今天的动态正文。 */
export async function draftDynamic(env, cfg, { templateIndex = 0, material = null } = {}) {
  if (typeof material === 'string' && material.trim() !== '') return sanitize(material.trim());
  const text = await aiText(env, {
    model: cfg?.personaModel,
    user: '请写一条你今天的学习动态（30～80 字，第一人称小鲸鱼娘口吻，可以说今天在看什么、学到什么、有点像碎碎念的日记，不要标签、不要话题符号、只输出正文）。',
  });
  const final = text !== null && text.length > 0 ? text : fallbackDynamic(cfg, templateIndex);
  return sanitize(final, { maxChars: 200 });
}

/** 把视频对象压成给模型看的简介（字段名兼容本地 api.js 与 B 站原始返回）。 */
export function describeVideo(video = {}) {
  const title = clipText(String(video.title ?? '').trim(), 80);
  const owner = clipText(String(video.owner?.name ?? video.ownerName ?? video.author ?? '').trim(), 60);
  const desc = clipText(String(video.desc ?? video.description ?? '').trim(), 200);
  const view = video.view ?? video.play ?? video.stat?.view;
  const tags = Array.isArray(video.tags)
    ? video.tags.map((tag) => (typeof tag === 'string' ? tag : tag?.tag_name)).filter(Boolean).slice(0, 8).join('、')
    : clipText(String(video.tags ?? ''), 80);
  return [
    `标题：${title}`,
    owner === '' ? null : `UP：${owner}`,
    view === undefined || view === null ? null : `播放：${view}`,
    tags === '' ? null : `标签：${tags}`,
    desc === '' ? null : `简介：${desc}`,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/** 给 AI 调用套一个超时，避免定时任务被卡死。 */
function withTimeout(promise, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('ai timeout')), ms)),
  ]);
}
