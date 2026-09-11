import type { Context } from '@deepseek-ai/cordis'
import { gatewayToken, gatewayUrl } from '../llm/gateway.ts'

/**
 * 本地 Bot（桌面端）的日常任务：**自己领、自己跑、自己回报。**
 *
 * 远程席位上这段活由机器上的工人做（manager/src/worker），Gateway 连得到那台机器。本地 Bot 跑在
 * 员工电脑上，Gateway 连不到它，dueRoutines 把它的任务排除在外——所以这颗 Bot 进程自己每半分钟去
 * Gateway 问一次「我有没有到点的任务」（`/runtime/local-routines/*`，凭席位票，只看得到自己账号的），
 * 领到就往**自己的**会话里发那条指令、等自己那一轮跑完、回报 Gateway。
 *
 * 一次跑的顺序和工人那份一字不差（问会话 id → started → 读游标 → 先挂流再发消息 → 只认自己那一轮的
 * turn/end → finish），readTurnEnd 也是同一份逻辑；怎么解释结果、补不补，全在 Gateway。
 *
 * 只在本地模式启用。代价写在 docs/adr-gateway-vercel-neon.md §4：电脑关着、应用没开，任务就不跑——
 * 到点没人领，Gateway 那头只是排着，不会记「错过」。
 */

export const name = 'satu-local-routines'
export const inject = ['server']

const TICK_MS = Math.max(1000, Math.trunc(Number(process.env.SATUWORK_LOCAL_ROUTINE_TICK_MS ?? 30_000)))

interface Job {
  runId: string
  routineId: string
  botId: string
  name: string
  instruction: string
  modelRole: string
  leaseMs: number
  timeoutMs: number
}

class LostError extends Error {}

/** 和 Gateway 那边的缺省一致（gateway/src/routines.ts）：一轮最多等 20 分钟，租约 60 秒。 */
const DEFAULT_TIMEOUT_MS = 20 * 60_000
const DEFAULT_LEASE_MS = 60_000

/** 网上来的数字不可信：不是有限正数就用缺省，否则 NaN 会变成 1 毫秒的定时器。 */
function num(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

async function gw(path: string, body?: unknown): Promise<unknown> {
  const r = await fetch(`${gatewayUrl()}/runtime/local-routines${path}`, {
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
  if (r.status === 404) throw new LostError('这一次已不归本机')
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

function textOfUserMessage(data: unknown): string {
  const content = (data as { message?: { content?: unknown } } | undefined)?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text?: unknown }).text ?? '') : '')).join('')
}

/** 同 gateway/src/routines.ts 的 readTurnEnd：别人的消息各自带走一轮、steered 不比轮号、reason 两种形状。 */
async function readTurnEnd(reader: ReadableStreamDefaultReader<Uint8Array>, ownTurn: boolean, instruction: string): Promise<string> {
  let turn: number | null = ownTurn ? null : -1
  let mine = false
  let foreign = 0
  type TurnEvent = { type?: string; data?: { turn?: number; reason?: string | { kind?: string } } }
  for await (const ev of sseEvents<TurnEvent>(reader)) {
    if (ev.type === 'user/message') {
      if (!mine) {
        if (textOfUserMessage(ev.data).trim() === instruction.trim()) mine = true
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
    if (ev.type !== 'turn/end') continue
    if (turn === null) continue
    if (turn === -1 && foreign > 0) {
      foreign--
      continue
    }
    if (turn !== -1 && Number(ev.data?.turn ?? -1) !== turn) continue
    const reason = ev.data?.reason
    return String((typeof reason === 'string' ? reason : reason?.kind) || 'completed')
  }
  throw new Error('事件流断了')
}

export function apply(ctx: Context) {
  if ((process.env.SATUWORK_RUNTIME_KIND || '').trim() !== 'local') return
  if (!gatewayUrl() || !gatewayToken()) {
    ctx.logger?.warn?.('local routines: 缺 GATEWAY_URL / GATEWAY_TOKEN，不领日常任务')
    return
  }
  const botId = (process.env.SATUWORK_BOT_ID || '').trim()
  const running = new Set<string>()

  // 打自己的 HTTP 口，票就是自己那把（守卫认的正是它）。
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
      void gw(`/${encodeURIComponent(job.runId)}/renew`, {}).catch((e) => {
        if (e instanceof LostError) {
          lost = true
          ac.abort()
        }
      })
    }, Math.max(1000, Math.trunc(num(job.leaseMs, DEFAULT_LEASE_MS) / 3)))
    let sessionId = ''
    const finish = (kind: string, error?: string) =>
      gw(`/${encodeURIComponent(job.runId)}/finish`, { kind, ...(error ? { error } : {}), ...(sessionId ? { sessionId } : {}) }).catch((e) => {
        if (!(e instanceof LostError)) ctx.logger?.warn?.(`local routines: 回报 ${job.name} 失败：${(e as Error).message}`)
      })
    try {
      const got = (await selfJson(`/api/bots/${encodeURIComponent(job.botId || botId)}/session`)) as { sessionId?: string } | null
      if (!got?.sessionId) throw new Error('没有会话 id')
      sessionId = got.sessionId
      const started = (await gw(`/${encodeURIComponent(job.runId)}/started`, { sessionId })) as { blocked?: string | null }
      if (started?.blocked) return
      const hist = (await selfJson(`/api/sessions/${encodeURIComponent(sessionId)}/history?turns=1`)) as { events?: { seq?: number }[] } | null
      let afterSeq = 0
      for (const ev of hist?.events ?? []) afterSeq = Math.max(afterSeq, Number(ev?.seq) || 0)
      const r = await fetch(`${self()}/api/sessions/${encodeURIComponent(sessionId)}/events?after=${afterSeq}`, {
        headers: { ...selfHeaders(), accept: 'text/event-stream' },
        signal: ac.signal,
      })
      if (!r.ok || !r.body) throw new Error(`事件流打不开：HTTP ${r.status}`)
      const reader = r.body.getReader()
      const posted = (await selfJson(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        body: {
          text: job.instruction,
          ...(job.modelRole === 'utility' ? { modelRole: 'utility' } : {}),
          routine: { id: job.routineId, name: job.name },
        },
      })) as { steered?: boolean } | null
      const kind = await readTurnEnd(reader, !posted?.steered, job.instruction)
      await finish(kind)
      ctx.logger?.info?.(`local routines: ${job.name} 跑完：${kind}`)
    } catch (e) {
      if (lost) return
      if (ac.signal.aborted) await finish('timeout')
      else await finish('failed', String((e as Error).message || e).slice(0, 300))
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
      if (!(e instanceof LostError)) ctx.logger?.warn?.(`local routines: 领不到活：${(e as Error).message}`)
      return
    }
    for (const job of got?.jobs ?? []) {
      if (running.has(job.runId)) continue
      running.add(job.runId)
      void runJob(job).finally(() => running.delete(job.runId))
    }
  }

  const timer = setInterval(() => void tick(), TICK_MS)
  // 起来先等一拍再领：自己的 server 可能还没听上。
  const first = setTimeout(() => void tick(), Math.min(TICK_MS, 3000))
  ctx.effect(() => () => {
    clearInterval(timer)
    clearTimeout(first)
  })
}
