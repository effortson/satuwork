import type { ChannelBinding } from '../db.ts'

const BASE = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '')

export class TelegramError extends Error {
  constructor(
    message: string,
    public status = 502,
    public retryAfterMs = 0,
    /** 哪个 Bot API 方法失败。轮询器据此区分“token 坏了”和“某一条消息回不出去”。 */
    public method = '',
  ) {
    super(message)
  }
  /**
   * **token 本身坏了**，整个渠道要标红——只看 getUpdates / getMe 上的 401 / 403 / 404
   * （404 是 Telegram 对格式不对的 token 的答法）。
   *
   * 以前不分方法：sendMessage 上的 403（用户把 Bot 拉黑了）、404（chat 不存在）也算
   * 「永久」，一个用户点了 block，整个 binding 就永久 error、别的人也收不到回复。
   * 那种 4xx 只说明**这一条**发不出去，由 `retryable` 决定这条事件的去留。
   */
  get permanent(): boolean {
    if (this.method !== 'getUpdates' && this.method !== 'getMe') return false
    return this.status === 401 || this.status === 403 || this.status === 404
  }
  /** 同一请求原样再试有机会恢复；其余 4xx 是这条 update 自身的毒消息。 */
  get retryable(): boolean { return this.status === 429 || this.status >= 500 }
}

