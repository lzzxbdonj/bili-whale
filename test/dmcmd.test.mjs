/**
 * 私信「真命令」的单元测试（主人 2026-10-05：「我想让她给我转达消息一直做不到」）。
 *
 * 事故：主人在私信里让她提炼拉康视频、让她转达消息，她从 00:22 到 10:14 连着回了 8 次
 * 「马上就好」，一件事没办 —— 因为私信自动回复这条路**只会说话**，没有任何执行环节。
 * 这里钉住 `lib/dmcmd.js`：认命令 → 真执行 → 回执，而且不许把命令丢给模型。
 *
 * 用法：node test/dmcmd.test.mjs
 */
import { strict as assert } from 'node:assert';
import { dmCommandHelp, parseDmCommand, runDmCommand } from '../lib/dmcmd.js';
import { emptyLedger } from '../lib/ledger.js';

const OWNER_A = 3494364865103885; // 懒寻真
const OWNER_B = 391581639; // 金易木木元
const CFG = {
  ownerName: '懒寻真',
  ownerMid: OWNER_A,
  ownerNames: ['懒寻真', '金易木木元'],
  ownerMids: [OWNER_A, OWNER_B],
  policy: {
    allowDm: true,
    maxCommentChars: 200,
    maxDmPerUserPerDay: 3,
    minIntervalSeconds: 0,
    minIntervalSecondsOwner: 0,
    blockKeywords: [],
  },
};

/** 假 BiliClient：只记下调用。 */
function fakeClient({ searchResult = null, failSearch = '', failVideo = '', hotCount = 3 } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      search: async (keyword) => {
        calls.push({ path: 'search', keyword });
        if (failSearch !== '') throw new Error(failSearch);
        return searchResult ?? [];
      },
      sendMsg: async ({ receiverId, content }) => {
        calls.push({ path: 'sendMsg', receiverId, content });
        return { msgKey: 'MK-1' };
      },
      video: async (id) => {
        calls.push({ path: 'video', id });
        if (failVideo !== '') throw new Error(failVideo);
        return { bvid: String(id), aid: 460754856, cid: 345175659, title: '拉康最著名的理论：镜像阶段', author: '潜在狗子', view: 133000, duration: '7:13', durationSec: 433 };
      },
      comments: async (id) => {
        calls.push({ path: 'comments', id });
        return { replies: Array.from({ length: hotCount }, (_, i) => ({ rpid: i, message: 'x' })) };
      },
      historyReport: async (options) => {
        calls.push({ path: 'historyReport', ...options });
        return { aid: options.aid, cid: options.cid, progress: options.progress };
      },
      videoLike: async () => { calls.push({ path: 'videoLike' }); return {}; },
      videoCoin: async () => { calls.push({ path: 'videoCoin' }); return {}; },
      favFolders: async () => { calls.push({ path: 'favFolders' }); return [{ id: 7, title: '小鲸鱼娘的学习收藏' }]; },
      favDeal: async () => { calls.push({ path: 'favDeal' }); return {}; },
    },
  };
}

const SEARCH_HITS = [
  { bvid: 'BV1X38BzWEBn', title: '拉康导读系列播客', author: '徒梦的学习笔记', view: 124000, duration: '259:45' },
  { bvid: 'BV1BZtC68EXq', title: '拉康：我们如何用一生偷来一个我', author: '大圆镜科普', view: 2329000, duration: '8:09' },
  { bvid: 'BV1Ff4y1h7zY', title: '精神分析入门——Lacan镜像自我', author: '荀爽', view: 141000, duration: '59:16' },
  { bvid: 'BV1M1t4zyEUL', title: '53分钟速通拉康派精神分析导论', author: '此在Lab', view: 44000, duration: '53:52' },
];

