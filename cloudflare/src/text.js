/**
 * 文本安全小工具（`lib/text.js` 的云端逐字镜像，改一边必须改另一边）。
 *
 * 为什么需要它（2026-10-05 真机踩到的坑，两条脑子同时全挂）：
 *
 * 1. `JSON.stringify` 会把「孤立代理项」（半个 emoji —— U+D800–U+DFFF 里落单的那个
 *    UTF-16 码元）转义成 `\ud83d` 这种**单飞的** `\uXXXX`。
 * 2. Node 自己的 `JSON.parse` 容忍这种写法，但 **DeepSeek 与 Cloudflare Workers AI
 *    用的严格 JSON 解析器不容忍**：
 *      - DeepSeek 直接 400：`Failed to parse the request body as JSON:
 *        messages[1].content: unexpected end of hex escape at line 1 column …`；
 *      - Workers AI 报 8006：`Invalid data for body - reason must be valid JSON`。
 *    于是「回主人用付费模型（deepseek）」和「免费兜底（whale）」**同时**哑火，
 *    评论回复永远写不出正文，主人那条回复欠了整整一天也发不出去。
 *
 * 孤立代理项是从哪来的：B 站评论里本来就带 emoji，而 `String.prototype.slice`
 * 是**按 UTF-16 码元**切的 —— `text.slice(0, 60)` 正好切在代理对中间，就劈出一个孤立的。
 * 所以本模块除了 `stripLoneSurrogates()` 还提供 `clipText()`：
 * **先清干净 → 再截断 → 截完再清一次**，从源头上不再制造孤立代理项。
 *
 * @module dsh-bilibili-whale/cloudflare-text
 */

/**
 * 去掉孤立代理项，成对的正常 emoji 原样保留。
 *
 * @param {unknown} value - 任意值（内部 `String()` 一下）。
 * @returns {string} 干净的字符串。
 */
export function stripLoneSurrogates(value) {
  const text = String(value ?? '');
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      // 高位代理项：后面紧跟低位才算一对完整 emoji，否则丢掉。
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i] + text[i + 1];
        i += 1;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      // 落单的低位代理项：没有配对的高位，丢掉。
      continue;
    }
    out += text[i];
  }
  return out;
}

/**
 * 安全截断：绝不把 emoji 代理对劈成两半。
 *
 * @param {unknown} value - 原始文本。
 * @param {number} max - 最多保留多少个 UTF-16 码元。
 * @returns {string} 截断并清理过的文本。
 */
export function clipText(value, max) {
  const text = stripLoneSurrogates(value);
  const limit = Number(max);
  if (!Number.isFinite(limit) || limit <= 0) return '';
  if (text.length <= limit) return text;
  // 截完可能又在切口上劈出一个孤立的，所以再清一次。
  return stripLoneSurrogates(text.slice(0, limit));
}

/**
 * 把一串文本做成「一定不会被严格 JSON 解析器拒绝」的形态。
 *
 * 给模型请求组装 body 之前过一道：`JSON.stringify` 之后不该再出现
 * 「单飞的 `\uXXXX`」——那正是 DeepSeek 400 / Workers AI 8006 的唯一成因。
 *
 * @param {unknown} value - 任意值。
 * @returns {string} 干净的字符串。
 */
export function safeForModel(value) {
  return stripLoneSurrogates(value);
}
