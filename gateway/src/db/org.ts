/**
 * 公司、账号、席位密钥、分组、邀请。
 *
 * 放在一个文件里是因为它们互相调：建账号要发席位密钥，取密钥要读账号，删账号要改分组、
 * 清邀请。
 */
import { randomUUID } from 'node:crypto'
import { randomAccessToken, randomApiKey } from '../crypto.ts'
import type { Account, AccountExpect, AccountPatch, AccountSecrets, AccountStatus, Company, Group, Invite, Role } from './types.ts'
import { accountOf, companyOf, groupOf, inviteOf, isUniqueViolation, nameFromEmail, num, type Row, str } from './rows.ts'
import { DbCore } from './core.ts'

export class OrgDb extends DbCore {
  // ── 公司 ──────────────────────────────────────────────────────────────

  async insertCompany(
    input: {
      slug: string
      name: string
    } & Partial<Pick<Company, 'contactName' | 'contactPhone' | 'contactEmail' | 'address' | 'website'>>,
  ): Promise<Company> {
    const now = Date.now()
    const row: Company = {
      id: randomUUID(),
      slug: input.slug,
      name: input.name,
      status: 'active',
      contactName: input.contactName ?? '',
      contactPhone: input.contactPhone ?? '',
      contactEmail: input.contactEmail ?? '',
      address: input.address ?? '',
      website: input.website ?? '',
      machineId: null,
      accessUrl: null,
      handoffWebhook: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.run(
      'insert into companies (id, slug, name, status, "contactName", "contactPhone", "contactEmail", address, website, "machineId", "accessUrl", "createdAt", "updatedAt") values (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        row.id,
        row.slug,
        row.name,
        row.status,
        row.contactName,
        row.contactPhone,
        row.contactEmail,
        row.address,
        row.website,
        row.machineId,
        row.accessUrl,
        row.createdAt,
        row.updatedAt,
      ],
    )
    return row
  }

  async company(id: string): Promise<Company | undefined> {
    const r = await this.one('select * from companies where id = ?', [id])
    return r ? companyOf(r) : undefined
  }

  async companyBySlug(slug: string): Promise<Company | undefined> {
    const r = await this.one('select * from companies where slug = ?', [slug])
    return r ? companyOf(r) : undefined
  }

  async updateCompany(
    id: string,
    patch: Partial<
      Pick<
        Company,
        | 'name'
        | 'slug'
        | 'status'
        | 'contactName'
        | 'contactPhone'
        | 'contactEmail'
        | 'address'
        | 'website'
        | 'machineId'
        | 'accessUrl'
        | 'handoffWebhook'
      >
    >,
  ): Promise<Company> {
    const cur = await this.company(id)
    if (!cur) throw new Error('公司不存在')
    const next: Company = {
      ...cur,
      name: patch.name ?? cur.name,
      slug: patch.slug ?? cur.slug,
      status: patch.status ?? cur.status,
      contactName: patch.contactName ?? cur.contactName,
      contactPhone: patch.contactPhone ?? cur.contactPhone,
      contactEmail: patch.contactEmail ?? cur.contactEmail,
      address: patch.address ?? cur.address,
      website: patch.website ?? cur.website,
      machineId: patch.machineId === undefined ? cur.machineId : patch.machineId,
      accessUrl: patch.accessUrl === undefined ? cur.accessUrl : patch.accessUrl,
      handoffWebhook: patch.handoffWebhook === undefined ? cur.handoffWebhook : patch.handoffWebhook,
      updatedAt: Date.now(),
    }
    await this.run(
      'update companies set slug=?, name=?, status=?, "contactName"=?, "contactPhone"=?, "contactEmail"=?, address=?, website=?, "machineId"=?, "accessUrl"=?, "handoffWebhook"=?, "updatedAt"=? where id=?',
      [
        next.slug,
        next.name,
        next.status,
        next.contactName,
        next.contactPhone,
        next.contactEmail,
        next.address,
        next.website,
        next.machineId,
        next.accessUrl,
        next.handoffWebhook,
        next.updatedAt,
        id,
      ],
    )
    return next
  }

