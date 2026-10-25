/**
 * 套餐、价目表、订单、单独充值、账单。
 *
 * 订单要按当期套餐回写公司的席位和知识库上限（syncPlanFromOrders），那几处数公司、账号、
 * 知识库的走 `this.db`（见 DbCore.db）。
 */
import { randomUUID } from 'node:crypto'
import type { Invoice, Plan, PlanOrder, PlanPeriod, PlanSku, Topup } from './types.ts'
import { invoiceOf, num, planOf, planOrderOf, planSkuOf, topupOf } from './rows.ts'
import { DbCore } from './core.ts'

export class PlansDb extends DbCore {
  // ── 套餐 ──────────────────────────────────────────────────────────────

  /** 套餐、到期时间、知识库个数是可选补丁：不传就保持原样，传 null 才是清空。 */
  async upsertPlan(
    companyId: string,
    seats: number,
    patch: { skuId?: string | null; expiresAt?: number | null; knowledgeBases?: number } = {},
  ): Promise<Plan> {
    const now = Date.now()
    const cur = await this.plan(companyId)
    const next: Plan = {
      companyId,
      seats,
      knowledgeBases: patch.knowledgeBases === undefined ? (cur?.knowledgeBases ?? 0) : patch.knowledgeBases,
      skuId: patch.skuId === undefined ? (cur?.skuId ?? null) : patch.skuId,
      expiresAt: patch.expiresAt === undefined ? (cur?.expiresAt ?? null) : patch.expiresAt,
      updatedAt: now,
    }
    await this.run(
      'insert into plans ("companyId", seats, "knowledgeBases", "skuId", "expiresAt", "updatedAt") values (?,?,?,?,?,?) on conflict ("companyId") do update set seats=excluded.seats, "knowledgeBases"=excluded."knowledgeBases", "skuId"=excluded."skuId", "expiresAt"=excluded."expiresAt", "updatedAt"=excluded."updatedAt"',
      [companyId, next.seats, next.knowledgeBases, next.skuId, next.expiresAt, next.updatedAt],
    )
    return next
  }

  async plan(companyId: string): Promise<Plan | undefined> {
    const r = await this.one('select * from plans where "companyId" = ?', [companyId])
    return r ? planOf(r) : undefined
  }

  // ── 套餐 SKU（价目表）────────────────────────────────────────────────

  async planSkus(): Promise<PlanSku[]> {
    const rows = await this.many('select * from plan_skus order by "amountMils", "createdAt"')
    return rows.map(planSkuOf)
  }

  async planSku(id: string): Promise<PlanSku | undefined> {
    const r = await this.one('select * from plan_skus where id = ?', [id])
    return r ? planSkuOf(r) : undefined
  }

  /** 按名字找。中英两列都查——重名要挡的是「界面上看着一样」，不分哪一列。 */
  async planSkuByName(name: string): Promise<PlanSku | undefined> {
    const r = await this.one('select * from plan_skus where name = ? or ("nameEn" <> \'\' and "nameEn" = ?)', [name, name])
    return r ? planSkuOf(r) : undefined
  }

  async insertPlanSku(input: {
    name: string
    nameEn?: string
    amountMils: number
    seats: number
    period?: PlanPeriod
    bonusMils?: number
    knowledgeBases?: number
  }): Promise<PlanSku> {
    const now = Date.now()
    const row: PlanSku = {
      id: randomUUID(),
      name: input.name,
      nameEn: input.nameEn ?? '',
      amountMils: input.amountMils,
      seats: input.seats,
      period: input.period ?? 'month',
      bonusMils: input.bonusMils ?? 0,
      knowledgeBases: input.knowledgeBases ?? 0,
      createdAt: now,
      updatedAt: now,
    }
    await this.run(
      'insert into plan_skus (id, name, "nameEn", "amountMils", seats, period, "bonusMils", "knowledgeBases", "createdAt", "updatedAt") values (?,?,?,?,?,?,?,?,?,?)',
      [row.id, row.name, row.nameEn, row.amountMils, row.seats, row.period, row.bonusMils, row.knowledgeBases, row.createdAt, row.updatedAt],
    )
    return row
  }

