import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assignSlice, callDetail, progressOf, resultLine, traceRows } from '../src/chat/task.ts'

const ev = (type: string, data: any) => ({ type, data })
const call = (callId: string, name: string, args: unknown, step = 1) => ev('tool/call', { turn: 1, step, callId, name, arguments: JSON.stringify(args) })
const out = (callId: string, text: string, failed = false) => ev('tool/result', { turn: 1, step: 1, callId, text, failed })
const say = (text: string) => ev('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } })

test('调用和结果按 callId 配对：并行两个、回来的顺序反了也不错位', () => {
  const rows = traceRows([
    say('先抓两处'),
    call('a', 'web_extract', { urls: ['https://farside.co.uk/eth/'] }),
    call('b', 'web_search', { query: 'eth etf flows' }),
    out('b', '搜到 10 条（firecrawl，用时 1.6s）：\n\n1. …'),
    out('a', '── https://farside.co.uk/eth/ ──\n标题：Ethereum ETF Flow · 抓到 4756 字符\n\n<web_content>…'),
  ])
  assert.equal(rows.length, 3)
  assert.deepEqual(rows[0], { kind: 'say', text: '先抓两处' })
  const [a, b] = rows.slice(1) as any[]
  assert.equal(a.name, 'web_extract')
  assert.equal(a.detail, 'https://farside.co.uk/eth/')
  assert.equal(a.out, '标题：Ethereum ETF Flow · 抓到 4756 字符')
  assert.equal(b.detail, 'eth etf flows')
  assert.equal(b.out, '搜到 10 条（firecrawl，用时 1.6s）：')
  assert.equal(a.status, 'ok')
})

test('被边界挡下的标成 blocked，工具自己坏的标成 error，没回来的是 running', () => {
  const rows = traceRows([
    call('a', 'terminal', { command: 'curl -sL https://x' }),
    out('a', '这次调用被公司的行为边界挡下了：命令里的 curl 会连到外部网络。', true),
    ev('tool/policy', { callId: 'a', name: 'terminal', guard: 'no-external', outcome: 'blocked', reason: 'x' }),
    call('b', 'todo', { todos: [{ id: '1' }] }),
    out('b', '第 1 条带了 id', true),
    call('c', 'web_extract', { url: 'https://y' }),
  ]) as any[]
  assert.deepEqual(rows.map((r) => r.status), ['blocked', 'error', 'running'])
  assert.equal(rows[1].detail, '1 条')
})

test('进度：步数按 (turn, step) 去重，当前工具取最后一次，清单取最后一张快照', () => {
  const p = progressOf([
    call('a', 'web_extract', { url: 'https://a' }, 1),
    call('b', 'web_search', { query: 'q' }, 1),
    ev('todo/list', { callId: 't', items: [
      { id: '1', task: '抓数据', status: 'completed' },
      { id: '2', task: '核对 AUM', status: 'in_progress' },
      { id: '3', task: '不做了', status: 'cancelled' },
      { id: '4', task: '写结论', status: 'pending' },
    ] }),
    call('c', 'terminal', { command: 'ls tasks/' }, 2),
  ])
  assert.equal(p.steps, 2)
  assert.deepEqual(p.tool, { name: 'terminal', detail: 'ls tasks/' })
  assert.deepEqual(p.todo, { done: 1, total: 3, now: '核对 AUM' })
  assert.deepEqual(progressOf([]), { steps: 0 })
})

test('callDetail：认不出的参数退回原串开头，不留空', () => {
  assert.equal(callDetail('{"urls":["https://a","https://b"]}'), 'https://a 等 2 个')
  assert.equal(callDetail('{"timezone":"Asia/Kuala_Lumpur"}'), '{"timezone":"Asia/Kuala_Lumpur"}')
  assert.equal(callDetail('{}'), '')
  assert.equal(callDetail('not json'), 'not json')
  assert.equal(resultLine('\n── x ──\n<web_content>\n'), '')
})

test('派活那一段：从带任务 id 的指令起，到它那一轮收口；前后的日常对话不算', () => {
  const src = (form: string, phase = 'instruction') => ({ kind: 'plugin', plugin: 'task', form, phase })
  const events = [
    ev('user/message', { message: { content: '早' }, source: { kind: 'user' } }),
    ev('turn/start', { turn: 1 }),
    say('早'),
    ev('turn/end', { turn: 1, reason: 'completed' }),
    ev('user/message', { message: { content: '查一下' }, source: src('bt-1') }),
    ev('turn/start', { turn: 2 }),
    call('a', 'web_search', { query: 'q' }),
    out('a', '搜到 1 条'),
    say('查到了'),
    ev('turn/end', { turn: 2, reason: 'completed' }),
    ev('user/message', { message: { content: '谢谢' }, source: { kind: 'user' } }),
  ]
  const slice = assignSlice(events, 'bt-1')
  assert.deepEqual(slice.map((e) => e.type), ['turn/start', 'tool/call', 'tool/result', 'assistant/message', 'turn/end'])
  assert.deepEqual(assignSlice(events, 'bt-x'), [])
})
