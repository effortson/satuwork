/** 输入框这一块：排队 dock、待办、点名药丸、引用、附件与上传、发送与停止，`@` 选单和斜杠命令。原先在 chat.js 里，拆出来只是搬家（顺序见 index.html）。 */
/**
 * 排队 dock：输入框顶上那一行小字。
 *
 * **一条一行，纯文字，不展开附件**——图片不出缩略图，`@` 出来的药丸也不画。它是
 * 「等会儿要说的话」的一个提醒，不是消息气泡的预演；把气泡那一套搬上去，输入框会被
 * 顶掉半屏。多条就多行，最多画 3 行，再多第一行变成「还有 N 条」。
 */
function paintChatQueue() {
  const box = document.getElementById('chat-queue')
  if (!box) return
  const rows = chatQueues.get(state.chatSessionId) || []
  box.hidden = !rows.length
  if (!rows.length) {
    box.innerHTML = ''
    return
  }
  const shown = rows.slice(-3)
  const hidden = rows.length - shown.length
  box.innerHTML =
    (hidden ? `<div class="sw-queue-more">${esc(t(`还有 ${hidden} 条`))}</div>` : '') +
    shown
      .map((r) => {
        /**
         * 主 Bot 派来、排在这儿的活（docs/bot-tasks.md §7）。**这里不给取消**：等它结论的是主 Bot
         * 那一轮，这边悄悄撤掉的话那边要干等到超时。要停去主 Bot 那边按停止，排着的这条会跟着撤掉。
         */
        const src = r.source || {}
        const task = src.kind === 'plugin' && src.plugin === 'task' && src.phase !== 'result'
        const body = task ? String(r.text || '').replace(TASK_IN_HEAD, '').replace(TASK_IN_TAIL, '') : r.text || ''
        const line = body.replace(/\s+/g, ' ').trim() || t('（只有附件）')
        const who = task ? t(`${(src.from && src.from.name) || '主 Bot'} 派来的任务：`, `Assigned by ${(src.from && src.from.name) || 'the main bot'}: `) : ''
        return `<div class="sw-queue-row">
          <span class="sw-queue-dot" aria-hidden="true"></span>
          <span class="sw-queue-text">${esc(who + line)}</span>
          ${task ? '' : `<button type="button" class="sw-file-x" data-act="chat-queue-cancel" data-id="${esc(r.id)}"
            aria-label="${esc(t('取消'))}">${ICON_X}</button>`}
        </div>`
      })
      .join('')
}

/**
 * 待办 dock 的四种状态标记。
 *
 * 画成图形而不是 ☐☑ 这类字符：那几个字符在不同系统上的字号、基线、甚至有没有字体
 * 都不一样（Windows 上常常退化成一个方框），而这一行的四个标记必须对得整整齐齐。
 */
const TODO_MARK = {
  pending:
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="12" cy="12" r="8"/></svg>',
  in_progress:
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.4" fill="currentColor" stroke="none"/></svg>',
  completed:
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="m8.6 12.2 2.3 2.3 4.5-4.7"/></svg>',
  cancelled:
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M9.2 9.2 14.8 14.8"/><path d="M14.8 9.2 9.2 14.8"/></svg>',
}

/**
 * 状态 → 标记。**走 hasOwn，不直接下标**：`TODO_MARK['__proto__']` 拿到的是
 * Object.prototype，而它是 truthy，`|| TODO_MARK.pending` 那道兜底接不住——拼进
 * innerHTML 就是一句 `[object Object]`。席位那边已经校验过状态，这一道是白捡的。
 */
const todoMark = (status) => (Object.hasOwn(TODO_MARK, status) ? TODO_MARK[status] : TODO_MARK.pending)

/** dock 抬头那个清单图标。 */
const ICON_LIST =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 6 2 2 3-3"/><path d="m3 15 2 2 3-3"/><path d="M12 7h9"/><path d="M12 16h9"/></svg>'

/** 折叠箭头。朝上；展开时由 CSS 转 180°——同一个箭头指的是同一件事的两个方向。 */
const ICON_CHEV =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>'

/**
 * dock 展开着还是折着，按会话记。**默认折着**：展开的清单会把输入框顶掉半屏，而人
 * 多半只想知道「还剩几条」。
 *
 * 只活在这一次页面加载里，不落 prefs：它是「我现在想不想看细节」，不是一项设置。
 */
const chatTodoOpen = new Map()

/**
 * 人手关掉的那张表，记的是**关掉时它长什么样**（sessionId → 指纹）。
 *
 * 不记「关掉了」这个布尔：那样一关就是永久的，而清单还在往前走——下一条做完了、
 * 新加了两条，人再也看不到。记指纹的话，**表一变它自己就回来**，而没变的时候不来烦人。
 */
const chatTodoHidden = new Map()

/**
 * 已经给它算过「要不要一上来就收起来」的会话（见 paintChatTodos 里那一段）。
 *
 * 只活在这一次页面加载里——「重新加载对话」正是这条规则要认的那一刻，落 prefs 就把
 * 它变成了一项永久设置。
 */
const chatTodoSeen = new Set()

const todoSign = (items) => items.map((i) => `${i.id}:${i.status}:${i.task}`).join('|')

/**
 * dock 该照着哪一份画。
 *
 * 两个数据源：折出来的最后一条 `todo/list` 事件，和打开这一页时拉的那次快照
 * （syncTodos）。谁新按**日志行号**比，不按时间比——那是两台机器各自的钟
 * （理由见 approvalDead）。快照没有 seq，它带的是取快照那一刻的水位。
 */
function chatTodoItems(folded) {
  const ev = folded && folded.todos
  const snap = chatTodoSnap.get(state.chatSessionId) || null
  if (ev && (!snap || Number(ev.seq) > Number(snap.upto))) return ev.items || []
  if (snap) return snap.items || []
  return []
}

/**
 * 待办 dock：输入框顶上那块可折叠的清单（见 docs/todo-tool.md）。
 *
 * **为什么值得单占一块地方。** 清单本来只以工具结果的形式躺在消息流里，而那正是它
 * 最没用的地方：一次十步的活会把它往上顶出屏幕，人想知道「还剩几条」得往回翻。它是
 * 一份**当前状态**，状态该待在一个固定的位置上。
 *
 * 折叠态一行说完三件事：在做什么、做了几条、还剩几条。展开才铺开细节。
 */
function paintChatTodos(folded) {
  const box = document.getElementById('chat-todock')
  if (!box) return
  const items = chatTodoItems(folded)
  const sid = state.chatSessionId
  // 空表不占位置。清单被清掉、或者这条会话压根没用过 todo，都走这一支。
  if (!items.length) return clearTodock(box)
  const sign = todoSign(items)
  const done = items.filter((i) => i.status === 'completed').length
  const running = items.find((i) => i.status === 'in_progress')
  const open = items.filter((i) => i.status === 'pending')
  // 抬头那句话：正在做哪一条 > 下一条该做什么 > 已经收口了。
  const now = running || open[0] || null
  const allDone = !running && !open.length
  /**
   * **收口了的那张表，重新加载之后不再摆出来。**
   *
   * 这块 dock 回答的是「这摊活做到哪儿了」。全部收口之后它已经答完了：再打开这一页
   * 时，它顶掉的是输入框上面那行位置，而它能说的只有一句「昨天那件事做完了」——那句话
   * 人上一次关掉页面之前就知道了。
   *
   * **只拦「第一次拿到」这一下**，所以盯着看的时候不受影响：最后一条打勾会让指纹变，
   * 那一帧照样画出「已完成」，人看得见事情收口了。之后清单再变（模型新列一张、或者
   * 某条被重新打开），指纹又变，它自己就回来——和 × 关掉那一张是同一套机制，这里只是
   * 替人先按了一下。
   *
   * 记「这条会话认过了」而不是直接看指纹在不在表里：一张空表也走不到这儿（上面那道
   * 闸），而 `chatTodoHidden` 里没有条目和「有条目但指纹不一样」是两件事。
   */
  if (!chatTodoSeen.has(sid)) {
    chatTodoSeen.add(sid)
    if (allDone) chatTodoHidden.set(sid, sign)
  }
  if (chatTodoHidden.get(sid) === sign) return clearTodock(box)
  const badge = running
    ? t('正在执行', 'Running')
    : allDone
      ? t('已完成', 'Done')
      : t('待办', 'To do')
  const opened = chatTodoOpen.get(sid) === true
  box.hidden = false
  /**
   * **清单没变就不重建 DOM。**
   *
   * 这个函数挂在 paintChatChrome 上，而那一个在流式期间是**每一帧**都跑的
   * （schedulePaintChat 走 rAF）。无条件写 innerHTML 的话，展开着的那张清单每帧被拆掉
   * 重建：它自己有滚动区（.sw-todock-list 的 max-height），于是 scrollTop 每帧归零——
   * 一张十几条的表在跑活的时候根本滚不动，而那正是人最想看它的时候；键盘焦点和选中的
   * 文字也一起没。同一件事在交接卡那块是用 hSig 挡住的（见 paintChatBlocks），
   * 这里照抄。
   *
   * 展开态**不进这个指纹**：它由下面几行属性写就地生效，不碰 DOM 结构，所以折起再
   * 展开时滚动位置和焦点都还在。
   */
  if (box.getAttribute('data-sig') !== sign) {
    box.setAttribute('data-sig', sign)
    box.innerHTML = todockHtml(items, { done, now, running, allDone, badge, opened })
  }
  // 展开 / 折起：改属性，不重建。每次都写一遍是幂等的，也顺手把重建之后的那一帧对齐。
  applyTodockOpen(box, opened)
}

