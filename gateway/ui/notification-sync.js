/** 三端共享的已读与通知。业务流只负责正文/待处理状态，提醒由 Gateway 统一领取。 */
let notificationAccount = ''
let notificationEpoch = 0
let notificationTimer = 0
let notificationReadingTimer = 0
let notificationRun = null
let notificationStartedAt = null
const notificationBaseline = new Set()
let notificationRevision = 0
let notificationFailures = 0
let notificationEvents = []
let notificationDismissed = ''
let notificationDevice = ''
const notificationReads = new Map()
const notificationPendingReads = new Map()
const notificationPendingEvents = new Map()
const notificationLocalEvents = new Map()
const notificationAttempted = new Set()
const notificationTaskTurns = new Map()

function notificationKey(botId, sessionId) { return JSON.stringify([botId, sessionId]) }
function notificationStorageKey() { return 'satu.notificationReads:' + gatewayBase() + ':' + notificationAccount }
function notificationCurrent(epoch) { return epoch === notificationEpoch && notificationAccount === state.me?.account?.id }

function notificationDeviceId() {
  if (notificationDevice) return notificationDevice
  const platform = desktopNoticeBridge() ? 'desktop' : 'web'
  const key = 'satu.notificationDevice:' + platform
  let id = ''
  try { id = localStorage.getItem(key) || '' } catch {}
  /**
   * 桌面端没存过的，用壳子给的设备身份（device.rs）——一台电脑一个身份。**已经存过的照旧用存的那个**：
   * 投递按（事件, 设备）去重，升级后换个 id，重放窗口里已经弹过的提醒会被当成新设备再弹一遍。
   */
  const shellId = window.__SATUWORK_DESKTOP_DEVICE__?.id || ''
  if (platform === 'desktop' && !/^[a-zA-Z0-9_-]{16,100}$/.test(id) && /^[a-zA-Z0-9_-]{16,100}$/.test(shellId)) {
    id = shellId
    try { localStorage.setItem(key, id) } catch {}
  }
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(id)) {
    id = globalThis.crypto?.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2))
    try { localStorage.setItem(key, id) } catch {}
  }
  notificationDevice = platform + ':' + id
  return notificationDevice
}

function saveNotificationReads() {
  try {
    const key = notificationStorageKey()
    if (notificationPendingReads.size) localStorage.setItem(key, JSON.stringify([...notificationPendingReads.values()]))
    else localStorage.removeItem(key)
  } catch {}
}

function saveLocalNotifications() {
  try {
    const key = notificationStorageKey() + ':events'
    if (notificationPendingEvents.size) localStorage.setItem(key, JSON.stringify([...notificationPendingEvents.values()]))
    else localStorage.removeItem(key)
  } catch {}
}

function resetNotificationSync() {
  ++notificationEpoch
  clearTimeout(notificationTimer)
  clearTimeout(notificationReadingTimer)
  notificationTimer = notificationReadingTimer = 0
  notificationRun = null
  notificationAccount = ''
  notificationStartedAt = null
  notificationBaseline.clear()
  notificationEvents = []
  notificationDismissed = ''
  notificationFailures = 0
  notificationReads.clear()
  notificationPendingReads.clear()
  notificationPendingEvents.clear()
  notificationLocalEvents.clear()
  notificationAttempted.clear()
  notificationTaskTurns.clear()
  resetWebNotifications()
}

function syncNotificationState() {
  const account = state.me?.account
  if (!account || account.role === 'owner') {
    if (notificationAccount) resetNotificationSync()
    return
  }
  if (notificationAccount !== account.id) {
    resetNotificationSync()
    notificationAccount = account.id
    webNoticeAccount = account.id
    try {
      const rows = JSON.parse(localStorage.getItem(notificationStorageKey()) || '[]')
      for (const row of rows) if (row.botId && row.sessionId && Number.isSafeInteger(row.seq) && row.seq > 0) {
        const key = notificationKey(row.botId, row.sessionId)
        notificationPendingReads.set(key, row)
        notificationReads.set(key, { ...row, lastReadSeq: row.seq, version: 0 })
      }
    } catch {}
    try {
      for (const row of JSON.parse(localStorage.getItem(notificationStorageKey() + ':events') || '[]')) {
        if (row.botId && row.sessionId && row.seq > 0) notificationPendingEvents.set(JSON.stringify([row.botId, row.sessionId, row.seq, row.kind]), row)
      }
    } catch {}
  }
  scheduleNotificationSync(0)
  scheduleNotificationRead()
}

