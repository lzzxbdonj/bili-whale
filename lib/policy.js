/**
 * 对外动作策略：该不该发、能不能自动发、还差什么。
 *
 * 三条硬规则来自主人：
 *   1. 主人（懒寻真）永远优先，不受「每人一条」限制。
 *   2. 别人一人一条：同一评论串里同一人至多回 1 条，且 24 小时内只回 1 条。
 *   3. 模式开关：auto 直接发 / confirm 只出草稿等主人点头 / off 禁止。
 *
 * 所有判断都在插件侧完成，模型说得再好听也绕不过配额与去重。
 *
 * @module dsh-bilibili-whale/policy
 */
import { autoDmCountForUser, commentedVideo, dmCountForUser, favoritedAlready, lastDmIncomingTs, lastReplyTsForUser, threadReplyCount, todayCounts, dynamicPostedToday } from './ledger.js';

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
export function isOwner(cfg, { mid, uname }) {
  const mids = [cfg.ownerMid, ...(Array.isArray(cfg.ownerMids) ? cfg.ownerMids : [])]
    .filter((value) => value !== null && value !== undefined && String(value) !== '');
  if (mids.some((value) => String(mid) === String(value))) return true;
  const names = [cfg.ownerName, ...(Array.isArray(cfg.ownerNames) ? cfg.ownerNames : [])]
    .filter((value) => typeof value === 'string' && value !== '');
  return typeof uname === 'string' && uname !== '' && names.includes(uname);
}

/**
 * 主人昵称列表（去重、去空）。给「@主人」用。
 *
 * @returns {string[]}
 */
export function ownerNames(cfg) {
  const list = [cfg?.ownerName, ...(cfg?.ownerNames ?? [])]
    .filter((name) => typeof name === 'string' && name.trim() !== '')
    .map((name) => name.trim());
  return [...new Set(list)];
}

/**
 * 给正文补上「@两个主人」。
 *
 * 主人的要求：她出去刷视频留言时，一定要把两位主人都 @ 上（这样主人才收得到动静）。
 * 已经 @ 过的不重复加；`policy.mentionOwners = false` 可以整体关掉。
 *
 * @param {object} cfg - 已解析配置。
 * @param {string} text - 原始正文。
 * @returns {string}
 */
export function withOwnerMentions(cfg, text) {
  const body = String(text ?? '');
  if (cfg?.policy?.mentionOwners === false) return body;
  const missing = ownerNames(cfg).filter((name) => body.includes(`@${name}`) === false);
  if (missing.length === 0) return body;
  return `${body.trimEnd()} ${missing.map((name) => `@${name}`).join(' ')}`;
}

/**
 * 视频一级评论的策略判断。
 * @returns {{allowed: boolean, needsConfirm: boolean, mode: string, reasons: string[], message: string}}
 */
export function checkVideoComment({ cfg, ledger, video, message, confirm = false, now = Date.now() }) {
  const mode = cfg.policy.postVideoComment;
  const reasons = [];
  const counts = todayCounts(ledger, new Date(now));
  const text = String(message ?? '').trim();
  if (mode === 'off') reasons.push('配置里 postVideoComment = off，禁止评论视频');
  if (text === '') reasons.push('评论内容为空');
  if (text.length > Number(cfg.policy.maxCommentChars)) {
    reasons.push(`评论 ${text.length} 字，超过上限 ${cfg.policy.maxCommentChars} 字（防刷屏）`);
  }
  const blocked = hitBlocked(text, cfg.policy.blockKeywords);
  if (blocked !== null) reasons.push(`命中屏蔽词「${blocked}」`);
  if (cfg.policy.dedupePerVideo === true && video?.bvid && commentedVideo(ledger, video.bvid) !== null) {
    reasons.push(`这个视频（${video.bvid}）已经评论过了`);
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
    message: text,
    hint: needsConfirm ? '这是草稿模式：把草稿给主人看，主人说发再用 confirm=true 重调。' : '',
  };
}

/**
 * 回复评论的策略判断。
 * @param options.target - { mid, uname, rpid, root }（root 为 0/空表示这是一级评论，回复时 root=rpid）
 * @param options.selfMid - 自己的 UID，用于拒绝自问自答
 */
