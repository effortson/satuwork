import { Db, migrateDatabaseUrl } from '../src/db.ts'

/**
 * 只跑迁移，然后退出。Vercel 的**生产构建**先跑它再打包（scripts/vercel-build.mjs），
 * preview 不跑；要提前单独跑也行
 * （`GATEWAY_MIGRATE_DATABASE_URL=… pnpm --filter satuwork-gateway migrate`），它是幂等的。
 * 理由和代价见 docs/vercel-deploy.md 的「迁移怎么跑」。
 * Debian 上不需要——index.ts 起来时自己跑。
 *
 * 用**直连**串：迁移锁是会话级 advisory lock，过 PgBouncer 的事务池会漂（ADR §5.2）。
 * 请求路径用池化串是另一个环境变量的事（GATEWAY_DATABASE_URL）。取哪一条见
 * src/db.ts 的 migrateDatabaseUrl：GATEWAY_MIGRATE_DATABASE_URL → （Vercel 上）Neon 的
 * DATABASE_URL_UNPOOLED → 退回请求路径那条。
 */
const db = new Db({ url: migrateDatabaseUrl() })
try {
  const result = await db.init()
  if (result.applied.length) console.log(`satuwork-gateway: 已应用 ${result.applied.length} 条迁移：${result.applied.join(', ')}`)
  else console.log(`satuwork-gateway: 数据库已是最新（${result.current ?? '空'}）`)
} finally {
  await db.close()
}
