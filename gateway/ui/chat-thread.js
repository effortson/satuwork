/** 整条消息流：长按菜单、逐行增量更新、时钟、往上翻更早的、threadRows / syncThread / paintChat。原先在 chat.js 里，拆出来只是搬家（顺序见 index.html）。 */
/* ── 触屏：长按消息弹菜单 ────────────────────────────────────────────────
   触屏没有悬停，气泡外侧那排动作只能常显，挂在每条消息边上是噪音（chat.css 在 hover:none 下把它藏了）。
   改成长按一条消息约半秒，弹一个小菜单：能引用的给「引用」，都给「复制」「选字」。长按本来会触发系统选字，
   chat.css 把它关了，「复制」顶整条、「选字」把这一条放回系统选字（只要一段、一行代码时用）。
   链接、图片、代码、输入框不归长按菜单：长按照旧是系统的（复制链接、存图、选一段代码），确认卡里
   的输入框照旧能选字、能编辑。 */

/** 长按菜单不接管的那些：交给系统的长按（复制链接、存图、选字、编辑）。 */
const PRESS_NATIVE = 'a, img, pre, code, input, textarea, select, [contenteditable="true"], .sw-approvals, .sw-handoffs'

const LONGPRESS_MS = 480
let pressTimer = null
let pressAt = null

function closeMsgMenu() {
  const box = document.getElementById('sw-msgmenu')
  if (box) box.remove()
}

function openMsgMenu(row, x, y) {
  closeMsgMenu()
  const seq = row.getAttribute('data-seq')
  const md = row.querySelector('.sw-bubble .sw-md')
  const items = []
  if (seq) items.push(`<button type="button" class="sw-msgmenu-item" data-act="chat-ref-msg" data-seq="${esc(seq)}">${ICON_QUOTE}<span>${esc(t('引用', 'Quote'))}</span></button>`)
  if (md && md.innerText.trim()) {
    items.push(`<button type="button" class="sw-msgmenu-item" data-act="msg-copy" data-key="${esc(row.getAttribute('data-key') || '')}">${svg(['M9 9h10v12H9z', 'M5 15V3h10'], 15)}<span>${esc(t('复制', 'Copy'))}</span></button>`)
    items.push(`<button type="button" class="sw-msgmenu-item" data-act="msg-select" data-key="${esc(row.getAttribute('data-key') || '')}">${svg(['M4 7V4h3', 'M20 7V4h-3', 'M4 17v3h3', 'M20 17v3h-3', 'M9 12h6'], 15)}<span>${esc(t('选字', 'Select'))}</span></button>`)
  }
  if (!items.length) return
  const box = document.createElement('div')
  box.id = 'sw-msgmenu'
  box.className = 'sw-msgmenu'
  box.setAttribute('role', 'menu')
  box.innerHTML = items.join('')
  // 挂在 #app 里：页面的点击分发（app.js）只听 #app，挂到 body 上菜单就点不动。
  ;(document.getElementById('app') || document.body).appendChild(box)
  // 摆在手指上方一点；挨着屏幕边就往里收，不让菜单出屏。
  const w = box.offsetWidth
  const h = box.offsetHeight
  const left = Math.max(8, Math.min(x - w / 2, innerWidth - w - 8))
  const top = y - h - 14 < 8 ? y + 14 : y - h - 14
  box.style.left = `${left}px`
  box.style.top = `${Math.min(top, innerHeight - h - 8)}px`
  row.setAttribute('data-pressed', '1')
  setTimeout(() => row.removeAttribute('data-pressed'), 300)
  if (navigator.vibrate) navigator.vibrate(10)
}

/** 「选字」打开的那一条：这一条放回系统选字，点到别处就收回。 */
function selectMsgText(key) {
  for (const el of document.querySelectorAll('#chat-thread .sw-msg[data-selecting]')) el.removeAttribute('data-selecting')
  const row = key ? document.querySelector(`#chat-thread .sw-msg[data-key="${CSS.escape(key)}"]`) : null
  if (row) row.setAttribute('data-selecting', '1')
}

document.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return
  if (e.target instanceof Element && e.target.closest('#sw-msgmenu')) return
  closeMsgMenu()
  const row = e.target instanceof Element ? e.target.closest('#chat-thread .sw-msg[data-key]') : null
  // 点到别的地方：上一条「选字」收回来。
  for (const el of document.querySelectorAll('#chat-thread .sw-msg[data-selecting]')) if (el !== row) el.removeAttribute('data-selecting')
  // 正在选字的那一条、气泡里的按钮、药丸，以及交给系统长按的那些（PRESS_NATIVE），都不抢。
  if (!row || row.hasAttribute('data-selecting')) return
  if (e.target instanceof Element && e.target.closest(`button, .sw-chip, .sw-filechip, ${PRESS_NATIVE}`)) return
  pressAt = { x: e.clientX, y: e.clientY }
  clearTimeout(pressTimer)
  pressTimer = setTimeout(() => {
    pressTimer = null
    openMsgMenu(row, pressAt.x, pressAt.y)
  }, LONGPRESS_MS)
})
const cancelPress = () => {
  clearTimeout(pressTimer)
  pressTimer = null
}
document.addEventListener('pointermove', (e) => {
  // 手指挪了就是在滚，不是长按。
  if (pressTimer && pressAt && Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) > 10) cancelPress()
})
document.addEventListener('pointerup', cancelPress)
document.addEventListener('pointercancel', cancelPress)
// 系统的长按菜单（iOS 的「拷贝 / 查询」、安卓的上下文菜单）不要冒出来和我们的打架。
document.addEventListener('contextmenu', (e) => {
  if (!(e.target instanceof Element) || !matchMedia('(hover: none)').matches) return
  const row = e.target.closest('#chat-thread .sw-msg')
  // 链接、图片、代码、输入框，和正在选字的那一条：系统的长按菜单照旧出来。
  if (!row || row.hasAttribute('data-selecting') || e.target.closest(PRESS_NATIVE)) return
  e.preventDefault()
})
document.addEventListener('scroll', closeMsgMenu, true)

/** 长按菜单里的「复制」：复制这条消息渲染出来的正文。 */
async function copyMsgText(key) {
  const row = key ? document.querySelector(`#chat-thread .sw-msg[data-key="${CSS.escape(key)}"]`) : null
  const md = row && row.querySelector('.sw-bubble .sw-md')
  const ok = md ? await copyText(md.innerText.trim()) : false
  flash(ok ? 'ok' : 'err', ok ? t('已复制', 'Copied') : t('复制失败，浏览器不允许', 'Copy failed'))
}

/**
 * 把 host 的子节点对齐到 text 渲染出的 Markdown 块。
 *
 * 每个子节点记着自己那一块的**源文本**（data-sig）。源文本没变就整块跳过——节点原地
 * 保留，里面已经渲染好的 KaTeX、高亮、mermaid 图跟着一起留下。流式输出下只有最后一块
 * 在变，所以每帧真正重画的就那一块。
 */
function syncMd(host, text, streaming) {
  const md = window.satuMd
  if (!md) {
    host.textContent = String(text || '')
    return
  }
  // healStream 看的是整段正文的末尾，所以要先补齐再切块，不能切完逐块补。
  const src = streaming ? md.healStream(text) : String(text == null ? '' : text)
  const parts = src.trim() ? md.splitBlocks(src) : []
  const kids = host.children
  for (let i = 0; i < parts.length; i++) {
    const cur = kids[i]
    if (cur && cur.getAttribute('data-sig') === parts[i]) continue
    const box = document.createElement('div')
    box.className = 'sw-mdblock'
    box.setAttribute('data-sig', parts[i])
    box.innerHTML = md.render(parts[i])
    if (cur) host.replaceChild(box, cur)
    else host.appendChild(box)
  }
  while (kids.length > parts.length) host.removeChild(kids[kids.length - 1])
}

