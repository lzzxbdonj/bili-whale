/**
 * 本机 ↔ 云端状态柜同步（小鲸鱼娘的「值班交接」）。
 *
 * 分工（主人定的）：
 *   - **本机开机 → 本机跑**：私信每 20 秒、自学每小时、20:30 发动态，全是本机定时器。
 *   - **本机关机 → 云端跑**：GitHub Actions 每 10 分钟一次，Worker 的 cron 会发现
 *     本机心跳不新鲜，于是喊一次 workflow。
 *
 * 所以本机要做三件事：
 *   1. **报心跳**（`meta.localSeenAt`）：让云端知道「有人在岗，别抢」；
 *   2. **交账本**（cookie / ledger / pending 合并推上去）：云端接手时不会重复评论；
 *   3. **接云端排的队**：主人可能在遥控台上点了头（draft.approved=true），
 *      本机在岗时就是那只「手」，负责把它真发出去，并在账本里记一笔。
 *
 * 全部 fail-soft：没配云端地址、网络不通、令牌不对，都只写日志、绝不抛给宿主。
 *
 * @module dsh-bilibili-whale/cloudsync
 */
import { appendLog, resolveConfig } from './config.js';
import { loadSession } from './cookies.js';
import { resolveCloud } from './cloud.js';
import { loadLedger, saveLedger } from './ledger.js';
import { loadPending, savePending } from './pending.js';
import { mergeLedger, mergePending } from './sync.js';
import { requestText } from './httpx.js';

/** 推给云端的请求超时（遥控台是 Cloudflare，正常几十毫秒）。 */
const TIMEOUT_MS = 15000;

/**
 * 本机配置里**该同步给云端**的那一部分。
 *
 * 为什么需要：云端 Worker 有自己的一份 cfg（`state:config`，来自 wrangler 变量 + 主人 /config 覆盖），
 * 跟本机 config.json 是两套。踩过的坑（2026-10-05 主人说「你这个@不对吧」）：
 * 云端只有 `OWNER_NAME`/`OWNER_MID` 两个变量，没有 `ownerNames`/`ownerMids`，
 * 于是云端写出来的评论只 @ 得到主人一个人，第二位主人永远收不到通知。
 *
 * 只搬「身份 + 策略 + 内容口味」，**绝不搬任何密钥**（cookie / 令牌 / 模型 apiKey 都留在本机）。
 */
export function cloudConfigPatch(pluginConfig = {}) {
  const cfg = resolveConfig(pluginConfig);
  const patch = {};
  for (const key of ['ownerName', 'ownerMid', 'ownerNames', 'ownerMids', 'whaleName', 'whaleMid', 'timezone']) {
    const value = cfg?.[key];
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    patch[key] = value;
  }
  for (const group of ['policy', 'feed', 'learning', 'dailyDynamic']) {
    const value = cfg?.[group];
    if (value === undefined || value === null || typeof value !== 'object') continue;
    const clean = {};
    for (const [k, v] of Object.entries(value)) {
      if (/key|token|secret|cookie/i.test(k)) continue;
      if (v === undefined || v === null) continue;
      clean[k] = v;
    }
    if (Object.keys(clean).length > 0) patch[group] = clean;
  }
  return patch;
}

/** 把本机配置搬一份到云端（`POST /config`，深合并）。 */
export async function pushConfig(pluginConfig) {
  const cloud = resolveCloud(pluginConfig);
  if (cloud.ok !== true) return { ok: false, reason: cloud.reason };
  const patch = cloudConfigPatch(pluginConfig);
  if (Object.keys(patch).length === 0) return { ok: true, skipped: '本机配置没什么可同步的' };
  const result = await cloudFetch(cloud, '/config', { method: 'POST', body: patch });
  writeLog(`config push：${Object.keys(patch).join('/')}（主人 ${(patch.ownerNames ?? []).join('、') || patch.ownerName || '?'}）`);
  return { ok: true, patch, result };
}

async function cloudFetch(cloud, path, { method = 'GET', body = null } = {}) {
  // 走 httpx：这台机器的 DNS 被污染，直连 workers.dev 会超时，必须借系统代理出去。
  const response = await requestText(`${cloud.url}${path}`, {
    method,
    headers: {
      'x-whale-token': cloud.token,
      ...(body === null ? {} : { 'content-type': 'application/json' }),
    },
    body: body === null ? null : JSON.stringify(body),
    proxy: cloud.proxy ?? '',
    timeoutMs: TIMEOUT_MS,
  });
  let payload = null;
  try {
    payload = response.text === '' ? null : JSON.parse(response.text);
  } catch {
    payload = null;
  }
  if (response.ok !== true) throw new Error(`遥控台 ${path} 返回 ${response.status}`);
  return payload;
}

function writeLog(line) {
  try {
    appendLog('cloudsync.log', line);
  } catch {
    /* 日志失败不影响值班 */
  }
}

/** 本机当前状态打包（cookie / 账本 / 草稿 / 心跳）。 */
function localSnapshot() {
  let cookies = {};
  try {
    cookies = loadSession()?.cookies ?? {};
  } catch {
    cookies = {};
  }
  return {
    cookies,
    ledger: loadLedger(),
    pending: loadPending()?.drafts ?? [],
    meta: { localSeenAt: Date.now(), writer: 'local', host: process.env.COMPUTERNAME ?? 'local' },
  };
}

