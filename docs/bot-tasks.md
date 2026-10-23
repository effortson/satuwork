# 主 Bot 派活（Bot tasks）

一次派活 = **主 Bot 把一件事交给名单上的另一颗 Bot，那颗 Bot 在自己的席位上做完，把结论
交回主 Bot 的对话，主 Bot 接着处理。**

它和 [delegation.md](./delegation.md) 的子代理委派是两件事，别混：

| | 子代理委派（`delegate_task`） | 派活（`assign_task`，本文） |
|---|---|---|
| 交给谁 | 一个新开的、干净的**自己** | 名单上**另一颗 Bot**（它有自己的人设、Skill、连接、记忆） |
| 跑在哪 | 同一席位的一条子会话 | 对方自己的席位、**对方的主会话**（人在它的对话里看得见这件活） |
| 谁能用 | 每颗 Bot | **只有主 Bot**（docs 里的「主 Bot」，一人一颗，迁移 0057） |
| 同步还是异步 | 同步：工具 `await` 到跑完 | **异步**：工具当场返回「已派出」，结果以一条消息回到主 Bot 的对话，主 Bot 在新的一轮里处理 |
| 价值 | 上下文隔离 | **分工**——销售那颗有 CRM 连接，财务那颗有报表知识库，主 Bot 自己没有 |

前置阅读：[routines.md](./routines.md)（一条不面对人的执行路径怎么走——派活就是沿着它走的）、
[gateway-runtime.md](./gateway-runtime.md)（席位模型）。

---

## 1. 为什么是异步

对方跑在另一台机器、或员工自己的电脑上（本地 Bot）。Gateway 到不了本地 Bot，席位之间也
互不相通——两颗 Bot 之间唯一的路是**各自和 Gateway 之间的那条**。所以一次派活是两段：

```
主 Bot 的席位 ──assign_task──▶ Gateway 记一条 bot_tasks（queued）
                                   │
          目标 Bot 的席位（工人 / 本地 Bot）来领 ──▶ 发进目标 Bot 的会话、等它那一轮收口、
                                   │                 把回复正文回报给 Gateway（reporting）
          主 Bot 的席位（工人 / 本地 Bot）来领 ──▶ 把结论作为一条消息发进主 Bot 的会话（done）
                                   │
                           主 Bot 新的一轮：汇总、追问、再派
```

两段都是「有事来问我」（docs/adr-gateway-vercel-neon.md §2.2）：Gateway 自己不敲任何席位，
只记、只租、只收。领活、租约、回报的接口和日常任务那套**一模一样的形状**，只是多了一格
「回复正文」。

**同步不可行，不是不想。** 主 Bot 的工具调用真的 `await` 在那儿的话，Gateway 得替它把
两跳都打通——而 Gateway 打不进本地 Bot，也不该在 Vercel 上挂着一个 20 分钟的请求。而且
异步在这件事上本来就更对：同事做完了来找你，你不会一直站在他桌边等。

代价也说清楚：**结果落在主 Bot 新的一轮里**。它看得见自己当初派活那一轮的工具调用
（在历史里），但那一轮已经收口了；结论来的时候它要靠对话历史想起「我为什么派」。所以
派出去那一刻，工具回给模型的那段话要让它**先告诉用户已经派出、不要空等**，结果回来时
那条消息要**自带原任务的一句摘要**。

---

## 2. 东西放在哪

| 东西 | 在哪 | 为什么 |
|---|---|---|
| 一次派活的定义、状态、结论 | Gateway 的 `bot_tasks` 表（迁移 0058） | 两颗席位之间的唯一公共点；有库、有租约、有唯一一份状态 |
| 指令落在哪 | **目标 Bot 的主会话**（和日常任务一样） | 人在那颗 Bot 的对话里看得见「主 Bot 派来的任务」和它怎么做的；不另开隐藏会话 |
| 结论落在哪 | **主 Bot 的主会话**，一条带 `task` 身份的用户消息 | 它就是主 Bot 下一轮的起因，和交还、日常任务同一类 |
| 谁能派 | `main_bots`（迁移 0057） | 主 Bot 是**人的视图**：这个账号把哪颗设成主 Bot，哪颗就有 `assign_task` |

归属是 **accountId**：派活的两头都是这个人名下的席位（公司 Bot 装在他的席位上也算他的）。
别人看不见、也动不了（404，不是 403）。

### 2.1 `bot_tasks`

