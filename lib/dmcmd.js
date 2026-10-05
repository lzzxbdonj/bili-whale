/**
 * 私信里的「真命令」：主人发 `/搜`、`/转达`，由**本机那双手**真去执行。
 *
 * 为什么需要它（2026-10-05 真机事故，主人原话：「我想让她给我转达消息一直做不到」）：
 * 私信自动回复这条路只会**说话** —— `bili_dm op=ack` 拿 `draftDmReply()` 问一次模型、
 * 把返回的**一段文字**直接 `sendMsg` 出去，中间没有任何执行环节。主人在私信里说
 * 「帮我提炼一下 b 站有关拉康精神分析的视频」，她只能回一句「人家这就去搜」——
 * 从 00:22 到 10:14 连着回了 8 次「马上就好」，一件事没办。
 *
 * 结论：**要办事的命令必须走代码，不能走模型。** 走模型只会得到承诺。
 * 这个模块只做四件事，每件都真落地：
 *   - `/搜 <关键词>`   → 真去 B 站搜，回前三条（标题/UP/播放/时长/BV 号）
 *   - `/转达 [昵称] <正文>` → 真把正文私信给另一位主人（过 `checkDm` 同一道闸门）
 *   - `/动态 [正文]`    → 真发一条动态（不点明正文就用「今天学到什么」写）
 *   - `/帮助`          → 命令表
 * 认不出来的 `/xxx` 一律回命令表，**绝不丢给脑子**（丢给脑子就又变成承诺了）。
 *
 * @module dsh-bilibili-whale/dmcmd
 */
import { appendLog } from './config.js';
import { checkDm, checkDynamic, ownerMentionList } from './policy.js';
import { recordDm, recordDynamic, saveLedger, seenVideoSet, selfWatchedToday, takeMaterial } from './ledger.js';
import { reportHistory, tripleVideo } from './triple.js';
import { clipText } from './text.js';
import { intentHelp, parseIntent } from './intent.js';
import { composeStudyDynamic, pickTopic, studyConfig } from './study.js';

/** 命令别名表（斜杠后面那截小写化之后查这里）。 */
const ALIASES = {
  搜: 'search',
  search: 'search',
  s: 'search',
  找: 'search',
  转达: 'relay',
  relay: 'relay',
  转: 'relay',
  刷: 'watch',
  watch: 'watch',
  browse: 'watch',
  看: 'watch',
  动态: 'dynamic',
  dynamic: 'dynamic',
  po: 'dynamic',
  帮助: 'help',
  help: 'help',
  '?': 'help',
};

/**
 * 认一条私信是不是命令。
 *
 * @param {unknown} text - 私信正文。
 * @returns {{name: string, args: string, raw: string}|null} 不是命令返回 null。
 */
export function parseDmCommand(text) {
  const raw = String(text ?? '').trim();
  if (raw.startsWith('/') !== true) return null;
  const body = raw.slice(1).trim();
  if (body === '') return { name: 'help', args: '', raw: '' };
  const at = body.search(/\s/u);
  const head = (at < 0 ? body : body.slice(0, at)).toLowerCase();
  const args = at < 0 ? '' : body.slice(at + 1).trim();
  return { name: ALIASES[head] ?? 'unknown', args, raw: head };
}

/**
 * 命令表（也当「不认识这个命令 / 认不出想让她干什么」的兜底回复）。
 *
 * 主人 2026-10-05：「不要命令形式」——所以她教的是**人话**怎么写（`intentHelp()`），
 * 斜杠写法仍然能用，只是不再列出来当门面。
 */
export function dmCommandHelp(cfg = {}) {
  return intentHelp(cfg);
}

/**
 * 把「转达」的口头说法从正文前面摘掉。
 *
 * 主人用大白话说话时是「帮我跟金易木木元说声谢谢」这样一整句，动词和「帮我」都不该出现在
 * 真正转发出去的那句话里 —— 转达是**原样带话**，多一个字都算篡改。
 * 只摘开头那一小截；摘完空了就原样返回（宁可带个动词，也不能把话弄没）。
 *
 * @param {string} text - 命令参数或自然语言里抠出来的那一串。
 * @returns {string} 只留下要说的话。
 */
