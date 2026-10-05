/**
 * bili-whale —— 小鲸鱼娘女仆的**云端常驻**（Cloudflare Worker）。
 *
 * 职责分工：
 *   - scheduled（cron 每 10 分钟）：无人值守巡检 —— 读消息中心、按策略自动回复、
 *     到点发学习动态、把视频一级评论做成「待确认草稿」排队；账号未转正时全程只读。
 *   - fetch（HTTP API）：给本机 DSH 插件（bili_cloud 工具）和主人自己用 ——
 *     看状态、看队列、点头/驳回、手动触发一次巡检；所有非公开端点都要令牌。
 *
 * 安全：除 /health 外全部要求 `x-whale-token`（或 `Authorization: Bearer`）等于机密 ADMIN_TOKEN；
 *      令牌比较用固定长度循环，避免最朴素的时序侧信道。
 *
 * @module bili-whale
 */
import { BiliClient, BiliError, cookieHeader, hasWriteCredentials } from './bili.js';
import { createLedger, dateKey, recordComment, recordDynamic, recordReply } from './ledger.js';
import { checkDynamic, checkReply, checkVideoComment, isOwner, ownerMentionList } from './policy.js';
import {
  appendCloudLog,
  deepMerge,
  getJson,
  loadState,
  putJson,
  readCloudLog,
  saveCookies,
  saveLedger,
  savePending,
  saveMeta,
  saveUserConfig,
  secretCookies,
  varsConfig,
} from './store.js';
import { enqueueDraft, runPatrol, timezoneShiftMs } from './patrol.js';
import { extractText } from './persona.js';
import { DEFAULTS } from './policy.js';
import { mergeCookies, mergeLedger, mergeMeta, mergePending } from './sync.js';
import { safeForModel } from './text.js';

/** 本机心跳多久算「在岗」：这段时间内云端不抢活（本机有自己的定时器在跑）。 */
const LOCAL_TTL_MS = 15 * 60 * 1000;

/**
 * 让「手脚」去干活：用 GitHub API 触发 Actions 里的 whale workflow。
 *
 * Worker 自己发不出去（Cloudflare 出口 IP 被 B 站 -412 拦死），所以它只负责
 * 「记住主人点了头」，真发交给手脚 —— 本机在线就是本机，关机就是 GitHub Actions。
 * 需要机密：`GITHUB_TOKEN`（细粒度、带 actions:write）与 `GH_REPO`（owner/name）。
 */
