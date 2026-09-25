#!/usr/bin/env node
/**
 * Vercel 的 buildCommand：**生产构建先跑迁移**，再打包；preview 只打包。
 *
 * 为什么按 `VERCEL_ENV` 分：迁移曾经无条件挂在 buildCommand 的第一步，于是每条 PR 的
 * preview 构建都要连库——Neon 集成只给 Production 注入变量，preview 就挂在「未配置
 * GATEWAY_DATABASE_URL」上；给 Preview 配上库更坏，还没合并的分支会往库上应用迁移。
 * 只在 production 跑，这两条都不成立：进 production 的只有 main（和手动 `vercel --prod`）。
 *
 * 顺序是这里保证的：迁移在 build 里，build 没过部署就不会上线，所以新代码永远不会先于
 * 它要的表对外服务。迁移失败 = 构建失败，线上还是上一版。
 *
 * 代价：迁移跑的时候旧代码还在服务，所以**每条迁移都要跟上一版代码兼容**（只加不删；
 * 删列、改类型拆成两次发布）。详见 docs/vercel-deploy.md「迁移怎么跑」。
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const gatewayDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

if (process.env.VERCEL_ENV === 'production') {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/migrate.ts'], { cwd: gatewayDir, stdio: 'inherit' })
  if (r.status !== 0) {
    console.error('satuwork-gateway: 迁移没跑过，不打包——这次部署不上线')
    process.exit(r.status ?? 1)
  }
} else {
  console.log(`satuwork-gateway: VERCEL_ENV=${process.env.VERCEL_ENV || '(无)'}，不是 production，跳过迁移`)
}

await import('./build-vercel.mjs')