/** 把「展开着还是折着」写到 DOM 上。**只改属性**，不碰结构——理由见上面那段。 */
function applyTodockOpen(box, opened) {
  box.setAttribute('data-open', opened ? '1' : '0')
  const head = box.querySelector('.sw-todock-head')
  if (head) head.setAttribute('aria-expanded', opened ? 'true' : 'false')
  const list = box.querySelector('.sw-todock-list')
  if (list) list.hidden = !opened
}

/** 收起来：连指纹一起清掉，否则下次要显示时会以为「没变」而不重建。 */
function clearTodock(box) {
  box.hidden = true
  box.removeAttribute('data-sig')
  box.innerHTML = ''
}

function todockHtml(items, { done, now, running, allDone, badge, opened }) {
  return (
    `<div class="sw-todock-bar">` +
    `<button type="button" class="sw-todock-head" data-act="chat-todo-toggle" aria-expanded="${opened ? 'true' : 'false'}">` +
    `<span class="sw-todock-icon">${ICON_LIST}</span>` +
    `<span class="sw-todock-title">${esc(t('任务', 'Tasks'))}</span>` +
    `<span class="sw-todock-badge" data-s="${running ? 'run' : allDone ? 'done' : 'idle'}">${esc(badge)}</span>` +
    (now ? `<span class="sw-todock-now">${esc(now.task || '')}</span>` : '') +
    `<span class="sw-spacer"></span>` +
    `<span class="sw-todock-count">${done}/${items.length} ${esc(t('已完成', 'done'))}</span>` +
    `<span class="sw-todock-chev">${ICON_CHEV}</span>` +
    `</button>` +
    `<button type="button" class="sw-todock-x" data-act="chat-todo-hide" ` +
    `aria-label="${esc(t('收起任务清单', 'Dismiss task list'))}" title="${esc(t('收起任务清单', 'Dismiss task list'))}">${ICON_X}</button>` +
    `</div>` +
    `<ol class="sw-todock-list"${opened ? '' : ' hidden'}>` +
    items
      .map(
        (i) =>
          `<li class="sw-todock-item" data-s="${esc(i.status || 'pending')}">` +
          `<span class="sw-todock-mark">${todoMark(i.status)}</span>` +
          `<span class="sw-todock-task">${esc(i.task || '')}</span>` +
          `</li>`,
      )
      .join('') +
    `</ol>`
  )
}

/**
 * 展开 / 折起。**只写三个属性**：不重绘整页（会冲掉输入框里没发出去的字），也不重折
 * 一遍历史、不重建清单的 DOM（那会把刚滚到的位置甩回顶上）。
 */
function toggleChatTodos() {
  const sid = state.chatSessionId
  const opened = chatTodoOpen.get(sid) !== true
  chatTodoOpen.set(sid, opened)
  const box = document.getElementById('chat-todock')
  if (box) applyTodockOpen(box, opened)
}

/** 关掉这一张。**只关这一张**：表一变它自己回来（见 chatTodoHidden）。 */
function hideChatTodos() {
  const sid = state.chatSessionId
  const folded = fold(state.chatEvents, chatLive.get(sid), currentBotHasChannelLabels())
  chatTodoHidden.set(sid, todoSign(chatTodoItems(folded)))
  paintChatTodos(folded)
}

/**
 * 点名以正文为准：正文里还留着 `@名字` 的才算点了，人把那几个字删了就是不点了（sendChat 也只带
 * 这些）。删掉的从 chatMentions 里拿掉——留着的话 `@` 选单把它当「已选」滤掉，人想再点一次也选不到。
 */
function syncChatMentions() {
  const text = state.chatDraft || ''
  const kept = (state.chatMentions || []).filter((m) => text.includes('@' + m.label))
  if (kept.length !== (state.chatMentions || []).length) state.chatMentions = kept
}

/**
 * 已经选中的 `@`。点名混排进了正文（takeMention 把 `@名字` 插在光标处），药丸就画在正文里；
 * 输入框上方原来那排只剩「正文里已经没有它」的——那些发送时本来就不带，摆着像是还会发，× 也按
 * 过滤后的下标删、删错人。所以这里只做一件事：把正文里没有的拿掉，那一排一直收着。
 */
function paintChatMentions() {
  syncChatMentions()
  const box = document.getElementById('chat-mentions')
  if (!box) return
  box.hidden = true
  box.innerHTML = ''
}

// ── 引用（docs/chat-references.md）────────────────────────────────────────────

const ICON_QUOTE = svg(['M9 7H5a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h2l-1 4h2l2-4V9a2 2 0 0 0-2-2z', 'M20 7h-4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h2l-1 4h2l2-4V9a2 2 0 0 0-2-2z'], 14)

/** 一条消息最多带几个引用。和图片、`@` 同一个上限，席位那边也截到这个数。 */
const MAX_REFS = 10
/** 卡上摘录的上限（字符）。席位会按 seq 重算，这份只是回执那几秒和卡上画的那份。 */
const REF_EXCERPT_CHARS = 300

/** 两个引用是不是同一个东西：同一条消息、同一个文件。 */
function sameRef(a, b) {
  if (!a || !b || a.kind !== b.kind) return false
  return a.kind === 'file' ? a.path === b.path : a.seq != null && a.seq === b.seq
}

/** 发给席位的形状：§5.1 那张表，就是卡上那份去掉界面用的字段。 */
function refPayload(r) {
  if (r.kind === 'file') return { kind: 'file', path: r.path, name: r.name }
  return { kind: 'message', seq: r.seq, role: r.role, excerpt: r.excerpt, time: r.time }
}

/** 按扩展名猜图片的 mime。只用来判「模型看不看得了」，跟 pickImages 那张表是一对。 */
function imageMimeOf(path) {
  const ext = String(path || '').split('.').pop().toLowerCase()
  return ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : ''
}

/** 一条消息的摘录：空白折成一个空格，截到上限。 */
function refExcerptOf(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, REF_EXCERPT_CHARS)
}

/**
 * 一张引用卡。输入框上那排（带 ×）和发出去之后气泡里那排（可点、跳回原消息）是同一个
 * 函数画的——发出去前后长得一样，人才认得出这就是刚才点的那个。
 *
 * 文件引用就是那颗产出药丸（fileChipHtml）：同一个东西，点开走同一个预览。
 */
