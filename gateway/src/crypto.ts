import {
  createHash,
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  scrypt as scryptCb,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 口令下限。和 Bot 框架同一条，不多写一条服务端不检查的。 */
export const MIN_PASSWORD = 10

/** 邀请新成员默认 7 天；重置已激活账号口令 1 小时。 */
export const INVITE_TTL = 7 * 24 * 3600 * 1000
export const RESET_LINK_TTL = 3600 * 1000

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

export function randomInviteToken(): string {
  return randomBytes(24).toString('base64url')
}

/** scrypt 参数。N 越大越慢越安全；16384 在本机登录约 50–80ms，够用且不刺痛。 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }

/**
 * Node 的 scrypt 有一道内存闸：`N * r * 128` 超过 `maxmem`（默认 32 MiB）就直接报错。
 * 校验时参数是**从库里读出来的**，所以得给它一个跟着参数走的上限，否则哪天把 N 调大，
 * 存量口令反而校验不动了——那正是这次要修的那种「静默锁死」的另一种形状。
 */
function maxmemFor(N: number, r: number): number {
  return Math.max(32 * 1024 * 1024, N * r * 256)
}

type ScryptParams = { N: number; r: number; p: number }

function scrypt(password: string, salt: Buffer, params: ScryptParams = SCRYPT): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(
      password,
      salt,
      SCRYPT.keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: maxmemFor(params.N, params.r) },
      (err, derived) => {
        if (err) reject(err)
        else resolve(derived as Buffer)
      },
    )
  })
}

/** `scrypt$N$r$p$salt$hash`，全部十六进制。**永远不出现在任何响应里。** */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt)
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${key.toString('hex')}`
}

/**
 * 校验时**用这一行自己存着的那组参数**，不用当前的常量。
 *
 * 格式里一直带着 `N$r$p`，但校验那句以前是 `const [scheme, , , , salt, hash]`——三个
 * 参数全跳过，一律拿模块常量重算。也就是说那三格是装饰。
 *
 * 代价要说清楚：哪天为了提高成本把 `SCRYPT.N` 从 16384 调到 32768（注释里写着「N 越大
 * 越安全」，这是迟早的事），**所有存量账号会在同一刻全部登录失败**，而且失败路径和
 * 「口令输错了」一字不差——verifyPassword 返回 false，`/auth/login` 回「邮箱或口令
 * 不对」。没有任何一处说得出这是参数变更。更坏的是格式里存着参数这件事本身，会让下
 * 一个人以为迁移已经被考虑过了。
 *
 * 读出来用，这条路就通了：老行按老参数校验，新写的按新参数，两代共存。
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, rawN, rawR, rawP, salt, hash] = String(stored || '').split('$')
  if (scheme !== 'scrypt' || !salt || !hash) return false
  const params = { N: Number(rawN), r: Number(rawR), p: Number(rawP) }
  // 参数得是正整数，而且 N 必须是 2 的幂——不是的话 Node 直接抛，那会变成一个 500
  // 而不是一次失败的登录。坏行按「校验不过」处理。
  if (![params.N, params.r, params.p].every((n) => Number.isInteger(n) && n > 0)) return false
  if ((params.N & (params.N - 1)) !== 0) return false
  let key: Buffer
  try {
    key = await scrypt(password, Buffer.from(salt, 'hex'), params)
  } catch {
    return false
  }
  const expected = Buffer.from(hash, 'hex')
  return key.length === expected.length && timingSafeEqual(key, expected)
}

/**
 * 这一行是不是该趁人登录时顺手升级成当前参数。
 *
 * 调用方拿到 true 就用**刚验过的那个明文**重算一次写回去（见 routes/auth.ts 的登录）。
 * 只往上升：手工把 N 调低时不该把已经强的行削弱回去。
 */
export function needsRehash(stored: string): boolean {
  const [scheme, rawN, rawR, rawP] = String(stored || '').split('$')
  if (scheme !== 'scrypt') return true
  const n = Number(rawN)
  const r = Number(rawR)
  const p = Number(rawP)
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return true
  return n < SCRYPT.N || r < SCRYPT.r || p < SCRYPT.p
}

export interface JwtKeys {
  kid: string
  privatePem: string
  publicPem: string
}

/**
 * 渠道 token 的包裹密钥。和 JWT 私钥一样第一次启动落盘、之后固定复用；0600 防止
 * 同机的普通用户读走。数据库泄露时 Telegram token 仍然不是明文。
 */
/**
 * 密钥的来源有两个：环境变量，或者磁盘。
 *
 * **环境变量优先**——Vercel 那样的函数环境没有一块跨请求、跨实例都在的磁盘，密钥只能从
 * 环境来（docs/adr-gateway-vercel-neon.md §5.1）。Debian 上照旧落盘：第一次起来自己生成，
 * 重启不变——重启一变，已经发出去的每张 JWT 就全失效了，这是当年把它放磁盘而不放库的理由。
 *
 * PEM 放进环境变量时换行常被压成字面的 `\n`，两种都认。
 */
function envPem(name: string): string {
  return (process.env[name] || '').trim().replace(/\\n/g, '\n')
}

export function loadChannelKey(home: string): Buffer {
  const fromEnv = (process.env.GATEWAY_CHANNEL_KEY || '').trim()
  if (fromEnv) {
    const key = Buffer.from(fromEnv, 'base64')
    if (key.length !== 32) throw new Error('GATEWAY_CHANNEL_KEY 须是 32 字节的 base64')
    return key
  }
  const dir = join(home, 'keys')
  const path = join(dir, 'channel-secret.key')
  mkdirSync(dir, { recursive: true })
  if (!existsSync(path)) writeFileSync(path, randomBytes(32), { mode: 0o600 })
  const key = readFileSync(path)
  if (key.length !== 32) throw new Error('渠道密钥长度不对，需要 32 字节')
  return key
}

export function encryptChannelSecret(key: Buffer, value: unknown): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from('satuwork-channel-v1'))
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`
}

