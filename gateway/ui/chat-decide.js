/** 人在卡片上拍板：批准 / 拒绝高风险调用、转人工的处理与交还，以及转人工待办的轮询。原先在 chat.js 里，拆出来只是搬家（顺序见 index.html）。 */
/**
 * 批准 / 拒绝一次高风险调用。
 *
 * **按下去先把卡片停用。** 终态是靠 SSE 那条事件回来的，一来一回几百毫秒，这期间
 * 按钮还亮着——人会以为没点上再点一次，而第二次点的是一条已经结束的确认，席位回
 * 409，界面上无端冒出一句「这条确认已经结束了」。
 *
 * 失败了要把它恢复回去：那次真的没送到，卡片得还能点。
 *
 * `feedback` 只跟着拒绝走：「退回修改」就是一次带意见的拒绝，席位把意见原样交给模型，
 * 让它照着改完再提交一次（见 bot/src/policy/index.ts 的 blockedByUser）。
 */
async function decideApproval(callId, decision, scope, feedback) {
  const sessionId = state.chatSessionId
  if (!sessionId || !callId) return
  const box = [...document.querySelectorAll('.sw-approval')].find((el) => el.getAttribute('data-call') === callId)
  if (box) {
    if (box.getAttribute('data-busy') === '1') return
    box.setAttribute('data-busy', '1')
  }
  try {
    const note = decision === 'deny' ? String(feedback || '').trim() : ''
    await api(
      'POST',
      '/runtime/sessions/' + encodeURIComponent(sessionId) + '/approvals/' + encodeURIComponent(callId),
      { decision, scope: scope || 'once', ...(note ? { feedback: note } : {}) },
    )
    // 这一条已经落定，草稿留着只会在下一次同名 callId 上冒出来（不会发生，但也没用了）。
    for (const key of [...approvalDrafts.keys()]) {
      if (key.startsWith(callId + '::')) approvalDrafts.delete(key)
    }
  } catch (err) {
    if (box) box.removeAttribute('data-busy')
    // 409 是「这条早就结束了」——超时、被停止、席位重启过、或者另一个标签页先点了。它不是
    // 错误，但必须说出来：人点了一下什么都没发生才是最糟的。
    flash('err', err && err.message ? err.message : t('没能提交这次确认', 'Could not submit that decision'))
    if (err && err.status === 409) {
      // 席位说了不在等，卡片就收成「已失效」，右栏「等你拍板」里那一条也一起拿掉，
      // 不然它们还亮着让人接着点。
      goneApprovals.add(callId)
      for (const row of botStreams.values()) {
        if (row && row.sum && row.sum.asks && row.sum.asks.delete(callId)) settleDot(row.sum)
      }
      // 卡片按签名跳过重画（chat-thread.js 的 apSig），签名里只有还在等的 callId，所以
      // 它少了一条签名就变了，这一下整块重画。
      render()
    }
  }
}

/** 交接卡上还没提交的那句话。key 是单号。重画时先存后填，见 updateRow。 */
const handoffDrafts = new Map()

/**
 * 右栏待办那一屏（还有 /handoffs 整页）里正写着的结论：重画之前存起来、画完填回去。
 *
 * 对话里那张卡有自己的一套（updateRow 按签名比，变了才换），右栏和整页是 render() /
 * paintAsideHandoffs 整块换的，换一次框里的字就没了——而 render() 在对话页上随时会来。
 *
 * **两边各存各的**（panelDrafts / handoffDrafts）。同一张单可能两边各有一个框，共用一份
 * 的话，对话卡里写的那句会在下一次重画时被抄进右栏那个框，之后两个框各改各的就对不上了。
 */
const panelDrafts = new Map()

function noteMapOf(ta) {
  return ta.closest && ta.closest('.gw-aside, .gw-page') ? panelDrafts : handoffDrafts
}

function stashHandoffNotes(root) {
  if (!root || !root.querySelectorAll) return
  // 同一边同一张单只该有一个框；真有两个，只要有一个写了字就记那一句。
  const seen = new Map()
  for (const ta of root.querySelectorAll('.sw-handoff-note')) {
    const id = ta.getAttribute('data-handoff')
    if (!id) continue
    const map = noteMapOf(ta)
    const key = (map === panelDrafts ? 'p:' : 'c:') + id
    const prev = seen.get(key)
    seen.set(key, { map, id, text: (prev && prev.text) || ta.value })
  }
  for (const { map, id, text } of seen.values()) {
    if (text) map.set(id, text)
    else map.delete(id)
  }
}

