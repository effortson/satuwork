import { createHash } from 'node:crypto'
import type { Db, KnowledgeEmbeddingSettings, PlatformSettings } from '../db.ts'
import { parseKnowledgeEmbedding } from '../db.ts'
import { HttpError } from '../http.ts'
import { WebToolError, safeFetch } from '../web-tools.ts'

/** 向量表的列宽定死在 1024（db/knowledge-vector.ts）。换维度要先迁移表，不是改一个设置。 */
export const KB_EMBEDDING_DIMENSION = 1024

/**
 * 页面上能挑的几家，全是 OpenAI 兼容的 `/embeddings`，都能出 1024 维。
 *
 * 按区域分：中国区部署连不上 OpenAI，国际区部署也不该把员工文档绕到国内去。`region` 只管
 * 页面上列哪几家，调用时不看它。`dimensions` = 要不要在请求里带 `dimensions: 1024`——
 * 原生就是 1024 维的模型（bge-m3）不带，带了反而可能被拒；`batchSize` 是这家单次最多收几条。
 */
export interface EmbeddingPreset {
  id: string
  region: 'cn' | 'intl'
  label: string
  baseUrl: string
  model: string
  models: string[]
  dimensions: boolean
  batchSize: number
}

export const EMBEDDING_PRESETS: readonly EmbeddingPreset[] = [
  { id: 'siliconflow', region: 'cn', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3', models: ['BAAI/bge-m3'], dimensions: false, batchSize: 16 },
  // 百炼和智谱单次都只收 10 条，多一条整批 400。
  { id: 'dashscope', region: 'cn', label: '阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'text-embedding-v4', models: ['text-embedding-v4', 'text-embedding-v3'], dimensions: true, batchSize: 10 },
  { id: 'zhipu', region: 'cn', label: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'embedding-3', models: ['embedding-3'], dimensions: true, batchSize: 10 },
  { id: 'openai', region: 'intl', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small', models: ['text-embedding-3-small', 'text-embedding-3-large'], dimensions: true, batchSize: 64 },
  { id: 'siliconflow-intl', region: 'intl', label: 'SiliconFlow（国际站）', baseUrl: 'https://api.siliconflow.com/v1', model: 'BAAI/bge-m3', models: ['BAAI/bge-m3'], dimensions: false, batchSize: 16 },
]

export const EMBEDDING_CUSTOM = 'custom'

/**
 * 密钥按预设分开存：切到别家再切回来，不用重贴。
 *
 * **自定义的那把钉在地址的 origin 上**：把地址从 A 家改成 B 家，名字跟着变、旧密钥就取不到了，
 * 不会把 A 家的密钥发给 B 家。预设的地址写死在代码里，不用钉。
 */
export function embeddingSecretName(provider: string, baseUrl = ''): string {
  if (provider !== EMBEDDING_CUSTOM) return `kb-embedding:${provider}`
  let origin = ''
  try { origin = new URL(baseUrl).origin } catch {}
  return `kb-embedding:${EMBEDDING_CUSTOM}:${origin}`
}

export function isEmbeddingSecret(name: string): boolean {
  return name.startsWith('kb-embedding:')
}

export interface EmbeddingConfig {
  /** 配置从哪来：页面、老的环境变量，还是哪都没有。 */
  source: 'settings' | 'env' | 'none'
  region: 'cn' | 'intl' | ''
  provider: string
  base: string
  model: string
  dimension: number
  sendDimensions: boolean
  batchSize: number
  token: string
  error: string
  /**
   * 能不能打内网地址。页面上填的自定义地址要过 web-tools 的 SSRF 闸（拿到平台管理员会话的人
   * 不该能借 Gateway 探内网）；运维写在环境变量里的地址和本机测试开关不过闸。
   */
  allowPrivate: boolean
  /** 一个向量空间的指纹。只看地址、模型、维度——换密钥不算换空间，不用重建。 */
  profile: string
}

function urlError(base: string): string {
  try {
    const url = new URL(base)
    if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error()
    return ''
  } catch { return '向量服务地址必须是 HTTPS（本机测试可用 HTTP），不能含凭据或查询参数' }
}

/**
 * 把页面上存的那份（或老环境变量）收成一份能直接调用的配置。纯函数，单测直接喂。
 *
 * 页面上没配过（`provider` 空）才看环境变量：老部署升级上来不断，在页面上存一次之后
 * 环境变量就不再起作用。
 */
export function resolveEmbedding(s: KnowledgeEmbeddingSettings, token: string, env: NodeJS.ProcessEnv = process.env): EmbeddingConfig {
  let source: EmbeddingConfig['source'] = 'settings'
  let base = '', model = '', sendDimensions = false, batchSize = 16
  let error = ''
  if (s.provider) {
    const preset = EMBEDDING_PRESETS.find((p) => p.id === s.provider)
    if (preset) {
      base = preset.baseUrl
      model = s.model || preset.model
      sendDimensions = preset.dimensions
      batchSize = preset.batchSize
    } else if (s.provider === EMBEDDING_CUSTOM) {
      base = s.baseUrl
      model = s.model
      sendDimensions = s.dimensions
      batchSize = s.batchSize
    } else error = `不认识的向量服务：${s.provider}`
  } else if ((env.KB_EMBEDDING_API_KEY || '').trim()) {
    source = 'env'
    base = (env.KB_EMBEDDING_BASE_URL || 'https://api.siliconflow.cn/v1').trim()
    model = (env.KB_EMBEDDING_MODEL || 'BAAI/bge-m3').trim()
    token = (env.KB_EMBEDDING_API_KEY || '').trim()
    if (Number(env.KB_EMBEDDING_DIMENSIONS || KB_EMBEDDING_DIMENSION) !== KB_EMBEDDING_DIMENSION) error = `向量表要求 ${KB_EMBEDDING_DIMENSION} 维；变更维度需要先迁移向量表`
  } else {
    source = 'none'
    error = '还没有配置向量模型'
  }
  base = base.trim().replace(/\/+$/, '')
  model = model.trim()
  if (!error && !base) error = '缺少向量服务地址'
  if (!error) error = urlError(base)
  if (!error && !model) error = '缺少向量模型名'
  const dimension = KB_EMBEDDING_DIMENSION
  return {
    source, region: s.region, provider: source === 'env' ? 'env' : s.provider, base, model, dimension, sendDimensions, batchSize,
    token: token.trim(), error, allowPrivate: source === 'env' || env.GATEWAY_KB_EMBEDDING_ALLOW_PRIVATE === '1',
    profile: createHash('sha256').update(JSON.stringify([base, model, dimension])).digest('hex'),
  }
}

/**
 * 每次现读：Vercel 上好几个实例，页面上一改，别的实例下一次调用就得跟上。不缓存；调用方手里已经
 * 有平台设置（检索那条路）就传进来，省一次查询。
 */
export async function loadEmbeddingConfig(db: Db, settings?: PlatformSettings): Promise<EmbeddingConfig> {
  const s = parseKnowledgeEmbedding((settings ?? await db.platformSettings()).knowledgeEmbedding)
  const cred = s.provider ? await db.platformCredential(embeddingSecretName(s.provider, s.baseUrl)) : undefined
  return resolveEmbedding(s, cred?.secret ?? '')
}

/** 能不能真去调：配置没毛病、密钥也在。 */
export function embeddingUsable(cfg: EmbeddingConfig): boolean {
  return !cfg.error && !!cfg.token
}

export function embeddingProblem(cfg: EmbeddingConfig): string {
  return cfg.error || (cfg.token ? '' : '还没有填向量服务的 API 密钥')
}

/** Retries stay inside the caller's ingestion deadline. Never return upstream bodies or credentials. */
export async function embedTexts(cfg: EmbeddingConfig, texts: string[], deadline = Date.now() + 40_000, usage?: (tokens: number | null, inputs: number) => Promise<void>): Promise<number[][]> {
  if (!embeddingUsable(cfg)) throw new HttpError(503, embeddingProblem(cfg))
  if (texts.some((text) => !text.trim())) throw new HttpError(400, '向量输入不能为空')
  const vectors: number[][] = []
  for (let offset = 0; offset < texts.length; offset += cfg.batchSize) {
    const batch = texts.slice(offset, offset + cfg.batchSize)
    for (let attempt = 0; ; attempt++) {
      const remaining = deadline - Date.now()
      if (remaining < 100) throw new HttpError(503, '向量生成超时，稍后重试')
      let response: Response
      const init = {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
        // 不带 encoding_format：各家默认都是 float，而有的家不认这个字段。
        body: JSON.stringify({ model: cfg.model, input: batch, ...(cfg.sendDimensions ? { dimensions: cfg.dimension } : {}) }),
      }
      const timeoutMs = Math.min(12_000, remaining)
      try {
        response = cfg.allowPrivate
          ? await fetch(`${cfg.base}/embeddings`, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
          : await safeFetch(`${cfg.base}/embeddings`, { ...init, timeoutMs })
      } catch (e) {
        // 打到内网是配置错，不是一时的：不重试，原样告诉管理员。
        if (e instanceof WebToolError && /内网/.test(e.hint)) throw new HttpError(503, '向量服务地址指向内网，已拒绝')
        if (attempt >= 2) throw new HttpError(503, '向量服务连接失败或超时，稍后重试')
        const delay = 300 * 2 ** attempt
        if (Date.now() + delay >= deadline) throw new HttpError(503, '向量生成超时，稍后重试')
        await new Promise((resolve) => setTimeout(resolve, delay))
        continue
      }
      if (!response.ok) {
        const retryAfter = response.headers.get('retry-after')
        await response.body?.cancel()
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          const seconds = Number(retryAfter)
          const delay = retryAfter && Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : 300 * 2 ** attempt
          if (Date.now() + delay < deadline) {
            await new Promise((resolve) => setTimeout(resolve, delay))
            continue
          }
        }
        // A provider's 429 must not become a permanently failed file in ingestOne.
        throw new HttpError(503, `向量服务请求失败（HTTP ${response.status}），请检查模型权限、额度和服务状态`)
      }
      let result: { data: Array<{ index: number; embedding: number[] }>; usage?: { prompt_tokens?: number; total_tokens?: number } }
      try { result = await response.json() } catch { throw new HttpError(502, '向量服务返回了无效 JSON') }
      const data = result.data
      if (!Array.isArray(data) || data.length !== batch.length) throw new HttpError(502, '向量服务返回的数量不匹配')
      const ordered: number[][] = new Array(batch.length)
      for (const item of data) {
        if (!Number.isInteger(item.index) || item.index < 0 || item.index >= batch.length || ordered[item.index] ||
          !Array.isArray(item.embedding) || item.embedding.length !== cfg.dimension ||
          item.embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value)) ||
          !item.embedding.some((value) => value !== 0)) throw new HttpError(502, '向量服务返回了无效向量、维度或索引')
        ordered[item.index] = item.embedding
      }
      vectors.push(...ordered)
      const tokens = result.usage?.prompt_tokens ?? result.usage?.total_tokens
      if (usage) await usage(Number.isSafeInteger(tokens) && tokens! >= 0 ? tokens! : null, batch.length)
      break
    }
  }
  return vectors
}
