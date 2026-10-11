#!/usr/bin/env node
/**
 * 把 @satuwork/core（core/src/index.ts）打成一个浏览器脚本：`gateway/ui/core.js`，挂在
 * `window.SatuCore` 上。界面是普通脚本（不是 module、没有打包器），core 是 TypeScript 模块，
 * 中间要有这一道。和 build-blob-client.mjs 是同一条路。
 *
 * 产物提交进仓库：不提交就要在 dev.mjs、vercel-build、桌面端 prepare:ui、e2e 四处各加一次
 * 构建，漏一处就是一处 404。CI（check.yml）会重打一遍核对没漂。改了 core/src 之后：
 *
 *   node gateway/scripts/build-core.mjs
 *
 * 不压缩：产物要进 PR diff，按行能看懂比省几十 KB 重要。esbuild 版本在 gateway/package.json
 * 里钉死，同一份源码在哪台机器上打出来都一样，CI 的核对才成立。
 */
import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await build({
  entryPoints: [resolve(root, '../core/src/index.ts')],
  outfile: resolve(root, 'ui/core.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'SatuCore',
  target: 'es2020',
  minify: false,
  // 译表是中文键：默认会被转成 \uXXXX，diff 就没法看了。
  charset: 'utf8',
  legalComments: 'none',
  banner: { js: '// 由 gateway/scripts/build-core.mjs 从 core/src 打出来的，别手改；改 core/src 再重打。' },
  logLevel: 'info',
})
