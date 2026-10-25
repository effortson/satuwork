/** 文件预览（图片 / PDF / Markdown / HTML / 文本 / Office），和在图上涂蒙版局部重绘。原先在 chat.js 里，拆出来只是搬家（顺序见 index.html）。 */
/**
 * 打开一个工作区文件的预览。
 *
 * **先取成 blob 再显示**，而不是把 URL 直接给 <img src>：Gateway 认 Authorization 头，
 * 而 src= 发出去的请求带不了头。顺带还有个好处——blob: 是 opaque origin，即使哪天
 * 白名单放进了带脚本的类型，它也够不着 Gateway 这一侧的登录态。
 *
 * 大文件不预览：整个读进内存只为看一眼不值当，给下载就行。判断用响应头里的
 * content-length，在读 body **之前**——否则「太大所以不看」的代价是先下完它。
 */
/* 预览方式按扩展名分（文本 / 文档 / 浏览器里能渲染的 Office），表和判法在 core/src/chat/preview.ts。 */
const PREVIEW_WEB_KIND = SatuCore.PREVIEW_WEB_KIND

/** 浏览器里渲染 Office 的那一页。Gateway 和桌面壳都认 `/ui/` 前缀（http.ts 的 serveUi、main.rs 的 serve_ui）。 */
const OFFICE_VIEW_SRC = '/ui/office-view.html'

function extOf(name) {
  return SatuCore.extOf(name)
}

/** 这个文件用哪种方式看。**按扩展名判，不按 content-type**（理由见 core 那边）。 */
function previewKindOf(name, type) {
  return SatuCore.previewKindOf(name, type)
}

/** 文本类不该按图片那个尺度收：一份 2MB 的日志已经没人会在预览里读了。 */
const PREVIEW_TEXT_MAX = 2 * 1024 * 1024

/**
 * 每轮、每个 HTML 只自动打开一次。人把预览关掉之后，这一轮后续 patch 不能又把它顶回来；
 * 下一轮重新生成同一路径则仍会打开。集合只记最近一小段，避免开几周的标签页只涨不落。
 */
const AUTO_PREVIEW_MAX = 200
const autoPreviewed = new Set()

function rememberAutoPreview(key) {
  autoPreviewed.add(key)
  while (autoPreviewed.size > AUTO_PREVIEW_MAX) autoPreviewed.delete(autoPreviewed.values().next().value)
}

/** 实时产出 HTML 时自动打开；已经打开的任意产出文件被再次写入时自动重载。 */
function maybeLivePreview(event) {
  if (!event || event.type !== 'tool/result' || !state.chatSessionId) return false
  const data = event.data || {}
  const files = Array.isArray(data.files) ? data.files.filter((file) => file && file.path) : []
  if (!files.length) return false
  const current = shownPreview()
  if (current) {
    const changed = files.find((file) => file.path === current.path)
    if (!changed) return false
    void openPreview(changed.path, changed.name || current.name || changed.path, { mode: current.mode })
    return true
  }
  const html = files.find((file) => previewKindOf(file.name || file.path, '') === 'html')
  if (!html) return false
  /**
   * 右栏收着就不自己弹。预览现在摆在右栏里，人把栏收起来就是不想让那一块占地方；Bot
   * 每产出一个 HTML 就把栏撑开一次，他得每一轮都去点一次收起。文件卡片还在对话里，
   * 想看点一下就出来。（已经开着的那份照旧跟着刷新，见上面。）
   */
  if (!asideOpen()) return false
  const key = `${state.chatSessionId}:${Number(data.turn) || 0}:${html.path}`
  if (autoPreviewed.has(key)) return false
  rememberAutoPreview(key)
  void openPreview(html.path, html.name || html.path)
  return true
}

/**
 * 预览是哪一条会话里的文件。换了 Bot、换了会话，那个路径在新会话的工作区里不是同一个
 * 文件（多半根本不存在），「下载」也会按新会话去取——所以那一份就不该再摆着。
 */
let previewSession = ''
/** 预览是哪颗 Bot 的。换页时用它判「人是不是离开了这颗 Bot」，见 leavePreview。 */
let previewBot = ''

/** 右栏眼下该摆的那份预览；不在对话页、或者已经换了会话，就是没有。 */
function shownPreview() {
  const p = state.preview
  if (!p || !onChatPage()) return null
  return previewSession && previewSession === state.chatSessionId ? p : null
}

