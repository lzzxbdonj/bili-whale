/**
 * 巡检（cron 每 10 分钟 + 手动 `POST /patrol`）：小鲸鱼娘在云端的一趟「上班」。
 *
 * 一趟做四件事，任何一步失败都不影响其它步骤（全部 try/catch，绝不向上抛）：
 *   1. 探活：nav 拿登录态 / 等级 / UID  —— Lv0（未转正）时 B 站会拒发（错误码 4126021）。
 *   2. 回消息中心：有人回她 → 按 `policy.checkReply` 判定（主人优先、别人每人每条串一条/24h）
 *      → 允许就发楼中楼回复；不许就记下原因。
 *   3. 视频一级评论：从推荐/热门榜挑没评论过的视频 → AI 起草 → `confirm` 模式**只排队**
 *      等主人点头（`/pending` → `/approve`），`auto` 模式直接发。
 *   4. 每日动态：到点（`dailyDynamic.at`，主人时区）且今天没发过 → 起草并发出。
 *
 * 观察模式（`observeOnly=true`）与 Lv0 期间：只读 + 排队，绝不发写请求；动态草稿存进
 * `meta.pendingDynamic`，转正后由主人放行。
 *
 * 时区：Workers 进程是 UTC，而账本里的「今天」和动态时刻都按主人时区算 —— 这里把
 * `now` 整体平移一个时区偏移再交给 policy/ledger（记录时同样用平移后的时间戳），
 * 保证「每天最多 3 条评论」这类配额以北京时间的零点换日。
 *
 * @module bili-whale/patrol
 */

import { BiliClient, BiliError } from './bili.js';
import { DEFAULTS, checkDynamic, checkReply, checkVideoComment, isOwnerTarget, ownerMentionList, titleBlocked, titleOnTopic } from './policy.js';
import {
  commentedVideo,
  createLedger,
  dynamicPostedToday,
  recordComment,
  recordDynamic,
  recordReply,
  snapshotLedger,
  takeMaterial,
  threadReplyCount,
} from './ledger.js';
import { draftDynamic, draftReply, draftVideoComment } from './persona.js';
import { appendCloudLog, loadState, saveCookies, saveLedger, saveMeta, savePending } from './store.js';

/** 待确认队列上限（超出丢最旧的）。 */
export const MAX_PENDING = 20;

/**
 * 主人时区相对 UTC 的偏移（毫秒）。
 * @param timezone - IANA 时区名。
 * @param at - 参考时刻。
 */
export function timezoneShiftMs(timezone = 'Asia/Shanghai', at = new Date()) {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = Object.fromEntries(formatter.formatToParts(at).map((part) => [part.type, part.value]));
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute),
      Number(parts.second),
    );
    return asUtc - at.getTime();
  } catch {
    return 8 * 3600000;
  }
}

/** 排进待确认队列（同一个视频只留最新一条）。 */
export function enqueueDraft(state, draft) {
  state.pending = (Array.isArray(state.pending) ? state.pending : []).filter((item) => item.bvid !== draft.bvid);
  state.pending.push({ id: `${draft.bvid}-${Date.now().toString(36)}`, createdAt: new Date().toISOString(), ...draft });
  while (state.pending.length > MAX_PENDING) state.pending.shift();
  return state.pending[state.pending.length - 1];
}

/** 从消息中心条目里挖出视频 id（bvid 优先，退而求其次用 aid/oid）。 */
export function videoRefFromMessage(item) {
  let blob = '';
  try {
    blob = JSON.stringify(item?.raw ?? {});
  } catch {
    blob = '';
  }
  const bvid = /BV[0-9A-Za-z]{10}/.exec(blob);
  if (bvid !== null) return { bvid: bvid[0] };
  const uri = /bilibili:\/\/video\/(\d+)/.exec(blob);
  if (uri !== null) return { aid: Number(uri[1]) };
  const oid = Number(item?.oid);
  if (Number.isFinite(oid) && oid > 0) return { aid: oid };
  return null;
}

