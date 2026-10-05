/**
 * 对外动作策略：该不该发、能不能自动发、还差什么。
 *
 * 三条硬规则来自主人：
 *   1. 主人（懒寻真）永远优先，不受「每人一条」限制。
 *   2. 别人一人一条：同一评论串里同一人至多回 1 条，且 24 小时内只回 1 条。
 *   3. 模式开关：auto 直接发 / confirm 只出草稿等主人点头 / off 禁止。
 *
 * 所有判断都在插件侧完成，模型说得再好听也绕不过配额与去重。
 *
 * @module dsh-bilibili-whale/policy
 */
import { autoDmCountForUser, commentedVideo, dateKey, dmCountForUser, favoritedAlready, lastDmIncomingTs, lastReplyTsForUser, threadReplyCount, todayCounts, dynamicPostedToday, tripledAlready, tripleCountToday } from './ledger.js';

/** 命中屏蔽词？ */
function hitBlocked(text, words) {
  const list = Array.isArray(words) ? words : [];
  return list.find((word) => typeof word === 'string' && word !== '' && text.includes(word)) ?? null;
}

/**
 * 标题黑名单：这些片**不评论**。
 *
 * 由来（2026-10-05）：待确认箱里混进了「女大学生的"隐秘的圈子"一月疯狂约600人」这类
 * 擦边垃圾 —— 云端 patrol 从 popular/ranking 里挑片时只看播放量，没有任何内容把关，
 * 排进草稿的文案还是照着人格写的，等于拿她的账号去这种视频底下发言。
 */
export const DEFAULT_TITLE_BLOCK = [
  '擦边', '福利', '美女', '性感', '诱惑', '私密', '隐秘', '约炮', '约600', '一晚赚',
  '出轨', '渣男', '渣女', '前任', '恋情', '绯闻', '八卦', '吃瓜', '狗血', '撕逼',
  '暴富', '一夜暴富', '赚上万', '日入', '月入过万', '副业', '割韭菜', '引流', '加微信',
  '带货', '开箱', '优惠券', '拼多多', '广告', '推广', '三连必回', '关注必回',
  '震惊', '不看后悔', '慎入', '未成年人', '擦边球', '偷拍',
];

/**
 * 学习向账号只在这些话题里发言（`feed.topicsOnly` 打开时生效）。
 *
 * 定得宽一点：太严就变成「怎么没刷视频/怎么没评论」——主人 2026-10-05 抱怨过的正是这个。
 */
export const DEFAULT_TOPIC_KEYWORDS = [
  '学习', '记忆', '笔记', '复习', '考试', '考研', '高考', '读书', '效率', '方法论',
  '数学', '物理', '化学', '生物', '地理', '天文', '宇宙', '相对论', '量子', '力学', '电路', '电子', '机械', '工程',
  '编程', '代码', '算法', '数据结构', '前端', '后端', '数据库', '操作系统', '网络', '安全', '开源', '软件', '工具', '教程',
  'AI', 'ai', '人工智能', '大模型', '模型', 'agent', 'Agent', 'LLM', '机器学习', '深度学习', '神经网络', '提示词',
  '科学', '科普', '知识', '原理', '逻辑', '思维', '哲学', '心理', '历史', '经济', '金融', '统计', '实验', '研究', '论文',
  '英语', '语言', '写作', '演讲', '设计', '摄影', '剪辑', '音乐', '美术',
];

/** 标题/标签命中黑名单？返回命中的那个词，没命中返回 null。 */
export function titleBlocked(cfg, title, tags = []) {
  // 空数组 = 「没自己写词表」→ 用默认黑名单（千万不要把空数组当成「主人要清空黑名单」，
  // 否则默认表永远不生效，擦边标题照样进评论队列）。
  const list = Array.isArray(cfg?.feed?.titleBlock) && cfg.feed.titleBlock.length > 0
    ? cfg.feed.titleBlock
    : DEFAULT_TITLE_BLOCK;
  const blob = `${String(title ?? '')} ${Array.isArray(tags) ? tags.join(' ') : ''}`;
  return hitBlocked(blob, list);
}

