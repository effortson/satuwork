#!/usr/bin/env node
/**
 * 把函数形态的 Gateway（src/serverless.ts）打成 Vercel 的 **Build Output API** 目录：
 * `.vercel/output/`。
 *
 * 为什么不是 `api/gateway.mjs` + vercel.json 的 `functions`：那条路走不通。Vercel 先扫仓库里
 * 已有的文件、拿这份清单跑 detectBuilders 校验 `functions` 的 glob，**然后**才轮到
 * installCommand / buildCommand。构建期才生成的文件那时还不存在，只会得到
 * 「The pattern "api/gateway.mjs" ... doesn't match any Serverless Functions」。要么把打好的包
 * 提交进版本库，要么自己产出 Build Output——这里选后者。
 *
 * 顺带避掉另一件事：`functions` 那套要配 `outputDirectory`，而 `outputDirectory: "."` 会让
 * static-build 把整个仓库当静态资源传上去（源码就公开了）。产出 .vercel/output 之后
 * static-build 直接透传这个目录，不再看 outputDirectory。
 *
 * 为什么要 esbuild 打包而不让 Vercel 直接编 TS：这套源码到处是 `import './x.ts'`（靠 tsx 在
 * 运行时转），平台的 TS 编译不认带 .ts 后缀的 import；esbuild 认，而且顺手把依赖收进一个文件，
 * 函数里不用再装 node_modules。pg 走纯 JS（pg-native 排除），tsx 不进包——它只是本地开发的运行时。
 *
 * 目录形状照着仓库里 gateway/ 的样子摆（`src/` 挨着 `ui/`）：http.ts 里界面目录的默认值是
 * `new URL('../ui', import.meta.url)`，包在 src/index.mjs 时它正好落到 ui/，不必再配
 * GATEWAY_UI_DIR。
 *
 *   .vercel/output/config.json                                路由表：所有路径打到那一个函数
 *   .vercel/output/functions/gateway.func/.vc-config.json     运行时、入口、时长
 *   .vercel/output/functions/gateway.func/src/index.mjs       打好的包
 *   .vercel/output/functions/gateway.func/ui/**               界面静态文件（函数里从磁盘读）
 */
import { build } from 'esbuild'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const outputDir = resolve(root, '.vercel/output')
const funcDir = resolve(outputDir, 'functions/gateway.func')
const out = resolve(funcDir, 'src/index.mjs')

// 每次重来：留着上一轮的产物会把删掉的界面文件也一起带上去。
await rm(outputDir, { recursive: true, force: true })
await mkdir(dirname(out), { recursive: true })

await build({
  entryPoints: [resolve(root, 'gateway/src/serverless.ts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external: ['pg-native'],
  // 包里有 require()（pg、部分依赖是 CJS）；ESM 里要有一个 require 可用。
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'info',
})

await cp(resolve(root, 'gateway/ui'), resolve(funcDir, 'ui'), { recursive: true })

await writeFile(
  resolve(funcDir, '.vc-config.json'),
  JSON.stringify(
    {
      runtime: 'nodejs22.x',
      handler: 'src/index.mjs',
      launcherType: 'Nodejs',
      // Router 自己从 req 流里读 body（http.ts 的 readBody），不要平台再插一层 helper。
      shouldAddHelpers: false,
      // /v1 是 SSE：模型答一句推一句，不能等函数返回才flush。
      supportsResponseStreaming: true,
      // 桌面端一轮长回答（连同工具调用）别被半路砍断；上限随套餐，见 docs/vercel-deploy.md。
      maxDuration: 300,
    },
    null,
    2,
  ) + '\n',
)

// crons 留在 vercel.json 里（CLI 会并进最终的 config.json）；这里只写路由。
// 走 filesystem 之后所有路径都进那一个函数——静态界面也由它发（http.ts 的 serveUi）。
await writeFile(
  resolve(outputDir, 'config.json'),
  JSON.stringify({ version: 3, routes: [{ handle: 'filesystem' }, { src: '/(.*)', dest: '/gateway' }] }, null, 2) + '\n',
)

console.log(`build-vercel: ${outputDir}`)
