/**
 * 席位工人。**这台机器上「到点自己会动」的那一半**，跑在非 root 的 `satuwork-worker` 单元里。
 *
 * ── 它替谁干活 ──────────────────────────────────────────────────────
 *
 * 日常任务原来由 Gateway 的调度器跑：到点了去敲席位、挂着流等这一轮跑完、记流水。Gateway
 * 要变成无状态的（docs/adr-gateway-vercel-neon.md §7 第 4 步），那段「主动打进席位、等 20
 * 分钟」的活就得有人在机器上接。就是这里。
 *
 * ── 它手上什么都没有 ────────────────────────────────────────────────
 *
 * 工人**不持有任何长期凭据**：没有 `smt_`（那是管家的 root 控制面凭据），也没有任何席位的
 * `sat_`。它只有一把开机时管家随机生成的本机令牌（`SATUWORK_WORKER_TOKEN`），凭它打管家在
 * 127.0.0.1 上的中继口（manager/src/relay.ts）：
 *
 *   /w-local/gateway/worker/*        → 管家带 smt_ 转给 Gateway 的 /worker/*，别的路径不转
 *   /w-local/seats/:seatId/bot/*     → 管家换成那个席位的 sat_ 转给本机 bot
 *
 * 于是工人被攻破的影响面 = 「领本机的日常任务 + 跟本机的 bot 说话」，管家和 Gateway 的
 * 控制面一条都碰不到。这是 ADR 决定三（非 root sidecar）真正想要的边界。
 *
 * ── 一次跑，和 Gateway 自己跑时一字不差 ───────────────────────────────
 *
 * 领活 → 问会话 id → 报 started（Gateway 查转人工挡不挡）→ 读游标 → **先挂流再发消息** →
 * 只认自己那一轮的 turn/end → 回报 kind。中间按租约的三分之一续命；租约被 Gateway 收掉
 * （404）就停手——那说明 Gateway 已经把这一次记成「机器没回报」并排了补跑，再回报就是
 * 两份结果。怎么解释 kind、补不补，全在 Gateway（routes/worker.ts），这里只如实报。
 *
 * readTurnEnd 那一段是从 gateway/src/routines.ts 搬过来的，理由和陷阱都写在那儿：别人的
 * 消息各自带走一轮、steered 不比轮号、reason 有两种形状。
 */

const LOCAL = (process.env.SATUWORK_MANAGER_LOCAL || '').trim().replace(/\/$/, '')
const TOKEN = (process.env.SATUWORK_WORKER_TOKEN || '').trim()
/** 多久去领一次。和 Gateway 调度器原来的节拍一样，粗一点没关系——任务是分钟级的。 */
const TICK_MS = Math.max(1000, Math.trunc(Number(process.env.SATUWORK_WORKER_TICK_MS ?? 30_000)))

if (!LOCAL || !TOKEN) {
  // 管家开机会写 worker.env；单元是 Restart=always，这里退出就等下一次。
  console.error('satuwork-worker: 缺 SATUWORK_MANAGER_LOCAL / SATUWORK_WORKER_TOKEN，等管家写出 worker.env 再起')
  process.exit(1)
}

interface Job {
  runId: string
  routineId: string
  trigger: string
  botId: string
  accountId: string
  seatId: string
  name: string
  instruction: string
  modelRole: string
  leaseMs: number
  timeoutMs: number
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-satuwork-worker': TOKEN, ...extra }
}