function refCardHtml(r, x) {
  if (r.kind === 'file') return `<span class="sw-ref sw-ref-file">${fileChipHtml(r)}${x}</span>`
  const who = r.role === 'user' ? t('我', 'Me') : t('Bot')
  const when = r.time ? chatClock(r.time) : ''
  const body =
    `<span class="sw-ref-head">${esc(who)}${when ? ' · ' + esc(when) : ''}</span>` +
    `<span class="sw-ref-text">${esc(r.excerpt || t('（无正文）', '(no text)'))}</span>`
  const inner =
    r.seq != null
      ? `<button type="button" class="sw-ref-card" data-act="chat-ref-jump" data-seq="${esc(String(r.seq))}" title="${esc(t('跳到这条', 'Jump to this message'))}">${body}</button>`
      : `<span class="sw-ref-card">${body}</span>`
  return `<span class="sw-ref sw-ref-msg">${inner}${x}</span>`
}

/** 输入框上方那排引用卡。 */
function paintChatRefs() {
  const box = document.getElementById('chat-refs')
  if (!box) return
  const picked = state.chatRefs || []
  box.hidden = !picked.length
  box.innerHTML = picked
    .map((r, i) =>
      refCardHtml(
        r,
        `<button type="button" class="sw-file-x" data-act="chat-ref-drop" data-i="${i}" ` +
          `aria-label="${esc(t('移除', 'Remove'))}">${ICON_X}</button>`,
      ),
    )
    .join('')
}

/** 挂一个引用到输入框上。重复的不挂；满了说一声。 */
function addChatRef(r) {
  const picked = state.chatRefs || []
  if (picked.some((x) => sameRef(x, r))) return false
  if (picked.length >= MAX_REFS) {
    flash('err', t(`一条消息最多引用 ${MAX_REFS} 个`, `At most ${MAX_REFS} quotes per message`))
    return false
  }
  state.chatRefs = picked.concat(r)
  paintChatRefs()
  const input = document.getElementById('chat-input')
  if (input) input.focus()
  return true
}

/** 气泡上点了「引用」：按 seq 在折好的块里找回那条，摘录从它的正文来。 */
function takeRefMessage(seq) {
  const n = Number(seq)
  if (!Number.isFinite(n)) return
  const folded = fold(state.chatEvents, chatLive.get(state.chatSessionId), currentBotHasChannelLabels())
  const b = (folded.blocks || []).find((x) => (x.kind === 'user' || x.kind === 'assistant') && quoteSeqOf(x) === n)
  if (!b) return
  addChatRef({ kind: 'message', seq: n, role: b.kind, excerpt: refExcerptOf(b.text), time: b.time || 0 })
}

/** 预览面板上点了「引用这个文件」：挂上、关掉预览。 */
function takeRefFile(path, name) {
  if (!path) return
  const ok = addChatRef({ kind: 'file', path, name: name || path.split('/').pop() || path })
  if (ok) closePreview()
}

function dropChatRef(i) {
  state.chatRefs = (state.chatRefs || []).filter((_, idx) => idx !== i)
  paintChatRefs()
}

/**
 * 跳到某条消息。已经加载的直接滚过去并亮一下；没加载到就往前翻（最多几页），还没有
 * 就说一声——`/clear` 过的、太久远的，就是不在这里了。
 */
async function jumpToMessage(seq, opts = {}) {
  // 按壳上的 data-seq 找（那是 quoteSeqOf 给的），不按 data-key：助手块的 key 是它第一条
  // 事件的 seq，而引用指的是 assistant/message 那条。
  const find = () => document.querySelector(`#chat-thread .sw-msg[data-seq="${esc(String(seq))}"]`)
  // 往前补几页为止。引用卡默认 5 页（引用的多半是眼前这几轮）；对话内查找（chat-find.js）
  // 的命中可能在几百轮之前，它自己给一个大得多的数。
  const pages = Math.max(0, Math.trunc(opts.pages ?? 5))
  let node = find()
  for (let i = 0; !node && i < pages; i++) {
    const page = chatPages.get(state.chatSessionId)
    if (!page || !page.hasMore) break
    await loadOlderChat(state.chatSessionId)
    node = find()
  }
  if (!node) {
    flash('err', t('那条消息不在这里了', 'That message is no longer here'))
    return false
  }
  node.scrollIntoView({ block: 'center', behavior: 'smooth' })
  node.setAttribute('data-flash', '1')
  setTimeout(() => node.removeAttribute('data-flash'), 1200)
  return true
}

/**
 * 这条对话里能不能 @ 别的 Bot：只有**主 Bot 的对话**可以（docs/bot-tasks.md）——只有它有
 * assign_task，别的 Bot 点了也派不出去。候选接口不知道人开着哪条对话，所以这一步在界面判。
 */
function botMentionsHere() {
  return Boolean(state.mainBotId && state.mainBotId === chatBotIdNow())
}

/** `@` 选单。候选来自 /mentions：连接器，加上名单上别的 Bot（只在主 Bot 的对话里画）。 */
function paintMentionPick() {
  const box = document.getElementById('chat-mentionpick')
  if (!box) return
  const pick = state.mentionPick
  if (!pick || !pick.open) {
    box.hidden = true
    box.innerHTML = ''
    return
  }
  const q = (pick.q || '').toLowerCase()
  syncChatMentions()
  const taken = new Set((state.chatMentions || []).map((m) => m.id))
  const botsHere = botMentionsHere()
  const list = (state.mentionOptions || [])
    .filter((m) => !taken.has(m.id))
    .filter((m) => m.kind !== 'bot' || botsHere)
    .filter((m) => !q || m.label.toLowerCase().includes(q) || (m.toolkit || '').includes(q))
    .slice(0, 8)
  box.hidden = false
  box.innerHTML = list.length
    ? list
        .map(
          (m, i) => `<button type="button" class="sw-pick${i === (pick.index || 0) ? ' is-on' : ''}"
        data-act="chat-mention-pick" data-id="${esc(m.id)}">
        ${m.kind === 'bot' ? `<span class="sw-pick-logo sw-pick-bot">${botAvatar(m.icon, 16, m.origin)}</span>` : m.logo ? `<img class="sw-pick-logo" src="${esc(m.logo)}" alt="" data-onerror="drop">` : ''}
        <span>${esc(m.label)}</span>
        ${m.kind === 'bot' ? `<small>${esc(t('派活给它', 'Assign to it'))}</small>` : m.mentionOnly ? `<small>${esc(t('仅 @ 时可用'))}</small>` : ''}
      </button>`,
        )
        .join('')
    : `<div class="sw-pick-empty">${esc(botsHere ? t('没有可 @ 的连接或 Bot。', 'Nothing to mention: no connections, no other bots.') : t('没有可用的连接。去「连接器」装一个再连上。'))}</div>`
}

/**
 * 正在传的附件，按 Bot 记：`botId → 那一条的附件`。
 *
 * **不再放在 state.chatFiles 里，也不再是一个全局开关。** 以前传的那几秒里附件还挂在
 * chatFiles 上、`state.chatUploading` 是一颗全局的闩：人这时切到 B，换 Bot 那一步把
 * 「在路上的」附件当成 A 的草稿收了起来，传完又因为人不在 A 而没清——切回 A，同一批
 * 附件又摆在输入框上，再按一次就传两遍、发两遍；而在 B 上按发送，撞上那颗全局闩，什么
 * 也不发生。现在一按发送，附件就从草稿里挪到这儿：草稿里只剩没发的，闩只闩这一个 Bot。
 */
const chatUploads = new Map()

function paintChatFiles() {
  const box = document.getElementById('chat-files')
  if (!box) return
  const flying = chatUploads.get(chatBotIdNow()) || []
  const files = state.chatFiles || []
  box.hidden = !flying.length && !files.length
  const chip = (f, x) => `<span class="sw-file"><span>${esc(f.name)}</span><small>${esc(fileSize(f.size))}</small>${x}</span>`
  // 在路上的不给「移除」：那一下删得掉列表项，删不掉已经在路上的请求。
  box.innerHTML =
    flying.map((f) => chip(f, '')).join('') +
    files
      .map((f, i) =>
        chip(
          f,
          `<button type="button" class="sw-file-x" data-act="chat-file-drop" data-i="${i}" ` +
            `aria-label="${esc(t('移除'))} ${esc(f.name)}">${ICON_X}</button>`,
        ),
      )
      .join('')
}