function stripRelayVerb(text) {
  const raw = String(text ?? '').trim();
  const hit = raw.match(/^(?:帮我|替我|给人家|麻烦你?|请你?|你?去|快|赶紧|立刻|马上|现在|来|先)?\s*(?:转达|转告|转给|告诉|捎句话|带个话|传个话|跟人家说|跟他说|说一下)\s*(?:一下|一声|一句)?\s*[:：]?\s*/u);
  if (hit === null) return raw;
  const rest = raw.slice(hit[0].length).replace(/^[，。！？、；:：\s]+/u, '').trim();
  return rest === '' ? raw : rest;
}

/** 播放量这种大数字压成「12.4万」。 */function fmtCount(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return '';
  if (num >= 100_000_000) return `${(num / 100_000_000).toFixed(1)}亿`;
  if (num >= 10_000) return `${(num / 10_000).toFixed(1)}万`;
  return String(num);
}

/**
 * 真执行一条命令 / 一个自然语言意图。
 *
 * @param options.cfg - 已解析配置。
 * @param options.ledger - 账本（`/转达` 要过闸门+记账）。
 * @param options.client - BiliClient。
 * @param options.mid - 发命令的主人 UID。
 * @param options.uname - 发命令的主人昵称。
 * @param options.command - `parseDmCommand()` 的结果（斜杠命令，老写法）。
 * @param options.intent - `parseIntent()` 的结果（主人**用大白话**下的指令，第六轮新增）。
 * @param options.force - 「最高权限」（调试档）主人说的：跳过每日上限 / 间隔 / 去重（第九轮新增）。
 *   屏蔽词、字数上限、`postXxx = off`、未登录这些**照样拦** —— 那是账号安全线。
 * @returns {Promise<{ok: boolean, text: string}>} `text` 是要发回去的回执正文。
 */
export async function runDmCommand({ cfg, ledger, client, mid, uname, command, intent = null, force = false } = {}) {
  if (intent !== null && intent !== undefined) return await runIntent({ cfg, ledger, client, mid, uname, intent, force });
  if (command === null || command === undefined) return { ok: false, text: '' };
  if (command.name === 'help') return { ok: true, text: dmCommandHelp(cfg) };
  if (command.name === 'unknown') {
    return { ok: false, text: `人家没听懂这个呢。\n${dmCommandHelp(cfg)}` };
  }
  if (command.name === 'search') return await runSearch({ cfg, client, args: command.args });
  if (command.name === 'watch') return await runWatch({ cfg, ledger, client, args: command.args, force });
  if (command.name === 'dynamic') return await runDynamic({ cfg, ledger, client, text: command.args, force });
  if (command.name === 'relay') return await runRelay({ cfg, ledger, client, mid, args: command.args, force });
  return { ok: false, text: dmCommandHelp(cfg) };
}

/**
 * 执行一个**自然语言**意图（主人用大白话说的，不要求她记斜杠命令）。
 *
 * 认出来的事只有三件，每件都真落地；认出来的话里如果缺了宾语（比如只说「刷刷视频」），
 * 就按「让她自己挑」办 —— 主人 2026-10-05：「自然语言识别，让她自己刷」。
 */
