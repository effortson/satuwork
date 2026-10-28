/**
 * 知识库的向量那一层：pgvector 存、OpenAI 兼容的 `/embeddings` 算（docs/knowledge-base.md §3.2）。
 *
 * 向量模型在平台「工具配置 → 知识库」里配（lib/knowledge-embedding.ts），不再读环境变量。
 * 向量表是可选的，由 `initializeKnowledgeVectors` 显式建：普通迁移从不要求 vector 扩展。
 */
import type { Db, PlatformSettings } from '../db.ts'
import { HttpError } from '../http.ts'
import { type EmbeddingConfig, embedTexts, embeddingProblem, embeddingUsable, loadEmbeddingConfig } from './knowledge-embedding.ts'

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

export interface KbVectorScope { id: string; companyId: string }

/** 入库一批推进多少片，也是计费单位（100 片 = 一次入库）。和向量服务单次收几条无关。 */
export const KB_UPSERT_BATCH = 100
export const VECTOR_NOT_CONFIGURED = '平台未配置知识库向量服务，请联系系统管理员检查工具配置'
export const VECTOR_NOT_INITIALIZED = '平台的知识库向量表还没建好，暂时不能检索；新传的文件会排队，建好后入库'
export const VECTOR_REBUILD_NEEDED = '平台更换了知识库向量模型，重建向量之前暂时不能检索；新传的文件会排队，重建后入库'

/**
 * 能不能真的用：模型配好、密钥在、表建了、表里向量和当前模型是同一个空间。缺一样就给出原因。
 * 入库节拍和检索看这一个——只看「配了没有」的话，表没建或换了模型时入库会一拍拍撞 503，
 * 几拍之后把排队的文件全标成失败。
 */
export async function vectorReadiness(db: Db, settings?: PlatformSettings): Promise<{ cfg: EmbeddingConfig; reason: string }> {
  const cfg = await loadEmbeddingConfig(db, settings)
  if (!embeddingUsable(cfg)) return { cfg, reason: VECTOR_NOT_CONFIGURED }
  const stored = await db.knowledgeVectorConfig()
  if (!stored) return { cfg, reason: VECTOR_NOT_INITIALIZED }
  if (stored.profile !== cfg.profile) return { cfg, reason: VECTOR_REBUILD_NEEDED }
  return { cfg, reason: '' }
}

/**
 * 上传和建库只看这个：模型配好、密钥在就收。表没建、等重建期间收下的文件只排队，入库节拍
 * 看 vectorReadiness 不领它们，就绪后自动灌进去——不会被一拍拍撞成「失败」。
 */
export async function vectorConfigured(db: Db): Promise<boolean> {
  return embeddingUsable(await loadEmbeddingConfig(db))
}

/** 检索和入库的入口：没就绪就 503，带上原因。 */
export async function readyVectors(db: Db, settings?: PlatformSettings): Promise<EmbeddingConfig> {
  const { cfg, reason } = await vectorReadiness(db, settings)
  if (reason) throw new HttpError(503, reason)
  return cfg
}

/** 一次检索只算一次查询向量，几个库共用。 */
export interface PreparedQuery { profile: string; vector: number[] }

export async function prepareVectorQuery(db: Db, query: string, companyId: string, settings?: PlatformSettings): Promise<PreparedQuery> {
  const cfg = await readyVectors(db, settings)
  const [vector] = await embedTexts(cfg, [query], undefined, (tokens, inputs) => db.recordKnowledgeEmbeddingUsage(companyId, cfg.profile, 'query', tokens, inputs))
  return { profile: cfg.profile, vector }
}

/** `cfg` 由入库那一拍开头的 readyVectors 给，不每批重读；写入时库里按指纹再核一次（模型中途换了就拒）。 */
export async function upsertChunks(db: Db, cfg: EmbeddingConfig, kb: KbVectorScope, rows: Array<{ id: string; data: string; metadata: KbVectorMeta }>, deadline?: number): Promise<void> {
  if (!rows.length) return
  const vectors = await embedTexts(cfg, rows.map((row) => row.data), deadline, (tokens, inputs) => db.recordKnowledgeEmbeddingUsage(kb.companyId, cfg.profile, 'ingest', tokens, inputs))
  await db.upsertKnowledgeVectors(kb, cfg.profile, rows.map((row, i) => ({ id: row.id, data: row.data, vector: vectors[i] })))
}

export async function queryNamespace(db: Db, kb: KbVectorScope, prepared: PreparedQuery, topK: number): Promise<KbHit[]> {
  return db.queryKnowledgeVectors(kb, prepared.profile, prepared.vector, topK)
}

// 删除不看配置：密钥过期、模型换了、甚至表还没建，都得删得掉。
export async function deleteFileVectors(db: Db, kb: KbVectorScope, fileId: string): Promise<void> {
  await db.deleteKnowledgeVectors(kb, fileId)
}

export async function deleteKbNamespace(db: Db, kb: KbVectorScope): Promise<void> {
  await db.deleteKnowledgeVectors(kb)
}

export interface VectorInfo {
  configured: boolean
  source: EmbeddingConfig['source']
  provider: string
  model: string
  dimension: number
  /** 向量表建了没有。 */
  initialized: boolean
  /** 表里现有向量是哪个模型算的；和当前配置不一样就得重建。 */
  storedModel?: string
  profileMatches?: boolean
  vectors?: number
  /** 「可用」却没有向量的文件数（从旧向量库迁来）。大于 0 时要点重建才查得到。 */
  unindexed?: number
  error?: string
}

/** 「工具配置 → 知识库」那一屏的状态。 */
export async function vectorInfo(db: Db): Promise<VectorInfo> {
  const cfg = await loadEmbeddingConfig(db)
  const out: VectorInfo = {
    configured: embeddingUsable(cfg), source: cfg.source, provider: cfg.provider, model: cfg.model, dimension: cfg.dimension, initialized: false,
  }
  try {
    const stored = await db.knowledgeVectorConfig()
    if (!stored) return { ...out, error: embeddingProblem(cfg) || undefined }
    out.initialized = true
    out.storedModel = stored.model
    out.profileMatches = stored.profile === cfg.profile
    const [vectors, unindexed] = await Promise.all([db.knowledgeVectorCount(), db.knowledgeFilesWithoutVectors()])
    out.vectors = vectors
    out.unindexed = unindexed
    if (!out.configured) out.error = embeddingProblem(cfg)
    else if (!out.profileMatches) out.error = `现有向量由 ${stored.model} 生成，和当前模型不同：重建之前检索和入库都暂停`
    return out
  } catch (e) {
    return { ...out, error: (e as Error).message }
  }
}