/**
 * 正文 + 工具条就地更新。streaming 指「这条还在写」，只有最后一条会是 true。
 * `since` 是这一轮开始的时刻（fold 的 statusAt），读秒从它起算。
 */
function updateRow(el, b, streaming, since) {
  // 先画的是通用图标（名单那会儿还没到）：名单到了就换成这颗 Bot 自己的头像。
  if (b.taskFrom) {
    updateTaskIn(el, b)
    // 卡片本身不是在流式输出的那条：指令早就写全了，跑着的那一轮在它下面（或者折在它里面）。
    streaming = false
  } else if (b.kind !== 'user') {
    const av = el.querySelector(':scope > .sw-msg-avatar')
    if (av && !av.hasAttribute('data-bot')) {
      const mine = assistantAvatar()
      if (mine.own) {
        av.innerHTML = mine.html
        av.setAttribute('data-bot', '1')
      }
    }
  }
  /**
   * 头像会不会动。**这一行是「它还在干活」在屏幕上唯一常驻的信号。**
   *
   * 三点省略号只在**还没吐字**的那一段有（一开口就地变成正文），气泡下面的读秒是一行
   * 小灰字。可一轮真正花时间的活（读十几个网页、跑几条命令）恰恰是**已经写了几段字、
   * 后面还在接着跑**的那种——那时候屏幕上除了那个每秒 +1 的数字，没有任何东西在动，
   * 人分不出「它还在跑」和「它答完了就这样」。头像按角色播放运行动作，停下后回到静态。
   *
   * 属性变了才写：updateRow 每帧都跑，无条件 setAttribute 会让 CSS 动画从头开始，
   * 呼吸变成一顿一顿的抽搐。
   */
  const bot = chatBotOf()
  const working = Boolean(streaming) && b.kind === 'assistant' && (!bot || botIsWorking(bot, true))
  if (working !== (el.getAttribute('data-live') === '1')) {
    if (working) el.setAttribute('data-live', '1')
    else el.removeAttribute('data-live')
  }
  setBotAvatarRunning(el.querySelector(':scope > .sw-msg-avatar'), working)

  const bubble = el.querySelector('.sw-bubble')
  const md = bubble.querySelector('.sw-md')
  const chips = bubble.querySelector('.sw-chips')

  // 用户发的图：缩略图排在正文上面，点开走预览。没有这一段，人发完图只看得见
  // 自己那句话，图像是发进了黑洞。
  const shots = b.images || []
  let strip = bubble.querySelector('.sw-shots')
  const shotSig = shots.map((x) => x.path).join('|')
  if (shots.length && !strip) {
    strip = document.createElement('div')
    strip.className = 'sw-shots'
    bubble.insertBefore(strip, md)
  }
  if (strip && strip.getAttribute('data-sig') !== shotSig) {
    strip.setAttribute('data-sig', shotSig)
    strip.innerHTML = shots.map(shotHtml).join('')
    strip.hidden = !shots.length
    void fillShots(strip)
  }

  /**
   * 这条消息 `@` 了谁。画在正文**上面**，和输入框里那排是同一种药丸——发出去前后
   * 长得一样，人才认得出这就是刚才点的那个。
   *
   * 和附件缩略图一条路子：签名没变就不重画，否则流式那几帧会把它反复换掉。
   */
  /**
   * 这条消息引用了什么。画在气泡最顶上——它是这句话的前提（「按这条改」里的「这条」），
   * 要先于正文被看到。卡和输入框上那排是同一种（refCardHtml），发出去前后长得一样。
   */
  const refs = b.refs || []
  const refSig = refs.map((r) => (r.kind === 'file' ? 'f:' + r.path : 'm:' + r.seq + ':' + r.excerpt)).join('|')
  let refBox = bubble.querySelector('.sw-refs-in')
  if (refs.length && !refBox) {
    refBox = document.createElement('div')
    refBox.className = 'sw-refs-in'
    bubble.insertBefore(refBox, bubble.firstChild)
  }
  if (refBox && refBox.getAttribute('data-sig') !== refSig) {
    refBox.setAttribute('data-sig', refSig)
    refBox.innerHTML = refs.map((r) => refCardHtml(r, '')).join('')
    refBox.hidden = !refs.length
  }

  /**
   * 悬停动作（引用这条）：流式输出中和回执没回来的不给，理由见 rowShell。
   *
   * 壳是节点新建时画的，而一条看着它流式输出完的回复，那时候还没有 assistant/message——
   * 壳里就没有这排动作。所以这里要**补**：seq 到了、壳里还没有，就现画一个；seq 变了
   * （一轮里多条助手消息）也跟着改。
   */
  const qseq = quoteSeqOf(b)
  let acts = el.querySelector('.sw-msg-acts')
  if (qseq != null) {
    const want = String(qseq)
    if (el.getAttribute('data-seq') !== want) el.setAttribute('data-seq', want)
    if (!acts) {
      const col = el.querySelector('.sw-msg-col')
      const box = document.createElement('div')
      box.innerHTML = msgActsHtml(b)
      acts = box.firstElementChild
      if (col && acts) col.appendChild(acts)
    } else {
      const btn = acts.querySelector('[data-act="chat-ref-msg"]')
      if (btn && btn.getAttribute('data-seq') !== want) btn.setAttribute('data-seq', want)
    }
  }
  if (acts) acts.hidden = qseq == null || Boolean(streaming) || Boolean(b.pending)

  // 混排的点名（inline）就地画在正文里（见 inlineMentionPills），这一排只留老格式的那些。
  const ments = (b.mentions || []).filter((m) => !m.inline)
  const mentSig = ments.map((m) => m.label).join('|')
  let mentBox = bubble.querySelector('.sw-mentions-in')
  if (ments.length && !mentBox) {
    mentBox = document.createElement('div')
    mentBox.className = 'sw-mentions-in'
    // 引用卡在最顶上，点名那排排它后面。
    bubble.insertBefore(mentBox, refBox ? refBox.nextSibling : bubble.firstChild)
  }
  if (mentBox && mentBox.getAttribute('data-sig') !== mentSig) {
    mentBox.setAttribute('data-sig', mentSig)
    mentBox.innerHTML = ments.map((m) => `${mentionPill(m)}</span>`).join('')
    mentBox.hidden = !ments.length
  }

  const tools = b.tools || []
  // 产出文件 + 上传的附件。两边是同一种东西（工作区里一个能点开的文件），
  // 用同一种药丸，点开走同一个预览。
  const outs = outputFiles(tools).concat(b.files || [])
  // 正文里已经点了名的那些，就地换成药丸（见 inlineFileChips），底下那条就不再
  // 重复摆一遍——同一个文件在一条消息里出现两次是噪音，而且下面那颗离它被提到的
  // 那句话隔了好几行。
  const inlined = mentionedFiles(b.text, outs)

  if (!String(b.text || '').trim() && streaming) {
    // 还没吐字。给一个空气泡里的三点——它就地长成正文，位置不跳。
    if (!md.querySelector('.sw-typing')) md.innerHTML = '<span class="sw-typing"><i></i><i></i><i></i></span>'
  } else {
    if (md.querySelector('.sw-typing')) md.innerHTML = ''
    syncMd(md, b.text, streaming)
    decorateFiles(md, outs)
    // 人打的只认这条消息真点了名的；主 Bot 回复里写的「@客户经理」按名单和连接认（见 mentionCands）。
    if (b.kind === 'user') inlineMentionPills(md, (b.mentions || []).filter((m) => m.inline))
    else inlineMentionPills(md, mentionCands())
  }

  /**
   * 浏览器一步一张的过程截图，摆在正文底下、药丸上面。
   *
   * 为什么值得占这块地方：一次多步浏览在日志里只剩十几段 a11y 文本，出了问题（点错了、
   * 页面弹了个没见过的东西、登录掉了）翻那些文本几乎看不出所以然，一眼缩略图就够。
   * 点开走的是产出文件同一个预览。
   *
   * 模型看不见这些图（默认那个对话模型没有视觉），所以它们**只在这里有用**——没有这条，
   * 那些图就只是躺在工作区里没人会去翻的东西。
   */
  /**
   * 产出的图片，摆在正文底下、过程截图上面（见 outputImages）。只看工具产出的——用户自己
   * 发的图在正文上面那一排，这里再摆一遍就重复了。
   */
  const outImgs = b.kind === 'assistant' ? outputImages(outputFiles(tools)) : []
  let outbox = bubble.querySelector('.sw-outshots')
  const outSig = outImgs.map((f) => f.path).join('|')
  if (outImgs.length && !outbox) {
    outbox = document.createElement('div')
    outbox.className = 'sw-shots sw-outshots'
    bubble.insertBefore(outbox, chips)
  }
  if (outbox && outbox.getAttribute('data-sig') !== outSig) {
    outbox.setAttribute('data-sig', outSig)
    outbox.innerHTML = outImgs.map(shotHtml).join('')
    outbox.hidden = !outImgs.length
    void fillShots(outbox, OUT_IMAGE_AUTO_MAX)
  }

  const allSteps = stepShots(tools)
  const steps = allSteps.slice(0, MAX_STEP_SHOTS)
  const moreSteps = allSteps.length - steps.length
  let stepbox = bubble.querySelector('.sw-steps')
  const stepSig = steps.map((f) => f.path).join('|') + '#' + moreSteps
  if (steps.length && !stepbox) {
    stepbox = document.createElement('div')
    stepbox.className = 'sw-shots sw-steps'
    bubble.insertBefore(stepbox, chips)
  }
  if (stepbox && stepbox.getAttribute('data-sig') !== stepSig) {
    stepbox.setAttribute('data-sig', stepSig)
    stepbox.innerHTML = steps.map(shotHtml).join('') + (moreSteps > 0 ? stepMoreHtml(moreSteps) : '')
    stepbox.hidden = !steps.length
    void fillShots(stepbox)
  }

  /**
   * 确认卡分两拨：**还等着人点的摊开，已经有结论的收成一颗药丸。**
   *
   * 摊开是给「你要批的到底是什么」用的——参数看不见就只能凭信任点，那和没有这个开关
   * 一样。可人点完之后它就只是一条痕迹了，再占着半屏参数，往上翻这一轮的对话会被
   * 几张已经作废的卡片挡住。收起来之后和工具痕迹排在一起，详情走同一个悬浮窗。
   */
  const apps = b.approvals || []
  const waiting = apps.filter((a) => a.state === 'pending' && !approvalDead(a))
  const settled = apps.filter((a) => !waiting.includes(a))

  // 底下只留没被正文点过名的。摆不下的收成一行，不闷声截断（见 outMoreHtml）。
  const imgPaths = new Set(outImgs.map((f) => f.path))
  const rest = outs.filter((f) => !inlined.has(f.path) && !imgPaths.has(f.path))
  const shownOuts = rest.slice(0, MAX_OUT_CHIPS)
  const moreOuts = rest.length - shownOuts.length
  /**
   * 读过、但正文里一个字也没提到的那些（见 readFiles）。
   *
   * 正文里接得上就不摆——那颗药丸离说这句话的地方隔着好几行，而链接就在句子里。
   * 判据拿的是**正文源码**：DOM 那边要等这一帧画完才知道接上了没有，而药丸和正文
   * 是同一帧决定的。
   */
  const wasRead = readFiles(tools)
  // 扫正文只在真读过东西的时候做。绝大多数消息一次 read 都没有，而这个函数每帧
  // 对每一行都会跑一次。
  const linked = new Set(wasRead.length ? fileHits(b.text, chatFileCands).map((h) => h.file.path) : [])
  const outPaths = new Set(outs.map((f) => f.path))
  const reads = wasRead.filter((f) => !outPaths.has(f.path) && !linked.has(f.path))
  const shownReads = reads.slice(0, MAX_READ_CHIPS)
  const moreReads = reads.length - shownReads.length
  const sig =
    tools.map((x) => x.name + (x.result == null ? '·' : x.failed ? '!' : '=')).join('|') +
    '#' +
    shownOuts.map((f) => f.path).join('|') +
    '+' +
    moreOuts +
    '#' +
    shownReads.map((f) => f.path).join('|') +
    '+' +
    moreReads +
    '#' +
    settled.map((a) => a.callId + ':' + approvalState(a)).join('|')
  if (chips.getAttribute('data-sig') !== sig) {
    chips.setAttribute('data-sig', sig)
    // 重画会把折叠框换掉：人点开了就保持开着——「调用中 → 完成」那一下正是他在看的时候。
    const wasOpen = Boolean(chips.querySelector('.sw-toolfold')?.open)
    chips.innerHTML =
      (tools.length || settled.length ? toolFoldHtml(tools, settled) : '') +
      shownOuts.map(fileChipHtml).join('') +
      (moreOuts > 0 ? outMoreHtml(moreOuts) : '') +
      shownReads.map(readChipHtml).join('') +
      (moreReads > 0 ? readMoreHtml(moreReads) : '')
    const fold = chips.querySelector('.sw-toolfold')
    if (fold && wasOpen) fold.open = true
    chips.hidden = !tools.length && !rest.length && !shownReads.length && !settled.length
    /**
     * 工具对象直接挂到节点上，悬浮窗按需取。
     *
     * **选择器要把确认那几颗排除掉**：它们也叫 sw-toolchip（为的是复用悬浮窗那一整套
     * 触发、定位、重接），混进来的话下标就错位了，鼠标停在一颗工具药丸上会弹出另一次
     * 调用的参数。产出文件那几颗是 sw-filechip，本来就不在这个选择器里。
     */
    const nodes = chips.querySelectorAll('.sw-toolchip:not(.sw-approvalchip)')
    for (let i = 0; i < nodes.length; i++) nodes[i].__tool = tools[i]
    // data-i 是「在这个容器的 .sw-toolchip 列表里排第几」，所以确认那几颗接在工具后面
    // 数（见 approvalChipHtml 的调用处）——refreshToolPop 靠它把浮层接回新节点。
    const apNodes = chips.querySelectorAll('.sw-approvalchip')
    for (let i = 0; i < apNodes.length; i++) apNodes[i].__tool = approvalPop(settled[i])
    // 这一批节点刚被换掉。开着的悬浮窗要么跟着换到新节点上，要么关掉——
    // 「调用中 → 完成」正好是人盯着它看的那一刻，不该在那时候闪没。
    refreshToolPop()
  }

  /**
   * 高风险确认卡。摆在工具药丸**底下**——它说的就是那颗还在转的药丸在等什么。
   *
   * 和别处一样按签名跳过重绘：不这么做的话，流式那几帧会把卡片连同上面的按钮一起
   * 换掉，人正要点的那一下就落空了。
   */
  let apbox = bubble.querySelector('.sw-approvals')
  if (waiting.length && !apbox) {
    apbox = document.createElement('div')
    apbox.className = 'sw-approvals'
    bubble.appendChild(apbox)
  }
  if (apbox) {
    const apSig = waiting.map((a) => a.callId).join('|')
    if (apbox.getAttribute('data-sig') !== apSig) {
      apbox.setAttribute('data-sig', apSig)
      apbox.innerHTML = waiting.map(approvalHtml).join('')
      apbox.hidden = !waiting.length
      fitMailCards(apbox)
    }
  }

  /**
   * 交接卡。和确认卡同一套写法，但**签名里要带状态**：一张单从"等人接手"变成
   * "处理中"是同一个 id，只按 id 比的话卡片不会重画，人点完接手看不到任何变化。
   *
   * 还没写完的那句话要留住：重画会把 textarea 换掉，而人可能正打到一半（另一个
   * 标签页的一次状态流转就足以触发重画）。所以先把草稿存起来，画完再填回去。
   */
  const hs = b.handoffs || []
  // 席位上已经没有的那些跟终态一样收成一行——**别再摆按钮**，点下去只有一句 409。
  const live = hs.filter((h) => !handoffDead(h) && (h.state === 'open' || h.state === 'claimed' || h.state === 'returned'))
  const done = hs.filter((h) => !live.includes(h))
  let hobox = bubble.querySelector('.sw-handoffs')
  if (hs.length && !hobox) {
    hobox = document.createElement('div')
    hobox.className = 'sw-handoffs'
    bubble.appendChild(hobox)
  }
  if (hobox) {
    const hSig = hs.map((h) => h.id + ':' + h.state + ':' + (h.repeats || 0) + (handoffDead(h) ? ':x' : '')).join('|')
    if (hobox.getAttribute('data-sig') !== hSig) {
      for (const ta of hobox.querySelectorAll('.sw-handoff-note')) {
        const id = ta.getAttribute('data-handoff')
        if (id && ta.value) handoffDrafts.set(id, ta.value)
      }
      hobox.setAttribute('data-sig', hSig)
      hobox.innerHTML = live.map(handoffHtml).join('') + done.map(handoffDoneHtml).join('')
      hobox.hidden = !hs.length
      for (const ta of hobox.querySelectorAll('.sw-handoff-note')) {
        const draft = handoffDrafts.get(ta.getAttribute('data-handoff'))
        if (draft) ta.value = draft
      }
    }
  }
  /**
   * 派出去的活：委派卡和派活卡。摆在最底下——它是这一轮里最重的一块，而它上面那颗
   * delegate_task / assign_task 药丸只说得出「调用中」。
   *
   * 签名里**必须带状态和步数**：一件活从 running 到 done 是同一个 id，只按 id 比的话
   * 卡片不会重画，人盯着的那几分钟里它一动不动——而这正是同步委派最难受的那几分钟
   * （见 docs/delegation.md §13）。
   */
  /**
   * **按 callId 分组，一批一张卡。**
   *
   * 同一轮里派两批不是边角情况——§8.6 推荐的就是「撞顶了就原样再派一次」。全丢进一个数组
   * 按 index 排的话，两批会交错成 0,0,1,1,2，每行的位置也不再对得上模型手上那个
   * `[n/总数]` 的编号。委派和派活各是各的调用，callId 不会撞，按出场先后排。
   */
  const groups = []
  for (const [list, view] of [
    [b.tasks, delegateView],
    [b.assigns, assignView],
  ]) {
    for (const task of list || []) {
      const key = task.callId || task.id
      let g = groups.find((x) => x.key === key)
      if (!g) groups.push((g = { key, rows: [], view }))
      g.rows.push(task)
    }
  }
  for (const g of groups) g.rows.sort((x, y) => (x.index || 0) - (y.index || 0))
  let tkbox = bubble.querySelector('.sw-tasks')
  if (groups.length && !tkbox) {
    tkbox = document.createElement('div')
    tkbox.className = 'sw-tasks'
    bubble.appendChild(tkbox)
  }
  if (tkbox) {
    const views = groups.map((g) => g.rows.map(g.view))
    const tSig = views.flat().map(taskSig).join('|')
    if (tkbox.getAttribute('data-sig') !== tSig) {
      tkbox.setAttribute('data-sig', tSig)
      paintTaskHtml(tkbox, views.map(taskGroupHtml).join(''))
      // 对方交回的结论里常有 `@某某`：和对话正文一样就地画成点名药丸。
      for (const md of tkbox.querySelectorAll('.sw-task-summary')) inlineMentionPills(md, mentionCands())
      tkbox.hidden = !groups.length
    }
  }

  /**
   * 「记下了一条方法」那张小卡。摆在委派卡下面——它是这一轮的一个副作用，不是主线。
   *
   * 删掉那颗按钮直接打公司目录那条删除接口（管理员也删得掉私有档，见
   * routes/catalog.ts）。删完把这张卡标成已删，不去重拉整条会话：那条 Skill 已经不在
   * 了，而这一块讲的是「当时发生了什么」。
   */
  const notes = b.skillNotes || []
  let nbox = bubble.querySelector('.sw-skillnotes')
  if (notes.length && !nbox) {
    nbox = document.createElement('div')
    nbox.className = 'sw-skillnotes'
    bubble.appendChild(nbox)
  }
  if (nbox) {
    const nSig = notes.map((x) => x.id + ':' + x.action + ':' + (state.skillNoteGone?.[x.id] ? 'x' : '-')).join('|')
    if (nbox.getAttribute('data-sig') !== nSig) {
      nbox.setAttribute('data-sig', nSig)
      nbox.innerHTML = notes.map(skillNoteHtml).join('')
    }
  }

  /**
   * 「记下了一条事实」那张小卡。**和 Skill 那张共用一套样式**——它们在人眼里是同一
   * 类东西（Bot 自己改了自己），分两套皮只会让人以为它们是两种不同的事件。
   */
  const mems = b.memNotes || []
  let mbox = bubble.querySelector('.sw-memnotes')
  if (mems.length && !mbox) {
    mbox = document.createElement('div')
    mbox.className = 'sw-memnotes sw-skillnotes'
    bubble.appendChild(mbox)
  }
  if (mbox) {
    const mSig = mems.map((x) => x.id + ':' + x.action + ':' + (state.memNoteGone?.[x.id] ? 'x' : '-')).join('|')
    if (mbox.getAttribute('data-sig') !== mSig) {
      mbox.setAttribute('data-sig', mSig)
      mbox.innerHTML = mems.map(memNoteHtml).join('')
    }
  }

  paintRowTime(el, b, streaming, since)
}

