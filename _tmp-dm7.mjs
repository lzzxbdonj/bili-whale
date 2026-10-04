const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const js = await (await fetch('https://s1.hdslb.com/bfs/static/2233-monorepo/message-pc/static/js/index.f2b7bca0.js', { headers: { 'User-Agent': UA, Referer: 'https://message.bilibili.com/' } })).text();
function ctx(needle, span = 260, max = 3) {
  let i = -1, n = 0;
  while (n < max) {
    i = js.indexOf(needle, i + 1);
    if (i < 0) break;
    console.log(`### ${needle} @${i}\n${js.slice(Math.max(0, i - span), i + span).replace(/\s+/g, ' ')}\n`);
    n += 1;
  }
}
ctx('session_svr/v1/session_svr/get_sessions', 300, 2);
ctx('fetch_sess_msg', 300, 2);
ctx('api.vc.bilibili.com', 300, 2);
