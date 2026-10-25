/**
 * 会话索引、自动对话审计、Bot 删除状态机。
 */
import { randomUUID } from 'node:crypto'
import { type BotDeletionRequest, type BotDeletionStatus, type ConversationAuditBatch, type ConversationAuditBatchKind, type ConversationAuditItem, type ConversationAuditModelRole, type ConversationAuditOutcome, parseReasoningEffort, SESSION_PAGE_DEFAULT, SESSION_PAGE_MAX, type SessionIndex } from './types.ts'
import { botDeletionRequestOf, conversationAuditBatchOf, conversationAuditItemOf, num, sessionIndexOf, str } from './rows.ts'
import { ChannelsDb } from './channels.ts'

/** Bot 删除请求失败后自动重试的上限。每次隔一分钟，试满就停在 failed 上，等管理员处理。 */
export const MAX_BOT_DELETION_ATTEMPTS = 20

export class SessionsDb extends ChannelsDb {
  // ── 会话索引。只存指针，不存 user/message 或 assistant/message 正文。──

  /**
   * 一行会话索引。**id 由席位给**，这边只 upsert——同 upsertHandoff。
   *
   * **更新那一支要认账号和公司。** `sessionId` 是上报方给的，可以是任何字符串，而一把
   * 席位票只代表一个账号；不带这两条判据的话，一台被拿下的席位报一个别人的 sessionId
   * 就能把那一行改到自己名下：原主人从此 `/runtime/sessions/:id/*` 一律 503
   * （seatTargetForSession 判的是 `idx.accountId !== account.id`），那条会话从他公司的
   * 列表里消失，审计上还记成了别人的。UUID 猜不出来不是理由——那是「难以利用」，
   * 不是「拦住了」（handoffs 那张表为同一件事写过同一段话）。
   *
   * 被判据挡下时**不返回库里那一行**：那是另一家公司的数据，原样回给上报方就是把
   * 刚拦住的东西从窗户递出去。直接抛，路由那边已经先回过一句 403 了，走到这里的只
   * 剩「两个请求撞在一起」这种极窄的竞态。
   */
  async upsertSessionIndex(input: {
    sessionId: string
    companyId: string
    accountId: string
    botId?: string | null
    machineId?: string | null
    origin?: string | null
    remoteId?: string | null
    messageCount?: number | null
    title?: string | null
    createdAt?: number | null
    updatedAt?: number | null
  }): Promise<SessionIndex> {
    const cur = await this.sessionIndex(input.sessionId)
    const now = Date.now()
    const row: SessionIndex = {
      sessionId: input.sessionId,
      companyId: input.companyId,
      accountId: input.accountId,
      botId: input.botId !== undefined ? input.botId : (cur?.botId ?? null),
      machineId: input.machineId !== undefined ? input.machineId : (cur?.machineId ?? null),
      origin: input.origin !== undefined ? input.origin : (cur?.origin ?? null),
      remoteId: input.remoteId !== undefined ? input.remoteId : (cur?.remoteId ?? null),
      messageCount: input.messageCount !== undefined ? input.messageCount : (cur?.messageCount ?? null),
      title: input.title !== undefined ? input.title : (cur?.title ?? null),
      createdAt: input.createdAt ?? cur?.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    }
    await this.run(
      `insert into session_index ("sessionId", "companyId", "accountId", "botId", "machineId", origin, "remoteId", "messageCount", title, "createdAt", "updatedAt")
       values (?,?,?,?,?,?,?,?,?,?,?)
       on conflict ("sessionId") do update set
         "companyId"=excluded."companyId",
         "accountId"=excluded."accountId",
         "botId"=excluded."botId",
         "machineId"=excluded."machineId",
         origin=excluded.origin,
         "remoteId"=excluded."remoteId",
         "messageCount"=excluded."messageCount",
         title=excluded.title,
         "createdAt"=excluded."createdAt",
         "updatedAt"=excluded."updatedAt"
       where session_index."accountId" = excluded."accountId"
         and session_index."companyId" = excluded."companyId"`,
      [
        row.sessionId,
        row.companyId,
        row.accountId,
        row.botId,
        row.machineId,
        row.origin,
        row.remoteId,
        row.messageCount,
        row.title,
        row.createdAt,
        row.updatedAt,
      ],
    )
    // 读回真正落下去的那一行：判据挡下时它还是原来的主人，那时候要抛，不能把它回出去。
    const saved = await this.sessionIndex(input.sessionId)
    if (!saved || saved.accountId !== input.accountId || saved.companyId !== input.companyId) {
      throw new Error(`会话 ${input.sessionId} 属于别的账号，拒绝改写`)
    }
    return saved
  }

