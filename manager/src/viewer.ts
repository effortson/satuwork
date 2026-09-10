import { createHash } from 'node:crypto'
import { verifyGatewaySigned } from './ticket.ts'

/**
 * 浏览器直连这台机器时的**看客**：拿登录 JWT 来，换回「这是哪个账号」。
 *
 * ── 为什么管家要认登录票 ────────────────────────────────────────────
 *
 * 对话那条 SSE 以前是浏览器 → Gateway → 管家 → bot，Gateway 在中间把登录票换成席位票
 * `sat_`。Gateway 要变成无状态的（docs/adr-gateway-vercel-neon.md），小时级的流不能再
 * 经过它，于是换票这件事只能挪到管家来做。bot 那边一行不改：它照旧只认 `sat_`。
 *
 * ── 两道闸 ─────────────────────────────────────────────────────────
 *
 * 1. **本地验签**（同桌面票那把钥匙、同一份 JWKS）。挡掉伪造的和过期的，不用外呼。
 * 2. **问 Gateway 一次 `/me`**。登录票默认活 7 天，而「停用账号」「重置口令」「停用公司」
 *    在 Gateway 那头都是每条请求现查库的（tokenRevokedAt、status）。管家没有库，只能问。
 *    答案按票缓存 60 秒——开一条流问一次，重连问一次，不是每帧都问。
 *
 * Gateway 够不着时**放行**：签名是真的、票没过期，只是问不到「有没有被吊销」。直连
 * 这条路存在的意义之一就是 Gateway 不在时对话照常；为了一个 7 天窗口里的吊销把它关掉，
 * 得不偿失。日志里留一句，别静默。
 */

export interface Viewer {
  accountId: string
}

const OK_TTL_MS = 60_000
/** 拒的也记一下：一张已吊销的票不该每次重连都让管家去敲一次 Gateway。 */
const DENY_TTL_MS = 10_000
const cache = new Map<string, { at: number; viewer: Viewer | null }>()
let warnedUnreachableAt = 0

function keyOf(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function sweep(now: number): void {
  if (cache.size < 256) return
  for (const [k, v] of cache) if (now - v.at > OK_TTL_MS) cache.delete(k)
}

/** 登录票 → 账号。验不过（或被 Gateway 拒了）一律 undefined。 */
export async function verifyLogin(token: string, gatewayUrl: string): Promise<Viewer | undefined> {
  if (!token || !gatewayUrl) return
  const now = Date.now()
  const key = keyOf(token)
  const hit = cache.get(key)
  if (hit && now - hit.at < (hit.viewer ? OK_TTL_MS : DENY_TTL_MS)) return hit.viewer ?? undefined

  const payload = await verifyGatewaySigned(token, gatewayUrl)
  // 登录票的形状：有 accountId、有 role、**没有** typ。桌面票（typ=satu-desktop）拿到
  // 这儿来一律不认——它只对一块屏有效，不代表一个人。
  if (!payload || payload.typ !== undefined) return
  const accountId = typeof payload.accountId === 'string' ? payload.accountId.trim() : ''
  if (!accountId || typeof payload.role !== 'string') return

  let viewer: Viewer | null = { accountId }
  try {
    const res = await fetch(`${gatewayUrl}/me`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    // 401/403 是 Gateway 明说「这张票不行了」；别的状态（5xx、网关抖动）当没问到。
    if (res.status === 401 || res.status === 403) viewer = null
  } catch {
    if (now - warnedUnreachableAt > 60_000) {
      warnedUnreachableAt = now
      console.error('satuwork-manager: 问不到 Gateway /me，直连的登录票只按签名放行')
    }
  }
  sweep(now)
  cache.set(key, { at: now, viewer })
  return viewer ?? undefined
}

/** 只给测试用：让下一次验证重新问 Gateway。 */
export function forgetViewers(): void {
  cache.clear()
}
