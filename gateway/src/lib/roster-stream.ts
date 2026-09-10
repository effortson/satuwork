/**
 * 名单那一条实时通道：**一个账号一套上游**——不是一个 Bot 一条，也不是一个页面一套。
 *
 * ── 为什么要有它 ────────────────────────────────────────────────────
 *
 * 侧栏名单要显示每个 Bot「在不在跑 / 最近说了什么 / 是不是在等你」，而这三样只能从
 * 会话事件里拿。最早的做法是**名单上每个 Bot 各开一条 SSE**，代价有两笔：
 *
 * 1. **连接槽。** HTTP/1.1 下浏览器对同一个源只给 6 条连接，而 SSE 是永不结束的
 *    fetch，开着就占死一条。十几个 Bot 直接把槽占光，这一页余下的请求——包括画出正文
 *    的那条 history——全部排在后面干等，刷新一次十几秒才见到消息。挂上 h2 反代能把这
 *    个上限抬掉（见 docs/gateway-runtime.md §7.1），但那只是让墙变远，不是把东西变小。
 * 2. **token 洪流。** 那几条流拿的是**全量**会话事件，包括每个 token 一条的
 *    `assistant/chunk`。10 个 Bot 同时干活，浏览器就在同时解析 10 路 token 流，画的是
 *    侧栏 10 行灰字。而名单对 chunk 做的**只有一件事**：把「最近活动时间」往前挪，
 *    那还是个 HH:MM 的钟。
 *
 * 收成一条通道平掉了这两笔。但**只收浏览器那一头是不够的**：
 *
 * 3. **刷新风暴。** 这里一开始是「一个浏览器连接一套上游」，理由是「两个标签页就是
 *    两套，和改之前一样，没有回退」。放在**快速刷新**这个场景下，那个判断是错的——
 *    刷新不是两个标签页，是同一个人在一秒内把十几套上游订阅建了又拆。线上抓到的席位
 *    日志就长这样：一秒两条 `after=0, tail=1, 重放 19 条`，连着刷七秒。
 *
 * 所以现在按**账号**共享一套上游，最后一个页面走掉之后还留 GRACE_MS 的宽限期：一次
 * 刷新落在宽限期里，直接接上还活着的那套，**席位侧一条重放都不用放**。
 *
 * ── 边界 ────────────────────────────────────────────────────────────
 *
 * · **只喂摘要，不喂正文。** 帧里的事件是过滤过的，凑不成一条完整的会话——客户端拿
 *   它更新 `sum`，**绝不能倒进事件桶**，否则点进那个 Bot 会看到一段缺了正文的历史。
 *   正文照旧走 per-session 那条流（人点进去时才开）。
 * · **席位那边一行都没改。** Gateway 订的就是席位现成的 `/api/sessions/:id/events`，
 *   过滤和折叠都在这一层做。这样十几台席位不用跟着发版（发布包只能在 Linux arm64 打，
 *   见 docs/local-release.md），上线风险低得多。
 * · **共享带来一个新问题：后来的人看不到之前的帧。** 通道只在事情发生时发帧，而新接
 *   上的页面要的是「现在是什么样」。所以每套上游留一份**追平集**——见 CatchUp。
 */
import type { ServerResponse } from 'node:http'
import type { Account, Db } from '../db.ts'
import type { Req } from '../http.ts'
import { machineHeader, seatBearer, seatTargetFor, sseEvents } from './runtime.ts'
import { type CatchUp, type Frame, type Upstream, catchUpFrames, newCatchUp, remember, rosterFrame } from './roster-filter.ts'

/** 流上垫几轮历史。名单只要「最近说了什么」，一轮就够。 */
const TAIL_TURNS = 1

/** 心跳。理由和席位那条一字不差：让半死的连接被及时发现，也把攒在下游缓冲里的顶出去。 */
const BEAT_MS = 15_000

/** 上游断了之后的退避档位（毫秒）。到顶就一直用最后那一档，不放弃。 */
const BACKOFF = [500, 1000, 2000, 4000, 8000, 15_000, 30_000]

