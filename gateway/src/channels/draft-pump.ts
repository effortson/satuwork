export interface DraftPumpErrorAction {
  retryAfterMs?: number
  stop?: boolean
}

export interface DraftPumpOptions {
  minMs: number
  batchChars: number
  maxWaitMs: number
  initialWaitMs: number
  keepaliveMs: number
  onSent?: () => void
  onError?: (error: unknown) => DraftPumpErrorAction | void
}

export interface DraftPump {
  enqueue(text: string): void
  isVisible(): boolean
  reset(): Promise<void>
  finish(): Promise<void>
}

function addedCharacters(previous: string, next: string): number {
  const before = Array.from(previous)
  const after = Array.from(next)
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1
  return Math.max(0, after.length - prefix)
}

/**
 * Telegram live drafts are snapshots, not a token queue. Keep at most one request in flight and
 * replace any waiting snapshot with the newest text, so a slow Telegram call never back-pressures
 * the seat's model stream or builds a long client-side animation backlog.
 */
export function createDraftPump(
  send: (text: string) => Promise<void>,
  options: DraftPumpOptions,
): DraftPump {
  const minMs = Math.max(0, Math.trunc(options.minMs))
  const batchChars = Math.max(1, Math.trunc(options.batchChars))
  const maxWaitMs = Math.max(0, Math.trunc(options.maxWaitMs))
  const initialWaitMs = Math.max(0, Math.trunc(options.initialWaitMs))
  const keepaliveMs = Math.max(1000, Math.trunc(options.keepaliveMs))

  let closed = false
  let generation = 0
  let pending: { text: string; since: number } | null = null
  let inFlight: Promise<void> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let timerDue = 0
  let lastText = ''
  let lastSentAt = 0
  let nextAttemptAt = 0
  let visible = false

  const clearTimer = () => {
    if (timer) clearTimeout(timer)
    timer = null
    timerDue = 0
  }

  const dropDuplicatePending = () => {
    const waiting = pending
    if (waiting?.text === lastText && lastSentAt - waiting.since < keepaliveMs) pending = null
  }

  const schedule = () => {
    if (closed || inFlight || !pending) return
    const now = Date.now()
    const isKeepalive = pending.text === lastText
    const enough = !lastText
      ? addedCharacters('', pending.text) >= batchChars
      : addedCharacters(lastText, pending.text) >= batchChars
    const batchingDue = isKeepalive
      ? now
      : !lastText && !enough
      ? pending.since + initialWaitMs
      : enough
      ? now
      : pending.since + maxWaitMs
    const due = Math.max(now, nextAttemptAt, batchingDue)
    if (timer && timerDue <= due) return
    clearTimer()
    timerDue = due
    timer = setTimeout(() => {
      timer = null
      timerDue = 0
      flush()
    }, Math.max(0, due - now))
    timer.unref?.()
  }

  const flush = () => {
    if (closed || inFlight || !pending) return
    const frame = pending
    pending = null
    const frameGeneration = generation
    const task = (async () => {
      try {
        await send(frame.text)
        if (closed || generation !== frameGeneration) return
        lastText = frame.text
        lastSentAt = Date.now()
        nextAttemptAt = lastSentAt + minMs
        visible = true
        // The same snapshot may have been queued while this request was in flight.
        dropDuplicatePending()
        options.onSent?.()
      } catch (error) {
        if (closed || generation !== frameGeneration) return
        const action = options.onError?.(error)
        nextAttemptAt = Date.now() + Math.max(minMs, action?.retryAfterMs || 0)
        if (action?.stop) {
          closed = true
          pending = null
          clearTimer()
        }
      }
    })()
    inFlight = task
    void task.finally(() => {
      if (inFlight === task) inFlight = null
      schedule()
    })
  }

  const reset = async () => {
    generation += 1
    pending = null
    clearTimer()
    const current = inFlight
    if (current) await current
    lastText = ''
    lastSentAt = 0
    nextAttemptAt = 0
    visible = false
  }

  return {
    enqueue(raw: string) {
      if (closed) return
      const text = String(raw || '').trim()
      if (!text) return
      /**
       * **只往后长。** 同一个草稿 id 上，客户端对「不以上一帧开头」的新帧会从分叉处重播打字
       * 动画——用户看到的是前面那段一遍遍重打。席位侧的 channelDraft 已经只往后接；这里再兜
       * 一道：老版本 bot 给的草稿会在中间改（末尾那张工具状态表），那种帧宁可不发，草稿停在
       * 上一帧，等最终回复把它换掉。reset() 之后 lastText 清空，新一段草稿不受约束。
       */
      if (lastText && !text.startsWith(lastText)) return
      const now = Date.now()
      if (text === lastText && now - lastSentAt < keepaliveMs) return
      pending = { text, since: pending?.since ?? now }
      schedule()
    },
    isVisible() {
      return visible && Date.now() - lastSentAt < 30_000
    },
    reset,
    async finish() {
      closed = true
      await reset()
    },
  }
}
