/**
 * Bot / Skill / MCP 的定义构造，以及平台与公司两套 CRUD——它们共用同一个工厂。
 */
import type { RouteCtx } from './ctx.ts'
import { COMPANY_BOT_ICONS, CatalogOwner, skillDisplayNames, skillFiles, skillModeOf, escalateToOf, DEFAULT_BOT_PROMPT, GLOBAL_BOT_ICONS, GLOBAL_OWNER, LEGACY_BOT_ICONS, MCP_KINDS, MCP_PERMS, McpKind, SkillSource, asDef, assignedIds, botBrowserOf, botDefOf, botGuardsOf, botIconOf, botMemoryOf, botNameOf, companyOwner, defaultBotModel, envOf, filesOf, iconSetFor, knownTags, namedOf, publicBot, publicCatalog, publicServer, publicSkill, rememberTags, tagsOf, trimStr } from '../lib/catalog.ts'
import { HttpError, type Req, type Router, json } from '../http.ts'
import { bodyOf, strField } from '../lib/validate.ts'
import { kindOf, requireOrgUser, requireOwner, requireOwnerUser, requireUser } from '../lib/guards.ts'
import { type Account, type CatalogItem, type CatalogKind } from '../db.ts'
import { requestBotDeletion } from '../conversation-audit.ts'

