/**
 * 登录类接口的失败限流：`/auth/login`、`/invites/:token/accept`、`/me/password`。
 *
 * 以前这几条没有任何节流，谁都能对着一个邮箱无限猜口令。
 *
 * ## 计数放在库里
 *
 * Vercel 上是多个函数实例、没有常驻进程也没有定时器（docs/adr-gateway-vercel-neon.md），
 * 进程内的计数器每个实例各数各的，等于没限。所以一行一个桶放在 `auth_throttle`（迁移
 * 0046），固定窗口，原子 upsert。过期行由 maintenanceTick 顺手收掉——不收也不影响对错，
 * 到期的行下一次碰到时就地从 1 数起。
 *
 * ## 只数失败
 *
 * 做法是**先记一次、再评判、对了退回去**：先记是为了并发——十条请求同时打进来各自拿到
 * 1..10，不会一起读到「还差一次」然后全部放行；对了退回去，所以净数下来只有失败。
 * 被 429 挡下的那一次也退回去：它没被评判，不该让挡在 IP 桶上的请求替邮箱桶再记一笔。
 *
 * ## 代价：别人能把你锁在门外一会儿
 *
 * 邮箱桶只看邮箱不看来源——否则换个 IP 就能接着猜，这一层就白做了。反过来就是：知道你
 * 邮箱的人连着输错 10 次，你在这 15 分钟里也登不进来（口令对也不行，锁住期间根本不去
 * 验，免得这扇门变成「猜对了就放行」的判定器）。取的是短窗口、自动解开、不需要管理员
 * 介入；持续锁一个人需要持续地打，而那会先撞上 IP 桶。真要更细（按「邮箱 + 设备」区分
 * 已知设备）以后再说。
 *
 * IP 桶放宽：同一个出口 NAT 后面可能是整间办公室。来源地址用 runtime.ts 的 sourceIpOf：
 * Debian 上默认只信 socket，挂了反代要配 `GATEWAY_TRUSTED_PROXIES`；Vercel 上要开
 * `GATEWAY_TRUST_FORWARDED=1`——不开的话所有人共用平台内网那一个地址，IP 桶就成了全站一个桶。
 *
 * 数值都能用环境变量改，e2e 靠这个把窗口缩到几秒。
 */
import { HttpError, type Req } from '../http.ts'
import type { Db } from '../db.ts'
import { sourceIpOf } from './runtime.ts'

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isInteger(n) && n > 0 ? n : fallback
}

const WINDOW_MS = envInt('GATEWAY_AUTH_WINDOW_MS', 15 * 60_000)
/** 同一个邮箱（或同一个账号改口令）一窗口里最多错几次。 */
const MAX_ACCOUNT_FAILS = envInt('GATEWAY_AUTH_MAX_ACCOUNT_FAILS', 10)
/** 同一个来源地址一窗口里最多错几次（登录和领邀请算在一起）。 */
const MAX_IP_FAILS = envInt('GATEWAY_AUTH_MAX_IP_FAILS', 100)

export type ThrottleKey = { key: string; max: number }

export const throttleKeys = {
  email: (email: string): ThrottleKey => ({ key: `email:${email.trim().toLowerCase()}`, max: MAX_ACCOUNT_FAILS }),
  ip: (req: Req): ThrottleKey => ({ key: `ip:${sourceIpOf(req) || 'unknown'}`, max: MAX_IP_FAILS }),
  password: (accountId: string): ThrottleKey => ({ key: `pw:${accountId}`, max: MAX_ACCOUNT_FAILS }),
}

/**
 * 进门先记一次。任何一个桶超了就退回全部、回 429（http.ts 按 retryAfter 写 Retry-After 头）。
 *
 * 返回的函数是「这次评判完了」：`ok` 为 true 时退回 IP 桶、清空 `clear` 里那几个桶；
 * 为 false 时什么都不做——失败就留在计数里。调用方**必须**在所有路径上调一次（try/finally），
 * 抛错（口令对不对还没判出来）按 `ok: true` 退回，不算失败。
 */
export async function enterThrottle(
  db: Db,
  keys: ThrottleKey[],
): Promise<(result: { ok: boolean; clear?: ThrottleKey[] }) => Promise<void>> {
  const now = Date.now()
  const rows = await db.bumpAuthThrottle(keys.map((k) => k.key), now, WINDOW_MS)
  const over = rows.filter((r) => r.count > (keys.find((k) => k.key === r.key)?.max ?? Infinity))
  if (over.length) {
    await db.refundAuthThrottle(keys.map((k) => k.key))
    const until = Math.max(...over.map((r) => r.resetAt))
    const seconds = Math.max(1, Math.ceil((until - now) / 1000))
    throw new HttpError(429, `尝试次数太多，请 ${waitText(seconds)}后再试`, { retryAfter: seconds })
  }
  let done = false
  return async ({ ok, clear = [] }) => {
    if (done) return
    done = true
    if (!ok) return
    const cleared = new Set(clear.map((k) => k.key))
    await db.refundAuthThrottle(keys.map((k) => k.key).filter((k) => !cleared.has(k)))
    await db.clearAuthThrottle([...cleared])
  }
}

function waitText(seconds: number): string {
  return seconds < 60 ? `${seconds} 秒` : `${Math.ceil(seconds / 60)} 分钟`
}

/** maintenanceTick 顺手收掉到期的桶。 */
export function sweepAuthThrottle(db: Db): Promise<void> {
  return db
    .sweepAuthThrottle(Date.now())
    .then(() => undefined)
    .catch((e: Error) => console.error(`satuwork-gateway: 清扫登录限流计数失败：${e.message}`))
}
