# 把 Gateway 部署到 Vercel + Neon

[adr-gateway-vercel-neon.md](adr-gateway-vercel-neon.md) 第 7 节第 6 步的操作手册；对着打勾的清单在
[vercel-golive-checklist.md](vercel-golive-checklist.md)。**前提是前面几步已经
铺到位**：每台席位机器的管家 ≥ 8 号协议（工人接日常任务和渠道那一轮）、配了 `directUrl`
（对话流、名单流、桌面直连），桌面端已升到直连本机的版本（没有隧道）。少一条，那一块功能在
Vercel 上就是「实例还没上线」——不是坏，是没人接。

## 形态

- `gateway/src/serverless.ts`：只有路由，没有监听、定时器、迁移。导出一个 `http.Server`，Vercel
  的 Node 函数直接接它。
- `gateway/scripts/build-vercel.mjs`：esbuild 把它打成一个文件 `api/gateway.mjs`（源码到处是
  `import './x.ts'`，平台的 TS 编译不认，esbuild 认）。界面静态文件不进包，函数里按
  `GATEWAY_UI_DIR` 从磁盘读，`vercel.json` 的 `includeFiles` 带上 `gateway/ui/**`。
- `vercel.json`：所有路径 rewrite 到那一个函数；`maxDuration` 300；Cron 每分钟打 `/cron/tick`
  （跑的是 Debian 上调度器每 30 秒跑的那份 `maintenanceTick`）。**Cron 每分钟一次要 Pro**，
  Hobby 只能每天一次——那样交接催办、审计派发、租约回收都成了一天一拍，不能用。
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
- **桌面反代退路**（没配 `directUrl` 的机器）：WebSocket 在函数里能开，但被钉在一个实例上、
  受 300 秒上限。全铺 `directUrl` 就用不到它。
- **老协议机器上的日常任务与渠道**：Gateway 不再自己跑那一轮（那要等席位 20 分钟），< 8 号的
  机器上这两样不动。先升管家。

## 双跑与切换

`vercel.json` 直接在仓库根目录，Vercel 项目的 Root Directory 留空。先接预览域名双跑一周
（Debian 那台照常，两边打同一个 Neon），管家的心跳地址由 Gateway 每次调用顺带教
（`managerHeaders`），切 DNS 之后一轮心跳内全部机器就跟过来。回退就是 DNS 切回。
