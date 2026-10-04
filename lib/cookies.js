/**
 * 登录态（cookie jar）读写。
 *
 * 只保留发请求真正需要的几个键，其余（buvid 等）也一并存下来用于风控指纹。
 * 存储位置：$DSH_HOME/bilibili-whale/cookies.json
 *
 * @module dsh-bilibili-whale/cookies
 */
import { readJsonFile, writeJsonFile, statePath } from './config.js';

/** B 站登录必需/有用的 cookie 键。 */
export const COOKIE_KEYS = [
  'SESSDATA',
  'bili_jct',
  'DedeUserID',
  'DedeUserID__ckMd5',
  'sid',
  'buvid3',
  'buvid4',
  'b_nut',
  'buvid_fp',
  'CURRENT_FNVAL',
  'CURRENT_QUALITY',
];

/** cookies.json 的完整路径。 */
export function cookiePath() {
  return statePath('cookies.json');
}

/** 读取已保存的登录态；没有则返回 null。 */
export function loadSession() {
  const value = readJsonFile(cookiePath(), null);
  if (value === null || typeof value !== 'object') return null;
  if (typeof value.cookies !== 'object' || value.cookies === null) return null;
  return value;
}

/**
 * 写入登录态（原子写）。
 *
 * 安全网：合并磁盘上已有的 cookie —— 只带 buvid 的匿名写盘绝不能把
 * SESSDATA / bili_jct 抹掉（曾经因为 ensureBuvid 落盘把登录态冲掉过）。
 * 真要清空请用 clearSession()。
 */
export function saveSession(session) {
  const incoming = session?.cookies ?? {};
  const previous = loadSession();
  const merged = { ...(previous?.cookies ?? {}), ...incoming };
  const value = {
    ...(previous ?? {}),
    ...(session ?? {}),
    cookies: merged,
    savedAt: session?.savedAt ?? new Date().toISOString(),
    user: session?.user ?? previous?.user ?? {},
  };
  if (hasWriteCredentials(merged) === false) value.anonymousFingerprint = true;
  else delete value.anonymousFingerprint;
  writeJsonFile(cookiePath(), value);
  return value;
}

/** 删除登录态。 */
export function clearSession() {
  writeJsonFile(cookiePath(), { cookies: {}, savedAt: new Date().toISOString(), loggedOut: true });
}

/**
 * 解析 "a=1; b=2" 形式的 cookie 字符串。
 * @param raw - 原始字符串。
 * @returns 键值记录。
 */
export function parseCookieString(raw) {
  const out = {};
  for (const part of String(raw).split(';')) {
    const item = part.trim();
    if (item === '') continue;
    const eq = item.indexOf('=');
    if (eq <= 0) continue;
    out[item.slice(0, eq).trim()] = item.slice(eq + 1).trim();
  }
  return out;
}

/**
 * 解析 fetch 的 Set-Cookie 头数组（Node 20+ 的 headers.getSetCookie()）。
 * @param list - Set-Cookie 字符串数组。
 * @returns 键值记录。
 */
export function parseSetCookie(list) {
  const out = {};
  for (const raw of list ?? []) {
    const first = String(raw).split(';')[0] ?? '';
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    out[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
  }
  return out;
}

/** 组 Cookie 请求头；无 cookie 时返回空串。 */
export function cookieHeader(cookies) {
  const pairs = Object.entries(cookies ?? {})
    .filter(([key, value]) => typeof value === 'string' && value !== '' && (COOKIE_KEYS.includes(key) || key.startsWith('buvid') || key.startsWith('b_')))
    .map(([key, value]) => `${key}=${value}`);
  return pairs.join('; ');
}

/** 有 bili_jct 才能做写操作（它是 csrf token 的来源）。 */
export function hasWriteCredentials(cookies) {
  return typeof cookies?.bili_jct === 'string' && cookies.bili_jct !== '' && typeof cookies?.SESSDATA === 'string' && cookies.SESSDATA !== '';
}
