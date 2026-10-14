/* ══ 对话里的查找（docs/chat-search.md）══════════════════════════════════
   顶栏一颗放大镜，点开是一条浮在消息流右上角的查找条——像浏览器的页内查找，不是另开
   一屏列表：人要找的是「那次说到报价是在哪儿」，找到就该站在那条消息上接着看上下文，
   而不是在另一栏里读一段摘录。

   **匹配在席位上做**（`GET /runtime/sessions/:id/search`，bot 的 session/search.ts）。
   浏览器手上只有最近几轮，更早的要翻才有；而几个月的长会话翻到头要几百页。席位有
   整份 JSONL，一次回全部命中的 seq，这边只负责按 seq 跳过去（jumpToMessage 会把中间
   的页一页页补上）。

   命中分两种，并在同一条跳转序列里：**正文**命中（用户说的、助手答的）和**文件**命中
   （上传的附件、Bot 产出的文件，按文件名）。文件命中跳到带着那个文件的那条消息，查找
   条上列出文件名，点一下开预览。

   顺序是**新的在前**：翻记录十有八九是找最近那次。Enter / ↑ 往更早走，Shift+Enter / ↓
   往更新走，到头回绕。
   ══════════════════════════════════════════════════════════════════════ */

/** 一次最多要多少条命中。再往前翻时按 nextBefore 续。 */
const FIND_LIMIT = 100
/** 打字停多久才发请求。每个字一发的话，一句话就是十来次整条会话的扫描。 */
const FIND_DEBOUNCE_MS = 250
/** 跳一条消息最多往前补多少页历史（每页 CHAT_TAIL_TURNS 轮）。引用卡那条路只给 5 页，
    查找的命中常常就在几百轮之前，不给够的话查到了也跳不过去。 */
const FIND_PAGES_MAX = 400
/** 命中词高亮一次最多标多少处。再多标下去主线程会卡，而人也不会去数。 */
const FIND_MARKS_MAX = 4000

const ICON_FIND = ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'm21 21-4.3-4.3']
const ICON_FIND_UP = ['m18 15-6-6-6 6']
const ICON_FIND_DOWN = ['m6 9 6 6 6-6']

function blankFind() {
  return {
    open: false,
    q: '',
    /** 命中属于哪条会话。换了 Bot 就作废（见 paintChatFind）。 */
    sessionId: '',
    terms: [],
    /** 统一后的命中：`[{ anchor, seq, role, time, snippet, files }]`，新的在前。 */
    hits: [],
    index: -1,
    /** 正文命中的总数（席位给的，不受分页影响）。 */
    total: 0,
    hasMore: false,
    nextBefore: null,
    /** 已经取到的正文命中里最早那条的 anchor。文件命中比它更早的，排在它后面但还没「翻到」。 */
    textFloor: Infinity,
    loading: false,
    error: '',
    /** 请求序号：慢的那次回来时人已经又打了几个字，结果不作数。 */
    req: 0,
  }
}

function chatFind() {
  if (!state.chatFind) state.chatFind = blankFind()
  return state.chatFind
}

/** 顶栏那颗放大镜（chatHeadInline 里摆）。 */
function findToggleHtml() {
  const open = Boolean(chatFind().open)
  const label = t('在对话里查找', 'Find in conversation')
  return `<button type="button" class="btn btn-ghost btn-icon sw-find-toggle" data-act="chat-find-toggle"
    aria-pressed="${open}" aria-label="${esc(label)}" title="${esc(label)} (${isMacLike() ? '⌘' : 'Ctrl+'}F)">${svg(ICON_FIND, 16)}</button>`
}

function isMacLike() {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')
}

/**
 * 查找条本身（chatPage 里摆在消息流上面）。**内容由 paintChatFind 就地填**：输入框里
 * 的字、计数、提示行每敲一个键都在变，走整页重绘的话输入框会丢焦点。
 */
