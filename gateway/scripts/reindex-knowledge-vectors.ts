import { Db, migrateDatabaseUrl } from '../src/db.ts'
import { loadEmbeddingConfig } from '../src/lib/knowledge-embedding.ts'
if (!process.argv.includes('--apply')) throw new Error('先备份，然后带 --apply 重建向量。原文件和文本分片会保留，重新入库按当前平台单价计费。平台「工具配置 → 知识库」里的「重建向量」做的是同一件事。')
const db = new Db({ url: migrateDatabaseUrl() })
try {
  const cfg = await loadEmbeddingConfig(db)
  if (cfg.error) throw new Error(cfg.error)
  const count = await db.reindexKnowledgeVectors(cfg.profile, cfg.model, cfg.dimension)
  console.log(`已清理旧向量并重新排队 ${count} 个文件：${cfg.model}，${cfg.dimension} 维`)
} finally { await db.close() }
