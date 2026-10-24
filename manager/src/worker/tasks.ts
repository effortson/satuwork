/**
 * 主 Bot 派活（docs/bot-tasks.md）在工人这一侧的那半截。
 *
 * 一条任务两步，工人领到的每条活自带 `phase`：
 *
 *   run      把指令发进**目标 Bot** 的会话、等它那一轮收口，**把回复正文带回去**（finish 的 result）
 *   deliver  把结论发进**主 Bot** 的会话。发进去就算完——主 Bot 那一轮是它自己的事，等它只是占着租约
 *
 * run 那一步和日常任务（index.ts 的 runJob）一字不差，只多收了一样东西：自己那一轮的
 * `assistant/message`。怎么解释结果、送不送回去，全在 Gateway（lib/bot-tasks.ts），这里只如实报。
 */
import { LostError, gw, headers, seatEventsUrl, seatJson } from './relay-client.ts'

export interface TaskJob {
  taskId: string
  phase: 'run' | 'deliver'
  botId: string
  accountId: string
  seatId: string
  instruction: string
  task: { id: string; phase: 'instruction' | 'result'; from: { id: string; name: string } }
  leaseMs: number
  timeoutMs: number
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

function textOfMessage(data: unknown): string {
  const content = (data as { message?: { content?: unknown } } | undefined)?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && 'text' in b ? String((b as { text?: unknown }).text ?? '') : ''))
    .join('')
}

/**
 * 同 index.ts 的 readTurnEnd（别人的消息各自带走一轮、steered 不比轮号、reason 有两种形状），
 * 多收一样：自己那一轮里**最后一条** assistant/message 的正文，收口时作为结论。
 */
async function readTurnResult(reader: ReadableStreamDefaultReader<Uint8Array>, ownTurn: boolean, instruction: string): Promise<{ kind: string; text: string }> {
  let turn: number | null = ownTurn ? null : -1
  let mine = false
  let foreign = 0
  /** 只留最后一条：模型每调一次工具前常先说一句「我先读一下收件箱」，那些不是结论（docs/bot-tasks.md §2）。 */
  let last = ''
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

export async function runTaskJob(job: TaskJob, log: (line: string) => void = console.log): Promise<void> {
  const ac = new AbortController()
  const timeout = setTimeout(() => ac.abort(), Math.max(60_000, job.timeoutMs))
  let lost = false
  const renew = setInterval(() => {
    void gw(`/tasks/${encodeURIComponent(job.taskId)}/renew`, {}).catch((e) => {
      if (e instanceof LostError) {
        lost = true
        ac.abort()
      }
    })
  }, Math.max(1000, Math.trunc(job.leaseMs / 3)))
  let sessionId = ''
  const finish = (body: Record<string, unknown>) =>
    gw(`/tasks/${encodeURIComponent(job.taskId)}/finish`, { ...body, ...(sessionId ? { sessionId } : {}) }).catch((e) => {
      if (!(e instanceof LostError)) console.error(`satuwork-worker: 回报派活 ${job.taskId} 失败：${(e as Error).message}`)
    })
  try {
    const got = (await seatJson(job.seatId, `/api/bots/${encodeURIComponent(job.botId)}/session`)) as { sessionId?: string } | null
    if (!got?.sessionId) throw new Error('席位没给出会话 id')
    sessionId = got.sessionId
    const started = (await gw(`/tasks/${encodeURIComponent(job.taskId)}/started`, { sessionId })) as { blocked?: string | null }
    if (started?.blocked) {
      log(`satuwork-worker: 派活 ${job.taskId} 这一步没跑：转人工挡着（${started.blocked}）`)
      return
    }
    const message = { text: job.instruction, task: job.task }
    if (job.phase === 'deliver') {
      // 结论发进主 Bot 的会话就算送到。插进了正在跑的那一轮（steered）也算：话已经到它手上了。
      await seatJson(job.seatId, `/api/sessions/${encodeURIComponent(sessionId)}/messages`, { method: 'POST', body: message })
      await finish({ kind: 'delivered' })
      log(`satuwork-worker: 派活 ${job.taskId} 的结论已送回主 Bot`)
      return
    }
    const hist = (await seatJson(job.seatId, `/api/sessions/${encodeURIComponent(sessionId)}/history?turns=1`)) as { events?: { seq?: number }[] } | null
    let afterSeq = 0
    for (const ev of hist?.events ?? []) afterSeq = Math.max(afterSeq, Number(ev?.seq) || 0)
    // 流先挂上，消息后发。顺序反了就会漏掉跑得快的那一轮。
    const r = await fetch(seatEventsUrl(job.seatId, sessionId, afterSeq), { headers: headers({ accept: 'text/event-stream' }), signal: ac.signal })
    if (!r.ok || !r.body) throw new Error(`事件流打不开：HTTP ${r.status}`)
    const reader = r.body.getReader()
    const posted = (await seatJson(job.seatId, `/api/sessions/${encodeURIComponent(sessionId)}/messages`, { method: 'POST', body: message })) as { steered?: boolean } | null
    const out = await readTurnResult(reader, !posted?.steered, job.instruction)
    await finish({ kind: out.kind, result: out.text })
    log(`satuwork-worker: 派活 ${job.taskId} 目标那一轮跑完：${out.kind}`)
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