async function openPreview(path, name, options = {}) {
  if (!state.chatSessionId) return
  revokePreview()
  previewSession = state.chatSessionId
  previewBot = state.chatBotId || ''
  const kind = previewKindOf(name || path, '')
  const mode = options.mode === 'source' ? 'source' : 'view'
  /**
   * Office 文档不取原文件：浏览器看不了那段字节，取它只为了一个大小不值一趟往返
   * （经 Gateway 就是一次函数调用加一次席位读流）。直接要渲染好的 PDF，要不到退回文本；
   * 太大由席位那头说（413 / 提取那条的说明）。
   *
   * 就算停在「原文」页（实时预览重开时会带着原来的 mode）也先要 PDF：没有它就没有
   * 「预览」页签，人切不回去。
   */
  if (kind === 'doc') {
    state.preview = { path, name, loading: false, url: '', type: '', size: 0, error: '', kind, mode, docLoading: 'pdf' }
    render()
    void fetchDocPdf(path, name)
    return
  }
  state.preview = { path, name, loading: true, url: '', type: '', size: 0, error: '', kind, mode }
  render()
  const url = '/runtime/sessions/' + encodeURIComponent(state.chatSessionId) + '/files?path=' + encodeURIComponent(path)
  const ac = new AbortController()
  state.preview.abort = ac
  try {
    const res = await swFetch(url, { headers: authHeaders(), signal: ac.signal })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let json = null
      try {
        json = text ? JSON.parse(text) : null
      } catch {}
      throw new Error(errText((json && json.error) || 'HTTP ' + res.status))
    }
    const type = (res.headers.get('content-type') || '').split(';')[0].trim()
    const size = Number(res.headers.get('content-length') || 0)
    const k = kind || previewKindOf(name || path, type)
    const cap = k === 'markdown' || k === 'html' || k === 'text' ? PREVIEW_TEXT_MAX : CHAT_PREVIEW_MAX
    /**
     * **不再拿 content-disposition 当「能不能看」的判据。**
     *
     * 席位那张白名单回答的是「这段字节能不能带着自己的 MIME 在浏览器里跑起来」——
     * HTML 不在里面，理由是它带得动 `<script>`，内联渲染等于让上传者在 Gateway 的源
     * 上执行代码。那个理由是对的，白名单不动。
     *
     * 但**我们并不是让它在 Gateway 的源上跑**：字节取回来变成 blob，塞进一个
     * `sandbox` 不带任何 allow-* 的 iframe——脚本、表单、同源、导航全关，里面的
     * `<script>` 一行都不会执行。Gateway 那一跳还压了一条同样含义的 CSP
     * （见 lib/runtime.ts 的 proxyDownload），直接把文件地址粘到地址栏也一样跑不起来。
     *
     * 所以这里改成按**扩展名**决定看法，只有真的没法看的（未知格式）才回落到下载。
     */
    if (!k || (size && size > cap)) {
      ac.abort()
      if (!state.preview || state.preview.path !== path) return
      state.preview = { path, name, loading: false, url: '', type, size, error: '', kind: k, mode, tooBig: true }
      render()
      return
    }
    const blob = await res.blob()
    if (!state.preview || state.preview.path !== path) return
    const next = { path, name, loading: false, url: '', type, size: blob.size, error: '', kind: k, mode }
    if (k === 'markdown' || k === 'html' || k === 'text') {
      next.text = await blob.text()
      // HTML 要一个**自称 text/html** 的 blob，iframe 才会当页面渲染。原始响应是
      // octet-stream（白名单没放行它），照搬只会得到一个下载。重打类型是安全的：
      // 保护来自 iframe 的 sandbox，不来自这个 MIME。
      // **charset 不能省。** 这个 blob 是从 JS 字符串造的，就是 UTF-8；不写的话浏览器
      // 会按自己的默认编码猜，中文当场变成一片乱码（实测就是这样）。
      if (k === 'html') next.url = URL.createObjectURL(new Blob([next.text], { type: 'text/html; charset=utf-8' }))
    } else if (k === 'pdf') {
      // **类型钉死。** 下面那个 iframe 不带 sandbox（不带才有 PDF 阅读器，见
      // previewBody），所以绝不能让这段字节有机会被当成 HTML 解释。blob 的 type
      // 就是浏览器认的 Content-Type：写死 application/pdf，一个改名成 .pdf 的
      // HTML 只会交给 PDF 阅读器然后解析失败，而不是变成一个页面跑起来。
      next.url = URL.createObjectURL(new Blob([await blob.arrayBuffer()], { type: 'application/pdf' }))
    } else {
      next.url = URL.createObjectURL(blob)
    }
    state.preview = next
  } catch (err) {
    if (ac.signal.aborted) return
    if (!state.preview || state.preview.path !== path) return
    state.preview = { path, name, loading: false, url: '', type: '', size: 0, error: err.message, kind, mode }
  }
  // 刚画出来的 Markdown 里的代码块 / 公式 / mermaid，由内容层换内容时一起过一遍（syncPreview）。
  render()
}

/**
 * Word / Excel / PPT：浏览器打不开，让席位提取成 Markdown 再看。
 *
 * 走的是 `read` 工具用的同一套提取（bot 的 workspace/extract.ts），所以这里看到的
 * 和模型读到的是同一份东西——这一点本身就有用：内容对不上时能一眼看出是提取的问题
 * 还是模型的问题。
 *
 * **老席位没有这个接口**，那时候如实退回「下载下来看吧」，而不是转个圈就空在那儿。
 */
async function fetchDocText(path, name) {
  const url =
    '/runtime/sessions/' + encodeURIComponent(state.chatSessionId) + '/files?path=' + encodeURIComponent(path) + '&as=text'
  try {
    const res = await swFetch(url, { headers: authHeaders({ accept: 'application/json' }) })
    // 415 是「这种格式提取不了」（.doc / .xls 这些老格式），席位那句原话就是答案；
    // 别的失败才可能是「席位太老、没有这个接口」。
    if (res.status === 415) throw Object.assign(new Error(), { unsupported: true })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    if (!state.preview || state.preview.path !== path) return
    state.preview.docLoading = false
    state.preview.text = String((data && data.text) || '')
    state.preview.docNote = String((data && data.note) || '')
    if (!state.preview.text && !state.preview.url) state.preview.tooBig = true
  } catch (err) {
    if (!state.preview || state.preview.path !== path) return
    state.preview.docLoading = false
    state.preview.text = ''
    // 有渲染好的 PDF 时只是「原文」页没东西，不能把整个预览判成看不了。
    if (!state.preview.url) state.preview.tooBig = true
    // 「席位太老」只在 PDF 也没要到时才可能成立：PDF 要到了，席位就是新的，失败是别的原因。
    state.preview.docNote = err && err.unsupported
      ? t('这种格式没法提取成文本，下载下来用 Office 打开看吧。', 'This format cannot be extracted as text. Download it and open it in Office.')
      : state.preview.url
        ? t('文本提取失败了，稍后再试，或者直接看「预览」。', 'Text extraction failed. Try again later, or use the Preview tab.')
        : t('这个席位还不支持把 Office 文档提取出来预览（要更新 Bot 版本）。')
  }
  render()
}

