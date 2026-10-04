# dsh-bilibili-whale —— 小鲸鱼娘女仆的 B 站手脚

给 DSH 加一只**可爱的鲸鱼娘女仆**：她能刷 B 站、看视频、读评论，
以小鲸鱼娘的口吻在评论区留言、回复主人的评论、每天发一条学习动态。

- **人格**：`persona/whale-maid.md`（自称「人家」，喊你「主人」，评论 15～60 字带具体细节）
- **工具**：10 个 `bili_*` 工具（读取 + 受策略管控的写入）
- **策略**：主人优先 / 别人一人一条 / 每日配额 / 同视频去重 / 屏蔽词 / 最小间隔
- **预设**：agent preset「鲸鱼娘女仆」，在 DSH 里一键切换

## 一、装了什么

| 位置 | 内容 |
| --- | --- |
| `~/.dsh/profiles/desktop/node_modules/dsh-bilibili-whale/` | 插件本体（本仓库的副本） |
| `~/.dsh/cordis.patch.yml` | 两条补丁：`biliwhale`（全局注册 10 个工具）+ `whalemaid-preset`（人格预设） |
| `~/.dsh/.agent-presets/whalemaid/` | 旧版 DSH 用的预设目录（preset.yml + agent.cordis.yml） |
| `~/.dsh/bilibili-whale/` | 运行状态：`cookies.json` 登录态、`config.json` 配置、`ledger.json` 账本、`logs/` 日志、`boot.json` 加载标记 |

改完配置/人格后：改 **`~/.dsh/bilibili-whale/config.json`** 立即生效（无需重启）；
改人格要重跑 `node tools/install-preset.mjs` 让预设重新生成。

## 二、工具一览

读取（随便用）：

| 工具 | 作用 |
| --- | --- |
| `bili_status` | 登录态、可写权限、今日配额、今天动态发没发、当前策略模式 |
| `bili_feed` | 刷 B 站：`rcmd` 首页推荐 / `popular` 热门 / `ranking` 排行榜 / `search` 关键词 |
| `bili_video` | 视频详情（简介、标签、数据、分P）+ 可选一屏热评 |
| `bili_comments` | 评论列表（一级 + 楼中楼摘要，带 rpid / UID / 昵称） |
| `bili_ledger` | 账本：今日战果、最近动作、塞学习素材、忘记某视频的评论记录 |
| `bili_config` | 读/改/重置配置（深合并 JSON patch） |

写入（全部过策略闸门）：

| 工具 | 默认模式 | 说明 |
| --- | --- | --- |
| `bili_comment` | `confirm` | 视频一级评论：先出草稿，主人点头后 `confirm=true` 才发 |
| `bili_reply` | `auto` | 回复评论：主人永远优先；别人同一评论串一条、24 小时一条 |
| `bili_dynamic` | `auto` | 发动态：每天一条，20:30 定时自动发（可关） |
| `bili_follow` | `auto`（只跟主人） | 关注 / 取关 / 查关系；默认只允许关注主人 |
| `bili_dm` | `auto`（主人）/ `once`（别人） | 私信：`list` `read` `reply` `ack` `send` `draft` `check` |
| `bili_favorite` | `auto` | 收藏：`add` `remove` `folders` `create` `list` `check`（每天最多 5 个） |
| `bili_cloud` | — | 遥控台：看/管云端 Worker（状态、待确认草稿、点头放行）；云端曾被 B 站 `-412` 拦死，现留作遥控台 |
| `bili_login` | — | `start` 生成二维码并打开扫码页 / `poll` 轮询 / `import` 导入 cookie / `logout` |

**私信回复的「脑子」**：`lib/brain.js` 在本机调 DeepSeek 生成真回复（只在主人私信时用），
Key 来源 环境变量 `DEEPSEEK_API_KEY` → `config.brain.apiKey` → `$DSH_HOME/.credentials.yaml`；
模型不可用自动回退 `dmAck.rules` 关键词 / `dmAck.templates` 模板，关掉它（`{"brain":{"enabled":false}}`）她照样收发。

## 三、登录