async function runIntent({ cfg, ledger, client, mid, uname, intent, force = false }) {
  if (intent.name === 'search') {
    const keyword = String(intent.keyword ?? intent.target ?? '').trim();
    if (keyword === '') return { ok: false, text: `人家没听清要搜什么呀主人～这样说就行：「搜一下拉康精神分析」` };
    return await runSearch({ cfg, client, args: keyword });
  }
  if (intent.name === 'watch') {
    // 设 `target` 就是要看的那条（BV 号或关键词）；设了 `self`（或两样都没给）就自己挑。
    // 一条私信里写了多个 BV 号时，`intent.targets` 是全部（主人 2026-10-05：「主人让它看的要看」）。
    const target = String(intent.target ?? '').trim();
    const ids = Array.isArray(intent.targets) ? intent.targets.filter((id) => String(id ?? '').trim() !== '') : [];
    // 没写数字时刷几条：以前写死 1，主人 2026-10-05 连着两次抱怨「还在只刷一个视频啊」。
    // 现在按 `learning.watchPerRound`（默认 3）；主人写了「刷 5 个」就听主人的。
    const asked = Number(intent.count ?? 0);
    const count = Number.isFinite(asked) && asked > 0 ? asked : studyConfig(cfg).watchPerRound;
    if (target === '' || intent.self === true) {
      return await runWatchSelf({ cfg, ledger, client, count, force });
    }
    const isId = /^(BV[0-9A-Za-z]{10}|av\d+)$/u.test(target);
    return await runWatch({
      cfg, ledger, client, force, ids: ids.length > 0 ? ids : null, isId,
      args: `${target} ${count}`,
    });
  }
  if (intent.name === 'relay') {
    const body = String(intent.target ?? '').trim();
    if (body === '') return { ok: false, text: '要人家转达什么呀主人？这样说就行：「帮我跟金易木木元说声谢谢」' };
    return await runRelay({ cfg, ledger, client, mid, args: body, force });
  }
  // 「那你现在去发学习动态吧」——主人 2026-10-05 连着说了两次，以前被判成「刷视频」（见 intent.js）。
  if (intent.name === 'dynamic') {
    return await runDynamic({ cfg, ledger, client, text: String(intent.target ?? '').trim(), force });
  }
  return { ok: false, text: dmCommandHelp(cfg) };
}

/**
 * 主人用大白话说的意图 → 老命令对象（`bili_dm` 之外的地方也走同一条路）。
 *
 * 例如「帮我搜一下拉康的视频」→ `{name:'search', args:'拉康精神分析'}`；
 * 「自己去找点视频看看」→ `{name:'watch', args:''}`（空参数 = 她自己挑）。
 *
 * @param {object} intent - `parseIntent()` 的结果。
 * @returns {{name: string, args: string, raw: string}|null}
 */
export function intentToCommand(intent) {
  if (intent === null || intent === undefined) return null;
  if (intent.name === 'search') return { name: 'search', args: String(intent.keyword ?? intent.target ?? '').trim(), raw: '搜' };
  if (intent.name === 'watch') {
    const target = String(intent.target ?? '').trim();
    // 主人没写数字时（`count` 为 0 / 没给）刷几条：以前写死 1，主人 2026-10-05
    // 连着两次抱怨「还在只刷一个视频啊」⇒ 现在按 `learning.watchPerRound`（默认 3）来。
    const count = Number(intent.count ?? 0) > 0 ? Number(intent.count) : 3;
    return { name: 'watch', args: target === '' ? '' : `${target} ${count}`, raw: '刷' };
  }
  if (intent.name === 'relay') return { name: 'relay', args: String(intent.target ?? '').trim(), raw: '转达' };
  if (intent.name === 'dynamic') return { name: 'dynamic', args: String(intent.target ?? '').trim(), raw: '动态' };
  return null;
}

/** 给私信里那句「认不出想让她干什么」的兜底话（她要自己发出去）。 */
export async function runDmIntent({ cfg, ledger, client, mid, uname, text, force = false } = {}) {
  const intent = parseIntent(text);
  if (intent === null) return { ok: false, text: '' };
  return await runDmCommand({ cfg, ledger, client, mid, uname, intent, force });
}

/** `/搜 <关键词>` 或主人一句「搜一下 xxx」：真搜，回前三条。 */
async function runSearch({ cfg, client, args }) {
  const keyword = String(args ?? '').trim();
  if (keyword === '') return { ok: false, text: '想搜什么呀主人？直接说就行，比如「搜一下拉康精神分析」。' };
  let items = [];
  try {
    items = await client.search(keyword, 1);
  } catch (error) {
    return { ok: false, text: `搜「${keyword}」没搜成：${error.message}` };
  }
  const rows = Array.isArray(items) ? items.filter((item) => item?.bvid) : [];
  if (rows.length === 0) return { ok: false, text: `「${keyword}」一条都没搜到呢。` };
  const lines = rows.slice(0, 3).map((item, index) => {
    const bits = [String(item.author ?? '').trim(), fmtCount(item.view), String(item.duration ?? '').trim()]
      .filter((piece) => piece !== '');
    return `${index + 1}. ${String(item.title ?? '').trim()}｜${bits.join('｜')}｜${item.bvid}`;
  });
  const text = [`「${keyword}」共搜到 ${rows.length} 条，前三条：`, ...lines].join('\n');
  return { ok: true, text: clipText(text, Number(cfg?.policy?.maxCommentChars ?? 200)) };
}

