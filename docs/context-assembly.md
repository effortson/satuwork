# 上下文是怎么装配的

**每开一轮，都从那条会话的 JSONL 全量重建一次请求。** 没有"会话对象"这种东西——
系统提示词、工具表、消息数组三样全是现算的，算完就扔；内存里只有一个正在跑的
`Agent` 实例，它一收口就没了。

这一份把"从日志到一次模型请求"这条路从上往下写一遍。之前它只散在
[bot/src/agent/index.ts](../bot/src/agent/index.ts) 的注释里——那些注释都在，但要拼出全貌得读一千多行。

相关：事件模型见 [session/types.ts](../bot/src/session/types.ts) 与
[session-event-field-map.md](./session-event-field-map.md)；人手改边界（`/compact`、`/new`）见
[chat-commands.md](./chat-commands.md)。

---

## 1. 一次请求由四样东西组成

入口是 `runTurn`（[agent/index.ts](../bot/src/agent/index.ts)）。它算出四样，喂给
pi（`@earendil-works/pi-agent-core`）的 `Agent`：

```
systemPrompt ← composeSystem(bot)          这一轮定死，中途不变
tools        ← toolSchemasFor(bot, @)      这一轮定死，中途不变
messages     ← toAgentMessages(history)    从事件重建
      +
agent.prompt(…)                            这一轮那句话，单独送（见 §5）
```

前两样在一轮之内是常量——pi 在这一轮里连着跑好几步（step），每一步都拿同一份提示词和
同一张工具表，只有 messages 在它自己内存里越滚越长。每一步开头 projector 记一条
`request/header`，链路视图那屏读的就是它。

---

## 2. systemPrompt：顺序固定

`composeSystem` 拼出来的，从上到下：

| 段 | 来自 | 什么时候有 |
|---|---|---|
| Bot 提示词 | 模版的 `prompt`，空则用全局默认 | 总是 |
| `runtimeBlock()` | 硬编码。讲清 `[时间]` 前缀这个约定 | 总是 |
| `webContentBlock()` | 硬编码。给 `<web_content>` / `<page_content>` 下定义 | 挂了 `web_extract` **或** `browser_snapshot` |
| `escalateBlock(rule)` | 模版的 `escalate` 字段，**原样引用不改写** | 有规则**且**挂了 `escalate_to_human` |
| `linkOutBlock()` | 硬编码。列举东西时每条都要写成 markdown 链接 | 挂了 `web_search` / `web_extract` / `browser_snapshot` / 任一 `mcp_*` |
| `fileOutBlock()` | 硬编码。产出的文件在界面上是一颗点得开的药丸，别教用户去文件系统里找 | 挂了 `write_file` / `patch` / `terminal` / `web_extract` / `browser_snapshot`——即**会报 `ToolResult.files` 的那五条路** |
| Skill 正文 | `skills` 集合里**常驻**那一档，`## Skill: 名字` + body 全文 | 有常驻的 Skill 时 |
| Skill 索引 | **按需**那一档，一条一行「名字 — 一句话」；装不下就只剩一行摘要，那一轮工具表里多一把 `skills_list`（见 [skills.md](./skills.md) §5） | 有按需的 Skill 时 |
| 记忆 | 记下的那些事实，**排在整份提示词的最末尾**（见 [memory.md](./memory.md) §7） | 模版上记忆开着、且有挑得出来的条目时 |

挂哪些 Skill 的口径没变：`bot.skills` 未定义 = 本机所有启用的，空数组 = 一条都不加。
变的是**同一条 Skill 进不进正文**——那由它自己的 `mode` 决定（常驻 / 按需），存量一律
是常驻。正文不进提示词的那些，由模型自己调 `skill_view` 取，见 [skills.md](./skills.md)。

几段硬编码的都是**条件加载**，理由是同一条：没有那把工具时，那几行是在教模型防一种它
遇不到的东西 / 用一把它没有的工具，纯占上下文。

