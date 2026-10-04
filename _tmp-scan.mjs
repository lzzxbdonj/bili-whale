import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out); else if (name.endsWith('.zstd')) out.push(p);
  }
  return out;
}
function multiFrame(buf) {
  const parts = []; let off = 0;
  while (off < buf.length) {
    try { const out = zlib.zstdDecompressSync(buf.subarray(off)); parts.push(out.toString('utf8')); break; }
    catch { break; }
  }
  return parts.join('');
}
const files = walk('C:\\Users\\Administrator\\.dsh\\sessions');
console.log('files:', files.length);
let hits = 0;
for (const f of files) {
  let text; try { text = multiFrame(readFileSync(f)); } catch { continue; }
  let idx = text.indexOf('SESSDATA');
  while (idx >= 0 && hits < 12) {
    console.log(`--- ${f.replace(/.*sessions\\/, '')} @${idx}`);
    console.log(text.slice(Math.max(0, idx - 120), idx + 260).replace(/\\n/g, ' '));
    hits += 1;
    idx = text.indexOf('SESSDATA', idx + 1);
  }
}
console.log('hits:', hits);