  /**
   * 硬删一家公司。**整串在一个事务里。**
   *
   * 十几条依赖删除要么一起成、要么一起不成：中途失败（连接断、后加的表带上外键、池子
   * 出错）留下的是一家「公司行还在、账号和席位已经没了」的半删公司——界面上照样列得
   * 出来，而管理员账号已经没了，没人能登进去看。
   *
   * 事务开在这儿而不是只靠调用方：`tx` 是可重入的（已经在事务里就直接跑），所以路由
   * 那侧现有的 `db.tx(() => db.deleteCompany(...))` 照旧生效，同时这条不变量不再取决于
   * 「每一个未来的调用方都记得包一层」。deleteAccount / deleteBot 也是这个写法。
   */
  async deleteCompany(id: string): Promise<void> {
    await this.tx(async () => {
    await this.run('delete from conversation_audit_items where "companyId" = ?', [id])
    await this.run('delete from conversation_audit_batches where "companyId" = ?', [id])
    await this.run('delete from bot_deletion_requests where "companyId" = ?', [id])
    await this.run('delete from channel_bindings where "companyId" = ?', [id])
    await this.run('delete from groups where "companyId" = ?', [id])
    await this.run('delete from skill_tags where "companyId" = ?', [id])
    await this.run('delete from session_index where "companyId" = ?', [id])
    await this.run('delete from instances where "companyId" = ?', [id])
    await this.run('delete from seat_runtimes where "companyId" = ?', [id])
    await this.run('delete from audit_events where "companyId" = ?', [id])
    await this.run('delete from settings where "companyId" = ?', [id])
    await this.run('delete from credentials where "companyId" = ?', [id])
    await this.run('delete from catalog_items where "companyId" = ?', [id])
    // 知识库三张从表都 on delete cascade 挂在 knowledge_bases 上。Upstash 命名空间和
    // 原文件不在库里，由路由那侧在删之前列出来、回完包再清（routes/company.ts）。
    await this.run('delete from knowledge_bases where "companyId" = ?', [id])
    await this.run('update machines set "companyId" = null where "companyId" = ?', [id])
    // machine_pairings."companyId" 有真外键指向 companies(id)。漏了这一条，最后那句
    // `delete from companies` 对**任何配对过机器的公司**都会外键报错，整条删除永远
    // 走不通。machines 那行是解绑（机器要留着重派），配对码则是一次性的，直接删。
    await this.run('delete from machine_pairings where "companyId" = ?', [id])
    await this.run('delete from invites where "companyId" = ?', [id])
    // **用量不删。** llm_calls 属于必须留档的记录，路由那道闸已经挡住「有用量的公司
    // 不许硬删」；这里不留销毁语句，免得将来有别的调用方绕过闸把它抹掉。表上没有指向
    // companies 的外键，公司行没了这些记录照样留得住。
    await this.run('delete from account_secrets where "accountId" in (select id from accounts where "companyId" = ?)', [id])
    await this.run('delete from accounts where "companyId" = ?', [id])
    await this.run('delete from plans where "companyId" = ?', [id])
    // 账单挂在订单上，先账单后订单，否则外键把订单卡住。
    await this.run('delete from topups where "companyId" = ?', [id])
    await this.run('delete from invoices where "companyId" = ?', [id])
    await this.run('delete from plan_orders where "companyId" = ?', [id])
    await this.run('delete from companies where id = ?', [id])
    })
  }

  /**
   * 这家公司还剩多少条**要留档**的记录。
   *
   * 账单和用量有留存要求，而 deleteCompany 是硬删——两者冲突时以留档为准，
   * 所以删除路由拿它来决定是不是该改走「停用」。
   */
  async billingFootprint(id: string): Promise<{ invoices: number; orders: number; topups: number; llmCalls: number }> {
    const n = (r: Row | undefined) => Number((r as { n?: unknown } | undefined)?.n ?? 0)
    // 表名写死在四条语句里，不拼字符串——这个文件里的 SQL 一律只有占位符是变的。
    return {
      invoices: n(await this.one('select count(*)::int as n from invoices where "companyId" = ?', [id])),
      orders: n(await this.one('select count(*)::int as n from plan_orders where "companyId" = ?', [id])),
      topups: n(await this.one('select count(*)::int as n from topups where "companyId" = ?', [id])),
      llmCalls: n(await this.one('select count(*)::int as n from llm_calls where "companyId" = ?', [id])),
    }
  }

  async companies(): Promise<Company[]> {
    const rows = await this.many('select * from companies order by "createdAt"')
    return rows.map(companyOf)
  }

  // ── 账号 ──────────────────────────────────────────────────────────────

