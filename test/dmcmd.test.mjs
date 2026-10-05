/**
 * 私信「真命令 + 自然语言」的单元测试。
 *
 * 第一起事故（2026-10-05 上午，主人：「我想让她给我转达消息一直做不到」）：主人在私信里让她
 * 提炼拉康视频、让她转达消息，她从 00:22 到 10:14 连着回了 8 次「马上就好」，一件事没办 ——
 * 因为私信自动回复这条路**只会说话**，没有任何执行环节。这里钉住 `lib/dmcmd.js`：
 * 认命令 → 真执行 → 回执，而且不许把命令丢给模型。
 *
 * 第二起（2026-10-05 下午，主人：「私信刷视频不要命令形式，自然语言识别，让她自己刷」）：
 * 主人不想背 `/刷` `/搜` 这些命令，于是有了 `lib/intent.js` —— 大白话也走**同一段执行代码**。
 * 这里同时钉住 `lib/intent.js`：主人怎么说话都认得出，否定句（「别刷了」）和问方法
 * （「怎么搜」）一律不动手。
 *
 * 用法：node test/dmcmd.test.mjs
 */
import { strict as assert } from 'node:assert';
import { dmCommandHelp, parseDmCommand, runDmCommand, runDmIntent } from '../lib/dmcmd.js';
import { looksLikeActionRequest, parseIntent } from '../lib/intent.js';
import { emptyLedger, recordWatched, selfWatchedToday } from '../lib/ledger.js';

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

// ── 2. 说明书：教的是**人话**，不再是斜杠命令 ───────────────────────────────
{
  const help = dmCommandHelp();
  assert.ok(help.includes('搜一下'), `说明书要教她怎么用大白话让她搜（实际：${help}）`);
  assert.ok(help.includes('自己'), '说明书要说清「她自己挑自己刷」这件事');
  assert.ok(help.includes('转达'), '说明书要说清能替主人带话');
  assert.ok(help.includes('/搜') !== true, '主人说不要命令形式，说明书里就不该再列斜杠写法');
  assert.ok(help.length <= 200, `说明书要能塞进一条私信（实际 ${help.length} 字）`);
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
  assert.ok(empty.text.includes('搜一下'), '没给关键词要教怎么写');

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
  assert.ok(blank.text.includes('转达什么'), '没正文要教怎么说');

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
  assert.ok(help.text.includes('搜一下'));

  const unknown = await runDmCommand({ cfg: CFG, ledger: emptyLedger(), client: fakeClient().client, mid: OWNER_A, command: parseDmCommand('/重启') });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.text.includes('没听懂'), '没听懂就直说，别让模型编');
  assert.ok(unknown.text.includes('搜一下'), '顺手给人话说明书');

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
  assert.ok(bare.text.includes('看什么'), '没给参数要教怎么说');

  const boom = await runDmCommand({ cfg: WATCH_CFG, ledger: emptyLedger(), client: fakeClient({ failVideo: 'B站接口返回 -412：请求被拦截' }).client, mid: OWNER_A, command: parseDmCommand('/刷 BV1M5411g7He') });
  assert.equal(boom.ok, false, '刷失败不能算办成');
  assert.ok(boom.text.includes('-412'), '失败原因要带回来');
}

