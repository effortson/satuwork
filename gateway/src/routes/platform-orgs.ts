/**
 * 平台侧的公司、账号、套餐价目、订单与充值。owner-only。
 */
import type { RouteCtx } from './ctx.ts'
import { HttpError, json, type Router } from '../http.ts'
import { MIN_PASSWORD, hashPassword } from '../crypto.ts'
import { amountMilsOf, bodyOf, bonusMilsOf, dateMsOf, endOfPeriod, knowledgeBasesOf, payStatusOf, periodOf, seatsOf, strField } from '../lib/validate.ts'
import { balanceOf, orderKindOf, publicInvoice, publicPlanOrder, publicPlanSku, publicTopup, syncInvoiceOfOrder, syncTopupOfOrder } from '../lib/billing.ts'
import { emailOf, expiresAtOf, orgSummary, patchAccount, phoneOf, publicAccount, publicCompany, publicPlan, slugOf, websiteOf } from '../lib/org.ts'
import { requireOrgUser, requireOwnerUser } from '../lib/guards.ts'
import { type PlanSku } from '../db.ts'

export function attachPlatformOrgs(router: Router, ctx: RouteCtx) {
  const { db, keys, meter } = ctx

  router.get('/platform/orgs', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    const kbCounts = await db.knowledgeCountsByCompany()
    json(res, 200, { orgs: await Promise.all((await db.companies()).map((c) => orgSummary(db, c, kbCounts))) })
  })

  router.get('/platform/accounts', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    const companies = new Map((await db.companies()).map((c) => [c.id, c]))
    json(res, 200, {
      accounts: (await db.accountsAll()).map((a) => {
        const company = a.companyId ? companies.get(a.companyId) : undefined
        return {
          ...publicAccount(a),
          company: company ? { id: company.id, name: company.name, slug: company.slug } : null,
        }
      }),
    })
  })

  router.get('/platform/accounts/:id', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    const row = await db.account(req.params.id)
    if (!row) throw new HttpError(404, '账号不存在')
    const company = row.companyId ? await db.company(row.companyId) : undefined
    const secrets = row.role === 'owner' ? undefined : await db.accountSecrets(row.id)
    json(res, 200, {
      account: publicAccount(row),
      company: company ? { id: company.id, name: company.name, slug: company.slug } : null,
      apiKey: secrets?.apiKey ?? null,
      accessToken: secrets?.accessToken ?? null,
    })
  })

  /**
   * 改一个账号的状态（以及名字 / 角色）。「用户」那一页上那颗「停用 / 启用」按的就是它。
   *
   * 为什么平台这一层要单独有一条：公司侧那条挂在 `/orgs/:id/accounts/:accountId` 上，
   * 拿不到**不属于任何公司**的平台账号；而这一页列的恰恰是所有人，包括那几个。
   *
   * 规矩一条都没重写，全在 `patchAccount` 里和公司侧共用——「不能改自己」「待接受不能
   * 被直接激活」「至少留一个管理员」「重新激活要占席位」在两条路上必须是同一份，抄成
   * 两份的那天起它们就开始各自漂移。
   */
  router.patch('/platform/accounts/:id', async (req, res) => {
    const actor = await requireOwnerUser(req, db, keys)
    const row = await db.account(req.params.id)
    if (!row) throw new HttpError(404, '账号不存在')
    const { account, patch } = await patchAccount(db, actor, row, bodyOf(req))
    await db.audit({
      // 平台账号不属于任何公司，那一条就记在平台名下（同 bot-release.upload 那几条）。
      companyId: row.companyId ?? '',
      accountId: actor.id,
      action: 'account.update',
      detail: { id: row.id, name: patch.name, role: patch.role, status: patch.status, from: 'platform' },
    })
    json(res, 200, { account: publicAccount(account) })
  })

  router.post('/platform/orgs', async (req, res) => {
    const actor = await requireOwnerUser(req, db, keys)
    const body = bodyOf(req)
    const name = strField(body, 'name')
    const slug = slugOf(strField(body, 'slug'))
    const contactName = strField(body, 'contactName')
    const contactPhone = phoneOf(strField(body, 'contactPhone'))
    const contactEmail = emailOf(strField(body, 'contactEmail'))
    const address = strField(body, 'address', false)
    const website = websiteOf(strField(body, 'website', false))
    const adminEmail = emailOf(strField(body, 'adminEmail'))
    const adminPassword = strField(body, 'adminPassword')
    if (adminPassword.length < MIN_PASSWORD) throw new HttpError(400, `口令至少 ${MIN_PASSWORD} 位`)
    if (await db.accountByEmail(adminEmail)) throw new HttpError(409, '这个邮箱已经注册')
    if (await db.companyBySlug(slug)) throw new HttpError(409, '这个 slug 已被占用')
    const passwordHash = await hashPassword(adminPassword)
    // 建公司只开管理员这一个席位；加席位走 `PUT /platform/orgs/:id/plan`（公司详情页的订阅）。
    const seats = 1
    const created = await db.tx(async () => {
      const company = await db.insertCompany({ slug, name, contactName, contactPhone, contactEmail, address, website })
      await db.upsertPlan(company.id, seats)
      const admin = await db.insertAccount({ companyId: company.id, email: adminEmail, passwordHash, role: 'admin' })
      await db.audit({
        companyId: company.id,
        accountId: actor.id,
        action: 'platform.org.create',
        detail: { slug, contactName, contactEmail, adminEmail },
      })
      return { company, admin }
    })
    json(res, 201, { company: publicCompany(created.company), account: publicAccount(created.admin), plan: { seats, used: 1 } })
  })

  router.put('/platform/orgs/:id/plan', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    if (!await db.company(req.params.id)) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    const cur = await db.plan(req.params.id)
    // 选了套餐但没写席位，就按套餐的席位数来——价目表里那个数就是卖出去的席位。
    let sku
    if (body.skuId !== undefined && body.skuId !== null && body.skuId !== '') {
      sku = await db.planSku(strField(body, 'skuId'))
      if (!sku) throw new HttpError(404, '套餐不存在')
    }
    const seats = body.seats == null || body.seats === '' ? (sku?.seats ?? cur?.seats ?? 1) : seatsOf(body.seats)
    const used = await db.accountCount(req.params.id)
    if (seats < used) throw new HttpError(409, '席位不能少于已有账号数', { seats, used })
    // 知识库个数同席位：选了套餐没写就按套餐的；往下调要先腾位（docs/knowledge-base.md §4.2）。
    const knowledgeBases = body.knowledgeBases == null || body.knowledgeBases === ''
      ? (sku?.knowledgeBases ?? cur?.knowledgeBases ?? 0)
      : knowledgeBasesOf(body.knowledgeBases)
    const kbUsed = await db.countKnowledgeBases(req.params.id)
    if (knowledgeBases < kbUsed) throw new HttpError(409, `知识库个数不能少于已有的 ${kbUsed} 个`, { knowledgeBases, used: kbUsed })
    const patch: { skuId?: string | null; expiresAt?: number | null; knowledgeBases: number } = { knowledgeBases }
    if (body.skuId !== undefined) patch.skuId = sku ? sku.id : null
    if (body.expiresAt !== undefined) patch.expiresAt = expiresAtOf(body.expiresAt)
    const plan = await db.upsertPlan(req.params.id, seats, patch)
    await db.audit({
      companyId: req.params.id,
      accountId: account.id,
      action: 'plan.update',
      detail: { seats, knowledgeBases, skuId: plan.skuId, expiresAt: plan.expiresAt },
    })
    json(res, 200, await publicPlan(db, plan, used))
  })

  /**
   * 套餐 SKU（价目表）。只有 owner 能动。
   * 注意跟 `PUT /platform/orgs/:id/plan` 分清：那条改的是某家公司的席位额度，
   * 这里改的是「卖什么」，改价不会动已经开出去的公司席位。
   */
  router.get('/platform/plans', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    json(res, 200, { plans: (await db.planSkus()).map(publicPlanSku) })
  })

  router.get('/platform/plans/:id', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    const plan = await db.planSku(req.params.id)
    if (!plan) throw new HttpError(404, '套餐不存在')
    json(res, 200, { plan: publicPlanSku(plan) })
  })

  router.post('/platform/plans', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const body = bodyOf(req)
    const name = strField(body, 'name')
    // 英文名选填：留空的话英文界面回落到中文名，总比显示空白强。
    const nameEn = strField(body, 'nameEn', false)
    const amountMils = amountMilsOf(body.amount)
    const seats = seatsOf(body.seats)
    const period = periodOf(body.period)
    const bonusMils = bonusMilsOf(body.bonusTokens)
    const knowledgeBases = knowledgeBasesOf(body.knowledgeBases)
    if (await db.planSkuByName(name)) throw new HttpError(409, '这个套餐名已存在')
    if (nameEn && await db.planSkuByName(nameEn)) throw new HttpError(409, '这个套餐名已存在')
    const plan = await db.insertPlanSku({ name, nameEn, amountMils, seats, period, bonusMils, knowledgeBases })
    await db.audit({
      companyId: 'platform',
      accountId: account.id,
      action: 'platform.plan.create',
      detail: { id: plan.id, name, nameEn, amountMils, seats, period, bonusMils, knowledgeBases },
    })
    json(res, 201, { plan: publicPlanSku(plan) })
  })

  router.put('/platform/plans/:id', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const cur = await db.planSku(req.params.id)
    if (!cur) throw new HttpError(404, '套餐不存在')
    const body = bodyOf(req)
    const name = 'name' in body ? strField(body, 'name') : cur.name
    const nameEn = 'nameEn' in body ? strField(body, 'nameEn', false) : cur.nameEn
    const amountMils = 'amount' in body ? amountMilsOf(body.amount, cur.amountMils) : cur.amountMils
    const seats = 'seats' in body ? seatsOf(body.seats, cur.seats) : cur.seats
    const period = 'period' in body ? periodOf(body.period, cur.period) : cur.period
    const bonusMils = 'bonusTokens' in body ? bonusMilsOf(body.bonusTokens, cur.bonusMils) : cur.bonusMils
    const knowledgeBases = 'knowledgeBases' in body ? knowledgeBasesOf(body.knowledgeBases, cur.knowledgeBases) : cur.knowledgeBases
    if (name !== cur.name) {
      const clash = await db.planSkuByName(name)
      if (clash && clash.id !== cur.id) throw new HttpError(409, '这个套餐名已存在')
    }
    if (nameEn && nameEn !== cur.nameEn) {
      const clash = await db.planSkuByName(nameEn)
      if (clash && clash.id !== cur.id) throw new HttpError(409, '这个套餐名已存在')
    }
    if (nameEn && nameEn === name) throw new HttpError(400, '中英文名不能填成同一个')
    const plan = await db.updatePlanSku(cur.id, { name, nameEn, amountMils, seats, period, bonusMils, knowledgeBases })
    if (!plan) throw new HttpError(404, '套餐不存在')
    await db.audit({
      companyId: 'platform',
      accountId: account.id,
      action: 'platform.plan.update',
      detail: { id: plan.id, name, nameEn, amountMils, seats, period, bonusMils, knowledgeBases },
    })
    json(res, 200, { plan: publicPlanSku(plan) })
  })

  /**
   * 订单：某公司订阅某套餐。owner 专属。
   * 下单时把套餐内容抄一份进订单——之后改价目表不会改写已经开出去的订单。
   */
  router.get('/platform/orders', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    const companies = new Map((await db.companies()).map((c) => [c.id, c]))
    json(res, 200, { orders: (await db.planOrders()).map((o) => publicPlanOrder(o, companies.get(o.companyId))) })
  })

  router.get('/platform/orders/:id', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    const order = await db.planOrder(req.params.id)
    if (!order) throw new HttpError(404, '订单不存在')
    json(res, 200, { order: publicPlanOrder(order, await db.company(order.companyId)) })
  })

  router.post('/platform/orders', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const body = bodyOf(req)
    const company = await db.company(strField(body, 'companyId'))
    if (!company) throw new HttpError(404, '公司不存在')
    // 充值单：只有金额和备注。付了款才开充值记录，余额也是那时候才涨。
    if (orderKindOf(body.kind) === 'topup') {
      const amountMils = amountMilsOf(body.amount)
      if (amountMils <= 0) throw new HttpError(400, '充值金额必须大于 0')
      const note = strField(body, 'note', false)
      const startAt = dateMsOf(body.startAt, Date.now())
      const payStatus = payStatusOf(body.payStatus)
      const { order, topup } = await db.tx(async () => {
        const order = await db.insertPlanOrder({
          companyId: company.id,
          kind: 'topup',
          note,
          planId: null,
          planName: '充值',
          planNameEn: 'Top-up',
          period: 'month',
          // 充值没有席位、没有赠送、也没有账期：起止同一天，别装成一段订阅。
          seats: 0,
          knowledgeBases: 0,
          amountMils,
          bonusMils: 0,
          startAt,
          endAt: startAt,
          payStatus,
        })
        return { order, topup: await syncTopupOfOrder(db, order, account.id) }
      })
      await db.audit({
        companyId: company.id,
        accountId: account.id,
        action: 'platform.order.create',
        detail: { id: order.id, kind: 'topup', amountMils, note, payStatus },
      })
      // 余额变了。不作废记忆的话，刚充完钱的公司还要被熔断一会儿——而那一会儿正是
      // 有人盯着屏幕等它恢复的时候。
      meter.forget(company.id)
      json(res, 201, {
        order: publicPlanOrder(order, company),
        topup: topup ? publicTopup(topup, company, account) : null,
        balance: await balanceOf(db, company.id),
      })
      return
    }
    const sku = await db.planSku(strField(body, 'planId'))
    if (!sku) throw new HttpError(404, '套餐不存在')
    // 套餐内容作为默认值抄进订单，但允许逐项改（打折、送席位都靠这个）。
    const period = 'period' in body ? periodOf(body.period, sku.period) : sku.period
    const seats = 'seats' in body ? seatsOf(body.seats, sku.seats) : sku.seats
    const knowledgeBases = 'knowledgeBases' in body ? knowledgeBasesOf(body.knowledgeBases, sku.knowledgeBases) : sku.knowledgeBases
    const amountMils = 'amount' in body ? amountMilsOf(body.amount, sku.amountMils) : sku.amountMils
    const bonusMils = 'bonusTokens' in body ? bonusMilsOf(body.bonusTokens, sku.bonusMils) : sku.bonusMils
    const startAt = dateMsOf(body.startAt, Date.now())
    const endAt = 'endAt' in body && body.endAt ? dateMsOf(body.endAt) : endOfPeriod(startAt, period)
    if (endAt <= startAt) throw new HttpError(400, '结束时间必须晚于开始时间')
    const payStatus = payStatusOf(body.payStatus)
    // 订单 + 账单一起落：账单开不出来就不该留下一条孤零零的订单。
    // 订阅要等付款——未付款时 syncPlanFromOrders 找不到已付款的生效订单，什么都不会写。
    const { order, invoice } = await db.tx(async () => {
      const order = await db.insertPlanOrder({
        companyId: company.id,
        kind: 'plan',
        note: '',
        planId: sku.id,
        planName: sku.name,
        planNameEn: sku.nameEn,
        period,
        seats,
        knowledgeBases,
        amountMils,
        bonusMils,
        startAt,
        endAt,
        payStatus,
      })
      const invoice = await syncInvoiceOfOrder(db, order)
      await db.syncPlanFromOrders(company.id)
      return { order, invoice }
    })
    await db.audit({
      companyId: company.id,
      accountId: account.id,
      action: 'platform.order.create',
      detail: { id: order.id, planId: sku.id, planName: sku.name, period, seats, knowledgeBases, amountMils, bonusMils, payStatus },
    })
    meter.forget(company.id)
    json(res, 201, { order: publicPlanOrder(order, company), invoice: publicInvoice(invoice) })
  })

  router.put('/platform/orders/:id', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const cur = await db.planOrder(req.params.id)
    if (!cur) throw new HttpError(404, '订单不存在')
    const body = bodyOf(req)
    const company = 'companyId' in body ? await db.company(strField(body, 'companyId')) : await db.company(cur.companyId)
    if (!company) throw new HttpError(404, '公司不存在')
    // 单据类型不给改：套餐单背后挂着账单，充值单背后挂着充值记录，改类型等于换一张单子。
    if ('kind' in body && orderKindOf(body.kind) !== cur.kind) throw new HttpError(400, '订单类型不能改，请另开一单')
    if (cur.kind === 'topup') {
      const amountMils = 'amount' in body ? amountMilsOf(body.amount, cur.amountMils) : cur.amountMils
      if (amountMils <= 0) throw new HttpError(400, '充值金额必须大于 0')
      const note = 'note' in body ? strField(body, 'note', false) : cur.note
      const startAt = 'startAt' in body ? dateMsOf(body.startAt, cur.startAt) : cur.startAt
      const payStatus = payStatusOf(body.payStatus, cur.payStatus)
      const { order, topup } = await db.tx(async () => {
        const order = await db.updatePlanOrder(cur.id, {
          companyId: company.id, note, amountMils, startAt, endAt: startAt, payStatus,
        })
        if (!order) throw new HttpError(404, '订单不存在')
        return { order, topup: await syncTopupOfOrder(db, order, account.id) }
      })
      await db.audit({
        companyId: company.id,
        accountId: account.id,
        action: 'platform.order.update',
        detail: { id: order.id, kind: 'topup', amountMils, note, payStatus },
      })
      // 改单会把余额往两个方向推（改金额、把已付款退回未付款），两家都得作废：
      // 换公司时老东家的余额也变了。
      meter.forget(cur.companyId)
      meter.forget(company.id)
      json(res, 200, {
        order: publicPlanOrder(order, company),
        topup: topup ? publicTopup(topup, company) : null,
        balance: await balanceOf(db, company.id),
      })
      return
    }
    // 换套餐要把快照一起换掉，否则订单上写的还是旧套餐的名字。
    let { planId, planName, planNameEn } = cur
    let sku: PlanSku | undefined
    if ('planId' in body && strField(body, 'planId') !== cur.planId) {
      sku = await db.planSku(strField(body, 'planId'))
      if (!sku) throw new HttpError(404, '套餐不存在')
      planId = sku.id
      planName = sku.name
      planNameEn = sku.nameEn
    }
    const period = 'period' in body ? periodOf(body.period, cur.period) : sku?.period ?? cur.period
    const seats = 'seats' in body ? seatsOf(body.seats, cur.seats) : sku?.seats ?? cur.seats
    const knowledgeBases = 'knowledgeBases' in body ? knowledgeBasesOf(body.knowledgeBases, cur.knowledgeBases) : sku?.knowledgeBases ?? cur.knowledgeBases
    const amountMils = 'amount' in body ? amountMilsOf(body.amount, cur.amountMils) : sku?.amountMils ?? cur.amountMils
    const bonusMils = 'bonusTokens' in body ? bonusMilsOf(body.bonusTokens, cur.bonusMils) : sku?.bonusMils ?? cur.bonusMils
    const startAt = 'startAt' in body ? dateMsOf(body.startAt, cur.startAt) : cur.startAt
    const endAt = 'endAt' in body && body.endAt ? dateMsOf(body.endAt) : endOfPeriod(startAt, period)
    if (endAt <= startAt) throw new HttpError(400, '结束时间必须晚于开始时间')
    const payStatus = payStatusOf(body.payStatus, cur.payStatus)
    const { order, invoice } = await db.tx(async () => {
      const order = await db.updatePlanOrder(cur.id, {
        companyId: company.id, planId, planName, planNameEn, period, seats, knowledgeBases, amountMils, bonusMils, startAt, endAt, payStatus,
      })
      if (!order) throw new HttpError(404, '订单不存在')
      const invoice = await syncInvoiceOfOrder(db, order)
      // 换公司时两边都要拉齐：老东家少了一条订单，新东家多了一条。
      if (cur.companyId !== company.id) await db.syncPlanFromOrders(cur.companyId)
      await db.syncPlanFromOrders(company.id)
      return { order, invoice }
    })
    await db.audit({
      companyId: company.id,
      accountId: account.id,
      action: 'platform.order.update',
      detail: { id: order.id, planId, planName, period, seats, knowledgeBases, amountMils, bonusMils, payStatus },
    })
    meter.forget(cur.companyId)
    meter.forget(company.id)
    json(res, 200, { order: publicPlanOrder(order, company), invoice: publicInvoice(invoice) })
  })

  /**
   * 充值记录只由充值单付款开出来，没有单独的「加一笔」接口——
   * 有了就等于两条路能改余额，对不上账时说不清是谁加的。
   */
  /** 某家公司的充值明细 + 两笔余额。公司管理员看得到自己家的。 */
  router.get('/orgs/:id/topups', async (req, res) => {
    const account = await requireOrgUser(req, db, keys, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const rows = await db.topupsOfCompany(company.id)
    // 操作人是平台这边的人，一条一条查太碎，先按 id 去重再一次取回来。
    const actors = new Map(
      (await Promise.all([...new Set(rows.map((r) => r.createdBy).filter(Boolean))].map((id) => db.account(id as string))))
        .filter(Boolean)
        .map((a) => [a!.id, a!]),
    )
    json(res, 200, {
      topups: rows.map((r) => publicTopup(r, company, r.createdBy ? actors.get(r.createdBy) : undefined)),
      balance: await balanceOf(db, company.id),
    })
  })
}
