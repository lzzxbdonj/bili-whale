#!/usr/bin/env node
/**
 * dsh-bilibili-whale 命令行：不启动 DSH 也能验证/手动使用同一套工具。
 *
 * 用法（在包根目录）：
 *   node lib/cli.mjs status
 *   node lib/cli.mjs feed --source popular --count 5
 *   node lib/cli.mjs search DeepSeek --count 5
 *   node lib/cli.mjs video BV1xx --comments 5
 *   node lib/cli.mjs comments BV1xx --count 10
 *   node lib/cli.mjs login-start
 *   node lib/cli.mjs login-poll
 *   node lib/cli.mjs comment BV1xx "正文" --confirm
 *   node lib/cli.mjs reply BV1xx 12345 "正文" --confirm --uname 懒寻真
 *   node lib/cli.mjs dynamic --text "..." --confirm
 *   node lib/cli.mjs daily
 *   node lib/cli.mjs ledger list
 *   node lib/cli.mjs follow check --mid 391581639
 *   node lib/cli.mjs follow follow --mid 391581639
 *   node lib/cli.mjs dm --mid 391581639 "正文" --confirm
 *   node lib/cli.mjs dm list          # 会话列表（谁找过她、有没有未读）
 *   node lib/cli.mjs dm read <mid>    # 读会话来往消息
 *   node lib/cli.mjs dm reply <mid> "正文" --confirm   # 回一条
 *   node lib/cli.mjs dm ack           # 给未读会话自动寒暄一轮
 *   node lib/cli.mjs study plan       # 看她今天打算学什么（只挑不写）
 *   node lib/cli.mjs study learn      # 立刻自己学一轮（挑片 → 记笔记 → 有意义就留言）
 *   node lib/cli.mjs study today      # 看今天学到了什么
 *   node lib/cli.mjs study dynamic --confirm   # 发今天的「学习动态」
 *   node lib/cli.mjs config get
 *
 * 任何子命令都接受 --json 打印原始结果（便于脚本消费）。
 *
 * @module dsh-bilibili-whale/cli
 */
import { buildBiliTools } from './tools.js';
import { openBrowser, runDailyDynamic } from './index.js';

/** 极简参数解析：--k v / --flag。 */
function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}

const { flags, positional } = parseFlags(process.argv.slice(2));
const command = positional[0] ?? 'status';
const json = flags.json === true;

/** 找到同名工具。 */
function tool(name) {
  const found = buildBiliTools({ pluginConfig: {}, openBrowser }).find((item) => item.name === name);
  if (found === undefined) throw new Error(`没有这个工具：${name}`);
  return found;
}

/** 打印工具的渲染结果（或原始 JSON）。 */
async function runTool(name, args) {
  const definition = tool(name);
  const value = await definition.execute(args, {});
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return value;
  }
  const parts = definition.output.render(args, value);
  for (const part of parts) {
    if (part.type === 'text') console.log(part.text);
  }
  return value;
}

