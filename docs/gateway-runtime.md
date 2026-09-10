# Satuwork：Gateway 与 Bot 框架

把现有仓库收成 **Bot 框架**（运行面），另起 **Gateway**（控制面 + 唯一聊天 UI）。本文是执行规范，不是意向。和本文冲突的旧结论以本文为准。

相关但不被本文改写的文档：

- [dsh-capability-map.md](./dsh-capability-map.md) 里「租户 / 席位 / 账单放在引擎之外」「将来另起 gateway」两条仍然成立，细节以本文为准
- [session-event-field-map.md](./session-event-field-map.md) 的事件信封继续用；会话根记录必须带上 `botId`（v2 的 `agentId` 启动时迁过来）

---

## 1. 目标与非目标

**做成：**

1. Gateway 是唯一聊天 UI：侧栏是助理名册，主区是那个助理的长对话（产品形态，不是 25 屏后台）。Bot 无头，不发 SPA
2. 一家公司一台 Debian 运行机器。部署按 **(account, botId) pair**，不是按账号。一个 Bot 进程恰好一个 Bot，进程内没有多名册
3. 模型 / Skill / MCP 定义分 **全局** 和 **公司** 两层，存在 Gateway。Bot 多一层：公司那一层是**一份带版本号的模版**，员工在它上面建自己的 Bot。部署实例钉目录里的那一颗（`SATUWORK_BOT_ID`）；未设该环境变量的本地进程才种 `default`
4. 浏览器只打 Gateway。Gateway 把该 pair 的 SSE / 发消息反代到席位实例。全文 JSONL 留在机器。Gateway 只存**索引**
5. Gateway 做公司级审计（登录、改配置、改模版、谁建了哪个 Bot）

**先不做：**

- 知识库、业务数据库的实现和部署
- 多公司挤一台机器、跨机器调度、会话迁到 Gateway
- 把 Agent 编译成 per-session 的 `cordis.yml` preset
- 重写 Cordis / 会话 JSONL / SQLite / pi-agent-core
- 电脑（box）、子代理、群、项目
- 一个进程里跑多个 Bot；聊天绕过 Gateway 直连实例
- 把某个人的 Bot 分享给同事（自建的只有本人看得见；要全公司一致，改模版）

---

## 2. 总拓扑

```
用户浏览器
  ├─ 管理（注册、公司、套餐、目录、审计索引）──► Gateway
  └─ 聊天 UI（名册 / SSE / 发消息）─────────────► Gateway
                                                    │
                                                    ├─ /v1/*（API Key 或登录 JWT；sat_ 不行）
                                                    ├─ 反代该 pair 的 SSE / messages
                                                    └─ 按 sessionId 拉全文
                                                    │
                                                    ▼
                                          公司运行机器（Debian，v1 一台）
                                          ├─ 机器管家 :8443（唯一入站口，root）
                                          ├─ Linux 账号 A（一个员工一个）
                                          │   ├─ ~/work                共享工作区
                                          │   ├─ 席位 (A, botX)  seatId / slim-desktop@ / satuwork-bot@
                                          │   └─ 席位 (A, botY)  同一个 uid，另一块屏
                                          └─ Linux 账号 B
                                              └─ 席位 (B, botX)
                                                │
                                                ├─ 拉目录 / ready / 报索引 / guard / handoff ──► Gateway
                                                └─ 模型 /v1/*（sk_sw_）──────────────► Gateway（pi-ai / 透传）
```

Gateway **不跑** 一轮对话，不当聊天的工作副本。浏览器聊天进 Gateway，由 Gateway 反代到该 pair 的实例。**模型调用**由 Bot 进程打 Gateway `/v1/*`。全文留在机器。

---

## 3. 实体

| 实体 | 活在哪 | 含义 |
|---|---|---|
| 平台 | Gateway | 全局目录的所有者 |
| 公司 | Gateway | 租户。有套餐、席位、一台运行机器 |
| 套餐 | Gateway | 先管席位数和模型额度 |
| 席位 | Gateway | 可开通的**账号**名额。多开 Bot **不**多占席位 |
| 账号 | Gateway | 一个人。`owner` 是平台账号，不占席位、不属于公司。`admin` / `member` 属于一家公司，占一席 |
| 运行机器 | Gateway 登记，配对接入 | 一家公司**可以有多台**。每台有一个「最多几个激活账号」的容量 |
| 访问地址 | Gateway 分配 | 公司记录里的 `accessUrl`（派机器时写入）。**聊天 Host 是 Gateway**，不是这个地址 |
| pair 实例 | 运行机器 | 一个 (account, botId) 一个 Bot 进程 + 一份 `$SATUWORK_HOME` + 一套瘦桌面。无头。同一账号的多个 pair **共用一个 Linux 用户**，因而共用 `~/work` |
| Bot | 定义在 Gateway（全局 / 员工自建） | 侧栏里的一个人。有自己的长会话。自建的长在**公司 Bot 模版**上，只有本人看得见。部署实例只钉 `SATUWORK_BOT_ID` 那一颗 |
| 会话 | 只在实例上 | JSONL。根事件带 `botId` |
| 会话索引 | Gateway | 能找到会话的指针，没有正文 |
| 审计事件与对话审计派生物 | Gateway | 操作记录，以及 Bot 运行时脱敏后生成的任务总结、时间线、问答、结果和评分；不是聊天全文 |

席位按**账号**计，不按 Bot 实例。`owner` 不占席位。用全局 Bot、或自己建几个 Bot 再各部署一个 pair，**都不多占席位**。3 席 × N 个 Bot = 最多 3N 个进程。

### 3.0 多机调度

一家公司可以配对多台机器，每台设一个**激活账号上限**（`machines.maxAccounts`，激活 =
当前有已部署席位）。派发规则两条：

1. **账号粘住机器。** 一个员工的所有 bot 必须落在同一台机器上——它们共用一个 uid 和
   `~/work`，拆到两台上「共享文件」就不成立了。所以调度单位是账号，不是席位；账号
   名下再加 bot 不多占容量。已经在某台机器上的账号**不会被驱逐**，那台就算被调小到
   超容量也一样：把人从机器上赶走会丢掉他的 `~/work`。
2. **填满一台再用下一台。** 新账号落在「没满的机器里已用最多」的那台（并列按登记先
   后）。不是最闲优先——摊平会让每台都半满，反而没法把空机器腾出来下线或转给别的公司。

所有机器都满时部署返回 409，并报出总容量。

### 3.1 机器时区

每台机器可以指定时区（`machines.timezone`，IANA 名，如 `Asia/Shanghai`）。部署机器一律
是 Debian，改的是 `timedatectl set-timezone`——但**改它的是机器上的管家，不是 Gateway**：
Gateway 没有任何能登录这台机器的凭据，只能在心跳响应里把期望时区带下去，机器自己去收敛。
和钉管家版本同一条路。

所以库里是两列：`timezone` 是**期望值**（人在公司详情的「运行机器」里填），
`currentTimezone` 是管家心跳自报的**实际值**。界面比这两个值来判断「指令下了」还是
「已经改上了」——只存一列的话，改失败和改成功在界面上长得一模一样。

留空 = 不管这台机器的时区，**不是**改成 UTC。

已经在跑的席位不会被重启：桌面和 bot 是在旧时区下起来的，libc 把时区缓存在进程里。
要让某个席位跟上，重新部署它。

### 3.2 机器负载与日志占用

管家每 30 秒采一次样，**搭心跳带上来**（不另开一条上行：机器本来就在敲门，多一条只是
多一个会失败、会重试、会被防火墙拦住的东西）：

| 项 | 内容 |
| --- | --- |
| CPU | 核数、**两次采样之间**的占用、`load1` |
| 内存 | 总量、已用（Linux 上按 `MemAvailable` 算，不是 `MemFree`）、交换区 |
| 磁盘 | 每个真块设备一行（按设备去重，`/` 和 `/home` 同盘只算一次），口径同 `df` |
| 出网 | 累计字节 + **速率**，回环和 docker/veth 这些虚拟网卡不算 |
| 日志 | journal 有多大、`/var/log` 有多大、当前上限、上次清理的结果 |

Gateway 侧存**最近一份**（`machines.telemetry`，jsonb），不建流水表——这一格答的是「这台
机器现在怎么样」，按 30 秒一行存，一台机器一个月就是八万多行，换来一条谁也不会去查的
曲线。要趋势那是监控系统的活儿。

`telemetryAt` 记的是 **Gateway 收到的时刻**，不是机器自报的采样时刻：机器的钟可能是歪
的，而界面上那句「3 分钟前」必须准（同 `heartbeatAge`）。

上报的是**网络数据**，进库前整份按形状收（`gateway/src/lib/telemetry.ts`）：数字必须有限
非负、百分比夹到 0–1、数组和字符串有上限并去掉控制字符。一台报疯了的机器不该把这一页
搞坏。心跳里**两份都没有**（老管家）时整格不动，**只报了一半时另一半沿用上一轮**——管家
重启之后负载立刻就有，而日志占用要异步走一遍目录树才出得来，中间那几百毫秒里打的心跳
只带得动一半；照直存下去，机器每重启一次界面上的日志占用就空一次。

CPU 占用和出网速率允许是 `null`（第一次采样只存基准、计数器回绕），界面上写「取样中」
——**不能编一个 0**：失联机器的 0% 和空闲机器的 0% 看着一样，结论正相反。

### 3.3 负载归档（日视图）

界面上「机器负载」那块有两档：**实时**是上面那份自报快照，**日**画的是归档。

归档按**分钟**存（`machine_metric_minutes`，迁移 0012）：心跳 30 秒一轮，所以一格通常并
两笔。粒度定在分钟是**为了看得见尖峰**——按小时归的话，CPU 冲顶五分钟在均值里只剩 8%，
而人来看这一页找的恰恰是那五分钟。

代价是一台机器一天 1440 行，所以**只留 30 天**（`METRIC_RETENTION_MS`）。清理挂在**心跳**
上——每台机器整点那一分钟扫一次，而不是等人打开这一页：写入是每 30 秒自动的，清理要是得
等人来点，那句「只留 30 天」在没人看图的部署上就是空话。归档也跟着机器走，机器被真正删掉
（收到管家回执，或者墓碑到期被清扫）时一并带走。再往前的回溯该去监控系统。

每格存的是 `sum + samples` 和单独一列 `max`，不是平均值：

- **累加得是纯 `+`**。存平均值的话每轮心跳都要「读出来、算新平均、写回去」，两轮撞在
  一起（机器重连、两个 Gateway 进程）就会丢一笔。平均值在读的时候除出来。
- **峰值推不出来**。一分钟里也可能一笔 5% 一笔 95%。
- **出网存的是增量**，不是计数器快照：拿相邻两轮心跳的差算（倒退当重启，那笔不计；上一
  份太旧也不计，否则失联一天再回来会把一整天的流量堆进一格）。这样它可以直接相加。

**格子按 UTC 整分切，「今天」的边界由界面按浏览器时区圈**（`from`/`to` 传上来）。存的时候
就折成某个时区的话，换个时区看就整体错位，而那种错最难被认出来是时区问题。

界面画的时候把分钟并成 10 分钟一格（一天 144 格）——1440 根柱子一根不到半个像素。并的
时候峰值取 `max` 而不是均值的均值，那一分钟的尖峰仍然留得住。**没有数据的格子留空，不
补 0**：一台没在报的机器和一台闲着的机器，在这张图上必须长得不一样。

### 3.4 日志清理