// ── 7. 自然语言：主人**不打命令**也必须能办成 ──────────────────────────────────
//
// 主人 2026-10-05：「私信刷视频不要命令形式，自然语言识别，让她自己刷。」
// 这一节钉两件事：①解析器认得出大白话；②认出之后**走的是同一段真执行代码**（真搜、真进历史）。
{
  // 7.1 不是命令的话，一个字都不许动
  assert.equal(parseIntent(''), null);
  assert.equal(parseIntent('你好呀主人，今天心情怎么样？'), null, '纯聊天别乱动主人账号');
  assert.equal(parseIntent('别刷了'), null, '否定句一律不动手');
  assert.equal(parseIntent('先别搜拉康了'), null);
  assert.equal(parseIntent('这个要怎么搜呀'), null, '问方法 ≠ 让去做');
  assert.equal(parseIntent('刷完了吗'), null, '只是问问，不是让去刷');

  // 7.2 搜：各种说法都要认出来，关键词要抠干净（尾巴上的「的视频」「吧」不能带进去）
  const wantSearch = [
    ['帮我搜一下拉康精神分析', '拉康精神分析'],
    ['搜一下拉康精神分析', '拉康精神分析'],
    ['你去找找拉康精神分析', '拉康精神分析'],
    ['给我推荐几个拉康精神分析', '拉康精神分析'],
    ['有没有拉康精神分析的视频', '拉康精神分析'],
    ['你能不能帮我搜拉康的视频？', '拉康'],
    ['搜一下拉康精神分析的视频吧', '拉康精神分析'],
  ];
  for (const [said, want] of wantSearch) {
    const hit = parseIntent(said);
    assert.ok(hit !== null, `这句得认出来：${said}`);
    assert.equal(hit.name, 'search', `这句该当「搜」：${said}`);
    assert.equal(hit.keyword, want, `关键词要抠干净：${said} → ${hit.keyword}`);
  }
  assert.equal(parseIntent('搜一下拉康的视频').keyword, '拉康', '「的视频」这种尾巴要去掉');

  // 7.3 自己刷：没点名，她自己挑
  for (const said of ['你自己去找点视频看看', '自己刷点视频吧', '你自己随便看看视频', '帮我自动刷点视频']) {
    const hit = parseIntent(said);
    assert.ok(hit !== null, `这句得认出来：${said}`);
    assert.equal(hit.name, 'watch', `这句该当「自己刷」：${said}`);
    assert.equal(hit.self, true, `没点名就该自己挑：${said}`);
  }

  // 7.4 点名刷：认 BV 号和关键词，个数也认
  const byId = parseIntent('帮我看看 BV1M5411g7He');
  assert.equal(byId.name, 'watch');
  assert.equal(byId.self, false);
  assert.equal(byId.target, 'BV1M5411g7He');
  assert.equal(byId.keyword, '', 'BV 号不是搜索关键词');

  const byWord = parseIntent('刷一下拉康精神分析的视频');
  assert.equal(byWord.name, 'watch');
  assert.equal(byWord.target, '拉康精神分析');
  assert.equal(parseIntent('看 3 个拉康的视频').count, 3, '说 3 个就 3 个');
  assert.equal(parseIntent('看两条拉康的视频').count, 2, '中文数字也认');

  // 7.5 转达
  const relay = parseIntent('帮我跟金易木木元说声谢谢');
  assert.equal(relay.name, 'relay');
  assert.equal(relay.target, '金易木木元 谢谢');
  assert.equal(parseIntent('告诉懒寻真人家想他啦').name, 'relay');

  // 7.5b 光杆「和」是连词不是转达动词（2026-10-05 真事故：金易木木元发的
  //      「从场域，本体论，认识论和目的论四个方面总结整个系列，而不是这一期」
  //      被「和」切成「转达『目的论四个方面总结整个系列…』给懒寻真」，她回了句「没转成」。
  //      当时靠私信上限拦住才没发出去 —— 上限一关，这条误判就会真发一条垃圾私信。
  assert.equal(
    parseIntent('从场域，本体论，认识论和目的论四个方面总结整个系列，而不是这一期'),
    null,
    '带「和」的正常句子不许被当成转达',
  );
  assert.notEqual(parseIntent('顺着这个和那个都看看')?.name, 'relay', '「和」在别的档位也不许变成 relay');
  assert.equal(parseIntent('我和他说一下').name, 'relay', '「和…说」是转达，别连坐');

  // 7.6 「在支使人干活但认不出来」要能被标出来（好让脑子老实说办不到）
  assert.equal(looksLikeActionRequest('帮我重启一下程序'), true, '认不出也要知道这是在支使人');
  assert.equal(looksLikeActionRequest('你好呀主人'), false, '纯聊天不算支使');
  assert.equal(looksLikeActionRequest('别去弄了'), false, '否定句不算支使');
}

// ── 8. 自然语言 → 真执行：不走脑子，走同一段代码 ────────────────────────────────
{
  // 8.1 「帮我搜一下…」真去搜
  const { client, calls } = fakeClient({ searchResult: SEARCH_HITS });
  const out = await runDmIntent({ cfg: CFG, ledger: emptyLedger(), client, mid: OWNER_A, uname: '懒寻真', text: '帮我搜一下拉康精神分析的视频' });
  assert.equal(out.ok, true);
  assert.equal(calls.length, 1, '只搜一次');
  assert.equal(calls[0].path, 'search');
  assert.equal(calls[0].keyword, '拉康精神分析', '要拿抠干净的关键词去搜');
  assert.ok(out.text.includes('BV1X38BzWEBn'), '回执要带 BV 号');

  // 8.2 「你自己去看点东西」真看、真进浏览记录、来源标 self
  const self = fakeClient({ searchResult: SEARCH_HITS });
  const ledSelf = emptyLedger();
  const outSelf = await runDmIntent({
    cfg: { ...CFG, policy: { ...CFG.policy, postTriple: 'auto', tripleMinScore: 6, dailyTriples: 10, tripleCoin: 1, reportHistory: true } },
    ledger: ledSelf,
    client: self.client,
    mid: OWNER_A,
    uname: '懒寻真',
    text: '你自己去找点视频看看',
  });
  assert.equal(outSelf.ok, true);
  assert.ok(self.calls.some((c) => c.path === 'historyReport'), '要真报 B 站浏览记录，历史里得看得到');
  assert.equal(ledSelf.watched.length, 1, '要留下本机痕迹');
  assert.equal(ledSelf.watched[0].source, 'self', '痕迹要标出来是她自己挑的');
  assert.ok(outSelf.text.includes('自己按'), `回执要说清是她自己挑的（实际：${outSelf.text}）`);

  // 8.3 「跟我跟 XX 说声谢谢」真发出去，而且正文里不许混进「帮我…说声」
  const relay = fakeClient();
  const outRelay = await runDmIntent({ cfg: CFG, ledger: emptyLedger(), client: relay.client, mid: OWNER_A, uname: '懒寻真', text: '帮我跟金易木木元说声谢谢' });
  assert.equal(outRelay.ok, true);
  assert.equal(relay.calls.length, 1);
  assert.equal(relay.calls[0].path, 'sendMsg');
  assert.equal(String(relay.calls[0].receiverId), String(OWNER_B), '要真发给另一位主人');
  assert.equal(relay.calls[0].content, '谢谢', `转达是原样带话，动词不许混进去（实际：${relay.calls[0].content}）`);

  // 8.4 认不出来就闭嘴（交回聊天链路），绝不假装办了
  const nada = await runDmIntent({ cfg: CFG, ledger: emptyLedger(), client: fakeClient().client, mid: OWNER_A, text: '帮我重启一下程序' });
  assert.equal(nada.ok, false);
  assert.equal(nada.text, '', '认不出来就别吭声，让脑子老实聊');

  // 8.5 斜杠写法还得能用（老主人手熟）
  const slash = fakeClient({ searchResult: SEARCH_HITS });
  const outSlash = await runDmIntent({ cfg: CFG, ledger: emptyLedger(), client: slash.client, mid: OWNER_A, text: '/搜 拉康' });
  assert.equal(outSlash.ok, true, '斜杠命令不能被自然语言那层吃掉');
  assert.equal(slash.calls[0].keyword, '拉康');
}

