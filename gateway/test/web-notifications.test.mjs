import assert from 'node:assert/strict'
import { test } from 'node:test'
import { notificationClient, noticeServer, source } from './helpers/notifications.mjs'

async function ready(options) {
  const server = noticeServer(), ui = notificationClient(server, options)
  await ui.start()
  return { ui, server }
}

test('web notifications come from server claims; raw events never create local unread', async () => {
  const { ui, server } = await ready()
  await ui.context.notifyDesktopEvent('bot-b', { type: 'turn/end', seq: 1, time: 1100, data: {} }, false, 'session-b')
  assert.equal(ui.document.title, 'Satuwork Gateway')
  server.add({ botId: 'bot-b', sessionId: 'session-b' }); server.time(4000)
  await ui.poll()
  assert.equal(ui.document.title, '(1) Satuwork Gateway')
  assert.match(ui.nodes.get('web-notifications').innerHTML, /助理 B/)
  assert.equal(ui.badges[1].textContent, '1')
  assert.equal(server.claims.size, 1)
  await ui.poll()
  assert.equal(server.claims.size, 1)
})

test('no reminder before grace expires, and opening a card only navigates', async () => {
  const { ui, server } = await ready()
  server.add(); server.time(2000)
  await ui.poll()
  assert.equal(ui.nodes.has('web-notifications'), false)
  assert.equal(ui.document.title, '(1) Satuwork Gateway')
  server.time(4000); await ui.poll()
  ui.click('bot-a')
  assert.deepEqual(ui.navigated, ['/a/bot-a'])
  assert.equal(server.reads.size, 0, 'navigation without rendered content is not read')
  ui.click('bot-a', true)
  assert.equal(ui.nodes.has('web-notifications'), false)
  assert.equal(ui.document.title, '(1) Satuwork Gateway', 'dismiss is not read')
})

test('read on web synchronizes badges to mobile and desktop and suppresses their notifications', async () => {
  const server = noticeServer()
  const web = notificationClient(server, { focused: true }), mobile = notificationClient(server, { platform: 'mobile' }), desktop = notificationClient(server, { platform: 'desktop' })
  await Promise.all([web.start(), mobile.start(), desktop.start()])
  const event = server.add(); server.time(2000)
  await Promise.all([web.poll(), mobile.poll(), desktop.poll()])
  for (const ui of [web, mobile, desktop]) assert.equal(ui.document.title, '(1) Satuwork Gateway')
  web.state.path = '/a/bot-a'; web.state.chatEvents = [{ seq: 10, type: 'turn/end' }]
  web.read(); await web.poll()
  server.time(4000)
  await Promise.all([mobile.poll(), desktop.poll()])
  for (const ui of [web, mobile, desktop]) assert.equal(ui.document.title, 'Satuwork Gateway')
  assert.equal(desktop.sent.length, 0)
  assert.equal(server.claims.size, 0)
  assert.deepEqual(mobile.cleared.at(-1), [event.id])
})

test('mobile and desktop can each originate the shared read cursor', async () => {
  for (const platform of ['mobile', 'desktop']) {
    const server = noticeServer(), reader = notificationClient(server, { platform, focused: true }), web = notificationClient(server)
    await Promise.all([reader.start(), web.start()])
    server.add(); server.time(2000); await web.poll()
    reader.state.path = '/a/bot-a'; reader.state.chatEvents = [{ seq: 10, type: 'turn/end' }]
    reader.read(); await reader.poll(); server.time(4000); await web.poll()
    assert.equal(web.document.title, 'Satuwork Gateway')
    assert.equal(web.nodes.has('web-notifications'), false)
  }
})

test('unread badges restore after reload without replaying historical notifications', async () => {
  const server = noticeServer(); server.add(); server.time(4000)
  const ui = notificationClient(server)
  await ui.start()
  assert.equal(ui.document.title, '(1) Satuwork Gateway')
  assert.equal(server.claims.size, 0)
})