席位机器上的日志只有一个去处：**journald**。bot、桌面、管家三个 systemd 单元都不写日志
文件，`/seats/:id/logs` 和 `/logs` 读的也是 journal。所以「日志把盘吃满了」等价于「journal
太大了」，清理也只有一个动作：`journalctl --rotate` 之后 `--vacuum-size`。

（先 rotate 再 vacuum：vacuum 只删得掉已归档的文件，正在写的那个——通常也是最大的那个
——不归档就一直留着，于是「清理成功、一个字节没少」。）

上限走和时区同一条路：`machines.logCapMb` 是**期望值**，心跳响应带下去，超了由管家自己
清（每 30 分钟查一次，两次清理之间至少隔 10 分钟）。机器上的优先级是
`SATUWORK_LOG_CAP_MB`（本地钉子）> Gateway 下发 > 默认 1024 MB。

| `logCapMb` | 含义 |
| --- | --- |
| 空（null） | 没人指定过，跟管家默认的 1024 MB 走 |
| `0` | 明确**不要**管家动这台机器的 journal |
| 正整数 | 超过这个数就清，清到它的六成（留出余量，否则每半小时清一次、每次只腾几兆） |

空和 0 **不是一回事**：把「没指定」当成 0，等于在谁也没按过的机器上把清理静默关掉，而盘
写满的表现不是一句报错，是 bot 起不来、桌面黑屏，**那时连日志都写不进去**，事后连查都
没得查。

`/var/log` 里别的文件归 logrotate 管，管家**只报大小不动手**——伸手进去删是在和系统自己
的轮转策略打架。最大的几个非 journal 文件跟着上报，大得离谱时人看得见。

手动清理走 `POST /platform/machines/:id/logs/vacuum`，**留审计**：这一下会永久删掉最老的
那截 journal，而那截日志正是事后复盘的材料。

这条反代**不能用默认的 15 秒超时**（`MANAGER_VACUUM_TIMEOUT_MS` = 240 秒）：那一头做的是
真活儿，管家自己给 rotate 和 vacuum 的预算就是 60 + 120 秒。按 15 秒掐断的话，一台 journal
攒到几个 G 的机器上会回一句「实例还没上线」，而清理正干得好好的——人看着报错就再点一次。
管家那边另有一道单飞闸，同一时刻只跑一轮。

### 3.5 通联状态

每台机器算一个 `link`（`publicMachine` 带出去，界面上是一盏灯）。**判据只有一个：最近
一次心跳有多久了**，阈值按管家的心跳周期（`MANAGER_HEARTBEAT_MS`，30 秒）取倍数：

| link | 条件 | 含义 |
| --- | --- | --- |
| `unpaired` | 没 `pairedAt` 或没 `host` | 还没装管家 |
| `online` | ≤ 3 轮（90 秒） | 通 |
| `stale` | ≤ 20 轮（10 分钟） | 该看一眼，但还不到「没了」 |
| `offline` | 更久，或配对过但从没心跳 | 失联 |

两个刻意的取舍：

- **不看 `lastError`。** 能报错说明线是通的。把两件事混进一盏灯，「机器失联」和「机器
  在线但升级失败」就长成一个样子，而这两种的处置完全不同。
- **中间那档 `stale` 不能省。** 换版重启本身就会断几十秒（`systemd-run --on-active=2s`
  加进程起来再跑完一轮心跳），一超时就报失联会让每次自升级都闪一次红灯。

`MANAGER_HEARTBEAT_MS` 和 `manager/src/index.ts` 里的 `HEARTBEAT_MS` 是同一个数，改一边
要改另一边——分叉的话灯会在机器好好的时候变黄。

机器还带一个 `no`：这家公司里的第几台，按登记先后。**给人指代用的短号**，中间删掉一台
后面的会往前挪；要唯一地指一台用 `machine.id`。

**槽位按机器唯一，不是按公司**（`unique(machineId, slot)`）。端口是从槽位算出来的
（`3200+N` 等），两台机器上各自的 slot 0 互不冲突；按公司唯一会白白吃掉第二台的端口
段，还会在满 N 席之后拒绝部署。

配对时**同一个地址算同一台**：重跑装机脚本是修复手段，不该凭空多出一台机器；地址不同
才是新增。重配会换一把新票，旧管家立刻失效。

### 3.1 部署与桌面

部署单位是 **(accountId, botId)**（一个「席位」），但 **Linux 账号按员工分**：同一员工名下的多个 bot 共用一个 uid，因而天然共享文件。

- `linuxUser` = `'sw-' + sha256(accountId).hex.slice(0, 12)`——**只由 accountId 派生**
- `seatId` = `{linuxUser}-{sha256(botId).hex.slice(0, 12)}`——systemd 实例名与席位私有目录名
- 槽 N（公司内从 0 起）：`DISPLAY=10+N`，RFB=`5910+N`，noVNC HTTP=`6081+N`，CDP=`9222+N`（`127.0.0.1`），Bot HTTP=`3200+N`
- 每个席位：一块屏（Xvfb `1280x800x24` + x11vnc `localhost`+密码 + noVNC 内网）、一个 Bot HTTP、一份私有目录
- systemd：`slim-desktop@{seatId}`、`satuwork-bot@{seatId}`。**实例名不再是用户名**——一个员工有多个席位，用户名不唯一了。`User=` 由部署时写的 drop-in 提供：`/etc/systemd/system/{unit}@{seatId}.service.d/seat.conf`
- 机器上常驻 **机器管家**（`satuwork-manager`，root systemd 服务），Gateway 通过它下发部署；**Gateway 不持有任何能登录这台机器的凭据**
- 席位用户无 sudo
- 员工能看见：桌面地址、linuxUser、seatId、共享目录、botVersion。看不见 CDP、sudo、LLM 密钥。**VNC 密码不再显示在对话页右栏**——票里已经带着它自动填进 noVNC，界面上留一行等于把随时可用的凭据摆在屏幕上；接口仍然返回，管理员在公司详情的席位卡里看得到
- Bot 环境必有 `SATUWORK_BOT_ID`。目录 `GET /runtime/catalog?botId=`，只钉那一颗，不种本地 `default`
- Bot 运行包在 Gateway 按版本发布；部署指定版本。公司可批量更新已部署的 pair：`POST /platform/orgs/:id/runtime/update`
- **「Gateway 在哪」在机器上冻着两份**：管家的 `/etc/satuwork/manager.json`（配对那天写的，心跳用它）和每个席位的 `bot.env`（部署那一刻写的，值来自 Gateway 进程的 `GATEWAY_PUBLIC_URL`）。Gateway 换了对外地址之后两份都是旧的，而且**都不报错**——管家表现成一盏「失联」灯，席位表现成每次模型调用都 `fetch failed`。两份现在都由 Gateway 每次入站调用捎的 `x-satuwork-gateway-url` 自动纠正：管家在 `requireMachine` 之后认（见 manager/README.md），席位在席位票验过之后认（见 bot/README.md 与 `bot/src/gateway-url.ts`），各自先落盘再改内存。**只在明确配过 `GATEWAY_PUBLIC_URL` 时才发这个头**，免得拿一个按 Host 猜出来的地址教坏机器
- `$SATUWORK_HOME` 是 `/home/{linuxUser}/.satuwork/{seatId}`，席位之间不共用

**共享的只有 `/home/{linuxUser}/work`。** 这是同一员工的多个 bot 看见同一批资料的唯一入口，靠 uid 相同实现，没有任何代码。其余一切按席位隔离——Chrome profile（同一个 `--user-data-dir` 起第二个 Chrome 会把网页开到别的席位屏上）、`XDG_RUNTIME_DIR`（logind 给的 `/run/user/{uid}` 是按 uid 的，会撞）、`XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_CACHE_HOME`（plank、dconf、picom、`.desktop` 跟着一起隔离）、`satuwork.db` 与 `sessions/`（`settings/change` 事件只在进程内广播，共用一份库会让另一个进程一直读到内存里的旧值）。

### 3.1a 换版之前先等会话跑完

换版是**打断**，两条路都是：

- **席位换 bot 版本** = `systemctl restart satuwork-bot@{seatId}`。正跑着的那一轮当场
  没命——日志里那条 `turn/end` 根本没写成（要等下一次从磁盘读这条会话才由
  `healDanglingTurn` 补上），花掉的 token 照样计费，而人正对着屏幕等回答。
- **管家自升级** = 重启管家自己。Gateway 到席位的每一跳（聊天、SSE、桌面、日志）都从
  它身上过，重启那几秒全断。

所以两边都先问一句「你忙不忙」，只是等法不同——这不是随手定的，是被各自的触发方式
逼出来的：

| | 谁触发 | 怎么等 | 等不到怎么办 |
| --- | --- | --- | --- |
| 席位换版 | Gateway 的一条 `PUT /seats/:id`，**同步**挂着 | 轮询席位的 `GET /api/health`，等 `min(调用方给的 drainMs, SATUWORK_SEAT_DRAIN_MS)`（后者默认 120 秒） | 回 `409 {busy:true}`，**机器上一个字节都不动**；Gateway 保留原状态与版本号，界面上单独数一格「有会话在跑没换」 |
| 管家自升级 | 心跳回包里的 `desiredManagerVersion`，30 秒一轮，**天然会重来** | 每轮心跳问一次所有席位，最多 `SATUWORK_UPGRADE_DEFER_MS`（默认 30 分钟） | 到点照换，journal 里写明等了多久、是谁占着；`GET /health` 的 `upgradeDeferred` 摊着「在等哪个版本、在等谁」 |

两个上限都不能省。同步那一路等太久会把一条 HTTP 请求吊死（批量重铺还要逐个席位串
下去）；异步那一路无限等则等于「一台天天有人用的机器再也不升级了」——而升级里往往
正躺着修这类问题的补丁。

**席位那一路的窗口由两个数取小，这一点不是可选的。** 调用方那侧的预算是
`deploySeat` 从这次请求的超时里切的一半（另一半留给真正的重铺），随 spec 的 `drainMs`
下发；机器那侧的上限是 `SATUWORK_SEAT_DRAIN_MS`。两个数各定各的就会出现**等到一半被
对面的超时掐断**：模版「立即下发」给单席位 90 秒、管家默认等 120 秒，于是每个忙着的
席位都在 90 秒时被 Gateway abort，库里记下一条「联系不上机器管家」并标红，而管家根本
不知道调用方走了，照样等满 120 秒再把席位重铺重启——机器好好的，状态却是假的。

`SATUWORK_SEAT_DRAIN_MS=0`（或 `drainMs: 0`）的意思是**一次都不等**，不是「关掉排空」：
席位忙照样回 409。「别管忙不忙，现在就重铺」是另一件事，走 `interrupt`。分开是有意的
——模版下发要的恰恰是「既不等，也不打断」。

「忙」的定义在席位那侧：`GET /api/health` 报 `{ busy, running, queued }`，`running` 来自
`ctx.agents`（在跑的 + 刚开跑还没造出 agent 的）。**`busy` 只看 `running`**：队列是落盘
的，而消费它的唯一时机是「某一轮跑完」——一条在 turn 跑到一半被杀掉留下的孤儿排队行，
重启之后会一直躺在盘上没人碰；把它算成忙，这个席位就永远自报忙、再也升不上去，而那时
拦下重启一件东西也保护不了（根本没有 turn 在跑，队列本来就不会动）。`queued` 照旧报出
来，它是查那种孤儿行的唯一线索。这条路**不要票**（管家手上只有机器票），所以只给计数，
不给会话 id 和正文。老席位不报这两个字段，管家一律当「问不出来」放行：拦住换版需要的是
**确凿的忙**，不是「没问出来」。