/** 填回去的只有右栏 / 待办页的框：对话里那张卡由 updateRow 自己填，这时它还没画出来。 */
function fillHandoffNotes(root) {
  if (!root || !root.querySelectorAll) return
  for (const ta of root.querySelectorAll('.gw-aside .sw-handoff-note, .gw-page .sw-handoff-note')) {
    const draft = panelDrafts.get(ta.getAttribute('data-handoff'))
    if (draft && !ta.value) ta.value = draft
  }
}

/**
 * 接手 / 交还 / 撤销。
 *
 * **走 `/runtime/handoffs/:id/*`，不走会话那条路。** 接手的人可能是管理员，这条会话
 * 根本不是他的——按会话鉴权的那几条路由在那时会把他挡在外面，而他恰恰是该来处理这件
 * 事的人（见 gateway/src/routes/handoffs.ts）。
 */
const handoffPending = new Set()

/** Feedback lives in the card, so an aside failure is visible beside its own action. */
function setHandoffFeedback(id, text, error = false) {
  state.handoffFeedback = { ...(state.handoffFeedback || {}), [id]: { text, error } }
  for (const node of document.querySelectorAll('[data-handoff-feedback]')) {
    if (node.getAttribute('data-handoff-feedback') !== id) continue
    node.textContent = text
    node.hidden = false
    node.setAttribute('role', error ? 'alert' : 'status')
    node.setAttribute('data-error', error ? '1' : '0')
  }
}

async function actOnHandoff(id, act, body, near) {
  if (!id || handoffPending.has(id)) return
  const box = (near && near.closest ? near.closest('.sw-handoff, [data-handoff-row]') : null) ||
    [...document.querySelectorAll('.sw-handoff')].find(el => el.getAttribute('data-handoff') === id)
  const previousFeedback = (state.handoffFeedback || {})[id]
  handoffPending.add(id)
  const controls = box && box.querySelectorAll ? [...box.querySelectorAll('button, textarea')] : []
  const enabled = controls.map(el => ({ el, disabled: el.disabled, readOnly: el.readOnly }))
  for (const { el } of enabled) {
    if (el.tagName === 'TEXTAREA') el.readOnly = true
    else el.disabled = true
  }
  if (box) {
    box.setAttribute('data-busy', '1')
    box.setAttribute('aria-busy', 'true')
  }
  setHandoffFeedback(id, t('正在提交，请稍候…', 'Submitting…'))
  try {
    await api('POST', '/runtime/handoffs/' + encodeURIComponent(id) + '/' + act, body || {})
    // Claiming a task must not discard notes already being written.
    if (act !== 'claim') {
      handoffDrafts.delete(id)
      panelDrafts.delete(id)
      for (const ta of document.querySelectorAll('.sw-handoff-note')) {
        if (ta.getAttribute('data-handoff') === id) ta.value = ''
      }
    }
    const message = act === 'claim' ? t('已接手。处理完成后，请填写说明并交还 Bot。', 'Claimed. Add an outcome and return it when ready.')
      : act === 'cancel' ? t('交接已撤销，未通知 Bot 继续。', 'Handoff cancelled. The bot was not asked to continue.')
      : t('处理说明已交还，等待 Bot 后续反馈。', 'Response returned. Awaiting the bot’s follow-up.')
    if (previousFeedback && previousFeedback.error && state.error === previousFeedback.text) dismissFlash()
    setHandoffFeedback(id, message)
    // SSE updates the chat; refresh the cross-bot inbox as well.
    await loadHandoffs()
  } catch (err) {
    const message = t('提交失败：', 'Could not submit: ') + ((err && err.message) || t('请稍后重试', 'Please retry'))
    setHandoffFeedback(id, message, true)
    // Keep the existing page-level notice too; render preserves both note drafts.
    flash('err', message)
    render()
  } finally {
    handoffPending.delete(id)
    for (const { el, disabled, readOnly } of enabled) {
      el.disabled = disabled
      el.readOnly = readOnly
    }
    if (box) {
      box.removeAttribute('data-busy')
      box.removeAttribute('aria-busy')
    }
  }
}

/**
 * 交还时那句话从哪个框里取。
 *
 * **先认点的那颗按钮所在的那张卡。** 同一张单可能同时摆着两张卡（对话里一张、右栏待办
 * 一张），两个框里的字未必一样——按文档顺序取第一个写了字的，取到的可能是另一张卡里
 * 旧的那句，交给 Bot 的就是人已经改掉的话。找不到按钮（失败重试那条路）才退回按单号
 * 找一个写了字的。
 */
