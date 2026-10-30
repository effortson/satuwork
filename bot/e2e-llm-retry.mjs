/**
 * 模型调用的瞬时失败重发（gateway.ts 的 LLM_RETRIES）。
 *
 * 要证的是边界，两头都得守住：
 *   1. 还没出内容就撞上一时的失败（Gateway 回 503、流里头一帧就是「fetch failed」），重发之后照常拿到回答。
 *   2. 不该重发的不重发：明确的请求错误（400）、已经开始吐字之后才断的——后者重发会把同一段话再来一遍。
 *
 * 探针要 tsx 才能 import .ts，由 e2e/llm-retry.mjs 另起一个进程跑；重试间隔由父进程注入。
 */
import { createServer } from 'node:http'
import { streamViaGateway } from './src/llm/gateway.ts'
import { stubModel } from './src/llm/stream.ts'

let mode = ''
let hits = 0

const sse = (res, frames) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const f of frames) res.write(`data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`)
  res.end()
}
const ok = (res) => sse(res, [{ choices: [{ delta: { content: '好了' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]'])

const server = createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    hits++
    if (mode === 'http503' && hits === 1) {
      res.writeHead(503, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'fetch failed' }))
    }
    if (mode === 'frame' && hits === 1) {
      // Gateway 那边上游先断：头给了 200，第一帧就是错误帧，后面跟一个空的收口。
      return sse(res, [{ error: { message: 'fetch failed', type: 'upstream_error' } }, { choices: [{ delta: { content: '' }, finish_reason: 'stop' }] }, '[DONE]'])
    }
    if (mode === 'bad') {
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'context length exceeded' } }))
    }
    if (mode === 'down') {
      res.writeHead(502, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'bad gateway' }))
    }
    if (mode === 'midway') {
      return sse(res, [{ choices: [{ delta: { content: '写到一半' } }] }, { error: { message: 'fetch failed', type: 'upstream_error' } }, '[DONE]'])
    }
    ok(res)
  })
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
process.env.GATEWAY_URL = `http://127.0.0.1:${server.address().port}`
process.env.GATEWAY_API_KEY = 'probe'

async function drain(m) {
  mode = m
  hits = 0
  const events = []
  const stream = await streamViaGateway(stubModel('deepseek', 'probe'), { messages: [], systemPrompt: '' })
  for await (const ev of stream) events.push({ type: ev.type, delta: ev.delta || '', error: ev.error?.errorMessage || '' })
  return { hits, events }
}

const out = {}
for (const m of ['http503', 'frame', 'bad', 'down', 'midway']) out[m] = await drain(m)
// 关不掉的 keep-alive 连接会拖住进程退出，直接退。
console.log('__RESULT__' + JSON.stringify(out))
process.exit(0)
