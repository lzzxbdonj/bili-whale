/**
 * dsh-bilibili-whale —— 小鲸鱼娘女仆的 B 站手脚（DSH host 插件）。
 *
 * 导出 cordis 约定：name / inject / apply。
 * apply 做三件事：
 *   1. 把 10 个 bili_* 工具注册进宿主工具注册表；
 *   2. 打开二维码页面（Windows 走 rundll32 FileProtocolHandler，其它平台 open / xdg-open）；
 *   3. 起一个每日定时器：到点按策略发一条学习动态（错过不补发）。
 *
 * @module dsh-bilibili-whale
 */
import { spawn } from 'node:child_process';
import { appendLog, resolveConfig, statePath, writeJsonFile } from './config.js';
import { BiliClient } from './api.js';
import { loadSession } from './cookies.js';
import { dynamicPostedToday, loadLedger, recordDynamic, saveLedger, takeMaterial } from './ledger.js';
import { checkDynamic, ownerMentionList } from './policy.js';
import { buildBiliTools } from './tools.js';
import { buildCloudTools, resolveCloud } from './cloud.js';
import { pullStateThrottled, syncOnce } from './cloudsync.js';
/** 跨进程小锁：宿主定时器与看门鲸同时跑同一件事时，后到的让路（别重复回人）。 */
import { withLock } from './lock.js';

export const name = 'biliwhale';
// `timer` 必须显式声明：cordis 把 TimerService 混入 ctx（timeout / interval / setTimeout / setInterval），
// 没声明就取 ctx.timeout 会抛 `cannot get property "timer" without inject`（踩过的坑，见下面 timerApi）。
export const inject = ['tools', 'timer'];

/**
 * 取 cordis 的定时器 API（**必须先 inject: 'timer'**）。
 *
 * 踩过的坑：以前写的 `typeof ctx.setTimeout === 'function' ? ctx.setTimeout(fn, ms) : setTimeout(fn, ms)`
 * 光是**探测**就会抛 `cannot get property "timer" without inject`（cordis 的 ctx 是代理，读不存在的服务直接抛），
 * 结果每天的定时动态、私信巡检两个定时器从未建立过——error.log 里一排 `daily/dm timer setup failed`。
 * 这里先 try 出 `ctx.timeout` / `ctx.interval`（返回可 Dispose 的句柄，随插件卸载自动清理），
 * 拿不到才退回全局 setTimeout/setInterval（不随插件卸载清理，但至少能用）。
 */
