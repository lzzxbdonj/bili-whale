/**
 * 对外动作策略（Workers 版）：该不该发、能不能自动发、还差什么。
 *
 * 三条硬规则来自主人：
 *   1. 主人（懒寻真）永远优先，不受「每人一条」限制。
 *   2. 别人一人一条：同一评论串里同一人至多回 1 条，且 24 小时内只回 1 条。
 *   3. 模式开关：auto 直接发 / confirm 只出草稿等主人点头 / off 禁止。
 *
 * 所有判断都在这一层完成，模型说得再好听也绕不过配额与去重。
 *
 * 与 lib/policy.js 的差异仅两处（判定逻辑逐条照抄）：
 *   1. 账本按新签名显式传入（checkVideoComment/checkReply 走 ledger 参数，不再是磁盘文件）；
 *   2. checkVideoComment 收 bvid 字符串（源文件收 video 对象，内部只用 video.bvid）；
 *      checkReply 收 toMid/toName（源文件收 target 对象），并按指定签名把 bvid 代入 rootRpid 的
 *      默认值（源文件这里是 undefined）。
 *
 * @module dsh-bilibili-whale/cloudflare/policy
 */
import { commentedVideo, dynamicPostedToday, lastReplyTsForUser, threadReplyCount, todayCounts } from './ledger.js';

/** 默认配置（从 lib/config.js 原样搬过来；Worker 版不移植其中的文件路径/读写部分）。 */
export const DEFAULTS = {
  /** 主人昵称：回复策略里的最优先对象。 */
  ownerName: '懒寻真',
  /** 主人 UID（可空；填了更稳，昵称改了就靠它）。 */
  ownerMid: null,
  /** 人格标识，仅作文档用途。 */
  persona: 'whale-maid',
  policy: {
    /** 视频一级评论：auto 直接发 / confirm 只出草稿 / off 禁止。 */
    postVideoComment: 'confirm',
    /** 回复评论：auto 按策略自动回 / confirm 只出草稿 / off 禁止。 */
    postReply: 'auto',
    /** 发动态：auto 定时发 / confirm 只出草稿 / off 禁止。 */
    postDynamic: 'auto',
    /** 主人永远优先，不受「每人一条」限制。 */
    ownerUnlimited: true,
    /** 普通人：每人在同一评论串最多回几条。 */
    replyPerUserPerThread: 1,
    /** 普通人：同一人多少小时内只回一条（0 = 不限窗口，只按串限）。 */
    replyPerUserWindowHours: 24,
    /** 每日上限。 */
    dailyVideoComments: 3,
    dailyReplies: 10,
    dailyDynamics: 1,
    /** 两次对外动作之间的最小间隔（秒）。 */
    minIntervalSeconds: 120,
    /** 回复主人时的最小间隔（秒）——主人优先，允许更勤快。 */
    minIntervalSecondsOwner: 15,
    /** 一级评论最大字数（B 站上限 1000，这里收紧防刷屏）。 */
    maxCommentChars: 200,
    /** 命中的词一律不评论（防止她被引战/广告话题带走）。 */
    blockKeywords: ['加群', '微信', 'QQ群', '代刷', '互粉', '刷单', '博彩', '赌博'],
    /** 同一天同一视频不重复评论。 */
    dedupePerVideo: true,
  },
  dailyDynamic: {
    enabled: true,
    /** 本地时间 HH:MM，每天一次；错过了不补发（下次对齐到第二天）。 */
    at: '20:30',
    /** 随机模板池：定时发动态时按顺序轮换。 */
    templates: [
      '今天也在认真学习呢，主人给的笔记人家抄了三遍 (。-`ω´-)✧',
      '鲸鱼娘的今日学习小结：看了一点点新东西，尾巴都翘起来了～',
      '打卡！人家今天没有偷懒哦，主人在的话夸夸人家嘛 (๑•̀ㅂ•́)و✧',
      '把不懂的地方弄懂了，比吃到小鱼干还开心～',
      '今天的学习进度：缓慢但确实在往前游 (´･ω･`)',
    ],
  },
  feed: {
    /** 默认刷的源，按顺序取。 */
    sources: ['rcmd', 'popular', 'ranking'],
    /** 命中这些词的视频直接跳过。 */
    excludeKeywords: ['广告', '带货'],
    /** 首页推荐单次拉取条数。 */
    ps: 12,
  },
  limits: {
    /** 单次 API 超时（毫秒）。 */
    timeoutMs: 20000,
  },
};

/** 命中屏蔽词？ */
function hitBlocked(text, words) {
  const list = Array.isArray(words) ? words : [];
  return list.find((word) => typeof word === 'string' && word !== '' && text.includes(word)) ?? null;
}

