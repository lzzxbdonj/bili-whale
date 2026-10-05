# 交接：小鲸鱼娘「评论回复」收尾（2026-10-05，**第六轮：私信大白话识别已上线** —— 看 §1.8）

> 给接手的会话：这份文件是唯一权威的交接说明。仓库 **`E:\donk\dsh-bilibili-whale`**（git 分支 `master`），
> 宿主插件装在 **`C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-bilibili-whale`**，
> 状态/日志目录 **`C:\Users\Administrator\.dsh\bilibili-whale\`**（`config.json` / `ledger.json` / `cookies.json` / `logs\auto.log` / `logs\brain.log`）。
>
> **上一轮交接里「还没做的事」①–⑦ 已全部做完，另外查出并修掉了两个真 bug。** 见 §3。
> **第六轮**（最新）：私信不再要求斜杠命令 —— 主人说人话她就当场办（§1.8）；云端付费脑子到底怎么配也写在 §1.8。

## 1. 主人的诉求（原话）
- m04637：「完善一下评论回复」。
- 追加（同日）：**「评论不要每一条回复都带上 @」** → 后来明确为 **「刷完视频评论就 @，回复评论不用 @」**。
- 追加（同日）：**「回复主人的时候用付费模型」**。

## 1.5 第三轮新增（主人同日晚些时候交办的三件事）
### 1.5.1 「我想让她给我转达消息一直做不到」→ 根因不是转达坏了，是她**没有手**
- 真机证据：金易木木元 00:22:05 发 `帮我提炼一下b站有关拉康精神分析的视频`，她到 10:14 连着回了 **8 次承诺**
  （「人家这就开跑啦」「已经跑到一半啦」「其实人家已经把清单和讲解都准备好了」），一件事没办；
  懒寻真也催了 5 遍（「你现在总结完之后推给他吧」「现在立刻马上发过去，不然你就是在摸鱼」）。
- **原因**：`bili_dm op=ack` 的自动回复链路（`lib/tools.js` 的 ack 分支 → `draftDmReply()` → `client.sendMsg`）
  **只会说话，没有任何执行环节**；而 `capabilityNote()` 还写着「你现在真的会…收发私信」「主人问「能不能」时…**别说自己做不到**」，
  于是模型对**任务请求**只能产出假承诺。`/restart` 也没人解析（全仓库搜 `startsWith('/')` 无命中）。
- 唯一成功的一次转达（00:02:59「另一个主人让大肥鱼转告你一句：他喜欢你」）是**真有人执行** `bili_dm op=send` —— 能力一直有，只是没人按按钮。
- **修 A**：`lib/brain.js` 的 `draftDmReply` 加三条主人侧硬规则（「你**没有手**」「绝不许说『我这就去/马上就好/已经准备好了』」「宁可认怂也别许兑不了的承诺」）；
  `lib/tools.js` 的 `capabilityNote()` 把「别说自己做不到」改成「分清**谁在按按钮**：上面那些是托管她的程序会做的事，她自己在私信里只能说话；要搜清单/要转达/要重启得主人在电脑前点一下」。
- **修 B（新模块 `lib/dmcmd.js` + `test/dmcmd.test.mjs`）**：主人私信里的**真命令走代码执行，绝不交给脑子**。
  > ⚠️ **已被 §1.8 取代**：主人后来不要斜杠命令了（「私信刷视频不要命令形式，自然语言识别」），所以命令表本身仍保留可用，
  > 但主通道改成**大白话**（`lib/intent.js`）。下面这套是它的底座。
  - `/搜 <关键词>` → 真去 `client.search`，回前三条（标题｜UP｜播放压成「万」｜时长｜BV号），压到 `maxCommentChars`(200) 以内；
  - `/转达 [昵称] <正文>` → 真 `client.sendMsg` 给另一位主人（过 `checkDm` 同一道闸门 + `recordDm` 记账）；
    开头第一个词**只有**正好是 `ownerNames` 里某位才当收件人，对不上就整串当正文（转错人比不转更糟）；
  - `/帮助` 或光一个 `/` → 命令表；**认不出来的 `/xxx` 一律回命令表，绝不丢给脑子**。
  - 接进 `lib/tools.js` 的 ack 分支：`owner === true && cfg.policy.dmCommands !== false` 时先解析命令；
    回执自己也要过 `checkDmReply`，若被「刚才那次动作」的最小间隔挡住（`/转达` 刚发过一条）就等过间隔再发一次。
  - 新开关 `policy.dmCommands: true`（`lib/config.js` 与 `cloudflare/src/policy.js` **逐字镜像**）。
- **顺手还债**：把主人等了 10 小时的拉康清单**真发了**（`bili_dm op=reply`，主人不受每日条数限制，单条 ≤200 字）：
  - 给金易木木元 3 条（10:56:39 / 10:56:54 / 10:57:08），抄给懒寻真 1 条（10:57:21），4 条都进了账本。
  - 选片：BV1BZtC68EXq(8:09 镜像阶段引子) / BV1Ff4y1h7zY(59:16 有完整骨架) / BV1M5411g7He(7:13 三界) /
    BV1Jg96BjEc9(29:46) / BV1M1t4zyEUL(53:52 有书可依) / BV1X38BzWEBn(4h19 播客)。

### 1.5.2 「让它刷视频能留下痕迹」
- 调查：`api.js:885` 的 `historyReport()`（POST `/x/v2/history/report`）**实测是通的**（报完 10:59:02 就在
  `x/web-interface/history/cursor` 里查到）；会报历史的原本只有 `lib/study.js:197`（自主学习）和 `bili_triple`。
- **真因**：`popular` / `ranking` / `rcmd` 的**原始条目全都自带 `cid`**，但 `api.js` 的 `normalizeVideo` **把 cid 丢掉了**，
  于是 `reportHistory` 拿不到 cid 只能静默跳过 → `bili_feed`（刷）和 `bili_video`（看）**一条痕都不留**。
  （`search` 的条目确实没有 cid，这类只能留本机痕。）
- 修法：
  1. `api.js normalizeVideo` 补 `cid: Number(item.cid ?? (item.pages ?? [])[0]?.cid ?? 0)` —— 刷列表报历史**零额外请求**；
  2. `lib/ledger.js` 新增 `watched[]`（`MAX_WATCHED = 400`，同一天同一条只记一次）+ `recordWatched` / `todayWatched` / `recentWatched`，
     `cloudflare/src/ledger.js` **同步镜像**（含 `snapshotLedger` 的裁剪）；
  3. `lib/triple.js` 的 `reportHistory` 改签名 `{ client, cfg, video, ledger = null, progress = 0, topic = '', source = '' }`：
     **报没报成都记一条 `watched`**（B 站历史只有她账号里看得到，主人要核「她今天刷了什么」得靠本机这份）；
  4. `bili_feed` 与 `bili_video` 都加 `history` 参数（默认 `true`，`false` 可不留痕），刷/看都会报历史 + 记 `watched`；
  5. `bili_ledger` 新增 `op=watched`：列出「今天刷到几条 / 其中几条进了 B 站浏览记录 / 最近刷到的清单」。
- 真机验证：`bili_feed source=popular count=3` → `刷视频留痕：3 条已记进账本…其中 3 条报进了 B 站浏览记录`，
  `bili_video` 也报成，`bili_ledger op=watched` 列得出来（BV1suam6sEtq / BV17pHB6tEtT / BV14sHj62EzS，`reported: true`）。

### 1.5.3 这一轮的提交与部署
- **`42ffed4`** `feat(watch): 刷视频留痕（cid 不再丢 + 账本 watched + bili_ledger op=watched）；feat(dm): 私信真命令 /搜 /转达`（15 文件 +645/-27）。
- Worker：**`d1575290-4636-4eec-a8dd-f7b724ccbc2e`**（前一个是 `f9d564fb-…`）。
- **测试：现在八套全绿** —— `test/{smoke,mention-dm,triple,reply,text,dmcmd}.mjs` + `cloudflare/test/{port,patrol.mock}.test.mjs`。
  注意 `cloudflare/test/port.test.mjs` 里有一处**硬编码的 `createLedger()` 期望形状**，账本加字段必须同步加它。
- 看门鲸：**pid 4640**（11:05 起）。
- **待回已归零**（10:59 起 `reply check: 回 0 条 / 跳过 0 条 / 失败 0 条 / 待回 0`），重复刷屏也停了
  —— 宿主在我同步 profile 时似乎**热重载**了新代码，所以本轮**不需要重启 DSH 就生效了**（重启仍然无害）。

### 1.6 第四轮（主人报「它现在回不了评论区的评论了」+ 三条新要求）
- **症状**：`auto.log` 11:10 / 11:15 连着两次 `reply check: 回 0 条 / 跳过 0 条 / 失败 1 条 / 待回 1`，
  而那条待回的**恰恰是主人的评论**（`BV1wAYP6YEif` / `rpid 316080212369`），失败原因：**`今日回复已达上限 10 条`**。
- **真因**：`lib/policy.js` 的 `checkReply` 里 `if (counts.replies >= Number(cfg.policy.dailyReplies))` **不分人** ——
  主人当天在评论区多聊了几句（含前面那些重复回复）就把 10 条额度吃光，主人的评论也回不了。
- **修法**：新增 `replyCountToday(ledger, now, wantOwner)`（从 `ledger.replies` 按 `isOwner` 分开数，因为
  `todayCounts().replies` 是**不分人**的总数），把那条判断拆成两支：
  - 主人 → 用新配置 **`policy.dailyRepliesOwner`（默认 50，0 = 不限）**；
  - 别人 → 用 `dailyReplies`，而且只数**非主人**的回复（主人聊再多也不吃陌生人的额度）。
  `lib/policy.js` 与 `cloudflare/src/policy.js` 都改了（后者还要 `import { dateKey }` + 同一份 helper）。
- **新要求与对应配置**（都写在 `config.json` 的 userConfig 里）：
  1. 「我有评论她能回」→ `dailyRepliesOwner: 50`（主人不再被陌生人的额度卡住）。
  2. 「别人的评论调用免费模型回」→ **本来就是**：`lib/compose.js:156` 与 `lib/brain.js:344` 都是
     `prefer: isOwner ? 'paid' : ''`（主人走付费 deepseek，别人走免费额度）。
  3. 「一直自动的刷视频学习」→ `learning.checkMinutes: 10`（宿主定时器）+ **看门鲸也挂了一条学习循环**
     （`tools/dm-watch.mjs` 新增 `--study-every`，默认 30 轮 ≈ 10 分钟，调 `runStudyOnce({})`；
     `learnOnce` 按 bvid 去重，两条加起来约每 5 分钟一轮）。
  4. 回复更勤快 → `replyCheckMinutes: 2`（宿主），看门鲸 `--reply-every 6`（≈2 分钟）。
- 提交 **`0dd6a5b`**；Worker **`a78af4df-c945-4df3-abcd-5c1915d9156f`**；看门鲸 pid **26876**。
- 回归测试：`test/reply.test.mjs` 新增第 6 节（陌生人额度满 → 主人照样能回；主人额度满才拦；
  主人多聊不吃陌生人额度；`dailyRepliesOwner: 0` = 不限）。
- 真机验证：修完立刻跑一轮 → `回 1 / 跳过 0 / 失败 0`，主人那条回出去了；
  手动跑一轮学习 → `topic=算法讲解 studied=2 historyReported=2`（两个视频都进了 B 站浏览记录）。

### 1.7 第五轮：IP 属地之谜 + Worker 接付费脑子 + 「刷视频」四条要求
- **主人问**：「为什么我 AI 的 IP 一会在美国一会在浙江，是不是跟它有关系？」→ **有关系，而且是三条出口**：
  1. **美国** = **GitHub Actions**（`.github/workflows/whale.yml`，`runs-on: ubuntu-latest` → Azure 出口）。
     它有自己的 `on.schedule: cron '*/10 * * * *'`，**不看本机心跳、每 10 分钟无条件跑** `cloud/run.mjs` 去碰 B 站。
     Cloudflare Worker 的 cron 反而早就有「本机在岗就让位」的判断（`cloudflare/src/index.js` 的 `scheduled`，
     日志里的「本机在岗（N 秒前还有心跳），云端只待命」），Worker 自己**不碰 B 站**。
  2. **浙江** = 本机（DSH 插件 + 看门鲸）**直连家宽**。
  3. **台湾** = 我自己引入的：看门鲸启动时带了 `$env:HTTPS_PROXY=http://127.0.0.1:19451`（交接文档教的），
     而本机有 **`NODE_USE_ENV_PROXY=1`**，于是它的 **B 站请求也走了 clash**，出口 `103.127.218.32`（台北，Pittqiao Network）。