/** 报心跳 + 交账本（合并式写入，云端不会因为拿到旧账本而重复行动）。 */
export async function pushState(pluginConfig) {
  const cloud = resolveCloud(pluginConfig);
  if (cloud.ok !== true) return { ok: false, reason: cloud.reason };
  const snapshot = localSnapshot();
  const result = await cloudFetch(cloud, '/state', { method: 'POST', body: snapshot });
  writeLog(`push ok：评论 ${snapshot.ledger.comments?.length ?? 0} / 学习 ${snapshot.ledger.study?.length ?? 0}，草稿 ${snapshot.pending.length} 条，云端草稿 ${result?.pending?.length ?? '?'} 条`);
  return { ok: true, result, snapshot };
}

/**
 * 拉云端账本与队列，并进本机（并集，不覆盖本机已有的记录）。
 */
export async function pullState(pluginConfig) {
  const cloud = resolveCloud(pluginConfig);
  if (cloud.ok !== true) return { ok: false, reason: cloud.reason };
  const state = await cloudFetch(cloud, '/state');
  const local = loadLedger();
  const merged = mergeLedger(local, state?.ledger ?? {});
  saveLedger(merged);
  const localPending = loadPending();
  const drafts = mergePending(localPending?.drafts ?? [], state?.pending ?? []);
  savePending({ ...localPending, drafts });
  return { ok: true, ledger: merged, drafts, meta: state?.meta ?? {} };
}

/**
 * 把遥控台上「主人已点头」的草稿真发出去（本机在岗时本机就是那只手）。
 *
 * 只用 `bili_comment … confirm=true` 走一次完整策略：草稿排队期间可能已经超配额、
 * 撞上屏蔽词或同视频已评过，那种情况就标 blocked，不硬发。
 */
export async function serviceApprovedDrafts(pluginConfig, { commentTool, limit = 3 } = {}) {
  if (commentTool === undefined) return { posted: 0, blocked: 0 };
  const cloud = resolveCloud(pluginConfig);
  if (cloud.ok !== true) return { ok: false, reason: cloud.reason };
  const state = await cloudFetch(cloud, '/state');
  const approved = (state?.pending ?? []).filter((draft) => draft?.approved === true && draft?.posted !== true);
  const local = loadPending();
  let posted = 0;
  let blocked = 0;
  for (const draft of approved.slice(0, limit)) {
    const message = String(draft.message ?? '').trim();
    const bvid = String(draft.bvid ?? '').trim();
    if (message === '' || bvid === '') continue;
    let result;
    try {
      result = await commentTool.execute({ id: bvid, message, confirm: true }, {});
    } catch (issue) {
      writeLog(`发草稿失败 bvid=${bvid}：${String(issue?.message ?? issue).slice(0, 160)}`);
      continue;
    }
    const ok = result?.allowed !== false && result?.needsConfirm !== true;
    const marker = { ...draft, posted: ok, postedAt: Date.now(), blockedReason: ok ? '' : (result?.reasons ?? []).join('；') };
    const drafts = mergePending(local?.drafts ?? [], [marker]).map((item) =>
      item.id === draft.id ? marker : item,
    );
    savePending({ ...local, drafts });
    if (ok) {
      posted += 1;
      writeLog(`草稿已发：${bvid}（${message.slice(0, 40)}…）`);
    } else {
      blocked += 1;
      writeLog(`草稿被策略拦下：${bvid}：${(result?.reasons ?? []).join('；')}`);
    }
  }
  appendLog('actions.log', `cloudsrv posted=${posted} blocked=${blocked}`);
  return { posted, blocked, approved: approved.length };
}

/**
 * 一次完整交接（本机定时器每 `cloud.syncMinutes` 分钟调一次）：
 * 先接云端的活（发已点头的草稿），再交账本 + 报心跳。
 */
export async function syncOnce(pluginConfig, { commentTool } = {}) {
  try {
    const served = await serviceApprovedDrafts(pluginConfig, { commentTool });
    const pushed = await pushState(pluginConfig);
    const configured = await pushConfig(pluginConfig);
    return { served, pushed, configured };
  } catch (issue) {
    writeLog(`同步失败：${String(issue?.message ?? issue).slice(0, 200)}`);
    return { ok: false, reason: String(issue?.message ?? issue) };
  }
}

/**
 * 只报到、不交账本：看门鲸每轮顺手叫一声，云端就知道「本机在岗，别把活派给 Actions」。
 *
 * 为什么要单独一条：整块账本（含 cookie）有二十多 KB，不适合二十秒推一次。
 */
export async function heartbeat(pluginConfig) {
  const cloud = resolveCloud(pluginConfig);
  if (cloud.ok !== true) return { ok: false, reason: cloud.reason };
  try {
    const payload = await cloudFetch(cloud, '/heartbeat', { method: 'POST', body: { host: process.env.COMPUTERNAME ?? 'local' } });
    return { ok: true, localSeenAt: payload?.localSeenAt ?? Date.now() };
  } catch (issue) {
    writeLog(`心跳失败：${String(issue?.message ?? issue).slice(0, 160)}`);
    return { ok: false, reason: String(issue?.message ?? issue) };
  }
}

/** 云端是否配好了（没配就静默跳过，不影响本机自己跑）。 */
export function cloudReady(pluginConfig) {
  try {
    const cloud = resolveCloud(pluginConfig);
    if (cloud.ok === true) return true;
    void resolveConfig(pluginConfig);
    return false;
  } catch {
    return false;
  }
}
