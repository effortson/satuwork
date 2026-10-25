/** 右栏的工作区文件树。原先在 chat.js 里，拆出来只是搬家（顺序见 index.html）。 */
/* ── 工作区文件 ───────────────────────────────────────────────────────────
 *
 * 右栏的另一屏：这台席位工作区里到底有些什么。
 *
 * 为什么要有它：在此之前，一个文件想被人看见，必须先在对话里被提到——Bot 写出来的
 * 那份报告、上传上去的那个附件。可工作区是**同一个员工所有席位共用的一个目录**，
 * 上周那次对话生成的东西、今天早上日常任务跑出来的东西，全都在里面躺着，界面上却
 * 一个入口都没有，人只能反过来问 Bot「我那份报告叫什么来着」。
 *
 * 一次只取一层（`/runtime/sessions/:id/workspace?path=`），展开哪个目录取哪个：
 * 跑上几周的工作区底下是几千个文件，一次拉整棵树既慢又没人看得完。
 */

/**
 * 文件那一屏开着、但这条会话的根还没取过：补一次。
 *
 * 挂在每次重绘上，而不是在「点开那一屏」那一处调一次——进这一页的路不止一条
 * （偏好里本来就开着、从别的页面切回来、席位刚接上），少接一条的表现就是那一屏
 * 永远停在「载入中」。取过一次之后这里是两个等值判断，白跑也不值几个周期。
 *
 * **「取过了」是按会话记的，不是按「这个格子有没有东西」记的**（state.wsSession）。
 * 这一条是那个「第一次打开文件夹是空的、按一下刷新就出来了」的原因：进页面那会儿
 * 席位还没接上，`chatSessionId` 是空的，这一屏立刻拿到一句「实例还没接上」——而那
 * 句话本身就算「取过了」，于是十几秒后席位接上、对话正常了，这一屏还停在原地，除非
 * 有人去按那颗刷新。会话从空串变成一个 id，本身就是「刚才那次不作数」。
 *
 * **推迟一拍再取，不在这一帧里动手。** 这个函数是从 render() 和 paintChat 里叫的，而
 * loadWorkspaceDir 开跑之前会 render() 一次；在重绘中间再来一次整页重绘，会把
 * paintChat 手上那个 #chat-thread 整个换掉，它接着往一个已经脱离文档的节点上画——
 * 往前翻历史时那套「内容在上面长高了多少就把视线推回多少」的锚定，就是这么失灵的。
 *
 * 那道「取过没有」的闸这里也要判一遍（loadWorkspaceDir 里还有一道）：不判的话，
 * 流式的每一帧都会排一个白跑的定时器出去。
 */
function ensureWorkspaceTree() {
  if (!wsPanelOnScreen()) return
  // 会话换了（切了 Bot、席位重建过、或者刚从「还没接上」变成接上了）：手上这棵树是
  // 上一台席位的，连同「取过了」这件事一起作废。
  if ((state.wsSession || '') !== (state.chatSessionId || '')) resetWorkspaceTree()
  const cur = wsDirs()['']
  if (cur && (cur.loading || cur.entries)) return
  // 上一趟失败了：**看是哪种失败**。「这个席位没有这条接口」那种再问一百遍也是同一个
  // 答案；而「席位还在热身」是**时间问题**——人进页面那会儿正好赶上，凭什么要他自己
  // 去按刷新才看得到文件。所以只有后者带 retryAt，到点了自己再来一趟。
  if (cur && cur.error && !(cur.retryAt && Date.now() >= cur.retryAt)) return
  if (wsPending) return
  wsPending = true
  setTimeout(() => {
    wsPending = false
    // 这一拍之内人可能已经切走了、或者把那一屏收起来了。再取一份没人看的目录、还为它
    // 整页重绘一次，会把新那一页上正在打字的输入框换掉。
    if (!wsPanelOnScreen()) return
    void loadWorkspaceDir('', Boolean(cur && cur.error))
  }, 0)
}

/**
 * 已经排了一个「去取根目录」的定时器。
 *
 * 排队的这一拍里 wsDirs 还是空的（或者还挂着上一趟那条错），于是同一拍里的每一次
 * 重绘——流式的时候一拍能来好几次——都会再排一个，最后是好几条一模一样的请求同时
 * 出发。真正拦住它们的只有 loadWorkspaceDir 里那道 loading 闸，而那道闸要等第一条
 * 跑起来才立得住。
 */
let wsPending = false

