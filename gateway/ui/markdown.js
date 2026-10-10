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
 * CDN 地址跟着 Gateway 的 `GATEWAY_UI_CDN` 走（内网部署时指到自己的镜像）：Gateway 换了
 * 镜像就在页面里插一条 `<meta name="satu-cdn">`，这里读它；没有就用 jsdelivr。CSP 的
 * script-src 只放行 LIBS 里那几个「包@版本/」目录（见 gateway/src/ui-cdn.ts），**在这里
 * 加库或改版本要同时改那张表**，否则浏览器把脚本挡掉，表现和「CDN 拉不到」一模一样。
 */
;(function () {
  'use strict'

  /* ══ 解析半边在 core ═══════════════════════════════════════════════════
     文本 → HTML 字符串那一半（healStream / splitBlocks / render / safeUrl / esc）搬到了
     core/src/markdown/render.ts，经 core.js 的 SatuCore.createMarkdown 拿回来。改解析去那边，
     改完重打 core.js；e2e 的 markdown.mjs 经这里喂它。

     两样东西从这边给过去：界面文案 t()（markdown.js 先于 prefs.js 加载，所以只能运行时去拿），
     以及「人点过加载的站外图片」那张表 loadedImages——下面图片兜底那一处往里加，解析半边重画时
     据此不再把它变回按钮。
     ══════════════════════════════════════════════════════════════════ */
  const md = SatuCore.createMarkdown({ t: (zh) => (typeof window.t === 'function' ? window.t(zh) : zh) })
  const { esc, render, splitBlocks, healStream, loadedImages } = md

  /** 界面文案走 app.js 的 t()。markdown.js 先加载，所以只能运行时去拿。 */
  function L(zh) {
    return typeof window.t === 'function' ? window.t(zh) : zh
  }

  const CDN = (function () {
    const meta = document.querySelector && document.querySelector('meta[name="satu-cdn"]')
    const v = meta && meta.getAttribute('content')
    return v ? v.replace(/\/+$/, '') : 'https://cdn.jsdelivr.net/npm'
  })()
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
   * CDN 指到内网镜像时这几个摘要照样成立——它算的是内容，不是地址。
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
      if (act === 'load-image') {
        // 人点了才拉（见 inline 里 RE_IMG 那段）。记下这个地址，之后重画同一条消息时直接出图。
        const src = btn.getAttribute('data-src') || ''
        if (!/^https?:\/\//i.test(src)) return
        loadedImages.add(src)
        const img = document.createElement('img')
        img.setAttribute('data-md', 'image')
        img.alt = btn.getAttribute('data-alt') || ''
        img.src = src
        btn.replaceWith(img)
        return
      }
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
