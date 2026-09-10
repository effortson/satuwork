import { request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { createHash } from 'node:crypto'
import { json } from './http.ts'
import { seat } from './seats.ts'
import { cookieName, cookieOf, verifyTicket } from './ticket.ts'
import { verifyLogin } from './viewer.ts'
import { rosterStream } from './roster.ts'

/**
 * 反代。席位的 bot 口和 noVNC 口都只听 127.0.0.1，对外只有管家这一个端口。
 *
 * 用 `node:http` 的 request 而不是 fetch：聊天是 SSE，要的是**流**——fetch 那套在这
 * 条路径上要自己接 ReadableStream 再往 res 里倒，pipe 一行就够的事没必要绕。
 *
 * 两条路径两套鉴权，因为调用方不同：
 *
 *   /seats/:id/bot/*   Gateway 调    x-satuwork-machine: smt_
 *   /seats/:id/vnc/*   浏览器直连     Gateway 签的短期 ticket → path 限定 cookie
 *
 * bot 那条**原样透传 authorization**：bot 自己要验席位票（`sat_`），管家不掺和，
 * 所以用一个自己的头，两层互不干扰。
 */

const BOT_PREFIX = /^\/seats\/([^/]+)\/bot(\/.*)?$/
const VNC_PREFIX = /^\/seats\/([^/]+)\/vnc(\/.*)?$/
/**
 * 浏览器直连的对话流：`/seats/:id/stream/sessions/...` → bot 的 `/api/sessions/...`。
 *
 * 和 `/bot` 那条的差别只在**谁来、拿什么票**：`/bot` 是 Gateway 来的，出示 `smt_`，
 * `authorization` 原样透传；这条是浏览器来的，出示登录 JWT，管家验完换成这个席位的
 * `sat_` 再往下递（见 viewer.ts 文件头）。只放 GET、只放 `/sessions/` 底下：今天要从
 * Gateway 挪出来的只有那条小时级的 SSE 和翻历史，发消息、审批、上传仍走 Gateway——
 * 那几条在 Gateway 上带着校验（@ 点名、连接器可见性），不是纯反代。
 */
const STREAM_PREFIX = /^\/seats\/([^/]+)\/stream(\/.*)?$/
/**
 * 名单那一条通道（roster.ts）。也是浏览器带登录 JWT 直连，但它不按席位走——一个人在
 * 这台机器上的所有 Bot 合成一条流，哪些 Bot 归他由名册的 linuxUser 说了算。
 */
const ROSTER_PATH = '/roster/stream'
const STREAM_ALLOWED = /^\/sessions\/[^/]+(\/|$)/

/**
 * `sw-` + sha256(accountId) 前 12 位。**和 gateway/src/deploy.ts 的 linuxUserOf 一字不差**
 * ——名册里存的 linuxUser 就是 Gateway 按这个式子算出来的。直连时用它回答「这个席位是不是
 * 这个人的」：登录票里只有 accountId，名册里只有 linuxUser，两头靠这个式子对上。
 * 管家没有 Gateway 的库，也不该为了这一句去问。
 */
function linuxUserOf(accountId: string): string {
  return 'sw-' + createHash('sha256').update(accountId).digest('hex').slice(0, 12)
}

/**
 * 跨源的头。页面的源是 Gateway，请求打的是这台机器：浏览器要先问一句 OPTIONS，正式
 * 请求的响应上也要有 allow-origin。**只认 Gateway 那一个源**，别的源一律不给头——
 * 浏览器那头就会拦住。凭证走 `Authorization` 头而不是 cookie，所以不开 allow-credentials。
 */
function corsFor(req: IncomingMessage, gatewayUrl: string): Record<string, string> | null {
  let allowed: string
  try {
    allowed = new URL(gatewayUrl).origin
  } catch {
    return null
  }
  const origin = String(req.headers.origin || '')
  if (!origin || origin !== allowed) return null
  return {
    'access-control-allow-origin': allowed,
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'authorization, accept, last-event-id',
    'access-control-max-age': '600',
    vary: 'origin',
  }
}

/**
 * 入口 URL 上允许原样带到 noVNC 落地页的显示参数。
 *
 * Gateway 的右栏把桌面内嵌成一小块预览，那块地方只有两百来像素宽——不给
 * `resize=scale` 的话 noVNC 按 1:1 画，看到的是桌面左上角那一小角，不是这块屏。
 *
 * **白名单，不是黑名单。** `path` 和 `password` 是这条链上唯一的连接地址和唯一的
 * 凭据，两者都由票决定；放开透传等于让调用方覆盖它们。值也卡成简单 token，免得
 * 有人往落地页的 query 里塞东西。
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

export interface ProxyDeps {
  machineToken: () => string
  gatewayUrl: () => string
}

function machineTokenOk(req: IncomingMessage, expected: string): boolean {
  const given = String(req.headers['x-satuwork-machine'] || '')
  if (!expected || !given || given.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

export function pipeUpstream(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  path: string,
  headers: Record<string, string | string[]>,
  /** 盖在上游响应头上的几个（CORS 那几条）。上游没理由知道浏览器是从哪个源来的。 */
  extra: Record<string, string> = {},
) {
  const upstream = httpRequest(
    { host: '127.0.0.1', port, method: req.method, path, headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, { ...(up.headers as Record<string, string | string[]>), ...extra })
      up.pipe(res)
      /**
       * 席位半路死掉时要把下游一起拆掉。**pipe 只在干净的 end 上收尾 res**：换版就是
       * `systemctl restart`，正开着的那条 SSE 从席位那头被掐断，`up` 走的是
       * aborted/error——pipe 对这两种只 unpipe，res 就此悬着。Gateway 和浏览器于是
       * 拿着一条「看着还开着、再也不会有字节」的流干等：重连、退避、长跑全都不会
       * 触发，因为它们等的都是「断」，而「断」从来没传下去。界面上那句永远的
       * 「正在思考」就是这么来的。close 无论哪种收场都会来，末了核对一句就够。
       */
      up.on('close', () => {
        if (!res.writableEnded) res.destroy()
      })
    },
  )
  upstream.on('error', (e) => {
    if (!res.headersSent) json(res, 502, { error: '席位没有响应: ' + (e as Error).message })
    else res.end()
  })
  // 客户端先走（关标签页、Gateway 取消 SSE），上游连接不能留着。
  res.on('close', () => upstream.destroy())
  req.pipe(upstream)
}