  /** 只改传进来的字段。套餐不存在返回 undefined，由上层决定报 404 还是别的。 */
  async updatePlanSku(
    id: string,
    patch: { name?: string; nameEn?: string; amountMils?: number; seats?: number; period?: PlanPeriod; bonusMils?: number; knowledgeBases?: number },
  ): Promise<PlanSku | undefined> {
    const cur = await this.planSku(id)
    if (!cur) return undefined
    const r = await this.one(
      'update plan_skus set name=?, "nameEn"=?, "amountMils"=?, seats=?, period=?, "bonusMils"=?, "knowledgeBases"=?, "updatedAt"=? where id=? returning *',
      [
        patch.name ?? cur.name,
        patch.nameEn ?? cur.nameEn,
        patch.amountMils ?? cur.amountMils,
        patch.seats ?? cur.seats,
        patch.period ?? cur.period,
        patch.bonusMils ?? cur.bonusMils,
        patch.knowledgeBases ?? cur.knowledgeBases,
        Date.now(),
        id,
      ],
    )
    return r ? planSkuOf(r) : undefined
  }

  // ── 订单 ──────────────────────────────────────────────────────────────

  async planOrders(): Promise<PlanOrder[]> {
    const rows = await this.many('select * from plan_orders order by "startAt" desc, "createdAt" desc')
    return rows.map(planOrderOf)
  }

  async planOrder(id: string): Promise<PlanOrder | undefined> {
    const r = await this.one('select * from plan_orders where id = ?', [id])
    return r ? planOrderOf(r) : undefined
  }

