/**
 * 生图模型：一张写死的小表。
 *
 * **为什么不从 pi-ai 的目录里来。** pi-ai 的目录是对话模型的目录：每一条都带着「怎么流式
 * 调它」的那一套（api、compat、thinkingLevelMap），gpt-image 这一类压根不在里面——它们
 * 不走 chat / responses，走的是 `/v1/images/generations`，请求和答复都是另一个形状。
 * models.dev 那条自动发现也只收「能调工具」的模型，同样补不进来。所以这里单开一张。
 *
 * **为什么不并进 `Llm.catalog()`。** 那份目录是日常 / utility / 备选挑模型的来源，也是
 * `/v1/models` 下发给席位的那份——生图模型混进去，就会出现在「设为日常」的列表里，
 * 点了之后每一轮对话都 400。所以它们只在两处露面：模型配置页的「生图模型」那一块，和
 * `Llm.find` 的最后一档回落（授权、结算、清扫都靠 find 认模型、拿单价）。反过来，表里的
 * 模型要是被 pi-ai / 自动发现当成对话模型收进了目录，catalog() 会把它剔掉（见那边）。
 *
 * **单价是 token 价，和对话模型同一个口径**（每 100 万 token 多少美元），账走 `llm` 那一类，
 * 平台的倍率、按模型改价、兜底价全都照常生效：
 *
 *   OpenAI   答复里的 `usage`（input_tokens / output_tokens / input_tokens_details）和
 *            Responses API 一个形状。
 *   Gemini   `usageMetadata`（promptTokenCount / candidatesTokenCount / thoughtsTokenCount），
 *            lib/llm-usage.ts 里有专门的一岔，文字和思考那几个 token 在那里折算，见那边。
 *
 * **`input` 取的是图片输入价，不是文字输入价。** 改图时要把原图喂进去，OpenAI 对图片输入
 * 的 token 另收一档更贵的价（gpt-image-2 文字 $5、图片 $8），而 usage 里的两种 token 我们只
 * 拿得到合计。按文字价收，改图就一直少收；按图片价收，多收的只是提示词那几十个文字
 * token——$3 / 1M × 100 token 不到半分钱。两害相权取高估，同 lib/pricing.ts 的回落规矩。
 * Gemini 不分，文字和图片输入一个价。
 *
 * 价格抄自两家的定价页（2026-09）。
 */
import type { CatalogModel } from './llm.ts'
import type { LlmTokens } from './lib/pricing.ts'

/**
 * 生图模型在目录里的 `api`。Bot 按它决定请求体怎么拼、答复怎么拆（bot/src/tools/image.ts），
 * Gateway 按它决定上游地址（llm.ts 的 imageTargetOf）。
 *
 *   openai-images   OpenAI Images：/v1/images/generations 与 /v1/images/edits
 *   gemini-images   Gemini 原生出图（Nano Banana）：models/{id}:streamGenerateContent
 */
export const IMAGE_APIS = ['openai-images', 'gemini-images'] as const
export type ImageApi = (typeof IMAGE_APIS)[number]

/** 质量档。Bot 那边的 `quality`（low / medium / high；auto 按 high 算）。 */
export type ImageTier = 'low' | 'medium' | 'high'
export const IMAGE_TIERS: readonly ImageTier[] = ['low', 'medium', 'high']

export interface ImageModelDef {
  provider: string
  id: string
  name: string
  api: ImageApi
  /** 每 100 万 token 多少美元，同 pi-ai 目录的 `cost`。 */
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  /**
   * 一张图大概要多少输出 token，按质量档，**取那一档里最大的尺寸**。只拿来预估（模型配置页上
   * 的「每张约多少」、余额闸门判「够不够这一张」），真收钱照旧按答复里的 usage。
   *
   * **这是冷启动用的**：这颗模型有了足够的实测样本之后，闸门改按实测的 P95 判
   * （lib/image-estimate.ts）。一张图用多少 token 随画面内容变，任何一张写死的表都只是个量级。
   */
  outputTokens: Record<ImageTier, number>
}

/**
 * 预估时按多少输入 token 算：一段描述加一张原图的量级。改图时原图的 token 两家都不少，
 * 但比起输出便宜一个数量级（输入价低得多），估粗一点无妨。
 */
export const ESTIMATE_INPUT_TOKENS = 1500

