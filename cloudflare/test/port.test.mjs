/**
 * 移植保真度测试：cloudflare/src/** 与 lib/** 的行为必须一致。
 *
 * 跑法：node cloudflare/test/port.test.mjs
 * 零依赖（只用 node: 内置模块 —— 测试文件本身可以 import node: 东西）。
 *
 * 说明：本文件只读 lib/**，不修改任何源文件。
 *
 * @module dsh-bilibili-whale/cloudflare/test
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { md5Hex, md5Bytes } from '../src/md5.js';
import * as wbiNew from '../src/wbi.js';
import * as wbiOld from '../../lib/wbi.js';
import * as cookiesOld from '../../lib/cookies.js';
import * as apiOld from '../../lib/api.js';
import * as oldPolicy from '../../lib/policy.js';
import * as oldLedger from '../../lib/ledger.js';
import {
  BiliClient,
  BiliError,
  CODE_HINT,
  COOKIE_KEYS,
  cookieHeader,
  fmtDuration,
  fmtTime,
  hasWriteCredentials,
  parseCookieString,
  parseSetCookie,
  readSetCookie,
  stripHtml,
} from '../src/bili.js';
import * as ledger from '../src/ledger.js';
import { DEFAULTS, checkDynamic, checkReply, checkVideoComment, isOwner } from '../src/policy.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(HERE, '..', 'src');
const CLOUDFLARE_DIR = join(HERE, '..');

/** 本次移植负责的 5 个文件（constraint 自检的判定范围）。 */
const PORTED_FILES = ['bili.js', 'ledger.js', 'md5.js', 'policy.js', 'wbi.js'];

let passed = 0;
let failed = 0;
const failures = [];

/** 断言包装：失败不中断，最后一起汇报（带清楚的 diff）。 */
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.log(`  FAIL ${name}`);
    console.log(
      String(error?.message ?? error)
        .split('\n')
        .map((line) => `       ${line}`)
        .join('\n'),
    );
  }
}

/** 异步断言包装。 */
async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.log(`  FAIL ${name}`);
    console.log(
      String(error?.message ?? error)
        .split('\n')
        .map((line) => `       ${line}`)
        .join('\n'),
    );
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/** 复制一份默认配置（避免测试之间互相污染）。 */
function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

/** 换一个与默认不同的时间，避免踩到最小间隔。 */
function farFuture() {
  return Date.parse('2030-01-01T00:00:00Z');
}

/** 把所有参数（含 wts）显式钉死，这样新旧 signUrl 才可比。 */
function pinWts(rawUrl, wts) {
  const url = new URL(rawUrl);
  url.searchParams.set('wts', String(wts));
  return url.toString();
}

/**
 * 把两只时钟冻结到同一个值再跑 fn（源文件 signUrl 只能取 `Date.now()`，
 * 所以要和它逐字符对比就必须冻结时钟，而不是给一边注入 wts）。
 */
function withFrozenClock(seconds, fn) {
  const original = Date.now;
  Date.now = () => seconds * 1000;
  try {
    return fn();
  } finally {
    Date.now = original;
  }
}

/** 从 URL 里取 query 对象。 */
function qs(url) {
  return new URL(url).searchParams;
}

/**
 * 按「URL 包含的片段」匹配路由的假 fetch。
 * 未匹配到的片段抛错（暴露 URL 写错）。
 */
function makeFakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const text = String(url);
    const method = init.method ?? 'GET';
    let body = null;
    if (typeof init.body === 'string' && init.body !== '') {
      body = init.body.startsWith('{') ? JSON.parse(init.body) : parseCookieString(init.body.replace(/&/g, ';'));
    }
    const hit = routes.find((route) => text.includes(route.match) && (route.method === undefined || route.method === method));
    calls.push({ url: text, method, headers: init.headers ?? {}, body, signal: init.signal });
    if (hit === undefined) throw new Error(`假 fetch 没有为这个请求准备响应：${method} ${text}`);
    return makeResponse(hit.body ?? {}, hit.status ?? 200, hit.setCookie ?? []);
  };
  return { impl, calls };
}

/**
 * 造一个带 Set-Cookie 的 Response。
 * 注意用 append 逐条加头：`new Response(body, { headers: { 'set-cookie': [...] } })` 在 Node 的
 * undici 里会被折叠成一条（逗号连接）、getSetCookie() 只返回 1 项，与 Workers 的真实行为不符。
 */
function makeResponse(body, status = 200, setCookie = []) {
  const headers = new Headers();
  for (const raw of setCookie) headers.append('Set-Cookie', raw);
  headers.set('Content-Type', 'application/json');
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}

const SPI_ROUTE = { match: '/x/frontend/finger/spi', body: { code: 0, data: { b_3: 'B3-FAKE', b_4: 'B4-FAKE' } } };

// ─────────────────────────────────────────────────────────────
section('1. md5Hex（纯 JS MD5）');

check("md5Hex('') === d41d8cd98f00b204e9800998ecf8427e", () => {
  assert.equal(md5Hex(''), 'd41d8cd98f00b204e9800998ecf8427e');
});

check("md5Hex('abc') === 900150983cd24fb0d6963f7d28e17f72", () => {
  assert.equal(md5Hex('abc'), '900150983cd24fb0d6963f7d28e17f72');
});

check('中文 UTF-8：md5Hex 与 node:crypto 一致（含各类边界长度）', () => {
  const samples = [
    '中文',
    '小鲸鱼娘在 B 站认真学习 (。-`ω´-)✧',
    'a'.repeat(55),
    'a'.repeat(56),
    'a'.repeat(57),
    'a'.repeat(63),
    'a'.repeat(64),
    'a'.repeat(65),
    'a'.repeat(1000),
    '🐳'.repeat(9),
    '混合 mixed 中英 123 !@#$%^&*()_+',
  ];
  for (const sample of samples) {
    const expected = createHash('md5').update(sample, 'utf8').digest('hex');
    assert.equal(md5Hex(sample), expected, `md5Hex(${JSON.stringify(sample.slice(0, 24))}…) 与 node:crypto 不一致`);
  }
});