/**
 * 这条片子「在我们想聊的话题里」吗？
 *
 * `feed.topicsOnly === false` 时一律返回 true（只靠黑名单把关）。
 * 返回 false 时调用方可以再拉一次视频详情（拿标签）重判一次——feed 列表里的条目
 * 常常没有 tags，光看标题会误杀。
 */
export function titleOnTopic(cfg, title, tags = []) {
  if (cfg?.feed?.topicsOnly !== true) return true;
  const list = Array.isArray(cfg?.feed?.topicKeywords) && cfg.feed.topicKeywords.length > 0
    ? cfg.feed.topicKeywords
    : DEFAULT_TOPIC_KEYWORDS;
  const blob = `${String(title ?? '')} ${Array.isArray(tags) ? tags.join(' ') : ''}`.toLowerCase();
  return list.some((word) => typeof word === 'string' && word !== '' && blob.includes(String(word).toLowerCase()));
}

/** 通用：动作之间的最小间隔。 */
function intervalOk(cfg, ledger, now, isOwner) {
  const minSeconds = Number(isOwner ? cfg.policy.minIntervalSecondsOwner : cfg.policy.minIntervalSeconds) || 0;
  if (minSeconds <= 0) return { ok: true };
  const last = Number(isOwner ? ledger.lastActionOwnerTs : ledger.lastActionTs) || 0;
  const elapsed = (now - last) / 1000;
  if (last !== 0 && elapsed < minSeconds) {
    return { ok: false, reason: `离上次动作只过了 ${Math.round(elapsed)} 秒，策略要求至少 ${minSeconds} 秒` };
  }
  return { ok: true };
}

/**
 * 今天回过几条（可按「是不是回主人」分开数）。
 *
 * 为什么不用 `todayCounts().replies`：那是个**不分人**的总数（`daily[key].replies`），
 * 拿它当上限会让「主人在评论区多聊几句」直接把陌生人的额度吃光。
 * `recordReply` 存了 `isOwner`，所以从 `ledger.replies` 现算更准。
 *
 * @param {boolean} wantOwner - true 只数回主人的，false 只数回别人的。
 */
function replyCountToday(ledger, now, wantOwner) {
  const key = dateKey(new Date(now));
  return (ledger.replies ?? []).filter((row) => {
    if ((row?.isOwner === true) !== wantOwner) return false;
    return dateKey(new Date(Number(row?.ts) || 0)) === key;
  }).length;
}

/** 主人判定：昵称或 UID 命中。 */
export function isOwner(cfg, { mid, uname }) {
  const mids = [cfg.ownerMid, ...(Array.isArray(cfg.ownerMids) ? cfg.ownerMids : [])]
    .filter((value) => value !== null && value !== undefined && String(value) !== '');
  if (mids.some((value) => String(mid) === String(value))) return true;
  const names = [cfg.ownerName, ...(Array.isArray(cfg.ownerNames) ? cfg.ownerNames : [])]
    .filter((value) => typeof value === 'string' && value !== '');
  return typeof uname === 'string' && uname !== '' && names.includes(uname);
}

/**
 * 「最高权限」（调试档）判定：既是主人，又没关掉 `policy.ownerDebug`，还在 `policy.debugMids`
 * 名单里（名单为空 = 两位主人都有）。
 *
 * 主人 2026-10-05：「给另一个主人调试最高权限」。拿到这档的主人，私信里能查状态 / 日志 /
 * 配置 / 额度 / 最近动作、能改配置、能让看门鲸重启，而且他支使的动作**免限额 / 免间隔 / 免去重**
 * （`force = true` 一路传下去）。
 *
 * ⚠️ `force` **不是**「免护栏」：屏蔽词、字数上限、`postXxx = off`、没登录没写权限这些照样拦 ——
 * 那是账号安全线，主人点头也不能让她被风控带走。
 *
 * @returns {boolean}
 */
export function isDebugOwner(cfg, { mid, uname }) {
  if (cfg?.policy?.ownerDebug === false) return false;
  if (isOwner(cfg, { mid, uname }) !== true) return false;
  const list = Array.isArray(cfg?.policy?.debugMids) ? cfg.policy.debugMids : [];
  const wanted = list.map((value) => String(value).trim()).filter((value) => value !== '');
  if (wanted.length === 0) return true;
  return wanted.some((value) => String(mid) === value || String(uname ?? '') === value);
}