/**
 * OpenAI 公布的 gpt-image 每张图 token 数（方图 / 竖图 / 横图，取大的那个）：低 408、中 1584、
 * 高 6240。gpt-image-2 没有这张表，也不会有——官方的说法是它支持几千种分辨率，同一档质量下
 * 大图的 token 可能反而比小图少，要按实际用量算。所以它和 mini 一样只在冷启动时借这张表，
 * 攒够实测样本就换成实测（lib/image-estimate.ts）。
 */
const OPENAI_TOKENS: Record<ImageTier, number> = { low: 408, medium: 1584, high: 6240 }

export const IMAGE_MODELS: readonly ImageModelDef[] = [
  {
    provider: 'openai',
    id: 'gpt-image-2',
    name: 'GPT Image 2',
    api: 'openai-images',
    // 图片输入 $8（缓存 $2）、文字输入 $5（缓存 $1.25）、输出 $30。input 取图片那档，理由见文件头。
    cost: { input: 8, output: 30, cacheRead: 2, cacheWrite: 0 },
    outputTokens: OPENAI_TOKENS,
  },
  {
    provider: 'openai',
    id: 'gpt-image-1-mini',
    name: 'GPT Image 1 mini',
    api: 'openai-images',
    // 图片输入 $2.5（缓存 $0.25）、文字输入 $2（缓存 $0.2）、输出 $8。
    cost: { input: 2.5, output: 8, cacheRead: 0.25, cacheWrite: 0 },
    outputTokens: OPENAI_TOKENS,
  },
  {
    provider: 'google',
    id: 'gemini-3.1-flash-image',
    name: 'Nano Banana 2（Gemini 3.1 Flash Image）',
    api: 'gemini-images',
    // 输入 $0.5（文字 / 图片同价）、图片输出 $60。文字和思考输出 $3，在 llm-usage.ts 里折算。
    cost: { input: 0.5, output: 60, cacheRead: 0, cacheWrite: 0 },
    // 定价页：1K 一张 $0.067、2K $0.101（按 $60 / 1M 折回去是 1117 / 1684 token）。Bot 在 high
    // 时要 2K，其余 1K（bot/src/tools/image.ts）。
    outputTokens: { low: 1117, medium: 1117, high: 1684 },
  },
  {
    provider: 'google',
    id: 'gemini-3-pro-image',
    name: 'Nano Banana Pro（Gemini 3 Pro Image）',
    api: 'gemini-images',
    // 输入 $2、图片输出 $120。文字和思考输出 $12，同上。
    cost: { input: 2, output: 120, cacheRead: 0, cacheWrite: 0 },
    // 定价页：1K / 2K 同价，一张 $0.134（按 $120 / 1M 折回去是 1117 token）。Bot 最多要 2K。
    outputTokens: { low: 1117, medium: 1117, high: 1117 },
  },
]

/** 表里的一条 → 目录里的一条。`output: ['image']` 是它和对话模型的区分标记。 */
export function imageCatalogModel(def: ImageModelDef): CatalogModel {
  return {
    provider: def.provider,
    id: def.id,
    name: def.name,
    api: def.api,
    input: ['text', 'image'],
    output: ['image'],
    reasoning: false,
    cost: def.cost,
    source: 'builtin',
  }
}

export function isImageModel(m: { api?: string } | undefined): boolean {
  return (IMAGE_APIS as readonly string[]).includes(String(m?.api ?? ''))
}

export function imageModelDef(provider: string, id: string): ImageModelDef | undefined {
  return IMAGE_MODELS.find((m) => m.provider === provider && m.id === id)
}

/**
 * 一张图的预估用量。**闸门用最贵的那一档**（`high`）：管家和 Gateway 都不拆请求体（管家是
 * 搬字节的，见 manager/src/llm-relay.ts），不知道这一次要的是哪一档；按最贵的估，余额刚好卡在
 * 「够一张低质量、不够一张高质量」之间的那一小段会被多拦一次，反过来就是透支。
 */
export function imageEstimateTokens(def: ImageModelDef, tier: ImageTier = 'high'): LlmTokens {
  return { promptTokens: ESTIMATE_INPUT_TOKENS, completionTokens: def.outputTokens[tier], cachedTokens: 0, cacheWriteTokens: 0 }
}

/** 这一对是不是生图表里的。catalog() 拿它把被当成对话模型收进来的那几颗剔掉。 */
export function isImageModelKey(provider: string, id: string): boolean {
  return IMAGE_MODELS.some((m) => m.provider === provider && m.id === id)
}
