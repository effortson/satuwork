/**
 * 报价：把「用了多少」折成「收多少微元」。
 *
 * **全是纯函数**，不碰库、不碰设置——传进来什么单价就按什么算。这样单价从哪来
 * （目录 / 平台覆盖 / 回落）和怎么算是两件事，各自能单独测。取单价那一步在 meter.ts。
 *
 * 单位：单价是「每 100 万 token 多少**美元**」（pi-ai 内置目录的口径），金额是
 * **微元**（百万分之一美元）。
 */
import { type ModelRate, type WebCallKind, type WebToolsSettings, emptyModelRate, parseModelRate } from '../db.ts'

/** 一次模型调用的四项 token。后两项都是 prompt 的**子集**，不是加项。 */
export interface LlmTokens {
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  cacheWriteTokens: number
}


/**
 * 目录里的 `cost` + 平台覆盖 + 平台兜底 → 实际生效的四项单价。
 *
 * **覆盖是按字段盖的，不是整份顶掉。** 曾经是「覆盖里有任意一项非零就整份用它」，
 * 那条规则有个安静的坑：改价弹层的四个输入框默认留空（故意不预填目录价，否则一按
 * 保存就把目录价抄成了覆盖，上游再调价也不会跟着动），于是只想修一项缓存单价的人
 * 填完保存，`input` 和 `output` 就成了 0——那个模型从此按 $0 计费，而且 `unpriced`
 * 是 false，所有「金额不完整」的提示都不会响。按字段盖之后，留空就是「这一项用目录
 * 价」，和界面上那几个占位符说的是同一件事。
 *
 * 代价：**0 一律读作「没填」，不是「这一项免费」**。整份文件都是这个约定（目录里
 * 没收录价格的模型四项也是 0），要真按 0 收就得引入「填了 0」和「没填」的区分，
 * 而那个区分在一个数字输入框上表达不出来。
 *
 * 四层回落，从近到远：**覆盖 → 目录 → 平台兜底 → `input`**。
 *
 * **兜底（`platformSettings.defaultModelRate`）压在目录价下面**，不是盖在上面：配了它
 * 之后已经有价的模型照旧按自己的价收，只有目录和覆盖都查不到的那些才落到它头上。
 * 它存在的理由是**「不知道」不该被收成「免费」**——没有它时这类调用记的是金额 0 +
 * `unpriced`，而 $0 在账单上和免费长得一模一样，月底真扣的钱就少了那一截。按一个
 * 说得清来路的估价收，比收零更接近真相（docs/billing.md §7）。
 *
 * 最后一层只兜缓存那两项：Anthropic 的缓存读是输入价的十分之一，按输入价收是高估
 * 十倍；但反过来（缺了按 0 收）是把最容易命中的那部分白送，而缓存命中率越高白送
 * 越多。两害相权取高估。
 *
 * **不给 cacheWrite 造 1.25 的系数。** 那是 Anthropic 一家的定价习惯，写进通用回落
 * 等于把某一家的价目表编死在代码里。
 *
 * **四层合完之后 `input` 和 `output` 缺任意一侧 → 返回 undefined**，意思是「不知道」，
 * 不是「免费」。调用方据此记 `unpriced`，界面上要喊出来。
 *
 * 缺一侧为什么不算有价：一颗「目录里有 input、没 output」的模型（自定义供应商那张表单
 * 四个价格框只填了第一个，就是这个形状），从前是算「有价」的——`llmMicros` 照着那个 0
 * 把输出 token 乘成 $0，而输出通常是输入的 3–5 倍，等于只收了四分之一。更要命的是
 * `unpriced` 那时是 false：统计屏不喊、模型表不标、余额闸照判，整条链上没有一处
 * 看得出少收了钱。**不喊出来的低估比喊出来的零更难查**，所以宁可整颗算「不知道」。
 *
 * 缺的那侧也不回落到另一侧：按 input 收输出仍旧是低估，而且 `unpriced` 会继续是 false，
 * 一句提示都不响——换汤不换药。要接住这批模型的是上面第三层（运营填的兜底价），它逐
 * 字段回落，配了就自动把缺的那一侧补上。
 */