const MEM_NOTE_VERB = {
  add: ['记住了', 'remembered'],
  replace: ['改了记下的事', 'updated a memory'],
  remove: ['忘掉了', 'forgot'],
}

/**
 * 卡上摆的是**正文**，不是名字——记忆没有名字，而「它记住了什么」正是人要看的那一句。
 *
 * 删除按钮不做二次确认：一条记错的记忆每一轮都在影响回答，删它要极其容易
 * （docs/memory.md §12 ②）。旁边那句小字说清「最多一分钟后在对话里生效」——不说的话，
 * 人删完立刻再问一句、看见它还记得，得到的结论是「删除没用」（§12 ③）。
 */
function memNoteHtml(note) {
  const gone = state.memNoteGone?.[note.id] || note.action === 'remove'
  const verb = MEM_NOTE_VERB[note.action] || MEM_NOTE_VERB.add
  const count = typeof note.used === 'number' && typeof note.max === 'number' ? ` · ${note.used}/${note.max}` : ''
  return `<div class="sw-skillnote">
    <span class="sw-skillnote-name">${esc(note.text || '')}</span>
    <span class="sw-skillnote-verb">${esc(t(verb[0], verb[1]))}${esc(count)}</span>
    ${
      gone
        ? `<span class="sw-skillnote-verb">${esc(t('已删掉', 'deleted'))}</span>`
        : `<button type="button" class="sw-skillnote-act" data-act="chat-memory-delete" data-id="${esc(note.id)}">${esc(t('删掉', 'delete'))}</button>`
    }
  </div>`
}