排空探的是**席位现在听着的那个口**（管家名册里的 `botPort`），不是这次 spec 要它听的
口：两者通常相同，但 Gateway 重分槽位时 spec 里那个口上蹲着的是另一个席位，拿它去问，
答的是别人忙不忙。

**顺序是「先落闸，再等」，不是「等到空闲就撒手」。** 只等「此刻没有 turn 在跑」是关不住
那个窗口的：等到空闲之后，到真正 `systemctl restart` 之间还隔着拉包、解包、rsync 几秒，
人在那几秒里发一句，照样被拦腰砍断，而排空看上去明明成功了。所以管家先让席位进入
**换版静默**（`POST /api/quiesce {ttlMs}`，带席位票），再开始等：

- 静默期里**不开新的一轮**：新消息、带 `@` 的排队、日常任务，一律当场回绝一句「席位正在
  换新版本，这几秒不接新消息」（409）。界面上草稿原样退回去，过几秒重发就是——比收下
  它、然后连 `turn/end` 都没写成就被换掉要诚实得多。正好撞上的日常任务会在流水上记一条
  失败，理由就是这句话（见 routines.ts）——比记一轮被砍断的、结局不明的执行强。
- **正在跑的那一轮不受影响**，steering 照旧插得进去。真有人一直插话，排空就等不到空闲、
  超时之后这次换版被拒——那个方向是安全的：宁可不换版，也不打断人。
- 静默**只在内存里，而且带 TTL**（席位那头夹在 5 分钟，管家发的是 4 分钟）。正常路径上
  它根本走不到期，进程被 systemctl 换掉，标记随内存一起没；而管家半路挂了、或者部署卡在
  重启之前，这台席位也不会变成一块永远不接活的砖。管家自己那侧还会在**每一条出口**上
  放开它（拉包失败、端口收不回来、脚本非零退出、排空超时——这些都停在重启之前）。
- 老席位没有这条路（404）：落不上就退回到没有静默的老样子，该换还得换。**不为一个增强
  把换版整个卡死。**

**只有人手工按的「重新部署」不等**（spec 里的 `interrupt`）。那条路上要修的往往正是一个
卡住的席位，拿排空把唯一的自助修复手段挡在门外就本末倒置了。模版「立即下发」虽然也带
`force`（那是为了穿过「版本没变就跳过」那道门），但它**不**打断谁：改一次模版把全公司
正跑着的那一轮一起掐掉，没有任何道理。

跨 bot 的「互相 @」**不走文件系统**：文件系统没有通知，叫不醒对方的 agent 循环，而且同一员工的席位未必在同一台机器上。那条路走 Gateway。

### 账号与角色

Gateway 账号分两类，公司账号再分两种。JWT 带 `role`：`owner` | `admin` | `member`。`owner` 没有 `companyId`。

| 角色 | 账号类型 | 谁 | 在 Gateway 管什么 |
|---|---|---|---|
| `owner` | 系统管理员 | 平台，不属于任何公司 | 所有注册公司；所有注册用户与公司管理员；模型供应商与可用模型（密钥只在这里）；全站日常模型 / utility 模型；系统级 Skill / MCP / 默认 Bot；订阅套餐；全站统计；Bot 运行包版本 |
| `admin` | 公司管理员 | 属于一家公司 | 本公司席位；本公司员工；对话审计（索引 + 按需拉全文）；费用；公司统计；公司 scope 的 Skill / MCP；**公司 Bot 模版**（全公司 Bot 的底座）；给员工 deploy pair |
| `member` | 公司员工 | 属于一家公司 | 只能看自己的统计。**自己建 Bot**（用公司模版当底座），自己部署、自己删。聊天走 Gateway UI，Gateway 反代到该 pair 的实例 |

公司管理员**不管**供应商、不管日常/utility、不管套餐 SKU、不管全局目录。员工在 Gateway **没有**公司管理入口。

自助注册仍创建一家公司 + 该公司第一个 `admin`。`owner` 可以查看、停用、改套餐，也可以再建公司或再建 `owner`。

日常模型、utility 模型、供应商密钥、可用模型白名单，都是**平台一份**，由 `owner` 写。不再按公司各设一套。Bot 发消息仍用该 Bot 的 `provider` + `model`，但必须落在 owner 放开的可用模型里；没指定时回落到平台日常或 utility。

---

## 4. 职责

### Gateway

- 注册、登录、JWT（JWKS 对外）。聊天 UI 在这里
- 公司、账号、角色（`owner` / `admin` / `member`）、套餐、席位
- 机器池：派机器、收回、记录该公司的访问地址
- 按 pair 部署：`PUT {machine.host}/seats/{seatId}` 交给机器管家，由它在本机建 linux 用户、起 `slim-desktop@` 与 `satuwork-bot@`
- 目录：模型、Skill、MCP、Bot，每条带 `scope: global | company | user`（`user` 的还带 `accountId`）。公司那一层的 Bot 配置是**一份模版**，不是一批 Bot
- 平台密钥（模型 / 需鉴权的 MCP），由 `owner` 配置。**不**下发到浏览器，**也不下发到 Bot 磁盘/环境**。公司不再各自贴 key
- 模型代理：`GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/responses`、`POST /v1/messages`。鉴权是席位 API Key（`sk_sw_`）或登录 JWT；`sat_` 不行。上游 key 由 Gateway 按 provider 选取（平台密钥 > 环境变量）
- 平台模型角色：`owner` 指定全站 **日常任务模型**（daily）和 **utility 模型**（轻量/快速），以及可用模型白名单。经平台 settings 读写，出现在 `GET /me` 里给 Bot 读。只存 provider + model，密钥仍按供应商留在 Gateway，不下发
- 用量汇聚与额度扣减（Gateway 在 `/v1/*` 代理侧按上游原始 usage 结算；实例不重复上报）
- 会话索引的写入与检索
- 按索引向机器拉全文，给公司管理员看
- 审计事件
- 把浏览器的会话 / SSE / 发消息反代到该 pair 的实例

### Bot 框架（本仓库，跑在 pair 实例里）

- 现有能力全部留下：Cordis 根、插件生命周期、会话 JSONL、`ctx.storage`、pi-agent-core、工具管道、SSE、steering
- **无头**：不发 SPA。产品聊天 UI 在 Gateway
- **pi-ai 不在 Bot 进程**。模型目录与上游调用在 Gateway（`/v1/*`）
- 一个进程恰好一个 Bot。`GET /api/bots` 返回钉住的那一颗（部署时由 `SATUWORK_BOT_ID` 钉目录项）
- 本地 `$SATUWORK_HOME`：`satuwork.db` + `sessions/*.jsonl`
- 启动时 `GET /runtime/catalog?botId=`，只钉这一颗；不种本地 `default`（`SATUWORK_BOT_ID` 已设）
- 验 `GATEWAY_TOKEN`（`sat_`）；用它上报 ready、会话索引、guard、handoff，只能替自己的账号说话
- 提供「按 sessionId 出全文」的内网接口；Gateway 仍带该账号的 `sat_`，管家那一跳另用 `smt_`
- 环境：`GATEWAY_URL`、`GATEWAY_TOKEN`（`sat_`）、`GATEWAY_API_KEY`（`sk_sw_`）、`SATUWORK_BOT_ID`。没有 `GATEWAY_MACHINE_TOKEN`，也没有 `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`

开通 / 停用由 Gateway 下发给**机器管家**，机器上确实另跑着这个监督进程（这条取代了原来「不另跑监督进程」的结论）。换掉 SSH 的理由有三条：Gateway 不必再明文保存 root 级凭据；对外端口从「每席位两个」收成一个；管家能自己升级，否则删掉 SSH 之后每次更新都要有人跑到每台机器前面。

---

## 5. 配置三层

所有「能被 Bot 用到的定义」只有三层。看得见才能用。

| 层 | 谁写 | 谁看见 | 存在哪 |
|---|---|---|---|
| 全局 | `owner` | 所有公司的所有账号 | Gateway |
| 公司 | 该公司 `admin` | 该公司账号 | Gateway |
| 我的 | 该员工自己 | **只有他本人** | Gateway |
| 本地 | 仅本地未设 `SATUWORK_BOT_ID` 时种 `default` | 该进程 | 该实例 |

目录种类：Bot、Skill、MCP、模型。模型密钥在平台，由 `owner` 配，不按公司、不按用户散落。可用模型由 `owner` 从 pi-ai 目录里放开。

### Bot 模版（公司这一层）

公司这一层**不再是一批共享的 Bot**，而是一份所有人共用的底座：

| 在模版里（公司统一） | 在每个 Bot 上（各人自己） |
|---|---|
| 系统提示词、行为边界、记忆策略、挂哪些 Skill / MCP、**能不能操作浏览器和允许哪些站点** | 名字、头像、简介、开场白、一段**追加**提示词 |

- 模版每保存一次，`version` **加一**。不是时间戳——时钟一歪（机器时区、库恢复）就会出现「新的比旧的还早」，只增的整数不会
- 员工的 Bot **不存副本**：读的时候拿当前模版现合成（`publicBot`）。所以「模版改了要同步」不是一个要去触发的动作，没有副本也就没有会漂的东西
- 追加提示词拼在模版提示词**后面**，不覆盖它。覆盖式的自定义会让模版形同虚设：第一个想改口气的人就把底座替掉了，之后公司再改模版他永远跟不上
- 跑着的席位**自己跟上**：实例每分钟打一次 `/runtime/catalog/version`，指纹变了才重拉整份目录（那一份带 MCP 明文 token，不该每分钟流动一次）。基线取自上一次拉目录时一起给的 `stamp`，不是第一次探针的结果——否则「拉完目录」到「第一次探针」之间落地的改动会永远丢掉
- **席位跟上了没有，平台看得见**：探针捎带 `?have=<席位这会儿跑的版本>`，Gateway 把它连同收到的时刻记在 `seat_runtimes.tplVersion / tplSyncedAt` 上（迁移 0013），「Bot 模版」那一页据此显示「3/4 在 v5」并点名落后的那几台。这条回报是**单独的一个数**，不是拿 Gateway 发了什么反推的——「进程死了」「机器断网」「拉取一直失败」在界面上原本和「一切正常」长得一模一样。汇报时刻兼作心跳：版本对得上、汇报停在两小时前，说明那个进程已经不在了
- admin 另有一个「立即下发」：把本公司已部署的席位挨个重铺。它会断掉正在进行的对话，所以不自动，只在「现在就要」和「那台机器上的东西不对」时按
- 一个人最多建几个 Bot 有上限（`GATEWAY_MAX_USER_BOTS`，默认 10）：每个 Bot 是机器上的一个真实进程，不是一行配置

#### 行为边界落在哪儿

模版上那三个开关（`high-risk` / `pii` / `no-external`）和「升级人工的条件」不是提示词里的
一句话，**它们是席位上工具执行前的一次表态**（`bot/src/policy/`，挂在 `tools/pre-execute`
这条 waterfall 上）。拦下来的调用没跑过——这是它和「让模型自己注意点」之间唯一的区别。

