/**
 * 主人的「最高权限」私信运维台（第九轮，2026-10-05）。
 *
 * 主人原话：「给另一个主人调试最高权限」——勾的是三件事：
 *   1. 私信里的运维命令：状态 / 日志 / 配置 / 额度 / 最近动作；
 *   2. 免限额免间隔：他说的动作立刻办、不限次数、跳过去重（那个由 `lib/policy.js` 的
 *      `isDebugOwner()` + 各闸门的 `force` 参数负责，这里只管命令）；
 *   3. 能远程让她重启看门鲸 / 改她的配置。
 *
 * 铁律不变：**要办事的命令必须走代码，不能走模型。** 所以这里全是最普通的确定性解析，
 * 一个模型调用都没有；认不出来就回说明书，绝不交给脑子去猜。
 *
 * ⚠️ 这个模块只给 `isDebugOwner()` 为真的主人用；`policy.ownerDebug = false` 或不在
 * `policy.debugMids` 名单里的人，`lib/tools.js` 根本不会走到这里。
 *
 * @module dsh-bilibili-whale/debug
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { deepMerge, readJsonFile, readUserConfig, statePath, writeJsonFile, appendLog } from './config.js';
import { loadLedger, recentWatched, todayCounts, selfWatchedToday, todayWatched, dmCountForUser, tripleCountToday } from './ledger.js';
import { ownerMentionList } from './policy.js';
import { clipText } from './text.js';

/** 允许看的日志（白名单，别让主人一句话把 cookies 或环境文件读出来）。 */
export const DEBUG_LOGS = ['actions', 'brain', 'study', 'cloudsync', 'auto', 'dm-watch'];

/** 键名里带这些字的一律不显示、更不许改（凭据和令牌都不在 config.json 里）。 */
const SECRET_KEY = /(key|token|secret|cookie|password|passwd|sessdata|jct|credential)/iu;

/** 改配置时不许碰的路径（原型污染 + 凭据）。 */
const FORBIDDEN_PATH = /(__proto__|prototype|constructor)/u;

/** 私信回执长度上限：跟策略层的「私信不能超过 maxCommentChars 字」同一个数（回执也走那道闸门）。 */
function replyChars(cfg) {
  return Math.max(20, Number(cfg?.policy?.maxCommentChars ?? 200) || 200);
}

/**
 * 把回执按私信上限交出去：装得下就直接发，装不下就**全文落盘**再回一句指路。
 *
 * 为什么这么绕：回执本身要过 `checkDmReply`，那里用 `policy.maxCommentChars`（默认 200 字）
 * 卡长度 —— 看日志/看配置这种东西一条私信装不下。与其偷偷把闸门关掉（那是防刷屏的安全线），
 * 不如把全文写到状态目录，主人本机就能打开看。
 */
function deliver(cfg, text) {
  const cap = replyChars(cfg);
  const body = String(text ?? '');
  if (body.length <= cap) return body;
  const file = statePath('debug-out.txt');
  try {
    writeFileSync(file, `${body}\n`, 'utf8');
  } catch {
    return clipText(body, cap);
  }
  // 指路的尾巴本身也要占地方：装得下就写全路径，装不下就只写文件名（否则回执自己会超长，
  // 被 `checkDmReply` 当成「私信超字数」整条拦掉，主人反而什么都看不到）。
  const compact = `\n…全文见 debug-out.txt（${body.length} 字）`;
  const detailed = `\n…全文（${body.length} 字）写到：${file}`;
  const tail = detailed.length <= cap - 20 ? detailed : compact;
  if (tail.length > cap - 8) return clipText(body, cap);
  return `${clipText(body, Math.max(8, cap - tail.length))}${tail}`;
}

/**
 * 把主人的话搓成「调试台看得懂的一句」：去掉斜杠、客套、语气，再去掉尾巴上的标点。
 *
 * 「帮我看看日志」→「日志」；「/配置 policy.tripleMinScore」→「配置 policy.tripleMinScore」。
 */
function normalize(raw) {
  let text = String(raw ?? '').trim();
  for (let round = 0; round < 3; round += 1) {
    const before = text;
    text = text
      .replace(/^[/／、,，]\s*/u, '')
      .replace(/^(?:帮我|替我|麻烦你|麻烦|请你|请|给我|你)\s*/u, '')
      .replace(/^(?:看(?:一下|一看|看|下)?|查(?:一下|一看|下)?|读(?:一下|下)?|瞄(?:一下)?)\s*/u, '');
    if (text === before) break;
  }
  return text.replace(/[，。！？!?~～\s]+$/u, '').trim();
}

