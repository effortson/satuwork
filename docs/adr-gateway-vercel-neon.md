# ADR：Gateway 全面进入 Vercel + Neon

- 状态：**已接受**（2026-09-10），**已实施**（同日，见 §10）
- 影响范围：gateway/、manager/、bot/、desktop/、e2e/
- 前置阅读：[gateway-runtime.md](gateway-runtime.md) §2、§3.0、§7、§12；[routines.md](routines.md) §1

## 0. 一句话

**Gateway 变成一组无状态的接口 + 一份静态界面 + `/v1` 模型代理，跑在 Vercel Functions
上，数据在 Neon。** 今天它进程里所有「自己会动的」和「握着长连接的」东西，按机器切分的
下沉到席位机器，按人切分的下沉到桌面端，剩下的分钟级扫描交给 Vercel Cron。

这不是「把现有进程搬上去」。现有进程搬不上去，原因见 §1。

## 1. 背景：为什么今天的 Gateway 上不了 Vercel

Gateway 是一个常驻的 `node:http` 守护进程（[gateway/src/index.ts](../gateway/src/index.ts)）。
Vercel Functions 现在能收 WebSocket、能流 SSE、请求体 100 MB、默认 300 秒，所以
「能不能开长连接」已经不是拦路的。拦路的是三件别的事：

1. **没有 always-on。** 进程里有五个自己会动的定时器：日常任务调度器（30 秒一拍，触发后
   挂在席位 SSE 上等最长 20 分钟）、渠道分发器（Telegram 30 秒长轮询、每秒扫、租约每
   10 秒续）、名单流心跳、Telegram typing 脉冲、以及挂在调度节拍上的交接催办 / 审计派发 /
   模型发现。没有函数实例会替它们跑。
2. **进程内共享状态。** 本地运行时隧道把 WebSocket 句柄存在一张 `Map` 里
   （[local-runtime.ts](../gateway/src/local-runtime.ts)）；名单流按账号在进程内共享一套
   上游订阅、最后一个页面走掉还留 30 秒（[roster-stream.ts](../gateway/src/lib/roster-stream.ts)）。
   Fluid Compute 复用实例，但不保证两条相关的连接落在同一个实例上。
3. **小时级连接。** 对话 SSE、日常任务等待、桌面 WebSocket 都是小时级，函数的时长上限
   盖不住，而且每条都在计费。

外加几处「不是不能改，但要改」：JWT 密钥对和渠道密钥落在磁盘；发布包最大 256 MB 落在磁盘；
迁移在进程启动时跑；Router 是裸的 `node:http`；可信代理名单只认自己的反代。

Neon 这一半没有障碍：它就是 PostgreSQL。今天把 `GATEWAY_DATABASE_URL` 指过去，Gateway
一行不改就能跑（用**直连串**，见 §5.2）。

## 2. 决定

### 2.1 总纲：三个进程各管一段

| 进程 | 在哪 | 管什么 | 有没有状态 |
| --- | --- | --- | --- |
| Gateway | Vercel Functions + Cron | 控制台接口、界面静态文件、`/v1`、连接器与搜索代理、机器工人接口、分钟级扫描 | **没有**。所有状态在 Neon 和 Blob |
| 席位工人 | 每台席位机器，管家起停的非 root sidecar | 本机席位的日常任务、渠道、名单流、对话流直连 | 进程内只有缓存；真相在 Gateway 的库 |
| 桌面端 | 员工电脑 | 本地 Bot 的一切：界面、对话、调度、Bot 层记忆与私有 Skill | 本地磁盘；只从 Gateway 拿票、模版、公司层数据、模型代理 |

拆分的判据只有一条：**谁会主动打谁。** 今天 Gateway 主动打席位（部署、发任务、订阅事件）
和主动打本地 Bot（穿隧道）。拆完之后 **Gateway 不再主动打任何人**：席位工人和桌面端都是
「有事来问它」，它只回答。这一条成立，Gateway 才是无状态的。

### 2.2 决定一：席位工人凭 `smt_` 走 Gateway 接口，不直连库

