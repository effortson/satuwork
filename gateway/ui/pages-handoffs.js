/**
 * 转人工待办：跨 Bot 的那一页（见 docs/handoff.md §6 第 2 层）。
 *
 * **它和会话里那张卡不是同一件事。** 卡片答的是「这一屏上这件事怎么办」，这一页答的是
 * 「我名下还欠着几件事」——而人多半正在别的 Bot 那一屏，甚至根本没打开过那颗 Bot
 * （半夜的日常任务开出来的单子就是这样）。
 *
 * 数据来自 Gateway 那张表（`/runtime/handoffs`），不是某一台席位：管理员要看的是
 * 全公司的，而那些单子分散在好几台机器上。正文（summary、交还时写的那段）只有席位
 * 有，点进对话去看。
 */

/** 一张单现在算哪一态，说给人听。列表上要一眼扫过，所以比卡片上那句还短。 */
function handoffStateTag(h) {
  const states = {
    open: ['tag-warn', t('待接手', 'Awaiting handler')],
    claimed: ['tag-accent-2', t('处理中', 'In progress')],
    returned: ['tag-neutral', t('已交还 Bot', 'Returned to bot')],
    expired: ['tag-neutral', t('已过期', 'Expired')],
    cancelled: ['tag-neutral', t('已撤销', 'Cancelled')],
    closed: ['mg-status-ok', t('已完成', 'Completed')],
  }
  const [cls, label] = states[h.state] || ['tag-neutral', t('已结束', 'Closed')]
  return `<span class="tag ${cls}">${esc(label)}</span>`
}

/**
 * 该谁处理。
 *
 * `assignee` 空着不是「没人管」，是**全体管理员**——模版上写的就是这一档（见
 * `escalateToOf`）。写成「未指派」的话，管理员会以为这条不归自己。
 */
function handoffWho(h) {
  if (h.claimedName) return h.claimedName
  if (h.assigneeName) return h.assigneeName
  return t('公司管理员', 'Company admins')
}

/**
 * 一段时长，说给人听。
 *
 * 不复用对话里那个读秒（`elapsedText`）：它给的是 `m:ss`，而这里的量级是小时和天
 * ——一张挂了两小时的单会显示成「120:00」，没有人读得出那是两小时。
 */
function handoffDuration(ms) {
  const min = Math.max(0, Math.round((Number(ms) || 0) / 60_000))
  if (min < 60) return t(`${min} 分钟`, `${min} min`)
  const h = Math.round(min / 6) / 10
  if (h < 48) return t(`${h} 小时`, `${h} h`)
  return t(`${Math.round(h / 24)} 天`, `${Math.round(h / 24)} d`)
}

/**
 * 顶上那三个数：最近 30 天开了几张、现在还欠着几张、多久有人接。
 *
 * **「多久有人接」用中位数**（服务端算的，见 db.handoffStats）：一张挂了两天没人接的
 * 单会把平均值拖到没法看，而这一格要答的是「一般多久有人应」。
 *
 * 没有数据就整条不画——三个 0 摆在那儿，看着像功能坏了。
 */
function handoffStatsStrip() {
  const st = state.handoffStats
  if (!st || !st.opened) return ''
  return managementStats([
    { label: t('近 30 天转交', 'Handoffs in 30 days'), value: st.opened, note: t('累计创建的交接单', 'Tickets created') },
    { label: t('近 30 天待处理', 'Awaiting response · 30 days'), value: st.waiting, note: t('待接手或正在处理', 'Awaiting a handler or in progress') },
    { label: t('近 30 天过期', 'Expired in 30 days'), value: st.expired, note: t('超时未处理的交接单', 'Tickets that timed out') },
    { label: t('接手耗时中位数', 'Median time to claim'), value: st.p50ClaimMs == null ? '—' : handoffDuration(st.p50ClaimMs), note: t('近 30 天已接手的交接单', 'Tickets claimed in 30 days') },
  ])
}