export function attachCatalog(router: Router, ctx: RouteCtx) {
  const { db, keys, llm } = ctx

  /**
   * 公司模型条目的 definition **不能原样入库**。规矩在 Llm.companyModelAllowed 里
   * （provider 得是平台配好的、模型得在白名单 / 平台目录里、不许自带 cost）；这里只做
   * 形状整理和翻成 400。catalog() 合并时还会再按同一条规矩挡一层。
   */
  async function companyModelDefinition(raw: unknown, name: string): Promise<Record<string, unknown>> {
    if (raw != null && (typeof raw !== 'object' || Array.isArray(raw))) throw new HttpError(400, 'definition 必须是对象')
    const def = { ...((raw ?? {}) as Record<string, unknown>) }
    if ('cost' in def) throw new HttpError(400, '公司模型条目不能自带 cost，单价由平台定')
    const provider = String(def.provider ?? name ?? '').trim()
    const id = String(def.id ?? def.model ?? name ?? '').trim()
    if (!provider || !id) throw new HttpError(400, 'definition 要带 provider 和 id')
    await llm.syncCustomProviders()
    await llm.syncDiscovered()
    const verdict = await llm.companyModelAllowed(provider, id)
    if (!verdict.ok) throw new HttpError(400, verdict.reason)
    return def
  }

  // ── 目录项的建 / 改。平台侧和公司侧共用这几段，差别只在 owner。────────

  async function newBotDefinition(owner: CatalogOwner, body: Record<string, unknown>) {
    // 模型不收 body 里那一对：谁都不能给某个 Bot 单独挑一个模型。
    const pinned = await defaultBotModel(db)
    return {
      description: typeof body.description === 'string' ? body.description.trim() : '',
      prompt: typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim() : DEFAULT_BOT_PROMPT,
      greeting: typeof body.greeting === 'string' ? body.greeting.trim() : '',
      escalate: typeof body.escalate === 'string' ? body.escalate.trim() : '',
      escalateTo: escalateToOf(body.escalateTo),
      guards: botGuardsOf(body.guards),
      browser: botBrowserOf(body.browser),
      memory: botMemoryOf(body.memory),
      icon: botIconOf(body.icon, owner.scope),
      provider: pinned.provider,
      model: pinned.model,
      enabled: true,
      skills: await assignedIds(db, owner, 'skill', body.skills),
      mcps: await assignedIds(db, owner, 'mcp', body.mcps),
    }
  }

  async function applyBotPatch(owner: CatalogOwner, def: Record<string, unknown>, body: Record<string, unknown>) {
    if (body.description !== undefined) def.description = String(body.description).trim()
    if (body.prompt !== undefined) def.prompt = String(body.prompt).trim()
    if (body.greeting !== undefined) def.greeting = String(body.greeting).trim()
    if (body.escalate !== undefined) def.escalate = String(body.escalate).trim()
    if (body.escalateTo !== undefined) def.escalateTo = escalateToOf(body.escalateTo)
    // 传来的是「改动的那几个开关」，跟库里现有的合并——只改一个不该把另外两个带回默认。
    if (body.guards !== undefined) def.guards = botGuardsOf(body.guards, botGuardsOf(def.guards))
    if (body.browser !== undefined) def.browser = botBrowserOf(body.browser, botBrowserOf(def.browser))
    if (body.memory !== undefined) def.memory = botMemoryOf(body.memory, botMemoryOf(def.memory))
    // 写入也走一遍归一化：老键（chat 这些）映射到新的一套，另一层级的键当没传、保留原值。
    if (typeof body.icon === 'string') {
      const key = LEGACY_BOT_ICONS[body.icon.trim()] ?? body.icon.trim()
      if (iconSetFor(owner.scope).has(key)) def.icon = key
    }
    // body 里的 provider / model 一概不看。存下来的这一对只是快照，顺手跟平台对齐；
    // 真正对外报的是 publicBot 读的时候现取的那一对。
    const pinned = await defaultBotModel(db)
    def.provider = pinned.provider
    def.model = pinned.model
    if (typeof body.enabled === 'boolean') def.enabled = body.enabled
    if (Array.isArray(body.skills)) def.skills = await assignedIds(db, owner, 'skill', body.skills)
    if (Array.isArray(body.mcps)) def.mcps = await assignedIds(db, owner, 'mcp', body.mcps)
    return def
  }

  function newSkillDefinition(b: Record<string, unknown>) {
    const source: SkillSource = b.source === '单文件 Skill' || b.source === 'ZIP 包' ? b.source : '手动编写'
    const files = source === 'ZIP 包' ? filesOf(b.files) : []
    const readme = files.find((f) => f.path.toLowerCase() === 'skill.md')
    const now = Date.now()
    const fileName = trimStr(b.fileName)
    const tags = tagsOf(b.tags)
    const definition: Record<string, unknown> = {
      body: source === 'ZIP 包' ? (readme?.text ?? '') : typeof b.body === 'string' ? b.body : '',
      tags,
      source,
      enabled: b.enabled !== false,
      // 新建的默认按需。**存量落常驻**（publicSkill 里那个 fallback），两个默认值方向
      // 相反是有意的：老的那些是在「全文常驻」的年代写的，改口径就是悄悄改行为。
      mode: skillModeOf(b.mode, '按需'),
      createdAt: now,
      updatedAt: now,
    }
    if (fileName) definition.fileName = fileName
    if (files.length) definition.files = files
    return { definition, tags }
  }

  function applySkillPatch(def: Record<string, unknown>, b: Record<string, unknown>) {
    if (typeof b.body === 'string') def.body = b.body
    if (Array.isArray(b.tags)) def.tags = tagsOf(b.tags)
    if (typeof b.enabled === 'boolean') def.enabled = b.enabled
    // 没传就不动：常驻还是按需是人在界面上拨的，改正文不该顺手把它改回默认。
    if (b.mode !== undefined) def.mode = skillModeOf(b.mode, skillModeOf(def.mode, '常驻'))
    const source = def.source === '单文件 Skill' || def.source === 'ZIP 包' ? def.source : '手动编写'
    if (typeof b.body === 'string' && source === 'ZIP 包' && Array.isArray(def.files)) {
      def.files = (def.files as { path: string; text: string }[]).map((f) =>
        f.path.toLowerCase() === 'skill.md' ? { ...f, text: b.body as string } : f,
      )
    }
    def.updatedAt = Date.now()
    return def
  }

  function newMcpDefinition(b: Record<string, unknown>) {
    const kind: McpKind = (MCP_KINDS as readonly string[]).includes(trimStr(b.kind)) ? (trimStr(b.kind) as McpKind) : 'SSE'
    const endpoint = trimStr(b.endpoint)
    if (!endpoint) throw new HttpError(400, kind === 'stdio' ? '要有启动命令' : '要有服务器地址')
    const now = Date.now()
    const token = trimStr(b.token)
    const definition: Record<string, unknown> = {
      kind,
      endpoint,
      env: envOf(b.env),
      perm: (MCP_PERMS as readonly string[]).includes(trimStr(b.perm)) ? trimStr(b.perm) : '只读',
      enabled: b.enabled !== false,
      createdAt: now,
      updatedAt: now,
    }
    if (token) definition.token = token
    return definition
  }

  function applyMcpPatch(def: Record<string, unknown>, b: Record<string, unknown>) {
    if ((MCP_KINDS as readonly string[]).includes(trimStr(b.kind))) def.kind = trimStr(b.kind)
    if (b.endpoint !== undefined) {
      const endpoint = trimStr(b.endpoint)
      const kind = (MCP_KINDS as readonly string[]).includes(trimStr(def.kind)) ? trimStr(def.kind) : 'SSE'
      if (!endpoint) throw new HttpError(400, kind === 'stdio' ? '要有启动命令' : '要有服务器地址')
      def.endpoint = endpoint
    }
    if (b.env !== undefined) def.env = envOf(b.env)
    if ((MCP_PERMS as readonly string[]).includes(trimStr(b.perm))) def.perm = trimStr(b.perm)
    if (typeof b.enabled === 'boolean') def.enabled = b.enabled
    // token 三种意思：没带这个字段=不动，带了空串=清掉，带了内容=换新的。
    if (typeof b.token === 'string') {
      const token = trimStr(b.token)
      if (token) def.token = token
      else delete def.token
    }
    def.updatedAt = Date.now()
    return def
  }

  // ── 全局 Bot / Skill / MCP（owner）。所有公司都看得见，只有 owner 能改。──

  /**
   * 平台目录和公司目录的 CRUD **只写一次**。
   *
   * 这两组路由（bots / skills / mcp-servers 各五条）以前是两份逐字抄出来的实现，
   * 加起来四百多行，差别只有三处：守卫、归属、审计里的 companyId。抄出来的两份必然
   * 会漂——审查时就已经漂出两个 bug：
   *
   *   · `DELETE /platform/skills/tags/:name` 多写了一次 decodeURIComponent，
   *     而路由器早就解过一次了。标签叫「5%折扣」时二次解码抛 URIError，变成 500；
   *     公司侧那条没有这一行。
   *   · `POST /platform/skills/tags` 少了「标签最多 12 个字」那道校验，公司侧有。
   *
   * 收成一个工厂之后，这类漂移在结构上就不可能再出现。CatalogOwner（scope / companyId /
   * auditCompanyId）本来就是为这件事准备的抽象，这里把路由也参数化。
   */
  interface CatalogRouteScope {
    /** 路径前缀：`/platform` 或 `/orgs/:id`。 */
    base: string
    /** 读请求的守卫。返回这次请求的归属。 */
    read(req: Req): Promise<CatalogOwner>
    /** 同 read，多带出账号。私有档要按「是不是管理员、是谁」裁，光有归属不够。 */
    readAs(req: Req): Promise<{ account: Account; owner: CatalogOwner }>
    /** 写请求的守卫。审计要用到账号，所以一并带出来。 */
    write(req: Req): Promise<{ account: Account; owner: CatalogOwner }>
    /** 建东西前确认归属还在。公司会被删，平台不会。 */
    ensure(req: Req): Promise<void>
    /** 这一层能挑的头像。两套不重合，跨层级用会落回本层级默认（见 iconSetFor）。 */
    icons: readonly string[]
    /** 能挂的分组。全局 Bot 挂不了公司分组——那是某一家公司的东西。 */
    groups(owner: CatalogOwner): Promise<{ id: string; name: string }[]>
    /**
     * 这一层还建不建 Bot。
     *
     * 平台侧建的是全局 Bot，照旧。**公司侧不再建**——公司这一层现在是一份 Bot 模版
     * （见 routes/bot-template.ts），Bot 由员工自己建（`POST /runtime/bots`）。这里
     * 只剩「看」和「删」，为的是收拾 0003 停用掉的那批老公司 Bot。
     */
    createsBots: boolean
  }

  const PLATFORM_SCOPE: CatalogRouteScope = {
    base: '/platform',
    async read(req) {
      return (await this.readAs(req)).owner
    },
    async readAs(req) {
      const account = await requireUser(req, db, keys)
      requireOwner(account)
      return { account, owner: GLOBAL_OWNER }
    },
    async write(req) {
      const account = await requireOwnerUser(req, db, keys)
      return { account, owner: GLOBAL_OWNER }
    },
    async ensure() {},
    icons: GLOBAL_BOT_ICONS,
    async groups() {
      return []
    },
    createsBots: true,
  }

  const COMPANY_SCOPE: CatalogRouteScope = {
    base: '/orgs/:id',
    async read(req) {
      return (await this.readAs(req)).owner
    },
    async readAs(req) {
      const account = await requireOrgUser(req, db, keys, req.params.id)
      return { account, owner: companyOwner(req.params.id) }
    },
    async write(req) {
      const account = await requireOrgUser(req, db, keys, req.params.id, true)
      return { account, owner: companyOwner(req.params.id) }
    },
    async ensure(req) {
      if (!(await db.company(req.params.id))) throw new HttpError(404, '公司不存在')
    },
    icons: COMPANY_BOT_ICONS,
    async groups(owner) {
      return (await db.groupsOf(owner.companyId!)).map((g) => ({ id: g.id, name: g.name }))
    },
    createsBots: false,
  }

  /** 这一层**自己拥有**的那一条。全局层只认全局项，公司层只认本公司项——改和删都走它。 */
  async function ownedItem(owner: CatalogOwner, id: string, kind: CatalogKind, missing: string, allowDeleting = false): Promise<CatalogItem> {
    const item = await db.catalog(id)
    const mine =
      owner.scope === 'global'
        ? item?.scope === 'global'
        : item?.scope === 'company' && item.companyId === owner.companyId
    if (!item || item.kind !== kind || !mine) throw new HttpError(404, missing)
    if (item.deletingAt && !allowDeleting) throw new HttpError(409, '这个 Bot 正在完成删除前审计')
    return item
  }

  /**
   * 这一层**看得见**的那一条：本层的，加上全局的。
   *
   * 公司管理员打得开全局 Bot 的详情（能看不能改，写路径走 ownedItem 自然 404）。
   * 平台层没有「上一层」，于是它退化成 ownedItem。
   */
  async function visibleItem(owner: CatalogOwner, id: string, kind: CatalogKind, missing: string): Promise<CatalogItem> {
    const item = await db.catalog(id)
    const mine = owner.scope === 'company' && item?.scope === 'company' && item.companyId === owner.companyId
    if (!item || item.kind !== kind || !(mine || item.scope === 'global')) throw new HttpError(404, missing)
    return item
  }

  /** 这一层自己拥有的全部条目。标签清理要按它遍历，不能连上一层的一起改。 */
  function ownedCatalog(owner: CatalogOwner, kind: CatalogKind): Promise<CatalogItem[]> {
    return owner.scope === 'global' ? db.visibleCatalog(kind, null) : db.companyCatalog(kind, owner.companyId!)
  }

  /** 审计。全局项在 detail 里多带一个 scope，公司项不带——两边原来就是这样。 */
  function auditCatalog(owner: CatalogOwner, accountId: string, action: string, detail: Record<string, unknown>) {
    return db.audit({
      companyId: owner.auditCompanyId,
      accountId,
      action,
      detail: owner.scope === 'global' ? { ...detail, scope: 'global' } : detail,
    })
  }

  function attachCatalogRoutes(s: CatalogRouteScope) {
    // ── Bot ────────────────────────────────────────────────────────────
    router.get(`${s.base}/bots`, async (req, res) => {
      const owner = await s.read(req)
      // 公司侧是「全局 ∪ 本公司」：全局项在界面上只读，写路径由 ownedItem 挡掉。
      const pinned = await defaultBotModel(db)
      json(res, 200, { bots: (await db.visibleCatalog('bot', owner.companyId)).map((i) => publicBot(i, pinned)) })
    })

    // 必须写在 /bots/:botId 前面，否则 options 会被当成 botId。
    router.get(`${s.base}/bots/options`, async (req, res) => {
      const owner = await s.read(req)
      json(res, 200, {
        skills: (await db.visibleCatalog('skill', owner.companyId)).map((i) => ({ id: i.id, name: i.name })),
        mcps: (await db.visibleCatalog('mcp', owner.companyId)).map((i) => ({ id: i.id, name: i.name })),
        groups: await s.groups(owner),
        kbs: [] as { id: string; name: string }[],
        icons: [...s.icons],
      })
    })

    if (s.createsBots) {
      router.post(`${s.base}/bots`, async (req, res) => {
        const { account, owner } = await s.write(req)
        await s.ensure(req)
        const body = bodyOf(req)
        const item = await db.insertCatalog({
          kind: 'bot',
          scope: owner.scope,
          companyId: owner.companyId,
          name: botNameOf(body.name),
          definition: await newBotDefinition(owner, body),
        })
        await auditCatalog(owner, account.id, 'catalog.create', { kind: 'bot', id: item.id })
        json(res, 201, { bot: publicBot(item, await defaultBotModel(db)) })
      })
    }

    router.get(`${s.base}/bots/:botId`, async (req, res) => {
      const owner = await s.read(req)
      const item = await visibleItem(owner, req.params.botId, 'bot', '没有这个助理')
      json(res, 200, { bot: publicBot(item, await defaultBotModel(db)) })
    })

    if (s.createsBots) {
      router.patch(`${s.base}/bots/:botId`, async (req, res) => {
        const { account, owner } = await s.write(req)
        const item = await ownedItem(owner, req.params.botId, 'bot', '没有这个助理')
        const body = bodyOf(req)
        const def = await applyBotPatch(owner, botDefOf(item.definition), body)
        const next = await db.updateCatalog(item.id, {
          name: body.name !== undefined ? botNameOf(body.name) : undefined,
          definition: def,
        })
        await auditCatalog(owner, account.id, 'catalog.update', { kind: 'bot', id: item.id })
        json(res, 200, { bot: publicBot(next, await defaultBotModel(db)) })
      })
    }

    /** 全局/公司 Bot 也先冻结并终审所有已部署 pair，成功后再由状态机拆席位。 */
    router.delete(`${s.base}/bots/:botId`, async (req, res) => {
      const { account, owner } = await s.write(req)
      const item = await ownedItem(owner, req.params.botId, 'bot', '没有这个助理', true)
      const deletion = await requestBotDeletion(db, {
        companyId: owner.auditCompanyId,
        accountId: item.accountId,
        botId: item.id,
        botName: item.name,
        requestedBy: account.id,
      })
      const done = deletion.status === 'completed'
      json(res, done ? 200 : 202, done
        ? { deleted: true, id: item.id, seats: 'releasedSeats' in deletion ? deletion.releasedSeats : 0, orphans: deletion.orphans, deletion }
        : { deleting: true, id: item.id, deletion })
    })

    /**
     * 一份 Skill 清单：全局 ∪ 本公司 ∪ **这家公司里 Bot 自己写下的那些**（`origin: 'seat'`）。
     *
     * 私有档也要出现在这一屏，理由见 docs/skills.md §7：Bot 给自己写下的方法会持续改变
     * 它的行为，攒在某个地方而界面上翻不到，等于给自己造一个查不了的故障源。
     *
     * **重名序号在这里算一次**（skillDisplayNames）。席位那边按「这颗 Bot 看得见的那些」
     * 另算一次，两份可能对不齐——只可能发生在两颗 Bot 各自写了同名的私有档时，而那时
     * 席位上的那份才是模型用的，这一屏是给人看的。
     *
     * **私有档按人裁**：管理员 / owner 看全公司的（§7「员工 + 管理员」），普通成员只看
     * 自己名下 Bot 写的。这条接口成员也调（编辑自己的 Bot 要挑 Skill），而私有档的正文
     * 是模型从员工对话里写下来的——同事之间不该互相翻得到。
     */
    async function listSkills(owner: CatalogOwner, account: Account) {
      const items = await db.visibleCatalog('skill', owner.companyId)
      if (owner.companyId) {
        const admin = account.role === 'owner' || account.role === 'admin'
        items.push(...(await (admin
          ? db.companySeatSkills(owner.companyId)
          : db.accountSeatSkills(owner.companyId, account.id))))
      }
      const names = skillDisplayNames(items)
      return items.map((i) => publicSkill(i, names.get(i.id)))
    }

    // ── Skill ──────────────────────────────────────────────────────────
    router.get(`${s.base}/skills`, async (req, res) => {
      const { account, owner } = await s.readAs(req)
      json(res, 200, {
        skills: await listSkills(owner, account),
        servers: (await db.visibleCatalog('mcp', owner.companyId)).map(publicServer),
        tags: await knownTags(db, owner.auditCompanyId),
      })
    })

    router.post(`${s.base}/skills`, async (req, res) => {
      const { account, owner } = await s.write(req)
      await s.ensure(req)
      const b = bodyOf(req)
      const { definition, tags } = newSkillDefinition(b)
      const item = await db.insertCatalog({
        kind: 'skill',
        scope: owner.scope,
        companyId: owner.companyId,
        name: namedOf(b.name),
        definition,
      })
      await rememberTags(db, owner.auditCompanyId, tags)
      await auditCatalog(owner, account.id, 'catalog.create', { kind: 'skill', id: item.id })
      json(res, 201, { skill: publicSkill(item) })
    })

    // 标签这两条要排在 /skills/:skillId 前面：段数一样，先注册的先中。
    router.post(`${s.base}/skills/tags`, async (req, res) => {
      const { owner } = await s.write(req)
      await s.ensure(req)
      const tag = namedOf(bodyOf(req).name)
      // 平台侧以前漏了这道，同一个弹窗在两个作用域下规则不一样。
      if (tag.length > 12) throw new HttpError(400, '标签最多 12 个字')
      await rememberTags(db, owner.auditCompanyId, [tag])
      json(res, 201, { tags: await knownTags(db, owner.auditCompanyId) })
    })

    router.delete(`${s.base}/skills/tags/:name`, async (req, res) => {
      const { owner } = await s.write(req)
      // **不要再 decodeURIComponent 一次**：Router.match 已经解过了（见 http.ts）。
      // 二次解码遇到含 % 的标签会抛 URIError，兜底 catch 把它变成 500。
      const tag = req.params.name
      await db.deleteSkillTag(owner.auditCompanyId, tag)
      let touched = 0
      for (const item of await ownedCatalog(owner, 'skill')) {
        const def = asDef(item.definition)
        const tags = Array.isArray(def.tags) ? def.tags.map((x) => String(x)) : []
        if (!tags.includes(tag)) continue
        def.tags = tags.filter((x) => x !== tag)
        def.updatedAt = Date.now()
        await db.updateCatalog(item.id, { definition: def })
        touched++
      }
      json(res, 200, { tags: await knownTags(db, owner.auditCompanyId), touched })
    })

    /**
     * 把一条「Bot 自己写的」转成公司 Skill。**人点的，没有自动晋升。**
     *
     * 公司目录是所有人共用的东西，往里写只能是人的决定——「攒够几次就自动提升」听着
     * 省事，实际是让一颗 Bot 的一次误判长到全公司身上（docs/skills.md §7）。
     *
     * 只在公司这一层有：全局目录不收私有档。
     */
    router.post(`${s.base}/skills/:skillId/promote`, async (req, res) => {
      const { account, owner } = await s.write(req)
      if (owner.scope !== 'company') throw new HttpError(400, '私有档只能转成公司 Skill')
      const item = await db.catalog(req.params.skillId)
      if (!item || item.kind !== 'skill' || item.scope !== 'user' || item.companyId !== owner.companyId) {
        throw new HttpError(404, '没有这个 Skill')
      }
      const next = await db.promoteSkill(item.id)
      await auditCatalog(owner, account.id, 'catalog.promote', {
        kind: 'skill',
        id: item.id,
        name: item.name,
        botId: item.botId,
      })
      json(res, 200, { skill: publicSkill(next, next.name) })
    })

    router.get(`${s.base}/skills/:skillId`, async (req, res) => {
      const owner = await s.read(req)
      // 读详情用 visibleItem：列表给的是「全局 ∪ 本公司」，详情却只认本公司的话，
      // 点开自己列表里那条平台发布的 Skill 会得到一句「没有这个 Skill」。写路径下面
      // 两条仍然走 ownedItem——全局项能看不能改，和 Bot 那条路一致。
      /**
       * 详情多带一份**包里的文件清单**（路径 + 字节数，不带正文）。
       *
       * 列表那一屏不带它：一屏几十条 Skill，每条再挂一份两百行的清单，翻一次目录页
       * 就是几百 KB。而详情是点开一条才拉的，那时管理员正想核对包里到底有什么——
       * 这些文件现在真的会下发到席位、被模型读到。
       */
      const item = await visibleItem(owner, req.params.skillId, 'skill', '没有这个 Skill')
      json(res, 200, {
        skill: {
          ...publicSkill(item),
          files: skillFiles(item).map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.text) })),
        },
      })
    })

    router.patch(`${s.base}/skills/:skillId`, async (req, res) => {
      const { account, owner } = await s.write(req)
      const item = await ownedItem(owner, req.params.skillId, 'skill', '没有这个 Skill')
      const b = bodyOf(req)
      const def = applySkillPatch(asDef(item.definition), b)
      const next = await db.updateCatalog(item.id, { name: b.name !== undefined ? namedOf(b.name) : undefined, definition: def })
      if (Array.isArray(def.tags)) await rememberTags(db, owner.auditCompanyId, def.tags.map((x) => String(x)))
      await auditCatalog(owner, account.id, 'catalog.update', { kind: 'skill', id: item.id })
      json(res, 200, { skill: publicSkill(next) })
    })

    router.delete(`${s.base}/skills/:skillId`, async (req, res) => {
      const { account, owner } = await s.write(req)
      /**
       * 管理员也删得掉「Bot 自己写的」那一档。
       *
       * `ownedItem` 只认本公司的 `company` 项，而私有档是 `user` 项——不放这一条，
       * 界面上那颗「删掉」按钮就是个 404。能看见却处理不了，比看不见更糟：它把一条
       * 「这颗 Bot 学歪了」的线索变成一次死路（docs/skills.md §7）。
       */
      const seat =
        owner.scope === 'company' ? await db.catalog(req.params.skillId) : undefined
      const isSeat = seat?.kind === 'skill' && seat.scope === 'user' && seat.companyId === owner.companyId
      const item = isSeat ? seat! : await ownedItem(owner, req.params.skillId, 'skill', '没有这个 Skill')
      await db.deleteCatalog(item.id)
      await auditCatalog(owner, account.id, 'catalog.delete', {
        kind: 'skill',
        id: item.id,
        ...(isSeat ? { scope: 'seat', botId: item.botId, name: item.name } : {}),
      })
      json(res, 200, { deleted: true, id: item.id })
    })

    // ── MCP ────────────────────────────────────────────────────────────
    router.get(`${s.base}/mcp-servers`, async (req, res) => {
      const owner = await s.read(req)
      json(res, 200, { servers: (await db.visibleCatalog('mcp', owner.companyId)).map(publicServer) })
    })

    router.post(`${s.base}/mcp-servers`, async (req, res) => {
      const { account, owner } = await s.write(req)
      await s.ensure(req)
      const b = bodyOf(req)
      const item = await db.insertCatalog({
        kind: 'mcp',
        scope: owner.scope,
        companyId: owner.companyId,
        name: namedOf(b.name),
        definition: newMcpDefinition(b),
      })
      await auditCatalog(owner, account.id, 'catalog.create', { kind: 'mcp', id: item.id })
      json(res, 201, { server: publicServer(item) })
    })

    router.get(`${s.base}/mcp-servers/:serverId`, async (req, res) => {
      const owner = await s.read(req)
      // 同 skill 详情：列表看得见的，详情就得打得开。
      json(res, 200, { server: publicServer(await visibleItem(owner, req.params.serverId, 'mcp', '没有这个 MCP 服务器')) })
    })

    router.patch(`${s.base}/mcp-servers/:serverId`, async (req, res) => {
      const { account, owner } = await s.write(req)
      const item = await ownedItem(owner, req.params.serverId, 'mcp', '没有这个 MCP 服务器')
      const b = bodyOf(req)
      const def = applyMcpPatch(asDef(item.definition), b)
      const next = await db.updateCatalog(item.id, { name: b.name !== undefined ? namedOf(b.name) : undefined, definition: def })
      await auditCatalog(owner, account.id, 'catalog.update', { kind: 'mcp', id: item.id })
      json(res, 200, { server: publicServer(next) })
    })

    router.delete(`${s.base}/mcp-servers/:serverId`, async (req, res) => {
      const { account, owner } = await s.write(req)
      const item = await ownedItem(owner, req.params.serverId, 'mcp', '没有这个 MCP 服务器')
      await db.deleteCatalog(item.id)
      await auditCatalog(owner, account.id, 'catalog.delete', { kind: 'mcp', id: item.id })
      json(res, 200, { deleted: true, id: item.id })
    })
  }

  attachCatalogRoutes(PLATFORM_SCOPE)
  attachCatalogRoutes(COMPANY_SCOPE)

  // ── 公司目录（admin）。bots 走上面那组，形状不同。────────────────

  for (const name of ['models'] as const) {
    const kind = kindOf(name)
    router.get(`/orgs/:id/${name}`, async (req, res) => {
      await requireOrgUser(req, db, keys, req.params.id)
      json(res, 200, { items: (await db.companyCatalog(kind, req.params.id)).map(publicCatalog) })
    })
    router.post(`/orgs/:id/${name}`, async (req, res) => {
      const account = await requireOrgUser(req, db, keys, req.params.id, true)
      if (!await db.company(req.params.id)) throw new HttpError(404, '公司不存在')
      const body = bodyOf(req)
      const name = strField(body, 'name')
      const item = await db.insertCatalog({
        kind,
        scope: 'company',
        companyId: req.params.id,
        name,
        // 现在这一组只有 models；再加一种要给它配自己的校验，别让新种类顺着这条路原样入库。
        definition: kind === 'model' ? await companyModelDefinition(body.definition, name) : body.definition ?? {},
      })
      await db.audit({ companyId: req.params.id, accountId: account.id, action: 'catalog.create', detail: { kind, id: item.id } })
      json(res, 201, { item: publicCatalog(item) })
    })
    router.get(`/orgs/:id/${name}/:itemId`, async (req, res) => {
      await requireOrgUser(req, db, keys, req.params.id)
      const item = await db.catalog(req.params.itemId)
      if (!item || item.kind !== kind || item.companyId !== req.params.id) throw new HttpError(404, '目录项不存在')
      json(res, 200, { item: publicCatalog(item) })
    })
    router.patch(`/orgs/:id/${name}/:itemId`, async (req, res) => {
      const account = await requireOrgUser(req, db, keys, req.params.id, true)
      const item = await db.catalog(req.params.itemId)
      if (!item || item.kind !== kind || item.companyId !== req.params.id) throw new HttpError(404, '目录项不存在')
      const body = bodyOf(req)
      const name = body.name != null ? strField(body, 'name') : undefined
      const next = await db.updateCatalog(item.id, {
        name,
        definition:
          kind === 'model' && body.definition !== undefined
            ? await companyModelDefinition(body.definition, name ?? item.name)
            : body.definition,
      })
      await db.audit({ companyId: req.params.id, accountId: account.id, action: 'catalog.update', detail: { kind, id: item.id } })
      json(res, 200, { item: publicCatalog(next) })
    })
    router.delete(`/orgs/:id/${name}/:itemId`, async (req, res) => {
      const account = await requireOrgUser(req, db, keys, req.params.id, true)
      const item = await db.catalog(req.params.itemId)
      if (!item || item.kind !== kind || item.companyId !== req.params.id) throw new HttpError(404, '目录项不存在')
      await db.deleteCatalog(item.id)
      await db.audit({ companyId: req.params.id, accountId: account.id, action: 'catalog.delete', detail: { kind, id: item.id } })
      json(res, 200, { deleted: true, id: item.id })
    })
  }
}