check('md5Bytes 也接受二进制输入', () => {
  assert.equal(md5Hex(new TextEncoder().encode('abc')), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(md5Bytes('').length, 16);
});

// ─────────────────────────────────────────────────────────────
section('2. WBI 兼容性（新 signUrl vs 原 lib/wbi.js）');

const WBI_CASES = [
  {
    label: '搜索（含中文关键词与编码字符）',
    rawUrl: 'https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=video&keyword=%E5%B0%8F%E9%B2%B8%E9%B1%BC%E5%A8%98%20test&page=1&page_size=20',
    imgKey: '7cd084941338484aae1ad9425b84077c',
    subKey: '4932caff0ff746eab6f01bf08b70ac45',
    wts: 1700000000,
  },
  {
    label: "首页推荐（参数里有 !'()* 需要被过滤）",
    rawUrl:
      "https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?web_location=1430650&y_num=5&fresh_type=4&feed_version=V8&fresh_idx_1h=1&fetch_row=1&fresh_idx=1&brush=0&homepage_ver=1&ps=12&note=a!b'c(d)e*f",
    imgKey: 'e2f0e1a1b2c3d4e5f60718293a4b5c6d',
    subKey: '11223344556677889900aabbccddeeff',
    wts: 1700000123,
  },
  {
    label: '另一组密钥 + 含中文',
    rawUrl: 'https://api.bilibili.com/x/web-interface/wbi/search/type?search_type=bili_user&keyword=%E6%87%92%E5%AF%BB%E7%9C%9F&page=1',
    imgKey: 'abc123def456abc123def456abc12345',
    subKey: '9876543210fedcba9876543210fedcba',
    wts: 1893456000,
  },
  {
    label: '只有 wts 的裸 URL',
    rawUrl: 'https://api.bilibili.com/x/web-interface/wbi/search/type',
    imgKey: '0123456789abcdef0123456789abcdef',
    subKey: 'fedcba9876543210fedcba9876543210',
    wts: 1700000001,
  },
];

for (const item of WBI_CASES) {
  check(`signUrl 输出完全一致 —— ${item.label}`, () => {
    // 源文件 signUrl 是 3 参、wts 永远取 `Math.round(Date.now() / 1000)`。
    // 所以比对的正确做法是「把两只时钟冻结到同一个值、两边都用 3 参调用」——
    // 而不是只给新实现注入 wts（那样一边是注入值、一边是真实时间，必然不等）。
    const { mine, theirs } = withFrozenClock(item.wts, () => ({
      mine: wbiNew.signUrl(item.rawUrl, item.imgKey, item.subKey),
      theirs: wbiOld.signUrl(item.rawUrl, item.imgKey, item.subKey),
    }));
    assert.equal(mine, theirs, '完整 URL（含 w_rid）必须逐字符一致');
    const mineRid = qs(mine).get('w_rid');
    assert.equal(mineRid, qs(theirs).get('w_rid'), 'w_rid 必须一致');
    assert.match(String(mineRid), /^[0-9a-f]{32}$/);
    assert.equal(qs(mine).get('wts'), String(item.wts), `wts 必须等于冻结的时钟：${item.wts}`);
    assert.equal(qs(mine).get('wts'), qs(theirs).get('wts'));
  });
}

check('signUrl 不传 wts 时用当前时间（与源文件同语义）', () => {
  const url = 'https://api.bilibili.com/x/web-interface/wbi/search/type?keyword=x';
  const { mine, theirs } = withFrozenClock(1_700_000_777, () => ({
    mine: wbiNew.signUrl(url, 'k1', 'k2'),
    theirs: wbiOld.signUrl(url, 'k1', 'k2'),
  }));
  assert.equal(qs(mine).get('wts'), qs(theirs).get('wts'));
  assert.equal(mine, theirs, '未注入 wts 时必须与源文件 3 参调用逐字符一致');
  assert.match(qs(mine).get('w_rid'), /^[0-9a-f]{32}$/);
});

check('signUrl 第 4 参（本移植新增的注入点）等价于「冻结时钟」', () => {
  for (const item of WBI_CASES) {
    const injected = wbiNew.signUrl(item.rawUrl, item.imgKey, item.subKey, item.wts);
    const frozen = withFrozenClock(item.wts, () => wbiNew.signUrl(item.rawUrl, item.imgKey, item.subKey));
    assert.equal(injected, frozen, `第 4 参与冻结时钟不等价：${item.label}`);
    // 顺带确认注入点没有改变「url 里已有 wts 会被覆盖」这一源文件语义。
    const pinned = pinWts(item.rawUrl, 1);
    const overridden = wbiNew.signUrl(pinned, item.imgKey, item.subKey, item.wts);
    assert.equal(qs(overridden).get('wts'), String(item.wts), 'url 里已有的 wts 必须被时间戳覆盖（同源文件）');
    assert.equal(overridden, injected, '钉死的 wts 参数不应影响签名结果（同源文件 encodeWbi 的覆盖语义）');
  }
});

check('keyFromUrl / mixinKey / encodeWbi / md5 与源文件逐项一致', () => {
  const urls = [
    'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
    'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
    '',
    undefined,
    'no-extension',
  ];
  for (const url of urls) {
    assert.equal(wbiNew.keyFromUrl(url), wbiOld.keyFromUrl(url), `keyFromUrl(${JSON.stringify(url)}) 不一致`);
  }
  const realPair = ['7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45'];
  const pairs = [realPair, ['abc', 'def'], ['', '']];
  for (const [img, sub] of pairs) {
    assert.equal(wbiNew.mixinKey(img, sub), wbiOld.mixinKey(img, sub), `mixinKey(${img}, ${sub}) 不一致`);
  }
  assert.equal(wbiNew.mixinKey(...realPair).length, 32);
  const params = { keyword: '中文 test', page: 1, search_type: 'video' };
  const now = 1700000000;
  assert.equal(
    wbiNew.encodeWbi(params, realPair[0], realPair[1], now),
    wbiOld.encodeWbi(params, realPair[0], realPair[1], now),
  );
  assert.equal(wbiNew.md5('abc'), wbiOld.md5('abc'));
  assert.equal(wbiNew.md5('abc'), md5Hex('abc'));
});

// ─────────────────────────────────────────────────────────────
section('3. ledger（纯函数 + 显式账本）');

check('createLedger 形状与源文件 emptyLedger 一致', () => {
  const empty = ledger.createLedger();
  assert.deepEqual(empty, {
    version: 1,
    comments: [],
    replies: [],
    dynamics: [],
    follows: [],
    dms: [],
    favorites: [],
    // 「刷到过什么」的视频流水（主人 2026-10-05：「让它刷视频能留下痕迹」）
    watched: [],
    study: [],
    dmIncoming: [],
    replyIndex: {},
    replyThreads: {},
    daily: {},
    materials: [],
    lastActionTs: 0,
    lastActionOwnerTs: 0,
    dynamicTemplateIndex: 0,
  });
  const dirty = ledger.createLedger({ version: 3, comments: 'nope', replyIndex: null, daily: 'x', extra: 1 });
  assert.deepEqual(dirty.comments, []);
  assert.deepEqual(dirty.replyIndex, {});
  assert.deepEqual(dirty.daily, {});
  assert.equal(dirty.version, 3);
  assert.equal(dirty.extra, 1);
  assert.deepEqual(ledger.createLedger(null), empty);
  assert.deepEqual(ledger.createLedger(), empty);
});

check('读取类函数：commentedVideo / threadReplyCount / lastReplyTsForUser / todayCounts', () => {
  const now = new Date(2026, 4, 20, 12, 0, 0);
  const l = ledger.createLedger();
  ledger.recordComment(l, { bvid: 'BV1xx411c7mD', aid: 111, rpid: 1, text: 'hi', ts: 1000, now });
  ledger.recordReply(l, {
    bvid: 'BV1xx411c7mD',
    aid: 111,
    rpid: 5,
    root: 1,
    targetMid: 42,
    targetUname: '路人',
    text: 'yo',
    selfRpid: 6,
    ts: 2000,
    now,
  });
  assert.equal(ledger.commentedVideo(l, 'BV1xx411c7mD')?.rpid, 1);
  assert.equal(ledger.commentedVideo(l, 'BVnope'), null);
  assert.equal(ledger.commentedVideo(l, ''), null);
  assert.equal(ledger.threadReplyCount(l, 1, 42), 1);
  assert.equal(ledger.threadReplyCount(l, 1, 43), 0);
  assert.equal(ledger.lastReplyTsForUser(l, 42), 2000);
  assert.equal(ledger.lastReplyTsForUser(l, 43), 0);
  assert.equal(ledger.dateKey(now), '2026-05-20');
  assert.deepEqual(ledger.todayCounts(l, now), { videoComments: 1, replies: 1, dynamics: 0, favorites: 0 });
  assert.deepEqual(ledger.todayCounts(l, new Date(2026, 4, 21)), { videoComments: 0, replies: 0, dynamics: 0, favorites: 0 });
});

check('记录类函数就地修改并返回同一个账本（动态 / 素材）', () => {
  const now = new Date(2026, 4, 20, 12, 0, 0);
  const l = ledger.createLedger();
  assert.equal(ledger.recordComment(l, { bvid: 'BV1', aid: 1, rpid: 9, text: 'x', ts: 5, now }), l);
  assert.equal(ledger.dynamicPostedToday(l, now), false);
  ledger.recordDynamic(l, { text: '学习打卡', dynId: 'd1', ts: 6, now });
  assert.equal(ledger.dynamicPostedToday(l, now), true);
  assert.equal(ledger.dynamicPostedToday(l, new Date(2026, 4, 21)), false);
  assert.deepEqual(ledger.todayCounts(l, now), { videoComments: 1, replies: 0, dynamics: 1, favorites: 0 });
  ledger.pushMaterial(l, '素材一');
  ledger.pushMaterial(l, '素材二');
  assert.equal(ledger.takeMaterial(l), '素材一');
  assert.equal(ledger.takeMaterial(l), '素材二');
  assert.equal(ledger.takeMaterial(l), null);
  assert.equal(l.materials[0].used, true);
});

check('主人回复记 lastActionOwnerTs；snapshotLedger 按上限裁剪', () => {
  const now = new Date(2026, 4, 20, 12, 0, 0);
  const l = ledger.createLedger();
  ledger.recordReply(l, {
    bvid: 'BV1',
    aid: 1,
    rpid: 2,
    root: 2,
    targetMid: 7,
    targetUname: '懒寻真',
    text: 'hi',
    isOwner: true,
    ts: 700,
    now,
  });
  assert.equal(l.lastActionTs, 700);
  assert.equal(l.lastActionOwnerTs, 700);
  for (let i = 0; i < 520; i += 1) l.comments.push({ bvid: `BV${i}`, ts: i });
  for (let i = 0; i < 40; i += 1) l.materials.push({ text: `m${i}`, used: true });
  ledger.snapshotLedger(l);
  assert.equal(l.comments.length, 500);
  assert.equal(l.materials.length, 30);
});

check('账本不需要任何文件/环境：坏数据也能归一化', () => {
  const l = ledger.createLedger({ comments: [{ bvid: 'BV1', ts: 5 }, null, 'x'], replyThreads: { '1|42': 2 } });
  assert.equal(l.comments.length, 3);
  assert.equal(ledger.threadReplyCount(l, 1, 42), 2);
  const bad = ledger.createLedger({ replyIndex: { 42: 'not-array' } });
  assert.equal(ledger.lastReplyTsForUser(bad, 42), 0);
});

// ─────────────────────────────────────────────────────────────
section('4. policy（策略闸门）');

check('isOwner：UID 命中 / 未配置 UID 时不认', () => {
  const cfg = cloneDefaults();
  assert.equal(isOwner(123, cfg), false);
  assert.equal(isOwner('123', cfg), false);
  cfg.ownerMid = 123;
  assert.equal(isOwner(123, cfg), true);
  assert.equal(isOwner('123', cfg), true);
  assert.equal(isOwner(456, cfg), false);
});

check('未登录/无写权限对应的 off 模式：视频评论被拒', () => {
  const cfg = cloneDefaults();
  cfg.policy.postVideoComment = 'off';
  const verdict = checkVideoComment({ cfg, ledger: ledger.createLedger(), bvid: 'BV1xx', message: '你好呀', now: farFuture() });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.needsConfirm, false);
  assert.equal(verdict.mode, 'off');
  assert.ok(verdict.reasons.some((r) => r.includes('postVideoComment = off')), `reasons=${JSON.stringify(verdict.reasons)}`);
  assert.deepEqual(verdict.warnings, []);
  assert.equal(verdict.hint, '');
});

check('off 模式：回复与动态同样被拒', () => {
  const cfg = cloneDefaults();
  cfg.policy.postReply = 'off';
  cfg.policy.postDynamic = 'off';
  const l = ledger.createLedger();
  const reply = checkReply({ cfg, ledger: l, bvid: 'BV1xx', root: 55, message: '回你', toMid: 9, toName: '路人', now: farFuture() });
  assert.equal(reply.allowed, false);
  assert.ok(reply.reasons.some((r) => r.includes('postReply = off')), `reasons=${JSON.stringify(reply.reasons)}`);
  const dyn = checkDynamic({ cfg, ledger: l, text: '今天也在学习', now: farFuture() });
  assert.equal(dyn.allowed, false);
  assert.ok(dyn.reasons.some((r) => r.includes('postDynamic = off')), `reasons=${JSON.stringify(dyn.reasons)}`);
});

check('confirm 模式：needsConfirm === true、allowed === false、带 hint', () => {
  const cfg = cloneDefaults();
  assert.equal(cfg.policy.postVideoComment, 'confirm');
  const l = ledger.createLedger();
  const verdict = checkVideoComment({ cfg, ledger: l, bvid: 'BV1xx', message: '主人今天也要开心哦', now: farFuture() });
  assert.equal(verdict.needsConfirm, true);
  assert.equal(verdict.allowed, false);
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.mode, 'confirm');
  assert.ok(verdict.hint.includes('草稿模式'), `hint=${verdict.hint}`);
  const confirmed = checkVideoComment({ cfg, ledger: l, bvid: 'BV1xx', message: '主人今天也要开心哦', confirm: true, now: farFuture() });
  assert.equal(confirmed.needsConfirm, false);
  assert.equal(confirmed.allowed, true);
  assert.equal(confirmed.hint, '');
});

