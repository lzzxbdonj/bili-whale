/**
 * 对外动作策略（Workers 版）：该不该发、能不能自动发、还差什么。
 *
 * 三条硬规则来自主人：
 *   1. 主人（懒寻真）永远优先，不受「每人一条」限制。
 *   2. 别人一人一条：同一评论串里同一人至多回 1 条，且 24 小时内只回 1 条。
 *   3. 模式开关：auto 直接发 / confirm 只出草稿等主人点头 / off 禁止。
 *
 * 所有判断都在这一层完成，模型说得再好听也绕不过配额与去重。
 *
 * 与 lib/policy.js 的差异仅两处（判定逻辑逐条照抄）：
 *   1. 账本按新签名显式传入（checkVideoComment/checkReply 走 ledger 参数，不再是磁盘文件）；
 *   2. checkVideoComment 收 bvid 字符串（源文件收 video 对象，内部只用 video.bvid）；
 *      checkReply 收 toMid/toName（源文件收 target 对象），并按指定签名把 bvid 代入 rootRpid 的
 *      默认值（源文件这里是 undefined）。
 *
 * @module dsh-bilibili-whale/cloudflare/policy
 */
import { commentedVideo, dynamicPostedToday, lastReplyTsForUser, threadReplyCount, todayCounts, tripledAlready, tripleCountToday } from './ledger.js';

