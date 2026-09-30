/**
 * 浏览器里渲染 Word / Excel / PPT（office-view.html）。
 *
 * **什么时候用它**：席位 / 这台电脑上没有 LibreOffice，渲染不出 PDF 的时候（桌面端的本地 Bot
 * 多半是这样）。有 PDF 就看 PDF——LibreOffice 的还原度比这几个前端库高。
 *
 * **跑在哪儿**：一个 `sandbox="allow-scripts"`、不带 allow-same-origin 的 iframe（chat.js 的
 * previewBody）。文档内容等同外部输入：docx 里的超链接可以是 `javascript:`，pptx 里的图表
 * 数据会喂进 echarts——哪一个库有个没转义干净的地方，脚本就在渲染它的那个源里跑起来。所以
 * 这一页是个不透明源：拿不到 Gateway 的登录票（localStorage / sessionStorage）、摸不到父页面，
 * 响应头那条 CSP 还只放行 'self' 和下面这几个钉了版本的 CDN 包。
 *
 * **怎么交接**：这一页加载好了说一声 `ready`；父页面把文件字节（ArrayBuffer）postMessage 进来；
 * 渲染完回 `done`，失败回 `error`（父页面据此退回提取文本）。**只认 parent 发来的消息**。
 *
 * 三个库：
 *  - Word：docx-preview（要全局的 JSZip）
 *  - Excel：exceljs 读，表格自己画（带行号列号、合并单元格、字体颜色填充边框、列宽）
 *  - PPT：@aiden0z/pptx-renderer（开源、按 PowerPoint 截图做视觉回归；带 zip 解压上限）
 *
 * 版本和路径要和 gateway/src/ui-cdn.ts 的 UI_CDN_PACKAGES、桌面端 main.rs 的 ui_cdn! 对上
 * （e2e 的 markdown 那一组核对），**改版本号三处一起改，SRI 一起换**。
 */
