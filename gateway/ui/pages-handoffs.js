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
  if (h.state === 'open') return `<span class="tag tag-accent">${t('等人接手', 'Waiting')}</span>`
  if (h.state === 'claimed') return `<span class="tag tag-accent-2">${t('处理中', 'In progress')}</span>`
  if (h.state === 'returned') return `<span class="tag tag-neutral">${t('已交还', 'Handed back')}</span>`
  if (h.state === 'expired') return `<span class="tag tag-neutral">${t('没人接', 'Nobody took it')}</span>`
  return `<span class="tag tag-neutral">${t('已结束', 'Closed')}</span>`
}

/**
 * 该谁处理。
 *
 * `assignee` 空着不是「没人管」，是**全体管理员**——模版上写的就是这一档（见
 * `escalateToOf`）。写成「未指派」的话，管理员会以为这条不归自己。
 */
function handoffWho(h) {
  if (h.claimedName) return t('由 ', 'by ') + h.claimedName
  if (h.assigneeName) return t('等 ', 'waiting on ') + h.assigneeName
  return t('等管理员', 'waiting on an admin')
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
  const p50 = st.p50ClaimMs == null ? t('还没有人接过', 'nobody has taken one yet') : handoffDuration(st.p50ClaimMs)
  return `<div style="display: flex; gap: var(--space-6); flex-wrap: wrap; padding: var(--space-3) var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
    <div><div style="font-size: 12px; color: var(--muted-foreground);">${t('近 30 天开出', 'Opened, 30d')}</div><div style="font-size: 20px; font-weight: 600;">${st.opened}</div></div>
    <div><div style="font-size: 12px; color: var(--muted-foreground);">${t('还欠着', 'Still waiting')}</div><div style="font-size: 20px; font-weight: 600;">${st.waiting}</div></div>
    <div><div style="font-size: 12px; color: var(--muted-foreground);">${t('没人接手', 'Nobody took')}</div><div style="font-size: 20px; font-weight: 600;">${st.expired}</div></div>
    <div><div style="font-size: 12px; color: var(--muted-foreground);">${t('多久有人接（中位）', 'Median time to take')}</div><div style="font-size: 20px; font-weight: 600;">${esc(p50)}</div></div>
  </div>`
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

function approvalWaitPanel() {
  const list = typeof pendingApprovals === 'function' ? pendingApprovals() : []
  if (!list.length) return ''
  const rows = list
    .map(
      (a) => `<div class="satu-handoffrow">
        <div style="min-width: 0;">
          <div style="font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(
            a.reason || t('要你拍板才能往下走', 'Needs your approval to continue'),
          )}</div>
          <div style="font-size: 12px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(a.name || '')}</div>
        </div>
        <span><span class="tag tag-warn">${t('等你拍板', 'Approve')}</span></span>
        <span style="font-size: 12.5px; color: var(--muted-foreground);">${esc(handoffBotName(a.botId))}</span>
        <span style="font-size: 12.5px; color: var(--muted-foreground);">${t('只有你点得动', 'only you can')}</span>
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(a.at ? chatClock(a.at) : '')}</span>
        <div class="satu-rowactions" style="display: flex; gap: var(--space-2); justify-content: flex-end;">
          <button type="button" class="btn btn-primary" data-act="handoff-open" data-bot="${esc(a.botId)}">${t('去拍板', 'Go approve')}</button>
        </div>
      </div>`,
    )
    .join('')
  return `<div>
    <p style="margin: 0 0 var(--space-2); font-size: 13px; color: var(--muted-foreground);">${t(
      '下面这几个是当场的：那一轮正停在席位上等你点，几分钟不点就按「不执行」收口，不会在这儿挂着。',
      'These are live: the turn is paused on the seat waiting for you, and times out as "declined" in a few minutes.',
    )}</p>
    <div style="border: 1px solid var(--color-warn-500); border-radius: var(--radius-lg); background: var(--popover);">
      <div class="satu-handoffhead">
        <span>${t('要你拍板什么', 'What to approve')}</span>
        <span>${t('状态', 'State')}</span>
        <span>${t('哪颗 Bot', 'Which bot')}</span>
        <span>${t('谁在处理', 'Who')}</span>
        <span>${t('弹出来', 'Asked')}</span>
        <span></span>
      </div>
      ${rows}
    </div>
  </div>`
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
      ? `<button type="button" class="btn btn-ghost" data-act="handoff-claim" data-id="${esc(h.id)}">${t('我来接手', 'Take it')}</button>`
      : ''
  const go =
    h.accountId === mine
      ? `<button type="button" class="btn btn-secondary" data-act="handoff-open" data-bot="${esc(h.botId)}">${t('去对话里处理', 'Open the chat')}</button>`
      : `<button type="button" class="btn btn-secondary" data-act="handoff-detail" data-id="${esc(h.id)}" aria-expanded="${open}">${open ? t('收起', 'Close') : t('展开处理', 'Handle here')}</button>`
  // 「不用处理了」直接摆在单子上。原来只有展开那张卡里才有，而自己名下的 Bot 根本
  // 展不开（只给「去对话里处理」）——一张重复开出来的单，要撤掉得先跳进对话再找那张卡。
  // 只对还活着的单给（席位那边 LIVE 之外的一律 409「已经不在了」）；展开着的那张卡里
  // 已经有同一颗，不再叠一颗。
  const live = h.state === 'open' || h.state === 'claimed' || h.state === 'returned'
  const cancel =
    live && !open
      ? `<button type="button" class="btn btn-ghost" data-act="handoff-cancel" data-id="${esc(h.id)}">${t('不用处理了', 'Never mind')}</button>`
      : ''
  return claim + go + cancel
}

/** 「全部 / 要我处理的」筛完之后的那几张。 */
function handoffRows() {
  const list = state.handoffs || []
  const me = state.me && state.me.account ? state.me.account.id : ''
  if (state.handoffScope !== 'mine') return list
  return list.filter((h) => h.assignee === me || h.claimedBy === me || (!h.assignee && isAdmin()))
}

function handoffRow(h) {
  const mine = state.me && state.me.account ? state.me.account.id : ''
  const open = state.handoffOpenId === h.id
  return `
    <div class="satu-handoffrow">
      <div style="min-width: 0;">
        <div style="font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(h.ask || t('（没写要做什么）', '(no ask)'))}</div>
        <div style="font-size: 12px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(h.reason || '')}</div>
      </div>
      <span>${handoffStateTag(h)}</span>
      <span style="font-size: 12.5px; color: var(--muted-foreground);">${esc(h.ownerName || h.accountId)}</span>
      <span style="font-size: 12.5px; color: var(--muted-foreground);">${esc(handoffWho(h))}${h.claimedBy && h.claimedBy === mine ? ' · ' + esc(t('我', 'me')) : ''}</span>
      <span style="font-size: 12px; color: var(--muted-foreground);">${esc(fmtTime(h.createdAt))}</span>
      <div class="satu-rowactions" style="display: flex; gap: var(--space-2); justify-content: flex-end;">${handoffActs(h)}</div>
    </div>${open ? handoffPanel(h) : ''}`
}

/**
 * 就地处理的那张卡（别人名下的 Bot，对话打不开）。
 *
 * 长得和会话里那张一样（同一套 `.sw-approval` / `.sw-handoff` 样式、同一个
 * `.sw-handoff-note`），所以接手 / 交还走的是同一条代码路（chat.js 的 actOnHandoff /
 * returnHandoff），不另写一套。
 *
 * **正文要现拉**：Gateway 那张表只留了 reason / ask 各一段，而接手的人真正要看的是
 * 「Bot 已经做到哪一步」。拉不到就说明白是席位没应答，不要画成「这张单没有内容」。
 */
function handoffPanel(h, { inCard = false } = {}) {
  const d = (state.handoffDetail || {})[h.id]
  const body =
    d === undefined
      ? `<div class="sw-handoff-who">${esc(t('正在取 Bot 做到哪一步…', 'Fetching what the bot got done…'))}</div>`
      : d === null
        ? `<div class="sw-handoff-who">${esc(t('席位没应答，看不到 Bot 那边的进度；下面照样可以接手和交还。', 'The seat did not answer, so its notes are unavailable — you can still take it and hand it back.'))}</div>`
        : d.summary
          ? `<pre class="sw-approval-args">${esc(d.summary)}</pre>`
          : `<div class="sw-handoff-who">${esc(t('Bot 没写它做到哪一步。', 'The bot did not say how far it got.'))}</div>`
  return `<div class="satu-handoffpanel">
    <div class="sw-approval sw-handoff" data-state="${esc(h.state)}" data-handoff="${esc(h.id)}">
      ${/* 右栏那张卡上面已经写着这两句了，展开的这一块不再重复一遍。 */ ''}
      ${inCard ? '' : `<div class="sw-handoff-ask">${esc(h.ask || t('接手处理这件事', 'Take this over'))}</div>`}
      ${!inCard && h.reason ? `<div class="sw-approval-why">${esc(h.reason)}</div>` : ''}
      ${body}
      <textarea class="input sw-handoff-note" data-handoff="${esc(h.id)}" rows="2"
        placeholder="${esc(t('你做了什么、结论是什么？Bot 要靠它接着做', 'What did you do, and what came of it? The bot continues from this'))}"></textarea>
      <div class="sw-approval-acts">
        <button type="button" class="btn btn-primary" data-act="chat-handoff-return" data-id="${esc(h.id)}" data-disp="done">${t('处理完了，交还', 'Done — hand back')}</button>
        <button type="button" class="btn btn-ghost" data-act="chat-handoff-return" data-id="${esc(h.id)}" data-disp="instructions">${t('换个做法', 'Do it differently')}</button>
        <button type="button" class="btn btn-ghost" data-act="chat-handoff-cancel" data-id="${esc(h.id)}">${t('不用处理了', 'Never mind')}</button>
      </div>
    </div>
  </div>`
}

function handoffsPage() {
  const mineOnly = state.handoffScope === 'mine'
  const rows = handoffRows()
  const body = rows.length
    ? `<div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
        <div class="satu-handoffhead">
          <span>${t('要人做什么', 'What is asked')}</span>
          <span>${t('状态', 'State')}</span>
          <span>${t('谁的 Bot', 'Whose bot')}</span>
          <span>${t('谁在处理', 'Who')}</span>
          <span>${t('开出来', 'Opened')}</span>
          <span></span>
        </div>
        ${rows.map(handoffRow).join('')}
      </div>`
    : `<p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t(
        '没有等着人处理的事。Bot 卡住、或者撞上公司规定要人拍板的事情时，会在这里开一张单。',
        'Nothing waiting. When a bot gets stuck or hits a rule that needs a person, it opens a ticket here.',
      )}</p>`
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('转人工待办', 'Handoffs')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t(
            'Bot 交出来等人处理的事。处理完在对话里交还，它会接着往下做。',
            'Things the bots handed over. Hand it back in the chat and the bot picks up from there.',
          )}</p>
        </div>
        ${handoffStatsStrip()}
        <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
          <button type="button" class="btn ${mineOnly ? 'btn-ghost' : 'btn-secondary'}" data-act="handoff-scope" data-scope="all">${t('全部', 'All')}</button>
          <button type="button" class="btn ${mineOnly ? 'btn-secondary' : 'btn-ghost'}" data-act="handoff-scope" data-scope="mine">${t('要我处理的', 'Mine')}</button>
        </div>
        ${flashes()}
        ${approvalWaitPanel()}
        ${body}
      </div>
    </div>`
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
  const mineOnly = state.handoffScope === 'mine'
  const rows = handoffRows()
  const st = state.handoffStats
  const stats =
    st && st.opened
      ? `<p class="satu-hoaside-stats">${esc(
          t(`近 30 天开出 ${st.opened} 张 · 还欠 ${st.waiting} · 没人接 ${st.expired}`, `${st.opened} opened in 30d · ${st.waiting} waiting · ${st.expired} untaken`),
        )}${
          st.p50ClaimMs == null
            ? ''
            : esc(t(` · 一般 ${handoffDuration(st.p50ClaimMs)}有人接`, ` · taken in ${handoffDuration(st.p50ClaimMs)} (median)`))
        }</p>`
      : ''
  const asks = typeof pendingApprovals === 'function' ? pendingApprovals() : []
  const askCards = asks
    .map(
      (a) => `<div class="satu-hocard" data-kind="ask">
        <div class="satu-hocard-top"><span class="tag tag-warn">${t('等你拍板', 'Approve')}</span><span>${esc(a.at ? chatClock(a.at) : '')}</span></div>
        <div class="satu-hocard-ask">${esc(a.reason || t('要你拍板才能往下走', 'Needs your approval to continue'))}</div>
        <div class="satu-hocard-meta">${esc(handoffBotName(a.botId))}${a.name ? ' · ' + esc(a.name) : ''}</div>
        <div class="satu-hocard-acts"><button type="button" class="btn btn-primary" data-act="handoff-open" data-bot="${esc(a.botId)}">${t('去拍板', 'Go approve')}</button></div>
      </div>`,
    )
    .join('')
  const mine = state.me && state.me.account ? state.me.account.id : ''
  const cards = rows
    .map(
      (h) => `<div class="satu-hocard">
        <div class="satu-hocard-top">${handoffStateTag(h)}<span>${esc(fmtTime(h.createdAt))}</span></div>
        <div class="satu-hocard-ask">${esc(h.ask || t('（没写要做什么）', '(no ask)'))}</div>
        ${h.reason ? `<div class="satu-hocard-why">${esc(h.reason)}</div>` : ''}
        <div class="satu-hocard-meta">${esc(h.ownerName || h.accountId)} · ${esc(handoffWho(h))}${h.claimedBy && h.claimedBy === mine ? ' · ' + esc(t('我', 'me')) : ''}</div>
        <div class="satu-hocard-acts">${handoffActs(h)}</div>
        ${state.handoffOpenId === h.id ? handoffPanel(h, { inCard: true }) : ''}
      </div>`,
    )
    .join('')
  const empty =
    !rows.length && !asks.length
      ? `<p class="satu-hoaside-empty">${t(
          '没有等着人处理的事。Bot 卡住、或者撞上公司规定要人拍板的事情时，会在这里开一张单。',
          'Nothing waiting. When a bot gets stuck or hits a rule that needs a person, it opens a ticket here.',
        )}</p>`
      : ''
  return `<h3>${t('转人工待办', 'Handoffs')}</h3>
    ${stats}
    <div class="satu-hoaside-scope">
      <button type="button" class="btn ${mineOnly ? 'btn-ghost' : 'btn-secondary'}" data-act="handoff-scope" data-scope="all">${t('全部', 'All')}</button>
      <button type="button" class="btn ${mineOnly ? 'btn-secondary' : 'btn-ghost'}" data-act="handoff-scope" data-scope="mine">${t('要我处理的', 'Mine')}</button>
    </div>
    ${askCards}${cards}${empty}`
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
 * 一次（见 chat.js 的 loadHandoffs），确认那一路更是随时会动（paintRoster 每帧来一次）。
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