/** 默认配置（从 lib/config.js 原样搬过来；Worker 版不移植其中的文件路径/读写部分）。 */
export const DEFAULTS = {
  /** 主人昵称：回复策略里的最优先对象。 */
  ownerName: '懒寻真',
  /** 主人 UID（可空；填了更稳，昵称改了就靠它）。 */
  ownerMid: null,
  /** 主人可以有多个：这里的每个 UID 都按「主人」对待（优先回复、豁免限流）。 */
  ownerMids: [],
  /** 多个主人的昵称（与 ownerMids 对应，认不出 UID 时按昵称兜底）。 */
  ownerNames: [],
  /** 人格标识，仅作文档用途。 */
  persona: 'whale-maid',
  policy: {
    /** 视频一级评论：auto 直接发 / confirm 只出草稿 / off 禁止。 */
    postVideoComment: 'confirm',
    /** 回复评论：auto 按策略自动回 / confirm 只出草稿 / off 禁止。 */
    postReply: 'auto',
    /** 发动态：auto 定时发 / confirm 只出草稿 / off 禁止。 */
    postDynamic: 'auto',
    /** 收藏视频：auto 看到喜欢的直接收 / confirm 先出草稿 / off 禁止。 */
    postFavorite: 'auto',
    /** 「好内容随手三连」（点赞+投币+收藏）：auto 直接连 / confirm 先出草稿 / off 禁止。 */
    postTriple: 'confirm',
    /** 分数门槛：学习打分（scoreVideo）到这个分才算「好内容」，才值得三连。 */
    tripleMinScore: 6,
    /** 三连时投几枚币（1 或 2）。 */
    tripleCoin: 1,
    /** 主人永远优先，不受「每人一条」限制。 */
    ownerUnlimited: true,
    /** 普通人：每人在同一评论串最多回几条。 */
    replyPerUserPerThread: 1,
    /** 普通人：同一人多少小时内只回一条（0 = 不限窗口，只按串限）。 */
    replyPerUserWindowHours: 24,
    /** 一轮（一次巡检）最多回几条 —— 别一口气把消息中心刷完。 */
    replyPerRun: 3,
    /** 一轮里最多回几个陌生人（主人不计入这个额度）。 */
    replyPerRunOthers: 1,
    /** 陌生人回复她时要不要理（false = 只回主人）。 */
    replyToOthers: true,
    /** 每日上限。 */
    dailyVideoComments: 3,
    dailyReplies: 10,
    dailyDynamics: 1,
    /** 每天最多收藏几个「刷到觉得好看」的视频。 */
    dailyFavorites: 5,
    /** 每天最多三连几个。 */
    dailyTriples: 5,
    /** 刷过的视频报进 B 站浏览记录（历史记录里能看到她刷过什么）。 */
    reportHistory: true,
    /** 两次对外动作之间的最小间隔（秒）。 */
    minIntervalSeconds: 120,
    /** 回复主人时的最小间隔（秒）——主人优先，允许更勤快。 */
    minIntervalSecondsOwner: 15,
    /** 一级评论最大字数（B 站上限 1000，这里收紧防刷屏）。 */
    maxCommentChars: 200,
    /** 命中的词一律不评论（防止她被引战/广告话题带走）。 */
    blockKeywords: ['加群', '微信', 'QQ群', '代刷', '互粉', '刷单', '博彩', '赌博'],
    /** 同一天同一视频不重复评论。 */
    dedupePerVideo: true,
    /** 评论/回复时自动补上「@两位主人」（主人要求：出去刷视频留言一定要 @ 到他俩）。 */
    mentionOwners: true,
    /**
     * 回复别人的评论时，还要不要**自动**补 @主人。
     * 主人 2026-10-05：「评论不要每一条回复都带上 @」——默认 false：
     * 回帖就正常回帖，要 @ 让模型自己决定（提示词里允许它偶尔点名），不再每条都挂尾巴。
     */
    mentionOwnersOnReply: false,
    /** 允许关注动作（默认只允许关注主人）。 */
    allowFollow: true,
    /** 是否允许关注主人以外的人（默认否）。 */
    allowFollowOthers: false,
    /** 允许私信（默认只允许发给主人）。 */
    allowDm: true,
    /** 是否允许私信主人以外的人（默认否）。 */
    allowDmToOthers: false,
    /** 私信模式：auto 直接发 / confirm 先给主人看。 */
    postDm: 'auto',
    /** 同一人每天最多收到几条私信。 */
    maxDmPerUserPerDay: 3,
    /** 回私信模式：主人 auto（直接回）/ confirm / off。 */
    replyDm: 'auto',
    /**
     * 回别人私信的模式：
     *   `once`（默认）= 只自动回一条，之后闭嘴，要主人点头才继续
     *   `confirm` = 一条都不自动回；`auto` = 不限；`off` = 彻底不回
     */
    replyDmOthers: 'once',
    /** 同一人每天最多被她回几条私信。 */
    maxDmReplyPerUserPerDay: 5,
    /** 收到私信后是否自动回一句寒暄（不调用模型，走模板）。 */
    autoAckDm: true,
  },
  /** 私信巡检：每隔多少分钟看一次未读会话。 */
  dmCheckMinutes: 3,
  /** 评论回复巡检：每隔多少分钟看一次「谁回了她 / @ 了她」。 */
  replyCheckMinutes: 5,
  /**
   * 小鲸鱼娘的「脑子」：本机调 DeepSeek 生成真回复（主人私信专用）。
   *
   * Key 来源优先级：环境变量 DEEPSEEK_API_KEY → 这里的 apiKey → $DSH_HOME/.credentials.yaml。
   * 任何失败都自动回退到 dmAck 模板，所以关掉它也不会让她哑掉。
   */
  brain: {
    enabled: true,
    /**
     * 用哪家模型：主人要求「回复人用免费模型」，默认走 whale = 借云端 Worker 的 Workers AI
     * 免费额度（不用再注册、也不动主人的钱包）。可选 pollinations / deepseek / siliconflow /
     * zhipu / openrouter / local（见 lib/brain.js 的 PROVIDER_PRESETS）。
     */
    provider: 'whale',
    /** 留空就用上面那家的预设地址与模型；想换模型再单独填。 */
    baseUrl: '',
    model: '',
    apiKey: '',
    /** 免费模型没答上来时，悄悄退回主人自己的 key（有 key 才生效）。 */
    fallback: 'deepseek',
    /**
     * 「付费那家」是谁：主人 2026-10-05 要求「回复主人的时候用付费模型」——
     * 回主人时 `askBrain(cfg, { prefer: 'paid' })` 就先用这家（要配好 key，没 key 自然跳过）。
     */
    paid: 'deepseek',
    maxTokens: 300,
    /** 0 = 用那家预设的温度（llama 那类模型在 1.3 会胡言乱语，别乱调高）。 */
    temperature: 0,
    timeoutMs: 25000,
  },
  /** 收到私信后的自动应答（先按关键词直答，不中就轮换模板；不调用模型）。 */
  dmAck: {
    enabled: true,
    /** 命中哪条关键词就用哪句回（顺序匹配，取第一条命中的）。 */
    rules: [
      { match: ['能说话', '在吗', '在么', '在不在', '你好', 'hi', 'hello', '嗨'], reply: '在的在的！人家一直都在哦 (。-ω´-)✧ 主人想说点什么，人家听着呢～' },
      { match: ['谢谢', '辛苦', '感谢'], reply: '不辛苦不辛苦～能帮上主人人家最开心了 (๑•̀ㅂ•́)و✧' },
      { match: ['学习', '笔记', '作业', '复习'], reply: '学习的事交给人家！主人给个方向，人家就去啃 (。-`ω´-)✧' },
      { match: ['视频', '评论', '留言', '弹幕'], reply: '好呀～主人把视频或者想法丢给人家，人家去评论区帮你说话！' },
      { match: ['测试', 'test'], reply: '收到测试信号！小鲸鱼娘在线，通道一切正常 (๑•̀ㅂ•́)و✧' },
    ],
    /** 陌生人（非主人）私信统一回这一句，礼貌收尾，不展开聊。 */
    strangerReply: '你好呀～人家是小鲸鱼娘，平时只陪主人说话哦 (。-ω´-)✧ 有什么想说的可以找主人转达，人家会认真看的～',
    templates: [
      '主人～人家收到你的消息啦 (。-ω´-)✧ 等人家把手上的事忙完就好好回你～',
      '收到收到！小鲸鱼娘已经记在小本本上啦，马上就回你～',
      '呜哇是主人的消息！人家这就游过来 (๑•̀ㅂ•́)و✧',
      '人家看到啦～先给你比个小心心，等下细细回你 (´･ω･`)',
    ],
  },
  dailyDynamic: {
    enabled: true,
    /** 本地时间 HH:MM，每天一次；错过了不补发（下次对齐到第二天）。 */
    at: '20:30',
    /** 随机模板池：定时发动态时按顺序轮换。 */
    templates: [
      '今天也在认真学习呢，主人给的笔记人家抄了三遍 (。-`ω´-)✧',
      '鲸鱼娘的今日学习小结：看了一点点新东西，尾巴都翘起来了～',
      '打卡！人家今天没有偷懒哦，主人在的话夸夸人家嘛 (๑•̀ㅂ•́)و✧',
      '把不懂的地方弄懂了，比吃到小鱼干还开心～',
      '今天的学习进度：缓慢但确实在往前游 (´･ω･`)',
    ],
    /** 当天有学习笔记时，动态用「今天真学了什么」而不是模板。 */
    useStudyNotes: true,
    /** 动态里也 @ 两位主人（学习汇报要让他们看见）。 */
    mentionOwners: true,
  },
  /**
   * 自主学习：她自己决定今天要刷什么、学什么，不用主人指定。
   * 由云端巡检（GitHub Actions）或本机定时器驱动，挑到 → 看 → 记笔记 → 有意义就留言 → 晚上发学习动态。
   */
  learning: {
    enabled: true,
    /** 她自己的兴趣方向，按顺序轮换（也是搜索关键词）。 */
    topics: [
      'DeepSeek',
      'AI 智能体',
      '大模型原理',
      '编程入门',
      '算法讲解',
      '数学之美',
      '物理科普',
      '纪录片 科学',
      '学习方法',
      '科幻小说',
    ],
    /** 每轮最多挑几个视频来「学」（多了会变成刷屏）。 */
    perRun: 2,
    /** 本机插件在的时候，每隔多少分钟自己学一轮（云端 Actions 另有 10 分钟巡检）。 */
    checkMinutes: 60,
    /** 挑视频时优先用的源：search（按 topics 搜）/ popular / ranking。 */
    sources: ['search', 'popular', 'ranking'],
    /** 学到有意义的内容时，去评论区留言（会 @ 两位主人）。 */
    commentWhenMeaningful: true,
    /** 有意义的分水岭，达到才留言（评分规则见 lib/study.js）。 */
    meaningfulScore: 6,
    /** 太短学不到东西、太长学不完，都跳过（秒）。 */
    minDurationSec: 120,
    maxDurationSec: 5400,
    /** 播放量低于这个数的不看（太冷门往往是随手拍）。 */
    minView: 5000,
    /** 标题命中这些词直接跳过。 */
    excludeKeywords: ['鬼畜', '带货', '广告', '直播回放', '切片', '抽奖'],
    /** 记笔记时给模型的热评条数。 */
    noteComments: 6,
    /** 她的学习笔记保留多少条（账本里）。 */
    keepNotes: 200,
  },
  knowledge: {
    /** 学习笔记要不要同时攒成知识库（主人 2026-10-05：「学习后数据要存入这个文件夹并压缩」「后面可以作为知识库使用」）。 */
    enabled: true,
    /** 知识库文件夹；留空 = 自动挑（本机优先 E:\donk\dsh-bilibili-whale\notes，云端用仓库里的 notes/）。 */
    dir: '',
    /** 知识库最多收多少条笔记（按时间倒序保留最新的）。 */
    maxEntries: 500,
    /** 回私信时最多带几条「人家学过的」当上下文。 */
    contextEntries: 3,
  },
  feed: {
    /** 默认刷的源，按顺序取。 */
    sources: ['rcmd', 'popular', 'ranking'],
    /** 命中这些词的视频直接跳过（老的排除词，跟 titleBlock 一起生效）。 */
    excludeKeywords: ['广告', '带货'],
    /** 标题黑名单：擦边/八卦/暴富/引流这类片子不评论（服务端要看得见的口碑）。 */
    titleBlock: [],
    /** true = 只评论「像学习内容」的片子（话题词见 policy.topicKeywords）。默认关，
     *  免得把「刷视频」窄成「只刷学习区」；擦边垃圾由 titleBlock 挡。 */
    topicsOnly: false,
    /** 自定义话题词；留空用 policy 里的默认表。 */
    topicKeywords: [],
    /** 三连时默认放进哪个收藏夹（「分类」的兜底夹）。 */
    favoriteFolder: '小鲸鱼娘的学习收藏',
    /** 按方向分类收藏夹：{ 'AI 智能体': 'AI 学习', 'DeepSeek': 'AI 学习' }。 */
    folderByTopic: {},
    /** 首页推荐单次拉取条数。 */
    ps: 12,
  },
  limits: {
    /** 单次 API 超时（毫秒）。 */
    timeoutMs: 20000,
  },
  cloud: {
    /** 本机在线时，每隔多少分钟和云端遥控台对一次账（报心跳 + 交账本 + 领主人点头的草稿）。 */
    syncMinutes: 5,
    /**
     * 访问遥控台用的 HTTP 代理（形如 http://127.0.0.1:19451）。
     * 这台机器的 DNS 被污染（workers.dev 被解析到假地址），Node 默认直连会超时，
     * 所以要借系统代理出去；留空则读 HTTPS_PROXY 环境变量，再留空就直连。
     */
    proxy: '',
  },
}

