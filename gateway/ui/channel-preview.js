;(function () {
  'use strict'

  const page = document.body
  const kind = page.dataset.kind || 'unknown'
  const name = page.dataset.name || '文档'
  const rawUrl = page.dataset.rawUrl || ''
  const host = document.getElementById('preview-body')
  const tabs = document.getElementById('preview-tabs')
  const sizeNode = document.getElementById('preview-size')
  const downloadButton = document.getElementById('preview-download')
  const closeButton = document.getElementById('preview-close')
  const modes = Array.from(document.querySelectorAll('[data-mode]'))
  const TEXT_MAX = 2 * 1024 * 1024
  const BINARY_MAX = 25 * 1024 * 1024
  let mode = 'view'
  let source = ''
  let fileBlob = null
  let frameUrl = ''
  /**
   * 浏览器里能渲染的那几种 Office（office-view.html，和对话页 chat.js 的 PREVIEW_WEB_KIND 同一张表）。
   * 席位没装 LibreOffice、要不到 PDF 时走这条；老格式（doc / xls / ppt）只能看提取出来的文字。
   */
  const WEB_KIND = { docx: 'docx', xlsx: 'xlsx', xlsm: 'xlsx', pptx: 'pptx' }
  const ext = (String(name).split('.').pop() || '').toLowerCase()
  /** 正在等哪一个 office-view 框说话；换了看法、出了错就作废。 */
  let officeView = null

  function fileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return ''
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) + ' MB'
  }

  function revokeFrame() {
    if (!frameUrl) return
    URL.revokeObjectURL(frameUrl)
    frameUrl = ''
  }

  function clear(flow) {
    revokeFrame()
    officeView = null
    host.replaceChildren()
    host.dataset.flow = flow
  }

  function note(text, error) {
    clear('center')
    const p = document.createElement('p')
    p.className = 'sw-preview-note' + (error ? ' sw-preview-err' : '')
    p.textContent = text
    host.appendChild(p)
  }

  function frame(blob, sandboxed) {
    clear('top')
    frameUrl = URL.createObjectURL(blob)
    const box = document.createElement('div')
    box.className = 'sw-preview-load'
    box.dataset.busy = '1'
    const spin = document.createElement('span')
    spin.className = 'sw-preview-spin'
    spin.setAttribute('aria-hidden', 'true')
    const iframe = document.createElement('iframe')
    iframe.className = 'sw-preview-frame'
    iframe.src = frameUrl
    iframe.title = name
    iframe.referrerPolicy = 'no-referrer'
    if (sandboxed) iframe.setAttribute('sandbox', '')
    iframe.addEventListener('load', () => box.removeAttribute('data-busy'))
    iframe.addEventListener('error', () => box.removeAttribute('data-busy'))
    box.append(spin, iframe)
    host.appendChild(box)
  }

  function render() {
    for (const button of modes) button.toggleAttribute('data-on', button.dataset.mode === mode)
    if (kind === 'pdf') {
      frame(new Blob([fileBlob], { type: 'application/pdf' }), false)
      return
    }
    if (kind === 'html' && mode === 'view') {
      frame(new Blob([source], { type: 'text/html; charset=utf-8' }), true)
      return
    }
    if (kind === 'markdown' && mode === 'view') {
      clear('top')
      const markdown = document.createElement('div')
      markdown.className = 'sw-preview-md sw-md'
      if (window.satuMd) {
        markdown.innerHTML = window.satuMd.render(source)
        window.satuMd.enhance(markdown)
      } else markdown.textContent = source
      host.appendChild(markdown)
      return
    }
    clear('top')
    const pre = document.createElement('pre')
    pre.className = 'sw-preview-src'
    pre.textContent = source
    host.appendChild(pre)
  }

  function spinner(text) {
    clear('center')
    const p = document.createElement('p')
    p.className = 'sw-preview-note'
    const spin = document.createElement('span')
    spin.className = 'sw-preview-spin'
    spin.setAttribute('aria-hidden', 'true')
    p.append(spin, text)
    host.appendChild(p)
  }

  /** 原链接上加一个 `as`：`rawUrl` 本身已经带着 `?raw=1`。 */
  function rawAs(as) {
    return rawUrl + (rawUrl.includes('?') ? '&' : '?') + 'as=' + as
  }

  async function loadImage() {
    const response = await fetch(rawUrl)
    if (!response.ok) throw new Error(response.status === 404 ? '预览链接不存在或已过期' : '文件读取失败（HTTP ' + response.status + '）')
    fileBlob = await response.blob()
    if (fileBlob.size > BINARY_MAX) throw new Error('文件太大，不能在线预览，请下载后查看。')
    sizeNode.textContent = fileBlob.size ? ' · ' + fileSize(fileBlob.size) : ''
    clear('center')
    frameUrl = URL.createObjectURL(fileBlob)
    const img = document.createElement('img')
    img.className = 'sw-preview-img'
    img.alt = name
    img.src = frameUrl
    host.appendChild(img)
  }

  /**
   * Word / Excel / PPT：三条路依次试，和对话页（chat.js 的 fetchDocPdf / fetchDocWeb / fetchDocText）同一个顺序。
   *
   * 1. 席位用 LibreOffice 渲染好的 PDF——还原度最高。**只认明确的 application/pdf**：老席位不认
   *    `as=pdf`，会把原文件字节原样回来，那塞进 PDF 阅读器只是一片解析失败。
   * 2. 要不到（没装 LibreOffice 回 501、太大、转坏了）就把原文件交给浏览器渲染。
   * 3. 浏览器也渲染不了，看提取出来的文字。
   */
  async function loadDoc() {
    spinner('正在渲染文档…')
    try {
      const response = await fetch(rawAs('pdf'))
      const type = (response.headers.get('content-type') || '').split(';')[0].trim()
      if (response.ok && type === 'application/pdf') {
        const pdf = await response.blob()
        if (pdf.size) {
          fileBlob = null
          frame(new Blob([pdf], { type: 'application/pdf' }), false)
          return
        }
      } else if (response.body) {
        // 不是 PDF 的那份正文不读完：老席位回的可能是一整个大文件。
        void response.body.cancel().catch(() => {})
      }
    } catch {}
    if (WEB_KIND[ext] && (await loadOfficeView())) return
    await loadDocText()
  }

  /**
   * 浏览器里渲染（office-view.html）。**只加 allow-scripts，绝不加 allow-same-origin**：渲染库要跑
   * 脚本，但文档内容等同外部输入，让它待在不透明源里（理由见 chat.js 的 previewBody 那一支）。
   *
   * 交接和对话页一样：那一页说 `ready`，这边把字节递进去；口令放在地址的 # 后面，只认带着
   * 这个口令、而且来自这个框的消息。渲染失败（`error`）就退回提取文字。
   */
  async function loadOfficeView() {
    let data
    try {
      const response = await fetch(rawUrl)
      const announced = Number(response.headers.get('content-length') || 0)
      if (!response.ok || (announced && announced > BINARY_MAX)) {
        if (response.body) void response.body.cancel().catch(() => {})
        return false
      }
      data = await response.arrayBuffer()
    } catch {
      return false
    }
    if (!data.byteLength || data.byteLength > BINARY_MAX) return false
    sizeNode.textContent = ' · ' + fileSize(data.byteLength)
    clear('top')
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('')
    const box = document.createElement('div')
    box.className = 'sw-preview-load'
    box.dataset.busy = '1'
    const spin = document.createElement('span')
    spin.className = 'sw-preview-spin'
    spin.setAttribute('aria-hidden', 'true')
    const iframe = document.createElement('iframe')
    iframe.className = 'sw-preview-frame'
    iframe.title = name
    iframe.setAttribute('sandbox', 'allow-scripts')
    iframe.src = '/ui/office-view.html#' + nonce
    iframe.addEventListener('load', () => box.removeAttribute('data-busy'))
    officeView = { iframe, nonce, data }
    box.append(spin, iframe)
    host.appendChild(box)
    return true
  }

  function officeViewCdn() {
    const meta = document.querySelector('meta[name="satu-cdn"]')
    const base = meta && meta.getAttribute('content')
    return base && /^https?:\/\//.test(base) ? base.replace(/\/+$/, '') : 'https://cdn.jsdelivr.net/npm'
  }

  window.addEventListener('message', (e) => {
    const msg = e && e.data
    const view = officeView
    if (!msg || msg.type !== 'satu-office-view' || !view) return
    if (e.source !== view.iframe.contentWindow || msg.nonce !== view.nonce) return
    if (msg.event === 'ready') {
      view.iframe.contentWindow.postMessage(
        { type: 'satu-office-view', event: 'render', kind: WEB_KIND[ext], name, cdn: officeViewCdn(), data: view.data },
        '*',
      )
    } else if (msg.event === 'error') {
      void loadDocText()
    }
  })

  async function loadDocText() {
    spinner('正在提取文档内容…')
    try {
      const response = await fetch(rawAs('text'), { headers: { accept: 'application/json' } })
      // 415：老格式（doc / xls / ppt）提取不了，席位那句原话就是答案。
      if (response.status === 415) throw new Error('这种格式没法在线预览，请下载后用 Office 打开。')
      if (!response.ok) throw new Error(response.status === 404 ? '预览链接不存在或已过期' : '文档读取失败（HTTP ' + response.status + '），请下载后查看。')
      const body = await response.json()
      const text = String((body && body.text) || '')
      if (!text) throw new Error('这份文档里没提取出文字，请下载后查看。')
      clear('top')
      if (body.note) {
        const p = document.createElement('p')
        p.className = 'sw-preview-note'
        p.textContent = String(body.note)
        host.appendChild(p)
      }
      const pre = document.createElement('pre')
      pre.className = 'sw-preview-src'
      pre.textContent = text
      host.appendChild(pre)
    } catch (error) {
      note(error && error.message ? error.message : '文档读取失败，请下载后查看。', true)
    }
  }

  async function load() {
    if (kind === 'doc' || kind === 'image') {
      tabs.hidden = true
      try {
        await (kind === 'doc' ? loadDoc() : loadImage())
      } catch (error) {
        note(error && error.message ? error.message : '文件读取失败', true)
      }
      return
    }
    if (!['html', 'markdown', 'pdf', 'text'].includes(kind)) {
      tabs.hidden = true
      note('这个文件暂不支持在线预览，请下载后查看。')
      return
    }
    try {
      const response = await fetch(rawUrl, { headers: { accept: 'application/octet-stream' } })
      if (!response.ok) throw new Error(response.status === 404 ? '预览链接不存在或已过期' : '文件读取失败（HTTP ' + response.status + '）')
      const announced = Number(response.headers.get('content-length') || 0)
      const limit = kind === 'pdf' ? BINARY_MAX : TEXT_MAX
      if (announced && announced > limit) throw new Error('文件太大，不能在线预览，请下载后查看。')
      fileBlob = await response.blob()
      if (fileBlob.size > limit) throw new Error('文件太大，不能在线预览，请下载后查看。')
      sizeNode.textContent = fileBlob.size ? ' · ' + fileSize(fileBlob.size) : ''
      if (kind !== 'pdf') source = await fileBlob.text()
      render()
    } catch (error) {
      note(error && error.message ? error.message : '文件读取失败', true)
    }
  }

  for (const button of modes) {
    button.addEventListener('click', () => {
      const next = button.dataset.mode === 'source' ? 'source' : 'view'
      if (next === mode || !fileBlob) return
      mode = next
      render()
    })
  }

  downloadButton.addEventListener('click', async () => {
    downloadButton.disabled = true
    try {
      const blob = fileBlob || await fetch(rawUrl).then((response) => {
        if (!response.ok) throw new Error('HTTP ' + response.status)
        return response.blob()
      })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) {
      note('下载失败：' + (error && error.message ? error.message : '未知错误'), true)
    } finally {
      downloadButton.disabled = false
    }
  })

  closeButton.addEventListener('click', () => {
    window.close()
    if (!window.closed && history.length > 1) history.back()
  })
  window.addEventListener('pagehide', revokeFrame)
  void load()
})()