/**
 * 要一份渲染好的 PDF（席位上 LibreOffice 转的，见 bot 的 workspace/render.ts）。
 *
 * **只认明确的 `application/pdf`**：老席位不认 `as=pdf`，会把原文件字节当普通预览原样
 * 回来（octet-stream）——那不是 PDF，拿去塞 PDF 阅读器只会是一片解析失败。
 *
 * 要不到（老席位、这台机器没装 LibreOffice、转坏了、太大）一律退回提取文本，和这个
 * 功能出现之前一模一样，不当成出错。
 */
async function fetchDocPdf(path, name) {
  const url =
    '/runtime/sessions/' + encodeURIComponent(state.chatSessionId) + '/files?path=' + encodeURIComponent(path) + '&as=pdf'
  const ac = new AbortController()
  if (state.preview && state.preview.path === path) state.preview.abort = ac
  let buf = null
  try {
    const res = await swFetch(url, { headers: authHeaders(), signal: ac.signal })
    const type = (res.headers.get('content-type') || '').split(';')[0].trim()
    if (res.ok && type === 'application/pdf') buf = await res.arrayBuffer()
    // 不是 PDF 的那份正文不读完：老席位回的可能是一整个大文件。
    else ac.abort()
  } catch {
    // 预览被关掉或换了文件，上面那个 abort 已经把这次请求收了；否则按「要不到」处理。
    if (!state.preview || state.preview.path !== path || state.preview.abort !== ac) return
  }
  if (!state.preview || state.preview.path !== path) return
  if (!buf || !buf.byteLength) {
    // 没有 PDF：能在浏览器里渲染的先试那条路，再不行才只看提取出来的文字。
    if (PREVIEW_WEB_KIND[extOf(name || path)]) {
      state.preview.docLoading = 'web'
      render()
      void fetchDocWeb(path, name)
      return
    }
    state.preview.mode = 'source'
    state.preview.docLoading = 'text'
    render()
    void fetchDocText(path, name)
    return
  }
  // 类型钉死成 application/pdf，理由同 openPreview 里 PDF 那支。
  state.preview.url = URL.createObjectURL(new Blob([buf], { type: 'application/pdf' }))
  state.preview.docLoading = false
  if (state.preview.mode === 'source') {
    state.preview.docLoading = 'text'
    void fetchDocText(path, name)
  }
  render()
}

/**
 * 要不到 PDF 时，取原文件交给浏览器渲染（office-view.html，跑在不透明源的 sandbox iframe 里）。
 *
 * 字节留在 `state.preview.web` 上：那个 iframe 会跟着每一次 render() 重建，重建后它会再说一声
 * ready，这边再把同一份字节递进去（onOfficeViewMessage）。取不到、太大就退回提取文本。
 */
async function fetchDocWeb(path, name) {
  const url = '/runtime/sessions/' + encodeURIComponent(state.chatSessionId) + '/files?path=' + encodeURIComponent(path)
  const ac = new AbortController()
  if (state.preview && state.preview.path === path) state.preview.abort = ac
  let data = null
  try {
    const res = await swFetch(url, { headers: authHeaders(), signal: ac.signal })
    const size = Number(res.headers.get('content-length') || 0)
    if (res.ok && !(size && size > CHAT_PREVIEW_MAX)) data = await res.arrayBuffer()
    else ac.abort()
  } catch {
    if (!state.preview || state.preview.path !== path || state.preview.abort !== ac) return
  }
  if (!state.preview || state.preview.path !== path) return
  if (!data || !data.byteLength || data.byteLength > CHAT_PREVIEW_MAX) {
    officeViewFallback(path, name)
    return
  }
  // nonce：放进 iframe 地址的 # 后面，查看页每条消息都带回来（见 onOfficeViewMessage）。
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')
  state.preview.web = { kind: PREVIEW_WEB_KIND[extOf(name || path)], data, nonce }
  state.preview.size = data.byteLength
  state.preview.docLoading = false
  if (state.preview.mode === 'source') {
    state.preview.docLoading = 'text'
    void fetchDocText(path, name)
  }
  render()
}

/** 浏览器里也渲染不了（取不到、太大、库报错）：和这条路出现之前一样，只看提取出来的文字。 */
function officeViewFallback(path, name) {
  const p = state.preview
  if (!p || p.path !== path) return
  p.web = null
  p.mode = 'source'
  if (p.text == null) {
    p.docLoading = 'text'
    void fetchDocText(path, name)
  }
  render()
}

/**
 * 和浏览器渲染那一页（office-view.js）的交接。
 *
 * **只认当前预览里那个 iframe、而且口令对得上的**：别的 frame（HTML 预览、noVNC 桌面）也能
 * postMessage。光看 `e.source` 还不够——那个 iframe 要是被导航走了（文档里的链接），contentWindow
 * 还是同一个对象，新页面同样是不透明源（sandbox 跟着 iframe 走），它冒充一声 ready 就能把文件
 * 字节要走。口令放在 iframe 地址的 # 后面，只有我们发出去的那一页读得到（片段不进 referrer）。
 *
 * 字节是复制过去的（不是 transfer），留一份给下一次 render() 重建之后再递。
 */
