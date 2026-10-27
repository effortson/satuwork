/** 右栏里内嵌的远程桌面，和运行日志那条流。原先在 chat.js 里，拆出来只是搬家（顺序见 index.html）。 */
/* ── 内嵌桌面 ─────────────────────────────────────────────────────────────
 *
 * 右栏里那块屏是**真的桌面**，不是截图：一个连着席位 noVNC 的 iframe。鼠标移上去
 * 出「打开」，点一下撑成全屏遮罩，键鼠这时才交给它。
 *
 * **iframe 不能画在 #app 里面。** render() 是整页 innerHTML 换掉的，画在里面等于
 * 每重绘一次就重连一次 VNC——发条消息、切个状态，桌面就黑一下。所以它挂在 body 上
 * 的一个常驻层里，位置每次跟着右栏那个空槽（#sw-desk-slot）算出来。全屏也是同一个
 * 层改几何，不重新挂——不然「点开」这个动作本身就会把连接掐断再连一次。
 *
 * 预览态不做 view_only：那是 URL 参数，换它要重载页面。改成在上面盖一层挡片，
 * 点击进不去，键盘也拿不到焦点，代价只有一个 div。
 */

/** 票只有五分钟。挂之前超过这个岁数就先换一张，不然 iframe 一开就是 401。 */
const DESK_TICKET_FRESH_MS = 180_000
/**
 * 看不见多久之后把这块屏拆掉。
 *
 * **为什么要拆，而不是只把它藏起来。** 这个层原来在两种「看不见」下都只改样式：
 * 切到后台标签页只记一个时刻，右栏把它滚出可视区只设 `visibility:hidden`。可两种
 * 情况下 iframe 和它那条 WebSocket 都原封不动，浏览器也不会替我们暂停 WebSocket，
 * 于是像素照收——而这条流是整个系统里最贵的一条：实测 1280×800 下，Bot 一滚页面就是
 * 4 MB/s，静止时才是 0。没人看的时候连着，等于把那 4 MB/s 白扔了。
 *
 * **为什么要等五秒。** 重挂要付一个整屏首帧（q6 下 242 KB）加大约一秒黑屏。滚过去
 * 又滚回来是很常见的动作，立刻拆会让人看见一串黑屏。五秒足够把「路过」和「不看了」
 * 分开；而只要那五秒里屏幕在动，省下的字节已经远超首帧那一次。
 */
const DESK_IDLE_MS = 5000
/** 当前挂着的是哪个席位、用的哪个地址。**地址变了也要重挂**——见 syncDesktop。 */
let deskMounted = null
let deskMounting = false
let deskSlotSeen = null
let deskObserver = null
let deskPlacePending = false
/**
 * 因为没人看而主动拆掉时记在这儿：`null` = 没挂起，`{ full }` = 挂起了，且记着拆之前
 * 是不是全屏态。
 *
 * **必须自己记 full。** `unmountDesktop()` 会把 `state.deskFull` 清成 false（收起桌面
 * 本来就该退出全屏），而这里的拆是「人不在看」而不是「人收起了」——回来时得还原成
 * 他离开时的样子。mountDesktop 读的是 `state.deskFull`，所以解挂起要先把它写回去。
 */
let deskSuspended = null
let deskSuspendTimer = null
/** 页面被切到后台的时刻。回来得太晚就重挂，因为票早过期了，noVNC 自己连不回来。 */
let deskHiddenAt = 0

function deskCaption() {
  const name = (chatBotOf() || {}).name || t('这个 Bot')
  return localeMode === 'en' ? `${name}'s screen` : `${name} 的桌面`
}

/**
 * 这个地址能不能内嵌。
 *
 * 桌面地址现在只有席位机器的绝对地址一种（`https://m001…/seats/<席位>/vnc/`，Gateway
 * 不再反代）。它挡的那个失败**没有声音**：页面是 https、机器只配了 http 地址的时候，
 * iframe 被浏览器按混合内容拦掉，什么都不显示，控制台以外看不出所以然。这里退回
 * 「打开桌面」那颗按钮（新标签页是顶层导航，不受混合内容限制），比留一块黑屏强。
 */
function deskEmbeddable(url) {
  if (!url) return false
  // 手机壳不提供远程桌面预览，也不提供交给系统浏览器打开的入口。
  if (mobileShell()) return false
  return !(location.protocol === 'https:' && /^http:/i.test(url))
}