/** 视频标题/标签是否命中「不想评论的话题」词表。 */
function hitsExclude(video, cfg) {
  const list = Array.isArray(cfg?.feed?.excludeKeywords) ? cfg.feed.excludeKeywords : [];
  const haystack = `${video?.title ?? ''} ${Array.isArray(video?.tags) ? video.tags.join(' ') : ''}`;
  return list.find((word) => typeof word === 'string' && word !== '' && haystack.includes(word)) ?? null;
}

/** 从配置的刷流来源里挑一批候选视频（按顺序尝试，失败自动换下一个源）。 */
async function pickCandidates(client, cfg, state, limit = 3) {
  const sources = Array.isArray(cfg?.feed?.sources) && cfg.feed.sources.length > 0 ? cfg.feed.sources : ['popular'];
  const ps = Number(cfg?.feed?.ps) || 12;
  const picked = [];
  const notes = [];
  for (const source of sources) {
    if (picked.length >= limit) break;
    try {
      let items = [];
      if (source === 'rcmd') items = await client.rcmd(Math.max(ps, 12));
      else if (source === 'ranking') items = await client.ranking(0, 'all');
      else items = await client.popular(Math.max(ps, 12), 1);
      for (const video of items) {
        if (picked.length >= limit) break;
        if (typeof video?.bvid !== 'string' || video.bvid === '') continue;
        if (commentedVideo(state.ledger, video.bvid) !== null) continue;
        const excluded = hitsExclude(video, cfg);
        if (excluded !== null) {
          notes.push(`跳过《${String(video.title ?? '').slice(0, 24)}》：命中排除词「${excluded}」`);
          continue;
        }
        // 内容把关（2026-10-05 起）：擦边/八卦/暴富这类标题一律不评论，
        // 不在话题里的也不评论 —— 以前只看播放量，待确认箱里因此出现过擦边垃圾。
        const banned = titleBlocked(cfg, video.title, video.tags ?? []);
        if (banned !== null) {
          notes.push(`跳过《${String(video.title ?? '').slice(0, 24)}》：标题黑名单「${banned}」`);
          continue;
        }
        if (!titleOnTopic(cfg, video.title, video.tags ?? [])) {
          notes.push(`跳过《${String(video.title ?? '').slice(0, 24)}》：不在话题范围（feed.topicsOnly）`);
          continue;
        }
        if (picked.some((item) => item.bvid === video.bvid)) continue;
        picked.push({ ...video, source });
      }
    } catch (issue) {
      notes.push(`源 ${source} 拉取失败：${issue instanceof BiliError ? `${issue.code} ${issue.message}` : String(issue?.message ?? issue)}`);
    }
  }
  return { picked, notes };
}

/**
 * 跑一趟巡检。
 * @param env - Worker 环境（WHALE_KV / BILI_COOKIES / AI / ADMIN_TOKEN / vars）。
 * @param options.trigger - 'cron' | 'manual'。
 * @param options.ctx - Worker 执行上下文（可选，用于 waitUntil）。
 * @param options.state - 已经 loadState 过的状态（调用方想省一次读 KV 时传入）。
 */