check('同一视频重复评论被去重拦下', () => {
  const cfg = cloneDefaults();
  cfg.policy.postVideoComment = 'auto';
  const l = ledger.createLedger();
  const past = farFuture() - 3600000;
  ledger.recordComment(l, { bvid: 'BV1xx411c7mD', aid: 1, rpid: 11, text: '先发一条', ts: past, now: new Date(past) });
  const verdict = checkVideoComment({ cfg, ledger: l, bvid: 'BV1xx411c7mD', message: '再来一条', now: farFuture() });
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.reasons.some((r) => r.includes('已经评论过了')), `reasons=${JSON.stringify(verdict.reasons)}`);
  const other = checkVideoComment({ cfg, ledger: l, bvid: 'BVother', message: '换个视频', now: farFuture() });
  assert.equal(other.allowed, true, `reasons=${JSON.stringify(other.reasons)}`);
});

check('主人回复豁免每人一条 / 24 小时窗口（并给出提醒）', () => {
  const cfg = cloneDefaults();
  cfg.ownerMid = 272770398;
  const l = ledger.createLedger();
  const now = farFuture();
  ledger.recordReply(l, {
    bvid: 'BV1xx',
    aid: 1,
    rpid: 3,
    root: 3,
    targetMid: 272770398,
    targetUname: '懒寻真',
    text: '先回一条',
    isOwner: true,
    ts: now - 60000,
    now: new Date(now - 60000),
  });
  const ownerVerdict = checkReply({ cfg, ledger: l, bvid: 'BV1xx', root: 3, message: '主人再理人家一下嘛', toMid: 272770398, toName: '懒寻真', now });
  assert.equal(ownerVerdict.owner, true);
  assert.equal(ownerVerdict.allowed, true, `reasons=${JSON.stringify(ownerVerdict.reasons)}`);
  assert.deepEqual(ownerVerdict.warnings, ['主人优先：跳过「每人一条」限制']);
  assert.deepEqual(ownerVerdict.reasons, []);

  const strangerVerdict = checkReply({ cfg, ledger: l, bvid: 'BV1xx', root: 3, message: '你也在啊', toMid: 999, toName: '路人甲', now });
  assert.equal(strangerVerdict.owner, false);
  assert.ok(strangerVerdict.reasons.length > 0);
});

check('普通人：同一评论串已回过 1 条 → 拦下', () => {
  const cfg = cloneDefaults();
  const l = ledger.createLedger();
  const now = farFuture();
  ledger.recordReply(l, {
    bvid: 'BV1xx',
    aid: 1,
    rpid: 5,
    root: 5,
    targetMid: 42,
    targetUname: '路人',
    text: '回过了',
    ts: now - 3600000,
    now: new Date(now - 3600000),
  });
  const verdict = checkReply({ cfg, ledger: l, bvid: 'BV1xx', root: 5, message: '再回一条', toMid: 42, toName: '路人', now });
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.reasons.some((r) => r.includes('已经被回过 1 条了')), `reasons=${JSON.stringify(verdict.reasons)}`);
  assert.equal(verdict.rootRpid, 5);
});

check('普通人：24 小时窗口内（不同评论串）也拦下', () => {
  const cfg = cloneDefaults();
  const l = ledger.createLedger();
  const now = farFuture();
  ledger.recordReply(l, {
    bvid: 'BV1xx',
    aid: 1,
    rpid: 5,
    root: 5,
    targetMid: 42,
    targetUname: '路人',
    text: '回过了',
    ts: now - 3600000,
    now: new Date(now - 3600000),
  });
  const verdict = checkReply({ cfg, ledger: l, bvid: 'BV1xx', root: 77, message: '换个串回', toMid: 42, toName: '路人', now });
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.reasons.some((r) => r.includes('小时前刚被回过')), `reasons=${JSON.stringify(verdict.reasons)}`);
});

check('每日上限触发：评论 3 条 / 回复 10 条 / 动态 1 条', () => {
  const cfg = cloneDefaults();
  cfg.policy.postVideoComment = 'auto';
  const now = farFuture();
  const day = new Date(now);

  const lc = ledger.createLedger();
  for (let i = 0; i < cfg.policy.dailyVideoComments; i += 1) {
    ledger.recordComment(lc, { bvid: `BVday${i}`, aid: i, rpid: i, text: '打卡', ts: now - 100000, now: day });
  }
  const commentVerdict = checkVideoComment({ cfg, ledger: lc, bvid: 'BVnew', message: '还想再发', now });
  assert.equal(commentVerdict.allowed, false);
  assert.ok(
    commentVerdict.reasons.some((r) => r.includes('今日视频评论已达上限 3 条')),
    `reasons=${JSON.stringify(commentVerdict.reasons)}`,
  );

  const lr = ledger.createLedger();
  for (let i = 0; i < cfg.policy.dailyReplies; i += 1) {
    ledger.recordReply(lr, { bvid: `BVr${i}`, aid: i, rpid: i, root: i, targetMid: 1000 + i, targetUname: `路人${i}`, text: '回', ts: now - 100000, now: day });
  }
  const replyVerdict = checkReply({ cfg, ledger: lr, bvid: 'BVnew', root: 999, message: '还想再回', toMid: 2000, toName: '新路人', now });
  assert.equal(replyVerdict.allowed, false);
  assert.ok(
    replyVerdict.reasons.some((r) => r.includes('今日回复已达上限 10 条')),
    `reasons=${JSON.stringify(replyVerdict.reasons)}`,
  );

  const ld = ledger.createLedger();
  ledger.recordDynamic(ld, { text: '今天的动态', dynId: 'd1', ts: now - 100000, now: day });
  const dynamicVerdict = checkDynamic({ cfg, ledger: ld, text: '再发一条', auto: true, now });
  assert.equal(dynamicVerdict.allowed, false);
  assert.ok(
    dynamicVerdict.reasons.some((r) => r.includes('今日动态已达上限 1 条')),
    `reasons=${JSON.stringify(dynamicVerdict.reasons)}`,
  );
  assert.ok(dynamicVerdict.reasons.some((r) => r.includes('今天已经发过动态了')), `reasons=${JSON.stringify(dynamicVerdict.reasons)}`);
});

check('屏蔽词触发（固定文案）', () => {
  const cfg = cloneDefaults();
  cfg.policy.postVideoComment = 'auto';
  const l = ledger.createLedger();
  const verdict = checkVideoComment({ cfg, ledger: l, bvid: 'BV1xx', message: '想要资源的加群哦', now: farFuture() });
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.reasons.includes('命中屏蔽词「加群」'), `reasons=${JSON.stringify(verdict.reasons)}`);
  const replyVerdict = checkReply({ cfg, ledger: l, bvid: 'BV1xx', root: 1, message: '微信多少', toMid: 1, toName: '甲', now: farFuture() });
  assert.ok(replyVerdict.reasons.includes('命中屏蔽词「微信」'), `reasons=${JSON.stringify(replyVerdict.reasons)}`);
  const dynamicVerdict = checkDynamic({ cfg, ledger: l, text: '一起来互粉吧', now: farFuture() });
  assert.ok(dynamicVerdict.reasons.includes('命中屏蔽词「互粉」'), `reasons=${JSON.stringify(dynamicVerdict.reasons)}`);
});

check('字数上限 + 空内容 + 最小间隔', () => {
  const cfg = cloneDefaults();
  cfg.policy.postVideoComment = 'auto';
  const l = ledger.createLedger();
  const tooLong = checkVideoComment({ cfg, ledger: l, bvid: 'BV1xx', message: '字'.repeat(201), now: farFuture() });
  assert.ok(tooLong.reasons.some((r) => r.includes('超过上限 200 字')), `reasons=${JSON.stringify(tooLong.reasons)}`);
  const blank = checkVideoComment({ cfg, ledger: l, bvid: 'BV1xx', message: '   ', now: farFuture() });
  assert.ok(blank.reasons.includes('评论内容为空'), `reasons=${JSON.stringify(blank.reasons)}`);

  const now = farFuture();
  l.lastActionTs = now - 10000; // 10 秒前刚动过，策略要求 120 秒
  const interval = checkVideoComment({ cfg, ledger: l, bvid: 'BV1xx', message: '间隔太短', now });
  assert.ok(interval.reasons.some((r) => r.includes('策略要求至少 120 秒')), `reasons=${JSON.stringify(interval.reasons)}`);

  cfg.policy.minIntervalSecondsOwner = 15;
  l.lastActionOwnerTs = now - 10000;
  const ownerInterval = checkReply({ cfg, ledger: l, bvid: 'BV1xx', root: 1, message: '主人', toMid: 1, toName: '懒寻真', now });
  assert.ok(ownerInterval.reasons.some((r) => r.includes('策略要求至少 15 秒')), `reasons=${JSON.stringify(ownerInterval.reasons)}`);
});

check('她自己发的评论不回（selfMid 判定）', () => {
  const cfg = cloneDefaults();
  const verdict = checkReply({ cfg, ledger: ledger.createLedger(), bvid: 'BV1xx', root: 8, message: '自言自语', toMid: 555, toName: '小鲸鱼娘', selfMid: 555, now: farFuture() });
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.reasons.includes('这是她自己发的评论，不回自己'), `reasons=${JSON.stringify(verdict.reasons)}`);
});

check('DEFAULTS 与 lib/config.js 完全一致（原样搬运）', () => {
  const source = readFileSync(join(HERE, '..', '..', 'lib', 'config.js'), 'utf8');
  const marker = 'export const DEFAULTS =';
  const start = source.indexOf(marker) + marker.length;
  const end = source.indexOf('\n/**', start);
  // eslint-disable-next-line no-new-func
  const expected = new Function(`return (${source.slice(start, end).trim().replace(/;$/, '')})`)();
  assert.deepEqual(DEFAULTS, expected);
  assert.equal(DEFAULTS.dailyDynamic.templates.length, 5);
  assert.deepEqual(DEFAULTS.policy.blockKeywords, ['加群', '微信', 'QQ群', '代刷', '互粉', '刷单', '博彩', '赌博']);
});

// ─────────────────────────────────────────────────────────────
section('5. BiliClient（注入假 fetch）');

