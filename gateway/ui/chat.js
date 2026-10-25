/**
 * 对话。整个前端最重的一块，也是唯一有长连接的一块：
 * 每个 Bot 一条 SSE、事件折叠成消息、增量重绘、以及对话页本身。
 *
 * 按关注点拆成了一串 chat-*.js，顺序就是 index.html 里那串（原来这一个文件从头到尾的顺序，
 * 只把几段不挂监听、不在加载时求值的挪到了它该在的那一片）。这个文件留下的是开头那层：
 * 每个 Bot 的事件桶、到 core 的转接、名单和会话怎么拿、历史怎么补。
 */
let chatAbort = null
let chatStreamId = ''
/**
 * 排着的那次「再拿一遍会话」。同一时刻只允许一条链——见 retryChatSession。
 * 声明摆在这里（而不是挨着那两个函数）：stopChatStream 也要清它，那一个在文件更上面。
 */
let sessionRetryTimer = null
/**
 * 那条重试链认输了没有。输入框底下那行小字要靠它区分「还在等」和「等不到了」——
 * 只看「有没有会话」的话，认输之后那一行还在许愿「接上之后就能发消息」，而这会儿
 * 已经没有任何人在试了。
 */
let sessionGaveUp = false

/**
 * 每个 Bot 一条事件流。
 *
 * 侧栏那份名单要显示「最近一条回复的时间 + 摘要 + 在不在跑」，这三样只能从会话事件里
 * 拿。**只盯当前这条会话是不够的**：人在 A 上派了活、切到 B 去看别的，最想知道的恰恰
 * 是 A 什么时候干完——而以前一切走就把 A 的流掐了，从此两眼一抹黑。
 *
 * 摘要为什么不让 Gateway 给：db.ts 那边写着「会话索引只存指针，不存 user/message 或
 * assistant/message 正文」——正文留在席位机器上，Gateway 只有 sessionId 和计数。为了
 * 名单上一行灰字去破这条边界不划算，而流里本来就有全文。
 *
 * botId -> { sessionId, ac, events, sum, hydrated }
 * sum = { busy, lastAt, lastText }，**增量维护**：每次渲染名单都去 fold 一遍全部事件，
 * 几个 Bot 各七百多条，光滚个侧栏就能把 CPU 吃满。
 * hydrated = 这个桶里的历史是不是已经用 HTTP 补全过（见 hydrateChat）。流上只垫一轮，
 * 不补的话点进去只看得见最后那一问一答。
 */
const botStreams = new Map()

/**
 * **同时开着的对话流的上限。**
 *
 * 这里数的只剩「对话流」了：名单的实时状态已经收进一条通道（见 startRosterStream），
 * 不再是一个 Bot 一条。人切 Bot 时上一条不掐（它可能正在干活，而切回去就不用重放
 * 历史），于是会攒——这道闸就是那个上限。
 *
 * 3 条：当前这条 + 最近待过的两条。每条 SSE 都是一个永不结束的 fetch，HTTP/1.1 下
 * 还各占死一个连接槽（浏览器每个源只给 6 条）；上线挂了 h2 反代之后这个上限不再是
 * 硬墙（见 docs/gateway-runtime.md §7.1），但攒着的每一条同样占着一台席位的连接和
 * 一份事件桶，没有理由留更多。
 */
const BOT_STREAM_MAX = 3

/**
 * 留在内存里的事件桶上限。**和上面那道闸是两回事**：桶占的是内存，流占的是连接，
 * 而流关掉之后桶还留着——切回那个 Bot 时不用再重放一遍历史。
 */
const BOT_BUCKET_MAX = 8

function botStreamOf(botId) {
  let row = botStreams.get(botId)
  if (!row) {
    // instanceId = 上次连上时席位自报的那个进程身份（见 runtime/hello）。空 = 还没连过。
    row = { sessionId: '', instanceId: '', ac: null, events: [], sum: SatuCore.newSum(), hydrated: false, hydrating: null }
    botStreams.set(botId, row)
  }
  return row
}

/**
 * 换了一条会话（席位重建过）——这一行上属于旧会话的东西**全部**作废。
 *
 * 「全部」包括还在飞的那两样，它们才是真正咬人的：
 *
 * · **那条流**。留着它有两笔账。startChatStream 的「已经在跑」闸认的是
 *   `row.sessionId === sessionId && row.ac`，而调用方紧接着就把 sessionId 改成新的
 *   ——闸于是误触发、直接 return，**新会话一条流都开不出来**。同时旧流自己还活着：
 *   它的读循环里 `isActive()` 已经是 false，两道 break 都不成立，于是继续往这只
 *   （刚清空的）桶里灌旧会话的事件，画出来就是另一条对话。
 *
 * · **在飞的那次 hydrate**。它拉的是旧会话的历史。不清掉的话，hydrateChat 那道
 *   「别拉两遍」的闸会把新会话挡在门外，并且返回旧会话那只 promise；旧的一醒来发现
 *   串台就自己走了，于是**新会话的历史从此没人去拉**，界面永远停在流垫的那一轮。
 *
 * 漏清 hydrated 的症状是新会话永远不去拉历史。
 *
 * **`sum` 只清能点的那几样，不整个换掉**——理由见下面那一段。
 */
function resetBotStream(row) {
  if (row.ac) {
    try {
      row.ac.abort()
    } catch {}
    dropPulse(row.ac)
    // 它可能正是「当前那条」。闩留着指向一个已经掐掉的流，后面谁也认不回来。
    if (chatAbort === row.ac) {
      chatAbort = null
      chatStreamId = ''
    }
    row.ac = null
  }
  row.hydrating = null
  row.events.length = 0
  /**
   * **摘要不整个换掉，只清「能点的」那几样。**
   *
   * `sum` 已经不是这条对话流的派生物了——它归名单通道管（见 startRosterStream）。整个
   * 换成空的等于把侧栏那一行抹白，而通道只在**变化时**发帧，不会因为你丢了状态就重发
   * 一遍：那一行要等这颗 Bot 下次开口才回得来。换版重启时每一颗被重置的 Bot 都会这样
   * 白一次，而换版恰恰是人最想从名单上看出「谁回来了」的时候。
   *
   * 但 `openIds` / `asks` 必须清：它们记的是「**这条会话**上还等着人处理的单子和确认」，
   * 会话都换了，它们的终态事件永远不会来，留着就是一颗永远灭不掉的「在等你」。
   * `lastText` / `lastAt` 只是一行灰字，旧一点也诚实，通道下一帧就盖掉了。
   */
  row.sum.openIds = null
  row.sum.snapIds = null
  row.sum.asks = null
  row.sum.busy = false
  settleDot(row.sum)
  row.hydrated = false
}

/** 那颗点现在算哪一态（在等人 > 正在跑 > 空闲）。实现在 core/src/chat/roster.ts。 */
function settleDot(sum) {
  return SatuCore.settleDot(sum)
}

/**
 * 名单上所有 Bot 此刻正等着人拍板的确认，摊平成一张表。
 *
 * **数据源是名单那条通道**（startRosterStream，一条管所有 Bot），不是 Gateway：
 * 确认停在席位的内存里，压根没上过 Gateway（见 docs/handoff.md §2——它和交接单的
 * 时间尺度、存活方式都不一样，不该塞进那张表）。所以「谁在等你拍板」这个问题，
 * 浏览器这边是唯一答得上来的地方。
 */
