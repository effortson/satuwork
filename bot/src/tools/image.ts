import type { Context } from '@deepseek-ai/cordis'
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { gatewayApiKey, llmBaseUrl } from '../llm/gateway.ts'
import type { WorkspaceFile } from './index.ts'
import { type Alpha, decodeAlpha, encodeAlphaMask, encodeGray, jpegOrientation, jpegSegments, pngInfo, unorient } from './png.ts'

/**
 * `generate_image`：按一段描述画一张图，或者拿工作区里已有的图改，落进工作区 `images/`。
 *
 * **为什么是一把工具，不是让对话模型「原生」出图。** 原生出图（Responses API 的
 * image_generation、Gemini 的图像模型）绑死在当时那颗对话模型上——平台的日常模型是
 * DeepSeek 或 Claude 的时候就画不了。做成工具之后谁都能调，用哪颗生图模型由平台在模型
 * 配置页挑（下发在 `/runtime/catalog` 的 `models.image`），没挑就不进工具表。
 *
 * **调用走的是模型那条路**（`llmBaseUrl()`）：席位上是本机管家的 `/llm/v1/images/*`，桌面
 * 本地 Bot 是 Gateway 的 `/v1/images/*`。画走 `generations`，改走 `edits`。密钥、计费（按
 * token，和对话同一本账）都在那两处，这边只拼请求、拆答复、落盘。
 *
 * **请求体按模型的 `api` 拼成供应商的原生形状**（gateway/src/image-models.ts）：
 *
 *   openai-images   OpenAI Images。改图时原图放在 `images: [{ image_url: data URL }]`。
 *   gemini-images   Gemini 的 generateContent：`contents` 里是原图（inlineData）加描述，
 *                   `generationConfig` 要 IMAGE 模态、宽高比和分辨率档。
 *
 * **要的是流式答复**。不是为了看半成品：非流式的答复要等整张图画完才给响应头，高质量的大图
 * 常常超过一两分钟，而管家和 Gateway 都只等响应头 120 秒；流式的头立刻就来。另外 base64 的
 * 图是几 MB 的一整块，Gateway 在 Vercel 上时非流式的响应体有 4.5 MB 的上限，流式没有。
 * OpenAI 是请求体里的 `stream: true`；Gemini 的流式是另一个接口（streamGenerateContent），
 * 地址由 Gateway 定，这边不用管。
 *
 * **图不进模型的上下文**：给模型的只有一行「画好了，存在哪」。对话模型多半没有视觉，
 * 塞一张几 MB 的 base64 进去只会把上下文撑爆。人在界面上直接看到图（`files`，见
 * gateway/ui/chat.js 的产出图片那一排）。
 */
export const name = 'satu-tools-image'
export const inject = ['tools', 'workspace', 'catalog']

/** 画一张图的上限。高质量的大图一两分钟是常事，再往上就是卡住了。 */
const TIMEOUT_MS = 5 * 60_000
/** 描述的上限。OpenAI 收 32000 字符，但一段真描述用不了这么多——过长多半是模型把整份文档塞了进来。 */
const PROMPT_MAX = 4_000
/** 一次最多带几张原图。两家都收得更多（OpenAI 16、Gemini 十几张），但请求体要有界。 */
const INPUT_MAX = 4

/**
 * 原图的总量上限（解码前的字节数）。
 *
 * 席位上走管家（设了 GATEWAY_LLM_URL），管家收 32 MB 的请求体，base64 之后要乘 4/3，
 * 留足余量取 20 MB。桌面本地 Bot 直连 Gateway，而 Gateway 在 Vercel 上时请求体上限是
 * 4.5 MB——同样乘 4/3 再留点 JSON 的余量，只能是 3 MB。
 */
function inputBudget(): number {
  return process.env.GATEWAY_LLM_URL ? 20 * 1024 * 1024 : 3 * 1024 * 1024
}

const SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto'] as const
const QUALITIES = ['low', 'medium', 'high', 'auto'] as const
const FORMATS = ['jpeg', 'png', 'webp'] as const
type Format = (typeof FORMATS)[number]