  async insertAccount(input: {
    companyId: string | null
    email: string
    passwordHash: string
    role: Role
    name?: string
    status?: AccountStatus
  }): Promise<Account> {
    let companyId = input.companyId
    if (input.role === 'owner') {
      if (companyId) throw new Error('owner 不能属于公司')
      companyId = null
    } else if (input.role === 'admin' || input.role === 'member') {
      if (!companyId) throw new Error('admin/member 必须属于公司')
    } else {
      throw new Error('未知角色')
    }
    const now = Date.now()
    const email = input.email
    const row: Account = {
      id: randomUUID(),
      companyId,
      email,
      name: (input.name ?? '').trim() || nameFromEmail(email),
      title: '',
      phone: '',
      theme: 'system',
      locale: 'zh',
      passwordHash: input.passwordHash,
      role: input.role,
      status: input.status ?? 'active',
      lastSeenAt: null,
      passwordChangedAt: null,
      tokenRevokedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.run(
      'insert into accounts (id, "companyId", email, name, title, phone, theme, locale, "passwordHash", role, status, "lastSeenAt", "passwordChangedAt", "tokenRevokedAt", "createdAt", "updatedAt") values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        row.id,
        row.companyId,
        row.email,
        row.name,
        row.title,
        row.phone,
        row.theme,
        row.locale,
        row.passwordHash,
        row.role,
        row.status,
        row.lastSeenAt,
        row.passwordChangedAt,
        row.tokenRevokedAt,
        row.createdAt,
        row.updatedAt,
      ],
    )
    if (row.role === 'admin' || row.role === 'member') await this.issueAccountSecrets(row.id)
    return row
  }

  async account(id: string): Promise<Account | undefined> {
    const r = await this.one('select * from accounts where id = ?', [id])
    return r ? accountOf(r) : undefined
  }

  async accountByEmail(email: string): Promise<Account | undefined> {
    const r = await this.one('select * from accounts where email = ?', [email])
    return r ? accountOf(r) : undefined
  }

  async accountsOf(companyId: string): Promise<Account[]> {
    const rows = await this.many('select * from accounts where "companyId" = ? order by "createdAt"', [companyId])
    return rows.map(accountOf)
  }

  async accountsAll(): Promise<Account[]> {
    const rows = await this.many('select * from accounts order by "createdAt"')
    return rows.map(accountOf)
  }

  async owners(): Promise<Account[]> {
    const rows = await this.many("select * from accounts where role = 'owner' order by \"createdAt\"")
    return rows.map(accountOf)
  }

  /** 占用席位：本公司非停用账号（owner 本来就不属于公司）。 */
  /**
   * 占席位这件事要串起来做：在事务里先锁住这家公司的套餐行，再数人、再写人。
   * 不锁的话两个请求可能同时读到「还剩一个席位」，各自放行，超出上限。
   */
  async lockPlan(companyId: string): Promise<void> {
    await this.one('select 1 from plans where "companyId" = ? for update', [companyId])
  }

  /** 占着席位的人：算 active 和 invited（邀请也占位），不算停用的，也不算 owner。 */
  async accountCount(companyId: string): Promise<number> {
    const r = await this.one(
      "select count(*) as n from accounts where \"companyId\" = ? and status != 'disabled' and role != 'owner'",
      [companyId],
    )
    return Number(r?.n ?? 0)
  }

  /**
   * 「至少留一个管理员」的那把锁。数 adminCount 再写之前先拿它，**必须在 db.tx 里调**
   * （同 lockExclusive）。不锁的话两个管理员同时互相降级 / 停用 / 删除，各自数到 2、各自
   * 放行，公司就一个管理员都不剩了。按公司散列，不同公司互不等。
   */
  async lockCompanyAdmins(companyId: string): Promise<void> {
    await this.xactLock('lockCompanyAdmins', `company_admins:${companyId}`)
  }

  /**
   * 「至少留一个能登录的系统管理员」的那把锁，道理同 lockCompanyAdmins。平台账号全库只有
   * 一队，键里折进 schema 名，e2e 各套 schema 之间不互相排队。
   */
  async lockPlatformOwners(): Promise<void> {
    this.requireTx('lockPlatformOwners')
    // 键在 SQL 那侧拼（要折进 current_schema()），所以不走 xactLock。
    await this.one("select pg_advisory_xact_lock(hashtext(current_schema() || ':platform_owners'))")
  }

  /** 还能管事的管理员：未停用的 admin（含待接受）。最后一个管理员靠它守门。 */
  /**
   * 还能登录的系统管理员有几个。停用最后一个之前要问它——平台账号不属于任何公司，
   * adminCount 那条按公司数的检查够不着它，而停完就再没有任何一条路能把它开回来。
   */
  async activeOwnerCount(): Promise<number> {
    const r = await this.one("select count(*) as n from accounts where role = 'owner' and status != 'disabled'")
    return Number(r?.n ?? 0)
  }