- **修法**：
  1. `cloud/run.mjs` 的 `main()` 里加**本机心跳让位**（`LOCAL_TTL_MS = 30 分钟`；`--always` 可强制跑）——
     本机在岗时 Actions 直接 `本机在岗（N 秒前还有心跳）→ 云端让位，这轮不碰 B 站` 并退 0。
  2. **看门鲸不再带 `HTTPS_PROXY` 启动**；云端对账改走显式配置 **`config.json` 的 `cloud.proxy`**
     （`lib/cloud.js:56` 的读取顺序：cloud.json > `cfg.cloud.proxy` > `BILI_WHALE_CLOUD_PROXY`）。
     于是 **B 站永远从浙江走直连**，只有「对 Cloudflare 的请求」才过代理。已实测：不设环境变量时
     `cloud.proxy` 照样把 `/status` 打通报（`ok: true`）。
- **给 Worker 配了付费脑子**：加了 secret **`DEEPSEEK_API_KEY`**（`wrangler secret put`），
  并在 `cloudflare/src/persona.js` 新增 `deepseekText()`；`draftReply()` 里**只有 `isOwner === true`** 才先试它，
  失败/没 key 静默回落免费 Workers AI；**陌生人继续走免费**（与本机 `lib/compose.js` 同口径）。
  提交里只动了 persona/policy；Worker 版本 **`2aaa72ae-0258-4fc4-9256-f566cdb4ed59`**。
  ⚠️ **GitHub Actions 那条线要另外配**：`whale.yml` 里写着 `DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}`，
  需要在 GitHub 仓库 Secrets 里也加同名 secret，否则云端那只「手脚」仍用免费模型。
