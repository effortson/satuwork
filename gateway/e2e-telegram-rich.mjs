import { createServer } from 'node:http'

const token = '123456789:telegram-rich-e2e'
const seen = []
let rejectRich = false
let rejectLinkOptions = false

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => { raw += chunk })
  req.on('end', () => {
    const method = new URL(req.url, 'http://telegram.test').pathname.replace(`/bot${token}/`, '')
    const body = JSON.parse(raw || '{}')
    seen.push({ method, body })
    res.setHeader('content-type', 'application/json')
    if ((method === 'sendRichMessage' || method === 'sendRichMessageDraft') && rejectRich) {
      res.statusCode = 404
      res.end(JSON.stringify({ ok: false, error_code: 404, description: 'Method not found' }))
      return
    }
    if (method === 'sendMessage' && body.link_preview_options && rejectLinkOptions) {
      res.statusCode = 400
      res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: unknown field link_preview_options' }))
      return
    }
    res.end(JSON.stringify({ ok: true, result: { message_id: seen.length } }))
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${address.port}`

try {
  const {
    normalizeTelegramCallback, startTelegramTyping, telegramAnswerCallbackQuery,
    telegramClearApprovalButtons, telegramRichTextParts, telegramSendApproval, telegramSendArtifactPreviews,
    telegramSendDraft, telegramSendHandoff, telegramSendHandoffReplyPrompt, telegramSendText,
    normalizeTelegramUpdate,
  } = await import('./src/channels/telegram.ts')
  const { createDraftPump } = await import('./src/channels/draft-pump.ts')
  const stopTyping = startTelegramTyping(token, '456', { intervalMs: 20 })
  await new Promise((resolve) => setTimeout(resolve, 75))
  stopTyping()
  const typingAtStop = seen.filter((entry) => entry.method === 'sendChatAction')
  await new Promise((resolve) => setTimeout(resolve, 50))
  const typingAfterStop = seen.filter((entry) => entry.method === 'sendChatAction')
  seen.length = 0
  const markdown = [
    '# 周报',
    '',
    '- [x] **已完成**',
    '- [ ] 待处理',
    '',
    '| 指标 | 值 |',
    '| --- | ---: |',
    '| 速度 | 42 |',
    '',
    '> 原生 RichMessage 引用',
    '',
    '```ts',
    'const answer = 42',
    '```',
  ].join('\n')
  await telegramSendText(token, '456', markdown, '88')
  const native = seen[0]

  rejectRich = true
  await telegramSendText(token, '456', '**旧 API 降级**', '88')
  const fallback = seen.slice(1)

  rejectRich = false
  seen.length = 0
  await telegramSendDraft(token, '456', 31415, '## 正在生成\n\n第一段', '88')
  const nativeDraft = seen[0]

  rejectRich = true
  await telegramSendDraft(token, '456', 31415, '**旧 API 草稿**', '88')
  const secondDraft = seen.slice(1)

  let activeDraftSends = 0
  let maxActiveDraftSends = 0
  const pumpedDrafts = []
  const pump = createDraftPump(async (text) => {
    activeDraftSends += 1
    maxActiveDraftSends = Math.max(maxActiveDraftSends, activeDraftSends)
    await new Promise((resolve) => setTimeout(resolve, 45))
    pumpedDrafts.push(text)
    activeDraftSends -= 1
  }, {
    minMs: 15,
    batchChars: 4,
    maxWaitMs: 35,
    initialWaitMs: 20,
    keepaliveMs: 1000,
  })
  const enqueueStarted = performance.now()
  pump.enqueue('一')
  pump.enqueue('一二三四')
  const enqueueElapsedMs = performance.now() - enqueueStarted
  await new Promise((resolve) => setTimeout(resolve, 8))
  pump.enqueue('一二三四五')
  pump.enqueue('一二三四五六七八')
  pump.enqueue('一二三四五六七八九十')
  await new Promise((resolve) => setTimeout(resolve, 140))
  await pump.finish()
  pump.enqueue('结束后不能再发')
  await new Promise((resolve) => setTimeout(resolve, 30))

  // 只往后长：中间被改过的帧不发（老版本 bot 会给这种），草稿停在上一帧；接着长的照发。
  const appendOnlyDrafts = []
  const appendPump = createDraftPump(async (text) => { appendOnlyDrafts.push(text) }, {
    minMs: 0, batchChars: 1, maxWaitMs: 0, initialWaitMs: 0, keepaliveMs: 1000,
  })
  const tick = () => new Promise((resolve) => setTimeout(resolve, 15))
  appendPump.enqueue('第一段')
  await tick()
  appendPump.enqueue('第一段\n\n🔧 工具调用\n⏳ web_search · 调用中')
  await tick()
  appendPump.enqueue('第一段\n\n第二段\n\n🔧 工具调用\n✓ web_search · 完成')
  await tick()
  appendPump.enqueue('第一段\n\n🔧 工具调用\n⏳ web_search · 调用中\n\n第二段')
  await tick()
  await appendPump.finish()

  // 超长草稿停在开头，不往后滑：连着两帧发出去的是同一段开头。
  rejectRich = false
  seen.length = 0
  const longBase = '长'.repeat(4200)
  await telegramSendDraft(token, '456', 27, longBase, '88')
  await telegramSendDraft(token, '456', 27, longBase + '再长一点', '88')
  const longDrafts = seen.filter((entry) => entry.method === 'sendMessageDraft').map((entry) => entry.body.text)

  rejectRich = false
  seen.length = 0
  const approvalKey = 'AbCdEfGhIjKlMnOpQrStUv'
  const approvalMessageId = await telegramSendApproval(token, '456', '## 需要批准\n\n请确认。', approvalKey)
  const approval = seen[0]
  await telegramAnswerCallbackQuery(token, 'query-1', '已批准这一次。')
  await telegramClearApprovalButtons(token, '456', approvalMessageId)
  const answer = seen[1]
  const cleared = seen[2]
  const callback = normalizeTelegramCallback({
    update_id: 99,
    callback_query: {
      id: 'query-1', data: `swa:${approvalKey}:a1`, from: { id: 456 },
      message: { message_id: approvalMessageId, chat: { id: 456, type: 'private' } },
    },
  })
  const callbackData = approval?.body?.reply_markup?.inline_keyboard
    ?.flatMap((row) => row.map((button) => button.callback_data)) || []

  seen.length = 0
  const handoffId = '12345678-1234-4234-8234-123456789abc'
  const handoffMessageId = await telegramSendHandoff(token, '456', '## 转人工\n\n请人工处理。', handoffId)
  const handoff = seen[0]
  const handoffButtons = handoff?.body?.reply_markup?.inline_keyboard
    ?.flatMap((row) => row.map((button) => button.callback_data)) || []
  await telegramSendHandoffReplyPrompt(token, '456', handoffId, 'done', handoffMessageId)
  const handoffPrompt = seen[1]
  const handoffReply = normalizeTelegramUpdate({
    update_id: 100,
    message: {
      message_id: 77,
      from: { id: 456, first_name: 'V' },
      chat: { id: 456, type: 'private' },
      text: '已经处理，结果正常。',
      reply_to_message: { message_id: 2, text: handoffPrompt.body.text },
    },
  }, {})

  seen.length = 0
  const longApprovalTail = '——长邮件正文结尾——'
  const longApproval = `## 需要批准\n\n### 正文\n\n> ${'完整正文 '.repeat(7_000)}\n>\n> ${longApprovalTail}\n\n请选择审批范围。`
  const longApprovalMessageId = await telegramSendApproval(token, '456', longApproval, approvalKey)
  const longApprovalMessages = [...seen]

  rejectRich = true
  seen.length = 0
  const fallbackApprovalTail = '——旧接口完整正文结尾——'
  const fallbackApproval = `## 需要批准\n\n### 正文\n\n${'旧接口正文 '.repeat(2_000)}\n\n${fallbackApprovalTail}`
  const fallbackApprovalMessageId = await telegramSendApproval(token, '456', fallbackApproval, approvalKey)
  const fallbackApprovalMessages = seen.filter((entry) => entry.method === 'sendMessage')
  const fallbackApprovalMessageIdIsLast = fallbackApprovalMessageId === seen.length
  rejectRich = false

  seen.length = 0
  await telegramSendArtifactPreviews(token, '456', [
    { name: 'ETH <报告>.html', url: 'https://example.test/channel-artifacts/ticket/eth.html' },
  ], '88')
  const artifactPreview = seen[0]

  rejectLinkOptions = true
  seen.length = 0
  await telegramSendArtifactPreviews(token, '456', [
    { name: '兼容预览.html', url: 'https://example.test/channel-artifacts/ticket/legacy.html' },
  ])
  const artifactFallback = [...seen]
  rejectLinkOptions = false

  const huge = `\`\`\`txt\n${'x'.repeat(31_000)}\n\`\`\``
  const parts = telegramRichTextParts(huge)
  console.log('__RESULT__' + JSON.stringify({
    appendOnlyDrafts,
    longDrafts,
    nativeMethod: native?.method,
    nativeMarkdown: native?.body?.rich_message?.markdown,
    nativeThread: native?.body?.message_thread_id,
    fallbackMethods: fallback.map((entry) => entry.method),
    fallbackText: fallback.at(-1)?.body?.text,
    nativeDraftMethod: nativeDraft?.method,
    nativeDraftId: nativeDraft?.body?.draft_id,
    nativeDraftText: nativeDraft?.body?.text,
    nativeDraftThread: nativeDraft?.body?.message_thread_id,
    secondDraftMethods: secondDraft.map((entry) => entry.method),
    secondDraftText: secondDraft.at(-1)?.body?.text,
    pumpedDrafts,
    maxActiveDraftSends,
    enqueueElapsedMs,
    typingCount: typingAtStop.length,
    typingStopped: typingAfterStop.length === typingAtStop.length,
    typingValid: typingAtStop.every((entry) => entry.body?.chat_id === '456' && entry.body?.action === 'typing'),
    approvalMethod: approval?.method,
    approvalButtons: callbackData,
    approvalButtonsFit: callbackData.every((data) => Buffer.byteLength(data, 'utf8') <= 64),
    handoffMethod: handoff?.method,
    handoffButtons,
    handoffButtonsFit: handoffButtons.every((data) => Buffer.byteLength(data, 'utf8') <= 64),
    handoffPromptMethod: handoffPrompt?.method,
    handoffForceReply: handoffPrompt?.body?.reply_markup?.force_reply,
    handoffPromptMarker: handoffPrompt?.body?.text,
    handoffReplyToText: handoffReply?.replyToText,
    handoffReplyText: handoffReply?.text,
    longApprovalParts: longApprovalMessages.length,
    longApprovalComplete: longApprovalMessages.some((entry) => entry.body?.rich_message?.markdown?.includes(longApprovalTail)),
    longApprovalQuoted: longApprovalMessages.filter((entry) => entry.method === 'sendRichMessage')
      .every((entry) => String(entry.body?.rich_message?.markdown || '').split('\n').filter((line) => line.includes('完整正文')).every((line) => line.startsWith('> '))),
    longApprovalButtonsOnlyLast: longApprovalMessages.slice(0, -1).every((entry) => !entry.body?.reply_markup)
      && Boolean(longApprovalMessages.at(-1)?.body?.reply_markup),
    longApprovalMessageIdIsLast: longApprovalMessageId === longApprovalMessages.length,
    fallbackApprovalParts: fallbackApprovalMessages.length,
    fallbackApprovalComplete: fallbackApprovalMessages.some((entry) => entry.body?.text?.includes(fallbackApprovalTail)),
    fallbackApprovalButtonsOnlyLast: fallbackApprovalMessages.slice(0, -1).every((entry) => !entry.body?.reply_markup)
      && Boolean(fallbackApprovalMessages.at(-1)?.body?.reply_markup),
    fallbackApprovalMessageIdIsLast,
    artifactMethod: artifactPreview?.method,
    artifactText: artifactPreview?.body?.text,
    artifactButton: artifactPreview?.body?.reply_markup?.inline_keyboard?.[0]?.[0],
    artifactLinkPreview: artifactPreview?.body?.link_preview_options,
    artifactThread: artifactPreview?.body?.message_thread_id,
    artifactFallbackMethods: artifactFallback.map((entry) => entry.method),
    artifactFallbackHasButton: Boolean(artifactFallback.at(-1)?.body?.reply_markup?.inline_keyboard?.[0]?.[0]?.url),
    callback,
    answerMethod: answer?.method,
    answerId: answer?.body?.callback_query_id,
    clearMethod: cleared?.method,
    clearKeyboard: cleared?.body?.reply_markup?.inline_keyboard,
    hugeParts: parts.length,
    hugePartsValid: parts.every((part) => part.startsWith('```txt\n') && part.endsWith('\n```') && Array.from(part).length <= 30_000),
  }))
} finally {
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}