**记忆为什么必须排在最后**：上面那些几天不动，而记忆一天动几次。插在 Skill 前面，等于
每记一条就把整段 Skill 正文的前缀缓存作废一次——这笔账和下面「这里不放当前时间」算的
是同一笔。

> `fileOutBlock()` 也是为一次线上现场加的：Bot 生成了一个 HTML 图表页，然后在回答里写
> 「文件已生成：`eth_price_10y.html`（工作区根目录，双击即可在浏览器打开）」——而用户
> 面前只有一个网页上的对话框，既没有那台席位机器的文件管理器，也没有可以双击的桌面。
> 路一直是通的（产出会变成一颗点得开的药丸），模型不知道它存在而已。

还有一段**只属于这一轮、不落盘**的：`@` 了某把连接、而它的工具一个都没挂上时，
追加 `mentionGapBlock`。不落盘是因为落盘的是结构（谁被点名了），重放时工具表可能已经
好了，那时不该还带着这句话。

> 线上真踩过：用户 `@Gmail` 说"查看邮件"，工具没挂上，模型一无所知，于是自己找了个
> 替代方案——去开虚拟桌面里的 Chrome。用户看到一堆莫名其妙的 terminal 调用，而真正的
> 问题一个字都没提到。这一段就是为它加的。

### 这里不放当前时间

系统提示词是整个请求的**前缀**，而上游做前缀缓存。塞一个每轮都变的时钟进去，等于每轮
都从第一个 token 重算。这笔账很实在：同一条会话里，命中缓存的那几轮提示词按 54、103
个 token 计费，冷缓存那一轮是 3151。

时间改由**最后一条用户消息开头的 `[时间]`** 提供（见 §4 ④）——它本来就在末尾、本来就
每轮都新，缓存边界落在它前面，一个 token 都不多花。`runtimeBlock()` 的唯一职责是把这个
约定讲清楚，不然模型会把前缀当成用户打的字，还会在自己的回复里跟着照抄。

### 返回值是三段不是一段

`{ text, base, skills }`。分开留一份是给界面那颗上下文 chip 用的——它要分别报"系统
提示词"和"Skill"占了多少，拼完再去切字符串既脆（提示词里出现同样的小标题就切错）又
白算一遍。

---

## 3. tools：过滤 + 排序，不是白名单

`toolSchemasFor`：

1. **内置工具全都在**；
2. `mcp_*` 按 `bot.mcps` 过滤（未定义 = 目录里所有 server）；
3. `browser_*` 按模版的浏览器开关**遮掩**；
4. `@` 点名的那把连接的工具**顶到表头**。

第 3 条只是遮掩，**不是强制**——模型硬报一个没在表里的名字照样调得通，真正拦在 policy
的 `checkBrowser` 里。两层都要有：少了这一层，没开浏览器的 Bot 会看见十来把它永远调不通
的工具，然后一遍遍去试。

第 4 条**只排序、不过滤**。"@Gmail 看看邮件，然后在 Notion 建个页面"是完全正常的一句
话，硬过滤会把它变成半个功能。顶到最前是因为工具表越长模型越容易在前几个里选——点名了
却排在第 40 位等于没点。点名唯一的**放开**作用是让 `mentionOnly` 的连接这一轮出现在表里
（平时它不进默认表）。

工具表最后过一层 `bridgeTools`，把 policy 那套（高风险确认、PII、外发闸）包在 execute
外面。工具**表**和工具**能不能跑**是两件事，装配这一层只管表。

---

## 4. messages：从事件重建，五道加工

`toAgentMessages(events, model, ctx)`。输入是事件数组，输出是 pi 认的消息数组。

### ① 截断到最后一条上下文边界

