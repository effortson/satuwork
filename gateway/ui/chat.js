/**
 * 对话。整个前端最重的一块，也是唯一有长连接的一块：
 * 每个 Bot 一条 SSE、事件折叠成消息、增量重绘、以及对话页本身。
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
    row = { sessionId: '', instanceId: '', ac: null, events: [], sum: { state: 'idle', lastAt: 0, lastText: '' }, hydrated: false, hydrating: null }
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

/**
 * 那颗点现在算哪一态。三样东西合成一个：**在等人 > 正在跑 > 空闲**。
 *
 * 分成三个计数而不是直接写 `sum.state`，是因为它们会交错：点了停止那一下，
 * `agent.abort()` 不等已经开跑的工具（见 bot 的 bridgeTools），`turn/end` 完全可能排在
 * 确认的终态**前面**到达——照着「最后一条事件」写的话，那颗点会从「空闲」被翻回
 * 「正在执行」然后一直停在那儿。各自记数、每次重算，就没有这个先后问题。
 */
function settleDot(sum) {
  const waiting = (sum.openIds ? sum.openIds.size : 0) + (sum.snapIds ? sum.snapIds.size : 0)
  const asking = sum.asks ? sum.asks.size : 0
  sum.state = asking || waiting ? 'review' : sum.busy ? 'busy' : 'idle'
  /**
   * **「在等你」还要分得出是哪一种。** 一颗点只说得出「有事」，而这两件事人要做的
   * 动作完全不同：拍板是当场点一下（那一轮真的停在席位上等着，5 分钟就超时按拒绝
   * 收口），接手是领一张能挂几天的单。名单上那个图标照这一格画。
   *
   * 两样都有时报拍板：它有钟在走，另一张单不会因为晚看十分钟就作废。
   */
  sum.need = asking ? 'approval' : waiting ? 'handoff' : ''
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

/** 事件到了就地更新摘要。O(1)，不 fold。 */
function noteBotEvent(botId, ev) {
  const row = botStreams.get(botId)
  if (!row) return
  const sum = row.sum
  const before = sum.state + '|' + sum.lastAt + '|' + sum.lastText
  if (ev.type === 'turn/start') {
    sum.busy = true
    settleDot(sum)
  } else if (ev.type === 'turn/end') {
    sum.busy = false
    settleDot(sum)
  } else if (ev.type === 'human/handoff') {
    /**
     * **「待人工处理」的第二个数据源。**
     *
     * 确认那一路（下面那条）只在一轮**正在跑**的时候出现，人多半就坐在这一屏。转人工
     * 不是：单子开出来之后那一轮就收口了，会话回到空闲，而这件事可能是半夜的日常任务
     * 开出来的。少了这一条，名单上那颗点会安安静静地写着「空闲」，而那台 Bot 其实卡着
     * 一件等人的事。
     */
    const d = ev.data || {}
    // **按单号记，不是计数。** 同一张单会来好几条（open → claimed → …），加加减减
    // 迟早会漂成一个永远归不了零的数，而那颗点就永远亮着「待人工处理」。
    const set = sum.openIds || (sum.openIds = new Set())
    if (d.state === 'open' || d.state === 'claimed') set.add(d.id)
    else {
      set.delete(d.id)
      // 快照那一份也要销掉，否则这颗点会亮到下一次轮询才灭——而人刚点完交还，
      // 正盯着它看。
      if (sum.snapIds) sum.snapIds.delete(d.id)
    }
    settleDot(sum)
  }
  // **「待人工处理」现在有数据源了。** 高风险确认会让那次工具调用真的停在席位上等人
  // 拍板（policy/approvals.ts），席位为此发一条 `tool/approval`。名单上那颗点因此有了
  // 第三态：不是在跑，也不是跑完了，而是**在等你**——而人多半正在别的 Bot 那一屏，
  // 名单是他唯一会瞥到的地方。
  else if (ev.type === 'tool/approval') {
    /**
     * **按 callId 记，不是计数**（同上面 openIds 那条）。原来这里是 `asking++/--`，
     * 而加加减减迟早会漂：重放段和实时段重叠一条 pending 就多加一次，那颗点从此
     * 永远亮着「在等你」，人点完了也灭不掉。
     *
     * 终态只删这一条，别的状态不碰——点了停止那一下，`agent.abort()` 不等已经开跑的
     * 工具（见 bot 的 bridgeTools），`turn/end` 完全可能排在终态**前面**到达；
     * 状态由 settleDot 从几个计数现算，就没有这个先后问题。
     */
    const d = ev.data || {}
    const asks = sum.asks || (sum.asks = new Map())
    if (!d.callId) {
      /* 老日志里可能没有 callId：认不回来的一条宁可不记，也不要记成一个销不掉的。 */
    } else if (d.state === 'pending') {
      asks.set(d.callId, {
        callId: d.callId,
        name: d.name || '',
        reason: d.reason || '',
        at: Number(ev.time) || 0,
        seq: Number(ev.seq) || 0,
      })
    } else asks.delete(d.callId)
    settleDot(sum)
  } else if (ev.type === 'user/message' || ev.type === 'assistant/message') {
    const text = messageText((ev.data || {}).message) || (ev.data || {}).text || ''
    if (text) {
      sum.lastText = text.replace(/\s+/g, ' ').trim().slice(0, 120)
      sum.lastAt = Number(ev.time) || sum.lastAt
    }
  } else if (ev.type === 'assistant/chunk') {
    // 流式期间也把时间往前推，否则「最近回复」会停在上一轮，看着像卡住了。
    sum.lastAt = Number(ev.time) || sum.lastAt
  }
  if (before !== sum.state + '|' + sum.lastAt + '|' + sum.lastText) scheduleRosterPaint()
}

/**
 * 从桶里重新认一遍「最近一条消息」。
 *
 * `hydrateChat` 往桶的**开头**塞一段历史，这些事件不能走 noteBotEvent——那一个是按
 * 「刚到的就是最新的」写的，会把名单上的摘要改成二十轮之前那句话。所以补完历史之后
 * 走这里：从后往前找第一条有正文的消息，**比手上这条新才认**。
 */
function refreshSum(row) {
  const sum = row.sum
  for (let i = row.events.length - 1; i >= 0; i--) {
    const ev = row.events[i] || {}
    if (ev.type !== 'user/message' && ev.type !== 'assistant/message') continue
    const text = messageText((ev.data || {}).message) || (ev.data || {}).text || ''
    if (!text) continue
    const at = Number(ev.time) || 0
    if (at < sum.lastAt) return
    sum.lastText = text.replace(/\s+/g, ' ').trim().slice(0, 120)
    sum.lastAt = at || sum.lastAt
    scheduleRosterPaint()
    return
  }
}

/**
 * 往桶里追一条事件，**已经有的就不追**。返回它是不是新的。
 *
 * 桶按 seq 有序；但**到达顺序不保证有序**。席位给事件拿号之后才异步落盘、落完才广播，
 * 两次并发 append 完全可能让 seq=42 先于 seq=41 到浏览器。尤其 `todo/list` 正好夹在
 * 工具调用的流式事件之间：把「不比尾巴大」当成「重复」会在新建清单时偶发地把它丢掉，
 * 输入框上面的任务 dock 就一直不出现。
 *
 * 所以这里按 seq **插入并去重**，不是只和尾巴比。桶不大（冷桶另有上限），一次从后往前
 * 找位置的成本远小于让所有 fold 都各自防乱序。
 *
 * 这道闸是给两条路准备的：历史走 HTTP、实时走 SSE，而流上还垫了一轮
 * （STREAM_TAIL_TURNS）用来给名单和第一帧兜底。那一轮和 hydrateChat 拉回来的最后
 * 一轮**必然重叠**——HTTP 先到的话，流的重放段就是一段桶里全有的事件，照追不误的
 * 结果是最后一问一答在屏幕上出现两遍。
 *
 * 反方向由 hydrateChat 那边的「比头还小才收」挡着。两头都挡上，谁先到就无所谓了。
 */
function pushBotEvent(botId, ev) {
  const list = botStreamOf(botId).events
  const seq = Number(ev && ev.seq)
  if (Number.isFinite(seq)) {
    let at = list.length
    for (let i = list.length - 1; i >= 0; i--) {
      const seen = Number(list[i] && list[i].seq)
      if (!Number.isFinite(seen)) continue
      if (seq === seen) return false
      if (seq > seen) {
        at = i + 1
        break
      }
      at = i
    }
    list.splice(at, 0, ev)
    return true
  }
  list.push(ev)
  return true
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

function closeAllBotStreams() {
  for (const id of botStreams.keys()) closeBotStream(id)
  botStreams.clear()
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

/**
 * 用户消息里的图片块（会话格式 v4 起）。
 *
 * 日志里存的是**路径**不是字节（见 bot 的 session/types.ts），所以这里拿到的也是路径，
 * 要显示还得走一趟预览接口——和点开产出文件是同一条路。
 */
function messageImages(msg) {
  const content = msg && msg.content
  if (!Array.isArray(content)) return []
  return content.filter((b) => b && b.type === 'image' && b.path).map((b) => ({ path: b.path, mime: b.mime || '' }))
}

function messageText(msg) {
  if (!msg) return ''
  if (typeof msg === 'string') return msg
  const content = msg.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => (b && (b.type === 'text' || b.type === 'reasoning') ? b.text || '' : ''))
    .join('')
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
  const logo = m.logo || (state.mentionOptions || []).find((x) => x.id === m.id)?.logo || ''
  const head = logo ? `<img src="${esc(logo)}" alt="" data-onerror="at">` : '@'
  return `<span class="sw-mention">${head}<span>${esc(m.label)}</span>`
}

function messageMentions(msg) {
  const content = msg && msg.content
  if (!Array.isArray(content)) return []
  return content
    .filter((b) => b && b.type === 'mention' && b.label)
    .map((b) => ({ kind: b.kind || 'connector', id: b.id || '', label: String(b.label) }))
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
 * 记下「手上最靠前那条是谁」和「它前面还有没有」。
 *
 * 规矩只有一条：**谁知道得更早，谁说了算。**
 *
 * 三个写入方看到的窗口不一样大——流上只垫一轮（STREAM_TAIL_TURNS），HTTP 一次二十
 * 轮，往前翻又是另一页——而谁先落地取决于网络。窄窗口晚到时如果照写，游标就被推回
 * 「最后一轮的开头」，于是「加载更早的对话」去取的是一页手上全有的事件：归并那两道
 * 闸（进桶比尾巴大、补历史比头小）会把它们全滤掉，按钮点了没反应。
 *
 * `hasMore` 必须跟着 `firstSeq` 一起走——那句「前面还有没有」问的是**这一条**之前。
 * 拆开取会配出一对互相矛盾的值。
 *
 * `loading` 只有 loadOlderChat 说了算（它是唯一会把按钮置灰的人），别人不传就保持
 * 原样：顺手写一个 `loading: false` 会把正在飞的那次翻页从界面上「解灰」，人一点就
 * 又发一次。
 */
function noteChatPage(sessionId, next) {
  const cur = chatPages.get(sessionId) || {}
  const known = typeof cur.firstSeq === 'number' ? cur.firstSeq : null
  const first = typeof next.firstSeq === 'number' ? next.firstSeq : null
  // 带来了更早的游标就是它赢；一条游标都没带（空会话、续传）时，只有在我们本来也
  // 什么都不知道的情况下才认它那句 hasMore。
  const wins = first != null ? known == null || first < known : known == null
  chatPages.set(sessionId, {
    ...cur,
    firstSeq: wins && first != null ? first : cur.firstSeq,
    hasMore: wins && typeof next.hasMore === 'boolean' ? next.hasMore : cur.hasMore,
    loading: next.loading !== undefined ? next.loading : Boolean(cur.loading),
  })
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

/**
 * 用户消息开头那段「我上传了文件，在工作区里：」是 composeChatBody 自己拼的
 * （同一个文件里，往下找）。这里把它认回来。
 *
 * **为什么值得认**：不认的话，附件在气泡里就是一行不能点的路径文本，而 Bot 生成的
 * 文件早就是可以点开预览的药丸了——同一个东西，自己传上去的反而看不了，这说不通。
 *
 * 敢按文本认，是因为这段文本**是我们自己生成的**，格式由 composeChatBody 定死；
 * 而且判据卡得很紧：首行必须整句相等（中英两版都列在下面，一条消息可能在另一种
 * 语言下被打开），随后必须是连续的 `- \`uploads/…\`` 行。这和「拿正则去扫模型写的
 * 散文猜路径」是两回事——那种一改措辞就散架，这种不会。
 */
const UPLOAD_LEADS = ['我上传了文件，在工作区里：', 'I uploaded some files. They are in the workspace at:']

function splitUploads(text) {
  const src = String(text == null ? '' : text)
  const lead = UPLOAD_LEADS.find((x) => src.startsWith(x + '\n'))
  if (!lead) return { text: src, files: [] }
  const lines = src.slice(lead.length + 1).split('\n')
  const files = []
  let i = 0
  for (; i < lines.length; i++) {
    const m = /^- `(uploads\/[^`]+)`$/.exec(lines[i])
    if (!m) break
    files.push({ path: m[1], name: m[1].split('/').pop() || m[1] })
  }
  if (!files.length) return { text: src, files: [] }
  return { text: lines.slice(i).join('\n').trim(), files }
}

function fold(events, live, channelBot = false) {
  const blocks = []
  // 名册标记负责首条 Telegram 消息之前的 Web 轮次；历史里的渠道来源兼容旧响应。
  const showChannelVia = channelBot || (events || []).some((ev) => {
    const source = ev?.type === 'user/message' ? ev?.data?.source : null
    return source?.kind === 'plugin' && source.plugin === 'channel' && source.channel === 'telegram'
  })
  let assistant = null
  let tools = []
  // 同一条主会话可以同时收 Web 和 Telegram；助手回复继承本轮用户消息的来源。
  let turnVia = ''
  let status = ''
  /**
   * 正在跑的这一轮是**什么时候开始的**（turn/start 那条事件的时间）。
   *
   * 读秒要的是「我已经等了多久」，那个起点只能是这一轮开始的时刻——不是第一个字
   * 落地的时刻。按后者算，一轮里模型先想十秒再开口，屏幕上的秒表会在第一个字冒出来
   * 的瞬间从头开始数，而人明明已经等了十秒。
   */
  let statusAt = 0
  // 空壳工具调用的 callId（见下面 tool/call）。它们的结果也要一起跳过。
  const phantoms = new Set()
  /** 最后一条 `todo/list` 快照。见下面那一支。 */
  let todos = null
  /** 单号 → 已经画在某一块上的那张交接卡。跨块认，见下面 human/handoff。 */
  const handoffSeen = new Map()
  const handoffOf = (id) => (id ? handoffSeen.get(id) : undefined)
  for (const ev of events || []) {
    const type = ev.type
    const data = ev.data || {}
    // 事件自带 time（bot 那边 append 时打的）。界面上要按天分隔、每条标时刻，
    // 所以 fold 得把它带出来——只有块的**第一条**事件的时间算数，流式续写的那些
    // chunk 不该让一条消息的时间一直往后跳。
    const at = Number(ev.time) || 0
    if (type === 'user/message') {
      /**
       * 不是人打进来的那些一律不画，但外部渠道和明确的代理入口要画。
       *
       * 那一条 `source` 是 `plugin: 'handoff'`（席位替接手的人发的，见 policy/handoff.ts），
       * 但它就是一个人做完事之后说的话，是这一轮的起因。滤掉的话，界面上会看到 Bot
       * 突然自己开口接着干活，而上一句是几小时前它说"等人接手"。
       */
      const src = data.source || {}
      // Telegram / Web 在同一主会话里按 via 分辨；看板、日常任务和交还继续用原来的代理标签。
      const via = src.kind === 'plugin' && src.plugin === 'channel'
        ? (src.channel === 'telegram' ? 'telegram' : String(src.channel || 'channel'))
        : src.kind === 'plugin' && (src.plugin === 'kanban' || src.plugin === 'routine' || src.plugin === 'handoff')
          ? src.plugin
          : (!src.kind || src.kind === 'user') ? (showChannelVia ? 'web' : '') : ''
      if (src.kind && src.kind !== 'user' && !via) continue
      turnVia = via
      assistant = null
      tools = []
      const raw = messageText(data.message) || data.text || ''
      const up = splitUploads(raw)
      blocks.push({
        kind: 'user',
        text: up.text,
        // 附件列表拆出来单独画成药丸；正文只留人真正打的那句话。
        files: up.files,
        // **点名要跟着消息留下来。** 它是这条消息的一部分（决定了这一轮的工具表），
        // 不是输入框上一个发完就没的装饰。丢掉的话翻上去看昨天那条，「@ 了谁」就消失了，
        // 而那正是「它为什么去读了我的邮箱」的唯一答案。
        mentions: messageMentions(data.message),
        // **这行话从哪来。** Web / Telegram / 代理任务都画在气泡上的角标。
        via,
        // **raw 不能省。** mergePending 靠「文字一模一样」认回执，而它手上那份是
        // 拼好的完整正文。只留拆过的 text，带附件的消息就永远认不回来——那条 pending
        // 销不掉，界面会一直挂着「正在思考」。
        raw,
        images: messageImages(data.message),
        time: at,
        seq: ev.seq,
      })
    } else if (type === 'assistant/message') {
      const text = messageText(data.message)
      if (!assistant) {
        assistant = { kind: 'assistant', text: '', tools, via: turnVia, time: at, seq: ev.seq }
        blocks.push(assistant)
      }
      if (text) assistant.text = text
      assistant.endTime = at
    } else if (type === 'assistant/chunk') {
      const chunk = data.chunk || {}
      if (chunk.type === 'text-delta' && chunk.text) {
        if (!assistant) {
          assistant = { kind: 'assistant', text: '', tools, via: turnVia, time: at, seq: ev.seq }
          blocks.push(assistant)
        }
        assistant.text += chunk.text
        assistant.endTime = at
      }
    } else if (type === 'tool/call') {
      // 工具常常在助手吐出第一个字**之前**就开始跑（先查订单再回话）。以前只在已经有
      // 助手块时才把工具挂上去，于是这一段时间里工具痕迹无处可去，等回答开始才突然
      // 冒出来——正好是最想知道「它在干什么」的那几秒什么都看不到。这里补一条：工具
      // 一开跑就把助手块建出来，正文留空，界面上就是一个带工具痕迹的「正在想」气泡。
      if (!assistant) {
        assistant = { kind: 'assistant', text: '', tools, via: turnVia, time: at, seq: ev.seq }
        blocks.push(assistant)
      }
      // **没有名字的不画。** 那是 bot 那边一个已经修掉的下标错位留下的空壳（见
      // llm/gateway.ts 的 toolSlot），它从来没跑过、也跑不起来，pi 一句「找不到叫「」
      // 的工具」就把它判失败了。可**已经写下的日志里还留着**，翻上去看昨天那轮，
      // 每一轮开头都挂一颗红色的「tool · 失败」，点开里面什么都没有。
      // 结果也一起跳过（见下面 tool/result）：不跳的话它会按「第一条还没有结果的」
      // 认过去，把一次成功的调用标成失败。
      if (!String(data.name || '').trim()) {
        phantoms.add(data.callId)
        continue
      }
      // arguments 要留着：工具药丸的悬浮窗全靠它回答「这次到底拿什么跑的」。存的是
      // bot 那边 JSON.stringify 过的原串，展示时再 parse 一次做缩进（见 toolPopBody）。
      tools.push({
        callId: data.callId,
        name: data.name,
        args: typeof data.arguments === 'string' ? data.arguments : '',
        result: null,
        failed: false,
      })
      assistant.tools = tools
      assistant.endTime = at
    } else if (type === 'tool/result') {
      if (phantoms.has(data.callId)) continue
      const hit =
        tools.find((x) => x.callId && x.callId === data.callId && x.result == null) ||
        tools.find((x) => x.result == null) ||
        tools[tools.length - 1]
      if (hit) {
        hit.result = data.text || ''
        hit.failed = Boolean(data.failed)
        // 工具自己报出来的产出文件。老日志没有这个字段，也**不去扫 text 猜路径**——
        // 那段文本是写给模型的散文，措辞一改就扫不出来了。
        hit.files = Array.isArray(data.files) ? data.files : null
        // 这次调用**看到**的文件（ls 列的、grep 命中的、read 读的那一个）。正文里
        // 出现的文件名靠它接成能点开的链接——同样是工具报出来的，不是扫文本猜的。
        hit.refs = Array.isArray(data.refs) ? data.refs : null
        // 浏览器工具拍的那张页面截图。老日志没有这个字段，那就没有——**不去猜**。
        hit.shot = data.shot && typeof data.shot.path === 'string' && data.shot.path ? data.shot : null
      }
      if (assistant) assistant.endTime = at
    } else if (type === 'agent/task') {
      /**
       * 一次委派（见 docs/delegation.md）。**挂在助手那一块上**，理由和确认卡一字不差：
       * 另起一块会把卡片插进正在跑的这一轮中间，而 `tool/result` 按 callId 认药丸，
       * 认不回去就会把一次成功的调用标成失败。
       *
       * 同一个 id 会来多条（running → 终态），**取最后一条**。读法和 tool/approval、
       * human/handoff 是同一套。
       */
      if (!assistant) {
        assistant = { kind: 'assistant', text: '', tools, via: turnVia, time: at, seq: ev.seq }
        blocks.push(assistant)
      }
      const list = assistant.tasks || (assistant.tasks = [])
      const prev = list.find((x) => x.id === data.id)
      if (prev) Object.assign(prev, data)
      else list.push({ ...data })
      assistant.endTime = at
    } else if (type === 'skill/saved') {
      /**
       * Bot 给自己记下了一条 Skill（docs/skills.md §13）。**挂在助手那一块上**，理由
       * 和委派卡、确认卡一字不差：另起一块会把它插进正在跑的这一轮中间，而
       * `tool/result` 按 callId 认药丸，认不回去就会把一次成功的调用标成失败。
       *
       * 这是员工唯一一次**在事情发生的当下**看见它改了自己——事后去 Skill 页面翻，
       * 那一屏没人会没事去看。
       */
      if (!assistant) {
        assistant = { kind: 'assistant', text: '', tools, via: turnVia, time: at, seq: ev.seq }
        blocks.push(assistant)
      }
      const notes = assistant.skillNotes || (assistant.skillNotes = [])
      const seen = notes.find((x) => x.callId === data.callId)
      if (seen) Object.assign(seen, data)
      else notes.push({ ...data })
      assistant.endTime = at
    } else if (type === 'memory/saved') {
      /**
       * Bot 记下（改掉、删掉）了一条事实（docs/memory.md §9）。**挂在助手那一块上**，
       * 理由和上面那张 Skill 卡一字不差。
       *
       * 比 Skill 那张更要紧一档：一条记忆此后**每一轮**都摆在提示词里影响回答，
       * 而事后去 Bot 设置里翻，那一屏没人会没事去看。
       */
      if (!assistant) {
        assistant = { kind: 'assistant', text: '', tools, via: turnVia, time: at, seq: ev.seq }
        blocks.push(assistant)
      }
      const mem = assistant.memNotes || (assistant.memNotes = [])
      const had = mem.find((x) => x.callId === data.callId)
      if (had) Object.assign(had, data)
      else mem.push({ ...data })
      assistant.endTime = at
    } else if (type === 'tool/approval') {
      /**
       * 高风险确认。**挂在助手那一块上，不另起一块。**
       *
       * 另起一块的话，卡片会插在正在跑的这一轮中间：上面是已经吐出来的正文、下面是
       * 后续的正文，而工具药丸和它的结果分属两块——`tool/result` 按 callId 认药丸，
       * 认不回去就会把一次成功的调用标成失败。挂在块上，位置就在那颗药丸底下，
       * 也正是人要找它的地方。
       */
      if (!assistant) {
        assistant = { kind: 'assistant', text: '', tools, via: turnVia, time: at, seq: ev.seq }
        blocks.push(assistant)
      }
      const list = assistant.approvals || (assistant.approvals = [])
      const cur = list.find((a) => a.callId === data.callId)
      if (cur) {
        // 同一个 callId 会来两条：先 pending，人点了之后再来终态。取最后一条。
        cur.state = data.state || cur.state
        if (data.scope) cur.scope = data.scope
        // 终态那条带的是**最终**那一份（人改过的话就是改后的），覆盖掉起草时那份。
        if (typeof data.arguments === 'string') cur.args = data.arguments
        if (data.form && Array.isArray(data.form.fields)) cur.form = data.form
        if (Array.isArray(data.edited)) cur.edited = data.edited
      } else {
        list.push({
          callId: data.callId,
          name: data.name || '',
          args: typeof data.arguments === 'string' ? data.arguments : '',
          reason: data.reason || '',
          // 这次用哪张卡、卡上哪几格。**席位算好的**，界面照着画（见 policy/forms.ts）。
          form: data.form && Array.isArray(data.form.fields) ? data.form : null,
          edited: Array.isArray(data.edited) ? data.edited : null,
          state: data.state || 'pending',
          expiresAt: Number(data.expiresAt) || 0,
          // 这条 pending 落在日志的第几行。核对现况时拿它跟快照的水位比——
          // **不拿时间比**，那是两台机器各自的钟（见 approvalDead）。
          seq: ev.seq,
        })
      }
      assistant.endTime = at
    } else if (type === 'human/handoff') {
      /**
       * 转人工的交接单（见 docs/handoff.md）。挂在开单那一块上，和确认卡同一个理由。
       *
       * **同一张单会来好几条**（open → claimed → returned → closed），而且后面那几条
       * 常常隔了几小时——中间人多半又跟 Bot 说过话，于是「当前这一块」早就不是开单
       * 那一块了。所以按单号在**整条会话**里认（handoffOf），认回开单时那一条就地改。
       *
       * 只在当前块里找的话，claimed 会被当成一张新单推进新块：同一张单画出两张卡，
       * 上面那张还写着「等人接手」、按钮还能点——点下去换回一句 409，而人在下面那张
       * 卡里写的结论也读不到（取的是第一个匹配的输入框）。
       */
      const seen = handoffOf(data.id)
      if (seen) {
        seen.state = data.state || seen.state
        if (data.claimedBy) seen.claimedBy = data.claimedBy
        if (data.result) seen.result = data.result
        if (data.repeats) seen.repeats = data.repeats
        // **不动任何一块的 endTime**：这条事件属于开单那一块，而它早就收口了；
        // 拿它去推当前块的时间，气泡下面那行会跳到几小时之后。
        continue
      }
      if (!assistant) {
        assistant = { kind: 'assistant', text: '', tools, via: turnVia, time: at, seq: ev.seq }
        blocks.push(assistant)
      }
      const hs = assistant.handoffs || (assistant.handoffs = [])
      const fresh = {
        id: data.id,
        callId: data.callId || '',
        state: data.state || 'open',
        reason: data.reason || '',
        ask: data.ask || '',
        summary: data.summary || '',
        blocking: data.blocking !== false,
        claimedBy: data.claimedBy || null,
        result: data.result || null,
        repeats: Number(data.repeats) || 0,
        seq: ev.seq,
      }
      hs.push(fresh)
      handoffSeen.set(data.id, fresh)
      assistant.endTime = at
    } else if (type === 'session/compact' || type === 'session/reset') {
      /**
       * 上下文边界。画成一条横穿的分割线，不是气泡。
       *
       * 自动压缩画的是同一条线，这是顺带修好的一件事：在这之前自动压缩在界面上完全
       * 不可见，人只看到 Bot 从某一刻起开始忘事，没有任何解释。
       *
       * **这里绝不能顺手 `assistant = null; tools = []`。**
       *
       * 直觉上该断：不断的话下一条助手消息会续写到分割线之前那一块上。但那个担心是空的
       * ——两轮之间紧跟着边界的必然是 `user/message`，而那一支自己就会断（见上面）。
       *
       * 而断了会咬人：压缩事件**完全可能落在一个正在跑的轮次中间**（轮末那次是
       * `void maybeCompact`，不 await，还要跑一次摘要模型调用，几秒到十几秒；这期间人
       * 早就发了下一句、下一轮的工具也开跑了）。这时把 `tools` 换成新的空数组，该轮后
       * 到的 `tool/result` 三次 find 全落空、结果被丢掉，而那颗药丸挂在上一块里、
       * `result` 永远是 null——界面上就是一颗**永远停在「调用中」的工具药丸**，刷新也
       * 回不来（重放同一串事件，结果一样）。同一个原因还会把正在流式输出的回答从中间
       * 劈成两个气泡。
       *
       * 不断的话，落在轮中间时这条线就画在那一块的后面，位置诚实，别的什么都不影响。
       */
      blocks.push({
        kind: 'mark',
        mark: type === 'session/reset' ? 'reset' : 'compact',
        // 老日志没有 by（那时只有自动压缩），按 auto 读。
        by: data.by || (type === 'session/reset' ? 'user' : 'auto'),
        from: Number(data.from) || 0,
        to: Number(data.to) || 0,
        tokensBefore: Number(data.tokensBefore) || 0,
        tokensAfter: Number(data.tokensAfter) || 0,
        dropped: Number(data.droppedMessages) || 0,
        time: at,
        seq: ev.seq,
      })
    } else if (type === 'todo/list') {
      /**
       * 待办清单的一张全量快照。**不画进消息流**——它是一份状态，不是一句话；每改一次
       * 就在对话里推一条的话，一次十步的活会把人真正在读的内容挤没。折出来给 dock 用。
       *
       * 后一条盖前一条，seq 一起带上：dock 还有第二个数据源（打开这一页时拉的那次快照），
       * 两边谁新按**日志行号**比，不按时间比（理由见 approvalDead）。
       */
      todos = { items: Array.isArray(data.items) ? data.items : [], seq: ev.seq }
    } else if (type === 'turn/start') {
      status = 'running'
      statusAt = at
    } else if (type === 'turn/end') {
      status = ''
      /**
       * **起点也要跟着清掉。**
       *
       * `status` 还有第二个来源：席位的 live 旗子会整个盖掉这里扫出来的结论（见下面
       * 那一句）。留着上一轮的起点，「live 说在跑、而手上这段事件的最后一条是
       * turn/end」时，秒表就从上一轮开始数——早上跑完一轮、晚上那条日常任务起来的
       * 那一帧，气泡下面直接是个「720:00」。清成 0，兜底那句才接得住。
       */
      statusAt = 0
      // **这一轮真正收口的时刻。** 气泡下面那个时间要的是「输出完毕」而不是「开始
      // 输出」，靠的就是它：比最后一条 chunk 准，也覆盖「只调工具、一个字没吐」的
      // 那种轮次（那种轮里根本没有 chunk 可以取时间）。
      if (assistant) assistant.endTime = at
    }
  }
  // bot 说过话就听它的：这份历史可能是截断的，而扫描对截断毫无抵抗力（见 chatLive）。
  if (typeof live === 'boolean') status = live ? 'running' : ''
  /**
   * 席位说「在跑」，可这段历史里根本没有那条 turn/start（截断了，或者只垫了一轮）。
   * 退到手上最后一条事件的时间：秒表会少数一截，但**它至少在走**——而 0 会让这一行
   * 整个消失（见 paintRowTime）。
   */
  if (status && !statusAt) {
    const tail = blocks[blocks.length - 1]
    statusAt = (tail && (tail.endTime || tail.time)) || 0
  }
  return { blocks, status, statusAt, todos, channelVia: showChannelVia }
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
    state.runtimeBots = data.bots || []
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
      }
      if (running && !localBotOf(bot.id)) {
        const b = await api('POST', `/runtime/bots/${encodeURIComponent(bot.id)}/local-bootstrap`, {})
        registerLocalBot(bot.id, s.port, b.accessToken)
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

/**
 * 核对一遍「哪几条确认还真的等着」。
 *
 * 卡片本身是从会话事件折出来的，可日志只说「那时候它在等」。**等待方是席位进程里的
 * 一个 Promise**：席位重启过、或者那条早就超时而这台浏览器当时没连着，日志上那条
 * pending 就永远停在那儿——人点下去什么都不会发生，只换回一句 409。
 *
 * 所以拉一次现况，比它早的 pending 只要不在清单里就画成失效。**「比它早」按 seq 算，
 * 不按时间算**：事件上的 time 是席位盖的，而「现在几点」是浏览器这边的——两台机器的
 * 钟差几十秒是常态（虚拟机漂移），席位慢一点的话，拉取之后新冒出来的确认会显得比快照
 * 还早，于是一张真的在等的卡片被画成失效、按钮消失，人只能眼看着它五分钟后超时。
 * seq 是会话日志的行号，两边看到的是同一个数，没有这个问题。
 *
 * 水位取在**发请求之前**：那之后落下的事件，席位的回执里可能来不及包含。
 */
function maxSeqOf(events) {
  let max = 0
  for (const ev of events || []) {
    const seq = Number(ev && ev.seq)
    if (Number.isFinite(seq) && seq > max) max = seq
  }
  return max
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
    if (state.chatBotId) state.chatDrafts[state.chatBotId] = { text: state.chatDraft, files: state.chatFiles }
    const kept = state.chatDrafts[botId] || { text: '', files: [] }
    state.chatBotId = botId
    state.chatSessionId = warm.sessionId
    resetWorkspaceTree()
    state.chatEvents = warm.events
    state.chatReplaying = false
    state.chatDraft = kept.text
    state.chatFiles = kept.files
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
    if (state.chatBotId) state.chatDrafts[state.chatBotId] = { text: state.chatDraft, files: state.chatFiles }
    const kept = state.chatDrafts[botId] || { text: '', files: [] }
    state.chatBotId = botId
    state.chatSessionId = ''
    // 正文直接指向这个 Bot 自己的事件桶：切回去时历史还在，不用再重放一遍。
    state.chatEvents = botStreamOf(botId).events
    state.chatStatus = ''
    state.chatReplaying = false
    state.chatDraft = kept.text
    state.chatFiles = kept.files
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
  // 换了会话，上一条还没发出去的 `@` 不该跟过来——它指的是「这一条消息带谁」。
  state.chatMentions = []
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

/* ══ 名单那一条实时通道 ═══════════════════════════════════════════════
   侧栏名单要的是每个 Bot「在不在跑 / 最近说了什么 / 是不是在等你」。这三样以前是
   **一个 Bot 一条 SSE** 拿回来的，两笔代价都很重：

     · 连接槽——HTTP/1.1 下浏览器每个源只给 6 条，而 SSE 是永不结束的 fetch，开着就
       占死一条。十几个 Bot 直接把槽占光，画出正文的那条 history 排在后面干等。
     · token 洪流——那几条流拿的是**全量**事件，包括每个 token 一条的 chunk。十个 Bot
       同时干活就是十路 token 流在主线程上 JSON.parse，画的是侧栏十行灰字。

   现在换成 Gateway 扇入、浏览器只连一条（见 gateway/src/lib/roster-stream.ts）：加上
   正在看的那条对话，**稳定态一共两条连接，跟 Bot 数无关**。

   **它喂的是摘要，不是正文。** 帧里的事件是过滤过的（只有名单消费的那六种），凑不成
   一条完整的会话——所以只喂 noteBotEvent，**绝不进事件桶**：进了的话点进那个 Bot 会
   看到一段缺了正文的历史。正文照旧由 ensureChatSession 在人点进去时另开一条。
   ══════════════════════════════════════════════════════════════════ */

/** 断了之后的退避档位（毫秒）。到顶就一直用最后那一档——名单这条不认输，理由见下。 */
const ROSTER_BACKOFF = [500, 1000, 2000, 4000, 8000, 15_000, 30_000]
let rosterAbort = null
let rosterTimer = null
/**
 * 名单流**只直连席位机器**（`state.rosterStreamUrl`，理由和对话那条一样，见 directStreamBase）。
 *
 * Gateway 上已经没有 `/runtime/roster/stream` 这条反代了——它是小时级的连接，Gateway 要
 * 变成无状态的就留不得它。所以地址是空的（机器没配 directUrl、或者管家太旧）就**不连**，
 * 也不排重试：地址不会自己长出来，它随下一次 /runtime/bots 到（见 syncRosterStream）。
 * 直连上的失败一律在同一个地址上退避重来——没有别的路可退了。
 */
function directRosterUrl() {
  return state.rosterStreamUrl || ''
}
/** 正在跑的那条流用的地址。/runtime/bots 换了地址时靠它判断要不要重开（见 syncRosterStream）。 */
let rosterLiveUrl = ''

async function startRosterStream(attempt = 0) {
  // 已经有一条在跑就别再开。整页重绘、切页、切 Bot 都会走到这儿。
  if (attempt === 0 && rosterAbort) return
  clearTimeout(rosterTimer)
  const url = directRosterUrl()
  if (!url) {
    rosterAbort = null
    rosterLiveUrl = ''
    return
  }
  const ac = new AbortController()
  rosterAbort = ac
  rosterLiveUrl = url
  const t = token()
  let res
  try {
    res = await swFetch(url, {
      headers: { accept: 'text/event-stream', ...(t ? { authorization: 'Bearer ' + t } : {}) },
      signal: ac.signal,
    })
  } catch {
    if (ac.signal.aborted) {
      if (rosterAbort === ac) rosterAbort = null
      return
    }
    return retryRosterStream(ac, attempt + 1)
  }
  /**
   * 401 / 403 当场认输：票没了、或者这个账号根本没有席位（owner）。重试只会白敲。
   * 404 也在内（管家太旧，还没有这条路由）——Gateway 只在管家够新时才给这个地址，
   * 真出现了说明两头对不上号，重试同样没有意义；下一次 /runtime/bots 会重新判一遍。
   */
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    if (rosterAbort === ac) rosterAbort = null
    return
  }
  if (!res.ok || !res.body) return retryRosterStream(ac, attempt + 1)
  /**
   * 下一次重连用哪个档位，判据是**这次连接活了多久**，不是「有没有连上」——和
   * startChatStream 那套一字不差（见 CHAT_ALIVE_MS 上面那段）。不这么算的话，早期
   * 几次失败把档位推到顶之后，哪怕这条流健康地跑了几小时再断，下一次也要等满 30 秒
   * 才重连，而那半分钟里名单上每一颗点都是冻着的。
   */
  const openedAt = Date.now()
  const nextAttempt = () => (Date.now() - openedAt >= CHAT_ALIVE_MS ? 0 : attempt + 1)
  try {
    for await (const ev of sseEvents(res.body.getReader(), () => ac.signal.aborted || rosterAbort !== ac)) {
      // 中止是在 read() 里等着的时候发生的：那一刻已经在路上的这一块数据照样会到，
      // 而它属于一条作废的流。不在这儿再判一次，它就会写进一份不该再动的名单。
      if (ac.signal.aborted || rosterAbort !== ac) break
      try {
        noteRosterFrame(ev)
      } catch {
        /* 不认识的形状：跳过，别把整条流带下去 */
      }
    }
  } catch {
    if (ac.signal.aborted) {
      if (rosterAbort === ac) rosterAbort = null
      return
    }
  }
  if (ac.signal.aborted || rosterAbort !== ac) return
  return retryRosterStream(ac, nextAttempt())
}

/**
 * 断了自己接回来，**而且不认输**。
 *
 * 认输的代价在这条通道上特别隐蔽：名单上那颗点会停在断掉那一刻的样子——「正在执行」
 * 一直转下去，而那台 Bot 可能十分钟前就干完了。没有任何东西会来纠正它，人也不会想到
 * 去刷新（他看到的是「在跑」，不是「断了」）。所以退避到 30 秒一档之后就一直重试。
 */
function retryRosterStream(ac, attempt) {
  if (rosterAbort !== ac) return
  rosterAbort = null
  const wait = ROSTER_BACKOFF[Math.min(attempt, ROSTER_BACKOFF.length - 1)]
  clearTimeout(rosterTimer)
  rosterTimer = setTimeout(() => void startRosterStream(attempt), wait)
}

/**
 * /runtime/bots 刚把名单流地址带回来：空 → 有值就起流，换了地址就在新地址上重开。
 * 地址没变什么都不动——正在退避的那条留着，别把它的档位打乱。
 */
function syncRosterStream() {
  const url = directRosterUrl()
  if (rosterAbort && rosterLiveUrl !== url) stopRosterStream()
  if (url) void startRosterStream()
}

function stopRosterStream() {
  clearTimeout(rosterTimer)
  rosterLiveUrl = ''
  const ac = rosterAbort
  rosterAbort = null
  if (ac) {
    try {
      ac.abort()
    } catch {}
  }
}

/** 名单通道的一帧。形状见 gateway/src/lib/roster-stream.ts。 */
function noteRosterFrame(msg) {
  if (!msg || typeof msg !== 'object' || !msg.botId) return
  if (msg.type === 'roster/ev') {
    // **只更新摘要，不进事件桶**（见这一段开头）。botStreamOf 顺手把这一行建出来：
    // 没有它 noteBotEvent 会直接 return，而刷新之后每一行本来都还没建。
    botStreamOf(msg.botId)
    noteBotEvent(msg.botId, msg.ev || {})
    return
  }
  if (msg.type === 'roster/live' && typeof msg.live === 'boolean') {
    /**
     * 席位表的态，压过按事件扫出来的结论——和正文那边 chatLive 治的是同一个病：
     * 席位崩在半路时日志里有 turn/start 没 turn/end，只扫事件的话那颗点永远转下去。
     *
     * **改 busy 再让 settleDot 去算，不直接写 state**：那是派生量，还要把「等审批 /
     * 等接手」一起算进去（见 settleDot）。
     */
    const sum = botStreamOf(msg.botId).sum
    sum.busy = msg.live
    settleDot(sum)
    scheduleRosterPaint()
  }
}

/**
 * 事件流游标。断线重连时带上它，服务端从这一条之后继续发。
 *
 * 事件里的 `seq` 是会话日志的行号，天然单调，所以「续传」就是把最后见到的那个数
 * 回传过去——不需要去重，也不会重放已经画出来的内容。
 */
function chatCursor(botId) {
  const list = botId ? botStreamOf(botId).events : state.chatEvents
  for (let i = list.length - 1; i >= 0; i--) {
    const n = Number(list[i] && list[i].seq)
    if (Number.isFinite(n)) return n
  }
  return null
}

/** 这条会话归哪个 Bot。事件回来时要知道记到谁头上。 */
function botIdOfSession(sessionId) {
  for (const [id, row] of botStreams) if (row.sessionId === sessionId) return id
  return ''
}

/**
 * 断了自己接回来。
 *
 * 以前是「流断了就停，下次打开会话才重连」——网络抖一下、或者机器管家换版重启一
 * 次，正在看的对话就无声地卡住了，人还以为 bot 在想。退避重试到这个档位为止，
 * 之后才把「连接断开」摆到界面上。
 *
 * **6 档（约 24 秒）不够。** 它挡得住网络抖一下，挡不住一次换版：重铺一个席位要拉
 * 发布包、解包、rsync 一份 app、重启两个单元，两个端口还各自自证 30 秒——几分钟是
 * 常态。24 秒之后这条流就认输了，而认输之后消息照发照跑：POST 走的是另一条请求，
 * 回答经 SSE 送出来时没人在听，屏幕上那句「正在思考」于是一直挂着，bot 日志里那一轮
 * 明明写着 completed。刷新一下就好，因为那会重开一条流——「更新完运行时，回复卡在
 * 界面上不动，刷新才看得见」说的就是这件事。
 *
 * 40 档 ≈ 5 分钟（前 5 档退避到 8 秒，之后每档 8 秒），够一次换版走完。真的一直不
 * 回来才认输，而认输也不再是死局：见 reviveChatStream——发消息、切回这个标签页、
 * 点那句话里的「重新连接」，任意一样都会当场再开一条。
 */
const CHAT_RETRY_MAX = 40
/** 连接活够这么久，就算「真的连上过」，退避档位归零。 */
const CHAT_ALIVE_MS = 10_000

/**
 * 对话流**只直连席位机器**。
 *
 * 机器配了公网地址、管家够新（≥5 号）时，Gateway 在 `bot.runtime.streamUrl` 里给一个
 * 前缀，这条 SSE 就直接打那台机器，带的还是登录票，管家那头验完换成席位票。它是整套
 * 界面里唯一一条小时级的连接，Gateway 要变成无状态的，头一个就得把它挪走
 * （docs/adr-gateway-vercel-neon.md §7 第 2 步）——所以 Gateway 上
 * `/runtime/sessions/:id/events` 那条反代已经**没有了**，直连不是「优先走」，是唯一一条路。
 *
 * 三种 Bot 三种走法：
 *
 * · **本地 Bot**（壳子里跑在这台 Mac 上的）照旧拼 `/runtime/sessions/<id>/events` 这个
 *   形状——data.js 的 localRoute 认这个形状，改道到 127.0.0.1，压根不碰 Gateway。
 * · **远程 Bot、有 streamUrl**：直接打那台机器。这一跳上的失败按老规矩分两类处置
 *   （见下面 503 和 401/403/404 两段），退避也在同一个地址上——没有别的路可退了。
 * · **远程 Bot、streamUrl 是 null**（机器没配 directUrl、或者管家太旧）：**一个请求都不
 *   发**，当场把原因摆到横幅上。这不是故障，是配置缺一项，重试只会白敲；等哪次
 *   /runtime/bots 把地址带回来，reviveDirectChatStream 会补开这条流。
 *
 * 名单上查不到这颗 Bot、或者名单没带 runtime（低层直接调用、测试）时按本地那个形状走：
 * 不是本地 Bot 的话 Gateway 会回 404，落到「答案不会变」那一支，界面上照样有话。
 */
const NO_DIRECT_STREAM_MSG = '这台机器没有配直连地址（或管家太旧），对话流开不了；找管理员在「机器」页填上 directUrl'

function runtimeBotOf(owner) {
  return owner ? (state.runtimeBots || []).find((b) => b.id === owner) || null : null
}

/** 这颗 Bot 是不是本地 Bot。两个字段都认：名单行上的 runtimeKind，和 overlayLocalRuntime 写的 runtime.kind。 */
function isLocalRuntimeBot(bot) {
  return Boolean(bot && (bot.runtimeKind === 'local' || (bot.runtime && bot.runtime.kind === 'local')))
}

/** 远程 Bot 的直连前缀；本地 Bot、没配地址、名单上没有这颗 Bot 都返回空串。 */
function directStreamBase(owner) {
  const bot = runtimeBotOf(owner)
  if (!bot || isLocalRuntimeBot(bot)) return ''
  return (bot.runtime && bot.runtime.streamUrl) || ''
}

/**
 * /runtime/bots 刷新过后：人正看着的那条会话没有流在跑、而这颗 Bot 现在有直连地址了
 * ——多半是上一次开流时地址还是 null（见 startChatStream 里 NO_DIRECT_STREAM_MSG 那一支），
 * 现在补开。正在退避的流手上还攥着 ac，chatStreamAlive 认它活着，这里不会插队。
 */
function reviveDirectChatStream() {
  const botId = state.chatBotId
  const sessionId = state.chatSessionId
  if (!botId || !sessionId || chatStreamAlive(sessionId, botId)) return
  const row = botStreams.get(botId)
  if (!row || row.sessionId !== sessionId) return
  if (!directStreamBase(botId)) {
    // 还是没有地址：把那句话写回去。loadRuntimeBots 开头把 runtimeError 清了，不写回的话
    // 下一次重绘横幅就没了，而这条流其实一直没开过。
    const bot = runtimeBotOf(botId)
    if (bot && bot.runtime && !isLocalRuntimeBot(bot)) state.runtimeError = NO_DIRECT_STREAM_MSG
    return
  }
  void startChatStream(sessionId, 0, botId)
}

async function startChatStream(sessionId, attempt = 0, botId = '') {
  const owner = botId || botIdOfSession(sessionId)
  const isActive = () => state.chatSessionId === sessionId
  if (attempt === 0) {
    const row = owner ? botStreamOf(owner) : null
    // 这条流已经在跑就别再开一条。**换 Bot 不再掐流**：名单要靠它继续报「跑完没有」。
    if (row && row.sessionId === sessionId && row.ac) {
      // 但**必须把它认领成当前那条**，不能只是 return。
      //
      // 它很可能是上一次待在这个 Bot 上时留下的（换 Bot 不掐流），或者是某条重连路径
      // 刚刚接回来的。那会儿它不是当前会话，chatAbort / chatStreamId 都没设。随后
      // ensureChatSession 把 chatSessionId 指
      // 过来，这条流在读循环里就同时满足了「是当前会话」和「chatStreamId 对不上」——那
      // 正是「人已经切走了」的判据，于是它自己收摊；retryChatStream 又拿同一把闩去认它，
      // 一次都不重连。结果就是正文一片空白、名单上没时间没摘要，切走再切回来还是空的
      // （热路径看见 ac 还在，以为流好着呢），只能刷新整页——而刷新之后这场竞态照样掷骰子。
      if (isActive() && chatAbort !== row.ac) {
        chatAbort = row.ac
        chatStreamId = sessionId
      }
      return
    }
    if (isActive()) stopChatStream()
  }
  const ac = new AbortController()
  if (owner) {
    const row = botStreamOf(owner)
    row.sessionId = sessionId
    row.ac = ac
    trimBotStreams(owner)
  }
  // `|| !owner`：没归到哪个 Bot 名下的流（低层直接调用、测试）按老规矩走单流那一套，
  // 否则它既不在 botStreams 里、又不是当前会话，就成了没人认领的孤儿——断了不重连，
  // 也没人把「连接断开」摆到界面上。
  if (isActive() || !owner) {
    chatAbort = ac
    chatStreamId = sessionId
    // 断线重连（带 after）也可能补一大段，同样先拉闸。
    beginReplay()
  }
  const t = token()
  const after = chatCursor(owner)
  // 头一次连（手上还没有事件）才要 tail，而且**只垫一轮**——打开对话要看的那二十轮
  // 走 HTTP（hydrateChat）。续传时 after 说了算，要的是「补上错过的」。
  const q = after != null ? '?after=' + encodeURIComponent(after) : '?tail=' + STREAM_TAIL_TURNS
  const bot = runtimeBotOf(owner)
  const direct = directStreamBase(owner)
  if (bot && bot.runtime && !isLocalRuntimeBot(bot) && !direct) {
    // 远程 Bot 没有直连地址：一个请求都不发（理由见 directStreamBase 上面那段）。收摊的
    // 顺序和 401/403/404 那一支一样——ac 要让出去，否则 chatStreamAlive 会一直当它活着。
    releaseChatStream(ac, owner)
    endReplay()
    noteStreamDown(sessionId, NO_DIRECT_STREAM_MSG)
    return
  }
  const streamUrl = (direct ? direct + '/sessions/' : '/runtime/sessions/') + encodeURIComponent(sessionId) + '/events' + q
  let res
  try {
    res = await swFetch(streamUrl, {
      headers: {
        accept: 'text/event-stream',
        ...(t ? { authorization: 'Bearer ' + t } : {}),
      },
      signal: ac.signal,
    })
  } catch (err) {
    if (ac.signal.aborted) {
      endReplay()
      releaseChatStream(ac, owner)
      return
    }
    endReplay()
    // **连不上要接着退避重试，不能就此认输。** 见下面 503 那条的说明。直连这一跳上
    // 「连不上」还多几种形状——机器的证书不对、CORS 头没到、管家正在换版——对人来说
    // 都是同一件事「还没接上」，处置也一样：退避重来。
    noteStreamWarming(sessionId)
    return retryChatStream(sessionId, ac, attempt + 1)
  }
  /**
   * 503 = 席位此刻不在（管家对席位的 fetch 抛了或没回 2xx，见 manager/src/proxy.ts）。
   * **这是「正在重启」，不是「坏了」**：每一次重新部署、每一次管家换版，都必然有几秒钟
   * 落在这个窗口里。
   *
   * 以前这里直接 return，于是撞上这几秒的那次重连就是最后一次——流断了、也不再重来。
   * 席位一分钟后好端端地回来了，页面却再也接不回去：消息 POST 走的是另一条请求，
   * 照发照跑，回答经 SSE 送出来时没人在听。屏幕上就一直挂着「正在思考」——因为
   * mergePending 手上那条 pending 只能靠 SSE 回来的 user/message 销账（见 mergePending）。
   * bot 日志里那一轮明明写着 completed，这是那个「日志跑完了、网页还转着」的成因。
   *
   * 退避重试到 CHAT_RETRY_MAX 为止（约 5 分钟，够一次换版走完）；真的一直不回来，
   * retryChatStream 会把「连接断开」摆到界面上。
   */
  if (res.status === 503) {
    endReplay()
    noteStreamWarming(sessionId)
    return retryChatStream(sessionId, ac, attempt + 1)
  }
  /**
   * 剩下的非 2xx 分两类，处置相反，所以必须分开。
   *
   * · **401 / 403 / 404 是「答案不会变」**：票过期了、这颗 Bot 不是你的、席位在那台
   *   机器上已经没了。重试只会白敲接口，再拿一句「实例还没上线」把真正的原因盖掉。
   *   当场认输，把席位那句原话摆出来。
   *
   * · **其余（500、502、504、以及 ok 但没有 body 的那种）跟 503 一路**：那是中间这
   *   几跳的临时故障——管家反代不到席位时回的正是 502（见 manager/src/proxy.ts），
   *   而换版那几分钟里它就是这个样子。以前这里一律认输，于是一次 502 和「席位永远
   *   没了」在界面上是同一件事。
   */
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    releaseChatStream(ac, owner)
    endReplay()
    // **render，不是 paintChat**（见 noteStreamDown 与 retryChatStream 认输那一处的
    // 长注释）：那句话摆在顶上那条横幅里，而横幅只由 chatPage() 拼。
    noteStreamDown(sessionId, (await res.text().catch(() => '')) || '实例还没上线')
    return
  }
  if (!res.ok || !res.body) {
    endReplay()
    noteStreamWarming(sessionId)
    return retryChatStream(sessionId, ac, attempt + 1)
  }
  const reader = res.body.getReader()
  // 重放卡在半路的看门狗。收到 replay/done 就撤——那之后长时间没动静是正常的。
  let sawDone = false
  let stallTimer = null
  const disarmStall = () => {
    sawDone = true
    clearTimeout(stallTimer)
  }
  const armStall = () => {
    if (sawDone) return
    clearTimeout(stallTimer)
    stallTimer = setTimeout(() => {
      if (sawDone || ac.signal.aborted) return
      try {
        ac.abort()
      } catch {}
      // 把这一行的 ac 让出去，否则重连会撞上「已经在跑」的那道闸。
      if (owner) {
        const r = botStreams.get(owner)
        if (r && r.ac === ac) r.ac = null
      }
      void startChatStream(sessionId, 0, owner)
    }, REPLAY_STALL_MS)
  }
  armStall()
  const openedAt = Date.now()
  const decoder = new TextDecoder()
  let buf = ''
  /**
   * 下一次重连用哪个退避档位。
   *
   * 判据是**这次连接活了多久**，不是「有没有连上」。两头都要照顾：
   *
   * - 只看「连上了没有」：bot 在崩溃重启循环里（接受连接后立刻断），每次都拿到 200，
   *   档位每次归零，于是每 500ms 重连一次、永远停不下来，也永远走不到「连接断开」。
   * - 只看「一共重连过几次」：一个开着一整天的标签页，被中间那一跳定期掐断 6 次之后
   *   就再也接不回来了——可每一次它都是连上的。
   *
   * 活够 CHAT_ALIVE_MS 才算一次真连接，归零；没活够就沿用当前档位继续退避。
   */
  const nextAttempt = () => (Date.now() - openedAt >= CHAT_ALIVE_MS ? 0 : attempt)
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      // 这条流已经不是「当前那条」了就收摊。切 Bot 的一瞬间，旧流手上可能还攥着一段
      // 已经收到、还没解析的数据；不在这里拦住，它会落进新会话的事件数组里，画出来
      // 就是两个 Bot 的消息串在一起。
      //
      // 判据以 chatStreamId 为准（换 Bot 必经 stopChatStream，它就是那把闩）。
      // chatSessionId 只在**已经认定了某条会话**时才参与——低层直接调 startChatStream
      // 的路径（重连、测试）还没来得及认领，不该被当成「串台」拦掉。
      if (ac.signal.aborted) break
      // **不再因为「不是当前会话」就收摊**：后台那几条流正是名单上时间、摘要和转圈的
      // 唯一来源。只有当前这条要盯 chatStreamId（重连时它会被换掉）。
      if (isActive() && chatStreamId !== sessionId) break
      // 任何字节都算脉搏——`: ping` 不是事件、下面的解析会跳过它，但它证明这条链活着。
      // **看门狗不在这里续命**（见下面的 sawData）：「这条链活着」和「重放在推进」是
      // 两件事，混成一件的后果写在 REPLAY_STALL_MS 上面。
      notePulse(ac, sessionId, owner)
      buf += decoder.decode(value, { stream: true })
      buf = buf.replace(/\r\n/g, '\n')
      let idx
      /** 这一批字节里有没有真事件。**只有它给看门狗续命**，`: ping` 不算。 */
      let sawData = false
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data: ')) continue
          sawData = true
          let ev
          try {
            ev = JSON.parse(line.slice(6))
          } catch {
            continue
          }
          if (!ev || typeof ev !== 'object') continue
          /**
           * 席位自报家门：**这是不是上次那个进程**。
           *
           * 换版就是把 bot 换一个进程，而浏览器这头只看得见「流断了」——和网络抖一下
           * 长得一模一样。于是它会拿着换版前的游标续传、接着用手上那些从旧进程攒下来
           * 的状态（正在跑的那一轮、排队的 dock、目录里的工具），而没有任何东西会来
           * 纠正它。席位每条流的第一帧都会说一句自己是谁（见 bot/src/web/index.ts 的
           * runtime/hello），认出换了进程就整条会话重来。
           *
           * **头一次见到不算重启**：那是页面刚开、或者这个 Bot 第一次连上，什么都不用做。
           */
          if (ev.type === 'runtime/hello') {
            const seat = String(ev.instanceId || '')
            const row = owner ? botStreamOf(owner) : null
            const known = row ? row.instanceId : ''
            if (row) row.instanceId = seat
            if (seat && known && known !== seat) {
              // 席位换过进程了。这条流上后面那些事件按新会话处理：先把旧的一律作废
              // （事件桶、摘要、「历史补过了」），再回去重新拿一次会话——会话 id 多半
              // 没变（它在席位的盘上），但**目录、队列、在不在跑全得重新问一遍**，
              // 而且那条 hydrate 也要重跑，否则界面停在换版前那一刻。
              seatRestarted(owner, sessionId)
              /**
               * **`return`，不是 `break`。**
               *
               * break 只跳出「这一帧里的各行」，外面按 `\n\n` 切帧的 while 还在转，
               * 而 hello 帧和新流的回放帧常常挤在同一个网络分片里。于是刚被
               * resetBotStream 清空的事件桶会被紧随其后的那些帧立刻填回去，而这时
               * `row.sessionId` 已经被置成空串——等 ensureChatSession 认下新会话时，
               * 那道 `if (row.sessionId && row.sessionId !== sessionId) reset` 因为空串
               * 而不成立，这批本该作废的事件就留在了新会话里，seq 还会把
               * chatCursor/hydrateChat 的合并判据一起带歪。
               */
              disarmStall()
              endReplay()
              return
            }
            continue
          }
          /**
           * 排队的消息有变。**不是会话事件**，不进事件桶——它还没发生，进了桶就会被
           * 当成历史画成气泡。它只画在输入框顶上那一行 dock 里。
           */
          if (ev.type === 'queue/change') {
            chatQueues.set(sessionId, Array.isArray(ev.queued) ? ev.queued : [])
            if (isActive()) paintChatQueue()
            continue
          }
          if (ev.type === 'replay/done') {
            disarmStall()
            // 刷新页面之后 dock 要能原样回来：队列在席位那边，这里只是接住它。
            if (Array.isArray(ev.queued)) {
              chatQueues.set(sessionId, ev.queued)
              if (isActive()) paintChatQueue()
            }
            // bot 明说历史放完了。它不是会话事件，不进事件桶。
            // 顺带说了这条会话此刻在不在跑——这句是权威，压过扫出来的那个结论。
            // 续传（after>0）那次 bot 不给这两个值；流垫的又只有一轮，比 hydrateChat
            // 那二十轮窄。两种情况都由 noteChatPage 挡住，别把已经知道的覆盖掉。
            if (typeof ev.firstSeq === 'number' || typeof ev.hasMore === 'boolean') {
              noteChatPage(sessionId, { firstSeq: ev.firstSeq, hasMore: ev.hasMore })
            }
            if (typeof ev.live === 'boolean') {
              chatLive.set(sessionId, ev.live)
              /**
               * 名单上那颗点也是扫出来的，同样会挂在「正在执行」上下不来。
               *
               * **改 `busy` 再让 settleDot 去算，不能直接写 `state`。** 全场只有这一处
               * 曾经直接写 state，而 state 是派生量：30 秒一次的 applyHandoffSnapshot
               * 会对每一行调 settleDot，按 `busy`/`asking`/openIds 重算一遍。busy 还留
               * 着旧的 true（席位崩在半路，日志里有 turn/start 没 turn/end），那颗点就
               * 在下一次轮询时被翻回「正在执行」，而且再也下不来——正是这面权威旗子要
               * 治的病，换个地方又长了出来。顺带 `review`（等审批/转人工）也不该被这一
               * 下抹掉，交给 settleDot 就都对了。
               */
              if (owner) {
                const sum = botStreamOf(owner).sum
                sum.busy = ev.live
                settleDot(sum)
                scheduleRosterPaint()
              }
            }
            if (isActive()) {
              endReplay()
              // **必须无条件重画。** endReplay 的第一行是「闸已经开过了就 return」，
              // 而重放一段长历史（实测 988 条）必然撞上 4 秒硬上限或 120ms 静默兜底，
              // 闸早就自己开了。于是走到这儿时 endReplay 直接返回——bot 刚给的结论
              // 存进了 chatLive，却一帧都没画出来。而这之后没有任何事件会再来触发重绘
              // （正因为它说的就是「没在跑」），界面就永远停在开闸那一刻的样子：
              // 一个悬着的 turn/start，一句「正在处理」，等多久都不变。
              schedulePaintChat()
            }
            continue
          }
          // bot 表过态之后，这个结论就由实时的 turn 事件接着维护。表态之前不碰它——
          // 那会儿来的是重放的历史，正是不能拿来下结论的那一批。
          if (chatLive.has(sessionId) && (ev.type === 'turn/start' || ev.type === 'turn/end')) {
            chatLive.set(sessionId, ev.type === 'turn/start')
          }
          if (owner) {
            if (!pushBotEvent(owner, ev)) {
              // 重复的——历史那条路已经收过这一条了。不进桶、不改摘要，但它证明流还
              // 活着，重放的静默判定要跟着往后推，否则一段全是重复的重放会让闸提前开。
              if (isActive() && state.chatReplaying) bumpReplayQuiet()
              continue
            }
            noteBotEvent(owner, ev)
          } else if (isActive()) {
            // 没有归属又不是当前会话的流，事件无处可放——**绝不能倒进 chatEvents**，
            // 那正是「切走了，旧流剩下的半截落进新会话」的老毛病。
            state.chatEvents.push(ev)
          }
          if (!isActive()) continue
          // replay/done 之前都是历史，不能因为翻到昨天生成过一个网页就突然弹预览。
          // 只有真正的实时 tool/result 才触发自动打开/刷新。
          if (sawDone) maybeLivePreview(ev)
          // 重放还在继续：把「静默」判定往后推。**但照画**——合并重绘由 rAF 管，
          // 状态由 paintChat 摁着不会说假话（两处都见重放闸那段说明）。以前这里是
          // 「重放期间一帧都不画」，代价是刷新之后最长四秒屏幕上什么都没有。
          if (state.chatReplaying) bumpReplayQuiet()
          schedulePaintChat()
        }
      }
      // 重放在推进，就把看门狗往后推一格。**放在解析之后**：这一批里要是有
      // replay/done，sawDone 已经置位，armStall 自己会空转。
      if (sawData) armStall()
    }
  } catch (err) {
    disarmStall()
    endReplay()
    if (!ac.signal.aborted) return retryChatStream(sessionId, ac, nextAttempt())
    return
  }
  disarmStall()
  endReplay()
  // 正常读到 done 也要重连：SSE 被中间那一跳掐掉时看起来就是干净的流结束。
  if (!ac.signal.aborted) return retryChatStream(sessionId, ac, nextAttempt())
}

function retryChatStream(sessionId, ac, attempt) {
  const owner = botIdOfSession(sessionId)
  const row = owner ? botStreams.get(owner) : null
  // 后台流也要重连——名单上的「跑完没有」全指望它。
  if (row ? row.ac !== ac : chatAbort !== ac || chatStreamId !== sessionId) return
  if (attempt >= CHAT_RETRY_MAX) {
    /**
     * 退避到头了。**但不能就此撒手。**
     *
     * 线上抓到的那一次：席位 22:23:25 重启、22:23:26 就在听了，而浏览器直到 5 分钟后
     * 才连上——中间那几百秒里席位一条连接都没收到。原因是标签页在后台：浏览器把
     * setTimeout 节流到分钟级、久了干脆冻住，退避链要么走得极慢、要么根本不走，等它
     * 醒过来时档位早就到头，于是「认输」，从此再没有任何东西去碰它。人回到这一页，
     * 看到的就是一条死掉的对话——而席位好端端地在那儿。
     *
     * 所以认输之后转成**慢速长跑**：每 CHAT_IDLE_RETRY_MS 试一次，只要这一页还开着就
     * 一直试。代价是每半分钟一个请求（而且只在这条流真的断着时才有），换来的是「席位
     * 回来了，界面自己就接上了」——不必等人想起来刷新。
     */
    releaseChatStream(ac, owner)
    idleRetry(sessionId, owner)
    /**
     * **必须 render()，paintChat() 是不够的。**
     *
     * 这句话和旁边那颗「重新连接」按钮画在顶上那条横幅里，而横幅只在 chatPage() 里
     * 拼一次（见 runtimeDownBanner 的调用处）；paintChat 只重画消息流和输入区那几个
     * 已有节点，横幅一个字都不会变。
     *
     * 而这一刻的处境恰恰是「再也不会有别的东西来触发重绘」——流已经死了，事件不会
     * 再来，tickClocks 只改 .sw-time 的文本。于是屏幕上什么都没有：认输了、没人再
     * 重连、也没有那颗能救回来的按钮，界面就那么静静挂着——正是这次要修的那个症状。
     * retryChatSession 认输那一处走的就是 render()。
     *
     * 整页重绘的代价（输入框被换掉、正打着字的人丢焦点和光标位置，见 paintChatCtx 上
     * 的注释）在这里认了：它一整条流只发生**一次**，而且是在连着五分钟接不上之后；
     * 草稿本身跟着 state.chatDraft 回来，不会丢。而后台那几条流断了不走这一下——
     * 见 noteStreamDown。
     */
    noteStreamDown(sessionId, '连接断开')
    return
  }
  const delay = Math.min(500 * 2 ** attempt, 8000)
  setTimeout(() => {
    // 判据要和上面那一条一样。后台流不在 chatAbort 名下，拿当前会话那把闩去认它，
    // 它就永远等不到这次重连——名单上的时间和摘要从此停在断线那一刻。
    const r = owner ? botStreams.get(owner) : null
    if (r ? r.ac !== ac : chatAbort !== ac || chatStreamId !== sessionId) return
    void startChatStream(sessionId, attempt + 1, owner)
  }, delay)
}

/**
 * 「这条流断了」摆到界面上。
 *
 * **只有人正看着的那一条有资格占用那条横幅。** 切过 Bot 之后手上会留着前几条对话流
 * （见 BOT_STREAM_MAX），其中任何一条断掉都会走到这里——而它说的是另一个 Bot 的事：屏幕上
 * 那条对话好好的，却被扣上一句「连接断开」，人会去点那颗「重新连接」，重连的也是另一
 * 条流。更实在的代价是**那一下是整页重绘**：正在打字的人当场丢焦点和光标位置，而起因
 * 是他根本没在看的一个 Bot。
 *
 * 留着的那几条断了就安静地放手：名单上那一行照旧由名单通道维护，人点进去时
 * ensureChatSession 会重新拿会话、重新开流。
 */
function noteStreamDown(sessionId, message) {
  if (state.chatSessionId !== sessionId) return
  state.runtimeError = message
  // **人不在对话页上就只记下来，不重绘。** 横幅只由 chatPage() 拼，在别的页上重绘一
  // 次谁也看不到那句话，代价却是把人正在填的表单换掉（切走不掐流，所以这条流完全
  // 可能在人已经翻到「机器」页之后才认输）。他回到对话页时 loadPage 自己会重绘。
  if (isChatPath(state.path)) render()
}

/**
 * 「这条流还在热身，正在退避重连」。同样只对人正看着的那一条说。
 *
 * runtimeDownBanner 把「实例还没上线」挡在界面外（它是常态，不该每次重新部署都弹红
 * 字），所以这一句本身不上屏——但它**会盖掉正摆着的那一句**。名单上那几个 Bot 的流
 * 各自在退避重连，谁都会往这一格里写：当前这条会话刚拿到一句「这颗 Bot 不是你的」，
 * 半秒后就被另一个 Bot 的 503 抹成「实例还没上线」，然后横幅连带着消失，人什么都
 * 看不到了。scope 一道，这一格就只由人正看着的那条会话写。
 */
function noteStreamWarming(sessionId) {
  if (state.chatSessionId !== sessionId) return
  state.runtimeError = '实例还没上线'
  // 同上：不在对话页上就没有可画的（paintChat 找不到 chat-thread 会直接返回，但在那
  // 之前它已经把整份事件 fold 了一遍——长会话上这不便宜，而且每一档退避都来一次）。
  if (isChatPath(state.path)) paintChat()
}

/**
 * 认输之后的慢速长跑。每 30 秒试一次，只要这一页还开着就不停。
 *
 * **和退避重连不是一回事**：那一段是「刚断，赶紧接回来」，节奏以秒计；这一段是「已经
 * 断了很久」，节奏以半分钟计，为的是不放弃。标签页在后台时浏览器会把它节流甚至冻住
 * ——那没关系，回到前台时 visibilitychange 那一路会立刻补一次（见文件末尾）。
 *
 * 同一个 Bot 只留一根：重复排会让请求成倍增长，而它们全都在等同一件事。
 */
const CHAT_IDLE_RETRY_MS = 30_000
const idleTimers = new Map()

function idleRetry(sessionId, botId) {
  const key = botId || sessionId
  if (idleTimers.has(key)) return
  const timer = setTimeout(() => {
    idleTimers.delete(key)
    // 这期间已经接上了（发消息、切回前台、点了「重新连接」）就不用再排。
    if (chatStreamAlive(sessionId, botId)) return
    // 会话都没了（换了 Bot、退了登录）也不再追。
    const row = botId ? botStreams.get(botId) : null
    if (botId && (!row || row.sessionId !== sessionId)) return
    /**
     * **从最后一档进去**，不是从头。
     *
     * 从 0 开始的话，每次长跑都会带出一整轮退避（40 次、五分钟、越到后面越密），而这
     * 会儿的处境明明是「已经断很久了」——那是在拿请求去撞一扇多半还关着的门。停在最后
     * 一档：连上就照常跑（活够 10 秒退避档位自己归零，见 nextAttempt），连不上就立刻
     * 再落回这条长跑，节奏稳定在半分钟一次。
     */
    void startChatStream(sessionId, CHAT_RETRY_MAX, botId)
  }, CHAT_IDLE_RETRY_MS)
  idleTimers.set(key, timer)
}

/**
 * 撤掉一根长跑。**只撤指名的那一根**——名单上每个 Bot 各有各的，开一条流不该把别人的
 * 也一并撤了：那些流断着，撤掉就再没有人去接，侧栏那几行从此停在断线那一刻。
 */
function cancelIdleRetry(key) {
  const t = idleTimers.get(key)
  if (!t) return
  clearTimeout(t)
  idleTimers.delete(key)
}

/** 退出登录时全撤：票都清了还在敲上一个人的席位，那就不只是难看了。 */
function cancelIdleRetries() {
  for (const t of idleTimers.values()) clearTimeout(t)
  idleTimers.clear()
}

/**
 * 「会话一直拿不到」的慢速长跑。和 idleRetry 一个节奏、共用一张表（退出登录一并撤）。
 *
 * key 上带前缀：同一个 Bot 可能同时有一根流的长跑和一根会话的长跑，撞 key 会让后排上
 * 的那根被当成「已经排过了」直接扔掉。
 */
function idleSessionRetry(botId) {
  if (!botId) return
  const key = 'session:' + botId
  if (idleTimers.has(key)) return
  const timer = setTimeout(() => {
    idleTimers.delete(key)
    // 期间已经接上了、或者人早切到别的 Bot 去了，就不用再排。
    if (state.chatBotId !== botId || state.chatSessionId) return
    void ensureChatSession(botId).catch(() => {
      // 「答案不会变」的那些（Bot 被删了、没权限）由 ensureChatSession 自己摆到界面上，
      // 这里不再重排：那种情况下长跑就是在白敲接口。
    })
  }, CHAT_IDLE_RETRY_MS)
  idleTimers.set(key, timer)
}

/**
 * 席位换了一个进程：这一路的东西全部作废，从头再问一遍。
 *
 * **不是「重连一下」就完了。** 换版之后那些还留在手上的东西，每一样都会骗人：
 *
 * · 事件桶和摘要——旧进程攒下的，界面停在换版前那一刻；
 * · 「正在跑」——旧进程那一轮已经随它一起没了，日志里连 turn/end 都没写成，
 *   而界面会一直挂着「正在思考」（这正是上一轮修过的那个症状的成因）；
 * · 排队的 dock、目录里的工具——都在席位那边，新进程重新拉过一遍，可能已经不一样了。
 *
 * 所以走 ensureChatSession 那条整路：重新拿会话（id 多半没变，它在席位的盘上，但那
 * 一跳同时会把「实例还没上线」那类状态清干净）、重新 hydrate、重新开流。resetBotStream
 * 把上面那三样一起清掉。
 */
function seatRestarted(botId, sessionId) {
  const row = botId ? botStreams.get(botId) : null
  const seat = row ? row.instanceId : ''
  if (row) {
    resetBotStream(row)
    // resetBotStream 会把 sessionId 之外的都清掉；身份要留着，否则下一条流又会把
    // 「头一次见到」当成重启，白重来一轮。
    row.instanceId = seat
    row.sessionId = ''
  }
  chatLive.delete(sessionId)
  chatQueues.delete(sessionId)
  chatPages.delete(sessionId)
  if (state.chatSessionId === sessionId) {
    state.chatSessionId = ''
    state.chatStatus = ''
    state.chatReplaying = false
  }
  if (!botId) return
  /**
   * **人正看着的那一个才走整路**（ensureChatSession：拿会话 + 补历史 + 开流 + 把
   * 「实例还没上线」那类话清掉）。名单上别的 Bot 换版了只悄悄挂回后台流——走
   * ensureChatSession 的话，它会把「当前 Bot」改成那一个，人正在看的对话会被拽走。
   */
  if (state.chatBotId === botId) {
    void ensureChatSession(botId).catch((err) => {
      // 这一路没有别的调用方接得住它（换版撞上「这颗 Bot 已经被删了」是真会发生的）。
      flash('err', err.message)
      render()
    })
    return
  }
  /**
   * 名单上别的 Bot 换版了：**什么都不用做**。它的状态走名单那条通道（一条管所有
   * Bot），而那条通道自己会断线重连、重连时带 `after` 把缺的补回来。以前这里要单独
   * 给它挂一条后台流，正是「一个 Bot 一条流」那套的尾巴。
   */
}

/** 这条会话此刻有没有人在听。判据和 startChatStream 那道「已经在跑」的闸一致。 */
function chatStreamAlive(sessionId, botId) {
  if (!sessionId) return false
  const row = botId ? botStreams.get(botId) : null
  if (row && row.sessionId === sessionId && row.ac) return true
  return chatStreamId === sessionId && Boolean(chatAbort)
}

/**
 * 心跳静默看门狗：**连接没断、字节也再也不来**的那种半死流，只有它救得回来。
 *
 * 这条链有三跳（浏览器 → Gateway → 管家 → 席位），任何一跳把「断」吞掉——反代的
 * pipe 没收尾、网络半开（NAT 超时、机器断电）——浏览器手上这条流就成了「看着还开
 * 着、永远等不来下一个字节」。而重连、退避、慢速长跑、发消息前的 reviveChatStream、
 * 切回前台那一路，**全都以 `row.ac` 在不在为判据**：半死的流 ac 还在，谁都以为它
 * 好着，于是没有任何东西会去碰它。消息照发照跑，回答经 SSE 送出来时没人在听，
 * 屏幕上那句「正在思考」就一直挂着——这正是修了好几轮都没除根的那个形状：每一轮
 * 修的都是「断了之后接不回来」，而这一种压根**没有断**。
 *
 * 判据是 bot 每 15 秒一条的 `: ping`（见 bot/src/web/index.ts 的心跳）：它不是事件、
 * 解析时直接跳过，但它是字节。任何字节都把脉搏往后推；45 秒（三个心跳）没有任何
 * 字节，就把这条流当死的拆掉重连——带 after 游标，静默期间错过的一起补回来。
 *
 * **只盯收到过字节的流。** 连上了却一个字节都没来的那种归重放看门狗管
 * （REPLAY_STALL_MS，8 秒），这边不掺和——也免得对一条还在建连的流下错结论。
 *
 * 定时器懒起懒收：有流才跑，表空了就停。后台标签页里被节流到分钟级没关系——
 * 晚一点发现死流总好过永远不发现，而回到前台还有 visibilitychange 那一路先补。
 */
const STREAM_SILENT_MS = 45_000
const STREAM_SWEEP_MS = 15_000
/** ac -> { sessionId, owner, at }。at = 最后一个字节到达的时刻。 */
const streamPulse = new Map()
let streamSweepTimer = null

function notePulse(ac, sessionId, owner) {
  const p = streamPulse.get(ac)
  if (p) {
    p.at = Date.now()
    return
  }
  streamPulse.set(ac, { sessionId, owner, at: Date.now() })
  if (streamSweepTimer == null) {
    streamSweepTimer = setInterval(() => sweepSilentStreams(), STREAM_SWEEP_MS)
    // Node 环境（e2e 垫片）下别拽着进程不退出；浏览器里 setInterval 是数字，没有 unref。
    if (streamSweepTimer && typeof streamSweepTimer.unref === 'function') streamSweepTimer.unref()
  }
}

function dropPulse(ac) {
  if (ac) streamPulse.delete(ac)
}

function sweepSilentStreams(now) {
  const t = now || Date.now()
  for (const [ac, p] of streamPulse) {
    const row = p.owner ? botStreams.get(p.owner) : null
    // 已经不是任何人手上的那条了（重连换了 ac、或者早被掐了）：只清账，不动流。
    const held = (row && row.ac === ac) || chatAbort === ac
    if (ac.signal.aborted || !held) {
      streamPulse.delete(ac)
      continue
    }
    if (t - p.at < STREAM_SILENT_MS) continue
    streamPulse.delete(ac)
    // 和重放看门狗同一套拆法：先把这一行的 ac 让出去，否则重连会撞上「已经在跑」的闸。
    try {
      ac.abort()
    } catch {}
    if (row && row.ac === ac) row.ac = null
    void startChatStream(p.sessionId, 0, p.owner)
  }
  if (!streamPulse.size && streamSweepTimer != null) {
    clearInterval(streamSweepTimer)
    streamSweepTimer = null
  }
}

/**
 * 没人在听就当场再开一条。
 *
 * **认输不该是死局。** retryChatStream 退避到头会把 ac 清掉、摆一句「连接断开」——
 * 那之后没有任何东西会再去重连，而这一屏还好端端地开着：消息照发照跑，回答经 SSE
 * 送出来时没人接，屏幕上一直挂着「正在思考」。原先唯一的出路是刷新整页。
 *
 * 三个入口都走这里：发消息之前（人正要用它，这是最该确认的一刻）、标签页回到前台
 * （合盖一小时回来，中间那一跳早把流掐了）、以及那句话里的「重新连接」。
 *
 * 重连带 after 游标（见 chatCursor），断线期间错过的那几条会一起补回来——所以这不是
 * 「从现在开始听」，是真的把断掉的那一段接上。
 */
function reviveChatStream(sessionId, botId) {
  const owner = botId || botIdOfSession(sessionId)
  if (!sessionId || chatStreamAlive(sessionId, owner)) return false
  /**
   * 这句话是上一次认输留下的，现在正要重来，先撤掉。
   *
   * **撤掉要连着 render()。** 它和那颗「重新连接」按钮画在顶上那条横幅里，而横幅只由
   * chatPage() 拼——只清 state 不重绘的话，屏幕上那句「连接断开」会一直挂着，人一边看
   * 着「断了」一边收到新回复。这一下只在「上次认输过、现在正接回来」时发生，罕见到
   * 值得为它付一次整页重绘（正打着字的人会丢焦点，见 paintChatCtx 上的注释）。
   */
  // 人主动把它叫醒了（发消息 / 切回前台 / 点按钮），排着的那根慢速长跑就没用了：
  // 快的这一条接手。留着它只是多一个到点空转的定时器。
  cancelIdleRetry(owner || sessionId)
  if (state.runtimeError === '连接断开') {
    state.runtimeError = ''
    // 同 noteStreamDown：人不在对话页上就没有可撤的横幅，别为它把这一页整块换掉。
    if (isChatPath(state.path)) render()
  }
  void startChatStream(sessionId, 0, owner)
  return true
}

/**
 * 重放闸。
 *
 * 打开一条会话时，SSE 会把**全部历史**从头推一遍，和后续的实时事件走同一个通道。
 * 一条 8 轮的对话就是 789 条事件（其中 706 条是流式 chunk）。以前每收到一条就重绘一
 * 次：每次都要 fold 全量事件、比对整棵 DOM、把最后那段 Markdown 重渲染一遍——O(n²)，
 * 而且屏幕上能看见消息一条条往外冒。
 *
 * 更糟的是**状态是错的**：重放到某轮的 `turn/start` 就显示「正在处理」，要等重放出
 * 配对的 `turn/end` 才消失。实测 789 帧里有 772 帧（98%）挂着「正在处理」，而那期间
 * 什么都没在跑——它说的是几小时前那一轮。
 *
 * 这道闸原来的做法是**重放期间一帧都不画**，历史放完再画一次。它治住了上面两条，
 * 却把「闪错状态」换成了更难受的「一片空白」：闸只在 replay/done 到达、或者静默
 * 120ms、或者 4 秒硬上限时才开，而刷新页面时这条流正在跟别的请求抢连接槽（当年名单上
 * 是一个 Bot 一条流），事件断断续续地来，静默判定一次次被推后——于是整整四秒，屏幕上
 * 什么都没有。
 *
 * 现在两头都要：
 *   · **照画。** rAF 已经把一帧里的若干条合并成一次重绘（见 schedulePaintChat），
 *     O(n²) 那笔账本来就不该由这道闸来还。
 *   · **状态由 paintChat 摁住**：重放期间席位还没表态，一律按「没在跑」，扫描扫出来
 *     的那个中间态一眼都不会露出来。
 *
 * 闸本身留着，它现在只回答「席位表态了没有」这一件事。三个判据照旧：
 *   1. bot 发的 `replay/done`（准确，但要 bot 也升级）
 *   2. 静默 120ms（兜底：重放是连续灌的，一停就是灌完了）
 *   3. 4 秒硬上限，免得某条流一直断续把闸卡死
 */
/**
 * 重放停在半路多久算「卡住了」。
 *
 * bot 把整段历史 enqueue 完就立刻发 `replay/done`，两者在网线上几乎是挨着的。所以
 * 「收着收着没了、而且迟迟等不到 replay/done」只有一种解释：尾巴压在下游某一层的
 * 缓冲里，而一条安静的会话再也不会有新字节把它顶出去。实测就是这样丢了 24 条。
 *
 * 到点就带着游标重连——bot 会把缺的那截补上，`replay/done` 也跟着来。比干等强，
 * 也比整页刷新强：刷新是从 0 再放一遍，缓冲边界照样可能卡在同一个地方。
 *
* **4 秒，而不是原来的 8 秒。**
 *
 * 能缩短，是因为上面那条 sawData 把这道闸的判据修对了：它现在量的是「**重放有没有在
 * 推进**」——只有真事件给它续命，`: ping` 不算。所以「N 秒内一条事件都没来、而
 * replay/done 也没到」就是货真价实的卡住，不必留那么宽的余量。判据没修之前不敢缩：
 * 那会儿它量的是「有没有收到字节」，一次慢一点的重放就会被误杀。
 *
 * **为什么不是反过来、让那条 15 秒的 ping 先去顶。** ping 存在的理由确实是把压在下游
 * 缓冲里的尾巴顶出去（见 bot 的 web/index.ts），闸拉到 20 秒就能等到它。可席位那条
 * `setInterval` 是从开流那一刻起算的，第一条 ping 稳稳落在 15 秒——**比现在这条重连
 * 路径还慢**。线上那份日志里，相隔整 8 秒的那次重连（`tail=1` 之后紧跟一条
 * `after=<游标>`）是**成功**的：补上之后就不再卡了。既然重连本来就管用，就让它快一点。
 *
 * 缩到 4 秒之后，人看到的那段空白从 8 秒变成 4 秒。至于 replay/done 一开始为什么会
 * 丢——那是下游哪一跳在攒帧的问题，得用 gateway/deploy/check-sse.mjs 逐跳打出来，
 * 不在这道闸的职责里。
 */
const REPLAY_STALL_MS = 4000
const REPLAY_QUIET_MS = 120
const REPLAY_MAX_MS = 4000
let replayQuietTimer = null
let replayCapTimer = null

function beginReplay() {
  state.chatReplaying = true
  clearTimeout(replayCapTimer)
  replayCapTimer = setTimeout(() => endReplay(), REPLAY_MAX_MS)
  bumpReplayQuiet()
}

/** 又来一条：重放还在继续，把「静默」判定往后推。 */
function bumpReplayQuiet() {
  if (!state.chatReplaying) return
  clearTimeout(replayQuietTimer)
  replayQuietTimer = setTimeout(() => endReplay(), REPLAY_QUIET_MS)
}

function endReplay() {
  clearTimeout(replayQuietTimer)
  clearTimeout(replayCapTimer)
  if (!state.chatReplaying) return
  state.chatReplaying = false
  paintChat()
}

let chatPaintQueued = false

/**
 * 流式渲染期间合并重绘。
 *
 * 每个 token 都整块 innerHTML 重建一次会话，是 O(n²)：第 n 个 token 要连带重画前面
 * n-1 条消息。一帧一次就够，人眼分辨不出差别，长会话下差别很大。
 */
function schedulePaintChat() {
  if (chatPaintQueued) return
  chatPaintQueued = true
  const run = () => {
    chatPaintQueued = false
    paintChat()
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
  else setTimeout(run, 16)
}

/* ══ 对话渲染 ════════════════════════════════════════════════════════
   一轮回答期间 paintChat 每帧跑一次，所以这里只有一条规矩：**只动变了的那一块**。
   两层各管一段：

     消息层  syncThread —— 按 data-key 比对，新消息插进来，旧的连节点都不换
     正文层  syncMd     —— 把正文切成 Markdown 顶层块，只重画正在长的那一块

   两层都要。只做消息层的话，一条越写越长的回答每帧都要重排整段正文，连带把里面
   已经画好的 mermaid 图和公式重画一遍；只做正文层的话，每帧还是在重建整条消息流。
   分开之后稳定的部分节点身份不变，markdown.js 打在上面的 data-done 才作数。
   ══════════════════════════════════════════════════════════════════ */

/* 时间戳统一按 SATU_TZ 读（定义在 state.js，全站只此一份）。跟 fmtTime 保持一致——
   同一屏上两套时区最难查。 */
function chatClock(ms) {
  if (!ms) return ''
  return new Intl.DateTimeFormat('en-GB', { timeZone: SATU_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms))
}

/** YYYY-MM-DD，只用来比「是不是同一天」。 */
function chatDayKey(ms) {
  if (!ms) return ''
  return tzDayKey(ms)
}

function chatDayLabel(ms) {
  const key = chatDayKey(ms)
  if (!key) return ''
  const now = Date.now()
  if (key === chatDayKey(now)) return t('今天')
  if (key === chatDayKey(now - 86400000)) return t('昨天')
  return key
}

const ICON_CLIP =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>'
const ICON_X =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'

/* 发送 / 停止。同一个按钮的两副面孔，所以放在一起。 */
const ICON_SEND =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>'
const ICON_STOP =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>'

const ICON_BOT =
  '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>'
const ICON_TOOL =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>'
/** 发信那张卡的抬头。信封比盾牌说得更准：这一张问的是「这封信发不发」。 */
const ICON_MAIL =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>'

/** 交接卡的抬头。举手：这是**一个人被叫来了**，不是一道边界拦下了什么。 */
const ICON_HAND =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 11V6a1.5 1.5 0 0 0-3 0"/><path d="M15 10V4a1.5 1.5 0 0 0-3 0v6"/><path d="M12 10V5a1.5 1.5 0 0 0-3 0v7"/><path d="M9 12V8a1.5 1.5 0 0 0-3 0v6a7 7 0 0 0 7 7h1a7 7 0 0 0 7-7v-3"/></svg>'

/** 确认卡上那面盾。用盾不用感叹号：这是一道**边界**，不是一次故障。 */
const ICON_SHIELD =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6z"/><path d="M9 12l2 2 4-4"/></svg>'
const ICON_DOWN =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>'
const ICON_FILE =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h6"/></svg>'

/** 当前这条对话属于哪个 Bot。抬头和导出都要用。 */
function chatBotOf() {
  const id = chatBotIdOf(state.path) || state.chatBotId
  return (state.runtimeBots || []).find((b) => b.id === id) || null
}

/**
 * 一条工具痕迹。
 *
 * 只露名字和状态，**不展开结果**：工具结果动辄几千字（一次文件读、一次搜索），摊在
 * 对话里会把真正的回答挤到屏幕外。要看细节去右栏的运行环境。
 */
/**
 * 这条消息里 Bot 落地的文件，按路径去重。
 *
 * 同一个文件被 edit 三次只该出现一次——人关心的是「产出了什么」，不是「被碰了几下」。
 */
function outputFiles(tools) {
  const seen = new Map()
  for (const x of tools || []) {
    for (const f of x.files || []) {
      if (f && f.path && !seen.has(f.path)) seen.set(f.path, f)
    }
  }
  return [...seen.values()]
}

/**
 * 缩略图自动加载的上限。
 *
 * 缩略图取的是**原图**——没有服务端缩放（那要拉原生图像库，而部署包是预打的 arm64）。
 * 所以大图不自动拉，留占位，点开再说：一屏十张 8 MB 的图会把内存和带宽一起吃掉。
 */
const SHOT_AUTO_MAX = 2 * 1024 * 1024

/** path → blob URL。同一张图在历史里可能出现多次，只取一次。 */
const SHOT_CACHE = new Map()
const SHOT_CACHE_MAX = 40

function shotCachePut(path, url) {
  SHOT_CACHE.set(path, url)
  while (SHOT_CACHE.size > SHOT_CACHE_MAX) {
    const oldest = SHOT_CACHE.keys().next().value
    const dead = SHOT_CACHE.get(oldest)
    SHOT_CACHE.delete(oldest)
    /**
     * **只吊销没人再看的那份。**
     *
     * 被挤出缓存不等于没人用：那张图多半还挂在上面某条消息的 <img> 上。吊销掉，
     * 那个节点下次重绘（往前翻一页历史、或者这一行的 data-sig 变了）就会拿着一个
     * 已经作废的 blob: 去取图，显示成永久破图——而缓存里已经没有它，fillShots 也
     * 只认带 data-shot 的占位元素，不会再去补。
     */
    if (dead && !shotInUse(dead)) setTimeout(() => URL.revokeObjectURL(dead), 0)
  }
}

/** 这个 blob URL 还挂在页面上吗。遍历而不是拼属性选择器——省掉一层转义的坑。 */
function shotInUse(url) {
  for (const img of document.querySelectorAll('.sw-shot img')) {
    if (img.src === url) return true
  }
  return false
}

/** 把占位换成真图。失败就留占位——一张图没取到，不该让整条消息看起来出了错。 */
async function fillShots(host) {
  if (!host || !state.chatSessionId) return
  const sessionId = state.chatSessionId
  for (const el of host.querySelectorAll('.sw-shot[data-shot]')) {
    const path = el.getAttribute('data-shot')
    // 取过就别再取：这个函数每帧都可能被调到。
    el.removeAttribute('data-shot')
    if (!path) continue
    const cached = SHOT_CACHE.get(path)
    if (cached) {
      el.innerHTML = '<img src="' + esc(cached) + '" alt="">'
      continue
    }
    try {
      const url = '/runtime/sessions/' + encodeURIComponent(sessionId) + '/files?path=' + encodeURIComponent(path)
      const res = await swFetch(url, { headers: authHeaders() })
      // 不读的响应体要显式收掉，否则连接和缓冲会一直挂着——一屏十张大图就是十条，
      // 正好是下面那道大小闸想省下的开销。
      if (!res.ok) {
        await res.body?.cancel().catch(() => {})
        continue
      }
      if (Number(res.headers.get('content-length') || 0) > SHOT_AUTO_MAX) {
        await res.body?.cancel().catch(() => {})
        continue
      }
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      shotCachePut(path, objectUrl)
      el.innerHTML = '<img src="' + esc(objectUrl) + '" alt="">'
    } catch {
      /* 留占位 */
    }
  }
}

/**
 * 用户发的一张图。
 *
 * 用 <img> 直接指预览接口是不行的——Gateway 认 Authorization 头，而 src= 带不了头。
 * 所以先画一个占位，等 loadShot 把 blob 取回来再填进去。
 */
function shotHtml(img) {
  return (
    `<button type="button" class="sw-shot" data-act="chat-preview" data-path="${esc(img.path)}" ` +
    `data-name="${esc(img.path.split('/').pop() || img.path)}" data-shot="${esc(img.path)}" ` +
    `title="${esc(img.path)}"><span class="sw-shot-ph">${ICON_FILE}</span></button>`
  )
}

/**
 * 一条消息底下最多摆几张过程截图。
 *
 * 一次多步浏览（navigate → click → snapshot → click…）在同一轮里轻松走十几步，全摆
 * 出来是四五行缩略图，把真正的回答挤出屏幕。前十二张已经足够看出「它是怎么走到这儿
 * 的」，而**一张都没丢**——全都在工作区 `browser/<会话>/` 里按时间排着。
 */
const MAX_STEP_SHOTS = 12

/**
 * 这条消息里浏览器每走一步拍下的那张图，按步骤顺序、按路径去重。
 *
 * 和产出文件分开摆：那一排是「Bot 产出了什么」（它写的报告、下载的附件），这一条是
 * 「它路上看到了什么」。混在一起的话，一次浏览的十几张过程图会把真正的产出埋掉。
 */
function stepShots(tools) {
  const seen = new Map()
  for (const x of tools || []) {
    const shot = x && x.shot
    if (shot && shot.path && !seen.has(shot.path)) seen.set(shot.path, shot)
  }
  return [...seen.values()]
}

/** 没摆下的那些。**不闷声吞掉**——闷声截断会让人以为这次就走了这么几步。 */
function stepMoreHtml(n) {
  return `<span class="sw-chip sw-stepmore">${esc(t('还有 N 张，在工作区 browser/ 里', 'N more in browser/ in the workspace').replace('N', String(n)))}</span>`
}

/** 一个可点开的产出文件。这是「用户怎么发现 Bot 生成了东西」的那一环。 */
function fileChipHtml(f) {
  return (
    `<button type="button" class="sw-chip sw-filechip" data-act="chat-preview" ` +
    `data-path="${esc(f.path)}" data-name="${esc(f.name || f.path)}" title="${esc(f.path)}">` +
    `${ICON_FILE}<span>${esc(f.name || f.path)}</span></button>`
  )
}

/**
 * 一条工具痕迹。
 *
 * **不再挂 title**：原生 tooltip 要等一秒才出、只能显示一行纯文本，而且会和下面那个
 * 悬浮窗同时冒出来。详情改由 sw-toolpop 给——参数和结果都在里面，那两样才是「它刚才
 * 到底干了什么」的答案，尤其是失败的那几颗，以前只能去导出记录里翻。
 *
 * 详情**不塞进 data-***：一次 bash 的参数加输出动辄几 KB，进属性要转义、要整份重复
 * 写进 DOM，而 chips 每次状态变化都重画一遍。改成 updateRow 把工具对象直接挂在节点上。
 */
function chipHtml(x, i) {
  const state_ = x.result == null ? 'running' : x.failed ? 'error' : 'done'
  const label = x.result == null ? t('调用中') : x.failed ? t('失败') : t('完成')
  return `<span class="sw-chip sw-toolchip" data-state="${state_}" data-i="${i}" tabindex="0">${ICON_TOOL}<span>${esc(x.name)} · ${esc(label)}</span></span>`
}

/**
 * 正文里被**行内代码**点了名的产出文件。
 *
 * 判据是 markdown 源码里出现 `` `路径` ``，而不是去渲染后的 DOM 里找。两个理由：
 * 一是它要参与 chips 那条的 sig（决定底下还摆哪几颗），必须在渲染之前就算得出来；
 * 二是源码里的反引号是模型明确写下的「这是个路径」，比事后按文本匹配可靠。
 *
 * **不做模糊匹配**：只认整段相等的完整路径。截一半的、拼在句子里的一律不动——
 * 那正是「拿正则扫散文猜路径」的老毛病，措辞一改就散架。
 */
function mentionedFiles(text, files) {
  const src = String(text == null ? '' : text)
  const set = new Set()
  for (const f of files || []) if (f && f.path && src.includes('`' + f.path + '`')) set.add(f.path)
  return set
}

/**
 * 把正文里那几段路径原地换成可以点开的药丸。
 *
 * 模型写出来的是 `uploads/s-0189cf21-787b-4c33-a4d4-c3daf292da34/Receipt-2095.md`
 * 这样一长串——占掉整行、看不出重点，而且不能点。换成药丸之后，「它生成了什么」
 * 就在说这句话的地方，不用再往下找。
 *
 * **跳过代码块里的**：那里面的路径是给人抄去执行的命令的一部分，换成按钮就抄不走了。
 */
function inlineFileChips(host, files) {
  const byPath = new Map((files || []).filter((f) => f && f.path).map((f) => [f.path, f]))
  if (!byPath.size) return
  for (const code of [...host.querySelectorAll('code')]) {
    if (code.closest('pre')) continue
    const hit = byPath.get(code.textContent.trim())
    if (!hit) continue
    const box = document.createElement('span')
    box.innerHTML = fileChipHtml(hit)
    const chip = box.firstElementChild
    if (!chip) continue
    chip.classList.add('sw-filechip-inline')
    code.replaceWith(chip)
  }
}

/**
 * 当前这条会话的「要在正文里找的文件名」表。每次重绘由 paintChat 重算一次。
 *
 * 挂在模块上而不是一路当参数传：updateRow 是从 syncThread 里逐条调的，为这一样东西
 * 给沿途每个函数加一个形参，只会让下一个人以为它是每条消息各自不同的东西——它不是，
 * 整条会话共用一份。
 */
let chatFileCands = []

/**
 * 代码高亮会把代码块的 innerHTML 整块换掉（见 markdown.js 的 enhanceCode），
 * 里面的文件链接自然一起没了。高亮完再接一次——这是目录树那一屏能点得动的关键：
 * 那一片正好在代码块里。
 *
 * **只管对话里的。** enhance 在预览层也会跑（见 openPreview / setPreviewMode），
 * 而那儿画的是文件自己的内容：往里塞按钮等于改了人正在看的那份文件，点一下还会把
 * 当前预览换成另一个文件。
 */
if (window.satuMd && satuMd.onCodeReady) {
  satuMd.onCodeReady((el) => {
    if (el && el.closest && el.closest('#chat-thread')) linkFiles(el, chatFileCands)
  })
}

/**
 * 这条会话里已经露过面的工作区文件：path → { path, name }。
 *
 * 三个来源，都是**报出来的、不是猜出来的**：人上传的附件、工具落地的产出（files）、
 * 工具看到的那些（refs，见 tools/index.ts）。有了这份名册，正文里出现的文件名才能
 * 接回一个真实存在的路径——没有它就只能拿正则去散文里认路径，措辞一改就散架。
 *
 * **按整条会话攒，不是按消息。** 模型常常上一条列了目录、下一条才说「那份 PDF 里
 * 写着…」，只看本条的话，人最想点的那一次恰好点不了。
 */
function knownFiles(blocks) {
  const map = new Map()
  const add = (f) => {
    if (!f || !f.path || map.has(f.path)) return
    map.set(f.path, { path: f.path, name: f.name || f.path.split('/').pop() || f.path })
  }
  for (const b of blocks || []) {
    for (const f of b.files || []) add(f)
    for (const x of b.tools || []) {
      for (const f of x.files || []) add(f)
      for (const f of x.refs || []) add(f)
    }
  }
  return map
}

/** 带扩展名才算文件名。没有它，一个叫「报告」的文件会把正文里每一个「报告」都点亮。 */
const FILE_EXT_RE = /\.[A-Za-z0-9]{1,8}$/

/**
 * 名册摊成一张「要在正文里找的字串」表，长的排前面。
 *
 * 两种字串：**完整路径**（模型写全的那种）和**文件名**。文件名这一类有两道闸——
 * 必须带扩展名、且在整条会话里不重名。重名的一律不认：`index.ts` 有三个的时候，
 * 猜中的那次不值得赔上另外两次指到错的文件。
 */
function fileCands(known) {
  const byBase = new Map()
  for (const f of known.values()) {
    const base = f.path.split('/').pop() || f.path
    // 撞名的置空而不是删掉——后面再来一个同名的，也得继续认得出它撞过。
    byBase.set(base, byBase.has(base) ? null : f)
  }
  const out = []
  for (const f of known.values()) if (f.path.includes('/')) out.push({ needle: f.path, file: f })
  for (const [base, f] of byBase) if (f && FILE_EXT_RE.test(base)) out.push({ needle: base, file: f })
  return out.sort((a, b) => b.needle.length - a.needle.length)
}

/**
 * 一段文本里出现的那些文件名，落在哪几段区间上。
 *
 * 纯函数，DOM 一点不碰：这条规则最容易出错的地方是边界（`报表.xlsx.bak` 不是
 * `报表.xlsx`、`src/a.ts` 里的 `a.ts` 不该单独再算一次），而那几条拿字符串就能钉死。
 * 长的先认、认过的区间不再让给短的，所以完整路径永远赢过它自己的文件名。
 */
function fileHits(text, cands) {
  const src = String(text == null ? '' : text)
  if (!src || !cands || !cands.length) return []
  const hits = []
  for (const c of cands) {
    let from = 0
    for (;;) {
      const at = src.indexOf(c.needle, from)
      if (at < 0) break
      const end = at + c.needle.length
      from = end
      if (!fileEdgeOk(src, at, end)) continue
      if (hits.some((h) => at < h.end && h.start < end)) continue
      hits.push({ start: at, end, file: c.file })
    }
  }
  return hits.sort((a, b) => a.start - b.start)
}

/**
 * 这一段确实是「一个完整的名字」，不是从更长的东西里截出来的一半。
 *
 * 中日韩的字不算词字符（`\w` 不匹配），所以「已生成印尼山火报告2026-08.html，请查收」
 * 里那个文件名照样接得上——这恰恰是最常见的写法。
 */
function fileEdgeOk(src, start, end) {
  const before = start > 0 ? src[start - 1] : ''
  const after = end < src.length ? src[end] : ''
  if (before && /[\w./\\-]/.test(before)) return false
  if (after && /[\w/\\-]/.test(after)) return false
  // `报表.xlsx.bak` 不是 `报表.xlsx`。
  if (after === '.' && /[A-Za-z0-9]/.test(src[end + 1] || '')) return false
  return true
}

/** 走文本节点时不进去的那些。链接和药丸里面已经是可点的了，再套一层只会打架。 */
const FILE_LINK_SKIP = new Set(['A', 'BUTTON', 'FIGCAPTION', 'SCRIPT', 'STYLE', 'TEXTAREA'])

/**
 * 把正文（含代码块）里出现的文件名原地变成可以点开预览的链接。
 *
 * **和行内药丸的分工**：`` `路径` `` 那种是模型明确写下的一整条路径，换成药丸；
 * 剩下的——目录树那一屏、句子里带出来的一个文件名——只加链接，**不换节点**。
 * 代码块尤其不能换：那一片要能整段抄走，塞个按钮进去就抄不成了。加链接不影响
 * `textContent`，上面那颗「复制」照样复制出原样的文本。
 */
function linkFiles(host, cands) {
  if (!host || !cands || !cands.length) return
  const walk = (node) => {
    for (const kid of [...node.childNodes]) {
      if (kid.nodeType === 3) {
        paintFileLinks(kid, cands)
      } else if (kid.nodeType === 1 && !FILE_LINK_SKIP.has(kid.tagName)) {
        walk(kid)
      }
    }
  }
  walk(host)
}

/** 一个文本节点，切成「原文 + 链接 + 原文」。没命中就一个字都不动。 */
function paintFileLinks(node, cands) {
  const src = node.data || ''
  // 一屏正文里绝大多数文本节点一个文件名都没有，先拿最便宜的那一刀挡掉。
  if (src.length < 3) return
  const hits = fileHits(src, cands)
  if (!hits.length) return
  const frag = document.createDocumentFragment()
  let at = 0
  for (const h of hits) {
    if (h.start > at) frag.appendChild(document.createTextNode(src.slice(at, h.start)))
    frag.appendChild(fileLinkNode(src.slice(h.start, h.end), h.file))
    at = h.end
  }
  if (at < src.length) frag.appendChild(document.createTextNode(src.slice(at)))
  node.parentNode.replaceChild(frag, node)
}

/** 一个文件链接。字面照抄原文——目录树那一屏的对齐全靠它一个字符都不多不少。 */
function fileLinkNode(label, file) {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'sw-filelink'
  el.setAttribute('data-act', 'chat-preview')
  el.setAttribute('data-path', file.path)
  el.setAttribute('data-name', file.name)
  el.title = file.path
  el.textContent = label
  return el
}

/**
 * 这条消息里 Bot 读过的文件。
 *
 * 单独挑出来是因为**读完之后的那句话常常一个文件名都不带**：「已读取《某某报告》，
 * 内容概要如下」——用的是文档标题。正文里接不上，就只能在底下给一颗药丸，否则那份
 * 报告在界面上根本没有入口。`ls`/`grep` 看到的那些不给药丸：一次能列出几十个，
 * 摆出来就是一堵墙，它们在正文里已经是链接了。
 */
function readFiles(tools) {
  const seen = new Map()
  for (const x of tools || []) {
    if (x.name !== 'read') continue
    for (const f of x.refs || []) if (f && f.path && !seen.has(f.path)) seen.set(f.path, f)
  }
  return [...seen.values()]
}

/** 读过的文件最多摆几颗。再多就把这条回答本身挤下去了。 */
const MAX_READ_CHIPS = 6

/** 读过的那种药丸。比产出淡一档——它不是这一轮的成果，只是「它看过这个」。 */
function readChipHtml(f) {
  return (
    `<button type="button" class="sw-chip sw-filechip sw-refchip" data-act="chat-preview" ` +
    `data-path="${esc(f.path)}" data-name="${esc(f.name || f.path)}" title="${esc(f.path)}">` +
    `${ICON_FILE}<span>${esc(f.name || f.path)}</span></button>`
  )
}

/** 没摆下的那几个。和过程截图一样：**不闷声吞掉**。 */
function readMoreHtml(n) {
  return `<span class="sw-chip sw-stepmore">${esc(t('还有 N 个读过的文件', 'N more files read').replace('N', String(n)))}</span>`
}

/**
 * 一条消息底下最多摆几颗**产出**药丸。
 *
 * 比读过的那一档宽一点：产出是这一轮的成果，人来就是找它的。但也得有个数——一条命令
 * 生成二十份分章报告，二十颗药丸能占掉三行，把回答本身挤出屏幕。
 */
const MAX_OUT_CHIPS = 8

/** 没摆下的产出。**不闷声吞掉**——摆八颗然后什么也不说，人会以为一共就这八个。 */
function outMoreHtml(n) {
  return `<span class="sw-chip sw-stepmore">${esc(t('还有 N 个产出文件，在右栏「工作区文件」里', 'N more files produced — see Workspace files in the side pane').replace('N', String(n)))}</span>`
}

/**
 * 一条消息渲染完之后，把里面的文件接上。
 *
 * 两件事一起做，按 Markdown 块逐块来并留个记号：`syncMd` 只重画签名变了的那一块，
 * 所以已经接过的块不必再走一遍——流式那几十帧里，这是整段正文里最费的一段。
 *
 * 记号带上「名册有多大」：工具是边跑边报文件的，先写下的那句话可能在后一颗工具
 * 结果回来之后才认得出文件名。名册一变，记号就对不上，那一块自然会再接一次。
 */
function decorateFiles(md, outs) {
  const cands = chatFileCands
  const stamp = cands.length + '·' + outs.length
  for (const block of md.querySelectorAll('.sw-mdblock')) {
    if (block.getAttribute('data-fl') === stamp) continue
    block.setAttribute('data-fl', stamp)
    inlineFileChips(block, outs)
    linkFiles(block, cands)
  }
}

/** 药丸上那几个字。比卡片上那句话短——药丸要一眼扫过，长了就换行。 */
const APPROVAL_CHIP_LABEL = {
  approved: () => t('已批准', 'approved'),
  denied: () => t('已拒绝', 'denied'),
  timeout: () => t('超时未批', 'timed out'),
  aborted: () => t('已作废', 'voided'),
  expired: () => t('已失效', 'expired'),
}

/** 这条确认现在算哪一态。失效是界面自己判出来的（见 approvalDead），日志里没有。 */
function approvalState(a) {
  return approvalDead(a) ? 'expired' : a.state
}

/**
 * 有结论的确认，收成一颗药丸。
 *
 * **和工具痕迹用同一个类（sw-toolchip）**，为的是复用悬浮窗那一整套——触发、定位、
 * chips 重画之后把浮层接回新节点。多加一个 sw-approvalchip 只是为了让挂 `__tool`
 * 那两个循环分得开彼此，别把下标错位（见 updateRow）。
 *
 * 批准的用普通底色：那是常态，不该每条对话里都跳出来。没批准的走 error 那一档——
 * 它往往正是「它后来为什么没干成」的答案，翻记录时要找得到。
 */
function approvalChipHtml(a, i) {
  const state = approvalState(a)
  const label = (APPROVAL_CHIP_LABEL[state] || APPROVAL_CHIP_LABEL.denied)()
  const tone = state === 'approved' ? 'done' : 'error'
  const mail = a.form && a.form.kind === 'email'
  // 药丸上写**剥壳之后**那把工具的名字：`mcp_github_default_sw_run` 谁也看不出是什么。
  const name = (a.form && a.form.tool) || a.name
  const edited = (a.edited || []).length ? ' · ' + t('已改', 'edited') : ''
  return (
    `<span class="sw-chip sw-toolchip sw-approvalchip" data-state="${tone}" data-i="${i}" tabindex="0">` +
    `${mail ? ICON_MAIL : ICON_SHIELD}<span>${esc(name)} · ${esc(label)}${esc(edited)}</span></span>`
  )
}

/** 挂到药丸上给悬浮窗读的那份。`approval: true` 是分支标记，见 toolPopBody。 */
function approvalPop(a) {
  return {
    approval: true,
    name: (a.form && a.form.tool) || a.name,
    args: a.args,
    form: a.form || null,
    edited: a.edited || null,
    reason: a.reason,
    state: approvalState(a),
  }
}

/**
 * 卡片上改到一半的内容：`callId::key` → 当前值。
 *
 * **必须存在渲染之外。** 气泡会因为别的事重画（同一轮里又来了一条工具结果、另一条
 * 确认冒出来），而重画是 innerHTML 整体换掉——正在写的那段正文会跟着没。这张表在
 * 重画之后把值填回去，人写到哪儿还是哪儿。
 */
const approvalDrafts = new Map()

function draftKey(callId, key) {
  return callId + '::' + key
}

/** 这张卡现在这几格的值：人改过就用改过的，没改过就是模型起草的那份。 */
function approvalValue(a, field) {
  const draft = approvalDrafts.get(draftKey(a.callId, field.key))
  return draft === undefined ? field.value || '' : draft
}

/** 这张卡被人动过没有。动过就不许再点「这次对话都批准」，见下面按钮上的说明。 */
function approvalTouched(a) {
  const fields = (a.form && a.form.fields) || []
  return fields.some((f) => f.editable && approvalValue(a, f) !== (f.value || ''))
}

/**
 * 这封信的正文是不是 HTML。
 *
 * 席位为了让老版本也能把没认出的参数露出来，会把 `is_html` 当成一格只读字段一起
 * 送来；所以不能只看布尔值（到这里通常已经是字符串了）。`html_body` 则是另一批
 * 邮件工具的命名，本身就说明这一格该按 HTML 预览。
 */
function approvalEmailIsHtml(a, fields) {
  const flag = fields.find((f) => {
    const key = String(f.key || '').split('.').pop().toLowerCase()
    return key === 'is_html'
  })
  if (flag) return /^(true|1|yes)$/i.test(String(approvalValue(a, flag)).trim())
  return fields.some((f) => String(f.key || '').split('.').pop().toLowerCase() === 'html_body')
}

/**
 * HTML 邮件只在 sandbox iframe 里预览，不能直接塞进批准页的 DOM。
 *
 * sandbox 禁掉脚本和顶层跳转；CSP 再挡住远程图片、字体和表单提交。尤其是邮件里的
 * 跟踪像素，光用 sandbox 并不会阻止它发请求，所以这里默认只放行内嵌 data/cid 资源。
 */
function emailPreviewDoc(html) {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: cid:; font-src data:; media-src data:; style-src \'unsafe-inline\'; form-action \'none\'; base-uri \'none\'">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>html{color-scheme:light}body{box-sizing:border-box;margin:0;padding:14px;background:#fff;color:#171717;font:14px/1.55 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}</style>' +
    '</head><body>' + String(html || '') + '</body></html>'
  )
}

/** 卡片底下那排按钮。发信那张的第一个按钮说「批准并发送」——它就是要干这件事。 */
function approvalActs(a, okLabel) {
  const touched = approvalTouched(a)
  return (
    `<div class="sw-approval-acts">` +
    `<button type="button" class="btn btn-primary" data-act="chat-approve" data-call="${esc(a.callId)}" data-scope="once">${esc(okLabel)}</button>` +
    /**
     * **「这一轮」，不是「这次对话」。**
     *
     * 一个 Bot 一辈子只有一条会话（席位那边的 ensureSession 有就复用），所以按会话
     * 放行等于给出一张永久通行证——而人点它时想的是「我让它发三封信，别问我三遍」。
     * 范围收在这一轮里，下一句话重新问。按钮上的话要跟真实范围对得上，
     * 否则这颗按钮就是在替人做一个他没同意的决定。
     */
    `<button type="button" class="btn btn-secondary" data-act="chat-approve" data-call="${esc(a.callId)}" data-scope="turn"` +
    (touched
      ? // 改过的这一次不能顺带放行后面几次：后面那些带的是模型自己写的内容，不是人刚改的这份。
        ` disabled title="${esc(t('这一次改过内容，只能批准这一次', 'You edited this one, so it can only be approved once'))}"`
      : ` title="${esc(t('从你刚才那句话到它答完，这把工具不再问；下一句话会重新问。', 'Until this reply finishes, this tool won\'t ask again; your next message starts over.'))}"`) +
    `>${esc(t('这一轮都批准', 'Approve for this turn'))}</button>` +
    `<button type="button" class="btn btn-ghost" data-act="chat-deny" data-call="${esc(a.callId)}" data-scope="once">${esc(t('拒绝', 'Deny'))}</button>` +
    /**
     * 拒绝那一侧也配一颗带范围的，和批准那一对对称。
     *
     * 只有「拒绝」的话，模型下一步换个措辞再调一遍同样的东西，人得一次次点——而每一次
     * 都长得差不多。点这颗，这一轮里同一把工具直接挡掉，理由如实告诉模型「刚拒过」，
     * 让它去换做法，不是换措辞。
     *
     * **单独一颗，不做成「拒绝」的默认行为**：默认就挡的话，「拒绝 → 我跟它说改发给
     * 李总 → 它重发」这条最自然的路会被自己挡死（插话是插进同一轮的）。
     */
    `<button type="button" class="btn btn-ghost" data-act="chat-deny" data-call="${esc(a.callId)}" data-scope="turn"` +
    ` title="${esc(t('这一轮里同一把工具直接挡掉，不再问你；下一句话会重新开始。', 'Blocks this tool for the rest of this reply; your next message starts over.'))}"` +
    `>${esc(t('这一轮别再试', 'Block for this turn'))}</button>` +
    `</div>`
  )
}

/**
 * 发信那张卡。
 *
 * **为什么单独做一张**：通用卡把整份 JSON 摊出来，而人在批一封信的时候要看的是
 * 「发给谁、写了什么」，不是一段带转义符的 JSON。更要紧的是**得能改**——模型起草的
 * 正文十有八九要动一两句，只能「批准/拒绝」的话，人就得拒掉、再去跟它解释一遍，
 * 而它下一稿仍然是它写的。
 *
 * 改动最终落在**真正要执行的那份参数**上（见 policy/approvals.ts 的 decide），
 * 不是这儿改个样子。哪几格能改由席位说了算，这里只负责画和收。
 */
function approvalEmailHtml(a) {
  const fields = (a.form && a.form.fields) || []
  const isHtml = approvalEmailIsHtml(a, fields)
  const rows = fields
    .map((f) => {
      const value = approvalValue(a, f)
      if (!f.editable) {
        // 只读的那几格（收件人、抄送、附件…）**照样摆出来**：藏起来的话，人以为自己
        // 看到了这封信的全部，而实际发出去的可能带着别的东西。
        return value
          ? `<div class="sw-mail-row"><span class="sw-mail-k">${esc(f.label)}</span><span class="sw-mail-v">${esc(value)}</span></div>`
          : ''
      }
      const attrs = `data-edit="${esc(f.key)}" data-call="${esc(a.callId)}"`
      const htmlBody = f.multiline && (isHtml || String(f.key || '').split('.').pop().toLowerCase() === 'html_body')
      if (htmlBody) {
        return (
          `<div class="sw-mail-body sw-mail-html"><span class="sw-mail-k">${esc(f.label)}</span>` +
          `<iframe class="sw-mail-preview" sandbox="" referrerpolicy="no-referrer" loading="lazy"` +
          ` title="${esc(t('HTML 邮件正文预览', 'HTML email body preview'))}" data-mail-preview` +
          ` data-call="${esc(a.callId)}" data-preview-for="${esc(f.key)}" srcdoc="${esc(emailPreviewDoc(value))}"></iframe>` +
          `<details class="sw-mail-source"><summary>${esc(t('查看或编辑 HTML 源码', 'View or edit HTML source'))}</summary>` +
          `<textarea class="input sw-mail-text" rows="8" aria-label="${esc(t('HTML 邮件源码', 'HTML email source'))}" ${attrs}>${esc(value)}</textarea>` +
          `</details></div>`
        )
      }
      return f.multiline
        ? `<div class="sw-mail-body"><span class="sw-mail-k">${esc(f.label)}</span>` +
            `<textarea class="input sw-mail-text" rows="8" ${attrs}>${esc(value)}</textarea></div>`
        : `<div class="sw-mail-row"><span class="sw-mail-k">${esc(f.label)}</span>` +
            `<input class="input sw-mail-input" type="text" value="${esc(value)}" ${attrs}></div>`
    })
    .join('')
  return (
    `<div class="sw-approval sw-approval-mail" data-state="pending" data-call="${esc(a.callId)}">` +
    `<div class="sw-approval-head">${ICON_MAIL}<span>${esc(t('这封邮件要发出去了', 'This email is about to be sent'))}</span></div>` +
    `<div class="sw-approval-why">${esc(isHtml
      ? t('下面按邮件效果预览正文；需要修改时可以展开 HTML 源码，预览会同步更新。', 'The body is previewed as an email. Expand the HTML source to edit it; the preview updates as you type.')
      : t('可以直接改主题和正文，改完发出去的就是你现在看到的这一份。', 'Edit the subject or body if you like — what you see is what gets sent.'))}</div>` +
    `<div class="sw-mail">${rows}</div>` +
    `<div class="sw-approval-tool"><code>${esc((a.form && a.form.tool) || a.name)}</code></div>` +
    approvalActs(a, t('批准并发送', 'Approve and send')) +
    `</div>`
  )
}

/**
 * 一张确认卡。**只画还等着人点的那些**——有结论的收成药丸（approvalChipHtml）。
 *
 * 按席位给的 `form.kind` 分流：认得的走定制样式（发信那张），认不出的走下面这张通用卡。
 * **认不出不是理由把参数藏起来**——通用卡把整份 JSON 摆出来，人照样看得见自己在批什么。
 *
 * **参数要摆出来。** 「Bot 想调用 send_email，批准吗」这句话本身没有信息量——人要批的
 * 是「发给谁、写了什么」，看不到这些就只能凭信任点，那和没有这个开关是一样的。
 */
function approvalHtml(a) {
  if (a.form && a.form.kind === 'email' && (a.form.fields || []).length) return approvalEmailHtml(a)
  const args = prettyArgs(a.args)
  return (
    `<div class="sw-approval" data-state="pending" data-call="${esc(a.callId)}">` +
    `<div class="sw-approval-head">${ICON_SHIELD}<span>${esc(t('需要你确认', 'Needs your approval'))}</span></div>` +
    `<div class="sw-approval-why">${esc(a.reason)}</div>` +
    `<div class="sw-approval-tool"><code>${esc(a.name)}</code></div>` +
    (args ? `<pre class="sw-approval-args">${esc(clip(args))}</pre>` : '') +
    approvalActs(a, t('批准这一次', 'Approve once')) +
    `</div>`
  )
}

/** 一张交接单现在算哪一态，说给人听。 */
function handoffLabel(h) {
  if (h.state === 'claimed') return t('转人工 · 处理中', 'Handoff · in progress')
  if (h.state === 'returned') return t('转人工 · 已交还', 'Handoff · handed back')
  return t('转人工 · 等人接手', 'Handoff · waiting for someone')
}

/**
 * 一张交接卡（见 docs/handoff.md）。
 *
 * **只画还没闭合的那些。** 已经关掉的收成一行灰字（handoffDoneHtml）——一件已经办完
 * 的事再占着半屏输入框，往上翻这一轮对话会被几张作废的卡挡住。
 *
 * 卡上最大的那行字是 `ask`（要人做什么），不是 `reason`（为什么卡住）。接手的人先要
 * 知道自己该干嘛；为什么卡住是接下来才关心的事。
 */
function handoffHtml(h) {
  const acts =
    h.state === 'returned'
      ? `<div class="sw-handoff-note-done">${esc(t('已经交还，Bot 正在接着做。', 'Handed back — the bot is picking it up.'))}</div>`
      : `<textarea class="input sw-handoff-note" data-handoff="${esc(h.id)}" rows="2" ` +
        `placeholder="${esc(t('你做了什么、结论是什么？Bot 要靠它接着做', 'What did you do, and what came of it? The bot continues from this'))}"></textarea>` +
        `<div class="sw-approval-acts">` +
        `<button type="button" class="btn btn-primary" data-act="chat-handoff-return" data-id="${esc(h.id)}" data-disp="done">` +
        `${esc(t('处理完了，交还', 'Done — hand back'))}</button>` +
        (h.state === 'open'
          ? `<button type="button" class="btn btn-secondary" data-act="chat-handoff-claim" data-id="${esc(h.id)}">${esc(t('我来接手', 'I will take it'))}</button>`
          : '') +
        `<button type="button" class="btn btn-ghost" data-act="chat-handoff-return" data-id="${esc(h.id)}" data-disp="instructions">` +
        `${esc(t('换个做法', 'Do it differently'))}</button>` +
        `<button type="button" class="btn btn-ghost" data-act="chat-handoff-cancel" data-id="${esc(h.id)}">${esc(t('不用处理了', 'Never mind'))}</button>` +
        `</div>`
  const who = h.claimedBy && h.claimedBy.name
  return (
    `<div class="sw-approval sw-handoff" data-state="${esc(h.state)}" data-handoff="${esc(h.id)}">` +
    `<div class="sw-approval-head">${ICON_HAND}<span>${esc(handoffLabel(h))}</span></div>` +
    `<div class="sw-handoff-ask">${esc(h.ask || t('接手处理这件事', 'Take this over'))}</div>` +
    (h.reason ? `<div class="sw-approval-why">${esc(h.reason)}</div>` : '') +
    (h.summary ? `<pre class="sw-approval-args">${esc(clip(h.summary))}</pre>` : '') +
    (who ? `<div class="sw-handoff-who">${esc(t('接手人', 'Taken by'))}：${esc(who)}</div>` : '') +
    (h.repeats ? `<div class="sw-handoff-who">${esc(t('它又撞上了同一件事', 'It hit the same wall again'))} × ${h.repeats}</div>` : '') +
    acts +
    `</div>`
  )
}

/** 已经闭合的那几张，收成一行。留着是因为「这件事上次是怎么处理的」要看得见。 */
function handoffDoneHtml(h) {
  const map = {
    closed: () => t('转人工 · 已完成', 'Handoff · done'),
    expired: () => t('转人工 · 没人接手，已关闭', 'Handoff · nobody took it'),
    cancelled: () => t('转人工 · 已撤销', 'Handoff · cancelled'),
  }
  // 席位上已经没有这张单了（重装、换机器、清过库）。**说出来**，别画成「已完成」——
  // 那件事到底办没办，这边并不知道。
  if (handoffDead(h)) {
    return `<div class="sw-handoff-done">${ICON_HAND}<span>${esc(t('转人工 · 席位上已经没有这张单了', 'Handoff · the seat no longer has this ticket'))}</span></div>`
  }
  const label = (map[h.state] || (() => t('转人工', 'Handoff')))()
  const by = h.result && h.result.by && h.result.by.name ? ` · ${h.result.by.name}` : ''
  return `<div class="sw-handoff-done">${ICON_HAND}<span>${esc(label + by)}</span></div>`
}

/** 一条消息的外壳。正文和工具条留空，交给 updateRow 填——它俩每帧都可能变。 */
function rowShell(b, key) {
  const account = (state.me && state.me.account) || {}
  const avatar = b.kind === 'user' ? esc(initialOf(account)) : ICON_BOT
  // 时间戳两侧一致，都挂在气泡外面（见 chat.css 里 .sw-time 的说明）。
  //
  // 内容留空，交给 updateRow：助手那条**还在输出时是读秒**、输出完了才换成时刻，
  // 而 rowShell 只在节点新建时跑一次，盯不住这个变化。
  const time = '<time class="sw-time" hidden></time>'
  return (
    `<div class="sw-msg" data-role="${b.kind}" data-key="${key}"${b.via ? ` data-via="${esc(b.via)}"` : ''}${b.pending ? ' data-pending="1"' : ''}>` +
    `<div class="sw-msg-avatar" aria-hidden="true">${avatar}</div>` +
    `<div class="sw-msg-col">` +
    `<div class="sw-bubble" data-role="${b.kind}"><div class="sw-md"></div><div class="sw-chips" hidden></div></div>` +
    `${time}</div></div>`
  )
}

/**
 * 把 host 的子节点对齐到 text 渲染出的 Markdown 块。
 *
 * 每个子节点记着自己那一块的**源文本**（data-sig）。源文本没变就整块跳过——节点原地
 * 保留，里面已经渲染好的 KaTeX、高亮、mermaid 图跟着一起留下。流式输出下只有最后一块
 * 在变，所以每帧真正重画的就那一块。
 */
function syncMd(host, text, streaming) {
  const md = window.satuMd
  if (!md) {
    host.textContent = String(text || '')
    return
  }
  // healStream 看的是整段正文的末尾，所以要先补齐再切块，不能切完逐块补。
  const src = streaming ? md.healStream(text) : String(text == null ? '' : text)
  const parts = src.trim() ? md.splitBlocks(src) : []
  const kids = host.children
  for (let i = 0; i < parts.length; i++) {
    const cur = kids[i]
    if (cur && cur.getAttribute('data-sig') === parts[i]) continue
    const box = document.createElement('div')
    box.className = 'sw-mdblock'
    box.setAttribute('data-sig', parts[i])
    box.innerHTML = md.render(parts[i])
    if (cur) host.replaceChild(box, cur)
    else host.appendChild(box)
  }
  while (kids.length > parts.length) host.removeChild(kids[kids.length - 1])
}

/**
 * 正文 + 工具条就地更新。streaming 指「这条还在写」，只有最后一条会是 true。
 * `since` 是这一轮开始的时刻（fold 的 statusAt），读秒从它起算。
 */
function updateRow(el, b, streaming, since) {
  /**
   * 头像会不会动。**这一行是「它还在干活」在屏幕上唯一常驻的信号。**
   *
   * 三点省略号只在**还没吐字**的那一段有（一开口就地变成正文），气泡下面的读秒是一行
   * 小灰字。可一轮真正花时间的活（读十几个网页、跑几条命令）恰恰是**已经写了几段字、
   * 后面还在接着跑**的那种——那时候屏幕上除了那个每秒 +1 的数字，没有任何东西在动，
   * 人分不出「它还在跑」和「它答完了就这样」。头像是这条消息的身份，一直在，让它呼吸。
   *
   * 属性变了才写：updateRow 每帧都跑，无条件 setAttribute 会让 CSS 动画从头开始，
   * 呼吸变成一顿一顿的抽搐。
   */
  const working = Boolean(streaming) && b.kind === 'assistant'
  if (working !== (el.getAttribute('data-live') === '1')) {
    if (working) el.setAttribute('data-live', '1')
    else el.removeAttribute('data-live')
  }

  const bubble = el.querySelector('.sw-bubble')
  const md = bubble.querySelector('.sw-md')
  const chips = bubble.querySelector('.sw-chips')

  // 用户发的图：缩略图排在正文上面，点开走预览。没有这一段，人发完图只看得见
  // 自己那句话，图像是发进了黑洞。
  const shots = b.images || []
  let strip = bubble.querySelector('.sw-shots')
  const shotSig = shots.map((x) => x.path).join('|')
  if (shots.length && !strip) {
    strip = document.createElement('div')
    strip.className = 'sw-shots'
    bubble.insertBefore(strip, md)
  }
  if (strip && strip.getAttribute('data-sig') !== shotSig) {
    strip.setAttribute('data-sig', shotSig)
    strip.innerHTML = shots.map(shotHtml).join('')
    strip.hidden = !shots.length
    void fillShots(strip)
  }

  /**
   * 这条消息 `@` 了谁。画在正文**上面**，和输入框里那排是同一种药丸——发出去前后
   * 长得一样，人才认得出这就是刚才点的那个。
   *
   * 和附件缩略图一条路子：签名没变就不重画，否则流式那几帧会把它反复换掉。
   */
  const ments = b.mentions || []
  const mentSig = ments.map((m) => m.label).join('|')
  let mentBox = bubble.querySelector('.sw-mentions-in')
  if (ments.length && !mentBox) {
    mentBox = document.createElement('div')
    mentBox.className = 'sw-mentions-in'
    bubble.insertBefore(mentBox, bubble.firstChild)
  }
  if (mentBox && mentBox.getAttribute('data-sig') !== mentSig) {
    mentBox.setAttribute('data-sig', mentSig)
    mentBox.innerHTML = ments.map((m) => `${mentionPill(m)}</span>`).join('')
    mentBox.hidden = !ments.length
  }

  const tools = b.tools || []
  // 产出文件 + 上传的附件。两边是同一种东西（工作区里一个能点开的文件），
  // 用同一种药丸，点开走同一个预览。
  const outs = outputFiles(tools).concat(b.files || [])
  // 正文里已经点了名的那些，就地换成药丸（见 inlineFileChips），底下那条就不再
  // 重复摆一遍——同一个文件在一条消息里出现两次是噪音，而且下面那颗离它被提到的
  // 那句话隔了好几行。
  const inlined = mentionedFiles(b.text, outs)

  if (!String(b.text || '').trim() && streaming) {
    // 还没吐字。给一个空气泡里的三点——它就地长成正文，位置不跳。
    if (!md.querySelector('.sw-typing')) md.innerHTML = '<span class="sw-typing"><i></i><i></i><i></i></span>'
  } else {
    if (md.querySelector('.sw-typing')) md.innerHTML = ''
    syncMd(md, b.text, streaming)
    decorateFiles(md, outs)
  }

  /**
   * 浏览器一步一张的过程截图，摆在正文底下、药丸上面。
   *
   * 为什么值得占这块地方：一次多步浏览在日志里只剩十几段 a11y 文本，出了问题（点错了、
   * 页面弹了个没见过的东西、登录掉了）翻那些文本几乎看不出所以然，一眼缩略图就够。
   * 点开走的是产出文件同一个预览。
   *
   * 模型看不见这些图（默认那个对话模型没有视觉），所以它们**只在这里有用**——没有这条，
   * 那些图就只是躺在工作区里没人会去翻的东西。
   */
  const allSteps = stepShots(tools)
  const steps = allSteps.slice(0, MAX_STEP_SHOTS)
  const moreSteps = allSteps.length - steps.length
  let stepbox = bubble.querySelector('.sw-steps')
  const stepSig = steps.map((f) => f.path).join('|') + '#' + moreSteps
  if (steps.length && !stepbox) {
    stepbox = document.createElement('div')
    stepbox.className = 'sw-shots sw-steps'
    bubble.insertBefore(stepbox, chips)
  }
  if (stepbox && stepbox.getAttribute('data-sig') !== stepSig) {
    stepbox.setAttribute('data-sig', stepSig)
    stepbox.innerHTML = steps.map(shotHtml).join('') + (moreSteps > 0 ? stepMoreHtml(moreSteps) : '')
    stepbox.hidden = !steps.length
    void fillShots(stepbox)
  }

  /**
   * 确认卡分两拨：**还等着人点的摊开，已经有结论的收成一颗药丸。**
   *
   * 摊开是给「你要批的到底是什么」用的——参数看不见就只能凭信任点，那和没有这个开关
   * 一样。可人点完之后它就只是一条痕迹了，再占着半屏参数，往上翻这一轮的对话会被
   * 几张已经作废的卡片挡住。收起来之后和工具痕迹排在一起，详情走同一个悬浮窗。
   */
  const apps = b.approvals || []
  const waiting = apps.filter((a) => a.state === 'pending' && !approvalDead(a))
  const settled = apps.filter((a) => !waiting.includes(a))

  // 底下只留没被正文点过名的。摆不下的收成一行，不闷声截断（见 outMoreHtml）。
  const rest = outs.filter((f) => !inlined.has(f.path))
  const shownOuts = rest.slice(0, MAX_OUT_CHIPS)
  const moreOuts = rest.length - shownOuts.length
  /**
   * 读过、但正文里一个字也没提到的那些（见 readFiles）。
   *
   * 正文里接得上就不摆——那颗药丸离说这句话的地方隔着好几行，而链接就在句子里。
   * 判据拿的是**正文源码**：DOM 那边要等这一帧画完才知道接上了没有，而药丸和正文
   * 是同一帧决定的。
   */
  const wasRead = readFiles(tools)
  // 扫正文只在真读过东西的时候做。绝大多数消息一次 read 都没有，而这个函数每帧
  // 对每一行都会跑一次。
  const linked = new Set(wasRead.length ? fileHits(b.text, chatFileCands).map((h) => h.file.path) : [])
  const outPaths = new Set(outs.map((f) => f.path))
  const reads = wasRead.filter((f) => !outPaths.has(f.path) && !linked.has(f.path))
  const shownReads = reads.slice(0, MAX_READ_CHIPS)
  const moreReads = reads.length - shownReads.length
  const sig =
    tools.map((x) => x.name + (x.result == null ? '·' : x.failed ? '!' : '=')).join('|') +
    '#' +
    shownOuts.map((f) => f.path).join('|') +
    '+' +
    moreOuts +
    '#' +
    shownReads.map((f) => f.path).join('|') +
    '+' +
    moreReads +
    '#' +
    settled.map((a) => a.callId + ':' + approvalState(a)).join('|')
  if (chips.getAttribute('data-sig') !== sig) {
    chips.setAttribute('data-sig', sig)
    chips.innerHTML =
      tools.map(chipHtml).join('') +
      shownOuts.map(fileChipHtml).join('') +
      (moreOuts > 0 ? outMoreHtml(moreOuts) : '') +
      shownReads.map(readChipHtml).join('') +
      (moreReads > 0 ? readMoreHtml(moreReads) : '') +
      settled.map((a, i) => approvalChipHtml(a, tools.length + i)).join('')
    chips.hidden = !tools.length && !rest.length && !shownReads.length && !settled.length
    /**
     * 工具对象直接挂到节点上，悬浮窗按需取。
     *
     * **选择器要把确认那几颗排除掉**：它们也叫 sw-toolchip（为的是复用悬浮窗那一整套
     * 触发、定位、重接），混进来的话下标就错位了，鼠标停在一颗工具药丸上会弹出另一次
     * 调用的参数。产出文件那几颗是 sw-filechip，本来就不在这个选择器里。
     */
    const nodes = chips.querySelectorAll('.sw-toolchip:not(.sw-approvalchip)')
    for (let i = 0; i < nodes.length; i++) nodes[i].__tool = tools[i]
    // data-i 是「在这个容器的 .sw-toolchip 列表里排第几」，所以确认那几颗接在工具后面
    // 数（见 approvalChipHtml 的调用处）——refreshToolPop 靠它把浮层接回新节点。
    const apNodes = chips.querySelectorAll('.sw-approvalchip')
    for (let i = 0; i < apNodes.length; i++) apNodes[i].__tool = approvalPop(settled[i])
    // 这一批节点刚被换掉。开着的悬浮窗要么跟着换到新节点上，要么关掉——
    // 「调用中 → 完成」正好是人盯着它看的那一刻，不该在那时候闪没。
    refreshToolPop()
  }

  /**
   * 高风险确认卡。摆在工具药丸**底下**——它说的就是那颗还在转的药丸在等什么。
   *
   * 和别处一样按签名跳过重绘：不这么做的话，流式那几帧会把卡片连同上面的按钮一起
   * 换掉，人正要点的那一下就落空了。
   */
  let apbox = bubble.querySelector('.sw-approvals')
  if (waiting.length && !apbox) {
    apbox = document.createElement('div')
    apbox.className = 'sw-approvals'
    bubble.appendChild(apbox)
  }
  if (apbox) {
    const apSig = waiting.map((a) => a.callId).join('|')
    if (apbox.getAttribute('data-sig') !== apSig) {
      apbox.setAttribute('data-sig', apSig)
      apbox.innerHTML = waiting.map(approvalHtml).join('')
      apbox.hidden = !waiting.length
    }
  }

  /**
   * 交接卡。和确认卡同一套写法，但**签名里要带状态**：一张单从"等人接手"变成
   * "处理中"是同一个 id，只按 id 比的话卡片不会重画，人点完接手看不到任何变化。
   *
   * 还没写完的那句话要留住：重画会把 textarea 换掉，而人可能正打到一半（另一个
   * 标签页的一次状态流转就足以触发重画）。所以先把草稿存起来，画完再填回去。
   */
  const hs = b.handoffs || []
  // 席位上已经没有的那些跟终态一样收成一行——**别再摆按钮**，点下去只有一句 409。
  const live = hs.filter((h) => !handoffDead(h) && (h.state === 'open' || h.state === 'claimed' || h.state === 'returned'))
  const done = hs.filter((h) => !live.includes(h))
  let hobox = bubble.querySelector('.sw-handoffs')
  if (hs.length && !hobox) {
    hobox = document.createElement('div')
    hobox.className = 'sw-handoffs'
    bubble.appendChild(hobox)
  }
  if (hobox) {
    const hSig = hs.map((h) => h.id + ':' + h.state + ':' + (h.repeats || 0) + (handoffDead(h) ? ':x' : '')).join('|')
    if (hobox.getAttribute('data-sig') !== hSig) {
      for (const ta of hobox.querySelectorAll('.sw-handoff-note')) {
        const id = ta.getAttribute('data-handoff')
        if (id && ta.value) handoffDrafts.set(id, ta.value)
      }
      hobox.setAttribute('data-sig', hSig)
      hobox.innerHTML = live.map(handoffHtml).join('') + done.map(handoffDoneHtml).join('')
      hobox.hidden = !hs.length
      for (const ta of hobox.querySelectorAll('.sw-handoff-note')) {
        const draft = handoffDrafts.get(ta.getAttribute('data-handoff'))
        if (draft) ta.value = draft
      }
    }
  }
  /**
   * 委派卡。摆在最底下——它是这一轮里最重的一块，而它上面那颗 delegate_task 药丸只说
   * 得出「调用中」。
   *
   * 签名里**必须带状态和步数**：一次委派从 running 到 done 是同一个 id，只按 id 比的话
   * 卡片不会重画，人盯着的那几分钟里它一动不动——而这正是同步委派最难受的那几分钟
   * （见 docs/delegation.md §13）。
   */
  /**
   * **按 callId 分组，一批一张卡。**
   *
   * 同一轮里派两批不是边角情况——§8.6 推荐的就是「撞顶了就原样再派一次」。全丢进一个数组
   * 按 index 排的话，两批会交错成 0,0,1,1,2，每行的位置也不再对得上模型手上那个
   * `[n/总数]` 的编号。
   */
  const groups = []
  for (const task of b.tasks || []) {
    const key = task.callId || task.id
    let g = groups.find((x) => x.key === key)
    if (!g) groups.push((g = { key, rows: [] }))
    g.rows.push(task)
  }
  for (const g of groups) g.rows.sort((x, y) => (x.index || 0) - (y.index || 0))
  const tks = groups.flatMap((g) => g.rows)
  let tkbox = bubble.querySelector('.sw-tasks')
  if (tks.length && !tkbox) {
    tkbox = document.createElement('div')
    tkbox.className = 'sw-tasks'
    bubble.appendChild(tkbox)
  }
  if (tkbox) {
    const tSig = tks
      .map((x) => x.id + ':' + x.state + ':' + (x.steps || 0) + ':' + (state.taskOpen?.[x.id] ? '1' : '0') + ':' + traceSig(x.child))
      .join('|')
    if (tkbox.getAttribute('data-sig') !== tSig) {
      tkbox.setAttribute('data-sig', tSig)
      tkbox.innerHTML = groups.map((g) => taskGroupHtml(g.rows)).join('')
      tkbox.hidden = !tks.length
    }
  }

  /**
   * 「记下了一条方法」那张小卡。摆在委派卡下面——它是这一轮的一个副作用，不是主线。
   *
   * 删掉那颗按钮直接打公司目录那条删除接口（管理员也删得掉私有档，见
   * routes/catalog.ts）。删完把这张卡标成已删，不去重拉整条会话：那条 Skill 已经不在
   * 了，而这一块讲的是「当时发生了什么」。
   */
  const notes = b.skillNotes || []
  let nbox = bubble.querySelector('.sw-skillnotes')
  if (notes.length && !nbox) {
    nbox = document.createElement('div')
    nbox.className = 'sw-skillnotes'
    bubble.appendChild(nbox)
  }
  if (nbox) {
    const nSig = notes.map((x) => x.id + ':' + x.action + ':' + (state.skillNoteGone?.[x.id] ? 'x' : '-')).join('|')
    if (nbox.getAttribute('data-sig') !== nSig) {
      nbox.setAttribute('data-sig', nSig)
      nbox.innerHTML = notes.map(skillNoteHtml).join('')
    }
  }

  /**
   * 「记下了一条事实」那张小卡。**和 Skill 那张共用一套样式**——它们在人眼里是同一
   * 类东西（Bot 自己改了自己），分两套皮只会让人以为它们是两种不同的事件。
   */
  const mems = b.memNotes || []
  let mbox = bubble.querySelector('.sw-memnotes')
  if (mems.length && !mbox) {
    mbox = document.createElement('div')
    mbox.className = 'sw-memnotes sw-skillnotes'
    bubble.appendChild(mbox)
  }
  if (mbox) {
    const mSig = mems.map((x) => x.id + ':' + x.action + ':' + (state.memNoteGone?.[x.id] ? 'x' : '-')).join('|')
    if (mbox.getAttribute('data-sig') !== mSig) {
      mbox.setAttribute('data-sig', mSig)
      mbox.innerHTML = mems.map(memNoteHtml).join('')
    }
  }

  paintRowTime(el, b, streaming, since)
}

const MEM_NOTE_VERB = {
  add: ['记住了', 'remembered'],
  replace: ['改了记下的事', 'updated a memory'],
  remove: ['忘掉了', 'forgot'],
}

/**
 * 卡上摆的是**正文**，不是名字——记忆没有名字，而「它记住了什么」正是人要看的那一句。
 *
 * 删除按钮不做二次确认：一条记错的记忆每一轮都在影响回答，删它要极其容易
 * （docs/memory.md §12 ②）。旁边那句小字说清「最多一分钟后在对话里生效」——不说的话，
 * 人删完立刻再问一句、看见它还记得，得到的结论是「删除没用」（§12 ③）。
 */
function memNoteHtml(note) {
  const gone = state.memNoteGone?.[note.id] || note.action === 'remove'
  const verb = MEM_NOTE_VERB[note.action] || MEM_NOTE_VERB.add
  const count = typeof note.used === 'number' && typeof note.max === 'number' ? ` · ${note.used}/${note.max}` : ''
  return `<div class="sw-skillnote">
    <span class="sw-skillnote-name">${esc(note.text || '')}</span>
    <span class="sw-skillnote-verb">${esc(t(verb[0], verb[1]))}${esc(count)}</span>
    ${
      gone
        ? `<span class="sw-skillnote-verb">${esc(t('已删掉', 'deleted'))}</span>`
        : `<button type="button" class="sw-skillnote-act" data-act="chat-memory-delete" data-id="${esc(note.id)}">${esc(t('删掉', 'delete'))}</button>`
    }
  </div>`
}

const SKILL_NOTE_VERB = { create: ['记下了一条方法', 'noted a method'], update: ['改了自己记的方法', 'updated its own method'], remove: ['删掉了自己记的方法', 'deleted its own method'] }

function skillNoteHtml(note) {
  const gone = state.skillNoteGone?.[note.id] || note.action === 'remove'
  const verb = SKILL_NOTE_VERB[note.action] || SKILL_NOTE_VERB.create
  const count = typeof note.used === 'number' && typeof note.max === 'number' ? ` · ${note.used}/${note.max}` : ''
  return `<div class="sw-skillnote">
    <span class="sw-skillnote-name">${esc(note.name || '')}</span>
    <span class="sw-skillnote-verb">${esc(t(verb[0], verb[1]))}${esc(count)}</span>
    ${
      gone
        ? `<span class="sw-skillnote-verb">${esc(t('已删掉', 'deleted'))}</span>`
        : /**
           * 「看看」只给管得着目录的人（管理员 / owner）。成员点进 /skills 会落在一屏
           * 拉不到数据的页面上——那比没有这颗按钮更糟。
           *
           * 「删掉」人人都有：它走的是「这颗 Bot 的主人删自己那条」那条路
           * （`/runtime/bots/:botId/skills/:id`），不是管理员的目录接口。
           */
          `${catalogBase() ? `<button type="button" class="sw-skillnote-act" data-act="go" data-href="/skills">${esc(t('看看', 'view'))}</button>` : ''}
           <button type="button" class="sw-skillnote-act" data-act="chat-skill-delete" data-id="${esc(note.id)}" data-name="${esc(note.name || '')}">${esc(t('删掉', 'delete'))}</button>`
    }
  </div>`
}

/** 子会话全文取到哪一步了。进签名，否则「加载中 → 有内容」那一下不会重画。 */
function traceSig(child) {
  const tr = state.taskTrace?.[child]
  return !tr ? '-' : tr.loading ? 'l' : tr.error ? 'e' : String((tr.events || []).length)
}

const TASK_STATE_TEXT = {
  running: ['进行中', 'running'],
  done: ['完成', 'done'],
  capped: ['到步数上限', 'step cap'],
  timeout: ['超时', 'timed out'],
  failed: ['失败', 'failed'],
  aborted: ['已停止', 'stopped'],
  lost: ['状态未知', 'unknown'],
}

/** 一批委派画成一张卡，每条一行。 */
function taskGroupHtml(tasks) {
  const head =
    tasks.length > 1
      ? `<div class="sw-task-head">${esc(t(`派出去 ${tasks.length} 件事`, `${tasks.length} delegated tasks`))}</div>`
      : ''
  return `<div class="sw-task-card">${head}${tasks.map(taskRowHtml).join('')}</div>`
}

function taskRowHtml(task) {
  const st = TASK_STATE_TEXT[task.state] || TASK_STATE_TEXT.running
  const open = Boolean(state.taskOpen?.[task.id])
  const m = task.model || {}
  /**
   * 档位后面跟着那句理由。**这是档位可不可审的全部**：光一个 utility，人判不出选得对
   * 不对，只能等它跑砸；配上「格式定死、漏一行一眼能看见」，当场就判得出来。
   *
   * 降过级的要标出来（写了 utility 却没给理由，或者平台没钉 utility）——不标的话，人会
   * 以为那一档是主代理自己选的。
   */
  const tier = m.role
    ? `<span class="sw-task-tier" data-role="${esc(m.role)}">${esc(m.role)}</span>` +
      (m.downgraded ? `<span class="sw-task-down">${esc(t('已降档', 'downgraded'))}</span>` : '') +
      (m.reason ? `<span class="sw-task-why">${esc(m.reason)}</span>` : '')
    : ''
  const meta = [
    task.steps ? t(`${task.steps} 步`, `${task.steps} steps`) : '',
    task.usage && task.usage.cost ? '$' + Number(task.usage.cost).toFixed(4) : '',
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    `<div class="sw-task-row" data-state="${esc(task.state)}">` +
    `<button type="button" class="sw-task-line" data-act="chat-task-toggle" data-id="${esc(task.id)}" data-child="${esc(task.child || '')}">` +
    `<span class="sw-task-dot" data-state="${esc(task.state)}" aria-hidden="true"></span>` +
    `<span class="sw-task-goal">${esc(task.goal || '')}</span>` +
    `<span class="sw-task-state">${esc(t(st[0], st[1]))}</span>` +
    (meta ? `<span class="sw-task-meta">${esc(meta)}</span>` : '') +
    '</button>' +
    `<div class="sw-task-tier-row">${tier}</div>` +
    (open ? taskDetailHtml(task) : '') +
    '</div>'
  )
}

function taskDetailHtml(task) {
  const summary = task.summary
    ? `<div class="sw-task-summary sw-md">${window.satuMd ? window.satuMd.render(task.summary) : esc(task.summary)}</div>`
    : `<p class="sw-task-empty">${esc(t('还没有结论', 'No conclusion yet'))}</p>`
  const files = (task.files || []).length
    ? `<div class="sw-task-files">${task.files.map(fileChipHtml).join('')}</div>`
    : ''
  return `<div class="sw-task-detail">${summary}${files}${taskTraceHtml(task)}</div>`
}

/**
 * 「看过程」。**取的是子会话的全文，而它经主会话授权**——子会话不进控制面的会话索引
 * （它不是「这个人的一条对话」），按 id 直取会换回一个 503（见 gateway 那条 tasks 路由）。
 */
function taskTraceHtml(task) {
  const tr = state.taskTrace?.[task.child]
  if (!tr) {
    return (
      `<button type="button" class="satu-linkbtn sw-task-trace-btn" data-act="chat-task-trace" data-child="${esc(task.child || '')}">` +
      `${esc(t('看过程', 'View the run'))}</button>`
    )
  }
  if (tr.loading) return `<p class="sw-task-empty">${esc(t('正在取…', 'Loading…'))}</p>`
  /**
   * 取失败要**留一条退路**。席位重启那几秒里点一下就会走到这儿，而按钮已经被这行字换掉
   * ——不把它摆回来的话，除了刷新整页没有第二条路。
   */
  if (tr.error) {
    return (
      `<p class="sw-task-empty sw-task-err">${esc(tr.error)}</p>` +
      `<button type="button" class="satu-linkbtn sw-task-trace-btn" data-act="chat-task-trace" data-child="${esc(task.child || '')}">` +
      `${esc(t('重试', 'Retry'))}</button>`
    )
  }
  const rows = (tr.events || []).map(traceLineHtml).filter(Boolean)
  if (!rows.length) return `<p class="sw-task-empty">${esc(t('没有留下过程', 'Nothing recorded'))}</p>`
  return `<div class="sw-task-trace">${rows.join('')}</div>`
}

/** 过程里的一行。**只画三种**：它说的话、它调的工具、工具回了什么（截断）。 */
function traceLineHtml(ev) {
  const d = ev.data || {}
  if (ev.type === 'assistant/message') {
    const text = messageText(d.message)
    return text ? `<div class="sw-trace-say">${esc(text)}</div>` : ''
  }
  if (ev.type === 'tool/call') {
    return `<div class="sw-trace-tool"><b>${esc(d.name || '')}</b> <span>${esc(String(d.arguments || '').slice(0, 160))}</span></div>`
  }
  if (ev.type === 'tool/result') {
    const text = String(d.text || '').slice(0, 240)
    return `<div class="sw-trace-out"${d.failed ? ' data-failed="1"' : ''}>${esc(text)}</div>`
  }
  return ''
}

/**
 * 取一次子会话全文。存进 state 之后由 render 自己画。
 *
 * 只取一次：过程是**已经结束**的东西（委派是同步的，卡片摊开时那一条早收口了），
 * 没有「刷新一下看看新的」这回事。
 */
async function loadTaskTrace(child) {
  if (!child) return
  const sessionId = state.chatSessionId
  if (!sessionId) return
  state.taskTrace = state.taskTrace || {}
  // 取过一次就不再取——过程是**已经结束**的东西。但失败那次不算「取过」，见上面那颗重试。
  const had = state.taskTrace[child]
  if (had && !had.error) return
  state.taskTrace[child] = { loading: true, events: [], error: '' }
  render()
  try {
    const data = await api(
      'GET',
      `/runtime/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(child)}/history?turns=50`,
    )
    state.taskTrace[child] = { loading: false, events: data.events || [], error: '' }
  } catch (e) {
    state.taskTrace[child] = { loading: false, events: [], error: e.message || String(e) }
  }
  render()
}

/**
 * 气泡下面那一行时间。
 *
 * 还在输出时显示**读秒**，输出完了显示**收口的时刻**。
 *
 * 以前两种情况都显示「开始的时刻」，于是一轮跑了三分钟的对话，下面写着的是三分钟前
 * 那个数字，而且从头到尾一动不动——既看不出它在跑，也看不出它跑了多久。而人在等的
 * 时候最想知道的恰恰是「已经等了多久」。
 *
 * 只有助手那条读秒：status 是 'sending' 时（消息刚发出去、还没有回执）最后一条是
 * 用户自己那句，给它挂个秒表没有意义。
 */
function paintRowTime(el, b, streaming, since) {
  const node = el.querySelector('.sw-time')
  if (!node) return
  /**
   * 起点是**这一轮开始的时刻**，不是这一块自己的时间。
   *
   * 两者常常差着十几秒（模型先想、先调工具，第一个字很晚才落地），而按后者算，秒表
   * 会在第一个字冒出来的那一刻从头数起——上一秒还是「正在想」下面什么都没有，下一秒
   * 蹦出个「0s」。读秒回答的是「我等了多久」，那个问题只有一个起点。
   *
   * 拿不到起点（老会话、截断的历史）才退回这一块自己的时间。
   */
  const start = Number(since) || b.time
  const running = Boolean(streaming) && b.kind === 'assistant' && Boolean(start)
  if (running) {
    node.hidden = false
    node.setAttribute('data-running', '1')
    node.setAttribute('data-since', String(start))
    node.removeAttribute('datetime')
    node.textContent = elapsedText(Date.now() - start)
    return
  }
  // endTime 是这一块最后一条事件的时间（turn/end 最准）。老会话没有它——那时候
  // 事件里也拿不出更好的答案，回落到开始时刻，和以前一个样，不会更差。
  const at = b.endTime || b.time
  node.removeAttribute('data-running')
  node.removeAttribute('data-since')
  if (!at) {
    node.hidden = true
    node.textContent = ''
    return
  }
  node.hidden = false
  node.setAttribute('datetime', new Date(at).toISOString())
  node.textContent = chatClock(at)
}

/** 读秒的文本。一分钟以内就是秒，超过了给 m:ss——纯秒数到了几百就读不出来了。 */
function elapsedText(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000))
  if (s < 60) return s + 's'
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
}

/**
 * 读秒的心跳。
 *
 * 只在**屏幕上真有**一个读秒中的时间戳时才转，转完自己停——挂一个长明的
 * setInterval 在这种页面上是白烧电，标签页在后台时尤其。
 */
let clockTimer = null
function tickClocks() {
  const nodes = document.querySelectorAll('.sw-time[data-running]')
  if (!nodes.length) {
    clearInterval(clockTimer)
    clockTimer = null
    return
  }
  for (const n of nodes) {
    const since = Number(n.getAttribute('data-since')) || 0
    if (since) n.textContent = elapsedText(Date.now() - since)
  }
}

function ensureClockTick() {
  const has = document.querySelector('.sw-time[data-running]')
  if (has && !clockTimer) clockTimer = setInterval(tickClocks, 1000)
  else if (!has && clockTimer) {
    clearInterval(clockTimer)
    clockTimer = null
  }
}

/**
 * 要画哪些行。日期分隔是**算出来的**，不是数据里的——相邻两条不在同一天就插一条。
 */
/**
 * 往前翻一页。
 *
 * 插在**开头**，所以要做两件事，缺一件人就会失去位置感：
 *   · 节点按 key 认（见 syncThread），插进来的只是开头那几条，别的原地不动；
 *   · 补回滚动位置——内容在上面长高了多少，scrollTop 就往下推多少，视线才不会跳。
 */
async function loadOlderChat(sessionId) {
  const page = chatPages.get(sessionId)
  if (!page || !page.hasMore || page.loading || !page.firstSeq) return
  chatPages.set(sessionId, { ...page, loading: true })
  paintLoadMore()
  try {
    const data = await api(
      'GET',
      `/runtime/sessions/${encodeURIComponent(sessionId)}/history?turns=${CHAT_TAIL_TURNS}&before=${page.firstSeq}`,
    )
    const owner = botIdOfSession(sessionId)
    const list = owner ? botStreamOf(owner).events : state.chatEvents
    // 和 hydrateChat 一个判据：只收比手上最靠前那条还早的。正常情况下 before=firstSeq
    // 已经保证了这一点，这里挡的是两条路撞在一起的那几次（补历史和翻页同时在跑）。
    const head = list.length ? Number(list[0].seq) : Infinity
    const older = ((data && data.events) || []).filter((ev) => Number(ev.seq) < head)
    if (older.length) {
      const thread = document.getElementById('chat-thread')
      chatAnchorHeight = thread ? thread.scrollHeight : 0
      list.unshift(...older)
    }
    // 走 noteChatPage 而不是直接 set：这一页也可能比手上知道的窄——等这一跳的工夫
    // hydrateChat 落了地，它那二十轮盖过了这里的一页，游标就不该再退回来。
    // loading 归零由这里说了算，翻页这件事从头到尾只有它一个人管。
    noteChatPage(sessionId, { firstSeq: data && data.firstSeq, hasMore: data && data.hasMore, loading: false })
  } catch (err) {
    // 翻不动就把「加载更多」放回去，别把这一段历史永久锁死。**读最新的那份**：
    // page 是发请求之前的快照，照它写回去会把这期间 hydrateChat 记下的游标抹掉。
    noteChatPage(sessionId, { loading: false })
    state.runtimeError = errText(err.message) || err.message
  }
  paintChat()
}

/** 上一次往前插之前，正文有多高。插完拿它补回滚动位置。0 表示这一帧没插东西。 */
let chatAnchorHeight = 0

function loadMoreRow(sessionId) {
  const page = chatPages.get(sessionId)
  if (!page || !page.hasMore) return null
  const label = page.loading ? t('加载中…') : t('加载更早的对话')
  return {
    kind: 'more',
    // key 带上状态：loading 一变就是新节点，省得再为一行字做一套「就地更新」。
    key: page.loading ? 'more-loading' : 'more',
    html: `<div class="sw-more" style="display: flex; justify-content: center; padding: var(--space-3) 0;"><button type="button" class="satu-linkbtn" data-act="chat-older" ${page.loading ? 'disabled' : ''}>${esc(label)}</button></div>`,
  }
}

let loadMorePaintQueued = false

/** 只重画顶部那一行，不动正文。 */
function scheduleLoadMorePaint() {
  if (loadMorePaintQueued) return
  loadMorePaintQueued = true
  const run = () => {
    loadMorePaintQueued = false
    paintLoadMore()
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
  else setTimeout(run, 16)
}

function paintLoadMore() {
  if (document.getElementById('chat-thread')) paintChat()
}

/**
 * 上下文边界那条线。
 *
 * **必须说清楚记录还在。** 「已清空」会让人以为历史没了，而 JSONL 一条没删——往上翻
 * 看得见，导出带得走，模型自己也还能用 history_read 调回来。清掉的只是「下一轮请求里
 * 带什么」（见 docs/context-assembly.md）。
 *
 * 自动压缩和手动压缩画同一条线，只是措辞不同：一个是「它自己压的」，一个是人点的。
 */
function ctxDivText(b) {
  const head =
    b.mark === 'reset'
      ? t('新对话从这里开始')
      : b.by === 'user'
        ? t('已压缩上下文')
        : t('上下文快满了，自动压缩了一次')
  const parts = [head]
  // 数字只在压缩那条线上有意义。0 → 老日志缺字段，那就不摆一个假的。
  if (b.mark === 'compact' && b.tokensBefore && b.tokensAfter) {
    parts.push(ctxNum(b.tokensBefore) + ' → ' + ctxNum(b.tokensAfter))
  }
  parts.push(b.mark === 'reset' ? t('上面的内容不再进上下文') : t('更早的对话仍在记录里'))
  return parts.join(' · ')
}

function ctxDivHtml(b) {
  return (
    `<div class="sw-ctxdiv" data-mark="${esc(b.mark)}">` +
    `<span class="sw-ctxdiv-text">${esc(ctxDivText(b))}</span></div>`
  )
}

function threadRows(folded, sessionId) {
  const blocks = folded.blocks || []
  const rows = []
  const more = sessionId ? loadMoreRow(sessionId) : null
  if (more) rows.push(more)
  let lastDay = ''
  blocks.forEach((b, i) => {
    const day = chatDayKey(b.time)
    if (day && day !== lastDay) {
      lastDay = day
      rows.push({ kind: 'day', key: 'd' + day, html: `<div class="sw-daydiv"><span>${esc(chatDayLabel(b.time) + ' ' + chatClock(b.time))}</span></div>` })
    }
    // 上下文边界走「html 行」那条路（和日期分隔线、加载更多同一条）：它没有气泡、
    // 没有头像、没有工具条，套 rowShell 只会画出一个空壳。
    if (b.kind === 'mark') {
      rows.push({ kind: 'mark', key: 'k' + b.seq, html: ctxDivHtml(b) })
      return
    }
    // key 必须**跟着这一块自己**走，不能用下标：往前翻加载旧消息会让所有下标移位，
    // 于是整棵 DOM 重建——Markdown 全部重渲染，滚动位置也跟着没了。
    rows.push({ kind: 'msg', key: 'm' + (b.seq != null ? b.seq : 'i' + i), block: b })
  })
  // 轮次开着但助手那条还没建出来（工具先跑、或者刚发出去）——补一条空的，
  // 让「正在想」有地方待着，而不是让输入框上面挂一行状态文字。
  //
  // **key 用常量，不能用 `'m' + blocks.length`。** 真实消息的 key 是 `'m' + seq`，seq 是
  // 会话日志的**行号**（turn/tool/分片都占行），跟**块数**是两套数——只要会话里恰好有
  // 一块 seq 等于当前块数，这条占位就和那条早期消息顶了同一个 key：下一帧 syncThread
  // 按 key 认节点时会把底下的占位节点搬到那条消息的位置（正文换成它的、外壳还是助手的
  // 头像和左对齐），被顶掉的原节点则一路被挤到最下面，看着就是「前面那句话跳到后面了」。
  /**
   * 还在跑、而最后一块不是助手正文：补一条空的「正在回答」占位。
   *
   * `last.kind === 'user'` 之外还要认 `mark`——自动压缩完全可能落在一轮的中间（见
   * fold 里那段长注释），那时候末尾那块是压缩分隔线。只认 user 的话，这一轮既拿不到
   * 占位、下面 syncThread 又只把**最后一行**标成 streaming（那行是分隔线），于是助手
   * 那条的秒表停了、光标没了、`healStream` 也不再补收口——半截围栏直接以原文露出来，
   * 屏幕上看着像已经答完，而这一轮其实还在跑。
   */
  const last = blocks[blocks.length - 1]
  if (folded.status && (!last || last.kind === 'user' || last.kind === 'mark')) {
    /**
     * **`time` 要给这一轮的起点，不能留 0。**
     *
     * 留 0 的话 paintRowTime 判不出「在跑」，那一行时间被整个隐掉——于是模型开口之前
     * 的那段（想、调工具、日常任务里动辄十几秒）屏幕上一个秒表都没有，等第一个字落地
     * 才凭空冒出来一个「0s」。人看到的就是这一行忽有忽无、还从头数起。
     */
    rows.push({ kind: 'msg', key: 'm-live', block: { kind: 'assistant', text: '', tools: [], via: last?.via || '', time: folded.statusAt || 0 } })
  }
  return rows
}

/**
 * 本地回显。**发出去的那一刻就画上，不等流把它送回来。**
 *
 * 消息流是单向的：POST 出去，等席位那边把 `user/message` 事件经 SSE 回传，界面才画。
 * Bot 一忙，这中间就是几秒到几十秒的**纯空白**——输入框清空了，屏幕上什么都没多，人
 * 完全看不出自己那一下有没有生效，只好再按一次。
 *
 * 回执一到就撤掉本地这条，换成流里的真货（它带 seq 和服务端时间）。
 *
 * **只认「发出去之后」的那些**：拿 afterSeq 卡住。不卡的话，历史里任何一条同样文字的
 * 消息都会把它抵消掉——发第二遍「好的」时，本地这条会在流还没回来时就凭空消失。
 */
function mergePending(folded, sessionId) {
  const all = state.chatPending || []
  const mine = all.filter((p) => p.sessionId === sessionId)
  if (!mine.length) return folded
  const fresh = folded.blocks.filter((b) => b.kind === 'user' && b.seq != null)
  const left = []
  for (const p of mine) {
    // 比的是 raw（拼好的完整正文），不是显示用的 text——后者已经把附件那段拆走了。
    const hit = fresh.findIndex((b) => b.seq > p.afterSeq && (b.raw != null ? b.raw : b.text) === p.text)
    if (hit >= 0) fresh.splice(hit, 1)
    else left.push(p)
  }
  if (left.length !== mine.length) {
    state.chatPending = all.filter((p) => p.sessionId !== sessionId || left.includes(p))
  }
  if (!left.length) return folded
  for (const p of left) {
    // 回执还没回来的那几秒也要长成最终的样子，否则附件会先以一行路径文本出现、
    // 再突然变成药丸——同一条消息在屏幕上跳两次。
    const up = splitUploads(p.text)
    folded.blocks.push({
      kind: 'user',
      text: up.text,
      files: up.files,
      raw: p.text,
      images: p.images || [],
      mentions: p.mentions || [],
      via: folded.channelVia ? 'web' : '',
      time: p.at,
      pending: true,
    })
  }
  // 没回执之前也要有「正在想」：那一行是人按下回车之后唯一的进度反馈。
  if (!folded.status) {
    folded.status = 'sending'
    // 秒表从**按下发送**那一刻起算：回执还没回来的这几秒同样是在等（见 fold 的 statusAt）。
    folded.statusAt = left.reduce((min, p) => (p.at && (!min || p.at < min) ? p.at : min), 0)
  }
  return folded
}

function syncThread(thread, folded, sessionId) {
  const rows = threadRows(folded, sessionId)
  // 空会话就留空。以前这里摆一句「继续这段对话…」——它只在**刚开一条新对话**时出现
  // 一瞬间，而输入框的 placeholder 已经说了该干什么。多一句灰字只是让空屏更吵。
  if (!rows.length) {
    if (thread.getAttribute('data-empty') !== '1') {
      thread.setAttribute('data-empty', '1')
      thread.innerHTML = ''
    }
    return
  }
  if (thread.getAttribute('data-empty') === '1') {
    thread.removeAttribute('data-empty')
    thread.innerHTML = ''
  }
  // **按 key 认节点，不按位置。** 位置对齐在「只往后追加」的年代够用，但往前翻会在
  // 开头插一批，之后每个位置都对不上，于是每个节点都被替换掉——看着是「重绘了一下」，
  // 实际是整段 Markdown 重渲染 + 滚动位置丢失。
  //
  // 重名的一律就地删掉，只认先来的那个。key 本该唯一，但一旦哪里算重了（历史上就是
  // 「正在想」那条占位撞上了某条真实消息的 seq），后来的会在 map 里盖掉先来的：认回
  // 来的是错的那个节点，被盖掉的那个既不参与排序也进不了下面的 stale 清理，于是留在
  // 正文里一路往下漂。宁可多建一个节点，也不能让一个野节点留在 DOM 里。
  const byKey = new Map()
  for (const kid of [...thread.children]) {
    const k = kid.getAttribute('data-key')
    if (!k) continue
    if (byKey.has(k)) thread.removeChild(kid)
    else byKey.set(k, kid)
  }
  let prev = null
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    let node = byKey.get(row.key)
    if (node) byKey.delete(row.key)
    else {
      const box = document.createElement('div')
      box.innerHTML = row.html ? row.html : rowShell(row.block, row.key)
      node = box.firstElementChild
      if (row.html) node.setAttribute('data-key', row.key)
    }
    const want = prev ? prev.nextSibling : thread.firstChild
    if (node !== want) thread.insertBefore(node, want)
    if (row.kind === 'msg') updateRow(node, row.block, folded.status ? i === rows.length - 1 : false, folded.statusAt)
    prev = node
  }
  for (const stale of byKey.values()) {
    if (stale.parentNode === thread) thread.removeChild(stale)
  }
}

/**
 * 贴底。
 *
 * 以前是每帧无条件 `scrollTop = scrollHeight`：往上翻历史时，回答每吐一个字就把人拽
 * 回底部，根本读不了前面。改成「本来就在底部附近才跟着走」，翻上去了就停住，另外给一
 * 个「回到底部」的按钮把路留回来。
 */
const STICK_SLACK = 80

function nearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_SLACK
}

function paintChat() {
  const thread = document.getElementById('chat-thread')
  /**
   * 「这一轮在不在跑」。席位表过态就听它的；**没表态而正在重放，一律按「没在跑」**。
   *
   * 重放是把历史从头灌一遍，而扫描对半截历史毫无抵抗力：灌到某轮的 `turn/start` 就是
   * 「正在处理」，要等配对的 `turn/end` 也灌出来才落下。拿真实数据量过，789 帧里有
   * 772 帧挂着「正在处理」，那期间什么都没在跑。这正是重放期间原来干脆一帧都不画的
   * 理由——可那个办法是拿「几秒钟一片空白」去换「不闪错状态」，而空白更难受。
   *
   * 摁在这里，两样就都拿到了：消息随着重放长出来，状态一眼假话都不说。`replay/done`
   * 一到，chatLive 里就是权威答案了（见流里那一支），这条兜底自然让位。
   */
  const live = chatLive.has(state.chatSessionId)
    ? chatLive.get(state.chatSessionId)
    : state.chatReplaying
      ? false
      : undefined
  const folded = mergePending(fold(state.chatEvents, live, currentBotHasChannelLabels()), state.chatSessionId)
  state.chatStatus = folded.status
  if (!thread) return
  // 正文里的文件名要接回哪几个文件，整条会话算一次（见 chatFileCands）。
  chatFileCands = fileCands(knownFiles(folded.blocks))
  // 右栏那一屏也在这儿补一次。**render() 里那一句不够**：席位接上之后走的是
  // hydrateChat / 流的帧，它们只 paintChat，不整页重绘——只挂在 render 上的话，那一屏
  // 要等到下一次真的重绘（人点了点什么）才去取。
  ensureWorkspaceTree()

  const stick = thread.getAttribute('data-touched') !== '1' || nearBottom(thread)
  syncThread(thread, folded, state.chatSessionId)
  if (window.satuMd) satuMd.enhance(thread)
  if (chatAnchorHeight) {
    // 刚往开头插了一批：内容在上面长高了多少，就把 scrollTop 往下推多少。不补的话
    // 视线会直接被甩到几十条之前，人根本认不出自己刚才在看哪儿。
    const grew = thread.scrollHeight - chatAnchorHeight
    chatAnchorHeight = 0
    if (grew > 0) thread.scrollTop += grew
  } else if (stick) thread.scrollTop = thread.scrollHeight
  paintChatChrome(folded)
  ensureClockTick()
}

/**
 * 抬头那盏灯此刻该说什么：`{ state, text }`。
 *
 * **机器够不着的时候，它先于一切说话——连「正在处理」都压过去。** 那一轮的 status 是
 * 断线之前留在手上的：机器没了，`turn/end` 永远不会来，于是屏幕上一直挂着「正在处理」，
 * 看着像它还在替你干活，而那台机器上此刻可能一个进程都没在跑。宁可说「失联」——它至少
 * 指对了要去看的地方。
 *
 * 判断抽出来单放，是因为写进 DOM 那一步没法断言（垫片里没有 lastElementChild 可写），
 * 而「机器失联时这盏灯说了什么」正是这次要钉住的那句话。
 */
function liveLamp(busy) {
  const bot = chatBotOf()
  const link = seatLink()
  // 本地 Bot 没有远程桌面（state.desktopRuntime），它是否在线由壳子的 status 盖到
  // runtime.status + machineLink。拿远程桌面判断它，会出现一边正常对话、一边写着
  // 「离线」的自相矛盾状态。
  if (bot && bot.runtimeKind === 'local') {
    const ready = bot.runtime && bot.runtime.status === 'ready' && link === 'online'
    if (!ready) return { state: '0', text: t('本机未运行', 'Not running locally') }
    if (busy) return { state: 'busy', text: t('正在处理') }
    return { state: '1', text: t('本机运行中', 'Running locally') }
  }
  if (linkDown(link)) return { state: link, text: (LINK_TEXT[link] || LINK_TEXT.unknown)() }
  if (busy) return { state: 'busy', text: t('正在处理') }
  const ready = state.desktopRuntime && state.desktopRuntime.status === 'ready'
  return ready ? { state: '1', text: t('在线') } : { state: '0', text: t('离线') }
}

/* ── 「正在停止」这一段 ────────────────────────────────────────────────
   点下停止到这一轮真的停下来，中间隔着一整条链路：界面 → Gateway → 席位 →
   bot 的 `agent.abort()` → 手上那一步收尾 → `turn/end` 回到流上。快则几百毫秒，
   撞上一个正跑着的工具（十分钟上限）就是几秒到十几秒，而这期间流上一个事件都不会
   来。以前这一段界面上一点动静都没有：按钮还是那颗「停止」，那行小字还写着「正在
   思考」——点了和没点长得一模一样，于是人只能反复点。 */

/** 这条会话停了多久了（毫秒）；没在停就是 null。 */
function stopElapsed() {
  if (!state.chatStopping || state.chatStopping !== state.chatSessionId) return null
  return Math.max(0, Date.now() - (state.chatStoppingAt || 0))
}

function clearStopping() {
  state.chatStopping = ''
  state.chatStoppingAt = 0
  ensureStopTick()
}

/**
 * 停到第几秒该说什么。
 *
 * 前几秒只说「已经下发了」——绝大多数时候它就在这几秒里停下来了，多余的解释是噪音。
 * 过了这道坎还没停，八成是卡在一个正跑着的工具上（中止信号递到了，但 bash 得自己
 * 收尾）。那时候改口把原因说出来，比让人对着一句不动的「正在停止…」猜要好。
 */
const STOP_SLOW_MS = 6000

function stopTipText(ms) {
  const clock = ' · ' + elapsedText(ms)
  return ms < STOP_SLOW_MS
    ? t('正在停止…已经下发给 Bot，它收到才停得下来', 'Stopping… the request is on its way to the bot') + clock
    : t('还在停…正在跑的那一步要等它自己收尾', 'Still stopping… the running step has to wind down first') + clock
}

/**
 * 输入框底下那一行此刻该说什么。
 *
 * 抽出来单放，和上面的 liveLamp 同一个理由：写进 DOM 那一步在垫片里断言不了，而
 * 「按下停止之后这行小字说了什么」正是这次要钉住的那句话。
 */
function composerTip(busy) {
  const stopping = stopElapsed()
  // 停止排在最前：它是人刚做的那个动作，压过「正在思考」——那句这会儿是错的，
  // 它已经在停了。
  if (stopping !== null) return stopTipText(stopping)
  // `/compact` 要跑一次模型写摘要，几秒。这几秒里没有任何事件会经 SSE 过来——
  // 不说一句的话，人只看到输入框被清空了，然后什么都没发生。
  if (state.chatCmdBusy) return state.chatCmdBusy === 'compact' ? t('正在压缩上下文…') : t('正在处理…')
  // 会话还没拿到（席位刚起来那几十秒）就直说。这一行是人在按发送之前唯一会看的地
  // 方，而那期间按下去是发不出去的——不说的话就是「点了没反应」。
  if (!state.chatSessionId) {
    return sessionGaveUp ? t('实例还没接上，这会儿发不出去') : t('实例还在上线，接上之后就能发消息…')
  }
  return busy ? t('正在思考…（可以继续输入来打断）') : t('Enter 发送，Shift + Enter 换行')
}

function paintChatTip(busy) {
  const tip = document.getElementById('chat-tip')
  if (!tip) return
  tip.textContent = composerTip(busy)
  // 停止那一句要从灰字里抬出来一档，见 chat.css。别的时候这一行是背景信息，不该抢眼。
  if (stopElapsed() !== null) tip.setAttribute('data-hint', 'stopping')
  else tip.removeAttribute('data-hint')
  ensureStopTick()
}

/**
 * 停止期间的读秒心跳。
 *
 * 和 ensureClockTick 一样只在真有东西要走时才转：这一段里流上没有事件，没有这只
 * 表的话那行字会僵在「· 0s」上——一个不动的读秒比没有读秒更像卡死了。
 */
let stopTimer = null
function ensureStopTick() {
  const on = stopElapsed() !== null
  if (on && !stopTimer) stopTimer = setInterval(tickStop, 1000)
  else if (!on && stopTimer) {
    clearInterval(stopTimer)
    stopTimer = null
  }
}

function tickStop() {
  const tip = document.getElementById('chat-tip')
  // 停完了、或者人已经走开这一页了（走开时不会再有 paint 来收表），自己停掉。
  if (stopElapsed() === null || !tip) {
    clearInterval(stopTimer)
    stopTimer = null
    return
  }
  // status 用 state 上那一份：paintChat 每帧刚算过，这只表不该为了读一个秒数
  // 再 fold 一遍整条会话。
  tip.textContent = composerTip(Boolean(state.chatStatus))
}

/** 抬头的在线灯、输入区的提示和中止按钮——都不重绘整页，就地改。 */
function paintChatChrome(folded) {
  const busy = Boolean(folded.status)
  // 真停下来了（turn/end 到了，status 空了）就把「正在停止」那一格收掉。**只认这一
  // 条会话**：切到别的 Bot 时那边本来就不忙，不该顺手把这边还没停完的状态抹掉。
  if (!busy && state.chatStopping && state.chatStopping === state.chatSessionId) clearStopping()
  const stopping = stopElapsed() !== null
  const live = document.getElementById('chat-live')
  if (live) {
    const lamp = liveLamp(busy)
    live.setAttribute('data-live', lamp.state)
    live.lastElementChild.textContent = lamp.text
  }
  const meta = document.getElementById('chat-meta')
  if (meta) meta.textContent = chatMetaText(folded)
  paintChatTodos(folded)
  paintChatTip(busy)
  const send = document.getElementById('chat-send')
  // 三副面孔：发送 / 停止 / 正在停止。前两副是同一颗按钮的开与关，第三副是「这一下
  // 已经收到了，正在下发」——它必须和「停止」长得不一样，不然人只能靠反复点来确认。
  const face = stopping ? 'stopping' : busy ? 'stop' : 'send'
  if (send && send.getAttribute('data-state') !== face) {
    // 停止态改成 type=button 并挂上 chat-abort：留着 submit 的话，点它会走发送。
    // 回车不受影响——那条路径仍是提交表单，也就是「边跑边补一句」，本来就该照发。
    send.setAttribute('data-state', face)
    send.type = busy ? 'button' : 'submit'
    send.innerHTML = busy ? ICON_STOP : ICON_SEND
    const label = stopping ? t('正在停止…', 'Stopping…') : busy ? t('停止') : t('发送')
    send.setAttribute('aria-label', label)
    send.title = label
    // 正在停的时候禁掉：第二下什么也做不成（席位已经收到了），但按得下去就会让人
    // 以为第一下没算数。转圈画在按钮外沿，见 chat.css 的 [data-state='stopping']。
    send.disabled = stopping
    if (busy) send.setAttribute('data-act', 'chat-abort')
    else send.removeAttribute('data-act')
  }
  // 名单上的时间/摘要/转圈由 paintRoster 管——它认每个 Bot 自己那条流，
  // 不再只看当前这一条。
  paintRoster()
  const jump = document.getElementById('chat-jump')
  const thread = document.getElementById('chat-thread')
  if (jump && thread) jump.hidden = nearBottom(thread)
  paintChatCtx()
}

function chatMetaText(folded) {
  // 分割线不算「一条消息」——它不是谁说的话。不滤的话，压过几次的会话条数会虚高。
  const blocks = ((folded && folded.blocks) || []).filter((b) => b.kind !== 'mark')
  const account = (state.me && state.me.account) || {}
  const who = account.name || account.email || ''
  const first = blocks.find((b) => b.time)
  const parts = []
  if (who) parts.push(t('发起人') + ' ' + who)
  parts.push(blocks.length + ' ' + t('条消息'))
  if (first) parts.push(t('开始于') + ' ' + chatDayLabel(first.time) + ' ' + chatClock(first.time))
  return parts.join(' · ')
}

/* ── 上下文占了多少 ────────────────────────────────────────────────────
   长会话唯一真正会撞上的墙是上下文窗口，而撞上之前界面上一点征兆都没有：答着答着
   开始忘事，谁也不知道为什么。所以把「用了多少 / 一共多少」摆在输入框底下那一行，
   点开再看它被什么占着。

   **数字全部来自事件流，一个都不是界面编的**：总量是 `assistant/message.usage`，
   模型自己回报的；窗口大小和分段来自 `request/header`，bot 在拼提示词时量的
   （只有那儿拿得到完整的工具 schema，见 session/types.ts 上的注释）。老会话的
   日志里没有后两样——那就只报总量，不摆一个看起来很精确的假分段。 */

/** 分段的颜色。表在这里，渲染处直接内联——不是用户输入，不用转义。 */
const CTX_COLORS = {
  msg: 'var(--color-accent-500)',
  sys: 'var(--color-accent-2-400)',
  skill: 'var(--color-ok-500)',
  // 记忆挨着 Skill：它们都在提示词末尾，同色系才看得出是同一类开销。
  // **必须是 theme.css 里真有的色号**——写一个不存在的变量不会报错，只会画出一段
  // 没有颜色的条，而那一格恰恰是拿来看「谁把上下文吃掉了」的。
  memory: 'var(--color-ok-800)',
  tool: 'var(--color-warn-500)',
  mcp: 'var(--color-accent-2-600)',
  free: 'var(--color-neutral-300)',
}

/**
 * 紧凑的 token 数：98.8k、1M。
 *
 * 不用上面那个 tokens()——它是给模型目录用的，会把 98,800 写成 99K。这一行要让人看出
 * 「还剩多少」，那一档精度正好是有用的那一档。
 */
function ctxNum(n) {
  const v = Math.max(0, Math.round(Number(n) || 0))
  if (v >= 1000000) return (v / 1000000).toFixed(v % 1000000 ? 1 : 0).replace(/\.0$/, '') + 'M'
  if (v >= 1000) return (v / 1000).toFixed(v >= 100000 ? 0 : 1).replace(/\.0$/, '') + 'k'
  return String(v)
}

function ctxWindowOf(provider, model) {
  const p = (state.catalog || []).find((x) => x.provider === provider)
  const m = p && (p.models || []).find((x) => x.id === model)
  return Number(m && m.contextWindow) || 0
}

/**
 * 从事件流里算出当前的上下文占用。没有真实用量就返回 null——一条写着「—」的提示
 * 比没有这条提示更让人分心。
 */
function chatContextStat(events) {
  const list = events || []
  let header = null
  let usage = null
  /**
   * 从后往前找，找齐两样就停：这两条在长会话里都在末尾附近，没必要从头扫一遍。
   *
   * **扫到上下文边界就停**（压缩点或重置点）。越过它继续找，找到的是**压缩之前**那一轮
   * 报的用量——人点完 `/compact`，输入框底下那颗 chip 纹丝不动，看起来就是命令没生效。
   * 停在这里、拿边界自带的数字当估算，下一轮跑完再换成实测。
   */
  let boundary = null
  for (let i = list.length - 1; i >= 0; i--) {
    const ev = list[i] || {}
    const data = ev.data || {}
    if (ev.type === 'session/compact' || ev.type === 'session/reset') {
      // **只有还没拿到用量时才在这儿停。** 已经拿到了就接着往前找 header——
      // 分段（系统提示词/Skill/工具表）是这颗 Bot 的属性，不随边界变，而它可能就落在
      // 边界之前。为了这条线把分段丢掉，等于让浮层从此只报一个总量。
      if (usage) continue
      boundary = { type: ev.type, data }
      break
    }
    if (!usage && ev.type === 'assistant/message') {
      const u = data.usage
      // 出错时补的那几条助手消息带的是全零 usage，跳过——认了它，占比会在一次
      // 模型调用失败之后归零，看着像上下文被清空了。
      if (u && (u.inputTokens || u.cacheReadTokens || u.outputTokens)) usage = u
    }
    if (!header && ev.type === 'request/header') header = data
    if (usage && header) break
  }
  /**
   * 边界之后还没跑过一轮：没有实测，给一个估算。
   *
   * 压缩点自带 `tokensAfter`（摘要 + 保留段）；重置点之后消息是空的，剩下的是**清不掉
   * 的固定开销**——系统提示词、Skill 正文、工具表，由最后那条 request/header 的分段给出。
   * 写 0 是错的：人下一轮马上会发现对不上。
   */
  if (!usage && boundary) {
    // header 要接着往前找：它在边界之前，上面那个循环已经停了。
    if (!header) {
      for (let i = list.length - 1; i >= 0; i--) {
        if ((list[i] || {}).type === 'request/header') {
          header = list[i].data || {}
          break
        }
      }
    }
    const sec = header && header.sections
    const fixed = sec ? (sec.system || 0) + (sec.skills || 0) + (sec.memory || 0) + (sec.builtinTools || 0) + (sec.mcpTools || 0) : 0
    const est = boundary.type === 'session/compact' ? Number(boundary.data.tokensAfter) || 0 : fixed
    const bot0 = chatBotOf()
    const window0 =
      Number(header && header.contextWindow) ||
      ctxWindowOf((header && header.provider) || (bot0 && bot0.provider) || '', (header && header.model) || (bot0 && bot0.model) || '')
    if (!est || !window0) return null
    return {
      used: est,
      window: window0,
      prompt: est,
      cached: 0,
      model: header && header.provider && header.model ? header.provider + ' / ' + header.model : '',
      split: false,
      // 估算，不是实测。浮层脚注会写明这一点。
      estimated: true,
      ratio: Math.min(1, est / window0),
      parts: [{ key: 'msg', label: boundary.type === 'session/compact' ? '摘要与保留段' : '系统提示词与工具表', tokens: est }],
    }
  }
  if (!usage) return null
  const bot = chatBotOf()
  const provider = (header && header.provider) || (bot && bot.provider) || ''
  const model = (header && header.model) || (bot && bot.model) || ''
  const window = Number(header && header.contextWindow) || ctxWindowOf(provider, model)
  if (!window) return null

  const prompt = (usage.inputTokens || 0) + (usage.cacheReadTokens || 0)
  const used = prompt + (usage.outputTokens || 0)
  const sec = header && header.sections
  const parts = []
  if (sec) {
    /**
     * **记忆那一格不能漏。** 漏掉的话它不会消失，会被算进「对话消息」——一个记了
     * 四十条的 Bot，那一格凭空多出上万 token，而人看到的结论是「聊得太长了」，
     * 于是去压缩，压完发现没小多少（docs/memory.md §12 ①）。
     *
     * 老日志没有 `sections.memory` 这个键，`|| 0` 兜住：那时候本来就没有这一段。
     */
    const fixed = (sec.system || 0) + (sec.skills || 0) + (sec.memory || 0) + (sec.builtinTools || 0) + (sec.mcpTools || 0)
    // 分段是估的，总量是真的。估出来比模型报的提示词还多时，按比例压回去——
    // 直接相减的话「对话消息」会变成负数，那一格在条上就消失了。
    const k = fixed > prompt && fixed > 0 ? prompt / fixed : 1
    const sys = Math.round((sec.system || 0) * k)
    const skills = Math.round((sec.skills || 0) * k)
    const memory = Math.round((sec.memory || 0) * k)
    const builtin = Math.round((sec.builtinTools || 0) * k)
    const mcp = Math.round((sec.mcpTools || 0) * k)
    parts.push({ key: 'msg', label: '对话消息', tokens: Math.max(0, used - sys - skills - memory - builtin - mcp) })
    parts.push({ key: 'sys', label: '系统提示词', tokens: sys })
    parts.push({ key: 'skill', label: 'Skill', tokens: skills })
    // 记忆单独一格：和 Skill 并成一格的话，「今天忽然变大」说不清是谁涨的。
    if (memory) parts.push({ key: 'memory', label: '记忆', tokens: memory })
    parts.push({ key: 'tool', label: '内置工具', tokens: builtin })
    parts.push({ key: 'mcp', label: 'MCP 工具', tokens: mcp })
  } else {
    parts.push({ key: 'msg', label: '已用', tokens: used })
  }
  return {
    used,
    window,
    prompt,
    cached: usage.cacheReadTokens || 0,
    model: provider && model ? provider + ' / ' + model : '',
    split: Boolean(sec),
    ratio: Math.min(1, used / window),
    parts: parts.filter((p) => p.tokens > 0),
  }
}

/** 浮层正文。条 + 明细 + 一行脚注，脚注写清楚哪些数是估的。 */
function chatCtxPop(stat) {
  const pct = (n) => ((n / stat.window) * 100).toFixed(1) + '%'
  const rows = [...stat.parts, { key: 'free', label: '剩余空间', tokens: Math.max(0, stat.window - stat.used) }]
  const bar = stat.parts
    .map((p) => `<i style="width: ${((p.tokens / stat.window) * 100).toFixed(2)}%; background: ${CTX_COLORS[p.key]};"></i>`)
    .join('')
  const list = rows
    .map(
      (p) => `<div class="sw-ctxrow">
        <span class="sw-ctxdot" style="background: ${CTX_COLORS[p.key]};"></span>
        <span class="sw-ctxname">${esc(t(p.label))}</span>
        <span class="sw-ctxnum">${esc(exactTokens(p.tokens))}</span>
        <span class="sw-ctxpct">${pct(p.tokens)}</span>
      </div>`,
    )
    .join('')
  const notes = []
  if (stat.model) notes.push(esc(stat.model))
  if (stat.prompt > 0 && stat.cached > 0) {
    notes.push(t('缓存命中') + ' ' + Math.round((stat.cached / stat.prompt) * 100) + '%')
  }
  if (stat.split) notes.push(t('分段为估算，总量来自模型回报'))
  // 刚压过 / 刚重置过，还没跑过一轮：这一整条都是估的，别让它看起来像实测。
  if (stat.estimated) notes.push(t('估算，下一轮跑完是实测'))
  return `<div class="sw-ctxhead">
      <span>${t('上下文窗口')}</span>
      <b>${esc(ctxNum(stat.used))} / ${esc(ctxNum(stat.window))}</b>
    </div>
    <div class="sw-ctxbar">${bar}</div>
    <div class="sw-ctxlist">${list}</div>
    <p class="sw-ctxnote">${notes.join(' · ')}</p>`
}

/**
 * 就地更新那颗药丸和它的浮层。
 *
 * 不走 render()：整页重绘会把输入框换掉，正打着字的人会丢焦点和光标位置——为了右下角
 * 一行灰字付这个代价说不过去。
 */
function paintChatCtx() {
  const box = document.getElementById('chat-ctx')
  if (!box) return
  const stat = chatContextStat(state.chatEvents)
  if (!stat) {
    box.hidden = true
    state.chatCtxOpen = false
    return
  }
  box.hidden = false
  const pct = Math.round(stat.ratio * 100)
  const chip = document.getElementById('chat-ctx-chip')
  const pop = document.getElementById('chat-ctx-pop')
  if (!chip || !pop) return
  chip.textContent = `${ctxNum(stat.used)} / ${ctxNum(stat.window)} (${pct}%)`
  // 七成开始变色、九成变警告色：撞墙之前得有征兆，而不是满了才知道。
  chip.setAttribute('data-level', pct >= 90 ? 'high' : pct >= 70 ? 'mid' : 'low')
  chip.setAttribute('aria-expanded', String(state.chatCtxOpen))
  chip.title = t('上下文用量')
  pop.hidden = !state.chatCtxOpen
  if (state.chatCtxOpen) pop.innerHTML = chatCtxPop(stat)
}

/** 导出成 Markdown。工具痕迹一起带上——只留回答的话，出问题时对不上做过什么。 */
function chatExportText() {
  const folded = fold(state.chatEvents, undefined, currentBotHasChannelLabels())
  const bot = chatBotOf()
  const account = (state.me && state.me.account) || {}
  const me = account.name || account.email || t('我')
  const title = (bot && bot.name) || t('对话')
  const out = ['# ' + title, '', '> ' + chatMetaText(folded), '']
  for (const b of folded.blocks || []) {
    // 上下文边界：一条分隔线加一句说明。套 `## 我 / ## Bot` 那个壳的话，这里会导出
    // 一个空的二级标题——它既不是谁说的话，也没有正文。
    if (b.kind === 'mark') {
      out.push('---', '', '*' + ctxDivText(b) + '*', '')
      continue
    }
    out.push('## ' + (b.kind === 'user' ? me : title) + (b.time ? ' · ' + fmtTime(b.time) : ''), '')
    for (const x of b.tools || []) {
      out.push('- ' + t('工具') + ' `' + x.name + '` · ' + (x.result == null ? t('调用中') : x.failed ? t('失败') : t('完成')))
      for (const f of x.files || []) out.push('  - ' + t('产出') + ' `' + f.path + '`')
      // 截图也写一行：导出的这份是事后复盘用的，而「当时页面长什么样」正是那时候要找的。
      if (x.shot && x.shot.path) out.push('  - ' + t('截图', 'screenshot') + ' `' + x.shot.path + '`')
    }
    if ((b.tools || []).length) out.push('')
    out.push(String(b.text || '').trim(), '')
  }
  return out.join('\n')
}

function downloadFile(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type: type || 'text/plain;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function deployBotButton(botId, label) {
  if (!botId) return ''
  const cls = label ? 'btn' : 'btn btn-primary'
  return `<button type="button" class="${cls}" data-act="runtime-deploy" data-bot="${esc(botId)}" ${state.deploying ? 'disabled' : ''}>${state.deploying ? t('部署中…') : label || t('部署这个 Bot')}</button>`
}

/**
 * 这个 Bot 的席位落在哪台机器上、那台机器现在通不通：
 * `''`（没这个字段）/ `online` / `stale` / `offline` / `unpaired`。
 *
 * **席位的 `status` 答不了这件事。** 它是「上一次部署走到哪一步了」，落库之后就不动
 * 了：机器断电、网线拔了、管家挂了，那一行照样写着 `ready`。于是平台那一页的灯已经
 * 打成「失联」，员工这边的 Bot 还挂着「在线」，点发送没有任何反应——发送失败那一路
 * 只会把 `实例还没上线` 写进 runtimeError，而它被 runtimeDownBanner 挡在界面外（那句
 * 话是重新部署时的常态，不该弹红字）。两头一凑，就是「什么都没说」。
 *
 * 判据直接用平台那一份（gateway 的 machineLink：心跳有多久没来了），一个字都不另算
 * ——同一台机器在两个页面上说两种话，比少一个字段糟得多。
 *
 * **后端没给这个字段 ≠ 机器失联。** 前端比后端新一步（浏览器读的是磁盘上的 app.js，
 * Gateway 要重启才换代码）就会拿到 undefined。那时老实回 ''、让灯照旧按部署状态走，
 * 不替它猜一个「失联」——猜错的方向恰恰是最吓人的那个。
 */
function seatLinkOf(bot) {
  const rt = bot && bot.runtime
  return (rt && rt.machineLink) || ''
}

function seatLink() {
  return seatLinkOf(chatBotOf())
}

/** 这盏灯该说「它现在够不着」的两档。`unpaired` 不算——那是「还没装」，另有话说。 */
function linkDown(link) {
  return link === 'offline' || link === 'stale'
}

/**
 * 「这个 Bot 的机器失联了」摆在对话最上面。
 *
 * **只有 `offline` 才出横幅，`stale` 不出。** 中间那一档（3 到 20 轮心跳）本来就是
 * 换版重启会落进去的窗口，出一条红字等于每次自升级都喊一次狼来了。抬头那盏灯会先
 * 变成「心跳迟了」——想看的人看得见，不想看的人不被打断。
 *
 * 话要说到「所以现在会怎样」：人看见「失联」两个字之后真正要知道的是，这期间发出去
 * 的消息不会到、它的回复也回不来，以及这事不用他去点什么按钮。
 */
function machineDownBanner() {
  const bot = chatBotOf()
  if (!bot || bot.runtimeKind === 'local' || seatLinkOf(bot) !== 'offline') return ''
  const age = bot.runtime.machineHeartbeatAge
  const when = age == null ? t('从未心跳') : t('最后一次心跳 %s').replace('%s', sinceMs(age))
  const name = bot.name || t('这个 Bot')
  // 两个占位符用不同的记号：都写 %s 的话，名字里恰好有一个 %s 就会把第二次替换吃掉。
  return `<div class="gw-flash gw-flash-err">${esc(
    t('%s 所在的机器失联了（%t）。这期间消息发不出去，它的回复也送不回来；机器回来之后这一页会自己接上。一直不好就找管理员看看那台机器。')
      .replace('%t', when)
      .replace('%s', name),
  )}</div>`
}

/**
 * 对话页右侧的「这个 Bot 的机器」栏。
 *
 * 部署按钮和环境信息原来挤在左边名册的上方，两者都不好用。挪到右栏之后：名册只管
 * 选人，中间只管对话，机器的事集中在一处。
 *
 * **桌面地址做成按钮,不打印 URL。** 那条 URL 里带着一整段 JWT 票（五分钟有效），
 * 渲染成文本会占掉半屏，而且没人会去手抄它——它唯一的用法就是点开。
 */
/**
 * 这一刻这一屏对着的那个 Bot 的安装进度。**别的 Bot 的那一份不作数**——轮询是异步的，
 * 人在两次回执之间换了 Bot，认领上一份就等于把别人的进度画在这一页上。
 */
function deployProgressNow() {
  const p = state.deployProgress
  return p && p.botId === chatBotIdNow() ? p : null
}

/**
 * 这个 Bot 的席位走到哪一步了：`unbound` / `none` / `deploying` / `error` / `ready`。
 *
 * 抽出来是因为有两处要看它——对话正文中间那块「去部署」，和右栏。两处各判一次的话，
 * 迟早出现「中间说没部署、右栏说在线」这种自相矛盾的画面。
 *
 * **进度那一份优先于 desktopRuntime。** 它每两秒刷一次，而 desktopRuntime 只在进页面
 * 和部署收尾时取；刚建完的那颗 Bot 尤其——那一刻 `/runtime/desktop` 完全可能还是 404
 * （席位行刚落库、或者后台那次登记还差几百毫秒），照着它画就是一句「还没有部署」外加
 * 一颗按钮，而机器上已经开工了。
 */
function seatStage() {
  const bot = chatBotOf()
  if (bot && bot.runtimeKind === 'local') return bot.runtime && bot.runtime.status === 'ready' ? 'ready' : 'none'
  if (!(state.runtimeMachine && state.runtimeMachine.paired)) return 'unbound'
  const p = deployProgressNow()
  /**
   * **`stalled` 和 `deploying` 必须分开。**
   *
   * 库里那一行两种情况长得一模一样，可人要做的事完全相反：一个是接着等（什么都不用
   * 按），一个是这次装到一半没人接着装了（非按一下不可）。混成一档的代价是后者——
   * 一屏永远走不完的读秒，外加一颗都没有的按钮。判据由服务端给（见
   * `/runtime/deploy/progress` 的 stale）：只有那个进程知道自己手上有没有这活儿。
   */
  if (p && p.status === 'deploying') return p.stale ? 'stalled' : 'deploying'
  const mine = state.desktopRuntime
  if (!mine || mine.status === 'none') return p && p.status === 'error' ? 'error' : 'none'
  if (mine.status === 'error' || mine.status === 'deploying') return mine.status
  return mine.status === 'ready' ? 'ready' : 'none'
}

/** 上一次部署失败的理由。两份里哪份有话说算哪份（见 seatStage 里那段）。 */
function seatErrorText() {
  const p = deployProgressNow()
  return (state.desktopRuntime && state.desktopRuntime.lastError) || (p && p.lastError) || t('部署失败')
}

/**
 * 安装进度那一屏的正文。
 *
 * 三档，**说得出多少就说多少，不摊成一根匀速的百分比条**：机器上那几步的时长差着一个
 * 数量级（apt 装桌面栈占大半，写 systemd 单元一秒都不到），摊平的进度条只会在最长的那
 * 一步上停住不动——比不画还糟，因为它明确地在骗人。
 *
 *   · 管家报得出第几步（协议 3 起）→ 「第 3 步 / 共 7 步 · 安装浏览器」，带一根按步数
 *     走的条；
 *   · 只知道已经下发了 → 「机器上正在安装」；
 *   · 刚登记完还没发出去 → 「正在下发到机器」。
 *
 * 读秒那一格套的是现成的 `.sw-time[data-running]`（见 tickClocks）：每秒自己往前走，
 * 不用为这一屏再挂一个定时器。**它是这屏上最要紧的一句话**——人真正想知道的是「这是
 * 正常的等，还是卡住了」，而唯一能回答的就是「已经装了多久」。
 */
function installProgressBody() {
  const p = deployProgressNow()
  const step = p && p.step
  const rows = []
  if (step && step.total > 0) {
    const pct = Math.max(4, Math.min(100, Math.round((step.step / step.total) * 100)))
    rows.push(`<div class="sw-install-bar"><span style="width:${pct}%"></span></div>`)
    rows.push(
      `<p class="sw-install-step">${esc(
        t('第 %a 步 / 共 %b 步', 'Step %a of %b').replace('%a', String(step.step)).replace('%b', String(step.total)),
      )} · ${esc(step.label || '')}</p>`,
    )
  } else {
    rows.push(
      `<p class="sw-install-step">${esc(
        p && p.phase === 'queued'
          ? t('正在下发到机器…', 'Sending it to the machine…')
          : t('机器上正在安装…', 'Installing on the machine…'),
      )}</p>`,
    )
  }
  // **本地锚点，不是服务端时刻**（见 pollDeployProgress 里那段）：读秒往后每一下都由
  // 这台电脑自己的时钟走，两台钟差多少都不进这个数。
  const since = (p && p.since) || 0
  if (since) {
    rows.push(
      `<p class="sw-install-since">${t('已经装了', 'Running for')} <span class="sw-time" data-running data-since="${since}">${esc(
        elapsedText(Date.now() - since),
      )}</span></p>`,
    )
  }
  return rows.join('')
}

/**
 * 席位没上线时，**把话说在正文中间**，而不是只摆在右栏里。
 *
 * 原先这套提示只有右栏一份：而右栏可以收起（默认也常常是收起的），于是人看到的是一
 * 片空白的对话，外加一个能打字、发出去却没有任何反应的输入框——最需要指路的那一刻，
 * 屏幕正中什么也没说。
 *
 * 输入框在这个状态下整个不渲染。留着它就是留一个「看着能用、按了没用」的东西，比没有
 * 更糟。
 */
function chatDeployPrompt(botId) {
  const stage = seatStage()
  if (stage === 'ready') return ''
  const bot = chatBotOf() || {}
  const name = bot.name || t('这个 Bot')
  let title = ''
  let body = ''
  let action = ''
  let extra = ''
  if (bot.runtimeKind === 'local') {
    title = t('%s 正在等待 Desktop', '%s is waiting for Desktop').replace('%s', name)
    body = window.__SATUWORK_DESKTOP__
      ? t('本地运行时正在启动；它会使用这台 Mac 上独立的默认工作目录。', 'The local runtime is starting with its own workspace on this Mac.')
      : t('请用 Satuwork Desktop 打开这个页面。本地 Bot 不会在普通浏览器里启动。', 'Open this page in Satuwork Desktop; local bots do not start in a regular browser.')
    action = window.__SATUWORK_DESKTOP__
      ? `<button type="button" class="btn btn-primary" data-act="local-bot-start" data-bot="${esc(botId)}">${t('重新启动', 'Start again')}</button>`
      : ''
  } else if (stage === 'unbound') {
    title = t('公司的运行机器还没配好')
    body = t('公司的运行机器还没有配对机器管家，请系统管理员在公司详情里生成配对码。')
  } else if (stage === 'deploying') {
    /**
     * 建完 Bot 之后人就坐在这一屏上等。所以这里说的不能只是「部署中…」——那句话在第
     * 一秒和第十分钟长得一模一样，人唯一能做的判断变成「是不是卡死了」，而正确答案
     * 通常是「没有，第一次装就是这么久」。
     *
     * 三句话，一句都不能少：**在装什么**（第几步）、**装了多久**（读秒）、**要不要
     * 守着**（不用，装好自己会变成对话）。
     */
    title = t('正在安装「%s」…', 'Setting up “%s”…').replace('%s', name)
    body = t(
      '第一次装要在机器上铺一整套桌面，通常几分钟。装好之后这一页会自己变成对话，不用守着——也可以先去做别的。',
      'The first install lays down a whole desktop on the machine and usually takes a few minutes. This page turns into the conversation on its own once it is done.',
    )
    extra = installProgressBody()
  } else if (stage === 'stalled') {
    // 说清楚**发生了什么**、**现在是什么状态**、**该按哪一下**。只写一句「部署失败」
    // 的话，人会去查一个根本不存在的故障——机器好好的，只是这次装没人接着做完。
    title = t('上一次安装没做完', 'The last install did not finish')
    body = t(
      '装到一半中断了（多半是 Gateway 重启过），机器上没有人接着装。点「重新部署」再来一次，已经装好的部分会复用。',
      'It stopped halfway — most likely the Gateway restarted — and nothing is installing it now. Hit “Redeploy” to run it again; whatever was already installed is reused.',
    )
    action = deployBotButton(botId, t('重新部署'))
  } else if (stage === 'error') {
    title = t('上一次部署没成功')
    body = seatErrorText()
    action = deployBotButton(botId, t('重新部署'))
  } else {
    title = t('%s 还没有部署').replace('%s', name)
    body = t('部署之后它才有自己的机器和桌面，也才收得到消息。这一步要几分钟。')
    action = deployBotButton(botId)
  }
  const hint = state.deployHint ? `<p class="sw-nodeploy-hint">${esc(state.deployHint)}</p>` : ''
  return `<div class="gw-chat-empty-main"><div class="sw-nodeploy">
    <span class="sw-nodeploy-icon">${svg(MONITOR, 26)}</span>
    <h2>${esc(title)}</h2>
    <p>${esc(body)}</p>
    ${extra}${action}${hint}
  </div></div>`
}

function chatMachinePanel() {
  const selected = chatBotIdOf(state.path) || state.chatBotId
  if (!selected) return ''
  const mine = state.desktopRuntime
  const stage = seatStage()
  const rows = []
  const local = (chatBotOf() || {}).runtimeKind === 'local'

  // 没上线时右栏只报状态，**不再摆第二颗部署按钮**——那句话和那颗按钮现在在正文
  // 中间，同一块屏幕上放两个一模一样的主操作，只会让人先分辨该点哪一个。
  if (local) {
    rows.push(`<p style="margin:0;font-size:12px;color:var(--muted-foreground);line-height:1.6;">${esc(
      stage === 'ready'
        ? t('运行在这台 Mac；默认只访问自己的工作目录。', 'Running on this Mac with access limited to its own workspace.')
        : t('本地运行时尚未连接。', 'The local runtime is not connected yet.'),
    )}</p>`)
    if (window.__SATUWORK_DESKTOP__) {
      rows.push(`<button type="button" class="btn btn-secondary" data-act="local-dir-approve" data-bot="${esc(selected)}">${t('批准访问其他文件夹', 'Approve another folder')}</button>`)
    }
  } else if (stage === 'unbound') {
    rows.push(
      `<p style="margin: 0; font-size: 12px; color: var(--muted-foreground); line-height: 1.6;">${t('公司的运行机器还没有配对机器管家，请系统管理员在公司详情里生成配对码。')}</p>`,
    )
  } else if (stage === 'none') {
    rows.push(`<p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('实例还没上线')}</p>`)
  } else if (stage === 'error') {
    // **不能读 mine.lastError**：这一档现在也可能只有进度那一份说得出话（席位行还没
    // 落到这个浏览器手上），那时 mine 是 null，读它就是一个白屏。
    rows.push(`<div class="gw-flash gw-flash-err" style="margin: 0;">${esc(seatErrorText())}</div>`)
  } else if (stage === 'stalled') {
    rows.push(`<div class="gw-flash gw-flash-err" style="margin: 0;">${esc(t('上一次安装没做完', 'The last install did not finish'))}</div>`)
  } else if (stage === 'deploying') {
    const p = deployProgressNow()
    const step = p && p.step
    const line = step ? `${t('正在安装', 'Installing')} · ${step.label || ''}` : t('正在安装…', 'Installing…')
    rows.push(`<p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${esc(line)}</p>`)
  }

  /**
   * 机器通不通，**这一栏也要说一句**。
   *
   * 席位铺好之后这一栏里就只剩那块桌面了，而机器失联时它是一块静止的死屏——不写这
   * 一行的话，人会以为是桌面这一路坏了，去点「重新连接」。灯和横幅在正文那边，右栏
   * 收起时同样看不见（它默认常常是收着的）。
   *
   * 两档都说，用的还是机器页那套词和那盏灯：`stale` 只是一句灰字（换版重启就长这样），
   * `offline` 才用错误色。
   */
  if (stage === 'ready' && linkDown(seatLink())) {
    const link = seatLink()
    const age = (chatBotOf() || {}).runtime?.machineHeartbeatAge
    const when = age == null ? t('从未心跳') : sinceMs(age)
    const label = (LINK_TEXT[link] || LINK_TEXT.unknown)()
    rows.push(
      link === 'offline'
        ? `<div class="gw-flash gw-flash-err" style="margin: 0;">${esc(t('机器') + ' ' + label + ' · ' + when)}</div>`
        : `<p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${esc(t('机器') + ' ' + label + ' · ' + when)}</p>`,
    )
  }

  if (mine && mine.status === 'ready') {
    if (!mine.novncUrl) {
      // 桌面地址只剩直连一种（Gateway 不再反代 `/desktop/…`）：机器没配 directUrl 或管家
      // 太旧时它是 null。不说这一句的话这一栏就是空的，人会以为桌面这一路坏了。
      rows.push(
        `<p style="margin: 0; font-size: 12px; color: var(--muted-foreground); line-height: 1.6;">${esc(t('这台机器没有配直连地址，桌面打不开'))}</p>`,
      )
    } else if (deskEmbeddable(mine.novncUrl)) {
      // 只放一个空槽。真正的 iframe 挂在 #app 外面的常驻层里（见 syncDesktop），
      // 整页重绘换不掉它——换掉一次就是断一次 VNC。
      rows.push(
        `<div class="sw-desk">
          <div class="sw-desk-slot" id="sw-desk-slot"><span>${t('正在连桌面…')}</span></div>
          <p class="sw-desk-cap">${esc(deskCaption())}</p>
        </div>`,
      )
    } else if (mine.novncUrl) {
      // 嵌不了的时候退回原来那颗按钮——新标签页是顶层导航，没有 iframe 那些限制。
      rows.push(
        `<a class="btn btn-primary" href="${esc(mine.novncUrl)}" target="_blank" rel="noopener noreferrer" style="text-align: center;">${t('打开桌面')}</a>`,
      )
    }
    /**
     * **右栏到这儿就结束了。**
     *
     * 这里原先还挂着一个「席位详情」折叠面板：共享目录、linuxUser、Bot 版本，以及
     * 「运行日志」「重新部署」两个入口。它们都是「出事那天」才用一次的东西，而这一
     * 栏每天要看的只有上面那块屏——多一个可展开的标题，就多一次「这里面是什么」的
     * 分神。
     *
     * **日志和重铺跟着一起下线了，这是有代价的**：员工手上暂时没有自助重铺的入口，
     * 席位坏了要找管理员。要把它们放回来的话，位置应该是桌面全屏时那条标题栏——出问
     * 题的是那块屏，人当时也正看着它。
     */
  }

  return rows.join('')
}

/* ── 工作区文件 ───────────────────────────────────────────────────────────
 *
 * 右栏的另一屏：这台席位工作区里到底有些什么。
 *
 * 为什么要有它：在此之前，一个文件想被人看见，必须先在对话里被提到——Bot 写出来的
 * 那份报告、上传上去的那个附件。可工作区是**同一个员工所有席位共用的一个目录**，
 * 上周那次对话生成的东西、今天早上日常任务跑出来的东西，全都在里面躺着，界面上却
 * 一个入口都没有，人只能反过来问 Bot「我那份报告叫什么来着」。
 *
 * 一次只取一层（`/runtime/sessions/:id/workspace?path=`），展开哪个目录取哪个：
 * 跑上几周的工作区底下是几千个文件，一次拉整棵树既慢又没人看得完。
 */

/**
 * 文件那一屏开着、但这条会话的根还没取过：补一次。
 *
 * 挂在每次重绘上，而不是在「点开那一屏」那一处调一次——进这一页的路不止一条
 * （偏好里本来就开着、从别的页面切回来、席位刚接上），少接一条的表现就是那一屏
 * 永远停在「载入中」。取过一次之后这里是两个等值判断，白跑也不值几个周期。
 *
 * **「取过了」是按会话记的，不是按「这个格子有没有东西」记的**（state.wsSession）。
 * 这一条是那个「第一次打开文件夹是空的、按一下刷新就出来了」的原因：进页面那会儿
 * 席位还没接上，`chatSessionId` 是空的，这一屏立刻拿到一句「实例还没接上」——而那
 * 句话本身就算「取过了」，于是十几秒后席位接上、对话正常了，这一屏还停在原地，除非
 * 有人去按那颗刷新。会话从空串变成一个 id，本身就是「刚才那次不作数」。
 *
 * **推迟一拍再取，不在这一帧里动手。** 这个函数是从 render() 和 paintChat 里叫的，而
 * loadWorkspaceDir 开跑之前会 render() 一次；在重绘中间再来一次整页重绘，会把
 * paintChat 手上那个 #chat-thread 整个换掉，它接着往一个已经脱离文档的节点上画——
 * 往前翻历史时那套「内容在上面长高了多少就把视线推回多少」的锚定，就是这么失灵的。
 *
 * 那道「取过没有」的闸这里也要判一遍（loadWorkspaceDir 里还有一道）：不判的话，
 * 流式的每一帧都会排一个白跑的定时器出去。
 */
function ensureWorkspaceTree() {
  if (!wsPanelOnScreen()) return
  // 会话换了（切了 Bot、席位重建过、或者刚从「还没接上」变成接上了）：手上这棵树是
  // 上一台席位的，连同「取过了」这件事一起作废。
  if ((state.wsSession || '') !== (state.chatSessionId || '')) resetWorkspaceTree()
  const cur = wsDirs()['']
  if (cur && (cur.loading || cur.entries)) return
  // 上一趟失败了：**看是哪种失败**。「这个席位没有这条接口」那种再问一百遍也是同一个
  // 答案；而「席位还在热身」是**时间问题**——人进页面那会儿正好赶上，凭什么要他自己
  // 去按刷新才看得到文件。所以只有后者带 retryAt，到点了自己再来一趟。
  if (cur && cur.error && !(cur.retryAt && Date.now() >= cur.retryAt)) return
  if (wsPending) return
  wsPending = true
  setTimeout(() => {
    wsPending = false
    // 这一拍之内人可能已经切走了、或者把那一屏收起来了。再取一份没人看的目录、还为它
    // 整页重绘一次，会把新那一页上正在打字的输入框换掉。
    if (!wsPanelOnScreen()) return
    void loadWorkspaceDir('', Boolean(cur && cur.error))
  }, 0)
}

/**
 * 已经排了一个「去取根目录」的定时器。
 *
 * 排队的这一拍里 wsDirs 还是空的（或者还挂着上一趟那条错），于是同一拍里的每一次
 * 重绘——流式的时候一拍能来好几次——都会再排一个，最后是好几条一模一样的请求同时
 * 出发。真正拦住它们的只有 loadWorkspaceDir 里那道 loading 闸，而那道闸要等第一条
 * 跑起来才立得住。
 */
let wsPending = false

/**
 * 文件那一屏此刻在不在屏幕上。
 *
 * **不看 #chat-thread**。那个节点只在「有 Bot、而且席位已经部署过」的时候才画得出来
 * （见 chatPage 里的 chatDeployPrompt），可右栏那一屏在别的形态下照样开着——盯着它等
 * 于在那几种形态下一次都不取，那一屏永远是「载入中」。
 */
function wsPanelOnScreen() {
  return hasAside() && asidePref.open && asidePref.tab === 'files'
}

/**
 * 换了一条会话（切 Bot、席位重建过、席位刚接上）：手上这棵树是上一台席位的，作废。
 */
function resetWorkspaceTree() {
  state.wsDirs = {}
  state.wsOpen = {}
  // 茬数跟着一起清。这棵树整个换了，在途那几趟本来就靠下面那句会话判据作废，
  // 留着旧计数只会让这张表一直长。
  state.wsGen = {}
  // 记下这一次作废是冲着哪条会话去的，免得下一次重绘又判成「会话换了」，一帧作废一次。
  state.wsSession = state.chatSessionId || ''
  // 不在这里重取：那一屏开着的话，下一次重绘自己会补（见 ensureWorkspaceTree）。
}

/** 目录的展开状态与内容。key 是相对工作区根的路径，根目录是空串。 */
function wsDirs() {
  return state.wsDirs || (state.wsDirs = {})
}

/**
 * 这一层现在是「第几茬」（见 state.js 的 wsGen）。
 *
 * **在途的那一趟只看会话是不够的。** 删一个目录、和「刷新」正在取它，这两件事撞在
 * 一起时会话根本没变：那一趟回来会把刚删掉的那份内容原样写回缓存。人当时看不见——
 * 那一行已经从上一层里消失了——直到 Bot 又建出一个同名目录（每传一个附件都会建
 * `uploads/<sessionId>`），展开它看到的是上一茬的文件，点开全是「文件不存在」，
 * 而且只有按刷新才好得了。
 */
function wsGenOf(key) {
  return (state.wsGen || (state.wsGen = {}))[key] || 0
}

/** 这一层作废了：茬数 +1，在途那一趟回来对不上就自己扔掉。 */
function wsBumpGen(key) {
  const gens = state.wsGen || (state.wsGen = {})
  gens[key] = (gens[key] || 0) + 1
}

/**
 * 软失败隔多久自己再来一趟。
 *
 * 十秒是照着「席位热身」定的：那一段通常是几十秒，重试个几次就赶上了，而人在这十秒里
 * 多半还在读上面那句话。再短就成了打席位，再长就不如让他自己去按刷新。
 */
const WS_RETRY_MS = 10_000

/** 取一层。已经取过就不再取——除非 force（那是人按了刷新，或者软失败到点了）。 */
async function loadWorkspaceDir(path, force) {
  const key = path || ''
  const dirs = wsDirs()
  const cur = dirs[key]
  // 取过、正在取、或者上次取失败了，都不再自动重来——这个函数每次重绘都会被叫一次
  // （见 ensureWorkspaceTree），失败了还自动重试的话，一台没上线的席位会被打成一串
  // 重试。重来的入口是那颗刷新，外加「会话换了」——那不是重试，那是另一台席位。
  if (!force && cur && (cur.loading || cur.entries || cur.error)) return
  // 这一趟是给哪条会话取的。**记下来**：席位接上之后 ensureWorkspaceTree 靠它判出
  // 「刚才那次不作数」，重取一遍。
  const sid = state.chatSessionId || ''
  state.wsSession = sid
  if (!sid) {
    // 会话还没接上（席位刚起来那几十秒）。**说出来**，别画一棵空树让人以为工作区是空的。
    // 这句话不是终点：会话一到手，上面那句 wsSession 就对不上了，那一屏自己会再取一次。
    dirs[key] = { loading: false, error: t('实例还没接上，稍后再看'), entries: null }
    render()
    return
  }
  // 这一趟取的是这一层的**第几茬**。删掉一层（连带它的上一层）会把茬数往前推一格，
  // 回来时对不上就说明手上这份东西已经被删掉了，见 wsGenOf。
  const gen = wsGenOf(key)
  /**
   * 「这一趟还作不作数」。两条判据，缺一条就会有一份陈的东西写进缓存：
   *
   * · **会话**——人换了 Bot、席位重建过，那是另一台机器的目录。
   * · **茬数**——这一层在半路上被删掉了（或者上一层被删了、正在重取）。会话在这种
   *   情况下一动不动，光看它拦不住。
   *
   * 对不上就**什么都不做**，不去清 dirs[key]：那一格这会儿要么已经被删除那一路扔掉了，
   * 要么装着新一趟刚写进去的东西——顺手清一下正好把新的抹了。
   */
  const stale = () => (state.chatSessionId || '') !== sid || wsGenOf(key) !== gen
  dirs[key] = { ...(cur || {}), loading: true, error: '' }
  render()
  try {
    const url = '/runtime/sessions/' + encodeURIComponent(sid) + '/workspace?path=' + encodeURIComponent(key)
    const data = await api('GET', url)
    // 这一趟在路上的时候人可能已经换了 Bot、席位也可能重建过，也可能这一层刚被删掉。
    // **这份结果不作数**：写回去就是把上一台席位（或者上一茬）的目录挂在这一屏上，
    // 而 dirs 这会儿多半已经是被 resetWorkspaceTree 换掉的那个空对象，写进去连画都
    // 画不出来。
    if (stale()) return
    // 席位回的不是一份目录（反代把别的什么塞回来了、或者回了一个空身子）：那是**没
    // 取到**，不是「工作区是空的」。差别全在人接下来会做什么——后者他会去传个文件，
    // 前者他该再取一次。
    const list = data && Array.isArray(data.entries) ? data.entries : null
    if (!list) {
      // **带一个状态码往下抛。** 下面那道分档拿 `!e.status` 认「根本没走到 Gateway」，
      // 光杆一个 Error 会被认成那一种，摆出一句「连不上服务器」——而这一趟明明走到了
      // 席位，只是回来的东西不对。502 说的正是这件事：上游回了一份不认识的东西。
      const err = new Error(t('列不出来'))
      err.status = 502
      throw err
    }
    wsDirs()[key] = {
      loading: false,
      error: '',
      entries: list,
      more: Number((data && data.more) || 0),
    }
  } catch (e) {
    // 同上：换过会话、或者这一层已经被删掉了，都不作数。一条「上一台席位列不出来」
    // 挂在新席位那一屏上，人只会拿它去猜新席位的毛病；而给一个刚被删掉的目录重新
    // 摆一条错，等于把那一行又种回树上。
    if (stale()) return
    // 席位版本旧的时候这条路由根本不存在，席位回的是 404 加一句 `unknown endpoint`
    // （见 bot 那边 /api/* 的兜底）。照抄给人看等于没说——这一屏是新的，旧席位上没有，
    // 那就直说要更新（和文档提取那条同一个说法，见 openPreview）。
    //
    // **先看状态码。** 文案会被 errText() 过一遍译表，拿它当唯一判据是 data.js 明说过
    // 别做的事；而「目录真的不见了」同样是 404，所以文案还得跟着一起看。
    // 截一段就够。这条错在最坏的情况下不是一句话——反代在前面挡一下，回来的可能是
    // 整页 HTML 错误页（api() 拿不到 JSON 就把响应体原样当消息），糊满右栏那一条。
    const raw = (e.message || '').slice(0, 200)
    /**
     * **压根没走到 Gateway**：`api()` 里那句 `await fetch()` 自己 reject 了，抛出来的是
     * 浏览器的 TypeError，没有 status，`errText` 也过不上（它只作用在 `!res.ok` 上）。
     * Gateway 正在重启、网断了一秒、机器刚从睡眠里醒过来，都长这样。
     *
     * 这是**最该自己再来一趟**的一种，偏偏最容易掉进「答案不会变」那一档去；照抄
     * `e.message` 给人看则是在右栏上摆一句没翻译的 “Failed to fetch”。
     */
    const offline = !e.status
    wsDirs()[key] = {
      loading: false,
      error: offline
        ? t('连不上服务器，过一会儿自己会再试一次', 'Cannot reach the server — this will retry shortly.')
        : e.status === 404 && /unknown endpoint/i.test(raw)
        ? t('这个席位还不支持列工作区文件（要更新 Bot 版本）', 'This seat cannot list workspace files yet (update the bot).')
        : raw || t('列不出来'),
      entries: null,
      // 「那头这会儿不行」的都排一次重来（见 ensureWorkspaceTree）：席位还在热身、管家
      // 没应声、反代超时（5xx），以及上面那种根本没出门的。4xx 不给——那是「答案不会
      // 变」，重试只是在打一台已经把话说清楚了的席位。
      retryAt: offline || e.status >= 500 ? Date.now() + WS_RETRY_MS : 0,
    }
  }
  render()
}

/** 点一下目录：开就收、收就开，第一次展开时才去取内容。 */
async function toggleWorkspaceDir(path) {
  const key = path || ''
  const open = state.wsOpen || (state.wsOpen = {})
  if (open[key]) delete open[key]
  else open[key] = true
  render()
  if (open[key]) await loadWorkspaceDir(key)
}

/**
 * 刷新。**已经展开的那几层全部重取**，只重取根的话，人正看着的那一层照旧是旧的——
 * 而按刷新的时刻，多半正是「Bot 刚说它写好了，我想看看在不在」。
 */
async function refreshWorkspaceTree() {
  const keys = ['', ...Object.keys(state.wsOpen || {})]
  await Promise.all([...new Set(keys)].map((k) => loadWorkspaceDir(k, true)))
}

/** 行末那颗删除用的字纸篓。和日常任务那一颗同一份路径，两处画的是同一个动作。 */
const WS_TRASH = ['M4 7h16', 'M9 7V5h6v2', 'M6 7l1 13h10l1-13']

/** 这条路径的上一层。根底下的东西回空串，那正是根目录自己的 key。 */
function wsParentOf(path) {
  const i = String(path || '').lastIndexOf('/')
  return i < 0 ? '' : String(path).slice(0, i)
}

/**
 * 删掉树上的一个文件或目录。**走到这儿人已经在确认框上点过「删除」了**（见 app.js
 * 的 ws-del），这里不再问第二遍。
 *
 * 删完只重取**上一层**，不整棵树重来：人删的是眼前这一行，别的层没有理由跟着闪一下，
 * 而且一次刷新会把还在路上的展开状态全部拉一遍。
 *
 * 删掉一个目录时，手上缓存着的它自己和它底下那几层要一起扔掉：不扔的话，下次有人
 * 建了个同名目录再展开，看到的是上一份内容——那些文件早就不在了。
 */
async function deleteWorkspaceEntry(path, name) {
  const key = String(path || '')
  const sid = state.chatSessionId || ''
  if (!key || !sid) {
    flash('err', t('实例还没接上，稍后再看'))
    render()
    return
  }
  try {
    await api('DELETE', '/runtime/sessions/' + encodeURIComponent(sid) + '/workspace?path=' + encodeURIComponent(key))
    flash('ok', t(`已删除 ${name || key}`, `Deleted ${name || key}`))
  } catch (e) {
    // 席位版本旧的时候这条路由压根不存在，回的是 404 加一句 `unknown endpoint`（见 bot
    // 那边 /api/* 的兜底）。**这一条要排在下面那条前面**：照 404 认成「已经不在了」的话，
    // 人会收到一句「删掉了」，刷新一下那个文件却还在——而真正的原因是席位该更新了。
    // 和列目录那条同一个说法（见 loadWorkspaceDir）。
    const raw = (e.message || '').slice(0, 200)
    if (e.status === 404 && /unknown endpoint/i.test(raw)) {
      flash('err', t('这个席位还不支持删工作区文件（要更新 Bot 版本）', 'This seat cannot delete workspace files yet (update the bot).'))
      render()
      return
    }
    // 404 = 那个东西本来就不在了（别处删过、Bot 自己清掉了）。**不当失败说**：人要的
    // 结果已经成立，摆一句红字只会让他以为还得再删一次。下面照旧重取一遍，那一行
    // 自己会消失。
    if (e.status !== 404) {
      flash('err', e.message)
      render()
      return
    }
    flash('ok', t(`${name || key} 已经不在了`, `${name || key} was already gone`))
  }
  // 这一趟在路上的时候人可能已经换了 Bot（那棵树整个作废了）。写回去只会把一棵
  // 属于上一台席位的树重新种回来。
  if ((state.chatSessionId || '') !== sid) return
  const dirs = wsDirs()
  const open = state.wsOpen || (state.wsOpen = {})
  // 扔掉的每一层都推一格茬数（连自己，哪怕它压根没被取过）。**光删缓存不够**：按了
  // 刷新之后那几趟正在路上，删完它们才回来，会把这份内容原样写回去（见 wsGenOf）。
  wsBumpGen(key)
  for (const k of Object.keys(dirs)) {
    if (k === key || k.startsWith(key + '/')) {
      delete dirs[k]
      wsBumpGen(k)
    }
  }
  for (const k of Object.keys(open)) {
    if (k === key || k.startsWith(key + '/')) delete open[k]
  }
  // **上一层也要推一格**，而且要赶在重取之前：刷新那一趟可能正取着它，回来会把刚
  // 删掉的那一行原样摆回去——而人眼前正是「我刚删掉的东西怎么又回来了」。
  const parent = wsParentOf(key)
  wsBumpGen(parent)
  await loadWorkspaceDir(parent, true)
}

/** 右栏那一屏。整页重绘时从 state 重画，没有自己的增量逻辑——它小，且不常动。 */
function workspacePanel() {
  const root = wsDirs()[''] || {}
  const head = `<div class="sw-ws-head">
    <h3>${t('工作区文件')}</h3>
    <button type="button" class="btn btn-ghost btn-icon" data-act="ws-refresh"
      aria-label="${esc(t('刷新'))}" title="${esc(t('刷新'))}">${svg(REFRESH, 15)}</button>
  </div>`
  return `<div class="sw-ws">${head}${wsBody(root)}</div>`
}

function wsBody(root) {
  if (root.error) return `<div class="gw-flash gw-flash-err" style="margin: 0;">${esc(root.error)}</div>`
  if (!root.entries) return `<p class="sw-ws-note">${t('载入中…')}</p>`
  if (!root.entries.length) return `<p class="sw-ws-note">${t('工作区还是空的。上传一个文件，或者让 Bot 写点什么。')}</p>`
  return `<ul class="sw-ws-tree">${wsRows('', 0)}</ul>`
}

/**
 * 行末那颗删除。
 *
 * **必须是行那颗按钮的兄弟，不能画在它里面**：整行本身就是一颗 `<button>`（点开预览
 * 或者展开目录），按钮套按钮是非法 HTML，浏览器会把里层那颗拎出去——真出来的 DOM 里
 * 它就不在行里了，点谁都是外面那一下。所以行和它并排装在 `.sw-ws-item` 里。
 *
 * 平时透明，鼠标移到这一行上（或者键盘 tab 到它）才现身：右栏本来就窄，几十行各挂一颗
 * 红图标，人第一眼看到的会是一排删除，而不是自己的文件。**位置常占着**——不占位的话
 * 鼠标一进来整行的名字就被挤短一截，读到一半的文件名会跳。
 */
function wsDelBtn(e) {
  const label = e.dir
    ? t('删掉这个文件夹', 'Delete this folder')
    : t('删掉这个文件', 'Delete this file')
  return `<button type="button" class="btn btn-ghost btn-icon sw-ws-del" data-act="ws-del"
    data-path="${esc(e.path)}" data-name="${esc(e.name)}" data-dir="${e.dir ? '1' : ''}"
    aria-label="${esc(label)}" title="${esc(label)}">${svg(WS_TRASH, 14)}</button>`
}

/** 一层的行。展开的目录把下一层接在自己后面，靠左边距表示深度。 */
function wsRows(key, depth) {
  const dir = wsDirs()[key] || {}
  const out = []
  for (const e of dir.entries || []) {
    const open = Boolean((state.wsOpen || {})[e.path])
    if (e.dir) {
      out.push(
        `<li><div class="sw-ws-item"><button type="button" class="sw-ws-row" data-act="ws-dir" data-path="${esc(e.path)}"
          style="padding-left: ${8 + depth * 12}px" aria-expanded="${open}" title="${esc(e.path)}">
          <span class="sw-ws-caret">${svg(open ? CHEVRON_SMALL_DOWN : CHEVRON_SMALL_RIGHT, 12)}</span>
          <span class="sw-ws-name">${esc(e.name)}</span>
        </button>${wsDelBtn(e)}</div></li>`,
      )
      if (open) out.push(wsRows(e.path, depth + 1))
      continue
    }
    // 文件点开走的是**和对话里那些药丸同一个预览**——同一个工作区、同一份字节。
    out.push(
      `<li><div class="sw-ws-item"><button type="button" class="sw-ws-row sw-ws-file" data-act="chat-preview"
        data-path="${esc(e.path)}" data-name="${esc(e.name)}"
        style="padding-left: ${8 + depth * 12}px" title="${esc(e.path)}">
        <span class="sw-ws-caret">${ICON_FILE}</span>
        <span class="sw-ws-name">${esc(e.name)}</span>
        <small>${esc(fileSize(e.size))}</small>
      </button>${wsDelBtn(e)}</div></li>`,
    )
  }
  if (dir.loading && !out.length) out.push(`<li><p class="sw-ws-note" style="padding-left: ${8 + depth * 12}px">${t('载入中…')}</p></li>`)
  if (dir.error) out.push(`<li><p class="sw-ws-note sw-ws-err" style="padding-left: ${8 + depth * 12}px">${esc(dir.error)}</p></li>`)
  // 截断要说出来（见 workspace/index.ts 的 list）：少列几条不说，看的人只会以为
  // 那个文件根本不存在。
  if (dir.more > 0) {
    out.push(
      `<li><p class="sw-ws-note" style="padding-left: ${8 + depth * 12}px">${esc(
        t('还有 N 条没列出', 'N more not listed').replace('N', String(dir.more)),
      )}</p></li>`,
    )
  }
  return out.join('')
}

/* ── 内嵌桌面 ─────────────────────────────────────────────────────────────
 *
 * 右栏里那块屏是**真的桌面**，不是截图：一个连着席位 noVNC 的 iframe。鼠标移上去
 * 出「打开」，点一下撑成全屏遮罩，键鼠这时才交给它。
 *
 * **iframe 不能画在 #app 里面。** render() 是整页 innerHTML 换掉的，画在里面等于
 * 每重绘一次就重连一次 VNC——发条消息、切个状态，桌面就黑一下。所以它挂在 body 上
 * 的一个常驻层里，位置每次跟着右栏那个空槽（#sw-desk-slot）算出来。全屏也是同一个
 * 层改几何，不重新挂——不然「点开」这个动作本身就会把连接掐断再连一次。
 *
 * 预览态不做 view_only：那是 URL 参数，换它要重载页面。改成在上面盖一层挡片，
 * 点击进不去，键盘也拿不到焦点，代价只有一个 div。
 */

/** 票只有五分钟。挂之前超过这个岁数就先换一张，不然 iframe 一开就是 401。 */
const DESK_TICKET_FRESH_MS = 180_000
/**
 * 看不见多久之后把这块屏拆掉。
 *
 * **为什么要拆，而不是只把它藏起来。** 这个层原来在两种「看不见」下都只改样式：
 * 切到后台标签页只记一个时刻，右栏把它滚出可视区只设 `visibility:hidden`。可两种
 * 情况下 iframe 和它那条 WebSocket 都原封不动，浏览器也不会替我们暂停 WebSocket，
 * 于是像素照收——而这条流是整个系统里最贵的一条：实测 1280×800 下，Bot 一滚页面就是
 * 4 MB/s，静止时才是 0。没人看的时候连着，等于把那 4 MB/s 白扔了。
 *
 * **为什么要等五秒。** 重挂要付一个整屏首帧（q6 下 242 KB）加大约一秒黑屏。滚过去
 * 又滚回来是很常见的动作，立刻拆会让人看见一串黑屏。五秒足够把「路过」和「不看了」
 * 分开；而只要那五秒里屏幕在动，省下的字节已经远超首帧那一次。
 */
const DESK_IDLE_MS = 5000
/** 当前挂着的是哪个席位、用的哪个地址。**地址变了也要重挂**——见 syncDesktop。 */
let deskMounted = null
let deskMounting = false
let deskSlotSeen = null
let deskObserver = null
let deskPlacePending = false
/**
 * 因为没人看而主动拆掉时记在这儿：`null` = 没挂起，`{ full }` = 挂起了，且记着拆之前
 * 是不是全屏态。
 *
 * **必须自己记 full。** `unmountDesktop()` 会把 `state.deskFull` 清成 false（收起桌面
 * 本来就该退出全屏），而这里的拆是「人不在看」而不是「人收起了」——回来时得还原成
 * 他离开时的样子。mountDesktop 读的是 `state.deskFull`，所以解挂起要先把它写回去。
 */
let deskSuspended = null
let deskSuspendTimer = null
/** 页面被切到后台的时刻。回来得太晚就重挂，因为票早过期了，noVNC 自己连不回来。 */
let deskHiddenAt = 0

function deskCaption() {
  const name = (chatBotOf() || {}).name || t('这个 Bot')
  return localeMode === 'en' ? `${name}'s screen` : `${name} 的桌面`
}

/**
 * 这个地址能不能内嵌。
 *
 * 桌面地址现在只有席位机器的绝对地址一种（`https://m001…/seats/<席位>/vnc/`，Gateway
 * 不再反代）。它挡的那个失败**没有声音**：页面是 https、机器只配了 http 地址的时候，
 * iframe 被浏览器按混合内容拦掉，什么都不显示，控制台以外看不出所以然。这里退回
 * 「打开桌面」那颗按钮（新标签页是顶层导航，不受混合内容限制），比留一块黑屏强。
 */
function deskEmbeddable(url) {
  if (!url) return false
  return !(location.protocol === 'https:' && /^http:/i.test(url))
}

/**
 * 这个桌面地址和当前页跨不跨源。
 *
 * 只有一个用处：决定 iframe 的 sandbox 里加不加 `allow-same-origin`（见 mountDesktop
 * 里那段长注释——这一条判错就是把父页的登录 JWT 交出去）。
 *
 * 现在的地址一律是席位机器的绝对地址（`https://m001…`，直连），正常都返回 true；
 * Gateway 同域反代那条路（`/desktop/…`）已经没有了。**但判据仍然只能是地址本身**，
 * 不能写死 true：万一哪天又有同源的桌面地址（本地壳子、开发环境），写死就是把
 * allow-same-origin 加到同源的框上。**解析不出来一律当同源**：那是更严的那一边，
 * 宁可让一个本该直连的框连不上，也不能给一个同源的框开 allow-same-origin。
 */
function deskCrossOrigin(url) {
  try {
    return new URL(url, location.href).origin !== location.origin
  } catch {
    return false
  }
}

/** 内嵌用的地址：按预览尺寸缩放，别把桌面裁成左上角一小块。 */
function deskUrl() {
  const rt = state.desktopRuntime
  // novncUrl 是 null 就是「这台机器没有桌面可开」（没配直连地址），右栏另有一句话说明。
  if (!rt || rt.status !== 'ready' || !rt.novncUrl || !deskEmbeddable(rt.novncUrl)) return ''
  const abs = rt.novncUrl
  return abs + (abs.includes('?') ? '&' : '?') + 'resize=scale&reconnect=1&bell=false'
}

const DESK_EXPAND = ['M15 3h6v6', 'M9 21H3v-6', 'M21 3l-7 7', 'M3 21l7-7']
const DESK_SHRINK = ['M9 3v6H3', 'M15 21v-6h6', 'M3 9l7-7', 'M21 15l-7 7']

function deskLayer() {
  return document.getElementById('sw-deskl')
}

function unmountDesktop() {
  const layer = deskLayer()
  if (layer) layer.remove()
  const back = document.getElementById('sw-deskb')
  if (back) back.remove()
  if (deskObserver) {
    deskObserver.disconnect()
    deskObserver = null
  }
  deskSlotSeen = null
  deskMounted = null
  state.deskFull = false
}

function mountDesktop(url, seatId) {
  // 换一块屏不等于收起这块屏：重连时人可能正开着全屏，unmountDesktop 会把它清掉。
  const wasFull = state.deskFull
  unmountDesktop()
  const back = document.createElement('div')
  back.id = 'sw-deskb'
  back.className = 'sw-deskb'
  back.addEventListener('click', () => setDeskFull(false))
  const layer = document.createElement('div')
  layer.id = 'sw-deskl'
  layer.className = 'sw-deskl'
  /**
   * `sandbox` 不能省。框进来的是席位自己供的页面，没有沙箱它就能 `top.location = …`
   * 把整个 Gateway 界面换掉——原来那颗「打开桌面」是新标签页加 `rel=noopener`，没这
   * 条路；一内嵌就有了。
   *
   * **`allow-same-origin` 按地址跨不跨源来给，这一条判错就是一个漏洞。**
   *
   * · 现在的桌面地址一律是席位机器直连（`https://m001…/seats/<席位>/vnc/`，绝对地址），
   *   框和父页**本来就不同源**，加了也读不到父页的任何东西——而不加的话框是 opaque
   *   源，管家那张 path 限定的 cookie 带不上，noVNC 的静态资源和 WebSocket 一律 401。
   *   同一个可注册域下 SameSite=Lax 在子框里是放行的（SameSite 判的是 site 不是
   *   origin），所以这条路上加回来既安全又必要。
   * · Gateway 同域反代那条路（`/desktop/:seatId/…`，相对地址）**已经没有了**，但它当年
   *   立下的规矩还在：同源的框绝不能加 allow-same-origin——那等于没有沙箱，框里那页
   *   （席位自己供的 noVNC）能直接读父页的 sessionStorage，登录 JWT 就躺在里面。
   *
   * 判据只能是**这个 url 到底跨不跨源**，不能是「桌面只剩直连了」之类的旁证：万一
   * 哪天又出现一条同源的桌面地址，错的方向恰好是把 allow-same-origin 加到同源的框上。
   *
   * `allow-forms` 是留给「票里没带口令」时那个登录框的。
   */
  const sandbox = 'allow-scripts allow-forms' + (deskCrossOrigin(url) ? ' allow-same-origin' : '')
  layer.innerHTML = `
    <iframe class="sw-deskl-frame" title="${esc(t('桌面'))}" tabindex="-1"
      sandbox="${sandbox}" allow="clipboard-read; clipboard-write"></iframe>
    <button type="button" class="sw-deskl-shield" data-desk="open">
      <span class="sw-deskl-open">${svg(DESK_EXPAND, 15)}${esc(t('打开'))}</span>
    </button>
    <div class="sw-deskl-bar">
      <span class="sw-deskl-title"></span>
      <span class="sw-deskl-acts">
        <button type="button" class="sw-deskl-btn" data-desk="reload">${esc(t('重连'))}</button>
        <button type="button" class="btn btn-ghost btn-icon sw-deskl-close" data-desk="close"
          aria-label="${esc(t('收起桌面'))}" title="${esc(t('收起桌面'))}">${svg(DESK_SHRINK, 16)}</button>
      </span>
    </div>`
  layer.addEventListener('click', (e) => {
    const hit = e.target instanceof Element ? e.target.closest('[data-desk]') : null
    if (!hit) return
    const act = hit.getAttribute('data-desk')
    if (act === 'reload') void remountDesktop(true)
    else setDeskFull(act === 'open')
  })
  document.body.appendChild(back)
  document.body.appendChild(layer)
  // src 最后给：DOM 先进树，iframe 才只加载一次。
  layer.querySelector('.sw-deskl-frame').src = url
  deskMounted = { seat: seatId, url }
  state.deskFull = wasFull
}

/** 预览 ⇄ 全屏。几何变化加一段过渡，拖右栏宽度时不加——那是每帧都在动的。 */
function setDeskFull(on) {
  const layer = deskLayer()
  if (!layer || state.deskFull === on) return
  state.deskFull = on
  layer.style.transition = 'top .22s ease, left .22s ease, width .22s ease, height .22s ease, border-radius .22s ease'
  clearTimeout(setDeskFull.timer)
  setDeskFull.timer = setTimeout(() => {
    layer.style.transition = ''
  }, 260)
  syncDesktop()
  if (on) {
    const frame = layer.querySelector('.sw-deskl-frame')
    // 焦点交给 iframe，键盘才进得去桌面。noVNC 会自己抓键盘。
    if (frame) setTimeout(() => frame.focus(), 240)
  }
}

/**
 * 这块预览此刻**有没有人在看**。
 *
 * 三种「看不见」：标签页在后台、槽位不在（人已经不在对话页上了）、右栏把它滚出了
 * 可视区。全屏态盖在整个视口上，右栏那一刀裁不到它，所以单独放行。
 *
 * 判右栏那一刀用的是和 placeDesktop 里同一套算法——那边算出来是设 `visibility`，
 * 这边算出来是决定拆不拆。两处必须一致，否则会出现「看着是空的，但连接还在」。
 */
function deskVisibleNow() {
  if (document.hidden) return false
  const slot = document.getElementById('sw-desk-slot')
  if (!slot) return false
  if (deskSuspended ? deskSuspended.full : state.deskFull) return true
  const r = slot.getBoundingClientRect()
  if (!r.height) return false
  const body = slot.closest('.gw-aside-body')
  if (!body) return true
  const b = body.getBoundingClientRect()
  const top = Math.max(0, b.top - r.top)
  const bottom = Math.max(0, r.bottom - b.bottom)
  return top + bottom < r.height
}

/**
 * 看不见就起一个倒计时，到点把屏拆掉；重新看得见就取消倒计时、并把它接回来。
 *
 * 挂在滚动/尺寸变化和 visibilitychange 上。**解挂起走的是 syncDesktop**，不在这里
 * 直接 mount：换票、地址比对、观察器换绑那一串都在它那儿，这里再写一遍迟早会漂。
 */
function scheduleDeskSuspend() {
  if (deskVisibleNow()) {
    if (deskSuspendTimer) {
      clearTimeout(deskSuspendTimer)
      deskSuspendTimer = null
    }
    if (deskSuspended) syncDesktop()
    return
  }
  if (deskSuspended || deskSuspendTimer || !deskMounted) return
  deskSuspendTimer = setTimeout(() => {
    deskSuspendTimer = null
    // 这五秒里人可能又滚回来了，也可能整块屏已经因为别的原因没了。
    if (deskVisibleNow() || !deskMounted) return
    const full = !!state.deskFull
    unmountDesktop()
    deskSuspended = { full }
  }, DESK_IDLE_MS)
}

/**
 * 把常驻层对齐到右栏那个空槽上，顺带管挂载与卸载。render() 之后、以及右栏尺寸或
 * 滚动变化时都要调一次。
 */
function syncDesktop() {
  const slot = document.getElementById('sw-desk-slot')
  const url = deskUrl()
  const seatId = (state.desktopRuntime && state.desktopRuntime.seatId) || ''
  if (!slot || !url) {
    if (deskMounted) unmountDesktop()
    // 离开对话页 / 这块屏没了：挂起状态跟着作废。留着的话，下次回到这一页会被
    // 下面那条 `if (deskSuspended)` 挡住，而那时候未必有滚动事件来把它叫醒。
    deskSuspended = null
    if (deskSuspendTimer) {
      clearTimeout(deskSuspendTimer)
      deskSuspendTimer = null
    }
    return
  }
  /**
   * 挂起期间不重挂——但**每次都重新判一遍**，不能无条件 return。
   *
   * 回到对话页是 render() 调这里，不是滚动事件；那一刻 scheduleDeskSuspend 不一定
   * 会被调到，无条件 return 的话这块屏就再也回不来了。
   */
  if (deskSuspended) {
    if (!deskVisibleNow()) return
    state.deskFull = deskSuspended.full
    deskSuspended = null
  }
  // **地址也要比，不只是席位。** 重新部署之后席位 id 一个字都没变，变的是票；只比
  // 席位的话，那张新票永远用不上，屏上留着的是重装前那条已经死掉的连接。
  if (!deskMounted || deskMounted.seat !== seatId || deskMounted.url !== url) {
    void remountDesktop()
    return
  }
  if (slot !== deskSlotSeen) {
    // 整页重绘换了个新的槽元素：观察器要跟着换过去。
    deskSlotSeen = slot
    if (deskObserver) deskObserver.disconnect()
    if (typeof ResizeObserver === 'function') {
      deskObserver = new ResizeObserver(() => placeSoon())
      deskObserver.observe(slot)
    }
  }
  placeDesktop()
}

/**
 * 票过期了就先换一张再挂。
 *
 * 五分钟的票进了 iframe 的路径（不再是 cookie，见 gateway/src/desktop.ts），连上之后
 * WebSocket 一直活着；但 iframe **重新加载**的那一刻要重新验票，票馊了就是一页 401。
 *
 * `force` 是「重连」那颗按钮走的路：不管票看着新不新都换一张。掉过一次线之后
 * noVNC 自己重连不回来——它路径里那张票早过期了，升级请求一律 401——
 * 所以人得有一个确定能把它救回来的动作。
 */
async function remountDesktop(force = false) {
  if (deskMounting) return
  deskMounting = true
  try {
    const want = chatBotIdNow()
    if (force || Date.now() - (state.desktopRuntimeAt || 0) > DESK_TICKET_FRESH_MS) {
      await loadDesktopRuntime(want)
      // 等票的这段时间里人切了 Bot：这一轮作废，新的那个 Bot 自己会触发一次。
      if (chatBotIdNow() !== want) return
    }
    const url = deskUrl()
    const slot = document.getElementById('sw-desk-slot')
    if (!url || !slot) {
      unmountDesktop()
      return
    }
    mountDesktop(url, (state.desktopRuntime && state.desktopRuntime.seatId) || '')
    deskSlotSeen = null
  } finally {
    deskMounting = false
  }
  syncDesktop()
  /**
   * **刚挂上就得判一次「有没有人在看」。**
   *
   * 挂起那套原本只挂在滚动/尺寸变化和 visibilitychange 上，而那三样都是**变化**。
   * 「挂上的那一刻就已经不可见」不产生任何变化，于是一条谁也没在看的流会一直开着：
   * 人把对话页留在后台标签页里、席位这时才部署完，SSE 触发 render() 就会走到这儿把
   * 屏挂上——后台标签页不再有 visibilitychange 转换，也不产生 scroll/resize，那条流
   * 一直开到人回来为止。右栏早就滚过预览位置、席位之后才 ready 是同一回事。
   */
  scheduleDeskSuspend()
}

function placeDesktop() {
  const layer = deskLayer()
  const back = document.getElementById('sw-deskb')
  if (!layer) return
  layer.classList.toggle('is-full', !!state.deskFull)
  if (back) back.classList.toggle('is-on', !!state.deskFull)
  const title = layer.querySelector('.sw-deskl-title')
  if (title) title.textContent = deskCaption()
  // 挡片只挡得住鼠标。iframe 本身还在 Tab 序里，键盘一路 Tab 过去就进了那块两百
  // 像素宽的预览，之后敲的每个字都送进了真桌面。预览态直接把它从 Tab 序里摘掉。
  const frame = layer.querySelector('.sw-deskl-frame')
  if (frame) {
    if (state.deskFull) frame.removeAttribute('tabindex')
    else frame.setAttribute('tabindex', '-1')
  }
  if (state.deskFull) {
    const vw = window.innerWidth || 0
    const vh = window.innerHeight || 0
    const pad = Math.round(Math.min(vw, vh) * 0.035)
    layer.style.top = pad + 'px'
    layer.style.left = pad + 'px'
    layer.style.width = vw - pad * 2 + 'px'
    layer.style.height = vh - pad * 2 + 'px'
    layer.style.clipPath = ''
    layer.style.visibility = ''
    return
  }
  const slot = document.getElementById('sw-desk-slot')
  if (!slot) {
    unmountDesktop()
    return
  }
  const r = slot.getBoundingClientRect()
  layer.style.top = r.top + 'px'
  layer.style.left = r.left + 'px'
  layer.style.width = r.width + 'px'
  layer.style.height = r.height + 'px'
  // 层是 fixed 的，不受右栏的 overflow 裁剪——右栏一滚，它会浮到别的东西上面去。
  // 自己按右栏可视区裁一刀。
  const body = slot.closest('.gw-aside-body')
  if (!body || !r.height) {
    layer.style.clipPath = ''
    layer.style.visibility = r.height ? '' : 'hidden'
    return
  }
  const b = body.getBoundingClientRect()
  const top = Math.max(0, b.top - r.top)
  const bottom = Math.max(0, r.bottom - b.bottom)
  layer.style.visibility = top + bottom >= r.height ? 'hidden' : ''
  layer.style.clipPath = `inset(${top}px 0px ${bottom}px 0px round 10px)`
}

/**
 * 一帧最多重排一次。
 *
 * 下面那个 scroll 是捕获阶段挂在 window 上的——消息流每吐一段就自动跟随一次，那些
 * 滚动全从这儿过。直接调 placeDesktop 的话，每一次都要量两个 getBoundingClientRect
 * 再写六条内联样式，等于在流式输出最吃帧的时候反复强制同步布局。
 */
function placeSoon() {
  if (deskPlacePending) return
  if (typeof requestAnimationFrame !== 'function') {
    scheduleDeskSuspend()
    placeDesktop()
    return
  }
  deskPlacePending = true
  requestAnimationFrame(() => {
    deskPlacePending = false
    // **先判挂起，再摆位置。** 挂起期间层已经不在了，placeDesktop 第一行就 return，
    // 光靠它把不回来——接回来这件事只能由 scheduleDeskSuspend 发起。
    scheduleDeskSuspend()
    placeDesktop()
  })
}

// 窗口尺寸、右栏滚动都会挪动那个槽。滚动用捕获，因为滚的是右栏自己而不是 window。
window.addEventListener('resize', placeSoon)
window.addEventListener('scroll', placeSoon, true)
/**
 * 回到前台时，离开得够久就重挂。
 *
 * 合盖、切标签页几十分钟回来，那条 WebSocket 基本已经断了，而 noVNC 的自动重连注定
 * 失败——cookie 里那张票只活五分钟。这时候重挂的代价是一秒钟的黑屏，不重挂的代价是
 * 一块永远回不来的死屏。
 */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    deskHiddenAt = Date.now()
    // 切到后台就开始倒计时拆屏。浏览器不会替我们暂停那条 WebSocket，不拆就是在
    // 一个没人看的标签页里继续收像素。
    scheduleDeskSuspend()
    return
  }
  const away = deskHiddenAt ? Date.now() - deskHiddenAt : 0
  deskHiddenAt = 0
  // 回到前台：挂起了就在这儿接回来（syncDesktop 会按票的岁数决定要不要先换票）。
  scheduleDeskSuspend()
  if (deskMounted && away > DESK_TICKET_FRESH_MS) void remountDesktop(true)
  /**
   * 那条聊天流也要认一遍。
   *
   * 后台标签页里 setTimeout 会被节流到分钟级，退避重试因此更容易走到头；而合盖一小时
   * 回来，中间那一跳早把连接掐了。回到前台是「人马上要看这一屏」的时刻，没人在听就
   * 当场接回来——带 after 游标，睡着那段时间的回复会一起补上。
   */
  if (state.chatSessionId) reviveChatStream(state.chatSessionId, state.chatBotId)
  // 会话本身都还没拿到（那条重试链在后台被节流着走完了、认输了）：也在这儿再试一次。
  // 不然人回到这一页看到的是一句「实例还没接上」，而没有任何人在替他重试。
  //
  // **只在对话页上做。** state.chatBotId 在人走开之后仍然留着（切走不掐流，见
  // ensureChatSession），拿它在别的页上重试的话：白敲一串接口不说，那条链认输时会
  // render() 整页——正在填的表单当场被换掉，而起因是一个他此刻根本没在看的 Bot。
  else if (state.chatBotId && isChatPath(state.path)) void ensureChatSession(state.chatBotId).catch(() => {})
})
window.addEventListener('keydown', (e) => {
  // 焦点在 iframe 里时这一条收不到（noVNC 把键盘抓走了），所以标题栏那颗收起按钮
  // 必须一直看得见——Esc 只是顺手。
  if (e.key === 'Escape' && state.deskFull) setDeskFull(false)
})

/**
 * 运行日志。
 *
 * 没有 SSH 的时候，「bot 到底卡在哪一步」谁也看不见——诊断快照能说「它活着」，
 * 说不了「它在干什么」。而这一层最贵的故障恰恰都不报错：单元 active、端口有人听，
 * 只是那一轮永远不结束。
 *
 * 走 SSE，和聊天一条路子。机器票留在 Gateway，浏览器只带自己的席位票；日志在管家
 * 那侧就过了脱敏（席位票、API key、VNC 口令一律盖掉）。
 */
const LOG_MAX = 2000
let logAbort = null

function stopLogStream() {
  if (logAbort) {
    try {
      logAbort.abort()
    } catch {}
  }
  logAbort = null
}

/**
 * 开一条日志流。`source` 是面板清单里的那一项：`{ key, label, direct }`，direct 是
 * Gateway 上**领票**的地址（/runtime/logs/direct?botId=… 或 /platform/…/logs/direct）。
 *
 * 两步走：先 api('GET', direct) 拿 `{ url, ticket }`——url 是机器管家上的 /logs 或
 * /seats/<id>/logs，ticket 是一张 5 分钟的票；再拿这张票**直接打那台机器**。Gateway
 * 不再替浏览器转这条 SSE（老的 ?follow=1 那条路已经 410）：它是跟对话流一样的长连接，
 * Gateway 要做成无状态的，长连接一条都不能留在它身上。
 *
 * 用的是裸 fetch 而不是 swFetch：地址是绝对的、票也不是登录票，本地改道那套逻辑
 * 一条都不适用。机器没配 directUrl、或管家太旧，领票那一步就会 409 带中文原因，
 * 原样摆进面板——和以前「连不上」摆在同一个位置。
 */
async function startLogStream(source) {
  stopLogStream()
  const ac = new AbortController()
  logAbort = ac
  state.logLines = []
  state.logError = ''
  paintLogs()
  const direct = source && typeof source === 'object' ? source.direct : source
  let ticket
  try {
    ticket = await api('GET', direct)
  } catch (err) {
    if (!ac.signal.aborted) {
      state.logError = (err && err.message) || t('拿不到日志')
      paintLogs()
    }
    return
  }
  // 领票那一趟是 await 的，人可能在这期间已经关了面板或换了来源。
  if (ac.signal.aborted) return
  if (!ticket || !ticket.url || !ticket.ticket) {
    state.logError = t('拿不到日志')
    paintLogs()
    return
  }
  let res
  try {
    res = await fetch(ticket.url + '?lines=300&follow=1', {
      headers: { accept: 'text/event-stream', authorization: 'Bearer ' + ticket.ticket },
      signal: ac.signal,
    })
  } catch {
    if (!ac.signal.aborted) {
      state.logError = t('连不上机器管家')
      paintLogs()
    }
    return
  }
  if (!res.ok || !res.body) {
    state.logError = (await res.text().catch(() => '')) || t('拿不到日志')
    paintLogs()
    return
  }
  try {
    for await (const ev of sseEvents(res.body.getReader(), () => ac.signal.aborted)) {
      // 同 startRosterStream：中止后仍在路上的那一块不该再画进面板。
      if (ac.signal.aborted) break
      try {
        if (ev.error) state.logError = String(ev.error)
        else if (typeof ev.line === 'string') state.logLines.push(ev.line)
      } catch {}
      // 不封顶的话，一个话多的 bot 能把标签页吃垮。
      //
      // 封顶和重绘从「每帧一次」改成了「每条一次」：两件事都幂等，而重绘本来就靠
      // scheduleLogPaint 合并到一个动画帧，多问几次不会多画一次。
      if (state.logLines.length > LOG_MAX) state.logLines.splice(0, state.logLines.length - LOG_MAX)
      scheduleLogPaint()
    }
  } catch {
    /* 关面板 / 断线 */
  }
  if (logAbort === ac) logAbort = null
}

let logPaintQueued = false

/** 和正文一样合并到一帧：日志可以刷得很快，一行一次重绘顶不住。 */
function scheduleLogPaint() {
  if (logPaintQueued) return
  logPaintQueued = true
  const run = () => {
    logPaintQueued = false
    paintLogs()
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
  else setTimeout(run, 16)
}

function paintLogs() {
  const box = document.getElementById('log-body')
  if (!box) return
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight <= 60
  box.textContent = state.logError
    ? state.logError
    : state.logLines.length
      ? state.logLines.join('\n')
      : t('还没有日志')
  if (stick) box.scrollTop = box.scrollHeight
}

/**
 * 日志面板。一个面板管两处：
 *   · 员工侧的运行环境——只有自己这个 Bot 一个来源；
 *   · 平台侧公司详情的运行机器——管家自己，加上这台机器上的每个席位。
 *
 * state.logsOpen = { title, active, sources: [{ key, label, direct }] }
 * direct 是领票的 Gateway 地址，不是日志地址——见 startLogStream。
 */
/** 开面板并接上第一个来源。两处入口都走它，别各写一份。 */
function openLogs(title, sources) {
  state.logsOpen = { title, sources, active: sources[0] && sources[0].key }
  state.logLines = []
  state.logError = ''
  render()
  // 先 render 再开流：paintLogs 往 #log-body 里填，那个节点得先存在。
  if (sources[0]) void startLogStream(sources[0])
}

function switchLogSource(key) {
  const box = state.logsOpen
  if (!box) return
  const hit = (box.sources || []).find((x) => x.key === key)
  if (!hit || key === box.active) return
  stopLogStream()
  box.active = key
  state.logLines = []
  state.logError = ''
  render()
  // 每换一个来源都重新领票：票是按 seat 签的，换来源就是换票。
  void startLogStream(hit)
}

/**
 * 打开一个工作区文件的预览。
 *
 * **先取成 blob 再显示**，而不是把 URL 直接给 <img src>：Gateway 认 Authorization 头，
 * 而 src= 发出去的请求带不了头。顺带还有个好处——blob: 是 opaque origin，即使哪天
 * 白名单放进了带脚本的类型，它也够不着 Gateway 这一侧的登录态。
 *
 * 大文件不预览：整个读进内存只为看一眼不值当，给下载就行。判断用响应头里的
 * content-length，在读 body **之前**——否则「太大所以不看」的代价是先下完它。
 */
/**
 * 文本类的扩展名。这几种取回来直接当文字看，比塞进 iframe 强——iframe 里的纯文本
 * 不会换行、没有主题色、也没法选中复制成一段。
 */
const PREVIEW_TEXT_EXT = new Set([
  'txt', 'log', 'csv', 'tsv', 'json', 'yml', 'yaml', 'xml', 'ini', 'toml', 'conf',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'sh', 'bash', 'zsh', 'py',
  'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'sql', 'env', 'gitignore', 'diff', 'patch',
])

/** 这几种在浏览器里没有原生渲染，得靠席位那边先提取成文本（见 fetchDocText）。 */
const PREVIEW_DOC_EXT = new Set(['docx', 'xlsx', 'xlsm', 'pptx'])

function extOf(name) {
  const base = String(name || '').split('/').pop() || ''
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}

/**
 * 这个文件用哪种方式看。
 *
 * **按扩展名判，不按 content-type**：席位那边对不在内联白名单里的一律回
 * `application/octet-stream`（HTML、docx 都是），光看类型什么都分不出来。
 */
function previewKindOf(name, type) {
  const ext = extOf(name)
  if (String(type || '').startsWith('image/') || ['png','jpg','jpeg','gif','webp','avif','bmp','ico','svg'].includes(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'html' || ext === 'htm') return 'html'
  if (PREVIEW_TEXT_EXT.has(ext)) return 'text'
  if (PREVIEW_DOC_EXT.has(ext)) return 'doc'
  return ''
}

/** 文本类不该按图片那个尺度收：一份 2MB 的日志已经没人会在弹窗里读了。 */
const PREVIEW_TEXT_MAX = 2 * 1024 * 1024

/**
 * 每轮、每个 HTML 只自动打开一次。人把预览关掉之后，这一轮后续 patch 不能又把它顶回来；
 * 下一轮重新生成同一路径则仍会打开。集合只记最近一小段，避免开几周的标签页只涨不落。
 */
const AUTO_PREVIEW_MAX = 200
const autoPreviewed = new Set()

function rememberAutoPreview(key) {
  autoPreviewed.add(key)
  while (autoPreviewed.size > AUTO_PREVIEW_MAX) autoPreviewed.delete(autoPreviewed.values().next().value)
}

/** 实时产出 HTML 时自动打开；已经打开的任意产出文件被再次写入时自动重载。 */
function maybeLivePreview(event) {
  if (!event || event.type !== 'tool/result' || !state.chatSessionId) return false
  const data = event.data || {}
  const files = Array.isArray(data.files) ? data.files.filter((file) => file && file.path) : []
  if (!files.length) return false
  const current = state.preview
  if (current) {
    const changed = files.find((file) => file.path === current.path)
    if (!changed) return false
    void openPreview(changed.path, changed.name || current.name || changed.path, { mode: current.mode })
    return true
  }
  const html = files.find((file) => previewKindOf(file.name || file.path, '') === 'html')
  if (!html) return false
  const key = `${state.chatSessionId}:${Number(data.turn) || 0}:${html.path}`
  if (autoPreviewed.has(key)) return false
  rememberAutoPreview(key)
  void openPreview(html.path, html.name || html.path)
  return true
}

async function openPreview(path, name, options = {}) {
  if (!state.chatSessionId) return
  revokePreview()
  const kind = previewKindOf(name || path, '')
  const mode = options.mode === 'source' ? 'source' : 'view'
  state.preview = { path, name, loading: true, url: '', type: '', size: 0, error: '', kind, mode }
  render()
  const url = '/runtime/sessions/' + encodeURIComponent(state.chatSessionId) + '/files?path=' + encodeURIComponent(path)
  const ac = new AbortController()
  state.preview.abort = ac
  try {
    const res = await swFetch(url, { headers: authHeaders(), signal: ac.signal })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let json = null
      try {
        json = text ? JSON.parse(text) : null
      } catch {}
      throw new Error(errText((json && json.error) || 'HTTP ' + res.status))
    }
    const type = (res.headers.get('content-type') || '').split(';')[0].trim()
    const size = Number(res.headers.get('content-length') || 0)
    const k = kind || previewKindOf(name || path, type)
    const cap = k === 'markdown' || k === 'html' || k === 'text' ? PREVIEW_TEXT_MAX : CHAT_PREVIEW_MAX
    /**
     * **不再拿 content-disposition 当「能不能看」的判据。**
     *
     * 席位那张白名单回答的是「这段字节能不能带着自己的 MIME 在浏览器里跑起来」——
     * HTML 不在里面，理由是它带得动 `<script>`，内联渲染等于让上传者在 Gateway 的源
     * 上执行代码。那个理由是对的，白名单不动。
     *
     * 但**我们并不是让它在 Gateway 的源上跑**：字节取回来变成 blob，塞进一个
     * `sandbox` 不带任何 allow-* 的 iframe——脚本、表单、同源、导航全关，里面的
     * `<script>` 一行都不会执行。Gateway 那一跳还压了一条同样含义的 CSP
     * （见 lib/runtime.ts 的 proxyDownload），直接把文件地址粘到地址栏也一样跑不起来。
     *
     * 所以这里改成按**扩展名**决定看法，只有真的没法看的（未知格式）才回落到下载。
     */
    if (!k || (size && size > cap)) {
      ac.abort()
      if (!state.preview || state.preview.path !== path) return
      state.preview = { path, name, loading: false, url: '', type, size, error: '', kind: k, mode, tooBig: true }
      render()
      return
    }
    if (k === 'doc') {
      const blob = await res.blob()
      if (!state.preview || state.preview.path !== path) return
      state.preview = { path, name, loading: false, url: '', type, size: blob.size, error: '', kind: k, mode, docLoading: true }
      render()
      void fetchDocText(path, name)
      return
    }
    const blob = await res.blob()
    if (!state.preview || state.preview.path !== path) return
    const next = { path, name, loading: false, url: '', type, size: blob.size, error: '', kind: k, mode }
    if (k === 'markdown' || k === 'html' || k === 'text') {
      next.text = await blob.text()
      // HTML 要一个**自称 text/html** 的 blob，iframe 才会当页面渲染。原始响应是
      // octet-stream（白名单没放行它），照搬只会得到一个下载。重打类型是安全的：
      // 保护来自 iframe 的 sandbox，不来自这个 MIME。
      // **charset 不能省。** 这个 blob 是从 JS 字符串造的，就是 UTF-8；不写的话浏览器
      // 会按自己的默认编码猜，中文当场变成一片乱码（实测就是这样）。
      if (k === 'html') next.url = URL.createObjectURL(new Blob([next.text], { type: 'text/html; charset=utf-8' }))
    } else if (k === 'pdf') {
      // **类型钉死。** 下面那个 iframe 不带 sandbox（不带才有 PDF 阅读器，见
      // previewBody），所以绝不能让这段字节有机会被当成 HTML 解释。blob 的 type
      // 就是浏览器认的 Content-Type：写死 application/pdf，一个改名成 .pdf 的
      // HTML 只会交给 PDF 阅读器然后解析失败，而不是变成一个页面跑起来。
      next.url = URL.createObjectURL(new Blob([await blob.arrayBuffer()], { type: 'application/pdf' }))
    } else {
      next.url = URL.createObjectURL(blob)
    }
    state.preview = next
  } catch (err) {
    if (ac.signal.aborted) return
    if (!state.preview || state.preview.path !== path) return
    state.preview = { path, name, loading: false, url: '', type: '', size: 0, error: err.message, kind, mode }
  }
  render()
  // 刚画出来的 Markdown 里可能有代码块 / 公式 / mermaid，和聊天气泡一样要过一遍。
  if (state.preview && state.preview.kind === 'markdown' && window.satuMd) {
    const host = document.querySelector('.sw-preview-md')
    if (host) window.satuMd.enhance(host)
  }
}

/**
 * Word / Excel / PPT：浏览器打不开，让席位提取成 Markdown 再看。
 *
 * 走的是 `read` 工具用的同一套提取（bot 的 workspace/extract.ts），所以这里看到的
 * 和模型读到的是同一份东西——这一点本身就有用：内容对不上时能一眼看出是提取的问题
 * 还是模型的问题。
 *
 * **老席位没有这个接口**，那时候如实退回「下载下来看吧」，而不是转个圈就空在那儿。
 */
async function fetchDocText(path, name) {
  const url =
    '/runtime/sessions/' + encodeURIComponent(state.chatSessionId) + '/files?path=' + encodeURIComponent(path) + '&as=text'
  try {
    const res = await swFetch(url, { headers: authHeaders({ accept: 'application/json' }) })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    if (!state.preview || state.preview.path !== path) return
    state.preview.docLoading = false
    state.preview.text = String((data && data.text) || '')
    state.preview.docNote = String((data && data.note) || '')
    if (!state.preview.text) state.preview.tooBig = true
  } catch {
    if (!state.preview || state.preview.path !== path) return
    state.preview.docLoading = false
    state.preview.tooBig = true
    state.preview.docNote = t('这个席位还不支持把 Office 文档提取出来预览（要更新 Bot 版本）。')
  }
  render()
}

/** blob: 的生命周期得自己管——不撤销，这一份就在内存里待到刷新页面为止。 */
function revokePreview() {
  const p = state.preview
  if (!p) return
  if (p.abort) try { p.abort.abort() } catch {}
  if (p.url) setTimeout(() => URL.revokeObjectURL(p.url), 0)
}

function closePreview() {
  revokePreview()
  state.preview = null
  render()
}

/** 直接把工作区里的文件存下来。走 fetch 而不是 <a href>，同样是为了带上票。 */
async function downloadWorkspaceFile(path, name) {
  if (!state.chatSessionId) return
  const url =
    '/runtime/sessions/' + encodeURIComponent(state.chatSessionId) + '/files?path=' + encodeURIComponent(path) + '&download=1'
  try {
    const res = await swFetch(url, { headers: authHeaders() })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const blob = await res.blob()
    const href = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = href
    a.download = name || path.split('/').pop() || 'file'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(href), 1000)
  } catch (err) {
    flash('err', t('下载失败：') + err.message)
  }
}

/** 渲染视图和原文之间的切换。只有两者都成立的类型才给，别摆一颗按不动的按钮。 */
function previewTabs(p) {
  const both = (p.kind === 'markdown' || p.kind === 'html') && !p.tooBig && !p.error && !p.loading
  if (!both) return ''
  const tab = (mode, label) =>
    `<button type="button" class="sw-preview-tab" data-act="preview-mode" data-mode="${mode}"` +
    `${p.mode === mode ? ' data-on="1"' : ''}>${esc(label)}</button>`
  return `<div class="sw-preview-tabs">${tab('view', t('预览'))}${tab('source', t('原文'))}</div>`
}

/**
 * 内容自己加载完之前先转圈。
 *
 * 取字节那一段有 p.loading 管，但**字节到手不等于看得见**：iframe 里的 PDF 阅读器、
 * 大图的解码，都还要一会儿，而那段时间框里是纯白的——和「坏了」长得一模一样。
 *
 * 清除动作写在 `data-onload` / `data-onerror` 上：它随 HTML 字符串走，每次整页重绘
 * 都自动带上。真正执行它的是 shell.js 挂在 document 上的那个捕获监听器——挂在节点
 * 自己身上的话，任何一次无关的 render() 都会把节点换掉、监听丢掉，圈就永远转下去。
 *
 * （这里原来是一个内联的 onload 属性。同样随字符串走、同样不怕重绘，但内联事件处理器
 * 要求 CSP 的 script-src 带 `'unsafe-inline'`，见 mediaFallback 上那段。）
 */
const DONE = 'data-onload="busy-done"'

function busyBox(inner) {
  return `<div class="sw-preview-load" data-busy="1"><span class="sw-preview-spin" aria-hidden="true"></span>${inner}</div>`
}

function spinNote(text) {
  return `<p class="sw-preview-note"><span class="sw-preview-spin" aria-hidden="true"></span>${esc(text)}</p>`
}

function previewBody(p) {
  if (p.loading) return spinNote(t('正在取文件…'))
  if (p.error) return `<p class="sw-preview-note sw-preview-err">${esc(p.error)}</p>`
  if (p.docLoading) return spinNote(t('正在提取文档内容…'))
  if (p.tooBig) {
    const why = p.docNote || t('这个文件不适合在浏览器里打开（太大，或者是不认识的格式）。下载下来看吧。')
    return `<p class="sw-preview-note">${esc(why)}</p>`
  }
  if (p.kind === 'image') {
    return busyBox(
      `<img class="sw-preview-img" src="${esc(p.url)}" alt="${esc(p.name)}" ` +
        `${DONE} data-onerror="busy-done">`,
    )
  }
  if (p.kind === 'pdf') {
    /**
     * PDF 交给浏览器自带的阅读器，**这个 iframe 不能带 sandbox**。
     *
     * 带上就是一片白：sandbox 的 opaque origin 会把 PDF 阅读器整个挡掉，页面根本
     * 起不来。这不是新问题，之前一直是这么写的——只是没人点过 PDF。实测对照过
     * `sandbox=""` / 无 sandbox / `<embed>` 三种，只有不带 sandbox 的那两种能起阅读器。
     *
     * 去掉它安全吗：安全，因为**类型是钉死的**。上面 openPreview 把这段字节重新包成
     * 了 `application/pdf` 的 blob，浏览器只会把它交给 PDF 阅读器，没有任何路径能让它
     * 被当成 HTML 解释——而 sandbox 在这里防的正是「HTML 跑起脚本」。
     */
    return busyBox(`<iframe class="sw-preview-frame" src="${esc(p.url)}" title="${esc(p.name)}" ${DONE}></iframe>`)
  }
  if (p.kind === 'html' && p.mode === 'view') {
    /**
     * **`sandbox` 一个 allow-* 都不能加。** 这是让 HTML 能被预览的全部依据：没有
     * allow-scripts 就没有脚本执行，没有 allow-same-origin 就是 opaque origin，
     * 拿不到 Gateway 这一侧的任何东西。加任何一项都会把这条推翻。
     *
     * 和上面 PDF 那条的差别就在这里：HTML **要**当页面跑，所以必须锁死；PDF 不当
     * 页面跑，锁死反而只剩一片白。
     */
    return busyBox(
      `<iframe class="sw-preview-frame" src="${esc(p.url)}" sandbox title="${esc(p.name)}" ${DONE}></iframe>`,
    )
  }
  if (p.kind === 'markdown' && p.mode === 'view') {
    // satuMd 对原始 HTML 一律转义、链接只放行白名单协议（见 markdown.js 开头第 3 条），
    // 所以这段 innerHTML 是安全的——和聊天气泡里渲染模型输出走的是同一条路。
    const md = window.satuMd
    const html = md ? md.render(String(p.text || '')) : ''
    if (md) return `<div class="sw-preview-md sw-md">${html}</div>`
  }
  // 其余一律看原文：Markdown/HTML 的「原文」页、纯文本、以及提取出来的 Office 文档。
  return `<pre class="sw-preview-src">${esc(String(p.text || ''))}</pre>`
}

function previewModal() {
  const p = state.preview
  if (!p) return ''
  const meta = p.size ? fileSize(p.size) : ''
  return `<div class="gw-modal-backdrop" data-act="preview-close">
    <div class="gw-modal sw-preview" data-stop>
      <div class="sw-preview-head">
        <div style="min-width: 0;">
          <h2>${esc(p.name)}</h2>
          <p><code>${esc(p.path)}</code>${meta ? ' · ' + esc(meta) : ''}</p>
        </div>
        <div class="sw-preview-acts">
          ${previewTabs(p)}
          <button type="button" class="btn" data-act="preview-download" data-path="${esc(p.path)}" data-name="${esc(p.name)}">${t('下载')}</button>
          <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="preview-close">${svg(['M18 6 6 18', 'M6 6l12 12'], 16)}</button>
        </div>
      </div>
      <div class="sw-preview-body" data-flow="${p.error || p.loading || p.docLoading || p.tooBig || p.kind === 'image' ? 'center' : 'top'}">${previewBody(p)}</div>
    </div>
  </div>`
}

/** 切「预览 / 原文」。只改一个字段，字节早就在手上了，不用再取一次。 */
function setPreviewMode(mode) {
  if (!state.preview || state.preview.mode === mode) return
  state.preview.mode = mode === 'source' ? 'source' : 'view'
  render()
  // 渲染出来的 Markdown 里可能有代码块、公式、mermaid——和聊天气泡一样要 enhance 一次，
  // 否则代码不高亮、公式显示 TeX 原文。
  if (state.preview.mode === 'view' && window.satuMd) {
    const host = document.querySelector('.sw-preview-md')
    if (host) window.satuMd.enhance(host)
  }
}

function logsModal() {
  if (!state.logsOpen) return ''
  const { title, sources = [], active } = state.logsOpen
  const picker =
    sources.length > 1
      ? `<select class="input" data-act="logs-source" style="max-width: 260px;">${sources
          .map((x) => `<option value="${esc(x.key)}" ${x.key === active ? 'selected' : ''}>${esc(x.label)}</option>`)
          .join('')}</select>`
      : ''
  return `<div class="gw-modal-backdrop" data-act="logs-close">
    <div class="gw-modal" style="max-width: 900px;" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div style="min-width: 0;">
          <h2 style="font-size: 20px; margin: 0 0 4px;">${t('运行日志')}</h2>
          <p style="margin: 0 0 var(--space-2); font-size: 13px; color: var(--muted-foreground);">${esc(title || '')}</p>
          ${picker}
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="logs-close">${svg(['M18 6 6 18', 'M6 6l12 12'], 16)}</button>
      </div>
      <pre id="log-body" style="margin: var(--space-4) 0 0; max-height: 60vh; overflow: auto; font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-all; background: var(--muted); border-radius: var(--radius); padding: var(--space-3);"></pre>
      <p style="margin: var(--space-2) 0 0; font-size: 11.5px; color: var(--muted-foreground);">${t('凭据已在机器那侧盖掉。日志里会有对话正文和执行过的命令。')}</p>
    </div>
  </div>`
}

/** 非「未上线」的错误仍然贴在名册上方——那是整页级别的问题，不属于某一个 Bot。 */
function runtimeDownBanner() {
  const err = state.runtimeError
  if (!err || String(err).includes('实例还没上线')) return ''
  // 这一栏里的话是我们自己写进 state 的中文常量（见 startChatStream / retryChatSession），
  // 过一遍译表才能跟着界面语言走；查不到的原样回来，不会变成空白。
  //
  // 「连接断开」那一句要**能点**：它是退避认输留下的，而认输之后没有任何东西会再去
  // 重连。原话让人去刷新整页——那会连草稿和还没发出去的附件一起丢掉，而真正要做的
  // 只是重开一条流。
  const retry =
    err === '连接断开'
      ? ` <button type="button" class="btn btn-ghost" style="margin-left: var(--space-2); height: 24px; padding: 0 8px; font-size: 12px;" data-act="chat-reconnect">${t('重新连接')}</button>`
      : ''
  return `<div class="gw-flash gw-flash-err">${esc(t(err))}${retry}</div>`
}

/**
 * 会话身份行，**直接长在页面顶栏里**。
 *
 * 它原本是消息流上面单独一条 header，于是顶栏写着「对话」、下面一行写着这条对话是
 * 谁——两条横杠叠在一起，上面那条还是一句永远不变的废话。合成一条之后，顶栏在对话页
 * 上说的就是「你正在跟谁说话、它现在什么状态」，这才是这一页需要一直挂在眼前的东西。
 *
 * 返回的是 .gw-head 的内容片段（身份 + 操作），外壳和内边距由 .gw-head 给。
 */
function chatHeadInline() {
  const bot = chatBotOf()
  const name = (bot && bot.name) || t('未选择')
  const menu =
    state.menu === 'chat'
      ? `<div class="satu-menu" data-flip="${String(Boolean(state.menuFlip))}">
          ${/* 自己建的那种才给设置入口：别人的、全局的，这一页上没有可改的东西。 */ ''}
          ${isMyBot(bot) ? `<button type="button" class="satu-menuitem" data-act="go" data-href="/bots/${esc(bot.id)}">${t('Bot 设置')}</button>` : ''}
          <button type="button" class="satu-menuitem" data-act="chat-copy-all">${t('复制全文')}</button>
          <button type="button" class="satu-menuitem" data-act="chat-export">${t('导出 Markdown')}</button>
        </div>`
      : ''
  return `<div class="sw-convo-avatar" aria-hidden="true">${ICON_BOT}</div>
    <div class="sw-convo-id">
      <div class="sw-convo-title">
        <span class="sw-convo-name">${esc(name)}</span>
        ${bot && bot.runtimeKind === 'local' ? `<span class="satu-localtag">${t('本地 Bot', 'Local bot')}</span>` : ''}
        <span class="sw-convo-live" id="chat-live" data-live="0"><i aria-hidden="true"></i><span>${t('离线')}</span></span>
      </div>
      <p class="sw-convo-meta" id="chat-meta"></p>
    </div>
    <div class="sw-convo-actions">
      <button type="button" class="btn btn-secondary" data-act="chat-export">${t('导出记录')}</button>
      <button type="button" class="btn btn-ghost btn-icon" data-menu-toggle data-act="chat-menu"
        aria-label="${esc(t('更多操作'))}">${svg(['M12 6h.01', 'M12 12h.01', 'M12 18h.01'], 16)}</button>
      ${menu}
    </div>`
}

function chatPage() {
  const bots = state.runtimeBots || []
  const selected = chatBotIdOf(state.path) || state.chatBotId
  /**
   * **flashes() 这一页以前没有。**
   *
   * flash() 写的是 state.error / state.notice，而这一页从头到尾只画 runtimeDownBanner
   * ——于是 chat.js 里那一串 flash 全是哑的：附件没传上去、这条消息没发出去、几个 `@`
   * 已经失效、「已中止，正在跑的那个工具要等它自己收尾」，一句都到不了屏幕上。人看到
   * 的就是「点了没反应」，而代码里明明写着话。别的页早就都拼了这一句（见各 pages-*.js）。
   * 导航时 go() 会清掉这两格，不会把上一页的红字带过来。
   */
  /**
   * 机器失联那一条**顶掉** runtimeDownBanner，不并排摆两条红字。
   *
   * 后者能说的只有「连接断开」外加一颗「重新连接」——而机器都不在了，那颗按钮点下去
   * 是白敲一次接口。真正的原因由前者说，而且它说得出「多久没心跳了」。
   */
  const machineDown = machineDownBanner()
  const banner = flashes() + (machineDown || runtimeDownBanner())
  if (!selected) {
    return `<div class="gw-chat"><section class="gw-chat-main">${banner}
      <div class="gw-chat-empty-main"><p>${bots.length ? t('从左边选一个 Bot 开始对话。') : t('还没有 Bot。点左下角「新建 Bot」建一个，它会用公司的 Bot 模版当底座。', 'No bots yet. Use “New bot” at the bottom left — it will run on your company template.')}</p></div>
    </section></div>`
  }
  // 席位没上线：正文换成一块「去部署」，连输入框一起不渲染（见 chatDeployPrompt）。
  const nodeploy = chatDeployPrompt(selected)
  if (nodeploy) {
    return `<div class="gw-chat"><section class="gw-chat-main">${banner}${nodeploy}</section></div>`
  }
  /* 正文一律留空：消息、在线灯、提示行全部由 paintChat 增量填。在这里先渲染一遍
     再让 paintChat 覆盖，等于每次换页把同一份内容画两遍，还会把已经渲染好的图冲掉。 */
  return `
    <div class="gw-chat">
      <section class="gw-chat-main">
        ${banner}
        <div class="sw-threadwrap">
          <div class="sw-thread" id="chat-thread"></div>
          <button type="button" class="sw-jump" id="chat-jump" data-act="chat-jump" hidden>${ICON_DOWN}${t('回到底部')}</button>
        </div>
        <div class="sw-composer">
          ${/* 待办 dock（见 docs/todo-tool.md）。摆在输入框**外面的顶上**，和排队那一行
                同一个位置逻辑：它说的是「这件事现在做到哪儿了」，是发下一句之前顺带
                知道的东西，不是消息流里的一条内容。默认折叠成一行——展开的清单会把
                输入框顶掉半屏，而人多半只想知道「还剩几条」。 */ ''}
          <div class="sw-todock" id="chat-todock" hidden></div>
          <div class="sw-queue" id="chat-queue" hidden></div>
          <form id="chat-form" class="sw-composer-box">
            <div class="sw-pickbox" id="chat-cmdpick" hidden></div>
            <div class="sw-pickbox" id="chat-mentionpick" hidden></div>
            <div class="sw-files" id="chat-mentions" hidden></div>
            <div class="sw-files" id="chat-files" hidden></div>
            <textarea id="chat-input" class="satu-prompt satu-grow" rows="1"
              placeholder="${esc(t('输入消息'))}">${esc(state.chatDraft || '')}</textarea>
            <div class="sw-composer-row">
              ${/* 席位的消息接口目前只收 text，没有二进制通道。所以附件走「随消息一起
                    贴成正文」这条路：选中的文本文件在发送时以围栏代码块拼进去，模型看到
                    的就是文件内容本身。二进制在选择那一刻当场挡掉并说明白，不做成一个
                    看起来能传、传完没反应的按钮。 */ ''}
              <button type="button" class="sw-iconbtn" data-act="chat-attach"
                aria-label="${esc(t('添加附件'))}" title="${esc(t('添加附件'))}">${ICON_CLIP}</button>
              <input type="file" id="chat-file" multiple hidden>
              <span class="sw-spacer"></span>
              ${/* 发送和停止是同一个按钮的两副面孔——它们指的是同一件事（这一轮对话的
                    开与关），而且永远只有一个有意义。摆两个按钮的话，其中一个总是灰的，
                    还得让人先分辨哪个能点。切换由 paintChatChrome 就地改，不重绘整页。 */ ''}
              <button type="submit" class="sw-send" id="chat-send" data-state="send"
                aria-label="${esc(t('发送'))}" title="${esc(t('发送'))}">${ICON_SEND}</button>
            </div>
          </form>
          <div class="sw-composer-tip">
            <span id="chat-tip"></span>
            <span class="sw-spacer"></span>
            ${/* 占比摆在这一行的最右边：它跟左边那句一样是「发之前顺带知道一下」的东西，
                  不值得单占一行，也不该跑到消息流里去抢正文的位置。内容由 paintChatCtx
                  就地填，没有真实用量时整块隐藏。 */ ''}
            <span class="sw-ctx" id="chat-ctx" hidden>
              <button type="button" class="sw-ctx-chip" id="chat-ctx-chip" data-act="chat-ctx"
                aria-expanded="false"></button>
              <div class="sw-ctxpop" id="chat-ctx-pop" hidden></div>
            </span>
          </div>
        </div>
      </section>
    </div>`
}

/**
 * 预览能在浏览器里直接打开的上限。
 *
 * 预览得把整个文件读成 blob 才能喂给 <img>/<iframe>——Gateway 认的是 Authorization
 * 头，而 src= 发出去的请求带不了头。所以这个数字是「愿意为看一眼吃多少内存」，
 * 超过就只给下载，不是不给看。
 *
 * 上传**没有**前端上限：文件是流着走的，不进模型上下文，把关的是席位那边的
 * SATUWORK_UPLOAD_MAX。
 */
const CHAT_PREVIEW_MAX = 25 * 1024 * 1024

/**
 * 排队 dock：输入框顶上那一行小字。
 *
 * **一条一行，纯文字，不展开附件**——图片不出缩略图，`@` 出来的药丸也不画。它是
 * 「等会儿要说的话」的一个提醒，不是消息气泡的预演；把气泡那一套搬上去，输入框会被
 * 顶掉半屏。多条就多行，最多画 3 行，再多第一行变成「还有 N 条」。
 */
function paintChatQueue() {
  const box = document.getElementById('chat-queue')
  if (!box) return
  const rows = chatQueues.get(state.chatSessionId) || []
  box.hidden = !rows.length
  if (!rows.length) {
    box.innerHTML = ''
    return
  }
  const shown = rows.slice(-3)
  const hidden = rows.length - shown.length
  box.innerHTML =
    (hidden ? `<div class="sw-queue-more">${esc(t(`还有 ${hidden} 条`))}</div>` : '') +
    shown
      .map((r) => {
        const line = (r.text || '').replace(/\s+/g, ' ').trim() || t('（只有附件）')
        return `<div class="sw-queue-row">
          <span class="sw-queue-dot" aria-hidden="true"></span>
          <span class="sw-queue-text">${esc(line)}</span>
          <button type="button" class="sw-file-x" data-act="chat-queue-cancel" data-id="${esc(r.id)}"
            aria-label="${esc(t('取消'))}">${ICON_X}</button>
        </div>`
      })
      .join('')
}

/**
 * 待办 dock 的四种状态标记。
 *
 * 画成图形而不是 ☐☑ 这类字符：那几个字符在不同系统上的字号、基线、甚至有没有字体
 * 都不一样（Windows 上常常退化成一个方框），而这一行的四个标记必须对得整整齐齐。
 */
const TODO_MARK = {
  pending:
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="12" cy="12" r="8"/></svg>',
  in_progress:
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.4" fill="currentColor" stroke="none"/></svg>',
  completed:
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="m8.6 12.2 2.3 2.3 4.5-4.7"/></svg>',
  cancelled:
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M9.2 9.2 14.8 14.8"/><path d="M14.8 9.2 9.2 14.8"/></svg>',
}

/**
 * 状态 → 标记。**走 hasOwn，不直接下标**：`TODO_MARK['__proto__']` 拿到的是
 * Object.prototype，而它是 truthy，`|| TODO_MARK.pending` 那道兜底接不住——拼进
 * innerHTML 就是一句 `[object Object]`。席位那边已经校验过状态，这一道是白捡的。
 */
const todoMark = (status) => (Object.hasOwn(TODO_MARK, status) ? TODO_MARK[status] : TODO_MARK.pending)

/** dock 抬头那个清单图标。 */
const ICON_LIST =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 6 2 2 3-3"/><path d="m3 15 2 2 3-3"/><path d="M12 7h9"/><path d="M12 16h9"/></svg>'

/** 折叠箭头。朝上；展开时由 CSS 转 180°——同一个箭头指的是同一件事的两个方向。 */
const ICON_CHEV =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>'

/**
 * dock 展开着还是折着，按会话记。**默认折着**：展开的清单会把输入框顶掉半屏，而人
 * 多半只想知道「还剩几条」。
 *
 * 只活在这一次页面加载里，不落 prefs：它是「我现在想不想看细节」，不是一项设置。
 */
const chatTodoOpen = new Map()

/**
 * 人手关掉的那张表，记的是**关掉时它长什么样**（sessionId → 指纹）。
 *
 * 不记「关掉了」这个布尔：那样一关就是永久的，而清单还在往前走——下一条做完了、
 * 新加了两条，人再也看不到。记指纹的话，**表一变它自己就回来**，而没变的时候不来烦人。
 */
const chatTodoHidden = new Map()

/**
 * 已经给它算过「要不要一上来就收起来」的会话（见 paintChatTodos 里那一段）。
 *
 * 只活在这一次页面加载里——「重新加载对话」正是这条规则要认的那一刻，落 prefs 就把
 * 它变成了一项永久设置。
 */
const chatTodoSeen = new Set()

const todoSign = (items) => items.map((i) => `${i.id}:${i.status}:${i.task}`).join('|')

/**
 * dock 该照着哪一份画。
 *
 * 两个数据源：折出来的最后一条 `todo/list` 事件，和打开这一页时拉的那次快照
 * （syncTodos）。谁新按**日志行号**比，不按时间比——那是两台机器各自的钟
 * （理由见 approvalDead）。快照没有 seq，它带的是取快照那一刻的水位。
 */
function chatTodoItems(folded) {
  const ev = folded && folded.todos
  const snap = chatTodoSnap.get(state.chatSessionId) || null
  if (ev && (!snap || Number(ev.seq) > Number(snap.upto))) return ev.items || []
  if (snap) return snap.items || []
  return []
}

/**
 * 待办 dock：输入框顶上那块可折叠的清单（见 docs/todo-tool.md）。
 *
 * **为什么值得单占一块地方。** 清单本来只以工具结果的形式躺在消息流里，而那正是它
 * 最没用的地方：一次十步的活会把它往上顶出屏幕，人想知道「还剩几条」得往回翻。它是
 * 一份**当前状态**，状态该待在一个固定的位置上。
 *
 * 折叠态一行说完三件事：在做什么、做了几条、还剩几条。展开才铺开细节。
 */
function paintChatTodos(folded) {
  const box = document.getElementById('chat-todock')
  if (!box) return
  const items = chatTodoItems(folded)
  const sid = state.chatSessionId
  // 空表不占位置。清单被清掉、或者这条会话压根没用过 todo，都走这一支。
  if (!items.length) return clearTodock(box)
  const sign = todoSign(items)
  const done = items.filter((i) => i.status === 'completed').length
  const running = items.find((i) => i.status === 'in_progress')
  const open = items.filter((i) => i.status === 'pending')
  // 抬头那句话：正在做哪一条 > 下一条该做什么 > 已经收口了。
  const now = running || open[0] || null
  const allDone = !running && !open.length
  /**
   * **收口了的那张表，重新加载之后不再摆出来。**
   *
   * 这块 dock 回答的是「这摊活做到哪儿了」。全部收口之后它已经答完了：再打开这一页
   * 时，它顶掉的是输入框上面那行位置，而它能说的只有一句「昨天那件事做完了」——那句话
   * 人上一次关掉页面之前就知道了。
   *
   * **只拦「第一次拿到」这一下**，所以盯着看的时候不受影响：最后一条打勾会让指纹变，
   * 那一帧照样画出「已完成」，人看得见事情收口了。之后清单再变（模型新列一张、或者
   * 某条被重新打开），指纹又变，它自己就回来——和 × 关掉那一张是同一套机制，这里只是
   * 替人先按了一下。
   *
   * 记「这条会话认过了」而不是直接看指纹在不在表里：一张空表也走不到这儿（上面那道
   * 闸），而 `chatTodoHidden` 里没有条目和「有条目但指纹不一样」是两件事。
   */
  if (!chatTodoSeen.has(sid)) {
    chatTodoSeen.add(sid)
    if (allDone) chatTodoHidden.set(sid, sign)
  }
  if (chatTodoHidden.get(sid) === sign) return clearTodock(box)
  const badge = running
    ? t('正在执行', 'Running')
    : allDone
      ? t('已完成', 'Done')
      : t('待办', 'To do')
  const opened = chatTodoOpen.get(sid) === true
  box.hidden = false
  /**
   * **清单没变就不重建 DOM。**
   *
   * 这个函数挂在 paintChatChrome 上，而那一个在流式期间是**每一帧**都跑的
   * （schedulePaintChat 走 rAF）。无条件写 innerHTML 的话，展开着的那张清单每帧被拆掉
   * 重建：它自己有滚动区（.sw-todock-list 的 max-height），于是 scrollTop 每帧归零——
   * 一张十几条的表在跑活的时候根本滚不动，而那正是人最想看它的时候；键盘焦点和选中的
   * 文字也一起没。同一件事在交接卡那块是用 hSig 挡住的（见 paintChatBlocks），
   * 这里照抄。
   *
   * 展开态**不进这个指纹**：它由下面几行属性写就地生效，不碰 DOM 结构，所以折起再
   * 展开时滚动位置和焦点都还在。
   */
  if (box.getAttribute('data-sig') !== sign) {
    box.setAttribute('data-sig', sign)
    box.innerHTML = todockHtml(items, { done, now, running, allDone, badge, opened })
  }
  // 展开 / 折起：改属性，不重建。每次都写一遍是幂等的，也顺手把重建之后的那一帧对齐。
  applyTodockOpen(box, opened)
}

/** 把「展开着还是折着」写到 DOM 上。**只改属性**，不碰结构——理由见上面那段。 */
function applyTodockOpen(box, opened) {
  box.setAttribute('data-open', opened ? '1' : '0')
  const head = box.querySelector('.sw-todock-head')
  if (head) head.setAttribute('aria-expanded', opened ? 'true' : 'false')
  const list = box.querySelector('.sw-todock-list')
  if (list) list.hidden = !opened
}

/** 收起来：连指纹一起清掉，否则下次要显示时会以为「没变」而不重建。 */
function clearTodock(box) {
  box.hidden = true
  box.removeAttribute('data-sig')
  box.innerHTML = ''
}

function todockHtml(items, { done, now, running, allDone, badge, opened }) {
  return (
    `<div class="sw-todock-bar">` +
    `<button type="button" class="sw-todock-head" data-act="chat-todo-toggle" aria-expanded="${opened ? 'true' : 'false'}">` +
    `<span class="sw-todock-icon">${ICON_LIST}</span>` +
    `<span class="sw-todock-title">${esc(t('任务', 'Tasks'))}</span>` +
    `<span class="sw-todock-badge" data-s="${running ? 'run' : allDone ? 'done' : 'idle'}">${esc(badge)}</span>` +
    (now ? `<span class="sw-todock-now">${esc(now.task || '')}</span>` : '') +
    `<span class="sw-spacer"></span>` +
    `<span class="sw-todock-count">${done}/${items.length} ${esc(t('已完成', 'done'))}</span>` +
    `<span class="sw-todock-chev">${ICON_CHEV}</span>` +
    `</button>` +
    `<button type="button" class="sw-todock-x" data-act="chat-todo-hide" ` +
    `aria-label="${esc(t('收起任务清单', 'Dismiss task list'))}" title="${esc(t('收起任务清单', 'Dismiss task list'))}">${ICON_X}</button>` +
    `</div>` +
    `<ol class="sw-todock-list"${opened ? '' : ' hidden'}>` +
    items
      .map(
        (i) =>
          `<li class="sw-todock-item" data-s="${esc(i.status || 'pending')}">` +
          `<span class="sw-todock-mark">${todoMark(i.status)}</span>` +
          `<span class="sw-todock-task">${esc(i.task || '')}</span>` +
          `</li>`,
      )
      .join('') +
    `</ol>`
  )
}

/**
 * 展开 / 折起。**只写三个属性**：不重绘整页（会冲掉输入框里没发出去的字），也不重折
 * 一遍历史、不重建清单的 DOM（那会把刚滚到的位置甩回顶上）。
 */
function toggleChatTodos() {
  const sid = state.chatSessionId
  const opened = chatTodoOpen.get(sid) !== true
  chatTodoOpen.set(sid, opened)
  const box = document.getElementById('chat-todock')
  if (box) applyTodockOpen(box, opened)
}

/** 关掉这一张。**只关这一张**：表一变它自己回来（见 chatTodoHidden）。 */
function hideChatTodos() {
  const sid = state.chatSessionId
  const folded = fold(state.chatEvents, chatLive.get(sid), currentBotHasChannelLabels())
  chatTodoHidden.set(sid, todoSign(chatTodoItems(folded)))
  paintChatTodos(folded)
}

/**
 * 已经选中的 `@`：输入框上方那排药丸。
 *
 * 和 dock 不是一回事——这排是**这一条还没发出去的**消息带着谁，dock 是**已经发出去、
 * 排着队**的那几条。
 */
function paintChatMentions() {
  const box = document.getElementById('chat-mentions')
  if (!box) return
  const picked = state.chatMentions || []
  box.hidden = !picked.length
  box.innerHTML = picked
    .map(
      (m, i) => `${mentionPill(m)}
        <button type="button" class="sw-file-x" data-act="chat-mention-drop" data-i="${i}"
          aria-label="${esc(t('移除'))} ${esc(m.label)}">${ICON_X}</button>
      </span>`,
    )
    .join('')
}

/** `@` 选单。候选来自 /mentions（现在只有连接器；Bot 和 Routine 以后往里加）。 */
function paintMentionPick() {
  const box = document.getElementById('chat-mentionpick')
  if (!box) return
  const pick = state.mentionPick
  if (!pick || !pick.open) {
    box.hidden = true
    box.innerHTML = ''
    return
  }
  const q = (pick.q || '').toLowerCase()
  const taken = new Set((state.chatMentions || []).map((m) => m.id))
  const list = (state.mentionOptions || [])
    .filter((m) => !taken.has(m.id))
    .filter((m) => !q || m.label.toLowerCase().includes(q) || (m.toolkit || '').includes(q))
    .slice(0, 8)
  box.hidden = false
  box.innerHTML = list.length
    ? list
        .map(
          (m, i) => `<button type="button" class="sw-pick${i === (pick.index || 0) ? ' is-on' : ''}"
        data-act="chat-mention-pick" data-id="${esc(m.id)}">
        ${m.logo ? `<img class="sw-pick-logo" src="${esc(m.logo)}" alt="" data-onerror="drop">` : ''}
        <span>${esc(m.label)}</span>
        ${m.mentionOnly ? `<small>${esc(t('仅 @ 时可用'))}</small>` : ''}
      </button>`,
        )
        .join('')
    : `<div class="sw-pick-empty">${esc(t('没有可用的连接。去「连接器」装一个再连上。'))}</div>`
}

function paintChatFiles() {
  const box = document.getElementById('chat-files')
  if (!box) return
  const files = state.chatFiles || []
  box.hidden = !files.length
  const busy = Boolean(state.chatUploading)
  box.innerHTML = files
    .map(
      (f, i) =>
        `<span class="sw-file">` +
        `<span>${esc(f.name)}</span><small>${esc(fileSize(f.size))}</small>` +
        // 传的时候不给「移除」：那一下删得掉列表项，删不掉已经在路上的请求。
        (busy
          ? ''
          : `<button type="button" class="sw-file-x" data-act="chat-file-drop" data-i="${i}" ` +
            `aria-label="${esc(t('移除'))} ${esc(f.name)}">${ICON_X}</button>`) +
        `</span>`,
    )
    .join('')
}

function fileSize(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n)) return ''
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

/**
 * 记下选中的附件。**不读内容**——文件在发送时整个流给席位，落进工作区，Bot 用
 * read/bash 自己取。
 *
 * 以前这里要 file.text() 把正文贴进消息，于是 256 KB 就是天花板，PDF、Excel、图片
 * 一概传不了（贴成乱码对谁都没用）。现在传的是路径，格式和大小都不再是这一层的事。
 */
function takeChatFiles(input) {
  const picked = Array.from(input.files || [])
  input.value = ''
  if (!picked.length) return
  state.chatFiles = [...(state.chatFiles || []), ...picked.map((file) => ({ name: file.name, size: file.size, file }))]
  paintChatFiles()
}

/** 带登录票的请求头。预览和上传都不走 api()——它们收发的不是 JSON。 */
function authHeaders(extra) {
  const headers = { ...(extra || {}) }
  const tok = token()
  if (tok) headers.authorization = 'Bearer ' + tok
  return headers
}

/**
 * 把一个文件传进这条会话的工作区，返回 { path, name, size }。
 *
 * 文件名走 header：查询串会进访问日志，而文件名常常就是内容本身
 * （「二季度裁员名单.xlsx」）。header 只认 ASCII，所以先 encodeURIComponent，
 * 席位那边解回来。
 */
/**
 * 上传**只直连席位机器**，和对话流同一个道理（见 directStreamBase 上面那段）：
 * Gateway 上 `POST /runtime/sessions/:id/files` 已经没有了，文件正文不该再经它中转。
 *
 * · 本地 Bot：照旧拼 `/runtime/sessions/<id>/files`——data.js 的 localRoute 认这个形状，
 *   改道到 127.0.0.1 那颗 bot 的 /api/sessions/<id>/files，票换成席位票。
 * · 远程 Bot：打 `bot.runtime.uploadUrl`（https://<机器>/seats/<seatId>/stream）下的
 *   /sessions/<id>/files，带登录票，管家那头验完换成席位票。地址是 null 就一个字节
 *   都不发——那是配置缺一项，不是故障。
 */
const NO_UPLOAD_URL_MSG = '这台机器没有配直连地址（或管家太旧），上传不了'

function uploadTargetOf(sessionId) {
  const owner = state.chatBotId || botIdOfSession(sessionId)
  const bot = runtimeBotOf(owner)
  const path = '/sessions/' + encodeURIComponent(sessionId) + '/files'
  // 名单上没有这颗 Bot、或者名单没带 runtime（低层直接调用、测试）：按本地那个形状走。
  if (!bot || !bot.runtime || isLocalRuntimeBot(bot)) return { url: '/runtime' + path, local: true }
  const base = bot.runtime.uploadUrl
  if (!base) return null
  return { url: base + path, local: false }
}

async function uploadChatFile(sessionId, file) {
  const target = uploadTargetOf(sessionId)
  if (!target) throw new Error(t(NO_UPLOAD_URL_MSG))
  const init = {
    method: 'POST',
    headers: authHeaders({
      accept: 'application/json',
      'content-type': 'application/octet-stream',
      'x-filename': encodeURIComponent(file.name),
    }),
    body: file,
  }
  // 本地那条走 swFetch（要它改道）；直连那条地址是绝对的，裸 fetch。
  const res = target.local ? await swFetch(target.url, init) : await fetch(target.url, init)
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {}
  if (!res.ok) throw new Error(errText((json && json.error) || 'HTTP ' + res.status))
  return json
}

/**
 * 附件在正文里的样子。
 *
 * 给的是**路径，不是内容**：文件已经躺在工作区里了，Bot 想读哪段读哪段，几百页的
 * PDF 也不会一次撑爆上下文。
 *
 * 排在正文前面——先给材料再给指令，模型读到「照这个文件改」时文件已经在眼前。
 */
function composeChatBody(files, text) {
  if (!files.length) return text
  const list = files.map((f) => '- `' + f.path + '`').join('\n')
  return t('我上传了文件，在工作区里：') + '\n' + list + (text ? '\n\n' + text : '')
}

/**
 * 模型真能看的图片格式。跟席位那边的白名单是同一张表（web/index.ts 的
 * MODEL_IMAGE_MIME）——这边先分好，能少一趟注定要被拒的往返。
 */
const MODEL_IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/**
 * 传上去的东西里，哪些能直接给模型看。
 *
 * 图片走 `images`（到了模型那边是真正的视觉输入），其余的只在正文里留个路径——
 * 后者模型得自己去 read。两条路都要有：图片的路径也列进正文，因为模型可能想用
 * 工具再处理它，而 image 块里是没有路径的。
 */
function pickImages(files) {
  return files
    .map((f) => ({ path: f.path, mime: String(f.contentType || '').split(';')[0].trim() }))
    .filter((f) => f.path && MODEL_IMAGE.has(f.mime))
}

/**
 * 挂着的那一条「等会话到了就发」。
 *
 * **只记意图，不记正文。** 正文一直躺在 state.chatDraft 里（这条路是在清草稿之前就
 * return 的），补发时现取——人在等的这几秒里又补了两个字，发出去的自然该是补过的那份；
 * 把它清空了，那就等于什么都没挂。
 *
 * 同时只留一个：人连按三次发送，挂的还是同一条，补发也只发一次。
 */
let heldSend = null

/**
 * 挂多久就不再补发了。
 *
 * 十分钟：换版、重启、网络断一阵都在这个尺度以内，而超过它多半是人早就走开了——那时
 * 候突然把十分钟前打的半句话发出去，比不发更糟。
 */
const HELD_SEND_MAX_MS = 10 * 60_000

function holdSend(botId) {
  if (!botId) return
  heldSend = { botId, at: Date.now() }
}

function clearHeldSend() {
  heldSend = null
}

/**
 * 会话到手了：把挂着的那一条补发出去。
 *
 * 三道闸，缺一不可：
 *
 * · **同一个 Bot**——人挂上之后切走了，那条草稿跟着上一个 Bot 收进 chatDrafts 里
 *   （见 ensureChatSession），这会儿补发就是把它发到别人的对话里去；
 * · **没挂太久**（见 HELD_SEND_MAX_MS）；
 * · **先清标记再发**——sendChat 里那条「没有会话」的路会重新挂上，不先清的话两边
 *   互相触发，一次断线能发出去好几条。
 */
function flushHeldSend(botId) {
  const held = heldSend
  if (!held || held.botId !== botId || state.chatBotId !== botId) return
  clearHeldSend()
  if (Date.now() - held.at > HELD_SEND_MAX_MS) return
  if (!(state.chatDraft || '').trim() && !(state.chatFiles || []).length && !(state.chatMentions || []).length) return
  void sendChat()
}

async function sendChat() {
  const text = (state.chatDraft || '').trim()
  const files = state.chatFiles || []
  const mentions = state.chatMentions || []
  const sessionId = state.chatSessionId
  /**
   * 发这条消息时人停在哪个 Bot 上。
   *
   * 下面几处失败回滚（还草稿、还点名）和 `state.chatFiles = []` 写的都是**当前**那个
   * Bot 的输入框，而中间隔着一段传附件的时间，几秒起步。人这会儿切到了别的 Bot 的话：
   * 传失败会把 A 的正文和 @ 塞进 B 的输入框，传成功那句清空又会把 B 刚选好的附件抹掉。
   * 所以每一处回写前都要问一句「人还在不在 A」——loadDesktopRuntime 那道门是同一个理由。
   */
  const forBot = chatBotIdNow()
  const stillHere = () => chatBotIdNow() === forBot
  if ((!text && !files.length && !mentions.length) || state.chatUploading) return
  /**
   * 斜杠命令**在这里拦下，绝不往 /messages 走**。
   *
   * 选单只是提示，真正的闸必须在发送路径上：人完全可以把 `/compact` 打完再按回车，
   * 那时选单可能已经关了（打完最后一个字母时它还开着，但失焦、Esc 都会关掉）。
   */
  const cmd = parseCommand(text)
  if (cmd) {
    if (cmd.unknown) {
      // **不当普通消息发出去。** 一个手滑的 `/copmact` 发给模型，它会礼貌地回一段
      // 「你是想…吗」，而人以为自己压缩过了。草稿留着，改一个字母就能重来。
      flash('err', t('没有这条命令：') + cmd.unknown)
      closeCmdPick()
      render()
      return
    }
    if (cmd.extra) {
      flash('err', '/' + cmd.cmd.name + ' ' + t('不带参数，单独发这一条就行'))
      closeCmdPick()
      render()
      return
    }
    if (files.length || mentions.length) {
      // 命令占满整条消息，不捎带附件和点名。那些东西原样留在输入框上。
      flash('err', t('命令不能和附件或 @ 一起发，先把这条命令单独发出去'))
      render()
      return
    }
    await runChatCommand(cmd.cmd)
    return
  }
  /**
   * **没有会话不能一声不吭地咽下去。** 席位刚部署完的那几十秒里 chatSessionId 就是空
   * 的（见 ensureChatSession），而这里原先和「草稿是空的」共用一句 `return`：字打得
   * 进去，点发送什么都不发生，一个字的解释也没有——刷新一下页面又好了，因为那会重
   * 新拿一次会话。
   *
   * 现在说清楚，并且当场催一次（ensureChatSession 自己会退避重来）。**不 await**：
   * 那一跳最长十几秒，等它回来再发的话，这期间人多半已经又按了一次回车——两次都停在
   * 同一个 await 上，会话一到就把同一条话发两遍。
   */
  if (!sessionId) {
    /**
     * **这一条不退回给人重按，挂起来等会话。**
     *
     * ensureChatSession 开头就 `cancelSessionRetry()` + `sessionGaveUp = false`，所以
     * 这一句本身就是「重新开始试」——关键是它以前只在**这一次点击**时催一下，人要是
     * 不再点，就再没有人管了。线上抓到的那次正是这个形状：换版期间标签页在后台，退避
     * 链被浏览器冻着走完了、认了输，人回来一按发送，看到一句「等它接上再发」，然后
     * 干等——而席位早就好了。
     *
     * 按下去是一次**真的重来**：会话那条链重排（最长 5 分钟），流那条也从慢速长跑里
     * 叫醒（idleRetry）。**并且记下「这一条要发」**——会话一到就自动补发（见
     * holdSend / flushHeldSend），人不必守在屏幕前反复按。
     *
     * 席位换版必然踩中这一刻：换了进程之后客户端要重新拿一次会话，中间隔着一个往返，
     * 而人正在这时候按发送。以前退回给他一句「接上再按一次」，等于把重试的活派给了人。
     */
    const botId = state.chatBotId || chatBotIdOf(state.path)
    if (botId) {
      holdSend(botId)
      void ensureChatSession(botId).catch(() => {})
      const row = botStreams.get(botId)
      if (row && row.sessionId) reviveChatStream(row.sessionId, botId)
    }
    flash('err', t('还没接上席位，这条先挂着——接上就自动发出去'))
    render()
    return
  }
  // 走到这儿说明会话在手上：之前挂着的那一条（如果有）就是这一条，标记该退场了，
  // 免得这次发完之后 flushHeldSend 又补发一遍。
  clearHeldSend()
  /**
   * **发之前先确认还有人在听。**
   *
   * 回答是经 SSE 回来的，而这条消息走的是另一条请求——两者互不相干，流断着照样发得
   * 出去、bot 照样跑完。屏幕上于是挂着一句「正在思考」，日志里那一轮明明已经
   * completed，只能刷新（刷新管用，正是因为它重开了一条流）。换版那几分钟里退避真
   * 认过一次输，那之后每一条消息都会落进这个坑。
   *
   * 不 await：重连带 after 游标，错过的会补回来，没必要让人多等一个 RTT。
   */
  reviveChatStream(sessionId, state.chatBotId)

  state.chatDraft = ''
  state.chatMentions = []
  closeMentionPick()
  paintChatMentions()
  const input = document.getElementById('chat-input')
  if (input) {
    input.value = ''
    input.style.height = ''
  }

  // 附件先落地，再发消息。反过来的话，模型会先读到路径、文件还没到。
  let uploaded = []
  if (files.length) {
    state.chatUploading = true
    paintChatFiles()
    render()
    try {
      for (const f of files) uploaded.push(await uploadChatFile(sessionId, f.file))
    } catch (err) {
      // 传失败就把草稿、附件和点名原样还回去，别让人重新选一遍文件、重新 @ 一遍。
      state.chatUploading = false
      if (stillHere()) {
        state.chatDraft = text
        state.chatMentions = mentions
        paintChatFiles()
        paintChatMentions()
      }
      flash('err', t('附件没传上去：') + err.message)
      render()
      return
    }
    state.chatUploading = false
  }
  if (stillHere()) {
    state.chatFiles = []
    paintChatFiles()
  }

  const images = pickImages(uploaded)
  const body = composeChatBody(uploaded, text)
  /**
   * 先画上，再发。**这一条是给人看的回执**：POST 出去到席位把 user/message 经 SSE 送
   * 回来，中间少则几百毫秒、多则几十秒（bot 在忙的时候），原先那段时间屏幕上什么也
   * 没有，人只能再按一次回车。
   *
   * afterSeq 记住「此刻流走到哪儿了」，回执认领时只认它之后的——见 mergePending。
   */
  const afterSeq = (state.chatEvents || []).reduce((m, ev) => (ev.seq > m ? ev.seq : m), -1)
  // mentions 也带上：回执那几秒里那条消息要长成最终的样子，否则药丸会先没有、
  // 等席位把事件送回来才突然冒出来——同一条消息在屏幕上跳两次。
  const pending = { sessionId, text: body, images, mentions, at: Date.now(), afterSeq }
  state.chatPending = (state.chatPending || []).concat(pending)
  paintChat()
  try {
    const r = await api('POST', '/runtime/sessions/' + encodeURIComponent(sessionId) + '/messages', {
      text: body,
      ...(images.length ? { images } : {}),
      ...(mentions.length ? { mentions: mentions.map((m) => ({ kind: m.kind, id: m.id, label: m.label })) } : {}),
    })
    /**
     * 排队了：把刚画上的那条气泡撤掉，改画成输入框顶上的一行。
     *
     * 席位那边紧接着会经 SSE 推一次 `queue/change`，这里先自己填一行是为了「点了发送
     * 立刻有反应」——那一跳来回几百毫秒，中间屏幕上什么都没有的话，人会再按一次。
     */
    if (r && r.queued) {
      state.chatPending = (state.chatPending || []).filter((p) => p !== pending)
      const rows = chatQueues.get(sessionId) || []
      chatQueues.set(sessionId, rows.concat({ id: r.queueId, text: body, mentions, createdAt: Date.now() }))
      paintChat()
      paintChatQueue()
    }
    // Gateway 把失效的点名剔掉了（断了、被公司禁了、根本不是我的）。人要知道为什么，
    // 不然那几颗药丸就是无声消失的。
    if (r && Array.isArray(r.droppedMentions) && r.droppedMentions.length) {
      flash('err', t(`有 ${r.droppedMentions.length} 个 @ 已经失效，这一条没带上它们`))
      render()
    }
  } catch (err) {
    // 没发出去就把这条回显撤掉，别让屏幕上留一条其实不存在的消息。
    state.chatPending = (state.chatPending || []).filter((p) => p !== pending)
    if (stillHere()) {
      // 文件已经传上去了，退回来的只有草稿——附件不还，还了会传第二遍。
      state.chatDraft = text
      /**
       * **点名也要还。** 只还正文的话，人按重发时这一条不带任何 `@`——而
       * `mentionOnly` 的连接（比如个人邮箱）这一轮根本不在工具表里，Bot 会回一句
       * 「没有可用的邮箱」，用户却以为自己点过名了。
       */
      state.chatMentions = mentions
      paintChatMentions()
    }
    if (uploaded.length) flash('err', t('附件已经在工作区里了，但这条消息没发出去。'))
    if (String(err.message || '').includes('实例还没上线')) state.runtimeError = '实例还没上线'
    else if (!uploaded.length) flash('err', err.message)
    render()
  }
}

/**
 * 中止这一轮。
 *
 * 以前是 `catch {}` 一把吞掉。三种完全不同的情况在界面上长得一模一样——请求没发出去、
 * 席位不认这条会话、这一轮其实早就结束了——都是「点了没反应」，连往哪儿查都给不出。
 *
 * **它不是当场生效的。** 这一下只是把中止下发出去：界面 → Gateway → 席位 →
 * `agent.abort()`。信号现在会往下传给正在跑的工具（bot/src/agent/index.ts 的
 * bridgeTools 接了 signal，terminal 收到就杀进程树），但收尾要时间，而且不是每种工具
 * 都能当场收住——一个已经发出去的网络请求、浏览器里正走着的那一步，都得等它自己回来。
 * 所以「按下」和「停住」之间永远有一段，`turn/end` 到了才算真停。
 *
 * 这一段以前界面上完全没有痕迹，于是它长得跟「点了没反应」一模一样。现在按下去当场
 * 进 `chatStopping`：按钮转圈并禁掉，输入框底下那行字改口读秒（见 stopTipText）。
 */
async function abortChat() {
  const sessionId = state.chatSessionId
  if (!sessionId) return
  // 已经在停了：第二下什么也别做。按钮那会儿是 disabled 的，这里是键盘和竞态的第二道闩。
  if (state.chatStopping === sessionId) return
  const stillRunning = Boolean(document.querySelector('.sw-toolchip[data-state="running"]'))
  /**
   * **先改界面，再发请求。** 这一下改的是「已经收到了」，不是「已经停了」——那两件
   * 事之间隔着整条下发链路，而这期间流上一个事件都不会来。等请求回来再改的话，最先
   * 那几百毫秒里屏幕纹丝不动，人得到的反馈是「点了没反应」。
   */
  state.chatStopping = sessionId
  state.chatStoppingAt = Date.now()
  paintChat()
  try {
    const r = await api('POST', '/runtime/sessions/' + encodeURIComponent(sessionId) + '/abort', {})
    if (r && r.aborted === false) {
      // 席位说这一轮本来就不在跑：转圈当场收掉，别让它对着一件没在发生的事转下去。
      clearStopping()
      flash('err', t('这一轮已经结束了', 'That turn had already finished.'))
    } else if (stillRunning) {
      flash('ok', t('已下发停止；正在跑的那个工具要等它自己收尾', 'Stop sent — the running tool has to wind down first.'))
    } else {
      flash('ok', t('已下发停止，等 Bot 收到就停', 'Stop sent — it takes effect once the bot receives it.'))
    }
    render()
  } catch (err) {
    // 没送到就把转圈收掉：这一下是白按的，得让按钮还能再按一次。
    clearStopping()
    flash('err', t('没能中止：', 'Could not stop: ') + (err && err.message ? err.message : ''))
    render()
  }
}

/**
 * 批准 / 拒绝一次高风险调用。
 *
 * **按下去先把卡片停用。** 终态是靠 SSE 那条事件回来的，一来一回几百毫秒，这期间
 * 按钮还亮着——人会以为没点上再点一次，而第二次点的是一条已经结束的确认，席位回
 * 409，界面上无端冒出一句「这条确认已经结束了」。
 *
 * 失败了要把它恢复回去：那次真的没送到，卡片得还能点。
 */
/**
 * 卡片上这几格现在是什么值。
 *
 * **点下去那一刻从 DOM 里现读**，不用上面那张草稿表：草稿表是为了重画之后不丢字，
 * 而「要发出去的是哪一份」只能以人眼前看到的那一份为准。两者不一致时（重画的竞态），
 * 眼前的那份才是他刚才读过的。
 */
function approvalEdits(callId) {
  const edits = {}
  for (const el of document.querySelectorAll('[data-edit]')) {
    if (el.getAttribute('data-call') !== callId) continue
    edits[el.getAttribute('data-edit')] = el.value
  }
  return edits
}

async function decideApproval(callId, decision, scope) {
  const sessionId = state.chatSessionId
  if (!sessionId || !callId) return
  const box = [...document.querySelectorAll('.sw-approval')].find((el) => el.getAttribute('data-call') === callId)
  if (box) {
    if (box.getAttribute('data-busy') === '1') return
    box.setAttribute('data-busy', '1')
  }
  try {
    const edits = decision === 'approve' ? approvalEdits(callId) : null
    await api(
      'POST',
      '/runtime/sessions/' + encodeURIComponent(sessionId) + '/approvals/' + encodeURIComponent(callId),
      { decision, scope: scope || 'once', ...(edits && Object.keys(edits).length ? { edits } : {}) },
    )
    // 这一条已经落定，草稿留着只会在下一次同名 callId 上冒出来（不会发生，但也没用了）。
    for (const key of [...approvalDrafts.keys()]) {
      if (key.startsWith(callId + '::')) approvalDrafts.delete(key)
    }
  } catch (err) {
    if (box) box.removeAttribute('data-busy')
    // 409 是「这条早就结束了」——超时、被停止、或者另一个标签页先点了。它不是错误，
    // 但必须说出来：人点了一下什么都没发生才是最糟的。
    flash('err', err && err.message ? err.message : t('没能提交这次确认', 'Could not submit that decision'))
  }
}

/** 交接卡上还没提交的那句话。key 是单号。重画时先存后填，见 updateRow。 */
const handoffDrafts = new Map()

/**
 * 接手 / 交还 / 撤销。
 *
 * **走 `/runtime/handoffs/:id/*`，不走会话那条路。** 接手的人可能是管理员，这条会话
 * 根本不是他的——按会话鉴权的那几条路由在那时会把他挡在外面，而他恰恰是该来处理这件
 * 事的人（见 gateway/src/routes/handoffs.ts）。
 */
async function actOnHandoff(id, act, body) {
  if (!id) return
  const box = [...document.querySelectorAll('.sw-handoff')].find((el) => el.getAttribute('data-handoff') === id)
  if (box) {
    if (box.getAttribute('data-busy') === '1') return
    box.setAttribute('data-busy', '1')
  }
  try {
    await api('POST', '/runtime/handoffs/' + encodeURIComponent(id) + '/' + act, body || {})
    handoffDrafts.delete(id)
    // 状态变化会顺着 SSE 回来（席位落了一条 human/handoff），卡片跟着重画。
    // 待办计数是 Gateway 那张表上的，单独刷一次。
    void loadHandoffs()
  } catch (err) {
    if (box) box.removeAttribute('data-busy')
    // render 会换掉 textarea，先保住人已经写好的交接说明。此前这里只改 state.error
    // 却不重绘，所以远程席位离线、本地通道断开、工单已被别人接走时，用户看到的都是
    // “按钮完全点不动”，连真实错误都没有。
    const draft = handoffNote(id)
    if (draft) handoffDrafts.set(id, draft)
    // 409「已经被别人接走了 / 这张单不在了」不是错误，但必须说出来：点了一下什么都
    // 没发生才是最糟的。
    flash('err', (err && err.message) || t('这一下没成', 'That did not go through'))
    render()
  }
}

function handoffNote(id) {
  const ta = [...document.querySelectorAll('.sw-handoff-note')].find((x) => x.getAttribute('data-handoff') === id)
  return ta ? ta.value.trim() : ''
}

async function returnHandoff(id, disposition) {
  const text = handoffNote(id)
  if (!text) {
    // 空的交还等于把「我处理完了」五个字扔给模型——它接着要做什么全靠猜。
    flash('err', t('写一句你做了什么，Bot 要靠它接着做', 'Say what you did — the bot continues from it'))
    return
  }
  await actOnHandoff(id, 'return', { disposition: disposition || 'done', text })
}

/**
 * 待办清单 + 顶栏那个计数。
 *
 * **轮询，不是长连接。** 现在的 SSE 是按会话挂的（每颗 Bot 一条），而管理员对别人
 * 名下 Bot 的单子没有任何一条流。为这一个页面先造一条账号级的流不划算——30 秒一次
 * 的 GET 换来的东西一样多。
 */
async function loadHandoffs() {
  if (!state.me || !state.me.account || !state.me.account.companyId) return
  try {
    const data = await api('GET', '/runtime/handoffs')
    state.handoffs = Array.isArray(data.handoffs) ? data.handoffs : []
    state.handoffCount = Number(data.count) || 0
    state.handoffStats = data.stats || null
    applyHandoffSnapshot(state.handoffs)
    paintHandoffBadge()
    // 待办页正开着就重画：这个数刚变过，而那一页整屏都是它。
    if (state.path === '/handoffs') render()
  } catch {
    // 拉不到就保持上一份。**不清零**：一个突然消失的待办数会让人以为事情办完了。
  }
}

/**
 * 拉一张单的正文（Bot 做到哪一步）。**只有展开那一条才拉**：这一跳会打到席位上。
 *
 * 拉不到就记 `null`，界面上说明白是「席位没应答」——写成「这张单没有内容」的话，
 * 接手的人会以为 Bot 什么都没做，然后从头再来一遍。
 */
async function loadHandoffDetail(id) {
  if (!id) return
  try {
    const data = await api('GET', '/runtime/handoffs/' + encodeURIComponent(id))
    state.handoffDetail = { ...(state.handoffDetail || {}), [id]: data.detail ?? null }
  } catch {
    state.handoffDetail = { ...(state.handoffDetail || {}), [id]: null }
  }
  if (state.path === '/handoffs') render()
}

/**
 * 待办的轮询。
 *
 * 30 秒一次，而且**只在页面可见时**转：一个丢在后台的标签页每半分钟打一个请求，
 * 一天下来是两千多个，换来的是没有人在看的一个数。切回前台时立刻补一次，
 * 那一下才是人真正会看的时刻。
 */
let handoffTimer = null

function startHandoffPoll() {
  if (handoffTimer) return
  handoffTimer = setInterval(() => {
    if (document.hidden) return
    void loadHandoffs()
  }, 30_000)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void loadHandoffs()
  })
}

/**
 * 席位通联的轮询：这些 Bot 的机器还在不在。
 *
 * **非有不可。** 这一份数据只在进页面时拉过一次（loadPage → loadRuntimeBots），而机器
 * 失联恰恰是「人已经坐在这一页上」的时候发生的：不再拉一次，那盏灯就会一直停在他进
 * 来时的样子——正是「平台说失联、员工这边还写着在线」的后半截。事件流救不了这件事，
 * 机器没了它同样收不到任何东西。
 *
 * 30 秒一轮，和管家的心跳同频（MANAGER_HEARTBEAT_MS）：再密也没有新数据，Gateway 那
 * 一份也是等心跳来才变的。规矩照抄待办那条——只在页面可见时转，切回前台立刻补一次。
 *
 * **只有真的变了才重绘**：横幅和名册由 chatPage() / chatRosterNav() 拼，改不动就得整页
 * 重画，而那一下会把正在打字的输入框换掉（见 paintChatCtx 上的注释）。半分钟一次的
 * 无条件重绘，等于让人没法在这一页上安心打字。
 */
const SEAT_WATCH_MS = 30_000
let seatWatchTimer = null

function startSeatWatch() {
  if (seatWatchTimer) return
  seatWatchTimer = setInterval(() => {
    if (document.hidden) return
    void pollSeatLinks()
  }, SEAT_WATCH_MS)
  // Node 环境（e2e 垫片）下别拽着进程不退出；浏览器里 setInterval 是数字，没有 unref。
  if (seatWatchTimer && typeof seatWatchTimer.unref === 'function') seatWatchTimer.unref()
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void pollSeatLinks()
  })
}

async function pollSeatLinks() {
  if (isOwner()) return
  // 名册里每个 Bot 的通联状态都在这一份里，一次请求就够——一个 Bot 一次的话，
  // 名册长一点就是每半分钟一串请求，而它们全在问同一件事。
  // 键里带上部署状态：名单上那一行「正在安装…」要在装完的时候自己消失，而通联状态
  // 从头到尾都是 online——只比它的话，那句话会一直挂到人点了点什么才换掉。
  const rosterKey = () => (state.runtimeBots || []).map((b) => b.id + ':' + seatLinkOf(b) + ':' + ((b.runtime && b.runtime.status) || '')).join(',')
  const before = rosterKey()
  try {
    await loadRuntimeBots()
  } catch {
    // 拉不动就算了：这一份只用来点亮那盏灯，不该因为一次网络抖动把界面上的话改掉。
    return
  }
  if (rosterKey() === before) return
  // 别的页上没有这盏灯，也没有那条横幅——重绘只会把人正在填的表单换掉。回到对话页时
  // loadPage 自己会重画。
  if (isChatPath(state.path)) render()
}

async function updateOrgRuntime() {
  const org = state.org && state.org.id
  if (!org || state.updatingRuntime) return
  const version = state.latestRelease
  if (!version) {
    flash('err', '还没有发布 Bot 版本')
    render()
    return
  }
  state.updatingRuntime = true
  render()
  try {
    const data = await api('POST', `/platform/orgs/${encodeURIComponent(org)}/runtime/update`, { version })
    const results = Array.isArray(data.results) ? data.results : []
    const ok = results.filter((r) => r.status === 'ready' && !r.error).length
    /**
     * 「有会话在跑，这次没换」**单独数**，不进「失败」。
     *
     * 那是管家等到超时也没等到席位空下来（见 manager/src/seats.ts 的排空）：机器上
     * 一个字节都没动，席位还是原来的版本、还在好好地跑，晚点再来一次就是了。混进
     * 失败里的话，一次「中午大家都在用」会被报成一片红，人会去查根本不存在的故障。
     */
    const held = results.filter((r) => r.busy).length
    const bad = results.filter((r) => !r.busy && (r.error || r.status === 'error')).length
    const tail = held ? t(`，${held} 个有会话在跑没换`, `, ${held} skipped (busy)`) : ''
    if (!results.length) flash('ok', t('没有需要更新的席位', 'No seats needed updating'))
    else
      flash(
        bad && !ok ? 'err' : 'ok',
        t(`更新 ${data.version}：成功 ${ok}，失败 ${bad}`, `Updated ${data.version}: ${ok} ok, ${bad} failed`) + tail,
      )
    await loadCompanyDetail(org)
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.updatingRuntime = false
    render()
  }
}

/* ── 安装进度的轮询 ──────────────────────────────────────────────────
   建完 Bot 之后自动开装（见 routes/runtime.ts 的 POST /runtime/bots），装完这一页要
   **自己**变成对话——让人为了知道「好了没有」去刷新页面，等于把刚省掉的那一次点击
   又还回去。 */

/** 两秒一轮。管家那份进度也就这个粒度（一步一变），再密只是白问。 */
const DEPLOY_WATCH_MS = 2000
let deployWatchTimer = null
let deployWatchBound = false

/**
 * 该不该转：这一页对着的那颗 Bot 正在装（或者刚建完、席位行还没落库）。
 *
 * 装完就停——**这不是一个长明的定时器**。一台已经好了的机器上每两秒问一次「装到哪儿
 * 了」，问的是一件没有答案的事，而它还要一路敲到那台机器上去。
 */
function ensureDeployWatch() {
  const want = !isOwner() && isChatPath(state.path) && Boolean(chatBotIdNow()) && seatStage() === 'deploying'
  if (want && !deployWatchTimer) {
    deployWatchTimer = setInterval(() => {
      if (document.hidden) return
      void pollDeployProgress()
    }, DEPLOY_WATCH_MS)
    // Node 环境（e2e 垫片）下别拽着进程不退出；浏览器里 setInterval 是数字，没有 unref。
    if (deployWatchTimer && typeof deployWatchTimer.unref === 'function') deployWatchTimer.unref()
    // 第一轮**当场就问**，不等这两秒：进这一页的那一瞬间，屏幕上那份进度可能是几分钟
    // 前留下的（换页回来、刷新过），而人正是为了看它才进来的。
    void pollDeployProgress()
    // 切回前台补一次，理由同待办和席位那两条轮询：后台标签页里不转，回来时立刻补上
    // 那一眼。**只挂一次**——这个函数每次 render 都会跑到。
    if (!deployWatchBound) {
      deployWatchBound = true
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && deployWatchTimer) void pollDeployProgress()
      })
    }
  } else if (!want && deployWatchTimer) {
    clearInterval(deployWatchTimer)
    deployWatchTimer = null
  }
}

/**
 * 上一轮还没跑完。**这道闸非有不可。**
 *
 * 收尾那一段（拉席位、拉名册、接会话）比两秒长是常事——尤其席位刚 ready、bot 进程还
 * 没上线的时候，正是这一段最慢的时刻。没有闸的话下一次 tick 会叠进来再跑一遍收尾，而
 * `ensureChatSession` 的第一句是 `cancelSessionRetry()`：它会把上一轮排好的退避重试取
 * 消掉，紧接着自己再发一次——退避于是被换成每两秒一记的硬打，而这条路是要经管家转到
 * 席位机器上去的。
 */
let deployPolling = false

/**
 * 问一次「装到哪一步了」，装好了就把这一页接上。
 *
 * **进度拉不动不清空 state.deployProgress**：一次网络抖动会让这一屏从「第 3 步 · 安装
 * 浏览器」跳回「还没有部署」外加一颗按钮——而机器上什么都没变。宁可让那个读秒继续走。
 */
async function pollDeployProgress() {
  const id = chatBotIdNow()
  if (!id || isOwner() || deployPolling) return
  deployPolling = true
  try {
    await runDeployPoll(id)
  } finally {
    deployPolling = false
  }
}

async function runDeployPoll(id) {
  let data
  try {
    data = await api('GET', '/runtime/deploy/progress?botId=' + encodeURIComponent(id))
  } catch {
    return
  }
  // 这一份是给 `id` 拉的。人在等待期间换了 Bot 的话，认领它就是把别人的进度画在这一页上。
  if (chatBotIdNow() !== id) return
  const before = deployProgressNow()
  /**
   * **年龄在收到的这一刻锚成本地时刻**，此后读秒走的是本机时钟。
   *
   * 服务端给的是「已经装了多久」而不是「什么时候开始的」（见 `/runtime/deploy/progress`）：
   * 员工的电脑和 Gateway 差几分钟是常事，拿绝对时刻自己减本地时钟，一台快十分钟的电脑
   * 会在刚按下「创建」的那一秒写出「已经装了 10:03」。
   *
   * 锚点**只在这里算一次**：每轮轮询都重锚的话，网络抖一下这个数就会往回跳，而人正盯着
   * 它判断「是不是卡住了」。同一次安装（状态还是 deploying、上一轮也是）就沿用上一次的
   * 锚点，只有换了一次安装才重新锚。
   */
  const keepAnchor = before && before.status === 'deploying' && data.status === 'deploying' && before.since
  const age = Number(data.elapsedMs)
  const since = keepAnchor || (Number.isFinite(age) ? Date.now() - Math.max(0, age) : 0)
  state.deployProgress = { botId: id, ...data, since }
  if (data.status === 'deploying') {
    // 装的过程中不整页重绘：那一屏上只有两处会动（第几步、读秒），而读秒自己每秒走
    // （tickClocks）。步骤没变就一个字都不用改。
    const same = before && before.status === 'deploying' && stepKeyOf(before) === stepKeyOf(state.deployProgress)
    if (!same) render()
    ensureClockTick()
    return
  }
  // 落地了（ready / error / none）：把席位那一份、名册那一份都换成新的，再整页重绘。
  await loadDesktopRuntime(id)
  await loadRuntimeBots().catch(() => {})
  if (data.status === 'ready') {
    state.runtimeError = ''
    state.deployHint = ''
    // 会话要现开一条：这颗 Bot 是刚装好的，之前每一次 ensureChatSession 都撞在 503 上。
    //
    // 吞掉它抛的那几种（这颗 Bot 不是你的、已经删了）：这是一条**定时器**里的调用，
    // 没有人接着这个 promise，抛出去只会变成一条 unhandled rejection；而这一页该说的
    // 话由下面的 render 按 state 画，不靠这次异常。
    await ensureChatSession(id).catch(() => {})
  }
  ensureDeployWatch()
  render()
}

/** 「这一屏此刻画的是什么」的身份。一个字都没变就没必要重绘。 */
function stepKeyOf(p) {
  const s = p && p.step
  // stale 也在里面：它一翻，这一屏就从「正在安装」换成「上一次安装没做完」，
  // 而 phase 和 step 那时通常一个都没动——漏掉它就是那句话永远换不过来。
  return (p && p.phase) + '/' + (p && p.stale ? 'stale' : 'live') + '/' + (s ? s.step + '/' + s.total + '/' + s.label : '-')
}

async function deployMyRuntime(botId, opts = {}) {
  const id = botId || chatBotIdOf(state.path) || state.chatBotId
  if (state.deploying || isOwner() || !id) return
  /**
   * **手上那份进度先扔掉。**
   *
   * 它可能正写着「上一次安装没做完」——而人按的正是那颗「重新部署」。留着它，seatStage
   * 会一直照它说话（进度那一份优先），于是这一次装完了，屏幕上还挂着上一次没做完的那
   * 句话，按钮也还是那颗。下一轮轮询会把新的那份填回来。
   */
  if (state.deployProgress && state.deployProgress.botId === id) state.deployProgress = null
  state.deploying = true
  state.deployHint = opts.update ? '正在重新部署…' : '正在部署…'
  render()
  try {
    // `update` 不能省：席位已经是 ready 且版本没变时，服务端会直接把现状还回来，
    // 什么都不做——那样「重新部署」这个按钮就成了摆设。
    // force：见 gateway/src/deploy.ts 里那道「已经 ready 就跳过」的门。不带它的话，
    // 「重新部署」在最需要它的时候（版本对、状态 ready、但机器上不对）什么都不会做。
    const body = { botId: id }
    if (opts.update) body.update = true
    if (opts.force) body.force = true
    await api('POST', '/runtime/deploy', body)
    const startAt = Date.now()
    // 部署结果按这一份说话，不看 state.desktopRuntime——那一份可能已经是别的 Bot 的了。
    let last = null
    while (Date.now() - startAt < 15000) {
      try {
        const rt = await api('GET', '/runtime/desktop?botId=' + encodeURIComponent(id))
        last = rt
        // 人在这十几秒里换了 Bot 的话，这一份就不能往 state 上写：desktopRuntime 是
        // remountDesktop 拿去挂屏的那一份，写进去等于把这个 Bot 的桌面挂到另一个
        // Bot 的对话页上（loadDesktopRuntime 里那道同样的门就是为这个立的）。
        if (chatBotIdNow() === id) {
          state.desktopRuntime = rt
          state.desktopRuntimeAt = Date.now()
        }
        if (rt.status === 'ready' || rt.status === 'error') break
      } catch {}
      await new Promise((r) => setTimeout(r, 400))
    }
    await loadRuntimeBots()
    if (state.chatBotId === id || chatBotIdOf(state.path) === id) {
      state.runtimeError = ''
      await ensureChatSession(id)
    }
    if (last && last.status === 'error') {
      state.deployHint = last.lastError || '部署失败'
    } else if (!state.runtimeError) {
      state.deployHint = ''
      flash('ok', '已部署')
    } else {
      state.deployHint = '已登记，实例还在上线'
    }
  } catch (err) {
    state.deployHint = err.message
    flash('err', err.message)
  } finally {
    state.deploying = false
    render()
  }
}


/* ── `@` 点名 ──────────────────────────────────────────────────────────
   输入框里打 `@` 弹选单，选中之后变成输入框上方的一颗药丸——**不是**往正文里塞一串
   字。点名是结构化的东西：它决定这一轮的工具表（`mentionOnly` 的连接只有被点名才
   出现），而一句「我提到了 Gmail」和「用户点名了这把连接」在进程那边是两回事。 */

/** 光标前面刚打出来的 `@xxx`。不在词首（前面挨着字母）不算，邮箱地址不该触发选单。 */
function mentionQueryAt(el) {
  if (!el) return null
  const pos = el.selectionStart ?? el.value.length
  const before = el.value.slice(0, pos)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  const prev = at > 0 ? before[at - 1] : ' '
  if (!/[\s(（]/.test(prev)) return null
  const word = before.slice(at + 1)
  if (/[\s\n]/.test(word)) return null
  return { at, q: word }
}

function closeMentionPick() {
  state.mentionPick = null
  paintMentionPick()
}

async function openMentionPick(q) {
  /**
   * **只在选单从关到开的那一下重拉候选**，不是每敲一个字拉一次，也不是一整页只拉一次。
   *
   * 一页只拉一次的话，人在另一个标签页刚连上的账号 `@` 不出来，只能刷新页面；每敲一个
   * 字拉一次又太吵。开合这一下正好：`/mentions` 就是两条查询，而人打开选单时本来就
   * 在等一小会儿。
   */
  const opening = !state.mentionPick
  state.mentionPick = { open: true, q, index: 0 }
  paintMentionPick()
  if (opening || !state.mentionOptions) {
    try {
      state.mentionOptions = (await api('GET', '/mentions')).mentions || []
    } catch {
      state.mentionOptions = state.mentionOptions || []
    }
    // 拉回来的时候人可能已经把选单关掉了（打了个空格）。那就别再画。
    if (state.mentionPick) paintMentionPick()
  }
}

/** 选中一个：把输入框里那截 `@xxx` 抹掉，改成上方的一颗药丸。 */
function takeMention(id) {
  const one = (state.mentionOptions || []).find((m) => m.id === id)
  if (!one) return
  const el = document.getElementById('chat-input')
  const hit = mentionQueryAt(el)
  if (el && hit) {
    const pos = el.selectionStart ?? el.value.length
    el.value = el.value.slice(0, hit.at) + el.value.slice(pos)
    el.selectionStart = el.selectionEnd = hit.at
    state.chatDraft = el.value
  }
  const picked = state.chatMentions || []
  if (!picked.some((m) => m.id === id)) state.chatMentions = picked.concat(one)
  closeMentionPick()
  paintChatMentions()
  el?.focus()
}

/* ── 斜杠命令 ─────────────────────────────────────────────────────────
 *
 * 一条命令 = **人对这条会话下的一次控制指令，不是发给模型的一句话**。它不进
 * `user/message`、不占 token、不开新的一轮，模型看不见它；走各自的 runtime 接口，
 * 落各自的会话事件，界面上画成一条分割线（见 docs/chat-commands.md）。
 *
 * 命令表是**本地常量，不走接口**：这两条是界面对席位发起的两次调用，不是席位提供的
 * 能力清单，为它多一跳只会让第一屏更慢。
 */
const CHAT_COMMANDS = [
  {
    name: 'compact',
    title: '压缩上下文',
    // 「会调用一次模型」要写出来：点一下是要花钱的，虽然不值得为它弹一个确认框。
    hint: '把更早的对话换成摘要，会调用一次模型',
    /** 这一轮在跑时能不能点。两条都不行，理由见 docs/chat-commands.md。 */
    idleOnly: true,
    run: (sessionId) => api('POST', '/runtime/sessions/' + encodeURIComponent(sessionId) + '/compact'),
  },
  {
    name: 'new',
    title: '开始新对话',
    hint: '从这里起不再带上前面的内容，记录不删',
    idleOnly: true,
    run: (sessionId) => api('POST', '/runtime/sessions/' + encodeURIComponent(sessionId) + '/reset'),
  },
]

/**
 * 输入框开头那条 `/xxx`。
 *
 * 判据比 `@` 严一档：**必须在最开头，而且后面只跟命令名**。斜杠在正文里太常见——
 * `/etc/hosts`、「他说的 /compact 是什么意思」、贴一段路径——那些都不该弹选单，
 * 更不该被当成命令执行。而命令本来就占满整条消息，不和正文混着发。
 */
function commandQueryAt(el) {
  if (!el) return null
  const pos = el.selectionStart ?? el.value.length
  const before = el.value.slice(0, pos)
  if (!/^\/[a-zA-Z-]*$/.test(before)) return null
  return { q: before.slice(1).toLowerCase() }
}

function closeCmdPick() {
  if (!state.cmdPick) return
  state.cmdPick = null
  paintCmdPick()
}

function openCmdPick(q) {
  state.cmdPick = { open: true, q, index: 0 }
  paintCmdPick()
}

function cmdMatches(q) {
  return CHAT_COMMANDS.filter((c) => !q || c.name.startsWith(q))
}

/** 命令选单。形状和 `@` 那个一样，共用 .sw-pickbox。 */
function paintCmdPick() {
  const box = document.getElementById('chat-cmdpick')
  if (!box) return
  const pick = state.cmdPick
  if (!pick) {
    box.hidden = true
    box.innerHTML = ''
    return
  }
  const list = cmdMatches(pick.q)
  if (!list.length) {
    box.hidden = true
    box.innerHTML = ''
    return
  }
  // 这一轮在跑时不能执行——**先标灰，别让人撞一次 409 才知道**。
  // 判据用 state.chatStatus：它是 paintChat 每帧算出来的那一份，`sending`（刚发出去、
  // 还没等到回执）也算在内——那时候一轮马上就要开始，压缩同样不该插进去。
  const busy = Boolean(state.chatStatus)
  const i = Math.min(pick.index || 0, list.length - 1)
  box.hidden = false
  box.innerHTML = list
    .map((c, n) => {
      const off = busy && c.idleOnly
      return `<button type="button" class="sw-pick${n === i ? ' is-on' : ''}${off ? ' is-off' : ''}"
        data-act="chat-cmd-pick" data-name="${esc(c.name)}"${off ? ' disabled' : ''}>
        <span class="sw-pick-name">/${esc(c.name)} · ${esc(t(c.title))}</span>
        <small>${esc(off ? t('等这一轮跑完') : t(c.hint))}</small>
      </button>`
    })
    .join('')
}

/** 从选单里选中一条：直接执行。命令没有「填进输入框再确认」这一步。 */
function takeCommand(name) {
  const one = CHAT_COMMANDS.find((c) => c.name === name)
  if (!one) return
  return runChatCommand(one)
}

/**
 * 这条草稿是不是一条命令。
 *
 * 三种结果：命中一条、`{ unknown }`（打了斜杠但不认识）、null（不是命令）。
 * **不认识的不能当普通消息发出去**——一个手滑的 `/copmact` 就发给模型了，它会礼貌地
 * 回一段「你是想…吗」，而人以为自己压缩过了。参数也一样不收：`/compact 只留三轮`
 * 当作不认识，不猜意图。
 */
function parseCommand(text) {
  const raw = String(text || '').trim()
  const first = raw.split(/\s+/)[0]
  /**
   * **命令名里不会有第二个斜杠。** 这一条把「整条消息就是一个路径」放行——
   * `/etc/hosts`、`/var/log/syslog` 是人真的会单独发过来的一句话（「看下这个文件」的
   * 省略说法），把它拦成「没有这条命令」纯属添乱。而 `/copmact` 这种仍然拦得住，
   * 那才是这道闸要防的。
   */
  if (!/^\/[a-zA-Z-]+$/.test(first)) return null
  const hit = CHAT_COMMANDS.find((c) => c.name === first.slice(1).toLowerCase())
  if (!hit) return { unknown: first }
  // 认得这条，但后面还跟着别的字。第一批两条都不收参数——**不猜意图**，
  // 也不把多出来的那半句悄悄丢掉。
  if (raw !== first) return { cmd: hit, extra: true }
  return { cmd: hit }
}

/**
 * 执行一条命令。
 *
 * 成功了**不清输入框以外的东西**：附件和 `@` 留在原地（命令不带它们，人多半是打完
 * 命令还要接着发那条消息）。结果由 SSE 推回来的那条事件画成分割线，这里只负责把
 * 「点了没反应」变成一句话。
 */
async function runChatCommand(cmd) {
  const sessionId = state.chatSessionId
  if (!sessionId) {
    flash('err', t('还没接上席位，等接上再试'))
    render()
    return
  }
  if (cmd.idleOnly && state.chatStatus) {
    flash('err', t('这一轮还在跑，等它跑完再试'))
    render()
    return
  }
  // 失败要把命令还回去（下面的 catch）。清空之前先留一份——同 sendChat 那条约定：
  // 一次 409 / 换版 404 不该让人重新把命令打一遍。
  const draft = state.chatDraft || '/' + cmd.name
  // 命令占满整条消息，走到这儿正文就该清掉了——它不会被发出去，留着只会让人再按一次。
  state.chatDraft = ''
  closeCmdPick()
  const input = document.getElementById('chat-input')
  if (input) {
    input.value = ''
    input.style.height = ''
  }
  state.chatCmdBusy = cmd.name
  paintChat()
  try {
    const r = await cmd.run(sessionId)
    if (r && r.compacted) {
      flash('ok', t('已压缩') + '：' + ctxNum(r.tokensBefore) + ' → ' + ctxNum(r.tokensAfter))
    } else if (r && r.reset) {
      flash('ok', t('已开始新对话，上面的内容不再进上下文'))
    }
    /**
     * **不在这里自己画那条线。** 席位紧接着会经 SSE 把 `session/compact` /
     * `session/reset` 推过来，fold 认得它。自己先垫一条的话，等真事件到了就是两条。
     *
     * 老席位不认这两条路：404 落到下面的 catch，翻成「版本还不支持」。
     */
  } catch (err) {
    // **把命令还回输入框。** 换版期间的 404、正跑着的 409、断线——这些都是过几秒
    // 再按一次就好的事，没道理让人重打一遍（finally 里的 render 会把它填回去）。
    state.chatDraft = draft
    // 席位那边每一种拒绝都带着一句能直接给人看的原话（正在跑、太短、排着队），
    // 原样显示，别翻成一句「操作失败」。
    flash('err', err.status === 404 ? t('这台席位的版本还不支持这条命令，升级后可用') : err.message)
  } finally {
    state.chatCmdBusy = ''
    paintChat()
    render()
  }
}

/** 取消一条排队的消息。已经开跑的席位回 409——那时如实说，不装作取消成功。 */
async function cancelQueued(id) {
  const sessionId = state.chatSessionId
  if (!sessionId) return
  try {
    await api('DELETE', `/runtime/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(id)}`)
    chatQueues.set(sessionId, (chatQueues.get(sessionId) || []).filter((r) => r.id !== id))
    paintChatQueue()
  } catch (err) {
    // 409 = 这一刻它正好被取出开跑了。把它从 dock 上撤下来——它已经不在队里了，
    // 接下来会以正常消息的样子从 SSE 上过来。
    chatQueues.set(sessionId, (chatQueues.get(sessionId) || []).filter((r) => r.id !== id))
    paintChatQueue()
    flash('err', err.status === 409 ? t('这条已经开始执行了') : err.message)
    render()
  }
}

/* ── 工具痕迹的悬浮窗 ────────────────────────────────────────────────────
 *
 * 药丸上只有「工具名 · 状态」，而人真正想知道的是**它拿什么参数跑的、跑出了什么**。
 * 失败的那几颗尤其——以前想知道为什么失败，只能去「导出记录」里翻整段 JSON。
 *
 * 浮层挂在 body 上，不放进气泡里：气泡有自己的圆角和 overflow，浮层长在里面会被裁掉
 * 一角；而且最后一条消息贴着输入框时，往上弹还是往下弹得按视口算，气泡内的坐标系
 * 算不出来。
 *
 * 鼠标移开有一小段宽限，且移到浮层上算「还在看」——否则一个能滚动的浮层，人刚要伸手
 * 去滚它就没了。
 */
const TOOLPOP_HIDE_MS = 160
const TOOLPOP_MAX_CHARS = 4000
let toolPop = null
let toolPopAnchor = null
let toolPopHost = null
let toolPopIndex = -1
let toolPopHideTimer = null

function toolPopEl() {
  if (toolPop) return toolPop
  toolPop = document.createElement('div')
  toolPop.className = 'sw-toolpop'
  toolPop.hidden = true
  toolPop.addEventListener('mouseenter', () => clearTimeout(toolPopHideTimer))
  toolPop.addEventListener('mouseleave', () => hideToolPop(TOOLPOP_HIDE_MS))
  document.body.appendChild(toolPop)
  return toolPop
}

/** 参数是 bot 那边 stringify 过的原串。能 parse 就缩进展示，不能就原样——不猜格式。 */
function prettyArgs(raw) {
  const text = String(raw == null ? '' : raw).trim()
  if (!text) return ''
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/** 超长就截断并说清楚截了多少。悄悄截掉会让人以为工具真的只输出了这么点。 */
function clip(text) {
  const s = String(text == null ? '' : text)
  if (s.length <= TOOLPOP_MAX_CHARS) return s
  return s.slice(0, TOOLPOP_MAX_CHARS) + '\n\n…（还有 ' + (s.length - TOOLPOP_MAX_CHARS) + ' 个字符，完整内容见「导出记录」）'
}

function toolPopBody(x) {
  if (x && x.approval) return approvalPopBody(x)
  const label = x.result == null ? t('调用中') : x.failed ? t('失败') : t('完成')
  const state_ = x.result == null ? 'running' : x.failed ? 'error' : 'done'
  const args = prettyArgs(x.args)
  const rows = [
    `<div class="sw-toolpop-head"><span class="sw-toolpop-name">${esc(x.name)}</span>` +
      `<span class="sw-toolpop-state" data-state="${state_}">${esc(label)}</span></div>`,
  ]
  // 参数为空是常事（now、ls 这种），那就不摆一个空框——空框看着像「读不出来」。
  if (args) rows.push(`<div class="sw-toolpop-k">${esc(t('参数'))}</div><pre>${esc(clip(args))}</pre>`)
  if (x.result == null) {
    rows.push(`<div class="sw-toolpop-wait">${esc(t('还在跑，结果出来后这里会填上'))}</div>`)
  } else {
    const out = String(x.result || '').trim()
    rows.push(
      `<div class="sw-toolpop-k">${esc(x.failed ? t('错误') : t('结果'))}</div>` +
        (out ? `<pre>${esc(clip(out))}</pre>` : `<div class="sw-toolpop-wait">${esc(t('（没有输出）'))}</div>`),
    )
  }
  return rows.join('')
}

/**
 * 收起来的那颗确认，展开之后要看到的东西：为什么要确认、当时批的是什么参数。
 *
 * 参数留在这里而不是留在气泡里，是因为**它只在被问起时才重要**：批的那一刻必须摊开，
 * 批完之后是一条痕迹。翻旧对话的人要的是「这一步谁点的头」，需要细看时再停一下鼠标。
 */
function approvalPopBody(a) {
  const label = (APPROVAL_CHIP_LABEL[a.state] || APPROVAL_CHIP_LABEL.denied)()
  const rows = [
    `<div class="sw-toolpop-head"><span class="sw-toolpop-name">${esc(a.name)}</span>` +
      `<span class="sw-toolpop-state" data-state="${a.state === 'approved' ? 'done' : 'error'}">${esc(label)}</span></div>`,
  ]
  if (a.reason) rows.push(`<div class="sw-toolpop-k">${esc(t('为什么要确认', 'Why approval was needed'))}</div><div>${esc(a.reason)}</div>`)
  /**
   * **改过要说出来，而且要说改了哪几格。**
   *
   * 下面摆的是最终那一份（席位在终态事件里给的就是改后的）。不写这一行的话，翻记录
   * 的人会以为模型起草的就是这个样子——而「这句话是谁写的」正是事后最要紧的问题。
   */
  if ((a.edited || []).length) {
    rows.push(
      `<div class="sw-toolpop-k">${esc(t('批准时改过', 'Edited before approving'))}</div><div>${esc(a.edited.join('、'))}</div>`,
    )
  }
  const fields = (a.form && a.form.fields) || []
  if (fields.length) {
    // 有表单就按表单摆（收件人 / 主题 / 正文），比一段带转义符的 JSON 好读得多。
    rows.push(
      `<div class="sw-toolpop-k">${esc(t('内容', 'Content'))}</div>` +
        fields
          .filter((f) => f.value)
          .map(
            (f) =>
              `<div class="sw-toolpop-field"><span>${esc(f.label)}</span>${
                f.multiline ? `<pre>${esc(clip(f.value))}</pre>` : `<div>${esc(f.value)}</div>`
              }</div>`,
          )
          .join(''),
    )
  } else {
    const args = prettyArgs(a.args)
    if (args) rows.push(`<div class="sw-toolpop-k">${esc(t('参数'))}</div><pre>${esc(clip(args))}</pre>`)
  }
  return rows.join('')
}

/**
 * 定位。先填内容再量高度——内容是刚换的，没量过就不知道往上弹放不放得下。
 * 放不下就翻到下面，两边都不够时贴住视口，宁可挡一点也不要跑到屏幕外面去。
 */
function placeToolPop(chip) {
  const pop = toolPopEl()
  const r = chip.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  pop.style.maxWidth = Math.min(520, vw - 24) + 'px'
  const box = pop.getBoundingClientRect()
  const above = r.top >= box.height + 12
  let top = above ? r.top - box.height - 8 : r.bottom + 8
  if (!above && top + box.height > vh - 8) top = Math.max(8, vh - box.height - 8)
  let left = r.left
  if (left + box.width > vw - 12) left = vw - 12 - box.width
  if (left < 12) left = 12
  pop.style.top = Math.max(8, top) + 'px'
  pop.style.left = left + 'px'
  pop.setAttribute('data-side', above ? 'top' : 'bottom')
}

function showToolPop(chip) {
  const x = chip.__tool
  if (!x) return
  clearTimeout(toolPopHideTimer)
  const pop = toolPopEl()
  // 同一颗药丸重复触发（鼠标在药丸里移动）就别重画了，否则滚动位置每帧都被重置。
  if (toolPopAnchor !== chip || pop.hidden) {
    toolPopAnchor = chip
    toolPopHost = chip.parentElement
    toolPopIndex = Number(chip.getAttribute('data-i'))
    pop.innerHTML = toolPopBody(x)
    pop.hidden = false
    placeToolPop(chip)
  }
}

function hideToolPop(delay) {
  clearTimeout(toolPopHideTimer)
  const run = () => {
    if (toolPop) toolPop.hidden = true
    toolPopAnchor = null
    toolPopHost = null
    toolPopIndex = -1
  }
  if (!delay) run()
  else toolPopHideTimer = setTimeout(run, delay)
}

/**
 * chips 重画之后把浮层接到新节点上。
 *
 * 节点是 innerHTML 整体换掉的，原来那个 anchor 已经脱离文档。按容器 + 下标重新认一次
 * ——「调用中 → 完成」正是人盯着它看的那一刻，那时候浮层闪没最难受。认不回来才关。
 */
function refreshToolPop() {
  if (!toolPop || toolPop.hidden) return
  if (toolPopAnchor && document.contains(toolPopAnchor)) return
  const list = toolPopHost ? toolPopHost.querySelectorAll('.sw-toolchip') : []
  const next = toolPopIndex >= 0 ? list[toolPopIndex] : null
  if (!next || !next.__tool) return hideToolPop(0)
  toolPopAnchor = next
  toolPop.innerHTML = toolPopBody(next.__tool)
  placeToolPop(next)
}

/**
 * 卡片上打的字，随手记进草稿表。
 *
 * 挂在 document 上而不是每张卡上：卡片是 innerHTML 换出来的，节点每次重画都是新的，
 * 挂在节点上的监听会跟着没。
 */
document.addEventListener('input', (e) => {
  const el = e.target instanceof Element ? e.target : null
  const key = el && el.getAttribute && el.getAttribute('data-edit')
  if (!key) return
  const callId = el.getAttribute('data-call') || ''
  approvalDrafts.set(draftKey(callId, key), el.value)
  // HTML 源码藏在折叠区里；一旦展开修改，预览必须马上跟上，否则人批准的是源码 A，
  // 眼睛最后检查的却还是旧预览 B。按 callId + 字段 key 精确找到这一格，避免同页几封
  // 待批邮件互相串内容。
  const card = el.closest('.sw-approval')
  const preview = card && [...card.querySelectorAll('[data-mail-preview]')].find((frame) =>
    frame.getAttribute('data-call') === callId && frame.getAttribute('data-preview-for') === key)
  if (preview) preview.setAttribute('srcdoc', emailPreviewDoc(el.value))
  /**
   * 改过之后「这次对话都批准」就不能点了。**当场变灰**，不等下一次重画——重画是别的
   * 事件驱动的，可能一直不来；而这颗按钮亮着，人点下去就是「把之后所有没人看过的信
   * 也一起放行」。席位那边也会把改过的这一次强制成 once（见 approvals.ts），
   * 这里变灰是让人看得见，不是唯一的一道。
   */
  // 选择器要和 approvalActs 里真正渲染出来的那颗对上：那颗是 `data-scope="turn"`
  // （范围早就从「这次对话」收成「这一轮」了），这里却一直在找 `session`——配不上，
  // 于是这段 disabled 从来没生效过。而重画那条路也指望不上：updateRow 的比对签名只看
  // waiting 的 callId 列表，改一个字段它不变，卡片不会重画。两道都空着的话，人改完
  // 内容还能点「这一轮都批准」，而席位那边会把改过的这次强制成 once——按钮承诺的事
  // 没发生，下一次同样的工具还会再问。
  const wide = card && card.querySelector('[data-act="chat-approve"][data-scope="turn"]')
  if (wide) {
    wide.disabled = true
    wide.title = t('这一次改过内容，只能批准这一次', 'You edited this one, so it can only be approved once')
  }
})

document.addEventListener('mouseover', (e) => {
  const el = e.target instanceof Element ? e.target : null
  if (!el) return
  const chip = el.closest('.sw-toolchip')
  if (chip) return showToolPop(chip)
  if (el.closest('.sw-toolpop')) return
  if (toolPop && !toolPop.hidden) hideToolPop(TOOLPOP_HIDE_MS)
})

// 键盘也要能看。药丸带 tabindex，Tab 到就出，离开就收。
document.addEventListener('focusin', (e) => {
  const el = e.target instanceof Element ? e.target : null
  const chip = el && el.closest('.sw-toolchip')
  if (chip) showToolPop(chip)
  else if (el && !el.closest('.sw-toolpop')) hideToolPop(0)
})

/**
 * 滚动时立刻收：浮层是 fixed 的，跟不上锚点，留在原地就是一块飘着的脏东西。
 *
 * **但浮层自己滚不算。** 结果那一段有自己的滚动区（`.sw-toolpop pre`，最高 220px），
 * 内容一长就得在里面滚着看——而这个监听器是捕获阶段挂在 window 上的，滚它也照收不误：
 * 手一动窗口就没了，长输出永远看不完。这里按事件源头分一下：源头在浮层里就不收。
 */
window.addEventListener(
  'scroll',
  (e) => {
    const el = e.target instanceof Element ? e.target : null
    if (el && el.closest('.sw-toolpop')) return
    hideToolPop(0)
  },
  true,
)
window.addEventListener('resize', () => hideToolPop(0))
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && toolPop && !toolPop.hidden) hideToolPop(0)
})
