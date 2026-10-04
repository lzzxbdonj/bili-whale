/**
 * 私信看门鲸：每隔 N 分钟看一次私信，按策略回寒暄 / 记未读。
 *
 * 用法：node tools/dm-watch.mjs [--minutes 10] [--once]
 *
 * 为什么需要它：宿主里的定时器只在 DSH 运行时存在；没重启 DSH 之前，
 * 这个独立进程能让私信照常被看见（真回复由会话里的模型 bili_dm op=reply 完成）。
 */
import { runDmCheck } from '../lib/index.js';
import { appendLog, resolveConfig } from '../lib/config.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const minutes = Math.max(0.25, Number(flag('minutes', '10')) || 10);
const once = args.includes('--once');

async function tick() {
  const stamp = new Date().toLocaleTimeString();
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
}

await tick();
if (once) process.exit(0);

console.log(`看门鲸已上岗：每 ${minutes < 1 ? `${Math.round(minutes * 60)} 秒` : `${minutes} 分钟`}看一次私信（Ctrl+C 结束）。`);
setInterval(tick, minutes * 60_000);
