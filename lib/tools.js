/**
 * 面向模型的 B 站工具集（10 个）。
 *
 * 设计原则：
 *   1. 读操作随便用（刷推荐、看视频、读评论、搜索）——这是她「刷 B 站」的眼睛。
 *   2. 写操作全部过 policy.js 的策略闸门：去重、每日配额、最小间隔、每人一条、
 *      主人优先；confirm 模式下只出草稿，绝不偷偷发出去。
 *   3. 每次执行都重新读盘（config.json / cookies.json / ledger.json），
 *      所以模型改完配置立刻生效，不需要重启 DSH。
 *
 * @module dsh-bilibili-whale/tools
 */
import { DEFAULTS, appendLog, deepMerge, readJsonFile, readUserConfig, resolveConfig, writeJsonFile, statePath } from './config.js';
import { pushConfig } from './cloudsync.js';
import { tripleVideo, reportHistory } from './triple.js';
import { clearSession, hasWriteCredentials, loadSession, parseCookieString, saveSession } from './cookies.js';
import { BiliClient, BiliError, decodeEntities, stripHtml } from './api.js';
import {
  commentedVideo,
  dmCountForUser,
  dynamicPostedToday,
  favoritedAlready,
  followedAlready,
  lastDmOutgoingTs,
  loadLedger,
  pushMaterial,
  recordComment,
  recordDm,
  recordDmIncoming,
  recordDynamic,
  recordFavorite,
  recordFollow,
  recordReply,
  saveLedger,
  takeMaterial,
  threadReplyCount,
  todayCounts,
  todayStudy,
} from './ledger.js';
import { draftDmReply } from './brain.js';
import { checkDm, checkDmReply, checkDynamic, checkFavorite, checkFollow, checkReply, checkTriple, checkVideoComment, isOwner, ownerMentionList, withOwnerMentions } from './policy.js';
import { composeStudyDynamic, learnOnce, pickTopic, studyConfig, studySummary } from './study.js';
import { kbContext, kbFiles, searchKnowledge, writeKnowledgeBase } from './kb.js';
import { queueDraft } from './pending.js';
import { writeQrPage } from './qrpage.js';
import { pathToFileURL } from 'node:url';

