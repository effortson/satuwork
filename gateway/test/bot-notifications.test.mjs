import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { tsImport } from 'tsx/esm/api'
const { apply } = await tsImport('../../bot/src/session/gateway.ts', import.meta.url)

async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await delay(10)
  }
  assert.fail('notification reporting did not settle')
}

function seat(rows, events) {
  const handlers = new Map(), cleanups = []
  apply({
    server: { get() {} }, catalog: {}, logger: { warn() {}, error() {} },
    storage: { collection: () => ({ put: (id, value) => rows.set(id, value), delete: (id) => rows.delete(id),
      list: () => [...rows].map(([id, value]) => ({ id, value })) }) },
    sessions: { events: async (id) => events.get(id) || [] },
    on: (name, handler) => handlers.set(name, handler), effect: (fn) => cleanups.push(fn()),
  })
  return { emit: (id, event) => { events.get(id).push(event); handlers.get('session/event')(id, event) },
    stop: () => cleanups.forEach((fn) => fn()) }
}

const root = (kind = 'main') => ({ type: 'session', seq: 1, time: 1000, data: { kind, botId: 'bot-a', createdAt: 1000 } })

test('seat notification protocol and durable outbox', async (t) => {
  const old = { ...process.env }, pushes = []
  let fail = false
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    if (req.url === '/internal/push') {
      pushes.push(JSON.parse(raw))
      res.writeHead(fail ? 503 : 202, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ account: { id: 'account-a' }, company: { id: 'company-a' } }))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  process.env.GATEWAY_URL = `http://127.0.0.1:${server.address().port}`
  process.env.GATEWAY_TOKEN = 'sat_test'
  delete process.env.SATUWORK_BOT_ID
  delete process.env.SATUWORK_RUNTIME_KIND
  try {
    await t.test('reports stable conversation sequence without unrelated event fields', async () => {
      const rows = new Map(), events = new Map([['s-main', [root()]]]), ctx = seat(rows, events)
      const before = pushes.length
      try {
        ctx.emit('s-main', { type: 'turn/end', seq: 9, time: 2000, data: { reason: 'completed', secret: 'never upload dialogue' } })
        await until(() => pushes.length > before)
        const p = pushes.at(-1)
        assert.deepEqual(p, { botId: 'bot-a', sessionId: 's-main', seq: 9, time: 2000, kind: 'turn-end', actionId: '', resolved: false, preview: '' })
        await until(() => ![...rows.values()].some((r) => r.kind === 'notification'))
      } finally { ctx.stop() }
    })

    await t.test('approval resolution uses the original pending sequence', async () => {
      const rows = new Map(), events = new Map([['s-approval', [root(), { type: 'tool/approval', seq: 3, time: 1500, data: { callId: 'c1', state: 'pending' } }]]])
      const ctx = seat(rows, events), before = pushes.length
      try {
        ctx.emit('s-approval', { type: 'tool/approval', seq: 6, time: 1800, data: { callId: 'c1', state: 'approved' } })
        await until(() => pushes.length > before)
        assert.equal(pushes.at(-1).seq, 3)
        assert.equal(pushes.at(-1).actionId, 'c1')
        assert.equal(pushes.at(-1).resolved, true)
      } finally { ctx.stop() }
    })

    await t.test('preview comes only from the final visible reply in the completed turn and stays bounded', async () => {
      const reply = '已核对三张发票，合计 RM 1,250。' + '✅'.repeat(300)
      const rows = new Map(), events = new Map([['s-preview', [root(),
        { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: '上一轮的旧结论' }] } } },
        { type: 'turn/start', seq: 3, data: { turn: 2 } },
        { type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'text', text: '我先查一下' }] } } },
        { type: 'tool/result', seq: 5, data: { text: '工具私密输出' } },
        { type: 'assistant/message', seq: 6, data: { message: { content: [{ type: 'reasoning', text: '内部推理' }, { type: 'text', text: reply }] } } },
      ]]])
      const ctx = seat(rows, events), before = pushes.length
      try {
        ctx.emit('s-preview', { type: 'turn/end', seq: 7, time: 2000, data: { turn: 2, reason: 'completed' } })
        ctx.emit('s-preview', { type: 'user/message', seq: 8, data: { source: { kind: 'user' } } })
        ctx.emit('s-preview', { type: 'turn/start', seq: 9, data: { turn: 3 } })
        ctx.emit('s-preview', { type: 'assistant/message', seq: 10, data: { message: { content: [{ type: 'text', text: '下一轮的回答' }] } } })
        await until(() => pushes.length > before)
        assert.equal(pushes.at(-1).preview, Array.from(reply).slice(0, 239).join('') + '…')
        assert.equal(Array.from(pushes.at(-1).preview).length, 240)
        assert.doesNotMatch(JSON.stringify(pushes.at(-1)), /内部推理|工具私密输出|上一轮|下一轮|我先查一下/)
      } finally { ctx.stop() }
    })

    await t.test('an empty turn does not reuse the previous reply; approval previews omit tool arguments', async () => {
      const rows = new Map(), events = new Map([['s-empty', [root(),
        { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: '旧回复' }] } } },
        { type: 'turn/start', seq: 3, data: { turn: 2 } },
      ]]])
      const ctx = seat(rows, events), before = pushes.length
      try {
        ctx.emit('s-empty', { type: 'turn/end', seq: 4, time: 2000, data: { turn: 2, reason: 'completed' } })
        await until(() => pushes.length > before)
        assert.equal(pushes.at(-1).preview, '')
        ctx.emit('s-empty', { type: 'tool/approval', seq: 5, time: 2100,
          data: { callId: 'c1', name: 'send_email', reason: '需要确认发送账单邮件', arguments: '私密邮件全文', state: 'pending' } })
        await until(() => pushes.length === before + 2)
        assert.equal(pushes.at(-1).preview, 'send_email · 需要确认发送账单邮件')
        assert.equal(JSON.stringify(pushes.at(-1)).includes('私密邮件全文'), false)
      } finally { ctx.stop() }
    })

    await t.test('failed metadata stays durable and is retried unchanged after seat restart', async () => {
      const rows = new Map(), events = new Map([['s-retry', [root()]]])
      let ctx = seat(rows, events)
      const before = pushes.length
      try {
        fail = true
        ctx.emit('s-retry', { type: 'turn/end', seq: 10, time: 2000, data: { reason: 'completed' } })
        await until(() => [...rows.values()].some((r) => r.kind === 'notification' && r.attempts === 1))
        const first = pushes.at(-1)
        ctx.stop()
        for (const row of rows.values()) row.nextTryAt = 0
        fail = false
        ctx = seat(rows, events)
        ctx.emit('s-retry', { type: 'tool/approval', seq: 11, time: 2100, data: { callId: 'c2', state: 'pending' } })
        await until(() => pushes.length >= before + 3)
        const retried = pushes.slice(before).filter((p) => p.seq === 10)
        assert.equal(retried.length, 2)
        assert.deepEqual(retried[0], first)
        assert.deepEqual(retried[1], first)
      } finally { fail = false; ctx.stop() }
    })

    await t.test('aborted turns and delegated sessions never create remote alerts', async () => {
      const rows = new Map(), events = new Map([['s-main', [root()]], ['s-side', [root('task')]]])
      const ctx = seat(rows, events), before = pushes.length
      try {
        ctx.emit('s-main', { type: 'turn/end', seq: 2, time: 2000, data: { reason: 'aborted' } })
        ctx.emit('s-side', { type: 'turn/end', seq: 2, time: 2000, data: { reason: 'completed' } })
        await delay(30)
        assert.equal(pushes.length, before)
        assert.equal([...rows.values()].some((r) => r.kind === 'notification'), false)
      } finally { ctx.stop() }
    })

    await t.test('assigned turns in the main session stay silent; approvals and later user turns still notify', async () => {
      const task = { kind: 'plugin', plugin: 'task', phase: 'instruction', form: 'task-1' }
      const rows = new Map(), events = new Map([['s-assigned', [root()]]])
      const ctx = seat(rows, events), before = pushes.length
      let seq = 1
      const emit = (type, data) => ctx.emit('s-assigned', { type, seq: ++seq, time: 1000 + seq, data })
      try {
        for (const [index, reason] of ['completed', 'error', 'capped'].entries()) {
          emit('user/message', { source: task })
          emit('turn/start', { turn: index + 1 })
          if (!index) {
            emit('tool/approval', { callId: 'assigned-approval', state: 'pending' })
            await until(() => pushes.length > before)
            assert.equal(pushes.at(-1).kind, 'approval')
          }
          emit('turn/end', { turn: index + 1, reason })
        }
        await delay(30)
        assert.equal(pushes.length, before + 1)

        emit('user/message', { source: { kind: 'user' } })
        emit('turn/start', { turn: 4 })
        emit('turn/end', { turn: 4, reason: 'completed' })
        const userEndSeq = seq
        // 通知异步读历史时，下一件派活可能已经开跑，不能据最新来源误判上一轮。
        emit('user/message', { source: task })
        emit('turn/start', { turn: 5 })
        await until(() => pushes.length === before + 2)
        assert.equal(pushes.at(-1).seq, userEndSeq)
      } finally { ctx.stop() }
    })

    await t.test('task results at the main bot and legacy task steering still notify', async () => {
      const rows = new Map(), events = new Map([['s-result', [root()]]])
      const ctx = seat(rows, events), before = pushes.length
      try {
        for (const event of [
          { type: 'user/message', seq: 2, data: { source: { kind: 'plugin', plugin: 'task', phase: 'result' } } },
          { type: 'turn/start', seq: 3, data: { turn: 1 } },
          { type: 'user/message', seq: 4, data: { source: { kind: 'plugin', plugin: 'task', phase: 'instruction' } } },
          { type: 'assistant/message', seq: 5, data: { turn: 1, message: { content: [] } } },
          { type: 'turn/end', seq: 6, data: { turn: 1, reason: 'completed' } },
        ]) ctx.emit('s-result', { time: 2000, ...event })
        await until(() => pushes.length > before)
        assert.equal(pushes.at(-1).seq, 6)
      } finally { ctx.stop() }
    })
  } finally {
    for (const key of ['GATEWAY_URL', 'GATEWAY_TOKEN', 'SATUWORK_BOT_ID', 'SATUWORK_RUNTIME_KIND']) {
      if (old[key] === undefined) delete process.env[key]
      else process.env[key] = old[key]
    }
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  }
})