- **「刷视频」四条要求**（主人原话：「给她自己自动刷视频的权限，每一天都要有浏览记录，
  遇到觉得有意思的视频就三连，还有我们让她刷什么视频她就要刷什么」）：
  1. **每天必有浏览记录** → `lib/study.js` 新增 `ensureDailyWatch()`：今天 `watched` 还是空的，
     就从 popular/rcmd/ranking 里抓一条**带 cid** 的报进 B 站历史 + 记账本；在 `learnOnce` 的
     **两个返回点**都调用（含「这轮没挑到合适视频」的早退分支）。
  2. **自动刷的权限** → 宿主 `learning.checkMinutes: 10` + 看门鲸 `--study-every 30`（≈10 分钟），两路错开。
  3. **三连** → 本来就在做（今天已连 6 个）；只是撞上了 `dailyTriples: 5`。**现已改成 0 = 不限**。
  4. **主人点名刷什么就刷什么** → `lib/dmcmd.js` 新增 **`/刷 <BV号|关键词> [个数]`**（别名 `刷`/`watch`/`browse`/`看`）：
     真拉详情 → 真报浏览记录 → 记 `watched`（`source: 'master'`）→ 读一眼前排评论 → 按「好内容」走三连闸门；
     回执一行一个（`BV号｜标题｜UP｜播放｜时长｜进历史✓｜三连✓｜热评N`），压到 200 字内。
  5. **不限额度**（主人追加）：「不加三连上限，币没了也没事」→ `dailyTriples: 0`；
     「主人的回复不限额度」→ `dailyRepliesOwner: 0`（`checkReply` 里 `cap > 0` 才算上限）；
     「陌生人的就用免费模型」→ `lib/compose.js:156` / `lib/brain.js:344` 的 `prefer: isOwner ? 'paid' : ''`（本来就是）。