/**
 * 落地页上补的一段样式：**关掉 noVNC 自己的控制条**。
 *
 * 和 gateway/src/desktop.ts 里那段一字不差，因为要解决的是同一件事：这块屏嵌在对话页
 * 右栏里，外面已经有自己的标题栏和「重连 / 收起」，noVNC 那条竖条于是变成两套控件
 * 叠在一起，还压着桌面右边一条。
 *
 * **为什么这里也要有一份。** 走 Gateway 反代时是 Gateway 边转发边插；而机器配了
 * `directUrl` 之后浏览器直接连管家，那一跳根本没有 Gateway，没人插这段——表现是同一
 * 块预览在两台机器上长得不一样，而配置里看不出任何区别。
 *
 * 只在**浏览器直连**那条路上插。Gateway 反代过来的请求不插：那一侧自己会插，两边都
 * 插就是两份重复的 style。判据是这次请求拿的是票/cookie 还是机器票，见下面调用点。
 */
const LANDING_CSS =
  '<style>#noVNC_control_bar_anchor{display:none!important}' +
  '#noVNC_status.noVNC_status_normal{display:none!important}</style>'

/**
 * 这块屏只准被 Gateway 的页面框进去。
 *
 * 直连之后这个源直接暴露在公网上，鉴权只剩那张五分钟的票——别人拿到票的那几分钟里，
 * 至少不该能把它嵌进自己的页面里做点什么。`frame-ancestors` 认的是源，`gatewayUrl`
 * 带着路径也不要紧，这里只取 origin。
 *
 * 取不到（还没配对、地址是空的）就退回 `'self'`：宁可把自己也框不进去，也不要发一个
 * 放开所有人的 CSP。
 */
