import { createReadStream, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

export type Req = IncomingMessage & {
  params: Record<string, string>
  query: URLSearchParams
  body: unknown
}

export type Handler = (req: Req, res: ServerResponse) => Promise<void> | void

/**
 * 每一条响应都带的那几个头。
 *
 * `nosniff` 是这里面唯一一个对 JSON 也要紧的：没有它，一条 `content-type` 被中间层
 * 抹掉或者被老浏览器猜错的响应，会拿正文当 HTML 解释——而这套接口的正文里装着模型
 * 输出和工具结果。`no-referrer` 是因为桌面直连那条路把票放在 URL 里（novncUrlOf 拼的
 * `?ticket=`），不关掉 Referer 的话，页面里任何一个外链都会把它捎给对面。
 */
const BASE_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}

export function json(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    ...BASE_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(data)
}

export function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization
  if (!h?.startsWith('Bearer ')) return
  const token = h.slice(7).trim()
  return token || undefined
}

/**
 * 「客户端还在不在」。**看 res 的 close，不看 req 的。**
 *
 * 路由器交给处理器之前已经把请求体读完了（readBody），而 Node 16 起请求体一读完，req
 * 自己就发过 close 了——之后再挂的 `req.on('close')` 在客户端断开时**一次都不会响**
 * （Node 24 上实测）。`/v1` 的两条流以前就挂在它上面，于是「客户端一走就停」从来没生效
 * 过：人关了标签页，上游照样整段生成完，钱照付。
 *
 * 分得清「对面走了」的是 res：它的 close 来的时候我们自己还没 end 过，那就是对面先断的。
 * 同一件事管家那边修过一次（manager/src/llm-relay.ts 的 watchClient）。
 *
 * 挂之前就已经断了的也要认（`res.destroyed`）：处理器在打上游之前还要查库、过闸、登记。
 * GET 这类没读请求体的路由不受那个坑影响，但用这一份也一样对。
 */
export interface ClientWatch {
  /** 客户端走了就 abort。可以直接交给 fetch / pi-ai。 */
  readonly signal: AbortSignal
  gone(): boolean
  /** 每条出口都要调，否则就是在 res 上攒监听器。 */
  release(): void
}

export function watchClient(res: ServerResponse, onGone?: () => void): ClientWatch {
  const ac = new AbortController()
  const mark = () => {
    if (ac.signal.aborted) return
    ac.abort(new Error('client closed'))
    onGone?.()
  }
  // 我们自己 end 之后也会来一次 close，那一次不算「对面走了」。
  const onClose = () => {
    if (!res.writableEnded) mark()
  }
  res.on('close', onClose)
  if (res.destroyed && !res.writableEnded) mark()
  return {
    signal: ac.signal,
    gone: () => ac.signal.aborted,
    release: () => {
      res.off('close', onClose)
    },
  }
}

const BODY_LIMIT = 8_000_000

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let n = 0
  for await (const chunk of req) {
    n += (chunk as Buffer).length
    if (n > BODY_LIMIT) throw new HttpError(413, '请求体太大')
    chunks.push(chunk as Buffer)
  }
  if (!chunks.length) return undefined
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'JSON 解析失败')
  }
}

/** 拦截器。返回 true 表示这个请求已经被接管（桌面反代走这条）。 */
export type Intercept = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean> | boolean

interface Route {
  method: string
  parts: string[]
  handler: Handler
  /** true 时不读也不解析 body，处理器自己拿 `req` 当流用（上传发布包走这条）。 */
  raw: boolean
}

/**
 * 百分号解码，坏了就当没这条路由。
 *
 * `decodeURIComponent('%zz')` 抛的是 URIError。原来它裸着写在 match 里，于是
 * `GET /orgs/%zz` 会一路穿到 handle 的 catch，变成一句 500 `internal error`
 * 外加一条完整的栈打进 stderr——一条谁都发得出的请求，既刷日志又把真正的 500
 * 淹在噪声里。解不开的段不可能等于任何一个真实 id，返回 null 让它落到 404。
 */
function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

