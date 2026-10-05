/**
 * 「好内容随手三连 + 分类收藏 + 浏览记录」的单元测试（主人 2026-10-05 的要求）。
 *
 * 三件事都要有客观门槛，不然等于把她的三连/历史随手撒出去：
 *   1. `checkTriple` 的四道闸：分数门槛、同片只连一次、每日上限、标题黑名单，外加密钥模式；
 *   2. `pickFolderTitle` 的分类规则：方向映射 → 标题关键词 → 兜底夹；
 *   3. `tripleVideo` 真的去点（点赞/投币/收藏）、夹子不存在就顺手建、少一步不算全败；
 *   4. `reportHistory` 没 cid 不硬报（B 站要 cid），关掉开关就完全不报。
 *
 * 用法：node test/triple.test.mjs
 */
import { strict as assert } from 'node:assert';
import { BiliClient } from '../lib/api.js';
import { checkTriple, pickFolderTitle, DEFAULT_FAVORITE_FOLDER } from '../lib/policy.js';
import { tripleVideo, reportHistory, tripleConfig } from '../lib/triple.js';
import { emptyLedger, recordFavorite, tripledAlready, tripleCountToday } from '../lib/ledger.js';

const VIDEO = { aid: 936177870, bvid: 'BV16T4y1k7dB', title: '如何炼成超强学习能力？', author: '硬核学长', cid: 123456, durationSec: 600 };

/** 一个假客户端：记下每次调用，按需返回收藏夹列表。 */
function fakeClient({ folders = [], fail = {} } = {}) {
  const calls = [];
  const client = Object.create(BiliClient.prototype);
  client.favFolders = async () => {
    calls.push({ path: 'favFolders' });
    return folders;
  };
  client.favFolderCreate = async (title) => {
    calls.push({ path: 'favFolderCreate', title });
    return { id: 42, title };
  };
  client.favDeal = async (options) => {
    calls.push({ path: 'favDeal', options });
    if (fail.favDeal) throw new Error(fail.favDeal);
    return {};
  };
  client.videoLike = async (options) => {
    calls.push({ path: 'videoLike', options });
    if (fail.videoLike) throw new Error(fail.videoLike);
    return {};
  };
  client.videoCoin = async (options) => {
    calls.push({ path: 'videoCoin', options });
    if (fail.videoCoin) throw new Error(fail.videoCoin);
    return {};
  };
  client.historyReport = async (options) => {
    calls.push({ path: 'historyReport', options });
    if (fail.historyReport) throw new Error(fail.historyReport);
    return {};
  };
  return { client, calls };
}

// ① 配置与门槛。
{
  const cfg = {};
  const conf = tripleConfig(cfg);
  assert.equal(conf.mode, 'confirm', '默认是 confirm（主人的账号，先让人看一眼）');
  assert.equal(conf.minScore, 6);
  assert.equal(conf.coin, 1);
  assert.equal(conf.reportHistory, true, '刷过的视频默认要报浏览记录');
  assert.equal(conf.folderDefault, DEFAULT_FAVORITE_FOLDER);

  const low = checkTriple({ cfg, ledger: emptyLedger(), video: VIDEO, score: 3 });
  assert.equal(low.allowed, false);
  assert.ok(low.reasons.some((reason) => reason.includes('不到 6')), `分数不够要拦（实际：${low.reasons.join('；')}）`);

  const ok = checkTriple({ cfg, ledger: emptyLedger(), video: VIDEO, score: 7, confirm: true });
  assert.equal(ok.allowed, true, `分数够 + 主人点头就该放行（实际：${ok.reasons.join('；')}）`);
  assert.equal(ok.actions.like, true);
  assert.equal(ok.actions.coin, 1);
  assert.equal(ok.actions.favorite, true);

  const needConfirm = checkTriple({ cfg, ledger: emptyLedger(), video: VIDEO, score: 7 });
  assert.equal(needConfirm.needsConfirm, true, 'confirm 模式下没点头要先问');
  assert.equal(needConfirm.allowed, false);

  const auto = checkTriple({ cfg: { policy: { postTriple: 'auto', tripleCoin: 2 } }, ledger: emptyLedger(), video: VIDEO, score: 9 });
  assert.equal(auto.allowed, true, 'auto 模式直接连');
  assert.equal(auto.actions.coin, 2, 'tripleCoin 要生效');

  const off = checkTriple({ cfg: { policy: { postTriple: 'off' } }, ledger: emptyLedger(), video: VIDEO, score: 9 });
  assert.equal(off.allowed, false, 'off 模式禁止三连');

  const banned = checkTriple({ cfg, ledger: emptyLedger(), video: { ...VIDEO, title: '女大学生的"隐秘的圈子"一月疯狂约600人' }, score: 9, confirm: true });
  assert.equal(banned.allowed, false, '擦边标题不给三连');
}

