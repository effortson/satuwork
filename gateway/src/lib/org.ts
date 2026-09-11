/**
 * 公司、账号、分组、会话索引：校验与对外序列化。
 *
 * 从 routes.ts 拆出来的——那个文件曾经是 5700 行，前 1900 行全是这类帮手。
 */
import { EMAIL_RE, PHONE_RE, SLUG_RE, strField } from './validate.ts'
import { losingAdmin, statusOf } from './guards.ts'
import { HttpError } from '../http.ts'
import { type Account, type AccountStatus, type CatalogItem, type Company, type CompanySettings, type CompanyStatus, type Db, type Group, type ModelRate, type ModelRole, type BillingSettings, PRICE_MULTIPLIER_MAX, PRICE_MULTIPLIER_MIN, REASONING_EFFORTS, type Plan, type PlatformSettings, type Role, type SessionIndex, parseBilling, parseConnectorPricing, parseModelPricing, parsePriceMultiplier, parseReasoningEffort } from '../db.ts'
import { WEB_BACKENDS, WEB_DOCUMENT } from '../db/types.ts'
import { VENDORS } from '../connectors/index.ts'

export function emailOf(raw: string): string {
  const email = raw.trim().toLowerCase()
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'email 格式不对')
  return email
}

export function slugOf(raw: string): string {
  const slug = raw.trim().toLowerCase()
  if (!SLUG_RE.test(slug)) throw new HttpError(400, 'slug 只能是小写字母开头的短名（字母数字和连字符）')
  return slug
}

export function companyStatusOf(v: unknown): CompanyStatus {
  if (v !== 'active' && v !== 'disabled') throw new HttpError(400, 'status 只能是 active 或 disabled')
  return v
}

/**
 * 到期时间。收 `YYYY-MM-DD`（当天 23:59:59 到期，按本地时区）或毫秒时间戳；
 * null / 空串 = 不限期。
 */
export function expiresAtOf(v: unknown): number | null {
  if (v == null || v === '') return null
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) throw new HttpError(400, '到期时间不对')
    return Math.floor(v)
  }
  if (typeof v !== 'string') throw new HttpError(400, '到期时间不对')
  const day = v.trim()
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T23:59:59.999`).getTime() : new Date(day).getTime()
  if (!Number.isFinite(ms)) throw new HttpError(400, '到期时间不对')
  return ms
}

/**
 * 号码要带国家区号：`+` 加 1~4 位区号，后面是本地号码。
 * 各国本地格式差太多，后半段只挡明显不是号码的：数字、空格、连字符、括号。
 */
export function phoneOf(raw: string): string {
  const phone = raw.trim()
  if (!PHONE_RE.test(phone)) throw new HttpError(400, '电话要带国家区号，例如 +86 13800000000')
  return phone
}

/** 公司官网。可以不写 scheme，补成 https；别的协议不收。 */
export function websiteOf(raw: string): string {
  const text = raw.trim()
  if (!text) return ''
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
  let u: URL
  try {
    u = new URL(hasScheme ? text : `https://${text}`)
  } catch {
    throw new HttpError(400, '网站必须是 http/https 地址')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, '网站必须是 http/https 地址')
  return u.toString().replace(/\/$/, '')
}

export function roleOf(v: unknown, fallback: Role = 'member'): Role {
  if (v == null || v === '') return fallback
  if (v !== 'admin' && v !== 'member') throw new HttpError(400, 'role 只能是 admin 或 member')
  return v
}

export function modelRoleOf(v: unknown, label: string): ModelRole {
  if (v == null) return { provider: '', model: '', reasoningEffort: 'off' }
  if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, `${label} 必须是对象`)
  const o = v as Record<string, unknown>
  const provider = o.provider == null || o.provider === '' ? '' : strField(o, 'provider')
  const model = o.model == null || o.model === '' ? '' : strField(o, 'model')
  if (Boolean(provider) !== Boolean(model)) throw new HttpError(400, `${label} 需要同时有 provider 和 model`)
  if (o.reasoningEffort != null && !(REASONING_EFFORTS as readonly unknown[]).includes(o.reasoningEffort)) {
    throw new HttpError(400, `${label}.reasoningEffort 不合法`)
  }
  return { provider, model, reasoningEffort: parseReasoningEffort(o.reasoningEffort) }
}