/**
 * 「等你拍板」——正停在席位上等人点的那几个确认（`tool/approval` 的 pending）。
 *
 * **它为什么不在下面那张表里。** 确认和交接单是两种东西（docs/handoff.md §2）：那一轮
 * 真的 `await` 在席位上、5 分钟不点就按拒绝收口、只存在内存里、席位一重启就没了。
 * 写进 Gateway 那张待办表，等于往一份「能挂几天的欠账」里塞一堆几分钟就自己消失的行，
 * 而消失的那些不会有任何人收到通知——那比不显示更糟。
 *
 * **但它为什么该出现在这一页。** 对人来说它就是「有活等着你」，和一张开着的单、一张
 * 卡住的卡是同一件事；顶栏那个数早就把后两样加在一起了（见 needCount），少了这一样，
 * 一个正被确认卡住的 Bot 在待办这一侧一点痕迹都没有。所以摆在最上面，说清楚它是当场
 * 的、会过期的，处理入口是回到那颗 Bot 的对话——那一轮就停在那儿等着。
 *
 * 数据源是名单那几条流（chat.js 的 pendingApprovals），不是 Gateway：这件事压根没上过
 * Gateway，浏览器这边是唯一答得上来的地方。**所以只看得见自己名下的 Bot**——管理员在
 * 这一段里看不到别人的确认，那是对的：别人的确认只有别人点得动。
 */
/** 等着拍板的那条是哪颗 Bot 的。名单里没有（刚删掉）就露 id，好过一片空白。 */
function handoffBotName(id) {
  const b = (state.runtimeBots || []).find((x) => x.id === id)
  return (b && (b.name || b.id)) || id
}

function handoffSourceName(h) {
  const bot = (state.runtimeBots || []).find(b => b.id === h.botId)
  return h.botName || (bot && bot.name) || t('成员 Bot', 'Member bot')
}

function approvalWaitPanel() {
  const list = typeof pendingApprovals === 'function' ? pendingApprovals() : []
  if (!list.length) return ''
  return `<section class="ho-section" aria-label="${t('操作确认', 'Action approvals')}">
    <div class="mg-sectionhead"><div><h2>${t('需要你确认', 'Needs your approval')} <span class="ho-count">${list.length}</span></h2>
      <p>${t('Bot 正在等待本次操作的授权，请回到对话查看详情。确认超时后，本次操作不会执行。', 'The bot is waiting for authorization. Review the action in its chat; it will not run if approval times out.')}</p></div></div>
    <div class="ho-approval-list">${list.map(a => `<div class="ho-approval-item">
      <div><strong>${esc(a.reason || t('请确认是否允许本次操作', 'Review this action'))}</strong>
      <span>${esc(handoffBotName(a.botId))}${a.name ? ' · ' + esc(a.name) : ''}${a.at ? ' · ' + esc(chatClock(a.at)) : ''}</span></div>
      <button type="button" class="btn btn-secondary" data-act="handoff-open" data-bot="${esc(a.botId)}">${t('查看并确认', 'Review action')}</button>
    </div>`).join('')}</div>
  </section>`
}

/**
 * 一张单右边那几颗按钮。整页那张表和右栏那一屏共用，按钮的规矩只写一遍。
 *
 * 「去处理」**只对自己的 Bot 给**。别人名下的 Bot 打不开：`/runtime/bots/:id` 按「这颗
 * Bot 是不是你的」判（visibleBotOf → botsFor），管理员点过去落在一句「没有这个 Bot」上
 * ——而管理员恰恰是这套东西里最该处理别人单子的人。所以那种就地展开处理（handoffPanel）。
 */
