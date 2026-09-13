import { randomUUID } from 'node:crypto'
import type { Db, ChannelEvent, ChannelHandoffPrompt, Handoff } from './db.ts'
import { decryptChannelSecret, encryptChannelSecret, signArtifactTicket, timingSafeToken, type JwtKeys } from './crypto.ts'
import { machineTokenFor, seatBearer } from './lib/runtime.ts'
import { gatewayPublicUrl } from './deploy.ts'
import { pairingCodeHash } from './channels/pairing.ts'
import { createDraftPump } from './channels/draft-pump.ts'
import { ensureTelegramInbound, telegramWebhookMode } from './channels/inbound.ts'
import { MIN_CHANNEL_WORKER_PROTOCOL } from './deploy.ts'
import { callSeat, canActOn } from './lib/handoff.ts'
import {
  TelegramError, normalizeTelegramCallback, normalizeTelegramUpdate, telegramAnswerCallbackQuery,
  telegramClearApprovalButtons, telegramGetUpdates, telegramJoinedSharedChat, telegramSendApproval,
  telegramSendHandoff, telegramSendHandoffReplyPrompt,
  startTelegramTyping, telegramLeaveChat, telegramSendArtifactPreviews, telegramSendDraft, telegramSendText, telegramSetMyCommands,
} from './channels/telegram.ts'

export interface StoredSecret { token: string; pairingCode: string }

interface ChannelApprovalField {
  key?: string
  label?: string
  value?: string
  editable?: boolean
  multiline?: boolean
}

const TICK_MS = Math.max(250, Math.trunc(Number(process.env.GATEWAY_CHANNEL_TICK_MS ?? 2000)))
const TURN_TIMEOUT_MS = Math.max(60_000, Math.trunc(Number(process.env.GATEWAY_CHANNEL_TURN_TIMEOUT_MS ?? 20 * 60_000)))
/**
 * 处理一轮可以很久，但租约不能跟着长达二十分钟：Gateway 热重启后会留下孤儿租约。
 * 短租约靠心跳续命，进程一没了，接管最多等这一小段。
 */
const EVENT_LEASE_MS = Math.max(15_000, Math.trunc(Number(process.env.GATEWAY_CHANNEL_EVENT_LEASE_MS ?? 30_000)))
const EVENT_LEASE_RENEW_MS = Math.max(1000, Math.min(
  Math.trunc(EVENT_LEASE_MS / 3),
  Math.trunc(Number(process.env.GATEWAY_CHANNEL_EVENT_LEASE_RENEW_MS ?? 10_000)),
))
const MAX_ATTEMPTS = 8
const POLL_SCAN_MS = Math.max(250, Math.trunc(Number(process.env.GATEWAY_CHANNEL_POLL_SCAN_MS ?? 1000)))
const POLL_TIMEOUT_SECONDS = Math.min(50, Math.max(1, Math.trunc(Number(process.env.GATEWAY_CHANNEL_POLL_TIMEOUT_SECONDS ?? 30))))
const POLL_LEASE_MS = (POLL_TIMEOUT_SECONDS + 20) * 1000
/** 长轮询/API 暂时失败后不要每秒轰 Telegram；429 给的 retry_after 优先。 */
const POLL_RETRY_MS = Math.max(1000, Math.trunc(Number(process.env.GATEWAY_CHANNEL_POLL_RETRY_MS ?? 5000)))
/**
 * 「归工人却没人来领」等多久就报出来。
 *
 * 工人两秒一轮（manager 的 CHANNEL_TICK_MS），两分钟等于漏了六十轮，不可能是抖动；
 * 而换版重启（systemd-run --on-active=2s 加进程起来）只断几十秒，够它跨过去。
 */
const WORKER_UNCLAIMED_MS = Math.max(30_000, Math.trunc(Number(process.env.GATEWAY_CHANNEL_UNCLAIMED_MS ?? 120_000)))
/** 席位接口自己最多等 250ms；短间隔继续取最新快照，不让 HTTP 轮询成为逐字瓶颈。 */
const TURN_POLL_MS = Math.max(50, Math.trunc(Number(process.env.GATEWAY_CHANNEL_TURN_POLL_MS ?? 100)))
/** 草稿与 typing 共用 Telegram 的 live-action 限额；一秒一帧留足突发余量。 */
const DRAFT_MIN_MS = Math.max(800, Math.trunc(Number(process.env.GATEWAY_TELEGRAM_DRAFT_MIN_MS ?? 1000)))
/** Telegram 官方建议按 N 字符或 M 秒组包；避免每个 token 都触发客户端动画。 */
const DRAFT_BATCH_CHARS = Math.max(4, Math.trunc(Number(process.env.GATEWAY_TELEGRAM_DRAFT_BATCH_CHARS ?? 24)))
const DRAFT_MAX_WAIT_MS = Math.max(DRAFT_MIN_MS, Math.trunc(Number(process.env.GATEWAY_TELEGRAM_DRAFT_MAX_WAIT_MS ?? 1200)))
const DRAFT_INITIAL_WAIT_MS = Math.max(0, Math.trunc(Number(process.env.GATEWAY_TELEGRAM_DRAFT_INITIAL_WAIT_MS ?? 250)))
/** live draft 约 30 秒失效。工具长时间没产出文字时，在失效前续一帧。 */
const DRAFT_KEEPALIVE_MS = Math.max(5000, Math.min(25_000, Math.trunc(Number(process.env.GATEWAY_TELEGRAM_DRAFT_KEEPALIVE_MS ?? 20_000))))
/** 交给工人的那一份节拍：它在席位旁边跑草稿泵和轮询，数值要和 Gateway 自己跑时一样。 */
export const CHANNEL_WORKER_TUNING = {
  leaseMs: EVENT_LEASE_MS,
  timeoutMs: TURN_TIMEOUT_MS,
  pollMs: TURN_POLL_MS,
  draft: { minMs: DRAFT_MIN_MS, batchChars: DRAFT_BATCH_CHARS, maxWaitMs: DRAFT_MAX_WAIT_MS, initialWaitMs: DRAFT_INITIAL_WAIT_MS, keepaliveMs: DRAFT_KEEPALIVE_MS },
}
let wakeCurrent: (() => void) | null = null
/** 本进程已经给哪些存量绑定补过私聊命令菜单。失败不记，下一轮继续试。 */
const commandsConfigured = new Set<string>()

