import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGatewayClient, type TokenStore } from '../src/api.ts'

type Call = { url: string; init: RequestInit | undefined }

function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body?: unknown; text?: string }) {
  const calls: Call[] = []
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const r = handler(url, init)
    const text = r.text != null ? r.text : r.body === undefined ? '' : JSON.stringify(r.body)
    return { status: r.status, ok: r.status >= 200 && r.status < 300, text: async () => text } as unknown as Response
  }
  return { fetch, calls }
}

function memTokens(initial: string | null = 'jwt-1'): TokenStore & { value: string | null } {
  const store = {
    value: initial,
    get: () => store.value,
    set: (t: string) => {
      store.value = t
    },
    clear: () => {
      store.value = null
    },
  }
  return store
}

function client(handler: Parameters<typeof fakeFetch>[0], extra: Partial<Parameters<typeof createGatewayClient>[0]> = {}) {
  const ff = fakeFetch(handler)
  const tokens = memTokens()
  const unauthorized: number[] = []
  const gw = createGatewayClient({
    fetch: ff.fetch,
    baseUrl: '',
    tokens,
    locale: () => 'zh',
    onUnauthorized: () => unauthorized.push(1),
    ...extra,
  })
  return { gw, calls: ff.calls, tokens, unauthorized }
}

test('gatewayAbs：相对路径接上 baseUrl（函数或字符串，去尾斜杠），绝对地址原样', () => {
  const a = createGatewayClient({ fetch: async () => ({}) as Response, baseUrl: () => 'https://gw.example/', tokens: memTokens(), locale: () => 'zh', onUnauthorized() {} })
  assert.equal(a.gatewayAbs('/me'), 'https://gw.example/me')
  assert.equal(a.gatewayAbs('https://x/y'), 'https://x/y')
  const b = createGatewayClient({ fetch: async () => ({}) as Response, baseUrl: '', tokens: memTokens(), locale: () => 'zh', onUnauthorized() {} })
  assert.equal(b.gatewayAbs('/me'), '/me')
})

test('api：带登录票、JSON 正文；空 body 回 null', async () => {
  const { gw, calls } = client(() => ({ status: 200, text: '' }))
  const r = await gw.api('POST', '/x', { a: 1 })
  assert.equal(r, null)
  const h = calls[0].init!.headers as Record<string, string>
  assert.equal(h.authorization, 'Bearer jwt-1')
  assert.equal(h['content-type'], 'application/json')
  assert.equal(calls[0].init!.body, '{"a":1}')
})

test('api：非 2xx 抛错，status 挂在错误上，文案按语言翻', async () => {
  const { gw } = client(() => ({ status: 404, body: { error: '口令至少 10 位' } }), { locale: () => 'en' })
  await assert.rejects(gw.api('GET', '/x'), (e: any) => e.status === 404 && e.message === 'Password must be at least 10 characters')
})

test('api：Gateway 的 401 → onUnauthorized 一次并抛；/auth/login 与 /invites/ 的 401 不算', async () => {
  const { gw, unauthorized } = client(() => ({ status: 401, body: { error: '需要登录' } }))
  await assert.rejects(gw.api('GET', '/me'), /需要登录/)
  assert.equal(unauthorized.length, 1)
  await assert.rejects(gw.api('POST', '/auth/login', {}), (e: any) => e.status === 401)
  await assert.rejects(gw.api('GET', '/invites/abc'), (e: any) => e.status === 401)
  assert.equal(unauthorized.length, 1)
})

test('api：请求在路上时人重新登录了，旧票的 401 不踢新票', async () => {
  const c = client(() => ({ status: 401, body: {} }))
  const p = c.gw.api('GET', '/me')
  c.tokens.set('jwt-2')
  await assert.rejects(p, (e: any) => e.status === 401)
  assert.equal(c.unauthorized.length, 0)
})

test('localRoute：只认两类路径，按对照表翻成本地 Bot 的地址', () => {
  const { gw } = client(() => ({ status: 200 }))
  assert.equal(gw.localRoute('/runtime/bots/b1/session'), null)
  gw.registerLocalBot('b1', 4321, 'sat_x')
  assert.deepEqual(gw.localRoute('/runtime/bots/b1/session?x=1'), { url: 'http://127.0.0.1:4321/api/bots/b1/session?x=1', token: 'sat_x', botId: 'b1' })
  assert.equal(gw.localBots.get('b1')!.login, 'jwt-1')
  assert.equal(gw.localRoute('/runtime/sessions/s1/history'), null)
  gw.localSessions.set('s1', 'b1')
  assert.equal(gw.localRoute('/runtime/sessions/s1/history?turns=2')!.url, 'http://127.0.0.1:4321/api/sessions/s1/history?turns=2')
  assert.equal(gw.localRoute('/runtime/sessions/s1/files?path=a', 'GET')!.url, 'http://127.0.0.1:4321/api/workspace/file?path=a')
  assert.equal(gw.localRoute('/runtime/sessions/s1/workspace?path=a', 'GET')!.url, 'http://127.0.0.1:4321/api/workspace/list?path=a')
  assert.equal(gw.localRoute('/runtime/sessions/s1/workspace?path=a', 'DELETE')!.url, 'http://127.0.0.1:4321/api/workspace/file?path=a')
  assert.equal(gw.localRoute('/orgs/o/skills'), null)
  // 登记时不给票：沿用旧票；没票的 Bot 不改道
  gw.registerLocalBot('b1', 4322)
  assert.equal(gw.localBots.get('b1')!.token, 'sat_x')
  gw.registerLocalBot('b2', 5000)
  assert.equal(gw.localRoute('/runtime/bots/b2/session'), null)
})

test('swFetch：改道的请求把登录票换成席位票', async () => {
  const { gw, calls } = client(() => ({ status: 200, body: {} }))
  gw.registerLocalBot('b1', 4321, 'sat_x')
  await gw.swFetch('/runtime/bots/b1/session', { headers: { Authorization: 'Bearer jwt-1', accept: 'x' } })
  assert.equal(calls[0].url, 'http://127.0.0.1:4321/api/bots/b1/session')
  assert.deepEqual(calls[0].init!.headers, { accept: 'x', authorization: 'Bearer sat_x' })
})

test('api：本地 Bot 的 401 → 重新要票、重试一次；不登出', async () => {
  let n = 0
  const c = client(
    (url) => {
      n++
      if (url.startsWith('http://127.0.0.1')) return n === 1 ? { status: 401, body: {} } : { status: 200, body: { ok: 1 } }
      return { status: 200, body: {} }
    },
    {
      renewLocalBot: async (botId) => {
        c.gw.registerLocalBot(botId, 4321, 'sat_new')
      },
    },
  )
  c.gw.registerLocalBot('b1', 4321, 'sat_old')
  const r = await c.gw.api('GET', '/runtime/bots/b1/session')
  assert.deepEqual(r, { ok: 1 })
  assert.equal(c.unauthorized.length, 0)
  assert.equal((c.calls[1].init!.headers as any).authorization, 'Bearer sat_new')
})

test('api：本地 Bot 重试后还是 401 → 抛本地那句，仍不登出', async () => {
  const c = client((url) => (url.startsWith('http://127.0.0.1') ? { status: 401, body: {} } : { status: 200, body: {} }), {
    renewLocalBot: async () => {},
  })
  c.gw.registerLocalBot('b1', 4321, 'sat_old')
  await assert.rejects(c.gw.api('GET', '/runtime/bots/b1/session'), /本地 Bot 拒绝了这次请求/)
  assert.equal(c.unauthorized.length, 0)
  assert.equal(c.calls.length, 2)
})
