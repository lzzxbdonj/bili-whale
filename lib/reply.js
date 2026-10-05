/**
 * 评论回复的编排：从消息中心挑「该回谁」→ 写正文 → 发出去 → 记账。
 *
 * 主人 2026-10-05：「完善一下评论回复」。原来的回复链路有三个洞：
 *   1. 只回主人：陌生人回复她，她一声不吭（`item.owner === true` 的过滤）；
 *   2. 一轮只回一条：循环里直接 `return`，其余目标要等下一轮（云端 15 分钟一轮）；
 *   3. 只认视频评论：动态下的评论（`type=17`）根本发不出去。
 * 这里把「挑人、限额、写话、发送」收成一份，宿主定时器、看门鲸、云端巡检都走它，
 * 免得三处各写一套、口径不一。
 *
 * 挑人与限额都交给 `lib/policy.js` 的 `checkReply`（每人每串一条、每人 24 小时一条、
 * 每日上限、最小间隔），这里只决定「这一轮最多动几条」和「主人优先」。
 *
 * @module dsh-bilibili-whale/reply
 */
import { isOwner } from './policy.js';
import { loadLedger, repliedToComment } from './ledger.js';
import { withLock } from './lock.js';
import { hasReplied } from './replied.js';

/** 回复节奏与上限（都在 policy 里，主人可以改）。 */
export function replyLimits(cfg) {
  const policy = cfg?.policy ?? {};
  const perRun = Number(policy.replyPerRun ?? 3);
  const perRunOthers = Number(policy.replyPerRunOthers ?? 1);
  return {
    perRun: Math.max(1, Number.isFinite(perRun) ? perRun : 3),
    perRunOthers: Math.max(0, Number.isFinite(perRunOthers) ? perRunOthers : 1),
    toOthers: policy.replyToOthers !== false,
  };
}

/** 消息中心的目标能不能回（不涉及额度，只做「这条是不是能动的」判断）。 */
function replyable(cfg, target, selfMid) {
  if (target === null || typeof target !== 'object') return '目标不是一条消息';
  if (target.mid === null || target.mid === undefined) return '这条消息没带 UID，回不了';
  if (selfMid !== null && selfMid !== undefined && String(target.mid) === String(selfMid)) return '这是她自己';
  if (target.oid === null || target.oid === undefined || String(target.oid) === '') return '这条消息没带稿件/动态 id';
  const rpid = Number(target.rpid);
  if (!Number.isFinite(rpid) || rpid <= 0) return '这条消息没带评论 rpid';
  const business = String(target.business ?? '');
  const hasBvid = typeof target.bvid === 'string' && target.bvid !== '';
  // 真机上「@我的」里视频评论的 business 是中文「评论」、动态是「动态」，别只认英文那几个值。
  const known = ['', 'reply', 'video', 'dynamic', 'comment', '评论', '动态'];
  if (hasBvid !== true && !known.includes(business)) return `不认识的消息类型「${business}」`;
  if (cfg?.policy?.replyScope === 'owner-only' && isOwner(cfg, target) !== true) return '配置里 replyScope = owner-only：只回主人';
  return null;
}

/**
 * 挑出这一轮要回谁（纯函数，好测）。
 *
 * @param options.inbox - `bili_inbox op=check` 的返回。
 * @returns {{owners: Array, others: Array, skipped: Array, limits: object}}
 */