function scheduleNotificationSync(delay = 100) {
  if (!notificationAccount) return
  clearTimeout(notificationTimer)
  const epoch = notificationEpoch
  notificationTimer = setTimeout(() => { if (notificationCurrent(epoch)) void pollNotifications(epoch) }, delay)
  notificationTimer.unref?.()
}

function notificationUnread(event) {
  return event.seq > (notificationReads.get(notificationKey(event.botId, event.sessionId))?.lastReadSeq || 0)
}

async function pollNotifications(epoch = notificationEpoch) {
  if (!notificationCurrent(epoch)) return
  if (notificationRun) return notificationRun
  const work = (async () => {
    try {
      // 先提交离线期间读过的位置，再取快照；避免恢复联网时旧通知抢先弹出来。
      for (const [key, row] of notificationPendingReads) {
        let result
        try { result = await api('PUT', '/me/notifications/read', row) }
        catch (e) {
          if (!notificationCurrent(epoch)) return
          if (e?.status !== 404) throw e
          notificationPendingReads.delete(key)
          saveNotificationReads()
          continue
        }
        const { read } = result
        if (!notificationCurrent(epoch)) return
        const pending = notificationPendingReads.get(key)
        if (pending && pending.seq <= read.lastReadSeq) notificationPendingReads.delete(key)
        const old = notificationReads.get(key)
        if (!old || old.lastReadSeq <= read.lastReadSeq) notificationReads.set(key, read)
        saveNotificationReads()
      }
      for (const [key, row] of notificationPendingEvents) {
        try { await api('POST', '/me/notifications/local', row) }
        catch (e) {
          if (!notificationCurrent(epoch)) return
          // 离线期间被删除或改成远程的 Bot，不得用一条永久失败挡住其他会话同步。
          if (e?.status !== 400 && e?.status !== 404) throw e
        }
        if (!notificationCurrent(epoch)) return
        if (notificationPendingEvents.get(key) === row) notificationPendingEvents.delete(key)
        saveLocalNotifications()
      }
      const revision = notificationRevision
      const snapshot = await api('GET', '/me/notifications' + (window.__SATUWORK_MOBILE__ ? '?platform=mobile' : ''))
      if (!notificationCurrent(epoch) || revision !== notificationRevision || notificationPendingReads.size) return
      notificationFailures = 0
      // 服务端时间决定缓冲到期；设备时钟不同不会造成提前弹出。
      if (notificationStartedAt === null) {
        notificationStartedAt = snapshot.serverTime
        for (const event of snapshot.events || []) notificationBaseline.add(event.id)
      }
      for (const read of snapshot.reads || []) {
        const key = notificationKey(read.botId, read.sessionId)
        const old = notificationReads.get(key)
        if (!old || read.lastReadSeq >= old.lastReadSeq) notificationReads.set(key, read)
      }
      notificationEvents = snapshot.events || []
      webNoticeUnread.clear()
      for (const row of snapshot.counts || []) if (row.count > 0) webNoticeUnread.set(row.botId, row.count)
      webNoticeCards = webNoticeCards.filter((card) => notificationEvents.some((ev) => ev.id === card.id && notificationUnread(ev)))
      paintWebNotifications()
      const dismissed = snapshot.dismissedIds || []
      const dismissedKey = dismissed.join(',')
      if (dismissedKey !== notificationDismissed) {
        const bridge = desktopNoticeBridge() || (typeof pushBridge === 'function' ? pushBridge() : null)
        if (typeof bridge?.clear === 'function') {
          try {
            await bridge.clear(dismissed, desktopNoticeGeneration)
            if (!notificationCurrent(epoch)) return
            notificationDismissed = dismissedKey
          } catch { /* 系统不支持撤回已展示通知时，游标和角标仍照常同步。 */ }
        }
      }
      // 已读更新只清提醒，不触碰 asks/openIds 等待处理集合。
      for (const event of notificationEvents) {
        if (!notificationCurrent(epoch)) return
        if (event.createdAt < notificationStartedAt || notificationBaseline.has(event.id) || event.dueAt > snapshot.serverTime || !notificationUnread(event) || notificationAttempted.has(event.id)) continue
        if (window.__SATUWORK_MOBILE__) continue // 手机系统提醒由服务端 APNs / FCM 调度。
        const bot = (state.runtimeBots || []).find((b) => b.id === event.botId)
        if (bot?.runtimeKind === 'local' && !desktopNoticeBridge()) continue
        if (desktopNoticeBridge() ? document.hasFocus?.() : webNoticeFocusedBot() === event.botId) continue
        const { claimed } = await api('POST', '/me/notifications/' + encodeURIComponent(event.id) + '/claim', { deviceId: notificationDeviceId() })
        if (!notificationCurrent(epoch)) return
        notificationAttempted.add(event.id)
        while (notificationAttempted.size > 4096) notificationAttempted.delete(notificationAttempted.values().next().value)
        if (!claimed || !notificationUnread(event)) continue
        if (desktopNoticeBridge()) await deliverDesktopNotification(event)
        else if (webNoticesEnabled()) {
          webNoticeCards = [{ id: event.id, botId: event.botId, kind: event.kind }, ...webNoticeCards.filter((r) => r.botId !== event.botId)].slice(0, 3)
          paintWebNotifications()
        }
      }
    } catch (e) {
      // 断网不清游标；下一次连接先补交已读。鉴权失效由 api() 统一退出。
      if (notificationCurrent(epoch)) {
        ++notificationFailures
        if (notificationFailures === 1 && e?.status >= 500) console.debug('satuwork: 通知同步稍后重试', e?.message || e)
      }
    }
  })()
  notificationRun = work
  try { await work } finally {
    if (notificationRun === work) notificationRun = null
    if (notificationCurrent(epoch)) scheduleNotificationSync(notificationFailures
      ? Math.min(30000, 1000 * 2 ** Math.min(notificationFailures - 1, 5))
      : notificationPendingReads.size ? 500 : document.visibilityState === 'hidden' ? 3000 : 1000)
  }
}