function fileSize(bytes) {
  return SatuCore.fmtFileSize(bytes)
}

/**
 * 记下选中的附件。**不读内容**——文件在发送时整个流给席位，落进工作区，Bot 用
 * read/bash 自己取。
 *
 * 以前这里要 file.text() 把正文贴进消息，于是 256 KB 就是天花板，PDF、Excel、图片
 * 一概传不了（贴成乱码对谁都没用）。现在传的是路径，格式和大小都不再是这一层的事。
 */
function takeChatFiles(input) {
  const picked = Array.from(input.files || [])
  input.value = ''
  if (!picked.length) return
  state.chatFiles = [...(state.chatFiles || []), ...picked.map((file) => ({ name: file.name, size: file.size, file }))]
  paintChatFiles()
}

/** 带登录票的请求头。预览和上传都不走 api()——它们收发的不是 JSON。 */
function authHeaders(extra) {
  const headers = { ...(extra || {}) }
  const tok = token()
  if (tok) headers.authorization = 'Bearer ' + tok
  return headers
}

/**
 * 把一个文件传进这条会话的工作区，返回 { path, name, size }。
 *
 * 文件名走 header：查询串会进访问日志，而文件名常常就是内容本身
 * （「二季度裁员名单.xlsx」）。header 只认 ASCII，所以先 encodeURIComponent，
 * 席位那边解回来。
 */
/**
 * 上传**只直连席位机器**，和对话流同一个道理（见 directStreamBase 上面那段）：
 * Gateway 上 `POST /runtime/sessions/:id/files` 已经没有了，文件正文不该再经它中转。
 *
 * · 本地 Bot：照旧拼 `/runtime/sessions/<id>/files`——data.js 的 localRoute 认这个形状，
 *   改道到 127.0.0.1 那颗 bot 的 /api/sessions/<id>/files，票换成席位票。
 * · 远程 Bot：打 `bot.runtime.uploadUrl`（https://<机器>/seats/<seatId>/stream）下的
 *   /sessions/<id>/files，带登录票，管家那头验完换成席位票。地址是 null 就一个字节
 *   都不发——那是配置缺一项，不是故障。
 */
const NO_UPLOAD_URL_MSG = '这台机器没有配直连地址（或管家太旧），上传不了'

function uploadTargetOf(sessionId) {
  /**
   * 认**这条会话的主人**，界面当下选中的那颗 Bot 只是兜底。
   *
   * 反过来写会错：上传是一个文件一个文件发的，`sessionId` 在循环外就钉死了，而这里每一轮
   * 都重算一次。人在传的中途切了个席位，第 N 个文件就带着第一条会话的 id 打到**另一个**
   * 席位的 uploadUrl 上；那边查得出这条会话不存在，回 404，界面上只剩一句「附件没传上去」
   * 加一个看不懂的状态码。
   */
  const owner = botIdOfSession(sessionId) || state.chatBotId
  const bot = runtimeBotOf(owner)
  const path = '/sessions/' + encodeURIComponent(sessionId) + '/files'
  // 本地 Bot 照旧拼 `/runtime/...`：data.js 的 localRoute 认这个形状，改道到 127.0.0.1。
  if (isLocalRuntimeBot(bot)) return { url: '/runtime' + path, local: true }
  /**
   * 名单上没有这颗 Bot、名单行没带 runtime、或者远程 Bot 没配 uploadUrl：一个字节都不发。
   *
   * 以前这几种也退回 `/runtime/...`，可 Gateway 上的 `POST /runtime/sessions/:id/files`
   * 这一版已经删干净了（见 e2e/gateway-chat.mjs 那条「要真的没了」），走过去只换来一个生的
   * 404。给 null，让 uploadChatFile 抛 NO_UPLOAD_URL_MSG——缺的是配置，那句话说得清。
   */
  const base = bot && bot.runtime && bot.runtime.uploadUrl
  if (!base) return null
  return { url: base + path, local: false }
}

async function uploadChatFile(sessionId, file) {
  const target = uploadTargetOf(sessionId)
  if (!target) throw new Error(t(NO_UPLOAD_URL_MSG))
  const init = {
    method: 'POST',
    headers: authHeaders({
      accept: 'application/json',
      'content-type': 'application/octet-stream',
      'x-filename': encodeURIComponent(file.name),
    }),
    body: file,
  }
  // 本地那条走 swFetch（要它改道）；直连那条地址是绝对的，裸 fetch。
  const res = target.local ? await swFetch(target.url, init) : await fetch(target.url, init)
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {}
  if (!res.ok) throw new Error(errText((json && json.error) || 'HTTP ' + res.status))
  return json
}

/**
 * 附件在正文里的样子。
 *
 * 给的是**路径，不是内容**：文件已经躺在工作区里了，Bot 想读哪段读哪段，几百页的
 * PDF 也不会一次撑爆上下文。
 *
 * 排在正文前面——先给材料再给指令，模型读到「照这个文件改」时文件已经在眼前。
 */
function composeChatBody(files, text) {
  if (!files.length) return text
  const list = files.map((f) => '- `' + f.path + '`').join('\n')
  return t('我上传了文件，在工作区里：') + '\n' + list + (text ? '\n\n' + text : '')
}

/**
 * 模型真能看的图片格式。跟席位那边的白名单是同一张表（web/index.ts 的
 * MODEL_IMAGE_MIME）——这边先分好，能少一趟注定要被拒的往返。
 */
const MODEL_IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/**
 * 传上去的东西里，哪些能直接给模型看。
 *
 * 图片走 `images`（到了模型那边是真正的视觉输入），其余的只在正文里留个路径——
 * 后者模型得自己去 read。两条路都要有：图片的路径也列进正文，因为模型可能想用
 * 工具再处理它，而 image 块里是没有路径的。
 */
function pickImages(files) {
  return files
    .map((f) => ({ path: f.path, mime: String(f.contentType || '').split(';')[0].trim() }))
    .filter((f) => f.path && MODEL_IMAGE.has(f.mime))
}

/**
 * 挂着的那一条「等会话到了就发」。
 *
 * **只记意图，不记正文。** 正文一直躺在 state.chatDraft 里（这条路是在清草稿之前就
 * return 的），补发时现取——人在等的这几秒里又补了两个字，发出去的自然该是补过的那份；
 * 把它清空了，那就等于什么都没挂。
 *
 * 同时只留一个：人连按三次发送，挂的还是同一条，补发也只发一次。
 */
let heldSend = null

/**
 * 挂多久就不再补发了。
 *
 * 十分钟：换版、重启、网络断一阵都在这个尺度以内，而超过它多半是人早就走开了——那时
 * 候突然把十分钟前打的半句话发出去，比不发更糟。
 */
const HELD_SEND_MAX_MS = 10 * 60_000

function holdSend(botId) {
  if (!botId) return
  heldSend = { botId, at: Date.now() }
}

function clearHeldSend() {
  heldSend = null
}

/**
 * 会话到手了：把挂着的那一条补发出去。
 *
 * 三道闸，缺一不可：
 *
 * · **同一个 Bot**——人挂上之后切走了，那条草稿跟着上一个 Bot 收进 chatDrafts 里
 *   （见 ensureChatSession），这会儿补发就是把它发到别人的对话里去；
 * · **没挂太久**（见 HELD_SEND_MAX_MS）；
 * · **先清标记再发**——sendChat 里那条「没有会话」的路会重新挂上，不先清的话两边
 *   互相触发，一次断线能发出去好几条。
 */
function flushHeldSend(botId) {
  const held = heldSend
  if (!held || held.botId !== botId || state.chatBotId !== botId) return
  clearHeldSend()
  if (Date.now() - held.at > HELD_SEND_MAX_MS) return
  if (!(state.chatDraft || '').trim() && !(state.chatFiles || []).length && !(state.chatMentions || []).length && !(state.chatRefs || []).length) return
  void sendChat()
}