function handoffNote(id, near) {
  const card = near && near.closest ? near.closest('.sw-handoff') : null
  const own = card ? card.querySelector('.sw-handoff-note') : null
  if (own) return own.value.trim()
  const tas = [...document.querySelectorAll('.sw-handoff-note')].filter((x) => x.getAttribute('data-handoff') === id)
  return tas.map((ta) => ta.value.trim()).find(Boolean) || ''
}

async function returnHandoff(id, disposition, near) {
  const text = handoffNote(id, near)
  const card = near && near.closest ? near.closest('.sw-handoff') : null
  const ta = card ? card.querySelector('.sw-handoff-note') :
    [...document.querySelectorAll('.sw-handoff-note')].find(el => el.getAttribute('data-handoff') === id)
  if (!text) {
    const message = disposition === 'instructions'
      ? t('请先填写希望 Bot 如何继续，再提交新指示。', 'Describe how the bot should continue before submitting instructions.')
      : t('请先填写处理结果，说明已完成的操作和结论。', 'Describe what you completed and the outcome before returning the task.')
    setHandoffFeedback(id, message, true)
    if (ta) {
      ta.setAttribute('aria-invalid', 'true')
      ta.focus()
    } else {
      flash('err', message)
      render()
    }
    return
  }
  if (ta) ta.removeAttribute('aria-invalid')
  await actOnHandoff(id, 'return', { disposition: disposition || 'done', text }, near)
}

/**
 * 待办清单 + 顶栏那个计数。
 *
 * **轮询，不是长连接。** 现在的 SSE 是按会话挂的（每颗 Bot 一条），而管理员对别人
 * 名下 Bot 的单子没有任何一条流。为这一个页面先造一条账号级的流不划算——30 秒一次
 * 的 GET 换来的东西一样多。
 */
async function loadHandoffs() {
  if (!state.me || !state.me.account || !state.me.account.companyId) return
  try {
    const data = await api('GET', '/runtime/handoffs')
    state.handoffs = Array.isArray(data.handoffs) ? data.handoffs : []
    state.handoffCount = Number(data.count) || 0
    state.handoffStats = data.stats || null
    state.handoffLoadError = false
    applyHandoffSnapshot(state.handoffs)
    paintHandoffBadge()
    // 待办页正开着就重画：这个数刚变过，而那一页整屏都是它。右栏那一屏只补它自己。
    repaintHandoffs()
  } catch {
    // Keep the last list and badge; expose that the refresh failed.
    state.handoffLoadError = true
    repaintHandoffs()
  }
}

/**
 * 拉一张单的正文（Bot 做到哪一步）。**只有展开那一条才拉**：这一跳会打到席位上。
 *
 * 拉不到就记 `null`，界面上说明白是「席位没应答」——写成「这张单没有内容」的话，
 * 接手的人会以为 Bot 什么都没做，然后从头再来一遍。
 */
async function loadHandoffDetail(id) {
  if (!id) return
  if ((state.handoffDetail || {})[id] !== undefined) {
    state.handoffDetail = { ...(state.handoffDetail || {}), [id]: undefined }
    repaintHandoffs()
  }
  try {
    const data = await api('GET', '/runtime/handoffs/' + encodeURIComponent(id))
    state.handoffDetail = { ...(state.handoffDetail || {}), [id]: data.detail ?? null }
  } catch {
    state.handoffDetail = { ...(state.handoffDetail || {}), [id]: null }
  }
  repaintHandoffs()
}

/**
 * 待办的轮询。
 *
 * 30 秒一次，而且**只在页面可见时**转：一个丢在后台的标签页每半分钟打一个请求，
 * 一天下来是两千多个，换来的是没有人在看的一个数。切回前台时立刻补一次，
 * 那一下才是人真正会看的时刻。
 */
let handoffTimer = null

/** 切回前台补的那一次。具名是为了停得掉：匿名的每起一次就多挂一个，退出登录也摘不下来。 */
function handoffOnVisible() {
  if (!document.hidden) void loadHandoffs()
}

function startHandoffPoll() {
  if (handoffTimer) return
  handoffTimer = setInterval(() => {
    if (document.hidden) return
    void loadHandoffs()
  }, 30_000)
  document.addEventListener('visibilitychange', handoffOnVisible)
}

/**
 * 退出登录 / 票过期时停（见 app.js 的 endSignedIn）。不停的话票清了它还在每半分钟敲一次；
 * 换成 owner 登进来，它敲的每一下都是 403。下一个人登进来之后由 loadPage 按角色重新起。
 */
function stopHandoffPoll() {
  clearInterval(handoffTimer)
  handoffTimer = null
  if (typeof document.removeEventListener === 'function') document.removeEventListener('visibilitychange', handoffOnVisible)
}
