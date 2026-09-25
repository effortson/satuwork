# 输入框里的斜杠命令

一条斜杠命令 = **人对这条会话下的一次控制指令**，不是发给模型的一句话。

第一批两条，都只干一件事——**改这条会话的上下文边界**：

| 命令 | 一句话 |
|---|---|
| `/compact` | 现在就把旧的那一段换成摘要 |
| `/new` | 从这里起，前面的全部不再进上下文 |

两条都在对话流里留下**一条分割线**，标明这一刀切在哪儿。

**这份不再是提案，是已经落地的东西的说明书**（代码位置见 §12，验收见 §13）。

本文只写这一件事的取舍与落地位置。会话事件模型以
[gateway-runtime.md](./gateway-runtime.md) 和 [bot/src/session/types.ts](../bot/src/session/types.ts) 为准，
本文在其上**加一种事件**（`session/reset`），不改已有的任何一种。

---

## 1. 第一条边界：命令不是消息

命令**不进 `user/message`**，不占 token，不开新的一轮，模型看不见它。

写清楚是因为反过来做要省事得多——把 `/compact` 原样 POST 到
[`/api/sessions/:id/messages`](../bot/src/web/index.ts)，让系统提示词教模型「看到这四个字就调压缩工具」。
那条路上有三笔账：

- 模型会把它当成一句话来理解，于是它**可能不照做**，也可能顺嘴回一段解释——而人要的是一个确定的动作；
- 重放、审计、导出里，「人点了压缩」和「人打了 compact 这几个字」长得一模一样（不变量：进模型的东西必须能从日志重建，反过来也一样——**没进模型的东西不能伪装成进过**）；
- `/new` 尤其荒唐：它的意义就是「这句话之后前文不算数」，而它自己作为一条消息**必然落在边界的错误一侧**。

所以：命令走各自的 HTTP 接口，落各自的会话事件，界面上画成分割线而不是气泡。

---

## 2. 两条命令的对照

| | `/compact` | `/new` |
|---|---|---|
| 做什么 | 旧的那一段 → 一段摘要 | 旧的那一段 → 什么都不留 |
| 要跑模型吗 | **要**，一次无工具的总结调用，几秒，**照常计费** | 不要，一次 append，几毫秒 |
| 落什么事件 | 复用 `session/compact` | 新增 `session/reset` |
| 上下文里留下 | 摘要 + 最后一整轮原文 | 只有最后这条边界之后的东西（也就是空的） |
| 日志 | 一条不删 | 一条不删 |
| 失败了会怎样 | 这一刀没切成，如实说，上下文原样 | 几乎不会失败（只是 append） |

**两条都不删任何东西。** 这是 `session/compact` 一开始就立下的规矩，`/new` 照抄：
JSONL 全量原文照旧，界面往上翻看得见，审计看得见，导出带得走，模型自己也仍能用
`history_read` / `history_search` 调阅。「丢弃上下文」丢的是**下一轮请求里带什么**，
不是丢掉记录。

> 界面文案要跟着这条走：`/new` 的分割线写「上面的内容不再进上下文」，
> **不写**「已清空」——人会以为记录没了，而它还在。

---

## 3. 为什么 `/new` 不是「新建一条会话」

「一个 Bot 一条长会话」是这套东西的架构不变量，挂在上面的有：侧栏那一行的摘要与状态点
（[chat.js 的 botStreams](../gateway/ui/chat.js)）、会话索引、`/a/:id` 的回访、工作区的归属、
跨轮认单的转人工（[handoff.md](./handoff.md)）。新建会话要连带回答一串问题：
旧会话的工作区还跟着走吗？那张昨天开出来、还没人接的单子归谁？侧栏是变成两行还是一行？

而人打 `/new` 时想要的只有一件事：**别把前面那些带上**。那是**上下文边界**，不是**会话边界**。

所以 `/new` = 在同一条会话上打一个**不带摘要的压缩点**。会话 id 不变，流不重连，
侧栏不动，工作区不动，历史往上翻照样在。

---

## 4. 事件模型：把「上下文边界」收成一个概念

新增一种事件，形状刻意跟 `session/compact` 对齐：