| 开关 | 判据 | 拦不住什么 |
|---|---|---|
| 禁止访问未授权的外部系统 | MCP 工具必须属于这颗 Bot 挂上的服务器（或这一轮 `@` 点名的连接）；`terminal` 扫命令名（`curl` / `git push` / `pip install` …），`bash -c "…"`、`eval "…"` 里那一段先展开再扫 | `terminal` 里 base64 拼出来的命令。真正的解是把它关进沙箱，在那之前这一层是「挡住顺手」，不是「挡住蓄意」 |
| 拦截个人敏感信息 | 出站参数里的手机号、身份证号（校验位）、银行卡号（Luhn）。**邮箱不算**——算进去邮件类连接器整个不能用 | 拆开写的号码、图片里的号码 |
| 高风险操作需确认 | 会毁东西的、或者「对外 + 写」的调用，停在执行前等人在对话里点批准；`terminal` 按命令判（`rm -rf` 要问，`git status` 不问） | — |
| 升级人工的条件 | 原样进系统提示词，配一把 `escalate_to_human` 工具；另外连着被挡 3 次自动改口劝转人工 | 它是判断题，写不成拦截规则 |

调用 `escalate_to_human` 之后**这件事怎么交到人手上、又怎么交回来**（交接单、指派、通知、
交还），是单独一份规范：[handoff.md](./handoff.md)。这张表只管到"它是一把真工具、调用会留痕"
为止。

浏览器（`browser.*`，见 [browser-tools.md](./browser-tools.md)）在模版里是**能力**，不是
第四条边界——那三条的语义是「要不要收紧」，默认全开等于最严；这一个是「要不要放开」，
默认关才是最严，并排放会让人读反。它落在三处：

| 落点 | 管什么 | 受开关影响吗 |
|---|---|---|
| `browser.on` | 关着就不注册那几把工具，调也调不通 | 不受。这是能力，不是边界 |
| 硬黑名单（回环、内网、非 http；按**解析到的 IP** 判） | 防的是用浏览器回头打自己的 bot 口 / CDP 口 / 管家口 | **谁都关不掉**。审计里记成 `guard: browser`，和三条开关分得开 |
| `browser.sites` 站点白名单 | 「禁止访问未授权的外部系统」在网页这一侧的样子 | 受 `no-external`。关掉它就等于说「可以去名单外的地方」 |

几条要点：

- **工具自报风险面**（`ToolDefinition.risk`：`read` / `write` / `external` / `destructive`）。
  没标注的按最高风险算——反过来意味着任何一把新注册的工具默认绕过全部边界，而新工具
  恰恰是最没被审视过的那些
- MCP 工具的风险 = 目录里配的 `perm` **加上**远端工具名里的动词，只叠加不相减。连接器
  合成出来的服务器 `perm` 默认是「只读」，而里面躺着 `GMAIL_SEND_EMAIL`
- **认不出就拦**：会话读不到、名册里没有这颗 Bot、老 Gateway 没下发 `guards`——三种都按
  全开处理。只有 `origin: local` 的自建 Bot 是明写出来的例外（没有模版管它）
- 确认是**一次真的往返**：调用停在席位上等，人在对话里点批准，这次调用继续跑下去
  （`tool/approval` 事件 → 界面上的卡片 → `POST /runtime/sessions/:id/approvals/:callId`）。
  超时（默认 5 分钟）和「点了停止」都按**不执行**处理
- 卡片上有四颗按钮，两两对称：**批准这一次 / 这一轮都批准**、**拒绝 / 这一轮别再试**。
  带范围的那两颗都**只管一轮**，轮末清掉。不能按会话记：一个 Bot 一辈子只有一条会话
  （`ensureSession` 有就复用），席位上的 bot 又是常驻进程，按会话等于「这台机器上这把
  工具从此不再问 / 再也不能用」——而按钮上写的是「这一轮」
- 「这一轮别再试」**是单独一颗按钮，不是「拒绝」的默认行为**：默认就挡的话，
  「拒绝 → 跟它说改发给李总 → 它重发」这条最自然的路会被自己挡死（插话是插进同一轮的）
- 卡片长什么样由席位给的**表单描述**决定（`bot/src/policy/forms.ts`）：`generic` 是工具名 +
  整份参数，`email` 是收件人 / 主题 / 正文，其中主题和正文**可以直接改**，改完执行的就是
  改后那一份（`decide` 写回的是那次调用本身的 `arguments`）。界面认不出的 kind 一律退回
  `generic`。改过的那一次强制降成「只批这一次」
- 每一次表态都落一条 `tool/policy` 会话事件，并经 `POST /internal/guard-events` 进公司审计
  （`bot.guard.*`）。只拦不报的话，没有任何一处回答得了「上个月拦了几次」

**物化规则：**

- 部署实例：`GET /runtime/catalog?botId=`，只钉这一颗（`origin: global|company` + 远程 id），会话写在本机。提示词和官方挂载只读。不种 `default`，不自建
- 本地无 Gateway / 未设 `SATUWORK_BOT_ID`：可种 `origin: local` 的 `default`，便于单机验收
- 公司要统一口径：admin 改**公司 Bot 模版**，不是实例自动上传，也不是逐个 Bot 去改

Skill / MCP：**定义**在 Gateway，**进程**跑在实例旁边。实例按当前账号可见集合成请求头里的工具表。公司密钥只下发到实例。

---

## 6. 开通

1. 在 Gateway 建公司（得到 `companyId`、`slug`）
2. 购买套餐，例如 3 席（3 个账号，不是 3 个进程）
3. Gateway 从机器池派一台 Debian 给该公司，写入访问地址
4. 开通最多 3 个账号。每个账号占用一席
5. 用户登录 Gateway。聊天 UI 留在 Gateway，不跳到公司访问地址
6. 员工在界面上建一颗自己的 Bot（`POST /runtime/bots`）——**建完就开装，不用再点一次
   「部署」**。这条请求只等「登记」（挑机器、定槽位、把席位行写成 `deploying`），机器上
   那十几分钟丢进后台；装不成的理由（没配机器、没发布版本、槽位满）回在回执的 `deploy`
   字段里，不把 201 变成 409——Bot 本身是好的，机器修好之后点一下就能装上。
   要重铺、要指定版本，仍然是 `POST /runtime/deploy` `{ botId }`（同步，等到装完为止）；
   管理员可 `POST /orgs/:id/accounts/:accountId/deploy` `{ botId }`
   - 装的这段时间里，界面每两秒问一次 `GET /runtime/deploy/progress?botId=`：Gateway 自己
     的那份（`status` / `phase` / `elapsedMs`）永远有；机器上那份细进度（第几
     步、这一步在干什么）由管家现问现答（`GET /seats/:id/progress`，协议 ≥ 3），问不到就
     只剩粗的那一档
7. Gateway `PUT {machine.host}/seats/{seatId}` 给机器管家：由管家在本机建 `linuxUser`、写 `$SATUWORK_HOME`、起 `slim-desktop@` 与 `satuwork-bot@`，注入 `SATUWORK_BOT_ID`、席位票 `sat_` 与 API Key `sk_sw_`。机器票 `smt_` 不进入席位环境
8. 实例 `POST /internal/instances/:accountId/ready` `{ host, botId }`

v1 约束：一家公司一台机器；机器先按 **pair 进程** 隔离，不上容器套容器。

---

## 7. 访问地址

- 每家公司**一个** `accessUrl`，由 Gateway 在派机器时发出，写在公司记录里。这是机器/DNS 登记，不是聊天入口
- 浏览器：管理页和聊天都打 Gateway。发消息、审批、上传由 Gateway 反代到该 pair 的 Bot HTTP（`3200+N`）
- **对话那条 SSE 直连席位机器**（机器配了 `directUrl` 且管家协议 ≥ 5，`streamUrlOf`）：浏览器带登录 JWT 打 `{directUrl}/seats/{seatId}/stream/sessions/{id}/events`，管家验签、问一次 Gateway `/me`（按票缓存 60 秒，吊销靠这一问）、换成该席位的 `sat_` 转给 Bot，对 Gateway 的源开 CORS。**任何失败前端都退回 Gateway 反代五分钟**，所以老管家、没重新部署的席位（管家名册里没有 `sat_`，回 409）、证书不对，表现都只是「走了老路」。这是 Gateway 从对话热路径上退下来的第一步，见 [adr-gateway-vercel-neon.md](adr-gateway-vercel-neon.md) §7
- **本地 Bot（桌面端）不经过 Gateway**：会话请求由页面直接改道到 127.0.0.1（ui/data.js 的 `localRoute`），Gateway 不再有反向隧道，也不知道它在不在跑；名单流、日常任务调度都不含本地 Bot。见 desktop/README.md「本地 Bot 直连本机」
- **名单流同样直连**（管家协议 ≥ 6，`rosterUrlOf`）：`/runtime/bots` 多给一格 `rosterStreamUrl`，浏览器带登录 JWT 打 `{directUrl}/roster/stream`，管家把这个人在本机的所有席位合成一条（manager/src/roster.ts，过滤规则是 gateway 那份 roster-filter 的逐字副本，e2e 按字节钉着）。**这个人有本地 Bot 时不给直连地址**：本地 Bot 不在任何机器的名册里，整条名单照旧从 Gateway 扇入。失败退路同上
- 桌面：**两条路，按机器有没有配 `directUrl` 选**（`novncUrlOf`）。票都是同一张：Gateway 用 JWT 私钥签、五分钟有效、只对一块屏
  - **默认：Gateway 同域反代** `/desktop/{seatId}/?ticket=…`。Gateway 验完票换成路径段里的票，再把请求（含 WebSocket 升级）反代到管家的 `/seats/{seatId}/vnc/*`，用机器票（`smt_`）认。x11vnc、websockify、CDP 全部只听 `127.0.0.1`
  - **配了 `directUrl` 就直连** `https://m001…/seats/{seatId}/vnc/?ticket=…`。浏览器直接打席位机器上的管家，Gateway 不再中转像素——实测那是整条链上最贵的一股流量（1280×800 下 Bot 一滚页面就是 4 MB/s，静止时是 0）。**不是把开销挪给席位机器**：那些字节它今天就在发（发给 Gateway），直连只是消掉一次转发
- **直连还要管家够新（协议 ≥ 4）**：落地页那段「关掉 noVNC 控制条」的样式和 `frame-ancestors`，走反代是 Gateway 插的，直连那一跳只能管家自己插。填了 `directUrl` 但管家还是 3 号 → 照旧走反代，机器卡上报 `directPending`。这样升级顺序怎么颠倒都不出岔子；少了这道闸，表现是同一块预览在有的机器上多一条控件压着画面，而配置里看不出区别
- 直连的三个前提，缺一条就别配：**公网可达**、**必须 https**（Gateway 是 https，http 的 iframe 会被当混合内容静默拦掉，界面上只是一块永远打不开的空白）、**最好和 Gateway 同一个可注册域**（SameSite 判的是 site 不是 origin，同站时管家那张 `SameSite=Lax` cookie 在 iframe 子框里才带得上）
  - 前端的 `sandbox` 跟着地址走：反代那条路同源，**绝不能**给 `allow-same-origin`（框里那页能读父页 sessionStorage 里的登录 JWT）；直连那条本来就跨源，加回来既安全又必要——不加的话框是 opaque 源，管家那张 cookie 带不上。判据是这个 URL 跨不跨源，不是「配没配直连」
  - **退路一直留着**：清空 `directUrl` 就回到反代。管家在内网、还没铺证书的机器，直连根本走不通；桌面打不开时先清这一格
- 管家侧 `/seats/:id/vnc/*` 同时认两种：机器票（Gateway 反代过来的）和票/cookie（浏览器直连的）。**后者一直没拆**，直连走的就是它

### 7.1 上线必须挂 TLS 反代（为了 h2）

