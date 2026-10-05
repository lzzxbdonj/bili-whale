/**
 * 「评论回复」这条链路的契约测试（2026-10-05 主人：「完善一下评论回复」）。
 *
 * 原来这条链路有四个洞，这里逐条钉住：
 *   1. 提示词里没有她自己的原话 / 楼上对话 / 对方是主人还是陌生人 → `buildReplyPrompt`；
 *   2. 只回主人、一轮只回一条、动态下的评论发不出去 → `pickReplyTargets` + `runInboxReplies`；
 *   3. 回复不该每条都挂 @（主人 2026-10-05：「评论不要每一条回复都带上 @」）→ 默认不补尾巴；
 *   4. **回主人走付费脑子**（主人 2026-10-05：「走 GitHub Actions 回主人信息是不是走的付费
 *      模型，是可行的」→ 给了钥匙就开）：`context.isOwner === true` 时 `prefer = 'paid'`，
 *      陌生人仍然 `''`（纯免费）。这一条先前是反的（「统一用免费模型处理」），主人后来改回来了；
 *   5. 同一条评论只回一次，**主人也不例外**（2026-10-05 真机：同一 rpid 被追着回了两遍）→ `repliedToComment`。
 *
 * 脑子（模型）不联网：`composeCommentReply` 支持注入 `ask`，这里塞一个假模型。
 *
 * 用法：node test/reply.test.mjs
 */
import { strict as assert } from 'node:assert';
import { BiliClient } from '../lib/api.js';
import { buildReplyPrompt, composeCommentReply } from '../lib/compose.js';
import { pickReplyTargets, replyLimits, runInboxReplies } from '../lib/reply.js';
import { emptyLedger, recordReply, repliedToComment } from '../lib/ledger.js';
import { checkReply } from '../lib/policy.js';

const CFG = {
  ownerName: '懒寻真',
  ownerMid: 3494364865103885,
  ownerNames: ['懒寻真', '金易木木元'],
  ownerMids: [3494364865103885, 391581639],
  whaleMid: 3747560556595480,
  policy: {
    postReply: 'auto',
    replyScope: 'anyone',
    replyPerUserPerThread: 1,
    replyPerUserWindowHours: 24,
    dailyReplies: 10,
    minIntervalSeconds: 120,
    minIntervalSecondsOwner: 15,
    maxCommentChars: 200,
    blockKeywords: ['加群', '微信'],
  },
};
const OWNER = 3494364865103885;
const STRANGER = 1234567;
const now = Date.now();

function target(over = {}) {
  return {
    mid: STRANGER,
    uname: '路人甲',
    message: '这个想法有意思，能展开说说吗',
    rpid: 9001,
    replyRoot: 9000,
    oid: 936177870,
    bvid: 'BV16T4y1k7dB',
    subject: '如何炼成超强学习能力？',
    myMessage: '人家觉得这个方法很适合边学边用～',
    business: 'reply',
    owner: false,
    answered: false,
    ts: now - 60_000,
    ...over,
  };
}