function onOfficeViewMessage(e) {
  const msg = e && e.data
  if (!msg || msg.type !== 'satu-office-view') return
  const p = state.preview
  const frame = typeof document !== 'undefined' ? document.querySelector('iframe[data-office-view]') : null
  if (!p || !p.web || !frame || e.source !== frame.contentWindow || msg.nonce !== p.web.nonce) return
  if (msg.event === 'ready') {
    frame.contentWindow.postMessage(
      { type: 'satu-office-view', event: 'render', kind: p.web.kind, name: p.name, cdn: uiCdn(), data: p.web.data },
      '*',
    )
  } else if (msg.event === 'error') {
    officeViewFallback(p.path, p.name)
  }
}
if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('message', onOfficeViewMessage)

/** blob: 的生命周期得自己管——不撤销，这一份就在内存里待到刷新页面为止。 */
function revokePreview() {
  const p = state.preview
  if (!p) return
  if (p.abort) try { p.abort.abort() } catch {}
  if (p.url) setTimeout(() => URL.revokeObjectURL(p.url), 0)
}

/** 撤掉预览但不重绘：换页、收右栏的时候跟着别的事一起画。 */
function dropPreview() {
  unmountPreviewLayer()
  if (!state.preview) return
  unwatchPaint()
  revokePreview()
  state.preview = null
  previewSession = ''
  previewBot = ''
}

/**
 * 换页时要不要撤掉预览（state.js 的 enterPath 调）。**只在离开这颗 Bot 的对话时撤**：
 * 点名单里正开着的这颗、或者待办里「去对话里处理」指回眼前这颗，地址没变，人也没离开，
 * 那份预览就该还在。换了会话由 shownPreview 自己认出来。
 */
function leavePreview() {
  if (!state.preview) return
  const bot = isChatPath(state.path) ? chatBotIdOf(state.path) || state.chatBotId : ''
  if (bot !== previewBot) dropPreview()
}

function closePreview() {
  dropPreview()
  render()
}

/** 直接把工作区里的文件存下来。走 fetch 而不是 <a href>，同样是为了带上票。 */
async function downloadWorkspaceFile(path, name) {
  if (!state.chatSessionId) return
  const url =
    '/runtime/sessions/' + encodeURIComponent(state.chatSessionId) + '/files?path=' + encodeURIComponent(path) + '&download=1'
  try {
    const res = await swFetch(url, { headers: authHeaders() })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    saveBlob(await res.blob(), name || path.split('/').pop() || 'file')
  } catch (err) {
    flash('err', t('下载失败：') + err.message)
  }
}

/** 渲染视图和原文之间的切换。只有两者都成立的类型才给，别摆一颗按不动的按钮。 */
function previewTabs(p) {
  // Office 文档：有 PDF、或者浏览器能渲染，才有「预览」可切；没有的话只剩提取文本，不摆按钮。
  const both =
    (p.kind === 'markdown' || p.kind === 'html' || (p.kind === 'doc' && (p.url || p.web))) && !p.tooBig && !p.error && !p.loading
  if (!both) return ''
  const tab = (mode, label) =>
    `<button type="button" class="sw-preview-tab" data-act="preview-mode" data-mode="${mode}"` +
    `${p.mode === mode ? ' data-on="1"' : ''}>${esc(label)}</button>`
  return `<div class="sw-preview-tabs">${tab('view', t('预览'))}${tab('source', t('原文'))}</div>`
}

/**
 * 内容自己加载完之前先转圈。
 *
 * 取字节那一段有 p.loading 管，但**字节到手不等于看得见**：iframe 里的 PDF 阅读器、
 * 大图的解码，都还要一会儿，而那段时间框里是纯白的——和「坏了」长得一模一样。
 *
 * 清除动作写在 `data-onload` / `data-onerror` 上：它随 HTML 字符串走，每次整页重绘
 * 都自动带上。真正执行它的是 shell.js 挂在 document 上的那个捕获监听器——挂在节点
 * 自己身上的话，任何一次无关的 render() 都会把节点换掉、监听丢掉，圈就永远转下去。
 *
 * （这里原来是一个内联的 onload 属性。同样随字符串走、同样不怕重绘，但内联事件处理器
 * 要求 CSP 的 script-src 带 `'unsafe-inline'`，见 mediaFallback 上那段。）
 */
const DONE = 'data-onload="busy-done"'

function busyBox(inner) {
  return `<div class="sw-preview-load" data-busy="1"><span class="sw-preview-spin" aria-hidden="true"></span>${inner}</div>`
}

function spinNote(text) {
  return `<p class="sw-preview-note"><span class="sw-preview-spin" aria-hidden="true"></span>${esc(text)}</p>`
}