/**
 * 文件那一屏此刻在不在屏幕上。
 *
 * **不看 #chat-thread**。那个节点只在「有 Bot、而且席位已经部署过」的时候才画得出来
 * （见 chatPage 里的 chatDeployPrompt），可右栏那一屏在别的形态下照样开着——盯着它等
 * 于在那几种形态下一次都不取，那一屏永远是「载入中」。
 */
function wsPanelOnScreen() {
  return hasAside() && asideOpen() && asidePref.tab === 'files'
}

/**
 * 换了一条会话（切 Bot、席位重建过、席位刚接上）：手上这棵树是上一台席位的，作废。
 */
function resetWorkspaceTree() {
  state.wsDirs = {}
  state.wsOpen = {}
  // 茬数跟着一起清。这棵树整个换了，在途那几趟本来就靠下面那句会话判据作废，
  // 留着旧计数只会让这张表一直长。
  state.wsGen = {}
  // 记下这一次作废是冲着哪条会话去的，免得下一次重绘又判成「会话换了」，一帧作废一次。
  state.wsSession = state.chatSessionId || ''
  // 不在这里重取：那一屏开着的话，下一次重绘自己会补（见 ensureWorkspaceTree）。
}

/** 目录的展开状态与内容。key 是相对工作区根的路径，根目录是空串。 */
function wsDirs() {
  return state.wsDirs || (state.wsDirs = {})
}

/**
 * 这一层现在是「第几茬」（见 state.js 的 wsGen）。
 *
 * **在途的那一趟只看会话是不够的。** 删一个目录、和「刷新」正在取它，这两件事撞在
 * 一起时会话根本没变：那一趟回来会把刚删掉的那份内容原样写回缓存。人当时看不见——
 * 那一行已经从上一层里消失了——直到 Bot 又建出一个同名目录（每传一个附件都会建
 * `uploads/<sessionId>`），展开它看到的是上一茬的文件，点开全是「文件不存在」，
 * 而且只有按刷新才好得了。
 */
function wsGenOf(key) {
  return (state.wsGen || (state.wsGen = {}))[key] || 0
}

/** 这一层作废了：茬数 +1，在途那一趟回来对不上就自己扔掉。 */
function wsBumpGen(key) {
  const gens = state.wsGen || (state.wsGen = {})
  gens[key] = (gens[key] || 0) + 1
}

/**
 * 软失败隔多久自己再来一趟。
 *
 * 十秒是照着「席位热身」定的：那一段通常是几十秒，重试个几次就赶上了，而人在这十秒里
 * 多半还在读上面那句话。再短就成了打席位，再长就不如让他自己去按刷新。
 */
const WS_RETRY_MS = 10_000