  async sessionIndex(sessionId: string): Promise<SessionIndex | undefined> {
    const r = await this.one('select * from session_index where "sessionId" = ?', [sessionId])
    return r ? sessionIndexOf(r) : undefined
  }

  /**
   * 会话索引列表。**必须带上限**：这张表随聊天无限增长，没有 LIMIT 的话一家用了一年
   * 的公司点一次「会话」就把几十万行读进内存再序列化成 JSON 发出去。
   */
  async listSessionIndex(
    companyId: string,
    filter: {
      accountId?: string
      botId?: string
      from?: number
      to?: number
      limit?: number
      /** keyset 游标：只要**严格排在它后面**的行。来自上一页最后一行。 */
      before?: { updatedAt: number; sessionId: string }
    } = {},
  ): Promise<SessionIndex[]> {
    let sql = 'select * from session_index where "companyId" = ?'
    const args: (string | number)[] = [companyId]
    if (filter.accountId) {
      sql += ' and "accountId" = ?'
      args.push(filter.accountId)
    }
    if (filter.botId) {
      sql += ' and "botId" = ?'
      args.push(filter.botId)
    }
    if (filter.from != null) {
      sql += ' and "updatedAt" >= ?'
      args.push(filter.from)
    }
    if (filter.to != null) {
      sql += ' and "updatedAt" <= ?'
      args.push(filter.to)
    }
    if (filter.before) {
      // 用 keyset 而不是 OFFSET：两页之间有新会话上报时，OFFSET 会让行整体后移，
      // 翻页要么漏要么重。审计列表漏行是实质问题。
      sql += ' and ("updatedAt" < ? or ("updatedAt" = ? and "sessionId" < ?))'
      args.push(filter.before.updatedAt, filter.before.updatedAt, filter.before.sessionId)
    }
    // 上限放到 MAX+1：路由会多要一条用来判断 hasMore，卡在 MAX 的话最后一页永远
    // 报「没有更多」。真正对外的每页条数由 sessionPageLimit 决定。
    const limit = Math.min(Math.max(Math.trunc(filter.limit ?? SESSION_PAGE_DEFAULT), 1), SESSION_PAGE_MAX + 1)
    sql += ' order by "updatedAt" desc, "sessionId" desc limit ?'
    args.push(limit)
    const rows = await this.many(sql, args)
    return rows.map(sessionIndexOf)
  }

  // ── 自动对话审计 ────────────────────────────────────────────────────

  /** 每个 (账号, Bot) 只取最近一条主会话索引。 */
  async conversationAuditTargets(companyId?: string, botId?: string, includeDeleting = false): Promise<SessionIndex[]> {
    const where = ['s."botId" is not null', 'c.kind = \'bot\'']
    const args: unknown[] = []
    if (companyId) { where.push('s."companyId" = ?'); args.push(companyId) }
    if (botId) { where.push('s."botId" = ?'); args.push(botId) }
    if (!includeDeleting) where.push('c."deletingAt" is null')
    const rows = await this.many(
      `select distinct on (s."accountId", s."botId") s.*
       from session_index s join catalog_items c on c.id = s."botId"
       where ${where.join(' and ')}
       order by s."accountId", s."botId", s."updatedAt" desc, s."sessionId" desc`,
      args,
    )
    return rows.map(sessionIndexOf)
  }

