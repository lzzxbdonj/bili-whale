/**
 * 私信里的**自然语言**识别：主人怎么说话，她都能听懂——不用再打 `/刷`、`/搜` 这种命令。
 *
 * 主人 2026-10-05（第六轮原话）：「私信刷视频不要命令形式，自然语言识别，让她自己刷。」
 *
 * 铁律（上一轮用 10 小时惨案换来的）：**要办事必须走代码，不能走模型。**
 * 所以这里不是「让模型猜主人想干嘛」，而是一层**认出意图就交给 `lib/dmcmd.js` 真执行**的
 * 确定性解析器：认出「帮我搜一下拉康的视频」→ 真去 search；认出「自己去找点东西看看」→
 * 真去刷并留浏览记录。模型只负责**写那口回执的语气**，绝不负责「办没办」。
 *
 * 认识的三件事（与 `/搜` `/刷` `/转达` 一一对应）：
 *   - `search`：让我搜/找/查点什么，或者问「有没有 X 的视频、给我几个 BV 号」
 *   - `watch` ：让我真去看（进浏览记录+三连）；没点名看什么就**自己挑**（self=true）
 *   - `relay` ：把一句话转达给另一位主人
 *
 * 不认识的、纯聊天、否定句（「别刷了」）、以及「能不能/怎么/为什么」这类**问方法**的话，
 * 一律返回 null 交回原来的聊天链路 —— 宁可让脑子好好聊天，也不许她乱动主人的账号。
 *
 * @module dsh-bilibili-whale/intent
 */

/** 一句话里带「否定」时一律不动手：主人说「别刷了」她要是真去刷，比不刷还糟。 */
const NEGATIONS = ['别', '不要', '不用', '先别', '暂时别', '先不', '不必', '不用管', '别去', '别刷', '别搜', '别看', '不准', '停一下', '停下', '取消'];

/** 问「怎么做」的话不是「去做」：主人问「能不能帮我搜」可以办，问「怎么搜」只能聊天。 */
const METHOD_QUESTIONS = ['怎么', '如何', '为什么', '为啥', '是不是可以', '可不可以教我', '教教我'];

/**
 * 认「让我搜点什么」的说法。第一个捕获组是关键词（可能为空，交给下一档兜）。
 *
 * ⚠️ 量词那一组必须写成**贪婪的重复**（`(?:一下|点|些|几个)+`）而不是可选的 `?`：
 * 写成 `?` 时，正则引擎只要能把后面那个可选的 `([^\s…]+)?` 凑够就算成功，
 * 「帮我搜一下拉康精神分析」会抠出「一下拉康精神分析」、「帮我看看 BV1xxxx」会抠出「看」——
 * 量词和动词全混进关键词里，搜出来的东西跟主人要的完全不搭。
 */
const SEARCH_PATTERNS = [
  /(?:帮我|替人家|给人家|麻烦你?|帮忙|请你?|你?去|快|赶紧|立刻|马上|现在|来)*\s*(?:搜索|搜|查|找一下|找找|找|看看有没有|有没有|推荐|挑|来点|来几个|整理|列个清单|列清单|罗列|汇总)\s*(?:一下|一哈|一回|点|些|几个|几条)*\s*([^\s，。！？、；:：""'']+)?/u,
];

/**
 * 认「让我真去看」的说法。量词那一组的写法理由同上。
 *
 * 动词表里「看看」必须排在「看」前面：交替是从左往右试的，长的写前头才不会只吃掉一个「看」，
 * 把另一个「看」留在捕获组里（写成 `看` 在前时「看看 BV1xxxx」抠出来的关键词是「看」）。
 */
const WATCH_PATTERNS = [
  /(?:帮我|给人家|麻烦你?|请你?|你?去|快|赶紧|立刻|马上|现在|来)*\s*(?:刷一刷|刷点|刷刷|刷|看看|看一看|看|逛逛|逛一逛|溜达|学习|学|三连|收藏)\s*(?:一下|一哈|一点|个把|几条|几个)*\s*([^\s，。！？、；:：""'']+)?/u,
];

/** 「没点名看什么」时她自己挑的几种说法。 */
const SELF_WATCH = [
  /(自己|你自己|自动|随便|随意|你看着办|想刷啥刷啥|想学啥学啥)/u,
];