/** 通用：动作之间的最小间隔。 */
function intervalOk(cfg, ledger, now, isOwner) {
  const minSeconds = Number(isOwner ? cfg.policy.minIntervalSecondsOwner : cfg.policy.minIntervalSeconds) || 0;
  if (minSeconds <= 0) return { ok: true };
  const last = Number(isOwner ? ledger.lastActionOwnerTs : ledger.lastActionTs) || 0;
  const elapsed = (now - last) / 1000;
  if (last !== 0 && elapsed < minSeconds) {
    return { ok: false, reason: `离上次动作只过了 ${Math.round(elapsed)} 秒，策略要求至少 ${minSeconds} 秒` };
  }
  return { ok: true };
}

/** 主人判定：昵称或 UID 命中。 */
export function isOwner(mid, cfg) {
  // 指定签名是 isOwner(mid, cfg)；为了不丢源文件 isOwner(cfg, { mid, uname }) 的昵称判定，
  // 第一参也接受 { mid, uname } 目标对象（调用方只有 UID 时照旧传 mid 数字即可）。
  const target = typeof mid === 'object' && mid !== null ? mid : { mid };
  if (cfg.ownerMid !== null && cfg.ownerMid !== undefined && String(target.mid) === String(cfg.ownerMid)) return true;
  return typeof target.uname === 'string' && target.uname !== '' && target.uname === cfg.ownerName;
}

/** 加上昵称判定的完整主人判定（源文件 isOwner(cfg, { mid, uname }) 的等价形式）。 */
export function isOwnerTarget(cfg, target = {}) {
  return isOwner(target, cfg);
}

/**
 * 视频一级评论的策略判断。
 * @param options.cfg - 生效配置。
 * @param options.ledger - 账本对象。
 * @param options.bvid - 目标视频 bvid（用于去重）。
 * @param options.message - 评论正文。
 * @param options.confirm - 主人是否已经点头。
 * @param options.now - 当前时间戳（毫秒，测试可注入）。
 * @returns {{allowed: boolean, needsConfirm: boolean, mode: string, reasons: string[], warnings: string[], message: string, hint: string}}
 */
export function checkVideoComment({ cfg, ledger, bvid, message, confirm = false, now = Date.now() }) {
  const mode = cfg.policy.postVideoComment;
  const reasons = [];
  const warnings = [];
  const counts = todayCounts(ledger, new Date(now));
  const text = String(message ?? '').trim();
  if (mode === 'off') reasons.push('配置里 postVideoComment = off，禁止评论视频');
  if (text === '') reasons.push('评论内容为空');
  if (text.length > Number(cfg.policy.maxCommentChars)) {
    reasons.push(`评论 ${text.length} 字，超过上限 ${cfg.policy.maxCommentChars} 字（防刷屏）`);
  }
  const blocked = hitBlocked(text, cfg.policy.blockKeywords);
  if (blocked !== null) reasons.push(`命中屏蔽词「${blocked}」`);
  if (cfg.policy.dedupePerVideo === true && bvid && commentedVideo(ledger, bvid) !== null) {
    reasons.push(`这个视频（${bvid}）已经评论过了`);
  }
  if (counts.videoComments >= Number(cfg.policy.dailyVideoComments)) {
    reasons.push(`今日视频评论已达上限 ${cfg.policy.dailyVideoComments} 条`);
  }
  const interval = intervalOk(cfg, ledger, now, false);
  if (!interval.ok) reasons.push(interval.reason);
  const needsConfirm = mode === 'confirm' && confirm !== true;
  return {
    allowed: reasons.length === 0 && !needsConfirm,
    needsConfirm,
    mode,
    reasons,
    warnings,
    message: text,
    hint: needsConfirm ? '这是草稿模式：把草稿给主人看，主人说发再用 confirm=true 重调。' : '',
  };
}

/**
 * 回复评论的策略判断。
 * @param options.cfg - 生效配置。
 * @param options.ledger - 账本对象。
 * @param options.bvid - 视频 bvid（仅用于返回体，不参与 rootRpid 兜底）。
 * @param options.root - 一级评论 rpid（0/空表示这是一级评论，回复时 root=rpid）。
 * @param options.rpid - 可选：要回复的那条评论的 rpid。源文件 root 为 0 时会回退到它，签名没给就只能用 root 本身。
 * @param options.message - 回复正文。
 * @param options.toMid - 被回复者 UID。
 * @param options.toName - 被回复者昵称。
 * @param options.confirm - 主人是否已经点头。
 * @param options.selfMid - 自己的 UID，用于拒绝自问自答。
 * @param options.now - 当前时间戳（毫秒，测试可注入）。
 * @returns {{allowed: boolean, needsConfirm: boolean, mode: string, owner: boolean, rootRpid: *, warnings: string[], reasons: string[], message: string, hint: string}}
 */