/** 取一层。已经取过就不再取——除非 force（那是人按了刷新，或者软失败到点了）。 */
async function loadWorkspaceDir(path, force) {
  const key = path || ''
  const dirs = wsDirs()
  const cur = dirs[key]
  // 取过、正在取、或者上次取失败了，都不再自动重来——这个函数每次重绘都会被叫一次
  // （见 ensureWorkspaceTree），失败了还自动重试的话，一台没上线的席位会被打成一串
  // 重试。重来的入口是那颗刷新，外加「会话换了」——那不是重试，那是另一台席位。
  if (!force && cur && (cur.loading || cur.entries || cur.error)) return
  // 这一趟是给哪条会话取的。**记下来**：席位接上之后 ensureWorkspaceTree 靠它判出
  // 「刚才那次不作数」，重取一遍。
  const sid = state.chatSessionId || ''
  state.wsSession = sid
  if (!sid) {
    // 会话还没接上（席位刚起来那几十秒）。**说出来**，别画一棵空树让人以为工作区是空的。
    // 这句话不是终点：会话一到手，上面那句 wsSession 就对不上了，那一屏自己会再取一次。
    dirs[key] = { loading: false, error: t('实例还没接上，稍后再看'), entries: null }
    render()
    return
  }
  // 这一趟取的是这一层的**第几茬**。删掉一层（连带它的上一层）会把茬数往前推一格，
  // 回来时对不上就说明手上这份东西已经被删掉了，见 wsGenOf。
  const gen = wsGenOf(key)
  /**
   * 「这一趟还作不作数」。两条判据，缺一条就会有一份陈的东西写进缓存：
   *
   * · **会话**——人换了 Bot、席位重建过，那是另一台机器的目录。
   * · **茬数**——这一层在半路上被删掉了（或者上一层被删了、正在重取）。会话在这种
   *   情况下一动不动，光看它拦不住。
   *
   * 对不上就**什么都不做**，不去清 dirs[key]：那一格这会儿要么已经被删除那一路扔掉了，
   * 要么装着新一趟刚写进去的东西——顺手清一下正好把新的抹了。
   */
  const stale = () => (state.chatSessionId || '') !== sid || wsGenOf(key) !== gen
  dirs[key] = { ...(cur || {}), loading: true, error: '' }
  render()
  try {
    const url = '/runtime/sessions/' + encodeURIComponent(sid) + '/workspace?path=' + encodeURIComponent(key)
    const data = await api('GET', url)
    // 这一趟在路上的时候人可能已经换了 Bot、席位也可能重建过，也可能这一层刚被删掉。
    // **这份结果不作数**：写回去就是把上一台席位（或者上一茬）的目录挂在这一屏上，
    // 而 dirs 这会儿多半已经是被 resetWorkspaceTree 换掉的那个空对象，写进去连画都
    // 画不出来。
    if (stale()) return
    // 席位回的不是一份目录（反代把别的什么塞回来了、或者回了一个空身子）：那是**没
    // 取到**，不是「工作区是空的」。差别全在人接下来会做什么——后者他会去传个文件，
    // 前者他该再取一次。
    const list = data && Array.isArray(data.entries) ? data.entries : null
    if (!list) {
      // **带一个状态码往下抛。** 下面那道分档拿 `!e.status` 认「根本没走到 Gateway」，
      // 光杆一个 Error 会被认成那一种，摆出一句「连不上服务器」——而这一趟明明走到了
      // 席位，只是回来的东西不对。502 说的正是这件事：上游回了一份不认识的东西。
      const err = new Error(t('列不出来'))
      err.status = 502
      throw err
    }
    wsDirs()[key] = {
      loading: false,
      error: '',
      entries: list,
      more: Number((data && data.more) || 0),
    }
  } catch (e) {
    // 同上：换过会话、或者这一层已经被删掉了，都不作数。一条「上一台席位列不出来」
    // 挂在新席位那一屏上，人只会拿它去猜新席位的毛病；而给一个刚被删掉的目录重新
    // 摆一条错，等于把那一行又种回树上。
    if (stale()) return
    // 席位版本旧的时候这条路由根本不存在，席位回的是 404 加一句 `unknown endpoint`
    // （见 bot 那边 /api/* 的兜底）。照抄给人看等于没说——这一屏是新的，旧席位上没有，
    // 那就直说要更新（和文档提取那条同一个说法，见 openPreview）。
    //
    // **先看状态码。** 文案会被 errText() 过一遍译表，拿它当唯一判据是 data.js 明说过
    // 别做的事；而「目录真的不见了」同样是 404，所以文案还得跟着一起看。
    // 截一段就够。这条错在最坏的情况下不是一句话——反代在前面挡一下，回来的可能是
    // 整页 HTML 错误页（api() 拿不到 JSON 就把响应体原样当消息），糊满右栏那一条。
    const raw = (e.message || '').slice(0, 200)
    /**
     * **压根没走到 Gateway**：`api()` 里那句 `await fetch()` 自己 reject 了，抛出来的是
     * 浏览器的 TypeError，没有 status，`errText` 也过不上（它只作用在 `!res.ok` 上）。
     * Gateway 正在重启、网断了一秒、机器刚从睡眠里醒过来，都长这样。
     *
     * 这是**最该自己再来一趟**的一种，偏偏最容易掉进「答案不会变」那一档去；照抄
     * `e.message` 给人看则是在右栏上摆一句没翻译的 “Failed to fetch”。
     */
    const offline = !e.status
    wsDirs()[key] = {
      loading: false,
      error: offline
        ? t('连不上服务器，过一会儿自己会再试一次', 'Cannot reach the server — this will retry shortly.')
        : e.status === 404 && /unknown endpoint/i.test(raw)
        ? t('这个席位还不支持列工作区文件（要更新 Bot 版本）', 'This seat cannot list workspace files yet (update the bot).')
        : raw || t('列不出来'),
      entries: null,
      // 「那头这会儿不行」的都排一次重来（见 ensureWorkspaceTree）：席位还在热身、管家
      // 没应声、反代超时（5xx），以及上面那种根本没出门的。4xx 不给——那是「答案不会
      // 变」，重试只是在打一台已经把话说清楚了的席位。
      retryAt: offline || e.status >= 500 ? Date.now() + WS_RETRY_MS : 0,
    }
  }
  render()
}

/** 点一下目录：开就收、收就开，第一次展开时才去取内容。 */
async function toggleWorkspaceDir(path) {
  const key = path || ''
  const open = state.wsOpen || (state.wsOpen = {})
  if (open[key]) delete open[key]
  else open[key] = true
  render()
  if (open[key]) await loadWorkspaceDir(key)
}

