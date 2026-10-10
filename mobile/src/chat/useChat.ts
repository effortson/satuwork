/**
 * 一条对话在手机上的全部数据流：取会话 → 拉历史 → 直连席位开 SSE → 事件进桶 → fold 成气泡；
 * 发消息、中止、审批、上传也从这里出去。
 *
 * 规则全在 @satuwork/core：桶按 seq 插入去重（insertEvent）、游标（cursorOf）、折叠（fold）、
 * 本地回显的认领（mergePending）、翻页合并（mergeChatPage）、流的退避与状态码分治
 * （runEventStream）。这里只是把它们接到 React 的生命周期上。
 *
 * 对话流和上传**只直连席位机器**（docs/adr-gateway-vercel-neon.md §7）：Gateway 上没有反代。
 * 名单里 `runtime.streamUrl` / `uploadUrl` 为空的 Bot，这里一个请求都不发，直接把原因摆出来。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  cursorOf,
  fold,
  insertEvent,
  maxSeqOf,
  mergeChatPage,
  mergePending,
  runEventStream,
  t as coreT,
  type ChatPage,
  type Folded,
  type PendingMessage,
  type SessionEvent,
  type StreamStatus,
} from '@satuwork/core'
import { session } from '../gateway'

export const NO_DIRECT_STREAM_MSG = '这台机器没有配直连地址（或管家太旧），对话流开不了；找管理员在「机器」页填上 directUrl'
export const NO_UPLOAD_URL_MSG = '这台机器没有配直连地址（或管家太旧），上传不了'
const TAIL_TURNS = 20
/** 模型真能看的图片格式。跟席位那边的白名单是同一张表（web/index.ts 的 MODEL_IMAGE_MIME）。 */
const MODEL_IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export interface RuntimeBot {
  id: string
  name: string
  avatar?: string
  description?: string
  channel?: string | null
  runtimeKind?: string
  runtime?: { kind?: string; status?: string; streamUrl?: string | null; uploadUrl?: string | null } | null
}

/** 要传上去的一张图：本地 uri、文件名、mime。 */
export interface LocalFile {
  uri: string
  name: string
  mime: string
}

export interface QueuedMessage {
  id: string
  text: string
  createdAt?: number
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
  /** 席位那边排着的消息（真相在席位，这里只是它推过来的一份副本）。 */
  queue: QueuedMessage[]
  /** 点了停止、席位还没收口。 */
  stopping: boolean
  /** 正在发（上传 + POST）。 */
  sending: boolean
}

const EMPTY: Folded = { blocks: [], status: '', statusAt: 0, todos: null, channelVia: false, modelSeq: 0 }