test('background, settings, replay and empty content never mark received messages read', async () => {
  const { ui, server } = await ready({ focused: true })
  ui.state.chatEvents = [{ seq: 10, type: 'turn/end' }]
  ui.read(); await ui.poll(); assert.equal(server.reads.size, 0, 'settings')
  ui.state.path = '/a/bot-a'
  ui.hidden(true); ui.read(); await ui.poll(); assert.equal(server.reads.size, 0, 'hidden')
  ui.hidden(false); ui.focus(false); ui.read(); await ui.poll(); assert.equal(server.reads.size, 0, 'unfocused')
  ui.focus(true); ui.state.chatReplaying = true; ui.read(); await ui.poll(); assert.equal(server.reads.size, 0, 'replay')
  ui.state.chatReplaying = false; ui.content(false); ui.read(); await ui.poll(); assert.equal(server.reads.size, 0, 'not rendered')
})

test('scrolling through history reads visible rows without reading the unseen tail', async () => {
  const { ui, server } = await ready({ focused: true })
  server.add({ seq: 5 }); server.add({ seq: 10 }); server.time(2000)
  ui.state.path = '/a/bot-a'; ui.state.chatEvents = [{ seq: 5, type: 'assistant/message' }, { seq: 10, type: 'turn/end' }]; ui.bottom(false)
  ui.read(); await ui.poll()
  assert.equal(ui.document.title, '(1) Satuwork Gateway')
  assert.equal([...server.reads.values()][0].lastReadSeq, 5)
  ui.bottom(true); ui.read(); await ui.poll()
  assert.equal(ui.document.title, 'Satuwork Gateway')
})

test('offline reads survive reload and are uploaded before fetching or claiming old notifications', async () => {
  const { ui, server } = await ready({ focused: true })
  server.add(); server.offline(true)
  ui.state.path = '/a/bot-a'; ui.state.chatEvents = [{ seq: 10, type: 'turn/end' }]
  ui.read(); await ui.poll()
  assert.equal(ui.inspect().pending[0].seq, 10)
  ui.context.resetNotificationSync()
  server.offline(false); server.time(4000)
  const restored = notificationClient(server, { storage: ui.storage })
  const offset = server.requests.length
  await restored.start()
  assert.equal(server.requests[offset].path, '/me/notifications/read')
  assert.equal(restored.document.title, 'Satuwork Gateway')
  assert.equal(server.claims.size, 0)
})

test('read update during an in-flight snapshot cannot resurrect an unread badge or alert', async () => {
  const { ui, server } = await ready({ focused: true })
  server.add(); server.time(4000)
  const api = ui.context.api
  let finish
  ui.context.api = async (m, p, b) => {
    const value = await api(m, p, b)
    if (m === 'GET') return new Promise((resolve) => { finish = () => resolve(value) })
    return value
  }
  const polling = ui.poll(); await new Promise(setImmediate)
  ui.state.path = '/a/bot-a'; ui.state.chatEvents = [{ seq: 10, type: 'turn/end' }]; ui.read()
  finish(); await polling
  assert.equal(ui.nodes.has('web-notifications'), false)
  ui.context.api = api; await ui.poll()
  assert.equal(ui.document.title, 'Satuwork Gateway')
  assert.equal(server.claims.size, 0)
})

test('logout discards in-flight snapshots; pending reads never leak to a different account', async () => {
  const { ui, server } = await ready({ focused: true })
  server.offline(true); ui.state.path = '/a/bot-a'; ui.state.chatEvents = [{ seq: 10, type: 'turn/end' }]; ui.read(); await ui.poll()
  ui.context.resetDesktopNotifications(); ui.state.me.account.id = 'account-b'; server.offline(false)
  await ui.start()
  assert.equal([...server.reads.keys()].some((k) => k.includes('account-b')), false)
  assert.equal(ui.document.title, 'Satuwork Gateway')
})