/**
 * 这个桌面地址和当前页跨不跨源。
 *
 * 只有一个用处：决定 iframe 的 sandbox 里加不加 `allow-same-origin`（见 mountDesktop
 * 里那段长注释——这一条判错就是把父页的登录 JWT 交出去）。
 *
 * 现在的地址一律是席位机器的绝对地址（`https://m001…`，直连），正常都返回 true；
 * Gateway 同域反代那条路（`/desktop/…`）已经没有了。**但判据仍然只能是地址本身**，
 * 不能写死 true：万一哪天又有同源的桌面地址（本地壳子、开发环境），写死就是把
 * allow-same-origin 加到同源的框上。**解析不出来一律当同源**：那是更严的那一边，
 * 宁可让一个本该直连的框连不上，也不能给一个同源的框开 allow-same-origin。
 */
function deskCrossOrigin(url) {
  try {
    return new URL(url, location.href).origin !== location.origin
  } catch {
    return false
  }
}

/** 内嵌用的地址：按预览尺寸缩放，别把桌面裁成左上角一小块。 */
function deskUrl() {
  const rt = state.desktopRuntime
  // novncUrl 是 null 就是「这台机器没有桌面可开」（没配直连地址），右栏另有一句话说明。
  if (!rt || rt.status !== 'ready' || !rt.novncUrl || !deskEmbeddable(rt.novncUrl)) return ''
  const abs = rt.novncUrl
  return abs + (abs.includes('?') ? '&' : '?') + 'resize=scale&reconnect=1&bell=false'
}

const DESK_EXPAND = ['M15 3h6v6', 'M9 21H3v-6', 'M21 3l-7 7', 'M3 21l7-7']
const DESK_SHRINK = ['M9 3v6H3', 'M15 21v-6h6', 'M3 9l7-7', 'M21 15l-7 7']

function deskLayer() {
  return document.getElementById('sw-deskl')
}

function unmountDesktop() {
  const layer = deskLayer()
  if (layer) layer.remove()
  const back = document.getElementById('sw-deskb')
  if (back) back.remove()
  if (deskObserver) {
    deskObserver.disconnect()
    deskObserver = null
  }
  deskSlotSeen = null
  deskMounted = null
  state.deskFull = false
}

function mountDesktop(url, seatId) {
  // 换一块屏不等于收起这块屏：重连时人可能正开着全屏，unmountDesktop 会把它清掉。
  const wasFull = state.deskFull
  unmountDesktop()
  const back = document.createElement('div')
  back.id = 'sw-deskb'
  back.className = 'sw-deskb'
  back.addEventListener('click', () => setDeskFull(false))
  const layer = document.createElement('div')
  layer.id = 'sw-deskl'
  layer.className = 'sw-deskl'
  /**
   * `sandbox` 不能省。框进来的是席位自己供的页面，没有沙箱它就能 `top.location = …`
   * 把整个 Gateway 界面换掉——原来那颗「打开桌面」是新标签页加 `rel=noopener`，没这
   * 条路；一内嵌就有了。
   *
   * **`allow-same-origin` 按地址跨不跨源来给，这一条判错就是一个漏洞。**
   *
   * · 现在的桌面地址一律是席位机器直连（`https://m001…/seats/<席位>/vnc/`，绝对地址），
   *   框和父页**本来就不同源**，加了也读不到父页的任何东西——而不加的话框是 opaque
   *   源，管家那张 path 限定的 cookie 带不上，noVNC 的静态资源和 WebSocket 一律 401。
   *   同一个可注册域下 SameSite=Lax 在子框里是放行的（SameSite 判的是 site 不是
   *   origin），所以这条路上加回来既安全又必要。
   * · Gateway 同域反代那条路（`/desktop/:seatId/…`，相对地址）**已经没有了**，但它当年
   *   立下的规矩还在：同源的框绝不能加 allow-same-origin——那等于没有沙箱，框里那页
   *   （席位自己供的 noVNC）能直接读父页的 sessionStorage，登录 JWT 就躺在里面。
   *
   * 判据只能是**这个 url 到底跨不跨源**，不能是「桌面只剩直连了」之类的旁证：万一
   * 哪天又出现一条同源的桌面地址，错的方向恰好是把 allow-same-origin 加到同源的框上。
   *
   * `allow-forms` 是留给「票里没带口令」时那个登录框的。
   */
  const sandbox = 'allow-scripts allow-forms' + (deskCrossOrigin(url) ? ' allow-same-origin' : '')
  layer.innerHTML = `
    <iframe class="sw-deskl-frame" title="${esc(t('桌面'))}" tabindex="-1"
      sandbox="${sandbox}" allow="clipboard-read; clipboard-write"></iframe>
    <button type="button" class="sw-deskl-shield" data-desk="open">
      <span class="sw-deskl-open">${svg(DESK_EXPAND, 15)}${esc(t('打开'))}</span>
    </button>
    <div class="sw-deskl-bar">
      <span class="sw-deskl-title"></span>
      <span class="sw-deskl-acts">
        <button type="button" class="sw-deskl-btn" data-desk="reload">${esc(t('重连'))}</button>
        <button type="button" class="btn btn-ghost btn-icon sw-deskl-close" data-desk="close"
          aria-label="${esc(t('收起桌面'))}" title="${esc(t('收起桌面'))}">${svg(DESK_SHRINK, 16)}</button>
      </span>
    </div>`
  layer.addEventListener('click', (e) => {
    const hit = e.target instanceof Element ? e.target.closest('[data-desk]') : null
    if (!hit) return
    const act = hit.getAttribute('data-desk')
    if (act === 'reload') void remountDesktop(true)
    else setDeskFull(act === 'open')
  })
  document.body.appendChild(back)
  document.body.appendChild(layer)
  // src 最后给：DOM 先进树，iframe 才只加载一次。
  const frame = layer.querySelector('.sw-deskl-frame')
  // 桌面壳的导航守卫只放行报过的席位机器（desktop nav.rs 的 allow_seat_desktop），
  // 先报再给 src；报失败也照给，最坏是这块屏被守卫送去系统浏览器，和以前一样。
  const seatGate = window.__SATUWORK_SEAT_DESKTOP__
  if (seatGate?.allow) {
    void Promise.resolve()
      .then(() => seatGate.allow(url))
      .catch(() => {})
      .then(() => {
        if (frame.isConnected) frame.src = url
      })
  } else frame.src = url
  deskMounted = { seat: seatId, url }
  state.deskFull = wasFull
}

