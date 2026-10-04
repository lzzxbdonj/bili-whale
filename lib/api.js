/**
 * B 站 API 客户端（纯 fetch，零第三方依赖）。
 *
 * 覆盖：登录态(nav) / 首页推荐(rcmd) / 热门(popular) / 排行榜(ranking) /
 * 搜索(search) / 视频详情(view) / 评论列表(reply) / 发评论(reply/add) /
 * 发动态(dynamic create) / 扫码登录(qrcode generate+poll)。
 *
 * 所有请求共用一套浏览器化请求头；写操作走 form 或 JSON，并带 csrf=bili_jct。
 *
 * @module dsh-bilibili-whale/api
 */
import { cookieHeader, hasWriteCredentials, loadSession, parseSetCookie, saveSession } from './cookies.js';
import { keyFromUrl, md5, signUrl } from './wbi.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** B 站业务错误（code != 0）。 */
export class BiliError extends Error {
  /** @param code - B 站返回的 code。 @param message - 中文说明。 @param payload - 原始响应体。 */
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

/**
 * 把常见的 HTML 实体还原成字符。
 *
 * 存在的理由：文本常常要穿过 shell / JSON / 模板好几层，`&#180;` 这种实体
 * 会被原样送进 B 站，评论里就出现一串乱码（踩过一次）。
 */
export function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(text ?? '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-zA-Z]+);/g, (whole, name) => named[name.toLowerCase()] ?? whole);
}

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

/** 时间戳 → YYYY-MM-DD HH:mm。 */
export function fmtTime(ts) {
  if (!ts) return '';
  const date = new Date(Number(ts) * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 私信消息归一化：content 是 JSON 字符串，msg_type 1=文本、2=图片、7=撤回提示等。 */
export function normalizeDmMessage(item) {
  const raw = item ?? {};
  const type = Number(raw.msg_type ?? raw.msgType ?? 1);
  let text = '';
  const content = raw.content;
  if (typeof content === 'string' && content !== '') {
    try {
      const parsed = JSON.parse(content);
      text = typeof parsed?.content === 'string' ? parsed.content : (typeof parsed === 'string' ? parsed : '');
    } catch {
      text = content;
    }
  } else if (content !== null && typeof content === 'object') {
    text = typeof content.content === 'string' ? content.content : '';
  }
  if (text === '') {
    if (type === 2) text = '[图片]';
    else if (type === 7) text = '[撤回了一条消息]';
    else if (type === 5) text = '[语音]';
    else text = `[消息类型 ${type}]`;
  }
  return {
    msgType: type,
    text: stripHtml(text),
    timestamp: raw.timestamp ?? null,
    ts: Number(raw.timestamp ?? 0) * 1000,
    msgKey: raw.msg_key === undefined || raw.msg_key === null ? null : String(raw.msg_key),
    seqno: raw.msg_seqno ?? null,
    raw,
  };
}

/** B 站 API 客户端。 */
export class BiliClient {
  /**
   * @param options.config - 生效配置（只用 timeoutMs / ps 等）。
   * @param options.session - loadSession() 的返回值（可为 null）。
   */
  constructor({ config, session } = {}) {
    this.config = config ?? {};
    this.session = session ?? { cookies: {} };
    this.wbiCache = null;
    this.buvid = undefined;
  }

  /** 当前 cookie 记录。 */
  get cookies() {
    return this.session?.cookies ?? {};
  }

  /**
   * 保证手里有 buvid3/buvid4：B 站多数接口（搜索、推荐）靠它做设备指纹，
   * 没有就会被当成裸请求回 -101。取一次就落盘复用。
   */
  async ensureBuvid() {
    if (this.buvidReady === true) return;
    this.buvidReady = true;
    if (typeof this.cookies.buvid3 === 'string' && this.cookies.buvid3 !== '') return;
    try {
      const response = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
        headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
        signal: AbortSignal.timeout(8000),
      });
      const body = await response.json();
      const b3 = body?.data?.b_3;
      const b4 = body?.data?.b_4;
      if (typeof b3 !== 'string' || b3 === '') return;
      const disk = loadSession();
      const cookies = { ...(disk?.cookies ?? {}), ...this.cookies, buvid3: b3, buvid4: b4 };
      this.session = {
        ...(disk ?? {}),
        ...(this.session ?? {}),
        cookies,
        savedAt: new Date().toISOString(),
        user: this.session?.user ?? disk?.user ?? {},
      };
      saveSession(this.session);
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
   * @param options.raw - true 时返回 { data, setCookie } 而不抛业务错误。
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
    const response = await fetch(target, { ...init, signal: AbortSignal.timeout(timeout) });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new BiliError(-1, `响应不是 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`);
    }
    const setCookie = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
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
      /** 秒数版本（挑「学得动」的长视频时按它筛）。 */
      durationSec: Math.max(0, Math.round(Number(data.duration) || 0)),
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
   * 看某人的名片（昵称、粉丝数、是否已关注）。
   *
   * @param mid - 对方 UID。
   */
  async card(mid) {
    const body = await this.request('/x/web-interface/card', { params: { mid, photo: false } });
    const card = body?.data?.card ?? {};
    return {
      mid: card.mid ?? mid,
      name: card.name ?? '',
      fans: body?.data?.follower ?? card.fans ?? null,
      sign: card.sign ?? '',
      level: card.level_info?.current_level ?? null,
      following: body?.data?.following === true,
      url: `https://space.bilibili.com/${card.mid ?? mid}`,
    };
  }

  /** 看她与某人的关系（following=已关注，follower=对方关注她）。 */
  async relation(fid) {
    const body = await this.request('/x/relation', { params: { fid } });
    const data = body?.data ?? {};
    return { mid: data.mid ?? fid, following: data.attribute === 2 || data.attribute === 6, attribute: data.attribute ?? null, follower: data.be_followed === true };
  }

  /**
   * 关注 / 取关一个人。
   *
   * @param fid - 对方 UID。
   * @param act - 1 关注，2 取关。
   */
  async relationModify(fid, act = 1) {
    if (this.canWrite() !== true) throw new BiliError(-101, '没有写权限（缺 SESSDATA / bili_jct），先登录。');
    const body = await this.request('/x/relation/modify', {
      method: 'POST',
      form: { fid: String(fid), act: String(act), re_src: '11', csrf: this.csrf() },
      referer: `https://space.bilibili.com/${fid}`,
    });
    return { mid: fid, act, ...(body?.data ?? {}) };
  }

  /**
   * 私信会话列表（谁给她发过消息、有没有未读）。
   *
   * 走 session_svr/get_sessions：返回的 last_msg.content 是 JSON 字符串，这里已经拆好。
   */
  async dmSessions({ size = 20 } = {}) {
    const body = await this.request('https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions', {
      params: { session_type: 1, group_fold: 1, unfollow_fold: 0, sort_rule: 2, build: 0, mobi_app: 'web' },
      referer: 'https://message.bilibili.com/',
    });
    const list = body?.data?.session_list ?? [];
    return list.slice(0, size).map((item) => {
      const last = normalizeDmMessage(item.last_msg ?? {});
      const sessionTs = Number(item.session_ts ?? 0); // 微秒
      return {
        talkerId: String(item.talker_id ?? item.talkerId ?? ''),
        sessionType: item.session_type ?? 1,
        unread: Number(item.unread_count ?? 0),
        followed: item.is_follow === 1,
        lastTs: sessionTs > 0 ? Math.floor(sessionTs / 1000) : Number(item.last_msg?.timestamp ?? 0) * 1000,
        lastSenderUid: String(item.last_msg?.sender_uid ?? ''),
        lastFromMe: String(item.last_msg?.sender_uid ?? '') === String(this.cookies.DedeUserID ?? ''),
        lastText: last.text,
        lastMsgType: Number(item.last_msg?.msg_type ?? 0),
        account: item.account ?? null,
      };
    });
  }

  /**
   * 读与某人的私信记录。
   *
   * @param options.talkerId - 对方 UID。
   * @param options.size - 拉多少条（默认 20，从最新往回）。
   */
  async dmMessages({ talkerId, size = 20 } = {}) {
    const body = await this.request('https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs', {
      params: { talker_id: talkerId, session_type: 1, size, sender_device_id: '1', build: 0, mobi_app: 'web' },
      referer: 'https://message.bilibili.com/',
    });
    const messages = body?.data?.messages ?? [];
    const selfMid = String(this.cookies.DedeUserID ?? '');
    return {
      talkerId,
      messages: messages.map((item) => ({ ...normalizeDmMessage(item), fromMe: String(item.sender_uid ?? '') === selfMid })),
      minSeqno: body?.data?.min_seqno ?? null,
      maxSeqno: body?.data?.max_seqno ?? null,
    };
  }

  /**
   * 发一条私信（web_im 接口）。
   *
   * dev_id 是 web 端每次会话生成的设备号；这里按主人 UID 派生一个稳定的 UUID 形状字符串，
   * 保证同一台机器重复调用时不会每次换设备（B 站会拿它做风控）。
   *
   * @param options.receiverId - 收件人 UID。
   * @param options.content - 纯文本正文。
   */
  async sendMsg({ receiverId, content }) {
    if (this.canWrite() !== true) throw new BiliError(-101, '没有写权限（缺 SESSDATA / bili_jct），先登录。');
    const senderUid = String(this.cookies.DedeUserID ?? this.session?.user?.mid ?? '');
    if (senderUid === '') throw new BiliError(-101, '登录态里没有 DedeUserID，重新登录一次。');
    const hex = md5(String(senderUid) + 'whalemaid').slice(0, 32).split('');
    hex[12] = '4';
    hex[16] = '8';
    const devId = `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20, 32).join('')}`;
    const form = {
      'msg[sender_uid]': senderUid,
      'msg[receiver_id]': String(receiverId),
      'msg[receiver_type]': '1',
      'msg[msg_type]': '1',
      'msg[msg_status]': '0',
      'msg[content]': JSON.stringify({ content }),
      'msg[timestamp]': String(Math.floor(Date.now() / 1000)),
      'msg[dev_id]': devId.toUpperCase(),
      csrf: this.csrf(),
      csrf_token: this.csrf(),
    };
    const body = await this.request('https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', {
      method: 'POST',
      form,
      referer: 'https://message.bilibili.com/',
    });
    const data = body?.data ?? {};
    return { receiverId, msgKey: data.msg_key ?? data.msgKey ?? null, ...data };
  }

  /**
   * 列出她自己的收藏夹。
   *
   * @returns {Promise<Array<{id:number,title:string,mediaCount:number,isDefault:boolean}>>}
   */
  async favFolders() {
    const nav = await this.nav();
    const mid = nav?.mid ?? this.cookies.DedeUserID;
    if (!mid) throw new BiliError(-101, '还没登录，拿不到收藏夹（先扫码登录）。');
    const body = await this.request('https://api.bilibili.com/x/v3/fav/folder/created/list-all', {
      params: { up_mid: mid, web_location: 333.1387 },
      referer: 'https://www.bilibili.com/',
    });
    const list = body?.data?.list ?? body?.data ?? [];
    return (Array.isArray(list) ? list : []).map((item) => ({
      id: Number(item.id ?? item.fid ?? 0),
      fid: Number(item.fid ?? item.id ?? 0),
      title: String(item.title ?? ''),
      mediaCount: Number(item.media_count ?? 0),
      isDefault: Number(item.attr ?? 0) !== 0 || String(item.title ?? '').includes('默认收藏夹'),
      privacy: Number(item.privacy ?? 0),
    }));
  }

  /** 新建一个收藏夹（收藏夹名叫「小鲸鱼娘的收藏夹」时用得上）。 */
  async favFolderCreate(title) {
    if (this.canWrite() !== true) throw new BiliError(-101, '没有写权限，先登录。');
    const body = await this.request('https://api.bilibili.com/x/v3/fav/folder/add', {
      method: 'POST',
      form: { title: String(title), privacy: 0, csrf: this.csrf() },
      referer: 'https://www.bilibili.com/',
    });
    return { id: Number(body?.data?.id ?? body?.data?.fid ?? 0), title: String(title) };
  }

  /**
   * 收藏 / 取消收藏一个视频。
   *
   * @param options.aid - 视频 aid（不是 bvid）。
   * @param options.addIds - 要加入的收藏夹 id 列表。
   * @param options.delIds - 要移出的收藏夹 id 列表。
   */
  async favDeal({ aid, addIds = [], delIds = [] }) {
    if (this.canWrite() !== true) throw new BiliError(-101, '没有写权限（缺 SESSDATA / bili_jct），先登录。');
    if (addIds.length === 0 && delIds.length === 0) throw new BiliError(-400, '既没给收藏夹也没给要移出的收藏夹。');
    const body = await this.request('https://api.bilibili.com/x/v3/fav/resource/deal', {
      method: 'POST',
      form: {
        rid: String(aid),
        type: 2,
        add_media_ids: addIds.join(','),
        del_media_ids: delIds.join(','),
        csrf: this.csrf(),
      },
      referer: 'https://www.bilibili.com/',
    });
    return { aid, addIds, delIds, raw: body?.data ?? {} };
  }

  /** 读一个收藏夹里的视频列表。 */
  async favList({ mediaId, pn = 1, ps = 20 } = {}) {
    const body = await this.request('https://api.bilibili.com/x/v3/fav/resource/list', {
      params: { media_id: mediaId, pn, ps, keyword: '', order: 'mtime', type: 0, tid: 0, platform: 'web' },
      referer: `https://www.bilibili.com/medialist/detail/ml${mediaId}`,
    });
    const data = body?.data ?? {};
    const medias = Array.isArray(data.medias) ? data.medias : [];
    return {
      mediaId,
      count: Number(data.info?.media_count ?? medias.length),
      videos: medias.map((item) => ({
        aid: Number(item.id ?? 0),
        bvid: String(item.bvid ?? ''),
        title: String(item.title ?? ''),
        upName: String(item.upper?.name ?? ''),
        duration: Number(item.duration ?? 0),
        favTime: Number(item.fav_time ?? 0),
        url: item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : '',
      })),
    };
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

  /** 轮询扫码结果；成功时返回服务端下发的 cookie。 */
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
