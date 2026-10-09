/**
 * 自动发现新模型。
 *
 * pi-ai 的内置目录是**编译进包的静态快照**（`models.generated.ts`）：40 个 provider
 * 里只有 radius 一个实现了 `refreshModels()`，opencode 和其余 38 个都不会自己更新。
 * 所以上游（比如 opencode zen）上了新模型，得等 pi 发版、我们再升依赖才看得见——
 * 这一趟少说几周，中间那些模型在我们这儿根本不存在。
 *
 * 这里把 pi 生成目录时用的**同一个数据源**（models.dev）在运行时拉一遍，把内置快照
 * 里没有的模型补进注册表。补法有三条硬规矩：
 *
 * 1. **只加不改。** 内置目录里已经有的 id 一律不碰。pi 的生成脚本里有几十处按模型
 *    手调的 compat（thinkingFormat、maxTokensField、supportsReasoningEffort、
 *    上下文窗口纠正……），那些是 pi 实测出来的，比 models.dev 的原始元数据准。
 * 2. **baseUrl 和 compat 从兄弟模型上抄**，不自己拼。同一个 provider 下、同一个 api
 *    的内置模型怎么调，新模型就怎么调。抄不到兄弟就跳过——宁可少一个模型，也不要
 *    往目录里塞一个地址是猜的、调用必然失败的条目。
 * 3. **能被屏蔽。** pi 会故意排除某些通过了通用过滤的模型（generate-models.ts 里的
 *    xAI 排除表、opencode 的 gpt-5.3-codex-spark），理由没写在代码里，多半是实测调不通。
 *    我们这边没有那份实测知识，所以留一张 denylist 让人把发现错的按下去。
 */
import type { Api, Model, Provider } from '@earendil-works/pi-ai'
import { type ModelRate, parseModelRate } from './db/types.ts'

/** pi 的 `scripts/generate-models.ts` 读的就是这个地址。 */
export const MODELS_DEV_URL = 'https://models.dev/api.json'

/** 拉目录的超时。这是后台刷新，慢一点没关系，但不能挂着不回。 */
export const FETCH_TIMEOUT_MS = 30_000

/**
 * models.dev 那份 api.json 有 4MB 出头，而我们只用得上十来个字段。存库前先压成
 * 这个形状：一来 jsonb 那一行不会失控，二来重启后能拿它**重新推导**一遍，而不是
 * 把当时推导出来的结果冻在库里（见 resolveOverlay 的注释）。
 */
export interface DiscoveredEntry {
  provider: string
  id: string
  name: string
  /** models.dev 的 `provider.npm`，决定这个模型走哪套 API 协议。 */
  npm?: string
  reasoning: boolean
  image: boolean
  contextWindow: number
  maxTokens: number
  /**
   * 四项单价，外加可选的长上下文档位（和 pi-ai 目录的 `cost.tiers` 同形）。models.dev 的
   * `tiers[]` 里 `tier.type === 'context'` 的那几条就是：过了 `tier.size` 整次按那一档收。
   * 不带上它，自动发现的模型（gpt-6.1-sol 这一批上线时 pi-ai 还没收录）过了 272k 就按
   * 半价记账——那正是 10 月对账时少掉的那三成。
   */
  cost: DiscoveredCost
}

/** 和账本那边同一个形状、同一个解析器（db/types.ts 的 parseModelRate）。 */
export type DiscoveredCost = ModelRate

export interface DiscoverySnapshot {
  /** 上一次成功拉到数据的时刻。拉失败不动它——失败不该让旧快照看起来更新了。 */
  fetchedAt: number
  entries: DiscoveredEntry[]
  /** `provider/id`。被按下去的模型不进目录。 */
  deny: string[]
  /** 上一次尝试刷新的时刻，成功失败都记。节流看的是它，否则一直失败就会一直重试。 */
  attemptedAt?: number
  lastError?: string
}

export function emptySnapshot(): DiscoverySnapshot {
  return { fetchedAt: 0, entries: [], deny: [] }
}