**选的：** Gateway 开一组「机器工人」接口，鉴权用现有的机器票 `smt_`，一台机器**只能**拉到
本机席位的到期任务、本机 Bot 的渠道事件，只能回报本机的结果。

**没选的：** 席位工人直连 Neon。代码少（`routines.ts`、`channels.ts` 几乎可以原样搬过去），
但每台客户机器上都要躺一份平台库凭据，泄一台等于泄全平台。机器在客户机房里，不在我们手上。

**代价：** 要新写一层接口，`routines.ts` 里那十几个 `db.*`、`channels.ts` 里二十几个都要
各对应一条。可以按「领取 / 续租 / 回报」三个动词收敛，不必一一对应。领取用库里现有的
`claim*` 语义（带 `machineId`），保证两台机器不会领到同一条。

### 2.3 决定二：管家验用户 JWT，换成席位票再交给 Bot

**选的：** 对话流和名单流由浏览器**直连**席位机器的二级域名。席位工人验浏览器带来的登录
JWT（管家已经为桌面票拉着 Gateway 的 JWKS，见 [config.ts](../manager/src/config.ts) 里
`jwks`），再换成这颗 Bot 的 `sat_` 交给本机的 Bot。

**没选的：** 继续由 Gateway 反代对话流。这条是热路径，也是小时级连接，留着就等于 Gateway
必须常驻。

**要补的规矩：**

- 管家今天只认两种东西：`smt_`（Gateway 来的）和桌面票（JWT，五分钟）。现在多认第三种：
  **登录 JWT**，只用来换本机的 `sat_`，**不能**用来调管家的控制类接口（部署、删席位、拉日志）。
  那些照旧只认 `smt_`。
- `sat_` 今天是 Gateway 在部署时写进 `bot.env` 的。工人要拿到它，管家在 deploySeat 时顺手
  留一份在 `/etc/satuwork/seats/<seatId>.json`（0600，属工人用户），不要再向 Gateway 要。
- 跨源：页面源是 Gateway，请求打机器域名。管家对 Gateway 的源开 CORS，`Authorization`
  要预检，SSE 用 `fetch` 不用 `EventSource`。**好处顺带拿到**：SSE 换了一个源，HTTP/1.1
  那 6 条连接的墙（§7.1）不再挡控制台自己的请求。
- 撤销：`account.tokenRevokedAt` 今天是 Gateway 每条请求查一次库。管家没有库，只能靠 JWT
  的 `exp`。把 `GATEWAY_JWT_TTL_SECONDS` 压到 1 小时以内，并在停用账号时让 Gateway 主动
  对该账号所在机器打一条 `POST /seats/revoke`（这是 Gateway 唯一保留的「主动打机器」，
  是一次性请求响应，不违反 2.1）。

### 2.4 决定三：新逻辑跑在非 root 的 sidecar，管家只管起停

**选的：** 新增一个 systemd 单元 `satuwork-worker.service`，跑在专用用户下，监听
`127.0.0.1` 的一个端口；管家的对外端口把 `/w/*` 反代给它，其余路径不变。管家负责装它、
升级它、看着它活。

**没选的：** 把三千行业务逻辑塞进管家。管家是 root、8.6k 行、只做部署和反代，暴露面清楚。
渠道和调度逻辑要解析第三方消息、要拼提示词、要跟会话事件打交道，这类代码不该有 root。

**代价：** 多一个单元、多一种发布包（`worker-<version>.tgz`），机器协议号升到 5。管家侧
的自升级已经有「换版 / 心跳确认 / 回滚」那套（[upgrade.ts](../manager/src/upgrade.ts)），
worker 复用同一套，不另写。

## 3. 逐项去向