// ── 1. 认命令 ─────────────────────────────────────────────────────────────
{
  assert.equal(parseDmCommand('你好呀主人'), null, '普通聊天不是命令');
  assert.equal(parseDmCommand(''), null);
  assert.equal(parseDmCommand('／搜 拉康'), null, '全角斜杠不认（别自作聪明）');

  assert.deepEqual(parseDmCommand('/搜 拉康精神分析'), { name: 'search', args: '拉康精神分析', raw: '搜' });
  assert.deepEqual(parseDmCommand('/search lacan'), { name: 'search', args: 'lacan', raw: 'search' });
  assert.equal(parseDmCommand('/s 拉康').name, 'search', '单字母别名');
  assert.equal(parseDmCommand('/找 拉康').name, 'search');

  assert.equal(parseDmCommand('/转达 你好').name, 'relay');
  assert.equal(parseDmCommand('/转达 你好').args, '你好');
  assert.equal(parseDmCommand('/转达 金易木木元 我喜欢你').args, '金易木木元 我喜欢你', '收件人留给 runRelay 去认');
  assert.equal(parseDmCommand('/relay hi').name, 'relay');

  assert.equal(parseDmCommand('/帮助').name, 'help');
  assert.equal(parseDmCommand('/').name, 'help', '光一个斜杠当求助');
  assert.equal(parseDmCommand('/重启').name, 'unknown', '不认识的就别提脑子猜');
  assert.equal(parseDmCommand('/重启').raw, '重启');
}

// ── 2. 命令表 ─────────────────────────────────────────────────────────────
{
  const help = dmCommandHelp();
  assert.ok(help.includes('/搜'), '命令表要说清 /搜');
  assert.ok(help.includes('/转达'), '命令表要说清 /转达');
  assert.ok(help.length <= 200, `命令表要能塞进一条私信（实际 ${help.length} 字）`);
}

// ── 3. /搜：真去搜，回前三条 ───────────────────────────────────────────────
{
  const { client, calls } = fakeClient({ searchResult: SEARCH_HITS });
  const out = await runDmCommand({ cfg: CFG, ledger: emptyLedger(), client, mid: OWNER_A, uname: '懒寻真', command: parseDmCommand('/搜 拉康精神分析') });
  assert.equal(out.ok, true);
  assert.equal(calls.length, 1, '只搜一次');
  assert.equal(calls[0].path, 'search');
  assert.equal(calls[0].keyword, '拉康精神分析');
  assert.ok(out.text.includes('共搜到 4 条'), '要说搜到几条');
  assert.ok(out.text.includes('BV1X38BzWEBn') && out.text.includes('BV1BZtC68EXq'), '要带上 BV 号');
  assert.ok(out.text.includes('12.4万'), '播放量要压成「万」');
  assert.ok(out.text.length <= 200, `回执不能超 200 字（实际 ${out.text.length}）`);

  const empty = await runDmCommand({ cfg: CFG, ledger: emptyLedger(), client: fakeClient().client, mid: OWNER_A, command: parseDmCommand('/搜') });
  assert.equal(empty.ok, false);
  assert.ok(empty.text.includes('/搜'), '没给关键词要教怎么写');

  const none = await runDmCommand({ cfg: CFG, ledger: emptyLedger(), client: fakeClient({ searchResult: [] }).client, mid: OWNER_A, command: parseDmCommand('/搜 不存在的东西') });
  assert.equal(none.ok, false);
  assert.ok(none.text.includes('一条都没搜到'));

  const boom = await runDmCommand({ cfg: CFG, ledger: emptyLedger(), client: fakeClient({ failSearch: 'B站接口返回 -412：请求被拦截' }).client, mid: OWNER_A, command: parseDmCommand('/搜 拉康') });
  assert.equal(boom.ok, false, '搜失败要如实说，不许假装搜到了');
  assert.ok(boom.text.includes('-412'), '失败原因要带回来');
}

