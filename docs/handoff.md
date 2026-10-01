# 转人工（Handoff）

一次转人工 = **一件事从 Bot 手上交到人手上，再交回来**。它不是一句提示词，也不是一条日志。

**人不在屏幕前的时候，这条路也得成立。** 这一句决定了下面几乎所有的取舍——真正会
出事的不是「员工正看着对话、Bot 说了句我搞不定」，是[日常任务](./routines.md)：浏览器
关着、到点自己跑、转人工开出来的单子没有任何人会看见。

本文和 [gateway-runtime.md](./gateway-runtime.md) 冲突处以那一份为准；本文在它的席位模型、
会话事件、审计口径上**加一类东西**。

**这份不再是提案，是已经落地的东西的说明书**（代码位置见 §13，验收见 §15）。

---

## 1. 原来缺的是什么

`escalate_to_human`（[bot/src/policy/index.ts](../bot/src/policy/index.ts)）在这之前只做一件事：**记账**。

| 原来就有的 | 原来缺的 |
|---|---|
| 它是一把**真工具**，不是提示词里的一句话，调用会留痕 | 留的痕没有**状态**：没有「等谁」「谁接了」「接完了没有」 |
| 一条 `tool/policy`（`guard: 'escalate'`）进会话日志 | 没有**归属**：席位只认得自己那个账号，交给别人这件事表达不出来 |
| 经 `POST /internal/guard-events` 落成审计行 `bot.guard.escalated` | 审计是「上个月拦了几次」的账，不是待办清单——没有人会去审计里找活干 |
| 连着被边界挡 3 次会自动改口劝转人工（`ESCALATE_AFTER`） | 没有**出口**：人做完了，没有任何一条路把结果交还给 Bot |
| 侧栏那颗点已经有第三态 `review`（"在等你"），由 `tool/approval` 驱动 | 转人工不进这个态。日常任务里开的单子，界面上一点痕迹都没有 |

所以模型调完它、说一句「已记录，等待人工接手」，然后 `turn/end`，会话变 idle——**那句话
是对的，只是没有任何人被等着**。下面这一整套要修的就是最后半句。

---

## 2. 为什么不直接复用高风险确认

[bot/src/policy/approvals.ts](../bot/src/policy/approvals.ts) 已经是一条真的人在环回路：调用**停在席位上**等人点，
卡片能从日志重建，超时按拒绝收口。形状要抄，东西不能塞进去——两者的时间尺度不一样：

| | 高风险确认 | 转人工交接 |
|---|---|---|
| 等多久 | 秒到分钟（默认 5 分钟超时） | 分钟到天 |
| 在哪一轮 | **同一轮**，工具真的 `await` 在那儿 | 跨轮。原来那一轮早收口了 |
| 存在哪 | 纯内存 `Map`，重启即丢（丢的方向是"多问一次"，安全） | **必须落盘**。席位重装是常事，单子不能跟着没 |
| 谁来点 | 就是正在对话的那个人 | 可能是管理员、可能是别的同事，可能根本没打开这颗 Bot |
| 丢了会怎样 | 那次调用不执行 | 那件事没人做，而且没人知道它没人做 |

把交接塞进 `ApprovalGate`，等于让一个 `await` 挂几个小时：那一轮一直开着、上下文一直占着、
进程一重启就全丢，而重启是升级换版的日常。

所以：**交接是一个独立的、有状态的、落盘的对象；escalate 这把工具本身仍然立即返回。**

---

## 3. 交接单

```
open ──claim──> claimed ──return──> returned ──(Bot 答完这一轮)──> closed
 │                  │                   │
 │                  └──return(closed)───┴────────────────────────> closed
 ├──超时 T2────> expired
 └──cancel────> cancelled
```

- `open` 开出来了，没人接
- `claimed` 有人认领了（认领是显式动作，人在对话里说句话不算）
- `returned` 人处理完交回来了，等 Bot 消化
- `closed` 这件事完了（Bot 答完那一轮，或者人直接结案）
- `expired` 超时没人接。**必须有这一态**，否则和今天一样悬着
- `cancelled` 人主动撤销，或者会话被删

东西放三处，各有各的理由：

