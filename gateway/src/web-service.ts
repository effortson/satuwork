/**
 * 网页工具的业务层：配置取用、后端派发、计量计价。
 *
 * 路由层只负责鉴权和收参数，这里负责「用哪家后端、拿哪把密钥、这一次算多少钱」。
 * 摆成单独一层是因为这三件事在自检、搜索、提取三条路上是同一套，而它们的鉴权各不
 * 相同（自检是 owner，另两条是席位票）。
 */
import type { Account, Db, WebCallKind, WebToolsSettings } from './db.ts'
import { WEB_DOCUMENT, emptyWebTools } from './db.ts'
import type { Meter } from './lib/meter.ts'
import {
  WebToolError,
  applyFilters,
  backendOf,
  fetchDocument,
  guardUrl,
  looksLikeDocument,
  stubFetchDocument,
  needsSecret,
  type BackendConfig,
  type Extracted,
  type SearchHit,
  type SearchQuery,
} from './web-tools.ts'

/** 一次 extract 最多几个 URL；单次搜索最多几条。和工具 schema 上写给模型的一致。 */
export const MAX_EXTRACT_URLS = 5
export const MAX_SEARCH_COUNT = 10
export const DEFAULT_SEARCH_COUNT = 5

export interface ResolvedBackend {
  id: string
  cfg: BackendConfig
}

/** 缓存活多久、最多存几条。 */
const CACHE_TTL_MS = 15 * 60_000
const CACHE_MAX = 64

/**
 * 进程内 LRU。
 *
 * 模型在一轮里反复 extract 同一页是常事——它会忘。不该为此反复付钱，也不该让上游
 * 反复限流我们。**命中不记 web_calls**：没打后端就没有这笔成本，记上去是虚报。
 *
 * 只在内存里，重启即空，多实例各存各的。这是刻意的：为一层 15 分钟的缓存引一个
 * 共享存储，运维成本比它省下的钱高。
 *
 * **键里带公司。** 「命中不计费」只在同一家公司里成立——付过钱的是它。不带的话，
 * B 公司搜 A 公司刚搜过的词会白拿结果：不记 web_calls、不落账，配额也数不到它。
 */
const cache = new Map<string, { at: number; value: unknown }>()

function cacheGet<T>(key: string): T | undefined {
  const hit = cache.get(key)
  if (!hit) return undefined
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key)
    return undefined
  }
  // 读一次挪到队尾——Map 保插入序，删了再插就是 LRU。
  cache.delete(key)
  cache.set(key, hit)
  return hit.value as T
}

/** 缓存按谁分。没有公司的账号（平台自己）按账号分，不和任何一家公司共用。 */
function cacheScope(account: Account): string {
  return account.companyId ? `co:${account.companyId}` : `acct:${account.id}`
}

function cachePut(key: string, value: unknown) {
  cache.delete(key)
  cache.set(key, { at: Date.now(), value })
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}


async function settingsOf(db: Db): Promise<{ web: WebToolsSettings }> {
  const s = await db.platformSettings()
  return { web: s.webTools ?? emptyWebTools() }
}

/**
 * 挑后端并把它要的东西配齐。**不做自动检测**：没配就是没配，说出来。
 *
 * 每一步失败都是 WebToolError——它们最终都会变成一句给模型看的话，而不是 500。
 * 模型看到「让管理员去配」才知道这条路这一轮走不通，看到 500 只会重试。
 */
export async function resolveBackend(db: Db, kind: WebCallKind): Promise<ResolvedBackend> {
  const { web } = await settingsOf(db)
  const id = kind === 'search' ? web.searchBackend : web.extractBackend
  if (!id) {
    throw new WebToolError(
      `no ${kind} backend`,
      `还没有配置网页${kind === 'search' ? '搜索' : '提取'}后端，让系统管理员去「工具配置 → 网页与搜索」配一个。`,
    )
  }
  const backend = backendOf(id)
  if (!backend) throw new WebToolError(`backend ${id} not implemented`, `后端 ${id} 还没接入，让系统管理员换一个。`)
  if (kind === 'search' && !backend.search) {
    throw new WebToolError(`${id} cannot search`, `当前搜索后端 ${id} 不支持搜索，让系统管理员换一个。`)
  }
  if (kind === 'extract' && !backend.extract) {
    throw new WebToolError(
      `${id} cannot extract`,
      `当前提取后端 ${id} 只支持搜索。让系统管理员在「工具配置 → 网页与搜索」里换一个支持提取的后端。`,
    )
  }
  const cfg: BackendConfig = { searxngUrl: web.searxngUrl }
  if (needsSecret(id)) {
    const cred = await db.platformCredential(id)
    if (!cred?.secret) {
      throw new WebToolError(`${id} no secret`, `还没有配置 ${id} 的密钥，让系统管理员去「工具配置 → 网页与搜索」配上。`)
    }
    cfg.secret = cred.secret
  }
  return { id, cfg }
}

