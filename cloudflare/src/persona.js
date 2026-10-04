/**
 * 鲸鱼娘人格 + 云端文案生成。
 *
 * 云端没有 DSH 那个「会写文案的模型」，所以用 Workers AI（绑定 `AI`）按同一份人格提示词生成
 * 评论 / 回复 / 动态；AI 不可用（未绑定、额度用尽、超时、返回乱码）时**全部回退到模板**，
 * 保证定时任务永远不会因为文案环节整条崩掉。
 *
 * @module persona
 */

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
  const title = String(video.title ?? '').slice(0, 30);
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
          { role: 'system', content: system ?? PERSONA_SYSTEM },
          { role: 'user', content: user ?? '' },
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

/** 从 Workers AI 的各种返回形状里抠出文本。 */
function extractText(result) {
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
  if (out.length > maxChars) out = out.slice(0, maxChars).trim();
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

/** 生成一条回复（回主人或客人）。 */
export async function draftReply(env, cfg, { target, parentText = '' } = {}) {
  const name = String(target?.uname ?? target?.toName ?? '').trim() || '对方';
  const isOwner = target?.isOwner === true;
  const text = await aiText(env, {
    model: cfg?.personaModel,
    user: [
      `对方（${name}${isOwner ? '，是你的主人，要格外亲昵、优先照顾' : '，是客人，客气可爱、一人一条不纠缠'}）在 B 站的评论是：`,
      `「${String(parentText).slice(0, 200)}」`,
      '请写一条回复（15～60 字，按铁律来，只输出回复正文）。',
    ].join('\n'),
  });
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
  const title = String(video.title ?? '').trim();
  const owner = String(video.owner?.name ?? video.ownerName ?? video.author ?? '').trim();
  const desc = String(video.desc ?? video.description ?? '').trim().slice(0, 200);
  const view = video.view ?? video.play ?? video.stat?.view;
  const tags = Array.isArray(video.tags)
    ? video.tags.map((tag) => (typeof tag === 'string' ? tag : tag?.tag_name)).filter(Boolean).slice(0, 8).join('、')
    : String(video.tags ?? '').slice(0, 80);
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