test('notification names are escaped, counts cap at 99+, and language follows the interface', async () => {
  const { ui, server } = await ready()
  ui.context.localeMode = 'en'; ui.state.runtimeBots[1].name = '<img src=x onerror=alert(1)>'
  for (let seq = 1; seq <= 100; seq++) server.add({ seq, botId: 'bot-b' })
  server.time(4000); await ui.poll()
  const html = ui.nodes.get('web-notifications').innerHTML
  assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img/); assert.match(html, /Reply ready/)
  assert.equal(ui.document.title, '(99+) Satuwork Gateway')
})

test('all app scripts are included in the gateway static-file allowlist', () => {
  const html = source('../../ui/index.html'), http = source('../../src/http.ts')
  for (const [, script] of html.matchAll(/<script[^>]* src="\/([^"]+)"/g)) assert.ok(http.includes(`'${script}'`), script)
})

test('web cards display the reply preview as escaped text', async () => {
  const { ui, server } = await ready()
  server.add({ preview: '已核对 3 张发票，合计 RM 1,250。<img src=x onerror=alert(1)>' }); server.time(4000)
  await ui.poll()
  const html = ui.nodes.get('web-notifications').innerHTML
  assert.match(html, /已核对 3 张发票，合计 RM 1,250/)
  assert.match(html, /&lt;img/)
  assert.doesNotMatch(html, /<img/)
})

test('web plays one chime for newly claimed notifications in a batch, never for polling or history', async () => {
  const { ui, server } = await ready({ audio: true })
  ui.gesture()
  assert.equal(ui.sounds.length, 0, 'unlocking audio is silent')
  server.add(); server.add({ botId: 'bot-b' }); server.time(4000)
  await ui.poll()
  assert.equal(ui.sounds.length, 3, 'a chime has three notes; the batch sounds once')
  await ui.poll()
  assert.equal(ui.sounds.length, 3, 'duplicate polling stays silent')
  server.add({ seq: 11 }); await ui.poll()
  assert.equal(ui.sounds.length, 6)

  const restored = notificationClient(server, { audio: true })
  await restored.start(); restored.gesture(); await restored.poll()
  assert.equal(restored.sounds.length, 0, 'restoring unread history stays silent')
})

test('web audio waits for a user gesture without queueing old sounds, and autoplay failure does not block cards', async () => {
  const { ui, server } = await ready({ audio: true })
  server.add(); server.time(4000); await ui.poll()
  assert.equal(ui.sounds.length, 0)
  assert.ok(ui.nodes.has('web-notifications'))
  ui.gesture(); await ui.poll()
  assert.equal(ui.sounds.length, 0, 'a late gesture does not replay the old notification')
  server.add({ seq: 11 }); await ui.poll()
  assert.equal(ui.sounds.length, 3)
  ui.context.resetNotificationSync()
  assert.equal(ui.audioContexts[0].state, 'closed', 'logout closes the old audio context')

  const blocked = await ready({ audio: 'blocked' })
  blocked.ui.gesture(); blocked.server.add(); blocked.server.time(4000); await blocked.ui.poll()
  assert.equal(blocked.ui.sounds.length, 0)
  assert.ok(blocked.ui.nodes.has('web-notifications'))
})

test('current visible chat, refused claims and native shells never play the web chime', async () => {
  const { ui, server } = await ready({ audio: true, focused: true })
  ui.gesture(); ui.state.path = '/a/bot-a'
  server.add(); server.time(4000); await ui.poll()
  assert.equal(server.claims.size, 0)
  assert.equal(ui.sounds.length, 0)
  ui.state.path = '/profile'
  const api = ui.context.api
  ui.context.api = (m, p, b) => p.endsWith('/claim') ? { claimed: false } : api(m, p, b)
  await ui.poll()
  assert.equal(ui.sounds.length, 0)

  for (const platform of ['desktop', 'mobile']) {
    const native = await ready({ platform, audio: true })
    native.ui.gesture(); native.server.add(); native.server.time(4000); await native.ui.poll()
    assert.equal(native.ui.audioContexts.length, 0)
    assert.equal(native.ui.sounds.length, 0)
  }
})
