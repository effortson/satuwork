/**
 * 模型流的空闲看门狗。
 *
 * 要证两件相反的事，缺一不可：
 *   1. 上游**静默不动**（连接还开着、一个字节都不来）时，流必须自己收口——否则
 *      agent.prompt() 永远不返回，turn/end 永远写不出去，界面永远「正在处理」。
 *   2. 上游**慢但活着**时不能误杀——只做到第 1 条太容易了：把所有流都掐掉也满足它。
 *
 * 探针要 tsx 才能 import .ts，所以由 e2e/llm-idle.mjs 另起一个进程跑。
 * 空闲上限从 SATUWORK_LLM_IDLE_MS 来，必须由父进程注入：它在模块顶层求值，
 * 进程里再改已经晚了。
 */
import { createServer } from 'node:http'
import { streamViaGateway } from './src/llm/gateway.ts'
import { stubModel } from './src/llm/stream.ts'

const IDLE = Number(process.env.SATUWORK_LLM_IDLE_MS)
let mode = 'silent'
/** 服务端收到的路径，给 relay 那条看请求打到了哪个 base。 */
const paths = []

const server = createServer((req, res) => {
  paths.push(req.url)
  req.resume()
  req.on('end', () => {
    if (mode === 'relay') {
      // 转发口：立刻答一句就收。这条测的是「打到哪」，不是空闲判据。
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      // 选路按模型的 api 走，两条路收流的解析器不是同一个：Messages 协议那条要发
      // Anthropic 的事件帧，发 OpenAI 那种 chunk 的话它一个字都读不出来。
      if (req.url.endsWith('/messages')) {
        const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
        ev('message_start', {
          message: { id: 'm', type: 'message', role: 'assistant', model: 'probe', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } },
        })
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '经管家' } })
        ev('content_block_stop', { index: 0 })
        ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
        ev('message_stop', {})
        res.end()
        return
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '经管家' } }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    if (mode === 'relayUsage') {
      /**
       * 带 `stream_options.include_usage` 时上游长什么样：**用量帧排在收口之后**，
       * 而且 `choices` 是空的。整条流的 token 数只在这一帧里，收口那一帧一个数都不带。
       */
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '经管家' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      // prompt_tokens 是**整个提示词**，命中缓存的那截在 cached_tokens 里单列。
      res.write(
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6, prompt_tokens_details: { cached_tokens: 2 } } })}\n\n`,
      )
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    // 连响应头都不给。abort 会落在 fetch 那一侧。
    if (mode === 'headless') return
    if (mode === 'silent') {
      // 头给了、正文一个字节都不来，也不关连接——线上真正的死法就是这个。
      res.flushHeaders()
      return
    }
    // 慢但活着：心跳撑过空闲上限的好几倍，最后正常吐一句话收尾。
    let n = 0
    const t = setInterval(() => {
      if (++n <= 6) return res.write(': ping\n\n')
      clearInterval(t)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '活着' } }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    }, Math.max(20, Math.floor(IDLE / 3)))
  })
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
process.env.GATEWAY_URL = `http://127.0.0.1:${server.address().port}`
process.env.GATEWAY_API_KEY = 'probe'

/** 跑一条流，把「收了什么事件、花了多久、有没有真的结束」带回来。 */
async function drain(model = stubModel('deepseek', 'probe')) {
  const at = Date.now()
  const events = []
  // 这一轮最后报出来的用量。只有 done 那一条带得出整条流的账，别的事件上都是半截。
  let usage = null
  const stream = await streamViaGateway(model, { messages: [], systemPrompt: '' })
  // 这个 for await 能不能出来，就是整件事的全部——出不来就是 agent.prompt() 挂住。
  for await (const ev of stream) {
    events.push({ type: ev.type, error: ev.error?.errorMessage || '' })
    if (ev.type === 'done') usage = ev.message?.usage ?? null
  }
  return { ms: Date.now() - at, events, usage }
}

const out = {}
mode = 'headless'
out.headless = await drain()
mode = 'silent'
out.silent = await drain()
mode = 'alive'
out.alive = await drain()
// 席位上管家转发模型调用：设了 GATEWAY_LLM_URL，/v1/* 必须打它，GATEWAY_URL 指向哪都不该碰。
// GATEWAY_URL 故意指到没人听的端口——要是补全还走它，这条就收到「Gateway 不可达」。
mode = 'relay'
process.env.GATEWAY_LLM_URL = `http://127.0.0.1:${server.address().port}/llm/`
process.env.GATEWAY_URL = 'http://127.0.0.1:9'
paths.length = 0
out.relay = { ...(await drain()), paths: [...paths] }
/**
 * 选路按**模型的 api**，不按供应商叫什么名字。
 *
 * 内置目录里有九家走 Anthropic 的 Messages 协议、名字却不是 anthropic（minimax、
 * kimi-coding、fireworks、vercel-ai-gateway…），其中四家只开这一条口。按名字认的话
 * 它们全被送到 chat 路由上，而中继的授权是按 api 判路的——那边直接回「这家走
 * /v1/messages」，到 Bot 这里就是一个 400，这九家一句话都说不出来。
 */
paths.length = 0
out.relayAnthropic = {
  ...(await drain({ ...stubModel('minimax', 'probe'), api: 'anthropic-messages' })),
  paths: [...paths],
}
paths.length = 0
out.relayOpenai = {
  ...(await drain({ ...stubModel('minimax', 'probe'), api: 'openai-completions' })),
  paths: [...paths],
}
// 收口之后才来的那一帧用量：Gateway 的授权补丁把 include_usage 加进请求体，账才算得出来，
// 而这一头要接得住——接不住的话钱收对了，界面上这一轮还是 0。
mode = 'relayUsage'
out.relayUsage = await drain()
delete process.env.GATEWAY_LLM_URL
server.close()
console.log('__RESULT__' + JSON.stringify(out))
