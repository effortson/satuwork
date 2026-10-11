/**
 * 手机推送：Gateway 直连 APNs（docs/adr-core-package-mobile.md §2.5）。
 *
 * **谁触发**：席位在一轮跑完、审批进入等待时报一条 `POST /internal/push`（routes/internal.ts）；
 * 转人工的新单由 `/internal/handoffs` 那条顺手推给接手人。Gateway 不经手对话流，它知道
 * 「这一轮跑完了」只能靠席位说。
 *
 * **推什么**：只推「哪颗 Bot、什么事」，**不推对话正文**。正文在席位机器上，Gateway 本来就
 * 不该看到；推送内容还会过 Apple 的服务器、躺在锁屏上。人点开通知，进的是对话页，正文在
 * 那儿从席位直连取。
 *
 * **怎么发**：APNs 的 HTTP/2 接口 + token 认证（.p8 钥匙签 ES256 的 JWT）。没用第三方推送
 * 服务——原定经 Expo push service，不用 Expo 之后就是直连。Android（FCM）还没做，登记只收 ios。
 *
 * 环境变量（缺任何一个就不发，只记一行日志；功能在没配的环境里等于关着）：
 *
 * - `GATEWAY_APNS_KEY`：App Store Connect 下载的 .p8 全文（PEM）；放不下换行的平台可以整段 base64。
 * - `GATEWAY_APNS_KEY_ID`、`GATEWAY_APNS_TEAM_ID`：那把钥匙的 Key ID 与开发团队 ID。
 * - `GATEWAY_APNS_TOPIC`：应用的 bundle id，默认 `sg.dami.satuwork.mobile`（mobile/src-tauri/tauri.conf.json）。
 * - `GATEWAY_APNS_ENDPOINT`：只给 e2e 用，把 sandbox / production 两头都指到一个本地假 APNs（h2c）。
 */
import { connect, constants, type ClientHttp2Session } from 'node:http2'
import { createPrivateKey, sign, type KeyObject } from 'node:crypto'
import type { Db } from '../db.ts'

export type PushPlatform = 'ios'
export type PushEnvironment = 'sandbox' | 'production'
export const PUSH_PLATFORMS: readonly string[] = ['ios']
export const PUSH_ENVIRONMENTS: readonly string[] = ['sandbox', 'production']

/** APNs 设备令牌：十六进制，现在是 64 位，Apple 说过会变长，留到 200。 */
export function validPushToken(t: string): boolean {
  return /^[0-9a-fA-F]{32,200}$/.test(t)
}

export interface PushMessage {
  title: string
  body: string
  /** 原样放进 payload 顶层，客户端点通知时据此跳页（botId、kind）。只放短字符串。 */
  data: Record<string, string>
  /** 同一个 collapse id 的通知后到的覆盖先到的：同一颗 Bot 连着跑完三轮，锁屏上只留一条。 */
  collapseId?: string
  /** iOS 通知中心按它分组。 */
  threadId?: string
}

/**
 * 推什么事。turn-end / approval 由席位报（/internal/push），handoff 由 /internal/handoffs 顺手发。
 * 加一种要同时改 bot 那头的上报和手机壳里点通知的跳转。
 */
export type PushKind = 'turn-end' | 'approval' | 'handoff'
export const PUSH_KINDS: ReadonlySet<string> = new Set<PushKind>(['turn-end', 'approval', 'handoff'])

const PUSH_TEXT: Record<PushKind, { zh: string; en: string }> = {
  'turn-end': { zh: '回复好了', en: 'Replied' },
  approval: { zh: '在等你批准一个操作', en: 'Waiting for your approval' },
  handoff: { zh: '转给你一件事，需要人来接手', en: 'Handed something over to you' },
}

/**
 * 一条推送长什么样。标题是 Bot 的名字，正文是一句固定的话——**不带对话内容**（见文件头）。
 * collapse id 按「Bot + 事」：同一颗 Bot 连跑完三轮，锁屏上只留最新那条；审批和回复各留各的。
 */
