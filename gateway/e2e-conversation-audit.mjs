/** 自动对话审计的数据库与窗口探针。由 e2e/conversation-audit.mjs 调用。 */
import { Db } from './src/db.ts'
import { auditResultHash, closedAuditWindows, requestBotDeletion, tickBotDeletions, tickConversationAudits } from './src/conversation-audit.ts'
import { partsIn } from './src/lib/schedule.ts'

const url = process.env.E2E_DATABASE_URL || 'postgres://satuwork:satuwork@127.0.0.1:5434/satuwork'
const schema = process.env.E2E_AUDIT_SCHEMA || 'e2e_conversation_audit'
const db = new Db({ url, schema })
const out = { 窗口: {}, 配置: {}, 空时段: {}, 筛选: {}, 翻页: {}, 评分理由: {}, 结果指纹: {}, 删除终审: {} }

try {
  await db.init()

  const now = Date.parse('2026-09-01T09:01:00+08:00')
  const windows = closedAuditWindows('Asia/Kuching', now, 6)
  const newestEnd = windows.at(-1)?.end
  out.窗口 = {
    三段连续: windows.every((row, i) => !i || windows[i - 1].end === row.start),
    固定八小时: windows.every((row) => row.end - row.start === 8 * 60 * 60_000),
    九点收口: newestEnd != null && partsIn('Asia/Kuching', newestEnd).hour === 9,
    每天三段: new Set(windows.map((row) => `${partsIn('Asia/Kuching', row.end).year}-${partsIn('Asia/Kuching', row.end).month}-${partsIn('Asia/Kuching', row.end).day}`)).size >= 2,
  }

  const dst = closedAuditWindows('America/New_York', Date.parse('2026-11-02T18:00:00Z'), 12)
  out.窗口.夏令时仍连续 = dst.every((row, i) => !i || dst[i - 1].end === row.start)
  out.窗口.边界只在一九十七点 = dst.every((row) => [1, 9, 17].includes(partsIn('America/New_York', row.end).hour))

  const company = await db.insertCompany({ slug: 'audit-probe', name: '审计探针' })
  const account = await db.insertAccount({ companyId: company.id, email: 'audit@example.test', passwordHash: 'x', role: 'member' })
  const defaults = (await db.settings(company.id)).conversationAudit
  out.配置 = {
    默认任务模型: defaults.modelRole === 'daily',
    固定锚点: defaults.anchor === '09:00' && defaults.windowMinutes === 480,
  }

  const platform = await db.platformSettings()
  await db.putPlatformSettings({
    ...platform,
    daily: { provider: 'probe', model: 'probe', reasoningEffort: 'off' },
  })
  const idleBot = await db.insertCatalog({
    kind: 'bot', scope: 'user', companyId: company.id, accountId: account.id, name: '空时段 Bot',
  })
  await db.upsertSessionIndex({
    sessionId: 'audit-idle-session', companyId: company.id, accountId: account.id, botId: idleBot.id,
    messageCount: 2, createdAt: Date.now() - 30 * 60 * 60_000, updatedAt: Date.now() - 20 * 60 * 60_000,
  })
  const idleTick = await tickConversationAudits(db)
  const idleCoverage = await db.conversationAuditCoverage(account.id, idleBot.id)
  out.空时段 = {
    Gateway直接判空: idleCoverage.windowEnd > 0 && idleCoverage.toSeq === 0,
    不派发到Bot: idleTick.dispatched === 0,
  }

  const bot = await db.insertCatalog({ kind: 'bot', scope: 'user', companyId: company.id, accountId: account.id, name: '待删除 Bot' })
  let blocked = false
  try { await db.deleteBot(bot.id) } catch (e) { blocked = String(e).includes('审计尚未完成') }

  const summaryBatch = await db.insertConversationAuditBatch({
    companyId: company.id,
    accountId: account.id,
    botId: bot.id,
    sessionId: 'audit-filter-session',
    kind: 'scheduled',
    windowStart: now - 8 * 60 * 60_000,
    windowEnd: now,
    timezone: 'Asia/Kuching',
    modelRole: 'daily',
    provider: 'probe',
    model: 'probe',
  })
  await db.completeConversationAuditBatch({
    id: summaryBatch.id,
    status: 'succeeded',
    fromSeq: 0,
    toSeq: 4,
    eventCount: 4,
    turnCount: 1,
    sourceHash: 'source-filter',
    resultHash: 'result-filter',
    botName: '已删除 Bot 快照',
    accountName: '已离职员工快照',
    retentionDays: 180,
    items: [{
      itemKey: 'filter-item', firstSeq: 1, lastSeq: 4, startedAt: now - 1000, endedAt: now,
      taskSummary: '筛选探针', timeline: [], userQuestion: '问题', modelAnswer: '回答', finalResult: '完成',
      outcome: 'completed', modelScore: 90, scoreBreakdown: {}, scoreConfidence: 1, evidence: [], riskFlags: [],
    }],
  })

  /**
   * 翻页：一个批次落 25 条，按「结束时间倒序、id 倒序」一页 10 条往后翻。其中两条结束时间
   * 相同——只按时间做游标的话，正好卡在页边上的那一对会丢一条或重复一条。
   */
  const pageBot = await db.insertCatalog({ kind: 'bot', scope: 'user', companyId: company.id, accountId: account.id, name: '翻页 Bot' })
  const pageBatch = await db.insertConversationAuditBatch({
    companyId: company.id, accountId: account.id, botId: pageBot.id, sessionId: 'audit-page-session', kind: 'scheduled',
    windowStart: now - 8 * 60 * 60_000, windowEnd: now, timezone: 'Asia/Kuching', modelRole: 'daily', provider: 'probe', model: 'probe',
  })
  const pageItems = Array.from({ length: 25 }, (_, i) => ({
    itemKey: `page-${i}`, firstSeq: i + 1, lastSeq: i + 1, startedAt: now - 100_000 + i,
    // 第 10、11 条同一个结束时间，正好跨在第一页和第二页之间。
    endedAt: now - 100_000 + (i === 10 ? 9 : i) * 10,
    taskSummary: `翻页 ${i}`, timeline: [], userQuestion: '问', modelAnswer: '答', finalResult: '完成',
    outcome: 'completed', modelScore: 80, scoreBreakdown: { completion: 30, evidence: 20, instructionFollowing: 15, efficiency: 8, communication: 7 },
    scoreReasons: i === 0 ? { completion: 'Sent the email but skipped the requested CC.', evidence: 'Tool result shows the sent id.' } : {},
    scoreMax: i === 0 ? { completion: 50, evidence: 20 } : {},
    scoreConfidence: 0.9, evidence: [], riskFlags: [], locale: i === 0 ? 'en' : 'zh',
  }))
  await db.completeConversationAuditBatch({
    id: pageBatch.id, status: 'succeeded', fromSeq: 0, toSeq: 25, eventCount: 25, turnCount: 25,
    sourceHash: 'source-page', resultHash: 'result-page', botName: '翻页 Bot', accountName: '已离职员工快照', retentionDays: 180,
    items: pageItems,
  })
  const pages = []
  let before
  for (let i = 0; i < 5; i++) {
    const rows = await db.conversationAuditItems(company.id, { botId: pageBot.id, limit: 10, before })
    if (!rows.length) break
    pages.push(rows)
    const last = rows[rows.length - 1]
    before = { at: last.endedAt ?? last.createdAt, id: last.id }
  }
  const seen = pages.flat()
  out.翻页 = {
    三页翻完: pages.length === 3 && pages[0].length === 10 && pages[2].length === 5,
    不重不漏: seen.length === 25 && new Set(seen.map((x) => x.id)).size === 25,
    // 同时间那一对的先后由库的排序规则定（id 是文本），这里只钉「结束时间不倒退」。
    按结束时间倒序: seen.every((x, i) => !i || seen[i - 1].endedAt >= x.endedAt),
  }
  const reasoned = seen.find((x) => x.itemKey === 'page-0')
  const plain = seen.find((x) => x.itemKey === 'page-1')
  out.评分理由 = {
    原因原样存回: reasoned?.scoreReasons?.completion === 'Sent the email but skipped the requested CC.',
    语言记在条目上: reasoned?.locale === 'en' && plain?.locale === 'zh',
    没原因就是空对象: plain && Object.keys(plain.scoreReasons).length === 0,
    满分跟着条目存: reasoned?.scoreMax?.completion === 50 && plain && Object.keys(plain.scoreMax).length === 0,
  }

  // 升级前落库的批次，升级后被原样重报：新代码给每条补上的默认值（空原因、空满分、zh）
  // 不能改变指纹，否则会被当成「提交过不同的结果」顶回去。
  const legacyItem = { itemKey: 'k', firstSeq: 1, lastSeq: 2, startedAt: 1, endedAt: 2, taskSummary: 's', timeline: [], userQuestion: 'q', modelAnswer: 'a', finalResult: 'r', outcome: 'completed', modelScore: 80, scoreBreakdown: { completion: 30 }, scoreConfidence: 0.9, evidence: [], riskFlags: [] }
  const head = { fromSeq: 0, toSeq: 2, eventCount: 2, turnCount: 1, sourceHash: 'h' }
  const { createHash } = await import('node:crypto')
  const legacyHash = createHash('sha256').update(JSON.stringify({ ...head, items: [legacyItem] })).digest('hex')
  out.结果指纹 = {
    默认值不改指纹: auditResultHash({ ...head, items: [{ ...legacyItem, scoreReasons: {}, scoreMax: {}, locale: 'zh' }] }) === legacyHash,
    有原因才进指纹: auditResultHash({ ...head, items: [{ ...legacyItem, scoreReasons: { completion: 'x' }, scoreMax: {}, locale: 'zh' }] }) !== legacyHash,
    英文进指纹: auditResultHash({ ...head, items: [{ ...legacyItem, scoreReasons: {}, scoreMax: {}, locale: 'en' }] }) !== legacyHash,
  }

  const pendingBot = await db.insertCatalog({ kind: 'bot', scope: 'user', companyId: company.id, accountId: account.id, name: '幂等 Bot' })
  await db.upsertSessionIndex({ sessionId: 'audit-idempotent-session', companyId: company.id, accountId: account.id, botId: pendingBot.id })
  const pendingFirst = await requestBotDeletion(db, {
    companyId: company.id, accountId: account.id, botId: pendingBot.id, botName: pendingBot.name, requestedBy: account.id,
  })
  const pendingSecond = await requestBotDeletion(db, {
    companyId: company.id, accountId: account.id, botId: pendingBot.id, botName: pendingBot.name, requestedBy: account.id,
  })

  const first = await requestBotDeletion(db, {
    companyId: company.id, accountId: account.id, botId: bot.id, botName: bot.name, requestedBy: account.id,
  })
  for (let i = 0; i < 20; i++) {
    const row = await db.botDeletion(first.id)
    if (row?.status === 'completed') break
    if (row) await db.updateBotDeletion(row.id, { nextTryAt: Date.now() })
    await tickBotDeletions(db)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const final = await db.botDeletion(first.id)
  const batches = await db.conversationAuditBatchesOfDeletion(first.id)
  const filterOptions = await db.conversationAuditFilterOptions(company.id)
  const filtered = await db.conversationAuditItems(company.id, {
    accountId: account.id,
    botId: bot.id,
    from: now - 2000,
    to: now + 2000,
  })
  out.筛选 = {
    日期员工Bot可组合: filtered.length === 1 && filtered[0].taskSummary === '筛选探针',
    删除Bot后选项仍在: filterOptions.bots.some((x) => x.id === bot.id && x.name === '已删除 Bot 快照'),
    员工名字来自快照: filterOptions.accounts.some((x) => x.id === account.id && x.name === '已离职员工快照'),
  }
  out.删除终审 = {
    未终审拒绝物理删除: blocked,
    重复请求幂等: pendingFirst.id === pendingSecond.id,
    无会话也有空终审: batches.length === 1 && batches[0].kind === 'pre_delete' && batches[0].status === 'empty',
    终审后才删除: final?.status === 'completed' && !(await db.catalog(bot.id)),
    审计批次删除后保留: (await db.conversationAuditBatchesOfDeletion(first.id)).length === 1,
  }

  console.log('__RESULT__' + JSON.stringify(out))
} finally {
  await db.dropSchema().catch(() => {})
  await db.close()
}
