# 把 Gateway 部署到 Vercel + Neon

[adr-gateway-vercel-neon.md](adr-gateway-vercel-neon.md) 第 7 节第 6 步的操作手册；对着打勾的清单在
[vercel-golive-checklist.md](vercel-golive-checklist.md)。**前提是前面几步已经
铺到位**：每台席位机器的管家 ≥ 8 号协议（工人接日常任务和渠道那一轮）、配了 `directUrl`
（对话流、名单流、桌面直连），桌面端已升到直连本机的版本（没有隧道）。少一条，那一块功能在
Vercel 上就是「实例还没上线」——不是坏，是没人接。

## 形态

- `gateway/src/serverless.ts`：只有路由，没有监听、定时器、迁移。默认导出一个 `(req, res)`
  监听器——Vercel 的 Node 启动器按导出形态分派，函数导出是它认得最实的一种（导出一个没
  listen 过的 `http.Server` 它抓不到：它靠猴补 `Server.prototype.listen` 捕获实例）。本地要
  监听用 `createGatewayServer()`。
- `gateway/scripts/build-vercel.mjs`：esbuild 打包（源码到处是 `import './x.ts'`，平台的 TS
  编译不认，esbuild 认），产出的是 **Build Output API** 目录 `.vercel/output/`：

  ```
  .vercel/output/config.json                                路由表：所有路径打到那一个函数
  .vercel/output/functions/gateway.func/.vc-config.json     nodejs22.x、maxDuration 300、开流式
  .vercel/output/functions/gateway.func/src/index.mjs       打好的包
  .vercel/output/functions/gateway.func/ui/**               界面静态文件（函数里从磁盘读）
  ```

  界面按 `src/` 挨着 `ui/` 摆，跟仓库里 `gateway/` 同形，`http.ts` 里
  `new URL('../ui', import.meta.url)` 那个默认值就还成立，线上不必配 `GATEWAY_UI_DIR`。
- **别改回 `vercel.json` 的 `functions` + `api/gateway.mjs`**：那条路走不通。Vercel 先扫仓库
  里已有的文件、拿这份清单跑 detectBuilders 校验 `functions` 的 glob，**然后**才轮到
  installCommand / buildCommand；构建期才生成的文件那时还不存在，只会得到「The pattern
  "api/gateway.mjs" ... doesn't match any Serverless Functions inside the `api` directory」。
  顺带，那套要配的 `outputDirectory: "."` 会让 static-build 把整个仓库当静态资源传上去
  （静态文件的匹配在 rewrites 之前，`/gateway/src/db.ts` 这类路径就把源码发出去了）。产出
  `.vercel/output` 之后 static-build 直接透传这个目录，不再看 `outputDirectory`。
- `vercel.json` 只剩三件事：`installCommand`、`buildCommand`、`crons`（CLI 会把 crons 并进最终
  的 `config.json`）。Cron 每分钟打 `/cron/tick`（跑的是 Debian 上调度器每 30 秒跑的那份
  `maintenanceTick`）。**Cron 每分钟一次要 Pro**，Hobby 只能每天一次——那样交接催办、审计派发、
  租约回收都成了一天一拍，不能用。
- 迁移在 build 里跑（`buildCommand` 先 `migrate` 再 `build:vercel`），用直连串。

## 环境变量