;(function () {
  'use strict'

  const LIBS = {
    jszip: {
      path: '/jszip@3.10.1/dist/jszip.min.js',
      sri: 'sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG',
    },
    docx: {
      path: '/docx-preview@0.4.1/dist/docx-preview.min.js',
      sri: 'sha384-DifWB1GSGsQgwTegPEbGdEMnGZpmfhUsx9A3WuHv+rfQVCFXMhawW/v4AZcP1FzL',
    },
    exceljs: {
      path: '/exceljs@4.4.0/dist/exceljs.min.js',
      sri: 'sha384-Pqp51FUN2/qzfxZxBCtF0stpc9ONI6MYZpVqmo8m20SoaQCzf+arZvACkLkirlPz',
    },
    pptx: {
      path: '/@aiden0z/pptx-renderer@1.3.0/dist/aiden0z-pptx-renderer.browser.es.js',
      sri: 'sha384-aJ9JUVs2QzRzKZfMcOihkMft6JnWgq9aSDZDAziDlmlezAbXsw7IbSCM1ov6CF1s',
      module: true,
    },
  }
  const DEFAULT_CDN = 'https://cdn.jsdelivr.net/npm'
  /** Excel 最多画多少行、多少列。再多浏览器会卡，人也不会在预览里看完。 */
  const XL_MAX_ROWS = 1000
  const XL_MAX_COLS = 60

  const statusEl = document.getElementById('status')
  const root = document.getElementById('root')
  let cdn = DEFAULT_CDN
  let busy = false

  /** 父页面放在地址 # 后面的口令，每条消息都带回去：父页面只认它（见 chat.js 的 onOfficeViewMessage）。 */
  const nonce = location.hash.slice(1)

  function tell(event, extra) {
    parent.postMessage(Object.assign({ type: 'satu-office-view', event: event, nonce: nonce }, extra || {}), '*')
  }

  function status(text, error) {
    statusEl.textContent = text
    if (error) statusEl.setAttribute('data-error', '1')
    else statusEl.removeAttribute('data-error')
    statusEl.hidden = !text
  }

  /**
   * 带 SRI 加载一个 CDN 文件。ES module 也走 `<script type="module" integrity>`：模块按地址进
   * 模块表，之后 `import()` 同一个地址拿到的就是这份已经核过摘要的实例，不会再取一遍。
   */
  const loaded = {}
  function load(lib) {
    const src = cdn + lib.path
    if (!loaded[src]) {
      loaded[src] = new Promise(function (ok, no) {
        const el = document.createElement('script')
        if (lib.module) el.type = 'module'
        el.src = src
        el.integrity = lib.sri
        el.crossOrigin = 'anonymous'
        el.onload = function () {
          ok(lib.module ? import(src) : true)
        }
        el.onerror = function () {
          no(new Error('加载不了 ' + lib.path.split('/')[1]))
        }
        document.head.appendChild(el)
      })
    }
    return loaded[src]
  }

  // 文档里的链接一律不跟：跟过去只会把预览框本身导航走（sandbox 挡住了弹窗和顶层导航）。
  document.addEventListener(
    'click',
    function (e) {
      const a = e.target && e.target.closest ? e.target.closest('a') : null
      if (a) e.preventDefault()
    },
    true,
  )

  // ── Word ──────────────────────────────────────────────────────────────
  async function renderDocx(data) {
    await load(LIBS.jszip)
    await load(LIBS.docx)
    const box = document.createElement('div')
    root.appendChild(box)
    await window.docx.renderAsync(data, box, undefined, {
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      // 图片内联成 data URL：blob: URL 的生命周期还得自己管，而这一页随时会被整个换掉。
      useBase64URL: true,
    })
  }

  // ── Excel ─────────────────────────────────────────────────────────────
  function argbToCss(argb) {
    if (typeof argb !== 'string' || argb.length < 6) return ''
    const hex = argb.length === 8 ? argb.slice(2) : argb
    return /^[0-9a-fA-F]{6}$/.test(hex) ? '#' + hex : ''
  }

  /** 单元格的值：公式格取算好的结果，富文本拼成一串。 */
  function cellValue(cell) {
    const v = cell.value
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('result' in v) return v.result
      if (Array.isArray(v.richText)) return v.richText.map(function (t) { return t.text }).join('')
      if ('text' in v) return v.text
    }
    return v
  }

  /**
   * 按单元格的数字格式出字。exceljs 的 `cell.text` 不管格式：0.15 标着 `0%` 也照样是 0.15。
   * 只认最常见的几种（百分比、千分位、小数位、日期），其余照原值。
   */
  function cellText(cell) {
    const v = cellValue(cell)
    if (v == null) return ''
    const fmt = String(cell.numFmt || '')
    if (v instanceof Date) {
      if (isNaN(v.getTime())) return ''
      const pad = function (n) { return String(n).padStart(2, '0') }
      const date = v.getUTCFullYear() + '-' + pad(v.getUTCMonth() + 1) + '-' + pad(v.getUTCDate())
      return /h|s/i.test(fmt) ? date + ' ' + pad(v.getUTCHours()) + ':' + pad(v.getUTCMinutes()) : date
    }
    if (typeof v !== 'number') return typeof v === 'object' ? (cell.text == null ? '' : String(cell.text)) : String(v)
    const decimals = function (part) {
      const m = /\.(0+)/.exec(part)
      return m ? m[1].length : 0
    }
    if (/%/.test(fmt)) return (v * 100).toFixed(decimals(fmt)) + '%'
    if (/#,##0/.test(fmt)) return v.toLocaleString('en-US', { minimumFractionDigits: decimals(fmt), maximumFractionDigits: decimals(fmt) })
    if (/^0(\.0+)?$/.test(fmt)) return v.toFixed(decimals(fmt))
    return String(v)
  }

  function colName(n) {
    let s = ''
    for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
    return s
  }

  function cellStyle(cell) {
    const css = []
    const font = cell.font || {}
    if (font.bold) css.push('font-weight:600')
    if (font.italic) css.push('font-style:italic')
    const deco = [font.underline ? 'underline' : '', font.strike ? 'line-through' : ''].filter(Boolean).join(' ')
    if (deco) css.push('text-decoration:' + deco)
    if (font.size) css.push('font-size:' + Math.max(8, Math.min(40, Number(font.size) * 1.1)) + 'px')
    const color = argbToCss(font.color && font.color.argb)
    if (color) css.push('color:' + color)
    const fill = cell.fill
    if (fill && fill.type === 'pattern' && fill.pattern !== 'none') {
      const bg = argbToCss(fill.fgColor && fill.fgColor.argb)
      if (bg) css.push('background:' + bg)
    }
    const al = cell.alignment || {}
    if (al.horizontal && /^(left|center|right|justify)$/.test(al.horizontal)) css.push('text-align:' + al.horizontal)
    else if (typeof cellValue(cell) === 'number') css.push('text-align:right')
    if (al.vertical === 'top' || al.vertical === 'middle') css.push('vertical-align:' + al.vertical)
    if (al.wrapText) css.push('white-space:pre-wrap')
    const border = cell.border || {}
    ;['top', 'right', 'bottom', 'left'].forEach(function (side) {
      const b = border[side]
      if (b && b.style) {
        const width = b.style === 'thick' ? 3 : b.style === 'medium' ? 2 : 1
        const style = b.style === 'dashed' || b.style === 'dotted' ? b.style : b.style === 'double' ? 'double' : 'solid'
        css.push('border-' + side + ':' + width + 'px ' + style + ' ' + (argbToCss(b.color && b.color.argb) || '#71717a'))
      }
    })
    return css.join(';')
  }

  function drawSheet(ws, box) {
    box.textContent = ''
    const rows = Math.min(ws.rowCount, XL_MAX_ROWS)
    const cols = Math.min(ws.columnCount, XL_MAX_COLS)
    // 合并单元格：左上角那格带 rowspan / colspan，被盖住的那些不画。
    const span = {}
    const covered = {}
    const merges = (ws.model && ws.model.merges) || []
    merges.forEach(function (ref) {
      const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref)
      if (!m) return
      const toNum = function (letters) {
        let n = 0
        for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
        return n
      }
      const r1 = Number(m[2])
      const c1 = toNum(m[1])
      const r2 = Number(m[4])
      const c2 = toNum(m[3])
      span[r1 + ':' + c1] = { rows: r2 - r1 + 1, cols: c2 - c1 + 1 }
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (r !== r1 || c !== c1) covered[r + ':' + c] = true
    })

    const table = document.createElement('table')
    table.className = 'xl'
    const colgroup = document.createElement('colgroup')
    const corner = document.createElement('col')
    corner.style.width = '44px'
    colgroup.appendChild(corner)
    for (let c = 1; c <= cols; c++) {
      const col = document.createElement('col')
      const w = ws.getColumn(c).width
      col.style.width = (w ? Math.round(w * 7 + 5) : 72) + 'px'
      colgroup.appendChild(col)
    }
    table.appendChild(colgroup)
    const head = document.createElement('tr')
    head.appendChild(document.createElement('th'))
    for (let c = 1; c <= cols; c++) {
      const th = document.createElement('th')
      th.textContent = colName(c)
      head.appendChild(th)
    }
    table.appendChild(head)
    for (let r = 1; r <= rows; r++) {
      const row = ws.getRow(r)
      if (row.hidden) continue
      const tr = document.createElement('tr')
      if (row.height) tr.style.height = Math.round(row.height * 1.33) + 'px'
      const num = document.createElement('td')
      num.className = 'xl-rownum'
      num.textContent = String(r)
      tr.appendChild(num)
      for (let c = 1; c <= cols; c++) {
        if (covered[r + ':' + c]) continue
        const cell = row.getCell(c)
        const td = document.createElement('td')
        const s = span[r + ':' + c]
        if (s) {
          td.rowSpan = s.rows
          td.colSpan = Math.min(s.cols, cols - c + 1)
        }
        // textContent，不是 innerHTML：单元格里写的 `<script>` 就是一段字。
        td.textContent = cellText(cell)
        const style = cellStyle(cell)
        if (style) td.setAttribute('style', style)
        tr.appendChild(td)
      }
      table.appendChild(tr)
    }
    const wrap = document.createElement('div')
    wrap.className = 'xl-wrap'
    wrap.appendChild(table)
    box.appendChild(wrap)
    if (ws.rowCount > rows || ws.columnCount > cols) {
      const note = document.createElement('div')
      note.className = 'xl-note'
      note.textContent = '这张表有 ' + ws.rowCount + ' 行、' + ws.columnCount + ' 列，预览只画了前 ' + rows + ' 行、' + cols + ' 列。'
      box.appendChild(note)
    }
  }

  async function renderXlsx(data) {
    await load(LIBS.exceljs)
    const wb = new window.ExcelJS.Workbook()
    await wb.xlsx.load(data)
    const sheets = wb.worksheets.filter(function (ws) {
      return ws.state !== 'hidden' && ws.state !== 'veryHidden'
    })
    if (!sheets.length) throw new Error('这个工作簿里没有可见的工作表')
    const tabs = document.createElement('div')
    tabs.className = 'xl-tabs'
    const box = document.createElement('div')
    sheets.forEach(function (ws, i) {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = ws.name
      b.addEventListener('click', function () {
        tabs.querySelectorAll('button').forEach(function (x) {
          x.removeAttribute('data-on')
        })
        b.setAttribute('data-on', '1')
        drawSheet(ws, box)
      })
      if (i === 0) b.setAttribute('data-on', '1')
      tabs.appendChild(b)
    })
    if (sheets.length > 1) root.appendChild(tabs)
    root.appendChild(box)
    drawSheet(sheets[0], box)
  }

  // ── PPT ───────────────────────────────────────────────────────────────
  async function renderPptx(data) {
    const mod = await load(LIBS.pptx)
    const box = document.createElement('div')
    box.className = 'pp-root'
    root.appendChild(box)
    await mod.PptxViewer.open(data, box, {
      // zip 解压上限：一个声明很小、解开很大的包在这一层就停，别把这个标签页撑死。
      zipLimits: mod.RECOMMENDED_ZIP_LIMITS,
      lazySlides: true,
      lazyMedia: true,
      listOptions: { windowed: true },
    })
  }

  const RENDER = { docx: renderDocx, xlsx: renderXlsx, pptx: renderPptx }

  window.addEventListener('message', async function (e) {
    // 只听父页面的：这一页里渲染的文档内容本身也能 postMessage，不能让它冒充父页面。
    if (e.source !== parent) return
    const msg = e.data
    if (!msg || msg.type !== 'satu-office-view' || msg.event !== 'render' || busy) return
    const render = RENDER[msg.kind]
    if (!render || !(msg.data instanceof ArrayBuffer)) {
      tell('error', { message: '这种文件浏览器里渲染不了' })
      return
    }
    // CDN 根：父页面按它那边的配置给（内网镜像），只收 http(s)。真正的闸是这一页的 CSP。
    if (typeof msg.cdn === 'string' && /^https?:\/\/[^\s"'<>]+$/.test(msg.cdn)) cdn = msg.cdn.replace(/\/+$/, '')
    busy = true
    status('正在渲染' + (msg.name ? '「' + msg.name + '」' : '') + '…')
    try {
      await render(msg.data)
      status('')
      tell('done')
    } catch (err) {
      root.textContent = ''
      status('浏览器里渲染不了这个文件：' + ((err && err.message) || String(err)), true)
      tell('error', { message: (err && err.message) || String(err) })
    }
  })

  tell('ready')
})()