找最后一条**上下文边界**（`contextBoundary`：`session/compact` 或 `session/reset`，
谁在后面算谁），扔掉 `seq <= throughSeq` 的全部。只认最后一条——每次压缩都是把
"上次的摘要 + 这段新对话"再压一次，后一条必然覆盖前一条；而 `/new` 打下的重置点
更是明说了前面的不要了。

两者的**唯一**区别在下面第 ⑤ 步：压缩点要把摘要并回去，重置点到此为止。

### ② 重排：工具结果挂到它那条助手消息后面

日志按真实时序记录，而 pi 在 `turn_end` 才给出最终助手消息——于是**带 `tool-call` 的那条
排在它自己的 `tool/result` 之后**。直接按 seq 喂回去，provider 会拒收
（"role 'tool' 必须紧跟在带 tool_calls 的消息之后"）。

做法是给每条算一个 `order`：助手消息用自己的 seq，工具结果用 `锚点 + 1e-6 × 批内序号`,
排到锚点之后、下一条整数 seq 之前，同时保住批内先后。

### ③ 图片：最多带 4 张真的

日志里存的是**路径**不是 base64（一张 2 MB 的图 base64 之后 2.7 MB，直接落进 JSONL 会让
单行大到没法 grep、没法 tail）。重建时现读现转，带 mtime+size 的 LRU 缓存兜着
（`IMAGE_CACHE`，8 条）。

`MAX_LIVE_IMAGES = 4`，这是**整个上下文里同时摆得下几张**，不是"一条消息最多几张"——
一条消息带十张图，也只有最后几张进得去。更早的换成一句"（前面有一张图 …，离现在太远，
这一轮没有放进上下文。）"：说清楚它存在过，模型才不会以为自己漏看了什么。

不加这道闸的话，历史里每一张图每一轮都要重新读盘、重新 base64、重新发一遍，开销随图片数
线性涨而且**只增不减**。

### ④ 时间戳只盖用户消息

每条用户消息前缀 `[8月18日 22:10]`（`stampUser`，时区取席位本地）。助手消息的时间模型能从
相邻的用户消息推出来，每条都盖是白花 token。

带图的那种走 `stampContent`：时间**单独作为第一个文本块**，不去改正文那一块,免得把它跟图
的先后关系弄乱。带图那几条往往正是之后会被问起的"上周发你的那张图"，漏盖就等于那几条没有
时间。

> 这件事修的不是我们的日志，是**模型的认知**。事件信封上一直有 `time`，但那个字段
> 从来没进过模型手上——以前重建时统一盖 `Date.now()`，一条跨了三天的长会话在模型眼里
> 每一句都是"刚刚"说的，"我昨天跟你说了什么"于是无解。

### ⑤ 摘要并进保留段的第一条 user 消息

**不单独占一条。** 压缩边界固定落在 `turn/end` 上，其后第一条一定是 user——摘要单独成条
就是**连续两条 user**，Anthropic 直接拒收整个请求。

症状极难查：OpenAI 兼容口完全正常，本地和 e2e 都照不出来，线上表现是"一旦压缩过，这个 Bot
就再也答不了话"。并进去就没有这个问题，任何家都一样。

摘要正文（`summaryText`）**必须写出覆盖区间的首尾时间**，否则压缩之后"昨天"就断了；
还要写明"原始对话一条没删，需要原文就用 `history_read` / `history_search`"。

### 另外两处防御

- **空名字的 `tool-call` 连它的结果成对丢掉。** 来源是一个已经修掉的下标错位，但已经写下的
  日志里还留着。一把叫「」的工具谁也执行不了，回传它轻则白占 token 外加教模型"可以有空名字
  的调用"，重则上游拒收整条请求。必须**成对**丢：只丢调用会留下一条无主的 toolResult,
  Anthropic 那边同样是硬拒。
- **重建的助手消息必须和 pi 自己产出的同形**：除了 content，还要带 `usage` 与
  `api`/`provider`/`model`。少了 `usage`，pi 在后续轮次读它的 `totalTokens` 时会炸——
  症状是第一轮正常、第二轮起全部失败。