| 变量 | 值 | 说明 |
| --- | --- | --- |
| `GATEWAY_DATABASE_URL` | Neon **池化**串（`-pooler`） | 请求路径用。事务里没有会话态，PgBouncer 事务模式没问题 |
| `GATEWAY_MIGRATE_DATABASE_URL` | Neon **直连**串 | 迁移用。迁移锁是会话级 advisory lock，过池化串会漂 |
| `GATEWAY_PG_POOL_MAX` | `2` | 每实例几条连接。函数实例多，别按 Debian 的 10 |
| `GATEWAY_JWT_PRIVATE_KEY` / `GATEWAY_JWT_PUBLIC_KEY` | PEM | 签票的钥匙。**必须来自环境**：函数没有跨实例的磁盘，落盘生成的钥匙每个实例都不一样 |
| `GATEWAY_CHANNEL_KEY` | 32 字节 base64 | 渠道 token 的加密钥匙。换了就解不开已有绑定 |
| `CRON_SECRET` | 随机串 | Vercel 触发 Cron 时带在 Authorization 上；没配 `/cron/tick` 整条关着 |
| `GATEWAY_PUBLIC_URL` | `https://…` | 对外地址。**必须 https**：Telegram 收信靠它自动切到 webhook（channels/inbound.ts），管家学地址也靠它 |
| `GATEWAY_TRUST_FORWARDED` | `1` | 信平台反代写的 `x-forwarded-for` 最右一跳（配对时记「机器在哪」用） |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob 库的读写 token | 发布包不落盘、边收边传到 Blob（私有），下发时带 token 取。Debian 上也可以配，两边的包就在同一个地方。见 gateway/src/releases.ts |
| `GATEWAY_ACCESS_HOST`、`GATEWAY_PLATFORM_TOKEN`、各家模型 key | 同 Debian | 见 docker-compose.yml |

生成钥匙：

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out jwt-private.pem
openssl pkey -in jwt-private.pem -pubout -out jwt-public.pem
openssl rand -base64 32   # GATEWAY_CHANNEL_KEY
```

从 Debian 迁过来时**把磁盘上那两把 PEM 和 channel-secret.key 原样搬进环境变量**（PEM 的换行写成
字面 `\n` 也认），否则已发出去的登录票全失效、渠道 token 全解不开。

## 还没搬过去的

- **发布包超过 100 MB**：函数的请求体上限。Blob 那条路是边收边传，但字节得先进函数；更大的包
  用「登记远端包」（带 `url` 的 POST，包放能直接下载的地方）。没配 `BLOB_READ_WRITE_TOKEN`
  时直接上传回 501。
- **Gateway 上已经没有长连接**：桌面反代（`desktop.ts`）、对话 SSE 反代
  （`/runtime/sessions/:id/events`）、名单流扇入（`/runtime/roster/stream`）三条都删了，
  没有退路。桌面、对话流、名单流要能用，每台机器必须配 `directUrl` 且管家 ≥ 6 号。
  之后又删了最后两条会挂着不放的：日志跟随（`/runtime/logs?follow=1` 和平台侧两条 `.../logs?follow=1`，
  现在回 410，浏览器改从 `.../logs/direct` 拿 `{ url, ticket }` 直连管家）和附件上传
  （`POST /runtime/sessions/:id/files`，浏览器改打 `runtime.uploadUrl`），这两样要管家 ≥ 9 号。
  **Vercel 上剩下唯一一条流式响应是 `/v1`**（模型回答的 SSE），而且**只剩本地 Bot 在用它**：
  席位上的模型调用已经改成管家中继（管家问 Gateway 要授权、自己打上游、完了回来结算，见
  gateway-runtime.md「模型调用」），Gateway 不再在那条流的路径上。`/v1` 是请求级的，模型答完
  就结束，不是小时级；函数的 `maxDuration` 建议给到 800 秒，让桌面端一轮长回答（连同工具调用）
  不被半路砍断。这里不动，上线前按需要改 `build-vercel.mjs` 里写 `.vc-config.json` 那段。
- **老协议机器上的日常任务与渠道**：Gateway 不再自己跑那一轮（那要等席位 20 分钟），< 8 号的
  机器上这两样不动。先升管家。

## 双跑与切换

`vercel.json` 直接在仓库根目录，Vercel 项目的 Root Directory 留空。先接预览域名双跑一周
（Debian 那台照常，两边打同一个 Neon），管家的心跳地址由 Gateway 每次调用顺带教
（`managerHeaders`），切 DNS 之后一轮心跳内全部机器就跟过来。回退就是 DNS 切回。
