/**
 * 账本：所有对外动作的持久记录 + 每日配额计数。
 *
 * 位置：$DSH_HOME/bilibili-whale/ledger.json
 * 用途：去重（同一视频不重复评论）、限流（每人一条 / 每日上限 / 最小间隔）、
 *      主人可见的「她都干了什么」清单、自动动态的素材队列。
 *
 * @module dsh-bilibili-whale/ledger
 */
import { readJsonFile, writeJsonFile, statePath } from './config.js';
import { mergeLedger } from './sync.js';

const MAX_EVENTS = 500;
const MAX_MATERIALS = 30;
/** 「刷到过什么」只留最近这些条，别把账本撑肥。 */
const MAX_WATCHED = 400;

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
    /**
     * 她**刷到/看过**的视频流水（主人 2026-10-05：「让它刷视频能留下痕迹」）。
     *
     * 为什么单独记一份：B 站浏览记录只有她自己账号里看得到，而且 `search` 搜出来的条目
     * 不带 cid 根本报不进去；主人想核「她今天到底刷了些什么」得有本机这份。
     */
    watched: [],
    /** 她的学习笔记（自己刷到的视频 + 学到的东西），供每日学习动态使用。 */
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

/** 本地日期键 YYYY-MM-DD。 */
export function dateKey(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 读取账本（不存在则给空账本）。 */
export function loadLedger() {
  const value = readJsonFile(statePath('ledger.json'), null);
  if (value === null || typeof value !== 'object') return emptyLedger();
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
    watched: Array.isArray(value.watched) ? value.watched : [],
    study: Array.isArray(value.study) ? value.study : [],
    dmIncoming: Array.isArray(value.dmIncoming) ? value.dmIncoming : [],
    replyIndex: typeof value.replyIndex === 'object' && value.replyIndex !== null ? value.replyIndex : {},
    replyThreads: typeof value.replyThreads === 'object' && value.replyThreads !== null ? value.replyThreads : {},
    daily: typeof value.daily === 'object' && value.daily !== null ? value.daily : {},
    materials: Array.isArray(value.materials) ? value.materials : [],
  };
}

/** 保存账本。 */
export function saveLedger(ledger) {
  ledger.comments = ledger.comments.slice(-MAX_EVENTS);
  ledger.replies = ledger.replies.slice(-MAX_EVENTS);
  ledger.dynamics = ledger.dynamics.slice(-MAX_EVENTS);
  ledger.follows = ledger.follows.slice(-MAX_EVENTS);
  ledger.dms = ledger.dms.slice(-MAX_EVENTS);
  ledger.study = ledger.study.slice(-MAX_EVENTS);
  ledger.watched = ledger.watched.slice(-MAX_WATCHED);
  ledger.materials = ledger.materials.slice(-MAX_MATERIALS);
  writeJsonFile(statePath('ledger.json'), ledger);
  return ledger;
}

/**
 * 合并保存：先把磁盘上的最新账本读回来，**并集**之后再写下去。
 *
 * 为什么要多这么一步（2026-10-05 真机「评论又重复回复了」）：
 * 本机不止一个写手 —— 宿主插件的回复定时器与看门鲸各拿一份账本快照，
 * 各回一条、各存一次，后存的把先存的记录**盖掉**（丢更新）。
 * 记录一丢，「这条评论已经回过了」的去重就失忆，下一轮又追着同一条评论回。
 *
 * 只给「对外说话」这类**只增不减**的动作（评论 / 回复 / 动态）用；
 * 会删记录的路径（`bili_ledger op=forget`、`takeMaterial` 取素材）仍旧走 `saveLedger`，
 * 否则删掉的东西会被磁盘上那份又并回来。
 */
export function saveLedgerMerged(ledger) {
  try {
    const merged = mergeLedger(loadLedger(), ledger);
    // mergeLedger 只认它认识的那些字段，标量（lastDmAt 这种）以内存这份为准。
    for (const [key, value] of Object.entries(ledger ?? {})) {
      if (value === null || typeof value !== 'object') merged[key] = value;
    }
    return saveLedger(merged);
  } catch {
    return saveLedger(ledger);
  }
}

/** 今天的计数桶。 */
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
    favorites: bucket.favorites ?? 0,
    replies: bucket.replies ?? 0,
    dynamics: bucket.dynamics ?? 0,
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

/**
 * 她是不是已经回过**这条评论本身**了（认对方那条评论的 `rpid`）。
 *
 * 和 `threadReplyCount` 的区别很关键：那个按「串 + 人」计数，主人是免检的
 * —— 主人再在同一个串里说新话，她还得答。但**同一条评论**被她回了两遍就是刷屏。
 * 2026-10-05 真机就是这么翻车的：账本里两条 reply 都指向 `rpid 316071900673`，
 * 主人那一句被她每轮（看门鲸约 5 分钟一轮）追着回一条。
 */