| 东西 | 在哪 | 为什么 |
|---|---|---|
| 事实源 | 席位会话 JSONL 的新事件 `human/handoff` | 照 `tool/approval` 的写法：同一个 id 多条，取最后一条。刷新页面、换标签页、断线重连之后卡片能重建 |
| 未闭合的单子 | 席位 `ctx.storage` 的 `handoffs` 集合 | 日志是追加式的，重启后要知道「哪几张还开着」不能靠回放整条会话。确认那一套是纯内存的，交接不能是 |
| 索引与待办 | Gateway 的 `handoffs` 表 | 待办要跨 Bot、跨机器、要指派给不是这颗 Bot 主人的人。一台席位只知道自己的事 |

**正文不上 Gateway。** 和会话索引同一条口径（gateway-runtime.md §10）：Gateway 存的是
「有这么一张单、归谁、什么状态」，`reason` / `ask` / `summary` 各留一段供列表显示，
全文点进去时从席位拉。

---

## 4. 事件与工具

### 4.1 `human/handoff`

```ts
'human/handoff': {
  /** 单号。同一张单会来多条，界面按它认，取最后一条。 */
  id: string
  /** 开这张单的那次工具调用。和 tool/policy 那条对得上。 */
  callId: string
  state: 'open' | 'claimed' | 'returned' | 'closed' | 'expired' | 'cancelled'
  /** 为什么要人接。一句话。 */
  reason: string
  /** 要人做什么。一句祈使句——接手页面上最大的那行字。 */
  ask: string
  /** 已经做到哪一步、卡在什么地方。接手的人靠它不用从头问一遍。 */
  summary?: string
  /** 人不处理，这件事是不是就停在这儿。决定要不要抑制后续定时轮。 */
  blocking: boolean
  /** 同一件事被合并进来几次（模型换个措辞又撞了一次）。 */
  repeats?: number
  /** 谁接的（accountId + 显示名）。open 态没有。 */
  claimedBy?: { accountId: string; name: string }
  /** 交还时人给的结论。 */
  result?: { disposition: 'done' | 'instructions' | 'closed'; text: string }
  at: number
}
```

加一种事件**不是破坏性变更**（同 `session/compact`、`tool/policy` 的理由：老版本读到不认识
的 type 会跳过），所以不动 `SESSION_FORMAT_VERSION`。

`tool/policy`（`guard: 'escalate'`）那条**照旧写**，别合并。两条回答的是两个问题：那一条是
留档（这次表态是什么），这一条是待办（这件事现在到哪儿了）。审计那一屏在用前者。

### 4.2 工具参数要扩

现在只有 `reason` / `summary`，接手的人拿到手还得猜要干嘛。

| 参数 | 必填 | 说明 |
|---|---|---|
| `reason` | 是 | 为什么需要人。已有 |
| `ask` | **是** | 要人**做什么**。没有它，一张单就是一句抱怨——人打开之后第一件事是回来问 Bot「所以你要我干嘛」，而 Bot 那时已经停了 |
| `summary` | 否 | 做到哪一步、卡在哪。已有 |
| `blocking` | 否，默认 `true` | 人不处理是不是就停在这儿 |

**没有「什么时候之前要处理完」这一格。** 催办是固定两档（§6 的 `T1` / `T2`），一个模型
自己填的截止时间只会变成又一处要在界面上显示、又没人拿它做决定的字段——真要按事情的
轻重缓急分档，那是模版上的配置，不是模型每次现编的一个数。

**这把工具单独一个 `ctx.inject`，不和拦截共用一个。** 它要交接单那个服务，而拦截只要
`policy`；写在同一个 inject 里的话，交接单没起来 = 整条 `tools/pre-execute` 不注册，
三条行为边界一起静默消失——工具照跑、日志干净、类型检查也过，正是这一层最怕的坏法。
反过来的降级是安全的：没有交接单时这把工具压根不注册，而提示词里那段「什么时候转人工」
本来就看 `tools.has('escalate_to_human')`，两边一致。

工具自己仍然 `risk: ['read']`，**不能被任何一条边界挡住**——模型撞墙之后连唯一的出口也
没有了，是今天这套设计里最不该出现的死局。返回给模型的话也要改：现在那句「已经记下」
要变成「单号 X 已经开出来，交给了 Y，你现在停下来」——**带上单号和接手人**，因为模型
接下来那句总结是人在对话里唯一会读到的东西。

---

## 5. 谁接

模版上加一格 `escalateTo`，和现有那段自由文本 `escalate` 并排（[bot/src/registry/index.ts](../bot/src/registry/index.ts)、
[bot/src/catalog/index.ts](../bot/src/catalog/index.ts)、Bot 模版那一页）：

