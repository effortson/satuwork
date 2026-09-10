import type { IncomingMessage, ServerResponse } from 'node:http'
import { seats, type SeatRecord } from './seats.ts'
import { type CatchUp, type Frame, type Upstream, catchUpFrames, newCatchUp, remember, rosterFrame } from './roster-filter.ts'

/**
 * 名单那一条实时通道，**这台机器上的那一半**。
 *
 * 它原来整个在 Gateway 里（gateway/src/lib/roster-stream.ts，为什么要有它、边界在哪儿都
 * 写在那儿）。Gateway 要变成无状态的（docs/adr-gateway-vercel-neon.md），而这条通道是
 * 「按账号在进程内共享一套上游、留 30 秒宽限」——进程内状态，正是无状态的反面。好在它
 * 天然按机器切：一个账号的所有席位 Bot 都在同一台机器上（gateway-runtime.md §3.0），
 * 所以「这个人的所有 Bot 现在什么样」在这台机器上就能答全，不必经过任何人。
 *
 * 和 Gateway 那份的差别只有三处，其余逐字照搬：
 *
 *   · 键是 linuxUser 而不是 accountId——名册里只有前者，而它就是 sha256(accountId) 的前缀；
 *   · 上游是 127.0.0.1:<botPort>，票是名册里存的 `sat_`，不再有机器票那一层；
 *   · 哪些 Bot 归这个人，从名册里读，不问 Gateway。**本地 Bot（跑在员工电脑上的）不在
 *     这台机器上，也就不在这条流里**：Gateway 那侧看到账号有本地 Bot 时不给直连地址，
 *     整条名单照旧走 Gateway。
 */

/** 流上垫几轮历史。名单只要「最近说了什么」，一轮就够。 */
const TAIL_TURNS = 1
/** 心跳。让半死的连接被及时发现，也把攒在下游缓冲里的顶出去。 */
const BEAT_MS = 15_000
/** 上游断了之后的退避档位（毫秒）。到顶就一直用最后那一档，不放弃。 */
const BACKOFF = [500, 1000, 2000, 4000, 8000, 15_000, 30_000]
/** 连接活够这么久才算「真连上过」，退避档位归零（判据是活了多久，不是有没有连上）。 */
const ALIVE_MS = 10_000
/** 最后一个页面走掉之后，这套上游还留多久。治的是「刷新风暴」，见 Gateway 那份的注释。 */
const GRACE_MS = 30_000

interface Hub {
  key: string
  subs: Set<(frame: Frame) => void>
  bots: Map<string, CatchUp>
  ac: AbortController
  grace: ReturnType<typeof setTimeout> | null
}

const hubs = new Map<string, Hub>()

/** 这个人在这台机器上的席位：名册里 linuxUser 相同、且已经登记了席位票的那些。 */
function seatsOf(linuxUser: string): SeatRecord[] {
  return seats().filter((r) => r.linuxUser === linuxUser && r.gatewayToken)
}

function acquireHub(linuxUser: string): Hub {
  const found = hubs.get(linuxUser)
  if (found) {
    if (found.grace) {
      clearTimeout(found.grace)
      found.grace = null
    }
    ensureBots(found)
    return found
  }
  const hub: Hub = { key: linuxUser, subs: new Set(), bots: new Map(), ac: new AbortController(), grace: null }
  hubs.set(linuxUser, hub)
  ensureBots(hub)
  return hub
}

function releaseHub(hub: Hub) {
  if (hub.subs.size || hub.grace) return
  hub.grace = setTimeout(() => {
    if (hub.subs.size) return
    if (hubs.get(hub.key) === hub) hubs.delete(hub.key)
    try {
      hub.ac.abort()
    } catch {}
  }, GRACE_MS)
  hub.grace.unref?.()
}

/**
 * 期间可能新部署了 Bot，补上。**少掉的那些不主动收**：维护一张「谁还在」的账比让那套
 * 上游自己退避重连贵得多（席位拆了之后那条循环打的是一个没人听的端口，30 秒一档空转，
 * 直到这个账号的最后一个页面走掉、宽限期过、整个 hub 拆掉）。
 */
function ensureBots(hub: Hub) {
  for (const row of seatsOf(hub.key)) {
    if (hub.bots.has(row.botId)) continue
    hub.bots.set(row.botId, newCatchUp())
    void pump(hub, row.botId)
  }
}

function emit(hub: Hub, frame: Frame) {
  const cu = hub.bots.get(frame.botId)
  if (cu) remember(cu, frame)
  for (const write of hub.subs) {
    try {
      write(frame)
    } catch {
      /* 某个页面的 socket 坏了：它自己那条循环会收尾，别连累别的页面 */
    }
  }
}

/**
 * 一个 Bot 的上游循环：拿会话 → 开流 → 过滤转发 → 断了退避重来。每个 Bot 各跑各的。
 *
 * 端口和票**每一轮现读名册**：重新部署会换端口、换票，拿函数开头那份会一直敲旧口。
 */
