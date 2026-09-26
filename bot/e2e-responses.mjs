/**
 * `api: 'openai-responses'` 的模型走 /v1/responses：选路、请求体、收流三件事。
 *
 * 起因是 gpt-5.6-sol 这一批：打 /v1/chat/completions 时「工具 + reasoning_effort」上游
 * 直接 400，而 Agent 每一轮都带工具。探针要 tsx 才 import 得了 .ts，由 e2e/responses.mjs
 * 另起一个进程跑。
 */
import { createServer } from 'node:http'
import { completeOnce, setApiLookup, streamViaGateway } from './src/llm/gateway.ts'
import { stubModel } from './src/llm/stream.ts'

/** 假 Gateway 收到的每一次请求：{ path, body }。 */
const seen = []
/** 这一次流式要吐的 Responses 事件。 */
let events = []
/** 非流式那一次要回的整包。 */
let json = null

const server = createServer((req, res) => {
  let buf = ''
  req.on('data', (d) => (buf += d))
  req.on('end', () => {
    let body = null
    try {
      body = JSON.parse(buf)
    } catch {}
    seen.push({ path: req.url, body })
    if (body?.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(json))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    res.end()
  })
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
process.env.GATEWAY_URL = `http://127.0.0.1:${server.address().port}`
process.env.GATEWAY_API_KEY = 'probe'

const model = { ...stubModel('openai', 'gpt-5.6-sol'), api: 'openai-responses', reasoning: true }

async function drain(context, options) {
  const stream = await streamViaGateway(model, context, options)
  let final = null
  let error = null
  for await (const ev of stream) {
    if (ev.type === 'done') final = ev.message
    if (ev.type === 'error') error = ev.error?.errorMessage ?? 'error'
  }
  const content = final?.content ?? []
  return {
    error,
    stopReason: final?.stopReason ?? null,
    usage: final?.usage ?? null,
    text: content.filter((c) => c.type === 'text').map((c) => c.text).join(''),
    tools: content.filter((c) => c.type === 'toolCall').map((c) => ({ id: c.id, name: c.name, args: c.arguments })),
    blocks: content.map((c) => c.type),
  }
}

const out = {}

// ① 一轮带工具、带推理档：推理条目占 output_index 0，正文 1，工具 2。
events = [
  { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
  { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] } },
  { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: '我先' },
  { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: '查一下。' },
  { type: 'response.output_item.done', output_index: 1, item: { type: 'message', id: 'msg_1' } },
  { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_x', name: 'web_search', arguments: '' } },
  { type: 'response.function_call_arguments.delta', output_index: 2, item_id: 'fc_1', delta: '{"q":"印尼' },
  { type: 'response.function_call_arguments.delta', output_index: 2, item_id: 'fc_1', delta: ' 山火"}' },
  { type: 'response.function_call_arguments.done', output_index: 2, item_id: 'fc_1', arguments: '{"q":"印尼 山火"}' },
  { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_x', name: 'web_search', arguments: '{"q":"印尼 山火"}' } },
  {
    type: 'response.completed',
    response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 20, total_tokens: 120 } },
  },
]
seen.length = 0
out.toolTurn = await drain(
  {
    systemPrompt: '你是助手',
    tools: [{ name: 'web_search', description: '搜', parameters: { type: 'object', properties: { q: { type: 'string' } } } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] },
      // 历史里一把来自 Anthropic 的调用：id 带的字符 Responses 不一定收，要规整，两头一致。
      { role: 'assistant', content: [{ type: 'text', text: '好' }, { type: 'toolCall', id: 'toolu_01.ab', name: 'now', arguments: {} }] },
      { role: 'toolResult', toolCallId: 'toolu_01.ab', content: [{ type: 'text', text: '十点' }] },
      { role: 'user', content: '查山火' },
    ],
  },
  { reasoning: 'high' },
)
out.toolTurn.request = seen[0]

// ② 顶到输出上限：incomplete + max_output_tokens → length。
events = [
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_2' } },
  { type: 'response.output_text.delta', output_index: 0, delta: '写到一半' },
  { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 5, output_tokens: 9 } } },
]
seen.length = 0
out.cut = await drain({ messages: [{ role: 'user', content: 'hi' }] }, { reasoning: 'off' })
out.cut.request = seen[0]

// ③ 上游在流里报错：不能当成正常收口的空回答。
events = [
  { type: 'response.created', response: { id: 'resp_3' } },
  { type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: '上游炸了' } } },
]
out.failed = await drain({ messages: [{ role: 'user', content: 'hi' }] })

// ④ 非流式（摘要、审计）：按目录的 api 选到 /v1/responses，正文从 output[] 里取。
setApiLookup((provider, id) => (provider === 'openai' && id === 'gpt-5.6-sol' ? 'openai-responses' : undefined))
json = {
  output: [
    { type: 'reasoning', id: 'rs_9', summary: [] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '摘要在此' }] },
  ],
}
seen.length = 0
const once = await completeOnce({ provider: 'openai', model: 'gpt-5.6-sol', system: 'sys', user: 'u', reasoningEffort: 'low', timeoutMs: 5000 })
out.once = { ...once, request: seen[0] }

console.log('__RESULT__' + JSON.stringify(out))
server.close()