export function publicSettings(s: CompanySettings | PlatformSettings): PlatformSettings {
  return {
    daily: { provider: s.daily.provider, model: s.daily.model, reasoningEffort: parseReasoningEffort(s.daily.reasoningEffort) },
    utility: { provider: s.utility.provider, model: s.utility.model, reasoningEffort: parseReasoningEffort(s.utility.reasoningEffort) },
    enabledModels: Array.isArray((s as PlatformSettings).enabledModels) ? (s as PlatformSettings).enabledModels : [],
    priceMultiplier: parsePriceMultiplier((s as PlatformSettings).priceMultiplier),
    connectorPricing: parseConnectorPricing((s as PlatformSettings).connectorPricing),
    managerVersion: (s as PlatformSettings).managerVersion ?? '',
    modelPricing: parseModelPricing((s as PlatformSettings).modelPricing),
    billing: parseBilling((s as PlatformSettings).billing),
  }
}

export function publicPlatformCred(c: { provider: string; createdAt: number; updatedAt: number }) {
  return { configured: true as const, provider: c.provider, createdAt: c.createdAt, updatedAt: c.updatedAt }
}

/**
 * `platform_credentials` 是一张**按名字存密钥的通用表**，三类东西都住在里面：
 * 模型供应商（openai、anthropic、自定义端点）、连接器供应商（composio）、网页搜索
 * 与提取后端（tavily 那几个）。表可以合，**清单不能合**。
 *
 * 「供应商」那一屏讲的是模型：一行的每一列——多少个模型、测一下通不通、哪个角色在
 * 用它——对连接器和搜索后端全都答不上来。混进去的结果就是那屏上多出一个 0 个模型、
 * 测不了、删了还会从别处再冒出来的假供应商，而它真正的配置屏在另外两页。
 *
 * 所以对外报密钥清单的那两条接口在这里过一道：**只报模型供应商**。另外两类各自有
 * 自己的接口和自己的页面（`/platform/connector-vendors`、`/platform/tools/web`），
 * 那才是它们该出现的地方。
 */
const NON_MODEL_SECRETS: ReadonlySet<string> = new Set<string>([...VENDORS, ...WEB_BACKENDS, WEB_DOCUMENT])

export function isModelProvider(provider: string): boolean {
  return !NON_MODEL_SECRETS.has(provider)
}

export function modelProviderCreds<T extends { provider: string }>(creds: T[]): T[] {
  return creds.filter((c) => isModelProvider(c.provider))
}

/**
 * 公司当前的订阅。套餐名跟着 SKU 走（SKU 改名这里就改名），所以每次现查，不落一份副本。
 * 套餐被删了就当没订：skuId 留着，名字给 null，界面显示「—」。
 */
export async function publicPlan(db: Db, plan: Plan | undefined, used: number) {
  const sku = plan?.skuId ? await db.planSku(plan.skuId) : undefined
  // 账期按生效的那张订单来：订单上的周期可以跟价目表不一样（改过价、改过周期的单子），
  // 卖出去的那张才算数。
  const active = plan ? await db.activePaidOrder(plan.companyId) : undefined
  return {
    seats: plan?.seats ?? 0,
    used,
    skuId: plan?.skuId ?? null,
    skuName: sku?.name ?? null,
    skuNameEn: sku?.nameEn ?? null,
    period: active?.period ?? sku?.period ?? null,
    expiresAt: plan?.expiresAt ?? null,
    updatedAt: plan?.updatedAt ?? 0,
  }
}

