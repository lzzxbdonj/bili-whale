# 交接：小鲸鱼娘「评论回复」收尾（2026-10-05）

> 给接手的会话：这份文件是唯一权威的交接说明。仓库 **`E:\donk\dsh-bilibili-whale`**（git 分支 `master`），
> 宿主插件装在 **`C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-bilibili-whale`**，
> 状态/日志目录 **`C:\Users\Administrator\.dsh\bilibili-whale\`**（`config.json` / `ledger.json` / `cookies.json` / `logs\auto.log` / `logs\brain.log`）。

## 1. 主人这次的诉求（原话）
- m04637：「完善一下评论回复」。
- 追加（同日）：**「评论不要每一条回复都带上 @」** → 后来明确为 **「刷完视频评论就 @，回复评论不用 @」**。
- 追加（同日）：**「回复主人的时候用付费模型」**。

## 2. 代码现状（**全部已改完，但还没提交/没部署/没同步**）
### 2.1 已落盘、六套测试全绿
`test/smoke.mjs`(17 工具) / `test/mention-dm.test.mjs` / `test/triple.test.mjs` / `test/reply.test.mjs` /
`cloudflare/test/port.test.mjs`(95) / `cloudflare/test/patrol.mock.test.mjs`(42) —— 全部 exit 0。

### 2.2 本轮新增的四处改动
1. **回复不再自动 @**（主人要求）
   - `lib/config.js` DEFAULTS：`policy.mentionOwnersOnReply = false`（新增，注释写明原因）。
   - `cloudflare/src/policy.js` DEFAULTS：**逐字镜像**了同一项（`port.test.mjs` 会逐字比对，改一边必须改另一边）。
   - `lib/compose.js` `composeCommentReply`：`const tail = isOwner && cfg?.policy?.mentionOwnersOnReply === true;`
     只有 `tail` 为真才走 `ownerSuffix` 留位 + `withOwnerMentions` 补尾巴。
   - `lib/compose.js` `buildReplyPrompt` 主人版提示词改成：
     `'- 这是一条**回复**，回复不用 @ 主人（主人本来就在这个串里，会收到通知）。只有非点名不可的时候才写一次 @主人（写全昵称），平时别加。'`
   - **一级评论（刷完视频留言）仍然照旧自动 @ 两位主人**：`compose.js` 的 `composeVideoComment`（第 ~60 行 `withOwnerMentions`）、
     `lib/tools.js:703/709`、`lib/study.js:244` 都没动 —— 这是主人要的「刷完视频评论就 @」。
2. **回主人用付费模型**（主人要求）
   - `lib/brain.js`：`DEFAULT_BRAIN.paid = 'deepseek'`；`brainConfig()` 回 `merged.paid`；
     `attemptList(brain, prefer)` 支持把点名的 provider 提到最前（`prefer: 'paid'` → `brain.paid`，那家没 key 就自动跳过）；
     `askBrain(cfg, { system, user, maxTokens, temperature, prefer })`；命中付费时往 `logs/brain.log` 写一行
     `这次先用 deepseek（付费）`（grep 这个就能证明走没走付费）。
   - `lib/compose.js` `composeCommentReply`：`askArgs = { system, user, prefer: isOwner ? 'paid' : '' }`。
   - `lib/brain.js` `composeDmReply`（私信，第 ~300 行）：同样 `prefer: isOwner ? 'paid' : ''`。
   - 陌生人（评论 + 私信）保持免费额度（`prefer: ''`）。
   - `lib/config.js` DEFAULTS.brain 与 `cloudflare/src/policy.js` DEFAULTS.brain 都加了 `paid: 'deepseek'`（镜像）。
3. **脑子抽风重试**：`lib/compose.js` 加 `const RETRY_DELAY_MS = 800;`，`composeCommentReply` 第一次 `null` 时隔 0.8s 再问一次（最多两次）。
4. **测试与注释**：`test/reply.test.mjs` 更新（默认不带 @、`mentionOwnersOnReply: true` 才补尾巴、主人 `prefer === 'paid'` / 陌生人 `prefer === ''`、
   重试一次成功 / 一直失败仍返回 null 且最多问两次），文件头注释和结尾成功文案也改了。

### 2.3 上一段遗留、**同样还没提交**的改动（`1d8211a` 之后）
- `lib/api.js`：`normalizeMsgReply` 重写（消息中心字段真相见 §5）、`commentAdd` 加 `type`/`referer`。
- `lib/reply.js`：挑人按 root 去重 + `repliedInRoot`、动态 id 用字符串、`referer` 传 opus 地址、business 白名单放宽。
- `lib/tools.js`：`bili_reply` 支持 `kind: 'dynamic'` + 透传 `referer`。
- `cloudflare/src/bili.js`（镜像归一化 + `commentAdd` referer/type）、`cloudflare/src/patrol.js`（动态/视频判定、opus referer）、
  `cloudflare/src/store.js`（`REPLY_PER_RUN` / `REPLY_PER_RUN_OTHERS` / `REPLY_TO_OTHERS`）。
- `test/mention-dm.test.mjs`、`cloudflare/test/port.test.mjs` 的夹具改成**真实报文形状**。

## 3. 还没做的事（接手第一件事就是这几步，按顺序）
```powershell
cd E:\donk\dsh-bilibili-whale
# ① 先删我这轮留下的临时脚本（都带 _tmp- 前缀）
Remove-Item _tmp-*.mjs -Force
# ② 六套测试再跑一遍（应全绿）
node test/smoke.mjs; node test/mention-dm.test.mjs; node test/triple.test.mjs; node test/reply.test.mjs
node cloudflare/test/port.test.mjs; node cloudflare/test/patrol.mock.test.mjs
# ③ 提交推送
git add -A; git commit -m "feat(reply): 回复不带 @ / 回主人走付费脑子 / 脑子抽风重试 + 消息中心字段修正"; git push origin master
# ④ 部署 Worker（cloudflare/src/{policy,bili,patrol,persona,store}.js 都变了；线上还停在 bc22977a-1d3b-4404-af03-342b7414d574）
$env:HTTPS_PROXY='http://127.0.0.1:19451'; npx --yes wrangler@4 deploy --cwd cloudflare
# ⑤ 同步 profile（宿主插件）并在 profile 侧跑冒烟
Copy-Item -Recurse -Force E:\donk\dsh-bilibili-whale\{lib,persona,skills,test,tools,cloud,cloudflare,notes} C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-bilibili-whale\
Copy-Item -Force E:\donk\dsh-bilibili-whale\package.json,E:\donk\dsh-bilibili-whale\README.md C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-bilibili-whale\
# ⑥ 重启看门鲸（现在跑的是旧代码：pid 19996，10:13 起的）
#    先 Get-Process node | 看命令行，确认是 dm-watch 再 kill；然后：
#    cd E:\donk\dsh-bilibili-whale; Start-Process D:\360Downloads\node.exe -ArgumentList 'tools/dm-watch.mjs','--minutes','0.33','--sync-every','15','--reply-every','15' -RedirectStandardOutput dm-watch.log
# ⑦ 真机跑一轮评论回复（走的就是宿主定时器那条路）：跑一个临时脚本 `await runReplyCheck({ userConfig: readUserConfig() })`，
#    然后看 C:\Users\Administrator\.dsh\bilibili-whale\logs\auto.log 尾部的 `reply check: 回 N 条 / 跳过 N 条 / 失败 N 条 / 待回 N`
#    和 logs/brain.log 里有没有 `这次先用 deepseek（付费）`。
```
最后提醒主人一句：**宿主（DSH）要重启**才会加载新的评论回复定时器与提示词。

## 4. 当前真机状态（截至交接）
- 看门鲸：pid **19996**，命令行 `D:\360Downloads\node.exe tools/dm-watch.mjs --minutes 0.33 --sync-every 15 --reply-every 15`，cwd 仓库根，日志 `dm-watch.log`（**内存里是旧 normalizer / 旧 @ 行为**）。
- Worker 线上版本：**`bc22977a-1d3b-4404-af03-342b7414d574`**（落后于仓库里的 `cloudflare/src`）。
- 已真发出去的回复（账本 `ledger.json` 的 `replies[]`，都已 @ 两位主人 —— 那是旧行为）：
  - `BV1UAYd6WE2t`（主人以 @ 通知她那条）：`rpid 316071900673` → 她回的那条 `selfRpid 316075810305`。
  - `BV16T4y1k7dB`（科技学习视频那条评论）：`rpid 316074512241` → `selfRpid 316075759185`。
- **还欠一条**：`BV1oC4y1k7iT`（主人说「又去偷懒刷视频了」那条）几次都因为脑子抽风没发出去，`bili_inbox op=check` 仍显示「待回 4」。
- 主人账号：`懒寻真` mid `3494364865103885`、`金易木木元` mid `391581639`；她 `bili_83352132154` mid `3747560556595480`。
- 配置（`config.json` 的 userConfig）：`policy.postVideoComment:'auto'`、`policy.postTriple:'auto'`、`dmCheckMinutes: 1`（其余用 DEFAULTS）。

## 5. 踩过的坑 / 事实（别再重新踩）
- **消息中心字段**（`/x/msgfeed/reply` 与 `/x/msgfeed/at`，真机核对过）：
  `item.source_content` = **对方说的那句**；`item.root_reply_content` = **她自己原来那条**（评论消息里 `item.title` 就等于它，不是视频标题，@ 我的里 `title` 才是视频标题）；
  `item.source_id` = 对方那条评论的 rpid（回它才回在同一串）；视频 oid 在 `subject_id`；动态 id 在 `uri` 的 `/opus/<18 位雪花号>`
  —— **雪花号必须留字符串**（转 Number 会掉精度成 …300）；`business` 是中文「评论」/「动态」，`business_id` 只是分区码。
- **@ 我的消息里 `oid`/`source_id` 是那条 @ 评论的 rpid，不是被评论对象** ⇒ 有 BV 号按视频（用 BV 号），`business` 是动态且无 BV 号才按动态（用 `subject_id`/opus id）。
- `lib/ledger.js` 的账本工厂叫 **`emptyLedger()`**（`createLedger` 是 `cloudflare/src/ledger.js` 的）。
- `appendLog(file, line)` 写的是 **`<dshHome>/bilibili-whale/logs/<file>`**（不是状态目录根）。
- 本机 Node 的 `fetch` 不认系统代理、且 `workers.dev` 的 DNS 被污染 ⇒ 走 `lib/httpx.js`；跑 wrangler / 云端请求前先
  `$env:HTTPS_PROXY='http://127.0.0.1:19451'`。云端出口被 B 站 -412 ⇒ **写操作永远不给 Worker 加端点**，写活交给「手脚」（本机看门鲸 / GitHub Actions）。
- PowerShell 用 `.Replace()` 改多行 JS 会把 `` `n `` 变成字面量（`SyntaxError: Unexpected identifier 'n'`）⇒ 多行改动一律用编辑工具。
- **免费脑子间歇性抽风**（实测）：Worker `/brain` 连续 502 `模型报错：8006: Invalid data for body - reason must be valid JSON`、
  `pollinations` 500 `ENOSPC`、`deepseek`（兜底）偶发 400；但同一时刻用 curl / `cloudRequest` 直接打 `/brain` 又是好的 ⇒ **是突发性的，不是配置错**。
  本轮已经加了「失败重试一次」；真要更稳，可考虑给 Worker 配 `DEEPSEEK_API_KEY` 让云端也能用付费模型（**没做，需要主人同意加 secret**）。

## 6. 未解决 / 待主人确认
1. 主人说过 **「把这条会话的模式调到创造模式吧」**：我在 `E:\donk` 下**没找到** `.dsh/skills/learning-system`（`E:\donk\.dsh` 不存在），
   全仓库搜「创造模式」/`creative` 也没有命中 ⇒ **需要主人指路**（模式定义在哪儿？是宿主设置里的开关，还是 StudyMate 技能里的 mode 字段？
   相关目录候选：`E:\donk\study-mate`、`E:\donk\study-mate-android`、`E:\donk\.studymate-stage`、`E:\donk\studymate-deploy`）。
2. Worker 自己的巡检（`cloudflare/src/patrol.js`）里「回复主人」仍然只能用 Workers AI（免费），**没走付费模型** —— 要不要也接付费 key，等主人点头。
3. 更早的开放目标：**云端整套跑通**（m02160/m02757）；**宿主重启**加载本机新代码（真 @ 动态 / 免费脑子 / 知识库 / 30 秒私信巡检 / 定时器修复 / 三连 / 本次评论回复）；
   陌生人私信也用免费模型（m03698，代码早已完成）。