const SKILL_NOTE_VERB = { create: ['记下了一条方法', 'noted a method'], update: ['改了自己记的方法', 'updated its own method'], remove: ['删掉了自己记的方法', 'deleted its own method'] }

function skillNoteHtml(note) {
  const gone = state.skillNoteGone?.[note.id] || note.action === 'remove'
  const verb = SKILL_NOTE_VERB[note.action] || SKILL_NOTE_VERB.create
  const count = typeof note.used === 'number' && typeof note.max === 'number' ? ` · ${note.used}/${note.max}` : ''
  return `<div class="sw-skillnote">
    <span class="sw-skillnote-name">${esc(note.name || '')}</span>
    <span class="sw-skillnote-verb">${esc(t(verb[0], verb[1]))}${esc(count)}</span>
    ${
      gone
        ? `<span class="sw-skillnote-verb">${esc(t('已删掉', 'deleted'))}</span>`
        : /**
           * 「看看」只给管得着目录的人（管理员 / owner）。成员点进 /skills 会落在一屏
           * 拉不到数据的页面上——那比没有这颗按钮更糟。
           *
           * 「删掉」人人都有：它走的是「这颗 Bot 的主人删自己那条」那条路
           * （`/runtime/bots/:botId/skills/:id`），不是管理员的目录接口。
           */
          `${catalogBase() ? `<button type="button" class="sw-skillnote-act" data-act="go" data-href="/skills">${esc(t('看看', 'view'))}</button>` : ''}
           <button type="button" class="sw-skillnote-act" data-act="chat-skill-delete" data-id="${esc(note.id)}" data-name="${esc(note.name || '')}">${esc(t('删掉', 'delete'))}</button>`
    }
  </div>`
}

