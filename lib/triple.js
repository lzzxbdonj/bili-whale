/**
 * 「好内容随手三连 + 分类收藏 + 浏览记录」。
 *
 * 主人的要求（2026-10-05）：「刷视频记得好的内容随手三连并分类，刷过的视频放入浏览记录」。
 * 三件事在这里合起来做：
 *   1. **三连**：点赞（`/x/web-interface/archive/like`）+ 投币（`/x/web-interface/coin/add`）
 *      + 收藏（`/x/v3/fav/resource/deal`），逐步容错 —— 少一步不算失败；
 *   2. **分类**：按学习方向选收藏夹（`feed.folderByTopic` → `feed.favoriteFolder` 兜底），
 *      夹子不存在就顺手建一个；
 *   3. **浏览记录**：把看过的视频报进 B 站历史（`/x/v2/history/report`）。
 *
 * 该不该连由 `policy.checkTriple` 说了算（分数门槛 / 每日上限 / 标题黑名单 / confirm 模式），
 * 这个模块只负责「判断通过之后真的去点」。本机与云端共用同一份代码。
 *
 * @module dsh-bilibili-whale/triple
 */
import { checkTriple, pickFolderTitle, DEFAULT_FAVORITE_FOLDER } from './policy.js';
import { recordFavorite, recordWatched } from './ledger.js';

/** 三连相关配置（缺项都给兜底，云端可能跑在旧配置上）。 */
export function tripleConfig(cfg) {
  const policy = cfg?.policy ?? {};
  const feed = cfg?.feed ?? {};
  return {
    mode: policy.postTriple ?? 'confirm',
    minScore: Number(policy.tripleMinScore ?? 6),
    coin: Math.min(Math.max(Number(policy.tripleCoin ?? 1), 1), 2),
    dailyLimit: Number(policy.dailyTriples ?? 5),
    reportHistory: policy.reportHistory !== false,
    folderDefault: String(feed.favoriteFolder ?? '').trim() || DEFAULT_FAVORITE_FOLDER,
    folderByTopic: feed.folderByTopic ?? {},
  };
}

/** 找到（必要时新建）一个收藏夹，返回它的 id。 */
export async function ensureFolder(client, title) {
  const wanted = String(title ?? '').trim() || DEFAULT_FAVORITE_FOLDER;
  const folders = await client.favFolders();
  const hit = (Array.isArray(folders) ? folders : []).find((item) => String(item.title ?? '') === wanted);
  if (hit !== undefined && Number(hit.id) > 0) return { id: Number(hit.id), title: wanted, created: false };
  const made = await client.favFolderCreate(wanted);
  if (Number(made?.id ?? 0) <= 0) throw new Error(`建收藏夹「${wanted}」没拿到 id`);
  return { id: Number(made.id), title: wanted, created: true };
}

/** 「已经点过赞了」这类回执不算失败：接口会以错误码返回，其实状态就是我们想要的。 */
function alreadyDone(issue) {
  return /已经(点赞|投币)|重复(点赞|投币)|65006|34005|超过投币上限|硬币不足|-102/.test(String(issue?.message ?? issue));
}

/**
 * 给一个视频三连，并按方向归进收藏夹。
 *
 * @param options.client - `BiliClient`。
 * @param options.cfg - 配置。
 * @param options.ledger - 账本（会记一条带 `triple` 标记的收藏）。
 * @param options.video - 视频对象，至少要有 `aid`/`bvid`/`title`。
 * @param options.topic - 学习方向（决定进哪个收藏夹）。
 * @param options.score - 这个视频的分数（决定够不够「好内容」）。
 * @param options.confirm - 主人点头过的调用传 true。
 * @returns {Promise<{done:boolean,needsConfirm:boolean,reasons:string[],like:boolean,coin:number,folder:object|null,errors:string[]}>}
 */
