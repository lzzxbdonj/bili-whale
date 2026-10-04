/**
 * 云端常驻（Cloudflare Worker）遥控工具：bili_cloud。
 *
 * 分工：
 *   - 云端 Worker（bili-whale）7×24 巡检：读消息中心、按策略自动回复、到点发动态、
 *     把视频一级评论做成「待确认草稿」排队；账号未转正（Lv0）时全程只读。
 *   - 本机 DSH（这个插件）负责主人这一侧：看云端状态、看队列、点头/驳回、手动触发一次巡检。
 *
 * 连接信息（任选其一）：
 *   1. 环境变量 BILI_WHALE_CLOUD_URL / BILI_WHALE_CLOUD_TOKEN
 *   2. 状态目录下的 cloud.json：{ "url": "...", "token": "..." }
 *   3. config.json 里的 cloudUrl / cloudToken（会被 cloud.json 覆盖）
 *
 * @module dsh-bilibili-whale/cloud
 */
import { readJsonFile, resolveConfig, statePath } from './config.js';

const looseSchema = { type: 'object', additionalProperties: true };

function compileParameters(spec) {
  const properties = {};
  const required = [];
  for (const [key, prop] of Object.entries(spec)) {
    if (prop?.required === true) required.push(key);
    const node = {};
    if (typeof prop?.type === 'string') node.type = prop.type;
    if (typeof prop?.description === 'string') node.description = prop.description;
    properties[key] = node;
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}

function asRecord(value) {
  return typeof value === 'object' && value !== null ? value : {};
}

/** 解析云端连接信息；缺 url 或 token 时返回 {ok:false, reason} 让工具如实汇报。 */
export function resolveCloud(pluginConfig) {
  let cfg = {};
  try {
    cfg = resolveConfig(pluginConfig);
  } catch {
    cfg = {};
  }
  let file = {};
  try {
    file = asRecord(readJsonFile(statePath('cloud.json'), {}));
  } catch {
    file = {};
  }
  const url = String(file.url ?? cfg.cloudUrl ?? process.env.BILI_WHALE_CLOUD_URL ?? '').trim().replace(/\/+$/, '');
  const token = String(file.token ?? cfg.cloudToken ?? process.env.BILI_WHALE_CLOUD_TOKEN ?? '').trim();
  if (url === '') return { ok: false, reason: '还没配置云端地址：请在 config.json 里写 cloudUrl，或建 cloud.json {url, token}。' };
  if (token === '') return { ok: false, reason: '还没配置云端令牌：请在 config.json 里写 cloudToken，或建 cloud.json {url, token}。' };
  return { ok: true, url, token };
}

/** 统一的云端请求（超时 30s，出错抛出带可读文案的 Error）。 */
export async function cloudRequest(cloud, path, { method = 'GET', body = null, timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${cloud.url}${path}`, {
      method,
      headers: {
        'x-whale-token': cloud.token,
        ...(body === null ? {} : { 'content-type': 'application/json' }),
      },
      body: body === null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 2000) };
    }
    if (response.ok !== true) {
      const detail = json?.error ?? json?.message ?? text.slice(0, 200);
      throw new Error(`云端返回 ${response.status}：${detail}`);
    }
    return json;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`云端请求超时（${path}）`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function renderCloud(value) {
  const rec = asRecord(value);
  if (typeof rec.text === 'string' && rec.text !== '') return [{ type: 'text', text: rec.text }];
  return [{ type: 'text', text: JSON.stringify(value, null, 2).slice(0, 20000) }];
}

/** 把云端 /status 的返回排成人话。 */
function statusText(s) {
  const lines = ['小鲸鱼娘 · 云端状态（Cloudflare Worker）'];
  lines.push(`- 云端版本：${s.version ?? '未知'}；巡检：${s.patrol ?? '未知'}`);
  lines.push(`- 最近巡检：${s.lastPatrolAt ?? '还没跑过'}`);
  lines.push(`- 登录：${s.loggedIn === true ? `已登录 ${s.uname ?? ''}（UID ${s.mid ?? '?'}）` : '未登录（云端没有可用 cookie）'}`);
  if (s.level !== undefined) lines.push(`- 等级：${s.levelText ?? `Lv${s.level}`}`);
  lines.push(`- 观察模式：${s.observeOnly === true ? '开（只读 + 排队，不发写请求）' : '关（按策略真发）'}`);
  lines.push(`- 待确认草稿：${s.pendingCount ?? 0} 条`);
  const today = asRecord(s.today);
  lines.push(`- 今日：评论 ${today.comments ?? 0}，回复 ${today.replies ?? 0}，动态 ${today.dynamics ?? 0}`);
  lines.push(`- 今天的动态：${s.dynamicPostedToday === true ? '已发' : '未发'}`);
  return lines.join('\n');
}

function pendingText(payload) {
  const items = Array.isArray(payload?.pending) ? payload.pending : [];
  if (items.length === 0) return '云端待确认草稿：0 条。小鲸鱼娘还没攒到想留言的视频～';
  const lines = [`云端待确认草稿：${items.length} 条`];
  items.forEach((item, index) => {
    lines.push('');
    lines.push(`${index + 1}. [${item.id}] 《${item.title ?? '未知视频'}》 UP：${item.upName ?? '?'}`);
    lines.push(`   BV：${item.bvid ?? '?'}　链接：https://www.bilibili.com/video/${item.bvid ?? ''}`);
    lines.push(`   草稿：${item.message ?? ''}`);
    lines.push(`   攒于：${item.createdAt ?? '?'}`);
  });
  lines.push('');
  lines.push('要让小鲸鱼娘发出去：bili_cloud op=approve id=<上面的方括号 id>；不想发就 op=reject。');
  return lines.join('\n');
}