async function pump(hub: Hub, botId: string) {
  const { ac } = hub
  const up: Upstream = { botId, sessionId: '', after: 0, lastTick: 0, attempt: 0 }
  while (!ac.signal.aborted) {
    let opened = false
    let openedAt = 0
    try {
      const row = seatsOf(hub.key).find((r) => r.botId === botId)
      if (!row) throw new Error('席位已不在名册')
      const base = `http://127.0.0.1:${row.botPort}`
      const headers = { authorization: `Bearer ${row.gatewayToken}`, accept: 'application/json' }
      if (!up.sessionId) {
        const r = await fetch(`${base}/api/bots/${encodeURIComponent(botId)}/session`, { headers, signal: ac.signal })
        if (!r.ok) throw new Error(`session ${r.status}`)
        const got = (await r.json()) as { sessionId?: string }
        if (!got?.sessionId) throw new Error('没有会话')
        up.sessionId = got.sessionId
      }
      const q = up.after > 0 ? `?after=${up.after}` : `?tail=${TAIL_TURNS}`
      const r = await fetch(`${base}/api/sessions/${encodeURIComponent(up.sessionId)}/events${q}`, {
        headers: { ...headers, accept: 'text/event-stream' },
        signal: ac.signal,
      })
      if (!r.ok || !r.body) throw new Error(`events ${r.status}`)
      opened = true
      openedAt = Date.now()
      await drain(r.body, up, (frame) => emit(hub, frame), () => ac.signal.aborted)
    } catch {
      if (ac.signal.aborted) return
    }
    if (ac.signal.aborted) return
    // 连 events 都没开起来：把会话 id 也扔掉，下一轮重新去问（席位重建会话是常态事件）。
    // 开起来过就说明这个 id 是好的，断在半路是网络的事，留着 after 才能补回错过的。
    if (!opened) {
      up.sessionId = ''
      up.after = 0
    }
    up.attempt = opened && Date.now() - openedAt >= ALIVE_MS ? 0 : up.attempt + 1
    await sleep(BACKOFF[Math.min(up.attempt, BACKOFF.length - 1)], ac.signal)
  }
}

/** 一个浏览器连接。挂上去听，走的时候把这套上游交还（可能进宽限期）。 */
export async function rosterStream(
  req: IncomingMessage,
  res: ServerResponse,
  linuxUser: string,
  extraHeaders: Record<string, string>,
) {
  const hub = acquireHub(linuxUser)

  res.writeHead(200, {
    ...extraHeaders,
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  })

  let done = () => {}
  const closed = new Promise<void>((resolve) => (done = resolve))
  const write = (frame: Frame) => {
    if (res.writableEnded || res.destroyed) return done()
    res.write(`data: ${JSON.stringify(frame)}\n\n`)
  }
  req.on('close', () => done())
  res.on('close', () => done())
  // 'close' 只发一次；进到这里之前有过 await（验票），快速刷新可能已经把请求中止掉了。
  // 漏掉这一句，这个 write 闭包会永远赖在 hub.subs 里，宽限期永远不进。
  if (req.destroyed || res.destroyed || res.writableEnded) done()

  hub.subs.add(write)
  // 先追平再听：中途接上是常态（每一次刷新都是）。
  try {
    for (const frame of catchUpFrames(hub.bots)) write(frame)
  } catch {
    done()
  }

  const beat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return done()
    try {
      res.write(': ping\n\n')
    } catch {
      done()
    }
  }, BEAT_MS)

  await closed
  clearInterval(beat)
  hub.subs.delete(write)
  releaseHub(hub)
  try {
    res.end()
  } catch {}
}

async function drain(body: ReadableStream<Uint8Array>, up: Upstream, write: (frame: Frame) => void, closed: () => boolean) {
  type RosterEvent = { type?: string; seq?: number; time?: number; live?: unknown }
  for await (const ev of sseEvents<RosterEvent>(body.getReader(), closed)) {
    if (closed()) return
    if (!ev || typeof ev !== 'object') continue
    const out = rosterFrame(ev, up)
    if (out) write(out)
  }
}

/** 同 gateway/src/lib/runtime.ts 的 sseEvents：一条 SSE 正文 → 一个个 JSON 事件。 */
async function* sseEvents<T>(reader: ReadableStreamDefaultReader<Uint8Array>, stop: () => boolean): AsyncGenerator<T> {
  const decoder = new TextDecoder()
  let buf = ''
  while (!stop()) {
    const { done, value } = await reader.read()
    if (done) return
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    let idx: number
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue
        try {
          yield JSON.parse(line.slice(6)) as T
        } catch {
          continue
        }
      }
    }
  }
}

/** 可中断的 sleep：连接一断就立刻醒，不然退避到 30 秒时会把请求吊那么久才收摊。 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}