/**
 * 没发成的那一条还给**它自己那个 Bot** 的草稿。
 *
 * 人还停在那个 Bot 上就还进输入框；已经切走了就写进 chatDrafts，切回去时 applyDraft
 * 摆出来。等的这几秒里人可能又打了几个字、又挑了附件：都留着，退回来的排在前面。
 */
function returnDraft(botId, text, files, mentions, refs = []) {
  const here = chatBotIdNow() === botId
  const cur = here
    ? { text: state.chatDraft || '', files: state.chatFiles || [], mentions: state.chatMentions || [], refs: state.chatRefs || [] }
    : state.chatDrafts[botId] || { text: '', files: [] }
  const curText = String(cur.text || '')
  const curMentions = Array.isArray(cur.mentions) ? cur.mentions : []
  const curRefs = Array.isArray(cur.refs) ? cur.refs : []
  const next = {
    text: curText.trim() ? text + '\n' + curText : text,
    files: files.concat(cur.files || []),
    mentions: mentions.concat(curMentions.filter((m) => !mentions.some((x) => x.id === m.id))),
    // 引用也要还：只还正文的话，人按重发时「按这条改」就没了「这条」。
    refs: refs.concat(curRefs.filter((r) => !refs.some((x) => sameRef(x, r)))),
  }
  if (!here) {
    state.chatDrafts[botId] = next
    return
  }
  state.chatDraft = next.text
  state.chatFiles = next.files
  state.chatMentions = next.mentions
  state.chatRefs = next.refs
  const input = document.getElementById('chat-input')
  if (input) input.value = next.text
  paintChatFiles()
  paintChatMentions()
  paintChatRefs()
}

async function sendChat() {
  const text = (state.chatDraft || '').trim()
  const files = state.chatFiles || []
  /**
   * 只带正文里还留着 `@名字` 的点名：人把那几个字删了，就是不点了。带 inline 是给回执用的
   * ——那几秒里气泡就该把药丸画在原位，和席位送回来的那条长得一样。
   */
  const mentions = (state.chatMentions || []).filter((m) => text.includes('@' + m.label)).map((m) => ({ ...m, inline: true }))
  const refs = state.chatRefs || []
  const sessionId = state.chatSessionId
  /**
   * 发这条消息时人停在哪个 Bot 上。
   *
   * 中间隔着一段传附件的时间，几秒起步，人这会儿可能已经切到了别的 Bot。所以草稿在
   * 按下的那一刻就整条从 A 的输入框里拿走（附件挪进 chatUploads），失败时经 returnDraft
   * 还给 A——不管人这会儿停在谁身上。
   */
  const forBot = chatBotIdNow()
  if (!text && !files.length && !mentions.length && !refs.length) return
  if (chatUploads.has(forBot)) {
    // 同一个 Bot 上一条的附件还在传：这一条抢在前面发，顺序就反了。别的 Bot 不受影响。
    flash('err', t('上一条的附件还在传，传完再发这一条', 'Still uploading the previous attachments — send this once they finish'))
    render()
    return
  }
  /**
   * 斜杠命令**在这里拦下，绝不往 /messages 走**。
   *
   * 选单只是提示，真正的闸必须在发送路径上：人完全可以把 `/compact` 打完再按回车，
   * 那时选单可能已经关了（打完最后一个字母时它还开着，但失焦、Esc 都会关掉）。
   */
  const cmd = parseCommand(text)
  if (cmd) {
    if (cmd.unknown) {
      // **不当普通消息发出去。** 一个手滑的 `/copmact` 发给模型，它会礼貌地回一段
      // 「你是想…吗」，而人以为自己压缩过了。草稿留着，改一个字母就能重来。
      flash('err', t('没有这条命令：') + cmd.unknown)
      closeCmdPick()
      render()
      return
    }
    if (cmd.extra && !cmd.cmd.args) {
      flash('err', '/' + cmd.cmd.name + ' ' + t('不带参数，单独发这一条就行'))
      closeCmdPick()
      render()
      return
    }
    if (files.length || mentions.length) {
      // 命令占满整条消息，不捎带附件和点名。那些东西原样留在输入框上。
      flash('err', t('命令不能和附件或 @ 一起发，先把这条命令单独发出去'))
      render()
      return
    }
    await runChatCommand(cmd.cmd, cmd.arg || '')
    return
  }
  /**
   * **没有会话不能一声不吭地咽下去。** 席位刚部署完的那几十秒里 chatSessionId 就是空
   * 的（见 ensureChatSession），而这里原先和「草稿是空的」共用一句 `return`：字打得
   * 进去，点发送什么都不发生，一个字的解释也没有——刷新一下页面又好了，因为那会重
   * 新拿一次会话。
   *
   * 现在说清楚，并且当场催一次（ensureChatSession 自己会退避重来）。**不 await**：
   * 那一跳最长十几秒，等它回来再发的话，这期间人多半已经又按了一次回车——两次都停在
   * 同一个 await 上，会话一到就把同一条话发两遍。
   */
  if (!sessionId) {
    /**
     * **这一条不退回给人重按，挂起来等会话。**
     *
     * ensureChatSession 开头就 `cancelSessionRetry()` + `sessionGaveUp = false`，所以
     * 这一句本身就是「重新开始试」——关键是它以前只在**这一次点击**时催一下，人要是
     * 不再点，就再没有人管了。线上抓到的那次正是这个形状：换版期间标签页在后台，退避
     * 链被浏览器冻着走完了、认了输，人回来一按发送，看到一句「等它接上再发」，然后
     * 干等——而席位早就好了。
     *
     * 按下去是一次**真的重来**：会话那条链重排（最长 5 分钟），流那条也从慢速长跑里
     * 叫醒（idleRetry）。**并且记下「这一条要发」**——会话一到就自动补发（见
     * holdSend / flushHeldSend），人不必守在屏幕前反复按。
     *
     * 席位换版必然踩中这一刻：换了进程之后客户端要重新拿一次会话，中间隔着一个往返，
     * 而人正在这时候按发送。以前退回给他一句「接上再按一次」，等于把重试的活派给了人。
     */
    const botId = state.chatBotId || chatBotIdOf(state.path)
    if (botId) {
      holdSend(botId)
      void ensureChatSession(botId).catch(() => {})
      const row = botStreams.get(botId)
      if (row && row.sessionId) reviveChatStream(row.sessionId, botId)
    }
    flash('err', t('还没接上席位，这条先挂着——接上就自动发出去'))
    render()
    return
  }
  // 走到这儿说明会话在手上：之前挂着的那一条（如果有）就是这一条，标记该退场了，
  // 免得这次发完之后 flushHeldSend 又补发一遍。
  clearHeldSend()
  /**
   * **发之前先确认还有人在听。**
   *
   * 回答是经 SSE 回来的，而这条消息走的是另一条请求——两者互不相干，流断着照样发得
   * 出去、bot 照样跑完。屏幕上于是挂着一句「正在思考」，日志里那一轮明明已经
   * completed，只能刷新（刷新管用，正是因为它重开了一条流）。换版那几分钟里退避真
   * 认过一次输，那之后每一条消息都会落进这个坑。
   *
   * 不 await：重连带 after 游标，错过的会补回来，没必要让人多等一个 RTT。
   */
  reviveChatStream(sessionId, state.chatBotId)

  state.chatDraft = ''
  state.chatMentions = []
  state.chatFiles = []
  state.chatRefs = []
  closeMentionPick()
  paintChatMentions()
  paintChatRefs()
  const input = document.getElementById('chat-input')
  if (input) {
    input.value = ''
    input.style.height = ''
  }

  // 附件先落地，再发消息。反过来的话，模型会先读到路径、文件还没到。
  let uploaded = []
  if (files.length) {
    chatUploads.set(forBot, files)
    paintChatFiles()
    render()
    try {
      for (const f of files) uploaded.push(await uploadChatFile(sessionId, f.file))
    } catch (err) {
      // 传失败就把草稿、附件和点名原样还回去，别让人重新选一遍文件、重新 @ 一遍。
      chatUploads.delete(forBot)
      returnDraft(forBot, text, files, mentions, refs)
      flash('err', t('附件没传上去：') + err.message)
      render()
      return
    }
    chatUploads.delete(forBot)
  }
  paintChatFiles()

  /**
   * 引用的图片**同时**走 `images`（docs/chat-references.md §5.2）：这样它既有「这是用户
   * 指着的那张图」这一行字，又是真正的视觉输入。按路径去重——同一张图既上传又引用的
   * 不送两遍。
   */
  const refImages = refs
    .filter((r) => r.kind === 'file' && OUT_IMAGE_RE.test(r.path))
    .map((r) => ({ path: r.path, mime: imageMimeOf(r.path) }))
    .filter((x) => MODEL_IMAGE.has(x.mime))
  const seenImg = new Set()
  const images = pickImages(uploaded)
    .concat(refImages)
    .filter((x) => (seenImg.has(x.path) ? false : (seenImg.add(x.path), true)))
  const body = composeChatBody(uploaded, text)
  /**
   * 先画上，再发。**这一条是给人看的回执**：POST 出去到席位把 user/message 经 SSE 送
   * 回来，中间少则几百毫秒、多则几十秒（bot 在忙的时候），原先那段时间屏幕上什么也
   * 没有，人只能再按一次回车。
   *
   * afterSeq 记住「此刻流走到哪儿了」，回执认领时只认它之后的——见 mergePending。
   */
  const afterSeq = (state.chatEvents || []).reduce((m, ev) => (ev.seq > m ? ev.seq : m), -1)
  // mentions 也带上：回执那几秒里那条消息要长成最终的样子，否则药丸会先没有、
  // 等席位把事件送回来才突然冒出来——同一条消息在屏幕上跳两次。
  const pending = { sessionId, text: body, images, mentions, refs, at: Date.now(), afterSeq }
  state.chatPending = (state.chatPending || []).concat(pending)
  paintChat()
  try {
    const r = await api('POST', '/runtime/sessions/' + encodeURIComponent(sessionId) + '/messages', {
      text: body,
      ...(images.length ? { images } : {}),
      ...(mentions.length ? { mentions: mentions.map((m) => ({ kind: m.kind, id: m.id, label: m.label })) } : {}),
      ...(refs.length ? { refs: refs.map(refPayload) } : {}),
    })
    /**
     * 席位认不认 `refs`：认的话响应里回 `refs: n`。老席位的响应没有它——那条消息已经
     * **不带引用地**发出去了，人要知道，不然「按这条改」发出去 Bot 却问「哪条」，像是它傻。
     * 不挡消息：用户那句话没有错。
     */
    if (r && refs.length && r.refs == null) {
      flash('err', t('这个席位还不认引用，这条没带上它们（要更新 Bot 版本）', 'This seat does not support quotes yet; sent without them (update the bot)'))
      render()
    }
    /**
     * 排队了：把刚画上的那条气泡撤掉，改画成输入框顶上的一行。
     *
     * 席位那边紧接着会经 SSE 推一次 `queue/change`，这里先自己填一行是为了「点了发送
     * 立刻有反应」——那一跳来回几百毫秒，中间屏幕上什么都没有的话，人会再按一次。
     */
    if (r && r.queued) {
      state.chatPending = (state.chatPending || []).filter((p) => p !== pending)
      const rows = chatQueues.get(sessionId) || []
      chatQueues.set(sessionId, rows.concat({ id: r.queueId, text: body, mentions, refs, createdAt: Date.now() }))
      paintChat()
      paintChatQueue()
    }
    // Gateway 把失效的点名剔掉了（断了、被公司禁了、根本不是我的）。人要知道为什么，
    // 不然那几颗药丸就是无声消失的。
    if (r && Array.isArray(r.droppedMentions) && r.droppedMentions.length) {
      flash('err', t(`有 ${r.droppedMentions.length} 个 @ 已经失效，这一条没带上它们`))
      render()
    }
  } catch (err) {
    // 没发出去就把这条回显撤掉，别让屏幕上留一条其实不存在的消息。
    state.chatPending = (state.chatPending || []).filter((p) => p !== pending)
    /**
     * 文件已经传上去了，退回来的只有草稿——附件不还，还了会传第二遍。
     *
     * **点名也要还。** 只还正文的话，人按重发时这一条不带任何 `@`——而
     * `mentionOnly` 的连接（比如个人邮箱）这一轮根本不在工具表里，Bot 会回一句
     * 「没有可用的邮箱」，用户却以为自己点过名了。
     */
    returnDraft(forBot, text, [], mentions, refs)
    if (uploaded.length) flash('err', t('附件已经在工作区里了，但这条消息没发出去。'))
    if (String(err.message || '').includes('实例还没上线')) state.runtimeError = '实例还没上线'
    else if (!uploaded.length) flash('err', err.message)
    render()
  }
}