| 取值 | 指给谁 |
|---|---|
| `owner`（默认） | 这颗 Bot 的归属员工 |
| `admin` | 公司管理员（全体，谁先接算谁的） |
| `member:<accountId>` | 指定的某个人 |

**这个字段根本不下发到席位。** 席位只认得自己那一个 accountId，而"该谁处理"要读公司模版
和成员表——两样都在 Gateway。所以报单那一刻由 Gateway 现读一次模版，翻成 `assignee`
（`resolveAssignee`，见 [gateway/src/lib/handoff.ts](../gateway/src/lib/handoff.ts)）。席位那边一个字都不用知道。

`assignee` 为 `null` 的意思是**全体管理员**，不是"没人管"：模版写 `admin` 是这一档，
指定的那个人离职、被停用、换了公司也落到这一档。丢给管理员总好过丢给一个已经不在的人
——后者的表现是一张永远没人看的单，而它长得和正常的一模一样。

**已经在册的单子不重算指派**：人都接手了，模版这时候改了也不该把它从他手上挪走。

谁能接：被指派人 + 本公司 `admin`（`canActOn`）。**抢单的 CAS 在席位那一个进程里**——
一条会话只有一台席位，那就是唯一的权威。Gateway 这边不再判一次：两边各判一次的话，
两个人在两个标签页里各点一次，一边说"你接到了"、另一边说"他接到了"，而单子只有一张。
抢不到的那个拿到的是 409 加一句"已经由张三接手"，和 `approvals.decide()` 返回 `'gone'`
是同一套口径：**"我接到了"和"这条早就不在了"对人是完全不同的两句话**。

---

## 6. 通知

分三层，按**人在不在场**。少任何一层，都有一整类场景通知不到。

| 层 | 场景 | 怎么做 |
|---|---|---|
| 1 | 人就在这一屏 | 会话里画一张卡（复用确认卡的样式）。SSE 已经通了，不用新东西 |
| 2 | 人在别的屏 | 侧栏那颗点的第三态 `review` 判据扩成「也看未闭合的 handoff」；顶栏一个待办计数 + 一页清单 |
| 3 | 人不在场（浏览器关着，日常任务那条路） | **公司级 webhook**：飞书 / 企微 / Slack 机器人 URL，配在公司设置里，Gateway 发 |

**第 2 层后来把高风险确认也收了进来。** §2 说的仍然成立——确认不是交接单，它停在席位
内存里、5 分钟就超时收口、席位一重启就没了，**不进 Gateway 那张表**。但那一段说的是
「东西存在哪」，不是「人在哪儿看得见它」：一个被确认卡住的 Bot，在待办这一侧原先一点
痕迹都没有，而人正好在别的屏——那恰恰是这一层存在的理由。所以：

- 侧栏名单上，那颗琥珀点旁边多一个**图标**：拍板是盾牌、接手是那只举起来的手
  （`shell.js` 的 `botNeedIcon`）。一颗 8px 的点说不出「你得去点一下」，而确认那一路
  是真的有一轮停在席位上等着
- 顶栏那个数是**两样之和**：开着的单 + 等着拍板的确认（`needCount`）。
- 待办页最上面多一段「等你拍板」，标清楚它是当场的、会过期的，入口是回到那颗 Bot 的
  对话（`pages-handoffs.js` 的 `approvalWaitPanel`）

这一段的数据源是**浏览器里那几条流**（`chat.js` 的 `pendingApprovals`），不是 Gateway
——这件事压根没上过 Gateway。代价说清楚：**只看得见自己名下的 Bot**，管理员在这一段里
看不到别人的确认。那是对的，别人的确认只有别人点得动。

第 2 层有个细节：现在的 SSE 是 **per-session** 的（`chat.js` 给名单上每颗 Bot 各挂一条流），
而管理员对别人 Bot 的单子没有流。**先做 30 秒轮询**，别为这个先造一条账号级的流——那是
一条要在 Gateway 上长期维护的连接，为一个还没人用的页面开它不划算。轮询有一条规矩照抄
日常任务详情页：**没有未闭合的单子就把定时器停掉**，不然一个开着的标签页会永远每 30 秒
一个请求。

第 3 层为什么是 webhook：

- **不做邮件**。Gateway 现在没有 SMTP。为它加一套投递重试 + 退信处理，是为了一个"通知"
  再养一个子系统
- **不用连接器**。[连接器绑账号不绑 Bot](./connectors.md)——员工自己装的 Gmail 只能以他自己
  的身份发，而收件人恰恰常常不是他