/** 预览 ⇄ 全屏。几何变化加一段过渡，拖右栏宽度时不加——那是每帧都在动的。 */
function setDeskFull(on) {
  const layer = deskLayer()
  if (!layer || state.deskFull === on) return
  state.deskFull = on
  layer.style.transition = 'top .22s ease, left .22s ease, width .22s ease, height .22s ease, border-radius .22s ease'
  clearTimeout(setDeskFull.timer)
  setDeskFull.timer = setTimeout(() => {
    layer.style.transition = ''
  }, 260)
  syncDesktop()
  if (on) {
    const frame = layer.querySelector('.sw-deskl-frame')
    // 焦点交给 iframe，键盘才进得去桌面。noVNC 会自己抓键盘。
    if (frame) setTimeout(() => frame.focus(), 240)
  }
}

/**
 * 这块预览此刻**有没有人在看**。
 *
 * 三种「看不见」：标签页在后台、槽位不在（人已经不在对话页上了）、右栏把它滚出了
 * 可视区。全屏态盖在整个视口上，右栏那一刀裁不到它，所以单独放行。
 *
 * 判右栏那一刀用的是和 placeDesktop 里同一套算法——那边算出来是设 `visibility`，
 * 这边算出来是决定拆不拆。两处必须一致，否则会出现「看着是空的，但连接还在」。
 */
function deskVisibleNow() {
  if (document.hidden) return false
  const slot = document.getElementById('sw-desk-slot')
  if (!slot) return false
  if (deskSuspended ? deskSuspended.full : state.deskFull) return true
  const r = slot.getBoundingClientRect()
  if (!r.height) return false
  const body = slot.closest('.gw-aside-body')
  if (!body) return true
  const b = body.getBoundingClientRect()
  const top = Math.max(0, b.top - r.top)
  const bottom = Math.max(0, r.bottom - b.bottom)
  return top + bottom < r.height
}

/**
 * 看不见就起一个倒计时，到点把屏拆掉；重新看得见就取消倒计时、并把它接回来。
 *
 * 挂在滚动/尺寸变化和 visibilitychange 上。**解挂起走的是 syncDesktop**，不在这里
 * 直接 mount：换票、地址比对、观察器换绑那一串都在它那儿，这里再写一遍迟早会漂。
 */
