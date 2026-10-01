/**
 * Anthropic 协议开推理后的工具循环。探针在 bot/e2e-anthropic-thinking.mjs（要 tsx 才 import 得了 .ts）。
 *
 * 这一层坏了只在**第二步**才炸：第一步调了工具，第二步回放那条 assistant 消息没带思考块，
 * Anthropic 直接 400。单看第一步的流一切正常，所以得把两步连起来看请求体。
 */
import { runProbe as sharedProbe } from './probe.mjs'

const runProbe = (root) => sharedProbe(root, 'bot/e2e-anthropic-thinking.mjs', { timeout: 30_000 })

export async function runAnthropicThinking({ root, test, assert, log }) {
  log('\n# anthropic-thinking')
  const r = await runProbe(root)

  await test('思考块和签名留在消息里，也照常发出推理事件', () => {
    assert(r.blocks.join(',') === 'thinking,thinking,toolCall', `块：${r.blocks.join(',')}`)
    assert(r.thinking[0].text === '先查天气' && r.thinking[0].sig === 'SIG-abc', `思考块：${JSON.stringify(r.thinking[0])}`)
    assert(r.thinking[1].redacted && r.thinking[1].sig === 'ENC-xyz', `打码的思考块：${JSON.stringify(r.thinking[1])}`)
    assert(r.events.includes('thinking_start') && r.events.includes('thinking_delta') && r.events.includes('thinking_end'), `事件：${r.events.join(',')}`)
  })

  await test('第二步回放：assistant 以思考块开头、带着签名，推理照开', () => {
    assert(
      JSON.stringify(r.replayed) ===
        JSON.stringify([{ type: 'thinking', signature: 'SIG-abc' }, { type: 'redacted_thinking', data: 'ENC-xyz' }, { type: 'tool_use' }]),
      `回放的块：${JSON.stringify(r.replayed)}`,
    )
    assert(r.withThinkingOn, '带着思考块的那一步不该关推理')
  })

  await test('工具循环中间历史没有思考块（从日志重建过）：这一步不开推理，新的一轮照开', () => {
    assert(!r.rebuiltOn, '没有思考块还开着推理，上游会 400')
    assert(r.freshOn, '新的一轮不该被关掉推理')
  })

  await test('用量：输入和缓存从 message_start 取，输出从 message_delta 取', () => {
    const u = r.usage
    assert(u.input === 900 && u.cacheRead === 400 && u.cacheWrite === 50 && u.output === 42, `用量：${JSON.stringify(u)}`)
    assert(u.totalTokens === 900 + 400 + 50 + 42, `合计：${u.totalTokens}`)
  })
}