/**
 * 一批委派或派活画成一张卡，每条一行（taskItemHtml）。卡头把这一批的状况数出来：
 * 「派出去 3 件 · 1 进行中 · 2 失败」——三条都摊着的时候不用一条条看就知道大局。
 */
function taskGroupHtml(views) {
  const n = (pred) => views.filter(pred).length
  const counts = [
    [n((v) => taskLive(v.state) && v.state !== 'waiting'), '进行中', 'running', 'run'],
    [n((v) => v.state === 'waiting'), '等待中', 'waiting', 'wait'],
    [n((v) => v.state === 'done'), '完成', 'done', 'ok'],
    [n((v) => TASK_TONE[v.state] === 'bad' || TASK_TONE[v.state] === 'warn'), '需留意', 'need attention', 'warn'],
    [n((v) => TASK_TONE[v.state] === 'off'), '已停止', 'stopped', 'off'],
  ]
    .filter(([k]) => k > 0)
    .map(([k, zh, en, tone]) => `<span class="sw-task-count" data-tone="${tone}">${esc(t(`${k} ${zh}`, `${k} ${en}`))}</span>`)
  const head = `<div class="sw-task-head"><span class="sw-task-head-title">${esc(t(`已派发 ${views.length} 项任务`, `${views.length} tasks delegated`))}</span><span class="sw-task-counts">${counts.join('')}</span></div>`
  return `<div class="sw-task-card">${head}${views.map((v) => `<div class="sw-task-row">${taskItemHtml(v)}</div>`).join('')}</div>`
}

/**
 * 气泡下面那一行时间。
 *
 * 还在输出时显示**读秒**，输出完了显示**收口的时刻**。
 *
 * 以前两种情况都显示「开始的时刻」，于是一轮跑了三分钟的对话，下面写着的是三分钟前
 * 那个数字，而且从头到尾一动不动——既看不出它在跑，也看不出它跑了多久。而人在等的
 * 时候最想知道的恰恰是「已经等了多久」。
 *
 * 只有助手那条读秒：status 是 'sending' 时（消息刚发出去、还没有回执）最后一条是
 * 用户自己那句，给它挂个秒表没有意义。
 */
function paintRowTime(el, b, streaming, since) {
  const node = el.querySelector('.sw-time')
  if (!node) return
  /**
   * 起点是**这一轮开始的时刻**，不是这一块自己的时间。
   *
   * 两者常常差着十几秒（模型先想、先调工具，第一个字很晚才落地），而按后者算，秒表
   * 会在第一个字冒出来的那一刻从头数起——上一秒还是「正在想」下面什么都没有，下一秒
   * 蹦出个「0s」。读秒回答的是「我等了多久」，那个问题只有一个起点。
   *
   * 拿不到起点（老会话、截断的历史）才退回这一块自己的时间。
   */
  const start = Number(since) || b.time
  const running = Boolean(streaming) && b.kind === 'assistant' && Boolean(start)
  if (running) {
    node.hidden = false
    node.setAttribute('data-running', '1')
    node.setAttribute('data-since', String(start))
    node.removeAttribute('datetime')
    node.textContent = elapsedText(Date.now() - start)
    return
  }
  // endTime 是这一块最后一条事件的时间（turn/end 最准）。老会话没有它——那时候
  // 事件里也拿不出更好的答案，回落到开始时刻，和以前一个样，不会更差。
  const at = b.endTime || b.time
  node.removeAttribute('data-running')
  node.removeAttribute('data-since')
  if (!at) {
    node.hidden = true
    node.textContent = ''
    return
  }
  node.hidden = false
  node.setAttribute('datetime', new Date(at).toISOString())
  node.textContent = chatClock(at)
}

/** 读秒的文本。一分钟以内就是秒，超过了给 m:ss——纯秒数到了几百就读不出来了。 */
function elapsedText(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000))
  if (s < 60) return s + 's'
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
}

/**
 * 读秒的心跳。
 *
 * 只在**屏幕上真有**一个读秒中的时间戳时才转，转完自己停——挂一个长明的
 * setInterval 在这种页面上是白烧电，标签页在后台时尤其。
 */
let clockTimer = null
function tickClocks() {
  const nodes = document.querySelectorAll('.sw-time[data-running]')
  if (!nodes.length) {
    clearInterval(clockTimer)
    clockTimer = null
    return
  }
  for (const n of nodes) {
    const since = Number(n.getAttribute('data-since')) || 0
    if (since) n.textContent = elapsedText(Date.now() - since)
  }
}

