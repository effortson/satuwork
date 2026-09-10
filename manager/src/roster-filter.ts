/**
 * **这是 gateway/src/lib/roster-filter.ts 的逐字副本。** 管家包 import 不到 gateway 的
 * 源（那个包没有 exports，见 manager/src/http.ts 文件头），而名单流下沉到这台机器之后，
 * 过滤规则在两边都要跑。规则本身是纯的、不 import 任何东西，抄一份的代价只是「会漂」——
 * e2e/roster-stream.mjs 里有一条用例按字节比对两份文件，漂了当场就红。改规则请改 gateway
 * 那一份，然后把这一份整个覆盖掉。
 */
/**
 * 名单通道的过滤规则：一条席位事件 → 要不要往浏览器转、转成什么。
 *
 * **单独一个文件、不 import 任何东西**，为的是能被 e2e 直接 import 跑（node 的
 * strip-only 模式带不动 db.ts 那种带参数属性的 TS）。规则本身也确实是纯的——它是这条
 * 通道的全部要点，值得能一条条钉住（见 e2e/roster-stream.mjs）。
 *
 * 通道为什么存在、边界在哪儿，见同目录的 roster-stream.ts 开头。
 */

/**
 * 名单真正消费的那几种事件（对着 chat.js 的 noteBotEvent 一条条数出来的）。
 *
 * 别的一律不转发。最要紧的是**没有 `assistant/chunk`**：一轮回答几百上千条，而名单
 * 拿它只是把时间往前推——那件事由下面的节流 tick 代劳。
 */
const ROSTER_TYPES = new Set([
  'turn/start',
  'turn/end',
  'human/handoff',
  'tool/approval',
  'user/message',
  'assistant/message',
])

/**
 * 流式期间「最近活动」最多多久往前推一次。
 *
 * 不推的话，一轮答两分钟，名单上那一行的时间会停在提问那一刻，看着像卡住了（原来
 * 靠每条 chunk 推，那是拿一千条帧换一个 HH:MM 的钟）。20 秒对分钟精度绰绰有余。
 */
const TICK_MS = 20_000

export interface Upstream {
  botId: string
  sessionId: string
  /** 断线续传用的游标。**过滤前的 seq**，否则被滤掉的那些会被当成没收到而重发。 */
  after: number
  lastTick: number
  attempt: number
}

/** 一条上游事件 → 要不要往浏览器转，转成什么。顺带把游标和节流状态推进。 */
export function rosterFrame(
  ev: { type?: string; seq?: number; time?: number; live?: unknown },
  up: Upstream,
): { type: string; botId: string; ev?: unknown; live?: boolean } | null {
  // 游标按**过滤前**的 seq 走：滤掉的那些也算「见过了」，否则每次重连都要把它们再拉
  // 一遍，而它们恰恰是最多的那一批（chunk）。
  if (typeof ev.seq === 'number' && ev.seq > up.after) up.after = ev.seq

  /**
   * 席位表态「这条会话此刻在不在跑」。**这一句是权威**，压过按事件扫出来的结论——
   * 席位崩在半路时日志里有 turn/start 没 turn/end，只扫事件的话那颗点会永远转下去
   * （和 chat.js 里 chatLive 治的是同一个病）。
   */
  if (ev.type === 'replay/done') {
    return typeof ev.live === 'boolean' ? { type: 'roster/live', botId: up.botId, live: ev.live } : null
  }
  if (ev.type === 'assistant/chunk') {
    // 折成一个节流过的时间戳（见 TICK_MS）。形状照着真事件写，客户端那边 noteBotEvent
    // 一行都不用改。
    const at = Number(ev.time) || 0
    if (!at || at - up.lastTick < TICK_MS) return null
    up.lastTick = at
    return { type: 'roster/ev', botId: up.botId, ev: { type: 'assistant/chunk', time: at } }
  }
  if (!ev.type || !ROSTER_TYPES.has(ev.type)) return null
  return { type: 'roster/ev', botId: up.botId, ev }
}

export type Frame = { type: string; botId: string; ev?: unknown; live?: boolean }

