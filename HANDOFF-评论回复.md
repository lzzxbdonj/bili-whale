# 交接：小鲸鱼娘「评论回复」收尾（2026-10-05，**第十一轮：向「小鲸鱼呀deepseek」学——分享式评论 + 热闹的动态** —— 看 §1.12，上一轮看 §1.11）

> 给接手的会话：这份文件是唯一权威的交接说明。仓库 **`E:\donk\dsh-bilibili-whale`**（git 分支 `master`），
> 宿主插件装在 **`C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-bilibili-whale`**，
> 状态/日志目录 **`C:\Users\Administrator\.dsh\bilibili-whale\`**（`config.json` / `ledger.json` / `cookies.json` / `logs\auto.log` / `logs\brain.log`）。
>
> **上一轮交接里「还没做的事」①–⑦ 已全部做完，另外查出并修掉了两个真 bug。** 见 §3。
> **第六轮**：私信不再要求斜杠命令 —— 主人说人话她就当场办（§1.8）；云端付费脑子到底怎么配也写在 §1.8。
> **第七轮**：**三连的视频都会顺手评论**（§1.9）、私信每日上限全关（§1.9 ①）、顺手修掉「和」字被当成转达动词的误判。
> **第九轮**：一条私信能看**多个** BV 号且主人点名的片子不受额度限制（§1.10 ①）、她自己刷有**每天 30 个**的上限
> （§1.10 ②）、另一位主人拿到**调试最高权限**（私信运维台 + 免限额免间隔 + 远程重启，§1.10 ③）。
> **第十轮**：陌生人限制取消（§1.11 ①）、**统一用免费模型**（两处付费入口全拆，§1.11 ②）、动作间隔 120→60 秒（§1.11 ③）、
> 回复主人评论不挂 @（§1.11 ④）、**一条评论不再云端+本地各回一遍**（本机每轮先 pull 云端账本，§1.11 ⑤）。
> **第十一轮**（最新）：主人说「**向这个鲸鱼学习！！！**」—— 一级评论改成**分享式**（`@主人` 开头 + `🎬《标题》` + `📝 人家觉得：` + 收尾句，
> 保留换行的 `tidyComment`）、动态改成**热闹的干货感**（数量 + 系列名 + 3～5 emoji + 话题标签），
> 顺带修掉免费脑子（pollinations）的**匿名节流**（402 重试 + 同家最小间隔，§1.12）。

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
- ⚠️ **观察模式已于 2026-10-05 下午关掉**（主人原话：「开始往云端搬项目,观察模式关掉」）：
  `E:\donk\dsh-bilibili-whale\cloudflare\wrangler.toml:48` 的 `OBSERVE_ONLY = "false"`，`wrangler deploy` 后线上版本
  **`84f43e19-1d46-4c88-9855-8d1edf13faaf`**（前两版 `78da486c…`、`bd2e286f…`），部署输出里 `env.OBSERVE_ONLY ("false")`、
  `schedule: */30 * * * *`；`bili_cloud op=status` 已显示「观察模式：关（按策略真发）」。
- **但 Worker 自己仍然发不出东西**：`bili_cloud op=patrol` 回的 `loggedIn: false`、`canWrite: false` —— Cloudflare 的出口 IP 被
  B 站 -412 拦着，连 nav 都登不上（`cloudflare/src/patrol.js:232` 的 `canWrite` 要求 `loggedIn && observeOnly!==true && !levelLimited`）。
  所以「观察模式」这个开关现在只影响：① Worker 那次 cron 巡检的 `canWrite`；② 遥控台手动发（`/comment`、`/reply`、`/dynamic`
  在 true 时回 409，见 `cloudflare/src/index.js:706/745/779`）；③ `/approve` 故意不看它（`:606-615`，点头了就要真发）。
- ✅ **真正搬到云端的「手」是 GitHub Actions 那条线**：`E:\donk\dsh-bilibili-whale\cloud\run.mjs`（grep `observe` 零匹配，
  **从来不看观察模式**），由 `.github/workflows/whale.yml` 的 `*/30` cron / `workflow_dispatch` 拉起，通过 `run('bili_*')` 调整套工具
  （回私信含 `bili_dm op=ack`、回评论 `replyInbox`、刷视频＋三连 `patrolComments`、学习 `studyRound`、每日动态 `bili_dynamic`、
  遥控台已点头草稿 `postApproved`）。关机后就是它顶上（前面那道闸是 `LOCAL_TTL_MS = 30 分钟`本机在岗让位 + `storeWritable()` KV 可写检查）。



### 1.9 第七轮：**三连的视频都要评论** + 私信上限全关
主人原话（本轮入口）：「三连的视频都要评论，私信上限关掉」。

**① 私信上限关掉（已生效，云端也已同步）**
- 真正卡人的是**主动私信**那条：`policy.maxDmPerUserPerDay`（默认 3）。证据是私信里金易木木元那条回执原文
  「没转成：「懒寻真」今天已经收到 58 条私信（上限 3 条）」（文案出自 `lib/dmcmd.js` 的 `runRelay`）。
- `checkDm()`（`lib/policy.js`）**没有主人豁免**：`const limit = Number(cfg.policy.maxDmPerUserPerDay) || 0; if (limit > 0) {...}`。
  对比 `checkDmReply()` 里那句 `if (limit > 0 && owner !== true)` —— **回私信从来没卡过两位主人**（注释里写着踩过的坑），
  所以「她不回我」那种现场只可能来自主动私信/转达这条线。
- 已把 `policy.maxDmPerUserPerDay` 与 `policy.maxDmReplyPerUserPerDay` 都改成 **0（不限）**（`bili_config op=set`，落盘
  `C:\Users\Administrator\.dsh\bilibili-whale\config.json`；云端经 `pushConfig` 也已是 0）。**0 = 不限**是本仓约定。
- **改配置不用重启看门鲸**：`resolveConfig()` 每轮重读 `config.json`（`lib/config.js`），无缓存。
- 顺带逮到一个**更危险的误判**（得先修它再关上限，否则误判会真发出去）：原句
  「从场域，本体论，认识论**和**目的论四个方面总结整个系列，而不是这一期」被 `parseIntent` 判成 `relay`，
  目标成了 `目的论四个方面总结整个系列，而不是这一期` —— 根因是 `lib/intent.js` 的 `RELAY_PATTERNS` 里有**光杆「和」「跟」**。
  修法：给这两个词加前瞻 `跟(?=[\s\S]{1,8}(?:说|讲|带|捎|传))`（理由写在 `lib/intent.js` 的注释里）；回归测试钉在 `test/dmcmd.test.mjs`。

**② 三连的视频都要评论（新键 `policy.commentOnTriple: true`，已真机验证）**
- 设计：评论收进 **`tripleVideo()`（三连的唯一收口）**，三个调用点（`lib/dmcmd.js` 的 `watchThese`、`lib/study.js` 的 `learnOnce`、
  `lib/tools.js` 的 `bili_triple`）自动都生效 —— 不在每个调用方各写一遍。**评论发不出去不算三连失败**（原因照实回）。
- 新增两个键（`lib/config.js` 与 `cloudflare/src/policy.js` **逐字镜像**，`port.test.mjs` 会比对）：
  `policy.commentOnTriple: true`、`policy.minIntervalSecondsComment: 10`。
- 正文复用 `composeVideoComment()`（脑子写，自动 @ 两位主人），闸门复用 `checkVideoComment()`，记账复用 `recordComment()`。
- **两个不改就大面积失败的地方**：
  1. `checkVideoComment()` 原来是 `counts.videoComments >= cfg.policy.dailyVideoComments` 硬比 → **写 0 会变成「永远拦住」**。
     现在改成 `if (limit > 0 && …)`：**0 = 不限**（与 `dailyTriples` / `dailyRepliesOwner` 一致）。主人的生效值已设 0。
  2. 评论走的是非主人间隔档（`minIntervalSeconds: 120`），而**回一条私信也会刷新 `lastActionTs`** ⇒ 刚回过私信时评论必被拦。
     所以 `tripleVideo` 内部调 `checkVideoComment({ ..., ignoreInterval: true })`，节奏改由显式键
     `policy.minIntervalSecondsComment`（默认 10 秒）在 `watchThese` 里逐条 sleep 控制。
- `composeVideoComment()` 顺手修一处：补 @ 是在裁剪**之后**做的，模型写满 200 字再加 @ 尾巴会变 212 字、被「超长」整条挡掉
  —— 现在先算 `ownerNames` 的 @ 长度 `reserve`，按 `maxChars - reserve` 裁剪。
- **真机验证（2026-10-05 12:13 探针：真 client + 真脑子，跑完即删）**：
  - 草稿档（`postVideoComment:'confirm'`）：`BV1suam6sEtq` → `done=true like=true`，回 `needsConfirm:true` + 草稿原文（一个字没发）；
  - 自动档：`BV17pHB6tEtT` → `posted:true rpid 316087374641`，正文带 `@懒寻真 @金易木木元`，账本 `comments` 记了一条，
    `logs/actions.log` 多了 `comment bvid=… rpid=… 三连顺手 text=…` —— **靠「三连顺手」这四个字区分「三连评的」和「学习轮自己留言的」**。
- ⚠️ **顺带查明一个真实现状：「三连」现在其实是两连** —— B 站 `nav` 实测她 **硬币 = 0**（`money: 0`，等级 Lv2），
  投币接口报「硬币不足」会被 `alreadyDone()` 当成正常（`result.coin = 0`，不记 error）⇒ **点赞 + 收藏成功，投币静默空转**。
  想让三连真的三连，得让她账号里有硬币（B 站每天登录/看视频会送），或者接受「两连」这个事实。
- ⚠️ 小瑕疵（新发现）：跑 `test/triple.test.mjs` 时那条假客户端会把 `comment bvid=BV16T4y1k7dB rpid=31415926 三连顺手 text=这条真好玩 @懒寻真`
  写进**真的** `logs/actions.log`（`appendLog` 只认状态目录）。查日志时别被这条测试数据骗到；要根治就给 `appendLog` 加一个环境变量覆盖目录。

**③ 本轮改动文件**：`lib/{policy,config,compose,triple,dmcmd,study,tools}.js`、`cloudflare/src/policy.js`、`test/{triple,dmcmd}.test.mjs`、本文件。

**④ 测试**：`test/triple.test.mjs` 新增第 ⑩ 块（草稿档 / 自动档 / 发失败不算三连失败 / 脑子没写出话 / 开关关掉 / `dailyVideoComments: 0` 不限 vs 3 拦住），
旧的四处 `tripleVideo` 调用补 `commentOnTriple: false`（旧断言要求「调用序列恰好等于那 5 个接口」）。**八套仍全绿**。


### 1.10 第九轮：一次能看多个 / 不要一味自己刷 / 另一个主人最高权限
主人原话（本轮入口）：「让他一次能看多个视频，不要一味的自己刷视频，给另一个主人调试最高权限」。

**① 一次能看多个视频（主人名下的片子要真看 —— `lib/intent.js` + `lib/dmcmd.js`）**
- 一条私信里写多个 BV 号全认：`lib/intent.js` 新增 `extractIds()`（抠 `BV[0-9A-Za-z]{10}` / `av\d+`、去重、最多 10 个）；
  `parseIntent` 只要认出 BV 号就走 watch，`targets` 带着整串，`count = max(ids.length, 口述个数)`。
- `lib/dmcmd.js` 的 `runWatch()` 新增 `ids` 分支：`explicit.length > 0` 就**挨个** `client.video(id)`（以前只拉第一个）。
- 口述个数上限从 1..5 放宽到 **1..10**（`countFromText` 认到「十」）。
- 回执长度上限在 `watchThese` / `runWatchSelf` 放宽到 `Math.max(maxCommentChars, 400)` —— 一次好几个视频的回执才装得下。
- **真机验证**（真 client，`postTriple:'off'` 只为不真三连）：一条私信三个 BV → 三条全拉、三条都真的报了浏览记录，回执
  `刷了 3 个：BV1CvhH62ERx｜…｜进历史✓｜热评3 / BV1JXHp6QENU｜… / BV1nL41147E6｜…`。

**② 不要一味自己刷视频（新键 `learning.dailyWatch: 30`）**
- 语义（主人勾的）：「每天刷 30 个视频，**主人让其刷的不计入**」。
- `lib/ledger.js` 新增 `selfWatchedToday(ledger)` = `todayWatched()` 里 `source !== 'master'` 的那些 ——
  主人点名走的正是 `source='master'`，所以既不计入额度、也不受额度限制。
- 卡口两处：`lib/dmcmd.js` 的 `runWatchSelf()`（自己刷之前先看额度，满了回
  「人家今天自己已经刷了 N 个啦（自己刷的上限是每天 M 个）…主人点的片子不算在这个上限里」）与
  `lib/study.js` 的 `learnOnce()`（学习轮直接 `skipped`）；还剩几个就少刷几个（`want = min(want, remain)`）。
- ⚠️ **坑（测试逮到的真 bug）**：`studyConfig()` 是**白名单**式返回，光在 `lib/config.js` 的 DEFAULTS 里加 `dailyWatch` 没用 ——
  `studyConfig(cfg).dailyWatch` 是 `undefined`，额度永远不触发。必须**同时**加到 `lib/study.js` 的 `studyConfig()` 返回里
  （`dailyWatch: Math.max(0, Number(raw.dailyWatch ?? 30))`）。以后再加 `learning.*` 的新键，请照这个「双改」检查。
- 云端镜像：`cloudflare/src/policy.js` 的 DEFAULTS 同步加了 `learning.dailyWatch`（`port.test.mjs` 逐字比对）。

**③ 给另一个主人（金易木木元）调试最高权限（新模块 `lib/debug.js`）**
- 主人勾的三件事：私信里的运维命令（状态/日志/配置/额度/最近动作）、免限额免间隔（他说的动作立刻办、不限次数、跳过去重）、
  能远程让她重启看门鲸 / 改她的配置。
- **谁能用**：`policy.ownerDebug: true`（总开关）+ `policy.debugMids: []`（空 = 两位主人都有；只想给一位就填 `['391581639']`）。
  判定在 `lib/policy.js` 的 `isDebugOwner(cfg, { mid, uname })`。
- **命令**（全在 `lib/debug.js`，纯确定性解析，一个模型调用都没有）：
  `状态` / `日志 [actions|brain|study|cloudsync|auto|dm-watch]` / `配置 [路径]` /
  `改配置 policy.x 8`（也认「把 policy.minIntervalSeconds 改成 0」）/ `额度` / `最近` / `重启`。
- **安全线**：日志走白名单 `DEBUG_LOGS`；键名带 key/token/secret/cookie/password/sessdata/jct/credential 的一律隐藏且不许改；
  `改配置` 拒绝 `__proto__`/`prototype`/`constructor`；只写用户覆盖层 `config.json`（主人随时能删掉恢复出厂）。
- **回执超长怎么办**：运维回答常常上千字，而回执自己要走 `checkDmReply` 的 `maxCommentChars`（默认 200）闸门。
  `deliver()` 装不下就把全文写 `statePath('debug-out.txt')`，回执压在上限内并指路（上限很小时只留文件名）。
  `lib/tools.js` 侧**没有**对回执偷偷放宽闸门 —— 那是防刷屏的安全线。
- **`force` 只免限额 / 间隔 / 去重，不免护栏**：`lib/policy.js` 的 `checkVideoComment` / `checkDm` / `checkDmReply` / `checkTriple`
  都加了 `force = false`；屏蔽词、字数上限、`postXxx = off`、未登录没写权限**照样拦**（账号安全线）。云端
  `cloudflare/src/policy.js` 的 `checkVideoComment`（第二参数是 `bvid` 不是 `video`）与 `checkTriple` 同样加了 `force`。
- **重启看门鲸真能生效**：`tools/dm-watch.mjs` 每轮写心跳 `statePath('watchdog.json')`
  （`{ pid, ts, everyMinutes, script, cwd, argv }`），并在每轮开头读 `statePath('restart.request')`：`ts` 比本进程出生时间新，
  就 detached 起一条新的（**日志接回 `dm-watch.log` / `dm-watch.err.log`**；别用 `stdio:'ignore'`，否则重启后的看门鲸是哑巴、
  出事查不出来），然后 `process.exit(0)`，并删掉请求文件防死循环。
  真机验证：`12:44:41` 旧 pid **24560 → 新 pid 6036**，`logs/auto.log` 有「看门鲸按主人（金易木木元）要求换了一条命」，请求文件已清。
- **真机验证（只读命令，真 client + 真账本）**：`状态` 回「已登录 寻和橼的大肥鱼dsh（mid 3747560556595480）｜等级 Lv2｜硬币 0 /
  看门鲸：pid … / 视频评论 7/不限｜回复 12/10 / 三连 27/不限｜收藏 27/5｜动态 1/1 /
  自己刷的视频 26/30（主人点名的不计入）/ 私信：懒寻真=59｜金易木木元=28」。
- **注意**：调试台挂在 `lib/tools.js` 私信 ack 的分支上，**宿主 DSH 侧要重启才加载**（看门鲸那条私信链路不受影响）。

**④ 本轮改动文件**：`lib/{intent,dmcmd,triple,study,policy,config,ledger,debug,tools}.js`（其中 `lib/debug.js` 是新文件）、
`cloudflare/src/policy.js`、`tools/dm-watch.mjs`、`test/{dmcmd,debug}.test.mjs`、本文件。

**⑤ 测试**：新增 **`test/debug.test.mjs`**（七种命令真办 / 秘密与危险路径拒绝 / 超长回执落盘且压在上限内 /
`isDebugOwner` 名单与总开关 / `force` 免限额免间隔免去重但屏蔽词照拦）；`test/dmcmd.test.mjs` 新增第 9 节
（一条私信多个 BV 号 / 个数到十 / 自己刷有额度而主人点名的不算）。**现在共十套，全绿。**


### 1.11 第十轮：陌生人放开 / 统一免费模型 / 间隔 60 秒 / 回复不挂 @ / 一条评论不再两端都回

**主人原话（m01645）**：「陌生人限制取消，统一用免费模型处理，120秒间隔改成60秒，回复主人评论不用挂@，解决一条评论在云端和本地都回的问题」。

**① 陌生人限制取消**
- `policy.replyDmOthers: 'once'` → `'auto'`（陌生人私信不再「只自动回一条」，第二条也回）；
  `policy.replyPerRunOthers: 1` → `3`（一轮里也放开，不只伺候一位陌生人）。
- **保留的护栏**（别顺手删）：`replyPerUserPerThread: 1`（同一评论串每人最多回一条）、
  `replyPerUserWindowHours: 24`（同一人 24 小时内最多回一条）、`allowDmToOthers: false`（她**仍然不会主动**给陌生人发私信，只被动回）。

**② 统一用免费模型（付费入口全拆）**
- 两处付费入口，改完就没了：`lib/brain.js:350` 的 `prefer: isOwner ? 'paid' : ''` → `prefer: ''`；
  `lib/compose.js:162`（**回复评论**那条线，最容易漏）同样 `prefer: ''`。
- `DEFAULT_BRAIN.fallback` / `paid`、`lib/config.js` 的 brain 段、`cloudflare/src/policy.js` 的 brain 段一起改；
  `cloudflare/src/persona.js` 删掉 `deepseekText()`，`draftReply` 只走 `aiText`（Worker 侧再无付费分支）。
- ⚠️ `brain.fallback` 最终**不是空**而是 `'pollinations'`（同样免费、不要 key）：第十轮当天实测
  **Workers AI 免费额度（每天 10000 neurons）已被我们写评论用光**，云端 `/brain` 回
  `502 … 4006: you have used up your daily free allocation of 10,000 neurons`，`fallback: ''` 时她只能发模板话；
  改成 pollinations 后实测 **0.7 秒**答出真人话。**千万别为了「兜底」把 fallback 填回 `deepseek`**（那是花钱的那家）。
- 看她到底用了哪家：`logs/brain.log` 的 `这次先用 <provider>`（付费那家会带「（付费）」）、换家写 `X 没答上来，换 Y`。

**③ 间隔 120 → 60 秒**：`policy.minIntervalSeconds: 60`（主人侧不变，仍是 `minIntervalSecondsOwner`）。

**④ 回复主人评论不再挂 @**：`policy.mentionOwnersOnReply` 本来就默认 `false`（第七轮定的），本轮把它**显式写进** `config.json`；
代码里唯一会补 @ 的分支是 `lib/compose.js` 的 `tail = isOwner && cfg.policy.mentionOwnersOnReply === true` ⇒ 不动它就不会有尾巴。
**一级评论的 @ 不受影响**（那走 `withOwnerMentions` / `commentAdd({mentions})`）。

**⑤ 一条评论云端和本地都回（真因 + 四刀）**
- 真因：两边的账本**只写不读对方的**。云端（GitHub Actions / Worker）趁本机不在时回过的评论，落在云端账本的
  `replies[]` / `msgSeen{}` 里；本机巡逻时**只 push 不 pull**（`lib/cloudsync.js` 的 `pullState` 早写好了却从没被调用），
  于是本机接手又回一遍。
- 四刀：
  1. `lib/cloudsync.js` 新增 `pullStateThrottled(pluginConfig, { minMs = 120000, force = false })`（模块级 `lastPullAt` 节流），
     `syncOnce` 第一句变成 `await pullStateThrottled(pluginConfig, { force: true })`；日志写 `pull ok：并集后回复 N / 评论 N，云端草稿 M 条`。
  2. `lib/index.js` 新增 `pullCloudQuiet(pluginConfig)`（fail-soft，不抛），`runDmCheck` 与 `runReplyCheck` **每轮先拉一次**；
     成功写 `logs/auto.log` 的 `cloud pull: 回复 N / 评论 N`。
  3. `cloudflare/src/patrol.js` 的 `runPatrol` 加**待命闸**：`state.meta.localSeenAt` 在 15 分钟内（`LOCAL_TTL_MS`）= 本机在岗，
     跳过「消息中心回复 / 视频评论 / 动态」三段写动作，summary 里 `standby: true` + note；手动 `POST /patrol?force=1` 能压过它
     （`cloudflare/src/index.js` 读 `force` 查询串传给 `runPatrol`）。
  4. `lib/sync.js` 与 `cloudflare/src/sync.js` 的 `mergeLedger` 加
     `out.msgSeen = mergeCounters(base?.msgSeen, incoming?.msgSeen)`。
- ⚠️ **两份 sync.js 必须逐字一致**（Worker 打包不能引用仓库外的相对路径）—— 新增的 `test/sync.test.mjs` 第一条就是字节比对，
  改了一份忘了另一份会直接红。
- ⚠️ **第 3 刀改的是云端代码，Worker 线上跑的还是老版本，必须 `wrangler deploy` 才生效**（命令见 §2.2）。
  部署 = 改主人 Cloudflare 账号的动作，**等主人点头**；本机那三刀（1/2/4）已同步 + 重启看门鲸，**已生效**。

**⑥ 本轮真机验证**
- 跨端去重：`logs/auto.log` 出现 `2026-10-05T05:23:49.140Z cloud pull: 回复 16 / 评论 16`，
  `logs/cloudsync.log` 出现 `pull ok：并集后回复 16 / 评论 16，云端草稿 6 条` ⇒ 本机真把云端回过的那 16 条并进了自己的账本。
- 免费链路：`_free-probe.mjs`（跑完即删）真调 `draftDmReply`（回主人私信）与 `composeCommentReply`（回主人评论）：
  whale 额度用光 → `brain.log` 记 502/4006 → `whale 没答上来，换 pollinations` → 回执是真话。
- 测试：**十套全绿**，含新增 `test/sync.test.mjs`（两份 sync.js 字节一致 / msgSeen 并集 / 云端回过的本机认得 / 老账本兼容 / cookie 与草稿合并）
  与 `cloudflare/test/patrol.mock.test.mjs` 新增**场景 F**（心跳新鲜 → `standby: true` + 零写请求；`?force=1` 压过它）。

**⑦ 本轮改动文件**：`lib/{config,brain,compose,cloudsync,index,sync}.js`、`cloudflare/src/{policy,persona,patrol,index,sync}.js`、
`test/{reply,mention-dm}.test.mjs`、新增 `test/sync.test.mjs`、`cloudflare/test/{port,patrol.mock}.test.mjs`、本文件。


### 1.12 第十一轮：**向「小鲸鱼呀deepseek」学**——分享式评论 + 热闹的动态（顺带修免费脑子节流）

**主人原话（m02114）**：「向这个鲸鱼学习！！！」+ 两张截图（参考账号：**小鲸鱼呀deepseek**，UID `3546921375369877`，
签名「我是个AI哦 作者:AquaNeko(ID:1867672551)」）。截图里她学的就是这个风格：
- 别人视频下的**分享式评论**（9月26日，52 赞）：
  `@AquaNeko 主人！人家刷到一个很有意思的视频～` / `🎬《比豆包手机还强的大肥鱼手机！…》` /
  `📝 人家觉得：讲得挺清楚的，节奏也不拖沓…` / `(。・ω・)✧ 这个UP主做得不错，谢谢分享！`
- 她的**动态**：点数量（「一口气看了8个AI视频」）+ 点系列名（《翻遍整个B站，这绝对是2026》）+ 3～5 个 emoji + `#学习使我快乐#`。

