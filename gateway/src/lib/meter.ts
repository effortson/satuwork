/**
 * 计费适配器：三条会花钱的路共用的一套动作。
 *
 * 在这之前，三条路各写各的——连接器在 `routes/mcp.ts` 里有自己的 `budgetOf` 和
 * `priceMicrosOf`，网页工具在 `web-service.ts` 里有自己的 `quoteMils` 和 `meter`，
 * 模型那条什么都没有。三份余额口径，其中两份还只看自己那张表：一家公司把钱全烧在
 * 模型上，连接器那边算出来的余额纹丝不动。
 *
 * 这里统一的是**数据形状和落账口径**，不是控制流：
 *
 *     const gate = await meter.gate(account)
 *     if (!gate.ok) { …各自的拒绝方式… }
 *     …真正干活…
 *     await meter.charge(billable)
 *
 * **刻意不做成 `meter.run(fn)` 那种包一层的写法。** 三条路对「什么算跑过了」的判定
 * 完全不同：连接器是「provider 返回即计费、抛出即不计费、超时另算」，模型是「拿到
 * usage 才知道多少钱、断流也要记」，网页工具是「命中缓存不计费、部分失败按成功条数
 * 算」。包进一个高阶函数里，这三种判定会退化成三个布尔参数，比现在更难读。
 *
 * 见 docs/billing.md。
 */
import type { Account, ChargeStatus, Db, ModelRate, PlatformSettings, UsageCharge, WebCallKind } from '../db.ts'
import { emptyWebTools, parseBilling, parseModelPricing, parseModelRate, parsePriceMultiplier } from '../db.ts'
import { balanceOf } from './billing.ts'
import { type LlmTokens, connectorMicros, llmMicros, rateOf, rateSnapshot, webMicros } from './pricing.ts'

/**
 * 一次计费调用的事实。三种 kind 一个联合类型——`quote` 按 kind 分支，漏一支编译不过。
 *
 * `botId` / `sessionId` 现在只有连接器那条路填得上（席位调用时带在 query 上）；
 * 模型那条两个都是空——`/v1/*` 收到的是一个 OpenAI 兼容请求，里面没有会话这个概念。
 * 见迁移 0007 里那段注释。
 */
export type Billable =
  | {
      kind: 'llm'
      account: Account
      botId?: string | null
      sessionId?: string | null
      status: ChargeStatus
      provider: string
      model: string
      tokens: LlmTokens
      /** 目录里那份 `cost`（pi-ai 内置 / 自定义供应商 / 公司目录）。平台覆盖压在它上面。 */
      cost: unknown
      refId?: string | null
    }
  | {
      kind: 'connector'
      account: Account
      botId?: string | null
      sessionId?: string | null
      status: ChargeStatus
      toolkit: string
      tool: string
      refId?: string | null
      /** 这一次不收钱（我们自己拒掉的、没跑成的）。流水照落，金额 0。 */
      free?: boolean
    }
  | {
      kind: 'web'
      account: Account
      botId?: string | null
      sessionId?: string | null
      status: ChargeStatus
      backend: string
      webKind: WebCallKind
      units: number
      refId?: string | null
    }

export interface Quote {
  amountMicros: number
  unitPrice: Record<string, number>
  multiplier: number
  /** 查不到单价。金额是 0，但**不等于免费**——界面要据此喊出来。 */
  unpriced: boolean
}

export interface Budget {
  /** 套餐赠送还剩多少微元。跟着账期，到期作废。 */
  bonusLeft: number
  /** 充值还剩多少微元。不过期。 */
  topupLeft: number
  left: number
  /** 已经花掉的（本账期的赠送 + 全部历史的充值部分）。界面上「本期已扣」用它。 */
  bonusSpent: number
  topupSpent: number
  planBonusExpiresAt: number | null
}

export type GateResult = { ok: true } | { ok: false; reason: string }

/**
 * 闸门要判断的那件事：这一类调用现在**收不收钱**。
 *
 * 形状跟着 Billable 走，但只留定价用得上的那几项——闸在调用发生**之前**，那时候
 * 还没有计量（模型那条尤其：跑完才知道用了多少 token）。
 */
export type GateSubject =
  | { kind: 'llm'; provider: string; model: string; cost: unknown }
  | { kind: 'connector'; toolkit: string }
  /**
   * `backends` 是复数：一次提取可能同时落在提取后端和 `document` 两档价上（PDF /
   * Word / Excel 是 Gateway 自己下的，记在 document 头上）。只问提取后端的话，
   * 「提取后端定价 0、document 定价非 0」这个完全合理的组合会让闸判定「不收钱」，
   * 而那次调用照样收钱——余额见底的公司能一直抓文档往负数走。
   */
  | { kind: 'web'; backends: string[]; webKind: WebCallKind }