export function kickChannelDispatcher(): void { wakeCurrent?.() }

function retryDelay(attempts: number): number {
  return Math.min(5 * 60_000, 5000 * Math.pow(2, Math.min(6, Math.max(0, attempts - 1))))
}

export interface ChannelApprovalSnapshot {
  key: string
  callId: string
  name: string
  arguments: string
  reason: string
  form?: {
    kind?: string
    tool?: string
    fields?: ChannelApprovalField[]
  }
}

interface SeatAccess {
  host: string
  headers: Record<string, string>
}

interface ChannelFile { path: string; name: string }

export function channelFiles(raw: unknown): ChannelFile[] {
  if (!Array.isArray(raw)) return []
  const out = new Map<string, ChannelFile>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const path = String((item as { path?: unknown }).path ?? '').trim()
    const name = String((item as { name?: unknown }).name ?? '').trim()
    if (!path || !name || path.length > 2048 || name.length > 512) continue
    out.set(path, { path, name })
    if (out.size >= 32) break
  }
  return [...out.values()]
}

export function channelHandoffs(raw: unknown): ChannelHandoffPrompt[] {
  if (!Array.isArray(raw)) return []
  const out = new Map<string, ChannelHandoffPrompt>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const id = String(row.id ?? '').trim()
    const state = row.state === 'claimed' ? 'claimed' : row.state === 'open' ? 'open' : null
    const reason = String(row.reason ?? '').trim()
    const ask = String(row.ask ?? '').trim()
    if (!id || !state || !reason || !ask) continue
    out.set(id, {
      id, state, reason, ask,
      ...(String(row.summary ?? '').trim() ? { summary: String(row.summary).trim() } : {}),
      blocking: row.blocking !== false,
      repeats: Math.max(0, Number(row.repeats) || 0),
      createdAt: Number(row.createdAt) || Date.now(),
      updatedAt: Number(row.updatedAt) || Date.now(),
    })
    if (out.size >= 8) break
  }
  return [...out.values()]
}

function artifactPreviews(keys: JwtKeys, accountId: string, sessionId: string, files: ChannelFile[]) {
  const base = gatewayPublicUrl()
  return files.map((file) => {
    const ticket = signArtifactTicket(keys, accountId, sessionId, file.path)
    return {
      name: file.name,
      url: `${base}/channel-artifacts/${encodeURIComponent(ticket)}/${encodeURIComponent(file.name)}`,
    }
  })
}

async function seatAccess(db: Db, binding: NonNullable<Awaited<ReturnType<Db['channelBinding']>>>): Promise<SeatAccess> {
  const instance = await db.instance(binding.accountId, binding.botId)
  const host = String(instance?.host || '').trim().replace(/\/$/, '')
  if (!host) throw new Error('telegram bot 还没有部署完成')
  const account = await db.account(binding.accountId)
  if (!account) throw new Error('渠道所属账号不存在')
  const bearer = await seatBearer(db, binding.accountId)
  const machine = await machineTokenFor(db, account, binding.botId)
  return {
    host,
    headers: {
      accept: 'application/json', 'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(machine ? { 'x-satuwork-machine': machine } : {}),
    },
  }
}

async function runSeatTurn(
  db: Db,
  event: ChannelEvent,
  binding: NonNullable<Awaited<ReturnType<Db['channelBinding']>>>,
  hooks: {
    onApproval?: (approval: ChannelApprovalSnapshot) => Promise<void>
    onDraft?: (draft: string) => Promise<void>
    onRunning?: () => void
  } = {},
) {
  const access = await seatAccess(db, binding)
  const deadline = Date.now() + TURN_TIMEOUT_MS
  while (Date.now() < deadline) {
    const r = await fetch(`${access.host}/api/channels/${encodeURIComponent(binding.id)}/messages`, {
      method: 'POST', headers: access.headers,
      body: JSON.stringify({
        botId: binding.botId,
        eventId: event.externalEventId,
        conversationId: event.externalConversationId,
        title: event.title,
        text: event.text,
      }),
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    })
    const data = await r.json().catch(() => null) as {
      status?: 'running' | 'approval'
      sessionId?: string
      reply?: string
      draft?: string
      files?: unknown
      handoffs?: unknown
      approval?: ChannelApprovalSnapshot
      error?: string
    } | null
    if (!r.ok && r.status !== 202) throw new Error(data?.error || `席位 HTTP ${r.status}`)
    if (r.status !== 202) {
      if (!data?.sessionId) throw new Error('席位没有返回渠道会话 id')
      return {
        sessionId: data.sessionId,
        reply: String(data.reply || '').trim() || '已处理，但没有可发送的文本回复。',
        files: channelFiles(data.files),
        handoffs: channelHandoffs(data.handoffs),
      }
    }
    if (data?.status === 'approval' && data.approval?.key) await hooks.onApproval?.(data.approval)
    else {
      if (data?.draft) await hooks.onDraft?.(String(data.draft))
      hooks.onRunning?.()
    }
    await new Promise((resolve) => setTimeout(resolve, TURN_POLL_MS))
  }
  throw new Error('席位处理渠道消息超时')
}

