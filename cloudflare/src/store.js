/**
 * KV 状态层：小鲸鱼娘在云端的所有持久化（不依赖文件系统）。
 *
 * 键位约定：
 *   state:cookies —— 运行时 cookie（主要是 buvid3/buvid4 匿名指纹；登录 cookie 走机密）
 *   state:config  —— 主人通过 /config 覆盖的配置（与 config.json 同一套键，深合并）
 *   state:ledger  —— 账本（评论/回复/动态/每日计数）
 *   state:pending —— 待主人点头的视频评论草稿队列
 *   state:meta    —— 巡检元信息（lastPatrolAt / lastActionTs / 运行日志尾巴）
 *
 * 登录 cookie 来自机密 `BILI_COOKIES`（JSON 字符串），运行时读到的指纹更新只写 KV，
 * 两者在 loadState() 里合并成一个普通对象交给 BiliClient。
 *
 * @module store
 */

/** 机密里的登录 cookie（SESSDATA / bili_jct / DedeUserID …）解析成普通对象。 */
export function secretCookies(env) {
  const raw = env?.BILI_COOKIES;
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object') return { ...raw };
  try {
    const parsed = JSON.parse(String(raw));
    if (parsed !== null && typeof parsed === 'object') {
      // 容错：有人会把 { cookies: {...} } 或裸 cookie 串塞进来
      if (parsed.cookies !== undefined && typeof parsed.cookies === 'object') return { ...parsed.cookies };
      return { ...parsed };
    }
  } catch {
    /* 落到下面的 cookie 串解析 */
  }
  const out = {};
  for (const piece of String(raw).split(';')) {
    const index = piece.indexOf('=');
    if (index <= 0) continue;
    out[piece.slice(0, index).trim()] = piece.slice(index + 1).trim();
  }
  return out;
}