  async adminCount(companyId: string): Promise<number> {
    const r = await this.one(
      "select count(*) as n from accounts where \"companyId\" = ? and role = 'admin' and status != 'disabled'",
      [companyId],
    )
    return Number(r?.n ?? 0)
  }

  /**
   * 改账号：**只写补丁里出现的列**，一条 `update … returning *` 落完。
   *
   * 以前是先整行读出来、合并补丁、再把十一列全写回去，中间不锁也不开事务。两个请求前后脚
   * 改同一个人（管理员停用 + 这个人正在登录记 lastSeenAt），后写的那个会把先写的那几列
   * 用它手上的旧值盖回去——停用当场被「登录」改回 active。现在各写各的列，互不覆盖。
   *
   * 取值规矩和原来一样：theme / locale / role / status / passwordHash 传 null 当没传
   * （这几列不能空）；其余几列 null 就是清空。
   */
  async updateAccount(id: string, patch: AccountPatch): Promise<Account> {
    const next = await this.updateAccountIf(id, patch, {})
    if (!next) throw new Error('账号不存在')
    return next
  }

  /**
   * 带条件的改：`expect` 里写的是「我读到、并据此做了判断的那一刻的值」，库里已经不是
   * 这个值就一行都不改，返回 undefined——比较和写入在同一条语句里，中间插不进别人。
   *
   * - `status`：当前状态必须是其中之一（登录只认 active，接受邀请不认 disabled）
   * - `passwordHash` / `tokenRevokedAt`：口令和作废点没被别人动过（改口令、登录顺手升级
   *   哈希都靠它让管理员的重置赢）
   */
  async updateAccountIf(id: string, patch: AccountPatch, expect: AccountExpect): Promise<Account | undefined> {
    const sets: string[] = []
    const params: unknown[] = []
    const put = (col: string, v: unknown) => {
      sets.push(`"${col}"=?`)
      params.push(v)
    }
    for (const k of ['name', 'title', 'phone', 'lastSeenAt', 'passwordChangedAt', 'tokenRevokedAt'] as const) {
      if (patch[k] !== undefined) put(k, patch[k])
    }
    for (const k of ['theme', 'locale', 'role', 'status', 'passwordHash'] as const) {
      if (patch[k] != null) put(k, patch[k])
    }
    put('updatedAt', Date.now())
    const where = ['id=?']
    params.push(id)
    if (expect.status) {
      if (!expect.status.length) return undefined
      where.push(`status in (${expect.status.map(() => '?').join(',')})`)
      params.push(...expect.status)
    }
    if (expect.passwordHash !== undefined) {
      where.push('"passwordHash"=?')
      params.push(expect.passwordHash)
    }
    if (expect.tokenRevokedAt !== undefined) {
      where.push('"tokenRevokedAt" is not distinct from ?')
      params.push(expect.tokenRevokedAt)
    }
    const r = await this.one(`update accounts set ${sets.join(', ')} where ${where.join(' and ')} returning *`, params)
    return r ? accountOf(r) : undefined
  }

  async deleteAccount(id: string): Promise<void> {
    await this.tx(async () => {
      const cur = await this.account(id)
      await this.deleteInvitesForUser(id)
      await this.run('delete from session_index where "accountId" = ?', [id])
      await this.run('delete from instances where "accountId" = ?', [id])
      await this.run('delete from seat_runtimes where "accountId" = ?', [id])
      await this.run('delete from channel_bindings where "accountId" = ?', [id])
      // 同上：删员工也不销毁他的用量记录。少了它，公司的历史用量会凭空缺一块，而
      // 「谁烧了多少」正是要留档的东西。accountId 变成悬空引用，统计里按 id 显示。
      await this.run('delete from account_secrets where "accountId" = ?', [id])
      // 他自己建的 Bot 跟着他走。catalog_items."accountId" 是真外键，留着这几行的话
      // 最后那句 delete from accounts 会直接外键报错，删员工整条路走不通。
      await this.run('delete from catalog_items where scope = \'user\' and "accountId" = ?', [id])
      if (cur?.companyId) {
        for (const g of await this.groupsOf(cur.companyId)) {
          if (!g.members.includes(id)) continue
          await this.updateGroup(g.id, { members: g.members.filter((m) => m !== id) })
        }
      }
      await this.run('delete from accounts where id = ?', [id])
    })
  }