- **提交**：`95e8ac3`（自动刷+每天必有记录+/刷+云端让位+Worker 付费）、`8bd92c2`（不限额度/不限三连）。
  Worker：`296744e2-…` → **`2aaa72ae-0258-4fc4-9256-f566cdb4ed59`**。看门鲸 pid **24124**。
  测试仍**八套全绿**（`test/triple.test.mjs` 加第 ⑨ 节钉住 `ensureDailyWatch`；`test/dmcmd.test.mjs` 加第 6 节钉住 `/刷`）。
- 真机验证：`ensureDailyWatch` → `{ok:true, already:6}`（今天已有痕迹，正确跳过）；
  `/刷 BV1M5411g7He` → `刷了 1 个，三连 1 个：BV1M5411g7He｜…｜进历史✓｜三连✓｜热评3`，账本 `watched` 里 `source: master`。

### 1.8 第六轮：私信**不要命令形式**（大白话识别）+ 云端付费脑子到底怎么配
主人原话（本轮入口）：「私信刷视频不要命令形式，自然语言识别让她自己刷，云端手脚改付费模型告诉我要怎么做」。

**① 大白话进得来，并且当场执行 —— 新模块 `lib/intent.js`（不是模型分类器，是确定性解析器）**
- 为什么不用模型分类：铁律没变 —— **要办事的必须走代码，模型只负责写回执的语气**。分类器一抽风就又是假承诺。
- `parseIntent(text)` → `{ name:'search'|'watch'|'relay', target, keyword, self, count, source }` 或 `null`：
  - 认「搜一下拉康精神分析」「帮我找找有没有讲三体的」「推荐几个算法讲解的视频」→ `search`；
  - 认「自己去找点视频看看」「你自己看着办」「随便刷刷」「想学啥学啥」→ `watch` + `self:true`（**她自己挑**）；
  - 认「看 3 个拉康的视频」「刷两条搞笑视频」「帮我看看 BV1xxxxxxxxxx」→ `watch` + 点名的目标/个数；
  - 认「帮我跟金易木木元说声谢谢」「转告他一声我明天到」→ `relay`（`splitRelayTarget()` 切收件人，只在句首 1–8 字像人名时才切，**发错人比不发更糟**）。
