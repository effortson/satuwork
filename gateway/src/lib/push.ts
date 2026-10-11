/**
 * 手机推送：Gateway 直连 APNs（iOS）和 FCM（Android）（docs/adr-core-package-mobile.md §2.5）。
 *
 * **谁触发**：席位在一轮跑完、审批进入等待时报一条 `POST /internal/push`（routes/internal.ts）；
 * 转人工的新单由 `/internal/handoffs` 那条顺手推给接手人。Gateway 不经手对话流，它知道
 * 「这一轮跑完了」只能靠席位说。
 *
 * **推什么**：只推「哪颗 Bot、什么事」，**不推对话正文**。正文在席位机器上，Gateway 本来就
 * 不该看到；推送内容还会过 Apple 的服务器、躺在锁屏上。人点开通知，进的是对话页，正文在
 * 那儿从席位直连取。
 *
 * **怎么发**：iOS 走 APNs 的 HTTP/2 接口 + token 认证（.p8 钥匙签 ES256 的 JWT）；Android 走 FCM 的
 * HTTP v1 接口，服务账号私钥签 RS256 的 JWT 换 OAuth2 access token。没用第三方推送服务——原定经
 * Expo push service，不用 Expo 之后就是直连两家。
 *
 * 环境变量（缺了哪一家就不发那一家，只记一行日志；功能在没配的环境里等于关着）：
 *
 * - `GATEWAY_APNS_KEY`：App Store Connect 下载的 .p8 全文（PEM）；放不下换行的平台可以整段 base64。
 * - `GATEWAY_APNS_KEY_ID`、`GATEWAY_APNS_TEAM_ID`：那把钥匙的 Key ID 与开发团队 ID。
 * - `GATEWAY_APNS_TOPIC`：应用的 bundle id，默认 `sg.dami.satuwork.mobile`（mobile/src-tauri/tauri.conf.json）。
 * - `GATEWAY_APNS_ENDPOINT`：只给 e2e 用，把 sandbox / production 两头都指到一个本地假 APNs（h2c）。
 * - `GATEWAY_FCM_SERVICE_ACCOUNT`：Firebase 控制台「项目设置 → 服务账号」生成的私钥 JSON 全文，
 *   或整段 base64。项目 ID、client_email、私钥、换票地址（token_uri）都从里面读。
 * - `GATEWAY_FCM_ENDPOINT`：只给 e2e 用，把 fcm.googleapis.com 换成本地假 FCM。
 */
import { connect, constants, type ClientHttp2Session } from 'node:http2'
import { createPrivateKey, sign, type KeyObject } from 'node:crypto'
import type { Db } from '../db.ts'
import { JWT_TTL } from './validate.ts'

export type PushPlatform = 'ios' | 'android'
export type PushEnvironment = 'sandbox' | 'production'
export const PUSH_PLATFORMS: readonly string[] = ['ios', 'android']
export const PUSH_ENVIRONMENTS: readonly string[] = ['sandbox', 'production']

/**
 * 设备令牌长得像不像。
 *
 * - APNs：十六进制。真机现在是 64 位，模拟器给的是 160 位，Apple 说过会变长，留到 200。
 * - FCM：`<实例 id>:<一长串 base64url>`，一百多到两百多个字符，留到 4096。
 *
 * 不认平台的老调用（DELETE 那条只拿得到令牌）两种都试。两种互斥：纯十六进制的只算 APNs。
 */
export function validPushToken(t: string, platform?: string): boolean {
  const apns = /^[0-9a-fA-F]{32,200}$/.test(t)
  // 纯十六进制的不算 FCM 令牌：那是 APNs 令牌报成了 android，收下来只会让 FCM 回一句 400。
  const fcm = /^[A-Za-z0-9_:-]{20,4096}$/.test(t) && !apns
  if (platform === 'ios') return apns
  if (platform === 'android') return fcm
  return apns || fcm
}

