/**
 * 一家公司自己的那一摊：资料、模型角色、员工与分组、订阅、账单、用量、机器。
 */
import type { RouteCtx } from './ctx.ts'
import { HANDOFF_WEBHOOK_ALLOW_PRIVATE } from '../handoff-sweep.ts'
import { HttpError, json, type Req, type Router } from '../http.ts'
import { INVITE_TTL, MIN_PASSWORD, RESET_LINK_TTL, hashPassword } from '../crypto.ts'
import { accessUrlFor } from '../lib/catalog.ts'
import { balanceOf } from '../lib/billing.ts'
import { parseBilling } from '../db.ts'
import { isUniqueViolation } from '../db/rows.ts'
import { bodyOf, deployOptsOf, strField, usd, usdMicros } from '../lib/validate.ts'
import { companyMachineOf, deploySeat, listSeatRuntime, publicMachine, publicSeatRuntime, releaseSeats } from '../deploy.ts'
import { companyStatusOf, emailOf, groupRoleOf, membersInCompany, orgSettings, patchAccount, phoneOf, publicAccount, publicCompany, publicGroup, publicPlan, publicSettings, roleOf, slugOf, stringIds, websiteOf } from '../lib/org.ts'
import { desktopTicketFor, machineHostOf, machineResolver } from '../lib/machines.ts'
import { inviteLinkOf, issueInvite, rangeQuery, requireOrgUser, requireOwner, requireUser, usagePayload } from '../lib/guards.ts'
import { randomUUID } from 'node:crypto'
import { type CompanyStatus, type Group } from '../db.ts'

/**
 * 转人工通知地址的形状检查。
 *
 * **只收 https**：这条 URL 是一把凭据（拿到就能往那个群里发东西），走明文等于把它交给
 * 路上的每一跳。**主机不能是字面的内网 / 回环 / link-local / 云元数据地址**：发通知的是
 * Gateway 进程自己，一条 `https://169.254.169.254/…` 就是拿 Gateway 当跳板去打它所在
 * 网络里的东西。这里只做字面 IP 判断，主机名解析到内网那一层由发送侧（handoff-sweep）
 * 再挡一道。认不出的形状一律 400，不静静地存下一个永远发不出去的值。
 */
export function handoffWebhookOf(raw: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new HttpError(400, '通知地址要是一条 https 链接')
  }
  if (u.protocol !== 'https:' || !u.hostname) throw new HttpError(400, '通知地址要是一条 https 链接')
  // e2e 的假群机器人听在本机；只有这个开关打开时才放过内网地址（发送侧同一个开关）。
  if (HANDOFF_WEBHOOK_ALLOW_PRIVATE) return raw
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) throw new HttpError(400, '通知地址不能指向本机')
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    const private4 =
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    if (private4) throw new HttpError(400, '通知地址不能是内网或本机地址')
  } else if (host.includes(':')) {
    // IPv6：回环、未指定、ULA（fc00::/7）、link-local（fe80::/10）、v4 映射。
    const bare = host.split('%')[0]
    if (
      bare === '::1' ||
      bare === '::' ||
      /^f[cd]/.test(bare) ||
      /^fe[89ab]/.test(bare) ||
      bare.startsWith('::ffff:')
    ) {
      throw new HttpError(400, '通知地址不能是内网或本机地址')
    }
  }
  return raw
}