function ensureClockTick() {
  const has = document.querySelector('.sw-time[data-running]')
  if (has && !clockTimer) clockTimer = setInterval(tickClocks, 1000)
  else if (!has && clockTimer) {
    clearInterval(clockTimer)
    clockTimer = null
  }
}

/**
 * 要画哪些行。日期分隔是**算出来的**，不是数据里的——相邻两条不在同一天就插一条。
 */
/**
 * 往前翻一页。
 *
 * 插在**开头**，所以要做两件事，缺一件人就会失去位置感：
 *   · 节点按 key 认（见 syncThread），插进来的只是开头那几条，别的原地不动；
 *   · 补回滚动位置——内容在上面长高了多少，scrollTop 就往下推多少，视线才不会跳。
 */
async function loadOlderChat(sessionId) {
  const page = chatPages.get(sessionId)
  if (!page || !page.hasMore || page.loading || !page.firstSeq) return
  chatPages.set(sessionId, { ...page, loading: true })
  paintLoadMore()
  try {
    const data = await api(
      'GET',
      `/runtime/sessions/${encodeURIComponent(sessionId)}/history?turns=${CHAT_TAIL_TURNS}&before=${page.firstSeq}`,
    )
    const owner = botIdOfSession(sessionId)
    const list = owner ? botStreamOf(owner).events : state.chatEvents
    // 和 hydrateChat 一个判据：只收比手上最靠前那条还早的。正常情况下 before=firstSeq
    // 已经保证了这一点，这里挡的是两条路撞在一起的那几次（补历史和翻页同时在跑）。
    const head = list.length ? Number(list[0].seq) : Infinity
    const older = ((data && data.events) || []).filter((ev) => Number(ev.seq) < head)
    if (older.length) {
      const thread = document.getElementById('chat-thread')
      chatAnchorHeight = thread ? thread.scrollHeight : 0
      list.unshift(...older)
    }
    // 走 noteChatPage 而不是直接 set：这一页也可能比手上知道的窄——等这一跳的工夫
    // hydrateChat 落了地，它那二十轮盖过了这里的一页，游标就不该再退回来。
    // loading 归零由这里说了算，翻页这件事从头到尾只有它一个人管。
    noteChatPage(sessionId, { firstSeq: data && data.firstSeq, hasMore: data && data.hasMore, loading: false })
  } catch (err) {
    // 翻不动就把「加载更多」放回去，别把这一段历史永久锁死。**读最新的那份**：
    // page 是发请求之前的快照，照它写回去会把这期间 hydrateChat 记下的游标抹掉。
    noteChatPage(sessionId, { loading: false })
    state.runtimeError = errText(err.message) || err.message
  }
  paintChat()
}

/** 上一次往前插之前，正文有多高。插完拿它补回滚动位置。0 表示这一帧没插东西。 */
let chatAnchorHeight = 0

function loadMoreRow(sessionId) {
  const page = chatPages.get(sessionId)
  if (!page || !page.hasMore) return null
  const label = page.loading ? t('加载中…') : t('加载更早的对话')
  return {
    kind: 'more',
    // key 带上状态：loading 一变就是新节点，省得再为一行字做一套「就地更新」。
    key: page.loading ? 'more-loading' : 'more',
    html: `<div class="sw-more" style="display: flex; justify-content: center; padding: var(--space-3) 0;"><button type="button" class="satu-linkbtn" data-act="chat-older" ${page.loading ? 'disabled' : ''}>${esc(label)}</button></div>`,
  }
}

let loadMorePaintQueued = false