/** 落库前的统一写法：APNs 令牌大小写不敏感，一律小写；FCM 令牌区分大小写，原样存。 */
export function normalizePushToken(t: string): string {
  return /^[0-9a-fA-F]+$/.test(t) ? t.toLowerCase() : t
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
  /** 一条都没发的原因（没配、账号停用、没登记设备）。给人看的，会改措辞，程序别比对它。 */
  skipped?: string
  /**
   * 这个账号眼下收不到推送（停用了、没登记设备），席位可以先别再问——bot 那头据此安静两分钟
   * （bot/src/session/gateway.ts 的 reportPush）。以前它比对 skipped 的中文原文，改一个字就悄悄失效。
   */
  quiet?: boolean
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

/**
 * 推送在 APNs / FCM 那边最多存多久。手机离线时两家都会替我们存着、上线再补发，不设的话 APNs 至少
 * 投一次、FCM 默认存四周——三小时后补到的「回复好了」只会骗人回去看一条早就看过的消息（bot 那头
 * 不重试也是这个理由）。一小时：地铁里断网一阵回来还收得到，隔夜的就不要了。
 */
export const PUSH_TTL_SECONDS = 3600

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

type DeviceRow = { token: string; platform: string; environment: string; updatedAt: number }

/** 这一条登记背后的登录还活着吗。理由见 pushToAccount。 */
export function liveRegistration(updatedAt: number, revokedAt: number, now: number, ttlSeconds = JWT_TTL): boolean {
  return updatedAt > revokedAt && now - updatedAt < ttlSeconds * 1000
}

/**
 * 给一个账号登记过的所有设备各发一条：iOS 的走 APNs，Android 的走 FCM。
 *
 * **只发给还活着的登录**，两种死法都跳过：
 *
 * - 登记时刻早于账号的 tokenRevokedAt（改了口令、被重置）：那台手机上的票已经作废了。
 * - 最近一次登记已经是一张票的寿命（JWT_TTL）以前：票不续期，过期了就得重新登录，而重新登录
 *   一定会再登记一次（gateway/ui/shell.js 的 syncMobilePush）。所以这么久没再登记过，名下那张票
 *   必然已经过期。退出登录时的注销（DELETE）偏偏就在票过期的那次 401 里发不出去，靠这一条兜住。
 *
 * 停用的账号一条不发。
 */
export async function pushToAccount(db: Db, accountId: string, msg: PushMessage, now = Date.now()): Promise<PushResult> {
  const result: PushResult = { sent: 0, dropped: 0, failed: 0 }
  const account = await db.account(accountId)
  if (!account || account.status !== 'active') return { ...result, skipped: '账号不可用', quiet: true }
  const revokedAt = Number(account.tokenRevokedAt || 0)
  const devices = (await db.pushDevicesOf(accountId)).filter((d) => liveRegistration(d.updatedAt, revokedAt, now))
  const ios = devices.filter((d) => d.platform === 'ios')
  const android = devices.filter((d) => d.platform === 'android')
  if (!ios.length && !android.length) return { ...result, skipped: '没有登记设备', quiet: true }

  const skipped: string[] = []
  if (ios.length) {
    const cfg = apnsConfig()
    if (cfg) await sendApns(db, cfg, ios, msg, result)
    else skipped.push('APNs 没配')
  }
  if (android.length) {
    const cfg = fcmConfig()
    if (cfg) await sendFcm(db, cfg, android, msg, result)
    else skipped.push('FCM 没配')
  }
  if (skipped.length && !result.sent && !result.dropped && !result.failed) result.skipped = skipped.join('；')
  return result
}

/**
 * iOS：每次调用开一条 HTTP/2 连接、发完关掉。不留常驻连接：Vercel 上实例随时会被冻住，
 * 挂着的连接下次醒来多半是死的；一个人手里也就一两台设备，握手那点开销不值得为它管连接池。
 */
async function sendApns(db: Db, cfg: ApnsConfig, devices: DeviceRow[], msg: PushMessage, result: PushResult): Promise<void> {
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
          // 绝对时刻（Unix 秒），过了 APNs 就丢掉不再投。
          'apns-expiration': String(Math.floor(Date.now() / 1000) + PUSH_TTL_SECONDS),
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
}

// ── FCM（Android）────────────────────────────────────────────────────────

interface FcmConfig {
  projectId: string
  clientEmail: string
  key: KeyObject
  tokenUri: string
  endpoint: string
}

let warnedFcmUnconfigured = false

function fcmConfig(): FcmConfig | null {
  const raw = (process.env.GATEWAY_FCM_SERVICE_ACCOUNT || '').trim()
  if (!raw) {
    if (!warnedFcmUnconfigured) {
      warnedFcmUnconfigured = true
      console.warn('satuwork-gateway: FCM 没配（GATEWAY_FCM_SERVICE_ACCOUNT），Android 推送不发')
    }
    return null
  }
  try {
    const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')
    const sa = JSON.parse(text) as { project_id?: string; client_email?: string; private_key?: string; token_uri?: string }
    if (!sa.project_id || !sa.client_email || !sa.private_key) throw new Error('缺 project_id / client_email / private_key')
    return {
      projectId: sa.project_id,
      clientEmail: sa.client_email,
      key: createPrivateKey(sa.private_key),
      tokenUri: sa.token_uri || 'https://oauth2.googleapis.com/token',
      endpoint: ((process.env.GATEWAY_FCM_ENDPOINT || '').trim() || 'https://fcm.googleapis.com').replace(/\/$/, ''),
    }
  } catch (e) {
    console.warn(`satuwork-gateway: GATEWAY_FCM_SERVICE_ACCOUNT 读不出来：${(e as Error).message}`)
    return null
  }
}

/** OAuth2 access token，Google 给一小时，提前一分钟换。按服务账号认，换了账号不串。 */
let fcmTokenCache: { clientEmail: string; token: string; expiresAt: number } | null = null

async function fcmAccessToken(cfg: FcmConfig, now = Date.now()): Promise<string> {
  if (fcmTokenCache && fcmTokenCache.clientEmail === cfg.clientEmail && fcmTokenCache.expiresAt - 60_000 > now) {
    return fcmTokenCache.token
  }
  const iat = Math.floor(now / 1000)
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(
    JSON.stringify({
      iss: cfg.clientEmail,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: cfg.tokenUri,
      iat,
      exp: iat + 3600,
    }),
  )
  const input = `${head}.${claims}`
  const assertion = `${input}.${b64url(sign('sha256', Buffer.from(input), cfg.key))}`
  const r = await fetch(cfg.tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const body = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string }
  if (!r.ok || !body.access_token) throw new Error(`换 FCM 访问令牌失败（${r.status} ${body.error || ''}）`)
  fcmTokenCache = { clientEmail: cfg.clientEmail, token: body.access_token, expiresAt: now + (Number(body.expires_in) || 3600) * 1000 }
  return body.access_token
}

/**
 * Android：一台设备一个请求（FCM v1 没有批量接口）。通知消息（notification 那一块）在后台由系统
 * 直接显示，点开带着 data 拉起应用（mobile/push-plugin 的 Kotlin 那半认它）；前台到达时应用没注册
 * FirebaseMessagingService，系统不显示——和 iOS 的「前台不弹」一致。
 *
 * collapse_key + notification.tag：同一颗 Bot 同一种事，后到的覆盖先到的，和 APNs 的 collapse id 一样。
 */
async function sendFcm(db: Db, cfg: FcmConfig, devices: DeviceRow[], msg: PushMessage, result: PushResult): Promise<void> {
  let access: string
  try {
    access = await fcmAccessToken(cfg)
  } catch (e) {
    console.warn(`satuwork-gateway: ${(e as Error).message}`)
    result.failed += devices.length
    return
  }
  const url = `${cfg.endpoint}/v1/projects/${encodeURIComponent(cfg.projectId)}/messages:send`
  for (const d of devices) {
    const message = {
      token: d.token,
      notification: { title: msg.title.slice(0, 120), body: msg.body.slice(0, 240) },
      data: msg.data,
      android: {
        priority: 'HIGH',
        // FCM 认的是时长字符串（秒，带 s）。
        ttl: `${PUSH_TTL_SECONDS}s`,
        ...(msg.collapseId ? { collapse_key: msg.collapseId.slice(0, 64) } : {}),
        notification: { sound: 'default', ...(msg.collapseId ? { tag: msg.collapseId.slice(0, 64) } : {}) },
      },
    }
    let status = 0
    let errorCode = ''
    let errorText = ''
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      status = r.status
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as {
          error?: { status?: string; message?: string; details?: { errorCode?: string }[] }
        }
        errorCode = body.error?.details?.find((x) => x.errorCode)?.errorCode || body.error?.status || ''
        errorText = body.error?.message || ''
      } else {
        await r.body?.cancel().catch(() => {})
      }
    } catch (e) {
      errorText = (e as Error).message
    }
    if (status === 200) {
      result.sent++
    } else if (status === 404 || errorCode === 'UNREGISTERED' || (status === 400 && /registration token/i.test(errorText))) {
      // 卸载了、清了数据、令牌换了：这个令牌不用再试了。
      await db.dropPushDevice(d.token)
      result.dropped++
    } else {
      if (status === 401 || status === 403) fcmTokenCache = null
      console.warn(`satuwork-gateway: FCM 拒了一条推送（${status} ${errorCode || errorText || '无原因'}）`)
      result.failed++
    }
  }
}