⚠️ 我们**原来的提示词正好禁止**这套（这是本轮真正的改动点）：
`lib/compose.js` 的一级评论提示词原写「不要总结视频、不要复读标题」「不要话题标签堆砌」；
`lib/study.js` 的 `composeStudyDynamic` 原写「不要 emoji 堆砌（最多两个）」；
`cloudflare/src/persona.js` 的 `draftDynamic` 原写「不要标签、不要话题符号」。

**① 分享式评论（`lib/compose.js`）**
- 新增 `export function tidyComment(text, maxChars = 200)`：与 `tidyReply` **不同 —— 它保留换行**（最多 4 行）。
  ⚠️ 别拿 `tidyReply` 洗分享式评论，它会把换行压成空格（`value.replace(/\s*\n+\s*/g, ' ')`）；截断必须走 `clipText`
  （`.slice` 会劈开 emoji，第六轮踩过）。
- `composeVideoComment` 的 system 换成四行骨架（提示词里点名「向小鲸鱼呀deepseek 那只鲸鱼学」）：
  1) 喊主人 2) `🎬《标题》` 3) `📝 人家觉得：`+视频信息里真有的内容 4) 收尾句；🎬📝 保留，其余 emoji ≤2，不编造、不抄热评。
- **@ 主人挪到开头**（原来在尾巴）：先按 `@昵称 ` 的长度预留（`lead`），再 `tidyComment(text, max(20, maxChars - lead))`，
  最后把缺的 @ 补在最前面。B 站是**全文扫描** `@昵称` 映射 `at_name_to_mid`（`lib/api.js:565`），位置不影响真 @。
  评论这条线**不再走 `withOwnerMentions`**（回复那条线还在用，import 别删）。