export function decryptChannelSecret<T>(key: Buffer, stored: string): T {
  const [version, ivRaw, tagRaw, bodyRaw] = String(stored || '').split('.')
  if (version !== 'v1' || !ivRaw || !tagRaw || !bodyRaw) throw new Error('渠道密文格式不对')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivRaw, 'base64url'))
  decipher.setAAD(Buffer.from('satuwork-channel-v1'))
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'))
  const plain = Buffer.concat([decipher.update(Buffer.from(bodyRaw, 'base64url')), decipher.final()]).toString('utf8')
  return JSON.parse(plain) as T
}

/**
 * 第一次启动生成 RSA 2048 并落盘。之后每次读同一对——kid 跟着公钥走，
 * 重启不会让已发出的票全部失效。
 */
export function loadKeys(home: string): JwtKeys {
  const envPriv = envPem('GATEWAY_JWT_PRIVATE_KEY')
  const envPub = envPem('GATEWAY_JWT_PUBLIC_KEY')
  if (envPriv || envPub) {
    if (!envPriv || !envPub) throw new Error('GATEWAY_JWT_PRIVATE_KEY 与 GATEWAY_JWT_PUBLIC_KEY 要一起给')
    // 先验一遍能不能当钥匙用：环境变量里少一行 PEM 尾巴，第一次签票时才炸，比这里炸难查得多。
    createPublicKey(envPub)
    return { kid: createHash('sha256').update(envPub).digest('hex').slice(0, 16), privatePem: envPriv, publicPem: envPub }
  }
  const dir = join(home, 'keys')
  const privPath = join(dir, 'jwt-private.pem')
  const pubPath = join(dir, 'jwt-public.pem')
  mkdirSync(dir, { recursive: true })
  if (!existsSync(privPath) || !existsSync(pubPath)) {
    const pair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    writeFileSync(privPath, pair.privateKey, { mode: 0o600 })
    writeFileSync(pubPath, pair.publicKey, { mode: 0o644 })
  }
  const privatePem = readFileSync(privPath, 'utf8')
  const publicPem = readFileSync(pubPath, 'utf8')
  const kid = createHash('sha256').update(publicPem).digest('hex').slice(0, 16)
  return { kid, privatePem, publicPem }
}

