# Satuwork Gateway

Control plane and the only chat UI: companies, accounts, plans, seats, catalogs, JWT, chat proxy, `/v1`.
Default listen port is 3080. Business data lives in **PostgreSQL**; the data dir
(`SATUWORK_GATEWAY_HOME`, default `~/.satuwork-gateway`) only holds local wrapping keys and Bot release tarballs.

控制面 + 聊天 UI：公司、账号、套餐、席位、目录、JWT、按 pair 部署、把 SSE/消息反代到该席位实例。

## 起一个

```bash
docker compose up -d postgres          # 宿主机 5434 → 容器 5432
cd gateway && pnpm dev
```

整套（含 Gateway 容器）：

```bash
docker compose up -d
```

然后开 <http://127.0.0.1:3080>。**一个系统管理员都没有时，首页就是「创建系统管理员」那一屏**，
建完当场就是登录态。`GATEWAY_OWNER_PASSWORD` 只是给无人值守的自动化留的口子，不是启动的前提。

## 环境变量

`GATEWAY_DATABASE_URL` 必填（没有默认值，缺了会直接报错并给出示例）。其余见 `.env.example`：
`GATEWAY_HOST`、`GATEWAY_PORT`、`GATEWAY_PG_SCHEMA`、`GATEWAY_ACCESS_HOST`、`GATEWAY_JWT_TTL_SECONDS`、
`GATEWAY_ISS`、`GATEWAY_MACHINE_TOKEN`、`GATEWAY_PLATFORM_TOKEN`。

Telegram 渠道使用 `getUpdates` 长轮询，不需要公网地址。用户从侧栏的「渠道」页
粘贴 BotFather token 后，Gateway 会验证 token、关闭该 Bot 原有 Webhook、加密保存凭据，并
自动创建一颗名为 `telegram bot` 的用户 Bot。页面同时生成一次性配对码：必须先在 Telegram
私聊里发送该码，之后只有这个 Telegram 用户发出的私聊消息才会进入模型；被拉进群或频道时会自动退出。
Telegram 和 Web 共用该 Bot 的同一条主会话，页面中的每轮问答分别带 `Telegram` 或 `Web` 来源标签。Bot 回复使用
Telegram 原生 `sendRichMessage` 和 `rich_message.markdown`，标题、列表、表格、引用与代码块会由
Telegram 客户端渲染。消息开头支持
`@连接名`（`/mentions` 查看可用名称），`/new` 与 Web 一样在同一会话上重置上下文。
旧版 Bot API 会自动降级为普通文本。

进程**不读 `.env`**，要用得 `node --env-file=.env --import tsx src/index.ts`。

`GATEWAY_PG_RESET=1` 会在启动时把自己那个 schema drop 掉重建，**只对非 public schema 生效**——
给 e2e 用的，生产跑在 public 上碰不到。

## 代码布局

```
src/index.ts        起进程：连库、种 owner、装路由、监听
src/http.ts         很小的路由器 + 静态文件
src/routes.ts       只做组装：把下面九组路由按顺序挂上去
src/routes/         按边界分的九组路由，每组收一个 RouteCtx { db, keys, llm }
src/lib/            路由用的帮手：校验、序列化、鉴权守卫、四个反代、目录定义
src/db.ts           Db 类（连接、事务、查询）；类型和行解析原样再导出
src/db/types.ts     库里那些行长什么样，以及跟着走的常量
src/db/rows.ts      裸行 → 类型
src/db/migrate.ts   编号迁移的执行器（advisory lock、一条一个事务、校验和）
src/db/migrations/  一条迁移一个文件，index.ts 是那张有序表
src/deploy.ts       席位：槽位、端口、下发给管家、拆席位
src/v1.ts           /v1/* 模型代理
src/llm.ts          pi-ai 目录与上游调用
```

**注册顺序有意义**：路由器按段精确匹配、先注册的先中，所以段数相同、更具体的路径要排在
带参数的前面（`/orgs/:id/bots/options` 必须在 `/orgs/:id/bots/:botId` 之前）。那类相邻关系
都在各自的模块里，跨模块之间段数不同、互不相抢。

## 数据库迁移

**起进程时自动跑，跑完才对外服务。** 一条迁移一个文件，编号升序，只跑一次，
跑过的记在 `schema_migrations` 里。