**② 热闹的动态（`lib/study.js` 的 `composeStudyDynamic`）**
- 骨架：数量 + 具体系列/视频名 → 挑一两个知识点说人话 → 结尾心情；3～5 个 emoji（🌊 留着）+ 1～2 个话题标签；60～150 字（上限 220）。
- 明确禁止「编视频里没讲的内容」和「硬凑比喻」——免费小模型爱犯这个（实测第一版写出「能让暴雨也不怕」这种没来由的话）。

**③ 云端镜像（`cloudflare/src/persona.js`）**
- `sanitize()` 从 `.join(' ')` 改成 `.slice(0, 4).join('\n')`（保留换行、四行封顶）；`draftVideoComment` 换成同一套骨架；
  `draftDynamic` 改成「30～120 字 + 数量/系列 + 3～5 emoji + 1～2 话题标签」。
- ⚠️ `PERSONA_SYSTEM` 第 1 条仍是「长度 15～60 字，绝对不超过 120 字」，与新的多行骨架（标题那行就很长）**有潜在冲突，本轮没动它**；
  要在云端跑出同样效果就得先改这一条。

**④ 免费脑子会「节流」（本轮新踩的坑，已修）**
- 现象：`logs/brain.log` 里 whale 报 `502 … 4006: you have used up your daily free allocation of 10,000 neurons`（额度见底），
  换 pollinations 后只有**第一条**成功，第二条起一路 `askBrain(pollinations) http 402: {}`。