/**
 * 「主人随心所欲」判定：**主人的指令不该被每日上限 / 间隔 / 去重挡住**。
 *
 * 主人 2026-10-05：「给她的账号最大权限，让她接受我的指令之后可以随心所欲」。
 * 规矩：`force === true`（调试档主人下的令）**或**说话的是主人且 `policy.ownerUnlimited !== false`。
 *
 * ⚠️ 跟 `force` 一样**不是免护栏**：屏蔽词、字数上限、`postXxx = off`、
 * `allowFollow = false`、`allowDm = false`、没登录没写权限 —— 这些账号安全线照拦。
 *
 * @param {object} cfg - 生效配置
 * @param {{owner?: boolean, force?: boolean}} [who] - owner = 说话的是不是主人
 * @returns {boolean}
 */
export function ownerFree(cfg, { owner = false, force = false } = {}) {
  if (force === true) return true;
  return owner === true && cfg?.policy?.ownerUnlimited !== false;
}

/**
 * 主人昵称列表（去重、去空）。给「@主人」用。
 *
 * @returns {string[]}
 */
export function ownerNames(cfg) {
  const list = [cfg?.ownerName, ...(cfg?.ownerNames ?? [])]
    .filter((name) => typeof name === 'string' && name.trim() !== '')
    .map((name) => name.trim());
  return [...new Set(list)];
}

/**
 * 主人「带 UID 的昵称」列表，给**动态的真 @** 用。
 *
 * 动态里的 `@昵称` 纯文本不会变成真 @（对方收不到通知），必须要 UID 才能拼成
 * `{type:2, biz_id:<mid>}` 的富文本节点。昵称与 UID 按位置一一对应：
 * `ownerName`↔`ownerMid`，`ownerNames[i]`↔`ownerMids[i]`；缺 UID 的那位只能退回纯文本。
 *
 * @returns {Array<{name: string, mid: string}>}
 */
export function ownerMentionList(cfg) {
  const names = [cfg?.ownerName, ...(Array.isArray(cfg?.ownerNames) ? cfg.ownerNames : [])];
  const mids = [cfg?.ownerMid, ...(Array.isArray(cfg?.ownerMids) ? cfg.ownerMids : [])];
  const list = [];
  names.forEach((name, index) => {
    if (typeof name !== 'string' || name.trim() === '') return;
    const mid = mids[index];
    if (mid === undefined || mid === null || String(mid).trim() === '') return;
    const clean = name.trim();
    if (list.some((item) => item.name === clean)) return;
    list.push({ name: clean, mid: String(mid).trim() });
  });
  return list;
}

/**
 * 给正文补上「@两个主人」。
 *
 * 主人的要求：她出去刷视频留言时，一定要把两位主人都 @ 上（这样主人才收得到动静）。
 * 已经 @ 过的不重复加；`policy.mentionOwners = false` 可以整体关掉。
 *
 * 注意：**评论区**里的纯文本 `@昵称` 会被 B 站解析成真 @（已实测 content.members 命中）；
 * **动态**不会，动态必须走 `BiliClient.dynamicCreate(text, { mentions: ownerMentionList(cfg) })`。
 *
 * @param {object} cfg - 已解析配置。
 * @param {string} text - 原始正文。
 * @returns {string}
 */
export function withOwnerMentions(cfg, text) {
  const body = String(text ?? '');
  if (cfg?.policy?.mentionOwners === false) return body;
  const missing = ownerNames(cfg).filter((name) => body.includes(`@${name}`) === false);
  if (missing.length === 0) return body;
  return `${body.trimEnd()} ${missing.map((name) => `@${name}`).join(' ')}`;
}

/**
 * 视频一级评论的策略判断。
 *
 * `ignoreInterval` 给「一口气刷了好几条、节奏由调用方自己拉开」的路径用
 * （三连顺手评论，见 `lib/triple.js` 的 `commentAfterTriple`）：评论之间不该被
 * **别的**动作（比如刚回过一条私信）刷新的 `lastActionTs` 挡住 120 秒。
 *
 * @returns {{allowed: boolean, needsConfirm: boolean, mode: string, reasons: string[], message: string}}
 */