- webhook 是**一条 URL + 一个 POST**，发失败只记一笔、不影响单子本身——那张单已经开出来
  了，站内照样看得见。它够到的正是"没人开着浏览器"那个场景，而那是这一层存在的全部理由

配置落在 **`companies.handoffWebhook`**（迁移 0015），不塞进 `settings` 那份 payload：
那份是「日常 / utility 模型」两个角色，`putSettings` 整份覆盖写，塞一个不相干的字段进去，
下次谁改模型就会把它清掉。

**只收 https**：这条 URL 是一把凭据（拿到就能往那个群里发东西），走明文等于交给路上的
每一跳。三家群机器人的字段一次发全（飞书 `msg_type`/`content`、企微 `msgtype`/`text`、
Slack `text`），各家只认自己那一份——比让人先在界面上选一家省事，而选错的代价是一条谁也
收不到的通知。

**催办与升级**（没有这一段，`expired` 就永远到不了）：

- `open` 超过 `T1`（`GATEWAY_HANDOFF_NUDGE_MS`，默认 30 分钟）：再推一次
- 超过 `T2`（`GATEWAY_HANDOFF_EXPIRE_MS`，默认 24 小时）：单子转 `expired`，
  **并且回头告诉 Bot**——Gateway 打席位的 `/expire`，席位按一次交还处理，起一轮告诉模型
  别再等了。少了最后半句，这张单就和原来那条日志一样悬着
- **第二档 `open` 和 `claimed` 都收。** 只扫 `open` 的话，一张被人点过「我来接手」然后
  再没动静的单子既不会被催、也不会转 `expired`：它永远停在 `claimed`，而 blocking 的
  那些会让这颗 Bot 的日常任务**天天被跳过**（§8 那条抑制），模型也永远等不到那句话。
  不变量 2 缺的就是这一半
- **接过手和没人接，给模型的措辞要分开**（`expiredMessage`）：前者人已经在做了、只是
  没回话，说成「没人管」的话，模型多半会把同事正做着的事再做一遍
- 两档都用**带旧值的 CAS** 记账（`notifyStep` 0 → 1 → 2）：升级换版那几十秒里新旧两代
  进程都会扫到同一张单，没有这一句，同一条催办会推两遍——而催办本身就是打扰人的东西
- 席位不在线时（机器关着的整夜正是没人接手的一半原因）**退回上一档下轮重来**，不是就此
  放过：这张单的最终态必须落下，而唯一能把那句话说给模型听的地方就是那台席位
- 扫描挂在已有的调度器 tick 上（`GATEWAY_ROUTINE_TICK_MS` 那一轮），不新起定时器

---

## 7. 交还

**交还是一次带结构的输入，不是一句聊天。**

`POST /runtime/handoffs/:id/return { disposition, text }`：

| disposition | 意思 | Bot 那边发生什么 |
|---|---|---|
| `done` | 人做完了，接着往下 | 写 `returned` 事件，**起新一轮**，把人做了什么喂进去 |
| `instructions` | 人做不了 / 要换个做法 | 同上，正文是指示 |
| `closed` | 这件事到此为止 | 只写事件，**不叫醒 Bot**。它下次读历史时看得到 |

喂进去的那条消息带 `source = { kind: 'plugin', plugin: 'handoff', form: <单号> }`——
[MessageSource](../bot/src/session/types.ts) 已经是这个形状，不用动格式版本。正文是拼好的一段：谁、什么时候、
做了什么、结论是什么、你接着做什么。

**为什么必须是新一轮，而不是"接回原来那一轮"**：原轮早就收口了（工具返回 → 模型收尾 →
`turn/end`）；中间可能过了一天、重启过、上下文还压缩过（`session/compact`）。把交还做成
一次显式输入，在日志里是一条能重放的因果；试图恢复旧轮则是一条随时间衰减的路径，而它
恰恰只在"隔了很久"的时候才会被用到。

**谁能交还，怎么到得了席位**：被指派人自己在界面上点，走的是现成的 `/runtime` 反代那条路。
管理员接的是别人名下的 Bot——那颗 Bot 在别人的席位上，浏览器够不着，所以这一跳由 Gateway
代发，复用日常任务那条路（`lib/runtime.ts` 的 `seatBearer` + `machineTokenFor`）。发进去的
就是一条普通消息，走 `/api/sessions/:id/messages`，所以**计费、审批、工具全都和人自己发的
一样**（同 routines.md §3）。