/** 读 KV JSON（坏数据/缺键都回退默认值，绝不抛）。 */
export async function getJson(kv, key, fallback) {
  try {
    const raw = await kv.get(key);
    if (raw === null || raw === undefined || raw === '') return fallback;
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/** 写 KV JSON（失败只返回 false，不抛）。 */
export async function putJson(kv, key, value) {
  try {
    await kv.put(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** 深合并（数组整体替换，纯对象递归；与 lib/config.js 的合并语义一致）。 */
export function deepMerge(base, override) {
  if (override === null || override === undefined) return base;
  if (Array.isArray(base) || Array.isArray(override)) return override;
  if (typeof base !== 'object' || typeof override !== 'object') return override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return out;
}

/**
 * 把 wrangler [vars] 里那串字符串配置折成 config 覆盖对象。
 *
 * 键位必须与 `lib/config.js` 的 DEFAULTS **同构**：策略类挂在 `policy.*`
 * （policy.js 只读 `cfg.policy.xxx`），每日动态时刻挂 `dailyDynamic.at`，
 * 刷流来源挂 `feed.sources`；`ownerName/ownerMid/whaleName/whaleMid/timezone/
 * observeOnly/personaModel` 是顶层扩展键。
 */
export function varsConfig(env) {
  const out = {};
  const policy = {};
  const num = (v) => (v === undefined || v === '' ? undefined : Number(v));
  const bool = (v) => (v === undefined || v === '' ? undefined : String(v).toLowerCase() === 'true');
  const ok = (value) => value !== undefined && value !== null && !(typeof value === 'number' && Number.isNaN(value));
  const setTop = (key, value) => {
    if (ok(value)) out[key] = value;
  };
  const setPolicy = (key, value) => {
    if (ok(value)) policy[key] = value;
  };
  setTop('ownerName', env?.OWNER_NAME);
  setTop('ownerMid', env?.OWNER_MID === undefined || env.OWNER_MID === '' ? undefined : String(env.OWNER_MID));
  setTop('whaleName', env?.WHALE_NAME);
  setTop('whaleMid', env?.WHALE_MID === undefined || env.WHALE_MID === '' ? undefined : String(env.WHALE_MID));
  setTop('timezone', env?.TIMEZONE);
  setTop('observeOnly', bool(env?.OBSERVE_ONLY));
  setTop('personaModel', env?.PERSONA_MODEL);
  setPolicy('postVideoComment', env?.POST_VIDEO_COMMENT);
  setPolicy('postReply', env?.POST_REPLY);
  setPolicy('postDynamic', env?.POST_DYNAMIC);
  setPolicy('dailyVideoComments', num(env?.DAILY_VIDEO_COMMENTS));
  setPolicy('dailyReplies', num(env?.DAILY_REPLIES));
  setPolicy('dailyDynamics', num(env?.DAILY_DYNAMICS));
  setPolicy('minIntervalSeconds', num(env?.MIN_INTERVAL_SECONDS));
  setPolicy('minIntervalSecondsOwner', num(env?.MIN_INTERVAL_SECONDS_OWNER));
  setPolicy('maxCommentChars', num(env?.MAX_COMMENT_CHARS));
  setPolicy('replyPerUserPerThread', num(env?.REPLY_PER_USER_PER_THREAD));
  setPolicy('replyPerUserWindowHours', num(env?.REPLY_PER_USER_WINDOW_HOURS));
  if (Object.keys(policy).length > 0) out.policy = policy;
  if (ok(env?.DAILY_DYNAMIC_AT)) out.dailyDynamic = { at: env.DAILY_DYNAMIC_AT };
  if (ok(env?.FEED_SOURCE)) out.feed = { sources: [env.FEED_SOURCE] };
  return out;
}

/** 一次性把云端状态全读出来（每个请求读一次，写操作结束再回写，避免读写放大）。 */
export async function loadState(env, { defaults }) {
  const kv = env?.WHALE_KV;
  const [cookieState, userConfig, ledger, pending, meta] = await Promise.all([
    getJson(kv, 'state:cookies', {}),
    getJson(kv, 'state:config', {}),
    getJson(kv, 'state:ledger', null),
    getJson(kv, 'state:pending', []),
    getJson(kv, 'state:meta', {}),
  ]);
  let cfg = deepMerge(defaults, varsConfig(env));
  cfg = deepMerge(cfg, userConfig ?? {});
  return {
    kv,
    cfg,
    ledger: ledger ?? {},
    pending: Array.isArray(pending) ? pending : [],
    meta: meta ?? {},
    cookies: { ...secretCookies(env), ...(cookieState ?? {}) },
  };
}

/** 回写运行时 cookie（只关心匿名指纹，登录串仍在机密里）。 */
export async function saveCookies(env, cookies) {
  const secret = secretCookies(env);
  const runtime = {};
  for (const [key, value] of Object.entries(cookies ?? {})) {
    if (secret[key] === value) continue;
    runtime[key] = value;
  }
  return putJson(env?.WHALE_KV, 'state:cookies', runtime);
}

export async function saveLedger(env, ledger) {
  return putJson(env?.WHALE_KV, 'state:ledger', ledger);
}

export async function savePending(env, pending) {
  return putJson(env?.WHALE_KV, 'state:pending', pending);
}

export async function saveMeta(env, meta) {
  return putJson(env?.WHALE_KV, 'state:meta', meta);
}

export async function saveUserConfig(env, userConfig) {
  return putJson(env?.WHALE_KV, 'state:config', userConfig);
}

/** 运行日志（KV 里保留最近 N 条，方便主人回看云端做过什么）。 */
export async function appendCloudLog(env, line, { limit = 100 } = {}) {
  const kv = env?.WHALE_KV;
  const list = await getJson(kv, 'state:log', []);
  const next = Array.isArray(list) ? list : [];
  next.push(`${new Date().toISOString()} ${line}`);
  while (next.length > limit) next.shift();
  await putJson(kv, 'state:log', next);
  return next;
}

export async function readCloudLog(env) {
  const list = await getJson(env?.WHALE_KV, 'state:log', []);
  return Array.isArray(list) ? list : [];
}
