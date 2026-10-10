/**
 * @satuwork/core 的出口。
 *
 * gateway/scripts/build-core.mjs 把这个文件打成 gateway/ui/core.js，这里 export 的每一个名字
 * 就是浏览器里 `SatuCore.<名字>`。Web 端的转接写在 state.js / prefs.js / data.js / chat.js /
 * i18n.js 里，一行一个。
 */
export { dict } from './i18n/dict.ts'
export { t, errText } from './i18n/t.ts'
export { esc, SATU_TZ, tzOffsetMs, tzDayStart, tzDayKey, fmtTime, dayStart, dayEnd, money, usd, fmtTokens } from './format.ts'
export type { Locale } from './format.ts'
export { connectorIdOfPath, botIdOfPath, companyIdOfPath, machineIdOfPath, userIdOfPath, sessionIdOfPath, auditItemIdOfPath } from './paths.ts'
export { createGatewayClient } from './api.ts'
export type { TokenStore, FetchLike, GatewayClientOptions, GatewayClient, LocalBot, LocalRoute, ApiError } from './api.ts'

// ── 对话事件层 ──
export { messageText, messageImages, messageMentions, messageRefs, UPLOAD_LEADS, splitUploads, isShot, maxSeqOf, insertEvent, cursorOf } from './chat/events.ts'
export { fold } from './chat/fold.ts'
export { newSum, settleDot, applyRosterEvent, refreshSum } from './chat/roster.ts'
export { mergePending } from './chat/pending.ts'
export { mergeChatPage } from './chat/pages.ts'
export { sseEvents } from './chat/sse.ts'
export { CHAT_RETRY_MAX, CHAT_ALIVE_MS, CHAT_IDLE_RETRY_MS, ROSTER_BACKOFF, chatRetryDelay, rosterRetryDelay, aliveLongEnough, classifyStreamStatus } from './chat/backoff.ts'
export { runEventStream } from './chat/stream.ts'
export type { StreamStatus, EventStreamOptions, EventStreamHandle } from './chat/stream.ts'
export type { SessionEvent, Message, MessageBlock, Mention, Ref, ToolCall, Block, UserBlock, AssistantBlock, MarkBlock, Folded, RosterSum, PendingMessage, ChatPage } from './protocol/events.ts'
