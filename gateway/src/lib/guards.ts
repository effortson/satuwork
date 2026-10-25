/**
 * 鉴权守卫、邀请、登录票。用量口径在 lib/usage.ts。
 *
 * 从 routes.ts 拆出来的——那个文件曾经是 5700 行，前 1900 行全是这类帮手。
 */
import { HttpError, type Req, bearer } from '../http.ts'
import { JWT_TTL, KIND } from './validate.ts'
import { type Account, type AccountStatus, type CatalogKind, type Db, type Machine, type Role } from '../db.ts'
import { type JwtKeys, type JwtPayload, randomInviteToken, sha256Hex, signJwt, ticketRevoked, timingSafeToken, verifyJwt } from '../crypto.ts'

export function gateAccount(account: Account | undefined): Account {
  if (!account) throw new HttpError(401, '需要登录')
  if (account.status === 'disabled') throw new HttpError(401, '这个账号已被停用，请联系管理员')
  if (account.status === 'invited') throw new HttpError(401, '请先用邀请链接设置口令')
  return account
}

/**
 * 公司停用就整家挡在门外——账号自己没停用也一样，省得一家家去停人。
 * owner 不属于任何公司，不受这条影响，否则停完就没人能把它开回来了。
 */
export async function gateCompany(db: Db, account: Account): Promise<Account> {
  if (!account.companyId) return account
  const company = await db.company(account.companyId)
  if (company && company.status === 'disabled') throw new HttpError(403, '这家公司已被停用，请联系平台管理员')
  return account
}

/**
 * 账号本身能不能用：停用 / 还没接受邀请 / 公司被停用。控制台、席位票、API Key、/v1 的
 * 登录 JWT 全走这一句，文案要能直接给调用方看——bot 会把它原样变成一条失败消息。
 *
 * 只此一份：「/v1 的规矩」和「控制台的规矩」一旦分成两份，下次改其中一句的人不会知道
 * 还有另一份。
 */
export async function assertUsable(db: Db, account: Account | undefined): Promise<Account> {
  return await gateCompany(db, gateAccount(account))
}

/**
 * 登录 JWT → 账号：验签、账号还在、票没被作废、账号能用。前缀判断（sat_ / sk_sw_ 能不能
 * 走这条）由调用方各自做，控制台和 /v1 的口径不一样。
 */
export async function accountFromJwtToken(db: Db, keys: JwtKeys, token: string): Promise<Account> {
  let payload: JwtPayload
  try {
    payload = verifyJwt(keys, token)
  } catch (e) {
    throw new HttpError(401, (e as Error).message)
  }
  const account = await db.account(payload.accountId)
  if (!account) throw new HttpError(401, '账号不存在')
  // 新票按毫秒 iatMs 比，老票退回按秒（见 ticketRevoked）。
  if (ticketRevoked(account.tokenRevokedAt, payload)) {
    throw new HttpError(401, '登录已失效，请重新登录')
  }
  return assertUsable(db, account)
}

/** 控制台写操作：只要登录 JWT。sat_ / sk_sw_ 都不行。 */
export async function requireUser(req: Req, db: Db, keys: JwtKeys): Promise<Account> {
  const token = bearer(req)
  if (!token) throw new HttpError(401, '需要登录')
  if (token.startsWith('sk_sw_') || token.startsWith('sat_')) throw new HttpError(401, '需要登录')
  return accountFromJwtToken(db, keys, token)
}

/** Bot 拉目录：登录 JWT 或席位 sat_。sk_sw_ 不行。 */
export async function requireSeatOrUser(req: Req, db: Db, keys: JwtKeys): Promise<Account> {
  const token = bearer(req)
  if (!token) throw new HttpError(401, '需要登录')
  if (token.startsWith('sk_sw_')) throw new HttpError(401, '需要登录')
  if (token.startsWith('sat_')) return assertUsable(db, await db.accountByAccessToken(token))
  return await requireUser(req, db, keys)
}

/**
 * 只认席位 sat_。**浏览器的登录 JWT 不行**——这条路会带出 MCP 明文 token 与 env，
 * 那是给实例进程用的，不是给某个成员的浏览器用的。
 */
export async function requireSeatOnly(req: Req, db: Db): Promise<Account> {
  const token = bearer(req)
  if (!token || !token.startsWith('sat_')) throw new HttpError(401, '需要席位凭证')
  return assertUsable(db, await db.accountByAccessToken(token))
}

export function headerOf(req: Req, name: string): string | undefined {
  const v = req.headers[name]
  if (Array.isArray(v)) return v[0]
  return typeof v === 'string' ? v : undefined
}