function pendingApprovals() {
  const out = []
  for (const [botId, row] of botStreams.entries()) {
    const asks = row && row.sum && row.sum.asks
    if (!asks || !asks.size) continue
    for (const a of asks.values()) out.push({ ...a, botId })
  }
  // 新的排前面：一个刚弹出来的确认后面多半还有人在等着看结果。
  return out.sort((x, y) => (y.at || 0) - (x.at || 0))
}

/**
 * 拿 Gateway 那份待办清单把名单上的点对一遍。
 *
 * **只靠事件是不够的**：流上只垫最近一轮（STREAM_TAIL_TURNS），昨天半夜开出来的那张单
 * 根本不在里面——而那正是最需要被看见的一张。Gateway 那张表是跨 Bot、跨机器的，
 * 30 秒轮一次（loadHandoffs），把每颗 Bot 该亮的点补上。
 */
function applyHandoffSnapshot(list) {
  const byBot = new Map()
  for (const h of list || []) {
    if (h.state !== 'open' && h.state !== 'claimed') continue
    const set = byBot.get(h.botId) || byBot.set(h.botId, new Set()).get(h.botId)
    set.add(h.id)
  }
  let changed = false
  for (const [id, row] of botStreams.entries()) {
    const sum = row.sum
    const before = sum.state
    /**
     * 快照单独一份，**不和事件那一份合并**。
     *
     * 合并成一个集合的话，别人在另一台机器上关掉的那张单就再也销不掉了：这条流上
     * 没有它的事件，而每一轮快照又会被并回去。两份各管各的：快照整份换掉（远端的
     * 变化 30 秒内跟上），事件那份负责当场生效。
     */
    sum.snapIds = byBot.get(id) || new Set()
    settleDot(sum)
    if (sum.state !== before) changed = true
  }
  if (changed) scheduleRosterPaint()
}

/**
 * 事件到了就地更新摘要。O(1)，不 fold。归并规则在 core/src/chat/roster.ts 的 applyRosterEvent，
 * 这里只负责「变了就重画名单」。
 */
function noteBotEvent(botId, ev) {
  const row = botStreams.get(botId)
  if (!row) return
  if (SatuCore.applyRosterEvent(row.sum, ev)) scheduleRosterPaint()
}

/**
 * 从桶里重新认一遍「最近一条消息」（补完历史之后走这里，不走 noteBotEvent——理由见
 * core/src/chat/roster.ts 的 refreshSum）。
 */
function refreshSum(row) {
  if (SatuCore.refreshSum(row.sum, row.events)) scheduleRosterPaint()
}

/**
 * 往桶里追一条事件，**已经有的就不追**。返回它是不是新的。按 seq 插入并去重（到达顺序不保证
 * 有序），规则见 core/src/chat/events.ts 的 insertEvent。
 */
function pushBotEvent(botId, ev) {
  return SatuCore.insertEvent(botStreamOf(botId).events, ev)
}

/** 关掉一个 Bot 的流。事件留着——切回去时就不用再重放一遍历史。 */
function closeBotStream(botId) {
  const row = botStreams.get(botId)
  if (!row) return
  if (row.ac) {
    try {
      row.ac.abort()
    } catch {}
  }
  row.ac = null
}

/**
 * 开着的流有几条。
 *
 * **闸要按这个数把，不能按 `botStreams.size`。** 后者是「攒过几个 Bot 的事件桶」，
 * 流关掉之后桶还留着（切回去不用再重放历史），拿它当连接数会算多——而算多的方向
 * 恰恰是「以为已经超了」，于是该开的流反倒开不出来。
 */
function openBotStreams() {
  let n = 0
  for (const row of botStreams.values()) if (row.ac) n++
  return n
}

/**
 * 超出上限就先关最久没动静的那条；桶另算一道闸。
 *
 * **只关空闲的**：一条正在跑的对话流断掉，那一轮的正文就没人接了。名单上那颗点不受
 * 影响——它现在归名单通道管（startRosterStream），跟这个 Bot 有没有开着对话流无关。
 *
 * 关流**不丢桶**：切回那个 Bot 时还有历史可看。桶多到 BOT_BUCKET_MAX 才清事件，
 * 而且**只清事件、不删这一行**（行上挂着名单要的 sum）。
 */
function trimBotStreams(keepId) {
  const rows = [...botStreams.entries()].filter(([id, r]) => id !== keepId && r.ac && r.sum.state === 'idle')
  rows.sort((a, b) => a[1].sum.lastAt - b[1].sum.lastAt)
  while (openBotStreams() > BOT_STREAM_MAX && rows.length) closeBotStream(rows.shift()[0])
  /**
   * 桶占的是内存，另算一道闸。**但只清事件，不删这一行**——行上还挂着 `sum`，那是
   * 名单上那一行灰字（在不在跑、最近说了什么）唯一的落脚处，而它现在由名单通道喂，
   * 跟这个 Bot 有没有开过对话流没关系。删掉行等于把侧栏那几行清空，而且再也不会
   * 自己长回来（通道只在**变化时**发帧，不会因为你丢了状态就重发一遍）。
   */
  /**
   * **两道守卫，各挡一种翻车法，缺一不可。**
   *
   * · `r.events !== state.chatEvents`——`state.chatEvents` 和某一行的 `events` 是**同
   *   一个数组对象**（见 ensureChatSession 那三处赋值）。正看着的那个 Bot 的流断在
   *   重连间隙时 `ac` 是 null，不挡住的话它会被当成冷桶清掉，而清的正是屏幕上那份。
   *   `keepId` 挡不住它：trim 是别的 Bot 开流时调的，keepId 是那个 Bot。
   * · **清是 `length = 0`，不是 `= []`。** 换数组会把上面那个别名切断：新事件落进新
   *   数组，`state.chatEvents` 还指着旧的，于是那条对话静默停止更新，连
   *   hydrateChat 也救不回来（它填的也是新数组）。全文清空一律用这个写法。
   */
  const fat = [...botStreams.entries()].filter(
    ([id, r]) => id !== keepId && r.events.length && !r.ac && !r.hydrating && r.events !== state.chatEvents,
  )
  if (fat.length <= BOT_BUCKET_MAX) return
  fat.sort((a, b) => a[1].sum.lastAt - b[1].sum.lastAt)
  for (const [, row] of fat.slice(0, fat.length - BOT_BUCKET_MAX)) {
    row.events.length = 0
    // 桶空了就得允许下次重新补历史，否则点进去只剩流垫的那一轮。
    row.hydrated = false
  }
}

/* ══ 转接到 core.js：消息正文的几个读法，实现在 core/src/chat/events.ts ══
   写成函数声明而不是 `const x = SatuCore.x`：e2e 的 chat-fold.mjs 把这个文件装进 vm 上下文、按
   属性读这些名字，顶层 const 不会挂到全局对象上，函数声明才会。下面几处同理。 */
function messageImages(msg) {
  return SatuCore.messageImages(msg)
}

function messageText(msg) {
  return SatuCore.messageText(msg)
}