- **三条守卫**（都是真机踩出来的，测试里钉死了）：
  1. 否定（`别/不要/不用/先别/取消…`）→ `null`，一个字都不办；
  2. 问方法（`怎么/如何/能不能教我…`）→ 只在**认不出动作**时才判 `null`。理由：主人求人办事最自然的说法就是「你能不能帮我搜一下…？」，先查末尾「能不能」会让**主人越客气她越不动手**（这是本轮最大的一个坑，推翻重来过一次）；
  3. 问结果（`刷完了吗/搜到了没`）→ `null`，否则「刷完了吗」会被当成新任务。
- 认不出但明显在支使人（`looksLikeActionRequest()`）→ 不再假装没看见：`capabilityNote()` 里加一句「这条**不是纯聊天**——主人在支使人干活，但程序没认出具体要干什么」，逼她老实说，而不是顺着编。
- `lib/tools.js` 的 ack 分支现在**同一段代码**吃两种入口：`parseDmCommand()`（斜杠）与 `parseIntent()`（大白话）→ `runDmCommand({ command, intent })` → 真执行 → `checkDmReply` 闸门 → `client.sendMsg` → `recordDm` → 账本 `actions.log` 记 `dm-intent <动作>`。
- **斜杠命令没删**（`/搜` `/刷` `/转达` `/帮助` 照旧可用，老习惯不断），只是 `dmCommandHelp()` 改成**人话说明书**（≤200 字，不再列斜杠）——她回「没听懂」时念的就是这三句：
  「搜一下拉康精神分析」「自己去找点视频看看」「帮我跟金易木木元说声谢谢」。
