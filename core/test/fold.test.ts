import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fold } from '../src/chat/fold.ts'
import { composeVoice, splitVoice } from '../src/chat/events.ts'

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

const todo = (seq: number, status = 'in_progress', task = '写页面') => ev(seq, 'todo/list', { items: [{ id: '1', task, status }] })
const plansOf = (f: ReturnType<typeof fold>) => f.blocks.flatMap(b => b.kind === 'assistant' && b.todoPlan ? [b.todoPlan] : [])

test('任务清单只在对应轮次的助手回复中更新一张卡，完成后留在历史', () => {
  const f = fold([ev(1, 'turn/start', { turn: 1 }), todo(2), todo(3, 'completed'),
    ev(4, 'assistant/message', { turn: 1, message: am('完成了') }), ev(5, 'turn/end', { turn: 1, reason: 'completed' })])
  const plans = plansOf(f)
  assert.equal(plans.length, 1)
  assert.equal(plans[0].seq, 2)
  assert.equal(plans[0].state, 'done')
  assert.equal(plans[0].items[0].status, 'completed')
  assert.equal((f.blocks[0] as any).text, '完成了')
})

test('中止、错误和截断历史按真实运行状态结束，下一轮不能复活旧卡片', () => {
  for (const reason of ['aborted', 'error', 'capped', 'completed']) {
    const f = fold([ev(1, 'turn/start', { turn: 1 }), todo(2), ev(3, 'turn/end', { turn: 1, reason }),
      ev(4, 'user/message', { message: um('在吗') }), ev(5, 'turn/start', { turn: 2 }),
      ev(6, 'assistant/message', { message: am('在的'), turn: 2 })])
    assert.equal(plansOf(f).length, 1)
    assert.equal(plansOf(f)[0].state, reason === 'aborted' ? 'stopped' : reason === 'error' ? 'error' : 'ended')
  }
  const events = [ev(1, 'turn/start', { turn: 1 }), todo(2)]
  assert.equal(plansOf(fold(events, false))[0].state, 'ended')
  assert.equal(plansOf(fold(events, true))[0].state, 'running')
  assert.equal(plansOf(fold([...events, ev(3, 'turn/start', { turn: 2 })]))[0].state, 'ended')
})

test('继续旧任务时新轮次有自己的卡，快照只补最后一轮读回的清单', () => {
  const events = [ev(1, 'turn/start', { turn: 1 }), todo(2), ev(3, 'turn/end', { turn: 1, reason: 'aborted' }),
    ev(4, 'user/message', { message: um('继续') }), ev(5, 'turn/start', { turn: 2 }),
    ev(6, 'tool/call', { turn: 2, callId: 'read', name: 'todo', arguments: '{}' })]
  const f = fold(events, true, false, { items: [{ id: '1', task: '恢复快照', status: 'pending' }], upto: 5 })
  const plans = plansOf(f)
  assert.equal(plans.length, 2)
  assert.equal(plans[0].items[0].task, '写页面')
  assert.equal(plans[0].state, 'stopped')
  assert.equal(plans[1].items[0].task, '恢复快照')
  assert.equal(plans[1].state, 'running')
  const latest = fold([...events, todo(7, 'in_progress', '事件更新')], true, false,
    { items: [{ id: '1', task: '旧快照', status: 'pending' }], upto: 5 })
  assert.equal(plansOf(latest)[1].items[0].task, '事件更新')
})

test('普通聊天不带快照清单，写入前不拿旧清单占位，收口后恢复外层清单不改历史卡', () => {
  const snapshot = { items: [{ id: '1', task: '外层清单', status: 'in_progress' }], upto: 10 }
  const start = [ev(1, 'turn/start', { turn: 1 })]
  assert.equal(plansOf(fold(start, true, false, snapshot)).length, 0)
  assert.equal(plansOf(fold([...start, ev(2, 'tool/call', { name: 'todo', arguments: '{"todos":[]}' })], true, false, snapshot)).length, 0)
  const f = fold([...start, todo(2, 'completed', '派活子任务'), ev(3, 'turn/end', { turn: 1, reason: 'completed' }),
    todo(4, 'in_progress', '外层清单')], false, false, snapshot)
  assert.equal(plansOf(f).length, 1)
  assert.equal(plansOf(f)[0].items[0].task, '派活子任务')
  assert.equal(plansOf(f)[0].state, 'done')
})

test('同一轮被插话隔开仍只更新原卡，清空会话后不保留旧卡', () => {
  const events = [ev(1, 'turn/start', { turn: 1 }), todo(2),
    ev(3, 'user/message', { message: um('补充一下') }), todo(4, 'completed')]
  assert.equal(plansOf(fold(events)).length, 1)
  assert.equal(plansOf(fold(events))[0].items[0].status, 'completed')
  assert.equal(plansOf(fold([...events, ev(5, 'session/reset', { clear: true })])).length, 0)
})