/**
 * 消息里的 `@` 点名块。
 *
 * 落盘的是结构（`{type:'mention', kind, id, label}`，见 bot 的 session/types.ts），
 * 正文里一个字都没有——`messageText` 也是这么约定的。所以要显示成药丸只能从这里取。
 */
/**
 * 一颗点名药丸的内容：**有图标就画图标，没有才画那个 `@`**。
 *
 * 两者说的是同一件事——「这一颗是点名，不是随手带的附件」。图标把它说得更清楚（一眼
 * 认出是哪一家），那就不必再顶一个 `@` 在前面；图标取不到时才轮到 `@` 顶上，不然药丸
 * 退化成一个看不出来历的普通标签。
 *
 * 图标只有候选清单里有（`/mentions` 的 `logo`）。消息里存的是 `{kind,id,label}`，所以
 * 历史那条要按 id 回候选里查（候选在 loadChatPage 里就拉了）。
 *
 * 图标 404 的那一下也要接住：换成 `@`，不是删掉——删掉的话那颗药丸既没图标也没 `@`。
 * 动作走 `data-onerror`，由 shell.js 那个 document 上的捕获监听器执行（内联 onerror
 * 会逼着 CSP 放开 script-src 的 'unsafe-inline'，见 mediaFallback）。
 */
function mentionPill(m) {
  const known = (state.mentionOptions || []).find((x) => x.id === m.id)
  // @ 的是一颗 Bot：药丸上画它的头像（历史那条只有 {kind,id,label}，头像按 id 回候选或名单里查）。
  if (m.kind === 'bot') {
    const bot = known || (state.runtimeBots || []).find((b) => b.id === m.id)
    const head = bot ? `<span class="sw-mention-bot">${botAvatar(bot.icon, 14, bot.origin)}</span>` : '@'
    return `<span class="sw-mention">${head}<span>${esc(m.label)}</span>`
  }
  const logo = m.logo || known?.logo || ''
  const head = logo ? `<img src="${esc(logo)}" alt="" data-onerror="at">` : '@'
  return `<span class="sw-mention">${head}<span>${esc(m.label)}</span>`
}

function messageMentions(msg) {
  return SatuCore.messageMentions(msg)
}

function messageRefs(msg) {
  return SatuCore.messageRefs(msg)
}

/**
 * 每条会话「此刻在不在跑」——**bot 亲口说的那一份**，不是扫事件扫出来的。
 *
 * 扫出来的那个（fold 里的 status）有个前提：手上这份历史是完整的。而它经常不成立，
 * 两种情况都很常见，表现完全一样——界面一直挂着「正在处理」，那边其实什么都没在跑：
 *
 *   · 流断在重放中途，尾巴那条 turn/end 没到；
 *   · 进程半路没了（崩溃、机器重启、每一次「重新部署」），日志里那条 turn/end 根本
 *     没写成，要等 bot 下次从磁盘读这条会话才补得上。
 *
 * 所以 bot 在 replay/done 上带了 live，收到就以它为准，之后再由实时的 turn 事件维护
 * ——那些是连着的时候一条条来的，可信。
 *
 * 键是 sessionId 而不是 botId：低层直接开的流（重连、测试）没有归属，但一样要有结论。
 * 没有这一项就说明 bot 没表态（老版本不带这个字段，或者流断在 replay/done 之前），
 * 那就回落到扫描——和以前一个样，不会更差。
 */
const chatLive = new Map()

/**
 * 每条会话的翻页状态：`{ firstSeq, hasMore, loading }`。
 *
 * 打开对话只取最近几轮，往上翻再一页页往前推。以前是整段推——实测 1078 条，慢，而且
 * 尾巴容易压在下游缓冲里出不来，那正是「历史缺一截 + 永远正在处理」的成因。
 * `firstSeq` 是手上最靠前那条的 seq，也就是再往前翻的游标。
 *
 * **三个地方都写这一对**：`hydrateChat` 拉回第一页、`loadOlderChat` 往前翻、流上的
 * `replay/done`。所以写入统一走 noteChatPage，别各写各的。
 */
const chatPages = new Map()

/**
 * 记下「手上最靠前那条是谁」和「它前面还有没有」。合并规则（谁知道得更早谁说了算）在
 * core/src/chat/pages.ts 的 mergeChatPage；三个写入方都走这里，别各写各的。
 */
function noteChatPage(sessionId, next) {
  chatPages.set(sessionId, SatuCore.mergeChatPage(chatPages.get(sessionId), next))
  scheduleLoadMorePaint()
}

/**
 * 每条会话排着的消息：`[{ id, text, mentions, images, createdAt }]`。
 *
 * **真相在席位那边**，这里只是它推过来的一份副本。放浏览器里自己记的话，刷新一次
 * 就丢、两个标签页各排各的，而消息其实已经发出去了——「界面上没有但它还是跑了」是
 * 最糟的一种状态。
 */
const chatQueues = new Map()

/** 历史一页几轮。人来是看最近说了什么的，更早的等他往上翻。 */
const CHAT_TAIL_TURNS = 20

/**
 * 流上垫几轮历史。
 *
 * **历史和实时拆成了两条路**：历史走 HTTP（`hydrateChat` / `loadOlderChat`，一次
 * 请求一页，promise 落地就是「拿全了」），SSE 只管实时那一段。
 *
 * 为什么不是 0：
 *
 *   · 名单上那行灰字（最近一条消息 + 时间）要有个来源，垫一轮就够，而 `tail=0` 在
 *     席位那边的含义是「整段推」（historySlice 的 turns=0 不切），正好相反；
 *   · 点进一个 Bot 的**第一帧**要有东西可看。历史那次 HTTP 还在路上时，屏幕上先有
 *     最后一问一答，比空白诚实。
 *
 * 为什么不是 20：这一轮是给「点进去的第一帧」垫的，二十轮那份由 hydrateChat 走 HTTP
 * 拉，两条路各司其职（见 docs/gateway-runtime.md §12）。
 */
const STREAM_TAIL_TURNS = 1

/** 用户消息开头那段「我上传了文件，在工作区里：」是 composeChatBody 拼的；认回来的实现在 core/src/chat/events.ts。 */
const UPLOAD_LEADS = SatuCore.UPLOAD_LEADS

function splitUploads(text) {
  return SatuCore.splitUploads(text)
}

/**
 * 把一串会话事件折成气泡。**实现在 core/src/chat/fold.ts**——一字没改地搬过去的（Telegram 来源、
 * 空壳工具、压缩落在轮中间、/clear……每一条都有线上事故在后面）。改它去那边，改完重打 core.js，
 * e2e 的 chat-fold.mjs 和 ui-smoke 仍经这里喂它。
 */
function fold(events, live, channelBot = false) {
  return SatuCore.fold(events, live, channelBot)
}

/** 只有绑定了 Telegram 渠道的 Bot 才显示 Web / Telegram 来源角标。 */
function currentBotHasChannelLabels() {
  const id = chatBotIdNow()
  return Boolean(id && (state.runtimeBots || []).some((bot) => bot.id === id && bot.channel === 'telegram'))
}

