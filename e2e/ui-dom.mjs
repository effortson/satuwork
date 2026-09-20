/**
 * 把 gateway/ui/app.js 装进一层 DOM 垫片里跑。
 *
 * **不是真浏览器**：它验的是「同一份 app.js 拿真 Gateway 的响应，渲染出什么 HTML」。
 * 布局、CSS、真事件分发这些验不到；但 boot 走哪条分支、某个视图有没有把正文渲染出来
 * 这类逻辑错，正是在这一层暴露的——那两个 bug（废票挡住初始化页、审计每条都渲染成
 * 「（空）」）都属于这一类。
 *
 * app.js 是 classic script（index.html 里就是普通 <script src>），所以能直接塞进
 * new Function 里执行；顶层那些 document.getElementById('app') 由垫片接住。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

function makeStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  }
}

/**
 * app.js 的两个委托处理器都靠 `instanceof HTMLInputElement / HTMLSelectElement`
 * 分流，node 里没有这几个构造器。这里补上最小的一套，好让 change / click
 * 真的能派发过去——只调用内部函数的话，「分支根本没接上」这类错测不出来：
 * 倍率输入框最早就是接在「只收 select」那道关卡后面，函数本身是好的，点了没反应。
 */
class Element {
  constructor(attrs = {}, value = '') {
    this._attrs = attrs
    this.value = value
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false }
  }
  getAttribute(k) {
    return k in this._attrs ? this._attrs[k] : null
  }
  setAttribute(k, v) {
    this._attrs[k] = String(v)
  }
  /**
   * 量尺寸。**全零**：测里造的元素没有布局，也不该假装有。
   *
   * 读它的地方判的都是「这颗按钮离屏幕底还有多远，菜单要不要往上弹」（app.js 的
   * menu-toggle）——全零的意思就是「在最上面」，于是一律往下弹。菜单**弹哪个方向**
   * 本来也不是这一层验得了的（这里没有 CSS、没有布局），这个方法只是让那条处理器
   * 跑得下去，好验它真正在做的事：开关状态和菜单里那几条。
   */
  getBoundingClientRect() {
    return { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0, x: 0, y: 0 }
  }
  /** 测里造的元素都是光杆一个，没有祖先——自己带 data-act 就算命中。 */
  closest(sel) {
    if (sel === '[data-act]') return this.getAttribute('data-act') == null ? null : this
    return null
  }
}
class HTMLInputElement extends Element {}
class HTMLSelectElement extends Element {}
class HTMLTextAreaElement extends Element {}
class HTMLFormElement extends Element {}

/** 造一个能喂给处理器的元素。kind 决定它会被哪个 instanceof 认走。 */
export function el(kind, attrs = {}, value = '') {
  const C = { input: HTMLInputElement, select: HTMLSelectElement, textarea: HTMLTextAreaElement, form: HTMLFormElement }[kind] || Element
  return new C(attrs, value)
}

/**
 * 一个能数「被重绘了几次」的元素桩。
 *
 * 合并重绘那类断言需要观测「innerHTML 被写了多少次」，光看最终 HTML 看不出来。
 */
function countingStub() {
  return {
    _html: '',
    writes: 0,
    get innerHTML() {
      return this._html
    },
    set innerHTML(v) {
      this._html = v
      this.writes += 1
    },
    textContent: '',
    scrollTop: 0,
    scrollHeight: 0,
    value: '',
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {},
    getAttribute: () => null,
    focus() {},
    style: {},
  }
}

/**
 * 只够 app.js 跑起来的那点 DOM。缺什么它自己会抛，不会静默。
 *
 * `stubIds` 里的 id 会拿到一个持久的 countingStub。默认为空——`getElementById`
 * 返回 null 是现有测试依赖的行为（`if (thread)` 那类分支会被跳过），不能默认改掉。
 */
function makeDom(stubIds = [], copied = []) {
  // app.js 给 'input' 挂了不止一个处理器，Map 存单个会把先挂的那个吞掉。
  const listeners = new Map()
  // 内容区那个滚动容器。app.js 重绘时会读它、再把位置贴回去。
  const page = { scrollTop: 0 }
  const app = {
    _html: '',
    get innerHTML() {
      return this._html
    },
    // 换 innerHTML 等于把内容区整块换掉：真浏览器里新出来的 .gw-page 从 0 开始，
    // 垫片也得跟着归零——不然「重绘保住滚动位置」那条断言测的是个假象。
    set innerHTML(v) {
      this._html = v
      page.scrollTop = 0
    },
    scrollTop: 0,
    scrollHeight: 0,
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(fn)
    },
  }
  const stub = { innerHTML: '', value: '', textContent: '', classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, getAttribute: () => null, focus() {}, style: {} }
  const stubs = new Map(stubIds.map((id) => [id, countingStub()]))
  // execCommand('copy') 复制的是「当前选中的那个东西」，所以垫片得真的记住 select()
  // 选中了谁。没有这一点，render.js 里那条兜底复制（非安全上下文下唯一能用的一条，
  // 而内网 http 部署就是那个常态）在测里根本跑不起来，只能假装它还在。
  let selected = null
  const body = {
    ...stub,
    children: [],
    appendChild(node) {
      this.children.push(node)
      return node
    },
  }
  const createElement = () => {
    const node = { ...stub }
    node.select = () => {
      selected = node
    }
    node.setSelectionRange = () => {}
    node.remove = () => {
      body.children = body.children.filter((c) => c !== node)
    }
    return node
  }
  const document = {
    getElementById: (id) => (id === 'app' ? app : (stubs.get(id) ?? null)),
    querySelector: (sel) => (sel === '.gw-page' ? page : null),
    querySelectorAll: () => [],
    documentElement: { setAttribute() {}, classList: { add() {}, remove() {}, toggle() {} }, style: {} },
    createElement,
    body,
    activeElement: null,
    execCommand: (cmd) => {
      if (cmd !== 'copy' || !selected || !body.children.includes(selected)) return false
      copied.push(String(selected.value ?? ''))
      return true
    },
    addEventListener() {},
  }
  return { document, app, page, listeners, stubs, body }
}

