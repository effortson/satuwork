import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { Service, type Context } from '@deepseek-ai/cordis'
import { gatewayApiKey, gatewayToken, gatewayUrl, llmBaseUrl } from '../llm/gateway.ts'
import { docKindOf, extractDocument } from '../workspace/extract.ts'

/**
 * 网页搜索与提取，席位这一侧。
 *
 * 这一层只做三件事：**调一次 Gateway、按长度决定要不要摘要、要不要落盘**。
 * 后端适配（Tavily / DuckDuckGo / …）和密钥都在 Gateway——Bot 版本的推进比 Gateway
 * 慢得多，把后端放进跑得慢的那一半，等于每换一家后端都要重新出包、重新部署所有席位。
 *
 * 抓回来的正文是**从网上取回来的数据，不是指令**。它会原样进模型的上下文，所以两件
 * 事必须在这里做完：剥掉脚本/样式/注释和不可见字符（藏在那里的指令用户根本看不见），
 * 再用 `<web_content>` 包起来。挡不住铁了心的注入——真正的边界在 tools/pre-execute
 * 那条 waterfall 上——但至少别让一段网页伪装成一条系统指令。
 */

/** 直出上限：短于它就原样给模型，一次模型调用都不用花。 */
export const INLINE_MAX = 8_000
/** 摘要的输出上限。 */
export const SUMMARY_MAX = 6_000
/** 肯做单次摘要的上限。再长的切块并行摘。 */
export const SINGLE_PASS_MAX = 400_000
/** 分块：每块多大、最多几块、几路并行。 */
export const CHUNK_SIZE = 80_000
export const MAX_CHUNKS = 20
export const CHUNK_CONCURRENCY = 4
/** 每块摘要的输出上限。20 块 × 1200 ≈ 24k，还够再收一次。 */
export const CHUNK_SUMMARY_MAX = 1_200
/** 拒绝的红线。 */
export const HARD_MAX = 1_500_000
/** 一次调用多个 URL 时整体进上下文的量。五页各 6000 已经是 terminal 输出上限的量级了。 */
export const TOTAL_MAX = 12_000

const SUMMARY_TIMEOUT_MS = 120_000

/** 允许落盘的文档后缀，和 Gateway 那边的 DOC_TYPES 一一对应。别的一律当 .bin。 */
const DOC_EXTS = ['.pdf', '.docx', '.xlsx', '.xlsm']

export interface SearchHit {
  title: string
  url: string
  snippet: string
  publishedAt?: string
}

export interface SearchOut {
  backend: string
  hits: SearchHit[]
  filtered: boolean
  elapsedMs: number
}

export interface ExtractedPage {
  url: string
  ok: boolean
  title?: string
  markdown?: string
  chars?: number
  error?: string
  /** PDF / Word / Excel：Gateway 给的是字节，正文要在这边提。 */
  document?: { contentType: string; ext: string; base64: string; bytes: number }
}

export interface ExtractOut {
  backend: string
  pages: ExtractedPage[]
  elapsedMs: number
}

/** 业务失败：没配后端、限流、参数不对。**不是**管道故障，照常返回文本。 */
export class WebFailure extends Error {}

async function callGateway<T>(path: string, body: unknown): Promise<T> {
  const base = gatewayUrl()
  const token = gatewayToken()
  if (!base || !token) throw new WebFailure('这台机器没有配 Gateway，网页工具用不了。')
  let r: Response
  try {
    r = await fetch(base + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    })
  } catch (e) {
    // 连不上 Gateway 是**管道故障**，不是业务失败——模型改什么都没用。
    throw new Error(`连不上 Gateway：${(e as Error).message}`)
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(`Gateway 返回 HTTP ${r.status}${text ? ` ${text.slice(0, 200)}` : ''}`)
  }
  const data = (await r.json()) as { ok?: boolean; error?: string } & T
  // ok:false 是 Gateway 那头判出来的业务失败，原话直接给模型。
  if (data?.ok === false) throw new WebFailure(data.error || '网页工具失败了')
  return data
}

export async function search(args: {
  query: string
  count?: number
  domains?: string[]
  exclude?: string[]
  freshness?: string
}): Promise<SearchOut> {
  return callGateway<SearchOut>('/runtime/web/search', args)
}

export async function extract(urls: string[]): Promise<ExtractOut> {
  return callGateway<ExtractOut>('/runtime/web/extract', { urls })
}

/**
 * 清洗抓回来的正文。
 *
 * 剥的是「用户在页面上看不见、但会进模型上下文」的东西：脚本、样式、HTML 注释、
 * 零宽字符和双向控制符。看得见的内容一个字不动——那是模型要读的东西。
 */
