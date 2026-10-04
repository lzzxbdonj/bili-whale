/**
 * 校验 home 级 cordis.patch.yml 仍是合法 YAML，并列出补丁结构。
 * 用自定义类型吃掉 !!js 标签（真身是 JS 表达式，这里只当字符串看）。
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire('file:///C:/Users/Administrator/.dsh/profiles/desktop/node_modules/');
const yaml = require('js-yaml');

const JsType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: () => true,
  construct: (data) => ({ __jsExpr: data }),
});
const schema = yaml.DEFAULT_SCHEMA.extend([JsType]);

const path = 'C:/Users/Administrator/.dsh/cordis.patch.yml';
const text = readFileSync(path, 'utf8');
let doc;
try {
  doc = yaml.load(text, { schema });
} catch (error) {
  console.error('YAML 解析失败：', error.message);
  process.exit(1);
}
const items = Array.isArray(doc) ? doc : [];
console.log(`YAML OK：根节点 ${Array.isArray(doc) ? '数组' : typeof doc}，${items.length} 个补丁条目`);
items.forEach((item, index) => {
  const inserts = Array.isArray(item?.insert) ? item.insert : [];
  for (const row of inserts) {
    const id = row?.id ?? row?.name ?? '(no id)';
    const preset = row?.config?.plugins ? ` preset=${row.config.id}(${row.config.name}) plugins=${row.config.plugins.length}` : '';
    console.log(`  [${index}] insert id=${id} name=${row?.name}${preset}`);
  }
});
