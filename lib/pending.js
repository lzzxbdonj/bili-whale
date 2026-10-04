/**
 * 待确认箱：她自动干出来的**草稿**（评论/回复）先放这里，等主人点头。
 *
 * 为什么单独一个文件：自动巡检（本机定时器 / GitHub Actions）跑的时候没人看着，
 * 而「视频一级评论」默认就是要主人点头的模式；所以草稿必须落盘，主人随时能看、
 * 能放行。云端巡检从遥控台 `/state` 读写同一份结构（`pending` 数组）。
 *
 * @module dsh-bilibili-whale/pending
 */
import { readJsonFile, writeJsonFile, statePath } from './config.js';

const MAX_DRAFTS = 50;

/** 读取待确认箱。 */
export function loadPending() {
  const value = readJsonFile(statePath('pending.json'), null);
  if (value === null || typeof value !== 'object') return { drafts: [] };
  return { drafts: Array.isArray(value.drafts) ? value.drafts : [] };
}

/** 落盘。 */
export function savePending(state) {
  const drafts = Array.isArray(state?.drafts) ? state.drafts : [];
  const payload = { drafts: drafts.slice(-MAX_DRAFTS) };
  writeJsonFile(statePath('pending.json'), payload);
  return payload;
}

/**
 * 收一条草稿（同一个视频不重复收）。
 *
 * @param {object} draft - `{ bvid, title, upName, message, topic?, score? }`
 * @returns {object} 更新后的待确认箱
 */
export function queueDraft(draft) {
  const state = loadPending();
  if (state.drafts.some((item) => item.bvid === draft.bvid && item.posted !== true)) return state;
  state.drafts.push({
    id: `${draft.bvid}-${Date.now().toString(36)}`,
    at: new Date().toISOString(),
    approved: false,
    posted: false,
    ...draft,
  });
  return savePending(state);
}

/** 还没处理的草稿（新的在前）。 */
export function listDrafts(state = loadPending()) {
  return state.drafts.filter((item) => item.posted !== true).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** 放行/丢弃：`action` = approve | reject。 */
export function markDraft(id, action) {
  const state = loadPending();
  const hit = state.drafts.find((item) => item.id === id);
  if (hit === undefined) return null;
  if (action === 'reject') hit.posted = true;
  else hit.approved = true;
  savePending(state);
  return hit;
}