// ② 同片只连一次 + 每日上限。
{
  const ledger = emptyLedger();
  recordFavorite(ledger, { aid: VIDEO.aid, bvid: VIDEO.bvid, title: VIDEO.title, triple: true, like: true, coin: 1 });
  assert.equal(tripledAlready(ledger, VIDEO.aid), true);
  assert.equal(tripleCountToday(ledger), 1);
  const again = checkTriple({ cfg: { policy: { postTriple: 'auto' } }, ledger, video: VIDEO, score: 9 });
  assert.equal(again.allowed, false, '同一个视频不能连两次');
  const capped = checkTriple({ cfg: { policy: { postTriple: 'auto', dailyTriples: 1 } }, ledger, video: { ...VIDEO, aid: 2, bvid: 'BV2' }, score: 9 });
  assert.equal(capped.allowed, false, '今天的额度用完了就不连');
  assert.ok(capped.reasons.some((reason) => reason.includes('上限')), '要说明是撞了每日上限');
}

// ③ 分类：方向映射 → 标题关键词 → 兜底。
{
  const cfg = { feed: { folderByTopic: { 'AI 智能体': 'AI 学习', DeepSeek: 'AI 学习' }, favoriteFolder: '小鲸鱼娘的学习收藏' } };
  assert.equal(pickFolderTitle(cfg, { topic: 'AI 智能体', title: '随便' }), 'AI 学习', '按方向精确映射');
  assert.equal(pickFolderTitle(cfg, { topic: '别的', title: '聊聊 DeepSeek 的推理' }), 'AI 学习', '标题里出现键也算');
  assert.equal(pickFolderTitle(cfg, { topic: '别的', title: '随便' }), '小鲸鱼娘的学习收藏', '都不命中就进兜底夹');
  assert.equal(pickFolderTitle({}, { topic: 'x' }), DEFAULT_FAVORITE_FOLDER, '没配就用内置兜底名');
}

// ④ 真去点：夹子不存在要建，收藏进对的夹子，账本记下 triple 标记。
{
  const ledger = emptyLedger();
  const { client, calls } = fakeClient({ folders: [{ id: 7, title: '别的夹子' }] });
  const result = await tripleVideo({
    client,
    cfg: { policy: { postTriple: 'auto', tripleCoin: 1 }, feed: { folderByTopic: { 'AI 智能体': 'AI 学习' } } },
    ledger,
    video: VIDEO,
    topic: 'AI 智能体',
    score: 8,
  });
  assert.equal(result.done, true, `三连该成功（errors：${result.errors.join('；')}）`);
  assert.equal(result.like, true);
  assert.equal(result.coin, 1);
  assert.equal(result.folder.title, 'AI 学习');
  assert.equal(result.folder.created, true, '夹子不存在时要新建');
  assert.deepEqual(calls.map((item) => item.path), ['videoLike', 'videoCoin', 'favFolders', 'favFolderCreate', 'favDeal']);
  assert.deepEqual(calls[4].options, { aid: VIDEO.aid, addIds: [42] }, '要收进新建的夹子');
  assert.equal(tripledAlready(ledger, VIDEO.aid), true, '账本要记一条带 triple 标记的收藏');
  assert.equal(tripleCountToday(ledger), 1);

  const { client: reuse, calls: calls2 } = fakeClient({ folders: [{ id: 9, title: 'AI 学习' }] });
  const second = await tripleVideo({ client: reuse, cfg: { policy: { postTriple: 'auto' }, feed: { folderByTopic: { 'AI 智能体': 'AI 学习' } } }, ledger: emptyLedger(), video: VIDEO, topic: 'AI 智能体', score: 8 });
  assert.equal(second.folder.created, false);
  assert.equal(calls2.some((item) => item.path === 'favFolderCreate'), false, '夹子已存在就别建');
}