function chatFindHtml() {
  const f = chatFind()
  return `<div class="sw-find" id="chat-find" role="search" ${f.open ? '' : 'hidden'}>
    <div class="sw-find-row">
      <span class="sw-find-icon" aria-hidden="true">${svg(ICON_FIND, 14)}</span>
      <input type="search" id="chat-find-input" class="sw-find-input" value="${esc(f.q || '')}"
        placeholder="${esc(t('查找消息和文件', 'Find messages and files'))}" autocomplete="off" spellcheck="false"
        aria-label="${esc(t('在对话里查找', 'Find in conversation'))}">
      <span class="sw-find-count" id="chat-find-count" aria-live="polite"></span>
      <button type="button" class="btn btn-ghost btn-icon sw-find-nav" data-act="chat-find-prev"
        aria-label="${esc(t('上一个（更早）', 'Previous (older)'))}" title="${esc(t('上一个（更早）', 'Previous (older)'))} (Enter)">${svg(ICON_FIND_UP, 15)}</button>
      <button type="button" class="btn btn-ghost btn-icon sw-find-nav" data-act="chat-find-next"
        aria-label="${esc(t('下一个（更新）', 'Next (newer)'))}" title="${esc(t('下一个（更新）', 'Next (newer)'))} (Shift+Enter)">${svg(ICON_FIND_DOWN, 15)}</button>
      <button type="button" class="btn btn-ghost btn-icon sw-find-close" data-act="chat-find-close"
        aria-label="${esc(t('关闭查找', 'Close find'))}" title="${esc(t('关闭查找', 'Close find'))} (Esc)">${ICON_X}</button>
    </div>
    <div class="sw-find-hint" id="chat-find-hint" hidden></div>
  </div>`
}

/** 把正文里命中的词包成 <mark>。先切段再转义，别对转义后的串做匹配。 */
function markTerms(text, terms) {
  const src = String(text || '')
  const lower = src.toLowerCase()
  if (lower.length !== src.length || !terms.length) return esc(src)
  const spans = []
  for (const term of terms) {
    if (!term) continue
    let i = lower.indexOf(term)
    while (i >= 0) {
      spans.push([i, i + term.length])
      i = lower.indexOf(term, i + term.length)
    }
  }
  if (!spans.length) return esc(src)
  spans.sort((a, b) => a[0] - b[0])
  let out = ''
  let at = 0
  for (const [s, e] of spans) {
    if (e <= at) continue
    const start = Math.max(s, at)
    out += esc(src.slice(at, start)) + '<mark>' + esc(src.slice(start, e)) + '</mark>'
    at = e
  }
  return out + esc(src.slice(at))
}

/**
 * 席位回来的一份结果 → 统一的命中序列。正文命中和文件命中按**消息**合并：同一条消息
 * 既有字命中又带着命中的文件，是一站，不是两站。
 */
function mergeFindHits(res, prev) {
  const byAnchor = new Map()
  for (const h of prev || []) byAnchor.set(h.anchor, h)
  for (const h of (res && res.hits) || []) {
    const anchor = Number(h.anchor)
    if (!Number.isFinite(anchor)) continue
    const cur = byAnchor.get(anchor)
    if (cur) {
      if (!cur.snippet) cur.snippet = h.snippet || ''
      cur.seq = Number(h.seq) || cur.seq
    } else {
      byAnchor.set(anchor, { anchor, seq: Number(h.seq) || anchor, role: h.role, time: h.time, snippet: h.snippet || '', files: [] })
    }
  }
  for (const file of (res && res.files) || []) {
    const anchor = Number(file.anchor)
    if (!Number.isFinite(anchor) || !file.path) continue
    let cur = byAnchor.get(anchor)
    if (!cur) {
      cur = { anchor, seq: anchor, role: file.role, time: file.time, snippet: '', files: [] }
      byAnchor.set(anchor, cur)
    }
    if (!cur.files.some((x) => x.path === file.path)) cur.files.push({ path: file.path, name: file.name || file.path })
  }
  return [...byAnchor.values()].sort((a, b) => b.anchor - a.anchor)
}

