/**
 * 离线联调：拿**真的** Worker 入口（src/index.js）跑一遍，只把两个外部依赖换成假的 ——
 *   - `WHALE_KV` → Map 版假 KV（验证状态真的落盘/读回）
 *   - `globalThis.fetch` → 按端点返回锻造的 B 站 JSON（验证协议解析与策略行为）
 *
 * 四个场景：
 *   A. 匿名 + observeOnly=true（真机当前状态）：只读 + 排队，一个写请求都不许发。
 *   B. 登录 Lv3 + observeOnly=false + 有主人回复：真回主人、真发动态；视频评论被
 *      「最小间隔」挡住（刚回过一条），验证限流真的生效。
 *   C. 登录 Lv0（未转正）：不发写请求，但主人的回复「存着不丢」、动态草稿进 meta。
 *   D. 登录 Lv3 + 收件箱空：视频评论排队 → 主人点头 → 真的发出去，账本计数 +1。
 *
 * 跑：node test/patrol.mock.test.mjs
 *
 * 注意：进程时区先钉成 UTC —— Workers 运行时就是 UTC，而本机（UTC+8）跑测试时
 * 会让 ledger.dateKey 的本地字段二次平移，把「今天」算成明天。
 *
 * @module bili-whale/test/patrol.mock
 */
process.env.TZ = 'UTC';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const TOKEN = 'test-token-0123456789abcdef';
const BVID = 'BV1WYeS6YEwt';
const OWNER_MID = '3494364865103885';
const WHALE_MID = '3747560556595480';

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