export async function tripleVideo({ client, cfg, ledger, video, topic = '', score = 0, confirm = false, now = Date.now() }) {
  const verdict = checkTriple({ cfg, ledger, video, score, confirm, now });
  const result = { done: false, needsConfirm: verdict.needsConfirm === true, reasons: verdict.reasons ?? [], like: false, coin: 0, folder: null, errors: [] };
  if (verdict.allowed !== true) return result;
  const conf = tripleConfig(cfg);
  const aid = Number(video?.aid ?? 0);
  const bvid = String(video?.bvid ?? '');

  try {
    await client.videoLike({ aid, bvid, like: true });
    result.like = true;
  } catch (issue) {
    if (alreadyDone(issue)) result.like = true;
    else result.errors.push(`点赞失败：${String(issue?.message ?? issue).slice(0, 80)}`);
  }

  try {
    await client.videoCoin({ aid, bvid, multiply: conf.coin, alsoLike: false });
    result.coin = conf.coin;
  } catch (issue) {
    if (alreadyDone(issue)) result.coin = 0;
    else result.errors.push(`投币失败：${String(issue?.message ?? issue).slice(0, 80)}`);
  }

  const wanted = pickFolderTitle(cfg, { topic: topic || video?.topic || '', title: video?.title ?? '' });
  try {
    const folder = await ensureFolder(client, wanted);
    result.folder = folder;
    await client.favDeal({ aid, addIds: [folder.id] });
  } catch (issue) {
    result.errors.push(`收藏失败：${String(issue?.message ?? issue).slice(0, 80)}`);
  }

  result.done = result.like === true || result.coin > 0 || result.folder !== null;
  if (result.done === true) {
    recordFavorite(ledger, {
      aid,
      bvid,
      title: String(video?.title ?? ''),
      upName: String(video?.author ?? ''),
      folderId: result.folder?.id ?? null,
      triple: true,
      like: result.like === true,
      coin: result.coin,
      ts: now,
      now: new Date(now),
    });
  }
  return result;
}

/**
 * 把看过的视频报进 B 站浏览记录（「刷过的视频放入浏览记录」），**并且在本机账本留一条痕**。
 *
 * 两件事分开看：
 *   1. **B 站历史**：要有 `cid` 才报得成（`search` 搜出来的条目不带 cid，这时只能留本机痕）。
 *      没有 cid 就静默跳过——不该因为一条历史记录打断刷视频。
 *   2. **本机账本**（`ledger.watched`）：**报没报成都记**。主人 2026-10-05：
 *      「让它刷视频能留下痕迹」——B 站历史只有她账号里看得到，主人要核「她今天刷了什么、
 *      有没有在摸鱼」得有本机这份。《popular/ranking/rcmd》的条目自带 `cid`（见 api.js
 *      的 `normalizeVideo`），所以刷列表也能免费报上去。
 *
 * @param options.ledger - 给了就顺手记一条 `ledger.watched`（不落盘，调用方自己 saveLedger）。
 * @param options.topic - 学习方向（留痕用）。
 * @param options.source - 从哪儿刷到的（popular / ranking / rcmd / search / video …）。
 * @returns {Promise<{reported:boolean,reason?:string,progress?:number}>}
 */
export async function reportHistory({ client, cfg, video, ledger = null, progress = 0, topic = '', source = '' }) {
  const outcome = await reportHistoryOnce({ client, cfg, video, progress });
  if (ledger !== null && ledger !== undefined) {
    recordWatched(ledger, {
      bvid: video?.bvid,
      aid: video?.aid,
      title: video?.title,
      upName: video?.author,
      topic,
      source,
      cid: video?.cid,
      reported: outcome.reported === true,
    });
  }
  return outcome;
}

/** 真去报 B 站历史这一步（抽出来是为了让留痕逻辑罩住「报失败」的情况）。 */
async function reportHistoryOnce({ client, cfg, video, progress = 0 }) {
  const conf = tripleConfig(cfg);
  if (conf.reportHistory !== true) return { reported: false, reason: '配置里 policy.reportHistory = false' };
  const aid = Number(video?.aid ?? 0);
  const cid = Number(video?.cid ?? 0);
  if (aid <= 0) return { reported: false, reason: '没有拿到 aid' };
  if (cid <= 0) return { reported: false, reason: '没有 cid，报不了浏览记录' };
  const total = Number(video?.durationSec ?? 0);
  const at = Number(progress) > 0 ? Math.round(Number(progress)) : total > 0 ? Math.max(1, Math.round(total * 0.9)) : 60;
  try {
    await client.historyReport({ aid, bvid: String(video?.bvid ?? ''), cid, progress: at });
    return { reported: true, progress: at };
  } catch (issue) {
    return { reported: false, reason: String(issue?.message ?? issue).slice(0, 80) };
  }
}
