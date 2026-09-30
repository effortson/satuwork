/**
 * 生图的预估：**先看自己实测的，没有才看表**。
 *
 * 一张图用多少 token，OpenAI 没公布 gpt-image-2 的表，而且这个数本来就不固定——同样的尺寸和质量，
 * 画面内容不同，输出 token 能差好几倍（实测见过同一组参数回 1286 和 5146）。所以写死的那张表
 * （image-models.ts 的 `outputTokens`）只当冷启动：这颗模型最近 30 天真成交过 20 张以上，就改用
 * 这些真实调用的 P95。
 *
 * **P95 而不是平均数**：闸门要回答的是「这一次会不会透支」，按平均估，一半的调用都比它贵。
 * 取最大值又会被一两次离群的大图拽得太高。P95 是「绝大多数这颗模型的调用花不到这么多」。
 *
 * 基线不分质量档：llm_calls 里没记这一次要的是哪一档。实测的 P95 天然反映了这家平台上人们
 * 实际在用的档位，比「一律按最贵那档」贴近得多——后者正是冷启动时的做法。
 */
import type { Db } from '../db.ts'
import type { LlmTokens } from './pricing.ts'

/** 至少这么多张才信实测。少了的话一两张离群值就能决定 P95。 */
export const BASELINE_MIN_SAMPLES = 20
/** 往回看多久、最多取多少张。模型会升级、人们的用法会变，太老的样本不作数。 */
export const BASELINE_WINDOW_MS = 30 * 24 * 3600 * 1000
export const BASELINE_MAX_SAMPLES = 200
/**
 * 同一颗模型的基线记多久。闸门在每一次生图调用的路径上，没必要每次都查一遍库。
 * e2e 造完样本要立刻看到新基线，用环境变量把它设成 0。
 */
function cacheMs(): number {
  const n = Number(process.env.SATUWORK_IMAGE_BASELINE_CACHE_MS)
  return Number.isFinite(n) && n >= 0 ? n : 10 * 60 * 1000
}

export interface ImageBaseline {
  samples: number
  /** 输入、输出各自的 P95 和平均数。 */
  p95: LlmTokens
  avg: LlmTokens
}

/** 取第 q 分位（0–1），最近秩法：不插值，结果一定是某一次真实调用的值。**纯函数**。 */
export function percentile(values: number[], q: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length)))
  return sorted[rank - 1]
}

/** 一串真实用量 → 基线。样本不够返回 undefined。**纯函数**，e2e 直接打它。 */
export function baselineOf(rows: { promptTokens: number; completionTokens: number }[]): ImageBaseline | undefined {
  if (rows.length < BASELINE_MIN_SAMPLES) return undefined
  const prompt = rows.map((r) => r.promptTokens)
  const completion = rows.map((r) => r.completionTokens)
  const mean = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length)
  const tokens = (p: number, c: number): LlmTokens => ({ promptTokens: p, completionTokens: c, cachedTokens: 0, cacheWriteTokens: 0 })
  return {
    samples: rows.length,
    p95: tokens(percentile(prompt, 0.95), percentile(completion, 0.95)),
    avg: tokens(mean(prompt), mean(completion)),
  }
}

const cache = new Map<string, { at: number; value: ImageBaseline | undefined }>()

/**
 * 这颗模型的实测基线（带缓存）。查库失败就当没有——预估是锦上添花，退回写死的表照样能判。
 */
export async function imageBaseline(db: Db, provider: string, model: string): Promise<ImageBaseline | undefined> {
  const key = `${provider}/${model}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < cacheMs()) return hit.value
  let value: ImageBaseline | undefined
  try {
    value = baselineOf(await db.recentModelUsage(provider, model, Date.now() - BASELINE_WINDOW_MS, BASELINE_MAX_SAMPLES))
  } catch {
    value = undefined
  }
  cache.set(key, { at: Date.now(), value })
  return value
}