/** 只有渲染并实际进入视野的内容才能推进游标。挂着连接、打开设置、向上翻历史都不算读到底。 */
function scheduleNotificationRead() {
  clearTimeout(notificationReadingTimer)
  if (!notificationAccount) return
  notificationReadingTimer = setTimeout(markVisibleNotificationsRead, 80)
  notificationReadingTimer.unref?.()
}

function markVisibleNotificationsRead() {
  if (!notificationAccount || document.visibilityState === 'hidden' || !document.hasFocus?.() || !isChatPath(state.path) || state.chatReplaying) return
  const botId = chatBotIdOf(state.path) || state.chatBotId
  const sessionId = state.chatSessionId
  const thread = document.getElementById('chat-thread')
  if (!botId || botId !== state.chatBotId || !sessionId || !thread || !thread.querySelector('.sw-msg')) return
  const bounds = thread.getBoundingClientRect()
  if (bounds.bottom <= bounds.top) return
  let seq = 0
  if (nearBottom(thread)) {
    // 流式分片不需要一帧一写；最终消息、轮次收口和待处理卡才推进共享阅读位置。
    const readable = new Set(['assistant/message', 'user/message', 'turn/end', 'tool/approval', 'human/handoff'])
    for (const ev of state.chatEvents || []) if (readable.has(ev.type) && ev.seq > seq) seq = ev.seq
  } else {
    for (const row of thread.querySelectorAll('.sw-msg[data-seq]')) {
      const box = row.getBoundingClientRect()
      const n = Number(row.getAttribute('data-seq'))
      if (box.bottom > bounds.top && box.bottom <= bounds.bottom && n > seq) seq = n
    }
  }
  const key = notificationKey(botId, sessionId)
  if (!seq || seq <= (notificationReads.get(key)?.lastReadSeq || 0)) return
  ++notificationRevision
  notificationReads.set(key, { botId, sessionId, lastReadSeq: seq, version: 0 })
  notificationPendingReads.set(key, { botId, sessionId, seq })
  saveNotificationReads()
  webNoticeCards = webNoticeCards.filter((card) => !notificationEvents.some((ev) => ev.id === card.id && !notificationUnread(ev)))
  paintWebNotifications()
  scheduleNotificationSync(0)
}