async function call<T>(token: string, method: string, body: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> {
  let r: Response
  try {
    r = await fetch(`${BASE}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new TelegramError('Telegram 暂时连接不上', 502, 0, method)
  }
  const data = await r.json().catch(() => null) as {
    ok?: boolean
    result?: T
    description?: string
    error_code?: number
    parameters?: { retry_after?: number }
  } | null
  if (!r.ok || !data?.ok) {
    const status = Number(data?.error_code) || r.status || 502
    throw new TelegramError(
      data?.description || `Telegram HTTP ${status}`,
      status,
      Math.max(0, Number(data?.parameters?.retry_after) || 0) * 1000,
      method,
    )
  }
  return data.result as T
}

export interface TelegramBotInfo {
  id: number
  is_bot: boolean
  first_name: string
  username?: string
}

export function telegramGetMe(token: string): Promise<TelegramBotInfo> {
  return call(token, 'getMe')
}

export function telegramDeleteWebhook(token: string, dropPending = false): Promise<boolean> {
  return call(token, 'deleteWebhook', { drop_pending_updates: dropPending })
}

/**
 * 让 Telegram 主动把 update 推到我们的地址上，不再长轮询。`secret` 会原样出现在每条推送的
 * `X-Telegram-Bot-Api-Secret-Token` 头里，收的那一头拿它认「真是 Telegram 发的」。
 * `allowed_updates` 和 getUpdates 那边保持一致——少一种就少收一类事件，而且不报错。
 */
export function telegramSetWebhook(token: string, url: string, secret: string): Promise<boolean> {
  return call(token, 'setWebhook', {
    url,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query', 'my_chat_member'],
    drop_pending_updates: false,
  })
}

/** 让 Telegram 客户端在 `/` 菜单里直接展示渠道支持的控制命令。 */
export function telegramSetMyCommands(token: string): Promise<boolean> {
  return call(token, 'setMyCommands', {
    commands: [
      { command: 'new', description: '开始新对话（保留记录，不带旧上下文）' },
      { command: 'tasks', description: '查看当前任务列表' },
      { command: 'mentions', description: '查看可用的 @ 连接' },
    ],
    scope: { type: 'all_private_chats' },
  })
}

export function telegramSendTyping(token: string, chatId: string): Promise<boolean> {
  return call(token, 'sendChatAction', { chat_id: chatId, action: 'typing' }, 8_000)
}

/**
 * Telegram 的 chat action 最多显示 5 秒。模型与工具调用可能持续更久，所以处理期间
 * 每 4 秒续一次；同一时刻只允许一个请求在飞，网络慢时不会叠出一串请求。
 */
export function startTelegramTyping(
  token: string,
  chatId: string,
  options: { intervalMs?: number; onError?: (error: Error) => void } = {},
): () => void {
  const intervalMs = Math.max(10, Math.trunc(options.intervalMs ?? 4000))
  let stopped = false
  let sending = false
  const pulse = async () => {
    if (stopped || sending) return
    sending = true
    try {
      await telegramSendTyping(token, chatId)
    } catch (e) {
      options.onError?.(e as Error)
    } finally {
      sending = false
    }
  }
  void pulse()
  const timer = setInterval(() => { void pulse() }, intervalMs)
  timer.unref?.()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

export function telegramGetUpdates(token: string, offset: number, timeoutSeconds = 30): Promise<unknown[]> {
  const seconds = Math.min(50, Math.max(1, Math.trunc(timeoutSeconds)))
  return call<unknown[]>(token, 'getUpdates', {
    offset: Math.max(0, Math.trunc(offset)), timeout: seconds, allowed_updates: ['message', 'callback_query', 'my_chat_member'],
  }, (seconds + 10) * 1000)
}

export interface TelegramCallback {
  queryId: string
  data: string
  chatId: string
  messageId: number
  remoteUserId: string
}

export function normalizeTelegramCallback(raw: unknown): TelegramCallback | null {
  const u = raw && typeof raw === 'object' ? raw as Record<string, any> : null
  const q = u?.callback_query
  const chat = q?.message?.chat
  const queryId = String(q?.id ?? '').trim()
  const data = String(q?.data ?? '').trim()
  const chatId = String(chat?.id ?? '').trim()
  const remoteUserId = String(q?.from?.id ?? '').trim()
  const messageId = Number(q?.message?.message_id)
  if (!queryId || !data || !chatId || !remoteUserId || chat?.type !== 'private' || !Number.isSafeInteger(messageId)) return null
  return { queryId, data, chatId, messageId, remoteUserId }
}

function approvalKeyboard(approvalKey: string) {
  const data = (action: 'a1' | 'at' | 'd1' | 'dt') => `swa:${approvalKey}:${action}`
  return {
    inline_keyboard: [
      [
        { text: '批准', callback_data: data('a1') },
        { text: '这一轮都批准', callback_data: data('at') },
      ],
      [
        { text: '拒绝', callback_data: data('d1') },
        { text: '这一轮别再试', callback_data: data('dt') },
      ],
    ],
  }
}

function handoffKeyboard(handoffId: string) {
  const data = (action: 'c' | 'd' | 'i' | 'x') => `swh:${handoffId}:${action}`
  return {
    inline_keyboard: [
      [
        { text: '✅ 处理完了', callback_data: data('d') },
        { text: '🙋 我来接手', callback_data: data('c') },
      ],
      [
        { text: '🔄 换个做法', callback_data: data('i') },
        { text: '🛑 不用处理', callback_data: data('x') },
      ],
    ],
  }
}

/**
 * 发带内联按钮的 RichMessage 审批内容。长正文会完整拆成多条，按钮只挂在最后一条；
 * 这样回调保存的 message id 始终指向真正带按钮的那条。旧 Bot API 逐段降级为普通文本。
 */
export async function telegramSendApproval(token: string, chatId: string, markdown: string, approvalKey: string): Promise<number> {
  const reply_markup = approvalKeyboard(approvalKey)
  const richParts = telegramRichTextParts(markdown)
  let messageId = NaN
  for (let i = 0; i < richParts.length; i += 1) {
    const part = richParts[i]
    const lastRichPart = i === richParts.length - 1
    let sent: { message_id?: unknown } | undefined
    try {
      sent = await call(token, 'sendRichMessage', {
        chat_id: chatId,
        rich_message: { markdown: part },
        ...(lastRichPart ? { reply_markup } : {}),
      })
    } catch (error) {
      if (!canFallBackToPlain(error)) throw error
      const plainParts = telegramTextParts(part, 4000)
      for (let j = 0; j < plainParts.length; j += 1) {
        const lastPlainPart = j === plainParts.length - 1
        sent = await call(token, 'sendMessage', {
          chat_id: chatId,
          text: plainParts[j],
          ...(lastRichPart && lastPlainPart ? { reply_markup } : {}),
        })
      }
    }
    if (lastRichPart) messageId = Number(sent?.message_id)
  }
  if (!Number.isSafeInteger(messageId)) throw new TelegramError('Telegram 没有返回审批消息 id')
  return messageId
}

/** 发一张可直接处理的转人工卡；按钮数据只放 UUID，低于 Telegram 的 64-byte 上限。 */
export async function telegramSendHandoff(token: string, chatId: string, markdown: string, handoffId: string): Promise<number> {
  const reply_markup = handoffKeyboard(handoffId)
  const richParts = telegramRichTextParts(markdown)
  let messageId = NaN
  for (let i = 0; i < richParts.length; i += 1) {
    const part = richParts[i]
    const lastRichPart = i === richParts.length - 1
    let sent: { message_id?: unknown } | undefined
    try {
      sent = await call(token, 'sendRichMessage', {
        chat_id: chatId,
        rich_message: { markdown: part },
        ...(lastRichPart ? { reply_markup } : {}),
      })
    } catch (error) {
      if (!canFallBackToPlain(error)) throw error
      const plainParts = telegramTextParts(part, 4000)
      for (let j = 0; j < plainParts.length; j += 1) {
        const lastPlainPart = j === plainParts.length - 1
        sent = await call(token, 'sendMessage', {
          chat_id: chatId,
          text: plainParts[j],
          ...(lastRichPart && lastPlainPart ? { reply_markup } : {}),
        })
      }
    }
    if (lastRichPart) messageId = Number(sent?.message_id)
  }
  if (!Number.isSafeInteger(messageId)) throw new TelegramError('Telegram 没有返回转人工消息 id')
  return messageId
}

/**
 * “处理完了 / 换个做法”需要一段文字，使用 Telegram 原生 ForceReply 收集。
 * marker 跟在被回复消息里，因此 Gateway 重启后也能知道这段回复属于哪张单、哪种处置。
 */
export async function telegramSendHandoffReplyPrompt(
  token: string,
  chatId: string,
  handoffId: string,
  disposition: 'done' | 'instructions',
  cardMessageId: number,
): Promise<number> {
  const done = disposition === 'done'
  const marker = `[satuwork-handoff:${handoffId}:${disposition}:${cardMessageId}]`
  const sent = await call<{ message_id?: unknown }>(token, 'sendMessage', {
    chat_id: chatId,
    text: `${done ? '请回复这条消息，写明你做了什么和结论。' : '请回复这条消息，写明希望 Bot 改用什么做法。'}\n\n${marker}`,
    reply_markup: {
      force_reply: true,
      selective: true,
      input_field_placeholder: done ? '做了什么、结论是什么' : '新的做法或指示',
    },
  })
  const messageId = Number(sent?.message_id)
  if (!Number.isSafeInteger(messageId)) throw new TelegramError('Telegram 没有返回转人工回复提示 id')
  return messageId
}

export function telegramAnswerCallbackQuery(
  token: string,
  queryId: string,
  text: string,
  showAlert = false,
): Promise<boolean> {
  return call(token, 'answerCallbackQuery', {
    callback_query_id: queryId, text: text.slice(0, 200), show_alert: showAlert,
  }, 8_000)
}

export function telegramClearApprovalButtons(token: string, chatId: string, messageId: number): Promise<unknown> {
  return call(token, 'editMessageReplyMarkup', {
    chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] },
  }, 8_000)
}

/**
 * 私人 Bot 若被拉进群或频道，会收到 message 或 my_chat_member。返回该非私聊 chat，
 * 供轮询器立即 leaveChat；已经离开/被踢的成员更新不必重复调用。
 */
export function telegramJoinedSharedChat(raw: unknown): { chatId: string; chatType: string } | null {
  const u = raw && typeof raw === 'object' ? raw as Record<string, any> : null
  const member = u?.my_chat_member
  if (member && (member.new_chat_member?.status === 'left' || member.new_chat_member?.status === 'kicked')) return null
  const chat = member?.chat || u?.message?.chat
  const chatId = String(chat?.id ?? '').trim()
  const chatType = String(chat?.type ?? '').trim()
  if (!chatId || !chatType || chatType === 'private') return null
  return { chatId, chatType }
}

export function telegramLeaveChat(token: string, chatId: string): Promise<boolean> {
  return call(token, 'leaveChat', { chat_id: chatId })
}

export interface TelegramInbound {
  externalEventId: string
  externalConversationId: string
  chatId: string
  chatType: string
  remoteUserId: string
  remoteDisplayName: string
  title: string
  text: string
  replyToMessageId?: number
  replyToText?: string
}

export function normalizeTelegramUpdate(raw: unknown, binding: ChannelBinding): TelegramInbound | null {
  const u = raw && typeof raw === 'object' ? raw as Record<string, any> : null
  const m = u?.message
  if (!m || typeof m !== 'object' || m.from?.is_bot) return null
  const chat = m.chat
  // Satuwork 的 Telegram Bot 是用户私人渠道：群、超级群、频道和话题都不入库。
  if (!chat || chat.type !== 'private') return null
  const text = String(m.text ?? m.caption ?? '').trim()
  if (!text) return null
  const updateId = String(u?.update_id ?? '').trim()
  const chatId = String(chat.id ?? '').trim()
  if (!updateId || !chatId) return null
  const first = String(m.from?.first_name ?? '').trim()
  const last = String(m.from?.last_name ?? '').trim()
  const username = String(m.from?.username ?? '').trim()
  const display = [first, last].filter(Boolean).join(' ') || (username ? `@${username}` : String(m.from?.id ?? ''))
  const chatTitle = String(chat.title ?? '').trim() || display || `Telegram ${chatId}`
  return {
    externalEventId: updateId,
    externalConversationId: chatId,
    chatId,
    chatType: String(chat.type || ''),
    remoteUserId: String(m.from?.id ?? ''),
    remoteDisplayName: display,
    title: chatTitle,
    text,
    ...(Number.isSafeInteger(Number(m.reply_to_message?.message_id))
      ? { replyToMessageId: Number(m.reply_to_message.message_id) }
      : {}),
    ...(String(m.reply_to_message?.text ?? m.reply_to_message?.caption ?? '').trim()
      ? { replyToText: String(m.reply_to_message?.text ?? m.reply_to_message?.caption).trim() }
      : {}),
  }
}

const EMPTY_REPLY = '已处理，但没有可发送的文本回复。'

function textLength(text: string): number {
  return Array.from(text).length
}

/**
 * 按 Unicode code point 切文本，优先落在换行或空格上，不把代理对劈开。
 * sendMessage 的限额是 4096，这里默认留 96 字符余量。
 */
export function telegramTextParts(text: string, max = 4000): string[] {
  const source = String(text || '').trim() || EMPTY_REPLY
  const out: string[] = []
  let rest = Array.from(source)
  while (rest.length > max) {
    let end = max
    const floor = Math.floor(max * 0.6)
    for (let i = max; i >= floor; i -= 1) {
      if (rest[i - 1] === '\n') { end = i - 1; break }
      if (end === max && /\s/u.test(rest[i - 1] || '')) end = i - 1
    }
    if (end <= 0) end = max
    const part = rest.slice(0, end).join('').trimEnd()
    if (part) out.push(part)
    rest = rest.slice(end)
    while (rest[0] === '\n' || rest[0] === '\r') rest.shift()
  }
  const tail = rest.join('').trim()
  if (tail) out.push(tail)
  return out.length ? out : [EMPTY_REPLY]
}

function markdownBlocks(markdown: string): string[] {
  const lines = markdown.split('\n')
  const blocks: string[] = []
  let current: string[] = []
  let fence = ''
  const flush = () => {
    const block = current.join('\n').trim()
    if (block) blocks.push(block)
    current = []
  }
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1] || ''
    if (!fence && marker) fence = marker[0]
    else if (fence && marker[0] === fence) fence = ''
    if (!fence && !line.trim()) flush()
    else current.push(line)
  }
  flush()
  return blocks
}

function splitOversizedMarkdownBlock(block: string, max: number): string[] {
  const lines = block.split('\n')
  if (lines.every((line) => /^\s*>/.test(line))) {
    const plain = lines.map((line) => line.replace(/^\s*> ?/, '')).join('\n')
    return telegramTextParts(plain, Math.max(1, max - 2)).map((part) =>
      part.split('\n').map((line) => line ? `> ${line}` : '>').join('\n'))
  }
  const opening = /^\s*(`{3,}|~{3,})[^\n]*$/.exec(lines[0] || '')
  const marker = opening?.[1] || ''
  const closed = marker && new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(lines.at(-1) || '')
  if (!opening || !closed || lines.length < 3) return telegramTextParts(block, max)

  // 一个超大代码块也要每段都有完整 fence，否则后面整条 RichMessage 会解析失败。
  const open = lines[0]
  const close = lines.at(-1) || marker
  const room = Math.max(1, max - textLength(open) - textLength(close) - 2)
  return telegramTextParts(lines.slice(1, -1).join('\n'), room)
    .map((part) => `${open}\n${part}\n${close}`)
}

/**
 * RichMessage 支持最多 32768 个 UTF-8 字符。在 Markdown 块边界组包，
 * 让标题、表格、列表、引用与代码块尽量不被拆开。
 */
export function telegramRichTextParts(text: string, max = 30_000): string[] {
  const source = String(text || '').trim() || EMPTY_REPLY
  const blocks = markdownBlocks(source).flatMap((block) =>
    textLength(block) <= max ? [block] : splitOversizedMarkdownBlock(block, max))
  const out: string[] = []
  let current = ''
  for (const block of blocks) {
    const next = current ? `${current}\n\n${block}` : block
    if (current && textLength(next) > max) {
      out.push(current)
      current = block
    } else current = next
  }
  if (current) out.push(current)
  return out.length ? out : [EMPTY_REPLY]
}

function canFallBackToPlain(error: unknown): boolean {
  return error instanceof TelegramError && (error.status === 400 || error.status === 404)
}

function draftTail(text: string, max: number): string {
  const chars = Array.from(String(text || ''))
  if (chars.length <= max) return chars.join('')
  return `…\n${chars.slice(-(max - 2)).join('')}`
}

/**
 * Telegram 的 AI 草稿是临时预览，最终仍由 telegramSendText 固化。
 *
 * 流式阶段固定走纯文本 sendMessageDraft：模型吐出的半截 Markdown 经常还没有闭合，
 * 若每帧都先试 RichMessage 再降级，会把一次刷新放大成两次调用并触发 live-action 限流。
 * 最终消息仍由 telegramSendText 以 RichMessage 完整发送。
 */
export async function telegramSendDraft(
  token: string,
  chatId: string,
  draftId: number,
  markdown: string,
  threadId = '',
): Promise<void> {
  await call(token, 'sendMessageDraft', {
    chat_id: chatId,
    draft_id: draftId,
    text: draftTail(markdown, 4000),
    ...(threadId ? { message_thread_id: threadId } : {}),
  }, 3_000)
}

async function telegramSendPlain(token: string, chatId: string, text: string, threadId: string): Promise<void> {
  for (const part of telegramTextParts(text)) await call(token, 'sendMessage', {
    chat_id: chatId,
    text: part,
    ...(threadId ? { message_thread_id: threadId } : {}),
  })
}

export async function telegramSendText(token: string, chatId: string, text: string, threadId = ''): Promise<void> {
  for (const part of telegramRichTextParts(text)) {
    try {
      await call(token, 'sendRichMessage', {
        chat_id: chatId,
        rich_message: { markdown: part },
        ...(threadId ? { message_thread_id: threadId } : {}),
      })
    } catch (error) {
      // 兼容旧版 Bot API，也防止模型生成的半截 Markdown 让回复整体丢失。
      if (!canFallBackToPlain(error)) throw error
      await telegramSendPlain(token, chatId, part, threadId)
    }
  }
}

export interface TelegramArtifactPreview {
  name: string
  url: string
}

function telegramHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 给每个产出文件发一张标准 Bot API 链接卡。
 *
 * URL 同时放在正文链接和 inline button：Telegram 能抓到公开地址时会画网页预览；抓不
 * 到（例如 Gateway 只在局域网）时，桌面/手机仍能点按钮在自己的网络里打开。新版本的
 * link_preview_options 被旧 API 拒绝时只去掉提示字段重试，链接和按钮都保留。
 */
export async function telegramSendArtifactPreviews(
  token: string,
  chatId: string,
  artifacts: TelegramArtifactPreview[],
  threadId = '',
): Promise<void> {
  const unique = new Map<string, TelegramArtifactPreview>()
  for (const artifact of artifacts) {
    const name = String(artifact?.name || '').trim()
    const url = String(artifact?.url || '').trim()
    if (!name || !/^https?:\/\//i.test(url)) continue
    unique.set(url, { name: name.slice(0, 200), url })
    if (unique.size >= 8) break
  }
  for (const artifact of unique.values()) {
    const text = `📄 <a href="${telegramHtml(artifact.url)}">${telegramHtml(artifact.name)}</a>`
    const common = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: '打开预览', url: artifact.url }]] },
      ...(threadId ? { message_thread_id: threadId } : {}),
    }
    try {
      await call(token, 'sendMessage', {
        ...common,
        link_preview_options: {
          is_disabled: false,
          url: artifact.url,
          prefer_large_media: true,
          show_above_text: false,
        },
      })
    } catch (error) {
      if (!(error instanceof TelegramError) || error.status !== 400) throw error
      await call(token, 'sendMessage', common)
    }
  }
}
