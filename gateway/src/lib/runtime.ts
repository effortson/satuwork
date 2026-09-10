/**
 * 席位定位与四个反代（JSON / 上传 / 下载 / SSE）。
 *
 * 从 routes.ts 拆出来的——那个文件曾经是 5700 行，前 1900 行全是这类帮手。
 */
import type { ServerResponse } from 'node:http'
import { HttpError, type Req, json } from '../http.ts'
import { INSTANCE_DOWN, machineBase } from './machines.ts'
import { Readable } from 'node:stream'
import { companyMachineOf, listSeatRuntime, managerHeaders } from '../deploy.ts'
import { pipeline } from 'node:stream/promises'
import { type Account, type Db, type Machine } from '../db.ts'
import { BlockList, isIP } from 'node:net'

/** Node 在双栈 socket 上给的是 ::ffff:1.2.3.4，统一去掉那层壳。 */
function plainIp(raw: string): string {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(raw.trim())
  return v4 ? v4[1] : raw.trim()
}

/**
 * 可信反代名单：`GATEWAY_TRUSTED_PROXIES`，逗号分隔的 IP 或 CIDR。
 *
 * 只有从这些地址进来的连接，`x-forwarded-for` 才算数。不配就是空名单——行为和以前
 * 一模一样，只看 socket。写错的条目直接丢掉并吼一声，不让一条错行把整份名单作废。
 */
const TRUSTED_PROXIES: BlockList | null = (() => {
  const raw = (process.env.GATEWAY_TRUSTED_PROXIES || '').trim()
  if (!raw) return null
  const list = new BlockList()
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [addr, prefix] = entry.split('/')
    const ip = plainIp(addr)
    const family = isIP(ip) === 4 ? 'ipv4' : isIP(ip) === 6 ? 'ipv6' : null
    const bits = prefix === undefined ? null : Number(prefix)
    if (!family || (bits !== null && !(Number.isInteger(bits) && bits >= 0 && bits <= (family === 'ipv4' ? 32 : 128)))) {
      console.error(`satuwork-gateway: GATEWAY_TRUSTED_PROXIES 里这一条看不懂，跳过：${entry}`)
      continue
    }
    if (bits === null) list.addAddress(ip, family)
    else list.addSubnet(ip, bits, family)
  }
  return list
})()

function isTrustedProxy(ip: string): boolean {
  if (!TRUSTED_PROXIES) return false
  const fam = isIP(ip)
  return fam === 4 ? TRUSTED_PROXIES.check(ip, 'ipv4') : fam === 6 ? TRUSTED_PROXIES.check(ip, 'ipv6') : false
}

/**
 * 取请求的来源 IP。
 *
 * 配对时用它决定「这台机器在哪儿」，所以**默认不信 `x-forwarded-for`**——那个头谁都
 * 能写，信了就等于让配对方自己指定 Gateway 以后往哪儿发部署。
 *
 * 但 §7.1 要求上线挂 TLS 反代，那时 socket 另一头永远是 127.0.0.1：每台机器配对都会
 * 被记成「在 Gateway 自己这台上」，第一次部署才发现打不通。所以补了一份可信代理名单
 * （`GATEWAY_TRUSTED_PROXIES`）：socket 源地址在名单里时，从 `x-forwarded-for` **右往左**
 * 找第一个不在名单里的地址——右边那些是我们自己的反代一跳跳追加的，左边那些是客户端
 * 自己能写的，只有名单外的第一跳是反代亲眼看见的真实来源。整条链都在名单里（反代和
 * 管家同一台机）就取最左那个。头里有看不懂的东西就当没有这个头，退回 socket 地址。
 */
export function sourceIpOf(req: Req): string {
  const socketIp = plainIp(req.socket.remoteAddress || '')
  if (!socketIp || !isTrustedProxy(socketIp)) return socketIp
  const header = req.headers['x-forwarded-for']
  const chain = (Array.isArray(header) ? header.join(',') : header || '')
    .split(',')
    .map((s) => plainIp(s))
    .filter(Boolean)
  if (!chain.length) return socketIp
  for (let i = chain.length - 1; i >= 0; i--) {
    const hop = chain[i]
    if (!isIP(hop)) return socketIp
    if (!isTrustedProxy(hop)) return hop
  }
  return chain[0]
}

