import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { rosterFrame } from '../../manager/src/roster-filter.ts'
import { notificationClient, noticeServer, source } from './helpers/notifications.mjs'

const turn = (seq = 1, reason = 'completed') => ({ type: 'turn/end', seq, time: 1100 + seq, data: { reason } })

test('raw events cannot bypass server scheduling to display desktop notifications', async () => {
  const server = noticeServer(), ui = notificationClient(server, { platform: 'desktop' })
  await ui.start()
  await ui.context.notifyDesktopEvent('bot-a', { ...turn(), secret: '私密正文' }, false, 'session-a')
  assert.equal(ui.sent.length, 0)
  server.add(); server.time(4000); await ui.poll(); await ui.poll()
  assert.equal(ui.sent.length, 1)
  assert.equal(ui.sent[0].kind, 'turn-end')
  assert.equal(ui.sent[0].generation, 1)
  assert.equal(JSON.stringify(ui.sent).includes('私密正文'), false)
})

test('foreground desktop remains silent; unread notifications remain available when focus changes', async () => {
  const server = noticeServer(), ui = notificationClient(server, { platform: 'desktop', focused: true })
  await ui.start(); server.add(); server.time(4000); await ui.poll()
  assert.equal(ui.sent.length, 0)
  assert.equal(ui.document.title, '(1) Satuwork Gateway')
  ui.focus(false); await ui.poll()
  assert.equal(ui.sent.length, 1)
})

test('browser and mobile never invoke the desktop bridge', async () => {
  for (const platform of ['web', 'mobile']) {
    const server = noticeServer(), ui = notificationClient(server, { platform })
    await ui.start(); server.add(); server.time(4000); await ui.poll()
    assert.equal(ui.sent.length, 0)
  }
})

test('server read suppresses desktop claim even before its snapshot catches up', async () => {
  const server = noticeServer(), ui = notificationClient(server, { platform: 'desktop' })
  await ui.start(); server.add(); server.time(4000)
  const api = ui.context.api
  ui.context.api = async (m, p, b) => {
    if (p.endsWith('/claim')) await server.api('account-a', 'PUT', '/me/notifications/read', { botId: 'bot-a', sessionId: 'session-a', seq: 10 })
    return api(m, p, b)
  }
  await ui.poll()
  assert.equal(ui.sent.length, 0)
})

test('already shown desktop reminders are cleared when another device reads the conversation', async () => {
  const server = noticeServer(), ui = notificationClient(server, { platform: 'desktop' })
  await ui.start(); const event = server.add(); server.time(4000); await ui.poll()
  assert.equal(ui.sent.length, 1)
  await server.api('account-a', 'PUT', '/me/notifications/read', { botId: 'bot-a', sessionId: 'session-a', seq: 10 })
  await ui.poll()
  assert.deepEqual(ui.cleared.at(-1), [event.id])
  assert.equal(ui.document.title, 'Satuwork Gateway')
})

test('notification clicks navigate only within the current desktop login generation', async () => {
  const ui = notificationClient(noticeServer(), { platform: 'desktop' })
  await ui.start(); ui.context.window.__SATUWORK_DESKTOP_NOTIFICATION_TAPPED__(1, 'bot/a')
  assert.deepEqual(ui.navigated, ['/a/bot%2Fa'])
  ui.context.resetDesktopNotifications(); ui.state.me.account.id = 'account-b'
  ui.context.window.__SATUWORK_DESKTOP_NOTIFICATION_TAPPED__(1, 'bot-a')
  assert.equal(ui.navigated.length, 1)
})

test('local bot events persist while offline and resolved approvals never become pending again', async () => {
  const server = noticeServer(), ui = notificationClient(server, { platform: 'desktop' })
  await ui.start(); ui.state.runtimeBots[0].runtimeKind = 'local'; server.offline(true)
  await ui.context.observeNotificationEvent('bot-a', { type: 'tool/approval', seq: 12, time: 1100, data: { callId: 'c1', state: 'pending' } }, false, 'session-a')
  await ui.context.observeNotificationEvent('bot-a', { type: 'tool/approval', seq: 13, time: 1200, data: { callId: 'c1', state: 'approved' } }, false, 'session-a')
  await ui.poll(); ui.context.resetNotificationSync()
  server.offline(false)
  const restored = notificationClient(server, { platform: 'desktop', storage: ui.storage })
  await restored.start()
  assert.equal(server.events.length, 1)
  assert.equal(server.events[0].seq, 12)
  assert.equal(server.events[0].resolved, true)
  assert.equal(restored.document.title, 'Satuwork Gateway')
})