/**
 * 认「帮我转达给另一位主人」。
 *
 * 动词表里**必须有光杆的「跟」「和」**：主人最自然的说法是「帮我跟金易木木元说声谢谢」，
 * 而「跟人家说」「跟他说」这两个长词都吃不下「跟金易木木元」——少了这两个字，
 * 整句就一文不值地落到 watch 那一档去了（「说」不在 watch 表里，结果是整句没人认）。
 * 排长的在前，让「跟…说」优先被长词吃掉。
 *
 * ⚠️ 光杆的「跟」「和」必须带**前瞻**：后面 8 个字里得真有一个「说/讲/带/捎/传」，
 * 否则中文里最常见的连词「和」会制造灾难性误判 —— 2026-10-05 金易木木元发的
 * 「从场域，本体论，认识论和目的论四个方面总结整个系列，而不是这一期」被「和」切开，
 * 判成「转达『目的论四个方面总结整个系列…』给懒寻真」，她回了句「没转成」。
 * （当时是私信上限把它拦下了才没真发出去；上限关掉后这条误判会直接发一条垃圾私信，
 *  所以在关上限的同一次改动里必须把前瞻补上。）
 */
const RELAY_PATTERNS = [
  /(?:帮我|替我|给人家|麻烦你?|请你?|你?去|快|赶紧|立刻|马上|现在|来)*\s*(?:转达|转告|转给|转达一下|跟人家说|跟他说|带个话|捎句话|传个话|说一下|告诉|跟(?=[\s\S]{1,8}(?:说|讲|带|捎|传))|和(?=[\s\S]{1,8}(?:说|讲|带|捎|传)))\s*(?:一下|一声|一句)?\s*[:：]?\s*([\s\S]+)$/u,
];

/** 关键词尾巴上的口头语，去了再拿去搜。 */
const TAIL_FILLERS = ['吧', '呀', '啊', '呢', '哦', '啦', '嘛', '哈', '一下', '一点', '一些', '几个', '几条'];
/** 光杆语气词：抠出来只剩这些就等于「没抠到东西」——
 *  「这个要怎么搜呀」的「搜」是动词本身，抠出来的「呀」不是关键词。 */
const BARE_FILLERS = new Set(['吧', '呀', '啊', '呢', '哦', '啦', '嘛', '哈', '一下', '一点', '一些', '几个', '几条', '的', '了']);
/** 关键词里要整段去掉的水词。 */
const PHRASE_FILLERS = ['相关的视频', '相关视频', '有关视频', '相关的', '有关的', '相关的视频内容', '的视频', '视频', '的内容', '内容', '合集', '清单'];

/**
 * 把主人那句话里的「要看/要搜什么」抠出来。
 *
 * @param {unknown} raw - 原始片段（可能带「的视频」这种尾巴和「吧」这种口头语）。
 * @returns {string} 干净的关键词；抠不出东西就返回空串。
 */
export function cleanKeyword(raw) {
  let text = String(raw ?? '').trim();
  text = text.replace(/^[的了个]?[，。！？、；:：\s]+/u, '').replace(/[，。！？、；:：""''\s]+$/u, '');
  for (const filler of PHRASE_FILLERS) text = text.split(filler).join('');
  let changed = true;
  while (changed === true && text !== '') {
    changed = false;
    for (const filler of TAIL_FILLERS) {
      if (text.endsWith(filler) === true && text.length > filler.length) {
        text = text.slice(0, -filler.length);
        changed = true;
      }
    }
  }
  // 「拉康精神分析的视频」→ 去掉「的视频」再收掉光杆的「的」。
  text = text.replace(/的$/u, '').trim();
  if (text === '') return '';
  // 一个汉字都没有（比如「，帮我看下」抠出来的标点）就不算关键词。
  if (/[\u4e00-\u9fa5a-zA-Z0-9]/u.test(text) !== true) return '';
  return text.length > 30 ? text.slice(0, 30) : text;
}

/** 主人在**问方法/闲聊**，不是在下命令。 */
function asksForMethod(text) {
  if (METHOD_QUESTIONS.some((word) => text.includes(word)) === true) return true;
  return /(能不能|可不可以|可以吗|行不行|好不好|要吗|好吗)[？?]?$/u.test(text);
}

/** 主人在**否定**这件事（别刷、先别、不用了）。 */
function negated(text) {
  return NEGATIONS.some((word) => text.startsWith(word) === true || text.includes(`，${word}`) === true || text.includes(` ${word}`) === true || text.includes(`，先别`) === true);
}

