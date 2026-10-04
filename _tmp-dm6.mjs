const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const js = await (await fetch('https://s1.hdslb.com/bfs/static/2233-monorepo/message-pc/static/js/index.f2b7bca0.js', { headers: { 'User-Agent': UA, Referer: 'https://message.bilibili.com/' } })).text();
console.log('len', js.length);
const pats = [/session_svr[^"'\`]{0,80}/g, /web_im\/v1[^"'\`]{0,60}/g, /api\.vc\.bilibili\.com[^"'\`]{0,80}/g];
for (const p of pats) {
  const hits = [...new Set([...js.matchAll(p)].map((m) => m[0]))];
  console.log(`--- ${p} -> ${hits.length}`);
  for (const h of hits.slice(0, 25)) console.log('  ', h);
}
