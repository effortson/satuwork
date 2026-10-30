import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { test } from 'node:test'
import { emptyKnowledgeEmbedding, type KnowledgeEmbeddingSettings } from '../src/db.ts'
import { EMBEDDING_PRESETS, type EmbeddingConfig, embedTexts, embeddingSecretName, resolveEmbedding } from '../src/lib/knowledge-embedding.ts'

const NO_ENV = {}
// 本机的假服务听在 127.0.0.1：只有打开这个开关才不过 SSRF 闸。
const LOCAL_ENV = { GATEWAY_KB_EMBEDDING_ALLOW_PRIVATE: '1' }
function custom(base: string, extra: Partial<KnowledgeEmbeddingSettings> = {}): KnowledgeEmbeddingSettings {
  return { ...emptyKnowledgeEmbedding(), provider: 'custom', baseUrl: base, model: 'BAAI/bge-m3', ...extra }
}

type Body = { input: string[]; model: string; dimensions?: number; encoding_format?: string }
async function service(handler: (body: Body, res: ServerResponse, call: number) => void, run: (cfg: EmbeddingConfig, calls: () => number) => Promise<void>, extra: Partial<KnowledgeEmbeddingSettings> = {}) {
  let calls = 0
  const server = createServer((req, res) => {
    let text = ''
    req.on('data', chunk => text += chunk)
    req.on('end', () => handler(JSON.parse(text), res, ++calls))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const cfg = resolveEmbedding(custom(`http://127.0.0.1:${port}/v1`, extra), 'test-secret-never-returned', LOCAL_ENV)
  try { await run(cfg, () => calls) } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

function vector(value = 1) { return [value, ...Array(1023).fill(0)] }
function json(res: ServerResponse, data: unknown) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)) }