function match(parts: string[], path: string): Record<string, string> | null {
  const segs = path.split('/').filter(Boolean)
  if (parts.length !== segs.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p.startsWith(':')) {
      const value = decodeSegment(segs[i])
      if (value == null) return null
      params[p.slice(1)] = value
    } else if (p !== segs[i]) return null
  }
  return params
}

// 打成一个文件部署到函数环境时 import.meta.url 指的是那个包，`../ui` 就不对了；由环境变量指过去。
const UI_DIR = process.env.GATEWAY_UI_DIR ? resolve(process.env.GATEWAY_UI_DIR) : resolve(fileURLToPath(new URL('../ui', import.meta.url)))

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
}

const SPA_PATHS = new Set(['/', '/login', '/privacy', '/terms', '/download', '/index.html', '/ui', '/ui/', '/models', '/providers', '/company', '/accounts', '/audit', '/companies', '/users', '/plans', '/orders', '/stats', '/tools', '/costs', '/billing', '/usage', '/catalog', '/profile', '/bots', '/skills', '/chat', '/releases', '/machines', '/connectors', '/handoffs', '/channels'])
// 前端脚本拆成了一串（见 gateway/ui/index.html 里那组 data-app-part），
// 加一个新的分片就要在这里也加一行，否则线上直接 404，而本地跑 index.html 是好的。
const UI_PARTS = ['prefs.js', 'state.js', 'data.js', 'shell.js', 'pages-landing.js', 'pages-legal.js', 'pages-download.js', 'pages-admin.js', 'pages-audit.js', 'pages-machines.js', 'pages-account.js', 'pages-bots.js', 'pages-tools.js', 'pages-connectors.js', 'pages-routines.js', 'pages-handoffs.js', 'pages-channels.js', 'chat.js', 'render.js', 'app.js']
const ROOT_FILES = new Set(['theme.css', 'shell.css', 'app.css', 'chat.css', ...UI_PARTS, 'i18n.js', 'markdown.js', 'channel-preview.js', 'index.html', 'unzip.js'])

/**
 * 按需加载的那三个库（KaTeX / highlight.js / Mermaid）从哪儿来。
 *
 * **要和 `gateway/ui/markdown.js` 的 `window.SATU_CDN` 指同一处**：那边换了镜像而这里
 * 没换，CSP 会把脚本挡掉，表现是公式和图静默不渲染——而那正是它「拉不到就退回纯文本」
 * 的降级路径，看上去像 CDN 慢，不像配错了。所以两边共用这一个环境变量。
 */
const UI_CDN = (process.env.GATEWAY_UI_CDN || 'https://cdn.jsdelivr.net').trim().replace(/\/+$/, '')

/**
 * 界面字体（`gateway/ui/theme.css` 顶上那句 `@import`）。样式表从 googleapis 来，
 * 字体文件本身从 gstatic 来——**两个源都要**，少一个的表现是字体静默退回系统默认。
 */
const FONT_CSS = 'https://fonts.googleapis.com'
const FONT_FILES = 'https://fonts.gstatic.com'

/**
 * Gateway 自己的页面是不是 http。**只认明确配过的 GATEWAY_PUBLIC_URL**——没配时那个值
 * 是按请求的 Host 猜的（见 lib/machines.ts 的 gatewayBaseFor），拿一个转发头决定安不安全
 * 不划算。
 *
 * 两处共用同一个判据：这里放宽 CSP，`lib/machines.ts` 的 `directUrlOf` 放宽直连地址的
 * https 强制。**分开写迟早分叉**，而分叉的表现最难查——地址存得进去，浏览器里却是一句
 * CSP 拒绝。
 */
