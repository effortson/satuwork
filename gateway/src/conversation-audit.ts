/** 自动对话审计的窗口调度、席位派发与 Bot 删除状态机。 */
import { MAX_BOT_DELETION_ATTEMPTS, type BotDeletionRequest, type BotDeletionStatus, type Db, type ConversationAuditBatch, type ConversationAuditSettings } from './db.ts'
import { createHash } from 'node:crypto'
import { fromZoned, partsIn } from './lib/schedule.ts'
import { machineHeader, seatBearer } from './lib/runtime.ts'
import { purgeBot } from './deploy.ts'

const GRACE_MS = Math.max(0, Math.trunc(Number(process.env.GATEWAY_AUDIT_GRACE_MS ?? 5 * 60_000)))
const LEASE_MS = Math.max(60_000, Math.trunc(Number(process.env.GATEWAY_AUDIT_LEASE_MS ?? 10 * 60_000)))
const QUIET_MS = 5 * 60_000
const FORCE_ABORT_MS = 2 * 60_000
const DISPATCH_LIMIT = 20
const RETRIES = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]
let lastPruneAt = 0

/**
 * 一个批次结果的指纹：同一个批次重报时靠它判「是不是同一份」（routes/internal.ts）。
 *
 * **按加 scoreReasons / scoreMax / locale 之前的形状算**：三格都是默认值（空、空、zh）时不进
 * 指纹，有内容才追加在每一条的末尾。否则升级前已经落库的批次，席位在升级后重报同一份结果
 * （上次回报超时、其实已经存上了）会算出另一个指纹、被 409 顶回去，那一条永远卡在席位的
 * 待报队列里。
 */
export function auditResultHash(input: {
  fromSeq: number
  toSeq: number
  eventCount: number
  turnCount: number
  sourceHash: string
  items: Array<Record<string, unknown> & { scoreReasons?: Record<string, string>; scoreMax?: Record<string, number>; locale?: string }>
}): string {
  const { fromSeq, toSeq, eventCount, turnCount, sourceHash } = input
  const items = input.items.map(({ scoreReasons, scoreMax, locale, ...rest }) => ({
    ...rest,
    ...(scoreReasons && Object.keys(scoreReasons).length ? { scoreReasons } : {}),
    ...(scoreMax && Object.keys(scoreMax).length ? { scoreMax } : {}),
    ...(locale && locale !== 'zh' ? { locale } : {}),
  }))
  return createHash('sha256').update(JSON.stringify({ fromSeq, toSeq, eventCount, turnCount, sourceHash, items })).digest('hex')
}

function addDays(y: number, mo: number, d: number, n: number) {
  const at = new Date(Date.UTC(y, mo - 1, d + n))
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() }
}

/**
 * 最近若干个已关闭的 8 小时窗口，旧到新。
 *
 * `since` 给的是已有水位（coverage.windowEnd）：比它早的窗口本来就会被滤掉，没必要
 * 先算出几十天的边界再扔——每个边界要过四次 partsIn，这段跑在每个 tick 的每家公司上。
 */
export function closedAuditWindows(tz: string, now = Date.now(), count = 24, since?: number): { start: number; end: number }[] {
  // 先让 Intl 验时区；非法值要在设置接口被挡，这里仍不能让整个调度 tick 崩掉。
  const p = partsIn(tz, now)
  const boundaries: number[] = []
  let daysBack = Math.ceil(Math.max(3, count) / 3) + 3
  // 多退两天：水位所在的那个窗口本身也要在列表里（它是下一个窗口的 start）。
  // 下限 1 天：最近一个已关闭窗口的起点可能在昨天 17 点，一天都不退会把它漏掉。
  if (since != null && since > 0) daysBack = Math.max(1, Math.min(daysBack, Math.ceil((now - since) / 86_400_000) + 2))
  for (let delta = -daysBack; delta <= 2; delta++) {
    const day = addDays(p.year, p.month, p.day, delta)
    for (const hour of [1, 9, 17]) boundaries.push(fromZoned(tz, day.year, day.month, day.day, hour, 0))
  }
  boundaries.sort((a, b) => a - b)
  const cutoff = now - GRACE_MS
  const out: { start: number; end: number }[] = []
  for (let i = 1; i < boundaries.length; i++) {
    if (boundaries[i]! <= cutoff) out.push({ start: boundaries[i - 1]!, end: boundaries[i]! })
  }
  return out.slice(-Math.max(1, count))
}