/**
 * 连接活够这么久才算「真连上过」，退避档位归零。
 *
 * 判据是**这次连接活了多久**，不是「有没有连上」：只看后者的话，一个接受连接后立刻
 * 断的席位（崩溃重启循环里就是这样）会让档位每次归零，于是每 500ms 重连一次、永远
 * 停不下来。前端那条流为同一件事有 CHAT_ALIVE_MS，一模一样的道理。
 */
const ALIVE_MS = 10_000

/**
 * 最后一个页面走掉之后，这套上游还留多久。
 *
 * **这一条就是治「刷新风暴」的。** 刷新是「断开 + 两百毫秒后重新连上」，当场拆的话，
 * 每刷新一次就要把这个账号的十几套上游全部重建，而每一次重建都是席位那边一次
 * `tail=1` 重放。留着就好，下一个页面直接接上。30 秒顺带也盖住了切页面和短暂断网。
 */
const GRACE_MS = 30_000

interface Hub {
  key: string
  db: Db
  account: Account
  subs: Set<(frame: Frame) => void>
  bots: Map<string, CatchUp>
  ac: AbortController
  grace: ReturnType<typeof setTimeout> | null
}

const hubs = new Map<string, Hub>()

function acquireHub(db: Db, account: Account, botIds: string[]): Hub {
  const found = hubs.get(account.id)
  if (found) {
    if (found.grace) {
      clearTimeout(found.grace)
      found.grace = null
    }
    // 期间可能新建了 Bot，补上。**少掉的那些不主动收**：维护一张「谁还在」的账比让
    // 那套上游自己退避重连贵得多，而删掉 Bot 之后这一页本来也要重开。
    ensureBots(found, botIds)
    return found
  }
  const hub: Hub = {
    key: account.id,
    db,
    account,
    subs: new Set(),
    bots: new Map(),
    ac: new AbortController(),
    grace: null,
  }
  hubs.set(account.id, hub)
  ensureBots(hub, botIds)
  return hub
}

function releaseHub(hub: Hub) {
  if (hub.subs.size || hub.grace) return
  // **不当场拆，留 GRACE_MS**（见 GRACE_MS）。
  hub.grace = setTimeout(() => {
    if (hub.subs.size) return
    // 只有还挂在册上的才拆：期间可能已经被别的路径换掉了。
    if (hubs.get(hub.key) === hub) hubs.delete(hub.key)
    try {
      hub.ac.abort()
    } catch {}
  }, GRACE_MS)
  // 一个挂着的定时器不该拽住进程（e2e 里尤其明显）。Node 里有 unref，浏览器里没有。
  hub.grace.unref?.()
}

function ensureBots(hub: Hub, botIds: string[]) {
  for (const botId of botIds) {
    if (hub.bots.has(botId)) continue
    hub.bots.set(botId, newCatchUp())
    void pump(hub, botId)
  }
}

/** 往这个账号所有还连着的页面发一帧，顺带记进追平集。 */
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
 * 一个 Bot 的上游循环：拿会话 → 开流 → 过滤转发 → 断了退避重来。
 *
 * **每个 Bot 各跑各的，一个连不上不影响别人**——席位是一个 Bot 一个进程，十几个里
 * 有一个正在换版是常态。
 */
