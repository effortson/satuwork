/**
 * 套餐、订单、账单、充值：额度口径与对外序列化。
 *
 * 从 routes.ts 拆出来的——那个文件曾经是 5700 行，前 1900 行全是这类帮手。
 */
import { HttpError } from '../http.ts'
import { type Account, type Company, type Db, type Invoice, type OrderKind, type PlanOrder, type PlanSku, type Topup } from '../db.ts'

/**
 * 公司的两笔额度，分开算，永远不合并成一个数：
 *
 * - **套餐赠送**：来自当前生效（已付款且在期内）的那条订单，有效期跟着套餐走。
 *   套餐一到期就没有生效订单了，这个数当场归零——没用完也不结转。
 * - **单独充值**：`topups` 累加，不过期，用完为止。
 *
 * **这里报的是「发下去多少」，不是「还剩多少」。** 消耗在账本上（`usage_charges`），
 * 由 `lib/meter.ts` 的 `budget()` 拿这两个数减去各自桶里已经花掉的部分。
 * 分成两步是因为这两个数的变化频率差着几个数量级：发多少只有平台管理员动手时才变，
 * 花多少每次调用都在动。
 */
export async function balanceOf(db: Db, companyId: string) {
  const active = await db.activePaidOrder(companyId)
  return {
    // 套餐赠送：跟着套餐有效期，到期清零。
    planBonusMils: active?.bonusMils ?? 0,
    planBonusExpiresAt: active?.endAt ?? null,
    /**
     * 当前账期的起点。null = 没有生效的套餐。
     *
     * 算「赠送还剩多少」必须有它：赠送只被**本账期内**的消耗吃掉，上一期花掉的那部分
     * 跟着套餐一起作废，不能再扣一遍。
     */
    planBonusStartAt: active?.startAt ?? null,
    // 充值：不过期。
    topupMils: await db.topupTotal(companyId),
  }
}

export function publicTopup(v: Topup, company?: Company, by?: Account) {
  return {
    id: v.id,
    companyId: v.companyId,
    company: company ? { id: company.id, name: company.name, slug: company.slug } : null,
    amount: v.amountMils / 1000,
    amountMils: v.amountMils,
    note: v.note,
    createdBy: v.createdBy,
    createdByName: by ? by.name || by.email : null,
    createdAt: v.createdAt,
  }
}

export function orderKindOf(v: unknown, fallback: OrderKind = 'plan'): OrderKind {
  if (v == null || v === '') return fallback
  if (v !== 'plan' && v !== 'topup') throw new HttpError(400, '订单类型只能是 plan 或 topup')
  return v
}

/**
 * 充值单 → 充值记录。**只有付了款才开记录**，余额也只认记录：
 * 未付款的充值单退回来什么都没有；已付款再改回未付款，记录撤掉，余额跟着掉回去。
 */
export async function syncTopupOfOrder(db: Db, order: PlanOrder, actorId: string): Promise<Topup | undefined> {
  const cur = await db.topupByOrder(order.id)
  if (order.payStatus !== 'paid') {
    if (cur) await db.deleteTopup(cur.id)
    return undefined
  }
  if (!cur) {
    return db.insertTopup({
      companyId: order.companyId,
      orderId: order.id,
      amountMils: order.amountMils,
      note: order.note,
      createdBy: actorId,
    })
  }
  return db.updateTopup(cur.id, { companyId: order.companyId, amountMils: order.amountMils, note: order.note })
}

/** 一条订单一张账单。改订单是改这张，不是再开一张。 */
export async function syncInvoiceOfOrder(db: Db, order: PlanOrder): Promise<Invoice> {
  const fields = {
    companyId: order.companyId,
    orderId: order.id,
    planName: order.planName,
    planNameEn: order.planNameEn,
    amountMils: order.amountMils,
    periodStart: order.startAt,
    periodEnd: order.endAt,
    status: order.payStatus,
    paidAt: order.payStatus === 'paid' ? Date.now() : null,
  }
  const cur = await db.invoiceByOrder(order.id)
  if (!cur) return db.insertInvoice(fields)
  // 已经付过的不重盖付款时间，否则每改一次订单，付款时间就往后跳一次。
  return (await db.updateInvoice(cur.id, {
    ...fields,
    paidAt: order.payStatus === 'paid' ? (cur.paidAt ?? Date.now()) : null,
  }))!
}

export function publicInvoice(v: Invoice) {
  return {
    id: v.id,
    orderId: v.orderId,
    planName: v.planName,
    planNameEn: v.planNameEn,
    amount: v.amountMils / 1000,
    amountMils: v.amountMils,
    periodStart: v.periodStart,
    periodEnd: v.periodEnd,
    status: v.status,
    paidAt: v.paidAt,
    createdAt: v.createdAt,
  }
}

export function publicPlanOrder(o: PlanOrder, company?: Company) {
  return {
    id: o.id,
    companyId: o.companyId,
    company: company ? { id: company.id, name: company.name, slug: company.slug } : null,
    kind: o.kind,
    note: o.note,
    planId: o.planId,
    planName: o.planName,
    planNameEn: o.planNameEn,
    period: o.period,
    seats: o.seats,
    knowledgeBases: o.knowledgeBases,
    amount: o.amountMils / 1000,
    amountMils: o.amountMils,
    bonus: o.bonusMils / 1000,
    bonusMils: o.bonusMils,
    startAt: o.startAt,
    endAt: o.endAt,
    payStatus: o.payStatus,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  }
}

export function publicPlanSku(p: PlanSku) {
  return {
    id: p.id,
    name: p.name,
    nameEn: p.nameEn,
    // 两个都给：amount 是美元、给人看，amountMils 是权威值（整数厘），
    // 前端拿它来格式化，不用自己跟浮点数较劲。
    amount: p.amountMils / 1000,
    amountMils: p.amountMils,
    seats: p.seats,
    knowledgeBases: p.knowledgeBases,
    period: p.period,
    bonus: p.bonusMils / 1000,
    bonusMils: p.bonusMils,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }
}
