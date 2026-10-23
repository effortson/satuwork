import type { Context } from '@deepseek-ai/cordis'
import { gatewayToken, gatewayUrl } from '../llm/gateway.ts'

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

/** 同 local-routines 的 readTurnEnd，多收自己那一轮的 assistant/message 正文。 */
async function readTurnResult(reader: ReadableStreamDefaultReader<Uint8Array>, ownTurn: boolean, instruction: string): Promise<{ kind: string; text: string }> {
  let turn: number | null = ownTurn ? null : -1
  let mine = false
  let foreign = 0
  const texts: string[] = []
  type Ev = { type?: string; data?: { turn?: number; reason?: string | { kind?: string } } }
  for await (const ev of sseEvents<Ev>(reader)) {
    if (ev.type === 'user/message') {
      if (!mine) {
        if (textOfMessage(ev.data).trim() === instruction.trim()) mine = true
        else foreign++
      }
      continue
    }
    if (ev.type === 'turn/start') {
      if (turn === null) {
        if (foreign > 0) foreign--
        else turn = Number(ev.data?.turn ?? -1)
      }
      continue
    }
    if (ev.type === 'assistant/message') {
      if (turn === null) continue
      if (turn === -1 ? foreign === 0 : Number(ev.data?.turn ?? -1) === turn) {
        const t = textOfMessage(ev.data).trim()
        if (t) texts.push(t)
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
    return { kind: String((typeof reason === 'string' ? reason : reason?.kind) || 'completed'), text: texts.join('\n\n') }
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
    const renew = setInterval(() => {
      void gw(`/${encodeURIComponent(job.taskId)}/renew`, {}).catch((e) => {
        if (e instanceof LostError) {
          lost = true
          ac.abort()
        }
      })
    }, Math.max(1000, Math.trunc(num(job.leaseMs, DEFAULT_LEASE_MS) / 3)))
    let sessionId = ''
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
      const posted = (await selfJson(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, { method: 'POST', body: message })) as { steered?: boolean } | null
      const out = await readTurnResult(reader, !posted?.steered, job.instruction)
      await finish({ kind: out.kind, result: out.text })
      ctx.logger?.info?.(`local tasks: ${job.taskId} 目标那一轮跑完：${out.kind}`)
    } catch (e) {
      if (lost) return
      if (ac.signal.aborted) await finish({ kind: 'timeout' })
      else await finish({ kind: 'failed', error: String((e as Error).message || e).slice(0, 300) })
    } finally {
      clearTimeout(timeout)
      clearInterval(renew)
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