/**
 * 计一次，落一行流水加一行账，返回这一次收了多少微元。
 *
 * 流水（`web_calls`）记事实：哪个后端、什么类型、抓成功几条。账本（`usage_charges`）
 * 记钱，靠 `refId` 串回来。报价在**写行那一刻定死**，之后不重算——搜索单价是人在配置
 * 屏里手填的，管理员一改，重算会把上个月的账单也改掉（docs/billing.md §2）。
 */
async function meterCall(
  db: Db,
  meter: Meter,
  account: Account,
  kind: WebCallKind,
  backend: string,
  units: number,
): Promise<number> {
  if (units <= 0) return 0
  const row = await db.insertWebCall({
    accountId: account.id,
    companyId: account.companyId,
    kind,
    backend,
    units,
  })
  const charge = await meter.charge({
    kind: 'web',
    account,
    status: 'ok',
    backend,
    webKind: kind,
    units,
    refId: row.id,
  })
  return charge.amountMicros
}

/**
 * 余额闸。撞上了是**业务失败**，不是 4xx——席位那头会把这句话原样交给模型。
 *
 * 和 checkQuota 并排但不是一回事：那道闸防的是跑飞（一个循环把额度打光），
 * 这道闸管的是钱。两道都要过。
 */
async function checkCredit(meter: Meter, account: Account, backends: string[], kind: WebCallKind): Promise<void> {
  const gate = await meter.gate(account, { kind: 'web', backends, webKind: kind })
  if (gate.ok) return
  // 被拒的也落一行（金额 0，units 0）——同 v1.ts 的 gateOr402。「为什么我的 Bot
  // 搜不了网页」得和「谁搜了」在同一张表上答；模型那条路早就这么做了，这条路以前漏了。
  await meter.charge(
    { kind: 'web', account, status: 'denied', backend: backends[0] ?? 'unknown', webKind: kind, units: 0 },
    { amountMicros: 0, unitPrice: {}, multiplier: 1, unpriced: false },
  )
  throw new WebToolError('no credit', gate.reason)
}

/**
 * 公司一天最多几次。0 = 不限。
 *
 * 按**自然日**数，用的是服务器时区——公司分布在哪个时区我们不知道，而这个闸的用途
 * 是防跑飞，不是精确到小时的计费，切错一小时没有后果。
 */
async function checkQuota(db: Db, companyId: string | null, web: WebToolsSettings): Promise<void> {
  const limit = web.dailyLimit ?? 0
  if (!limit || !companyId) return
  const since = new Date()
  since.setHours(0, 0, 0, 0)
  const used = await db.webCallCountSince(companyId, since.getTime())
  if (used >= limit) {
    throw new WebToolError(
      `quota ${used}/${limit}`,
      `今天这家公司的网页调用已经用满 ${limit} 次了，明天再试，或者让系统管理员调高上限。`,
    )
  }
}