function handoffActs(h) {
  const mine = state.me && state.me.account ? state.me.account.id : ''
  const open = state.handoffOpenId === h.id
  const claim =
    h.state === 'open'
      ? `<button type="button" class="btn btn-ghost" data-act="handoff-claim" data-id="${esc(h.id)}">${t('接手处理', 'Claim task')}</button>`
      : ''
  const go =
    h.accountId === mine
      ? `<button type="button" class="btn btn-secondary" data-act="handoff-open" data-bot="${esc(h.botId)}">${t('查看对话', 'Open chat')}</button>`
      : `<button type="button" class="btn btn-secondary" data-act="handoff-detail" data-id="${esc(h.id)}" aria-expanded="${open}">${open ? t('收起详情', 'Hide details') : t('查看并处理', 'Review task')}</button>`
  // 「不用处理了」直接摆在单子上。原来只有展开那张卡里才有，而自己名下的 Bot 根本
  // 展不开（只给「去对话里处理」）——一张重复开出来的单，要撤掉得先跳进对话再找那张卡。
  // 只对还活着的单给（席位那边 LIVE 之外的一律 409「已经不在了」）；展开着的那张卡里
  // 已经有同一颗，不再叠一颗。
  const live = h.state === 'open' || h.state === 'claimed' || h.state === 'returned'
  const cancel =
    live && !open
      ? `<button type="button" class="btn btn-ghost ho-cancel" title="${esc(t('撤销后不再等待人工处理，也不会通知 Bot 继续', 'Closes the handoff without asking the bot to continue'))}" data-act="handoff-cancel" data-id="${esc(h.id)}">${t('撤销交接', 'Cancel handoff')}</button>`
      : ''
  return claim + go + cancel
}

/** 「全部 / 要我处理的」筛完之后的那几张。 */
function handoffRows() {
  const list = state.handoffs || []
  const me = state.me && state.me.account ? state.me.account.id : ''
  if (state.handoffScope !== 'mine') return list
  return list.filter((h) => h.assignee === me || h.claimedBy === me || (!h.assignee && (isAdmin() || h.accountId === me)))
}

function handoffRow(h) {
  const mine = state.me && state.me.account ? state.me.account.id : ''
  const open = state.handoffOpenId === h.id
  return `<div class="satu-handoffrow" data-handoff-row="${esc(h.id)}">
    <div class="ho-task"><strong title="${esc(h.ask || '')}">${esc(h.ask || t('请查看交接详情', 'Review handoff details'))}</strong>
      ${h.reason ? `<span title="${esc(h.reason)}">${esc(h.reason)}</span>` : ''}</div>
    <span>${handoffStateTag(h)}</span>
    <div class="ho-origin"><span>${esc(handoffSourceName(h))}</span><small>${esc(h.ownerName || h.accountId)}</small></div>
    <span class="ho-handler">${esc(handoffWho(h))}${h.claimedBy === mine ? ' · ' + t('我', 'me') : ''}</span>
    <time class="ho-time">${esc(fmtTime(h.createdAt))}</time>
    <div class="satu-rowactions">${handoffActs(h)}${!open ? handoffFeedbackHtml(h.id) : ''}</div>
  </div>${open ? handoffPanel(h) : ''}`
}

/**
 * 就地处理的那张卡（别人名下的 Bot，对话打不开）。
 *
 * 长得和会话里那张一样（同一套 `.sw-approval` / `.sw-handoff` 样式、同一个
 * `.sw-handoff-note`），所以接手 / 交还走的是同一条代码路（chat-decide.js 的 actOnHandoff /
 * returnHandoff），不另写一套。
 *
 * **正文要现拉**：Gateway 那张表只留了 reason / ask 各一段，而接手的人真正要看的是
 * 「Bot 已经做到哪一步」。拉不到就说明白是席位没应答，不要画成「这张单没有内容」。
 */
function handoffFeedbackHtml(id) {
  const feedback = (state.handoffFeedback || {})[id]
  return `<div class="ho-feedback" data-handoff-feedback="${esc(id)}" role="${feedback && feedback.error ? 'alert' : 'status'}"${feedback && feedback.error ? ' data-error="1"' : ''}${feedback ? '' : ' hidden'}>${feedback ? esc(feedback.text) : ''}</div>`
}

function handoffContext(h) {
  return `<div class="ho-context"><span class="ho-label">${t('Bot 的处理进展', 'Bot’s progress')}</span>${h.summary
    ? `<pre class="sw-approval-args">${esc(h.summary)}</pre>`
    : `<p>${t('Bot 暂未提供处理进展，请结合任务与转交原因判断。', 'No progress notes were provided. Review the task and handoff reason.')}</p>`}</div>`
}