check('helper：stripHtml / fmtDuration / fmtTime / cookie 工具与源文件一致', () => {
  assert.equal(stripHtml('<em class="keyword">鲸鱼</em> &amp; 娘'), '鲸鱼 & 娘');
  assert.equal(stripHtml('&quot;a&quot;&lt;b&gt;'), '"a"<b>');
  assert.equal(fmtDuration(0), '0:00');
  assert.equal(fmtDuration(65), '1:05');
  assert.equal(fmtDuration(3661), '61:01');
  assert.equal(fmtDuration('12'), '0:12');
  assert.equal(fmtTime(null), '');
  assert.equal(fmtTime(0), '');
  // 东八区固定输出（源文件用的是「本地时区」，中文用户机器上就是 UTC+8）
  assert.equal(fmtTime(1700000000), '2023-11-15 06:13');
  assert.equal(Object.keys(CODE_HINT).length, 11);
  assert.equal(CODE_HINT['-101'], '先跑 bili_login 扫码登录。');
  assert.equal(COOKIE_KEYS.length, 11);
  assert.deepEqual(parseCookieString('SESSDATA=abc%2Cdef; bili_jct=xyz; DedeUserID=1'), {
    SESSDATA: 'abc%2Cdef',
    bili_jct: 'xyz',
    DedeUserID: '1',
  });
  assert.deepEqual(parseSetCookie(['buvid3=AAA; Path=/; Domain=.bilibili.com', 'weird', 'x=1']), { buvid3: 'AAA', x: '1' });
  // cookieHeader 按 cookies 对象的**插入顺序**输出，白名单只用于过滤、不决定顺序。
  assert.equal(
    cookieHeader({ SESSDATA: 'a', buvid3: 'b', buvid4: '', DedeUserID: '9', OTHER: 'z' }),
    'SESSDATA=a; buvid3=b; DedeUserID=9',
  );
  // 换一个插入顺序 → 输出顺序跟着变，证明不是按 COOKIE_KEYS 的顺序输出
  assert.equal(
    cookieHeader({ DedeUserID: '9', OTHER: 'z', buvid3: 'b', SESSDATA: 'a' }),
    'DedeUserID=9; buvid3=b; SESSDATA=a',
  );
  assert.equal(hasWriteCredentials({ SESSDATA: 'a', bili_jct: 'b' }), true);
  assert.equal(hasWriteCredentials({ SESSDATA: 'a' }), false);
  assert.equal(hasWriteCredentials({}), false);
  assert.equal(hasWriteCredentials({ SESSDATA: 'a', bili_jct: '' }), false);
});

check('cookie 工具与 lib/cookies.js 逐项对拍（源文件是唯一事实来源）', () => {
  const cookieCases = [
    { SESSDATA: 'a', buvid3: 'b', buvid4: '', DedeUserID: '9', OTHER: 'z' },
    { DedeUserID: '9', OTHER: 'z', buvid3: 'b', SESSDATA: 'a' },
    { b_nut: '1', buvid_fp: 'fp', CURRENT_FNVAL: '4048', sid: 's', x: '' },
    {},
  ];
  for (const cookies of cookieCases) {
    assert.equal(
      cookieHeader(cookies),
      cookiesOld.cookieHeader(cookies),
      `cookieHeader(${JSON.stringify(cookies)}) 与源文件不一致`,
    );
    assert.equal(
      hasWriteCredentials(cookies),
      cookiesOld.hasWriteCredentials(cookies),
      `hasWriteCredentials(${JSON.stringify(cookies)}) 与源文件不一致`,
    );
  }
  assert.deepEqual(COOKIE_KEYS, cookiesOld.COOKIE_KEYS);
  const rawCases = [
    'SESSDATA=abc%2Cdef; bili_jct=xyz; DedeUserID=1',
    'a=1;; b=2; =bad; c=',
    '',
    '  spaced = 1  ',
  ];
  for (const raw of rawCases) {
    assert.deepEqual(parseCookieString(raw), cookiesOld.parseCookieString(raw), `parseCookieString(${JSON.stringify(raw)})`);
  }
  const setCookieCases = [
    ['buvid3=AAA; Path=/; Domain=.bilibili.com', 'weird', 'x=1'],
    ['b_nut=1700000000; Expires=Wed, 20 May 2026 12:00:00 GMT', 'buvid_fp=abcdef'],
    [],
  ];
  for (const list of setCookieCases) {
    assert.deepEqual(parseSetCookie(list), cookiesOld.parseSetCookie(list), `parseSetCookie(${JSON.stringify(list)})`);
  }
});

check('helper：stripHtml / fmtDuration / fmtTime / CODE_HINT 与 lib/api.js 逐项对拍', () => {
  const htmlCases = ['<em class="keyword">鲸鱼</em> &amp; 娘', '&quot;a&quot;&lt;b&gt;', 'a<br/>b', '', '  x  ', '<a href="x">l</a>'];
  for (const text of htmlCases) {
    assert.equal(stripHtml(text), apiOld.stripHtml(text), `stripHtml(${JSON.stringify(text)}) 与源文件不一致`);
  }
  const secondCases = [0, 1, 59, 60, 65, 3599, 3600, 3661, 86399, 86400, 0.4, -5, null, undefined, '12', 'abc'];
  for (const seconds of secondCases) {
    assert.equal(
      fmtDuration(seconds),
      apiOld.fmtDuration(seconds),
      `fmtDuration(${JSON.stringify(seconds)}) 与源文件不一致`,
    );
  }
  const timeCases = [0, 1, 1700000000, 1700000000_000, 1893456000, null, undefined, '1700000000', 'abc'];
  for (const ts of timeCases) {
    assert.equal(fmtTime(ts), apiOld.fmtTime(ts), `fmtTime(${JSON.stringify(ts)}) 与源文件不一致`);
  }
  assert.deepEqual(CODE_HINT, apiOld.CODE_HINT);
});

check('readSetCookie：多条 Set-Cookie 逐条保留，不被逗号折叠', () => {
  const response = makeResponse({}, 200, [
    'buvid3=AAA; Path=/; Domain=.bilibili.com; Expires=Wed, 20 May 2026 12:00:00 GMT',
    'buvid4=BBB; Path=/; Domain=.bilibili.com',
  ]);
  const list = readSetCookie(response.headers);
  assert.equal(list.length, 2, `应保留 2 条，实际 ${JSON.stringify(list)}`);
  assert.deepEqual(parseSetCookie(list), { buvid3: 'AAA', buvid4: 'BBB' });
  assert.deepEqual(readSetCookie(new Headers()), []);
  assert.deepEqual(readSetCookie(undefined), []);
});

await checkAsync('nav 在 {"code":-101} 时不抛错，并按 data 归一', async () => {
  const fake = makeFakeFetch([
    SPI_ROUTE,
    {
      match: '/x/web-interface/nav',
      body: {
        code: -101,
        message: '账号未登录',
        data: {
          isLogin: false,
          uname: '',
          mid: 0,
          wbi_img: {
            img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
            sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
          },
          level_info: { current_level: 0, current_exp: 0, next_exp: 200 },
          mobile_verified: 0,
        },
      },
    },
  ]);
  const client = new BiliClient({ cookies: {}, fetchImpl: fake.impl });
  const nav = await client.nav();
  assert.equal(nav.code, -101);
  assert.equal(nav.isLogin, false);
  assert.equal(nav.uname, '');
  assert.equal(nav.mid, 0);
  assert.equal(nav.level, 0);
  assert.equal(nav.mobileVerified, false);
  assert.equal(client.wbiCache.imgKey, '7cd084941338484aae1ad9425b84077c');
  assert.equal(client.wbiCache.subKey, '4932caff0ff746eab6f01bf08b70ac45');
  const navCall = fake.calls.find((call) => call.url.includes('/x/web-interface/nav'));
  assert.ok(navCall !== undefined);
  assert.match(navCall.headers.Cookie, /buvid3=B3-FAKE/);
});

await checkAsync('request：-101 在非 raw 模式下抛 BiliError（code/payload/文案）', async () => {
  const fake = makeFakeFetch([
    SPI_ROUTE,
    { match: '/x/msgfeed/reply', body: { code: -101, message: '账号未登录', data: {} } },
  ]);
  const client = new BiliClient({ cookies: {}, fetchImpl: fake.impl });
  await assert.rejects(
    () => client.request('/x/msgfeed/reply'),
    (error) => {
      assert.ok(error instanceof BiliError);
      assert.equal(error.code, -101);
      assert.equal(error.name, 'BiliError');
      assert.equal(error.message, 'B站接口返回 -101：账号未登录（先跑 bili_login 扫码登录。）');
      assert.deepEqual(error.payload, { code: -101, message: '账号未登录', data: {} });
      return true;
    },
  );
});

