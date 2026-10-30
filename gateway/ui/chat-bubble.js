/** 气泡里的东西怎么画：时间、产出与截图、文件药丸和链接、派出去的活、收到的派活、确认卡、转人工卡、行壳。原先在 chat.js 里，拆出来只是搬家（顺序见 index.html）。 */
/* ══ 对话渲染 ════════════════════════════════════════════════════════
   一轮回答期间 paintChat 每帧跑一次，所以这里只有一条规矩：**只动变了的那一块**。
   两层各管一段：

     消息层  syncThread —— 按 data-key 比对，新消息插进来，旧的连节点都不换
     正文层  syncMd     —— 把正文切成 Markdown 顶层块，只重画正在长的那一块

   两层都要。只做消息层的话，一条越写越长的回答每帧都要重排整段正文，连带把里面
   已经画好的 mermaid 图和公式重画一遍；只做正文层的话，每帧还是在重建整条消息流。
   分开之后稳定的部分节点身份不变，markdown.js 打在上面的 data-done 才作数。
   ══════════════════════════════════════════════════════════════════ */

/* 时间戳统一按 SATU_TZ 读（定义在 state.js，全站只此一份）。跟 fmtTime 保持一致——
   同一屏上两套时区最难查。 */
function chatClock(ms) {
  if (!ms) return ''
  return new Intl.DateTimeFormat('en-GB', { timeZone: SATU_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms))
}

/** YYYY-MM-DD，只用来比「是不是同一天」。 */
function chatDayKey(ms) {
  if (!ms) return ''
  return tzDayKey(ms)
}

function chatDayLabel(ms) {
  const key = chatDayKey(ms)
  if (!key) return ''
  const now = Date.now()
  if (key === chatDayKey(now)) return t('今天')
  if (key === chatDayKey(now - 86400000)) return t('昨天')
  return key
}

const ICON_CLIP =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>'
const ICON_X =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'

/* 发送 / 停止。同一个按钮的两副面孔，所以放在一起。 */
const ICON_SEND =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>'
const ICON_STOP =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>'

const ICON_BOT =
  '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>'
const ICON_TOOL =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>'
/** 发信那张卡的抬头。信封比盾牌说得更准：这一张问的是「这封信发不发」。 */
const ICON_MAIL =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>'

/** 交接卡的抬头。举手：这是**一个人被叫来了**，不是一道边界拦下了什么。 */
const ICON_HAND =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 11V6a1.5 1.5 0 0 0-3 0"/><path d="M15 10V4a1.5 1.5 0 0 0-3 0v6"/><path d="M12 10V5a1.5 1.5 0 0 0-3 0v7"/><path d="M9 12V8a1.5 1.5 0 0 0-3 0v6a7 7 0 0 0 7 7h1a7 7 0 0 0 7-7v-3"/></svg>'

/** 确认卡上那面盾。用盾不用感叹号：这是一道**边界**，不是一次故障。 */
const ICON_SHIELD =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6z"/><path d="M9 12l2 2 4-4"/></svg>'
const ICON_DOWN =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>'
const ICON_FILE =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h6"/></svg>'

/** 当前这条对话属于哪个 Bot。抬头和导出都要用。 */
function chatBotOf() {
  const id = chatBotIdOf(state.path) || state.chatBotId
  return (state.runtimeBots || []).find((b) => b.id === id) || null
}

/**
 * 一条工具痕迹。
 *
 * 只露名字和状态，**不展开结果**：工具结果动辄几千字（一次文件读、一次搜索），摊在
 * 对话里会把真正的回答挤到屏幕外。要看细节去右栏的运行环境。
 */
/**
 * 这条消息里 Bot 落地的文件，按路径去重。
 *
 * 同一个文件被 edit 三次只该出现一次——人关心的是「产出了什么」，不是「被碰了几下」。
 */
function outputFiles(tools) {
  const seen = new Map()
  for (const x of tools || []) {
    for (const f of x.files || []) {
      if (f && f.path && !seen.has(f.path)) seen.set(f.path, f)
    }
  }
  return [...seen.values()]
}

/**
 * 缩略图自动加载的上限。
 *
 * 缩略图取的是**原图**——没有服务端缩放（那要拉原生图像库，而部署包是预打的 arm64）。
 * 所以大图不自动拉，留占位，点开再说：一屏十张 8 MB 的图会把内存和带宽一起吃掉。
 */
const SHOT_AUTO_MAX = 2 * 1024 * 1024

/**
 * Bot **产出的图片**自动加载的上限，比上面那道宽。
 *
 * 那道 2 MB 是给过程截图和用户附图定的——一屏十几张，大图不值得自动拉。产出的图不一样：它就是
 * 这一轮的答案，一条消息最多摆 8 张（MAX_OUT_IMAGES），而生图模型出的 PNG 常常两三 MB 起
 * （Gemini 选不了格式，2K 的 PNG 四五 MB）。卡在 2 MB 的话，画出来的图多半只显示一个占位。
 */
const OUT_IMAGE_AUTO_MAX = 8 * 1024 * 1024

/** path → blob URL。同一张图在历史里可能出现多次，只取一次。 */
const SHOT_CACHE = new Map()
const SHOT_CACHE_MAX = 40

function shotCachePut(path, url) {
  SHOT_CACHE.set(path, url)
  while (SHOT_CACHE.size > SHOT_CACHE_MAX) {
    const oldest = SHOT_CACHE.keys().next().value
    const dead = SHOT_CACHE.get(oldest)
    SHOT_CACHE.delete(oldest)
    /**
     * **只吊销没人再看的那份。**
     *
     * 被挤出缓存不等于没人用：那张图多半还挂在上面某条消息的 <img> 上。吊销掉，
     * 那个节点下次重绘（往前翻一页历史、或者这一行的 data-sig 变了）就会拿着一个
     * 已经作废的 blob: 去取图，显示成永久破图——而缓存里已经没有它，fillShots 也
     * 只认带 data-shot 的占位元素，不会再去补。
     */
    if (dead && !shotInUse(dead)) setTimeout(() => URL.revokeObjectURL(dead), 0)
  }
}

/** 这个 blob URL 还挂在页面上吗。遍历而不是拼属性选择器——省掉一层转义的坑。 */
function shotInUse(url) {
  for (const img of document.querySelectorAll('.sw-shot img')) {
    if (img.src === url) return true
  }
  return false
}

/**
 * 把占位换成真图。失败就留占位——一张图没取到，不该让整条消息看起来出了错。
 * `max` 是自动加载的上限：过程截图和附图用 SHOT_AUTO_MAX，产出的图用 OUT_IMAGE_AUTO_MAX。
 */
async function fillShots(host, max = SHOT_AUTO_MAX) {
  if (!host || !state.chatSessionId) return
  const sessionId = state.chatSessionId
  for (const el of host.querySelectorAll('.sw-shot[data-shot]')) {
    const path = el.getAttribute('data-shot')
    // 取过就别再取：这个函数每帧都可能被调到。
    el.removeAttribute('data-shot')
    if (!path) continue
    const cached = SHOT_CACHE.get(path)
    if (cached) {
      el.innerHTML = '<img src="' + esc(cached) + '" alt="">'
      continue
    }
    try {
      const url = '/runtime/sessions/' + encodeURIComponent(sessionId) + '/files?path=' + encodeURIComponent(path)
      const res = await swFetch(url, { headers: authHeaders() })
      // 不读的响应体要显式收掉，否则连接和缓冲会一直挂着——一屏十张大图就是十条，
      // 正好是下面那道大小闸想省下的开销。
      if (!res.ok) {
        await res.body?.cancel().catch(() => {})
        continue
      }
      if (Number(res.headers.get('content-length') || 0) > max) {
        await res.body?.cancel().catch(() => {})
        continue
      }
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      shotCachePut(path, objectUrl)
      el.innerHTML = '<img src="' + esc(objectUrl) + '" alt="">'
    } catch {
      /* 留占位 */
    }
  }
}

/**
 * 用户发的一张图。
 *
 * 用 <img> 直接指预览接口是不行的——Gateway 认 Authorization 头，而 src= 带不了头。
 * 所以先画一个占位，等 loadShot 把 blob 取回来再填进去。
 */
function shotHtml(img) {
  return (
    `<button type="button" class="sw-shot" data-act="chat-preview" data-path="${esc(img.path)}" ` +
    `data-name="${esc(img.path.split('/').pop() || img.path)}" data-shot="${esc(img.path)}" ` +
    `title="${esc(img.path)}"><span class="sw-shot-ph">${ICON_FILE}</span></button>`
  )
}

/**
 * 一条消息底下最多摆几张过程截图。
 *
 * 一次多步浏览（navigate → click → snapshot → click…）在同一轮里轻松走十几步，全摆
 * 出来是四五行缩略图，把真正的回答挤出屏幕。前十二张已经足够看出「它是怎么走到这儿
 * 的」，而**一张都没丢**——全都在工作区 `browser/<会话>/` 里按时间排着。
 */
const MAX_STEP_SHOTS = 12

/** 一张像样的截图记录：至少有个路径。 */
function isShot(x) {
  return SatuCore.isShot(x)
}

/**
 * 这条消息里浏览器每走一步拍下的那张图，按步骤顺序、按路径去重。
 *
 * 和产出文件分开摆：那一排是「Bot 产出了什么」（它写的报告、下载的附件），这一条是
 * 「它路上看到了什么」。混在一起的话，一次浏览的十几张过程图会把真正的产出埋掉。
 */
function stepShots(tools) {
  const seen = new Map()
  for (const x of tools || []) {
    const shot = x && x.shot
    if (shot && shot.path && !seen.has(shot.path)) seen.set(shot.path, shot)
  }
  return [...seen.values()]
}

/**
 * Bot 产出的图片（generate_image 画的、脚本生成的图表……）直接摆缩略图，不只给一颗药丸。
 *
 * 图片就是拿来看的：一颗写着 `image-20260930-101500.jpg` 的药丸要点开才知道画成了什么，
 * 而人要的正是「画成了什么」。和上面的过程截图分开摆（那一条是「路上看到了什么」），
 * 摆不下的照旧落回药丸那一排，一张都不丢。
 *
 * 只认浏览器能内联渲染的位图，判据和工作区那张内联白名单一样按扩展名（SVG 故意不在：
 * 它能带脚本，预览接口本来就不给它内联）。
 */
const OUT_IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i
const MAX_OUT_IMAGES = 8

