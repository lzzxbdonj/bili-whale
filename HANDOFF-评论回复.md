# 交接：小鲸鱼娘「评论回复」收尾（2026-10-05，**第二轮：已完成**）

> 给接手的会话：这份文件是唯一权威的交接说明。仓库 **`E:\donk\dsh-bilibili-whale`**（git 分支 `master`），
> 宿主插件装在 **`C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-bilibili-whale`**，
> 状态/日志目录 **`C:\Users\Administrator\.dsh\bilibili-whale\`**（`config.json` / `ledger.json` / `cookies.json` / `logs\auto.log` / `logs\brain.log`）。
>
> **上一轮交接里「还没做的事」①–⑦ 已全部做完，另外查出并修掉了两个真 bug。** 见 §3。

## 1. 主人的诉求（原话）
- m04637：「完善一下评论回复」。
- 追加（同日）：**「评论不要每一条回复都带上 @」** → 后来明确为 **「刷完视频评论就 @，回复评论不用 @」**。
- 追加（同日）：**「回复主人的时候用付费模型」**。

## 2. 本轮已完成（都已提交 / 已部署 / 已同步 / 已真机验证）
### 2.1 提交
- **`b89bae1`** `feat(reply): 回复不带 @ / 回主人走付费脑子 / 脑子抽风重试 + 消息中心字段修正`
  （15 文件；含上一轮遗留的 `lib/api.js` 消息中心字段修正、`lib/reply.js` 挑人、动态评论 `type=17`、Worker 侧镜像。）
- **`d2265a3`** `fix(brain): 孤立代理项让两条脑子全挂 —— 截断不劈 emoji + 出口清代理项 + 同一条评论只回一次`
  （15 文件 +518/-40；新增 `lib/text.js`、`cloudflare/src/text.js`、`test/text.test.mjs`。）
- 都已 `git push origin master`。

### 2.2 部署
- Worker 线上版本：**`f9d564fb-84be-4d65-905a-8586dcd307e1`**
  （此前依次是 `bc22977a-1d3b-4404-af03-342b7414d574` → `4c304060-7e32-4a3a-9020-3de52327c0ba` → 现在这个）。
- 部署命令（必须带代理）：`$env:HTTPS_PROXY='http://127.0.0.1:19451'; npx --yes wrangler@4 deploy --cwd cloudflare`

### 2.3 配置现状（`config.json` 的 userConfig）
`ownerName 懒寻真` / `ownerMid 3494364865103885` / `ownerNames [懒寻真, 金易木木元]` /
`ownerMids [3494364865103885, 391581639]` / `whaleName bili_83352132154` / `whaleMid 3747560556595480` /
`dmCheckMinutes 1` / `policy { maxDmReplyPerUserPerDay:20, minIntervalSecondsOwner:5, postVideoComment:'auto', postTriple:'auto' }`。
其余用 `lib/config.js` 的 DEFAULTS（注意 `policy.mentionOwnersOnReply: false`、`brain.paid: 'deepseek'` 这两个新项，云端 `cloudflare/src/policy.js` 是**逐字镜像**，改一边必须改另一边，`port.test.mjs` 会比对）。

### 2.4 测试（七套全绿，改动后请照跑）
```powershell
cd E:\donk\dsh-bilibili-whale
node test/smoke.mjs; node test/mention-dm.test.mjs; node test/triple.test.mjs; node test/reply.test.mjs; node test/text.test.mjs
node cloudflare/test/port.test.mjs; node cloudflare/test/patrol.mock.test.mjs
```

### 2.5 真机验证（真的发出去了）
- `BV1UAYd6WE2t`（主人那条「@寻和橼的大肥鱼dsh 要这样@」）：`rpid 316071900673` → `selfRpid 316077035713`。
- `BV1oC4y1k7iT`（主人「又去偷懒刷视频了」——上一轮欠的那条）：`rpid 316075381585` → `selfRpid 316077335425`。
- 两条都走了付费脑子：`logs/brain.log` 里 `这次先用 deepseek（付费）` 后面**没有失败行**。

### 2.6 守护进程
- 看门鲸：pid **17468**，命令行 `D:\360Downloads\node.exe tools/dm-watch.mjs --minutes 0.33 --sync-every 15 --reply-every 15`，cwd 仓库根，日志 `dm-watch.log`（**已是新代码**）。
  启动时要在**同一个 shell** 里先 `$env:HTTPS_PROXY='http://127.0.0.1:19451'` 再 `Start-Process`（子进程继承环境变量，云端心跳/对账才走得通）。

### 2.7 还剩两条待回（交给看门鲸/宿主定时器自然发，别手动催）
`node` 跑一遍只读检查（见 §5 的脚本）会看到：
1. `rpid 316076035841` / `root 316074039329` —— 主人懒寻真在 `BV16T4y1k7dB` 串里的**新话**（`bili_inbox` 标了「已回过」是按「串+人」算的，主人免检，**该回**）。
2. `rpid 316048667233` / `root 316048667233` —— 陌生人「我的小千1」在**动态** `1255384434914361365` 下的评论。
限流是 `minIntervalSecondsOwner: 5` / 陌生人 `minIntervalSeconds: 120`，且**一轮只发一条**，所以会分几轮慢慢发完。

## 3. 本轮查出的两个真 bug（**都别再踩**）
### 3.1 孤立代理项让两条脑子同时全挂（最要命）
- **症状**：主人的评论回复整整一天发不出去。`logs/brain.log` 里两家同时挂：
  - `askBrain(whale) 失败：云端返回 502：模型报错：8006: Invalid data for body - reason must be valid JSON`
  - `askBrain(deepseek) http 400: null`
- **真凶**：提示词里有一个**孤立 UTF-16 代理项**（半个 emoji）。`String.prototype.slice` 按码元切，`text.slice(0, 60)` 正好切在 emoji 代理对中间，劈出一个孤立高位代理项；`JSON.stringify` 把它写成**单飞的** `\ud83d`。
  DeepSeek 的严格解析器直接吐真话：`Failed to parse the request body as JSON: messages[1].content: unexpected end of hex escape at line 1 column 4922`；Workers AI 报 8006。**Node 自己的 `JSON.parse` 容忍这种写法**，所以本地怎么试都是好的 —— 这是当时误判成「间歇性抽风」的原因。
- **定位方法**（以后再遇到直接照抄）：给 `globalThis.fetch` 挂探针把 `options.body` 落到文件，然后扫 `messages[i].content` 的孤立代理项：
  ```js
  if (c >= 0xd800 && c <= 0xdbff) { const n = s.charCodeAt(k+1); if (!(n >= 0xdc00 && n <= 0xdfff)) /* 孤立 */ }
  ```
- **修法**（三层）：
  1. 新增 **`lib/text.js`** + 云端镜像 **`cloudflare/src/text.js`**：`stripLoneSurrogates()`（清孤立代理项，成对保留）、`clipText(value, max)`（先清→再截→再清，绝不劈对）、`safeForModel()`。
  2. **源头**：`lib/compose.js` 与 `cloudflare/src/persona.js` 里所有**字符串**的 `.slice(0, N)` 全换成 `clipText(x, N)`（数组的 `.slice` 别动！）。
  3. **出口兜底**：`lib/brain.js` 的 `askOnce()` / `askCloudBrain()` 和 `cloudflare/src/index.js` 的 `/brain`、`cloudflare/src/persona.js` 的 `aiText()`，送进模型前都过 `safeForModel(system)` / `safeForModel(user)`。
- 回归测试：`test/text.test.mjs`（含「老写法 `slice(0,60)` 确实会劈出孤立代理项」的机制复现，和「`askBrain` 真正发出去的 body 里没有单飞转义」的出口断言）。

### 3.2 同一条评论被重复回复（刷屏）
- **症状**：账本 `replies` 里两条都指向 `rpid 316071900673` —— 主人**同一条评论**被回了 40 秒内两遍，不改的话看门鲸每轮（约 5 分钟）都会再追一条。
- **原因**：两处去重都对主人网开一面 —— `lib/reply.js` 的 `if (target.answered === true && owner !== true)` 与 `if (owner !== true && repliedInRoot(ledger, root))`；`lib/tools.js` 的 `if (answered && !includeAnswered && !owner) return;`；`cloudflare/src/patrol.js` 的 `if (answered && !owner)`。`answered` 是按「串 + 人」算的（`threadReplyCount(ledger, root, mid)`），主人永远为真也永远免检。
- **修法**：新增 `repliedToComment(ledger, rpid)`（**按对方那条评论的 rpid** 认，`lib/ledger.js` 与 `cloudflare/src/ledger.js` 各一份），在三处都加一层「同一条评论只回一次，**主人也不例外**」的硬闸。
  - 关键区分：主人免的是「每人一条 / 一串一条」（他**换了新评论**还得答），不是「同一条评论追着回两遍」。
  - `lib/tools.js` 里 `answered` 也改成 `answeredRoot || answeredComment`，这样 `bili_inbox` 的「待回」计数才会归零。
- 回归测试：`test/reply.test.mjs` 第 3 节新增断言（同 rpid 不再进 `pick`、主人换新 rpid 仍照答、`repliedToComment` 的边界）。

## 4. 上一轮记下的坑（仍然有效）
- **消息中心字段**（`/x/msgfeed/reply` 与 `/x/msgfeed/at`，真机核对过）：
  `item.source_content` = **对方说的那句**；`item.root_reply_content` = **她自己原来那条**（评论消息里 `item.title` 就等于它，不是视频标题；@ 我的里 `title` 才是视频标题）；
  `item.source_id` = 对方那条评论的 rpid（回它才回在同一串）；视频 oid 在 `subject_id`；动态 id 在 `uri` 的 `/opus/<18 位雪花号>`
  —— **雪花号必须留字符串**（转 Number 会掉精度成 …300）；`business` 是中文「评论」/「动态」，`business_id` 只是分区码。
- **@ 我的消息里 `oid`/`source_id` 是那条 @ 评论的 rpid，不是被评论对象** ⇒ 有 BV 号按视频（用 BV 号），`business` 是动态且无 BV 号才按动态（用 `subject_id`/opus id）。
- `lib/ledger.js` 的账本工厂叫 **`emptyLedger()`**（`createLedger` 是 `cloudflare/src/ledger.js` 的）。
- `appendLog(file, line)` 写的是 **`<dshHome>/bilibili-whale/logs/<file>`**（不是状态目录根）。
- 本机 Node 的 `fetch` 不认系统代理、且 `workers.dev` 的 DNS 被污染 ⇒ 走 `lib/httpx.js`；跑 wrangler / 云端请求前先
  `$env:HTTPS_PROXY='http://127.0.0.1:19451'`。云端出口被 B 站 -412 ⇒ **写操作永远不给 Worker 加端点**，写活交给「手脚」（本机看门鲸 / GitHub Actions）。
  - 注意本机环境变量里有 **`NODE_USE_ENV_PROXY=1`**（Node 24），所以**设了 `HTTPS_PROXY` 之后 B 站请求也会走代理** —— 实测设着也能正常跑（看门鲸就是设着跑的）。
- PowerShell 用 `.Replace()` 改多行 JS 会把 `` `n `` 变成字面量（`SyntaxError: Unexpected identifier 'n'`）⇒ 多行改动一律用编辑工具。
- 免费脑子会真抽风（云端 Workers AI 502 / pollinations 500）⇒ `compose.js` 已加「失败隔 0.8s 重问一次」。**但先确认不是 §3.1 的孤立代理项**，别把确定性 bug 当抽风。