// ── 1. 提示词：喂进去的上下文决定回复接不接得住话 ────────────────────────────
{
  const video = {
    title: '如何炼成超强学习能力？为什么有的人学得又快又好？',
    author: '硬核学长2077',
    tags: ['学习', '效率', '方法论'],
    desc: '讲了检索式练习、间隔重复、交错练习三种方法。',
  };
  const ownerPrompt = buildReplyPrompt({
    cfg: CFG,
    video,
    comment: { uname: '懒寻真', mid: OWNER, message: '那你自己平时怎么复习呀' },
    context: {
      isOwner: true,
      selfText: '人家把笔记都塞进知识库了～',
      thread: [
        { uname: '懒寻真', message: '那你自己平时怎么复习呀' },
      ],
      recentReplies: ['这条人家也刷到过，讲得清楚～'],
    },
  });
  assert.match(ownerPrompt.system, /对方是\*\*主人\*\*/u, '主人要认出来');
  assert.match(ownerPrompt.system, /回复不用 @ 主人/u, '主人版的回复不自动 @（主人 2026-10-05 的要求）');
  assert.match(ownerPrompt.user, /硬核学长2077/u, 'UP 名要喂进去');
  assert.match(ownerPrompt.user, /检索式练习/u, '简介要喂进去（否则回复只能空谈）');
  assert.match(ownerPrompt.user, /人家把笔记都塞进知识库了/u, '她自己那条原话要喂进去');
  assert.match(ownerPrompt.user, /← 对方最新这句/u, '楼上最新一句要标出来');
  assert.match(ownerPrompt.user, /别重复这些/u, '最近回过的话要当防复读材料');
  assert.equal(ownerPrompt.maxChars, 200);

  const strangerPrompt = buildReplyPrompt({
    cfg: CFG,
    video,
    comment: { uname: '路人甲', mid: STRANGER, message: '加个微信聊聊？' },
    context: { isOwner: false, kind: 'dynamic', subject: '今天也在认真学习呢' },
  });
  assert.match(strangerPrompt.system, /对方是\*\*陌生人\*\*/u, '陌生人要认出来');
  assert.match(strangerPrompt.system, /不要透露主人的任何信息/u, '陌生人版必须有不泄露主人的规矩');
  assert.match(strangerPrompt.system, /不要 @ 主人/u, '别把主人拖进陌生人的评论串');
  assert.match(strangerPrompt.user, /动态信息/u, '动态评论要按动态讲，不是视频');
  assert.doesNotMatch(strangerPrompt.user, /UP：/u, '动态没有 UP 行');
}

// ── 2. 回复不加 @（主人 2026-10-05 的要求）、统一用免费模型 ────────────────────
{
  const asked = [];
  const long = '人'.repeat(300);
  const text = await composeCommentReply({
    cfg: CFG,
    video: { title: 'x' },
    comment: { uname: '懒寻真', mid: OWNER, message: '在吗' },
    context: { isOwner: true },
    ask: async (cfg, { system, prefer }) => {
      asked.push({ system, prefer });
      return long;
    },
  });
  assert.ok(text.length <= 200, `主人回复不能超过 200 字，实际 ${text.length}`);
  assert.doesNotMatch(text, /@/u, '默认回复不带 @（主人说了：回复评论不用 @）');
  assert.equal(asked[0].prefer, 'paid', '回主人点付费脑子（brain.paid）');

  // 想恢复老样子：policy.mentionOwnersOnReply = true 时才补尾巴。
  const tailed = await composeCommentReply({
    cfg: { ...CFG, policy: { ...CFG.policy, mentionOwnersOnReply: true } },
    video: { title: 'x' },
    comment: { uname: '懒寻真', mid: OWNER, message: '在吗' },
    context: { isOwner: true },
    ask: async () => long,
  });
  assert.match(tailed, /@懒寻真 @金易木木元$/u, '打了开关才补两位主人的 @');
  assert.ok(tailed.length <= 200, '补完 @ 也不能超字数');

  const strangerText = await composeCommentReply({
    cfg: CFG,
    video: { title: 'x' },
    comment: { uname: '路人甲', mid: STRANGER, message: '在吗' },
    context: { isOwner: false },
    ask: async (cfg, { prefer }) => {
      asked.push({ system: '', prefer });
      return '人家只是路过看看～';
    },
  });
  assert.equal(strangerText, '人家只是路过看看～', '陌生人回复不加主人 @');
  assert.doesNotMatch(strangerText, /@/u, '陌生人回复里不该出现 @');
  assert.equal(asked[1].prefer, '', '回陌生人继续免费');

  const nulled = await composeCommentReply({
    cfg: CFG,
    video: { title: 'x' },
    comment: { uname: '路人甲', mid: STRANGER, message: '在吗' },
    context: {},
    ask: async () => null,
  });
  assert.equal(nulled, null, '模型不可用时返回 null（宁可不发，也别发模板垃圾话）');
  assert.equal(asked.length, 2, '主人那条 + 陌生人那条各问一次');

  // 免费脑子会抽风（实测云端 502 / pollinations 500）：第一次没答上来要再问一次。
  let tries = 0;
  const retried = await composeCommentReply({
    cfg: CFG,
    video: { title: 'x' },
    comment: { uname: '路人甲', mid: STRANGER, message: '在吗' },
    context: {},
    ask: async () => {
      tries += 1;
      return tries === 1 ? null : '人家在的在的～';
    },
  });
  assert.equal(retried, '人家在的在的～', '脑子打嗝一次，重问一次就该答上来');
  assert.equal(tries, 2, '失败后只重问一次，不做无限重试');

  // 一直答不上来就还是 null（不能让重试变成死循环）。
  let always = 0;
  assert.equal(
    await composeCommentReply({
      cfg: CFG,
      video: { title: 'x' },
      comment: { uname: '路人甲', mid: STRANGER, message: '在吗' },
      context: {},
      ask: async () => {
        always += 1;
        return null;
      },
    }),
    null,
  );
  assert.equal(always, 2, '最多问两次');
}

