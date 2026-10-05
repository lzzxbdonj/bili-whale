/**
 * 极简 HTTP 客户端：**带代理支持**的取文本工具。
 *
 * 为什么需要它：这台开发机的 DNS 被污染（`workers.dev` / `*.workers.dev` 会被解析到
 * 2a03:2880:… （Facebook）和 104.244.46.x 这类假地址），直连 Cloudflare 一律 10 秒超时；
 * 而机器上有一个系统代理（WinINET `127.0.0.1:19451`）能正常出去。
 * Node 的全局 `fetch`（undici）既不读系统代理、默认也不读 `HTTPS_PROXY` 环境变量，
 * 所以云端的对账/遥控请求会莫名其妙「fetch failed」。
 * 这里用 `HTTP CONNECT` 打一条隧道，再在隧道里跑 HTTPS，行为跟 curl -x 一致。
 *
 * 仅供云端遥控台（Cloudflare Worker）这类**需要翻墙出去**的请求使用；
 * B 站接口本机直连没问题，不必绕代理。
 *
 * @module dsh-bilibili-whale/httpx
 */
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

/** 决定这次请求走哪个代理：显式配置 > 环境变量 > 直连。 */
export function resolveProxyUrl(explicit = '') {
  const fromConfig = String(explicit ?? '').trim();
  if (fromConfig !== '') return fromConfig;
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const value = String(process.env[key] ?? '').trim();
    if (value !== '') return value;
  }
  return '';
}

/** 在代理上开隧道，返回一个已经连到目标站点的 TLS socket。 */
function tunnel(proxyUrl, target) {
  const proxy = new URL(proxyUrl);
  const port = Number(target.port || 443);
  const host = target.hostname;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: {
        host: `${host}:${port}`,
        ...(proxy.username === '' ? {} : { 'proxy-authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` }),
      },
      timeout: 15000,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理拒绝 CONNECT（${res.statusCode}）`));
        return;
      }
      const secured = tls.connect({ socket, servername: host }, () => resolve(secured));
      secured.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('代理连接超时')); });
    req.end();
  });
}

/**
 * 取一个 URL 的文本。
 *
 * @param url - 完整地址。
 * @param options.method - HTTP 方法。
 * @param options.headers - 请求头。
 * @param options.body - 字符串正文（给了就自动带 content-length）。
 * @param options.proxy - 显式代理地址（空则看环境变量、再直连）。
 * @param options.timeoutMs - 超时毫秒数。
 * @returns {Promise<{status:number, ok:boolean, text:string}>}
 */
export async function requestText(url, { method = 'GET', headers = {}, body = null, proxy = '', timeoutMs = 30000 } = {}) {
  const proxyUrl = resolveProxyUrl(proxy);
  if (proxyUrl === '') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body === null ? undefined : body,
        signal: controller.signal,
      });
      return { status: response.status, ok: response.ok === true, text: await response.text() };
    } finally {
      clearTimeout(timer);
    }
  }

  const target = new URL(url);
  const socket = await tunnel(proxyUrl, target);
  const payload = body === null ? null : Buffer.from(body, 'utf8');
  const head = [
    `${method} ${target.pathname}${target.search} HTTP/1.1`,
    `Host: ${target.host}`,
    'Connection: close',
    ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
    ...(payload === null ? [] : [`Content-Length: ${payload.length}`]),
  ].join('\r\n');
  // 自己拼请求、自己解响应：Node 的 https.Agent 只肯在它自己建的 socket 上做 TLS，
  // 拿一条已经握手好的隧道 socket 塞给它，请求会石沉大海（实测 15 秒超时）。
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`请求超时（${timeoutMs}ms）`));
    }, timeoutMs);
    let buffer = Buffer.alloc(0);
    let headDone = false;
    let parsedHead = null;
    let chunked = false;
    let remaining = -1;
    const parts = [];

    const finish = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({
        status: parsedHead?.status ?? 0,
        ok: (parsedHead?.status ?? 0) >= 200 && (parsedHead?.status ?? 0) < 300,
        text: Buffer.concat(parts).toString('utf8'),
      });
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (headDone === false) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const rawHead = buffer.subarray(0, end).toString('utf8');
        buffer = buffer.subarray(end + 4);
        const lines = rawHead.split('\r\n');
        const status = Number((lines[0] ?? '').split(' ')[1] ?? 0);
        const headerMap = {};
        for (const line of lines.slice(1)) {
          const at = line.indexOf(':');
          if (at > 0) headerMap[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
        }
        parsedHead = { status, headers: headerMap };
        chunked = /chunked/i.test(headerMap['transfer-encoding'] ?? '');
        remaining = chunked ? -1 : Number(headerMap['content-length'] ?? -1);
        headDone = true;
      }
      if (chunked) {
        // 逐块解析：<十六进制长度>\r\n<数据>\r\n … 0\r\n\r\n
        for (;;) {
          const at = buffer.indexOf('\r\n');
          if (at < 0) return;
          const size = Number.parseInt(buffer.subarray(0, at).toString('utf8').trim(), 16);
          if (!Number.isFinite(size)) return finish();
          if (size === 0) return finish();
          if (buffer.length < at + 2 + size + 2) return;
          parts.push(buffer.subarray(at + 2, at + 2 + size));
          buffer = buffer.subarray(at + 2 + size + 2);
        }
      }
      if (remaining >= 0) {
        parts.push(buffer);
        remaining -= buffer.length;
        buffer = Buffer.alloc(0);
        if (remaining <= 0) finish();
      }
    });
    socket.on('end', () => {
      if (headDone === false) {
        clearTimeout(timer);
        reject(new Error('代理隧道没有返回响应'));
        return;
      }
      if (remaining > 0 || chunked) {
        // 连接提前断了：把已经拿到的给调用方，总比什么都没有强。
        parts.push(buffer);
      }
      finish();
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.write(head + '\r\n\r\n');
    if (payload !== null) socket.write(payload);
  });
}

/** 取 JSON（非 2xx 也照解析，交给调用方判断）。 */
export async function requestJson(url, options = {}) {
  const { text, status, ok } = await requestText(url, {
    ...options,
    headers: { accept: 'application/json', ...(options.headers ?? {}) },
  });
  let json = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 2000) };
  }
  return { status, ok, json, text };
}
