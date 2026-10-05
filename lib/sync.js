/**
 * 状态柜：本机（DSH 插件）与云端（GitHub Actions）共用同一本账本。
 *
 * 为什么要「合并」而不是「覆盖」：
 *   - 本机在线时由本机干活，云端每 10 分钟也会拉一次状态；
 *   - 本机可能刚回了一条私信、又关机，云端随后拿着旧账本开工 → 覆盖就会重复行动；
 *   - 所以两边的写入都做**并集合并**：同一条记录按 id/时间去重、取更新的那份，
 *     每日计数取两边最大值，cookie 只在「对方真的有登录串」时才覆盖。
 *
 * 分工约定：
 *   - `meta.localSeenAt` —— 本机最近一次心跳；云端看到它很新就让位（本机在岗）。
 *   - `pending` —— 待主人点头的草稿；本机与云端都可能排队，合并时按 id 去重。
 *
 * @module sync
 *
 * 注意：本模块在仓库里有两份拷贝 —— lib/sync.js 与 cloudflare/src/sync.js
 * （Worker 打包不能引用仓库外的相对路径）。两份必须**逐字一致**；改一份就一起改另一份。
 */

/** 各集合的去重键：同一个键视为同一条记录。 */
const KEYS = {
  comments: (item) => `${item?.bvid ?? item?.aid ?? ''}:${item?.rpid ?? item?.ts ?? ''}`,
  replies: (item) => `${item?.rpid ?? ''}:${item?.bvid ?? ''}:${item?.ts ?? ''}`,
  dynamics: (item) => `${item?.dynId ?? item?.date ?? item?.ts ?? ''}`,
  follows: (item) => `${item?.mid ?? ''}`,
  dms: (item) => `${item?.mid ?? ''}:${item?.direction ?? ''}:${item?.ts ?? item?.at ?? ''}`,
  favorites: (item) => `${item?.aid ?? item?.bvid ?? ''}`,
  study: (item) => `${item?.bvid ?? item?.ts ?? ''}`,
  dmIncoming: (item) => `${item?.mid ?? ''}:${item?.msgKey ?? item?.ts ?? ''}`,
  materials: (item) => `${item?.ts ?? ''}:${String(item?.text ?? '').slice(0, 40)}`,
};

/** 记录的时间戳（用于「谁更新」比较）。 */
function stamp(item) {
  const value = item?.ts ?? item?.at ?? item?.favTime ?? item?.studiedAt ?? 0;
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) return num;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 数组合并：并集 + 同键取更新的一份 + 按时间排序。 */
function mergeArray(base, incoming, keyOf) {
  const out = new Map();
  for (const item of Array.isArray(base) ? base : []) out.set(keyOf(item), item);
  for (const item of Array.isArray(incoming) ? incoming : []) {
    const key = keyOf(item);
    const old = out.get(key);
    if (old === undefined || stamp(item) >= stamp(old)) out.set(key, item);
  }
  return [...out.values()].sort((a, b) => stamp(a) - stamp(b));
}

/** 对象合并：逐键取「数值更大 / 非空」的一份（replyIndex、replyThreads 这类计数表）。 */
function mergeCounters(base, incoming) {
  const out = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(incoming ?? {})) {
    const old = out[key];
    if (typeof value === 'number' && typeof old === 'number') {
      out[key] = Math.max(old, value);
      continue;
    }
    if (value !== null && value !== undefined && value !== '') out[key] = value;
  }
  return out;
}

/** 每日计数：同一天逐字段取最大值。 */
function mergeDaily(base, incoming) {
  const out = { ...(base ?? {}) };
  for (const [date, bucket] of Object.entries(incoming ?? {})) {
    const old = out[date] ?? {};
    const merged = { ...old };
    for (const [field, value] of Object.entries(bucket ?? {})) {
      const oldValue = merged[field];
      merged[field] = typeof value === 'number' && typeof oldValue === 'number' ? Math.max(oldValue, value) : (value ?? oldValue);
    }
    out[date] = merged;
  }
  return out;
}

/**
 * 账本合并：本机与云端各干各的活，合到一起时谁都不能丢。
 */
export function mergeLedger(base, incoming) {
  const out = { ...(base ?? {}) };
  for (const [name, keyOf] of Object.entries(KEYS)) out[name] = mergeArray(base?.[name], incoming?.[name], keyOf);
  out.replyIndex = mergeCounters(base?.replyIndex, incoming?.replyIndex);
  out.replyThreads = mergeCounters(base?.replyThreads, incoming?.replyThreads);
  // 消息中心的「已读过」标记也要并过来：云端（趁本机不在时）读过的消息，
  // 本机接手后不该再当成新消息回一遍（主人 2026-10-05：别一条评论两端都回）。
  out.msgSeen = mergeCounters(base?.msgSeen, incoming?.msgSeen);
  out.daily = mergeDaily(base?.daily, incoming?.daily);
  out.lastActionTs = Math.max(Number(base?.lastActionTs ?? 0) || 0, Number(incoming?.lastActionTs ?? 0) || 0);
  out.lastActionOwnerTs = Math.max(Number(base?.lastActionOwnerTs ?? 0) || 0, Number(incoming?.lastActionOwnerTs ?? 0) || 0);
  out.dynamicTemplateIndex = Math.max(Number(base?.dynamicTemplateIndex ?? 0) || 0, Number(incoming?.dynamicTemplateIndex ?? 0) || 0);
  out.version = 1;
  return out;
}

/** 草稿队列合并：按 id 去重；已发出的（posted）与已驳回的不再留。 */
export function mergePending(base, incoming) {
  const out = new Map();
  for (const item of Array.isArray(base) ? base : []) {
    if (item?.posted === true || item?.rejected === true) continue;
    out.set(String(item?.id ?? `${item?.bvid}:${item?.at ?? ''}`), item);
  }
  for (const item of Array.isArray(incoming) ? incoming : []) {
    if (item?.posted === true || item?.rejected === true) continue;
    const key = String(item?.id ?? `${item?.bvid}:${item?.at ?? ''}`);
    const old = out.get(key);
    // 云端或本机任一边点了头，点头这件事要留住。
    out.set(key, old === undefined ? item : { ...old, ...item, approved: old.approved === true || item.approved === true });
  }
  return [...out.values()];
}

/**
 * cookie 合并：只带 buvid 指纹的写入**绝不能**抹掉登录串（本机踩过这个坑）。
 */
export function mergeCookies(base, incoming) {
  const out = { ...(base ?? {}) };
  const LOGIN = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'];
  const hasLogin = (bag) => LOGIN.some((key) => String(bag?.[key] ?? '') !== '');
  const protectedBase = hasLogin(base) && !hasLogin(incoming);
  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (value === null || value === undefined || value === '') continue;
    if (protectedBase && LOGIN.includes(key)) continue;
    out[key] = value;
  }
  if (hasLogin(incoming)) for (const key of LOGIN) delete out[`anonymous:${key}`];
  return out;
}

/** 元信息合并：浅合并 + 心跳时间取较新。 */
export function mergeMeta(base, incoming) {
  const out = { ...(base ?? {}), ...(incoming ?? {}) };
  out.localSeenAt = Math.max(Number(base?.localSeenAt ?? 0) || 0, Number(incoming?.localSeenAt ?? 0) || 0);
  out.cloudSeenAt = Math.max(Number(base?.cloudSeenAt ?? 0) || 0, Number(incoming?.cloudSeenAt ?? 0) || 0);
  return out;
}
