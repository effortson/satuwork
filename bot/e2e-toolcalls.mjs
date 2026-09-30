/**
 * 流式装配工具调用：`tool_calls[].index` **不是** `content[]` 的下标。
 *
 * 上游那个下标说的是「这是第几把工具」，我们 `content[]` 里还躺着正文块。混用会出两种
 * 事故，线上两种都见过：
 *
 *   1. 上游把正文算进下标（正文走 `reasoning_content`，我们不收进 content），工具从
 *      `index:1` 起——为了填到 1，0 位被补出一个空壳 `{name:'', id:''}`。它照样会被
 *      pi 拿去执行，找不到叫「」的工具，于是每轮开头挂一颗红色的「tool · 失败」，
 *      点开里面什么都没有。
 *   2. 正文先来（`content[0]` 是文字），`index:0` 的工具增量落到**正文块**上——第一把
 *      工具就此消失，界面上不留痕迹，模型却以为自己调了。
 *
 * 两条都不报错，所以只能靠这条探针钉住。探针要 tsx 才 import 得了 .ts，
 * 由 e2e/toolcalls.mjs 另起一个进程跑。
 */
import { createServer } from 'node:http'
import { streamViaGateway } from './src/llm/gateway.ts'
import { toAgentMessages } from './src/agent/index.ts'
import { stubModel } from './src/llm/stream.ts'

/** 一段 SSE。每个元素是一个 choices[0].delta。 */
let frames = []

const server = createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
process.env.GATEWAY_URL = `http://127.0.0.1:${server.address().port}`
process.env.GATEWAY_API_KEY = 'probe'

const delta = (d, finish) => ({ choices: [{ delta: d, ...(finish ? { finish_reason: finish } : {}) }] })

/** 跑一条流，把最终那条消息里的工具调用和正文带回来。 */
async function drain() {
  const stream = await streamViaGateway(stubModel('deepseek', 'probe'), { messages: [], systemPrompt: '' })
  let final = null
  const starts = []
  for await (const ev of stream) {
    if (ev.type === 'toolcall_start') starts.push(ev.contentIndex)
    if (ev.type === 'done' || ev.type === 'error') final = ev.message ?? ev.error
  }
  const content = final?.content ?? []
  return {
    starts,
    text: content.filter((c) => c.type === 'text').map((c) => c.text).join(''),
    tools: content.filter((c) => c.type === 'toolCall').map((c) => ({ id: c.id, name: c.name, args: c.arguments })),
    // 空壳会以 toolCall 的身份混在里面，名字是空的——这正是要抓的东西。
    blocks: content.map((c) => c.type),
  }
}

const out = {}

// ① 上游按整条消息给下标：推理占了 0，工具从 1 起。
frames = [
  delta({ role: 'assistant' }),
  delta({ tool_calls: [{ index: 1, id: 'call_a', type: 'function', function: { name: 'web_search', arguments: '' } }] }),
  delta({ tool_calls: [{ index: 1, function: { arguments: '{"q":"印尼 山火"}' } }] }),
  delta({ tool_calls: [{ index: 2, id: 'call_b', type: 'function', function: { name: 'web_extract', arguments: '{"url":"x"}' } }] }),
  delta({}, 'tool_calls'),
]
out.offsetIndex = await drain()

// ② 正文先来，工具从 0 起。第一把不能落到正文块上。
frames = [
  delta({ role: 'assistant' }),
  delta({ content: '我先查一下。' }),
  delta({ tool_calls: [{ index: 0, id: 'call_c', type: 'function', function: { name: 'web_search', arguments: '{"q":"a"}' } }] }),
  delta({ tool_calls: [{ index: 1, id: 'call_d', type: 'function', function: { name: 'now', arguments: '{}' } }] }),
  delta({}, 'tool_calls'),
]
out.textFirst = await drain()

// ③ 老老实实从 0 开始、没有正文的那种，必须原样还是原样。
frames = [
  delta({ role: 'assistant' }),
  delta({ tool_calls: [{ index: 0, id: 'call_e', type: 'function', function: { name: 'now', arguments: '{}' } }] }),
  delta({}, 'tool_calls'),
]
out.plain = await drain()

