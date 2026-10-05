/**
 * 账本（Workers 版）：所有对外动作的持久记录 + 每日配额计数。
 *
 * 与 lib/ledger.js 的差异：**不碰文件系统**。源文件里 loadLedger()/saveLedger()
 * 负责读写 $DSH_HOME/bilibili-whale/ledger.json，Worker 版本把账本变成「显式传入
 * 的普通对象」，由调用方决定存哪儿（KV / Durable Object / D1 …）：
 *   - createLedger(raw?)   归一化账本（等价于源文件的 emptyLedger + loadLedger 校验部分）
 *   - snapshotLedger(l)    等价于源文件的 saveLedger(l)（只做裁剪，返回同一个账本）
 * 其余字段名、计数键、上限常量、查询与记录语义全部照抄。
 *
 * @module dsh-bilibili-whale/cloudflare/ledger
 */

const MAX_EVENTS = 500;
const MAX_MATERIALS = 30;

/** 空账本。 */
export function emptyLedger() {
  return {
    version: 1,
    comments: [],
    replies: [],
    dynamics: [],
    follows: [],
    dms: [],
    favorites: [],
    study: [],
    dmIncoming: [],
    replyIndex: {},
    replyThreads: {},
    daily: {},
    materials: [],
    lastActionTs: 0,
    lastActionOwnerTs: 0,
    dynamicTemplateIndex: 0,
  };
}

/**
 * 把任意输入归一化成一个可用账本（字段缺失/类型不对时补默认值）。
 * @param raw - 从存储读回来的对象（可为 null/undefined/脏数据）。
 * @returns 完整形状的账本对象。
 */
export function createLedger(raw) {
  const value = raw;
  if (value === null || value === undefined || typeof value !== 'object') return emptyLedger();
  const base = emptyLedger();
  return {
    ...base,
    ...value,
    comments: Array.isArray(value.comments) ? value.comments : [],
    replies: Array.isArray(value.replies) ? value.replies : [],
    dynamics: Array.isArray(value.dynamics) ? value.dynamics : [],
    follows: Array.isArray(value.follows) ? value.follows : [],
    dms: Array.isArray(value.dms) ? value.dms : [],
    favorites: Array.isArray(value.favorites) ? value.favorites : [],
    study: Array.isArray(value.study) ? value.study : [],
    dmIncoming: Array.isArray(value.dmIncoming) ? value.dmIncoming : [],
    replyIndex: typeof value.replyIndex === 'object' && value.replyIndex !== null ? value.replyIndex : {},
    replyThreads: typeof value.replyThreads === 'object' && value.replyThreads !== null ? value.replyThreads : {},
    daily: typeof value.daily === 'object' && value.daily !== null ? value.daily : {},
    materials: Array.isArray(value.materials) ? value.materials : [],
  };
}

/**
 * 落盘前的裁剪（等价源文件 saveLedger 的副作用，但不再写文件）。
 * @param ledger - 待裁剪账本。
 * @returns 同一个账本对象（已就地裁剪）。
 */
export function snapshotLedger(ledger) {
  ledger.comments = ledger.comments.slice(-MAX_EVENTS);
  ledger.replies = ledger.replies.slice(-MAX_EVENTS);
  ledger.dynamics = ledger.dynamics.slice(-MAX_EVENTS);
  ledger.follows = ledger.follows.slice(-MAX_EVENTS);
  ledger.dms = ledger.dms.slice(-MAX_EVENTS);
  ledger.study = ledger.study.slice(-MAX_EVENTS);
  ledger.materials = ledger.materials.slice(-MAX_MATERIALS);
  return ledger;
}

/**
 * 日期键 YYYY-MM-DD（与源文件 lib/ledger.js:33-36 逐字一致：读**本地**字段）。
 *
 * 关于时区：Cloudflare Workers 进程跑在 UTC，所以线上「本地字段」就是 UTC 字段，
 * 行为与源文件在 UTC 机器上跑完全一样。调用方若已经把 `now` 用
 * `patrol.timezoneShiftMs()` 平移成「主人时区的墙上时间」，请用下面的
 * dateKeyUTC()（读取平移后 Date 的 UTC 字段）来取主人日期，不要指望 dateKey
 * 帮你做二次平移 —— 在 UTC+8 的开发机上那样会提前 8 小时换日。
 */