```
id            text pk
accountId     text   -- 谁的
companyId     text
fromBotId     text   -- 主 Bot（派的那颗）
toBotId       text   -- 目标 Bot
fromSessionId text   -- 主 Bot 派活时所在的会话（界面点回去用）
callId        text   -- 派活的那次工具调用
instruction   text   -- 原话
status        text   -- queued | running | reporting | delivering | done | failed
owner         text   -- 这一步该谁来领：机器 id，或本地 Bot 的 desktop:<accountId>
leaseUntil    bigint -- 领走的那一方的租约；null = 还没人领
attempts      int    -- 这一步重领过几次
runSessionId  text   -- 目标 Bot 那边跑在哪条会话
runKind       text   -- 目标那一轮怎么收的场：completed / error / timeout / failed…
result        text   -- 目标 Bot 的回复正文（或失败说明）
error         text
createdAt / startedAt / endedAt / deliveredAt
```

状态只往前走：

```
queued ─(目标席位领走)─▶ running ─(回报)─▶ reporting ─(主席位领走)─▶ delivering ─(发进主会话)─▶ done
   │                        │                                          │
   └── 没人领 / 领走没回报 ──┴──▶ 仍然进 reporting：结论写成「没做成：…」───┴── 送不到 ▶ failed
```

**目标那边砸了也要送回去。** 主 Bot 要知道「财务那颗没做成，因为它的席位掉线了」，它才能
换人或告诉用户；静静地 failed 等于让主 Bot 永远在等一件不会来的事。只有**送不回主 Bot**
那一种才是 failed（主 Bot 的席位也不在了）——那时没有任何一轮能消化它。

### 2.2 谁来领

和日常任务一样按席位分流：

| 目标 / 主 Bot 是 | 这一步的 `owner` | 谁来领 |
|---|---|---|
| 远程 Bot，席位在机器 M 上 | `M` | M 上的工人：`/worker/tasks/*`（机器票 `smt_`） |
| 本地 Bot（桌面端） | `desktop:<accountId>` | 桌面端里那颗 Bot 进程：`/runtime/local-tasks/*`（席位票 `sat_`） |
| 没部署 / 机器太旧 | — | 当场记成「没跑起来」，直接进 reporting（或 failed） |

机器要 ≥ `MIN_TASK_WORKER_PROTOCOL`（12）：旧工人没有这条循环，领不走。派出去那一刻就判，
别让一条任务在 queued 里等到天荒地老。

租约、续命、到期清扫全部照抄日常任务（`ROUTINE_LEASE_MS`、`RUN_TIMEOUT_MS`）。到期没回报
的那一步：`attempts < 3` 就放回去等人再领（`leaseUntil = null`），否则按上面那张图走。

---

## 3. 只有主 Bot 能派

三道门，每一道单独成立：

1. **工具表。** `assign_task` 只在目录下发了 `assignable`（可派的 Bot 名单）时进工具表，
   而 Gateway 只给**这个账号的主 Bot** 下发那份名单。换主 Bot 的那一刻目录指纹变，席位下一次
   探针就把工具换掉（和知识库那把一个机制）。
2. **接口。** `POST /runtime/tasks` 用席位票，body 里带 `fromBotId`；Gateway 查
   `main_bots`，不是这个账号的主 Bot 一律 403。席位票只认账号，一个账号的几颗席位是同一个人
   的，互相冒名没有意义。
3. **目标。** `toBotId` 得在 `botsFor(account)` 里、不能是自己、不能是另一个正在等它的
   派活的发起方（A 派给 B、B 再派给 A 转圈）。目标 Bot 不是主 Bot，所以它**没有** `assign_task`，
   派活天然只有一层。

目标 Bot 那边**不加任何限制**：它收到的就是一条带身份的用户消息，照自己的边界（审批、外发
闸、PII 闸）跑。主 Bot 派它发一封邮件，拦不拦在它那次发信上，不在「被派」这件事上。

---

## 4. 两条消息长什么样

**发进目标 Bot 的**（run 那一步）：

```
【主 Bot「我的助手」派来的任务】
<instruction 原文>

（做完把结果直接写在回复里，回复会原样交回主 Bot；需要人拍板的事写进结论，不要在这儿等。）
```

`source: { kind: 'plugin', plugin: 'task', form: <taskId>, phase: 'instruction', from: { id, name } }`

**发进主 Bot 的**（deliver 那一步）：

