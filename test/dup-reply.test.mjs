/**
 * 「评论又重复回复了」的回归测试（2026-10-05 主人报的事故）。
 *
 * 真机到底怎么刷屏的：
 *   - 本机有**两个写手**：DSH 宿主的回复定时器（`replyCheckMinutes`，2 分钟一轮）
 *     与看门鲸 `tools/dm-watch.mjs --reply-every`（约 2 分钟一轮）；
 *   - 两边各自 `loadLedger()` 拿一份快照 → 各回一条 → 各 `saveLedger()` 一次，
 *     **后写的把先写的记录盖掉**（丢更新）；
 *   - 记录一丢，`repliedToComment` 就失忆，下一轮又追着同一条评论回一条
 *     （真机账本里 6 条 reply 指向同一个 rpid 316071900673）。
 *
 * 这里钉住三件事：
 *   1. `withLock` 同一时刻只放一个进程进去，跑完把锁文件清干净；
 *   2. `saveLedgerMerged` 不再丢更新（并集落盘），`saveLedger` 的老行为留作对照；
 *   3. 回复链路：发之前重新读磁盘账本，别人刚回过的那条必须跳过；
 *      抢不到锁的那一轮干脆不动手（`locked: false`）。
 *
 * 用法：node test/dup-reply.test.mjs
 */
import { strict as assert } from 'node:assert';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// 临时 DSH_HOME：绝不碰真账本、绝不发真评论。
const HOME = join(tmpdir(), `dsh-dup-reply-${Date.now()}`);
process.env.DSH_HOME = HOME;
mkdirSync(join(HOME, 'bilibili-whale', 'logs'), { recursive: true });