const EXT: Record<Format, string> = { jpeg: 'jpg', png: 'png', webp: 'webp' }
const FORMAT_OF_MIME: Record<string, Format> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/webp': 'webp' }
/** 能当原图喂进去的格式。两家都认这三种；GIF 和 SVG 都不收。 */
const INPUT_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

/** 尺寸 → Gemini 的宽高比。`auto` 不给这一格：没有原图时是方图，有原图时跟原图走。 */
const GEMINI_ASPECT: Record<string, string> = { '1024x1024': '1:1', '1536x1024': '3:2', '1024x1536': '2:3' }

export interface ImageArgs {
  prompt?: unknown
  size?: unknown
  quality?: unknown
  transparent?: unknown
  format?: unknown
  name?: unknown
  images?: unknown
  mask?: unknown
}

/** 读好了的一张原图。 */
export interface InputImage {
  path: string
  mime: string
  b64: string
}

export interface ImageModelRef {
  provider: string
  model: string
  api: string
}

export type ImageRequest = { body: Record<string, unknown>; format: Format; edit: boolean }

/**
 * 模型给的参数（加上读好的原图）→ 这颗模型的原生请求体。**纯函数**，e2e 探针直接打它。
 *
 * 默认格式是 JPEG：同样一张 1024² 的图，PNG 两三 MB，JPEG 几百 KB——界面上缩略图只自动
 * 拉 2 MB 以内的（chat.js 的 SHOT_AUTO_MAX），PNG 多半显示成一个占位。要透明背景就只能是
 * PNG / WebP（JPEG 没有透明通道，上游会直接 400），所以 `transparent` 时默认换成 PNG。
 * Gemini 选不了格式（它自己定，多半是 PNG），`format` 对它不起作用；它也画不了透明背景。
 *
 * 尺寸默认方图；带了原图（改图）时默认 `auto`——改图多半要保持原图的比例。
 */
export function imageRequest(model: ImageModelRef, a: ImageArgs, inputs: InputImage[] = [], mask?: InputImage): ImageRequest | { error: string } {
  const prompt = String(a.prompt ?? '').trim()
  if (!prompt) return { error: 'prompt 不能为空：用一段话描述要画什么、或者要怎么改。' }
  if (prompt.length > PROMPT_MAX) return { error: `prompt 太长了（${prompt.length} 字符，上限 ${PROMPT_MAX}）。只写画面本身：主体、风格、构图、颜色。` }
  const edit = inputs.length > 0
  const size = (SIZES as readonly string[]).includes(String(a.size)) ? String(a.size) : edit ? 'auto' : '1024x1024'
  const quality = (QUALITIES as readonly string[]).includes(String(a.quality)) ? String(a.quality) : 'medium'
  const transparent = a.transparent === true
  const asked = (FORMATS as readonly string[]).includes(String(a.format)) ? (String(a.format) as Format) : undefined
  // `provider/model` 加上 provider：模型 id 撞名时 Gateway 靠它认是哪一家，转给上游前会删掉。
  const head = { model: `${model.provider}/${model.model}`, provider: model.provider }

  if (mask && !edit) return { error: '蒙版要和原图一起给：images 里放要改的那张，mask 放蒙版。' }

  if (model.api === 'gemini-images') {
    if (transparent) return { error: `${model.model} 画不了透明背景。要透明背景得换一颗模型（平台在模型配置页挑）。` }
    if (mask) {
      // 执行路径上蒙版已经过了 maskProblem；这里再判一次，是因为 imageRequest 是个独立可调的纯函数。
      const d = decodeAlpha(Buffer.from(mask.b64, 'base64'))
      if ('error' in d) return { error: `这张蒙版读不出来（${d.error}）。换一张 8 位 RGBA 的 PNG，界面上涂出来的就是。` }
      if (!maskRegion(d)) return { error: '蒙版上没有透明的地方——透明的那一块才是要重画的。' }
    }
    const imageConfig: Record<string, string> = {
      // 分辨率档：high 给 2K，其余 1K。Pro 的 1K / 2K 同价，Flash 的 2K 贵一半。
      imageSize: quality === 'high' ? '2K' : '1K',
      ...(GEMINI_ASPECT[size] ? { aspectRatio: GEMINI_ASPECT[size] } : {}),
    }
    return {
      edit,
      format: 'png',
      body: {
        ...head,
        contents: [{ role: 'user', parts: mask ? geminiMaskParts(inputs, mask, prompt) : [...inputs.map(inline), { text: prompt }] }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig },
      },
    }
  }

  if (model.api !== 'openai-images') return { error: `这台席位还不认识 ${model.provider}/${model.model} 的生图接口（${model.api}），要等 Bot 升级。` }
  if (transparent && asked === 'jpeg') return { error: 'JPEG 没有透明通道。要透明背景就用 png 或 webp。' }
  const format: Format = asked ?? (transparent ? 'png' : 'jpeg')
  return {
    edit,
    format,
    body: {
      ...head,
      prompt,
      ...(edit ? { images: inputs.map((i) => ({ image_url: `data:${i.mime};base64,${i.b64}` })) } : {}),
      // 蒙版透明的地方就是要重画的地方，套在第一张原图上（OpenAI 的约定）。
      ...(mask ? { mask: { image_url: `data:image/png;base64,${mask.b64}` } } : {}),
      n: 1,
      size,
      quality,
      output_format: format,
      // 不压到底：90 看不出和原图的区别，体积差不多减半。只有 JPEG / WebP 认这一格。
      ...(format === 'png' ? {} : { output_compression: 90 }),
      ...(transparent ? { background: 'transparent' } : {}),
      stream: true,
      partial_images: 0,
    },
  }
}

