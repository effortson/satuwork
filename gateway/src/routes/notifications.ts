import type { RouteCtx } from './ctx.ts'
import { HttpError, json, type Router } from '../http.ts'
import { requireUser, viewerOf } from '../lib/guards.ts'
import { bodyOf, strField } from '../lib/validate.ts'
import { visibleBotOf } from '../lib/runtime.ts'
import { runtimeKindOf } from '../lib/catalog.ts'
import { PUSH_KINDS, type PushKind } from '../lib/push.ts'
import { wakeNotificationDispatcher } from '../lib/notifications.ts'

export function notificationPosition(body: Record<string, unknown>) {
  const botId = strField(body, 'botId')
  const sessionId = strField(body, 'sessionId')
  const seq = body.seq
  if (botId.length > 200 || sessionId.length > 200 || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= 0) {
    throw new HttpError(400, '通知的会话或序号无效')
  }
  return { botId, sessionId, seq }
}

export function attachNotifications(router: Router, { db, keys }: RouteCtx) {
  router.get('/me/notifications', async (req, res) => {
    const account = await requireUser(req, db, keys)
    json(res, 200, await db.notificationSnapshot(account.id, req.query.get('platform') !== 'mobile'))
  })

  router.put('/me/notifications/read', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const { botId, sessionId, seq } = notificationPosition(bodyOf(req))
    // 交接单可能来自另一个人的 Bot；只允许读自己收到通知的那条会话。
    if (!(await db.hasNotificationConversation(account.id, botId, sessionId))) await visibleBotOf(db, account, botId, viewerOf(req))
    const read = await db.markNotificationRead(account.id, botId, sessionId, seq)
    json(res, 200, { read })
  })

  router.post('/me/notifications/:id/claim', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const body = bodyOf(req)
    const deviceId = strField(body, 'deviceId')
    // 客户端不能冒充系统推送领取；同一浏览器的多个标签共用一个设备标识。
    if (!/^(web|desktop):[a-zA-Z0-9_-]{16,100}$/.test(deviceId)) throw new HttpError(400, '通知设备标识无效')
    const lease = await db.claimNotification(account.id, req.params.id, deviceId, false)
    json(res, 200, { claimed: !!lease })
  })

  /** 本地 Bot 没有席位凭证，由已登录的桌面壳上报同样的元数据。 */
  router.post('/me/notifications/local', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const body = bodyOf(req)
    const position = notificationPosition(body)
    const bot = await visibleBotOf(db, account, position.botId, viewerOf(req))
    if (runtimeKindOf(bot) !== 'local') throw new HttpError(400, '远程 Bot 由席位上报通知')
    const kind = strField(body, 'kind')
    if (!PUSH_KINDS.has(kind)) throw new HttpError(400, 'kind 不认识')
    const event = await db.recordNotification({ ...position, accountId: account.id, kind: kind as PushKind,
      preview: body.preview,
      actionId: strField(body, 'actionId', false).slice(0, 200), occurredAt: Math.min(Date.now(), typeof body.time === 'number' ? body.time : Date.now()),
      resolvedAt: body.resolved === true ? Date.now() : undefined })
    wakeNotificationDispatcher(db, account.id)
    json(res, 200, { id: event.id })
  })
}
