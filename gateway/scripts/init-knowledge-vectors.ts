/** Explicit optional backend initialization; extension installation remains an admin operation. */
import { Db, migrateDatabaseUrl } from '../src/db.ts'
import { embeddingConfig } from '../src/lib/knowledge-embedding.ts'
const db = new Db({ url: migrateDatabaseUrl() })
try {
  const cfg = embeddingConfig()
  if (cfg.error) throw new Error(cfg.error)
  await db.initializeKnowledgeVectors(cfg.profile, cfg.model, cfg.dimension)
  console.log(`pgvector 知识库已初始化：${cfg.model}，${cfg.dimension} 维`)
} finally { await db.close() }
