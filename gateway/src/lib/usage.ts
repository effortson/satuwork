/**
 * 用量屏的口径：查询参数（范围、时区、粒度）、日线 / 小时线怎么铺、各块维度怎么算、整屏信封。
 *
 * 公司用量、员工自己的用量、平台统计三屏共用。以前一半在 guards.ts（和鉴权毫无关系，只是
 * 从 routes.ts 拆出来时落在了那儿），一半是 company.ts 里的一个闭包。
 */
import { HttpError, type Req } from '../http.ts'
import { usdMicros } from './validate.ts'
import type { Account, Db } from '../db.ts'
import { DAY_MS, HOUR_MS } from '../db/sql.ts'

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

/**
 * 用量屏那几块维度：日线、按 Bot、按模型、按类型。
 *
 * 都从已经有的两张表来——事实在 `llm_calls`，钱在账本——所以公司管理员这一屏和平台
 * 那一屏是同一个口径，不是另算一份。以前这四个字段是写死的空数组，界面上四块永远
 * 写着「还没有用量」，而底下的计费明细一屏都是——两个说法互相打脸。
 *
 * `offsetMs` 是看的人所在时区的偏移，只有日线用得上（见 `db.llmDailyBy`）。
 * `step` 是柱子的粒度：「今日」那一屏按小时，别的按天。
 */
export async function usageDims(
  db: Db,
  scope: { companyId?: string; accountId?: string },
  range: { from?: number; to?: number },
  offsetMs: number,
  step: BarStep = 'day',
) {
  const column = scope.companyId ? 'companyId' : 'accountId'
  const value = scope.companyId ?? scope.accountId ?? ''
  /**
   * 「今日」= 看的人所在时区的零点到现在，**不跟着上面选的范围走**：选「近 30 天」
   * 的时候想知道的也常常是「今天已经花了多少」，那一格从 30 根柱子里抠不准（最后一根
   * 的时区、边界都得自己心算）。
   */
  const now = Date.now()
  const todayBucket = dayBucketOf(now, offsetMs)
  const todayRange = { from: todayBucket * DAY_MS - offsetMs, to: now }
  const [buckets, spentBuckets, models, charges, todayUsage, todayCharges] = await Promise.all([
    db.llmDailyBy(column, value, range, offsetMs, stepMs(step)),
    db.chargeDailyBy(column, value, range, offsetMs, stepMs(step)),
    db.llmUsageByCompanyModel(range, scope.companyId, scope.accountId),
    db.chargeUsageBy(['botId', 'kind', 'subject'], range, scope),
    scope.companyId ? db.llmUsageOfCompany(scope.companyId, todayRange) : db.llmUsageOfAccount(value, todayRange),
    db.chargeUsageBy(['kind'], todayRange, scope),
  ])

  // 没有调用的那天（那个小时）也画一根 0 柱、右端不越过现在——规矩在 dailyBars / hourlyBars 里，
  // 平台统计那一屏同一套。
  const daily = usageBars(step, buckets, spentBuckets, range, offsetMs)

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
  /**
   * 三块分布的条长都按**钱**算，不按次数或 token：这一页回答的是「钱花哪了」，
   * 一次 gpt-5 的调用和一次连接器查询按次数等长，按钱差两个量级。排序跟着条长走，
   * 不然最长的条会出现在第二行。
   */
  const modelRows = [...modelAcc.entries()]
    .map(([name, m]) => ({ name, tokens: m.tokens, micros: spentBySubject.get(name) ?? 0 }))
    .sort((a, b) => b.micros - a.micros || b.tokens - a.tokens)
  const topModel = modelRows[0]?.micros ?? 0
  const byModel = modelRows.map((m) => ({
    name: m.name,
    value: `${n(m.tokens)} token · ${usdMicros(m.micros)}`,
    pct: pctOf(m.micros, topModel),
  }))

  const KINDS: [string, string][] = [['llm', '模型'], ['connector', '连接器'], ['web', '网页'], ['kb', '知识库']]
  const topKind = Math.max(0, ...[...byKindAcc.values()].map((x) => x.micros))
  const byKind = KINDS.filter(([k]) => byKindAcc.has(k)).map(([k, label]) => {
    const x = byKindAcc.get(k) as { calls: number; micros: number }
    return { name: label, value: `${n(x.calls)} 次 · ${usdMicros(x.micros)}`, pct: pctOf(x.micros, topKind) }
  })

  const bots = scope.companyId
    ? await db.companyBots(scope.companyId)
    : scope.accountId
      // 账单不按设备收：钱是这个账号花的，别的电脑上的本地 Bot 也得叫得出名字（docs/local-bot-device.md §4.2）。
      ? await db.botsFor((await db.account(scope.accountId))?.companyId ?? null, scope.accountId, { kind: 'seat' })
      : []
  const botName = new Map(bots.map((b) => [b.id, b.name]))
  const botRows = [...byBotAcc.entries()].sort((a, b) => b[1].micros - a[1].micros || b[1].calls - a[1].calls)
  const topBot = botRows[0]?.[1].micros ?? 0
  const byAgent = botRows.map(([id, x]) => ({
    // 名字查不到就用 id：Bot 被删了，它花过的钱还在账上。
    name: botName.get(id) ?? id,
    value: `${n(x.calls)} 次 · ${usdMicros(x.micros)}`,
    pct: pctOf(x.micros, topBot),
  }))

  const todayKind = new Map(todayCharges.map((c) => [c.kind, c]))
  const today = {
    label: dayLabelOf(todayBucket),
    calls: todayUsage.calls,
    promptTokens: todayUsage.promptTokens,
    completionTokens: todayUsage.completionTokens,
    amount: usdMicros(todayCharges.reduce((n, c) => n + c.amountMicros, 0)),
    // 三条路各自的次数和钱，一条都没有的不列——和上面「按类型」同一个口径。
    byKind: KINDS.filter(([k]) => todayKind.has(k)).map(([k, label]) => {
      const x = todayKind.get(k) as { calls: number; amountMicros: number }
      return { name: label, value: `${n(x.calls)} 次 · ${usdMicros(x.amountMicros)}` }
    }),
  }

  return { daily, byAgent, byModel, byKind, today }
}