function inline(i: { mime: string; b64: string }) {
  return { inlineData: { mimeType: i.mime, data: i.b64 } }
}

/** 蒙版里要重画的那一块在哪。坐标是原图的百分比。 */
export interface MaskRegion {
  /** 「右下角」「正中间」这种。按涂抹区域外接框的中心落在九宫格的哪一格。 */
  where: string
  x: [number, number]
  y: [number, number]
  /** 涂掉的像素占整张图的百分比。 */
  coverage: number
}

/** alpha 小于这个值就算「透明」（要重画）。浏览器画笔的边缘是半透明的，取中间。 */
const CLEAR_BELOW = 128

/**
 * 从蒙版的 alpha 里算出要重画的那一块。一个透明像素都没有就是 undefined。**纯函数**。
 *
 * 只给外接框和九宫格方位，不给更细的形状：这些是写进给模型的那句话里的，模型读得懂「右下角、
 * 横向 60%–90%」，读不懂一串多边形坐标。形状本身靠同时发过去的那张黑白蒙版。
 */
export function maskRegion(a: Alpha): MaskRegion | undefined {
  let x0 = a.width
  let y0 = a.height
  let x1 = -1
  let y1 = -1
  let clear = 0
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      if (a.alpha[y * a.width + x] >= CLEAR_BELOW) continue
      clear++
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (!clear) return undefined
  const pct = (n: number, of: number) => Math.round((n / of) * 100)
  const third = (c: number, of: number) => (c < of / 3 ? 0 : c < (of * 2) / 3 ? 1 : 2)
  const cx = third((x0 + x1 + 1) / 2, a.width)
  const cy = third((y0 + y1 + 1) / 2, a.height)
  const GRID = [
    ['左上角', '上方正中', '右上角'],
    ['左侧中部', '正中间', '右侧中部'],
    ['左下角', '下方正中', '右下角'],
  ]
  return {
    where: GRID[cy][cx],
    x: [pct(x0, a.width), pct(x1 + 1, a.width)],
    y: [pct(y0, a.height), pct(y1 + 1, a.height)],
    coverage: Math.max(1, pct(clear, a.width * a.height)),
  }
}