| 今天在 Gateway 里 | 去哪 | 怎么做 | 备注 |
| --- | --- | --- | --- |
| 桌面反代 `desktop.ts` | **已删** | 全铺二级域名后每台机器填 `directUrl`；协议 ≥4 直连 | 没配 `directUrl` 的机器没有桌面 |
| 对话 SSE / JSON / 上传 / 下载反代（`lib/runtime.ts`） | 席位工人 | 浏览器直连 `https://<机器>/w/seats/:id/bot/*`，工人验 JWT 换 `sat_` | 决定二 |
| 名单流 `roster-stream.ts` | 管家（**已删** Gateway 那份） | 账号粘机器（§3.0），一个人所有席位 Bot 都在一台机上，整段逻辑搬进 manager/src/roster.ts | 本地 Bot 那一行由桌面端推的索引补 |
| 日常任务调度 `routines.ts` | 席位工人 | 工人每 30 秒 `GET /worker/routines/due`，领到就在本机跑，`turn/end` 后回报 | 定义、流水、补跑仍在 Gateway 的表里 |
| 渠道分发 `channels.ts` | 席位工人 | 长轮询换 **webhook**：`https://<机器>/w/channels/telegram/<secret>`；事件账本、配对、租约仍走 Gateway 接口 | 决定一；机器要能出网到 Telegram |
| 交接催办 `handoff-sweep.ts` | Gateway Cron | 每分钟一跑，无状态 | 「告诉 Bot 没人接」这一步改成写一条待办，由工人下一拍拉走 |
| 对话审计派发 `conversation-audit.ts` | Gateway Cron + 工人 | Cron 切窗口、写批次；工人拉本机批次派给席位 | |
| 模型发现、订阅重算、Bot 删除状态机 | Gateway Cron | 每分钟一跑 | 删除里「清席位」那一步改成写待办给工人 |
| 本地运行时隧道 `local-runtime.ts` | **删** | 桌面端独立，见 §4 | |
| 发布包上传 / 下载 `releases.ts` | Vercel Blob | 上传改成签一张直传 URL，Gateway 只登记；管家拉包走 Blob 的私有 URL | 256 MB 超过函数 100 MB 请求体 |
| JWT 密钥对、渠道密钥 `crypto.ts` | 环境变量 | 启动时从 env 读；轮换靠改 env 重新部署 | JWKS 照旧从 `/.well-known` 发 |
| 迁移 `db/migrate.ts` | build 步骤 | `vercel build` 前跑 `node --import tsx src/db/migrate.ts`，用 Neon 直连串 | 迁移锁是会话级 advisory lock，直连串上正常 |
| 清库时的 schema 占用锁 `db.ts claimSchema` | 只留给 e2e | 生产从来走不到（只在 `GATEWAY_PG_RESET` 下拿），保持不动 | |
| `/v1` 模型代理 | Gateway 原地 | 流式但单次有界，300 秒够 | 可选：加 `maxDuration` 到 800 |
| 连接器、网页搜索代理 | Gateway 原地 | 出站请求响应 | |
| 控制台全部 JSON 路由 | Gateway 原地 | Router 包一层 `(req, res)` 适配即可 | |
| `ui/` 静态文件 | Vercel 静态 | 分片直接当静态资源发；`GATEWAY_UI_CDN` 那条逻辑退休 | |

新增在 Gateway 的接口（全部 `smt_` 鉴权，只回本机的数据）：

```
GET  /worker/routines/due            领本机到期任务与补跑
POST /worker/routines/:runId/renew   续租
POST /worker/routines/:runId/finish  回报 ok / error / 结果不明
GET  /worker/channels/bindings       本机 Bot 的渠道绑定（token 解密后下发，工人只留内存）
POST /worker/channels/events         webhook 收到的原始事件入账本（Gateway 去重、分配 seq）
GET  /worker/channels/events/due     领本机待处理事件
POST /worker/channels/events/:id     续租 / 完成 / 失败
GET  /worker/todo                    Gateway 侧扫描留下的待办：交接结果、删席位、审计批次
POST /worker/todo/:id                回报
```

`due` 类接口都是**领取**语义：一次调用同时完成「查 + 标记为本机持有 + 写租约」，两台机器
撞不上。租约到期没回报，Gateway 的 Cron 把它标回可领取；这就是「机器离线导致漏跑」的记法，
流水上写「机器未领取」而不是「失败」。

## 4. 桌面端：独立的系统