  // ── 席位密钥。明文存，详情页给 owner 看；列表接口不许带出去。────────

  async accountSecrets(accountId: string): Promise<AccountSecrets | undefined> {
    const r = await this.one('select * from account_secrets where "accountId" = ?', [accountId])
    if (!r) return undefined
    return {
      accountId: str(r.accountId),
      apiKey: str(r.apiKey),
      accessToken: str(r.accessToken),
      createdAt: num(r.createdAt),
    }
  }

  async issueAccountSecrets(accountId: string): Promise<AccountSecrets | undefined> {
    const existing = await this.accountSecrets(accountId)
    if (existing) return existing
    const account = await this.account(accountId)
    if (!account || account.role === 'owner') return undefined
    for (let i = 0; i < 8; i++) {
      const apiKey = randomApiKey()
      const accessToken = randomAccessToken()
      const createdAt = Date.now()
      try {
        await this.savepoint(() =>
          this.run(
            'insert into account_secrets ("accountId", "apiKey", "accessToken", "createdAt") values (?,?,?,?)',
            [accountId, apiKey, accessToken, createdAt],
          ),
        )
        return { accountId, apiKey, accessToken, createdAt }
      } catch (e) {
        if (!isUniqueViolation(e)) throw e
        /**
         * 冲突分两种，处理方式相反。
         *
         * `accountId` 是主键：并发的另一次调用先插进去了，重试多少次都是同一个冲突，
         * 正确结果就在库里，回读一次即可（installConnector 就是这么写的）。只有
         * apiKey / accessToken 撞了才轮得到「换一串再试」。
         */
        const raced = await this.accountSecrets(accountId)
        if (raced) return raced
        if (i === 7) throw e
      }
    }
    return undefined
  }

  /** 旧席位部署时补发。已有则原样返回。 */
  async ensureAccountSecrets(accountId: string): Promise<AccountSecrets | undefined> {
    return this.issueAccountSecrets(accountId)
  }

  /**
   * 桌面端本地 Bot 的那一套凭证（迁移 0041）。还有效就原样给，**早于 `notBefore`（账号的
   * tokenRevokedAt）的就换一套新的**——改口令、被重置之后，旧的那一套和旧登录票一起作废。
   *
   * 换新是一条带条件的 upsert：几颗本地 Bot 同时启动会并发来要，只看「查到的那份过期了」
   * 就各插一套的话，先回去的那颗拿到的票转眼就被后一套顶掉。条件落空（别人刚换过）就读回
   * 别人换好的那一份，大家拿到的是同一套。
   */
  async desktopSecrets(accountId: string, notBefore: number): Promise<AccountSecrets> {
    const read = async () => {
      const r = await this.one('select * from desktop_secrets where "accountId" = ?', [accountId])
      return r
        ? { accountId: str(r.accountId), apiKey: str(r.apiKey), accessToken: str(r.accessToken), createdAt: num(r.createdAt) }
        : undefined
    }
    const cur = await read()
    if (cur && cur.createdAt >= notBefore) return cur
    const r = await this.one(
      `insert into desktop_secrets ("accountId", "apiKey", "accessToken", "createdAt") values (?,?,?,?)
       on conflict ("accountId") do update
         set "apiKey" = excluded."apiKey", "accessToken" = excluded."accessToken", "createdAt" = excluded."createdAt"
         where desktop_secrets."createdAt" < ?
       returning *`,
      [accountId, randomApiKey(), randomAccessToken(), Math.max(Date.now(), notBefore), notBefore],
    )
    if (r) return { accountId: str(r.accountId), apiKey: str(r.apiKey), accessToken: str(r.accessToken), createdAt: num(r.createdAt) }
    const raced = await read()
    if (!raced) throw new Error('桌面端凭证写不进去')
    return raced
  }

  /**
   * 席位那一套只要对得上就认；桌面端那一套还得**不早于账号的 tokenRevokedAt**——它是拿登录票
   * 换来的，登录票作废了它也跟着作废（见迁移 0041）。
   */
  async accountByApiKey(key: string): Promise<Account | undefined> {
    if (!key) return undefined
    const r =
      (await this.one('select "accountId" from account_secrets where "apiKey" = ?', [key])) ??
      (await this.one(
        `select d."accountId" from desktop_secrets d join accounts a on a.id = d."accountId"
          where d."apiKey" = ? and d."createdAt" >= coalesce(a."tokenRevokedAt", 0)`,
        [key],
      ))
    return r ? this.account(str(r.accountId)) : undefined
  }