```ts
/**
 * 上下文重置点（人在输入框里打了 /new）。
 *
 * 和 session/compact 是同一类东西——**下一轮请求从哪儿开始**——区别只在这一条
 * 不留摘要。共用一套判定：见 contextBoundary()。
 */
'session/reset': {
  /** 这一条（含）之前的事件不再进上下文。和 compact 一样，**必须落在 turn/end 上**。 */
  throughSeq: number
  /** 被切掉那一段的首尾时间。界面上那条分割线要写出来。 */
  from: number
  to: number
  /** 谁切的。审计要分得清「它自己压的」和「人点的」。 */
  by: 'user'
}
```

`session/compact` 同时补一个可选的 `by?: 'auto' | 'user'`（老日志没有，按 `auto` 读）——
不然事后没法回答「这次压缩是自动触发的还是人点的」，而这两件事在排查
「它怎么突然忘事了」时是不同的答案。

**`SESSION_FORMAT_VERSION` 不动。** 理由和当年加 `session/compact` 时一样：老版本读到
不认识的 type 会跳过。要注意的是**退化的方向**——老版本读到 `session/reset` 会把前文
全都带回上下文，也就是「像没执行过 `/new` 一样」。多带不是少带，方向是安全的，但
回滚一次席位版本，`/new` 的效果就消失了（见 §11）。

### 三处硬编码收了口

判定收成一个导出函数，凡是问「下一轮从哪儿开始」的地方都用它：

```ts
/** 最后一条上下文边界。压缩点和重置点是同一类东西，判定只能有一份。 */
export function contextBoundary(events) {
  return [...events].reverse().find(
    (e) => e.type === 'session/compact' || e.type === 'session/reset',
  )
}
```

三处原先各写各的，现在都改成它（都在 [agent/index.ts](../bot/src/agent/index.ts)）：

| 位置 | 原来 | 现在 |
|---|---|---|
| `toAgentMessages` | 找 compact，截断，把摘要并进保留段第一条 user | 找边界截断；**是 reset 就到此为止，不并摘要** |
| `scopeAfterLastCompact` → **改名 `scopeAfterBoundary`** | 挑新压缩边界时只看上一个 compact 之后 | 只看上一条**边界**之后 |
| `compactOnce` 里的 `older` 切片 | 同上 | 同上 |

改名而不是留个别名：这个函数是导出的、e2e 直接测它，留着「LastCompact」这个名字，
下一个读它的人会以为它真的只认压缩点——而那正是这次要修掉的那个 bug。

**这一处不收口的代价很具体**：`scopeAfterBoundary` 如果只认 compact，那么
`/new` 之后的第一次自动压缩会从**重置点之前**去挑边界——挑到的位置比 reset 更早，
而 `toAgentMessages` 认的是最后一条边界，于是那次压缩把 `/new` 刚扔掉的原文
**又放回了上下文**。人点过的 `/new` 会在几轮之后无声失效。

### `throughSeq` 必须落在 `turn/end` 上

这条对 reset 同样是硬的，理由一字不改：切在一轮中间，带 `tool_calls` 的助手消息被切走、
它的 `tool/result` 留在后面 —— provider 直接拒收整个请求。

`/new` 只在「没在跑」时才允许执行（见 §6），所以最后一条事件通常就在 `turn/end` 之后。
但**不能假设**：进程崩过的会话里存在一个永远没有 `turn/end` 的轮次。所以实现是
「取最后一条 `turn/end` 的 seq」，而不是「取最后一条事件的 seq」——切在那儿，
那个残缺的轮次留在边界之后，它本来就是要被下一轮看见的现场。

一条 `turn/end` 都没有（这条会话还没跑成过一轮）→ 没有可切的位置，也没有必要切，
回一句「这条会话还没跑成过一轮，没有要清的上下文」。

还有一道**幂等闸**（方案里没有，写的时候才发现）：上一条边界已经落在这个 seq 上时
回 409「这里已经是新对话的开头了」。不拦的话连着点两次 `/new`，对话里会叠出两条紧挨着
的分割线，而第二条什么都没做。

---

## 5. `/compact` 压到哪儿：`keepBudget = 0`

自动压缩传的是 `window * compactKeep`（默认 0.3），留下三成原文。手动压缩传 **0**。

不用加任何新逻辑（`compactOnce` 多收一个 `opts.keepBudget` 就够）——
[`compactionPoint`](../bot/src/agent/index.ts) 现成的行为正好是想要的：
预算 0 时没有任何切点「装得下」，于是落到最后那条兜底路径 `ends[maxCut]`，
也就是**允许范围内最靠后的切点 = 只留最后一整轮**。「至少压掉一轮、至少留一轮」这两条
护栏一并继承。