/**
 * Gemini 的「局部重绘」。它不收透明蒙版，只会按指令改图——官方文档里改图的做法就是多张图加一段
 * 文字。所以把蒙版换成一张它看得懂的**黑白图**（白色 = 要重画），和原图一起发过去，再把涂抹
 * 区域的方位和范围写进指令里，明说白色以外不许动。
 *
 * 这比不上 OpenAI 那种像素级的蒙版：Gemini 可能会顺手动一点白色区域以外的东西。但它比「只靠
 * 文字说改哪里」准得多，而人涂的那一块也真的传到了。
 *
 * 蒙版在调用前已经过了 maskProblem（PNG、有透明、和原图一样大、读得出来），这里不再判。
 */
export function geminiMaskParts(inputs: InputImage[], mask: InputImage, prompt: string): unknown[] {
  const a = decodeAlpha(Buffer.from(mask.b64, 'base64')) as Alpha
  const region = maskRegion(a)!
  const bw = new Uint8Array(a.width * a.height)
  for (let i = 0; i < bw.length; i++) bw[i] = a.alpha[i] < CLEAR_BELOW ? 255 : 0
  const bwB64 = encodeGray(a.width, a.height, bw).toString('base64')
  const refs = inputs.length > 1 ? `第三张起是参考图，按要求取用。` : ''
  const text =
    `第一张图是要改的原图，第二张是和它一样大的黑白蒙版：白色的地方是要重画的区域` +
    `（在原图的${region.where}，横向约 ${region.x[0]}%–${region.x[1]}%、纵向约 ${region.y[0]}%–${region.y[1]}%，占画面约 ${region.coverage}%）。` +
    `只改白色区域里的内容，白色以外的部分必须和原图保持一模一样，画面尺寸和构图不变。${refs}\n要改成：${prompt}`
  return [inline(inputs[0]), { inlineData: { mimeType: 'image/png', data: bwB64 } }, ...inputs.slice(1).map(inline), { text }]
}

type Picked = { b64: string; format?: string } | { error: string }

/**
 * 从答复里拿图，按 `api` 拆。**纯函数**，e2e 探针直接打它。
 *
 * OpenAI：流式的图在 `image_generation.completed`（画）或 `image_edit.completed`（改）那一帧；
 * 也认非流式的整块 JSON（`data[0].b64_json`）——中间要是有一层代理把流攒成了一块，答复就是
 * 那个形状。流里出错是一帧 `{ type: 'error', error: { message } }`。
 *
 * Gemini：每一帧都是一份 GenerateContentResponse，图在 `candidates[0].content.parts[].inlineData`。
 * **`thought: true` 的那几张不要**——Gemini 3 的生图模型会先画几张草稿当思考过程，真正的
 * 结果是最后一张不带这个标记的。一张图都没有时多半是被安全策略拦了，`finishReason` /
 * `promptFeedback.blockReason` 会说是哪一种，照实报出来。
 */
export function imageFromResponse(text: string, api = 'openai-images'): Picked {
  const payloads = payloadsOf(text)
  if ('error' in payloads) return payloads
  return api === 'gemini-images' ? geminiImage(payloads.list) : openaiImage(payloads.list)
}

/** 答复 → 一串 JSON 对象。SSE 一帧一个；整块 JSON 是一个（Gemini 非流式时是一个数组，摊平）。 */
function payloadsOf(text: string): { list: Record<string, unknown>[] } | { error: string } {
  const trimmed = text.trim()
  if (!trimmed) return { list: [] }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const o: unknown = JSON.parse(trimmed)
      const arr = Array.isArray(o) ? o : [o]
      return { list: arr.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') }
    } catch {
      return { error: '答复不是合法的 JSON' }
    }
  }
  const list: Record<string, unknown>[] = []
  for (const frame of text.split(/\r?\n\r?\n/)) {
    for (const line of frame.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const o: unknown = JSON.parse(payload)
        if (o && typeof o === 'object') list.push(o as Record<string, unknown>)
      } catch {}
    }
  }
  return { list }
}

