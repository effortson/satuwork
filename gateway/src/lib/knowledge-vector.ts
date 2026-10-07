/**
 * Upstash Vector 的那一层壳（docs/knowledge-base.md §3.2）。
 *
 * 一个索引、每个知识库一个命名空间、用索引**内置的 embedding**：这里只送文本（`data`），
 * 向量在 Upstash 那边算，Gateway 不碰任何 embedding 模型，也不需要额外的模型密钥。
 *
 * 两个环境变量交给 Gateway：`UPSTASH_VECTOR_REST_URL` / `UPSTASH_VECTOR_REST_TOKEN`。
 * 没配 = 没开：写接口和检索回 501（同 Blob 没配时发布包那条），读接口照常——界面要能
 * 画出「未开通」。
 *
 * 命名空间 `kb:{kbId}`：删库 = 删命名空间，删文件 = 按前缀 `{fileId}:` 删，各一条调用。
 * 元数据里不放 companyId——命名空间已经把它钉死了，再放一份只是多一个可能对不上的地方。
 */
import { Index } from '@upstash/vector'
import { HttpError } from '../http.ts'

export interface KbVectorMeta {
  fileId: string
  fileName: string
  kbId: string
  no: number
  page: number | null
  text: string
  [key: string]: unknown
}

export interface KbHit {
  id: string
  score: number
  metadata: KbVectorMeta
}

/** 一批最多灌多少条。Upstash 免费档每批上限 1000，100 是留给 50 秒预算的步长。 */
export const KB_UPSERT_BATCH = 100

function restUrl(): string {
  return (process.env.UPSTASH_VECTOR_REST_URL || '').trim()
}

function restToken(): string {
  return (process.env.UPSTASH_VECTOR_REST_TOKEN || '').trim()
}

export function vectorConfigured(): boolean {
  return !!restUrl() && !!restToken()
}

export const VECTOR_NOT_CONFIGURED = '平台未配置向量库（UPSTASH_VECTOR_REST_URL / UPSTASH_VECTOR_REST_TOKEN）'

let cached: { key: string; index: Index } | null = null

/** 懒建、按配置键缓存：e2e 里同一进程会换假服务地址。 */
function index(): Index {
  if (!vectorConfigured()) throw new HttpError(501, VECTOR_NOT_CONFIGURED)
  const key = `${restUrl()}|${restToken()}`
  if (cached?.key === key) return cached.index
  const idx = new Index({ url: restUrl(), token: restToken() })
  cached = { key, index: idx }
  return idx
}

export function namespaceOf(kbId: string): string {
  return `kb:${kbId}`
}

export async function upsertChunks(kbId: string, rows: Array<{ id: string; data: string; metadata: KbVectorMeta }>): Promise<void> {
  if (!rows.length) return
  const idx = index()
  for (let i = 0; i < rows.length; i += KB_UPSERT_BATCH) {
    await idx.upsert(rows.slice(i, i + KB_UPSERT_BATCH), { namespace: namespaceOf(kbId) })
  }
}

export async function queryNamespace(kbId: string, query: string, topK: number): Promise<KbHit[]> {
  const out = await index().query<KbVectorMeta>({ data: query, topK, includeMetadata: true }, { namespace: namespaceOf(kbId) })
  return out
    .filter((r) => r.metadata && typeof r.metadata.text === 'string')
    .map((r) => ({ id: String(r.id), score: Number(r.score) || 0, metadata: r.metadata as KbVectorMeta }))
}

export async function deleteFileVectors(kbId: string, fileId: string): Promise<void> {
  await index().delete({ prefix: `${fileId}:` }, { namespace: namespaceOf(kbId) })
}

/** 对不存在的命名空间 Upstash 回成功，所以 tick 重来是幂等的。 */
export async function deleteKbNamespace(kbId: string): Promise<void> {
  try {
    await index().deleteNamespace(namespaceOf(kbId))
  } catch (e) {
    // 有的版本对「没有这个命名空间」回 4xx；那正是我们要的结果。
    if (/not found|does not exist|404/i.test(String((e as Error).message))) return
    throw e
  }
}

/** 平台「工具配置」那一屏的状态行：配没配、索引里一共多少向量。 */
export async function vectorInfo(): Promise<{ configured: boolean; vectors?: number; dimension?: number; error?: string }> {
  if (!vectorConfigured()) return { configured: false }
  try {
    const info = await index().info()
    return { configured: true, vectors: Number(info.vectorCount) || 0, dimension: Number(info.dimension) || 0 }
  } catch (e) {
    return { configured: true, error: (e as Error).message }
  }
}