async function decideSeatApproval(
  db: Db,
  binding: NonNullable<Awaited<ReturnType<Db['channelBinding']>>>,
  approvalKey: string,
  decision: 'approve' | 'deny',
  scope: 'once' | 'turn',
): Promise<'ok' | 'gone'> {
  const access = await seatAccess(db, binding)
  const r = await fetch(`${access.host}/api/channels/${encodeURIComponent(binding.id)}/approvals/${encodeURIComponent(approvalKey)}`, {
    method: 'POST', headers: access.headers,
    body: JSON.stringify({ botId: binding.botId, decision, scope }),
    signal: AbortSignal.timeout(15_000),
  })
  const data = await r.json().catch(() => null) as { error?: string } | null
  if (r.status === 409) return 'gone'
  if (!r.ok) throw new Error(data?.error || `席位 HTTP ${r.status}`)
  return 'ok'
}

function compactMarkdown(value: unknown, max: number): string {
  const chars = Array.from(String(value ?? '').replace(/```/g, "'''"))
  return chars.length <= max ? chars.join('') : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`
}

function quotedMarkdown(value: unknown): string {
  const text = String(value ?? '').replace(/\r\n?/g, '\n')
  if (!text) return '> （空）'
  return text.split('\n').map((line) => line ? `> ${line}` : '>').join('\n')
}

/** 同一个渠道事件在重试/接管后仍使用同一个非零草稿 id。 */
export function telegramDraftId(value: string): number {
  let hash = 0x811c9dc5
  for (const char of value) {
    hash ^= char.codePointAt(0) || 0
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash & 0x7fffffff) || 1
}

function emailApprovalDetails(fields: ChannelApprovalField[]): string {
  const body = fields.find((field) => field.multiline)
  const metadata = fields.filter((field) => field !== body).map((field) => {
    const label = compactMarkdown(field.label || field.key || '参数', 80).replace(/[*_`]/g, '')
    const value = compactMarkdown(field.value, 600).replace(/\s+/g, ' ').replace(/`/g, "'") || '（空）'
    return `- **${label}**：\`${value}\``
  })
  const sections = ['### 邮件内容']
  if (metadata.length) sections.push(metadata.join('\n'))
  sections.push(
    '',
    '### 正文',
    // 正文不截断。引用块既保留原始段落和列表，也把正文与审批说明清楚地区分开。
    quotedMarkdown(body?.value),
  )
  return sections.join('\n')
}

export function approvalMarkdown(approval: ChannelApprovalSnapshot): string {
  const tool = compactMarkdown(approval.form?.tool || approval.name || '未知操作', 160).replace(/`/g, "'")
  const fields = Array.isArray(approval.form?.fields) ? approval.form.fields : []
  const details = approval.form?.kind === 'email' && fields.length
    ? emailApprovalDetails(fields)
    : fields.length
    ? [
      ...fields.slice(0, 4).map((field) => {
      const label = compactMarkdown(field.label || field.key || '参数', 80).replace(/[*_`]/g, '')
      const value = compactMarkdown(field.value, field.multiline ? 400 : 200)
      return field.multiline ? `**${label}**\n\`\`\`text\n${value}\n\`\`\`` : `- **${label}**：\`${value.replace(/`/g, "'")}\``
      }),
      ...(fields.length > 4 ? [`_还有 ${fields.length - 4} 项参数，请在 Web 中查看完整内容。_`] : []),
    ].join('\n\n')
    : `\`\`\`json\n${compactMarkdown(approval.arguments || '{}', 2200)}\n\`\`\``
  const parameterSection = approval.form?.kind === 'email' && fields.length
    ? details
    : `**参数**\n${details}`
  return [
    '## 需要你的批准',
    '',
    compactMarkdown(approval.reason || 'Bot 准备执行一个需要确认的操作。', 600),
    '',
    `**操作**：\`${tool}\``,
    '',
    parameterSection,
    '',
    '请选择下面的批准范围。Telegram 暂不支持编辑参数；如需修改，请在 Web 中审批。',
  ].join('\n')
}

export function handoffMarkdown(handoff: ChannelHandoffPrompt): string {
  const sections = [
    '## 转人工 · 等人接手',
    '',
    `**需要你做**：${compactMarkdown(handoff.ask, 800)}`,
    '',
    `**原因**：${compactMarkdown(handoff.reason, 800)}`,
  ]
  if (handoff.summary) sections.push('', `**当前进展**：${compactMarkdown(handoff.summary, 1400)}`)
  if (handoff.repeats > 0) sections.push('', `_这件事又遇到了 ${handoff.repeats} 次。_`)
  sections.push('', '处理完成或想换一种做法时，点按钮后直接回复 Telegram 的输入提示。')
  return sections.join('\n')
}