- **她自己去刷是真的刷**（真机验证，2026-10-05 11:44 探针 + 12:xx 复验）：`你自己去找点视频看看` →
  `{name:'watch',self:true}` → `runWatchSelf()` 按今天轮到的方向（当时是「科幻小说」）真搜 → 挑播放最高的一条 →
  **真报 B 站浏览记录**（`client.historyReport`）→ 真读热评 → 过三连闸门（这道闸门是通的，回了 `三连✓`）→ 回执
  `人家自己按「科幻小说」挑的1条，看了：BV1o74y6XEcM｜一个人，耗时18个月…｜野生锅导演｜342.6万｜94:31｜进历史✓｜三连✓｜热评3`。
  ⚠️ 探针第一版**我自己写错了**：拿一个只代理了 `search/video/comments/sendMsg` 的假 client 去跑，于是
  `reportHistory` 报 `client.historyReport is not a function` 被静默吞成「没进历史」。教训记在这：**验链路要么用真 client，
  要么把所有被调用的方法都代理上** —— `Proxy` 包真 client 只换 `sendMsg` 才是对的做法。
- 测试：`test/dmcmd.test.mjs` 加了第 7、8 节（纯解析器逐条比对 + `runDmIntent` 真执行走假 client）。**八套仍然全绿**。
- 顺手修掉一个真 bug：`runWatch()` 原来 `return await watchThese(...)`，而 `watchThese()` 的内部形状是 `{lines,tripled,text}`、
  **没有 `ok` 字段** → 回执 `ok: undefined`，私信那层会当成「没办成」。现已改成显式 `{ ok:true, text: outcome.text }`。

**② 主人问「云端手脚改付费模型告诉我要怎么做」—— 现状 + 只差一步**
- 云端有**两只手脚**，付费这件事它们各算各的：
  | 手脚 | 在哪 | 付费现状 | 还要做什么 |
  |---|---|---|---|
  | 本机看门鲸 / DSH 插件 | `tools/dm-watch.mjs` + 宿主 | **已经是付费**（`lib/brain.js` 读 `DEEPSEEK_API_KEY`，本机取自 `$DSH_HOME/.credentials.yaml`；`logs/brain.log` 全是「这次先用 deepseek（付费）」） | 不用动 |
  | GitHub Actions（`.github/workflows/whale.yml`） | GitHub 仓库 secrets | **已经是付费**：`gh secret list --repo lzzxbdonj/bili-whale` 实测有 `DEEPSEEK_API_KEY`（2026-10-04T16:27:51Z） | 不用动（§1.7 那条「要另外加」已过时） |
  | Cloudflare Worker（`cloudflare/`） | Worker secrets | **代码已就绪，secret 有没有待主人确认**：`cloudflare/src/persona.js` 的 `deepseekText()` 只读 `env.DEEPSEEK_API_KEY`；`draftReply()` 里 `isOwner===true` 才先试付费、失败静默回落免费 Workers AI；`cloudflare/src/patrol.js:298` 调它时传了 `isOwner` ⇒ **回主人的评论已经会走付费分支** | 给这只 Worker 加同名 secret（下面三步） |
