import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { notificationPreview } from '../../../core/src/chat/notification.ts'

export const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
export const plain = (value) => JSON.parse(JSON.stringify(value))

export function noticeServer() {
  const reads = new Map(), events = [], claims = new Set(), requests = []
  let clock = 1000, offline = false
  const key = (account, bot, session) => JSON.stringify([account, bot, session])
  const unread = (a, e) => e.accountId === a && !e.resolved && e.seq > (reads.get(key(a, e.botId, e.sessionId))?.lastReadSeq || 0)
  return {
    reads, events, claims, requests,
    time: (n) => { clock = n }, offline: (n) => { offline = n },
    add: (event = {}) => {
      const e = { id: `event-${events.length + 1}`, accountId: 'account-a', botId: 'bot-a', sessionId: 'session-a',
        seq: 10, kind: 'turn-end', preview: '', createdAt: 1100, dueAt: 3100, expiresAt: 3601100, ...event }
      events.push(e)
      return e
    },
    async api(account, method, path, body) {
      requests.push({ account, method, path, body })
      if (offline) throw new Error('offline')
      if (path.endsWith('/read')) {
        const k = key(account, body.botId, body.sessionId), old = reads.get(k)
        const read = { botId: body.botId, sessionId: body.sessionId, lastReadSeq: Math.max(old?.lastReadSeq || 0, body.seq), version: (old?.version || 0) + 1 }
        reads.set(k, read)
        return { read }
      }
      if (path.endsWith('/claim')) {
        const id = path.split('/').at(-2), e = events.find((e) => e.id === id), k = account + ':' + id + ':' + body.deviceId
        const claimed = e && unread(account, e) && clock >= e.dueAt && !claims.has(k)
        if (claimed) claims.add(k)
        return { claimed: !!claimed }
      }
      if (path.endsWith('/local')) {
        const existing = events.find((e) => e.accountId === account && e.botId === body.botId && e.sessionId === body.sessionId && e.seq === body.seq && e.kind === body.kind)
        if (existing) existing.resolved ||= body.resolved
        else this.add({ ...body, preview: notificationPreview(body.preview), accountId: account, resolved: body.resolved, createdAt: clock })
        return { id: existing?.id || events.at(-1).id }
      }
      const mine = events.filter((e) => unread(account, e))
      const counts = new Map()
      for (const e of mine) counts.set(e.botId, (counts.get(e.botId) || 0) + 1)
      return { reads: [...reads].filter(([k]) => JSON.parse(k)[0] === account).map(([, v]) => plain(v)),
        events: plain(mine), counts: [...counts].map(([botId, count]) => ({ botId, count })),
        dismissedIds: events.filter((e) => e.accountId === account && !unread(account, e)).map((e) => e.id), serverTime: clock }
    },
  }
}

