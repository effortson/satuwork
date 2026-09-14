/**
 * 平台设置、上游密钥、用量统计、自定义供应商、连通性探测。owner-only。
 */
import type { RouteCtx } from './ctx.ts'
import { CUSTOM_APIS, type CustomProviderDef, DefError, parseProviderDef } from '../providers.ts'
import { HttpError, json, type Router } from '../http.ts'
import { bodyOf, strField } from '../lib/validate.ts'
import { billingOf, defaultModelRateOf, enabledModelsOf, modelPricingOf, modelProviderCreds, modelRoleOf, priceMultiplierOf, publicPlatformCred, publicSettings } from '../lib/org.ts'
import { refreshDiscovered, REFRESH_MS } from '../model-discovery.ts'
import { isVendor } from '../connectors/index.ts'
import { rangeQuery, requireOwnerUser } from '../lib/guards.ts'
import { WEB_BACKENDS, WEB_DOCUMENT, type PlatformSettings, emptyWebTools, parseBilling, parseConnectorPricing, parseModelPricing, parseModelRate, parsePriceMultiplier, parseWebTools } from '../db.ts'
import { WebToolError, canExtract, canSearch, needsSecret } from '../web-tools.ts'
import { testBackend } from '../web-service.ts'

export function attachPlatform(router: Router, ctx: RouteCtx) {
  const { db, keys, llm, meter } = ctx

  // ── 平台（owner）───────────────────────────────────────────────────

  router.get('/platform/settings', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    json(res, 200, publicSettings(await db.platformSettings()))
  })

  router.put('/platform/settings', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const body = bodyOf(req)
    const cur = await db.platformSettings()
    const next: PlatformSettings = {
      daily: 'daily' in body ? modelRoleOf(body.daily, 'daily') : cur.daily,
      utility: 'utility' in body ? modelRoleOf(body.utility, 'utility') : cur.utility,
      enabledModels: 'enabledModels' in body ? enabledModelsOf(body.enabledModels) : cur.enabledModels ?? [],
      priceMultiplier: priceMultiplierOf(body.priceMultiplier, parsePriceMultiplier(cur.priceMultiplier)),
      // 写端和 parsePlatformPayload 必须成对：少一边这个开关就是死的。
      connectorPricing: 'connectorPricing' in body ? parseConnectorPricing(body.connectorPricing) : cur.connectorPricing,
      managerVersion:
        'managerVersion' in body ? String(body.managerVersion ?? '').trim() : (cur.managerVersion ?? ''),
      // 这一屏不管网页工具，但 next 是整份覆盖上去的——不带着它，去模型配置页存一次
      // 就把工具配置抹了。
      webTools: cur.webTools ?? emptyWebTools(),
      modelPricing: 'modelPricing' in body ? modelPricingOf(body.modelPricing, parseModelPricing(cur.modelPricing)) : parseModelPricing(cur.modelPricing),
      // 兜底单价：查不到价的模型按它收，而不是按 0 收（docs/billing.md §7）。
      defaultModelRate: 'defaultModelRate' in body
        ? defaultModelRateOf(body.defaultModelRate, parseModelRate(cur.defaultModelRate))
        : parseModelRate(cur.defaultModelRate),
      billing: 'billing' in body ? billingOf(body.billing, parseBilling(cur.billing)) : parseBilling(cur.billing),
    }
    const saved = await db.putPlatformSettings(next)
    // 改了熔断开关，各家公司的余额记忆当场作废——不然要等它自己过期，界面上像没改上。
    meter.forget(null)
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'platform.settings.update', detail: publicSettings(saved) })
    json(res, 200, publicSettings(saved))
  })

  /**
   * 平台密钥清单。**只报模型供应商**——连接器和网页后端的密钥虽然同住一张表，
   * 但它们各有自己的页面和接口，见 modelProviderCreds。
   */
  /**
   * 这条路只收模型供应商的密钥。
   *
   * 连接器供应商（composio）有自己的保存接口 `PUT /platform/connector-vendors/:vendor`
   * 和自己的页面。两条路都写得进同一张表，于是「在供应商页贴一次、在连接器页再贴
   * 一次」这种事随时会发生，而两边显示的状态还各算各的。堵住这一头，composio 就只有
   * 一个存法、一个看处。
   *
   * 网页搜索后端（tavily 那几个）仍然从这条路存——它们没有另一条路，见「工具配置」
   * 那一屏的注释。它们不出现在供应商清单里，是 GET 那头过滤掉的。
   */
  function modelSecretOr400(provider: string): string {
    if (isVendor(provider)) throw new HttpError(400, `${provider} 是连接器供应商，密钥请到「连接器」页保存`)
    return provider
  }

  router.get('/platform/credentials', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    json(res, 200, { credentials: modelProviderCreds(await db.platformCredentials()).map(publicPlatformCred) })
  })

  router.post('/platform/credentials', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const body = bodyOf(req)
    const provider = modelSecretOr400(strField(body, 'provider'))
    const secret = strField(body, 'secret')
    const existed = !!await db.platformCredential(provider)
    const row = await db.upsertPlatformCredential(provider, secret)
    await db.audit({
      companyId: 'platform',
      accountId: account.id,
      action: existed ? 'platform.credential.update' : 'platform.credential.create',
      detail: { provider },
    })
    json(res, existed ? 200 : 201, { credential: publicPlatformCred(row) })
  })

  router.put('/platform/credentials/:provider', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const provider = modelSecretOr400(req.params.provider)
    if (!await db.platformCredential(provider)) throw new HttpError(404, '密钥不存在')
    const secret = strField(bodyOf(req), 'secret')
    const row = await db.upsertPlatformCredential(provider, secret)
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'platform.credential.update', detail: { provider } })
    json(res, 200, { credential: publicPlatformCred(row) })
  })

  router.delete('/platform/credentials/:provider', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const provider = modelSecretOr400(req.params.provider)
    if (!await db.platformCredential(provider)) throw new HttpError(404, '密钥不存在')
    await db.deletePlatformCredential(provider)
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'platform.credential.delete', detail: { provider } })
    json(res, 200, { deleted: true, provider })
  })

  // ── 工具配置 → 网页与搜索 ─────────────────────────────────────────────
  //
  // 只在平台层配一次，公司不配、也看不见：搜索后端是平台采购、平台计价、转售给各家
  // 的能力。公司那层留一个开关，「这家用的是哪个后端、按哪个价结算」当场变糊涂账。

  /** 密钥永不回显，只报「配没配 + 什么时候改的」，和模型供应商那屏同一条规矩。 */
  async function webToolsView() {
    const s = await db.platformSettings()
    const web = s.webTools ?? emptyWebTools()
    const creds = new Map((await db.platformCredentials()).map((c) => [c.provider, c]))
    return {
      web,
      priceMultiplier: parsePriceMultiplier(s.priceMultiplier),
      backends: [
        ...WEB_BACKENDS.map((id) => ({
          id,
          label: id,
          search: canSearch(id),
          extract: canExtract(id),
          needsSecret: needsSecret(id),
          // firecrawl 在名单里但没实现：界面上要能看见它「未接入」，而不是凭空少一项。
          implemented: canSearch(id) || canExtract(id),
          // 能不能出现在那两个下拉里。document 不能：它不是可选的后端，是一条计价项。
          selectable: true,
          configured: needsSecret(id) ? creds.has(id) : true,
          updatedAt: creds.get(id)?.updatedAt ?? null,
        })),
        {
          id: WEB_DOCUMENT,
          label: '文档直取（PDF / Word / Excel）',
          search: false,
          extract: true,
          needsSecret: false,
          implemented: true,
          selectable: false,
          configured: true,
          updatedAt: null,
        },
      ],
    }
  }

  router.get('/platform/tools/web', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    json(res, 200, await webToolsView())
  })

  router.put('/platform/tools/web', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const body = bodyOf(req)
    const cur = await db.platformSettings()
    const web = parseWebTools({ ...(cur.webTools ?? emptyWebTools()), ...body })
    // 配得出来的组合必须是能跑的：把只会搜索的后端设成提取后端，等于让人配出一个
    // 必然报错的组合，然后到席位那边才发现。
    if (web.searchBackend && !canSearch(web.searchBackend)) {
      throw new HttpError(400, `${web.searchBackend} 不支持搜索`)
    }
    if (web.extractBackend && !canExtract(web.extractBackend)) {
      throw new HttpError(400, `${web.extractBackend} 不支持提取`)
    }
    if (web.searxngUrl) {
      let u: URL | undefined
      try {
        u = new URL(web.searxngUrl)
      } catch {
        throw new HttpError(400, 'SearXNG 地址必须是完整的 http/https 地址')
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'SearXNG 地址必须是 http/https')
    }
    await db.putPlatformSettings({ ...cur, webTools: web })
    await db.audit({
      companyId: 'platform',
      accountId: account.id,
      action: 'platform.tools.web.update',
      // **不带密钥**：审计里躺一份密钥，等于把它复制到了第二个地方。
      detail: { searchBackend: web.searchBackend, extractBackend: web.extractBackend, searxngUrl: web.searxngUrl, pricing: web.pricing },
    })
    json(res, 200, await webToolsView())
  })

  /** 自检：拿固定查询词打一次选中的后端。不记 web_calls——这是验配置，不是用。 */
  router.post('/platform/tools/web/test', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    const kind = strField(bodyOf(req), 'kind') === 'extract' ? 'extract' : 'search'
    try {
      const out = await testBackend(db, kind)
      json(res, 200, { ok: true, kind, ...out })
    } catch (e) {
      // 自检失败是这一屏的正常结果，不是接口故障：要让管理员看见原因，而不是一个红叉。
      json(res, 200, { ok: false, kind, error: e instanceof WebToolError ? e.hint : (e as Error).message })
    }
  })

  /** 网页调用的汇总：按公司一行、按后端一行，外加一个合计。 */
  function webStats(
    rows: { companyId: string | null; backend: string; kind: string; calls: number; units: number; amountMicros: number; lastAt: number | null }[],
    companies: Map<string, { id: string; name: string }>,
  ) {
    const byCompany = new Map<string, { companyId: string | null; name: string; calls: number; units: number; amountMicros: number; lastAt: number | null }>()
    const byBackend = new Map<string, { backend: string; search: number; extract: number; units: number; amountMicros: number }>()
    for (const row of rows) {
      const key = row.companyId ?? ''
      let c = byCompany.get(key)
      if (!c) {
        c = {
          companyId: row.companyId,
          name: row.companyId ? companies.get(row.companyId)?.name ?? row.companyId : '平台（系统管理员）',
          calls: 0, units: 0, amountMicros: 0, lastAt: null,
        }
        byCompany.set(key, c)
      }
      c.calls += row.calls
      c.units += row.units
      c.amountMicros += row.amountMicros
      if (row.lastAt != null && (c.lastAt == null || row.lastAt > c.lastAt)) c.lastAt = row.lastAt

      let b = byBackend.get(row.backend)
      if (!b) {
        b = { backend: row.backend, search: 0, extract: 0, units: 0, amountMicros: 0 }
        byBackend.set(row.backend, b)
      }
      if (row.kind === 'search') b.search += row.calls
      else b.extract += row.calls
      b.units += row.units
      b.amountMicros += row.amountMicros
    }
    const list = [...byCompany.values()].sort((a, b) => b.amountMicros - a.amountMicros)
    return {
      byCompany: list,
      byBackend: [...byBackend.values()].sort((a, b) => b.amountMicros - a.amountMicros),
      totals: list.reduce(
        (acc, x) => ({ calls: acc.calls + x.calls, units: acc.units + x.units, amountMicros: acc.amountMicros + x.amountMicros }),
        { calls: 0, units: 0, amountMicros: 0 },
      ),
    }
  }

  /**
   * 平台用量统计：token 从 `llm_calls` 汇总，**金额从账本汇总**。
   *
   * 时间窗由前端算好用 from/to（unix 毫秒）传进来——「今日」「本月」是相对
   * **用户所在时区**的，服务端不知道那是哪个时区，自己切会错一整天。
   *
   * **金额不再按当前单价现折。** 以前这里是「token 数 × 目录里此刻的单价 × 此刻的
   * 倍率」，于是改一次倍率，上个月的模型账单跟着变，而同一张表里连接器那一列不变。
   * 现在三条路一个口径：写行那一刻定死，统计只 sum（docs/billing.md §2）。
   *
   * 原价那一列是**倒推**出来的：成交额 ÷ 当时的倍率。账本上存的是倍率而不是原价，
   * 因为倍率只有一个数、而原价有四项。
   */
  router.get('/platform/stats', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    const range = rangeQuery(req)
    const companyId = (req.query.get('companyId') || '').trim()
    if (companyId && !(await db.company(companyId))) throw new HttpError(404, '公司不存在')

    const rows = await db.llmUsageByCompanyModel(range, companyId || undefined)
    const webRows = await db.webUsageByCompanyBackend(range, companyId || undefined)
    const connectorRows = await db.connectorUsage({ companyId: companyId || undefined }, range)
    const multiplier = parsePriceMultiplier((await db.platformSettings()).priceMultiplier)

    /** 账本里模型那一类的钱，按 (公司, 模型) 摊开。key 和下面 token 那份对齐。 */
    const charged = new Map<string, { amountMicros: number; costMicros: number; unpricedCalls: number; unmeteredCalls: number }>()
    /**
     * 三条路各自的钱。**上面那两张卡（原价 / 已扣）要的是三条路的和**——月底从余额里
     * 扣掉的是这个数，只报模型那一份的话，卡上的钱比账单少，而少掉的那截在这一屏上
     * 没有任何地方能对出来。
     *
     * 这里数的是账本行本身，不是领域表：钱只在账本里（docs/billing.md §2），
     * 模型 / 连接器 / 网页三条路在这张表上是同一个口径，直接按 kind 分堆就行。
     */
    const byKind = new Map<string, { calls: number; amountMicros: number; costMicros: number }>()
    for (const c of await db.chargeUsageBy(['companyId', 'kind', 'subject'], range, { companyId: companyId || undefined })) {
      const k = byKind.get(c.kind) ?? { calls: 0, amountMicros: 0, costMicros: 0 }
      k.calls += c.calls
      k.amountMicros += c.amountMicros
      k.costMicros += c.costMicros
      byKind.set(c.kind, k)

      if (c.kind !== 'llm') continue
      const key = `${c.companyId ?? ''}|${c.subject}`
      const cur = charged.get(key) ?? { amountMicros: 0, costMicros: 0, unpricedCalls: 0, unmeteredCalls: 0 }
      cur.amountMicros += c.amountMicros
      cur.costMicros += c.costMicros
      cur.unpricedCalls += c.unpricedCalls
      cur.unmeteredCalls += c.unmeteredCalls
      charged.set(key, cur)
    }

    const companies = new Map((await db.companies()).map((c) => [c.id, c]))
    type Bucket = {
      companyId: string | null
      name: string
      calls: number
      promptTokens: number
      completionTokens: number
      /** promptTokens 里命中缓存的那一截。是子集，界面上用来解释金额为什么比 token 数低。 */
      cachedTokens: number
      /** promptTokens 里写进缓存的那一截。也是子集，但它比普通输入**贵**。 */
      cacheWriteTokens: number
      /** 已扣的（成交额）和倒推的原价，都是微元。 */
      amountMicros: number
      costMicros: number
      unpricedCalls: number
      /** 有单价、但结算时没拿到用量的调用数。金额也是 0，可原因和上一格不是一回事。 */
      unmeteredCalls: number
      /** 账本上根本没有对应行的调用数。金额是 0，但那个 0 是「没记过账」。 */
      unledgeredCalls: number
      lastAt: number | null
    }
    const byCompany = new Map<string, Bucket>()
    const byModel = new Map<string, {
      provider: string
      model: string
      calls: number
      promptTokens: number
      completionTokens: number
      cachedTokens: number
      cacheWriteTokens: number
      amountMicros: number
      costMicros: number
      priced: boolean
      unmeteredCalls: number
      unledgeredCalls: number
    }>()
    /** 目录里没价的模型（pi-ai 没收录，或自定义时留了 0）。金额算不出来，得说清楚。 */
    const unpricedModels = new Set<string>()
    /**
     * **有单价、但那几次调用没拿到用量**的模型。和「没单价」分开报，因为它不是配置问题：
     * 上游的流里一个 usage 字段都没回，或者管家拿了授权之后**再也没回来**（被清扫按 0 元
     * 收了口，routines.ts 的 sweepUnsettledLlmCalls）。去配置页补价补不出这笔钱——那一次
     * 的用量已经没了。合在一起报的表现是：单价明明配着，界面却说「目录里没有单价」。
     *
     * 管家只是**晚**回来的那种不在这里：那行占位会被补成真的成交（docs/billing.md §2.1）。
     */
    const unmeteredModels = new Set<string>()
    /**
     * 账本上没有行的模型。**和「没单价」是两回事，所以分开报**：一个是配置漏了、
     * 现在就得去补，另一个是那段历史本来就没记过账、补不回来。混成一句话的话，
     * owner 会跑去模型配置页找一个并不存在的问题。
     */
    const unledgeredModels = new Set<string>()

    for (const row of rows) {
      const key = `${row.provider}/${row.model}`
      const cid = row.companyId
      const money = charged.get(`${cid ?? ''}|${key}`) ?? { amountMicros: 0, costMicros: 0, unpricedCalls: 0, unmeteredCalls: 0 }
      if (money.unpricedCalls > 0) unpricedModels.add(key)
      if (money.unmeteredCalls > 0) unmeteredModels.add(key)
      if (row.unledgeredCalls > 0) unledgeredModels.add(key)
      // cachedTokens / cacheWriteTokens 理论上都是 promptTokens 的子集。真出现脏数据
      // （上游改了口径、旧行没有这一列）也不能让界面上算出负的未命中量。
      const cached = Math.min(Math.max(0, row.cachedTokens), row.promptTokens)
      const written = Math.min(Math.max(0, row.cacheWriteTokens), row.promptTokens - cached)

      const bk = cid ?? ''
      let bucket = byCompany.get(bk)
      if (!bucket) {
        bucket = {
          companyId: cid,
          name: cid ? companies.get(cid)?.name ?? cid : '平台（系统管理员）',
          calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0,
          amountMicros: 0, costMicros: 0, unpricedCalls: 0, unmeteredCalls: 0, unledgeredCalls: 0, lastAt: null,
        }
        byCompany.set(bk, bucket)
      }
      bucket.calls += row.calls
      bucket.promptTokens += row.promptTokens
      bucket.completionTokens += row.completionTokens
      bucket.cachedTokens += cached
      bucket.cacheWriteTokens += written
      bucket.amountMicros += money.amountMicros
      bucket.costMicros += money.costMicros
      bucket.unpricedCalls += money.unpricedCalls
      bucket.unmeteredCalls += money.unmeteredCalls
      bucket.unledgeredCalls += row.unledgeredCalls
      if (row.lastAt != null && (bucket.lastAt == null || row.lastAt > bucket.lastAt)) bucket.lastAt = row.lastAt

      let mb = byModel.get(key)
      if (!mb) {
        mb = { provider: row.provider, model: row.model, calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, amountMicros: 0, costMicros: 0, priced: true, unmeteredCalls: 0, unledgeredCalls: 0 }
        byModel.set(key, mb)
      }
      mb.calls += row.calls
      mb.promptTokens += row.promptTokens
      mb.completionTokens += row.completionTokens
      mb.cachedTokens += cached
      mb.cacheWriteTokens += written
      mb.amountMicros += money.amountMicros
      mb.costMicros += money.costMicros
      // `priced` 只说目录里有没有价——它管的是那一列画不画得出「原价」。没拿到用量
      // 不影响单价存不存在，所以这里只看 unpricedCalls。
      if (money.unpricedCalls > 0) mb.priced = false
      mb.unmeteredCalls += money.unmeteredCalls
      mb.unledgeredCalls += row.unledgeredCalls
    }

    const list = [...byCompany.values()].sort((a, b) => b.promptTokens + b.completionTokens - (a.promptTokens + a.completionTokens))
    const totals = list.reduce(
      (acc, x) => ({
        calls: acc.calls + x.calls,
        promptTokens: acc.promptTokens + x.promptTokens,
        completionTokens: acc.completionTokens + x.completionTokens,
        cachedTokens: acc.cachedTokens + x.cachedTokens,
        cacheWriteTokens: acc.cacheWriteTokens + x.cacheWriteTokens,
        amountMicros: acc.amountMicros + x.amountMicros,
        costMicros: acc.costMicros + x.costMicros,
        unpricedCalls: acc.unpricedCalls + x.unpricedCalls,
        unmeteredCalls: acc.unmeteredCalls + x.unmeteredCalls,
        unledgeredCalls: acc.unledgeredCalls + x.unledgeredCalls,
      }),
      { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, amountMicros: 0, costMicros: 0, unpricedCalls: 0, unmeteredCalls: 0, unledgeredCalls: 0 },
    )

    /**
     * 连接器按**次**算钱，和网页工具一样不进 token 合计，单开一块。
     *
     * `byConnector` 在库里是按 (连接器, 连接名) 分的——同一个 Gmail 连了三个账号就是
     * 三行。这一屏是平台视角，看的是「哪个连接器花了钱」，所以把连接名合并掉；
     * 谁用的、哪一把连接，在连接器那一页和计费明细里。
     */
    const byConnector = new Map<string, { connector: string; calls: number; amountMicros: number }>()
    for (const c of connectorRows.byConnector) {
      const cur = byConnector.get(c.connector) ?? { connector: c.connector, calls: 0, amountMicros: 0 }
      cur.calls += c.calls
      cur.amountMicros += c.amountMicros
      byConnector.set(c.connector, cur)
    }
    const zero = { calls: 0, amountMicros: 0, costMicros: 0 }
    const kind = (k: string) => byKind.get(k) ?? zero
    const spend = {
      llm: kind('llm'),
      connector: kind('connector'),
      web: kind('web'),
      all: [...byKind.values()].reduce(
        (a, x) => ({ calls: a.calls + x.calls, amountMicros: a.amountMicros + x.amountMicros, costMicros: a.costMicros + x.costMicros }),
        { ...zero },
      ),
    }

    json(res, 200, {
      from: range.from ?? null,
      to: range.to ?? null,
      // 当前倍率，只给界面上那句「现在按几倍报价」用。历史金额里的倍率是各行自己的。
      multiplier,
      companies: [...companies.values()].map((c) => ({ id: c.id, name: c.name })),
      byCompany: list,
      byModel: [...byModel.values()].sort((a, b) => b.promptTokens + b.completionTokens - (a.promptTokens + a.completionTokens)),
      totals,
      // 前端要据此提示「有模型没单价，金额不完整」，不能让 $0.00 被读成免费。
      unpricedModels: [...unpricedModels],
      // 同样是「金额不完整」，但这些模型**单价是有的**，缺的是那几次调用的用量。
      // 和上面那条分开说，否则 owner 会跑去配置页找一个不存在的问题。
      unmeteredModels: [...unmeteredModels],
      // 同上，但原因不同：这些调用在账本上根本没有行（多半是升级前那段），
      // 金额补不回来。两句话分开说，否则 owner 会去配置页找一个不存在的问题。
      unledgeredModels: [...unledgeredModels],
      // 网页工具按次算钱，跟 token 不是一个量纲，所以单开一块，不混进上面的合计。
      web: webStats(webRows, companies),
      // 连接器同理：按次收，和 token 不是一个量纲。
      connector: {
        byConnector: [...byConnector.values()].sort((a, b) => b.amountMicros - a.amountMicros || b.calls - a.calls),
        totals: { calls: connectorRows.total.calls, amountMicros: connectorRows.total.amountMicros },
      },
      /**
       * 三条路各自的钱和它们的和。`totals` 里那两个金额是**模型那一条**，两处不一样，
       * 所以分开给：卡上要账单口径的总数，按公司 / 按模型那两张表要的是模型这一条。
       */
      money: spend,
    })
  })

  // ── 自定义供应商（pi-ai 的 createProvider 形状）──────────────────────

  /** 删掉这个供应商就没模型可用了的角色。删之前先问清楚，别让日常模型悄悄哑掉。 */
  async function rolesUsing(provider: string): Promise<string[]> {
    const s = await db.platformSettings()
    const hit: string[] = []
    if (s.daily.provider === provider) hit.push('日常')
    if (s.utility.provider === provider) hit.push('utility')
    return hit
  }

  async function customProviderItem(id: string) {
    for (const item of await db.visibleCatalog('provider', null)) {
      const def = (item.definition ?? {}) as { id?: unknown }
      if (String(def.id ?? item.name) === id) return item
    }
    return undefined
  }

  function defOf(item: { definition: unknown }): CustomProviderDef {
    return parseProviderDef(item.definition)
  }

  /** parseProviderDef 抛的是 DefError，对外要变成 400，不能漏成 500。 */
  function parseOr400<T>(fn: () => T): T {
    try {
      return fn()
    } catch (e) {
      if (e instanceof DefError) throw new HttpError(400, e.message)
      throw e
    }
  }

  router.get('/platform/providers', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    const items = await db.visibleCatalog('provider', null)
    const out: Record<string, unknown>[] = []
    for (const item of items) {
      try {
        out.push({ itemId: item.id, ...defOf(item) })
      } catch (e) {
        // 坏定义也要露出来，否则界面上它就是一条看不见删不掉的记录。
        out.push({ itemId: item.id, id: item.name, name: item.name, broken: (e as Error).message })
      }
    }
    json(res, 200, { providers: out, apis: CUSTOM_APIS, builtin: [...llm.builtinProviderIds()] })
  })

  router.post('/platform/providers', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const def = parseOr400(() => parseProviderDef(bodyOf(req)))
    if (llm.isBuiltinProvider(def.id)) throw new HttpError(409, `${def.id} 是内置供应商，换个 id`)
    if (await customProviderItem(def.id)) throw new HttpError(409, '这个供应商 id 已经有了')
    const item = await db.insertCatalog({ kind: 'provider', scope: 'global', companyId: null, name: def.id, definition: def })
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'platform.provider.create', detail: { provider: def.id } })
    json(res, 201, { provider: { itemId: item.id, ...def } })
  })

  router.put('/platform/providers/:provider', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const item = await customProviderItem(req.params.provider)
    if (!item) throw new HttpError(404, '自定义供应商不存在')
    // id 不给改：模型角色、密钥、用量记录都是按它存的，改了会成孤儿。
    const def = parseOr400(() => parseProviderDef({ ...(bodyOf(req) as object), id: req.params.provider }))
    const next = await db.updateCatalog(item.id, { name: def.id, definition: def })
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'platform.provider.update', detail: { provider: def.id } })
    json(res, 200, { provider: { itemId: next.id, ...def } })
  })

  router.delete('/platform/providers/:provider', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const provider = req.params.provider
    const item = await customProviderItem(provider)
    if (!item) throw new HttpError(404, '自定义供应商不存在')
    const used = await rolesUsing(provider)
    if (used.length && req.query.get('force') !== '1') {
      throw new HttpError(409, `${used.join(' 和 ')}模型正在用它，确认要删就带 force=1`, { roles: used })
    }
    await db.deleteCatalog(item.id)
    // 密钥跟着走，别在库里留一把指向不存在的供应商的密钥。
    if (await db.platformCredential(provider)) await db.deletePlatformCredential(provider)
    for (const role of used) {
      await db.putPlatformSettings({
        ...(await db.platformSettings()),
        [role === '日常' ? 'daily' : 'utility']: { provider: '', model: '', reasoningEffort: 'off' },
      })
    }
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'platform.provider.delete', detail: { provider, clearedRoles: used } })
    json(res, 200, { deleted: true, provider, clearedRoles: used })
  })

  router.post('/platform/llm/test', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    const body = bodyOf(req)
    let provider = ''
    let model = ''
    const role = body.role
    const cur = await db.platformSettings()
    if (role === 'daily' || role === 'utility') {
      const slot = cur[role]
      if (!slot.provider || !slot.model) throw new HttpError(400, `${role === 'daily' ? '日常' : 'utility'} 模型还没设置`)
      provider = slot.provider
      model = slot.model
    } else {
      provider = strField(body, 'provider')
      model = strField(body, 'model', false)
      if (!model) {
        if (cur.daily.provider === provider && cur.daily.model) model = cur.daily.model
        else if (cur.utility.provider === provider && cur.utility.model) model = cur.utility.model
        else model = await llm.firstModel(null, provider)
      }
      if (!model) throw new HttpError(400, '这个供应商没有可测的模型')
    }
    const result = await llm.probe(null, provider, model)
    if (!result.ok && result.error === '模型不在可见目录里') {
      throw new HttpError(404, result.error, { model: `${result.provider}/${result.model}` })
    }
    if (!result.ok && result.error?.startsWith('没有 ') && result.error.endsWith(' 的密钥')) {
      throw new HttpError(402, result.error, { provider: result.provider })
    }
    json(res, 200, result)
  })

  // ── 模型自动发现 ───────────────────────────────────────────────────

  /**
   * 目录发现的状态。页面拿它显示「上次刷新于……」和失败原因——不给这个的话，
   * 「新模型怎么还没出来」就只能靠翻网关日志回答。
   */
  router.get('/platform/models/discovery', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    const snap = await db.discoveredModels()
    json(res, 200, {
      fetchedAt: snap.fetchedAt || null,
      attemptedAt: snap.attemptedAt || null,
      lastError: snap.lastError || null,
      // models.dev 收录的可用模型总数，和真正补进目录的数量不是一回事：绝大多数
      // 早就在内置快照里了，补进去的只有差集。
      upstream: snap.entries.length,
      added: await llm.syncDiscovered(),
      deny: snap.deny,
      intervalMs: REFRESH_MS,
    })
  })

  /** 立即刷新。等不到下一个 tick 的时候用（比如上游刚上了模型，现在就要）。 */
  router.post('/platform/models/discovery/refresh', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    const result = await refreshDiscovered(db, { force: true })
    if (result.error) throw new HttpError(502, `models.dev 拉取失败：${result.error}`)
    const snap = await db.discoveredModels()
    json(res, 200, { fetchedAt: snap.fetchedAt, upstream: snap.entries.length, added: await llm.syncDiscovered() })
  })

  /**
   * 把某个自动发现的模型按下去 / 放回来。
   *
   * 存在的理由是真事：pi 的生成脚本里有几张写死的排除表（xAI 那几个、opencode 的
   * gpt-5.3-codex-spark），排除理由没写在代码里，多半是实测调不通。我们这边靠
   * models.dev 的元数据看不出这类问题，只能等它在探测里露馅，然后按下去。
   */
  router.post('/platform/models/discovery/deny', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const body = bodyOf(req)
    const provider = strField(body, 'provider')
    const model = strField(body, 'model')
    const key = `${provider}/${model}`
    const snap = await db.discoveredModels()
    const on = body.denied !== false
    const deny = new Set(snap.deny)
    if (on) deny.add(key)
    else deny.delete(key)
    await db.putDiscoveredModels({ ...snap, deny: [...deny] })
    // 按下去一个模型等于把它从所有公司的目录里拿掉，和改 enabledModels 一样要留痕。
    await db.audit({
      companyId: 'platform',
      accountId: account.id,
      action: 'platform.models.discovery.deny',
      detail: { model: key, denied: on },
    })
    json(res, 200, { model: key, denied: on, added: await llm.syncDiscovered() })
  })
}
