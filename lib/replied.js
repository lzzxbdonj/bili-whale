/**
 * 「这条评论回过了」的**追加日志**：$DSH_HOME/bilibili-whale/replied.jsonl
 *
 * 为什么不能只信 ledger.json（2026-10-05 真机事故「评论又开始重复回复了」）：
 * 本机不止一个写手 —— 宿主插件的回复定时器、看门鲸、（将来）云端 —— 各自 `loadLedger()`
 * 拿一份快照、各回一条、各整份覆盖写。后写的把先写的记录**盖掉**（丢更新），
 * 记录一丢，`repliedToComment` 就失忆，同一条评论被追着回了 6 遍。
 *
 * 这份日志只追加、不重写：**谁也盖不掉**。去重时账本和日志两处都看
 * （账本是主人能看、能清的全量记录；日志是防丢更新的保险）。
 *
 * 只存最小的东西：rpid / root / bvid / 时间。写失败不影响主流程。
 *
 * @module dsh-bilibili-plugin/replied
 */
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { statePath } from './config.js';

const FILE = 'replied.jsonl';
/** 超过这个大小就裁一次，只留最近的 KEEP_LINES 行（一天几十条，正常几十天不用裁）。 */
const TRIM_BYTES = 512 * 1024;
const KEEP_LINES = 2000;

/** { stamp, rpids } 缓存：文件没变就不重复解析。 */
let cache = { stamp: null, rpids: new Set() };

function stamp() {
  try {
    const info = statSync(statePath(FILE));
    return `${info.size}:${Math.round(info.mtimeMs)}`;
  } catch {
    return 'none';
  }
}

function journalPath() {
  return statePath(FILE);
}

/**
 * 已经回过的 rpid 集合（账本被别的写手盖掉也认得出来）。
 * @returns {Set<number>}
 */
export function repliedRpidSet() {
  const now = stamp();
  if (now === cache.stamp) return cache.rpids;
  const rpids = new Set();
  if (now !== 'none') {
    try {
      for (const line of readFileSync(journalPath(), 'utf8').split('\n')) {
        if (line.trim() === '') continue;
        try {
          const value = Number(JSON.parse(line)?.rpid);
          if (Number.isFinite(value) && value > 0) rpids.add(value);
        } catch {
          /* 坏行跳过，不因为一行坏了就认不出别的 */
        }
      }
    } catch {
      /* 还没有日志 */
    }
  }
  cache = { stamp: now, rpids };
  return rpids;
}

/** 这条评论（rpid）回过了吗。 */
export function hasReplied(rpid) {
  const value = Number(rpid);
  if (!Number.isFinite(value) || value <= 0) return false;
  return repliedRpidSet().has(value);
}

/**
 * 记一笔「回过这条评论了」。
 * @param {number|string} rpid - 被回复的那条评论 rpid
 * @param {{root?: number|string, bvid?: string, ts?: number}} [extra]
 */
export function markReplied(rpid, { root = 0, bvid = '', ts = Date.now() } = {}) {
  const value = Number(rpid);
  if (!Number.isFinite(value) || value <= 0) return false;
  try {
    const line = JSON.stringify({
      rpid: value,
      root: Number(root) || 0,
      bvid: String(bvid ?? ''),
      ts: Number(ts) || Date.now(),
    });
    appendFileSync(journalPath(), `${line}\n`, 'utf8');
    trim();
    cache.stamp = null; // 下次读重新解析
    cache.rpids.add(value);
    return true;
  } catch {
    return false;
  }
}

/** 把某个 rpid / 某个视频的痕迹从日志里抹掉（主人说「这条再回一次」时用）。 */
export function forgetReplied({ rpid = 0, bvid = '' } = {}) {
  const targetRpid = Number(rpid);
  const targetBvid = String(bvid ?? '').trim();
  if ((!Number.isFinite(targetRpid) || targetRpid <= 0) && targetBvid === '') return 0;
  let kept = 0;
  let dropped = 0;
  try {
    const lines = readFileSync(journalPath(), 'utf8').split('\n').filter((line) => line.trim() !== '');
    const out = [];
    for (const line of lines) {
      let row = null;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const sameRpid = Number.isFinite(targetRpid) && targetRpid > 0 && Number(row?.rpid) === targetRpid;
      const sameBvid = targetBvid !== '' && String(row?.bvid ?? '') === targetBvid;
      if (sameRpid || sameBvid) dropped += 1;
      else {
        out.push(line);
        kept += 1;
      }
    }
    if (dropped > 0) {
      writeFileSync(journalPath(), out.length > 0 ? `${out.join('\n')}\n` : '', 'utf8');
      cache.stamp = null;
    }
  } catch {
    return 0;
  }
  return dropped;
}

/** 日志太大就裁到最近 KEEP_LINES 行。 */
function trim() {
  try {
    const info = statSync(journalPath());
    if (info.size <= TRIM_BYTES) return;
    const lines = readFileSync(journalPath(), 'utf8').split('\n').filter((line) => line.trim() !== '');
    writeFileSync(journalPath(), `${lines.slice(-KEEP_LINES).join('\n')}\n`, 'utf8');
  } catch {
    /* 裁不动就算了，下一次再说 */
  }
}