export function checkVideoComment({ cfg, ledger, video, message, confirm = false, now = Date.now(), ignoreInterval = false, force = false }) {
  const mode = cfg.policy.postVideoComment;
  const reasons = [];
  const counts = todayCounts(ledger, new Date(now));
  const text = String(message ?? '').trim();
  if (mode === 'off') reasons.push('配置里 postVideoComment = off，禁止评论视频');
  if (text === '') reasons.push('评论内容为空');
  if (text.length > Number(cfg.policy.maxCommentChars)) {
    reasons.push(`评论 ${text.length} 字，超过上限 ${cfg.policy.maxCommentChars} 字（防刷屏）`);
  }
  const blocked = hitBlocked(text, cfg.policy.blockKeywords);
  if (blocked !== null) reasons.push(`命中屏蔽词「${blocked}」`);
  // 同一支片子不重复评论：**默认硬闸**（`dedupePerVideo !== false`），而且**不吃 `force`**。
  // 主人 2026-10-05：「她现在开始重复刷刷过的视频了」——当天同一支视频被回了 4 条一模一样的
  // 评论（B 站那边看起来就是在刷屏）。`defaults` 里 `dedupePerVideo` 本来就是 `true`，
  // 真正漏的是 `force !== true` 这个豁免：主人私信那条链一路带 `force`（`lib/tools.js` 的
  // `forceCmd = ownerFree(...)`），于是自动挑片挑回同一支、评论闸又放行，两道一起漏。
  // 真想再评一次就用配置 `policy.dedupePerVideo: false` 显式放开。
  if (cfg.policy.dedupePerVideo !== false && video?.bvid && commentedVideo(ledger, video.bvid) !== null) {
    reasons.push(`这个视频（${video.bvid}）已经评论过了`);
  }
  // 每日上限：**0 = 不限**（跟 dailyTriples / dailyRepliesOwner 一个规矩）。
  // 主人 2026-10-05：「三连的视频都要评论」——默认 3 会把当天第 4 条起的评论全挡掉。
  const limit = Number(cfg.policy.dailyVideoComments);
  if (force !== true && limit > 0 && counts.videoComments >= limit) {
    reasons.push(`今日视频评论已达上限 ${limit} 条`);
  }
  if (ignoreInterval !== true && force !== true) {
    const interval = intervalOk(cfg, ledger, now, false);
    if (!interval.ok) reasons.push(interval.reason);
  }
  const needsConfirm = mode === 'confirm' && confirm !== true;
  return {
    allowed: reasons.length === 0 && !needsConfirm,
    needsConfirm,
    mode,
    reasons,
    message: text,
    hint: needsConfirm ? '这是草稿模式：把草稿给主人看，主人说发再用 confirm=true 重调。' : '',
  };
}

/**
 * 回复评论的策略判断。
 * @param options.target - { mid, uname, rpid, root }（root 为 0/空表示这是一级评论，回复时 root=rpid）
 * @param options.selfMid - 自己的 UID，用于拒绝自问自答
 */