/**
 * 这个 Gateway 对外的地址。
 *
 * 从请求头推，不从配置里读——同一份部署可能同时挂在内网 IP 和公网域名上，写死一个
 * 就会有一半的链接打不开。**回调地址也走这条**：连接器的 OAuth 回调必须落在用户
 * 刚才所在的那个域名上，否则浏览器带回来的是另一个源。
 */
export function originOf(req: Req): string {
  const host = headerOf(req, 'x-forwarded-host') || headerOf(req, 'host') || '127.0.0.1:3080'
  const proto = headerOf(req, 'x-forwarded-proto') || 'http'
  return `${proto}://${host}`
}

export function inviteLinkOf(req: Req, token: string): string {
  return `${originOf(req)}/join/${token}`
}

export async function inviteeOf(db: Db, token: string) {
  const id = sha256Hex(token)
  const row = await db.invite(id)
  if (!row) return null
  if (row.expiresAt < Date.now()) {
    await db.deleteInvite(id)
    return null
  }
  const user = await db.account(row.userId)
  if (!user || user.status === 'disabled') return null
  return { user, invite: row, id }
}

export async function issueInvite(db: Db, user: Account, createdBy: string, ttl: number) {
  await db.deleteInvitesForUser(user.id)
  const token = randomInviteToken()
  const now = Date.now()
  await db.putInvite({
    id: sha256Hex(token),
    userId: user.id,
    companyId: user.companyId ?? '',
    createdBy,
    createdAt: now,
    expiresAt: now + ttl,
  })
  return { token, expiresAt: now + ttl }
}

/**
 * 登录成功之后记一笔 lastSeenAt，**顺带确认这一刻账号还是验口令时那个样子**。
 *
 * `account` 是登录一开始读出来的那一行，中间隔着一次 scrypt（几十毫秒）。以前这里拿它的
 * status 整行写回去：管理员恰好在这几十毫秒里停用了这个人，这一句就把 active 写回去了——
 * 账号复活、席位检查绕过，签出来的票 iat 还在 tokenRevokedAt 之后，是张好票。
 *
 * 现在不写 status，只在「还是 active、口令和作废点都没被动过」时写 lastSeenAt；对不上就
 * 当登录失败，不签票。invited 本来就进不了登录（auth.ts 先拦了），这里也不再替它翻成 active。
 */
export async function noteLogin(db: Db, account: Account): Promise<Account> {
  const next = await db.updateAccountIf(
    account.id,
    { lastSeenAt: Date.now() },
    { status: ['active'], passwordHash: account.passwordHash, tokenRevokedAt: account.tokenRevokedAt },
  )
  if (next) return next
  const cur = await db.account(account.id)
  if (cur?.status === 'disabled') throw new HttpError(403, '这个账号已被停用，请联系管理员')
  throw new HttpError(401, '邮箱或口令不对')
}

export function statusOf(v: unknown): AccountStatus {
  if (v !== 'active' && v !== 'disabled' && v !== 'invited') throw new HttpError(400, 'status 只能是 active、disabled 或 invited')
  return v
}

export function losingAdmin(row: Account, nextRole: Role, nextStatus: AccountStatus): boolean {
  return row.role === 'admin' && row.status !== 'disabled' && (nextRole !== 'admin' || nextStatus === 'disabled')
}

/**
 * 「取登录态」+「判角色」这两步在路由里永远连着出现，合成一句。
 *
 * 拆成两行不是为了灵活——118 处调用点没有一处只做前半步。分开写的代价是：漏掉第二行
 * 不会有任何报错，那条路由就此对所有人敞开，而 diff 上看不出少了什么。合成一句之后，
 * 「谁能调这条」写在函数名里，漏不掉。
 */
export async function requireOwnerUser(req: Req, db: Db, keys: JwtKeys): Promise<Account> {
  const account = await requireUser(req, db, keys)
  requireOwner(account)
  return account
}

/** 同上，公司这一层。owner 照旧一路放行（见 requireOrg）。 */
export async function requireOrgUser(req: Req, db: Db, keys: JwtKeys, orgId: string, admin = false): Promise<Account> {
  const account = await requireUser(req, db, keys)
  requireOrg(account, orgId, admin)
  return account
}

export function requireOrg(account: Account, orgId: string, admin = false): void {
  if (account.role === 'owner') return
  if (account.companyId !== orgId) throw new HttpError(403, '不属于这家公司')
  if (admin && account.role !== 'admin') throw new HttpError(403, '需要管理员')
}

export function requireOwner(account: Account): void {
  if (account.role !== 'owner') throw new HttpError(403, '需要系统管理员')
}

export function requireBootstrapMachine(req: Req) {
  const expected = process.env.GATEWAY_MACHINE_TOKEN ?? ''
  const token = bearer(req)
  if (!expected || !token || !timingSafeToken(token, expected)) {
    throw new HttpError(401, '无效的机器凭证')
  }
}

