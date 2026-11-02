# 从 dsh-superagent 借什么

对照读的是 DeepSeek 的 [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)
（2026-11-02 的 main）。它是 DeepSeek Harness 的一个 bundle：**盯着一个 GitHub 仓库的主动型编码代理**。
有人在 Issue / PR 或飞书群里 @ 它，它开一张工单，在自己的 Session 和 worktree 里干活，回到原来的
对话交付一个 PR；一个面板只列「要人管的事」。仓库自己说是研究原型，MIT。

代码不大（core + app 约六千行、60 个测试文件），**值钱的是八份按序编号的设计文档和十几份提示词**。
这份笔记只记两样：它想清楚了什么，以及哪几条能落到 satuwork 上、落在哪。
和 [gateway-runtime.md](./gateway-runtime.md) 冲突处以那一份为准；这里不改席位模型、不改计费口径。

---

## 1. 它的骨架

**一条原则统摄一切**：尽量少占人的注意力。由此推出来的五条：只在被点名、或团队写了规则时才动；
只在人必须做事或能用上结果时才说话；一次只问一个具体问题；按影响而不是按工作量决定停在哪；
草稿标草稿、失败报失败。文档、面板、设置项都按「占了多少注意力、换回多少价值」裁。

**领域模型很薄**：

```
Source ──Trigger──► Thread ──批──► Eval（确定性 gate + 模型研判）──► Decision
                      │                                               │ accept
                      └── Subscription 扇出 ──────────────────────► Ticket（带 Mandate）
                                                                      │ Assignment
                                                                      ▼
                                                                   Executor（一单一个 Session + worktree）
```

- Trigger 不可变、按来源 id 幂等，重读安全；接两次只开一张单。
- Mandate 记「谁授权、授权到哪、依据哪个策略版本」，不可变；范围要变就是新单。只有人能撤它。
- Subscription 让后续讨论自动流到工单，不用再 @；但扇出**只给上下文，不给授权**。
- 文档里有一张「否决掉的概念」表：为什么不要「人」这个实体（人只是 Trigger 上的元数据）、
  为什么 Eval 不能等待（会等的条件就是一个 Source）、为什么策略变了不取消正在跑的单（半成品比通知糟）。

**授权由宿主代码强制，消息永远只是数据**：允许名单、@ 还是私聊、三格准入表、bot 永远不能授权。
接单模式 `off / observe / auto`，observe 只记录「本来会接」而不真做，团队看一阵再放开。

**主 Session 只路由，worker 才干活**：路由备注最多 30 字，禁止改写需求、加实施计划；主 Session 从不
sleep、从不等任务，报告和候选以消息形式自己送到，没事就收口。worker 前台命令 5 秒转后台，
任务结束再把它叫醒。并发上限之外永远多一个槽给人的消息。

**交付纪律写进工具而不只写提示词**：reply 工具校验用途（确认 / 回答 / 结果 / 待决）；IM 消息 100 字
硬上限由传输层拒绝；确认只发一次且要点名对象；工作中沉默；PR 开出来不等于就绪；bot 评审最多三轮。

**副作用先落库再执行**：Effects 队列按 kind/key 去重，指数退避，`Later` 表示让位而非失败；Outbox 同一
会话内有序，发送带幂等键，「永远送不到」和「可重试」严格分开；连续失败三次才算系统问题。

**提示词可运维**：团队可改三段（沟通 / 范围 / 交付）并覆盖任何内置段；覆盖记录所依据的默认文本；
升级后默认变了，面板显示「默认已更新」diff，让团队选留自己的还是用新的；每次模型请求读最新版本，
并记录会话用过哪个版本。

**工程纪律**：Engine 全同步、一个命令一个事务；KV 键只能在一处定义且有测试把关；`docs.spec` 校验
架构文档的模块表和测试表齐全、编号文档只能引用前面的；每个类必须有 JSDoc；`SETUP.md` 是写给
coding agent 的装机流程，一次问一件事，秘密不进聊天。

---

## 2. 能落到 satuwork 的十条

按「现在就能落」到「等场景来了再说」排。每条四格：它怎么做、我们现在怎样、借什么、落在哪。

### 2.1 派活的结论带结构化状态

