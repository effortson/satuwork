/**
 * 一条会一直自己接回来的会话事件流。**给移动端用的**：Web 那条（chat.js 的 startChatStream）
 * 和重放闸、脉搏、整页重绘缠在一起，没有搬——它和这里共用的是分帧（sseEvents）、状态码
 * 分治（classifyStreamStatus）和退避（backoff.ts），规则改一处两边一起变。
 *
 * 用法：
 *   const h = runEventStream({ fetch, url: (after) => …, token, cursor, onEvent, onStatus })
 *   …
 *   h.close()
 *
 * 续传靠 `cursor()`：每次重连前问一次「手上最后一条是第几行」，带 `after=` 过去；一条都
 * 没有时带 `tail=`。`runtime/hello`、`replay/done`、`queue/change` 这些**不是会话事件**，照样
 * 经 onEvent 交出去，由调用方按 type 分流——和 Web 一样。
 */
import type { FetchLike } from '../api.ts'
import { CHAT_IDLE_RETRY_MS, CHAT_RETRY_MAX, aliveLongEnough, chatRetryDelay, classifyStreamStatus } from './backoff.ts'
import { sseEvents } from './sse.ts'

export type StreamStatus =
  | { kind: 'open' }
  /** 正在退避重连；attempt 是第几次。 */
  | { kind: 'warming'; attempt: number }
  /** 退避到头了，转成每 30 秒一次的慢速长跑。 */
  | { kind: 'idle'; attempt: number }
  /** 401 / 403 / 404：答案不会变，不再重连。message 是席位那句原话。 */
  | { kind: 'dead'; status: number; message: string }
  | { kind: 'closed' }

export interface EventStreamOptions {
  fetch: FetchLike
  /** 按游标拼出这次要连的地址。after 为 null 表示手上一条都没有。 */
  url: (after: number | null) => string
  token: () => string | null | undefined
  cursor: () => number | null
  onEvent: (ev: any) => void
  onStatus?: (s: StreamStatus) => void
  /** 测试用：换掉时钟和睡眠。 */
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

export interface EventStreamHandle {
  close(): void
  /** 跑完（close 或 dead）才 resolve；给测试和「等它收摊」的人用。 */
  done: Promise<void>
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function runEventStream(opts: EventStreamOptions): EventStreamHandle {
  const ac = new AbortController()
  const now = opts.now || (() => Date.now())
  const sleep = opts.sleep || defaultSleep
  const status = (s: StreamStatus) => {
    if (!ac.signal.aborted || s.kind === 'closed') opts.onStatus?.(s)
  }

  async function loop(): Promise<void> {
    let attempt = 0
    while (!ac.signal.aborted) {
      const tok = opts.token()
      let res: Response
      try {
        res = await opts.fetch(opts.url(opts.cursor()), {
          headers: { accept: 'text/event-stream', ...(tok ? { authorization: 'Bearer ' + tok } : {}) },
          signal: ac.signal,
        })
      } catch {
        if (ac.signal.aborted) break
        // 连不上要接着退避重试，不能就此认输：机器的证书不对、CORS 头没到、管家正在换版，
        // 对人来说都是同一件事「还没接上」，处置也一样。
        attempt = await backoff(attempt)
        continue
      }
      const verdict = classifyStreamStatus(res.status, Boolean(res.body))
      if (verdict === 'dead') {
        const message = (await res.text().catch(() => '')) || '实例还没上线'
        status({ kind: 'dead', status: res.status, message })
        return
      }
      if (verdict === 'warming') {
        attempt = await backoff(attempt)
        continue
      }
      status({ kind: 'open' })
      const openedAt = now()
      try {
        for await (const ev of sseEvents(res.body!.getReader(), () => ac.signal.aborted)) {
          if (ac.signal.aborted) break
          opts.onEvent(ev)
        }
      } catch {
        /* 读到一半断了：下面按「活了多久」决定档位 */
      }
      if (ac.signal.aborted) break
      // 正常读到 done 也要重连：SSE 被中间那一跳掐掉时看起来就是干净的流结束。
      attempt = await backoff(aliveLongEnough(openedAt, now()) ? 0 : attempt)
    }
    status({ kind: 'closed' })
  }

  /** 等一档，返回下一档。退避到头之后转慢速长跑，不认输。 */
  async function backoff(attempt: number): Promise<number> {
    if (attempt >= CHAT_RETRY_MAX) {
      status({ kind: 'idle', attempt })
      await sleep(CHAT_IDLE_RETRY_MS, ac.signal)
      return attempt
    }
    status({ kind: 'warming', attempt })
    await sleep(chatRetryDelay(attempt), ac.signal)
    return attempt + 1
  }

  const done = loop().catch(() => undefined)
  return {
    close() {
      if (!ac.signal.aborted) ac.abort()
    },
    done,
  }
}