// ── 4. /转达：真发私信给另一位主人 ─────────────────────────────────────────
{
  const ledger = emptyLedger();
  const { client, calls } = fakeClient();
  const out = await runDmCommand({ cfg: CFG, ledger, client, mid: OWNER_A, uname: '懒寻真', command: parseDmCommand('/转达 他喜欢你') });
  assert.equal(out.ok, true);
  assert.equal(calls.length, 1, '真发出去了');
  assert.equal(calls[0].path, 'sendMsg');
  assert.equal(String(calls[0].receiverId), String(OWNER_B), '默认转给另一位主人');
  assert.equal(calls[0].content, '他喜欢你');
  assert.ok(out.text.includes('转达到位'), '回执要说办成了');
  assert.equal(ledger.dms.length, 1, '要进账本');
  assert.equal(String(ledger.dms[0].mid), String(OWNER_B));

  // 点名的收件人要对得上才认
  const named = fakeClient();
  const out2 = await runDmCommand({ cfg: CFG, ledger: emptyLedger(), client: named.client, mid: OWNER_B, uname: '金易木木元', command: parseDmCommand('/转达 懒寻真 我也喜欢你') });
  assert.equal(out2.ok, true);
  assert.equal(String(named.calls[0].receiverId), String(OWNER_A), '点名了懒寻真就发给他');
  assert.equal(named.calls[0].content, '我也喜欢你', '收件人那截不能混进正文');

  // 昵称对不上：整串当正文，绝不猜收件人（转错人比不转更糟）
  const odd = fakeClient();
  await runDmCommand({ cfg: CFG, ledger: emptyLedger(), client: odd.client, mid: OWNER_A, uname: '懒寻真', command: parseDmCommand('/转达 张三 你好') });
  assert.equal(String(odd.calls[0].receiverId), String(OWNER_B), '对不上就还是默认那位');
  assert.equal(odd.calls[0].content, '张三 你好', '整串当正文，不擅自改意思');

  // 空正文
  const blank = await runDmCommand({ cfg: CFG, ledger: emptyLedger(), client: fakeClient().client, mid: OWNER_A, command: parseDmCommand('/转达') });
  assert.equal(blank.ok, false);
  assert.ok(blank.text.includes('/转达'), '没正文要教怎么写');

  // 闸门拦下时要如实回执（每天最多 3 条，塞满它）
  const full = emptyLedger();
  for (let i = 0; i < 3; i += 1) full.dms.push({ mid: String(OWNER_B), uname: '金易木木元', text: 'x', date: new Date().toISOString().slice(0, 10), ts: Date.now() });
  const blocked = fakeClient();
  const out3 = await runDmCommand({ cfg: CFG, ledger: full, client: blocked.client, mid: OWNER_A, command: parseDmCommand('/转达 你好') });
  assert.equal(out3.ok, false, '被闸门拦住不能算办成');
  assert.ok(out3.text.includes('没转成'), '要说清楚没转成');
  assert.equal(blocked.calls.length, 0, '拦下了就一个请求都别发');
}

// ── 5. 不认识 / 求助 / 缺东西 ────────────────────────────────────────────
{
  const help = await runDmCommand({ cfg: CFG, ledger: emptyLedger(), client: fakeClient().client, mid: OWNER_A, command: parseDmCommand('/帮助') });
  assert.equal(help.ok, true);
  assert.ok(help.text.includes('/搜'));

  const unknown = await runDmCommand({ cfg: CFG, ledger: emptyLedger(), client: fakeClient().client, mid: OWNER_A, command: parseDmCommand('/重启') });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.text.includes('不认识'), '不认识就直说，别让模型编');
  assert.ok(unknown.text.includes('/搜'), '顺手给命令表');

  const nada = await runDmCommand({ cfg: CFG, ledger: emptyLedger(), client: fakeClient().client, mid: OWNER_A, command: null });
  assert.equal(nada.ok, false);
  assert.equal(nada.text, '', '不是命令就别吭声');

  // 只有一位主人时无从「转达给另一位」
  const solo = await runDmCommand({
    cfg: { ...CFG, ownerNames: ['懒寻真'], ownerMids: [OWNER_A] },
    ledger: emptyLedger(),
    client: fakeClient().client,
    mid: OWNER_A,
    command: parseDmCommand('/转达 你好'),
  });
  assert.equal(solo.ok, false);
  assert.ok(solo.text.includes('不知道该转给谁'));
}

