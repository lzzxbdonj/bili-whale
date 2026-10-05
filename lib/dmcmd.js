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
 * 这个模块只做三件事，每件都真落地：
 *   - `/搜 <关键词>`   → 真去 B 站搜，回前三条（标题/UP/播放/时长/BV 号）
 *   - `/转达 [昵称] <正文>` → 真把正文私信给另一位主人（过 `checkDm` 同一道闸门）
 *   - `/帮助`          → 命令表
 * 认不出来的 `/xxx` 一律回命令表，**绝不丢给脑子**（丢给脑子就又变成承诺了）。
 *
 * @module dsh-bilibili-whale/dmcmd
 */
import { checkDm, ownerMentionList } from './policy.js';
import { recordDm } from './ledger.js';
import { reportHistory, tripleVideo } from './triple.js';
import { clipText } from './text.js';

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

/** 命令表（也当「不认识这个命令」的兜底回复）。 */
export function dmCommandHelp() {
  return [
    '人家能听懂这几个命令：',
    '/搜 <关键词> —— 真去 B 站搜，回前三条（标题/UP/播放/时长/BV号）',
    '/刷 <BV号|关键词> [个数] —— 真去看（进浏览记录），好看的三连',
    '/转达 [昵称] <正文> —— 真把这句话私信给另一位主人（昵称省了就发另一位）',
    '/帮助 —— 看这张表',
  ].join('\n');
}

/** 播放量这种大数字压成「12.4万」。 */
function fmtCount(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return '';
  if (num >= 100_000_000) return `${(num / 100_000_000).toFixed(1)}亿`;
  if (num >= 10_000) return `${(num / 10_000).toFixed(1)}万`;
  return String(num);
}

/**
 * 真执行一条命令。
 *
 * @param options.cfg - 已解析配置。
 * @param options.ledger - 账本（`/转达` 要过闸门+记账）。
 * @param options.client - BiliClient。
 * @param options.mid - 发命令的主人 UID。
 * @param options.uname - 发命令的主人昵称。
 * @param options.command - `parseDmCommand()` 的结果。
 * @returns {Promise<{ok: boolean, text: string}>} `text` 是要发回去的回执正文。
 */
export async function runDmCommand({ cfg, ledger, client, mid, uname, command } = {}) {
  if (command === null || command === undefined) return { ok: false, text: '' };
  if (command.name === 'help') return { ok: true, text: dmCommandHelp() };
  if (command.name === 'unknown') {
    return { ok: false, text: `人家不认识 /${command.raw} 这个命令呢。\n${dmCommandHelp()}` };
  }
  if (command.name === 'search') return await runSearch({ cfg, client, args: command.args });
  if (command.name === 'watch') return await runWatch({ cfg, ledger, client, args: command.args });
  if (command.name === 'relay') return await runRelay({ cfg, ledger, client, mid, args: command.args });
  return { ok: false, text: dmCommandHelp() };
}

/** `/搜 <关键词>`：真搜，回前三条。 */
async function runSearch({ cfg, client, args }) {
  const keyword = String(args ?? '').trim();
  if (keyword === '') return { ok: false, text: '想搜什么呀主人？这样写：/搜 拉康精神分析' };
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
 * `/刷 <BV号 | 关键词> [个数]`：主人**指定刷什么，她就真去刷什么**。
 *
 * 主人 2026-10-05：「给她自己自动刷视频的权限……还有我们让她刷什么视频她就要刷什么」。
 * 「刷」在这里是**真动作**：拉详情 → 报 B 站浏览记录（历史里看得到）→ 记进账本 `watched`
 * → 顺手读一眼前排评论 → 够得上「好内容」的再走一遍三连闸门。
 *
 * 主人特意点的片子按「好内容」算（分数取 `tripleMinScore`，正好过分数门槛），
 * 但每日上限 / 去重 / 标题黑名单这些闸门照走 —— 主人点头也不能让她被风控带走。
 */
async function runWatch({ cfg, ledger, client, args }) {
  const words = String(args ?? '').trim().split(/\s+/u).filter((word) => word !== '');
  if (words.length === 0) return { ok: false, text: '要刷什么呀主人？这样写：/刷 BV1xxxxxxxxxx，或者 /刷 拉康精神分析 3' };
  const first = words[0];
  const isId = /^(BV[0-9A-Za-z]{10}|av\d+)$/u.test(first);
  const count = Math.min(Math.max(Number(words[1]) || 1, 1), 5);
  const targets = [];
  try {
    if (isId) {
      targets.push(await client.video(first));
    } else {
      const items = await client.search(words.join(' '));
      for (const item of (Array.isArray(items) ? items : []).slice(0, count)) {
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

  const lines = [];
  let tripled = 0;
  for (const video of targets) {
    const watched = await reportHistory({ client, cfg, video, ledger, progress: 0, source: 'master' });
    let hot = 0;
    try {
      const listed = await client.comments(video.bvid, { ps: 3, aid: video.aid });
      hot = (listed?.replies ?? []).length;
    } catch {
      hot = 0;
    }
    const verdict = await tripleVideo({ client, cfg, ledger, video, topic: '', score: Number(cfg?.policy?.tripleMinScore ?? 6), confirm: false });
    if (verdict.done === true) tripled += 1;
    const bits = [String(video.author ?? '').trim(), fmtCount(video.view), String(video.duration ?? '').trim()].filter((piece) => piece !== '');
    lines.push(`${video.bvid}｜${clipText(video.title, 34)}｜${bits.join('｜')}｜${watched.reported === true ? '进历史✓' : '没进历史'}${verdict.done === true ? '｜三连✓' : ''}${hot > 0 ? `｜热评${hot}` : ''}`);
  }
  const text = [`刷了 ${targets.length} 个${tripled > 0 ? `，三连 ${tripled} 个` : ''}：`, ...lines].join('\n');
  return { ok: true, text: clipText(text, Number(cfg?.policy?.maxCommentChars ?? 200)) };
}

/**
 * `/转达 [昵称] <正文>`：真发私信给另一位主人。
 *
 * 昵称省略就发给「另一位主人」（配置里除了自己以外的那位）。开了头的第一个词**只有**
 * 正好是某位主人的昵称（`ownerNames`/`ownerMids`）才当收件人；对不上就整串当正文，
 * 绝不把「张三 你好」猜成要转给金易木木元 —— 转错人比不转更糟。主人多于两位且
 * 没点名时直接问清楚。
 */
async function runRelay({ cfg, ledger, client, mid, args }) {
  const owners = ownerMentionList(cfg);
  const others = owners.filter((row) => String(row.mid) !== String(mid));
  if (others.length === 0) return { ok: false, text: '配置里只认得一位主人，人家不知道该转给谁呢。' };
  let target = others.length === 1 ? others[0] : null;
  let body = String(args ?? '').trim();
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
    return { ok: false, text: `要转给谁呀主人？这样写：/转达 ${others[0].name} 正文` };
  }
  if (body === '') return { ok: false, text: `要转达什么呀主人？这样写：/转达 ${target.name} 正文` };
  const verdict = checkDm({ cfg, ledger, mid: target.mid, uname: target.name, text: body });
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