export function dateKey(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * 日期键的 UTC 变体（**移植时新增的 helper，源文件没有**）。
 *
 * 给「已经用 timezoneShiftMs 平移过」的调用路径用：平移后的 Date 其 UTC 字段
 * 就是主人时区的墙上日期。这样在 UTC 的 Worker 和 UTC+8 的开发机上结果一致。
 */
export function dateKeyUTC(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
}

/** 今天的计数桶（会就地建桶）。 */
export function todayBucket(ledger, now = new Date()) {
  const key = dateKey(now);
  if (ledger.daily[key] === undefined) {
    ledger.daily[key] = { videoComments: 0, replies: 0, dynamics: 0, favorites: 0 };
  }
  return ledger.daily[key];
}

/** 今天已经发生的计数（读，不写）。 */
export function todayCounts(ledger, now = new Date()) {
  const bucket = ledger.daily[dateKey(now)] ?? {};
  return {
    videoComments: bucket.videoComments ?? 0,
    replies: bucket.replies ?? 0,
    dynamics: bucket.dynamics ?? 0,
    favorites: bucket.favorites ?? 0,
  };
}

/** 是否已评论过该视频（用于去重）。 */
export function commentedVideo(ledger, bvid) {
  if (!bvid) return null;
  const hit = ledger.comments.find((item) => item.bvid === bvid);
  return hit ?? null;
}

/** 某人在某评论串里已被回复过几次。 */
export function threadReplyCount(ledger, rootRpid, mid) {
  return ledger.replyThreads[`${rootRpid}|${mid}`] ?? 0;
}

/** 某人在窗口内是否已被回复过（返回最近一次时间戳，毫秒）。 */
export function lastReplyTsForUser(ledger, mid) {
  const list = ledger.replyIndex[String(mid)];
  if (!Array.isArray(list) || list.length === 0) return 0;
  return Math.max(...list.map((value) => Number(value) || 0));
}

/** 记录一次视频一级评论（就地修改账本）。 */
export function recordComment(ledger, { bvid, aid, rpid, text, ts = Date.now(), now = new Date() }) {
  ledger.comments.push({ bvid, aid, rpid, text, ts });
  todayBucket(ledger, now).videoComments += 1;
  ledger.lastActionTs = ts;
  return ledger;
}

/** 记录一次回复（就地修改账本）。 */
export function recordReply(ledger, { bvid, aid, rpid, root, targetMid, targetUname, text, selfRpid, isOwner = false, ts = Date.now(), now = new Date() }) {
  ledger.replies.push({ bvid, aid, rpid, root, targetMid, targetUname, text, selfRpid, ts, isOwner });
  todayBucket(ledger, now).replies += 1;
  const key = String(targetMid);
  const list = Array.isArray(ledger.replyIndex[key]) ? ledger.replyIndex[key] : [];
  list.push(ts);
  ledger.replyIndex[key] = list.slice(-20);
  const threadKey = `${root}|${targetMid}`;
  ledger.replyThreads[threadKey] = (ledger.replyThreads[threadKey] ?? 0) + 1;
  ledger.lastActionTs = ts;
  if (isOwner) ledger.lastActionOwnerTs = ts;
  return ledger;
}

/** 记录一条动态（就地修改账本）。 */
export function recordDynamic(ledger, { text, dynId = null, ts = Date.now(), now = new Date() }) {
  ledger.dynamics.push({ date: dateKey(now), ts, text, dynId });
  todayBucket(ledger, now).dynamics += 1;
  return ledger;
}

/** 今天是否已经发过动态。 */
export function dynamicPostedToday(ledger, now = new Date()) {
  const key = dateKey(now);
  return ledger.dynamics.some((item) => item.date === key);
}

/** 追加一条学习素材（供自动动态取用）。 */
export function pushMaterial(ledger, text) {
  ledger.materials.push({ text, ts: Date.now(), used: false });
  return ledger;
}

/** 取一条未使用的素材并标记为已用。 */
export function takeMaterial(ledger) {
  const hit = ledger.materials.find((item) => item.used !== true);
  if (hit === undefined) return null;
  hit.used = true;
  return hit.text;
}

/** recordComment 的别名（名字里点明是「视频一级评论」，便于调用方区分）。 */
export const recordVideoComment = recordComment;

/**
 * 记录一次收藏（刷到好看的视频就收进收藏夹）。`aid` 是去重键。
 * 与 lib/ledger.js:200-207 逐行等价。
 */
export function recordFavorite(ledger, { aid, bvid = '', title = '', upName = '', folderId = null, triple = false, like = false, coin = 0, ts = Date.now(), now = new Date() }) {
  if (!Array.isArray(ledger.favorites)) ledger.favorites = [];
  ledger.favorites.push({ aid: Number(aid), bvid, title, upName, folderId, triple: triple === true, like: like === true, coin: Number(coin) || 0, date: dateKey(now), ts });
  ledger.favorites = ledger.favorites.slice(-500);
  ledger.lastActionTs = ts;
  if (ledger.daily?.[dateKey(now)] !== undefined) ledger.daily[dateKey(now)].favorites = (ledger.daily[dateKey(now)].favorites ?? 0) + 1;
  return ledger;
}

/** 这个视频是不是已经收过了。 */
export function favoritedAlready(ledger, aid) {
  const key = Number(aid);
  return (ledger.favorites ?? []).some((item) => Number(item.aid) === key);
}

/** 这个视频是不是已经「三连」过了（收藏记录里带 triple 标记）。 */
export function tripledAlready(ledger, aid) {
  const key = Number(aid);
  return (ledger.favorites ?? []).some((item) => Number(item.aid) === key && item.triple === true);
}

/** 今天三连了几个（按收藏记录里的 triple 标记数）。 */
export function tripleCountToday(ledger, now = new Date()) {
  const key = dateKey(now);
  return (ledger.favorites ?? []).filter((item) => item.triple === true && (item.date ?? dateKey(new Date(Number(item.ts) || Date.now()))) === key).length;
}