// ⑤ 少一步不算全败：投币说「超过投币上限」当成功，收藏失败也保留点赞记录。
{
  const ledger = emptyLedger();
  const { client } = fakeClient({ fail: { videoCoin: 'B站接口返回 34005：超过投币上限' } });
  const result = await tripleVideo({ client, cfg: { policy: { postTriple: 'auto' } }, ledger, video: VIDEO, score: 8 });
  assert.equal(result.like, true);
  assert.equal(result.errors.length, 0, `「已经投过币」不该记成错误（实际：${result.errors.join('；')}）`);
  assert.equal(result.done, true);

  const ledger2 = emptyLedger();
  const { client: broken } = fakeClient({ fail: { videoLike: 'B站接口返回 -412：请求被拦截', favDeal: 'B站接口返回 -400：参数错误' } });
  const partial = await tripleVideo({ client: broken, cfg: { policy: { postTriple: 'auto' } }, ledger: ledger2, video: VIDEO, score: 8 });
  assert.equal(partial.like, false);
  assert.equal(partial.done, true, '收藏没成但投币成了，也算连过（不重复撒币）');
  assert.ok(partial.errors.some((line) => line.includes('点赞失败')), '失败原因要带回来');
  assert.ok(partial.errors.some((line) => line.includes('收藏失败')), '收藏失败也要记');
  assert.equal(tripledAlready(ledger2, VIDEO.aid), true, '连过就要记账，避免下次重复投币');
}

// ⑥ 密钥模式：confirm 没点头时一步都不许动。
{
  const ledger = emptyLedger();
  const { client, calls } = fakeClient();
  const result = await tripleVideo({ client, cfg: {}, ledger, video: VIDEO, score: 8 });
  assert.equal(result.done, false);
  assert.equal(result.needsConfirm, true);
  assert.equal(calls.length, 0, '没点头不许发任何写请求');
  assert.equal(tripledAlready(ledger, VIDEO.aid), false);
}

// ⑦ 浏览记录：要 cid；开关关掉就不报；进度默认按「看完了」算。
{
  const video = { ...VIDEO };
  const { client, calls } = fakeClient();
  const reported = await reportHistory({ client, cfg: {}, video });
  assert.equal(reported.reported, true);
  assert.equal(calls[0].path, 'historyReport');
  assert.equal(calls[0].options.cid, video.cid, 'cid 必须带上');
  assert.ok(calls[0].options.progress >= 500, `没给进度就按看完了算（实际：${calls[0].options.progress}）`);

  const missing = await reportHistory({ client, cfg: {}, video: { ...video, cid: 0 } });
  assert.equal(missing.reported, false);
  assert.ok(missing.reason.includes('cid'), '没有 cid 要说明原因');

  const off = await reportHistory({ client, cfg: { policy: { reportHistory: false } }, video });
  assert.equal(off.reported, false);
  assert.ok(off.reason.includes('reportHistory'), '关掉开关后完全不报');

  const bad = await reportHistory({ client: fakeClient({ fail: { historyReport: 'B站接口返回 -400：请求错误' } }).client, cfg: {}, video });
  assert.equal(bad.reported, false);
  assert.ok(bad.reason.includes('-400'), '报失败也要把原因带回来，不能吞掉');
}

console.log('✓ 三连测试通过：分数/每日上限/去重门槛、收藏夹分类、逐步容错、浏览记录契约');
