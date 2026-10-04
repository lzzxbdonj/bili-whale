// 往 home 级 cordis.patch.yml 追加 dsh-bilibili-whale 的插入行（幂等，带备份）。
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const patchPath = 'C:/Users/Administrator/.dsh/cordis.patch.yml';
const begin = '# BEGIN BILIBILI-WHALE (home patch, manual install)';
const end = '# END BILIBILI-WHALE (home patch, manual install)';

const block = `
${begin}
# 小鲸鱼娘女仆的 B 站手脚：10 个 bili_* 工具，对所有会话可用。
# 人格与工作流在 agent preset「鲸鱼娘女仆」里；策略配置见：
#   C:/Users/Administrator/.dsh/bilibili-whale/config.json
- insert:
    - id: biliwhale
      name: dsh-bilibili-whale
      config: {}
${end}
`;

let text = readFileSync(patchPath, 'utf8');
if (text.includes(begin)) {
  console.log('already present, skip');
  process.exit(0);
}
const backup = `${patchPath}.bak-biliwhale-${Date.now()}`;
copyFileSync(patchPath, backup);
if (!text.endsWith('\n')) text += '\n';
text += block;
writeFileSync(patchPath, text, 'utf8');
console.log('backup:', backup);
console.log('patched:', patchPath);
