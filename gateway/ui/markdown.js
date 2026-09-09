/**
 * 聊天气泡里的 Markdown。
 *
 * 设计照着 vercel/ai-chatbot 现在用的那套（Streamdown + @streamdown/{code,math,
 * mermaid,cjk}）搬：**为流式输出而写的 Markdown**，不是把一份写完的文档渲染出来。
 * 三条约束决定了这个文件的形状：
 *
 * 1. **半截的语法不能露原文。** 模型一个 token 一个 token 地吐，任何一帧都可能停在
 *    `**加粗` 或围栏里面。照直渲染的话，星号、反引号、`[标题](` 会在屏幕上闪一下再
 *    消失——很脏。所以渲染前先把「还没收口的记号」补上（见 healStream）。
 * 2. **按块记忆。** 一轮回答要重画几百次，每次整段重排是 O(n²)。splitBlocks 把正文切
 *    成顶层块，调用方只重画变了的那一块（app.js 的 paintChat 就这么用）。
 * 3. **默认不信任正文。** 这里渲染的是模型输出和工具结果，等同于外部输入：原始 HTML
 *    一律转义不透传，链接和图片只放行白名单协议。
 *
 * 重的东西（KaTeX / Mermaid / highlight.js）不打进这个文件，用到时才从 CDN 拉，拉不到
 * 就退回纯文本——公式显示 TeX 原文、图显示源码、代码不高亮，但页面不会坏。三者都带
 * SRI 摘要，内容对不上一律当拉不到（见 LIBS）。
 *
 * CDN 地址可以用 window.SATU_CDN 覆盖（内网部署时指到自己的镜像）。**换了这个就要同时
 * 设 Gateway 的 `GATEWAY_UI_CDN`**：CSP 的 script-src 是按后者写的，只换一边的话脚本会
 * 被浏览器挡掉，而表现和「CDN 拉不到」一模一样（见 gateway/src/http.ts 的 CSP）。
 */