  async insertPlanOrder(input: Omit<PlanOrder, 'id' | 'createdAt' | 'updatedAt'>): Promise<PlanOrder> {
    const now = Date.now()
    const row: PlanOrder = { ...input, id: randomUUID(), createdAt: now, updatedAt: now }
    await this.run(
      `insert into plan_orders
       (id, "companyId", kind, note, "planId", "planName", "planNameEn", period, seats, "knowledgeBases", "amountMils", "bonusMils", "startAt", "endAt", "payStatus", "createdAt", "updatedAt")
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        row.id, row.companyId, row.kind, row.note, row.planId, row.planName, row.planNameEn, row.period,
        row.seats, row.knowledgeBases, row.amountMils, row.bonusMils, row.startAt, row.endAt, row.payStatus, row.createdAt, row.updatedAt,
      ],
    )
    return row
  }

  /** 只改传进来的字段。订单不存在返回 undefined。 */
  async updatePlanOrder(id: string, patch: Partial<Omit<PlanOrder, 'id' | 'createdAt'>>): Promise<PlanOrder | undefined> {
    const cur = await this.planOrder(id)
    if (!cur) return undefined
    const next = { ...cur, ...patch, updatedAt: Date.now() }
    const r = await this.one(
      `update plan_orders set "companyId"=?, kind=?, note=?, "planId"=?, "planName"=?, "planNameEn"=?, period=?,
       seats=?, "knowledgeBases"=?, "amountMils"=?, "bonusMils"=?, "startAt"=?, "endAt"=?, "payStatus"=?, "updatedAt"=? where id=? returning *`,
      [
        next.companyId, next.kind, next.note, next.planId, next.planName, next.planNameEn, next.period,
        next.seats, next.knowledgeBases, next.amountMils, next.bonusMils, next.startAt, next.endAt, next.payStatus, next.updatedAt, id,
      ],
    )
    return r ? planOrderOf(r) : undefined
  }

  /**
   * 此刻生效的那条**套餐**订单：已付款、开始时间已到、结束时间未过。充值单不参与订阅。
   * 未付款的订单只是一张待收的账单，不算订阅——钱没到就别开服务。
   * 有重叠就取开始得最晚的一条——续约提前下单时，新订单一生效就顶掉旧的。
   */
  async activePaidOrder(companyId: string, at = Date.now()): Promise<PlanOrder | undefined> {
    const r = await this.one(
      `select * from plan_orders
       where "companyId" = ? and kind = 'plan' and "payStatus" = 'paid' and "startAt" <= ? and "endAt" > ?
       order by "startAt" desc limit 1`,
      [companyId, at, at],
    )
    return r ? planOrderOf(r) : undefined
  }

  /**
   * 把公司的订阅拉齐到订单：**已付款且在期内**的那条订单说了算，没有就把套餐清掉。
   * 未付款的订单只是一张待收的账单，不写订阅。
   * 席位不缩到已有账号数以下——订单少给了席位也不能把人挤掉，先按现有人数保住。
   *
   * 「清掉」也包括席位：订单给的席位跟订单一起走，到期后只按现有人数保住，不能让一份
   * 过期订阅把席位永远留在那里。但平台管理员可以不经订单直接给席位（skuId 本来就是空），
   * 那不是订单算出来的，这里不动。
   *
   * 下单/改单之后调它；起进程时也对一遍全量，把「订单到期了没人碰」和历史规则留下的
   * 脏值收干净——plans 里那几列是订单算出来的结果，不是另一份可以自己漂的真相。
   */
  async syncPlanFromOrders(companyId: string): Promise<void> {
    const active = await this.activePaidOrder(companyId)
    const used = await this.db.accountCount(companyId)
    // 知识库和席位同一条规矩：订单给的个数不缩到已有库数以下——已经建好的库不能因为
    // 一张单子少给了就凭空超额，先按现有个数保住（docs/knowledge-base.md §4.2）。
    const kbUsed = await this.db.countKnowledgeBases(companyId)
    const cur = await this.plan(companyId)
    if (!active) {
      if (cur?.skuId == null && cur?.expiresAt == null && cur) return
      const seats = cur?.skuId != null ? Math.max(used, 1) : (cur?.seats ?? Math.max(used, 1))
      const knowledgeBases = cur?.skuId != null ? kbUsed : (cur?.knowledgeBases ?? kbUsed)
      await this.upsertPlan(companyId, seats, { skuId: null, expiresAt: null, knowledgeBases })
      return
    }
    await this.upsertPlan(companyId, Math.max(active.seats, used), {
      skuId: active.planId,
      expiresAt: active.endAt,
      knowledgeBases: Math.max(active.knowledgeBases, kbUsed),
    })
  }

  /** 起进程时对一遍所有公司的订阅。返回被改动的公司数，只为在日志里说一声。 */
  async syncAllPlansFromOrders(): Promise<number> {
    let changed = 0
    for (const c of await this.db.companies()) {
      const before = await this.plan(c.id)
      await this.syncPlanFromOrders(c.id)
      const after = await this.plan(c.id)
      if (before?.skuId !== after?.skuId || before?.expiresAt !== after?.expiresAt || before?.seats !== after?.seats || before?.knowledgeBases !== after?.knowledgeBases) changed++
    }
    return changed
  }

  // ── 单独充值 ──────────────────────────────────────────────────────────

  async topups(): Promise<Topup[]> {
    const rows = await this.many('select * from topups order by "createdAt" desc')
    return rows.map(topupOf)
  }

  async topupsOfCompany(companyId: string): Promise<Topup[]> {
    const rows = await this.many('select * from topups where "companyId" = ? order by "createdAt" desc', [companyId])
    return rows.map(topupOf)
  }

  /** 充值总额。充值不过期，所以是从头累加，不按时间窗口切。 */
  async topupTotal(companyId: string): Promise<number> {
    const r = await this.one('select coalesce(sum("amountMils"), 0) as total from topups where "companyId" = ?', [companyId])
    return num(r?.total)
  }

  async topupByOrder(orderId: string): Promise<Topup | undefined> {
    const r = await this.one('select * from topups where "orderId" = ?', [orderId])
    return r ? topupOf(r) : undefined
  }

  async insertTopup(input: {
    companyId: string
    amountMils: number
    orderId?: string | null
    note?: string
    createdBy?: string | null
  }): Promise<Topup> {
    const row: Topup = {
      id: randomUUID(),
      companyId: input.companyId,
      orderId: input.orderId ?? null,
      amountMils: input.amountMils,
      note: input.note ?? '',
      createdBy: input.createdBy ?? null,
      createdAt: Date.now(),
    }
    await this.run(
      'insert into topups (id, "companyId", "orderId", "amountMils", note, "createdBy", "createdAt") values (?,?,?,?,?,?,?)',
      [row.id, row.companyId, row.orderId, row.amountMils, row.note, row.createdBy, row.createdAt],
    )
    return row
  }

  async updateTopup(id: string, patch: Partial<Pick<Topup, 'companyId' | 'amountMils' | 'note'>>): Promise<Topup | undefined> {
    const cur = await this.one('select * from topups where id = ?', [id])
    if (!cur) return undefined
    const next = { ...topupOf(cur), ...patch }
    const r = await this.one(
      'update topups set "companyId"=?, "amountMils"=?, note=? where id=? returning *',
      [next.companyId, next.amountMils, next.note, id],
    )
    return r ? topupOf(r) : undefined
  }

  /** 充值单退回未付款时，把开出去的那条充值记录撤掉——余额跟着掉回去。 */
  async deleteTopup(id: string): Promise<void> {
    await this.run('delete from topups where id = ?', [id])
  }

  // ── 账单 ──────────────────────────────────────────────────────────────

  async invoicesOfCompany(companyId: string): Promise<Invoice[]> {
    const rows = await this.many('select * from invoices where "companyId" = ? order by "periodStart" desc', [companyId])
    return rows.map(invoiceOf)
  }

  async invoiceByOrder(orderId: string): Promise<Invoice | undefined> {
    const r = await this.one('select * from invoices where "orderId" = ?', [orderId])
    return r ? invoiceOf(r) : undefined
  }

  async insertInvoice(input: Omit<Invoice, 'id' | 'createdAt' | 'updatedAt'>): Promise<Invoice> {
    const now = Date.now()
    const row: Invoice = { ...input, id: randomUUID(), createdAt: now, updatedAt: now }
    await this.run(
      `insert into invoices
       (id, "companyId", "orderId", "planName", "planNameEn", "amountMils", "periodStart", "periodEnd", status, "paidAt", "createdAt", "updatedAt")
       values (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        row.id, row.companyId, row.orderId, row.planName, row.planNameEn, row.amountMils,
        row.periodStart, row.periodEnd, row.status, row.paidAt, row.createdAt, row.updatedAt,
      ],
    )
    return row
  }

  async updateInvoice(id: string, patch: Partial<Omit<Invoice, 'id' | 'createdAt'>>): Promise<Invoice | undefined> {
    const cur = await this.one('select * from invoices where id = ?', [id])
    if (!cur) return undefined
    const next = { ...invoiceOf(cur), ...patch, updatedAt: Date.now() }
    const r = await this.one(
      `update invoices set "companyId"=?, "orderId"=?, "planName"=?, "planNameEn"=?, "amountMils"=?,
       "periodStart"=?, "periodEnd"=?, status=?, "paidAt"=?, "updatedAt"=? where id=? returning *`,
      [
        next.companyId, next.orderId, next.planName, next.planNameEn, next.amountMils,
        next.periodStart, next.periodEnd, next.status, next.paidAt, next.updatedAt, id,
      ],
    )
    return r ? invoiceOf(r) : undefined
  }
}
