/**
 * 等主人扫码：轮询 qrcode_key 直到成功 / 过期 / 超时。
 *
 * 用法：node tools/login-wait.mjs [--minutes 8] [--key <qrcode_key>]
 * 不带 --key 时用上一次 login-start 留下的 pending-qr.json。
 * 成功后 cookie 直接落盘（复用 bili_login op=poll 的同一段逻辑）。
 */
import { buildBiliTools } from '../lib/tools.js';
import { openBrowser } from '../lib/index.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const minutes = Number(flag('minutes', '8'));
const key = flag('key', undefined);
const deadline = Date.now() + minutes * 60 * 1000;

const login = buildBiliTools({ pluginConfig: {}, openBrowser }).find((tool) => tool.name === 'bili_login');
const states = { 0: '扫码成功', 86101: '还没扫码', 86090: '已扫码，等手机确认', 86038: '二维码已过期' };
let last = null;

while (Date.now() < deadline) {
  const result = await login.execute({ op: 'poll', qrcodeKey: key }, {});
  const label = result.state ?? `code=${result.code}`;
  if (label !== last) {
    console.log(`[${new Date().toLocaleTimeString()}] ${label}`);
    last = label;
  }
  if (result.loggedIn === true) {
    console.log(`✓ 登录成功：${result.uname}（UID ${result.mid}），可写权限 ${result.canWrite === true ? '有' : '没有'}`);
    for (const note of result.notes ?? []) console.log(`  · ${note}`);
    process.exit(0);
  }
  if (result.code === 86038) {
    console.log('✗ 二维码已过期，重新跑：node lib/cli.mjs login-start');
    process.exit(2);
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
}
console.log(`✗ ${minutes} 分钟内没有等到扫码`);
process.exit(3);
