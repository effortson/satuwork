import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { test } from 'node:test'
import { signJwt, type JwtKeys } from '../src/crypto.ts'
import { Router } from '../src/http.ts'
import { attachRuntime } from '../src/routes/runtime.ts'
import type { RouteCtx } from '../src/routes/ctx.ts'

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return 'http://127.0.0.1:' + (server.address() as { port: number }).port
}

test('Gateway forwards the UI reply language and falls back to the account for older clients', async t => {
  const forwarded: any[] = []
  const seat = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    forwarded.push(JSON.parse(raw))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"accepted":true}')
  })
  const seatBase = await listen(seat)
  const account = { id: 'user', companyId: 'company', role: 'member', status: 'active', locale: 'en' }
  const db = {
    account: async () => account,
    company: async () => ({ status: 'active' }),
    sessionIndex: async () => ({ accountId: account.id, botId: 'designer' }),
    instance: async () => ({ host: seatBase }),
    seatRuntime: async () => ({ machineId: 'machine' }),
    machine: async () => ({ token: 'smt_probe' }),
    accountSecrets: async () => ({ accessToken: 'sat_probe' }),
  }
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const keys: JwtKeys = {
    kid: 'reply-language',
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
  const router = new Router()
  attachRuntime(router, { db, keys } as unknown as RouteCtx)
  const gateway = createServer((req, res) => void router.handle(req, res))
  t.after(async () => {
    for (const server of [gateway, seat]) {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
  const base = await listen(gateway)
  const token = signJwt(keys, { sub: account.id, accountId: account.id, companyId: account.companyId, role: account.role }, 3600)
  async function send(locale?: unknown) {
    const response = await fetch(base + '/runtime/sessions/chat/messages', {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello', ...(locale === undefined ? {} : { locale }) }),
    })
    assert.equal(response.status, 200, await response.text())
    return forwarded.at(-1)
  }
  assert.equal((await send()).locale, 'en')
  assert.equal((await send('zh')).locale, 'zh', 'current UI selection wins over the saved account setting')
  assert.equal((await send('en')).locale, 'en')
  assert.equal((await send('arbitrary prompt text')).locale, 'en', 'invalid locales must not become instructions')
  account.locale = 'zh'
  assert.equal((await send()).locale, 'zh')
})
