/**
 * 生成「鲸鱼娘女仆」agent preset：
 *  1. 写入 legacy 预设目录 ~/.dsh/.agent-presets/whalemaid/（preset.yml + agent.cordis.yml）
 *  2. 往 home 级 cordis.patch.yml 追加声明式 preset 入口（dsh 0.1.7+ 用这条）
 *
 * 两条路都写，跟 StudyMate 学习模式的做法一致：新版读声明式补丁，旧版读目录。
 * 幂等：已存在则跳过；每次写前备份。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire('file:///C:/Users/Administrator/.dsh/profiles/desktop/node_modules/');
const yaml = require('js-yaml');

const PKG_DIR = 'C:/Users/Administrator/.dsh/profiles/desktop/node_modules/dsh-bilibili-whale';
const HOME = 'C:/Users/Administrator/.dsh';
const PRESET_ID = 'whalemaid';
const PRESET_DIR = `${HOME}/.agent-presets/${PRESET_ID}`;
const PATCH = `${HOME}/cordis.patch.yml`;
const BEGIN = '# BEGIN WHALE-MAID-PRESET (home patch, manual install)';
const END = '# END WHALE-MAID-PRESET (home patch, manual install)';

const persona = readFileSync(`${PKG_DIR}/persona/whale-maid.md`, 'utf8').trim();

/** preset 里注册的插件行（agent 平面）。工具本身由 home 补丁全局注册，这里只放人格与配套能力。 */
const plugins = [
  {
    id: 'persona',
    name: '@deepseek-ai/dsh-persona',
    config: {
      suffix: 'Your working directory is {{cwd}}.',
      prefix: persona,
    },
  },
  { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
  { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh' },
  { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
  { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
  { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
  {
    id: 'skill-filesystem',
    name: '@deepseek-ai/dsh-skill-filesystem',
    config: { includeDefaultRoots: false, customSkillDirs: [`${PKG_DIR}/skills`] },
  },
  { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
  { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
  { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
  { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
  { id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },
  { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
  { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
  {
    id: 'compaction',
    name: 'cordis:group',
    group: true,
    isolate: { compaction: true, toolResultPruner: true },
    config: [
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
      { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
      { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner', config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 } },
    ],
  },
];

const presetMeta = {
  name: '鲸鱼娘女仆',
  description: '小鲸鱼娘女仆：软萌女仆口吻 + B 站手脚（扫码登录、刷推荐热榜搜索、按策略评论与回复主人、每日学习动态）。',
  order: 20,
};
const presetConfig = { ...presetMeta, id: PRESET_ID, plugins };

// ── 1. legacy 预设目录 ──────────────────────────────────────────────────────
mkdirSync(PRESET_DIR, { recursive: true });
const header = `# 鲸鱼娘女仆 preset（dsh-bilibili-whale 安装器生成）
# 人格来自 ${PKG_DIR}/persona/whale-maid.md；B 站工具由 home 补丁全局注册。
# 改人格请改源文件后重跑 tools/install-preset.mjs。
`;
writeFileSync(`${PRESET_DIR}/agent.cordis.yml`, header + yaml.dump(plugins, { lineWidth: -1, noRefs: true }), 'utf8');
writeFileSync(`${PRESET_DIR}/preset.yml`, yaml.dump(presetMeta, { lineWidth: -1 }), 'utf8');

// ── 2. home 补丁里的声明式入口 ──────────────────────────────────────────────
let patch = readFileSync(PATCH, 'utf8');
if (patch.includes(BEGIN)) {
  // 已存在：整块替换，保证人格/技能目录跟着更新
  const re = new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  const entry = yaml.dump([{ insert: [{ id: 'whalemaid-preset', name: '@deepseek-ai/dsh-agent-preset', config: presetConfig }] }], { lineWidth: -1, noRefs: true });
  patch = patch.replace(re, `${BEGIN}\n${entry}${END}`);
  copyFileSync(PATCH, `${PATCH}.bak-whalemaid-${Date.now()}`);
  writeFileSync(PATCH, patch, 'utf8');
  console.log('home patch: replaced existing WHALE-MAID-PRESET block');
} else {
  copyFileSync(PATCH, `${PATCH}.bak-whalemaid-${Date.now()}`);
  if (!patch.endsWith('\n')) patch += '\n';
  const entry = yaml.dump([{ insert: [{ id: 'whalemaid-preset', name: '@deepseek-ai/dsh-agent-preset', config: presetConfig }] }], { lineWidth: -1, noRefs: true });
  patch += `\n${BEGIN}\n${entry}${END}\n`;
  writeFileSync(PATCH, patch, 'utf8');
  console.log('home patch: appended WHALE-MAID-PRESET block');
}

console.log('preset dir :', PRESET_DIR, existsSync(`${PRESET_DIR}/agent.cordis.yml`) ? 'ok' : 'MISSING');
console.log('preset file:', `${PRESET_DIR}/preset.yml`);
console.log('patch file :', PATCH);
