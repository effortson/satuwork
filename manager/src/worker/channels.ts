import { createDraftPump } from '../draft-pump.ts'
import { LostError, gw, seatRaw } from './relay-client.ts'

/**
 * 渠道（Telegram）的一轮，**工人这一半**。
 *
 * 一条 Telegram 消息进来之后要做的事分两段：跟席位说话、跟 Telegram 说话。第一段是「每
 * 100ms 问一次席位跑到哪儿了，最长二十分钟」——正是 Gateway 里不能再有的那种循环；第二段
 * 是几次短请求（typing、草稿、审批卡、最终回复）。所以切法是：**第一段搬到席位旁边（这里），
 * 第二段留在 Gateway**。工人不碰 Telegram 的 token，它只把「现在该发什么」报给 Gateway
 * （`POST /worker/channels/events/:id/progress`），由 Gateway 去发。
 *
 * 草稿的节流（draft-pump）在这一头跑：它管的是「多久刷一帧、攒几个字再刷」，离模型流最近的
 * 地方做最准；每一帧变成一次 progress 请求，Gateway 那头把 Telegram 的 429 / retry_after 原样
 * 回来，泵按它退。
 *
 * 租约：每一次 progress 都顺带续；Gateway 回 404 = 租约已被收走（工人死过、或者 Gateway 认为
 * 机器离线），此后一律停手，不再回报——那条事件会由别人接着跑。
 */

export interface ChannelJob {
  eventId: string
  bindingId: string
  botId: string
  seatId: string
  /** fencing token：每一次回报都带着，Gateway 只认持有者。 */
  lease: string
  externalEventId: string
  conversationId: string
  title: string
  text: string
  leaseMs: number
  timeoutMs: number
  /** 席位那头没回话时多久再问一次。 */
  pollMs: number
  draft: { minMs: number; batchChars: number; maxWaitMs: number; initialWaitMs: number; keepaliveMs: number }
}

interface ApprovalSnapshot { key: string; [k: string]: unknown }

type Progress = { kind: 'renew' } | { kind: 'typing' } | { kind: 'draft'; text: string } | { kind: 'approval'; approval: ApprovalSnapshot }
interface ProgressReply { retryAfterMs?: number; stop?: boolean }

class DraftRejected extends Error {
  constructor(public retryAfterMs: number, public stop: boolean) {
    super('draft rejected')
  }
}

export async function runChannelJob(job: ChannelJob, log: (line: string) => void = console.log): Promise<void> {
  const ac = new AbortController()
  const timeout = setTimeout(() => ac.abort(), Math.max(60_000, job.timeoutMs))
  let lost = false
  const progress = async (body: Progress): Promise<ProgressReply> => {
    try {
      return ((await gw(`/channels/events/${encodeURIComponent(job.eventId)}/progress`, { lease: job.lease, ...body })) as ProgressReply) ?? {}
    } catch (e) {
      if (e instanceof LostError) {
        lost = true
        ac.abort()
      }
      throw e
    }
  }
  const renew = setInterval(() => void progress({ kind: 'renew' }).catch(() => {}), Math.max(1000, Math.trunc(job.leaseMs / 3)))

  let typing: ReturnType<typeof setInterval> | null = null
  const startTyping = () => {
    if (typing) return
    void progress({ kind: 'typing' }).catch(() => {})
    typing = setInterval(() => void progress({ kind: 'typing' }).catch(() => {}), 4000)
  }
  const pauseTyping = () => {
    if (typing) clearInterval(typing)
    typing = null
  }
  const drafts = createDraftPump(
    async (text) => {
      const r = await progress({ kind: 'draft', text })
      if (r.stop || r.retryAfterMs) throw new DraftRejected(r.retryAfterMs || 0, Boolean(r.stop))
    },
    {
      ...job.draft,
      onSent: pauseTyping,
      onError: (error) => (error instanceof DraftRejected ? { retryAfterMs: error.retryAfterMs, stop: error.stop } : { stop: lost }),
    },
  )

  const finish = (body: Record<string, unknown>) =>
    gw(`/channels/events/${encodeURIComponent(job.eventId)}/finish`, { lease: job.lease, ...body }).catch((e) => {
      if (!(e instanceof LostError)) log(`satuwork-worker: 渠道事件 ${job.eventId} 回报失败：${(e as Error).message}`)
    })

  try {
    startTyping()
    const deadline = Date.now() + job.timeoutMs
    let sentApproval = ''
    for (;;) {
      if (ac.signal.aborted) throw new Error(lost ? 'lost' : '席位处理渠道消息超时')
      const { status, json } = await seatRaw(job.seatId, `/api/channels/${encodeURIComponent(job.bindingId)}/messages`, {
        method: 'POST',
        body: { botId: job.botId, eventId: job.externalEventId, conversationId: job.conversationId, title: job.title, text: job.text },
        timeoutMs: Math.max(1000, deadline - Date.now()),
      })
      const data = json as {
        status?: 'running' | 'approval'
        sessionId?: string
        reply?: string
        draft?: string
        files?: unknown
        handoffs?: unknown
        approval?: ApprovalSnapshot
        error?: string
      } | null
      if (status !== 202 && (status < 200 || status >= 300)) throw new Error(data?.error || `席位 HTTP ${status}`)
      if (status !== 202) {
        if (!data?.sessionId) throw new Error('席位没有返回渠道会话 id')
        await drafts.finish()
        pauseTyping()
        await finish({ sessionId: data.sessionId, reply: String(data.reply || ''), files: data.files ?? [], handoffs: data.handoffs ?? [] })
        log(`satuwork-worker: 渠道事件 ${job.eventId} 跑完`)
        return
      }
      if (data?.status === 'approval' && data.approval?.key) {
        if (sentApproval !== data.approval.key) {
          pauseTyping()
          // 发审批卡会清掉 Telegram 的临时草稿；批准后即使正文没变也要重发一帧。
          await drafts.reset()
          await progress({ kind: 'approval', approval: data.approval })
          sentApproval = data.approval.key
        }
      } else {
        if (data?.draft) drafts.enqueue(String(data.draft))
        if (!drafts.isVisible()) startTyping()
      }
      await new Promise((r) => setTimeout(r, job.pollMs))
    }
  } catch (e) {
    if (lost) return
    await drafts.finish().catch(() => {})
    pauseTyping()
    await finish({ error: ac.signal.aborted ? '席位处理渠道消息超时' : String((e as Error).message || e).slice(0, 300) })
  } finally {
    clearTimeout(timeout)
    clearInterval(renew)
    pauseTyping()
  }
}