/**
 * 中止这一轮。
 *
 * 以前是 `catch {}` 一把吞掉。三种完全不同的情况在界面上长得一模一样——请求没发出去、
 * 席位不认这条会话、这一轮其实早就结束了——都是「点了没反应」，连往哪儿查都给不出。
 *
 * **它不是当场生效的。** 这一下只是把中止下发出去：界面 → Gateway → 席位 →
 * `agent.abort()`。信号现在会往下传给正在跑的工具（bot/src/agent/index.ts 的
 * bridgeTools 接了 signal，terminal 收到就杀进程树），但收尾要时间，而且不是每种工具
 * 都能当场收住——一个已经发出去的网络请求、浏览器里正走着的那一步，都得等它自己回来。
 * 所以「按下」和「停住」之间永远有一段，`turn/end` 到了才算真停。
 *
 * 这一段以前界面上完全没有痕迹，于是它长得跟「点了没反应」一模一样。现在按下去当场
 * 进 `chatStopping`：按钮转圈并禁掉，输入框底下那行字改口读秒（见 stopTipText）。
 */
/**
 * 发送键的三副面孔：发送 / 停止 / 正在停止。前两副是同一颗按钮的开与关，第三副是「这一下已经收到了，
 * 正在下发」——它必须和「停止」长得不一样，不然人只能靠反复点来确认。
 *
 * **输入框里是一条命令时，跑着也给「发送」**：`/clear` 打好了，按下去就该执行它（runChatCommand 会先
 * 停下这一轮），而不是停掉这一轮、命令原样躺在框里。手机上没有回车键兜底，这一条尤其要紧。
 */
function paintSendFace(busy = Boolean(state.chatStatus)) {
  const send = document.getElementById('chat-send')
  if (!send) return
  const stopping = stopElapsed() !== null
  const parsed = parseCommand(state.chatDraft || '')
  const asStop = busy && !(parsed && !parsed.unknown)
  const face = stopping ? 'stopping' : asStop ? 'stop' : 'send'
  if (send.getAttribute('data-state') === face) return
  // 停止态改成 type=button 并挂上 chat-abort：留着 submit 的话，点它会走发送。
  // 回车不受影响——那条路径仍是提交表单，也就是「边跑边补一句」，本来就该照发。
  send.setAttribute('data-state', face)
  send.type = asStop || stopping ? 'button' : 'submit'
  send.innerHTML = asStop || stopping ? ICON_STOP : ICON_SEND
  const label = stopping ? t('正在停止…', 'Stopping…') : asStop ? t('停止') : t('发送')
  send.setAttribute('aria-label', label)
  send.title = label
  // 正在停的时候禁掉：第二下什么也做不成（席位已经收到了），但按得下去就会让人
  // 以为第一下没算数。转圈画在按钮外沿，见 chat.css 的 [data-state='stopping']。
  send.disabled = stopping
  if (asStop) send.setAttribute('data-act', 'chat-abort')
  else send.removeAttribute('data-act')
}