加一条：

```bash
# 1. 新建 gateway/src/db/migrations/0002-<短名>.ts，导出一个 SQL
# 2. 在 gateway/src/db/migrations/index.ts 的数组末尾加一行
# 3. 起一次进程
```

日志会说这一轮跑了什么：

```
satuwork-gateway: 已应用 1 条迁移：0002-seat-labels
satuwork-gateway: 数据库已是最新（0002-seat-labels）
```

三条规矩：

- **已经发出去的迁移不能改。** 校验和对不上时进程直接不起来并说清楚是哪一条。
  想撤销，写新的一条把它改回去。**没有 down 脚本**：要回到升级前的状态，靠升级前
  的库快照（`pg_dump`），不靠反向迁移——所以升级前先备份。
- **0001 是冻结的基线。** 它就是编号机制之前那段幂等脚本——存量库第一次带着新版本
  起来时跑它等于空转，然后记一行账，**不需要任何人工基线标定**。
- **一条迁移一件事。** 每条和它那行账在同一个事务里落，失败就整条回滚，
  不存在「跑了一半」。

库里出现代码里没有的编号（把代码回滚到了比库更旧的版本）同样直接停机——
让旧代码去读一个更新的库，比起不来危险得多。

## 检查

```bash
pnpm typecheck        # tsc，无输出即通过
node ../e2e/run.mjs   # 全量 e2e（要先起 postgres）
E2E_ONLY=machine-deploy node ../e2e/run.mjs   # 只跑一套
```

对话页右栏那块桌面预览「没人看就断开」的那套逻辑，e2e 覆盖不到（要真浏览器加一个
ready 的席位）。`deploy/desk-suspend-check.mjs` 起一套自带假管家和 stub 席位的环境，
打开浏览器登进去就能验：

```bash
node deploy/desk-suspend-check.mjs
```

Passwords are scrypt. Credential secrets never appear in list/get or JWT.
Deploy is per (account, botId) pair, not per account. Seats still count accounts.

## Bot 发布包

Gateway **不构建 Bot**，只存和发。生产上由 CI 打包并传上来：

```bash
GATEWAY_PLATFORM_TOKEN=… node bot/pack.mjs --upload https://gw.example.com
```

`bot/pack.mjs` 走 `pnpm deploy` 把依赖实体化进包里（仓库里的 `bot/node_modules` 全是
指向 workspace 的软链，直接 tar 出去到席位机器上就是断链），然后 PUT 上来。
手工传现成的包也行：

```bash
curl -sf -X PUT "$GATEWAY_URL/platform/bot-releases/1.2.3+$(git rev-parse --short HEAD)" \
  -H "Authorization: Bearer $GATEWAY_PLATFORM_TOKEN" \
  -H "X-Bot-Sha256: $(shasum -a 256 bot.tgz | cut -d' ' -f1)" \
  --data-binary @bot.tgz
```

校验 sha256、是 gzip 的 tar、里面有 `bin/satuwork.mjs`；不过关就删文件不入库。
上限 `GATEWAY_RELEASE_MAX_BYTES`（默认 256 MiB）。

机器管家的包走同一套：`PUT /platform/manager-releases/:version`，入口文件换成
`bin/satuwork-manager.mjs`。

**只有上传这一条路。** 原来还有一条「从本机 bot 源码现打」，已经拆掉：它只有本地
开发的 Gateway 能走，而且打出来的包带的是**那台机器**的 esbuild 原生二进制（tsx 依赖
它），传到席位机器上加载不了，进程起不来。包必须在和席位机器同架构的 Linux 上打，
`pack.mjs` 会拦住不合规的包。

包只在 Gateway 本机磁盘上，机器管家按版本来拉，所以 **Gateway 目前是单实例**。

## LLM proxy

pi-ai 只活在这里。Bot 进程用席位 API Key（`sk_sw_…`）调；登录 JWT 也行；`sat_…` 不行。
上游密钥不出 Gateway：

- GET /v1/models
- POST /v1/chat/completions
- POST /v1/responses
- POST /v1/messages

`/runtime/catalog` 会带出 MCP 的明文 token 与 env，**只认席位 `sat_`**——登录 JWT 会被 401 挡掉。
