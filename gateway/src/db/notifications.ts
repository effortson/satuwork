import { createHash, randomUUID } from 'node:crypto'
import { DbCore } from './core.ts'
import type { Row } from './rows.ts'
import type { PushKind } from '../lib/push.ts'
import { JWT_TTL } from '../lib/validate.ts'

export interface NotificationEvent {
  id: string
  accountId: string
  botId: string
  sessionId: string
  seq: number
  kind: PushKind
  actionId: string
  createdAt: number
  dueAt: number
  expiresAt: number
}
export interface NotificationRead {
  botId: string
  sessionId: string
  lastReadSeq: number
  version: number
}
function eventRow(r: Row): NotificationEvent {
  return { id: String(r.id), accountId: String(r.accountId), botId: String(r.botId), sessionId: String(r.sessionId),
    seq: Number(r.seq), kind: r.kind as PushKind, actionId: String(r.actionId), createdAt: Number(r.createdAt),
    dueAt: Number(r.dueAt), expiresAt: Number(r.expiresAt) }
}
function readRow(r: Row): NotificationRead {
  return { botId: String(r.botId), sessionId: String(r.sessionId), lastReadSeq: Number(r.lastReadSeq), version: Number(r.version) }
}
const UNREAD = `e."resolvedAt" is null and e.seq > coalesce(r."lastReadSeq", 0)`
const READ_JOIN = `left join notification_reads r on r."accountId" = e."accountId" and r."botId" = e."botId" and r."sessionId" = e."sessionId"`
const REMOTE_BOT = `not exists (select 1 from catalog_items b where b.id = e."botId"
  and b.scope = 'user' and b.definition->>'runtimeKind' = 'local')`

export class NotificationsDb extends DbCore {
  /** 阅读与投递领取使用同一账号锁：已经提交的已读一定挡住后来的投递。 */
  async markNotificationRead(accountId: string, botId: string, sessionId: string, seq: number, now = Date.now()): Promise<NotificationRead> {
    return this.tx(async () => {
      await this.xactLock('markNotificationRead', 'notifications:' + accountId)
      const r = await this.one(`insert into notification_reads ("accountId", "botId", "sessionId", "lastReadSeq", "updatedAt")
        values (?, ?, ?, ?, ?) on conflict ("accountId", "botId", "sessionId") do update set
        "lastReadSeq" = greatest(notification_reads."lastReadSeq", excluded."lastReadSeq"),
        version = notification_reads.version + case when excluded."lastReadSeq" > notification_reads."lastReadSeq" then 1 else 0 end,
        "updatedAt" = greatest(notification_reads."updatedAt", excluded."updatedAt") returning *`, [accountId, botId, sessionId, seq, now])
      return readRow(r!)
    })
  }

  async recordNotification(input: {
    accountId: string; botId: string; sessionId: string; seq: number; kind: PushKind
    actionId: string; occurredAt: number; resolvedAt?: number
  }, graceMs = 2000): Promise<NotificationEvent> {
    const id = createHash('sha256').update(JSON.stringify([input.accountId, input.botId, input.sessionId, input.seq, input.kind])).digest('hex')
    // 缓冲与设备登记比较使用 Gateway 时钟；原事件时间只限制旧提醒的补发寿命。
    const now = Date.now()
    return this.tx(async () => {
      await this.xactLock('recordNotification', 'notifications:' + input.accountId)
      let resolvedAt = input.resolvedAt ?? null
      if (input.actionId) {
        if (resolvedAt !== null) {
          await this.run(`update notification_events set "resolvedAt" = coalesce("resolvedAt", ?)
            where "accountId" = ? and "botId" = ? and "sessionId" = ? and kind = ? and "actionId" = ?`,
          [resolvedAt, input.accountId, input.botId, input.sessionId, input.kind, input.actionId])
        } else {
          // 本地端重连时可能只见到终态。保留按业务 ID 的终态，晚到的 pending 不得复活。
          const terminal = await this.one(`select "resolvedAt" from notification_events
            where "accountId" = ? and "botId" = ? and "sessionId" = ? and kind = ? and "actionId" = ? and "resolvedAt" is not null limit 1`,
          [input.accountId, input.botId, input.sessionId, input.kind, input.actionId])
          if (terminal) resolvedAt = Number(terminal.resolvedAt)
        }
      }
      const r = await this.one(`insert into notification_events
        (id, "accountId", "botId", "sessionId", seq, kind, "actionId", "createdAt", "dueAt", "expiresAt", "resolvedAt")
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (id) do update set
        "resolvedAt" = coalesce(notification_events."resolvedAt", excluded."resolvedAt") returning *`,
      [id, input.accountId, input.botId, input.sessionId, input.seq, input.kind, input.actionId, now,
        now + graceMs, Math.min(now, input.occurredAt) + 3600_000, resolvedAt])
      return eventRow(r!)
    })
  }

