import type { Context } from '@deepseek-ai/cordis'

/** 送进模型的图：用户消息里的、工具结果里的。读盘有一份小缓存，看不了图的模型换成一句说明。 */

/**
 * 这一轮的模型看不看得了图。看的是目录里的 `input`（Gateway 的 /v1/models 发的）。
 *
 * **目录里没写的当看不了**（llm 的 stubModel 就是 `['text']`）：把图塞给纯文本模型，上游会
 * 把整个请求拒掉、这一轮直接失败；少给一张图，最多是模型说它看不到。宁可少给。
 */
export function seesImages(model: { input?: unknown } | undefined): boolean {
  return Array.isArray(model?.input) && model.input.includes('image')
}

/**
 * 工具结果里一次最多带几张图的字节（跨调用算，只留最近的）。
 *
 * 渲染一页文档约一千多 token；模型核对排版通常只看刚画的那几页，更早的换成一句说明。
 * 和用户消息里的图（MAX_LIVE_IMAGES）分开算：两边回答的不是一个问题。
 */
export const MAX_LIVE_TOOL_IMAGES = 6

/** 回放历史里某条工具结果的图：太靠前的换成一句说明，其余照 toolImageBlocks。 */
export async function replayToolImages(
  seq: number,
  images: { path: string; mime: string }[],
  sees: boolean,
  live: Set<string>,
  ctx?: Context,
): Promise<any[]> {
  if (!sees) return toolImageBlocks(images, false, ctx)
  const out: any[] = []
  for (const [i, img] of images.entries()) {
    out.push(live.has(`${seq}:${i}`) ? await loadImage(img, ctx) : { type: 'text', text: `（这里有一张图 ${img.path}，离现在太远，这一轮没有放进上下文。）` })
  }
  return out
}

/** 工具结果里的图 → 送进模型的块：看得了就是图片块，看不了就是一句说明。 */
export async function toolImageBlocks(images: { path: string; mime: string }[], sees: boolean, ctx?: Context): Promise<any[]> {
  if (!sees) {
    return [
      {
        type: 'text',
        text:
          `\n（这一轮用的模型看不了图，${images.length} 张图没有送进来：${images.map((i) => i.path).join('、')}。` +
          '要核对样子，可以请用户在界面上点开文件预览看。）',
      },
    ]
  }
  const out: any[] = []
  for (const img of images) out.push(await loadImage(img, ctx))
  return out
}

/**
 * 单张图喂给模型的上限（原始字节）。
 *
 * 各家上限不一样（Anthropic 5 MB、OpenAI 20 MB，都按 base64 之后算，要再打七折），
 * 这里取最紧的那个再留些余量。超了不缩放——缩放要拉原生图像库，而部署包是预打的
 * arm64，为这件事拉一个原生依赖不划算。超限就换成一句说明，模型至少知道有这么个东西。
 */
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024

/**
 * 一轮里最多带几张真图。再往前的换成一句说明。
 *
 * 每张图大约值一两千 token，而人问的几乎总是最近那几张。这个数字是「上下文里同时
 * 摆得下几张图」，不是「一条消息最多几张」——一条消息带十张图，也只有最后几张进得去。
 */
export const MAX_LIVE_IMAGES = 4

/**
 * 已经读过的图。键里带 mtime 和 size，文件被改过自然不命中。
 *
 * 一轮之内同一张图只读一次，多轮之间也复用——没有它，每发一句话都要把上下文里那几张
 * 图整个重新读一遍盘、重新 base64 一遍。
 */
const IMAGE_CACHE = new Map<string, string>()
const IMAGE_CACHE_MAX = 8

function imageCacheGet(key: string): string | undefined {
  const hit = IMAGE_CACHE.get(key)
  // 命中就挪到末尾，砍的总是最久没用的那份。
  if (hit !== undefined) {
    IMAGE_CACHE.delete(key)
    IMAGE_CACHE.set(key, hit)
  }
  return hit
}

function imageCachePut(key: string, data: string) {
  IMAGE_CACHE.set(key, data)
  while (IMAGE_CACHE.size > IMAGE_CACHE_MAX) IMAGE_CACHE.delete(IMAGE_CACHE.keys().next().value as string)
}

/** 太靠前、这一轮不带字节的图。说清楚它存在过，模型才不会以为自己漏看了什么。 */
export function stale(img: { path: string }) {
  return { type: 'text', text: `（前面有一张图 ${img.path}，离现在太远，这一轮没有放进上下文。）` }
}

export async function loadImage(img: { path: string; mime: string }, ctx?: Context) {
  const miss = (why: string) => ({ type: 'text', text: `（附了一张图 ${img.path}，但${why}。）` })
  // ctx 缺席才走这条路：ctx 本身是可选参数（userContentFor / toAgentMessages 都声明成
  // `ctx?`），给不出上下文的调用方——测试里手搓一份历史、以后可能有的离线重放——
  // 应该看到一句说明，而不是崩掉。
  if (!ctx) return miss('这个运行时读不到工作区')
  try {
    // 取工作区的两种失败**都得在 try 里面**，因为 cordis 对这两种的反应不一样：
    //
    // - 插件上下文（fiber.runtime 有值）没 inject 这个服务：读属性直接**抛**
    //   `cannot get property "workspace" without inject`。曾经的 `!ctx?.workspace`
    //   就是栽在这儿——它写在 try 外面，一次都没兜住，反而把异常带出整轮。
    // - 裸的根上下文（`new Context()`，探针在造的那种）：cordis 走
    //   `reflect.get(prop, false)`，服务没注册就是 **undefined**，不抛。
    //
    // 所以抛的那支交给下面的 catch，undefined 那支自己判一次——不判的话就是一个
    // `Cannot read properties of undefined (reading 'resolve')` 冒充「读不出来」。
    const ws = ctx.workspace
    if (!ws) return miss('这个运行时读不到工作区')
    const file = ws.resolve(img.path)
    const { readFile, stat } = await import('node:fs/promises')
    const info = await stat(file)
    if (info.size > MAX_IMAGE_BYTES) {
      return miss(`它有 ${(info.size / 1024 / 1024).toFixed(1)} MB，超过了能直接看的大小`)
    }
    const key = `${file}|${info.mtimeMs}|${info.size}`
    let data = imageCacheGet(key)
    if (data === undefined) {
      data = (await readFile(file)).toString('base64')
      imageCachePut(key, data)
    }
    return { type: 'image', data, mimeType: img.mime }
  } catch (e) {
    return miss(`读不出来：${(e as Error).message}`)
  }
}