export function repliedToComment(ledger, rpid) {
  const value = Number(rpid);
  if (ledger === null || ledger === undefined || !Number.isFinite(value) || value <= 0) return false;
  const rows = Array.isArray(ledger.replies) ? ledger.replies : [];
  return rows.some((row) => Number(row?.rpid) === value);
}

/** 某人在窗口内是否已被回复过（返回最近一次时间戳，毫秒）。 */
export function lastReplyTsForUser(ledger, mid) {
  const list = ledger.replyIndex[String(mid)];
  if (!Array.isArray(list) || list.length === 0) return 0;
  return Math.max(...list.map((value) => Number(value) || 0));
}

/** 记录一次视频一级评论。 */
export function recordComment(ledger, { bvid, aid, rpid, text, ts = Date.now(), now = new Date() }) {
  ledger.comments.push({ bvid, aid, rpid, text, ts });
  todayBucket(ledger, now).videoComments += 1;
  ledger.lastActionTs = ts;
  return ledger;
}

/** 记录一次回复。 */
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

/** 记录一条动态。 */
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

/** 记录一次关注 / 取关。 */
export function recordFollow(ledger, { mid, uname = '', act = 1, ts = Date.now() }) {
  ledger.follows.push({ mid, uname, act, ts });
  ledger.lastActionTs = ts;
  return ledger;
}

/** 是否已经关注过某人（act=1 的记录存在且之后没有取关）。 */
export function followedAlready(ledger, mid) {
  const list = (ledger.follows ?? []).filter((item) => String(item.mid) === String(mid));
  if (list.length === 0) return false;
  return Number(list[list.length - 1].act) === 1;
}

/** 记录一条私信。`auto: true` 表示这是她自动回的（陌生人只允许一条自动回）。 */
export function recordDm(ledger, { mid, uname = '', text, msgKey = null, isOwner = false, auto = false, ts = Date.now(), now = new Date() }) {
  ledger.dms.push({ mid, uname, text, msgKey, auto: auto === true, date: dateKey(now), ts });
  ledger.lastActionTs = ts;
  if (isOwner === true) ledger.lastActionOwnerTs = ts;
  if (ledger.daily?.[dateKey(now)] !== undefined) ledger.daily[dateKey(now)].dms = (ledger.daily[dateKey(now)].dms ?? 0) + 1;
  return ledger;
}

/** 今天给某人发过几条私信。 */
export function dmCountForUser(ledger, mid, now = new Date()) {
  const when = now instanceof Date ? now : new Date(now);
  const key = dateKey(when);
  return (ledger.dms ?? []).filter((item) => String(item.mid) === String(mid) && item.date === key).length;
}

/**
 * 她给某人**自动**回过几条私信（不限当天，一辈子只回一条）。
 *
 * 理由：陌生人（非主人）只自动回一句就闭嘴，之后要他主动找主人点头才回。
 * 主人点头发的（auto 缺省 false）不计入，所以点头过的不影响后续自动判定。
 */
export function autoDmCountForUser(ledger, mid) {
  return (ledger.dms ?? []).filter((item) => String(item.mid) === String(mid) && item.auto === true).length;
}

/**
 * 记录一次收藏（刷到好看的视频就收进收藏夹）。
 *
 * `aid` 是去重键：同一个视频不会重复收藏，也不会重复记账。
 */