/** 命中屏蔽词？ */
function hitBlocked(text, words) {
  const list = Array.isArray(words) ? words : [];
  return list.find((word) => typeof word === 'string' && word !== '' && text.includes(word)) ?? null;
}

/**
 * 标题黑名单：这些片**不评论**。
 *
 * 由来（2026-10-05）：待确认箱里混进了「女大学生的"隐秘的圈子"一月疯狂约600人」这类
 * 擦边垃圾 —— patrol 从 popular/ranking 里挑片时只看播放量，没有任何内容把关，
 * 排进草稿的文案还是照着人格写的，等于拿她的账号去这种视频底下发言。
 * 与 lib/policy.js 的 DEFAULT_TITLE_BLOCK 保持一致。
 */
export const DEFAULT_TITLE_BLOCK = [
  '擦边', '福利', '美女', '性感', '诱惑', '私密', '隐秘', '约炮', '约600', '一晚赚',
  '出轨', '渣男', '渣女', '前任', '恋情', '绯闻', '八卦', '吃瓜', '狗血', '撕逼',
  '暴富', '一夜暴富', '赚上万', '日入', '月入过万', '副业', '割韭菜', '引流', '加微信',
  '带货', '开箱', '优惠券', '拼多多', '广告', '推广', '三连必回', '关注必回',
  '震惊', '不看后悔', '慎入', '未成年人', '擦边球', '偷拍',
];