`reasoning` 块在这里被过滤掉：思考过程只进日志和界面，不回传给模型。

---

## 5. 这一轮那句话不走 messages

一处关键时序：`history` 是在 `user/message` 和 `turn/start` **append 之前**取的快照
（`sessions.events()` 返回的是 `state.events.slice()`）。所以**这一轮的消息不在 messages
里**，它靠 `agent.prompt()` 单独送。

- 有图、有 `@` 或有引用 → 走 `userContentFor` 拼内容块（图在前、正文在后、点名渲染成一行
  `[本轮指定：…]`、引用渲染成 `[引用你 … 的回复] 全文 [引用结束]` / `[引用文件：…]`，见
  [chat-references.md](./chat-references.md) §6），再 `stampContent` 盖时间。引用要把 `history`
  一起递进去：被引用的回复全文按 seq 从那里读，而引用只会指向更早的消息，这份快照够用；
- 纯文本 → `stampUser` 那条快路，直接是字符串。

这一轮的图**必须从这里进去**。只传文本的话，图要等到下一轮重建历史时才被读出来,
表现成"问第一遍它没看见，再问一句就看见了"。

**先落盘再干慢活**也是刻意的：两次 append 排在重建历史之前，因为重建要读盘 + base64
（最多 4 × 3.5 MB）。进程要是在那段窗口里硬死（OOM、systemd 重启、SIGKILL），用户那句话
就一个字都没留下。

---

## 6. 长度控制：三道闸

### 判据：估算，不是 tokenizer

`estTokens`：CJK 一字一 token，其余按 3.6 字符一 token。图按 **1500 token/张**固定计
（各家按分块数算，一张常见截图落在一两千之间）。宁可估高——估低的代价是撞窗口，估高只是
早压一轮。

### 三道闸

| 闸 | 在哪 | 判据 | 动作 |
|---|---|---|---|
| 软压缩 | 轮末，**不 await** | 本地估算或 provider prompt token 高水位 > 窗口 × `compactAt` (0.6) | 跑一次总结，写 `session/compact` |
| 硬顶 | 轮首，**同步等** | 估算 > 窗口 × `compactHard` (0.9) | 先压一次再发，这一轮多等几秒 |
| 图片窗口 | 重建时 | 最近 4 张 | 更早的换成一句说明 |

软压缩摆在**回复送出之后**：它自己也要跑一次模型，摆在轮首用户就得干等。不 await——
这一轮已经结束了，压缩失败也只是下一轮再试。

硬顶是兜底：轮末那次可能失败了，也可能上个进程根本没跑到那一步。已经顶到硬顶还往上游发,
换来的是一个 400，用户看到的是"出错了"，宁可这一轮多等几秒。**这一整段（包括判断条件本身）
都套在 try 里**——估算上下文长度是优化，不是正确性的一部分，失败了就带着原上下文往下走。

> 这个 try 是有来历的：早先它只圈住 `maybeCompact`，条件里那次 `await toAgentMessages`
> 露在外面。它不是纯计算（要读图、要碰 `ctx.workspace`），而 workspace 一度没进这个插件的
> inject——于是**一条会话只要带过一次图，之后每条消息都在这一行静默消失**。

`compacting` 那把在飞锁：轮末那次是后台的，下一轮很可能撞上。两次压缩同时算会各自按自己
看到的历史挑边界，然后写下两条互相矛盾的压缩点。硬顶那条路**要等它**，不能直接返回。

### 压到哪儿：`compactionPoint`

从后往前累加每条事件的估算值，直到近期这一段吃满 `窗口 × compactKeep`(0.3)，切在再往前
的那个 `turn/end` 上。用后缀和把 O(n²) 压成 O(n)——挨个切点重跑一遍 `toAgentMessages`，
长会话上会明显卡一下。

两条硬约束：