/**
 * 余额不足时给出去的那句话。**一句人话，不是错误码文案**——它会被原样交给模型
 * （连接器和网页工具那两条路），模型会照实转述给用户。
 */
export const OUT_OF_CREDIT = '这家公司的额度用完了，请联系管理员充值。'

/** 余额缓存活多久。见 budgetOf 的注释。 */
const BUDGET_TTL_MS = 1000

export class Meter {
  /**
   * 每家公司的余额记忆。
   *
   * 存在的理由：熔断判定在每一次模型调用的热路径上，而它要两条 `sum`。一轮里并发的
   * 几十次工具调用会各打一次库，问出同一个答案。
   *
   * **落账时就地扣减，不是等它过期。** 只靠 TTL 的话，1 秒之内的连续调用会一直读到
   * 同一个「还有余额」，透支上限变成「1 秒内能烧多少」；扣减之后，记忆和库之间只差
   * 别的进程写的那部分。
   */
  private budgets = new Map<string, { at: number; value: Budget; grantMicros: number; bonusSince: number | null }>()

  constructor(private db: Db) {}

  /** 平台改了套餐、充了值：那家公司的记忆当场作废，别让人盯着一个不动的数。 */
  forget(companyId: string | null): void {
    if (companyId) this.budgets.delete(companyId)
    else this.budgets.clear()
  }

  async budget(companyId: string): Promise<Budget> {
    return (await this.budgetEntry(companyId)).value
  }

  /** budget 连同它背后的赠送额度和账期起点——charge 落账时要把这两个数交给库去校验。 */
  private async budgetEntry(companyId: string) {
    const hit = this.budgets.get(companyId)
    if (hit && Date.now() - hit.at < BUDGET_TTL_MS) return hit
    const bal = await balanceOf(this.db, companyId)
    const spent = await this.db.chargeSpend(companyId, bal.planBonusStartAt)
    const value: Budget = {
      bonusLeft: Math.max(0, bal.planBonusMils * 1000 - spent.bonusMicros),
      topupLeft: Math.max(0, bal.topupMils * 1000 - spent.topupMicros),
      left: 0,
      bonusSpent: spent.bonusMicros,
      topupSpent: spent.topupMicros,
      planBonusExpiresAt: bal.planBonusExpiresAt,
    }
    value.left = value.bonusLeft + value.topupLeft
    const entry = { at: Date.now(), value, grantMicros: bal.planBonusMils * 1000, bonusSince: bal.planBonusStartAt }
    this.budgets.set(companyId, entry)
    return entry
  }

  /**
   * 事前闸：这家公司还能不能发起需要计费的调用。
   *
   * **返回值而不是抛异常。** 三条路对「拒绝」的表达方式不一样：模型那条要 HTTP 402，
   * 连接器和网页工具要一句给模型看的人话。谁来拒、怎么拒由调用方决定，这里只回答
   * 「能不能」。
   *
   * 不熔断的：owner 自己的调用（没有公司余额可扣）、`enforce` 关掉时（影子计费）。
   */
  async gate(account: Account, subject: GateSubject): Promise<GateResult> {
    if (!account.companyId) return { ok: true }
    const s = await this.db.platformSettings()
    const billing = parseBilling(s.billing)
    if (!billing.enforce) return { ok: true }
    // **不收钱的调用不熔断。** 拦住一个一分钱都不产生的调用保护不了任何人，而它会
    // 把「平台还没开始定价」变成「所有公司一上来就用不了」。
    if (!chargeable(s, subject)) return { ok: true }
    const budget = await this.budget(account.companyId)
    if (budget.left + billing.graceMicros > 0) return { ok: true }
    return { ok: false, reason: OUT_OF_CREDIT }
  }