async function abortChat() {
  const sessionId = state.chatSessionId
  if (!sessionId) return
  // 已经在停了：第二下什么也别做。按钮那会儿是 disabled 的，这里是键盘和竞态的第二道闩。
  if (state.chatStopping === sessionId) return
  const stillRunning = Boolean(document.querySelector('.sw-toolchip[data-state="running"]'))
  /**
   * **先改界面，再发请求。** 这一下改的是「已经收到了」，不是「已经停了」——那两件
   * 事之间隔着整条下发链路，而这期间流上一个事件都不会来。等请求回来再改的话，最先
   * 那几百毫秒里屏幕纹丝不动，人得到的反馈是「点了没反应」。
   */
  state.chatStopping = sessionId
  state.chatStoppingAt = Date.now()
  paintChat()
  try {
    const r = await api('POST', '/runtime/sessions/' + encodeURIComponent(sessionId) + '/abort', {})
    if (r && r.aborted === false) {
      // 席位说这一轮本来就不在跑：转圈当场收掉，别让它对着一件没在发生的事转下去。
      clearStopping()
      flash('err', t('这一轮已经结束了', 'That turn had already finished.'))
    } else if (stillRunning) {
      flash('ok', t('已下发停止；正在跑的那个工具要等它自己收尾', 'Stop sent — the running tool has to wind down first.'))
    } else {
      flash('ok', t('已下发停止，等 Bot 收到就停', 'Stop sent — it takes effect once the bot receives it.'))
    }
    render()
  } catch (err) {
    // 没送到就把转圈收掉：这一下是白按的，得让按钮还能再按一次。
    clearStopping()
    flash('err', t('没能中止：', 'Could not stop: ') + (err && err.message ? err.message : ''))
    render()
  }
}

/* ── `@` 点名 ──────────────────────────────────────────────────────────
   输入框里打 `@` 弹选单，选中之后 `@名字` 落在正文里光标处，和文字混排——点名的意思在
   位置里（「打开 @Gmail 邮件，让 @客户经理 处理」）。它仍然是结构化的：发送时 mentions
   单独带上 id，席位按 `@名字` 的位置切成 text / mention 交错的块，决定这一轮的工具表
   （`mentionOnly` 的连接只有被点名才出现），不是靠模型从一串字里猜。 */

/** 光标前面刚打出来的 `@xxx`。不在词首（前面挨着字母）不算，邮箱地址不该触发选单。 */
function mentionQueryAt(el) {
  if (!el) return null
  return SatuCore.mentionQueryAt(el.value, el.selectionStart ?? el.value.length)
}

function closeMentionPick() {
  state.mentionPick = null
  paintMentionPick()
}

async function openMentionPick(q) {
  /**
   * **只在选单从关到开的那一下重拉候选**，不是每敲一个字拉一次，也不是一整页只拉一次。
   *
   * 一页只拉一次的话，人在另一个标签页刚连上的账号 `@` 不出来，只能刷新页面；每敲一个
   * 字拉一次又太吵。开合这一下正好：`/mentions` 就是两条查询，而人打开选单时本来就
   * 在等一小会儿。
   */
  const opening = !state.mentionPick
  state.mentionPick = { open: true, q, index: 0 }
  paintMentionPick()
  if (opening || !state.mentionOptions) {
    try {
      state.mentionOptions = (await api('GET', '/mentions')).mentions || []
    } catch {
      state.mentionOptions = state.mentionOptions || []
    }
    // 拉回来的时候人可能已经把选单关掉了（打了个空格）。那就别再画。
    if (state.mentionPick) paintMentionPick()
  }
}

/** 选中一个：把输入框里那截 `@xxx` 抹掉，改成上方的一颗药丸。 */
function takeMention(id) {
  const one = (state.mentionOptions || []).find((m) => m.id === id)
  if (!one) return
  /**
   * **插进正文，不另摆一排。** 点名的意思在位置里：「打开 @Gmail 邮件，让 @客户经理 处理」，
   * 谁去打开、谁来处理全靠它落在哪儿。选中的那一刻把刚打的 `@xx` 换成 `@名字 `，光标停在
   * 后面接着打；发送时按 `@名字` 的位置切块（见 sendChat 和席位的 interleaveMentions）。
   */
  const el = document.getElementById('chat-input')
  const hit = mentionQueryAt(el)
  const token = '@' + one.label + ' '
  if (el) {
    const pos = el.selectionStart ?? el.value.length
    const from = hit ? hit.at : pos
    el.value = el.value.slice(0, from) + token + el.value.slice(pos)
    el.selectionStart = el.selectionEnd = from + token.length
    state.chatDraft = el.value
  }
  const picked = state.chatMentions || []
  if (!picked.some((m) => m.id === id)) state.chatMentions = picked.concat(one)
  closeMentionPick()
  paintChatMentions()
  el?.focus()
}

/* ── 斜杠命令 ─────────────────────────────────────────────────────────
 *
 * 一条命令 = **人对这条会话下的一次控制指令，不是发给模型的一句话**。它不进
 * `user/message`、不占 token、不开新的一轮，模型看不见它；走各自的 runtime 接口，
 * 落各自的会话事件，界面上画成一条分割线（见 docs/chat-commands.md）。
 *
 * 命令表是**本地常量，不走接口**：这两条是界面对席位发起的两次调用，不是席位提供的
 * 能力清单，为它多一跳只会让第一屏更慢。认命令的规则（parseCommand 那几个）在 core。
 */
const CHAT_COMMANDS = [
  {
    name: 'compact',
    title: '压缩上下文',
    // 「会调用一次模型」要写出来：点一下是要花钱的，虽然不值得为它弹一个确认框。
    hint: '把更早的对话换成摘要，会调用一次模型',
    /** 这一轮在跑时能不能点。两条都不行，理由见 docs/chat-commands.md。 */
    idleOnly: true,
    run: (sessionId) => api('POST', '/runtime/sessions/' + encodeURIComponent(sessionId) + '/compact'),
  },
  {
    name: 'new',
    title: '开始新对话',
    hint: '从这里起不再带上前面的内容，记录不删',
    idleOnly: true,
    run: (sessionId) => api('POST', '/runtime/sessions/' + encodeURIComponent(sessionId) + '/reset'),
  },
  {
    name: 'clear',
    title: '清空对话记录',
    // 和 /new 的区别要一句话说清：它连界面上的记录也一并拿掉，往上翻也没有了。
    hint: '清掉这条对话的全部记录和上下文，往上翻也看不到了',
    idleOnly: true,
    /** 点了就回不来（界面上），先问一句。见 runChatCommand。 */
    confirm: '清空和这个 Bot 的全部对话记录？清空后往上翻也看不到了，Bot 也不再记得之前的内容。',
    run: (sessionId) => api('POST', '/runtime/sessions/' + encodeURIComponent(sessionId) + '/clear'),
  },
  {
    name: 'model',
    title: '切换模型',
    // 跑着的时候也能换：那一轮的模型换不了，从下一轮起生效（席位那头就是这么收的）。
    hint: '换这条对话用的日常模型，下一轮起生效',
    idleOnly: false,
    /** 唯一一条收参数的：`/model 2`、`/model default`、`/model 模型名`。不带就打开选择器。 */
    args: true,
    run: (sessionId, arg) => modelCommand(sessionId, arg),
  },
]

/**
 * 输入框开头那条 `/xxx`。判据比 `@` 严一档：必须在最开头，而且后面只跟命令名（见 core/src/chat/commands.ts）。
 */
function commandQueryAt(el) {
  if (!el) return null
  return SatuCore.commandQueryAt(el.value, el.selectionStart ?? el.value.length)
}

function closeCmdPick() {
  if (!state.cmdPick) return
  state.cmdPick = null
  paintCmdPick()
}

function openCmdPick(q) {
  state.cmdPick = { open: true, q, index: 0 }
  paintCmdPick()
}

function cmdMatches(q) {
  return SatuCore.cmdMatches(q, CHAT_COMMANDS)
}