  async insertConversationAuditBatch(input: {
    companyId: string
    accountId: string
    botId: string
    sessionId: string
    deletionRequestId?: string | null
    kind: ConversationAuditBatchKind
    windowStart: number
    windowEnd: number
    timezone: string
    fromSeq?: number
    modelRole: ConversationAuditModelRole
    provider: string
    model: string
    reasoningEffort?: string
    promptVersion?: number
  }): Promise<ConversationAuditBatch> {
    const now = Date.now()
    const id = randomUUID()
    const r = await this.one(
      `insert into conversation_audit_batches
       (id,"companyId","accountId","botId","sessionId","deletionRequestId",kind,"windowStart","windowEnd",timezone,
        "fromSeq","toSeq",status,attempts,"nextTryAt","modelRole",provider,model,"reasoningEffort","promptVersion",
        "redactionVersion","createdAt")
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       on conflict ("accountId","botId",kind,"windowStart","windowEnd") do nothing returning *`,
      [
        id, input.companyId, input.accountId, input.botId, input.sessionId, input.deletionRequestId ?? null,
        input.kind, input.windowStart, input.windowEnd, input.timezone, input.fromSeq ?? 0, 0, 'queued', 0, now,
        input.modelRole, input.provider, input.model, parseReasoningEffort(input.reasoningEffort), input.promptVersion ?? 1, 1, now,
      ],
    )
    if (r) return conversationAuditBatchOf(r)
    const existing = await this.one(
      `select * from conversation_audit_batches where "accountId"=? and "botId"=? and kind=?
       and "windowStart"=? and "windowEnd"=?`,
      [input.accountId, input.botId, input.kind, input.windowStart, input.windowEnd],
    )
    if (!existing) throw new Error('审计批次创建失败')
    return conversationAuditBatchOf(existing)
  }

  async conversationAuditBatch(id: string): Promise<ConversationAuditBatch | undefined> {
    const r = await this.one('select * from conversation_audit_batches where id = ?', [id])
    return r ? conversationAuditBatchOf(r) : undefined
  }

  async claimConversationAuditBatch(now: number, leaseMs: number): Promise<ConversationAuditBatch | undefined> {
    const r = await this.one(
      `update conversation_audit_batches set status='leased', attempts=attempts+1,
         "leaseUntil"=?, "startedAt"=coalesce("startedAt", ?), "lastError"=null
       where id = (
         select b.id from conversation_audit_batches b
         where ((b.status in ('queued','retry') and (b."nextTryAt" is null or b."nextTryAt" <= ?))
            or (b.status in ('leased','processing') and b."leaseUntil" < ?))
           -- 公司关了自动审计：还没跑完的定时批次原地停着，重新打开后接着跑。删除终审不受影响。
           and (b.kind <> 'scheduled' or exists (
             select 1 from settings s where s."companyId" = b."companyId"
             and s.payload->'conversationAudit'->>'enabled' = 'true'
           ))
         order by b."createdAt" asc for update of b skip locked limit 1
       ) returning *`,
      [now + leaseMs, now, now, now],
    )
    return r ? conversationAuditBatchOf(r) : undefined
  }

  /** 还在席位上跑、租约将在 `leaseEndsBefore` 之前到期的批次——续租用（见 conversation-audit.ts）。 */
  async processingConversationAuditBatches(leaseEndsBefore: number, limit = 20): Promise<ConversationAuditBatch[]> {
    const rows = await this.many(
      `select * from conversation_audit_batches b where b.status='processing' and b."leaseUntil" <= ?
         -- 和领活那条同一道闸：公司关了自动审计，定时批次不续租。续租就是把任务再发给席位，席位手上
         -- 没有就重跑一遍、调一次模型——关着审计还在花钱（本地一条批次就这样被拉着跑了六周多）。
         -- 租约到期后原地停着（领活那条也跳过它），重新打开后从那里接着审。删除终审不受影响。
         and (b.kind <> 'scheduled' or exists (
           select 1 from settings s where s."companyId" = b."companyId"
           and s.payload->'conversationAudit'->>'enabled' = 'true'
         ))
       order by b."leaseUntil" asc limit ?`,
      [leaseEndsBefore, Math.max(1, limit)],
    )
    return rows.map(conversationAuditBatchOf)
  }

