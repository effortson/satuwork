/**
 * 桌面通知：远程 Bot 复用名单流；本地 Bot 在各自的 loopback 端口听一条流，保证未打开的
 * Bot 和定时任务也能提醒。只消费主会话，跳过重放，只保留通知短摘要、不建立远程推送设备。
 * 事件只唤醒 Gateway 的统一通知调度；原生层最后核对焦点和登录代次。
 */
let desktopNoticeAccount = ''
let desktopNoticeGeneration = 0
let desktopNoticeEpoch = 0
let desktopNoticeSession = null
const desktopNoticeRosterReady = new Set()
const desktopLocalNotices = new Map()

function desktopNoticeBridge() {
  return window.__SATUWORK_DESKTOP_NOTIFICATIONS__ || null
}

async function syncDesktopNotifications() {
  const bridge = desktopNoticeBridge()
  const account = state.me?.account
  if (!bridge || !account || account.role === 'owner') {
    if (desktopNoticeAccount) resetDesktopNotifications()
    return
  }
  if (desktopNoticeAccount === account.id && desktopNoticeSession) {
    await desktopNoticeSession
    syncDesktopLocalNotices()
    return
  }
  const epoch = ++desktopNoticeEpoch
  desktopNoticeAccount = account.id
  desktopNoticeGeneration = 0
  for (const row of desktopLocalNotices.values()) row.ac.abort()
  desktopLocalNotices.clear()
  desktopNoticeRosterReady.clear()
  desktopNoticeSession = bridge.session(account.id).then((generation) => {
    if (epoch !== desktopNoticeEpoch || state.me?.account?.id !== account.id) return
    desktopNoticeGeneration = generation
    syncDesktopLocalNotices()
  }).catch((error) => {
    if (epoch === desktopNoticeEpoch) desktopNoticeSession = null
    console.warn('satuwork: 桌面通知初始化失败：' + String(error?.message || error))
  })
  await desktopNoticeSession
}

function resetDesktopNotifications() {
  if (typeof resetNotificationSync === 'function') resetNotificationSync()
  else if (typeof resetWebNotifications === 'function') resetWebNotifications()
  ++desktopNoticeEpoch
  desktopNoticeAccount = ''
  desktopNoticeGeneration = 0
  desktopNoticeSession = null
  desktopNoticeRosterReady.clear()
  for (const row of desktopLocalNotices.values()) row.ac.abort()
  desktopLocalNotices.clear()
  const bridge = desktopNoticeBridge()
  if (bridge) void bridge.session(null).catch(() => {})
}

/** Bot 事件只唤醒统一调度，不能绕过账号级已读自行弹通知。 */
async function notifyDesktopEvent(botId, ev, replay = false, sessionId = '') {
  if (typeof observeNotificationEvent === 'function') await observeNotificationEvent(botId, ev, replay, sessionId)
}

async function deliverDesktopNotification(event) {
  const bridge = desktopNoticeBridge()
  if (!bridge || !desktopNoticeGeneration || desktopNoticeAccount !== state.me?.account?.id || document.hasFocus?.()) return
  const bot = (state.runtimeBots || []).find((b) => b.id === event.botId)
  await bridge.send({ generation: desktopNoticeGeneration, botId: event.botId, title: bot?.name || 'Satuwork',
    body: event.preview || '',
    kind: event.kind, locale: localeMode === 'en' ? 'en' : 'zh', notificationId: event.id, sessionId: event.sessionId, seq: event.seq })
}

function syncDesktopLocalNotices() {
  if (!desktopNoticeBridge() || !desktopNoticeGeneration || !state.me) return
  const wanted = new Map()
  for (const bot of state.runtimeBots || []) {
    const local = bot.runtimeKind === 'local' && localBotOf(bot.id)
    if (local && local.login === token()) wanted.set(bot.id, local.base + '|' + local.token)
  }
  for (const [id, row] of desktopLocalNotices) {
    if (wanted.get(id) === row.route) continue
    row.ac.abort()
    desktopLocalNotices.delete(id)
  }
  for (const [id, route] of wanted) {
    if (desktopLocalNotices.has(id)) continue
    const row = { ac: new AbortController(), route }
    desktopLocalNotices.set(id, row)
    void pumpDesktopLocalNotices(id, row)
  }
}

async function pumpDesktopLocalNotices(botId, row) {
  const { signal } = row.ac
  let attempt = 0
  while (!signal.aborted) {
    try {
      const session = await swFetch('/runtime/bots/' + encodeURIComponent(botId) + '/session', { signal })
      if (!session.ok) throw new Error('HTTP ' + session.status)
      const { sessionId } = await session.json()
      if (signal.aborted) return
      if (!sessionId) throw new Error('没有会话')
      localSessions.set(sessionId, botId)
      const response = await swFetch('/runtime/sessions/' + encodeURIComponent(sessionId) + '/events?tail=1', { signal })
      if (!response.ok || !response.body) throw new Error('HTTP ' + response.status)
      let live = false
      for await (const ev of sseEvents(response.body.getReader(), () => signal.aborted)) {
        if (signal.aborted) return
        if (ev.type === 'replay/done') { live = true; attempt = 0; continue }
        void notifyDesktopEvent(botId, ev, !live, sessionId)
      }
    } catch { /* 本地 Bot 重启或换票时退避重连；登出时由 AbortSignal 立即收掉。 */ }
    if (!signal.aborted) await desktopNoticePause(SatuCore.rosterRetryDelay(++attempt), signal)
  }
}

function desktopNoticePause(ms, signal) {
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })
}

window.__SATUWORK_DESKTOP_NOTIFICATION_TAPPED__ = (generation, botId) => {
  if (state.me && desktopNoticeGeneration === generation && botId) go('/a/' + encodeURIComponent(botId))
}

if (typeof window.addEventListener === 'function') window.addEventListener('pagehide', resetDesktopNotifications)