那一轮答完，单子转 `closed`。

---

## 8. 等着的时候，规矩是什么

这一块决定了这个功能会不会变成一台刷屏机器。

- **别让定时任务反复开同一张单。** 会话上有未闭合且 `blocking` 的单子时，routine 触发的
  那一轮**跳过**，在 `routine_runs` 上记一条「等人处理中」。不拦的话，一件卡住的事会每小时
  重跑一遍、每小时开一张新单、每小时推一次通知
- **去重。** 同一 sessionId、同一工具、同一 `reason` 指纹，5 分钟内只开一张，后面的合并进
  已有那张（次数 +1）
- **人在对话里说了句话不算接手。** 他可能只是问一句。要显式点「我来接手」。但卡片上给一颗
  **「就在这儿处理」**——点了直接把这条会话置成 `claimed`，因为绝大多数情况下人就在这儿
- **停止按钮不撤单。** 点停止是掐掉这一轮，不是"这件事不用人管了"。撤单是单子上的另一颗按钮

---

## 9. 接口契约

### Gateway（用户 JWT）

```
GET    /runtime/handoffs[?scope=mine][&state=all]   我看得见的单子（跨 Bot）+ 顶栏计数 + 30 天概览
GET    /runtime/handoffs/:id                        一张单：索引那一份 + `detail`（现去席位拉的正文）
POST   /runtime/handoffs/:id/claim                  我来接。抢不到回 409 + 谁接走了
POST   /runtime/handoffs/:id/return                 交还 { disposition, text }
POST   /runtime/handoffs/:id/cancel                 撤销
GET    /runtime/sessions/:id/handoffs               这条会话上还开着的那几张（反代到席位）
```

**接手 / 交还按单号走，不按会话走。** 那几条会话路由的鉴权判据是「这条会话是不是你的」，
而交接的全部意义就是接手的人可能不是这颗 Bot 的主人——`seatTargetForSession` 在那时会把
他挡在外面，而他恰恰是该来处理这件事的人。所以这一组的判据换成 `canActOn`（同一家公司 +
被指派 / 已接手 / 是主人 / 是管理员），席位地址按单子上记着的 `accountId + botId` 取
（`seatOf`），不按当前登录的人取。

### Gateway（机器 / 席位票，`/internal`）

```
POST   /internal/handoffs                        席位报一张单或一次状态流转（upsert）
```

和 `/internal/sessions/index`、`/internal/guard-events` 同一套 `requireInternalCaller` 口径：
席位票只能报自己那个账号，管家的机器票能替本机任意席位报。`assignee` 和 `machineId`
**服务端算**，不收 body（同会话索引那条的理由）。

### 席位（Gateway 反代 / 服务凭证）

```
GET    /api/sessions/:id/handoffs                 还开着的那几张（界面拿它核对，见 §11）
POST   /api/sessions/:id/handoffs/:hid/claim      置 claimed。要 actor，没有回 400
POST   /api/sessions/:id/handoffs/:hid/return     置 returned，并按 disposition 决定要不要起新一轮
POST   /api/sessions/:id/handoffs/:hid/cancel     撤销，不叫醒 Bot
POST   /api/sessions/:id/handoffs/:hid/expire     超时收单 + 告诉模型没人接。**只有 Gateway 调**
```

**`actor`（谁在操作）由 Gateway 填**：席位只认得自己那一个账号，而接手的人可能是管理员。
认不出就不写——日志上宁可少一个名字，也不要写一个编出来的。

**席位自己不看表**：`expire` 由 Gateway 那边的扫描触发。机器可能整夜关着，而那正是没人
接手的一半原因。

---

## 10. 库

新迁移 `0014-handoffs`（编号迁移，见 [gateway/src/db/migrate.ts](../gateway/src/db/migrate.ts)，**不要回去改老的那几条**）：

