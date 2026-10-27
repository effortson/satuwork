/** 共享未读的展示层。计数来自 notification-sync.js 的服务端快照。 */
let webNoticeAccount = ''
const webNoticeUnread = new Map()
let webNoticeCards = []
const webNoticeTitle = document.title || 'Satuwork Gateway'

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
  host.innerHTML = webNoticeCards.map(({ botId, kind }) => {
    const bot = (state.runtimeBots || []).find((b) => b.id === botId)
    const count = webNoticeUnread.get(botId) || 0
    return `<div class="satu-web-notice">
      <button type="button" class="satu-web-notice-open" data-web-notice="${esc(botId)}">
        <strong>${esc(bot?.name || 'Satuwork')}</strong>
        <span>${esc(webNoticeLabel(kind))} · ${esc(webNoticeUnreadLabel(count))}</span>
      </button>
      <button type="button" class="satu-web-notice-close" data-web-notice="${esc(botId)}" data-dismiss aria-label="${esc(t('关闭', 'Dismiss'))}">×</button>
    </div>`
  }).join('')
}