/** 把作者 DSL 编译成 JSON Schema（与 dsh-ffmpeg 同一套写法）。 */
function compileParameters(spec) {
  const properties = {};
  const required = [];
  for (const [key, prop] of Object.entries(spec)) {
    if (prop?.required === true) required.push(key);
    const node = {};
    if (typeof prop?.type === 'string') node.type = prop.type;
    if (typeof prop?.description === 'string') node.description = prop.description;
    properties[key] = node;
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}

function asRecord(value) {
  return typeof value === 'object' && value !== null ? value : {};
}

function requiredString(args, key, label) {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label}（参数 ${key}）为必填，请提供非空字符串。`);
  }
  return value.trim();
}

function optionalString(args, key) {
  const value = args[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * 统一清洗要发出去的正文。
 *
 * 文本会穿过 shell / JSON / 模板好几层，很容易带进 `&#180;` 这类 HTML 实体
 * 或者标签；这里先还原实体再去标签，免得评论/私信里出现一串乱码。
 */
function cleanText(value) {
  return typeof value === 'string' ? decodeEntities(stripHtml(value)).trim() : '';
}

/**
 * 给「脑子」一句她自己现在能干什么的上下文。
 *
 * 不写这句，模型会答「人家现在还不能刷视频」这类自我否定的话——
 * 她其实早就能刷热门、能评论、能收藏了。
 */
function capabilityNote(cfg) {
  const owners = [cfg.ownerName, ...(cfg.ownerNames ?? [])].filter((name) => typeof name === 'string' && name !== '');
  const unique = [...new Set(owners)];
  return [
    '她（小鲸鱼娘）现在真的会：刷 B 站热门/推荐/搜索视频、看视频详情和评论区、',
    '在视频下发一级评论、回复别人的评论、收藏喜欢的视频、发学习动态、收发私信；',
    '她的 B 站号已经 Lv2、能发评论和动态。',
    owners.length === 0 ? '' : `主人有这两位：${unique.join('、')}。`,
    '主人问「能不能」时按上面如实回答，别说自己做不到。',
  ].filter((line) => line !== '').join('');
}

/**
 * 她最近真的做过什么——不写这句，「脑子」就不知道话已经带到了、视频已经刷完了。
 */
function recentDoings(ledger) {
  const parts = [];
  for (const item of (ledger.dms ?? []).slice(-3)) {
    parts.push(`给「${item.uname ?? item.mid}」发过私信：「${String(item.text ?? '').slice(0, 50)}」`);
  }
  for (const item of (ledger.replies ?? []).slice(-2)) {
    parts.push(`回过 ${item.bvid} 下面的评论`);
  }
  for (const item of (ledger.comments ?? []).slice(-2)) {
    parts.push(`在 ${item.bvid} 发过一级评论`);
  }
  for (const item of (ledger.favorites ?? []).slice(-2)) {
    parts.push(`收藏了《${String(item.title ?? item.bvid ?? '').slice(0, 30)}》`);
  }
  return parts.length === 0 ? '' : `人家最近做过的事（回答「办了吗」时照实说）：${parts.join('；')}。`;
}

/**
 * 把「@我的」里最近几条搬进「脑子」的上下文。
 *
 * 主人 2026-10-05 在私信里说「你看一下我给你的@」——以前她只读「回复我的」，
 * @ 走的却是另一个接口，所以她只能回一句「人家没法翻主人的@记录呢」。
 * 现在读得到，就把最近 3 条照实喂给脑子，主人问「我@你了吗」时能答上。
 */
async function mentionsNote(client, cfg) {
  try {
    const feed = await client.msgMentions({ ps: 20 });
    const rows = (feed.items ?? []).slice(0, 3);
    if (rows.length === 0) return '；主人的「@我的」里最近没有消息（可能主人还没 @ 过人家）。';
    const parts = rows.map((item) => {
      const where = item.subject !== '' ? `《${String(item.subject).slice(0, 30)}》` : (item.bvid === null ? '某处' : item.bvid);
      return `${item.ctime} 在 ${where} @ 了人家：「${String(item.message ?? '').slice(0, 60)}」（${item.bvid === null ? `rpid=${item.rpid}` : `${item.bvid}，rpid=${item.rpid}`}）`;
    });
    return `；主人最近 @ 了人家（回答「我@你了吗」时照实说，别再说看不到）：${parts.join('；')}。`;
  } catch (error) {
    return `；（「@我的」读失败：${error.message}）`;
  }
}

/**
 * 挑一句自动应答。
 *
 * 先看 `dmAck.rules`（命中关键词就直答，比如「能说话吗」→「在的在的！」），
 * 都没命中就按发出条数轮换 `dmAck.templates`。这样后台没人喂模型时，
 * 主人的一句「在吗」也不会收到驴唇不对马嘴的寒暄。
 */
function pickDmAck(cfg, ledger, incomingText) {
  const text = String(incomingText ?? '');
  const rules = Array.isArray(cfg.dmAck?.rules) ? cfg.dmAck.rules : [];
  for (const rule of rules) {
    const words = Array.isArray(rule?.match) ? rule.match : [];
    if (words.some((word) => String(word).length > 0 && text.includes(String(word)))) {
      return String(rule.reply ?? '').trim() || '人家在的！(。-ω´-)✧';
    }
  }
  const templates = Array.isArray(cfg.dmAck?.templates) ? cfg.dmAck.templates : [];
  if (templates.length === 0) return '人家收到你的消息啦～';
  return String(templates[(ledger.dms ?? []).length % templates.length]);
}

function optionalNumber(args, key, fallback) {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionalBool(args, key, fallback = false) {
  const value = args[key];
  return typeof value === 'boolean' ? value : fallback;
}

/** 数字人类可读：1.2万 / 3.4亿。 */
function fmtCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '未知';
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(n);
}

/** 主人清单文案（支持多个主人）。 */
function ownersText(value) {
  const pairs = [];
  const push = (mid, name) => {
    if (mid === null || mid === undefined || String(mid) === '') return;
    if (pairs.some((item) => item.mid === String(mid))) return;
    pairs.push({ mid: String(mid), name: typeof name === 'string' && name !== '' ? name : '' });
  };
  push(value.ownerMid, value.ownerName);
  const mids = Array.isArray(value.ownerMids) ? value.ownerMids : [];
  const names = Array.isArray(value.ownerNames) ? value.ownerNames : [];
  mids.forEach((mid, index) => push(mid, names[index]));
  if (pairs.length === 0) {
    const only = [value.ownerName, ...names].filter((item) => typeof item === 'string' && item !== '');
    return `${[...new Set(only)].join('、') || '（未配置）'}（还没记下 UID，只按昵称认）`;
  }
  return pairs.map((item) => `${item.name === '' ? '主人' : item.name}（UID ${item.mid}）`).join('、');
}

/** 一屏文本渲染器。 */
function textRenderer(lines) {
  return (args, value) => [{ type: 'text', text: lines(asRecord(value)).join('\n') }];
}

const looseSchema = { type: 'object', additionalProperties: true };

/** 把草稿包装成统一回复：策略不允许时也返回结构化原因，模型据此解释给主人听。 */
function gateResult(action, verdict, payload) {
  return {
    action,
    allowed: verdict.allowed === true,
    needsConfirm: verdict.needsConfirm === true,
    mode: verdict.mode,
    reasons: verdict.reasons ?? [],
    warnings: verdict.warnings ?? [],
    hint: verdict.hint ?? '',
    ...payload,
  };
}

/** 渲染「策略拒绝/等确认」的结果。 */
function renderGate(value) {
  const rec = asRecord(value);
  const lines = [];
  if (rec.allowed === true) {
    lines.push(`已执行：${rec.action}`);
  } else if (rec.needsConfirm === true) {
    lines.push(`草稿（模式 ${rec.mode}，等主人点头）：${rec.action}`);
  } else {
    lines.push(`没发出去：${rec.action} 被策略拦下（模式 ${rec.mode}）`);
  }
  if (typeof rec.draft === 'string' && rec.draft !== '') lines.push(`草稿内容：${rec.draft}`);
  const reasons = Array.isArray(rec.reasons) ? rec.reasons : [];
  for (const reason of reasons) lines.push(`- 拦下原因：${reason}`);
  const warnings = Array.isArray(rec.warnings) ? rec.warnings : [];
  for (const warning of warnings) lines.push(`- 提醒：${warning}`);
  if (typeof rec.hint === 'string' && rec.hint !== '') lines.push(rec.hint);
  if (rec.rpid !== undefined && rec.rpid !== null) lines.push(`评论 rpid：${rec.rpid}`);
  return [{ type: 'text', text: lines.join('\n') }];
}

/** 人类可读的「她今天干了什么」。 */
function renderLedgerLines(ledger, cfg) {
  const counts = todayCounts(ledger);
  const lines = [
    `今日：视频评论 ${counts.videoComments}/${cfg.policy.dailyVideoComments}，回复 ${counts.replies}/${cfg.policy.dailyReplies}，动态 ${counts.dynamics}/${cfg.policy.dailyDynamics}`,
  ];
  const recentComments = ledger.comments.slice(-3).reverse();
  for (const item of recentComments) lines.push(`- 评论过 ${item.bvid}：${item.text.slice(0, 40)}`);
  const recentReplies = ledger.replies.slice(-3).reverse();
  for (const item of recentReplies) lines.push(`- 回复过 ${item.targetUname}：${item.text.slice(0, 40)}`);
  if (dynamicPostedToday(ledger)) lines.push('- 今天的学习动态：已发');
  else lines.push('- 今天的学习动态：还没发');
  return lines;
}

/**
 * 构建 10 个工具定义。
 * @param options.pluginConfig - cordis.patch.yml 里给的 config。
 * @param options.openBrowser - (url) => Promise<void>，扫码页打开方式（由 index.js 注入）。
 * @param options.sessionInfo - 返回当前登录信息的小回调（可选）。
 */
export function buildBiliTools({ pluginConfig = {}, openBrowser = async () => {} } = {}) {
  /** 每次执行都重新读盘，保证配置/账本/登录态是最新的。 */
  const runtime = () => {
    const cfg = resolveConfig(pluginConfig);
    const session = loadSession();
    const ledger = loadLedger();
    const client = new BiliClient({ config: cfg, session });
    return { cfg, session, ledger, client };
  };

  /** 拿自己的 mid（登录态里存着，没存就问 nav）。 */
  async function selfMid(client, session) {
    const stored = session?.user?.mid;
    if (stored !== undefined && stored !== null) return stored;
    try {
      const nav = await client.nav();
      return nav?.mid ?? null;
    } catch {
      return null;
    }
  }

  /** 按昵称找主人的 UID（best-effort，用于稳定识别「主人」）。 */
  async function findOwnerMid(client, name) {
    try {
      const body = await client.request('/x/web-interface/wbi/search/type', {
        signed: true,
        params: { search_type: 'bili_user', keyword: name, page: 1 },
      });
      const list = body?.data?.result ?? [];
      const exact = list.find((item) => item.uname === name) ?? list[0];
      return exact?.mid ?? null;
    } catch {
      return null;
    }
  }

  const login = {
    name: 'bili_login',
    description:
      '小鲸鱼娘的 B 站登录（扫码）。op=status 查登录态；op=start 生成二维码页面（会顺手用默认浏览器打开，主人用手机 B 站 App 扫屏幕上的二维码）；op=poll 轮询扫码结果（需要 qrcodeKey），成功后 cookie 落盘；op=import 直接导入 cookie 字符串；op=logout 退出登录。',
    parameters: compileParameters({
      op: { type: 'string', required: true, description: 'status | start | poll | import | logout' },
      qrcodeKey: { type: 'string', description: 'op=poll 时必填，start 返回的 qrcode_key。' },
      cookie: { type: 'string', description: 'op=import 时的 cookie 字符串（SESSDATA=...; bili_jct=...; DedeUserID=...）。' },
      open: { type: 'boolean', description: 'op=start 时是否自动打开扫码页（默认 true）。' },
    }),
    output: { schema: looseSchema, render: textRenderer((value) => {
      const lines = [`登录操作：${value.op ?? ''}`];
      if (value.loggedIn === true) {
        lines.push(`已登录：${value.uname ?? ''}（UID ${value.mid ?? '?'}）`);
        lines.push(`可写权限（bili_jct）：${value.canWrite === true ? '有' : '没有'}`);
      } else if (value.op === 'start') {
        lines.push(`二维码页面：${value.qrPage ?? '（未写出）'}`);
        lines.push(`二维码内容：${value.url ?? ''}`);
        lines.push(`qrcode_key：${value.qrcodeKey ?? ''}`);
        lines.push('请主人用手机 B 站 App 扫屏幕上的二维码，并在手机上点「确认登录」；扫完调用 bili_login op=poll 轮询结果。');
      } else if (value.op === 'poll') {
        lines.push(`轮询结果：${value.state ?? ''}（code=${value.code ?? ''}）`);
      } else if (value.op === 'import') {
        lines.push(value.ok === true ? 'cookie 已导入。' : `导入失败：${value.error ?? ''}`);
      } else {
        lines.push(value.loggedIn === true ? '未登录' : '未登录（没有可用的 cookie）');
      }
      for (const note of value.notes ?? []) lines.push(`- ${note}`);
      return lines;
    }) },
    async execute(rawArgs) {
      const args = asRecord(rawArgs);
      const op = requiredString(args, 'op', '操作').toLowerCase();
      const { cfg, session, client } = runtime();
      if (op === 'status') {
        const nav = await client.nav();
        return {
          op,
          loggedIn: nav.isLogin === true,
          uname: nav.uname ?? '',
          mid: nav.mid ?? null,
          canWrite: client.canWrite(),
          cookieSaved: hasWriteCredentials(session?.cookies ?? {}),
          ownerName: cfg.ownerName,
          notes: nav.isLogin === true ? [] : ['还没登录：op=start 生成二维码，主人扫码后 op=poll。'],
        };
      }
      if (op === 'start') {
        const qr = await client.qrGenerate();
        const shouldOpen = optionalBool(args, 'open', true);
        const notes = [];
        // 把登录链接画成本地二维码页面：手机 B 站 App 扫码才是正确的登录姿势，
        // 直接在已登录的桌面浏览器里打开这个链接只会显示「当前账号 + 确认」，没用。
        let pageFile = null;
        try {
          pageFile = writeQrPage(qr.url, statePath('login-qr.html'));
        } catch (error) {
          notes.push(`二维码页面写出失败（${error.message}），可以直接把链接复制到手机里打开。`);
        }
        if (shouldOpen && pageFile !== null) {
          try {
            await openBrowser(pathToFileURL(pageFile).href);
            notes.push('已经用默认浏览器打开二维码页面了。');
          } catch (error) {
            notes.push(`自动打开失败（${error.message}）：请主人手动打开二维码页面。`);
          }
        }
        if (hasWriteCredentials(session?.cookies ?? {})) {
          notes.push('现在 cookie 里已经有登录态了；重新扫码会覆盖成新账号。');
        }
        writeJsonFile(statePath('pending-qr.json'), { url: qr.url, qrcodeKey: qr.qrcodeKey, ts: Date.now() });
        return { op, url: qr.url, qrcodeKey: qr.qrcodeKey, qrPage: pageFile, notes };
      }
      if (op === 'poll') {
        const key = optionalString(args, 'qrcodeKey') ?? loadQrKey();
        if (key === undefined) throw new Error('缺少 qrcodeKey：先 op=start 生成二维码。');
        const result = await client.qrPoll(key);
        const stateMap = { 0: '扫码成功', 86101: '还没扫码', 86090: '已扫码，等手机确认', 86038: '二维码已过期' };
        if (result.code !== 0) {
          return { op, code: result.code, state: stateMap[result.code] ?? result.message, notes: result.code === 86038 ? ['重新 op=start 生成新二维码。'] : [] };
        }
        const merged = { ...(session?.cookies ?? {}), ...result.cookies };
        const verified = new BiliClient({ config: cfg, session: { cookies: merged } });
        const nav = await verified.nav();
        const notes = [];
        let ownerMid = cfg.ownerMid ?? null;
        if (ownerMid === null) {
          ownerMid = await findOwnerMid(verified, cfg.ownerName);
          if (ownerMid !== null) {
            const userConfig = readUserConfig();
            userConfig.ownerMid = ownerMid;
            writeJsonFile(statePath('config.json'), userConfig);
            notes.push(`已把主人的 UID 记下来：${cfg.ownerName} = ${ownerMid}（回复时优先认主人）。`);
          } else {
            notes.push(`没能查到「${cfg.ownerName}」的 UID，暂时只按昵称认主人。`);
          }
        }
        saveSession({
          cookies: merged,
          savedAt: new Date().toISOString(),
          user: { mid: nav.mid ?? null, uname: nav.uname ?? '', isLogin: nav.isLogin === true },
        });
        return { op, code: result.code, state: stateMap[0], loggedIn: nav.isLogin === true, uname: nav.uname ?? '', mid: nav.mid ?? null, canWrite: hasWriteCredentials(merged), notes };
      }
      if (op === 'import') {
        const raw = requiredString(args, 'cookie', 'cookie 字符串');
        const cookies = parseCookieString(raw);
        if (!hasWriteCredentials(cookies)) {
          return { op, ok: false, error: 'cookie 里缺少 SESSDATA 或 bili_jct，写操作会失败。' };
        }
        const verified = new BiliClient({ config: cfg, session: { cookies } });
        const nav = await verified.nav();
        saveSession({ cookies, savedAt: new Date().toISOString(), user: { mid: nav.mid ?? null, uname: nav.uname ?? '', isLogin: nav.isLogin === true } });
        return { op, ok: true, loggedIn: nav.isLogin === true, uname: nav.uname ?? '', mid: nav.mid ?? null, canWrite: true, notes: [] };
      }
      if (op === 'logout') {
        clearSession();
        return { op, loggedIn: false, canWrite: false, notes: ['本地 cookie 已清空（B 站端登录态不受影响）。'] };
      }
      throw new Error(`不支持的 op：${op}`);
    },
    timeoutMs: 40000,
  };

  /** 读取上一次 start 留下的 qrcode_key（模型不用自己记）。 */
  function loadQrKey() {
    const pending = readJsonFile(statePath('pending-qr.json'), null);
    if (pending !== null && typeof pending.qrcodeKey === 'string' && pending.qrcodeKey !== '') return pending.qrcodeKey;
    return undefined;
  }

  const status = {
    name: 'bili_status',
    description:
      '小鲸鱼娘的 B 站总览：登录态、可写权限、今天的配额用了多少、今天的学习动态发没发、最近评论/回复记录、当前策略模式（auto/confirm/off）与关键限流参数。开工前先看这个。',
    parameters: compileParameters({}),
    output: { schema: looseSchema, render: textRenderer((value) => {
      const lines = ['小鲸鱼娘 B 站状态：'];
      lines.push(`- 登录：${value.loggedIn === true ? `已登录 ${value.uname}（UID ${value.mid ?? '?'}）` : '未登录'}`);
      lines.push(`- 写权限：${value.canWrite === true ? '可以发评论/动态' : '只能读（先 bili_login）'}`);
      lines.push(`- 等级：Lv${value.level ?? '?'}${value.level === 0 ? '（未转正：B 站会拒发动态/评论，错误码 4126021，先做转正答题）' : ''}`);
      lines.push(`- 主人：${ownersText(value)}`);
      lines.push(`- 策略：视频评论 ${value.modes?.postVideoComment}，回复 ${value.modes?.postReply}，动态 ${value.modes?.postDynamic}`);
      lines.push(`- 今日：评论 ${value.today?.videoComments}，回复 ${value.today?.replies}，动态 ${value.today?.dynamics}`);
      lines.push(`- 今天的动态：${value.dynamicPostedToday === true ? '已发' : '未发'}${value.dailyDynamic?.enabled === true ? `（自动动态 ${value.dailyDynamic.at}）` : '（自动动态关闭）'}`);
      for (const line of value.recent ?? []) lines.push(`- 最近：${line}`);
      return lines;
    }) },
    async execute() {
      const { cfg, session, ledger, client } = runtime();
      let nav = { isLogin: false };
      try {
        nav = await client.nav();
      } catch (error) {
        nav = { isLogin: false, error: error.message };
      }
      const recent = [];
      for (const item of ledger.comments.slice(-3).reverse()) recent.push(`评论 ${item.bvid}：${item.text.slice(0, 40)}`);
      for (const item of ledger.replies.slice(-3).reverse()) recent.push(`回复 ${item.targetUname}：${item.text.slice(0, 40)}`);
      for (const item of ledger.dynamics.slice(-2).reverse()) recent.push(`动态 ${item.date}：${item.text.slice(0, 40)}`);
      return {
        loggedIn: nav.isLogin === true,
        uname: nav.uname ?? session?.user?.uname ?? '',
        mid: nav.mid ?? session?.user?.mid ?? null,
        canWrite: client.canWrite(),
        level: nav.level ?? null,
        exp: nav.exp ?? null,
        nextExp: nav.nextExp ?? null,
        mobileVerified: nav.mobileVerified === true,
        ownerName: cfg.ownerName,
        ownerMid: cfg.ownerMid ?? null,
        modes: {
          postVideoComment: cfg.policy.postVideoComment,
          postReply: cfg.policy.postReply,
          postDynamic: cfg.policy.postDynamic,
        },
        today: todayCounts(ledger),
        dynamicPostedToday: dynamicPostedToday(ledger),
        dailyDynamic: { enabled: cfg.dailyDynamic.enabled === true, at: cfg.dailyDynamic.at },
        recent,
        error: nav.error ?? null,
      };
    },
    timeoutMs: 30000,
  };

  const config = {
    name: 'bili_config',
    description:
      '读/改小鲸鱼娘的运行配置（落盘到 $DSH_HOME/bilibili-whale/config.json，改完立刻生效）。op=get 看当前生效配置；op=set 用 patch 传入要改的字段（深合并，比如 {"policy":{"postVideoComment":"auto"}}）；op=reset 清掉用户覆盖回到默认。',
    parameters: compileParameters({
      op: { type: 'string', required: true, description: 'get | set | reset' },
      patch: { type: 'string', description: 'op=set 时的 JSON 字符串，深合并进配置。' },
    }),
    output: { schema: looseSchema, render: textRenderer((value) => {
      if (value.op === 'set') {
        return [`配置已更新：${(value.changed ?? []).join('，') || '（无变化）'}`, `当前策略：视频评论 ${value.effective?.policy?.postVideoComment}，回复 ${value.effective?.policy?.postReply}，动态 ${value.effective?.policy?.postDynamic}`];
      }
      if (value.op === 'reset') return ['已清掉用户覆盖配置，回到默认值。'];
      return [
        `主人：${value.effective?.ownerName}（UID ${value.effective?.ownerMid ?? '未记录'}）`,
        `策略：视频评论 ${value.effective?.policy?.postVideoComment}，回复 ${value.effective?.policy?.postReply}，动态 ${value.effective?.policy?.postDynamic}`,
        `限流：每日评论 ${value.effective?.policy?.dailyVideoComments}，每日回复 ${value.effective?.policy?.dailyReplies}，最小间隔 ${value.effective?.policy?.minIntervalSeconds}s`,
        `别人每人每串 ${value.effective?.policy?.replyPerUserPerThread} 条 / ${value.effective?.policy?.replyPerUserWindowHours} 小时一条`,
        `自动动态：${value.effective?.dailyDynamic?.enabled === true ? `${value.effective?.dailyDynamic?.at} 每天一条` : '关闭'}`,
        `用户覆盖文件：${value.userConfigPath}`,
      ];
    }) },
    async execute(rawArgs) {
      const args = asRecord(rawArgs);
      const op = requiredString(args, 'op', '操作').toLowerCase();
      const pluginResolved = resolveConfig(pluginConfig);
      if (op === 'get') {
        const { cfg } = runtime();
        return { op, effective: cfg, userConfigPath: statePath('config.json'), defaults: DEFAULTS };
      }
      if (op === 'reset') {
        writeJsonFile(statePath('config.json'), {});
        return { op, effective: resolveConfig(pluginConfig) };
      }
      if (op === 'set') {
        const raw = requiredString(args, 'patch', 'patch JSON');
        let patch;
        try {
          patch = JSON.parse(raw);
        } catch (error) {
          throw new Error(`patch 不是合法 JSON：${error.message}`);
        }
        // 必须**深合并**：以前是 `{...readUserConfig(), ...patch}`，于是
        // `{"policy":{"postVideoComment":"auto"}}` 会把整个 policy 组替换成一个键，
        // 其余策略悄悄掉回默认值（还看不出来）。
        const userConfig = deepMerge(readUserConfig(), patch);
        writeJsonFile(statePath('config.json'), userConfig);
        const effective = resolveConfig(pluginConfig);
        const changed = Object.keys(patch);
        appendLog('config.log', `patch=${raw}`);
        // 顺手把配置搬一份到云端：不然云端和本机是两套 cfg（曾经云端没有 ownerNames，
        // 评论里第二位主人永远 @ 不到）。失败只写日志，不影响改配置本身。
        void pushConfig(pluginConfig).catch(() => {});
        return { op, changed, effective, userConfigPath: statePath('config.json') };
      }
      throw new Error(`不支持的 op：${op}`);
    },
    timeoutMs: 15000,
  };

  const feed = {
    name: 'bili_feed',
    description:
      '刷 B 站：source=rcmd 首页推荐 / popular 热门 / ranking 排行榜 / search 关键词搜索（要 keyword）。返回统一格式的视频列表（bvid、标题、UP、播放、时长、推荐理由、链接）。挑好之后再 bili_video 看详情、bili_comments 读评论。',
    parameters: compileParameters({
      source: { type: 'string', description: 'rcmd | popular | ranking | search（默认按配置顺序自动挑）。' },
      keyword: { type: 'string', description: 'source=search 时的关键词。' },
      count: { type: 'number', description: '要几条，默认 10，最多 20。' },
    }),
    output: { schema: looseSchema, render: textRenderer((value) => {
      const lines = [`来源：${value.source}${value.keyword ? `（关键词 ${value.keyword}）` : ''}，共 ${(value.videos ?? []).length} 条`];
      for (const video of value.videos ?? []) {
        lines.push(`- ${video.bvid}｜${video.title}｜UP ${video.author}｜${fmtCount(video.view)}播放｜${video.duration}${video.rcmdReason ? `｜${video.rcmdReason}` : ''}`);
        if (video.url) lines.push(`  ${video.url}`);
      }
      for (const line of value.notes ?? []) lines.push(`- ${line}`);
      return lines;
    }) },
    async execute(rawArgs) {
      const args = asRecord(rawArgs);
      const { cfg, client } = runtime();
      const count = Math.min(Math.max(optionalNumber(args, 'count', 10), 1), 20);
      const keyword = optionalString(args, 'keyword');
      let source = optionalString(args, 'source');
      if (source === undefined) source = keyword !== undefined ? 'search' : (cfg.feed.sources?.[0] ?? 'popular');
      source = source.toLowerCase();
      const notes = [];
      let videos = [];
      if (source === 'search') {
        if (keyword === undefined) throw new Error('source=search 时必须给 keyword。');
        videos = await client.search(keyword);
      } else if (source === 'rcmd') {
        try {
          videos = await client.rcmd(Math.max(count, cfg.feed.ps ?? 12));
        } catch (error) {
          notes.push(`首页推荐失败（${error.message}），回退热门。`);
          videos = await client.popular(count);
        }
      } else if (source === 'popular') {
        videos = await client.popular(Math.max(count, 12));
      } else if (source === 'ranking') {
        videos = await client.ranking();
      } else {
        throw new Error(`不支持的 source：${source}`);
      }
      const exclude = Array.isArray(cfg.feed.excludeKeywords) ? cfg.feed.excludeKeywords : [];
      const filtered = videos
        .filter((video) => !exclude.some((word) => word !== '' && (`${video.title} ${video.desc}`).includes(word)))
        .slice(0, count)
        .map((video) => ({ ...video, commented: commentedVideo(loadLedger(), video.bvid) !== null }));
      return { source, keyword: keyword ?? null, videos: filtered, notes };
    },
    timeoutMs: 30000,
  };

  const video = {
    name: 'bili_video',
    description:
      '看一个视频的详情：标题、UP、简介、分区、标签、播放/点赞/评论数、分P，可选带上一屏热评。判断「这个视频值不值得留言」就看这里。id 传 bvid（BV...）或 aid。',
    parameters: compileParameters({
      id: { type: 'string', required: true, description: 'bvid（BV1xx...）或 aid（数字）。' },
      comments: { type: 'number', description: '顺带返回几条热评，默认 0，最多 20。' },
    }),
    output: { schema: looseSchema, render: textRenderer((value) => {
      const lines = [`《${value.title}》`, `UP：${value.author}（UID ${value.mid}）｜分区：${value.tname}｜时长：${value.duration}`];
      lines.push(`播放 ${fmtCount(value.view)}｜点赞 ${fmtCount(value.like)}｜评论 ${fmtCount(value.reply)}｜弹幕 ${fmtCount(value.danmaku)}`);
      lines.push(`链接：${value.url}`);
      if ((value.tags ?? []).length > 0) lines.push(`标签：${value.tags.join('、')}`);
      if (value.desc) lines.push(`简介：${String(value.desc).slice(0, 300)}`);
      if (value.alreadyCommented === true) lines.push('注意：她已经在这个视频下评论过了（去重会拦）。');
      for (const comment of value.hotComments ?? []) {
        lines.push(`热评 rpid=${comment.rpid}｜${comment.uname}｜${comment.message.slice(0, 80)}${comment.rcount > 0 ? `（${comment.rcount} 条回复）` : ''}`);
      }
      return lines;
    }) },
    async execute(rawArgs) {
      const args = asRecord(rawArgs);
      const id = requiredString(args, 'id', '视频 id');
      const { client } = runtime();
      const detail = await client.video(id);
      detail.tags = await client.tags(id);
      const wantComments = Math.min(Math.max(optionalNumber(args, 'comments', 0), 0), 20);
      if (wantComments > 0) {
        const listed = await client.comments(id, { ps: wantComments, aid: detail.aid });
        detail.hotComments = listed.replies;
      }
      detail.alreadyCommented = commentedVideo(loadLedger(), detail.bvid) !== null;
      return detail;
    },
    timeoutMs: 30000,
  };

  const comments = {
    name: 'bili_comments',
    description:
      '读评论：一级评论 + 每条的楼中楼摘要（含 rpid / UID / 昵称 / 内容 / 时间 / 回复数）。sort=2 热度（默认）、0 时间。要回复谁就抄它的 rpid（回复楼中楼时 root 用一级评论的 rpid）。',
    parameters: compileParameters({
      id: { type: 'string', required: true, description: 'bvid 或 aid。' },
      sort: { type: 'number', description: '2=按热度（默认），0=按时间（未登录时可能被服务端拒，会自动回退热度）。' },
      page: { type: 'number', description: '页码，默认 1。' },
      count: { type: 'number', description: '每页几条，默认 20，最多 20。' },
    }),
    output: { schema: looseSchema, render: textRenderer((value) => {
      const lines = [`评论（共 ${value.total ?? '?'} 条，第 ${value.page} 页，共 ${(value.comments ?? []).length} 条一级评论，排序 ${value.sortUsed === 0 ? '时间' : '热度'}${value.fallback === true ? '（时间序被拒，已回退热度）' : ''}）`];
      for (const comment of value.comments ?? []) {
        lines.push(`- rpid=${comment.rpid}｜${comment.uname}（UID ${comment.mid}）｜${comment.ctime}｜${comment.message.slice(0, 100)}${comment.rcount > 0 ? `｜${comment.rcount} 条回复` : ''}`);
        for (const reply of comment.replies ?? []) {
          lines.push(`    └ rpid=${reply.rpid}（root=${reply.root}）｜${reply.uname}｜${reply.message.slice(0, 80)}`);
        }
      }
      return lines;
    }) },
    async execute(rawArgs) {
      const args = asRecord(rawArgs);
      const id = requiredString(args, 'id', '视频 id');
      const { client } = runtime();
      const sort = optionalNumber(args, 'sort', 2);
      const page = Math.max(optionalNumber(args, 'page', 1), 1);
      const count = Math.min(Math.max(optionalNumber(args, 'count', 20), 1), 20);
      const listed = await client.comments(id, { sort, pn: page, ps: count });
      return {
        bvid: /^BV/i.test(id) ? id : null,
        aid: listed.aid,
        total: listed.page?.count ?? null,
        page,
        sortUsed: listed.sortUsed,
        fallback: listed.fallback === true,
        comments: [...listed.top, ...listed.replies],
      };
    },
    timeoutMs: 30000,
  };

  const comment = {
    name: 'bili_comment',
    description:
      '在视频下发一条一级评论（以小鲸鱼娘女仆的口吻）。默认是草稿：先调一次看 allowed / needsConfirm，把草稿念给主人听；主人同意后再带 confirm=true 重调才会真的发出去。配额（每日条数、最小间隔、同视频去重、屏蔽词）由策略层把关。',
    parameters: compileParameters({
      id: { type: 'string', required: true, description: 'bvid 或 aid。' },
      message: { type: 'string', required: true, description: '评论正文（≤配置的 maxCommentChars 字）。' },
      confirm: { type: 'boolean', description: 'true = 主人已经点头，真的发出去。' },
    }),
    output: { schema: looseSchema, render: (args, value) => renderGate(value) },
    async execute(rawArgs) {
      const args = asRecord(rawArgs);
      const id = requiredString(args, 'id', '视频 id');
      const confirm = optionalBool(args, 'confirm', false);
      const { cfg, ledger, client } = runtime();
      // 主人的规矩：刷视频留言必须 @ 两位主人（长度、屏蔽词都在补完之后再判）。
      const message = withOwnerMentions(cfg, cleanText(requiredString(args, 'message', '评论正文')));
      const detail = await client.video(id);
      const verdict = checkVideoComment({ cfg, ledger, video: detail, message, confirm });
      if (verdict.allowed !== true) {
        return gateResult(`评论《${detail.title}》`, verdict, { draft: message, bvid: detail.bvid });
      }
      const created = await client.commentAdd({ aid: detail.aid, message, bvid: detail.bvid, mentions: ownerMentionList(cfg) });
      const rpid = created?.rpid ?? null;
      recordComment(ledger, { bvid: detail.bvid, aid: detail.aid, rpid, text: message });
      saveLedger(ledger);
      appendLog('actions.log', `comment bvid=${detail.bvid} rpid=${rpid} text=${message}`);
      return gateResult(`评论《${detail.title}》`, verdict, { draft: message, bvid: detail.bvid, rpid, url: `https://www.bilibili.com/video/${detail.bvid}#reply${rpid}` });
    },
    timeoutMs: 40000,
  };

  const reply = {
    name: 'bili_reply',
    description:
      '回复一条评论（楼中楼）。主人「' + '懒寻真」永远优先且不受每人一条限制；别人同一评论串至多回一条、且 24 小时内只回一条（配置可改）。默认草稿：先看 allowed/needsConfirm，主人点头再 confirm=true。回复楼中楼时 root 传一级评论 rpid、rpid 传要回的那条 rpid（只给 rpid 时按它自身当 root 处理）。动态下面的评论要 kind=dynamic 且 id 传**动态 id**（不是 BV 号）。',
    parameters: compileParameters({
      id: { type: 'string', required: true, description: 'bvid / aid；kind=dynamic 时传动态 id。' },
      rpid: { type: 'number', required: true, description: '要回复的评论 rpid。' },
      message: { type: 'string', required: true, description: '回复正文。' },
      root: { type: 'number', description: '所在评论串的一级评论 rpid（回复楼中楼时给）。' },
      kind: { type: 'string', description: 'video（默认）或 dynamic。' },
      uname: { type: 'string', description: '对方昵称（从 bili_comments 抄，用于主人识别与账本记录）。' },
      mid: { type: 'number', description: '对方 UID（从 bili_comments 抄，用于限流判定）。' },
      confirm: { type: 'boolean', description: 'true = 主人已点头，真的发出去。' },
    }),
    output: { schema: looseSchema, render: (args, value) => renderGate(value) },
    async execute(rawArgs) {
      const args = asRecord(rawArgs);
      const id = requiredString(args, 'id', '视频 id');
      const message = cleanText(requiredString(args, 'message', '回复正文'));
      const rpid = optionalNumber(args, 'rpid', undefined);
      if (rpid === undefined) throw new Error('缺少 rpid：先 bili_comments 找到要回复的评论。');
      const confirm = optionalBool(args, 'confirm', false);
      const root = optionalNumber(args, 'root', 0);
      const kind = (optionalString(args, 'kind') ?? 'video').toLowerCase() === 'dynamic' ? 'dynamic' : 'video';
      const { cfg, ledger, client, session } = runtime();
      // 动态评论没有「视频详情」，标题用消息中心带过来的 subject；策略判定（限流/字数/屏蔽词）完全一致。
      const detail = kind === 'dynamic' ? { aid: id, bvid: null, title: optionalString(args, 'subject') ?? '动态' } : await client.video(id);
      const target = { rpid, root, mid: optionalNumber(args, 'mid', null), uname: optionalString(args, 'uname') ?? '' };
      const self = await selfMid(client, session);
      const verdict = checkReply({ cfg, ledger, target, message, confirm, selfMid: self });
      const label = `回复「${target.uname || target.mid}」 ${verdict.owner === true ? '（主人！）' : ''}`;
      if (verdict.allowed !== true) {
        return gateResult(label, verdict, { draft: message, bvid: detail.bvid ?? null, oid: detail.aid, rpid, root: verdict.rootRpid, kind });
      }
      const created = await client.commentAdd({
        aid: detail.aid,
        message,
        root: verdict.rootRpid,
        parent: rpid,
        bvid: detail.bvid,
        mentions: ownerMentionList(cfg),
        type: kind === 'dynamic' ? 17 : 1,
        referer: optionalString(args, 'referer') ?? '',
      });
      const selfRpid = created?.rpid ?? null;
      recordReply(ledger, {
        bvid: detail.bvid ?? null,
        aid: detail.aid,
        rpid,
        root: verdict.rootRpid,
        targetMid: target.mid,
        targetUname: target.uname,
        text: message,
        selfRpid,
        isOwner: verdict.owner === true,
      });
      saveLedger(ledger);
      appendLog('actions.log', `reply kind=${kind} oid=${detail.aid} rpid=${rpid} owner=${verdict.owner === true} text=${message}`);
      const url = kind === 'dynamic'
        ? `https://t.bilibili.com/${detail.aid}#reply${selfRpid}`
        : `https://www.bilibili.com/video/${detail.bvid}#reply${selfRpid}`;
      return gateResult(label, verdict, { draft: message, bvid: detail.bvid ?? null, oid: detail.aid, rpid, root: verdict.rootRpid, selfRpid, kind, url });
    },
    timeoutMs: 40000,
  };

  const dynamic = {
    name: 'bili_dynamic',
    description:
      '发一条 B 站动态（图文纯文本）。默认取账本里的学习素材，没有素材时用她自己的学习模板；每天最多一条（dailyDynamics=1）。confirm 模式只出草稿；auto 模式直接发。auto=true 表示这是定时任务的调用（今天已发过就跳过）。',
    parameters: compileParameters({
      text: { type: 'string', description: '动态正文；不给就用素材队列/模板。' },
      confirm: { type: 'boolean', description: 'true = 主人点头，直接发。' },
      auto: { type: 'boolean', description: 'true = 定时任务调用（受「今天已发过」限制）。' },
    }),
    output: { schema: looseSchema, render: (args, value) => renderGate(value) },
    async execute(rawArgs) {
      const args = asRecord(rawArgs);
      const confirm = optionalBool(args, 'confirm', false);
      const auto = optionalBool(args, 'auto', false);
      const { cfg, ledger, client } = runtime();
      let text = cleanText(optionalString(args, 'text') ?? '');
      if (text === undefined) {
        // 今天真学了东西 → 用「今天学到什么」写动态；否则才轮到素材/模板。
        const studyText = await composeStudyDynamic({ cfg, ledger });
        if (studyText !== '') text = studyText;
      }
      if (text === undefined) {
        const material = takeMaterial(ledger);
        if (material !== null) text = material;
      }
      if (text === undefined) {
        const templates = Array.isArray(cfg.dailyDynamic.templates) ? cfg.dailyDynamic.templates : [];
        const index = Number(ledger.dynamicTemplateIndex) || 0;
        text = templates.length > 0 ? templates[index % templates.length] : '今天也在认真学习呢 (。-`ω´-)✧';
        ledger.dynamicTemplateIndex = index + 1;
      }
      const verdict = checkDynamic({ cfg, ledger, text, confirm, auto });
      if (verdict.allowed !== true) {
        return gateResult('发学习动态', verdict, { draft: text });
      }
      const created = await client.dynamicCreate(text, { mentions: ownerMentionList(cfg) });
      recordDynamic(ledger, { text, dynId: created?.dyn_id_str ?? created?.dynamic_id ?? null });
      saveLedger(ledger);
      appendLog('actions.log', `dynamic text=${text}`);
      return gateResult('发学习动态', verdict, { draft: text, dynId: created?.dyn_id_str ?? null });
    },
    timeoutMs: 40000,
  };

  const ledgerTool = {
    name: 'bili_ledger',
    description:
      '看/维护她的 B 站账本。op=today 今日战果与配额；op=list 最近的动作明细；op=add-material 往学习素材队列塞一条（自动动态优先发素材）；op=clear-materials 清空素材；op=forget 删掉某个视频的「已评论」记录（想重发时用）。',
    parameters: compileParameters({
      op: { type: 'string', required: true, description: 'today | list | add-material | clear-materials | forget' },
      text: { type: 'string', description: 'op=add-material 时的素材正文。' },
      bvid: { type: 'string', description: 'op=forget 时的视频 bvid。' },
      count: { type: 'number', description: 'op=list 时返回几条，默认 10。' },
    }),
    output: { schema: looseSchema, render: textRenderer((value) => {
      const lines = [`账本（${value.op}）`];
      const counts = value.today ?? {};
      lines.push(`今日：视频评论 ${counts.videoComments ?? 0}，回复 ${counts.replies ?? 0}，动态 ${counts.dynamics ?? 0}`);
      for (const item of value.items ?? []) lines.push(`- ${item}`);
      for (const note of value.notes ?? []) lines.push(`- ${note}`);
      return lines;
    }) },
    async execute(rawArgs) {
      const args = asRecord(rawArgs);
      const op = requiredString(args, 'op', '操作').toLowerCase();
      const { cfg, ledger } = runtime();
      if (op === 'today') {
        return { op, today: todayCounts(ledger), dynamicPostedToday: dynamicPostedToday(ledger), items: renderLedgerLines(ledger, cfg), notes: [] };
      }
      if (op === 'list') {
        const count = Math.min(Math.max(optionalNumber(args, 'count', 10), 1), 50);
        const items = [];
        for (const item of ledger.comments.slice(-count).reverse()) items.push(`评论 ${item.bvid}｜rpid=${item.rpid}｜${item.text.slice(0, 60)}`);
        for (const item of ledger.replies.slice(-count).reverse()) items.push(`回复 ${item.targetUname}（UID ${item.targetMid}）｜${item.text.slice(0, 60)}`);
        for (const item of ledger.dynamics.slice(-count).reverse()) items.push(`动态 ${item.date}｜${item.text.slice(0, 60)}`);
        return { op, today: todayCounts(ledger), items, notes: [] };
      }
      if (op === 'add-material') {
        const text = cleanText(requiredString(args, 'text', '素材正文'));
        pushMaterial(ledger, text);
        saveLedger(ledger);
        return { op, today: todayCounts(ledger), items: [], notes: [`已塞入素材：${text}`] };
      }
      if (op === 'clear-materials') {
        ledger.materials = [];
        saveLedger(ledger);
        return { op, today: todayCounts(ledger), items: [], notes: ['素材队列已清空。'] };
      }
      if (op === 'forget') {
        const bvid = requiredString(args, 'bvid', 'bvid');
        const before = ledger.comments.length;
        ledger.comments = ledger.comments.filter((item) => item.bvid !== bvid);
        saveLedger(ledger);
        return { op, today: todayCounts(ledger), items: [], notes: [`删掉 ${before - ledger.comments.length} 条 ${bvid} 的评论记录。`] };
      }
      throw new Error(`不支持的 op：${op}`);
    },
    timeoutMs: 15000,
  };

  const inbox = {
    name: 'bili_inbox',
    description:
      '看「谁回复了/@ 了小鲸鱼娘」：读 B 站消息中心的「回复我的」**和「@我的」**（@ 我的走的是另一个接口，以前漏读——主人 @ 了她，她一条都看不到），挑出还没回过的人（主人优先不限条数、别人同一评论串一条且 24 小时内不重复），再交给 bili_reply 去回。@ 我的目标里 `rpid` 就是那条写着 @ 的评论，回它即回在同一评论串。op=check 列出待回复目标（只读，不发东西）；op=thread 读某条评论串的全部楼中楼；op=raw 打印两个消息中心的原始 JSON（排查字段用）。',
    parameters: compileParameters({
      op: { type: 'string', description: 'check（默认，列待回复目标）| thread（读某条评论串）| raw（原始 JSON）' },
      id: { type: 'string', description: 'op=thread 时的 bvid 或 aid。' },
      root: { type: 'number', description: 'op=thread 时的一级评论 rpid。' },
      count: { type: 'number', description: '最多列出多少个目标，默认 10。' },
      includeAnswered: { type: 'boolean', description: 'true = 已经回过的也列出来（带 answered 标记）。' },
    }),
    output: { schema: looseSchema, render: textRenderer((value) => {
      if (value.op === 'thread') {
        const lines = [`评论串 ${value.bvid ?? ''} root=${value.root}（共 ${value.count ?? '?'} 条回复）`];
        for (const reply of value.replies ?? []) {
          lines.push(`- rpid=${reply.rpid}｜parent=${reply.parent}｜${reply.uname}（UID ${reply.mid}）｜${reply.ctime}｜${reply.message.slice(0, 120)}`);
        }
        for (const note of value.notes ?? []) lines.push(`- ${note}`);
        return lines;
      }
      if (value.op === 'raw') {
        const lines = ['消息中心「回复我的」原始数据（前 1200 字）：', JSON.stringify(value.items ?? []).slice(0, 1200)];
        lines.push('消息中心「@我的」原始数据（前 1200 字）：', JSON.stringify(value.mentionItems ?? []).slice(0, 1200));
        return lines;
      }
      const lines = [`待回复：${(value.targets ?? []).length} 个（回复我的 ${value.total ?? 0} 条 / @我的 ${value.mentionTotal ?? 0} 条）`];
      for (const target of value.targets ?? []) {
        lines.push(
          `- rpid=${target.rpid}（root=${target.replyRoot}）｜${target.uname}（UID ${target.mid}）${target.owner === true ? '｜★主人' : ''}${target.answered === true ? '｜已回过' : ''}${target.kind === 'at' ? '｜＠了人家' : ''}｜${target.ctime}`,
        );
        lines.push(`    他说：${target.message.slice(0, 120)}`);
        if (target.bvid) lines.push(`    在哪：${target.bvid}${target.subject ? `《${String(target.subject).slice(0, 40)}》` : ''}`);
        if (target.myMessage !== '') lines.push(`    人家原话：${target.myMessage.slice(0, 80)}`);
        if (target.subject !== '' && target.bvid === null) lines.push(`    来自：${target.subject.slice(0, 60)}`);
      }
      for (const note of value.notes ?? []) lines.push(`- ${note}`);
      return lines;
    }) },
    async execute(rawArgs) {
      const args = asRecord(rawArgs);
      const op = (optionalString(args, 'op') ?? 'check').toLowerCase();
      const { cfg, ledger, client } = runtime();
      const nav = await client.nav();
      const notes = [];
      if (nav.isLogin !== true) notes.push('还没登录：消息中心读不到，先跑 bili_login。');
      if (nav.level === 0) {
        notes.push('提醒：这个号还是 Lv0（未转正），B 站会拒发动态/评论（错误码 4126021 等级不足）；先让主人做「转正答题」，或每天做任务攒经验。');
      }
      if (op === 'thread') {
        const id = requiredString(args, 'id', '视频 id');
        const root = optionalNumber(args, 'root', undefined);
        if (root === undefined) throw new Error('op=thread 需要 root（一级评论的 rpid）。');
        const detail = await client.video(id);
        const thread = await client.threadReplies({ aid: detail.aid, root, bvid: detail.bvid, ps: 20 });
        return { op, bvid: detail.bvid, title: detail.title, root, count: thread.count, replies: thread.replies, notes };
      }
      const feed = await client.msgReplies({ ps: 20 });
      // 「@我的」是另一个接口（踩过的坑：只读「回复我的」时主人 @ 了她却毫无反应）。
      // 读失败不影响「回复我的」这条老路，只记一句备注。
      let mentionFeed = { code: 0, items: [], raw: { items: [] } };
      try {
        mentionFeed = await client.msgMentions({ ps: 20 });
      } catch (error) {
        notes.push(`「@我的」读失败：${error.message}`);
      }
      if (op === 'raw') {
        return { op, code: feed.code, cursor: feed.cursor, items: feed.raw?.items ?? [], mentionItems: mentionFeed.raw?.items ?? [], notes };
      }
      const selfMid = nav.mid ?? cfg.whaleMid ?? null;
      const includeAnswered = optionalBool(args, 'includeAnswered', false);
      const count = Math.min(Math.max(optionalNumber(args, 'count', 10), 1), 30);
      const seen = new Set();
      const targets = [];
      const pushTarget = (item, kind) => {
        if (item.mid === null || item.mid === undefined || item.mid === selfMid) return;
        const replyRoot = item.root || item.rpid;
        const dedupeKey = `${replyRoot}|${item.mid}`;
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);
        const owner = isOwner(cfg, { mid: item.mid, uname: item.uname });
        const answered = threadReplyCount(ledger, replyRoot, item.mid) > 0;
        if (answered && !includeAnswered && !owner) return;
        const { raw, atDetails, mentionTime, ...rest } = item;
        targets.push({ ...rest, kind, replyRoot, owner, answered });
      };
      // 「@我的」先入列：主人 @ 了她是要她**立刻看见**的，排在「回复我的」前面。
      for (const item of mentionFeed.items ?? []) pushTarget(item, 'at');
      for (const item of feed.items) pushTarget(item, 'reply');
      targets.sort((a, b) => Number(b.owner === true) - Number(a.owner === true) || Number(b.kind === 'at') - Number(a.kind === 'at') || (b.ts ?? 0) - (a.ts ?? 0));
      if (targets.length === 0 && feed.items.length === 0 && (mentionFeed.items ?? []).length === 0) {
        notes.push('消息中心里还没有人回复或 @ 过她 —— 先去评论区发一条，等别人来回。');
      }
      return {
        op,
        total: feed.items.length,
        mentionTotal: (mentionFeed.items ?? []).length,
        selfMid,
        targets: targets.slice(0, count),
        cursor: feed.cursor,
        mentionCursor: mentionFeed.cursor,
        notes,
      };
    },
    timeoutMs: 40000,
  };

  const followTool = {
    name: 'bili_follow',
    description:
      '关注 / 取关某个人，或看自己和某人的关系。默认只允许关注主人（policy.allowFollowOthers 才会关注别人）。op=follow 关注；op=unfollow 取关；op=check 看关系与名片（不写）。给我 mid 时直接查；给 name 时先搜索昵称。',
    parameters: compileParameters({
      op: { type: 'string', description: 'follow | unfollow | check（默认 check）' },
      mid: { type: 'string', description: '对方 UID。' },
      name: { type: 'string', description: '对方昵称（没给 mid 时用来搜）。' },
    }),
    output: { schema: looseSchema, render: (args, value) => {
      const rec = asRecord(value);
      if (rec.allowed === false && rec.needsConfirm !== true) return renderGate(rec);
      return textRenderer((item) => {
      const lines = [`${item.action ?? '看关系'}：${item.name ?? ''}（UID ${item.mid}）${item.owner === true ? '｜★主人' : ''}`];
      if (item.following !== undefined) lines.push(`- 人家关注他了没：${item.following === true ? '已关注' : '还没关注'}`);
      if (item.follower !== undefined) lines.push(`- 他关注人家了没：${item.follower === true ? '已关注' : '还没'}`);
      if (item.fans !== undefined && item.fans !== null) lines.push(`- 他的粉丝：${item.fans}`);
      if (item.sign) lines.push(`- 签名：${item.sign.slice(0, 60)}`);
      if (item.hint) lines.push(`- ${item.hint}`);
      return lines;
      })(args, value);
    } },
    async execute(rawArgs) {
      const args = asRecord(rawArgs);
      const op = (optionalString(args, 'op') ?? 'check').toLowerCase();
      const { cfg, ledger, client } = runtime();
      let mid = optionalString(args, 'mid');
      if (mid === undefined) {
        const name = optionalString(args, 'name');
        if (name === undefined) throw new Error('至少给 mid 或 name 一个。');
        mid = await findOwnerMid(client, name);
        if (mid === null) throw new Error(`搜不到「${name}」，直接给 UID 吧。`);
      }
      const card = await client.card(mid);
      const relation = await client.relation(mid).catch(() => ({}));
      const owner = isOwner(cfg, { mid, uname: card.name });
      if (op === 'check') {
        return {
          action: '看关系',
          mid: card.mid,
          name: card.name,
          owner,
          fans: card.fans,
          sign: card.sign,
          following: relation.following ?? card.following,
          follower: relation.follower,
          level: card.level,
          reasons: [],
          hint: '',
        };
      }
      const act = op === 'unfollow' ? 2 : 1;
      const verdict = checkFollow({ cfg, mid: card.mid, uname: card.name, act });
      if (verdict.allowed !== true) {
        return gateResult(op === 'unfollow' ? '取关' : '关注', verdict, { mid: card.mid, name: card.name, owner, reasons: verdict.reasons, hint: verdict.hint });
      }
      if (act === 1 && followedAlready(ledger, card.mid) === true) {
        return gateResult('关注', verdict, { mid: card.mid, name: card.name, owner, reasons: [], hint: '账本里记着已经关注过了，这一步跳过。' });
      }
      await client.relationModify(card.mid, act);
      recordFollow(ledger, { mid: card.mid, uname: card.name, act });
      saveLedger(ledger);
      appendLog('actions.log', `follow act=${act} mid=${card.mid} name=${card.name}`);
      return gateResult(op === 'unfollow' ? '取关' : '关注', verdict, {
        action: op === 'unfollow' ? '取关' : '关注',
        mid: card.mid,
        name: card.name,
        owner,
        following: act === 1,
        reasons: [],
        hint: act === 1 ? '关注成功，以后他的评论会优先回。' : '已取关。',
      });
    },
    timeoutMs: 40000,
  };

  const favoriteTool = {
    name: 'bili_favorite',
    description:
      '收藏视频（刷到觉得好看的视频就收进收藏夹）。op=add 收藏（给 id = bvid 或 aid；folderId 不给就进默认收藏夹）；op=remove 取消收藏；op=favorites 看她自己的收藏夹列表；op=folders 同 favorites；op=create 新建收藏夹（给 title）；op=list 看某个收藏夹里有什么；op=check 只判断能不能收（不写）。',
    parameters: compileParameters({
      op: { type: 'string', description: 'add | remove | folders | create | list | check（默认 check）' },
      id: { type: 'string', description: '视频 bvid（BV…）或 aid。' },
      folderId: { type: 'string', description: '收藏夹 id；不给则用默认收藏夹。' },
      title: { type: 'string', description: 'op=create 时的收藏夹名字。' },
      mediaId: { type: 'string', description: 'op=list 时的收藏夹 id。' },
      confirm: { type: 'boolean', description: 'true = 主人点头（postFavorite=confirm 时才需要）。' },
    }),
    output: { schema: looseSchema, render: (args, value) => {
      const rec = asRecord(value);
      if (rec.allowed === false && rec.needsConfirm !== true) return renderGate(rec);
      return textRenderer((item) => {
        const op = String(item.op ?? 'check');
        if (op === 'folders') {
          const folders = Array.isArray(item.folders) ? item.folders : [];
          const lines = [`收藏夹 ${folders.length} 个：`];
          for (const folder of folders) lines.push(`- ${folder.title}（id=${folder.id}，${folder.mediaCount} 个视频）${folder.isDefault === true ? '｜默认' : ''}`);
          if (folders.length === 0) lines.push('- 还没有收藏夹，用 op=create title="..." 建一个。');
          return lines;
        }
        if (op === 'list') {
          const videos = Array.isArray(item.videos) ? item.videos : [];
          const lines = [`收藏夹 ${item.mediaId} 里 ${item.count ?? videos.length} 个视频：`];
          for (const video of videos.slice(0, 20)) lines.push(`- ${video.title}（${video.upName}）${video.url}`);
          if (videos.length === 0) lines.push('- （空的）');
          return lines;
        }
        if (op === 'create') return [`收藏夹建好了：${item.title}（id=${item.id}）`];
        const lines = [`${op === 'remove' ? '取消收藏' : op === 'add' ? '收藏' : '看看能不能收'}：${item.title ?? ''}${item.bvid ? `（${item.bvid}）` : ''}`];
        if (item.aid) lines.push(`- aid：${item.aid}`);
        if (item.folderTitle) lines.push(`- 收藏夹：${item.folderTitle}（id=${item.folderId}）`);
        if (item.already === true) lines.push('- 账本里记着收过了，跳过。');
        if (item.hint) lines.push(`- ${item.hint}`);
        return lines;
      })(args, value);
    } },
    async execute(rawArgs) {
      const args = asRecord(rawArgs);
      const op = (optionalString(args, 'op') ?? 'check').toLowerCase();
      const { cfg, ledger, client } = runtime();
      const confirm = args.confirm === true;

      if (op === 'folders' || op === 'favorites') {
        const folders = await client.favFolders();
        return { op: 'folders', folders, reasons: [], hint: '' };
      }
      if (op === 'create') {
        const title = optionalString(args, 'title');
        if (title === undefined) throw new Error('建收藏夹要给 title。');
        const created = await client.favFolderCreate(title);
        appendLog('actions.log', `fav folder create id=${created.id} title=${title}`);
        return { op: 'create', id: created.id, title: created.title, reasons: [], hint: '' };
      }
      if (op === 'list') {
        const mediaId = optionalString(args, 'mediaId') ?? optionalString(args, 'folderId');
        if (mediaId === undefined) throw new Error('op=list 要给 mediaId（收藏夹 id）。');
        const result = await client.favList({ mediaId });
        return { op: 'list', ...result, reasons: [], hint: '' };
      }

      // add / remove / check 都需要先拿到视频信息与默认收藏夹。
      const id = optionalString(args, 'id');
      if (id === undefined) throw new Error('要给 id（bvid 或 aid）。');
      const video = await client.video(id);
      const folders = await client.favFolders().catch(() => []);
      const wanted = optionalString(args, 'folderId');
      const folder = wanted !== undefined
        ? folders.find((item) => String(item.id) === String(wanted)) ?? { id: Number(wanted), title: `收藏夹 ${wanted}` }
        : folders[0] ?? null;
      if (folder === null) {
        return gateResult(op === 'add' ? '收藏' : '看能不能收', { allowed: false, needsConfirm: false, mode: 'auto', reasons: ['她还没有收藏夹，先用 op=create title="..." 建一个'] }, { op, aid: video.aid, bvid: video.bvid, title: video.title, reasons: ['她还没有收藏夹'], hint: '' });
      }

      const verdict = checkFavorite({ cfg, ledger, aid: video.aid, title: video.title, confirm });
      const payload = {
        op,
        aid: video.aid,
        bvid: video.bvid,
        title: video.title,
        upName: video.author,
        folderId: folder.id,
        folderTitle: folder.title,
        reasons: verdict.reasons,
        hint: verdict.hint,
      };
      if (op === 'check') return gateResult('看能不能收', verdict, payload);
      const already = favoritedAlready(ledger, video.aid);
      if (verdict.allowed !== true) return gateResult('收藏', verdict, payload);
      if (already === true && op === 'add') return gateResult('收藏', verdict, { ...payload, already: true, reasons: [] });

      await client.favDeal(op === 'remove'
        ? { aid: video.aid, delIds: [folder.id] }
        : { aid: video.aid, addIds: [folder.id] });
      if (op === 'add') {
        recordFavorite(ledger, { aid: video.aid, bvid: video.bvid, title: video.title, upName: video.author, folderId: folder.id });
        saveLedger(ledger);
      }
      appendLog('actions.log', `favorite ${op} aid=${video.aid} bvid=${video.bvid} folder=${folder.id}`);
      return gateResult(op === 'remove' ? '取消收藏' : '收藏', verdict, {
        ...payload,
        reasons: [],
        hint: op === 'remove' ? '已经移出收藏夹啦。' : `收进「${folder.title}」了，主人想看的时候翻得到～`,
      });
    },
    timeoutMs: 40000,
  };

  const tripleTool = {
    name: 'bili_triple',
    description:
      '看完/刷到一个视频后的「随手」，一步做完三件事：①把它记进 B 站浏览记录（历史记录里能看到她刷过）；②分数够「好内容」（policy.tripleMinScore）就三连——点赞 + 投币 + 收藏；③收藏时按方向归进不同收藏夹（feed.folderByTopic，没配就进 feed.favoriteFolder）。默认 confirm 模式只回报判断不真连，主人点头（confirm=true）才连；history=false 可以不报浏览记录。',
    parameters: compileParameters({
      id: { type: 'string', description: '视频 bvid（BV…）或 aid。' },
      topic: { type: 'string', description: '学习方向（决定进哪个收藏夹）。' },
      score: { type: 'number', description: '这个视频的分数（够 tripleMinScore 才三连）。' },
      history: { type: 'boolean', description: 'false = 不报浏览记录（默认报）。' },
      confirm: { type: 'boolean', description: 'true = 主人点头，真连（postTriple=confirm 时才需要）。' },
    }),
    output: { schema: looseSchema, render: textRenderer((value) => {
      const lines = [];
      const history = asRecord(value.history);
      lines.push(`浏览记录：${history.reported === true ? `已报（看到第 ${history.progress ?? 0} 秒）` : `没报（${history.reason ?? '未知原因'}）`}`);
      const triple = asRecord(value.triple);
      if (triple.done === true) {
        lines.push(`三连：${triple.like === true ? '点赞✓' : '点赞✗'}｜投币 ${triple.coin ?? 0} 枚｜收藏进「${triple.folder?.title ?? ''}」${triple.folder?.created === true ? '（新夹子）' : ''}`);
        if ((triple.errors ?? []).length > 0) lines.push(`- 有几步没成：${(triple.errors ?? []).join('；')}`);
      } else if (triple.needsConfirm === true) {
        lines.push(`三连：等主人点头（模式 ${triple.mode ?? 'confirm'}，confirm=true 才连）`);
      } else {
        lines.push(`三连：没连（${(triple.reasons ?? []).join('；')}）`);
      }
      return lines;
    }) },
    async execute(rawArgs) {
      const args = asRecord(rawArgs);
      const id = optionalString(args, 'id');
      if (id === undefined) throw new Error('要给 id（bvid 或 aid）。');
      const { cfg, ledger, client } = runtime();
      const video = await client.video(id);
      const topic = optionalString(args, 'topic') ?? '';
      const score = optionalNumber(args, 'score', 0);
      const history = optionalBool(args, 'history', true);
      const confirm = args.confirm === true;

      const watched = history === true
        ? await reportHistory({ client, cfg, video, progress: 0 })
        : { reported: false, reason: 'history=false，这次不报' };
      const verdict = checkTriple({ cfg, ledger, video, score, confirm });
      const tripled = verdict.allowed === true
        ? await tripleVideo({ client, cfg, ledger, video, topic, score, confirm })
        : { done: false, needsConfirm: verdict.needsConfirm === true, reasons: verdict.reasons ?? [], like: false, coin: 0, folder: null, errors: [] };
      if (tripled.done === true) saveLedger(ledger);
      appendLog(
        'actions.log',
        `triple bvid=${video.bvid} aid=${video.aid} history=${watched.reported === true ? 1 : 0} triple=${tripled.done === true ? 1 : 0} folder=${tripled.folder?.id ?? 0} coin=${tripled.coin ?? 0}`,
      );
      return {
        action: '三连并分类收藏',
        allowed: tripled.done === true,
        needsConfirm: tripled.needsConfirm === true,
        mode: verdict.mode,
        reasons: tripled.done === true ? [] : (verdict.reasons ?? []),
        hint: tripled.done === true ? `收进「${tripled.folder?.title ?? ''}」了，主人想看的时候翻得到～` : verdict.hint ?? '',
        bvid: video.bvid,
        aid: video.aid,
        title: video.title,
        upName: video.author,
        score,
        history: watched,
        triple: tripled,
      };
    },
    timeoutMs: 60000,
  };

  const studyTool = {
    name: 'bili_study',
    description:
      '她的自主学习：不用主人指定，她自己决定今天学什么。op=plan 只挑今天要学的视频（不写笔记、不留言）；op=learn 立刻学一轮（挑视频 → 看内容与热评 → 写学习笔记进账本与知识库 → 觉得有意义就去评论区留言并 @ 两位主人）；op=today 看今天学到了什么；op=topic 看今天轮到哪个方向；op=kb 把笔记重写成知识库（notes/knowledge-base.md）；op=ask 在知识库里查（用 text 给关键词，答「人家学过什么」）；op=dynamic 预览/发送「学习动态」（给 confirm=true 才真发）。',
    parameters: compileParameters({
      op: { type: 'string', description: 'plan | learn | today | topic | kb | ask | dynamic（默认 plan）' },
      topic: { type: 'string', description: '指定方向（不给就按 topics 轮换）。' },
      count: { type: 'number', description: 'op=plan/learn 时这一轮学几个，默认用配置 learning.perRun。' },
      text: { type: 'string', description: 'op=dynamic 时直接指定动态正文；op=ask 时是查询的关键词。' },
      confirm: { type: 'boolean', description: 'op=dynamic 时 true = 真发出去。' },
    }),
    output: { schema: looseSchema, render: textRenderer((value) => {
      const op = String(value.op ?? 'plan');
      const lines = [`自主学习（${op}）`];
      if (op === 'topic') {
        lines.push(`今天的方向：${value.topic}`);
        lines.push(`今天已学：${value.studied ?? 0} 个视频`);
        return lines;
      }
      if (op === 'today') {
        lines.push(studySummary({ study: value.notes ?? [], daily: {} }, new Date(value.now ?? Date.now())));
        for (const note of value.notes ?? []) {
          lines.push(`- 《${String(note.title ?? '').slice(0, 40)}》（${note.upName ?? ''}）｜方向 ${note.topic ?? '?'}｜分 ${note.score ?? 0}${note.meaningful === true ? '｜有意义' : ''}`);
          lines.push(`    笔记：${String(note.note ?? '（没写）').slice(0, 160)}`);
        }
        if ((value.notes ?? []).length === 0) lines.push('- 今天还没学，跑一次 op=learn 吧。');
        return lines;
      }
      if (op === 'dynamic') {
        lines.push(`草稿：${String(value.text ?? '').slice(0, 200)}`);
        if (value.dynId) lines.push(`已发出：dynId=${value.dynId}`);
        if (value.allowed === false) lines.push(`没发：${(value.reasons ?? []).join('；')}`);
        return lines;
      }
      if (op === 'kb') {
        lines.push(`知识库已重写：${value.count ?? 0} 条笔记，${Math.round((value.bytes ?? 0) / 1024)} KB`);
        lines.push(`文件：${value.file ?? ''}`);
        lines.push(`索引：${value.index ?? ''}`);
        return lines;
      }
      if (op === 'ask') {
        lines.push(`在知识库里查「${String(value.question ?? '').slice(0, 40)}」：命中 ${(value.hits ?? []).length} 条`);
        for (const hit of value.hits ?? []) {
          lines.push(`- 《${String(hit.title ?? '').slice(0, 40)}》（${hit.topic ?? '?'}）`);
          lines.push(`    ${String(hit.note ?? '').slice(0, 160)}`);
        }
        if ((value.hits ?? []).length === 0) lines.push('- 没有相关笔记（换个关键词，或先 op=learn 学一轮）。');
        return lines;
      }
      if (value.topic) lines.push(`方向：${value.topic}`);
      if (value.note) lines.push(value.note);
      for (const pick of value.picks ?? []) {
        lines.push(`- 《${String(pick.title ?? '').slice(0, 44)}》（${pick.upName ?? ''}）｜分 ${pick.score}｜${pick.url ?? ''}`);
      }
      for (const item of value.notes ?? []) lines.push(`- 笔记《${String(item.title ?? '').slice(0, 32)}》：${String(item.note ?? '').slice(0, 120)}`);
      if ((value.commented ?? []).length > 0) lines.push(`已去 ${value.commented.length} 个视频下留言（@ 了两位主人）`);
      return lines;
    }) },
    async execute(rawArgs) {
      const args = asRecord(rawArgs);
      const op = (optionalString(args, 'op') ?? 'plan').toLowerCase();
      const { cfg, ledger, client } = runtime();
      const conf = studyConfig(cfg);
      const topic = optionalString(args, 'topic');

      if (op === 'topic') {
        return { op, topic: pickTopic(cfg, ledger), studied: todayStudy(ledger).length, reasons: [], hint: '' };
      }
      if (op === 'today') {
        const notes = todayStudy(ledger);
        return { op, notes, now: Date.now(), reasons: [], hint: notes.length === 0 ? '今天还没学，跑一次 op=learn。' : '' };
      }
      if (op === 'kb') {
        // 把账本里的笔记整份重写成知识库（notes/knowledge-base.md + 索引）。
        const written = writeKnowledgeBase(cfg, ledger);
        appendLog('study.log', `kb rebuilt count=${written.count} bytes=${written.bytes} dir=${written.dir}`);
        return { op, ...written, reasons: [], hint: `知识库已更新：${written.file}` };
      }
      if (op === 'ask') {
        const question = optionalString(args, 'text') ?? optionalString(args, 'topic') ?? '';
        const hits = searchKnowledge(cfg, question, { limit: 5 });
        return {
          op,
          question,
          hits: hits.map((hit) => ({ title: hit.title, topic: hit.topic, note: hit.note, bvid: hit.bvid, ts: hit.ts })),
          kb: kbFiles(cfg),
          reasons: [],
          hint: hits.length === 0 ? '知识库里没有和这句相关的笔记（换几个关键词，或者先 op=learn 学一轮）。' : '',
        };
      }
      if (op === 'dynamic') {
        const given = optionalString(args, 'text');
        const text = given ?? (await composeStudyDynamic({ cfg, ledger }));
        const verdict = checkDynamic({ cfg, ledger, text, confirm: args.confirm === true, auto: false });
        if (verdict.allowed !== true) return gateResult('发学习动态', verdict, { op, text, reasons: verdict.reasons, hint: verdict.hint });
        const created = await client.dynamicCreate(text, { mentions: ownerMentionList(cfg) });
        recordDynamic(ledger, { text, dynId: created?.dyn_id_str ?? null });
        saveLedger(ledger);
        appendLog('actions.log', `study dynamic text=${text}`);
        return gateResult('发学习动态', verdict, { op, text, dynId: created?.dyn_id_str ?? null, reasons: [] });
      }

      // plan / learn
      const wanted = optionalNumber(args, 'count', conf.perRun);
      const scoped = { ...cfg, learning: { ...(cfg.learning ?? {}), perRun: Math.min(Math.max(wanted, 1), 5) } };
      if (op === 'plan') {
        const { pickStudyVideos } = await import('./study.js');
        const picked = await pickStudyVideos({ client, ledger, cfg: scoped, topic });
        return {
          op,
          topic: picked.topic,
          picks: picked.picks.map((item) => ({
            bvid: item.video.bvid,
            title: item.video.title,
            upName: item.video.author,
            score: item.score,
            url: item.video.url,
          })),
          reasons: [],
          hint: picked.picks.length === 0 ? '这轮没挑到合适的（方向太窄或都学过了），换个 topic 试试。' : '',
        };
      }
      const report = await learnOnce({
        run: async (name, callArgs) => {
          const tool = [comment, reply, dynamic, favoriteTool].find((item) => item.name === name) ?? null;
          if (tool === null) throw new Error(`learnOnce 想调 ${name}，但这里没有这个工具。`);
          return await tool.execute(callArgs, {});
        },
        client,
        ledger,
        cfg: scoped,
      });
      // 有意义但策略要求主人点头的，进待确认箱（云端巡检会把它们推给遥控台）。
      for (const draft of report.queued ?? []) queueDraft(draft);
      saveLedger(ledger);
      // 学完就把笔记并进知识库（主人要求：学习后数据存进 notes/ 并合并成一份 markdown）。
      let kb = null;
      try {
        kb = writeKnowledgeBase(scoped, ledger);
      } catch (issue) {
        appendLog('error.log', `知识库写入失败：${String(issue?.message ?? issue)}`);
      }
      appendLog('study.log', `learn topic=${report.topic ?? '?'} studied=${report.studied ?? 0} commented=${(report.commented ?? []).length} queued=${(report.queued ?? []).length} kb=${kb?.count ?? 'n/a'}`);
      return {
        op,
        ...report,
        kb,
        reasons: [],
        hint: report.studied > 0 ? `今天的方向是「${report.topic}」，笔记已进知识库（${kb?.file ?? 'notes/'}）。` : '',
      };
    },
    timeoutMs: 180000,
  };

  const dmTool = {
    name: 'bili_dm',
    description:
      'B 站私信（web_im）。op=list 看会话列表（谁给她发过、有没有未读）；op=read 读某个会话的来往消息；op=reply 回一条（主人直接回，别人默认要 confirm=true）；op=ack 对未读会话自动寒暄一轮；op=send 主动私信（默认只允许主人）；op=draft 只写出来给主人看；op=check 看今天发过几条。',
    parameters: compileParameters({
      op: { type: 'string', description: 'list | read | reply | ack | send | draft | check（默认 draft）' },
      mid: { type: 'string', description: '会话对方 UID（read/reply/send/draft/check 用）。' },
      text: { type: 'string', description: '正文（reply/send/draft 用）。' },
      confirm: { type: 'boolean', description: 'true = 主人点头，直接发。' },
      size: { type: 'number', description: 'list/read 拉取条数，默认 20。' },
    }),
    output: { schema: looseSchema, render: (args, value) => {
      const rec = asRecord(value);
      if (rec.allowed === false && rec.needsConfirm !== true) return renderGate(rec);
      return textRenderer((item) => {
        if (item.op === 'list') {
          const lines = [`私信会话：${item.count} 个（未读 ${item.unreadCount} 个）`];
          for (const row of item.sessions ?? []) {
            const state = row.sysMsg === true ? '（系统消息）' : row.lastFromMe ? '（我刚回过）' : '（等我回）';
            lines.push(`- ${row.owner ? '★' : ' '}${row.uname}（UID ${row.mid}）${row.unread > 0 ? ` 未读 ${row.unread}` : ''} ${state}：${String(row.lastText ?? '').slice(0, 40)}`);
          }
          if (item.hint) lines.push(`- ${item.hint}`);
          return lines;
        }
        if (item.op === 'read' || item.op === 'ack') {
          const lines = [`${item.op === 'ack' ? '自动寒暄' : '读会话'}：${item.name ?? ''}（UID ${item.talkerId ?? item.mid ?? ''}）`];
          for (const msg of (item.messages ?? []).slice(-10)) {
            lines.push(`  ${msg.fromMe ? '→我' : '←他'} ${String(msg.text ?? '').slice(0, 60)}`);
          }
          for (const note of item.notes ?? []) lines.push(`- ${note}`);
          if (item.acked !== undefined) lines.push(`- 寒暄发送：${item.acked} 条`);
          if (item.hint) lines.push(`- ${item.hint}`);
          return lines;
        }
        const lines = [`${item.action ?? '私信'}：${item.name ?? ''}（UID ${item.mid}）`];
        if (item.draft) lines.push(`- 正文：${item.draft}`);
        if (item.sentCount !== undefined) lines.push(`- 今天已发：${item.sentCount} 条`);
        if (item.hint) lines.push(`- ${item.hint}`);
        return lines;
      })(args, value);
    } },
    async execute(rawArgs) {
      const args = asRecord(rawArgs);
      const op = (optionalString(args, 'op') ?? 'draft').toLowerCase();
      const midArg = optionalString(args, 'mid') ?? '';
      const text = cleanText(optionalString(args, 'text') ?? '');
      const confirm = optionalBool(args, 'confirm', false);
      const size = Math.max(1, Math.min(50, Number(optionalString(args, 'size') ?? args.size ?? 20) || 20));
      const { cfg, ledger, client } = runtime();

      const inboundNote = (row) => {
        if (row.lastFromMe !== true && row.lastTs > 0) {
          recordDmIncoming(ledger, { mid: row.mid, uname: row.uname, text: row.lastText, ts: row.lastTs });
          saveLedger(ledger);
        }
      };

      if (op === 'list') {
        const sessions = await client.dmSessions({ size });
        const rows = [];
        for (const row of sessions) {
          let name = row.account ?? '';
          // 号码大小不能用来判断「系统号」（主人 UID 也是 16 位），直接问名片、失败就算了。
          if (name === '') {
            try {
              const card = await client.card(row.talkerId);
              name = card?.name ?? '';
            } catch {
              name = '';
            }
          }
          rows.push({
            ...row,
            mid: row.talkerId,
            uname: name === '' ? `UID ${row.talkerId}` : name,
            owner: isOwner(cfg, { mid: row.talkerId, uname: name }),
            // 类型 1 才是人打的字；别的（10 = 系统卡）不用回，列表里也标出来。
            sysMsg: Number(row.lastMsgType) !== 1,
          });
        }
        for (const row of rows) inboundNote(row);
        const unread = rows.filter((row) => Number(row.unread) > 0);
        return {
          op, count: rows.length, unreadCount: unread.length,
          sessions: rows,
          hint: unread.length === 0 ? '暂时没有未读私信～' : `有 ${unread.length} 个会话等她回：op=read 看内容，op=reply 回一条，op=ack 自动寒暄。`,
        };
      }

      if (op === 'ack') {
        const sessions = await client.dmSessions({ size });
        const notes = [];
        let acked = 0;
        for (const row of sessions) {
          // 「要不要回」看的是「他最后一条比我最后一条新」，不是未读数：
          // 未读数会被任何一次读取清掉，只看它就会漏掉主人刚说的话。
          if (row.lastFromMe === true) continue;
          if (row.lastTs > 0 && lastDmOutgoingTs(ledger, row.talkerId) >= row.lastTs) {
            notes.push(`「${row.uname ?? row.account ?? row.talkerId}」最后一条人家已经回过了`);
            continue;
          }
          // 系统自动开场白（「我们已互相关注，开始聊天吧~」之类）不值得回。
          if (Number(row.lastMsgType) !== 1 || /我们已互相关注|开始聊天吧/.test(String(row.lastText ?? ''))) {
            notes.push(`「${row.uname ?? row.account ?? row.talkerId}」最后一条是系统消息，跳过`);
            continue;
          }
          // 会话列表里 account 经常是空的，日志就会写成「name=null」——回之前先把名片问出来。
          let name = row.account ?? '';
          if (name === '') {
            try {
              const card = await client.card(row.talkerId);
              name = card?.name ?? '';
            } catch {
              name = '';
            }
          }
          const who = name === '' ? `UID ${row.talkerId}` : name;
          const owner = isOwner(cfg, { mid: row.talkerId, uname: name });
          recordDmIncoming(ledger, { mid: row.talkerId, uname: name, text: row.lastText, ts: row.lastTs });
          if (cfg.dmAck?.enabled === false || cfg.policy.autoAckDm === false) { notes.push(`「${who}」自动寒暄已关闭`); continue; }
          // 先从账本/模板拿一句兜底：脑子写不出来时就用它（陌生人默认那句礼貌收尾语）。
          let pick = owner === true
            ? pickDmAck(cfg, ledger, row.lastText)
            : String(cfg.dmAck?.strangerReply ?? '你好呀～人家是小鲸鱼娘，只跟主人说话哦。有事找主人就好啦 (。-ω´-)✧');
          // 主人和陌生人都让「脑子」（免费的云端模型）写一条真回复；失败就回退上面那句。
          // 陌生人 2026-10-05 起也走脑子（主人：「之后回复陌生人人改成用免费模型回复吧，我说少了」），
          // 但**不喂任何内部上下文**：能力清单、账本、知识库、@记录都是主人侧信息，不能漏给外人。
          if (cfg.brain?.enabled !== false) {
            try {
              const history = await client.dmMessages({ talkerId: row.talkerId, size: 10 });
              const extra = owner === true
                // 让脑子知道她能干什么、最近做了什么，带上知识库里相关的学习笔记
                //（主人 2026-10-05：笔记要能当知识库用），以及主人最近 @ 了她什么
                //（主人：「你看一下我给你的@」——以前连 @ 都读不到，只能答「没法翻@记录」）。
                ? `${capabilityNote(cfg)}${recentDoings(ledger)}${kbContext(cfg, String(row.lastText ?? ''))}${await mentionsNote(client, cfg)}`
                : '';
              const drafted = await draftDmReply({
                cfg,
                messages: history?.messages ?? [],
                talkerName: owner === true ? (name === '' ? '主人' : name) : who,
                audience: owner === true ? 'owner' : 'stranger',
                extra,
              });
              if (drafted !== null) pick = drafted;
            } catch (error) {
              appendLog('auto.log', `brain 生成私信失败，回退模板：${error.message}`);
            }
          }
          const verdict = checkDmReply({ cfg, ledger, mid: row.talkerId, uname: name, text: pick, confirm: owner === true });
          if (verdict.needsConfirm === true) {
            notes.push(`「${who}」不是主人，回不回等主人点头（op=read ${row.talkerId} 看内容后 op=reply --confirm）`);
            continue;
          }
          if (verdict.allowed !== true) { notes.push(`「${who}」寒暄没发出去：${verdict.reasons.join('；')}`); continue; }
          const sent = await client.sendMsg({ receiverId: row.talkerId, content: pick });
          recordDm(ledger, { mid: row.talkerId, uname: name, text: pick, msgKey: sent?.msgKey === undefined ? null : String(sent.msgKey), isOwner: owner, auto: owner !== true });
          appendLog('actions.log', `dm-ack mid=${row.talkerId} name=${who}${owner === true ? ' owner' : ''}`);
          acked += 1;
        }
        saveLedger(ledger);
        return { op, talkerId: null, name: '全部未读会话', messages: [], acked, notes, hint: acked > 0 ? '寒暄发出去了，接下来可以用 op=read 看内容再好好回。' : '没有需要寒暄的未读会话。' };
      }

      if (op === 'read') {
        const mid = requiredString(args, 'mid', '会话对方 UID');
        const card = await client.card(mid);
        const thread = await client.dmMessages({ talkerId: mid, size });
        const incoming = thread.messages.filter((msg) => msg.fromMe !== true);
        if (incoming.length > 0) {
          const last = incoming[incoming.length - 1];
          recordDmIncoming(ledger, { mid: card.mid, uname: card.name, text: last.text, ts: last.ts, msgKey: last.msgKey });
          saveLedger(ledger);
        }
        const owner = isOwner(cfg, { mid: card.mid, uname: card.name });
        return {
          op, talkerId: card.mid, mid: card.mid, name: card.name, owner,
          messages: thread.messages,
          notes: [`共 ${thread.messages.length} 条（对方 ${incoming.length} 条）`],
          hint: incoming.length === 0 ? 'TA 还没给她发过消息，不能主动搭话。' : `想回就用 op=reply${owner ? '' : ' confirm=true'}。`,
        };
      }

      const mid = requiredString(args, 'mid', '对方 UID');
      const card = await client.card(mid);
      const owner = isOwner(cfg, { mid: card.mid, uname: card.name });

      if (op === 'check') {
        return { action: '看私信额度', mid: card.mid, name: card.name, owner, sentCount: dmCountForUser(ledger, card.mid), reasons: [], hint: '' };
      }

      if (op === 'reply') {
        const verdict = checkDmReply({ cfg, ledger, mid: card.mid, uname: card.name, text, confirm: confirm === true });
        if (verdict.allowed !== true) {
          return gateResult('回私信', verdict, {
            action: verdict.needsConfirm ? '回私信草稿' : '回私信',
            mid: card.mid, name: card.name, owner, draft: text,
            reasons: verdict.reasons,
            hint: verdict.reasons.length === 0 ? `要真回就带 confirm=true（或主人说一声）。` : verdict.hint,
          });
        }
        const sent = await client.sendMsg({ receiverId: card.mid, content: text });
        recordDm(ledger, { mid: card.mid, uname: card.name, text, msgKey: sent?.msgKey === undefined ? null : String(sent.msgKey), isOwner: owner });
        saveLedger(ledger);
        appendLog('actions.log', `dm-reply mid=${card.mid} name=${card.name} text=${text.slice(0, 40)}`);
        return gateResult('回私信', verdict, {
          action: '回私信', mid: card.mid, name: card.name, owner, draft: text,
          msgKey: sent?.msgKey === undefined ? null : String(sent.msgKey), reasons: [], hint: '回过去了～',
        });
      }

      const verdict = checkDm({ cfg, ledger, mid: card.mid, uname: card.name, text });
      const needsConfirm = op === 'draft' || confirm !== true;
      if (verdict.allowed !== true || needsConfirm) {
        return gateResult('发私信', verdict, {
          action: op === 'draft' ? '私信草稿' : '发私信',
          mid: card.mid,
          name: card.name,
          owner,
          draft: text,
          reasons: verdict.reasons,
          hint: verdict.reasons.length === 0 ? '想说就说吧 —— 要真发就带 confirm=true 再来一次。' : verdict.hint,
        });
      }
      const sent = await client.sendMsg({ receiverId: card.mid, content: text });
      recordDm(ledger, { mid: card.mid, uname: card.name, text, msgKey: sent?.msgKey === undefined ? null : String(sent.msgKey), isOwner: owner });
      saveLedger(ledger);
      appendLog('actions.log', `dm mid=${card.mid} name=${card.name} text=${text.slice(0, 40)}`);
      return gateResult('发私信', verdict, {
        action: '发私信',
        mid: card.mid,
        name: card.name,
        owner,
        draft: text,
        msgKey: sent?.msgKey === undefined ? null : String(sent.msgKey),
        reasons: [],
        hint: '送达了～',
      });
    },
    timeoutMs: 60000,
  };

  return [login, status, config, feed, video, comments, comment, reply, inbox, dynamic, ledgerTool, followTool, dmTool, favoriteTool, tripleTool, studyTool];
}

export { BiliError, isOwner };