```sql
create table if not exists handoffs (
  id           text primary key,
  "sessionId"  text not null,
  "botId"      text not null,
  -- 这颗 Bot 归谁。**不是**接手人：交接的意义正在于这两者可以不是同一个人。
  "accountId"  text not null references accounts(id) on delete cascade,
  "companyId"  text not null references companies(id) on delete cascade,
  -- 拉全文、发交还都要敲这台机器。服务端算出来的，不收上报方指定。
  "machineId"  text,
  state        text not null check (state in ('open','claimed','returned','closed','expired','cancelled')),
  -- 指派解算之后的结果。**null = 全体管理员**
  assignee     text references accounts(id) on delete set null,
  -- 谁真的接了。抢单的 CAS 在席位那一个进程里，这边只跟着记
  "claimedBy"  text references accounts(id) on delete set null,
  blocking     boolean not null default true,
  repeats      integer not null default 0,
  -- 各留一段给列表显示（各截 500 字），全文在席位
  reason       text not null default '',
  ask          text not null default '',
  -- 催办推到第几档：0 没推过，1 推过一次，2 已收单。重启之后不会从头再推一遍
  "notifyStep" integer not null default 0,
  "createdAt"  bigint not null,
  "claimedAt"  bigint,
  "returnedAt" bigint,
  "closedAt"   bigint,
  "updatedAt"  bigint not null
);
-- 待办页和催办扫描
create index if not exists handoff_live on handoffs ("companyId", state) where state in ('open','claimed','returned');
-- 会话里那张卡、以及「这条会话上还有没有挡路的单子」
create index if not exists handoff_of_session on handoffs ("sessionId", "createdAt" desc);
-- 顶栏那个计数
create index if not exists handoff_assignee on handoffs (assignee, state);
```

**upsert 按 `updatedAt` 收**（`where excluded."updatedAt" >= handoffs."updatedAt"`）：同一次
流转会从两条路过来——人点完那一下 Gateway 顺手写一次（让他刷新时立刻看到），席位的 outbox
再异步报一次。两条殊途同归，晚到的那条不会把新的盖回旧的。

**更新那一支还认账号和公司**（`handoffs."accountId" = excluded."accountId"`）：单号是席位
给的，一把席位票只代表一个账号，但它报上来的 id 可以是任何字符串。不带这一条的话，一台被
拿下的席位只要报一个已经存在的单号，就能改掉别人（甚至别家公司）那张单的状态。UUID 猜不
出来不是理由——那是"难以利用"，不是"拦住了"。

公司的通知地址是 `companies.handoffWebhook`（迁移 `0015-handoff-webhook`），理由见 §6。

---

## 11. 界面

| 在哪 | 什么 | 落在哪儿 |
|---|---|---|
| 会话里 | 一张交接卡：要做什么、为什么、谁接的、一个写结论的框；按钮「处理完了，交还 / 我来接手 / 换个做法 / 不用处理了」 | `chat.js` 的 `handoffHtml`，骨架复用 `.sw-approval` 那套样式 |
| 侧栏 | 那颗点的第三态 `review`：**在等人 > 正在跑 > 空闲** | `chat.js` 的 `settleDot`（确认和交接各记一份，重算而不是按最后一条事件写） |
| 顶栏 | 待办计数（角标压在图标右上角，为 0 时不出现）。**对话页上**它是右栏的一屏（和工作区文件、运行环境并列），点开不离开对话；别的页没有右栏，照旧跳 `/handoffs` | 对话页：`render.js` 的 `asideToggle` + `pages-handoffs.js` 的 `handoffsAside`；别的页：`handoffBell` |
| 新一页 | `/handoffs`：30 天概览 + 清单（全部 / 要我处理的）+ 就地处理的卡 | 新分片 `pages-handoffs.js`——**加分片要同步改 `index.html` 和 `http.ts` 的 `UI_PARTS`** |

几条要点：

- 卡片跟 `tool/approval` 一样**只画还开着的那些**，闭合的收成一行灰字——一件办完的事再占
  半屏输入框，往上翻这一轮对话会被几张作废的卡挡住
- 卡片重画的签名里**要带状态**：一张单从"等人接手"变成"处理中"是同一个 id，只按 id 比的话
  卡片不会重画，人点完接手看不到任何变化。重画前先把没写完的那句话存起来，画完填回去
- **按单号跨块认**（`fold` 里的 `handoffSeen`）：后续状态常常隔几小时才来，那时人多半又
  跟 Bot 说过话，「当前这一块」早就不是开单那一块了。只在当前块里找的话，同一张单会被
  画成两张卡——上面那张还写着「等人接手」、按钮还能点（点下去换回 409），而人在下面那张
  卡里写的结论也读不到（取的是第一个匹配的输入框）
- **拉一次现况核对**（`syncHandoffs`，和确认那一套同源）：交接单是落盘的，但席位重装、
  换机器、手工清过库之后，日志里那条 `open` 还在而单子已经没了。比水位早、又不在席位
  清单里的，画成一行「席位上已经没有这张单了」，**不留按钮**。席位没答话时一律当它还活着
  ——宁可留一张可能点不动的卡，也不要把一件真在等人的事画成失效
