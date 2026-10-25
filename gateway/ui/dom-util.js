/**
 * 几样 DOM 小工具：复制到剪贴板、把一个 Blob 存成文件、这台 Gateway 配的 CDN 根。
 *
 * 普通脚本，挂全局。**不是分片**：渠道预览页（gateway/src/routes/channels.ts 那一页）不装
 * 那一串分片，却也要存文件、读 CDN 根；markdown.js 的复制和下载也用它。所以它单独加载，
 * 排在 markdown.js 前面——index.html 和渠道预览页都是这个顺序。
 */

// 复制分两段走，因为线上和内网是两种环境。
//
// navigator.clipboard 在规范里标了 [SecureContext]：https 和 localhost 之外整个对象
// 都不存在，writeText 不是被拒，是直接抛 TypeError。而 Gateway 常常就跑在
// http://192.168.x.x:3080 这种内网地址上——「复制失败」绝大多数时候是这个原因，不是
// 用户没给权限。所以后面接上 execCommand 那条老路兜底，它不挑安全上下文（聊天里复制
// 代码块也走这一条，见 markdown.js）。
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {}
  return copyTextFallback(text)
}

/**
 * 老路：把文字塞进一个隐形 textarea、选中、复制、撤掉。
 *
 * 它要的是 transient user activation（点一下之后的那几秒）。按钮上那几处是直接点出来
 * 的，稳；而「生成邀请链接顺手复制」得先等一次 POST 回来，网络慢过那个窗口就会静静地
 * 失败——所以那处的自动复制只能算搭头，链接本身必须留在界面上给人手动选。
 *
 * 整段包在 try 里：这是尽力而为的兜底，兜底自己炸出来没有意义，返回 false 让调用方按
 * 「没复制成」去提示就行。
 */
function copyTextFallback(text) {
  let ta = null
  try {
    const active = document.activeElement
    ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    // 不能拿 display:none / visibility:hidden 藏——那样选不中，复制过去是空的。
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, String(text).length)
    const ok = document.execCommand('copy')
    // 焦点还回去，不然弹窗里点完「再复制一次」焦点就掉到 body 上了。
    if (active && active.focus) active.focus()
    return !!ok
  } catch {
    return false
  } finally {
    if (ta && ta.remove) ta.remove()
  }
}

/**
 * 把一个 Blob 存成文件：临时挂一个 `<a download>` 点一下就撤。
 *
 * blob: 地址过一会儿再撤销——点下去之后浏览器才开始读它，当场撤掉的话下载会落空。
 * 一般一秒够了；知识库那份文件可能很大、存盘慢，给的是一分钟。
 */
function saveBlob(blob, name, revokeMs = 1000) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), revokeMs)
}

/**
 * 按需加载的那几个库（KaTeX / highlight.js / Mermaid / three.js / Office 渲染库）从哪个 CDN 根拉。
 *
 * Gateway 配了内网镜像（`GATEWAY_UI_CDN`）就在页面里插一条 `<meta name="satu-cdn">`（见
 * gateway/src/ui-cdn.ts，那边已经只放行 http(s)），这里读它；没有就用 jsdelivr。不是 http(s)
 * 的一律不认——这个值要拼进脚本地址。
 */
function uiCdn() {
  const meta = typeof document !== 'undefined' && document.querySelector ? document.querySelector('meta[name="satu-cdn"]') : null
  const base = meta && meta.getAttribute('content')
  return base && /^https?:\/\//.test(base) ? base.replace(/\/+$/, '') : 'https://cdn.jsdelivr.net/npm'
}