function frameAncestorsOf(gatewayUrl: string): string {
  try {
    return `frame-ancestors ${new URL(gatewayUrl).origin}`
  } catch {
    return "frame-ancestors 'self'"
  }
}

/**
 * 落地页要改内容，所以不能像别的资源那样直接对接两个流：先收完，插一段样式，再按
 * 新长度发出去。它只有几十 KB，且一次会话只取一次。
 *
 * 请求上游时把 `accept-encoding` 摘掉：浏览器会要 gzip/br，而收进内存改字符串之前
 * 得先解压。这一页小，让上游发明文最省事。
 */
function pipeLanding(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  path: string,
  headers: Record<string, string | string[]>,
  csp: string,
) {
  delete headers['accept-encoding']
  const upstream = httpRequest({ host: '127.0.0.1', port, method: req.method, path, headers }, (up) => {
    const chunks: Buffer[] = []
    up.on('data', (c: Buffer) => chunks.push(c))
    up.on('end', () => {
      const head = { ...(up.headers as Record<string, string | string[]>) }
      // CSP 每条都钉：框不框得住这块屏和它返的是 200 还是 404 没关系。
      head['content-security-policy'] = csp
      /**
       * **只改 200 的正文**，其余原样把上游的头和字节送出去。
       *
       * 和 gateway/src/desktop.ts 那份对齐（它是 `up.statusCode !== 200` 就直接对流）。
       * 少了这道闸，一个 3xx / 404 / 500 也会被收进内存、盖上 no-store、并用重算过的
       * content-length 覆盖上游的头——对错误页和重定向而言那些头没有意义，而且同一块
       * 屏在 Gateway 反代和直连两条路上会回出不同的响应头，排查时看到的现场对不上。
       */
      if ((up.statusCode ?? 0) !== 200) {
        res.writeHead(up.statusCode ?? 502, head)
        res.end(Buffer.concat(chunks))
        return
      }
      head['cache-control'] = 'no-store'
      const type = String(head['content-type'] ?? '')
      let body = Buffer.concat(chunks)
      if (type.includes('text/html')) {
        const html = body.toString('utf8')
        const at = html.lastIndexOf('</head>')
        // 选择器对不上、或者压根没有 </head> 时什么都不做，页面照旧——不能因为
        // noVNC 换了个版本就白屏。
        if (at >= 0) body = Buffer.from(html.slice(0, at) + LANDING_CSS + html.slice(at), 'utf8')
      }
      // 改了内容就要重算长度，否则浏览器按旧长度截断。
      head['content-length'] = String(body.length)
      delete head['transfer-encoding']
      res.writeHead(up.statusCode ?? 502, head)
      res.end(body)
    })
    up.on('close', () => {
      if (!res.writableEnded) res.destroy()
    })
  })
  upstream.on('error', (e) => {
    if (!res.headersSent) json(res, 502, { error: '席位没有响应: ' + (e as Error).message })
    else res.end()
  })
  res.on('close', () => upstream.destroy())
  req.pipe(upstream)
}

export function forwardHeaders(req: IncomingMessage, port: number): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue
    // hop-by-hop 与我们自己的鉴权头不往下传；host 要换成上游的。
    if (k === 'host' || k === 'connection' || k === 'x-satuwork-machine' || k === 'cookie') continue
    headers[k] = v
  }
  headers.host = `127.0.0.1:${port}`
  return headers
}

