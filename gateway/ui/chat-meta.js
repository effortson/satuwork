/** 输入框周边的几样状态：「正在停止」、上下文占了多少、日常模型选择器，外加导出全文。原先在 chat.js 里，拆出来只是搬家（顺序见 index.html）。 */
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
  return busy ? t('正在思考…（现在发的消息会等这一轮结束再发）') : t('Enter 发送，Shift + Enter 换行')
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
  setBotAvatarRunning(document.getElementById('chat-avatar'), botIsWorking(chatBotOf(), busy))
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
  paintSendFace(busy)
  /**
   * 页面整体重绘（render）会把输入框上面那两个选单的框换成新的、默认 hidden 的，而选单状态还挂着：
   * Bot 在跑时重绘很勤，人打了 `/clear` 选单一闪就没了（手机上尤其明显，没有回车去兜底）。
   * 框是隐藏的、状态却开着，就补画一次；开着的不重画——每帧重画会把人正要点的那一项换掉。
   */
  const cmdBox = document.getElementById('chat-cmdpick')
  if (state.cmdPick && cmdBox && (cmdBox.hidden || cmdBox.getAttribute('data-busy') !== String(busy))) paintCmdPick()
  const mentBox = document.getElementById('chat-mentionpick')
  if (state.mentionPick && state.mentionPick.open && mentBox && mentBox.hidden) paintMentionPick()
  // 名单上的时间/摘要/转圈由 paintRoster 管——它认每个 Bot 自己那条流，
  // 不再只看当前这一条。
  paintRoster()
  const jump = document.getElementById('chat-jump')
  const thread = document.getElementById('chat-thread')
  if (jump && thread) jump.hidden = nearBottom(thread)
  paintChatCtx()
  paintChatModel(folded)
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
 *
 * 百万档不带小数、向下取：1,050,000 的窗口带一位小数会进位成「1.1M」，四舍五入也会
 * 把 1.5M 写成 2M——都比实际大。宁可说小，不说大。
 */