export function gatewayPageIsHttp(): boolean {
  const explicit = (process.env.GATEWAY_PUBLIC_URL || '').trim()
  if (!explicit) return false
  try {
    return new URL(explicit).protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * 直连（对话流、桌面 iframe）允许打到哪些源。生产上是整个 `https:`；Gateway 自己跑在
 * http 上时（本地开发）再加 `http:`，否则 directUrlOf 收下的 http 直连地址会在浏览器里
 * 被这条头拒掉，而 Gateway 已经没有反代退路。
 */
const DIRECT_SRC = gatewayPageIsHttp() ? 'https: http:' : 'https:'

/**
 * 管理界面这一页的 CSP。
 *
 * 这套界面渲染的是**模型输出和工具结果**——等同于外部输入。markdown.js 那一层已经
 * 转义、白名单协议、mermaid 走 `securityLevel: 'strict'`，但它是唯一一道防线；漏一处
 * 就直接换来登录 JWT（存在 sessionStorage / localStorage 里）。这条头是第二道。
 *
 * 几处刻意的松：
 *
 * - `style-src 'unsafe-inline'`：界面里有几十处 `style="…"` 属性，收紧要动的是排版，
 *   而内联样式换不出脚本执行。
 * - `img-src https: http:`：模型写得出任意图片地址，markdown 的 safeUrl 明确放行了
 *   `https?://`。收紧等于把「贴一张图」这件事废掉。
 * - `frame-src blob:`：文件预览把字节做成 blob 再喂给 iframe（chat.js 的 previewBody）。
 * - `connect-src https:` 与 `frame-src https:`：席位机器配了 `directUrl` 之后，对话那条 SSE
 *   （chat.js 的 directStreamBase）和桌面那块 iframe（novncUrlOf）都直接打机器的域名，
 *   不再经 Gateway。机器地址按公司各不相同、随时会加，写不进一条静态的头；而直连的
 *   前提本来就是 https（见 docs/gateway-runtime.md §7），所以放的是整个 https:。**只有
 *   Gateway 自己跑在 http 上时才另外加 http:**（见 DIRECT_SRC）：那时页面本身就是 http，
 *   混合内容无从谈起，而管家只监听明文 http，不放的话本地怎么配都连不上直连那条流。这两条放开不等于放开外泄：能发请求的脚本仍然只有 `script-src 'self'` 放进来的
 *   那几份。**只写 `'self'` 的话，直连在浏览器里是一句 CSP 拒绝——而 Gateway 已经没有
 *   反代退路，对话流和桌面就此全黑，日志里还一个字都没有。**
 *
 * 一处刻意的紧：**`script-src` 不带 `'unsafe-inline'`**。为此 index.html 里那段内联
 * module 搬进了 `ui/unzip.js` 的末尾，四处 `onload=` / `onerror=` 内联处理器换成了
 * `data-onload` / `data-onerror` 加一个委派监听（`ui/shell.js` 的 mediaFallback）。
 * 加回 `'unsafe-inline'` 的话这条头对 XSS 就只剩装饰作用了——真要加，先想清楚它还
 * 挡得住什么。e2e 的 connectors 那一组有一条按源码扫内联脚本的用例守着这件事。
 */
const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  `script-src 'self' ${UI_CDN}`,
  `style-src 'self' 'unsafe-inline' ${UI_CDN} ${FONT_CSS}`,
  `font-src 'self' data: ${UI_CDN} ${FONT_FILES}`,
  "img-src 'self' data: blob: https: http:",
  "media-src 'self' data: blob:",
  // http://127.0.0.1:* 是桌面端里的本地 Bot（ui/data.js 的 localRoute）：那一条和 directUrl
  // 无关，生产上也要有，所以单列着——DIRECT_SRC 只在本地开发时才带 http:。
  `connect-src 'self' ${DIRECT_SRC} http://127.0.0.1:*`,
  `frame-src 'self' blob: ${DIRECT_SRC}`,
  "worker-src 'self' blob:",
].join('; ')

/**
 * 跨源来的界面：桌面端把 gateway/ui 打进了包里，页面的源是 satu://localhost（Windows 上是
 * http://satu.localhost），所有 API 请求都是跨源的。只对这几个源开，外加 GATEWAY_CORS_ORIGINS
 * 里逗号分隔的（预览环境、别的壳）。凭据走 Authorization 头不走 cookie，不开 allow-credentials。
 * 别的源一律不给头，浏览器那头就会拦住——放开 `*` 的话，任何网页里的脚本拿着偷来的票都能打。
 */
const CORS_ORIGINS = new Set(
  ['satu://localhost', 'http://satu.localhost', 'tauri://localhost', 'http://tauri.localhost']
    .concat((process.env.GATEWAY_CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)),
)

function corsHeaders(req: IncomingMessage): Record<string, string> | null {
  const origin = String(req.headers.origin || '')
  if (!origin || !CORS_ORIGINS.has(origin)) return null
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, accept, x-filename, x-api-key, last-event-id',
    'access-control-expose-headers': 'content-type, content-disposition',
    'access-control-max-age': '600',
    vary: 'origin',
  }
}