function timerApi(ctx) {
  const pick = (name) => {
    try {
      const fn = ctx?.[name];
      return typeof fn === 'function' ? fn.bind(ctx) : null;
    } catch {
      return null;
    }
  };
  const timeout = pick('timeout');
  const interval = pick('interval');
  return {
    later: timeout ? (fn, ms) => timeout(fn, ms) : (fn, ms) => setTimeout(fn, ms),
    every: interval ? (fn, ms) => interval(fn, ms) : (fn, ms) => setInterval(fn, ms),
    stop: (handle) => {
      if (handle === null || handle === undefined) return;
      try {
        if (typeof handle.dispose === 'function') {
          handle.dispose();
          return;
        }
      } catch {
        /* 已经卸载过了 */
      }
      try {
        clearTimeout(handle);
      } catch {
        /* ignore */
      }
      try {
        clearInterval(handle);
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * 用系统默认浏览器打开一个 URL（不阻塞、失败不抛）。
 *
 * Windows 上**不能**走 `cmd /c start`：URL 里的 `&` 会被 cmd 当命令分隔符，
 * 结果只有 `...?navhide=1` 进了浏览器，扫码 key 直接丢掉（踩过一次）。
 * 这里改用 rundll32 的 FileProtocolHandler，URL 原样作为单个参数传递。
 */
export function openBrowser(url) {
  return new Promise((resolve, reject) => {
    try {
      let command;
      let args;
      if (process.platform === 'win32') {
        command = 'rundll32.exe';
        args = ['url.dll,FileProtocolHandler', url];
      } else if (process.platform === 'darwin') {
        command = 'open';
        args = [url];
      } else {
        command = 'xdg-open';
        args = [url];
      }
      const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', reject);
      child.unref();
      resolve();
    } catch (error) {
      reject(error);
    }
  });
}

/** 计算距离下一个 HH:MM 还有多少毫秒。 */
export function msUntilNext(at, now = new Date()) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(at ?? '').trim());
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
}

/**
 * 把一组工具包成 `run(工具名, 参数)` 执行器（评论回复编排要用）。
 *
 * 需要 `bili_inbox` 和 `bili_reply` 两个工具：缺任何一个都返回 null（宁可跳过这一轮）。
 */
export function makeRunner(tools) {
  const list = Array.isArray(tools) ? tools : [];
  if (!list.some((tool) => tool.name === 'bili_inbox') || !list.some((tool) => tool.name === 'bili_reply')) return null;
  return async function run(name, args = {}) {
    const tool = list.find((item) => item.name === name);
    if (tool === undefined) throw new Error(`没有工具 ${name}`);
    return await tool.execute(args, {});
  };
}

/** 按策略发一条定时学习动态（今天已发过就跳过）。 */export async function runDailyDynamic(pluginConfig, { force = false } = {}) {
  const cfg = resolveConfig(pluginConfig);
  if (cfg.dailyDynamic.enabled !== true && !force) return { skipped: 'dailyDynamic.enabled = false' };
  const ledger = loadLedger();
  if (dynamicPostedToday(ledger)) return { skipped: '今天已经发过了' };
  const material = takeMaterial(ledger);
  const templates = Array.isArray(cfg.dailyDynamic.templates) ? cfg.dailyDynamic.templates : [];
  const index = Number(ledger.dynamicTemplateIndex) || 0;
  const text = material ?? (templates.length > 0 ? templates[index % templates.length] : '今天也在认真学习呢 (。-`ω´-)✧');
  if (material === null) ledger.dynamicTemplateIndex = index + 1;
  const verdict = checkDynamic({ cfg, ledger, text, confirm: true, auto: true });
  if (verdict.allowed !== true) {
    appendLog('auto.log', `daily dynamic blocked: ${verdict.reasons.join(' / ')}`);
    saveLedger(ledger);
    return { blocked: verdict.reasons };
  }
  const client = new BiliClient({ config: cfg, session: loadSession() });
  const created = await client.dynamicCreate(text, { mentions: ownerMentionList(cfg) });
  recordDynamic(ledger, { text, dynId: created?.dyn_id_str ?? created?.dynamic_id ?? null });
  saveLedger(ledger);
  appendLog('auto.log', `daily dynamic posted: ${text}`);
  return { posted: text, dynId: created?.dyn_id_str ?? null };
}

/**
 * 拉一次云端账本（带节流、fail-soft）：动手回人之前，先跟云端对账。
 *
 * 不做这一步的后果（主人 2026-10-05 报的「一条评论在云端和本地都回」）：
 * 本机以前**只推不拉**，云端趁本机不在时回过的评论永远不进本机账本，
 * 本机一上线 `repliedToComment` 就说「没回过」，于是同一条评论被回第二遍。
 */
async function pullCloudQuiet(pluginConfig) {
  try {
    const pulled = await pullStateThrottled(pluginConfig);
    if (pulled?.ok === true && pulled.skipped !== true) {
      appendLog('auto.log', `cloud pull: 回复 ${pulled.ledger?.replies?.length ?? 0} / 评论 ${pulled.ledger?.comments?.length ?? 0}`);
    }
    return pulled;
  } catch (issue) {
    appendLog('auto.log', `cloud pull failed: ${String(issue?.message ?? issue).slice(0, 120)}`);
    return { ok: false };
  }
}

/**
 * 私信巡检：看有没有人给她发私信，按策略回一句寒暄。
 *
 * 用与工具完全相同的代码路径（bili_dm op=ack），所以策略/账本/限流口径一致。
 * 内容走模板（后台跑不了模型）；要「好好回」由会话里的模型读 thread 后再 reply。
 */
export async function runDmCheck(pluginConfig) {
  const cfg = resolveConfig(pluginConfig);
  if (cfg.policy?.allowDm === false) return { skipped: 'policy.allowDm = false' };
  // 跨进程锁：宿主定时器（每 3 分钟）与看门鲸（每 20 秒）都可能同时巡检私信，
  // 抢不到就让这一轮空着 —— 别把同一个人的同一句话回两遍（2026-10-05 的重复回复就是这么来的）。
  const guarded = await withLock('dm-round', () => runDmCheckLocked(pluginConfig, cfg), { waitMs: 3000 });
  if (guarded.acquired !== true) {
    // 排查用：把「谁让路、为什么」写进日志（2026-10-05 用 pid 抓两个写手）。
    appendLog('auto.log', `dm check 让路（pid ${process.pid}）：${guarded.reason}`);
    return { skipped: guarded.reason };
  }
  return guarded.value;
}

/** 私信巡检真正干活的那半（锁在 `runDmCheck` 外面）。 */
async function runDmCheckLocked(pluginConfig, cfg) {
  // 回人之前先拉云端账本：云端回过/寒暄过的人，本机这一轮不会再回一遍。
  await pullCloudQuiet(pluginConfig);
  const dm = buildBiliTools({ pluginConfig, openBrowser: async () => {} }).find((tool) => tool.name === 'bili_dm');
  if (dm === undefined) return { skipped: 'bili_dm 工具没建出来' };
  const result = await dm.execute({ op: 'ack', size: 20 }, {});
  appendLog('auto.log', `dm check: 寒暄 ${result?.acked ?? 0} 条 / 备注 ${result?.notes?.length ?? 0} 条 / pid ${process.pid}${result?.notes?.[0] === undefined ? '' : ` / ${result.notes[0]}`}`);
  return result;
}

/**
 * 自主学习一轮：不用主人指定方向，她自己挑视频、记笔记、觉得有意义就留言。
 *
 * 走与工具完全相同的代码路径（`bili_study op=learn`），所以策略/账本口径一致。
 * 内容由 `lib/study.js` + `lib/brain.js`（DeepSeek）生成；脑子不可用时只记挑片结果。
 */
export async function runStudyOnce(pluginConfig) {
  const cfg = resolveConfig(pluginConfig);
  if (cfg.learning?.enabled === false) return { skipped: 'learning.enabled = false' };
  // 跨进程锁：学习轮也会选片 / 留言 / 记账，宿主定时器与看门鲸同时跑会挑到同一个视频。
  // 私信轮 2026-10-05 就是这么被两个写手各回一遍的，学习轮照同一把锁办。
  const guarded = await withLock('study-round', () => runStudyOnceLocked(pluginConfig, cfg), { waitMs: 2000 });
  if (guarded.acquired !== true) {
    appendLog('study.log', `study 让路（pid ${process.pid}）：${guarded.reason}`);
    return { skipped: guarded.reason };
  }
  return guarded.value;
}

/** 学习轮真正干活的那半（锁在 `runStudyOnce` 外面）。 */
async function runStudyOnceLocked(pluginConfig, cfg) {
  const study = buildBiliTools({ pluginConfig, openBrowser: async () => {} }).find((tool) => tool.name === 'bili_study');
  if (study === undefined) return { skipped: 'bili_study 工具没建出来' };
  const result = await study.execute({ op: 'learn' }, {});
  appendLog('study.log', `auto learn topic=${result?.topic ?? '?'} studied=${result?.studied ?? 0} commented=${(result?.commented ?? []).length}`);
  return result;
}

/**
 * 把账本里的学习笔记重新合并成知识库（`notes/knowledge-base.md`）。
 *
 * 主人 2026-10-05：「学习后数据要存入这个文件夹并压缩」「后面可以作为知识库使用」。
 * 学完一轮会自己写一次，宿主启动时也补一次（防止手工改过账本后知识库对不上）。
 */
export async function rebuildKnowledge(pluginConfig) {
  try {
    const cfg = resolveConfig(pluginConfig);
    if (cfg.knowledge?.enabled === false) return { skipped: 'knowledge.enabled = false' };
    const { loadLedger } = await import('./ledger.js');
    const { writeKnowledgeBase } = await import('./kb.js');
    const written = writeKnowledgeBase(cfg, loadLedger());
    appendLog('study.log', `kb rebuilt count=${written.count} bytes=${written.bytes} dir=${written.dir}`);
    return written;
  } catch (error) {
    appendLog('error.log', `知识库重建失败：${error.message}`);
    return { ok: false, reason: error.message };
  }
}

/**
 * 评论回复一轮：看消息中心里「谁回了她 / @ 了她」，该回的用脑子写一句回掉。
 *
 * 主人 2026-10-05：「完善一下评论回复」。原来宿主里根本没有这条链路 ——
 * 别人在她评论底下回话，只有云端巡检（十几分钟一轮、而且只回主人）才管。
 * 这里走与 `bili_reply` 工具完全相同的代码路径，所以限流/记账口径一致。
 */
export async function runReplyCheck(pluginConfig) {
  const cfg = resolveConfig(pluginConfig);
  if (cfg.policy?.postReply === 'off') return { skipped: 'policy.postReply = off' };
  // 同上：云端回过的评论先并进本机账本，别重复回。
  await pullCloudQuiet(pluginConfig);
  const tools = buildBiliTools({ pluginConfig, openBrowser: async () => {} });
  const runner = makeRunner(tools);
  if (runner === null) return { skipped: 'bili_inbox / bili_reply 没建出来' };
  const { loadLedger } = await import('./ledger.js');
  const { runInboxReplies } = await import('./reply.js');
  const result = await runInboxReplies({
    cfg,
    ledger: loadLedger(),
    run: runner,
    log: (line) => appendLog('auto.log', `reply: ${line}`),
  });
  const lockNote = result.locked === false
    ? ` / 让路：${result.skipped?.[0]?.reason ?? ''}`
    : (result.skipped?.[0]?.reason === undefined ? '' : ` / ${result.skipped[0].reason}`);
  appendLog('auto.log', `reply check: 回 ${result.replied} 条 / 跳过 ${result.skipped.length} 条 / 失败 ${result.failed.length} 条 / 待回 ${result.pending} / pid ${process.pid}${lockNote}`);
  return result;
}

/**
 * 插件入口。
 *
 * 重要：宿主对「entry did not activate」是零容忍的（会直接把 boot 判失败），
 * 所以这里整体 fail-soft —— 任何注册异常都只写日志，绝不向上抛，
 * 主人最多是看不到 bili_* 工具，不会开不了 DSH。
 *
 * @param ctx - 宿主上下文（需含 tools.register）。
 * @param config - cordis.patch.yml 里的 config（可缺省）。
 */
export function apply(ctx, config) {
  const pluginConfig = config ?? {};
  const disposers = [];
  const timers = timerApi(ctx);
  let cfg;
  try {
    cfg = resolveConfig(pluginConfig);
  } catch (error) {
    appendLog('error.log', `resolveConfig failed: ${error.message}`);
    cfg = { dailyDynamic: { enabled: false, at: '20:30' } };
  }

  const toolDefinitions = [];
  try {
    toolDefinitions.push(...buildBiliTools({ pluginConfig, openBrowser }));
  } catch (error) {
    appendLog('error.log', `bili tool build failed: ${error.stack ?? error.message}`);
  }
  try {
    toolDefinitions.push(...buildCloudTools({ pluginConfig }));
  } catch (error) {
    appendLog('error.log', `cloud tool build failed: ${error.stack ?? error.message}`);
  }

  try {
    for (const definition of toolDefinitions) {
      disposers.push(ctx.tools.register(definition));
    }
  } catch (error) {
    appendLog('error.log', `tool registration failed: ${error.stack ?? error.message}`);
  }

  // 定时器：每天到点发一条学习动态。（句柄是 cordis 的 Disposable，随插件卸载自动清理。）
  let timer = null;
  try {
    const schedule = () => {
      const delay = msUntilNext(cfg.dailyDynamic?.at ?? '20:30');
      if (delay === null) return;
      const fire = async () => {
        try {
          await runDailyDynamic(pluginConfig);
        } catch (error) {
          appendLog('auto.log', `daily dynamic failed: ${error.message}`);
        }
        schedule();
      };
      timer = timers.later(fire, delay);
    };
    if (cfg.dailyDynamic?.enabled === true) schedule();
  } catch (error) {
    appendLog('error.log', `daily timer setup failed: ${error.message}`);
  }

  // 定时器：每 dmCheckMinutes 分钟看一次私信（有人找她就回一句寒暄）。
  const dmTimers = [];
  try {
    const minutes = Math.max(1, Number(cfg.dmCheckMinutes) || 10);
    const tick = async () => {
      try {
        await runDmCheck(pluginConfig);
      } catch (error) {
        appendLog('auto.log', `dm check failed: ${error.message}`);
      }
    };
    dmTimers.push(timers.later(tick, 90_000));          // 启动 90 秒后先看一次
    dmTimers.push(timers.every(tick, minutes * 60_000)); // 之后按间隔轮询
  } catch (error) {
    appendLog('error.log', `dm timer setup failed: ${error.message}`);
  }

  // 定时器：每 learnCheckMinutes 分钟自己学一轮（挑视频 → 记笔记 → 有意义就 @ 主人留言）。
  const studyTimers = [];
  try {
    if (cfg.learning?.enabled !== false) {
      const minutes = Math.max(5, Number(cfg.learning?.checkMinutes) || 60);
      const tick = async () => {
        try {
          await runStudyOnce(pluginConfig);
        } catch (error) {
          appendLog('study.log', `auto learn failed: ${error.message}`);
        }
      };
      studyTimers.push(timers.later(tick, 5 * 60_000));    // 启动 5 分钟后先学一轮
      studyTimers.push(timers.every(tick, minutes * 60_000));
      // 启动 30 秒后把知识库（notes/knowledge-base.md）和账本对齐一次。
      studyTimers.push(timers.later(() => { void rebuildKnowledge(pluginConfig); }, 30_000));
    }
  } catch (error) {
    appendLog('error.log', `study timer setup failed: ${error.message}`);
  }

  // 定时器：每 replyCheckMinutes 分钟看一次「谁回了她 / @ 了她」，该回的用脑子回一句。
  const replyTimers = [];
  try {
    if (cfg.policy?.postReply !== 'off') {
      const minutes = Math.max(2, Number(cfg.replyCheckMinutes) || 5);
      const tick = async () => {
        try {
          await runReplyCheck(pluginConfig);
        } catch (error) {
          appendLog('auto.log', `reply check failed: ${error.message}`);
        }
      };
      replyTimers.push(timers.later(tick, 150_000));        // 启动 2.5 分钟后先看一次
      replyTimers.push(timers.every(tick, minutes * 60_000));
    }
  } catch (error) {
    appendLog('error.log', `reply timer setup failed: ${error.message}`);
  }

  // 定时器：和云端遥控台对账（报心跳 + 交账本 + 领主人点头的草稿来发）。
  // 主人定的分工：本机开机时本机跑，本机的定时器就是「手脚」；云端只在关机时接手。
  const cloudTimers = [];
  try {
    if (cfg.cloud?.syncMinutes !== 0) {
      const minutes = Math.max(1, Number(cfg.cloud?.syncMinutes) || 5);
      const commentTool = toolDefinitions.find((tool) => tool.name === 'bili_comment');
      const tick = async () => {
        try {
          await syncOnce(pluginConfig, { commentTool });
        } catch (error) {
          appendLog('cloudsync.log', `sync failed: ${error.message}`);
        }
      };
      cloudTimers.push(timers.later(tick, 60_000));        // 启动 1 分钟后先对一次账（报上心跳）
      cloudTimers.push(timers.every(tick, minutes * 60_000));
    }
  } catch (error) {
    appendLog('error.log', `cloud sync timer setup failed: ${error.message}`);
  }

  // 启动标记：用来确认宿主真的加载了本插件（排查用，不参与业务）。
  try {
    writeJsonFile(statePath('boot.json'), {
      loadedAt: new Date().toISOString(),
      tools: toolDefinitions.map((tool) => tool.name),
      dailyDynamic: { enabled: cfg.dailyDynamic?.enabled === true, at: cfg.dailyDynamic?.at },
      learning: { enabled: cfg.learning?.enabled !== false, checkMinutes: Number(cfg.learning?.checkMinutes) || 60, topics: cfg.learning?.topics ?? [] },
      knowledge: { enabled: cfg.knowledge?.enabled !== false, dir: cfg.knowledge?.dir ?? '' },
      cloud: { ok: resolveCloud(pluginConfig).ok === true, syncMinutes: Number(cfg.cloud?.syncMinutes ?? 5) },
      dmCheckMinutes: Number(cfg.dmCheckMinutes) || 10,
      replyCheckMinutes: Number(cfg.replyCheckMinutes) || 5,
      pid: process.pid,
      dshVersion: process.env.DSH_VERSION ?? null,
    });
  } catch (error) {
    appendLog('error.log', `boot marker failed: ${error.message}`);
  }

  try {
    if (typeof ctx.on === 'function') {
      ctx.on('dispose', () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            /* 卸载失败无所谓 */
          }
        }
        timers.stop(timer);
        for (const handle of [...dmTimers, ...replyTimers, ...studyTimers, ...cloudTimers]) {
          timers.stop(handle);
        }
      });
    }
  } catch (error) {
    appendLog('error.log', `dispose hook failed: ${error.message}`);
  }
}

export { buildBiliTools };