test('上一轮没收口（只有 turn/start）之后派来的指令紧挨着开了自己的一轮：是派来的活，不是插话', () => {
  const task = { kind: 'plugin', plugin: 'task', form: 't9', phase: 'instruction', from: { id: 'main', name: '助手' } }
  const f = fold([
    ev(1, 'user/message', { message: um('人那句'), source: { kind: 'user' } }),
    ev(2, 'turn/start', { turn: 1 }),
    ev(3, 'user/message', { message: um('【主 Bot「助手」派来的任务】\n活'), source: task }),
    ev(4, 'turn/start', { turn: 2 }),
    ev(5, 'assistant/message', { turn: 2, step: 1, message: am('做完了'), usage }),
    ev(6, 'turn/end', { turn: 2, reason: 'completed' }),
  ])
  const card: any = f.blocks.find((b: any) => b.kind === 'user' && b.assigned)
  assert.equal(card.assigned.state, 'completed')
  assert.equal(card.assigned.turn, 2)
})

test('真插话（指令后面跟的是人那一轮的助手事件）照旧是 steered', () => {
  const task = { kind: 'plugin', plugin: 'task', form: 't8', phase: 'instruction', from: { id: 'main', name: '助手' } }
  const f = fold([
    ev(1, 'user/message', { message: um('人那句'), source: { kind: 'user' } }),
    ev(2, 'turn/start', { turn: 1 }),
    ev(3, 'user/message', { message: um('【主 Bot「助手」派来的任务】\n插进来的'), source: task }),
    ev(4, 'assistant/message', { turn: 1, step: 1, message: am('人那件的回答'), usage }),
    ev(5, 'turn/end', { turn: 1, reason: 'completed' }),
  ])
  const card: any = f.blocks.find((b: any) => b.kind === 'user' && b.assigned)
  assert.equal(card.assigned.state, 'steered')
})

test('语音消息：拼出来的正文认得回来，折叠后正文只留转写、录音单独一项', () => {
  for (const lang of ['zh', 'en'] as const) {
    const body = composeVoice(lang, { path: 'uploads/s1/voice-1.wav', seconds: 11.6 }, '  帮我订会议室\n下午三点  ')
    assert.deepEqual(splitVoice(body), { text: '帮我订会议室\n下午三点', voice: { path: 'uploads/s1/voice-1.wav', seconds: 12 } })
    const f = fold([ev(1, 'session', { version: 5, id: 's1', botId: 'b', createdAt: T }), ev(2, 'user/message', { message: um(body), source: { kind: 'user' } })])
    const user = f.blocks.find((b: any) => b.kind === 'user') as any
    assert.equal(user.text, '帮我订会议室\n下午三点')
    assert.deepEqual(user.voice, { path: 'uploads/s1/voice-1.wav', seconds: 12 })
    assert.equal(user.raw, body, '回执靠 raw 认，得是完整正文')
  }
  // 不是我们拼的就不认：首行像、后面不对的一律当普通消息。
  assert.equal(splitVoice('我发了一条语音（3 秒），录音在工作区里：\n随便写的'), null)
  assert.equal(splitVoice('我发了一条语音（3 秒），录音在工作区里：\n- `/etc/passwd`\n\n转写（自动识别，可能有错字）：\nx'), null)
  assert.equal(splitVoice('你好'), null)
})

test('本地语音回执：拿到文件名之前谁都不认，拿到之后按文件名认领服务端拼的那条', async () => {
  const { mergePending } = await import('../src/chat/pending.ts')
  const body = composeVoice('zh', { path: 'uploads/s1/voice-20261104-120000-abc123.wav', seconds: 4 }, '你好')
  const events = [ev(1, 'session', { version: 5, id: 's1', botId: 'b', createdAt: T }), ev(2, 'user/message', { message: um(body), source: { kind: 'user' } })]
  const local = { sessionId: 's1', text: '', voice: { path: 'local:x', seconds: 4 }, voiceName: '', at: T, afterSeq: 1 }
  const f1 = fold(events)
  assert.equal(mergePending(f1, [local]).length, 1, '还没文件名，不该被认领')
  const shown = f1.blocks.filter((b: any) => b.kind === 'user')
  assert.deepEqual((shown.at(-1) as any).voice, { path: 'local:x', seconds: 4 }, '没认领的本地语音该画成语音条')
  assert.equal((shown.at(-1) as any).text, '', '本地语音还没有转写')
  const f2 = fold(events)
  assert.equal(mergePending(f2, [{ ...local, voiceName: 'voice-20261104-120000-abc123.wav' }]).length, 0, '文件名对上该认领')
  assert.equal(mergePending(fold(events), [{ ...local, voiceName: 'voice-other.wav' }]).length, 1, '别的文件名不该认领')
})