export function pushMessage(kind: PushKind, botName: string, botId: string, locale: string): PushMessage {
  const en = locale === 'en'
  const text = PUSH_TEXT[kind]
  return {
    title: botName || 'Satuwork',
    body: en ? text.en : text.zh,
    data: { kind, botId },
    collapseId: botId ? `${kind}:${botId}` : undefined,
    threadId: botId || undefined,
  }
}

export interface PushResult {
  sent: number
  /** APNs 说令牌作废、已经从库里摘掉的。 */
  dropped: number
  failed: number
  /** 一条都没发的原因（没配、账号停用、没登记设备）。 */
  skipped?: string
}

interface ApnsConfig {
  key: KeyObject
  keyId: string
  teamId: string
  topic: string
  endpoint: string | null
}

let warnedUnconfigured = false

function apnsConfig(): ApnsConfig | null {
  const raw = (process.env.GATEWAY_APNS_KEY || '').trim()
  const keyId = (process.env.GATEWAY_APNS_KEY_ID || '').trim()
  const teamId = (process.env.GATEWAY_APNS_TEAM_ID || '').trim()
  if (!raw || !keyId || !teamId) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true
      console.warn('satuwork-gateway: APNs 没配（GATEWAY_APNS_KEY / _KEY_ID / _TEAM_ID），手机推送不发')
    }
    return null
  }
  const pem = raw.includes('BEGIN') ? raw : Buffer.from(raw, 'base64').toString('utf8')
  let key: KeyObject
  try {
    key = createPrivateKey(pem)
  } catch (e) {
    console.warn(`satuwork-gateway: GATEWAY_APNS_KEY 读不出钥匙：${(e as Error).message}`)
    return null
  }
  return {
    key,
    keyId,
    teamId,
    topic: (process.env.GATEWAY_APNS_TOPIC || '').trim() || 'sg.dami.satuwork.mobile',
    endpoint: (process.env.GATEWAY_APNS_ENDPOINT || '').trim() || null,
  }
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url')
}

/**
 * APNs 的 provider token。Apple 要求 20～60 分钟之间换一次：太勤会被 429
 * （TooManyProviderTokenUpdates），过期了回 403 ExpiredProviderToken。缓存 40 分钟。
 */
let tokenCache: { keyId: string; teamId: string; jwt: string; at: number } | null = null
const PROVIDER_TOKEN_TTL_MS = 40 * 60_000

export function providerToken(cfg: Pick<ApnsConfig, 'key' | 'keyId' | 'teamId'>, now = Date.now()): string {
  if (tokenCache && tokenCache.keyId === cfg.keyId && tokenCache.teamId === cfg.teamId && now - tokenCache.at < PROVIDER_TOKEN_TTL_MS) {
    return tokenCache.jwt
  }
  const head = b64url(JSON.stringify({ alg: 'ES256', kid: cfg.keyId }))
  const claims = b64url(JSON.stringify({ iss: cfg.teamId, iat: Math.floor(now / 1000) }))
  const input = `${head}.${claims}`
  // JWT 的 ES256 签名是 r‖s 各 32 字节，不是 DER——Node 默认给 DER，得显式要 ieee-p1363。
  const sig = sign('sha256', Buffer.from(input), { key: cfg.key, dsaEncoding: 'ieee-p1363' })
  const jwt = `${input}.${b64url(sig)}`
  tokenCache = { keyId: cfg.keyId, teamId: cfg.teamId, jwt, at: now }
  return jwt
}

function hostOf(cfg: ApnsConfig, env: string): string {
  if (cfg.endpoint) return cfg.endpoint
  return env === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com'
}

/** 这几种回答说的是「这个令牌不用再试了」，摘掉。别的错（限流、证书、超时）留着下次再发。 */
const DEAD_TOKEN_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic', 'ExpiredToken'])

const REQUEST_TIMEOUT_MS = 10_000