/**
 * 改一个账号的名字 / 角色 / 状态，**规矩全在这里**。
 *
 * 两条路进来：公司管理员改自己公司的人（`PATCH /orgs/:id/accounts/:accountId`），以及
 * 系统管理员在平台的「用户」那一页上改任何人（`PATCH /platform/accounts/:id`）。**规矩
 * 只能有一份**——「不能改自己」「待接受不能被直接激活」「至少留一个管理员」「重新激活
 * 要占席位」这几条，抄成两份的那一天起，两条路就开始各自漂移，而漂移的方向恰好是没人
 * 会去测的那一边。
 *
 * 鉴权不在这里：谁能碰这个账号由路由自己判（公司侧 requireOrg，平台侧 requireOwner）。
 * 审计也不在这里，两边记的 action 不一样。
 */
export async function patchAccount(
  db: Db,
  actor: Account,
  row: Account,
  body: { name?: unknown; role?: unknown; status?: unknown },
): Promise<{ account: Account; patch: { name?: string; role?: Role; status?: AccountStatus } }> {
  // `null` 和没传一样看待：roleOf 会把 null 折成 member，靠真值判断的话 `role: null`
  // 就绕过了这道闸，把自己从 admin 悄悄降成 member。
  if (row.id === actor.id && ((body.role != null && body.role !== '') || (body.status != null && body.status !== ''))) {
    throw new HttpError(400, '不能改自己的角色或状态')
  }
  const patch: { name?: string; role?: Role; status?: AccountStatus; tokenRevokedAt?: number | null } = {}
  if (body.name != null) {
    const name = strField(body as Record<string, unknown>, 'name')
    if (!name) throw new HttpError(400, 'name 不能为空')
    patch.name = name
  }
  if (body.role != null && body.role !== '') patch.role = roleOf(body.role)
  // owner 这一行只能停用，**不能改成 admin / member**：roleOf 已经不收 `owner`，所以任何
  // 送来的角色都是降级；降完的 owner 属于哪家公司说不清（它没有 companyId），而且平台
  // 那一层的写入口全都 requireOwner，降掉最后一个之后再没人能改回来。
  if (row.role === 'owner' && patch.role && patch.role !== 'owner') throw new HttpError(400, '系统管理员的角色不能改')
  if (body.status != null && body.status !== '') patch.status = statusOf(body.status)
  const nextRole = patch.role ?? row.role
  const nextStatus = patch.status ?? row.status
  if (patch.status === 'invited' && row.status !== 'invited') {
    throw new HttpError(400, '已激活的账号不能退回待接受，需要重设口令请用重置链接')
  }
  if (patch.status === 'active' && row.status === 'invited') {
    throw new HttpError(400, '待接受的账号不能由管理员直接激活，对方需用邀请链接设置口令')
  }
  if (row.companyId && losingAdmin(row, nextRole, nextStatus) && (await db.adminCount(row.companyId)) <= 1) {
    throw new HttpError(409, '至少要留一个管理员')
  }
  /**
   * 系统管理员这一层同理：**最后一个还能登录的 owner 不许停**。
   *
   * 平台账号不属于任何公司，上面那条按公司数的检查够不着它。把最后一个 owner 停掉之后，
   * 没有任何一条路能再把它开回来——这一层的写入口全都 requireOwner。
   */
  // 不再要求 `!row.companyId`：owner 行本不该有公司，但万一有（老数据、手改的库），
  // 上面那条按公司数的检查看的是 admin，仍然够不着它。
  if (row.role === 'owner' && patch.status === 'disabled' && (await db.activeOwnerCount()) <= 1) {
    throw new HttpError(409, '至少要留一个能登录的系统管理员')
  }
  if (patch.status === 'disabled') patch.tokenRevokedAt = Date.now()
  // 停用的人重新激活会多占一个席位。满了就不让激活——先加席位，或者停掉别人。
  // 检查和写入放在同一个事务里，并先锁住套餐行，否则两个人同时激活会一起挤进来。
  const account = await db.tx(async () => {
    if (patch.status === 'active' && row.status === 'disabled' && row.companyId) {
      await db.lockPlan(row.companyId)
      const seats = (await db.plan(row.companyId))?.seats ?? 0
      const used = await db.accountCount(row.companyId)
      if (used >= seats) throw new HttpError(409, '席位已满，先加席位或停用其他成员', { seats, used })
    }
    return db.updateAccount(row.id, patch)
  })
  return { account, patch }
}

