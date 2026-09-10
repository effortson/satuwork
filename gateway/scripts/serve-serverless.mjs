#!/usr/bin/env node
/**
 * 把函数形态的 Gateway 在本地监听起来，给 e2e 用（线上由 Vercel 接管 server，不经这里）。
 *
 *   SATUWORK_SERVERLESS_ENTRY  要装的入口：默认 ../src/serverless.ts（要 --import tsx），
 *                              也可以指到 build-vercel 打出来的 api/gateway.mjs，验的就是那个包。
 */
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const entry = process.env.SATUWORK_SERVERLESS_ENTRY || resolve(import.meta.dirname, '../src/serverless.ts')
const mod = await import(pathToFileURL(resolve(entry)).href)
const server = mod.default
const host = process.env.GATEWAY_HOST || '127.0.0.1'
const port = Number(process.env.GATEWAY_PORT || 3080)
server.listen(port, host, () => {
  console.log(`satuwork-gateway(serverless): 听在 http://${host}:${port}`)
})
