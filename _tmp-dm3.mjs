import { loadSession, cookieHeader } from './lib/cookies.js';
const session = loadSession();
const cookies = session.cookies ?? {};
const cookie = cookieHeader(cookies);
const csrf = cookies.bili_jct ?? '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const H = { 'User-Agent': UA, Referer: 'https://message.bilibili.com/', Cookie: cookie, Accept: 'application/json, text/plain, */*' };
const base = 'session_type=1&group_fold=1&unfollow_fold=0&sort_rule=2&build=0&mobi_app=web';
const urls = [
  `https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?${base}&csrf=${csrf}&csrf_token=${csrf}`,
  `https://api.vc.bilibili.com/web_im/v1/web_im/get_sessions?${base}&csrf=${csrf}&csrf_token=${csrf}`,
  'https://api.bilibili.com/x/im/web/sessions?session_type=1&build=0&mobi_app=web',
  `https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&mobi_app=web&csrf=${csrf}`,
];
for (const u of urls) {
  const res = await fetch(u, { headers: H });
  const text = await res.text();
  console.log(`http=${res.status} ${u.slice(0, 78)} => ${text.slice(0, 220)}`);
}
