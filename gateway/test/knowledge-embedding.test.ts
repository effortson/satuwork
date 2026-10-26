import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { test } from 'node:test'
import { embedTexts, embeddingConfig } from '../src/lib/knowledge-embedding.ts'

async function service(handler: (body: { input: string[] }, res: ServerResponse, call: number) => void, run: (calls: () => number) => Promise<void>) {
  let calls = 0
  const server = createServer((req, res) => {
    let text = ''
    req.on('data', chunk => text += chunk)
    req.on('end', () => handler(JSON.parse(text), res, ++calls))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const previous = { ...process.env }
  const port = (server.address() as { port: number }).port
  process.env.KB_EMBEDDING_BASE_URL = `http://127.0.0.1:${port}/v1`
  process.env.KB_EMBEDDING_API_KEY = 'test-secret-never-returned'
  process.env.KB_EMBEDDING_MODEL = 'BAAI/bge-m3'
  process.env.KB_EMBEDDING_DIMENSIONS = '1024'
  try { await run(() => calls) } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]
    Object.assign(process.env, previous)
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

function vector(value = 1) { return [value, ...Array(1023).fill(0)] }
function json(res: ServerResponse, data: unknown) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)) }

test('embedding batches, reordered indices, and provider-reported usage', async () => {
  await service((body, res) => json(res, { data: body.input.map((value, index) => ({ index, embedding: vector(Number(value)) })).reverse(), usage: { prompt_tokens: 20 } }), async calls => {
    const usage: number[] = []
    const out = await embedTexts(Array.from({ length: 33 }, (_, i) => String(i + 1)), undefined, async tokens => { usage.push(tokens!) })
    assert.deepEqual(out.map(v => v[0]), Array.from({ length: 33 }, (_, i) => i + 1))
    assert.equal(calls(), 3)
    assert.deepEqual(usage, [20, 20, 20])
  })
})

for (const [name, data] of [
  ['missing vector', []],
  ['duplicate index', [{ index: 0, embedding: vector() }, { index: 0, embedding: vector() }]],
  ['wrong dimension', [{ index: 0, embedding: [1] }, { index: 1, embedding: vector() }]],
  ['zero vector', [{ index: 0, embedding: Array(1024).fill(0) }, { index: 1, embedding: vector() }]],
  ['non numeric vector', [{ index: 0, embedding: ['secret', ...Array(1023).fill(0)] }, { index: 1, embedding: vector() }]],
] as const) {
  test('rejects ' + name, async () => service((_body, res) => json(res, { data }), async () => {
    await assert.rejects(embedTexts(['a', 'b']), /向量服务返回/)
  }))
}

test('429 retries without exposing the response body or permanently failing ingestion', async () => {
  await service((_body, res, call) => {
    if (call === 1) { res.writeHead(429, { 'retry-after': '0' }); res.end('test-secret-never-returned'); return }
    json(res, { data: [{ index: 0, embedding: vector() }] })
  }, async calls => { assert.equal((await embedTexts(['a'])).length, 1); assert.equal(calls(), 2) })
})

test('provider authentication errors are sanitized', async () => {
  await service((_body, res) => { res.writeHead(401); res.end('test-secret-never-returned') }, async () => {
    await assert.rejects(embedTexts(['a']), (error: { status: number; message: string }) => error.status === 503 && error.message.includes('401') && !error.message.includes('test-secret'))
  })
})

test('timeout is bounded by the caller deadline', async () => {
  await service(() => {}, async () => {
    const before = Date.now()
    await assert.rejects(embedTexts(['a'], Date.now() + 150), /超时/)
    assert.ok(Date.now() - before < 1500)
  })
})

test('key rotation keeps the vector space; model changes do not', async () => {
  await service(() => {}, async () => {
    const before = embeddingConfig().profile
    process.env.KB_EMBEDDING_API_KEY = 'rotated'
    assert.equal(embeddingConfig().profile, before)
    process.env.KB_EMBEDDING_MODEL = 'different-model'
    assert.notEqual(embeddingConfig().profile, before)
    process.env.KB_EMBEDDING_BASE_URL = 'https://user:secret@example.com/v1'
    assert.ok(embeddingConfig().error)
  })
})