export interface JwtPayload {
  iss: string
  sub: string
  accountId: string
  companyId: string
  role: 'owner' | 'admin' | 'member'
  iat: number
  exp: number
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url')

export function signJwt(keys: JwtKeys, claims: Omit<JwtPayload, 'iss' | 'iat' | 'exp'>, ttlSec: number): string {
  const now = Math.floor(Date.now() / 1000)
  const payload: JwtPayload = {
    iss: process.env.GATEWAY_ISS ?? 'satuwork-gateway',
    iat: now,
    exp: now + ttlSec,
    ...claims,
  }
  const header = { alg: 'RS256', typ: 'JWT', kid: keys.kid }
  const h = b64url(JSON.stringify(header))
  const p = b64url(JSON.stringify(payload))
  const sig = sign('sha256', Buffer.from(`${h}.${p}`), keys.privatePem)
  return `${h}.${p}.${sig.toString('base64url')}`
}

export function verifyJwt(keys: JwtKeys, token: string): JwtPayload {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('票格式不对')
  const [h, p, s] = parts
  const ok = verify('sha256', Buffer.from(`${h}.${p}`), keys.publicPem, Buffer.from(s, 'base64url'))
  if (!ok) throw new Error('票签验失败')
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as JwtPayload
  if (!payload.accountId || !payload.role) throw new Error('票缺字段')
  if (payload.role !== 'owner' && !payload.companyId) throw new Error('票缺字段')
  if (payload.role !== 'owner' && payload.role !== 'admin' && payload.role !== 'member') throw new Error('票缺字段')
  const iss = process.env.GATEWAY_ISS ?? 'satuwork-gateway'
  if (payload.iss !== iss) throw new Error('票签发方不对')
  // exp 不是有限数字（NaN 序列化成 null、或者被人改成字符串）一律拒：没有过期时间的票
  // 等于永不过期，而这里签出去的每一张都是带 exp 的。
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) throw new Error('票缺过期时间')
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error('票已过期')
  return payload
}

export interface DesktopTicket {
  typ: 'satu-desktop'
  seatId: string
  iat: number
  exp: number
  /** 席位的 VNC 口令，交给 noVNC 自动填。没有就让人自己输。 */
  vnc?: string
}

/**
 * 桌面票。浏览器拿它直连机器管家看 noVNC。
 *
 * 为什么不复用登录 JWT：那张票带着 accountId 和 role，能调 Gateway 的写接口，而这
 * 一张要交给一个**不在我们控制下的进程**（管家）去验，还会以 cookie 的形式在机器
 * 上落一会儿。所以另起一种，只说明「谁可以看哪一块屏、看到什么时候」，别的什么
 * 都不说。`typ` 是显式的，管家验签之后还要再对一次——同一把密钥签出来的两种票不
 * 能互相冒充。
 *
 * 五分钟：够点开桌面，不够被人捡去慢慢用。管家会把它换成一张 path 限定的 cookie，
 * 所以票短不影响会话长度。
 */
export function signDesktopTicket(keys: JwtKeys, seatId: string, vnc = '', ttlSec = 300): string {
  const now = Math.floor(Date.now() / 1000)
  // `vnc`：席位的 VNC 口令。带上它，管家就能把它交给 noVNC 自动填，人点开就看见桌面。
  //
  // 放在票里而不是拼在最初那个链接上：那个链接会渲染进页面、可能被复制转发，而票是
  // 签名的、五分钟就废。**但要认清代价**——JWT 的载荷只是 base64，不是加密，谁拿到
  // 这张票谁就能读出口令。这不算新增泄露面：拿到票本来就能直接进这块屏。
  const payload: DesktopTicket = { typ: 'satu-desktop', seatId, iat: now, exp: now + ttlSec, ...(vnc ? { vnc } : {}) }
  const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: keys.kid }))
  const p = b64url(JSON.stringify(payload))
  return `${h}.${p}.${sign('sha256', Buffer.from(`${h}.${p}`), keys.privatePem).toString('base64url')}`
}

/**
 * 验一张桌面票。
 *
 * Gateway 自己签、自己也要验：桌面现在从 Gateway 同域反代出去（见 desktop.ts），
 * 入口那一跳要把票换成一张同源的 cookie。验不过一律 undefined，不区分原因。
 *
 * `typ` 必须对上。同一把私钥还签着登录票，不显式区分的话，一张登录 JWT 就能当桌面
 * 票用——那张票上带着 accountId 和 role。
 */