  async markConversationAuditProcessing(id: string, leaseUntil: number): Promise<void> {
    await this.run(
      `update conversation_audit_batches set status='processing', "leaseUntil"=?
       where id=? and status in ('leased','processing')`,
      [leaseUntil, id],
    )
  }

  /**
   * 换掉批次上记的模型（派发前换成公司当前配的那个，见 conversation-audit.ts 的 withCurrentModel）。
   * 已经收口的不动：结果落了库，模型那几格是它当时真用的。
   */
  async updateConversationAuditBatchModel(
    id: string,
    m: { modelRole: string; provider: string; model: string; reasoningEffort?: string },
  ): Promise<ConversationAuditBatch | undefined> {
    const r = await this.one(
      `update conversation_audit_batches set "modelRole"=?, provider=?, model=?, "reasoningEffort"=?
       where id=? and status not in ('succeeded','empty','dead') returning *`,
      [m.modelRole, m.provider, m.model, parseReasoningEffort(m.reasoningEffort), id],
    )
    return r ? conversationAuditBatchOf(r) : undefined
  }

  /**
   * 转成重试（或 dead）。`expectStatus`：只有批次**还是**这个状态才改，改没改成回 true / false。
   * 席位报失败那条路是先读后写：读到 retry 之后、写之前，派发那一拍可能刚把它领成 leased 发了出去——
   * 不带条件的话这一笔把它改回 retry、租约清空，下一拍再领一次、同一批派两遍。
   */
  async retryConversationAuditBatch(id: string, error: string, nextTryAt: number, dead = false, expectStatus?: string): Promise<boolean> {
    const n = await this.run(
      `update conversation_audit_batches set status=?, "lastError"=?, "nextTryAt"=?, "leaseUntil"=null
       where id=? and status not in ('succeeded','empty')${expectStatus ? ' and status=?' : ''}`,
      [dead ? 'dead' : 'retry', error.slice(0, 500), dead ? null : nextTryAt, id, ...(expectStatus ? [expectStatus] : [])],
    )
    return n > 0
  }

  async completeConversationAuditBatch(input: {
    id: string
    status: 'succeeded' | 'empty'
    fromSeq: number
    toSeq: number
    eventCount: number
    turnCount: number
    sourceHash: string
    resultHash: string
    botName: string
    accountName: string
    retentionDays: number
    /**
     * 一条审计条目的**正文**：身份（id / batchId / 那几个快照名）和时间戳由这一层
     * 自己填，调用方只给内容。
     *
     * 用 Omit 而不是把字段再抄一遍：往 ConversationAuditItem 上加一格正文字段时，
     * 这里会当场编译不过，逼调用方补上。抄一份的话加了也不报错，那一格只是在这条
     * 写入路上永远是空的。
     */
    items: Array<Omit<ConversationAuditItem, 'id' | 'batchId' | 'companyId' | 'accountId' | 'botId' | 'sessionId' | 'botNameSnapshot' | 'accountNameSnapshot' | 'createdAt' | 'expiresAt'>>
  }): Promise<ConversationAuditBatch> {
    return this.tx(async () => {
      const cur = await this.conversationAuditBatch(input.id)
      if (!cur) throw new Error('审计批次不存在')
      if (cur.status === 'succeeded' || cur.status === 'empty') {
        if (cur.resultHash !== input.resultHash || cur.sourceHash !== input.sourceHash) throw new Error('审计批次结果冲突')
        return cur
      }
      const now = Date.now()
      const expiresAt = now + Math.max(30, Math.min(3650, input.retentionDays)) * 86_400_000
      for (const item of input.items) {
        await this.run(
          `insert into conversation_audit_items
           (id,"batchId","companyId","accountId","botId","sessionId","botNameSnapshot","accountNameSnapshot",
            "itemKey","firstSeq","lastSeq","startedAt","endedAt","taskSummary",timeline,"userQuestion","modelAnswer",
            "finalResult",outcome,"modelScore","scoreBreakdown","scoreReasons","scoreMax","scoreConfidence",evidence,"riskFlags",locale,"createdAt","expiresAt")
           values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict do nothing`,
          [
            randomUUID(), cur.id, cur.companyId, cur.accountId, cur.botId, cur.sessionId, input.botName, input.accountName,
            item.itemKey, item.firstSeq, item.lastSeq, item.startedAt, item.endedAt, item.taskSummary,
            JSON.stringify(item.timeline), item.userQuestion, item.modelAnswer, item.finalResult, item.outcome,
            // 两格是 0042 才有的：列是 not null，没带的调用方（老探针、脚本）按「没有原因、中文」落。
            item.modelScore, JSON.stringify(item.scoreBreakdown), JSON.stringify(item.scoreReasons ?? {}),
            JSON.stringify(item.scoreMax ?? {}), item.scoreConfidence,
            JSON.stringify(item.evidence), JSON.stringify(item.riskFlags), item.locale === 'en' ? 'en' : 'zh', now, expiresAt,
          ],
        )
      }
      const r = await this.one(
        `update conversation_audit_batches set status=?, "fromSeq"=?, "toSeq"=?, "eventCount"=?, "turnCount"=?,
         "sourceHash"=?, "resultHash"=?, "leaseUntil"=null, "nextTryAt"=null, "lastError"=null, "completedAt"=?
         where id=? returning *`,
        [input.status, input.fromSeq, input.toSeq, input.eventCount, input.turnCount, input.sourceHash, input.resultHash, now, cur.id],
      )
      return conversationAuditBatchOf(r!)
    })
  }