为什么手动要压得比自动狠：自动压缩是**省钱的优化**，留三成是为了不把有用的上下文压没；
手动压缩是人明确说「现在太长了，收拾一下」，留三成等于没听懂。

**压不动的情况要说人话。** 原来 `compactOnce` 返回 `boolean`——够自动压缩用（它失败了
只是下一轮再试，没人需要知道为什么），但手动那条路上「还没到阈值」「找不到能切的地方」
「摘要没写成」是三件不同的事，混成一个 `false` 只能回一句「没成功」。所以改成
`CompactOutcome { compacted, reason?, throughSeq?, tokensBefore?, tokensAfter? }`：

| 情况 | 回什么 |
|---|---|
| `turn/end` 不足两条 | 409「这条对话还太短，没有可压的历史」 |
| 摘要那次模型调用失败 | 502 + 原因，上下文原样不动 |
| 正在跑 | 409，见下 |

---

## 6. 正在跑的时候：两条都拒绝

`isRunning(sessionId)` 为真时，两条命令都回 409。

- `/compact` 要读全量历史挑边界、跑一次总结，而这一轮的事件还在往里写；
- `/new` 会把边界打进一个没收口的轮次里（§4 那条硬约束）；
- 而且人在一轮跑到一半时打 `/new`，真实意图基本是「停下来重开」——那是**两个**动作，
  该由人明确地各做一次（先按停止，再 `/new`），不该由命令替他猜。

**队列也一样**：`/new` 时队里还排着消息（带 `@` 的那些）→ 一并拒绝，提示先取消。
那些消息是冲着旧上下文发的，把它们留到边界之后执行，等于人以为清空了、Bot 却在接着
回答几分钟前的事。

界面上不要让人先撞一次 409 才知道：命令选单里，这一轮在跑时把这两条标灰，
底下一行小字写「等这一轮跑完」。

**换版静默期（`quiesced()`）**：`/compact` 拒（它要跑模型，而进程马上要被换掉，
换来的多半是一次半路夭折）；`/new` 放行（纯 append，几毫秒，且不开新轮）。

---

## 7. HTTP 面

席位（[bot/src/web/index.ts](../bot/src/web/index.ts)，摆在 `abort` 旁边，形状照抄它）：

```
POST /api/sessions/:id/compact  → { compacted: true, throughSeq, tokensBefore, tokensAfter }
                                  409 { error } | 502 { error }
POST /api/sessions/:id/reset    → { reset: true, throughSeq }
                                  409 { error }
```

Gateway（[gateway/src/routes/runtime.ts](../gateway/src/routes/runtime.ts)，两条 `proxyJson` 直转，
和 `/abort` 那条逐字一样：`requireUser` → `seatTargetForSession` → `seatBearer` + `machineToken`）：

```
POST /runtime/sessions/:id/compact
POST /runtime/sessions/:id/reset
```

Gateway 这一层**不做业务判断**——它不知道这条会话跑没跑、有几个 `turn/end`，
那些只有席位知道。它只做身份与归属，剩下的原样转、原样透回（含 409/502 的 body）。

服务方法挂在 `AgentService` 上，和 `abort` / `enqueue` 同一层：

```ts
/** 现在就压一次。force + keepBudget 0，见 §5。 */
async compactNow(sessionId: string): Promise<CompactOutcome>
/** 打一个重置点。不跑模型，一次 append。 */
async resetContext(sessionId: string): Promise<{ throughSeq: number; droppedMessages: number }>
```

拒绝走 `CommandError(message, status)`（形状照抄 `WorkspaceError`）：路由层
`instanceof` 一下就能把状态码和**那句原话**一起透出去，而服务这边不用认识 HTTP。
每一种拒绝的原话都是直接给人看的——含糊一句「操作失败」等于让人对着一个没反应的
按钮反复点。

`compactNow` 复用现成的 `compacting` 那把在飞锁——轮末那次后台压缩很可能正好在跑，
两次同时算会写下两条互相矛盾的边界。

---

## 8. 前端：命令怎么被认出来

### 触发条件比 `@` 严

`@` 的判据是「在词首」（[mentionQueryAt](../gateway/ui/chat.js)），`/` 的判据是
**必须在输入框最开头，且整条草稿只有这一条命令**。

严一档是因为斜杠在正文里太常见：`/etc/hosts`、`他说的 /compact 是什么意思`、
贴一段路径 —— 这些都不该弹选单，更不该被当成命令执行。而命令本来就**占满整条消息**，
不和正文混着发。

