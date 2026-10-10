/**
 * 鉴权守卫、邀请、登录票，以及用量口径。
 *
 * 从 routes.ts 拆出来的——那个文件曾经是 5700 行，前 1900 行全是这类帮手。
 */
import { HttpError, type Req, bearer } from '../http.ts'
import { JWT_TTL, KIND, usdMicros } from './validate.ts'
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

export async function accountFromJwt(req: Req, db: Db, keys: JwtKeys): Promise<Account> {
  const token = bearer(req)
  if (!token) throw new HttpError(401, '需要登录')
  if (token.startsWith('sk_sw_') || token.startsWith('sat_')) throw new HttpError(401, '需要登录')
  let payload: JwtPayload
  try {
    payload = verifyJwt(keys, token)
  } catch (e) {
    throw new HttpError(401, (e as Error).message)
  }
  const account = await db.account(payload.accountId)
  if (!account) throw new HttpError(401, '账号不存在')
  if (ticketRevoked(account.tokenRevokedAt, payload)) {
    throw new HttpError(401, '登录已失效，请重新登录')
  }
  return gateCompany(db, gateAccount(account))
}

/** 控制台写操作：只要登录 JWT。sat_ / sk_sw_ 都不行。 */
export async function requireUser(req: Req, db: Db, keys: JwtKeys): Promise<Account> {
  return await accountFromJwt(req, db, keys)
}

/** Bot 拉目录：登录 JWT 或席位 sat_。sk_sw_ 不行。 */
export async function requireSeatOrUser(req: Req, db: Db, keys: JwtKeys): Promise<Account> {
  const token = bearer(req)
  if (!token) throw new HttpError(401, '需要登录')
  if (token.startsWith('sk_sw_')) throw new HttpError(401, '需要登录')
  if (token.startsWith('sat_')) return gateCompany(db, gateAccount(await db.accountByAccessToken(token)))
  return await accountFromJwt(req, db, keys)
}

/**
 * 只认席位 sat_。**浏览器的登录 JWT 不行**——这条路会带出 MCP 明文 token 与 env，
 * 那是给实例进程用的，不是给某个成员的浏览器用的。
 */