/** Map 版假 KV。 */
function fakeKV() {
  const map = new Map();
  return {
    map,
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async put(key, value) {
      map.set(key, String(value));
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

const NAV_IMG = {
  img_url: 'https://i0.hdslb.com/bfs/wbi/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
  sub_url: 'https://i0.hdslb.com/bfs/wbi/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png',
};

const VIDEO_LIST_ITEM = {
  bvid: BVID,
  aid: 1001,
  title: '比豆包手机还强的大肥鱼手机！让 DeepSeek 控制手机有多丝滑？',
  owner: { name: '酸小明', mid: 11935599 },
  stat: { view: 72000, like: 2278, reply: 472, danmaku: 30 },
  tname: '科技',
  duration: 412,
  rcmd_reason: { content: '测试推荐理由' },
  pic: 'https://i0.hdslb.com/bfs/archive/test.jpg',
};

const OWNER_MESSAGE_ITEM = {
  id: 9001,
  user: { mid: Number(OWNER_MID), nickname: '懒寻真' },
  item: {
    business: 'video',
    title: '比豆包手机还强的大肥鱼手机！',
    uri: 'bilibili://video/1001',
    source_content: '小鲸鱼娘的第一条评论',
  },
  reply: { rpid: 555, oid: 1001, root: 0, parent: 0, ctime: 1791120000, content: { message: '鲸鱼娘，帮我看看这个视频？' } },
  is_multi: 0,
};

const NAV_ANONYMOUS = { code: -101, message: '账号未登录', data: { isLogin: false, wbi_img: NAV_IMG } };
const navLoggedIn = (level) => ({
  code: 0,
  data: {
    isLogin: true,
    mid: Number(WHALE_MID),
    uname: 'bili_83352132154',
    money: 0,
    level_info: { current_level: level, current_exp: 300, next_exp: 1500 },
    mobile_verified: 1,
    wbi_img: NAV_IMG,
  },
});

/** 造一个按端点分发的假 fetch，并把每次请求记进 log。 */
function mockFetch({ nav, messages = [], mentions = [], log }) {
  const routes = [
    ['/x/frontend/finger/spi', () => ({ code: 0, data: { b_3: 'BV3-FAKE', b_4: 'BV4-FAKE' } })],
    ['/x/web-interface/nav', () => nav],
    ['/x/msgfeed/reply', () => ({ code: 0, data: { items: messages, cursor: {}, last_view_at: 0 } })],
    // 「@我的」是另一个接口（巡逻现在也会读它，否则主人在评论里 @ 她没反应）。
    ['/x/msgfeed/at', () => ({ code: 0, data: { items: mentions, cursor: {} } })],
    ['/x/web-interface/wbi/index/top/feed/rcmd', () => ({ code: 0, data: { item: [VIDEO_LIST_ITEM] } })],
    ['/x/web-interface/popular', () => ({ code: 0, data: { list: [VIDEO_LIST_ITEM] } })],
    ['/x/web-interface/ranking/v2', () => ({ code: 0, data: { list: [VIDEO_LIST_ITEM] } })],
    [
      '/x/web-interface/view',
      () => ({
        code: 0,
        data: {
          bvid: BVID,
          aid: 1001,
          title: VIDEO_LIST_ITEM.title,
          desc: '测试视频简介',
          owner: { name: '酸小明', mid: 11935599 },
          tname: '科技',
          duration: 412,
          pubdate: 1791000000,
          stat: { view: 72000, like: 2278, reply: 472, danmaku: 30 },
          pages: [{ page: 1, part: '正片', duration: 412 }],
        },
      }),
    ],
    ['/x/tag/archive/tags', () => ({ code: 0, data: [{ tag_name: 'deepseek' }, { tag_name: '大肥鱼' }] })],
    ['/x/v2/reply/add', () => ({ code: 0, data: { rpid: 666, rp_id: 666 } })],
    ['/x/dynamic/feed/create/dyn', () => ({ code: 0, data: { dyn_id_str: '777888999' } })],
    ['/x/v2/reply/reply', () => ({ code: 0, data: { replies: [], page: { count: 0 } } })],
    ['/x/v2/reply', () => ({ code: 0, data: { page: { count: 0 }, replies: [] } })],
  ];
  return async (url, options = {}) => {
    const target = String(url);
    log.push({ url: target, method: options.method ?? 'GET', body: options.body ?? null });
    for (const [fragment, handler] of routes) {
      if (target.includes(fragment)) {
        const body = handler(target, options);
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    throw new Error(`假 fetch 没匹配到：${options.method ?? 'GET'} ${target}`);
  };
}

function makeEnv(kv, vars) {
  return {
    WHALE_KV: kv,
    ADMIN_TOKEN: TOKEN,
    BILI_COOKIES: JSON.stringify({ SESSDATA: 'fake-sess', bili_jct: 'fake-jct', DedeUserID: WHALE_MID, buvid3: 'BV3-FAKE', buvid4: 'BV4-FAKE' }),
    ...vars,
  };
}

const BASE_VARS = {
  FEED_SOURCE: 'popular',
  TIMEZONE: 'Asia/Shanghai',
  DAILY_DYNAMIC_AT: '00:00',
  POST_VIDEO_COMMENT: 'confirm',
  POST_REPLY: 'auto',
  POST_DYNAMIC: 'auto',
  OWNER_MID,
  WHALE_MID,
};

function call(env, path, { method = 'GET', body, token = TOKEN } = {}) {
  const headers = {};
  if (token !== null) headers['x-whale-token'] = token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const request = new Request(`https://bili-whale.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return worker.fetch(request, env, { waitUntil: () => {} });
}

/** 取出所有 POST 到某端点的请求。 */
const postedTo = (log, fragment) => log.filter((item) => item.url.includes(fragment) && item.method === 'POST');

/** 客户端写请求用的是表单体（不是 JSON），统一解析成对象。 */
function formOf(entry) {
  const raw = String(entry?.body ?? '');
  if (raw.trim().startsWith('{')) return JSON.parse(raw);
  return Object.fromEntries(new URLSearchParams(raw));
}

/** 跑一次 scheduled 并等它真的结束（waitUntil 的 promise 要自己接住）。 */
async function runScheduled(env) {
  let pending = null;
  await worker.scheduled({}, env, { waitUntil: (promise) => { pending = promise; } });
  if (pending !== null) await pending;
}

// ── 场景 A：匿名 + 观察模式（真机当前状态） ──────────────────────────────────
{
  const kv = fakeKV();
  const log = [];
  const env = makeEnv(kv, { ...BASE_VARS, OBSERVE_ONLY: 'true' });
  globalThis.fetch = mockFetch({ nav: NAV_ANONYMOUS, log });

  const health = await (await call(env, '/health', { token: null })).json();
  check('A: /health 免鉴权可用', () => assert.equal(health.ok, true));

  const denied = await call(env, '/status', { token: 'wrong-token' });
  check('A: 令牌不对 → 401', () => assert.equal(denied.status, 401));

  const status = await (await call(env, '/status')).json();
  check('A: /status 读出观察模式与未登录', () => {
    assert.equal(status.ok, true);
    assert.equal(status.observeOnly, true);
    assert.equal(status.loggedIn, false);
    assert.equal(status.canWrite, false);
    assert.equal(status.policies.postVideoComment, 'confirm');
  });

  const patrol = await (await call(env, '/patrol', { method: 'POST' })).json();
  check('A: 巡检排了 1 条视频评论草稿', () => assert.equal(patrol.videoComments.queued, 1));
  check('A: 巡检无错误', () => assert.deepEqual(patrol.errors, []));
  check('A: 动态因观察模式跳过', () => assert.equal(patrol.dynamic.skipped, 'observeOnly'));
  check('A: 观察模式下零写请求', () => {
    assert.equal(postedTo(log, '/x/v2/reply/add').length, 0);
    assert.equal(postedTo(log, '/x/dynamic/feed/create/dyn').length, 0);
  });

  const pending = await (await call(env, '/pending')).json();
  check('A: 队列里有草稿且是那个视频', () => {
    assert.equal(pending.count, 1);
    assert.equal(pending.pending[0].bvid, BVID);
    assert.ok(String(pending.pending[0].message).length > 0);
  });

  const approve = await call(env, '/approve', { method: 'POST', body: { id: pending.pending[0].id } });
  // 观察模式约束的是**云端自己**：主人显式点头后，草稿只做标记，真发交给本机/GitHub 手脚。
  // 曾经的 bug：这里被 409 拦死，主人点了半天 approve，草稿永远 approved:false，评论一条都发不出去。
  check('A: 观察模式不影响主人点头（200 + 标记 approved）', () => assert.equal(approve.status, 200));
  {
    const after = await (await call(env, '/pending')).json();
    check('A: 点头后草稿 approved=true 且仍未发出', () => {
      const draft = after.pending.find((item) => item.id === pending.pending[0].id);
      assert.equal(draft?.approved, true);
      assert.notEqual(draft?.posted, true);
      assert.equal(postedTo(log, '/x/v2/reply/add').length, 0);
    });
  }

  const dynamic = await call(env, '/dynamic', { method: 'POST', body: { text: '测试动态' } });
  check('A: 观察模式下发动态被拦（409）', () => assert.equal(dynamic.status, 409));

  const logBody = await (await call(env, '/log')).json();
  check('A: 云端日志记了手动巡检', () => assert.ok(logBody.log.some((line) => line.includes('patrol(manual)'))));

  await runScheduled(env);
  const afterCron = await (await call(env, '/log')).json();
  check('A: scheduled() 也能跑通并写日志', () => assert.ok(afterCron.log.some((line) => line.includes('cron：'))));
  check('A: cron 之后状态仍在 KV 里', () => assert.ok(kv.map.has('state:ledger') && kv.map.has('state:meta')));
}

// ── 场景 B：登录 Lv3 + 关闭观察模式 + 主人刚回复过 ───────────────────────────
{
  const kv = fakeKV();
  const log = [];
  const env = makeEnv(kv, { ...BASE_VARS, OBSERVE_ONLY: 'false' });
  globalThis.fetch = mockFetch({ nav: navLoggedIn(3), messages: [OWNER_MESSAGE_ITEM], log });

  const status = await (await call(env, '/status')).json();
  check('B: /status 显示 Lv3 可写', () => {
    assert.equal(status.loggedIn, true);
    assert.equal(status.level, 3);
    assert.equal(status.canWrite, true);
    assert.equal(status.observeOnly, false);
  });

  const patrol = await (await call(env, '/patrol', { method: 'POST' })).json();
  check('B: 巡检无错误', () => assert.deepEqual(patrol.errors, []));
  check('B: 回复了主人 1 条', () => assert.equal(patrol.inbox.replied, 1));
  check('B: 真的发出了楼中楼回复（root/parent 正确）', () => {
    const replied = postedTo(log, '/x/v2/reply/add');
    assert.equal(replied.length, 1);
    const form = formOf(replied[0]);
    assert.equal(form.root, '555');
    assert.equal(form.oid, '1001');
    assert.ok(String(form.message).length > 0);
  });
  check('B: 刚回完就被「最小间隔」挡住评论（限流生效）', () => {
    assert.equal(patrol.videoComments.queued, 0);
    assert.ok(patrol.notes.some((note) => note.includes('60 秒')));
  });
  check('B: 到点发了每日动态', () => {
    assert.ok(typeof patrol.dynamic.posted === 'string' && patrol.dynamic.posted.length > 0);
    assert.equal(postedTo(log, '/x/dynamic/feed/create/dyn').length, 1);
  });

  const again = await (await call(env, '/patrol', { method: 'POST' })).json();
  check('B: 再巡检一次不会重复回主人（msgSeen 生效）', () => assert.equal(again.inbox.replied, 0));
  check('B: 同一天不会重复发动态', () => assert.equal(again.dynamic.skipped, '今天已经发过了'));
}

// ── 场景 C：Lv0 未转正（真机转正前会走这里） ─────────────────────────────────
{
  const kv = fakeKV();
  const log = [];
  const env = makeEnv(kv, { ...BASE_VARS, OBSERVE_ONLY: 'false' });
  globalThis.fetch = mockFetch({ nav: navLoggedIn(0), messages: [OWNER_MESSAGE_ITEM], log });

  const patrol = await (await call(env, '/patrol', { method: 'POST' })).json();
  check('C: Lv0 判定为不可写', () => assert.equal(patrol.canWrite, false));
  check('C: Lv0 提醒里有转正提示', () => assert.ok(patrol.notes.some((note) => note.includes('Lv0'))));
  check('C: Lv0 期间零写请求', () => {
    assert.equal(postedTo(log, '/x/v2/reply/add').length, 0);
    assert.equal(postedTo(log, '/x/dynamic/feed/create/dyn').length, 0);
  });
  check('C: 主人的回复被「存着」而不是丢掉', () => assert.equal(patrol.inbox.deferred, 1));
  check('C: 动态草稿存进 meta 等放行', () => {
    assert.equal(patrol.dynamic.skipped, '未转正/未登录');
    const meta = JSON.parse(kv.map.get('state:meta'));
    assert.ok(typeof meta.pendingDynamic?.text === 'string' && meta.pendingDynamic.text.length > 0);
  });

  const second = await (await call(env, '/patrol', { method: 'POST' })).json();
  check('C: 待回消息不会被标记成已读（msgSeen 仍空）', () => {
    assert.equal(second.inbox.deferred, 1);
    const ledger = JSON.parse(kv.map.get('state:ledger'));
    assert.equal(Object.keys(ledger.msgSeen ?? {}).length, 0);
  });
}

// ── 场景 D：登录 Lv3 + 收件箱空 → 草稿排队 → 主人点头 → 真发出 ───────────────
{
  const kv = fakeKV();
  const log = [];
  const env = makeEnv(kv, { ...BASE_VARS, OBSERVE_ONLY: 'false' });
  globalThis.fetch = mockFetch({ nav: navLoggedIn(3), messages: [], log });

  const patrol = await (await call(env, '/patrol', { method: 'POST' })).json();
  check('D: 收件箱空时不浪费动作', () => {
    assert.equal(patrol.inbox.total, 0);
    assert.equal(patrol.inbox.replied, 0);
    assert.equal(patrol.errors.length, 0);
  });
  check('D: 视频评论进了待确认队列', () => assert.equal(patrol.videoComments.queued, 1));

  const before = await (await call(env, '/status')).json();
  check('D: 点头前账本里没有评论', () => assert.equal(before.today.comments, 0));

  const pending = await (await call(env, '/pending')).json();
  check('D: 草稿带上了视频标题与 UP 名（方便主人判断）', () => {
    assert.equal(pending.count, 1);
    assert.equal(pending.pending[0].bvid, BVID);
    assert.ok(String(pending.pending[0].title).length > 0);
    assert.equal(pending.pending[0].upName, '酸小明');
  });

  const approve = await (await call(env, '/approve', { method: 'POST', body: { id: pending.pending[0].id } })).json();
  check('D: 主人点头只做标记（Worker 出口被 -412 拦死，真发交给手脚）', () => {
    assert.equal(approve.ok, true);
    assert.equal(approve.bvid, BVID);
    assert.equal(approve.approved, true);
    assert.equal(postedTo(log, '/x/v2/reply/add').length, 0);
  });

  const queuedAfter = await (await call(env, '/pending')).json();
  check('D: 点头后草稿留在队列里等手脚发送', () => {
    assert.equal(queuedAfter.count, 1);
    assert.equal(queuedAfter.pending[0].approved, true);
    assert.notEqual(queuedAfter.pending[0].posted, true);
  });

  const after = await (await call(env, '/status')).json();
  check('D: 真发出去之前账本不计这条评论', () => assert.equal(after.today.comments, 0));

  const again = await (await call(env, '/patrol', { method: 'POST' })).json();
  check('D: 同一视频不会重复排队（queueDraft 按 bvid 覆盖）', () => assert.equal(again.videoComments.queued, 1));
}

// ── 场景 E：陌生人回复的额度开关 + 「@我的」里的动态评论（type=17）─────────────
{
  const strangerMessage = {
    id: 90210,
    user: { mid: 1049033797, nickname: '路过的客人' },
    item: { type: 'reply', source_id: 777, uri: `https://www.bilibili.com/video/${BVID}` },
    reply: { rpid: 778, root_id: 777, content: { message: '这个视频讲得真好' }, ctime: Math.floor(Date.now() / 1000) },
  };
  const dynamicMention = {
    id: 90211,
    user: { mid: Number(OWNER_MID), nickname: '懒寻真' },
    item: {
      type: 'at',
      business: 'dynamic',
      source_id: 880,
      root_id: 880,
      subject_id: 117258059782954,
      source_content: '@bili_83352132154 这条动态说得对',
      at_time: Math.floor(Date.now() / 1000),
    },
  };

  // ① 默认（replyToOthers 未关）+ 取消最小间隔：陌生人和主人的 @ 各回一条。
  {
    const kv = fakeKV();
    const log = [];
    const env = makeEnv(kv, { ...BASE_VARS, OBSERVE_ONLY: 'false', MIN_INTERVAL_SECONDS: '0', MIN_INTERVAL_SECONDS_OWNER: '0' });
    globalThis.fetch = mockFetch({ nav: navLoggedIn(3), messages: [strangerMessage], mentions: [dynamicMention], log });

    const patrol = await (await call(env, '/patrol', { method: 'POST' })).json();
    check('E: 巡检无错误', () => assert.deepEqual(patrol.errors, []));
    check('E: 陌生人和主人的 @ 都回了', () => assert.equal(patrol.inbox.replied, 2));
    check('E: 动态下的评论走 type=17（oid 是动态 id）', () => {
      const posts = postedTo(log, '/x/v2/reply/add').map(formOf);
      const dyn = posts.find((form) => String(form.type) === '17');
      assert.ok(dyn !== undefined, '应该有一条 type=17 的回复');
      assert.equal(dyn.oid, '117258059782954');      assert.equal(posts.filter((form) => String(form.type) === '1').length, 1, '视频那条仍是 type=1');
    });
    check('E: 回复正文不是空壳', () => {
      const posts = postedTo(log, '/x/v2/reply/add').map(formOf);
      assert.ok(posts.every((form) => String(form.message).length > 0));
    });
  }

  // ② 关掉陌生人（REPLY_TO_OTHERS=false）：只回主人的 @。
  {
    const kv = fakeKV();
    const log = [];
    const env = makeEnv(kv, { ...BASE_VARS, OBSERVE_ONLY: 'false', REPLY_TO_OTHERS: 'false' });
    globalThis.fetch = mockFetch({ nav: navLoggedIn(3), messages: [strangerMessage], mentions: [dynamicMention], log });

    const patrol = await (await call(env, '/patrol', { method: 'POST' })).json();
    check('E: replyToOthers=false 时陌生人不回', () => assert.equal(patrol.inbox.replied, 1));
    check('E: 关掉陌生人后只有主人那条 @ 被回', () => {
      const posts = postedTo(log, '/x/v2/reply/add').map(formOf);
      assert.equal(posts.length, 1);
      assert.equal(String(posts[0].type), '17');
    });
  }
}

// ── 场景 F：本机在岗（心跳新鲜）→ 云端只待命，一个写请求都不发 ───────────────
{
  const kv = fakeKV();
  const log = [];
  const env = makeEnv(kv, { ...BASE_VARS, OBSERVE_ONLY: 'false' });
  globalThis.fetch = mockFetch({ nav: navLoggedIn(3), messages: [OWNER_MESSAGE_ITEM], log });
  // 心跳：本机（看门鲸 / cloud/run.mjs）刚报过到。
  kv.map.set('state:meta', JSON.stringify({ localSeenAt: Date.now(), cloudSeenAt: 0 }));

  const patrol = await (await call(env, '/patrol', { method: 'POST' })).json();
  check('F: 本机在岗时云端判定为待命', () => assert.equal(patrol.standby, true));
  check('F: 待命时不回私信、不排队评论、不发动态', () => {
    assert.equal(patrol.inbox.replied, 0);
    assert.equal(patrol.videoComments.queued, 0);
    assert.equal(patrol.dynamic.posted, null);
  });
  check('F: 待命时零写请求', () => {
    assert.equal(postedTo(log, '/x/v2/reply/add').length, 0);
    assert.equal(postedTo(log, '/x/dynamic/feed/create/dyn').length, 0);
  });
  check('F: 待命原因写进 notes（并提示 force）', () => {
    assert.ok(patrol.notes.some((note) => note.includes('本机在岗')), `notes=${JSON.stringify(patrol.notes)}`);
    assert.ok(patrol.notes.some((note) => note.includes('force')), `notes=${JSON.stringify(patrol.notes)}`);
  });

  const forced = await (await call(env, '/patrol?force=1', { method: 'POST' })).json();
  check('F: ?force=1 能压过待命闸（主人叫云端干活就真干）', () => {
    assert.equal(forced.standby, false);
    assert.equal(forced.inbox.replied, 1);
  });
}

// ── 场景 G：KV 写不进去（免费写额度 1000/天 见底）→ 整轮只读待命，force 也压不过 ──
//
// 这就是 2026-10-05 主人看到的刷屏的现场：额度写光后 putJson 静默失败，云端拿着几小时前的
// 旧账本回评论，同一条评论被回了 6 条。规矩是「宁可少干一轮，也不能拿旧账本刷屏」。
{
  const deadKv = {
    map: new Map(),
    async get() {
      return null;
    },
    async put() {
      // 真实世界里是 KV 返回 10048 / 抛错，store.js 的 putJson 把它 catch 成 false。
      throw new Error('KV put failed: your account has reached the free usage limit for this operation for today');
    },
    async delete() {},
  };
  const log = [];
  const env = makeEnv(deadKv, { ...BASE_VARS, OBSERVE_ONLY: 'false' });
  globalThis.fetch = mockFetch({ nav: navLoggedIn(3), messages: [OWNER_MESSAGE_ITEM], log });

  const patrol = await (await call(env, '/patrol', { method: 'POST' })).json();
  check('G: KV 写不进去时云端判定为待命', () => assert.equal(patrol.standby, true));
  check('G: KV 写不进去时原因写进 notes', () => {
    assert.ok(patrol.notes.some((note) => note.includes('KV 写不进去')), `notes=${JSON.stringify(patrol.notes)}`);
  });
  check('G: KV 写不进去时不回评论、不发评论、不发动态', () => {
    assert.equal(patrol.inbox.replied, 0);
    assert.equal(patrol.videoComments.queued, 0);
    assert.equal(patrol.dynamic.posted, null);
    assert.equal(postedTo(log, '/x/v2/reply/add').length, 0);
    assert.equal(postedTo(log, '/x/dynamic/feed/create/dyn').length, 0);
  });

  const forced = await (await call(env, '/patrol?force=1', { method: 'POST' })).json();
  check('G: 就算 ?force=1，KV 写不进去也不动手（拿旧账本刷屏更糟）', () => {
    assert.equal(forced.standby, true);
    assert.equal(forced.inbox.replied, 0);
    assert.equal(postedTo(log, '/x/v2/reply/add').length, 0);
  });
}

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  for (const line of failures) console.log(`  - ${line}`);
  process.exitCode = 1;
}