function withCors(res: ServerResponse, status: number, body: unknown, cors: Record<string, string> | null) {
  res.writeHead(status, { ...(cors ?? {}), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * 浏览器直连的那条流（STREAM_PREFIX 的注释说了它是什么）。这里是顺序：
 *
 *   1. 预检（OPTIONS）只看源，不看票——浏览器发预检时还没带 Authorization。
 *   2. 只放 GET、只放 `/sessions/` 底下。
 *   3. 席位在不在、票对不对、**席位是不是这个人的**（linuxUserOf）。三样都对了才换票。
 *   4. 名册里没有 `sat_`（5 号协议之前部署的席位）：409，明说「重新部署后可用」。
 *      前端把任何非 2xx 当「直连不通」退回 Gateway，所以这一句主要是给 curl 的人看的。
 *
 * 状态码的分配是给前端看的：它对直连**不区分**原因，任何失败都退回 Gateway 反代五分钟
 * （见 gateway/ui/chat.js 的 directStreamBase）。所以这里不必像 Gateway 那样把 401/403/404
 * 当「答案不会变」——真的不会变的话，Gateway 那条路上会再说一次。
 */
async function streamProxy(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  seatId: string,
  rest: string,
  deps: ProxyDeps,
): Promise<void> {
  const cors = corsFor(req, deps.gatewayUrl())
  if (req.method === 'OPTIONS') {
    if (!cors) return withCors(res, 403, { error: '不认这个源' }, null)
    res.writeHead(204, cors)
    res.end()
    return
  }
  if (req.method !== 'GET') return withCors(res, 405, { error: '这条路只放 GET' }, cors)
  if (!STREAM_ALLOWED.test(rest)) return withCors(res, 404, { error: '这条路只放会话' }, cors)
  const row = seat(seatId)
  if (!row) return withCors(res, 404, { error: '没有这个席位' }, cors)
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
  if (!token) return withCors(res, 401, { error: '需要登录' }, cors)
  const viewer = await verifyLogin(token, deps.gatewayUrl())
  if (!viewer) return withCors(res, 401, { error: '登录已失效，请重新登录' }, cors)
  if (linuxUserOf(viewer.accountId) !== row.linuxUser) return withCors(res, 403, { error: '这个席位不是你的' }, cors)
  if (!row.gatewayToken) return withCors(res, 409, { error: '席位还没登记席位票，重新部署后可用' }, cors)
  const headers = forwardHeaders(req, row.botPort)
  headers.authorization = `Bearer ${row.gatewayToken}`
  pipeUpstream(req, res, row.botPort, '/api' + rest + url.search, headers, { ...(cors ?? {}), 'cache-control': 'no-store' })
}

/**
 * 名单流的门。前三道闸和 streamProxy 一样（预检、只放 GET、验登录票），过了就把这个人
 * 在本机的所有席位合成一条 SSE 交给 roster.ts。**名册里一个席位都没有也照样开流**：
 * 空流合法（刚删完最后一个 Bot 的那一刻就是），前端只是收不到帧；回 404 的话前端会当
 * 「直连不通」退回 Gateway 五分钟，白绕一圈。
 */
async function rosterProxy(req: IncomingMessage, res: ServerResponse, deps: ProxyDeps): Promise<void> {
  const cors = corsFor(req, deps.gatewayUrl())
  if (req.method === 'OPTIONS') {
    if (!cors) return withCors(res, 403, { error: '不认这个源' }, null)
    res.writeHead(204, cors)
    res.end()
    return
  }
  if (req.method !== 'GET') return withCors(res, 405, { error: '这条路只放 GET' }, cors)
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
  if (!token) return withCors(res, 401, { error: '需要登录' }, cors)
  const viewer = await verifyLogin(token, deps.gatewayUrl())
  if (!viewer) return withCors(res, 401, { error: '登录已失效，请重新登录' }, cors)
  await rosterStream(req, res, linuxUserOf(viewer.accountId), cors ?? {})
}

/** 注册到 Router.intercept。返回 true 表示这个请求已经被反代接管。 */
export function proxyIntercept(deps: ProxyDeps) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const stream = STREAM_PREFIX.exec(url.pathname)
    if (stream) {
      await streamProxy(req, res, url, stream[1], stream[2] || '/', deps)
      return true
    }
    if (url.pathname === ROSTER_PATH) {
      await rosterProxy(req, res, deps)
      return true
    }

    const bot = BOT_PREFIX.exec(url.pathname)
    if (bot) {
      const row = seat(bot[1])
      if (!machineTokenOk(req, deps.machineToken())) {
        json(res, 401, { error: '无效的机器凭证' })
        return true
      }
      if (!row) {
        json(res, 404, { error: '没有这个席位' })
        return true
      }
      pipeUpstream(req, res, row.botPort, (bot[2] || '/') + url.search, forwardHeaders(req, row.botPort))
      return true
    }

    const vnc = VNC_PREFIX.exec(url.pathname)
    if (!vnc) return false
    const seatId = vnc[1]
    const row = seat(seatId)
    if (!row) {
      json(res, 404, { error: '没有这个席位' })
      return true
    }
    const rest = vnc[2] || '/'
    /**
     * Gateway 反代过来的那条路：认机器票，和 `/bot` 那条一模一样。
     *
     * 桌面现在是 Gateway 同域的 `/desktop/:seatId/*` 反代过来的（见
     * gateway/src/desktop.ts）——那一侧没有、也不该有这块屏的 cookie，它手里只有
     * 机器票。**这一支要放在票/cookie 前面**：Gateway 不会带 ticket，也不会带
     * cookie，落到下面就是一句 401。
     *
     * 浏览器直连那条路没变，下面原样留着：管理员从后台点进来还走它。
     */
    if (machineTokenOk(req, deps.machineToken())) {
      pipeUpstream(req, res, row.novncPort, rest + url.search, forwardHeaders(req, row.novncPort))
      return true
    }
    const ticket = url.searchParams.get('ticket')
    if (ticket) {
      // 入口带票 → 换成一张 path 限定的 cookie 再跳转。之后 noVNC 自己发的那些请求
      // （静态资源、WebSocket 升级）就不用把票挂在 URL 上到处跑了。
      const ok = await verifyTicket(ticket, deps.gatewayUrl())
      if (!ok || ok.seatId !== seatId) {
        json(res, 401, { error: '桌面票无效或已过期' })
        return true
      }
      const base = `/seats/${encodeURIComponent(seatId)}/vnc`
      const maxAge = Math.max(60, ok.exp - Math.floor(Date.now() / 1000))
      // **必须把 path 告诉 noVNC。** 它拼 WebSocket 地址的写法是 `'/' + path`，从
      // **根**开始，而 path 默认就是 `websockify`——也就是说，不传的话它会去连
      // ws://<管家>/websockify。那个路径不属于任何席位，反代认不出来直接 404，
      // 浏览器上的表现就是页面打得开、一按 Connect 弹「Failed to connect to server」。
      //
      // 席位的静态资源是相对路径，所以页面本身一直是好的——坏的只有这一条连接，
      // 而它恰好是唯一真正要紧的那条。
      //
      // autoconnect：这个入口是从 Gateway 上点「打开桌面」进来的，意图就是看桌面，
      // 不是打开一个还要再按一次 Connect 的页面。VNC 口令仍然要人自己输。
      const wsPath = `${base.slice(1)}/websockify`
      // 口令由 Gateway 签在票里带过来（票已经验过签了），这里转成 noVNC 认的
      // `password=` 参数——它只从 URL 或输入框读凭据，没有别的入口。
      //
      // **代价说清楚**：这一跳之后浏览器地址栏里会有明文口令，也会进历史记录。
      // 换来的是「点开就是桌面」。没带口令时照旧弹输入框，不会更差。
      const query =
        `path=${encodeURIComponent(wsPath)}&autoconnect=1` +
        (ok.vnc ? `&password=${encodeURIComponent(ok.vnc)}` : '') +
        viewParams(url)
      res.writeHead(302, {
        'set-cookie': `${cookieName(seatId)}=${encodeURIComponent(ticket)}; Path=${base}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`,
        location: `${base}/vnc.html?${query}`,
        'cache-control': 'no-store',
      })
      res.end()
      return true
    }
    const fromCookie = cookieOf(req, cookieName(seatId))
    const okCookie = fromCookie ? await verifyTicket(fromCookie, deps.gatewayUrl()) : undefined
    if (!okCookie || okCookie.seatId !== seatId) {
      json(res, 401, { error: '桌面票无效或已过期' })
      return true
    }
    /**
     * 到这儿说明是**浏览器直连**（认的是票换来的 cookie，不是机器票）。落地页要插那段
     * 关控制条的样式——这一跳没有 Gateway，没人替我们插。
     *
     * 只认落地页那一条路径：别的资源（app/ui.js、locale JSON、那条 WebSocket）一律
     * 原样对流，改写它们既没意义又要把整个文件收进内存。
     */
    const csp = frameAncestorsOf(deps.gatewayUrl())
    if (rest === '/vnc.html' || rest === '/' || rest === '/index.html') {
      pipeLanding(req, res, row.novncPort, rest + url.search, forwardHeaders(req, row.novncPort), csp)
      return true
    }
    pipeUpstream(req, res, row.novncPort, rest + url.search, forwardHeaders(req, row.novncPort))
    return true
  }
}

/**
 * WebSocket 升级。noVNC 的画面全走这条。
 *
 * 不引 ws 库：升级就是把原始 socket 接起来。用 `http.request` 发同样的升级请求，
 * 拿到上游的 `upgrade` 事件之后把两个 socket 对接，剩下的字节我们不看也不改。
 */
export function attachUpgrade(server: Server, deps: ProxyDeps) {
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const bail = (line: string) => {
      try {
        socket.write(`HTTP/1.1 ${line}\r\nconnection: close\r\n\r\n`)
      } catch {}
      socket.destroy()
    }
    void (async () => {
      // 畸形的 Host 会让它抛。下面那个 .catch 接得住（不会像 gateway 那边一样掀掉进程），
      // 但回一句 500 是误导——这是条坏请求，不是我们出错。
      let url: URL
      try {
        url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      } catch {
        return bail('400 Bad Request')
      }
      const vnc = VNC_PREFIX.exec(url.pathname)
      if (!vnc) return bail('404 Not Found')
      const seatId = vnc[1]
      const row = seat(seatId)
      if (!row) return bail('404 Not Found')
      // 同上：Gateway 反代过来的升级请求带的是机器票，没有 cookie。
      if (!machineTokenOk(req, deps.machineToken())) {
        const token = cookieOf(req, cookieName(seatId))
        const ok = token ? await verifyTicket(token, deps.gatewayUrl()) : undefined
        if (!ok || ok.seatId !== seatId) return bail('401 Unauthorized')
      }

      // `connection` 在普通反代里是 hop-by-hop，要摘掉；但在升级请求里它**就是**
      // 那个把请求变成升级的头。摘了上游不会发 101，Node 的客户端也不会触发
      // 'upgrade' 事件，表现就是干等到超时。所以这里补回去。
      const headers = forwardHeaders(req, row.novncPort)
      headers.connection = 'Upgrade'
      headers.upgrade = String(req.headers.upgrade || 'websocket')
      const upstream = httpRequest({
        host: '127.0.0.1',
        port: row.novncPort,
        method: req.method,
        path: (vnc[2] || '/') + url.search,
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
      upstream.on('error', () => bail('502 Bad Gateway'))
      // 上游没升级、回了一个普通响应（websockify 没起来时前面顶着的东西、404、5xx）：
      // 不接这个事件的话 Node 会把 upstream 当普通请求收完，而浏览器那头的 socket 一直
      // 悬着，直到它自己超时。给它一句 502 然后关掉，noVNC 才会立刻显示连不上。
      upstream.on('response', (upRes) => {
        upRes.resume()
        upstream.destroy()
        bail('502 Bad Gateway')
      })
      // 有些客户端把第一帧和升级请求粘在一起发，那段字节在 head 里，不转就丢了。
      if (head?.length) upstream.write(head)
      upstream.end()
    })().catch(() => bail('500 Internal Server Error'))
  })
}
