/**
 * 小鲸鱼娘的**自主学习**：不用主人指定，她自己决定今天学什么。
 *
 * 一轮学习的流程（`learnOnce`）：
 *   1. 从 `cfg.learning.topics` 里挑一个今天还没用过的方向（轮换，避免天天同一个话题）；
 *   2. 按方向去搜/B 站热门里捞候选视频，用 `scoreVideo()` 打分，挑分数最高的几个；
 *   3. 看过的视频报进 B 站浏览记录（`reportHistory`，主人要求「刷过的视频放入浏览记录」）；
 *   4. 觉得是好内容（分数 ≥ `policy.tripleMinScore`）就随手三连：点赞 + 投币 + 收藏，
 *      并按方向归进不同收藏夹（`tripleVideo`，收藏夹名见 `feed.folderByTopic`）；
 *   5. 看过详情与热评后，让脑子写一条**学习笔记**（学到什么、为什么有意思）；
 *   6. 觉得有意义（分数 ≥ `meaningfulScore`）就顺手去评论区留言，留言里 @ 两位主人；
 *   7. 笔记记进账本 `ledger.study` + 素材队列，晚上由 `composeStudyDynamic()` 拼成学习动态。
 *
 * 全部规则都在这里，云端巡检（`cloud/run.mjs`）与本机工具（`bili_study`）共用，
 * 保证「云端学的」和「本机学的」是同一只鲸鱼。
 *
 * @module dsh-bilibili-whale/study
 */
import { askBrain, loadPersona, tidyReply } from './brain.js';
import { withOwnerMentions, titleBlocked } from './policy.js';
import { recordStudy, studiedVideo, todayStudy, pushMaterial } from './ledger.js';
import { reportHistory, tripleVideo, tripleConfig } from './triple.js';

/** 取学习配置，缺项用兜底值（云端可能跑在旧配置上）。 */
export function studyConfig(cfg) {
  const raw = cfg?.learning ?? {};
  return {
    enabled: raw.enabled !== false,
    topics: Array.isArray(raw.topics) && raw.topics.length > 0 ? raw.topics : ['DeepSeek', 'AI 智能体', '科普'],
    perRun: Math.min(Math.max(Number(raw.perRun ?? 2), 1), 5),
    sources: Array.isArray(raw.sources) && raw.sources.length > 0 ? raw.sources : ['search', 'popular', 'ranking'],
    commentWhenMeaningful: raw.commentWhenMeaningful !== false,
    meaningfulScore: Number(raw.meaningfulScore ?? 6),
    minDurationSec: Number(raw.minDurationSec ?? 120),
    maxDurationSec: Number(raw.maxDurationSec ?? 5400),
    minView: Number(raw.minView ?? 5000),
    excludeKeywords: Array.isArray(raw.excludeKeywords) ? raw.excludeKeywords : ['鬼畜', '带货', '广告'],
    noteComments: Math.min(Math.max(Number(raw.noteComments ?? 6), 0), 20),
    keepNotes: Math.max(1, Number(raw.keepNotes ?? 200)),
    maxCommentChars: Number(cfg?.policy?.maxCommentChars ?? 200),
  };
}

/** 今天该学哪个方向：按「今天已经学过的方向」轮换。 */
export function pickTopic(cfg, ledger, now = new Date()) {
  const conf = studyConfig(cfg);
  const used = new Set(todayStudy(ledger, now).map((item) => item.topic).filter(Boolean));
  const fresh = conf.topics.filter((topic) => used.has(topic) === false);
  const pool = fresh.length > 0 ? fresh : conf.topics;
  // 用「今年第几天 + 已学条数」定位，保证同一天里依次换方向。
  const index = (todayStudy(ledger, now).length + new Date(now).getDate()) % pool.length;
  return pool[index];
}

/**
 * 给候选视频打分：越像「值得学的」分越高。
 *
 * 命中方向关键词 +3、教程/讲解类词 +2、时长在 2 分钟~90 分钟 +2、
 * 播放量够 +1、有热评（说明有人在认真聊）+1、命中排除词 -10、学过 -100。
 *
 * @returns {number} 分数（负数=直接放弃）
 */
