/**
 * 和机器管家说话的那一层：控制接口的头和请求（名册、部署、拆席位、装机进度、探活），
 * 以及报错里怎么把密钥抹掉。
 */
import type { Machine } from '../db.ts'
import { MIN_PROGRESS_PROTOCOL, type SeatPorts, gatewayPublicUrlExplicit, machinePaired } from './paths.ts'

/**
 * 单个席位的部署超时。第一次部署要 apt 装一整套桌面栈，十五分钟是给它的。
 *
 * 重铺一个已经 ready 的席位用不了这么久，批量那条路自己传一个短的（见 managerDeploy）。
 */
export const DEPLOY_TIMEOUT_MS = 900_000

/**
 * 发往**管家自己**那几条控制接口的头：机器票，外加一句「Gateway 现在在哪」。
 *
 * 第二个头是给管家学地址用的（见 manager/src/index.ts 的 adoptGatewayUrl）。它要解的
 * 是一个死结：Gateway 换了地址之后，管家手上那份 `gatewayUrl` 还是配对那天写死的，
 * 心跳打向一个不存在的地方——而它唯一能被告知这件事的通道，恰恰是它**打不出去**的
 * 那一条。入站这条还通着（机器没挪窝），那就从这条告诉它。
 *
 * **信任面没有变大**：这个头只有过了 `requireMachine` 的调用方才会被采信，也就是拿得出
 * `smt_` 的那一个；而部署请求的 body 里本来就带着 `gatewayUrl`，管家一直原样把它写进
 * 席位的 bot.env。差别只是这次它也写给自己。
 *
 * **反代那条路上带了也没用**：管家转发给 bot 的请求走的是它自己那道 machineTokenOk，
 * 不经过 requireMachine，所以聊天流量不会 adopt。真正的入口是控制类那几条（探活、
 * 部署、取日志）——反正它们才是「有人在平台上动了这台机器」的时刻。
 *
 * **只在明确配置过时才带**，理由见 gatewayPublicUrlExplicit。
 */
export function managerHeaders(machineToken?: string): Record<string, string> {
  const url = gatewayPublicUrlExplicit()
  return {
    ...(machineToken ? { 'x-satuwork-machine': machineToken } : {}),
    ...(url ? { 'x-satuwork-gateway-url': url } : {}),
  }
}

/**
 * 打管家自己的一条控制接口（名册、部署、拆席位、装机进度）。调用方得先确认机器配对过
 * （machinePaired），这里不再查 host。
 *
 * 机器票两种写法都带：`x-satuwork-machine` 是反代那条路径上用来和 bot 的 `authorization`
 * 区分开的；控制类调用没有这个冲突，带上 `authorization` 让 curl 和旧版管家也认。
 */
function managerControlFetch(machine: Machine, path: string, init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> } = {}): Promise<Response> {
  return fetch(`${machine.host!.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: { ...init.headers, ...managerHeaders(machine.token), authorization: 'Bearer ' + machine.token },
  })
}

/** 管家名册里的一行（manager/src/seats.ts 的 SeatRecord，去掉了 gatewayToken）。只取要用的几格。 */
export interface ManagerSeat {
  seatId: string
  status: 'ready' | 'error'
  /** 管家**开始**装这一次的时刻（管家自己的钟），见 seats.ts 的 base。 */
  deployedAt: number
  lastError: string | null
  botVersion: string
}

/** 管家的名册。问不到（机器没配对、不通、老管家）就是 undefined，调用方当「不知道」处理。 */
export async function managerSeatsOf(machine: Machine, timeoutMs = 5000): Promise<ManagerSeat[] | undefined> {
  if (!machinePaired(machine)) return undefined
  try {
    const res = await managerControlFetch(machine, '/seats', { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return undefined
    const body = (await res.json()) as { seats?: unknown }
    return Array.isArray(body?.seats) ? (body.seats as ManagerSeat[]) : undefined
  } catch {
    return undefined
  }
}

/** Gateway 下发给管家的席位规格。字段和 manager/src/seats.ts 的 SeatSpec 一一对应。 */
export interface SeatSpec {
  seatId: string
  linuxUser: string
  homeDir: string
  workDir: string
  seatDir: string
  botId: string
  /** Bot 的名字，管家只拿它写工作区那一格的名牌。可选：查不到就不带。 */
  botName?: string
  botVersion: string
  /**
   * bot 包的外部地址（GitHub Release）和它的 sha256。**成对出现或都不出现**：包只在
   * Gateway 本机或私有 Blob 里时没有这两个字段，管家回落到 `/internal/bot-releases/*`。
   */
  botUrl?: string
  botSha256?: string
  vncPassword: string
  gatewayUrl: string
  gatewayToken: string
  gatewayApiKey: string
  ports: SeatPorts
  /**
   * 现在就重铺，别等席位把这一轮跑完（见 manager/src/seats.ts 的 drainSeat）。
   *
   * **不等于本地那个 `force`**：force 是「已经是这个版本也照铺」，模版下发也带着它，
   * 而那条路恰恰是该等的。只有人手工按的「重新部署」才把这个字段发下去。
   */
  interrupt?: boolean
  /** 允许管家花在排空上的毫秒数。由这次请求的超时算出来，见 deploySeat 里的 drainMs。 */
  drainMs?: number
}

/**
 * 管家说「席位正忙，这次没换版」。
 *
 * 单独一个类型，因为它和「部署失败」的处置完全相反：那边要把席位标红、留一行错误等人
 * 来看；这边什么都没发生，席位照旧在跑，人该做的只是晚点再来（或者按「重新部署」）。
 */
export class SeatBusyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SeatBusyError'
  }
}

