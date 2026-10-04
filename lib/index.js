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
import { checkDynamic } from './policy.js';
import { buildBiliTools } from './tools.js';
import { buildCloudTools } from './cloud.js';

export const name = 'biliwhale';
export const inject = ['tools'];

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

/** 按策略发一条定时学习动态（今天已发过就跳过）。 */
export async function runDailyDynamic(pluginConfig, { force = false } = {}) {
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
  const created = await client.dynamicCreate(text);
  recordDynamic(ledger, { text, dynId: created?.dyn_id_str ?? created?.dynamic_id ?? null });
  saveLedger(ledger);
  appendLog('auto.log', `daily dynamic posted: ${text}`);
  return { posted: text, dynId: created?.dyn_id_str ?? null };
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
  const dm = buildBiliTools({ pluginConfig, openBrowser: async () => {} }).find((tool) => tool.name === 'bili_dm');
  if (dm === undefined) return { skipped: 'bili_dm 工具没建出来' };
  const result = await dm.execute({ op: 'ack', size: 20 }, {});
  appendLog('auto.log', `dm check: 寒暄 ${result?.acked ?? 0} 条 / 备注 ${result?.notes?.length ?? 0} 条`);
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

  // 定时器：每天到点发一条学习动态。用 ctx.setTimeout 优先（cordis 会随插件卸载清理）。
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
      timer = typeof ctx.setTimeout === 'function' ? ctx.setTimeout(fire, delay) : setTimeout(fire, delay);
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
    const later = (fn, ms) => (typeof ctx.setTimeout === 'function' ? ctx.setTimeout(fn, ms) : setTimeout(fn, ms));
    const every = (fn, ms) => (typeof ctx.setInterval === 'function' ? ctx.setInterval(fn, ms) : setInterval(fn, ms));
    dmTimers.push(later(tick, 90_000));          // 启动 90 秒后先看一次
    dmTimers.push(every(tick, minutes * 60_000)); // 之后按间隔轮询
  } catch (error) {
    appendLog('error.log', `dm timer setup failed: ${error.message}`);
  }

  // 启动标记：用来确认宿主真的加载了本插件（排查用，不参与业务）。
  try {
    writeJsonFile(statePath('boot.json'), {
      loadedAt: new Date().toISOString(),
      tools: toolDefinitions.map((tool) => tool.name),
      dailyDynamic: { enabled: cfg.dailyDynamic?.enabled === true, at: cfg.dailyDynamic?.at },
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
        if (timer !== null) {
          try {
            if (typeof ctx.clearTimeout === 'function') ctx.clearTimeout(timer);
            else clearTimeout(timer);
          } catch {
            /* ignore */
          }
        }
        for (const handle of dmTimers) {
          try {
            if (typeof ctx.clearInterval === 'function') ctx.clearInterval(handle);
            else if (typeof ctx.clearTimeout === 'function') ctx.clearTimeout(handle);
            else clearInterval(handle);
          } catch {
            /* ignore */
          }
        }
      });
    }
  } catch (error) {
    appendLog('error.log', `dispose hook failed: ${error.message}`);
  }
}

export { buildBiliTools };