/**
 * 一个 Bot 的「追平集」：**新接上的页面要先看到的那几帧**。
 *
 * 通道只在事情发生时发帧，所以中途接上的人什么都拿不到——共享上游之后这不再是边角
 * 情况，而是**每一次刷新**的常态。
 *
 * 留的仍然是**原样的帧**，不是另算一份摘要：客户端把它们喂给同一个 noteBotEvent，
 * 折出来的 `sum` 和一路听下来的完全一致。这一层不解释任何状态——
 *
 * · 消息帧留最近几条（「最近说了什么」由客户端自己从里面折）；
 * · 交接和确认**按 id 留最后一条，不管那一条是开还是关**：客户端收到一条「已关闭」
 *   做的是 `delete(id)`，在一个本来就没有它的集合上删是空操作，结果一样对。这样这
 *   一层就不必知道哪些状态算「还开着」——那种知识一旦抄成两份，迟早分叉。
 */
export interface CatchUp {
  msgs: Frame[]
  /**
   * 最后一条折过的 chunk tick。
   *
   * **一轮正跑着的时候，它是唯一在推「最近活动」那个钟的东西**——那会儿还没有新的
   * 消息帧。不留的话，一次刷新会让侧栏那一行的时间退回到提问那一刻，而没刷新的另一
   * 个标签页显示的是当前分钟，两边从此对不上，直到这一轮吐出一条消息才被纠正。
   *
   * 消息帧一到就把它清掉（见 remember）：那一步收口了，tick 就过期了，留着会让
   * `lastAt` 往回跳（noteBotEvent 那一支是无条件赋值）。
   */
  tick: Frame | null
  turn: Frame | null
  byId: Map<string, Frame>
  live: Frame | null
}

/** 消息帧留几条。够客户端折出「最近说了什么」，又不至于让长期挂着的 hub 长胖。 */
const CATCH_MSGS = 4
/** 交接 / 确认按 id 留多少条。超了丢最旧的——丢掉的多半是早就收口的那些。 */
const CATCH_IDS = 50

export function idOf(frame: Frame): string {
  const ev = frame.ev as { type?: string; data?: { id?: unknown; callId?: unknown } } | undefined
  const d = ev?.data
  if (!d) return ''
  const raw = ev?.type === 'human/handoff' ? d.id : d.callId
  return typeof raw === 'string' && raw ? `${ev?.type}:${raw}` : ''
}

export function remember(cu: CatchUp, frame: Frame) {
  if (frame.type === 'roster/live') {
    cu.live = frame
    return
  }
  const type = (frame.ev as { type?: string } | undefined)?.type
  if (type === 'turn/start' || type === 'turn/end') {
    cu.turn = frame
    return
  }
  if (type === 'human/handoff' || type === 'tool/approval') {
    const id = idOf(frame)
    if (!id) return
    // 先删再塞：Map 是插入序，这样「丢最旧的」丢的就是最久没动静的那一条。
    cu.byId.delete(id)
    cu.byId.set(id, frame)
    while (cu.byId.size > CATCH_IDS) cu.byId.delete(cu.byId.keys().next().value as string)
    return
  }
  if (type === 'assistant/chunk') {
    cu.tick = frame
    return
  }
  if (type === 'user/message' || type === 'assistant/message') {
    cu.msgs.push(frame)
    while (cu.msgs.length > CATCH_MSGS) cu.msgs.shift()
    // 这一步收口了，上一条 tick 就过期了（见 CatchUp.tick）。
    cu.tick = null
  }
}

/**
 * 追平的发送顺序。
 *
 * `roster/live` **排在最后**：它是席位对「在不在跑」的权威表态，压过 turn 事件扫出来
 * 的结论（席位崩在半路时，日志里有 turn/start 没 turn/end）。先 turn 后 live，客户端
 * 那边 settleDot 算出来的才是对的。
 */
export function* catchUpFrames(bots: Map<string, CatchUp>): Generator<Frame> {
  for (const cu of bots.values()) {
    for (const f of cu.byId.values()) yield f
    for (const f of cu.msgs) yield f
    // tick 排在消息之后：它记的是「这一轮还在动」，比最后那条消息新。
    if (cu.tick) yield cu.tick
    if (cu.turn) yield cu.turn
    if (cu.live) yield cu.live
  }
}

/** 一个 Bot 的空追平集。 */
export function newCatchUp(): CatchUp {
  return { msgs: [], tick: null, turn: null, byId: new Map(), live: null }
}