export function pickReplyTargets({ cfg, ledger = null, inbox = null, selfMid = null } = {}) {
  const limits = replyLimits(cfg);
  const rows = Array.isArray(inbox?.targets) ? inbox.targets : [];
  const skipped = [];
  const candidates = [];
  for (const target of rows) {
    const owner = target?.owner === true || isOwner(cfg, target ?? {}) === true;
    const reason = replyable(cfg, target, selfMid);
    if (reason !== null) {
      skipped.push({ mid: target?.mid ?? null, uname: target?.uname ?? '', reason });
      continue;
    }
    // 同一条评论只回一次 —— **主人也不例外**。
    // 主人免的是「每人一条 / 一串一条」（他再在串里说新话，她还得答），
    // 不是「同一条评论追着回两遍」：2026-10-05 真机就是这么刷屏的
    // （账本里两条 reply 都指向 rpid 316071900673，主人那一句被每轮追着回一条）。
    const sourceRpid = Number(target.rpid);
    if (repliedToComment(ledger, sourceRpid)) {
      skipped.push({ mid: target.mid, uname: target.uname ?? '', reason: '这条评论人家已经回过了' });
      continue;
    }
    // 已经回过的人（同一串里）不再回；主人除外 —— 主人找她必须答。
    if (target.answered === true && owner !== true) {
      skipped.push({ mid: target.mid, uname: target.uname ?? '', reason: '这一串里已经回过他了' });
      continue;
    }
    // 她自己在这串里已经说过话（对谁都算）：主人再找她照答，别人这轮先放过 —— 别在人家的评论串里刷屏。
    const root = Number(target.replyRoot ?? target.root ?? target.rpid);
    if (owner !== true && repliedInRoot(ledger, root)) {
      skipped.push({ mid: target.mid, uname: target.uname ?? '', reason: '这一串人家已经回过了，别刷屏' });
      continue;
    }
    const business = String(target.business ?? '');
    const hasBvid = typeof target.bvid === 'string' && target.bvid !== '';
    // 动态下面的评论要回在动态评论串里（type=17，id 用动态 id）；有 BV 号就一定是视频。
    const isDynamic = hasBvid !== true && (business === 'dynamic' || business === '动态');
    // 动态 id 是雪花号（18 位以上），必须按字符串搬，转 Number 会掉精度。
    const dynId = target.dynamicId === null || target.dynamicId === undefined || target.dynamicId === ''
      ? (target.aid !== null && target.aid !== undefined && target.aid !== '' ? String(target.aid) : String(target.oid ?? ''))
      : String(target.dynamicId);
    candidates.push({
      mid: target.mid,
      uname: target.uname ?? '',
      message: String(target.message ?? ''),
      rpid: Number(target.rpid),
      root,
      // 注意：@ 我的消息里 `oid` 是**那条 @ 评论的 rpid**，不是被评论的对象 ——
      // 视频要认 bvid，动态要认 subject_id（normalize 里落在 `aid` 上），否则会往错误的 id 上回。
      oid: isDynamic ? dynId : target.oid,
      id: isDynamic ? dynId : String(hasBvid ? target.bvid : target.oid),
      bvid: hasBvid ? target.bvid : null,
      subject: target.subject ?? '',
      selfText: String(target.myMessage ?? ''),
      business,
      kind: isDynamic ? 'dynamic' : 'video',
      // 专栏/动态的雪花 id 在 opus 页面上，回它时 referer 要给对。
      referer: isDynamic && target.opusId ? `https://www.bilibili.com/opus/${String(target.opusId)}` : '',
      owner,
      ts: Number(target.ts ?? 0),
    });
  }

  // 主人排前面；同一串一轮只回一条（主人和陌生人撞在同一串时，主人赢）。
  candidates.sort((left, right) => Number(right.owner) - Number(left.owner));
  const usedRoots = new Set();
  const owners = [];
  const others = [];
  for (const row of candidates) {
    if (usedRoots.has(row.root)) {
      skipped.push({ mid: row.mid, uname: row.uname, reason: '这一串这轮已经排了回复' });
      continue;
    }
    usedRoots.add(row.root);
    if (row.owner) owners.push(row);
    else if (limits.toOthers) others.push(row);
    else skipped.push({ mid: row.mid, uname: row.uname, reason: 'policy.replyToOthers = false：这一轮只回主人' });
  }
  const pick = [...owners, ...others.slice(0, limits.perRunOthers)].slice(0, limits.perRun);
  return { owners, others, skipped, limits, pick };
}

/** 账本里她自己在这条评论串下已经说过话吗。 */
function repliedInRoot(ledger, root) {
  if (ledger === null || ledger === undefined || !Number.isFinite(root)) return false;
  const rows = Array.isArray(ledger.replies) ? ledger.replies : [];
  return rows.some((row) => Number(row?.root) === root);
}

/**
 * 回头读一眼**磁盘上最新**的账本（读不到就给 null）。
 *
 * 为什么要多读一次：本机同时有宿主插件与看门鲸两个写手，各自的内存快照可能都
 * 没包含对方刚写下的一条回复（2026-10-05「评论又重复回复了」就是这么来的）。
 * 发之前看最新的一份，才认得出「这条评论刚刚已经被回过」。
 */
function freshLedger() {
  try {
    return loadLedger();
  } catch {
    return null;
  }
}

/**
 * 跑一轮评论回复（出口函数）。
 *
 * 加了跨进程锁：同一时刻只允许一个进程跑「回评论」这件事 —— 宿主定时器与看门鲸
 * 撞在一起时，后到的那个直接让路（`{ skipped: [{reason: '…的锁被别的进程拿着（…）'}] }`），
 * 不去重复回同一条评论。拿不到锁不算失败，下一轮再来。
 *
 * @param {object} options - 与 `runInboxRepliesLocked` 相同（多 `lock: false` 关掉锁、
 *   `lockWaitMs` 调等锁时长，都是测试/排查用的）。
 */
export async function runInboxReplies(options = {}) {
  if (options.lock === false) return await runInboxRepliesLocked(options);
  // 只等 3 秒：撞车时宁可这轮不动手，也别把定时器卡在那里（下一轮很快就来）。
  const waitMs = Number(options.lockWaitMs ?? 3000);
  const guarded = await withLock('reply-round', () => runInboxRepliesLocked(options), {
    waitMs: Number.isFinite(waitMs) && waitMs >= 0 ? waitMs : 3000,
  });
  if (guarded.acquired === true) return guarded.value;
  // 拿不到锁：另一个进程正在回复，这轮先不动手 —— 总比追着同一条评论回两遍强。
  try {
    options.log?.(`${guarded.reason}，这轮先不动手`);
  } catch {
    /* 日志失败不影响主流程 */
  }
  return {
    replied: 0,
    drafts: [],
    skipped: [{ mid: null, uname: '', reason: guarded.reason }],
    failed: [],
    pending: 0,
    locked: false,
  };
}

