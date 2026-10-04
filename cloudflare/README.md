# bili-whale 云端常驻（Cloudflare Worker）

小鲸鱼娘女仆的「云端值班室」：即使主人的电脑关着，她也照常巡检 B 站消息中心、
按策略回话、到点发学习动态，并把视频一级评论做成草稿排队等主人点头。

```
cron (*/10 * * * *)  ──►  runPatrol()  ──►  KV: ledger / pending / meta / log
                                             ▲
主人（本机 DSH 的 bili_cloud 工具）──────────┘  /status /pending /approve /reject
```

## 一、端点

除 `/health` 外**全部要求令牌**：请求头带 `x-whale-token: <ADMIN_TOKEN>`（或 `Authorization: Bearer ...`）。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/health` | 免鉴权自检（Worker 活着吗、KV/AI 绑定了吗） |
| GET | `/status` | 登录态、等级、可写与否、今日计数、待确认数、最近一次巡检结果 |
| GET | `/inbox` | 消息中心「回复我的」→ 待回复清单（主人★优先、别人是否已回过） |
| GET | `/pending` | 待主人点头的视频评论草稿队列 |
| POST | `/approve` | `{"id":"..."}` 放行一条草稿（真发到 B 站） |
| POST | `/reject` | `{"id":"..."}` 丢掉一条草稿 |
| POST | `/comment` | 直接起草评论：`{bvid,message,confirm}`；`confirm` 模式会排队 |
| POST | `/reply` | 直接回复某条评论：`{bvid,root,message,toMid,toName}` |
| POST | `/dynamic` | 发一条动态：`{text}`（会记账，避免同一天巡检再发） |
| POST | `/patrol` | 手动跑一趟巡检（不等 cron） |
| GET | `/log` | 最近 100 条云端日志 + meta |
| GET/POST | `/config` | 读 / 深合并写 KV 里的配置覆盖（`state:config`） |
| GET | `/feed` | `?kind=popular\|ranking\|rcmd\|search&q=&limit=` 看当前刷到的内容 |
| GET | `/video` | `?bvid=` 视频详情（含标签） |
| GET | `/comments` | `?bvid=` 评论列表 |

## 二、状态（KV）

绑定 `WHALE_KV`，键位：

| 键 | 内容 |
| --- | --- |
| `state:cookies` | 运行时 cookie（主要是 buvid3/buvid4 匿名指纹；登录串在机密里） |
| `state:config` | 主人用 `/config` 覆盖的配置（与 `lib/config.js` 的 DEFAULTS 同构） |
| `state:ledger` | 账本：comments / replies / dynamics / daily 计数 / msgSeen（消息去重） |
| `state:pending` | 待确认草稿队列（同视频只留一条，上限 20） |
| `state:meta` | 巡检元信息（lastPatrolAt / lastPatrolResult / pendingDynamic） |
| `state:log` | 最近 100 行运行日志 |

机密（`wrangler secret put`）：

- `BILI_COOKIES` —— 登录 cookie 的 JSON（`{cookies:{...}}` 或裸对象都认）；内容来自本机
  `~/.dsh/bilibili-whale/cookies.json` 的 `cookies` 字段。
- `ADMIN_TOKEN` —— 遥控台令牌（32 位 hex），发给本机 DSH 的 `bili_cloud` 工具用。

## 三、部署 / 运维

```bash
# 部署（本机 wrangler 在 StudyMate-Web 的 node_modules 里）
node C:\Users\Administrator\Downloads\StudyMate-Web\node_modules\wrangler\bin\wrangler.js deploy

# 看实时日志（cron 跑得对不对）
node ...wrangler.js tail

# 手动跑一趟巡检 + 看状态
curl -H "x-whale-token: $TOKEN" https://bili-whale.<账号>.workers.dev/patrol -X POST
curl -H "x-whale-token: $TOKEN" https://bili-whale.<账号>.workers.dev/status
```

## 四、观察模式（observeOnly）与「转正」流程

账号（`bili_83352132154`）目前是 **Lv0 未转正**：B 站会以 `4126021 等级不足无法发送` 拒发动态与评论。
所以云端默认 `OBSERVE_ONLY="true"`：**只读 + 排队，一个写请求都不发**。

转正（主人在 App 里做答题/攒经验到 Lv1）之后，把 `cloudflare/wrangler.toml` 里的

```toml
OBSERVE_ONLY = "true"     # → "false"
```

改掉重新 `deploy` 即可让她真正开跑。届时：

- `meta.pendingDynamic` 里攒下的动态草稿会由下一趟巡检重新起草发出；
- 观察模式期间**不会**把主人的回复标记成已读，所以那些回复会照常补上；
- 待确认队列里的视频评论草稿仍在，主人点 `/approve` 才发。

## 五、离线联调

```bash
node test/port.test.mjs          # 移植件与源文件逐项一致（md5/wbi/policy/ledger/bili）
node test/patrol.mock.test.mjs   # 假 KV + 假 fetch 驱动真 Worker：34 项场景断言
```

`patrol.mock.test.mjs` 覆盖：令牌校验、`/health` 免鉴权、观察模式零写请求、草稿排队与
`/approve` 放行、Lv0「存着不丢」、主人优先回复、当日配额与最小限流、动态一天一条。