// ── 3. 挑人：主人优先、去重、已回过的不再回、认不出的跳过 ─────────────────────
{
  const limits = replyLimits(CFG);
  assert.deepEqual(limits, { perRun: 3, perRunOthers: 1, toOthers: true });

  const picked = pickReplyTargets({
    cfg: CFG,
    selfMid: CFG.whaleMid,
    inbox: {
      targets: [
        target({ mid: STRANGER, uname: '路人甲', rpid: 9001, replyRoot: 9000 }),
        target({ mid: 2222, uname: '路人乙', rpid: 9101, replyRoot: 9100, answered: true }),
        target({ mid: OWNER, uname: '懒寻真', owner: true, rpid: 9201, replyRoot: 9200 }),
        target({ mid: 3333, uname: '复读机', rpid: 9001, replyRoot: 9000 }),
        target({ mid: CFG.whaleMid, uname: '自己', rpid: 9301, replyRoot: 9300 }),
        target({ mid: 4444, uname: '没 id', rpid: 9401, replyRoot: 9400, oid: null }),
        target({ mid: 5555, uname: '专栏', rpid: 9501, replyRoot: 9500, business: 'article', bvid: null }),
        target({ mid: null, uname: '鬼', rpid: 9601, replyRoot: 9600 }),
      ],
    },
  });
  assert.deepEqual(picked.owners.map((row) => row.uname), ['懒寻真'], '主人单独一列');
  assert.deepEqual(picked.others.map((row) => row.uname), ['路人甲'], '已回过的那个人不进 others');
  assert.deepEqual(picked.pick.map((row) => row.uname), ['懒寻真', '路人甲'], '主人排在陌生人前面');
  const reasons = picked.skipped.map((row) => row.reason).join(' | ');
  assert.match(reasons, /已经回过他了/u);
  assert.match(reasons, /这一串这轮已经排了回复/u, '同一串里第二个陌生人这轮不再回（别刷屏）');
  assert.match(reasons, /没带稿件/u);
  assert.match(reasons, /不认识的消息类型「article」/u);
  assert.match(reasons, /没带 UID/u);

  // 账本里她自己在这串说过话：陌生人放过，主人照答。
  const ledger = emptyLedger();
  recordReply(ledger, { bvid: 'BV1', aid: 1, rpid: 555, root: 9999, targetMid: 777, targetUname: '别人', text: '人家回过了', selfRpid: 556 });
  const inThread = pickReplyTargets({
    cfg: CFG,
    ledger,
    inbox: {
      targets: [
        target({ mid: STRANGER, uname: '路人甲', rpid: 5001, replyRoot: 9999 }),
        target({ mid: OWNER, uname: '懒寻真', owner: true, rpid: 5002, replyRoot: 9999 }),
      ],
    },
  });
  assert.deepEqual(inThread.pick.map((row) => row.uname), ['懒寻真'], '同一串里主人仍然优先被回');
  assert.match(inThread.skipped.map((row) => row.reason).join(' '), /别刷屏/u);

  // 主人的回复不受「已经回过」限制：主人找她必须答。
  const ownerAgain = pickReplyTargets({
    cfg: CFG,
    inbox: { targets: [target({ mid: OWNER, uname: '懒寻真', owner: true, answered: true, rpid: 9701, replyRoot: 9700 })] },
  });
  assert.deepEqual(ownerAgain.pick.map((row) => row.uname), ['懒寻真']);

  // 但**同一条评论**只回一次 —— 主人也不例外（2026-10-05 真机事故：同一 rpid 被回了两遍）。
  const dupLedger = emptyLedger();
  recordReply(dupLedger, { bvid: 'BV16T4y1k7dB', aid: 936177870, rpid: 9701, root: 9700, targetMid: OWNER, targetUname: '懒寻真', text: '好嘞主人～记下啦', selfRpid: 9702, isOwner: true });
  assert.equal(repliedToComment(dupLedger, 9701), true, '账本里能认出这条评论已经回过');
  assert.equal(repliedToComment(dupLedger, 9709), false, '没回过的 rpid 不能误判');
  assert.equal(repliedToComment(null, 9701), false, '没账本也不炸');
  assert.equal(repliedToComment(dupLedger, null), false, '没 rpid 也不炸');
  const dupOwner = pickReplyTargets({
    cfg: CFG,
    ledger: dupLedger,
    inbox: { targets: [target({ mid: OWNER, uname: '懒寻真', owner: true, rpid: 9701, replyRoot: 9700 })] },
  });
  assert.equal(dupOwner.pick.length, 0, '同一条评论回过了就不能再回，主人也不例外');
  assert.match(dupOwner.skipped.map((row) => row.reason).join(' '), /这条评论人家已经回过了/u);
  // 主人在同一个串里**又说了一句新的**（新 rpid）：仍然要答。
  const ownerNewLine = pickReplyTargets({
    cfg: CFG,
    ledger: dupLedger,
    inbox: { targets: [target({ mid: OWNER, uname: '懒寻真', owner: true, rpid: 9711, replyRoot: 9700 })] },
  });
  assert.deepEqual(ownerNewLine.pick.map((row) => row.uname), ['懒寻真'], '主人换了新评论还得答（免的是每人一条，不是同一条回两遍）');

  // 关掉陌生人：只回主人。
  const onlyOwner = pickReplyTargets({
    cfg: { ...CFG, policy: { ...CFG.policy, replyToOthers: false } },
    inbox: { targets: [target({ mid: STRANGER }), target({ mid: OWNER, uname: '懒寻真', owner: true, rpid: 9801, replyRoot: 9800 })] },
  });
  assert.deepEqual(onlyOwner.pick.map((row) => row.uname), ['懒寻真']);
  assert.match(onlyOwner.skipped.map((row) => row.reason).join(' '), /replyToOthers = false/u);

  // replyScope = owner-only 时陌生人不进列。
  const scoped = pickReplyTargets({
    cfg: { ...CFG, policy: { ...CFG.policy, replyScope: 'owner-only' } },
    inbox: { targets: [target({ mid: STRANGER })] },
  });
  assert.equal(scoped.pick.length, 0);
  assert.match(scoped.skipped[0].reason, /replyScope = owner-only/u);

  // 一轮上限：5 个主人只有 3 个进计划，5 个陌生人只有 replyPerRunOthers 个。
  const many = pickReplyTargets({
    cfg: CFG,
    inbox: {
      targets: [
        ...Array.from({ length: 5 }, (_, index) => target({ mid: 6000 + index, uname: `主人${index}`, owner: true, rpid: 10_000 + index, replyRoot: 10_000 + index })),
        ...Array.from({ length: 5 }, (_, index) => target({ mid: 7000 + index, uname: `路人${index}`, rpid: 20_000 + index, replyRoot: 20_000 + index })),
      ],
    },
  });
  assert.equal(many.pick.length, 3, '每轮最多 replyPerRun 条');
  assert.deepEqual(many.pick.map((row) => row.owner), [true, true, true], '先填主人的额度');
  assert.equal(many.others.length, 5);
}