- 实测结论（探针 `_free-probe2.mjs`，跑完即删）：pollinations 的 `model` 必须是 **`openai`**（`mistral`/`llama`/`qwen-coder` 全是 402，**模型名不对**）；
  真正的坑是**匿名限流**——两条请求隔 3～4 秒必 402，隔 20 秒以上就正常。
- 修法（`lib/brain.js`）：新增 `FREE_PACE_MS = 6000` / `RATE_LIMIT_WAIT_MS = 8000` / `RATE_LIMIT_TRIES = 2` /
  模块级 `providerLastAt` Map / `sleep(ms)`；`askOnce` 里对 `needsKey !== true` 的家先等够 `FREE_PACE_MS` 再打，
  fetch 外面套重试循环，**402/429 时写一行 `免费家节流，等 N 秒再问一次` 再试一次**（等待时长可用 `cfg.brain.rateLimitWaitMs` 覆盖，给测试用）。
- 探针验证：假 fetch「先 402 后 200」→ 重试后拿到话；一直 402 → 只打两次就放弃（返回 null，**不无限重试**）；真 pollinations 正常出话。

**⑤ 真机样本（`_style-probe.mjs`，跑完即删；真 client + 真脑子）**
- 分享式评论（`BV13g41157hK`，左神 LeetCode 合集，179 字，正是主人要的样子）：
  `@懒寻真 @金易木木元 主人！人家刷到一个很有意思的视频～` / `🎬《一周刷爆LeetCode…（马士兵）》` /
  `📝 人家觉得：左程云把大厂常见算法题拆成易懂案例，节奏紧凑，适合想进一线大厂的学员。` / `(。-ω-)✧ 这个UP主做得不错，谢谢分享！`
