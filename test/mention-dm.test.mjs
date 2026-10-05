/**
 * 「@我的」与私信两条链路的单元测试（2026-10-05 主人报的两个 bug）。
 *
 * 1. 主人 @ 了她却收不到：`/x/msgfeed/at` 的字段和 `/x/msgfeed/reply` 不一样，
 *    `normalizeMsgMention` 必须从 `item.source_content` / `uri` / `at_time` 里把
 *    正文、BV 号、rpid、时间抠出来（否则 inbox 里是一条空壳目标，回也回不对串）。
 * 2. 陌生人私信不能泄露主人侧信息：`draftDmReply(audience:'stranger')` 的系统提示
 *    里不许出现主人昵称/UID/知识库/能力清单，长度上限也更短。
 *
 * 用法：node test/mention-dm.test.mjs
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BiliClient } from '../lib/api.js';
import { ownerMentionList, isOwner, checkDmReply, titleBlocked, titleOnTopic } from '../lib/policy.js';
import { DEFAULTS } from '../lib/config.js';

const here = dirname(fileURLToPath(import.meta.url));

// 真实抓到的「@我的」一条（2026-10-05 主人 @「寻和橼的大肥鱼dsh 要这样@」）——字段按实测原样。
const AT_ITEM = {
  id: 999,
  user: { mid: 3494364865103885, nickname: '懒寻真' },
  item: {
    type: 'reply',
    business: '评论',
    title: '⚡我即为长夜⚡',
    uri: 'https://www.bilibili.com/video/BV1UAYd6WE2t',
    subject_id: 117258059782954,
    source_id: 316071900673,
    source_content: '@寻和橼的大肥鱼dsh 要这样@',
    at_details: [{ mid: 3747560556595480, nickname: '寻和橼的大肥鱼dsh' }],
  },
  at_time: 1759612345,
};

// 只要能调纯函数就行，不需要真 cookie/网络。
const client = Object.create(BiliClient.prototype);

const mention = client.normalizeMsgMention(AT_ITEM);
assert.equal(mention.mid, 3494364865103885, '@ 我的人应是消息中心的 user.mid');
assert.equal(mention.uname, '懒寻真');
assert.equal(mention.message, '@寻和橼的大肥鱼dsh 要这样@', '正文要取 item.source_content');
assert.equal(mention.rpid, 316071900673, 'rpid 要取被 @ 的那条评论 source_id');
assert.equal(mention.root, 316071900673, '没有 root_id 时 root 兜底成 source_id');
assert.equal(mention.bvid, 'BV1UAYd6WE2t', 'BV 号要从 uri 里抠');
assert.equal(mention.aid, 117258059782954, 'aid 取 subject_id');
assert.equal(mention.subject, '⚡我即为长夜⚡');
assert.deepEqual(mention.atDetails, [{ mid: 3747560556595480, nickname: '寻和橼的大肥鱼dsh' }]);
assert.equal(mention.ts, 1759612345 * 1000, 'ts 要用 at_time（秒）换算');
assert.notEqual(mention.ctime, '', 'ctime 不该是空的（列表上要显示时间）');
assert.equal(mention.myMessage, '', '@ 我的没有「人家原话」可显示');

// 老路子不能被我改坏：`/x/msgfeed/reply` 的字段形状。
const replyItem = {
  id: 1,
  user: { mid: 1049033797, nickname: '我的小千1' },
  item: { type: 'reply', source_id: 555, uri: 'https://www.bilibili.com/video/BV1xx411c7mD' },
  reply: { rpid: 777, root_id: 555, content: { message: '你好呀' }, ctime: 1759600000 },
};
const reply = client.normalizeMsgReply(replyItem);
assert.equal(reply.mid, 1049033797);
assert.equal(reply.rpid, 777, '「回复我的」的 rpid 仍取 reply.rpid');
assert.equal(reply.message, '你好呀');

// ownerMentionList：只配了昵称没配 UID 的人要丢掉（没有 biz_id 的 @ 发出去是纯文本，等于没 @）。
const cfg = {
  ...DEFAULTS,
  ownerName: '懒寻真',
  ownerMid: '3494364865103885',
  ownerNames: ['懒寻真', '金易木木元', '没UID的人'],
  ownerMids: ['3494364865103885', '391581639'],
};
assert.deepEqual(
  ownerMentionList(cfg),
  [
    { name: '懒寻真', mid: '3494364865103885' },
    { name: '金易木木元', mid: '391581639' },
  ],
  'ownerNames/ownerMids 按下标配对，缺 UID 的丢掉，重名去重',
);
assert.equal(isOwner(cfg, { mid: '391581639', uname: '随便' }), true, '按 UID 认主人');
assert.equal(isOwner(cfg, { mid: '1', uname: '金易木木元' }), true, '按昵称也认主人');
assert.equal(isOwner(cfg, { mid: '1', uname: '路人' }), false);

// checkDmReply：陌生人默认只自动回一条，主人不受这条限制。
// 注意 ledger 里必须有「对方先发来的」记录（dmIncoming），否则会被「不主动搭话陌生人」拦掉。
const now = Date.now();
const stranger = { mid: '1049033797', uname: '我的小千1' };
const ledger = {
  daily: {},
  dms: [],
  dmIncoming: [
    { mid: stranger.mid, uname: stranger.uname, text: '你好呀', ts: now - 60_000 },
    { mid: '3494364865103885', uname: '懒寻真', text: '在吗', ts: now - 30_000 },
  ],
  replyThreads: {},
};
const strangerFirst = checkDmReply({ cfg, ledger, mid: stranger.mid, uname: stranger.uname, text: '你好', now });
assert.equal(strangerFirst.needsConfirm, false, 'replyDmOthers 默认 once：陌生人第一条可以自动回');
assert.equal(strangerFirst.allowed, true, `陌生人第一条应放行（原因：${strangerFirst.reasons.join('；')}）`);
const ledgerAfter = {
  ...ledger,
  daily: { [new Date(now).toISOString().slice(0, 10)]: { dms: 0 } },
  dms: [{ ...stranger, text: '你好', ts: now - 30_000, isOwner: false, auto: true }],
};
const strangerSecond = checkDmReply({ cfg, ledger: ledgerAfter, mid: stranger.mid, uname: stranger.uname, text: '在吗', now });
assert.equal(strangerSecond.allowed, false, 'replyDmOthers=once：同一个人不回第二条');
const ownerReply = checkDmReply({ cfg, ledger: ledgerAfter, mid: '3494364865103885', uname: '懒寻真', text: '在吗', now });
assert.equal(ownerReply.needsConfirm, false, '主人私信不需要点头');
assert.equal(ownerReply.allowed, true, `主人应放行（原因：${ownerReply.reasons.join('；')}）`);

// brain 的陌生人提示词：不能把主人侧信息喂进去。
const brainSrc = readFileSync(join(here, '..', 'lib', 'brain.js'), 'utf8');
assert.match(brainSrc, /audience = 'owner'/, 'draftDmReply 必须支持 audience 参数');
assert.match(brainSrc, /不要透露主人的任何信息/, '陌生人分支必须有「不透露主人信息」的约束');

const toolsSrc = readFileSync(join(here, '..', 'lib', 'tools.js'), 'utf8');
assert.match(toolsSrc, /audience: owner === true \? 'owner' : 'stranger'/, 'tools.js 侧接线要对陌生人传 stranger');
assert.match(toolsSrc, /msgMentions/, 'bili_inbox 必须读「@我的」接口');
assert.match(toolsSrc, /kind: 'at'|kind === 'at'/, 'inbox 目标里要标出「@我的」');
assert.match(toolsSrc, /const \{\s*raw, atDetails, mentionTime, \.\.\.rest \}/, '私有字段不能漏进工具返回值');
assert.doesNotMatch(
  toolsSrc,
  /owner === true && cfg\.brain\?\.enabled !== false/,
  '私信脑子不能再只给主人（陌生人也要走免费模型）',
);

// 评论区的真 @：正文里的 @昵称 必须随 at_name_to_mid 交给服务端（否则主人收不到通知）。
{
  const captured = [];
  const fake = Object.create(BiliClient.prototype);
  fake.csrf = () => 'csrf-token';
  fake.request = async (path, options) => {
    captured.push({ path, form: options.form });
    return { data: { reply: { rpid: 1 } } };
  };
  const mentions = [{ name: '懒寻真', mid: '3494364865103885' }, { name: '金易木木元', mid: '391581639' }];
  await fake.commentAdd({ aid: 1, bvid: 'BV1xx', message: '学到啦 @懒寻真 @金易木木元', mentions });
  assert.equal(captured[0].path, '/x/v2/reply/add');
  const map = JSON.parse(captured[0].form.at_name_to_mid);
  assert.deepEqual(map, { 懒寻真: '3494364865103885', 金易木木元: '391581639' }, '正文里提到的两位主人都要进 at_name_to_mid');
  await fake.commentAdd({ aid: 1, bvid: 'BV1xx', message: '没提人', mentions });
  assert.equal(captured[1].form.at_name_to_mid, undefined, '正文没写 @ 就别塞 at_name_to_mid');
}

// 内容把关：擦边标题必须被拦，话题表默认不启用（免得把「刷视频」窄成「只刷学习区」）。
{
  const junk = titleBlocked({}, '女大学生的"隐秘的圈子"一月疯狂约600人一晚赚上万');
  assert.ok(junk !== null, `擦边标题必须命中黑名单（实际：${junk}）`);
  assert.ok(
    titleBlocked({ feed: { titleBlock: [] } }, '女大学生的"隐秘的圈子"一月疯狂约600人一晚赚上万') !== null,
    'feed.titleBlock 为空数组时必须回落到默认黑名单（空数组 ≠ 清空黑名单）',
  );
  assert.equal(titleBlocked({}, '【相对论】为什么光速不变？'), null, '正常科普不该被拦');
  assert.equal(titleOnTopic({}, '随便什么标题'), true, 'topicsOnly 默认关：不按话题过滤');
  assert.equal(titleOnTopic({ feed: { topicsOnly: true } }, '随便什么标题'), false, 'topicsOnly 打开时要按话题过滤');
  assert.equal(titleOnTopic({ feed: { topicsOnly: true } }, '【相对论】为什么光速不变？'), true, '话题内的片子要放行');
}

console.log('✓ 提及/私信测试通过：@我的归一化、inbox 契约、陌生人私信边界、评论区真 @、内容把关');
