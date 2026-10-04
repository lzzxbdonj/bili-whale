import { loadSession, cookieHeader } from './lib/cookies.js';
const session = loadSession();
const cookies = session.cookies ?? {};
const cookie = cookieHeader(cookies);
const csrf = cookies.bili_jct ?? '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const H = { 'User-Agent': UA, Referer: 'https://message.bilibili.com/', Cookie: cookie, Accept: 'application/json, text/plain, */*', Origin: 'https://message.bilibili.com', 'x-bili-web-location': '333.1339' };
const base = 'session_type=1&group_fold=1&unfollow_fold=0&sort_rule=2&build=0&mobi_app=web';
async function go(label, url, init) {
  const res = await fetch(url, { headers: H, ...init });
  const text = await res.text();
  console.log(`[${label}] http=${res.status} => ${text.slice(0, 200)}`);
}
await go('GET+loc', `https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?${base}`);
await go('POST form', 'https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions', { method: 'POST', headers: { ...H, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `${base}&csrf=${csrf}&csrf_token=${csrf}` });
await go('msgs svc2', 'https://api.vc.bilibili.com/svc2/session_svr/v1/session_svr/session_msgs?session_type=1&talker_id=3494364865103885&session_id=0&size=5&build=0&mobi_app=web');
await go('msgs session_svr', 'https://api.vc.bilibili.com/session_svr/v1/session_svr/session_msgs?session_type=1&talker_id=3494364865103885&session_id=0&size=5&build=0&mobi_app=web');
await go('gen_session_id', 'https://api.vc.bilibili.com/web_im/v1/web_im/gen_session_id?talker_id=3494364865103885&session_type=1&build=0&mobi_app=web');
