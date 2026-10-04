/**
 * 学习笔记 → 知识库（主人 2026-10-05 的要求）。
 *
 * 主人原话：**「学习后数据要存入这个文件夹并压缩」**「后面可以作为知识库使用」。
 * 所以这里的活儿分三件：
 *   1. **存**：把账本里学过的视频笔记落到 `notes/` 文件夹（默认 `E:\donk\dsh-bilibili-whale\notes`）；
 *   2. **压缩**：不是打包 zip，而是**合并成一个 markdown**（`notes/knowledge-base.md`），
 *      按方向分组、去重、只留知识点本身，长原文不留；
 *   3. **能查**：同一份内容再写一份机器可读的 `notes/knowledge-index.json`，
 *      她回私信 / 写评论时可以 `searchKnowledge()` 捞相关的学过的东西，
 *      答得上「你最近学了什么」，而不是瞎编。
 *
 * 两份产物是同一个来源（账本 `ledger.study`）重算的，所以随时可以整份重写、不会累积脏数据。
 *
 * @module dsh-bilibili-whale/kb
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 插件包根目录（本机是 node_modules 里那份，云端是 clone 出来的仓库）。 */
const PKG_ROOT = path.resolve(HERE, '..');
/** 开发仓库路径：本机跑的时候优先把笔记写进这个仓库，主人一眼能看到。 */
const DEV_REPO = 'E:\\donk\\dsh-bilibili-whale';

export const KB_FILE = 'knowledge-base.md';
export const KB_INDEX = 'knowledge-index.json';

/**
 * 知识库目录：主人可配 `knowledge.dir`；没配就自动挑一个合适的：
 *   1. 环境变量 `WHALE_NOTES_DIR`（云端 workflow 里指到仓库的 notes/）
 *   2. 本机的开发仓库 `E:\donk\dsh-bilibili-whale\notes`（存在才用）
 *   3. 插件包自己的 `notes/`（云端 clone 出来的仓库正好是这个）
 */
export function kbDir(cfg) {
  const configured = String(cfg?.knowledge?.dir ?? '').trim();
  if (configured !== '') return configured;
  const fromEnv = String(process.env.WHALE_NOTES_DIR ?? '').trim();
  if (fromEnv !== '') return fromEnv;
  try {
    if (fs.existsSync(path.join(DEV_REPO, 'lib', 'tools.js'))) return path.join(DEV_REPO, 'notes');
  } catch {
    /* 读不到就算了 */
  }
  return path.join(PKG_ROOT, 'notes');
}

export function kbFiles(cfg) {
  const dir = kbDir(cfg);
  return { dir, file: path.join(dir, KB_FILE), index: path.join(dir, KB_INDEX) };
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (issue) {
    if (issue?.code !== 'EEXIST') throw issue;
  }
}