function previewBody(p) {
  if (p.loading) return spinNote(t('正在取文件…'))
  if (p.error) return `<p class="sw-preview-note sw-preview-err">${esc(p.error)}</p>`
  if (p.docLoading) {
    return spinNote(
      p.docLoading === 'pdf'
        ? t('正在渲染文档…', 'Rendering the document…')
        : p.docLoading === 'web'
          ? t('正在取文件…')
          : t('正在提取文档内容…'),
    )
  }
  if (p.tooBig) {
    const why = p.docNote || t('这个文件不适合在浏览器里打开（太大，或者是不认识的格式）。下载下来看吧。')
    return `<p class="sw-preview-note">${esc(why)}</p>`
  }
  if (p.kind === 'image' && p.paint) {
    // 涂抹时不套 busyBox：图早就解码好了（从「预览」切过来的），而那层转圈会盖住画布。
    return (
      `<div class="sw-paint"><img id="sw-paint-img" class="sw-preview-img" src="${esc(p.url)}" alt="${esc(p.name)}">` +
      `<canvas id="sw-paint-canvas" aria-label="${esc(t('涂出要重画的区域'))}"></canvas></div>`
    )
  }
  if (p.kind === 'image') {
    return busyBox(
      `<img class="sw-preview-img" src="${esc(p.url)}" alt="${esc(p.name)}" ` +
        `${DONE} data-onerror="busy-done">`,
    )
  }
  if (p.kind === 'pdf' || (p.kind === 'doc' && p.mode === 'view' && p.url)) {
    /**
     * PDF 交给浏览器自带的阅读器，**这个 iframe 不能带 sandbox**。
     *
     * 带上就是一片白：sandbox 的 opaque origin 会把 PDF 阅读器整个挡掉，页面根本
     * 起不来。这不是新问题，之前一直是这么写的——只是没人点过 PDF。实测对照过
     * `sandbox=""` / 无 sandbox / `<embed>` 三种，只有不带 sandbox 的那两种能起阅读器。
     *
     * 去掉它安全吗：安全，因为**类型是钉死的**。上面 openPreview 把这段字节重新包成
     * 了 `application/pdf` 的 blob，浏览器只会把它交给 PDF 阅读器，没有任何路径能让它
     * 被当成 HTML 解释——而 sandbox 在这里防的正是「HTML 跑起脚本」。
     */
    return busyBox(`<iframe class="sw-preview-frame" src="${esc(p.url)}" title="${esc(p.name)}" ${DONE}></iframe>`)
  }
  if (p.kind === 'doc' && p.mode === 'view' && p.web) {
    /**
     * 浏览器里渲染 Office（office-view.html）。**只加 allow-scripts，绝不加 allow-same-origin。**
     *
     * 渲染库得跑脚本，所以不能像 HTML 预览那样一个 allow-* 都不给；但不给 allow-same-origin，
     * 它就是个不透明源：拿不到 Gateway 的登录票、摸不到这一页。文档内容（超链接、图表数据）
     * 等同外部输入，哪个库没转义干净，脚本也只能在那个空房间里跑。两个一起加等于没有 sandbox。
     */
    return busyBox(
      `<iframe class="sw-preview-frame" data-office-view="1" src="${OFFICE_VIEW_SRC}#${esc(p.web.nonce)}" sandbox="allow-scripts" ` +
        `title="${esc(p.name)}" ${DONE}></iframe>`,
    )
  }
  if (p.kind === 'html' && p.mode === 'view') {
    /**
     * **`sandbox` 一个 allow-* 都不能加。** 这是让 HTML 能被预览的全部依据：没有
     * allow-scripts 就没有脚本执行，没有 allow-same-origin 就是 opaque origin，
     * 拿不到 Gateway 这一侧的任何东西。加任何一项都会把这条推翻。
     *
     * 和上面 PDF 那条的差别就在这里：HTML **要**当页面跑，所以必须锁死；PDF 不当
     * 页面跑，锁死反而只剩一片白。
     */
    return busyBox(
      `<iframe class="sw-preview-frame" src="${esc(p.url)}" sandbox title="${esc(p.name)}" ${DONE}></iframe>`,
    )
  }
  if (p.kind === 'markdown' && p.mode === 'view') {
    // satuMd 对原始 HTML 一律转义、链接只放行白名单协议（见 markdown.js 开头第 3 条），
    // 所以这段 innerHTML 是安全的——和聊天气泡里渲染模型输出走的是同一条路。
    const md = window.satuMd
    const html = md ? md.render(String(p.text || '')) : ''
    if (md) return `<div class="sw-preview-md sw-md">${html}</div>`
  }
  // Office 文档的「原文」页提取不出东西时（老格式、老席位），把原因说出来，别给一块空白。
  if (p.kind === 'doc' && !p.text && p.docNote) return `<p class="sw-preview-note">${esc(p.docNote)}</p>`
  // 其余一律看原文：Markdown/HTML 的「原文」页、纯文本、以及提取出来的 Office 文档。
  return `<pre class="sw-preview-src">${esc(String(p.text || ''))}</pre>`
}

/**
 * 右栏里的预览（见 render.js 的 pageAside）。
 *
 * 原来是一个盖住整屏的弹层：人看着 Bot 刚产出的东西，想说「这一段改一下」，得先把
 * 预览关掉才看得见输入框，说完再点开——一来一回什么都对不上。挪进右栏之后对话照旧在
 * 左边，Bot 改完同一个文件，这边自己重载（maybeLivePreview）。
 *
 * 右栏比弹层窄，所以头上分两行：上面是文件名和关闭，下面是那一排看法 / 涂抹 / 下载，
 * 窄的时候自己折行。
 */
function previewPanel() {
  const p = state.preview
  if (!p) return ''
  const meta = p.size ? fileSize(p.size) : ''
  return `<section class="sw-preview sw-preview-side" aria-label="${esc(t('文件预览', 'File preview'))}">
      <div class="sw-preview-head">
        <div style="min-width: 0;">
          <h2>${esc(p.name)}</h2>
          <p><code>${esc(p.path)}</code>${meta ? ' · ' + esc(meta) : ''}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" style="flex: none;" aria-label="${esc(t('关闭'))}" title="${esc(t('关闭'))}" data-act="preview-close">${svg(CLOSE_ICON, 16)}</button>
      </div>
      <div class="sw-preview-acts">
        ${previewTabs(p)}
        ${paintActs(p)}
        ${/* 「引用这个文件」：把它挂到输入框上，下一句话就指着它说（docs/chat-references.md §7.2）。
              药丸、正文里的行内路径、右栏「工作区文件」点开走的都是这同一个预览，一个按钮三处都覆盖到。 */ ''}
        <button type="button" class="btn" data-act="chat-ref-file" data-path="${esc(p.path)}" data-name="${esc(p.name)}">${t('引用这个文件', 'Quote this file')}</button>
        <button type="button" class="btn" data-act="preview-download" data-path="${esc(p.path)}" data-name="${esc(p.name)}">${t('下载')}</button>
      </div>
      <div class="sw-preview-slot" id="sw-preview-slot"></div>
    </section>`
}

