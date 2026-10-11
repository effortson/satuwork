/**
 * 转义、金额与时间。原先在 gateway/ui/state.js 里，都是纯函数：不发请求、不碰 DOM。
 */

/** HTML 转义。移动端用不上它（RN 没有 innerHTML），留在这儿是因为 Web 的每一页都在用。 */
export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

/**
 * 全站时间戳按这个时区读：fmtTime、对话页的时钟和「今天/昨天」（chat.js）、日期筛选
 * 的零点（dayStart/dayEnd、pages-machines.js 的 loadRangeOf）都用它。**只在这里定义**，
 * 以前 chat.js 另有一份 CHAT_TZ、筛选按浏览器本地零点算——同一屏上列表按此时区显示
 * 日期、筛选却按本地日历圈，差八小时的人会看到「筛了今天却有昨天的」。
 */
export const SATU_TZ = 'Asia/Kuching'

/** 某一刻在 SATU_TZ 下的墙钟偏移（毫秒）：墙钟当作 UTC 读出来的值减去真实 epoch。 */
export function tzOffsetMs(ms: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SATU_TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms))
  const n = (type: string) => Number(parts.find((x) => x.type === type)?.value)
  const wall = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour') % 24, n('minute'), n('second'))
  return wall - Math.floor(ms / 1000) * 1000
}

/**
 * SATU_TZ 下某一天（YYYY-MM-DD）的零点 epoch 毫秒。`dayOffset` 为 1 是「下一天零点」。
 * 先当 UTC 算，再按该时区当时的偏移修正；修两轮是为了跨夏令时切换那两天也稳。
 */
export function tzDayStart(dateStr: unknown, dayOffset = 0): number {
  const [y, m, d] = String(dateStr || '').split('-').map(Number)
  if (!y || !m || !d) return NaN
  const wall = Date.UTC(y, m - 1, d + dayOffset)
  let guess = wall - tzOffsetMs(wall)
  guess = wall - tzOffsetMs(guess)
  return guess
}

/** SATU_TZ 下的 YYYY-MM-DD。 */
export function tzDayKey(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: SATU_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))
}

export function fmtTime(ms: number | null | undefined): string {
  if (!ms) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: SATU_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms))
}

/** 日期筛选的起点：SATU_TZ 下那天的零点；空串或坏日期回空串（表单里「没填」的形状）。 */
export function dayStart(dateStr: unknown): number | '' {
  if (!dateStr) return ''
  const t = tzDayStart(dateStr)
  return Number.isFinite(t) ? t : ''
}

/** 日期筛选的终点：SATU_TZ 下那天的最后一毫秒。 */
export function dayEnd(dateStr: unknown): number | '' {
  if (!dateStr) return ''
  const t = tzDayStart(dateStr, 1) - 1
  return Number.isFinite(t) ? t : ''
}

/** token 成本，美元。不足 $1 要看到第三位小数。 */
export function money(n: unknown): string {
  if (n === undefined || n === null || n === '') return '—'
  const x = Number(n)
  if (!Number.isFinite(x)) return '—'
  return x >= 1 ? `$${x.toFixed(2)}` : `$${x.toFixed(3)}`
}

/** 界面语言。只有这两种；别处要判断语言一律用这个类型。 */
export type Locale = 'zh' | 'en'

/**
 * 套餐金额。入参是**厘**（整数，千分之一美元），不是元——从整数格式化，
 * 免得 amount/1000 的浮点误差跑到界面上。
 * 常规价显示两位小数；带厘位的价（$0.005 这种）才显示第三位，不然满屏都是多余的 0。
 *
 * 千分位按语言分：以前这里直接读 prefs.js 的 localeMode，现在由调用方传进来。
 */
export function usd(mils: unknown, locale: Locale = 'zh'): string {
  const m = Number(mils)
  if (!Number.isFinite(m)) return '—'
  if (m === 0) return '$0.00'
  const neg = m < 0
  const a = Math.round(Math.abs(m))
  const whole = Math.floor(a / 1000)
  const frac = a % 1000
  const dec = frac % 10 === 0 ? String(frac / 10).padStart(2, '0') : String(frac).padStart(3, '0')
  const loc = locale === 'en' ? 'en-US' : 'zh-CN'
  return `${neg ? '-' : ''}$${whole.toLocaleString(loc)}.${dec}`
}

/** token 数：1.2M / 340K。Web 里叫 tokens()，这儿改名是为了不和「票」撞。 */
export function fmtTokens(n: number | null | undefined): string {
  if (!n) return '—'
  return n >= 1000000 ? `${(n / 1000000).toFixed(n % 1000000 ? 1 : 0)}M` : `${Math.round(n / 1000)}K`
}