export function attachCompany(router: Router, ctx: RouteCtx) {
  const { db, keys, llm, meter } = ctx

  // ── 公司 ────────────────────────────────────────────────────────────

  router.get('/orgs/:id', async (req, res) => {
    await requireOrgUser(req, db, keys, req.params.id)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const plan = (await db.plan(company.id))!
    json(res, 200, {
      company: publicCompany(company),
      plan: await publicPlan(db, plan, await db.accountCount(company.id)),
      // 套餐赠送和单独充值分开报，界面上也分开显示——两者的有效期规矩不一样。
      balance: await balanceOf(db, company.id),
    })
  })

  router.patch('/orgs/:id', async (req, res) => {
    const account = await requireOrgUser(req, db, keys, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    const patch: {
      name?: string
      slug?: string
      status?: CompanyStatus
      contactName?: string
      contactPhone?: string
      contactEmail?: string
      address?: string
      website?: string
      machineId?: string | null
      accessUrl?: string | null
      handoffWebhook?: string | null
    } = {}
    if (body.name != null) patch.name = strField(body, 'name')
    if (body.status != null) {
      // 停用是把整家公司关在门外，公司管理员不能自己停自己——停完谁也开不回来。
      requireOwner(account)
      patch.status = companyStatusOf(body.status)
    }
    if (body.contactName != null) patch.contactName = strField(body, 'contactName')
    if (body.contactPhone != null) patch.contactPhone = phoneOf(strField(body, 'contactPhone'))
    if (body.contactEmail != null) patch.contactEmail = emailOf(strField(body, 'contactEmail'))
    // 地址和网站可以清空，空串就是清空。
    if (body.address !== undefined) patch.address = strField(body, 'address', false)
    if (body.website !== undefined) patch.website = websiteOf(strField(body, 'website', false))
    // 转人工的通知地址。空串 = 关掉。形状规矩见 handoffWebhookOf。
    if (body.handoffWebhook !== undefined) {
      const raw = strField(body, 'handoffWebhook', false)
      patch.handoffWebhook = raw ? handoffWebhookOf(raw) : null
    }
    if (body.accessUrl !== undefined) {
      if (body.accessUrl === null || body.accessUrl === '') patch.accessUrl = null
      else patch.accessUrl = strField(body, 'accessUrl')
    }
    if (body.slug != null) {
      patch.slug = slugOf(strField(body, 'slug'))
      // 这一查是为了回一句人话；真正兜底的是 companies.slug 上的唯一约束，两个人同时
      // 改成同一个 slug 时它会挡住第二个（下面把那个异常翻成同一句 409，不是 500）。
      if (patch.slug !== company.slug && await db.companyBySlug(patch.slug)) throw new HttpError(409, '这个 slug 已被占用')
    }
    if (body.machineId !== undefined) {
      if (body.machineId === null || body.machineId === '') {
        const prev = company.machineId
        if (prev) {
          // 和 PUT /platform/machines/:id/company 同一条判据：机器上还有席位就不许解绑。
          // 席位是按公司建的，解绑不会把它们搬走，只会留下一台谁也找不回席位的机器。
          const seats = await db.seatRuntimesOfMachine(prev)
          if (seats.length) throw new HttpError(409, `这台机器上还有 ${seats.length} 个席位，先把它们拆掉再解绑`)
          await db.updateMachine(prev, { companyId: null })
        }
        patch.machineId = null
      } else {
        const machineId = strField(body, 'machineId')
        const machine = await db.machine(machineId)
        if (!machine) throw new HttpError(404, '机器不存在')
        if (machine.companyId && machine.companyId !== company.id) throw new HttpError(409, '这台机器已经派给别的公司')
        // 和 POST /orgs/:id/machine 同一条判据，一个字都不能少：companyId 为空不代表
        // 这台是干净的新机器——公司被删时它会被置空，而机器上的席位还在跑。少了这一句，
        // 那边拦住的认领从这条 PATCH 上原样走过去了。
        if (
          !machine.companyId &&
          machine.pairedAt &&
          account.role !== 'owner' &&
          !(await db.machinePairedBy(machine.id, company.id))
        ) {
          throw new HttpError(403, '这台机器不是本公司配对的，请让系统管理员指派')
        }
        // **改默认，不是换一台。** 以前这里会把原来那台解绑——多机之后那等于把一台正在
        // 跑的机器连同它上面的席位一起踢出公司，容量凭空缩水（POST 那条路已经改掉了）。
        await db.updateMachine(machine.id, { companyId: company.id })
        patch.machineId = machine.id
        // 派机器时写入访问地址。换机器只改解析，地址按 slug 保持。
        const slug = patch.slug ?? company.slug
        patch.accessUrl = company.accessUrl && !(body.slug != null && patch.slug !== company.slug) ? company.accessUrl : accessUrlFor(slug)
      }
    }
    if (patch.slug && patch.slug !== company.slug && (company.accessUrl || patch.machineId || company.machineId)) {
      patch.accessUrl = accessUrlFor(patch.slug)
    }
    let next: Awaited<ReturnType<typeof db.updateCompany>>
    try {
      next = await db.updateCompany(company.id, patch)
    } catch (e) {
      // 上面那一查和这一写之间没有锁，中间有人占走同一个 slug 的话，唯一约束会在这儿
      // 抛。翻成 409：让保存失败得像「被占了」，而不是一次说不清的 500。
      if (patch.slug && isUniqueViolation(e)) throw new HttpError(409, '这个 slug 已被占用')
      throw e
    }
    // 审计里**不躺 webhook 明文**：它是一把凭据（同 platform.tools.web.update 那条的做法），
    // 只记换没换、换成了哪个域名。
    const detail: Record<string, unknown> = { ...patch }
    if ('handoffWebhook' in patch) {
      detail.handoffWebhook = patch.handoffWebhook ? { changed: true, host: new URL(patch.handoffWebhook).host } : null
    }
    await db.audit({ companyId: company.id, accountId: account.id, action: 'org.update', detail })
    json(res, 200, { company: publicCompany(next) })
  })

  router.delete('/orgs/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    // 删公司是**硬删**：账号、审计、发票、订单、充值、用量一起没。这不是公司管理员
    // 该有的权限——「停用」才是公司层面的动作，而且那条已经是 owner-only 了；删除比
    // 停用更不可逆，权限却更松，是说不通的。
    requireOwner(account)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    // 账单**和用量**都要留档，硬删和留档直接冲突：有过任何一条的公司只能停用，不能删。
    // 用量算进来的代价是「发过一条消息的公司就删不掉了」——这是留档要求的必然结果，
    // 不是遗漏。要清理这类公司，走「停用」；真要腾库存得先有一套留存期到期后的归档
    // 流程，那是另一件事，不能靠这个接口顺手做掉。
    const footprint = await db.billingFootprint(company.id)
    const kept = footprint.invoices + footprint.orders + footprint.topups + footprint.llmCalls
    if (kept > 0) {
      throw new HttpError(409, '这家公司有账单或用量记录，必须留档；请改用「停用」而不是删除', footprint)
    }
    /**
     * **先把机器上的席位拆掉。**
     *
     * `deleteCompany` 只是 `delete from seat_runtimes`，随后把 machines.companyId
     * 置空。机器上那套 systemd 单元、noVNC、以及 3200+N / 6081+N 那组端口会继续跑，
     * 而库里再也没有任何指针能找回它们——这台机器改派给别的公司之后，allocateSlot
     * 扫的是一张空表，会把同一批槽位再分出去，新席位起不来。
     *
     * 删账号那条一直是这么做的（见下面的 DELETE /orgs/:id/accounts/:accountId），
     * 删公司这条以前漏了。有账单或用量的公司走不到这里（上面 409 挡着），但
     * 「配了机器、部署了席位、还没发过一条消息」的公司恰好一条记录都没有，删得掉。
     */
    const seats = await db.seatRuntimesOf(company.id)
    try {
      await releaseSeats(db, seats)
    } catch (e) {
      throw new HttpError(502, (e as Error).message)
    }
    await db.tx(() => db.deleteCompany(company.id))
    // 审计写在事务**之后**：deleteCompany 会把这家公司的 audit_events 一起删掉，写在
    // 事务里等于白写。audit_events 没有指向 companies 的外键，公司没了这条也留得住。
    await db.audit({
      companyId: company.id,
      accountId: account.id,
      action: 'org.delete',
      detail: { name: company.name, slug: company.slug, seats: seats.map((x) => x.seatId) },
    })
    json(res, 200, { deleted: true, id: company.id })
  })

  // ── 公司模型角色（日常 / utility）。不存密钥。──────────────────────

  router.get('/orgs/:id/settings', async (req, res) => {
    const account = await requireOrgUser(req, db, keys, req.params.id)
    if (!await db.company(req.params.id)) throw new HttpError(404, '公司不存在')
    // requireOrgUser 放 owner 也放这家公司的任何人，所以这里要再按角色分一次：
    // owner 拿整份（他在公司详情页上要看定价），公司侧只拿模型角色那三样。
    const stored = await db.platformSettings()
    json(res, 200, account.role === 'owner' ? publicSettings(stored) : orgSettings(stored))
  })

  router.put('/orgs/:id/settings', async (req, res) => {
    await requireUser(req, db, keys)
    throw new HttpError(403, '日常和 utility 由系统管理员配置')
  })

  /**
   * ── 连通性探测：**公司这一侧撤了。** ──────────────────────────────
   *
   * 它探的是「这家公司用这个供应商打得通吗」，而那件事只有在公司自己贴 key 的年代
   * 才是一个问题——密钥归平台之后，答案对所有公司都一样，该在平台那一屏问
   * （`POST /platform/llm/test`，routes/platform.ts）。留着它的话，公司管理员在一个
   * 自己既配不了也看不见的东西上按「测试」，通不通都不归他管。
   */

  // ── 席位 / 账号 ─────────────────────────────────────────────────────

  router.get('/orgs/:id/accounts', async (req, res) => {
    const account = await requireOrgUser(req, db, keys, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const plan = await db.plan(company.id)
    const runtimes = account.role === 'owner' ? await db.seatRuntimesOf(company.id) : []
    const byAccount = new Map<string, typeof runtimes>()
    for (const rt of runtimes) {
      const list = byAccount.get(rt.accountId) || []
      list.push(rt)
      byAccount.set(rt.accountId, list)
    }
    const machineOf = machineResolver(db)
    const members = await Promise.all(
      (await db.accountsOf(req.params.id)).map(async (row) => {
        const pub = publicAccount(row)
        if (account.role !== 'owner') return pub
        const list = byAccount.get(row.id) || []
        return { ...pub, runtimes: await Promise.all(list.map(async (rt) => listSeatRuntime(rt, await machineOf(rt)))) }
      }),
    )
    json(res, 200, {
      members,
      // 「全体成员」是算出来的，不落库：新人进来自动在里面。
      groups: [
        {
          id: 'all',
          builtin: true,
          name: '全体成员',
          desc: '所有已加入的成员，自动维护',
          icon: 'users',
          role: null,
          members: members.map((m) => m.id),
          agents: [],
          createdAt: members[0]?.createdAt ?? Date.now(),
        },
        ...(await db.groupsOf(company.id)).map(publicGroup),
      ],
      seats: { total: plan?.seats ?? 0, used: await db.accountCount(company.id) },
      me: publicAccount(account),
    })
  })

  router.post('/orgs/:id/accounts', async (req, res) => {
    const actor = await requireOrgUser(req, db, keys, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    const email = emailOf(strField(body, 'email'))
    const password = strField(body, 'password')
    if (password.length < MIN_PASSWORD) throw new HttpError(400, `口令至少 ${MIN_PASSWORD} 位`)
    const role = roleOf(body.role, 'member')
    const name = strField(body, 'name', false)
    if (await db.accountByEmail(email)) throw new HttpError(409, '这个邮箱已经注册')
    const passwordHash = await hashPassword(password)
    const created = await db.tx(async () => {
      await takeSeat(company.id)
      const row = await db.insertAccount({ companyId: company.id, email, passwordHash, role, name, status: 'active' })
      await db.audit({ companyId: company.id, accountId: actor.id, action: 'account.create', detail: { id: row.id, email, role } })
      return row
    })
    json(res, 201, { account: publicAccount(created) })
  })

  /**
   * 建号并发一条邀请链接。账号当场建出来（待接受），链接只负责让本人设口令。
   * 必须写在 /accounts/:accountId 前面，否则 members 会被当成 accountId。
   */
  router.post('/orgs/:id/accounts/members', async (req, res) => {
    const actor = await requireOrgUser(req, db, keys, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    const email = emailOf(strField(body, 'email'))
    const name = strField(body, 'name', false)
    const role = roleOf(body.role, 'member')
    const days = Math.min(Math.max(Number(body.ttlDays) || 7, 1), 30)
    if (await db.accountByEmail(email)) throw new HttpError(409, '这个邮箱已经注册')
    const passwordHash = await hashPassword(randomUUID())
    const created = await db.tx(async () => {
      await takeSeat(company.id)
      const row = await db.insertAccount({
        companyId: company.id,
        email,
        passwordHash,
        role,
        name,
        status: 'invited',
      })
      const invite = await issueInvite(db, row, actor.id, days * 24 * 3600 * 1000)
      await db.audit({
        companyId: company.id,
        accountId: actor.id,
        action: 'account.invite',
        detail: { id: row.id, email, role, expiresAt: invite.expiresAt },
      })
      return { row, invite }
    })
    json(res, 201, {
      user: publicAccount(created.row),
      invite: { url: inviteLinkOf(req, created.invite.token), expiresAt: created.invite.expiresAt },
    })
  })

  /**
   * 改一个分组之前要过的那几关：管理员、不是「全体成员」、公司在、分组属于这家公司。
   *
   * 收在一起是因为最后那一关容易漏——`groupId` 从 URL 上来，不比对 companyId 的话，
   * 甲公司的管理员能拿乙公司的分组 id 改到别人家的分组。
   */
  async function editableGroup(req: Req) {
    const actor = await requireOrgUser(req, db, keys, req.params.id, true)
    if (req.params.groupId === 'all') throw new HttpError(400, '「全体成员」是系统固定分组')
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const cur = await db.group(req.params.groupId)
    if (!cur || cur.companyId !== company.id) throw new HttpError(404, '没有这个分组')
    return { actor, company, cur }
  }

  /**
   * 占一个席位，占不到就 409。**必须在事务里调**（两处调用点都在 `db.tx` 内）。
   *
   * `lockPlan` 那一句是关键：不锁的话，两个管理员同时加最后一个人，两边都读到
   * `used < seats`，两边都插进去，席位就超卖了——而超卖之后没有任何一处会报错，
   * 只是这家公司永远多一个人。
   */
  async function takeSeat(companyId: string) {
    await db.lockPlan(companyId)
    const plan = await db.plan(companyId)
    const used = await db.accountCount(companyId)
    const seats = plan?.seats ?? 0
    if (used >= seats) throw new HttpError(409, '席位已满', { seats, used })
  }

  /**
   * 分组。必须写在 /accounts/:accountId 前面，否则 groups 会被当成 accountId。
   * 默认角色只影响以后加进组的人，不改已有成员的账号角色。
   */
  router.post('/orgs/:id/accounts/groups', async (req, res) => {
    const actor = await requireOrgUser(req, db, keys, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) throw new HttpError(400, '分组要有名字')
    const desc = typeof body.desc === 'string' ? body.desc.trim() : ''
    const icon = (typeof body.icon === 'string' && body.icon.trim()) || 'chat'
    const role = groupRoleOf(body.role)
    const members = await membersInCompany(db, company.id, body.members)
    const agents = stringIds(body.agents)
    const group = await db.insertGroup({ companyId: company.id, name, desc, icon, role, members, agents })
    await db.audit({ companyId: company.id, accountId: actor.id, action: 'group.create', detail: { id: group.id, name } })
    json(res, 201, { group: publicGroup(group) })
  })

  router.patch('/orgs/:id/accounts/groups/:groupId', async (req, res) => {
    const { actor, company, cur } = await editableGroup(req)
    const body = bodyOf(req)
    const patch: Partial<Pick<Group, 'name' | 'desc' | 'icon' | 'role' | 'members' | 'agents'>> = {}
    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name) throw new HttpError(400, '分组要有名字')
      patch.name = name
    }
    if (typeof body.desc === 'string') patch.desc = body.desc.trim()
    if (typeof body.icon === 'string' && body.icon.trim()) patch.icon = body.icon.trim()
    if (body.role === 'admin' || body.role === 'member') patch.role = body.role
    if (Array.isArray(body.members)) patch.members = await membersInCompany(db, company.id, body.members)
    if (Array.isArray(body.agents)) patch.agents = stringIds(body.agents)
    const group = await db.updateGroup(cur.id, patch)
    await db.audit({ companyId: company.id, accountId: actor.id, action: 'group.update', detail: { id: group.id } })
    json(res, 200, { group: publicGroup(group) })
  })

  router.delete('/orgs/:id/accounts/groups/:groupId', async (req, res) => {
    const { actor, company, cur } = await editableGroup(req)
    await db.deleteGroup(cur.id)
    await db.audit({ companyId: company.id, accountId: actor.id, action: 'group.delete', detail: { id: cur.id, name: cur.name } })
    json(res, 200, { ok: true })
  })

  router.get('/orgs/:id/accounts/:accountId', async (req, res) => {
    await requireOrgUser(req, db, keys, req.params.id, true)
    const row = await db.account(req.params.accountId)
    if (!row || row.companyId !== req.params.id) throw new HttpError(404, '账号不存在')
    json(res, 200, { account: publicAccount(row) })
  })

  router.patch('/orgs/:id/accounts/:accountId', async (req, res) => {
    const actor = await requireOrgUser(req, db, keys, req.params.id, true)
    const row = await db.account(req.params.accountId)
    if (!row || row.companyId !== req.params.id) throw new HttpError(404, '账号不存在')
    // 规矩在 lib/org.ts 的 patchAccount 里，和平台那条路共用一份（见那儿的注释）。
    const { account: next, patch } = await patchAccount(db, actor, row, bodyOf(req))
    await db.audit({
      companyId: row.companyId,
      accountId: actor.id,
      action: 'account.update',
      detail: { id: row.id, name: patch.name, role: patch.role, status: patch.status },
    })
    json(res, 200, { account: publicAccount(next) })
  })

  /**
   * 重发邀请 / 重置口令，都落成一条新链接。旧邀请删掉，tokenRevokedAt 立刻作废旧 JWT。
   * Gateway 没有会话表：未过期的 JWT 若签发于 tokenRevokedAt 之后仍可用；登录会因 disabled 被拒。
   */
  router.post('/orgs/:id/accounts/:accountId/reset', async (req, res) => {
    const actor = await requireOrgUser(req, db, keys, req.params.id, true)
    const row = await db.account(req.params.accountId)
    if (!row || row.companyId !== req.params.id) throw new HttpError(404, '没有这个成员')
    await db.updateAccount(row.id, { tokenRevokedAt: Date.now() })
    const ttl = row.status === 'invited' ? INVITE_TTL : RESET_LINK_TTL
    const invite = await issueInvite(db, row, actor.id, ttl)
    await db.audit({
      companyId: row.companyId,
      accountId: actor.id,
      action: 'account.reset',
      detail: { id: row.id, expiresAt: invite.expiresAt },
    })
    json(res, 200, { invite: { url: inviteLinkOf(req, invite.token), expiresAt: invite.expiresAt } })
  })

  router.post('/orgs/:id/accounts/:accountId/deploy', async (req, res) => {
    const actor = await requireOrgUser(req, db, keys, req.params.id, true)
    const row = await db.account(req.params.accountId)
    if (!row || row.companyId !== req.params.id) throw new HttpError(404, '账号不存在')
    if (row.role === 'owner') throw new HttpError(403, '系统管理员没有席位')
    const out = await deploySeat(db, keys, row, deployOptsOf(req))
    const rt = out.ok ? out.result.runtime : out.runtime
    await db.audit({
      companyId: req.params.id,
      accountId: actor.id,
      action: 'runtime.deploy',
      detail: {
        targetAccountId: row.id,
        botId: rt?.botId,
        linuxUser: rt?.linuxUser,
        seatId: rt?.seatId,
        slot: rt?.slot,
        status: rt?.status,
      },
    })
    if (!out.ok) throw new HttpError(out.status, out.error)
    json(res, 200, publicSeatRuntime(out.result.runtime, out.result.machine, {
      includePassword: actor.role === 'owner' || actor.id === row.id,
      ticket: desktopTicketFor(keys, out.result.machine, out.result.runtime),
    }))
  })

  router.delete('/orgs/:id/accounts/:accountId', async (req, res) => {
    const actor = await requireOrgUser(req, db, keys, req.params.id, true)
    const row = await db.account(req.params.accountId)
    if (!row || row.companyId !== req.params.id) throw new HttpError(404, '账号不存在')
    if (row.id === actor.id) throw new HttpError(400, '不能删除自己')
    if (row.role === 'admin' && row.status !== 'disabled' && row.companyId && await db.adminCount(row.companyId) <= 1) {
      throw new HttpError(409, '不能删掉最后一个管理员')
    }
    // **先拆机器上的席位，再删库里的行。** 理由见 deploy.ts 的 releaseSeats——
    // 删公司走的是同一条。
    const seats = await db.seatRuntimesOfAccount(row.id)
    try {
      await releaseSeats(db, seats)
    } catch (e) {
      throw new HttpError(502, (e as Error).message)
    }
    await db.deleteAccount(row.id)
    await db.audit({
      companyId: row.companyId,
      accountId: actor.id,
      action: 'account.delete',
      detail: { id: row.id, email: row.email, seats: seats.map((x) => x.seatId) },
    })
    json(res, 200, { deleted: true, id: row.id })
  })

  router.get('/orgs/:id/plan', async (req, res) => {
    await requireOrgUser(req, db, keys, req.params.id)
    const plan = await db.plan(req.params.id)
    if (!plan) throw new HttpError(404, '套餐不存在')
    json(res, 200, await publicPlan(db, plan, await db.accountCount(req.params.id)))
  })

  /**
   * 公司账单。席位来自 db.plan，是真的。发票、充值、扣款都还没接——空列表，不编数字。
   */
  router.get('/orgs/:id/billing', async (req, res) => {
    await requireOrgUser(req, db, keys, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const plan = await db.plan(company.id)
    if (!plan) throw new HttpError(404, '套餐不存在')
    const used = await db.accountCount(company.id)
    // 订阅和账单都来自订单：已付款且在期内的那条订单就是「现在订的是什么」。
    const active = await db.activePaidOrder(company.id)
    const expired = plan.expiresAt != null && plan.expiresAt < Date.now()
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
    const invoices = await db.invoicesOfCompany(company.id)
    const topups = await db.topupsOfCompany(company.id)
    const balance = await balanceOf(db, company.id)
    const budget = await meter.budget(company.id)
    const billing = parseBilling((await db.platformSettings()).billing)
    const spentThisPeriod = await db.chargeSpentSince(company.id, balance.planBonusStartAt ?? 0)
    json(res, 200, {
      plan: {
        name: active?.planName || '席位套餐',
        status: active ? '生效中' : expired ? '已到期' : '未订阅',
        cycle: '—',
        seats: `${plan.seats} 个席位`,
        used,
        period: active ? `${day(active.startAt)} → ${day(active.endAt)}` : '—',
        renew: plan.expiresAt == null ? '—' : day(plan.expiresAt),
        amount: active ? usd(active.amountMils) : '—',
        autoRenew: false,
      },
      // 客户这边只看已付款的：没付的单子是「还没成交」，摆在账单里像已经欠着钱。
      // 界面那张表按 period / amount / status / paid 四列画，这里就按它的形状给。
      invoices: invoices
        .filter((v) => v.status === 'paid')
        .map((v) => ({
          id: v.id,
          period: `${day(v.periodStart)} → ${day(v.periodEnd)}`,
          amount: usd(v.amountMils),
          status: '已付款',
          paid: v.paidAt ? day(v.paidAt) : '—',
        })),
      // 两笔额度分开报：赠送的跟着套餐到期清零，充的不过期。合计只是给一眼看的。
      //
      // **发的和剩的是两个数。** planBonus / topup 是「发了多少」，left 那两个才是
      // 「还剩多少」——按量扣费接上之后，只报发了多少等于让人看着一个永远不动的数
      // 去猜自己还能用多久。
      balance: {
        amount: usd(balance.planBonusMils + balance.topupMils),
        planBonus: usd(balance.planBonusMils),
        planBonusExpires: balance.planBonusExpiresAt ? day(balance.planBonusExpiresAt) : '—',
        topup: usd(balance.topupMils),
        planBonusLeft: usdMicros(budget.bonusLeft),
        topupLeft: usdMicros(budget.topupLeft),
        left: usdMicros(budget.left),
        leftMicros: budget.left,
        // 「本期」= 当前套餐账期，不是自然月：赠送额度是按账期作废的，跟着它数才对得上
        // 「还剩多少」。没有生效套餐时退回全部历史——那时也没有账期可言。
        spentThisPeriod: usdMicros(spentThisPeriod),
        // 预警线还没有设置项。不编一个数——编出来的阈值会被当成真的在生效。
        alertAt: '—',
        // 余额见底会不会真的停下来。界面上那句提示的措辞得跟着它变。
        enforce: billing.enforce,
        /**
         * 本期一共有过多少额度（发放 + 累计充值）。
         *
         * 给「还剩不到一成」那条预警当分母。分母不能用「当前余额」——那样算出来的
         * 比例恒等于 100%。
         */
        grantedMicros: (balance.planBonusMils + balance.topupMils) * 1000,
      },
      topups: topups.map((v) => ({
        id: v.id,
        time: day(v.createdAt),
        amount: usd(v.amountMils),
        note: v.note || '—',
      })),
    })
  })

  /**
   * 用量屏那几块维度：日线、按 Bot、按模型、按类型。
   *
   * 都从已经有的两张表来——事实在 `llm_calls`，钱在账本——所以公司管理员这一屏和平台
   * 那一屏是同一个口径，不是另算一份。以前这四个字段是写死的空数组，界面上四块永远
   * 写着「还没有用量」，而底下的计费明细一屏都是——两个说法互相打脸。
   *
   * `offsetMs` 是看的人所在时区的偏移，只有日线用得上（见 `db.llmDailyBy`）。
   */
  async function usageDims(
    scope: { companyId?: string; accountId?: string },
    range: { from?: number; to?: number },
    offsetMs: number,
  ) {
    const column = scope.companyId ? 'companyId' : 'accountId'
    const value = scope.companyId ?? scope.accountId ?? ''
    const [buckets, models, charges] = await Promise.all([
      db.llmDailyBy(column, value, range, offsetMs),
      db.llmUsageByCompanyModel(range, scope.companyId, scope.accountId),
      db.chargeUsageBy(['botId', 'kind', 'subject'], range, scope),
    ])

    /**
     * 日线要**把没有调用的那天也画出来**：只画有数的那几天，横轴会被悄悄压缩，
     * 「周末没人用」看上去和「天天都在用」长得一样。
     */
    const day = 86400000
    const first = range.from != null ? Math.floor((range.from + offsetMs) / day) : buckets[0]?.bucket
    const last = range.to != null ? Math.floor((range.to + offsetMs) / day) : buckets[buckets.length - 1]?.bucket
    const daily: { label: string; value: number }[] = []
    if (first != null && last != null && last >= first) {
      const counts = new Map(buckets.map((b) => [b.bucket, b.calls]))
      // 92 根柱子已经挤不下了；手搓一个三年的 from/to 不该把这一屏拖垮。
      const start = Math.max(first, last - 91)
      for (let b = start; b <= last; b += 1) {
        const d = new Date(b * day)
        const label = `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`
        daily.push({ label, value: counts.get(b) ?? 0 })
      }
    }

    /** 账本上这一段的钱，按对象（模型是 `provider/model`、连接器是 `连接器:工具`）摊开。 */
    const spentBySubject = new Map<string, number>()
    const byKindAcc = new Map<string, { calls: number; micros: number }>()
    const byBotAcc = new Map<string, { calls: number; micros: number }>()
    for (const c of charges) {
      spentBySubject.set(c.subject, (spentBySubject.get(c.subject) ?? 0) + c.amountMicros)
      const k = byKindAcc.get(c.kind) ?? { calls: 0, micros: 0 }
      k.calls += c.calls
      k.micros += c.amountMicros
      byKindAcc.set(c.kind, k)
      // botId 只有连接器那条路填得上（见 lib/meter.ts）。填不上的不兜成「未标记」——
      // 那一行会一口气占掉九成，把真正带标识的几行压成看不见的细线。
      if (!c.botId) continue
      const b = byBotAcc.get(c.botId) ?? { calls: 0, micros: 0 }
      b.calls += c.calls
      b.micros += c.amountMicros
      byBotAcc.set(c.botId, b)
    }

    const n = (x: number) => x.toLocaleString('en-US')
    const pctOf = (x: number, top: number) => (top > 0 ? Math.round((x / top) * 100) : 0)

    /** 同一个模型可能跨多家公司/多个人分了几行，这里按 `provider/model` 合回去。 */
    const modelAcc = new Map<string, { tokens: number; calls: number }>()
    for (const m of models) {
      const key = `${m.provider}/${m.model}`
      const cur = modelAcc.get(key) ?? { tokens: 0, calls: 0 }
      cur.tokens += m.promptTokens + m.completionTokens
      cur.calls += m.calls
      modelAcc.set(key, cur)
    }
    const modelRows = [...modelAcc.entries()].sort((a, b) => b[1].tokens - a[1].tokens)
    const topTokens = modelRows[0]?.[1].tokens ?? 0
    const byModel = modelRows.map(([name, m]) => ({
      name,
      value: `${n(m.tokens)} token · ${usdMicros(spentBySubject.get(name) ?? 0)}`,
      pct: pctOf(m.tokens, topTokens),
    }))

    const KINDS: [string, string][] = [['llm', '模型'], ['connector', '连接器'], ['web', '网页']]
    const topKind = Math.max(0, ...[...byKindAcc.values()].map((x) => x.calls))
    const byKind = KINDS.filter(([k]) => byKindAcc.has(k)).map(([k, label]) => {
      const x = byKindAcc.get(k) as { calls: number; micros: number }
      return { name: label, value: `${n(x.calls)} 次 · ${usdMicros(x.micros)}`, pct: pctOf(x.calls, topKind) }
    })

    const bots = scope.companyId
      ? await db.companyBots(scope.companyId)
      : scope.accountId
        ? await db.botsFor((await db.account(scope.accountId))?.companyId ?? null, scope.accountId)
        : []
    const botName = new Map(bots.map((b) => [b.id, b.name]))
    const botRows = [...byBotAcc.entries()].sort((a, b) => b[1].calls - a[1].calls)
    const topBot = botRows[0]?.[1].calls ?? 0
    const byAgent = botRows.map(([id, x]) => ({
      // 名字查不到就用 id：Bot 被删了，它花过的钱还在账上。
      name: botName.get(id) ?? id,
      value: `${n(x.calls)} 次 · ${usdMicros(x.micros)}`,
      pct: pctOf(x.calls, topBot),
    }))

    return { daily, byAgent, byModel, byKind }
  }

  /**
   * 时区偏移（毫秒）。前端传的是 `Date.getTimezoneOffset()` 的**相反数**（东八区 +480 分）。
   * 缺省 0 = UTC 切天：老前端不带这个参数时，日线仍然画得出来，只是边界按 UTC。
   */
  function tzOffsetMs(req: Parameters<typeof rangeQuery>[0]): number {
    const raw = (req.query.get('tz') || '').trim()
    if (!raw) return 0
    const n = Number(raw)
    if (!Number.isFinite(n)) throw new HttpError(400, 'tz 必须是分钟数')
    // 谁也不在 ±16 小时之外。越界的值当没传，而不是让日线整体飘走。
    if (Math.abs(n) > 16 * 60) return 0
    return n * 60000
  }

  /**
   * 公司用量。调用次数和 token 从 `llm_calls` 汇总，钱从账本汇总（三条路都算）。
   * 管理员；员工走 GET /me/stats。
   */
  router.get('/orgs/:id/usage', async (req, res) => {
    await requireOrgUser(req, db, keys, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const range = rangeQuery(req)
    const plan = await db.plan(company.id)
    const seats = plan?.seats ?? 0
    const members = (await db.accountsOf(company.id)).filter((a) => a.role !== 'owner')
    const usage = await db.llmUsageOfCompany(company.id, range)
    // 钱按人摊开要走账本，不能按 token 折——一个人跑一天搜索、一次模型都不调，
    // 按 token 看他是零，而他确实花了钱。
    const spentByAccount = new Map<string, number>()
    let spentMicros = 0
    for (const row of await db.chargeUsageBy(['accountId'], range, { companyId: company.id })) {
      spentByAccount.set(row.accountId, (spentByAccount.get(row.accountId) ?? 0) + row.amountMicros)
      spentMicros += row.amountMicros
    }
    const dims = await usageDims({ companyId: company.id }, range, tzOffsetMs(req))
    json(res, 200, usagePayload(usage, { seats, members, includeMembers: true, spentByAccount, spentMicros, dims }))
  })

  router.get('/me/stats', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const range = rangeQuery(req)
    const usage = await db.llmUsageOfAccount(account.id, range)
    const mine = await db.chargeUsageBy(['accountId'], range, { accountId: account.id })
    const dims = await usageDims({ accountId: account.id }, range, tzOffsetMs(req))
    json(res, 200, usagePayload(usage, {
      seats: 0,
      members: [account],
      includeMembers: false,
      spentMicros: mine.reduce((n, r) => n + r.amountMicros, 0),
      dims,
    }))
  })

  router.put('/orgs/:id/plan', async (req, res) => {
    await requireUser(req, db, keys)
    throw new HttpError(403, '席位由系统管理员分配')
  })

  router.patch('/orgs/:id/plan', async (req, res) => {
    await requireUser(req, db, keys)
    throw new HttpError(403, '席位由系统管理员分配')
  })

  // ── 机器 / 访问地址 ─────────────────────────────────────────────────

  router.get('/orgs/:id/machine', async (req, res) => {
    await requireOrgUser(req, db, keys, req.params.id)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const machine = company.machineId ? await db.machine(company.machineId) : await companyMachineOf(db, company.id)
    json(res, 200, { machine: machine ? publicMachine(machine) : null, accessUrl: company.accessUrl })
  })

  router.post('/orgs/:id/machine', async (req, res) => {
    const account = await requireOrgUser(req, db, keys, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    // 机器地址是平台的事：登记走 POST /internal/machines（引导票），改走
    // PUT /platform/orgs/:id/machine（owner）。公司管理员只能把已有机器认领过来。
    // 否则管理员能把 host 指到自己的服务器上，让 Gateway 带着 smt_ 打过去。
    const rawHost = body.host != null ? strField(body, 'host', false) : ''
    if (rawHost && account.role !== 'owner') throw new HttpError(403, '机器地址由系统管理员配置')
    const host = rawHost ? machineHostOf(rawHost) : null
    const id = body.id != null ? strField(body, 'id', false) || undefined : undefined
    const existing = id ? await db.machine(id) : undefined
    if (existing && existing.companyId && existing.companyId !== company.id) {
      throw new HttpError(409, '这台机器已经派给别的公司')
    }
    // **配过对的机器不是「谁先认领谁得」。** companyId 为空不代表这台是干净的新机器：
    // 公司被删时 machines.companyId 会被置空，而那台机器上的席位还在跑。这种机器只能
    // 由 owner 重新指派，或者由**当初配对它的那家公司**认回去。没配过对的预登记机器
    // （平台先 POST /internal/machines 建好、再交给公司）不受影响，照旧可以认领。
    if (
      existing &&
      !existing.companyId &&
      existing.pairedAt &&
      account.role !== 'owner' &&
      !(await db.machinePairedBy(existing.id, company.id))
    ) {
      throw new HttpError(403, '这台机器不是本公司配对的，请让系统管理员指派')
    }
    const { machine, next } = await db.tx(async () => {
      // **认领是「加一台」，不是「换一台」。** 以前这里会把 company.machineId 指向的
      // 那台解绑——单机时代那是对的，多机之后会把已经在跑的机器连同它上面的席位一起
      // 踢出公司，容量凭空缩水。
      const machine = existing
        ? await db.updateMachine(existing.id, { companyId: company.id, host: host ?? existing.host })
        : await db.insertMachine({ id, host, companyId: company.id })
      const accessUrl = company.accessUrl ?? accessUrlFor(company.slug)
      // 认领是个明确动作，把这台设成公司的默认机器是合理的。但**只是改默认**——
      // 上面那台仍然属于这家公司、仍然在跑、仍然算容量。
      const next = await db.updateCompany(company.id, { machineId: machine.id, accessUrl })
      await db.audit({ companyId: company.id, accountId: account.id, action: 'machine.assign', detail: { machineId: machine.id, accessUrl } })
      return { machine, next }
    })
    json(res, 201, { machine: publicMachine(machine), company: publicCompany(next) })
  })
}
