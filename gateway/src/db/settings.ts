/**
 * 平台密钥、审计、公司与平台设置（含模型角色和自动发现的模型快照）。
 */
import { randomUUID } from 'node:crypto'
import { type AuditEvent, type CompanySettings, type Credential, type DiscoverySnapshot, emptyPlatformSettings, emptySettings, emptySnapshot, parseBilling, parseConnectorPricing, parseConversationAuditSettings, parseDiscoverySnapshot, parseKnowledgeSettings, parseModelPricing, parseModelRate, parsePriceMultiplier, parseReasoningEffort, parseWebTools, type PlatformSettings } from './types.ts'
import { auditOf, jsonOf, parseDailyAlternates, parseImageRole, parsePlatformPayload, platformCredOf } from './rows.ts'
import { CatalogDb } from './catalog.ts'

export class SettingsDb extends CatalogDb {
  // ── 密钥 ──────────────────────────────────────────────────────────────

  /**
   * 公司密钥那一组方法**全撤了**：按公司查的（credentialsOf / credentialByProvider）、
   * 写的（insertCredential / upsertCredential）、删的（deleteCredentialByProvider），和按 id 走的那三个
   * （credential / updateCredential / deleteCredential）。供应商只由平台配，没有任何
   * 一条路再读写 `credentials` 这张表。
   *
   * 表和历史数据留着（见 liftCompanySettingsToPlatform 下面那段），但别为了「顺手」
   * 把这几个方法加回来——它们一回来，下一步就是路由。
   */

  async platformCredential(provider: string): Promise<Credential | undefined> {
    const r = await this.one('select * from platform_credentials where provider = ?', [provider])
    return r ? platformCredOf(r) : undefined
  }

  async upsertPlatformCredential(provider: string, secret: string): Promise<Credential> {
    const now = Date.now()
    await this.run(
      'insert into platform_credentials (provider, secret, "createdAt", "updatedAt") values (?,?,?,?) on conflict (provider) do update set secret=excluded.secret, "updatedAt"=excluded."updatedAt"',
      [provider, secret, now, now],
    )
    return (await this.platformCredential(provider))!
  }

  async platformCredentials(): Promise<Credential[]> {
    const rows = await this.many('select * from platform_credentials order by provider')
    return rows.map(platformCredOf)
  }

  async deletePlatformCredential(provider: string): Promise<void> {
    await this.run('delete from platform_credentials where provider = ?', [provider])
  }

  // ── 审计 ──────────────────────────────────────────────────────────────

  async audit(input: {
    companyId: string
    accountId?: string | null
    action: string
    detail?: unknown
  }): Promise<AuditEvent> {
    const row: AuditEvent = {
      id: randomUUID(),
      companyId: input.companyId,
      accountId: input.accountId ?? null,
      action: input.action,
      detail: input.detail ?? {},
      createdAt: Date.now(),
    }
    await this.run(
      'insert into audit_events (id, "companyId", "accountId", action, detail, "createdAt") values (?,?,?,?,?,?)',
      [row.id, row.companyId, row.accountId, row.action, JSON.stringify(row.detail), row.createdAt],
    )
    return row
  }

  async auditsOf(companyId: string, limit = 100): Promise<AuditEvent[]> {
    const rows = await this.many('select * from audit_events where "companyId" = ? order by "createdAt" desc limit ?', [
      companyId,
      limit,
    ])
    return rows.map(auditOf)
  }

  // ── 公司模型角色（日常 / utility）。不存密钥。────────────────────────

  async settings(companyId: string): Promise<CompanySettings> {
    const r = await this.one('select payload from settings where "companyId" = ?', [companyId])
    if (!r) return emptySettings()
    const raw = (jsonOf(r.payload) ?? {}) as Partial<CompanySettings>
    return {
      daily: { provider: String(raw.daily?.provider ?? ''), model: String(raw.daily?.model ?? ''), reasoningEffort: parseReasoningEffort(raw.daily?.reasoningEffort) },
      utility: { provider: String(raw.utility?.provider ?? ''), model: String(raw.utility?.model ?? ''), reasoningEffort: parseReasoningEffort(raw.utility?.reasoningEffort) },
      conversationAudit: parseConversationAuditSettings(raw.conversationAudit),
    }
  }