/**
 * 刷新。**已经展开的那几层全部重取**，只重取根的话，人正看着的那一层照旧是旧的——
 * 而按刷新的时刻，多半正是「Bot 刚说它写好了，我想看看在不在」。
 */
async function refreshWorkspaceTree() {
  const keys = ['', ...Object.keys(state.wsOpen || {})]
  await Promise.all([...new Set(keys)].map((k) => loadWorkspaceDir(k, true)))
}

/** 行末那颗删除用的字纸篓。和日常任务那一颗同一份路径，两处画的是同一个动作。 */
const WS_TRASH = ['M4 7h16', 'M9 7V5h6v2', 'M6 7l1 13h10l1-13']

/** 这条路径的上一层。根底下的东西回空串，那正是根目录自己的 key。 */
function wsParentOf(path) {
  const i = String(path || '').lastIndexOf('/')
  return i < 0 ? '' : String(path).slice(0, i)
}

/**
 * 删掉树上的一个文件或目录。**走到这儿人已经在确认框上点过「删除」了**（见 app.js
 * 的 ws-del），这里不再问第二遍。
 *
 * 删完只重取**上一层**，不整棵树重来：人删的是眼前这一行，别的层没有理由跟着闪一下，
 * 而且一次刷新会把还在路上的展开状态全部拉一遍。
 *
 * 删掉一个目录时，手上缓存着的它自己和它底下那几层要一起扔掉：不扔的话，下次有人
 * 建了个同名目录再展开，看到的是上一份内容——那些文件早就不在了。
 */
async function deleteWorkspaceEntry(path, name) {
  const key = String(path || '')
  const sid = state.chatSessionId || ''
  if (!key || !sid) {
    flash('err', t('实例还没接上，稍后再看'))
    render()
    return
  }
  try {
    await api('DELETE', '/runtime/sessions/' + encodeURIComponent(sid) + '/workspace?path=' + encodeURIComponent(key))
    flash('ok', t(`已删除 ${name || key}`, `Deleted ${name || key}`))
  } catch (e) {
    // 席位版本旧的时候这条路由压根不存在，回的是 404 加一句 `unknown endpoint`（见 bot
    // 那边 /api/* 的兜底）。**这一条要排在下面那条前面**：照 404 认成「已经不在了」的话，
    // 人会收到一句「删掉了」，刷新一下那个文件却还在——而真正的原因是席位该更新了。
    // 和列目录那条同一个说法（见 loadWorkspaceDir）。
    const raw = (e.message || '').slice(0, 200)
    if (e.status === 404 && /unknown endpoint/i.test(raw)) {
      flash('err', t('这个席位还不支持删工作区文件（要更新 Bot 版本）', 'This seat cannot delete workspace files yet (update the bot).'))
      render()
      return
    }
    // 404 = 那个东西本来就不在了（别处删过、Bot 自己清掉了）。**不当失败说**：人要的
    // 结果已经成立，摆一句红字只会让他以为还得再删一次。下面照旧重取一遍，那一行
    // 自己会消失。
    if (e.status !== 404) {
      flash('err', e.message)
      render()
      return
    }
    flash('ok', t(`${name || key} 已经不在了`, `${name || key} was already gone`))
  }
  // 这一趟在路上的时候人可能已经换了 Bot（那棵树整个作废了）。写回去只会把一棵
  // 属于上一台席位的树重新种回来。
  if ((state.chatSessionId || '') !== sid) return
  const dirs = wsDirs()
  const open = state.wsOpen || (state.wsOpen = {})
  // 扔掉的每一层都推一格茬数（连自己，哪怕它压根没被取过）。**光删缓存不够**：按了
  // 刷新之后那几趟正在路上，删完它们才回来，会把这份内容原样写回去（见 wsGenOf）。
  wsBumpGen(key)
  for (const k of Object.keys(dirs)) {
    if (k === key || k.startsWith(key + '/')) {
      delete dirs[k]
      wsBumpGen(k)
    }
  }
  for (const k of Object.keys(open)) {
    if (k === key || k.startsWith(key + '/')) delete open[k]
  }
  // **上一层也要推一格**，而且要赶在重取之前：刷新那一趟可能正取着它，回来会把刚
  // 删掉的那一行原样摆回去——而人眼前正是「我刚删掉的东西怎么又回来了」。
  const parent = wsParentOf(key)
  wsBumpGen(parent)
  await loadWorkspaceDir(parent, true)
}

