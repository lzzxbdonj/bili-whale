/**
 * B 站 API 客户端（Cloudflare Workers 版）。
 *
 * 覆盖：登录态(nav) / 首页推荐(rcmd) / 热门(popular) / 排行榜(ranking) /
 * 搜索(search) / 视频详情(view) / 评论列表(reply) / 发评论(reply/add) /
 * 发动态(dynamic create) / 扫码登录(qrcode generate+poll) / 消息中心(msgfeed/reply)。
 *
 * 所有请求共用一套浏览器化请求头；写操作走 form 或 JSON，并带 csrf=bili_jct。
 *
 * 与 lib/api.js 的差异（仅这两处，语义不变）：
 *   1. 不再从磁盘读登录态：cookie 由构造参数 cookies（普通对象）传入，客户端自己拼 Cookie 头；
 *      服务端下发的 Set-Cookie / buvid 指纹通过 onCookies 回调交给调用方持久化。
 *   2. fetch 可注入（fetchImpl），便于测试与在 Worker 里替换。
 * 其余方法名、参数、返回形状、错误判定与文案逐行照抄。
 *
 * @module dsh-bilibili-whale/cloudflare/bili
 */
import { keyFromUrl, signUrl } from './wbi.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** B 站登录必需/有用的 cookie 键（来自 lib/cookies.js 的 COOKIE_KEYS）。 */
export const COOKIE_KEYS = [
  'SESSDATA',
  'bili_jct',
  'DedeUserID',
  'DedeUserID__ckMd5',
  'sid',
  'buvid3',
  'buvid4',
  'b_nut',
  'buvid_fp',
  'CURRENT_FNVAL',
  'CURRENT_QUALITY',
];

/** B 站业务错误（code != 0）。 */
export class BiliError extends Error {
  /**
   * @param code - B 站返回的 code。
   * @param message - 中文说明。
   * @param payload - 原始响应体。
   */
  constructor(code, message, payload) {
    super(`B站接口返回 ${code}：${message}`);
    this.name = 'BiliError';
    this.code = code;
    this.payload = payload;
  }
}

/** 常见 code 的中文解释，出错时直接告诉模型怎么办。 */
export const CODE_HINT = {
  '-101': '先跑 bili_login 扫码登录。',
  '-111': '登录态可能过期，重新扫码。',
  '-400': '请求参数错误。',
  '-403': '多半需要登录或被风控了。',
  '-404': '内容不存在或已删除。',
  12061: '评论内容被拒（可能含敏感词或重复）。',
  12015: '需要先绑定手机号才能评论。',
  12035: '评论被判定为刷屏（内容重复发送）。',
  12051: '评论太频繁，稍后再试。',
  10030: '该内容禁止评论。',
  41010: '动态发布失败：多为登录态或参数问题。',
};

