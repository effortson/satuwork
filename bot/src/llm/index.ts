import { Service, type Context as Ctx } from '@deepseek-ai/cordis'
import { gatewayApiKey, llmBaseUrl, setApiLookup, streamViaGateway, stubModel } from './gateway.ts'
import { AssistantMessageEventStream, emptyAssistant } from './stream.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    llm: LlmService
  }
}

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface CatalogProvider {
  provider: string
  name: string
  endpoint?: string
  models: {
    id: string
    name: string
    api?: string
    reasoning?: boolean
    reasoningLevels?: string[]
    contextWindow?: number
    maxTokens?: number
    cost?: unknown
  }[]
}

/** 拉目录的超时。Gateway 就在本机或内网，10 秒还没回就是它出问题了。 */
const REFRESH_TIMEOUT_MS = 10_000

/**
 * 模型接缝：Gateway 的薄客户端。
 *
 * 目录与补全都打 llmBaseUrl() 的 /v1/*（席位上是管家的转发口 GATEWAY_LLM_URL，本地
 * 就是 GATEWAY_URL）。本进程不持有 provider 密钥，也不依赖 pi-ai。
 * 流式结果映射成 pi-agent-core 的 streamFn，会话投影不用改。
 */
export class LlmService extends Service {
  private cached: CatalogProvider[] = []

  constructor(ctx: Ctx) {
    super(ctx, 'llm')
    /**
     * 把「这个模型走哪种协议」的查法交给 gateway.ts。
     *
     * web-search 的摘要、conversation-audit 的审计也是模型调用，也得按 api 选路，可它们手上
     * 只有 provider + 模型名。查的是这份目录，不另存一份表：目录会刷新，抄一份就会过期。
     * 查不到给 undefined（不能借 modelOf——它查不到时会用 stubModel 按名字猜一个 api 出来，
     * 那正是这次要改掉的猜法）。
     */
    setApiLookup((provider, id) => this.cached.find((p) => p.provider === provider)?.models.find((m) => m.id === id)?.api)
  }

  /** 模型调用的入口，界面上 /api/models 的 gateway 字段就是它——席位上会是管家的转发口。 */
  get url() {
    return llmBaseUrl()
  }

  /** 发给 pi-agent-core 的 streamFn。失败编码进流，不抛。 */
  streamFn = (model: any, context: any, options?: any) => {
    if (process.env.E2E_STUB_LLM === '1') return stubLlmStream(model)
    return streamViaGateway(model, context, options)
  }

  modelOf(provider: string, id: string) {
    const base = stubModel(provider, id)
    const found = this.cached.find((p) => p.provider === provider)?.models.find((m) => m.id === id)
    return found
      ? {
          ...base,
          api: found.api ?? base.api,
          reasoning: !!found.reasoning,
          contextWindow: found.contextWindow ?? base.contextWindow,
          maxTokens: found.maxTokens ?? base.maxTokens,
        }
      : base
  }

  async configured(): Promise<string[]> {
    return []
  }

  async available(): Promise<string[]> {
    const cat = await this.refresh()
    return [...new Set(cat.map((p) => p.provider))]
  }

  catalog(): CatalogProvider[] {
    return this.cached
  }

  async refresh(): Promise<CatalogProvider[]> {
    const base = llmBaseUrl()
    const apiKey = gatewayApiKey()
    if (!base || !apiKey) {
      this.cached = []
      return this.cached
    }
    /**
     * 带超时；失败**保留上一次的目录**。
     *
     * 没有超时的话 Gateway 卡住时这个 await 会一直挂着，`available()` 也跟着挂。
     * 失败就清空更糟：一次网络抖动就让 modelOf 认不出任何模型、界面上模型列表变空，
     * 而上一份目录明明还在手里。只有从未成功过时它才是空的。
     */
    try {
      const r = await fetch(base + '/v1/models', {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      })
      if (!r.ok) {
        this.ctx.logger?.warn?.(`llm: 拉模型目录失败 HTTP ${r.status}，沿用上一份`)
        return this.cached
      }
      const body = (await r.json()) as { data?: any[] }
      const by = new Map<string, CatalogProvider>()
      for (const m of body.data ?? []) {
        const provider = String(m.provider || m.owned_by || 'unknown')
        // 只在**第一个**斜杠上切：`m.id` 是 `provider/model`，而模型 id 自己可能还带斜杠
        // （openrouter 的 openai/gpt-4o）。用 pop() 会把它切得只剩最后一段。
        const composite = String(m.id || '')
        const cut = composite.indexOf('/')
        const id = String(m.model || (cut > 0 ? composite.slice(cut + 1) : composite) || m.id)
        if (!by.has(provider)) {
          by.set(provider, { provider, name: provider, models: [] })
        }
        by.get(provider)!.models.push({
          id,
          name: m.name ?? id,
          api: m.api,
          reasoning: !!m.reasoning,
          reasoningLevels: Array.isArray(m.reasoning_levels) ? m.reasoning_levels.map(String) : undefined,
          contextWindow: m.context_window,
          maxTokens: m.max_tokens,
          cost: m.cost,
        })
      }
      this.cached = [...by.values()]
      return this.cached
    } catch (e) {
      this.ctx.logger?.warn?.(`llm: 拉模型目录失败：${(e as Error).message}，沿用上一份`)
      return this.cached
    }
  }
}

export const name = 'satu-llm'
export const inject = ['storage']

export function apply(ctx: Ctx) {
  ctx.plugin(LlmService)
  ctx.inject(['llm'], (ctx: Ctx) => {
    void ctx.llm.refresh()
  })
}

/** 只在 E2E_STUB_LLM=1 时走。仍经过 Agent.send，会写下 request/header。不假装模型成功。 */
function stubLlmStream(model: any) {
  const stream = new AssistantMessageEventStream()
  queueMicrotask(() => {
    const error = emptyAssistant(model, 'E2E_STUB_LLM')
    stream.push({ type: 'error', reason: 'error', error })
    stream.end()
  })
  return stream
}
