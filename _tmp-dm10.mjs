import { loadSession, cookieHeader } from './lib/cookies.js';
import { BiliClient } from './lib/api.js';
import { resolveConfig } from './lib/config.js';
import { signUrl } from './lib/wbi.js';
const session = loadSession();
const c = new BiliClient({ config: resolveConfig({}), session });
const keys = await c.wbiKeys();
const cookies = session.cookies ?? {};
const csrf = cookies.bili_jct ?? '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const locale = JSON.stringify({ locale: 'zh-CN', timezone: 'Asia/Shanghai', utc_offset: 8 });
async function go(label, base, path, params) {
  const q = new URLSearchParams({ ...params, statistics: JSON.stringify({ appId: 100 }) });
  const url = signUrl(`${base}${path}?${q}`, keys.imgKey, keys.subKey);
  const res = await fetch(url, { headers: {
    'User-Agent': UA, Referer: 'https://message.bilibili.com/', Origin: 'https://message.bilibili.com',
    Cookie: cookieHeader(cookies), 'x-bili-locale-json': locale, 'x-bili-metadata-legal-region': 'CN', 'x-bili-metadata-ip-region': 'CN',
  } });
  const text = await res.text();
  console.log(`[${label}] http=${res.status} => ${text.slice(0, 320)}`);
}
const V = 'https://api.vc.bilibili.com';
await go('sessions', V, '/session_svr/v1/session_svr/get_sessions', { session_type: '1', group_fold: '1', unfollow_fold: '0', sort_rule: '2', build: '0', mobi_app: 'web', csrf, csrf_token: csrf });
await go('sessions+nocsrf', V, '/session_svr/v1/session_svr/get_sessions', { session_type: '1', build: '0', mobi_app: 'web' });
await go('fetch_msgs', V, '/svr_sync/v1/svr_sync/fetch_session_msgs', { talker_id: '3494364865103885', session_type: '1', size: '5', sender_device_id: '1', build: '0', mobi_app: 'web' });
