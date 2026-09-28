/**
 * 一个够用的 Chrome DevTools Protocol 客户端。
 *
 * **不引 puppeteer，也不引 ws。** 发布包是在 Linux arm64 上打的（docs/release-*），
 * 多一个带原生模块的依赖就多一次「本机能跑、机器上装不上」。Node 22 起 `WebSocket`
 * 和 `fetch` 都是全局的，CDP 那点协议本身只有「发一条带 id 的 JSON、等一条同 id 的
 * 回来」——写出来比接一层适配器短。
 */

import { readFileSync } from 'node:fs'

/**
 * 这个口上蹲着的监听者是不是**本进程这个账号**的。`true` 是，`false` 不是，`null` 判不了
 * （不是 Linux、读不到 /proc、或者此刻根本没人在听）。
 *
 * **为什么要问。** 一台机器上跑着好几个员工的席位（一人一个 Linux 账号）。root 装的那条
 * nft 规则（manager/src/seat/seat-cdp-guard.sh）挡的是「别的账号连进这个口」，挡不了
 * 反方向：席位的 Chrome 没起来的时候口是空的（员工没点过、或者刚崩了），别的账号可以
 * 抢先在 127.0.0.1:<这个口> 上听着。Bot 这时候连过去，就是把「开哪个网址、填什么」发给
 * 了别人，还把别人回的页面当成自己席位上的内容读进上下文。nft 按 uid 挡不住这一半：
 * 回包（SYN-ACK）不带完整的 socket，uid 那一项在那条路上是认不出来的。
 *
 * /proc/net/tcp{,6} 谁都读得到，每一行带着 socket 属主的 uid——拿来对一下就够了。
 */
export function listenerIsOurs(port: number): boolean | null {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') return null
  const me = process.getuid()
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0')
  let seen = false
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n').slice(1)) {
      // sl local_address rem_address st tx:rx tr:when retrnsmt uid timeout inode
      const cols = line.trim().split(/\s+/)
      if (cols.length < 8) continue
      const [, local, , state, , , , uid] = cols
      // 0A = LISTEN。地址不挑：0.0.0.0 / :: 上的监听一样接得住发往 127.0.0.1 的连接。
      if (state !== '0A' || !local.endsWith(':' + hexPort)) continue
      seen = true
      if (Number(uid) !== me) return false
    }
  }
  return seen ? true : null
}

/** 一条命令等多久。页面加载那类慢操作自己传更大的值。 */
const DEFAULT_TIMEOUT = 15_000

export class CdpError extends Error {}

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface CdpEvent {
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

export class Cdp {
  private ws: WebSocket
  private seq = 0
  private pending = new Map<number, Pending>()
  private listeners = new Set<(event: CdpEvent) => void>()
  /** 连接断了之后，所有还在等的命令都要立刻收到错误，不能挂到超时。 */
  private closed: Error | null = null

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', (e) => this.onMessage(String((e as MessageEvent).data)))
    ws.addEventListener('close', () => this.fail(new CdpError('浏览器的调试连接断了')))
    ws.addEventListener('error', () => this.fail(new CdpError('浏览器的调试连接出错')))
  }

  /**
   * 连上浏览器那一层（不是某个标签页）。
   *
   * 走 `/json/version` 拿 webSocketDebuggerUrl，而不是自己拼——那个地址里带着一段
   * 每次启动都变的 GUID。
   */
  static async connect(port: number, timeoutMs = 5_000): Promise<Cdp> {
    // 先认人再说话：口上听着的不是自己这个账号，就一个字节都别发（见 listenerIsOurs）。
    // 判不了（null）的放行——那是非 Linux 的本地 Bot，或者此刻没人在听、下面自然连不上。
    if (listenerIsOurs(port) === false) {
      throw new CdpError(
        `127.0.0.1:${port} 上听着的不是这个席位账号的进程，拒绝连接。` +
          '多半是同一台机器上别的账号抢先占了这个口；停掉它再重启这个席位的桌面。',
      )
    }
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
      // CDP 的 HTTP 端点只认 Host 是 localhost / IP 的请求，这是 Chrome 自己防 DNS
      // rebinding 的做法。默认发出去的 Host 就是 127.0.0.1，这里只是别去改它。
    }).catch((e: Error) => {
      throw new CdpError(`连不上席位上的浏览器（127.0.0.1:${port}）：${e.message}`)
    })
    if (!res.ok) throw new CdpError(`浏览器调试端口回了 ${res.status}`)
    const body = (await res.json()) as { webSocketDebuggerUrl?: string }
    const url = body.webSocketDebuggerUrl
    if (!url) throw new CdpError('浏览器没给出调试用的 WebSocket 地址')
    const ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new CdpError('连浏览器超时')), timeoutMs)
      ws.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      })
      ws.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new CdpError('连浏览器失败'))
      })
    })
    return new Cdp(ws)
  }

  private onMessage(raw: string) {
    let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: unknown; sessionId?: string }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof msg.id === 'number') {
      const hit = this.pending.get(msg.id)
      if (!hit) return
      this.pending.delete(msg.id)
      clearTimeout(hit.timer)
      if (msg.error) hit.reject(new CdpError(msg.error.message || 'CDP 报错'))
      else hit.resolve(msg.result ?? {})
      return
    }
    if (!msg.method) return
    const event: CdpEvent = {
      method: msg.method,
      params: (msg.params ?? {}) as Record<string, unknown>,
      ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
    }
    // 监听者自己出错不该把整条连接带下水。
    for (const fn of this.listeners) {
      try {
        fn(event)
      } catch {
        /* 忽略 */
      }
    }
  }

  private fail(err: Error) {
    if (this.closed) return
    this.closed = err
    for (const [, hit] of this.pending) {
      clearTimeout(hit.timer)
      hit.reject(err)
    }
    this.pending.clear()
  }

  on(fn: (event: CdpEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  get alive(): boolean {
    return !this.closed && this.ws.readyState === 1
  }

  /**
   * 发一条命令。`sessionId` 给的是某个标签页那一层，不给就是浏览器那一层。
   *
   * `signal` 一响立刻 reject——**跑得久的工具必须自己响应中止**（见 tools/index.ts）。
   * 注意这里只是不再等：命令已经发出去了，浏览器那边会照跑，所以调用方的措辞得说
   * 「这一下可能已经生效」，不能说「没发生」。
   */
  async send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    opts: { sessionId?: string; timeout?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.closed) throw this.closed
    const id = ++this.seq
    const payload: Record<string, unknown> = { id, method, params }
    if (opts.sessionId) payload.sessionId = opts.sessionId
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // 超时也要摘掉 abort 监听器：同一个 signal 会跟着一整次工具调用跑几十条命令，
        // 不摘的话每条超时都在它身上留一个闭包，直到那一轮结束。
        opts.signal?.removeEventListener('abort', onAbort)
        reject(new CdpError(`${method} 超时`))
      }, opts.timeout ?? DEFAULT_TIMEOUT)
      const onAbort = () => {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new CdpError('已中止'))
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: (value) => {
          opts.signal?.removeEventListener('abort', onAbort)
          resolve(value as T)
        },
        reject: (err) => {
          opts.signal?.removeEventListener('abort', onAbort)
          reject(err)
        },
        timer,
      })
      try {
        this.ws.send(JSON.stringify(payload))
      } catch (e) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new CdpError(`发不出去：${(e as Error).message}`))
      }
    })
  }

  close(): void {
    this.fail(new CdpError('连接已关闭'))
    try {
      this.ws.close()
    } catch {
      /* 关不掉就算了 */
    }
  }
}
