/**
 * WBI 签名（Workers 版）：B 站 2023 年起对 search / 首页推荐 / 新版评论列表等接口要求的
 * w_rid + wts 签名。密钥来自 nav 接口返回的 wbi_img（未登录也能拿到）。
 *
 * 与 lib/wbi.js 的唯一实现差异：MD5 由 node:crypto 改为本地纯 JS（Workers 没有
 * crypto.createHash，WebCrypto 也不支持 MD5）。公式、乱序表、参数排序、过滤字符、
 * 拼接顺序全部逐字符照抄，输出与源文件完全一致。
 *
 * @module dsh-bilibili-whale/cloudflare/wbi
 */
import { md5Hex } from './md5.js';

/** 官方 mixinKey 乱序表。 */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

/**
 * 从 wbi_img 的两个 URL 里取出文件名（不含扩展名）。
 * @param url - 例如 https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png
 * @returns 文件名主体（无扩展名、无路径）。
 */
export function keyFromUrl(url) {
  const name = String(url ?? '').split('/').pop() ?? '';
  return name.split('.')[0] ?? '';
}

/**
 * 由 img_key + sub_key 生成 32 位 mixinKey。
 * @param imgKey - wbi_img.img_url 的文件名。
 * @param subKey - wbi_img.sub_url 的文件名。
 * @returns 32 位 mixinKey。
 */
export function mixinKey(imgKey, subKey) {
  const raw = `${imgKey}${subKey}`;
  return MIXIN_KEY_ENC_TAB.map((index) => raw[index] ?? '').join('').slice(0, 32);
}

/**
 * md5 十六进制（与源文件同名导出；实现换成纯 JS MD5）。
 * @param text - 待摘要的字符串（UTF-8）。
 * @returns 32 位小写十六进制串。
 */
export function md5(text) {
  return md5Hex(text);
}

/**
 * 给参数签名，返回可直接拼到 URL 上的查询串。
 * @param params - 业务参数（值会被转成字符串）。
 * @param imgKey - nav.wbi_img.img_url 的文件名。
 * @param subKey - nav.wbi_img.sub_url 的文件名。
 * @param now - 秒级时间戳（缺省取当前时间；测试可注入）。
 * @returns 形如 a=1&wts=1700000000&w_rid=... 的查询串。
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

/**
 * 给完整 URL 追加 WBI 签名（url 里已有查询串时正确拼接）。
 *
 * 时间戳取值：显式传入的 wts（第 4 参，本移植新增的可选注入点）> 当前时间。
 * 三参调用的行为与源文件逐字一致——源文件也是 `Math.round(Date.now() / 1000)`，
 * 且 encodeWbi 里 `{ ...params, wts: String(now) }` 会**覆盖** url 里已有的 wts。
 * 第 4 参只用于「不依赖当前时间」的确定性输出，便于与源文件对齐比对。
 *
 * @param url - 完整 URL（可已带查询串）。
 * @param imgKey - nav.wbi_img.img_url 的文件名。
 * @param subKey - nav.wbi_img.sub_url 的文件名。
 * @param wts - 可选，秒级时间戳；不给则取当前时间（与源文件相同）。
 * @returns 带 w_rid 的完整 URL。
 */
export function signUrl(url, imgKey, subKey, wts) {
  const parsed = new URL(url);
  const params = {};
  parsed.searchParams.forEach((value, name) => {
    params[name] = value;
  });
  const now = wts !== undefined && wts !== null && wts !== '' ? Number(wts) : Math.round(Date.now() / 1000);
  const signed = encodeWbi(params, imgKey, subKey, now);
  return `${parsed.origin}${parsed.pathname}?${signed}`;
}
