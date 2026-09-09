import { request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { verifyDesktopTicket, type JwtKeys } from './crypto.ts'
import type { Db } from './db.ts'
import { MIN_DESKTOP_PROTOCOL } from './deploy.ts'
import { json } from './http.ts'

/**
 * 桌面反代。`/desktop/:seatId/*` → 管家的 `/seats/:seatId/vnc/*`。
 *
 * **为什么要多这一跳。** 桌面原来是浏览器直连管家：`{machine.host}/seats/:id/vnc/`。
 * 那是一个顶层跳转（新标签页打开），管家发的 `SameSite=Lax` cookie 照常放行。改成
 * 在右栏里内嵌之后，那条 cookie 就废了——iframe 里的请求既不是顶层导航，也（当
 * Gateway 和管家不同站时）不是同站请求，浏览器**连存都不会存**它，于是 vnc.html 和
 * 之后的 WebSocket 一律 401，而界面上只是一片空白。
 *
 * 走 Gateway 同域之后，cookie 是第一方的，Lax 不再挡路。顺带两个好处：
 *
 *   - 浏览器**不再需要能连到管家**。以前 Gateway 在云上、管家在公司内网时，这条路
 *     本来就走不通；现在只要 Gateway 连得到管家就行，而它本来就连得到（聊天走的就是
 *     同一条）。
 *   - 机器票（`smt_`）不进浏览器。这一跳用它认到管家那侧，浏览器手里只有一张只对
 *     一块屏、五分钟有效的桌面票。
 *
 * **后来又把 cookie 换成了路径里的票**（`/desktop/:seatId/t/:ticket/*`）。同域反代
 * 之后那个 iframe 和父页同源，`sandbox="allow-scripts allow-same-origin"` 等于没有沙箱：
 * 框里的页面能读父页的 sessionStorage，里面躺着登录 JWT。要去掉 `allow-same-origin`，
 * 框的源就是 opaque——浏览器**不给它发 cookie**，而 noVNC 的静态资源和 WebSocket
 * 都是相对路径拼出来的，没法一条条挂 `?ticket=`。票放进路径段之后，相对路径解析出来
 * 的每一条请求天然都带着它，验票的地方和从前验 cookie 的地方一一对应。
 * 代价：票（含 VNC 口令的 JWT）出现在每条请求的 URL 里；从前 `?password=` 就在落地页
 * 的 URL 上，暴露面同一类，没有变大。见 ui/chat.js 的 mountDesktop。
 *
 * **代价说清楚**：桌面的像素现在全部经过 Gateway。noVNC 只在画面变化时发字节，几个
 * 席位不成问题；真要成规模，这一跳得挪到边缘去。
 */

/** 入口：`/desktop/:seatId/?ticket=…`，验票之后 302 到下面那种带票的路径。 */
const DESKTOP_PREFIX = /^\/desktop\/([^/]+)(\/.*)?$/
/** 落地页、静态资源、WebSocket 都走这条：`/desktop/:seatId/t/:ticket/*`。票是 JWT，字符集里没有 `/`。 */
const TICKET_PREFIX = /^\/desktop\/([^/]+)\/t\/([^/]+)(\/.*)?$/

/**
 * 反代响应上要改的头。
 *
 * - `content-security-policy: frame-ancestors 'self'`：这页只准嵌在 Gateway 自己的页面里
 *   （对话页右栏那个 iframe），别的站不许把它框进去。上游要是带了自己的 CSP / XFO，
 *   一律覆盖——那是给「整页就是一块屏」的直连用法写的，这一跳说了算。
 * - `set-cookie` 不透传：管家那侧的 cookie 落到 Gateway 的域上没有任何意义，只是多一个面。
 * - `access-control-allow-origin: *`：iframe 去掉 `allow-same-origin` 之后源是 opaque，
 *   ES module（noVNC 的 app/ui.js 及其 import）和 locale JSON 都按 CORS 取，没这一行
 *   浏览器直接拒载。放开无妨：这条路上没有 cookie，鉴权全在路径里的票。
 */
function guardHead(head: Record<string, string | string[]>): void {
  delete head['set-cookie']
  delete head['x-frame-options']
  head['content-security-policy'] = "frame-ancestors 'self'"
  head['access-control-allow-origin'] = '*'
  head['cache-control'] = 'no-store'
}

/**
 * 路径段解码，坏了返回 null。
 *
 * `decodeURIComponent('%')` 抛的是 URIError。裸着写的话，普通请求那条会被 Router 的
 * catch 兜成一句 500，升级那条更糟——它在一个 async IIFE 里，直接把进程带走。
 * 解不开的段不可能等于任何一个真实 seatId，当坏请求处理就对了。
 */
function decodeSeg(raw: string): string | null {
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

/** 认路径里那张票认不认。认不过的一律当没认，不区分原因。 */
function seatOfTicketPath(keys: JwtKeys, seatId: string, ticket: string): boolean {
  if (!ticket) return false
  const ok = verifyDesktopTicket(keys, ticket)
  return !!ok && ok.seatId === seatId
}

/**
 * 允许原样带到 noVNC 落地页的显示参数。
 *
 * 右栏那块预览只有两百来像素宽，不给 `resize=scale` 的话 noVNC 按 1:1 画，看到的是
 * 桌面左上角那一小角。**白名单，不是黑名单**：`path` 和 `password` 是这条链上唯一的
 * 连接地址和唯一的凭据，两者都由票决定，放开透传等于让调用方覆盖它们。
 */
const VIEW_PARAMS = new Set(['resize', 'view_only', 'bell', 'reconnect', 'quality', 'compression'])

function viewParams(url: URL): string {
  let out = ''
  const seen = new Set<string>()
  for (const [k, v] of url.searchParams) {
    if (!VIEW_PARAMS.has(k) || seen.has(k)) continue
    if (!/^[A-Za-z0-9_.-]{1,16}$/.test(v)) continue
    seen.add(k)
    out += `&${k}=${encodeURIComponent(v)}`
  }
  return out
}

/** 这块屏在哪台机器上、拿什么认、那台管家多新。查不到就是没有。 */
async function upstreamOf(
  db: Db,
  seatId: string,
): Promise<{ base: string; token: string; protocol: number } | undefined> {
  const row = await db.seatRuntimeBySeatId(seatId)
  if (!row) return
  const machine = await db.machine(row.machineId)
  const base = (machine?.host || '').trim().replace(/\/$/, '')
  if (!base || !machine?.token) return
  return { base, token: machine.token, protocol: machine.protocol ?? 0 }
}

/**
 * 管家太旧时的说法。
 *
 * **这句话是这次改动欠下的债。** 1 号管家在 `/seats/:id/vnc/*` 上只认票和 cookie，
 * 而反代过来的请求两样都没有，于是它回一句「桌面票无效或已过期」——和票真的过期
 * 一字不差。人在浏览器上看到的是同一句话，却要做完全不同的两件事。所以这里先按协议
 * 号把它拦下来，说清楚该干什么。
 */
const TOO_OLD = '这台机器的管家版本过旧，还不会从 Gateway 反代桌面。去「机器配置」里升级管家（升完不用重新部署 Bot）'

function upstreamPath(seatId: string, rest: string, search: string): string {
  return `/seats/${encodeURIComponent(seatId)}/vnc${rest}${search}`
}

/**
 * 落地页上补的一段样式：**关掉 noVNC 自己的控制条**。
 *
 * 那条竖条（连接/断开、剪贴板、Ctrl-Alt-Del、全屏、设置）是给「整页就是一块屏」那
 * 种用法准备的。我们这边它嵌在对话页右栏里、外面已经有自己的标题栏和「重连 / 收起」，
 * 于是它变成了两套控件叠在一起，还压着桌面右边一条。
 *
 * 藏的是 `#noVNC_control_bar_anchor` ——**连那个把手一起**。只藏 `#noVNC_control_bar`
 * 的话，把手还在，点开又是那条。同一段样式里还关掉了「Connected to …」那条提示，
 * 见 LANDING_CSS。
 *
 * 代价说清楚：noVNC 的剪贴板面板和 Ctrl-Alt-Del 都在这条里，藏了就没了。剪贴板仍然
 * 可以走系统那一路（在桌面里自己复制粘贴），跨机器的粘贴要另想办法。选择器对不上时
 * 这段样式什么也不做，页面照旧——不会因为 noVNC 换版本而白屏。
 */
/**
 * 顺带把「Connected to …」那条提示也关掉。
 *
 * noVNC 的状态条只有一个元素（`#noVNC_status`），靠三个类分档：`normal` / `warn` /
 * `error`，连上那句走的是 normal。**只关 normal**——控制条已经藏了，这行字是页面上
 * 唯一还会说「连不上」「断开了」的地方，三档一起关掉，出问题时就只剩一块黑屏。
 */
const LANDING_CSS =
  '<style>#noVNC_control_bar_anchor{display:none!important}' +
  '#noVNC_status.noVNC_status_normal{display:none!important}</style>'

/**
 * 落地页上再补一段脚本：**给沙箱里的 noVNC 一个假的 localStorage**。
 *
 * iframe 去掉 `allow-same-origin` 之后（见文件头），框内碰 `localStorage` 会直接抛
 * SecurityError，而 noVNC 的 app/webutil.js 在 UI 初始化时就用它读设置——一抛整页白屏。
 * 这里在 module 脚本跑之前把 window.localStorage 换成一份内存字典：设置不再跨会话
 * 记住（本来也没人在这块预览里调设置），别的一切照旧。有真 localStorage 时什么也不做。
 */
const LANDING_SHIM =
  '<script>(function(){try{localStorage.getItem("satu")}catch(e){var m={};' +
  'var s={getItem:function(k){return Object.prototype.hasOwnProperty.call(m,k)?m[k]:null},' +
  'setItem:function(k,v){m[k]=String(v)},removeItem:function(k){delete m[k]},clear:function(){m={}},' +
  'key:function(i){return Object.keys(m)[i]||null},get length(){return Object.keys(m).length}};' +
  'try{Object.defineProperty(window,"localStorage",{value:s,configurable:true})}catch(_){}}})()</script>'

/**
 * 落地页要改内容，所以不能像别的资源那样直接对接两个流：先收完，插一段样式，再按
 * 新长度发出去。它只有几十 KB，且一次会话只取一次。
 *
 * **请求上游时把 `accept-encoding` 摘掉**：浏览器会要 gzip/br，而收进内存改字符串
 * 之前得先解压。这一页小，让上游发明文最省事。
 */
function pipeLanding(
  req: IncomingMessage,
  res: ServerResponse,
  target: { base: string; token: string },
  path: string,
) {
  pipeUpstream(req, res, target, path, (body, type) => {
    if (!type.includes('text/html')) return body
    const html = body.toString('utf8')
    const at = html.lastIndexOf('</head>')
    if (at < 0) return body
    return Buffer.from(html.slice(0, at) + LANDING_SHIM + LANDING_CSS + html.slice(at), 'utf8')
  })
}

function pipeUpstream(
  req: IncomingMessage,
  res: ServerResponse,
  target: { base: string; token: string },
  path: string,
  transform?: (body: Buffer, contentType: string) => Buffer,
) {
  let url: URL
  try {
    url = new URL(target.base + path)
  } catch {
    json(res, 502, { error: '机器地址不对' })
    return
  }
  const headers: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue
    // hop-by-hop、我们自己的 cookie、以及 host 都不往下传。**cookie 尤其不能传**：
    // 那是 Gateway 这一侧的凭据，管家不需要，传过去只是多一个泄露面。
    if (k === 'host' || k === 'connection' || k === 'cookie' || k === 'authorization') continue
    // 要改内容就不能收到压缩过的字节——见 pipeLanding。
    if (transform && k === 'accept-encoding') continue
    headers[k] = v
  }
  headers.host = url.host
  headers['x-satuwork-machine'] = target.token
  const upstream = httpRequest(
    {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      method: req.method,
      path: url.pathname + url.search,
      headers,
    },
    (up) => {
      // 我们带的是机器票。管家还回 401，那不是「票过期」——它压根不认这条路上的机器
      // 票，也就是版本太旧。原样透传的话，浏览器上显示的是管家那句和票过期一字不差
      // 的话，人会去反复重开桌面，而那永远不会好。
      if (up.statusCode === 401) {
        up.resume()
        json(res, 409, { error: TOO_OLD })
        return
      }
      const head = { ...(up.headers as Record<string, string | string[]>) }
      guardHead(head)
      if (!transform || up.statusCode !== 200) {
        res.writeHead(up.statusCode ?? 502, head)
        up.pipe(res)
        // 管家半路断了要把浏览器那头一起拆掉：pipe 只在干净的 end 上收尾 res，
        // aborted/error 时只 unpipe，下游会悬着不关（同 manager/src/proxy.ts 那处）。
        up.on('close', () => {
          if (!res.writableEnded) res.destroy()
        })
        return
      }
      const chunks: Buffer[] = []
      up.on('data', (c: Buffer) => chunks.push(c))
      up.on('end', () => {
        const out = transform(Buffer.concat(chunks), String(head['content-type'] || ''))
        // 长度变了；分块编码是上游那一跳的事，我们这一跳自己定长发。
        delete head['content-length']
        delete head['transfer-encoding']
        head['content-length'] = String(out.length)
        res.writeHead(200, head)
        res.end(out)
      })
      up.on('error', () => {
        if (!res.headersSent) json(res, 502, { error: '机器管家中途断了' })
        else res.end()
      })
    },
  )
  upstream.on('error', (e) => {
    if (!res.headersSent) json(res, 502, { error: '连不上机器管家: ' + (e as Error).message })
    else res.end()
  })
  // 客户端先走（关标签页、收起右栏），上游连接不能留着。
  res.on('close', () => upstream.destroy())
  req.pipe(upstream)
}

/** 注册到 Router.intercept。返回 true 表示这个请求已经被反代接管。 */
export function desktopIntercept(db: Db, keys: JwtKeys) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const withTicket = TICKET_PREFIX.exec(url.pathname)
    if (withTicket) {
      // 带票的路径：落地页和 noVNC 自己发的静态资源都从这儿过，每一条都验票。
      const seatId = decodeSeg(withTicket[1])
      if (seatId == null) {
        json(res, 400, { error: '地址不合法' })
        return true
      }
      const rest = withTicket[3] || '/'
      if (!seatOfTicketPath(keys, seatId, withTicket[2])) {
        json(res, 401, { error: '这块屏的凭据过期了（Gateway 验的）。回对话页重新打开它' })
        return true
      }
      const target = await upstreamOf(db, seatId)
      if (!target) {
        json(res, 404, { error: '没有这个席位' })
        return true
      }
      if (target.protocol < MIN_DESKTOP_PROTOCOL) {
        json(res, 409, { error: TOO_OLD })
        return true
      }
      // 落地页要改（关掉 noVNC 自己的控制条），别的资源原样对接两个流。
      const send = rest === '/vnc.html' || rest === '/vnc_lite.html' ? pipeLanding : pipeUpstream
      send(req, res, target, upstreamPath(seatId, rest, url.search))
      return true
    }
    const hit = DESKTOP_PREFIX.exec(url.pathname)
    if (!hit) return false
    const seatId = decodeSeg(hit[1])
    if (seatId == null) {
      json(res, 400, { error: '地址不合法' })
      return true
    }
    const ticket = url.searchParams.get('ticket')
    if (!ticket) {
      json(res, 401, { error: '这块屏的凭据过期了（Gateway 验的）。回对话页重新打开它' })
      return true
    }
    /**
     * 入口。验票之后跳到带票的路径（`/desktop/:seatId/t/:ticket/vnc.html`），之后
     * noVNC 自己发的那些请求（静态资源、WebSocket 升级）按相对路径解析，天然都带着票。
     * 以前是票换 cookie；为什么不再用 cookie 见文件头。
     *
     * **必须把 path 告诉 noVNC。** 它拼 WebSocket 地址的写法是 `'/' + path`，从
     * **根**开始，而 path 默认是 `websockify`——不传的话它会去连 ws://<gateway>/
     * websockify，那个路径不属于任何席位，反代认不出来直接 404。页面本身照样打得
     * 开（静态资源是相对路径），坏的只有这一条连接，而它是唯一真正要紧的那条。
     */
    const ok = verifyDesktopTicket(keys, ticket)
    if (!ok || ok.seatId !== seatId) {
      json(res, 401, { error: '桌面票无效或已过期（Gateway 验的）。回对话页重新打开这块屏' })
      return true
    }
    const base = `/desktop/${encodeURIComponent(seatId)}/t/${encodeURIComponent(ticket)}`
    const wsPath = `${base.slice(1)}/websockify`
    // 口令由票带过来（票已经验过签），这里转成 noVNC 认的 `password=`——它只从 URL
    // 或输入框读凭据，没有别的入口。代价：这一跳之后 iframe 的地址里有明文口令。
    // 换来的是「点开就是桌面」。没带口令时照旧弹输入框，不会更差。
    const query =
      `path=${encodeURIComponent(wsPath)}&autoconnect=1` +
      (ok.vnc ? `&password=${encodeURIComponent(ok.vnc)}` : '') +
      viewParams(url)
    res.writeHead(302, {
      location: `${base}/vnc.html?${query}`,
      'cache-control': 'no-store',
    })
    res.end()
    return true
  }
}

