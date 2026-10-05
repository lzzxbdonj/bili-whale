/**
 * 「别把 emoji 劈成半个」的回归测试（2026-10-05 真机事故）。
 *
 * 事故经过：主人的评论回复整整一天发不出去。`logs/brain.log` 里两家脑子同时挂：
 *   - `askBrain(whale) 失败：云端返回 502：模型报错：8006: Invalid data for body - reason must be valid JSON`
 *   - `askBrain(deepseek) http 400: null`
 * 真凶不是 key、不是网络、不是 Worker 版本，而是**提示词里有一个孤立代理项**：
 * `String.prototype.slice` 按 UTF-16 码元切，`text.slice(0, 60)` 正好切在 emoji 代理对中间，
 * 劈出一个孤立的高位代理项 U+D83D；`JSON.stringify` 把它写成**单飞的** `\ud83d`。
 * Node 的 `JSON.parse` 容忍，DeepSeek / Workers AI 的严格解析器不容忍：
 *   `Failed to parse the request body as JSON: messages[1].content: unexpected end of hex escape at line 1 column 4922`
 *
 * 这里把三件事钉住：
 *   1. `stripLoneSurrogates` / `clipText` 的行为（成对 emoji 保留、孤立的清掉、截断不劈对）；
 *   2. **复现机制**：老写法 `slice(0, 60)` 真的会劈出孤立代理项，`clipText(..., 60)` 不会；
 *   3. **出口把关**：`askBrain` 真正 `JSON.stringify` 出去的 body 里，不允许出现单飞代理项转义，
 *      而且 `buildReplyPrompt` 喂给模型的上下文本身就得是干净的。
 *
 * 用法：node test/text.test.mjs
 */
import { strict as assert } from 'node:assert';
import { askBrain } from '../lib/brain.js';
import { buildReplyPrompt } from '../lib/compose.js';
import { clipText, safeForModel, stripLoneSurrogates } from '../lib/text.js';
import * as cloudText from '../cloudflare/src/text.js';

/** 一个真的 emoji：U+1F30A 🌊 = 高位 \ud83c + 低位 \udf0a。 */
const WAVE = '\u{1F30A}';
/** 🌊 的两个半边。 */
const WAVE_HIGH = '\ud83c';
const WAVE_LOW = '\udf0a';
/** 事故现场真正出现的那个孤立代理项（半个 emoji，U+D83D）。 */
const LONE_HIGH = '\ud83d';
const LONE_LOW = '\udf0a';

/**
 * 扫出孤立代理项（模拟严格解析器的视角）。
 *
 * @param {string} text - 要检查的字符串。
 * @returns {number[]} 孤立代理项的码元下标。
 */
function loneSurrogateAt(text) {
  const hits = [];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) hits.push(i);
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      const prev = text.charCodeAt(i - 1);
      if (!(prev >= 0xd800 && prev <= 0xdbff)) hits.push(i);
    }
  }
  return hits;
}

/**
 * 严格解析器会拒绝的形态：`JSON.stringify` 之后出现**单飞**的 `\uXXXX` 转义。
 *
 * @param {string} text - 要发出去的文本。
 * @returns {string|null} 命中的转义片段（没命中返回 null）。
 */
function loneEscapeInJson(text) {
  const encoded = JSON.stringify({ content: text });
  let index = encoded.indexOf('\\u');
  while (index !== -1) {
    const hex = encoded.slice(index + 2, index + 6);
    if (/^[dD][89abAB][0-9a-fA-F]{2}$/u.test(hex)) {
      const after = encoded.slice(index + 6, index + 12);
      if (!/^\\u[dD][c-fC-F][0-9a-fA-F]{2}$/u.test(after)) return encoded.slice(index, index + 6);
    }
    if (/^[dD][c-fC-F][0-9a-fA-F]{2}$/u.test(hex)) {
      const before = encoded.slice(Math.max(0, index - 6), index);
      if (!/\\u[dD][89abAB][0-9a-fA-F]{2}$/u.test(before)) return encoded.slice(index, index + 6);
    }
    index = encoded.indexOf('\\u', index + 1);
  }
  return null;
}