export async function orgSummary(db: Db, c: Company) {
  const plan = await db.plan(c.id)
  const used = await db.accountCount(c.id)
  return {
    ...publicCompany(c),
    seats: plan?.seats ?? 0,
    used,
    plan: await publicPlan(db, plan, used),
  }
}

export function enabledModelsOf(v: unknown): string[] {
  if (v == null) return []
  if (!Array.isArray(v)) throw new HttpError(400, 'enabledModels 必须是数组')
  return v.map((x) => {
    if (typeof x !== 'string' || !x.trim()) throw new HttpError(400, 'enabledModels 必须是模型 id 字符串')
    return x.trim()
  })
}

/** 倍率写坏了要当场报错，不能悄悄回落成 1——那等于把管理员改的价吞了。 */
export function priceMultiplierOf(v: unknown, fallback: number): number {
  if (v == null || v === '') return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) throw new HttpError(400, 'priceMultiplier 必须是数字')
  if (n < PRICE_MULTIPLIER_MIN || n > PRICE_MULTIPLIER_MAX) {
    throw new HttpError(400, `priceMultiplier 只能在 ${PRICE_MULTIPLIER_MIN} 到 ${PRICE_MULTIPLIER_MAX} 之间`)
  }
  return n
}

/**
 * 模型单价覆盖表。写坏了当场报错，不悄悄回落——回落等于把管理员刚填的价吞了，
 * 而他会以为已经改上了（同 priceMultiplierOf 的处理）。
 */
export function modelPricingOf(v: unknown, fallback: Record<string, ModelRate>): Record<string, ModelRate> {
  if (v == null) return fallback
  if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'modelPricing 必须是对象')
  for (const [key, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!key.includes('/')) throw new HttpError(400, `modelPricing 的键要写成 provider/model：${key}`)
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new HttpError(400, `${key} 的单价必须是对象`)
    }
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      const n = (raw as Record<string, unknown>)[field]
      if (n == null || n === '') continue
      const x = Number(n)
      if (!Number.isFinite(x) || x < 0) throw new HttpError(400, `${key} 的 ${field} 必须是不小于 0 的数字`)
    }
  }
  return parseModelPricing(v)
}

/** 熔断开关。`enforce` 不传就不动——整份覆盖上去的写法容易把它顺手抹掉。 */
export function billingOf(v: unknown, fallback: BillingSettings): BillingSettings {
  if (v == null) return fallback
  if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'billing 必须是对象')
  const o = v as Record<string, unknown>
  if (o.enforce != null && typeof o.enforce !== 'boolean') throw new HttpError(400, 'billing.enforce 只能是 true/false')
  if (o.graceMicros != null && o.graceMicros !== '') {
    const n = Number(o.graceMicros)
    if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'billing.graceMicros 必须是不小于 0 的整数微元')
  }
  return parseBilling({ enforce: o.enforce ?? fallback.enforce, graceMicros: o.graceMicros ?? fallback.graceMicros })
}

export function publicAccount(a: Account) {
  return {
    id: a.id,
    email: a.email,
    name: a.name,
    title: a.title,
    phone: a.phone,
    theme: a.theme,
    locale: a.locale,
    role: a.role,
    status: a.status,
    companyId: a.companyId,
    createdAt: a.createdAt,
    lastSeenAt: a.lastSeenAt,
    passwordChangedAt: a.passwordChangedAt,
  }
}