function fmtDate(ts) {
  const d = new Date(Number(ts) || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 一条笔记压成一句知识点（去掉换行、控长度）。 */
function oneLine(text, max = 200) {
  const flat = String(text ?? '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

/** 账本里的 study 记录 → 知识库条目（按 bvid 去重，保留信息最全的那条）。 */
export function kbEntries(ledger, { limit = 500 } = {}) {
  const seen = new Map();
  for (const item of Array.isArray(ledger?.study) ? ledger.study : []) {
    const bvid = String(item?.bvid ?? '').trim();
    if (bvid === '') continue;
    const note = String(item?.note ?? '').trim();
    const prev = seen.get(bvid);
    if (prev !== undefined && String(prev.note ?? '').length >= note.length) continue;
    seen.set(bvid, {
      bvid,
      aid: Number(item?.aid ?? 0),
      title: String(item?.title ?? '').trim() || bvid,
      upName: String(item?.upName ?? '').trim(),
      topic: String(item?.topic ?? '').trim() || '未分类',
      score: Number(item?.score ?? 0),
      note,
      meaningful: item?.meaningful === true,
      ts: Number(item?.ts ?? 0) || Date.now(),
    });
  }
  return Array.from(seen.values())
    .sort((a, b) => b.ts - a.ts)
    .slice(0, Math.max(1, limit));
}

/** 合并成一份 markdown：按方向分组，方向内新的在前。 */
export function renderKnowledgeBase(entries, { cfg, now = Date.now() } = {}) {
  const ownerNames = [cfg?.ownerName, ...(Array.isArray(cfg?.ownerNames) ? cfg.ownerNames : [])]
    .filter((name) => typeof name === 'string' && name.trim() !== '');
  const byTopic = new Map();
  for (const entry of entries) {
    if (!byTopic.has(entry.topic)) byTopic.set(entry.topic, []);
    byTopic.get(entry.topic).push(entry);
  }
  const lines = [];
  lines.push('# 小鲸鱼娘的学习笔记（知识库）');
  lines.push('');
  lines.push(`> 她自己刷视频学来的东西，攒在这里。更新于 ${new Date(now).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}。`);
  lines.push('> 用法：按方向找、按 `Ctrl+F` 搜关键词；每条的「知识点」是她看完视频自己写的一句话总结，不是原文摘抄。');
  lines.push('');
  lines.push(`共 **${entries.length}** 条笔记，**${byTopic.size}** 个方向。`);
  lines.push('');
  lines.push('## 目录');
  lines.push('');
  for (const topic of Array.from(byTopic.keys()).sort((a, b) => byTopic.get(b).length - byTopic.get(a).length)) {
    const slug = topic.replace(/\s+/g, '-');
    lines.push(`- [${topic}](#${slug})（${byTopic.get(topic).length} 条）`);
  }
  lines.push('');
  for (const topic of Array.from(byTopic.keys()).sort((a, b) => byTopic.get(b).length - byTopic.get(a).length)) {
    lines.push(`## ${topic}`);
    lines.push('');
    for (const entry of byTopic.get(topic)) {
      const when = fmtDate(entry.ts);
      const up = entry.upName === '' ? '' : ` — ${entry.upName}`;
      lines.push(`### [${entry.title}](https://www.bilibili.com/video/${entry.bvid})${up}`);
      lines.push('');
      lines.push(`- 学习时间：${when}${entry.score > 0 ? `（筛选分 ${entry.score}）` : ''}${entry.meaningful === true ? ' · 已留言' : ''}`);
      if (entry.note !== '') lines.push(`- 知识点：${oneLine(entry.note, 240)}`);
      lines.push('');
    }
  }
  if (ownerNames.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push(`学习去向都会 @${ownerNames.join(' @')}，主人想看哪条直接点标题就行～`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * 把账本里的笔记整份重写成知识库（markdown + json 索引）。返回写入结果，失败抛错由调用方兜。
 */
export function writeKnowledgeBase(cfg, ledger, { now = Date.now() } = {}) {
  const entries = kbEntries(ledger, { limit: Number(cfg?.knowledge?.maxEntries ?? 500) });
  const markdown = renderKnowledgeBase(entries, { cfg, now });
  const { dir, file, index } = kbFiles(cfg);
  ensureDir(dir);
  fs.writeFileSync(file, markdown, 'utf8');
  fs.writeFileSync(
    index,
    `${JSON.stringify({ updatedAt: now, count: entries.length, entries }, null, 2)}\n`,
    'utf8',
  );
  return { dir, file, index, count: entries.length, bytes: Buffer.byteLength(markdown, 'utf8') };
}

/** 读知识库索引（没有就返回空数组，不报错）。 */
export function loadKnowledgeEntries(cfg) {
  const { index } = kbFiles(cfg);
  try {
    if (fs.existsSync(index) !== true) return [];
    const parsed = JSON.parse(fs.readFileSync(index, 'utf8'));
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

/** 中文也能用的朴素打分：整串命中 4 分、词命中 1 分，标题权重 ×2。 */
function scoreEntry(entry, keywords) {
  const title = `${entry.title ?? ''}`.toLowerCase();
  const topic = `${entry.topic ?? ''}`.toLowerCase();
  const note = `${entry.note ?? ''}`.toLowerCase();
  let score = 0;
  for (const word of keywords) {
    if (word.length >= 2 && title.includes(word)) score += 4;
    if (word.length >= 2 && topic.includes(word)) score += 2;
    if (word.length >= 2 && note.includes(word)) score += 1;
  }
  return score;
}

/** 把一句话切成关键词（中文按 2 字滑窗 + 英文/数字按词）。 */
export function keywordsOf(text) {
  const raw = String(text ?? '').toLowerCase();
  const words = new Set();
  for (const token of raw.match(/[a-z0-9]{2,}/g) ?? []) words.add(token);
  const han = raw.replace(/[^\u4e00-\u9fa5]/g, ' ');
  for (const run of han.split(/\s+/)) {
    if (run.length === 0) continue;
    if (run.length <= 3) {
      words.add(run);
      continue;
    }
    for (let i = 0; i + 2 <= run.length; i += 1) words.add(run.slice(i, i + 2));
  }
  return Array.from(words);
}

/** 从知识库里找和这句话最相关的几条（用于回私信时「想起来学过什么」）。 */
export function searchKnowledge(cfg, query, { limit = 3 } = {}) {
  const entries = loadKnowledgeEntries(cfg);
  if (entries.length === 0) return [];
  const keywords = keywordsOf(query);
  if (keywords.length === 0) return [];
  return entries
    .map((entry) => ({ entry, score: scoreEntry(entry, keywords) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.entry.ts ?? 0) - Number(a.entry.ts ?? 0))
    .slice(0, Math.max(1, limit))
    .map((row) => row.entry);
}

/** 拼成给脑子看的「人家学过的」上下文；没有相关内容就返回空串。 */
export function kbContext(cfg, query, { limit = null, maxChars = 600 } = {}) {
  const count = limit ?? Number(cfg?.knowledge?.contextEntries ?? 3);
  const hits = searchKnowledge(cfg, query, { limit: count });
  if (hits.length === 0) return '';
  const parts = [];
  let used = 0;
  for (const hit of hits) {
    const line = `- 《${hit.title}》（${hit.topic}）：${oneLine(hit.note, 160)}`;
    if (used + line.length > maxChars) break;
    used += line.length;
    parts.push(line);
  }
  if (parts.length === 0) return '';
  return `【她自己的学习笔记里相关的几条，可以自然地提一句，不要逐条念】\n${parts.join('\n')}`;
}
