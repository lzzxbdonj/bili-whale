/**
 * 插件契约冒烟测试：用假 ctx 跑一遍 apply()，确认
 *   1. 13 个工具都注册上、名字唯一、参数与输出 schema 合法；
 *   2. apply 不会抛异常（宿主对「entry did not activate」零容忍）；
 *   3. 定时器与 boot 标记能正常落地。
 *
 * 用法：node test/smoke.mjs
 */
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { apply, msUntilNext, name, inject } from '../lib/index.js';

const registered = [];
const ctx = {
  tools: { register: (definition) => { registered.push(definition); return () => {}; } },
  // 真宿主里定时器只能从注入的 timer 服务拿（deprecated 别名 ctx.setTimeout 在没 inject 时
  // 连 typeof 都会抛 `cannot get property "timer" without inject`，2026-10-05 的定时器事故）。
  timeout: (fn, delay) => setTimeout(fn, delay),
  interval: (fn, delay) => setInterval(fn, delay),
  on: (event, handler) => { if (event === 'dispose') ctx._dispose = handler; },
};

assert.equal(typeof apply, 'function', 'apply 必须是函数');
assert.equal(name, 'biliwhale', 'name 必须与 cordis.patch.yml 的行 id 一致');
assert.deepEqual(
  [...inject].sort(),
  ['timer', 'tools'],
  'inject 必须同时声明 tools 与 timer（定时器服务）',
);

apply(ctx, {});

const expected = ['bili_login', 'bili_status', 'bili_config', 'bili_feed', 'bili_video', 'bili_comments', 'bili_comment', 'bili_reply', 'bili_inbox', 'bili_dynamic', 'bili_ledger', 'bili_follow', 'bili_dm', 'bili_favorite', 'bili_study', 'bili_cloud'];
const names = registered.map((tool) => tool.name);
for (const want of expected) assert.ok(names.includes(want), `缺少工具 ${want}`);
assert.equal(new Set(names).size, names.length, '工具名不能重复');
assert.equal(names.length, expected.length, '不该注册多余工具');

for (const tool of registered) {
  assert.equal(tool.parameters?.type, 'object', `${tool.name} 的 parameters 必须是 object schema`);
  assert.ok(tool.output?.schema, `${tool.name} 缺少 output.schema`);
  assert.equal(typeof tool.output.render, 'function', `${tool.name} 缺少 output.render`);
  assert.equal(typeof tool.execute, 'function', `${tool.name} 缺少 execute`);
  assert.ok(typeof tool.description === 'string' && tool.description.length > 10, `${tool.name} 的 description 太短`);
  assert.equal(typeof tool.timeoutMs, 'number', `${tool.name} 缺少 timeoutMs`);
}

// 定时时间计算
const at = new Date('2026-10-02T19:00:00');
assert.equal(msUntilNext('20:30', at), 90 * 60 * 1000, '20:30 距离 19:00 应是 90 分钟');
assert.equal(msUntilNext('18:00', at), 23 * 3600 * 1000, '已过的时间点应顺延到明天');
assert.equal(msUntilNext('bad', at), null, '非法时间返回 null');

// boot 标记
const bootPath = join(process.env.DSH_HOME ?? join(process.env.USERPROFILE, '.dsh'), 'bilibili-whale', 'boot.json');
assert.ok(existsSync(bootPath), 'apply 之后应写出 boot.json');
const boot = JSON.parse(readFileSync(bootPath, 'utf8'));
assert.deepEqual(boot.tools, names, 'boot.json 里的工具清单应与注册一致');

// dispose 不应抛
if (typeof ctx._dispose === 'function') ctx._dispose();

// 工具 count 说明
console.log(`✓ 冒烟测试通过：注册 ${names.length} 个工具 -> ${names.join(', ')}`);
console.log(`✓ boot.json: ${bootPath}`);