/** 主流程。 */
async function main() {
  switch (command) {
    case 'status':
      await runTool('bili_status', {});
      return;
    case 'feed':
      await runTool('bili_feed', {
        source: typeof flags.source === 'string' ? flags.source : undefined,
        keyword: typeof flags.keyword === 'string' ? flags.keyword : positional[1],
        count: flags.count === undefined ? 5 : Number(flags.count),
      });
      return;
    case 'search':
      await runTool('bili_feed', { source: 'search', keyword: positional.slice(1).join(' ') || flags.keyword, count: flags.count === undefined ? 5 : Number(flags.count) });
      return;
    case 'video':
      await runTool('bili_video', { id: positional[1], comments: flags.comments === undefined ? 0 : Number(flags.comments) });
      return;
    case 'comments':
      await runTool('bili_comments', {
        id: positional[1],
        sort: flags.sort === undefined ? 2 : Number(flags.sort),
        count: flags.count === undefined ? 10 : Number(flags.count),
        page: flags.page === undefined ? 1 : Number(flags.page),
      });
      return;
    case 'login-start':
      await runTool('bili_login', { op: 'start', open: flags.open !== false });
      return;
    case 'login-poll':
      await runTool('bili_login', { op: 'poll', qrcodeKey: typeof flags.key === 'string' ? flags.key : undefined });
      return;
    case 'login-status':
      await runTool('bili_login', { op: 'status' });
      return;
    case 'logout':
      await runTool('bili_login', { op: 'logout' });
      return;
    case 'comment':
      await runTool('bili_comment', { id: positional[1], message: positional.slice(2).join(' '), confirm: flags.confirm === true });
      return;
    case 'reply':
      await runTool('bili_reply', {
        id: positional[1],
        rpid: Number(positional[2]),
        message: positional.slice(3).join(' '),
        root: flags.root === undefined ? undefined : Number(flags.root),
        uname: typeof flags.uname === 'string' ? flags.uname : undefined,
        mid: flags.mid === undefined ? undefined : Number(flags.mid),
        confirm: flags.confirm === true,
      });
      return;
    case 'inbox':
      await runTool('bili_inbox', {
        op: typeof flags.op === 'string' ? flags.op : 'check',
        count: flags.count === undefined ? 10 : Number(flags.count),
        includeAnswered: flags.answered === true,
      });
      return;
    case 'thread':
      await runTool('bili_inbox', { op: 'thread', id: positional[1], root: Number(positional[2]) });
      return;
    case 'dynamic':
      await runTool('bili_dynamic', {
        text: typeof flags.text === 'string' ? flags.text : positional.slice(1).join(' ') || undefined,
        confirm: flags.confirm === true,
        auto: flags.auto === true,
      });
      return;
    case 'daily': {
      const result = await runDailyDynamic({}, { force: flags.force === true });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case 'ledger':
      await runTool('bili_ledger', { op: positional[1] ?? 'today', count: flags.count === undefined ? 10 : Number(flags.count), text: typeof flags.text === 'string' ? flags.text : undefined, bvid: typeof flags.bvid === 'string' ? flags.bvid : undefined });
      return;
    case 'follow': {
      const ops = ['follow', 'unfollow', 'check'];
      const first = positional[1];
      const op = typeof flags.op === 'string' ? flags.op : (ops.includes(first) ? first : 'check');
      const mid = flags.mid !== undefined ? String(flags.mid) : (first !== undefined && !ops.includes(first) ? first : undefined);
      await runTool('bili_follow', { op, mid, name: typeof flags.name === 'string' ? flags.name : undefined });
      return;
    }
    case 'dm': {
      const ops = ['list', 'read', 'reply', 'ack', 'send', 'draft', 'check'];
      const first = positional[1];
      const op = typeof flags.op === 'string' ? flags.op : (ops.includes(first) ? first : (flags.confirm === true ? 'send' : 'draft'));
      const rest = ops.includes(first) ? positional.slice(2) : positional.slice(1);
      const mid = flags.mid !== undefined ? String(flags.mid) : (rest[0] !== undefined && /^\d+$/.test(rest[0]) ? rest[0] : undefined);
      const words = flags.text !== undefined ? [String(flags.text)] : rest.filter((part) => part !== mid);
      await runTool('bili_dm', {
        op,
        mid,
        text: words.join(' ') || undefined,
        confirm: flags.confirm === true,
        size: flags.size !== undefined ? Number(flags.size) : undefined,
      });
      return;
    }
    case 'favorite':
    case 'fav': {
      const ops = ['add', 'remove', 'folders', 'create', 'list', 'check'];
      const first = positional[1];
      const op = typeof flags.op === 'string' ? flags.op : (ops.includes(first) ? first : (flags.title !== undefined ? 'create' : (flags.mediaId !== undefined ? 'list' : 'folders')));
      const rest = ops.includes(first) ? positional.slice(2) : positional.slice(1);
      const id = flags.id !== undefined ? String(flags.id) : (first !== undefined && !ops.includes(first) ? first : (rest[0] !== undefined ? rest[0] : undefined));
      await runTool('bili_favorite', {
        op,
        id,
        folderId: flags.folderId !== undefined ? String(flags.folderId) : (flags['folder-id'] !== undefined ? String(flags['folder-id']) : undefined),
        mediaId: flags.mediaId !== undefined ? String(flags.mediaId) : (flags['media-id'] !== undefined ? String(flags['media-id']) : undefined),
        title: typeof flags.title === 'string' ? flags.title : undefined,
        confirm: flags.confirm === true,
      });
      return;
    }
    case 'study':
    case 'learn': {
      const ops = ['plan', 'learn', 'today', 'topic', 'dynamic'];
      const first = positional[1];
      const op = typeof flags.op === 'string' ? flags.op : (ops.includes(first) ? first : (command === 'learn' ? 'learn' : 'plan'));
      const rest = ops.includes(first) ? positional.slice(2) : positional.slice(1);
      await runTool('bili_study', {
        op,
        topic: flags.topic !== undefined ? String(flags.topic) : (rest[0] !== undefined && op !== 'dynamic' ? rest[0] : undefined),
        count: flags.count !== undefined ? Number(flags.count) : undefined,
        text: typeof flags.text === 'string' ? flags.text : undefined,
        confirm: flags.confirm === true,
      });
      return;
    }
    case 'config': {
      const op = positional[1] ?? 'get';
      await runTool('bili_config', { op, patch: op === 'set' ? positional.slice(2).join(' ') : undefined });
      return;
    }
    default:
      console.log(`未知命令：${command}\n可用：status feed search video comments login-start login-poll login-status logout comment reply inbox thread dynamic daily ledger follow dm favorite study config`);
      process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(`✗ ${error.name ?? 'Error'}: ${error.message}`);
  process.exitCode = 1;
});