/** 内容框里是居中摆（图、提示、转圈）还是从顶上排（文本、渲染出来的 Markdown、iframe）。 */
function previewFlow(p) {
  return p.error || p.loading || p.docLoading || p.tooBig || p.kind === 'image' ? 'center' : 'top'
}

/**
 * 预览的内容层：真正的 iframe / 图 / 正文**不画在右栏里**，挂在 body 上的一个常驻层上，
 * 位置跟着右栏那个空槽（#sw-preview-slot）走。和内嵌桌面（syncDesktop）是同一个理由。
 *
 * render() 是整页 innerHTML 换掉的，而对话页上它来得很勤：发一条消息就是十来次。内容
 * 要是画在右栏里，每来一次 PDF 就重新加载、跳回第一页，HTML 重跑一遍，Office 重新渲染，
 * Markdown 丢掉代码高亮和 mermaid——预览挪进右栏图的就是「边看边说」，说一句它就重来
 * 一遍，等于没挪。弹层那会儿没这个问题，是因为弹层开着人什么也干不了。
 *
 * 所以这一层只在**要画的东西真的变了**才换内容（签名见 previewSig），其余时候只对位置。
 */
let previewLayerSig = ''
let previewLayerFor = null
let previewSlotSeen = null
let previewObserver = null

function previewLayer() {
  return document.getElementById('sw-previewl')
}

/**
 * 内容签名：这几样之外的变化（涂抹的笔画、按钮的忙闲）都不该让内容重建。
 * 对象本身也要比——重新打开同一个文件（Bot 刚改过）是一个新对象，字段可能一个都没变。
 */
function previewSig(p) {
  return [
    p.path, p.kind, p.mode, p.url, p.loading, p.error, p.docLoading, p.tooBig, p.docNote,
    Boolean(p.paint), p.web ? p.web.nonce : '', typeof p.text === 'string' ? p.text.length : -1,
  ].join('|')
}

function unmountPreviewLayer() {
  const layer = typeof document !== 'undefined' ? previewLayer() : null
  if (layer) layer.remove()
  if (previewObserver) previewObserver.disconnect()
  previewObserver = null
  previewSlotSeen = null
  previewLayerSig = ''
  previewLayerFor = null
}

/** render() 之后调：对位置，内容变了才换内容。 */
function syncPreview() {
  const slot = document.getElementById('sw-preview-slot')
  const p = shownPreview()
  if (!slot || !p) {
    if (previewLayer()) {
      unwatchPaint()
      unmountPreviewLayer()
    }
    return
  }
  let layer = previewLayer()
  if (!layer) {
    layer = document.createElement('div')
    layer.id = 'sw-previewl'
    document.body.appendChild(layer)
    previewLayerSig = ''
  }
  const sig = previewSig(p)
  if (sig !== previewLayerSig || p !== previewLayerFor) {
    previewLayerSig = sig
    previewLayerFor = p
    layer.className = 'sw-preview-body sw-previewl'
    layer.setAttribute('data-flow', previewFlow(p))
    layer.innerHTML = previewBody(p)
    // 渲染出来的 Markdown 里可能有代码块、公式、mermaid——和聊天气泡一样要 enhance 一次。
    const md = p.kind === 'markdown' && p.mode === 'view' && window.satuMd ? layer.querySelector('.sw-preview-md') : null
    if (md) window.satuMd.enhance(md)
    // 画布跟着内容一起换了：笔画在 state 里，重新挂上去照着重画。
    if (p.paint) mountPainter()
    else unwatchPaint()
  }
  if (slot !== previewSlotSeen) {
    // 整页重绘换了个新的槽：观察器跟着换过去（拖宽右栏、窗口变化都靠它）。
    previewSlotSeen = slot
    if (previewObserver) previewObserver.disconnect()
    previewObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => placePreview()) : null
    if (previewObserver) previewObserver.observe(slot)
  }
  placePreview()
}

function placePreview() {
  const layer = previewLayer()
  const slot = document.getElementById('sw-preview-slot')
  if (!layer || !slot) return
  const r = slot.getBoundingClientRect()
  layer.style.top = r.top + 'px'
  layer.style.left = r.left + 'px'
  layer.style.width = r.width + 'px'
  layer.style.height = r.height + 'px'
}
if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('resize', () => placePreview())

/** 切「预览 / 原文」。只改一个字段，字节早就在手上了，不用再取一次。 */
function setPreviewMode(mode) {
  if (!state.preview || state.preview.mode === mode) return
  state.preview.mode = mode === 'source' ? 'source' : 'view'
  // Office 文档的文本是切到「原文」时才去取的——大多数人只看渲染出来的那一份。
  const p = state.preview
  if (p.kind === 'doc' && p.mode === 'source' && p.text == null && !p.docLoading) {
    p.docLoading = 'text'
    void fetchDocText(p.path, p.name)
  }
  // 切到「预览」那一刻 Markdown 要 enhance 一次（代码高亮、公式、mermaid）——内容层换
  // 内容时自己会做，见 syncPreview。
  render()
}

