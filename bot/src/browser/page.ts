/**
 * 注进页面里跑的那一段。
 *
 * **为什么是注 JS，不是用 CDP 的 Accessibility 域。** 那个域给的是一棵带
 * backendDOMNodeId 的树，要点它还得再走一趟 DOM 域换节点、换盒子；而我们真正需要的
 * 只有「可交互的东西有哪些、各自叫什么、在屏幕的哪个位置」。一段自己写的遍历把这三样
 * 一次取回来，还顺手解决了 ref 的稳定性——ref 存在页面里的一张表上，`@e5` 指的就是
 * 那一次快照里的那个元素，不是「第五个按钮」这种会漂的说法。
 *
 * 页面一跳转，这段脚本连同那张表一起没了，所以每次调用都把定义和调用一起发过去，
 * 定义那半段自带「已经有了就别重来」的判断——重来会把 ref 表清空，而模型手上那些
 * `@e5` 就是从那张表里来的。
 */

/** 快照最多列多少个元素。超了截断并**明说**——闷声截断会让模型以为下面没东西了。 */
const MAX_NODES = 400

/**
 * 地址长过这个数就**整条不要**，而不是截一刀。
 *
 * 截断的 URL 不是一个更短的地址，是一个**错的**地址——而它照样以可点链接的样子摆到
 * 人面前，点下去落到别处，没有任何迹象表明它被动过手脚。带签名参数的下载链接、带一
 * 大串追踪参数的商品页都可能超。截文字（text）没关系，那只影响显示；截地址不行。
 *
 * 2000 是现实里 URL 的实用上限（IE 那条 2083 的老限制留下来的行业惯例），超过它的
 * 多半本来也不是给人点的。
 */
const MAX_URL = 2000