async function pump(hub: Hub, botId: string) {
  const { db, account, ac } = hub
  const up: Upstream = { botId, sessionId: '', after: 0, lastTick: 0, attempt: 0 }
  while (!ac.signal.aborted) {
    /** 这一轮到底有没有把 events 那条流开起来。见下面「会话 id 可能已经不作数了」。 */
    let opened = false
    let openedAt = 0
    try {
      const target = await seatTargetFor(db, account, botId)
      const tok = await seatBearer(db, account.id)
      const headers = {
        authorization: tok ? `Bearer ${tok}` : '',
        accept: 'application/json',
        ...machineHeader(target.machineToken),
      }
      if (!up.sessionId) {
        const r = await fetch(`${target.host}/api/bots/${encodeURIComponent(botId)}/session`, {
          headers,
          signal: ac.signal,
        })
        if (!r.ok) throw new Error(`session ${r.status}`)
        const got = (await r.json()) as { sessionId?: string }
        if (!got?.sessionId) throw new Error('没有会话')
        up.sessionId = got.sessionId
      }
      const q = up.after > 0 ? `?after=${up.after}` : `?tail=${TAIL_TURNS}`
      const r = await fetch(`${target.host}/api/sessions/${encodeURIComponent(up.sessionId)}/events${q}`, {
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
    /**
     * **连 events 都没开起来：把会话 id 也扔掉，下一轮重新去问。**
     *
     * 会话 id 是缓存下来的（`if (!up.sessionId)`），而「席位把会话重建了」在这个系统
     * 里是**常态事件**，不是意外——席位重装、换机器、手工清过库都会（正文那一路为此
     * 专门有 resetBotStream / seatRestarted / hydrateChat 的 `sessionId` 闸）。旧 id
     * 一旦不存在，这条 events 每次都非 2xx，而重试拿的还是同一个 id：这个 Bot 的名单
     * 行就以 30 秒一档永远空转下去，冻在重启前那一刻，**而且任何地方都不报错**。
     *
     * **只在没开起来时扔。** 开起来过就说明这个 id 是好的，断在半路是网络的事——那时
     * 候留着 `after` 才能把断线期间错过的补回来。
     */
    if (!opened) {
      up.sessionId = ''
      up.after = 0
    }
    up.attempt = opened && Date.now() - openedAt >= ALIVE_MS ? 0 : up.attempt + 1
    await sleep(BACKOFF[Math.min(up.attempt, BACKOFF.length - 1)], ac.signal)
  }
}

/** 一个浏览器连接。挂上去听，走的时候把这套上游交还（可能进宽限期）。 */
export async function rosterStream(req: Req, res: ServerResponse, db: Db, account: Account, botIds: string[]) {
  const hub = acquireHub(db, account, botIds)

  res.writeHead(200, {
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
  /**
   * **挂完监听要立刻补一次判定。**
   *
   * `'close'` 只发一次，之后再挂监听就永远等不到。而这条路由在进到这里之前有两个
   * await（requireUser、db.botsFor），**快速刷新恰好会在那期间把请求中止掉**——那时
   * 'close' 已经发过了。漏掉这一句的后果不是少收几帧，而是这个 write 闭包永远赖在
   * hub.subs 里：`await closed` 不落地，releaseHub 开头那句 `if (hub.subs.size) return`
   * 于是永远不进宽限期，这个账号的十几套上游一直跑一直重连。要等某个 Bot 下次发帧、
   * write 撞见 res.destroyed 才自愈，而空闲账号可能是几小时。
   */
  if (req.destroyed || res.destroyed || res.writableEnded) done()

  hub.subs.add(write)
  /**
   * **先追平再听。**
   *
   * 共享之后「中途接上」是常态（每一次刷新都是），不追平的话侧栏会空着等下一件事发生
   * ——而下一件事可能是几小时以后。
   */
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

/** 读一条上游 SSE，把名单要的那几帧转出去。返回即代表这条上游断了。 */
async function drain(
  body: ReadableStream<Uint8Array>,
  up: Upstream,
  write: (frame: Frame) => void,
  closed: () => boolean,
) {
  type RosterEvent = { type?: string; seq?: number; time?: number; live?: unknown }
  for await (const ev of sseEvents<RosterEvent>(body.getReader(), closed)) {
    // 连接是在 read() 等着的时候断的：那一刻已经在路上的这一块照样会到。不在这儿
    // 再判一次，就会往一条已经收摊的响应上写。
    if (closed()) return
    if (!ev || typeof ev !== 'object') continue
    const out = rosterFrame(ev, up)
    if (out) write(out)
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
