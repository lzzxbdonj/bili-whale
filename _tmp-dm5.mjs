const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const res = await fetch('https://message.bilibili.com/', { headers: { 'User-Agent': UA } });
const html = await res.text();
const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
console.log('scripts:', scripts.length);
for (const s of scripts) console.log(' -', s);
const inline = [...html.matchAll(/https?:\/\/[a-z.]*bilibili\.com\/[a-zA-Z0-9_\/]*/g)].map((m) => m[0]);
console.log('inline urls:', [...new Set(inline)].slice(0, 20));