/** 学习向账号只在这些话题里发言（`feed.topicsOnly` 打开时生效）。定宽一点，别把主人等成「怎么没评论」。 */
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
  // 空数组 = 没自己写词表 → 用默认黑名单（见 lib/policy.js 同一处注释）。
  const list = Array.isArray(cfg?.feed?.titleBlock) && cfg.feed.titleBlock.length > 0
    ? cfg.feed.titleBlock
    : DEFAULT_TITLE_BLOCK;
  const blob = `${String(title ?? '')} ${Array.isArray(tags) ? tags.join(' ') : ''}`;
  return hitBlocked(blob, list);
}

/** 这条片子「在我们想聊的话题里」吗？（topicsOnly=false 时一律 true，只靠黑名单把关） */
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

/** 主人判定：昵称或 UID 命中。 */
export function isOwner(mid, cfg) {
  // 指定签名是 isOwner(mid, cfg)；为了不丢源文件 isOwner(cfg, { mid, uname }) 的昵称判定，
  // 第一参也接受 { mid, uname } 目标对象（调用方只有 UID 时照旧传 mid 数字即可）。
  const target = typeof mid === 'object' && mid !== null ? mid : { mid };
  if (cfg.ownerMid !== null && cfg.ownerMid !== undefined && String(target.mid) === String(cfg.ownerMid)) return true;
  return typeof target.uname === 'string' && target.uname !== '' && target.uname === cfg.ownerName;
}

