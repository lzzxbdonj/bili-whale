import { loadSession } from './lib/cookies.js';
import { cookieHeader } from './lib/cookies.js';
const session = loadSession();
const cookie = cookieHeader(session.cookies ?? {});
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const url = 'https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&group_fold=1&unfollow_fold=0&sort_rule=2&build=0&mobi_app=web';
for (const origin of ['https://www.bilibili.com', 'https://message.bilibili.com', null]) {
  const headers = { 'User-Agent': UA, Referer: 'https://message.bilibili.com/', Cookie: cookie, Accept: 'application/json, text/plain, */*' };
  if (origin) headers.Origin = origin;
  const res = await fetch(url, { headers });
  const text = await res.text();
  console.log(`origin=${origin} http=${res.status} body=${text.slice(0, 300)}`);
}
