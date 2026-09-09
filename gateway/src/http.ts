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

export function json(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
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

const UI_DIR = resolve(fileURLToPath(new URL('../ui', import.meta.url)))

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

const SPA_PATHS = new Set(['/', '/index.html', '/ui', '/ui/', '/models', '/providers', '/company', '/accounts', '/audit', '/companies', '/users', '/plans', '/orders', '/stats', '/tools', '/costs', '/billing', '/usage', '/catalog', '/profile', '/bots', '/skills', '/chat', '/releases', '/machines', '/connectors', '/handoffs', '/channels'])
// 前端脚本拆成了一串（见 gateway/ui/index.html 里那组 data-app-part），
// 加一个新的分片就要在这里也加一行，否则线上直接 404，而本地跑 index.html 是好的。
const UI_PARTS = ['prefs.js', 'state.js', 'data.js', 'shell.js', 'pages-admin.js', 'pages-audit.js', 'pages-machines.js', 'pages-account.js', 'pages-bots.js', 'pages-tools.js', 'pages-connectors.js', 'pages-routines.js', 'pages-handoffs.js', 'pages-channels.js', 'chat.js', 'render.js', 'app.js']
const ROOT_FILES = new Set(['theme.css', 'shell.css', 'app.css', 'chat.css', ...UI_PARTS, 'i18n.js', 'markdown.js', 'channel-preview.js', 'index.html', 'unzip.js'])

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
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
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