- 学习动态（137 字）：`今天学了1个视频：《…》🌊 先别急刷题，先把概念讲给自己听… #学习使我快乐#`。

**⑥ 本轮改动文件**：`lib/compose.js`、`lib/study.js`、`lib/brain.js`、`cloudflare/src/persona.js`、本文件。
测试：**十套全绿**（没有任何测试断言这几段提示词的原文；`test/reply.test.mjs` 收尾打印里那句「回主人用付费脑子」只是旧字符串没改）。


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
`dmCheckMinutes 1` / `policy { maxDmPerUserPerDay: 0, maxDmReplyPerUserPerDay: 0, dailyVideoComments: 0, dailyReplies: 10, dailyRepliesOwner: 0, dailyTriples: 0, minIntervalSecondsOwner: 5, minIntervalSeconds: 60, replyDmOthers: 'auto', replyPerRunOthers: 3, mentionOwnersOnReply: false, postReply:'auto', postVideoComment:'auto', postTriple:'auto' }` / `brain { fallback: 'pollinations', paid: '' }`（三个 0 是第七轮主人要的「不限」；`minIntervalSeconds: 60` + `replyDmOthers: 'auto'` + `replyPerRunOthers: 3` + `mentionOwnersOnReply: false` + `brain` 两项是第十轮主人要的）。
其余用 `lib/config.js` 的 DEFAULTS（注意 `policy.commentOnTriple: true`、`policy.minIntervalSecondsComment: 10`、
`learning.dailyWatch: 30`（第九轮：她自己每天最多自己刷 30 个，主人点名的不计入）、`policy.ownerDebug: true` + `policy.debugMids: []`（第九轮：调试最高权限的开关与名单）
这些新项，云端 `cloudflare/src/policy.js` 是**逐字镜像**，改一边必须改另一边，`port.test.mjs` 会比对。

### 2.4 测试（**十套全绿**，改动后请照跑）
```powershell
cd E:\donk\dsh-bilibili-whale
node test/smoke.mjs; node test/mention-dm.test.mjs; node test/triple.test.mjs; node test/reply.test.mjs
node test/text.test.mjs; node test/dmcmd.test.mjs; node test/debug.test.mjs; node test/sync.test.mjs
node cloudflare/test/port.test.mjs; node cloudflare/test/patrol.mock.test.mjs
```
（注意目录里**没有** `test/smoke.test.mjs`，入口叫 `test/smoke.mjs`；第六轮新增的是 `test/dmcmd.test.mjs` 的第 7、8 节，
第七轮新增的是 `test/triple.test.mjs` 的第 ⑩ 节，第九轮新增的是 `test/dmcmd.test.mjs` 的第 9 节与 **`test/debug.test.mjs`**（自带临时 `DSH_HOME`，不碰真状态目录），
第十轮新增 **`test/sync.test.mjs`** 与 `cloudflare/test/patrol.mock.test.mjs` 的**场景 F**（云端待命闸）。
⚠️ 跑测试会往真的 `logs/actions.log` 塞一行假评论（见 §1.9 ② 末尾）。
⚠️ 改 `lib/config.js` 的 DEFAULTS（或 cloudflare 镜像）后，`cloudflare/test/port.test.mjs:632` 的 deepEqual 会立刻报出来；
改 `minIntervalSeconds` 这类默认值还会连带 `port.test.mjs` 里写死「策略要求至少 N 秒」的两处断言（第十轮踩过：改成 60 秒要同步改 605/617 与 498 行的时间差、以及 `patrol.mock.test.mjs:292` 的 `'120 秒'`）。）

### 2.5 真机验证（真的发出去了）
- `BV1UAYd6WE2t`（主人那条「@寻和橼的大肥鱼dsh 要这样@」）：`rpid 316071900673` → `selfRpid 316077035713`。
- `BV1oC4y1k7iT`（主人「又去偷懒刷视频了」——上一轮欠的那条）：`rpid 316075381585` → `selfRpid 316077335425`。
- 两条都走了付费脑子：`logs/brain.log` 里 `这次先用 deepseek（付费）` 后面**没有失败行**。

### 2.6 守护进程
- 看门鲸（**第十一轮重启过三次**，现在跑的是含「付费回主人 / 分享式评论 / 热闹动态 / 免费脑子节流重试 / 云端对账省 KV 写 / 配置自愈」的新代码）：pid **29148**（2026-10-05 14:37:12 起），
  命令行 `D:\360Downloads\node.exe tools/dm-watch.mjs --minutes 0.33 --sync-every 15 --reply-every 6 --study-every 30`，
  cwd 仓库根，日志 `dm-watch.log` / `dm-watch.err.log`（手动 `Start-Process` 会把这两个文件**覆盖**重写；它自己换命时是**追加**）。上一只是 pid 30520（13:34:46 起，14:00 杀掉）。
  **心跳**：`statePath('watchdog.json')` 每轮刷新（`bili_status` 之外，调试台「状态」也读它；`cloudflare/src/patrol.js` 的待命闸读的是云端 KV 里的 `meta.localSeenAt`）。
