#!/usr/bin/env node
/**
 * 把函数形态的 Gateway 在本地监听起来，给 e2e 用（线上由 Vercel 的启动器接管，不经这里）。
 *
 *   SATUWORK_SERVERLESS_ENTRY  要装的入口：默认 ../src/serverless.ts（要 --import tsx），
 *                              也可以指到 build-vercel 打出来的
 *                              .vercel/output/functions/gateway.func/src/index.mjs，
 *                              验的就是那个包。
 *
 * 入口的 default 是一个 `(req, res)` 监听器（跟 Vercel 的启动器拿到的是同一个东西），这里包成
 * http.Server 再 listen。
 */
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const entry = process.env.SATUWORK_SERVERLESS_ENTRY || resolve(import.meta.dirname, '../src/serverless.ts')
const mod = await import(pathToFileURL(resolve(entry)).href)
const server = createServer(mod.default)
const host = process.env.GATEWAY_HOST || '127.0.0.1'
const port = Number(process.env.GATEWAY_PORT || 3080)
server.listen(port, host, () => {
  console.log(`satuwork-gateway(serverless): 听在 http://${host}:${port}`)
})