async function processOne(db: Db, key: Buffer, keys: JwtKeys, event: ChannelEvent): Promise<void> {
  const leaseToken = randomUUID()
  if (!await db.claimChannelEvent(event.id, Date.now(), Date.now() + EVENT_LEASE_MS, leaseToken)) return
  let renewing = false
  const renew = async () => {
    if (renewing) return
    renewing = true
    try {
      await db.renewChannelEventLease(event.id, leaseToken, Date.now() + EVENT_LEASE_MS)
    } catch (e) {
      // 数据库短抖时保留本地工作；fencing update 会阻止已经失去租约的进程提交。
      console.warn(`satuwork-gateway: 渠道事件 ${event.id} 续租失败：${(e as Error).message}`)
    } finally {
      renewing = false
    }
  }
  const renewTimer = setInterval(() => { void renew() }, EVENT_LEASE_RENEW_MS)
  renewTimer.unref?.()
  try {
    const current = await db.channelEvent(event.id)
    const binding = current ? await db.channelBinding(current.bindingId) : undefined
    if (!current) return
    if (!binding || binding.status !== 'active') {
      await db.updateClaimedChannelEvent(current.id, leaseToken, {
        status: 'pending', nextTryAt: Date.now(), leaseUntil: null,
      })
      return
    }
    let reply = current.reply
    let sessionId = current.sessionId
    let files = current.files
    let handoffs = current.handoffs
    const secret = decryptChannelSecret<StoredSecret>(key, binding.credentialCiphertext)
    try {
      if (!reply) {
        let typingWarned = false
        let draftWarned = false
        const draftId = telegramDraftId(current.externalEventId)
        let stopTyping: (() => void) | null = null
        const startTyping = () => {
          if (stopTyping) return
          stopTyping = startTelegramTyping(secret.token, current.externalConversationId, {
            onError: (error) => {
              if (typingWarned) return
              typingWarned = true
              console.warn(`satuwork-gateway: Telegram 正在输入状态发送失败：${error.message}`)
            },
          })
        }
        const pauseTyping = () => {
          stopTyping?.()
          stopTyping = null
        }
        const drafts = createDraftPump(
          (text) => telegramSendDraft(secret.token, current.externalConversationId, draftId, text),
          {
            minMs: DRAFT_MIN_MS,
            batchChars: DRAFT_BATCH_CHARS,
            maxWaitMs: DRAFT_MAX_WAIT_MS,
            initialWaitMs: DRAFT_INITIAL_WAIT_MS,
            keepaliveMs: DRAFT_KEEPALIVE_MS,
            onSent: pauseTyping,
            onError: (error) => {
              const tg = error instanceof TelegramError ? error : null
              if (!draftWarned) {
                draftWarned = true
                console.warn(`satuwork-gateway: Telegram 流式草稿发送失败，继续等待最终回复：${(error as Error).message}`)
              }
              // 草稿上的非限流 4xx 原样重试不会变好；本轮退回 typing，最终消息仍照常发送。
              return {
                retryAfterMs: tg?.retryAfterMs || 0,
                stop: Boolean(tg && tg.status >= 400 && tg.status < 500 && tg.status !== 429),
              }
            },
          },
        )
        startTyping()
        let ran: Awaited<ReturnType<typeof runSeatTurn>>
        try {
          ran = await runSeatTurn(db, current, binding, {
            onRunning: () => { if (!drafts.isVisible()) startTyping() },
            onDraft: async (draft) => { drafts.enqueue(draft) },
            onApproval: async (approval) => {
              pauseTyping()
              // 发送审批消息会清掉 Telegram 临时草稿；批准后即使正文没变也要重发一帧。
              await drafts.reset()
              const latest = await db.channelEvent(current.id)
              if (latest?.approvalKey === approval.key && latest.approvalMessageId != null) return
              const messageId = await telegramSendApproval(
                secret.token, current.externalConversationId, approvalMarkdown(approval), approval.key,
              )
              if (!await db.recordChannelApprovalPrompt(current.id, leaseToken, approval.key, messageId)) {
                throw new Error('渠道事件租约已经转交')
              }
            },
          })
        } finally {
          await drafts.finish()
          pauseTyping()
        }
        reply = ran.reply
        sessionId = ran.sessionId
        files = ran.files
        handoffs = ran.handoffs
      }
      await deliverClaimedEvent(db, key, keys, current, binding, leaseToken, { sessionId, reply, files, handoffs })
    } catch (e) {
      await failClaimedEvent(db, current, binding, leaseToken, e, { sessionId, reply })
    }
  } finally {
    clearInterval(renewTimer)
  }
}

type Binding = NonNullable<Awaited<ReturnType<Db['channelBinding']>>>

/**
 * 一轮已经跑完，把结果送到 Telegram 并把事件收成 delivered。**Gateway 自己跑完的和工人回报
 * 的都走这一条**（routes/worker.ts 的 finish），投递、去重、收口只有一份。
 *
 * 先把结果落盘、继续持有租约，再发：进程若在发送前崩溃，接管者只会重发这份 reply，绝不会
 * 再烧一轮模型。结果里 reply 已有（接管重发）时不再落一次。抛出的错由 failClaimedEvent 接。
 */
export async function deliverClaimedEvent(
  db: Db,
  key: Buffer,
  keys: JwtKeys,
  current: ChannelEvent,
  binding: Binding,
  leaseToken: string,
  result: { sessionId: string | null; reply: string; files: ChannelFile[]; handoffs: ChannelHandoffPrompt[] },
): Promise<void> {
  const secret = decryptChannelSecret<StoredSecret>(key, binding.credentialCiphertext)
  const { sessionId, files, handoffs } = result
  const reply = String(result.reply || '').trim() || '已处理，但没有可发送的文本回复。'
  if (!current.reply) {
    const saved = await db.updateClaimedChannelEvent(current.id, leaseToken, {
      status: 'processing', attempts: current.attempts, nextTryAt: Date.now(),
      sessionId, reply, files, handoffs, lastError: null,
    })
    if (!saved) return
  }
  // 出站最多 20 秒；发送前把 30 秒窗口重新撑满，正常情况下不会被另一进程并发重发。
  if (!await db.renewChannelEventLease(current.id, leaseToken, Date.now() + EVENT_LEASE_MS)) return
  // 渠道只接受私聊，conversationId 就是唯一配对用户的 chat id。
  await telegramSendText(secret.token, current.externalConversationId, reply)
  if (sessionId && files.length) {
    await telegramSendArtifactPreviews(
      secret.token,
      current.externalConversationId,
      artifactPreviews(keys, binding.accountId, sessionId, files),
    )
  }
  for (const handoff of handoffs) {
    await telegramSendHandoff(secret.token, current.externalConversationId, handoffMarkdown(handoff), handoff.id)
  }
  const delivered = await db.updateClaimedChannelEvent(current.id, leaseToken, {
    status: 'delivered', attempts: current.attempts, nextTryAt: null, leaseUntil: null,
    sessionId, reply, files, handoffs, lastError: null, deliveredAt: Date.now(),
  })
  if (delivered) await db.updateChannelBinding(binding.id, { lastError: null })
}