桌面端从「装 Gateway 界面的空壳」变成**自己 hold 自己逻辑的客户端**。它和 Gateway 之间
只剩出站的请求响应：

| 从 Gateway 拿 | 为什么不能本地 |
| --- | --- |
| 登录、`sat_`、`sk_sw_` | 身份只有一份 |
| 这颗 Bot 的定义和模版（系统提示、守卫、记忆策略、常驻 Skill 清单） | 公司的口径，管理员在 Gateway 改 |
| 公司层 / 分组层记忆、公司 Skill | 要进全公司提示词，只能拉不能改 |
| `/v1`、连接器、网页搜索 | 计费和上游密钥 |
| 本地运行时发布包清单与下载 | 本来就是拉 |

| 在本地做 | 说明 |
| --- | --- |
| 界面 | 把 `gateway/ui` 那批分片**原样打进包里**，不分叉。加一层请求前缀：本地 Bot 打 `127.0.0.1:<port>`，远程 Bot 与需要 Gateway 的那几条照旧打 Gateway。README 里「内置前端会漂」的顾虑已接受：界面版本跟着桌面端发版走 |
| 对话与会话全文 | 直接打本机 Bot 的 HTTP 口，不过 Gateway |
| Bot 层记忆、Bot 自己写的私有 Skill | 落本地。今天放 Gateway 只因席位会被重装，桌面端没有这个问题 |
| 日常任务调度 | 定时器进壳子；定义存本地；跑完推一条流水到 Gateway 供后台查看 |
| 会话索引、审计上报 | Bot 现成的 gateway-outbox 出站队列，不动 |
| 运行时更新 | 壳子加一个小时级定时器调现成的 `stage_runtime_update`，只下载写 PENDING；所有本地 Bot 都停下时再提升 |

**本地 Bot 从此放弃的能力**，界面上要写明：

- 只能在这台桌面端上对话。别的浏览器和管理员后台只看到它推上来的索引，没有实时灯。
- 日常任务只在电脑开着、应用开着时跑。
- 转人工只有开单；「有人接了 / 没人接」由 Bot 自己轮询单子状态取回。
- 不能绑渠道。

隧道（`bot/src/local-tunnel`、`gateway/src/local-runtime.ts`、`instances.host` 里的
`satu-local://`）整体删除。

## 5. Gateway 自身的工程项

### 5.1 Vercel

- **入口**：`api/[...all].ts` 一个函数接全部路由，内部还是现在的 `Router`；包一层把
  Vercel 的 `(req, res)` 交给 `router.handle`。`listen()`、`server.on('upgrade')`、
  `SIGTERM` 那些只在本地 `pnpm dev` 时用。
- **Cron**：`vercel.ts` 里挂 `* * * * *` 一条打 `/cron/tick`，里面顺序跑 §3 那几项分钟级
  扫描；每项自己有 `claim`，重入无害。
- **客户端 IP**：`GATEWAY_TRUSTED_PROXIES` 的语义改成「在 Vercel 上信 `x-forwarded-for`
  最右那一跳」。配对时记「机器在哪」这件事本来就只在管家配对那一条上用。
- **静态**：`ui/` 由 Vercel 直接发，`index.html` 里的 CSP / SRI 照旧。
- **密钥**：`GATEWAY_JWT_PRIVATE_KEY`、`GATEWAY_JWT_PUBLIC_KEY`、`GATEWAY_CHANNEL_KEY`
  三个 env；`SATUWORK_GATEWAY_HOME` 退休。
- **Blob**：`GATEWAY_RELEASE_MAX_BYTES` 保留作登记时的校验；上传接口改成回一张直传 URL，
  客户端传完再 `POST` 登记（sha256、size 由 Gateway 从 Blob 元数据核对）。

### 5.2 Neon

- **两条连接串**：迁移和 Cron 用**直连**串（advisory lock 是会话级的）；请求路径用**池化**
  串（PgBouncer 事务模式）。`db.ts` 里 `new Pool({ max: 10 })` 在函数里改成 `max: 2`，
  实例复用下够，实例多时不会把 Neon 的连接数打满。