export function recordFavorite(ledger, { aid, bvid = '', title = '', upName = '', folderId = null, triple = false, like = false, coin = 0, ts = Date.now(), now = new Date() }) {
  if (!Array.isArray(ledger.favorites)) ledger.favorites = [];
  ledger.favorites.push({ aid: Number(aid), bvid, title, upName, folderId, triple: triple === true, like: like === true, coin: Number(coin) || 0, date: dateKey(now), ts });
  ledger.favorites = ledger.favorites.slice(-500);
  ledger.lastActionTs = ts;
  // 跟 `recordComment` / `recordReply` / `recordDynamic` 一样用 `todayBucket` ——
  // 原来写成 `if (ledger.daily?.[dateKey(now)] !== undefined)` 时，账本里还没建今天的桶
  // 就等于**不计数**，`dailyFavorites` 那道上限会被悄悄绕过（2026-10-05 补）。
  todayBucket(ledger, now).favorites += 1;
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

/**
 * 记一条「她刷到这个视频了」（主人 2026-10-05：「让它刷视频能留下痕迹」）。
 *
 * 与 B 站浏览记录的区别：那条要 `cid` 而且只有她账号里看得到；这条永远记得下来，
 * 主人用 `bili_ledger` 随时能核「她今天到底刷了些什么、有没有在摸鱼」。
 *
 * 同一个视频同一天只记一次（刷列表会反复看到同一条），`reported` 表示有没有真报进 B 站历史。
 */
export function recordWatched(ledger, { bvid = '', aid = 0, title = '', upName = '', topic = '', source = '', cid = 0, reported = false, ts = Date.now(), now = new Date() }) {
  if (!Array.isArray(ledger.watched)) ledger.watched = [];
  const key = String(bvid ?? '') !== '' ? String(bvid) : `av${Number(aid) || 0}`;
  const date = dateKey(now);
  const hit = ledger.watched.find((item) => item.key === key && item.date === date);
  if (hit !== undefined) {
    // 当天重复刷到：更新一下标题/上报状态就够，不再占一条。
    if (reported === true) hit.reported = true;
    hit.ts = ts;
    return ledger;
  }
  ledger.watched.push({ key, bvid: String(bvid ?? ''), aid: Number(aid) || 0, title: String(title ?? ''), upName: String(upName ?? ''), topic: String(topic ?? ''), source: String(source ?? ''), cid: Number(cid) || 0, reported: reported === true, date, ts });
  return ledger;
}

/** 今天刷到过的视频（新的在前）。 */
export function todayWatched(ledger, now = new Date()) {
  const key = dateKey(now);
  return (ledger.watched ?? []).filter((item) => item.date === key).sort((a, b) => Number(b.ts ?? 0) - Number(a.ts ?? 0));
}

/**
 * 今天「她自己刷」的视频：**不含主人点名要她看的**（那批 `source = 'master'`）。
 *
 * 主人 2026-10-05：「每天刷 30 个视频，主人让其刷的不计入」——`learning.dailyWatch`
 * 就是按这个数配额的，所以主人点名的刷既不算额度、也不会被额度卡住。
 *
 * @returns {Array<object>} 今天她自己刷的那些（新的在前）。
 */
export function selfWatchedToday(ledger, now = new Date()) {
  return todayWatched(ledger, now).filter((row) => String(row?.source ?? '') !== 'master');
}

/** 最近刷到过的视频（新的在前，默认 20 条）。 */
export function recentWatched(ledger, limit = 20) {
  const size = Math.max(1, Number(limit) || 20);
  return [...(ledger.watched ?? [])].sort((a, b) => Number(b.ts ?? 0) - Number(a.ts ?? 0)).slice(0, size);
}

/** 这个视频她是不是已经「学过」了（学过的就不再挑）。 */
export function studiedVideo(ledger, bvid) {
  if (!bvid) return null;
  return (ledger.study ?? []).find((item) => item.bvid === bvid) ?? null;
}

/**
 * 记一条学习笔记：她今天自己刷到了什么、学到了什么。
 *
 * `bvid` 是去重键；笔记同时进「素材队列」，晚上发学习动态时优先用当天的笔记。
 */
export function recordStudy(ledger, { bvid = '', aid = 0, title = '', upName = '', topic = '', score = 0, note = '', meaningful = false, ts = Date.now(), now = new Date(), keep = 200 }) {
  if (!Array.isArray(ledger.study)) ledger.study = [];
  const existing = studiedVideo(ledger, bvid);
  if (existing !== null) return ledger;
  ledger.study.push({ bvid, aid: Number(aid) || 0, title, upName, topic, score, note, meaningful: meaningful === true, date: dateKey(now), ts });
  ledger.study = ledger.study.slice(-Math.max(1, Number(keep) || 200));
  return ledger;
}

/** 今天学到的笔记（新的在前）。 */
export function todayStudy(ledger, now = new Date()) {
  const key = dateKey(now);
  return (ledger.study ?? []).filter((item) => item.date === key).sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
}

/** 记录一条收到的私信（用于判断「是不是他先找的她」与未读游标）。 */
export function recordDmIncoming(ledger, { mid, uname = '', text, ts = Date.now(), msgKey = null }) {
  if (!Array.isArray(ledger.dmIncoming)) ledger.dmIncoming = [];
  const key = msgKey === null ? null : String(msgKey);
  // 同一条消息可能被 list 和 read 各记一次，按 (mid, msgKey 或 ts+正文) 去重。
  const duplicated = ledger.dmIncoming.some((item) => String(item.mid) === String(mid)
    && ((key !== null && item.msgKey !== null && String(item.msgKey) === key)
      || (Number(item.ts) === Number(ts) && String(item.text) === String(text))));
  if (duplicated) return ledger;
  ledger.dmIncoming.push({ mid: String(mid), uname, text, ts, msgKey: key });
  ledger.dmIncoming = ledger.dmIncoming.slice(-200);
  return ledger;
}

/** 某人最近一次给她发私信的时间（毫秒），没有则 0。 */
export function lastDmIncomingTs(ledger, mid) {
  const list = (ledger.dmIncoming ?? []).filter((item) => String(item.mid) === String(mid));
  if (list.length === 0) return 0;
  return Math.max(...list.map((item) => Number(item.ts) || 0));
}

/** 她最近一次给某人发私信的时间（毫秒），没有则 0。 */
export function lastDmOutgoingTs(ledger, mid) {
  const list = (ledger.dms ?? []).filter((item) => String(item.mid) === String(mid));
  if (list.length === 0) return 0;
  return Math.max(...list.map((item) => Number(item.ts) || 0));
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