/** 把「关 / 开 / 不限 / 12 / {…}」搓成真值。 */
function parseValue(raw) {
  const text = String(raw ?? '').trim();
  if (/^(关|关掉|关闭|禁用|off|false|no|不)$/iu.test(text)) return false;
  if (/^(开|打开|开启|启用|on|true|yes|要)$/iu.test(text)) return true;
  if (/^(不限|无限|无限制|随便|不用限制)$/u.test(text)) return 0;
  if (/^-?\d+(?:\.\d+)?$/u.test(text)) return Number(text);
  if (/^[[{"]/u.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

/**
 * 认一条调试命令（不碰网络、不写盘，纯解析）。
 *
 * @param {string} text - 主人发来的原话。
 * @returns {{name: string, arg: string}|null} `name` ∈ status/logs/config/setconfig/quota/recent/restart。
 */
export function parseDebugCommand(text) {
  const raw = String(text ?? '').trim();
  if (raw === '') return null;
  const clean = normalize(raw);
  if (clean === '') return null;
  // 「把 policy.x 改成 关」这种口语句式（比 `改配置` 更自然）
  const polite = clean.match(/^把\s*([\w.$-]+)\s*(?:改成|改为|设为|设置为|调成|调为)\s*([\s\S]+)$/u);
  if (polite !== null) return { name: 'setconfig', arg: `${polite[1]} ${polite[2]}` };
  if (/^(?:状态|情况|怎么样了|还好吗|活着吗|在吗|status)$/iu.test(clean)) return { name: 'status', arg: '' };
  if (/^(?:日志|看日志|最新日志|log|logs)(?:\s+([\w-]+))?$/iu.test(clean)) {
    const hit = clean.match(/^(?:日志|看日志|最新日志|log|logs)(?:\s+([\w-]+))?$/iu);
    return { name: 'logs', arg: String(hit?.[1] ?? 'actions').trim() };
  }
  if (/^(?:改配置|设置|修改配置|set|setconfig)\s+([\s\S]+)$/iu.test(clean)) {
    return { name: 'setconfig', arg: clean.replace(/^(?:改配置|设置|修改配置|set|setconfig)\s+/iu, '').trim() };
  }
  if (/^(?:配置|看配置|读取配置|config|getconfig)(?:\s+([\w.$-]+))?$/iu.test(clean)) {
    const hit = clean.match(/^(?:配置|看配置|读取配置|config|getconfig)(?:\s+([\w.$-]+))?$/iu);
    return { name: 'config', arg: String(hit?.[1] ?? '').trim() };
  }
  if (/^(?:额度|配额|还剩多少|今天刷了多少|quota)$/iu.test(clean)) return { name: 'quota', arg: '' };
  if (/^(?:最近|最近动作|最近干了啥|动作|actions?)$/iu.test(clean)) return { name: 'recent', arg: '' };
  if (/^(?:重启|重启看门鲸|重启程序|重新启动|restart|reload)$/iu.test(clean)) return { name: 'restart', arg: '' };
  return null;
}

/** 调试台说明书（认不出命令时回这个，**绝不丢给脑子**）。 */
export function debugHelp() {
  return [
    '主人要是想调试人家，这样跟人家说就行：',
    '·「状态」——登录/等级/今天做了多少/看门鲸还活着吗',
    '·「日志 actions」——看最近的动作（也能看 brain/study/cloudsync/auto/dm-watch）',
    '·「配置 policy.tripleMinScore」——看某一项（不带路径就看全貌）',
    '·「改配置 policy.tripleMinScore 8」或「把 policy.minIntervalSeconds 改成 0」',
    '·「额度」——今天的用量和上限',
    '·「最近」——最近刷了什么、动作记录',
    '·「重启」——让人家把看门鲸重启一下（改完代码/配置生效用）',
  ].join('\n');
}

/** 按点分路径取值（`policy.tripleMinScore`）。 */
function pickPath(root, path) {
  if (path === '') return undefined;
  let node = root;
  for (const key of String(path).split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[key];
  }
  return node;
}

/** 深拷贝一份、把秘密字段涂掉（只给主人看，不落日志）。 */
function redact(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) === true ? '（已隐藏）' : redact(item, depth + 1);
  }
  return out;
}

/** 读看门鲸心跳（`tools/dm-watch.mjs` 每轮写一次）。 */
export function watchdogInfo() {
  const info = readJsonFile(statePath('watchdog.json'), null);
  if (info === null || typeof info !== 'object') return null;
  return info;
}

/** 读日志尾巴。 */
function tailLog(name, lines) {
  const file = statePath(`logs/${name}.log`);
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text.split(/\r?\n/u).filter((line) => line.trim() !== '').slice(-lines);
}

/** 今天做了多少（额度视图）。 */
function usageLines(cfg, ledger, now = new Date()) {
  const counts = todayCounts(ledger, now);
  const self = selfWatchedToday(ledger, now).length;
  const cap = Number(cfg?.learning?.dailyWatch ?? 30);
  const owners = ownerMentionList(cfg).map((row) => `${row.name}=${dmCountForUser(ledger, row.mid, now)}`);
  return [
    `视频评论 ${counts.videoComments}/${Number(cfg?.policy?.dailyVideoComments ?? 0) === 0 ? '不限' : cfg.policy.dailyVideoComments}｜回复 ${counts.replies}/${Number(cfg?.policy?.dailyReplies ?? 10)}`,
    `三连 ${tripleCountToday(ledger, now)}/${Number(cfg?.policy?.dailyTriples ?? 0) === 0 ? '不限' : cfg.policy.dailyTriples}｜收藏 ${counts.favorites}/${Number(cfg?.policy?.dailyFavorites ?? 5)}｜动态 ${counts.dynamics}/${Number(cfg?.policy?.dailyDynamics ?? 1)}`,
    `自己刷的视频 ${self}/${cap === 0 ? '不限' : cap}（主人点名的不计入）`,
    `私信：${owners.join('｜')}`,
  ];
}

/**
 * 真办一条调试命令。
 *
 * @param {object} options
 * @param {object} options.cfg - 生效配置。
 * @param {object} options.command - `parseDebugCommand()` 的结果。
 * @param {object} [options.ledger] - 账本（不给就现读）。
 * @param {object} [options.client] - BiliClient（`状态` 要看登录态）。
 * @param {string|number} [options.mid] - 发命令的主人 UID（记账用）。
 * @param {string} [options.uname] - 发命令的主人昵称（记账用）。
 * @returns {Promise<{ok: boolean, text: string}>}
 */
export async function runDebugCommand({ cfg, command, ledger = null, client = null, mid = '', uname = '' } = {}) {
  if (command === null || command === undefined) return { ok: false, text: '' };
  const book = ledger ?? loadLedger();
  const name = String(command.name ?? '');
  const arg = String(command.arg ?? '').trim();

  if (name === 'status') {
    const lines = ['人家还活着呢主人～'];
    if (client !== null && typeof client.nav === 'function') {
      try {
        const nav = await client.nav();
        lines.push(`B 站：${nav.isLogin === true ? `已登录 ${nav.uname}（mid ${nav.mid}）` : '未登录'}｜等级 Lv${nav.level ?? '?'}｜硬币 ${nav.coins ?? nav.money ?? '?'}`);
      } catch (error) {
        lines.push(`B 站：查不动（${clipText(String(error.message ?? error), 60)}）`);
      }
    }
    const dog = watchdogInfo();
    lines.push(dog === null
      ? '看门鲸：没看到心跳（可能没在跑）'
      : `看门鲸：pid ${dog.pid ?? '?'}｜心跳 ${dog.ts === undefined ? '?' : new Date(Number(dog.ts)).toLocaleString('zh-CN')}｜每 ${dog.everyMinutes ?? '?'} 分钟一轮`);
    lines.push(...usageLines(cfg, book));
    return { ok: true, text: deliver(cfg, lines.join('\n')) };
  }

  if (name === 'logs') {
    const want = arg === '' ? 'actions' : arg;
    if (DEBUG_LOGS.includes(want) !== true) {
      return { ok: false, text: `人家只能看这几个日志：${DEBUG_LOGS.join('、')}。想看哪个直接说，比如「日志 brain」。` };
    }
    const lines = tailLog(want, 12);
    if (lines.length === 0) return { ok: true, text: `\`${want}.log\` 现在还是空的呢。` };
    return { ok: true, text: deliver(cfg, [`\`${want}.log\` 最后 ${lines.length} 行：`, ...lines].join('\n')) };
  }

  if (name === 'config') {
    if (arg === '') {
      const view = redact({ policy: cfg?.policy ?? {}, learning: cfg?.learning ?? {}, feed: cfg?.feed ?? {}, cloud: cfg?.cloud ?? {} });
      return { ok: true, text: deliver(cfg, ['生效配置（改过的会盖住默认值）：', JSON.stringify(view, null, 1)].join('\n')) };
    }
    if (SECRET_KEY.test(arg) === true) return { ok: false, text: '这一项是秘密，人家不说也不给改。' };
    const value = pickPath(cfg, arg);
    if (value === undefined) return { ok: false, text: `配置里没有 \`${arg}\` 这一项呢（改过的项会盖住默认值，名字得写全）。` };
    return { ok: true, text: `配置 \`${arg}\` = ${JSON.stringify(redact(value))}` };
  }

  if (name === 'setconfig') {
    const parts = arg.split(/\s+/u).filter((piece) => piece !== '');
    if (parts.length < 2) return { ok: false, text: '要改哪一项、改成什么呀主人？这样说：「改配置 policy.tripleMinScore 8」。' };
    const path = parts[0];
    const value = parseValue(parts.slice(1).join(' '));
    if (FORBIDDEN_PATH.test(path) === true) return { ok: false, text: '这个路径不许碰（怕把配置写坏）。' };
    if (SECRET_KEY.test(path) === true) return { ok: false, text: '秘密字段不在配置文件里，人家改不了（要改走环境变量/凭据文件）。' };
    if (pickPath(cfg, path) === undefined) {
      return { ok: false, text: `配置里没有 \`${path}\` 这一项呢，先「配置」看一眼名字再改吧。` };
    }
    // 只写用户覆盖层（config.json），默认值本身不动 —— 这样主人随时能删掉恢复出厂。
    const patch = {};
    let node = patch;
    const keys = path.split('.');
    keys.forEach((key, index) => {
      if (index === keys.length - 1) {
        node[key] = value;
      } else {
        node[key] = {};
        node = node[key];
      }
    });
    const next = deepMerge(readUserConfig(), patch);
    try {
      writeJsonFile(statePath('config.json'), next);
    } catch (error) {
      return { ok: false, text: `没写成：${clipText(String(error.message ?? error), 80)}` };
    }
    appendLog('actions.log', `debug-config ${path}=${JSON.stringify(value)} by=${uname || mid}`);
    const effective = deepMerge(cfg, patch);
    return { ok: true, text: `改好了：\`${path}\` = ${JSON.stringify(redact(pickPath(effective, path) ?? value))}\n（写进 config.json 的覆盖层，立刻生效，不用重启）` };
  }

  if (name === 'quota') {
    return { ok: true, text: deliver(cfg, ['今天的用量：', ...usageLines(cfg, book)].join('\n')) };
  }

  if (name === 'recent') {
    // 控制在一封私信装得下的长度（超长就会落 debug-out.txt，主人得去电脑前看，不划算）。
    const watched = recentWatched(book, 3);
    const lines = [
      `今天刷了 ${todayWatched(book).length} 条（自己挑的 ${selfWatchedToday(book).length} 条）`,
      ...watched.map((row) => `· ${row.bvid}｜${row.source ?? '?'}｜${row.topic === '' || row.topic === undefined ? '没标方向' : row.topic}`),
      '最近的动作：',
      ...tailLog('actions', 2).map((line) => clipText(line, 36)),
    ];
    return { ok: true, text: deliver(cfg, lines.join('\n')) };
  }

  if (name === 'restart') {
    // 看门鲸每轮读一次这个文件；`ts` 比它自己的启动时间新，它就会 detached 重启自己。
    try {
      writeJsonFile(statePath('restart.request'), { ts: Date.now(), by: String(uname || mid), reason: '主人在私信里说了重启' });
    } catch (error) {
      return { ok: false, text: `没写成重启请求：${clipText(String(error.message ?? error), 80)}` };
    }
    appendLog('actions.log', `debug-restart requested by=${uname || mid}`);
    const dog = watchdogInfo();
    if (dog === null) return { ok: false, text: '重启请求写下了，可是没看到看门鲸的心跳 —— 它好像本来就没在跑，主人得在电脑前手动起一下。' };
    return { ok: true, text: `好啦，重启请求已经递过去了（看门鲸 pid ${dog.pid ?? '?'}），它下一轮（最多 ${dog.everyMinutes ?? '?'} 分钟）就自己换一条命。` };
  }

  return { ok: false, text: debugHelp() };
}
