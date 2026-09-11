import { getSupportedThinkingLevels, type Provider } from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import type { Db } from './db.ts'
import { overlayProvider, resolveOverlay, type DiscoverySnapshot } from './model-discovery.ts'
import { buildProvider, customEnvVar, isModelId, parseProviderDef, PROVIDER_ID_RE, type CustomProviderDef } from './providers.ts'

export interface CatalogModel {
  provider: string
  id: string
  name: string
  api?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  reasoningLevels?: string[]
  input?: ('text' | 'image')[]
  cost?: unknown
  source: 'builtin' | 'company' | 'custom' | 'discovered'
}

export interface ModelRef {
  provider: string
  id: string
}

export interface ProbeResult {
  ok: boolean
  provider: string
  model: string
  latencyMs: number
  excerpt?: string
  error?: string
}

/** 连通性测试的上限。上游卡住时页面上那颗按钮不能一直转。 */
const PROBE_TIMEOUT_MS = 20_000

/** 调用方没带 `anthropic-version` 时补的那一个。/v1/messages 和管家授权共用。 */
export const ANTHROPIC_VERSION = '2023-06-01'

/** 管家中继要打的上游。`headers` 里带着供应商密钥，只能进内存，不能落日志。 */
export interface UpstreamTarget {
  url: string
  headers: Record<string, string>
  model: string
}

/**
 * 内置 openai / anthropic 的上游主机覆盖。给 e2e 指到 stub、或者走企业代理用。
 * 值是**主机**（不含 `/v1`），/v1 的透传路由和 upstreamTargetOf 各自往后拼路径。
 */
export function openaiBase(): string {
  return (process.env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/$/, '')
}
export function anthropicBase(): string {
  return (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '')
}

export function openaiModelId(m: { provider: string; id: string }): string {
  return `${m.provider}/${m.id}`
}

/** 常见 provider 的环境变量名。只在 Gateway 进程里读，绝不下发。 */
export function envSecret(provider: string): string | undefined {
  const aliases: Record<string, string[]> = {
    deepseek: ['DEEPSEEK_API_KEY'],
    openai: ['OPENAI_API_KEY'],
    anthropic: ['ANTHROPIC_API_KEY'],
    google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    groq: ['GROQ_API_KEY'],
    openrouter: ['OPENROUTER_API_KEY'],
    xai: ['XAI_API_KEY'],
    mistral: ['MISTRAL_API_KEY'],
  }
  const keys = aliases[provider] ?? [
    `${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`,
    // 自定义供应商用带前缀的名字，免得撞上机器上别的同名变量。
    customEnvVar(provider),
  ]
  for (const k of keys) {
    const v = process.env[k]?.trim()
    if (v) return v
  }
}

export function parseModelRef(raw: string, hint?: string): ModelRef {
  const s = String(raw || '').trim()
  if (!s) return { provider: hint || '', id: '' }
  const slash = s.indexOf('/')
  if (slash > 0) return { provider: s.slice(0, slash), id: s.slice(slash + 1) }
  return { provider: hint || '', id: s }
}

/**
 * Gateway 上的模型目录与密钥解析。pi-ai 只活在这里。
 *
 * 可见集 = pi-ai 内置全局目录 ∪ 该公司 catalog 里的 model。
 * 若平台 enabledModels 非空，再按 openai id（provider/id）过滤。
 * 密钥：公司表 > 平台表 > 进程环境变量（见 secret）。永远不回显。
 */
export class Llm {
  readonly models = builtinModels()
  /** 内置 provider 的 id。自定义的绝不能顶掉它们，同步时也不能把它们删了。 */
  private readonly builtinIds = new Set(builtinModels().getProviders().map((p) => p.id))
  private registered = new Set<string>()
  private fingerprint = ''

  /**
   * 内置 provider 的原件。套壳前先留一份，因为补模型是 `setProvider(套壳后的)`——
   * 不留原件的话，第二次同步就会拿**上一层壳**再套一层，壳叠壳，上一轮补进去的
   * 模型也会跟着漏到下一轮，撤不掉。
   */
  private readonly originals = new Map<string, Provider>()
  /** 当前被套了壳的 provider。发现结果变空时要按这个名单还原。 */
  private overlaid = new Set<string>()
  private discoveryFingerprint = ''
  /** `provider/id`，catalog() 拿它给这些模型打「自动发现」的标。 */
  private discoveredKeys = new Set<string>()

  constructor(private db: Db) {
    for (const p of this.models.getProviders()) this.originals.set(p.id, p)
  }

  isBuiltinProvider(id: string): boolean {
    return this.builtinIds.has(id)
  }