function inboxText(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (items.length === 0) return `云端消息中心：没有需要她回的评论（共 ${payload?.total ?? 0} 条）。`;
  const lines = [`云端待回复：${items.length} 条（消息中心共 ${payload?.total ?? 0} 条）`];
  items.forEach((item, index) => {
    lines.push('');
    lines.push(`${index + 1}. ${item.isOwner === true ? '★主人' : '客人'} ${item.uname ?? '?'}（UID ${item.mid ?? '?'}）`);
    lines.push(`   BV：${item.bvid ?? '?'}　说的是：${String(item.message ?? '').slice(0, 120)}`);
    lines.push(`   状态：${item.answered === true ? '已回过' : '待回复'}${item.autoReplied === true ? '（云端已自动回）' : ''}`);
  });
  return lines.join('\n');
}

export function buildCloudTools({ pluginConfig = {} } = {}) {
  const def = {
    name: 'bili_cloud',
    description: [
      '小鲸鱼娘的**云端常驻**（Cloudflare Worker）遥控台：她 7×24 在云端刷 B 站，本工具用来查看与点头。',
      'op=status 云端状态（登录/等级/观察模式/今日配额/待确认数）；',
      'op=inbox 看云端消息中心里待回复的评论（★主人优先）；',
      'op=pending 看云端排队的视频评论草稿；op=approve id=… 让云端把某条草稿发出去；op=reject id=… 丢掉；',
      'op=patrol 立刻让云端跑一次巡检；op=log 看云端最近做过什么；op=config 看/改云端配置；',
      'op=feed 看云端视角的推荐/搜索（排查用）。',
      '注意：视频一级评论默认 confirm —— 云端只会攒草稿，必须主人点头（approve）才发。',
    ].join(' '),
    parameters: compileParameters({
      op: {
        type: 'string',
        required: true,
        description: 'status | inbox | pending | approve | reject | patrol | log | config | feed | dynamic',
      },
      id: { type: 'string', description: 'op=approve/reject 时的草稿 id' },
      text: { type: 'string', description: 'op=dynamic 时想发的动态正文；op=config 时配合 key/value 用' },
      key: { type: 'string', description: 'op=config 时要改的键（如 observeOnly）' },
      value: { type: 'string', description: 'op=config 时的新值（布尔写 true/false，数字写数字）' },
      kind: { type: 'string', description: 'op=feed 时：popular | ranking | search' },
      q: { type: 'string', description: 'op=feed kind=search 时的关键词' },
      limit: { type: 'number', description: '条数上限（默认 10）' },
    }),
    output: { schema: looseSchema, render: (_args, value) => renderCloud(value) },
    timeoutMs: 60000,
    async execute(args) {
      const op = String(args?.op ?? '').trim();
      const cloud = resolveCloud(pluginConfig);
      if (cloud.ok !== true) {
        return { text: `云端还没接上：${cloud.reason}` };
      }
      const limit = Number.isFinite(args?.limit) ? Number(args.limit) : 10;
      try {
        if (op === 'status') {
          const s = await cloudRequest(cloud, '/status');
          return { text: statusText(asRecord(s)) };
        }
        if (op === 'inbox') {
          const payload = await cloudRequest(cloud, `/inbox?limit=${limit}`);
          return { text: inboxText(asRecord(payload)) };
        }
        if (op === 'pending') {
          const payload = await cloudRequest(cloud, '/pending');
          return { text: pendingText(asRecord(payload)) };
        }
        if (op === 'approve') {
          if (typeof args?.id !== 'string' || args.id.trim() === '') throw new Error('op=approve 需要 id（先用 op=pending 看）。');
          const result = await cloudRequest(cloud, '/approve', { method: 'POST', body: { id: args.id.trim() } });
          return { text: result?.ok === true ? `云端已发出这条评论：${result.message ?? ''}` : `没发出去：${result?.error ?? JSON.stringify(result)}` };
        }
        if (op === 'reject') {
          if (typeof args?.id !== 'string' || args.id.trim() === '') throw new Error('op=reject 需要 id。');
          const result = await cloudRequest(cloud, '/reject', { method: 'POST', body: { id: args.id.trim() } });
          return { text: `已丢弃草稿 ${args.id.trim()}（${result?.ok === true ? 'ok' : '未找到'}）` };
        }
        if (op === 'patrol') {
          const result = await cloudRequest(cloud, '/patrol', { method: 'POST', body: { trigger: 'manual' } });
          return { text: `云端巡检完成：\n${JSON.stringify(result, null, 2).slice(0, 4000)}` };
        }
        if (op === 'log') {
          const result = await cloudRequest(cloud, '/log');
          const lines = Array.isArray(result?.log) ? result.log : [];
          return { text: lines.length === 0 ? '云端还没有日志。' : `云端最近日志：\n${lines.slice(-limit).join('\n')}` };
        }
        if (op === 'config') {
          if (typeof args?.key === 'string' && args.key.trim() !== '') {
            let value = args?.value;
            if (typeof value === 'string') {
              if (value === 'true' || value === 'false') value = value === 'true';
              else if (/^-?\d+(\.\d+)?$/.test(value)) value = Number(value);
            }
            const result = await cloudRequest(cloud, '/config', { method: 'POST', body: { [args.key.trim()]: value } });
            return { text: `云端配置已更新：${JSON.stringify(result?.config ?? result, null, 2).slice(0, 4000)}` };
          }
          const result = await cloudRequest(cloud, '/config');
          return { text: `云端配置：\n${JSON.stringify(result?.config ?? result, null, 2).slice(0, 6000)}` };
        }
        if (op === 'feed') {
          const kind = String(args?.kind ?? 'popular').trim();
          const q = typeof args?.q === 'string' ? encodeURIComponent(args.q.trim()) : '';
          const payload = await cloudRequest(cloud, `/feed?kind=${kind}${q === '' ? '' : `&q=${q}`}&limit=${limit}`);
          const items = Array.isArray(payload?.items) ? payload.items : [];
          if (items.length === 0) return { text: `云端 ${kind} 没有结果。` };
          const lines = [`云端 ${kind}：${items.length} 条`];
          items.forEach((item, index) => {
            lines.push(`${index + 1}. 《${item.title ?? '?'}》 UP：${item.owner?.name ?? '?'}　${item.bvid ?? ''}　播放 ${item.view ?? item.play ?? '?'}`);
          });
          return { text: lines.join('\n') };
        }
        if (op === 'dynamic') {
          const result = await cloudRequest(cloud, '/dynamic', { method: 'POST', body: { text: args?.text ?? '', force: true } });
          return { text: result?.posted === true ? `云端已发动态：${result.text}` : `没发出去：${JSON.stringify(result).slice(0, 800)}` };
        }
        throw new Error(`未知 op：${op}（可用：status / inbox / pending / approve / reject / patrol / log / config / feed / dynamic）`);
      } catch (error) {
        return { text: `云端调用失败：${error.message}` };
      }
    },
  };
  return [def];
}