async function relayJson(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${LOCAL}${path}`, {
    method: init?.method ?? 'GET',
    headers: headers({
      accept: 'application/json',
      ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
    }),
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: init?.signal ?? AbortSignal.timeout(20_000),
  })
  const text = await r.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: r.status, json }
}

/** 打 Gateway 的 /worker/*（经管家中继）。非 2xx 抛错，404 单独认——那是「这一次不归你了」。 */
class LostError extends Error {}
async function gw(path: string, body?: unknown): Promise<unknown> {
  const { status, json } = await relayJson(`/w-local/gateway/worker${path}`, body === undefined ? undefined : { method: 'POST', body })
  if (status === 404) throw new LostError('这一次已不归本机')
  if (status < 200 || status >= 300) throw new Error(`Gateway ${status}：${(json as { error?: string } | null)?.error ?? ''}`)
  return json
}

/** 跟本机的一个 bot 说话（经管家中继，管家换成席位票）。 */
async function seatJson(seatId: string, path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
  const { status, json } = await relayJson(`/w-local/seats/${encodeURIComponent(seatId)}/bot${path}`, init)
  if (status < 200 || status >= 300) {
    throw new Error((json as { error?: string } | null)?.error || `HTTP ${status}`)
  }
  return json
}

async function openEvents(seatId: string, sessionId: string, afterSeq: number, ac: AbortController) {
  const r = await fetch(`${LOCAL}/w-local/seats/${encodeURIComponent(seatId)}/bot/api/sessions/${encodeURIComponent(sessionId)}/events?after=${afterSeq}`, {
    headers: headers({ accept: 'text/event-stream' }),
    signal: ac.signal,
  })
  if (!r.ok || !r.body) throw new Error(`事件流打不开：HTTP ${r.status}`)
  return r.body.getReader()
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
        } catch {
          continue
        }
      }
    }
  }
}

function textOfUserMessage(data: unknown): string {
  const content = (data as { message?: { content?: unknown } } | undefined)?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text?: unknown }).text ?? '') : ''))
    .join('')
}

/** 同 gateway/src/routines.ts 的 readTurnEnd。 */
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

const running = new Set<string>()

async function runJob(job: Job): Promise<void> {
  const ac = new AbortController()
  const timeout = setTimeout(() => ac.abort(), Math.max(60_000, job.timeoutMs))
  let lost = false
  const renew = setInterval(() => {
    void gw(`/routines/${encodeURIComponent(job.runId)}/renew`, {}).catch((e) => {
      if (e instanceof LostError) {
        lost = true
        ac.abort()
      }
    })
  }, Math.max(1000, Math.trunc(job.leaseMs / 3)))
  let sessionId = ''
  const finish = (kind: string, error?: string) =>
    gw(`/routines/${encodeURIComponent(job.runId)}/finish`, { kind, ...(error ? { error } : {}), ...(sessionId ? { sessionId } : {}) }).catch((e) => {
      if (!(e instanceof LostError)) console.error(`satuwork-worker: 回报 ${job.name} 失败：${(e as Error).message}`)
    })
  try {
    const got = (await seatJson(job.seatId, `/api/bots/${encodeURIComponent(job.botId)}/session`)) as { sessionId?: string } | null
    if (!got?.sessionId) throw new Error('席位没给出会话 id')
    sessionId = got.sessionId
    const started = (await gw(`/routines/${encodeURIComponent(job.runId)}/started`, { sessionId })) as { blocked?: string | null }
    if (started?.blocked) {
      console.log(`satuwork-worker: ${job.name} 这一次没跑：转人工挡着（${started.blocked}）`)
      return
    }
    const hist = (await seatJson(job.seatId, `/api/sessions/${encodeURIComponent(sessionId)}/history?turns=1`)) as { events?: { seq?: number }[] } | null
    let afterSeq = 0
    for (const ev of hist?.events ?? []) afterSeq = Math.max(afterSeq, Number(ev?.seq) || 0)
    // 流先挂上，消息后发。顺序反了就会漏掉跑得快的那一轮。
    const reader = await openEvents(job.seatId, sessionId, afterSeq, ac)
    const posted = (await seatJson(job.seatId, `/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      body: {
        text: job.instruction,
        ...(job.modelRole === 'utility' ? { modelRole: 'utility' } : {}),
        routine: { id: job.routineId, name: job.name },
      },
    })) as { steered?: boolean } | null
    const kind = await readTurnEnd(reader, !posted?.steered, job.instruction)
    await finish(kind)
    console.log(`satuwork-worker: ${job.name} 跑完：${kind}`)
  } catch (e) {
    if (lost) return
    if (ac.signal.aborted) await finish('timeout')
    else await finish('failed', String((e as Error).message || e).slice(0, 300))
  } finally {
    clearTimeout(timeout)
    clearInterval(renew)
    // 等到了也要掐：那条 SSE 是席位主动保活的，不掐就留一条永不关闭的连接。
    ac.abort()
  }
}

async function tick(): Promise<void> {
  let got: { jobs?: Job[] }
  try {
    got = (await gw('/routines/due')) as { jobs?: Job[] }
  } catch (e) {
    console.error(`satuwork-worker: 领不到活：${(e as Error).message}`)
    return
  }
  for (const job of got?.jobs ?? []) {
    if (running.has(job.runId)) continue
    running.add(job.runId)
    void runJob(job).finally(() => running.delete(job.runId))
  }
}

console.log(`satuwork-worker: 起了，每 ${TICK_MS / 1000}s 向 ${LOCAL} 领一次活`)
void tick()
const timer = setInterval(() => void tick(), TICK_MS)
const shutdown = () => {
  clearInterval(timer)
  // 手上的活不等：租约会到期，Gateway 记成「机器没回报」并排补跑，比让 systemd 等 20 分钟强。
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// 没有 import/export 的 .ts 在 TypeScript 眼里是全局脚本，会和 src/index.ts 的顶层变量撞名。
export {}