async function dispatchHands(env, task = 'patrol') {
  const token = String(env?.GITHUB_TOKEN ?? '');
  const repo = String(env?.GH_REPO ?? '');
  if (token === '' || repo === '') {
    return { dispatched: false, reason: '没配 GITHUB_TOKEN / GH_REPO（本机在线时不影响：本机就是手脚）' };
  }
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/whale.yml/dispatches`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'bili-whale-worker',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ref: String(env?.GH_REF ?? 'master'), inputs: { task } }),
    });
    if (response.ok !== true) {
      const text = await response.text().catch(() => '');
      return { dispatched: false, status: response.status, reason: text.slice(0, 160) };
    }
    return { dispatched: true, status: response.status };
  } catch (issue) {
    return { dispatched: false, reason: String(issue?.message ?? issue) };
  }
}

export const VERSION = '1.0.0';

/**
 * 主人时区的「现在」：Worker 进程是 UTC，而账本里的「今天」与间隔判定都按主人时区算，
 * 所以写路径（/comment /approve /reply /dynamic）也要用平移后的时间戳记账。
 */
function policyClock(cfg) {
  const shift = timezoneShiftMs(cfg?.timezone ?? 'Asia/Shanghai');
  const ts = Date.now() + shift;
  return { ts, date: new Date(ts) };
}

/** 固定长度比较（长度不同直接不等，但比较过程不提前 return）。 */
function safeEqual(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  let diff = left.length === right.length ? 0 : 1;
  const len = Math.max(left.length, right.length);
  for (let index = 0; index < len; index += 1) {
    diff |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return diff === 0;
}

function tokenFrom(request) {
  const direct = request.headers.get('x-whale-token');
  if (direct !== null && direct !== '') return direct;
  const auth = request.headers.get('authorization') ?? '';
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return '';
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function fail(message, status = 400, extra = {}) {
  return json({ ok: false, error: message, ...extra }, status);
}

/** 云端时区的本地时间（默认 Asia/Shanghai）。 */
export function localParts(cfg, now = new Date()) {
  const timezone = typeof cfg?.timezone === 'string' && cfg.timezone !== '' ? cfg.timezone : 'Asia/Shanghai';
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  const hour = Number(parts.hour === '24' ? '0' : parts.hour);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour, minute: Number(parts.minute), minutes: hour * 60 + Number(parts.minute) };
}

/** 建一个带 cookie 回写能力的客户端。 */
function makeClient(state, env, ctx) {
  const pendingCookies = [];
  const client = new BiliClient({
    cookies: state.cookies,
    onCookies: (cookies) => {
      pendingCookies.push(cookies);
      Object.assign(state.cookies, cookies);
    },
  });
  return {
    client,
    flush: async () => {
      if (pendingCookies.length === 0) return;
      await saveCookies(env, state.cookies);
      void ctx;
    },
  };
}

/** 固定的浏览器 UA（与 bili.js 里的 UA 保持一致，便于排查风控）。 */
const DIAG_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * 风控自检：从 Cloudflare 这台机器上，用不同「请求头 + cookie」组合打几个 B 站端点，
 * 看谁被 -412（request was banned）拦下。B 站对机房 IP 有风控，这一步用来确认
 * 「是 IP 被拦」还是「cookie 失效」还是「接口需要 wbi 签名」。
 */
async function handleDiag(state) {
  const cookie = cookieHeader(state.cookies ?? {});
  const probes = [
    { name: 'spi（指纹，无 cookie）', url: 'https://api.bilibili.com/x/frontend/finger/spi', cookie: '' },
    { name: 'view（公开稿件，无 cookie）', url: 'https://api.bilibili.com/x/web-interface/view?bvid=BV1WYeS6YEwt', cookie: '' },
    { name: 'view（公开稿件，带 cookie）', url: 'https://api.bilibili.com/x/web-interface/view?bvid=BV1WYeS6YEwt', cookie },
    { name: 'popular（带 cookie）', url: 'https://api.bilibili.com/x/web-interface/popular?ps=3&pn=1', cookie },
    { name: 'popular（无 cookie）', url: 'https://api.bilibili.com/x/web-interface/popular?ps=3&pn=1', cookie: '' },
    { name: 'nav（带 cookie，看登录态）', url: 'https://api.bilibili.com/x/web-interface/nav', cookie },
    // —— 换域名/换 UA 再试：是想区分「整段 IP 被 WAF 拦」还是「只有 api.bilibili.com 拦」 ——
    { name: '对照：api.github.com（证明出口网络正常）', url: 'https://api.github.com/zen', cookie: '' },
    { name: 'www.bilibili.com（网页 HTML）', url: 'https://www.bilibili.com/', cookie: '' },
    { name: 'app.bilibili.com（移动端接口）', url: 'https://app.bilibili.com/x/v2/feed/index?build=1&mobi_app=android', cookie },
    { name: 'api.live.bilibili.com', url: 'https://api.live.bilibili.com/xlive/web-interface/v1/index/getList?platform=web', cookie: '' },
    { name: 'passport.bilibili.com（扫码登录域）', url: 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate', cookie: '' },
    { name: 'api.bilibili.com + 手机 UA', url: 'https://api.bilibili.com/x/web-interface/popular?ps=3&pn=1', cookie, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148' },
  ];
  const results = [];
  for (const probe of probes) {
    const headers = {
      'User-Agent': probe.ua ?? DIAG_UA,
      Referer: 'https://www.bilibili.com/',
      Origin: 'https://www.bilibili.com',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    };
    if (probe.cookie !== '') headers.Cookie = probe.cookie;
    try {
      const response = await fetch(probe.url, { headers, signal: AbortSignal.timeout(8000) });
      const text = await response.text();
      let code = null;
      let message = null;
      try {
        const body = JSON.parse(text);
        code = body?.code ?? null;
        message = body?.message ?? null;
        if (probe.name.startsWith('nav')) message = `${message ?? ''} isLogin=${body?.data?.isLogin}`;
        if (probe.name.startsWith('spi')) message = `b_3=${String(body?.data?.b_3 ?? '').slice(0, 8)}…`;
      } catch {
        message = text.slice(0, 80);
      }
      results.push({ name: probe.name, http: response.status, code, message });
    } catch (issue) {
      results.push({ name: probe.name, http: null, code: null, message: String(issue?.message ?? issue) });
    }
  }
  return json({
    ok: true,
    cookieKeys: Object.keys(state.cookies ?? {}),
    hasWriteCredentials: hasWriteCredentials(state.cookies ?? {}),
    probes: results,
  });
}

async function handleStatus(env, state, ctx) {
  const { client, flush } = makeClient(state, env, ctx);
  let nav = null;
  let error = null;
  try {
    nav = await client.nav();
  } catch (issue) {
    error = issue instanceof BiliError ? `${issue.code}: ${issue.message}` : String(issue?.message ?? issue);
  }
  await flush();
  const tz = localParts(state.cfg);
  // 存储键必须与写入方（ledger.todayBucket / recordDynamic）完全同源：它们用 dateKey(policyClock 平移过的 now)。
  // 若这里改用 Intl 取的真实墙上日期，在 UTC+8 开发机上会与写入键差 8 小时（Worker 跑 UTC 时两者恰好相等）。
  const storeKey = dateKey(policyClock(state.cfg).date);
  const counts = (state.ledger?.daily?.[storeKey]) ?? { videoComments: 0, replies: 0, dynamics: 0 };
  return json({
    ok: true,
    version: VERSION,
    patrol: state.meta?.lastTrigger ?? 'unknown',
    lastPatrolAt: state.meta?.lastPatrolAt ?? null,
    lastPatrolResult: state.meta?.lastPatrolResult ?? null,
    loggedIn: nav?.isLogin === true,
    uname: nav?.uname ?? state.cfg.whaleName ?? '',
    mid: nav?.mid ?? state.cfg.whaleMid ?? null,
    level: nav?.level ?? null,
    levelText:
      nav?.level === null || nav?.level === undefined
        ? null
        : `Lv${nav.level}${Number(nav.level) === 0 ? '（未转正：B 站会拒发动态/评论，错误码 4126021）' : ''}`,
    exp: nav?.exp ?? null,
    mobileVerified: nav?.mobileVerified ?? null,
    owner: { name: state.cfg.ownerName, mid: state.cfg.ownerMid },
    policies: {
      postVideoComment: state.cfg.policy?.postVideoComment ?? null,
      postReply: state.cfg.policy?.postReply ?? null,
      postDynamic: state.cfg.policy?.postDynamic ?? null,
    },
    observeOnly: state.cfg.observeOnly === true,
    // 能不能写 = 真的登录了 + 没开观察模式 + 已转正（Lv0 会被 B 站以 4126021 拒发）；
    // 光看 cookie 齐不齐（client.canWrite()）会误报「可写」。
    canWrite: nav?.isLogin === true && state.cfg.observeOnly !== true && Number(nav?.level ?? 0) !== 0,
    cookiesReady: typeof client.canWrite === 'function' ? client.canWrite() : null,
    // 桶里的字段名是 videoComments/replies/dynamics（见 ledger.todayBucket）
    today: {
      date: storeKey,
      wallDate: tz.date,
      comments: counts.videoComments ?? 0,
      replies: counts.replies ?? 0,
      dynamics: counts.dynamics ?? 0,
    },
    // dynamics 条目的字段名是 date（recordDynamic 写 {date: dateKey(now), ...}），不是 dateKey
    dynamicPostedToday: (state.ledger?.dynamics ?? []).some((item) => item.date === storeKey) === true,
    pendingCount: state.pending.length,
    navError: error,
  });
}

async function handleInbox(env, state, ctx, url) {
  const limit = Number(url.searchParams.get('limit') ?? 10);
  const { client, flush } = makeClient(state, env, ctx);
  const inbox = await client.msgReplies({ ps: Math.min(Math.max(limit, 1), 20) });
  await flush();
  const seen = state.ledger?.msgSeen ?? {};
  const items = inbox.items.slice(0, limit).map((item) => ({
    id: item.id,
    mid: item.mid,
    uname: item.uname,
    message: item.message,
    subject: item.subject,
    bvid: item.raw?.item?.bvid ?? item.raw?.item?.uri ?? null,
    oid: item.oid,
    rpid: item.rpid,
    root: item.root,
    ctime: item.ctime,
    isOwner: isOwner(item.mid, state.cfg),
    answered: seen[String(item.id)] !== undefined,
    autoReplied: seen[String(item.id)]?.auto === true,
  }));
  return json({ ok: true, total: inbox.items.length, cursor: inbox.cursor, items, code: inbox.code });
}

function handlePending(state) {
  return json({ ok: true, pending: state.pending, count: state.pending.length });
}

/** 把 /feed 的 kind 映射到客户端方法。 */
async function feedItems(client, cfg, kind, keyword, limit) {
  if (kind === 'search') {
    if (typeof keyword !== 'string' || keyword.trim() === '') throw new Error('kind=search 需要 q 关键词');
    return { source: 'search', items: (await client.search(keyword.trim())).slice(0, limit) };
  }
  if (kind === 'ranking') return { source: 'ranking', items: (await client.ranking(0, 'all')).slice(0, limit) };
  if (kind === 'rcmd') {
    try {
      return { source: 'rcmd', items: (await client.rcmd(Math.max(limit, 12))).slice(0, limit) };
    } catch (issue) {
      // 推荐流需要登录态，失败就如实回退热门（与插件端行为一致）
      return { source: 'popular(fallback)', items: (await client.popular(Math.max(limit, 12), 1)).slice(0, limit), fallbackReason: String(issue?.message ?? issue) };
    }
  }
  void cfg;
  return { source: 'popular', items: (await client.popular(Math.max(limit, 12), 1)).slice(0, limit) };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/health') {
      return json({ ok: true, name: 'bili-whale', version: VERSION, ai: env?.AI !== undefined, kv: env?.WHALE_KV !== undefined });
    }

    const provided = tokenFrom(request);
    const expected = env?.ADMIN_TOKEN ?? '';
    if (expected === '' || !safeEqual(provided, expected)) {
      return fail('令牌不对：请在请求头带 x-whale-token（或 Authorization: Bearer）。', 401);
    }
    if (env?.WHALE_KV === undefined) return fail('没有绑定 KV（WHALE_KV），无法保存账本与队列。', 500);

    let state;
    try {
      state = await loadState(env, { defaults: DEFAULTS });
      state.ledger = createLedger(state.ledger);
    } catch (issue) {
      return fail(`读取云端状态失败：${issue?.message ?? issue}`, 500);
    }

    try {
      if (path === '/status' || path === '/') return await handleStatus(env, state, ctx);
      if (path === '/diag') return await handleDiag(state);
      if (path === '/inbox') return await handleInbox(env, state, ctx, url);
      if (path === '/pending') return handlePending(state);
      if (path === '/log') return json({ ok: true, log: await readCloudLog(env), meta: state.meta });

      if (path === '/feed') {
        const kind = (url.searchParams.get('kind') ?? 'popular').toLowerCase();
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 10), 1), 30);
        const keyword = url.searchParams.get('q') ?? '';
        const { client, flush } = makeClient(state, env, ctx);
        const result = await feedItems(client, state.cfg, kind, keyword, limit);
        await flush();
        return json({ ok: true, ...result });
      }

      if (path === '/video') {
        const bvid = url.searchParams.get('bvid') ?? url.searchParams.get('id') ?? '';
        if (bvid === '') return fail('需要 bvid 参数');
        const { client, flush } = makeClient(state, env, ctx);
        const video = await client.video(bvid);
        const tags = await client.tags(bvid);
        await flush();
        return json({ ok: true, video: { ...video, tags } });
      }

      if (path === '/comments') {
        const bvid = url.searchParams.get('bvid') ?? url.searchParams.get('id') ?? '';
        if (bvid === '') return fail('需要 bvid 参数');
        const { client, flush } = makeClient(state, env, ctx);
        const comments = await client.comments(bvid, { ps: Math.min(Math.max(Number(url.searchParams.get('limit') ?? 20), 1), 20) });
        await flush();
        return json({ ok: true, ...comments });
      }

      // —— 状态柜：本机（DSH 插件）与云端（GitHub Actions）共用同一本账本 ——
      // 本机在线时，它每次动作完都会 POST 一次，顺带写心跳 meta.localSeenAt；
      // 云端跑之前先 GET 一次（心跳新就让位），跑完把结果合并回来。
      if (path === '/state') {
        if (request.method === 'GET') {
          const cookies = { ...secretCookies(env), ...(state.cookies ?? {}) };
          return json({
            ok: true,
            at: new Date().toISOString(),
            cookies,
            config: await varsConfigOverride(env),
            ledger: state.ledger,
            pending: state.pending,
            meta: state.meta,
          });
        }
        if (request.method === 'POST') {
          const body = await readJsonBody(request);
          if (body === null) return fail('请求体必须是 JSON 对象');
          const nextLedger = mergeLedger(state.ledger, body.ledger ?? {});
          const nextPending = mergePending(state.pending, body.pending ?? []);
          const nextMeta = mergeMeta(state.meta, { ...(body.meta ?? {}), at: new Date().toISOString() });
          // 每一次写都把结果收起来：KV 免费额度（1000 写/天）见底时 `kv.put` 会失败，
          // 而 store.js 的 putJson 是「吞掉异常返回 false」——不检查的话，
          // 客户端会以为「交账本成功」，实际云端还停在几小时前的旧快照上
          // （2026-10-05 的翻车：云端拿旧账本，同一条评论被重复回复）。
          const writes = [];
          writes.push(await saveLedger(env, nextLedger));
          writes.push(await savePending(env, nextPending));
          writes.push(await saveMeta(env, nextMeta));
          let cookieKeys = Object.keys(state.cookies ?? {});
          if (body.cookies !== undefined && body.cookies !== null && Object.keys(body.cookies).length > 0) {
            const merged = mergeCookies(state.cookies, body.cookies);
            writes.push(await saveCookies(env, merged));
            cookieKeys = Object.keys(merged);
          }
          const persisted = writes.every((flag) => flag === true);
          // 这里**故意不写 state:log**：每交一次账本就追加一行，是 KV 写额度里最没必要的那一档
          // （云端跑完动作会单独 POST /log 报一句，那条才值得留）。
          return json({
            ok: true,
            persisted,
            warning: persisted === true ? '' : 'KV 写不进去（免费写额度见底？）：这份状态没有落盘',
            mergedAt: new Date().toISOString(),
            ledger: {
              comments: nextLedger.comments.length,
              replies: nextLedger.replies.length,
              dynamics: nextLedger.dynamics.length,
              study: nextLedger.study.length,
              favorites: nextLedger.favorites.length,
              dms: nextLedger.dms.length,
            },
            pending: nextPending,
            meta: nextMeta,
            cookieKeys,
          });
        }
        return fail('只支持 GET / POST', 405);
      }

      // —— 免费脑子：把 Workers AI 借给本机 / 手脚当「不要钱的模型」用 ——
      // 主人要求「回复人用免费模型」，于是本机的 brain.js 默认就来敲这个接口。
      if (path === '/brain') {
        if (request.method !== 'POST') return fail('只支持 POST', 405);
        const body = await readJsonBody(request);
        if (body === null) return fail('请求体必须是 JSON 对象');
        const ai = env?.AI;
        if (ai === undefined || ai === null || typeof ai.run !== 'function') return fail('这朵 Worker 没绑 Workers AI', 503);
        const model = String(body.model ?? '').trim() || String(env?.PERSONA_MODEL ?? '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
        try {
          const result = await ai.run(model, {
            messages: [
              // 孤立代理项（半个 emoji）会让 Workers AI 报 8006「Invalid data for body - reason must be valid JSON」。
              { role: 'system', content: safeForModel(body.system) },
              { role: 'user', content: safeForModel(body.user) },
            ],
            max_tokens: Number(body.maxTokens ?? 300),
            temperature: Number(body.temperature ?? 1.3),
          });
          const text = extractText(result).trim();
          if (text === '') return fail('模型没吐字', 502);
          return json({ ok: true, provider: 'workers-ai', model, text, at: new Date().toISOString() });
        } catch (error) {
          return fail(`模型报错：${error.message}`, 502);
        }
      }

      // —— 心跳：本机报「我在岗」，云端据此让位（本机开机时云端不抢活）——
      if (path === '/heartbeat') {
        const now = Date.now();
        state.meta = { ...state.meta, localSeenAt: now, localWriter: 'local' };
        const persisted = await saveMeta(env, state.meta);
        return json({ ok: true, persisted, localSeenAt: now, at: new Date(now).toISOString() });
      }

      // —— 探针：KV 今天还能不能写？云端（GitHub Actions）**每轮开工前先问一次**。
      //
      // 为什么要这么啰嗦：KV 免费额度（1000 写/天）见底后，putJson 会静默失败，
      // 云端会拿着几小时前的旧账本继续回复陌生人 —— 旧账本认不出「这条已经回过」，
      // 同一条评论就被重复回（2026-10-05 亲眼看到 6 条「人家记住啦」）。
      // 所以：写一个随机 nonce → 立刻读回来 → 对得上才允许这一轮动手。
      if (path === '/probe') {
        const body = await readJsonBody(request);
        const nonce = String(body?.nonce ?? Date.now());
        const wrote = await putJson(env?.WHALE_KV, 'state:probe', { nonce, at: new Date().toISOString() });
        const back = await getJson(env?.WHALE_KV, 'state:probe', null);
        const persisted = wrote === true && back?.nonce === nonce;
        return json({
          ok: persisted,
          persisted,
          wrote: wrote === true,
          nonce,
          backNonce: back?.nonce ?? null,
          at: new Date().toISOString(),
        });
      }

      if (path === '/config') {        if (request.method === 'GET') {
          return json({ ok: true, config: state.cfg, overrides: await varsConfigOverride(env) });
        }
        if (request.method === 'POST') {
          const body = await readJsonBody(request);
          if (body === null) return fail('请求体必须是 JSON 对象');
          const overrides = await varsConfigOverride(env);
          const next = deepMerge(overrides, body);
          const persisted = await saveUserConfig(env, next);
          await appendCloudLog(env, `config updated: ${JSON.stringify(body)}`);
          return json({
            ok: true,
            persisted,
            warning: persisted === true ? '' : 'KV 写不进去（免费写额度见底？）：配置没有落盘',
            config: deepMerge(deepMerge(DEFAULTS, varsConfig(env)), next),
          });
        }
        return fail('只支持 GET / POST', 405);
      }

      if (path === '/patrol') {
        // 本机在岗时云端默认只待命（别两端抢回同一条评论）；`?force=1` 强制跑。
        const forced = url.searchParams.get('force') === '1';
        const result = await runPatrol(env, { trigger: 'manual', ctx, force: forced });
        return json({ ok: true, ...result });
      }

      if (path === '/reject') {
        const body = await readJsonBody(request);
        const id = String(body?.id ?? '').trim();
        if (id === '') return fail('需要 id');
        const before = state.pending.length;
        state.pending = state.pending.filter((item) => item.id !== id);
        await savePending(env, state.pending);
        await appendCloudLog(env, `draft rejected: ${id}`);
        return json({ ok: state.pending.length < before, pending: state.pending.length });
      }

      if (path === '/approve') {
        const body = await readJsonBody(request);
        const id = String(body?.id ?? '').trim();
        if (id === '') return fail('需要 id');
        const draft = state.pending.find((item) => item.id === id);
        if (draft === undefined) return fail(`队列里没有 id=${id} 的草稿`, 404);
        // 只标记「主人点头了」。真发由手脚来做（本机在线就是本机，关机就是 GitHub Actions）：
        // Cloudflare 的出口 IP 被 B 站 -412 拦死，Worker 自己发不出去。
        //
        // 这里**故意不看 observeOnly**（踩过的坑：云端 OBSERVE_ONLY=true 时 /approve 直接 409，
        // 主人点了头也发不出去，看起来就是「评论一个都没发出去」）。
        // 观察模式约束的是**云端自己**别发写请求；主人显式点头之后的发送由本机的手脚执行，
        // 本机有自己的 policy 把关（observeOnly 也是本机 policy 的一环）。
        draft.approved = true;
        draft.approvedAt = new Date().toISOString();
        await savePending(env, state.pending);
        await appendCloudLog(env, `draft approved（等手脚发送）：${draft.bvid}`);
        const dispatched = await dispatchHands(env, 'patrol');
        return json({ ok: true, id, bvid: draft.bvid, approved: true, dispatched, observeOnly: state.cfg.observeOnly === true });
      }

      if (path === '/reply') {
        return await handleReply(env, state, ctx, request);
      }
      if (path === '/comment') {
        return await handleComment(env, state, ctx, request);
      }
      if (path === '/dynamic') {
        return await handleDynamic(env, state, ctx, request);
      }

      return fail(`未知路径：${path}`, 404);
    } catch (issue) {
      const message = issue instanceof BiliError ? `B站接口返回 ${issue.code}：${issue.message}` : String(issue?.message ?? issue);
      await appendCloudLog(env, `ERROR ${path}: ${message}`);
      return fail(message, 502, { code: issue instanceof BiliError ? issue.code : undefined });
    }
  },

  async scheduled(event, env, ctx) {
    const run = async () => {
      try {
        // 谁是「手脚」？—— 本机开机时本机跑（它自己有自己的定时器，Worker 让位）；
        // 本机关机时，Worker 只负责**喊一声**，让 GitHub Actions 去跑。
        const [meta, pending] = await Promise.all([
          getJson(env?.WHALE_KV, 'state:meta', {}),
          getJson(env?.WHALE_KV, 'state:pending', []),
        ]);
        const localFresh = Number(meta?.localSeenAt ?? 0) > 0 && Date.now() - Number(meta.localSeenAt) < LOCAL_TTL_MS;
        if (localFresh) {
          await appendCloudLog(env, `cron：本机在岗（${Math.round((Date.now() - Number(meta.localSeenAt)) / 1000)} 秒前还有心跳），云端只待命`);
          return;
        }
        const approved = (Array.isArray(pending) ? pending : []).filter((item) => item?.approved === true);
        const dispatched = await dispatchHands(env, approved.length > 0 ? 'patrol' : 'patrol');
        await appendCloudLog(
          env,
          `cron：本机不在岗 → 喊手脚 ${dispatched.dispatched === true ? '成功' : `失败（${dispatched.reason ?? dispatched.status ?? ''}）`}，待发草稿 ${approved.length} 条`,
        );
      } catch (issue) {
        await appendCloudLog(env, `cron FAILED: ${String(issue?.message ?? issue)}`);
      }
    };
    void event;
    if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(run());
    else await run();
  },
};

/** 读出 KV 里主人覆盖的配置（供 /config 回显）。 */
async function varsConfigOverride(env) {
  const { getJson } = await import('./store.js');
  const value = await getJson(env?.WHALE_KV, 'state:config', {});
  return value ?? {};
}

async function readJsonBody(request) {
  try {
    const text = await request.text();
    if (text.trim() === '') return {};
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function handleComment(env, state, ctx, request) {
  const body = await readJsonBody(request);
  if (body === null) return fail('请求体必须是 JSON 对象');
  const bvid = String(body.bvid ?? '').trim();
  const message = String(body.message ?? '').trim();
  if (bvid === '' || message === '') return fail('需要 bvid 与 message');
  const confirm = body.confirm === true;
  const { client, flush } = makeClient(state, env, ctx);
  const video = await client.video(bvid);
  const verdict = checkVideoComment({ cfg: state.cfg, ledger: state.ledger, bvid, message, confirm });
  if (verdict.allowed !== true) {
    // 只有「纯粹因为草稿模式」才排队；有硬拦截理由（配额/间隔/屏蔽词）时排队也没意义
    if (verdict.needsConfirm === true && verdict.reasons.length === 0) {
      const draft = enqueueDraft(state, { bvid, aid: video.aid, title: video.title, upName: video.author, message, source: 'api' });
      await savePending(env, state.pending);
      await flush();
      await appendCloudLog(env, `draft queued: ${bvid} ${message}`);
      return json({ ok: true, queued: true, draft, verdict });
    }
    await flush();
    return json({ ok: false, verdict }, 409);
  }
  if (state.cfg.observeOnly === true) {
    await flush();
    return fail('云端处于观察模式（observeOnly=true），先把观察模式关掉再发。', 409);
  }
  const created = await client.commentAdd({ aid: video.aid, bvid, message, mentions: ownerMentionList(state.cfg) });
  await flush();
  const clock = policyClock(state.cfg);
  recordComment(state.ledger, { bvid, aid: video.aid, rpid: created?.rpid ?? null, text: message, ts: clock.ts, now: clock.date });
  await saveLedger(env, state.ledger);
  await appendCloudLog(env, `comment posted: ${bvid} ${message}`);
  return json({ ok: true, posted: true, bvid, rpid: created?.rpid ?? null, verdict });
}

async function handleReply(env, state, ctx, request) {
  const body = await readJsonBody(request);
  if (body === null) return fail('请求体必须是 JSON 对象');
  const bvid = String(body.bvid ?? '').trim();
  const root = body.root ?? 0;
  const message = String(body.message ?? '').trim();
  const toMid = body.toMid ?? null;
  if (bvid === '' || message === '') return fail('需要 bvid 与 message');
  const { client, flush } = makeClient(state, env, ctx);
  const video = await client.video(bvid);
  // rpid 回退：源文件是 Number(target.root)>0 ? target.root : target.rpid；
  // 只给了一级评论文（root=0）时，正确的串根就是这条评论自己（body.parent ?? body.rpid）。
  const verdict = checkReply({
    cfg: state.cfg,
    ledger: state.ledger,
    bvid,
    root,
    rpid: body.parent ?? body.rpid ?? root,
    message,
    toMid,
    toName: body.toName ?? '',
  });
  if (verdict.allowed !== true) {
    await flush();
    return json({ ok: false, verdict }, 409);
  }
  if (state.cfg.observeOnly === true) {
    await flush();
    return fail('云端处于观察模式（observeOnly=true），先把观察模式关掉再发。', 409);
  }
  const created = await client.commentAdd({ aid: video.aid, bvid, message, root: root || undefined, parent: body.parent ?? undefined, mentions: ownerMentionList(state.cfg) });
  await flush();
  const clock = policyClock(state.cfg);
  // 手动回复也要记账：否则「每人每条串只回一条」与当日配额都看不见它，
  // 下一趟巡检可能把同一个人再回一遍。
  recordReply(state.ledger, {
    bvid,
    aid: video.aid,
    rpid: body.parent ?? root ?? null,
    root: Number(root) > 0 ? root : (body.parent ?? null),
    targetMid: toMid,
    targetUname: body.toName ?? '',
    text: message,
    selfRpid: created?.rpid ?? null,
    isOwner: isOwner(toMid, state.cfg),
    ts: clock.ts,
    now: clock.date,
  });
  await saveLedger(env, state.ledger);
  await appendCloudLog(env, `reply posted: ${bvid} root=${root} ${message}`);
  return json({ ok: true, posted: true, bvid, root, rpid: created?.rpid ?? null, verdict });
}

async function handleDynamic(env, state, ctx, request) {
  const body = await readJsonBody(request);
  if (body === null) return fail('请求体必须是 JSON 对象');
  const text = String(body.text ?? '').trim();
  if (text === '') return fail('需要 text');
  const verdict = checkDynamic({ cfg: state.cfg, ledger: state.ledger, text });
  if (verdict.allowed !== true) return json({ ok: false, verdict }, 409);
  if (state.cfg.observeOnly === true) {
    return fail('云端处于观察模式（observeOnly=true），先把观察模式关掉再发。', 409);
  }
  const { client, flush } = makeClient(state, env, ctx);
  const created = await client.dynamicCreate(text, { mentions: ownerMentionList(state.cfg) });
  await flush();
  const clock = policyClock(state.cfg);
  // 手动发的动态也要记账，否则同一天巡检还会再发一条
  recordDynamic(state.ledger, { text, dynId: created?.dyn_id_str ?? null, ts: clock.ts, now: clock.date });
  await saveLedger(env, state.ledger);
  await saveMeta(env, { ...state.meta, lastDynamicAt: new Date().toISOString(), lastDynamicText: text });
  await appendCloudLog(env, `dynamic posted: ${text}`);
  return json({ ok: true, posted: true, text, dynId: created?.dyn_id_str ?? null });
}
