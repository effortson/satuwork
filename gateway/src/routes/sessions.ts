/**
 * 公司密钥、会话索引与按需拉全文、审计流水。
 */
import type { RouteCtx } from './ctx.ts'
import { HttpError, json, type Router } from '../http.ts'
import { PULL_ERROR, pullSessionEvents } from '../lib/machines.ts'
import { companyMachineOf } from '../deploy.ts'
import { bodyOf, intField, strField } from '../lib/validate.ts'
import { isModelProvider, modelProviderCreds, publicCredential, publicSessionIndex, sessionCursorOf } from '../lib/org.ts'
import { isVendor } from '../connectors/index.ts'
import { rangeQuery, requireOrgUser } from '../lib/guards.ts'
import { seatBearer, seatMachineOf } from '../lib/runtime.ts'
import { sessionPageLimit } from '../db.ts'

export function attachSessions(router: Router, ctx: RouteCtx) {
  const { db, keys, llm } = ctx

  // ── 公司密钥。列表/详情只回 configured: true ────────────────────────
  //
  // 公司密钥是主机制（llm.ts 的 secret：公司 > 平台 > 环境变量），这一屏就是公司管理员
  // 配自己那几把的地方。清单里平台兜底的那几把也列出来（标 scope: 'platform'），让他
  // 知道没配的供应商是不是照样能用；但平台那把在这里只能看，改和删都只认公司自己的行。

  /**
   * 这一条路只收模型供应商的密钥，而且 provider 得是注册表里真有的。密钥是按 provider 名
   * 去索引的（envSecret 拼 `<PROVIDER>_API_KEY`），一条 `{"provider":"stripe"}` 存进去
   * 没人用得上，只会在清单里挂一个假供应商；连接器供应商（composio）另有自己的页面。
   */
  async function modelProviderOr400(provider: string): Promise<string> {
    const p = provider.trim()
    if (!p) throw new HttpError(400, 'provider 不能为空')
    if (isVendor(p) || !isModelProvider(p)) throw new HttpError(400, `${p} 不是模型供应商`)
    await llm.syncCustomProviders()
    if (!llm.models.getProviders().some((x) => x.id === p)) throw new HttpError(400, `平台没有 ${p} 这个供应商`)
    return p
  }

  router.get('/orgs/:id/credentials', async (req, res) => {
    await requireOrgUser(req, db, keys, req.params.id)
    const own = modelProviderCreds(await db.credentialsOf(req.params.id))
    const overridden = new Set(own.map((c) => c.provider))
    // 和平台那条同一个口径：只报模型供应商。连接器和搜索后端漏进来同样是假供应商。
    // 公司已经配了自己那把的供应商，平台那把对它不生效，就不再列一遍。
    const shared = modelProviderCreds(await db.platformCredentials()).filter((c) => !overridden.has(c.provider))
    json(res, 200, {
      credentials: [
        ...own.map((c) => publicCredential(c, 'company')),
        ...shared.map((c) => publicCredential(c, 'platform')),
      ],
    })
  })

  router.post('/orgs/:id/credentials', async (req, res) => {
    const account = await requireOrgUser(req, db, keys, req.params.id, true)
    const body = bodyOf(req)
    const provider = await modelProviderOr400(strField(body, 'provider'))
    const secret = strField(body, 'secret')
    const existed = !!(await db.credentialByProvider(req.params.id, provider))
    const row = await db.upsertCredential(req.params.id, provider, secret)
    await db.audit({ companyId: req.params.id, accountId: account.id, action: 'credential.set', detail: { provider } })
    json(res, existed ? 200 : 201, { credential: publicCredential(row, 'company') })
  })

  router.get('/orgs/:id/credentials/:provider', async (req, res) => {
    await requireOrgUser(req, db, keys, req.params.id)
    const provider = req.params.provider.startsWith('platform:') ? req.params.provider.slice('platform:'.length) : req.params.provider
    if (!isModelProvider(provider)) throw new HttpError(404, '密钥不存在')
    const own = await db.credentialByProvider(req.params.id, provider)
    if (own) {
      json(res, 200, { credential: publicCredential(own, 'company') })
      return
    }
    // 跟列表同一个口径：不是模型供应商的密钥（连接器、搜索后端）对公司管理员就不存在，
    // 列表里看不到的，按名字也不能捞出来。
    const shared = await db.platformCredential(provider)
    if (!shared) throw new HttpError(404, '密钥不存在')
    json(res, 200, { credential: publicCredential(shared, 'platform') })
  })

  router.put('/orgs/:id/credentials/:provider', async (req, res) => {
    const account = await requireOrgUser(req, db, keys, req.params.id, true)
    const provider = await modelProviderOr400(req.params.provider)
    const secret = strField(bodyOf(req), 'secret')
    const row = await db.upsertCredential(req.params.id, provider, secret)
    await db.audit({ companyId: req.params.id, accountId: account.id, action: 'credential.set', detail: { provider } })
    json(res, 200, { credential: publicCredential(row, 'company') })
  })

  router.delete('/orgs/:id/credentials/:provider', async (req, res) => {
    const account = await requireOrgUser(req, db, keys, req.params.id, true)
    const provider = req.params.provider
    // 只删公司自己的行。平台兜底的那把不归这家管，删了会让别的公司一起没密钥。
    if (!(await db.deleteCredentialByProvider(req.params.id, provider))) throw new HttpError(404, '这家公司没有配这个供应商的密钥')
    await db.audit({ companyId: req.params.id, accountId: account.id, action: 'credential.delete', detail: { provider } })
    json(res, 200, { deleted: true, provider })
  })

  // ── 会话索引 / 按需拉全文。Gateway 只存指针，正文留在机器上。────────

  router.get('/orgs/:id/sessions', async (req, res) => {
    await requireOrgUser(req, db, keys, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const accountId = (req.query.get('accountId') || '').trim()
    const botId = (req.query.get('botId') || '').trim()
    const range = rangeQuery(req)
    const limit = sessionPageLimit(intField({ limit: req.query.get('limit') ?? undefined }, 'limit'))
    const before = sessionCursorOf(req.query.get('cursor'))
    // 多取一条来判断后面还有没有。静默截断比没有上限还糟：调用方看到的是一份「看起来
    // 很完整」的列表，然后据此得出「这些会话不存在」的结论。
    const rows = await db.listSessionIndex(company.id, {
      accountId: accountId || undefined,
      botId: botId || undefined,
      from: range.from,
      to: range.to,
      limit: limit + 1,
      before,
    })
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page[page.length - 1]
    const nextCursor = hasMore && last ? `${last.updatedAt}:${last.sessionId}` : null
    // 名字一次性查齐，不要每行两次。
    const names = {
      accounts: new Map((await db.accountsOf(company.id)).map((a) => [a.id, a])),
      // 管理员看的是全公司的会话，所以这里要**不分主人**的那一份：员工自己建的 Bot
      // 也得能按 id 显示出名字，否则审计页上只剩一串 uuid。
      bots: new Map((await db.companyBots(company.id)).map((b) => [b.id, b])),
    }
    json(res, 200, {
      sessions: await Promise.all(page.map((row) => publicSessionIndex(db, row, names))),
      limit,
      hasMore,
      nextCursor,
    })
  })

  router.get('/orgs/:id/sessions/:sessionId', async (req, res) => {
    const account = await requireOrgUser(req, db, keys, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const row = await db.sessionIndex(req.params.sessionId)
    if (!row || row.companyId !== company.id) throw new HttpError(404, '会话不存在')
    const session = await publicSessionIndex(db, row)
    await db.audit({
      companyId: company.id,
      accountId: account.id,
      action: 'session.pull',
      detail: { sessionId: row.sessionId },
    })
    // host 和机器票必须来自**同一台**机器：`instances.host` 是按席位实际所在那台写的，
    // 票以前却按 `sessions.machineId` / 公司默认机器取——多机公司里这两台可能不是一台，
    // 拿 M1 的票敲 M2 只会得到一个 401。所以先按席位查机器，查不到才回落到老路。
    const seatMachine = row.botId ? await seatMachineOf(db, row.accountId, row.botId) : undefined
    const machineId = row.machineId || company.machineId
    const machine = seatMachine ?? (machineId ? await db.machine(machineId) : await companyMachineOf(db, company.id))
    const instance = row.botId ? await db.instance(row.accountId, row.botId) : undefined
    const host = (instance?.host || machine?.host || '').trim()
    if (!host) {
      json(res, 200, { session, events: null, pullError: PULL_ERROR })
      return
    }
    const pulled = await pullSessionEvents(host, row.sessionId, {
      seat: await seatBearer(db, row.accountId),
      machine: machine?.token || '',
    })
    if (!pulled.ok) {
      json(res, 200, { session, events: null, pullError: PULL_ERROR })
      return
    }
    json(res, 200, { session, events: pulled.events })
  })

  router.get('/orgs/:id/audit', async (req, res) => {
    await requireOrgUser(req, db, keys, req.params.id, true)
    json(res, 200, {
      events: (await db.auditsOf(req.params.id)).map((e) => ({
        id: e.id,
        accountId: e.accountId,
        action: e.action,
        detail: e.detail,
        createdAt: e.createdAt,
      })),
    })
  })

  // ── 自动对话审计。结构化派生物在 Gateway，原始对话仍按上面的路径去席位拉。────

  router.get('/orgs/:id/conversation-audit-settings', async (req, res) => {
    await requireOrgUser(req, db, keys, req.params.id, true)
    if (!await db.company(req.params.id)) throw new HttpError(404, '公司不存在')
    const settings = (await db.settings(req.params.id)).conversationAudit
    const platform = await db.platformSettings()
    json(res, 200, { settings, model: platform[settings.modelRole] })
  })

  router.patch('/orgs/:id/conversation-audit-settings', async (req, res) => {
    const account = await requireOrgUser(req, db, keys, req.params.id, true)
    if (!await db.company(req.params.id)) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    const role = String(body.modelRole ?? '')
    if (role !== 'daily' && role !== 'utility') throw new HttpError(400, 'modelRole 只能是 daily 或 utility')
    const platform = await db.platformSettings()
    if (!platform[role].provider || !platform[role].model) {
      throw new HttpError(400, `${role === 'daily' ? '任务' : 'Utility'} 模型还没配置`)
    }
    const cur = await db.settings(req.params.id)
    const from = cur.conversationAudit.modelRole
    cur.conversationAudit = { ...cur.conversationAudit, modelRole: role }
    const saved = (await db.putSettings(req.params.id, cur)).conversationAudit
    if (from !== role) {
      await db.audit({
        companyId: req.params.id,
        accountId: account.id,
        action: 'conversation_audit.model_role.update',
        detail: { from, to: role },
      })
    }
    json(res, 200, { settings: saved, model: platform[saved.modelRole] })
  })

  router.get('/orgs/:id/conversation-audits', async (req, res) => {
    const account = await requireOrgUser(req, db, keys, req.params.id, true)
    const range = rangeQuery(req)
    const rawOutcome = (req.query.get('outcome') || '').trim()
    const outcomes = new Set(['completed', 'partial', 'failed', 'blocked', 'answered', 'unknown'])
    if (rawOutcome && !outcomes.has(rawOutcome)) throw new HttpError(400, 'outcome 不合法')
    const filter = {
      accountId: (req.query.get('accountId') || '').trim() || undefined,
      botId: (req.query.get('botId') || '').trim() || undefined,
      from: range.from,
      to: range.to,
      outcome: rawOutcome ? rawOutcome as any : undefined,
      scoreLte: intField({ scoreLte: req.query.get('scoreLte') ?? undefined }, 'scoreLte'),
      limit: intField({ limit: req.query.get('limit') ?? undefined }, 'limit'),
    }
    const [items, filters] = await Promise.all([
      db.conversationAuditItems(req.params.id, filter),
      db.conversationAuditFilterOptions(req.params.id),
    ])
    await db.audit({
      companyId: req.params.id,
      accountId: account.id,
      action: 'conversation_audit.list',
      detail: { count: items.length },
    })
    json(res, 200, {
      filters,
      items: items.map((x) => ({
        id: x.id, batchId: x.batchId, accountId: x.accountId, botId: x.botId,
        accountName: x.accountNameSnapshot, botName: x.botNameSnapshot,
        taskSummary: x.taskSummary, outcome: x.outcome, modelScore: x.modelScore,
        scoreConfidence: x.scoreConfidence, startedAt: x.startedAt, endedAt: x.endedAt,
      })),
    })
  })

  router.get('/orgs/:id/conversation-audits/:itemId', async (req, res) => {
    const account = await requireOrgUser(req, db, keys, req.params.id, true)
    const item = await db.conversationAuditItem(req.params.itemId)
    if (!item || item.companyId !== req.params.id) throw new HttpError(404, '审计条目不存在')
    const batch = await db.conversationAuditBatch(item.batchId)
    await db.audit({
      companyId: req.params.id,
      accountId: account.id,
      action: 'conversation_audit.read',
      detail: { auditItemId: item.id },
    })
    json(res, 200, {
      item,
      batch: batch ? {
        id: batch.id, kind: batch.kind, windowStart: batch.windowStart, windowEnd: batch.windowEnd,
        modelRole: batch.modelRole, provider: batch.provider, model: batch.model,
        reasoningEffort: batch.reasoningEffort, promptVersion: batch.promptVersion,
      } : null,
    })
  })

  router.get('/orgs/:id/conversation-audit-coverage', async (req, res) => {
    await requireOrgUser(req, db, keys, req.params.id, true)
    const batches = await db.conversationAuditCoverageOfCompany(req.params.id)
    json(res, 200, {
      coverage: batches.map((b) => ({
        accountId: b.accountId, botId: b.botId, sessionId: b.sessionId, status: b.status,
        windowStart: b.windowStart, windowEnd: b.windowEnd, toSeq: b.toSeq,
        completedAt: b.completedAt, lastError: b.lastError,
      })),
    })
  })
}