/**
 * 跑一轮评论回复（真的干活的那半；锁由 `runInboxReplies` 套在外面）。
 *
 * @param options.run - `async (工具名, 参数) => 工具返回值`（宿主与云端各自注入自己的执行器）。
 * @param options.inbox - 已经拿到的消息中心结果（不给就自己调 `bili_inbox op=check`）。
 * @param options.compose - 生成正文的函数（默认 `composeCommentReply`，测试可换）。
 * @param options.dryRun - true 时只写话不发出去（排查用）。
 * @returns {Promise<{replied: number, drafts: Array, skipped: Array, failed: Array, pending: number}>}
 */
async function runInboxRepliesLocked({ cfg, ledger = null, run, inbox = null, selfMid = null, compose = null, dryRun = false, log = () => {} } = {}) {
  if (typeof run !== 'function') throw new Error('runInboxReplies 需要一个 run(工具名, 参数) 执行器');
  const feed = inbox ?? (await run('bili_inbox', { op: 'check', count: 30 }));
  const picked = pickReplyTargets({ cfg, ledger, inbox: feed, selfMid: feed?.selfMid ?? selfMid });
  const write = compose ?? (await import('./compose.js')).composeCommentReply;
  const recentReplies = (ledger?.replies ?? []).slice(-5).map((item) => String(item?.text ?? '')).filter((line) => line !== '');
  const drafts = [];
  const failed = [];
  const skipped = []; // 发之前才发现「别人刚回过」的那几条，也如实报出去
  let replied = 0;

  for (const target of picked.pick) {
    // 追加日志挡一道：账本被别的写手整份盖掉（丢更新）时，这里仍认得出「回过」。
    if (hasReplied(target.rpid)) {
      skipped.push({ mid: target.mid, uname: target.uname, reason: '这条评论人家回过了（追加日志）' });
      continue;
    }
    let video = null;
    let thread = [];
    try {
      if (target.kind === 'video') {
        video = await run('bili_video', { id: String(target.bvid ?? target.oid) });
        try {
          const detail = await run('bili_inbox', { op: 'thread', id: String(target.bvid ?? target.oid), root: target.root });
          thread = Array.isArray(detail?.replies) ? detail.replies : [];
        } catch (error) {
          log(`读评论串失败（${target.uname}）：${error.message}`);
        }
      }
    } catch (error) {
      failed.push({ ...target, reason: `取内容失败：${error.message}` });
      continue;
    }
    const context = {
      isOwner: target.owner === true,
      kind: target.kind,
      selfText: target.selfText,
      subject: target.subject,
      thread,
      recentReplies,
      ownMid: selfMid,
    };
    let message = null;
    try {
      message = await write({
        cfg,
        video,
        comment: { uname: target.uname, mid: target.mid, message: target.message },
        context,
        extra: target.kind === 'dynamic' ? '这是一条动态下面的评论，不是视频。' : '',
      });
    } catch (error) {
      failed.push({ ...target, reason: `写不出话：${error.message}` });
      continue;
    }
    if (message === null || String(message).trim() === '') {
      failed.push({ ...target, reason: '脑子没给出正文（模型不可用？）' });
      continue;
    }
    drafts.push({ mid: target.mid, uname: target.uname, owner: target.owner, kind: target.kind, message });
    if (dryRun) continue;
    // 发之前再认一次「这条评论到底回过没有」——用的是**磁盘上最新**的账本，
    // 别的进程（宿主定时器 / 看门鲸）刚回过的那条，这一步能认出来。
    const fresh = freshLedger();
    if (hasReplied(target.rpid)) {
      skipped.push({ mid: target.mid, uname: target.uname, reason: '这条评论刚被别的进程回过了（追加日志）' });
      continue;
    }
    if (fresh !== null && repliedToComment(fresh, target.rpid)) {
      skipped.push({ mid: target.mid, uname: target.uname, reason: '这条评论刚被别的进程回过了' });
      continue;
    }
    if (fresh !== null && target.owner !== true && repliedInRoot(fresh, target.root)) {
      skipped.push({ mid: target.mid, uname: target.uname, reason: '这一串刚被别的进程回过了' });
      continue;
    }
    try {
      const sent = await run('bili_reply', {
        id: String(target.id ?? target.oid),
        rpid: target.rpid,
        root: target.root,
        mid: target.mid,
        uname: target.uname,
        message,
        kind: target.kind,
        ...(target.referer === '' ? {} : { referer: target.referer }),
        confirm: true,
      });
      if (sent?.allowed === false) {
        failed.push({ ...target, reason: (sent.reasons ?? []).join('；') || '策略拦下了' });
        continue;
      }
      replied += 1;
      log(`回了 ${target.uname || target.mid}：${String(message).slice(0, 40)}`);
    } catch (error) {
      failed.push({ ...target, reason: `发送失败：${error.message}` });
    }
  }

  return { replied, drafts, skipped: [...picked.skipped, ...skipped], failed, pending: (feed?.targets ?? []).length };
}