/**
 * `/刷 <BV号 | 关键词> [个数]` 或主人一句「刷一下拉康的视频」「看看 BV1xxxx」：
 * 主人**指定刷什么，她就真去刷什么**。
 *
 * 主人 2026-10-05：「给她自己自动刷视频的权限……还有我们让她刷什么视频她就要刷什么」。
 * 「刷」在这里是**真动作**：拉详情 → 报 B 站浏览记录（历史里看得到）→ 记进账本 `watched`
 * → 顺手读一眼前排评论 → 够得上「好内容」的再走一遍三连闸门。
 *
 * 主人特意点的片子按「好内容」算（分数取 `tripleMinScore`，正好过分数门槛），
 * 但每日上限 / 去重 / 标题黑名单这些闸门照走 —— 主人点头也不能让她被风控带走。
 * （唯一例外：`force = true` 的「最高权限」主人免上限/免间隔/免去重，屏蔽词与字数照拦。）
 *
 * `ids` 给了就按 `ids` 挨个拉（一条私信里写了三个 BV 号就刷三个 —— 主人 2026-10-05
 * 「主人让它看的要看」）；没给就按老规矩从 `args` 的头一个词认 BV 号或关键词。
 */
async function runWatch({ cfg, ledger, client, args, isId = null, ids = null, force = false }) {
  const explicit = Array.isArray(ids) === true
    ? ids.map((id) => String(id ?? '').trim()).filter((id) => /^(BV[0-9A-Za-z]{10}|av\d+)$/u.test(id)).slice(0, 10)
    : [];
  const words = String(args ?? '').trim().split(/\s+/u).filter((word) => word !== '');
  if (words.length === 0 && explicit.length === 0) return { ok: false, text: '想让人家看什么呀主人？这样说就行：「看看 BV1xxxxxxxxxx」，或者「刷一下拉康精神分析」。' };
  const first = words[0] ?? explicit[0];
  const looksLikeId = isId === null ? /^(BV[0-9A-Za-z]{10}|av\d+)$/u.test(first) : isId === true;
  const askedCount = Number(words[1]);
  // 主人只说了关键词、没点数字时，也按配置刷几条（主人 2026-10-05：「还在只刷一个视频啊」）。
  const count = Number.isFinite(askedCount) && askedCount > 0
    ? Math.min(askedCount, 5)
    : studyConfig(cfg).watchPerRound;
  const targets = [];
  try {
    if (explicit.length > 0) {
      for (const id of explicit) {
        try {
          targets.push(await client.video(id));
        } catch {
          // 单个拉不到详情就跳过，别把整条命令带崩
        }
      }
    } else if (looksLikeId) {
      targets.push(await client.video(first));
    } else {
      const keyword = words.join(' ');
      const items = await client.search(keyword);
      const rows = (Array.isArray(items) ? items : []).filter((item) => item?.bvid);
      // 「刷过的不要再刷」——主人 2026-10-05：「她现在开始重复刷刷过的视频了」。
      // 关键词刷也不强求重看：搜到的全碰过就老实说，别把同一支片子再看一遍、再评论一遍。
      const seen = seenVideoSet(ledger);
      const fresh = rows.filter((item) => !seen.has(String(item.bvid)));
      if (rows.length > 0 && fresh.length === 0) {
        return { ok: true, text: `「${keyword}」搜到的 ${rows.length} 条人家都刷过了呢～主人换个关键词，或者直接把 BV 号丢给人家？` };
      }
      for (const item of (fresh.length > 0 ? fresh : rows).slice(0, count)) {
        try {
          targets.push(await client.video(item.bvid));
        } catch {
          // 单个拉不到详情就跳过，别把整条命令带崩
        }
      }
    }
  } catch (error) {
    return { ok: false, text: `刷不动：${String(error.message).slice(0, 80)}` };
  }
  if (targets.length === 0) return { ok: false, text: '一条都没拉到呢主人，换个 BV 号或关键词试试？' };
  // ⚠️ `watchThese()` 返回的是 `{lines,tripled,text}`（给 `runWatchSelf` 拼标题用的内部形状），
  // **必须在这里补上 `ok: true`** —— 否则 `runDmCommand()` 的回执成了 `ok: undefined`，
  // 私信那层会当成「没办成」，主人明明刷成功了却收到一句失败话（第六轮测试逮到的真 bug）。
  const outcome = await watchThese({ cfg, ledger, client, targets, force });
  return { ok: true, text: outcome.text };
}