// ── 6. /刷：主人指定刷什么，她就真去刷什么 ────────────────────────────────────
//
// 主人 2026-10-05：「给她自己自动刷视频的权限，每一天都要有浏览记录，遇到觉得有意思的
// 视频就三连，还有我们让她刷什么视频她就要刷什么」。
{
  const WATCH_CFG = {
    ...CFG,
    policy: { ...CFG.policy, postTriple: 'auto', tripleMinScore: 6, dailyTriples: 10, tripleCoin: 1, reportHistory: true, minIntervalSeconds: 0, minIntervalSecondsOwner: 0 },
  };

  // 给 BV 号：真拉详情 → 真报浏览记录 → 真三连。
  const ledger = emptyLedger();
  const { client, calls } = fakeClient();
  const out = await runDmCommand({ cfg: WATCH_CFG, ledger, client, mid: OWNER_A, uname: '懒寻真', command: parseDmCommand('/刷 BV1M5411g7He') });
  assert.equal(out.ok, true);
  assert.ok(calls.some((c) => c.path === 'video' && c.id === 'BV1M5411g7He'), '要真去拉详情');
  const hist = calls.find((c) => c.path === 'historyReport');
  assert.ok(hist !== undefined, '要真报 B 站浏览记录');
  assert.equal(hist.cid, 345175659, 'cid 必须带上，不然报不进历史');
  assert.ok(calls.some((c) => c.path === 'videoLike'), '觉得有意思要三连（点赞）');
  assert.ok(calls.some((c) => c.path === 'favDeal'), '三连要收藏');
  assert.equal(ledger.watched.length, 1, '要留下本机痕迹');
  assert.equal(ledger.watched[0].source, 'master', '痕迹要标出来是主人点的');
  assert.equal(ledger.watched[0].reported, true);
  assert.ok(out.text.includes('刷了 1 个'), `回执要说刷了几个（实际：${out.text}）`);
  assert.ok(out.text.includes('进历史✓'), '回执要说进没进历史');
  assert.ok(out.text.includes('三连✓'), '回执要说连没连');
  assert.ok(out.text.length <= 200, `回执不能超 200 字（实际 ${out.text.length}）`);

  // 给关键词：先搜、再逐个拉详情去刷。
  const keyed = fakeClient({ searchResult: SEARCH_HITS });
  const led2 = emptyLedger();
  const out2 = await runDmCommand({ cfg: WATCH_CFG, ledger: led2, client: keyed.client, mid: OWNER_A, command: parseDmCommand('/刷 拉康 2') });
  assert.equal(out2.ok, true);
  assert.equal(keyed.calls.filter((c) => c.path === 'search').length, 1, '关键词只搜一次');
  assert.equal(keyed.calls.filter((c) => c.path === 'video').length, 2, '个数说 2 就拉 2 条详情');
  assert.equal(led2.watched.length, 2, '两条都要留痕');

  // 缺参数 / 拉不到：如实说，别假装刷了。
  const bare = await runDmCommand({ cfg: WATCH_CFG, ledger: emptyLedger(), client: fakeClient().client, mid: OWNER_A, command: parseDmCommand('/刷') });
  assert.equal(bare.ok, false);
  assert.ok(bare.text.includes('/刷'), '没给参数要教怎么写');

  const boom = await runDmCommand({ cfg: WATCH_CFG, ledger: emptyLedger(), client: fakeClient({ failVideo: 'B站接口返回 -412：请求被拦截' }).client, mid: OWNER_A, command: parseDmCommand('/刷 BV1M5411g7He') });
  assert.equal(boom.ok, false, '刷失败不能算办成');
  assert.ok(boom.text.includes('-412'), '失败原因要带回来');
}

console.log('✓ 私信命令测试通过：认命令、命令表、/搜 真搜并压字数、/刷 真刷+留痕+三连、/转达 真发并过闸门、不认识就不猜');