test('roster stream preserves session identity and replay flags across upstream reconnects', () => {
  const up = { botId: 'bot-a', sessionId: 's-a', after: 0, lastTick: 0, attempt: 0, replaying: true }
  assert.equal(rosterFrame(turn(), up).replay, true)
  assert.equal(rosterFrame(turn(), up).sessionId, 's-a')
  rosterFrame({ type: 'replay/done', live: false }, up)
  assert.equal(rosterFrame(turn(2), up).replay, false)
  up.replaying = true
  assert.equal(rosterFrame(turn(2), up).replay, true)
})

test('roster hook passes the server session and preserves old-manager history detection', async () => {
  const ui = notificationClient(noticeServer(), { platform: 'desktop' }), observed = []
  Object.assign(ui.context, { botStreamOf: () => ({ sum: {} }), noteBotEvent() {}, settleDot() {}, scheduleRosterPaint() {},
    observeNotificationEvent: (...args) => observed.push(args) })
  runInNewContext(source('../../ui/chat-stream.js'), ui.context)
  ui.context.noteRosterFrame({ type: 'roster/ev', botId: 'bot-a', sessionId: 's-a', ev: turn() })
  ui.context.noteRosterFrame({ type: 'roster/live', botId: 'bot-a', live: false })
  ui.context.noteRosterFrame({ type: 'roster/ev', botId: 'bot-a', sessionId: 's-a', ev: turn(2) })
  assert.equal(observed[0][2], true)
  assert.equal(observed[1][2], false)
  assert.equal(observed[1][3], 's-a')
})

test('a deleted local bot cannot block synchronization of the other conversations', async () => {
  const server = noticeServer(), ui = notificationClient(server, { platform: 'desktop' })
  await ui.start(); ui.state.runtimeBots[0].runtimeKind = 'local'
  await ui.context.observeNotificationEvent('bot-a', turn(), false, 'deleted-local')
  const api = ui.context.api
  ui.context.api = (m, p, b) => p.endsWith('/local') ? Promise.reject(Object.assign(new Error('deleted'), { status: 404 })) : api(m, p, b)
  server.add({ botId: 'bot-b' }); server.time(4000)
  await ui.poll()
  assert.equal(ui.document.title, '(1) Satuwork Gateway')
  assert.equal(ui.sent.length, 1)
  assert.equal([...ui.storage.keys()].some((key) => key.endsWith(':events')), false)
})

test('local bots are monitored without opening their chat, preserving replay and abort semantics', async () => {
  const ui = notificationClient(noticeServer(), { platform: 'desktop' }), observed = []
  ui.state.runtimeBots[0].runtimeKind = 'local'
  Object.assign(ui.context, {
    AbortController, TextDecoder, localSessions: new Map(), sseEvents: ui.context.SatuCore.sseEvents,
    localBotOf: () => ({ base: 'http://127.0.0.1:3456', token: 'local-ticket', login: 'ticket' }),
    observeNotificationEvent: (...args) => observed.push(args),
  })
  let signal, emit
  ui.context.swFetch = async (url, init) => {
    signal = init.signal
    if (url.includes('/bots/')) return { ok: true, json: async () => ({ sessionId: 'local-session' }) }
    assert.equal(url, '/runtime/sessions/local-session/events?tail=1')
    const body = new ReadableStream({ start(controller) {
      emit = (ev) => controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(ev) + '\n\n'))
      signal.addEventListener('abort', () => controller.close(), { once: true })
    } })
    return { ok: true, body }
  }
  try {
    await ui.start(); await new Promise(setImmediate)
    assert.ok(emit)
    emit(turn()); emit({ type: 'replay/done' }); emit(turn(2))
    await new Promise(setImmediate)
    assert.equal(observed.length, 2)
    assert.equal(observed[0][2], true)
    assert.equal(observed[1][2], false)
    assert.equal(observed[1][3], 'local-session')
    ui.context.resetDesktopNotifications()
    assert.equal(signal.aborted, true)
  } finally { ui.context.resetDesktopNotifications() }
})

test('logout invalidates pending native initialization and old notification clicks', async () => {
  const ui = notificationClient(noticeServer(), { platform: 'desktop' })
  let finish
  ui.context.window.__SATUWORK_DESKTOP_NOTIFICATIONS__.session = (id) => id ? new Promise((resolve) => { finish = resolve }) : Promise.resolve(2)
  const starting = ui.context.syncDesktopNotifications()
  ui.context.resetDesktopNotifications(); ui.state.me = null; finish(1); await starting
  await ui.context.deliverDesktopNotification({ botId: 'bot-a', kind: 'turn-end' })
  ui.context.window.__SATUWORK_DESKTOP_NOTIFICATION_TAPPED__(1, 'bot-a')
  assert.equal(ui.sent.length, 0)
  assert.equal(ui.navigated.length, 0)
})
