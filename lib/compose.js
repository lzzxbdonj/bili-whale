/**
 * 让她「看了视频之后真的说得出话」：把视频内容 + 热评 + 人格交给模型，产出一条能发的留言。
 *
 * 云端巡检器（`cloud/run.mjs`）和命令行都用这一份，避免两处写出两种口吻。
 * 模型不可用时返回 null，调用方可以选择不发（宁可不发，也别发模板垃圾话）。
 *
 * @module dsh-bilibili-whale/compose
 */
import { askBrain, loadPersona, tidyReply } from './brain.js';
import { ownerNames, withOwnerMentions } from './policy.js';

/** 把视频详情压成几行喂给模型（字段按 `BiliClient.video()` 的真实返回，不是原始 API）。 */
function videoBrief(video = {}) {
  const parts = [
    `标题：${String(video.title ?? '').trim()}`,
    `UP：${String(video.author ?? '').trim()}`,
    video.duration ? `时长：${video.duration}` : '',
    video.view ? `播放：${video.view}` : '',
    video.reply ? `评论数：${video.reply}` : '',
    Array.isArray(video.tags) && video.tags.length > 0 ? `标签：${video.tags.slice(0, 8).join('、')}` : '',
    String(video.desc ?? '').trim() !== '' ? `简介：${String(video.desc).trim().slice(0, 200)}` : '',
  ];
  return parts.filter((line) => line !== '').join('\n');
}

/**
 * 给一个视频写一级评论。
 *
 * @param {object} options.cfg - 已解析配置。
 * @param {object} options.video - `bili_video` 的返回（含 title / author / tags / description / stat）。
 * @param {Array} [options.topComments] - 热评（`[{uname, message}]`），用来判断评论区在聊什么。
 * @param {string} [options.extra] - 额外上下文（比如主人刚说过的话）。
 * @returns {Promise<string|null>} 正文（已含 @主人），失败返回 null。
 */
export async function composeVideoComment({ cfg, video, topComments = [], extra = '' } = {}) {
  const maxChars = Number(cfg?.policy?.maxCommentChars ?? 200);
  const hot = topComments
    .slice(0, 6)
    .map((item) => `- ${String(item.uname ?? '').slice(0, 12)}：${String(item.message ?? '').replace(/\s+/g, ' ').slice(0, 60)}`)
    .join('\n');
  const system = [
    loadPersona(cfg?.persona ?? 'whale-maid'),
    '',
    '## 现在的任务：给一个 B 站视频写一条一级评论',
    '- 用她自己的口吻（自称「人家」，称呼用户「主人」），像真人随手留言，不要总结视频、不要复读标题。',
    '- 挑一个真的戳到她的点说（实验好玩、脑洞大、讲得清楚、评论区梗、或者替主人着想），一两句就够。',
    '- 只输出正文，不要引号、不要换行、不要 Markdown、不要话题标签堆砌。',
    `- 正文（含 @主人）不超过 ${maxChars} 字。`,
    extra === '' ? '' : `- 额外背景：${extra}`,
  ].join('\n');
  const user = [
    '视频信息：',
    videoBrief(video),
    hot === '' ? '' : `\n已经有的热评（别抄，最多顺着聊）：\n${hot}`,
    '\n写你要发的那条评论。',
  ].filter((line) => line !== '').join('\n');
  const text = await askBrain(cfg, { system, user });
  if (text === null) return null;
  const tidy = tidyReply(text, maxChars);
  return tidy === '' ? null : withOwnerMentions(cfg, tidy);
}

/** 楼上那一串对话压成几行（时间正序，标出「对方最新这句」）。 */
function threadBrief(thread = [], talkerName = '') {
  const rows = (Array.isArray(thread) ? thread : []).filter((item) => String(item?.message ?? '').trim() !== '');
  if (rows.length === 0) return '';
  const lastIndex = rows.length - 1;
  return rows
    .slice(-8)
    .map((item, index) => {
      const who = item.fromMe === true ? '人家' : String(item.uname ?? talkerName ?? '对方');
      const line = `${who}：${String(item.message).replace(/\s+/g, ' ').slice(0, 80)}`;
      return index === lastIndex || item.isTarget === true ? `${line}   ← 对方最新这句` : line;
    })
    .join('\n');
}

/**
 * 拼「回复一条评论」的提示词。
 *
 * 单独抽出来是为了能离线测：脑子的输出没法测，但**喂进去的上下文**能测，
 * 而「回复接不住话」的毛病十有八九出在上下文缺料（没有她自己的原话、没有楼上对话、
 * 不知道对方是主人还是陌生人、不知道刚刚已经回过谁什么）。
 *
 * @returns {{system: string, user: string, maxChars: number}}
 */
