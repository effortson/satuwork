/**
 * 计费明细：一次调用一行，看得见钱是怎么算出来的。
 *
 * 三个 `*-stats` 接口回答的是「这个月一共多少」，这里回答「为什么是这个数」——
 * 每行带着当时的计量、当时的单价、当时的倍率，乘出来就是金额。没有它，改过一次价
 * 之后就再也没人能复核历史账单了。
 *
 * **接口分页，不是前端切页。** 平台那四张长表是一次拉齐、前端切的（commit 06b4349），
 * 理由是「问题不在拉不动，在一屏塞不下」。账本不一样：一家公司一天就能产生几千行。
 */
import type { RouteCtx } from './ctx.ts'
import { HttpError, json, type Req, type Router } from '../http.ts'
import { rangeQuery, requireOrgUser, requireOwnerUser, requireUser } from '../lib/guards.ts'
import { bodyOf, intField, strField } from '../lib/validate.ts'
import { chargeCursorOf } from '../lib/org.ts'
import { CHARGE_PAGE_DEFAULT, CHARGE_PAGE_MAX, type Account, type ChargeKind, type ChargeStatus, type Company, type UsageCharge } from '../db.ts'

const KINDS: ChargeKind[] = ['llm', 'connector', 'web', 'kb']
const STATUSES: ChargeStatus[] = ['ok', 'failed', 'timeout', 'denied', 'error']

function kindOf(raw: string | null): ChargeKind | undefined {
  const v = (raw || '').trim()
  if (!v) return undefined
  if (!KINDS.includes(v as ChargeKind)) throw new HttpError(400, `kind 只能是 ${KINDS.join(' / ')}`)
  return v as ChargeKind
}

function statusOfQuery(raw: string | null): ChargeStatus | undefined {
  const v = (raw || '').trim()
  if (!v) return undefined
  if (!STATUSES.includes(v as ChargeStatus)) throw new HttpError(400, `status 只能是 ${STATUSES.join(' / ')}`)
  return v as ChargeStatus
}

function limitOf(raw: string | null): number {
  const v = (raw || '').trim()
  if (!v) return CHARGE_PAGE_DEFAULT
  const n = Math.trunc(Number(v))
  if (!Number.isFinite(n) || n < 1) throw new HttpError(400, 'limit 必须是正整数')
  return Math.min(n, CHARGE_PAGE_MAX)
}

/**
 * 一行的对外形状。
 *
 * **金额同时给微元和美元。** 微元是权威值（整数，能直接相加），美元是给人看的——
 * 让前端自己去跟浮点数较劲，各处的小数位就会各不相同（同 publicPlanSku 的处理）。
 *
 * **单价和倍率只给平台自己。** 它们合起来就是我们的成本价和加价率；客户那边要的是
 * 「用了多少、扣了多少」，中间怎么定价的不是他们的事。所以对非 owner 这两个字段
 * 整个不出现在响应里——只在界面上不画的话，翻开 devtools 就都在（docs/billing.md §9）。
 * 计量（`quantity`）和金额照给：那是他们自己的消耗和真扣掉的钱。
 */
