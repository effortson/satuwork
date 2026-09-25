// Vercel Web Analytics 和 Speed Insights 的前置脚本。**只在 Vercel 上会被加载**：
// gateway/src/http.ts 的 serveUi 在 VERCEL=1 时往 index.html 里注入这一份、
// /_vercel/insights/script.js 和 /_vercel/speed-insights/script.js；自托管和桌面端没有
// 那两个端点，也就不带它。
//
// 单独成文件而不是按文档写成内联 <script>：CSP 的 script-src 不带 'unsafe-inline'。
// 也没用 @vercel/speed-insights 包的 injectSpeedInsights()：这套界面不打包，它做的事就是
// 下面这个队列加一个 defer 脚本标签。
//
// 必须在两个 script.js 之前执行——它们加载时会把 window.vaq / window.siq 里排着的调用
// （这里的 beforeSend）接过去。
window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments) }
window.si = window.si || function () { (window.siq = window.siq || []).push(arguments) }

// 上报前把地址洗一遍：
// - 查询串和 # 一律丢掉。前端路由不用它们，留着只会把偶然带上的东西送出去。
// - /join/<邀请令牌> 的令牌是凭据，整段换成占位。
// - 其余带 id 的屏把 id 换成 [id]，看板上才能按「哪一屏」聚合，而不是一条 id 一行。
//
// 两边的 beforeSend 收到的都是带 url 的对象，也都只取回返回值里的 url，所以共用这一个。
const VA_ID_PREFIXES = new Set(['a', 'bots', 'connectors', 'companies', 'users', 'machines', 'audit'])

function scrubEventUrl(event) {
  try {
    const url = new URL(event.url)
    const segs = url.pathname.split('/')
    if (segs[1] === 'join') url.pathname = '/join/[token]'
    else if (VA_ID_PREFIXES.has(segs[1]) && segs[2]) {
      segs[2] = '[id]'
      url.pathname = segs.join('/')
    }
    url.search = ''
    url.hash = ''
    return { ...event, url: url.toString() }
  } catch {
    // 洗不了就不报，别把原样的地址送出去。
    return null
  }
}

window.va('beforeSend', scrubEventUrl)
window.si('beforeSend', scrubEventUrl)