/**
 * WebSocket 升级。桌面的画面全走这条。
 *
 * 不引 ws 库：升级就是把原始 socket 接起来。用 `http.request` 发同样的升级请求，拿到
 * 上游的 `upgrade` 事件之后把两个 socket 对接，剩下的字节我们不看也不改。
 */
export function attachDesktopUpgrade(server: Server, db: Db, keys: JwtKeys) {
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Node 在 emit 'upgrade' 之前就摘掉了自己那个 error 监听，交到这儿的 socket 上一个都没有。
    // 下面要 await 查库、连上游，这中间对面一个 RST 就是没人接的 'error'——那会掀掉整个进程。
    socket.on('error', () => socket.destroy())
    const bail = (line: string) => {
      try {
        socket.write(`HTTP/1.1 ${line}\r\nconnection: close\r\n\r\n`)
      } catch {}
      socket.destroy()
    }
    void (async () => {
      // 地址解析失败（畸形的 Host、畸形的请求行）就是一条坏请求。不包起来的话它会变成
      // 一条没人接的 rejection——下面那个 IIFE 原来连 .catch 都没有，于是整个进程跟着走。
      let url: URL
      try {
        url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      } catch {
        return bail('400 Bad Request')
      }
      // 本地 Bot 的反向通道由 local-runtime.ts 接管。同一个 server 上的 upgrade 监听器
      // 会全部收到事件；这里若继续回 404，会把已经交给 ws 的 socket 当场掐掉。
      if (url.pathname === '/runtime/local-tunnel') return
      const hit = TICKET_PREFIX.exec(url.pathname)
      if (!hit) return bail('404 Not Found')
      // 票和 seatId 都从路径里来，`%` 落单时 decodeURIComponent 会抛。
      const seatId = decodeSeg(hit[1])
      if (seatId == null) return bail('400 Bad Request')
      // 票在路径里，和普通请求同一套验法（见文件头）。
      if (!seatOfTicketPath(keys, seatId, hit[2])) return bail('401 Unauthorized')
      const target = await upstreamOf(db, seatId)
      if (!target) return bail('404 Not Found')
      let up: URL
      try {
        up = new URL(target.base + upstreamPath(seatId, hit[3] || '/', url.search))
      } catch {
        return bail('502 Bad Gateway')
      }
      const headers: Record<string, string | string[]> = {}
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue
        if (k === 'host' || k === 'cookie' || k === 'authorization') continue
        headers[k] = v
      }
      headers.host = up.host
      headers['x-satuwork-machine'] = target.token
      // `connection` 在普通反代里是 hop-by-hop，要摘掉；但在升级请求里它**就是**那个
      // 把请求变成升级的头。摘了上游不会发 101，Node 也不会触发 'upgrade'，表现就是
      // 干等到超时。所以这里明确补回去。
      headers.connection = 'Upgrade'
      headers.upgrade = String(req.headers.upgrade || 'websocket')
      const upstream = httpRequest({
        protocol: up.protocol,
        hostname: up.hostname,
        port: up.port,
        method: req.method,
        path: up.pathname + up.search,
        headers,
      })
      upstream.on('upgrade', (upRes, upSocket, upHead) => {
        const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`]
        for (const [k, v] of Object.entries(upRes.headers)) {
          for (const one of Array.isArray(v) ? v : [v]) if (one !== undefined) lines.push(`${k}: ${one}`)
        }
        socket.write(lines.join('\r\n') + '\r\n\r\n')
        if (upHead?.length) socket.write(upHead)
        upSocket.pipe(socket)
        socket.pipe(upSocket)
        const shut = () => {
          upSocket.destroy()
          socket.destroy()
        }
        upSocket.on('error', shut)
        socket.on('error', shut)
        upSocket.on('close', shut)
        socket.on('close', shut)
      })
      upstream.on('response', (upRes) => bail(`${upRes.statusCode} ${upRes.statusMessage}`))
      upstream.on('error', () => bail('502 Bad Gateway'))
      if (head?.length) upstream.write(head)
      upstream.end()
      // **不能少这一句。** 上面每一步都可能抛（查库、解析地址、拼上游 URL），而这是个
      // `void` 掉的 async IIFE——没有 catch 的话那些异常就是没人接的 rejection，Node
      // 的默认行为是结束进程。manager/src/proxy.ts 里同形的那个一直有，这里漏了。
    })().catch(() => bail('500 Internal Server Error'))
  })
}
