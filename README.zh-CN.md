# Satuwork

[English](README.md) | 简体中文

**给公司用的 AI 员工。** 给公司里的每个人配几个 AI 员工：他们有自己的机器，会用你们已经在用的系统，
拿不准的那一步会停下来等你。交代的方式和交给一个同事一样——说清楚要什么，然后去忙别的。

## 项目介绍

### 两种 AI 员工

- **远程 AI 员工**：跑在公司自己的席位机器（Debian）上，有自己的工作区、终端、浏览器和一块桌面。
  到点自己开工，浏览器关了、人下班了也照常干活。
- **本地 AI 员工**：随桌面端（Windows / macOS）装在你自己的电脑上，直接动你的文件夹，文件不出这台机器。

### 它不只是一个聊天框

- **真的有一台机器**：读写文件、跑命令、开浏览器、上网搜索和取网页、处理 Office 文档、生图。
- **拿不准就停下来**：该人点头的那一步等着你；处理不了的事转进人工待办，由人接手。
- **日常任务**：写清楚指令和时间，到点自动进会话执行，结果记成一条流水。
- **技能与记忆**：公司写好的做事方法挂在 Bot 上（常驻 / 按需两档），Bot 也能把跑通的方法自己记下来；
  跨对话记得住事实（怎么称呼人、报表放哪、客户联系人是谁）。
- **连接公司在用的系统**：连接器走 OAuth，外加 MCP；工具太多时自动退化成「先搜、再看、才调」。
- **渠道**：除了网页和桌面端，也能从 Telegram 直接交代。
- **大事拆小事**：一件子任务可以整个委派给一个干净的子代理，跑完只交回结论，不撑爆主会话的上下文。
- **一本账**：模型（含缓存读写）、连接器、网页搜索按次落账，从「套餐赠送 → 账户余额」实时扣。
- **审计**：公司级操作审计，以及脱敏后的对话审计（任务总结、时间线、评分）——Gateway 不存聊天全文。

### 怎么管

平台 → 公司（租户：套餐、席位、运行机器）→ 账号（一个人）→ Bot（侧栏里的一个 AI 员工）。
模型、Skill、MCP 分**全局**和**公司**两层；公司维护一份带版本号的 **Bot 模版**，员工在它上面建自己的 Bot。
席位按账号计，一个人多开几个 Bot **不**多占席位。

### 怎么搭的

```
浏览器 / 桌面端 ──► Gateway（控制面 + 唯一聊天界面）
                       │  反代聊天流、下发目录、调度、记账
                       ▼
                 机器管家（每台席位机器一个，唯一入站口）
                       │  部署 / 升级
                       ▼
                 Bot 进程（每个「账号 × Bot」一个，无头）
                       │
                       └──► 模型调用经 Gateway 的 /v1，会话全文留在机器上
```

| 目录 | 是什么 |
|---|---|
| [`gateway/`](gateway) | 控制面 + 唯一的聊天界面：账号、公司、目录、计费、审计、调度；把聊天反代到席位；模型调用走它的 `/v1`。Debian 上常驻跑，也有 Vercel + Neon 的函数形态 |
| [`bot/`](bot) | 运行面：无头的 AI 员工运行时（基于 Cordis）。一个进程恰好一个 Bot，按 (账号, botId) 部署，不发界面 |
| [`manager/`](manager) | 机器管家：席位机器上的 root 常驻服务，和 Gateway 配对后负责部署、升级 Bot，对外只开它一个端口 |
| [`desktop/`](desktop) | Tauri 桌面端：界面打在包里，连远程 Gateway，也能在本机跑本地 Bot |
| [`e2e/`](e2e) | 端到端测试 |
| [`docs/`](docs) | 设计文档；总规范是 [docs/gateway-runtime.md](docs/gateway-runtime.md) |
| [`searxng/`](searxng) | 可选的自托管搜索 |

## 起步

```bash
pnpm install
docker compose up -d postgres
cd gateway && pnpm dev
```

