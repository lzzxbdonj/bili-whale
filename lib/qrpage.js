/**
 * 把 B 站的扫码登录链接渲染成本地可扫的二维码页面。
 *
 * 为什么要这一层：B 站「扫码登录」的正确姿势是**手机 B 站 App 扫二维码**，
 * 二维码内容就是 qrcode/generate 返回的那个 url。直接在已登录的桌面浏览器里
 * 打开这个 url 只会看到「当前浏览器账号 + 确认」按钮，点了与登录轮询毫无关系
 * （踩过一次），所以必须把 url 画成二维码让主人用手机扫。
 *
 * 二维码编码器（qrcodejs 1.0.0，MIT）已经**内联**进生成的 HTML：
 * 页面不联网、不依赖 CDN、不把一次性登录链接发给任何第三方，file:// 直接能扫。
 *
 * @module dsh-bilibili-whale/qrpage
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 内联用的二维码编码器（assets/qrcode.min.js，qrcodejs 1.0.0 / MIT）。 */
export const QR_LIB_PATH = join(HERE, '..', 'assets', 'qrcode.min.js');

/** JSON 序列化后塞进 <script>，避免 `</script>` 提前闭合。 */
function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** 读取内联的二维码编码器源码；读不到就返回 null（页面退化成只显示链接）。 */
export function loadQrLib() {
  try {
    return readFileSync(QR_LIB_PATH, 'utf8').replace(/<\/script/gi, '<\\/script');
  } catch {
    return null;
  }
}

/**
 * 生成二维码页面的完整 HTML。
 *
 * @param {string} url - 二维码内容（B 站扫码登录链接）。
 * @param {{title?: string, note?: string, libSource?: string|null}} [options]
 * @returns {string} HTML 文本。
 */
export function buildQrHtml(url, options = {}) {
  const title = options.title ?? '小鲸鱼娘的 B 站扫码登录';
  const note = options.note ?? '用手机 B 站 App 的「扫一扫」扫下面这个二维码，然后在手机上点「确认登录」。';
  const libSource = options.libSource === undefined ? loadQrLib() : options.libSource;
  const renderScript =
    typeof libSource === 'string' && libSource !== ''
      ? `${libSource}
  try {
    new QRCode(document.getElementById('qr'), { text: QR_TEXT, width: 320, height: 320, correctLevel: QRCode.CorrectLevel.M });
    document.getElementById('status').textContent = '';
    document.getElementById('tip').textContent = '扫完记得在手机上点「确认」哦～';
  } catch (error) {
    document.getElementById('status').textContent = '二维码画不出来（' + error.message + '），请用下面的链接。';
  }`
      : `document.getElementById('status').textContent = '二维码组件没带上，请用下面的链接在手机 B 站里打开。';`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: radial-gradient(circle at 50% 0%, #dff1ff 0%, #f7fbff 55%, #ffffff 100%);
    font-family: "Microsoft YaHei", "PingFang SC", system-ui, sans-serif; color: #17324d;
  }
  .card {
    background: #ffffff; border-radius: 24px; padding: 32px 40px 28px;
    box-shadow: 0 18px 48px rgba(23, 50, 77, 0.14); text-align: center; max-width: 480px;
  }
  h1 { font-size: 22px; margin: 0 0 6px; }
  .note { font-size: 14px; color: #4a6b88; margin: 0 0 18px; line-height: 1.6; }
  #qr { width: 320px; height: 320px; margin: 0 auto; display: flex; align-items: center; justify-content: center; }
  #qr img, #qr canvas { border-radius: 12px; }
  #status { font-size: 13px; color: #7d93a8; min-height: 20px; margin-top: 10px; }
  .url { margin-top: 14px; font-size: 11px; color: #8fa6ba; word-break: break-all; line-height: 1.5; user-select: all; }
  .tip { margin-top: 18px; font-size: 13px; color: #2f8fb5; min-height: 20px; }
</style>
</head>
<body>
  <div class="card">
    <h1>🐳 ${title}</h1>
    <p class="note">${note}</p>
    <div id="qr"></div>
    <div id="status">正在准备二维码…</div>
    <p class="tip" id="tip"></p>
    <p class="url" id="urlText"></p>
  </div>
<script>
  var QR_TEXT = ${jsonForScript(url)};
  document.getElementById('urlText').textContent = QR_TEXT;
  ${renderScript}
</script>
</body>
</html>
`;
}

/**
 * 写出二维码页面，返回文件路径。
 *
 * @param {string} url - 二维码内容。
 * @param {string} file - 目标 HTML 路径。
 * @param {{title?: string, note?: string}} [options]
 * @returns {string} 写入的路径。
 */
export function writeQrPage(url, file, options = {}) {
  writeFileSync(file, buildQrHtml(url, options), 'utf8');
  return file;
}