test('embedding batches, reordered indices, and provider-reported usage', async () => {
  await service((body, res) => json(res, { data: body.input.map((value, index) => ({ index, embedding: vector(Number(value)) })).reverse(), usage: { prompt_tokens: 20 } }), async (cfg, calls) => {
    const usage: number[] = []
    const out = await embedTexts(cfg, Array.from({ length: 33 }, (_, i) => String(i + 1)), undefined, async tokens => { usage.push(tokens!) })
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
  test('rejects ' + name, async () => service((_body, res) => json(res, { data }), async cfg => {
    await assert.rejects(embedTexts(cfg, ['a', 'b']), /向量服务返回/)
  }))
}

test('429 retries without exposing the response body or permanently failing ingestion', async () => {
  await service((_body, res, call) => {
    if (call === 1) { res.writeHead(429, { 'retry-after': '0' }); res.end('test-secret-never-returned'); return }
    json(res, { data: [{ index: 0, embedding: vector() }] })
  }, async (cfg, calls) => { assert.equal((await embedTexts(cfg, ['a'])).length, 1); assert.equal(calls(), 2) })
})

test('provider authentication errors are sanitized', async () => {
  await service((_body, res) => { res.writeHead(401); res.end('test-secret-never-returned') }, async cfg => {
    await assert.rejects(embedTexts(cfg, ['a']), (error: { status: number; message: string }) => error.status === 503 && error.message.includes('401') && !error.message.includes('test-secret'))
  })
})

test('timeout is bounded by the caller deadline', async () => {
  await service(() => {}, async cfg => {
    const before = Date.now()
    await assert.rejects(embedTexts(cfg, ['a'], Date.now() + 150), /超时/)
    assert.ok(Date.now() - before < 1500)
  })
})

test('key rotation keeps the vector space; model changes do not', () => {
  const before = resolveEmbedding(custom('https://example.com/v1'), 'a', NO_ENV)
  assert.equal(resolveEmbedding(custom('https://example.com/v1'), 'rotated', NO_ENV).profile, before.profile)
  assert.notEqual(resolveEmbedding(custom('https://example.com/v1', { model: 'different-model' }), 'a', NO_ENV).profile, before.profile)
  assert.ok(resolveEmbedding(custom('https://user:secret@example.com/v1'), 'a', NO_ENV).error)
  assert.ok(resolveEmbedding(custom('http://example.com/v1'), 'a', NO_ENV).error)
})

test('presets fix the address and batch size; the model can be overridden', () => {
  const dashscope = resolveEmbedding({ ...emptyKnowledgeEmbedding(), provider: 'dashscope', baseUrl: 'https://evil.example/v1', batchSize: 64 }, 'k', NO_ENV)
  assert.equal(dashscope.base, 'https://dashscope.aliyuncs.com/compatible-mode/v1')
  assert.equal(dashscope.model, 'text-embedding-v4')
  assert.equal(dashscope.batchSize, 10)
  assert.equal(dashscope.sendDimensions, true)
  const large = resolveEmbedding({ ...emptyKnowledgeEmbedding(), region: 'intl', provider: 'openai', model: 'text-embedding-3-large' }, 'k', NO_ENV)
  assert.equal(large.model, 'text-embedding-3-large')
  assert.ok(EMBEDDING_PRESETS.every((p) => p.models.includes(p.model)))
  assert.match(resolveEmbedding({ ...emptyKnowledgeEmbedding(), provider: 'nope' }, 'k', NO_ENV).error, /不认识/)
})

test('page settings win; legacy env vars only fill in when nothing is configured', () => {
  const env = { KB_EMBEDDING_API_KEY: 'env-key' }
  const legacy = resolveEmbedding(emptyKnowledgeEmbedding(), '', env)
  assert.equal(legacy.source, 'env')
  assert.equal(legacy.token, 'env-key')
  // 页面上选硅基流动 + bge-m3，和老环境变量的默认值是同一个向量空间：升级上来不用重建。
  const page = resolveEmbedding({ ...emptyKnowledgeEmbedding(), provider: 'siliconflow' }, 'page-key', env)
  assert.equal(page.source, 'settings')
  assert.equal(page.token, 'page-key')
  assert.equal(page.profile, legacy.profile)
  const none = resolveEmbedding(emptyKnowledgeEmbedding(), '', NO_ENV)
  assert.equal(none.source, 'none')
  assert.ok(none.error)
})

test('dimensions are sent only when the model needs it', async () => {
  const seen: Body[] = []
  const answer = (body: Body, res: ServerResponse) => { seen.push(body); json(res, { data: body.input.map((_v, index) => ({ index, embedding: vector() })) }) }
  await service(answer, async cfg => { await embedTexts(cfg, ['a']) })
  await service(answer, async cfg => { await embedTexts(cfg, ['a']) }, { dimensions: true })
  assert.equal(seen[0].dimensions, undefined)
  assert.equal(seen[1].dimensions, 1024)
  assert.ok(seen.every((b) => b.encoding_format === undefined))
})

test('page-entered custom URLs cannot reach private addresses', async () => {
  let hit = false
  await service((_body, res) => { hit = true; json(res, { data: [{ index: 0, embedding: vector() }] }) }, async (cfg) => {
    const guarded = { ...cfg, allowPrivate: false }
    await assert.rejects(embedTexts(guarded, ['a']), /内网/)
    assert.equal(hit, false)
  })
  assert.equal(resolveEmbedding(custom('https://example.com/v1'), 'k', NO_ENV).allowPrivate, false)
  assert.equal(resolveEmbedding(emptyKnowledgeEmbedding(), '', { KB_EMBEDDING_API_KEY: 'k' }).allowPrivate, true)
})

test('the custom key is bound to the base URL origin; presets are not', () => {
  assert.equal(embeddingSecretName('custom', 'https://a.example/v1'), embeddingSecretName('custom', 'https://a.example/other'))
  assert.notEqual(embeddingSecretName('custom', 'https://a.example/v1'), embeddingSecretName('custom', 'https://b.example/v1'))
  assert.equal(embeddingSecretName('openai', 'https://anything.example'), 'kb-embedding:openai')
})