- **给 Cloudflare Worker 加付费 key（三步，主人自己在电脑前做，一条命令一次）**：
  ```powershell
  # 1) 先确认这只 Worker 现在有没有配（没有会报 "not found"，不影响下一步）
  $env:HTTPS_PROXY='http://127.0.0.1:19451'
  npx --yes wrangler@4 secret list --cwd cloudflare
  # 2) 把本机那份 key 打到 Worker 上（key 在 C:\Users\Administrator\.dsh\.credentials.yaml 的 DEEPSEEK_API_KEY，
  #    也可以直接用本机环境变量 $env:DEEPSEEK_API_KEY；粘进提示符时不会回显）
  npx --yes wrangler@4 secret put DEEPSEEK_API_KEY --cwd cloudflare
  # 3) 不用重新部署：secret 立即生效。验一下 Worker 还活着
  npx --yes wrangler@4 deployments list --cwd cloudflare
  ```
  - 加完就生效，**不需要 `deploy`**（改 secret 是改运行时环境，不是改代码）。
  - 验证方式：Worker 巡检回主人那条评论时，`cloudflare/src/persona.js` 会先打 `/chat/completions`；在 Cloudflare 面板
    「Workers & Pages → bili-whale → Logs」能同时看到有没有报错回落。回落是**静默**的（设计如此，不让定时任务整条崩）。
- ⚠️ **但云端现在发不出任何东西**：`bili_cloud op=config` 读到 `observeOnly: true`，`bili_cloud op=status` 显示
  **未登录（云端没有可用 cookie）+ 等级 Lvnull + 观察模式开**；`cloudflare/src/index.js:271` 的 `canWrite` 要求
  `isLogin===true && observeOnly!==true && level!==0` 三条同时成立。所以就算配好付费 key，**这只 Worker 也只排队不发**。
  真要「云端当手」得：①登录云端那只号（cookie 同步 / 扫码）②关掉观察模式（`observeOnly:false`）③等级不为 0。
  **当前分工是本机看门鲸干活、云端只排队**——这也正是「写操作永不给 Worker 加端点」那条坑的延续。


## 2. 前几轮已完成（都已提交 / 已部署 / 已同步 / 已真机验证）
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

### 2.4 测试（**八套全绿**，改动后请照跑）
```powershell
cd E:\donk\dsh-bilibili-whale
node test/smoke.mjs; node test/mention-dm.test.mjs; node test/triple.test.mjs; node test/reply.test.mjs
node test/text.test.mjs; node test/dmcmd.test.mjs
node cloudflare/test/port.test.mjs; node cloudflare/test/patrol.mock.test.mjs
```
（注意目录里**没有** `test/smoke.test.mjs`，入口叫 `test/smoke.mjs`；第六轮新增的是 `test/dmcmd.test.mjs` 的第 7、8 节。）

### 2.5 真机验证（真的发出去了）
- `BV1UAYd6WE2t`（主人那条「@寻和橼的大肥鱼dsh 要这样@」）：`rpid 316071900673` → `selfRpid 316077035713`。
- `BV1oC4y1k7iT`（主人「又去偷懒刷视频了」——上一轮欠的那条）：`rpid 316075381585` → `selfRpid 316077335425`。
- 两条都走了付费脑子：`logs/brain.log` 里 `这次先用 deepseek（付费）` 后面**没有失败行**。

### 2.6 守护进程
- 看门鲸（第六轮重启过，**跑的是含大白话识别的新代码**）：pid **30700**（2026-10-05 11:44 起），
  命令行 `D:\360Downloads\node.exe tools/dm-watch.mjs --minutes 0.33 --sync-every 15 --reply-every 6 --study-every 30`，
  cwd 仓库根，日志 `dm-watch.log` / `dm-watch.err.log`（`Start-Process` 会把这两个文件**覆盖**重写，历史内容不留）。
  **重启方式**（第六轮实际用的，不需要代理，因为看门鲸不再带 `HTTPS_PROXY`）：
  ```powershell
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'dm-watch' }  # 找 pid
  Stop-Process -Id <pid> -Force
  Start-Process -FilePath 'D:\360Downloads\node.exe' `
    -ArgumentList 'tools/dm-watch.mjs','--minutes','0.33','--sync-every','15','--reply-every','6','--study-every','30' `
    -WorkingDirectory 'E:\donk\dsh-bilibili-whale' -WindowStyle Hidden `
    -RedirectStandardOutput 'E:\donk\dsh-bilibili-whale\dm-watch.log' `
    -RedirectStandardError  'E:\donk\dsh-bilibili-whale\dm-watch.err.log'
  ```
  ⚠️ 改完 `lib/*.js` **必须重启看门鲸**：Node 的 ESM 模块缓存只在进程启动时读一次，改完文件不重启，跑的还是老代码
  （第六轮原 pid 24124 是 11:31 起的，而 `lib/tools.js` 11:39、`lib/dmcmd.js` 11:40、`lib/intent.js` 11:41 才落地 —— 不重启就是白改）。

