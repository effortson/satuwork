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
    refId: v.refId,
  }
}

export function attachCharges(router: Router, ctx: RouteCtx) {
  const { db, keys, meter } = ctx

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