| | |
|---|---|
| 它 | worker 的 Report 是六态枚举 `progress / waiting / ready / blocked / failed / dropped`，另有独立的 `human_action` 字段放**一个**要人拍板的问题；主 Session 原样转给人，不改写 |
| 我们 | [bot-tasks.md](./bot-tasks.md) §1：目标 Bot **最后一条回复**当结论。主 Bot 靠读文本判断对方是做完了、卡住了、还是在等人 |
| 借 | 结论上加 `state` 和可选的 `question`。目标 Bot 卡在要人决定时，主 Bot 把那一个问题原样转给人，或开一张转人工单；而不是转一段话 |
| 落 | [bot/src/tools/assign.ts](../bot/src/tools/assign.ts) 的 result 形状、[bot/src/agent/task-outcome.ts](../bot/src/agent/task-outcome.ts)。先看 task-outcome 现在带不带结构化状态，带了就只是把它透传给主 Bot |

### 2.2 限制由工具和传输层硬卡

| | |
|---|---|
| 它 | reply 工具校验用途；超过 100 字传输层直接拒绝，提示词只负责说「这是上限不是目标」 |
| 我们 | 日常任务结果、Telegram 回复、派活结论的「别啰嗦」大多在提示词里；通知摘要已经按 240 字截（[notifications.md](./notifications.md)） |
| 借 | Telegram 出站和派活结论同样在工具 / 出站层限长并拒绝，而不是指望模型自律 |
| 落 | `gateway/src/channels/draft-pump.ts`、`assign.ts` 的 `RESULT_MAX` |

### 2.3 渠道准入模型，等群聊时直接用

| | |
|---|---|
| 它 | 允许名单 + @ 或私聊 + 三格准入表（名单内未点名 / 名单外点名 / 名单外未点名，各自选 explicit / inferred / ignore）+ bot 永不授权 + observe 先看再放。Source 的策略部分带成员同步 |
| 我们 | Telegram 一个 Bot 配对一个人、只收私聊，授权是隐含的（[telegram-main-bot-guide.zh-CN.md](./telegram-main-bot-guide.zh-CN.md)） |
| 借 | 接飞书群 / 企业微信群 / Telegram 群时，整套口径照抄。尤其 observe：先让 Bot 记录「本来会接这条」，看一周再开 auto |
| 落 | 新渠道的策略表与设置页；现在不动 |

它的 `SourceKind` 接口也是我们把 `gateway/src/channels` 抽成通用渠道插件时的模板：
`schema` + `fields` 自动生成设置表单、`scope`（收不收、观察不观察）、`channel.{allowed,send,link}`、
`threadContext`（给研判读上下文）、`policy.{allowed,rows}`、`health`。加一个渠道就是实现这一个接口，
面板和准入表不用改。

### 2.4 Outbox 三条规则

| | |
|---|---|
| 它 | 发送带幂等键；「对方会话已不存在」记 dropped 永不重发，其它一律退避重试（5 s 翻倍到 300 s）；同一会话内有序，确认一定先于结果；连续失败三次才上升为系统问题 |
| 我们 | 通知投递有租约和领取（[notifications.md](./notifications.md)），文档承认「不能承诺严格恰好一次」；Telegram 出站走 draft-pump |
| 借 | 幂等键把重复压到网络边界那一种；gone / retry 分开后「永远转圈」的消息会消失；同会话有序让「好，我去做」不会晚于「做完了」 |
| 落 | `draft-pump.ts`、`notification_events` 的投递 |

### 2.5 status 四档退出码 + 每小时自检

| | |
|---|---|
| 它 | `status` 退出码：0 正常、1 重启可能修好、2 某部件坏了重启没用、3 等人配置。每小时一条例行任务跑它：1 就 restart，2 / 3 告诉人，0 不出声 |
| 我们 | 机器管家是席位上的 root 常驻服务；没 SSH 时让用户在控制台贴 `/runtime/diag`（见记忆 seat-diag-via-console） |
| 借 | 管家和 Bot 进程各出一个这样的 status；Gateway 的席位状态分「重启一下」和「要人来看」两类，并能一键重启前者 |
| 落 | `manager/`、Gateway 的机器页 |

### 2.6 提示词覆盖记 base，升级时显示 diff