  /**
   * 这一次收多少钱。
   *
   * 单价在这里取，算法在 `lib/pricing.ts`（纯函数，单独可测）。取到的单价会跟着账本
   * 行存下来——**「为什么收这么多」唯一说得清的地方**，也是敢说「金额不重算」的前提。
   */
  async quote(b: Billable): Promise<Quote> {
    const s = await this.db.platformSettings()
    const multiplier = parsePriceMultiplier(s.priceMultiplier)
    if (b.kind === 'llm') {
      const override: ModelRate | undefined = parseModelPricing(s.modelPricing)[`${b.provider}/${b.model}`]
      const rate = rateOf(b.cost, override, parseModelRate(s.defaultModelRate))
      /**
       * 覆盖、目录、兜底三层合完还缺 input 或 output 任意一侧：金额 0 且标 unpriced。
       * **缺一侧也算「不知道」**——只按有的那一侧收，收的是四分之一而 unpriced 还是
       * false，一句提示都不响（lib/pricing.ts 的 `rateOf`）。**这里仍然不编一个数**——
       * 代码编出来的数没有来路，会被当成成交价。
       *
       * 兜底价不一样：它是运营在模型配置页上自己填的一个数，来路说得清、随时改得动，
       * 而且改了之后立刻就在那一屏上看得见。所以「不要按 0 收」这件事由它办
       * （`rateOf` 的最后一层），不由这里办。没设兜底时行为和从前一模一样。
       */
      if (!rate) return { amountMicros: 0, unitPrice: {}, multiplier, unpriced: true }
      return {
        amountMicros: llmMicros(rate, b.tokens, multiplier),
        unitPrice: rateSnapshot(rate),
        multiplier,
        unpriced: false,
      }
    }
    if (b.kind === 'connector') {
      const unit = b.free ? 0 : connectorMicros(s.connectorPricing, b.toolkit)
      // 连接器**没有倍率**：供应商收我们的是按席位按月的订阅，不是按次，没有原价可加成
      // （connectors.md §8）。这里的 1 是「没有倍率」，不是「倍率恰好是 1」。
      return { amountMicros: unit, unitPrice: { unit }, multiplier: 1, unpriced: false }
    }
    const web = s.webTools ?? emptyWebTools()
    const unitMils = web.pricing?.[b.backend]?.[b.webKind] ?? 0
    return {
      amountMicros: webMicros(web, b.backend, b.webKind, b.units, multiplier),
      unitPrice: { unit: Math.round(unitMils * 1000) },
      multiplier,
      unpriced: false,
    }
  }

  /**
   * 落账。**被拒的、没收钱的也落**——「谁想调、为什么没调成」和「谁调了」一样要留档。
   *
   * 这一笔从哪个桶出：**先扣套餐赠送，再扣充值**。赠送跟着套餐到期作废，反过来扣等于
   * 逼公司先花光不过期的那笔，然后眼看赠送过期（connectors.md §8）。
   */
  async charge(b: Billable, q?: Quote): Promise<UsageCharge> {
    const quote = q ?? (await this.quote(b))
    const companyId = b.account.companyId
    const input = {
      companyId,
      accountId: b.account.id,
      botId: b.botId ?? null,
      sessionId: b.sessionId ?? null,
      kind: b.kind,
      subject: subjectOf(b),
      status: b.status,
      quantity: quantityOf(b),
      unitPrice: quote.unitPrice,
      multiplier: quote.multiplier,
      amountMicros: quote.amountMicros,
      unpriced: quote.unpriced,
      refId: b.refId ?? null,
    }
    if (!companyId || quote.amountMicros <= 0) return this.db.insertUsageCharge(input)
    /**
     * 赠送桶那一份**由库来算，不由这里的记忆算**。记忆里的 bonusLeft 是 1 秒前读的
     * 再就地扣减，同一进程内是准的；可两个进程、或者一轮里几十次并发在缓存过期前各
     * 读到同一份「还剩 $0.30」，每一笔都按 $0.30 记 bonus，赠送桶就被扣穿，而超出的
     * 那截本该落到充值桶——余额页会比实际多出那一截。insert 里带 `bonusCap`，同一条
     * SQL 用 sum(bonusMicros) 校验；配一把按公司的事务锁，让落账排队（锁里只有这一条
     * insert，等的是一次 insert 的工夫）。
     */
    const entry = await this.budgetEntry(companyId)
    const row = await this.db.tx(async () => {
      await this.db.lockCompanyLedger(companyId)
      return this.db.insertUsageCharge({
        ...input,
        bonusCap: entry.bonusSince == null ? { grantMicros: 0, since: 0 } : { grantMicros: entry.grantMicros, since: entry.bonusSince },
      })
    })
    // 就地扣减，别等 TTL 到。透支上限因此是「一轮真并发的量」，不是「1 秒内的量」。
    // 用的是库真扣掉的那份，不是这里预估的。
    const budget = entry.value
    const bonusMicros = row.bonusMicros
    budget.bonusLeft = Math.max(0, budget.bonusLeft - bonusMicros)
    budget.topupLeft = Math.max(0, budget.topupLeft - (quote.amountMicros - bonusMicros))
    budget.bonusSpent += bonusMicros
    budget.topupSpent += quote.amountMicros - bonusMicros
    budget.left = budget.bonusLeft + budget.topupLeft
    return row
  }