/**
 * 「审计模型没配」已经提醒过的公司 → 当时提醒的是哪个角色。
 *
 * 审计默认开启而模型未配是新装环境的常态，每 30 秒的 tick 对每个目标各刷一条 error，
 * 一夜下来日志里全是同一句话。改成每家公司只说一次，配好了就把记忆清掉——再次拆掉配置
 * 或换了角色时会再提醒一次。
 */
const warnedNoModel = new Map<string, string>()

function pickedModel(platform: Awaited<ReturnType<Db['platformSettings']>>, settings: ConversationAuditSettings) {
  const role = settings.modelRole
  const picked = platform[role]
  if (!picked.provider || !picked.model) return null
  return { role, provider: picked.provider, model: picked.model, reasoningEffort: picked.reasoningEffort }
}

function emptyResult(fromSeq: number) {
  const sourceHash = createHash('sha256').update('').digest('hex')
  const canonical = JSON.stringify({
    fromSeq,
    toSeq: fromSeq,
    eventCount: 0,
    turnCount: 0,
    sourceHash,
    items: [],
  })
  return {
    sourceHash,
    resultHash: createHash('sha256').update(canonical).digest('hex'),
  }
}

async function createScheduledBatches(db: Db, now = Date.now()): Promise<number> {
  const platform = await db.platformSettings()
  let created = 0
  for (const company of await db.companies()) {
    const settings = (await db.settings(company.id)).conversationAudit
    if (!settings.enabled) continue
    // 先取各目标的水位：窗口只需要回溯到最老的那条水位，没有水位的目标只看最近一个窗口。
    const targets: { target: Awaited<ReturnType<Db['conversationAuditTargets']>>[number]; coverage: Awaited<ReturnType<Db['conversationAuditCoverage']>> }[] = []
    for (const target of await db.conversationAuditTargets(company.id)) {
      targets.push({ target, coverage: await db.conversationAuditCoverage(target.accountId, target.botId || '') })
    }
    const oldest = targets.reduce<number | undefined>((acc, t) => (t.coverage.windowEnd ? Math.min(acc ?? Infinity, t.coverage.windowEnd) : acc), undefined)
    let windows: { start: number; end: number }[]
    try {
      // 停机后的缺口补到保留期边界；更老的摘要即使生成也会立刻过期，没有回填价值。
      windows = closedAuditWindows(settings.timezone, now, settings.retentionDays * 3 + 3, oldest)
    } catch (e) {
      console.error(`satuwork-gateway: 公司 ${company.id} 的审计时区不可用：${(e as Error).message}`)
      continue
    }
    const latest = windows.at(-1)
    if (!latest) continue
    const model = pickedModel(platform, settings)
    if (model) warnedNoModel.delete(company.id)
    for (const { target, coverage } of targets) {
      // 第一次启用不回填整段历史，只从最近刚关闭的窗口开始；一旦有水位，停机期间的缺口全补。
      const eligible = coverage.windowEnd
        ? windows.filter((w) => w.end > coverage.windowEnd)
        : [latest]
      // 同一 pair 串行推进水位；后一个窗口不能拿着前一个尚未确认的 fromSeq 抢跑。
      // 一轮只推一个窗口，fromSeq 就是上面刚取的那份水位，中间没有写过，不必再查一遍。
      for (const window of eligible.slice(0, 1)) {
        // session_index 会在用户消息和 turn/end 时更新。若它在整段窗口里都没有动过，
        // 这个窗口不可能有新对话；messageCount=0 则连首次启用也可以直接判空。
        // 仍落一个 empty 水位，避免 Gateway 重启后反复检查同一窗口，但不派发 Bot、
        // 不读会话正文，也不会产生模型调用。删除前终审不走这里，不能被该优化绕过。
        const skipEmpty = target.messageCount === 0 || target.updatedAt < window.start
        if (!model && !skipEmpty) {
          // 每家公司只说一次（见 warnedNoModel）。
          if (warnedNoModel.get(company.id) !== settings.modelRole) {
            warnedNoModel.set(company.id, settings.modelRole)
            console.warn(`satuwork-gateway: 公司 ${company.id} 的审计模型 ${settings.modelRole} 尚未配置，自动审计暂停，配好后自动恢复`)
          }
          continue
        }
        const selected = model ?? {
          role: settings.modelRole,
          provider: platform[settings.modelRole].provider,
          model: platform[settings.modelRole].model,
          reasoningEffort: platform[settings.modelRole].reasoningEffort,
        }
        const batch = await db.insertConversationAuditBatch({
          companyId: company.id,
          accountId: target.accountId,
          botId: target.botId || '',
          sessionId: target.sessionId,
          kind: 'scheduled',
          windowStart: window.start,
          windowEnd: window.end,
          timezone: settings.timezone,
          fromSeq: coverage.toSeq,
          modelRole: selected.role,
          provider: selected.provider,
          model: selected.model,
          reasoningEffort: selected.reasoningEffort,
          promptVersion: settings.promptVersion,
        })
        if (batch.createdAt >= now - 1000) created++
        if (skipEmpty && batch.status === 'queued' && batch.attempts === 0) {
          const hashes = emptyResult(coverage.toSeq)
          const account = await db.account(target.accountId)
          const bot = await db.catalog(target.botId || '')
          await db.completeConversationAuditBatch({
            id: batch.id,
            status: 'empty',
            fromSeq: coverage.toSeq,
            toSeq: coverage.toSeq,
            eventCount: 0,
            turnCount: 0,
            sourceHash: hashes.sourceHash,
            resultHash: hashes.resultHash,
            botName: bot?.name || target.botId || '',
            accountName: account?.name || account?.email || target.accountId,
            retentionDays: settings.retentionDays,
            items: [],
          })
        }
      }
    }
  }
  return created
}