- **只切在 `turn/end` 上。** 切在一轮中间，带 `tool_calls` 的助手消息会被摘要吃掉、而它的
  `tool/result` 留在后面 —— provider 拒收整个请求。切在 `turn/end` 上，边界两侧各自都是
  完整的轮次。
- **至少压掉一轮、至少留一轮。** 可切位置是 `ends[0 .. length-2]`。

挑边界时**只看上一条上下文边界之后的范围**（`scopeAfterBoundary`）。按全量去挑会挑到更早的
位置，而 `toAgentMessages` 认的是最后一条压缩事件——于是"再压一次"反而把上次压掉的原文
放了回来，**越压越大**。边界必须单调向前。

### 摘要本身

一次**无工具**的模型调用，不走 pi 的 Agent（套一层循环没有意义），直接用 `streamFn` 读到
`done`。提示词 `SUMMARY_SYSTEM` 明说"读它的是接着聊下去的 AI 助理，不是人"，要求保留
事实/决定/**没做完的事**/绝对时间/产出物位置，丢掉寒暄和工具原始输出。

输入超 60k 字符时 `clampTranscript` **掐中间、头尾都留**。不能简单 `slice(-N)`：级联压缩时
上一次的摘要就在第一条，只留末尾第一个丢掉的就是它，新摘要因此不含第一次压缩之前的任何东西。

**输入是从全量切的，不是从 scope 切的**——这样它带上了上一条压缩事件，`toAgentMessages` 会把
"上次的摘要 + 这段新对话"折成一份再交给模型去总结。

---

## 7. 所以上下文里最多有多少轮？

**没有轮次上限。** 整条路径上没有任何一处数轮次，唯一的闸是 token 预算。

```
0.9×窗口 ┄┄┄ 硬顶：轮首同步压一次再发（兜底，正常走不到）
0.7×窗口 ━━━ 触发：轮末跑一次摘要
            ↓ 压
0.3×窗口 ━━━ 压完剩下：摘要 + 这么多原文
            ↑ 长
```

稳态下上下文在窗口的 **30%~70%** 之间来回，不会真的"装满到截断"。

换算成轮次要看每轮多重（`estEvent` 只算三种事件：用户消息、助手消息、工具结果）。
128k 窗口 → 保留预算 38.4k：

| 这一轮长什么样 | 大约值 | 38.4k 装得下 |
|---|---|---|
| 纯问答，几句话 | 200~600 | 几十到一百多轮 |
| 带一次 `web_extract` / `search_files` | 数千 | 十几轮 |
| 一次 `terminal` 吐了满屏日志 | 上万 | 三五轮 |
| 每带一张图 | +1500 | — |

**最少剩几轮 = 1 轮。** 就算最后那一轮自己就超预算，也整个留着——切了也不省，这种情况只可能
是单轮塞进了巨大的工具结果，压缩帮不上忙，交给别的手段。

---

## 8. 会失效的地方（都是真的，别当边角料）

**① 阈值只量消息，不含系统提示词和工具表。** 两处判据算的都是
`estMessages(toAgentMessages(...))`，而真实请求还要驮上系统提示词 + Skill 正文 + 完整工具
schema。一个挂满 Skill 和 MCP 的 Bot，这部分能有一两万 token，全都不在判据里——界面那颗
chip 报的是实测总量，会明显比"该压了没压"的判断更早见红。

**② 只跑过一轮就撑爆时，压缩救不了。** `turn/end` 少于两条 → `compactionPoint` 返回
`undefined` → 软压缩不压、硬顶那次也压不动（日志里一行 `找不到能切的轮次边界` 的 warn），
然后带着超长上下文发出去，换回一个 provider 的 400。第一轮就 `terminal` 出几十万字会踩这个。

**③ 窗口拉不到时按 128k 兜底。** `windowOf()` 从 Gateway 目录读 `contextWindow`，目录没给
就退回 `128_000`。真实窗口要是更小（32k 的模型），压缩就一直不触发。