```js
/** 输入框开头那条 `/xxx`。前面有任何字符都不算。 */
function commandQueryAt(el) {
  const before = el.value.slice(0, el.selectionStart ?? el.value.length)
  if (!/^\/[a-zA-Z-]*$/.test(before)) return null
  return { q: before.slice(1).toLowerCase() }
}
```

### 选单

复用 `.sw-pickbox`，新起一个 `#chat-cmdpick`，摆在 `#chat-mentionpick` 旁边
（[chatPage 的 composer 段](../gateway/ui/chat.js)）。键盘那一段照抄
[app.js 里 `mentionPick` 的分支](../gateway/ui/app.js)：Esc 关、上下键选、回车执行，
**必须排在「回车发送」之前**，理由和 `@` 那条一样。

命令表是**本地常量**，不走接口：

```js
const CHAT_COMMANDS = [
  { name: 'compact', title: '压缩上下文', hint: '把更早的对话换成摘要，会调用一次模型' },
  { name: 'new',     title: '开始新对话', hint: '从这里起不再带上前面的内容，记录不删' },
]
```

不做成 `/mentions` 那样的接口：这两条是**界面对席位发起的两次调用**，不是席位提供的
能力清单，为它多一跳只会让第一屏更慢。（等到命令与席位版本相关时再说——那时接口的
形状应该是「这台席位支持哪几条」，不是「有哪几条命令」。）

`hint` 里那句「会调用一次模型」要写：点一下是要花钱的，虽然不值得为它弹一个确认框。

### 拦在 `sendChat` 的第一行

选单只是提示，**真正的闸在发送路径上**——人完全可以直接把 `/compact` 打完再按回车，
那时选单可能已经关了。

```js
async function sendChat() {
  const text = (state.chatDraft || '').trim()
  const cmd = parseCommand(text)          // 只在 text 整条就是一条命令时命中
  if (cmd) return runChatCommand(cmd)     // 绝不走 POST /messages
  ...
}
```

`parseCommand` 的四种结果（**判据是第一个词，不是整条**）：

| 输入 | 结果 |
|---|---|
| `/compact` | 命中，执行 |
| `/copmact`、`/foo` | **不发出去**，草稿留着，一句「没有 /foo 这条命令」 |
| `/compact 只留最近三轮` | **不发出去**，一句「/compact 不带参数，单独发这一条就行」 |
| `/etc/hosts`、`看下 /compact` | **不是命令**，照常当消息发出去 |

最后一行是写的时候补的一条规则：**命令名里不会有第二个斜杠**。原方案是「以 `/` 开头
就当命令」，那样整条消息就是一个路径时（`/etc/hosts`、`/var/log/syslog`——「看下这个
文件」的省略说法，人真的会这么发）会被拦成「没有这条命令」，纯属添乱。判据收窄到
`第一个词匹配 ^/[a-zA-Z-]+$` 之后，`/copmact` 照样拦得住，而路径放行。

不认识的命令**不当普通消息发出去**：一个手滑的 typo 就把 `/copmact` 发给模型，
它会礼貌地回一段「你是想…吗」，而人以为自己压缩过了。参数那一行同理——不猜意图，
也不把多出来的那半句悄悄丢掉。

带附件或 `@` 时打命令 → 也拦下来说明白：命令不带附件，那些东西还留在输入框上。

---

## 9. 分割线怎么画

### fold 出一种新块

[`fold()`](../gateway/ui/chat.js) 加一个分支：

```js
} else if (type === 'session/compact' || type === 'session/reset') {
  // 自己成块。**同时把 assistant / tools 断掉**——下一条助手消息不能续写到
  // 分割线之前那一块上，否则线会被画进一个气泡的中间。
  assistant = null
  tools = []
  blocks.push({
    kind: 'mark',
    mark: type === 'session/reset' ? 'reset' : 'compact',
    from: data.from, to: data.to,
    tokensBefore: data.tokensBefore, tokensAfter: data.tokensAfter,
    time: at, seq: ev.seq,
  })
}
```

### 走已有的那条「html 行」

[`threadRows`](../gateway/ui/chat.js) 里 `mark` 块出一条 `{ kind: 'mark', key: 'k'+seq, html }`，
和日期分隔线、「加载更多」同一条路。`syncThread` **一个字都不用改**——它只对
`kind === 'msg'` 调 `updateRow`，别的行按 `html` 建一次节点就完事，`data-key` 也已经在处理了。