export function useChat(bot: RuntimeBot | null) {
  const [state, setState] = useState<ChatState>({ sessionId: '', folded: EMPTY, page: {}, stream: null, error: '', loading: true, queue: [], stopping: false, sending: false })
  // 事件桶就地改（insertEvent 要求），所以放 ref；每次变化重新 fold 进 state。
  const events = useRef<SessionEvent[]>([])
  const live = useRef<boolean | null>(null)
  const pending = useRef<PendingMessage[]>([])
  const sessionRef = useRef('')
  const paintTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const channelBot = Boolean(bot && bot.channel === 'telegram')

  const paint = useCallback(() => {
    if (paintTimer.current) return
    // 流式 chunk 一帧一个，合并到 50ms 一次重折，别每条都 setState。
    paintTimer.current = setTimeout(() => {
      paintTimer.current = null
      const folded = fold(events.current, live.current, channelBot)
      // 本地回显：回执到了就销掉，没到的画成 pending 块。
      const mine = pending.current
      if (mine.length) pending.current = mergePending(folded, mine)
      setState((s) => ({
        ...s,
        folded,
        // 这一轮收口了，「正在停止」就没有意义了。
        stopping: s.stopping && folded.status === 'running',
      }))
    }, 50)
  }, [channelBot])

  const botId = bot?.id || ''
  const streamBase = bot?.runtime?.streamUrl || ''
  const uploadBase = bot?.runtime?.uploadUrl || ''
  const hasRuntime = Boolean(bot?.runtime)

  useEffect(() => {
    events.current = []
    live.current = null
    pending.current = []
    sessionRef.current = ''
    setState({ sessionId: '', folded: EMPTY, page: {}, stream: null, error: '', loading: Boolean(botId), queue: [], stopping: false, sending: false })
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
      sessionRef.current = sessionId
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
          if (ev.type === 'runtime/hello') return
          /**
           * 排队的消息有变。**不是会话事件**，不进事件桶——它还没发生，进了桶就会被当成
           * 历史画成气泡。它只画在输入框顶上那一行。
           */
          if (ev.type === 'queue/change') {
            setState((s) => ({ ...s, queue: Array.isArray(ev.queued) ? ev.queued : [] }))
            return
          }
          if (ev.type === 'replay/done') {
            if (typeof ev.live === 'boolean') live.current = ev.live
            if (Array.isArray(ev.queued)) setState((s) => ({ ...s, queue: ev.queued }))
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

  /**
   * 把一个文件传进这条会话的工作区，返回 { path, name, size, contentType }。
   *
   * 文件名走 header：查询串会进访问日志，而文件名常常就是内容本身。header 只认 ASCII，
   * 所以先 encodeURIComponent，席位那边解回来。裸字节进 body。
   */
  const upload = useCallback(
    async (file: LocalFile) => {
      const sessionId = sessionRef.current
      if (!sessionId) throw new Error('会话还没好')
      if (!uploadBase) throw new Error(coreT(session.locale, NO_UPLOAD_URL_MSG))
      const blob = await (await fetch(file.uri)).blob()
      const tok = session.token
      const res = await fetch(`${uploadBase}/sessions/${encodeURIComponent(sessionId)}/files`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/octet-stream',
          'x-filename': encodeURIComponent(file.name),
          ...(tok ? { authorization: 'Bearer ' + tok } : {}),
        },
        body: blob,
      })
      const text = await res.text()
      let json: any = null
      try {
        json = text ? JSON.parse(text) : null
      } catch {}
      if (!res.ok) throw new Error((json && json.error) || 'HTTP ' + res.status)
      return json as { path: string; name: string; size: number; contentType?: string }
    },
    [uploadBase],
  )

  /**
   * 发一条。**先画上，再发**：POST 出去到席位把 user/message 经 SSE 送回来，中间少则几百毫秒、
   * 多则几十秒，屏幕上先有本地回显，人才知道那一下生效了。回执认领规则见 core 的 mergePending。
   *
   * 附件先传、再把路径列进正文（Bot 想读哪段读哪段）；图片另走 `images`，到模型那边是真正的
   * 视觉输入。失败就把本地那条撤掉并抛出去——调用方把草稿还给输入框。
   */
  const send = useCallback(
    async (text: string, files: LocalFile[] = []) => {
      const sessionId = sessionRef.current
      if (!sessionId) throw new Error('会话还没好')
      const body = text.trim()
      if (!body && !files.length) return
      setState((s) => ({ ...s, sending: true }))
      try {
        const uploaded: { path: string; mime: string }[] = []
        for (const f of files) {
          const r = await upload(f)
          uploaded.push({ path: r.path, mime: String(r.contentType || f.mime || '').split(';')[0].trim() })
        }
        const lead = coreT(session.locale, '我上传了文件，在工作区里：')
        const full = uploaded.length ? lead + '\n' + uploaded.map((f) => '- `' + f.path + '`').join('\n') + (body ? '\n\n' + body : '') : body
        const images = uploaded.filter((f) => MODEL_IMAGE.has(f.mime))
        const p: PendingMessage = { sessionId, text: full, images, mentions: [], refs: [], at: Date.now(), afterSeq: maxSeqOf(events.current) }
        pending.current = pending.current.concat(p)
        paint()
        try {
          const r = await session.client.api('POST', `/runtime/sessions/${encodeURIComponent(sessionId)}/messages`, {
            text: full,
            ...(images.length ? { images } : {}),
          })
          // 排队了：把刚画上的那条撤掉，改画成输入框顶上的一行（席位紧接着会推 queue/change，
          // 这里先自己填一行是为了「点了发送立刻有反应」）。
          if (r && r.queued) {
            pending.current = pending.current.filter((x) => x !== p)
            setState((s) => ({ ...s, queue: s.queue.concat({ id: String(r.queueId || ''), text: full, createdAt: Date.now() }) }))
            paint()
          }
        } catch (err) {
          // 没发出去就把这条回显撤掉，别让屏幕上留一条其实不存在的消息。
          pending.current = pending.current.filter((x) => x !== p)
          paint()
          throw err
        }
      } finally {
        setState((s) => ({ ...s, sending: false }))
      }
    },
    [paint, upload],
  )

  /** 停掉正在跑的这一轮。先改界面再发请求：那几百毫秒里流上一个事件都不会来。 */
  const abort = useCallback(async () => {
    const sessionId = sessionRef.current
    if (!sessionId) return
    setState((s) => ({ ...s, stopping: true }))
    try {
      const r = await session.client.api('POST', `/runtime/sessions/${encodeURIComponent(sessionId)}/abort`, {})
      if (r && r.aborted === false) setState((s) => ({ ...s, stopping: false }))
    } catch {
      setState((s) => ({ ...s, stopping: false }))
    }
  }, [])

  /** 高风险确认：同意 / 拒绝。409 是「这条早就结束了」，抛出去让调用方说一声。 */
  const decide = useCallback(async (callId: string, decision: 'approve' | 'deny') => {
    const sessionId = sessionRef.current
    if (!sessionId || !callId) return
    await session.client.api('POST', `/runtime/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(callId)}`, { decision, scope: 'once' })
  }, [])

  /** 撤掉一条排着的消息。 */
  const dequeue = useCallback(async (queueId: string) => {
    const sessionId = sessionRef.current
    if (!sessionId || !queueId) return
    await session.client.api('DELETE', `/runtime/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queueId)}`)
    setState((s) => ({ ...s, queue: s.queue.filter((q) => q.id !== queueId) }))
  }, [])

  return { ...state, loadOlder, send, abort, decide, dequeue, canUpload: Boolean(uploadBase) }
}
