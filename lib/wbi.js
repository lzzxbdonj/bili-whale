/**
 * WBI 签名：B 站 2023 年起对 search / 首页推荐 / 新版评论列表等接口要求的
 * w_rid + wts 签名。密钥来自 nav 接口返回的 wbi_img（未登录也能拿到）。
 *
 * @module dsh-bilibili-whale/wbi
 */
import { createHash } from 'node:crypto';

/** 官方 mixinKey 乱序表。 */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

/** 从 wbi_img 的两个 URL 里取出文件名（不含扩展名）。 */
export function keyFromUrl(url) {
  const name = String(url ?? '').split('/').pop() ?? '';
  return name.split('.')[0] ?? '';
}

/** 由 img_key + sub_key 生成 32 位 mixinKey。 */
export function mixinKey(imgKey, subKey) {
  const raw = `${imgKey}${subKey}`;
  return MIXIN_KEY_ENC_TAB.map((index) => raw[index] ?? '').join('').slice(0, 32);
}

/** md5 十六进制。 */
export function md5(text) {
  return createHash('md5').update(text, 'utf8').digest('hex');
}

/**
 * 给参数签名，返回可直接拼到 URL 上的查询串。
 * @param params - 业务参数（值会被转成字符串）。
 * @param imgKey - nav.wbi_img.img_url 的文件名。
 * @param subKey - nav.wbi_img.sub_url 的文件名。
 * @param now - 秒级时间戳（测试可注入）。
 */
export function encodeWbi(params, imgKey, subKey, now = Math.round(Date.now() / 1000)) {
  const key = mixinKey(imgKey, subKey);
  const all = { ...params, wts: String(now) };
  const query = Object.keys(all)
    .sort()
    .map((name) => {
      // 官方实现会先过滤掉 !'()* 这几个字符再编码
      const value = String(all[name]).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
    })
    .join('&');
  return `${query}&w_rid=${md5(query + key)}`;
}

/** 给完整 URL 追加 WBI 签名（url 里已有查询串时正确拼接）。 */
export function signUrl(url, imgKey, subKey) {
  const parsed = new URL(url);
  const params = {};
  parsed.searchParams.forEach((value, name) => {
    params[name] = value;
  });
  const signed = encodeWbi(params, imgKey, subKey);
  return `${parsed.origin}${parsed.pathname}?${signed}`;
}
