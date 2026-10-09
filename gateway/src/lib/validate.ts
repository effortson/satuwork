/**
 * 请求体、字段与枚举的校验。全是纯函数，不碰 db、不碰 res。
 *
 * 从 routes.ts 拆出来的——那个文件曾经是 5700 行，前 1900 行全是这类帮手。
 */
import { HttpError, type Req } from '../http.ts'
import { hashPassword } from '../crypto.ts'
import { type CatalogKind, PLAN_PERIODS, type PayStatus, type PlanPeriod } from '../db.ts'

/**
 * 登录票活多久（秒）。**配错了当场停机**，而不是签出一张 exp 为 NaN 的票：
 * `exp: NaN` 序列化成 null，verifyJwt 那头会当成「没有过期时间」，等于永不过期。
 */
export const JWT_TTL = jwtTtlOf(process.env.GATEWAY_JWT_TTL_SECONDS)

function jwtTtlOf(raw: string | undefined): number {
  if (raw == null || raw === '') return 7 * 24 * 3600
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`GATEWAY_JWT_TTL_SECONDS 必须是正数（秒），现在是 ${JSON.stringify(raw)}`)
  return n
}
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const SLUG_RE = /^[a-z][a-z0-9-]{0,61}[a-z0-9]$|^[a-z]$/
export const PHONE_RE = /^\+\d{1,4}[\s-]?[\d\s()-]{4,24}$/
export const KIND: Record<string, CatalogKind> = { models: 'model', skills: 'skill', mcp: 'mcp', bots: 'bot' }
export const LOGIN_DUMMY_HASH = hashPassword('satuwork-login-dummy')

export function bodyOf(req: Req): Record<string, unknown> {
  if (req.body == null) return {}
  if (typeof req.body !== 'object' || Array.isArray(req.body)) throw new HttpError(400, '请求体必须是对象')
  return req.body as Record<string, unknown>
}

export function deployOptsOf(req: Req): { botId: string; version?: string; update?: boolean; force?: boolean } {
  const body = bodyOf(req)
  const botId = strField(body, 'botId')
  const version = strField(body, 'version', false)
  // force 和 update 是两件事：update 是「换到最新版本」，force 是「版本不变也重铺一遍」。
  // 「重新部署」要的是后者——它想修的正是那些版本对、状态也 ready，但机器上就是不对的情况。
  return { botId, version: version || undefined, update: body.update === true, force: body.force === true }
}

export function strField(body: Record<string, unknown>, key: string, required = true): string {
  const v = body[key]
  if (v == null || v === '') {
    if (required) throw new HttpError(400, `${key} 不能为空`)
    return ''
  }
  if (typeof v !== 'string') throw new HttpError(400, `${key} 必须是字符串`)
  return v.trim()
}

export function intField(body: Record<string, unknown>, key: string): number | undefined {
  const v = body[key]
  if (v == null || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) throw new HttpError(400, `${key} 必须是数字`)
  return Math.trunc(n)
}

export function seatsOf(v: unknown, fallback?: number): number {
  if (v == null) {
    if (fallback == null) throw new HttpError(400, 'seats 不能为空')
    return fallback
  }
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'seats 必须是正整数')
  return n
}

/** 套餐里的知识库个数。0 合法（不含知识库），负数和小数不是。 */
export function knowledgeBasesOf(v: unknown, fallback?: number): number {
  if (v == null || v === '') {
    if (fallback == null) return 0
    return fallback
  }
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, 'knowledgeBases 必须是非负整数')
  return n
}

/**
 * 金额按「美元」进出接口，按「厘」（千分之一美元）存。0 是合法的（内部套餐、试用）。
 * 厘以下没有意义，直接拒掉——静默四舍五入会让人以为存进去了。
 */
export function amountMilsOf(v: unknown, fallback?: number): number {
  if (v == null || v === '') {
    if (fallback == null) throw new HttpError(400, 'amount 不能为空')
    return fallback
  }
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'amount 必须是不小于 0 的数')
  // 先放大再取整：0.1*1000 在浮点里是 100.00000000000001，round 一下才干净。
  const mils = Math.round(n * 1000)
  if (Math.abs(n * 1000 - mils) > 1e-6) throw new HttpError(400, 'amount 最多到厘（小数点后 3 位）')
  if (!Number.isSafeInteger(mils)) throw new HttpError(400, 'amount 太大')
  return mils
}

/** 赠送额度。跟金额同一套：按美元进出，按厘存。 */
export function bonusMilsOf(v: unknown, fallback?: number): number {
  if (v == null || v === '') return fallback ?? 0
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, '赠送额度必须是不小于 0 的数')
  const mils = Math.round(n * 1000)
  if (Math.abs(n * 1000 - mils) > 1e-6) throw new HttpError(400, '赠送额度最多到厘（小数点后 3 位）')
  if (!Number.isSafeInteger(mils)) throw new HttpError(400, '赠送额度太大')
  return mils
}

