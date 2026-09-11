# Gateway 切到 Vercel + Neon：上线清单

[vercel-deploy.md](vercel-deploy.md) 是手册，这一页是**对着打勾的**。顺序就是做的顺序：前一段没勾完，
后一段做了也白做——那一块功能在 Vercel 上会是「实例还没上线」，不是坏，是没人接。每一条后面写着
**怎么验**，验不了的不算勾。

## 一、席位机器（逐台）

- [ ] **管家 ≥ 8 号协议。** 平台侧「机器」页每台的协议号；心跳里自报。< 7 的机器日常任务不跑
      （流水上每次到点记一条「管家太旧」的 error，试跑直接 409）、< 8 的机器渠道那一轮没人跑。
- [ ] **工人单元真的在跑：`systemctl status satuwork-worker`。** 协议号是包里写死的，装脚本没重跑、
      单元没起来的机器也报 8——Gateway 会把任务交给一个不存在的工人，表现是流水上「机器没回报」
      加补跑。老机器重跑一遍安装脚本（`useradd satuwork-worker`、单元、`worker.env` 的属组一起补）。
- [ ] **`directUrl` 配了，而且三个前提齐：公网可达、https、和 Gateway 同一个可注册域**（SameSite 判的
      是 site；桌面端界面在自己的源上时管家那张 cookie 已改成 `SameSite=None; Secure`，仍要 https）。
      机器卡上 `directPending` 为假才算真切过去了。
- [ ] **那台机器前面终结 TLS 的反代：h2、SSE 不缓冲、空闲超时小时级。** nginx `proxy_buffering off` +
      `gzip off`，Caddy `flush_interval -1`。拿 `gateway/deploy/check-sse.mjs` 对着机器跑一遍，两个
      server 都跑。
- [ ] **机器能出网到 Telegram**（`api.telegram.org` 或 `TELEGRAM_API_BASE` 指的代理）——只有绑了渠道
      的账号所在机器需要。今天是 Gateway 出网，下沉后每台都要能。
- [ ] **机器时钟准。** 日常任务的「到点」从此由机器判；心跳里带机器时间，偏差大的机器卡上会亮灯。

## 二、桌面端

- [ ] 所有人升到**直连本机、界面内置**的版本（`satu://` 界面，没有隧道）。老版本装的是 Gateway 的
      页面、走隧道，Gateway 上隧道已经删了，本地 Bot 会一直「本机未运行」。
- [ ] **真机各开一次**（一台 Mac、一台 Windows）：`satu://` 界面起得来、登录、开一颗远程 Bot 对话、
      看一眼桌面预览（那张跨站 cookie）、开一颗本地 Bot 并跑一条日常任务。这几条在仓库里只有
      `cargo check`，没有 UI 层的自动测试。

## 三、Neon

- [ ] 生产库建好，**关掉 auto-suspend**（冷启动多几百毫秒）。
- [ ] 拿到**两条串**：池化（`-pooler`）给 `GATEWAY_DATABASE_URL`，直连给 `GATEWAY_MIGRATE_DATABASE_URL`。
      迁移锁是会话级 advisory lock，过池化串会漂。
- [ ] 数据从 Debian 那台迁过来（`pg_dump` / `pg_restore`），并在双跑期间**两边打同一个库**。
- [ ] 不设 `GATEWAY_PG_SCHEMA`（生产在 `public`）。设了要先核 Neon 池化端点是否透传
      `options=-c search_path`——这一条没在真 Neon 上验过。

## 四、Vercel 项目

- [ ] **Pro 计划。** Cron 每分钟一次要 Pro；Hobby 每天一次，催办、审计派发、租约回收都成了一天一拍。
- [ ] Root Directory 留空（`vercel.json` 在仓库根）。Build 用 `vercel.json` 里那条：先 `migrate` 再
      `build:vercel`。
- [ ] 环境变量按 [vercel-deploy.md](vercel-deploy.md) 那张表配齐。**钥匙从 Debian 原样搬**：
      `~/.satuwork-gateway/keys/` 下两把 PEM → `GATEWAY_JWT_PRIVATE_KEY` / `GATEWAY_JWT_PUBLIC_KEY`，
      `channel-secret.key` 的 base64 → `GATEWAY_CHANNEL_KEY`。换新钥匙 = 所有登录票失效、所有渠道
      token 解不开。
- [ ] `GATEWAY_PUBLIC_URL` 是 **https** 的正式域名（不是 `*.vercel.app` 预览域名）：Telegram 自动切
      webhook、管家学地址都靠它。
- [ ] `CRON_SECRET` 配了；部署后看 Cron 的执行记录有 200。
- [ ] `GATEWAY_TRUST_FORWARDED=1`，`GATEWAY_PG_POOL_MAX=2`。
- [ ] Blob 库建好，`BLOB_READ_WRITE_TOKEN` 配了；**传一个包、让一台机器拉一次**——假 Blob 上验过，
      真 Blob 没有。> 100 MB 的包走「登记远端包」。
- [ ] Vercel 上的 `x-forwarded-for`、CORS（桌面源）、CSP 都不用另配，代码里有。

## 五、双跑与切换

- [ ] 预览域名先跑一周，Debian 那台照常，两边同一个 Neon。看：登录、对话、名单、Telegram 一来一回、
      一条到点的日常任务、一次转人工催办。
- [ ] 看 Gateway 日志里每条 Telegram 绑定都出现过一次「已切到 webhook，不再长轮询」。
- [ ] 切 DNS。管家的心跳地址由 Gateway 每次调用顺带教（`managerHeaders`），一轮心跳内全部机器跟过来；
      机器页上没有「失联」就是跟上了。
- [ ] Debian 那台**先别停**，留一周当回退：回退就是 DNS 切回。
- [ ] 一周后停 Debian 上的 Gateway；`~/.satuwork-gateway/releases/` 里的包已经在 Blob 上有一份才能删。

## 明知的空白

- 桌面端的 `satu://` 界面、桌面 cookie、真 Blob——三样只在假的对面验过。
- 发布包 > 100 MB 走不了直传。
- Bot 层记忆与私有 Skill 仍在 Gateway（产品取舍，不影响上线）。