export function publicCharge(
  v: UsageCharge,
  names?: { accounts: Map<string, Account>; companies: Map<string, Company> },
  opts?: { withPrice?: boolean },
) {
  const who = names?.accounts.get(v.accountId)
  const org = v.companyId ? names?.companies.get(v.companyId) : undefined
  return {
    id: v.id,
    createdAt: v.createdAt,
    companyId: v.companyId,
    companyName: v.companyId ? (org?.name ?? v.companyId) : '平台（系统管理员）',
    accountId: v.accountId,
    // 人可能已经离职，流水还在（留档要求）。那时按 id 显示，不装作查不到。
    accountName: who ? who.name || who.email : v.accountId,
    departed: Boolean(names && !who),
    botId: v.botId,
    sessionId: v.sessionId,
    kind: v.kind,
    subject: v.subject,
    status: v.status,
    quantity: v.quantity,
    // 展开而不是给 undefined：JSON.stringify 会丢掉 undefined 的键，但类型上
    // 「可能没有这个字段」比「值可能是 undefined」更贴近实际发出去的东西。
    ...(opts?.withPrice ? { unitPrice: v.unitPrice, multiplier: v.multiplier } : {}),
    amountMicros: v.amountMicros,
    amount: v.amountMicros / 1_000_000,
    bonusMicros: v.bonusMicros,
    /** 这一笔里由充值承担的部分。前端不用自己做减法，减错了没人看得出来。 */
    topupMicros: v.amountMicros - v.bonusMicros,
    unpriced: v.unpriced,
    /** 用量是估的（流在 usage 之前断了）。金额照扣，但明细上要能看出来。 */
    estimated: v.estimated,
    /** 平台人工改过 / 重算过：改之前的金额。null = 没改过。备注只给平台自己看。 */
    originalAmountMicros: v.originalAmountMicros,
    adjustedAt: v.adjustedAt,
    ...(opts?.withPrice ? { adjustNote: v.adjustNote } : {}),
    refId: v.refId,
  }
}

/** 一次重算最多碰多少行。超过就让人把范围缩小——悄悄只算一截，「应用」按下去就改了一半。 */
export const RECALC_MAX_ROWS = 5000
/** 预览里最多回多少行明细。汇总数照样是全量的。 */
const RECALC_PREVIEW_ROWS = 200
export const RECALC_NOTE = '按当前单价重算'

/** 请求体里的一个必填整数字段（intField 认数字和数字字符串，缺了回 undefined，这里补「必填」）。 */
function requiredInt(body: Record<string, unknown>, key: string, what: string): number {
  const n = intField(body, key)
  if (n == null) throw new HttpError(400, `${key} 不能为空（${what}）`)
  return n
}