/** 右栏那一屏。整页重绘时从 state 重画，没有自己的增量逻辑——它小，且不常动。 */
function workspacePanel() {
  const root = wsDirs()[''] || {}
  const head = `<div class="sw-ws-head">
    <h3>${t('工作区文件')}</h3>
    <button type="button" class="btn btn-ghost btn-icon" data-act="ws-refresh"
      aria-label="${esc(t('刷新'))}" title="${esc(t('刷新'))}">${svg(REFRESH, 15)}</button>
  </div>`
  return `<div class="sw-ws">${head}${wsBody(root)}</div>`
}

function wsBody(root) {
  if (root.error) return `<div class="gw-flash gw-flash-err" style="margin: 0;">${esc(root.error)}</div>`
  if (!root.entries) return `<p class="sw-ws-note">${t('载入中…')}</p>`
  if (!root.entries.length) return `<p class="sw-ws-note">${t('工作区还是空的。上传一个文件，或者让 Bot 写点什么。')}</p>`
  return `<ul class="sw-ws-tree">${wsRows('', 0)}</ul>`
}

/**
 * 行末那颗删除。
 *
 * **必须是行那颗按钮的兄弟，不能画在它里面**：整行本身就是一颗 `<button>`（点开预览
 * 或者展开目录），按钮套按钮是非法 HTML，浏览器会把里层那颗拎出去——真出来的 DOM 里
 * 它就不在行里了，点谁都是外面那一下。所以行和它并排装在 `.sw-ws-item` 里。
 *
 * 平时透明，鼠标移到这一行上（或者键盘 tab 到它）才现身：右栏本来就窄，几十行各挂一颗
 * 红图标，人第一眼看到的会是一排删除，而不是自己的文件。**位置常占着**——不占位的话
 * 鼠标一进来整行的名字就被挤短一截，读到一半的文件名会跳。
 */
function wsDelBtn(e) {
  const label = e.dir
    ? t('删掉这个文件夹', 'Delete this folder')
    : t('删掉这个文件', 'Delete this file')
  return `<button type="button" class="btn btn-ghost btn-icon sw-ws-del" data-act="ws-del"
    data-path="${esc(e.path)}" data-name="${esc(e.name)}" data-dir="${e.dir ? '1' : ''}"
    aria-label="${esc(label)}" title="${esc(label)}">${svg(WS_TRASH, 14)}</button>`
}

/** 一层的行。展开的目录把下一层接在自己后面，靠左边距表示深度。 */
function wsRows(key, depth) {
  const dir = wsDirs()[key] || {}
  const out = []
  for (const e of dir.entries || []) {
    const open = Boolean((state.wsOpen || {})[e.path])
    if (e.dir) {
      out.push(
        `<li><div class="sw-ws-item"><button type="button" class="sw-ws-row" data-act="ws-dir" data-path="${esc(e.path)}"
          style="padding-left: ${8 + depth * 12}px" aria-expanded="${open}" title="${esc(e.path)}">
          <span class="sw-ws-caret">${svg(open ? CHEVRON_SMALL_DOWN : CHEVRON_SMALL_RIGHT, 12)}</span>
          <span class="sw-ws-name">${esc(e.name)}</span>
        </button>${wsDelBtn(e)}</div></li>`,
      )
      if (open) out.push(wsRows(e.path, depth + 1))
      continue
    }
    // 文件点开走的是**和对话里那些药丸同一个预览**——同一个工作区、同一份字节。
    out.push(
      `<li><div class="sw-ws-item"><button type="button" class="sw-ws-row sw-ws-file" data-act="chat-preview"
        data-path="${esc(e.path)}" data-name="${esc(e.name)}"
        style="padding-left: ${8 + depth * 12}px" title="${esc(e.path)}">
        <span class="sw-ws-caret">${ICON_FILE}</span>
        <span class="sw-ws-name">${esc(e.name)}</span>
        <small>${esc(fileSize(e.size))}</small>
      </button>${wsDelBtn(e)}</div></li>`,
    )
  }
  if (dir.loading && !out.length) out.push(`<li><p class="sw-ws-note" style="padding-left: ${8 + depth * 12}px">${t('载入中…')}</p></li>`)
  if (dir.error) out.push(`<li><p class="sw-ws-note sw-ws-err" style="padding-left: ${8 + depth * 12}px">${esc(dir.error)}</p></li>`)
  // 截断要说出来（见 workspace/index.ts 的 list）：少列几条不说，看的人只会以为
  // 那个文件根本不存在。
  if (dir.more > 0) {
    out.push(
      `<li><p class="sw-ws-note" style="padding-left: ${8 + depth * 12}px">${esc(
        t('还有 N 条没列出', 'N more not listed').replace('N', String(dir.more)),
      )}</p></li>`,
    )
  }
  return out.join('')
}