export function checkReply({ cfg, ledger, target, message, confirm = false, selfMid = null, now = Date.now(), force = false }) {
  const mode = cfg.policy.postReply;
  const reasons = [];
  const warnings = [];
  const text = String(message ?? '').trim();
  const owner = isOwner(cfg, target ?? {});
  const rootRpid = Number(target?.root) > 0 ? target.root : target?.rpid;
  // 「主人的指令」= 调用方明确传下来的 `force`（私信命令那条链会给任何主人的指令打上
  // `ownerFree` 的结论）。**不**因为「被回的人是主人」就免间隔 —— 那 15 秒是防 B 站风控的
  // 节奏线，自动巡检一次回好几条主人评论时还得留着。
  const free = force === true;

  if (mode === 'off') reasons.push('配置里 postReply = off，禁止回复');
  if (text === '') reasons.push('回复内容为空');
  if (text.length > Number(cfg.policy.maxCommentChars)) {
    reasons.push(`回复 ${text.length} 字，超过上限 ${cfg.policy.maxCommentChars} 字`);
  }
  const blocked = hitBlocked(text, cfg.policy.blockKeywords);
  if (blocked !== null) reasons.push(`命中屏蔽词「${blocked}」`);
  const self = selfMid !== null && String(target?.mid) === String(selfMid);
  if (self) reasons.push('这是她自己发的评论，不回自己');
  if (cfg.policy.replyScope === 'owner-only' && !owner) reasons.push('配置里 replyScope = owner-only：只回主人');

  if (free !== true && !owner && !self) {
    const perThread = Number(cfg.policy.replyPerUserPerThread) || 0;
    const used = threadReplyCount(ledger, rootRpid, target?.mid);
    if (perThread > 0 && used >= perThread) {
      reasons.push(`「${target?.uname ?? target?.mid}」在这条评论串里已经被回过 ${used} 条了（每人每串上限 ${perThread}）`);
    }
    const windowHours = Number(cfg.policy.replyPerUserWindowHours) || 0;
    if (windowHours > 0) {
      const last = lastReplyTsForUser(ledger, target?.mid);
      const hours = last === 0 ? Number.POSITIVE_INFINITY : (now - last) / 3600000;
      if (hours < windowHours) {
        reasons.push(`「${target?.uname ?? target?.mid}」${hours.toFixed(1)} 小时前刚被回过（每人 ${windowHours} 小时一条）`);
      }
    }
  } else if (owner) {
    warnings.push(free === true ? '主人优先：不限条数、不限间隔（ownerUnlimited）' : '主人优先：跳过「每人一条」限制');
  }

  // 每日上限**分开算**（主人 2026-10-05：「我有评论她能回，别人的评论调用免费模型回」）。
  // 原来主人和陌生人共用 `dailyReplies`，主人一多聊几句就把额度用光，
  // 表现就是「她回不了评论区的评论了」——
  // 真机 11:10 / 11:15 连着两次 `失败 1 条 / 今日回复已达上限 10 条`，而那条恰恰是主人发的。
  if (free !== true && owner) {
    const capOwner = Number(cfg.policy.dailyRepliesOwner ?? 50) || 0;
    const usedOwner = replyCountToday(ledger, now, true);
    if (capOwner > 0 && usedOwner >= capOwner) {
      reasons.push(`今日回复主人已达上限 ${capOwner} 条`);
    }
  } else if (free !== true && !owner) {
    const cap = Number(cfg.policy.dailyReplies) || 0;
    const used = replyCountToday(ledger, now, false);
    if (cap > 0 && used >= cap) {
      reasons.push(`今日回复已达上限 ${cap} 条`);
    }
  }
  if (free !== true) {
    const interval = intervalOk(cfg, ledger, now, owner);
    if (!interval.ok) reasons.push(interval.reason);
  }

  const needsConfirm = mode === 'confirm' && confirm !== true;
  return {
    allowed: reasons.length === 0 && !needsConfirm,
    needsConfirm,
    mode,
    owner,
    free,
    rootRpid,
    warnings,
    reasons,
    message: text,
    hint: needsConfirm ? '这是草稿模式：先给主人看，主人点头后再用 confirm=true 重调。' : '',
  };
}

/** 关注的策略判断：只关注主人；关注别人要先在配置里开 allowFollowOthers（主人点名的除外）。 */
export function checkFollow({ cfg, mid, uname, act = 1, force = false }) {
  const reasons = [];
  const owner = isOwner(cfg, { mid, uname });
  const following = Number(act) === 1;
  if (cfg.policy.allowFollow === false) reasons.push('配置里 allowFollow = false，禁止任何关注动作');
  // 主人点名「关注这个 UP」时 force = true：`allowFollowOthers` 这道「只许关注主人」的
  // 范围限制给他让路（`allowFollow = false` 这种总闸仍然拦，那是账号安全线）。
  if (following && owner !== true && cfg.policy.allowFollowOthers !== true && force !== true) {
    reasons.push('只关注主人（要关注别人请在配置里开 policy.allowFollowOthers）');
  }
  return {
    allowed: reasons.length === 0,
    needsConfirm: false,
    mode: following ? 'follow' : 'unfollow',
    owner,
    free: force === true,
    reasons,
    hint: reasons.length === 0 ? '' : '这条规则在插件侧强制，模型绕不过。',
  };
}

