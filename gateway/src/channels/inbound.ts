import { randomBytes } from 'node:crypto'
import type { ChannelBinding, Db } from '../db.ts'
import { sha256Hex } from '../crypto.ts'
import { gatewayPublicUrlExplicit } from '../deploy.ts'
import { telegramDeleteWebhook, telegramSetWebhook } from './telegram.ts'

/**
 * Telegram 的消息怎么进来：**webhook 还是长轮询**。
 *
 * 长轮询是一条永不停的循环（每 30 秒一次 getUpdates 挂着等），Gateway 要变成无状态的
 * （docs/adr-gateway-vercel-neon.md §7 第 5 步），这条循环就得没有。webhook 正好相反：
 * Telegram 有事才来敲一下 `POST /channels/telegram/hook/:publicId`，一次请求一次响应，
 * 在函数里跑得很自然。
 *
 * 但 webhook 要一个 Telegram 够得着的 **https** 地址。本地开发和大多数 e2e 没有，所以两种
 * 模式都留着，按环境挑：
 *
 *   · `GATEWAY_TELEGRAM_WEBHOOK_BASE` 有值 → 用它拼地址（e2e 拿假 Telegram 时用 http 也行）；
 *   · 否则 `GATEWAY_PUBLIC_URL` 是 https → 用它；
 *   · 否则长轮询，和以前一模一样。
 *
 * 切换是**双向、自愈**的：长轮询扫到一条该走 webhook 的绑定就给它设上，之后不再轮询它；
 * 模式关掉之后扫到一条还挂着 webhook 的绑定就把 webhook 删掉，恢复轮询（见 channels.ts
 * 的 poll）。所以升级不用停机迁移，改一个环境变量重启就换过去。
 *
 * 认 Telegram 靠 `secret_token`：设 webhook 时随机一把，只存 sha256（`webhookSecretHash`，
 * 这一列 0028 就建了、一直空着）；每条推送头上带明文，比一次散列。空散列 = 这条绑定走轮询。
 */

export function telegramWebhookBase(): string {
  const forced = (process.env.GATEWAY_TELEGRAM_WEBHOOK_BASE || '').trim().replace(/\/$/, '')
  if (forced) return forced
  const explicit = gatewayPublicUrlExplicit()
  return /^https:\/\//i.test(explicit) ? explicit : ''
}

export function telegramWebhookMode(): boolean {
  return Boolean(telegramWebhookBase())
}

export function telegramWebhookUrl(publicId: string): string {
  return `${telegramWebhookBase()}/channels/telegram/hook/${encodeURIComponent(publicId)}`
}

/**
 * 把这条绑定的收信方式对齐到当前模式。绑定、重连、以及轮询扫到不对的时候都调它。
 * 返回之后 `webhookSecretHash` 就是真相：非空走 webhook，空走轮询。
 */
export async function ensureTelegramInbound(db: Db, binding: ChannelBinding, token: string): Promise<ChannelBinding> {
  if (telegramWebhookMode()) {
    const secret = randomBytes(24).toString('base64url')
    await telegramSetWebhook(token, telegramWebhookUrl(binding.publicId), secret)
    return db.updateChannelBinding(binding.id, { webhookSecretHash: sha256Hex(secret), pollLeaseUntil: null, pollLastError: null })
  }
  // getUpdates 和 webhook 互斥；轮询模式下显式清掉，否则 getUpdates 会被 Telegram 以 409 顶回来。
  await telegramDeleteWebhook(token, false)
  if (!binding.webhookSecretHash) return binding
  return db.updateChannelBinding(binding.id, { webhookSecretHash: '' })
}

/** 一条推送头上的 secret 对不对。空散列的绑定不收推送——它在走轮询。 */
export function telegramWebhookSecretOk(binding: ChannelBinding, given: string): boolean {
  if (!binding.webhookSecretHash || !given) return false
  const a = Buffer.from(sha256Hex(given))
  const b = Buffer.from(binding.webhookSecretHash)
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}