// ── 4. 编排：额度、动态评论、失败原因都要如实回报 ──────────────────────────────
{
  const ledger = emptyLedger();

  // 动态下的评论：不回视频、kind=dynamic，回在动态评论串里。
  const calls = [];
  const run = async (name, args) => {
    calls.push({ name, args });
    if (name === 'bili_inbox') return { targets: [target({ business: 'dynamic', bvid: null, aid: 117258059782954, oid: 316071900673, uname: '路人甲' })] };
    if (name === 'bili_reply') return { allowed: true, selfRpid: 1 };
    throw new Error(`不该调 ${name}`);
  };
  const result = await runInboxReplies({
    cfg: CFG,
    ledger,
    run,
    compose: async () => '人家也在学这个呢～',
  });
  assert.equal(result.replied, 1);
  assert.deepEqual(calls.map((row) => row.name), ['bili_inbox', 'bili_reply'], '动态评论不取视频、不读评论串');
  assert.equal(calls[1].args.kind, 'dynamic');
  assert.equal(calls[1].args.id, '117258059782954', '动态评论的 id 要用动态 id（subject_id / aid），不是那条 @ 评论的 rpid');
  assert.equal(calls[1].args.rpid, 9001, '要回的是那条 @ 评论本身');
  assert.equal(calls[1].args.confirm, true);
  assert.equal(calls[1].args.message, '人家也在学这个呢～');
  assert.deepEqual(result.drafts.map((row) => row.kind), ['dynamic']);

  // @ 通知（在视频评论里 @ 了她）：id 用 BV 号，不是 source_id 那个 rpid。
  const atCalls = [];
  const at = await runInboxReplies({
    cfg: CFG,
    ledger: emptyLedger(),
    compose: async () => '主人～人家在呢',
    run: async (name, args) => {
      atCalls.push({ name, args });
      if (name === 'bili_inbox' && args.op === 'check') {
        return {
          targets: [target({
            mid: OWNER,
            uname: '懒寻真',
            owner: true,
            business: '评论',
            bvid: 'BV1UAYd6WE2t',
            aid: 117258059782954,
            oid: 316071900673,
            rpid: 316071900673,
            replyRoot: 316071900673,
          })],
        };
      }
      if (name === 'bili_video') return { aid: 111, bvid: 'BV1UAYd6WE2t', title: '⚡我即为长夜⚡' };
      if (name === 'bili_inbox' && args.op === 'thread') return { replies: [] };
      if (name === 'bili_reply') return { allowed: true };
      throw new Error(`不该调 ${name}`);
    },
  });
  assert.equal(at.replied, 1);
  const sent = atCalls.find((row) => row.name === 'bili_reply');
  assert.equal(sent.args.id, 'BV1UAYd6WE2t', '@ 通知回视频评论要用 BV 号');
  assert.equal(sent.args.kind, 'video');

  // 视频评论：先取详情 → 读评论串 → 发；每轮上限生效。
  const videoCalls = [];
  const runVideo = async (name, args) => {
    videoCalls.push({ name, args });
    if (name === 'bili_inbox' && args.op === 'check') {
      return {
        targets: Array.from({ length: 5 }, (_, index) => target({
          mid: 8000 + index,
          uname: `主人${index}`,
          owner: true,
          rpid: 30_000 + index,
          replyRoot: 30_000 + index,
        })),
      };
    }
    if (name === 'bili_video') return { aid: 936177870, bvid: 'BV16T4y1k7dB', title: '标题' };
    if (name === 'bili_inbox' && args.op === 'thread') return { replies: [{ uname: '主人0', message: '你好呀' }] };
    if (name === 'bili_reply') return { allowed: true };
    throw new Error(`不该调 ${name}`);
  };
  const capped = await runInboxReplies({ cfg: CFG, ledger, run: runVideo, compose: async () => '主人～人家在呢' });
  assert.equal(capped.replied, 3, 'replyPerRun = 3');
  assert.equal(videoCalls.filter((row) => row.name === 'bili_reply').length, 3);

  // dryRun：写话但不发。
  const dryCalls = [];
  const dry = await runInboxReplies({
    cfg: CFG,
    ledger,
    dryRun: true,
    run: async (name, args) => {
      dryCalls.push(name);
      if (name === 'bili_inbox') return { targets: [target()] };
      if (name === 'bili_video') return { aid: 1, bvid: 'BV1', title: 't' };
      if (name === 'bili_reply') throw new Error('dryRun 不该发');
      return {};
    },
    compose: async () => '先给主人看看这句行不行～',
  });
  assert.equal(dry.replied, 0);
  assert.equal(dry.drafts.length, 1, 'dryRun 也要写出草稿');
  assert.equal(dryCalls.includes('bili_reply'), false);

  // 写不出话 / 被策略拦 / 工具抛错，都要分开记进 failed，别让整轮崩掉。
  const ledger2 = emptyLedger();
  recordReply(ledger2, { bvid: 'BV1', aid: 1, rpid: 1, root: 1, targetMid: 5000, targetUname: '熟人', text: '人家先回过了', selfRpid: 2 });
  const failed = await runInboxReplies({
    cfg: { ...CFG, policy: { ...CFG.policy, replyPerRunOthers: 2 } },
    ledger: ledger2,
    run: async (name, args) => {
      if (name === 'bili_inbox') {
        return { targets: [target({ mid: 4001, uname: '没脑子' }), target({ mid: 4002, uname: '被拦', rpid: 40_002, replyRoot: 40_002 })] };
      }
      if (name === 'bili_video') return { aid: 1, bvid: 'BV1', title: 't' };
      if (name === 'bili_reply') return args.mid === 4002 ? { allowed: false, reasons: ['今日回复已达上限'] } : { allowed: true };
      return {};
    },
    compose: async (options) => (options.comment.mid === 4001 ? null : '你好呀'),
  });
  assert.equal(failed.replied, 0);
  assert.equal(failed.failed.length, 2);
  assert.match(failed.failed.map((row) => row.reason).join(' | '), /脑子没给出正文/u);
  assert.match(failed.failed.map((row) => row.reason).join(' | '), /今日回复已达上限/u);
  assert.match(failed.drafts[0].message, /你好呀/u, '草稿里要留下写过的那句（主人能看见）');

  await assert.rejects(() => runInboxReplies({ cfg: CFG, run: null }), /需要一个 run/u);
}

