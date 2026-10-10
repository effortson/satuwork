import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyRosterEvent, newSum, refreshSum, settleDot } from '../src/chat/roster.ts'

test('turn/start/end 翻 busy；确认按 callId 记，终态只删那一条，turn/end 先到也不影响', () => {
  const sum = newSum()
  assert.equal(applyRosterEvent(sum, { type: 'turn/start' }), true)
  assert.equal(sum.state, 'busy')
  assert.equal(applyRosterEvent(sum, { type: 'tool/approval', time: 5, seq: 9, data: { callId: 'c1', state: 'pending', name: 'bash' } }), true)
  assert.equal(sum.state, 'review')
  assert.equal(sum.need, 'approval')
  // 重放一遍 pending 不会多记
  applyRosterEvent(sum, { type: 'tool/approval', data: { callId: 'c1', state: 'pending' } })
  assert.equal(sum.asks!.size, 1)
  applyRosterEvent(sum, { type: 'turn/end' })
  assert.equal(sum.state, 'review')
  assert.equal(applyRosterEvent(sum, { type: 'tool/approval', data: { callId: 'c1', state: 'approved' } }), true)
  assert.equal(sum.state, 'idle')
  // 没 callId 的不记
  applyRosterEvent(sum, { type: 'tool/approval', data: { state: 'pending' } })
  assert.equal(sum.state, 'idle')
})

test('交接单按单号记；关单顺手销掉快照里那一份', () => {
  const sum = newSum()
  sum.snapIds = new Set(['h1'])
  settleDot(sum)
  assert.equal(sum.need, 'handoff')
  applyRosterEvent(sum, { type: 'human/handoff', data: { id: 'h1', state: 'open' } })
  applyRosterEvent(sum, { type: 'human/handoff', data: { id: 'h1', state: 'claimed' } })
  assert.equal(sum.openIds!.size, 1)
  assert.equal(applyRosterEvent(sum, { type: 'human/handoff', data: { id: 'h1', state: 'closed' } }), true)
  assert.equal(sum.state, 'idle')
  assert.equal(sum.snapIds.size, 0)
})

test('最近一句：消息写正文与时间，chunk 只推时间；没变就报 false', () => {
  const sum = newSum()
  assert.equal(applyRosterEvent(sum, { type: 'user/message', time: 10, data: { message: { content: [{ type: 'text', text: '  你好\n世界  ' }] } } }), true)
  assert.equal(sum.lastText, '你好 世界')
  assert.equal(sum.lastAt, 10)
  assert.equal(applyRosterEvent(sum, { type: 'assistant/chunk', time: 11 }), true)
  assert.equal(sum.lastAt, 11)
  assert.equal(applyRosterEvent(sum, { type: 'assistant/chunk', time: 11 }), false)
  assert.equal(applyRosterEvent(sum, { type: 'something/else' }), false)
})

test('refreshSum：从后往前找第一条有正文的，比手上的新才认', () => {
  const sum = newSum()
  sum.lastAt = 50
  sum.lastText = 'new'
  const events: any[] = [{ type: 'user/message', time: 20, data: { text: 'old' } }, { type: 'turn/end', time: 60 }]
  assert.equal(refreshSum(sum, events), false)
  assert.equal(sum.lastText, 'new')
  events.push({ type: 'assistant/message', time: 70, data: { text: 'newer' } })
  assert.equal(refreshSum(sum, events), true)
  assert.equal(sum.lastText, 'newer')
  assert.equal(sum.lastAt, 70)
})
