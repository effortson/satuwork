import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fold } from '../src/chat/fold.ts'

const T = Date.parse('2026-08-24T02:00:00Z')
const ev = (seq: number, type: string, data: any) => ({ seq, time: T + seq * 1000, type, data })
const um = (s: string) => ({ id: 'u' + s, role: 'user', content: [{ type: 'text', text: s }] })
const am = (s: string) => ({ id: 'a' + s, role: 'assistant', content: [{ type: 'text', text: s }] })
const usage = { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, reasoningTokens: 0 }
const COMPACT = { from: T, to: T + 6000, summary: 's', droppedMessages: 2, tokensBefore: 90500, tokensAfter: 3200 }

function twoTurns() {
  return [
    ev(1, 'session', { version: 5, id: 's1', botId: 'b', createdAt: T }),
    ev(2, 'user/message', { message: um('问一'), source: { kind: 'user' } }),
    ev(3, 'turn/start', { turn: 1 }),
    ev(4, 'assistant/message', { turn: 1, step: 1, message: am('答一'), usage }),
    ev(5, 'turn/end', { turn: 1, reason: 'completed' }),
  ]
}

test('一问一答折成两块；收口后 status 空、statusAt 归零', () => {
  const f = fold(twoTurns())
  assert.deepEqual(f.blocks.map((b) => b.kind), ['user', 'assistant'])
  assert.equal(f.status, '')
  assert.equal(f.statusAt, 0)
  assert.equal((f.blocks[1] as any).msgSeq, 4)
  assert.equal((f.blocks[1] as any).endTime, T + 5000)
})

test('正在跑：statusAt 是 turn/start 的时间；live 旗子压过扫描', () => {
  const running = twoTurns().concat([ev(6, 'user/message', { message: um('问二'), source: { kind: 'user' } }), ev(7, 'turn/start', { turn: 2 })])
  const f = fold(running)
  assert.equal(f.status, 'running')
  assert.equal(f.statusAt, T + 7000)
  assert.equal(fold(running, false).status, '')
  const relive = fold(twoTurns(), true)
  assert.equal(relive.status, 'running')
  // 历史里没有这一轮的 turn/start：退到最后一块的时间，秒表至少在走
  assert.equal(relive.statusAt, T + 5000)
})

test('压缩事件落在轮次中间：工具结果照样认得回它的药丸，回答还在同一块', () => {
  const events = twoTurns().concat([
    ev(6, 'user/message', { message: um('问二'), source: { kind: 'user' } }),
    ev(7, 'turn/start', { turn: 2 }),
    ev(8, 'tool/call', { turn: 2, step: 1, callId: 'c1', name: 'bash', arguments: '{}' }),
    ev(9, 'session/compact', { throughSeq: 5, ...COMPACT }),
    ev(10, 'tool/result', { turn: 2, step: 1, callId: 'c1', text: '跑完了', failed: false }),
    ev(11, 'assistant/message', { turn: 2, step: 1, message: am('答二'), usage }),
    ev(12, 'turn/end', { turn: 2, reason: 'completed' }),
  ])
  const blocks = fold(events).blocks
  const pills = blocks.flatMap((b: any) => b.tools || [])
  assert.equal(pills.length, 1)
  assert.equal(pills[0].result, '跑完了')
  assert.equal(pills[0].failed, false)
  const owner: any = blocks.find((b: any) => (b.tools || []).some((x: any) => x.callId === 'c1'))
  assert.equal(owner.text, '答二')
  assert.deepEqual(blocks.map((b: any) => (b.kind === 'mark' ? 'mark:' + b.mark : b.kind)), ['user', 'assistant', 'user', 'assistant', 'mark:compact'])
})

test('空壳工具调用（没名字）连同它的结果一起跳过', () => {
  const events = twoTurns().concat([
    ev(6, 'user/message', { message: um('问二'), source: { kind: 'user' } }),
    ev(7, 'turn/start', { turn: 2 }),
    ev(8, 'tool/call', { turn: 2, step: 1, callId: 'ghost', name: '', arguments: '' }),
    ev(9, 'tool/result', { turn: 2, step: 1, callId: 'ghost', text: '找不到叫「」的工具', failed: true }),
    ev(10, 'tool/call', { turn: 2, step: 2, callId: 'c2', name: 'read', arguments: '{}' }),
    ev(11, 'tool/result', { turn: 2, step: 2, callId: 'c2', text: 'ok', failed: false }),
  ])
  const pills = fold(events).blocks.flatMap((b: any) => b.tools || [])
  assert.deepEqual(pills.map((p: any) => [p.callId, p.failed]), [['c2', false]])
})

test('/clear：之前的全扔掉，只剩那条线；非人的消息不画，交接单按单号就地改', () => {
  const events = twoTurns().concat([
    ev(6, 'session/reset', { clear: true, by: 'user' }),
    ev(7, 'user/message', { message: um('系统注入'), source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } }),
    ev(8, 'user/message', { message: um('问二'), source: { kind: 'user' } }),
    ev(9, 'turn/start', { turn: 2 }),
    ev(10, 'human/handoff', { id: 'h1', state: 'open', reason: 'r' }),
    ev(11, 'turn/end', { turn: 2 }),
    ev(12, 'human/handoff', { id: 'h1', state: 'claimed', claimedBy: 'alice' }),
  ])
  const f = fold(events)
  assert.deepEqual(f.blocks.map((b: any) => (b.kind === 'mark' ? 'mark:' + b.mark : b.kind)), ['mark:clear', 'user', 'assistant'])
  const a: any = f.blocks[2]
  assert.equal(a.handoffs.length, 1)
  assert.equal(a.handoffs[0].state, 'claimed')
  assert.equal(a.handoffs[0].claimedBy, 'alice')
  // claimed 那条不动块的 endTime
  assert.equal(a.endTime, T + 11000)
})

test('Telegram 渠道：用户块带 via，助手块继承；session/model 画成分割线并记 modelSeq', () => {
  const events = [
    ev(1, 'user/message', { message: um('hi'), source: { kind: 'plugin', plugin: 'channel', channel: 'telegram' } }),
    ev(2, 'turn/start', { turn: 1 }),
    ev(3, 'assistant/message', { turn: 1, step: 1, message: am('hello'), usage }),
    ev(4, 'turn/end', { turn: 1 }),
    ev(5, 'session/model', { key: 'm', label: 'M', reason: 'user' }),
    ev(6, 'user/message', { message: um('web'), source: { kind: 'user' } }),
  ]
  const f = fold(events)
  assert.equal(f.channelVia, true)
  assert.equal((f.blocks[0] as any).via, 'telegram')
  assert.equal((f.blocks[1] as any).via, 'telegram')
  assert.equal((f.blocks[2] as any).mark, 'model')
  assert.equal((f.blocks[3] as any).via, 'web')
  assert.equal(f.modelSeq, 5)
})

test('todo/list 不进消息流，后一条盖前一条', () => {
  const f = fold([ev(1, 'todo/list', { items: [1] }), ev(2, 'todo/list', { items: [1, 2] })])
  assert.equal(f.blocks.length, 0)
  assert.deepEqual(f.todos, { items: [1, 2], seq: 2 })
})