/** 这一轮砸了：排重试或记 dead，把原因写到事件和绑定上。同样只有这一份。 */
export async function failClaimedEvent(
  db: Db,
  current: ChannelEvent,
  binding: Binding,
  leaseToken: string,
  e: unknown,
  partial: { sessionId: string | null; reply: string },
): Promise<void> {
  const attempts = current.attempts + 1
  const tg = e instanceof TelegramError ? e : null
  // sendMessage 上的 403 / 404 / 400（被拉黑、chat 没了、消息不合法）原样重发不会变好，
  // 这条事件直接 dead；但那不是 token 失效，binding 不动（见 TelegramError.permanent）。
  const dead = attempts >= MAX_ATTEMPTS || Boolean(tg && !tg.retryable)
  const message = String((e as Error)?.message || e).slice(0, 300)
  const updated = await db.updateClaimedChannelEvent(current.id, leaseToken, {
    status: dead ? 'dead' : 'retry', attempts,
    nextTryAt: dead ? null : Date.now() + (tg?.retryAfterMs || retryDelay(attempts)),
    leaseUntil: null, sessionId: partial.sessionId, reply: partial.reply, lastError: message,
  })
  if (updated) {
    await db.updateChannelBinding(binding.id, {
      ...(tg?.permanent ? { status: 'error' as const } : {}),
      lastError: message,
    })
  }
}

/**
 * 这条绑定的 Bot 所在机器够不够新到自己跑渠道那一轮（协议 ≥ MIN_CHANNEL_WORKER_PROTOCOL）。
 * 够新就归工人：Gateway 的扫描不碰它**还没有回复**的事件（跑一轮是工人的活）；已经有回复、
 * 只差投递的照旧 Gateway 发（投递是几次短请求）。一次 tick 里同一台机器只问一遍。
 */
export async function workerOwnedBinding(db: Db, binding: Binding, cache: Map<string, boolean>): Promise<boolean> {
  const rt = await db.seatRuntime(binding.accountId, binding.botId)
  if (!rt?.machineId) return false
  const hit = cache.get(rt.machineId)
  if (hit !== undefined) return hit
  const machine = await db.machine(rt.machineId)
  const owned = (machine?.protocol ?? 0) >= MIN_CHANNEL_WORKER_PROTOCOL
  cache.set(rt.machineId, owned)
  return owned
}

/**
 * 「这条归工人，可工人一直没来领」——把它说出来。
 *
 * **不说的话，这种故障没有任何外在迹象**：事件停在 `pending`、`attempts` 永远 0、
 * 事件自己的 `lastError` 永远空，而 Gateway 判定归工人之后就不再兜底，于是 Telegram
 * 那头的表现只是「机器人不理人」。实际发生过一次：机器是老脚本装的，压根没有
 * `satuwork-worker` 单元，协议升上去之后消息静默堆了将近一天，靠人报故障才发现。
 * 日常任务那条路反倒有交代（`routine_runs` 会写「管家太旧」「机器没回报」），渠道这条
 * 什么都没有。
 *
 * 写在**绑定**的 `lastError` 上，不是事件的：渠道页显示的就是它（ui/pages-channels.js），
 * 而事件的 lastError 没有任何界面。投递成功时那句会被清掉（见 deliver 那一支），所以
 * 工人一恢复，红字自己就消失了，不需要谁去清。
 *
 * 三个不碰的情况：等得还不够久；领过了（`attempts` 或租约有值）——那是「跑失败」，
 * 另一回事，别抢它的位置；话已经写在那儿了——否则每一轮扫描都写一次库。
 */
async function flagUnclaimed(db: Db, binding: Binding, event: ChannelEvent): Promise<void> {
  if (Date.now() - event.createdAt < WORKER_UNCLAIMED_MS) return
  if (event.attempts > 0 || event.leaseUntil) return
  const msg =
    '收到的消息没人处理：这台机器的席位工人（satuwork-worker）没在领活。' +
    '到机器上看一眼 `systemctl status satuwork-worker`；单元不在就重跑一次装机脚本补上。'
  if (binding.lastError === msg) return
  await db.updateChannelBinding(binding.id, { lastError: msg })
  // 只在第一次写库时说一句：上面那个比较天然把日志也节流了。
  console.warn(`satuwork-gateway: 渠道 ${binding.id} 的消息没人来领，席位工人多半没在跑`)
}

