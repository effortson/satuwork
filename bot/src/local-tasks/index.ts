import type { Context } from '@deepseek-ai/cordis'
import { gatewayToken, gatewayUrl } from '../llm/gateway.ts'
import { ProgressTracker } from '../agent/progress.ts'

/**
 * 本地 Bot（桌面端）自己领主 Bot 派的活（docs/bot-tasks.md §2.2）。
 *
 * Gateway 连不到员工的电脑，所以派给本地 Bot 的活、以及要送回本地主 Bot 的结论，都由这颗进程
 * 自己来领：`/runtime/local-tasks/*`，凭自己的席位票，只领得到自己账号的。一次跑的顺序和机器上
 * 的工人（manager/src/worker/tasks.ts）一字不差：
 *
 *   run      问会话 id → started → 读游标 → 先挂流再发消息 → 只认自己那一轮的 turn/end，顺手收下
 *            那一轮的 assistant/message 正文 → finish 带 result
 *   deliver  发进主 Bot 的会话就算送到 → finish
 *
 * 和 local-routines 是两份几乎一样的代码。**故意的**：两条循环领的是两张表、回报的是两套接口，
 * 合成一份要在每一步按 kind 分叉，比两份各自顺着读难看。
 */
export const name = 'satu-local-tasks'
export const inject = ['server']

const TICK_MS = Math.max(1000, Math.trunc(Number(process.env.SATUWORK_LOCAL_TASK_TICK_MS ?? 5_000)))
const DEFAULT_TIMEOUT_MS = 20 * 60_000
const DEFAULT_LEASE_MS = 60_000

interface Job {
  taskId: string
  phase: 'run' | 'deliver'
  botId: string
  seatId: string
  instruction: string
  task: { id: string; phase: 'instruction' | 'result'; from: { id: string; name: string } }
  leaseMs: number
  timeoutMs: number
  /** 续租的节拍（Gateway 给）。续租的回复里带 cancelled：主 Bot 那边停了，这边立刻停。 */
  cancelPollMs?: number
}

class LostError extends Error {}

function num(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

async function gw(path: string, body?: unknown): Promise<unknown> {
  const r = await fetch(`${gatewayUrl()}/runtime/local-tasks${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${gatewayToken()}`,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  const text = await r.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {}
  if (r.status === 404) throw new LostError('这一步已不归本机')
  if (!r.ok) throw new Error(`Gateway ${r.status}：${(json as { error?: string } | null)?.error ?? ''}`)
  return json
}

async function* sseEvents<T>(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<T> {
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
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
        } catch {}
      }
    }
  }
}

function textOfMessage(data: unknown): string {
  const content = (data as { message?: { content?: unknown } } | undefined)?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && 'text' in b ? String((b as { text?: unknown }).text ?? '') : ''))
    .join('')
}

/** 同 local-routines 的 readTurnEnd，多收自己那一轮**最后一条** assistant/message 的正文作为结论。 */
async function readTurnResult(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ownTurn: boolean,
  instruction: string,
  track?: (ev: { type?: string; data?: unknown }) => void,
): Promise<{ kind: string; text: string }> {
  let turn: number | null = ownTurn ? null : -1
  let mine = false
  let foreign = 0
  /** 只留最后一条：模型每调一次工具前常先说一句「我先读一下收件箱」，那些不是结论（docs/bot-tasks.md §2）。 */
  let last = ''
  type Ev = { type?: string; data?: { turn?: number; reason?: string | { kind?: string } } }
  for await (const ev of sseEvents<Ev>(reader)) {
    // 自己那一轮的事件喂给进度（docs/bot-tasks.md §4）。todo/list 不带轮号，进了自己那一轮就算。
    if (track && turn !== null && (turn === -1 ? foreign === 0 : ev.type === 'todo/list' || Number(ev.data?.turn ?? -1) === turn)) track(ev)
    if (ev.type === 'user/message') {
      if (!mine) {
        if (textOfMessage(ev.data).trim() === instruction.trim()) mine = true
        else if (turn === -1) foreign++
      }
      continue
    }
    /**
     * 自己那一轮：**见到自己那条指令之后的第一个 turn/start**。派活的指令不插话，忙着就排队
     * （docs/bot-tasks.md §7），开轮时 user/message 和 turn/start 是紧挨着写的。以前数「前面
     * 还有几条别人的消息」——人在这期间插的话不占一轮，一数就把自己那一轮让给了别人。
     */
    if (ev.type === 'turn/start') {
      if (turn === null && mine) turn = Number(ev.data?.turn ?? -1)
      continue
    }
    if (ev.type === 'assistant/message') {
      if (turn === null) continue
      if (turn === -1 ? foreign === 0 : Number(ev.data?.turn ?? -1) === turn) {
        const t = textOfMessage(ev.data).trim()
        if (t) last = t
      }
      continue
    }
    if (ev.type !== 'turn/end') continue
    if (turn === null) continue
    if (turn === -1 && foreign > 0) {
      foreign--
      continue
    }
    if (turn !== -1 && Number(ev.data?.turn ?? -1) !== turn) continue
    const reason = ev.data?.reason
    return { kind: String((typeof reason === 'string' ? reason : reason?.kind) || 'completed'), text: last }
  }
  throw new Error('事件流断了')
}

