/**
 * 每条会话此刻连着几条事件流（web/index.ts 的 sse 开流时 +1、收尾时 -1）。
 *
 * 只给手机推送用（session/gateway.ts 的 reportPush）：有人连着这条会话的流、这一轮又刚开始不久，
 * 他多半就盯着屏幕，再往他手机上推一条「回复好了」是打扰。
 *
 * **连着 ≠ 在看**：浏览器切到后台不会断流（gateway/ui/chat.js 有意保持连接），所以光凭这个数
 * 不能断定有人在看——桌面上开着标签页走开了的人照样该收到推送。判断要和「这一轮多长」一起用，
 * 见 pushSuppressed。
 */
const open = new Map<string, number>()

export function watchOpen(sessionId: string): void {
  open.set(sessionId, (open.get(sessionId) || 0) + 1)
}

export function watchClose(sessionId: string): void {
  const n = (open.get(sessionId) || 0) - 1
  if (n > 0) open.set(sessionId, n)
  else open.delete(sessionId)
}

export function watched(sessionId: string): boolean {
  return (open.get(sessionId) || 0) > 0
}

/**
 * 一轮短于这个、而且有人连着流，就不推。人刚发完一句、半分钟内回来了，他还在屏幕前的可能性
 * 远大于走开了；跑了几分钟的那种轮次，人多半已经切去干别的，正是推送有用的时候。
 */
export const QUICK_TURN_MS = 30_000

/**
 * 这一条推送要不要省掉。`turnStartedAt` 是这一轮 turn/start 事件的时刻；不知道（进程中途起来、
 * 没看到 turn/start）就当长轮次，照推——宁可多推一条，也别让人等一件永远不来的通知。
 */
export function pushSuppressed(isWatched: boolean, turnStartedAt: number | undefined, now: number): boolean {
  return isWatched && turnStartedAt != null && now - turnStartedAt < QUICK_TURN_MS
}
