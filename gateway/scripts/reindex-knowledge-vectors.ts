import { Db, migrateDatabaseUrl } from '../src/db.ts'
import { embeddingConfig } from '../src/lib/knowledge-embedding.ts'
if (!process.argv.includes('--apply')) throw new Error('先停止 Gateway 并备份，然后带 --apply 重建向量。原文件和文本分片会保留，重新入库按当前平台单价计费。')
const db = new Db({ url: migrateDatabaseUrl() })
try {
  const cfg = embeddingConfig()
  if (cfg.error) throw new Error(cfg.error)
  const count = await db.reindexKnowledgeVectors(cfg.profile, cfg.model, cfg.dimension)
  console.log(`已清理旧向量并重新排队 ${count} 个文件：${cfg.model}，${cfg.dimension} 维`)
} finally { await db.close() }