function outputImages(files) {
  return files.filter((f) => f && f.path && OUT_IMAGE_RE.test(f.path)).slice(0, MAX_OUT_IMAGES)
}

/** 没摆下的那些。**不闷声吞掉**——闷声截断会让人以为这次就走了这么几步。 */
function stepMoreHtml(n) {
  return `<span class="sw-chip sw-stepmore">${esc(t('还有 N 张，在工作区 browser/ 里', 'N more in browser/ in the workspace').replace('N', String(n)))}</span>`
}

/** 一个可点开的产出文件。这是「用户怎么发现 Bot 生成了东西」的那一环。 */
function fileChipHtml(f) {
  return (
    `<button type="button" class="sw-chip sw-filechip" data-act="chat-preview" ` +
    `data-path="${esc(f.path)}" data-name="${esc(f.name || f.path)}" title="${esc(f.path)}">` +
    `${ICON_FILE}<span>${esc(f.name || f.path)}</span></button>`
  )
}

/**
 * 一条工具痕迹。
 *
 * **不再挂 title**：原生 tooltip 要等一秒才出、只能显示一行纯文本，而且会和下面那个
 * 悬浮窗同时冒出来。详情改由 sw-toolpop 给——参数和结果都在里面，那两样才是「它刚才
 * 到底干了什么」的答案，尤其是失败的那几颗，以前只能去导出的记录里翻。
 *
 * 详情**不塞进 data-***：一次 bash 的参数加输出动辄几 KB，进属性要转义、要整份重复
 * 写进 DOM，而 chips 每次状态变化都重画一遍。改成 updateRow 把工具对象直接挂在节点上。
 */
function chipHtml(x, i) {
  const state_ = x.result == null ? 'running' : x.failed ? 'error' : 'done'
  const label = x.result == null ? t('调用中') : x.failed ? t('失败') : t('完成')
  return `<span class="sw-chip sw-toolchip" data-state="${state_}" data-i="${i}" tabindex="0">${ICON_TOOL}<span>${esc(x.name)} · ${esc(label)}</span></span>`
}

/**
 * 工具折叠框摊开时最多几行，多了就在框里滚（高度见 chat.css 的 .sw-toolfold-list）。
 * 改这个数要连那边的 max-height 一起改——两边写的是同一件事。
 */
const TOOLFOLD_ROWS = 5

/**
 * 一次调用在标题里怎么称呼：工具名，带命令的（terminal 这种）再接上那条命令。
 *
 * 「正在执行什么」里人要的是**那条命令**，不是 `terminal` 这个名字——一轮里十几次都叫
 * terminal，只看名字分不出是在装依赖还是在删文件。args 是模型给的 JSON 串，解不开就
 * 只报名字，不猜。
 */
function toolCommandOf(x) {
  let cmd = ''
  try {
    const o = typeof x.args === 'string' ? JSON.parse(x.args) : x.args
    if (o && typeof o === 'object') cmd = String(o.command || o.cmd || '').trim()
  } catch {}
  cmd = cmd.replace(/\s+/g, ' ')
  if (cmd.length > 80) cmd = cmd.slice(0, 80) + '…'
  return cmd ? `${x.name} · ${cmd}` : String(x.name || '')
}

/**
 * 工具痕迹收进一个折叠框：**默认收着，标题上说正在执行什么。**
 *
 * 一轮十几次调用摊成一排药丸，会把正文下面那几颗真正要点的东西（产出的文件、读过的
 * 文件）挤到好几行之后；可「它现在在干什么」又是人盯着看的那一句，不能跟着一起藏。
 * 所以标题就是那一句：有还在跑的就写「正在执行 <最后一个在跑的>」，都跑完了写一共
 * 几次、失败几次、最后一次是什么。展开之后是原来那些药丸，一行一颗，悬浮详情照旧；
 * 超过 TOOLFOLD_ROWS 行在框里滚，不把气泡撑长。
 *
 * 已有结论的确认药丸也收在里面：它们和工具痕迹是同一类东西（这一轮路上发生过什么），
 * 还等着人点的那几张确认卡不进来，照旧摊在下面。
 */
function toolFoldHtml(tools, settled) {
  const running = [...tools].reverse().find((x) => x.result == null)
  const failed = tools.filter((x) => x.result != null && x.failed).length
  const n = tools.length + settled.length
  let state_ = 'done'
  let title
  if (running) {
    state_ = 'running'
    title = t('正在执行', 'Running') + ' ' + toolCommandOf(running)
  } else {
    if (failed) state_ = 'error'
    const last = tools[tools.length - 1]
    title = t(`${tools.length} 次工具调用`, `${tools.length} tool calls`)
    if (failed) title += ' · ' + t(`${failed} 次失败`, `${failed} failed`)
    if (last) title += ' · ' + t('最后一次', 'last') + ' ' + toolCommandOf(last)
    if (!tools.length) title = t(`${settled.length} 次确认`, `${settled.length} approvals`)
  }
  return (
    `<details class="sw-toolfold" data-state="${state_}">` +
    `<summary class="sw-toolfold-head" title="${esc(title)}">${ICON_TOOL}<span class="sw-toolfold-title">${esc(title)}</span>` +
    `<span class="sw-toolfold-n">${n}</span></summary>` +
    `<div class="sw-toolfold-list" data-rows="${TOOLFOLD_ROWS}">` +
    tools.map(chipHtml).join('') +
    settled.map((a, i) => approvalChipHtml(a, tools.length + i)).join('') +
    `</div></details>`
  )
}

/**
 * 正文里被**行内代码**点了名的产出文件。
 *
 * 判据是 markdown 源码里出现 `` `路径` ``，而不是去渲染后的 DOM 里找。两个理由：
 * 一是它要参与 chips 那条的 sig（决定底下还摆哪几颗），必须在渲染之前就算得出来；
 * 二是源码里的反引号是模型明确写下的「这是个路径」，比事后按文本匹配可靠。
 *
 * **不做模糊匹配**：只认整段相等的完整路径。截一半的、拼在句子里的一律不动——
 * 那正是「拿正则扫散文猜路径」的老毛病，措辞一改就散架。
 */
function mentionedFiles(text, files) {
  const src = String(text == null ? '' : text)
  const set = new Set()
  for (const f of files || []) if (f && f.path && src.includes('`' + f.path + '`')) set.add(f.path)
  return set
}

/**
 * 把正文里那几段路径原地换成可以点开的药丸。
 *
 * 模型写出来的是 `uploads/s-0189cf21-787b-4c33-a4d4-c3daf292da34/Receipt-2095.md`
 * 这样一长串——占掉整行、看不出重点，而且不能点。换成药丸之后，「它生成了什么」
 * 就在说这句话的地方，不用再往下找。
 *
 * **跳过代码块里的**：那里面的路径是给人抄去执行的命令的一部分，换成按钮就抄不走了。
 */
function inlineFileChips(host, files) {
  const byPath = new Map((files || []).filter((f) => f && f.path).map((f) => [f.path, f]))
  if (!byPath.size) return
  for (const code of [...host.querySelectorAll('code')]) {
    if (code.closest('pre')) continue
    const hit = byPath.get(code.textContent.trim())
    if (!hit) continue
    const box = document.createElement('span')
    box.innerHTML = fileChipHtml(hit)
    const chip = box.firstElementChild
    if (!chip) continue
    chip.classList.add('sw-filechip-inline')
    code.replaceWith(chip)
  }
}

/**
 * 当前这条会话的「要在正文里找的文件名」表。每次重绘由 paintChat 重算一次。
 *
 * 挂在模块上而不是一路当参数传：updateRow 是从 syncThread 里逐条调的，为这一样东西
 * 给沿途每个函数加一个形参，只会让下一个人以为它是每条消息各自不同的东西——它不是，
 * 整条会话共用一份。
 */
let chatFileCands = []

/**
 * 代码高亮会把代码块的 innerHTML 整块换掉（见 markdown.js 的 enhanceCode），
 * 里面的文件链接自然一起没了。高亮完再接一次——这是目录树那一屏能点得动的关键：
 * 那一片正好在代码块里。
 *
 * **只管对话里的。** enhance 在预览层也会跑（见 openPreview / setPreviewMode），
 * 而那儿画的是文件自己的内容：往里塞按钮等于改了人正在看的那份文件，点一下还会把
 * 当前预览换成另一个文件。
 */
if (window.satuMd && satuMd.onCodeReady) {
  satuMd.onCodeReady((el) => {
    if (el && el.closest && el.closest('#chat-thread')) linkFiles(el, chatFileCands)
  })
}

/* ══ 转接到 core.js：正文里的文件名怎么接回工作区里的文件，实现在 core/src/chat/files.ts ══
   名册按整条会话攒（knownFiles），摊成「要找的字串」（fileCands），再在一段文本里认出区间
   （fileHits / fileEdgeOk）。函数声明的理由见上面 messageText 那一组。 */
function knownFiles(blocks) {
  return SatuCore.knownFiles(blocks)
}

function fileCands(known) {
  return SatuCore.fileCands(known)
}

function fileHits(text, cands) {
  return SatuCore.fileHits(text, cands)
}

function fileEdgeOk(src, start, end) {
  return SatuCore.fileEdgeOk(src, start, end)
}

/** 走文本节点时不进去的那些。链接和药丸里面已经是可点的了，再套一层只会打架。 */
const FILE_LINK_SKIP = new Set(['A', 'BUTTON', 'FIGCAPTION', 'SCRIPT', 'STYLE', 'TEXTAREA'])

/**
 * 把正文（含代码块）里出现的文件名原地变成可以点开预览的链接。
 *
 * **和行内药丸的分工**：`` `路径` `` 那种是模型明确写下的一整条路径，换成药丸；
 * 剩下的——目录树那一屏、句子里带出来的一个文件名——只加链接，**不换节点**。
 * 代码块尤其不能换：那一片要能整段抄走，塞个按钮进去就抄不成了。加链接不影响
 * `textContent`，上面那颗「复制」照样复制出原样的文本。
 */
function linkFiles(host, cands) {
  if (!host || !cands || !cands.length) return
  const walk = (node) => {
    for (const kid of [...node.childNodes]) {
      if (kid.nodeType === 3) {
        paintFileLinks(kid, cands)
      } else if (kid.nodeType === 1 && !FILE_LINK_SKIP.has(kid.tagName)) {
        walk(kid)
      }
    }
  }
  walk(host)
}