function scheduleDeskSuspend() {
  if (deskVisibleNow()) {
    if (deskSuspendTimer) {
      clearTimeout(deskSuspendTimer)
      deskSuspendTimer = null
    }
    if (deskSuspended) syncDesktop()
    return
  }
  if (deskSuspended || deskSuspendTimer || !deskMounted) return
  deskSuspendTimer = setTimeout(() => {
    deskSuspendTimer = null
    // 这五秒里人可能又滚回来了，也可能整块屏已经因为别的原因没了。
    if (deskVisibleNow() || !deskMounted) return
    const full = !!state.deskFull
    unmountDesktop()
    deskSuspended = { full }
  }, DESK_IDLE_MS)
}

/**
 * 把常驻层对齐到右栏那个空槽上，顺带管挂载与卸载。render() 之后、以及右栏尺寸或
 * 滚动变化时都要调一次。
 */
function syncDesktop() {
  const slot = document.getElementById('sw-desk-slot')
  const url = deskUrl()
  const seatId = (state.desktopRuntime && state.desktopRuntime.seatId) || ''
  if (!slot || !url) {
    if (deskMounted) unmountDesktop()
    // 离开对话页 / 这块屏没了：挂起状态跟着作废。留着的话，下次回到这一页会被
    // 下面那条 `if (deskSuspended)` 挡住，而那时候未必有滚动事件来把它叫醒。
    deskSuspended = null
    if (deskSuspendTimer) {
      clearTimeout(deskSuspendTimer)
      deskSuspendTimer = null
    }
    return
  }
  /**
   * 挂起期间不重挂——但**每次都重新判一遍**，不能无条件 return。
   *
   * 回到对话页是 render() 调这里，不是滚动事件；那一刻 scheduleDeskSuspend 不一定
   * 会被调到，无条件 return 的话这块屏就再也回不来了。
   */
  if (deskSuspended) {
    if (!deskVisibleNow()) return
    state.deskFull = deskSuspended.full
    deskSuspended = null
  }
  // **地址也要比，不只是席位。** 重新部署之后席位 id 一个字都没变，变的是票；只比
  // 席位的话，那张新票永远用不上，屏上留着的是重装前那条已经死掉的连接。
  if (!deskMounted || deskMounted.seat !== seatId || deskMounted.url !== url) {
    void remountDesktop()
    return
  }
  if (slot !== deskSlotSeen) {
    // 整页重绘换了个新的槽元素：观察器要跟着换过去。
    deskSlotSeen = slot
    if (deskObserver) deskObserver.disconnect()
    if (typeof ResizeObserver === 'function') {
      deskObserver = new ResizeObserver(() => placeSoon())
      deskObserver.observe(slot)
    }
  }
  placeDesktop()
}

/**
 * 票过期了就先换一张再挂。
 *
 * 五分钟的票进了 iframe 的路径（不再是 cookie，见 gateway/src/desktop.ts），连上之后
 * WebSocket 一直活着；但 iframe **重新加载**的那一刻要重新验票，票馊了就是一页 401。
 *
 * `force` 是「重连」那颗按钮走的路：不管票看着新不新都换一张。掉过一次线之后
 * noVNC 自己重连不回来——它路径里那张票早过期了，升级请求一律 401——
 * 所以人得有一个确定能把它救回来的动作。
 */
async function remountDesktop(force = false) {
  if (mobileShell() || deskMounting) return
  deskMounting = true
  try {
    const want = chatBotIdNow()
    if (force || Date.now() - (state.desktopRuntimeAt || 0) > DESK_TICKET_FRESH_MS) {
      await loadDesktopRuntime(want)
      // 等票的这段时间里人切了 Bot：这一轮作废，新的那个 Bot 自己会触发一次。
      if (chatBotIdNow() !== want) return
    }
    const url = deskUrl()
    const slot = document.getElementById('sw-desk-slot')
    if (!url || !slot) {
      unmountDesktop()
      return
    }
    mountDesktop(url, (state.desktopRuntime && state.desktopRuntime.seatId) || '')
    deskSlotSeen = null
  } finally {
    deskMounting = false
  }
  syncDesktop()
  /**
   * **刚挂上就得判一次「有没有人在看」。**
   *
   * 挂起那套原本只挂在滚动/尺寸变化和 visibilitychange 上，而那三样都是**变化**。
   * 「挂上的那一刻就已经不可见」不产生任何变化，于是一条谁也没在看的流会一直开着：
   * 人把对话页留在后台标签页里、席位这时才部署完，SSE 触发 render() 就会走到这儿把
   * 屏挂上——后台标签页不再有 visibilitychange 转换，也不产生 scroll/resize，那条流
   * 一直开到人回来为止。右栏早就滚过预览位置、席位之后才 ready 是同一回事。
   */
  scheduleDeskSuspend()
}

