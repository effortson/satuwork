/** Optional vector backends share the existing ingestion/deletion/search contract. */
import type { Db } from '../db.ts'
import { HttpError } from '../http.ts'
import { embedTexts, embeddingConfig, embeddingMissing } from './knowledge-embedding.ts'
import * as upstash from './knowledge-upstash.ts'
export type { KbHit, KbVectorMeta } from './knowledge-upstash.ts'
import type { KbHit, KbVectorMeta } from './knowledge-upstash.ts'

export interface KbVectorScope { id: string; companyId: string }
/** Billing units remain logical groups of 100 chunks, independent of provider request batches. */
export const KB_UPSERT_BATCH = upstash.KB_UPSERT_BATCH
export const VECTOR_NOT_CONFIGURED = '平台未配置知识库向量服务，请联系系统管理员检查工具配置'
export const namespaceOf = upstash.namespaceOf

export function vectorBackend(): string {
  return (process.env.KB_VECTOR_BACKEND || 'upstash').trim()
}

function configuration() {
  const backend = vectorBackend()
  if (backend === 'upstash') return { backend, missing: [
    ...((process.env.UPSTASH_VECTOR_REST_URL || '').trim() ? [] : ['UPSTASH_VECTOR_REST_URL']),
    ...((process.env.UPSTASH_VECTOR_REST_TOKEN || '').trim() ? [] : ['UPSTASH_VECTOR_REST_TOKEN']),
  ], error: '' }
  if (backend === 'pgvector') return { backend, missing: embeddingMissing(), error: embeddingConfig().error }
  return { backend, missing: [], error: 'KB_VECTOR_BACKEND 只能是 upstash 或 pgvector' }
}

export function vectorConfigured(): boolean {
  const cfg = configuration()
  return !cfg.error && !cfg.missing.length
}

async function ready(db: Db): Promise<void> {
  const cfg = configuration()
  if (cfg.error || cfg.missing.length) throw new HttpError(503, cfg.error || VECTOR_NOT_CONFIGURED)
  try { await db.assertKnowledgeVectorProfile(embeddingConfig().profile) } catch (error) {
    const message = (error as Error).message
    throw new HttpError(503, /模型或地址已变更/.test(message) ? message : 'pgvector 知识库尚未初始化或数据库不可用，请检查向量表和扩展')
  }
}

export async function prepareVectorQuery(db: Db, query: string, companyId: string): Promise<number[] | undefined> {
  if (vectorBackend() === 'upstash') return undefined
  await ready(db)
  return (await embedTexts([query], undefined, (tokens, inputs) => db.recordKnowledgeEmbeddingUsage(companyId, embeddingConfig().profile, 'query', tokens, inputs)))[0]
}

export async function upsertChunks(db: Db, kb: KbVectorScope, rows: Array<{ id: string; data: string; metadata: KbVectorMeta }>, deadline?: number): Promise<void> {
  if (!rows.length) return
  if (vectorBackend() === 'upstash') return upstash.upsertChunks(kb.id, rows)
  await ready(db)
  const vectors = await embedTexts(rows.map((row) => row.data), deadline, (tokens, inputs) => db.recordKnowledgeEmbeddingUsage(kb.companyId, embeddingConfig().profile, 'ingest', tokens, inputs))
  await db.upsertKnowledgeVectors(kb, embeddingConfig().profile, rows.map((row, i) => ({ id: row.id, data: row.data, vector: vectors[i] })))
}

export async function queryNamespace(db: Db, kb: KbVectorScope, query: string, topK: number, prepared?: number[]): Promise<KbHit[]> {
  if (vectorBackend() === 'upstash') return upstash.queryNamespace(kb.id, query, topK)
  await ready(db)
  const vector = prepared ?? (await embedTexts([query]))[0]
  return db.queryKnowledgeVectors(kb, embeddingConfig().profile, vector, topK)
}

// Deletion must still work after an embedding key expires or the configured model changes.
export async function deleteFileVectors(db: Db, kb: KbVectorScope, fileId: string): Promise<void> {
  if (vectorBackend() === 'upstash') return upstash.deleteFileVectors(kb.id, fileId)
  if (vectorBackend() !== 'pgvector') throw new HttpError(503, configuration().error)
  await db.deleteKnowledgeVectors(kb, fileId)
}

export async function deleteKbNamespace(db: Db, kb: KbVectorScope): Promise<void> {
  if (vectorBackend() === 'upstash') return upstash.deleteKbNamespace(kb.id)
  if (vectorBackend() !== 'pgvector') throw new HttpError(503, configuration().error)
  await db.deleteKnowledgeVectors(kb)
}

export async function vectorInfo(db: Db): Promise<{ configured: boolean; backend: string; model?: string; vectors?: number; dimension?: number; missing?: string[]; error?: string }> {
  const cfg = configuration()
  if (cfg.error || cfg.missing.length) return { configured: false, ...cfg }
  if (cfg.backend === 'upstash') return { backend: cfg.backend, ...await upstash.vectorInfo() }
  const embedding = embeddingConfig()
  try {
    await ready(db)
    return { configured: true, backend: cfg.backend, model: embedding.model, dimension: embedding.dimension, vectors: await db.knowledgeVectorCount() }
  } catch (e) {
    return { configured: true, backend: cfg.backend, model: embedding.model, dimension: embedding.dimension, error: (e as Error).message }
  }
}