function postOne(
  session: ClientHttp2Session,
  path: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; reason: string }> {
  return new Promise((resolve) => {
    let settled = false
    const done = (v: { status: number; reason: string }) => {
      if (settled) return
      settled = true
      resolve(v)
    }
    let req
    try {
      req = session.request({ [constants.HTTP2_HEADER_METHOD]: 'POST', [constants.HTTP2_HEADER_PATH]: path, ...headers })
    } catch (e) {
      done({ status: 0, reason: (e as Error).message })
      return
    }
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.close(constants.NGHTTP2_CANCEL)
      done({ status: 0, reason: 'timeout' })
    })
    let status = 0
    let text = ''
    req.on('response', (h) => {
      status = Number(h[constants.HTTP2_HEADER_STATUS]) || 0
    })
    req.setEncoding('utf8')
    req.on('data', (c: string) => {
      if (text.length < 4096) text += c
    })
    req.on('end', () => {
      let reason = ''
      try {
        reason = String((JSON.parse(text || '{}') as { reason?: unknown }).reason || '')
      } catch {}
      done({ status, reason })
    })
    req.on('error', (e) => done({ status: 0, reason: e.message }))
    req.end(body)
  })
}

/**
 * 给一个账号登记过的所有 iOS 设备各发一条。
 *
 * **只发给还活着的登录**：登记时刻早于账号的 tokenRevokedAt（改了口令、被重置）的那些跳过——
 * 那台手机上的票已经作废了，通知不该还往那儿送。停用的账号一条不发。
 *
 * 每次调用开一条 HTTP/2 连接、发完关掉。不留常驻连接：Vercel 上实例随时会被冻住，
 * 挂着的连接下次醒来多半是死的；一个人手里也就一两台设备，握手那点开销不值得为它管连接池。
 */
export async function pushToAccount(db: Db, accountId: string, msg: PushMessage): Promise<PushResult> {
  const result: PushResult = { sent: 0, dropped: 0, failed: 0 }
  const account = await db.account(accountId)
  if (!account || account.status !== 'active') return { ...result, skipped: '账号不可用' }
  const revokedAt = Number(account.tokenRevokedAt || 0)
  const devices = (await db.pushDevicesOf(accountId)).filter((d) => d.platform === 'ios' && d.updatedAt > revokedAt)
  if (!devices.length) return { ...result, skipped: '没有登记设备' }
  const cfg = apnsConfig()
  if (!cfg) return { ...result, skipped: 'APNs 没配' }

  const payload = JSON.stringify({
    ...msg.data,
    aps: {
      alert: { title: msg.title.slice(0, 120), body: msg.body.slice(0, 240) },
      sound: 'default',
      ...(msg.threadId ? { 'thread-id': msg.threadId } : {}),
    },
  })

  // 按目标主机分组：sandbox 和 production 是两台不同的服务器，各开一条连接。
  const byHost = new Map<string, typeof devices>()
  for (const d of devices) {
    const host = hostOf(cfg, d.environment)
    byHost.set(host, [...(byHost.get(host) || []), d])
  }
  for (const [host, list] of byHost) {
    let session: ClientHttp2Session
    try {
      session = connect(host)
    } catch (e) {
      console.warn(`satuwork-gateway: 连不上 APNs ${host}：${(e as Error).message}`)
      result.failed += list.length
      continue
    }
    session.on('error', () => {})
    try {
      for (const d of list) {
        const headers: Record<string, string> = {
          authorization: `bearer ${providerToken(cfg)}`,
          'apns-topic': cfg.topic,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'content-type': 'application/json',
        }
        if (msg.collapseId) headers['apns-collapse-id'] = msg.collapseId.slice(0, 64)
        const r = await postOne(session, `/3/device/${d.token}`, headers, payload)
        if (r.status === 200) {
          result.sent++
        } else if (r.status === 410 || (r.status === 400 && DEAD_TOKEN_REASONS.has(r.reason))) {
          await db.dropPushDevice(d.token)
          result.dropped++
        } else {
          // 403 ExpiredProviderToken：下一次重签。别的照实记一行，令牌留着。
          if (r.reason === 'ExpiredProviderToken' || r.reason === 'InvalidProviderToken') tokenCache = null
          console.warn(`satuwork-gateway: APNs 拒了一条推送（${r.status} ${r.reason || '无原因'}）`)
          result.failed++
        }
      }
    } finally {
      session.close()
    }
  }
  return result
}