function posInt(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
}

/**
 * 库里读出来的快照要重新体检一遍，不能直接信。
 *
 * 这一行是后台任务写的，而写它的进程可能是**另一个版本的网关**——滚动升级的那几
 * 分钟里，新老进程共用同一个库。老版本写下的形状少字段、多字段都有可能，直接
 * 铺开用就会在 catalog() 那条热路径上抛。
 */
export function parseDiscoverySnapshot(raw: unknown): DiscoverySnapshot {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const entries: DiscoveredEntry[] = []
  for (const item of Array.isArray(o.entries) ? o.entries : []) {
    if (!item || typeof item !== 'object') continue
    const e = item as Record<string, any>
    const provider = typeof e.provider === 'string' ? e.provider : ''
    const id = typeof e.id === 'string' ? e.id : ''
    if (!provider || !usableModelId(id)) continue
    entries.push({
      provider,
      id,
      name: typeof e.name === 'string' && e.name ? e.name : id,
      npm: typeof e.npm === 'string' ? e.npm : undefined,
      reasoning: e.reasoning === true,
      image: e.image === true,
      contextWindow: numOr(e.contextWindow, 4096),
      maxTokens: numOr(e.maxTokens, 4096),
      cost: parseModelRate(e.cost),
    })
  }
  const deny = (Array.isArray(o.deny) ? o.deny : [])
    .filter((x): x is string => typeof x === 'string' && !!x.trim())
    .map((x) => x.trim())
  const snap: DiscoverySnapshot = { fetchedAt: posInt(o.fetchedAt), entries, deny: [...new Set(deny)] }
  const attemptedAt = posInt(o.attemptedAt)
  if (attemptedAt) snap.attemptedAt = attemptedAt
  if (typeof o.lastError === 'string' && o.lastError) snap.lastError = o.lastError.slice(0, 500)
  return snap
}

/**
 * models.dev 的 `provider.npm` → pi 的 api。抄自 pi 生成脚本里 opencode 那一段的
 * 映射表，它对别的 provider 也成立，因为 npm 字段本来就是「这家用哪个 SDK 调」。
 *
 * 认不出来的一律当 openai-completions：models.dev 上没有 npm 或者写
 * `@ai-sdk/openai-compatible` 的，就是标准的 /v1/chat/completions。
 */
const NPM_TO_API: Record<string, Api> = {
  '@ai-sdk/openai': 'openai-responses',
  '@ai-sdk/anthropic': 'anthropic-messages',
  '@ai-sdk/google': 'google-generative-ai',
}

const DEFAULT_API: Api = 'openai-completions'

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback
}

/**
 * 模型 id 的体检。
 *
 * **比 providers.ts 的 MODEL_ID_RE 松**，而且必须松：内置目录里就有 48 个 id 过不了
 * 那条正则（cloudflare 的 `workers-ai/@cf/meta/llama-...`、vertex 的
 * `claude-opus-4-5@20251101`），把它们判死等于把整个 provider 的新模型全丢掉。
 *
 * 那条严正则守的是**另一件事**：库里存的自定义定义，provider 字段会被拼成
 * `<PROVIDER>_API_KEY` 去索引 process.env，形状不对就能骗网关拿错密钥。这里的
 * provider 来自注册表本身，不是外部输入，那条风险不存在。
 *
 * 这里只需要保证两件事：不带空白或控制字符（会毁掉 URL 和日志），以及拼成
 * `provider/id` 之后 parseModelRef 能原样切回来——provider 本身不含斜杠，所以
 * 只要 id 不以斜杠开头就成立。
 */
export function usableModelId(id: string): boolean {
  if (!id || id.length > 128) return false
  if (id.startsWith('/')) return false
  return !/[\s\u0000-\u001f\u007f]/.test(id)
}