/**
 * 认一条私信里主人想让她干的事。
 *
 * 顺序很要紧（第六轮踩过坑）：**先认「要办的事」，再拿「问方法」去否决**。
 * 因为主人求人办事最自然的说法就是问句 —— 「你能不能帮我搜一下拉康的视频？」
 * 这句里的「能不能」是客气，不是疑问；早先版本先查「能不能」末尾就把它当成问方法，
 * 结果主人越客气她越不动手。现在的规矩是：**只要句子里有明确的动作（搜/刷/转达），
 * 一律按「要办」处理**；只有找不到动作、又确实在问「怎么/如何/能不能」时才算问方法。
 *
 * @param {unknown} text - 私信正文。
 * @returns {{name: string, target: string, keyword: string, self: boolean, count: number, source: string}|null}
 *   不是「可执行的事」就返回 null（交回聊天链路）。
 */
export function parseIntent(text) {
  const raw = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (raw === '') return null;
  if (negated(raw) === true) return null;
  const hit = matchIntent(raw);
  // 认出了明确动作 → 主人再客气也是在下命令。
  if (hit !== null) return hit;
  // 没认出动作：问方法的（「这个要怎么搜呀」「可不可以教教我」）交回聊天链路 —— 她只能聊天，
  // **绝不许**为了「显得听话」去乱动主人账号（`asksForMethod()` 在这里只是显式写出这条规矩）。
  if (asksForMethod(raw) === true) return null;
  return null;
}

/** 纯模式匹配：只认「要办的三件事」，不管否定/问句（那是 `parseIntent` 的活）。 */
function matchIntent(raw) {
  // ⓪ 「刷完了吗」「搜过了没」是在**问结果**，不是让去办 —— 这种句子里的动词会被正则当成命令,
  //    抠出来的「完了吗」还要被当成关键词去搜，所以先在这里掐掉。
  if (/(完了|过了|好了|完了没|过没)\s*(吗|没|嘛|没有)?\s*[？?]?$/u.test(raw) === true) return null;

  // ① 转达：只要出现「转达/告诉/跟…说」就算（这是最不容易误判的一类）。
  for (const pattern of RELAY_PATTERNS) {
    const hit = raw.match(pattern);
    if (hit === null) continue;
    const target = splitRelayTarget(String(hit[1] ?? '').replace(/^[，。！？、；:：\s]+/u, '').trim());
    if (target === '') continue;
    return { name: 'relay', target, keyword: '', self: false, count: 1, source: '' };
  }

  // ② 「自己刷」：没点名要什么，她自己挑。
  const wantWatch = WATCH_PATTERNS.some((pattern) => pattern.test(raw));
  const bySelf = SELF_WATCH.some((pattern) => pattern.test(raw));
  if (wantWatch === true && bySelf === true) {
    return { name: 'watch', target: '', keyword: '', self: true, count: 1, source: 'self' };
  }

  // ③ 真去看：抠出要点名的片子（BV 号 / 关键词）。
  const watchHit = firstMatch(raw, WATCH_PATTERNS);
  if (watchHit !== null) {
    const target = cleanKeyword(watchHit);
    const isId = /^(BV[0-9A-Za-z]{10}|av\d+)$/u.test(target);
    return { name: 'watch', target, keyword: isId === true ? '' : target, self: target === '', count: countFromText(raw, target), source: 'master' };
  }

  // ④ 搜：抠关键词。
  const searchHit = firstMatch(raw, SEARCH_PATTERNS);
  if (searchHit !== null) {
    // 「你去找找拉康」会把第二个「找」也抠进关键词，所以再削一次开头的动词。
    const keyword = cleanKeyword(stripLeadSearchVerb(searchHit));
    // 「这个要怎么搜呀」也会路过这里（「搜」被当成动词、抠出来一个「呀」）：
    // 抠出来只剩语气词就不算关键词，免得她真拿「呀」去搜。
    if (keyword !== '' && BARE_FILLERS.has(keyword) !== true) {
      return { name: 'search', target: keyword, keyword, self: false, count: 1, source: '' };
    }
  }

  // ⑤ 「有没有 X 的视频」「给我几个 X 的 BV 号」——没动词也算，但**必须带提问词/索要词**，
  //    而且得在句首：不然「这个视频真好看」也会被当成让她去搜（第六轮收窄过这条）。
  const askHit = raw.match(/^(?:有没有|有|给我|来点|来几个|推荐|要)\s*([\u4e00-\u9fa5A-Za-z0-9]{2,20})\s*(?:的视频|相关的视频|有关的视频|视频|的内容)/u);
  if (askHit !== null) {
    const keyword = cleanKeyword(askHit[1]);
    if (keyword !== '') return { name: 'search', target: keyword, keyword, self: false, count: 1, source: '' };
  }
  return null;
}

/** 从一串正则里取第一个捕获组（没有捕获组就返回空串表示「认出来了但没带宾语」）。 */
function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const hit = text.match(pattern);
    if (hit === null) continue;
    return String(hit[1] ?? '').trim();
  }
  return null;
}