/** Both chat and inbox use the same labelled field and disposition controls. */
function handoffForm(h) {
  if (h.state === 'returned') return `<div class="sw-handoff-note-done">${h.result && h.result.text ? `<span class="ho-label">${t('已提交的处理说明', 'Submitted response')}</span><p>${esc(h.result.text)}</p>` : ''}${t('处理说明已交还，等待 Bot 后续反馈。', 'Your response has been returned. Awaiting the bot’s follow-up.')}</div>
    ${(state.handoffFeedback || {})[h.id]?.error ? handoffFeedbackHtml(h.id) : ''}
    <div class="sw-approval-acts"><button type="button" class="btn btn-ghost ho-cancel" title="${t('撤销后不会通知 Bot 继续', 'Cancel without asking the bot to continue')}" data-act="chat-handoff-cancel" data-id="${esc(h.id)}">${t('撤销交接', 'Cancel handoff')}</button></div>`
  if (h.state !== 'open' && h.state !== 'claimed') return handoffFeedbackHtml(h.id)
  return `<div class="ho-response">
    <label class="ho-label">${t('处理结果 / 后续指示', 'Outcome / next steps')}
      <textarea class="input sw-handoff-note" data-handoff="${esc(h.id)}" rows="3" aria-required="true"
        placeholder="${esc(t('例如：已核对金额并完成付款，凭证号 PAY-1027。请继续整理报销记录。', 'Example: Payment confirmed, receipt PAY-1027. Continue preparing the expense record.'))}"></textarea>
    </label>
    <p class="ho-help">${t('说明你已完成的操作，或希望 Bot 下一步怎么做。交还后，Bot 会收到这段说明。', 'Describe what you completed or what the bot should do next. Returning the task sends this note to the bot.')}</p>
    ${handoffFeedbackHtml(h.id)}
    <div class="sw-approval-acts">
      <button type="button" class="btn btn-primary" data-act="chat-handoff-return" data-id="${esc(h.id)}" data-disp="done">${t('已处理，交还 Bot', 'Done · return to bot')}</button>
      <button type="button" class="btn btn-secondary" data-act="chat-handoff-return" data-id="${esc(h.id)}" data-disp="instructions">${t('按新指示继续', 'Continue with instructions')}</button>
      ${h.state === 'open' ? `<button type="button" class="btn btn-ghost" data-act="chat-handoff-claim" data-id="${esc(h.id)}">${t('接手处理', 'Claim task')}</button>` : ''}
      <button type="button" class="btn btn-ghost ho-cancel" title="${t('撤销后不会通知 Bot 继续', 'Cancel without asking the bot to continue')}" data-act="chat-handoff-cancel" data-id="${esc(h.id)}">${t('撤销交接', 'Cancel handoff')}</button>
    </div>
    <p class="ho-help ho-action-help">${t('“已处理”表示人工已完成任务；“按新指示继续”让 Bot 按你的说明执行。撤销交接不会通知 Bot 继续。', '“Done” records work you completed; “Continue with instructions” asks the bot to follow your note. Cancelling does not ask the bot to continue.')}</p>
  </div>`
}

function handoffPanel(h, { inCard = false } = {}) {
  const d = (state.handoffDetail || {})[h.id]
  const body = d === undefined
    ? `<div class="ho-detail-status" role="status">${t('正在加载 Bot 的处理进展…', 'Loading the bot’s progress…')}</div>`
    : d === null
      ? `<div class="ho-detail-status" role="status">${t('暂时无法获取 Bot 的处理进展，请重新加载。接手或交还任务需要 Bot 所在设备在线。', 'Could not load the bot’s progress. Retry to load it; claiming or returning a task requires the bot’s device to be online.')}
          <button type="button" class="btn btn-ghost" data-act="handoff-detail-retry" data-id="${esc(h.id)}">${t('重新加载', 'Retry')}</button></div>`
      : handoffContext(d)
  return `<div class="satu-handoffpanel"><div class="sw-approval sw-handoff" data-state="${esc(h.state)}" data-handoff="${esc(h.id)}">
    <div class="sw-approval-head">${svg(ICON_HANDOFF, 18)}<span>${t('交接详情', 'Handoff details')}</span>${handoffStateTag(h)}</div>
    ${inCard && !(d && d.ask && d.ask !== h.ask) ? '' : `<div class="sw-handoff-ask">${esc((d && d.ask) || h.ask || t('请查看交接详情', 'Review handoff details'))}</div>`}
    ${(!inCard || (d && d.reason && d.reason !== h.reason)) && ((d && d.reason) || h.reason) ? `<div class="sw-approval-why"><span class="ho-label">${t('转交原因', 'Reason')}</span>${esc((d && d.reason) || h.reason)}</div>` : ''}
    ${body}${handoffForm({ ...h, result: (d && d.result) || h.result })}
  </div></div>`
}