await checkAsync('comments：sort=0 被服务端拒（count=0）时回退 sort=2 并带 fallback 标记', async () => {
  const calls = [];
  const impl = async (url) => {
    const text = String(url);
    const params = qs(text);
    calls.push({ url: text });
    if (text.includes('/x/frontend/finger/spi')) return makeResponse({ code: 0, data: { b_3: 'b3', b_4: 'b4' } });
    if (text.includes('/x/web-interface/view')) {
      return makeResponse({ code: 0, data: { bvid: 'BV1xx411c7mD', aid: 777, title: '测试视频' } });
    }
    if (text.includes('/x/v2/reply')) {
      if (params.get('sort') === '0') return makeResponse({ code: 0, data: { page: { count: 0 }, replies: [] } });
      return makeResponse({
        code: 0,
        data: {
          page: { count: 2, num: 1, size: 20 },
          top: { upper: { rpid: 900, mid: 1, member: { uname: 'UP主' }, content: { message: '置顶 <em>评论</em>' }, ctime: 1700000000 } },
          replies: [
            { rpid: 11, mid: 2, member: { uname: '甲' }, content: { message: '第一条' }, ctime: 1700000000, rcount: 0, like: 3 },
            {
              rpid: 12,
              mid: 3,
              root: 11,
              member: { uname: '乙' },
              content: { message: '楼中楼' },
              ctime: 1700000001,
              replies: [{ rpid: 13, mid: 4, member: { uname: '丙' }, content: { message: 'sub' }, ctime: 1700000002 }],
            },
          ],
        },
      });
    }
    throw new Error(`未预期请求：${text}`);
  };
  const client = new BiliClient({ cookies: {}, fetchImpl: impl });
  const listed = await client.comments('BV1xx411c7mD', { sort: 0, ps: 20 });
  assert.equal(listed.sortUsed, 2);
  assert.equal(listed.fallback, true);
  assert.equal(listed.aid, 777);
  assert.equal(listed.page.count, 2);
  assert.equal(listed.top.length, 1);
  assert.equal(listed.top[0].message, '置顶 评论');
  assert.equal(listed.replies.length, 2);
  assert.equal(listed.replies[0].rpid, 11);
  assert.equal(listed.replies[0].message, '第一条');
  assert.equal(listed.replies[0].ctime, '2023-11-15 06:13');
  assert.equal(listed.replies[0].uname, '甲');
  assert.equal(listed.replies[0].like, 3);
  assert.equal(listed.replies[1].replies[0].message, 'sub');
  assert.equal(listed.replies[1].url, 'https://www.bilibili.com/video/BV1xx411c7mD#reply12');
  const replyCalls = calls.filter((call) => call.url.includes('/x/v2/reply'));
  assert.equal(replyCalls.length, 2, '应当先 sort=0 再回退 sort=2');
  assert.equal(qs(replyCalls[0].url).get('sort'), '0');
  assert.equal(qs(replyCalls[0].url).get('nohot'), '1');
  assert.equal(qs(replyCalls[1].url).get('sort'), '2');
  assert.equal(qs(replyCalls[1].url).get('nohot'), '0');
  assert.equal(qs(replyCalls[1].url).get('oid'), '777');
  assert.equal(qs(replyCalls[1].url).get('type'), '1');
  assert.equal(qs(replyCalls[1].url).get('ps'), '20');
});

await checkAsync('comments：sort=0 有数据时不回退', async () => {
  let replyCalls = 0;
  const impl = async (url) => {
    const text = String(url);
    if (text.includes('/x/frontend/finger/spi')) return makeResponse({ code: 0, data: { b_3: 'b3', b_4: 'b4' } });
    if (text.includes('/x/web-interface/view')) return makeResponse({ code: 0, data: { bvid: 'BV1', aid: 5, title: 't' } });
    replyCalls += 1;
    return makeResponse({ code: 0, data: { page: { count: 1 }, replies: [{ rpid: 1, mid: 2, member: { uname: '甲' }, content: { message: 'ok' } }] } });
  };
  const client = new BiliClient({ cookies: {}, fetchImpl: impl });
  const listed = await client.comments('BV1', { sort: 0 });
  assert.equal(listed.sortUsed, 0);
  assert.equal(listed.fallback, false);
  assert.equal(replyCalls, 1);
});

await checkAsync('ensureBuvid：Set-Cookie 里的 buvid3/buvid4 通过 onCookies 交出来', async () => {
  const fake = makeFakeFetch([
    {
      match: '/x/frontend/finger/spi',
      body: { code: 0, data: { b_3: 'BUV3-ABC', b_4: 'BUV4-DEF' } },
      setCookie: ['buvid3=BUV3-ABC; Path=/; Domain=.bilibili.com', 'buvid4=BUV4-DEF; Path=/; Domain=.bilibili.com'],
    },
  ]);
  const seen = [];
  const client = new BiliClient({ cookies: {}, fetchImpl: fake.impl, onCookies: (cookies) => seen.push(cookies) });
  await client.ensureBuvid();
  assert.equal(seen.length, 1, `onCookies 应被调用 1 次，实际 ${seen.length}`);
  assert.equal(seen[0].buvid3, 'BUV3-ABC');
  assert.equal(seen[0].buvid4, 'BUV4-DEF');
  assert.equal(client.cookies.buvid3, 'BUV3-ABC');
  assert.equal(client.cookies.buvid4, 'BUV4-DEF');
  assert.equal(client.session.anonymousFingerprint, true);
  // 指纹来自 body.data.b_3/b_4（源文件行为），不是 Set-Cookie
  assert.equal(fake.calls[0].headers.Referer, 'https://www.bilibili.com/');
  assert.match(fake.calls[0].headers['User-Agent'], /^Mozilla\/5\.0/);
});

await checkAsync('已有 buvid3 时 ensureBuvid 直接返回（一次请求都不发）', async () => {
  const fake = makeFakeFetch([]);
  const seen = [];
  const client = new BiliClient({ cookies: { buvid3: 'EXISTING' }, fetchImpl: fake.impl, onCookies: (c) => seen.push(c) });
  await client.ensureBuvid();
  assert.equal(fake.calls.length, 0);
  assert.equal(client.cookies.buvid3, 'EXISTING');
  await client.ensureBuvid();
  assert.equal(fake.calls.length, 0, '第二次调用也不应发请求');
  assert.equal(seen.length, 0);
});

await checkAsync('request 把响应 Set-Cookie 合并进 cookie 并通过 onCookies 回调', async () => {
  const fake = makeFakeFetch([
    SPI_ROUTE,
    {
      match: '/x/web-interface/popular',
      body: { code: 0, data: { list: [] } },
      setCookie: ['b_nut=1700000000; Path=/; Expires=Wed, 20 May 2026 12:00:00 GMT', 'buvid_fp=abcdef; Path=/'],
    },
  ]);
  const seen = [];
  const client = new BiliClient({ cookies: { SESSDATA: 's' }, fetchImpl: fake.impl, onCookies: (c) => seen.push(c) });
  await client.request('/x/web-interface/popular', { params: { ps: 12, pn: 1 } });
  assert.equal(client.cookies.b_nut, '1700000000');
  assert.equal(client.cookies.buvid_fp, 'abcdef');
  // onCookies 会被叫两次，这是正确行为、不是 bug：
  //   第 1 次来自 request → ensureBuvid（指纹来自 body.data.b_3/b_4，源文件在此处 saveSession）
  //   第 2 次来自本次响应 Set-Cookie 的合并（b_nut / buvid_fp）
  assert.equal(seen.length, 2, `onCookies 应被调用 2 次，实际 ${seen.length}：${JSON.stringify(seen)}`);
  assert.equal(seen[0].buvid3, 'B3-FAKE', '第 1 次是 SPI 指纹');
  assert.equal(seen[0].buvid_fp, undefined, '第 1 次还不该有响应 Set-Cookie 的字段');
  const last = seen[seen.length - 1];
  assert.equal(last.buvid_fp, 'abcdef', '第 2 次要带上响应 Set-Cookie 解析出的 buvid_fp');
  assert.equal(last.b_nut, '1700000000');
  assert.equal(last.SESSDATA, 's', '原有登录 cookie 不能被覆盖掉');
  assert.equal(last.buvid3, 'B3-FAKE', 'SPI 指纹不能被响应 Set-Cookie 冲掉');
});

await checkAsync('setCookies 手动合并也会通知 onCookies', async () => {
  const seen = [];
  const client = new BiliClient({ cookies: {}, fetchImpl: async () => makeResponse({}), onCookies: (c) => seen.push(c) });
  client.setCookies({ buvid3: 'X' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].buvid3, 'X');
});

await checkAsync('popular / ranking / search 的请求 URL 与返回形状', async () => {
  const fake = makeFakeFetch([
    SPI_ROUTE,
    {
      match: '/x/web-interface/nav',
      body: {
        code: 0,
        data: {
          isLogin: true,
          wbi_img: {
            img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
            sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
          },
        },
      },
    },
    {
      match: '/x/web-interface/popular',
      body: {
        code: 0,
        data: {
          list: [
            {
              bvid: 'BVpop',
              aid: 1,
              title: '<em>热门</em>视频',
              owner: { name: 'UP', mid: 9 },
              stat: { view: 100, like: 5 },
              duration: 125,
              rcmd_reason: { content: '因为你爱看' },
            },
          ],
        },
      },
    },
    { match: '/x/web-interface/ranking/v2', body: { code: 0, data: { list: [{ bvid: 'BVrank', aid: 2, title: '排行', owner: { name: 'UP2' } }] } } },
    {
      match: '/x/web-interface/wbi/search/type',
      body: {
        code: 0,
        data: {
          result: [
            {
              bvid: 'BVsearch',
              aid: 3,
              id: 3,
              title: '<em>搜索</em>结果',
              author: 'UP3',
              mid: 4,
              play: 42,
              video_review: 7,
              duration: '7:5',
              pubdate: 1700000000,
              description: '描述 <b>加粗</b>',
              tag: 'a,b,',
              arcurl: 'https://x',
            },
          ],
        },
      },
    },
    { match: '/x/web-interface/wbi/index/top/feed/rcmd', body: { code: 0, data: { item: [{ bvid: 'BVrcmd', aid: 4, title: '推荐', owner: { name: 'UP4' }, duration: 30 }] } } },
  ]);
  const client = new BiliClient({ cookies: {}, fetchImpl: fake.impl });

  const popular = await client.popular(12, 1);
  assert.equal(popular.length, 1);
  assert.equal(popular[0].title, '热门视频');
  assert.equal(popular[0].author, 'UP');
  assert.equal(popular[0].mid, 9);
  assert.equal(popular[0].duration, '2:05');
  assert.equal(popular[0].view, 100);
  assert.equal(popular[0].rcmdReason, '因为你爱看');
  assert.equal(popular[0].url, 'https://www.bilibili.com/video/BVpop');

  const ranking = await client.ranking();
  assert.equal(ranking[0].bvid, 'BVrank');

  const rcmd = await client.rcmd(12);
  assert.equal(rcmd[0].bvid, 'BVrcmd');
  assert.equal(rcmd[0].duration, '0:30');

  const search = await client.search('鲸鱼');
  assert.equal(search[0].title, '搜索结果');
  assert.equal(search[0].duration, '7:05');
  assert.equal(search[0].play, 42);
  assert.equal(search[0].view, 42);
  assert.equal(search[0].danmaku, 7);
  assert.deepEqual(search[0].tags, ['a', 'b']);
  assert.equal(search[0].description, '描述 加粗');
  assert.equal(search[0].url, 'https://www.bilibili.com/video/BVsearch');

  const searchCall = fake.calls.find((call) => call.url.includes('/wbi/search/type'));
  assert.match(searchCall.url, /w_rid=[0-9a-f]{32}/);
  assert.match(searchCall.url, /wts=\d+/);
  assert.equal(qs(searchCall.url).get('keyword'), '鲸鱼');
  assert.equal(searchCall.headers.Referer, `https://search.bilibili.com/all?keyword=${encodeURIComponent('鲸鱼')}`);
  const popularCall = fake.calls.find((call) => call.url.includes('/x/web-interface/popular'));
  assert.equal(qs(popularCall.url).get('ps'), '12');
  assert.equal(qs(popularCall.url).get('pn'), '1');
});