  async putSettings(companyId: string, next: CompanySettings): Promise<CompanySettings> {
    const now = Date.now()
    const payload = JSON.stringify({
      daily: { provider: next.daily.provider, model: next.daily.model, reasoningEffort: parseReasoningEffort(next.daily.reasoningEffort) },
      utility: { provider: next.utility.provider, model: next.utility.model, reasoningEffort: parseReasoningEffort(next.utility.reasoningEffort) },
      conversationAudit: parseConversationAuditSettings(next.conversationAudit),
    })
    await this.run(
      'insert into settings ("companyId", payload, "updatedAt") values (?,?,?) on conflict ("companyId") do update set payload=excluded.payload, "updatedAt"=excluded."updatedAt"',
      [companyId, payload, now],
    )
    return this.settings(companyId)
  }

  async platformSettings(): Promise<PlatformSettings> {
    const r = await this.one("select payload from platform_settings where id = 'platform'")
    if (!r) return emptyPlatformSettings()
    return parsePlatformPayload(r.payload)
  }

  async putPlatformSettings(next: PlatformSettings): Promise<PlatformSettings> {
    const now = Date.now()
    const enabled = Array.isArray(next.enabledModels) ? next.enabledModels.map((x) => String(x)).filter(Boolean) : []
    const payload = JSON.stringify({
      daily: { provider: next.daily.provider, model: next.daily.model, reasoningEffort: parseReasoningEffort(next.daily.reasoningEffort) },
      utility: { provider: next.utility.provider, model: next.utility.model, reasoningEffort: parseReasoningEffort(next.utility.reasoningEffort) },
      // 同下面那一串「不能漏」：整份重写，漏了它备选就是能填、回 200、读出来永远是空。
      dailyAlternates: parseDailyAlternates(next.dailyAlternates, next.daily),
      // 同上：生图模型也是整份重写里的一格，漏了就是「能选、回 200、席位上永远没有那把工具」。
      image: parseImageRole(next.image),
      enabledModels: enabled,
      priceMultiplier: parsePriceMultiplier(next.priceMultiplier),
      connectorPricing: parseConnectorPricing(next.connectorPricing),
      // **不能漏。** 这一行漏了整整一版：类型上有、路由层收得好好的、界面也能填，
      // 只有这里拼 payload 时把它丢了——于是 PUT 回 200、读出来永远是空。
      // 后果是「全机队钉版本」这一级完全失效：传一个包上去，所有没有逐台钉过的机器
      // 都会在下一次心跳自己升上去，而唯一能拦住它的开关，看起来能设、其实存不进去。
      managerVersion: String(next.managerVersion ?? '').trim(),
      // 同上，Bot 的那一档。漏了它，钉 Bot 版本就是「能填、回 200、席位照样跟最新走」。
      botVersion: String(next.botVersion ?? '').trim(),
      // 同上：这一行漏了，工具配置那一屏就是「能填、回 200、读出来永远是空」。
      webTools: parseWebTools(next.webTools),
      // 同上第三次。这两项漏了的后果更重：单价覆盖存不进去，缺价的模型就永远缺价；
      // 熔断开关存不进去，`enforce` 就成了一个改不动的常量。
      modelPricing: parseModelPricing(next.modelPricing),
      // 同上第四次。漏了它的表现是：兜底单价能填、PUT 回 200、读出来永远是全 0，
      // 于是缺价的模型继续按 0 收——正是加这一项要堵的那个洞。
      defaultModelRate: parseModelRate(next.defaultModelRate),
      billing: parseBilling(next.billing),
      // 同上第五次：知识库的单价和门槛。漏了就是「工具配置那一屏能填、回 200、读出来永远是 0」。
      knowledge: parseKnowledgeSettings(next.knowledge),
    })
    await this.run(
      "insert into platform_settings (id, payload, \"updatedAt\") values ('platform', ?, ?) on conflict (id) do update set payload=excluded.payload, \"updatedAt\"=excluded.\"updatedAt\"",
      [payload, now],
    )
    return this.platformSettings()
  }