/**
 * ④ 已经写下的日志里那些空壳：重建历史时连它的结果一起丢掉。
 *
 * 上面那个装配错位是修好了，可日志改不了。回传一把叫「」的工具，好一点是白占 token
 * 外加教模型「可以有空名字的调用」，坏一点是上游直接拒收整条请求（name 空、
 * tool_call_id 空），那这个会话从此一句话都答不了。
 */
let seq = 0
const ev = (type, data) => ({ seq: ++seq, time: Date.parse('2026-08-21T02:00:00Z'), type, data })
const replayed = await toAgentMessages(
  [
    ev('session', { version: 4, id: 's', createdAt: 1, botId: 'b' }),
    ev('user/message', { message: { id: 'u1', role: 'user', content: [{ type: 'text', text: '查一下' }] }, source: { kind: 'user' } }),
    ev('turn/start', { turn: 1 }),
    ev('tool/result', { turn: 1, step: 1, callId: '', text: 'Tool  not found', failed: true }),
    ev('tool/result', { turn: 1, step: 1, callId: 'call_a', text: '搜到了', failed: false }),
    ev('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: 'a1',
        role: 'assistant',
        content: [
          { type: 'tool-call', callId: '', name: '', arguments: '{}' },
          { type: 'tool-call', callId: 'call_a', name: 'web_search', arguments: '{"q":"x"}' },
        ],
      },
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, reasoningTokens: 0 },
    }),
    ev('turn/end', { turn: 1, reason: 'completed' }),
  ],
  { api: 'openai-completions', provider: 'p', model: 'm' },
)
out.replay = {
  calls: replayed
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => (m.content ?? []).filter((c) => c.type === 'toolCall').map((c) => ({ id: c.id, name: c.name }))),
  results: replayed.filter((m) => m.role === 'toolResult').map((m) => m.toolCallId),
}

/**
 * ⑤ 进程死在一步中间：工具结果落盘了，带 tool-call 的助手消息还没有（它要等这一步所有工具
 * 跑完才写）。以前重建时那条结果被当成无主的丢掉——邮件已经发了，下一轮模型却不知道。
 */
seq = 0
const crashed = await toAgentMessages(
  [
    ev('session', { version: 4, id: 's', createdAt: 1, botId: 'b' }),
    ev('user/message', { message: { id: 'u1', role: 'user', content: [{ type: 'text', text: '发封邮件再跑个脚本' }] }, source: { kind: 'user' } }),
    ev('turn/start', { turn: 1 }),
    ev('step/start', { turn: 1, step: 1 }),
    ev('tool/call', { turn: 1, step: 1, callId: 'call_mail', name: 'send_email', arguments: '{"to":"a@b.c"}' }),
    ev('tool/call', { turn: 1, step: 1, callId: 'call_sh', name: 'terminal', arguments: '{"command":"sleep 999"}' }),
    ev('tool/result', { turn: 1, step: 1, callId: 'call_mail', text: '已发送', failed: false }),
    // 进程在这里被杀；开机后 healDanglingTurn 补了一条 turn/end。
    ev('turn/end', { turn: 1, reason: 'error' }),
    ev('user/message', { message: { id: 'u2', role: 'user', content: [{ type: 'text', text: '刚才怎么样了' }] }, source: { kind: 'user' } }),
  ],
  { api: 'openai-completions', provider: 'p', model: 'm' },
)
out.crashed = {
  roles: crashed.map((m) => m.role),
  calls: crashed.filter((m) => m.role === 'assistant').flatMap((m) => m.content.filter((c) => c.type === 'toolCall').map((c) => c.name)),
  results: crashed.filter((m) => m.role === 'toolResult').map((m) => `${m.toolCallId}:${m.isError ? 'err' : 'ok'}:${m.content[0].text}`),
}

console.log('__RESULT__' + JSON.stringify(out))
server.close()