const { statePath } = await import('../lib/config.js');
const { loadLedger, recordReply, recordWatched, saveLedger, saveLedgerMerged } = await import('../lib/ledger.js');
const { withLock, lockHolder } = await import('../lib/lock.js');
const { runInboxReplies } = await import('../lib/reply.js');
const { forgetReplied, hasReplied, markReplied, repliedRpidSet } = await import('../lib/replied.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}

const CFG = {
  ownerName: '懒寻真',
  ownerMid: 3494364865103885,
  ownerNames: ['懒寻真', '金易木木元'],
  ownerMids: [3494364865103885, 391581639],
  whaleMid: 3747560556595480,
  policy: {
    postReply: 'auto',
    replyScope: 'anyone',
    replyPerUserPerThread: 1,
    replyPerUserWindowHours: 24,
    dailyReplies: 10,
    minIntervalSeconds: 120,
    minIntervalSecondsOwner: 15,
    maxCommentChars: 200,
    blockKeywords: ['加群', '微信'],
  },
};

console.log('\n1. 跨进程锁：同一时刻只放一个进去，跑完清干净');
await checkAsync('第二个来抢的要被挡住，理由是「锁被别的进程拿着」', async () => {
  let inside = false;
  const first = withLock('t-lock', async () => {
    inside = true;
    await sleep(500);
    return 'first';
  });
  await sleep(80);
  assert.equal(inside, true, '第一个应该已经在里面了');
  const second = await withLock('t-lock', async () => 'second', { waitMs: 120 });
  assert.equal(second.acquired, false, '锁被占着时不该拿到');
  assert.match(second.reason, /锁被别的进程拿着/, '理由要说清是被谁占着');
  const done = await first;
  assert.equal(done.value, 'first');
  assert.equal(done.acquired, true);
});
await checkAsync('前一个跑完就放行，锁文件也删掉', async () => {
  assert.equal(existsSync(statePath('locks/t-lock.lock')), false, '跑完不该留锁文件');
  const again = await withLock('t-lock', async () => 'third', { waitMs: 200 });
  assert.equal(again.acquired, true, '锁空了就该拿到');
  assert.equal(again.value, 'third');
  assert.equal(lockHolder('t-lock'), '', '此时不该有人拿着');
});
await checkAsync('锁文件写进了 pid 与时间（排查用）', async () => {
  const running = withLock('t-lock2', async () => {
    await sleep(200);
  });
  await sleep(60);
  assert.match(lockHolder('t-lock2'), /pid=\d+ at=/, '锁文件里要有 pid 和时间');
  await running;
});

console.log('\n2. 账本丢更新：并集保存能救，覆盖保存救不了');
check('老写法（各存各的）真的会把别人的记录盖掉', () => {
  const a = loadLedger();
  const b = loadLedger();
  recordReply(a, { rpid: 111, root: 111, text: 'A 回的' });
  saveLedger(a);
  recordReply(b, { rpid: 222, root: 222, text: 'B 回的' });
  saveLedger(b);
  const disk = loadLedger();
  const rpids = disk.replies.map((row) => Number(row.rpid));
  assert.deepEqual(rpids, [222], `老写法只该剩最后写的那条（实际 ${JSON.stringify(rpids)}）—— 这就是事故本身`);
});
check('saveLedgerMerged 把两条都留住（并集落盘）', () => {
  const c = loadLedger();
  const d = loadLedger();
  recordReply(c, { rpid: 333, root: 333, text: 'C 回的' });
  saveLedger(c);
  recordReply(d, { rpid: 444, root: 444, text: 'D 回的' });
  saveLedgerMerged(d);
  const rpids = loadLedger().replies.map((row) => Number(row.rpid)).sort((x, y) => x - y);
  assert.deepEqual(rpids, [222, 333, 444], `两条都不能丢（实际 ${JSON.stringify(rpids)}）`);
});
check('合并保存也不会把「她刷到过什么」并丢', () => {
  const before = loadLedger();
  recordWatched(before, { bvid: 'BV-old', title: '早就记下的' });
  saveLedger(before);
  const stale = loadLedger(); // 另一个进程在这之后才拿到的快照，里面没有新记的那条
  recordWatched(stale, { bvid: 'BV-new', title: '刚记下的' });
  saveLedgerMerged(stale);
  const keys = loadLedger().watched.map((row) => row.bvid);
  assert.ok(keys.includes('BV-old') && keys.includes('BV-new'), `两条痕迹都要在（实际 ${JSON.stringify(keys)}）`);
});

console.log('\n3. 回复链路：发之前再看一眼磁盘，别人刚回过的不许再回');
function fakeRun(calls) {
  return async (tool, args) => {
    calls.push({ tool, args });
    if (tool === 'bili_video') return { aid: 116617757459999, bvid: 'BV1dupreply', title: '重复回复现场', upName: '测试' };
    if (tool === 'bili_inbox') return { replies: [] };
    if (tool === 'bili_reply') return { allowed: true, selfRpid: 999 };
    throw new Error(`没料到会调 ${tool}`);
  };
}
const TARGET = {
  mid: 2002,
  uname: '路人甲',
  message: '人家说得对吗',
  rpid: 316093531889,
  replyRoot: 316093334209,
  oid: 116617757459999,
  bvid: 'BV1dupreply',
  business: '评论',
  ts: Date.now(),
};
const inbox = { selfMid: CFG.whaleMid, targets: [TARGET] };

// 磁盘上先记下「这条评论已经回过了」（模拟另一个进程刚回完）
const seeded = loadLedger();
recordReply(seeded, { bvid: 'BV1dupreply', rpid: TARGET.rpid, root: TARGET.replyRoot, text: '别人先回的那条' });
saveLedger(seeded);

await checkAsync('别人刚回过、内存快照也失忆：重读磁盘后跳过，一条都不发', async () => {
  const calls = [];
  const blind = loadLedger();
  blind.replies = blind.replies.filter((row) => Number(row.rpid) !== TARGET.rpid); // 假装这份快照失忆了（真机就是这么丢的）
  const result = await runInboxReplies({
    cfg: CFG,
    ledger: blind,
    run: fakeRun(calls),
    inbox,
    compose: async () => '人家来晚了',
  });
  assert.equal(result.replied, 0, '重读磁盘之后必须拦住');
  assert.equal(calls.filter((c) => c.tool === 'bili_reply').length, 0, '一个 bili_reply 都不许打');
  assert.ok(
    result.skipped.some((row) => /刚被别的进程回过了/.test(String(row.reason))),
    `跳过理由要写清是「刚被别的进程回过」（实际 ${JSON.stringify(result.skipped)}）`,
  );
});
await checkAsync('内存快照里就有这条：普通去重也拦得住', async () => {
  const calls = [];
  const result = await runInboxReplies({
    cfg: CFG,
    ledger: loadLedger(),
    run: fakeRun(calls),
    inbox,
    compose: async () => '人家来晚了',
  });
  assert.equal(result.replied, 0, '不该回');
  assert.equal(calls.filter((c) => c.tool === 'bili_reply').length, 0, '一个 bili_reply 都不许打');
  assert.ok(result.skipped.some((row) => /已经回过了/.test(String(row.reason))), `跳过理由要在（实际 ${JSON.stringify(result.skipped)}）`);
});
await checkAsync('磁盘上确实没回过的那条：正常回，回完落账', async () => {
  const freshTarget = { ...TARGET, rpid: 316099999999, replyRoot: 316099999999 };
  const calls = [];
  const result = await runInboxReplies({
    cfg: CFG,
    ledger: loadLedger(),
    run: fakeRun(calls),
    inbox: { selfMid: CFG.whaleMid, targets: [freshTarget] },
    compose: async () => '人家现在回',
  });
  assert.equal(result.replied, 1, `该回的要回（实际 ${JSON.stringify(result.failed)}）`);
  assert.equal(calls.filter((c) => c.tool === 'bili_reply').length, 1);
});

console.log('\n4. 抢不到锁的那一轮：空手而归，不动手');
await checkAsync('锁被占着时 runInboxReplies 直接跳过', async () => {
  const holder = withLock('reply-round', async () => {
    await sleep(400);
  });
  await sleep(60);
  const calls = [];
  const freshTarget = { ...TARGET, rpid: 316088888888, replyRoot: 316088888888 };
  const result = await runInboxReplies({
    cfg: CFG,
    ledger: loadLedger(),
    run: fakeRun(calls),
    inbox: { selfMid: CFG.whaleMid, targets: [freshTarget] },
    compose: async () => '不该被发出去',
    lockWaitMs: 150, // 只等 150 毫秒：等不到就走（生产默认是 3 秒）
  });
  await holder;
  assert.equal(result.locked, false, '要标明这轮没拿到锁');
  assert.equal(result.replied, 0, '拿不到锁就别动手');
  assert.equal(calls.length, 0, '拿不到锁时连视频详情都不该去取');
  assert.match(String(result.skipped[0]?.reason ?? ''), /reply-round 的锁被别的进程拿着/);
});

console.log('\n5. 追加日志：账本被盖掉了，也还记得「这条回过了」');
const JOURNAL_RPID = 316077777777;
check('markReplied 之后认得出，账本里那行即使被抹掉也认得出', () => {
  markReplied(JOURNAL_RPID, { root: 123, bvid: 'BV1journal' });
  assert.equal(hasReplied(JOURNAL_RPID), true, '日志里记了就该认得');
  assert.equal(repliedRpidSet().has(JOURNAL_RPID), true, '集合里也要有');
  // 模拟另一个写手（老代码 / 云端）整份覆盖写，把账本里这行连带抹掉
  const clobbered = loadLedger();
  clobbered.replies = clobbered.replies.filter((row) => Number(row.rpid) !== JOURNAL_RPID);
  saveLedger(clobbered);
  assert.equal(
    loadLedger().replies.some((row) => Number(row.rpid) === JOURNAL_RPID),
    false,
    '前提：账本里已经找不到这条了',
  );
  assert.equal(hasReplied(JOURNAL_RPID), true, '账本没了，日志还在');
});
await checkAsync('账本失忆 + 日志有记录 ⇒ 一条都不发', async () => {
  const calls = [];
  const result = await runInboxReplies({
    cfg: CFG,
    ledger: loadLedger(),
    run: fakeRun(calls),
    inbox: { selfMid: CFG.whaleMid, targets: [{ ...TARGET, rpid: JOURNAL_RPID, replyRoot: 123 }] },
    compose: async () => '不该再回一遍',
  });
  assert.equal(result.replied, 0, '不该回');
  assert.equal(calls.length, 0, '日志拦住的连视频详情都不该去取');
  assert.match(String(result.skipped[0]?.reason ?? ''), /追加日志/, '理由要写清是追加日志拦的');
});
check('forgetReplied 之后可以重发（主人说「这条再回一次」）', () => {
  assert.ok(forgetReplied({ bvid: 'BV1journal' }) >= 1, '要真抹掉至少一行');
  assert.equal(hasReplied(JOURNAL_RPID), false, '抹掉之后就不该再拦');
});

rmSync(HOME, { recursive: true, force: true });

if (failed > 0) {
  console.log(`\n✗ ${failed} 项没过`);
  process.exit(1);
}
console.log('\n✓ 全部通过');