/** 查找条上那行计数和提示。 */
function paintChatFind() {
  const f = chatFind()
  // 换了会话：上一条会话的命中跳不过去，整份作废；条开着就留着让人重搜。
  if (f.sessionId && f.sessionId !== state.chatSessionId) {
    const keepOpen = f.open
    const q = f.q
    state.chatFind = { ...blankFind(), open: keepOpen, q }
    return paintChatFind()
  }
  const box = document.getElementById('chat-find')
  const toggle = document.querySelector('.sw-find-toggle')
  if (toggle) toggle.setAttribute('aria-pressed', String(Boolean(f.open)))
  if (!box) return
  box.hidden = !f.open
  const count = document.getElementById('chat-find-count')
  const hint = document.getElementById('chat-find-hint')
  const navs = box.querySelectorAll('.sw-find-nav')
  const hasHits = f.hits.length > 0
  for (const b of navs) b.disabled = !hasHits
  if (count) {
    count.textContent = !f.q.trim()
      ? ''
      : f.loading && !hasHits
        ? '…'
        : hasHits
          ? `${f.index + 1} / ${f.hits.length}${f.hasMore ? '+' : ''}`
          : t('0 / 0')
    count.setAttribute('data-empty', String(Boolean(f.q.trim()) && !f.loading && !hasHits && !f.error))
  }
  if (hint) {
    const cur = hasHits ? f.hits[f.index] : null
    if (f.error) {
      hint.hidden = false
      hint.innerHTML = `<span class="sw-find-err">${esc(f.error)}</span>`
    } else if (cur) {
      const who = cur.role === 'user' ? t('你', 'You') : t('Bot')
      const when = cur.time ? `${chatDayLabel(cur.time)} ${chatClock(cur.time)}` : ''
      const files = (cur.files || [])
        .map(
          (x) =>
            `<button type="button" class="sw-chip sw-filechip sw-find-file" data-act="chat-preview" data-path="${esc(x.path)}" data-name="${esc(x.name)}" title="${esc(x.path)}">${ICON_CLIP}<span>${markTerms(x.name, f.terms)}</span></button>`,
        )
        .join('')
      hint.hidden = false
      hint.innerHTML =
        `<span class="sw-find-who">${esc(who)}</span><span class="sw-find-when">${esc(when)}</span>` +
        (cur.snippet ? `<span class="sw-find-snip">${markTerms(cur.snippet, f.terms)}</span>` : '') +
        (files ? `<span class="sw-find-files">${files}</span>` : '')
    } else if (f.q.trim() && !f.loading) {
      hint.hidden = false
      hint.textContent = t('这条对话里没有找到。', 'Nothing in this conversation matches.')
    } else {
      hint.hidden = true
      hint.innerHTML = ''
    }
  }
  scheduleFindMarks()
}

function openChatFind() {
  const f = chatFind()
  if (!state.chatSessionId) return
  f.open = true
  paintChatFind()
  const input = document.getElementById('chat-find-input')
  if (input) {
    input.focus()
    input.select()
  }
}

function closeChatFind() {
  const f = chatFind()
  const wasOpen = f.open
  f.open = false
  clearTimeout(findTimer)
  paintChatFind()
  clearFindMarks()
  if (wasOpen) {
    const input = document.getElementById('chat-input')
    if (input) input.focus()
  }
}

function toggleChatFind() {
  if (chatFind().open) closeChatFind()
  else openChatFind()
}

let findTimer = 0

/** 输入框每一下都到这儿；真正发请求的是 FIND_DEBOUNCE_MS 之后那一次。 */
function onChatFindInput(value) {
  const f = chatFind()
  f.q = String(value || '')
  clearTimeout(findTimer)
  if (!f.q.trim()) {
    f.req++
    f.hits = []
    f.index = -1
    f.terms = []
    f.total = 0
    f.hasMore = false
    f.nextBefore = null
    f.textFloor = Infinity
    f.loading = false
    f.error = ''
    clearFindCurrent()
    paintChatFind()
    return
  }
  f.loading = true
  paintChatFind()
  findTimer = setTimeout(() => void runChatFind(), FIND_DEBOUNCE_MS)
}