  /** 同一个快照内的计数、游标、事件必须一致，防止读回旧计数又点亮角标。 */
  async notificationSnapshot(accountId: string, includeLocal = true) {
    return this.tx(async () => {
      await this.xactLock('notificationSnapshot', 'notifications:' + accountId)
      const scope = includeLocal ? '' : `and ${REMOTE_BOT}`
      const reads = (await this.many(`select * from notification_reads where "accountId" = ?`, [accountId])).map(readRow)
      const counts = (await this.many(`select e."botId", count(*) as count from notification_events e ${READ_JOIN}
        where e."accountId" = ? and ${UNREAD} ${scope} group by e."botId"`, [accountId])).map((r) => ({ botId: String(r.botId), count: Number(r.count) }))
      const events = (await this.many(`select e.* from notification_events e ${READ_JOIN}
        where e."accountId" = ? and ${UNREAD} ${scope} and e."expiresAt" > ? order by e."createdAt" desc, e.id limit 200`, [accountId, Date.now()])).map(eventRow)
      const dismissedIds = (await this.many(`select e.id from notification_events e ${READ_JOIN}
        where e."accountId" = ? and (e."resolvedAt" is not null or e.seq <= coalesce(r."lastReadSeq", 0))
        order by e."createdAt" desc limit 1000`, [accountId])).map((r) => String(r.id))
      return { reads, counts, events, dismissedIds, serverTime: Date.now() }
    })
  }

  async dueNotifications(accountId?: string, now = Date.now()): Promise<NotificationEvent[]> {
    return (await this.many(`select e.* from notification_events e ${READ_JOIN} where ${UNREAD}
      and e."dueAt" <= ? and e."expiresAt" > ?
      and ${REMOTE_BOT}
      and exists (select 1 from push_devices p join accounts a on a.id = p."accountId"
        left join notification_deliveries d on d."eventId" = e.id and d."deviceId" = 'push:' || p.token
        where p."accountId" = e."accountId" and a.status = 'active'
        and p."updatedAt" > coalesce(a."tokenRevokedAt", 0) and p."updatedAt" > ?
        and p."updatedAt" <= e."createdAt"
        and (d."eventId" is null or (d."deliveredAt" is null and d."leaseUntil" <= ?)))
      ${accountId ? 'and e."accountId" = ?' : ''}
      order by e."dueAt" limit 100`, [now, now, now - JWT_TTL * 1000, now, ...(accountId ? [accountId] : [])])).map(eventRow)
  }

  /** 设备领取时再次核对已读。客户端一次领取即去重，手机失败可在租约后重试。 */
  async claimNotification(accountId: string, eventId: string, deviceId: string, retry: boolean, now = Date.now()): Promise<string | null> {
    return this.tx(async () => {
      await this.xactLock('claimNotification', 'notifications:' + accountId)
      const e = await this.one(`select e.id from notification_events e ${READ_JOIN} where e.id = ? and e."accountId" = ?
        and ${UNREAD} and e."dueAt" <= ? and e."expiresAt" > ?`, [eventId, accountId, now, now])
      if (!e) return null
      const leaseId = randomUUID()
      const r = await this.one(`insert into notification_deliveries ("eventId", "deviceId", "leaseId", "leaseUntil", "deliveredAt")
        values (?, ?, ?, ?, ?) on conflict ("eventId", "deviceId") do update set
        "leaseId" = excluded."leaseId", "leaseUntil" = excluded."leaseUntil", "deliveredAt" = excluded."deliveredAt"
        where notification_deliveries."deliveredAt" is null and notification_deliveries."leaseUntil" <= ? returning "leaseId"`,
      [eventId, deviceId, leaseId, now + 60_000, retry ? null : now, now])
      return r ? leaseId : null
    })
  }

  async hasNotificationConversation(accountId: string, botId: string, sessionId: string): Promise<boolean> {
    return !!(await this.one('select id from notification_events where "accountId" = ? and "botId" = ? and "sessionId" = ? limit 1', [accountId, botId, sessionId]))
  }

  async notificationStillUnread(accountId: string, id: string): Promise<boolean> {
    return !!(await this.one(`select e.id from notification_events e ${READ_JOIN} where e.id = ? and e."accountId" = ? and ${UNREAD}`, [id, accountId]))
  }

  async finishNotificationDelivery(eventId: string, deviceId: string, leaseId: string, delivered: boolean, outcome = delivered ? 'sent' : 'failed'): Promise<void> {
    // 失败也保留短暂退避，避免一个坏设备阻塞整个账号；旧工人不能覆盖新租约。
    await this.run(`update notification_deliveries set "deliveredAt" = ?, "leaseUntil" = ?, outcome = ?
      where "eventId" = ? and "deviceId" = ? and "leaseId" = ?`,
    [delivered ? Date.now() : null, Date.now() + 30_000, outcome, eventId, deviceId, leaseId])
  }
}