export function instanceHostOf(raw: string): string {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    throw new HttpError(400, 'host 必须是 http/https URL')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'host 必须是 http/https URL')
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) throw new HttpError(400, 'host 不能带路径')
  return `${u.protocol}//${u.host}`
}

export function requireSeat(account: Account): void {
  if (account.role === 'owner' || !account.companyId) throw new HttpError(403, '没有公司席位')
}

export async function instanceHostFor(account: Account, db: Db, botId: string): Promise<string> {
  requireSeat(account)
  const id = (botId || '').trim()
  if (!id) throw new HttpError(400, 'botId 不能为空')
  const row = await db.instance(account.id, id)
  const host = row?.host?.trim() || ''
  if (!host) throw new HttpError(503, INSTANCE_DOWN)
  return host.replace(/\/$/, '')
}

export async function visibleBotOf(db: Db, account: Account, botId: string) {
  requireSeat(account)
  const id = (botId || '').trim()
  if (!id) throw new HttpError(400, 'botId 不能为空')
  const hit = (await db.botsFor(account.companyId, account.id)).find((b) => b.id === id)
  if (!hit) throw new HttpError(404, '没有这个 Bot')
  return hit
}

export async function pairRuntime(db: Db, account: Account, botId: string) {
  const rt = await db.seatRuntime(account.id, botId)
  if (!rt) return null
  return listSeatRuntime(rt, (await db.machine(rt.machineId)) ?? null)
}

/**
 * 这个席位**所在那台机器**的票。反代要用它过管家那一关。
 *
 * 以前取的是 `companies.machineId`——首次配对写死的默认机器。而 host 一直是按席位解析
 * 的（`instances.host` 由 deploySeat 按 machineForAccount 实际调度到的那台写入）。公司
 * 只有一台机器时两者恰好相同；配了第二台之后必然错配：拿 M1 的票去敲 M2，管家 401，
 * 聊天四条接口全部永久失败——而桌面和历史仍然正常，看起来像 bot 挂了而不是路由错了。
 *
 * 没有席位记录（stub / 老数据）才回落到公司默认机器。
 */
export async function machineTokenFor(db: Db, account: Account, botId: string): Promise<string | undefined> {
  if (!account.companyId) return undefined
  const rt = await db.seatRuntime(account.id, botId)
  const seatMachine = rt?.machineId ? await db.machine(rt.machineId) : undefined
  const machine = seatMachine ?? (await companyMachineOf(db, account.companyId))
  return machine?.token || undefined
}

/**
 * 某个席位**实际所在**的那台机器（按 seat_runtimes 查）。没有席位记录就是 undefined。
 *
 * 给「不是本人调用」的那些路用（管理员拉会话全文）：machineTokenFor 收的是调用方的
 * Account，而那条路上的调用方是管理员，席位是别人的。host 和机器票都从这一台取，才不
 * 会出现 host 是 M2、票是 M1 的错配。
 */
export async function seatMachineOf(db: Db, accountId: string, botId: string): Promise<Machine | undefined> {
  const id = (botId || '').trim()
  if (!id) return undefined
  const rt = await db.seatRuntime(accountId, id)
  return rt?.machineId ? await db.machine(rt.machineId) : undefined
}

/** 反代目标。地址和机器票**一次解析出来**，两边各查各的就没有漂移的余地了。 */
export interface SeatTarget {
  host: string
  machineToken: string | undefined
}

export async function seatTargetFor(db: Db, account: Account, botId: string): Promise<SeatTarget> {
  return {
    host: await instanceHostFor(account, db, botId),
    machineToken: await machineTokenFor(db, account, botId),
  }
}

/**
 * **管家自己**那一层的地址，不是 bot 的。
 *
 * `instances.host` 长这样：`http://机器:8443/seats/<seatId>/bot`——它是给反代 bot 用
 * 的完整前缀。拿它再去拼 `/seats/:id/diag`，出来的是
 * `…/seats/X/bot/seats/X/diag`，管家把它当成「转给 bot 的路径」原样递下去，bot 回
 * 404。席位诊断从上线起就是这么坏的，而 404 长得像「这台机器没这个接口」，不像
 * 「地址拼错了」。
 *
 * 管家的地址只有一个来源：机器记录的 host。
 */
