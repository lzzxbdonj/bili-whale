#!/usr/bin/env node
/**
 * 小鲸鱼娘的**云端身体**：给 GitHub Actions（或任何常驻机器）用的无头巡检器。
 *
 * 为什么长这样：
 *   - Cloudflare Worker 的出口 IP 被 B 站整段风控（-412 request was banned），
 *     所以「动嘴动手」的事必须交给一个 B 站不拦的运行环境；GitHub Actions 的
 *     Azure 出口（AS8075）实测可以正常访问 B 站接口。
 *   - Worker 则退化成**遥控台 + 状态柜**：AI 里的账本、待确认草稿、cookie 都存在
 *     Cloudflare KV 上，由本文件负责拉取 → 干活 → 写回。
 *
 * 复用本机插件同一套 `lib/`（api / policy / ledger / brain / tools），所以云端与
 * 本机的规则、人格、账本格式完全一致，不会出现「两边各说各话」。
 *
 * 用法：
 *   WHALE_URL=https://bili-whale.<account>.workers.dev \
 *   WHALE_TOKEN=<遥控台令牌> BILI_COOKIES='{...}' DEEPSEEK_API_KEY=sk-... \
 *   node cloud/run.mjs [--task patrol|dm|daily|study|report] [--dry]
 *
 * 日志纪律：只打印计数与结论，**绝不打印私信正文或 cookie**（公共仓库的 Actions
 * 日志任何人都能看）。
 *
 * @module bili-whale/cloud-run
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback = '') => {
  const hit = argv.find((item) => item.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};

const TASK = value('task', 'patrol');
const DRY = flag('dry');
const WHALE_URL = String(process.env.WHALE_URL ?? '').replace(/\/+$/, '');
const WHALE_TOKEN = String(process.env.WHALE_TOKEN ?? '');

/** 把状态隔离在一个临时 DSH_HOME 里，插件那套读写逻辑原样复用。 */
const HOME = process.env.RUNNER_HOME ?? join(tmpdir(), 'whale-state');
mkdirSync(HOME, { recursive: true });
process.env.DSH_HOME = HOME;
/** 插件把状态放在 $DSH_HOME/bilibili-whale（看 lib/config.js 的 stateDir），别写错层。 */
const STATE = join(HOME, 'bilibili-whale');
mkdirSync(STATE, { recursive: true });

const say = (line) => console.log(line);
const summary = [];