/** 私信的策略判断：默认只能私信主人，且每人每天 maxDmPerUserPerDay 条。 */
export function checkDm({ cfg, ledger, mid, uname, text, now = Date.now(), force = false }) {
  const reasons = [];
  const value = String(text ?? '').trim();
  const owner = isOwner(cfg, { mid, uname });
  if (cfg.policy.allowDm === false) reasons.push('配置里 allowDm = false，禁止私信');
  if (value === '') reasons.push('私信内容为空');
  if (value.length > Number(cfg.policy.maxCommentChars)) {
    reasons.push(`私信 ${value.length} 字，超过上限 ${cfg.policy.maxCommentChars} 字`);
  }
  const blocked = hitBlocked(value, cfg.policy.blockKeywords);
  if (blocked !== null) reasons.push(`命中屏蔽词「${blocked}」`);
  if (owner !== true && cfg.policy.allowDmToOthers !== true) {
    reasons.push('只给主人发私信（要发给别人请在配置里开 policy.allowDmToOthers）');
  }
  const limit = Number(cfg.policy.maxDmPerUserPerDay) || 0;
  if (force !== true && limit > 0) {
    const sent = dmCountForUser(ledger, mid, new Date(now));
    if (sent >= limit) reasons.push(`「${uname ?? mid}」今天已经收到 ${sent} 条私信（上限 ${limit} 条）`);
  }
  if (force !== true) {
    const interval = intervalOk(cfg, ledger, now, owner);
    if (!interval.ok) reasons.push(interval.reason);
  }
  return {
    allowed: reasons.length === 0,
    needsConfirm: false,
    mode: cfg.policy.postDm ?? 'auto',
    owner,
    reasons,
    message: value,
    hint: reasons.length === 0 ? '' : '这条规则在插件侧强制，模型绕不过。',
  };
}

/**
 * 回私信的策略判断（Reply to a DM）。
 *
 * 与「主动私信」的区别：这里只回**先找过她**的人。
 *   - 主人：mode = policy.replyDm（默认 auto，不限条数）
 *   - 别人：mode = policy.replyDmOthers（默认 `once`：**只自动回一条**，之后闭嘴；
 *     也可设 'confirm' 要主人点头、'auto' 不限、'off' 完全不回）
 *   - 对方没先发过消息 → 直接拦下（绝不主动搭话陌生人）
 */
export function checkDmReply({ cfg, ledger, mid, uname, text, confirm = false, now = Date.now(), force = false }) {
  const owner = isOwner(cfg, { mid, uname });
  const mode = owner ? (cfg.policy.replyDm ?? 'auto') : (cfg.policy.replyDmOthers ?? 'once');
  const reasons = [];
  const value = String(text ?? '').trim();
  if (cfg.policy.allowDm === false) reasons.push('配置里 allowDm = false，禁止任何私信');
  if (value === '') reasons.push('私信内容为空');
  if (value.length > Number(cfg.policy.maxCommentChars)) {
    reasons.push(`私信 ${value.length} 字，超过上限 ${cfg.policy.maxCommentChars} 字`);
  }
  const blocked = hitBlocked(value, cfg.policy.blockKeywords);
  if (blocked !== null) reasons.push(`命中屏蔽词「${blocked}」`);
  if (lastDmIncomingTs(ledger, mid) === 0) {
    reasons.push(`「${uname ?? mid}」没有先给她发过私信，人家不主动搭话陌生人`);
  }
  if (owner !== true && mode === 'off') {
    reasons.push('配置里 replyDmOthers = off，她不自动回陌生人的私信');
  }
  if (owner !== true && mode === 'once' && confirm !== true && autoDmCountForUser(ledger, mid) >= 1) {
    reasons.push(`已经自动回过「${uname ?? mid}」一条了，陌生人只回一条，之后要主人点头才回`);
  }
  // 每日上限只管别人：主人找她说话是**实时**要回的，不该被自己的配额卡住
  //（踩过的坑：主人连发几条后被 maxDmReplyPerUserPerDay 拦住，看起来像「她不回我」）。
  const limit = Number(cfg.policy.maxDmReplyPerUserPerDay) || 0;
  if (force !== true && limit > 0 && owner !== true) {
    const sent = dmCountForUser(ledger, mid, new Date(now));
    if (sent >= limit) reasons.push(`「${uname ?? mid}」今天已经收到 ${sent} 条私信（上限 ${limit} 条）`);
  }
  if (force !== true) {
    const interval = intervalOk(cfg, ledger, now, owner);
    if (!interval.ok) reasons.push(interval.reason);
  }
  const needsConfirm = mode === 'confirm' && confirm !== true;
  return {
    allowed: reasons.length === 0 && !needsConfirm,
    needsConfirm,
    mode,
    owner,
    reasons,
    message: value,
    hint: needsConfirm
      ? '别人发的私信先给主人看一眼，点头后再回（confirm=true）。'
      : (owner !== true && mode === 'once' ? '陌生人只自动回一条，之后要主人点头（confirm=true）才回。' : ''),
  };
}