export function scoreVideo(video, { topic = '', cfg, ledger } = {}) {
  const conf = studyConfig(cfg);
  const title = `${String(video?.title ?? '')} ${(video?.tags ?? []).join(' ')}`;
  if (video === null || video === undefined) return -100;
  if (studiedVideo(ledger, video.bvid) !== null) return -100;
  // 擦边/八卦/暴富这类片子直接 -100（不学、不评论、不进素材）——跟云端 patrol 用同一张黑名单。
  if (titleBlocked(cfg, video.title, video.tags ?? []) !== null) return -100;
  if (conf.excludeKeywords.some((word) => title.includes(word))) return -10;
  const durationSec = Number(video.durationSec ?? 0);
  if (durationSec > 0 && (durationSec < conf.minDurationSec || durationSec > conf.maxDurationSec)) return -5;
  if (Number(video.view ?? 0) > 0 && Number(video.view) < conf.minView) return -5;
  let score = 0;
  const topicWords = String(topic).split(/[\s/]+/).filter((word) => word.length >= 2);
  if (topicWords.some((word) => title.includes(word))) score += 3;
  if (/教程|讲解|原理|入门|科普|分析|拆解|源码|论文|笔记|解读|实录|公开课|手把手/.test(title)) score += 2;
  if (durationSec >= 120 && durationSec <= 5400) score += 2;
  if (Number(video.view ?? 0) >= 50000) score += 1;
  if (Number(video.reply ?? 0) >= 20) score += 1;
  if ((video.tags ?? []).length > 0) score += 0.5;
  return score;
}

/**
 * 挑这一轮要学的视频。
 *
 * @param {object} options.client - `BiliClient`。
 * @param {object} options.ledger - 账本。
 * @param {object} options.cfg - 配置。
 * @returns {Promise<{topic: string, picks: object[], considered: number}>}
 */