export interface SearchArgs {
  query: string
  count?: number
  domains?: string[]
  exclude?: string[]
  freshness?: string
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map((x) => String(x ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean).slice(0, 10)
}

export function parseSearchArgs(raw: SearchArgs): SearchQuery {
  const query = String(raw.query ?? '').trim()
  if (!query) throw new WebToolError('empty query', 'query 不能为空。')
  if (query.length > 400) throw new WebToolError('query too long', '搜索词太长了，说重点就行。')
  const n = raw.count == null ? DEFAULT_SEARCH_COUNT : Number(raw.count)
  if (!Number.isFinite(n) || n < 1 || n > MAX_SEARCH_COUNT) {
    throw new WebToolError('bad count', `count 只能是 1 到 ${MAX_SEARCH_COUNT}。`)
  }
  const fresh = String(raw.freshness ?? '').trim()
  if (fresh && !['day', 'week', 'month', 'year'].includes(fresh)) {
    throw new WebToolError('bad freshness', 'freshness 只能是 day / week / month / year。')
  }
  return {
    query,
    count: Math.floor(n),
    domains: strList(raw.domains),
    exclude: strList(raw.exclude),
    freshness: (fresh || '') as SearchQuery['freshness'],
  }
}

export interface SearchResult {
  backend: string
  hits: SearchHit[]
  /** 这一次是缓存给的，没打后端，也没记账。 */
  cached?: boolean
  /** 结果是在我们这边滤过的（后端不原生支持那几个约束）。要报给模型。 */
  filtered: boolean
  elapsedMs: number
  /** 这一次收了多少微元。命中缓存是 0。 */
  amountMicros: number
}

export async function runSearch(db: Db, meter: Meter, account: Account, raw: SearchArgs): Promise<SearchResult> {
  const q = parseSearchArgs(raw)
  const { id, cfg } = await resolveBackend(db, 'search')
  const { web } = await settingsOf(db)
  await checkCredit(meter, account, [id], 'search')
  await checkQuota(db, account.companyId, web)
  const key = `search:${cacheScope(account)}:${id}:${JSON.stringify(q)}`
  const cached = cacheGet<SearchHit[]>(key)
  const started = Date.now()
  const hits = cached ?? (await backendOf(id)!.search!(q, cfg))
  if (!cached) cachePut(key, hits)
  const elapsedMs = Date.now() - started
  // Tavily 原生支持域名过滤，DuckDuckGo 不支持——不支持的在这里补上，
  // 并把「滤过」这件事报出去。悄悄忽略模型给的约束比不支持更糟。
  const post = id === 'tavily' ? { hits, filtered: false } : applyFilters(hits, q)
  // 命中缓存不记账：这一次没打后端，也就没有这笔成本。
  const amountMicros = cached ? 0 : await meterCall(db, meter, account, 'search', id, 1)
  return { backend: id, hits: post.hits.slice(0, q.count), filtered: post.filtered, elapsedMs, amountMicros, cached: Boolean(cached) }
}

export interface ExtractedPage {
  url: string
  ok: boolean
  title?: string
  markdown?: string
  contentType?: string
  chars?: number
  error?: string
  /**
   * PDF / Word / Excel：给字节，不给正文。
   * 席位那边落盘后交给 workspace/extract.ts——那套逻辑已经处理过扫描件、表格这些坑。
   */
  document?: { contentType: string; ext: string; base64: string; bytes: number }
}

export interface ExtractResult {
  backend: string
  pages: ExtractedPage[]
  elapsedMs: number
  /** 这一次一共收了多少微元。命中缓存和抓失败的那几条不算在内。 */
  amountMicros: number
}

/** e2e 里不打网络，文档那一步换成假的；生产走真的 fetchDocument。 */
const fetchDoc = process.env.E2E_STUB_WEB === '1' ? async (url: string) => stubFetchDocument(url) : fetchDocument

/** 文档的标题只能从地址里取——PDF 里的元数据不一定有，也不一定对。 */
function docTitle(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || url)
  } catch {
    return url
  }
}

/**
 * 交给提取后端之前先过一遍 SSRF 闸（协议 + 解析出的 IP）。
 *
 * 地址是模型给的，而提取后端**替我们去打它**：自托管的 Firecrawl（FIRECRAWL_API_URL
 * 指 localhost:3002 那种）就在我们的内网里，不设闸的话模型给一个
 * `http://169.254.169.254/latest/meta-data/` 或 `http://10.0.0.5:5432/`，它照打不误，
 * 我们自己那道闸等于被绕开。托管的 Tavily/Firecrawl 打不到我们的内网，但一样没理由
 * 替模型去探别人的内网段。
 *
 * **这道闸关不死 DNS rebinding。** 我们判的是「此刻解析出来的 IP」，后端连的时候会自己
 * 再解析一次——TTL 0 的权威 DNS 可以先答公网、再答内网。自己打的那条路（safeFetch）
 * 靠 pinnedLookup 把 IP 钉在 socket 上补上了这个缝，第三方后端的解析我们够不着。
 * 所以自托管 Firecrawl 本身仍然要在网络层隔离（出口不许访问内网与 metadata 地址），
 * 这里只挡住直给内网地址和解析到内网的域名这两种最直接的打法。
 *
 * e2e 用假后端时，`.test` 结尾的域名（RFC 6761 保留，现实里永远解析不了）只查协议——
 * 那几条用例要验的是计量计价，不是 DNS。直给的 IP 与别的域名照常全套过闸。
 */
async function guardExtractUrl(url: string): Promise<void> {
  if (process.env.E2E_STUB_WEB === '1') {
    try {
      const u = new URL(url)
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.endsWith('.test')) return
    } catch {
      // 坏地址交给 guardUrl 去报。
    }
  }
  await guardUrl(url)
}

export function parseExtractUrls(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  // **先去重再数**。同一个地址写两遍在模型那儿并不罕见（尤其是从搜索结果里拉列表的
  // 时候），而两条一样的 URL 会并发绕过缓存——第一条还没回来写缓存，第二条已经出去了。
  // 结果是同一个页面抓两次、收两份钱。顺带让「最多 5 个」数的是五个**不同**的页面。
  const urls = [...new Set(list.map((x) => String(x ?? '').trim()).filter(Boolean))]
  if (!urls.length) throw new WebToolError('no urls', 'urls 不能为空。')
  if (urls.length > MAX_EXTRACT_URLS) {
    throw new WebToolError('too many urls', `一次最多 ${MAX_EXTRACT_URLS} 个不同的地址，你给了 ${urls.length} 个。`)
  }
  return urls
}