- **事务里不用会话态**：`SET`、临时表、`pg_advisory_lock` 一律不出现在请求路径。现有代码
  里 `db.tx` 内没有这些；`GATEWAY_PG_SCHEMA` 已经是走连接启动参数
  `options=-c search_path=...`（[db.ts:102](../gateway/src/db.ts:102)），不是每条连接
  `SET`。要核一件事：Neon 的池化端点是否透传 `options`。不透传也无妨，生产本来就在
  `public`，不设 `GATEWAY_PG_SCHEMA`；分 schema 只有 e2e 在用，而 e2e 不走 Neon。
- **冷启动**：Neon 的 scale-to-zero 会让第一条查询多几百毫秒。生产关掉 auto-suspend；
  预览环境开着无所谓。
- **分支**：每个 PR 一个 Neon 分支，迁移在分支上先跑一遍，是免费拿到的回归保护。e2e 的
  按 checkout 路径分 schema（[e2e/isolate.mjs](../e2e/isolate.mjs)）保持不动，本地仍打
  Docker 里的 PG。

## 6. 前置条件（逐台机器确认，不是代码）

1. 二级域名前面谁终结 TLS、有没有 **h2**、SSE **不缓冲**、空闲超时小时级。§7.1 对 Gateway
   的要求原样搬到每台机器上；[deploy/check-sse.mjs](../gateway/deploy/check-sse.mjs)
   对着机器再跑一遍。
2. 机器能出网到 `api.telegram.org`（或 `TELEGRAM_API_BASE` 指的代理）。今天是 Gateway 出网，
   机器在内网无所谓；下沉后每台都要能。
3. 机器时钟。日常任务的「到点」从此由机器的钟判断，[timezone.ts](../manager/src/timezone.ts)
   那套已经在管；再加一条：心跳里带机器时间，Gateway 偏差超过 30 秒就在机器卡上亮灯。

## 7. 上线顺序

每一步独立上线、独立回退，中间任何时刻 Gateway 都还能照旧跑在 Debian 上。

| 步 | 做什么 | 回退 |
| --- | --- | --- |
| 0 | 库换 Neon 直连串。其余不动 | 改回连接串 |
| 1 | 全铺 `directUrl`，桌面走直连 | 清空 `directUrl` |
| 2 | 管家协议 5：worker 单元、CORS、验 JWT 换 `sat_`。对话流和名单流直连；**Gateway 那两条反代随后已删**（连同桌面反代），directUrl + 管家 ≥ 6 成了硬前提 | 已无 Gateway 前缀可切回；回退是回滚 Gateway 版本 |
| 3 | 桌面端独立：内置分片、直连本机、删隧道 | 桌面端回旧版；Gateway 隧道代码晚一个版本再删 |
| 4 | 日常任务改成工人拉取；Gateway 调度器改成只做租约回收 | 环境变量切回 Gateway 自己跑 |
| 5 | 渠道换 webhook 下沉；Gateway 分发器下线 | 同上 |
| 6 | Gateway 密钥进 env、迁移进 build、Router 适配、Blob；先部署到 Vercel 预览域名，双跑一周 | DNS 切回 |
| 7 | DNS 切到 Vercel；Debian 上的 Gateway 停机 | DNS 切回 |

第 2 步和第 4、5 步之间要**先发一版管家**、等 fleet 都升上来再开 Gateway 侧的开关：管家
协议号低于 5 的机器，Gateway 照旧自己跑那台的任务和渠道。这个「按机器协议号分流」的口子
在 [deploy.ts](../gateway/src/deploy.ts) 里已经有三个先例（`MIN_*_PROTOCOL`），照着做。

## 8. 不变量（改完之后仍然要成立的）

- Gateway 除 §2.3 的 `revoke` 外**不主动连接任何机器或桌面端**。
- 机器只凭 `smt_` 读写**本机**的数据；`smt_` 泄露的影响面是一台机器。
- 浏览器的登录 JWT 到了管家只能换 `sat_`，换不到任何控制类接口。
- 计费的三条路（模型、连接器、搜索）**全部**经过 Gateway 的 `/v1` 与代理，桌面端和工人都
  没有上游密钥。