// ── 1. stripLoneSurrogates：成对保留、孤立清掉 ──────────────────────────────
{
  assert.equal(stripLoneSurrogates(`人家${WAVE}拍拍`), `人家${WAVE}拍拍`, '成对的 emoji 要原样保留');
  assert.equal(stripLoneSurrogates(`人家${LONE_HIGH}拍拍`), '人家拍拍', '孤立高位代理项要清掉');
  assert.equal(stripLoneSurrogates(`人家${LONE_LOW}拍拍`), '人家拍拍', '孤立低位代理项要清掉');
  assert.equal(stripLoneSurrogates(`a${WAVE_HIGH}${WAVE_LOW}b`), `a${WAVE}b`, '高低位顺序接上就该拼回一个 emoji');
  assert.equal(stripLoneSurrogates(null), '', 'null 也吃得下');
  assert.equal(stripLoneSurrogates(undefined), '', 'undefined 也吃得下');
  assert.equal(stripLoneSurrogates(123), '123', '非字符串走 String()');
}

// ── 2. clipText：截断绝不劈开代理对 ────────────────────────────────────────
{
  const long = `${'啊'.repeat(59)}${WAVE}尾巴`;
  // 复现机制：老写法按码元切，第 59 位正好是高位代理项 → 劈出一个孤立的。
  const naive = long.slice(0, 60);
  assert.equal(loneSurrogateAt(naive).length, 1, '老写法 slice(0, 60) 确实会劈出孤立代理项（这就是事故根因）');
  // 新写法同一位置不会劈。
  assert.deepEqual(loneSurrogateAt(clipText(long, 60)), [], 'clipText 不能劈开 emoji 代理对');
  assert.equal(clipText(long, 60), '啊'.repeat(59), '切在代理对之前就把它整对丢掉，不留半个');
  assert.equal(clipText('短文本', 100), '短文本', '没超长就原样返回');
  assert.equal(clipText(`${WAVE}${WAVE}`, 4), `${WAVE}${WAVE}`, '刚好放得下两个 emoji');
  assert.equal(clipText('abc', 0), '', 'max<=0 返回空串');
  assert.equal(clipText('abc', -1), '', 'max 为负返回空串');
  assert.equal(clipText('abc', Number.NaN), '', 'max 非有限数返回空串');
  assert.deepEqual(loneSurrogateAt(clipText(`${LONE_HIGH}${'x'.repeat(100)}`, 50)), [], '截断前也要先把孤立项清掉');
}

// ── 3. safeForModel 就是出口兜底 ───────────────────────────────────────────
{
  const dirty = `拍拍～${LONE_HIGH}\n- 欸嘿，主人～`;
  assert.equal(loneEscapeInJson(dirty), '\\ud83d', '没兜底时 JSON 里就是单飞的 \\ud83d（严格解析器会 400）');
  const clean = safeForModel(dirty);
  assert.equal(loneEscapeInJson(clean), null, 'safeForModel 之后不该再有单飞转义');
  assert.equal(clean, '拍拍～\n- 欸嘿，主人～', '只清代理项，别的字符一个不动');
}