function placeDesktop() {
  const layer = deskLayer()
  const back = document.getElementById('sw-deskb')
  if (!layer) return
  layer.classList.toggle('is-full', !!state.deskFull)
  if (back) back.classList.toggle('is-on', !!state.deskFull)
  const title = layer.querySelector('.sw-deskl-title')
  if (title) title.textContent = deskCaption()
  // 挡片只挡得住鼠标。iframe 本身还在 Tab 序里，键盘一路 Tab 过去就进了那块两百
  // 像素宽的预览，之后敲的每个字都送进了真桌面。预览态直接把它从 Tab 序里摘掉。
  const frame = layer.querySelector('.sw-deskl-frame')
  if (frame) {
    if (state.deskFull) frame.removeAttribute('tabindex')
    else frame.setAttribute('tabindex', '-1')
  }
  if (state.deskFull) {
    const vw = window.innerWidth || 0
    const vh = window.innerHeight || 0
    const pad = Math.round(Math.min(vw, vh) * 0.035)
    layer.style.top = pad + 'px'
    layer.style.left = pad + 'px'
    layer.style.width = vw - pad * 2 + 'px'
    layer.style.height = vh - pad * 2 + 'px'
    layer.style.clipPath = ''
    layer.style.visibility = ''
    return
  }
  const slot = document.getElementById('sw-desk-slot')
  if (!slot) {
    unmountDesktop()
    return
  }
  const r = slot.getBoundingClientRect()
  layer.style.top = r.top + 'px'
  layer.style.left = r.left + 'px'
  layer.style.width = r.width + 'px'
  layer.style.height = r.height + 'px'
  // 层是 fixed 的，不受右栏的 overflow 裁剪——右栏一滚，它会浮到别的东西上面去。
  // 自己按右栏可视区裁一刀。
  const body = slot.closest('.gw-aside-body')
  if (!body || !r.height) {
    layer.style.clipPath = ''
    layer.style.visibility = r.height ? '' : 'hidden'
    return
  }
  const b = body.getBoundingClientRect()
  const top = Math.max(0, b.top - r.top)
  const bottom = Math.max(0, r.bottom - b.bottom)
  layer.style.visibility = top + bottom >= r.height ? 'hidden' : ''
  layer.style.clipPath = `inset(${top}px 0px ${bottom}px 0px round 10px)`
}

/**
 * 一帧最多重排一次。
 *
 * 下面那个 scroll 是捕获阶段挂在 window 上的——消息流每吐一段就自动跟随一次，那些
 * 滚动全从这儿过。直接调 placeDesktop 的话，每一次都要量两个 getBoundingClientRect
 * 再写六条内联样式，等于在流式输出最吃帧的时候反复强制同步布局。
 */
function placeSoon() {
  if (deskPlacePending) return
  if (typeof requestAnimationFrame !== 'function') {
    scheduleDeskSuspend()
    placeDesktop()
    return
  }
  deskPlacePending = true
  requestAnimationFrame(() => {
    deskPlacePending = false
    // **先判挂起，再摆位置。** 挂起期间层已经不在了，placeDesktop 第一行就 return，
    // 光靠它把不回来——接回来这件事只能由 scheduleDeskSuspend 发起。
    scheduleDeskSuspend()
    placeDesktop()
  })
}