开 <http://127.0.0.1:3080>。第一次进去是「创建系统管理员」那一屏，建完就是登录态。

之后 `/` 是**首页**（给还没开通的人看的那一屏，`gateway/ui/pages-landing.js`），登录在 `/login`；
有票的话 `/` 照旧直接是对话 / 概览。桌面壳里没有首页这一步——`/` 就是登录。

`/privacy` 和 `/terms` 是隐私政策与服务条款（`gateway/ui/pages-legal.js`），**不看登录状态**，
首页和登录页的页脚都指过去。里面的落款主体、管辖地和联系邮箱现在是占位的，上线前要换掉
（见那个文件顶上的 `LEGAL_DRAFT`）。

桌面端下载在两个地方，画的是同一张卡（`gateway/ui/pages-landing.js` 的 `dlGrid`）：

- **没登录**：首页上的一段，紧接在「怎么开始」后面（`lpDownload`）。`/#download` 直接落到那一段；
  登录、创建管理员、接受邀请三屏底下也指过去（开新标签页）。
- **登录了**：应用内的 `/download` 一页（`downloadPage`），入口在个人设置里。

老的 `/download` 地址照样交得出界面，进来按登录状态分流：没登录改写成 `/#download`，登录了就是那一页
（`gateway/ui/app.js` 的 `foldDownload`）。桌面壳里两样都不给。卡片按浏览器报的平台自动挑 Windows / macOS，
顶上那排随时能自己切。

文件指的是一个固定的 `desktop-latest` Release，所以发新版不用改页面：桌面端发版 CI 把安装包去掉
版本号（`Satuwork_x64-setup.exe`、`Satuwork_aarch64.dmg`、`Satuwork_x64.dmg`）传上去，而且总是对齐到
现有 `desktop-v*` 里最新的**正式版**（纯 `X.Y.Z`，预发布不算；补发老 tag 不会把它换回旧包）。这几个名字和 `dlBuilds` 是一对，有一条 e2e 盯着。**不用 GitHub 的
`releases/latest`**：几条发布线共用一个 Release 列表，而且都以 `--latest=false` 建 Release，仓库的
「Latest」不跟着哪一条走。

整套跑在容器里：`docker compose up -d`（Gateway + PostgreSQL）。
Bot 不在 compose 里——它由席位机器上的机器管家按 (账号, botId) 部署，不是容器编排出来的。

compose 里还有一个**可选**的自托管 SearXNG，默认不起，要它才点名：
`docker compose --profile searxng up -d`，见 [searxng/README.md](searxng/README.md)。

Gateway 的业务数据在 PostgreSQL；宿主机端口用 **5434**（5432 一般已被别的实例占着）。
`SATUWORK_GATEWAY_HOME` 只放 JWT 密钥对和 Bot 发布包。

## 路线

Gateway 要全面进入 Vercel + Neon：进程里会动的和握长连接的东西按机器下沉到席位工人、按人
下沉到桌面端，Gateway 只剩无状态接口、静态界面和 `/v1`。决定、去向、上线顺序见
[docs/adr-gateway-vercel-neon.md](docs/adr-gateway-vercel-neon.md)。

## 部署到 Vercel + Neon

Gateway 有一个函数形态（`gateway/src/serverless.ts`）：没有监听、定时器、迁移，钥匙来自环境变量，
分钟级扫描由 Cron 打 `/cron/tick`。仓库根目录的 `vercel.json` 就是给它的。环境变量、前提和还没
搬过去的东西见 [docs/vercel-deploy.md](docs/vercel-deploy.md)。Debian 上照旧 `pnpm dev` / compose。

## 桌面端

`desktop/` 是个 Tauri 壳，**界面打在包里**（`gateway/ui` 那批分片原样拷进去，由壳子自己的
`satu://` 协议发出来），壳子记住「连哪台 Gateway」并注入给页面。本地 Bot 的会话不经过 Gateway，
日常任务由 Bot 进程自己领。为什么是这个形状、以及换系统时该先跑哪个自检，见
[desktop/README.md](desktop/README.md)。