/**
 * 发一次查找。`more` 是「接着往前翻」：带上 nextBefore，结果并进已有的那份，人正站着
 * 的那条不动。
 */
async function runChatFind(opts = {}) {
  const f = chatFind()
  const sessionId = state.chatSessionId
  const q = f.q.trim()
  if (!sessionId || !q) return
  const more = Boolean(opts.more)
  if (more && (!f.hasMore || !f.nextBefore)) return
  const req = ++f.req
  f.loading = true
  f.error = ''
  f.sessionId = sessionId
  paintChatFind()
  let res
  try {
    const qs = `q=${encodeURIComponent(q)}&limit=${FIND_LIMIT}${more ? `&before=${encodeURIComponent(f.nextBefore)}` : ''}`
    res = await api('GET', `/runtime/sessions/${encodeURIComponent(sessionId)}/search?${qs}`)
  } catch (err) {
    if (req !== f.req || sessionId !== state.chatSessionId) return
    f.loading = false
    f.error = String((err && err.message) || err || t('查找失败', 'Search failed'))
    paintChatFind()
    return
  }
  if (req !== f.req || sessionId !== state.chatSessionId) return
  const prevAnchor = more && f.index >= 0 && f.hits[f.index] ? f.hits[f.index].anchor : null
  f.loading = false
  f.terms = Array.isArray(res.terms) ? res.terms : []
  // 续页时文件早在第一页就全给了（席位不分页文件），再并一遍只会重复。
  f.hits = mergeFindHits(more ? { hits: res.hits } : res, more ? f.hits : [])
  f.total = Number(res.total) || 0
  f.hasMore = Boolean(res.hasMore)
  f.nextBefore = res.nextBefore || null
  const texts = (res.hits || []).map((h) => Number(h.anchor)).filter(Number.isFinite)
  const floor = texts.length ? Math.min(...texts) : more ? f.textFloor : Infinity
  f.textFloor = f.hasMore ? floor : 0
  if (!f.hits.length) {
    f.index = -1
    clearFindCurrent()
    paintChatFind()
    return
  }
  if (more) {
    f.index = Math.max(0, f.hits.findIndex((h) => h.anchor === prevAnchor))
    paintChatFind()
    return
  }
  // 新搜一次：直接站到最近那条命中上，像浏览器的查找一样，不用再按一下。
  await gotoFindHit(0)
}

/** 站到第 i 条命中上：滚过去、亮一下、把它标成当前。 */
async function gotoFindHit(i) {
  const f = chatFind()
  if (i < 0 || i >= f.hits.length) return
  f.index = i
  paintChatFind()
  const hit = f.hits[i]
  const found = await jumpToMessage(hit.anchor, { pages: FIND_PAGES_MAX })
  if (f.index !== i) return
  clearFindCurrent()
  if (found) {
    const node = document.querySelector(`#chat-thread .sw-msg[data-seq="${esc(String(hit.anchor))}"]`)
    if (node) node.setAttribute('data-find', '1')
  }
  scheduleFindMarks()
}

function clearFindCurrent() {
  for (const node of document.querySelectorAll('#chat-thread .sw-msg[data-find]')) node.removeAttribute('data-find')
}

/**
 * 往前（更早，dir=1）或往后（更新，dir=-1）走一站。到头回绕。
 *
 * 往前走时要留意**还没取回来的那一段**：文件命中是一次全给的，可能比已取的正文命中
 * 还早；走到正文命中的尽头（textFloor）而席位说还有更多，先续一页再走，不然会跳过
 * 中间那些正文命中、直接落到更早的文件上。
 */
