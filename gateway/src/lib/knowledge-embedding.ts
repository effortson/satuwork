import { createHash } from 'node:crypto'
import { HttpError } from '../http.ts'

/** A profile identifies a vector space. Rotating a credential does not change it. */
export function embeddingConfig() {
  const base = (process.env.KB_EMBEDDING_BASE_URL || 'https://api.siliconflow.cn/v1').trim().replace(/\/+$/, '')
  const model = (process.env.KB_EMBEDDING_MODEL || 'BAAI/bge-m3').trim()
  const dimension = Number(process.env.KB_EMBEDDING_DIMENSIONS || 1024)
  const token = (process.env.KB_EMBEDDING_API_KEY || '').trim()
  let error = ''
  try {
    const url = new URL(base)
    if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error()
  } catch { error = 'KB_EMBEDDING_BASE_URL 必须是 HTTPS 地址（本机测试可用 HTTP），不能含凭据或查询参数' }
  if (dimension !== 1024) error = '当前 pgvector 后端要求 1024 维；变更维度需要先迁移向量表'
  if (!model) error = '缺少 KB_EMBEDDING_MODEL'
  return { base, model, dimension, token, error,
    profile: createHash('sha256').update(JSON.stringify([base, model, dimension])).digest('hex') }
}

export function embeddingMissing(): string[] {
  return embeddingConfig().token ? [] : ['KB_EMBEDDING_API_KEY']
}

/** Retries stay inside the caller's ingestion deadline. Never return upstream bodies or credentials. */
export async function embedTexts(texts: string[], deadline = Date.now() + 40_000, usage?: (tokens: number | null, inputs: number) => Promise<void>): Promise<number[][]> {
  const cfg = embeddingConfig()
  if (cfg.error || !cfg.token) throw new HttpError(503, cfg.error || '未配置 KB_EMBEDDING_API_KEY')
  if (texts.some((text) => !text.trim())) throw new HttpError(400, '向量输入不能为空')
  const vectors: number[][] = []
  for (let offset = 0; offset < texts.length; offset += 16) {
    const batch = texts.slice(offset, offset + 16)
    for (let attempt = 0; ; attempt++) {
      const remaining = deadline - Date.now()
      if (remaining < 100) throw new HttpError(503, '向量生成超时，稍后重试')
      let response: Response
      try {
        response = await fetch(`${cfg.base}/embeddings`, {
          method: 'POST', redirect: 'error',
          headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: cfg.model, input: batch, encoding_format: 'float' }),
          signal: AbortSignal.timeout(Math.min(12_000, remaining)),
        })
      } catch {
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