/** 只重画顶部那一行，不动正文。 */
function scheduleLoadMorePaint() {
  if (loadMorePaintQueued) return
  loadMorePaintQueued = true
  const run = () => {
    loadMorePaintQueued = false
    paintLoadMore()
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
  else setTimeout(run, 16)
}

function paintLoadMore() {
  if (document.getElementById('chat-thread')) paintChat()
}

/**
 * 上下文边界那条线。
 *
 * **必须说清楚记录还在。** 「已清空」会让人以为历史没了，而 JSONL 一条没删——往上翻
 * 看得见，导出带得走，模型自己也还能用 history_read 调回来。清掉的只是「下一轮请求里
 * 带什么」（见 docs/context-assembly.md）。
 *
 * 自动压缩和手动压缩画同一条线，只是措辞不同：一个是「它自己压的」，一个是人点的。
 */
function ctxDivText(b) {
  if (b.mark === 'model') {
    // 被下架退回的那一条要说清楚原因：人回来看到模型变了，第一个问题就是「谁换的」。
    if (b.reason === 'removed') {
      return t(`${b.from || '之前选的模型'} 已不在可选名单里，改用默认模型 ${b.label}`, `${b.from || 'The chosen model'} is no longer offered; switched to the default ${b.label}`)
    }
    return b.key
      ? t(`从这里起用 ${b.label}`, `Using ${b.label} from here`)
      : t(`从这里起换回默认模型 ${b.label}`, `Back to the default model ${b.label} from here`)
  }
  // `/clear` 那条只说一件事：之前的看不见了。用不着数字，也用不着「仍在记录里」——
  // 记录确实还在（审计要用），但人打 /clear 要的就是从这里起当它不存在。
  if (b.mark === 'clear') return t('对话记录已清空')
  const head =
    b.mark === 'reset'
      ? t('新对话从这里开始')
      : b.by === 'user'
        ? t('已压缩上下文')
        : t('上下文快满了，自动压缩了一次')
  const parts = [head]
  // 数字只在压缩那条线上有意义。0 → 老日志缺字段，那就不摆一个假的。
  if (b.mark === 'compact' && b.tokensBefore && b.tokensAfter) {
    parts.push(ctxNum(b.tokensBefore) + ' → ' + ctxNum(b.tokensAfter))
  }
  parts.push(b.mark === 'reset' ? t('上面的内容不再进上下文') : t('更早的对话仍在记录里'))
  return parts.join(' · ')
}

function ctxDivHtml(b) {
  return (
    `<div class="sw-ctxdiv" data-mark="${esc(b.mark)}">` +
    `<span class="sw-ctxdiv-text">${esc(ctxDivText(b))}</span></div>`
  )
}

function threadRows(folded, sessionId) {
  const blocks = folded.blocks || []
  const rows = []
  const more = sessionId ? loadMoreRow(sessionId) : null
  if (more) rows.push(more)
  let lastDay = ''
  /** 正折着的那件派来的活：它那一轮的助手块不画（见 taskInBlock）。 */
  let folding = false
  /** 末尾那一块被折进卡里了：这一轮还在跑也不补「正在回答」的空气泡，卡片自己的状态签说着呢。 */
  let tailFolded = false
  blocks.forEach((b, i) => {
    if (folding && b.kind === 'assistant' && b.via === 'task') {
      tailFolded = i === blocks.length - 1
      return
    }
    folding = false
    tailFolded = false
    const day = chatDayKey(b.time)
    if (day && day !== lastDay) {
      lastDay = day
      rows.push({ kind: 'day', key: 'd' + day, html: `<div class="sw-daydiv"><span>${esc(chatDayLabel(b.time) + ' ' + chatClock(b.time))}</span></div>` })
    }
    // 上下文边界走「html 行」那条路（和日期分隔线、加载更多同一条）：它没有气泡、
    // 没有头像、没有工具条，套 rowShell 只会画出一个空壳。
    if (b.kind === 'mark') {
      rows.push({ kind: 'mark', key: 'k' + b.seq, html: ctxDivHtml(b) })
      return
    }
    // key 必须**跟着这一块自己**走，不能用下标：往前翻加载旧消息会让所有下标移位，
    // 于是整棵 DOM 重建——Markdown 全部重渲染，滚动位置也跟着没了。
    const block = b.kind === 'user' && b.via === 'task' ? taskInBlock(b, blocks, i, folded.status, sessionId) : b
    if (block.foldable && !block.open) {
      folding = true
      tailFolded = i === blocks.length - 1
    }
    rows.push({ kind: 'msg', key: 'm' + (b.seq != null ? b.seq : 'i' + i), block })
  })
  // 轮次开着但助手那条还没建出来（工具先跑、或者刚发出去）——补一条空的，
  // 让「正在想」有地方待着，而不是让输入框上面挂一行状态文字。
  //
  // **key 用常量，不能用 `'m' + blocks.length`。** 真实消息的 key 是 `'m' + seq`，seq 是
  // 会话日志的**行号**（turn/tool/分片都占行），跟**块数**是两套数——只要会话里恰好有
  // 一块 seq 等于当前块数，这条占位就和那条早期消息顶了同一个 key：下一帧 syncThread
  // 按 key 认节点时会把底下的占位节点搬到那条消息的位置（正文换成它的、外壳还是助手的
  // 头像和左对齐），被顶掉的原节点则一路被挤到最下面，看着就是「前面那句话跳到后面了」。
  /**
   * 还在跑、而最后一块不是助手正文：补一条空的「正在回答」占位。
   *
   * `last.kind === 'user'` 之外还要认 `mark`——自动压缩完全可能落在一轮的中间（见
   * fold 里那段长注释），那时候末尾那块是压缩分隔线。只认 user 的话，这一轮既拿不到
   * 占位、下面 syncThread 又只把**最后一行**标成 streaming（那行是分隔线），于是助手
   * 那条的秒表停了、光标没了、`healStream` 也不再补收口——半截围栏直接以原文露出来，
   * 屏幕上看着像已经答完，而这一轮其实还在跑。
   */
  const last = blocks[blocks.length - 1]
  if (folded.status && !tailFolded && (!last || last.kind === 'user' || last.kind === 'mark')) {
    /**
     * **`time` 要给这一轮的起点，不能留 0。**
     *
     * 留 0 的话 paintRowTime 判不出「在跑」，那一行时间被整个隐掉——于是模型开口之前
     * 的那段（想、调工具、日常任务里动辄十几秒）屏幕上一个秒表都没有，等第一个字落地
     * 才凭空冒出来一个「0s」。人看到的就是这一行忽有忽无、还从头数起。
     */
    rows.push({ kind: 'msg', key: 'm-live', block: { kind: 'assistant', text: '', tools: [], via: last?.via || '', time: folded.statusAt || 0 } })
  }
  return rows
}

/**
 * 本地回显：发出去的那一刻就画上，回执一到就撤掉本地这条。认领规则在 core/src/chat/pending.ts；
 * 这里只负责从 state.chatPending 里挑出这条会话的、再把没收到回执的写回去。
 */
function mergePending(folded, sessionId) {
  const all = state.chatPending || []
  const mine = all.filter((p) => p.sessionId === sessionId)
  if (!mine.length) return folded
  const left = SatuCore.mergePending(folded, mine)
  if (left.length !== mine.length) {
    state.chatPending = all.filter((p) => p.sessionId !== sessionId || left.includes(p))
  }
  return folded
}

/** 节点是按哪种外壳画的（rowShell 的两条路）。认回来的节点外壳不对，就不能拿来更新。 */
function shellKindOf(b) {
  return b.taskFrom ? 'task' : b.kind
}
function nodeShellKind(node) {
  return node.classList.contains('sw-taskin') ? 'task' : node.getAttribute('data-role')
}

function syncThread(thread, folded, sessionId) {
  const rows = threadRows(folded, sessionId)
  /**
   * **换了会话就整片清掉，不跨会话认节点。**
   *
   * key 是 `'m' + seq`，seq 是**这一条**会话日志的行号，两条会话之间必然撞号。切到一个
   * 流还开着的 Bot 时，ensureChatSession 那条热路径当场 paintChat，而这时候屏幕上还是
   * 上一个 Bot 的 #chat-thread（整页重绘要等 loadPage 回来）：不清的话，新会话的派活卡
   * 会认领上一条会话里同号的普通消息节点，往不存在的 `.sw-taskname-tag` 上写字直接抛错。
   * 带上 Bot：两颗都还没拿到会话时 sessionId 都是空的。
   */
  const owner = `${state.chatBotId || ''}:${sessionId || ''}`
  if (thread.getAttribute('data-owner') !== owner) {
    thread.setAttribute('data-owner', owner)
    thread.removeAttribute('data-empty')
    thread.innerHTML = ''
  }
  // 空会话就留空。以前这里摆一句「继续这段对话…」——它只在**刚开一条新对话**时出现
  // 一瞬间，而输入框的 placeholder 已经说了该干什么。多一句灰字只是让空屏更吵。
  if (!rows.length) {
    if (thread.getAttribute('data-empty') !== '1') {
      thread.setAttribute('data-empty', '1')
      thread.innerHTML = ''
    }
    return
  }
  if (thread.getAttribute('data-empty') === '1') {
    thread.removeAttribute('data-empty')
    thread.innerHTML = ''
  }
  // **按 key 认节点，不按位置。** 位置对齐在「只往后追加」的年代够用，但往前翻会在
  // 开头插一批，之后每个位置都对不上，于是每个节点都被替换掉——看着是「重绘了一下」，
  // 实际是整段 Markdown 重渲染 + 滚动位置丢失。
  //
  // 重名的一律就地删掉，只认先来的那个。key 本该唯一，但一旦哪里算重了（历史上就是
  // 「正在想」那条占位撞上了某条真实消息的 seq），后来的会在 map 里盖掉先来的：认回
  // 来的是错的那个节点，被盖掉的那个既不参与排序也进不了下面的 stale 清理，于是留在
  // 正文里一路往下漂。宁可多建一个节点，也不能让一个野节点留在 DOM 里。
  const byKey = new Map()
  for (const kid of [...thread.children]) {
    const k = kid.getAttribute('data-key')
    if (!k) continue
    if (byKey.has(k)) thread.removeChild(kid)
    else byKey.set(k, kid)
  }
  let prev = null
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    let node = byKey.get(row.key)
    if (node) byKey.delete(row.key)
    // 同一个 key 换了外壳（派活卡 ↔ 普通消息、用户 ↔ 助手）：旧节点里没有新外壳要的那几格，
    // 拿来 updateRow 会往 null 上写。扔掉重建。
    if (node && row.kind === 'msg' && nodeShellKind(node) !== shellKindOf(row.block)) {
      if (node.parentNode === thread) thread.removeChild(node)
      node = null
    }
    if (!node) {
      const box = document.createElement('div')
      box.innerHTML = row.html ? row.html : rowShell(row.block, row.key)
      node = box.firstElementChild
      if (row.html) node.setAttribute('data-key', row.key)
    }
    const want = prev ? prev.nextSibling : thread.firstChild
    if (node !== want) thread.insertBefore(node, want)
    if (row.kind === 'msg') updateRow(node, row.block, folded.status ? i === rows.length - 1 : false, folded.statusAt)
    prev = node
  }
  for (const stale of byKey.values()) {
    if (stale.parentNode === thread) thread.removeChild(stale)
  }
}