// 窗口尺寸、右栏滚动都会挪动那个槽。滚动用捕获，因为滚的是右栏自己而不是 window。
window.addEventListener('resize', placeSoon)
window.addEventListener('scroll', placeSoon, true)
/**
 * 回到前台时，离开得够久就重挂。
 *
 * 合盖、切标签页几十分钟回来，那条 WebSocket 基本已经断了，而 noVNC 的自动重连注定
 * 失败——cookie 里那张票只活五分钟。这时候重挂的代价是一秒钟的黑屏，不重挂的代价是
 * 一块永远回不来的死屏。
 */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    deskHiddenAt = Date.now()
    // 切到后台就开始倒计时拆屏。浏览器不会替我们暂停那条 WebSocket，不拆就是在
    // 一个没人看的标签页里继续收像素。
    scheduleDeskSuspend()
    return
  }
  const away = deskHiddenAt ? Date.now() - deskHiddenAt : 0
  deskHiddenAt = 0
  // 回到前台：挂起了就在这儿接回来（syncDesktop 会按票的岁数决定要不要先换票）。
  scheduleDeskSuspend()
  if (deskMounted && away > DESK_TICKET_FRESH_MS) void remountDesktop(true)
  /**
   * 那条聊天流也要认一遍。
   *
   * 后台标签页里 setTimeout 会被节流到分钟级，退避重试因此更容易走到头；而合盖一小时
   * 回来，中间那一跳早把连接掐了。回到前台是「人马上要看这一屏」的时刻，没人在听就
   * 当场接回来——带 after 游标，睡着那段时间的回复会一起补上。
   */
  if (state.chatSessionId) reviveChatStream(state.chatSessionId, state.chatBotId)
  // 会话本身都还没拿到（那条重试链在后台被节流着走完了、认输了）：也在这儿再试一次。
  // 不然人回到这一页看到的是一句「实例还没接上」，而没有任何人在替他重试。
  //
  // **只在对话页上做。** state.chatBotId 在人走开之后仍然留着（切走不掐流，见
  // ensureChatSession），拿它在别的页上重试的话：白敲一串接口不说，那条链认输时会
  // render() 整页——正在填的表单当场被换掉，而起因是一个他此刻根本没在看的 Bot。
  else if (state.chatBotId && isChatPath(state.path)) void ensureChatSession(state.chatBotId).catch(() => {})
})
window.addEventListener('keydown', (e) => {
  // 焦点在 iframe 里时这一条收不到（noVNC 把键盘抓走了），所以标题栏那颗收起按钮
  // 必须一直看得见——Esc 只是顺手。
  if (e.key === 'Escape' && state.deskFull) setDeskFull(false)
})

/**
 * 运行日志。
 *
 * 没有 SSH 的时候，「bot 到底卡在哪一步」谁也看不见——诊断快照能说「它活着」，
 * 说不了「它在干什么」。而这一层最贵的故障恰恰都不报错：单元 active、端口有人听，
 * 只是那一轮永远不结束。
 *
 * 走 SSE，和聊天一条路子。机器票留在 Gateway，浏览器只带自己的席位票；日志在管家
 * 那侧就过了脱敏（席位票、API key、VNC 口令一律盖掉）。
 */
const LOG_MAX = 2000
let logAbort = null

function stopLogStream() {
  if (logAbort) {
    try {
      logAbort.abort()
    } catch {}
  }
  logAbort = null
}

/**
 * 开一条日志流。`source` 是面板清单里的那一项：`{ key, label, direct }`，direct 是
 * Gateway 上**领票**的地址（/runtime/logs/direct?botId=… 或 /platform/…/logs/direct）。
 *
 * 两步走：先 api('GET', direct) 拿 `{ url, ticket }`——url 是机器管家上的 /logs 或
 * /seats/<id>/logs，ticket 是一张 5 分钟的票；再拿这张票**直接打那台机器**。Gateway
 * 不再替浏览器转这条 SSE（老的 ?follow=1 那条路已经 410）：它是跟对话流一样的长连接，
 * Gateway 要做成无状态的，长连接一条都不能留在它身上。
 *
 * 用的是裸 fetch 而不是 swFetch：地址是绝对的、票也不是登录票，本地改道那套逻辑
 * 一条都不适用。机器没配 directUrl、或管家太旧，领票那一步就会 409 带中文原因，
 * 原样摆进面板——和以前「连不上」摆在同一个位置。
 */
/**
 * 浏览器直连管家失败时说什么。fetch 抛错分不出是网络不通还是跨源被拦，可后一种有个一眼就能认出的
 * 形状：管家只放行它配对时的 Gateway 地址（`gatewayOrigin`，领票时 Gateway 给的），而这一页是从
 * 别的地址打开的（本地最常见的是 localhost 对 192.168.64.1）。对得上这个形状就直说该换哪个地址。
 * 桌面端的页面源（satu://、tauri:// 之类）管家另外认，不算不一致。
 */