  async accountByAccessToken(token: string): Promise<Account | undefined> {
    if (!token) return undefined
    const r =
      (await this.one('select "accountId" from account_secrets where "accessToken" = ?', [token])) ??
      (await this.one(
        `select d."accountId" from desktop_secrets d join accounts a on a.id = d."accountId"
          where d."accessToken" = ? and d."createdAt" >= coalesce(a."tokenRevokedAt", 0)`,
        [token],
      ))
    return r ? this.account(str(r.accountId)) : undefined
  }

  // ── 分组。全体成员是算出来的，不进这张表。──────────────────────────

  async groupsOf(companyId: string): Promise<Group[]> {
    const rows = await this.many('select * from groups where "companyId" = ? order by "createdAt"', [companyId])
    return rows.map(groupOf)
  }

  async group(id: string): Promise<Group | undefined> {
    const r = await this.one('select * from groups where id = ?', [id])
    return r ? groupOf(r) : undefined
  }

  async insertGroup(input: {
    companyId: string
    name: string
    desc?: string
    icon?: string
    role: 'admin' | 'member'
    members?: string[]
    agents?: string[]
  }): Promise<Group> {
    const row: Group = {
      id: randomUUID(),
      companyId: input.companyId,
      name: input.name,
      desc: input.desc ?? '',
      icon: input.icon || 'chat',
      role: input.role,
      members: input.members ?? [],
      agents: input.agents ?? [],
      createdAt: Date.now(),
    }
    await this.run(
      'insert into groups (id, "companyId", name, "desc", icon, role, members, agents, "createdAt") values (?,?,?,?,?,?,?,?,?)',
      [
        row.id,
        row.companyId,
        row.name,
        row.desc,
        row.icon,
        row.role,
        JSON.stringify(row.members),
        JSON.stringify(row.agents),
        row.createdAt,
      ],
    )
    return row
  }

  async updateGroup(
    id: string,
    patch: Partial<Pick<Group, 'name' | 'desc' | 'icon' | 'role' | 'members' | 'agents'>>,
  ): Promise<Group> {
    const cur = await this.group(id)
    if (!cur) throw new Error('分组不存在')
    const next: Group = {
      ...cur,
      name: patch.name !== undefined ? patch.name : cur.name,
      desc: patch.desc !== undefined ? patch.desc : cur.desc,
      icon: patch.icon !== undefined ? patch.icon : cur.icon,
      role: patch.role ?? cur.role,
      members: patch.members !== undefined ? patch.members : cur.members,
      agents: patch.agents !== undefined ? patch.agents : cur.agents,
    }
    await this.run('update groups set name=?, "desc"=?, icon=?, role=?, members=?, agents=? where id=?', [
      next.name,
      next.desc,
      next.icon,
      next.role,
      JSON.stringify(next.members),
      JSON.stringify(next.agents),
      id,
    ])
    return next
  }

  async deleteGroup(id: string): Promise<boolean> {
    return (await this.run('delete from groups where id = ?', [id])) > 0
  }

  // ── 邀请 ──────────────────────────────────────────────────────────────

  async putInvite(row: Invite): Promise<Invite> {
    await this.run(
      'insert into invites (id, "userId", "companyId", "createdBy", "createdAt", "expiresAt") values (?,?,?,?,?,?)',
      [row.id, row.userId, row.companyId, row.createdBy, row.createdAt, row.expiresAt],
    )
    return row
  }

  async invite(id: string): Promise<Invite | undefined> {
    const r = await this.one('select * from invites where id = ?', [id])
    return r ? inviteOf(r) : undefined
  }

  async deleteInvitesForUser(userId: string): Promise<void> {
    await this.run('delete from invites where "userId" = ?', [userId])
  }

  async deleteInvite(id: string): Promise<void> {
    await this.run('delete from invites where id = ?', [id])
  }

  /**
   * 把一条邀请**领走**：还没过期就删掉并交回这一行，删不到（不存在、过期、被别人先领了）
   * 就是 undefined。两个人同时拿同一条链接去接受，只有一个能领到。
   */
  async takeInvite(id: string, now: number): Promise<Invite | undefined> {
    const r = await this.one('delete from invites where id = ? and "expiresAt" >= ? returning *', [id, now])
    return r ? inviteOf(r) : undefined
  }
}