/** GET / 与各管理屏、GET /ui/*、/theme.css、/assets/* 从 gateway/ui 出。路径不得逃出该目录。 */
function serveUi(pathname: string, res: ServerResponse): boolean {
  let rel: string | null = ''
  if (SPA_PATHS.has(pathname) || pathname.startsWith('/join/') || pathname.startsWith('/bots/') || pathname.startsWith('/connectors/') || pathname.startsWith('/companies/') || pathname.startsWith('/users/') || pathname.startsWith('/machines/') || pathname.startsWith('/audit') || pathname.startsWith('/a/')) rel = 'index.html'
  // 解不开的百分号不是路径，是坏请求：返回 null 让它落到 404，别抛进 handle 的 catch
  // 变成一句 500（同 match 里那道 decodeSegment）。
  else if (pathname.startsWith('/ui/')) rel = decodeSegment(pathname.slice('/ui/'.length))
  else if (pathname.startsWith('/assets/')) rel = decodeSegment(pathname.slice(1))
  else if (pathname.startsWith('/') && ROOT_FILES.has(pathname.slice(1))) rel = pathname.slice(1)
  else return false
  if (!rel || rel.includes('\0')) return false
  const file = resolve(UI_DIR, rel)
  const root = UI_DIR.endsWith(sep) ? UI_DIR : UI_DIR + sep
  if (file !== UI_DIR && !file.startsWith(root)) return false
  try {
    if (!statSync(file).isFile()) return false
  } catch {
    return false
  }
  const ext = extname(file).toLowerCase()
  const type = MIME[ext] ?? 'application/octet-stream'
  res.writeHead(200, {
    ...BASE_HEADERS,
    'content-type': type,
    'cache-control': 'no-store',
    // CSP 只挂在网页本身上：脚本和样式是被这一页加载的，约束它们的是这一页的策略。
    ...(ext === '.html' ? { 'content-security-policy': CSP } : {}),
  })
  createReadStream(file).pipe(res)
  return true
}

/**
 * 这次 GET 是在拿一张网页，还是在调 JSON API。
 *
 * `/channels` 这类地址两边都要用：浏览器刷新要 index.html，前端的 api()
 * 则要同名 JSON。浏览器顶层导航会明确带 `text/html`，api() 也明确带
 * `application/json`，用这句话分流就不需要给其中一边改一套公开 URL。
 *
 * 不把通配 Accept 当 HTML：脚本、curl 和旧客户端不表态时继续按 API 处理，避免一次前端
 * 路由新增就静默改变已有接口的返回类型。
 */
function acceptsHtml(req: IncomingMessage): boolean {
  const raw = req.headers.accept
  if (typeof raw !== 'string') return false
  return raw.split(',').some((part) => part.split(';', 1)[0].trim().toLowerCase() === 'text/html')
}

/**
 * 很小的路由器。路径按段精确匹配，`:id` 是参数。先注册的先中——所以更具体的
 * 路径要写在带参数的前面（`/orgs/:id/sessions/:sessionId` 和 `/orgs/:id/sessions`
 * 段数不同，互不抢）。未命中时 GET / 与 GET /ui/* 走静态管理页。
 */
export class Router {
  private routes: Route[] = []
  private intercepts: Intercept[] = []

  on(method: string, path: string, handler: Handler, raw = false) {
    this.routes.push({ method, parts: path.split('/').filter(Boolean), handler, raw })
  }

