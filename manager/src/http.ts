import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

/**
 * 极小路由器。
 *
 * **不复用 gateway/src/http.ts**：那份的 `listen()` 写死 `GATEWAY_HOST`/`GATEWAY_PORT`，
 * `Router.handle` 的兜底 `serveUi` 写死 `gateway/ui` 目录，错误日志写死 Gateway 前缀；
 * 而且 gateway 包没有 `exports`，第三个包 import 不到。管家只有几条路由，抄一份比抽
 * 公共包动的地方少。
 */

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

/** 请求进来先过它。返回 true 表示已经接管（反代走这条，不进路由器）。 */
export type Intercept = (req: IncomingMessage, res: ServerResponse, url: URL) => boolean | Promise<boolean>

export function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * `Authorization: Bearer xxx` 里的那个 xxx。没有这个前缀就当没带票。
 *
 * **大小写不敏感**：写头的不只有我们自己的代码——OpenAI/Anthropic 的各家 SDK、curl 的
 * 抄写、桌面端，都可能发 `bearer`。RFC 7235 说这个 scheme 本来就是不区分大小写的，
 * 按字面只认 `Bearer ` 的话，那种请求会变成一句「需要登录」，没人能从消息里看出差在哪。
 */
export function bearer(req: IncomingMessage): string {
  const h = String(req.headers.authorization || '')
  if (!/^Bearer\s+/i.test(h)) return ''
  return h.replace(/^Bearer\s+/i, '').trim()
}

/**
 * 只收本机的连接。工人中继（relay.ts）、模型中继（llm-relay.ts）共用一份。
 *
 * **带转发头的一律不算本机**：机器前面常挂一层反代（Caddy 把 `https://<域名>` 反到
 * `127.0.0.1:8443`，好给管家地址和桌面直连地址配 https），代理转进来的外部请求在 socket
 * 上的源地址也是 127.0.0.1，光看 remoteAddress 会把整个公网当成本机。本机的 Bot 和
 * 席位工人都是直连 `127.0.0.1:端口`，从来不带 `x-forwarded-for` / `forwarded` /
 * `x-real-ip`；反代则几乎都会加其中一个（Caddy、nginx 的常见配法、各家负载均衡）。
 * 这两处本来还要验票，这里是纵深防御——别让「反代配置漏挡一条路」直接变成「只剩一张票」。
 */
export function isLoopback(req: IncomingMessage): boolean {
  const h = req.headers
  if (h['x-forwarded-for'] !== undefined || h.forwarded !== undefined || h['x-real-ip'] !== undefined) return false
  const a = req.socket.remoteAddress || ''
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
}

/**
 * 定长比较两张票。**不早退**：`a === b` 会在第一个不同的字节上返回，比较耗时随对上的
 * 前缀长度变化，拿它去猜密钥是成熟手法。长度不同直接算不对（长度本来就藏不住）。
 */
export function sameToken(given: string, expected: string): boolean {
  if (!expected || !given || given.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

/**
 * 读整个请求体，**上限之外的字节不进内存**：超了就地放手，回 undefined，由调用方决定
 * 是 413 还是别的说法。
 *
 * 一份供三条路用（路由器、工人中继、模型中继），因为它们各自抄过一遍、三个上限、三种
 * 溢出行为，其中一份干脆没有上限——一条超大 body 就能把管家撑爆，而管家是这台机器上
 * 所有席位的控制面。
 */
export function readRaw(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let n = 0
    let tooBig = false
    req.on('data', (c: Buffer) => {
      if (tooBig) return
      n += c.length
      if (n > limit) {
        tooBig = true
        chunks.length = 0
        resolve(undefined)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!tooBig) resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

const BODY_LIMIT = 4_000_000

async function readBody(req: IncomingMessage): Promise<unknown> {
  const buf = await readRaw(req, BODY_LIMIT)
  if (!buf) throw new HttpError(413, 'request body too large')
  const raw = buf.toString('utf8').trim()
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'malformed JSON')
  }
}

interface Route {
  method: string
  parts: string[]
  handler: Handler
}

/** 同 gateway：`%zz` 解不开时不抛，让这条路由不匹配，落到 404 而不是 500。 */
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

export class Router {
  private routes: Route[] = []
  private intercepts: Intercept[] = []

  on(method: string, path: string, handler: Handler) {
    this.routes.push({ method, parts: path.split('/').filter(Boolean), handler })
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
     * **解析地址这一步要在 try 里面**（同 gateway/src/http.ts 那一处）。
     *
     * 畸形的 Host（`Host: [`）会让 `new URL` 抛 TypeError，而 handle 是 async、调用方
     * 是 `void router.handle(...)`——异常变成没人接的 rejection，Node 默认直接结束进程。
     * 管家是那台机器上所有席位的控制面，被一条 TCP 请求打停的代价比 Gateway 还高。
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
      for (const route of this.routes) {
        if (route.method !== method) continue
        const params = match(route.parts, url.pathname)
        if (!params) continue
        const req = raw as Req
        req.params = params
        req.query = url.searchParams
        req.body = method === 'GET' || method === 'HEAD' || method === 'DELETE' ? undefined : await readBody(raw)
        await route.handler(req, res)
        if (!res.writableEnded) json(res, 204, null)
        return
      }
      json(res, 404, { error: 'unknown endpoint', path: url.pathname })
    } catch (e) {
      if (res.headersSent) {
        try {
          res.end()
        } catch {}
        return
      }
      if (e instanceof HttpError) {
        json(res, e.status, { error: e.message, ...e.extra })
        return
      }
      const err = e as Error
      console.error(`satuwork-manager: ${err.stack ?? err.message}`)
      json(res, 500, { error: 'internal error' })
    }
  }
}

export function listen(router: Router, host: string, port: number): Server {
  const server = createServer((req, res) => {
    void router.handle(req, res)
  })
  server.listen(port, host, () => {
    console.log(`satuwork-manager: listening on http://${host}:${port}`)
  })
  return server
}
