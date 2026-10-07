#!/usr/bin/env node
/**
 * 把 `@vercel/blob/client` 打成一个浏览器脚本：`gateway/ui/blob-client.js`，挂在
 * `window.VercelBlobClient` 上。界面是普通脚本（不是 module、没有打包器），知识库页浏览器
 * 直传 Blob 要用它的 `upload()`——自己照协议发 PUT 太脆，SDK 换一版就断。
 *
 * 产物提交进仓库（和 unzip.js 一样算界面的一部分）；升级 @vercel/blob 后重跑一次：
 *
 *   node gateway/scripts/build-blob-client.mjs
 */
import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await build({
  entryPoints: [resolve(root, 'scripts/blob-client-entry.mjs')],
  outfile: resolve(root, 'ui/blob-client.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'VercelBlobClient',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
})