Gateway 自己是 `node:http`，只说 HTTP/1.1。**而 HTTP/1.1 下浏览器对同一个源只给 6 条
连接，每条 SSE 是一个永不结束的 fetch，开着就占死一条。** 这曾经是致命的：名单上一个
Bot 一条流，6 个 Bot 就把槽占光，这一页余下的请求全部排在后面干等，**刷新之后消息迟迟
不出来**，短则三五秒长到十几秒，而且每次不一样（谁抢到槽是随机的）。

名单那条通道已经把它收成一条了（见 §12），所以最坏情况不再是十几条。但常驻的两条之外，
这一页还有一串 XHR 要跑——正文的 `history`、待办、确认、交接、日常任务、`@` 候选——6 条
仍然是个会硌人的数。h2 一条 TCP 多路复用上百条流，这件事就不用再算了。

现成的配置在 [`gateway/deploy/`](../gateway/deploy/)：`Caddyfile.example`（自动证书、
自动 h2）和 `nginx.conf.example`（Debian 上更常用）。两份都写清了同一件命门事：

> **反代不许缓冲 SSE**（nginx `proxy_buffering off` + `gzip off`，Caddy `flush_interval -1`），
> 而且要把空闲超时放到小时级。缓冲会把席位那条 `replay/done` 连同重放的尾巴一起攒住，
> 而一条安静下来的会话再也不会有新字节把它顶出去——症状就是 §12 里那句「历史缺一截 +
> 永远挂着正在处理」，连接看着还开着，也不会重连。

**这一条要在本地验过再上线**，而且不需要证书——攒不攒和 TLS 无关。
`gateway/deploy/check-sse.mjs` 就是干这个的：它起一个假席位，复现真实的失败形状（先灌
一批帧、然后彻底安静下来），再从反代那一头看结尾标记多久才到。配套的
`nginx.local.conf` 起两个 server，一个照上线配、一个故意用 nginx 默认值——**两个都跑一遍**，
不然你不知道这个测是不是根本抓不到东西。

**挂了反代还要配 `GATEWAY_TRUSTED_PROXIES`**（逗号分隔的 IP 或 CIDR，比如
`127.0.0.1,::1`）。机器配对时 Gateway 拿 socket 源地址当「这台机器在哪儿」，过了反代
那个地址永远是 127.0.0.1，每台机器都会被记成在 Gateway 自己这台上，第一次部署才发现
打不通。配了名单之后，只有从名单里的地址进来的连接才采信 `X-Forwarded-For`（取最右
侧第一个名单外的地址）；不配就只看 socket，和以前一样。

本地开发不挂反代也能用：名单那条通道只占一条连接，**所有 Bot 的实时状态照旧都有**。
HTTP/1.1 那 6 条只是紧一点——真正受限的是「切过几个 Bot 之后留在手上的对话流」，上限 3
条（`chat.js` 的 `BOT_STREAM_MAX`）。这是本地的正常样子，不是 bug。

---

## 8. 认证

各类凭据用途不混：

| 票 | 前缀 / 名 | 谁用 | 干什么 |
|---|---|---|---|
| 登录 JWT | Gateway 签发 | 浏览器 / 控制台 | dashboard 与 Gateway UI。带 `accountId` `role`（`owner` \| `admin` \| `member`）；公司账号再带 `companyId`。暴露 JWKS |
| API Key | `sk_sw_…` | Bot 调 `/v1/*`；也可登录 JWT 调 `/v1` | 开 admin/member 时签发，用量记在这个用户上。owner 账号详情 `/users/:id`（`GET /platform/accounts/:id`）可见。列表 API 永不带出。`owner` 账号没有 |
| Access token | `sat_…` | Gateway ↔ Bot 双向，该席位用户 | Bot 环境 `GATEWAY_TOKEN`。同一用户的多个 Bot 实例共用一把。不能调 `/v1` |
| Machine token | `smt_…` | 一台机器一把；Gateway ↔ 机器管家 | 管家心跳、拉发布包、部署/删除/诊断/日志，以及 Gateway 经管家反代 Bot/桌面。写在 `machines.token` 与管家的 `manager.json`，**永不进入 `bot.env`** |
| Bootstrap machine token | Gateway 环境变量 `GATEWAY_MACHINE_TOKEN`（引导值） | 无 UI 登记机器的兼容/测试路径 | 只用于 `POST /internal/machines`。正常装机使用一次性配对码；登记后换成该机器自己的 `smt_` |

- 密码、注册、重置只在 Gateway
- 实例不存密码，也不存 `smt_`。部署实例的 `/api/*` 与 `/internal/sessions/:id` 都验该账号的 `sat_`；管家在上一跳独立验证 `smt_`
- 现有 `src/auth` 的本机 cookie 登录不是产品路径（实现阶段遗留）

---

## 9. Bot 与会话

一个 Bot 一条长会话。Gateway 打开该 Bot 复用，不每次新建。部署实例一个进程只有这一颗。

会话根事件在现有信封上增加：

```
session: {
  version, id, createdAt, title?,
  botId,            // 本实例内 Bot id（v2 字段名是 agentId，启动时迁过来）
  origin,           // local | company | global
  remoteId?         // origin 不是 local 时，Gateway 上的定义 id
}
```

每个 Bot 有自己的 `provider` + `model`。发消息用这一对，不是进程全局默认。本地未设 `SATUWORK_BOT_ID` 时仍可种 `default`（`deepseek` + 默认模型 id），只有 Gateway 配了对应密钥才能真正调通。

`SESSION_FORMAT_VERSION` 因此再 +1（v3），并写迁移：旧会话没有 `botId` 的，取原 `agentId`，再没有则挂到该实例的默认 Bot。必须有迁移，不能丢文件。

**v4：消息内容块加了 `image`。** 形状是 `{ type: 'image', path, mime }`——**存路径，不存
字节**。一张 2 MB 的图 base64 之后是 2.7 MB，直接落进 JSONL 会让这一行没法 grep、没法
tail，整条会话的重放还要把它再搬一遍。图片本体就在工作区里（`uploads/<sessionId>/`），
组模型请求的时候现读现转。

v3 → v4 不需要专门的迁移代码：老日志里根本没有 image 块，走已有的「版本号低于当前就
就地升级」那条路即可。

---

## 10. 会话索引（Gateway）与全文（机器）

实例在这些时刻**只报索引**，不报正文：

- 会话创建
- 标题变更
- 一轮结束（可带最后活动时间、消息条数，仍无正文）

索引记录至少：

```
sessionId
companyId
accountId
botId
origin
remoteId?
machineId
title
createdAt
updatedAt
messageCount?
```

公司管理员在 Gateway 按人 / Bot / 时间检索到索引。点开时：

1. Gateway 用服务凭证向该 `machineId` 要 `GET /internal/sessions/:sessionId`
2. 机器读本地 JSONL，返回事件列表
3. Gateway **不落盘**这次响应，用完即弃（或仅进程内缓存，重启即无）

机器不在线：只能看索引，并明确提示「机器不可达」。

---

## 11. 审计

记在 Gateway，和聊天正文分开。至少这些事件：

- 登录 / 登出
- 开通、停用账号或实例；pair 部署 / 批量更新版本
- 新建 / 修改 / 删除公司 Skill、公司 MCP、公司模型密钥；改公司 Bot 模版；员工建 / 改 / 删自己的 Bot
- 账号部署某个全局 Bot 或自己建的 Bot（钉到该 pair）
- 套餐、席位变更
- Gateway 拉取某条会话全文（谁、何时、哪条 sessionId）

审计事件**不是** `user/message` 原文。

对话审计另走固定的三个连续 8 小时窗口（公司审计时区 09:00 起算）。Gateway 创建并租赁
批次，Bot 运行时在本地读取 JSONL、脱敏，并用批次固化的模型生成任务总结、时间线、用户
问题、模型回答、最终结果和评分，再把有长度上限的结构化派生物写回 Gateway。默认使用平台
任务模型 `daily`，公司管理员可以改为 `utility`；模型选择只影响新批次。删除 Bot 时先冻结，
完成一笔 `pre_delete` 终审（从未对话过则明确记为 `empty`）后才允许物理删除。完整设计见
[`conversation-audit.md`](conversation-audit.md)。

---

## 12. 一轮对话（浏览器打 Gateway；Gateway 反代到该 pair；模型走 `/v1`）

1. 用户在 Gateway 打开该 Bot（名册 `GET /runtime/bots`，200 即使实例未上线；每条带 `runtime` 或 null）
2. 未部署 → 会话/SSE/发消息 503 `实例还没上线`
3. 已上线：Gateway 把 `/runtime/bots/:id/session`、SSE、发消息反代到**该 pair** 的实例
4. 没有长会话就 `sessions.create`，根事件带 `botId` / `origin` / `remoteId`，并上报索引
5. 发消息：已在跑则 steering，否则新 turn（现有行为）
6. 组请求：系统提示词来自该 Bot；工具表 = 该 Bot 挂上的、且当前账号可见的 Skill / MCP
7. 模型：Bot 用该 Bot 的 `provider` + `model`，以 **API Key（`sk_sw_`）** 打 Gateway `/v1/*`。**不**在实例上调 provider，**不**持有上游 key
   - `openai` → `/v1/chat/completions` 或 `/v1/responses`
   - `anthropic` → `/v1/messages`
   - `deepseek` 及其他 OpenAI Chat 兼容协议 → `/v1/chat/completions`
8. Gateway 用 pi-ai（Chat Completions）或把 Responses / Anthropic Messages 透传到官方上游；密钥按 provider 从平台选取，永不回显
9. 事件追加到本机 JSONL，经现有 SSE 推（Gateway 再转给浏览器）
10. turn 结束：Bot 报索引（`updatedAt`、`messageCount`）；用量已经由 Gateway 的 `/v1/*` 代理按这次调用结算，Bot 不再重复上报

浏览器的聊天 SSE / 发消息打 Gateway，不直连实例。**模型调用**是 Bot 进程打 Gateway `/v1`。

### 打开一个 Bot：历史和实时是两条路

点进一个 Bot 时，前端**并发**发两个请求，不是一条流包办：

| | 走法 | 拿什么 |
| --- | --- | --- |
| 历史 | `GET /runtime/sessions/:id/history?turns=20` | 最近 20 轮。往上翻是同一个接口加 `before=<seq>` |
| 实时 | `GET /runtime/sessions/:id/events?tail=1` | 垫最近 1 轮兜底，随后是实时事件 |

拆开的理由是「历史放完了没有」这件事**不该猜**。挤在一条流里时，历史和实时是同样的
`data:` 帧，客户端只能靠 `replay/done` 这个标记加三个定时器兜着；而那条标记会连同尾巴
一起压在下游缓冲里出不来（实测 bot 报重放 1078 条、客户端只收到 1054 条），于是历史缺
一截、界面因为拿不到那句「在不在跑」而永远挂着「正在处理」。HTTP 那一路没有这个失败
模式：promise 落地就是拿全了。

两条路的事件都带 `seq`（会话日志行号，单调），所以归并只有两条规矩，两头各挡一次：

- 进事件桶时**比尾巴大才收**（`pushBotEvent`）——挡住 HTTP 先到时流那段重叠的重放；
- 补历史时**比头小才收**（`hydrateChat`）——挡住流先到时历史那段重叠的尾巴。

于是谁先到都画得对。`replay/done` 保留，但只剩它真正该干的活：报 `live`（这条会话此刻
在不在跑，`ctx.agents.isRunning` 说了算）和 `queued`（席位那边的排队快照）。