### 2.7 第六轮之后的同步与代码状态
- 同步方式：**没有 sync 脚本**，就是直接拷文件 —— `Copy-Item <repo>\{lib,cloud,cloudflare,persona,skills,assets,notes,tools,.github} <plugin>\ -Recurse -Force`（再加 `package.json`/`README.md`/`cordis.patch.yml`）。第六轮已同步，`lib/intent.js` 是新文件，**第一次同步必须确认它进去了**（`Test-Path <plugin>\lib\intent.js`）。
- 宿主 DSH 侧：`lib/tools.js` 的 ack 分支改动要等宿主重启才会加载（§7）。


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
1. ~~「把这条会话的模式调到创造模式吧」~~ —— **主人已自己回答「你现在就是创造模式了」（第三轮）**，那条悬案结清，不用再去翻 `E:\donk\study-mate` 之类目录。
2. ~~Worker 巡检回主人只能用免费模型~~ —— 代码侧已就绪（`deepseekText` + `draftReply` 的 `isOwner` 分支）。
   **待办只剩一步「加 secret」，但那是改主人的 Cloudflare 账号，必须主人点头**（加 secret 的完整命令在 §1.8 ②）。
   注意：本机与 GitHub Actions 两条线的 key **都已配好**，只有这只 Worker 待确认。
3. 更早的开放目标：**云端整套跑通**（m02160/m02757）。云端现状是 `observeOnly:true` + 未登录 ⇒ 只排队不发；真要它当手得先登录 + 关观察模式（§1.8 ②末尾）。
4. 私信命令不只 `/搜`、`/转达`、`/帮助` 了：第六轮加了**大白话识别**（`lib/intent.js`）与 `/刷`。主人若还想要别的动作（比如「把这条记进待办」「去给 BVxxxx 留个言」），照 `lib/intent.js` 的 `matchIntent()` 加一档 + 在 `lib/dmcmd.js` 的 `runIntent()` 加一个分支就行 —— 记住铁律：**要办事的必须走代码，走模型只会得到承诺**。
5. 遗留小瑕疵（不影响用）：她自己刷片时账本 `watched` 那条 `topic` 是空的（`watchThese` 收到的 `topic` 默认 `''`，只有回执文案里带了方向），主人要按方向统计「她自己刷了什么」会少一列。

## 7. ⚠️ 必须提醒主人
- 宿主（DSH）**重启**才会加载新的评论回复定时器与提示词。不过第三轮实测：主人插件目录一同步，宿主的评论回复链路**看起来已经热重载**成新代码了（旧代码那种「每 5 分钟往同一条评论追一条」的刷屏在同步之后就停了，`待回` 也归零了）。所以重启是**保险**，不是必需。
  - 第六轮又验证了一次这个现象：同步 `lib/tools.js`（11:39 落盘）之后宿主侧**没重启**，但看门鲸重启后大白话链路立刻可用。
- 本机的评论回复在宿主没重启时靠 §2.6 那只看门鲸（现在 pid **30700**）顶着。
- 想让她跑腿，**直接说人话就行**：「搜一下拉康精神分析的视频」「你自己去找点视频看看」「帮我跟金易木木元说声谢谢」
  （斜杠命令 `/搜` `/刷` `/转达` `/帮助` 也还留着，老的用惯了不会失效）。**说「能不能帮我搜…？」也算命令**，不会再被当成请教方法。