- 任务定义、流水、渠道账本、交接单的真相在 Neon；工人和桌面端进程死掉不丢任何一条记录。
- e2e 仍然在本地 Docker PG 上按 schema 隔离跑，不依赖 Neon。

## 9. 明知的风险

- **发版速度变慢。** roster-stream 当初留在 Gateway 就是为了「十几台席位不用跟着发版」。
  下沉后调度和渠道逻辑每改一次都是一次 fleet 升级，包只能在 Linux arm64 上打
  （[local-release.md](local-release.md)）。接受；换来的是 Gateway 无状态。
- **Telegram webhook 一个 Bot 只能指一台机器。** 账号粘机器保证了这一点，但账号迁机（今天
  不支持）以后如果做，要先改 webhook 再搬人。
- **本地 Bot 的可见性下降**（§4）。产品上要说清楚它是「我自己的 Bot」，不是「公司的 Bot
  跑在我电脑上」。
- **Vercel 上的 `/v1` 长响应计费**按活跃 CPU 算，流式等待上游时 CPU 空闲，成本可控；但
  单次响应上限（300 或 800 秒）以上的模型调用会被掐断。今天没有这么长的单次调用，模型
  上下文继续变大时要回头看。

## 10. 实施后记（2026-09-10）

七步的代码侧全部落地，合进 main 的顺序：#126（本文）→ #127 对话流直连（协议 5）→ #138 名单流直连
（协议 6；原 #128 在 #127 删分支时被自动关闭，同分支重开）→ #129 日常任务的工人接口 → #130 席位工人
（协议 7）→ #131 Telegram webhook → #132 渠道那一轮下沉（协议 8）→ #133 本地 Bot 直连、删隧道 →
#134 Gateway 函数形态 → #135 本地 Bot 自己领日常任务 → #136 界面打进桌面端包 → #137 发布包走 Blob。

做的时候有三处和上面写的不一样，都比原文更紧，记在这儿免得以后照原文去找：

- **§2.3 的换票留在管家里，没进 worker。** 管家本来就是这台机器的反代，验票的钥匙（JWKS）也在它
  手上；worker 从第 4 步的调度才开始存在。`/seats/:id/stream/*` 与 `/roster/stream` 都在管家。
- **§2.2 / §2.4 的工人不持任何凭据。** 原文说工人凭 `smt_` 走接口。做的时候发现 `smt_` 同时是管家的
  root 控制面凭据（`PUT /seats/:id` 就认它），交给非 root 的工人等于白拆。改成：管家开机随机一把
  本机令牌写进 `worker.env`，工人凭它打管家回环地址上的中继口（`/w-local/gateway/worker/*` 由管家带
  `smt_` 转给 Gateway 的 `/worker/*`，只有这个前缀；`/w-local/seats/:id/bot/*` 由管家换成席位票转给
  本机 bot）。工人被攻破的影响面 = 领本机任务 + 跟本机 bot 说话。
- **§3 渠道那一轮只下沉了一半。** 跟席位说话的那段（每 100ms 轮询、最长 20 分钟、草稿节流）在
  工人；跟 Telegram 说话的那段（typing、草稿、审批卡、最终回复）留在 Gateway，工人不碰 Telegram
  的 token，只报「现在该发什么」。Telegram 收信改 webhook 落在 Gateway 上，不在机器上——它是一次
  请求一次响应，在函数里跑得很自然，机器也不必能出网到 Telegram。

§8 的第一条不变量要改一个字：Gateway 保留的**短的、请求响应式**外呼不止 `revoke`——部署
（`PUT /seats/:id`）、审批与交接回调、试跑都还在。不变的是：**没有长连接、没有定时器**。

没做的：Bot 层记忆与私有 Skill 落本地（§4，产品取舍，不影响无状态化）；包 > 100 MB 走「登记
远端包」（函数请求体上限）。真机上还没验：桌面端的 `satu://` 界面与那张桌面 cookie、真 Blob。