function errorOf(o: Record<string, unknown>): string | undefined {
  const e = o.error
  if (typeof e === 'string' && e) return e
  if (e && typeof e === 'object') {
    const m = (e as { message?: unknown }).message
    return typeof m === 'string' && m ? m : '上游报错'
  }
  return undefined
}

function openaiImage(list: Record<string, unknown>[]): Picked {
  let failure = ''
  for (const o of list) {
    const type = o.type
    if ((type === 'image_generation.completed' || type === 'image_edit.completed') && typeof o.b64_json === 'string' && o.b64_json) {
      return { b64: o.b64_json, format: typeof o.output_format === 'string' ? o.output_format : undefined }
    }
    const data = Array.isArray(o.data) ? (o.data[0] as { b64_json?: unknown } | undefined) : undefined
    if (typeof data?.b64_json === 'string' && data.b64_json) {
      return { b64: data.b64_json, format: typeof o.output_format === 'string' ? o.output_format : undefined }
    }
    failure = errorOf(o) ?? failure
  }
  return { error: failure || '流结束了也没等到那张图' }
}

function geminiImage(list: Record<string, unknown>[]): Picked {
  let last: { b64: string; format?: string } | undefined
  let finish = ''
  let blocked = ''
  let failure = ''
  for (const o of list) {
    failure = errorOf(o) ?? failure
    const feedback = o.promptFeedback as { blockReason?: unknown } | undefined
    if (typeof feedback?.blockReason === 'string') blocked = feedback.blockReason
    const cand = Array.isArray(o.candidates) ? (o.candidates[0] as Record<string, unknown> | undefined) : undefined
    if (!cand) continue
    if (typeof cand.finishReason === 'string') finish = cand.finishReason
    const parts = (cand.content as { parts?: unknown } | undefined)?.parts
    for (const p of Array.isArray(parts) ? parts : []) {
      if (!p || typeof p !== 'object' || (p as { thought?: unknown }).thought === true) continue
      const inline = ((p as Record<string, unknown>).inlineData ?? (p as Record<string, unknown>).inline_data) as { data?: unknown; mimeType?: unknown; mime_type?: unknown } | undefined
      if (typeof inline?.data === 'string' && inline.data) {
        const mime = String(inline.mimeType ?? inline.mime_type ?? '')
        last = { b64: inline.data, format: FORMAT_OF_MIME[mime] }
      }
    }
  }
  if (last) return last
  if (failure) return { error: failure }
  if (blocked) return { error: `描述被安全策略拦下了（${blocked}），换个说法再试。` }
  if (finish && finish !== 'STOP') return { error: `模型没有出图（${finish}）。多半是安全策略拦下了，换个说法再试。` }
  return { error: '流结束了也没等到那张图' }
}

/** 上游 / Gateway / 管家回的错是 `{ error: { message } }` 或 `{ error: '…' }`。拿不出就给一截原文。 */
function errorText(status: number, text: string): string {
  try {
    const o = JSON.parse(text) as Record<string, unknown> | Record<string, unknown>[]
    const m = errorOf(Array.isArray(o) ? (o[0] ?? {}) : o)
    if (m) return m
  } catch {}
  return `HTTP ${status}${text ? ` ${text.slice(0, 200)}` : ''}`
}

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 文件名：模型给了 `name` 就用它（扩展名以实际格式为准），否则按时间起。
 * 清洗和「重名不覆盖」在 workspace.saveBytes 里，这里只管挑一个像样的主干。
 */
export function imageFileName(raw: unknown, format: Format): string {
  const stem = String(raw ?? '')
    .trim()
    .replace(/\.(png|jpe?g|webp)$/i, '')
    .replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '_')
    .slice(0, 80)
  return `${stem || `image-${stamp()}`}.${EXT[format]}`
}

/** 参数里的 `images` → 路径列表。给了一个字符串也认。 */
export function inputPathsOf(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' && raw.trim() ? [raw] : []
  return [...new Set(list.map((x) => String(x ?? '').trim()).filter(Boolean))]
}