await checkAsync('commentAdd / threadReplies / msgReplies / video / tags', async () => {
  const fake = makeFakeFetch([
    SPI_ROUTE,
    {
      match: '/x/web-interface/view',
      body: {
        code: 0,
        data: {
          bvid: 'BV1',
          aid: 5,
          title: 't',
          desc: 'd',
          owner: { name: 'u', mid: 6 },
          tname: '生活',
          duration: 65,
          stat: { view: 1, like: 2, coin: 3, favorite: 4, reply: 7, danmaku: 8 },
          pages: [{ page: 1, part: 'P1', duration: 65 }],
        },
      },
    },
    { match: '/x/tag/archive/tags', body: { code: 0, data: [{ tag_name: '标签一' }, { tag_name: 42 }, { tag_name: '标签二' }] } },
    { match: '/x/v2/reply/add', method: 'POST', body: { code: 0, data: { reply: { rpid: 555 } } } },
    {
      match: '/x/v2/reply/reply',
      body: {
        code: 0,
        data: {
          root: { rpid: 1, mid: 2, member: { uname: '甲' }, content: { message: 'root' } },
          replies: [{ rpid: 9, mid: 3, member: { uname: '乙' }, content: { message: 'lzl' } }],
          page: { count: 3 },
        },
      },
    },
    {
      match: '/x/msgfeed/reply',
      body: {
        code: 0,
        data: {
          items: [
            {
              id: 1,
              user: { mid: 42, nickname: '路人' },
              // 真实形状：source_content 是对方说的，root_reply_content（= title）是她自己原来那条。
              item: { business: '评论', subject_id: 5, source_id: 8, title: '人家原话', root_reply_content: '人家原话', source_content: '原话' },
              reply: { rpid: 8, oid: 5, ctime: 1700000000, content: { message: '回复你' } },
            },
          ],
          cursor: { id: 99 },
          last_view_at: 1700000000,
        },
      },
    },
  ]);
  const client = new BiliClient({ cookies: { SESSDATA: 's', bili_jct: 'j' }, fetchImpl: fake.impl });

  const detail = await client.video('BV1');
  assert.equal(detail.duration, '1:05');
  assert.equal(detail.pages[0].part, 'P1');
  assert.equal(detail.url, 'https://www.bilibili.com/video/BV1');
  assert.equal(detail.author, 'u');
  assert.deepEqual(await client.tags('BV1'), ['标签一', '标签二']);

  const created = await client.commentAdd({ aid: 5, message: '你好', root: 1, parent: 8, bvid: 'BV1' });
  assert.equal(created.rpid, 555);
  const addCall = fake.calls.find((call) => call.url.includes('/x/v2/reply/add'));
  assert.equal(addCall.method, 'POST');
  assert.equal(addCall.body.type, '1');
  assert.equal(addCall.body.oid, '5');
  assert.equal(addCall.body.csrf, 'j');
  assert.equal(addCall.body.root, '1');
  assert.equal(addCall.body.parent, '8');
  assert.equal(addCall.body.plat, '1');
  assert.equal(addCall.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(addCall.headers.Referer, 'https://www.bilibili.com/video/BV1');

  const thread = await client.threadReplies({ aid: 5, root: 1, bvid: 'BV1' });
  assert.equal(thread.count, 3);
  assert.equal(thread.root.message, 'root');
  assert.equal(thread.replies[0].rpid, 9);

  const inbox = await client.msgReplies({ ps: 20 });
  assert.equal(inbox.code, 0);
  assert.equal(inbox.items[0].mid, 42);
  assert.equal(inbox.items[0].uname, '路人');
  assert.equal(inbox.items[0].message, '回复你');
  assert.equal(inbox.items[0].myMessage, '人家原话', 'myMessage 取 root_reply_content（她自己原来那条）');
  assert.equal(inbox.items[0].subject, '', 'title 是「被回复的评论」，不该当 subject');
  assert.equal(inbox.items[0].aid, 5, '视频 oid 取 subject_id');
  assert.equal(inbox.items[0].rpid, 8, 'rpid 取 source_id（对方那条评论）');
  assert.equal(inbox.items[0].root, 8);
  assert.equal(inbox.items[0].ctime, '2023-11-15 06:13');
  assert.equal(inbox.items[0].ts, 1700000000000);
  assert.equal(inbox.cursor.id, 99);
  assert.equal(inbox.lastViewAt, 1700000000);
});

await checkAsync('dynamicCreate：JSON 体 + csrf 参数 + t.bilibili.com referer', async () => {
  const fake = makeFakeFetch([
    SPI_ROUTE,
    { match: '/x/dynamic/feed/create/dyn', method: 'POST', body: { code: 0, data: { dyn_id_str: 'DYN-1' } } },
  ]);
  const client = new BiliClient({ cookies: { SESSDATA: 's', bili_jct: 'j' }, fetchImpl: fake.impl });
  const created = await client.dynamicCreate('今天也在学习');
  assert.equal(created.dyn_id_str, 'DYN-1');
  const call = fake.calls.find((c) => c.url.includes('/x/dynamic/feed/create/dyn'));
  assert.equal(call.headers['Content-Type'], 'application/json');
  assert.equal(call.headers.Referer, 'https://t.bilibili.com/');
  assert.equal(qs(call.url).get('csrf'), 'j');
  assert.equal(qs(call.url).get('platform'), 'web');
  assert.equal(call.body.dyn_req.content.contents[0].raw_text, '今天也在学习');
  assert.equal(call.body.dyn_req.content.contents[0].type, 1);
  assert.equal(call.body.dyn_req.scene, 1);
  assert.equal(call.body.dyn_req.meta.app_meta.mobi_app, 'web');
});

await checkAsync('csrf 缺失时抛 BiliError(-101) 且文案一致', async () => {
  const client = new BiliClient({ cookies: {}, fetchImpl: async () => makeResponse({}) });
  assert.equal(client.canWrite(), false);
  await assert.rejects(
    () => client.commentAdd({ aid: 1, message: 'x' }),
    (error) => {
      assert.ok(error instanceof BiliError);
      assert.equal(error.code, -101);
      assert.equal(error.message, 'B站接口返回 -101：缺少 bili_jct，无法执行写操作：先跑 bili_login（扫码）。');
      return true;
    },
  );
});

await checkAsync('响应不是 JSON 时抛 BiliError(-1) 并带上 HTTP 状态', async () => {
  const client = new BiliClient({ cookies: {}, fetchImpl: async () => makeResponse('<html>风控</html>', 412) });
  await assert.rejects(
    () => client.request('/x/web-interface/nav', { raw: true, skipBuvid: true }),
    (error) => {
      assert.equal(error.code, -1);
      assert.match(error.message, /响应不是 JSON（HTTP 412）/);
      return true;
    },
  );
});

await checkAsync('raw 模式返回 { body, setCookie, status } 且不抛业务错误', async () => {
  const client = new BiliClient({
    cookies: {},
    fetchImpl: async () => makeResponse({ code: -404, message: '啥都没有', data: null }, 200, ['buvid3=Z; Path=/']),
  });
  const raw = await client.request('/x/whatever', { raw: true, skipBuvid: true });
  assert.equal(raw.status, 200);
  assert.equal(raw.body.code, -404);
  assert.deepEqual(raw.setCookie, ['buvid3=Z; Path=/']);
});

await checkAsync('qrGenerate / qrPoll 形状不变（poll 的 cookie 来自 Set-Cookie）', async () => {
  const fake = makeFakeFetch([
    SPI_ROUTE,
    { match: 'qrcode/generate', body: { code: 0, data: { url: 'https://passport.bilibili.com/h5/...', qrcode_key: 'KEY-1' } } },
    {
      match: 'qrcode/poll',
      body: { code: 0, data: { code: 0, message: 'ok', url: 'https://x' } },
      setCookie: ['SESSDATA=NEW; Path=/; Domain=.bilibili.com', 'bili_jct=NEWJ; Path=/; Domain=.bilibili.com'],
    },
  ]);
  const client = new BiliClient({ cookies: {}, fetchImpl: fake.impl });
  const qr = await client.qrGenerate();
  assert.deepEqual(qr, { url: 'https://passport.bilibili.com/h5/...', qrcodeKey: 'KEY-1' });
  const polled = await client.qrPoll('KEY-1');
  assert.equal(polled.code, 0);
  assert.equal(polled.message, 'ok');
  assert.deepEqual(polled.cookies, { SESSDATA: 'NEW', bili_jct: 'NEWJ' });
  const poll = fake.calls.find((call) => call.url.includes('qrcode/poll'));
  assert.ok(poll !== undefined, `没找到 poll 请求：${fake.calls.map((call) => call.url).join(', ')}`);
  assert.equal(qs(poll.url).get('qrcode_key'), 'KEY-1');
  assert.match(String(poll.headers.Cookie ?? ''), /buvid3=/);
});

// ─────────────────────────────────────────────────────────────
section('6. 判定对拍：同一份账本 + 同一份配置，新 policy/ledger 必须等于 lib 的实现');

const DIFF_CFG = {
  ownerMid: 4242,
  ownerName: '懒寻真',
  policy: {
    postVideoComment: 'confirm',
    postReply: 'confirm',
    postDynamic: 'confirm',
    ownerUnlimited: true,
    replyPerUserPerThread: 1,
    replyPerUserWindowHours: 24,
    dailyVideoComments: 3,
    dailyReplies: 10,
    dailyDynamics: 1,
    minIntervalSeconds: 120,
    minIntervalSecondsOwner: 15,
    maxCommentChars: 20,
    blockKeywords: ['加群', '刷单'],
    dedupePerVideo: true,
  },
};

/** 生成一份 cfg（在 DIFF_CFG 基础上打补丁）。 */
function diffCfg(policyPatch = {}) {
  return { ...DIFF_CFG, policy: { ...DIFF_CFG.policy, ...policyPatch } };
}

/** 用源文件的 ledger 记录函数造一份两边共用的账本。 */
function seededLedger(seed) {
  const ledger = oldLedger.emptyLedger();
  if (typeof seed === 'function') seed(ledger);
  return ledger;
}

const TODAY = oldLedger.dateKey();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * 判定结果对拍：源文件的键必须全在、且逐字段相等；
 * 新实现允许比源文件多出文档里声明的键（固定接口要求三处都返回 warnings）。
 */
const DECLARED_EXTRA_KEYS = ['warnings'];

function assertSameDecision(label, mine, theirs) {
  const missing = Object.keys(theirs).filter((key) => !(key in mine));
  const extra = Object.keys(mine).filter((key) => !(key in theirs));
  assert.deepEqual(missing, [], `${label}：新实现缺少源文件的字段`);
  assert.deepEqual(
    extra.filter((key) => !DECLARED_EXTRA_KEYS.includes(key)),
    [],
    `${label}：新实现多出未声明的字段`,
  );
  for (const key of Object.keys(theirs)) {
    assert.deepEqual(
      mine[key],
      theirs[key],
      `${label}：字段 ${key} 不一致\n  新 ${JSON.stringify(mine[key])}\n  源 ${JSON.stringify(theirs[key])}`,
    );
  }
}

check('isOwner：新 (mid, cfg) 与源 (cfg, { mid, uname }) 判定一致', () => {
  const cfg = diffCfg();
  const cases = [
    { mid: 0, uname: '' },
    { mid: 4242, uname: '随便' },
    { mid: 4243, uname: '懒寻真' },
    { mid: 0, uname: '懒寻真' },
  ];
  for (const target of cases) {
    // 指定签名（第一参是 mid 数字）只能看 UID，所以用「只靠 UID 判定」的形态对拍；
    // 源文件的昵称分支通过 isOwner 的目标对象兼容形式对拍。
    assert.equal(
      isOwner(target.mid, cfg),
      oldPolicy.isOwner(cfg, { mid: target.mid, uname: '' }),
      `isOwner(${target.mid}, cfg) 与源文件（只看 UID）不一致`,
    );
    assert.equal(
      isOwner(target, cfg),
      oldPolicy.isOwner(cfg, target),
      `isOwner({ mid: ${target.mid}, uname: '${target.uname}' }, cfg) 与源文件不一致`,
    );
  }
  // 未配置 ownerMid 时，源文件只认 uname
  const noMid = diffCfg();
  noMid.ownerMid = null;
  assert.equal(isOwner(4242, noMid), oldPolicy.isOwner(noMid, { mid: 4242, uname: '' }));
  assert.equal(isOwner({ mid: 1, uname: '懒寻真' }, noMid), oldPolicy.isOwner(noMid, { mid: 1, uname: '懒寻真' }));
  assert.equal(isOwner(1, noMid), oldPolicy.isOwner(noMid, { mid: 1, uname: '' }));
});

const VIDEO_DIFF_CASES = [
  { label: 'off 模式', cfg: diffCfg({ postVideoComment: 'off' }), message: 'hi' },
  { label: '空内容', message: '   ' },
  { label: '超字数', message: 'x'.repeat(21) },
  { label: '屏蔽词', message: '来加群 一起玩' },
  { label: '去重命中', seed: (l) => oldLedger.recordComment(l, { bvid: 'BV1', aid: 1, rpid: 1, text: 'x' }), message: 'hi' },
  { label: '每日上限', seed: (l) => { l.daily[TODAY] = { videoComments: 3, replies: 0, dynamics: 0 }; }, message: 'hi' },
  { label: '最小间隔（普通）', seed: (l) => { l.lastActionTs = Date.now() - 5 * 1000; }, message: 'hi' },
  { label: '最小间隔（主人 15s）', seed: (l) => { l.lastActionOwnerTs = Date.now() - 5 * 1000; }, message: 'hi', confirm: true, owner: true },
  { label: '主人已过 20s 可发', seed: (l) => { l.lastActionOwnerTs = Date.now() - 20 * 1000; }, message: 'hi', confirm: true, owner: true },
  { label: 'confirm 已点头 → 放行', message: 'hi', confirm: true },
  { label: 'auto 模式 → 放行', cfg: diffCfg({ postVideoComment: 'auto' }), message: 'hi' },
  { label: '普通间隔已过 200s 可发', seed: (l) => { l.lastActionTs = Date.now() - 200 * 1000; }, message: 'hi', confirm: true },
];

for (const item of VIDEO_DIFF_CASES) {
  check(`checkVideoComment 对拍 —— ${item.label}`, () => {
    const cfg = item.cfg ?? diffCfg();
    const ledger = seededLedger(item.seed);
    const mine = checkVideoComment({ cfg, ledger, bvid: 'BV1', message: item.message, confirm: item.confirm === true });
    const theirs = oldPolicy.checkVideoComment({
      cfg,
      ledger,
      video: { bvid: 'BV1' },
      message: item.message,
      confirm: item.confirm === true,
    });
    assertSameDecision('与 lib/policy.js 对拍', mine, theirs);
  });
}

const REPLY_DIFF_CASES = [
  { label: 'off 模式', cfg: diffCfg({ postReply: 'off' }), message: 'hi' },
  { label: '空内容', message: '' },
  { label: '超字数（源文件此处不带「防刷屏」后缀，注意与视频评论的差别）', message: 'x'.repeat(21) },
  { label: '屏蔽词', message: '刷单吗' },
  { label: '不回自己', message: 'hi', selfMid: 7 },
  { label: 'replyScope=owner-only 拦普通人', cfg: diffCfg({ replyScope: 'owner-only' }), message: 'hi' },
  { label: '每人每串上限', seed: (l) => oldLedger.recordReply(l, { bvid: 'BV1', aid: 1, rpid: 5, root: 5, targetMid: 7, targetUname: '甲', text: 'x' }), message: 'hi' },
  { label: '24 小时窗口（另一条串）', seed: (l) => oldLedger.recordReply(l, { bvid: 'BV1', aid: 1, rpid: 6, root: 6, targetMid: 7, targetUname: '甲', text: 'x' }), root: 900, message: 'hi' },
  { label: '主人豁免 + 警告', message: 'hi', toMid: 4242, toName: '懒寻真', confirm: true },
  { label: '每日回复上限', seed: (l) => { l.daily[TODAY] = { videoComments: 0, replies: 10, dynamics: 0 }; }, message: 'hi' },
  { label: '最小间隔（主人 15s）', seed: (l) => { l.lastActionOwnerTs = Date.now() - 5 * 1000; }, toMid: 4242, toName: '懒寻真', message: 'hi', confirm: true },
  { label: 'confirm 未点头', message: 'hi' },
  { label: 'auto 模式放行', cfg: diffCfg({ postReply: 'auto' }), message: 'hi' },
  // rootRpid 的两种回退：root>0 直接用 root；root=0 时源文件回退到 target.rpid
  { label: 'root=0 → rootRpid 回退到 rpid', root: 0, rpid: 99, message: 'hi' },
  { label: 'root=0 且没给 rpid → rootRpid 与源文件一样是 undefined', root: 0, noRpid: true, message: 'hi' },
];

for (const item of REPLY_DIFF_CASES) {
  check(`checkReply 对拍 —— ${item.label}`, () => {
    const cfg = item.cfg ?? diffCfg();
    const ledger = seededLedger(item.seed);
    const root = item.root ?? 5;
    const toMid = item.toMid ?? 7;
    const toName = item.toName ?? '甲';
    const rpid = item.noRpid === true ? undefined : (item.rpid ?? root);
    const mine = checkReply({
      cfg,
      ledger,
      bvid: 'BV1',
      root,
      rpid,
      message: item.message,
      toMid,
      toName,
      confirm: item.confirm === true,
      selfMid: item.selfMid ?? null,
    });
    const theirs = oldPolicy.checkReply({
      cfg,
      ledger,
      target: { root, rpid, mid: toMid, uname: toName },
      message: item.message,
      confirm: item.confirm === true,
      selfMid: item.selfMid ?? null,
    });
    assertSameDecision('与 lib/policy.js 对拍', mine, theirs);
  });
}

const DYNAMIC_DIFF_CASES = [
  { label: 'off 模式', cfg: diffCfg({ postDynamic: 'off' }), text: 'hi' },
  { label: '空内容', text: '  ' },
  { label: '超 2000 字', text: 'x'.repeat(2001) },
  { label: '今日已发（auto）', seed: (l) => oldLedger.recordDynamic(l, { text: 'x' }), text: 'hi', auto: true },
  { label: '今日已发（非 auto）', seed: (l) => oldLedger.recordDynamic(l, { text: 'x' }), text: 'hi' },
  { label: '每日上限', seed: (l) => { l.daily[TODAY] = { videoComments: 0, replies: 0, dynamics: 1 }; }, text: 'hi' },
  { label: 'confirm 未点头', text: 'hi' },
  { label: 'auto 放行', cfg: diffCfg({ postDynamic: 'auto' }), text: 'hi', auto: true },
  { label: 'auto 模式但调用方没传 auto', cfg: diffCfg({ postDynamic: 'auto' }), text: 'hi' },
  { label: '命中屏蔽词', text: '来加群玩' },
  { label: 'len(2000) 边界不算超', text: 'x'.repeat(2000) },
  { label: 'auto 已点头 + 今日已发（既要 reason 也不 needsConfirm）', seed: (l) => oldLedger.recordDynamic(l, { text: 'x' }), text: 'hi', auto: true, confirm: true },
];

for (const item of DYNAMIC_DIFF_CASES) {
  check(`checkDynamic 对拍 —— ${item.label}`, () => {
    const cfg = item.cfg ?? diffCfg();
    const ledger = seededLedger(item.seed);
    const mine = checkDynamic({ cfg, ledger, text: item.text, confirm: item.confirm === true, auto: item.auto === true });
    const theirs = oldPolicy.checkDynamic({ cfg, ledger, text: item.text, confirm: item.confirm === true, auto: item.auto === true });
    assertSameDecision('与 lib/policy.js 对拍', mine, theirs);
  });
}

check('账本查询对拍：lib/ledger.js 记出来的账本，新实现读到的数一样', () => {
  const book = oldLedger.emptyLedger();
  oldLedger.recordComment(book, { bvid: 'BVx', aid: 9, rpid: 11, text: 'a' });
  oldLedger.recordReply(book, { bvid: 'BVx', aid: 9, rpid: 12, root: 11, targetMid: 7, targetUname: '甲', text: 'b' });
  oldLedger.recordReply(book, { bvid: 'BVx', aid: 9, rpid: 13, root: 11, targetMid: 8, targetUname: '乙', text: 'c', isOwner: true });
  oldLedger.recordDynamic(book, { text: 'd', dynId: 'D1' });
  assert.deepEqual(
    ledger.commentedVideo(book, 'BVx'),
    oldLedger.commentedVideo(book, 'BVx'),
    'commentedVideo 返回的整条记录必须与源文件一致（含 bvid/aid/rpid）',
  );
  assert.equal(ledger.commentedVideo(book, 'BVx').bvid, 'BVx');
  assert.equal(ledger.commentedVideo(book, 'BVnope'), null);
  assert.equal(ledger.commentedVideo(book, ''), null);
  assert.equal(ledger.threadReplyCount(book, 11, 7), oldLedger.threadReplyCount(book, 11, 7));
  assert.equal(ledger.threadReplyCount(book, 11, 8), oldLedger.threadReplyCount(book, 11, 8));
  assert.equal(ledger.lastReplyTsForUser(book, 7), oldLedger.lastReplyTsForUser(book, 7));
  assert.equal(ledger.lastReplyTsForUser(book, 999), oldLedger.lastReplyTsForUser(book, 999));
  assert.equal(ledger.lastReplyTsForUser(book, 999), 0);
  assert.deepEqual(ledger.todayCounts(book), oldLedger.todayCounts(book));
  assert.equal(ledger.dynamicPostedToday(book), oldLedger.dynamicPostedToday(book));
  assert.equal(ledger.dateKey(new Date(1700000000000)), oldLedger.dateKey(new Date(1700000000000)));
  // 记录函数写出来的字段也要与源文件一致：冻结时钟后整本账本必须 deepEqual
  const mineBook = ledger.createLedger();
  const oldBook = oldLedger.emptyLedger();
  withFrozenClock(1_700_000_000, () => {
    for (const book of [mineBook]) {
      ledger.recordComment(book, { bvid: 'BVx', aid: 9, rpid: 11, text: 'a' });
      ledger.recordReply(book, { bvid: 'BVx', aid: 9, rpid: 12, root: 11, targetMid: 7, targetUname: '甲', text: 'b' });
      ledger.recordReply(book, { bvid: 'BVx', aid: 9, rpid: 13, root: 11, targetMid: 8, targetUname: '乙', text: 'c', isOwner: true });
      ledger.recordDynamic(book, { text: 'd', dynId: 'D1' });
      ledger.pushMaterial(book, '素材一');
      ledger.pushMaterial(book, '素材二');
    }
    for (const book of [oldBook]) {
      oldLedger.recordComment(book, { bvid: 'BVx', aid: 9, rpid: 11, text: 'a' });
      oldLedger.recordReply(book, { bvid: 'BVx', aid: 9, rpid: 12, root: 11, targetMid: 7, targetUname: '甲', text: 'b' });
      oldLedger.recordReply(book, { bvid: 'BVx', aid: 9, rpid: 13, root: 11, targetMid: 8, targetUname: '乙', text: 'c', isOwner: true });
      oldLedger.recordDynamic(book, { text: 'd', dynId: 'D1' });
      oldLedger.pushMaterial(book, '素材一');
      oldLedger.pushMaterial(book, '素材二');
    }
  });
  assert.deepEqual(mineBook, oldBook, '同一串记录操作后，账本必须与源文件逐字段一致');
  assert.deepEqual(ledger.takeMaterial(mineBook), oldLedger.takeMaterial(oldBook), 'takeMaterial 的返回必须一致');
  assert.deepEqual(mineBook, oldBook, 'takeMaterial 之后也要一致');
});

// ─────────────────────────────────────────────────────────────
section('7. 约束自检：cloudflare/src 不得出现 node: / require / 第三方依赖');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && full.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * 剥掉注释再扫描。
 * 移植说明里会写「源文件用 node:crypto」「WebCrypto（crypto.subtle）不支持 MD5」这类
 * **解释性文字**，纯文本 grep 会把它们误判成依赖；判定必须只看真实代码。
 * `https://` 里的 `//` 不算注释（前一个字符是 `:`）。
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => {
      const index = line.indexOf('//');
      if (index === -1) return line;
      return line[index - 1] === ':' ? line : line.slice(0, index);
    })
    .join('\n');
}