/** 调遥控台。 */
async function panel(path, { method = 'GET', body } = {}) {
  if (WHALE_URL === '' || WHALE_TOKEN === '') throw new Error('缺少 WHALE_URL / WHALE_TOKEN');
  const response = await fetch(`${WHALE_URL}${path}`, {
    method,
    headers: { 'x-whale-token': WHALE_TOKEN, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (response.ok !== true) {
    throw new Error(`遥控台 ${path} 返回 ${response.status}：${payload?.error ?? ''}`);
  }
  return payload;
}

/**
 * 把云端的账本/cookie 落到临时目录，让 lib/ 当它们是本机状态。
 */
async function pullState() {
  const state = await panel('/state');
  const cookies = { ...(state.cookies ?? {}) };
  // 云端 IP 跟本机不是同一个：带着本机的 buvid 指纹去请求，风控会甩 -352。
  // 只留登录凭据（SESSDATA / bili_jct / DedeUserID），让 ensureBuvid() 用这台机器的 IP 现领一份指纹。
  for (const key of ['buvid3', 'buvid4', 'b_nut', 'b_lsid', 'buvid_fp', '_uuid', 'bili_ticket', 'bili_ticket_expires']) {
    delete cookies[key];
  }
  if (Object.keys(cookies).length === 0 && process.env.BILI_COOKIES) {
    const seed = JSON.parse(process.env.BILI_COOKIES);
    Object.assign(cookies, seed?.cookies ?? seed);
  }
  writeFileSync(join(STATE, 'cookies.json'), JSON.stringify({ cookies, savedAt: new Date().toISOString() }, null, 2));
  if (state.config && Object.keys(state.config).length > 0) {
    writeFileSync(join(STATE, 'config.json'), JSON.stringify(state.config, null, 2));
  }
  if (state.ledger) writeFileSync(join(STATE, 'ledger.json'), JSON.stringify(state.ledger, null, 2));
  return { cookies, pending: state.pending ?? [], meta: state.meta ?? {} };
}

/** 把干完的结果推回遥控台（cookie 可能被 B 站刷新过，必须带回去）。 */
async function pushState({ pending, meta }) {
  const { loadLedger, saveLedger } = await import('../lib/ledger.js');
  const { loadSession } = await import('../lib/cookies.js');
  const ledger = loadLedger();
  saveLedger(ledger);
  const session = loadSession();
  const payload = {
    cookies: session?.cookies ?? {},
    ledger,
    pending,
    meta,
    runner: { at: new Date().toISOString(), task: TASK },
  };
  if (DRY) {
    say('（dry-run：不写回遥控台）');
    return payload;
  }
  await panel('/state', { method: 'POST', body: payload });
  return payload;
}

/** 统一跑一个工具，把错误变成一行日志而不是崩溃。 */
function makeRunner(tools) {
  return async function run(name, args = {}) {
    const tool = tools.find((item) => item.name === name);
    if (tool === undefined) throw new Error(`没有工具 ${name}`);
    return await tool.execute(args, {});
  };
}

/** 主人优先的评论回复：主人（或另一位主人）在评论区点了她，就用脑子回一条真的。 */
async function replyOwners(run, { cfg }) {
  if (cfg.policy?.postReply === 'off') return { replied: 0, pendingOwnerComments: 0 };
  const { composeCommentReply } = await import('../lib/compose.js');
  const inbox = await run('bili_inbox', { op: 'check', count: 10 });
  const targets = (inbox?.targets ?? []).filter(
    (item) => item.owner === true && item.answered !== true && item.oid !== null && item.oid !== undefined,
  );
  if (targets.length === 0) return { replied: 0, pendingOwnerComments: 0 };
  for (const target of targets) {
    // 只处理视频评论（动态/专栏的 oid 不能当视频 aid 用）。
    if (target.business !== '' && target.business !== 'reply' && target.business !== 'video') continue;
    const video = await run('bili_video', { id: String(target.oid) });
    const message = await composeCommentReply({
      cfg,
      video,
      comment: { uname: target.uname, message: target.message },
      extra: `对方是主人（${target.uname}），回得亲昵一点、别客套。`,
    });
    if (message === null) continue;
    const sent = await run('bili_reply', {
      id: String(target.oid),
      rpid: target.rpid,
      root: target.replyRoot,
      mid: target.mid,
      uname: target.uname,
      message,
      confirm: true,
    });
    // 一轮只回主人一条，别刷屏。
    return { replied: sent?.allowed === false ? 0 : 1, pendingOwnerComments: targets.length, blocked: sent?.allowed === false ? (sent.reasons ?? []).join('；') : '' };
  }
  return { replied: 0, pendingOwnerComments: targets.length };
}

/** 挑视频 → 写评论：默认 confirm 时只排队，等遥控台点头。 */
async function patrolComments(run, { cfg, pending }) {
  const { composeVideoComment } = await import('../lib/compose.js');
  const { checkVideoComment } = await import('../lib/policy.js');
  const { loadLedger, commentedVideo } = await import('../lib/ledger.js');
  const ledger = loadLedger();
  const sources = cfg.feed?.sources ?? ['popular'];
  const exclude = cfg.feed?.excludeKeywords ?? [];
  const queued = [];
  const posted = [];

  for (const source of sources) {
    let items = [];
    try {
      const feed = await run('bili_feed', { source, count: 12 });
      // 注意：bili_feed 工具返回的是 { source, videos, notes }，字段名是 videos 不是 items。
      items = feed?.videos ?? feed?.items ?? [];
    } catch (issue) {
      summary.push(`源 ${source} 拉取失败：${String(issue?.message ?? issue).slice(0, 80)}`);
      continue;
    }
    let seen = 0;
    for (const item of items) {
      const title = String(item.title ?? '');
      if (title === '' || exclude.some((word) => title.includes(word))) continue;
      if (commentedVideo(ledger, item.bvid) === true) {
        seen += 1;
        continue;
      }
      if (pending.some((draft) => draft.bvid === item.bvid)) continue;
      // 一轮只挑一个视频，避免待确认箱被塞满。
      const video = await run('bili_video', { id: item.bvid, comments: 8 });
      const message = await composeVideoComment({ cfg, video, topComments: video?.hotComments ?? [] });
      if (message === null) {
        summary.push(`《${title.slice(0, 24)}》脑子没写出话来，跳过`);
        continue;
      }
      const verdict = checkVideoComment({ cfg, ledger, video, message, confirm: false });
      if (verdict.needsConfirm === true) {
        queued.push({
          id: `${item.bvid}-${Date.now().toString(36)}`,
          bvid: item.bvid,
          aid: video?.aid ?? item.aid ?? 0,
          title: title.slice(0, 80),
          upName: String(video?.author ?? item.author ?? '').slice(0, 40),
          message,
          at: new Date().toISOString(),
          approved: false,
        });
        return { queued, posted, note: '已排队一条评论草稿，等遥控台点头' };
      }
      if (verdict.allowed === true) {
        const sent = await run('bili_comment', { id: item.bvid, message, confirm: true });
        if (sent?.allowed !== false) posted.push(item.bvid);
        return { queued, posted, note: '评论已自动发出（策略允许）' };
      }
      summary.push(`跳过 ${item.bvid}：${(verdict.reasons ?? []).join('；').slice(0, 80)}`);
    }
    summary.push(`源 ${source}：${items.length} 条（已看过 ${seen} 条）`);
  }
  return { queued, posted, note: '这轮没有合适的视频' };
}

/**
 * 自主学习：没人指定也自己找视频学。
 * 一轮 = 挑方向 → 挑片 → 写笔记（存临时账本）→ 觉得有意义就去留言。
 * 留言走的是本机同一套策略：`postVideoComment=confirm` 时只排队，草稿带回遥控台等主人点头。
 */
async function studyRound(run, { cfg, pending }) {
  if (cfg.learning?.enabled === false) return { studied: 0, queued: 0, commented: 0, blocked: 0 };
  const { loadPending } = await import('../lib/pending.js');
  const before = new Set((loadPending().drafts ?? []).map((draft) => draft.id));
  let report = null;
  try {
    report = await run('bili_study', { op: 'learn', count: cfg.learning?.perRun ?? 2 });
  } catch (issue) {
    summary.push(`自主学习失败：${String(issue?.message ?? issue).slice(0, 120)}`);
    return { studied: 0, queued: 0, commented: 0, blocked: 0 };
  }
  // 学完的草稿落在临时 pending.json 里，要带回遥控台（否则主人永远看不到）。
  const fresh = (loadPending().drafts ?? []).filter((draft) => before.has(draft.id) !== true && draft.posted !== true);
  for (const draft of fresh) {
    if (pending.some((item) => item.bvid === draft.bvid)) continue;
    pending.push(draft);
  }
  const commented = Array.isArray(report?.commented) ? report.commented.length : 0;
  const blocked = Array.isArray(report?.blocked) ? report.blocked.length : 0;
  return {
    studied: Array.isArray(report?.notes) ? report.notes.length : 0,
    queued: fresh.length,
    commented,
    blocked,
    topic: report?.topic ?? '',
  };
}

/** 把遥控台上「已点头」的草稿真正发出去。 */async function postApproved(run, pending) {
  const { loadLedger, recordComment } = await import('../lib/ledger.js');
  const { checkVideoComment } = await import('../lib/policy.js');
  const { resolveConfig } = await import('../lib/config.js');
  const cfg = resolveConfig({});
  const ledger = loadLedger();
  const done = [];
  for (const draft of pending) {
    if (draft.approved !== true || draft.posted === true) continue;
    const verdict = checkVideoComment({ cfg, ledger, bvid: draft.bvid, message: draft.message, confirm: true });
    if (verdict.allowed !== true) {
      summary.push(`草稿 ${draft.bvid} 未通过复核：${(verdict.reasons ?? []).join('；').slice(0, 80)}`);
      continue;
    }
    const sent = await run('bili_comment', { id: draft.bvid, message: draft.message, confirm: true });
    if (sent?.allowed === false) {
      summary.push(`草稿 ${draft.bvid} 发送被策略拦下`);
      continue;
    }
    recordComment(ledger, { bvid: draft.bvid, aid: draft.aid ?? 0, rpid: sent?.rpid ?? 0, text: draft.message });
    draft.posted = true;
    draft.postedAt = new Date().toISOString();
    done.push(draft.bvid);
  }
  const { saveLedger } = await import('../lib/ledger.js');
  saveLedger(ledger);
  return done;
}

async function main() {
  say(`== 小鲸鱼娘云端巡检：${TASK} @ ${new Date().toISOString()}`);
  const state = await pullState();
  say(`状态拉取完成：cookie ${Object.keys(state.cookies).length} 项 · 账本草稿 ${state.pending.length} 条`);

  const { buildBiliTools } = await import('../lib/tools.js');
  const { resolveConfig } = await import('../lib/config.js');
  const tools = buildBiliTools({ pluginConfig: {} });
  const run = makeRunner(tools);
  const cfg = resolveConfig({});

  const status = await run('bili_status', {});
  say(`登录：${status?.loggedIn === true ? '已登录' : '未登录'} · 等级 Lv${status?.level ?? '?'} · 可写：${status?.canWrite === true ? '是' : '否'}`);
  if (status?.loggedIn !== true) {
    summary.push('未登录（cookie 可能过期），本轮只写日志不做动作');
  } else {
    // ① 主人点头过的草稿先发。
    const approved = await postApproved(run, state.pending);
    if (approved.length > 0) summary.push(`放行草稿 ${approved.length} 条：${approved.join(', ')}`);

    // ② 私信：主人的话由「脑子」现场回。
    if (TASK === 'patrol' || TASK === 'dm') {
      try {
        const ack = await run('bili_dm', { op: 'ack', size: 20 });
        const skipped = Array.isArray(ack?.skipped) ? ack.skipped.length : 0;
        summary.push(`私信巡检：回了 ${ack?.acked ?? 0} 条${skipped > 0 ? `，跳过 ${skipped} 个会话` : ''}`);
      } catch (issue) {
        summary.push(`私信巡检失败：${String(issue?.message ?? issue).slice(0, 120)}`);
      }
    }

    // ③ 评论区：主人的回复 + 视频一级评论草稿。
    if (TASK === 'patrol') {
      const inbox = await replyOwners(run, { cfg });
      if (inbox.replied > 0) summary.push('已回主人 1 条评论');
      else if (inbox.pendingOwnerComments > 0) summary.push(`主人的评论待回 ${inbox.pendingOwnerComments} 条${inbox.blocked ? `（被拦：${inbox.blocked.slice(0, 60)}）` : ''}`);

      const picked = await patrolComments(run, { cfg, pending: state.pending });
      if (picked.queued.length > 0) {
        state.pending.push(...picked.queued);
        summary.push(`排队评论草稿 ${picked.queued.length} 条（等遥控台点头）`);
      }
      if (picked.posted.length > 0) summary.push(`自动发评论 ${picked.posted.length} 条`);
      if (picked.note) summary.push(picked.note);
    }

    // ④ 自主学习：自己找方向、自己挑片、自己写笔记；值得留言的草稿进待确认箱。
    if (TASK === 'study' || cfg.learning?.inPatrol === true) {
      const studied = await studyRound(run, { cfg, pending: state.pending });
      if (studied.studied > 0) summary.push(`自学 ${studied.studied} 个视频（方向 ${studied.topic || '轮换'}）`);
      if (studied.queued > 0) summary.push(`排队学习留言 ${studied.queued} 条（等遥控台点头）`);
      if (studied.commented > 0) summary.push(`自动留言 ${studied.commented} 条`);
      if (studied.blocked > 0) summary.push(`学习留言被拦 ${studied.blocked} 条`);
      if (studied.studied === 0) summary.push('这轮没挑到合适的学习视频');
    }

    // ⑤ 每日学习动态（本地时间 20:30 之后、当天还没发；优先用当天笔记合成）。
    if (TASK === 'patrol' || TASK === 'daily' || TASK === 'study') {
      const now = new Date();
      const at = String(cfg.dailyDynamic?.at ?? '20:30');
      const [hour, minute] = at.split(':').map((part) => Number(part));
      const due = now.getHours() > hour || (now.getHours() === hour && now.getMinutes() >= minute);
      if (cfg.dailyDynamic?.enabled !== false && due === true) {
        try {
          const posted = await run('bili_dynamic', { auto: true });
          summary.push(posted?.allowed === false ? `动态没发：${(posted.reasons ?? []).join('；')}` : '动态已发');
        } catch (issue) {
          summary.push(`动态失败：${String(issue?.message ?? issue).slice(0, 120)}`);
        }
      } else {
        summary.push(`动态未到点（${at} 之后发）`);
      }
    }
  }

  const pushed = await pushState({ pending: state.pending, meta: state.meta });
  const line = summary.join(' · ');
  say(`== 结果：${line === '' ? '无事发生' : line}`);
  if (DRY !== true) {
    // 遥控台的日志柜：一行计数，方便主人事后翻「她今天都干了啥」。
    await panel('/log', {
      method: 'POST',
      body: { at: new Date().toISOString(), task: TASK, line, counts: pushed.ledger?.daily ?? {} },
    }).catch(() => null);
  }
}

main().catch((error) => {
  console.error(`云端巡检崩了：${error?.stack ?? error}`);
  process.exitCode = 1;
});