**④ 三个比例不能在界面上改。** `provider`/`model`/`system`/`maxSteps` 都走 `setting()`
（设置库 > cordis.yml > 默认），而 `compactAt`/`compactKeep`/`compactHard` 是直接读
`this.config`，只认 cordis.yml——而 cordis.yml 里没写，所以就是 0.7/0.3/0.9。

**⑤ steering 的消息不落会话日志。** 跑到一半插的话走 `agent.steer()`，投在 pi 自己的队列里,
**没有对应的 `user/message` 事件**。它进了这一轮的模型，但**下一轮重建历史时它不在**——
模型会"忘掉"你插的那句话。撞步数硬顶时更直接，代码里那行 warn 写着"已随这一轮丢弃"。

---

## 9. 几条不变量

1. **凡是进入模型请求的东西，都必须能从日志重建。** 反过来也成立：没进模型的东西不能伪装成
   进过（这是 `/compact`、`/new` 不做成普通消息的理由，见 [chat-commands.md](./chat-commands.md)）。
2. **压缩不是丢弃。** JSONL 一条不删，界面、审计、`/internal/sessions/:id` 看到的都是全量原文；
   模型自己也能用 `history_read` / `history_search` 把压掉的那段调回来。这正是这件事敢做的前提。
3. **压缩边界只落在 `turn/end` 上**，且**单调向前**。
4. **落盘是结构，进模型是话。** `mention` 块存 `{kind,id,label}`，渲染成 `[本轮指定：…]` 只发生在
   `textFrom` 这一处；`mentionGapBlock` 只进这一轮的提示词、不落盘。两边分开，重放才和当时一致。
   `ref` 块同理：存 seq / 路径，全文在渲染那一刻按 seq 从**全量**日志里读（压缩边界之前的也读得到），
   文件在不在也是那一刻查的；`refBlock` 只进这一轮的提示词。
5. **估算失败不能连累这一轮。**

---

## 10. 别和这两个数搞混

- `STREAM_TAIL_TURNS = 1`（[gateway/ui/chat.js](../gateway/ui/chat.js)）—— SSE 第一帧垫的历史；
- 打开对话拉 20 轮、往前翻一页一页取 —— HTTP `/history` 的分页（`historySlice`）。

这两个是**浏览器里看得见多少**，跟模型上下文里有多少完全无关。

---

## 11. 代码位置

| 干什么 | 在哪 |
|---|---|
| 一轮的总装配 | `runTurn`（[agent/index.ts](../bot/src/agent/index.ts)） |
| 系统提示词 | `composeSystem` / `runtimeBlock` / `webContentBlock` / `escalateBlock` / `linkOutBlock` / `fileOutBlock` / `mentionGapBlock` / `refBlock` |
| 工具表 | `toolSchemasFor`，执行期包装在 `bridgeTools` |
| 事件 → 消息 | `toAgentMessages`（导出，e2e 直接测它） |
| 图片 | `userContentFor` / `loadImage` / `stale` / `IMAGE_CACHE` / `MAX_LIVE_IMAGES` |
| 时间戳 | `stampUser` / `stampContent` / `textFrom` |
| 估算 | `estTokens` / `estEvent` / `estMessages` / `toolsText` / `contentDigest` |
| 上下文边界 | `contextBoundary` / `scopeAfterBoundary`（压缩点和重置点共用一套判定） |
| 压缩 | `maybeCompact` / `compactOnce` / `compactionPoint` / `summarize` / `clampTranscript` / `summaryText` |
| 人手改边界 | `compactNow` / `resetContext`（见 [chat-commands.md](./chat-commands.md)） |
| 每步的留痕 | `projector` 里的 `request/header` |
| 探针 | [bot/e2e-compact.mjs](../bot/e2e-compact.mjs)（纯函数，不起服务） |