export function rateOf(cost: unknown, override?: ModelRate, fallback?: ModelRate): ModelRate | undefined {
  const base = parseModelRate(cost)
  const o = override ?? emptyModelRate()
  const f = fallback ?? emptyModelRate()
  const merged: ModelRate = {
    input: o.input || base.input || f.input,
    output: o.output || base.output || f.output,
    cacheRead: o.cacheRead || base.cacheRead || f.cacheRead,
    cacheWrite: o.cacheWrite || base.cacheWrite || f.cacheWrite,
  }
  if (!merged.input || !merged.output) return undefined
  return fillRate(merged)
}

/** 合并之后仍然缺的缓存项补成 input。这是回落的最后一层。 */
function fillRate(r: ModelRate): ModelRate {
  return {
    input: r.input,
    output: r.output,
    cacheRead: r.cacheRead || r.input,
    cacheWrite: r.cacheWrite || r.input,
  }
}

/**
 * 模型调用的金额（微元）。
 *
 * **不除一百万。** 单价是「每 100 万 token 多少美元」，账本是微元（1e-6 美元），
 * 两个一百万正好抵消：1 token × r 美元/1M tok = r 微元。
 * 下一个人看到这里多半想补一个 `/ 1_000_000`——补了之后所有模型账单会变成零。
 *
 * `promptTokens` 含缓存读和缓存写两截（见 v1.ts 的 usageFromPayload：Anthropic 那边
 * 是 input + cacheRead + cacheWrite，OpenAI 的 prompt_tokens 本来就含缓存读、且没有
 * 缓存写），所以未命中的部分要把两截都减掉。`max(0, …)` 是防脏数据，不是防逻辑错。
 */
export function llmMicros(rate: ModelRate, tok: LlmTokens, multiplier: number): number {
  const prompt = Math.max(0, tok.promptTokens)
  const cached = Math.min(Math.max(0, tok.cachedTokens), prompt)
  const written = Math.min(Math.max(0, tok.cacheWriteTokens), prompt - cached)
  const fresh = prompt - cached - written
  const usd =
    fresh * rate.input + cached * rate.cacheRead + written * rate.cacheWrite + Math.max(0, tok.completionTokens) * rate.output
  return Math.max(0, Math.round(usd * multiplier))
}

/**
 * 连接器的按次单价（微元）。**没有倍率**——模型那边有倍率是因为模型有原价可以加成，
 * 连接器没有：供应商收我们的是按席位按月的订阅，不是按次（见 connectors.md §8）。
 */
export function connectorMicros(pricing: { defaultMicros: number; byToolkit: Record<string, number> } | undefined, toolkit: string): number {
  const p = pricing ?? { defaultMicros: 0, byToolkit: {} }
  const raw = p.byToolkit?.[toolkit] ?? p.defaultMicros
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0
}

/**
 * 网页工具的金额（微元）。配置屏上填的是**厘**，这里换算：1 mil = 1000 micros。
 *
 * 倍率沿用模型那一个——搜索额度是我们采购来转售的，和模型一样有成本基准可以加成。
 */
export function webMicros(web: WebToolsSettings, backend: string, kind: WebCallKind, units: number, multiplier: number): number {
  const unitMils = web.pricing?.[backend]?.[kind] ?? 0
  if (!unitMils || units <= 0) return 0
  return Math.max(0, Math.round(unitMils * 1000 * units * multiplier))
}

/** 单价快照存进账本时的形状。llm 存四项，另两条存一个 `unit`（微元/次）。 */
export function rateSnapshot(rate: ModelRate | undefined): Record<string, number> {
  const r = rate ?? emptyModelRate()
  return { input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite }
}