function rawUpdateId(raw: unknown): number | null {
  const n = Number(raw && typeof raw === 'object' ? (raw as { update_id?: unknown }).update_id : NaN)
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

const APPROVAL_CALLBACK = /^swa:([A-Za-z0-9_-]{22}):(a1|at|d1|dt)$/
const HANDOFF_CALLBACK = /^swh:([0-9a-f-]{36}):(c|d|i|x)$/i
const HANDOFF_REPLY = /\[satuwork-handoff:([0-9a-f-]{36}):(done|instructions):(\d+)\]/i

interface SeatHandoffSnapshot {
  state?: unknown
  claimedBy?: { accountId?: unknown } | null
  repeats?: unknown
  updatedAt?: unknown
}

async function syncChannelHandoff(db: Db, handoff: Handoff, seat: SeatHandoffSnapshot | undefined): Promise<Handoff> {
  if (!seat || typeof seat.state !== 'string') return handoff
  const claimedBy = typeof seat.claimedBy?.accountId === 'string' ? seat.claimedBy.accountId : handoff.claimedBy
  return db.upsertHandoff({
    ...handoff,
    state: seat.state as Handoff['state'],
    claimedBy: claimedBy || null,
    repeats: typeof seat.repeats === 'number' ? seat.repeats : handoff.repeats,
    updatedAt: typeof seat.updatedAt === 'number' ? seat.updatedAt : Date.now(),
  })
}

/** 席位上报交接单走异步 outbox；给刚发出的 Telegram 按钮留一个很短的追平窗口。 */
async function waitForChannelHandoff(db: Db, id: string): Promise<Handoff | undefined> {
  for (let i = 0; i < 10; i += 1) {
    const handoff = await db.handoff(id)
    if (handoff) return handoff
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return undefined
}

async function processTelegramHandoffCallback(
  db: Db,
  key: Buffer,
  binding: NonNullable<Awaited<ReturnType<Db['channelBinding']>>>,
  raw: unknown,
): Promise<boolean> {
  const callback = normalizeTelegramCallback(raw)
  if (!callback) return false
  const parsed = HANDOFF_CALLBACK.exec(callback.data)
  if (!parsed) return false
  const secret = decryptChannelSecret<StoredSecret>(key, binding.credentialCiphertext)
  const answer = async (text: string, showAlert = false) => {
    try { await telegramAnswerCallbackQuery(secret.token, callback.queryId, text, showAlert) }
    catch (e) {
      console.warn(`satuwork-gateway: Telegram 转人工回调 ${callback.queryId} 已无法应答：${(e as Error).message}`)
    }
  }
  const identity = await db.channelIdentity(binding.id)
  if (!identity || identity.externalUserId !== callback.remoteUserId || callback.chatId !== callback.remoteUserId) {
    await answer('你不能处理这张转人工工单。', true)
    return true
  }
  const account = await db.account(binding.accountId)
  const handoff = await waitForChannelHandoff(db, parsed[1])
  if (!account || !handoff || !canActOn(account, handoff)) {
    await answer('这张工单已经结束，或你没有处理权限。', true)
    return true
  }
  const action = parsed[2]
  if (action === 'd' || action === 'i') {
    try {
      await telegramSendHandoffReplyPrompt(
        secret.token,
        callback.chatId,
        handoff.id,
        action === 'd' ? 'done' : 'instructions',
        callback.messageId,
      )
      await answer(action === 'd' ? '请回复新消息填写处理结论。' : '请回复新消息填写新的做法。')
    } catch (e) {
      console.warn(`satuwork-gateway: Telegram 转人工输入提示发送失败：${(e as Error).message}`)
      await answer('输入提示发送失败，请重试。', true)
    }
    return true
  }
  const actor = { accountId: account.id, name: account.name || account.email }
  const result = await callSeat(db, handoff, action === 'c' ? 'claim' : 'cancel', { actor })
  if (result.status !== 200) {
    await answer(String(result.json.error || '处理失败，请重试。'), true)
    return true
  }
  await syncChannelHandoff(db, handoff, result.json.handoff as SeatHandoffSnapshot | undefined)
  if (action === 'c') await answer('已由你接手。处理后可继续点“处理完了”交回 Bot。')
  else {
    await answer('已关闭这张转人工工单。')
    await telegramClearApprovalButtons(secret.token, callback.chatId, callback.messageId).catch(() => undefined)
  }
  return true
}

async function processTelegramHandoffReply(
  db: Db,
  key: Buffer,
  binding: NonNullable<Awaited<ReturnType<Db['channelBinding']>>>,
  message: NonNullable<ReturnType<typeof normalizeTelegramUpdate>>,
): Promise<boolean> {
  const parsed = HANDOFF_REPLY.exec(message.replyToText || '')
  if (!parsed) return false
  const secret = decryptChannelSecret<StoredSecret>(key, binding.credentialCiphertext)
  const account = await db.account(binding.accountId)
  const handoff = await waitForChannelHandoff(db, parsed[1])
  if (!account || !handoff || !canActOn(account, handoff)) {
    await telegramSendText(secret.token, message.chatId, '这张转人工工单已经结束，或你没有处理权限。')
    return true
  }
  const actor = { accountId: account.id, name: account.name || account.email }
  const result = await callSeat(db, handoff, 'return', {
    disposition: parsed[2], text: message.text, actor,
  })
  if (result.status !== 200) {
    await telegramSendText(secret.token, message.chatId, `交还失败：${String(result.json.error || '请回复同一条提示重试。')}`)
    return true
  }
  await syncChannelHandoff(db, handoff, result.json.handoff as SeatHandoffSnapshot | undefined)
  await telegramClearApprovalButtons(secret.token, message.chatId, Number(parsed[3])).catch(() => undefined)
  await telegramSendText(
    secret.token,
    message.chatId,
    parsed[2] === 'done'
      ? '已把处理结论交还给 Bot，它会从这里继续。'
      : '已把新的做法交还给 Bot，它会按你的指示继续。',
  )
  return true
}

async function processTelegramApprovalCallback(
  db: Db,
  key: Buffer,
  binding: NonNullable<Awaited<ReturnType<Db['channelBinding']>>>,
  raw: unknown,
): Promise<boolean> {
  const callback = normalizeTelegramCallback(raw)
  if (!callback) return false
  const secret = decryptChannelSecret<StoredSecret>(key, binding.credentialCiphertext)
  /**
   * callback_query 是一次性、短时效的确认。审批本身已经有结果之后，给 Telegram 回提示
   * 只是 UI 收尾，失败绝不能让同一个 update 永远卡住 getUpdates offset。
   */
  const answer = async (text: string, showAlert = false) => {
    try {
      await telegramAnswerCallbackQuery(secret.token, callback.queryId, text, showAlert)
    } catch (e) {
      const error = e as Error
      console.warn(`satuwork-gateway: Telegram 回调 ${callback.queryId} 已无法应答，继续确认该 update：${error.message}`)
    }
  }
  const parsed = APPROVAL_CALLBACK.exec(callback.data)
  const identity = await db.channelIdentity(binding.id)
  if (!parsed || !identity || identity.externalUserId !== callback.remoteUserId || callback.chatId !== callback.remoteUserId) {
    await answer('你不能处理这条审批。', true)
    return true
  }
  const action = parsed[2]
  const decision = action.startsWith('a') ? 'approve' : 'deny'
  const scope = action.endsWith('t') ? 'turn' : 'once'
  let result: 'ok' | 'gone'
  try {
    result = await decideSeatApproval(db, binding, parsed[1], decision, scope)
  } catch (e) {
    console.warn(`satuwork-gateway: Telegram 审批失败：${(e as Error).message}`)
    await answer('审批失败，请重试。', true)
    return true
  }
  const message = result === 'gone'
    ? '这条审批已经结束。'
    : decision === 'approve' ? (scope === 'turn' ? '已批准这一轮。' : '已批准这一次。')
      : (scope === 'turn' ? '这一轮已拒绝同类操作。' : '已拒绝这一次。')
  await answer(message, result === 'gone')
  await telegramClearApprovalButtons(secret.token, callback.chatId, callback.messageId).catch(() => undefined)
  return true
}

export async function processTelegramUpdate(db: Db, key: Buffer, binding: NonNullable<Awaited<ReturnType<Db['channelBinding']>>>, raw: unknown): Promise<void> {
  const live = await db.channelBinding(binding.id)
  if (!live || live.status !== 'active') return
  if (await processTelegramHandoffCallback(db, key, live, raw)) return
  if (await processTelegramApprovalCallback(db, key, live, raw)) return
  const sharedChat = telegramJoinedSharedChat(raw)
  if (sharedChat) {
    // Telegram 没有 Bot API 可以全局关闭「被加群」；收到成员更新或群消息后立即退出。
    // 退出失败不能卡住 update 游标，否则后续合法私聊也会永远收不到。
    const secret = decryptChannelSecret<StoredSecret>(key, live.credentialCiphertext)
    try { await telegramLeaveChat(secret.token, sharedChat.chatId) }
    catch (e) { console.warn(`satuwork-gateway: Telegram 私人 Bot 退出 ${sharedChat.chatType} ${sharedChat.chatId} 失败：${(e as Error).message}`) }
    return
  }
  const message = normalizeTelegramUpdate(raw, live)
  if (!message) return
  const identity = await db.channelIdentity(binding.id)
  if (!identity) {
    // 配对只在私聊里受理，避免有人在群里把一次性口令公开贴出来。
    const matches = live.pairingCodeHash
      && timingSafeToken(pairingCodeHash(message.text), live.pairingCodeHash)
    if (message.chatType !== 'private' || !matches) {
      if (message.chatType === 'private') {
        const secret = decryptChannelSecret<StoredSecret>(key, live.credentialCiphertext)
        await telegramSendText(secret.token, message.chatId, '此 Bot 尚未配对。请在 Satuwork「渠道」页面复制配对码并发送到这里。')
      }
      return
    }
    const pairedToken = await db.tx(async () => {
      // 长轮询租约保证正常情况下只有一个消费者；事务内再读一次，挡住租约接管的极小窗口。
      await db.lockChannelBinding(binding.id)
      if (await db.channelIdentity(binding.id)) return ''
      const fresh = await db.channelBinding(binding.id)
      if (fresh?.status !== 'active' || !fresh.pairingCodeHash || !timingSafeToken(pairingCodeHash(message.text), fresh.pairingCodeHash)) return ''
      const secret = decryptChannelSecret<StoredSecret>(key, fresh.credentialCiphertext)
      await db.pairChannelIdentity({
        bindingId: binding.id, externalUserId: message.remoteUserId,
        externalUsername: String((raw as any)?.message?.from?.username || ''),
        externalDisplayName: message.remoteDisplayName, pairedEventId: message.externalEventId,
      })
      await db.updateChannelBinding(binding.id, {
        pairingCodeHash: '',
        credentialCiphertext: encryptChannelSecret(key, { ...secret, pairingCode: '' } satisfies StoredSecret),
        lastError: null,
      })
      return secret.token
    })
    if (pairedToken) await telegramSendText(pairedToken, message.chatId, '配对成功。现在可以直接给我发消息了。')
    return
  }
  // 同一个 bot 用户名可能被任何人搜到；只接受已配对 Telegram 身份发出的消息。
  if (identity.externalUserId !== message.remoteUserId) return
  // 配对成功回包之后进程崩溃时，Telegram 会重送那条口令。它不能进入模型。
  if (identity.pairedEventId === message.externalEventId) return
  // ForceReply 的正文里带工单 id 与处置方式。这是交接结果，不是普通用户消息；先在这里
  // 消费掉，避免它既唤醒交接单、又作为新问题再跑一轮模型。
  if (await processTelegramHandoffReply(db, key, live, message)) return
  const inserted = await db.tx(async () => {
    await db.lockChannelBinding(binding.id)
    const currentBinding = await db.channelBinding(binding.id)
    if (currentBinding?.status !== 'active') return null
    const stillPaired = await db.channelIdentityForUser(binding.id, message.remoteUserId)
    if (!stillPaired || stillPaired.pairedEventId === message.externalEventId) return null
    await db.touchChannelIdentity(stillPaired.id)
    return db.insertChannelEvent({
      bindingId: binding.id, externalEventId: message.externalEventId,
      externalConversationId: message.externalConversationId, remoteUserId: message.remoteUserId,
      remoteDisplayName: message.remoteDisplayName, title: message.title, text: message.text,
    })
  })
  if (!inserted) return
  await db.updateChannelBinding(binding.id, { lastReceivedAt: Date.now() })
  if (inserted.created) kickChannelDispatcher()
}

async function pollOne(db: Db, key: Buffer, candidate: Awaited<ReturnType<Db['channelBinding']>>): Promise<void> {
  if (!candidate) return
  const now = Date.now()
  if (!await db.claimChannelPoll(candidate.id, now, now + POLL_LEASE_MS)) return
  const binding = await db.channelBinding(candidate.id)
  if (!binding || binding.status !== 'active') return
  let nextOffset = binding.pollOffset
  try {
    const secret = decryptChannelSecret<StoredSecret>(key, binding.credentialCiphertext)
    /**
     * 收信方式和当前模式对不上就先对齐（见 channels/inbound.ts）。
     *
     * · 该走 webhook 而这条还在轮询：设上 webhook，**这一轮不再 getUpdates**（两者互斥，
     *   Telegram 会 409）。dueChannelPolls 从此不再选它——判据就是散列非空。
     * · 该走轮询而这条还挂着 webhook（模式关掉了）：删掉 webhook、清散列，接着照常轮询。
     */
    if (telegramWebhookMode() !== Boolean(binding.webhookSecretHash)) {
      const aligned = await ensureTelegramInbound(db, binding, secret.token)
      if (aligned.webhookSecretHash) {
        console.log(`satuwork-gateway: Telegram 渠道 ${binding.id} 已切到 webhook，不再长轮询`)
        await db.finishChannelPoll(binding.id, { pollLastError: null, nextPollAt: null })
        return
      }
    }
    if (!commandsConfigured.has(binding.id)) {
      try {
        await telegramSetMyCommands(secret.token)
        commandsConfigured.add(binding.id)
      } catch (e) {
        // 菜单只是发现入口，命令解析本身仍然可用；不能因为它暂时失败就停收消息。
        console.warn(`satuwork-gateway: Telegram 命令菜单注册失败：${(e as Error).message}`)
      }
    }
    const updates = await telegramGetUpdates(secret.token, binding.pollOffset, POLL_TIMEOUT_SECONDS)
    for (const raw of updates) {
      const updateId = rawUpdateId(raw)
      if (updateId == null || updateId < nextOffset) continue
      try {
        await processTelegramUpdate(db, key, binding, raw)
      } catch (e) {
        const tg = e instanceof TelegramError ? e : null
        if (!tg || tg.retryable) throw e
        /**
         * 一条 update 引发了不可重试的 Telegram 4xx。原样重放不会变好，反而会把它后面
         * 所有私聊永久堵死（过期 callback_query 就是线上这次事故）。跳过的是这一个
         * update，不是整个 binding；401/403 若真是 token 失效，下一次 getUpdates 会在
         * 外层被识别并把渠道标红。
         */
        console.warn(
          `satuwork-gateway: Telegram update ${updateId} 的 ${tg.method || 'API 调用'} 不可重试，` +
            `跳过毒消息继续收取后续 update：${tg.message}`,
        )
      }
      nextOffset = updateId + 1
      // 每条处理完就落游标：后面某条失败时，前面的不会跟着重放。
      await db.advanceChannelPollOffset(binding.id, nextOffset)
    }
    await db.finishChannelPoll(binding.id, { pollOffset: nextOffset, pollLastError: null })
  } catch (e) {
    const tg = e instanceof TelegramError ? e : null
    await db.finishChannelPoll(binding.id, {
      pollOffset: nextOffset, pollLastError: (e as Error).message.slice(0, 300),
      nextPollAt: tg?.permanent ? null : Date.now() + Math.min(5 * 60_000, Math.max(POLL_RETRY_MS, tg?.retryAfterMs ?? 0)),
      ...(tg?.permanent ? { status: 'error' as const, lastError: (e as Error).message.slice(0, 300) } : {}),
    })
  }
}

export function startChannelDispatcher(db: Db, key: Buffer, keys: JwtKeys): () => void {
  let scanning = false
  let stopped = false
  const activeEvents = new Set<string>()
  const tick = () => {
    if (scanning || stopped) return
    scanning = true
    const owned = new Map<string, boolean>()
    void db.dueChannelEvents(Date.now(), 10)
      .then(async (events) => {
        for (const event of events) {
          if (activeEvents.has(event.id)) continue
          // 归工人的机器上、还没跑出回复的事件不碰：工人会来领（routes/worker.ts）。
          if (!event.reply) {
            const binding = await db.channelBinding(event.bindingId)
            if (binding && (await workerOwnedBinding(db, binding, owned))) {
              await flagUnclaimed(db, binding, event)
              continue
            }
          }
          activeEvents.add(event.id)
          // 扫描只负责派活，不等最长二十分钟的模型轮次。一个慢会话不能挡住其它渠道
          // 或其它会话的新消息；同一远端会话的顺序仍由 dueChannelEvents 的前驱条件保证。
          void processOne(db, key, keys, event)
            .catch((e: Error) => console.error(`satuwork-gateway: 渠道事件 ${event.id} 处理失败：${e.message}`))
            .finally(() => activeEvents.delete(event.id))
        }
      })
      .catch((e: Error) => console.error(`satuwork-gateway: 渠道投递扫描失败：${e.message}`))
      .finally(() => { scanning = false })
  }
  wakeCurrent = tick
  const timer = setInterval(tick, TICK_MS)
  timer.unref?.()
  let polling = false
  const poll = () => {
    if (polling || stopped) return
    polling = true
    // webhook 模式下已经切过去的绑定不再轮询；模式关着时全都看一遍，把残留的 webhook 删掉。
    void db.dueChannelPolls(Date.now(), 10, !telegramWebhookMode())
      .then((bindings) => Promise.all(bindings.map((binding) => pollOne(db, key, binding))))
      .catch((e: Error) => console.error(`satuwork-gateway: Telegram 长轮询失败：${e.message}`))
      .finally(() => { polling = false })
  }
  const pollTimer = setInterval(poll, POLL_SCAN_MS)
  pollTimer.unref?.()
  tick()
  poll()
  return () => {
    stopped = true
    clearInterval(timer)
    clearInterval(pollTimer)
    if (wakeCurrent === tick) wakeCurrent = null
  }
}