function handoffScopeTabs() {
  const mine = state.handoffScope === 'mine'
  return `<div class="mg-tabs satu-hoaside-scope" aria-label="${t('待办范围', 'Handoff scope')}">
    <button type="button" class="btn mg-tab" aria-pressed="${!mine}" data-act="handoff-scope" data-scope="all">${t('全部待办', 'All handoffs')}</button>
    <button type="button" class="btn mg-tab" aria-pressed="${mine}" data-act="handoff-scope" data-scope="mine">${t('待我处理', 'For me')}</button>
  </div>`
}

function handoffEmpty() {
  return `<div class="ho-empty">${svg(ICON_HANDOFF, 18)}<strong>${state.handoffScope === 'mine' ? t('暂无需要你处理的交接任务', 'No handoffs for you') : t('当前没有待处理的交接任务', 'No handoffs to handle')}</strong>
    <p>${t('Bot 需要人工协助时，任务会显示在这里。', 'Tasks appear here when a bot needs human help.')}</p></div>`
}

function handoffLoadNotice() {
  return state.handoffLoadError ? `<div class="ho-detail-status" role="alert">${t('待办更新失败，当前显示上次获取的内容。请刷新重试。', 'Could not update handoffs. Showing the last available list; refresh to retry.')}<button type="button" class="btn btn-ghost" data-act="handoff-refresh">${t('重试', 'Retry')}</button></div>` : ''
}

function handoffsPage() {
  const rows = handoffRows()
  return `<div class="gw-page ho-page"><div class="gw-page-inner">
    ${pageHead(t('转人工待办', 'Handoffs'), t('集中处理 Bot 转交的任务。查看进展、补充处理说明，再交还 Bot 继续。', 'Review tasks handed over by bots, add an outcome or instructions, and return them to continue.'), `<button type="button" class="btn btn-secondary" data-act="handoff-refresh">${t('刷新待办', 'Refresh')}</button>`)}
    ${handoffStatsStrip()}${flashes()}${handoffLoadNotice()}
    ${approvalWaitPanel()}
    <section class="ho-section"><div class="mg-sectionhead"><div><h2>${t('人工交接', 'Human handoffs')} <span class="ho-count">${rows.length}</span></h2><p>${t('接手后可稍后交还；处理说明会作为 Bot 继续工作的依据。', 'Claim a task and return it when ready. Your response provides the context for the bot to continue.')}</p></div>${handoffScopeTabs()}</div>
      ${rows.length ? `<div class="mg-table ho-table"><div class="satu-handoffhead">
        <span>${t('待处理任务', 'Task')}</span><span>${t('状态', 'Status')}</span><span>${t('来源 Bot / 成员', 'Bot / member')}</span><span>${t('处理人', 'Handler')}</span><span>${t('创建时间', 'Created')}</span><span></span>
      </div>${rows.map(handoffRow).join('')}</div>` : handoffEmpty()}
    </section>
  </div></div>`
}

/**
 * 右栏里的转人工待办（对话页）。
 *
 * **和 /handoffs 那一页是同一份数据、同一套按钮，只是排成一列卡片。** 右栏只有两三百
 * 像素宽，那张六列的表摆不下；而人在这里要的也不是全表，是「眼下有几件、哪件该我动手」。
 *
 * 为什么要有这一屏：顶栏那颗按钮原来一点就整页换成 /handoffs，人正在跟 Bot 说的话、
 * 往上翻到的位置全没了，看完还得点回来。转人工本来就是「Bot 做到一半交给人」，人多半
 * 正坐在对话里——待办该在旁边摆着，而不是把对话挤走。
 */