/**
 * 放掉「当前流」这把闩，但不 abort。
 *
 * 建连失败的几条路径（fetch 抛、503、非 2xx）以前直接 return，把 chatAbort /
 * chatStreamId 留在「已占用」状态。ensureChatSession 和 startChatStream 都靠这两个值
 * 判断「已经有流在跑」，于是一次实例还没起来的 503 之后，聊天再也不会重连——要刷新
 * 整页才回得来。
 */
function releaseChatStream(ac, owner) {
  // 还要把 Bot 那一行的 ac 清掉：它是「这条流还活着」的唯一判据——ensureChatSession 的
  // 热路径靠它决定要不要直接把正文接回去，chatStreamAlive 靠它决定发消息前要不要重连。留着
  // 一个已经死掉的 ac，那两处就都以为流还在跑，于是谁也不再重连：切回这个 Bot 只会接到
  // 一个空的事件桶，刷新整页才回得来。
  const row = owner ? botStreams.get(owner) : null
  if (row && row.ac === ac) row.ac = null
  // 看门狗那本脉搏账也一起销掉（见 notePulse）：这条流已经不归任何人了。
  dropPulse(ac)
  if (chatAbort !== ac) return
  chatAbort = null
  chatStreamId = ''
}

function stopChatStream() {
  // 排着的那次「再拿一遍会话」也一起停。退出登录走的就是这条路（见 app.js 的
  // logout），留着它的话，票都清了它还会照着上一个人的 Bot 再敲十几次接口。
  cancelSessionRetry()
  if (chatAbort) {
    try {
      chatAbort.abort()
    } catch {}
    dropPulse(chatAbort)
  }
  chatAbort = null
  chatStreamId = ''
}

/**
 * 一个 Bot 被删掉了：把对话页上属于它的东西全部拆掉。
 *
 * 「删除当前 Bot」原先只清了 state.bot 就 go('/')——chatBotId 还指着那个已经不存在的
 * Bot，正文、会话 id、桌面运行时全留着，流和长跑还在照着一个已删的席位敲接口。
 * 拆的东西照着退出登录那条路（app.js 的 logout）来，但**只拆这一个 Bot 的**：名单上
 * 别的 Bot 的流和长跑不能跟着断。
 */
function forgetChatBot(botId) {
  if (!botId) return
  closeBotStream(botId)
  botStreams.delete(botId)
  cancelIdleRetry(botId)
  cancelIdleRetry('session:' + botId)
  if (heldSend && heldSend.botId === botId) clearHeldSend()
  if (state.chatDrafts) delete state.chatDrafts[botId]
  if (state.chatBotId !== botId) return
  stopChatStream()
  if (state.chatSessionId) chatLive.delete(state.chatSessionId)
  state.chatBotId = ''
  state.chatSessionId = ''
  state.chatEvents = []
  state.chatDraft = ''
  state.chatPending = []
  state.chatStatus = ''
  state.wsDirs = {}
  state.wsOpen = {}
  state.wsSession = ''
  state.desktopRuntime = null
  state.desktopRuntimeAt = 0
  unmountDesktop()
}

async function loadRuntimeBots() {
  state.runtimeError = ''
  try {
    const before = state.runtimeBots || []
    const data = await api('GET', '/runtime/bots')
    state.runtimeHasMachine = typeof data.hasMachine === 'boolean' ? data.hasMachine : null
    /**
     * 公司没配运行机器时，全局 / 公司 Bot 永远装不上（它们只能是远程的），摆在名册里只会
     * 是一排「公司的运行机器还没配好」。这时候名册里只留本人建的——本地 Bot 用得了，
     * 自己建过的远程 Bot 也留着，那是本人的东西，删不删由本人定。
     */
    // 还在路上的「移到分类」盖回去：服务端那份这时还是旧的（shell.js 的 applyPendingFolders）。
    state.runtimeBots = applyPendingFolders((data.bots || []).filter((bot) => state.runtimeHasMachine !== false || bot.scope === 'user'))
    state.botFolders = Array.isArray(data.folders) ? data.folders : []
    state.mainBotId = typeof data.mainBotId === 'string' ? data.mainBotId : ''
    // 本地 Bot 在不在跑、听哪个口，Gateway 不知道（隧道拆了），只有壳子知道。
    await overlayLocalRuntime(state.runtimeBots)
    // 名单流的直连地址（机器够新、配了公网地址、这个人没有本地 Bot 时才有），没有就是 null。
    // Gateway 不再反代这条流，所以地址一到就得起、一换就得重开——这一次刷新可能正是
    // 管理员刚在「机器」页填完 directUrl 之后的那一次。
    state.rosterStreamUrl = data.rosterStreamUrl || ''
    syncRosterStream()
    reviveDirectChatStream()
    if (window.__SATUWORK_LOCAL_BOT__?.stop) {
      const ids = new Set(state.runtimeBots.map((bot) => bot.id))
      for (const bot of before) {
        if (bot.runtimeKind === 'local' && !ids.has(bot.id)) void window.__SATUWORK_LOCAL_BOT__.stop(bot.id).catch(() => {})
      }
    }
    void ensureDesktopLocalBots(state.runtimeBots)
  } catch (err) {
    state.runtimeBots = []
    throw err
  }
}

const localBotStarts = new Map()

/**
 * 给本地 Bot 补上运行状态。Gateway 那份 `runtime` 对本地 Bot 只是个占位（它再也连不到
 * 本机了），真相在壳子手里：在不在跑、听哪个口。顺手把直连要用的口和票登记进 localBots——
 * 页面刷新之后进程还在，票却只在内存里，得再向 Gateway 要一次。
 *
 * **登录票换过也要再要一次**（见 data.js 的 localBots）：改口令、被管理员重置之后，进程手上
 * 那把票已经作废。要回来的交给壳子的 start——同一把什么都不动，换了一把就用新票把进程
 * 重起一遍（desktop 的 start_local_bot），口也可能跟着换。
 */
async function overlayLocalRuntime(bots) {
  const bridge = window.__SATUWORK_LOCAL_BOT__
  for (const bot of bots || []) {
    if (bot.runtimeKind !== 'local') continue
    if (!bridge || typeof bridge.status !== 'function') {
      bot.runtime = { kind: 'local', status: 'none', machineLink: 'offline', workspace: 'desktop' }
      continue
    }
    try {
      const s = await bridge.status(bot.id)
      const running = Boolean(s && s.running && s.port)
      bot.runtime = {
        kind: 'local',
        status: running ? 'ready' : 'none',
        machineLink: running ? 'online' : 'offline',
        workspace: (s && s.workspace) || 'desktop',
        port: running ? s.port : null,
        // 壳子的运行时指针（local-runtime/CURRENT / PENDING / LAST_ERROR）。字段名跟远程
        // 席位的 runtime.botVersion 对齐：Bot 设置页那一行版本号两种 Bot 读同一个名字。
        botVersion: (s && s.runtimeVersion) || null,
        pendingVersion: (s && s.pendingRuntimeVersion) || null,
        updateError: (s && s.runtimeUpdateError) || null,
      }
      const known = localBots.get(bot.id)
      if (running && (!known || !known.token || known.login !== token())) {
        const started = await startDesktopLocalBot(bot.id)
        if (started && started.port) bot.runtime.port = started.port
      } else if (running) registerLocalBot(bot.id, s.port)
    } catch {
      bot.runtime = { kind: 'local', status: 'none', machineLink: 'offline', workspace: 'desktop' }
    }
  }
}