/** 周期只认三个枚举值。默认月包——不传就是月包，是产品定的默认。 */
export function periodOf(v: unknown, fallback: PlanPeriod = 'month'): PlanPeriod {
  if (v == null || v === '') return fallback
  const s = String(v)
  if (!(PLAN_PERIODS as string[]).includes(s)) throw new HttpError(400, 'period 只能是 month、quarter 或 year')
  return s as PlanPeriod
}

/**
 * 按周期算到期时间。用 UTC 的年月加法，不是加固定天数——
 * 「一个月」在 1 月和 2 月不一样长，加 30 天会让续费日期慢慢漂走。
 */
export function endOfPeriod(startAt: number, period: PlanPeriod): number {
  const d = new Date(startAt)
  const months = period === 'year' ? 12 : period === 'quarter' ? 3 : 1
  const day = d.getUTCDate()
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, day, d.getUTCHours(), d.getUTCMinutes()))
  // 1/31 + 1 个月没有 2/31，JS 会翻到 3/3；退回当月最后一天更符合直觉。
  if (end.getUTCDate() !== day) end.setUTCDate(0)
  return end.getTime()
}

/** 日期按 unix 毫秒收。前端传的是 YYYY-MM-DD，转成当天 UTC 零点。 */
export function dateMsOf(v: unknown, fallback?: number): number {
  if (v == null || v === '') {
    if (fallback == null) throw new HttpError(400, 'startAt 不能为空')
    return fallback
  }
  if (typeof v === 'number') return v
  const s = String(v)
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const n = Number(s)
  if (Number.isFinite(n) && n > 0) return n
  throw new HttpError(400, '日期格式不对，用 YYYY-MM-DD')
}

/** 账单那几列是现成的字符串。金额从整数「厘」格式化，不让 /1000 的浮点误差跑出去。 */
export function usd(mils: number): string {
  const a = Math.round(Math.abs(mils))
  const frac = a % 1000
  const dec = frac % 10 === 0 ? String(frac / 10).padStart(2, '0') : String(frac).padStart(3, '0')
  return `${mils < 0 ? '-' : ''}$${Math.floor(a / 1000).toLocaleString('en-US')}.${dec}`
}

/**
 * 微元 → 给人看的美元字符串。
 *
 * 账本存微元（一次调用值半厘是常态，用厘存会被舍成 0），界面显示到厘就够了——
 * 再往下的位数在一行账单上没有意义。**只在显示这一步舍**，参与运算的永远是微元。
 */
export function usdMicros(micros: number): string {
  return usd(Math.round(micros / 1000))
}

export function payStatusOf(v: unknown, fallback: PayStatus = 'unpaid'): PayStatus {
  if (v == null || v === '') return fallback
  if (v !== 'paid' && v !== 'unpaid') throw new HttpError(400, '付款状态只能是 paid 或 unpaid')
  return v
}

/** 引用里摘录的上限（字符），和席位那边 refExcerptOf 的上限一致。 */
const REF_EXCERPT_CHARS = 300

/**
 * 请求体里的 `refs` → 只剩认识的字段、截到 10 条（docs/chat-references.md §5.1）。
 *
 * **只认形状。** 文件路径越不越界、消息 seq 在不在，都是席位那头的事——那里才有工作区
 * 和会话日志。这里把不认识的 kind 丢掉、不认识的字段剥掉，席位收到的就永远是一个它
 * 认得的形状。
 */
export function refShapes(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return []
  const out: Record<string, unknown>[] = []
  for (const item of raw) {
    const o = (item ?? {}) as Record<string, unknown>
    const kind = String(o.kind ?? '')
    if (kind === 'file') {
      const path = typeof o.path === 'string' ? o.path.trim() : ''
      if (!path) continue
      const name = typeof o.name === 'string' ? o.name.trim().slice(0, 255) : ''
      out.push({ kind, path, ...(name ? { name } : {}) })
    } else if (kind === 'message') {
      const seq = Number(o.seq)
      const excerpt = typeof o.excerpt === 'string' ? o.excerpt.trim().slice(0, REF_EXCERPT_CHARS) : ''
      const role = o.role === 'user' ? 'user' : o.role === 'assistant' ? 'assistant' : ''
      const time = Number(o.time)
      out.push({
        kind,
        ...(Number.isSafeInteger(seq) && seq > 0 ? { seq } : {}),
        ...(excerpt ? { excerpt } : {}),
        ...(role ? { role } : {}),
        ...(Number.isFinite(time) && time > 0 ? { time } : {}),
      })
    }
    if (out.length >= 10) break
  }
  return out
}