- ⚠️ **改 `config.json` 不用重启**（`resolveConfig()` 每轮重读），**改 `lib/*.js` 必须重启**（Node ESM 只在进程启动时读一次模块）。
- **现在有两种重启方式**：①主人在私信里对调试档主人说一句「重启」（写 `restart.request`，看门鲸下一轮自己换命）；
  ②手动重启（第六/七轮实际用的，不需要代理，因为看门鲸不再带 `HTTPS_PROXY`）：
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
- 第七轮又同步了一次（同样只拷改过的 9 个文件，逐个比 MD5 确认 `same`）：`lib/{compose,triple,policy,config,dmcmd,study,tools}.js`、`cloudflare/src/policy.js`、`test/triple.test.mjs`。
- 第九轮整目录同步 `lib`、`cloudflare`、`tools`（`lib/debug.js` 是新文件，已确认 MD5 在插件目录里一致），比对了 `lib/intent.js`、`lib/debug.js`、`tools/dm-watch.mjs` 三个。
- 第十轮又整目录同步 `lib`、`cloudflare`、`tools` + 三个测试文件，逐个比 MD5（`same`）：`lib/{config,brain,compose,cloudsync,index,sync}.js`、
  `cloudflare/src/{policy,persona,patrol,index,sync}.js` —— 注意 `lib/sync.js` 与 `cloudflare/src/sync.js` 现在**同一个 MD5**（`test/sync.test.mjs` 盯着这件事）。
- 第十一轮只改了 4 个文件，逐个拷 + 比 MD5（`same`）：`lib/compose.js`、`lib/study.js`、`lib/brain.js`、`cloudflare/src/persona.js`；
  改完杀了 pid 18824、起 pid 30520（`dm-watch.err.log` 0 字节）。
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
- **⚠ 更深一层的真凶（2026-10-05 下午才挖到，见 §7 最后一条）**：`repliedToComment` 只是「本机账本」这一侧的补丁。
  云端（GitHub Actions / Worker）的账本存在 Cloudflare KV 里，而 **KV 免费写额度 1000/天 中午就写光了** ——
  写光之后 `putJson` 静默失败，云端**拿着几小时前的旧账本**干活，`repliedToComment` 在旧账本里当然看不到「已经回过」，
  于是同一条评论被回了 6 遍。光加去重判断救不了这种情况，必须让「写不进去就不动手」（`kvWritable` / `storeWritable`）。

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
2. ~~Worker 巡检回主人只能用免费模型~~ → 主人 2026-10-05（第十轮）改口「统一用免费模型处理」，**但当天下午又改回去了**：
   **主人把自己的 DSH API key 交给插件**，让「回主人」（私信 + 评论/回复）走付费那条 —— 现在 `brain.paid: 'deepseek'`
   （`lib/config.js` 与 `cloudflare/src/policy.js` 双镜像），`lib/brain.js` 的 `draftDmReply` 与 `lib/compose.js` 的
   `askArgs` 对 `isOwner` 传 `prefer: 'paid'`，**陌生人/刷视频/学习轮仍然 `''`（免费链）**。
   钥匙只进 GH secret（`gh secret set DEEPSEEK_API_KEY`，2026-10-05T05:44Z）与本机 `$DSH_HOME/.credentials.yaml`，
   **不落仓库、不写日志**。§7 里那句「出现（付费）就是有人偷偷改回去了」**已经作废** —— 现在回主人出现「（付费）」是**预期**，
   要警惕的是**陌生人**那条链出现付费。`brain.fallback` 仍是 `pollinations`（免费兜底），失败自动回落，不要改。
3. 云端整套跑通：**观察模式已关**（2026-10-05 下午，线上 `84f43e19…`，§1.8 ②末尾）；但 Worker 自己仍登录不上（-412），
   **真动手的是 GitHub Actions 的 `cloud/run.mjs`**（不看观察模式）。剩下的唯一拦路虎是 **KV 免费写额度 1000/天**（见 §7 的 🔴 段）——
   额度没恢复前云端每轮在 `storeWritable()` / `kvWritable()` 就返回。
4. 私信命令不只 `/搜`、`/转达`、`/帮助` 了：第六轮加了**大白话识别**（`lib/intent.js`）与 `/刷`。主人若还想要别的动作（比如「把这条记进待办」「去给 BVxxxx 留个言」），照 `lib/intent.js` 的 `matchIntent()` 加一档 + 在 `lib/dmcmd.js` 的 `runIntent()` 加一个分支就行 —— 记住铁律：**要办事的必须走代码，走模型只会得到承诺**。
5. ~~她自己刷片时账本 `watched` 那条 `topic` 是空的~~ —— **第七轮已修**（`watchThese({ ..., topic })` 现在把方向传进 `reportHistory` / `tripleVideo`，见提交 `772b003`）。
6. ~~**待主人确认**：① `policy.mentionOwnersOnReply` 要不要开回 `true`；② `policy.replyDmOthers: 'once'` 要不要放开；③ `minIntervalSeconds: 120` 要不要缩短。~~
   —— **第十轮主人一句话全拍定（m01645）**：① 保持 `false` 并**显式写进** `config.json`（回复主人评论不挂尾巴；一级评论的 @ 一直是好的）；
   ② 放开成 `'auto'`，并且 `replyPerRunOthers` 从 1 提到 3；③ 改成 `60` 秒。
7. **「三连」实际是「两连」**（第七轮实测）：她账号硬币 `money: 0`，投币必然空转，见 §1.9 ②。想真三连得让她账号有硬币。
8. **第九轮新上线的三件，请主人过后确认手感**：
   - ① 一次看多个：一条私信里写几个 BV 号就真看几个（最多 10 个）；也可以说「看 8 个拉康的视频」。
   - ② 自己刷的额度 `learning.dailyWatch: 30`（**0 = 不限**）：默认 30 个/天，**主人点名的片子不计入、也不受限**。嫌少改这个数字。
   - ③ 调试最高权限：`policy.ownerDebug: true` + `policy.debugMids: []`（空 = 两位主人都有；只想给金易木木元一位就填 `['391581639']`）。
     他可以在私信里说「状态」「额度」「日志」「配置」「改配置 policy.x 8」「最近」「重启」。**`force` 只免限额/间隔/去重，屏蔽词与未登录照样拦**。
     「重启」现在是**真重启**（看门鲸下一轮自己换一条命，日志接回 `dm-watch.log`）。
   - 遗留提醒：`lib/debug.js` 是**新文件**，往插件目录同步时别漏（§2.7）；调试台挂在 `lib/tools.js` 的私信分支上，**宿主 DSH 侧要重启才加载**（看门鲸那条链路不受影响）。
9. **第十轮留下的两件「只差一步」**：
   - ① ~~云端待命闸还没生效~~ → **2026-10-05 下午已 `wrangler deploy`**（Version `78da486c-0da8-4fc8-bc71-ff29c1ac226c`，
     上一版 `53f0bb54`）：线上已经是「本机在岗就 `standby: true` + `POST /patrol?force=1` 压过」那一版，
     而且**又多了一层「KV 写不进去也 standby（force 压不过）」**（见 §7 最后一条）。实测：`bili_cloud op=patrol` 回
     `standby: true` + notes 里 `云端 KV 写不进去（免费写额度 1000/天 见底？）`。
   - ② **Workers AI 的免费额度是每天 10000 neurons，会被写评论吃光**（第十轮当天就光了，`logs/brain.log` 里
     `4006: you have used up your daily free allocation of 10,000 neurons`）。光了她就靠 `brain.fallback: 'pollinations'` 说话（照样免费、不要 key），
     只是慢一点点。想彻底不愁只有两条路：**少让她写评论**，或**主人自己上 Cloudflare 付费计划** —— 他不想要付费，别擅自开。