**流断了自己接回来。** SSE 会断，而且不是意外：每一次换版、每一次管家重启、中间任何
一跳的空闲超时都会断。断了不接的代价很特别——**消息照发照跑**（POST 走的是另一条请
求），回答经 SSE 送出来时没人在听，屏幕上一直挂着「正在思考」，而 bot 日志里那一轮明
明写着 completed。所以：

- 退避重连到 40 档为止（约 5 分钟，前 5 档退到 8 秒，之后每档 8 秒）。**24 秒是不够
  的**：重铺一个席位要拉发布包、解包、rsync、重启两个单元、再各自自证端口，几分钟是常态。
- 重连带 `after=<seq>`，断线期间错过的那几条一起补回来——不是「从现在开始听」。
- 只有 401 / 403 / 404 当场认输（票没了、这颗 Bot 不是你的、席位在那台机器上已经没
  了）。502 / 503 / 504 一律重来：管家反代不到席位时回的正是 502。
- 认输也不是死局：**发消息之前会先确认还有人在听**，没有就当场重开一条；标签页回到
  前台、以及那句「连接断开」旁边的「重新连接」按钮，同样各是一个入口。刷新整页仍然
  管用，但那会丢掉草稿和还没发出去的附件，不该是唯一的出路。
- 「拿会话」那一跳（`GET /runtime/bots/:id/session`）是同一套：退避 60 次约 5 分钟，
  回到前台时再试一次（**只在对话页上**：`state.chatBotId` 在人走开之后仍留着，拿它在
  别的页上重试，认输时那一下 `render()` 会把正在填的表单换掉）。
- 顶上那条横幅只归**人正看着的那条会话**（`noteStreamDown` / `noteStreamWarming`）。
  名单上每个 Bot 都挂着一条流，任何一条断了都会走到认输那一支——让它写这一格的话，
  屏幕上这条好好的对话会被扣一句「连接断开」，点「重新连接」重连的还是另一条流，而且
  那一下整页重绘会让正在打字的人丢焦点。后台流断了就安静放手，人点进去时
  `ensureChatSession` 会重新拿会话、重新开流。
- **还有一种流压根没有「断」：连接开着，字节再也不来。** 上面那一整套（退避、长跑、
  发消息前的确认、切回前台）等的都是「断」，判据全是 `row.ac` 在不在——半死的流 ac
  还在，谁都以为它好着，于是没有任何东西会去碰它。它的来路有两条：中间哪一跳的反代把
  上游的 aborted/error 吞了（`pipe` 只在干净的 end 上收尾下游——manager/src/proxy.ts
  和 gateway/src/desktop.ts 都补了「`up` close 而 res 没 end 就 destroy」那一句），
  以及真正的网络半开（NAT 超时、机器断电，谁也替你收不了尾）。所以客户端有最后一道
  闸：bot 每 15 秒在流上发一条 `: ping`（它不是事件，解析直接跳过，但它是字节），
  前端把每个字节都记成脉搏（`sweepSilentStreams`），**45 秒（三个心跳）没有任何字节
  就把这条流当死的拆掉重连**——带 `after` 游标，静默期间错过的一起补回来。只盯收到
  过字节的流：连上了却一个字节都没来的那种归重放看门狗（8 秒）管。

### 名单是第三条路：一个人一条通道，不是一个 Bot 一条

侧栏名单要显示每个 Bot「在不在跑 / 最近说了什么 / 是不是在等你」。这三样只能从会话事件
里拿，而原来的做法是**名单上每个 Bot 各挂一条 SSE**。两笔代价都很重：

- **连接槽。** 见 §7.1：HTTP/1.1 下浏览器每个源只给 6 条，SSE 是永不结束的 fetch，开着
  就占死一条。十几个 Bot 把槽占光，正文那条 `history` 排在后面干等。
- **token 洪流。** 那几条流拿的是**全量**事件，包括每个 token 一条的 `assistant/chunk`。
  十个 Bot 同时干活就是十路 token 流在主线程上 `JSON.parse`，画的是侧栏十行灰字——而
  名单对 chunk 做的**只有一件事**：把「最近活动」那个 HH:MM 的钟往前推。

现在收成一条：`GET /runtime/roster/stream`，**一个人一条，Gateway 扇入**
（`gateway/src/lib/roster-stream.ts`）。加上正在看的那条对话，稳定态一共两条连接，跟
Bot 数无关。

| | 走法 | 拿什么 |
| --- | --- | --- |
| 名单 | `GET /runtime/roster/stream` | 所有 Bot 的状态变化，一条通道 |
| 正文 | `GET /runtime/sessions/:id/events` | 人点进的那一个，全量事件 |

四条规矩：

- **只转名单消费的那六种**：`turn/start` `turn/end` `human/handoff` `tool/approval`
  `user/message` `assistant/message`（照着前端 `noteBotEvent` 数出来的）。`chunk` 在
  Gateway 这一层折成一个**节流过的时间戳**（20 秒一次），形状仍是 `assistant/chunk`，
  所以前端那段逻辑一行都不用改。认不出来的类型**一律不转**——默认放行的话，将来加一种
  高频事件就是又一次洪流。规则由 `e2e/roster-stream.mjs` 一条条钉着。
- **它喂的是摘要，不是正文。** 帧里的事件是过滤过的，凑不成一条会话，所以前端只拿它更新
  `sum`，**绝不进事件桶**——进了的话点进那个 Bot 会看到一段缺了正文的历史。
- **席位那边一行都没改。** Gateway 订的是席位现成的 `/api/sessions/:id/events`，过滤和
  折叠都在 Gateway 做。十几台席位不用跟着发版。
- **路径叫 `stream` 不叫 `events`**：前后好几处（含测试的 fetch 桩）拿
  `path.includes('/events')` 认会话流，撞上同一个子串会把名单这条当成某条会话的流。

断了不认输：Gateway 侧每个 Bot 各自退避重连（封顶 30 秒一次），浏览器侧整条通道也退避
重连。认输的代价在这条通道上特别隐蔽——名单那颗点会停在断掉那一刻，「正在执行」一直转
下去，而那台 Bot 可能十分钟前就干完了，人看到的是「在跑」而不是「断了」，不会想到去刷新。

**流上为什么只垫 1 轮**：这一轮是给「点进去的第一帧」垫的——历史那次 HTTP 还在路上时，
屏幕上先有最后一问一答，比空白诚实。打开对话要看的那二十轮由 `hydrateChat` 走 HTTP 拉。

---

## 12b. Gateway 的存储

业务数据在 **PostgreSQL**（`GATEWAY_DATABASE_URL`）。同一个库里可以按
`GATEWAY_PG_SCHEMA` 分开多套环境；默认 `public`。

`GATEWAY_PG_RESET=1` 会在起进程时把这个 schema **整个 drop 掉重建**（只对非 `public`
生效，e2e 用）。它起手先拿一把会话级 advisory lock 认领这个 schema，握到进程结束：
同一个 schema 上已经有别的 Gateway 在跑时，当场停机并报出对面是谁，而不是把人家的
数据抹掉。以前没有这道闸，两份 e2e 同时跑就会互相清库，而现象是一串
`relation ... does not exist` 和 401「账号不存在」，指不回真正的原因。

磁盘上只剩两样重启不能变的东西：

```
$SATUWORK_GATEWAY_HOME/  # 默认 ~/.satuwork-gateway
  keys/jwt-*.pem         JWT 密钥对——换了它已发出的票会全部失效
  releases/bot-*.tgz     Bot 运行包
```

聊天正文不进 Gateway，任何时候都只在实例的 JSONL 里；库里保存会话**指针**和经过脱敏、
限长的结构化审计派生物，不能用它重建原始会话。

部署：`docker compose up -d`（Gateway + PostgreSQL）。Bot 不在 compose 里，它按 pair
宿主机 PG 端口用 5434。

### 发布包从哪来

**生产：CI 构建，Gateway 只收。** Gateway 镜像里没有 bot 源码，也不构建：

```bash
GATEWAY_PLATFORM_TOKEN=… node bot/pack.mjs --upload https://gw.example.com --note nightly
```

`bot/pack.mjs` 干两件事。一是**把依赖变成真文件**：`pnpm deploy --legacy` 生成自包含
目录，里面的软链只指向包内部的 `.pnpm`，解到席位机器上不会断——仓库里的
`bot/node_modules` 是指向 workspace 根的软链，直接打包出去就是一堆断链，而机器上
既没有 pnpm 也没有 install 这一步。devDependencies 也一起进包：systemd 跑的是
`node --import tsx bin/satuwork.mjs`，src/ 是 TypeScript，tsx 是**运行时**依赖。
二是 PUT 上来（等价于手工 curl）：

```bash
curl -sf -X PUT "$GATEWAY_URL/platform/bot-releases/$VERSION?note=$NOTE" \
  -H "Authorization: Bearer $GATEWAY_PLATFORM_TOKEN" \
  -H "X-Bot-Sha256: $(shasum -a 256 bot.tgz | cut -d' ' -f1)" \
  --data-binary @bot.tgz
```

GitHub Actions 的接线在 `.github/workflows/bot-release.yml`：推 `bot-v*` tag 触发，
要 `GATEWAY_URL` 和 `GATEWAY_PLATFORM_TOKEN` 两个 secret。

收下的包要过三关：sha256 跟 `X-Bot-Sha256` 对得上（不带这个头就跳过这关）、是 gzip
的 tar、里面有 `bin/satuwork.mjs`。任何一关不过就删文件、不入库。上限
`GATEWAY_RELEASE_MAX_BYTES`（默认 256 MiB）。包直接流式写到最终文件名上，用 `wx`
开——文件本身就是这个版本的锁，同一个版本传两次第二次拿 409。

版本号由 CI 给，建议 `<pkg version>+<git sha>`（`+` 是合法字符），这样一个版本号永远
对应同一份字节，回滚时找得回来。

**只有上传这一条路。** 源码打包（原 `POST /platform/bot-releases`）已经拆掉：它只有
本地开发的 Gateway 能走，而且打出来的包带的是**那台机器**的 esbuild 原生二进制，
传到席位机器上 tsx 加载不了它，进程起不来。包必须在和席位机器同架构的 Linux 上打，
`pack.mjs` 会拦住不合规的包。

发布包只在 Gateway 本机磁盘上（`$SATUWORK_GATEWAY_HOME/releases/`），部署时要 scp
给席位机器——**Gateway 因此是单实例**。要多副本就得先把这个目录换成对象存储。

---

## 13. 实例进程

机器上除了每个席位的两个单元（`satuwork-bot@` / `slim-desktop@`）和管家，7 号协议起还有一个
`satuwork-worker.service`：非 root，替 Gateway 接下日常任务的「到点去敲、等跑完」那段（见
[routines.md](routines.md) §8b、manager/README.md「席位工人」）。

每个员工一个 Linux 账号，账号下每个 pair 一个席位：

```
/home/{linuxUser}/
  work/                        共享工作区。同一员工的所有席位都看得见
  .satuwork/{seatId}/          = $SATUWORK_HOME，席位之间不共用
    satuwork.db                设置、本机钉住的 Bot、队列（待上报的索引/用量）
    sessions/<id>.jsonl        工作副本，唯一全文
    app/                       该席位的 Bot 代码（cordis.yml 的监听口逐席位 sed）
    chrome/                    Chrome --user-data-dir
    config/ share/ cache/      XDG_CONFIG_HOME / XDG_DATA_HOME / XDG_CACHE_HOME
    bin/seat-chrome            Chrome 包装脚本（带 --remote-debugging-port 和上面那份 profile）
    bot.env  desktop.env  vnc-passwd
```

