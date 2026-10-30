/** 共享未读的展示层。计数来自 notification-sync.js 的服务端快照。 */
let webNoticeAccount = ''
const webNoticeUnread = new Map()
let webNoticeCards = []
const webNoticeTitle = document.title || 'Satuwork Gateway'
let webNoticeAudio = null

/** 浏览器要求用户手势解锁音频。只解锁，不补播之前因自动播放限制而静音的通知。 */
function unlockWebNotificationSound() {
  if (!webNoticesEnabled()) return
  try {
    const Audio = window.AudioContext || window.webkitAudioContext
    if (!Audio) return
    if (!webNoticeAudio || webNoticeAudio.state === 'closed') webNoticeAudio = new Audio()
    if (webNoticeAudio.state === 'suspended') void webNoticeAudio.resume().catch(() => {})
  } catch { /* 不支持音频或浏览器禁播时，通知卡片照常显示。 */ }
}

/** 一批新领取的通知响一次；历史、已读、重复领取和正在阅读的会话都不会走到这里。 */
function playWebNotificationSound() {
  if (!webNoticesEnabled() || webNoticeAudio?.state !== 'running') return false
  try {
    const audio = webNoticeAudio
    // 较低音区的 C–E–G 短铃声，轻起音、自然衰减，避免尖锐的高音提示。
    for (const [frequency, offset] of [[523.25, 0], [659.25, 0.10], [783.99, 0.20]]) {
      const oscillator = audio.createOscillator(), gain = audio.createGain()
      const at = audio.currentTime + offset
      oscillator.type = 'triangle'
      oscillator.frequency.setValueAtTime(frequency, at)
      gain.gain.setValueAtTime(0.0001, at)
      gain.gain.exponentialRampToValueAtTime(0.075, at + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.26)
      oscillator.connect(gain); gain.connect(audio.destination)
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect() }
      oscillator.start(at); oscillator.stop(at + 0.28)
    }
    return true
  } catch { return false }
}

function webNoticesEnabled() {
  return !appShell() && !!state.me?.account?.id && state.me.account.role !== 'owner'
}

function webNoticeFocusedBot() {
  if (document.visibilityState === 'hidden' || !document.hasFocus?.()) return ''
  if (!isChatPath(state.path) || !state.chatSessionId || !document.getElementById('chat-thread')) return ''
  const botId = chatBotIdOf(state.path) || state.chatBotId
  return botId === state.chatBotId ? botId : ''
}

function resetWebNotifications() {
  try { if (webNoticeAudio) void webNoticeAudio.close().catch(() => {}) } catch {}
  webNoticeAudio = null
  webNoticeAccount = ''
  webNoticeUnread.clear()
  webNoticeCards = []
  document.title = webNoticeTitle
  document.getElementById('web-notifications')?.remove()
}

function webNoticeLabel(kind) {
  if (kind === 'approval') return t('需要你审批', 'Approval needed')
  if (kind === 'handoff') return t('需要人工接手', 'Human assistance needed')
  return t('回复已完成', 'Reply ready')
}

function webNoticeUnreadLabel(count) {
  return localeMode === 'en' ? `${count} unread notifications` : `${count} 条未读通知`
}

/** 换页只刷新展示；是否已读由可视区域检测和服务端游标决定。 */
function syncWebNotifications() {
  if (!state.me?.account) return
  paintWebNotifications()
  if (typeof scheduleNotificationRead === 'function') scheduleNotificationRead()
}

function paintWebNotifications() {
  let total = 0
  for (const n of webNoticeUnread.values()) total += n
  document.title = total ? `(${total > 99 ? '99+' : total}) ${webNoticeTitle}` : webNoticeTitle
  for (const badge of document.querySelectorAll('[data-web-unread]')) {
    const n = webNoticeUnread.get(badge.getAttribute('data-web-unread')) || 0
    badge.hidden = !n
    badge.textContent = n > 99 ? '99+' : String(n)
    badge.setAttribute('aria-label', webNoticeUnreadLabel(n))
    badge.title = webNoticeUnreadLabel(n)
  }
  let host = document.getElementById('web-notifications')
  if (!webNoticesEnabled() || !webNoticeCards.length) { host?.remove(); return }
  if (!host) {
    host = document.createElement('div')
    host.id = 'web-notifications'
    host.setAttribute('aria-live', 'polite')
    host.setAttribute('aria-relevant', 'additions text')
    document.body.appendChild(host)
    host.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-web-notice]')
      if (!button || !host.contains(button)) return
      const id = button.getAttribute('data-web-notice')
      if (button.hasAttribute('data-dismiss')) {
        webNoticeCards = webNoticeCards.filter((row) => row.botId !== id)
        paintWebNotifications()
      } else go('/a/' + encodeURIComponent(id))
    })
  }
  host.innerHTML = webNoticeCards.map(({ botId, kind, preview }) => {
    const bot = (state.runtimeBots || []).find((b) => b.id === botId)
    const count = webNoticeUnread.get(botId) || 0
    return `<div class="satu-web-notice">
      <button type="button" class="satu-web-notice-open" data-web-notice="${esc(botId)}">
        <strong>${esc(bot?.name || 'Satuwork')}</strong>
        <span>${esc(webNoticeLabel(kind))} · ${esc(webNoticeUnreadLabel(count))}</span>
        ${preview ? `<span class="satu-web-notice-preview">${esc(preview)}</span>` : ''}
      </button>
      <button type="button" class="satu-web-notice-close" data-web-notice="${esc(botId)}" data-dismiss aria-label="${esc(t('关闭', 'Dismiss'))}">×</button>
    </div>`
  }).join('')
}

document.addEventListener('pointerdown', unlockWebNotificationSound, { capture: true, passive: true })
document.addEventListener('keydown', unlockWebNotificationSound, { capture: true })