```
【任务结果】@财务 做完了（任务：<instruction 前 60 字>）
<result 原文>
```

没做成的：

```
【任务结果】@财务 没做成：<原因>（任务：<instruction 前 60 字>）
```

`source: { kind: 'plugin', plugin: 'task', form: <taskId>, phase: 'result', from: { id, name } }`

两条都走席位的 `/api/sessions/:id/messages`，多一个 `task` 字段，老席位不认就当普通消息
（正文自带的那行标题已经说清楚了来龙去脉——身份字段只是让界面画角标）。

界面：`via` 多两档，`task`（目标那边：「主 Bot 派来的任务」）和 `task-result`（主这边：
「任务结果」），和日常任务 / 看板 / 交还同一套角标。

---

## 5. 主 Bot 怎么知道能派给谁

目录（`/runtime/catalog`）多一格：

```jsonc
"assignable": [{ "id": "…", "name": "财务", "desc": "做报表、对账" }]
```

只有主 Bot 的目录里有。席位把它放进两处：

- `assign_task` 的参数 `bot` 按**名字**选（模型看名字），工具内部按目录解析成 id；对不上
  就把名单回给它。
- 系统提示词多一段「你是主 Bot，可以把活派给：…」，说清**派出去就先回复用户、结果会以
  「任务结果」消息回来**——不写这一句，模型会在派完之后反复问用户「要不要等」。

名单变了（新建、删掉、改名、换主 Bot）指纹跟着变，席位一分钟内换过来。

---

## 6. 契约

### 6.1 `assign_task`

```
assign_task({ bot: string, instruction: string })
```

- `bot`：名单上的名字（也认 id）。
- `instruction`：交给对方的原话，**要自足**——对方看不见主 Bot 的对话，没有上下文。工具描述
  里要把这句话说给模型听。

回给模型：

```
已派给 @财务（任务 t-xxxx）。它做完会把结果以「任务结果」消息发回这条对话，到时候你再处理。
现在先告诉用户已经派出去了，不要在这儿等。
```

### 6.2 Gateway

| 接口 | 谁 | 做什么 |
|---|---|---|
| `POST /runtime/tasks` | 席位票（主 Bot） | 建一条；返回 `{ task }`。403 不是主 Bot，404 目标不在名单，400 空指令 / 派给自己 |
| `GET /runtime/tasks?sessionId=` | 登录票 | 这条会话派出去的那些（界面要画状态时用） |
| `GET /worker/tasks/due` | 机器票 | 领本机席位上的活：run 和 deliver 两种 |
| `POST /worker/tasks/:id/started` | 机器票 | `{ sessionId }`；转人工挡着就 `blocked` |
| `POST /worker/tasks/:id/renew` | 机器票 | 续租 |
| `POST /worker/tasks/:id/finish` | 机器票 | run：`{ kind, result?, error?, sessionId? }`；deliver：`{ kind }` |
| `/runtime/local-tasks/*` | 席位票（本地 Bot） | 同上四条，owner = `desktop:<accountId>` |

交给工人的一条活：

```jsonc
{ "taskId": "…", "phase": "run" | "deliver",
  "botId": "…",            // 这一步要敲哪颗 Bot 的会话（run = 目标，deliver = 主）
  "seatId": "…",
  "instruction": "…",      // run：发给目标的全文；deliver：发给主 Bot 的全文
  "task": { "id", "phase", "from": { "id", "name" } },   // 原样塞进 /messages 的 task 字段
  "leaseMs": 60000, "timeoutMs": 1200000 }
```

工人 run 那一步和日常任务一字不差，只多一件事：**把自己那一轮的 `assistant/message` 正文
收起来**，`finish` 时带上。deliver 那一步只发消息、不等收口（主 Bot 那一轮是它自己的事，
等它只是占着租约）。

---

## 7. 不做的

- **不做二层派活。** 目标 Bot 没有 `assign_task`。主 Bot 要串三件事，就派三次。
- **不做「派给多个」。** 一次一颗。要并行就连调几次工具，模型自己会。
- **不做进度。** 目标 Bot 跑着的那几分钟主 Bot 看不见进度，只等结论。人想看，去目标 Bot 的
  对话里看——它就在那儿跑着。
- **不做撤回。** 派出去就派出去了。目标 Bot 的那一轮可以在它的对话里按停止。
- **不做跨账号。** 派活不出这个人的名单。