/**
 * 凭机器票 `smt_` 认出是哪台机器。
 *
 * **默认不认墓碑**（`removedAt` 已立）。`machineByToken` 故意把墓碑也查出来——心跳要靠
 * 它把「你被移除了」送下去——但这不等于墓碑的票还能干别的：平台移除一台疑似被攻破
 * 的机器之后，它的票在墓碑躺着的那段时间（等回执，或者等 TTL 扫掉）里要是还能报会话
 * 索引、报守卫事件、拉发布包，就等于「移除」只在界面上生效。所以这里一律 403
 * `machine_removed`：肯定式的「我认识你，你已经被移除了」，和 401「不认识」分开。
 *
 * 只有收信那两条要 `allowRemoved`：心跳（回 `removed: true`）和收尾回执
 * （`/internal/machines/:id/removed`）。它们都只对墓碑做「告诉它 / 删掉它」这一件事。
 */
export async function requireMachine(req: Req, db: Db, opts: { allowRemoved?: boolean } = {}): Promise<Machine> {
  const token = bearer(req)
  if (!token) throw new HttpError(401, '无效的机器凭证')
  const machine = await db.machineByToken(token)
  if (!machine || !machine.token || !timingSafeToken(token, machine.token)) {
    throw new HttpError(401, '无效的机器凭证')
  }
  if (machine.removedAt && !opts.allowRemoved) {
    throw new HttpError(403, '这台机器已在平台上移除', { code: 'machine_removed' })
  }
  return machine
}

/**
 * `/internal/*` 里**由 bot 发起**的那几条（ready / sessions.index / usage）的调用方。
 *
 * 两种凭据都收，但权限不一样：
 *
 *  - `sat_` 席位票：bot 进程自己。只能报**它自己那个账号**的事，body 里的 accountId 不作数。
 *  - `smt_` 机器票：管家。能替本机任意席位报。
 *
 * 加 `sat_` 这条路是为了让 bot 不再需要机器票。`smt_` 同时是管家的 root 控制面凭据
 * （`PUT /seats/:id` 就是拿它鉴权的），以前却被写进席位 Linux 用户读得到的 `bot.env`，
 * 于是员工桌面上一句 `cat` 就能拿到整台机器的控制权。现在它不再离开
 * `/etc/satuwork/manager.json`。
 */
export type InternalCaller =
  | { kind: 'machine'; machine: Machine; companyId: string }
  | { kind: 'seat'; account: Account; companyId: string }

export async function requireInternalCaller(req: Req, db: Db): Promise<InternalCaller> {
  const token = bearer(req)
  if (token && token.startsWith('sat_')) {
    const account = await assertUsable(db, await db.accountByAccessToken(token))
    if (!account.companyId) throw new HttpError(403, '没有公司席位')
    return { kind: 'seat', account, companyId: account.companyId }
  }
  const machine = await requireMachine(req, db)
  if (!machine.companyId) throw new HttpError(403, '机器还没有派给公司')
  return { kind: 'machine', machine, companyId: machine.companyId }
}

/** 调用方能替哪个账号说话。席位票只能是自己，机器票由 body 指定。 */
export function callerAccountId(caller: InternalCaller, fromBody: () => string): string {
  return caller.kind === 'seat' ? caller.account.id : fromBody()
}

export function requirePlatformToken(req: Req) {
  const expected = process.env.GATEWAY_PLATFORM_TOKEN ?? ''
  const token = bearer(req)
  if (!expected || !token || !timingSafeToken(token, expected)) {
    throw new HttpError(401, '无效的平台凭证')
  }
}

/**
 * 谁能发布 Bot 版本：CI 拿平台令牌，人拿 owner 登录态。
 * 返回 accountId（平台令牌没有账号，返回空串）。
 */
export async function requireReleaseAuthor(req: Req, db: Db, keys: JwtKeys): Promise<string> {
  const expected = process.env.GATEWAY_PLATFORM_TOKEN ?? ''
  const token = bearer(req)
  if (expected && token && timingSafeToken(token, expected)) return ''
  const account = await requireUser(req, db, keys)
  requireOwner(account)
  return account.id
}

export function issue(keys: JwtKeys, account: Account) {
  return signJwt(
    keys,
    {
      sub: account.id,
      accountId: account.id,
      companyId: account.role === 'owner' ? '' : (account.companyId ?? ''),
      role: account.role,
    },
    JWT_TTL,
  )
}

export function kindOf(name: string): CatalogKind {
  const k = KIND[name]
  if (!k) throw new HttpError(404, '未知目录')
  return k
}