export function verifyDesktopTicket(keys: JwtKeys, token: string): DesktopTicket | undefined {
  const parts = (token || '').split('.')
  if (parts.length !== 3) return
  const [h, p, s] = parts
  let ok = false
  try {
    ok = verify('sha256', Buffer.from(`${h}.${p}`), keys.publicPem, Buffer.from(s, 'base64url'))
  } catch {
    return
  }
  if (!ok) return
  let payload: DesktopTicket
  try {
    payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as DesktopTicket
  } catch {
    return
  }
  if (payload.typ !== 'satu-desktop' || !payload.seatId) return
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return
  return payload
}

export interface ArtifactTicket {
  typ: 'satu-artifact'
  accountId: string
  sessionId: string
  path: string
  iat: number
  exp: number
}

/**
 * Telegram 预览票。它只授权读取某一条会话工作区里的某一个文件，不能拿来登录、列目录
 * 或读取相邻路径。七天够消息里的卡片反复点开，也不会把一次转发变成永久公开链接。
 */
export function signArtifactTicket(
  keys: JwtKeys,
  accountId: string,
  sessionId: string,
  path: string,
  ttlSec = 7 * 24 * 3600,
): string {
  const now = Math.floor(Date.now() / 1000)
  const payload: ArtifactTicket = { typ: 'satu-artifact', accountId, sessionId, path, iat: now, exp: now + ttlSec }
  const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: keys.kid }))
  const p = b64url(JSON.stringify(payload))
  return `${h}.${p}.${sign('sha256', Buffer.from(`${h}.${p}`), keys.privatePem).toString('base64url')}`
}

/** 严格验形状；失败统一返回 undefined，公开预览入口不泄露是哪一格不对。 */
export function verifyArtifactTicket(keys: JwtKeys, token: string): ArtifactTicket | undefined {
  const parts = (token || '').split('.')
  if (parts.length !== 3) return
  const [h, p, s] = parts
  try {
    if (!verify('sha256', Buffer.from(`${h}.${p}`), keys.publicPem, Buffer.from(s, 'base64url'))) return
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as ArtifactTicket
    if (payload.typ !== 'satu-artifact') return
    if (typeof payload.accountId !== 'string' || !payload.accountId) return
    if (typeof payload.sessionId !== 'string' || !payload.sessionId) return
    if (typeof payload.path !== 'string' || !payload.path || payload.path.length > 2048 || payload.path.includes('\0')) return
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp < Math.floor(Date.now() / 1000)) return
    return payload
  } catch {
    return
  }
}

/** JWKS。实例拿它验 Gateway 签的票。 */
export function jwks(keys: JwtKeys): { keys: Record<string, unknown>[] } {
  const jwk = createPublicKey(keys.publicPem).export({ format: 'jwk' }) as Record<string, unknown>
  return { keys: [{ ...jwk, kid: keys.kid, alg: 'RS256', use: 'sig' }] }
}

export function timingSafeToken(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given ?? '').digest()
  const b = createHash('sha256').update(expected ?? '').digest()
  return timingSafeEqual(a, b)
}

/** 席位 API Key。调 Gateway /v1 模型，标明是哪个用户发起的调用。明文落库，详情页要给 owner 看。 */
export function randomApiKey(): string {
  return 'sk_sw_' + randomBytes(32).toString('base64url')
}

/** 席位 access token。Gateway ↔ Bot 双向鉴权。明文落库。 */
export function randomAccessToken(): string {
  return 'sat_' + randomBytes(32).toString('base64url')
}

/**
 * 每台机器一把，**只给管家**。
 *
 * 它是管家控制面（`PUT /seats/:id` 等）的凭据，等同于那台机器的 root。所以它只活在
 * `/etc/satuwork/manager.json`（0600），不再注入 bot.env——那个文件属于席位那个普通
 * Linux 用户，员工在 noVNC 桌面里 cat 一下就拿到了。bot 上报用的是席位票（sat_）。
 */
export function randomMachineToken(): string {
  return 'smt_' + randomBytes(32).toString('base64url')
}