  get(path: string, handler: Handler) {
    this.on('GET', path, handler)
  }
  post(path: string, handler: Handler) {
    this.on('POST', path, handler)
  }
  put(path: string, handler: Handler) {
    this.on('PUT', path, handler)
  }
  /** PUT 二进制体：body 不进内存、不当 JSON 解析，处理器直接消费 `req`。 */
  putRaw(path: string, handler: Handler) {
    this.on('PUT', path, handler, true)
  }
  /** POST 二进制体：同上。附件上传走这条——8 MB 的 JSON 上限对文件没有意义。 */
  postRaw(path: string, handler: Handler) {
    this.on('POST', path, handler, true)
  }
  patch(path: string, handler: Handler) {
    this.on('PATCH', path, handler)
  }
  delete(path: string, handler: Handler) {
    this.on('DELETE', path, handler)
  }

  /** 反代注册在这儿：它要拿原始 req 当流用，不能让路由器先把 body 读掉。 */
  intercept(fn: Intercept) {
    this.intercepts.push(fn)
  }

  async handle(raw: IncomingMessage, res: ServerResponse) {
    const method = (raw.method ?? 'GET').toUpperCase()
    /**
     * **解析地址这一步必须在 try 里面。**
     *
     * `new URL()` 对畸形的 Host（`Host: [`）或畸形的请求行会抛 TypeError，而这两行
     * 原来在 try 之外。handle 是 async、调用方是 `void router.handle(...)`，于是那个
     * 异常变成一条没人接的 unhandled rejection——Node 的默认行为是**当场结束进程**。
     * 也就是说一条不需要登录的 TCP 请求就能把 Gateway 打停，而且能一直打。
     *
     * 地址读不出来就是一条坏请求，回 400；listen 那头另有一道进程级兜底。
     */
    let url: URL
    try {
      url = new URL(raw.url ?? '/', `http://${raw.headers.host ?? '127.0.0.1'}`)
    } catch {
      json(res, 400, { error: 'bad request' })
      return
    }
    try {
      // 跨源的界面（桌面端）：头先挂上，预检直接答。routes 里的 writeHead 会保留这里 setHeader 的。
      const cors = corsHeaders(raw)
      if (cors) {
        for (const [k, v] of Object.entries(cors)) res.setHeader(k, v)
        if (method === 'OPTIONS') {
          res.writeHead(204)
          res.end()
          return
        }
      }
      for (const fn of this.intercepts) {
        if (await fn(raw, res, url)) return
      }
      /**
       * 页面导航要在同名 API 之前认领。
       *
       * 原来静态页只在所有 API 都没命中之后才试；`GET /channels` 已经被渠道 API 命中，
       * 所以站内点过去正常（没有整页请求），一刷新却直接拿到 `{"error":"需要登录"}`。
       * 只提前处理明确要 HTML 的请求，JSON API 的鉴权和行为都保持原样。
       */
      if ((method === 'GET' || method === 'HEAD') && acceptsHtml(raw) && serveUi(url.pathname, res)) return
      for (const route of this.routes) {
        if (route.method !== method) continue
        const params = match(route.parts, url.pathname)
        if (!params) continue
        const req = raw as Req
        req.params = params
        req.query = url.searchParams
        const skipBody = route.raw || method === 'GET' || method === 'HEAD' || method === 'DELETE'
        req.body = skipBody ? undefined : await readBody(raw)
        await route.handler(req, res)
        if (!res.writableEnded) json(res, 204, null)
        return
      }
      if ((method === 'GET' || method === 'HEAD') && serveUi(url.pathname, res)) return
      json(res, 404, { error: 'unknown endpoint', path: url.pathname })
    } catch (e) {
      if (res.headersSent) {
        try { res.end() } catch {}
        return
      }
      if (e instanceof HttpError) {
        json(res, e.status, { error: e.message, ...e.extra })
        return
      }
      const err = e as Error
      console.error(`satuwork-gateway: ${err.stack ?? err.message}`)
      json(res, 500, { error: 'internal error' })
    }
  }
}

export function listen(router: Router) {
  const host = process.env.GATEWAY_HOST ?? '127.0.0.1'
  const port = Number(process.env.GATEWAY_PORT ?? 3080)
  const server = createServer((req, res) => {
    void router.handle(req, res)
  })
  server.listen(port, host, () => {
    console.log(`satuwork-gateway: 听在 http://${host}:${port}`)
  })
  return server
}
