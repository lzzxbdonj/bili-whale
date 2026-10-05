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
import { runDmCheck, runReplyCheck } from '../lib/index.js';
import { appendLog, resolveConfig } from '../lib/config.js';
import { heartbeat, syncOnce } from '../lib/cloudsync.js';
import { buildBiliTools } from '../lib/tools.js';

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

async function tick() {
  const stamp = new Date().toLocaleTimeString();
  round += 1;
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