// ── 4. 真实事故数据：buildReplyPrompt 出来的上下文本身就得干净 ───────────────
{
  const cfg = {
    ownerName: '懒寻真',
    ownerNames: ['懒寻真', '金易木木元'],
    policy: { maxCommentChars: 200, mentionOwnersOnReply: false },
  };
  // 让「最近回过别人的话」那条正好在第 60 个码元处卡一个 emoji（事故就是这么来的）。
  const poison = `${'人家觉得你的混剪视频超级高燃'.repeat(3).slice(0, 59)}${WAVE}最后那个场景真的让人家尾巴拍拍～`;
  const prompt = buildReplyPrompt({
    cfg,
    video: { title: '⚡我即为长夜⚡', author: '某UP', tags: ['混剪'], desc: '高燃混剪' },
    comment: { uname: '懒寻真', mid: 3494364865103885, message: '又去偷懒刷视频了' },
    context: {
      isOwner: true,
      kind: 'video',
      selfText: `人家学到了时间跟相对论有关${WAVE}`,
      thread: [{ uname: '懒寻真', message: `又去偷懒刷视频了${WAVE}`, isTarget: true }],
      recentReplies: [poison],
      kb: `艾宾浩斯遗忘曲线${WAVE}`,
    },
  });
  assert.deepEqual(loneSurrogateAt(prompt.system), [], 'system 提示词里不能有孤立代理项');
  assert.deepEqual(loneSurrogateAt(prompt.user), [], 'user 提示词里不能有孤立代理项（事故就出在这）');
  assert.equal(loneEscapeInJson(prompt.system), null);
  assert.equal(loneEscapeInJson(prompt.user), null);
  assert.ok(prompt.user.includes('又去偷懒刷视频了'), '清代理项不能把正文内容一起吃掉');
}

// ── 5. 出口把关：askBrain 真正发出去的 body 不允许有单飞转义 ─────────────────
{
  const realFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, options = {}) => {
    captured = { url: String(url), body: String(options.body ?? '') };
    return new Response(JSON.stringify({ choices: [{ message: { content: '人家在呢～' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    // pollinations 不要 key，直接走 fetch，正好拿来抓 body。
    const cfg = { brain: { provider: 'pollinations', fallback: '', paid: '' } };
    const dirty = `拍拍～${LONE_HIGH}\n- 欸嘿，主人～`;
    const text = await askBrain(cfg, { system: dirty, user: dirty });
    assert.equal(text, '人家在呢～', '假模型应答得上');
    assert.ok(captured !== null, '应该真的发出去了一个请求');
    assert.equal(captured.url, 'https://text.pollinations.ai/openai/chat/completions');
    assert.equal(loneEscapeInJson(captured.body), null, '发出去的 body 里不能有单飞代理项转义（DeepSeek 会 400）');
    const parsed = JSON.parse(captured.body);
    assert.deepEqual(loneSurrogateAt(parsed.messages[0].content), [], 'system 已经是干净的');
    assert.deepEqual(loneSurrogateAt(parsed.messages[1].content), [], 'user 已经是干净的');
    assert.equal(parsed.messages[1].content, '拍拍～\n- 欸嘿，主人～', '内容本身不能被吃掉');
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── 6. 云端镜像（cloudflare/src/text.js）不能和本机跑偏 ──────────────────────
{
  assert.equal(typeof cloudText.stripLoneSurrogates, 'function', '云端镜像要导出 stripLoneSurrogates');
  assert.equal(typeof cloudText.clipText, 'function', '云端镜像要导出 clipText');
  assert.equal(typeof cloudText.safeForModel, 'function', '云端镜像要导出 safeForModel');
  const samples = [
    `人家${WAVE}拍拍`,
    `人家${LONE_HIGH}拍拍`,
    `人家${LONE_LOW}拍拍`,
    `${'啊'.repeat(59)}${WAVE}尾巴`,
    '普通文本',
    '',
    null,
  ];
  for (const sample of samples) {
    assert.equal(cloudText.stripLoneSurrogates(sample), stripLoneSurrogates(sample), `stripLoneSurrogates 本机/云端不一致：${JSON.stringify(sample)}`);
    assert.equal(cloudText.clipText(sample, 60), clipText(sample, 60), `clipText 本机/云端不一致：${JSON.stringify(sample)}`);
    assert.equal(cloudText.safeForModel(sample), safeForModel(sample), `safeForModel 本机/云端不一致：${JSON.stringify(sample)}`);
  }
}

console.log('✓ 文本安全测试通过：孤立代理项清理、截断不劈 emoji、提示词干净、出口 body 无单飞转义、云端镜像一致');
