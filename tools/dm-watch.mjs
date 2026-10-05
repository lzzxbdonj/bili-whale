/**
 * 私信看门鲸：每隔 N 分钟看一次私信，按策略回寒暄 / 记未读。
 *
 * 用法：node tools/dm-watch.mjs [--minutes 10] [--once] [--sync-every 15]
 *
 * 为什么需要它：宿主里的定时器只在 DSH 运行时存在；没重启 DSH 之前，
 * 这个独立进程能让私信照常被看见（真回复由会话里的模型 bili_dm op=reply 完成）。
 * 顺带替宿主做两件云端值班的事：报心跳（告诉云端「本机在岗」）、
 * 定期把遥控台上主人点过头的草稿发出去。
 */
import { spawn } from 'node:child_process';
import { closeSync, openSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runDmCheck, runReplyCheck, runStudyOnce } from '../lib/index.js';
import { appendLog, readJsonFile, resolveConfig, statePath, writeJsonFile } from '../lib/config.js';
import { heartbeat, syncOnce } from '../lib/cloudsync.js';
import { buildBiliTools } from '../lib/tools.js';

const SELF = fileURLToPath(import.meta.url);
/** 本进程的出生时间：比它更晚的 `restart.request` 才算「主人让人家换一条命」。 */
const START_TS = Date.now();

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const minutes = Math.max(0.25, Number(flag('minutes', '10')) || 10);
const once = args.includes('--once');
/** 每多少轮做一次完整云端交接（20 秒 × 15 轮 = 5 分钟）。 */
const syncEvery = Math.max(1, Number(flag('sync-every', '15')) || 15);
/** 每多少轮看一次「谁回了她 / @ 了她」（20 秒 × 15 轮 = 5 分钟）。 */
const replyEvery = Math.max(1, Number(flag('reply-every', '15')) || 15);
/**
 * 每多少轮自己刷一轮视频学习（20 秒 × 30 轮 = 10 分钟）。
 *
 * 主人 2026-10-05：「我要让她一直自动的刷视频学习」。宿主里的学习定时器只有 DSH
 * 开着时才跑；看门鲸是常驻进程，所以这里也挂上一条，DSH 关了照样在学。
 * 两条加起来大约每 5 分钟一轮（`learnOnce` 里按 bvid 去重，不会学重）。
 */
const studyEvery = Math.max(1, Number(flag('study-every', '30')) || 30);
let round = 0;

/** 本机在岗时本机就是云端的「手」：把主人点过头的草稿发出去。 */
function commentTool() {
  try {
    return buildBiliTools({ pluginConfig: {} }).find((tool) => tool.name === 'bili_comment') ?? null;
  } catch (error) {
    appendLog('auto.log', `dm-watch 取评论工具失败：${error.message}`);
    return null;
  }
}

/**
 * 报心跳：写 `statePath('watchdog.json')`。
 *
 * 主人 2026-10-05「给另一个主人调试最高权限」：调试档主人在私信里发「状态」时，
 * 要靠这个文件说清「看门鲸还活着吗、pid 多少、每几分钟一轮」。
 */
function writeHeartbeat() {
  try {
    writeJsonFile(statePath('watchdog.json'), {
      pid: process.pid,
      ts: Date.now(),
      everyMinutes: minutes,
      script: SELF,
      cwd: process.cwd(),
      argv: args,
    });
  } catch (error) {
    appendLog('auto.log', `dm-watch 写心跳失败：${error.message}`);
  }
}

/**
 * 主人从私信里让人家「重启」时，调试台会写 `statePath('restart.request')`；
 * 这里每轮开头看一眼：请求比本进程更新，就**自己把自己换一条命**。
 *
 * 为什么要重启：Node 的 ESM 模块只在进程启动时读一次盘 —— 改了 `lib/*.js` 而没重启，
 * 改的代码根本没进内存（第七轮踩过：改完不重启就是白改）。
 */
function checkRestart() {
  const request = readJsonFile(statePath('restart.request'), null);
  const ts = Number(request?.ts ?? 0);
  if (!Number.isFinite(ts) || ts <= START_TS) return;
  try {
    // 新的一条命要把日志接上（`stdio: 'ignore'` 会让重启后的看门鲸变成哑巴，出问题查不出来）。
    const out = openSync('dm-watch.log', 'a');
    const err = openSync('dm-watch.err.log', 'a');
    let child = null;
    try {
      child = spawn(process.execPath, [SELF, ...args], {
        cwd: process.cwd(),
        detached: true,
        stdio: ['ignore', out, err],
        windowsHide: true,
      });
    } finally {
      closeSync(out);
      closeSync(err);
    }
    child.unref();
    appendLog('auto.log', `看门鲸按主人（${request?.by ?? '?'}）要求换了一条命：旧 pid ${process.pid} → 新 pid ${child.pid ?? '?'}`);
    rmSync(statePath('restart.request'), { force: true });
    console.log(`[${new Date().toLocaleTimeString()}] 主人让人家重启：旧 pid ${process.pid} → 新 pid ${child.pid ?? '?'}`);
    process.exit(0);
  } catch (error) {
    appendLog('auto.log', `dm-watch 重启失败：${error.message}`);
  }
}