export async function requireSeatOnly(req: Req, db: Db): Promise<Account> {
  const token = bearer(req)
  if (!token || !token.startsWith('sat_')) throw new HttpError(401, '需要席位凭证')
  return gateCompany(db, gateAccount(await db.accountByAccessToken(token)))
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

export function rangeQuery(req: Req): { from?: number; to?: number } {
  const fromRaw = req.query.get('from')
  const toRaw = req.query.get('to')
  const from = fromRaw != null && fromRaw !== '' ? Number(fromRaw) : undefined
  const to = toRaw != null && toRaw !== '' ? Number(toRaw) : undefined
  if (fromRaw && fromRaw !== '' && !Number.isFinite(from)) throw new HttpError(400, 'from 必须是 unix 毫秒')
  if (toRaw && toRaw !== '' && !Number.isFinite(to)) throw new HttpError(400, 'to 必须是 unix 毫秒')
  return { from, to }
}

/**
 * 时区偏移（毫秒）。前端传的是 `Date.getTimezoneOffset()` 的**相反数**（东八区 +480 分）。
 * 缺省 0 = UTC 切天：老前端不带这个参数时，日线仍然画得出来，只是边界按 UTC。
 *
 * 公司用量屏和平台统计屏共用：两边的日线都按**看的人所在时区**切天，服务端不知道那是
 * 哪个时区（同 `rangeQuery` 的 from/to 由前端算好是一个道理）。
 */
export function tzOffsetMs(req: Req): number {
  const raw = (req.query.get('tz') || '').trim()
  if (!raw) return 0
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new HttpError(400, 'tz 必须是分钟数')
  // 谁也不在 ±16 小时之外。越界的值当没传，而不是让日线整体飘走。
  if (Math.abs(n) > 16 * 60) return 0
  return n * 60000
}

/**
 * 日线上的一根柱子。`label` 是给人看的日期，怎么写由算它的那一层决定。`value` 是模型调用
 * 次数（柱高），`amount` 是那一天账本上扣的钱（三条计费路都算）。
 */
export type UsageBar = { label: string; value: number; amount?: string; amountMicros?: number }

const DAY_MS = 86400000
const HOUR_MS = 3600000

/** 柱子按什么粒度切：按天（默认）还是按小时（「今日」那一屏）。 */
export type BarStep = 'day' | 'hour'

/** `step=hour` → 按小时切柱子；没传、传别的都按天——老前端不带这个参数，日线照旧。 */
export function stepQuery(req: Req): BarStep {
  return (req.query.get('step') || '').trim() === 'hour' ? 'hour' : 'day'
}

/** 一根柱子盖多长时间（毫秒）。SQL 里切桶和这里铺柱子用同一个数。 */
export function stepMs(step: BarStep): number {
  return step === 'hour' ? HOUR_MS : DAY_MS
}

/** 桶号（按看的人所在时区平移后的天序号，见 `db.llmDailyBy`）→ `MM/DD`。 */
export function dayLabelOf(bucket: number): string {
  const d = new Date(bucket * DAY_MS)
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`
}

/** 某一时刻落在哪个桶里。平移 `offsetMs` 之后按天切，和 SQL 里那句 `floor((createdAt + ?) / 86400000)` 一致。 */
export function dayBucketOf(at: number, offsetMs: number): number {
  return Math.floor((at + offsetMs) / DAY_MS)
}

/**
 * 把库里按桶聚合出来的两串数（调用次数、扣费）铺成一根根柱子。
 *
 * **没有调用的那天也要画出来**：只画有数的那几天，横轴会被悄悄压缩，「周末没人用」看上去
 * 和「天天都在用」长得一样。窗口两端按 from/to 算；没传的那头退回有数的第一 / 最后一天。
 *
 * **右端不越过今天**：「本月」那种窗口 to 是月底最后一刻，月中看的时候后半个月还没发生，
 * 画成一排 0 会被读成「下半月没人用」。
 *
 * 92 根柱子已经挤不下了；手搓一个三年的 from/to 不该把这一屏拖垮。
 */
export function dailyBars(
  buckets: { bucket: number; calls: number }[],
  spentBuckets: { bucket: number; amountMicros: number }[],
  range: { from?: number; to?: number },
  offsetMs: number,
): UsageBar[] {
  return barsOf(buckets, spentBuckets, range, offsetMs, DAY_MS, dayLabelOf, 92)
}

/** 桶号（平移后的小时序号）→ `HH:00`。 */
export function hourLabelOf(bucket: number): string {
  return `${String(new Date(bucket * HOUR_MS).getUTCHours()).padStart(2, '0')}:00`
}

/**
 * 按小时铺柱子，给「今日」那一屏用。规矩和 dailyBars 一样：窗口里没调用的那个小时也画
 * 一根 0 柱；右端不越过**现在这个小时**——下午三点看「今日」，后面九个小时还没发生，
 * 画成一排 0 会被读成「晚上没人用」。最多 48 根（手搓一个跨天的窗口也不该拖垮这一屏）。
 */
export function hourlyBars(
  buckets: { bucket: number; calls: number }[],
  spentBuckets: { bucket: number; amountMicros: number }[],
  range: { from?: number; to?: number },
  offsetMs: number,
): UsageBar[] {
  return barsOf(buckets, spentBuckets, range, offsetMs, HOUR_MS, hourLabelOf, 48)
}

/** 按粒度分派：`day` → dailyBars，`hour` → hourlyBars。路由那边拿 stepQuery 的结果直接调。 */
export function usageBars(
  step: BarStep,
  buckets: { bucket: number; calls: number }[],
  spentBuckets: { bucket: number; amountMicros: number }[],
  range: { from?: number; to?: number },
  offsetMs: number,
): UsageBar[] {
  return step === 'hour' ? hourlyBars(buckets, spentBuckets, range, offsetMs) : dailyBars(buckets, spentBuckets, range, offsetMs)
}

function barsOf(
  buckets: { bucket: number; calls: number }[],
  spentBuckets: { bucket: number; amountMicros: number }[],
  range: { from?: number; to?: number },
  offsetMs: number,
  sizeMs: number,
  labelOf: (bucket: number) => string,
  maxBars: number,
): UsageBar[] {
  const bucketOf = (at: number) => Math.floor((at + offsetMs) / sizeMs)
  const nowBucket = bucketOf(Date.now())
  const first = range.from != null ? bucketOf(range.from) : buckets[0]?.bucket
  const rawLast = range.to != null ? bucketOf(range.to) : buckets[buckets.length - 1]?.bucket
  const last = rawLast != null ? Math.min(rawLast, nowBucket) : undefined
  const bars: UsageBar[] = []
  if (first == null || last == null || last < first) return bars
  const counts = new Map(buckets.map((b) => [b.bucket, b.calls]))
  const spent = new Map(spentBuckets.map((b) => [b.bucket, b.amountMicros]))
  const start = Math.max(first, last - (maxBars - 1))
  for (let b = start; b <= last; b += 1) {
    const micros = spent.get(b) ?? 0
    bars.push({ label: labelOf(b), value: counts.get(b) ?? 0, amount: usdMicros(micros), amountMicros: micros })
  }
  return bars
}
/** 看的人所在时区的「今天」：零点到现在。不跟着界面上选的范围走。 */
export type UsageToday = {
  label: string
  calls: number
  promptTokens: number
  completionTokens: number
  amount: string
  byKind: { name: string; value: string }[]
}
/** 一条量表：名字、右边那行小字、以及 0–100 的占比。 */
export type UsageMeter = { name: string; value: string; pct: number }

export function usagePayload(
  usage: { calls: number; promptTokens: number; completionTokens: number; byAccount: { accountId: string; calls: number; promptTokens: number; completionTokens: number; lastAt: number | null }[] },
  opts: {
    seats: number
    members: Account[]
    includeMembers: boolean
    /**
     * 账本上每个人扣了多少微元。**含三条计费路**，不只是模型——「谁烧的钱」这个问题
     * 按 token 是答不全的：一个人跑一天搜索、一次模型都不调，按 token 看他是零。
     */
    spentByAccount?: Map<string, number>
    /** 这个范围内一共扣了多少微元。顶上那张「费用」卡用它。 */
    spentMicros?: number
    /**
     * 下面那几块维度：日线、按 Bot、按模型、按类型。都由路由那边算好——这里只负责
     * 把它们摆进同一个信封，不去碰库。给空数组时界面画各自的空态。
     */
    dims?: { daily?: UsageBar[]; byAgent?: UsageMeter[]; byModel?: UsageMeter[]; byKind?: UsageMeter[]; today?: UsageToday }
  },
) {
  const spent = opts.spentByAccount ?? new Map<string, number>()
  const byAccount = new Map(usage.byAccount.map((row) => [row.accountId, row]))
  /**
   * 名册上已经没有、但用量记录还在的那些人。
   *
   * 删员工时他的 llm_calls 是**留着**的（留档要求），所以公司总数里一直含着这部分，
   * 而下面「按成员」只列现有成员。不把这一行兜出来，顶部的总数就大于各行相加，差额
   * 没有出处——看的人只会以为哪里算错了。
   */
  const departed = usage.byAccount.filter((row) => !opts.members.some((m) => m.id === row.accountId))
  const departedRow =
    departed.length === 0
      ? null
      : {
          id: '',
          departed: true,
          count: departed.length,
          name: '已离职员工',
          initial: '·',
          tasks: String(departed.reduce((n, r) => n + r.calls, 0)),
          tokens: String(departed.reduce((n, r) => n + r.promptTokens + r.completionTokens, 0)),
          amount: usdMicros(departed.reduce((n, r) => n + (spent.get(r.accountId) ?? 0), 0)),
          last: '—',
        }
  return {
    stats: [
      { label: '任务执行', value: String(usage.calls), delta: '—' },
      { label: '输入 Tokens', value: String(usage.promptTokens), delta: '—' },
      { label: '输出 Tokens', value: String(usage.completionTokens), delta: '—' },
      // 以前这里永远是 '—'（「按量扣费还没接」）。现在是真的。
      { label: '费用', value: usdMicros(opts.spentMicros ?? 0), delta: '—' },
    ],
    daily: opts.dims?.daily ?? [],
    today: opts.dims?.today ?? null,
    byAgent: opts.dims?.byAgent ?? [],
    byModel: opts.dims?.byModel ?? [],
    // 套餐额度这一维**故意还是空的**：当前套餐只约束席位，没有任务次数和 token 额度，
    // 编一个分母出来会被当成真的在生效。界面上那句话说的就是这件事。
    quota: [] as unknown[],
    // 三条计费路各自的次数和钱。模型那条填不上 botId（见 lib/meter.ts），所以「按 Bot」
    // 覆盖不全；这一维是能覆盖全的那个，两块并排看才知道钱花在哪一类上。
    byKind: opts.dims?.byKind ?? [],
    seats: opts.seats,
    ...(opts.includeMembers
      ? {
          byMember: [
            ...opts.members.map((m) => {
              const name = m.name || m.email
              const initial = (name || '·').trim().slice(0, 1).toUpperCase()
              const row = byAccount.get(m.id)
              const tokens = row ? row.promptTokens + row.completionTokens : 0
              return {
                id: m.id,
                departed: false,
                count: 0,
                name,
                initial,
                tasks: String(row?.calls ?? 0),
                tokens: String(tokens),
                amount: usdMicros(spent.get(m.id) ?? 0),
                last: '—',
              }
            }),
            ...(departedRow ? [departedRow] : []),
          ],
        }
      : {}),
  }
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
    const account = await gateCompany(db, gateAccount(await db.accountByAccessToken(token)))
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