/**
 * 局部重绘：在预览的图上涂出要重画的那一块，生成一张蒙版 PNG 当附件发给 Bot。
 *
 * Bot 那边的 generate_image 收 `mask`（bot/src/tools/image.ts），但让模型自己做蒙版几乎做不到
 * ——它多半看不见图，看得见也说不准坐标。人来涂是唯一靠谱的办法，而这件事只有界面做得了。
 *
 * **笔画存在 state 里，不只画在画布上**：任何一次无关的 render()（对话流来了一帧、侧栏刷新）
 * 都可能把预览换掉，画布上的东西就没了。所以笔画按**原图像素**坐标存进 `state.preview.paint`，
 * 每次画布重新挂上来（mountPainter，内容层换内容时调，见 syncPreview）都照着重画一遍。
 *
 * 蒙版的约定是 OpenAI 的：和原图一样大，**透明的地方重画**，其余不透明。
 */
const PAINT_BRUSH_DEFAULT = 40
const PAINT_COLOR = 'rgba(239, 68, 68, 0.45)'

/**
 * 盯着那张图的尺寸：窗口一缩、侧栏一开，图跟着变小，画布得跟着重新贴上去——不然画布还是
 * 旧的大小，笔落下的地方和光标对不上，涂出来的蒙版也就不是人看到的那一块。
 * 同一时间只有一个画布，所以只留一个观察者，换画布（重挂、关掉）时先断开旧的。
 */
let paintObserver = null

function unwatchPaint() {
  if (paintObserver) paintObserver.disconnect()
  paintObserver = null
}

function paintActs(p) {
  if (p.kind !== 'image' || !p.url || p.loading || p.error || p.tooBig) return ''
  if (!p.paint) {
    return `<button type="button" class="btn" data-act="paint-start" title="${esc(t('涂出要重画的区域，让 Bot 只改那一块', 'Paint the area to redraw; the bot changes only that part'))}">${t('局部重绘', 'Inpaint')}</button>`
  }
  return (
    `<label class="sw-paint-brush">${t('笔刷', 'Brush')}` +
    `<input type="range" id="sw-paint-brush" min="8" max="160" step="4" value="${esc(String(p.paint.brush))}"></label>` +
    `<button type="button" class="btn btn-ghost" data-act="paint-undo" ${p.paint.strokes.length ? '' : 'disabled'}>${t('撤销', 'Undo')}</button>` +
    `<button type="button" class="btn btn-ghost" data-act="paint-clear" ${p.paint.strokes.length ? '' : 'disabled'}>${t('清除', 'Clear')}</button>` +
    `<button type="button" class="btn btn-ghost" data-act="paint-cancel">${t('取消', 'Cancel')}</button>` +
    `<button type="button" class="btn btn-primary" data-act="paint-done" ${p.paint.strokes.length && !p.paint.busy ? '' : 'disabled'}>${t('用这块重绘', 'Use this area')}</button>`
  )
}

function startPaint() {
  const p = state.preview
  if (!p || p.kind !== 'image' || !p.url) return
  p.paint = { strokes: [], brush: PAINT_BRUSH_DEFAULT }
  render()
}

function stopPaint() {
  unwatchPaint()
  if (!state.preview) return
  state.preview.paint = null
  render()
}

/** 撤销 / 清除只动 state 和这两颗按钮的可用状态，**不整页重绘**——画布重挂会闪一下。 */
function editPaint(act) {
  const paint = state.preview && state.preview.paint
  if (!paint) return
  if (act === 'undo') paint.strokes.pop()
  else paint.strokes = []
  redrawPaint()
  syncPaintButtons()
}

function syncPaintButtons() {
  const paint = state.preview && state.preview.paint
  const empty = !paint || !paint.strokes.length
  for (const act of ['paint-undo', 'paint-clear', 'paint-done']) {
    const b = document.querySelector(`[data-act="${act}"]`)
    if (b) b.disabled = empty || (act === 'paint-done' && !!paint.busy)
  }
}

/** 一笔：原图像素坐标下的点列和笔宽。单点（点一下没拖）画成一个圆。 */
function strokePath(ctx, stroke, scale) {
  const pts = stroke.pts
  ctx.lineWidth = stroke.w * scale
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (pts.length === 1) {
    ctx.beginPath()
    ctx.arc(pts[0].x * scale, pts[0].y * scale, (stroke.w * scale) / 2, 0, Math.PI * 2)
    ctx.fill()
    return
  }
  ctx.beginPath()
  ctx.moveTo(pts[0].x * scale, pts[0].y * scale)
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x * scale, pts[i].y * scale)
  ctx.stroke()
}

function redrawPaint() {
  const canvas = document.getElementById('sw-paint-canvas')
  const img = document.getElementById('sw-paint-img')
  const paint = state.preview && state.preview.paint
  if (!canvas || !img || !paint || !img.naturalWidth) return
  const ctx = canvas.getContext('2d')
  const dpr = window.devicePixelRatio || 1
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.strokeStyle = PAINT_COLOR
  ctx.fillStyle = PAINT_COLOR
  const scale = img.clientWidth / img.naturalWidth
  for (const s of paint.strokes) strokePath(ctx, s, scale)
}

/**
 * 把画布贴到图上、接上笔。render.js 每次 render 之后调一次（节点是新的，监听也是新挂的，
 * 旧节点连同旧监听一起被丢掉，不会攒）。
 */
/**
 * 笔刷那根滑杆在右栏的按钮行里，随 render() 换掉，每次都要重新接上。画布在内容层里，
 * 不跟着换（见 syncPreview），所以两件事分开挂。
 */