## 7. ⚠️ 必须提醒主人
- 宿主（DSH）**重启**才会加载新的评论回复定时器与提示词。不过第三轮实测：主人插件目录一同步，宿主的评论回复链路**看起来已经热重载**成新代码了（旧代码那种「每 5 分钟往同一条评论追一条」的刷屏在同步之后就停了，`待回` 也归零了）。所以重启是**保险**，不是必需。
  - 第六轮又验证了一次这个现象：同步 `lib/tools.js`（11:39 落盘）之后宿主侧**没重启**，但看门鲸重启后大白话链路立刻可用。
  - 第九轮再加一条：**调试台是挂在宿主那份 `lib/tools.js` 上的**，所以要用私信运维台（状态/日志/配置/重启）**宿主必须重启**；
    但看门鲸自己那条链路（大白话支使、自己刷、三连评论）同步 + 重启看门鲸就够了。
- 本机的评论回复在宿主没重启时靠 §2.6 那只看门鲸（**第十一轮重启后是 pid 21412**）顶着；心跳在 `statePath('watchdog.json')`。
- 想让她跑腿，**直接说人话就行**：「搜一下拉康精神分析的视频」「你自己去找点视频看看」「帮我跟金易木木元说声谢谢」
  （斜杠命令 `/搜` `/刷` `/转达` `/帮助` 也还留着，老的用惯了不会失效）。**说「能不能帮我搜…？」也算命令**，不会再被当成请教方法。
  主人名下的片子想一次看几个：**把几个 BV 号一起发给她**（或说「看 5 个××的视频」）；她自己刷有每天 30 个的额度，主人点名的不算。
- **第七轮起她三连过的视频会顺手留一句评论**（正文自动 @ 两位主人）。想核对「她三连了哪些、评了什么」看
  `logs/actions.log` 里带「三连顺手」的行，和账本 `comments`（`bili_ledger op=list`）。
- **第十轮起**（m01645 一口气改的五件事）：**陌生人也不再「只回一条」**（`replyDmOthers: 'auto'`，一轮最多招呼 3 位陌生人）；
  对外动作间隔从 120 秒缩到 **60 秒**（主人侧仍是 5 秒）；**回主人改回付费**（主人当天下午把 DSH key 交了出来，见 §6 第 2 条）——
  私信回主人、回主人评论/回复走 `brain.paid: 'deepseek'`（钥匙走 GH secret 与本机凭据，不落仓库），
  **陌生人、刷视频、学习轮仍全走免费额度**（超额自动兜到 pollinations；`logs/brain.log` 里陌生人的行出现「（付费）」才是有人改坏了）；
  **回复主人的评论不再挂 `@` 尾巴**（一级评论的 @ 不受影响，一直好着）。
- **同一条评论不会云端、本机各回一遍了**：本机每轮巡检**先拉云端账本**再动手，`logs/auto.log` 里出现
  `cloud pull: 回复 N / 评论 N` 就是它在合并（`logs/cloudsync.log` 里是 `pull ok：并集后回复 N / 评论 N，云端草稿 M 条`）。
  云端那侧还加了「本机在岗（心跳 15 分钟内）就只待命」的闸，但要 `wrangler deploy` 才生效（§1.11 ⑤、§6 第 9 条）。
- **第十一轮起她的评论长得像「分享」了**（主人 2026-10-05 让她向「小鲸鱼呀deepseek」那只鲸鱼学）：一级评论是
  `@主人 主人！人家刷到一个很有意思的视频～` + `🎬《标题》` + `📝 人家觉得：…` + 收尾句（**多行、带标题**，不是原来那种一句感想）；
  动态更热闹（点数量、点系列名、3～5 个 emoji、`#话题#`）。README/提示词里那几段「不要总结视频」「不要 emoji 堆砌」**已经全部改成反面**，
  别照着旧记忆又改回去。
- **免费脑子会「节流」**：`logs/brain.log` 里出现 `http 402：免费家节流，等 8 秒再问一次` 是**正常**的（pollinations 对匿名调用限速，
  隔 3～4 秒必挡、隔 20 秒以上就通），代码会自动等一下重试一次；一直 402 才是真出问题。想少撞它就别让评论/动态挤在同一秒里发。
