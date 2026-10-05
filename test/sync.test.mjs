/**
 * 跨端账本合并（lib/sync.js）—— 主人 2026-10-05 报的问题：
 * 「解决一条评论在云端和本地都回的问题」。
 *
 * 根因不是「谁来干活」，而是**两边各自回完都只写自己的账本**：
 * 云端回过的评论落在云端账本的 replies/msgSeen 里，本机接手时只 push 不 pull，
 * 于是同一条 @ / 评论被回了第二遍。修法是 mergeLedger 把 msgSeen 也并过来，
 * 并且本机每轮巡检前先 pullState。
 *
 * 另外钉一件事：lib/sync.js 与 cloudflare/src/sync.js 是同一份逻辑的两份拷贝
 * （Worker 打包不能引用仓库外的相对路径），改动必须逐字同步 —— 这条测试就是那道闸。
 *
 * 跑：node test/sync.test.mjs
 *
 * @module bili-whale/test/sync
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeCookies, mergeLedger, mergeMeta, mergePending } from '../lib/sync.js';
import { repliedToComment } from '../lib/ledger.js';

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (issue) {
    failures.push(`${name} → ${issue.message}`);
    console.log(`✗ ${name} → ${issue.message}`);
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));

// ── 1. 两份 sync.js 必须逐字一致 ───────────────────────────────────────────
check('lib/sync.js 与 cloudflare/src/sync.js 逐字一致（改动要一起改）', () => {
  const local = readFileSync(join(HERE, '..', 'lib', 'sync.js'), 'utf8');
  const cloud = readFileSync(join(HERE, '..', 'cloudflare', 'src', 'sync.js'), 'utf8');
  assert.equal(local, cloud, '两份拷贝内容不同：把改动同步到另一份');
});

// ── 2. 云端回过的那条，并回本机后本机不会再回 ───────────────────────────────
check('云端回过的评论并回本机后，repliedToComment 认得它', () => {
  const local = { replies: [], msgSeen: {} };            // 本机：没回过
  const cloud = {                                         // 云端：趁本机不在时回过
    replies: [{ bvid: 'BV1xx', aid: 1, rpid: 555, root: 555, targetMid: 99, targetUname: '路人', text: '回过了', isOwner: false, ts: 1000 }],
    msgSeen: { 9001: { at: 1000, auto: true, selfRpid: 555 } },
  };
  const merged = mergeLedger(local, cloud);
  assert.equal(merged.replies.length, 1);
  assert.ok(repliedToComment(merged, 555), '合并后本机应该认出「这条评论回过了」');
  assert.equal(merged.msgSeen['9001'].selfRpid, 555, 'msgSeen 必须并过来，否则本机把同一条消息又当新消息');
});

// ── 3. 两边各自读过的消息都在（并集，不互相覆盖）─────────────────────────────
check('msgSeen 是并集：本机读过的和云端读过的都留着', () => {
  const base = { msgSeen: { 1: { at: 10, auto: true } } };
  const incoming = { msgSeen: { 2: { at: 20, auto: true, selfRpid: 77 } } };
  const out = mergeLedger(base, incoming);
  assert.deepEqual(Object.keys(out.msgSeen).sort(), ['1', '2']);
  assert.equal(out.msgSeen['2'].selfRpid, 77);
  // 反过来合并也不能丢
  const back = mergeLedger(incoming, base);
  assert.deepEqual(Object.keys(back.msgSeen).sort(), ['1', '2']);
  assert.equal(back.msgSeen['1'].at, 10);
});

// ── 4. 老账本没有 msgSeen 字段也不能炸 ──────────────────────────────────────
check('任一边缺 msgSeen 时合并照样出对象（老账本兼容）', () => {
  assert.deepEqual(mergeLedger({}, {}).msgSeen, {});
  assert.deepEqual(mergeLedger(undefined, undefined).msgSeen, {});
  assert.deepEqual(Object.keys(mergeLedger({ msgSeen: { 5: { at: 1 } } }, {}).msgSeen), ['5']);
});

// ── 5. 原有合并语义没被改坏 ────────────────────────────────────────────────
check('回复并集按 rpid 去重、每日计数取大、心跳取新', () => {
  const base = {
    replies: [{ rpid: 1, bvid: 'BV1', ts: 100 }],
    daily: { '2026-10-05': { replies: 3, videoComments: 1 } },
  };
  const incoming = {
    replies: [{ rpid: 1, bvid: 'BV1', ts: 100 }, { rpid: 2, bvid: 'BV1', ts: 200 }],
    daily: { '2026-10-05': { replies: 1, videoComments: 4 } },
  };
  const out = mergeLedger(base, incoming);
  assert.equal(out.replies.length, 2);
  assert.equal(out.daily['2026-10-05'].replies, 3);
  assert.equal(out.daily['2026-10-05'].videoComments, 4);
  assert.equal(mergeMeta({ localSeenAt: 100 }, { localSeenAt: 300 }).localSeenAt, 300);
});

check('cookie 合并：只带 buvid 的写入不能抹掉登录串', () => {
  const out = mergeCookies({ SESSDATA: 'abc', bili_jct: 't' }, { buvid3: 'x' });
  assert.equal(out.SESSDATA, 'abc');
  assert.equal(out.buvid3, 'x');
});

check('草稿合并：任一边点过头都算点头、发过的不再留', () => {
  const out = mergePending([{ id: 'a', approved: true }], [{ id: 'a' }, { id: 'b', posted: true }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].approved, true);
});

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项${failures.length === 0 ? ' —— 跨端不会再回两遍' : ''}`);
if (failures.length > 0) {
  for (const line of failures) console.log(`  - ${line}`);
  process.exitCode = 1;
}