/**
 * 贴底。
 *
 * 以前是每帧无条件 `scrollTop = scrollHeight`：往上翻历史时，回答每吐一个字就把人拽
 * 回底部，根本读不了前面。改成「本来就在底部附近才跟着走」，翻上去了就停住，另外给一
 * 个「回到底部」的按钮把路留回来。
 */
const STICK_SLACK = 80

function nearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_SLACK
}

// 跟随是用户的滚动意图，不能在键盘缩短视口、图片加载长高之后重新按距离推断。
// 只保留当前消息区的观察器；整页重绘换节点时拆掉旧的。
let chatScroll = null

function rememberChatScrollSize(scroll) {
  scroll.height = scroll.thread.scrollHeight
  scroll.viewport = scroll.thread.clientHeight
}

function watchChatScroll(thread) {
  if (chatScroll && chatScroll.thread === thread) return chatScroll
  if (chatScroll && chatScroll.observer) chatScroll.observer.disconnect()
  const scroll = {
    thread,
    following: thread.getAttribute('data-touched') !== '1' || nearBottom(thread),
    rows: new Set(),
    observer: null,
  }
  chatScroll = scroll
  rememberChatScrollSize(scroll)
  if (typeof ResizeObserver === 'function') {
    scroll.observer = new ResizeObserver(() => {
      if (document.getElementById('chat-thread') !== thread) {
        scroll.observer.disconnect()
        return
      }
      if (scroll.following) thread.scrollTop = thread.scrollHeight
      rememberChatScrollSize(scroll)
      const jump = document.getElementById('chat-jump')
      if (jump) jump.hidden = nearBottom(thread)
    })
    scroll.observer.observe(thread)
  }
  return scroll
}

function noteChatScroll(thread) {
  const scroll = watchChatScroll(thread)
  // 布局变化也会产生 scroll；它不代表用户离开了底部。
  if (scroll.height === thread.scrollHeight && scroll.viewport === thread.clientHeight) {
    scroll.following = nearBottom(thread)
  }
  rememberChatScrollSize(scroll)
}

function followChatBottom(thread) {
  if (!thread) return
  watchChatScroll(thread).following = true
  thread.scrollTop = thread.scrollHeight
  rememberChatScrollSize(chatScroll)
}

function syncChatScroll(thread) {
  const scroll = watchChatScroll(thread)
  // Markdown 的图片、公式和过程卡会在 paintChat 返回之后才长高，连同行高一起观察。
  if (scroll.observer) {
    const rows = new Set(thread.children)
    for (const row of scroll.rows) if (!rows.has(row)) scroll.observer.unobserve(row)
    for (const row of rows) if (!scroll.rows.has(row)) scroll.observer.observe(row)
    scroll.rows = rows
  }
  if (scroll.following) thread.scrollTop = thread.scrollHeight
  rememberChatScrollSize(scroll)
}

function paintChat() {
  const thread = document.getElementById('chat-thread')
  /**
   * 「这一轮在不在跑」。席位表过态就听它的；**没表态而正在重放，一律按「没在跑」**。
   *
   * 重放是把历史从头灌一遍，而扫描对半截历史毫无抵抗力：灌到某轮的 `turn/start` 就是
   * 「正在处理」，要等配对的 `turn/end` 也灌出来才落下。拿真实数据量过，789 帧里有
   * 772 帧挂着「正在处理」，那期间什么都没在跑。这正是重放期间原来干脆一帧都不画的
   * 理由——可那个办法是拿「几秒钟一片空白」去换「不闪错状态」，而空白更难受。
   *
   * 摁在这里，两样就都拿到了：消息随着重放长出来，状态一眼假话都不说。`replay/done`
   * 一到，chatLive 里就是权威答案了（见流里那一支），这条兜底自然让位。
   */
  const live = chatLive.has(state.chatSessionId)
    ? chatLive.get(state.chatSessionId)
    : state.chatReplaying
      ? false
      : undefined
  const folded = mergePending(fold(state.chatEvents, live, currentBotHasChannelLabels()), state.chatSessionId)
  state.chatStatus = folded.status
  if (!thread) {
    if (chatScroll && chatScroll.observer) chatScroll.observer.disconnect()
    chatScroll = null
    return
  }
  // 正文里的文件名要接回哪几个文件，整条会话算一次（见 chatFileCands）。
  chatFileCands = fileCands(knownFiles(folded.blocks))
  // 右栏那一屏也在这儿补一次。**render() 里那一句不够**：席位接上之后走的是
  // hydrateChat / 流的帧，它们只 paintChat，不整页重绘——只挂在 render 上的话，那一屏
  // 要等到下一次真的重绘（人点了点什么）才去取。
  ensureWorkspaceTree()

  watchChatScroll(thread)
  syncThread(thread, folded, state.chatSessionId)
  if (window.satuMd) satuMd.enhance(thread)
  if (chatAnchorHeight) {
    // 刚往开头插了一批：内容在上面长高了多少，就把 scrollTop 往下推多少。不补的话
    // 视线会直接被甩到几十条之前，人根本认不出自己刚才在看哪儿。
    const grew = thread.scrollHeight - chatAnchorHeight
    chatAnchorHeight = 0
    if (grew > 0) thread.scrollTop += grew
  }
  paintChatChrome(folded)
  syncChatScroll(thread)
  if (typeof scheduleNotificationRead === 'function') scheduleNotificationRead()
  ensureClockTick()
  // 查找条开着的话，新画出来的消息里命中的词也要上色（chat-find.js；没开就什么都不做）。
  if (state.chatFind && state.chatFind.open) scheduleFindMarks()
}

/**
 * 抬头那盏灯此刻该说什么：`{ state, text }`。
 *
 * **机器够不着的时候，它先于一切说话——连「正在处理」都压过去。** 那一轮的 status 是
 * 断线之前留在手上的：机器没了，`turn/end` 永远不会来，于是屏幕上一直挂着「正在处理」，
 * 看着像它还在替你干活，而那台机器上此刻可能一个进程都没在跑。宁可说「失联」——它至少
 * 指对了要去看的地方。
 *
 * 判断抽出来单放，是因为写进 DOM 那一步没法断言（垫片里没有 lastElementChild 可写），
 * 而「机器失联时这盏灯说了什么」正是这次要钉住的那句话。
 */
function liveLamp(busy) {
  const bot = chatBotOf()
  const link = seatLink()
  // 本地 Bot 没有远程桌面（state.desktopRuntime），它是否在线由壳子的 status 盖到
  // runtime.status + machineLink。拿远程桌面判断它，会出现一边正常对话、一边写着
  // 「离线」的自相矛盾状态。
  if (bot && bot.runtimeKind === 'local') {
    const ready = bot.runtime && bot.runtime.status === 'ready' && link === 'online'
    if (!ready) return { state: '0', text: t('本机未运行', 'Not running locally') }
    if (busy) return { state: 'busy', text: t('正在处理') }
    return { state: '1', text: t('本机运行中', 'Running locally') }
  }
  if (linkDown(link)) return { state: link, text: (LINK_TEXT[link] || LINK_TEXT.unknown)() }
  if (busy) return { state: 'busy', text: t('正在处理') }
  const ready = state.desktopRuntime && state.desktopRuntime.status === 'ready'
  return ready ? { state: '1', text: t('在线') } : { state: '0', text: t('离线') }
}