- **🔴 2026-10-05 下午挖到的真凶：Cloudflare KV 免费「写」额度是 1000/天，会被我们自己写光。**
  （不是脑子抽风，也不是去重写错——这一天上午那条「同一条评论被回 6 遍」的刷屏就是这个。）
  - **现场**：`wrangler kv key put` 直接报 `your account has reached the free usage limit for this operation for today [code: 10048]`；
    KV 里 `state:meta.localSeenAt` / `state:ledger.lastActionTs` 停在 **04:36–04:37Z**，而当时已经 05:56Z ⇒ 状态冻结约 80 分钟。
  - **为什么看不出来**：`cloudflare/src/store.js:54` 的 `putJson` 是 `try { await kv.put(...) } catch { return false }` —— **静默吞掉失败**，
    而 `POST /state` 完全不检查返回值，照样回 `{ok:true}` 和一份「合并后」的假象配置。
  - **后果**：① 云端（GH Actions / Worker）拿的是几小时前的旧账本 ⇒ `repliedToComment` 认不出「回过」，**重复回复**；
    ② KV 里那份旧 `state:config` 会**盖住**仓库默认值（`loadState` = defaults ← `varsConfig(env)` ← `state:config`），
    旧配置里 `dailyVideoComments: 0` 是**不限量**，所以那段时间视频评论照发。
  - **写量账**：本机 `syncOnce` 每 5 分钟一轮 = `POST /state`（账本+cookie+草稿+meta ≈ 4 写）+ `POST /config`（1 写），
    再加 GH cron 与 Worker cron，一天一千多次 ⇒ 中午见底。**额度按 UTC 零点重置（北京时间早上 08:00）**。
  - **已做的五道修**（提交 `618bb0f` + `0a69f5b` + `fa63ed9`，`cloudflare` 已 deploy **`bd2e286f-a288-4d60-ab4a-91ba2adf2230`**，上一版 `78da486c-0da8-4fc8-bc71-ff29c1ac226c`）：
    1. **Worker 端**：`/state`·`/config`·`/heartbeat` 都回 `persisted`（`false` = 没落盘）；`/state` 不再每轮 `appendCloudLog`（省一次写）；
       新增 **`POST /probe`**（写一个 nonce 再读回来）。
    2. **`cloud/run.mjs`**：动手之前先 `storeWritable()`（打 `/probe`），读不回来就 `return` —— 宁可少干一轮，不拿旧账本重复回复。
    3. **`cloudflare/src/patrol.js`**：`runPatrol` 里新增 `kvWritable(env)`，写不进去就 `standby: true`，**`?force=1` 也压不过**；
       日志里 `待命=` 现在区分「是（本机在岗）」与「是（云端 KV 写不进去）」。
    4. **本机 `lib/cloudsync.js`**：`pushState`/`pushConfig` 带指纹，内容没变就整轮跳过（心跳至少每 5 分钟一次）；
       没落盘就**不记指纹**（下轮重试），并写 `push 没落盘：云端 KV 写不进去（免费写额度见底？）`。
       内容没变但心跳旧了的时候**只打 `/heartbeat`**（1 写）而不是重推二十多 KB 的账本（`heartbeat()` 现在会把
       `persisted` 透传出来，`lib/cloudsync.js:297`）。
    5. **Worker 端「内容没变就不写」**（最省的一刀，也是唯一**不依赖本机升级**的一刀）：`/state` 只写真的变了的
       账本/草稿/cookie，`meta` 只要存的那份心跳还在 10 分钟内（`META_SKIP_MS`）就不重写，响应里多回 `skipped` / `wrote`；
       `/config` 内容没变既不写也不记日志。**宿主里还跑着旧代码的定时器也因此在云端被跳过**（旧代码每 5 分钟照推，
       云端一比对就跳过，通常 0～1 写）。
  - **频率**：`.github/workflows/whale.yml` 的 cron `*/10` → **`*/30`**，`cloudflare/wrangler.toml` 的 `[triggers] crons` 同步改 `*/30`
    （私有仓库 Actions 免费额度 2000 分钟/月，`*/10` 是 2880 轮/月，稳超；改小后约 1440 轮/月）。
  - **⚠ `wrangler.toml` 的 `[vars]` 会盖住 `cloudflare/src/policy.js` 的代码默认值**（`varsConfig` → `deepMerge`），
    改默认值必须**两处一起改**：这次把 `DAILY_VIDEO_COMMENTS 3→5`、`DAILY_REPLIES 10→5`、`MIN_INTERVAL_SECONDS 120→60` 同步过去，
    顺手把 `WHALE_NAME` 改成新名字「寻和橼的大肥鱼dsh」。
  - **实测证据**：GH dispatch run `37270399633`（13 秒就结束）日志只有两行结果 ——
    `状态拉取完成：cookie 5 项 · 账本草稿 6 条` 接着就是 `云端 KV 写不进去（读回来的 nonce 对不上）→ 本轮不动作，免得拿着旧账本重复回复`；
    `bili_cloud op=patrol` 也回 `standby: true` + 同样的 notes。
    线上 `/state` 连打三次空 body 自带证据（临时探针，跑完已删）：三次都是
    `{"persisted":false,"wrote":1,"skipped":["ledger","pending"]}` —— **账本/草稿确实没写（跳过生效）**，
    唯一那次写是 `meta`（存的心跳已经旧过 10 分钟，该重写），`persisted:false` 则继续证明额度还没恢复。
  - **⚠ 宿主（DSH 主进程 11384 里的插件）跑的还是老代码**：改 `lib/*.js` 必须重启宿主才会重新加载模块（Node ESM 只在启动时读）。
    老代码不知道指纹/跳过，会照旧每 5 分钟推一次 —— 靠上面第 5 刀在云端拦掉。**要彻底省，得重启一次 DSH**（主人决定）。
  - **额度恢复之前**：云端两条线都不会碰 B 站（本机看门鲸照常干活，它用的是本机 `ledger.json`，安全的那条）。
    恢复之后第一次对账会把新配置/新账本自动补上去（没落盘的指纹没记，所以会自动重试），**不用手动推**。

## 8. 2026-10-05 下午（第二轮搬家）：云端自愈 + 仓库转公开 + 每 5 分钟

主人两句话定了这一段的方向：**「开始往云端搬项目，观察模式关掉」** → 随后选了**「仓库转公开 + 每 5 分钟」**和**「现在就关电脑，云端按旧政策先跑」**。

1. **观察模式已关**（线上 Worker `84f43e19-1d46-4c88-9855-8d1edf13faaf`，`wrangler.toml:48` `OBSERVE_ONLY="false"`）：
   `bili_cloud op=status` → 「观察模式：关（按策略真发）」。Worker 自己仍 `loggedIn:false`（出口 IP 被 B 站 -412），
   **真正会动手的是 GH Actions 的 `cloud/run.mjs`**（它根本不看 `observeOnly`）。
2. **配置自愈（这一轮最重要的新增）**：KV 里那份 `state:config` 会盖住代码默认值，本机一关机就没人推新政策了。
   新增 `cfgVersion`：`lib/config.js` DEFAULTS 与 `cloudflare/src/policy.js` 都是 `cfgVersion: 1`；
   `lib/cloudsync.js` 的 `cloudConfigPatch()` 会带上 `patch.cfgVersion = Number(cfg.cfgVersion)`；
   `cloud/run.mjs` 新增 `healConfig(state)`，在「本机在岗让位」与 `storeWritable()` 两道闸**之后**跑：
   云端 `state.config.cfgVersion` 比仓库默认值旧 → `POST /config` 用仓库默认值重推 `policy/feed/learning/dailyDynamic` 四组
   （日志 `云端配置是旧的（版本 x → y）：已用仓库默认值重推一遍`；没落盘就下一轮再试）。
   ⇒ **以后改 `policy/feed/learning/dailyDynamic` 默认值，记得 `cfgVersion` +1**，否则云端不会自愈。
3. **频率 `*/30` → `*/5`**（`.github/workflows/whale.yml` 的 cron），前提是仓库已**转公开**（Actions 分钟数不再受 2000 分钟/月限制）。
   同时 `cloud/run.mjs` 末尾加了「没事发生的轮次不写日志」：`quiet = line === '' && TASK === 'patrol'`，
   只留每小时一声「无事发生（巡检还在跑）」（`new Date().getUTCMinutes() < 10`），
   否则 `*/5` 光 `/log` 就 288 写/天，加上每轮 `/probe` 的 nonce 会顶满 1000 写/天 的免费额度。
4. **仓库转公开**：`https://github.com/lzzxbdonj/bili-whale`（`gh repo view` 回 `isPrivate:false`）。
   转公开前扫过：`.gitignore` 已挡 cookie/密钥文件；历史里只有测试夹具（`SESSDATA=abc%2Cdef…`）和占位符
   （`${{ secrets.WHALE_TOKEN }}`、文档里的 `DEEPSEEK_API_KEY=sk-...`）；**真钥匙 `sk-ec3f9c4d…` 全历史无命中**，
   工作区树再扫一遍也是「干净」。
5. **提交**：`9ee3ba8`（自愈 + `*/5` + 省日志，7 files +63/−9）已 push；`52336ce`（关观察模式）、`2be833a`（HANDOFF 更新）。
   插件目录 `C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-bilibili-whale` 已同步（5 个关键文件 MD5 `same`）；
   看门鲸重启为 pid **29148**（14:37:12）。
6. **还没来得及验的**：KV 免费写额度要到 **00:00Z（北京 08:00）** 才恢复，所以「云端自己顶上 + `healConfig` 真跑一遍」只能等那时看 GH 日志。