  async conversationAuditCoverage(accountId: string, botId: string): Promise<{ toSeq: number; windowEnd: number }> {
    const r = await this.one(
      `select coalesce(max("toSeq"),0) as "toSeq", coalesce(max("windowEnd"),0) as "windowEnd"
       from conversation_audit_batches where "accountId"=? and "botId"=? and status in ('succeeded','empty')`,
      [accountId, botId],
    )
    return { toSeq: num(r?.toSeq || 0), windowEnd: num(r?.windowEnd || 0) }
  }

  async conversationAuditBatchesOfDeletion(requestId: string): Promise<ConversationAuditBatch[]> {
    const rows = await this.many(
      'select * from conversation_audit_batches where "deletionRequestId"=? order by "accountId", "createdAt"',
      [requestId],
    )
    return rows.map(conversationAuditBatchOf)
  }

  async conversationAuditItems(companyId: string, filter: {
    accountId?: string
    botId?: string
    from?: number
    to?: number
    outcome?: ConversationAuditOutcome
    scoreLte?: number
    limit?: number
    /**
     * 翻页游标：上一页最后一条的排序键。排序是「结束时间倒序、id 倒序」，所以下一页就是
     * 严格排在它后面的那些。用键而不是 offset：翻页的同时新批次还在落库，offset 会把
     * 同一条推到下一页再出现一次。
     */
    before?: { at: number; id: string }
  } = {}): Promise<ConversationAuditItem[]> {
    const where = ['"companyId" = ?']
    const args: unknown[] = [companyId]
    if (filter.before) {
      where.push('(coalesce("endedAt","createdAt"), id) < (?, ?)')
      args.push(filter.before.at, filter.before.id)
    }
    if (filter.accountId) { where.push('"accountId" = ?'); args.push(filter.accountId) }
    if (filter.botId) { where.push('"botId" = ?'); args.push(filter.botId) }
    if (filter.from != null) { where.push('coalesce("endedAt","createdAt") >= ?'); args.push(filter.from) }
    if (filter.to != null) { where.push('coalesce("endedAt","createdAt") <= ?'); args.push(filter.to) }
    if (filter.outcome) { where.push('outcome = ?'); args.push(filter.outcome) }
    if (filter.scoreLte != null) { where.push('"modelScore" <= ?'); args.push(filter.scoreLte) }
    // 上限 201：接口按「要 n 条就查 n+1 条」判有没有下一页，页大小自己最多 200。
    args.push(Math.min(201, Math.max(1, Math.trunc(filter.limit ?? 100))))
    const rows = await this.many(
      `select * from conversation_audit_items where ${where.join(' and ')}
       order by coalesce("endedAt","createdAt") desc, id desc limit ?`,
      args,
    )
    return rows.map(conversationAuditItemOf)
  }