/**
 * 「自己去找点视频看看」：主人没点名，**她自己挑**。
 *
 * 主人 2026-10-05：「刷视频不要命令形式，自然语言识别，让她自己刷。」
 * 她挑片的依据跟自主学习同一条：今天该轮到的学习方向（`pickTopic`）→ 真搜 → 挑评价最好的
 * 一条去「看」（进 B 站浏览记录 + 账本 `watched`，来源标 `self` 以便和主人点的区分开）。
 */
async function runWatchSelf({ cfg, ledger, client, count = 1, force = false }) {
  // 「不要一味的自己刷视频」——主人 2026-10-05：她自己每天顶多刷 `learning.dailyWatch` 个
  // （默认 30，0 = 不限），**主人点名让她刷的不计入也不受限**（那些走 `runWatch`，source = master）。
  let remain = 0;
  if (force !== true) {
    const cap = Number(studyConfig(cfg).dailyWatch ?? 30);
    if (cap > 0) {
      const done = selfWatchedToday(ledger).length;
      if (done >= cap) {
        return { ok: false, text: `人家今天自己已经刷了 ${done} 个啦（自己刷的上限是每天 ${cap} 个）～想看什么主人直接点名，主人点的片子不算在这个上限里。` };
      }
      remain = cap - done;
    }
  }
  let want = Math.min(Math.max(Number(count) || 1, 1), 5);
  if (remain > 0) want = Math.min(want, remain);
  let topic = '';
  try {
    topic = pickTopic(cfg, ledger);
  } catch {
    topic = '';
  }
  if (topic === '') topic = String(studyConfig(cfg).topics[0] ?? '科普');
  let targets = [];
  // 「刷过的不要再刷」：自己刷这条链以前**从不查账本**，而 `client.search(方向)` 的排序是固定的
  // ⇒ 每一轮都挑回同一条播放量最高的，同一支视频被反复「看」、反复评论
  // （主人 2026-10-05 就是为这个发的火：「她现在开始重复刷刷过的视频了」）。
  // 现在翻三页、剔掉碰过的（刷过/学过/评论过/收藏过），再按播放量挑。
  const seen = seenVideoSet(ledger);
  const rows = [];
  let firstError = null;
  for (const page of [1, 2, 3]) {
    let items = [];
    try {
      items = await client.search(topic, page);
    } catch (error) {
      if (page === 1) firstError = error;
      break;
    }
    if (Array.isArray(items) !== true) break;
    for (const item of items) {
      if (item?.bvid && rows.some((row) => row.bvid === item.bvid) !== true) rows.push(item);
    }
    if (rows.length >= 40) break;
  }
  if (rows.length === 0 && firstError !== null) {
    return { ok: false, text: `自己找也没找着（${String(firstError.message).slice(0, 60)}），主人点一条给人家看吧？` };
  }
  const fresh = rows.filter((item) => seen.has(String(item.bvid)) !== true);
  if (fresh.length === 0) {
    return {
      ok: true,
      text: rows.length === 0
        ? `人家按「${topic}」搜了一圈，什么都没搜着。`
        : `人家按「${topic}」翻了三页，${rows.length} 条全刷过了～换个方向吧，或者主人点一条新的给人家看？`,
    };
  }
  // 挑播放量最高的几条：她自己挑也得挑值得看的，别抓个没人看过的小片回来。
  fresh.sort((left, right) => Number(right.view ?? 0) - Number(left.view ?? 0));
  for (const item of fresh.slice(0, want)) {
    try {
      targets.push(await client.video(item.bvid));
    } catch {
      // 单条拉不到就跳过
    }
  }
  if (targets.length === 0) return { ok: false, text: `人家按「${topic}」找了一圈，没挑到合适的片子呢。` };
  const outcome = await watchThese({ cfg, ledger, client, targets, source: 'self', topic, force });
  const head = `人家自己按「${topic}」挑的${outcome.lines.length}条，看了：`;
  return { ok: true, text: clipText([head, ...outcome.lines].join('\n'), Math.max(Number(cfg?.policy?.maxCommentChars ?? 200), 400)) };
}