async function targetHeaders(db: Db, batch: ConversationAuditBatch) {
  const instance = await db.instance(batch.accountId, batch.botId)
  if (!instance?.host) throw new Error('实例还没上线')
  const seat = await db.seatRuntime(batch.accountId, batch.botId)
  const machine = seat?.machineId ? await db.machine(seat.machineId) : undefined
  const bearer = await seatBearer(db, batch.accountId)
  if (!bearer) throw new Error('席位凭证不存在')
  return {
    url: `${instance.host.replace(/\/$/, '')}/api/audit-jobs/${encodeURIComponent(batch.id)}`,
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      ...machineHeader(machine?.token || undefined),
    },
  }
}

/**
 * 把任务 POST 给席位。**幂等**：席位对同一个 jobId 回 `accepted`（新接下）/ `running`
 * （还在跑）/ `cached`（已经跑完，重放结果），都不会再花一次模型费——所以派发和续租
 * 用的是同一个请求。
 */
async function postAuditJob(db: Db, batch: ConversationAuditBatch): Promise<void> {
  const target = await targetHeaders(db, batch)
  const deletion = batch.deletionRequestId ? await db.botDeletion(batch.deletionRequestId) : undefined
  /**
   * 审计文字用会话主人的界面语言写（个人设置里那个中文 / English）。按派活这一刻取，
   * 不存在批次上：改了语言之后，还没跑的批次就该用新的；已经跑完的那几条照旧是当时的语言，
   * 条目自己记着（conversation_audit_items.locale）。
   */
  const owner = await db.account(batch.accountId)
  const r = await fetch(target.url, {
    method: 'POST',
    headers: target.headers,
    body: JSON.stringify({
      id: batch.id,
      sessionId: batch.sessionId,
      botId: batch.botId,
      kind: batch.kind,
      windowStart: batch.windowStart,
      windowEnd: batch.windowEnd,
      timezone: batch.timezone,
      fromSeq: batch.fromSeq,
      modelRole: batch.modelRole,
      provider: batch.provider,
      model: batch.model,
      reasoningEffort: batch.reasoningEffort,
      promptVersion: batch.promptVersion,
      locale: owner?.locale === 'en' ? 'en' : 'zh',
      quiesceMs: batch.kind === 'pre_delete' ? QUIET_MS : 0,
      forceAbort: Boolean(deletion && Date.now() - deletion.requestedAt >= FORCE_ABORT_MS),
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`席位返回 HTTP ${r.status}${body ? ` ${body.slice(0, 160)}` : ''}`)
  }
}

async function dispatchBatch(db: Db, batch: ConversationAuditBatch): Promise<void> {
  await postAuditJob(db, batch)
  await db.markConversationAuditProcessing(batch.id, Date.now() + LEASE_MS)
}

/**
 * 给还在跑的批次续租。
 *
 * 租约只有 10 分钟，而一次审计可能更久（删除前终审先要静默 5 分钟，再加一轮模型）。
 * 以前没有续租：到期就被 claim 回去、attempts +1、重新派发——席位那头虽然幂等，
 * 但 attempts 会一路涨上去，界面上看着像反复失败。现在每过 lease/2 问一次席位：
 * 它还认这个任务（2xx）就把租约再撑满；问不到（席位挂了、机器关了）就什么都不做，
 * 让租约自然过期走原来的重试路径——续租不能变成给一个死掉的席位无限续命。
 */
async function renewProcessingLeases(db: Db, now = Date.now()): Promise<number> {
  let renewed = 0
  for (const batch of await db.processingConversationAuditBatches(now + LEASE_MS / 2, DISPATCH_LIMIT)) {
    try {
      await postAuditJob(db, batch)
      await db.markConversationAuditProcessing(batch.id, Date.now() + LEASE_MS)
      renewed++
    } catch {
      // 到期由 claim 那条路接手；这里不记错，免得一台关机的机器每 30 秒刷一条。
    }
  }
  return renewed
}

async function dispatchDueBatches(db: Db): Promise<number> {
  let dispatched = 0
  for (let i = 0; i < DISPATCH_LIMIT; i++) {
    const batch = await db.claimConversationAuditBatch(Date.now(), LEASE_MS)
    if (!batch) break
    try {
      await dispatchBatch(db, batch)
      dispatched++
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const retry = RETRIES[Math.min(batch.attempts - 1, RETRIES.length - 1)]!
      // 自动审计不能在第八次失败后永久静默；封顶为每小时重试，直到席位或模型恢复。
      // dead 只留给“删除终审已经接管了这个普通批次”的明确终止情形。
      await db.retryConversationAuditBatch(batch.id, message, Date.now() + retry, false)
    }
  }
  return dispatched
}

/** 每个 Gateway tick 调一次。 */
export async function tickConversationAudits(db: Db): Promise<{ created: number; dispatched: number }> {
  const now = Date.now()
  if (now - lastPruneAt >= 60 * 60_000) {
    await db.deleteExpiredConversationAudits(now)
    lastPruneAt = now
  }
  const created = await createScheduledBatches(db, now)
  await renewProcessingLeases(db, now)
  const dispatched = await dispatchDueBatches(db)
  return { created, dispatched }
}

async function createDeletionBatches(db: Db, request: Awaited<ReturnType<Db['botDeletion']>> & object): Promise<number> {
  const targets = await db.conversationAuditTargets(undefined, request.botId, true)
  const platform = await db.platformSettings()
  // 没有主会话也留下一笔明确的 empty 终审。物理删除的数据库防线要求终审批次必须存在，
  // 因此“这颗 Bot 从未对话过”是可核验的结论，而不是绕过审计状态机的特殊通道。
  if (!targets.length) {
    const settings = (await db.settings(request.companyId)).conversationAudit
    const picked = platform[settings.modelRole]
    const accountId = request.accountId || request.requestedBy
    const account = await db.account(accountId)
    const batch = await db.insertConversationAuditBatch({
      companyId: request.companyId,
      accountId,
      botId: request.botId,
      sessionId: '',
      deletionRequestId: request.id,
      kind: 'pre_delete',
      windowStart: 0,
      windowEnd: request.cutoffAt,
      timezone: settings.timezone,
      fromSeq: 0,
      modelRole: settings.modelRole,
      provider: picked.provider,
      model: picked.model,
      reasoningEffort: picked.reasoningEffort,
      promptVersion: settings.promptVersion,
    })
    const sourceHash = createHash('sha256').update('').digest('hex')
    const resultHash = createHash('sha256').update(JSON.stringify({ empty: true, sourceHash })).digest('hex')
    await db.completeConversationAuditBatch({
      id: batch.id, status: 'empty', fromSeq: 0, toSeq: 0, eventCount: 0, turnCount: 0,
      sourceHash, resultHash, botName: request.botNameSnapshot,
      accountName: account?.name || account?.email || accountId,
      retentionDays: settings.retentionDays, items: [],
    })
    return 1
  }
  let count = 0
  for (const target of targets) {
    const settings = (await db.settings(target.companyId)).conversationAudit
    const model = pickedModel(platform, settings)
    if (!model) throw new Error(`公司 ${target.companyId} 的审计模型 ${settings.modelRole} 尚未配置`)
    const coverage = await db.conversationAuditCoverage(target.accountId, request.botId)
    await db.insertConversationAuditBatch({
      companyId: target.companyId,
      accountId: target.accountId,
      botId: request.botId,
      sessionId: target.sessionId,
      deletionRequestId: request.id,
      kind: 'pre_delete',
      windowStart: coverage.windowEnd || 0,
      windowEnd: request.cutoffAt,
      timezone: settings.timezone,
      fromSeq: coverage.toSeq,
      modelRole: model.role,
      provider: model.provider,
      model: model.model,
      reasoningEffort: model.reasoningEffort,
      promptVersion: settings.promptVersion,
    })
    count++
  }
  return count
}

/**
 * 'failed' 只记了「出过错」，没记在哪一步出的错。终审早就过了、拆席位时失败的请求，
 * 不能再送回去建一批终审批次——那会用 cutoffAt 之后的水位再建一份 [cutoffAt, cutoffAt]
 * 的空批次。表里没有「失败前的阶段」这一列，就从已有的痕迹推：auditCompletedAt 已落，
 * 或者这个请求名下的终审批次都已跑完，就直接回到拆席位那一步。
 */
async function resumeStatusOf(db: Db, request: BotDeletionRequest): Promise<BotDeletionStatus> {
  if (request.status !== 'failed') return request.status
  if (request.auditCompletedAt != null) return 'ready_to_purge'
  const batches = await db.conversationAuditBatchesOfDeletion(request.id)
  if (batches.length && batches.every((b) => b.status === 'succeeded' || b.status === 'empty')) return 'ready_to_purge'
  return 'freezing'
}

async function advanceDeletion(db: Db, request: BotDeletionRequest): Promise<void> {
  try {
    const status = await resumeStatusOf(db, request)
    if (status === 'freezing') {
      const count = await createDeletionBatches(db, request)
      if (!count) {
        await db.updateBotDeletion(request.id, {
          status: 'ready_to_purge', targetCount: 0, auditedCount: 0, auditCompletedAt: Date.now(), nextTryAt: Date.now(),
        })
      } else {
        await db.updateBotDeletion(request.id, { status: 'auditing', targetCount: count, lastError: null, nextTryAt: Date.now() + 5000 })
      }
      return
    }
    if (status === 'auditing') {
      const batches = await db.conversationAuditBatchesOfDeletion(request.id)
      const done = batches.filter((b) => b.status === 'succeeded' || b.status === 'empty').length
      if (done < batches.length) {
        await db.updateBotDeletion(request.id, { auditedCount: done, nextTryAt: Date.now() + 5000 })
        return
      }
      await db.updateBotDeletion(request.id, {
        status: 'ready_to_purge', auditedCount: done, auditCompletedAt: Date.now(), nextTryAt: Date.now(),
      })
      return
    }
    if (status === 'ready_to_purge' || status === 'purging') {
      await db.updateBotDeletion(request.id, { status: 'purging', attempts: request.attempts + 1, nextTryAt: Date.now() + 60_000 })
      const { released, failed } = await purgeBot(db, request.botId)
      const orphans = failed.map((f) => ({ seatId: f.seat.seatId, error: f.error }))
      await db.updateBotDeletion(request.id, {
        status: 'completed', orphans, deletedAt: Date.now(), nextTryAt: null, lastError: null,
      })
      await db.audit({
        companyId: request.companyId,
        accountId: request.requestedBy,
        action: 'bot.delete.completed',
        detail: { requestId: request.id, botId: request.botId, seats: released.length, orphans },
      })
    }
  } catch (e) {
    const attempts = request.attempts + 1
    let message = (e instanceof Error ? e.message : String(e)).slice(0, 500)
    // 到了上限就不再自动重试（dueBotDeletions 按 attempts 过滤），状态仍是 failed，
    // 错误里说清楚是停了而不是还在转，留给管理员处理。
    if (attempts >= MAX_BOT_DELETION_ATTEMPTS) message += `（已重试 ${attempts} 次，不再自动重试）`
    await db.updateBotDeletion(request.id, {
      status: 'failed', attempts, lastError: message, nextTryAt: Date.now() + 60_000,
    })
  }
}

export async function tickBotDeletions(db: Db): Promise<number> {
  const rows = await db.dueBotDeletions()
  for (const row of rows) await advanceDeletion(db, row)
  return rows.length
}

export async function requestBotDeletion(db: Db, input: {
  companyId: string
  accountId?: string | null
  botId: string
  botName: string
  requestedBy: string
}) {
  const existing = await db.liveBotDeletion(input.botId)
  if (existing) return existing
  const request = await db.createBotDeletion(input)
  await db.audit({
    companyId: input.companyId,
    accountId: input.requestedBy,
    action: 'bot.delete.requested',
    detail: { requestId: request.id, botId: input.botId, name: input.botName },
  })
  // 不等下一次 30 秒 tick，至少同步建好终审批次；真正联系席位和调用模型仍在后台跑。
  await advanceDeletion(db, request)
  let current = (await db.botDeletion(request.id))!
  const batches = await db.conversationAuditBatchesOfDeletion(request.id)
  const seats = await db.seatRuntimesOfBot(input.botId)
  // 从未有会话、也没有席位的 Bot 不需要人为等两个 scheduler tick：empty 终审已经落库，
  // 直接把状态机走完。它仍然经过同一条数据库删除防线，不是兼容旧接口的旁路。
  if (batches.length === 1 && batches[0]?.sessionId === '' && batches[0].status === 'empty') {
    await db.updateBotDeletion(current.id, { nextTryAt: Date.now() })
    await advanceDeletion(db, (await db.botDeletion(current.id))!)
    current = (await db.botDeletion(current.id))!
    await db.updateBotDeletion(current.id, { nextTryAt: Date.now() })
    await advanceDeletion(db, (await db.botDeletion(current.id))!)
    current = (await db.botDeletion(current.id))!
    return { ...current, releasedSeats: Math.max(0, seats.length - current.orphans.length) }
  }
  return current
}