/**
 * 图片的宽高（文件里像素的宽高，不管 EXIF 方向），只认 PNG 和 JPEG（蒙版只能是 PNG，原图常见的
 * 就这两种）。认不出就是 undefined，调用方跳过尺寸校验——宁可让上游去判，也不在这儿误拦。
 */
export function imageDims(buf: Buffer): { width: number; height: number } | undefined {
  const png = pngInfo(buf)
  if (!('error' in png)) return { width: png.width, height: png.height }
  let dims: { width: number; height: number } | undefined
  jpegSegments(buf, (m, d) => {
    // SOF0–SOF15，除去 DHT（C4）、JPG（C8）、DAC（CC）这三个同号段的非帧头。
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc && d.length >= 5) {
      dims = { width: d.readUInt16BE(3), height: d.readUInt16BE(1) }
      return true
    }
  })
  return dims
}

/**
 * 蒙版能不能用、要不要转方向。**纯函数**，e2e 探针直接打它。
 *
 * 必须是 PNG、必须带透明通道（透明的地方才是要重画的）、和第一张原图一样大——都是 OpenAI 的
 * 硬要求，不在这儿挡的话上游回的是一句英文的 400，模型多半看不懂该改什么。
 *
 * **「一样大」要算上 EXIF 方向。** 手机拍的竖图常常按横图存、带一个方向标记，浏览器显示时会
 * 转过来，于是人在界面上涂出来的蒙版是**显示方向**的尺寸（3024×4032），文件里的像素却是
 * 4032×3024。这种蒙版照原样发出去和原图对不上，所以换回文件里像素的方向再发
 * （`unorient`）。只按文件尺寸量的话，手机竖图一律过不了尺寸校验。
 *
 * 再真把像素解开看一眼：一个透明的地方都没有，等于「什么都不改」，发出去也是白花钱。解不开时，
 * OpenAI 那条照样放行（上游自己会判，这里只是提前拦一道）；Gemini 那条要靠像素画黑白蒙版
 * （`needPixels`），要转方向的也得靠像素，解不开就只能拦下。
 */
export function prepareMask(mask: Buffer, first: Buffer | undefined, needPixels = false): { bytes: Buffer } | { error: string } {
  const info = pngInfo(mask)
  if ('error' in info) return { error: '蒙版得是 PNG。' }
  // IHDR 的颜色类型：4 是灰度 + 透明，6 是 RGBA。其余类型只有真带 tRNS 块才有透明。
  if (info.colorType !== 4 && info.colorType !== 6 && !info.trns) {
    return { error: '蒙版没有透明通道。要重画的地方得是透明的，其余不透明。' }
  }
  const stored = first ? imageDims(first) : undefined
  const orientation = first ? jpegOrientation(first) : 1
  const swap = orientation >= 5
  const shown = stored && (swap ? { width: stored.height, height: stored.width } : stored)
  const same = (d: { width: number; height: number } | undefined) => !!d && d.width === info.width && d.height === info.height
  // 带方向标记、而且蒙版是显示方向的尺寸：人照着屏幕涂的，要转回去。
  const turn = orientation !== 1 && same(shown)
  if (stored && !same(stored) && !turn) {
    return { error: `蒙版是 ${info.width}×${info.height}，原图是 ${shown!.width}×${shown!.height}，得一样大。` }
  }
  const decoded = decodeAlpha(mask)
  if ('error' in decoded) {
    if (needPixels || turn) return { error: `这张蒙版读不出来（${decoded.error}）。换一张 8 位 RGBA 的 PNG，界面上涂出来的就是。` }
    return { bytes: mask }
  }
  if (!maskRegion(decoded)) return { error: '蒙版上没有透明的地方——透明的那一块才是要重画的。' }
  return { bytes: turn ? encodeAlphaMask(unorient(decoded, orientation, stored!.width, stored!.height)) : mask }
}