/** 管家在我们给的时限里没回话（不是连不上——连不上是当场就知道的）。见 installSeat 的处置。 */
export class ManagerTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManagerTimeoutError'
  }
}

/**
 * 把一个席位交给管家去建。
 *
 * 这一整个函数取代了原来的 scp + ssh：发布包不再逐席位推过去，管家自己按版本从
 * Gateway 拉一次、全机共享；`smt_` 走 `x-satuwork-machine` 头，和管家转发给 bot 的
 * `authorization` 分开——两层鉴权互不干扰。
 *
 * 15 分钟超时：第一次部署要 apt 装一整套桌面栈，慢是正常的。
 *
 * 批量重铺那条路（模版的「立即下发」）会传一个**短得多**的超时：那些席位都已经
 * ready，桌面栈早装好了，不该让一台卡住的机器把整条请求拖到十五分钟。
 */
export async function managerDeploy(machine: Machine, spec: SeatSpec, timeoutMs = DEPLOY_TIMEOUT_MS): Promise<void> {
  let res: Response
  try {
    res = await managerControlFetch(machine, `/seats/${encodeURIComponent(spec.seatId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(spec),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') {
      throw new ManagerTimeoutError(`管家 ${Math.round(timeoutMs / 1000)} 秒内没装完，机器上多半还在装，结局稍后补上`)
    }
    throw new Error('联系不上机器管家: ' + (e instanceof Error ? e.message : String(e)))
  }
  if (res.ok) return
  /**
   * **先读完再解析，最后才截。** 原先是 `text().slice(0, 400)` 之后再 JSON.parse——
   * 而真出错时这个响应体一定超过 400 字（里面整个席位记录都在），于是 JSON 被砍断、
   * parse 必然失败、回退成「把那段残缺 JSON 当错误存起来」。也就是说：**越是有内容的
   * 错误，越是拿不到内容**，界面上看到的是半句话加一个没闭合的花括号。真发生过。
   *
   * 上限放到 16 KiB：管家那侧已经把输出裁到 500 字级别，这里只需要够装下整个 JSON。
   */
  const text = (await res.text()).slice(0, 16_000)
  let message = text
  let busy = false
  try {
    const body = JSON.parse(text) as { error?: string; busy?: boolean; seat?: { lastError?: string } }
    busy = body.busy === true
    // 忙的那一条里 seat 是**没动过的**那一行（lastError 多半是上一次部署留下的），
    // 会把「有会话在跑」盖掉。这种时候只认 error。
    message = busy ? body.error || text : body.seat?.lastError || body.error || text
  } catch {}
  if (busy && res.status === 409) throw new SeatBusyError(tailOf(message, 900))
  throw new Error(`管家部署失败 ${res.status}: ${tailOf(message, 900)}`)
}

/** 拆席位：停单元、删 drop-in、删席位目录。账号和 ~/work 留着，别的席位还在用。 */
export async function managerRemoveSeat(machine: Machine, seatId: string): Promise<void> {
  if (!machinePaired(machine)) return
  const res = await managerControlFetch(machine, `/seats/${encodeURIComponent(seatId)}`, {
    method: 'DELETE',
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok && res.status !== 404) throw new Error(`管家拆席位失败 ${res.status}`)
}

/** 问管家还活着吗。配对回拨和界面上的「检查连通」都走它。 */
export async function managerHealth(
  host: string,
  opts: { token?: string; challenge?: string; timeoutMs?: number },
): Promise<{ ok: boolean; body?: Record<string, unknown>; error?: string }> {
  const base = host.replace(/\/$/, '')
  const q = opts.challenge ? `?challenge=${encodeURIComponent(opts.challenge)}` : ''
  try {
    const res = await fetch(`${base}/health${q}`, {
      // 探活也捎上「Gateway 现在在哪」：界面上那颗「保存并探活」于是顺带把地址教给
      // 管家——换了 Gateway 地址之后，那正是人第一个会去按的按钮。
      headers: opts.token ? { authorization: 'Bearer ' + opts.token, ...managerHeaders() } : {},
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    })
    if (!res.ok) return { ok: false, error: `管家返回 ${res.status}` }
    return { ok: true, body: (await res.json()) as Record<string, unknown> }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 探一下这个**公网直连地址**后面是不是一台管家。
 *
 * **绝不带机器票。** 这是它和 managerHealth 唯一也是最要紧的区别：`directUrl` 是
 * 管理员手输的公网域名，敲错一个字母就落到别人的服务器上——而 managerHealth 会把
 * `Authorization: Bearer smt_…` 和 Gateway 的公网地址一起送过去，等于把这台机器完整
 * 可用、可吊销的机器票交给那个域名的持有者。host 那条路上填的是内网地址，写错通常
 * 解析不到；这一条按定义就是公网域名，笔误落到真实第三方手里的概率高得多。
 *
 * 不带票反而**判得更准**：管家的 `/health` 没有票就是 401（见 manager/src/index.ts），
 * 所以「401」恰恰是「对面真是一台管家」的证据，而 200 / 404 / 连不上都说明这个地址
 * 指错了地方。比带着票去换一个 200 更能抓住笔误，还不用付出任何凭据。
 *
 * 只是给人看的提示，不作为任何判定的依据——浏览器连不连得上仍然只有真开一次桌面
 * 才知道。
 */
export async function probeDirectUrl(url: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(8000) })
    if (res.status === 401) return { ok: true }
    return { ok: false, error: `这个地址回的是 ${res.status}，不像是席位机器上的管家` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 管家报上来的一步：脚本自己写的中文短句，Gateway 一个字都不解释。 */
export interface SeatStep {
  step: number
  total: number
  label: string
  at: number
}

/**
 * 问管家「这个席位装到第几步了」。**问不到一律回 undefined**，不是错误。
 *
 * 这条路上「问不到」有一大把正常成因：管家太旧（没这条路）、脚本还没报出第一行、这一
 * 刻机器上根本没在装、网络抖了一下。它们对调用方是同一个决定——退回到粗进度，照旧
 * 把「已经装了几分钟」画出来。分开报只会让一屏等待的界面上多出几种吓人的说法。
 *
 * 超时压到 3 秒：这是每两秒问一次的东西，等一个卡住的管家没有任何意义。
 */
export async function seatStepOf(machine: Machine, seatId: string, timeoutMs = 3000): Promise<SeatStep | undefined> {
  if (!machinePaired(machine) || machine.protocol < MIN_PROGRESS_PROTOCOL) return undefined
  try {
    const res = await managerControlFetch(machine, `/seats/${encodeURIComponent(seatId)}/progress`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return undefined
    const body = (await res.json()) as { progress?: unknown }
    const p = body?.progress as Record<string, unknown> | null | undefined
    if (!p) return undefined
    const step = Number(p.step)
    const total = Number(p.total)
    const at = Number(p.at)
    if (!Number.isFinite(step) || !Number.isFinite(total) || total <= 0 || step <= 0 || step > total) return undefined
    return { step, total, label: String(p.label ?? '').slice(0, 80), at: Number.isFinite(at) ? at : Date.now() }
  } catch {
    return undefined
  }
}

/**
 * 太长就砍头，不砍尾。
 *
 * 这些消息里装的是脚本输出：进度在前，原因在后。从头截等于把唯一有用的那一段扔掉。
 */
export function tailOf(text: string, max: number): string {
  const s = (text || '').replace(/\s+/g, ' ').trim()
  return s.length <= max ? s : '…' + s.slice(-max)
}

export function sanitizeError(e: unknown, secrets: string[] = []): string {
  const raw = e instanceof Error ? e.message : String(e)
  return tailOf(stripSecrets(raw, secrets), 900) || '部署失败'
}
function stripSecrets(text: string, secrets: string | string[] = []): string {
  let s = text
  const list = typeof secrets === 'string' ? (secrets ? [secrets] : []) : secrets
  for (const secret of list) {
    if (secret) s = s.split(secret).join('***')
  }
  s = s.replace(/SSHPASS=\S+/g, 'SSHPASS=***')
  s = s.replace(/gatewayToken[=:]\S+/gi, 'gatewayToken=***')
  s = s.replace(/gatewayApiKey[=:]\S+/gi, 'gatewayApiKey=***')
  s = s.replace(/machineToken[=:]\S+/gi, 'machineToken=***')
  s = s.replace(/vncPassword[=:]\S+/gi, 'vncPassword=***')
  s = s.replace(/\bsat_[A-Za-z0-9_-]+/g, 'sat_***')
  s = s.replace(/\bsk_sw_[A-Za-z0-9_-]+/g, 'sk_sw_***')
  s = s.replace(/\bsmt_[A-Za-z0-9_-]+/g, 'smt_***')
  return s
}