`bot.env` 和 `desktop.env` 都带 CDP 口（`SATUWORK_CDP_PORT` / `CDP`，同一个值）：桌面那套
靠它拼包装脚本，Bot 进程靠它连上员工正在看的那个浏览器。**两份都要有**——bot 单元的
`EnvironmentFile` 只读 `bot.env`，只写进 desktop.env 的话，浏览器工具连不上自己席位的
浏览器（见 [browser-tools.md](./browser-tools.md) §3）。

发布包解到 `/opt/satuwork/releases/{version}/`，**全机共享**：同一版本的第二个席位不再重解一遍。

上报失败必须落本地队列，下次重试。聊天不因 Gateway 短暂不可用而失败（已建连的 turn）；未部署的 pair 在 Gateway 上 503。

本仓库要改的产品形状（实现阶段，对照现状）：

- `satu-agent-registry`：`storage.collection('bots')`；部署时只有钉住的那一颗
- 会话属于 Bot
- 模型 / Skill / MCP **目录**以 Gateway 为准；本机只缓存。Bot 的 llm 层是 Gateway `/v1/*` 的薄客户端（API Key）
- `accounts` / `billing` / 套餐屏从本仓库产品主路径拿掉，入口在 Gateway
- 聊天 UI、名册在 Gateway；实例无头

---

## 14. 接口契约（实现时按此立路由，名字可微调，语义不能软）

### Gateway（用户 JWT；`sat_` 可调 runtime 拉目录 / 反代，不能当登录进控制台写操作的替代）

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/auth/setup` `/auth/login` | 建第一个系统管理员、登录。**没有自助注册**——公司由 owner 在 `/platform/orgs` 上开 |
| GET | `/me` | 当前账号、角色；公司账号带公司与访问地址；平台日常/utility 与可用模型 |
| CRUD | `/platform/orgs` `/platform/accounts` `/platform/plans` `/platform/providers` `/platform/settings` | `owner`：公司、用户、套餐、供应商、日常/utility、可用模型、系统级目录 |
| GET | `/platform/accounts/:id` | `owner` 账号详情：`apiKey` / `accessToken`（`owner` 账号均为 null）。列表接口永不带这两项 |
| CRUD | `/orgs/:id` `/orgs/:id/accounts` `/orgs/:id/plan` | 公司管理员：本公司与席位、员工 |
| GET | `/catalog/models` `/catalog/skills` `/catalog/mcp` `/catalog/bots` | 可见的全局 + 本公司（员工只读） |
| CRUD | `/orgs/:id/skills` `/orgs/:id/mcp` | 公司目录，公司 admin |
| GET | `/orgs/:id/bots` | 该公司看得见的**全局** Bot，加上模版改版前留下、已停用的老公司 Bot（只读 / 可删）。员工自建的不在里面 |
| GET/PUT | `/orgs/:id/bot-template` | 公司 Bot 模版。读：公司里所有人（员工建 Bot 那一屏要显示继承了什么）。写：公司 admin，每次保存 `version` 加一 |
| POST | `/orgs/:id/bot-template/redeploy` | admin：把本公司已部署的席位挨个重铺一遍（会断对话）。平时不用——席位自己在盯版本号 |
| CRUD | `/runtime/bots` `/runtime/bots/:id` | 员工自己的 Bot。POST/PATCH **只收身份字段**（名字、头像、简介、开场白、追加提示词），底座一概不收；**POST 建完顺手开装**（后台，回执里带 `deploy: { started }` 或装不成的理由，见第 6 节）；DELETE 通常返回 202，先冻结并完成删除终审，再连席位、会话索引、实例地址和分组引用一起清掉（账本与审计派生物不动）；从未有会话时可在同步写入 `empty` 终审后直接 200。拆不掉的席位留成待清理墓碑 |
| DELETE | `/platform/machines/:id/seats/:seatId` | `owner`：清理一条**没有主人的席位**（Bot 已删、当时没拆掉）。Bot 还在的席位 409——那是「删 Bot」的事 |
| GET | `/orgs/:id/sessions` | 会话索引检索，公司 admin |
| GET | `/orgs/:id/sessions/:sessionId` | **现场**向机器拉全文，Gateway 不存，公司 admin |
| GET | `/orgs/:id/audit` | 公司审计，公司 admin |
| GET/PATCH | `/orgs/:id/conversation-audit-settings` | 对话审计设置；默认 `daily`，公司 admin 可切换 `utility` |
| GET | `/orgs/:id/conversation-audits` `/orgs/:id/conversation-audits/:itemId` `/orgs/:id/conversation-audit-coverage` | 对话审计总结、详情与覆盖水位，公司 admin |
| GET | `/me/stats` | 员工看自己的统计；admin / owner 看各自范围 |
| GET | `/runtime/bots` | Gateway 目录名册，200 即使实例未上线；每条 `runtime` 或 null。`runtime` 里除了部署状态（`status`），还带**席位那台机器的通联状态** `machineLink`（`online` / `stale` / `offline` / `unpaired`，判据与平台机器页那盏灯同一份）与 `machineHeartbeatAge`：`status` 落库之后就不动了，答不了「那台机器现在还在不在」，而对话页抬头那盏灯问的正是后者。界面每 30 秒重拉一次这份名册 |
| GET | `/runtime/bots/:id/session` 等 | 反代到**该 pair**；未部署 503 `实例还没上线` |
| GET | `/runtime/desktop?botId=` | 该 pair 的桌面（noVNC / 密码 / linuxUser / botVersion）。`botId` 必填 |
| POST | `/runtime/deploy` | `{ botId }` 必填。给当前席位部署该 Bot。**同步**：等到机器上装完才回（最长 15 分钟）。建 Bot 那条自动部署走的是同一段代码，只是把「装」丢进后台 |
| GET | `/runtime/deploy/progress?botId=` | 装到哪一步了：`status` / `phase`（`queued` / `installing`）/ `elapsedMs`（**已经装了多久，不是起始时刻**——同 heartbeatAge，界面拿绝对时刻自己减本地时钟会在钟不准的电脑上写出「已经装了 10 分钟」），外加机器上那份细进度 `step`（第几步、这一步在干什么，来自管家 `/seats/:id/progress`，协议 ≥ 3；问不到就是 null）。没有席位行不是 404，回 `status: 'none'`——调用方是个每两秒转一圈的轮询，它要分得清「还没登记」和「问错了」 |
| POST | `/orgs/:id/accounts/:accountId/deploy` | admin：给该账号部署 `{ botId }` |
| GET | `/runtime/catalog?botId=` | 实例拉目录。有 `botId` 时只返回那一颗。响应带 `templateVersion` 与 `stamp`。**只认席位 `sat_`**：这条会带出 MCP 明文 token 与 env，登录 JWT → 401 |
| GET | `/runtime/catalog/version?botId=&have=` | 「变了没有」的探针，只回 `templateVersion` + `stamp`。实例每分钟打一次，指纹没动就一个字节都不再取。`have` 是席位自报的当前模版版本，顺路记成同步状态（见上）。同样只认 `sat_` |
| PUT | `/platform/bot-releases/:version` | **上传**发布包（body 就是 tgz）。CI 用 `GATEWAY_PLATFORM_TOKEN`，人用 `owner` 登录态 |
| POST | `/platform/orgs/:id/runtime/update` | 公司批量把已部署 pair 更新到某版本 |
| POST | `/platform/machines/:id/runtime/update` | `owner`：这台机器上的席位逐个重铺。带 `version`（或默认最新）= **升级**；带 `force` 不带 `version` = **照现状重铺**，每个席位仍用它自己那一版，只是重走一遍部署——用于刷新整份部署期配置。`GATEWAY_URL` 平时会由入站请求自动纠正，不必只为换地址重铺。重铺不打断正在跑的那一轮，忙的席位回 `busy` |
| POST | `/orgs/:id/accounts/:accountId/deploy` | admin/`owner`：给该账号部署 `{ botId }`。带 `force` = 照现状重铺**这一个**席位（机器详情页每行那颗「重新部署」走的就是它，会打断正在跑的那一轮） |

### Gateway（模型代理；API Key `sk_sw_` 或登录 JWT。`sat_` → 401。`x-api-key` 若出现也只当席位 API Key / JWT，不是上游密钥）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/v1/models` | 调用方可见的模型（`owner` 放开的可用集 ∪ 本公司模型条目），无密钥 |
| POST | `/v1/chat/completions` | OpenAI Chat Completions。`stream: true` 时 SSE（`text/event-stream`）。底下是 pi-ai |
| POST | `/v1/responses` | OpenAI Responses API（当前 `/v1/responses`，不是旧 assistants）。可 stream。透传到官方上游 |
| POST | `/v1/messages` | Anthropic Messages API。请求可带 `anthropic-version`；`x-api-key` **不是**上游 key。Gateway 附上平台的 Anthropic 密钥 |

选模型不在可见目录 → 404。该 provider 没有密钥 → 402（或上游不可达 503）。JSON 错误，无 stack。用量记在持有该 API Key / JWT 的用户上。

Bot 配置：`GATEWAY_URL`（例如 `http://127.0.0.1:3080`）+ `GATEWAY_TOKEN`（`sat_`）+ `GATEWAY_API_KEY`（`sk_sw_`）+ `SATUWORK_BOT_ID`。进程里没有 `GATEWAY_MACHINE_TOKEN`，也没有 `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`。

### Gateway（机器服务凭证）

