import { loadSession, cookieHeader } from './lib/cookies.js';
import { BiliClient } from './lib/api.js';
import { resolveConfig } from './lib/config.js';
const session = loadSession();
const c = new BiliClient({ config: resolveConfig({}), session });
const nav = await c.nav();
console.log('nav:', JSON.stringify({ isLogin: nav.isLogin, uname: nav.uname, mid: nav.mid, level: nav.level, mobile: nav.mobileVerified, coins: nav.coins }));
console.log('cookies:', Object.keys(session.cookies ?? {}).join(','));
console.log('header:', cookieHeader(session.cookies ?? {}).slice(0, 160));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const H = { 'User-Agent': UA, Referer: 'https://message.bilibili.com/', Origin: 'https://message.bilibili.com', Cookie: cookieHeader(session.cookies ?? {}) };
for (const u of [
  'https://api.vc.bilibili.com/session_svr/v1/get_user_settings?build=0&mobi_app=web',
  'https://api.vc.bilibili.com/session_svr/v1/session_svr/single_unread?unread_type=0&show_unfollow_list=0&build=0&mobi_app=web',
  'https://api.bilibili.com/x/msgfeed/reply?platform=web&build=0&mobi_app=web',
  'https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&build=0&mobi_app=web&web_location=333.1339',
]) {
  const res = await fetch(u, { headers: H });
  console.log(`http=${res.status} ${u.slice(30, 95)} => ${(await res.text()).slice(0, 160)}`);
}