样式在 [chat.css](../gateway/ui/chat.css) 里起一个 `.sw-ctxdiv`：一条横线穿过去，
中间留给字（`::before` / `::after` 各占一半）。

**这一条真的画线，和它旁边的 `.sw-daydiv` 不一样**——日期分隔那条注释里写着「再加一条
横贯全宽的线，视觉重量比它要传达的信息（换了一天）重得多」。这里正好相反：「往上翻的
那些，模型这一轮看不见了」比气泡之间的任何间隔都更该被看见。`/new` 的线比压缩再实
一档（压缩还留着摘要，重置什么都不留）。

```
────────────  上下文已压缩 · 128k → 9.2k · 更早的对话仍在记录里  ────────────
────────────  新对话从这里开始 · 上面的内容不再进上下文  ────────────
```

### 顺带修好的一件事

自动压缩画的是**同一条线**。在这之前自动压缩在界面上完全不可见——人只看到 Bot 从某一刻
起开始忘事，没有任何解释。这条线一加，那件事就有了出处。这也是 `by` 字段要落盘的
原因之一：自动那条写的是「上下文快满了，自动压缩了一次」，手动那条写「已压缩上下文」。

### 什么时候看不见它

SSE 推的是最近几轮（`historySlice` 的 tail），更早的边界事件要往上翻才加载得回来——
和日期分隔线一样的行为，可接受。

---

## 10. 上下文占比那颗 chip 必须跟着变

[`chatContextStat`](../gateway/ui/chat.js) 是从后往前扫，找最后一条带真实 usage 的
`assistant/message`。**压缩/重置之后到下一轮之前，它扫到的还是压缩前那个数** ——
人点完 `/compact`，输入框底下那颗 chip 纹丝不动，看起来就是「命令没生效」。

改法：**倒扫时遇到边界事件就停**。停下来还没找到 usage 时：

- `session/compact` → 用它自带的 `tokensAfter` 当估算；
- `session/reset` → 用最后一条 `request/header` 的 `sections` 之和（系统提示词 + Skill +
  工具表那些**清不掉的固定开销**）当估算；写 0 是错的，人下一轮马上会发现对不上。

浮层里那行脚注加一句「估算，下一轮跑完是实测」——这份脚注本来就是用来区分估算和实测的。

**「就停」只对 usage 成立，对 header 不成立**（写的时候才发现，方案里那句话说漏了）：
已经拿到 usage 之后还要接着往前找 `request/header`——分段（系统提示词 / Skill / 工具表）
是这颗 Bot 的属性，不随边界变，而它完全可能落在边界之前。一并停掉的话，那颗 chip 从此
只报一个总量，分段永远出不来了。

---

## 11. 导出、审计、跨版本

**导出**。[`chatExportText`](../gateway/ui/chat.js) 原来按 `b.kind === 'user'` 二分地套
`## 我 / ## Bot` 的壳，`mark` 块会画出一个空的二级标题。现在走一个分支，出一条 `---`
加一行斜体说明。顺带：`chatMetaText` 那句「N 条消息」要把分割线滤掉——它不是谁说的话，
不滤的话压过几次的会话条数会虚高。

**审计**。`/internal/sessions/:id` 是全量原文，两种事件天然带上，不用改。`by` 字段
让「谁切的」这个问题有答案。

**老席位 + 新 UI**（换版期间必然出现）：那两条接口 404。前端要把它翻成
「这台席位的版本还不支持这条命令，升级后可用」，不是一句「出错了」。

**新席位 + 老 UI**：`fold` 忽略不认识的 type，退化成「消息照常、没有那条分割线」。

**回滚**（新日志 + 老席位）：老 `toAgentMessages` 不认 `session/reset`，于是把前文
又带回上下文。方向安全（多带不是少带），但**人点过的 `/new` 会静静失效**——
回滚清单上要写这一条。

---

## 12. 落地清单