- 名单那颗点有两个数据源：**事件**（这条流上的，当场生效）和**快照**（`/runtime/handoffs`
  每 30 秒一次，补上流里没有的——流上只垫最近一轮，昨天半夜那张单不在里面）。两份分开存，
  合并成一个集合的话，别人在另一台机器上关掉的单子就再也销不掉了
- 交还的那条消息 `source` 是 `plugin: 'handoff'`，而 `fold` 默认滤掉非人类消息——**这一种
  要放行**，否则界面上会看到 Bot 突然自己开口接着干活，而上一句是几小时前它说"等人接手"
- **别人名下的 Bot 打不开对话**：`/runtime/bots/:id` 按「这颗 Bot 是不是你的」判
  （`visibleBotOf` → `botsFor`），管理员点过去落在一句「没有这个 Bot」上——而他恰恰是最
  该处理别人单子的人。所以待办页上「去对话里处理」**只对自己的 Bot 给**，别人的那种
  就地展开一张同样的卡（同一套 `.sw-handoff` 样式、同一条 `actOnHandoff`）。正文
  （Bot 做到哪一步）现去席位拉（`GET /runtime/handoffs/:id` 的 `detail`），拉不到就说
  「席位没应答」——写成「这张单没有内容」的话，接手的人会以为 Bot 什么都没做，然后从头
  再来一遍

---

## 12. 审计与指标

- `bot.guard.escalated` 那条**照旧**（管理员那一屏在用，别删）
- 状态流转各一条：`handoff.open` / `handoff.claimed` / `handoff.returned` / `handoff.expired` /
  `handoff.cancelled`。「谁接的、什么时候接的、交还时说了什么」正是事后要问的
- **`handoff.closed` 不记**：那只是 Bot 把交还消化完了，不是人做的事。审计那一栏被机器动作
  刷满，人做的那几行就淹了
- 指标从 `handoffs` 表投影，不从日志正则（`db.handoffStats`，30 天窗口）：开了几张、还欠着
  几张、几张没人接、**多久有人接**（中位数，不是平均——一张挂了两天的单会把平均值拖到没法
  看，而人想知道的是「一般多久有人应」）。[dsh-capability-map.md](./dsh-capability-map.md) 第 10 项写的"转人工率"
  就此有了数据源
- **`claimedAt` 只在真被人接手时落**（`claimed` / `returned` 那两态）。照「不是 open 就算
  接过」写的话，`expired` / `cancelled` 这些从来没人碰过的单子也会带上一个 claimedAt，
  而那个中位数正是 `filter (claimedAt is not null)`——于是恰恰是没人接的那些，把响应速度
  这个数字拖到最难看
- **统计的范围跟清单一样**：员工只算自己名下和指名给自己的。一律按公司算的话，他顶上写着
  「近 30 天开出 42」、下面的表格只有一行，而且顺带把别人 Bot 的工作量报给了每一个人

---

## 13. 落地在哪几处

| 层 | 文件 | 干什么 |
|---|---|---|
| 席位 | [bot/src/policy/handoff.ts](../bot/src/policy/handoff.ts) | 状态机、落盘、去重、`turn/end` 收口、交还那段话的措辞 |
| 席位 | [bot/src/policy/index.ts](../bot/src/policy/index.ts) | `escalate_to_human` 开单（`ask` 必填），留档那条 `tool/policy` 照旧 |
| 席位 | [bot/src/session/types.ts](../bot/src/session/types.ts) | `human/handoff` 事件 |
| 席位 | [bot/src/agent/index.ts](../bot/src/agent/index.ts) | `send()` 收 `source`，交还那一轮标成 `plugin: 'handoff'`；提示词里那段「什么时候转人工」 |
| 席位 | [bot/src/web/index.ts](../bot/src/web/index.ts) | 五条 `/api/sessions/:id/handoffs*`，交还落地成一次 steer 或新一轮 |
| 席位 | [bot/src/session/gateway.ts](../bot/src/session/gateway.ts) | outbox 多一种 `handoff`，失败重试 |
| Gateway | `db/migrations/0014-handoffs.ts` · `0015-handoff-webhook.ts` | 表与通知地址 |
| Gateway | [gateway/src/lib/handoff.ts](../gateway/src/lib/handoff.ts) | 指派解算、能不能动、够到席位、名字回填 |
| Gateway | [gateway/src/routes/handoffs.ts](../gateway/src/routes/handoffs.ts) | 待办清单、接手 / 交还 / 撤销 |
| Gateway | [gateway/src/routes/internal.ts](../gateway/src/routes/internal.ts) | `/internal/handoffs`：落库、开单通知、状态流转进审计 |
| Gateway | [gateway/src/handoff-sweep.ts](../gateway/src/handoff-sweep.ts) | webhook 正文、催办两档、超时收单 |
| Gateway | [gateway/src/routines.ts](../gateway/src/routines.ts) | 有挡路的单子就跳过这一次定时 |
| 界面 | `chat.js` · `pages-handoffs.js` · `pages-bots.js` · `pages-admin.js` | 卡片、名单那颗点、待办页、「交给谁」、通知地址 |
| 测试 | `bot/e2e-handoff.mjs` · `e2e/handoff.mjs` | 席位内的状态机（探针）+ Gateway 这一侧（真 HTTP，假席位 + 假群机器人） |