/** 一个文本节点，切成「原文 + 链接 + 原文」。没命中就一个字都不动。 */
function paintFileLinks(node, cands) {
  const src = node.data || ''
  // 一屏正文里绝大多数文本节点一个文件名都没有，先拿最便宜的那一刀挡掉。
  if (src.length < 3) return
  const hits = fileHits(src, cands)
  if (!hits.length) return
  const frag = document.createDocumentFragment()
  let at = 0
  for (const h of hits) {
    if (h.start > at) frag.appendChild(document.createTextNode(src.slice(at, h.start)))
    frag.appendChild(fileLinkNode(src.slice(h.start, h.end), h.file))
    at = h.end
  }
  if (at < src.length) frag.appendChild(document.createTextNode(src.slice(at)))
  node.parentNode.replaceChild(frag, node)
}

/** 一个文件链接。字面照抄原文——目录树那一屏的对齐全靠它一个字符都不多不少。 */
function fileLinkNode(label, file) {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'sw-filelink'
  el.setAttribute('data-act', 'chat-preview')
  el.setAttribute('data-path', file.path)
  el.setAttribute('data-name', file.name)
  el.title = file.path
  el.textContent = label
  return el
}

/**
 * 这条消息里 Bot 读过的文件。
 *
 * 单独挑出来是因为**读完之后的那句话常常一个文件名都不带**：「已读取《某某报告》，
 * 内容概要如下」——用的是文档标题。正文里接不上，就只能在底下给一颗药丸，否则那份
 * 报告在界面上根本没有入口。`ls`/`grep` 看到的那些不给药丸：一次能列出几十个，
 * 摆出来就是一堵墙，它们在正文里已经是链接了。
 */
function readFiles(tools) {
  const seen = new Map()
  for (const x of tools || []) {
    if (x.name !== 'read') continue
    for (const f of x.refs || []) if (f && f.path && !seen.has(f.path)) seen.set(f.path, f)
  }
  return [...seen.values()]
}

/** 读过的文件最多摆几颗。再多就把这条回答本身挤下去了。 */
const MAX_READ_CHIPS = 6

/** 读过的那种药丸。比产出淡一档——它不是这一轮的成果，只是「它看过这个」。 */
function readChipHtml(f) {
  return (
    `<button type="button" class="sw-chip sw-filechip sw-refchip" data-act="chat-preview" ` +
    `data-path="${esc(f.path)}" data-name="${esc(f.name || f.path)}" title="${esc(f.path)}">` +
    `${ICON_FILE}<span>${esc(f.name || f.path)}</span></button>`
  )
}

/** 没摆下的那几个。和过程截图一样：**不闷声吞掉**。 */
function readMoreHtml(n) {
  return `<span class="sw-chip sw-stepmore">${esc(t('还有 N 个读过的文件', 'N more files read').replace('N', String(n)))}</span>`
}

/**
 * 一条消息底下最多摆几颗**产出**药丸。
 *
 * 比读过的那一档宽一点：产出是这一轮的成果，人来就是找它的。但也得有个数——一条命令
 * 生成二十份分章报告，二十颗药丸能占掉三行，把回答本身挤出屏幕。
 */
const MAX_OUT_CHIPS = 8

/** 没摆下的产出。**不闷声吞掉**——摆八颗然后什么也不说，人会以为一共就这八个。 */
function outMoreHtml(n) {
  return `<span class="sw-chip sw-stepmore">${esc(t('还有 N 个产出文件，在右栏「工作区文件」里', 'N more files produced — see Workspace files in the side pane').replace('N', String(n)))}</span>`
}

/**
 * 一条消息渲染完之后，把里面的文件接上。
 *
 * 两件事一起做，按 Markdown 块逐块来并留个记号：`syncMd` 只重画签名变了的那一块，
 * 所以已经接过的块不必再走一遍——流式那几十帧里，这是整段正文里最费的一段。
 *
 * 记号带上「名册有多大」：工具是边跑边报文件的，先写下的那句话可能在后一颗工具
 * 结果回来之后才认得出文件名。名册一变，记号就对不上，那一块自然会再接一次。
 */
function decorateFiles(md, outs) {
  const cands = chatFileCands
  const stamp = cands.length + '·' + outs.length
  for (const block of md.querySelectorAll('.sw-mdblock')) {
    if (block.getAttribute('data-fl') === stamp) continue
    block.setAttribute('data-fl', stamp)
    inlineFileChips(block, outs)
    linkFiles(block, cands)
  }
}

/**
 * 正文里的 `@名字` 就地换成点名药丸（「打开 @Gmail 邮件，让 @客户经理 处理」）。
 *
 * 只换这条消息真点了名的那几个——人随手打的 `@某某` 不是点名，不该长成药丸。名字长的
 * 先认，理由同席位的 interleaveMentions。代码块里的不碰。按 Markdown 块留记号，和
 * decorateFiles 一个做法：syncMd 只重画变了的块，已经换过的不再走一遍。
 */
function inlineMentionPills(md, mentions) {
  if (!mentions.length) return
  const byLabel = [...mentions].sort((a, b) => b.label.length - a.label.length)
  /**
   * 记号里要带上「候选和名单到了没有」。图标和头像是按 id 回这两份里查的，而打开对话时消息先按
   * 历史画出来、候选是异步拉的——只按 id 记的话，先画成「@」的那几颗药丸，候选到了也不会再换。
   */
  const stamp = byLabel.map((m) => m.id).join('|') + '#' + (state.mentionOptions ? state.mentionOptions.length : -1) + '#' + (state.runtimeBots || []).length
  for (const block of md.querySelectorAll('.sw-mdblock')) {
    if (block.getAttribute('data-mn') === stamp) continue
    block.setAttribute('data-mn', stamp)
    // 已经画好的药丸就地换一遍：候选刚到，图标 / 头像这下查得到了。
    for (const old of block.querySelectorAll('.sw-mention-inline[data-mid]')) {
      const m = byLabel.find((x) => x.id === old.getAttribute('data-mid'))
      if (!m) continue
      const box = document.createElement('span')
      box.innerHTML = mentionPill(m) + '</span>'
      const fresh = box.firstElementChild
      if (!fresh) continue
      fresh.classList.add('sw-mention-inline')
      fresh.setAttribute('data-mid', m.id)
      old.replaceWith(fresh)
    }
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
    const nodes = []
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.parentElement && n.parentElement.closest('code, pre, .sw-mention')) continue
      if (n.nodeValue.includes('@')) nodes.push(n)
    }
    for (const node of nodes) {
      let rest = node
      for (;;) {
        const v = rest.nodeValue
        let best = null
        for (const m of byLabel) {
          const at = v.indexOf('@' + m.label)
          if (at >= 0 && (!best || at < best.at)) best = { at, m }
        }
        if (!best) break
        const tail = rest.splitText(best.at)
        const after = tail.splitText(best.m.label.length + 1)
        const box = document.createElement('span')
        box.innerHTML = mentionPill(best.m) + '</span>'
        const pill = box.firstElementChild
        if (!pill) break
        pill.classList.add('sw-mention-inline')
        pill.setAttribute('data-mid', best.m.id)
        tail.replaceWith(pill)
        rest = after
      }
    }
  }
}

/**
 * 回复里能认成点名药丸的 `@名字`：名单上的 Bot（用头像）加上能点名的连接器（用图标）。
 * 主 Bot 说「派出去了 —— @客户经理」，那个 `@客户经理` 和人打的点名长得一样。
 */
function mentionCands() {
  const bots = (state.runtimeBots || []).filter((b) => String(b.name || '').length >= 2).map((b) => ({ kind: 'bot', id: b.id, label: b.name, icon: b.icon, origin: b.origin }))
  const conns = (state.mentionOptions || []).filter((m) => m.kind === 'connector')
  return bots.concat(conns)
}

/* ── 派出去的活：委派（agent/task）和派活（bot/assign）共用一套画法 ──────────────
   两种活跑在不同的地方（子代理在本席位的子会话里，派活在另一颗 Bot 自己的会话里），人要问的却是
   同一组问题：它在干什么、做到哪了、卡在哪、交回了什么。所以每一件先收成同一个形状
   （delegateView / assignView），再用同一个 taskItemHtml 画：

     第一行  状态点 · 任务一句话 · 状态 · 读秒 / 步数 / 花费
     第二行  跑着：正在调什么 + 清单进度；等着：等谁。收场了（做成、没做成、停了）就没有这一行，一件一行
     点开    失败原因、结论全文、产出文件、过程（一步一行，调用和结果按 callId 配对，见 core/src/chat/task.ts）

   位置也一样：都挂在主 Bot 派活那一轮的气泡里，一批一张卡（taskGroupHtml）。派活那一行前面多一个
   对方的头像和名字——对方那一轮就是主 Bot 这一轮里的一段执行，和子代理是同一回事。 */

const TASK_STATE_TEXT = {
  waiting: ['等前置', 'waiting'],
  running: ['进行中', 'running'],
  done: ['完成', 'done'],
  capped: ['到步数上限', 'step cap'],
  timeout: ['超时', 'timed out'],
  failed: ['失败', 'failed'],
  aborted: ['已停止', 'stopped'],
  cancelled: ['已停止', 'stopped'],
  skipped: ['跳过', 'skipped'],
  detached: ['转到后台', 'detached'],
  lost: ['状态未知', 'unknown'],
}

/** 颜色只分几种：跑着、等着、做成、要留意（撞顶 / 超时 / 转后台 / 不知死活）、没做成；停止和跳过是灰的。 */
const TASK_TONE = { waiting: 'wait', running: 'run', done: 'ok', capped: 'warn', timeout: 'warn', detached: 'warn', lost: 'warn', failed: 'bad', aborted: 'off', cancelled: 'off', skipped: 'off' }

const taskLive = (s) => !s || s === 'running' || s === 'waiting'

/** 「看过程」去哪取：key → { child } 或 { session, taskId }。画卡片时登记，点按钮时按 key 查。 */
const taskTraceSrc = {}

/** 派活的过程在对方会话里往前最多翻几页（每页 50 轮）找它那条指令。 */
const TRACE_PAGES = 6

/** 跑着的时候，摊开的过程隔多久重取一次。重取挂在重画上（进度一变就重画），不另起定时器。 */
const TRACE_REFRESH_MS = 3000