  /**
   * 把清扫写下的占位行补成真的成交。判据、原子性和那条例外的边界都在
   * `db.fillPlaceholderCharge` 上，这里只负责**把钱算对**——报价、赠送桶的上限、余额
   * 记忆的就地扣减，和 `charge` 一字不差地走同一套。
   *
   * 补不上（没有那行占位，或者它已经被别人补过了）就回 undefined，一行都不动。
   */
  async fillPlaceholder(b: Billable, q?: Quote): Promise<UsageCharge | undefined> {
    const quote = q ?? (await this.quote(b))
    const companyId = b.account.companyId
    const input = {
      refId: b.refId ?? '',
      companyId,
      status: b.status,
      quantity: quantityOf(b),
      unitPrice: quote.unitPrice,
      multiplier: quote.multiplier,
      amountMicros: quote.amountMicros,
      unpriced: quote.unpriced,
    }
    if (!input.refId) return undefined
    // 没公司、或者补完还是 0 元：没有赠送桶要算，也就不必排队。
    if (!companyId || quote.amountMicros <= 0) return this.db.fillPlaceholderCharge(input)
    const entry = await this.budgetEntry(companyId)
    const row = await this.db.tx(async () => {
      await this.db.lockCompanyLedger(companyId)
      return this.db.fillPlaceholderCharge({
        ...input,
        bonusCap: entry.bonusSince == null ? { grantMicros: 0, since: 0 } : { grantMicros: entry.grantMicros, since: entry.bonusSince },
      })
    })
    if (!row) return undefined
    // 和 charge 一样就地扣减，别等 TTL 到。占位行原来一分钱没扣，所以这里扣的是全额。
    const budget = entry.value
    const bonusMicros = row.bonusMicros
    budget.bonusLeft = Math.max(0, budget.bonusLeft - bonusMicros)
    budget.topupLeft = Math.max(0, budget.topupLeft - (row.amountMicros - bonusMicros))
    budget.bonusSpent += bonusMicros
    budget.topupSpent += row.amountMicros - bonusMicros
    budget.left = budget.bonusLeft + budget.topupLeft
    return row
  }
}

/** 这一类调用当前的单价是不是 0。0 = 现在不收钱，闸放行。 */
function chargeable(s: PlatformSettings, subject: GateSubject): boolean {
  if (subject.kind === 'llm') {
    const override: ModelRate | undefined = parseModelPricing(s.modelPricing)[`${subject.provider}/${subject.model}`]
    // 连兜底都凑不齐 input / output 的模型才放行：那时候收的是 0（记 unpriced），拦它
    // 等于按「不知道」收费。兜底把缺的那一侧补上之后这类模型是**要钱的**，闸就得照常判。
    return !!rateOf(subject.cost, override, parseModelRate(s.defaultModelRate))
  }
  if (subject.kind === 'connector') return connectorMicros(s.connectorPricing, subject.toolkit) > 0
  const web = s.webTools ?? emptyWebTools()
  // 任意一档要钱，这一次就可能要钱，闸就得判。
  return subject.backends.some((b) => (web.pricing?.[b]?.[subject.webKind] ?? 0) > 0)
}

/** 收费对象的字面量。存下来不存外键：连接器下架、模型删了，上个月的账还得看得懂。 */
export function subjectOf(b: Billable): string {
  if (b.kind === 'llm') return `${b.provider}/${b.model}`
  if (b.kind === 'connector') return `${b.toolkit}:${b.tool}`
  return `${b.backend}:${b.webKind}`
}

function quantityOf(b: Billable): Record<string, number> {
  if (b.kind === 'llm') {
    return {
      promptTokens: b.tokens.promptTokens,
      completionTokens: b.tokens.completionTokens,
      cachedTokens: b.tokens.cachedTokens,
      cacheWriteTokens: b.tokens.cacheWriteTokens,
    }
  }
  if (b.kind === 'web') return { units: b.units }
  // 连接器恒为一次调用，没有可计量的维度。空对象比写一个恒等于 1 的字段诚实。
  return {}
}

export function createMeter(db: Db): Meter {
  return new Meter(db)
}
