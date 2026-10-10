/**
 * 和 Gateway 说话的那一层：api()、swFetch、本地 Bot 改道表。原先在 gateway/ui/data.js 开头。
 *
 * 这里**不认任何全局**：fetch、Gateway 地址、票的存取、语言、401 之后干什么、怎么重新要
 * 本地 Bot 的票，全部由宿主在 createGatewayClient() 里注入。Web（data.js）传的是浏览器里
 * 那一套，移动端传 expo/fetch 和 SecureStore。
 */
import type { Locale } from './format.ts'
import { errText, t } from './i18n/t.ts'

/** 登录票放在哪。Web 是 sessionStorage / localStorage（state.js），移动端是 SecureStore。 */
export interface TokenStore {
  get(): string | null | undefined
  set(token: string): void
  clear(): void
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface GatewayClientOptions {
  fetch: FetchLike
  /**
   * Gateway 在哪。浏览器里页面就是 Gateway 发的，相对路径即可，给空串；桌面端里界面是包里
   * 自带的（源是 satu://localhost），壳子注入 `__SATUWORK_GATEWAY__`；移动端是人填的地址。
   * 给函数是因为 Web 那个值在脚本加载之后才注入，要用时再读。
   */
  baseUrl: string | (() => string)
  tokens: TokenStore
  locale: () => Locale
  /**
   * Gateway 说登录票不认了（过期、账号被停用）。Web 在这里走和「退出登录」同一条拆法
   * （app.js 的 endSignedIn）、挪到 /login、重绘。移动端清票、回登录屏。
   * 调完之后 api() 照样会抛，调用方拿到的仍是一个错误。
   */
  onUnauthorized: () => void
  /**
   * 本地 Bot 回了 401：重新向 Gateway 要一把这颗 Bot 的票（Web 是 chat.js 的
   * startDesktopLocalBot，它会顺手把新票 registerLocalBot 进来）。不给就不重试。
   */
  renewLocalBot?: (botId: string) => Promise<unknown>
}

/** 一颗本地 Bot：听在哪个口、用哪把票、那把票是拿哪张登录票要来的。 */
export interface LocalBot {
  base: string
  token: string
  login: string | null | undefined
}

export interface LocalRoute {
  url: string
  token: string
  botId: string
}

/** api() 抛出来的错误带状态码：调用方要判断 404 就看这个，别去猜文案——文案是会被翻译的。 */
export interface ApiError extends Error {
  status?: number
}

export function createGatewayClient(opts: GatewayClientOptions) {
  const { fetch, tokens, locale, onUnauthorized, renewLocalBot } = opts

  function gatewayBase(): string {
    const raw = typeof opts.baseUrl === 'function' ? opts.baseUrl() : opts.baseUrl
    return String(raw || '').replace(/\/$/, '')
  }

  /** Gateway 的相对地址 → 可用的地址。已经是绝对地址的原样返回。 */
  function gatewayAbs<T>(url: T): T | string {
    return typeof url === 'string' && url.startsWith('/') ? gatewayBase() + url : url
  }

  /* ══ 本地 Bot 直连 ═══════════════════════════════════════════════════
     桌面端里的本地 Bot 跑在这台电脑上（Tauri 壳起的进程，听 127.0.0.1 的一个端口）。
     以前它的对话流、历史、发消息都先到 Gateway、再穿一条反向隧道绕回本机——为的是让
     Gateway 能「主动打进」本地 Bot。隧道拆了（docs/adr-gateway-vercel-neon.md §4）：
     本地 Bot 的请求在这一层**直接改道**到 127.0.0.1，带的票换成这颗 Bot 的票
     （sat_，从 /runtime/bots/:id/local-bootstrap 拿的桌面端那一套，bot 只认它）。

     改道只发生在两类路径上：`/runtime/bots/:id/session`（取会话）和
     `/runtime/sessions/:sid/*`（那条会话上的一切）。别的照旧打 Gateway——公司模版、
     记忆、Skill、账号，本地 Bot 也要从 Gateway 拿。

     路径对照表照着 gateway/src/routes/runtime.ts 里那几条反代抄：Gateway 把
     `/runtime/sessions/:sid/files?path=` 翻成 bot 的 `/api/workspace/file?path=`、
     `/workspace?path=` 翻成 `/api/workspace/list?path=`、其余原样接在 `/api/sessions/:sid`
     后面。这张表漂了，表现是本地 Bot 上某个按钮 404 而远程 Bot 好好的。

     移动端永远不登记本地 Bot，这两张表就是空的，所有请求原样打 Gateway。
     ══════════════════════════════════════════════════════════════════ */

  /**
   * botId → { base, token, login }。壳子起了哪些本地 Bot、听在哪个口、用哪把票，以及那把票
   * 是拿哪张登录票要来的（`login`）。
   *
   * 本地 Bot 的票跟登录票同生共死（Gateway 迁移 0041）：改口令、被管理员重置之后它一起作废。
   * 而那之后页面手上一定换了一张登录票（重新登录，或改口令时回来的新票）——所以「登录票变了」
   * 就是「该重新要一次本地 Bot 的票」的信号，见 chat.js 的 overlayLocalRuntime。
   */
  const localBots = new Map<string, LocalBot>()
  /** sessionId → botId。只登记本地 Bot 的会话；查不到的一律走 Gateway。 */
  const localSessions = new Map<string, string>()

  function registerLocalBot(botId: string, port: number | string, tok?: string): void {
    if (!botId || !port) return
    const prev = localBots.get(botId)
    localBots.set(botId, {
      base: 'http://127.0.0.1:' + port,
      token: tok || prev?.token || '',
      login: tok ? tokens.get() : prev?.login,
    })
  }

  function localBotOf(botId: string | null | undefined): LocalBot | null {
    const lb = botId ? localBots.get(botId) : null
    return lb && lb.token ? lb : null
  }

  /** 这条 Gateway 路径要不要改道到本地 Bot。返回 { url, token, botId } 或 null。 */
  function localRoute(path: unknown, method?: string): LocalRoute | null {
    if (typeof path !== 'string' || !path.startsWith('/runtime/')) return null
    let m = /^\/runtime\/bots\/([^/?]+)\/session(\?.*)?$/.exec(path)
    if (m) {
      const botId = decodeURIComponent(m[1])
      const lb = localBotOf(botId)
      return lb ? { url: lb.base + '/api/bots/' + m[1] + '/session' + (m[2] || ''), token: lb.token, botId } : null
    }
    m = /^\/runtime\/sessions\/([^/?]+)(\/[^?]*)?(\?.*)?$/.exec(path)
    if (!m) return null
    const botId = localSessions.get(decodeURIComponent(m[1]))
    const lb = localBotOf(botId)
    if (!lb || !botId) return null
    const rest = m[2] || ''
    const q = m[3] || ''
    const verb = String(method || 'GET').toUpperCase()
    let target: string
    if (rest === '/files' && q && verb === 'GET') target = '/api/workspace/file' + q
    else if (rest === '/workspace') target = (verb === 'DELETE' ? '/api/workspace/file' : '/api/workspace/list') + q
    else target = '/api/sessions/' + m[1] + rest + q
    return { url: lb.base + target, token: lb.token, botId }
  }

  /**
   * 所有打 Gateway 的 fetch 都从这儿过：本地 Bot 的那几条改道到 127.0.0.1，票换成席位票；
   * 其余原样。init.headers 里的 authorization 会被覆盖——那是登录票，bot 不认。
   */
  function swFetch(path: string, init?: RequestInit): Promise<Response> {
    const route = localRoute(path, init && (init.method as string | undefined))
    if (!route) return fetch(gatewayAbs(path), init)
    const headers: Record<string, string> = { ...((init && (init.headers as Record<string, string>)) || {}) }
    for (const k of Object.keys(headers)) if (k.toLowerCase() === 'authorization') delete headers[k]
    headers.authorization = 'Bearer ' + route.token
    return fetch(route.url, { ...(init || {}), headers })
  }

  /**
   * botId → 正在进行的那次「重新要本地 Bot 的票」。同一拍里几条请求一起撞上 401 时只要一次：
   * 每要一次壳子就可能拿新票把进程重起一遍（见 chat.js 的 startDesktopLocalBot）。
   */
  const localTicketRenewals = new Map<string, Promise<unknown>>()

  function renewLocalTicket(botId: string): Promise<unknown> {
    let p = localTicketRenewals.get(botId)
    if (!p) {
      p = Promise.resolve()
        .then(() => (renewLocalBot ? renewLocalBot(botId) : Promise.reject(new Error('no renewLocalBot'))))
        .finally(() => localTicketRenewals.delete(botId))
      localTicketRenewals.set(botId, p)
    }
    return p
  }

  async function api(method: string, path: string, body?: unknown, localRetried = false): Promise<any> {
    const headers: Record<string, string> = { accept: 'application/json' }
    const tok = tokens.get()
    if (tok) headers.authorization = 'Bearer ' + tok
    if (body !== undefined) headers['content-type'] = 'application/json'
    // 改道到本机的那几条（见 swFetch）：它们的 401 是**本地 Bot** 说的，跟登录票无关。
    const local = localRoute(path, method)
    const res = await swFetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let json: any = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {}
    /**
     * 本地 Bot 回的 401：多半是它重启过、或者票换过一轮（登录票变了之后 overlayLocalRuntime
     * 会重新要），手上这把席位票作废了。这**不是**登录过期——当成登录过期的话，桌面端里
     * 本地 Bot 重起一次就把人踢回登录页。重新向 Gateway 要一把票、重试一次；还是 401 就
     * 照普通错误抛，别登出。要票那一跳本身打的是 Gateway，真是登录过期的话由它那条 401 去登出。
     */
    if (res.status === 401 && local) {
      if (!localRetried) {
        const cur = localBotOf(local.botId)
        // 并发的另一条已经换过票了：直接拿新票重试，别再要一次。
        const renewed = cur && cur.token !== local.token
          ? true
          : await renewLocalTicket(local.botId).then(() => true, () => false)
        if (renewed) return api(method, path, body, true)
      }
      const err: ApiError = new Error(errText(locale(), (json && json.error) || t(locale(), '本地 Bot 拒绝了这次请求', 'The local bot rejected this request')))
      err.status = res.status
      throw err
    }
    /**
     * Gateway 说登录票不认了（过期、账号被停用）：交给宿主的 onUnauthorized（Web 走和
     * 「退出登录」同一条拆法，见 app.js 的 endSignedIn）。
     *
     * `tok === tokens.get()`：这条请求是拿**当时那张**票发的。它在路上时人可能已经重新登录过
     * ——那张旧票的 401 不能把新登进来的人再踢出去。
     */
    if (res.status === 401 && tok && tok === tokens.get() && path !== '/auth/login' && !path.startsWith('/invites/')) {
      onUnauthorized()
      throw new Error((json && json.error) || t(locale(), '需要登录'))
    }
    // 服务端只发中文。在这里翻一次，调用方无论是丢给 flash 还是直接塞进 state
    // （state.planSkuError、state.inviteError 这些）拿到的都已经是当前语言。
    if (!res.ok) {
      const err: ApiError = new Error(errText(locale(), (json && json.error) || text || 'HTTP ' + res.status))
      // 状态码挂在错误上：调用方要判断 404 就看这个，别去猜文案——文案是会被翻译的。
      err.status = res.status
      throw err
    }
    return json
  }

  return { gatewayBase, gatewayAbs, localBots, localSessions, registerLocalBot, localBotOf, localRoute, swFetch, renewLocalTicket, api }
}

export type GatewayClient = ReturnType<typeof createGatewayClient>
