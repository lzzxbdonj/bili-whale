/**
 * 「主人随心所欲」（`policy.ownerUnlimited`）测试。
 *
 * 主人 2026-10-05：「给她账号的最大权限，让她接受我的指令之后可以随心所欲」。
 * 规矩定成两条线：
 *   1. **主人的指令**（调用方明确传下来的 `force`）免每日上限 / 免动作间隔 / 免去重；
 *   2. 账号安全线照旧 —— 屏蔽词、总开关 `postXxx = off`、`allowFollow = false`、
 *      `postReply = off` 一律拦；「被回的人是主人」**不**免那 15 秒风控间隔。
 *
 * 这里不碰真网络、不读磁盘配置：全部用 `DEFAULTS` 的副本 + 手搓账本。
 */
import { strict as assert } from 'node:assert';
import { DEFAULTS } from '../lib/config.js';
import {
  checkDynamic, checkFavorite, checkFollow, checkReply, checkTriple, checkVideoComment, ownerFree,
} from '../lib/policy.js';
import {
  emptyLedger, recordComment, recordDynamic, recordFavorite, recordReply,
} from '../lib/ledger.js';

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const OWNER = { mid: 1001, uname: '懒寻真' };
const STRANGER = { mid: 2002, uname: '路人甲' };

/** 拿一份独立可改的 cfg（默认值 + 把主人 UID 填成 1001）。 */
function cfgWith(policyPatch = {}) {
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  cfg.ownerMid = OWNER.mid;
  Object.assign(cfg.policy, policyPatch);
  return cfg;
}

/** 判定里有没有这条理由（子串匹配，避免被文案微调连坐）。 */
function has(verdict, needle) {
  return (verdict?.reasons ?? []).some((reason) => String(reason).includes(needle));
}