export async function runExtract(db: Db, meter: Meter, account: Account, rawUrls: unknown): Promise<ExtractResult> {
  const urls = parseExtractUrls(rawUrls)
  const { id, cfg } = await resolveBackend(db, 'extract')
  const { web } = await settingsOf(db)
  // 带上 WEB_DOCUMENT：这一次里的 PDF / Word / Excel 记在它头上，不是提取后端头上。
  await checkCredit(meter, account, [id, WEB_DOCUMENT], 'extract')
  await checkQuota(db, account.companyId, web)
  const backend = backendOf(id)!
  const started = Date.now()
  // 逐个抓，互不牵连：**部分失败不是失败**，调用方自己判断够不够用。
  //
  // 每条自己报 `billable`，不靠外面数计数器倒推。倒推那版栽在「后缀骗人」这条路上：
  // 一个 .pdf 结尾却返回 HTML 的地址会把计数器加两次，于是缓存命中数被算成负的，
  // 一条 URL 收两份钱，连同一次调用里真正命中缓存的那几条也一起收了。
  const done = await Promise.all(
    urls.map(async (url): Promise<{ page: ExtractedPage; billable: string | null }> => {
      const key = `extract:${cacheScope(account)}:${id}:${url}`
      try {
        // 先过闸，再谈缓存和后端。见 guardExtractUrl。
        await guardExtractUrl(url)
        const hit = cacheGet<ExtractedPage>(key)
        // 命中缓存这一次没打后端，也就没有这笔成本。
        if (hit) return { page: hit, billable: null }
        // 看着像文档就自己取字节：提取后端对着一份 PDF 要么给空、要么给乱码。
        if (looksLikeDocument(url)) {
          const doc = await fetchDoc(url)
          if (doc) {
            // 文档不进缓存：base64 一份就有好几 MB，64 条能把进程撑爆。
            // **记在 document 头上，不记在提取后端头上**：这一趟是我们自己下的文件，
            // 提取后端一次都没被调用。记错了，统计里「按后端」那张表就在撒谎。
            return {
              page: { url, ok: true, title: docTitle(url), contentType: doc.contentType, document: doc },
              billable: WEB_DOCUMENT,
            }
          }
          // 后缀骗人（.pdf 结尾其实是 HTML），落回正常那条路——这一趟只读了响应头，
          // 后端那次才是要付钱的那次，所以这里不额外计一笔。
        }
        const got: Extracted = await backend.extract!(url, cfg)
        const page: ExtractedPage = {
          url,
          ok: true,
          title: got.title,
          markdown: got.markdown,
          contentType: got.contentType,
          chars: got.markdown.length,
        }
        cachePut(key, page)
        return { page, billable: id }
      } catch (e) {
        // 失败不进缓存：下一次多半是另一个结果，缓存一条 404 只会把它钉死 15 分钟。
        // 也不计费：没抓着的那条没花后端的钱。
        return {
          page: { url, ok: false, error: e instanceof WebToolError ? e.hint : (e as Error).message },
          billable: null,
        }
      }
    }),
  )
  const pages = done.map((d) => d.page)
  const elapsedMs = Date.now() - started
  // 一次调用里网页和文档可能各占几条，两者单价不同，所以按各自的名义分开落账。
  const byBackend = new Map<string, number>()
  for (const d of done) {
    if (d.billable) byBackend.set(d.billable, (byBackend.get(d.billable) ?? 0) + 1)
  }
  let amountMicros = 0
  for (const [name, units] of byBackend) amountMicros += await meterCall(db, meter, account, 'extract', name, units)
  return { backend: id, pages, elapsedMs, amountMicros }
}

/**
 * 配置屏上的自检。**不记 web_calls**——这是管理员在验配置，不是公司在用。
 */
export async function testBackend(db: Db, kind: WebCallKind): Promise<{ backend: string; elapsedMs: number; count: number }> {
  const { id, cfg } = await resolveBackend(db, kind)
  const started = Date.now()
  if (kind === 'search') {
    const hits = await backendOf(id)!.search!(
      { query: 'satuwork web search self test', count: 3, domains: [], exclude: [], freshness: '' },
      cfg,
    )
    return { backend: id, elapsedMs: Date.now() - started, count: hits.length }
  }
  const got = await backendOf(id)!.extract!('https://example.com/', cfg)
  return { backend: id, elapsedMs: Date.now() - started, count: got.markdown.length }
}