/**
 * 前端源码，按**线上真正的加载顺序**拼成一份。
 *
 * 顺序不能在这里另写一份：那样它迟早和 index.html 漂开，而漂开的表现是「测试全绿、
 * 浏览器里白屏」。所以直接读 index.html 里那组 `data-app-part`——它就是线上那串
 * <script>，改了哪儿、加了哪个分片，垫片自动跟上。
 */
export function uiSource(uiDir) {
  const html = readFileSync(join(uiDir, 'index.html'), 'utf8')
  const parts = [...html.matchAll(/<script src="\/([^"]+)"[^>]*\bdata-app-part\b/g)].map((m) => m[1])
  if (!parts.length) throw new Error(`在 ${uiDir}/index.html 里找不到 data-app-part 脚本`)
  return parts.map((f) => readFileSync(join(uiDir, f), 'utf8')).join('\n')
}

/**
 * 载入前端。
 *
 * appPath 指的是分片里的任意一个（一般是 app.js），真正装进来的是它旁边那一整串——
 * 见 uiSource。末尾那句 boot() 去掉，由调用方决定什么时候起，否则一 import 就开始打
 * 网络，断言没法安排在它前面。
 */
export function loadApp({ appPath, base, token, fetchImpl, stubIds, desktop = false, persistentStorage, localBotBridge, path = '/', secureContext = true }) {
  const raw = uiSource(dirname(appPath))
  const src = raw.replace(/\nboot\(\)\s*$/, '\n')
  // 复制过的东西都落这儿，两条路（navigator.clipboard 和 execCommand）都记。
  const copied = []
  const { document, app, page, listeners, stubs, body } = makeDom(stubIds, copied)
  const sessionStorage = makeStorage()
  // desktop 重开窗口时 sessionStorage 是一份新的，localStorage 仍是同一份。测试把上一
  // 次的 persistentStorage 递回来，才能真的覆盖「关掉再打开」而不只是同页 reload。
  const localStorage = persistentStorage || makeStorage()
  if (token) sessionStorage.setItem(tokenKey(appPath), token)

  // 进来时地址栏上是什么。`/` 和 `/login` 在没登录时画的是两屏（见 render.js 的
  // anonView），所以这一条得能由测试指定。
  const location = { pathname: path, search: '', hash: '', href: base + path }
  const history = {
    replaceState: (_s, _t, url) => {
      if (url) location.pathname = String(url).split('?')[0]
    },
    pushState: (_s, _t, url) => {
      if (url) location.pathname = String(url).split('?')[0]
    },
  }
  // app.js 里是相对路径，node 的 fetch 只收绝对地址。
  // fetchImpl 给测试用来接管某几条请求（聊天 SSE 要能精确控制什么时候来帧、什么时候断）。
  const shimFetch = (path, init) => (fetchImpl ? fetchImpl(path, init) : fetch(base + path, init))

  const wrapper = new Function(
    'document',
    'window',
    'location',
    'history',
    'sessionStorage',
    'localStorage',
    'matchMedia',
    // app.js 里有几处直接读裸的 innerHeight（判浮层往上还是往下弹）。node 里没有
    // 这个全局，不补的话那几条处理器一跑就是 ReferenceError——而且是**跑到才炸**，
    // 平时一声不响。
    'innerHeight',
    'navigator',
    'fetch',
    'CSS',
    'Element',
    'HTMLInputElement',
    'HTMLSelectElement',
    'HTMLTextAreaElement',
    'HTMLFormElement',
    `${src}\n;return { boot, render, state, api, auditTranscript, messageText, setToken, clearToken, token, onSetup, testLlm, saveSettings, savePriceMultiplier, saveCustomProvider, saveCustomModel, loadCustomProviders, runConfirm, statsWindow, chargesWindow, usageRangeMs, loadStats, loadCharges, loadConversationAudits, catalogBase, pathAllowed, machineHead, readOnlyItem, startChatStream, stopChatStream, paintChat, ensureChatSession, sendChat, fold, threadRows, paintRowTime, refreshRoutine, refreshRoutineList, routineShot, loadOlderChat, hydrateChat, pushBotEvent, botStreamOf, resetBotStream, trimBotStreams, BOT_BUCKET_MAX, startRosterStream, stopRosterStream, noteRosterFrame, openBotStreams, BOT_STREAM_MAX, chatPages, CHAT_TAIL_TURNS, STREAM_TAIL_TURNS, CHAT_RETRY_MAX, sweepSilentStreams, STREAM_SILENT_MS, streamPulse, loadWebTools, saveWebTools, saveWebPrice, testWebBackend, mentionQueryAt, paintChatMentions, paintChatQueue, paintMentionPick, takeMention, chatQueues, idleTimers, flushHeldSend, clearHeldSend, seatRestarted, retryChatSession, SESSION_RETRY_MAX, approvalState, approvalChipHtml, approvalPop, approvalDead, approvalHtml, toolPopBody, handoffHtml, handoffDoneHtml, handoffsPage, handoffBell, applyHandoffSnapshot, settleDot, handoffDead, handoffRow, stepShots, stepMoreHtml, MAX_STEP_SHOTS, knownFiles, fileCands, fileHits, readFiles, workspacePanel, maybeLivePreview, openPreview, previewBody, liveLamp, composerTip, stopTipText, abortChat, seatLink, seatLinkOf, linkDown, machineDownBanner, myBotPage, storedMemories, seatStage, chatDeployPrompt, installProgressBody, ensureDeployWatch, pollDeployProgress, uploadTargetOf, uploadChatFile }`,
  )

  /**
   * `window.open` 开出来的那些标签页。
   *
   * 授权那一路必须在**点击的同一拍**里把标签页开出来（见 pages-connectors.js 的
   * conn-add-account），拿到地址再送过去。没有这个桩就只能验到「没跳走」，验不到
   * 「真的开了一页、地址送对了」——而那正是这条路的全部。
   */
  const windowOpens = []
  const windowStub = {
    __SATUWORK_DESKTOP__: desktop,
    __SATUWORK_LOCAL_BOT__: localBotBridge,
    addEventListener() {},
    satuUnzip: null,
    location,
    history,
    open: (url = '') => {
      const tab = {
        closed: false,
        opener: {},
        location: { href: url },
        close() {
          this.closed = true
        },
      }
      windowOpens.push(tab)
      return tab
    },
  }
  const api = wrapper(
    document,
    windowStub,
    location,
    history,
    sessionStorage,
    localStorage,
    () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    900,
    // secureContext: false = 内网 http 那种页面。navigator.clipboard 在规范里标了
    // [SecureContext]，那种页面上整个对象都不存在——不是 writeText 被拒，是它压根没挂
    // 出来。这是「复制失败」最常见的成因，所以垫片得能演出来。
    { userAgent: 'satuwork-ui-smoke', ...(secureContext ? { clipboard: { writeText: async (v) => void copied.push(String(v)) } } : {}) },
    shimFetch,
    { escape: (s) => String(s) },
    Element,
    HTMLInputElement,
    HTMLSelectElement,
    HTMLTextAreaElement,
    HTMLFormElement,
  )

  /** 把一个元素当事件目标派发给 app.js 挂的处理器，走的是真的分流逻辑。 */
  const fire = async (type, target) => {
    for (const fn of listeners.get(type) || []) {
      await fn({ type, target, preventDefault() {}, stopPropagation() {} })
    }
  }

  return { ...api, app, page, listeners, stubs, fire, sessionStorage, localStorage, location, windowOpens, copied, body, html: () => app.innerHTML }
}