export function apply(ctx: Context) {
  if ((process.env.SATUWORK_RUNTIME_KIND || '').trim() !== 'local') return
  if (!gatewayUrl() || !gatewayToken()) {
    ctx.logger?.warn?.('local tasks: 缺 GATEWAY_URL / GATEWAY_TOKEN，不领派活')
    return
  }
  const botId = (process.env.SATUWORK_BOT_ID || '').trim()
  const running = new Set<string>()

  const self = () => String(ctx.server.baseUrl || `http://127.0.0.1:${ctx.server.port}`).replace(/\/$/, '')
  const selfHeaders = () => ({ authorization: `Bearer ${gatewayToken()}`, accept: 'application/json' })
  async function selfJson(path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
    const r = await fetch(`${self()}${path}`, {
      method: init?.method ?? 'GET',
      headers: { ...selfHeaders(), ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    })
    const text = await r.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {}
    if (!r.ok) throw new Error((json as { error?: string } | null)?.error || `HTTP ${r.status}`)
    return json
  }

  async function runJob(job: Job): Promise<void> {
    const ac = new AbortController()
    const timeout = setTimeout(() => ac.abort(), Math.max(60_000, num(job.timeoutMs, DEFAULT_TIMEOUT_MS)))
    let lost = false
    let sessionId = ''
    /** 这一轮是不是插进别人正在跑的那一轮里的（steered）。是的话停止时不砍它：那一轮是人自己的。 */
    let steered = false
    /** 对方正忙、指令排在它的队列里：队列里那一条的 id。停止时先撤它（docs/bot-tasks.md §7）。 */
    let queueId = ''
    /** 指令正在发：这一下还不知道它是开轮、排队还是插话，停止要等发完再按结果办。 */
    let posting = false
    /** 主 Bot 那边按了停止（续租的回复里带 cancelled）。 */
    let stopped = false
    let stopTimer: ReturnType<typeof setTimeout> | null = null
    /** 目标那一轮做到哪了：随续租报上去，主 Bot 那张卡画「正在：…」。 */
    const tracker = new ProgressTracker()
    let moved = false
    /**
     * 停掉目标那一轮（docs/bot-tasks.md §1.2）。调席位的「中止」接口，那一轮以 aborted 收口，下面照常
     * 读到 turn/end 报上去；中止请求发出去 15 秒还没收口就不等了，照样报 aborted。
     */
    const stopTarget = () => {
      if (stopped) return
      stopped = true
      if (job.phase !== 'run' || !sessionId || steered || posting) return
      // 还在对方队列里排着：撤掉就完了，一个字都没进它的对话。撤不掉（刚好开跑了）再中止那一轮。
      if (queueId) {
        const qid = queueId
        queueId = ''
        void selfJson(`/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(qid)}`, { method: 'DELETE' })
          .then(() => ac.abort())
          .catch(() => {
            stopped = false
            stopTarget()
          })
        return
      }
      void selfJson(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, { method: 'POST', body: {} }).catch(() => {})
      stopTimer = setTimeout(() => ac.abort(), 15_000)
    }
    const renew = setInterval(() => {
      const body = moved ? { progress: tracker.snapshot() } : {}
      moved = false
      void gw(`/${encodeURIComponent(job.taskId)}/renew`, body)
        .then((r) => {
          if ((r as { cancelled?: boolean } | null)?.cancelled) stopTarget()
        })
        .catch((e) => {
          // 这一拍没报上去：下一拍补报。
          if ('progress' in body) moved = true
          if (e instanceof LostError) {
            lost = true
            ac.abort()
          }
        })
    }, Math.max(200, Math.min(Number(job.cancelPollMs) || Infinity, Math.trunc(num(job.leaseMs, DEFAULT_LEASE_MS) / 3))))
    const finish = (body: Record<string, unknown>) =>
      gw(`/${encodeURIComponent(job.taskId)}/finish`, { ...body, ...(sessionId ? { sessionId } : {}) }).catch((e) => {
        if (!(e instanceof LostError)) ctx.logger?.warn?.(`local tasks: 回报 ${job.taskId} 失败：${(e as Error).message}`)
      })
    try {
      /**
       * 同一个账号的几颗本地 Bot 各自领：这条活要敲的不是自己就放着（别的进程会领走——它们
       * 共用一个 owner，谁先来谁领；领到了不是自己的只能退回去）。
       */
      if (botId && job.botId !== botId) throw new Error(`这一步要敲的是别的 Bot（${job.botId}），不是本进程`)
      const got = (await selfJson(`/api/bots/${encodeURIComponent(job.botId)}/session`)) as { sessionId?: string } | null
      if (!got?.sessionId) throw new Error('没有会话 id')
      sessionId = got.sessionId
      const started = (await gw(`/${encodeURIComponent(job.taskId)}/started`, { sessionId })) as { blocked?: string | null }
      if (started?.blocked) return
      const message = { text: job.instruction, task: job.task }
      if (job.phase === 'deliver') {
        await selfJson(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, { method: 'POST', body: message })
        await finish({ kind: 'delivered' })
        ctx.logger?.info?.(`local tasks: ${job.taskId} 的结论已送回主 Bot`)
        return
      }
      const hist = (await selfJson(`/api/sessions/${encodeURIComponent(sessionId)}/history?turns=1`)) as { events?: { seq?: number }[] } | null
      let afterSeq = 0
      for (const ev of hist?.events ?? []) afterSeq = Math.max(afterSeq, Number(ev?.seq) || 0)
      const r = await fetch(`${self()}/api/sessions/${encodeURIComponent(sessionId)}/events?after=${afterSeq}`, {
        headers: { ...selfHeaders(), accept: 'text/event-stream' },
        signal: ac.signal,
      })
      if (!r.ok || !r.body) throw new Error(`事件流打不开：HTTP ${r.status}`)
      const reader = r.body.getReader()
      // 开跑之前就被停了：指令别发进去。
      if (stopped) {
        await finish({ kind: 'aborted' })
        return
      }
      posting = true
      const posted = (await selfJson(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, { method: 'POST', body: message })) as { steered?: boolean; queueId?: string } | null
      steered = Boolean(posted?.steered)
      queueId = String(posted?.queueId || '')
      posting = false
      // 发消息的那一下刚好撞上停止：按发的结果补办（排着的撤掉，开了轮的中止）。
      if (stopped && !steered) {
        stopped = false
        stopTarget()
      }
      const out = await readTurnResult(reader, !posted?.steered, job.instruction, (ev) => {
        if (tracker.feed(ev)) moved = true
      })
      await finish({ kind: out.kind, result: out.text })
      ctx.logger?.info?.(`local tasks: ${job.taskId} 目标那一轮跑完：${out.kind}`)
    } catch (e) {
      if (lost) return
      if (stopped) await finish({ kind: 'aborted' })
      else if (ac.signal.aborted) await finish({ kind: 'timeout' })
      else await finish({ kind: 'failed', error: String((e as Error).message || e).slice(0, 300) })
    } finally {
      clearTimeout(timeout)
      clearInterval(renew)
      if (stopTimer) clearTimeout(stopTimer)
      ac.abort()
    }
  }

  async function tick(): Promise<void> {
    let got: { jobs?: Job[] }
    try {
      got = (await gw('/due')) as { jobs?: Job[] }
    } catch (e) {
      // 老 Gateway 没这条路（404）就安静地过；断网也别刷屏。
      if (!(e instanceof LostError)) ctx.logger?.warn?.(`local tasks: 领不到活：${(e as Error).message}`)
      return
    }
    for (const job of got?.jobs ?? []) {
      const key = `${job.taskId}:${job.phase}`
      if (running.has(key)) continue
      running.add(key)
      void runJob(job).finally(() => running.delete(key))
    }
  }

  const timer = setInterval(() => void tick(), TICK_MS)
  const first = setTimeout(() => void tick(), Math.min(TICK_MS, 3000))
  ctx.effect(() => () => {
    clearInterval(timer)
    clearTimeout(first)
  })
}