function handoffsAside() {
  const rows = handoffRows()
  const st = state.handoffStats
  const asks = typeof pendingApprovals === 'function' ? pendingApprovals() : []
  const mine = state.me && state.me.account ? state.me.account.id : ''
  return `<div class="ho-aside-head"><h3>${t('转人工待办', 'Handoffs')}</h3><button type="button" class="btn btn-ghost" data-act="handoff-refresh">${t('刷新', 'Refresh')}</button></div>
    <p class="satu-hoaside-stats">${st ? esc(t(`近 30 天转交 ${st.opened} 项 · 其中 ${st.waiting} 项待处理`, `${st.opened} created in 30 days · ${st.waiting} awaiting a response`)) : t('查看需要人工协助的任务，并交还处理结果。', 'Review tasks that need human help and return your response.')}</p>
    ${handoffScopeTabs()}${handoffLoadNotice()}
    ${asks.map(a => `<div class="satu-hocard" data-kind="ask">
      <div class="satu-hocard-top"><span class="tag tag-warn">${t('需要你确认', 'Needs approval')}</span><time>${esc(a.at ? chatClock(a.at) : '')}</time></div>
      <div class="satu-hocard-ask">${esc(a.reason || t('请确认是否允许本次操作', 'Review this action'))}</div>
      <div class="satu-hocard-meta">${esc(handoffBotName(a.botId))}${a.name ? ' · ' + esc(a.name) : ''}</div>
      <p class="ho-help">${t('确认超时后，本次操作不会执行。', 'The action will not run if approval times out.')}</p>
      <div class="satu-hocard-acts"><button type="button" class="btn btn-secondary" data-act="handoff-open" data-bot="${esc(a.botId)}">${t('查看并确认', 'Review action')}</button></div>
    </div>`).join('')}
    ${rows.map(h => `<div class="satu-hocard" data-state="${esc(h.state)}" data-handoff-row="${esc(h.id)}">
      <div class="satu-hocard-top">${handoffStateTag(h)}<time>${esc(fmtTime(h.createdAt))}</time></div>
      <div class="satu-hocard-ask">${esc(h.ask || t('请查看交接详情', 'Review handoff details'))}</div>
      ${h.reason ? `<div class="satu-hocard-why"><span class="ho-label">${t('转交原因', 'Reason')}</span>${esc(h.reason)}</div>` : ''}
      <div class="satu-hocard-meta">${esc(handoffSourceName(h))} · ${esc(h.ownerName || h.accountId)}</div>
      <div class="satu-hocard-meta">${t('处理人', 'Handler')} · ${esc(handoffWho(h))}${h.claimedBy === mine ? ' · ' + t('我', 'me') : ''}</div>
      <div class="satu-hocard-acts">${handoffActs(h)}</div>
      ${state.handoffOpenId === h.id ? handoffPanel(h, { inCard: true }) : handoffFeedbackHtml(h.id)}
    </div>`).join('')}
    ${!rows.length && !asks.length ? handoffEmpty() : ''}`
}

/**
 * 只重画右栏那一屏，不走 render()。
 *
 * 待办每 30 秒拉一次、确认那一路随时会动，照着它们整页重绘的话，输入框的焦点、对话
 * 滚到的位置、那张卡里正写着的结论，每半分钟被冲一次。所以只换这一块，而且画出来的
 * 东西没变就连这一块也不换；换之前把正在写的结论存起来，换完填回去、焦点还给它。
 */
let asideHandoffsHtml = ''

function paintAsideHandoffs() {
  const host = typeof document !== 'undefined' ? document.getElementById('aside-handoffs') : null
  if (!host) return
  const html = handoffsAside()
  if (html === asideHandoffsHtml && host.childElementCount) return
  const focused = document.activeElement
  const focusId = focused && focused.classList && focused.classList.contains('sw-handoff-note') ? focused.getAttribute('data-handoff') : ''
  const caret = focusId ? [focused.selectionStart, focused.selectionEnd] : null
  stashHandoffNotes(host)
  asideHandoffsHtml = html
  host.innerHTML = html
  fillHandoffNotes(host)
  if (focusId) {
    const ta = [...host.querySelectorAll('.sw-handoff-note')].find((x) => x.getAttribute('data-handoff') === focusId)
    if (ta) {
      ta.focus()
      if (caret) ta.setSelectionRange(caret[0], caret[1])
    }
  }
}

