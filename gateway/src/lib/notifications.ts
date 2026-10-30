import type { Db } from '../db.ts'
import type { NotificationEvent } from '../db/notifications.ts'
import { liveRegistration, pushMessage, pushToAccount } from './push.ts'
import { afterResponse } from './background.ts'
import { runtimeKindOf } from './catalog.ts'

export const NOTIFICATION_GRACE_MS = 2000

/** 元数据先落库，快速唤醒只是优化。进程退出后，常驻扫描 / Cron 会续跑同一份队列。 */
export function wakeNotificationDispatcher(db: Db, accountId: string): void {
  afterResponse('统一通知调度', (async () => {
    await new Promise((resolve) => setTimeout(resolve, NOTIFICATION_GRACE_MS + 50))
    await dispatchNotifications(db, accountId)
  })())
}

export async function dispatchNotifications(db: Db, accountId?: string): Promise<number> {
  let sent = 0
  const deadline = Date.now() + 20_000
  for (const event of await db.dueNotifications(accountId)) {
    if (Date.now() >= deadline) break
    try { sent += await dispatchEvent(db, event, deadline) }
    catch (e) { console.warn(`satuwork-gateway: 通知 ${event.id} 投递失败：${(e as Error).message}`) }
  }
  return sent
}

async function dispatchEvent(db: Db, event: NotificationEvent, deadline: number): Promise<number> {
  const account = await db.account(event.accountId)
  if (!account || account.status !== 'active') return 0
  const bot = await db.catalog(event.botId)
  if (!bot || runtimeKindOf(bot) === 'local') return 0
  const msg = pushMessage(event.kind, bot.name, event.botId, account.locale, event.preview)
  Object.assign(msg.data, { notificationId: event.id, sessionId: event.sessionId, seq: String(event.seq) })
  let sent = 0
  const devices = (await db.pushDevicesOf(account.id)).filter((d) => d.updatedAt <= event.createdAt && liveRegistration(d.updatedAt, Number(account.tokenRevokedAt || 0), Date.now()))
  for (const device of devices) {
    if (Date.now() >= deadline) break
    const deviceId = 'push:' + device.token
    const leaseId = await db.claimNotification(account.id, event.id, deviceId, true)
    if (!leaseId) continue
    // 领取后、真正交给系统推送前再复查。交给 APNs/FCM 之后无法保证撤回。
    if (!(await db.notificationStillUnread(account.id, event.id))) {
      await db.finishNotificationDelivery(event.id, deviceId, leaseId, true, 'read')
      continue
    }
    const result = await pushToAccount(db, account.id, msg, Date.now(), device.token)
    await db.finishNotificationDelivery(event.id, deviceId, leaseId, result.failed === 0,
      result.failed ? 'failed' : result.dropped ? 'dropped' : result.sent ? 'sent' : 'skipped')
    sent += result.sent
  }
  return sent
}

export function startNotificationDispatcher(db: Db): () => void {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try { await dispatchNotifications(db) }
    catch (e) { console.warn(`satuwork-gateway: 通知队列扫描失败：${(e as Error).message}`) }
    finally { running = false }
  }
  const timer = setInterval(() => { void tick() }, 1000)
  timer.unref()
  void tick()
  return () => clearInterval(timer)
}