export async function managerTargetFor(
  db: Db,
  account: Account,
  botId: string,
): Promise<{ base: string; seatId: string; machineToken: string | undefined }> {
  requireSeat(account)
  if (!botId) throw new HttpError(400, 'botId 不能为空')
  const runtime = await db.seatRuntime(account.id, botId)
  if (!runtime) throw new HttpError(404, '还没有部署')
  const machine = await db.machine(runtime.machineId)
  if (!machine?.host) throw new HttpError(503, INSTANCE_DOWN)
  return { base: machineBase(machine.host), seatId: runtime.seatId, machineToken: machine.token || undefined }
}

export async function seatTargetForSession(db: Db, account: Account, sessionId: string): Promise<SeatTarget> {
  requireSeat(account)
  const idx = await db.sessionIndex(sessionId)
  const botId = (idx?.botId || '').trim()
  if (!botId || idx!.accountId !== account.id) throw new HttpError(503, INSTANCE_DOWN)
  return await seatTargetFor(db, account, botId)
}

export async function seatBearer(db: Db, accountId: string): Promise<string> {
  const secrets = await db.accountSecrets(accountId)
  // 没有回落到机器票：bot 只认席位票了，把 smt_ 递过去只会换回一个 401，
  // 并且会让人以为「票发了但没生效」，比直接空着更难查。
  return secrets?.accessToken ?? ''
}

/**
 * 两层鉴权，两个头。
 *
 * `authorization` 是给 **bot** 的席位票（`sat_`），管家原样透传不看；
 * `x-satuwork-machine` 是给 **管家** 的机器票（`smt_`），管家验完就摘掉。
 * 分开是为了让 bot 那边一行都不用改。
 *
 * 真正拼头的是 deploy.ts 的 `managerHeaders`——它还会捎上「Gateway 现在在哪」，
 * 而那一句必须每条发往管家的调用都带着才有意义（见那边的长注释）。这里保留这个名字，
 * 是因为它有十几个调用点，而它们要的正是「发给管家的那套头」。
 */
export function machineHeader(machineToken?: string): Record<string, string> {
  return managerHeaders(machineToken)
}

export async function proxyJson(
  res: ServerResponse,
  method: string,
  url: string,
  body?: unknown,
  token?: string,
  machineToken?: string,
  /**
   * 拼进席位响应里的附加字段。
   *
   * 给「Gateway 这一跳做了什么」用——比如剔掉了几个失效的 `@`。席位不知道这件事，
   * 而界面需要知道，所以由这一跳补上去，**不覆盖**席位已有的字段。
   */
  extra?: Record<string, unknown>,
  /**
   * 等席位/管家多久，毫秒。默认 15 秒——够任何一条「取一份状态」的接口。
   *
   * **有一类调用必须自己给一个更大的数**：那一头做的是真活儿（清 journal 要先
   * rotate 再删文件），而不是查一份现成的数据。用默认值的后果不是「慢」，是**假的
   * 失败**：Gateway 在 15 秒掐断连接、回一句「实例还没上线」，而机器上那件事正干得
   * 好好的，人看着报错就会再点一次。
   */
  timeoutMs = 15000,
) {
  // authorization 上只能是席位票。bot 不认机器票了，回落到 smt_ 只会换回 401，
  // 而且会让人以为「票带了但没生效」，比空着更难查。
  const bearerTok = token || ''
  let r: Response
  try {
    r = await fetch(url, {
      method,
      headers: {
        authorization: bearerTok ? `Bearer ${bearerTok}` : '',
        accept: 'application/json',
        ...machineHeader(machineToken),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new HttpError(503, INSTANCE_DOWN)
  }
  const text = await r.text()
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = { error: text.slice(0, 200) || INSTANCE_DOWN }
  }
  if (extra && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    json(res, r.status, { ...(parsed as Record<string, unknown>), ...extra })
    return
  }
  json(res, r.status, parsed)
}

/**
 * 把浏览器传上来的字节**边收边转**给席位，不在 Gateway 落地。
 *
 * 附件动辄几十 MB，`readBody` 那条路会先攒进内存再解析成 JSON——对文件来说两件事
 * 都是错的。所以路由用 `postRaw`，这里直接把 `req` 接到 fetch 的 body 上。
 *
 * `duplex: 'half'` 是流式 body 的硬性要求，不带这个参数 undici 直接拒绝发出。
 */
export async function proxyUpload(
  req: Req,
  res: ServerResponse,
  url: string,
  headers: Record<string, string>,
  token?: string,
  machineToken?: string,
) {
  let r: Response
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: token ? `Bearer ${token}` : '',
        accept: 'application/json',
        'content-type': 'application/octet-stream',
        ...headers,
        ...machineHeader(machineToken),
      },
      body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
      duplex: 'half',
      // 传大文件比一次 JSON 往返慢得多，15 秒那个超时会在半路砍断它。
      signal: AbortSignal.timeout(10 * 60 * 1000),
    } as RequestInit & { duplex: 'half' })
  } catch {
    throw new HttpError(503, INSTANCE_DOWN)
  }
  const text = await r.text()
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = { error: text.slice(0, 200) || INSTANCE_DOWN }
  }
  json(res, r.status, parsed)
}

