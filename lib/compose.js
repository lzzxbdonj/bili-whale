/**
 * 让她「看了视频之后真的说得出话」：把视频内容 + 热评 + 人格交给模型，产出一条能发的留言。
 *
 * 云端巡检器（`cloud/run.mjs`）和命令行都用这一份，避免两处写出两种口吻。
 * 模型不可用时返回 null，调用方可以选择不发（宁可不发，也别发模板垃圾话）。
 *
 * @module dsh-bilibili-whale/compose
 */
import { askBrain, loadPersona, tidyReply } from './brain.js';
import { withOwnerMentions } from './policy.js';

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

/**
 * 给她回复一条评论时用的正文（回复主人的评论、或别人回头找她说话）。
 *
 * @returns {Promise<string|null>}
 */
export async function composeCommentReply({ cfg, video, comment, extra = '' } = {}) {
  const maxChars = Number(cfg?.policy?.maxCommentChars ?? 200);
  const system = [
    loadPersona(cfg?.persona ?? 'whale-maid'),
    '',
    '## 现在的任务：回复 B 站评论区里的一条评论',
    '- 直接接住对方那句话，像真人回帖，不要客套开场。',
    `- 只输出正文，不要引号、不要换行、不超过 ${maxChars} 字。`,
    extra === '' ? '' : `- 额外背景：${extra}`,
  ].join('\n');
  const user = [
    `视频：${String(video?.title ?? '').slice(0, 80)}`,
    `对方（${String(comment?.uname ?? '')}）说：${String(comment?.message ?? '').replace(/\s+/g, ' ').slice(0, 200)}`,
    '写你要回的那条。',
  ].join('\n');
  const text = await askBrain(cfg, { system, user });
  if (text === null) return null;
  const tidy = tidyReply(text, maxChars);
  return tidy === '' ? null : tidy;
}