/** 加上昵称判定的完整主人判定（源文件 isOwner(cfg, { mid, uname }) 的等价形式）。 */
export function isOwnerTarget(cfg, target = {}) {
  return isOwner(target, cfg);
}

/**
 * 主人 @ 名单：把 ownerName/ownerMid（以及 ownerNames/ownerMids 数组）按位置配成
 * [{ name, mid }]，供动态发真 @（富文本 type=2 节点）用。缺 UID 的条目直接丢掉，
 * 调用方会退回纯文本 @。
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
 * 视频一级评论的策略判断。
 * @param options.cfg - 生效配置。
 * @param options.ledger - 账本对象。
 * @param options.bvid - 目标视频 bvid（用于去重）。
 * @param options.message - 评论正文。
 * @param options.confirm - 主人是否已经点头。
 * @param options.now - 当前时间戳（毫秒，测试可注入）。
 * @returns {{allowed: boolean, needsConfirm: boolean, mode: string, reasons: string[], warnings: string[], message: string, hint: string}}
 */
export function checkVideoComment({ cfg, ledger, bvid, message, confirm = false, now = Date.now() }) {
  const mode = cfg.policy.postVideoComment;
  const reasons = [];
  const warnings = [];
  const counts = todayCounts(ledger, new Date(now));
  const text = String(message ?? '').trim();
  if (mode === 'off') reasons.push('配置里 postVideoComment = off，禁止评论视频');
  if (text === '') reasons.push('评论内容为空');
  if (text.length > Number(cfg.policy.maxCommentChars)) {
    reasons.push(`评论 ${text.length} 字，超过上限 ${cfg.policy.maxCommentChars} 字（防刷屏）`);
  }
  const blocked = hitBlocked(text, cfg.policy.blockKeywords);
  if (blocked !== null) reasons.push(`命中屏蔽词「${blocked}」`);
  if (cfg.policy.dedupePerVideo === true && bvid && commentedVideo(ledger, bvid) !== null) {
    reasons.push(`这个视频（${bvid}）已经评论过了`);
  }
  if (counts.videoComments >= Number(cfg.policy.dailyVideoComments)) {
    reasons.push(`今日视频评论已达上限 ${cfg.policy.dailyVideoComments} 条`);
  }
  const interval = intervalOk(cfg, ledger, now, false);
  if (!interval.ok) reasons.push(interval.reason);
  const needsConfirm = mode === 'confirm' && confirm !== true;
  return {
    allowed: reasons.length === 0 && !needsConfirm,
    needsConfirm,
    mode,
    reasons,
    warnings,
    message: text,
    hint: needsConfirm ? '这是草稿模式：把草稿给主人看，主人说发再用 confirm=true 重调。' : '',
  };
}