/** 去掉搜索/推荐标题里的 <em class="keyword"> 高亮标签。 */
export function stripHtml(text) {
  return String(text ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/** 秒数 → mm:ss。 */
export function fmtDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 时间戳 → 东八区 YYYY-MM-DD HH:mm（中文用户看到的输出与源文件本地时区一致）。 */
export function fmtTime(ts) {
  if (!ts) return '';
  const date = new Date(Number(ts) * 1000);
  if (Number.isNaN(date.getTime())) {
    // 源文件直接取 Date 的本地 getter，无效时间戳会拼出 'NaN-NaN-NaN NaN:NaN'。
    // 这里逐字保持一致（而不是「顺手」返回空串），免得上层拿到的字符串形状变了。
    return 'NaN-NaN-NaN NaN:NaN';
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? '';
  // 某些环境里 hourCycle 会把 00 点写成 24，按东八区的日界也要归一
  const hour = pick('hour') === '24' ? '00' : pick('hour');
  return `${pick('year')}-${pick('month')}-${pick('day')} ${hour}:${pick('minute')}`;
}

/** 解析 "a=1; b=2" 形式的 cookie 字符串。 */
export function parseCookieString(raw) {
  const out = {};
  for (const part of String(raw).split(';')) {
    const item = part.trim();
    if (item === '') continue;
    const eq = item.indexOf('=');
    if (eq <= 0) continue;
    out[item.slice(0, eq).trim()] = item.slice(eq + 1).trim();
  }
  return out;
}

/** 解析 fetch 的 Set-Cookie 头数组。 */
export function parseSetCookie(list) {
  const out = {};
  for (const raw of list ?? []) {
    const first = String(raw).split(';')[0] ?? '';
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    out[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
  }
  return out;
}

/**
 * 从 fetch Response 里取 Set-Cookie 数组。
 * Workers 的 Headers 有 getSetCookie()；有些运行时（或测试替身）只有 get()，那就自己按逗号切。
 */
export function readSetCookie(headers) {
  if (headers === undefined || headers === null) return [];
  try {
    if (typeof headers.getSetCookie === 'function') return headers.getSetCookie() ?? [];
  } catch {
    /* 落到 get('set-cookie') */
  }
  try {
    const single = typeof headers.get === 'function' ? headers.get('set-cookie') : null;
    if (typeof single === 'string' && single !== '') return [single];
  } catch {
    /* 拿不到就当作没有 */
  }
  return [];
}

/** 组 Cookie 请求头；无 cookie 时返回空串。 */
export function cookieHeader(cookies) {
  const pairs = Object.entries(cookies ?? {})
    .filter(([key, value]) => typeof value === 'string' && value !== '' && (COOKIE_KEYS.includes(key) || key.startsWith('buvid') || key.startsWith('b_')))
    .map(([key, value]) => `${key}=${value}`);
  return pairs.join('; ');
}

/** 有 bili_jct 才能做写操作（它是 csrf token 的来源）。 */
export function hasWriteCredentials(cookies) {
  return typeof cookies?.bili_jct === 'string' && cookies.bili_jct !== '' && typeof cookies?.SESSDATA === 'string' && cookies.SESSDATA !== '';
}

/** B 站 API 客户端（Web 平台版）。 */
export class BiliClient {
  /**
   * @param options.cookies - 普通对象 { 名称: 值 }；客户端自己拼 Cookie 头。
   * @param options.fetchImpl - 可选注入的 fetch（测试用）。
   * @param options.onCookies - 可选回调 (cookieObject) => void，服务端下发 Set-Cookie / 指纹时调用。
   * @param options.config - 生效配置（只用 limits.timeoutMs 等）。
   */
  constructor({ cookies = {}, config = {}, fetchImpl = null, onCookies = null } = {}) {
    this.config = config ?? {};
    this.session = { cookies: { ...(cookies ?? {}) }, user: {} };
    this.fetchImpl = typeof fetchImpl === 'function' ? fetchImpl : null;
    this.onCookies = typeof onCookies === 'function' ? onCookies : null;
    this.wbiCache = null;
    this.buvid = undefined;
  }

  /** 实际发请求用的 fetch（缺省全局 fetch，丢失 this 没关系）。 */
  fetcher() {
    return this.fetchImpl ?? ((...args) => fetch(...args));
  }

  /** 当前 cookie 记录（返回内部对象，便于调用方读）。 */
  get cookies() {
    return this.session.cookies;
  }

  /** 覆盖 cookie（合并式），并通知 onCookies。 */
  setCookies(patch) {
    if (patch === null || typeof patch !== 'object') return this.cookies;
    Object.assign(this.session.cookies, patch);
    this.notifyCookies();
    return this.cookies;
  }

  /** 把当前 cookie 交给调用方持久化（没回调就只在内存里）。 */
  notifyCookies() {
    if (this.onCookies === null) return;
    try {
      this.onCookies({ ...this.session.cookies });
    } catch {
      /* 持久化失败不影响主流程 */
    }
  }

  /**
   * 保证手里有 buvid3/buvid4：B 站多数接口（搜索、推荐）靠它做设备指纹，
   * 没有就会被当成裸请求回 -101。取一次就记住，并通过 onCookies 交给调用方落盘。
   */
  async ensureBuvid() {
    if (this.buvidReady === true) return;
    this.buvidReady = true;
    if (typeof this.cookies.buvid3 === 'string' && this.cookies.buvid3 !== '') return;
    try {
      const response = await this.fetcher()('https://api.bilibili.com/x/frontend/finger/spi', {
        headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
        signal: AbortSignal.timeout(8000),
      });
      const body = await response.json();
      const b3 = body?.data?.b_3;
      const b4 = body?.data?.b_4;
      if (typeof b3 !== 'string' || b3 === '') return;
      this.session = {
        ...(this.session ?? {}),
        cookies: { ...this.cookies, buvid3: b3, buvid4: b4 },
        savedAt: new Date().toISOString(),
        user: this.session?.user ?? {},
        anonymousFingerprint: true,
      };
      this.notifyCookies();
    } catch {
      /* 拿不到指纹不致命，继续裸请求 */
    }
  }

  /** 是否可以写（发评论/动态）。 */
  canWrite() {
    return hasWriteCredentials(this.cookies);
  }

  /** csrf token（写操作必带）。 */
  csrf() {
    const token = this.cookies.bili_jct;
    if (typeof token !== 'string' || token === '') {
      throw new BiliError(-101, '缺少 bili_jct，无法执行写操作：先跑 bili_login（扫码）。');
    }
    return token;
  }

  /**
   * 统一请求。
   * @param url - 完整 URL 或 path（/x/...）。
   * @param options.params - 查询参数（附加在 URL 上）。
   * @param options.method - HTTP 方法，默认 GET。
   * @param options.form - application/x-www-form-urlencoded 体。
   * @param options.json - application/json 体。
   * @param options.signed - 是否需要 WBI 签名。
   * @param options.referer - Referer 覆盖。
   * @param options.skipBuvid - true 时跳过指纹获取。
   * @param options.raw - true 时返回 { body, setCookie, status } 而不抛业务错误。
   */
  async request(url, options = {}) {
    const base = url.startsWith('http') ? url : `https://api.bilibili.com${url}`;
    const parsed = new URL(base);
    for (const [name, value] of Object.entries(options.params ?? {})) {
      if (value !== undefined && value !== null) parsed.searchParams.set(name, String(value));
    }
    let target = parsed.toString();
    if (options.signed === true) {
      const keys = await this.wbiKeys();
      target = signUrl(target, keys.imgKey, keys.subKey);
    }
    const headers = {
      'User-Agent': UA,
      Referer: options.referer ?? 'https://www.bilibili.com/',
      Origin: 'https://www.bilibili.com',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Accept: 'application/json, text/plain, */*',
    };
    if (options.skipBuvid !== true) await this.ensureBuvid();
    const cookie = cookieHeader(this.cookies);
    if (cookie !== '') headers.Cookie = cookie;
    const init = { method: options.method ?? 'GET', headers };
    if (options.form !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = new URLSearchParams(options.form).toString();
    } else if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.json);
    }
    const timeout = Number(this.config?.limits?.timeoutMs ?? 20000);
    const response = await this.fetcher()(target, { ...init, signal: AbortSignal.timeout(timeout) });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new BiliError(-1, `响应不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`);
    }
    const setCookie = readSetCookie(response.headers);
    // 服务端下发的新 cookie（登录态刷新、指纹等）合并进来并交给调用方持久化
    const fresh = parseSetCookie(setCookie);
    if (Object.keys(fresh).length > 0) this.setCookies(fresh);
    if (options.raw === true) return { body, setCookie, status: response.status };
    if (body?.code !== 0) {
      const hint = CODE_HINT[String(body?.code)] ?? '';
      throw new BiliError(body?.code, `${body?.message ?? '未知错误'}${hint === '' ? '' : `（${hint}）`}`, body);
    }
    return body;
  }

  /**
   * nav：登录态 + wbi 密钥。
   * 注意：未登录时 nav 也返回 code=-101，但 data 里照样有 isLogin=false 与 wbi_img，
   * 所以这里用 raw 模式取值，不把 -101 当异常。
   */
  async nav() {
    const { body } = await this.request('/x/web-interface/nav', { raw: true });
    const data = body?.data ?? {};
    if (data.wbi_img) {
      this.wbiCache = {
        imgKey: keyFromUrl(data.wbi_img.img_url),
        subKey: keyFromUrl(data.wbi_img.sub_url),
        ts: Date.now(),
      };
    }
    return {
      isLogin: data.isLogin === true,
      uname: data.uname ?? '',
      mid: data.mid ?? null,
      code: body?.code ?? 0,
      vip: data.vipStatus ?? null,
      money: data.money ?? null,
      level: data.level_info?.current_level ?? null,
      exp: data.level_info?.current_exp ?? null,
      nextExp: data.level_info?.next_exp ?? null,
      mobileVerified: data.mobile_verified === 1,
      coins: data.coins ?? null,
    };
  }

  /** 取 WBI 密钥（缓存 6 小时）。 */
  async wbiKeys() {
    const fresh = this.wbiCache !== null && Date.now() - this.wbiCache.ts < 6 * 3600 * 1000;
    if (fresh) return this.wbiCache;
    await this.nav();
    if (this.wbiCache === null) throw new BiliError(-1, '拿不到 WBI 密钥（nav 接口异常）。');
    return this.wbiCache;
  }

  /** 首页推荐（需要 WBI；未登录可用但内容偏泛）。 */
  async rcmd(ps = 12) {
    const body = await this.request('/x/web-interface/wbi/index/top/feed/rcmd', {
      signed: true,
      referer: 'https://www.bilibili.com/',
      params: {
        web_location: '1430650',
        y_num: 5,
        fresh_type: 4,
        feed_version: 'V8',
        fresh_idx_1h: 1,
        fetch_row: 1,
        fresh_idx: 1,
        brush: 0,
        homepage_ver: 1,
        ps,
      },
    });
    const items = body?.data?.item ?? [];
    return items.map((item) => this.normalizeVideo(item));
  }

  /** 热门。 */
  async popular(ps = 12, pn = 1) {
    const body = await this.request('/x/web-interface/popular', { params: { ps, pn } });
    return (body?.data?.list ?? []).map((item) => this.normalizeVideo(item));
  }

  /** 排行榜。 */
  async ranking(rid = 0, type = 'all') {
    const body = await this.request('/x/web-interface/ranking/v2', { params: { rid, type } });
    return (body?.data?.list ?? []).map((item) => this.normalizeVideo(item));
  }

  /** 关键词搜视频。 */
  async search(keyword, page = 1) {
    const body = await this.request('/x/web-interface/wbi/search/type', {
      signed: true,
      referer: `https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword)}`,
      params: { search_type: 'video', keyword, page, page_size: 20 },
    });
    const list = body?.data?.result ?? [];
    return list.map((item) => ({
      bvid: item.bvid ?? '',
      aid: item.aid ?? item.id ?? null,
      title: stripHtml(item.title),
      author: item.author ?? '',
      mid: item.mid ?? null,
      // 搜索结果里播放量字段叫 play，时长是 "7:5" 这种不补零的字符串
      view: item.play ?? null,
      play: item.play ?? null,
      like: item.like ?? null,
      danmaku: item.video_review ?? null,
      duration: /^\d+:\d{1,2}$/.test(String(item.duration ?? ''))
        ? String(item.duration).replace(/^(\d+):(\d)$/, '$1:0$2')
        : String(item.duration ?? ''),
      pubdate: item.pubdate ?? null,
      description: stripHtml(item.description).slice(0, 160),
      tags: typeof item.tag === 'string' ? item.tag.split(',').filter((tag) => tag !== '') : [],
      url: item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : item.arcurl ?? '',
    }));
  }

  /** 把各接口的视频条目统一成一个形状。 */
  normalizeVideo(item) {
    const bvid = item.bvid ?? '';
    const aid = item.aid ?? item.id ?? item.avid ?? null;
    const owner = item.owner ?? {};
    const stat = item.stat ?? {};
    // rcmd_reason 有时是字符串，有时是 { content, reason_type } 对象
    const reasonRaw = item.rcmd_reason ?? item.reason ?? '';
    const rcmdReason =
      typeof reasonRaw === 'object' && reasonRaw !== null ? stripHtml(reasonRaw.content ?? '') : stripHtml(reasonRaw);
    return {
      bvid,
      aid: typeof aid === 'number' ? aid : Number(aid) || null,
      title: stripHtml(item.title),
      author: owner.name ?? item.author ?? '',
      mid: owner.mid ?? item.mid ?? null,
      desc: stripHtml(item.desc ?? item.description ?? '').slice(0, 200),
      duration: typeof item.duration === 'number' ? fmtDuration(item.duration) : String(item.duration ?? ''),
      pubdate: item.pubdate ?? null,
      view: stat.view ?? item.play ?? null,
      like: stat.like ?? null,
      reply: stat.reply ?? item.video_review ?? null,
      danmaku: stat.danmaku ?? null,
      tname: item.tname ?? '',
      rcmdReason,
      url: bvid === '' ? `https://www.bilibili.com/video/av${aid}` : `https://www.bilibili.com/video/${bvid}`,
    };
  }

  /** 视频详情（含分P、UP、统计）。 */
  async video(id) {
    const params = /^BV/i.test(String(id)) ? { bvid: id } : { aid: String(id).replace(/^av/i, '') };
    const body = await this.request('/x/web-interface/view', { params });
    const data = body.data ?? {};
    return {
      bvid: data.bvid,
      aid: data.aid,
      title: data.title,
      desc: data.desc ?? '',
      author: data.owner?.name ?? '',
      mid: data.owner?.mid ?? null,
      tname: data.tname ?? '',
      duration: fmtDuration(data.duration),
      pubdate: data.pubdate ?? null,
      view: data.stat?.view ?? null,
      like: data.stat?.like ?? null,
      coin: data.stat?.coin ?? null,
      favorite: data.stat?.favorite ?? null,
      reply: data.stat?.reply ?? null,
      danmaku: data.stat?.danmaku ?? null,
      pages: (data.pages ?? []).map((page) => ({ page: page.page, part: page.part, duration: fmtDuration(page.duration) })),
      url: `https://www.bilibili.com/video/${data.bvid}`,
      tags: [],
    };
  }

  /** 视频标签（用于判断该不该评论）。 */
  async tags(id) {
    const params = /^BV/i.test(String(id)) ? { bvid: id } : { aid: String(id).replace(/^av/i, '') };
    try {
      const body = await this.request('/x/tag/archive/tags', { params });
      return (body?.data ?? []).map((tag) => tag.tag_name).filter((name) => typeof name === 'string');
    } catch {
      return [];
    }
  }

  /**
   * 评论列表。
   * @param id - bvid 或 aid。
   * @param options.sort - 2=热度（默认），0=时间。
   * @param options.pn - 页码。
   * @param options.ps - 每页条数。
   * @param options.aid - 已知 aid 时直接传，省一次 view 调用。
   */
  async comments(id, options = {}) {
    const aid = options.aid ?? (await this.video(id)).aid;
    const sort = options.sort ?? 2;
    const query = async (sortMode) => this.request('/x/v2/reply', {
      referer: `https://www.bilibili.com/video/${id}`,
      params: { type: 1, oid: aid, sort: sortMode, pn: options.pn ?? 1, ps: options.ps ?? 20, nohot: sortMode === 0 ? 1 : 0 },
    });
    let body = await query(sort);
    let sortUsed = sort;
    let fallback = false;
    // 时间排序在未登录时可能被服务端拒（返回 count=0），回退热度排序
    if (sort === 0 && (body?.data?.replies ?? []).length === 0 && (body?.data?.page?.count ?? 0) === 0) {
      body = await query(2);
      sortUsed = 2;
      fallback = true;
    }
    const data = body?.data ?? {};
    const top = data.top?.upper?.rpid ? [data.top.upper] : [];
    return {
      aid,
      page: data.page ?? {},
      sortUsed,
      fallback,
      top: top.map((item) => this.normalizeComment(item, id)),
      replies: (data.replies ?? []).map((item) => this.normalizeComment(item, id)),
    };
  }

  /** 一条评论 → 精简结构（含楼中楼前几条）。 */
  normalizeComment(item, bvid) {
    return {
      rpid: item.rpid,
      root: item.root ?? 0,
      parent: item.parent ?? 0,
      mid: item.mid,
      uname: item.member?.uname ?? '',
      message: stripHtml(item.content?.message ?? ''),
      like: item.like ?? 0,
      rcount: item.rcount ?? 0,
      ctime: fmtTime(item.ctime),
      location: item.reply_control?.location ?? '',
      replies: (item.replies ?? []).slice(0, 5).map((reply) => ({
        rpid: reply.rpid,
        root: reply.root ?? 0,
        parent: reply.parent ?? 0,
        mid: reply.mid,
        uname: reply.member?.uname ?? '',
        message: stripHtml(reply.content?.message ?? ''),
        ctime: fmtTime(reply.ctime),
      })),
      url: bvid ? `https://www.bilibili.com/video/${bvid}#reply${item.rpid}` : '',
    };
  }

  /**
   * 发评论 / 回复评论。
   * @param options.aid - 视频 aid。
   * @param options.message - 正文。
   * @param options.root - 楼中楼根评论 rpid（回复时给）。
   * @param options.parent - 被回复评论的 rpid（回复时给）。
   * @param options.bvid - 仅用于 Referer。
   */
  async commentAdd({ aid, message, root, parent, bvid }) {
    const form = { type: 1, oid: String(aid), message, plat: 1, csrf: this.csrf() };
    if (root !== undefined && root !== null) form.root = String(root);
    if (parent !== undefined && parent !== null) form.parent = String(parent);
    const body = await this.request('/x/v2/reply/add', {
      method: 'POST',
      form,
      referer: `https://www.bilibili.com/video/${bvid ?? `av${aid}`}`,
    });
    return body?.data?.reply ?? body?.data ?? {};
  }

  /** 发一条文字动态。 */
  async dynamicCreate(text) {
    const payload = {
      dyn_req: {
        content: { contents: [{ raw_text: text, type: 1, biz_id: '' }] },
        scene: 1,
        attach_card: null,
        upload_id: '',
        meta: { app_meta: { from: 'create.dynamic.web', mobi_app: 'web' } },
        dyn_id_str: '',
        orig_dyn_id_str: '',
      },
    };
    const body = await this.request('/x/dynamic/feed/create/dyn', {
      method: 'POST',
      params: { platform: 'web', csrf: this.csrf() },
      json: payload,
      referer: 'https://t.bilibili.com/',
    });
    return body?.data ?? {};
  }

  /**
   * 读一条评论串（楼中楼）的全部回复。
   *
   * @param options.aid - 视频 aid。
   * @param options.root - 一级评论 rpid。
   * @param options.pn - 页码。
   * @param options.ps - 每页条数。
   * @param options.bvid - 仅用于 Referer。
   */
  async threadReplies({ aid, root, pn = 1, ps = 20, bvid }) {
    const body = await this.request('/x/v2/reply/reply', {
      referer: `https://www.bilibili.com/video/${bvid ?? `av${aid}`}`,
      params: { type: 1, oid: aid, root, pn, ps },
    });
    const data = body?.data ?? {};
    return {
      root: data.root ? this.normalizeComment(data.root, bvid) : null,
      replies: (data.replies ?? []).map((item) => this.normalizeComment(item, bvid)),
      count: data.page?.count ?? 0,
    };
  }

  /**
   * 「回复我的」消息中心（需要登录）。
   *
   * 这是发现「谁回复了小鲸鱼娘」的正规入口：B 站把别人对她的回复都汇总在这里，
   * 不用自己遍历每个视频的评论串。返回结构做得比较宽容 —— B 站这类消息接口
   * 字段位置历来会挪（item.item / item.reply 混着来），这里把能认出来的都认了，
   * 认不出来的字段留给 op=raw 排查。
   *
   * @param options.ps - 每页条数。
   * @param options.id - 翻页游标（上一页 cursor.id）。
   */
  async msgReplies({ ps = 20, id } = {}) {
    const params = { platform: 'web', build: 0, mobi_app: 'web', ps };
    if (id !== undefined && id !== null && id !== '') params.id = String(id);
    const { body } = await this.request('/x/msgfeed/reply', { params, referer: 'https://message.bilibili.com/', raw: true });
    const data = body?.data ?? {};
    return {
      code: body?.code ?? 0,
      items: (data.items ?? []).map((item) => this.normalizeMsgReply(item)),
      cursor: data.cursor ?? {},
      lastViewAt: data.last_view_at ?? null,
      raw: data,
    };
  }

  /** 消息中心一条「回复我的」→ 精简结构（字段可能藏在 item.item / item.reply 里）。 */
  normalizeMsgReply(item) {
    const inner = item?.item ?? {};
    const reply = item?.reply ?? {};
    const user = item?.user ?? {};
    const content = reply?.content ?? item?.content ?? {};
    const source = inner?.source_content ?? inner?.title ?? '';
    return {
      id: item?.id ?? reply?.rpid ?? null,
      mid: user?.mid ?? reply?.mid ?? inner?.source_id ?? null,
      uname: user?.nickname ?? user?.name ?? '',
      message: stripHtml(content?.message ?? inner?.target_reply_content ?? inner?.reply_content ?? ''),
      myMessage: stripHtml(typeof source === 'string' ? source : ''),
      subject: stripHtml(inner?.title ?? inner?.subject ?? ''),
      business: inner?.business ?? inner?.type ?? '',
      oid: reply?.oid ?? inner?.business_id ?? inner?.source_id ?? null,
      rpid: reply?.rpid ?? reply?.id ?? null,
      root: reply?.root ?? inner?.root_id ?? 0,
      parent: reply?.parent ?? null,
      ctime: fmtTime(reply?.ctime ?? item?.reply_time ?? item?.ctime ?? null),
      ts: Number(reply?.ctime ?? item?.reply_time ?? 0) * 1000 || null,
      isMulti: item?.is_multi === 1,
      raw: item,
    };
  }

  /** 生成扫码登录二维码。 */
  async qrGenerate() {
    const body = await this.request('https://passport.bilibili.com/x/passport-login/web/qrcode/generate');
    return { url: body.data.url, qrcodeKey: body.data.qrcode_key };
  }

  /** 轮询扫码结果；成功时返回服务端下发的 cookie（由调用方持久化）。 */
  async qrPoll(qrcodeKey) {
    const { body, setCookie } = await this.request('https://passport.bilibili.com/x/passport-login/web/qrcode/poll', {
      params: { qrcode_key: qrcodeKey },
      raw: true,
    });
    const data = body?.data ?? {};
    return {
      code: data.code,
      message: data.message ?? body?.message ?? '',
      url: data.url ?? '',
      cookies: parseSetCookie(setCookie),
    };
  }
}

export default BiliClient;
