/**
 * 配置与路径解析。
 *
 * 状态根目录：$DSH_HOME/bilibili-whale（DSH_HOME 缺省 ~/.dsh）
 *   cookies.json  登录态（SESSDATA / bili_jct / DedeUserID ...）
 *   config.json   用户覆盖配置（只在显式写入时存在）
 *   ledger.json   账本：已评论视频、已回复评论、每人回复次数、每日配额、动态记录
 *   logs/*.log    运行日志（自动动态、异常）
 *
 * 三层配置优先级：本文件 DEFAULTS < config.json < cordis.patch.yml 的 config。
 *
 * @module dsh-bilibili-whale/config
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';

/** 默认配置。所有字段都可被用户覆盖。 */
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
    /**
     * 每天最多三连几个。**0 = 不限**。
     *
     * 主人 2026-10-05：「不加三连上限，币没了也没事」——投币上限由 B 站自己管，
     * 硬币投完 `tripleVideo` 会把「硬币不足」当成「已经投过」容错掉，点赞和收藏照做。
     */
    dailyTriples: 0,
    /** 刷过的视频报进 B 站浏览记录（历史记录里能看到她刷过什么）。 */
    reportHistory: true,
    /**
     * 主人的私信里认「真命令」（`/搜`、`/转达`、`/帮助`），由本机代码真去执行。
     *
     * 主人 2026-10-05：「我想让她给我转达消息一直做不到」。原因不是转达坏了，而是
     * 私信自动回复**只会说话**，主人在私信里让她办事，她只能回一句「人家这就去」。
     * 命令走代码才办得成（见 `lib/dmcmd.js`）；设 false 就退回「只陪聊」。
     */
    dmCommands: true,
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
    /**
     * 回**主人**的每日上限（单独算，跟上面的 `dailyReplies` 不共用）。**0 = 不限**。
     *
     * 主人 2026-10-05：「我有评论她能回，别人的评论调用免费模型回」，随后又明确
     * 「主人的回复不限额度」。原来主人和陌生人共用一个 `dailyReplies`，主人在评论区
     * 多聊几句就把额度吃光，结果她**连主人的评论都回不了**（真机 11:10/11:15
     * `今日回复已达上限 10 条`）。所以主人这条线默认**不限**；真怕她刷屏就设个正整数。
     */
    dailyRepliesOwner: 0,
    dailyDynamics: 1,
    /** 每天最多收藏几个「刷到觉得好看」的视频。 */
    dailyFavorites: 5,
    /**
     * 三连成功的视频要不要顺手写一条一级评论。主人 2026-10-05：「三连的视频都要评论」。
     *
     * 默认 true：`lib/triple.js` 连完就点评一句（正文由 `composeVideoComment` 写、
     * `checkVideoComment` 把关）。评论没发成**不算三连失败**，原因照实记在回执行里。
     */
    commentOnTriple: true,
    /** 两次对外动作之间的最小间隔（秒）。 */
    minIntervalSeconds: 120,
    /** 回复主人时的最小间隔（秒）——主人优先，允许更勤快。 */
    minIntervalSecondsOwner: 15,
    /**
     * 连着给几个视频评论时，两条之间歇几秒（0 = 不歇）。
     *
     * 三连是一条接一条做的，评论要是也挤在一秒里发，B 站风控会当成刷屏。
     * 刷视频那条路（`lib/dmcmd.js` 的 `watchThese`）按这个值在两条之间等一下。
     */
    minIntervalSecondsComment: 10,
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
};

/** DSH 家目录。 */
export function dshHome() {
  const home = process.env.DSH_HOME;
  return home !== undefined && home.trim() !== '' ? home : join(homedir(), '.dsh');
}

/** 插件状态目录（不存在则创建）。 */
export function stateDir() {
  const dir = join(dshHome(), 'bilibili-whale');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 状态文件路径。 */
export function statePath(name) {
  return join(stateDir(), name);
}

/** 一个对象是不是普通记录。 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 深合并：数组整体替换，记录递归合并，其余覆盖。 */
export function deepMerge(base, patch) {
  if (!isRecord(patch)) return base;
  const out = isRecord(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = isRecord(value) && isRecord(out[key]) ? deepMerge(out[key], value) : value;
  }
  return out;
}

/** 读 JSON，失败返回 fallback（不抛）。 */
export function readJsonFile(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 原子写 JSON：先写 .tmp 再 rename，避免半截文件。 */
export function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

/** 读取用户覆盖配置（config.json）。 */
export function readUserConfig() {
  const value = readJsonFile(statePath('config.json'), null);
  return isRecord(value) ? value : {};
}

/** 生效配置 = DEFAULTS <- config.json <- 插件 config。 */
export function resolveConfig(pluginConfig) {
  return deepMerge(deepMerge(DEFAULTS, readUserConfig()), pluginConfig);
}

/** 把一行追加进日志文件。 */
export function appendLog(file, line) {
  try {
    const path = statePath(join('logs', file));
    mkdirSync(dirname(path), { recursive: true });
    const stamp = new Date().toISOString();
    writeFileSync(path, `${stamp} ${line}\n`, { encoding: 'utf8', flag: 'a' });
  } catch {
    /* 日志失败不影响主流程 */
  }
}