/**
 * 一条可控的假 SSE 响应。
 *
 * app.js 走的是 `res.body.getReader()`，所以只要给出一个能 read 的 reader 就够了。
 * `push` 发一帧，`close` 正常收流。什么时候发、什么时候断由测试说了算——聊天流那几条
 * 逻辑（建连失败放闩、退避档位、合并重绘）都得靠精确的时序才测得出来。
 */
export function fakeSse() {
  const queue = []
  const encoder = new TextEncoder()
  let waiting = null
  let ended = false
  const pump = () => {
    if (!waiting) return
    if (queue.length) {
      const value = queue.shift()
      const resolve = waiting
      waiting = null
      resolve({ done: false, value })
    } else if (ended) {
      const resolve = waiting
      waiting = null
      resolve({ done: true, value: undefined })
    }
  }
  return {
    push(obj) {
      queue.push(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))
      pump()
    },
    close() {
      ended = true
      pump()
    },
    response: {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () =>
            new Promise((resolve) => {
              waiting = resolve
              pump()
            }),
        }),
      },
      text: async () => '',
    },
  }
}

/** 前端读 token 的那个 key，垫片要和它对上。写死会悄悄失效，所以从源码里取。 */
export function tokenKey(appPath) {
  const m = uiSource(dirname(appPath)).match(/const TOKEN_KEY = '([^']+)'/)
  if (!m) throw new Error('在前端源码里找不到 TOKEN_KEY')
  return m[1]
}