  /**
   * 自动发现的模型快照。
   *
   * 借 platform_settings 那张表另开一行（id='discovered'），不新建表也就不用加迁移：
   * 那张表本来就是 `(id, payload jsonb, updatedAt)` 的通用键值，platform 只是它的
   * 一个键。**不能塞进 platform 那一行**——putPlatformSettings 是整条 payload 重写的，
   * 它已经漏掉过三次字段（见那个函数里的注释），再往里加一个由后台任务写、由页面
   * 顺手覆盖的字段，就是给同一个坑再挖一遍。
   */
  async discoveredModels(): Promise<DiscoverySnapshot> {
    const r = await this.one("select payload from platform_settings where id = 'discovered'")
    if (!r) return emptySnapshot()
    return parseDiscoverySnapshot(r.payload)
  }

  async putDiscoveredModels(next: DiscoverySnapshot): Promise<DiscoverySnapshot> {
    const clean = parseDiscoverySnapshot(next)
    await this.run(
      "insert into platform_settings (id, payload, \"updatedAt\") values ('discovered', ?, ?) on conflict (id) do update set payload=excluded.payload, \"updatedAt\"=excluded.\"updatedAt\"",
      [JSON.stringify(clean), Date.now()],
    )
    return clean
  }

  /**
   * 一次性：公司日常/utility 升到平台设置（平台还空时）。开机时跑一遍（index.ts）。
   *
   * **这里曾经还把公司密钥升成平台密钥，已经删掉，不要再加回来。**
   *
   * 那半段是 `select provider, secret from credentials` —— 整张表、**不带公司过滤**，
   * 挑到谁算谁，upsert 进 platform_credentials。当初写它时 `credentials` 没有任何写入
   * 口，整张表就是单租户时代留下的那几行，「升成平台的」和「搬个家」是一回事。
   *
   * 后来那张表成了每家公司自己配密钥的地方，那半段就变成了一个跨租户漏密钥的开机
   * 自动化：任意一个公司管理员填进去的 key，重启之后成了全平台的兜底密钥。
   *
   * **现在公司那条路又撤了**（供应商只由平台配，见上面 platformCredential 前面那段），
   * 可这张表里**还躺着各家当初存进去的行**——正因为没有写入口了，那批数据反而是死的，
   * 谁也管不着、谁也改不了。把它们升成平台密钥，等于拿一家公司几个月前的 key 去给
   * 全平台供货。这道禁令因此比以前更该留着。
   *
   * 平台密钥只能由平台管理员在平台那一屏显式配置。
   */
  async liftCompanySettingsToPlatform(): Promise<{ settings: boolean }> {
    const lifted = { settings: false }
    const cur = await this.platformSettings()
    const empty = !cur.daily.provider && !cur.daily.model && !cur.utility.provider && !cur.utility.model
    if (empty) {
      const rows = await this.many('select payload from settings order by "updatedAt" desc')
      for (const row of rows) {
        const s = parsePlatformPayload(row.payload)
        if (s.daily.provider || s.daily.model || s.utility.provider || s.utility.model) {
          /**
           * **原样带上 cur 的全部字段，只覆盖要迁的那两项。**
           *
           * putPlatformSettings 是「整份重写」：漏给一项，它就按空值序列化下去。
           * 这里原先漏了 managerVersion / modelPricing / billing 三项——只要平台的
           * daily/utility 还空着（上面 `empty` 只看这四个字符串），一次开机迁移就会把
           * 钉好的机队版本、全部单价覆盖和熔断开关一起清成默认值。
           */
          await this.putPlatformSettings({ ...cur, daily: s.daily, utility: s.utility })
          lifted.settings = true
          break
        }
      }
    }
    return lifted
  }
}