export function checkReply({ cfg, ledger, bvid, root, rpid, message, toMid, toName, confirm = false, selfMid = null, now = Date.now() }) {
  const mode = cfg.policy.postReply;
  const reasons = [];
  const warnings = [];
  const text = String(message ?? '').trim();
  const target = { mid: toMid, uname: toName, root };
  const owner = isOwnerTarget(cfg, target);
  // 源文件 lib/policy.js 是 rootRpid = Number(target.root) > 0 ? target.root : target.rpid；
  // 固定签名把 target 拆成了 root/toMid/toName，原 target.rpid 对应这里的可选 rpid 参数
  // （调用方没传时就是 undefined，与源文件遇到 target 没有 rpid 时完全一样）。
  const rootRpid = Number(root) > 0 ? root : rpid;
  const counts = todayCounts(ledger, new Date(now));

  if (mode === 'off') reasons.push('配置里 postReply = off，禁止回复');
  if (text === '') reasons.push('回复内容为空');
  if (text.length > Number(cfg.policy.maxCommentChars)) {
    reasons.push(`回复 ${text.length} 字，超过上限 ${cfg.policy.maxCommentChars} 字`);
  }
  const blocked = hitBlocked(text, cfg.policy.blockKeywords);
  if (blocked !== null) reasons.push(`命中屏蔽词「${blocked}」`);
  const self = selfMid !== null && String(toMid) === String(selfMid);
  if (self) reasons.push('这是她自己发的评论，不回自己');
  if (cfg.policy.replyScope === 'owner-only' && !owner) reasons.push('配置里 replyScope = owner-only：只回主人');

  if (!owner && !self) {
    const perThread = Number(cfg.policy.replyPerUserPerThread) || 0;
    const used = threadReplyCount(ledger, rootRpid, toMid);
    if (perThread > 0 && used >= perThread) {
      reasons.push(`「${toName ?? toMid}」在这条评论串里已经被回过 ${used} 条了（每人每串上限 ${perThread}）`);
    }
    const windowHours = Number(cfg.policy.replyPerUserWindowHours) || 0;
    if (windowHours > 0) {
      const last = lastReplyTsForUser(ledger, toMid);
      const hours = last === 0 ? Number.POSITIVE_INFINITY : (now - last) / 3600000;
      if (hours < windowHours) {
        reasons.push(`「${toName ?? toMid}」${hours.toFixed(1)} 小时前刚被回过（每人 ${windowHours} 小时一条）`);
      }
    }
  } else if (owner) {
    warnings.push('主人优先：跳过「每人一条」限制');
  }

  if (counts.replies >= Number(cfg.policy.dailyReplies)) {
    reasons.push(`今日回复已达上限 ${cfg.policy.dailyReplies} 条`);
  }
  const interval = intervalOk(cfg, ledger, now, owner);
  if (!interval.ok) reasons.push(interval.reason);

  const needsConfirm = mode === 'confirm' && confirm !== true;
  return {
    allowed: reasons.length === 0 && !needsConfirm,
    needsConfirm,
    mode,
    owner,
    rootRpid,
    warnings,
    reasons,
    message: text,
    hint: needsConfirm ? '这是草稿模式：先给主人看，主人点头后再用 confirm=true 重调。' : '',
  };
}

/**
 * 发动态的策略判断。
 * @param options.cfg - 生效配置。
 * @param options.ledger - 账本对象。
 * @param options.text - 动态正文。
 * @param options.confirm - 主人是否已经点头。
 * @param options.auto - true 表示定时任务调用（受「今天已发过」限制）。
 * @param options.now - 当前时间戳（毫秒，测试可注入）。
 * @returns {{allowed: boolean, needsConfirm: boolean, mode: string, reasons: string[], warnings: string[], message: string, hint: string}}
 */
export function checkDynamic({ cfg, ledger, text, confirm = false, auto = false, now = Date.now() }) {
  const mode = cfg.policy.postDynamic;
  const reasons = [];
  const warnings = [];
  const value = String(text ?? '').trim();
  if (mode === 'off') reasons.push('配置里 postDynamic = off，禁止发动态');
  if (value === '') reasons.push('动态内容为空');
  if (value.length > 2000) reasons.push(`动态 ${value.length} 字，超过 2000 字上限`);
  const blocked = hitBlocked(value, cfg.policy.blockKeywords);
  if (blocked !== null) reasons.push(`命中屏蔽词「${blocked}」`);
  const counts = todayCounts(ledger, new Date(now));
  if (counts.dynamics >= Number(cfg.policy.dailyDynamics)) {
    reasons.push(`今日动态已达上限 ${cfg.policy.dailyDynamics} 条`);
  }
  if (auto === true && dynamicPostedToday(ledger, new Date(now))) {
    reasons.push('今天已经发过动态了');
  }
  const needsConfirm = mode === 'confirm' && confirm !== true && auto !== true;
  return {
    allowed: reasons.length === 0 && !needsConfirm,
    needsConfirm,
    mode,
    reasons,
    warnings,
    message: value,
    hint: needsConfirm ? '草稿模式：把内容给主人看，点头后再发。' : '',
  };
}