```bash
node lib/cli.mjs login-start    # 生成二维码并在默认浏览器打开扫码页
node lib/cli.mjs login-poll     # 手机扫码后轮询，成功后 cookie 落盘
node lib/cli.mjs status         # 确认已登录
```

在 DSH 里让模型跑就行：`bili_login op=start` → 主人扫码 → `bili_login op=poll`。

- 登录态只存在本机 `~/.dsh/bilibili-whale/cookies.json`，不外发。
- 未登录也能读：热门、排行榜、视频详情、评论、搜索（需要 buvid 指纹，插件自动去拿）。
- 需要登录的：首页推荐、发评论/回复/动态。
- `SESSDATA` 有效期通常数月；失效时 `-101`，重新扫码即可。

## 四、策略（`config.json`）

```jsonc
{
  "ownerName": "懒寻真",          // 主人昵称：回复优先级最高
  "ownerMid": 123456,             // 主人的 UID（登录后自动补齐，认得更准）
  "policy": {
    "postVideoComment": "confirm",// auto | confirm | off
    "postReply": "auto",
    "postDynamic": "auto",
    "replyPerUserPerThread": 1,   // 别人：同一评论串最多回几条
    "replyPerUserWindowHours": 24,// 别人：同一人多少小时内只回一条
    "dailyVideoComments": 3,
    "dailyReplies": 10,
    "dailyDynamics": 1,
    "minIntervalSeconds": 120,     // 两次对外动作的最小间隔
    "minIntervalSecondsOwner": 15, // 回复主人时可以更勤快
    "maxCommentChars": 200,
    "blockKeywords": ["加群", "微信", "QQ群", "代刷", "互粉", "刷单", "博彩", "赌博"]
  },
  "dailyDynamic": { "enabled": true, "at": "20:30", "templates": ["..."] }
}
```

想让她更大胆：把 `postVideoComment` 改成 `"auto"`（一级评论也直接发）。
想让她安静：任意一项改 `"off"`，或整体 `postReply: "off"`。

## 五、命令行（不启动 DSH 也能用）

```bash
node lib/cli.mjs status
node lib/cli.mjs feed --source popular --count 5
node lib/cli.mjs search "大肥鱼" --count 5
node lib/cli.mjs video BV1xx --comments 8
node lib/cli.mjs comments BV1xx --count 20
node lib/cli.mjs comment BV1xx "正文" --confirm
node lib/cli.mjs reply BV1xx 12345 "正文" --confirm --uname 懒寻真 --mid 123
node lib/cli.mjs dynamic --text "今天也在认真学习" --confirm
node lib/cli.mjs daily            # 手动触发一次定时动态
node lib/cli.mjs ledger today
node lib/cli.mjs config set '{"policy":{"postVideoComment":"auto"}}'
```

加 `--json` 打印原始结构。

## 六、维护脚本

| 脚本 | 作用 |
| --- | --- |
| `tools/patch-home.mjs` | 往 home 补丁追加 `biliwhale` 工具行（幂等，带备份） |
| `tools/install-preset.mjs` | 生成「鲸鱼娘女仆」预设（目录 + 声明式入口），改人格后重跑 |
| `tools/verify-patch.mjs` | 校验 home 补丁仍是合法 YAML，并列出结构 |

## 七、已知边界与风险

- **风控**：自动评论有被限流/禁言的真实风险。默认配置已经压到很保守
  （一级评论要主人点头、每天最多 3 条、间隔 2 分钟、同视频只评一次）。
  实测建议先用小号跑一周。
- **时间序评论**：`bili_comments sort=0`（按时间）在未登录时会被服务端拒，插件自动回退热度排序。
- **动态接口**：`x/dynamic/feed/create/dyn` 的载荷随 B 站前端更新可能变，失败会在 `logs/` 里留痕。
- **接口都是非官方接口**，B 站随时可能改；`CODE_HINT` 表负责把常见错误翻译成中文动作建议。
- **登录态是明文 cookie**：本机文件，注意别把 `~/.dsh/bilibili-whale/` 分享出去。

## 八、License

MIT。人格设定与工作流为本项目原创；B 站接口调用遵循其公开 Web 端行为，请自行遵守平台规则。
