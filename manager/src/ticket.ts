import { createPublicKey, verify } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { patchState, readState } from './config.ts'

/**
 * 桌面 ticket。
 *
 * 浏览器要直连管家看 noVNC，而它手里没有 `smt_`（那是 Gateway 的机器票，绝不能进
 * 浏览器）。所以 Gateway 用自己的 JWT 私钥签一张只活几分钟、只对一个席位有效的票，
 * 管家用 Gateway 的公钥验。
 *
 * 验签自己写，不引依赖——照 gateway/src/crypto.ts:113 那份的写法，RS256 就是
 * `verify('sha256', h.p, pubkey, sig)`。
 */

export interface Ticket {
  typ: string
  seatId: string
  exp: number
  /** 席位的 VNC 口令。Gateway 签在票里，管家原样转给 noVNC 自动填。 */
  vnc?: string
}

function b64urlJson(part: string): unknown {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
}

/**
 * 未知 kid 的负缓存：kid → 什么时候查过。
 *
 * 验票是浏览器直连那条路，谁都能发一张 kid 随便写的票过来；没有这层，每一张都会让
 * 管家外呼一次 Gateway 再写一次盘。同一个 kid 60 秒内只问一次——Gateway 真轮换了密钥，
 * 一分钟后照样认得。
 */
const UNKNOWN_KID_TTL_MS = 60_000
const unknownKids = new Map<string, number>()
/** 同一时刻只让一路去抓 JWKS：一屏 noVNC 起来是一串并发请求，不该变成一串并发外呼。 */
let jwksInflight: Promise<{ keys: Record<string, unknown>[] } | undefined> | null = null

async function jwksOf(gatewayUrl: string, kid: string): Promise<Record<string, unknown> | undefined> {
  const state = readState()
  const find = (set: { keys: Record<string, unknown>[] } | null) =>
    set?.keys?.find((k) => k.kid === kid) ?? undefined
  const cached = find(state?.jwks ?? null)
  if (cached) return cached
  const asked = unknownKids.get(kid)
  if (asked !== undefined && Date.now() - asked < UNKNOWN_KID_TTL_MS) return
  unknownKids.set(kid, Date.now())
  // 别让这张表无限长：过期的顺手清掉。
  for (const [k, at] of unknownKids) if (Date.now() - at >= UNKNOWN_KID_TTL_MS) unknownKids.delete(k)
  // kid 对不上就再抓一次：Gateway 轮换密钥之后不该要求管家重装。
  try {
    jwksInflight ??= (async () => {
      const res = await fetch(`${gatewayUrl}/.well-known/jwks.json`, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) return
      return (await res.json()) as { keys: Record<string, unknown>[] }
    })().finally(() => {
      jwksInflight = null
    })
    const fresh = await jwksInflight
    if (!fresh) return
    // patchState 现读现写，而且只在 keys 真变了时才落盘——原来是拿函数开头那份快照整份
    // 写回，会把期间别处写的字段（confirmedVersion 等）抹掉，而且每张未知 kid 的票都写一次。
    patchState((s) => (JSON.stringify(s.jwks?.keys ?? null) === JSON.stringify(fresh.keys ?? null) ? undefined : { jwks: fresh }))
    const hit = find(fresh)
    if (hit) unknownKids.delete(kid)
    return hit
  } catch {
    return
  }
}

/**
 * Gateway 签的任何一张 JWT：验签、验 exp，把 payload 交出来。**不看 typ**——那是调用方
 * 的事：桌面票要 `satu-desktop`，登录票没有 typ（见 verifyLogin）。两种票同一把钥匙、
 * 同一份 JWKS、同一套 kid 轮换，验签这一段没理由写两遍。
 *
 * 验不过一律返回 undefined，不区分原因——区分了就是在告诉攻击者哪一步错了。
 */
export async function verifyGatewaySigned(token: string, gatewayUrl: string): Promise<Record<string, unknown> | undefined> {
  const parts = (token || '').split('.')
  if (parts.length !== 3) return
  const [h, p, s] = parts
  let kid: string
  try {
    kid = String((b64urlJson(h) as { kid?: string }).kid || '')
  } catch {
    return
  }
  if (!kid) return
  const jwk = await jwksOf(gatewayUrl, kid)
  if (!jwk) return
  let ok = false
  try {
    const key = createPublicKey({ key: jwk as never, format: 'jwk' })
    ok = verify('sha256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))
  } catch {
    return
  }
  if (!ok) return
  let payload: Record<string, unknown>
  try {
    const raw = b64urlJson(p)
    if (!raw || typeof raw !== 'object') return
    payload = raw as Record<string, unknown>
  } catch {
    return
  }
  const exp = payload.exp
  if (!(typeof exp === 'number') || !Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return
  return payload
}

/**
 * 日志票。Gateway 签给浏览器直连跟日志用的：`unit` 说看哪个单元，`seat` 必带 seatId，
 * `manager` 不带。和桌面票同一把钥匙、同一份 JWKS，只差 typ——**桌面票在这里过不了**，
 * 反过来也一样：一张票只开一扇门。
 */
export interface LogsTicket {
  typ: 'satu-logs'
  unit: 'seat' | 'manager'
  seatId?: string
  exp: number
}

/** 桌面票。验不过一律返回 undefined。 */
export async function verifyTicket(token: string, gatewayUrl: string): Promise<Ticket | undefined> {
  const payload = await verifyGatewaySigned(token, gatewayUrl)
  if (!payload) return
  if (payload.typ !== 'satu-desktop') return
  if (!payload.seatId || typeof payload.seatId !== 'string') return
  return payload as unknown as Ticket
}

/** 日志票。验不过一律返回 undefined；`unit === 'seat'` 而没有 seatId 也算验不过。 */
export async function verifyLogsTicket(token: string, gatewayUrl: string): Promise<LogsTicket | undefined> {
  const payload = await verifyGatewaySigned(token, gatewayUrl)
  if (!payload) return
  if (payload.typ !== 'satu-logs') return
  if (payload.unit === 'seat') {
    if (!payload.seatId || typeof payload.seatId !== 'string') return
  } else if (payload.unit !== 'manager') return
  return payload as unknown as LogsTicket
}

export const cookieName = (seatId: string) => `satu_desk_${seatId.replace(/[^A-Za-z0-9_-]/g, '')}`

export function cookieOf(req: IncomingMessage, name: string): string {
  const raw = req.headers.cookie
  if (!raw) return ''
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return ''
}