/**
 * 看门鲸不再自带配置覆盖 —— 让它跟宿主插件读同一份用户配置（一个真相来源）。
 *
 * 2026-10-05 的教训（记在这里，免得下次又踩）：
 *  - 私信一度「一次发两个」：本机有两个写手（这个进程 + 宿主插件的定时器）。宿主里的模块是
 *    DSH 启动那一刻载入的，Node 的 ESM 缓存按进程生效 —— 当天新加的跨进程锁 `locks/dm-round.lock`、
 *    追加日志 `replied.jsonl`、并集落盘 `saveLedgerMerged` 它都看不见，于是两边各拿旧快照覆盖写。
 *    当时靠「用户配置里关掉插件三条线 + 这里显式开回来」先止血，根治是**重启一次 DSH 宿主**。
 *  - 回复轮别用 `replyPerRun: 0` 来静音：旧代码 `lib/reply.js:25` 是 `Math.max(1, …)`，写 0 被抬成 1。
 *  - 插件重载的判断：`boot.json` 的 `loadedAt`/`pid` 才会刷新（`plugin_manager` 关开插件**不会**重新 import）。
 * 现在两边都是新代码、都带锁（`dm-round` / `study-round`），所以这里什么也不用覆盖了。
 */

async function tick() {
  const stamp = new Date().toLocaleTimeString();
  round += 1;
  checkRestart();
  writeHeartbeat();
  try {
    const result = await runDmCheck({});
    const rows = (result?.notes ?? []).join(' / ');
    const unread = result?.acked === undefined ? '' : `寒暄 ${result.acked} 条`;
    console.log(`[${stamp}] 巡检完成：${unread}${rows === '' ? '' : ` · ${rows}`}`);
  } catch (error) {
    // 未登录 / 风控都会走到这里，别让看门鲸自己死掉。
    console.log(`[${stamp}] 巡检失败：${error.message}`);
    appendLog('auto.log', `dm-watch failed: ${error.message}`);
  }

  // 顺手报到：本机开着的时候，云端调度器就不该再喊 GitHub Actions 干活。
  try {
    await heartbeat({});
  } catch {
    /* 网络不通也照跑本机的活 */
  }

  // 评论区也归看门鲸管：别人回了她 / @ 了她，该回的就回一句（限流在 checkReply 里）。
  if (round % replyEvery === 0) {
    try {
      const outcome = await runReplyCheck({});
      if ((outcome?.replied ?? 0) > 0) console.log(`[${stamp}] 评论回复：回了 ${outcome.replied} 条`);
      else if ((outcome?.pending ?? 0) > 0) console.log(`[${stamp}] 评论回复：待回 ${outcome.pending} 条，这轮没到该回的时候`);
    } catch (error) {
      console.log(`[${stamp}] 评论回复失败：${error.message}`);
      appendLog('auto.log', `dm-watch 评论回复失败：${error.message}`);
    }
  }

  if (round % studyEvery === 0) {
    try {
      const outcome = await runStudyOnce({});
      const studied = outcome?.studied ?? 0;
      if (studied > 0) console.log(`[${stamp}] 刷视频学习：${outcome.topic ?? ''} 学了 ${studied} 个`);
      else if (outcome?.skipped) console.log(`[${stamp}] 刷视频学习：跳过（${outcome.skipped}）`);
    } catch (error) {
      console.log(`[${stamp}] 刷视频学习失败：${error.message}`);
      appendLog('study.log', `dm-watch 学习失败：${error.message}`);
    }
  }

  if (round % syncEvery === 0) {
    try {
      const outcome = await syncOnce({}, { commentTool: commentTool() });
      const posted = outcome?.served?.posted ?? 0;
      if (posted > 0) console.log(`[${stamp}] 云端交接：替主人发出 ${posted} 条草稿`);
    } catch (error) {
      appendLog('auto.log', `dm-watch 云端交接失败：${error.message}`);
    }
  }
}

await tick();
if (once) process.exit(0);

console.log(`看门鲸已上岗：每 ${minutes < 1 ? `${Math.round(minutes * 60)} 秒` : `${minutes} 分钟`}看一次私信（Ctrl+C 结束）。`);
setInterval(tick, minutes * 60_000);
