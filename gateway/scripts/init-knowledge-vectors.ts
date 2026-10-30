/** Explicit optional backend initialization; extension installation remains an admin operation. */
import { Db, migrateDatabaseUrl } from '../src/db.ts'
import { loadEmbeddingConfig } from '../src/lib/knowledge-embedding.ts'
// 平台页面上的「初始化向量表」做的是同一件事；运行时账号没有建表权限时用这个脚本走迁移账号。
const db = new Db({ url: migrateDatabaseUrl() })
try {
  const cfg = await loadEmbeddingConfig(db)
  if (cfg.error) throw new Error(cfg.error)
  await db.initializeKnowledgeVectors(cfg.profile, cfg.model, cfg.dimension)
  console.log(`pgvector 知识库已初始化：${cfg.model}，${cfg.dimension} 维`)
} finally { await db.close() }