/** 待办那份数据变了之后该重画哪儿：整页开着就重画整页，否则只补右栏那一屏。 */
function repaintHandoffs() {
  if (state.path === '/handoffs') render()
  else paintAsideHandoffs()
}

let askShot = ''

/**
 * 「等你拍板」那一段变了才重画整页。
 *
 * 名单每一帧都在画（paintRoster），照着帧重画整页的话，这一页上「展开处理」那张卡里
 * 正在写的结论每秒被清空一次。集合本身（哪几条 callId）变了才值得重画——那时候人手上
 * 那张卡本来也已经不是原来那张了。
 */
function repaintAskPanel() {
  const shot = (typeof pendingApprovals === 'function' ? pendingApprovals() : []).map((a) => a.botId + ':' + a.callId).join(',')
  if (shot === askShot) return
  askShot = shot
  repaintHandoffs()
}

/**
 * 顶栏那个数：**要人做的事一共几件**。
 *
 * **两样加在一起**：开着的交接单、正等着人拍板的确认。对人是同一件事——「有活等着你」。
 * 分成两个数字、两页清单的话，人要学会看两个地方，而他只会记住一个。
 *
 * 只算真的在等人做决定的项目，避免把普通状态信息混进来，让徽章从「有活等着你」变成
 * 「有事发生过」。
 *
 * **首绘和重绘共用它**：原来 handoffBell 只数交接单、paintHandoffBadge 数两样，
 * 于是页面刚画出来那一下和第一次重绘之后是两个不同的数字。
 */
function needCount() {
  const asks = typeof pendingApprovals === 'function' ? pendingApprovals().length : 0
  return (Number(state.handoffCount) || 0) + asks
}

/**
 * 就地改，不走 render()：整页重绘会把正在打字的输入框换掉，而这个数每 30 秒就要动
 * 一次（见 chat-decide.js 的 loadHandoffs），确认那一路更是随时会动（paintRoster 每帧来一次）。
 */
function paintHandoffBadge() {
  const node = document.querySelector('.satu-handoffcount')
  if (!node) return
  const n = needCount()
  const text = n > 99 ? '99+' : String(n)
  if (node.textContent !== text) node.textContent = text
  if (node.hidden !== !n) node.hidden = !n
}

const ICON_HANDOFF = [
  'M18 11V6a1.5 1.5 0 0 0-3 0',
  'M15 10V4a1.5 1.5 0 0 0-3 0v6',
  'M12 10V5a1.5 1.5 0 0 0-3 0v7',
  'M9 12V8a1.5 1.5 0 0 0-3 0v6a7 7 0 0 0 7 7h1a7 7 0 0 0 7-7v-3',
]

/** 转人工待办只对公司里的人有：owner 没有席位、也没有 Bot，那一侧永远是 0。 */
function canSeeHandoffs() {
  return Boolean(state.me && !isOwner() && state.me.account && state.me.account.companyId)
}

/**
 * 顶栏那颗按钮（对话页以外）。
 *
 * **只对公司里的人出现**：owner 没有席位、也没有 Bot，那一侧永远是 0。
 * 数字为 0 时按钮照样在——待办入口消失的话，人只能靠记性想起来去哪儿找它。
 */
function handoffBell() {
  // 对话页上它是右栏的一屏（见 render.js 的 asideToggle），这里不再画一颗跳整页的。
  if (!canSeeHandoffs() || hasAside()) return ''
  const n = needCount()
  const label = t('转人工待办', 'Handoffs')
  return `<button type="button" class="btn btn-ghost btn-icon satu-handoffbell" style="margin-left: auto; flex: none; position: relative;"
    data-act="go" data-href="/handoffs" aria-label="${esc(label)}" title="${esc(label)}">
    ${svg(ICON_HANDOFF, 17)}
    <span class="satu-handoffcount" ${n ? '' : 'hidden'}>${n > 99 ? '99+' : n}</span>
  </button>`
}