let failed = 0;
let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${error.message}`);
  }
}

console.log('1. ownerFree 真值表：谁的指令、配置怎么说');
check('默认（ownerUnlimited 未关）：主人 = 免限', () => {
  assert.equal(ownerFree(cfgWith(), { owner: true }), true);
});
check('默认：不是主人、也没有 force = 不免', () => {
  assert.equal(ownerFree(cfgWith(), {}), false);
  assert.equal(ownerFree(cfgWith(), { owner: false, force: false }), false);
});
check('配置里 ownerUnlimited = false：主人的指令也收紧', () => {
  assert.equal(ownerFree(cfgWith({ ownerUnlimited: false }), { owner: true }), false);
});
check('但明确带 force 的仍是主人的指令（force 压过 ownerUnlimited）', () => {
  assert.equal(ownerFree(cfgWith({ ownerUnlimited: false }), { owner: true, force: true }), true);
  assert.equal(ownerFree(cfgWith({ ownerUnlimited: false }), { force: true }), true);
});
check('cfg 缺失也不炸：force 就是主人的指令', () => {
  assert.equal(ownerFree(undefined, { force: true }), true);
});

console.log('2. 视频一级评论：去重 / 每日上限 / 间隔让路，屏蔽词照拦');
check('没 force：评过的视频 + 超上限 = 两条理由都拦', () => {
  const cfg = cfgWith({ postVideoComment: 'auto', dailyVideoComments: 1, dedupePerVideo: true });
  const ledger = emptyLedger();
  recordComment(ledger, { bvid: 'BV1ownerfree', aid: 111, rpid: 1, text: '先评一条', now: new Date(NOW) });
  const verdict = checkVideoComment({
    cfg, ledger, video: { bvid: 'BV1ownerfree', aid: 111, title: '随便一个标题' }, message: '再来一条', now: NOW,
  });
  assert.equal(verdict.allowed, false);
  assert.ok(has(verdict, '已经评论过'), `期望「已经评论过」，实际 ${JSON.stringify(verdict.reasons)}`);
  assert.ok(has(verdict, '已达上限'), `期望「已达上限」，实际 ${JSON.stringify(verdict.reasons)}`);
});
check('force = 主人点名：去重 / 上限 / 间隔全让路', () => {
  const cfg = cfgWith({ postVideoComment: 'auto', dailyVideoComments: 1, dedupePerVideo: true });
  const ledger = emptyLedger();
  recordComment(ledger, { bvid: 'BV1ownerfree', aid: 111, rpid: 1, text: '先评一条', now: new Date(NOW) });
  const verdict = checkVideoComment({
    cfg, ledger, video: { bvid: 'BV1ownerfree', aid: 111, title: '随便一个标题' }, message: '再来一条', now: NOW, force: true,
  });
  assert.equal(verdict.allowed, true, JSON.stringify(verdict.reasons));
});
check('force 也拦不住的：屏蔽词 / 总开关 off / 草稿档仍要点头', () => {
  const cfg = cfgWith({ postVideoComment: 'auto' });
  const blocked = checkVideoComment({
    cfg, ledger: emptyLedger(), video: { bvid: 'BV1x', aid: 1, title: 't' }, message: '加群一起玩', now: NOW, force: true,
  });
  assert.equal(blocked.allowed, false);
  assert.ok(has(blocked, '屏蔽词'));

  const off = checkVideoComment({
    cfg: cfgWith({ postVideoComment: 'off' }), ledger: emptyLedger(), video: { bvid: 'BV1x', aid: 1, title: 't' }, message: '正常内容', now: NOW, force: true,
  });
  assert.equal(off.allowed, false);
  assert.ok(has(off, 'postVideoComment = off'));

  const draft = checkVideoComment({
    cfg: cfgWith({ postVideoComment: 'confirm' }), ledger: emptyLedger(), video: { bvid: 'BV1x', aid: 1, title: 't' }, message: '正常内容', now: NOW, force: true,
  });
  assert.equal(draft.allowed, false);
  assert.equal(draft.needsConfirm, true);
});

console.log('3. 回复评论：陌生人每人每串 / 24 小时窗口让路；主人那条不因此免风控间隔');
check('没 force：陌生人被「每人每串」和「24 小时」一起拦', () => {
  const cfg = cfgWith({ postReply: 'auto', replyPerUserPerThread: 1, replyPerUserWindowHours: 24 });
  const ledger = emptyLedger();
  recordReply(ledger, {
    bvid: 'BV1r', rpid: 900, root: 900, targetMid: STRANGER.mid, targetUname: STRANGER.uname, text: '回过一条', now: new Date(NOW - 3600 * 1000),
  });
  const verdict = checkReply({
    cfg, ledger, target: { ...STRANGER, rpid: 901, root: 900 }, message: '再回一条', now: NOW,
  });
  assert.equal(verdict.free, false);
  assert.ok(has(verdict, '每人每串上限'), JSON.stringify(verdict.reasons));
  assert.ok(has(verdict, '小时前刚被回过'), JSON.stringify(verdict.reasons));
});
check('force = 主人的指令：两条限制都让路', () => {
  const cfg = cfgWith({ postReply: 'auto', replyPerUserPerThread: 1, replyPerUserWindowHours: 24 });
  const ledger = emptyLedger();
  recordReply(ledger, {
    bvid: 'BV1r', rpid: 900, root: 900, targetMid: STRANGER.mid, targetUname: STRANGER.uname, text: '回过一条', now: new Date(NOW - 3600 * 1000),
  });
  const verdict = checkReply({
    cfg, ledger, target: { ...STRANGER, rpid: 901, root: 900 }, message: '再回一条', now: NOW, force: true,
  });
  assert.equal(verdict.free, true);
  assert.equal(verdict.allowed, true, JSON.stringify(verdict.reasons));
});
check('回主人：提醒「跳过每人一条」，但那 15 秒间隔还在', () => {
  const cfg = cfgWith({ postReply: 'auto', minIntervalSecondsOwner: 900 });
  const ledger = emptyLedger();
  ledger.lastActionOwnerTs = NOW - 5000;
  const verdict = checkReply({ cfg, ledger, target: { ...OWNER, rpid: 5, root: 5 }, message: '主人好呀', now: NOW });
  assert.equal(verdict.free, false);
  assert.ok(verdict.warnings.includes('主人优先：跳过「每人一条」限制'), JSON.stringify(verdict.warnings));
  assert.ok(has(verdict, '策略要求至少'), JSON.stringify(verdict.reasons));
});
check('force 时回复间隔也免，提醒换成「不限条数、不限间隔」', () => {
  const cfg = cfgWith({ postReply: 'auto', minIntervalSecondsOwner: 900 });
  const ledger = emptyLedger();
  ledger.lastActionOwnerTs = NOW - 5000;
  const verdict = checkReply({ cfg, ledger, target: { ...OWNER, rpid: 5, root: 5 }, message: '主人好呀', now: NOW, force: true });
  assert.equal(verdict.allowed, true, JSON.stringify(verdict.reasons));
  assert.ok(verdict.warnings.includes('主人优先：不限条数、不限间隔（ownerUnlimited）'), JSON.stringify(verdict.warnings));
});

console.log('4. 收藏：收过 / 每日上限让路，标题黑名单照拦');
check('没 force：同一视频收过 + 超上限都拦', () => {
  const cfg = cfgWith({ postFavorite: 'auto', dailyFavorites: 1 });
  const ledger = emptyLedger();
  recordFavorite(ledger, { aid: 111, bvid: 'BV1f', title: '好片子', now: new Date(NOW) });
  const verdict = checkFavorite({ cfg, ledger, aid: 111, title: '好片子', now: NOW });
  assert.equal(verdict.allowed, false);
  assert.ok(has(verdict, '已经收藏过'), JSON.stringify(verdict.reasons));
  assert.ok(has(verdict, '已达上限'), JSON.stringify(verdict.reasons));
});
check('force：能再收（换收藏夹），但标题黑名单照拦', () => {
  const cfg = cfgWith({ postFavorite: 'auto', dailyFavorites: 1 });
  const ledger = emptyLedger();
  recordFavorite(ledger, { aid: 111, bvid: 'BV1f', title: '好片子', now: new Date(NOW) });
  const verdict = checkFavorite({ cfg, ledger, aid: 111, title: '好片子', now: NOW, force: true });
  assert.equal(verdict.free, true);
  assert.equal(verdict.allowed, true, JSON.stringify(verdict.reasons));

  const blocked = checkFavorite({ cfg, ledger, aid: 222, title: '加群送福利', now: NOW, force: true });
  assert.equal(blocked.allowed, false);
  assert.ok(has(blocked, '屏蔽词'));
});

console.log('5. 动态：今天发过 / 每日一条让路，屏蔽词与总开关照拦');
check('没 force：每日一条 + 「今天已经发过动态了」', () => {
  const cfg = cfgWith({ postDynamic: 'auto', dailyDynamics: 1 });
  const ledger = emptyLedger();
  recordDynamic(ledger, { text: '今天的动态', now: new Date(NOW) });
  const verdict = checkDynamic({ cfg, ledger, text: '再发一条', auto: true, now: NOW });
  assert.equal(verdict.allowed, false);
  assert.ok(has(verdict, '已达上限'), JSON.stringify(verdict.reasons));
  assert.ok(has(verdict, '今天已经发过动态了'), JSON.stringify(verdict.reasons));
});
check('force = 主人说「发个动态说…」：上限都让路', () => {
  const cfg = cfgWith({ postDynamic: 'auto', dailyDynamics: 1 });
  const ledger = emptyLedger();
  recordDynamic(ledger, { text: '今天的动态', now: new Date(NOW) });
  const verdict = checkDynamic({ cfg, ledger, text: '再发一条', auto: true, now: NOW, force: true });
  assert.equal(verdict.free, true);
  assert.equal(verdict.allowed, true, JSON.stringify(verdict.reasons));
});
check('force 也拦不住的：屏蔽词 / postDynamic = off / 2000 字上限', () => {
  const blocked = checkDynamic({ cfg: cfgWith({ postDynamic: 'auto' }), ledger: emptyLedger(), text: '加群聊聊', now: NOW, force: true });
  assert.equal(blocked.allowed, false);
  assert.ok(has(blocked, '屏蔽词'));

  const off = checkDynamic({ cfg: cfgWith({ postDynamic: 'off' }), ledger: emptyLedger(), text: '正常内容', now: NOW, force: true });
  assert.equal(off.allowed, false);
  assert.ok(has(off, 'postDynamic = off'));

  const long = checkDynamic({ cfg: cfgWith({ postDynamic: 'auto' }), ledger: emptyLedger(), text: '啊'.repeat(2001), now: NOW, force: true });
  assert.equal(long.allowed, false);
  assert.ok(has(long, '2000 字上限'));
});

console.log('6. 关注：allowFollowOthers 让路，allowFollow = false 这种总闸不让');
check('没 force：只关注主人', () => {
  const cfg = cfgWith({ allowFollow: true, allowFollowOthers: false });
  const verdict = checkFollow({ cfg, mid: STRANGER.mid, uname: STRANGER.uname, act: 1 });
  assert.equal(verdict.allowed, false);
  assert.ok(has(verdict, '只关注主人'), JSON.stringify(verdict.reasons));
});
check('force = 主人点名「关注这个 UP」：可以关注别人', () => {
  const cfg = cfgWith({ allowFollow: true, allowFollowOthers: false });
  const verdict = checkFollow({ cfg, mid: STRANGER.mid, uname: STRANGER.uname, act: 1, force: true });
  assert.equal(verdict.free, true);
  assert.equal(verdict.allowed, true, JSON.stringify(verdict.reasons));
});
check('allowFollow = false：主人点名也不让（账号安全线）', () => {
  const cfg = cfgWith({ allowFollow: false, allowFollowOthers: false });
  const verdict = checkFollow({ cfg, mid: STRANGER.mid, uname: STRANGER.uname, act: 1, force: true });
  assert.equal(verdict.allowed, false);
  assert.ok(has(verdict, 'allowFollow = false'));
});

console.log('7. 三连：三连过 / 每日上限让路，分数与标题黑名单照拦');
check('没 force：已经三连过 + 超上限', () => {
  const cfg = cfgWith({ postTriple: 'auto', dailyTriples: 1, tripleMinScore: 6 });
  const ledger = emptyLedger();
  recordFavorite(ledger, { aid: 222, bvid: 'BV1t', title: '好片子', triple: true, now: new Date(NOW) });
  const verdict = checkTriple({ cfg, ledger, video: { aid: 222, bvid: 'BV1t', title: '好片子' }, score: 8, now: NOW });
  assert.equal(verdict.allowed, false);
  assert.ok(has(verdict, '已经三连过'), JSON.stringify(verdict.reasons));
  assert.ok(has(verdict, '已达上限'), JSON.stringify(verdict.reasons));
});
check('force：主人点名刷的视频，三连过也能再连', () => {
  const cfg = cfgWith({ postTriple: 'auto', dailyTriples: 1, tripleMinScore: 6 });
  const ledger = emptyLedger();
  recordFavorite(ledger, { aid: 222, bvid: 'BV1t', title: '好片子', triple: true, now: new Date(NOW) });
  const verdict = checkTriple({ cfg, ledger, video: { aid: 222, bvid: 'BV1t', title: '好片子' }, score: 8, now: NOW, force: true });
  assert.equal(verdict.allowed, true, JSON.stringify(verdict.reasons));
});
check('force 也拦不住的：分数不够', () => {
  const cfg = cfgWith({ postTriple: 'auto', tripleMinScore: 6 });
  const verdict = checkTriple({ cfg, ledger: emptyLedger(), video: { aid: 333, bvid: 'BV1t2', title: '一般般' }, score: 3, now: NOW, force: true });
  assert.equal(verdict.allowed, false);
  assert.ok(has(verdict, '够不上「好内容」'), JSON.stringify(verdict.reasons));
});

if (failed > 0) {
  console.error(`\n失败 ${failed} 项，通过 ${passed} 项`);
  process.exit(1);
}
console.log(`\n✓ 主人随心所欲测试通过（${passed} 项）：ownerFree 真值表、force 免限额/免间隔/免去重、屏蔽词与总开关照拦`);