/**
 * 把 models.dev 的整包解析成我们要的条目。
 *
 * 过滤条件和 pi 的生成脚本一字不差：能调工具、且没被标记废弃。放宽任何一条，目录
 * 里就会出现「点得到但用不了」的模型——这正是自定义目录以前踩过的坑。
 */
export function parseModelsDev(raw: unknown): DiscoveredEntry[] {
  const out: DiscoveredEntry[] = []
  if (!raw || typeof raw !== 'object') return out
  for (const [providerId, rawProvider] of Object.entries(raw as Record<string, unknown>)) {
    if (!rawProvider || typeof rawProvider !== 'object') continue
    const models = (rawProvider as { models?: unknown }).models
    if (!models || typeof models !== 'object') continue
    for (const [modelId, rawModel] of Object.entries(models as Record<string, unknown>)) {
      if (!rawModel || typeof rawModel !== 'object') continue
      const m = rawModel as Record<string, any>
      if (m.tool_call !== true) continue
      if (m.status === 'deprecated') continue
      if (!usableModelId(modelId)) continue
      out.push({
        provider: providerId,
        id: modelId,
        name: typeof m.name === 'string' && m.name ? m.name : modelId,
        npm: typeof m.provider?.npm === 'string' ? m.provider.npm : undefined,
        reasoning: m.reasoning === true,
        image: Array.isArray(m.modalities?.input) && m.modalities.input.includes('image'),
        contextWindow: numOr(m.limit?.context, 4096),
        maxTokens: numOr(m.limit?.output, 4096),
        cost: parseModelRate(modelsDevCost(m.cost)),
      })
    }
  }
  return out
}

/**
 * models.dev 的 cost 翻成目录的形状，解析交给 parseModelRate：键是蛇形（cache_read），档位
 * 的门槛裹在 `tier: { type, size }` 里。只认 `type === 'context'` 的档——别的类型（比如按
 * 批量）不是按输入量切的，门槛给 0 让解析器丢掉它。
 */
function modelsDevCost(raw: any): unknown {
  if (!raw || typeof raw !== 'object') return undefined
  const tiers = Array.isArray(raw.tiers)
    ? raw.tiers.map((t: any) => ({
        inputTokensAbove: t?.tier?.type === 'context' ? t.tier.size : 0,
        input: t?.input,
        output: t?.output,
        cacheRead: t?.cache_read,
        cacheWrite: t?.cache_write,
      }))
    : undefined
  return { input: raw.input, output: raw.output, cacheRead: raw.cache_read, cacheWrite: raw.cache_write, tiers }
}

export async function fetchModelsDev(signal?: AbortSignal): Promise<DiscoveredEntry[]> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const res = await fetch(MODELS_DEV_URL, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`models.dev 返回 ${res.status}`)
  const entries = parseModelsDev(await res.json())
  // 空目录几乎肯定是对面出了问题（改了结构、挂了 CDN 兜底页）。当成失败，别拿它
  // 去覆盖库里那份还能用的快照。
  if (!entries.length) throw new Error('models.dev 没给出任何可用模型，当作失败处理')
  return entries
}

/**
 * 两次拉取之间至少隔多久。默认 6 小时。
 *
 * models.dev 是别人家的免费公共服务，我们没有理由按分钟去敲它；而上游上新模型
 * 这件事本来也是天为单位的。设 0 关掉自动刷新（手动那条路不受影响）。
 */
export const REFRESH_MS = (() => {
  const raw = process.env.GATEWAY_MODEL_DISCOVERY_MS
  if (raw === undefined || raw.trim() === '') return 6 * 60 * 60 * 1000
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 6 * 60 * 60 * 1000
})()

/** 拉失败之后的重试间隔。比正常节奏短，但也不至于一直捶对面。 */
const RETRY_MS = 15 * 60 * 1000

export interface RefreshDeps {
  discoveredModels(): Promise<DiscoverySnapshot>
  putDiscoveredModels(next: DiscoverySnapshot): Promise<DiscoverySnapshot>
}

export interface RefreshOutcome {
  ran: boolean
  added?: number
  error?: string
}

