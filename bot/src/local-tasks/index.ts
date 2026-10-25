import type { Context } from '@deepseek-ai/cordis'
import { pinnedBotId } from '../env.ts'
import { DEFAULT_LEASE_MS, DEFAULT_TIMEOUT_MS, LostError, localGateway, localReady, num, selfClient, sseEvents } from '../local-runtime.ts'
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

const gw = localGateway('/runtime/local-tasks', '这一步已不归本机')

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
  /** 席位推的队列快照（`queue/change`），和「见到了自己那条指令」。认对方那边撤掉排队用，见 runTaskJob。 */
  watch?: { queue?: (ids: string[]) => void; mine?: () => void },
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
    if (ev.type === 'queue/change') {
      const queued = (ev as { queued?: { id?: unknown }[] }).queued
      watch?.queue?.(Array.isArray(queued) ? queued.map((q) => String(q?.id ?? '')) : [])
      continue
    }
    if (ev.type === 'user/message') {
      if (!mine) {
        if (textOfMessage(ev.data).trim() === instruction.trim()) {
          mine = true
          watch?.mine?.()
        } else if (turn === -1) foreign++
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

/** 排着的那条离队多久还没开轮，就算对方那边有人把它撤了（见 runTaskJob 的 leftQueueAt）。 */
const QUEUE_GONE_MS = Math.max(500, Math.trunc(Number(process.env.SATUWORK_TASK_QUEUE_GONE_MS ?? 5_000)))

export function apply(ctx: Context) {
  if (!localReady(ctx, 'local tasks: 缺 GATEWAY_URL / GATEWAY_TOKEN，不领派活')) return
  const botId = pinnedBotId()
  const running = new Set<string>()

  const { self, selfHeaders, selfJson } = selfClient(ctx)

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
    /** 指令已经发进去了。没发之前那一轮不是我们的，停止不去砍它（同 manager/src/worker/tasks.ts）。 */
    let sent = false
    /** 主 Bot 那边按了停止（续租的回复里带 cancelled）。 */
    let stopped = false
    /**
     * 排着队的那条从对方队列里没了、自己那条指令却一直没出现：人在对方那边把它撤了（DELETE 队列那一下
     * 不经我们）。不认出来的话要等到二十分钟超时，主 Bot 也跟着干等、最后报「等结果超时」。离队到开轮
     * 之间本来就有一小段（先出队、再写那条 user/message），所以等 QUEUE_GONE_MS 还没见到才算撤了。
     */
    let leftQueueAt = 0
    let mineSeen = false
    let goneThere = false
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
      if (job.phase !== 'run' || !sessionId || !sent || steered || posting) return
      // 还在对方队列里排着：撤掉就完了，一个字都没进它的对话。
      if (queueId) {
        const qid = queueId
        queueId = ''
        void fetch(`${self()}/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(qid)}`, {
          method: 'DELETE',
          headers: selfHeaders(),
          signal: AbortSignal.timeout(20_000),
        })
          .then(({ status }) => {
            // 撤掉了；或者队列里已经没有这一条（人撤了）——它不会再跑，也别去砍人那一轮。
            if ((status >= 200 && status < 300) || status === 404) ac.abort()
            // 刚好开跑了：现在跑着的就是我们那一轮，中止它。
            else if (status === 409) abortTurn()
            else throw new Error(`HTTP ${status}`)
          })
          .catch(() => {
            // 没撤成：下一拍续租再撤。不退回去中止「当前那一轮」——那多半是人的。
            queueId = qid
            stopped = false
          })
        return
      }
      abortTurn()
    }
    const abortTurn = () => {
      void selfJson(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, { method: 'POST', body: {} }).catch(() => {})
      stopTimer = setTimeout(() => ac.abort(), 15_000)
    }
    const renew = setInterval(() => {
      if (queueId && leftQueueAt && !mineSeen && Date.now() - leftQueueAt > QUEUE_GONE_MS) {
        goneThere = true
        ac.abort()
        return
      }
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
       * 同一个账号的几颗本地 Bot 各自领（/due 带 botId，Gateway 只交要敲自己的）。还是领到了别人的
       * ——老 Gateway 不认 botId——就不碰它：不回报，租约到期放回去，由那颗自己的进程再领。
       */
      if (botId && job.botId !== botId) {
        ctx.logger?.warn?.(`local tasks: ${job.taskId} 要敲的是别的 Bot（${job.botId}），不是本进程，放着等它到期`)
        return
      }
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
      sent = true
      // 发消息的那一下刚好撞上停止：按发的结果补办（排着的撤掉，开了轮的中止）。
      if (stopped && !steered) {
        stopped = false
        stopTarget()
      }
      const out = await readTurnResult(
        reader,
        !posted?.steered,
        job.instruction,
        (ev) => {
          if (tracker.feed(ev)) moved = true
        },
        {
          queue: (ids) => {
            if (queueId && !ids.includes(queueId) && !leftQueueAt) leftQueueAt = Date.now()
          },
          mine: () => {
            mineSeen = true
          },
        },
      )
      await finish({ kind: out.kind, result: out.text })
      ctx.logger?.info?.(`local tasks: ${job.taskId} 目标那一轮跑完：${out.kind}`)
    } catch (e) {
      if (lost) return
      if (stopped || goneThere) await finish({ kind: 'aborted' })
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
      // 带上自己是哪颗：同一个账号的几颗本地 Bot 共用一个领活身份，不带就会领到别人的活。
      got = (await gw(botId ? `/due?botId=${encodeURIComponent(botId)}` : '/due')) as { jobs?: Job[] }
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