/**
 * 收藏一个视频的策略判断（刷到觉得好看的视频就收进收藏夹）。
 *
 * 收藏是「给自己记一份」，不对外说话，所以默认 `auto`（不打扰主人）；
 * 但仍然受限：同一视频只收一次、每天有上限 `dailyFavorites`、命中屏蔽词不收。
 */
export function checkFavorite({ cfg, ledger, aid, title = '', confirm = false, now = Date.now(), force = false }) {
  const mode = cfg.policy.postFavorite ?? 'auto';
  const reasons = [];
  if (mode === 'off') reasons.push('配置里 postFavorite = off，禁止收藏');
  if (Number(aid) <= 0) reasons.push('没有拿到视频 aid，没法收藏');
  // 主人点名「把这个收了」force = true：同一视频收过也能再收（他可能是想换个收藏夹），
  // 每日上限也给他让路；标题黑名单照拦。
  if (force !== true && Number(aid) > 0 && favoritedAlready(ledger, aid)) reasons.push(`这个视频（aid=${aid}）已经收藏过了`);
  if (String(title).trim() !== '') {
    const blocked = hitBlocked(String(title), cfg.policy.blockKeywords);
    if (blocked !== null) reasons.push(`标题命中屏蔽词「${blocked}」，不收`);
  }
  const counts = todayCounts(ledger, new Date(now));
  const limit = Number(cfg.policy.dailyFavorites);
  if (force !== true && limit > 0 && Number(counts.favorites ?? 0) >= limit) {
    reasons.push(`今日收藏已达上限 ${limit} 个`);
  }
  const needsConfirm = mode === 'confirm' && confirm !== true;
  return {
    allowed: reasons.length === 0 && !needsConfirm,
    needsConfirm,
    mode,
    owner: true,
    free: force === true,
    reasons,
    hint: needsConfirm ? '收藏先给主人看一眼，点头后再收（confirm=true）。' : '',
  };
}

/**
 * 「好内容随手三连」的策略判断：点赞 + 投币 + 收藏（收藏进分类夹）一起做。
 *
 * 主人要求（2026-10-05）：「刷视频记得好的内容随手三连并分类」。
 * 但「好」要有客观门槛，否则等于把她的三连随手撒出去：
 *   - 分数门槛 `policy.tripleMinScore`（沿用学习打分 scoreVideo 的分数）；
 *   - 同一个视频只三连一次（账本 favorites 里的 triple 标记去重）；
 *   - 每天最多 `policy.dailyTriples` 个；
 *   - 标题命中黑名单不三连（不给擦边垃圾捧场）。
 */