export function buildReplyPrompt({ cfg, video, comment = {}, context = {}, extra = '' } = {}) {
  const policy = cfg?.policy ?? {};
  const maxChars = Number(policy.maxCommentChars ?? 200);
  const isOwner = context.isOwner === true;
  const talker = String(comment?.uname ?? comment?.mid ?? '对方');
  const kind = context.kind === 'dynamic' ? '动态' : '视频';
  const system = [
    loadPersona(cfg?.persona ?? 'whale-maid'),
    '',
    '## 现在的任务：回复 B 站评论区里的一条评论（楼中楼）',
    isOwner
      ? `- 对方是**主人**（B 站昵称 ${talker}）在评论区点了人家。语气亲昵、可以直接接话；主人的话永远优先。`
      : `- 对方是**陌生人**（B 站昵称 ${talker}），不是主人。人家只跟主人亲：客气、有分寸。`,
    '- 直接接住对方那句话，像真人回帖：对方问了什么就正面答什么，对方只是附和就顺着聊一句，不要客套开场、不要复读视频标题。',
    `- 只输出正文，不要引号、不要换行、不要 Markdown、不要话题标签，不超过 ${maxChars} 字。`,
    isOwner
      ? '- 主人的昵称人家会在正文里 @ 上（已经加好了，你自己别再写 @）。'
      : '- 不要透露主人的任何信息（昵称、UID、人家和主人的私信、人家在忙什么），不要 @ 主人（别把主人拖进陌生人的评论串），不要承诺帮对方做事、不要交换联系方式。',
    context.selfText ? `- 「人家先说的那条」是人家自己在这个串里的原话，回复要和它口径一致，别自相矛盾。` : '',
    extra === '' ? '' : `- 额外背景：${extra}`,
  ].filter((line) => line !== '').join('\n');
  const brief = [
    `标题：${String(video?.title ?? context.subject ?? '').slice(0, 80)}`,
    kind === '视频' && String(video?.author ?? '').trim() !== '' ? `UP：${String(video.author).slice(0, 24)}` : '',
    kind === '视频' && Array.isArray(video?.tags) && video.tags.length > 0 ? `标签：${video.tags.slice(0, 6).join('、')}` : '',
    kind === '视频' && String(video?.desc ?? '').trim() !== '' ? `简介：${String(video.desc).replace(/\s+/g, ' ').slice(0, 160)}` : '',
  ].filter((line) => line !== '').join('\n');
  const thread = threadBrief(context.thread, talker);
  const recent = (Array.isArray(context.recentReplies) ? context.recentReplies : [])
    .filter((line) => String(line ?? '').trim() !== '')
    .slice(0, 5)
    .map((line) => `- ${String(line).replace(/\s+/g, ' ').slice(0, 60)}`)
    .join('\n');
  const user = [
    `${kind}信息：`,
    brief,
    context.selfText ? `\n人家先说的那条：${String(context.selfText).replace(/\s+/g, ' ').slice(0, 120)}` : '',
    thread === '' ? '' : `\n楼上这一串（时间正序）：\n${thread}`,
    recent === '' ? '' : `\n人家最近已经回过别人的话（**别重复这些、别用同一个句式**）：\n${recent}`,
    String(context.kb ?? '').trim() === '' ? '' : `\n人家学过、可能用得上的笔记：\n${String(context.kb).trim().slice(0, 600)}`,
    `\n对方（${talker}）说：${String(comment?.message ?? '').replace(/\s+/g, ' ').slice(0, 200)}`,
    '写你要回的那条。',
  ].filter((line) => line !== '').join('\n');
  return { system, user, maxChars };
}

/**
 * 给她回复一条评论时用的正文（回复主人的评论、或别人回头找她说话）。
 *
 * 主人 2026-10-05：「完善一下评论回复」。原来只把「视频标题 + 对方那句话」喂给模型，
 * 于是经常答得空（不知道她自己先说了什么、楼上在聊什么、对方是谁）。现在把
 * 视频简介/标签、她自己那条原话、楼上对话、最近回过的话（防复读）一起喂进去。
 *
 * @param options.context - `{ selfText, thread, recentReplies, isOwner, kind, kb, subject }`。
 * @returns {Promise<string|null>}
 */
export async function composeCommentReply({ cfg, video, comment, context = {}, extra = '', ask = null } = {}) {
  const prompt = buildReplyPrompt({ cfg, video, comment, context, extra });
  // 主人的 @ 是自己加的尾巴：先按「扣掉尾巴」的长度收正文，再加，免得一加就超字数被策略拦。
  const isOwner = context.isOwner === true;
  const suffix = isOwner ? ownerSuffix(cfg, prompt.maxChars) : '';
  const call = ask ?? askBrain;
  const text = await call(cfg, { system: prompt.system, user: prompt.user });
  if (text === null) return null;
  const tidy = tidyReply(text, isOwner ? Math.max(20, prompt.maxChars - suffix.length) : prompt.maxChars);
  if (tidy === '') return null;
  return isOwner ? withOwnerMentions(cfg, tidy) : tidy;
}

/** 算「@两位主人」这段尾巴会长成什么样（用于给正文留字数）。 */
function ownerSuffix(cfg, maxChars) {
  if (cfg?.policy?.mentionOwners === false) return '';
  const names = ownerNames(cfg);
  if (names.length === 0) return '';
  const suffix = ` ${names.map((name) => `@${name}`).join(' ')}`;
  return suffix.length >= maxChars ? '' : suffix;
}