  /**
   * 审计总结的筛选项来自审计快照，不从当前账号 / Bot 名册现算。
   *
   * Bot 删除后审计仍然保留；如果下拉只读 catalog，那颗已删除 Bot 的历史总结就再也
   * 筛不出来。员工离职同理。每个 id 取最近一条快照，既保留历史对象，也让改名后的
   * 显示尽量接近最后一次审计时的名字。
   */
  async conversationAuditFilterOptions(companyId: string): Promise<{
    accounts: { id: string; name: string }[]
    bots: { id: string; name: string }[]
  }> {
    const [accounts, bots] = await Promise.all([
      this.many(
        `select distinct on ("accountId") "accountId", "accountNameSnapshot"
         from conversation_audit_items where "companyId"=?
         order by "accountId", "createdAt" desc, id desc`,
        [companyId],
      ),
      this.many(
        `select distinct on ("botId") "botId", "botNameSnapshot"
         from conversation_audit_items where "companyId"=?
         order by "botId", "createdAt" desc, id desc`,
        [companyId],
      ),
    ])
    return {
      accounts: accounts
        .map((row) => ({ id: str(row.accountId), name: str(row.accountNameSnapshot) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      bots: bots
        .map((row) => ({ id: str(row.botId), name: str(row.botNameSnapshot) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }
  }

  async conversationAuditItem(id: string): Promise<ConversationAuditItem | undefined> {
    const r = await this.one('select * from conversation_audit_items where id = ?', [id])
    return r ? conversationAuditItemOf(r) : undefined
  }

  async conversationAuditCoverageOfCompany(companyId: string): Promise<ConversationAuditBatch[]> {
    const rows = await this.many(
      `select distinct on ("accountId","botId") * from conversation_audit_batches
       where "companyId"=? order by "accountId","botId","windowEnd" desc,"createdAt" desc`,
      [companyId],
    )
    return rows.map(conversationAuditBatchOf)
  }

  async deleteExpiredConversationAudits(now = Date.now()): Promise<number> {
    return await this.run('delete from conversation_audit_items where "expiresAt" < ?', [now])
  }

  // ── Bot 删除状态机 ──────────────────────────────────────────────────

  async botDeletion(id: string): Promise<BotDeletionRequest | undefined> {
    const r = await this.one('select * from bot_deletion_requests where id = ?', [id])
    return r ? botDeletionRequestOf(r) : undefined
  }

  async liveBotDeletion(botId: string): Promise<BotDeletionRequest | undefined> {
    const r = await this.one(
      `select * from bot_deletion_requests where "botId"=?
       and status in ('freezing','auditing','ready_to_purge','purging','failed') order by "requestedAt" desc limit 1`,
      [botId],
    )
    return r ? botDeletionRequestOf(r) : undefined
  }

  async createBotDeletion(input: {
    companyId: string
    accountId?: string | null
    botId: string
    botName: string
    requestedBy: string
  }): Promise<BotDeletionRequest> {
    return this.tx(async () => {
      const existing = await this.liveBotDeletion(input.botId)
      if (existing) return existing
      const now = Date.now()
      const id = randomUUID()
      const r = await this.one(
        `insert into bot_deletion_requests
         (id,"companyId","accountId","botId","botNameSnapshot","requestedBy",status,"cutoffAt",
          "targetCount","auditedCount",attempts,"nextTryAt",orphans,"requestedAt")
         values (?,?,?,?,?,?,?,?,?,?,?,?,?,?) returning *`,
        [id, input.companyId, input.accountId ?? null, input.botId, input.botName, input.requestedBy,
          'freezing', now, 0, 0, 0, now, '[]', now],
      )
      await this.run('update catalog_items set "deletingAt"=?, "updatedAt"=? where id=? and kind=\'bot\'', [now, now, input.botId])
      await this.run(
        `update conversation_audit_batches set status='dead', "lastError"='已由删除终审批次接管',
         "leaseUntil"=null, "nextTryAt"=null
         where "botId"=? and kind='scheduled' and status not in ('succeeded','empty','dead')`,
        [input.botId],
      )
      return botDeletionRequestOf(r!)
    })
  }

  async updateBotDeletion(id: string, patch: {
    status?: BotDeletionStatus
    targetCount?: number
    auditedCount?: number
    attempts?: number
    nextTryAt?: number | null
    lastError?: string | null
    orphans?: { seatId: string; error: string }[]
    auditCompletedAt?: number | null
    deletedAt?: number | null
  }): Promise<BotDeletionRequest> {
    const cur = await this.botDeletion(id)
    if (!cur) throw new Error('删除请求不存在')
    const next = { ...cur, ...patch }
    const r = await this.one(
      `update bot_deletion_requests set status=?, "targetCount"=?, "auditedCount"=?, attempts=?,
       "nextTryAt"=?, "lastError"=?, orphans=?, "auditCompletedAt"=?, "deletedAt"=? where id=? returning *`,
      [next.status, next.targetCount, next.auditedCount, next.attempts, next.nextTryAt, next.lastError,
        JSON.stringify(next.orphans), next.auditCompletedAt, next.deletedAt, id],
    )
    return botDeletionRequestOf(r!)
  }

  /**
   * 删除请求的状态迁移，**带旧状态条件**：库里那一行还是 `expect` 描述的样子才改，改到了
   * 返回新行，没改到（别人先动了）返回 undefined。
   *
   * 重叠的两拍 tick、requestBotDeletion 的同步推进、升级时新旧两个进程，都会拿着同一行去
   * 推同一个请求。不带条件的话两边都走到 purgeBot——席位被释放两遍、完成审计记两条。
   * 只有抢到这一次更新的那一边往下做。
   */
  async casBotDeletion(
    id: string,
    expect: { status: BotDeletionStatus; attempts: number; nextTryAt?: number | null },
    patch: Parameters<SessionsDb['updateBotDeletion']>[1],
  ): Promise<BotDeletionRequest | undefined> {
    const cols: Record<string, string> = {
      status: 'status',
      targetCount: '"targetCount"',
      auditedCount: '"auditedCount"',
      attempts: 'attempts',
      nextTryAt: '"nextTryAt"',
      lastError: '"lastError"',
      orphans: 'orphans',
      auditCompletedAt: '"auditCompletedAt"',
      deletedAt: '"deletedAt"',
    }
    const sets: string[] = []
    const args: unknown[] = []
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !cols[k]) continue
      sets.push(`${cols[k]} = ?`)
      args.push(k === 'orphans' ? JSON.stringify(v) : v)
    }
    if (!sets.length) throw new Error('casBotDeletion 没有要改的字段')
    let where = 'id = ? and status = ? and attempts = ?'
    args.push(id, expect.status, expect.attempts)
    if (expect.nextTryAt !== undefined) {
      where += ' and "nextTryAt" is not distinct from ?'
      args.push(expect.nextTryAt)
    }
    const r = await this.one(`update bot_deletion_requests set ${sets.join(', ')} where ${where} returning *`, args)
    return r ? botDeletionRequestOf(r) : undefined
  }

  /** 失败的删除请求不无限重试：试满这么多次就停在 failed 上，等人来看。 */
  async dueBotDeletions(now = Date.now(), limit = 20): Promise<BotDeletionRequest[]> {
    const rows = await this.many(
      `select * from bot_deletion_requests where status in ('freezing','auditing','ready_to_purge','purging','failed')
       and attempts < ? and ("nextTryAt" is null or "nextTryAt" <= ?) order by "requestedAt" asc limit ?`,
      [MAX_BOT_DELETION_ATTEMPTS, now, limit],
    )
    return rows.map(botDeletionRequestOf)
  }
}