export function checkTriple({ cfg, ledger, video, score = 0, confirm = false, now = Date.now(), force = false }) {
  const mode = cfg?.policy?.postTriple ?? 'confirm';
  const aid = Number(video?.aid ?? 0);
  const title = String(video?.title ?? '');
  const minScore = Number(cfg?.policy?.tripleMinScore ?? 6);
  const reasons = [];
  if (mode === 'off') reasons.push('配置里 postTriple = off，禁止三连');
  if (aid <= 0) reasons.push('没有拿到视频 aid，没法三连');
  if (Number(score) < minScore) reasons.push(`这个视频分数 ${Number(score)} 不到 ${minScore}，够不上「好内容」`);
  if (title.trim() !== '') {
    const blocked = titleBlocked(cfg, title, video?.tags ?? []);
    if (blocked !== null) reasons.push(`标题命中黑名单「${blocked}」，不三连`);
  }
  if (force !== true && aid > 0 && tripledAlready(ledger, aid)) reasons.push(`这个视频（aid=${aid}）已经三连过了`);
  const limit = Number(cfg?.policy?.dailyTriples ?? 5);
  if (force !== true && limit > 0 && tripleCountToday(ledger, new Date(now)) >= limit) reasons.push(`今日三连已达上限 ${limit} 个`);
  const needsConfirm = mode === 'confirm' && confirm !== true;
  return {
    allowed: reasons.length === 0 && !needsConfirm,
    needsConfirm,
    mode,
    owner: true,
    reasons,
    actions: {
      like: true,
      coin: Math.min(Math.max(Number(cfg?.policy?.tripleCoin ?? 1), 1), 2),
      favorite: true,
      folder: pickFolderTitle(cfg, { topic: video?.topic ?? '', title }),
    },
    hint: needsConfirm ? '三连先给主人看一眼，点头后再连（confirm=true）。' : '',
  };
}

/** 三连时默认往哪个收藏夹放（主人没配就用这个）。 */
export const DEFAULT_FAVORITE_FOLDER = '小鲸鱼娘的学习收藏';

/**
 * 这个视频该进哪个收藏夹（「分类」就靠它）。
 *
 * 先看方向映射 `feed.folderByTopic`（键是学习方向，值是收藏夹名），
 * 键直接出现在标题里也算；都没有就回落到 `feed.favoriteFolder`。
 */
export function pickFolderTitle(cfg, { topic = '', title = '' } = {}) {
  const map = cfg?.feed?.folderByTopic ?? {};
  const key = String(topic ?? '').trim();
  const exact = map[key];
  if (typeof exact === 'string' && exact.trim() !== '') return exact.trim();
  const text = String(title ?? '');
  for (const [word, folder] of Object.entries(map)) {
    if (String(word).trim() !== '' && text.includes(String(word)) && typeof folder === 'string' && folder.trim() !== '') {
      return folder.trim();
    }
  }
  const fallback = String(cfg?.feed?.favoriteFolder ?? '').trim();
  return fallback === '' ? DEFAULT_FAVORITE_FOLDER : fallback;
}

/** 发动态的策略判断。 */
export function checkDynamic({ cfg, ledger, text, confirm = false, auto = false, now = Date.now(), force = false }) {
  const mode = cfg.policy.postDynamic;
  const reasons = [];
  const value = String(text ?? '').trim();
  if (mode === 'off') reasons.push('配置里 postDynamic = off，禁止发动态');
  if (value === '') reasons.push('动态内容为空');
  if (value.length > 2000) reasons.push(`动态 ${value.length} 字，超过 2000 字上限`);
  const blocked = hitBlocked(value, cfg.policy.blockKeywords);
  if (blocked !== null) reasons.push(`命中屏蔽词「${blocked}」`);
  const counts = todayCounts(ledger, new Date(now));
  // 主人说「发个动态说…」force = true：每日一条的上限和「今天发过了」都给他让路，
  // 屏蔽词 / 总开关 / 字数上限照拦。
  if (force !== true && counts.dynamics >= Number(cfg.policy.dailyDynamics)) {
    reasons.push(`今日动态已达上限 ${cfg.policy.dailyDynamics} 条`);
  }
  if (force !== true && auto === true && dynamicPostedToday(ledger, new Date(now))) {
    reasons.push('今天已经发过动态了');
  }
  const needsConfirm = mode === 'confirm' && confirm !== true && auto !== true;
  return {
    allowed: reasons.length === 0 && !needsConfirm,
    needsConfirm,
    mode,
    free: force === true,
    reasons,
    message: value,
    hint: needsConfirm ? '草稿模式：把内容给主人看，点头后再发。' : '',
  };
}