export function sanitize(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // 零宽、字节序标记、双向控制符（U+202A–202E、U+2066–2069）。
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

/** 落盘用的文件名：日期 + 域名 + 标题头几个字。同名就加序号，不覆盖。 */
export function fileNameFor(url: string, title: string, now: Date): string {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  let host = ''
  try {
    host = new URL(url).hostname.replace(/^www\./, '')
  } catch {
    host = 'page'
  }
  const slug = `${host} ${title}`
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${day}-${slug || 'page'}.md`
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    websearch: WebSearchService
  }
}

export class WebSearchService extends Service {
  /**
   * **catalog 和 roster 必须写在这里**，哪怕这个服务的调用方是 tools/web.ts。
   *
   * cordis 的服务是隔离的：没在 inject 里声明的服务，取一下就抛
   * 「cannot get property without inject」。而这里取 catalog 是为了拿 utility 模型，
   * 取 roster 是最后那一级回退——漏了它们，摘要每次都静悄悄退化成「截原文开头」，
   * 而那条路本来是给模型不可用准备的应急道，不是常态。
   */
  static inject = ['workspace', 'catalog', 'roster']

  constructor(ctx: Context) {
    super(ctx, 'websearch')
  }

  /** 摘要用哪个模型：utility → daily → 本 Bot 当前在用的那个。 */
  private summaryModel(): { provider: string; model: string; reasoningEffort: string } | null {
    const roles = this.ctx.catalog?.models
    for (const role of [roles?.utility, roles?.daily]) {
      if (role?.provider && role.model) return { provider: role.provider, model: role.model, reasoningEffort: role.reasoningEffort }
    }
    const pin = (process.env.SATUWORK_BOT_ID || '').trim()
    const bot = (pin ? this.ctx.roster?.get(pin) : null) ?? this.ctx.roster?.list()?.[0]
    if (bot?.provider && bot.model) return { provider: bot.provider, model: bot.model, reasoningEffort: 'off' }
    return null
  }

  /**
   * 一次非流式补全。**不复用 agent 那条流式路**：摘要不需要流，也不该出现在会话
   * 事件里——它是工具内部的一次调用，不是这个 Bot 说的话。
   */
  private async complete(system: string, user: string): Promise<string> {
    // 模型调用走 llmBaseUrl()：席位上是管家转发口，不是 Gateway 本身。
    const base = llmBaseUrl()
    const key = gatewayApiKey()
    const picked = this.summaryModel()
    if (!base || !key || !picked) throw new Error('没有可用的摘要模型')
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: `${picked.provider}/${picked.model}`,
        provider: picked.provider,
        stream: false,
        ...(picked.reasoningEffort !== 'off' ? { reasoning_effort: picked.reasoningEffort } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
    })
    if (!r.ok) throw new Error(`摘要模型返回 HTTP ${r.status}`)
    const data = (await r.json()) as any
    const text = data?.choices?.[0]?.message?.content
    const out = typeof text === 'string' ? text : Array.isArray(text) ? text.map((c: any) => c?.text ?? '').join('') : ''
    if (!out.trim()) throw new Error('摘要模型没有返回内容')
    return out.trim()
  }

  /**
   * 长页面收敛成能进上下文的量。
   *
   * 摘要要求写死在 prompt 里：保留数字、专有名词、代码块和引文**原样**，不要复述
   * 结构，不要加原文没有的结论。含糊的要求换不来稳定的摘要。
   */
  async condense(text: string, goal: string): Promise<{ text: string; summarized: boolean; note?: string }> {
    if (text.length <= INLINE_MAX) return { text, summarized: false }
    const system = [
      '你在为另一个 AI 助理压缩一份网页正文。',
      '规则：',
      '1. 数字、专有名词、版本号、代码块和引文一律原样保留，不要改写、不要换算。',
      '2. 不要复述结构（不要写「本文首先介绍…」），直接给内容。',
      '3. 不要添加原文没有的结论或推测。',
      `4. 输出控制在 ${SUMMARY_MAX} 字符以内，用中文，可以用列表。`,
      goal ? `5. 读者关心的是：${goal}。围绕它取舍，相关的多留，无关的略过。` : '',
    ]
      .filter(Boolean)
      .join('\n')
    try {
      const source =
        text.length <= SINGLE_PASS_MAX ? text : await this.chunked(text, goal)
      const out = await this.complete(system, source)
      return { text: out.slice(0, SUMMARY_MAX), summarized: true }
    } catch (e) {
      // 摘要挂了不算失败：模型拿到原文开头也能干活，比拿到一条错误强。
      this.ctx.logger?.warn?.(`web_extract: 摘要失败 ${(e as Error).message}`)
      return {
        text: text.slice(0, INLINE_MAX),
        summarized: false,
        note: `摘要失败（${(e as Error).message}），以下是原文开头`,
      }
    }
  }

  /**
   * 超长正文：切块 → 并行各摘一段 → 拼起来，再交给上面那次收口。
   *
   * **并行度压到 4**：一份 1M 字符的页面能切出 13 块，全放出去等于一瞬间给
   * Gateway 十几个请求，而它同时还在替这台机器上别的席位转发对话。
   *
   * 某一块摘失败不牵连别的：那一块退回自己的开头一小段。丢一块的摘要仍然有用，
   * 整个失败就只剩「截原文前 8000 字」这一条路了。
   */
  private async chunked(text: string, goal: string): Promise<string> {
    const chunks: string[] = []
    for (let i = 0; i < text.length && chunks.length < MAX_CHUNKS; i += CHUNK_SIZE) {
      chunks.push(text.slice(i, i + CHUNK_SIZE))
    }
    const system = [
      '你在给一份很长的网页正文做分段摘要，下面是其中一段。',
      '规则：数字、专有名词、版本号、代码块和引文原样保留；不要复述结构；不要加原文没有的结论。',
      `输出控制在 ${CHUNK_SUMMARY_MAX} 字符以内。`,
      goal ? `读者关心的是：${goal}。` : '',
    ]
      .filter(Boolean)
      .join('\n')

    const out: string[] = new Array(chunks.length).fill('')
    let next = 0
    const worker = async () => {
      while (true) {
        const i = next++
        if (i >= chunks.length) return
        try {
          out[i] = (await this.complete(system, chunks[i]!)).slice(0, CHUNK_SUMMARY_MAX)
        } catch {
          out[i] = chunks[i]!.slice(0, 600)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, chunks.length) }, worker))
    const tail = text.length > MAX_CHUNKS * CHUNK_SIZE ? `\n\n（原文还有 ${text.length - MAX_CHUNKS * CHUNK_SIZE} 字符没有纳入摘要。）` : ''
    return out.map((piece, i) => `【第 ${i + 1} 段】\n${piece}`).join('\n\n') + tail
  }

  /**
   * 文档：先落盘，再用 workspace/extract.ts 提正文。
   *
   * **一定落盘**，不像网页那样看 save 参数：一份 PDF 的原件是有价值的，人多半还要
   * 自己打开看；而且那条提取路本来就是「读磁盘上的文件」，不落盘也得先落盘。
   */
  async document(
    url: string,
    title: string,
    doc: { ext: string; base64: string },
  ): Promise<{ path: string; name: string; text: string; extractError?: string }> {
    // **ext 是 Gateway 给的，是外部输入。** 直接拼进文件名就是一条写路径：
    // `/../../.ssh/authorized_keys` 这种值能让这次写落到工作区外面去。白名单一挡，
    // 再让最终路径过一遍 workspace.resolve()——越界在那里会被拒，和别的写入同一条规矩。
    const ext = DOC_EXTS.includes(doc.ext) ? doc.ext : '.bin'
    const base = fileNameFor(url, title, new Date()).replace(/\.md$/, ext)
    let name = base
    for (let i = 2; i < 100; i++) {
      if (!existsSync(this.ctx.workspace.resolve(`web/${name}`))) break
      name = base.slice(0, -ext.length) + `-${i}${ext}`
    }
    const target = this.ctx.workspace.resolve(`web/${name}`)
    await mkdir(this.ctx.workspace.resolve('web'), { recursive: true })
    await writeFile(target, Buffer.from(doc.base64, 'base64'))
    const path = this.ctx.workspace.show(target)
    const kind = docKindOf(name)
    if (!kind) return { path, name, text: '' }
    try {
      return { path, name, text: (await extractDocument(target, kind)).text }
    } catch (e) {
      /**
       * **提文失败不能连累「文件已经落盘」这个事实。**
       *
       * 这两步以前共用调用方的一个 catch：一份损坏的 PDF 让 unpdf 抛出来，模型收到的
       * 是「存不进工作区」——可文件明明就在那儿，只是没进 ToolResult.files，于是界面上
       * 也看不见它。文件已经写成了就要报出来，取不出正文是另一件事，分开说。
       */
      return { path, name, text: '', extractError: (e as Error).message }
    }
  }

  /** 原文落到 `work/web/`。摘要是有损的，落盘让漏掉的东西还捞得回来。 */
  async save(url: string, title: string, markdown: string): Promise<{ path: string; name: string }> {
    await mkdir(this.ctx.workspace.resolve('web'), { recursive: true })
    const base = fileNameFor(url, title, new Date())
    // 同名不覆盖：同一天抓同一页两次，第二次多半是因为页面变了，正是要能对比。
    // 路径一律过 workspace.resolve()，和 document() 同一条规矩。
    let name = base
    for (let i = 2; i < 100; i++) {
      if (!existsSync(this.ctx.workspace.resolve(`web/${name}`))) break
      name = base.replace(/\.md$/, `-${i}.md`)
    }
    const target = this.ctx.workspace.resolve(`web/${name}`)
    const head = `# ${title || url}\n\n来源：${url}\n抓取时间：${new Date().toISOString()}\n\n---\n\n`
    await writeFile(target, head + markdown, 'utf8')
    return { path: this.ctx.workspace.show(target), name }
  }
}

export const name = 'satu-websearch'
export const inject = ['workspace', 'catalog', 'roster']

export function apply(ctx: Context) {
  ctx.plugin(WebSearchService)
}