| 文件 | 改什么 |
|---|---|
| [bot/src/session/types.ts](../bot/src/session/types.ts) | 加 `session/reset`；`session/compact` 加可选 `by` |
| [bot/src/agent/index.ts](../bot/src/agent/index.ts) | 抽 `contextBoundary()`，三处硬编码改用它；`compactNow` / `resetContext`；`compactOnce` 收 `keepBudget` 参数 |
| [bot/src/web/index.ts](../bot/src/web/index.ts) | 两条 POST，摆在 `/abort` 旁边 |
| [gateway/src/routes/runtime.ts](../gateway/src/routes/runtime.ts) | 两条 `proxyJson` 直转 |
| [gateway/ui/chat.js](../gateway/ui/chat.js) | `CHAT_COMMANDS` 表、`commandQueryAt` / 选单三件套、`parseCommand` + `runChatCommand`、`sendChat` 首行拦、`fold` 的 mark 分支、`threadRows` 的 mark 行、`chatContextStat` 的边界停扫、`chatExportText` 的 mark 分支、composer 里的 `#chat-cmdpick` |
| [gateway/ui/app.js](../gateway/ui/app.js) | `input` 里开合命令选单；`keydown` 里 Esc/上下/回车（排在发送之前） |
| [gateway/ui/chat.css](../gateway/ui/chat.css) | `.sw-ctxdiv` |
| [gateway/ui/i18n.js](../gateway/ui/i18n.js) | 命令名、说明、分割线的英文，**外加席位那几句拒绝的原话**（服务端只发中文，`errText` 在这张表里查） |
| [gateway/ui/prefs.js](../gateway/ui/prefs.js) | `errText` 里多一条正则：「还有 N 条消息排着队」带数字，进不了字典 |
| [bot/e2e-compact.mjs](../bot/e2e-compact.mjs) / [e2e/compact.mjs](../e2e/compact.mjs) | 两组新用例，见 §13 |
| [e2e/run.mjs](../e2e/run.mjs) / [e2e/gateway-chat.mjs](../e2e/gateway-chat.mjs) | HTTP 面各一条 |

`gateway/src/http.ts` 的 `UI_PARTS` **没动**（没有新分片）。

---

## 13. 验收

**边界逻辑**（[bot/e2e-compact.mjs](../bot/e2e-compact.mjs) 的纯函数探针 +
[e2e/compact.mjs](../e2e/compact.mjs) 的断言），两组：

- 「重置点截断照做，但不留摘要」——前面那几轮一句不剩、最后一轮还在、没有摘要抬头、
  第一条是 user、不出现连续同角色；
- 「压缩点和重置点混着来时，只认最后那一条」——两种顺序各一遍；
  其中 `movesPastReset` 那一行钉的就是 §4 那个坑：它挂了 = `scopeAfterBoundary` 只认
  compact，`/new` 之后的第一次自动压缩会把刚扔掉的原文整段放回上下文，而且不报任何错。

**HTTP 面**：

- [e2e/run.mjs](../e2e/run.mjs)（直连席位）：无票 401；`/reset` 成功后日志里真有一条
  `session/reset`、回给前端的 seq 和落盘的一致、**边界落在 `turn/end` 上**、日志只长不短；
  连点两次 409；刚重置完 `/compact` 回 409 且理由带「太短」。一轮都没跑完时改断言那句
  「没跑成过一轮」——不能是 500。
- [e2e/gateway-chat.mjs](../e2e/gateway-chat.mjs)（经 Gateway）：只验通道——无票 401，
  其余不该是 5xx，被拒时必须带得出 `error` 字段。业务判断全在席位那边。

**手测清单**：打 `/co` 弹选单 → 直接打全 `/compact` 回车 → 打 `/xxx` 回车（不该发出去）→
打 `/etc/hosts` 回车（**该照常发出去**）→ 一轮在跑时命令是灰的 → 压缩后 chip 当场变小 →
刷新页面分割线还在 → 另开一个标签页也看得到（SSE 直接推）→ 导出的 Markdown 里那条线
是 `---` 不是空标题。

`pnpm typecheck` 三个包全过。

---

## 14. 这一版不做的

- **不做 `/clear` 当 `/new` 的别名。** 两个名字只会让人猜它们有什么区别。
- **不做 `/new` 之后把上文藏起来。** 往上翻得见，正是「日志不删」的意义所在。
- **不做命令参数。** 第一批两条都不收；真需要「压到只剩三轮」时，那是配置，不是命令行。
  （后来加的 `/model` 是唯一的例外，见下一条。）
- **`/export` 之类的第二批先不做。** `CHAT_COMMANDS` 是张表，加一行的成本很低，
  但每一条都得回答「它落什么事件、界面上留什么痕迹」——没想清楚之前不加。
  `/model` 已经回答过了：落 `session/model`，画一条「从这里起用 xx」的分割线，
  跑着的时候也收（下一轮起生效），带参数 `/model 2` / `/model default` 直接换。
  见 [model-choice.md](model-choice.md)。