/**
 * 回复评论的策略判断。
 * @param options.cfg - 生效配置。
 * @param options.ledger - 账本对象。
 * @param options.bvid - 视频 bvid（仅用于返回体，不参与 rootRpid 兜底）。
 * @param options.root - 一级评论 rpid（0/空表示这是一级评论，回复时 root=rpid）。
 * @param options.rpid - 可选：要回复的那条评论的 rpid。源文件 root 为 0 时会回退到它，签名没给就只能用 root 本身。
 * @param options.message - 回复正文。
 * @param options.toMid - 被回复者 UID。
 * @param options.toName - 被回复者昵称。
 * @param options.confirm - 主人是否已经点头。
 * @param options.selfMid - 自己的 UID，用于拒绝自问自答。
 * @param options.now - 当前时间戳（毫秒，测试可注入）。
 * @returns {{allowed: boolean, needsConfirm: boolean, mode: string, owner: boolean, rootRpid: *, warnings: string[], reasons: string[], message: string, hint: string}}
 */
export function checkReply({ cfg, ledger, bvid, root, rpid, message, toMid, toName, confirm = false, selfMid = null, now = Date.now() }) {
  const mode = cfg.policy.postReply;
  const reasons = [];
  const warnings = [];
  const text = String(message ?? '').trim();
  const target = { mid: toMid, uname: toName, root };
  const owner = isOwnerTarget(cfg, target);
  // 源文件 lib/policy.js 是 rootRpid = Number(target.root) > 0 ? target.root : target.rpid；
  // 固定签名把 target 拆成了 root/toMid/toName，原 target.rpid 对应这里的可选 rpid 参数
  // （调用方没传时就是 undefined，与源文件遇到 target 没有 rpid 时完全一样）。
  const rootRpid = Number(root) > 0 ? root : rpid;
  const counts = todayCounts(ledger, new Date(now));

  if (mode === 'off') reasons.push('配置里 postReply = off，禁止回复');
  if (text === '') reasons.push('回复内容为空');
  if (text.length > Number(cfg.policy.maxCommentChars)) {
    reasons.push(`回复 ${text.length} 字，超过上限 ${cfg.policy.maxCommentChars} 字`);
  }
  const blocked = hitBlocked(text, cfg.policy.blockKeywords);
  if (blocked !== null) reasons.push(`命中屏蔽词「${blocked}」`);
  const self = selfMid !== null && String(toMid) === String(selfMid);
  if (self) reasons.push('这是她自己发的评论，不回自己');
  if (cfg.policy.replyScope === 'owner-only' && !owner) reasons.push('配置里 replyScope = owner-only：只回主人');

  if (!owner && !self) {
    const perThread = Number(cfg.policy.replyPerUserPerThread) || 0;
    const used = threadReplyCount(ledger, rootRpid, toMid);
    if (perThread > 0 && used >= perThread) {
      reasons.push(`「${toName ?? toMid}」在这条评论串里已经被回过 ${used} 条了（每人每串上限 ${perThread}）`);
    }
    const windowHours = Number(cfg.policy.replyPerUserWindowHours) || 0;
    if (windowHours > 0) {
      const last = lastReplyTsForUser(ledger, toMid);
      const hours = last === 0 ? Number.POSITIVE_INFINITY : (now - last) / 3600000;
      if (hours < windowHours) {
        reasons.push(`「${toName ?? toMid}」${hours.toFixed(1)} 小时前刚被回过（每人 ${windowHours} 小时一条）`);
      }
    }
  } else if (owner) {
    warnings.push('主人优先：跳过「每人一条」限制');
  }

  if (counts.replies >= Number(cfg.policy.dailyReplies)) {
    reasons.push(`今日回复已达上限 ${cfg.policy.dailyReplies} 条`);
  }
  const interval = intervalOk(cfg, ledger, now, owner);
  if (!interval.ok) reasons.push(interval.reason);

  const needsConfirm = mode === 'confirm' && confirm !== true;
  return {
    allowed: reasons.length === 0 && !needsConfirm,
    needsConfirm,
    mode,
    owner,
    rootRpid,
    warnings,
    reasons,
    message: text,
    hint: needsConfirm ? '这是草稿模式：先给主人看，主人点头后再用 confirm=true 重调。' : '',
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
export function checkTriple({ cfg, ledger, video, score = 0, confirm = false, now = Date.now() }) {
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
  if (aid > 0 && tripledAlready(ledger, aid)) reasons.push(`这个视频（aid=${aid}）已经三连过了`);
  const limit = Number(cfg?.policy?.dailyTriples ?? 5);
  if (limit > 0 && tripleCountToday(ledger, new Date(now)) >= limit) reasons.push(`今日三连已达上限 ${limit} 个`);
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

/**
 * 发动态的策略判断。
 * @param options.cfg - 生效配置。
 * @param options.ledger - 账本对象。
 * @param options.text - 动态正文。
 * @param options.confirm - 主人是否已经点头。
 * @param options.auto - true 表示定时任务调用（受「今天已发过」限制）。
 * @param options.now - 当前时间戳（毫秒，测试可注入）。
 * @returns {{allowed: boolean, needsConfirm: boolean, mode: string, reasons: string[], warnings: string[], message: string, hint: string}}
 */
export function checkDynamic({ cfg, ledger, text, confirm = false, auto = false, now = Date.now() }) {
  const mode = cfg.policy.postDynamic;
  const reasons = [];
  const warnings = [];
  const value = String(text ?? '').trim();
  if (mode === 'off') reasons.push('配置里 postDynamic = off，禁止发动态');
  if (value === '') reasons.push('动态内容为空');
  if (value.length > 2000) reasons.push(`动态 ${value.length} 字，超过 2000 字上限`);
  const blocked = hitBlocked(value, cfg.policy.blockKeywords);
  if (blocked !== null) reasons.push(`命中屏蔽词「${blocked}」`);
  const counts = todayCounts(ledger, new Date(now));
  if (counts.dynamics >= Number(cfg.policy.dailyDynamics)) {
    reasons.push(`今日动态已达上限 ${cfg.policy.dailyDynamics} 条`);
  }
  if (auto === true && dynamicPostedToday(ledger, new Date(now))) {
    reasons.push('今天已经发过动态了');
  }
  const needsConfirm = mode === 'confirm' && confirm !== true && auto !== true;
  return {
    allowed: reasons.length === 0 && !needsConfirm,
    needsConfirm,
    mode,
    reasons,
    warnings,
    message: value,
    hint: needsConfirm ? '草稿模式：把内容给主人看，点头后再发。' : '',
  };
}