async function startDesktopLocalBot(botId) {
  const bridge = window.__SATUWORK_LOCAL_BOT__
  if (!window.__SATUWORK_DESKTOP__ || !bridge || typeof bridge.start !== 'function') {
    throw new Error(t('请在 Satuwork Desktop 中启动本地 Bot', 'Open Satuwork Desktop to start this local bot'))
  }
  const bootstrap = await api('POST', `/runtime/bots/${encodeURIComponent(botId)}/local-bootstrap`, {})
  const status = await bridge.start(bootstrap)
  if (status && status.port) registerLocalBot(botId, status.port, bootstrap.accessToken)
  if (status && status.runtimeUpdateError) {
    state.deployHint = t(
      `本地 Bot 已用旧版本启动；自动升级失败：${status.runtimeUpdateError}`,
      `The local bot started on the previous version; automatic update failed: ${status.runtimeUpdateError}`,
    )
  }
  return status
}

async function ensureDesktopLocalBots(bots) {
  if (!window.__SATUWORK_DESKTOP__ || !window.__SATUWORK_LOCAL_BOT__) return
  const now = Date.now()
  for (const bot of bots || []) {
    if (bot.runtimeKind !== 'local' || (bot.runtime && bot.runtime.status === 'ready')) continue
    if (now - (localBotStarts.get(bot.id) || 0) < 10_000) continue
    localBotStarts.set(bot.id, now)
    void startDesktopLocalBot(bot.id).catch((err) => {
      state.deployHint = err instanceof Error
        ? err.message
        : String(err || t('本地 Bot 启动失败', 'Could not start the local bot'))
      if (chatBotIdOf(state.path) === bot.id) render()
    })
  }
}

async function loadRuntimeMachine() {
  const id = orgId()
  if (!id || isOwner()) {
    state.runtimeMachine = null
    return
  }
  try {
    const data = await api('GET', `/orgs/${encodeURIComponent(id)}/machine`)
    state.runtimeMachine = data.machine || null
  } catch {
    state.runtimeMachine = null
  }
}

/**
 * 现在这一屏对着的是哪个 Bot。地址优先于 state：`go()` 先改地址再去拉数据，切换
 * 途中 state.chatBotId 还是上一个（见 ensureChatSession），照它去拉就是拉错人。
 */
function chatBotIdNow() {
  return chatBotIdOf(state.path) || state.chatBotId
}

async function loadDesktopRuntime(botId) {
  const id = botId || chatBotIdNow()
  if (isOwner() || !id) {
    state.desktopRuntime = null
    state.desktopRuntimeAt = 0
    return
  }
  let rt
  try {
    rt = await api('GET', '/runtime/desktop?botId=' + encodeURIComponent(id))
  } catch {
    // 期间人已经切走了：这次的失败也不作数，别把新 Bot 的席位清成 null。
    if (chatBotIdNow() !== id) return
    state.desktopRuntime = null
    state.desktopRuntimeAt = 0
    return
  }
  // 这一份是给 `id` 拉的。人在等待期间换了 Bot 的话，认领它就等于把新 Bot 的席位
  // 顶掉——右栏会显示上一个 Bot 的路径和桌面，而对话是新的那个。
  if (chatBotIdNow() !== id) return
  state.desktopRuntime = rt
  state.desktopRuntimeAt = Date.now()
}

/**
 * 把最近一页历史用**一次 HTTP** 拉回来，填进这个 Bot 的事件桶。
 *
 * 这是「历史」和「实时」拆成两条路里的那一条。以前两件事挤在同一条 SSE 上：连上先推
 * 二十轮历史，推完发一条 `replay/done` 说「后面是实时的了」。挤在一起有三笔账：
 *
 *   · **「放完了没有」只能猜。** 历史和实时是同样的 `data:` 帧，客户端分不出来，只好
 *     靠 replay/done 这个标记加三个定时器（REPLAY_QUIET/MAX/STALL）兜着。HTTP 不用
 *     猜——promise 落地就是拿全了。
 *   · **尾巴会压在下游缓冲里。** 实测 bot 报重放 1078 条、客户端只收到 1054 条，
 *     replay/done 从没到达（见 bot 的 web/index.ts）。JSON body 没有这个失败模式：
 *     要么整段拿到，要么抛。
 *   · **名单上每个 Bot 都要开一条流**，二十轮乘几个 Bot 全在主线程上 parse，换来的
 *     只是侧栏一行字。
 *
 * 和往上翻用的是同一个接口、同一个切片函数（席位那边的 historySlice），区别只是不带
 * `before`——也就是「最新的一页」。
 *
 * **不 await 也能用**：调用方开完流就走，这边拉回来自己重画。屏幕上先是流垫的那一轮，
 * 历史到了再从上面接进去。
 */
async function hydrateChat(botId, sessionId) {
  const row = botStreamOf(botId)
  if (!sessionId || row.sessionId !== sessionId || row.hydrated) return
  // 两个入口都会叫它（切过去时一次、席位回来重连时一次），别拉两遍。
  if (row.hydrating) return row.hydrating
  const job = (async () => {
    let data
    try {
      data = await api('GET', `/runtime/sessions/${encodeURIComponent(sessionId)}/history?turns=${CHAT_TAIL_TURNS}`)
    } catch (err) {
      // 席位没上线之类。**不置 runtimeError**：流那边正在为同一件事重试，两处都喊
      // 会把「实例还没上线」和「连接断开」轮流刷在同一行上。留着 hydrated=false，
      // 下次切过来再试，人也可以点顶上那个「加载更早的对话」自己重来。
      return
    } finally {
      // 只清自己那一把。会话换过之后这里可能已经是**新一轮**的 job 了，清掉它就等于
      // 把那道「别拉两遍」的闸打开。
      if (row.hydrating === job) row.hydrating = null
    }
    // 拉回来这一路上，席位可能重建过会话——那这份历史属于另一条对话，认了就是串台。
    if (row.sessionId !== sessionId) return
    // **空 body 也是 200。** api() 在 body 为空时返回 null（Gateway 的 proxyJson 同样
    // 把席位的空 body 转成 200 + null），下面那几个 data.xxx 会当场抛——而 hydrated
    // 已经置位了，于是这个 Bot 从此不再重拉，永远停在流垫的那一轮。当成拉失败处理：
    // 不置 hydrated，切走再切回来会重来一次。
    if (!data) return
    const older = data.events || []
    // **只收比手上最靠前那条还早的。** 流垫的那一轮和这一页必然重叠，而 seq 是日志
    // 行号、天然单调，所以「比头还小」既是去重也保证了插进去之后仍然有序。
    const head = row.events.length ? Number(row.events[0].seq) : Infinity
    const add = older.filter((ev) => Number(ev.seq) < head)
    if (add.length) {
      const thread = state.chatSessionId === sessionId ? document.getElementById('chat-thread') : null
      // 往开头插东西会把视线甩走，和翻页是同一个补法（见 loadOlderChat）。
      chatAnchorHeight = thread ? thread.scrollHeight : 0
      row.events.unshift(...add)
    }
    row.hydrated = true
    // 这些是**旧**事件，不能走 noteBotEvent（它按「刚到的最新」写）。
    refreshSum(row)
    noteChatPage(sessionId, { firstSeq: data.firstSeq, hasMore: data.hasMore })
    if (state.chatSessionId === sessionId) paintChat()
    void syncApprovals(botId, sessionId)
    void syncHandoffs(botId, sessionId)
    void syncTodos(botId, sessionId)
  })()
  row.hydrating = job
  return job
}

