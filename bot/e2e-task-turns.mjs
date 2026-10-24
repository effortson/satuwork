/**
 * 主 Bot 派来的活那几轮不进后续上下文（docs/bot-tasks.md §7，src/agent/task-turns.ts）。
 *
 * 线上的样子：设计师被派了一件活，跑到一半主 Bot 那边按了停止；人过一会儿在设计师的对话里说
 * 「你好」，它又调了 21 次工具把那件作废的活接着做完。原因是那一轮原样留在上下文里，模型看见的
 * 最后一件事是「一件没做完的活」。
 *
 * 纯函数，不起服务——探针要 tsx 才 import 得了 .ts。
 */
import { toAgentMessages } from './src/agent/index.ts'
import { withoutTaskTurns } from './src/agent/task-turns.ts'

const T = Date.parse('2026-10-24T06:00:00Z')
let seq = 0
const ev = (type, data) => ({ seq: ++seq, time: T + seq * 1000, type, data })
const um = (text) => ({ id: 'u' + seq, role: 'user', content: [{ type: 'text', text }] })
const am = (turn, step, content) => ({
  turn,
  step,
  message: { id: 'a' + seq, role: 'assistant', content },
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, reasoningTokens: 0 },
})
const TASK = { kind: 'plugin', plugin: 'task', form: 'tk-1', phase: 'instruction', from: { id: 'main', name: '我的助手' } }

const textOf = (msgs) => JSON.stringify(msgs.map((m) => m.content))

// 一、人聊一轮 → 派来一件活（自己一轮，调了工具，被停）→ 人再说一句。
seq = 0
const stopped = [
  ev('session', { version: 5, id: 's', createdAt: T, botId: 'designer' }),
  ev('user/message', { message: um('帮我看看这个配色'), source: { kind: 'user' } }),
  ev('turn/start', { turn: 1 }),
  ev('assistant/message', am(1, 1, [{ type: 'text', text: '配色偏冷，建议加一点暖色。' }])),
  ev('turn/end', { turn: 1, reason: 'completed' }),
  ev('user/message', { message: um('【主 Bot「我的助手」派来的任务】\n循环 6 轮搜设计趋势，写进 tool_log_ds.txt'), source: TASK }),
  ev('turn/start', { turn: 2 }),
  ev('step/start', { turn: 2, step: 1 }),
  ev('tool/call', { turn: 2, step: 1, callId: 'c1', name: 'web_search', arguments: '{"query":"dashboard trends"}' }),
  ev('tool/result', { turn: 2, step: 1, callId: 'c1', text: '5 条结果', isError: false }),
  ev('assistant/message', am(2, 1, [{ type: 'text', text: '第 1 轮搜完了，接着第 2 轮。' }, { type: 'tool-call', callId: 'c1', name: 'web_search', arguments: { query: 'dashboard trends' } }])),
  ev('todo/list', { callId: 't1', items: [{ id: '1', task: '第 2 轮', status: 'in_progress' }] }),
  ev('turn/end', { turn: 2, reason: 'aborted' }),
]
const afterStop = await toAgentMessages(stopped, { api: 'openai-completions', provider: 'p', id: 'm' })

// 二、老席位把派活插进了人正跑着的那一轮（steered）：那一轮是人的，只去掉指令那一句。
seq = 0
const steered = [
  ev('session', { version: 5, id: 's2', createdAt: T, botId: 'designer' }),
  ev('user/message', { message: um('人问的事'), source: { kind: 'user' } }),
  ev('turn/start', { turn: 1 }),
  ev('user/message', { message: um('【主 Bot「我的助手」派来的任务】\n插进来的活'), source: TASK }),
  ev('assistant/message', am(1, 1, [{ type: 'text', text: '人那件事的回答' }])),
  ev('turn/end', { turn: 1, reason: 'completed' }),
]
const steeredKept = withoutTaskTurns(steered).map((e) => e.seq)

// 三、派活那一轮中间落了一条压缩点：边界不能跟着被丢掉，丢了 toAgentMessages 就认不出从哪开始。
seq = 0
const withCompact = [
  ev('user/message', { message: um('【主 Bot「我的助手」派来的任务】\n做月报'), source: TASK }),
  ev('turn/start', { turn: 1 }),
  ev('session/compact', { throughSeq: 0, summary: 's', from: T, to: T }),
  ev('assistant/message', am(1, 1, [{ type: 'text', text: '月报做好了' }])),
  ev('turn/end', { turn: 1, reason: 'completed' }),
]
const compactKept = withoutTaskTurns(withCompact).map((e) => e.type)

// 四、兜底送回主 Bot 的「任务结果」（phase=result）是主 Bot 自己要处理的，照常进上下文。
seq = 0
const result = [
  ev('user/message', { message: um('【任务结果】@财务 做完了（任务：做月报）\n合计 20 万'), source: { ...TASK, phase: 'result' } }),
  ev('turn/start', { turn: 1 }),
  ev('assistant/message', am(1, 1, [{ type: 'text', text: '收到，我来汇总' }])),
  ev('turn/end', { turn: 1, reason: 'completed' }),
]
const resultKept = withoutTaskTurns(result).length

// 五、两件派来的活接连跑：后一件看不见前一件，但看得见人前面聊的。
seq = 0
const twoTasks = [
  ev('user/message', { message: um('人：我们这周主推蓝色'), source: { kind: 'user' } }),
  ev('turn/start', { turn: 1 }),
  ev('assistant/message', am(1, 1, [{ type: 'text', text: '好的，记住了' }])),
  ev('turn/end', { turn: 1, reason: 'completed' }),
  ev('user/message', { message: um('【主 Bot「我的助手」派来的任务】\n第一件'), source: TASK }),
  ev('turn/start', { turn: 2 }),
  ev('assistant/message', am(2, 1, [{ type: 'text', text: '第一件做完了' }])),
  ev('turn/end', { turn: 2, reason: 'completed' }),
]
const secondTask = await toAgentMessages(twoTasks, { api: 'openai-completions', provider: 'p', id: 'm' })

console.log(
  '__RESULT__' +
    JSON.stringify({
      afterStop: { count: afterStop.length, text: textOf(afterStop) },
      steeredKept,
      compactKept,
      resultKept,
      secondTask: textOf(secondTask),
    }),
)