/** 对外不带 companyId，形状跟 Bot 一致。 */
export function publicGroup(g: Group) {
  return {
    id: g.id,
    name: g.name,
    desc: g.desc,
    icon: g.icon,
    role: g.role,
    members: g.members,
    agents: g.agents,
    createdAt: g.createdAt,
    builtin: false as const,
  }
}

export function stringIds(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
}

export function groupRoleOf(v: unknown): 'admin' | 'member' {
  return v === 'admin' ? 'admin' : 'member'
}

export async function membersInCompany(db: Db, companyId: string, v: unknown): Promise<string[]> {
  const allowed = new Set((await db.accountsOf(companyId)).map((a) => a.id))
  return stringIds(v).filter((id) => allowed.has(id))
}

export function publicCompany(c: Company) {
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    status: c.status,
    contactName: c.contactName,
    contactPhone: c.contactPhone,
    contactEmail: c.contactEmail,
    address: c.address,
    website: c.website,
    machineId: c.machineId,
    accessUrl: c.accessUrl,
    /**
     * 转人工的通知地址。**回显出去**：管理员要能看到自己配的是哪一条、也要能改。
     *
     * 它和模型密钥不是一回事——那种一律不回显，因为泄漏等于别人可以拿我们的额度花钱；
     * 这一条泄漏的后果是「有人往那个群里发消息」，而能看到它的只有本公司管理员，
     * 藏起来换来的是一个改不动、也看不出改没改成的输入框。
     */
    handoffWebhook: c.handoffWebhook,
    createdAt: c.createdAt,
  }
}

/**
 * 一行会话索引对外的样子。
 *
 * `names` 是可选的预取表：列表接口一次性把本公司的账号和 Bot 拉齐再传进来，省掉每行
 * 两次查库——一页 200 行就是 400 次往返。单条详情接口不传，照旧现查。
 */
/**
 * 会话列表的翻页游标：`updatedAt:sessionId`。
 *
 * 排序键是 ("updatedAt" desc, "sessionId" desc)，游标就得是同一对值——只带 updatedAt
 * 的话，同一毫秒上报的两条会话在翻页边界上要么漏要么重。
 */
export function sessionCursorOf(raw: string | null): { updatedAt: number; sessionId: string } | undefined {
  const text = (raw || '').trim()
  if (!text) return undefined
  const i = text.indexOf(':')
  const updatedAt = Number(text.slice(0, i))
  const sessionId = i < 0 ? '' : text.slice(i + 1)
  if (i < 0 || !Number.isFinite(updatedAt) || !sessionId) throw new HttpError(400, 'cursor 不合法')
  return { updatedAt, sessionId }
}

/**
 * 计费明细的翻页游标：`createdAt:id`。
 *
 * 和会话那条一样要带第二把钥匙：账本一毫秒里落好几行是常态（一轮里并发的几个工具调用），
 * 只比时间的话翻页边界上要么漏要么重。
 */
export function chargeCursorOf(raw: string | null): { createdAt: number; id: string } | undefined {
  const text = (raw || '').trim()
  if (!text) return undefined
  const i = text.indexOf(':')
  const createdAt = Number(text.slice(0, i))
  const id = i < 0 ? '' : text.slice(i + 1)
  if (i < 0 || !Number.isFinite(createdAt) || !id) throw new HttpError(400, 'cursor 不合法')
  return { createdAt, id }
}

export async function publicSessionIndex(
  db: Db,
  row: SessionIndex,
  names?: { accounts: Map<string, Account>; bots: Map<string, CatalogItem> },
) {
  const account = names ? names.accounts.get(row.accountId) : await db.account(row.accountId)
  const bot = row.botId ? (names ? names.bots.get(row.botId) : await db.catalog(row.botId)) : undefined
  return {
    sessionId: row.sessionId,
    accountId: row.accountId,
    accountName: account?.name || account?.email || row.accountId,
    botId: row.botId,
    botName: bot && bot.kind === 'bot' ? bot.name : null,
    origin: row.origin,
    remoteId: row.remoteId,
    messageCount: row.messageCount,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    machineId: row.machineId,
  }
}
