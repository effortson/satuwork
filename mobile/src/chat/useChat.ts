/**
 * 一条对话在手机上的全部数据流：取会话 → 拉历史 → 直连席位开 SSE → 事件进桶 → fold 成气泡。
 *
 * 规则全在 @satuwork/core：桶按 seq 插入去重（insertEvent）、游标（cursorOf）、折叠（fold）、
 * 翻页合并（mergeChatPage）、流的退避与状态码分治（runEventStream）。这里只是把它们接到
 * React 的生命周期上。
 *
 * 对话流**只直连席位机器**（docs/adr-gateway-vercel-neon.md §7）：Gateway 上没有反代。所以
 * 名单里 `runtime.streamUrl` 为空的 Bot，这里一个请求都不发，直接把原因摆出来。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { cursorOf, fold, insertEvent, mergeChatPage, runEventStream, type ChatPage, type Folded, type SessionEvent, type StreamStatus } from '@satuwork/core'
import { session } from '../gateway'

export const NO_DIRECT_STREAM_MSG = '这台机器没有配直连地址（或管家太旧），对话流开不了；找管理员在「机器」页填上 directUrl'
const TAIL_TURNS = 20

export interface RuntimeBot {
  id: string
  name: string
  avatar?: string
  description?: string
  channel?: string | null
  runtimeKind?: string
  runtime?: { kind?: string; status?: string; streamUrl?: string | null; uploadUrl?: string | null } | null
}

export interface ChatState {
  sessionId: string
  folded: Folded
  page: ChatPage
  /** 流的状态；null = 还没开。 */
  stream: StreamStatus | null
  /** 取会话 / 拉历史那一跳的错误。 */
  error: string
  loading: boolean
}

const EMPTY: Folded = { blocks: [], status: '', statusAt: 0, todos: null, channelVia: false, modelSeq: 0 }

export function useChat(bot: RuntimeBot | null) {
  const [state, setState] = useState<ChatState>({ sessionId: '', folded: EMPTY, page: {}, stream: null, error: '', loading: true })
  // 事件桶就地改（insertEvent 要求），所以放 ref；每次变化重新 fold 进 state。
  const events = useRef<SessionEvent[]>([])
  const live = useRef<boolean | null>(null)
  const paintTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const channelBot = Boolean(bot && bot.channel === 'telegram')

  const paint = useCallback(() => {
    if (paintTimer.current) return
    // 流式 chunk 一帧一个，合并到 50ms 一次重折，别每条都 setState。
    paintTimer.current = setTimeout(() => {
      paintTimer.current = null
      setState((s) => ({ ...s, folded: fold(events.current, live.current, channelBot) }))
    }, 50)
  }, [channelBot])

  const botId = bot?.id || ''
  const streamBase = bot?.runtime?.streamUrl || ''
  const hasRuntime = Boolean(bot?.runtime)

  useEffect(() => {
    events.current = []
    live.current = null
    setState({ sessionId: '', folded: EMPTY, page: {}, stream: null, error: '', loading: Boolean(botId) })
    if (!botId) return
    let gone = false
    let handle: ReturnType<typeof runEventStream> | null = null
    const client = session.client

    ;(async () => {
      let sessionId = ''
      try {
        const r = await client.api('GET', `/runtime/bots/${encodeURIComponent(botId)}/session`)
        sessionId = String((r && r.sessionId) || '')
        if (!sessionId) throw new Error('席位没有给会话')
      } catch (err: any) {
        if (!gone) setState((s) => ({ ...s, loading: false, error: err.message || String(err) }))
        return
      }
      if (gone) return
      setState((s) => ({ ...s, sessionId }))
      // 历史走 HTTP（一次二十轮）；流只管实时那一段，只垫一轮兜第一帧。
      try {
        const h = await client.api('GET', `/runtime/sessions/${encodeURIComponent(sessionId)}/history?turns=${TAIL_TURNS}`)
        if (gone) return
        for (const ev of (h && h.events) || []) insertEvent(events.current, ev)
        setState((s) => ({ ...s, loading: false, page: mergeChatPage(s.page, { firstSeq: h?.firstSeq, hasMore: h?.hasMore }) }))
        paint()
      } catch (err: any) {
        if (!gone) setState((s) => ({ ...s, loading: false, error: err.message || String(err) }))
      }
      if (!streamBase) {
        if (hasRuntime) setState((s) => ({ ...s, stream: { kind: 'dead', status: 0, message: NO_DIRECT_STREAM_MSG } }))
        return
      }
      handle = runEventStream({
        fetch: (url, init) => session.client.swFetch(url, init),
        url: (after) => `${streamBase}/sessions/${encodeURIComponent(sessionId)}/events` + (after != null ? `?after=${after}` : '?tail=1'),
        token: () => session.token,
        cursor: () => cursorOf(events.current),
        onStatus: (st) => !gone && setState((s) => ({ ...s, stream: st })),
        onEvent: (ev) => {
          if (gone || !ev || typeof ev !== 'object') return
          if (ev.type === 'runtime/hello' || ev.type === 'queue/change') return
          if (ev.type === 'replay/done') {
            if (typeof ev.live === 'boolean') live.current = ev.live
            if (typeof ev.firstSeq === 'number' || typeof ev.hasMore === 'boolean') {
              setState((s) => ({ ...s, page: mergeChatPage(s.page, { firstSeq: ev.firstSeq, hasMore: ev.hasMore }) }))
            }
            paint()
            return
          }
          if (live.current != null && (ev.type === 'turn/start' || ev.type === 'turn/end')) live.current = ev.type === 'turn/start'
          if (insertEvent(events.current, ev)) paint()
        },
      })
    })()

    return () => {
      gone = true
      handle?.close()
      if (paintTimer.current) {
        clearTimeout(paintTimer.current)
        paintTimer.current = null
      }
    }
  }, [botId, streamBase, hasRuntime, paint])

  /** 往前翻一页。 */
  const loadOlder = useCallback(async () => {
    const { sessionId, page } = state
    if (!sessionId || !page.hasMore || page.loading || page.firstSeq == null) return
    setState((s) => ({ ...s, page: mergeChatPage(s.page, { loading: true }) }))
    try {
      const h = await session.client.api('GET', `/runtime/sessions/${encodeURIComponent(sessionId)}/history?turns=${TAIL_TURNS}&before=${page.firstSeq}`)
      for (const ev of (h && h.events) || []) insertEvent(events.current, ev)
      setState((s) => ({ ...s, page: mergeChatPage({ ...s.page, loading: false }, { firstSeq: h?.firstSeq, hasMore: h?.hasMore, loading: false }) }))
      paint()
    } catch {
      setState((s) => ({ ...s, page: mergeChatPage(s.page, { loading: false }) }))
    }
  }, [state, paint])

  return { ...state, loadOlder }
}
