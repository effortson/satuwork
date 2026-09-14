/**
 * 健康检查、JWKS、登录注册、邀请、以及「我」这一组。
 */
import type { RouteCtx } from './ctx.ts'
import { HttpError, json, type Router } from '../http.ts'
import { LOGIN_DUMMY_HASH, bodyOf, strField } from '../lib/validate.ts'
import { MIN_PASSWORD, hashPassword, jwks, needsRehash, verifyPassword } from '../crypto.ts'
import { emailOf, orgSettings, orgSummary, publicAccount, publicCompany, publicPlan, publicSettings } from '../lib/org.ts'
import { headerOf, inviteeOf, issue, noteLogin, requireSeatOrUser, requireUser } from '../lib/guards.ts'
import { type Account } from '../db.ts'

/**
 * 建系统管理员那把事务级锁的号。
 *
 * 一个随手取的常数，唯一的要求是**别和以后新加的那几处撞上**——两件不相干的事排在
 * 一条队上，是最难查的那种慢（见 db.lockExclusive）。
 */
const SETUP_LOCK = 20260831

export function attachAuth(router: Router, ctx: RouteCtx) {
  const { db, keys } = ctx

  router.get('/health', async (_req, res) => json(res, 200, { ok: true }))
  router.get('/jwks', async (_req, res) => json(res, 200, jwks(keys)))
  router.get('/.well-known/jwks.json', async (_req, res) => json(res, 200, jwks(keys)))

  /**
   * 门口的状态。**公开**：还没登录的浏览器要靠它决定画登录页还是「创建系统管理员」。
   * 只回一个布尔，不透露任何账号信息。
   */
  router.get('/auth/state', async (_req, res) => {
    json(res, 200, { needsSetup: (await db.owners()).length === 0 })
  })

  /**
   * 建第一个系统管理员。**只在一个 owner 都没有时可用**，这条检查在服务端——
   * 否则任何人都能往这个接口再造一个 owner 出来。
   */
  router.post('/auth/setup', async (req, res) => {
    const body = bodyOf(req)
    const email = emailOf(strField(body, 'email'))
    const password = strField(body, 'password')
    if (password.length < MIN_PASSWORD) throw new HttpError(400, `口令至少 ${MIN_PASSWORD} 位`)
    const name = strField(body, 'name', false)
    const passwordHash = await hashPassword(password)
    /**
     * 并发点两次「创建」也只成一个。
     *
     * **光「抢在事务里再查一遍」拦不住**：`db.tx` 是 READ COMMITTED，两条事务各自查到
     * 「还没有 owner」然后各插一行，两边都 201——库里就有了两个系统管理员，而这套东西
     * 从头到尾假设只有一个（`/auth/state` 的 needsSetup、平台那一组的鉴权都按它算）。
     * 那一版只是把窗口缩小到本机上撞不着，CI 一慢就现原形（201/201）。
     *
     * 所以先上一把事务级排他锁再查：后到的那条阻塞到前一条提交，然后查到 owner，回 409。
     */
    const owner = await db.tx(async () => {
      await db.lockExclusive(SETUP_LOCK)
      if ((await db.owners()).length) throw new HttpError(409, '已经有系统管理员了')
      if (await db.accountByEmail(email)) throw new HttpError(409, '这个邮箱已经注册')
      return db.insertAccount({ companyId: null, email, passwordHash, role: 'owner', name })
    })
    await db.audit({ companyId: 'platform', accountId: owner.id, action: 'auth.setup', detail: { email } })
    json(res, 201, { token: issue(keys, owner), account: publicAccount(owner), company: null })
  })

  /**
   * 这里以前还有一条 `POST /auth/register`：无鉴权、无邀请、无限流、无开关，一次
   * 请求建出一家公司加一个 admin，`seats` 还由请求体自己指定。前端、e2e、文档全都
   * 没有引用过它——它是自助注册那一版留下的，而产品里建公司走的是 owner-only 的
   * `POST /platform/orgs`。删掉了。
   *
   * 真要做自助注册，另起一条带邀请码或开关的路径，不要留一个默认开着、没人知道
   * 存在的口。
   */

  // ── 登录 ────────────────────────────────────────────────────────────

  router.post('/auth/login', async (req, res) => {
    const body = bodyOf(req)
    const email = emailOf(strField(body, 'email'))
    const password = strField(body, 'password')
    let account = await db.accountByEmail(email)
    // 找不到也走同一条失败路径，不靠耗时差泄露「这个邮箱在不在」。
    const ok = account ? await verifyPassword(password, account.passwordHash) : await verifyPassword(password, await LOGIN_DUMMY_HASH)
    if (!account || !ok) throw new HttpError(401, '邮箱或口令不对')
    if (account.status === 'disabled') throw new HttpError(403, '这个账号已被停用，请联系管理员')
    if (account.status === 'invited') throw new HttpError(403, '请先用邀请链接设置口令')
    /**
     * 口令哈希跟着当前参数走，**趁这一刻升级**。
     *
     * 校验现在按每一行自己存的 `N$r$p` 算（见 crypto.verifyPassword），所以调高成本
     * 不会再把存量账号锁在门外；但不补这一句的话，老行会用老参数一直用下去，那个开关
     * 等于只对新注册的人生效。这是唯一一处手上有明文的地方。
     *
     * 升级失败不能挡住登录：口令是对的，重算只是顺手做的事。
     */
    if (needsRehash(account.passwordHash)) {
      try {
        account = await db.updateAccount(account.id, { passwordHash: await hashPassword(password) })
      } catch (e) {
        console.error(`satuwork-gateway: 口令哈希升级失败 ${account.id}：${(e as Error).message}`)
      }
    }
    const logged = await noteLogin(db, account)
    if (logged.role === 'owner') {
      await db.audit({ companyId: 'platform', accountId: logged.id, action: 'auth.login' })
      json(res, 200, { token: issue(keys, logged), account: publicAccount(logged), company: null })
      return
    }
    const company = await db.company(logged.companyId!)
    if (!company) throw new HttpError(401, '账号不存在')
    if (company.status === 'disabled') throw new HttpError(403, '这家公司已被停用，请联系平台管理员')
    await db.audit({ companyId: company.id, accountId: logged.id, action: 'auth.login' })
    json(res, 200, { token: issue(keys, logged), account: publicAccount(logged), company: publicCompany(company) })
  })

  /**
   * 看一条邀请是否还有效。公开：点链接的人还没有账号。
   * 无效不区分「不存在 / 过期 / 用过」——三者对访客是同一件事。
   */
  router.get('/invites/:token', async (req, res) => {
    const found = await inviteeOf(db, req.params.token)
    if (!found) {
      json(res, 200, { valid: false })
      return
    }
    json(res, 200, {
      valid: true,
      email: found.user.email,
      name: found.user.name,
      expiresAt: found.invite.expiresAt,
    })
  })

  router.post('/invites/:token/accept', async (req, res) => {
    const found = await inviteeOf(db, req.params.token)
    if (!found) throw new HttpError(400, '这条邀请链接不可用')
    const body = bodyOf(req)
    const password = strField(body, 'password')
    if (password.length < MIN_PASSWORD) throw new HttpError(400, `口令至少 ${MIN_PASSWORD} 位`)
    const name = strField(body, 'name', false)
    const passwordHash = await hashPassword(password)
    const now = Date.now()
    const next = await db.updateAccount(found.user.id, {
      name: name || found.user.name,
      passwordHash,
      status: 'active',
      passwordChangedAt: now,
      lastSeenAt: now,
    })
    await db.deleteInvite(found.id)
    json(res, 200, { token: issue(keys, next), account: publicAccount(next) })
  })

  router.get('/me', async (req, res) => {
    const account = await requireSeatOrUser(req, db, keys)
    const stored = await db.platformSettings()
    if (account.role === 'owner') {
      json(res, 200, {
        account: publicAccount(account),
        company: null,
        plan: null,
        // 平台那几屏（单价、倍率、连接器计费、期望管家版本）就靠这一份画。
        settings: publicSettings(stored),
        orgs: await Promise.all((await db.companies()).map((c) => orgSummary(db, c))),
      })
      return
    }
    const company = await db.company(account.companyId!)
    if (!company) throw new HttpError(401, '账号不存在')
    const plan = (await db.plan(company.id))!
    json(res, 200, {
      account: publicAccount(account),
      company: publicCompany(company),
      plan: await publicPlan(db, plan, await db.accountCount(company.id)),
      // 公司管理员、员工、席位都走这一支：**定价不下发**。见 orgSettings 的注释。
      settings: orgSettings(stored),
    })
  })

  /**
   * 改自己的资料与界面偏好。邮箱/角色/状态/口令不在这里——邮箱是登录身份，
   * 角色是管理面的事，口令走 /me/password。
   */
  router.patch('/me', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const body = bodyOf(req)
    const patch: {
      name?: string
      title?: string
      phone?: string
      theme?: Account['theme']
      locale?: Account['locale']
    } = {}
    if (typeof body.name === 'string') {
      const name = body.name.trim()
      if (name) patch.name = name
    }
    if (typeof body.title === 'string') patch.title = body.title.trim()
    if (typeof body.phone === 'string') patch.phone = body.phone.trim()
    if (body.theme != null && body.theme !== '') {
      const theme = strField(body, 'theme')
      if (theme !== 'light' && theme !== 'dark' && theme !== 'system') {
        throw new HttpError(400, 'theme 只能是 light、dark 或 system')
      }
      patch.theme = theme as Account['theme']
    }
    if (body.locale != null && body.locale !== '') {
      const locale = strField(body, 'locale')
      if (locale !== 'zh' && locale !== 'en') throw new HttpError(400, 'locale 只能是 zh 或 en')
      patch.locale = locale as Account['locale']
    }
    const next = Object.keys(patch).length ? await db.updateAccount(account.id, patch) : account
    json(res, 200, { account: publicAccount(next) })
  })

  /**
   * 改口令。先验当前口令；改完 tokenRevokedAt 立刻作废其他 JWT，当前这次发一张新票。
   */
  router.post('/me/password', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const body = bodyOf(req)
    const current = strField(body, 'current')
    const next = strField(body, 'next')
    const ok = await verifyPassword(current, account.passwordHash)
    if (!ok) throw new HttpError(400, '当前口令不对')
    if (next.length < MIN_PASSWORD) throw new HttpError(400, `口令至少 ${MIN_PASSWORD} 位`)
    if (next === current) throw new HttpError(400, '新口令不能和当前口令相同')
    const passwordHash = await hashPassword(next)
    const now = Date.now()
    const nextAccount = await db.updateAccount(account.id, {
      passwordHash,
      passwordChangedAt: now,
      tokenRevokedAt: now,
    })
    await db.audit({
      companyId: account.companyId ?? 'platform',
      accountId: account.id,
      action: 'account.password',
    })
    json(res, 200, { ok: true, token: issue(keys, nextAccount) })
  })

  /**
   * Gateway 用 JWT，没有会话表。只回当前这一次，列不出也注销不了其他设备。
   */
  router.get('/me/sessions', async (req, res) => {
    const account = await requireUser(req, db, keys)
    json(res, 200, {
      sessions: [
        {
          id: 'current',
          agent: headerOf(req, 'user-agent') || '',
          createdAt: account.lastSeenAt || Date.now(),
          current: true,
        },
      ],
    })
  })
}