  /**
   * 公司目录里的一条 model 能不能进目录。**路由写入前和 catalog() 合并时各问一次**——
   * 写入那道挡人，合并那道挡库里已经躺着的老条目和别的进程写进来的。
   *
   * 三条规矩：provider 得是平台注册表里有的（密钥是按 provider 名去索引 process.env
   * 的，一条 `{"provider":"stripe"}` 就能让网关拿 STRIPE_API_KEY 去打模型接口；注册表
   * 这一关就把它挡掉了。**不要求平台已经配好密钥**：没密钥的模型照样进目录，调用时
   * 回 402「没配密钥」，这是 /v1 一直以来的口径）；模型得在 enabledModels 白名单里，
   * 白名单为空时得是平台目录 / 自动发现里真有的；`cost` 一律不认（单价由平台定，
   * 公司条目自带一份就是自己给自己定价）。
   *
   * 调用前要先 syncCustomProviders + syncDiscovered，注册表才是新的。
   */
  async companyModelAllowed(
    provider: string,
    id: string,
    enabled?: unknown,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!PROVIDER_ID_RE.test(provider) || !isModelId(id)) return { ok: false, reason: 'provider 或模型 id 形状不对' }
    if (!this.models.getProviders().some((p) => p.id === provider)) return { ok: false, reason: `平台没有 ${provider} 这个供应商` }
    const list = enabled === undefined ? (await this.db.platformSettings()).enabledModels : enabled
    const key = `${provider}/${id}`
    if (Array.isArray(list) && list.length) {
      if (!list.includes(key)) return { ok: false, reason: `${key} 不在平台启用的模型名单里` }
    } else if (!this.models.getModel(provider, id)) {
      return { ok: false, reason: `平台目录里没有 ${key}` }
    }
    return { ok: true }
  }

  builtinProviderIds(): ReadonlySet<string> {
    return this.builtinIds
  }

  /**
   * 把库里的自定义供应商灌进 pi-ai 的注册表。
   *
   * 每次要用目录之前都走一遍：定义存在库里，可能是别的进程改的，光靠进程内的
   * 事件通知会漏。变了才重建——指纹一样就直接返回，热路径上不做无谓的工作。
   */
  async syncCustomProviders(): Promise<CustomProviderDef[]> {
    const defs: CustomProviderDef[] = []
    for (const item of await this.db.visibleCatalog('provider', null)) {
      try {
        const def = parseProviderDef(item.definition)
        // 撞上内置 id 就跳过：顶掉 openai 会让所有公司的模型一起哑掉。
        if (this.builtinIds.has(def.id)) continue
        defs.push(def)
      } catch {
        // 库里存着一条坏定义，不该让整个目录跟着塌。跳过它。
      }
    }
    const fp = JSON.stringify(defs)
    if (fp === this.fingerprint) return defs
    const next = new Set(defs.map((d) => d.id))
    for (const id of this.registered) {
      if (!next.has(id) && !this.builtinIds.has(id)) this.models.deleteProvider(id)
    }
    for (const def of defs) this.models.setProvider(buildProvider(def))
    this.registered = next
    this.fingerprint = fp
    return defs
  }

  /**
   * 把库里那份「自动发现」的快照铺到注册表上（见 model-discovery.ts）。
   *
   * 和 syncCustomProviders 一样每次都读库、按指纹决定要不要重建：写这一行的是
   * 后台刷新任务，多进程部署时它可能跑在**另一个网关进程**里，只靠进程内的通知
   * 一定会漏。
   */
  async syncDiscovered(): Promise<number> {
    let snap: DiscoverySnapshot
    try {
      snap = await this.db.discoveredModels()
    } catch {
      // 读不到就当没有。自动发现是锦上添花，不能因为它让整个目录塌掉。
      return this.discoveredKeys.size
    }
    // 指纹里要带上自定义供应商的那一份：它们也会改变注册表，而推导是拿注册表当
    // 输入的。只按快照做指纹的话，新加一个自定义供应商之后就不会重新推导。
    const fp = `${snap.fetchedAt}|${snap.entries.length}|${snap.deny.join(',')}|${this.fingerprint}`
    if (fp === this.discoveryFingerprint) return this.discoveredKeys.size

    // 传 originals 而不是 this.models：只往内置 provider 上补（自定义供应商的模型
    // 是人手录进去的，那份定义就是权威），而且基线必须是没套过壳的——理由见
    // resolveOverlay 的注释，那是个会让目录来回跳的坑。
    const { extras } = resolveOverlay(this.originals.values(), snap.entries, new Set(snap.deny))
    const keys = new Set<string>()
    for (const [providerId, add] of extras) {
      const base = this.originals.get(providerId)!
      this.models.setProvider(overlayProvider(base, add))
      for (const m of add) keys.add(`${providerId}/${m.id}`)
    }
    for (const id of this.overlaid) {
      if (extras.has(id)) continue
      const base = this.originals.get(id)
      if (base) this.models.setProvider(base)
    }
    this.overlaid = new Set(extras.keys())
    this.discoveredKeys = keys
    this.discoveryFingerprint = fp
    return keys.size
  }

  async catalog(companyId: string | null): Promise<CatalogModel[]> {
    const custom = new Set((await this.syncCustomProviders()).map((d) => d.id))
    // 必须排在 syncCustomProviders 后面：发现结果的指纹里带着自定义供应商那一份，
    // 反过来的话这一轮读到的是上一轮的旧指纹，注册表已经变了却不会重新推导。
    await this.syncDiscovered()
    const discovered = this.discoveredKeys
    const out: CatalogModel[] = []
    const seen = new Set<string>()
    for (const p of this.models.getProviders()) {
      for (const m of this.models.getModels(p.id) ?? []) {
        const key = `${p.id}/${m.id}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({
          provider: p.id,
          id: m.id,
          name: (m as { name?: string }).name ?? m.id,
          api: (m as { api?: string }).api,
          contextWindow: (m as { contextWindow?: number }).contextWindow,
          maxTokens: (m as { maxTokens?: number }).maxTokens,
          reasoning: !!(m as { reasoning?: boolean }).reasoning,
          reasoningLevels: getSupportedThinkingLevels(m),
          input: Array.isArray((m as { input?: unknown }).input)
            ? ((m as { input: ('text' | 'image')[] }).input.filter((x) => x === 'text' || x === 'image'))
            : ['text'],
          cost: (m as { cost?: unknown }).cost,
          source: custom.has(p.id) ? 'custom' : discovered.has(key) ? 'discovered' : 'builtin',
        })
      }
    }
    const enabled = (await this.db.platformSettings()).enabledModels
    for (const item of await this.db.visibleCatalog('model', companyId || null)) {
      const def = (item.definition ?? {}) as Record<string, unknown>
      const provider = String(def.provider ?? item.name ?? '').trim()
      const id = String(def.id ?? def.model ?? item.name ?? '').trim()
      if (!provider || !id) continue
      // provider 会被 envSecret 拼成 `<PROVIDER>_API_KEY` 去索引 process.env，所以它
      // 不能是任意字符串。形状不对的条目直接不进目录——平台条目和公司条目都一样。
      if (!PROVIDER_ID_RE.test(provider) || !isModelId(id)) continue
      // **公司条目**还要过 companyModelAllowed（provider 在注册表里、模型在白名单 / 平台
      // 目录里）：写入口（routes/catalog.ts）已经挡过一次，这里再挡一层，库里可能躺着规矩
      // 收紧前写进去的老条目。平台条目是 owner 自己写的，只查形状，不查这些。
      if (item.scope === 'company' && !(await this.companyModelAllowed(provider, id, enabled)).ok) continue
      const key = `${provider}/${id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        provider,
        id,
        name: String(def.name ?? item.name ?? id),
        api: typeof def.api === 'string' ? def.api : undefined,
        input: Array.isArray(def.input)
          ? (def.input as unknown[]).filter((x): x is 'text' | 'image' => x === 'text' || x === 'image')
          : ['text'],
        contextWindow: typeof def.contextWindow === 'number' ? def.contextWindow : undefined,
        maxTokens: typeof def.maxTokens === 'number' ? def.maxTokens : undefined,
        reasoning: Boolean(def.reasoning),
        // **公司条目不带自己的 cost**：单价是平台定的，公司条目里写一份等于自己给自己
        // 定价。平台条目（owner 写的）照旧带，之前没带时界面上这类模型的单价一律是空的。
        cost: item.scope === 'company' ? undefined : def.cost,
        source: 'company',
      })
    }
    if (Array.isArray(enabled) && enabled.length) {
      const allow = new Set(enabled)
      return out.filter((m) => allow.has(`${m.provider}/${m.id}`))
    }
    return out
  }

  async find(companyId: string | null, raw: string, hint?: string): Promise<CatalogModel | undefined> {
    const ref = parseModelRef(raw, hint)
    const list = await this.catalog(companyId)
    if (ref.provider && ref.id) {
      const hit = list.find((m) => m.provider === ref.provider && m.id === ref.id)
      if (hit) return hit
    }
    // 模型 id 自己带斜杠时（`openai/gpt-4o` 这种），上面那一刀会把前半段当成 provider。
    // 切错了就把整条再当作裸 id 找一遍——唯一命中，或者跟 hint 的供应商对得上，才算数。
    const bare = String(raw || '').trim()
    if (bare) {
      const hits = list.filter((m) => m.id === bare)
      if (hits.length === 1) return hits[0]
      if (hint) return hits.find((m) => m.provider === hint)
    }
    return undefined
  }

  /**
   * 密钥的取法：**公司密钥 > 平台密钥 > 进程环境变量。**
   *
   * 公司密钥是主机制：每家公司拿自己的 key 调上游，账单在供应商那边就是分开的，
   * 一把 key 泄了也只是这一家的事。平台密钥是共享的兜底——没自己配的公司走平台
   * 采购的那把，平台按 usage_charges 转售。环境变量是最后一档，留给没人配过任何
   * 表、只靠 `.env` 起来的部署。
   *
   * 这个顺序和以前相反（以前平台表压过公司表）。反过来的理由是**影响面**：平台
   * 密钥优先时，公司配了自己的 key 也不生效，所有公司的流量都从平台那把出去——一旦
   * 它被限流或吊销，所有公司同时哑掉；而公司的 key 优先时，平台那把只承担没自己
   * 配的那些，哪一家出问题都只影响哪一家。
   *
   * 调用方拿去调上游（Gateway 自己的 /v1，或者发给管家中继的授权），响应里不得
   * 出现这个字符串。
   */
  async secret(companyId: string | null, provider: string): Promise<string | undefined> {
    if (companyId) {
      const company = await this.db.credentialByProvider(companyId, provider)
      if (company?.secret) return company.secret
    }
    const platform = await this.db.platformCredential(provider)
    if (platform?.secret) return platform.secret
    return envSecret(provider)
  }

  /**
   * 管家中继要打的上游：地址、鉴权头、上游认的模型名。
   *
   * 这是 /v1 三条路由「往哪打、带什么头」的那一份规矩，抽出来给授权接口用——管家
   * 只拿结果，不需要知道 pi-ai。地址从 pi-ai 的 Model.baseUrl 推（自定义供应商是
   * providers.ts 的 buildProvider 灌进去的 def.baseUrl），各家 baseUrl 的形状不一样，
   * 拼法按 `api` 分：
   *
   *   openai-completions / openai-responses   baseUrl 已含 `/v1`（内置 openai 是
   *       `https://api.openai.com/v1`）：chat → `${baseUrl}/chat/completions`，
   *       responses → `${baseUrl}/responses`。两种 api 的上游都同时开着这两条，所以
   *       chat 路由不挑。
   *   google-generative-ai   baseUrl 是 `https://generativelanguage.googleapis.com/v1beta`，
   *       Google 的 OpenAI 兼容口在 `/v1beta/openai/chat/completions`，即 `${baseUrl}/openai/...`。
   *   anthropic-messages     baseUrl 是 `https://api.anthropic.com`（**不含** `/v1`，
   *       Anthropic SDK 自己补 `/v1/messages`）：`${baseUrl}/v1/messages`。自定义供应商
   *       填了带 `/v1` 的 baseUrl 也认，不再叠一层。
   *
   * 头：OpenAI 系是 `authorization: Bearer`，Anthropic 是 `x-api-key` + `anthropic-version`；
   * 自定义供应商定义里的 headers 原样带上（它们本来就是给 pi-ai 每次请求附上的）。
   * 内置 openai / anthropic 的 OPENAI_BASE_URL / ANTHROPIC_BASE_URL 覆盖和 /v1 同一份。
   */
  upstreamTargetOf(
    found: CatalogModel,
    route: 'chat' | 'messages' | 'responses',
    secret: string,
    reqHeaders: { anthropicVersion?: string; openaiBeta?: string } = {},
  ): UpstreamTarget | { error: string } {
    const piModel = this.piModel(found.provider, found.id) as { api?: string; baseUrl?: string; headers?: Record<string, string> } | undefined
    if (!piModel) return { error: '模型不在可见目录里' }
    const api = String(piModel.api ?? found.api ?? '')
    const provider = this.models.getProviders().find((p) => p.id === found.provider) as { headers?: Record<string, string> } | undefined
    const baseUrl = this.baseUrlOf(found.provider, String(piModel.baseUrl ?? '')).replace(/\/$/, '')
    if (!baseUrl) return { error: `${found.provider} 没有上游地址` }
    const extra = { ...(provider?.headers ?? {}), ...(piModel.headers ?? {}) }
    const bearer = { ...extra, authorization: `Bearer ${secret}` }
    const openaiLike = api === 'openai-completions' || api === 'openai-responses'

    if (route === 'chat') {
      if (openaiLike) return { url: `${baseUrl}/chat/completions`, headers: bearer, model: found.id }
      if (api === 'google-generative-ai') return { url: `${baseUrl}/openai/chat/completions`, headers: bearer, model: found.id }
      if (api === 'anthropic-messages') return { error: '这个供应商要走 /v1/messages' }
      return { error: `${found.provider} 的接口（${api || '未知'}）没有 OpenAI 兼容口` }
    }
    if (route === 'responses') {
      if (!openaiLike) return { error: `/v1/responses 只接受 OpenAI 系的模型，收到的是 ${found.provider}` }
      const headers = { ...bearer }
      if (reqHeaders.openaiBeta) headers['openai-beta'] = reqHeaders.openaiBeta
      return { url: `${baseUrl}/responses`, headers, model: found.id }
    }
    if (api !== 'anthropic-messages') return { error: `/v1/messages 只接受 Anthropic 协议的模型，收到的是 ${found.provider}` }
    return {
      url: `${baseUrl.replace(/\/v1$/, '')}/v1/messages`,
      headers: {
        ...extra,
        'x-api-key': secret,
        'anthropic-version': reqHeaders.anthropicVersion || ANTHROPIC_VERSION,
      },
      model: found.id,
    }
  }

  /** 内置 openai / anthropic 认环境变量覆盖，其余照 pi-ai 的 Model.baseUrl。 */
  private baseUrlOf(provider: string, fromModel: string): string {
    if (provider === 'openai' && process.env.OPENAI_BASE_URL) return `${openaiBase()}/v1`
    if (provider === 'anthropic' && process.env.ANTHROPIC_BASE_URL) return anthropicBase()
    return fromModel
  }

  piModel(provider: string, id: string) {
    return this.models.getModel(provider, id)
  }

  async firstModel(companyId: string | null, provider: string): Promise<string> {
    const list = (await this.catalog(companyId)).filter((m) => m.provider === provider)
    const cheap = list.find((m) => /flash|mini|haiku|lite|nano/i.test(m.id))
    return (cheap || list[0])?.id || ''
  }

  async probe(companyId: string | null, provider: string, model: string): Promise<ProbeResult> {
    const found = await this.find(companyId, model, provider)
    if (!found) return { ok: false, provider, model, latencyMs: 0, error: '模型不在可见目录里' }
    const secret = await this.secret(companyId, found.provider)
    if (!secret) return { ok: false, provider: found.provider, model: found.id, latencyMs: 0, error: `没有 ${found.provider} 的密钥` }
    const piModel = this.piModel(found.provider, found.id)
    if (!piModel) return { ok: false, provider: found.provider, model: found.id, latencyMs: 0, error: '模型不在可见目录里' }
    const started = Date.now()
    const abort = AbortSignal.timeout(PROBE_TIMEOUT_MS)
    try {
      const message = await this.models.completeSimple(
        piModel as any,
        {
          messages: [{ role: 'user', content: 'Reply with exactly: ok', timestamp: Date.now() }],
        } as any,
        { apiKey: secret, maxTokens: 16, temperature: 0, signal: abort },
      )
      const latencyMs = Date.now() - started
      if (message?.stopReason === 'aborted' || abort.aborted) {
        return { ok: false, provider: found.provider, model: found.id, latencyMs, error: `${PROBE_TIMEOUT_MS / 1000}s 内没有响应` }
      }
      if (message?.stopReason === 'error' || message?.errorMessage) {
        return {
          ok: false,
          provider: found.provider,
          model: found.id,
          latencyMs,
          error: redact(String(message.errorMessage || 'model error'), secret),
        }
      }
      const text = Array.isArray(message?.content)
        ? message.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
        : ''
      return { ok: true, provider: found.provider, model: found.id, latencyMs, excerpt: String(text).slice(0, 80) }
    } catch (e) {
      return {
        ok: false,
        provider: found.provider,
        model: found.id,
        latencyMs: Date.now() - started,
        error: abort.aborted
          ? `${PROBE_TIMEOUT_MS / 1000}s 内没有响应`
          : redact((e as Error).message || 'upstream error', secret),
      }
    }
  }
}

export function createLlm(db: Db) {
  return new Llm(db)
}

export function redact(text: string, secret?: string): string {
  if (!secret || !text) return text
  return text.split(secret).join('[redacted]')
}

export const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}