| | |
|---|---|
| 它 | 覆盖记录所依据的默认文本；bundle 升级改了默认，面板标「默认已更新」并把新旧默认和团队文本三者并排，选「留我的」或「用新的」；「完整提示词」视图能看装配结果并和存档比对 |
| 我们 | Bot 模版有版本号；公司在模版上改过的段落，bot 发新版、内置提示词变了之后，静默地叠在一起 |
| 借 | 模版的每段覆盖记它基于的内置版本；bot 升级后在模版页标出来。再加一个「完整提示词」视图，把 [context-assembly.md](./context-assembly.md) 描述的装配结果直接展示，排查和审计都用 |
| 落 | Bot 模版表、模版页、`bot/src/agent/prompt-blocks.ts` |

### 2.7 面板先答「有没有事等我」

| | |
|---|---|
| 它 | 打开先答三个问题：有没有事等我、系统健不健康、某件事的来龙去脉。一张首行匹配的阶段表：等你回答 / 等你审阅 / 卡住 / 排队 / 空闲 / 执行中；标签说「等谁、要什么」而不是内部状态码；数字必须等于它链到的列表长度；健康状态不占地方 |
| 我们 | 侧栏那颗点有三态（含 `review`「在等你」）；概览页按 Bot 列 |
| 借 | 概览把「等你」的会话、转人工单、待审批卡排最前；每行一句「等你做什么」；没事就空着 |
| 落 | `gateway/ui/` 的概览分片 |

### 2.8 给人的消息留一个槽

| | |
|---|---|
| 它 | 并发上限之外永远多一个槽给人的消息；唤醒优先于新启动；CI、bot 的输入只能排普通槽 |
| 我们 | 一个 Bot 一条会话，日常任务和派活都排队、不再插话（[bot-tasks.md](./bot-tasks.md) §7） |
| 借 | 确认人自己发的消息永远排在队列里的自动任务前面；不是就改 |
| 落 | 席位的会话队列 |

### 2.9 终端命令 5 秒转后台

| | |
|---|---|
| 它 | worker 前台命令最多等 5 秒，之后转后台任务，结束再把 Session 叫醒；一轮收口时还有后台任务就保持「执行中」，30 分钟兜底 |
| 我们 | 远程 AI 员工跑一个长命令时，这一轮一直占着，人下一句话要等 |
| 借 | 看 terminal 工具现在是不是同步等到底；是的话值得做同样的事，收益是人随时能插话 |
| 落 | `bot/src/tools/terminal.ts` |

### 2.10 文档和工程纪律

| | |
|---|---|
| 它 | 编号文档只引用前面的，测试校验链接；领域文档放「否决掉的概念」表；架构文档的模块表、测试表由测试保证不漏；KV 键集中定义并有测试；`SETUP.md` 给 coding agent 读 |
| 我们 | docs 已经是 ADR 风格；装 Gateway + 管家是手工配对 |
| 借 | 一条 docs 测试（链接可达、模块表齐全）；设计文档末尾补「否决掉的方案」；写一份给 coding agent 的 `SETUP.md`：一次问一件事、给默认值、秘密走用户自己的终端 |
| 落 | `gateway/test/`、`docs/`、仓库根 |

---

## 3. 不照搬的

- **异步主 Session。** 它的报告以消息回到主 Session 的下一轮，主 Session 没事就收口。我们派活刻意
  选同步（[bot-tasks.md](./bot-tasks.md) §1：主 Bot 要在同一轮里记得自己为什么派），它能异步是因为
  主 Session 本来就不做汇总、只路由。两边各自成立，别混。
- **子代理不提问。** 它的 worker 通过结构化 `human_action` 提问；我们的子代理（[delegation.md](./delegation.md) §3）
  定死不面对人。借 2.1 时只给**派活**加问题字段，子代理照旧把它写进结论。
- **单仓库、单运维、无租户。** worker 以操作系统用户全权限跑，交付物只有 PR，没有席位、公司、账本。
  这些和我们不在一个层面。
- **DSH 特有的东西。** preset、cordis.patch.yml、`orchestrator_*` 工具族。我们的 bot 也基于 Cordis
  （[dsh-capability-map.md](./dsh-capability-map.md)），接口形状可以参考，实现不搬。