/** prepareMask 只要结论的那一半。 */
export function maskProblem(mask: Buffer, first: Buffer | undefined, needPixels = false): string | undefined {
  const r = prepareMask(mask, first, needPixels)
  return 'error' in r ? r.error : undefined
}

export function apply(ctx: Context) {
  /**
   * 把原图和蒙版从工作区读进来。越界（`resolve` 会抛）、不是认得的格式、太大，都是**业务失败**：
   * 写成一句话给模型，它才知道换哪张、或者先把图缩小。原图和蒙版共用一个总量上限。
   */
  async function loadInputs(paths: string[], maskPath: string, api: string): Promise<{ inputs: InputImage[]; mask?: InputImage } | { error: string }> {
    if (paths.length > INPUT_MAX) return { error: `一次最多带 ${INPUT_MAX} 张原图，这次给了 ${paths.length} 张。` }
    const budget = inputBudget()
    let total = 0
    const read = async (path: string): Promise<{ bytes: Buffer } | { error: string }> => {
      let file: string
      let size: number
      try {
        file = ctx.workspace.resolve(path)
        size = (await stat(file)).size
      } catch (e) {
        // 不存在的时候别把 stat 那句带着绝对路径的原话甩给模型——它只需要知道换一张。
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { error: `工作区里没有 ${path}。` }
        return { error: `读不到 ${path}：${(e as Error).message}` }
      }
      total += size
      if (total > budget) {
        return { error: `原图一共超过 ${Math.round(budget / 1024 / 1024)} MB 了（到 ${path} 为止）。少带几张，或者先把图缩小。` }
      }
      return { bytes: await readFile(file) }
    }

    const inputs: InputImage[] = []
    let first: Buffer | undefined
    for (const path of paths) {
      const mime = INPUT_MIME[extname(path).toLowerCase()]
      if (!mime) return { error: `${path} 不是 PNG / JPEG / WebP，当不了原图。` }
      const got = await read(path)
      if ('error' in got) return got
      first ??= got.bytes
      inputs.push({ path, mime, b64: got.bytes.toString('base64') })
    }
    if (!maskPath) return { inputs }

    if (extname(maskPath).toLowerCase() !== '.png') return { error: `蒙版 ${maskPath} 得是 PNG。` }
    const got = await read(maskPath)
    if ('error' in got) return got
    const prepared = prepareMask(got.bytes, first, api === 'gemini-images')
    if ('error' in prepared) return { error: `${maskPath}：${prepared.error}` }
    return { inputs, mask: { path: maskPath, mime: 'image/png', b64: prepared.bytes.toString('base64') } }
  }

  ctx.tools.register({
    name: 'generate_image',
    // 画图和主代理还是子代理干没关系；平台开没开由工具表那一层管（agent 的 toolSchemasFor）。
    delegation: {},
    /**
     * `external`：描述和原图会发到生图供应商那里。`read` 而不是 `write`：它不改任何已有的
     * 东西——改图也是另存一张新的，原图不动——只往工作区 `images/` 里放新文件（重名不覆盖），
     * 和 web_extract 的 save 同一个性质。标成 write 的话，external + write 每画一张都要弹卡。
     */
    risk: ['external', 'read'],
    description:
      '画一张图，存进工作区 images/ 目录，用户在对话里能直接看到。按描述画新图；给了 images（工作区里的图片路径，用户发来的图在消息里标着路径）就是拿那几张图改、或者照着它们画；再给 mask 就只重画蒙版透明的那一块。描述写画面本身：主体、场景、风格、构图、颜色、要出现的文字（原样加引号）；改图时写清楚改哪里、哪里保持不变。不要把用户的姓名、联系方式这类隐私写进描述。一次调用出一张；要几个版本就调几次。原图不会被改动。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '画面描述，或者要怎么改。越具体越好，中英文都行。' },
        mask: {
          type: 'string',
          description: '局部重绘的蒙版：工作区里一张带透明通道的 PNG，和第一张原图一样大，透明的地方重画、其余不动。用户在界面上涂出来的蒙版会作为附件发过来。',
        },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: `要改的图、或者参考图：工作区里的路径（PNG / JPEG / WebP），最多 ${INPUT_MAX} 张。不给就是画新图。`,
        },
        size: { type: 'string', enum: [...SIZES], description: '1024x1024 方图、1536x1024 横图、1024x1536 竖图，auto 让模型自己定。画新图默认方图，改图默认 auto（跟原图走）。' },
        quality: { type: 'string', enum: [...QUALITIES], description: '质量，默认 medium。high 更精细，但更慢、更贵。' },
        transparent: { type: 'boolean', description: '要透明背景（图标、贴纸、Logo）。默认 false。有的模型画不了。' },
        format: { type: 'string', enum: [...FORMATS], description: '文件格式。默认 jpeg；透明背景时默认 png。有的模型只出自己的格式。' },
        name: { type: 'string', description: '文件名（不带扩展名），不给就按时间起。' },
      },
      required: ['prompt'],
    },
    async execute(args, call) {
      const a = (args ?? {}) as ImageArgs
      const model = ctx.catalog.models.image as ImageModelRef | null
      // 不在工具表里也可能被调到（模型照着历史里的名字报）。平台没开就明说。
      if (!model) return { text: '平台还没有开通生图（模型配置页里没选生图模型），这次画不了。' }
      const maskPath = typeof a.mask === 'string' ? a.mask.trim() : ''
      const loaded = await loadInputs(inputPathsOf(a.images), maskPath, model.api)
      if ('error' in loaded) return { text: loaded.error }
      const inputs = loaded.inputs
      const req = imageRequest(model, a, inputs, loaded.mask)
      if ('error' in req) return { text: req.error }

      const signal = call.signal ? AbortSignal.any([call.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS)
      let text: string
      try {
        const r = await fetch(`${llmBaseUrl()}/v1/images/${req.edit ? 'edits' : 'generations'}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${gatewayApiKey()}`,
            'content-type': 'application/json',
            accept: 'text/event-stream, application/json',
          },
          body: JSON.stringify(req.body),
          signal,
        })
        text = await r.text()
        if (!r.ok) {
          // 管家太老、还没有这条路由时是 404 not found。别让模型以为是它参数写错了。
          if (r.status === 404 && /not found/i.test(text) && !/模型/.test(text)) {
            return { text: `这台机器上的管家版本太旧，还不支持${req.edit ? '改图' : '生图'}。等管家升级之后再试。` }
          }
          return { text: `生图失败：${errorText(r.status, text)}` }
        }
      } catch (e) {
        if (call.signal?.aborted) return { text: '已停止。', failed: true }
        const timedOut = (e as Error).name === 'TimeoutError'
        return { text: timedOut ? `生图超时（${TIMEOUT_MS / 60_000} 分钟没画完）。换个低一点的 quality 再试。` : `生图失败：${(e as Error).message}`, failed: true }
      }

      const got = imageFromResponse(text, model.api)
      if ('error' in got) return { text: `生图失败：${got.error}` }
      const format = (FORMATS as readonly string[]).includes(String(got.format)) ? (got.format as Format) : req.format
      let file: { path: string; name: string; size: number }
      try {
        file = await ctx.workspace.saveBytes('images', imageFileName(a.name, format), Buffer.from(got.b64, 'base64'))
      } catch (e) {
        return { text: `图画好了，但存不进工作区：${(e as Error).message}`, failed: true }
      }
      const files: WorkspaceFile[] = [{ path: file.path, name: file.name }]
      const kb = Math.max(1, Math.round(file.size / 1024))
      const verb = loaded.mask
        ? `按蒙版 ${loaded.mask.path} 局部重绘 ${inputs[0].path} 的结果`
        : req.edit
          ? `按 ${inputs.map((i) => i.path).join('、')} 改好的图`
          : '图'
      return {
        text: `${verb}已保存到 ${file.path}（${kb} KB），用户在对话里能直接看到。不用再描述图里画了什么，除非用户问。`,
        files,
      }
    },
  })
}