## 14. 不变量

1. **转人工这把工具永远调得通。** 它不被任何一条边界挡，不因为额度、限流、离线而失败——
   模型撞墙之后唯一的出口不能也是墙
2. **一张开着的单子必然有终态。** 要么被人闭合，要么超时转 `expired` 并交还给 Bot。
   没有第三种结局
3. **交还必然产生一条会话事件。** 人做了什么，在日志里能重建；否则下一次谁也答不了
   「这件事上次是怎么处理的」
4. **Gateway 不存正文。** 单子的 `reason` / `ask` 各留一段供列表显示，全文在席位
5. **认领是显式的。** 说话不算，路过不算，看见不算

---

## 15. 验收（对着打勾）

打勾的那几条由 `e2e/handoff.mjs` 盯着（`pnpm e2e`）；没打勾的是要人手点一遍的。

- [x] 让 Bot 转人工 → 单子开出来、状态是「等人接手」、事件落了、上报了
- [x] 同一件事换个措辞再撞一次 → 并进同一张单，不是开第二张
- [x] 两个人同时点「我来接手」→ 一个成功，另一个看到"已被 X 接手"，不是静默覆盖
- [x] 点「交还」并写一句结论 → 那段话真的送到了席位，模型看得出谁做了什么、接下来做什么
- [x] 交还之后那一轮收口 → 单子才转 `closed`（中间是「已交还，Bot 正在接着做」）
- [x] 重启席位 → 单子还在，还接得动
- [x] 管理员接别人名下 Bot 的单 → 够得着那台席位（会话不是他的，按会话鉴权的路走不通）
- [x] 别的员工 → 看不见、也拉不到（404，不是 403——否则这条路由成了猜单号的探针）
- [x] 通知地址只收 https；开单往群里推一条，正文里有「要人做什么」
- [x] 没人接到点 → 单子 `expired`，席位收到 `/expire`，那句「没人接手」进得了模型
- [x] 席位不在线 → 交接动作如实报 503，不假装成功
- [x] 统计投影：近 30 天开了几张、还欠着几张、几张没人接
- [x] 接了手却一直没交还的，到点也会被收掉（不然它永远挡着日常任务）
- [x] 没人接过的单子不留 `claimedAt`，不污染「多久有人接」
- [x] 员工看到的统计跟他看得到的清单是同一个范围
- [x] 中间隔了几轮对话，同一张单还是同一张卡（不是两张）
- [x] 席位上已经没有的那张单画成一行字、不留按钮；席位没答话时不当它失效
- [x] 交还之后**上一轮**的收口不算数，等它自己那一轮跑完才闭合
- [x] 待办页上，别人名下的 Bot 不给「去对话里处理」（那条路走不通），给就地处理的卡
- [x] 那张卡的正文是现去席位拉的；席位没应答时说清楚，不画成「这张单没有内容」
- [ ] 员工在自己对话里转人工 → 卡片出现，侧栏那颗点变成"在等你"
- [ ] 刷新页面 / 换标签页 → 卡片还在，没写完的那句话还在
- [ ] 日常任务在半夜跑 → 开单 + 推群；早上点进去接手 → Bot 接着往下
- [ ] 那条 blocking 的单子没闭合 → 下一次定时不跑，流水上写着"等人处理中"
- [ ] 审计里查得到「谁接的、什么时候、交还说了什么」