function ctxNum(n) {
  const v = Math.max(0, Math.round(Number(n) || 0))
  if (v >= 1000000) return Math.floor(v / 1000000) + 'M'
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

/* ── 日常模型选择器（docs/model-choice.md）──────────────────────────────
 *
 * 平台给一个默认的日常模型和几个备选；人给自己和这颗 Bot 的这条会话挑一个。挑选落在
 * 席位的会话上（`session/model` 事件），Telegram 里的 `/model` 写的是同一条，所以这边
 * 的状态**以席位为准**：先 GET 一份快照，之后看到新的 `session/model` 事件就再取一次
 * ——事件里只有 key 和名字，名单和「现在生效的是哪个」还是得席位说。
 *
 * **平台改了名单，席位一分钟内就跟上，但席位不会发 `session/model` 事件**——那份名单不是这条
 * 会话的事。所以快照还得自己过期：取到之后 CHAT_MODEL_TTL_MS 再重取一次；人点开选择器时不管
 * 过没过期都当场重取（chatModelOpen），挑的那一刻看到的一定是席位眼下的名单。以前两样都没有，
 * 网页刷新一下就好，桌面端的窗口一开几天，就一直挂着打开时那份。
 *
 * 快照按会话存：`{ data, upto, at }`，取不到时是 `{ failedAt, retryMs }`。404 多半是席位
 * 还不认这条路（老版本），但席位随时可能在人开着页面时升级，所以也只是隔久一点再问，
 * 不是永远不问。paintChat 一秒能跑好几次，重试一律按时间节流。
 */
const chatModelSnap = new Map()
const chatModelSyncing = new Set()
const CHAT_MODEL_RETRY_MS = 30_000
/** 一份好快照用多久。只决定「选择器上那个名字」多久对一次，挑之前另有 chatModelOpen 当场重取。 */
const CHAT_MODEL_TTL_MS = 5 * 60_000
/** 404 之后多久再问一次：够盖过一次换版，又不至于让升级之后的选择器迟迟不出来。 */
const CHAT_MODEL_UNSUPPORTED_RETRY_MS = 5 * 60_000

/** 这份事件里最后一条 `session/model` 的 seq。只在发请求时算一次；每一帧用 fold 记下的那个。 */
function lastModelSeq(events) {
  for (let i = (events || []).length - 1; i >= 0; i--) {
    if (events[i].type === 'session/model') return Number(events[i].seq) || 0
  }
  return 0
}

function chatModelDue(snap) {
  if (!snap) return false
  if (snap.failedAt) return Date.now() - snap.failedAt > snap.retryMs
  return Boolean(snap.data && Date.now() - (snap.at || 0) > CHAT_MODEL_TTL_MS)
}

async function syncChatModel(sessionId, force) {
  if (!sessionId || chatModelSyncing.has(sessionId)) return
  const snap = chatModelSnap.get(sessionId)
  if (snap && !force && !chatModelDue(snap)) return
  chatModelSyncing.add(sessionId)
  // 水位取在发请求之前：请求在路上时又来一条换模型的事件，它的 seq 会比水位新，下一帧重取。
  const upto = state.chatSessionId === sessionId ? lastModelSeq(state.chatEvents) : 0
  try {
    const data = await api('GET', `/runtime/sessions/${encodeURIComponent(sessionId)}/model`)
    chatModelSnap.set(
      sessionId,
      data && Array.isArray(data.options)
        ? { data, upto, at: Date.now() }
        : { failedAt: Date.now(), retryMs: CHAT_MODEL_UNSUPPORTED_RETRY_MS, upto },
    )
  } catch (err) {
    const retryMs = err.status === 404 ? CHAT_MODEL_UNSUPPORTED_RETRY_MS : CHAT_MODEL_RETRY_MS
    // 手上那份好的别扔：一次拉失败不该让已经画出来的选择器消失。
    const prev = snap && snap.data ? snap : null
    chatModelSnap.set(sessionId, { ...(prev || {}), failedAt: Date.now(), retryMs, upto: prev ? prev.upto : upto })
  } finally {
    chatModelSyncing.delete(sessionId)
    if (state.chatSessionId === sessionId) paintChatModel()
  }
}

/**
 * 画选择器。`folded` 是 paintChat 这一帧的结果——只有带着它的那一路才判「要不要重取」，
 * 点开 / 关上浮层这类只换显示的调用不带，也就不会顺手发请求。
 */
function paintChatModel(folded) {
  const box = document.getElementById('chat-model')
  if (!box) return
  const sid = state.chatSessionId
  const snap = sid ? chatModelSnap.get(sid) : null
  if (sid && folded) {
    if (!snap || chatModelDue(snap)) void syncChatModel(sid, false)
    else if (snap.data && !snap.failedAt && (folded.modelSeq || 0) > snap.upto) void syncChatModel(sid, true)
  }
  const data = snap && snap.data
  // 只有一个可选、也没挑过：没得换，不占输入框那一行的位置。挑过的即使名单缩成一个也要画，
  // 否则人看不出这条对话此刻用的是哪个。
  if (!data || (data.options.length < 2 && !data.picked)) {
    box.hidden = true
    state.chatModelOpen = false
    return
  }
  box.hidden = false
  const chip = document.getElementById('chat-model-chip')
  const pop = document.getElementById('chat-model-pop')
  if (!chip || !pop) return
  chip.textContent = data.effective.label + ' ▾'
  chip.title = t('日常模型：', 'Daily model: ') + data.effective.key
  chip.setAttribute('aria-expanded', String(Boolean(state.chatModelOpen)))
  pop.hidden = !state.chatModelOpen
  if (state.chatModelOpen) pop.innerHTML = chatModelPop(data)
}

/**
 * 点开选择器：先拿手上那份画出来，同时当场向席位重取一次，取回来 syncChatModel 会再画一遍。
 * 人一般只在要换模型时才点开它，多一个请求换「挑的那一刻名单是对的」，划算。
 */
function openChatModel() {
  state.chatModelOpen = true
  paintChatModel()
  if (state.chatSessionId) void syncChatModel(state.chatSessionId, true)
}

function chatModelPop(data) {
  const rows = data.options
    .map((c) => {
      const on = c.key === data.effective.key
      const bits = []
      if (c.isDefault) bits.push(t('默认'))
      if (c.reasoning) bits.push(t('推理'))
      if (c.contextWindow) bits.push(tokens(c.contextWindow))
      return `<button type="button" class="sw-pick${on ? ' is-on' : ''}" role="option" aria-selected="${on}"
        data-act="chat-model-pick" data-key="${esc(c.key)}" title="${esc(c.key)}">
        <span class="sw-pick-name">${on ? '✓ ' : ''}${esc(c.label)}</span>
        <small>${esc(bits.join(' · '))}</small>
      </button>`
    })
    .join('')
  // 跑着的时候照样能挑，但得说清楚这一轮不会变——不然人会以为下一句回答就是新模型写的。
  const note = state.chatStatus
    ? t('这一轮跑完后生效', 'Takes effect after this turn')
    : t('从下一条消息起生效，也可以输入 /model 切换', 'Applies from your next message; /model works too')
  return `${rows}<p class="sw-modelnote">${esc(note)}</p>`
}

/**
 * 换模型。`body` 是 `{ key }`（点选的那一项，null = 回默认）或 `{ arg }`（`/model` 后面
 * 打的那截，由席位按和 Telegram 同一份规则去认）。返回给人看的那句提示；失败照原话抛。
 */
async function setChatModel(sessionId, body) {
  const r = await api('PUT', `/runtime/sessions/${encodeURIComponent(sessionId)}/model`, body)
  chatModelSnap.set(sessionId, { data: r, upto: lastModelSeq(state.chatEvents), at: Date.now() })
  if (state.chatSessionId === sessionId) paintChatModel()
  const label = (r && r.effective && r.effective.label) || body.key || ''
  if (!r || !r.changed) return t(`已经在用 ${label}`, `Already using ${label}`)
  return r.nextTurn
    ? t(`这一轮跑完后换成 ${label}`, `Switching to ${label} after this turn`)
    : t(`已切换到 ${label}`, `Switched to ${label}`)
}

async function pickChatModel(key) {
  const sid = state.chatSessionId
  state.chatModelOpen = false
  paintChatModel()
  if (!sid) return
  try {
    flash('ok', await setChatModel(sid, { key }))
  } catch (err) {
    flash('err', err.status === 404 ? t('这台席位的版本还不支持切换模型，升级后可用') : err.message)
  }
  render()
}

/**
 * `/model`：不带参数打开选择器；带参数（序号、`default`、key、模型 id、显示名）原样交给
 * 席位去认——认的规则只有席位那一份（和 Telegram 共用），认不出来的那句错也是它给的。
 */
async function modelCommand(sessionId, arg) {
  if (String(arg || '').trim()) return { modelSwitched: await setChatModel(sessionId, { arg: String(arg).trim() }) }
  const snap = chatModelSnap.get(sessionId)
  const data = snap && snap.data
  if (!data) {
    throw new Error(snap && snap.retryMs === CHAT_MODEL_UNSUPPORTED_RETRY_MS
      ? t('这台席位的版本还不支持切换模型，升级后可用')
      : t('还没取到可选的模型，过几秒再试'))
  }
  if (data.options.length < 2) throw new Error(t('平台目前只配了一个日常模型，没有可换的'))
  openChatModel()
  return null
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
    // 引用：回复写成一段引文，文件写成一行路径。导出的这份是事后复盘用的，「当时指的是哪条」要看得出来。
    for (const r of b.refs || []) {
      if (r.kind === 'file') out.push('- ' + t('引用', 'Quoted') + ' `' + r.path + '`')
      else out.push('> ' + t('引用', 'Quoted') + ' ' + (r.role === 'user' ? me : title) + (r.time ? ' · ' + fmtTime(r.time) : '') + '：' + r.excerpt)
    }
    if ((b.refs || []).length) out.push('')
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
  return saveBlob(new Blob([text], { type: type || 'text/plain;charset=utf-8' }), name)
}