/** 本地 Bot 的派活也在主会话中。重放时重建归属，重复流按 seq 去重，老席位的插话仍算人的那一轮。 */
function notificationIsTaskTurn(botId, sessionId, ev) {
  const key = notificationKey(botId, sessionId)
  let row = notificationTaskTurns.get(key)
  if (!row) {
    row = { seq: 0, open: null, pending: false, task: false, justTask: false, taskEndSeq: 0 }
    notificationTaskTurns.set(key, row)
  }
  if (ev.seq <= row.seq) return ev.type === 'turn/end' && ev.seq === row.taskEndSeq
  row.seq = ev.seq
  const afterTask = row.justTask
  row.justTask = false
  const d = ev.data || {}
  if (ev.type === 'user/message') {
    const source = d.source
    row.justTask = source?.kind === 'plugin' && source.plugin === 'task' && source.phase !== 'result'
    if (row.open === null) row.pending = row.justTask
  } else if (ev.type === 'turn/start') {
    row.open = Number(d.turn)
    row.task = row.pending || afterTask
    row.pending = false
  } else if (ev.type === 'turn/end') {
    const task = row.task
    if (task) row.taskEndSeq = ev.seq
    if (Number(d.turn) === row.open) { row.open = null; row.task = false }
    return task
  }
  return false
}

/** 原始流只唤醒同步；本地 Bot 另外登记元数据，远程 Bot 由席位可靠上报。 */
async function observeNotificationEvent(botId, ev, replay, sessionId) {
  if (!notificationAccount || !sessionId || !ev?.seq) return
  const taskTurn = notificationIsTaskTurn(botId, sessionId, ev)
  let kind, actionId = '', resolved = false
  const d = ev.data || {}
  if (ev.type === 'turn/end' && d.reason !== 'aborted' && !taskTurn) kind = 'turn-end'
  else if (ev.type === 'tool/approval' && d.callId) { kind = 'approval'; actionId = d.callId; resolved = d.state !== 'pending' }
  else if (ev.type === 'human/handoff' && d.id) { kind = 'handoff'; actionId = d.id; resolved = d.state !== 'open' }
  else return
  const bot = (state.runtimeBots || []).find((b) => b.id === botId)
  const key = JSON.stringify([botId, sessionId, kind, actionId || ev.seq])
  if (actionId && !resolved && !notificationLocalEvents.has(key)) notificationLocalEvents.set(key, { seq: ev.seq, time: ev.time })
  while (notificationLocalEvents.size > 2048) notificationLocalEvents.delete(notificationLocalEvents.keys().next().value)
  if (bot?.runtimeKind === 'local' && desktopNoticeBridge() && !replay) {
    const source = kind === 'turn-end' ? ev : notificationLocalEvents.get(key) || (resolved ? ev : null)
    if (source) {
      const noticeKey = JSON.stringify([botId, sessionId, source.seq, kind])
      const previous = notificationPendingEvents.get(noticeKey)
      notificationPendingEvents.set(noticeKey, { botId, sessionId, seq: source.seq, time: source.time, kind, actionId, resolved: resolved || previous?.resolved || false })
      saveLocalNotifications()
    }
  }
  if (!replay) scheduleNotificationSync(100)
  scheduleNotificationRead()
}

document.addEventListener('visibilitychange', () => { if (notificationAccount) { scheduleNotificationRead(); scheduleNotificationSync(0) } })
document.addEventListener('scroll', scheduleNotificationRead, true)
window.addEventListener('focus', () => { if (notificationAccount) { scheduleNotificationRead(); scheduleNotificationSync(0) } })
window.addEventListener('online', () => scheduleNotificationSync(0))
window.addEventListener('pagehide', resetNotificationSync)