## 出包

本地测试包（过一层 Docker 打 Linux 包、传进本地 Gateway）见
[docs/local-release.md](docs/local-release.md)。生产走 CI：推 `bot-v*` / `manager-v*` / `local-bot-v*` /
`desktop-v*` tag。`desktop-v*` 还会顺手刷新首页下载用的 `desktop-latest` Release（见上文）。

## 计费

模型（含缓存读写）、连接器、网页搜索都按次落在一张账本上，实时从「套餐赠送 → 账户
余额」里扣，两个桶都空了就熔断这家公司所有要收钱的调用。口径、账本表、上线顺序见
[docs/billing.md](docs/billing.md)。

升级到带账本的版本之后**立刻**跑一次回填，否则历史花费在余额里不存在。
**先起一次 Gateway**（迁移在进程启动时跑），再回填：

```bash
GATEWAY_DATABASE_URL=... node gateway/scripts/backfill-charges.mjs --dry-run
```

看一眼条数对不对，再去掉 `--dry-run` 真跑。脚本可以重复跑。

## 日常任务

对话右栏里，一个 Bot 可以有几条「到点自己去做的事」：写清楚指令和时间，Gateway 的调度器
到点把它发进那个席位的会话，跑完把结果记成一条流水。浏览器关着也照跑。

模型、时区口径、为什么调度器在 Gateway 而不在席位，见 [docs/routines.md](docs/routines.md)。

## 技能

公司写好的做事方法挂在 Bot 上。以前每一条的正文都全量压在系统提示词里、每一轮都在；
现在分两档：**常驻**的照旧（口径、语气这类每次都要成立的规矩），**按需**的只在提示词里
留一行「名字 + 一句话」，Bot 判断要用时自己 `skill_view` 展开——ZIP 包里的参考资料和
脚本也是这时候才拉到席位上。

跑完一件事，它还可以把方法记下来（`skill_manage`）：只有这颗 Bot 用得上，在 Skill 页面
的「Bot 自己写的」那一栏里看得到、删得掉、也可以一键转成公司 Skill。

分档口径、私有档为什么落在 Gateway、边界与计费见 [docs/skills.md](docs/skills.md)。

## 上下文

一个 Bot 一条长会话，只增不减，而每一轮都把历史重建成一次模型请求。顶到窗口七成就在轮末
把旧的那一段换成摘要——原文一条不删，模型想看还调得回来。

装配路径（提示词、工具表、消息重建、压缩、几处会让它失效的地方）见
[docs/context-assembly.md](docs/context-assembly.md)。

## 记忆

一个 Bot 记得住跨对话的事实：怎么称呼这位员工、报表放在哪儿、这家客户的联系人是谁。
它自己在对话里记（`memory_write`），存在 Gateway，每一轮摆在系统提示词的最末尾。

**记的是事实，不是方法**——一段有步骤的流程走 Skill 那条路（`skill_manage`），
判据是"要不要展开"。四层（这颗 Bot / 这个人 / 分组 / 全公司）里模型只写得了下面两层，
上面两层要管理员在界面上推上去：那两层会逐字进入本公司每个人的提示词。

策略在 Bot 模版里（记哪几类、留多久、每轮摆几条、写前要不要确认、记不记敏感信息），
口径和为什么长这样见 [docs/memory.md](docs/memory.md)。

## 检查

```bash
node e2e/run.mjs          # 全量端到端，要先起 postgres
cd gateway && pnpm typecheck
```

e2e 用的 schema 名和 `/tmp` 目录都按 checkout 路径带后缀（见
[e2e/isolate.mjs](e2e/isolate.mjs)），所以**几个 worktree 可以同时跑**，不会互相清库、
互相删数据目录。剩下一处躲不开的共用资源是端口 3200——它由 Gateway 的槽位公式定死，
同一台机器上两套 manager 用例会撞，撞了那条用例会直说。
