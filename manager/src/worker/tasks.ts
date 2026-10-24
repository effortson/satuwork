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
  /** 续租的节拍（Gateway 给）。续租的回复里带 cancelled：主 Bot 那边停了，这边立刻停。 */
  cancelPollMs?: number
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

/**
 * 目标那一轮做到哪了，随续租报给 Gateway，主 Bot 那张卡据此画「正在：…」（docs/bot-tasks.md §4）。
 *
 * 和 bot/src/agent/progress.ts、core/src/chat/task.ts 是**同一个口径的三份**——管家不依赖那两个包。
 * 改字段、改「关键参数取哪个」要三处一起改。
 */
const DETAIL_KEYS = ['url', 'urls', 'query', 'q', 'command', 'cmd', 'path', 'file', 'paths', 'goal', 'instruction', 'task', 'name', 'id', 'text']

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length <= n ? one : one.slice(0, n - 1) + '…'
}

function callDetail(args: unknown): string {
  let o: unknown = args
  if (typeof args === 'string') {
    try {
      o = args ? JSON.parse(args) : {}
    } catch {
      return clip(args, 120)
    }
  }
  if (!o || typeof o !== 'object') return ''
  const rec = o as Record<string, unknown>
  for (const k of DETAIL_KEYS) {
    const v = rec[k]
    if (typeof v === 'string' && v.trim()) return clip(v, 120)
    if (Array.isArray(v) && v.length) {
      const first = v.find((x) => typeof x === 'string' && x.trim())
      if (typeof first === 'string') return clip(first + (v.length > 1 ? ` 等 ${v.length} 个` : ''), 120)
    }
  }
  if (Array.isArray(rec.todos)) return `${rec.todos.length} 条`
  const raw = JSON.stringify(rec)
  return raw === '{}' ? '' : clip(raw, 120)
}

interface TaskProgress {
  steps: number
  tool?: { name: string; detail?: string }
  todo?: { done: number; total: number; now?: string }
}

class ProgressTracker {
  private steps = new Set<string>()
  private tool: TaskProgress['tool']
  private todo: TaskProgress['todo']
  private sig = ''

  /** 喂一条事件。进度变了回 true。 */
  feed(ev: { type?: string; data?: any }): boolean {
    const d = ev.data || {}
    if (ev.type === 'tool/call') {
      this.steps.add(`${d.turn ?? ''}:${d.step ?? ''}`)
      this.tool = { name: String(d.name || ''), detail: callDetail(d.arguments) }
    } else if (ev.type === 'todo/list' && Array.isArray(d.items)) {
      const live = d.items.filter((i: any) => i && i.status !== 'cancelled')
      const now = live.find((i: any) => i.status === 'in_progress')
      this.todo = live.length
        ? { done: live.filter((i: any) => i.status === 'completed').length, total: live.length, ...(now?.task ? { now: clip(String(now.task), 120) } : {}) }
        : undefined
    } else return false
    const sig = JSON.stringify(this.snapshot())
    if (sig === this.sig) return false
    this.sig = sig
    return true
  }

  snapshot(): TaskProgress {
    return { steps: this.steps.size, ...(this.tool ? { tool: this.tool } : {}), ...(this.todo ? { todo: this.todo } : {}) }
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
    // 自己那一轮的事件喂给进度。todo/list 不带轮号，进了自己那一轮就算。
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

export async function runTaskJob(job: TaskJob, log: (line: string) => void = console.log): Promise<void> {
  const ac = new AbortController()
  const timeout = setTimeout(() => ac.abort(), Math.max(60_000, job.timeoutMs))
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
      void seatJson(job.seatId, `/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(qid)}`, { method: 'DELETE' })
        .then(() => ac.abort())
        .catch(() => {
          stopped = false
          stopTarget()
        })
      return
    }
    void seatJson(job.seatId, `/api/sessions/${encodeURIComponent(sessionId)}/abort`, { method: 'POST', body: {} }).catch(() => {})
    stopTimer = setTimeout(() => ac.abort(), 15_000)
  }
  const renew = setInterval(() => {
    const body = moved ? { progress: tracker.snapshot() } : {}
    moved = false
    void gw(`/tasks/${encodeURIComponent(job.taskId)}/renew`, body)
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
  }, Math.max(200, Math.min(Number(job.cancelPollMs) || Infinity, Math.trunc(job.leaseMs / 3))))
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
    // 开跑之前就被停了：指令别发进去。
    if (stopped) {
      await finish({ kind: 'aborted' })
      return
    }
    posting = true
    const posted = (await seatJson(job.seatId, `/api/sessions/${encodeURIComponent(sessionId)}/messages`, { method: 'POST', body: message })) as { steered?: boolean; queueId?: string } | null
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
    log(`satuwork-worker: 派活 ${job.taskId} 目标那一轮跑完：${out.kind}`)
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