const allSourceFiles = walk(SRC_DIR);
const portedSourceFiles = allSourceFiles.filter((file) => PORTED_FILES.includes(file.split(/[\\/]/).pop()));
/** 本次移植之外的既有文件（不属于交付范围，只报告不判定）。 */
const foreignSourceFiles = allSourceFiles.filter((file) => !PORTED_FILES.includes(file.split(/[\\/]/).pop()));

check(`移植文件齐全（${PORTED_FILES.join(' / ')}）`, () => {
  assert.deepEqual(
    portedSourceFiles.map((file) => relative(CLOUDFLARE_DIR, file)).sort(),
    PORTED_FILES.map((name) => join('src', name)).sort(),
  );
});

check('cloudflare/src/{md5,wbi,bili,ledger,policy}.js 无 node: 模块导入', () => {
  const offenders = [];
  for (const file of portedSourceFiles) {
    const text = stripComments(readFileSync(file, 'utf8'));
    for (const [index, line] of text.split('\n').entries()) {
      // 只抓真正的模块说明符（注释里提到 node:crypto 说明差异不算导入）
      const hit = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"](node:|crypto|fs|path|os|url|http|https|stream|buffer|child_process)['"]/.exec(line);
      if (hit !== null) offenders.push(`${relative(CLOUDFLARE_DIR, file)}:${index + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], `发现 Node 内置模块导入：\n${offenders.join('\n')}`);
});

check('cloudflare/src/{md5,wbi,bili,ledger,policy}.js 无 require / process / Buffer / __dirname', () => {
  const offenders = [];
  for (const file of portedSourceFiles) {
    const text = stripComments(readFileSync(file, 'utf8'));
    for (const [index, line] of text.split('\n').entries()) {
      if (/\brequire\s*\(/.test(line) || /\bprocess\./.test(line) || /\bBuffer\b/.test(line) || /__dirname/.test(line)) {
        offenders.push(`${relative(CLOUDFLARE_DIR, file)}:${index + 1}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `发现 Node 专有全局：\n${offenders.join('\n')}`);
});

check('cloudflare/src/{md5,wbi,bili,ledger,policy}.js 只从相对路径 import（零第三方依赖）', () => {
  const offenders = [];
  for (const file of portedSourceFiles) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/^\s*(?:import|export)[^\n]*?from\s+['"]([^'"]+)['"]/gm)) {
      const spec = match[1];
      if (!spec.startsWith('./') && !spec.startsWith('../')) offenders.push(`${relative(CLOUDFLARE_DIR, file)}: ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], `发现非相对 import：\n${offenders.join('\n')}`);
});

check('md5.js 是纯 JS 实现（不依赖 crypto.subtle 做摘要）', () => {
  const raw = readFileSync(join(SRC_DIR, 'md5.js'), 'utf8');
  assert.equal(/^\s*import[^\n]*['"]node:/m.test(raw), false, 'md5.js 不得 import node: 模块');
  // 文件头的注释会解释「Workers 的 WebCrypto（crypto.subtle）不支持 MD5」——
  // 那是说明文字，判定要看剥掉注释后的真实代码。
  const code = stripComments(raw);
  assert.equal(/crypto\s*\.\s*subtle/.test(code), false, 'md5.js 的代码里出现了 crypto.subtle');
  assert.equal(/\bcrypto\b/.test(code), false, 'md5.js 的代码里不该引用 crypto 全局');
  assert.equal(/\bcreateHash\b/.test(code), false, 'md5.js 的代码里出现了 createHash');
  assert.equal(/\brequire\s*\(/.test(code), false, 'md5.js 里出现了 require');
  // 零模块依赖 + 标准 MD5 常量表内联（证明摘要算法是自己算的，不是转手给运行时）
  assert.equal(/^\s*import\b/m.test(code), false, 'md5.js 不该 import 任何模块');
  assert.equal(/^\s*export\s+[^\n]*\bfrom\b/m.test(code), false, 'md5.js 不该 re-export 别的模块');
  assert.match(code, /0xd76aa478/);
  assert.match(code, /0xeb86d391/);
  assert.match(code, /export function md5Hex/);
  assert.match(code, /export function md5Bytes/);
});

check('（信息）本次移植之外的既有文件', () => {
  // 这些文件（index.js / store.js / persona.js …）是调用方/其他工作流的产品，不属于本次 5 文件交付，
  // 因此上面的约束自检只判定 PORTED_FILES。这里只把它们列出来，方便报告里说明。
  const names = foreignSourceFiles.map((file) => relative(CLOUDFLARE_DIR, file)).sort();
  console.log(`       （不计入判定）src 下另有 ${names.length} 个既有文件：${names.join(', ') || '无'}`);
  const risky = [];
  for (const file of foreignSourceFiles) {
    const text = readFileSync(file, 'utf8');
    for (const [index, line] of text.split('\n').entries()) {
      const hit = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"](node:|crypto|fs|path|os|url)['"]/.exec(line);
      if (hit !== null) risky.push(`${relative(CLOUDFLARE_DIR, file)}:${index + 1}`);
    }
  }
  console.log(`       （不计入判定）其中带 Node 内置导入的行：${risky.join(', ') || '无'}`);
});

// ─────────────────────────────────────────────────────────────
console.log('\n──────────────────────────────────────────────');
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) {
  console.log('\n失败详情：');
  for (const { name, error } of failures) {
    console.log(`\n- ${name}`);
    console.log(String(error?.message ?? error));
  }
  process.exitCode = 1;
} else {
  console.log('全部通过 ✅');
}