/**
 * 上游把这次调用拒了：把它那份正文原样转出去。
 *
 * `passthrough` 是「这个状态码该原样交给浏览器」的白名单，其余一律 503。分开列是因为
 * 两条代理的口径本来就不同：下载那条把 400/404 当业务答案，SSE 那条还要把 401/403
 * 交出去（席位票过期了，前端要据此重取一张，收到 503 它只会当作实例挂了一直重连）。
 *
 * 上游正文认不出 JSON 时兜一句 INSTANCE_DOWN——**不能把原文透传**：那多半是一页
 * HTML 错误页，前端 `res.json()` 会当场抛，人看到的是一次没有任何线索的失败。
 */
async function relayUpstreamError(res: ServerResponse, r: Response, passthrough: number[]) {
  const text = await r.text().catch(() => '')
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : { error: INSTANCE_DOWN }
  } catch {
    parsed = { error: INSTANCE_DOWN }
  }
  json(res, passthrough.includes(r.status) ? r.status : 503, parsed)
}

/**
 * 一条上游 SSE 拆成一个个事件。
 *
 * 分帧规则收在这一处：CRLF 归一化、`\n\n` 分帧、一帧里可能有多行 `data:`、认不出
 * JSON 的那一行跳过。两处消费者（例行任务等这一轮的结局、名册流往下转发）本来各写
 * 一遍——而这几条每一条都是「写错了不报错、只是偶尔悄悄丢一帧」的那种规则。
 *
 * `stop` 在每次 read 之前问一次，位置和原来那两个 while 条件一致。
 */
export async function* sseEvents<T>(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  stop: () => boolean = () => false,
): AsyncGenerator<T> {
  const decoder = new TextDecoder()
  let buf = ''
  while (!stop()) {
    const { done, value } = await reader.read()
    if (done) return
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    let idx: number
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue
        let ev: T
        try {
          ev = JSON.parse(line.slice(6)) as T
        } catch {
          continue
        }
        yield ev
      }
    }
  }
}

/**
 * 把席位上的文件字节转给浏览器。预览和下载都走这条。
 *
 * **安全头在这里加，不在 bot 那边**：面向浏览器的是这一跳，源也是这一跳的源。
 * bot 那边同样设了一份，但那是防御纵深，真正生效的是这里。
 *
 * `content-type` 与 `content-disposition` 原样透传——它们由 bot 的白名单算出来
 * （见 workspace/index.ts 的 INLINE），Gateway 不该二次猜测，猜了反而会和白名单打架。
 */