export async function pickStudyVideos({ client, ledger, cfg, topic }) {
  const conf = studyConfig(cfg);
  const chosenTopic = topic ?? pickTopic(cfg, ledger);
  const seen = new Set();
  const candidates = [];
  for (const source of conf.sources) {
    let items = [];
    try {
      // 注意各接口的返回形态：search/popular/ranking 都直接给数组（不是 {items}）。
      if (source === 'search') items = await client.search(chosenTopic, 1);
      else if (source === 'ranking') items = await client.ranking();
      else items = await client.popular(20);
    } catch {
      continue;
    }
    if (Array.isArray(items) !== true) continue;
    for (const item of items) {
      if (item?.bvid === undefined || item.bvid === '' || seen.has(item.bvid)) continue;
      seen.add(item.bvid);
      candidates.push({ ...item, source });
    }
    if (candidates.length >= 20) break;
  }
  // 打分需要时长/播放等细节，先看详情再定；最多细看 8 个，省接口配额。
  const scored = [];
  for (const item of candidates.slice(0, 8)) {
    let video = item;
    try {
      const detail = await client.video(item.bvid);
      detail.tags = await client.tags(item.bvid).catch(() => []);
      video = { ...detail, source: item.source };
    } catch {
      continue;
    }
    const score = scoreVideo(video, { topic: chosenTopic, cfg, ledger });
    if (score < 0) continue;
    scored.push({ video, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return { topic: chosenTopic, picks: scored.slice(0, conf.perRun), considered: candidates.length };
}

/**
 * 让脑子写一条学习笔记（这是「她真的学了」的证据，晚上动态就用它）。
 *
 * @returns {Promise<{note: string, interesting: string}|null>}
 */
export async function writeStudyNote({ cfg, video, topic, topComments = [] }) {
  const conf = studyConfig(cfg);
  const hot = topComments
    .slice(0, conf.noteComments)
    .map((item) => `- ${String(item.uname ?? '').slice(0, 12)}：${String(item.message ?? '').replace(/\s+/g, ' ').slice(0, 60)}`)
    .join('\n');
  const system = [
    loadPersona(cfg?.persona ?? 'whale-maid'),
    '',
    '## 现在的任务：看完一个视频，写一条自己的学习笔记（给自己看的）',
    `- 今天想学的方向：${topic}`,
    '- 用 2~4 句写清楚「这个视频讲了什么、人家学到/明白了什么」，要具体到知识点，不要「很有收获」这种空话。',
    '- 允许保留她不成熟的理解与疑问（像真学生）。',
    '- 只输出笔记正文，第一人称（自称「人家」），不要标题、不要 Markdown、不要换行分点。',
    '- 不超过 160 字。',
  ].join('\n');
  const user = [
    `视频：《${String(video?.title ?? '')}》｜UP：${String(video?.author ?? '')}｜时长：${String(video?.duration ?? '')}`,
    (video?.tags ?? []).length > 0 ? `标签：${(video.tags ?? []).slice(0, 8).join('、')}` : '',
    String(video?.desc ?? '').trim() === '' ? '' : `简介：${String(video.desc).trim().slice(0, 200)}`,
    hot === '' ? '' : `热评：\n${hot}`,
    '',
    '写你的笔记。',
  ].filter((line) => line !== '').join('\n');
  const text = await askBrain(cfg, { system, user });
  if (text === null) return null;
  const note = tidyReply(text, 160);
  return note === '' ? null : { note, interesting: `${String(video?.title ?? '').slice(0, 40)}` };
}

/**
 * 一轮自主学习。会写账本，但**不落盘**（谁调用谁 `saveLedger`），方便云端一次推回。
 *
 * @param {object} options.run - 执行工具的函数 `(name, args) => Promise<any>`（复用插件的策略与账本逻辑）。
 * @param {object} options.client - `BiliClient`。
 * @param {object} options.ledger - 账本。
 * @param {object} options.cfg - 配置。
 * @param {boolean} [options.dry] - true 时只挑不写（不记笔记、不留言）。
 * @returns {Promise<object>} 本轮报告（给日志用，不含私信/凭据）。
 */
export async function learnOnce({ run, client, ledger, cfg, dry = false }) {
  const conf = studyConfig(cfg);
  if (conf.enabled !== true) return { skipped: '配置里 learning.enabled = false' };
  const { topic, picks, considered } = await pickStudyVideos({ client, ledger, cfg });
  if (picks.length === 0) return { topic, considered, studied: 0, notes: [], commented: [], queued: [], note: '这轮没找到值得学的' };
  const notes = [];
  const commented = [];
  const queued = [];
  const triples = [];
  let reported = 0;
  for (const pick of picks) {
    const video = pick.video;
    if (dry === true) {
      notes.push({ bvid: video.bvid, title: video.title, score: pick.score, note: '（dry-run，没让脑子写）' });
      continue;
    }
    // 刷过的视频先报进 B 站浏览记录（主人要求：「刷过的视频放入浏览记录」），
    // 顺手在账本 `watched` 里留一条痕（主人 2026-10-05：「让它刷视频能留下痕迹」）。
    const watched = await reportHistory({ client, cfg, video, ledger, topic, source: 'study' });
    if (watched.reported === true) reported += 1;
    let topComments = [];
    try {
      const listed = await client.comments(video.bvid, { ps: conf.noteComments, aid: video.aid });
      topComments = listed?.replies ?? [];
    } catch {
      topComments = [];
    }
    const written = await writeStudyNote({ cfg, video, topic, topComments });
    const note = written?.note ?? '';
    const meaningful = pick.score >= conf.meaningfulScore;
    recordStudy(ledger, {
      bvid: video.bvid,
      aid: video.aid,
      title: String(video.title ?? ''),
      upName: String(video.author ?? ''),
      topic,
      score: pick.score,
      note,
      meaningful,
      keep: conf.keepNotes,
    });
    if (note !== '') pushMaterial(ledger, `【今天学到的】《${String(video.title ?? '').slice(0, 40)}》——${note}`);
    notes.push({ bvid: video.bvid, title: video.title, upName: video.author, score: pick.score, note, meaningful });

    // 好内容随手三连（点赞 + 投币 + 收藏，并按方向进不同收藏夹）。
    // 策略说了算：分数门槛 tripleMinScore、每日上限 dailyTriples、postTriple 模式。
    const tripled = await tripleVideo({ client, cfg, ledger, video, topic, score: pick.score, confirm: false });
    if (tripled.done === true) {
      triples.push({
        bvid: video.bvid,
        title: video.title,
        folder: tripled.folder?.title ?? '',
        folderCreated: tripled.folder?.created === true,
        coin: tripled.coin,
        errors: tripled.errors,
      });
    } else if (tripled.needsConfirm === true) {
      notes[notes.length - 1].tripleBlocked = '三连是 confirm 模式，等主人点头（policy.postTriple = auto 才会自己连）';
    } else if ((tripled.reasons ?? []).length > 0) {
      notes[notes.length - 1].tripleBlocked = tripled.reasons.join('；');
    }

    // 觉得有意义 → 去评论区留言（工具侧会自动 @ 两位主人）。
    // 走策略：postVideoComment=auto 就直接发；=confirm（默认）就变成草稿进待确认箱，等主人点头。
    if (meaningful && conf.commentWhenMeaningful) {
      const comment = note === '' ? '' : withOwnerMentions(cfg, tidyReply(note, conf.maxCommentChars));
      if (comment !== '') {
        try {
          const sent = await run('bili_comment', { id: video.bvid, message: comment });
          const record = { bvid: video.bvid, title: video.title, upName: video.author, message: comment, topic, score: pick.score };
          if (sent?.needsConfirm === true) queued.push(record);
          else if (sent?.allowed === false) notes[notes.length - 1].commentBlocked = (sent?.reasons ?? []).join('；');
          else commented.push(video.bvid);
        } catch (issue) {
          notes[notes.length - 1].commentBlocked = String(issue?.message ?? issue).slice(0, 80);
        }
      }
    }
  }
  return {
    topic,
    considered,
    studied: notes.length,
    notes,
    commented,
    queued,
    triples,
    historyReported: reported,
    meaningful: notes.filter((item) => item.meaningful === true).length,
  };
}

/**
 * 把今天的学习笔记拼成一条「学习动态」。
 *
 * 优先让脑子写（有笔记时）；没笔记或脑子挂了，回退到模板池。
 *
 * @returns {Promise<string>} 动态正文（已 @ 两位主人）。
 */
export async function composeStudyDynamic({ cfg, ledger, now = new Date() }) {
  const notes = todayStudy(ledger, now).filter((item) => String(item.note ?? '').trim() !== '');
  const mention = cfg?.dailyDynamic?.mentionOwners === false ? (text) => text : (text) => withOwnerMentions(cfg, text);
  if (notes.length === 0) {
    const templates = cfg?.dailyDynamic?.templates ?? ['今天也在认真学习呢 (。-`ω´-)✧'];
    const index = Number(ledger?.dynamicTemplateIndex ?? 0) % templates.length;
    ledger.dynamicTemplateIndex = index + 1;
    return mention(String(templates[index]));
  }
  if (cfg?.dailyDynamic?.useStudyNotes !== false) {
    const system = [
      loadPersona(cfg?.persona ?? 'whale-maid'),
      '',
      '## 现在的任务：把今天自己学的东西写成一条 B 站动态',
      '- 口吻是她的日常动态：开心、骄傲一点点，但不夸张，不要 emoji 堆砌（最多两个）。',
      '- 先报今天看了什么、学到什么（用下面给的具体知识，别编），再说一句给自己或主人的话。',
      '- 只输出正文，不要标题、不要换行分点、不要引号。',
      '- 不超过 220 字。',
    ].join('\n');
    const list = notes
      .slice(0, 5)
      .map((item, index) => `${index + 1}. 《${String(item.title ?? '').slice(0, 40)}》（${item.upName ?? ''}）｜${String(item.note).slice(0, 120)}`)
      .join('\n');
    const text = await askBrain(cfg, { system, user: `今天学的：\n${list}\n\n写这条动态。` });
    if (text !== null) {
      const tidy = tidyReply(text, 220);
      if (tidy !== '') return mention(tidy);
    }
  }
  const lines = notes.slice(0, 3).map((item) => `《${String(item.title ?? '').slice(0, 30)}》：${String(item.note).slice(0, 80)}`);
  return mention(`人家今天自己找了 ${notes.length} 个视频来学～\n${lines.join('\n')}`);
}

/** 给「今天学了什么」用的一句话摘要（汇报/私信里用）。 */
export function studySummary(ledger, now = new Date()) {
  const notes = todayStudy(ledger, now);
  if (notes.length === 0) return '今天还没开始学呢，尾巴有点心虚 (´･ω･`)';
  const topics = [...new Set(notes.map((item) => item.topic).filter(Boolean))];
  return `今天学了 ${notes.length} 个视频${topics.length > 0 ? `（方向：${topics.join('、')}）` : ''}，笔记都在账本里了。`;
}
