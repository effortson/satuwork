/**
 * Anthropic 协议开了推理（extended thinking）之后的一轮工具调用。
 *
 * 要钉的是一件**不报错、只在第二步才炸**的事：思考块和它的签名要是没留住，一步里调了
 * 工具，下一步回放那条 assistant 消息时就带不出思考块，Anthropic 回 400「final assistant
 * message must start with a thinking block」——开了推理的 Bot 一用工具就失败。
 *
 * 顺带钉住用量：输入和缓存的 token 在 message_start 里，message_delta 只报输出。
 *
 * 探针要 tsx 才 import 得了 .ts，由 e2e/anthropic-thinking.mjs 另起一个进程跑。
 */
import { createServer } from 'node:http'
import { streamViaGateway, toAnthropic } from './src/llm/gateway.ts'
import { stubModel } from './src/llm/stream.ts'

const server = createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    ev('message_start', {
      message: { id: 'm', type: 'message', role: 'assistant', model: 'probe', content: [], usage: { input_tokens: 900, cache_read_input_tokens: 400, cache_creation_input_tokens: 50, output_tokens: 1 } },
    })
    ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } })
    ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: '先查天气' } })
    ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'SIG-abc' } })
    ev('content_block_stop', { index: 0 })
    ev('content_block_start', { index: 1, content_block: { type: 'redacted_thinking', data: 'ENC-xyz' } })
    ev('content_block_stop', { index: 1 })
    ev('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'now', input: {} } })
    ev('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{}' } })
    ev('content_block_stop', { index: 2 })
    ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } })
    ev('message_stop', {})
    res.end()
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
process.env.GATEWAY_URL = `http://127.0.0.1:${server.address().port}`
process.env.GATEWAY_API_KEY = 'probe'

const model = stubModel('anthropic', 'claude-probe')
const stream = await streamViaGateway(model, { messages: [{ role: 'user', content: '现在几点' }], systemPrompt: '' }, { reasoning: 'high' })
let final = null
const events = []
for await (const e of stream) {
  events.push(e.type)
  if (e.type === 'done' || e.type === 'error') final = e.message ?? e.error
}

// 第二步：把第一步的 assistant 消息和工具结果放回去，看发出去的请求体。
const step2 = (assistant) =>
  toAnthropic(
    {
      messages: [
        { role: 'user', content: '现在几点' },
        assistant,
        { role: 'toolResult', toolCallId: 'toolu_1', toolName: 'now', content: [{ type: 'text', text: '10:00' }], isError: false },
      ],
    },
    model,
    { reasoning: 'high' },
  )
const withThinking = step2(final)
// 从日志重建的历史不带推理块（toAgentMessages 有意不回传）：这时不能开推理，否则整次 400。
const rebuilt = step2({ ...final, content: final.content.filter((c) => c.type !== 'thinking') })
// 新的一轮（最后一条是人说的话）：照常开推理。
const freshTurn = toAnthropic({ messages: [{ role: 'user', content: '再说一遍' }] }, model, { reasoning: 'high' })

const out = {
  blocks: final.content.map((c) => c.type),
  thinking: final.content.filter((c) => c.type === 'thinking').map((c) => ({ text: c.thinking, sig: c.thinkingSignature, redacted: !!c.redacted })),
  events,
  usage: final.usage,
  replayed: withThinking.messages[1].content.map((c) => ({ type: c.type, signature: c.signature, data: c.data })),
  withThinkingOn: !!withThinking.thinking,
  rebuiltOn: !!rebuilt.thinking,
  freshOn: !!freshTurn.thinking,
}
server.close()
console.log('__RESULT__' + JSON.stringify(out))
