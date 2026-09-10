#!/usr/bin/env node
/**
 * 把函数形态的 Gateway（src/serverless.ts）打成一个文件：api/gateway.mjs。
 *
 * 为什么要打包而不让 Vercel 直接编 TS：这套源码到处是 `import './x.ts'`（靠 tsx 在运行时转），
 * 平台的 TS 编译不认带 .ts 后缀的 import；esbuild 认，而且顺手把依赖收进一个文件，函数里
 * 不用再装 node_modules。pg 走纯 JS（pg-native 排除），tsx 不进包——它只是本地开发的运行时。
 *
 * 界面那批静态文件不打进去：函数里从磁盘读（http.ts 的 GATEWAY_UI_DIR），vercel.json 的
 * includeFiles 把 gateway/ui/** 带上。
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const out = resolve(root, 'api/gateway.mjs')
mkdirSync(dirname(out), { recursive: true })
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
console.log(`build-vercel: ${out}`)