function maxSeqOf(events) {
  return SatuCore.maxSeqOf(events)
}

/**
 * 核对一遍「这几张交接单在席位上还认不认」。
 *
 * 和确认那一套（syncApprovals）同一个道理，只是失效的原因不同：交接单是**落盘**的，
 * 正常情况下重启也还在；但席位重装、换机器、手工清过库之后，会话日志里那条 open
 * 还在，而单子已经没了——照着日志画出来的卡片带着一整排按钮，点下去只换回一句 409。
 *
 * 水位（`upto`）取在发请求之前，判据按**日志行号**比，不按时间比：那是两台机器各自
 * 的钟（见 approvalDead 那段说明）。
 */
async function syncHandoffs(botId, sessionId) {
  const upto = maxSeqOf(botStreamOf(botId).events)
  try {
    const data = await api('GET', `/runtime/sessions/${encodeURIComponent(sessionId)}/handoffs`)
    const ids = new Set(((data && data.handoffs) || []).map((h) => h.id))
    state.chatHandoffs = { sessionId, ids, upto }
    if (state.chatSessionId === sessionId) paintChat()
  } catch {
    // 席位没上线、或者老版本没有这条路由。**什么都不做**：宁可留一张可能点不动的卡片，
    // 也不要把一件真的等着人的事画成失效——那会让人以为不用管它。
  }
}

/**
 * 这张卡还点得动吗。
 *
 * 判据必须是「确定不在了」：这张单在核对那一刻之前就落了盘，而席位报回来的清单里
 * 没有它。终态的那些本来就不画按钮，不参与这个判断。
 */
function handoffDead(h) {
  if (h.state !== 'open' && h.state !== 'claimed' && h.state !== 'returned') return false
  const snap = state.chatHandoffs
  if (!snap || snap.sessionId !== state.chatSessionId || !snap.upto) return false
  return Boolean(h.seq && h.seq <= snap.upto && !snap.ids.has(h.id))
}

/**
 * sessionId → 这条会话待办清单的一张快照（`{ items, upto }`）。
 *
 * **按会话存，不是一个槽。** 单槽的话，A → B → A 这么切一圈，槽里留的是 B 那一份，
 * 而 `chatTodoItems` 认不出会话就只好退回「只看事件」——那时 dock 会在一张真有未完成
 * 清单的会话上**静静地空掉**，正好是这一跳本来要解决的那件事（确认卡和交接单也是
 * 单槽，但它们认不出时退化成「当它还活着」，方向是安全的；这里的退化方向不是）。
 */
const chatTodoSnap = new Map()

/**
 * 拉一次这条会话现在的待办清单。
 *
 * **事件不够。** dock 平时靠 `todo/list` 事件跟着动，可流上只垫最近一轮
 * （STREAM_TAIL_TURNS）——一张三天前列出来、还没做完的表根本不在里面，而那正是最该
 * 被看见的一张：人今天早上打开这一页，第一件想知道的事就是「昨天那摊活做到哪儿了」。
 *
 * **拿到过就不再拉**，也不轮询：这条会话只有一个人在看，而看着的时候每一次改动都有
 * 事件跟过来（不像交接单，那是跨 Bot、跨机器、别人也能改的东西）。反过来，**没拿到
 * 就还会再试**——这条闸让「席位当时没上线」不至于变成「这一页从此没有 dock」：
 * `hydrateChat` 拉过一次就再也不进（`row.hydrated`），全靠切回来这一下补。
 *
 * 水位（`upto`）取在发请求之前，和事件谁新按 seq 比（理由见 approvalDead）。
 */
async function syncTodos(botId, sessionId) {
  if (!sessionId || chatTodoSnap.has(sessionId)) return
  const upto = maxSeqOf(botStreamOf(botId).events)
  try {
    const data = await api('GET', `/runtime/sessions/${encodeURIComponent(sessionId)}/todos`)
    chatTodoSnap.set(sessionId, { items: (data && data.todos) || [], upto })
    if (state.chatSessionId === sessionId) paintChat()
  } catch {
    // 席位没上线、或者老版本没有这条路由。**不写进表**：留着空位，下次切回来会再试一次。
    // dock 这一轮退回只认事件那一份，也就是加这一跳之前的行为。
  }
}

async function syncApprovals(botId, sessionId) {
  const upto = maxSeqOf(botStreamOf(botId).events)
  try {
    const data = await api('GET', `/runtime/sessions/${encodeURIComponent(sessionId)}/approvals`)
    const ids = new Set(((data && data.pending) || []).map((p) => p.callId))
    state.chatApprovals = { sessionId, ids, upto }
    if (state.chatSessionId === sessionId) paintChat()
  } catch {
    // 席位没上线、或者这台席位还是老版本没有这条路由。**什么都不做**：宁可留着一张
    // 可能点不动的卡片，也不要把一条真的在等的确认画成失效——那会让人以为不用管它。
  }
}

/**
 * 这张卡片还点得动吗。
 *
 * 只有一条判据，而且必须是「确定不在等了」：这条确认在核对那一刻之前就落了盘，
 * 而席位报回来的待办里没有它。超时那一路不靠这里——席位超时时会自己补一条终态事件，
 * 那条走同一条流回来，比在浏览器这边拿两台机器的钟去猜可靠得多。
 */
function approvalDead(a) {
  if (a.state !== 'pending') return false
  const snap = state.chatApprovals
  if (!snap || snap.sessionId !== state.chatSessionId || !snap.upto) return false
  return Boolean(a.seq && a.seq <= snap.upto && !snap.ids.has(a.callId))
}

/**
 * 拿会话这一跳没成就退避重来。
 *
 * **「刚部署完，字打得进去、点发送没反应，刷新一下就好了」漏的就是这一环。** 席位
 * 报 ready 之后还有几十秒接不了话，而且有**两副面孔**：
 *
 * · 进程还没听上端口 → Gateway 转不过去，503「实例还没上线」；
 * · 端口听上了，但公司目录还没同步下来（名册里还没有这颗 Bot，见 bot 的
 *   registry `ensureSession`）→ 404「没有这个助理」。
 *
 * 两种原先都是「记一笔就完」：chatSessionId 留空，而 sendChat 开头那道闸认的正是它，
 * 于是每一次发送都被无声地吞掉——屏幕上一个字都没有，只有刷新（重跑 loadChatPage）
 * 才会再拿一次会话。所以这里跟着流那边的做法退避重连：席位回来了，这一页自己接上，
 * 不用人去刷新。
 *
 * 上限 60 次（约 5 分钟，前 4 次退避到 5 秒，之后每次 5 秒）。真的一直不回来，才把话摆
 * 到界面上——那时候「稍等」是骗人的。
 *
 * **48 秒是不够的**，和流那边（CHAT_RETRY_MAX）同一个理由：重铺一个席位要拉发布包、
 * 解包、rsync、重启两个单元、再各自自证端口，几分钟是常态；换版之前管家还会先等席位
 * 把手上那一轮跑完（见 manager/src/seats.ts 的排空），那一段最长又是两分钟。等不够就
 * 认输的话，人在换版期间刷了一次页面，这一页就再也接不上了。
 */