async function findStep(dir) {
  const f = chatFind()
  if (!f.hits.length || f.loading) return
  const cur = f.hits[f.index] || f.hits[0]
  if (dir > 0) {
    const next = f.hits[f.index + 1]
    if (f.hasMore && (!next || next.anchor < f.textFloor)) {
      await runChatFind({ more: true })
      const j = f.hits.findIndex((h) => h.anchor < cur.anchor)
      if (j >= 0) return gotoFindHit(j)
    }
    return gotoFindHit(next ? f.index + 1 : 0)
  }
  return gotoFindHit(f.index <= 0 ? f.hits.length - 1 : f.index - 1)
}

/* ── 命中词高亮 ───────────────────────────────────────────────────────────
   用 CSS Custom Highlight API（`CSS.highlights`）给消息流里每一处命中的词上底色：它只
   画不改 DOM——消息正文是 markdown.js 增量渲染的，往里插 <mark> 会让它认不出自己画过
   的块、下一帧全部重画。不支持这套 API 的浏览器就只有「当前那条亮一圈」。 */

let findMarksTimer = 0

function scheduleFindMarks() {
  clearTimeout(findMarksTimer)
  findMarksTimer = setTimeout(syncFindMarks, 120)
}

function clearFindMarks() {
  clearTimeout(findMarksTimer)
  try {
    if (typeof CSS !== 'undefined' && CSS.highlights) CSS.highlights.delete('satu-find')
  } catch {}
}

function syncFindMarks() {
  if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight !== 'function') return
  const f = chatFind()
  const thread = document.getElementById('chat-thread')
  if (!f.open || !f.terms.length || !thread) {
    clearFindMarks()
    return
  }
  const ranges = []
  const walker = document.createTreeWalker(thread, NodeFilter.SHOW_TEXT)
  let node
  while ((node = walker.nextNode()) && ranges.length < FIND_MARKS_MAX) {
    const text = node.nodeValue
    if (!text || !text.trim()) continue
    const lower = text.toLowerCase()
    // 大小写折叠会改长度的那几种字符（土耳其语的 İ 之类），偏移对不上，跳过这一段。
    if (lower.length !== text.length) continue
    for (const term of f.terms) {
      let i = lower.indexOf(term)
      while (i >= 0 && ranges.length < FIND_MARKS_MAX) {
        const r = new Range()
        r.setStart(node, i)
        r.setEnd(node, i + term.length)
        ranges.push(r)
        i = lower.indexOf(term, i + term.length)
      }
    }
  }
  try {
    CSS.highlights.set('satu-find', new Highlight(...ranges))
  } catch {}
}

/* ── 事件 ─────────────────────────────────────────────────────────────────
   都挂在 document 上：查找条跟着整页重绘换节点，挂在元素上得每次重挂。 */

document.addEventListener('input', (e) => {
  const el = e.target
  if (!(el instanceof Element) || el.id !== 'chat-find-input') return
  onChatFindInput(el.value)
})

document.addEventListener('keydown', (e) => {
  const el = e.target
  const inFind = el instanceof Element && el.id === 'chat-find-input'
  if (inFind) {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.isComposing) return
      void findStep(e.shiftKey ? -1 : 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      void findStep(1)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      void findStep(-1)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeChatFind()
    }
    return
  }
  // ⌘F / Ctrl+F：对话页上接管成对话内查找。浏览器自带的那条只搜已经画出来的几轮。
  if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'f' || e.key === 'F') && onChatPage() && state.chatSessionId) {
    if (e.defaultPrevented) return
    e.preventDefault()
    openChatFind()
  }
})

document.getElementById('app').addEventListener('click', (e) => {
  const el = e.target instanceof Element ? e.target : e.target.parentElement
  const btn = el && el.closest('[data-act^="chat-find-"]')
  if (!btn) return
  const act = btn.getAttribute('data-act')
  if (act === 'chat-find-toggle') toggleChatFind()
  else if (act === 'chat-find-close') closeChatFind()
  else if (act === 'chat-find-prev') void findStep(1)
  else if (act === 'chat-find-next') void findStep(-1)
})
