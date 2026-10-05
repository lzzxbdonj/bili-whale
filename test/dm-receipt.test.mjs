/**
 * 私信回执：**宁短不可丢**（2026-10-05 主人「为什么刷完视频还没有给我回私信」）。
 *
 * 那次事故有两个原因：
 *   1. `lib/policy.js` 的 `checkDmReply` 借用了评论的 `maxCommentChars`（200）卡私信，
 *      而「刷了 3 条…」那种回执天然 266 字 ⇒ **整条不发**，动作做了主人却收不到；
 *   2. `lib/tools.js` 里用了 `clipText` 却没有 import ⇒ 回执这条路一跑就
 *      `ReferenceError: clipText is not defined`（看门鲸 13:10:30 的真机日志）。
 *
 * 第 2 条之所以能溜进主干，是因为**没有任何测试跑过 `tools.js` 里的私信回执路径**。
 * 所以这个文件用**假客户端**（`buildBiliTools({ client })` 注入）把整条路径跑起来：
 * 认命令 → `runDmCommand` → 裁短 → 过闸门 → 真 `sendMsg` → 记账本。
 */
import { strict as assert } from 'node:assert';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 临时 HOME：这条路径会写账本/日志，绝不能碰真家目录（2026-10-05 的测试污染教训）。
const HOME = join(tmpdir(), `dsh-dm-receipt-${Date.now()}`);
process.env.DSH_HOME = HOME;
mkdirSync(join(HOME, 'bilibili-whale', 'logs'), { recursive: true });

const { buildBiliTools } = await import('../lib/tools.js');
const { readJsonFile, statePath } = await import('../lib/config.js');
const { dmTextLimit } = await import('../lib/policy.js');

const OWNER_MID = 3494364865103885;

/** 假客户端：只实现私信巡检那条路真正会碰到的几个接口。 */
function fakeOwnerClient({ titles = [], text = '/搜 拉康精神分析' } = {}) {
  const sent = [];
  return {
    sent,
    client: {
      async dmSessions() {
        return [{
          talkerId: OWNER_MID,
          account: '懒寻真',
          lastMsgType: 1,
          lastFromMe: false,
          lastTs: Date.now(),
          lastText: text,
          unread: 1,
        }];
      },
      async card() {
        return { name: '懒寻真' };
      },
      async search() {
        return titles.map((title, index) => ({
          bvid: `BVfake${String(index).padStart(6, '0')}`,
          title,
          author: `UP主${index + 1}`,
          view: 100000 * (index + 1),
          duration: '10:00',
        }));
      },
      async sendMsg({ receiverId, content }) {
        sent.push({ receiverId, content });
        return { msgKey: `msgkey-${sent.length}` };
      },
    },
  };
}

function config(extra = {}) {
  return {
    ownerMid: String(OWNER_MID),
    ownerName: '懒寻真',
    brain: { enabled: false },
    policy: { allowDm: true, postReply: 'auto', dmCommands: true, minIntervalSecondsOwner: 0 },
    ...extra,
  };
}

async function runAck({ titles, cfg }) {
  const fake = fakeOwnerClient({ titles });
  const tools = buildBiliTools({ pluginConfig: cfg, client: fake.client, openBrowser: async () => {} });
  const dm = tools.find((tool) => tool.name === 'bili_dm');
  assert.ok(dm !== undefined, 'bili_dm 工具要建得出来');
  const result = await dm.execute({ op: 'ack', size: 20 }, {});
  return { result, sent: fake.sent };
}

// 长标题 ⇒ 回执天然远超评论的 200 字上限（旧代码在这个位置整条丢掉）。
const LONG = Array.from({ length: 3 }, (_, i) => `第${i + 1}个超长标题${'（很长的尾巴）'.repeat(20)}`);

// ① 超过 200 字的回执必须真发出去，而且压在私信上限内
{
  const { result, sent } = await runAck({ titles: LONG, cfg: config() });
  assert.equal(result.acked, 1, `回执要算「回」了一条（备注：${JSON.stringify(result.notes)}）`);
  assert.equal(sent.length, 1, '回执必须真的 sendMsg —— 「发不出去」就是这次事故');
  const text = sent[0].content;
  assert.equal(sent[0].receiverId, OWNER_MID);
  assert.ok(text.length > 200, `这轮回执本来就超过评论上限（实际 ${text.length} 字）`);
  assert.ok(text.length <= dmTextLimit(config()), `回执要压进私信上限（实际 ${text.length} 字）`);
  assert.ok(text.includes('拉康精神分析'), '裁短不能把正文全裁没');
  assert.ok(
    (result.notes ?? []).every((note) => note.includes('没发出去') === false),
    `不该出现「回执没发出去」（实际：${JSON.stringify(result.notes)}）`,
  );
  const ledger = readJsonFile(statePath('ledger.json'), null);
  assert.ok(Array.isArray(ledger?.dms) && ledger.dms.some((row) => row.text === text), '发出去的回执要记账本');
}

// ② 主人把上限调得很小时：照样发得出去（裁得更短而已），绝不静默丢弃
{
  const cfg = config({ policy: { ...config().policy, maxDmChars: 60 } });
  const { result, sent } = await runAck({ titles: LONG, cfg });
  assert.equal(sent.length, 1, '上限再小也要发出去');
  assert.ok(sent[0].content.length <= 60, `要压到 60 字内（实际 ${sent[0].content.length} 字）`);
  assert.equal(result.acked, 1);
}

// ③ 没配 `maxDmChars` 时退回评论上限（老配置的行为不变），配了就用它
{
  assert.equal(dmTextLimit({ policy: { maxCommentChars: 200 } }), 200, '没配 maxDmChars 就退回 maxCommentChars');
  assert.equal(dmTextLimit({ policy: { maxCommentChars: 200, maxDmChars: 500 } }), 500, '配了就用 maxDmChars');
  assert.equal(dmTextLimit({ policy: {} }), 500, '两样都没配才兜底 500');
}

console.log('✓ 私信回执测试通过：长回执裁短后真发出去（不再被评论上限整条拦掉）');