// ── 9. 第九轮：一次看多个 / 自己刷有上限（主人 2026-10-05）───────────────────
{
  // 9.1 一条私信里写三个 BV 号 → 三条全看（主人：「主人让它看的要看」）
  const THREE = 'BV1X38BzWEBn BV1BZtC68EXq BV1Ff4y1h7zY';
  const parsedMulti = parseIntent(`帮我看看 ${THREE}`);
  assert.equal(parsedMulti?.name, 'watch');
  assert.deepEqual(parsedMulti?.targets, ['BV1X38BzWEBn', 'BV1BZtC68EXq', 'BV1Ff4y1h7zY'], `三个 BV 号要全认出来（实际：${JSON.stringify(parsedMulti?.targets)}）`);
  const multi = fakeClient();
  const ledMulti = emptyLedger();
  const outMulti = await runDmIntent({
    cfg: { ...CFG, policy: { ...CFG.policy, postTriple: 'off' } },
    ledger: ledMulti,
    client: multi.client,
    mid: OWNER_A,
    uname: '懒寻真',
    text: `帮我看看 ${THREE}`,
  });
  assert.equal(outMulti.ok, true, `三个 BV 号要刷得动（实际：${outMulti.text}）`);
  assert.equal(multi.calls.filter((c) => c.path === 'video').length, 3, '三个 BV 号要真拉三次详情');
  assert.equal(ledMulti.watched.length, 3, '三条都要留痕');
  assert.ok(outMulti.text.includes('刷了 3 个'), `回执要说清刷了几个（实际：${outMulti.text}）`);

  // 9.2 个数能到十（原来夹在 1..5），但也不许无限拉
  assert.equal(parseIntent('看 8 个拉康的视频')?.count, 8, '主人说八个就是八个');
  assert.equal(parseIntent('看 20 个拉康的视频')?.count, 10, '再大也只认到 10，别一次拉一百条');

  // 9.3 她自己刷有每日上限（learning.dailyWatch）；主人点名的**不计数也不受限**
  const ledCap = emptyLedger();
  recordWatched(ledCap, { bvid: 'BV1atCRYsE7x', source: 'study' });
  recordWatched(ledCap, { bvid: 'BV1fY411J7wD', source: 'self' });
  const capCfg = { ...CFG, policy: { ...CFG.policy, postTriple: 'off' }, learning: { enabled: true, dailyWatch: 2 } };
  const capped = fakeClient({ searchResult: SEARCH_HITS });
  const outCapped = await runDmIntent({ cfg: capCfg, ledger: ledCap, client: capped.client, mid: OWNER_A, uname: '懒寻真', text: '你自己去找点视频看看' });
  assert.equal(outCapped.ok, false, '自己刷的额度用完就别再自己挑了（主人：「不要一味的自己刷视频」）');
  assert.ok(outCapped.text.includes('上限'), `要说清是额度问题（实际：${outCapped.text}）`);
  assert.equal(capped.calls.length, 0, '额度满了不该再打 B 站接口');
  const named = fakeClient();
  const outNamed = await runDmIntent({ cfg: capCfg, ledger: ledCap, client: named.client, mid: OWNER_A, uname: '懒寻真', text: '看看 BV1X38BzWEBn' });
  assert.equal(outNamed.ok, true, '主人点名的片子不受她自己额度限制');
  assert.equal(ledCap.watched.at(-1).source, 'master', '主人点名的要标 master');
  assert.equal(selfWatchedToday(ledCap).length, 2, '额度只数自己刷的：master 那条不算');
}

console.log('✓ 私信测试通过：斜杠命令照旧、大白话也认（搜/自己刷/点名刷/转达）、否定句与问方法一律不动手、/搜 真搜并压字数、/刷 真刷+留痕+三连、/转达 真发并过闸门、认不出就不猜、一条私信多个 BV 号全看、自己刷有每日上限而主人点名的不算');