/**
 * 「帮我跟金易木木元说声谢谢」：把「收件人 + 要说的话」拆开。
 *
 * `RELAY_PATTERNS` 的光杆动词「跟」「和」吃不下「跟金易木木元说声谢谢」，整串会落在捕获组里，
 * 于是收件人那截和正文黏在一起（`runRelay` 只在有空格时才认昵称，会整串当正文发出去）。
 * 这里按「收件人 + 说/讲/带 + 一声/一句」把话切开：`金易木木元说声谢谢` → `金易木木元 谢谢`。
 *
 * 只在**句首那一小截像人名**（1-8 个字、没有空格）时才切 —— 「说一声我到了」这种没有收件人的
 * 句子必须原样留着，绝不能拿「我到了」当人名（发错人比不发更糟）。
 *
 * @param {string} target - 正则抠出来的那串。
 * @returns {string} 空格隔开的「收件人 正文」，或原样返回。
 */
function splitRelayTarget(target) {
  const text = String(target ?? '').trim();
  const hit = text.match(/^(.{1,8}?)\s*(?:说|讲|带|捎)\s*(?:声|一句|一下)?\s*([\s\S]+)$/u);
  if (hit === null) return text;
  const who = String(hit[1] ?? '').trim();
  const body = String(hit[2] ?? '').trim();
  if (who === '' || body === '') return text;
  return `${who} ${body}`;
}

/** 「找找」「搜一下」「推荐几个」这类动词和量词，别让它跟着关键词去搜。 */
function stripLeadSearchVerb(raw) {
  let text = String(raw ?? '').trim();
  const redup = text.match(/^(搜|查|找|翻|推荐|挑|来|整|罗|汇)\1+/u);
  if (redup !== null) text = text.slice(redup[0].length).trim();
  else text = text.replace(/^(搜|搜索|查|找|推荐|挑|整理|罗列|汇总)/u, '').trim();
  // 剩下来的「几个拉康精神分析」：量词留着会让搜出来的东西完全跑偏。
  text = text.replace(/^(几个|几条|几支|几个|一些|一点|点|些|来点|来几个)/u, '').trim();
  return text;
}

/** 「看 3 个」「来个两条」里的个数。 */
function countFromText(text, keyword) {
  const hit = String(text).match(/(?:刷|看|来|要|要了)\s*([0-9一二两三四五])\s*(?:个|条|支|部)?/u);
  if (hit === null) return 1;
  const map = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5 };
  const value = map[hit[1]] ?? Number(hit[1]);
  if (Number.isFinite(value) !== true) return 1;
  return Math.min(Math.max(Math.trunc(value), 1), 5);
}

/**
 * 主人这句话是不是在**支使她干活**（哪怕没认出具体想干什么）。
 *
 * 用来给脑子一句上下文：认出来了就照实回执「已经办了」，认不出来就必须老实说
 * 「这个人家现在办不了」——**绝不许再来一句「我这就去」**（10 小时惨案）。
 *
 * @param {unknown} text - 私信正文。
 * @returns {boolean}
 */
export function looksLikeActionRequest(text) {
  const raw = String(text ?? '').trim();
  if (raw === '') return false;
  if (negated(raw) === true) return false;
  if (asksForMethod(raw) === true) return false;
  if (parseIntent(raw) !== null) return true;
  return /(帮我|给人家|替你|替我|你去|快去|赶紧|麻烦你|请你)[^\s]*/u.test(raw) === true
    || /^(去|快|赶紧|立刻|马上)\s*[^\s]+/u.test(raw) === true;
}

/**
 * 她「能听懂什么」的说明书（自然语言版）。
 *
 * 主人 2026-10-05：「不要命令形式」——所以这里教的是**人话**，
 * 斜杠写法还能用（老主人手熟），但不再出现在这张表里。
 *
 * @param {object} options.cfg - 已解析配置（用到字符上限）。
 * @returns {string} 塞得进一条私信（≤200 字）的说明书。
 */
export function intentHelp(cfg = {}) {
  const cap = Number(cfg?.policy?.maxCommentChars ?? 200);
  return [
    '主人直接跟人家说话就行，人家听得懂：',
    '· 「搜一下拉康精神分析」→ 人家真去搜，把前三条带 BV 号发回来',
    '· 「自己去找点视频看看」→ 人家自己挑、自己刷，浏览记录里看得到',
    '· 「帮我跟金易木木元说声谢谢」→ 人家真把话转达过去',
  ].join('\n').slice(0, cap);
}