/**
 * 真去看这几条：报浏览记录 → 读热评 → 走三连闸门 → 攒回执行。
 *
 * `topic` 只影响两件事：账本 `watched` 记下「这条是按哪个方向刷到的」（第六轮补，
 * 之前一直是空串，主人想按方向统计她自己刷了什么就少一列），以及三连时按方向选收藏夹
 * （`feed.folderByTopic` 为空时仍然进默认夹，行为不变）。
 */
async function watchThese({ cfg, ledger, client, targets, source = 'master', topic = '', force = false }) {
  const lines = [];
  let tripled = 0;
  let commented = 0;
  // 连着刷几条时，评论之间歇一下（三连是一条接一条做的，评论挤在一秒里像刷屏）。
  const paceMs = cfg?.policy?.commentOnTriple === false ? 0 : Math.max(0, Number(cfg?.policy?.minIntervalSecondsComment ?? 10) * 1000);
  let previousTripled = false;
  for (const video of targets) {
    if (previousTripled && paceMs > 0) await new Promise((done) => setTimeout(done, paceMs));
    const watched = await reportHistory({ client, cfg, video, ledger, progress: 0, source, topic });
    let hotList = [];
    try {
      const listed = await client.comments(video.bvid, { ps: 3, aid: video.aid });
      hotList = listed?.replies ?? [];
    } catch {
      hotList = [];
    }
    // 三连（连成了会顺手评论 —— 主人 2026-10-05：「三连的视频都要评论」）。
    const verdict = await tripleVideo({ client, cfg, ledger, video, topic, score: Number(cfg?.policy?.tripleMinScore ?? 6), confirm: false, topComments: hotList, force });
    if (verdict.done === true) tripled += 1;
    const said = verdict.comment ?? { posted: false };
    if (said.posted === true) commented += 1;
    previousTripled = verdict.done === true;
    const bits = [String(video.author ?? '').trim(), fmtCount(video.view), String(video.duration ?? '').trim()].filter((piece) => piece !== '');
    const mark = verdict.done === true
      ? `${said.posted === true ? '｜评论✓' : `｜评论✗(${clipText(String(said.reason ?? '没说原因'), 24)})`}`
      : '';
    lines.push(`${video.bvid}｜${clipText(video.title, 34)}｜${bits.join('｜')}｜${watched.reported === true ? '进历史✓' : '没进历史'}${verdict.done === true ? '｜三连✓' : ''}${mark}${hotList.length > 0 ? `｜热评${hotList.length}` : ''}`);
  }
  const text = [`刷了 ${targets.length} 个${tripled > 0 ? `，三连 ${tripled} 个` : ''}${commented > 0 ? `，评论 ${commented} 条` : ''}：`, ...lines].join('\n');
  return { lines, tripled, commented, text: clipText(text, Math.max(Number(cfg?.policy?.maxCommentChars ?? 200), 400)) };
}

/**
 * `/转达 [昵称] <正文>`：真发私信给另一位主人。
 *
 * 昵称省略就发给「另一位主人」（配置里除了自己以外的那位）。开了头的第一个词**只有**
 * 正好是某位主人的昵称（`ownerNames`/`ownerMids`）才当收件人；对不上就整串当正文，
 * 绝不把「张三 你好」猜成要转给金易木木元 —— 转错人比不转更糟。主人多于两位且
 * 没点名时直接问清楚。
 */