## 5. 排查小抄（临时脚本模式，**跑完记得删**）
```js
// 看现在还剩哪些待回（只读，不发）
import { buildBiliTools } from './lib/tools.js';
import { loadLedger } from './lib/ledger.js';
import { pickReplyTargets } from './lib/reply.js';
import { resolveConfig } from './lib/config.js';
const cfg = resolveConfig({});
const tools = buildBiliTools({ pluginConfig: {}, openBrowser: async () => {} });
const inbox = await tools.find((t) => t.name === 'bili_inbox').execute({ op: 'check', count: 30 }, {});
console.log(pickReplyTargets({ cfg, ledger: loadLedger(), inbox, selfMid: inbox?.selfMid }));
```
```js
// 真机跑一轮评论回复（会真的发）
import { runReplyCheck } from './lib/index.js';
console.log(await runReplyCheck({}));
```
日志看 `C:\Users\Administrator\.dsh\bilibili-whale\logs\{auto,brain}.log` 尾部。

## 6. 未解决 / 待主人确认
1. 主人说过 **「把这条会话的模式调到创造模式吧」**：在 `E:\donk` 下**没找到** `.dsh/skills/learning-system`（`E:\donk\.dsh` 不存在），
   全仓库搜「创造模式」/`creative` 也没命中 ⇒ **需要主人指路**（模式定义在哪儿？宿主设置里的开关，还是 StudyMate 技能里的 mode 字段？
   相关目录候选：`E:\donk\study-mate`、`E:\donk\study-mate-android`、`E:\donk\.studymate-stage`、`E:\donk\studymate-deploy`）。
2. Worker 自己的巡检（`cloudflare/src/patrol.js`）里「回复主人」仍然只能用 Workers AI（免费），**没走付费模型** —— 要不要给 Worker 也配 `DEEPSEEK_API_KEY`（需要主人同意加 secret）。
3. 更早的开放目标：**云端整套跑通**（m02160/m02757）。

## 7. ⚠️ 必须提醒主人
**宿主（DSH）要重启**才会加载新的评论回复定时器与提示词。没重启之前，本机的评论回复靠 §2.6 那只看门鲸顶着。