export async function proxyDownload(req: Req, res: ServerResponse, url: string, token?: string, machineToken?: string) {
  const ac = new AbortController()
  const onClose = () => ac.abort()
  req.on('close', onClose)
  let r: Response
  try {
    r = await fetch(url, {
      headers: {
        authorization: token ? `Bearer ${token}` : '',
        ...machineHeader(machineToken),
      },
      signal: ac.signal,
    })
  } catch {
    req.off('close', onClose)
    if (ac.signal.aborted) return
    throw new HttpError(503, INSTANCE_DOWN)
  }
  if (!r.ok || !r.body) {
    req.off('close', onClose)
    await relayUpstreamError(res, r, [400, 404])
    return
  }
  const type = r.headers.get('content-type') || 'application/octet-stream'
  const disposition = r.headers.get('content-disposition') || 'attachment'
  const length = r.headers.get('content-length')
  res.writeHead(200, {
    'content-type': type,
    'content-disposition': disposition,
    ...(length ? { 'content-length': length } : {}),
    // 声明的类型就是最终类型：允许嗅探，一个改名成 .png 的 HTML 就能变回 HTML。
    'x-content-type-options': 'nosniff',
    /**
     * 这段字节是**用户上传的**，而它此刻挂在 Gateway 的源上。没有这条，一个 SVG 或
     * HTML 附件里的 `<script>` 就在登录态里跑起来了。
     *
     * `sandbox` 不带任何 allow-*：脚本、表单、同源存储、导航全关，图片和 PDF 照常
     * 显示。扩展名白名单已经挡掉了 SVG/HTML 的内联（它们只会 attachment），这条是
     * 第二道——白名单哪天加错一项，不至于当场变成 XSS。
     */
    'content-security-policy': "sandbox; default-src 'none'; img-src 'self' data:; object-src 'self'",
    'cache-control': 'private, no-store',
  })
  try {
    await pipeline(Readable.fromWeb(r.body as any), res)
  } catch {
    // 浏览器中途关掉预览是常事，不是故障。
  } finally {
    req.off('close', onClose)
  }
}

export async function proxySse(req: Req, res: ServerResponse, url: string, token?: string, machineToken?: string) {
  // authorization 上只能是席位票。bot 不认机器票了，回落到 smt_ 只会换回 401，
  // 而且会让人以为「票带了但没生效」，比空着更难查。
  const bearerTok = token || ''
  const ac = new AbortController()
  const onClose = () => ac.abort()
  req.on('close', onClose)
  let r: Response
  try {
    r = await fetch(url, {
      headers: {
        authorization: bearerTok ? `Bearer ${bearerTok}` : '',
        accept: 'text/event-stream',
        ...machineHeader(machineToken),
      },
      signal: ac.signal,
    })
  } catch {
    req.off('close', onClose)
    if (ac.signal.aborted) return
    throw new HttpError(503, INSTANCE_DOWN)
  }
  if (!r.ok || !r.body) {
    req.off('close', onClose)
    await relayUpstreamError(res, r, [401, 403, 404])
    return
  }
  res.writeHead(r.status, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  })
  const reader = r.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      // 对面已经走了就别再写：写进一个毁掉的流只会换回一次 error 事件。
      if (res.writableEnded || res.destroyed) break
      if (!res.write(Buffer.from(value))) await drained(res)
    }
  } catch {
    /* 客户端断开或上游中断 */
  } finally {
    req.off('close', onClose)
    try {
      res.end()
    } catch {}
  }
}

/**
 * 背压：等对面把缓冲吃掉。**close 和 error 也要收，不能只等 drain。**
 *
 * 这里原来是 `new Promise((resolve) => res.once('drain', resolve))`。客户端在背压里
 * 关掉标签页（慢网上看 SSE，socket 缓冲满了，人这时候关掉页面）时，那个 socket 已经
 * 毁了——毁掉的可写流只发 `close` / `error`，**`drain` 永远不会来**。于是这个 promise
 * 永远不落地：上面那个 while 再也不往下走，`finally` 不跑，`req` 上那个监听摘不掉，
 * ReadableStream 的读锁也不放。每断一次就在这个所有公司共用的进程里留一帧永远挂着的
 * 栈，而外面看不出任何异常。
 *
 * 三个事件哪个先到都算「不必再等了」，然后由调用方自己判断还该不该写。
 */
function drained(res: ServerResponse): Promise<void> {
  if (res.writableEnded || res.destroyed) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = () => {
      res.off('drain', done)
      res.off('close', done)
      res.off('error', done)
      resolve()
    }
    res.once('drain', done)
    res.once('close', done)
    res.once('error', done)
  })
}