// ── 5. commentAdd：动态评论走 type=17，视频评论仍然 type=1 ────────────────────
{
  const client = Object.create(BiliClient.prototype);
  const seen = [];
  client.csrf = () => 'CSRF';
  client.request = async (path, options) => {
    seen.push({ path, form: options.form, referer: options.referer });
    return { data: { reply: { rpid: 1 } } };
  };
  await client.commentAdd({ aid: 117258059782954, message: '人家在看这个动态～', root: 1, parent: 2, type: 17 });
  assert.equal(seen[0].form.type, 17, '动态评论 type=17');
  assert.equal(seen[0].form.oid, '117258059782954', '动态评论 oid 用动态 id');
  assert.equal(seen[0].referer, 'https://t.bilibili.com/117258059782954');
  await client.commentAdd({ aid: 936177870, bvid: 'BV16T4y1k7dB', message: '人家看完了～' });
  assert.equal(seen[1].form.type, 1);
  assert.equal(seen[1].referer, 'https://www.bilibili.com/video/BV16T4y1k7dB');
}

// ── 6. 每日回复额度「主人 / 别人」分开算 ──────────────────────────────────────
//
// 事故（主人 2026-10-05 报「它现在回不了评论区的评论了」）：
// 主人和陌生人共用 `policy.dailyReplies`（10 条），主人当天在评论区多聊了几句就把额度吃光，
// 于是**主人的评论也回不了**。真机 `auto.log` 11:10 / 11:15 连着两次：
//   `reply check: 回 0 条 / 跳过 0 条 / 失败 1 条 / 待回 1`，失败原因是「今日回复已达上限 10 条」。
{
  const cfg = {
    ownerMid: OWNER,
    ownerNames: ['懒寻真', '金易木木元'],
    ownerMids: [OWNER, 391581639],
    policy: { ...CFG.policy, postReply: 'auto', dailyReplies: 10, dailyRepliesOwner: 50, minIntervalSeconds: 0, minIntervalSecondsOwner: 0 },
  };
  const seed = (ledger, count, isOwner) => {
    for (let i = 0; i < count; i += 1) {
      recordReply(ledger, {
        bvid: `BV${i}`, aid: i, rpid: 1000 + i, root: 2000 + i,
        targetMid: isOwner ? OWNER : 5000 + i,
        targetUname: isOwner ? '懒寻真' : `路人${i}`,
        text: '回过了', selfRpid: 3000 + i, isOwner,
      });
    }
  };

  // 陌生人额度用尽 → 陌生人被拦；但**主人照样能回**（这就是那条事故）。
  const used = emptyLedger();
  seed(used, 10, false);
  const blockedStranger = checkReply({ cfg, ledger: used, target: { mid: 9999, uname: '新路人', root: 7000, rpid: 7001 }, message: '再回一条' });
  assert.equal(blockedStranger.allowed, false);
  assert.match(blockedStranger.reasons.join(' '), /今日回复已达上限 10 条/u, '陌生人额度照旧');
  const ownerStillOk = checkReply({ cfg, ledger: used, target: { mid: OWNER, uname: '懒寻真', root: 7000, rpid: 7001 }, message: '主人我来啦' });
  assert.equal(ownerStillOk.allowed, true, '主人不能被陌生人的额度卡住（事故就是这么来的）');

  // 主人额度也满了才拦主人，而且报的是主人自己那条线。
  const ownerFull = emptyLedger();
  seed(ownerFull, 50, true);
  const blockedOwner = checkReply({ cfg, ledger: ownerFull, target: { mid: OWNER, uname: '懒寻真', root: 7000, rpid: 7001 }, message: '主人我来啦' });
  assert.equal(blockedOwner.allowed, false);
  assert.match(blockedOwner.reasons.join(' '), /今日回复主人已达上限 50 条/u);

  // 主人聊再多也不吃陌生人的额度。
  const ownerChatty = emptyLedger();
  seed(ownerChatty, 49, true);
  const strangerFine = checkReply({ cfg, ledger: ownerChatty, target: { mid: 9999, uname: '新路人', root: 7100, rpid: 7101 }, message: '你好呀' });
  assert.equal(strangerFine.allowed, true, '主人多聊几句不该把陌生人的额度吃光');

  // dailyRepliesOwner = 0 表示主人不限。
  const unlimited = { ...cfg, policy: { ...cfg.policy, dailyRepliesOwner: 0 } };
  const alwaysOk = checkReply({ cfg: unlimited, ledger: ownerFull, target: { mid: OWNER, uname: '懒寻真', root: 7200, rpid: 7201 }, message: '主人～' });
  assert.equal(alwaysOk.allowed, true, 'dailyRepliesOwner=0 = 主人不限');
}

console.log('✓ 评论回复测试通过：提示词上下文、回复不带 @、回主人用付费脑子、同一条评论只回一次、主人/别人额度分开、挑人与额度、动态评论、失败如实回报');
