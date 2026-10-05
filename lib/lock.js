/**
 * 跨进程小锁：同一时刻只让一个进程干同一件事。
 *
 * 为什么要有它（2026-10-05 真机「评论又重复回复了」）：
 * 本机有**两个**写手 —— DSH 宿主里的回复定时器（`replyCheckMinutes`，2 分钟一轮）
 * 和看门鲸 `tools/dm-watch.mjs --reply-every`（约 2 分钟一轮）。两边各自
 * `loadLedger()` 拿一份快照 → 各回一条 → 各 `saveLedger()` 一次，后写的把先写的
 * 记录盖掉（丢更新），于是「同一条评论只回一次」的去重就失忆了，下一轮又追着同一条回。
 * 用文件锁把「一轮回复」串起来，配合发之前重新读账本，就不会再追着同一条评论回两遍。
 *
 * 设计口味：
 *   - 拿不到锁**不抛错**，返回 `{ acquired: false, reason }`，让调用方决定「这轮先不动手」；
 *   - 锁文件是 `$DSH_HOME/bilibili-whale/locks/<name>.lock`，写进 pid 与时间，方便排查；
 *   - 锁文件超过 `staleMs`（默认 3 分钟）就当持有者已经崩了，抢过来用，免得死锁一辈子。
 *
 * @module dsh-bilibili-whale/lock
 */
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { statePath } from './config.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 锁文件里现在写着谁拿着（排查用；读不到就给空串）。 */
export function lockHolder(name) {
  try {
    return readFileSync(statePath(`locks/${name}.lock`), 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * 抢到 `<name>` 的锁再跑 `run()`；拿不到就原样返回拿不到。
 *
 * @param {string} name - 锁名（同一件事用同一个名字）。
 * @param {() => Promise<any>} run - 拿到锁之后要跑的活。
 * @param {{waitMs?: number, pollMs?: number, staleMs?: number}} [options]
 * @returns {Promise<{acquired: boolean, value?: any, reason?: string}>}
 */
export async function withLock(name, run, { waitMs = 20000, pollMs = 250, staleMs = 180000 } = {}) {
  const path = statePath(`locks/${name}.lock`);
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  let fd = null;
  try {
    mkdirSync(dirname(path), { recursive: true });
    for (;;) {
      try {
        fd = openSync(path, 'wx');
        writeSync(fd, `pid=${process.pid} at=${new Date().toISOString()} job=${name}\n`);
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        let age = 0;
        try {
          age = Date.now() - statSync(path).mtimeMs;
        } catch {
          age = 0; // 刚被释放，下一圈就能拿到
        }
        if (age > staleMs) {
          // 持有者多半是崩了（或被杀），抢过来。
          try {
            unlinkSync(path);
          } catch {
            /* 别人先删了也无妨 */
          }
          continue;
        }
        if (Date.now() >= deadline) {
          return { acquired: false, reason: `${name} 的锁被别的进程拿着（${Math.round(age / 1000)} 秒前：${lockHolder(name) || '不知道是谁'}）` };
        }
        await sleep(pollMs);
      }
    }
  } catch (error) {
    try {
      if (fd !== null) closeSync(fd);
    } catch {
      /* 忽略 */
    }
    try {
      unlinkSync(path);
    } catch {
      /* 忽略 */
    }
    return { acquired: false, reason: `拿不到 ${name} 的锁：${error.message}` };
  }

  try {
    return { acquired: true, value: await run() };
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* 忽略 */
    }
    try {
      unlinkSync(path);
    } catch {
      /* 忽略 */
    }
  }
}