function bindPaintBrush() {
  const range = document.getElementById('sw-paint-brush')
  if (!range) return
  range.addEventListener('input', () => {
    const paint = state.preview && state.preview.paint
    if (paint) paint.brush = Number(range.value) || PAINT_BRUSH_DEFAULT
  })
}

function mountPainter() {
  const canvas = document.getElementById('sw-paint-canvas')
  const img = document.getElementById('sw-paint-img')
  if (!canvas || !img) return
  const fit = () => {
    const dpr = window.devicePixelRatio || 1
    canvas.style.width = img.clientWidth + 'px'
    canvas.style.height = img.clientHeight + 'px'
    canvas.width = Math.round(img.clientWidth * dpr)
    canvas.height = Math.round(img.clientHeight * dpr)
    redrawPaint()
  }
  if (img.complete && img.naturalWidth) fit()
  else img.addEventListener('load', fit, { once: true })
  unwatchPaint()
  if (typeof ResizeObserver === 'function') {
    paintObserver = new ResizeObserver(() => {
      if (img.naturalWidth) fit()
    })
    paintObserver.observe(img)
  }

  let current = null
  const at = (e) => {
    const r = canvas.getBoundingClientRect()
    const k = img.naturalWidth / r.width
    return { x: Math.round((e.clientX - r.left) * k), y: Math.round((e.clientY - r.top) * k) }
  }
  canvas.addEventListener('pointerdown', (e) => {
    const paint = state.preview && state.preview.paint
    if (!paint || !img.naturalWidth) return
    e.preventDefault()
    canvas.setPointerCapture(e.pointerId)
    // 笔宽按**屏幕上看到的**粗细换算成原图像素：人调的是眼睛看到的那支笔。
    const k = img.naturalWidth / canvas.getBoundingClientRect().width
    current = { w: Math.max(1, Math.round(paint.brush * k)), pts: [at(e)] }
    paint.strokes.push(current)
    redrawPaint()
    syncPaintButtons()
  })
  canvas.addEventListener('pointermove', (e) => {
    if (!current) return
    current.pts.push(at(e))
    redrawPaint()
  })
  const end = () => {
    current = null
  }
  canvas.addEventListener('pointerup', end)
  canvas.addEventListener('pointercancel', end)
}

/**
 * 按原图尺寸出一张蒙版：先整张涂成不透明，再把笔画那几块「挖掉」（destination-out）。
 * 返回 PNG 的 Blob；没涂任何东西返回 null。
 */
function buildMask(strokes, width, height) {
  if (!strokes.length || !width || !height) return Promise.resolve(null)
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, width, height)
  ctx.globalCompositeOperation = 'destination-out'
  ctx.strokeStyle = '#000'
  ctx.fillStyle = '#000'
  for (const s of strokes) strokePath(ctx, s, 1)
  return new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/png'))
}

/**
 * 涂完了：蒙版作为附件挂到输入框上，再预填一句「按蒙版 X 局部重绘 Y：」，光标停在句尾，
 * 人接着写要改成什么。蒙版随消息一起传进工作区，Bot 在消息里看到它的路径（`[附图 …]`），
 * 原图的路径就在这句话里。
 */
async function finishPaint() {
  const p = state.preview
  const img = document.getElementById('sw-paint-img')
  // 出蒙版要等 toBlob，那段时间里按钮还在：双击一下就是两张蒙版、两句预填。
  if (!p || !p.paint || !img || p.paint.busy) return
  p.paint.busy = true
  const done = document.querySelector('[data-act="paint-done"]')
  if (done) done.disabled = true
  const blob = await buildMask(p.paint.strokes, img.naturalWidth, img.naturalHeight)
  if (!blob || state.preview !== p) {
    if (state.preview === p && p.paint) p.paint.busy = false
    syncPaintButtons()
    return
  }
  /**
   * 名字要**每次都不一样**。同一张图再涂一次，蒙版要是还叫 `mask-猫.png`，上传时撞名会被存成
   * `mask-猫-1.png`，可预填的那句话写的仍是 `mask-猫.png`——模型照着那句话去找，拿到的是上一次
   * 那张旧蒙版，改的是上一次涂的那一块，而且一句错都不报。
   */
  const stem = String(p.name || 'image').replace(/\.[^.]+$/, '').slice(0, 60) || 'image'
  const file = new File([blob], `mask-${stem}-${Date.now().toString(36)}.png`, { type: 'image/png' })
  state.chatFiles = [...(state.chatFiles || []), { name: file.name, size: file.size, file }]
  const line = t(`按蒙版 ${file.name} 局部重绘 ${p.path}，涂掉的那块改成：`, `Inpaint ${p.path} using mask ${file.name}; change the painted area to: `)
  state.chatDraft = (state.chatDraft || '').trim() ? `${state.chatDraft}\n${line}` : line
  unwatchPaint()
  closePreview()
  const input = document.getElementById('chat-input')
  if (input) {
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  }
}

/**
 * 预览能在浏览器里直接打开的上限。
 *
 * 预览得把整个文件读成 blob 才能喂给 <img>/<iframe>——Gateway 认的是 Authorization
 * 头，而 src= 发出去的请求带不了头。所以这个数字是「愿意为看一眼吃多少内存」，
 * 超过就只给下载，不是不给看。
 *
 * 上传**没有**前端上限：文件是流着走的，不进模型上下文，把关的是席位那边的
 * SATUWORK_UPLOAD_MAX。
 */
const CHAT_PREVIEW_MAX = 25 * 1024 * 1024