export const BOOTSTRAP = `
(() => {
  if (window.__satu) return
  const S = { refs: new Map(), ids: new WeakMap(), version: 0, seq: 0 }
  window.__satu = S

  const CLICKABLE = 'a[href],button,input,select,textarea,summary,[contenteditable=""],[contenteditable="true"],[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[role="switch"],[role="option"],[tabindex]:not([tabindex="-1"])'

  /** full=true 时额外列出来的正文结构。只出文字，不发 ref。 */
  const TEXTY = 'h1,h2,h3,h4,p,li,td,th'

  /**
   * 不在 CLICKABLE 里、但**明摆着能点**的东西也要列。
   *
   * 线上撞上的：一个 Vben 后台的侧栏菜单，「SC Device Management」是一个
   * div.vben-menu-submenu-title——没有 role、没有 tabindex，只挂了 Vue 的 @click。
   * 只认语义的话整个侧栏一个 ref 都没有，模型找不到能点的，就去按键盘、去拼路由，
   * 最后只能请人帮它点。Vue / React 写的后台里，菜单、卡片、图标按钮大多是这个样子。
   *
   * 认两样：
   * - 写着要被点的：onclick 属性、aria-haspopup、aria-expanded（折叠菜单、下拉触发器）。
   * - 鼠标放上去是一只手（cursor: pointer）。**只认最外那一层**——cursor 会继承，
   *   可点区域里每一层子元素都是 pointer，全列的话一个菜单项会占三四个 ref。
   *
   * 包着复选框的 label 不列：点它等于点里面那个框，而那个框已经在快照里了。
   */
  const HINTED = '[onclick],[aria-haspopup]:not([aria-haspopup="false"]),[aria-expanded]'
  const pointer = (el) => {
    try { return getComputedStyle(el).cursor === 'pointer' } catch (e) { return false }
  }
  S.pointy = (el) => {
    if (el === document.body || el === document.documentElement) return false
    if (el.tagName === 'LABEL' && el.control) return false
    if (el.matches(HINTED)) return true
    if (!pointer(el)) return false
    const up = el.parentElement
    return !up || !pointer(up)
  }

  const text = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()

  /** 可访问名。aria → 关联 label → 自身文字 → 占位符，第一个非空的算数。 */
  S.name = (el) => {
    const aria = el.getAttribute && el.getAttribute('aria-label')
    if (aria && aria.trim()) return aria.trim()
    const by = el.getAttribute && el.getAttribute('aria-labelledby')
    if (by) {
      const parts = by.split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean).map(text)
      if (parts.join(' ').trim()) return parts.join(' ').trim()
    }
    if (el.id) {
      const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]')
      if (lab && text(lab)) return text(lab)
    }
    const closest = el.closest && el.closest('label')
    if (closest && text(closest)) return text(closest)
    if (el.tagName === 'IMG' && el.alt) return el.alt.trim()
    if (el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'button')) return (el.value || '').trim()
    /**
     * 下拉框和输入框**不拿自身文字当名字**。select 的 innerText 是全部选项拼起来
     * 的一长串（「甲 乙 丙…」），拿它当名字，模型看到的是一个叫「甲 乙 丙」的控件，
     * 而它真正想找的是那个没有 label 的下拉框。宁可留空。
     */
    const tag = el.tagName
    if (tag !== 'SELECT' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
      const own = text(el)
      if (own) return own.slice(0, 120)
    }
    const ph = el.getAttribute && el.getAttribute('placeholder')
    if (ph) return ph.trim()
    const title = el.getAttribute && el.getAttribute('title')
    if (title) return title.trim()
    return ''
  }

  S.role = (el) => {
    const explicit = el.getAttribute && el.getAttribute('role')
    if (explicit) return explicit
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'button') return 'button'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase()
      if (t === 'checkbox' || t === 'radio') return t
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button'
      return 'textbox'
    }
    if (el.isContentEditable) return 'textbox'
    return tag
  }

  /**
   * 可交互元素的角色。没有语义的那些（div、li、span……）一律叫 clickable——
   * 写成「- div "SC Device Management"」，模型看不出这一行是能点的。
   */
  S.actRole = (el) => {
    const role = S.role(el)
    return role === el.tagName.toLowerCase() ? 'clickable' : role
  }

  S.visible = (el) => {
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false
    return true
  }

  /**
   * 一次新的快照。
   *
   * **ref 表不清空，同一个元素永远是同一个 ref。**
   *
   * 一开始写的是「每次快照重发一遍 @e1、@e2…」，那样有个不出声的错法：页面变了之后，
   * 模型手上那个 @e5 在新表里照样查得到，只是指向了**另一个元素**——于是它以为自己
   * 点的是「取消」，实际点的是「确认」。版本号挡不住这种，因为版本号是我们自己填的。
   *
   * 认元素、不认序号之后，旧 ref 只有两种下场：还是那个元素（那就没问题），或者
   * 元素已经从页面上掉了（isConnected 为假，明确报错）。两种都不会点错人。
   */
  S.snapshot = (full, base) => {
    /**
     * **序号要接着上一份文档往下发。**
     *
     * 页面一跳转，这段脚本连同 ref 表一起没了，从 1 重新发的话，新页面上的 @e2 和
     * 旧页面上的 @e2 长得一模一样——模型隔一次跳转回头用一个 ref，会点到一个它从没
     * 见过的元素上，而且没有任何东西会报错。base 由席位那边传进来（它记得发到几号了）。
     */
    if (base && S.seq < base) S.seq = base
    S.version += 1
    // 一条会话可以很长。攒到这个数就整体丢掉重来——丢掉的后果只是旧 ref 报「不认识」，
    // 而不丢的后果是这张表跟着页面一直涨。
    if (S.refs.size > 5000) { S.refs = new Map(); S.ids = new WeakMap() }
    const lines = []
    /**
     * 这一页上的链接：**地址要带出去**。
     *
     * 早先快照只写「- link "Learn more" [@e12]」——名字有、地址没有。后果是模型手上
     * 从来就没有链接可给：让它列十个搜索结果，它只能给出十个标题，人拿到之后还得自己
     * 去搜一遍。
     *
     * 地址只写进正文这一份就够：模型看的就是正文，而「让用户点得进去」这件事落在它把
     * 地址写成 markdown 链接上（见 agent 里 linkOutBlock 那段）。早先还另外结构化带了
     * 一份给界面，界面拿它在回答底下摆一排药丸——那排东西和回答对不上号，已经撤掉。
     */
    const hrefOf = (el) => {
      // el.href 是**解析过的绝对地址**（相对路径、"./x" 都已经展开），比 getAttribute 可靠。
      const href = typeof el.href === 'string' ? el.href : ''
      if (!href) return ''
      // 页内锚点和 javascript: 不算链接：前者不换页，后者根本不是地址。
      // 反斜杠要写两遍。这段整个在一个模板字符串里，单个反斜杠会被吃掉一层，
      // 发到页面上的就成了提前闭合的正则——整段脚本语法错误，而表现是**所有**
      // browser_* 一起失灵。同理这里面一个反引号都不能出现。见文件头那段说明。
      if (!/^https?:\\/\\//i.test(href)) return ''
      if (href.split('#')[0] === location.href.split('#')[0]) return ''
      // 超长的整条丢掉，见 MAX_URL：截出来的是个错地址，比没有更坏。
      if (href.length > ${MAX_URL}) return ''
      return href
    }
    let cut = false
    const push = (line) => {
      if (lines.length >= ${MAX_NODES}) { cut = true; return false }
      lines.push(line)
      return true
    }
    const ref = (el) => {
      const known = S.ids.get(el)
      if (known) return known
      const id = '@e' + (++S.seq)
      S.refs.set(id, el)
      S.ids.set(el, id)
      return id
    }
    /**
     * 按文档顺序走一遍全部元素，而不是只取 CLICKABLE：「看起来能点」的那些（见 S.pointy）
     * 没有选择器能一次挑出来，要逐个看样式。
     *
     * 只靠样式认出来的、又没有名字的不列。光秃秃一行「- clickable ""」模型不知道它是什么，
     * 而这种行在装饰性的包裹层上会有一大堆，把 MAX_NODES 吃掉。
     */
    for (const el of document.querySelectorAll('body *')) {
      const native = el.matches(CLICKABLE)
      const loose = !native && S.pointy(el)
      if (!native && !loose && !(full && el.matches(TEXTY))) continue
      if (!S.visible(el)) continue
      const name = S.name(el)
      const interactive = native || (loose && Boolean(name))
      const role = interactive ? S.actRole(el) : S.role(el)
      if (!interactive) {
        if (!el.matches(TEXTY)) continue
        if (!name) continue
        if (!push('  ' + role + ' "' + name.slice(0, 200) + '"')) break
        continue
      }
      const bits = []
      /**
       * 密码框：打一个 password 标记（**放在最前**，策略靠它认「这是在登录」），值不列——
       * 列出来就是把员工的密码读进模型、写进会话日志。
       *
       * 看的是 input 的 type，**不看 role**：role 先取元素上显式写的那个（组件库常给密码框
       * 写 role=searchbox 之类），按 role 判的话这种密码框既不打标记、也认不出是在登录。
       */
      const secret = el.tagName === 'INPUT' && String(el.type || '').toLowerCase() === 'password'
      if (secret) bits.push('password')
      else if (el.value !== undefined && el.value !== '' && role === 'textbox') bits.push('value="' + String(el.value).slice(0, 80) + '"')
      if (el.checked) bits.push('checked')
      if (el.disabled) bits.push('disabled')
      if (role === 'combobox') {
        const opts = [...(el.options || [])].slice(0, 12).map((o) => o.value || o.text)
        if (opts.length) bits.push('options=[' + opts.join(', ') + ']')
      }
      /**
       * 地址跟在行尾。**只给链接，不给按钮**——按钮没有地址，而给每一行都塞点东西
       * 只会让这份快照更长，而它已经是进上下文的大头。
       */
      const href = role === 'link' ? hrefOf(el) : ''
      if (!push('- ' + role + ' "' + name + '" [' + ref(el) + ']' + (bits.length ? ' ' + bits.join(' ') : '') + (href ? ' ' + href : ''))) break
    }
    return {
      version: S.version,
      url: location.href,
      title: document.title,
      body: lines.join('\\n'),
      truncated: cut,
    }
  }

  /**
   * 取元素。
   *
   * 不比版本号——ref 认的是元素本身（见 snapshot 上的说明）。页面整个跳转之后，这段
   * 脚本连同这张表一起没了，旧 ref 落到 'gone'；SPA 原地重渲染的话元素还在表里但已经
   * 脱离文档，落到 'detached'。两条路都比「点到了另一个元素」强。
   */
  S.get = (ref) => {
    const el = S.refs.get(ref)
    if (!el) return { err: 'gone' }
    if (!el.isConnected) return { err: 'detached' }
    return { el }
  }

  /** 点之前先滚进视口：视口外的元素坐标是负的，鼠标事件会落在别的东西上。 */
  S.locate = (ref) => {
    const hit = S.get(ref)
    if (hit.err) return hit
    hit.el.scrollIntoView({ block: 'center', inline: 'center' })
    const rect = hit.el.getBoundingClientRect()
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      name: S.name(hit.el),
      role: S.actRole(hit.el),
    }
  }

  S.focusOn = (ref) => {
    const hit = S.get(ref)
    if (hit.err) return hit
    const el = hit.el
    el.scrollIntoView({ block: 'center' })
    el.focus()
    // 先清空。原地追加会把「填一个新值」变成「在旧值后面接一段」，而模型以为它换掉了。
    if (el.value !== undefined) {
      el.value = ''
      el.dispatchEvent(new Event('input', { bubbles: true }))
    } else if (el.isContentEditable) {
      el.textContent = ''
    }
    return { name: S.name(el), role: S.actRole(el) }
  }

  S.selectOptions = (ref, values) => {
    const hit = S.get(ref)
    if (hit.err) return hit
    const el = hit.el
    if (!el.options) return { err: 'notselect' }
    let hits = 0
    for (const opt of el.options) {
      const on = values.includes(opt.value) || values.includes(opt.text)
      opt.selected = on
      if (on) hits += 1
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { picked: hits, name: S.name(el) }
  }

  /**
   * 读正文。优先 main / article——整个 body 里混着导航、页脚和一堆按钮文字，
   * 那些在快照里已经有了，再读一遍只是把上下文填满。
   */
  S.read = (ref) => {
    let root = document.querySelector('main') || document.querySelector('article') || document.body
    if (ref) {
      const hit = S.get(ref)
      if (hit.err) return hit
      root = hit.el
    }
    const body = (root.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim()
    /**
     * **在页面里就先截一刀。**
     *
     * 席位那边还会再截一次（给模型看的那份更短），但那是截完之后的事——不在这儿截的话，
     * 一张几兆的表格页会把整段正文经 CDP 的 WebSocket 原样搬过来一趟，只为了在下一行
     * 被扔掉 95%。总字数照实报，截断的话由调用方去讲。
     */
    return { url: location.href, title: document.title, body: body.slice(0, 200000), total: body.length }
  }

  S.scrollBy = (dir, amount) => {
    const step = amount || Math.round(window.innerHeight * 0.8)
    const map = { down: [0, step], up: [0, -step], right: [step, 0], left: [-step, 0] }
    const d = map[dir] || map.down
    window.scrollBy(d[0], d[1])
    return { x: window.scrollX, y: window.scrollY, height: document.body.scrollHeight, viewport: window.innerHeight }
  }

  /** 页面上有没有这段文字。wait_for 靠它轮询。 */
  S.hasText = (needle) => (document.body.innerText || '').includes(needle)

  /** 当前地址。策略问「这次动作作用在哪一页」时用得上。 */
  S.where = () => ({ url: location.href, title: document.title })
})();
`

/** 把一次调用拼成 `Runtime.evaluate` 的表达式：定义 + 调用，一趟 round trip。 */
export function callExpr(fn: string, args: unknown[] = []): string {
  return `${BOOTSTRAP}\n(window.__satu.${fn}).apply(null, ${JSON.stringify(args)})`
}