export async function runPatrol(env, { trigger = 'cron', ctx, state: providedState } = {}) {
  const startedAt = Date.now();
  const state = providedState ?? (await loadState(env, { defaults: DEFAULTS }));
  const cfg = state.cfg ?? DEFAULTS;
  const ledger = createLedger(state.ledger);
  state.ledger = ledger;
  state.pending = Array.isArray(state.pending) ? state.pending : [];
  state.meta = state.meta ?? {};
  if (typeof ledger.msgSeen !== 'object' || ledger.msgSeen === null) ledger.msgSeen = {};

  const shift = timezoneShiftMs(cfg.timezone ?? 'Asia/Shanghai', new Date(startedAt));
  const policyNow = startedAt + shift;
  const policyDate = new Date(policyNow);

  const summary = {
    trigger,
    at: new Date(startedAt).toISOString(),
    loggedIn: false,
    level: null,
    observeOnly: cfg.observeOnly === true,
    canWrite: false,
    inbox: { total: 0, replied: 0, skipped: 0, deferred: 0, queued: 0 },
    videoComments: { queued: 0, posted: 0 },
    dynamic: { posted: null, skipped: null },
    notes: [],
    errors: [],
  };

  const cookieBag = { ...(state.cookies ?? {}) };
  const client = new BiliClient({
    cookies: cookieBag,
    onCookies: (patch) => Object.assign(cookieBag, patch),
  });

  // ── 1. 探活 ────────────────────────────────────────────────────────────────
  let nav = null;
  try {
    nav = await client.nav();
  } catch (issue) {
    summary.errors.push(`nav：${issue instanceof BiliError ? `${issue.code} ${issue.message}` : String(issue?.message ?? issue)}`);
  }
  summary.loggedIn = nav?.isLogin === true;
  summary.level = nav?.level ?? null;
  const selfMid = nav?.mid ?? cfg.whaleMid ?? null;
  const levelLimited = Number(nav?.level ?? 0) === 0;
  const canWrite = summary.loggedIn && cfg.observeOnly !== true && !levelLimited;
  summary.canWrite = canWrite;
  if (levelLimited && nav !== null) {
    const todayKey = policyDate.toISOString().slice(0, 10);
    if (state.meta.levelNoteDate !== todayKey) {
      state.meta.levelNoteDate = todayKey;
      summary.notes.push('账号仍是 Lv0（未转正）：B 站会拒发（4126021），本轮只读 + 排队，请主人先做转正答题。');
    }
  }
  if (cfg.observeOnly === true) summary.notes.push('观察模式开着：只读 + 排队，不发任何写请求。');

  // ── 2. 消息中心 → 自动回复 ──────────────────────────────────────────────────
  if (summary.loggedIn) {
    try {
      // 「回复我的」和「@我的」是两个接口：只读前者时，主人在评论里 @ 她会毫无反应。
      const feed = await client.msgReplies({ ps: 20 });
      let mentionFeed = { items: [] };
      try {
        mentionFeed = await client.msgMentions({ ps: 20 });
      } catch (issue) {
        summary.errors.push(`读「@我的」：${issue instanceof BiliError ? `${issue.code} ${issue.message}` : String(issue?.message ?? issue)}`);
      }
      const inboxItems = [...(mentionFeed.items ?? []), ...feed.items];
      summary.inbox.total = inboxItems.length;
      const seenThreads = new Set();
      // 一轮最多回几条（policy.replyPerRun），陌生人另有更小的额度（replyPerRunOthers）。
      const perRun = Math.max(1, Number(cfg.policy?.replyPerRun ?? 3) || 3);
      const perRunOthers = Math.max(0, Number(cfg.policy?.replyPerRunOthers ?? 1) || 0);
      const toOthers = cfg.policy?.replyToOthers !== false;
      let othersDone = 0;
      for (const item of inboxItems) {
        if (summary.inbox.replied >= perRun) break;
        try {
          if (item.mid === null || item.mid === undefined || String(item.mid) === String(selfMid)) continue;
          const replyRoot = item.root || item.rpid;
          const dedupe = `${replyRoot}|${item.mid}`;
          if (seenThreads.has(dedupe)) continue;
          seenThreads.add(dedupe);
          if (ledger.msgSeen[String(item.id)] !== undefined) {
            summary.inbox.skipped += 1;
            continue;
          }
          const owner = isOwnerTarget(cfg, { mid: item.mid, uname: item.uname });
          if (!owner && !toOthers) {
            summary.inbox.skipped += 1;
            continue;
          }
          if (!owner && othersDone >= perRunOthers) {
            summary.inbox.skipped += 1;
            continue;
          }
          const answered = threadReplyCount(ledger, replyRoot, item.mid) > 0;
          if (answered && !owner) {
            ledger.msgSeen[String(item.id)] = { at: new Date().toISOString(), skipped: '这串已经回过了' };
            summary.inbox.skipped += 1;
            continue;
          }
          const ref = videoRefFromMessage(item);
          // 动态下面的评论：oid 就是动态 id（subject_id），走 type=17 发得出去；认不出就跳过。
          const rawBusiness = String(item.business ?? '');
          const hasBvid = typeof ref?.bvid === 'string' && ref.bvid !== '';
          const isDynamic = hasBvid !== true && (rawBusiness === 'dynamic' || rawBusiness === '动态');
          if (ref === null && !isDynamic) {
            ledger.msgSeen[String(item.id)] = { at: new Date().toISOString(), skipped: '认不出视频 id' };
            summary.inbox.skipped += 1;
            continue;
          }
          // @ 我的消息里 `oid` 是那条 @ 评论的 rpid，不是被评论的对象：动态认 subject_id、视频认 BV 号。
          const oid = isDynamic
            ? String(item.dynamicId ?? item.aid ?? item.oid)
            : String(ref.bvid ?? ref.aid ?? item.oid);
          // 把视频信息、她自己的原话、楼上这一串一起喂给脑子，回复才接得住话。
          let detail = null;
          if (!isDynamic) {
            try {
              detail = await client.video(oid);
            } catch {
              detail = null;
            }
          }
          let thread = [];
          if (!isDynamic) {
            try {
              const rows = await client.threadReplies({ aid: detail?.aid ?? ref.aid, bvid: detail?.bvid ?? ref.bvid, root: replyRoot, ps: 20 });
              thread = rows?.replies ?? [];
            } catch {
              thread = [];
            }
          }
          const recentReplies = Object.values(ledger.replies ?? {}).slice(-5).map((row) => String(row?.text ?? '')).filter((line) => line !== '');
          const target = { mid: item.mid, uname: item.uname, message: item.message, subject: item.subject, isOwner: owner };
          const draft = await draftReply(env, cfg, {
            target,
            theirText: item.message,
            selfText: item.myMessage,
            thread,
            recentReplies,
            video: detail,
            subject: item.subject,
          });
          const verdict = checkReply({
            cfg,
            ledger,
            bvid: ref?.bvid ?? ref?.aid ?? oid,
            root: replyRoot,
            rpid: item.rpid,
            message: draft,
            toMid: item.mid,
            toName: item.uname,
            selfMid,
            now: policyNow,
          });
          if (verdict.allowed !== true) {
            const reason = verdict.needsConfirm === true
              ? '回复是草稿模式，等主人点头'
              : (verdict.reasons[0] ?? '策略拦下');
            ledger.msgSeen[String(item.id)] = { at: new Date().toISOString(), skipped: reason };
            summary.inbox.skipped += 1;
            summary.notes.push(`不回「${item.uname}」：${reason}`);
            continue;
          }
          if (!canWrite) {
            // 注意：**不能**记进 msgSeen —— 观察模式 / 未转正只是「暂时发不了」，
            // 等到能写的那天这条还得补回，标记成已读就永远丢了。
            summary.inbox.deferred += 1;
            continue;
          }
          const created = await client.commentAdd({
            aid: isDynamic ? oid : (detail?.aid ?? ref?.aid),
            bvid: detail?.bvid ?? ref?.bvid ?? null,
            message: draft,
            root: verdict.rootRpid,
            parent: item.rpid,
            mentions: ownerMentionList(cfg),
            type: isDynamic ? 17 : 1,
          });
          const selfRpid = created?.rpid ?? null;
          recordReply(ledger, {
            bvid: detail?.bvid ?? ref?.bvid ?? null,
            aid: isDynamic ? Number(oid) : (detail?.aid ?? ref?.aid),
            rpid: item.rpid,
            root: verdict.rootRpid,
            targetMid: item.mid,
            targetUname: item.uname,
            text: draft,
            selfRpid,
            isOwner: owner,
            ts: policyNow,
            now: policyDate,
          });
          ledger.msgSeen[String(item.id)] = { at: new Date().toISOString(), auto: true, selfRpid };
          summary.inbox.replied += 1;
          if (!owner) othersDone += 1;
        } catch (issue) {
          summary.errors.push(`回复 ${item?.uname ?? item?.mid}：${issue instanceof BiliError ? `${issue.code} ${issue.message}` : String(issue?.message ?? issue)}`);
        }
      }
    } catch (issue) {
      summary.errors.push(`读消息中心：${issue instanceof BiliError ? `${issue.code} ${issue.message}` : String(issue?.message ?? issue)}`);
    }
    if (summary.inbox.deferred > 0) {
      summary.notes.push(
        `消息中心有 ${summary.inbox.deferred} 条等着回（${cfg.observeOnly === true ? '观察模式' : '未转正/未登录'}，先存着不会丢）。`,
      );
    }
  }

  // ── 3. 视频一级评论（confirm → 排队；auto → 直接发） ────────────────────────
  try {
    const mode = cfg.policy?.postVideoComment ?? 'confirm';
    if (mode !== 'off') {
      const { picked, notes } = await pickCandidates(client, cfg, state, 3);
      summary.notes.push(...notes.slice(0, 5));
      let queued = 0;
      for (const video of picked) {
        const draft = await draftVideoComment(env, cfg, video);
        const verdict = checkVideoComment({
          cfg,
          ledger,
          bvid: video.bvid,
          message: draft,
          confirm: false,
          now: policyNow,
        });
        if (verdict.needsConfirm === true && verdict.reasons.length === 0) {
          enqueueDraft(state, {
            bvid: video.bvid,
            aid: video.aid ?? null,
            title: video.title ?? '',
            upName: video.author ?? '',
            message: draft,
            source: `patrol:${video.source ?? 'feed'}`,
          });
          summary.videoComments.queued += 1;
          queued += 1;
          // 一趟只排一条草稿：cron 每 10 分钟一次，排太多会让主人的待确认箱变成垃圾场
          break;
        }
        // 注意：有硬性拦截理由（配额用尽 / 间隔太短 / 撞屏蔽词）时**不排队**，
        // 否则主人的待确认箱里会堆满「点了也发不出去」的草稿。
        if (verdict.allowed !== true) {
          summary.notes.push(`不评论《${String(video.title ?? '').slice(0, 24)}》：${verdict.reasons[0] ?? '策略拦下'}`);
          continue;
        }
        // auto 模式但云端自己发不出去（观察模式 / 出口 IP 被 -412 拦 / 未转正）：
        // 也要把草稿**标成已同意**交给手脚（本机在线是本机，关机是 GitHub Actions）。
        // 踩过的坑：这里以前直接 `continue`，于是 auto 模式下既没草稿也没评论，
        // 主人看到的就是「怎么没刷视频/一条评论都没有」。
        if (!canWrite) {
          enqueueDraft(state, {
            bvid: video.bvid,
            aid: video.aid ?? null,
            title: video.title ?? '',
            upName: video.author ?? '',
            message: draft,
            source: `patrol:${video.source ?? 'feed'}`,
            approved: true,
            approvedAt: new Date().toISOString(),
            approvedBy: 'policy:auto',
          });
          summary.videoComments.queued += 1;
          summary.notes.push(`《${String(video.title ?? '').slice(0, 24)}》按 auto 策略排队，等手脚发送（云端发不出去）`);
          break;
        }
        const detail = video.aid !== undefined && video.aid !== null ? video : await client.video(video.bvid);
        const created = await client.commentAdd({ aid: detail.aid, bvid: video.bvid, message: draft, mentions: ownerMentionList(cfg) });
        recordComment(ledger, {
          bvid: video.bvid,
          aid: detail.aid,
          rpid: created?.rpid ?? null,
          text: draft,
          ts: policyNow,
          now: policyDate,
        });
        summary.videoComments.posted += 1;
      }
      if (queued > 0 && canWrite) summary.notes.push(`有 ${queued} 条视频评论草稿等主人点头（/pending → /approve）。`);
    }
  } catch (issue) {
    summary.errors.push(`视频评论：${issue instanceof BiliError ? `${issue.code} ${issue.message}` : String(issue?.message ?? issue)}`);
  }

  // ── 4. 每日学习动态 ────────────────────────────────────────────────────────
  try {
    const enabled = cfg.dailyDynamic?.enabled === true;
    const mode = cfg.policy?.postDynamic ?? 'auto';
    if (!enabled) {
      summary.dynamic.skipped = 'dailyDynamic.enabled = false';
    } else if (mode === 'off') {
      summary.dynamic.skipped = 'postDynamic = off';
    } else if (dynamicPostedToday(ledger, policyDate)) {
      summary.dynamic.skipped = '今天已经发过了';
    } else {
      const at = String(cfg.dailyDynamic?.at ?? '20:30');
      const match = /^(\d{1,2}):(\d{2})$/.exec(at.trim());
      const atMinutes = match === null ? 20 * 60 + 30 : Number(match[1]) * 60 + Number(match[2]);
      const localMinutes = policyDate.getUTCHours() * 60 + policyDate.getUTCMinutes();
      if (localMinutes < atMinutes) {
        summary.dynamic.skipped = `还没到点（${at}）`;
      } else {
        const material = takeMaterial(ledger);
        const templateIndex = Number(ledger.dynamicTemplateIndex) || 0;
        const text = await draftDynamic(env, cfg, { templateIndex, material });
        const verdict = checkDynamic({ cfg, ledger, text, confirm: true, auto: true, now: policyNow });
        if (verdict.allowed !== true) {
          summary.dynamic.skipped = verdict.reasons[0] ?? '策略拦下';
          if (material !== null) putBackMaterial(ledger, material);
        } else if (!canWrite) {
          state.meta.pendingDynamic = { text, at: new Date().toISOString(), reason: cfg.observeOnly === true ? 'observeOnly' : '未转正/未登录' };
          summary.dynamic.skipped = state.meta.pendingDynamic.reason;
        } else {
          const created = await client.dynamicCreate(text, { mentions: ownerMentionList(cfg) });
          recordDynamic(ledger, {
            text,
            dynId: created?.dyn_id_str ?? created?.dynamic_id ?? null,
            ts: policyNow,
            now: policyDate,
          });
          if (material === null) ledger.dynamicTemplateIndex = templateIndex + 1;
          delete state.meta.pendingDynamic;
          summary.dynamic.posted = text;
        }
      }
    }
  } catch (issue) {
    summary.errors.push(`每日动态：${issue instanceof BiliError ? `${issue.code} ${issue.message}` : String(issue?.message ?? issue)}`);
  }

  // ── 5. 落盘 ────────────────────────────────────────────────────────────────
  try {
    snapshotLedger(ledger);
    await saveLedger(env, ledger);
    await savePending(env, state.pending);
    await saveCookies(env, cookieBag);
    state.meta.lastPatrolAt = new Date().toISOString();
    state.meta.lastTrigger = trigger;
    state.meta.lastPatrolResult = {
      trigger,
      loggedIn: summary.loggedIn,
      level: summary.level,
      canWrite,
      replied: summary.inbox.replied,
      deferred: summary.inbox.deferred,
      queued: summary.videoComments.queued,
      posted: summary.videoComments.posted,
      dynamic: summary.dynamic.posted === null ? null : 'posted',
      errors: summary.errors.length,
    };
    await saveMeta(env, state.meta);
    state.cookies = cookieBag;
  } catch (issue) {
    summary.errors.push(`落盘：${String(issue?.message ?? issue)}`);
  }

  const line = `patrol(${trigger}) 登录=${summary.loggedIn} 等级=${summary.level ?? '?'} 可写=${canWrite} 回复=${summary.inbox.replied} 待回=${summary.inbox.deferred} 评论草稿=${summary.videoComments.queued} 评论发出=${summary.videoComments.posted} 动态=${summary.dynamic.posted === null ? '未发' : '已发'}${summary.errors.length > 0 ? ` 错误=${summary.errors.length}` : ''}`;
  try {
    await appendCloudLog(env, line);
  } catch {
    /* 日志失败不影响结果 */
  }
  void ctx;
  return summary;
}

/** 动态没发成时把素材放回队列尾部（下次再用）。 */
function putBackMaterial(ledger, material) {
  if (!Array.isArray(ledger.materials)) ledger.materials = [];
  ledger.materials.push(material);
}