export function checkReply({ cfg, ledger, target, message, confirm = false, selfMid = null, now = Date.now() }) {
  const mode = cfg.policy.postReply;
  const reasons = [];
  const warnings = [];
  const text = String(message ?? '').trim();
  const owner = isOwner(cfg, target ?? {});
  const rootRpid = Number(target?.root) > 0 ? target.root : target?.rpid;
  const counts = todayCounts(ledger, new Date(now));

  if (mode === 'off') reasons.push('配置里 postReply = off，禁止回复');
  if (text === '') reasons.push('回复内容为空');
  if (text.length > Number(cfg.policy.maxCommentChars)) {
    reasons.push(`回复 ${text.length} 字，超过上限 ${cfg.policy.maxCommentChars} 字`);
  }
  const blocked = hitBlocked(text, cfg.policy.blockKeywords);
  if (blocked !== null) reasons.push(`命中屏蔽词「${blocked}」`);
  const self = selfMid !== null && String(target?.mid) === String(selfMid);
  if (self) reasons.push('这是她自己发的评论，不回自己');
  if (cfg.policy.replyScope === 'owner-only' && !owner) reasons.push('配置里 replyScope = owner-only：只回主人');

  if (!owner && !self) {
    const perThread = Number(cfg.policy.replyPerUserPerThread) || 0;
    const used = threadReplyCount(ledger, rootRpid, target?.mid);
    if (perThread > 0 && used >= perThread) {
      reasons.push(`「${target?.uname ?? target?.mid}」在这条评论串里已经被回过 ${used} 条了（每人每串上限 ${perThread}）`);
    }
    const windowHours = Number(cfg.policy.replyPerUserWindowHours) || 0;
    if (windowHours > 0) {
      const last = lastReplyTsForUser(ledger, target?.mid);
      const hours = last === 0 ? Number.POSITIVE_INFINITY : (now - last) / 3600000;
      if (hours < windowHours) {
        reasons.push(`「${target?.uname ?? target?.mid}」${hours.toFixed(1)} 小时前刚被回过（每人 ${windowHours} 小时一条）`);
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

/** 关注的策略判断：只关注主人；关注别人要先在配置里开 allowFollowOthers。 */
export function checkFollow({ cfg, mid, uname, act = 1 }) {
  const reasons = [];
  const owner = isOwner(cfg, { mid, uname });
  const following = Number(act) === 1;
  if (cfg.policy.allowFollow === false) reasons.push('配置里 allowFollow = false，禁止任何关注动作');
  if (following && owner !== true && cfg.policy.allowFollowOthers !== true) {
    reasons.push('只关注主人（要关注别人请在配置里开 policy.allowFollowOthers）');
  }
  return {
    allowed: reasons.length === 0,
    needsConfirm: false,
    mode: following ? 'follow' : 'unfollow',
    owner,
    reasons,
    hint: reasons.length === 0 ? '' : '这条规则在插件侧强制，模型绕不过。',
  };
}

/** 私信的策略判断：默认只能私信主人，且每人每天 maxDmPerUserPerDay 条。 */
export function checkDm({ cfg, ledger, mid, uname, text, now = Date.now() }) {
  const reasons = [];
  const value = String(text ?? '').trim();
  const owner = isOwner(cfg, { mid, uname });
  if (cfg.policy.allowDm === false) reasons.push('配置里 allowDm = false，禁止私信');
  if (value === '') reasons.push('私信内容为空');
  if (value.length > Number(cfg.policy.maxCommentChars)) {
    reasons.push(`私信 ${value.length} 字，超过上限 ${cfg.policy.maxCommentChars} 字`);
  }
  const blocked = hitBlocked(value, cfg.policy.blockKeywords);
  if (blocked !== null) reasons.push(`命中屏蔽词「${blocked}」`);
  if (owner !== true && cfg.policy.allowDmToOthers !== true) {
    reasons.push('只给主人发私信（要发给别人请在配置里开 policy.allowDmToOthers）');
  }
  const limit = Number(cfg.policy.maxDmPerUserPerDay) || 0;
  if (limit > 0) {
    const sent = dmCountForUser(ledger, mid, new Date(now));
    if (sent >= limit) reasons.push(`「${uname ?? mid}」今天已经收到 ${sent} 条私信（上限 ${limit} 条）`);
  }
  const interval = intervalOk(cfg, ledger, now, owner);
  if (!interval.ok) reasons.push(interval.reason);
  return {
    allowed: reasons.length === 0,
    needsConfirm: false,
    mode: cfg.policy.postDm ?? 'auto',
    owner,
    reasons,
    message: value,
    hint: reasons.length === 0 ? '' : '这条规则在插件侧强制，模型绕不过。',
  };
}

/**
 * 回私信的策略判断（Reply to a DM）。
 *
 * 与「主动私信」的区别：这里只回**先找过她**的人。
 *   - 主人：mode = policy.replyDm（默认 auto，不限条数）
 *   - 别人：mode = policy.replyDmOthers（默认 `once`：**只自动回一条**，之后闭嘴；
 *     也可设 'confirm' 要主人点头、'auto' 不限、'off' 完全不回）
 *   - 对方没先发过消息 → 直接拦下（绝不主动搭话陌生人）
 */
export function checkDmReply({ cfg, ledger, mid, uname, text, confirm = false, now = Date.now() }) {
  const owner = isOwner(cfg, { mid, uname });
  const mode = owner ? (cfg.policy.replyDm ?? 'auto') : (cfg.policy.replyDmOthers ?? 'once');
  const reasons = [];
  const value = String(text ?? '').trim();
  if (cfg.policy.allowDm === false) reasons.push('配置里 allowDm = false，禁止任何私信');
  if (value === '') reasons.push('私信内容为空');
  if (value.length > Number(cfg.policy.maxCommentChars)) {
    reasons.push(`私信 ${value.length} 字，超过上限 ${cfg.policy.maxCommentChars} 字`);
  }
  const blocked = hitBlocked(value, cfg.policy.blockKeywords);
  if (blocked !== null) reasons.push(`命中屏蔽词「${blocked}」`);
  if (lastDmIncomingTs(ledger, mid) === 0) {
    reasons.push(`「${uname ?? mid}」没有先给她发过私信，人家不主动搭话陌生人`);
  }
  if (owner !== true && mode === 'off') {
    reasons.push('配置里 replyDmOthers = off，她不自动回陌生人的私信');
  }
  if (owner !== true && mode === 'once' && confirm !== true && autoDmCountForUser(ledger, mid) >= 1) {
    reasons.push(`已经自动回过「${uname ?? mid}」一条了，陌生人只回一条，之后要主人点头才回`);
  }
  // 每日上限只管别人：主人找她说话是**实时**要回的，不该被自己的配额卡住
  //（踩过的坑：主人连发几条后被 maxDmReplyPerUserPerDay 拦住，看起来像「她不回我」）。
  const limit = Number(cfg.policy.maxDmReplyPerUserPerDay) || 0;
  if (limit > 0 && owner !== true) {
    const sent = dmCountForUser(ledger, mid, new Date(now));
    if (sent >= limit) reasons.push(`「${uname ?? mid}」今天已经收到 ${sent} 条私信（上限 ${limit} 条）`);
  }
  const interval = intervalOk(cfg, ledger, now, owner);
  if (!interval.ok) reasons.push(interval.reason);
  const needsConfirm = mode === 'confirm' && confirm !== true;
  return {
    allowed: reasons.length === 0 && !needsConfirm,
    needsConfirm,
    mode,
    owner,
    reasons,
    message: value,
    hint: needsConfirm
      ? '别人发的私信先给主人看一眼，点头后再回（confirm=true）。'
      : (owner !== true && mode === 'once' ? '陌生人只自动回一条，之后要主人点头（confirm=true）才回。' : ''),
  };
}

/**
 * 收藏一个视频的策略判断（刷到觉得好看的视频就收进收藏夹）。
 *
 * 收藏是「给自己记一份」，不对外说话，所以默认 `auto`（不打扰主人）；
 * 但仍然受限：同一视频只收一次、每天有上限 `dailyFavorites`、命中屏蔽词不收。
 */
export function checkFavorite({ cfg, ledger, aid, title = '', confirm = false, now = Date.now() }) {
  const mode = cfg.policy.postFavorite ?? 'auto';
  const reasons = [];
  if (mode === 'off') reasons.push('配置里 postFavorite = off，禁止收藏');
  if (Number(aid) <= 0) reasons.push('没有拿到视频 aid，没法收藏');
  if (Number(aid) > 0 && favoritedAlready(ledger, aid)) reasons.push(`这个视频（aid=${aid}）已经收藏过了`);
  if (String(title).trim() !== '') {
    const blocked = hitBlocked(String(title), cfg.policy.blockKeywords);
    if (blocked !== null) reasons.push(`标题命中屏蔽词「${blocked}」，不收`);
  }
  const counts = todayCounts(ledger, new Date(now));
  const limit = Number(cfg.policy.dailyFavorites);
  if (limit > 0 && Number(counts.favorites ?? 0) >= limit) {
    reasons.push(`今日收藏已达上限 ${limit} 个`);
  }
  const needsConfirm = mode === 'confirm' && confirm !== true;
  return {
    allowed: reasons.length === 0 && !needsConfirm,
    needsConfirm,
    mode,
    owner: true,
    reasons,
    hint: needsConfirm ? '收藏先给主人看一眼，点头后再收（confirm=true）。' : '',
  };
}

/** 发动态的策略判断。 */
export function checkDynamic({ cfg, ledger, text, confirm = false, auto = false, now = Date.now() }) {
  const mode = cfg.policy.postDynamic;
  const reasons = [];
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
    message: value,
    hint: needsConfirm ? '草稿模式：把内容给主人看，点头后再发。' : '',
  };
}
