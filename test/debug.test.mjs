/**
 * 第九轮：主人的「最高权限」私信运维台（`lib/debug.js`）与 `force` 闸门。
 *
 * 主人原话（2026-10-05）：「给另一个主人调试最高权限」，勾的是：
 *   1. 私信里的运维命令：状态 / 日志 / 配置 / 额度 / 最近动作
 *   2. 免限额免间隔：他说的动作立刻办、不限次数、跳过去重
 *   3. 能远程让她重启看门鲸 / 改她的配置
 *
 * 用临时 DSH_HOME，绝不碰真状态目录、绝不发真私信、绝不真重启看门鲸。
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'whale-debug-'));
process.env.DSH_HOME = HOME;
mkdirSync(join(HOME, 'bilibili-whale', 'logs'), { recursive: true });

const { parseDebugCommand, runDebugCommand, debugHelp, DEBUG_LOGS } = await import('../lib/debug.js');
const { statePath, writeJsonFile, readUserConfig, resolveConfig } = await import('../lib/config.js');
const { emptyLedger, recordWatched, recordFavorite, recordDm, recordDmIncoming, todayBucket } = await import('../lib/ledger.js');
const { isDebugOwner, checkDmReply, checkVideoComment, checkTriple } = await import('../lib/policy.js');

// 默认配置 + 两位主人（临时 DSH_HOME 里没有真 config.json，主人 UID/昵称得自己摆好）。
const CFG = {
  ...resolveConfig({}),
  ownerMid: 3494364865103885,
  ownerMids: [3494364865103885, 391581639],
  ownerName: '懒寻真',
  ownerNames: ['懒寻真', '金易木木元'],
};
const OWNER_A = { mid: CFG.ownerMids[0], uname: CFG.ownerNames[0] };
const OWNER_B = { mid: CFG.ownerMids[1], uname: CFG.ownerNames[1] };

// ── 1. 认命令（纯解析，不碰网络不写盘）────────────────────────────────────
{
  assert.equal(parseDebugCommand(''), null);
  assert.equal(parseDebugCommand('今天天气真好呀'), null, '纯聊天绝不进调试台');
  assert.deepEqual(parseDebugCommand('状态'), { name: 'status', arg: '' });
  assert.deepEqual(parseDebugCommand('帮我看看状态'), { name: 'status', arg: '' }, '客套话要剥掉');
  assert.deepEqual(parseDebugCommand('/日志'), { name: 'logs', arg: 'actions' }, '斜杠写法也认');
  assert.deepEqual(parseDebugCommand('看一下 日志 brain'), { name: 'logs', arg: 'brain' });
  assert.deepEqual(parseDebugCommand('配置 policy.tripleMinScore'), { name: 'config', arg: 'policy.tripleMinScore' });
  assert.deepEqual(parseDebugCommand('额度'), { name: 'quota', arg: '' });
  assert.deepEqual(parseDebugCommand('最近'), { name: 'recent', arg: '' });
  assert.deepEqual(parseDebugCommand('重启'), { name: 'restart', arg: '' });
  assert.deepEqual(parseDebugCommand('改配置 policy.tripleMinScore 8'), { name: 'setconfig', arg: 'policy.tripleMinScore 8' });
  assert.deepEqual(parseDebugCommand('把 policy.minIntervalSeconds 改成 0'), { name: 'setconfig', arg: 'policy.minIntervalSeconds 0' }, '口语句式也要认');
  assert.ok(debugHelp().includes('重启') && debugHelp().includes('额度'), '认不出时要能念出说明书');
  assert.ok(DEBUG_LOGS.includes('actions') && DEBUG_LOGS.includes('brain'));
}

// ── 2. 真办命令（临时状态目录）────────────────────────────────────────────
const ledger = emptyLedger();
recordWatched(ledger, { bvid: 'BV1atCRYsE7x', source: 'study', topic: 'DeepSeek' });
recordWatched(ledger, { bvid: 'BV1X38BzWEBn', source: 'master', topic: '拉康' });
todayBucket(ledger).videoComments = 2;
writeFileSync(statePath('logs/actions.log'), ['a1 动作一', 'a2 动作二', 'a3 动作三'].join('\n') + '\n', 'utf8');
writeJsonFile(statePath('watchdog.json'), { pid: 4242, ts: Date.now(), everyMinutes: 0.33 });

const client = { nav: async () => ({ isLogin: true, uname: '寻和橼的大肥鱼dsh', mid: 3747560556595480, level: 2, coins: 0 }) };
const say = async (text, cfg = CFG) => runDebugCommand({ cfg, command: parseDebugCommand(text), ledger, client, mid: OWNER_B.mid, uname: OWNER_B.uname });

{
  const st = await say('状态');
  assert.equal(st.ok, true, `状态要看得到（实际：${st.text}）`);
  assert.ok(st.text.includes('已登录'), '要说登录态');
  assert.ok(st.text.includes('pid 4242'), '要说看门鲸 pid');
  assert.ok(st.text.includes('自己刷的视频'), '要给额度视图');
  assert.ok(st.text.includes('Lv2') && st.text.includes('硬币 0'), '等级和硬币都要报（硬币 0 是三连投不出去的真因）');
}

{
  const lg = await say('日志');
  assert.equal(lg.ok, true);
  assert.ok(lg.text.includes('a3 动作三'), `要看到日志尾巴（实际：${lg.text}）`);
  const bad = await say('日志 cookies');
  assert.equal(bad.ok, false, '白名单外的日志不给看');
  assert.ok(bad.text.includes('只能看'), '要说清能看哪几个');
  const brain = await say('日志 brain');
  assert.equal(brain.ok, true, 'brain 在白名单里');
}

{
  const all = await say('配置');
  assert.equal(all.ok, true);
  // 全貌几千字，一条私信装不下 → 按设计落到 debug-out.txt，回执只指路
  assert.ok(all.text.includes('debug-out.txt'), `全貌要指路到文件（实际：${all.text}）`);
  assert.ok(readFileSync(statePath('debug-out.txt'), 'utf8').includes('tripleMinScore'), '全貌要真写进文件');
  const one = await say('配置 policy.tripleMinScore');
  assert.equal(one.ok, true);
  assert.ok(one.text.includes('6'), `要看得到真值（实际：${one.text}）`);
  const secretCfg = { ...CFG, policy: { ...CFG.policy, apiKey: 'sk-should-not-leak' } };
  const secret = await say('配置 policy.apiKey', secretCfg);
  assert.equal(secret.ok, false, '秘密项要拒绝');
  assert.ok(secret.text.includes('秘密'));
  const wide = await say('配置', secretCfg);
  assert.equal(wide.text.includes('sk-should-not-leak'), false, '回执里不许漏');
  assert.equal(readFileSync(statePath('debug-out.txt'), 'utf8').includes('sk-should-not-leak'), false, '落盘的全貌也要把秘密涂掉');
  const missing = await say('配置 policy.notAThing');
  assert.equal(missing.ok, false);
  assert.ok(missing.text.includes('没有'));
}

{
  const out = await say('改配置 policy.tripleMinScore 8');
  assert.equal(out.ok, true, `改配置要成（实际：${out.text}）`);
  assert.equal(readUserConfig().policy.tripleMinScore, 8, '要写进 config.json 的覆盖层');
  assert.ok(out.text.includes('8'));
  const off = await say('把 policy.postVideoComment 改成关');
  assert.equal(off.ok, true);
  assert.equal(readUserConfig().policy.postVideoComment, false, '「关」要变成布尔 false');
  const unlimited = await say('改配置 policy.dailyVideoComments 不限');
  assert.equal(unlimited.ok, true);
  assert.equal(readUserConfig().policy.dailyVideoComments, 0, '「不限」要变成 0（本仓约定 0 = 不限）');

  // 三种拒绝：秘密字段、危险路径、不存在的项
  assert.equal((await say('改配置 policy.apiKey abc')).ok, false, '秘密字段不给改');
  assert.equal((await say('改配置 __proto__.polluted 1')).ok, false, '危险路径不给改');
  assert.equal({}.polluted, undefined, '别真的污染原型');
  assert.equal((await say('改配置 policy.notAThing 1')).ok, false, '不存在的项不给改');
  assert.equal(readUserConfig().policy.notAThing, undefined);
}

{
  const quota = await say('额度');
  assert.equal(quota.ok, true);
  assert.ok(quota.text.includes('自己刷的视频'), `额度要单列自己刷的（实际：${quota.text}）`);
  assert.ok(quota.text.includes('主人点名的不计入'), '要说清主人点名的不占额度');
  const recent = await say('最近');
  assert.equal(recent.ok, true);
  assert.ok(recent.text.includes('今天刷了 2 条'), `要说清今天刷了几条（实际：${recent.text}）`);
  assert.ok(recent.text.includes('自己挑的 1 条'), '要分开数自己挑的');
  assert.ok(recent.text.includes('最近的动作'), '要带最近动作记录');
}

{
  // 超长回执：全文落盘，回执本身必须压到私信上限内（否则会被 checkDmReply 整条拦掉）
  const many = Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 行的动作记录${'（很长的尾巴）'.repeat(3)}`).join('\n') + '\n';
  writeFileSync(statePath('logs/actions.log'), many, 'utf8');
  const big = await say('日志');
  assert.ok(big.text.includes('debug-out.txt'), `超长要指路到文件（实际：${big.text}）`);
  assert.ok(readFileSync(statePath('debug-out.txt'), 'utf8').includes('第 60 行'), '全文要真写进文件');
  assert.ok(big.text.length <= CFG.policy.maxCommentChars, `回执要压到上限内（实际 ${big.text.length} 字）`);
  const tightCfg = { ...CFG, policy: { ...CFG.policy, maxCommentChars: 60 } };
  const tight = await say('日志', tightCfg);
  assert.ok(tight.text.length <= 60, `上限很小时也要装得下（实际 ${tight.text.length} 字）`);
  assert.ok(tight.text.includes('debug-out.txt'));
  writeFileSync(statePath('logs/actions.log'), 'a1 动作一\n', 'utf8');
}

{
  const dog = await say('重启');
  assert.equal(dog.ok, true, `有心跳就该受理（实际：${dog.text}）`);
  assert.ok(dog.text.includes('pid 4242'));
  assert.equal(existsSync(statePath('restart.request')), true, '要真写下重启请求（看门鲸每轮读它）');
  rmSync(statePath('watchdog.json'), { force: true });
  const lonely = await say('重启');
  assert.equal(lonely.ok, false, '没心跳要老实说：它本来就没在跑');
  assert.ok(lonely.text.includes('手动'), `要告诉主人本机手动起（实际：${lonely.text}）`);
  writeJsonFile(statePath('watchdog.json'), { pid: 4242, ts: Date.now(), everyMinutes: 0.33 });
}

// ── 3. 谁能用最高权限 + force 免限额但**不免护栏**─────────────────────────
{
  assert.equal(isDebugOwner(CFG, OWNER_A), true, '默认两位主人都有调试台');
  assert.equal(isDebugOwner(CFG, OWNER_B), true);
  assert.equal(isDebugOwner(CFG, { mid: 999999, uname: '路人甲' }), false, '不是主人就没有');
  const onlyB = { ...CFG, policy: { ...CFG.policy, debugMids: [String(OWNER_B.mid)] } };
  assert.equal(isDebugOwner(onlyB, OWNER_B), true);
  assert.equal(isDebugOwner(onlyB, OWNER_A), false, '不在 debugMids 名单里的人没有');
  const off = { ...CFG, policy: { ...CFG.policy, ownerDebug: false } };
  assert.equal(isDebugOwner(off, OWNER_B), false, 'ownerDebug = false 全关掉');
}

{
  const book = emptyLedger();
  todayBucket(book).videoComments = 3;
  const vcfg = { ...CFG, policy: { ...CFG.policy, dailyVideoComments: 3, blockKeywords: ['鬼畜'], postVideoComment: 'auto', dedupePerVideo: true } };
  const video = { bvid: 'BV1X38BzWEBn', aid: 1, title: '拉康导读' };
  const blocked = checkVideoComment({ cfg: vcfg, ledger: book, video, message: '好看' });
  assert.equal(blocked.allowed, false, '到每日上限就拦');
  assert.ok(blocked.reasons.some((r) => r.includes('上限')), `原因要说明是上限（实际：${blocked.reasons.join('；')}）`);
  assert.equal(checkVideoComment({ cfg: vcfg, ledger: book, video, message: '好看', force: true }).allowed, true, '最高权限免上限');
  const dirty = checkVideoComment({ cfg: vcfg, ledger: book, video, message: '这条鬼畜真好', force: true });
  assert.equal(dirty.allowed, false, '屏蔽词不因最高权限放行');
  assert.ok(dirty.reasons.some((r) => r.includes('屏蔽词')));
  const offMode = { ...vcfg, policy: { ...vcfg.policy, postVideoComment: 'off' } };
  assert.equal(checkVideoComment({ cfg: offMode, ledger: book, video, message: '好看', force: true }).allowed, false, '配置关掉的照拦');

  // 私信：主人自己的间隔免掉，别人的每日上限也免掉（别人那档仍要「先找过她」）
  const book2 = emptyLedger();
  recordDmIncoming(book2, { mid: OWNER_B.mid, uname: OWNER_B.uname, text: '在吗', ts: Date.now() });
  book2.lastActionOwnerTs = Date.now();
  const dcfg = { ...CFG, policy: { ...CFG.policy, minIntervalSecondsOwner: 3600 } };
  const wait = checkDmReply({ cfg: dcfg, ledger: book2, mid: OWNER_B.mid, uname: OWNER_B.uname, text: '在的主人～' });
  assert.equal(wait.allowed, false, '刚回过就要等间隔');
  assert.ok(wait.reasons.some((r) => r.includes('离上次动作')), `原因要说明是间隔（实际：${wait.reasons.join('；')}）`);
  assert.equal(checkDmReply({ cfg: dcfg, ledger: book2, mid: OWNER_B.mid, uname: OWNER_B.uname, text: '在的主人～', force: true }).allowed, true, '最高权限立刻回，不等间隔');

  const book2b = emptyLedger();
  const stranger = { mid: 999999, uname: '路人甲' };
  recordDmIncoming(book2b, { mid: stranger.mid, uname: stranger.uname, text: '你好', ts: Date.now() });
  recordDm(book2b, { mid: stranger.mid, uname: stranger.uname, text: '嗨～' });
  const scfg = { ...CFG, policy: { ...CFG.policy, replyDmOthers: 'auto', maxDmReplyPerUserPerDay: 1, minIntervalSeconds: 0 } };
  const capped2 = checkDmReply({ cfg: scfg, ledger: book2b, mid: stranger.mid, uname: stranger.uname, text: '人家在呢' });
  assert.equal(capped2.allowed, false, '别人的每日上限照常算');
  assert.ok(capped2.reasons.some((r) => r.includes('上限')), `原因要说明是上限（实际：${capped2.reasons.join('；')}）`);
  assert.equal(checkDmReply({ cfg: scfg, ledger: book2b, mid: stranger.mid, uname: stranger.uname, text: '人家在呢', force: true }).allowed, true, '最高权限免别人的每日上限');

  const book3 = emptyLedger();
  recordFavorite(book3, { aid: 1, bvid: 'BV1X38BzWEBn', triple: true });
  const tcfg = { ...CFG, policy: { ...CFG.policy, postTriple: 'auto', tripleMinScore: 6, dailyTriples: 0 } };
  const again = checkTriple({ cfg: tcfg, ledger: book3, video: { aid: 1, title: '拉康导读' }, score: 9 });
  assert.equal(again.allowed, false, '三连过的默认不重复');
  assert.ok(again.reasons.some((r) => r.includes('已经三连过')));
  assert.equal(checkTriple({ cfg: tcfg, ledger: book3, video: { aid: 1, title: '拉康导读' }, score: 9, force: true }).allowed, true, '最高权限跳过去重');
}

console.log('✓ 调试台测试通过：状态/日志/配置/额度/最近/重启都真办、秘密与危险路径拒绝、超长回执落盘且压在上限内、最高权限只给主人名单里的人、force 免限额免间隔免去重但屏蔽词照拦');
