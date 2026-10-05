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
/** `--always`：就算本机在岗也照跑（排查用；默认让位给本机）。 */
const ALWAYS = flag('always');
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

/**
 * 评论回复：主人（或另一位主人）在评论区点了她，就用脑子回一条真的；
 * 陌生人回复她也在额度里回（`policy.replyToOthers` / `replyPerRunOthers` 可关）。
 *
 * 编排在 `lib/reply.js`（宿主定时器、看门鲸、这里共用一份），
 * 这里只负责把 `run` 执行器和账本递进去。
 */
async function replyInbox(run, { cfg }) {
  if (cfg.policy?.postReply === 'off') return { replied: 0, pending: 0, drafts: [], failed: [], skipped: [] };
  const { runInboxReplies } = await import('../lib/reply.js');
  const { loadLedger } = await import('../lib/ledger.js');
  return await runInboxReplies({
    cfg,
    ledger: loadLedger(),
    run,
    log: (line) => say(`  · ${line}`),
  });
}

/** 挑视频 → 写评论：默认 confirm 时只排队，等遥控台点头。 */
async function patrolComments(run, { cfg, pending }) {
  const { composeVideoComment } = await import('../lib/compose.js');
  const { checkVideoComment, titleBlocked, titleOnTopic } = await import('../lib/policy.js');
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
      // 内容把关（跟 Worker 侧同一张词表）：擦边/八卦/暴富这类标题一律不评论；
      // 不在话题里的也不评论（feed.topicsOnly）。以前只看播放量，待确认箱里出现过擦边垃圾。
      const banned = titleBlocked(cfg, title, item.tags ?? []);
      if (banned !== null) {
        summary.push(`跳过《${title.slice(0, 24)}》：标题黑名单「${banned}」`);
        continue;
      }
      if (!titleOnTopic(cfg, title, item.tags ?? [])) {
        summary.push(`跳过《${title.slice(0, 24)}》：不在话题范围（feed.topicsOnly）`);
        continue;
      }
      // 一轮只挑一个视频，避免待确认箱被塞满。
      const video = await run('bili_video', { id: item.bvid, comments: 8 });

      // 刷过的视频进 B 站浏览记录；够「好内容」就随手三连并分类收藏（主人要求）。
      // 走 bili_triple 工具：策略、账本、落盘都由它管，三连是 confirm 模式时它只回判断。
      try {
        const { scoreVideo } = await import('../lib/study.js');
        const scored = scoreVideo(video, { topic: '', cfg, ledger });
        const acted = await run('bili_triple', { id: item.bvid, topic: '', score: scored });
        const short = title.slice(0, 24);
        if (acted?.history?.reported === true) summary.push(`《${short}》记进浏览记录了`);
        if (acted?.triple?.done === true) {
          summary.push(`三连《${short}》：点赞 + ${acted.triple.coin ?? 0} 币 + 收藏进「${acted.triple.folder?.title ?? ''}」`);
        } else if (acted?.triple?.needsConfirm === true) {
          summary.push(`《${short}》够好内容，但三连是 confirm 模式，没连`);
        } else if ((acted?.triple?.reasons ?? []).length > 0) {
          summary.push(`《${short}》没三连：${(acted.triple.reasons ?? []).join('；').slice(0, 60)}`);
        }
      } catch (issue) {
        summary.push(`三连/浏览记录失败：${String(issue?.message ?? issue).slice(0, 80)}`);
      }

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

/**
 * 「脑子」自检：云端这条线到底哪家模型能用。
 *
 * 为什么要有它：GitHub runner 上拿不到本机的 `logs/brain.log`，评论回不出来时只看到
 * 「脑子没给出正文」这一句，分不清是 whale（云端 Workers AI 额度用光）还是兜底的
 * pollinations（GitHub 出口 IP 被限流）出的问题。这个任务不碰 B 站，可以随时跑。
 */
async function brainCheck() {
  const { resolveConfig } = await import('../lib/config.js');
  const { brainConfig, askBrain } = await import('../lib/brain.js');
  const cfg = resolveConfig({});
  const brain = brainConfig(cfg);
  say(`脑子配置：provider=${brain.provider} · model=${brain.model || '(预设)'} · fallback=${brain.fallback === '' ? '(空)' : brain.fallback} · paid=${brain.paid === '' ? '(空)' : brain.paid} · enabled=${brain.enabled}`);
  const order = [brain.provider, ...String(brain.fallback ?? '').split(',').map((item) => item.trim()).filter((item) => item !== '')];
  for (const provider of [...new Set(order)]) {
    const t0 = Date.now();
    const text = await askBrain(
      { ...cfg, brain: { ...cfg.brain, provider, fallback: '' } },
      { system: '你是小鲸鱼娘，自称人家。', user: '用一句话说今天天气好。' },
    );
    say(`  ${provider}：${text === null ? '失败（原因见下）' : `成功 ${Date.now() - t0}ms：${text.slice(0, 40)}`}`);
  }
  // brain.log 只留「哪家、什么状态码」这些行，不带正文（公共仓库的日志谁都能看）。
  try {
    const { readFileSync, existsSync } = await import('node:fs');
    const path = join(STATE, 'logs', 'brain.log');
    if (existsSync(path)) {
      const lines = readFileSync(path, 'utf8').trimEnd().split('\n').slice(-8);
      for (const line of lines) say(`  brain.log｜${line.slice(0, 160)}`);
    }
  } catch (issue) {
    say(`  （brain.log 读不出来：${String(issue?.message ?? issue).slice(0, 80)}）`);
  }
}

async function main() {
  say(`== 小鲸鱼娘云端巡检：${TASK} @ ${new Date().toISOString()}`);
  const state = await pullState();
  say(`状态拉取完成：cookie ${Object.keys(state.cookies).length} 项 · 账本草稿 ${state.pending.length} 条`);

  // 脑子自检：不碰 B 站，所以放在「本机在岗就让位」前面。
  if (TASK === 'brain') {
    await brainCheck();
    say('== 结果：脑子自检完成');
    return;
  }

  // 本机在岗就让位。
  //
  // 主人 2026-10-05 问：「为什么我 AI 的 IP 一会在美国一会在浙江？」
  // 答案就在这条链路：GitHub Actions 的 runner 跑在 Azure（出口**美国**），本机是**浙江**家宽。
  // 云端如果在本机开着的时候也照跑，同一个 B 站账号就会「一会儿美国一会儿浙江」地活动，
  // 看着像被盗号 / 共享账号，纯属给风控递刀，而且 Actions 分钟数是白烧的。
  // Cloudflare Worker 的 cron 早就有这条判断（日志里的「本机在岗…云端只待命」），这里补上同一条。
  const LOCAL_TTL_MS = 30 * 60 * 1000;
  const seenAt = Number(state.meta?.localSeenAt ?? 0);
  const localFresh = seenAt > 0 && Date.now() - seenAt < LOCAL_TTL_MS;
  if (localFresh && ALWAYS !== true) {
    say(`本机在岗（${Math.round((Date.now() - seenAt) / 1000)} 秒前还有心跳）→ 云端让位，这轮不碰 B 站（想强制跑加 --always）`);
    return;
  }

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

    // ③ 评论区：该回的评论（主人优先，陌生人在额度内）+ 视频一级评论草稿。
    if (TASK === 'patrol') {
      const inbox = await replyInbox(run, { cfg });
      if (inbox.replied > 0) {
        const who = inbox.drafts.slice(0, 3).map((item) => `${item.uname}${item.owner ? '(主人)' : ''}`).join('、');
        summary.push(`回评论 ${inbox.replied} 条：${who}`);
      } else if (inbox.pending > 0) {
        summary.push(`评论待回 ${inbox.pending} 条${inbox.failed.length > 0 ? `（没回成：${String(inbox.failed[0]?.reason ?? '').slice(0, 60)}）` : ''}`);
      }
      for (const item of inbox.failed.slice(0, 2)) summary.push(`评论回复失败（${item.uname}）：${String(item.reason).slice(0, 60)}`);

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