/**
 * 拉一次 models.dev 并落库。定时任务和管理页的「立即刷新」走的是同一个函数。
 *
 * `force` 跳过节流，别的都一样。**不抛异常**：它挂在共用的那个 tick 上（见
 * routines.ts），一次网络抖动不该把同一轮里的看板派卡和转人工催办一起带走。
 */
export async function refreshDiscovered(db: RefreshDeps, opts: { force?: boolean; now?: number; signal?: AbortSignal } = {}): Promise<RefreshOutcome> {
  const now = opts.now ?? Date.now()
  if (!opts.force && !REFRESH_MS) return { ran: false }
  const snap = await db.discoveredModels().catch(() => emptySnapshot())
  if (!opts.force) {
    // 节流看 attemptedAt 而不是 fetchedAt：一直失败时 fetchedAt 不动，只看它的话
    // 会变成每个 tick 都重试一次。
    const since = now - (snap.attemptedAt ?? snap.fetchedAt ?? 0)
    const wait = snap.lastError ? Math.min(RETRY_MS, REFRESH_MS) : REFRESH_MS
    if (since < wait) return { ran: false }
  }
  try {
    const entries = await fetchModelsDev(opts.signal)
    await db.putDiscoveredModels({ fetchedAt: now, attemptedAt: now, entries, deny: snap.deny })
    return { ran: true, added: entries.length }
  } catch (e) {
    const error = (e as Error).message || '拉取失败'
    // 只更新尝试时间和错误，**保留旧的 entries**：对面挂了不该让目录跟着缩水。
    await db.putDiscoveredModels({ ...snap, attemptedAt: now, lastError: error }).catch(() => {})
    return { ran: true, error }
  }
}

export interface OverlayResult {
  /** provider id → 要补进去的模型。只含真的有东西可补的 provider。 */
  extras: Map<string, Model<Api>[]>
  /** 认得出是新模型、但没有同 api 的兄弟可抄，只能放弃的。 */
  skipped: { provider: string; id: string; api: Api }[]
}

/**
 * 推导要补哪些模型。
 *
 * `baseline` 必须是**没套过壳的原件**。传当前注册表会错得很隐蔽：注册表里那些
 * provider 已经被 overlayProvider 套过，getModels() 返回的是「内置 + 上一轮补的」，
 * 于是上一轮补进去的模型这一轮全被当成「内置已有」而过滤掉，extras 变空，壳被整个
 * 撤掉——目录会在补上和撤掉之间来回跳，每同步一次翻一次面。
 *
 * **每次都重新推导，不存推导结果**：pi 升级之后，原先要补的模型可能已经内置了
 * （这时它自动从 extras 里消失，pi 调过的那份定义接管），或者 pi 改了某个
 * provider 的 baseUrl（这时新模型跟着一起改）。把结果冻在库里就拿不到这两件好处。
 */
