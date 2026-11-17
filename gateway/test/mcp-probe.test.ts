import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { test } from 'node:test'
import { bareToken, probeMcp } from '../src/lib/mcp-probe.ts'

// 本机的假服务听在 127.0.0.1，过不了 SSRF 闸；握手逻辑用裸 fetch 测，闸单独测。
const plain = (url: string, init: RequestInit & { timeoutMs?: number }) => {
  const { timeoutMs, ...rest } = init
  return fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs ?? 3000) })
}

async function withServer(
  handler: (req: IncomingMessage, body: { method: string; id?: number }, res: ServerResponse) => void,
  run: (url: string) => Promise<void>,
) {
  const server = createServer((req, res) => {
    let text = ''
    req.on('data', (c) => (text += c))
    req.on('end', () => handler(req, JSON.parse(text), res))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  try {
    await run(`http://127.0.0.1:${port}/mcp`)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  }
}

test('bareToken 剥掉多填的 Bearer 前缀', () => {
  assert.equal(bareToken('re0_sk_abc'), 're0_sk_abc')
  assert.equal(bareToken('  Bearer re0_sk_abc '), 're0_sk_abc')
  assert.equal(bareToken('bearer   Bearer re0_sk_abc'), 're0_sk_abc')
  assert.equal(bareToken('Bearer'), '')
  assert.equal(bareToken('BearerToken123'), 'BearerToken123')
  assert.equal(bareToken(undefined), '')
})

test('握上手：带着裸 token，回工具数', async () => {
  const auth: (string | undefined)[] = []
  await withServer(
    (req, body, res) => {
      auth.push(req.headers.authorization)
      if (body.method === 'notifications/initialized') return void res.writeHead(202).end()
      if (body.method === 'tools/list') {
        // 这一条走 SSE，另一条走 JSON：两种响应形状都要认。
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'a' }, { name: 'b' }] } })}\n\n`)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }))
    },
    async (url) => {
      const out = await probeMcp({ kind: 'HTTP', endpoint: url, token: 'Bearer key-1' }, plain)
      assert.deepEqual(out, { status: 'ok', tools: 2, names: ['a', 'b'] })
      assert.deepEqual(auth, ['Bearer key-1', 'Bearer key-1', 'Bearer key-1'])
    },
  )
})

test('对端回 401：failed，带原话', async () => {
  await withServer(
    (_req, _body, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":"missing_api_key"}')
    },
    async (url) => {
      const out = await probeMcp({ kind: 'SSE', endpoint: url }, plain)
      assert.equal(out.status, 'failed')
      assert.match((out as { error: string }).error, /HTTP 401.*missing_api_key/)
    },
  )
})

test('stdio 和内网地址是 skipped，不是 failed', async () => {
  assert.equal((await probeMcp({ kind: 'stdio', endpoint: 'npx x' })).status, 'skipped')
  // 走真的 SSRF 闸：127.0.0.1 在握手之前就被拦下。
  assert.equal((await probeMcp({ kind: 'HTTP', endpoint: 'http://127.0.0.1:9/mcp' })).status, 'skipped')
})

test('地址不合法：failed', async () => {
  assert.equal((await probeMcp({ kind: 'HTTP', endpoint: 'not a url' })).status, 'failed')
})