async function runRelay({ cfg, ledger, client, mid, args, force = false }) {
  const owners = ownerMentionList(cfg);
  const others = owners.filter((row) => String(row.mid) !== String(mid));
  if (others.length === 0) return { ok: false, text: '配置里只认得一位主人，人家不知道该转给谁呢。' };
  let target = others.length === 1 ? others[0] : null;
  let body = stripRelayVerb(String(args ?? '').trim());
  const at = body.search(/\s/u);
  if (at > 0) {
    const head = body.slice(0, at);
    const hit = others.find((row) => row.name === head);
    if (hit !== undefined) {
      target = hit;
      body = body.slice(at + 1).trim();
    }
  }
  if (target === null) {
    return { ok: false, text: `要转给谁呀主人？这样说就行：「帮我跟${others[0].name}说声谢谢」。` };
  }
  if (body === '') return { ok: false, text: `要人家转达什么呀主人？这样说就行：「帮我跟${target.name}说声谢谢」。` };
  const verdict = checkDm({ cfg, ledger, mid: target.mid, uname: target.name, text: body, force });
  if (verdict.allowed !== true) {
    return { ok: false, text: `没转成：${verdict.reasons.join('；')}` };
  }
  let sent = null;
  try {
    sent = await client.sendMsg({ receiverId: target.mid, content: body });
  } catch (error) {
    return { ok: false, text: `没转成，接口报错：${error.message}` };
  }
  recordDm(ledger, { mid: target.mid, uname: target.name, text: body, msgKey: sent?.msgKey === undefined ? null : String(sent.msgKey), isOwner: true });
  return { ok: true, text: `转达到位啦，已经发给「${target.name}」：${clipText(body, 60)}` };
}

/**
 * 「去发条学习动态吧」：主人一句话就**真发**（2026-10-05 真机事故修的就是这条）。
 *
 * 事故原样：主人连着两次私信「那你现在去发学习动态吧」，`WATCH_PATTERNS` 里的「学习|学」
 * 先把它吃成「刷视频」、关键词抠出「动态」，于是她去搜了两条名字里带「动态」的片子
 * （《动态功能介绍》《C++动态规划》）回来交差，动态**一条没发**。修法两处：
 * `lib/intent.js` 先认「发动态」（见 `POST_DYNAMIC_PATTERNS`），这里负责**真发**。
 *
 * 正文顺序跟 `bili_dynamic` 一致：主人点明的那句 → 今天学到什么（`composeStudyDynamic`）
 * → 学习素材 → 模板。这是主人的指令（`force`）⇒ `checkDynamic` 的「每日一条上限」
 * 「今天已经发过」都让路；屏蔽词、2000 字、`postDynamic = off` 照拦（账号安全线）。
 */
async function runDynamic({ cfg, ledger, client, text = '', force = false }) {
  let body = String(text ?? '').trim();
  if (body === '') {
    try {
      body = String((await composeStudyDynamic({ cfg, ledger })) ?? '').trim();
    } catch {
      body = '';
    }
  }
  if (body === '') {
    const material = takeMaterial(ledger);
    if (material !== null) body = String(material).trim();
  }
  if (body === '') {
    const templates = Array.isArray(cfg?.dailyDynamic?.templates) ? cfg.dailyDynamic.templates : [];
    const index = Number(ledger.dynamicTemplateIndex) || 0;
    body = templates.length > 0 ? String(templates[index % templates.length]) : '今天也在认真学习呢 (。-`ω´-)✧';
    ledger.dynamicTemplateIndex = index + 1;
  }
  // confirm: true —— 主人亲口让发的，草稿档不该再拦（要拦的是她**自己**想发的时候）。
  const verdict = checkDynamic({ cfg, ledger, text: body, confirm: true, auto: false, force });
  if (verdict.allowed !== true) {
    saveLedger(ledger);
    return { ok: false, text: `动态没发成：${verdict.reasons.join('；')}` };
  }
  let created = null;
  try {
    created = await client.dynamicCreate(body, { mentions: ownerMentionList(cfg) });
  } catch (error) {
    saveLedger(ledger);
    return { ok: false, text: `动态没发出去，接口报错：${error.message}` };
  }
  recordDynamic(ledger, { text: body, dynId: created?.dyn_id_str ?? created?.dynamic_id ?? null });
  saveLedger(ledger);
  appendLog('actions.log', `dynamic text=${body}`);
  return { ok: true, text: `发好啦主人～今天的动态：\n${clipText(body, Number(cfg?.policy?.maxCommentChars ?? 200))}` };
}