export function resolveOverlay(baseline: Iterable<Provider>, entries: readonly DiscoveredEntry[], deny: ReadonlySet<string>): OverlayResult {
  const extras = new Map<string, Model<Api>[]>()
  const skipped: OverlayResult['skipped'] = []

  const providers = new Map<string, Provider>()
  for (const p of baseline) providers.set(p.id, p)

  const byProvider = new Map<string, DiscoveredEntry[]>()
  for (const e of entries) {
    const list = byProvider.get(e.provider)
    if (list) list.push(e)
    else byProvider.set(e.provider, [e])
  }

  for (const [providerId, list] of byProvider) {
    const provider = providers.get(providerId)
    // models.dev 收录了一堆 pi 没有对应 provider 的厂商。没有 provider 就没有
    // auth、没有 stream 实现，补进来也调不动。
    if (!provider) continue
    const builtin = provider.getModels()
    if (!builtin.length) continue

    const have = new Set(builtin.map((m) => m.id))
    // 同一个 api 下取第一个内置模型当样板。同 provider 同 api 的模型，baseUrl 和
    // 那套 compat 开关本来就是一样的——pi 的生成脚本也是先按 provider+api 铺一层
    // 默认值，再往个别模型上打补丁。我们抄到的就是那层默认值。
    const sample = new Map<Api, Model<Api>>()
    for (const m of builtin) if (!sample.has(m.api)) sample.set(m.api, m)
    const onlyApi = sample.size === 1 ? [...sample.keys()][0] : undefined

    const add: Model<Api>[] = []
    for (const e of list) {
      if (have.has(e.id)) continue
      if (deny.has(`${providerId}/${e.id}`)) continue
      const want = (e.npm && NPM_TO_API[e.npm]) || DEFAULT_API
      // 这家只有一套 api 时，npm 字段说什么都不重要：那套就是唯一能调通的路。
      const sib = sample.get(want) ?? (onlyApi ? sample.get(onlyApi) : undefined)
      if (!sib) {
        skipped.push({ provider: providerId, id: e.id, api: want })
        continue
      }
      add.push({
        id: e.id,
        name: e.name,
        api: sib.api,
        provider: sib.provider,
        baseUrl: sib.baseUrl,
        reasoning: e.reasoning,
        input: e.image ? ['text', 'image'] : ['text'],
        cost: e.cost,
        contextWindow: e.contextWindow,
        maxTokens: e.maxTokens,
        ...(sib.headers ? { headers: sib.headers } : {}),
        ...(sib.compat ? { compat: sib.compat } : {}),
        // thinkingLevelMap 故意不抄：它是**按模型**测出来的映射，抄邻居等于拿
        // 一个模型的思考档位去套另一个。留空走 provider 默认，最多是档位少几档，
        // 不会变成往上游发一个它不认的值。
      } as Model<Api>)
    }
    if (add.length) extras.set(providerId, add)
  }

  return { extras, skipped }
}

/**
 * 给 provider 套一层壳，只把模型列表加长，别的全部原样转发。
 *
 * **不重建 provider**：auth 怎么解析、stream 怎么分发、api map 长什么样，都锁在
 * pi 的工厂函数里，Provider 接口上根本读不到。想用 createProvider 重造一个，那几样
 * 只能靠猜。套壳则完全不碰它们——补进来的模型带着 `api` 字段进 base.stream()，
 * base 照样按 model.api 去它自己的 api map 里分发，跟内置模型走的是同一条路。
 */
export function overlayProvider(base: Provider, extra: readonly Model<Api>[]): Provider {
  if (!extra.length) return base
  const wrapped: Provider = {
    get id() {
      return base.id
    },
    get name() {
      return base.name
    },
    get baseUrl() {
      return base.baseUrl
    },
    get headers() {
      return base.headers
    },
    get auth() {
      return base.auth
    },
    getModels: () => {
      const own = base.getModels()
      // base 自己的列表随时可能变（动态 provider 刷新过），所以每次都重新去重，
      // 不缓存合并结果。pi 真发布了某个模型时，内置的那份要赢。
      const have = new Set(own.map((m) => m.id))
      return [...own, ...extra.filter((m) => !have.has(m.id))]
    },
    stream: (model, context, options) => base.stream(model as never, context, options as never),
    streamSimple: (model, context, options) => base.streamSimple(model, context, options),
  }
  // 这几个是可选实现。base 没有就不能凭空造一个出来，否则 pi 那边
  // 「provider 支不支持 deferred」的判断会被我们说谎骗过去。
  if (base.refreshModels) wrapped.refreshModels = (ctx) => base.refreshModels!(ctx)
  if (base.filterModels) wrapped.filterModels = (list, cred) => base.filterModels!(list, cred)
  if (base.fetchDeferred) wrapped.fetchDeferred = (model, handle, options) => base.fetchDeferred!(model, handle, options)
  if (base.cancelDeferred) wrapped.cancelDeferred = (model, handle, options) => base.cancelDeferred!(model, handle, options)
  return wrapped
}