正常装机用一次性配对码换取每台机器自己的 `smt_`（`machines.token`）；环境变量引导票
`GATEWAY_MACHINE_TOKEN` 只保留给 `POST /internal/machines` 的无 UI 兼容/测试路径。`smt_`
之后用于管家心跳、拉包和 Gateway → 管家的控制/反代调用，只留在管家的 `manager.json`；
Bot 的 ready、索引等上报使用 `sat_`，部署绝不把 `smt_` 写入 `bot.env`。

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/platform/orgs/:id/pairing-code` | owner 生成一次性配对码（30 分钟）。响应带可直接粘贴的安装命令 |
| POST | `/machines/pair` | **无登录态**，配对码本身是凭据。签 `smt_`、把地址记成请求来源 IP、立刻回拨 `/health` 验可达 |
| GET | `/install-manager.sh` | 公开。按请求 Host 填好 Gateway 地址的装机脚本 |
| GET | `/manager/release?code=` | 装机脚本下载管家包，凭配对码（不消费它） |
| PUT | `/platform/manager-releases/:version` | 上传管家发布包。和 bot 发布同一套凭证 |
| GET | `/internal/bot-releases/:version` | 管家按版本拉 bot 包。取代了逐席位 scp |
| GET | `/internal/manager-releases/:version` | 管家自升级拉包 |
| GET | `/platform/desktop-ticket?seatId=` | owner 支持入口：替某个席位签一张桌面票。走审计 |
| POST | `/internal/machines` | 引导票登记机器（无 UI 版，e2e/smoke 用）。响应带一次 `token`（`smt_`） |
| POST | `/internal/machines/:id/heartbeat` | 该机器的 `smt_`；票必须对应 `:id`。**也是自升级、时区和日志上限的下发通道**：body 带 `managerVersion`/`protocol`/`arch`/`timezone`（实际时区）/`metrics`/`logs`/`seats`，响应带 `desiredManagerVersion`/`url`/`sha256`/`timezone`（期望时区）/`logCapMb`/`minNode`/`minProtocol` |
| POST | `/internal/instances/:accountId/ready` | Bot 通常带自己的 `sat_`，只能报该账号；兼容管家带 `smt_` 替本机席位上报。body `{ host, botId }`，`botId` 必填；pair 必须已部署 |
| POST | `/internal/sessions/index` | Bot 通常带自己的 `sat_`，只能报该账号；兼容管家带 `smt_` 替本机席位上报。`machineId` 由服务端按席位实际所在机器计算，不采信 body |
| POST | `/channels/telegram/hook/:publicId` | Telegram 推送的 update（webhook 模式，`GATEWAY_TELEGRAM_WEBHOOK_BASE` 或 https 的 `GATEWAY_PUBLIC_URL`）。认 publicId + `X-Telegram-Bot-Api-Secret-Token`，错一样 404；处理同长轮询那条。没有 https 公网地址时仍长轮询，两种模式双向自愈，见 gateway/src/channels/inbound.ts |
| GET | `/worker/routines/due` | 席位工人凭 `smt_` 领**本机**到点的日常任务（含补跑）。领取即租约，见 [routines.md](routines.md) §8b |
| POST | `/worker/routines/:runId/started` | `{ sessionId }`。Gateway 查转人工挡不挡；挡着回 `{ blocked }` 并收场 |
| POST | `/worker/routines/:runId/renew` | 续租。404 = 这一次已不归你（租约被收、或已收场），停手 |
| POST | `/worker/routines/:runId/finish` | `{ kind, error?, sessionId? }`。解释权在 Gateway；别的机器的活一律 404 |
| GET | `/worker/channels/events/due` | 席位工人凭 `smt_` 领本机**还没跑出回复**的渠道事件（协议 ≥ 8）。领取即租约，租约就是事件的 `leaseToken`，随活交给工人 |
| POST | `/worker/channels/events/:eventId/progress` | `{ lease, kind: renew\|typing\|draft\|approval, text?, approval? }`。续租，并替工人跟 Telegram 说一句；草稿的 429 / 不可重试 4xx 原样回给工人的草稿泵 |
| POST | `/worker/channels/events/:eventId/finish` | `{ lease, sessionId, reply, files, handoffs }` 或 `{ lease, error }`。投递与收场只有 Gateway 这一份（`deliverClaimedEvent` / `failClaimedEvent`） |

### 实例（`sat_`；Gateway 经持有 `smt_` 的管家反代，浏览器不直连）

现有 `/api/sessions*` 留下；产品名词是 Bot，主 API 是 `/api/bots*`：

- `POST /api/sessions` 必须带 `botId`
- `GET /api/bots` 返回本进程钉住的那一颗；每条带 `provider` + `model`
- `POST /api/bots` 410：Bot 配置在 Gateway（本机不自建）
- `GET /api/models` 代理 Gateway 目录，不提供「粘贴 API key」
- `POST /api/quiesce` `{ttlMs}` 换版静默：这几秒不开新的一轮（`ttlMs: 0` = 放开）。要
  席位票，只有管家会调，语义见 §3.1a
- `GET /api/health` **不要票**（管家手上只有机器票，而它要靠这条路判断席位起来没有）。
  回 `{ ok, busy, running, queued, quiesced }`——换版前的排空问的就是它，见 §3.1a。`busy` 只看
  `running`（排着的不算，理由同上）。只给计数，不给会话 id 和正文：这条路没有票，能
  少说一句是一句

### 实例（Gateway 拉会话全文；两跳分别验证 `smt_` 与 `sat_`）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/internal/sessions/:sessionId` | 管家先验 Gateway 的 `smt_` 并转发；Bot 再验目标账号的 `sat_`，返回该 JSONL 的事件数组 |

没有服务凭证或 session 不属于本机：404，不泄露是否存在。

---

## 15. 不变量

1. 一个 **pair** 最多一个正在运行的实例
2. 一个进程恰好一个 Bot
3. 一个 pair 的 `$SATUWORK_HOME` 不被另一个 pair 打开
4. 聊天请求的 Host 是 Gateway，不是公司访问地址、也不是实例端口
5. `/v1` 用 API Key 或登录 JWT 认人；`sat_` 不能调 `/v1`
6. Gateway 磁盘上不出现会话事件正文；只允许索引字段和脱敏、限长、不可还原全文的审计派生物
7. 进入模型的内容必须能从**该实例**的 JSONL 重建（现有 session 规则）
8. 全局 / 公司定义只读；改定义只发生在 Gateway，实例下次拉取生效
9. 平台密钥不进浏览器、不进用户 JWT、不进 Bot 环境里的 provider key
10. **Bot 磁盘与环境永不包含 provider API key**（`DEEPSEEK_API_KEY` 等只允许出现在 Gateway）
11. 机器不在线不影响 Gateway 上的索引与审计查看，只影响全文和该 pair 的聊天
12. 上报失败不得丢本地 JSONL，也不得阻断发消息
13. 每个 Bot 有自己的 `provider` + `model`；发消息用这一对
14. 席位按账号计；多部署几个 Bot 不多占席位
15. `linuxUser` 只由 `accountId` 派生；席位靠 `seatId` 区分。同一员工的多个 bot 共用 uid 与 `~/work`，其余（`$SATUWORK_HOME`、Chrome profile、XDG 各目录、`XDG_RUNTIME_DIR`）一律按 `seatId` 隔离
16. Bot 物理删除必须存在已完成的 `pre_delete` 批次；无会话也要有一笔 `empty` 终审

---

## 16. 里程碑（按此拆任务，不要并行铺 25 屏）

**M0 — 规范冻结（本文）**
本文件进仓库。旧文档冲突处加一句指向本文。

**M1 — 本仓库：名册 + 长对话**
- Bot 落 `storage.collection('bots')`，去掉 mock 名册
- 会话根带 `botId`，一 Bot 一长会话
- ~~侧栏是名册，`/a/:id` 是聊天~~ **已取代**：聊天 UI 在 Gateway；实例无头
- 不接 Gateway。单机可跑、可验收（未设 `SATUWORK_BOT_ID` 时可种 `default`）

**M2 — Gateway 骨架**
- 公司、账号、套餐、席位、JWT、JWKS
- 机器登记与访问地址
- 空目录（模型 / Skill / MCP / Bot）能读写，带 scope

**M3 — 开通 + pair 部署**
- ~~买 3 席 → 派机器 → 起 3 个实例~~ **已取代**：买 3 席 → 派机器 → 按 (账号, botId) 部署；3 席 × N 个 Bot = 3N 个进程
- ~~用户登录后跳到公司访问地址~~ **已取代**：登录后留在 Gateway 聊天 UI
- 实例只验账号级 `sat_`；机器级 `smt_` 由管家独立验证，绝不进入席位

**M4 — 目录下发与物化**
- 实例拉全局 + 公司目录；部署时 `?botId=` 只钉一颗
- ~~侧栏可钉官方 / 公司 Bot，可自建~~ **已取代（部署路径）**：名册在 Gateway；部署实例不自建
- ~~公司密钥下发到实例~~ **否**：密钥留在 Gateway，实例只打 `/v1/*`

**M5 — 索引、审计、按需全文**
- 实例上报索引；用量由 Gateway 的 `/v1/*` 代理直接结算，不做第二次上报
- Gateway 检索索引
- 点开向机器拉全文
- 审计事件落地

知识库、业务库、多租户挤机器：M5 之后另开文档，不挤进上述里程碑。

---

## 17. 验收（对着打勾）

**M1**

- ~~刷新后侧栏是人，不是「对话 / 任务 / 配置」抢主位~~ **已取代**：名册在 Gateway UI
- 点一个助理能接着上次聊
- ~~新建助理立刻多一行~~ **已取代（部署路径）**：Bot 定义在 Gateway 目录；部署实例不自建
- `~/.satuwork/sessions/*.jsonl` 根事件有 `botId`
- `/api/bots` 响应不再带 `mock: true`；条目有 `provider` + `model`；部署实例只有钉住的那一颗

**M3**

- ~~3 席公司在一台机器上正好 3 个进程、3 份数据目录~~ **已取代**：3 席 × N 个已部署 Bot = 3N 个进程、3N 份 `$SATUWORK_HOME`，但只有 **3 个 Linux 账号**（一员工一个）
- 账号 A 看不到账号 B 的会话文件；同一账号的不同 Bot 不共用 `$SATUWORK_HOME`，但**共用 `~/work`**——这是有意的
- 未派到本 pair 的票被实例拒绝

**M5**

- Gateway 库里搜不到任何 `user/message` 正文
- 有一条索引能指向机器上的全文，机器关掉则全文失败、索引仍在
- 公司 admin 拉全文会多一条审计

---

## 18. 与旧结论的对照

| 旧说法 | 现在 |
|---|---|
| 单机 4C8G 包办一切 | 控制面 / 运行面拆开；会话仍在运行机器 |
| Agent = 编译成 preset 的配置行 | Agent = 侧栏上的人，有长会话 |
| 会话正文不上 Gateway | **索引**上 Gateway，正文不上 |
| 聊天可走 Gateway 反代 → 不走 | **走**。浏览器只打 Gateway；Gateway 反代到该 pair。公司访问地址不是聊天入口 |
| 一个席位 = 一个账号 = 一个进程；一个进程里多个 Bot | 席位仍按账号计。部署按 pair。一个进程恰好一个 Bot。3 席 × N Bot = 3N 进程 |
| 25 屏产品主路径 | 账号 / 套餐 / 目录 / 聊天名册都在 Gateway；实例无头 |
| 一家公司一个 admin 后台，兼管供应商和日常/utility | 拆成 owner 控制台与公司后台。供应商、可用模型、日常/utility、套餐 SKU、系统级目录只在 owner；公司 admin 管席位/员工/审计/费用/公司目录；员工只看自己的统计 |
| 用户自建 Bot 同步到 Gateway | 不同步；部署实例不自建。Bot 在 Gateway 上由本人建（`/runtime/bots`），只有他自己看得见 |
| 公司这一层是一批共享的 Bot，admin 逐个配 | **已取代**：公司这一层是**一份带版本号的 Bot 模版**，员工在它上面建自己的 Bot；模版一改，全公司跟着走。改版前的公司 Bot 已停用留档，不删（它们名下有席位和会话索引） |
| `/v1` 只收用户 JWT；`x-api-key` 也当 JWT | `/v1` 收 API Key（`sk_sw_`）或登录 JWT。`sat_` 不行。用量记在该用户 |
| ~~`linuxUser` = `bot-` + sha256(`accountId` + `\n` + `botId`) 前 12 hex~~ | **已回退**：`linuxUser` = `sw-` + sha256(`accountId`) 前 12 hex，一员工一个账号；席位改由 `seatId` 区分。老机器上残留的 `bot-*` 账号与单元需人工清理（换前缀就是为了让新旧不互相覆盖） |
| Gateway 用 SSH 部署席位，`machines.sshSecret` 明文存 root 凭据 | **已取代**：机器上常驻 `satuwork-manager`，Gateway 只有可吊销的 `smt_`。ssh* 五列已从库里删除 |
| 每个席位对外开 bot 口 `3200+N` 和 noVNC 口 `6081+N` | 两者都只听 `127.0.0.1`，对外只有管家一个端口；noVNC 走 Gateway 签的短期票 |
| 实例 `ready` 上报的 `host` 决定 Gateway 打哪儿 | **不再采信**（stub 除外）。bot 只听 loopback，自报会把 Gateway 写好的地址覆盖成打不通的 `127.0.0.1` |
| systemd 实例名就是 Linux 用户名（`User=%i`） | 实例名是 `seatId`；`User=` 由部署写的 drop-in 提供。正是 `User=%i` 这条约束当初逼出了「一个 bot 一个账号」 |
