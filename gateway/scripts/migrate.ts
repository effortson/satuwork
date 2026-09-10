import { Db, databaseUrl } from '../src/db.ts'

/**
 * 只跑迁移，然后退出。给 build 步骤用（Vercel 上 `pnpm --filter satuwork-gateway migrate`），
 * Debian 上不需要——index.ts 起来时自己跑。
 *
 * 用**直连**串：迁移锁是会话级 advisory lock，过 PgBouncer 的事务池会漂（ADR §5.2）。
 * 请求路径用池化串是另一个环境变量的事（GATEWAY_DATABASE_URL），这里认
 * GATEWAY_MIGRATE_DATABASE_URL，没有就退回 GATEWAY_DATABASE_URL。
 */
const url = (process.env.GATEWAY_MIGRATE_DATABASE_URL || '').trim() || databaseUrl()
const db = new Db({ url })
try {
  const result = await db.init()
  if (result.applied.length) console.log(`satuwork-gateway: 已应用 ${result.applied.length} 条迁移：${result.applied.join(', ')}`)
  else console.log(`satuwork-gateway: 数据库已是最新（${result.current ?? '空'}）`)
} finally {
  await db.close()
}