function directFailText(gatewayOrigin) {
  const here = location.origin
  const web = location.protocol === 'http:' || location.protocol === 'https:'
  if (gatewayOrigin && web && here !== gatewayOrigin) {
    return t(
      `连不上机器管家：这台机器只放行从 ${gatewayOrigin} 打开的页面，你现在是从 ${here} 打开的。换成 ${gatewayOrigin} 再看。`,
      `Cannot reach the machine manager: it only accepts pages opened from ${gatewayOrigin}, but this page is on ${here}. Open it from ${gatewayOrigin} instead.`,
    )
  }
  return t('连不上机器管家')
}

async function startLogStream(source) {
  stopLogStream()
  const ac = new AbortController()
  logAbort = ac
  state.logLines = []
  state.logError = ''
  paintLogs()
  const direct = source && typeof source === 'object' ? source.direct : source
  let ticket
  try {
    ticket = await api('GET', direct)
  } catch (err) {
    if (!ac.signal.aborted) {
      state.logError = (err && err.message) || t('拿不到日志')
      paintLogs()
    }
    return
  }
  // 领票那一趟是 await 的，人可能在这期间已经关了面板或换了来源。
  if (ac.signal.aborted) return
  if (!ticket || !ticket.url || !ticket.ticket) {
    state.logError = t('拿不到日志')
    paintLogs()
    return
  }
  let res
  try {
    res = await fetch(ticket.url + '?lines=300&follow=1', {
      headers: { accept: 'text/event-stream', authorization: 'Bearer ' + ticket.ticket },
      signal: ac.signal,
    })
  } catch {
    if (!ac.signal.aborted) {
      state.logError = directFailText(ticket.gatewayOrigin)
      paintLogs()
    }
    return
  }
  if (!res.ok || !res.body) {
    state.logError = (await res.text().catch(() => '')) || t('拿不到日志')
    paintLogs()
    return
  }
  try {
    for await (const ev of sseEvents(res.body.getReader(), () => ac.signal.aborted)) {
      // 同 startRosterStream：中止后仍在路上的那一块不该再画进面板。
      if (ac.signal.aborted) break
      try {
        if (ev.error) state.logError = String(ev.error)
        else if (typeof ev.line === 'string') state.logLines.push(ev.line)
      } catch {}
      // 不封顶的话，一个话多的 bot 能把标签页吃垮。
      //
      // 封顶和重绘从「每帧一次」改成了「每条一次」：两件事都幂等，而重绘本来就靠
      // scheduleLogPaint 合并到一个动画帧，多问几次不会多画一次。
      if (state.logLines.length > LOG_MAX) state.logLines.splice(0, state.logLines.length - LOG_MAX)
      scheduleLogPaint()
    }
  } catch {
    /* 关面板 / 断线 */
  }
  if (logAbort === ac) logAbort = null
}

let logPaintQueued = false

/** 和正文一样合并到一帧：日志可以刷得很快，一行一次重绘顶不住。 */
function scheduleLogPaint() {
  if (logPaintQueued) return
  logPaintQueued = true
  const run = () => {
    logPaintQueued = false
    paintLogs()
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
  else setTimeout(run, 16)
}

function paintLogs() {
  const box = document.getElementById('log-body')
  if (!box) return
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight <= 60
  box.textContent = state.logError
    ? state.logError
    : state.logLines.length
      ? state.logLines.join('\n')
      : t('还没有日志')
  if (stick) box.scrollTop = box.scrollHeight
}

/**
 * 日志面板。一个面板管两处：
 *   · 员工侧的运行环境——只有自己这个 Bot 一个来源；
 *   · 平台侧公司详情的运行机器——管家自己，加上这台机器上的每个席位。
 *
 * state.logsOpen = { title, active, sources: [{ key, label, direct }] }
 * direct 是领票的 Gateway 地址，不是日志地址——见 startLogStream。
 */
/** 开面板并接上第一个来源。两处入口都走它，别各写一份。 */
function openLogs(title, sources) {
  state.logsOpen = { title, sources, active: sources[0] && sources[0].key }
  state.logLines = []
  state.logError = ''
  render()
  // 先 render 再开流：paintLogs 往 #log-body 里填，那个节点得先存在。
  if (sources[0]) void startLogStream(sources[0])
}

function switchLogSource(key) {
  const box = state.logsOpen
  if (!box) return
  const hit = (box.sources || []).find((x) => x.key === key)
  if (!hit || key === box.active) return
  stopLogStream()
  box.active = key
  state.logLines = []
  state.logError = ''
  render()
  // 每换一个来源都重新领票：票是按 seat 签的，换来源就是换票。
  void startLogStream(hit)
}
