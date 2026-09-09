import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import type { Db } from './db.ts'

type Wire =
  | { type: 'auth'; token: string; botId: string }
  | { type: 'ready' }
  | { type: 'request'; id: string; method: string; path: string; headers: Record<string, string> }
  | { type: 'request/chunk'; id: string; data: string }
  | { type: 'request/end'; id: string }
  | { type: 'response'; id: string; status: number; headers: Record<string, string> }
  | { type: 'response/chunk'; id: string; data: string }
  | { type: 'response/end'; id: string }
  | { type: 'response/error'; id: string; error: string }

interface Pending {
  resolve: (response: Response) => void
  reject: (error: Error) => void
  controller?: ReadableStreamDefaultController<Uint8Array>
}

const sockets = new Map<string, LocalRuntime>()
const keyOf = (accountId: string, botId: string) => `${accountId}:${botId}`

function json(raw: WebSocket.RawData): Wire | null {
  try {
    return JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')) as Wire
  } catch {
    return null
  }
}

function send(ws: WebSocket, message: Wire) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
}

class LocalRuntime {
  private pending = new Map<string, Pending>()

  constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => this.receive(json(raw)))
    ws.on('close', () => this.close())
    ws.on('error', () => this.close())
  }

  private receive(message: Wire | null) {
    if (!message || !('id' in message)) return
    const pending = this.pending.get(message.id)
    if (!pending) return
    if (message.type === 'response') {
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          pending.controller = controller
        },
        cancel: () => {
          this.pending.delete(message.id)
        },
      })
      pending.resolve(new Response(stream, { status: message.status, headers: message.headers }))
      return
    }
    if (message.type === 'response/chunk') {
      pending.controller?.enqueue(Buffer.from(message.data, 'base64'))
      return
    }
    if (message.type === 'response/end') {
      pending.controller?.close()
      this.pending.delete(message.id)
      return
    }
    if (message.type === 'response/error') {
      const error = new Error(message.error || '本地运行时断开')
      if (pending.controller) pending.controller.error(error)
      else pending.reject(error)
      this.pending.delete(message.id)
    }
  }

  private close() {
    for (const pending of this.pending.values()) {
      const error = new Error('本地运行时断开')
      if (pending.controller) pending.controller.error(error)
      else pending.reject(error)
    }
    this.pending.clear()
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error('本地运行时未连接')
    const id = randomUUID()
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((value, name) => (headers[name] = value))
    const response = new Promise<Response>((resolve, reject) => this.pending.set(id, { resolve, reject }))
    send(this.ws, { type: 'request', id, method: init.method || 'GET', path, headers })
    try {
      if (init.body) {
        const body = new Response(init.body as BodyInit).body
        if (body) {
          const reader = body.getReader()
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            send(this.ws, { type: 'request/chunk', id, data: Buffer.from(value).toString('base64') })
          }
        }
      }
      send(this.ws, { type: 'request/end', id })
    } catch (error) {
      this.pending.delete(id)
      throw error
    }
    return response
  }
}

/** `instances.host` 里的虚拟地址。它只在 Gateway 进程内解析，不会交给 DNS。 */
export function localRuntimeHost(accountId: string, botId: string): string {
  return `satu-local://${accountId}/${botId}`
}

export function localRuntimeOnline(accountId: string, botId: string): boolean {
  return sockets.get(keyOf(accountId, botId))?.ws.readyState === WebSocket.OPEN
}

/** 普通 http(s) 返回 null；虚拟地址则通过 Desktop 建立的反向通道执行。 */
export async function localRuntimeFetch(url: string, init?: RequestInit): Promise<Response | null> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'satu-local:') return null
  const botAndPath = parsed.pathname.split('/').filter(Boolean)
  const botId = botAndPath.shift() || ''
  const runtime = sockets.get(keyOf(parsed.hostname, botId))
  if (!runtime) throw new Error('本地运行时未连接')
  const path = '/' + botAndPath.join('/') + parsed.search
  return runtime.fetch(path, init)
}

/**
 * 本地运行时反向通道。先升级、再用第一帧的 sat_ 席位票鉴权；票只在 TLS 通道正文里，
 * 不进 URL、代理访问日志或 Referer。
 */
export function attachLocalRuntimeUpgrade(server: Server, db: Db) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 })
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    /**
     * **这一句必须包起来。** 这是个同步监听器，`new URL` 对畸形的 Host（`Host: [`）
     * 会抛 TypeError，而从同步监听器里抛出去的异常没人接——它是 uncaughtException，
     * 进程当场就没了。一条不需要登录的升级请求就能做到。
     *
     * 解不出地址就当这条不归我们管：直接 return，让同一个 server 上别的 upgrade
     * 监听器（desktop.ts）去处置，它那边也有自己的兜底。
     */
    let url: URL
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
    } catch {
      return
    }
    if (url.pathname !== '/runtime/local-tunnel') return
    wss.handleUpgrade(req, socket, head, (ws) => {
      const timer = setTimeout(() => ws.close(4401, 'auth timeout'), 10_000)
      ws.once('message', (raw) => {
        clearTimeout(timer)
        const hello = json(raw)
        void (async () => {
          if (!hello || hello.type !== 'auth' || !hello.token.startsWith('sat_')) throw new Error('unauthorized')
          const account = await db.accountByAccessToken(hello.token)
          if (!account?.companyId || account.status !== 'active') throw new Error('unauthorized')
          const bot = (await db.botsFor(account.companyId, account.id)).find((item) => item.id === hello.botId)
          const def = bot?.definition as Record<string, unknown> | undefined
          if (!bot || bot.scope !== 'user' || bot.accountId !== account.id || def?.runtimeKind !== 'local') {
            throw new Error('not a local bot')
          }
          const key = keyOf(account.id, bot.id)
          const old = sockets.get(key)
          if (old && old.ws !== ws) old.ws.close(4409, 'replaced')
          const runtime = new LocalRuntime(ws)
          sockets.set(key, runtime)
          ws.once('close', () => {
            if (sockets.get(key)?.ws === ws) sockets.delete(key)
          })
          await db.upsertInstance({
            accountId: account.id,
            companyId: account.companyId,
            botId: bot.id,
            host: localRuntimeHost(account.id, bot.id),
          })
          send(ws, { type: 'ready' })
        })().catch(() => ws.close(4401, 'unauthorized'))
      })
    })
  })
}