export function attachCharges(router: Router, ctx: RouteCtx) {
  const { db, keys, meter, llm } = ctx

  /** 多取一条判断后面还有没有。静默截断比没有上限更糟：调用方会以为这就是全部。 */
  async function page(req: Req, filter: Parameters<typeof db.listUsageCharges>[0]) {
    const limit = limitOf(req.query.get('limit'))
    const rows = await db.listUsageCharges({ ...filter, limit: limit + 1, before: chargeCursorOf(req.query.get('cursor')) })
    const hasMore = rows.length > limit
    const list = hasMore ? rows.slice(0, limit) : rows
    const last = list[list.length - 1]
    return { list, limit, hasMore, nextCursor: hasMore && last ? `${last.createdAt}:${last.id}` : null }
  }

  router.get('/platform/charges', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    const companyId = (req.query.get('companyId') || '').trim()
    if (companyId && !(await db.company(companyId))) throw new HttpError(404, '公司不存在')
    const range = rangeQuery(req)
    const p = await page(req, {
      companyId: companyId || undefined,
      accountId: (req.query.get('accountId') || '').trim() || undefined,
      kind: kindOf(req.query.get('kind')),
      status: statusOfQuery(req.query.get('status')),
      from: range.from,
      to: range.to,
    })
    // 名字一次性查齐，不要每行两次。
    const names = {
      accounts: new Map((await db.accountsAll()).map((a) => [a.id, a])),
      companies: new Map((await db.companies()).map((c) => [c.id, c])),
    }
    json(res, 200, {
      charges: p.list.map((row) => publicCharge(row, names, { withPrice: true })),
      limit: p.limit,
      hasMore: p.hasMore,
      nextCursor: p.nextCursor,
    })
  })

  /**
   * **人工改一行的金额**（docs/billing.md §2.2）。只有 owner；改之前的金额留在行上，
   * 审计记一笔。改完这家公司的余额记忆作废，不然界面上的余额要等一秒才动。
   */
  router.put('/platform/charges/:id', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const body = bodyOf(req)
    // 美元那一格给人看，权威值是微元（同 publicCharge）。
    const amountMicros = requiredInt(body, 'amountMicros', '微元')
    if (amountMicros < 0) throw new HttpError(400, '金额不能是负数')
    const note = strField(body, 'note', false)
    const cur = await db.usageCharge(req.params.id)
    if (!cur) throw new HttpError(404, '没有这一行')
    const row = await db.tx(async () => {
      if (cur.companyId) await db.lockCompanyLedger(cur.companyId)
      // 人工定的金额就是金额：原来标着「算不出来」的，现在算得出来了。
      return db.adjustUsageCharge(cur.id, { amountMicros, by: account.id, note, unpriced: amountMicros > 0 ? false : cur.unpriced })
    })
    if (!row) throw new HttpError(404, '没有这一行')
    meter.forget(row.companyId)
    await db.audit({
      companyId: cur.companyId ?? 'platform',
      accountId: account.id,
      action: 'platform.charge.adjust',
      detail: { chargeId: row.id, subject: row.subject, fromMicros: cur.amountMicros, toMicros: row.amountMicros, note },
    })
    const names = {
      accounts: new Map((await db.accountsAll()).map((a) => [a.id, a])),
      companies: new Map((await db.companies()).map((c) => [c.id, c])),
    }
    json(res, 200, { charge: publicCharge(row, names, { withPrice: true }) })
  })

  /**
   * **按筛选（公司 × 时间 × 类型）重算一批行。** `apply` 不为 true 是预览：只算不改，回每一行
   * 会从多少变成多少；确认之后再带 `apply: true` 来一次，改的是那时再算一遍的结果（两次之间
   * 单价又改了的话，以第二次为准——预览只是给人看的）。
   *
   * 单价用现在的、倍率用行上的，见 meter.requote。查不到价的行跳过并数一笔 `skipped`；
   * **人工改过金额的行不碰**，数一笔 `manual`——客户投诉减半的那一行，不能被下个月一次批量
   * 重算悄悄改回去。重算自己改过的行（备注是 RECALC_NOTE）照常参与，再算一遍是幂等的。
   */
  router.post('/platform/charges/recalc', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const body = bodyOf(req)
    const companyId = strField(body, 'companyId', false)
    if (companyId && !(await db.company(companyId))) throw new HttpError(404, '公司不存在')
    const kind = kindOf(typeof body.kind === 'string' ? body.kind : null)
    if ((body.from == null || body.from === '') && (body.to == null || body.to === '')) throw new HttpError(400, '重算要给出 from / to，不能全时段')
    const from = requiredInt(body, 'from', 'unix 毫秒')
    const to = requiredInt(body, 'to', 'unix 毫秒')
    const apply = body.apply === true
    const picked = await db.usageChargesForRecalc({ companyId: companyId || undefined, kind, from, to }, RECALC_MAX_ROWS)
    if (picked.truncated) throw new HttpError(400, `这个范围超过 ${RECALC_MAX_ROWS} 行，请缩小时间范围或只选一家公司`)
    // 几千行共用这一份设置，别每行读一次库。
    const settings = await db.platformSettings()

    /** 同一个模型查一次目录就够了：一天几千行里模型就那几个。 */
    const costs = new Map<string, Promise<unknown>>()
    const costOf = (row: UsageCharge): Promise<unknown> => {
      const key = `${row.companyId ?? ''}|${row.subject}`
      let p = costs.get(key)
      if (!p) {
        p = llm.find(row.companyId, row.subject).then((m) => m?.cost)
        costs.set(key, p)
      }
      return p
    }

    const changes: { row: UsageCharge; after: { amountMicros: number; unitPrice: Record<string, number>; multiplier: number } }[] = []
    let skipped = 0
    let manual = 0
    let beforeMicros = 0
    let afterMicros = 0
    for (const row of picked.rows) {
      if (row.adjustedAt != null && row.adjustNote !== RECALC_NOTE) {
        manual++
        continue
      }
      const quote = await meter.requote(row, row.kind === 'llm' ? await costOf(row) : undefined, settings)
      if (!quote) {
        skipped++
        continue
      }
      beforeMicros += row.amountMicros
      afterMicros += quote.amountMicros
      if (quote.amountMicros === row.amountMicros) continue
      changes.push({ row, after: { amountMicros: quote.amountMicros, unitPrice: quote.unitPrice, multiplier: quote.multiplier } })
    }

    let applied = 0
    if (apply && changes.length) {
      /**
       * 按公司分组，一家一条事务：锁拿一次、UPDATE 批着发（db.adjustUsageChargesBulk）。
       * 一行一条事务的话几千行就是几千次锁和往返，Vercel 上一次请求跑不完还会停在半截。
       */
      const byCompany = new Map<string | null, typeof changes>()
      for (const c of changes) {
        const list = byCompany.get(c.row.companyId) ?? []
        list.push(c)
        byCompany.set(c.row.companyId, list)
      }
      for (const [cid, list] of byCompany) {
        applied += await db.tx(async () => {
          if (cid) await db.lockCompanyLedger(cid)
          return db.adjustUsageChargesBulk(
            list.map((c) => ({ id: c.row.id, amountMicros: c.after.amountMicros, unitPrice: c.after.unitPrice, multiplier: c.after.multiplier })),
            { by: account.id, note: RECALC_NOTE },
          )
        })
        meter.forget(cid)
      }
      await db.audit({
        companyId: companyId || 'platform',
        accountId: account.id,
        action: 'platform.charge.recalc',
        detail: { companyId: companyId || null, kind: kind ?? null, from, to, scanned: picked.rows.length, changed: applied, skipped, manual, beforeMicros, afterMicros },
      })
    }

    json(res, 200, {
      applied: apply,
      scanned: picked.rows.length,
      changed: apply ? applied : changes.length,
      skipped,
      /** 人工改过、没碰的行数。 */
      manual,
      beforeMicros,
      afterMicros,
      deltaMicros: afterMicros - beforeMicros,
      rows: changes.slice(0, RECALC_PREVIEW_ROWS).map((c) => ({
        id: c.row.id,
        createdAt: c.row.createdAt,
        companyId: c.row.companyId,
        subject: c.row.subject,
        kind: c.row.kind,
        beforeMicros: c.row.amountMicros,
        afterMicros: c.after.amountMicros,
      })),
      more: Math.max(0, changes.length - RECALC_PREVIEW_ROWS),
    })
  })

  router.get('/orgs/:id/charges', async (req, res) => {
    const account = await requireOrgUser(req, db, keys, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const range = rangeQuery(req)
    const p = await page(req, {
      companyId: company.id,
      accountId: (req.query.get('accountId') || '').trim() || undefined,
      botId: (req.query.get('botId') || '').trim() || undefined,
      kind: kindOf(req.query.get('kind')),
      status: statusOfQuery(req.query.get('status')),
      from: range.from,
      to: range.to,
    })
    const names = {
      accounts: new Map((await db.accountsOf(company.id)).map((a) => [a.id, a])),
      companies: new Map([[company.id, company]]),
    }
    json(res, 200, {
      charges: p.list.map((row) => publicCharge(row, names, { withPrice: account.role === 'owner' })),
      limit: p.limit,
      hasMore: p.hasMore,
      nextCursor: p.nextCursor,
      // 余额和已扣一起给：这一屏要回答的是「还剩多少、都花在哪了」，两个数分两次拉
      // 会在界面上短暂地互相矛盾。
      budget: await meter.budget(company.id),
    })
  })

  router.get('/me/charges', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const range = rangeQuery(req)
    const p = await page(req, {
      accountId: account.id,
      kind: kindOf(req.query.get('kind')),
      status: statusOfQuery(req.query.get('status')),
      from: range.from,
      to: range.to,
    })
    const companies = new Map<string, Company>()
    const own = account.companyId ? await db.company(account.companyId) : undefined
    if (own) companies.set(own.id, own)
    const names = { accounts: new Map([[account.id, account]]), companies }
    json(res, 200, {
      charges: p.list.map((row) => publicCharge(row, names, { withPrice: account.role === 'owner' })),
      limit: p.limit,
      hasMore: p.hasMore,
      nextCursor: p.nextCursor,
    })
  })
}