;(function () {
  'use strict'

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESCAPES[c])
  }

  /** 界面文案走 app.js 的 t()。markdown.js 先加载，所以只能运行时去拿。 */
  function L(zh) {
    return typeof window.t === 'function' ? window.t(zh) : zh
  }

  /**
   * 行内解析分好几趟，代码片段和公式必须在「转义 → 链接 → 强调」之前先抽走：
   * `a*b*c` 里的星号不是强调，`$x_1$` 里的下划线也不是。抽走时留一个私用区字符包着的
   * 数字当占位符——它躲得过后面每一趟正则（转义不碰它，强调不匹配纯数字），最后一步
   * 再换回来。
   */
  const MARK = '\uE000'
  const RE_HOLE = /\uE000(\d+)\uE000/g

  function hold(store, html) {
    store.push(html)
    return MARK + (store.length - 1) + MARK
  }

  function unhold(html, store) {
    // 占位符会嵌套（链接文字里有行内代码），所以要换到不动为止。
    let out = html
    for (let i = 0; i < 8 && out.indexOf(MARK) >= 0; i++) {
      out = out.replace(RE_HOLE, (m, n) => (store[Number(n)] == null ? '' : store[Number(n)]))
    }
    return out.split(MARK).join('')
  }

  /** 判「这条相对地址是不是还在站内」用的假基地址。只用来比对源，不会出现在输出里。 */
  const RELATIVE_BASE = 'https://satu.invalid/'
  const RELATIVE_ORIGIN = 'https://satu.invalid'

  /** 只放行安全协议。模型写得出 `javascript:`，这里是唯一拦得住的地方。 */
  function safeUrl(raw, kind) {
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
  function healStream(src) {
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
  function splitBlocks(src) {
    const lines = String(src == null ? '' : src)
      .replace(/\r\n?/g, '\n')
      .split('\n')
    const out = []
    let buf = []
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

  function mathNode(tex, display) {
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
  function inline(src, ctx) {
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
  function startsBlock(l) {
    return RE_FENCE.test(l) || RE_ATX.test(l) || RE_HR.test(l) || RE_QUOTE.test(l) || RE_BULLET.test(l) || RE_ORDERED.test(l) || /^[ \t]{0,3}\$\$/.test(l)
  }

  function indentOf(line) {
    let n = 0
    for (const ch of line) {
      if (ch === ' ') n += 1
      else if (ch === '\t') n += 4
      else break
    }
    return n
  }

  function toolBtn(act, label) {
    return '<button type="button" class="sw-tool" data-md-act="' + act + '" title="' + esc(label) + '">' + esc(label) + '</button>'
  }

  function codeFigure(lang, code, ctx) {
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

  function mermaidFigure(code) {
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

  function splitRow(line) {
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

  function tableHtml(head, align, rows, ctx) {
    const cell = (text, i, tag) =>
      '<' + tag + (align[i] ? ' style="text-align:' + align[i] + '"' : '') + '>' + inline(text, ctx) + '</' + tag + '>'
    return (
      '<div class="sw-table" data-md="table">' +
      '<div class="sw-table-tools">' +
      toolBtn('copy-table', L('复制表格')) +
      '</div>' +
      '<div class="sw-table-scroll"><table>' +
      '<thead><tr>' +
      head.map((c, i) => cell(c, i, 'th')).join('') +
      '</tr></thead><tbody>' +
      rows.map((r) => '<tr>' + head.map((_, i) => cell(r[i] == null ? '' : r[i], i, 'td')).join('') + '</tr>').join('') +
      '</tbody></table></div></div>'
    )
  }

  /** 一段行渲染成块级 HTML。列表项和引用的内容回头调它自己。 */
  function blocks(lines, ctx) {
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
        const res = listAt(lines, i, ctx)
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
  function listAt(lines, start, ctx) {
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
        cur = [bullet ? bullet[3] : num[4]]
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

    const html = items
      .map((body) => {
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
            .map((r) => r.trim())
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
  function render(src, opts) {
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

  // ── 按需加载：KaTeX / highlight.js / Mermaid ─────────────────────────
  const CDN = window.SATU_CDN || 'https://cdn.jsdelivr.net/npm'
  const loaded = {}

  /**
   * 这三个库的路径和摘要。**摘要不是可选的。**
   *
   * 这几段脚本是拿这一页的源加载并执行的：CDN 哪天被投毒、或者 DNS 被劫持，进来的
   * 就是能读 sessionStorage / localStorage 的同源脚本，而那里躺着登录 JWT。SRI 让
   * 浏览器在执行之前先核一次内容——对不上就当加载失败，走这个文件开头写的那条降级路
   * （公式显示 TeX 原文、图显示源码、代码不高亮，页面不坏）。
   *
   * **改版本号就要同时换摘要**，两者是一对。取法：
   *
   *   curl -sSL <url> | openssl dgst -sha384 -binary | openssl base64 -A
   *
   * `window.SATU_CDN` 指到内网镜像时这几个摘要照样成立——它算的是内容，不是地址。
   * 镜像里放的要是另一个版本，这里会当场拒载，那也是对的。
   */
  const LIBS = {
    katexCss: {
      path: '/katex@0.16.11/dist/katex.min.css',
      sri: 'sha384-nB0miv6/jRmo5UMMR1wu3Gz6NLsoTkbqJghGIsx//Rlm+ZU03BU6SQNC66uf4l5+',
    },
    katexJs: {
      path: '/katex@0.16.11/dist/katex.min.js',
      sri: 'sha384-7zkQWkzuo3B5mTepMUcHkMB5jZaolc2xDwL6VFqjFALcbeS9Ggm/Yr2r3Dy4lfFg',
    },
    hljs: {
      path: '/@highlightjs/cdn-assets@11.10.0/highlight.min.js',
      sri: 'sha384-GdEWAbCjn+ghjX0gLx7/N1hyTVmPAjdC2OvoAA0RyNcAOhqwtT8qnbCxWle2+uJX',
    },
    mermaid: {
      path: '/mermaid@11.4.1/dist/mermaid.esm.min.mjs',
      sri: 'sha384-HteIAsnwkbgGVEAzdIZs19SFw7jEi5VYjjlP+WhnGhrjlHPiQxu8glOSahByV8DA',
    },
  }

  /** `crossorigin` 是 SRI 的前提：跨源的响应不按 CORS 取，浏览器读不到正文也就核不了。 */
  function loadScript(lib) {
    const src = CDN + lib.path
    if (!loaded[src]) {
      loaded[src] = new Promise((ok, no) => {
        const el = document.createElement('script')
        el.src = src
        el.async = true
        el.integrity = lib.sri
        el.crossOrigin = 'anonymous'
        el.onload = () => ok(true)
        el.onerror = () => no(new Error('load ' + src))
        document.head.appendChild(el)
      })
    }
    return loaded[src]
  }

  function loadStyle(lib) {
    const href = CDN + lib.path
    if (loaded[href]) return
    const el = document.createElement('link')
    el.rel = 'stylesheet'
    el.href = href
    el.integrity = lib.sri
    el.crossOrigin = 'anonymous'
    document.head.appendChild(el)
    loaded[href] = true
  }

  function katexLib() {
    if (!loaded.__katex) {
      loadStyle(LIBS.katexCss)
      loaded.__katex = loadScript(LIBS.katexJs).then(() => window.katex)
    }
    return loaded.__katex
  }

  function hljsLib() {
    if (!loaded.__hljs) {
      loaded.__hljs = loadScript(LIBS.hljs).then(() => window.hljs)
    }
    return loaded.__hljs
  }

  function mermaidLib() {
    if (!loaded.__mermaid) {
      const src = CDN + LIBS.mermaid.path
      /**
       * **动态 `import()` 挂不上 integrity**——语法里没有这一格。
       *
       * 所以先下一条 `modulepreload`：它带 integrity，浏览器按它取回并核验，随后那句
       * `import()` 命中的是同一条已经核过的记录。认这个属性的浏览器（Chrome / Edge /
       * Safari 17+ / Firefox 115+）拿到的是有校验的模块；不认的退回今天的行为——没有
       * 校验，但图照画，不会因为这一条而坏掉。
       */
      const pre = document.createElement('link')
      pre.rel = 'modulepreload'
      pre.href = src
      pre.integrity = LIBS.mermaid.sri
      pre.crossOrigin = 'anonymous'
      document.head.appendChild(pre)
      // v11 只发 ESM。经典脚本里用动态 import 拿得到。
      loaded.__mermaid = import(src).then((mod) => {
        const m = mod.default || mod
        m.initialize(mermaidConfig())
        return m
      })
    }
    return loaded.__mermaid
  }

  /** 让图跟着主题走：颜色直接读 theme.css 的令牌，深浅两套自动一致。 */
  function mermaidConfig() {
    const cs = getComputedStyle(document.documentElement)
    const v = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback
    return {
      startOnLoad: false,
      securityLevel: 'strict',
      fontFamily: v('--font-body', 'system-ui, sans-serif'),
      theme: 'base',
      themeVariables: {
        background: v('--popover', '#ffffff'),
        primaryColor: v('--color-accent-100', '#f8ece7'),
        primaryTextColor: v('--color-text', '#3d3929'),
        primaryBorderColor: v('--color-accent-400', '#d88d72'),
        lineColor: v('--color-neutral-500', '#b4b2a7'),
        secondaryColor: v('--card', '#f5f4ef'),
        tertiaryColor: v('--muted', '#ede9de'),
        textColor: v('--color-text', '#3d3929'),
        mainBkg: v('--color-accent-100', '#f8ece7'),
        nodeBorder: v('--color-accent-400', '#d88d72'),
        clusterBkg: v('--card', '#f5f4ef'),
        clusterBorder: v('--border', '#dad9d4'),
      },
    }
  }

  // ── enhance：把占位的公式 / 代码 / 图变成真东西 ──────────────────────
  /**
   * 对一棵刚插进 DOM 的子树做后处理。**幂等**：做过的节点打 data-done，重复调用不会
   * 重画——流式渲染下这个函数每帧都会被叫一次。
   */
  function enhance(root) {
    const scope = root && root.querySelectorAll ? root : document
    enhanceMath(scope)
    enhanceCode(scope)
    enhanceMermaid(scope)
  }

  function enhanceMath(scope) {
    const nodes = scope.querySelectorAll('.sw-math:not([data-done])')
    if (!nodes.length) return
    katexLib()
      .then((katex) => {
        for (const el of nodes) {
          if (el.getAttribute('data-done')) continue
          try {
            el.innerHTML = katex.renderToString(el.getAttribute('data-tex') || '', {
              displayMode: el.getAttribute('data-display') === '1',
              throwOnError: false,
              output: 'html',
            })
            el.setAttribute('data-done', '1')
          } catch {
            el.setAttribute('data-done', 'err')
          }
        }
      })
      // 拉不到 KaTeX 就留着 TeX 原文——看得懂，只是不好看。
      .catch(() => {
        for (const el of nodes) el.setAttribute('data-done', 'off')
      })
  }

  /**
   * 高亮完一块代码之后叫一声。
   *
   * 上色是把 `innerHTML` 整块换掉，外面往代码块里加过的东西（对话那边把文件名接成了
   * 可点开预览的链接）会一起被抹掉，而且抹在**异步**那一拍——外面自己看不见这件事
   * 发生。所以这里留一个回调：谁往里面加过东西，谁在这一拍再加一次。
   */
  let codeReady = null

  function fireCodeReady(el) {
    if (!codeReady) return
    try {
      codeReady(el)
    } catch {
      /* 回调是外面的事，坏了不该把高亮这一趟拖下水 */
    }
  }

  function enhanceCode(scope) {
    const nodes = scope.querySelectorAll('.sw-code pre code:not([data-done])')
    if (!nodes.length) return
    hljsLib()
      .then((hljs) => {
        for (const el of nodes) {
          if (el.getAttribute('data-done')) continue
          const lang = (el.className.match(/language-([\w+#.-]+)/) || [])[1]
          try {
            const src = el.textContent || ''
            const res = lang && hljs.getLanguage(lang) ? hljs.highlight(src, { language: lang, ignoreIllegals: true }) : hljs.highlightAuto(src)
            el.innerHTML = res.value
          } catch {}
          el.setAttribute('data-done', '1')
          fireCodeReady(el)
        }
      })
      // 拉不到 hljs 就不上色。**这一声照样要叫**：外面不该因为高亮没跑成，就永远等不到
      // 自己那一次补接——没有上色的代码块，里面的文件名一样该点得动。
      .catch(() => {
        for (const el of nodes) {
          el.setAttribute('data-done', 'off')
          fireCodeReady(el)
        }
      })
  }

  /**
   * Mermaid。
   *
   * 状态只认 `data-src`（画出来的是哪一版源码），不认 data-done —— 流式写到一半的图必然
   * 渲染失败，用 data-done 记「做过了」的话，等它写完就再也不会重试。
   *
   * 另外要**等源码停下来再画**：每帧拿半张图去渲染，既白烧 CPU，也会让画布在
   * 失败态和成功态之间闪。源码变一次就把定时器往后推一次，安静 220ms 才真的画。
   */
  const mermaidTimers = new WeakMap()

  function enhanceMermaid(scope) {
    for (const fig of scope.querySelectorAll('.sw-mermaid')) {
      const src = ((fig.querySelector('.sw-mermaid-src code') || {}).textContent || '').trim()
      if (!src || fig.getAttribute('data-src') === src) continue
      if (fig.getAttribute('data-pending') === src) continue
      fig.setAttribute('data-pending', src)
      clearTimeout(mermaidTimers.get(fig))
      mermaidTimers.set(
        fig,
        setTimeout(() => {
          if (fig.getAttribute('data-pending') !== src) return
          drawMermaid(fig, src)
        }, 220),
      )
    }
  }

  /**
   * 画一张图。
   *
   * 两件事跟直觉相反，都是 mermaid 自己的行为逼出来的：
   *
   * 1. **先 parse 再 render。** render 在源码有语法错时会往 document.body 上挂一张
   *    「Syntax error in text」的错误图，还留在那儿不收——页面底下于是慢慢堆起一排
   *    小人图。parse({ suppressErrors: true }) 只回 false，不碰 DOM。
   * 2. **收尾要自己扫。** render 过程中会往 body 塞一个临时容器（id 是 `d` + 我们给的
   *    那个 id），正常路径它自己会清，异常路径不一定。
   */
  function drawMermaid(fig, src) {
    const canvas = fig.querySelector('.sw-mermaid-canvas')
    if (!canvas) return
    const rid = 'sw-mm-' + Math.random().toString(36).slice(2)
    const sweep = () => {
      for (const id of [rid, 'd' + rid]) {
        const stray = document.getElementById(id)
        if (stray && !fig.contains(stray)) stray.remove()
      }
    }
    mermaidLib()
      .then(async (mermaid) => {
        const ok = await mermaid.parse(src, { suppressErrors: true })
        if (!ok) throw new Error('mermaid syntax')
        return mermaid.render(rid, src)
      })
      .then((res) => {
        sweep()
        if (fig.getAttribute('data-pending') !== src) return
        canvas.innerHTML = res.svg
        canvas.setAttribute('data-state', 'ok')
        fig.setAttribute('data-src', src)
        fig.setAttribute('data-view', 'diagram')
      })
      .catch(() => {
        sweep()
        if (fig.getAttribute('data-pending') !== src) return
        canvas.textContent = L('这张图画不出来，下面是源码。')
        canvas.setAttribute('data-state', 'err')
        fig.setAttribute('data-src', src)
        fig.setAttribute('data-view', 'source')
      })
  }

  /** 主题切换后重画所有 Mermaid：SVG 里的颜色是渲染那一刻写死的，不跟 CSS 走。 */
  function retheme() {
    if (!loaded.__mermaid) return
    loaded.__mermaid = loaded.__mermaid.then((m) => {
      m.initialize(mermaidConfig())
      return m
    })
    for (const fig of document.querySelectorAll('.sw-mermaid[data-src]')) {
      const src = fig.getAttribute('data-src')
      fig.removeAttribute('data-src')
      fig.setAttribute('data-pending', src)
      drawMermaid(fig, src)
    }
  }

  // ── 代码块 / 表格 / Mermaid 上那几个按钮 ─────────────────────────────
  function copyText(text, btn) {
    const done = () => {
      if (!btn) return
      const old = btn.getAttribute('data-label') || btn.textContent
      btn.setAttribute('data-label', old)
      btn.textContent = L('已复制')
      btn.setAttribute('data-ok', '1')
      setTimeout(() => {
        btn.textContent = old
        btn.removeAttribute('data-ok')
      }, 1400)
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => {})
      return
    }
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;opacity:0'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
      done()
    } catch {}
    ta.remove()
  }

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type: type || 'text/plain;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const EXT = { javascript: 'js', typescript: 'ts', python: 'py', bash: 'sh', shell: 'sh', markdown: 'md', yaml: 'yml', text: 'txt' }

  // 捕获阶段：app.js 的委托挂在 #app 上，冒泡会先到它那儿。这些按钮不归它管。
  document.addEventListener(
    'click',
    (e) => {
      const btn = e.target instanceof Element ? e.target.closest('[data-md-act]') : null
      if (!btn) return
      e.preventDefault()
      e.stopPropagation()
      const act = btn.getAttribute('data-md-act')
      const fig = btn.closest('figure, .sw-table')
      if (!fig) return

      if (act === 'copy') {
        const code = fig.querySelector('.sw-mermaid-src code, pre code')
        copyText(code ? code.textContent || '' : '', btn)
        return
      }
      if (act === 'download') {
        const lang = fig.getAttribute('data-lang') || 'text'
        const code = fig.querySelector('pre code')
        download('snippet.' + (EXT[lang] || lang.replace(/[^\w]/g, '') || 'txt'), code ? code.textContent || '' : '')
        return
      }
      if (act === 'mermaid-view') {
        const showingSource = fig.getAttribute('data-view') === 'source'
        fig.setAttribute('data-view', showingSource ? 'diagram' : 'source')
        btn.textContent = showingSource ? L('源码') : L('图')
        return
      }
      if (act === 'mermaid-svg') {
        const svg = fig.querySelector('.sw-mermaid-canvas svg')
        if (svg) download('diagram.svg', svg.outerHTML, 'image/svg+xml;charset=utf-8')
        else copyText((fig.querySelector('.sw-mermaid-src code') || {}).textContent || '', btn)
        return
      }
      if (act === 'copy-table') {
        const rows = []
        for (const tr of fig.querySelectorAll('tr')) {
          rows.push(Array.from(tr.children, (td) => (td.textContent || '').trim()).join('\t'))
        }
        copyText(rows.join('\n'), btn)
      }
    },
    true,
  )

  window.satuMd = {
    render,
    splitBlocks,
    healStream,
    enhance,
    retheme,
    esc,
    /** 注册「这块代码高亮完了」的回调。只留一个——用它的就对话那一处。 */
    onCodeReady: (fn) => {
      codeReady = typeof fn === 'function' ? fn : null
    },
  }
})()