function humanMs(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

function taskBotOf(b) {
  return (state.runtimeBots || []).find((x) => x.id === (b.bot && b.bot.id))
}

/** 前置任务的名字：「等 @客户经理 做完」。after 里写的是 tasks 的 id，回同一批里找它派给了谁。 */
function taskWaitText(b) {
  const peers = (state.chatEvents || []).filter((e) => e.type === 'bot/assign' && e.data && e.data.callId === b.callId).map((e) => e.data)
  const names = [...new Set((b.after || []).map((k) => peers.find((p) => String(p.id).endsWith(':' + k))?.bot?.name).filter(Boolean))]
  return names.length ? t(`等 ${names.map((n) => '@' + n).join('、')} 做完`, `Waiting for ${names.map((n) => '@' + n).join(', ')}`) : t('等前面那件做完', 'Waiting for the previous task')
}

/** 一件委派（agent/task 的最后一条）收成统一的形状。 */
function delegateView(task) {
  const m = task.model || {}
  // 登记时就记下是哪条会话的：跑着时那次延后重取落在人切走之后，现读 state.chatSessionId 会打到别的会话。
  const trace = task.child ? { key: 'c:' + task.child, child: task.child, session: state.chatSessionId } : null
  if (trace) taskTraceSrc[trace.key] = trace
  return {
    id: task.id,
    kind: 'delegate',
    state: task.state || 'running',
    title: task.goal || '',
    since: task.startedAt || 0,
    until: taskLive(task.state) ? 0 : task.at || 0,
    steps: task.steps || (task.progress && task.progress.steps) || 0,
    cost: task.usage && task.usage.cost ? Number(task.usage.cost) : 0,
    tier: m.role ? m : null,
    progress: task.progress || null,
    body: task.summary || '',
    reason: task.error || '',
    files: task.files || [],
    trace,
  }
}

/**
 * 一件派活（bot/assign 的最后一条）收成统一的形状。
 *
 * `result` 一字两用（bot/src/tools/assign.ts）：做完了是对方交回的结论，别的态是原因。这里拆开：
 * 结论进 body，原因进 reason——卡片上「没做成」那一行要的是原因，不是一段像结论的话。
 */
function assignView(b) {
  const text = taskLive(b.state) ? '' : String(b.result || '')
  const trace = b.taskId && b.runSessionId ? { key: 'a:' + b.taskId, session: b.runSessionId, taskId: b.taskId } : null
  if (trace) taskTraceSrc[trace.key] = trace
  return {
    id: b.id,
    kind: 'assign',
    state: b.state || 'waiting',
    title: String(b.instruction || '').replace(/\s+/g, ' '),
    since: b.startedAt || 0,
    until: b.endedAt || 0,
    steps: (b.progress && b.progress.steps) || 0,
    cost: 0,
    tier: null,
    progress: b.progress || null,
    body: b.state === 'done' ? text : '',
    reason: b.state === 'done' ? '' : text,
    files: [],
    waitText: b.state === 'waiting' ? taskWaitText(b) : '',
    who: taskWho(b),
    trace,
  }
}

/** 派给了谁：头像加名字，摆在那一行任务前面。名单上找不到（Bot 删了）就只留派活时记下的名字。 */
function taskWho(b) {
  const bot = taskBotOf(b)
  const name = (bot && bot.name) || (b.bot && b.bot.name) || ''
  return { name, avatar: bot ? botAvatar(bot.icon, 18, bot.origin) : ICON_BOT }
}

/** 重画用的签名：状态、进度、开合、过程取到哪了，任何一样变了才重画。 */
function taskSig(v) {
  const key = v.trace && v.trace.key
  const tr = key ? state.taskTrace?.[key] : null
  const steps = key ? Object.keys(state.traceOpen || {}).filter((k) => k.startsWith(key + '|')).join(',') : ''
  return [
    v.id,
    v.state,
    v.steps,
    JSON.stringify(v.progress || ''),
    v.body.length,
    v.reason.length,
    state.taskOpen?.[v.id] ? 1 : 0,
    !tr ? '-' : (tr.loading ? 'l' : '') + (tr.error ? 'e' : '') + (tr.at || 0),
    steps,
  ].join(':')
}

/** 第一行右侧那几个小字：读秒（跑着时由 tickTaskElapsed 每秒刷）、步数、花费。 */
function taskMetaHtml(v) {
  const parts = []
  if (v.since && taskLive(v.state) && v.state !== 'waiting') parts.push(`<span class="sw-taskelapsed" data-since="${esc(String(v.since))}"></span>`)
  else if (v.since && v.until) parts.push(esc(humanMs(v.until - v.since)))
  if (v.steps) parts.push(esc(t(`${v.steps} 步`, `${v.steps} steps`)))
  if (v.cost) parts.push(esc('$' + v.cost.toFixed(4)))
  return parts.length ? `<span class="sw-task-meta">${parts.join(' · ')}</span>` : ''
}

/** 结论的第一句。标题行（「## 结论」）跳过、Markdown 的标记去掉，只要那句话。 */
function firstLine(text) {
  const lines = String(text || '').split('\n')
  const clean = (l) => l.replace(/^[\s#>*\-+|]+/, '').replace(/[*_`]/g, '').trim()
  return clean(lines.find((l) => clean(l) && !/^\s*#/.test(l)) || lines.find((l) => clean(l)) || '')
}

/**
 * 第二行，只有跑着、等着的才有：说「正在干什么」——不用点开就知道它做到哪了。
 *
 * 没有进度（老席位、老管家不报；刚开跑还没调过工具）就只说「正在做」，不编一个数出来。
 */
function taskSubHtml(v) {
  if (v.state === 'waiting') return `<span class="sw-taskwait" aria-hidden="true"></span><span class="sw-ti-now">${esc(v.waitText || t('等前置', 'Waiting'))}</span>`
  const p = v.progress || {}
  const now = p.tool
    ? `<span class="sw-ti-now"><span class="sw-ti-label">${esc(t('正在执行', 'Running'))}</span><b>${esc(p.tool.name)}</b>` +
      (p.tool.detail ? `<span class="sw-ti-command" title="${esc(p.tool.detail)}">${esc(p.tool.detail)}</span>` : '') + '</span>'
    : `<span class="sw-ti-now"><span class="sw-ti-label">${esc(t('正在处理任务', 'Working on the task'))}</span></span>`
  const todo = p.todo
    ? `<span class="sw-ti-todo" title="${esc(p.todo.now || '')}">${esc(`${p.todo.done}/${p.todo.total}`)}${p.todo.now ? ' · ' + esc(p.todo.now) : ''}</span>`
    : ''
  return `<span class="sw-taskspin" aria-hidden="true"></span>${now}${todo}`
}

/** 一件活，委派和派活都用它（见本段开头）。 */
function taskItemHtml(v) {
  const st = TASK_STATE_TEXT[v.state] || TASK_STATE_TEXT.running
  const tone = TASK_TONE[v.state] || 'run'
  const open = Boolean(state.taskOpen?.[v.id])
  /**
   * 收场了就折成一行：一批派出去七八件，每件再挂一行结论摘要，卡片比对话还长。
   * 结论、原因、档位都在点开之后（taskDetailHtml）。
   */
  const live = taskLive(v.state)
  /**
   * 档位后面跟着那句理由。**这是档位可不可审的全部**：光一个 utility，人判不出选得对
   * 不对，只能等它跑砸；配上「格式定死、漏一行一眼能看见」，当场就判得出来。
   *
   * 降过级的要标出来（写了 utility 却没给理由，或者平台没钉 utility）——不标的话，人会
   * 以为那一档是主代理自己选的。
   */
  const m = v.tier
  const tier = m && (live || open)
    ? `<div class="sw-task-tier-row"><span class="sw-task-tier" data-role="${esc(m.role)}">${esc(m.role)}</span>` +
      (m.downgraded ? `<span class="sw-task-down">${esc(t('已降档', 'downgraded'))}</span>` : '') +
      (m.reason ? `<span class="sw-task-why">${esc(m.reason)}</span>` : '') +
      '</div>'
    : ''
  return (
    `<div class="sw-ti" data-state="${esc(v.state)}" data-tone="${esc(tone)}"${open ? ' data-open="1"' : ''}>` +
    `<button type="button" class="sw-task-line${v.who && live ? ' sw-task-line-assigned' : ''}" data-act="chat-task-toggle" data-id="${esc(v.id)}" aria-expanded="${open ? 'true' : 'false'}">` +
    `<span class="sw-task-dot" data-tone="${esc(tone)}" aria-hidden="true"></span>` +
    (v.who ? `<span class="sw-task-who" title="${esc(v.who.name)}"><span class="sw-task-who-av" aria-hidden="true">${v.who.avatar}</span><span class="sw-task-who-name">${esc(v.who.name)}</span></span>` : '') +
    `<span class="sw-task-goal" title="${esc(v.title)}">${esc(v.title)}</span>` +
    `<span class="sw-task-state">${esc(t(st[0], st[1]))}</span>` +
    taskMetaHtml(v) +
    `<span class="sw-ti-chev" aria-hidden="true"></span>` +
    '</button>' +
    (live ? `<div class="sw-ti-sub">${taskSubHtml(v)}</div>` : '') +
    tier +
    (open ? taskDetailHtml(v, tone) : '') +
    '</div>'
  )
}

function taskDetailHtml(v, tone) {
  const why = v.reason
    ? `<div class="sw-ti-reason" data-tone="${esc(tone)}"><b>${esc(tone === 'bad' ? t('失败原因', 'Why it failed') : t('说明', 'Note'))}</b><span>${esc(v.reason)}</span></div>`
    : ''
  const body = v.body
    ? // 包一层 .sw-mdblock：inlineMentionPills 只认这一层（syncMd 画的正文都有），不包的话结论里的 @某某 永远不会变成药丸。
      `<div class="sw-task-summary sw-md"><div class="sw-mdblock">${window.satuMd ? window.satuMd.render(v.body) : esc(v.body)}</div></div>`
    : taskLive(v.state)
      ? ''
      : v.reason
        ? ''
        : `<p class="sw-task-empty">${esc(t('还没有结论', 'No conclusion yet'))}</p>`
  const files = (v.files || []).length ? `<div class="sw-task-files">${v.files.map(fileChipHtml).join('')}</div>` : ''
  return `<div class="sw-task-detail">${why}${body}${files}${taskTraceHtml(v, tone)}</div>`
}

/**
 * 「看过程」。委派取的是子会话全文（**经主会话授权**：子会话不进控制面的会话索引，按 id 直取
 * 会换回一个 503，见 gateway 那条 tasks 路由）；派活取的是对方那条会话里这件活的那一段
 * （core 的 assignSlice：从带着任务 id 的那条指令起，到它那一轮收口）。
 *
 * 跑着的时候过程会接着长：摊开着、又过了 TRACE_REFRESH_MS，就在这次重画之后再取一次。
 */
function taskTraceHtml(v, tone) {
  if (!v.trace) return ''
  const key = v.trace.key
  const tr = state.taskTrace?.[key]
  const btn = (label) =>
    `<button type="button" class="satu-linkbtn sw-task-trace-btn" data-act="chat-task-trace" data-key="${esc(key)}">${esc(label)}</button>`
  if (!tr) return btn(t('看过程', 'View the run'))
  if (!tr.rows) {
    if (tr.loading) return `<p class="sw-task-empty">${esc(t('正在取…', 'Loading…'))}</p>`
    /**
     * 取失败要**留一条退路**。席位重启那几秒里点一下就会走到这儿，而按钮已经被这行字换掉
     * ——不把它摆回来的话，除了刷新整页没有第二条路。
     */
    return `<p class="sw-task-empty sw-task-err">${esc(tr.error || '')}</p>` + btn(t('重试', 'Retry'))
  }
  const live = taskLive(v.state)
  if (live && !tr.loading && Date.now() - (tr.at || 0) > TRACE_REFRESH_MS) setTimeout(() => loadTaskTrace(key, true), 0)
  const rows = tr.rows.map((r) => traceRowHtml(r, key))
  if (!live) {
    const st = TASK_STATE_TEXT[v.state] || TASK_STATE_TEXT.running
    const bits = [t(st[0], st[1]), v.steps ? t(`${v.steps} 步`, `${v.steps} steps`) : '', v.since && v.until ? humanMs(v.until - v.since) : '']
    if (v.reason && tone === 'bad') bits.push(firstLine(v.reason))
    rows.push(`<div class="sw-tr-end" data-tone="${esc(tone)}">${esc(bits.filter(Boolean).join(' · '))}</div>`)
  }
  if (!tr.rows.length && live) rows.unshift(`<p class="sw-task-empty">${esc(t('还没有动作', 'Nothing yet'))}</p>`)
  return `<div class="sw-task-trace" data-key="${esc(key)}"${live ? ' data-follow="1"' : ''}>${rows.join('')}</div>`
}

const TRACE_BADGE = { running: ['进行中', 'running'], blocked: ['被拦', 'blocked'], error: ['出错', 'error'] }

/**
 * 过程里的一行。它说的话一行；一次调用一行——工具名、关键参数、结果第一句，被拦 / 出错标出来。
 * 结果原文点开那一行才摊开（截到 4000 字）：工具结果动辄几万字，默认全摊开就没法往下看了。
 */
function traceRowHtml(r, key) {
  if (r.kind === 'say') return `<div class="sw-tr-say">${esc(r.text)}</div>`
  const okey = key + '|' + r.callId
  const open = Boolean(state.traceOpen?.[okey])
  const badge = TRACE_BADGE[r.status]
  return (
    `<div class="sw-tr-step" data-status="${esc(r.status)}">` +
    `<button type="button" class="sw-tr-head" data-act="chat-trace-step" data-key="${esc(okey)}"${r.full ? '' : ' disabled'}>` +
    `<span class="sw-tr-ico" aria-hidden="true"></span><b>${esc(r.name)}</b>` +
    (r.detail ? `<span class="sw-tr-arg">${esc(r.detail)}</span>` : '') +
    (badge ? `<span class="sw-tr-badge">${esc(t(badge[0], badge[1]))}</span>` : '') +
    '</button>' +
    (r.out ? `<div class="sw-tr-out">${esc(r.out)}</div>` : '') +
    (open && r.full ? `<pre class="sw-tr-full">${esc(r.full.length > 4000 ? r.full.slice(0, 4000) + '\n…' : r.full)}</pre>` : '') +
    '</div>'
  )
}

/**
 * 把一块派出去的活重新画进 host。过程框各自有滚动条：重画前记下滚到哪，画完摆回去；
 * 还在跑的那一框跟着最底下走（新的一步长在最后）。
 */
function paintTaskHtml(host, html) {
  const keep = {}
  for (const el of host.querySelectorAll('.sw-task-trace[data-key]')) {
    keep[el.getAttribute('data-key')] = { top: el.scrollTop, bottom: el.scrollHeight - el.scrollTop - el.clientHeight < 8 }
  }
  host.innerHTML = html
  for (const el of host.querySelectorAll('.sw-task-trace[data-key]')) {
    const k = keep[el.getAttribute('data-key')]
    if (el.hasAttribute('data-follow') && (!k || k.bottom)) el.scrollTop = el.scrollHeight
    else if (k) el.scrollTop = k.top
  }
  tickTaskElapsed()
}

/**
 * 在对话里原地开合一块（派出去的活、过程里的一步、派来的那一轮）。
 *
 * **不走 render()。** 整页重绘会把 #chat-thread 整个换掉，新的那个没被滚过、scrollTop 是 0，
 * paintChat 按「从没滚过」一律贴底——人点开中间一张卡，视线被甩到页底。这里只增量重画
 * 对话，再把点的那颗按钮摆回它原来在屏幕上的高度：往下摊开的东西长在它下面，它自己不动。
 */
function paintChatInPlace(btn, attr) {
  const thread = document.getElementById('chat-thread')
  if (!thread || !thread.contains(btn)) return render()
  const sel = `[data-act="${CSS.escape(btn.getAttribute('data-act') || '')}"][${attr}="${CSS.escape(btn.getAttribute(attr) || '')}"]`
  const top = btn.getBoundingClientRect().top
  // 人在这一屏里点了东西，就当摸过滚动条：不然 paintChat 照「从没滚过」贴底。
  thread.setAttribute('data-touched', '1')
  watchChatScroll(thread).following = false
  paintChat()
  const again = thread.querySelector(sel)
  if (again) thread.scrollTop += again.getBoundingClientRect().top - top
}

/**
 * 取一次过程，存进 state 之后由 paintChat 画（理由同 paintChatInPlace：render 会把人甩到页底，
 * 跑着时每 TRACE_REFRESH_MS 重取一次，就是每几秒甩一次）。`again` = 跑着时的重取：取到之前旧的那份照画，
 * 失败了也留着旧的——一跳没取到，不该让已经摊开的过程消失。
 */
async function loadTaskTrace(key, again) {
  const src = taskTraceSrc[key]
  if (!src) return
  state.taskTrace = state.taskTrace || {}
  const had = state.taskTrace[key]
  if (had && had.loading) return
  if (had && had.rows && !again) return
  state.taskTrace[key] = { ...(had || {}), loading: true }
  if (!had || !had.rows) paintChat()
  try {
    let events
    if (src.child) {
      const sessionId = src.session || state.chatSessionId
      if (!sessionId) throw new Error(t('这条对话还没打开', 'This conversation is not open'))
      const data = await api(
        'GET',
        `/runtime/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(src.child)}/history?turns=50`,
      )
      events = data.events || []
    } else {
      /**
       * 对方那边之后又聊了很多轮，那件活就不在最近一页里了：往前翻着找，找到它那条指令为止（最多几页）。
       * 只取最近二十轮的话，收场的卡上过程只剩一行结尾，看着像什么都没做。
       */
      let all = []
      let before = 0
      events = []
      for (let page = 0; page < TRACE_PAGES; page++) {
        const data = await api('GET', `/runtime/sessions/${encodeURIComponent(src.session)}/history?turns=50${before ? `&before=${before}` : ''}`)
        all = [...(data.events || []), ...all]
        events = SatuCore.assignSlice(all, src.taskId)
        if (events.length || !data.hasMore || !data.firstSeq) break
        before = data.firstSeq
      }
    }
    state.taskTrace[key] = { loading: false, rows: SatuCore.traceRows(events), at: Date.now(), error: '' }
  } catch (e) {
    state.taskTrace[key] = { ...(had || {}), loading: false, at: Date.now(), error: e.message || String(e) }
  }
  paintChat()
}

/* ── 目标 Bot 这边收到的派活（docs/bot-tasks.md §7）──────────────────────
   和主 Bot 那边的派活卡对称：画成「主 Bot 发来的一条消息」——左侧、主 Bot 的头像和名字，
   不是右边人打的那种气泡。那条 user/message 是工人替主 Bot 发的，人一个字也没说过。
   正文去掉首行标题和末尾那句给模型看的交代：名字那一行已经说了是谁派的。

   **它开的那一轮默认折起来。** 那是替主 Bot 跑的一次性差事，结论已经交回主 Bot；摊开的话
   一件活几十次工具调用，把人和这颗 Bot 自己的对话挤得找不着。卡上只留任务、状态和一个
   「展开过程」，点开才露出那一轮的回复和工具。 */

const TASK_IN_HEAD = /^【主 Bot「([^」]*)」派来的任务】\n?/
const TASK_IN_TAIL = /\s*（做完把结果直接写在回复里[^）]*）\s*$/

/**
 * 展开过的那几件：`<会话>:<指令那条 user/message 的 seq>`。只在这一页里记着，刷新就回到折起来。
 * 带上会话：每条会话的 seq 都从 1 起，只记 seq 的话在一颗 Bot 上展开了 42，切到另一颗它的 42 也是开的。
 */
const taskInOpen = new Set()
const taskInKey = (sessionId, seq) => `${sessionId || ''}:${seq ?? ''}`

/**
 * 指令那一块，加上卡片要的几样：谁派的、开没开、那一轮调了几次工具。`blocks[i]` 是它自己，
 * 后面紧跟着的 via=task 的助手块就是它那一轮的（fold 给助手块标的是这一轮开头那条消息的来源）。
 */
function taskInBlock(b, blocks, i, live, sessionId) {
  const a = b.assigned || null
  const raw = String(b.text || '')
  const head = raw.match(TASK_IN_HEAD)
  const from = (a && a.from) || {}
  let calls = 0
  /**
   * 那一轮里有没有等人的东西：没批的高风险确认、没人接的交接单。有就**不许折**——确认卡挂在
   * 助手块上，折起来人就看不见，主 Bot 只能干等到超时、记成没做成。批完、接完再照常折回去。
   */
  let waits = 0
  if (a && a.state !== 'steered') {
    for (let j = i + 1; j < blocks.length && blocks[j].kind === 'assistant' && blocks[j].via === 'task'; j++) {
      calls += (blocks[j].tools || []).length
      waits += (blocks[j].approvals || []).filter((x) => x.state === 'pending' && !approvalDead(x)).length
      waits += (blocks[j].handoffs || []).filter((h) => h.state === 'open' && !handoffDead(h)).length
    }
  }
  return {
    ...b,
    text: raw.replace(TASK_IN_HEAD, '').replace(TASK_IN_TAIL, ''),
    taskFrom: { id: from.id || '', name: from.name || (head && head[1]) || '' },
    // 老席位插进人那一轮的（steered）没有自己的轮次，没什么可折的。
    foldable: Boolean(a && a.state !== 'steered'),
    openKey: taskInKey(sessionId, b.seq),
    open: waits > 0 || taskInOpen.has(taskInKey(sessionId, b.seq)),
    calls,
    waits,
    // 这条会话还在跑没有（fold 的 status）。一轮只有 turn/start 没有 turn/end、而席位说没在跑：上一条命死在半路了。
    live: Boolean(live),
  }
}

function taskInBotOf(b) {
  const bots = state.runtimeBots || []
  return bots.find((x) => b.taskFrom.id && x.id === b.taskFrom.id) || bots.find((x) => b.taskFrom.name && x.name === b.taskFrom.name)
}

function taskInRowShell(b, key) {
  const bot = taskInBotOf(b)
  const qseq = quoteSeqOf(b)
  return (
    `<div class="sw-msg sw-taskin" data-role="assistant" data-key="${esc(key)}"${qseq != null ? ` data-seq="${esc(String(qseq))}"` : ''} data-via="task">` +
    `<div class="sw-msg-avatar" aria-hidden="true"${bot ? ' data-bot="1"' : ''}>${bot ? botAvatar(bot.icon, 36, bot.origin) : ICON_BOT}</div>` +
    `<div class="sw-msg-col">` +
    `<div class="sw-taskname"><span class="sw-taskname-bot">${esc((bot && bot.name) || b.taskFrom.name)}</span><span class="sw-taskname-tag"></span></div>` +
    `<div class="sw-bubble" data-role="assistant"><div class="sw-md"></div><div class="sw-chips" hidden></div>` +
    `<button type="button" class="sw-taskin-toggle" data-act="chat-taskin-toggle" data-seq="${esc(b.openKey || '')}" hidden></button></div>` +
    `<div class="sw-msg-meta"><time class="sw-time" hidden></time></div>${msgActsHtml(b)}</div></div>`
  )
}

/** 派来的活现在怎样了：fold 从它那一轮的 turn/start、turn/end 填的。 */
function taskInState(b) {
  const st = (b.assigned && b.assigned.state) || ''
  // 重放还没收尾时 live 还没到（折出来的 status 是空的）：这时说「没收口」是误报，照旧说在跑。
  if (st === 'running' && !b.live && !state.chatReplaying) return 'lost'
  return st
}

const TASK_IN_LABEL = {
  queued: () => t('派来的任务 · 排队中', 'Assigned · Queued'),
  running: () => t('派来的任务 · 正在执行', 'Assigned · Working'),
  completed: () => t('派来的任务 · 已完成', 'Assigned · Done'),
  aborted: () => t('派来的任务 · 已停止', 'Assigned · Stopped'),
  lost: () => t('派来的任务 · 没收口', 'Assigned · Interrupted'),
  steered: () => t('派来的任务', 'Assigned a task'),
}

/** 名字那一行的状态签、底下那颗开合按钮，以及名单晚到时补换主 Bot 的头像。每帧跑，变了才写。 */
function updateTaskIn(el, b) {
  const av = el.querySelector(':scope > .sw-msg-avatar')
  if (av && !av.hasAttribute('data-bot')) {
    const bot = taskInBotOf(b)
    if (bot) {
      av.innerHTML = botAvatar(bot.icon, 36, bot.origin)
      av.setAttribute('data-bot', '1')
      el.querySelector('.sw-taskname-bot').textContent = bot.name || b.taskFrom.name
    }
  }
  const st = taskInState(b)
  const sig = [st, b.foldable ? 1 : 0, b.open ? 1 : 0, b.calls, b.waits ? 1 : 0].join('|')
  if (el.getAttribute('data-sig') === sig) return
  el.setAttribute('data-sig', sig)
  el.setAttribute('data-state', st)
  if (b.foldable) el.setAttribute('data-open', b.open ? '1' : '0')
  else el.removeAttribute('data-open')
  el.querySelector('.sw-taskname-tag').textContent = b.waits
    ? t('派来的任务 · 等你确认', 'Assigned · Needs you')
    : (TASK_IN_LABEL[st] || (() => t('派来的任务 · 出错了', 'Assigned · Failed')))()
  const btn = el.querySelector('.sw-taskin-toggle')
  // 有等人的东西时强制摊开（见 taskInBlock），「收起」点了也收不起来，干脆不摆。
  btn.hidden = !b.foldable || Boolean(b.waits)
  btn.setAttribute('aria-expanded', b.open ? 'true' : 'false')
  const n = b.calls ? t(`${b.calls} 次工具调用`, `${b.calls} tool calls`) : ''
  btn.textContent = b.open ? t('收起过程', 'Hide the work') : n ? t(`展开过程 · ${n}`, `Show the work · ${n}`) : t('展开过程', 'Show the work')
}

/** 「正在执行」后面那个读秒。只在页面上有在跑的派活卡时转。 */
let taskTicker = null
function tickTaskElapsed() {
  const els = document.querySelectorAll('.sw-taskelapsed[data-since]')
  for (const el of els) {
    const s = Math.max(0, Math.round((Date.now() - Number(el.getAttribute('data-since'))) / 1000))
    el.textContent = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  }
  if (els.length && !taskTicker) taskTicker = setInterval(tickTaskElapsed, 1000)
  if (!els.length && taskTicker) {
    clearInterval(taskTicker)
    taskTicker = null
  }
}

/** 药丸上那几个字。比卡片上那句话短——药丸要一眼扫过，长了就换行。 */
const APPROVAL_CHIP_LABEL = {
  approved: () => t('已批准', 'approved'),
  denied: () => t('已拒绝', 'denied'),
  timeout: () => t('超时未批', 'timed out'),
  aborted: () => t('已作废', 'voided'),
  expired: () => t('已失效', 'expired'),
}

/** 这条确认现在算哪一态。失效是界面自己判出来的（见 approvalDead），日志里没有。 */
function approvalState(a) {
  return approvalDead(a) ? 'expired' : a.state
}

/**
 * 有结论的确认，收成一颗药丸。
 *
 * **和工具痕迹用同一个类（sw-toolchip）**，为的是复用悬浮窗那一整套——触发、定位、
 * chips 重画之后把浮层接回新节点。多加一个 sw-approvalchip 只是为了让挂 `__tool`
 * 那两个循环分得开彼此，别把下标错位（见 updateRow）。
 *
 * 批准的用普通底色：那是常态，不该每条对话里都跳出来。没批准的走 error 那一档——
 * 它往往正是「它后来为什么没干成」的答案，翻记录时要找得到。
 */
function approvalChipHtml(a, i) {
  const state = approvalState(a)
  const label = (APPROVAL_CHIP_LABEL[state] || APPROVAL_CHIP_LABEL.denied)()
  const tone = state === 'approved' ? 'done' : 'error'
  const mail = a.form && a.form.kind === 'email'
  // 药丸上写**剥壳之后**那把工具的名字：`mcp_github_default_sw_run` 谁也看不出是什么。
  const name = (a.form && a.form.tool) || a.name
  const edited = (a.edited || []).length ? ' · ' + t('已改', 'edited') : ''
  // 退回修改也是一次 denied，但它的意思是「照这个改了再来」，药丸上要说得出来。
  const label2 = state === 'denied' && a.feedback ? t('退回修改', 'sent back') : label
  return (
    `<span class="sw-chip sw-toolchip sw-approvalchip" data-state="${tone}" data-i="${i}" tabindex="0">` +
    `${mail ? ICON_MAIL : ICON_SHIELD}<span>${esc(name)} · ${esc(label2)}${esc(edited)}</span></span>`
  )
}

/** 挂到药丸上给悬浮窗读的那份。`approval: true` 是分支标记，见 toolPopBody。 */
function approvalPop(a) {
  return {
    approval: true,
    name: (a.form && a.form.tool) || a.name,
    args: a.args,
    form: a.form || null,
    edited: a.edited || null,
    feedback: a.feedback || '',
    reason: a.reason,
    state: approvalState(a),
  }
}

/**
 * 卡片上写到一半的修改意见：`callId::key` → 当前值。
 *
 * **必须存在渲染之外。** 气泡会因为别的事重画（同一轮里又来了一条工具结果、另一条
 * 确认冒出来），而重画是 innerHTML 整体换掉——正在写的那段意见会跟着没。这张表在
 * 重画之后把值填回去，人写到哪儿还是哪儿。
 */
const approvalDrafts = new Map()

function draftKey(callId, key) {
  return callId + '::' + key
}

/** 修改意见那一格在草稿表里的 key。 */
const FEEDBACK_KEY = 'feedback'

/**
 * 这封信的正文是不是 HTML。
 *
 * 席位为了让老版本也能把没认出的参数露出来，会把 `is_html` 当成一格只读字段一起
 * 送来；所以不能只看布尔值（到这里通常已经是字符串了）。`html_body` 则是另一批
 * 邮件工具的命名，本身就说明这一格该按 HTML 预览。
 */
function approvalEmailIsHtml(a, fields) {
  const flag = fields.find((f) => {
    const key = String(f.key || '').split('.').pop().toLowerCase()
    return key === 'is_html'
  })
  if (flag) return /^(true|1|yes)$/i.test(String(flag.value || '').trim())
  return fields.some((f) => String(f.key || '').split('.').pop().toLowerCase() === 'html_body')
}

/**
 * HTML 邮件只在 sandbox iframe 里预览，不能直接塞进批准页的 DOM。
 *
 * sandbox 禁掉脚本和顶层跳转；CSP 再挡住远程图片、字体和表单提交。尤其是邮件里的
 * 跟踪像素，光用 sandbox 并不会阻止它发请求，所以这里默认只放行内嵌 data/cid 资源。
 */
function emailPreviewDoc(html) {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: cid:; font-src data:; media-src data:; style-src \'unsafe-inline\'; form-action \'none\'; base-uri \'none\'">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>html{color-scheme:light}body{box-sizing:border-box;margin:0;padding:14px;background:#fff;color:#171717;font:14px/1.55 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}</style>' +
    '</head><body>' + String(html || '') + '</body></html>'
  )
}

/**
 * 发信卡上的 HTML 正文要**整封摊开**，不是一个固定高度的小窗。
 *
 * 人在这儿批的是「写了什么」——看不完整封就点批准，和没看是一样的。卡片是 innerHTML
 * 换出来的，节点每次重画都是新的，所以挂上去之后要补一遍：等 iframe 载入完再按文档
 * 高度撑（load 不冒泡，用捕获期在 document 上接）。纯文本正文是普通的块，自己就会长高。
 */
function fitMailPreview(frame) {
  try {
    const doc = frame.contentDocument
    // 量 body 不量 html：html 的高度就是 iframe 的视口，一旦撑高过就再也缩不回去。
    const h = doc && doc.body ? doc.body.scrollHeight : 0
    if (h) frame.style.height = h + 2 + 'px'
  } catch {
    // 拿不到文档（同源被挡）就留着 CSS 的最小高度，预览本身照样能看。
  }
}
function fitMailCards(root) {
  const fit = () => {
    for (const frame of root.querySelectorAll('iframe[data-mail-preview]')) fitMailPreview(frame)
  }
  fit()
  // 刚塞进 DOM 那一刻气泡可能还没撑到最终宽度（父级在同一帧里也在重排），下一帧补量一次。
  requestAnimationFrame(fit)
}
// 窗口一变宽，折行就变，整封信的高度也跟着变。
window.addEventListener('resize', () => fitMailCards(document))
document.addEventListener(
  'load',
  (e) => {
    const el = e.target
    if (el instanceof HTMLIFrameElement && el.hasAttribute('data-mail-preview')) fitMailPreview(el)
  },
  true,
)

/** 卡片底下那排按钮。发信那张的第一个按钮说「批准并发送」——它就是要干这件事。 */
function approvalActs(a, okLabel) {
  /**
   * terminal 的「这一轮都批准」只放行一字不差的同一条命令（席位那边 approvals.ts 的
   * grantKey）：它的风险在命令里，按工具放行等于批了一条删临时文件、放过一整轮的删目录。
   * 按钮上的话要跟着改，不然人以为后面的命令都不会再问。
   */
  const byCommand = ((a.form && a.form.tool) || a.name) === 'terminal'
  const turnTip = byCommand
    ? t('这一轮里一字不差的同一条命令不再问；换一条命令照样会问。', 'This exact command won\'t ask again until this reply finishes; any other command still asks.')
    : t('从你刚才那句话到它答完，这把工具不再问；下一句话会重新问。', 'Until this reply finishes, this tool won\'t ask again; your next message starts over.')
  return (
    `<div class="sw-approval-acts">` +
    `<button type="button" class="btn btn-primary" data-act="chat-approve" data-call="${esc(a.callId)}" data-scope="once">${esc(okLabel)}</button>` +
    /**
     * **「这一轮」，不是「这次对话」。**
     *
     * 一个 Bot 一辈子只有一条会话（席位那边的 ensureSession 有就复用），所以按会话
     * 放行等于给出一张永久通行证——而人点它时想的是「我让它发三封信，别问我三遍」。
     * 范围收在这一轮里，下一句话重新问。按钮上的话要跟真实范围对得上，
     * 否则这颗按钮就是在替人做一个他没同意的决定。
     */
    `<button type="button" class="btn btn-secondary" data-act="chat-approve" data-call="${esc(a.callId)}" data-scope="turn"` +
    ` title="${esc(turnTip)}"` +
    `>${esc(byCommand ? t('这一轮这条都批准', 'Approve this command for this turn') : t('这一轮都批准', 'Approve for this turn'))}</button>` +
    `<button type="button" class="btn btn-ghost" data-act="chat-deny" data-call="${esc(a.callId)}" data-scope="once">${esc(t('拒绝', 'Deny'))}</button>` +
    /**
     * 拒绝那一侧也配一颗带范围的，和批准那一对对称。
     *
     * 只有「拒绝」的话，模型下一步换个措辞再调一遍同样的东西，人得一次次点——而每一次
     * 都长得差不多。点这颗，这一轮里同一把工具直接挡掉，理由如实告诉模型「刚拒过」，
     * 让它去换做法，不是换措辞。
     *
     * **单独一颗，不做成「拒绝」的默认行为**：默认就挡的话，「拒绝 → 我跟它说改发给
     * 李总 → 它重发」这条最自然的路会被自己挡死（插话是插进同一轮的）。
     */
    `<button type="button" class="btn btn-ghost" data-act="chat-deny" data-call="${esc(a.callId)}" data-scope="turn"` +
    ` title="${esc(t('这一轮里同一把工具直接挡掉，不再问你；下一句话会重新开始。', 'Blocks this tool for the rest of this reply; your next message starts over.'))}"` +
    `>${esc(t('这一轮别再试', 'Block for this turn'))}</button>` +
    `</div>`
  )
}

/**
 * 发信卡上不摆的那几格：`is_html` 已经体现在正文是按 HTML 预览还是按纯文本排，
 * `user_id`（几乎总是 `me`）是连接器自己的寻址参数。两格对「发给谁、写了什么」
 * 没有信息量，摆出来只会让人以为要核对它们。
 */
const MAIL_HIDDEN_KEYS = new Set(['is_html', 'user_id'])

function mailFieldHidden(f) {
  return MAIL_HIDDEN_KEYS.has(String(f.key || '').split('.').pop().toLowerCase())
}

/**
 * 发信那张卡。
 *
 * **为什么单独做一张**：通用卡把整份 JSON 摊出来，而人在批一封信的时候要看的是
 * 「发给谁、写了什么」，不是一段带转义符的 JSON。
 *
 * **内容只读，要改就写修改意见退回去。** 人直接改正文，改出来的那一版模型不知道，
 * 后面几封照旧按它自己的写法来；把意见写下来交回给它（「退回修改」，见 chat-decide.js），
 * 它照着改完再提交一次，新的那一版重新弹卡——下一封它也就知道该怎么写了。
 *
 * 只读的那几格（收件人、抄送、附件…）**照样摆出来**：藏起来的话，人以为自己看到了
 * 这封信的全部，而实际发出去的可能带着别的东西。藏的只有 MAIL_HIDDEN_KEYS 那两格。
 */
function approvalEmailHtml(a) {
  const fields = (a.form && a.form.fields) || []
  const isHtml = approvalEmailIsHtml(a, fields)
  const rows = fields
    .filter((f) => !mailFieldHidden(f))
    .map((f) => {
      const value = f.value || ''
      if (!f.multiline) {
        return value
          ? `<div class="sw-mail-row"><span class="sw-mail-k">${esc(f.label)}</span><span class="sw-mail-v">${esc(value)}</span></div>`
          : ''
      }
      if (isHtml || String(f.key || '').split('.').pop().toLowerCase() === 'html_body') {
        return (
          `<div class="sw-mail-body sw-mail-html"><span class="sw-mail-k">${esc(f.label)}</span>` +
          // sandbox 里只放 allow-same-origin，**不放 allow-scripts**：没有脚本，同源的那头什么也
          // 拿不到；而只有同源，外面才读得到它的 scrollHeight，把整封信按实际高度撑开
          // （见 fitMailPreview）——不然就是一个 240px 的小窗，长信得在里面再滚一遍。
          `<iframe class="sw-mail-preview" sandbox="allow-same-origin" referrerpolicy="no-referrer"` +
          ` title="${esc(t('HTML 邮件正文预览', 'HTML email body preview'))}" data-mail-preview` +
          ` srcdoc="${esc(emailPreviewDoc(value))}"></iframe></div>`
        )
      }
      // 纯文本正文：按收件人那边看到的样子排——白底、正文字号、保留换行，整封摊开。
      return `<div class="sw-mail-body"><span class="sw-mail-k">${esc(f.label)}</span>` +
        `<div class="sw-mail-plain">${esc(value)}</div></div>`
    })
    .join('')
  const note = approvalDrafts.get(draftKey(a.callId, FEEDBACK_KEY)) || ''
  return (
    `<div class="sw-approval sw-approval-mail" data-state="pending" data-call="${esc(a.callId)}">` +
    `<div class="sw-approval-head">${ICON_MAIL}<span>${esc(t('这封邮件要发出去了', 'This email is about to be sent'))}</span></div>` +
    `<div class="sw-approval-why">${esc(t(
      '核对一遍再批准；哪里要改，在下面写修改意见，它会照着重写一版再给你看。',
      'Check it before approving. If something needs changing, write it below and it will redo the draft for you to review.',
    ))}</div>` +
    `<div class="sw-mail">${rows}</div>` +
    `<div class="sw-mail-feedback">` +
    `<label class="sw-mail-k" for="sw-fb-${esc(a.callId)}">${esc(t('修改意见', 'Changes'))}</label>` +
    `<textarea class="input sw-mail-note" id="sw-fb-${esc(a.callId)}" rows="2" data-feedback data-call="${esc(a.callId)}"` +
    ` placeholder="${esc(t('比如：语气正式一点，结尾加上我的签名', 'e.g. make it more formal and add my signature'))}">${esc(note)}</textarea>` +
    `<div class="sw-mail-feedback-acts">` +
    `<button type="button" class="btn btn-secondary" data-act="chat-revise" data-call="${esc(a.callId)}">${esc(t('按意见重写', 'Redo with changes'))}</button>` +
    `</div></div>` +
    `<div class="sw-approval-tool"><code>${esc((a.form && a.form.tool) || a.name)}</code></div>` +
    approvalActs(a, t('批准并发送', 'Approve and send')) +
    `</div>`
  )
}

/**
 * 一张确认卡。**只画还等着人点的那些**——有结论的收成药丸（approvalChipHtml）。
 *
 * 按席位给的 `form.kind` 分流：认得的走定制样式（发信那张），认不出的走下面这张通用卡。
 * **认不出不是理由把参数藏起来**——通用卡把整份 JSON 摆出来，人照样看得见自己在批什么。
 *
 * **参数要摆出来。** 「Bot 想调用 send_email，批准吗」这句话本身没有信息量——人要批的
 * 是「发给谁、写了什么」，看不到这些就只能凭信任点，那和没有这个开关是一样的。
 */
/**
 * 本地 Bot 申请访问一个文件夹（席位那边的 request_folder_access）。
 *
 * **Bot 说了要哪个文件夹，「批准」就直接批那一个**：卡上写得清清楚楚，再让人在选择框里把
 * 同一个文件夹找一遍是多此一举。路径交给 Desktop（approve_local_directory 带 path），
 * 那边展开 `~`、核对是真实存在的文件夹，并挡掉整个磁盘和整个用户目录——那两种得人亲手选。
 * 要的不是这个，点「换一个文件夹…」拉起系统选择框，选什么批什么；没说要哪个时只有这一颗。
 * 选择框里点取消就什么都不提交，卡片留着。
 *
 * 这张卡没有「这一轮都批准」：每一个文件夹都该是人看过的那一个。
 *
 * 普通浏览器里批不了（入口链接要 Desktop 来建），照实说，只留一颗拒绝。
 */
function approvalFolderHtml(a) {
  const fields = (a.form && a.form.fields) || []
  const reason = (fields.find((f) => f.key === 'reason') || {}).value || a.reason || ''
  const suggested = (fields.find((f) => f.key === 'suggested') || {}).value || ''
  const bridge = window.__SATUWORK_LOCAL_BOT__
  const canPick = Boolean(window.__SATUWORK_DESKTOP__ && bridge && typeof bridge.approveDirectory === 'function')
  return (
    `<div class="sw-approval sw-approval-folder" data-state="pending" data-call="${esc(a.callId)}">` +
    `<div class="sw-approval-head">${ICON_SHIELD}<span>${esc(t('Bot 想访问一个文件夹', 'The bot wants to access a folder'))}</span></div>` +
    (reason ? `<div class="sw-approval-why">${esc(reason)}</div>` : '') +
    (suggested
      ? `<div class="sw-approval-tool">${esc(t('它想要的是', 'It asked for'))} <code>${esc(suggested)}</code></div>`
      : '') +
    `<div class="sw-approval-acts">` +
    (canPick && suggested
      ? `<button type="button" class="btn btn-primary" data-act="chat-folder-pick" data-call="${esc(a.callId)}" data-path="${esc(suggested)}">${esc(t('批准', 'Approve'))}</button>` +
        `<button type="button" class="btn btn-ghost" data-act="chat-folder-pick" data-call="${esc(a.callId)}">${esc(t('换一个文件夹…', 'Choose another…'))}</button>`
      : canPick
      ? `<button type="button" class="btn btn-primary" data-act="chat-folder-pick" data-call="${esc(a.callId)}">${esc(t('选择文件夹…', 'Choose a folder…'))}</button>`
      : `<span style="font-size: 12.5px; color: var(--muted-foreground);">${esc(t('要在 Satuwork 桌面端里批准：文件夹的访问入口只有它建得了。', 'Approve this in the Satuwork desktop app — only it can grant folder access.'))}</span>`) +
    `<button type="button" class="btn btn-ghost" data-act="chat-deny" data-call="${esc(a.callId)}" data-scope="once">${esc(t('拒绝', 'Deny'))}</button>` +
    `</div></div>`
  )
}

function approvalHtml(a) {
  if (a.form && a.form.kind === 'folder') return approvalFolderHtml(a)
  if (a.form && a.form.kind === 'email' && (a.form.fields || []).length) return approvalEmailHtml(a)
  const args = prettyArgs(a.args)
  return (
    `<div class="sw-approval" data-state="pending" data-call="${esc(a.callId)}">` +
    `<div class="sw-approval-head">${ICON_SHIELD}<span>${esc(t('需要你确认', 'Needs your approval'))}</span></div>` +
    `<div class="sw-approval-why">${esc(a.reason)}</div>` +
    `<div class="sw-approval-tool"><code>${esc(a.name)}</code></div>` +
    (args ? `<pre class="sw-approval-args">${esc(clip(args))}</pre>` : '') +
    approvalActs(a, t('批准这一次', 'Approve once')) +
    `</div>`
  )
}

/**
 * 一张交接卡（见 docs/handoff.md）。
 *
 * **只画还没闭合的那些。** 已经关掉的收成一行灰字（handoffDoneHtml）——一件已经办完
 * 的事再占着半屏输入框，往上翻这一轮对话会被几张作废的卡挡住。
 *
 * 卡上最大的那行字是 `ask`（要人做什么），不是 `reason`（为什么卡住）。接手的人先要
 * 知道自己该干嘛；为什么卡住是接下来才关心的事。
 */
function handoffHtml(h) {
  return `<div class="sw-approval sw-handoff" data-state="${esc(h.state)}" data-handoff="${esc(h.id)}">
    <div class="sw-approval-head">${ICON_HAND}<span>${t('需要人工协助', 'Human help needed')}</span>${handoffStateTag(h)}</div>
    <div class="sw-handoff-ask">${esc(h.ask || t('请查看交接详情', 'Review handoff details'))}</div>
    ${h.reason ? `<div class="sw-approval-why"><span class="ho-label">${t('转交原因', 'Reason')}</span>${esc(h.reason)}</div>` : ''}
    ${handoffContext(h)}
    <div class="sw-handoff-meta">${h.claimedBy && h.claimedBy.name ? `<span>${t('处理人', 'Handler')} · ${esc(h.claimedBy.name)}</span>` : ''}
      ${h.blocking && h.state !== 'returned' ? `<span>${t('此任务正在等待人工处理', 'This task is waiting for human help')}</span>` : ''}
      ${h.repeats ? `<span>${t('同一问题再次触发', 'Repeated issue')} × ${esc(String(h.repeats))}</span>` : ''}
    </div>${handoffForm(h)}
  </div>`
}

/** 已经闭合的那几张，收成一行。留着是因为「这件事上次是怎么处理的」要看得见。 */
function handoffDoneHtml(h) {
  const map = {
    closed: () => t('转人工 · 已完成', 'Handoff · done'),
    expired: () => t('转人工 · 已过期，超时未处理', 'Handoff · expired without a response'),
    cancelled: () => t('转人工 · 已撤销', 'Handoff · cancelled'),
  }
  // 席位上已经没有这张单了（重装、换机器、清过库）。**说出来**，别画成「已完成」——
  // 那件事到底办没办，这边并不知道。
  if (handoffDead(h)) {
    return `<div class="sw-handoff-done">${ICON_HAND}<span>${esc(t('转人工 · 席位上已经没有这张单了', 'Handoff · the seat no longer has this ticket'))}</span></div>`
  }
  const label = (map[h.state] || (() => t('转人工', 'Handoff')))()
  const by = h.result && h.result.by && h.result.by.name ? ` · ${h.result.by.name}` : ''
  return `<div class="sw-handoff-done">${ICON_HAND}<span>${esc(label + by)}</span></div>`
}

/** 一条消息的外壳。正文和工具条留空，交给 updateRow 填——它俩每帧都可能变。 */
/**
 * 助手那一行的头像：**这颗 Bot 自己的**（和侧栏、顶栏、派活卡上同一个），不是通用的机器人图标。
 * 名单还没到时先画通用图标，到了由 updateRow 补换（rowShell 只在节点新建时跑一次）。
 */
function assistantAvatar() {
  const bot = chatBotOf()
  return bot ? { html: botAvatar(bot.icon, 36, bot.origin), own: true } : { html: ICON_BOT, own: false }
}

function rowShell(b, key) {
  if (b.taskFrom) return taskInRowShell(b, key)
  const account = (state.me && state.me.account) || {}
  const mine = b.kind === 'user' ? null : assistantAvatar()
  const avatar = b.kind === 'user' ? accountAvatar(account, 36) : mine.html
  // 时间戳两侧一致，都挂在气泡外面（见 chat.css 里 .sw-time 的说明）。
  //
  // 内容留空，交给 updateRow：助手那条**还在输出时是读秒**、输出完了才换成时刻，
  // 而 rowShell 只在节点新建时跑一次，盯不住这个变化。
  const time = '<div class="sw-msg-meta"><time class="sw-time" hidden></time></div>'
  /**
   * 悬停才出现的那排动作，第一版只有「引用」（见 docs/chat-references.md §7.2）。
   *
   * 壳里**总是**画上，显不显示由 updateRow 定：正在流式输出的那条还没有
   * `assistant/message`，seq 指的是第一条 chunk，发出去席位会判「引用的消息不存在」；
   * 回执没回来的那条（pending）同理。那两种情况 updateRow 把它藏起来。
   */
  const qseq = quoteSeqOf(b)
  return (
    `<div class="sw-msg" data-role="${b.kind}" data-key="${key}"${qseq != null ? ` data-seq="${esc(String(qseq))}"` : ''}${b.via ? ` data-via="${esc(b.via)}"` : ''}${b.pending ? ' data-pending="1"' : ''}>` +
    `<div class="sw-msg-avatar" aria-hidden="true"${mine && mine.own ? ' data-bot="1"' : ''}>${avatar}</div>` +
    `<div class="sw-msg-col">` +
    `<div class="sw-bubble" data-role="${b.kind}"><div class="sw-md"></div><div class="sw-chips" hidden></div></div>` +
    `${time}${msgActsHtml(b)}</div></div>`
  )
}

/**
 * 引用这一块时该指的 seq：那条 user/message / assistant/message 事件，**不是块的 seq**
 * （助手块的 seq 是它第一条事件的，常常是一条 chunk，见 fold 里 msgSeq 那段）。
 * 还在流式输出的助手块没有它——那条 assistant/message 还没写下来。
 */
function quoteSeqOf(b) {
  if (!b) return null
  if (b.kind === 'user') return b.seq != null ? b.seq : null
  return b.msgSeq != null ? b.msgSeq : null
}

/** 悬停才出现的那排动作（见 rowShell 的说明）。没有可引用的 seq 就是空串。 */
function msgActsHtml(b) {
  const qseq = quoteSeqOf(b)
  if (qseq == null) return ''
  return (
    `<div class="sw-msg-acts" hidden><button type="button" class="sw-msg-act" data-act="chat-ref-msg" ` +
    `data-seq="${esc(String(qseq))}" data-role="${b.kind}" title="${esc(t('引用这条', 'Quote this'))}" ` +
    `aria-label="${esc(t('引用这条', 'Quote this'))}">${ICON_QUOTE}<span>${esc(t('引用', 'Quote'))}</span></button></div>`
  )
}