export function notificationClient(server, { platform = 'web', focused = false, hidden = false, storage = new Map(), audio = false } = {}) {
  const nodes = new Map(), windowEvents = {}, documentEvents = {}, sent = [], cleared = [], navigated = [], timers = new Map()
  let focus = focused, bottom = true, hasContent = true, timer = 0
  const sounds = [], audioContexts = []
  const badge = (id) => ({ hidden: true, getAttribute: () => id, setAttribute() {} })
  const badges = [badge('bot-a'), badge('bot-b')]
  const row = { getAttribute: () => '5', getBoundingClientRect: () => ({ top: 0, bottom: 200 }) }
  const thread = { querySelector: () => hasContent ? row : null, querySelectorAll: () => [row], getBoundingClientRect: () => ({ top: 0, bottom: 600 }) }
  nodes.set('chat-thread', thread)
  const document = {
    title: 'Satuwork Gateway', visibilityState: hidden ? 'hidden' : 'visible', hasFocus: () => focus,
    getElementById: (id) => nodes.get(id) || null, querySelectorAll: () => badges,
    createElement: () => ({ innerHTML: '', listeners: {}, setAttribute() {}, contains: () => true,
      addEventListener(type, fn) { this.listeners[type] = fn }, remove() { nodes.delete(this.id) } }),
    body: { appendChild: (node) => nodes.set(node.id, node) },
    addEventListener: (type, fn) => { documentEvents[type] = fn },
  }
  const state = { me: { account: { id: 'account-a', role: 'member' } }, path: '/profile', chatBotId: 'bot-a',
    chatSessionId: 'session-a', chatEvents: [], chatReplaying: false,
    runtimeBots: [{ id: 'bot-a', name: '助理 A' }, { id: 'bot-b', name: '助理 B' }] }
  const bridge = { session: async () => 1, send: async (notice) => { sent.push(plain(notice)); return true }, clear: async (ids) => { cleared.push(plain(ids)) } }
  const context = {
    state, document, console: { debug() {}, warn() {} }, localStorage: { getItem: (k) => storage.get(k) || null,
      setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
    window: { addEventListener: (type, fn) => { windowEvents[type] = fn } },
    setTimeout: (fn, ms) => { const id = ++timer; timers.set(id, { fn, ms }); return id }, clearTimeout: (id) => timers.delete(id),
    crypto: { randomUUID: () => '12345678-1234-1234-1234-123456789012' },
    gatewayBase: () => 'https://gateway.test', api: (m, p, b) => server.api(state.me.account.id, m, p, b),
    appShell: () => platform !== 'web', pushBridge: () => platform === 'mobile' ? bridge : null,
    nearBottom: () => bottom, isChatPath: (p) => p.startsWith('/a/'), chatBotIdOf: (p) => p.startsWith('/a/') ? p.slice(3) : '',
    go: (path) => navigated.push(path), localeMode: 'zh',
    t: (zh, en) => context.localeMode === 'en' ? en : zh,
    esc: (s) => String(s).replace(/[&<>"']/g, (v) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[v]),
    token: () => 'ticket', localBotOf: () => null,
  }
  if (platform === 'desktop') context.window.__SATUWORK_DESKTOP_NOTIFICATIONS__ = bridge
  if (platform === 'mobile') context.window.__SATUWORK_MOBILE__ = true
  if (audio) context.window.AudioContext = class {
    state = 'suspended'; currentTime = 0; destination = {}
    constructor() { audioContexts.push(this) }
    async resume() { if (audio === 'blocked') throw new Error('autoplay blocked'); this.state = 'running' }
    async close() { this.state = 'closed' }
    createOscillator() { return { frequency: { setValueAtTime() {} }, connect() {}, disconnect() {},
      start: (at) => sounds.push(at), stop() {} } }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} } }
  }
  runInNewContext(source('../../ui/core.js') + '\n' + source('../../ui/notification-sync.js') + '\n' + source('../../ui/web-notifications.js') + '\n' + source('../../ui/desktop-notifications.js') + `
    globalThis.inspectNotices = () => ({ unread: [...webNoticeUnread], cards: webNoticeCards, pending: [...notificationPendingReads.values()] });
  `, context)
  return {
    context, state, document, nodes, badges, sent, cleared, navigated, storage, timers, sounds, audioContexts,
    gesture: () => documentEvents.pointerdown?.(),
    start: async () => { await context.syncDesktopNotifications(); context.syncNotificationState(); await context.pollNotifications() },
    poll: () => context.pollNotifications(),
    focus: (v) => { focus = v; if (v) windowEvents.focus?.() },
    hidden: (v) => { document.visibilityState = v ? 'hidden' : 'visible'; documentEvents.visibilitychange?.() },
    bottom: (v) => { bottom = v }, content: (v) => { hasContent = v },
    read: () => context.markVisibleNotificationsRead(),
    inspect: () => plain(context.inspectNotices()),
    click: (id, dismiss = false) => nodes.get('web-notifications').listeners.click({ target: { closest: () => ({ getAttribute: () => id, hasAttribute: () => dismiss }) } }),
  }
}