const SESSION_RETRY_MAX = 60

function cancelSessionRetry() {
  if (sessionRetryTimer) clearTimeout(sessionRetryTimer)
  sessionRetryTimer = null
}

/**
 * 这个错值不值得再来一次。
 *
 * 认状态码，不认文案——文案是会被翻译的（见 api()）。503/502/504 是席位那一跳没通，
 * 没有状态码是请求压根没发出去。
 *
 * **404 不在其列，而且必须不在。** 这条接口上的 404 只剩一个含义了：这颗 Bot 不是你的
 * ／已经删了（visibleBotOf）——等一万年也是同一个答案，重试只会白敲十几次接口，然后
 * 拿「实例还没接上」盖掉真正的原因。席位那种「我还不认识它」的 404 由 Gateway 折成了
 * 503（见 routes/runtime.ts 里 `/runtime/bots/:id/session` 的那段），走上面那一路。
 * 403 / 401 同理，不重试。
 */
function seatWarmingUp(err) {
  const st = Number(err && err.status)
  return !st || st === 502 || st === 503 || st === 504
}

function retryChatSession(botId, attempt) {
  cancelSessionRetry()
  if (attempt >= SESSION_RETRY_MAX) {
    // **这一句要看得见。** '实例还没上线' 被 runtimeDownBanner 挡在界面外（它是常态，
    // 不该每次重新部署都弹一条红字），可等了快一分钟还没接上就不是常态了。
    sessionGaveUp = true
    state.runtimeError = '实例还没接上，等一会儿再试，或者重新部署一次'
    /**
     * **认输的是这一串急脾气的重试，不是这件事本身。**
     *
     * 流那边认输之后转慢速长跑（idleRetry），会话这边原先是真的停手——于是「bot 停机
     * 超过五分钟」这一种，页面永远停在这句话上：没有会话就开不出流，也就没有任何东西
     * 会再去试，只能等人按发送、切回标签页或者刷新。而这恰恰是最常见的一种停机。
     *
     * 所以这里也接上同一根长跑：半分钟一次，页面开着就一直试；席位回来了这一页自己
     * 接上。`sessionGaveUp` 留着不动——输入框底下那行小字说的是「这会儿发不出去」，
     * 那是实话。
     */
    idleSessionRetry(botId)
    render()
    return
  }
  const delay = Math.min(500 * 2 ** attempt, 5000)
  sessionRetryTimer = setTimeout(() => {
    sessionRetryTimer = null
    // 人切走了、或者别的路子已经把会话拿到了——这次重排就此作废。
    if (state.chatBotId !== botId || state.chatSessionId) return
    void ensureChatSession(botId, attempt + 1).catch((err) => {
      // 重试路上冒出来的「答案不会变」的错（权限变了、Bot 被删了）。这一路没有调用方
      // 接得住它，只能自己摆出来——**而且要 render**：flash 只写 state，不重绘就要等
      // 下一次别的什么触发重绘，那时候人已经又按了三次发送。
      sessionGaveUp = true
      flash('err', err.message)
      render()
    })
  }, delay)
}

/**
 * 把一份收起来的草稿摆回输入框。
 *
 * `mentions` 平时不在草稿里（点名只管「这一条消息」，换页就清，见 loadChatPage）；只有
 * 「附件没传上去」退回来的那份才带着——那是人已经按过发送的一整条，@ 丢了就是另一条话。
 */
function applyDraft(kept) {
  state.chatDraft = kept.text
  state.chatFiles = kept.files
  if (Array.isArray(kept.mentions) && kept.mentions.length) state.chatMentions = kept.mentions
  // 引用跟附件一样随草稿走：人引用了一条、切去别的 Bot 查个东西再回来，那张卡还在。
  state.chatRefs = Array.isArray(kept.refs) ? kept.refs : []
  paintChatFiles()
  paintChatRefs()
}

/**
 * 把当前会话换成这个 Bot 的。
 *
 * **换 Bot 的第一件事是清场，不是去拿新会话。** 原先是等新会话拿回来、比对出
 * sessionId 变了才清 state.chatEvents——于是只要那一步没走到，屏幕上就还挂着上一个
 * Bot 的对话。而它非常容易走不到：新 Bot 的席位没起来时，`/runtime/bots/:id/session`
 * 直接 503「实例还没上线」，catch 里记一笔就返回了。结果是切过去之后，你看着的是**另
 * 一个 Bot 的聊天记录**，旧的那条流还连着，还在往里追新消息。
 *
 * 所以顺序反过来：Bot 一变，立刻停掉旧流、把正文和状态清空。拿不到新会话就是一片空
 * 白加一句「实例还没上线」——空白是诚实的，别人的对话不是。
 */
