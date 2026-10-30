import type { RouteCtx } from './ctx.ts'
import { HttpError, json, type Router } from '../http.ts'
import { requireOwnerUser, requireUser, viewerOf } from '../lib/guards.ts'
import { bodyOf, strField } from '../lib/validate.ts'
import { visibleBotOf } from '../lib/runtime.ts'

export const REPORT_REASONS = new Set(['sexual', 'violence', 'child_safety', 'hate', 'dangerous', 'other'])

export function contentReportInput(body: Record<string, unknown>) {
  const botId = strField(body, 'botId'), sessionId = strField(body, 'sessionId'), reason = strField(body, 'reason')
  const excerpt = strField(body, 'excerpt', false), note = strField(body, 'note', false), seq = body.seq
  if (botId.length > 200 || sessionId.length > 200 || !Number.isSafeInteger(seq) || Number(seq) <= 0
    || !REPORT_REASONS.has(reason) || excerpt.length > 2000 || note.length > 1000 || body.consent !== true) {
    throw new HttpError(400, '举报内容无效，或尚未确认发送所选内容')
  }
  return { botId, sessionId, seq: Number(seq), reason, excerpt, note }
}

export function attachContentReports(router: Router, { db, keys }: RouteCtx) {
  router.post('/me/content-reports', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const input = contentReportInput(bodyOf(req))
    const notified = await db.hasNotificationConversation(account.id, input.botId, input.sessionId)
    if (!notified) await visibleBotOf(db, account, input.botId, viewerOf(req))
    const session = await db.sessionIndex(input.sessionId)
    // A new/local conversation may not have reached the asynchronous session index yet.
    // No transcript is fetched: the excerpt is explicitly supplied, unverified report data.
    if (session && ((!notified && session.accountId !== account.id) || session.botId !== input.botId)) throw new HttpError(404, '会话不存在或不可见')
    const id = await db.insertContentReport(account.id, input)
    if (!id) throw new HttpError(429, '举报提交过于频繁，请稍后再试')
    json(res, 201, { id })
  })
  router.get('/platform/content-reports', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    const raw = req.query.get('before'), before = raw ? Number(raw) : Date.now() + 1
    if (!Number.isSafeInteger(before) || before <= 0) throw new HttpError(400, '游标无效')
    const beforeId = req.query.get('beforeId') || ''
    if (beforeId.length > 100) throw new HttpError(400, '游标无效')
    json(res, 200, { reports: await db.contentReports(before, beforeId) })
  })
  router.patch('/platform/content-reports/:id', async (req, res) => {
    const owner = await requireOwnerUser(req, db, keys)
    const note = strField(bodyOf(req), 'note')
    if (note.length > 1000) throw new HttpError(400, '审核说明过长')
    if (!(await db.reviewContentReport(req.params.id, note))) throw new HttpError(404, '举报不存在')
    // Review accountability without copying the reported conversation into general audit logs.
    await db.audit({ companyId: 'platform', accountId: owner.id, action: 'content_report.reviewed', detail: { reportId: req.params.id } })
    json(res, 200, { ok: true })
  })
}