/** 命令选单。形状和 `@` 那个一样，共用 .sw-pickbox。 */
function paintCmdPick() {
  const box = document.getElementById('chat-cmdpick')
  if (!box) return
  const pick = state.cmdPick
  if (!pick) {
    box.hidden = true
    box.innerHTML = ''
    return
  }
  const list = cmdMatches(pick.q)
  if (!list.length) {
    box.hidden = true
    box.innerHTML = ''
    return
  }
  // 这一轮在跑时不能执行——**先标灰，别让人撞一次 409 才知道**。
  // 判据用 state.chatStatus：它是 paintChat 每帧算出来的那一份，`sending`（刚发出去、
  // 还没等到回执）也算在内——那时候一轮马上就要开始，压缩同样不该插进去。
  const busy = Boolean(state.chatStatus)
  const i = Math.min(pick.index || 0, list.length - 1)
  box.hidden = false
  box.setAttribute('data-busy', String(busy))
  /**
   * 这一轮在跑时，要等它跑完的那几条（/clear、/new、/compact）**不再灰掉**：点了就先停下这一轮、
   * 等它收口再执行（runChatCommand）。原来是灰的、点了没反应，手机上又没有回车去触发那句解释，
   * 人看到的就是「命令用不了」。
   */
  box.innerHTML = list
    .map((c, n) => {
      const first = busy && c.idleOnly
      return `<button type="button" class="sw-pick${n === i ? ' is-on' : ''}"
        data-act="chat-cmd-pick" data-name="${esc(c.name)}">
        <span class="sw-pick-name">/${esc(c.name)} · ${esc(t(c.title))}</span>
        <small>${esc(first ? t('会先停下正在跑的这一轮', 'Stops the running turn first') : t(c.hint))}</small>
      </button>`
    })
    .join('')
}

/** 从选单里选中一条：直接执行。命令没有「填进输入框再确认」这一步。 */
function takeCommand(name) {
  const one = CHAT_COMMANDS.find((c) => c.name === name)
  if (!one) return
  return runChatCommand(one)
}

/**
 * 这条草稿是不是一条命令：命中一条、`{ unknown }`（打了斜杠但不认识）、null（不是命令）。
 * 判法在 core/src/chat/commands.ts；表是这里的 CHAT_COMMANDS（每条带着自己的 run）。
 */
function parseCommand(text) {
  return SatuCore.parseCommand(text, CHAT_COMMANDS)
}

/**
 * 执行一条命令。
 *
 * 成功了**不清输入框以外的东西**：附件和 `@` 留在原地（命令不带它们，人多半是打完
 * 命令还要接着发那条消息）。结果由 SSE 推回来的那条事件画成分割线，这里只负责把
 * 「点了没反应」变成一句话。
 */
async function runChatCommand(cmd, arg = '') {
  const sessionId = state.chatSessionId
  if (!sessionId) {
    flash('err', t('还没接上席位，等接上再试'))
    render()
    return
  }
  /**
   * 唯一要先问一句的是 `/clear`：别的几条点错了都有退路（压缩后翻得到原文、/new 之后
   * 往上翻还在、换模型再换回来），它点完界面上就回不来了。**问在停之前**：人点了取消，正在跑的
   * 那一轮也不该被停掉。
   */
  if (cmd.confirm && !confirm(t(cmd.confirm))) return
  /**
   * 这一轮还在跑：先停下它、等它收口，再执行。原来是一句「等它跑完再试」就回去了——手机上没有
   * 回车去触发这句话，选单里那几项又是灰的，人看到的就是「命令用不了」。等收口最多 20 秒，
   * 停不下来才如实说。
   */
  if (cmd.idleOnly && state.chatStatus) {
    flash('ok', t(`先停下正在跑的这一轮，再执行 /${cmd.name}…`, `Stopping the running turn before /${cmd.name}…`))
    render()
    await abortChat()
    const until = Date.now() + 20_000
    // state.chatStatus 说的是**当前开着的那条**。等的这几秒里人切去了别的 Bot，它就不再是这条的状态：
    // 切到空闲的会立刻放行、对旧会话发命令（那一轮还没停，409，命令还进了新 Bot 的输入框），切到
    // 在跑的会白等二十秒。人走了就不执行，说一声。
    const here = () => state.chatSessionId === sessionId
    while (here() && state.chatStatus && Date.now() < until) await new Promise((r) => setTimeout(r, 300))
    if (!here()) {
      flash('err', t(`切到了别的对话，/${cmd.name} 没有执行`, `Switched to another conversation; /${cmd.name} was not run`))
      render()
      return
    }
    if (state.chatStatus) {
      flash('err', t('这一轮没停下来，等它停了再试', 'The turn did not stop; try again once it has'))
      render()
      return
    }
  }
  // 失败要把命令还回去（下面的 catch）。清空之前先留一份——同 sendChat 那条约定：
  // 一次 409 / 换版 404 不该让人重新把命令打一遍。
  const draft = state.chatDraft || '/' + cmd.name
  // 命令占满整条消息，走到这儿正文就该清掉了——它不会被发出去，留着只会让人再按一次。
  state.chatDraft = ''
  closeCmdPick()
  const input = document.getElementById('chat-input')
  if (input) {
    input.value = ''
    input.style.height = ''
  }
  state.chatCmdBusy = cmd.name
  paintChat()
  try {
    const r = await cmd.run(sessionId, arg)
    if (r && r.modelSwitched) {
      flash('ok', r.modelSwitched)
    } else if (r && r.compacted) {
      flash('ok', t('已压缩') + '：' + ctxNum(r.tokensBefore) + ' → ' + ctxNum(r.tokensAfter))
    } else if (r && r.reset) {
      flash('ok', t('已开始新对话，上面的内容不再进上下文'))
    } else if (r && r.cleared) {
      /**
       * 「加载更早的对话」那颗按钮要当场收起：清除点之前的席位已经不给了，留着它点下去
       * 只会取回一页空的。清除点那条事件由 SSE 推回来，fold 认得它、把之前画的全扔掉。
       */
      chatPages.set(sessionId, { firstSeq: r.throughSeq + 1, hasMore: false, loading: false })
      flash('ok', t('对话记录已清空'))
    }
    /**
     * **不在这里自己画那条线。** 席位紧接着会经 SSE 把 `session/compact` /
     * `session/reset` 推过来，fold 认得它。自己先垫一条的话，等真事件到了就是两条。
     *
     * 老席位不认这两条路：404 落到下面的 catch，翻成「版本还不支持」。
     */
  } catch (err) {
    // **把命令还回输入框。** 换版期间的 404、正跑着的 409、断线——这些都是过几秒
    // 再按一次就好的事，没道理让人重打一遍（finally 里的 render 会把它填回去）。
    // 人已经切去了别的对话就不还：那是另一颗 Bot 的输入框。
    if (state.chatSessionId === sessionId) state.chatDraft = draft
    // 席位那边每一种拒绝都带着一句能直接给人看的原话（正在跑、太短、排着队），
    // 原样显示，别翻成一句「操作失败」。
    flash('err', err.status === 404 ? t('这台席位的版本还不支持这条命令，升级后可用') : err.message)
  } finally {
    state.chatCmdBusy = ''
    paintChat()
    render()
  }
}

/** 取消一条排队的消息。已经开跑的席位回 409——那时如实说，不装作取消成功。 */
async function cancelQueued(id) {
  const sessionId = state.chatSessionId
  if (!sessionId) return
  try {
    await api('DELETE', `/runtime/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(id)}`)
    chatQueues.set(sessionId, (chatQueues.get(sessionId) || []).filter((r) => r.id !== id))
    paintChatQueue()
  } catch (err) {
    // 409 = 这一刻它正好被取出开跑了。把它从 dock 上撤下来——它已经不在队里了，
    // 接下来会以正常消息的样子从 SSE 上过来。
    chatQueues.set(sessionId, (chatQueues.get(sessionId) || []).filter((r) => r.id !== id))
    paintChatQueue()
    flash('err', err.status === 409 ? t('这条已经开始执行了') : err.message)
    render()
  }
}