async function ensureChatSession(botId, attempt = 0) {
  if (!botId) return
  // 这一跳现在就要发，排在后面那次重排作废（换 Bot 时同理：它盯的是上一个 Bot）。
  cancelSessionRetry()
  sessionGaveUp = false
  if (state.chatBotId === botId && state.chatSessionId && chatStreamId === state.chatSessionId) return
  // 这个 Bot 的流一直开着（切走时没掐）——把正文接回去就行，不用重新拉一遍会话。
  const warm = botStreams.get(botId)
  if (warm && warm.ac && warm.sessionId && state.chatBotId !== botId) {
    if (state.chatBotId) state.chatDrafts[state.chatBotId] = { text: state.chatDraft, files: state.chatFiles, refs: state.chatRefs }
    const kept = state.chatDrafts[botId] || { text: '', files: [] }
    state.chatBotId = botId
    state.chatSessionId = warm.sessionId
    resetWorkspaceTree()
    state.chatEvents = warm.events
    state.chatReplaying = false
    applyDraft(kept)
    chatAbort = warm.ac
    chatStreamId = warm.sessionId
    // 先把手上有的画出来——流垫的那一轮已经在桶里，切过去是**这一帧**就有东西看。
    paintChat()
    // 更早的那些走 HTTP 补。不 await：补回来自己重画，视线用 chatAnchorHeight 钉住。
    void hydrateChat(botId, warm.sessionId)
    // 待办快照单独补一次：hydrateChat 拉过一次就再也不进（`row.hydrated`），而这条流
    // 一直开着的 Bot 走的正是这条热路径。有了就直接返回，没有才真的发请求。
    void syncTodos(botId, warm.sessionId)
    return
  }
  if (state.chatBotId !== botId) {
    // **不掐上一个 Bot 的流。** 它可能正在干活，而名单上的转圈和「最近回复」就靠它。
    // 只把「当前会话」这把闩放开——正文渲染换到新 Bot 那边去。
    chatAbort = null
    chatStreamId = ''
    // 没发出去的草稿和附件是写给上一个 Bot 的，跟着它一起收起来；切回去还在。
    // 挂着的那条「等会话到了就发」同样作废：它指的是上一个 Bot 的那条草稿，而草稿这会儿
    // 已经收进 chatDrafts 了——补发只会把它发到新这位的对话里去。
    clearHeldSend()
    if (state.chatBotId) state.chatDrafts[state.chatBotId] = { text: state.chatDraft, files: state.chatFiles, refs: state.chatRefs }
    const kept = state.chatDrafts[botId] || { text: '', files: [] }
    state.chatBotId = botId
    state.chatSessionId = ''
    // 正文直接指向这个 Bot 自己的事件桶：切回去时历史还在，不用再重放一遍。
    state.chatEvents = botStreamOf(botId).events
    state.chatStatus = ''
    state.chatReplaying = false
    applyDraft(kept)
  }
  try {
    const data = await api('GET', '/runtime/bots/' + encodeURIComponent(botId) + '/session')
    const sessionId = data.sessionId
    if (!sessionId) throw new Error('没有会话')
    // 本地 Bot 的会话记下来，这条会话上之后的每一条请求都改道到本机（见 data.js 的 localRoute）。
    if (localBotOf(botId)) localSessions.set(sessionId, botId)
    // 期间人又切走了：这次的结果已经不作数，认领了就会把新会话顶掉。
    if (state.chatBotId !== botId) return
    const row = botStreamOf(botId)
    // 换了一条会话（席位重建过）——旧事件、旧摘要、旧的「历史补过了」一起作废。
    if (row.sessionId && row.sessionId !== sessionId) resetBotStream(row)
    row.sessionId = sessionId
    state.chatEvents = row.events
    state.chatSessionId = sessionId
    resetWorkspaceTree()
    state.chatStatus = ''
    // 接上了。等席位那段时间挂的话要撤掉，否则界面上会一直留着一句已经不成立的
    // 「还没接上」——流那边要是断了，它自己会再挂一次。
    state.runtimeError = ''
    // **两条路一起发，谁先到算谁的。** 历史走 HTTP，实时走 SSE（只垫一轮）；两边都
    // 带 seq，hydrateChat 按「比头还小才收」归并，重叠的那一轮不会画两遍。
    //
    // 都不 await：多等一个 RTT 才切页面，人按下去那一下就是白等。
    void hydrateChat(botId, sessionId)
    void startChatStream(sessionId, 0, botId)
    /**
     * 会话到手了：把等着这一刻的那条消息补发出去（见 flushHeldSend）。
     *
     * **排在开流之后**：那条消息的回答是经 SSE 回来的，先把流挂上，回执和回答才有人接
     * ——反过来的话，正好落进「消息发出去了、流还没开」那个缝里，屏幕上又是一条挂着的
     * 「正在思考」。
     */
    flushHeldSend(botId)
  } catch (err) {
    const msg = String(err.message || '')
    // 席位还在热身（见 retryChatSession 上面那段）：排一次重来，**并且不往外抛**——
    // 抛出去就是一条红字，而这会儿正确的说法是「还没好」，不是「坏了」。
    if (seatWarmingUp(err)) {
      if (state.chatBotId === botId) retryChatSession(botId, attempt)
      if (msg.includes('实例还没上线')) state.runtimeError = '实例还没上线'
      // 输入框底下那行小字要跟着改口（见 paintChatChrome）：人正对着它等。
      paintChat()
      return
    }
    // 剩下的是「答案不会变」的那些（没权限、这颗 Bot 不是你的）：照旧往外抛，由
    // loadPage 摆成一条红字。
    throw err
  }
}

async function loadChatPage() {
  state.chatCtxOpen = false
  state.chatModelOpen = false
  // 查找条是**这一条会话**里的：命中的 seq 换了会话就指不到东西，连条一起收掉。
  if (state.chatFind && state.chatFind.open) closeChatFind()
  // 换了会话，上一条还没发出去的 `@` 不该跟过来——它指的是「这一条消息带谁」。
  state.chatMentions = []
  // 引用指的是**那条会话里**的某条消息、某个文件，换了会话更不该跟过来。
  state.chatRefs = []
  state.mentionPick = null
  // 命令选单和「正在压缩」那句提示都是**上一页**的事，跟着走会挂在一条不相干的会话上。
  state.cmdPick = null
  state.chatCmdBusy = ''
  // 「正在停止」**不在这里清**。它记的是会话 id（见 state.js），换一页自然就不显示了；
  // 而换走的那一条可能还在停——切回来时该看到它还在转，不该看到一颗又能按的停止键。
  // 真停下来那一下由 paintChatChrome 收（turn/end 到了 status 就空了）。
  // 候选清空：换 Bot 之后连接没变，但换公司/换人之后就变了，重开一页重拉一次不亏。
  state.mentionOptions = null
  /**
   * 候选**这一页就拉**，不等人打 `@`。
   *
   * 历史消息里的点名药丸要画连接器的图标，而消息里只有 `{kind,id,label}`——图标得按 id
   * 回这份候选里查。等打 `@` 才拉的话，刚进页面翻上去看昨天那条，药丸上是没有图标的，
   * 打一次 `@` 之后又突然有了。**不 await**：它只影响药丸上那个小图标，不该把整页拖住。
   */
  void api('GET', '/mentions')
    .then((r) => {
      state.mentionOptions = r.mentions || []
      paintChat()
    })
    .catch(() => {})
  // loadRuntimeBots 由 loadPage 统一拉（名单是全局侧栏，不只这一页要）。
  // 上下文占比要知道模型的窗口有多大。新日志的 request/header 自带，老日志没有，
  // 目录是那种情况下的唯一来源。**不 await，也不让它的失败冒出来**——一条灰字的提示
  // 不值得把整页的加载拖住或者拖挂。
  if (!(state.catalog || []).length) void loadCatalog().catch(() => {})
  const botId = chatBotIdOf(state.path)
  /**
   * **会话不排在这两跳后面。**
   *
   * 机器信息（抬头那盏灯）和桌面运行时（右栏那块屏）跟正文没有任何关系，可它们原来是
   * 一条一条 `await` 下来的，而 ensureChatSession 排在最后——刷新一次，正文要等这两个
   * 来回都走完才开始去拿会话。两跳都是 Gateway → 管家 → 席位，各自还带着几次
   * Postgres 查询（见 lib/runtime.ts 的 seatTargetFor），白挡在最要紧的那条路前面。
   *
   * 三条一起发，正文只等它自己那条。这一页仍然等齐了才返回，所以 loadPage 之后那次
   * render() 该有的东西一样不少。
   */
  const chrome = Promise.all([loadRuntimeMachine(), loadDesktopRuntime(botId)]).catch(() => {})
  // 右栏那一列日常任务。**不 await**：它只画右栏，不该让正文晚一个 RTT 才出来。
  void loadRoutines(botId)
  try {
    if (botId) await ensureChatSession(botId)
  } finally {
    // 抬头和右栏那两份照旧要等齐了才返回（loadPage 之后那次 render 要用），
    // 会话这一跳抛出来时也一样——`finally` 就是为这一条。
    await chrome
  }
  // 名单那一条通道（一条管所有 Bot，见 startRosterStream）。已经开着就是空操作——
  // 它由 loadPage 在每一页统一起，这里只是补一次「直接落在对话页」的情况。
  void startRosterStream()
}
