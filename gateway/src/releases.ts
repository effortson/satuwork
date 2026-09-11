/**
 * Bot 发布包。
 *
 * 生产路径是**上传**：CI 构建产物 → `PUT /platform/bot-releases/:version` → Gateway
 * 只负责校验、落盘、登记，自己不构建。版本号由 CI 给（建议带 git sha），这样一个
 * 版本号永远对应同一份字节。
 *
 * 本地开发还留着**源码打包**：Gateway 磁盘上有 bot 源码时才启用（生产镜像里没有
 * 那份源码，所以自动是关的），省得改一行 bot 代码就得推一趟 CI。
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { del, put } from '@vercel/blob'
import type { BotRelease, Db, ReleaseKind } from './db.ts'
import { gatewayHome } from './home.ts'
import { HttpError } from './http.ts'

/**
 * 对象存储（Vercel Blob）。**配了 `BLOB_READ_WRITE_TOKEN` 就走它，不再落盘**——函数环境没有可写
 * 磁盘，Debian 上也可以配，好让两边的包在同一个地方。私有库：包里是我们的代码和依赖，不该
 * 挂在一个公开地址上；拉的时候带 token（Blob 的私有地址就是 GET + Bearer）。
 *
 * `VERCEL_BLOB_API_URL` 是 SDK 自己认的覆盖项，e2e 用它把上传指到一个假的 Blob。
 */
function blobToken(): string {
  return (process.env.BLOB_READ_WRITE_TOKEN || '').trim()
}

function blobApiUrl(): string {
  return (process.env.VERCEL_BLOB_API_URL || '').trim().replace(/\/$/, '')
}

/** 这个地址是不是我们自己 Blob 库里的包：拉它要带 token。别的地址（GitHub Release）什么都不带。 */
function isBlobUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.hostname.endsWith('.blob.vercel-storage.com')) return true
    const api = blobApiUrl()
    return Boolean(api && url.startsWith(api))
  } catch {
    return false
  }
}

/** 取一个远端包。私有 Blob 带 Bearer，其余裸取。verifyRemote 和 openRelease 共用，别各写一遍。 */
function fetchRelease(url: string): Promise<Response> {
  const token = blobToken()
  return fetch(url, {
    ...(token && isBlobUrl(url) ? { headers: { authorization: `Bearer ${token}` } } : {}),
    signal: AbortSignal.timeout(300_000),
  })
}

const VERSION_RE = /^[A-Za-z0-9._+-]+$/
const SHA256_RE = /^[0-9a-f]{64}$/

/**
 * 每种包里必须有的入口。systemd 单元直接跑它，缺了就是个跑不起来的包。
 *
 * 校验只看这一个文件在不在。不解包、不看内容——包是我们自己的 CI 打的，这里挡的
 * 是「传错文件」和「传到一半断了」，不是恶意构造。
 */
const ENTRY: Record<ReleaseKind, string> = {
  bot: 'bin/satuwork.mjs',
  manager: 'bin/satuwork-manager.mjs',
  'local-bot': 'bin/satuwork.mjs',
}

const LOCAL_TARGET_RE = /-(darwin|windows|linux)-(x64|arm64)$/

/** Desktop 本地包的目标平台写在版本尾部，发布与选择都只认这一处。 */
export function localBotReleaseTarget(version: string): { platform: string; arch: string } | undefined {
  const matched = LOCAL_TARGET_RE.exec(String(version || ''))
  return matched ? { platform: matched[1], arch: matched[2] } : undefined
}

function uploadLimit(): number {
  const raw = Number(process.env.GATEWAY_RELEASE_MAX_BYTES ?? 0)
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 256 * 1024 * 1024
}

export function parseBotVersion(raw: string): string {
  const version = String(raw || '').trim()
  if (!version || version.length > 64 || !VERSION_RE.test(version)) {
    throw new HttpError(400, 'version 须为 1–64 位字母数字或 . _ + -')
  }
  return version
}

export function botReleaseDir(): string {
  return gatewayHome('releases')
}

export function botReleaseFile(version: string, kind: ReleaseKind = 'bot'): string {
  return join(botReleaseDir(), `${kind}-${version}.tgz`)
}

/**
 * 一条发布记录对外的样子。
 *
 * `downloadUrl` 是**机器真正去拉的那条地址**，字节就在 Gateway 磁盘上时也照给：
 * 那台 Debian 上没有别的地方能看到它，界面上只写一句「本机存储」等于没给。
 * `url` 仍然只表示「登记的外部来源」，可以为空。
 */
export function publicBotRelease(row: BotRelease, base = '') {
  return {
    kind: row.kind,
    url: row.url,
    /** 机器拉包的地址。远端登记的包也走这条——Gateway 会替它回源。 */
    downloadUrl: `${base.replace(/\/$/, '')}/internal/${row.kind}-releases/${encodeURIComponent(row.version)}`,
    /** 字节在哪儿：本机磁盘，还是只登记了一个外部地址。界面上要分得清。 */
    storage: row.url ? ('remote' as const) : ('local' as const),
    version: row.version,
    sha256: row.sha256,
    size: row.size,
    createdAt: row.createdAt,
    note: row.note,
  }
}

function oneLine(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return raw.replace(/\s+/g, ' ').trim().slice(0, 200)
}

function discard(path: string) {
  try {
    unlinkSync(path)
  } catch {}
}

// ── 上传（生产路径）──────────────────────────────────────────────────────

function tarEntryName(header: Buffer): string {
  const cut = (buf: Buffer) => {
    const end = buf.indexOf(0)
    return buf.toString('utf8', 0, end === -1 ? buf.length : end)
  }
  const name = cut(header.subarray(0, 100))
  // ustar 的长路径拆成 prefix + name 两段存。
  const magic = header.toString('utf8', 257, 262)
  const prefix = magic === 'ustar' ? cut(header.subarray(345, 500)) : ''
  const full = prefix ? `${prefix}/${name}` : name
  return full.replace(/^\.?\//, '')
}

function tarEntrySize(header: Buffer): number {
  const raw = header.toString('utf8', 124, 136).replace(/\0.*$/, '').trim()
  const n = parseInt(raw, 8)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/**
 * 流式走一遍 tar.gz 的头块，找某个成员。
 *
 * 不解压到磁盘、不把整包读进内存：读 512 字节头 → 按 size 跳过数据 → 下一个头。
 * GNU 长文件名（'L'）和 pax 扩展头（'x'/'g'）不管——我们要找的名字很短，永远
 * 不会被拆成长名记录。
 */
async function tarHasEntry(path: string, wanted: string): Promise<boolean> {
  const src = createReadStream(path)
  const gunzip = createGunzip()
  // 不能用 src.pipe(gunzip)：pipe 不把源的错误传下去，读文件一出错，下面的 for await
  // 就永远等不到结束。跟下面收包那条一样走 pipeline，源坏了 gunzip 跟着 destroy，循环抛出来。
  const piped = pipeline(src, gunzip).catch(() => {})
  let pending: Buffer = Buffer.alloc(0)
  let skip = 0
  let found = false
  try {
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      while (!found) {
        if (skip > 0) {
          const n = Math.min(skip, pending.length)
          pending = pending.subarray(n)
          skip -= n
          if (skip > 0) break
        }
        if (pending.length < 512) break
        const header = pending.subarray(0, 512)
        pending = pending.subarray(512)
        if (header.every((b) => b === 0)) continue
        const size = tarEntrySize(header)
        skip = size + ((512 - (size % 512)) % 512)
        if (tarEntryName(header) === wanted) found = true
      }
      if (found) break
    }
  } finally {
    src.destroy()
    gunzip.destroy()
    await piped
  }
  return found
}

async function assertBotArchive(path: string, kind: ReleaseKind): Promise<void> {
  let ok: boolean
  try {
    ok = await tarHasEntry(path, ENTRY[kind])
  } catch (e) {
    throw new HttpError(400, '发布包不是 .tar.gz：' + oneLine(e))
  }
  if (!ok) throw new HttpError(400, `发布包缺少 ${ENTRY[kind]}`)
}

/**
 * 收下 CI 传来的发布包。
 *
 * 直接写到最终文件名上，用 `wx` 开——文件本身就是这个版本的锁，同一个版本并发上传
 * 只有一个能建出来，另一个拿 EEXIST。写坏了就把文件删掉，不留半个包。
 */
export async function storeUploadedRelease(
  db: Db,
  input: { version: string; note?: string; body: Readable; sha256?: string; kind?: ReleaseKind },
): Promise<BotRelease> {
  const kind: ReleaseKind = input.kind ?? 'bot'
  const version = parseBotVersion(input.version)
  const note = String(input.note ?? '').trim()
  const expected = String(input.sha256 ?? '')
    .trim()
    .toLowerCase()
  if (expected && !SHA256_RE.test(expected)) throw new HttpError(400, 'sha256 须为 64 位十六进制')
  if (await db.botRelease(version, kind)) throw new HttpError(409, '这个版本已经发布过')
  if (blobToken()) return storeToBlob(db, { kind, version, note, body: input.body, expected })
  /**
   * 函数环境（Vercel）只有 /tmp，不跨实例、不跨部署：包写进去等于随手丢，而登记已经进了库，
   * 管家来拉时 404，比一句「不能上传」难查一百倍。Vercel 上要么配 BLOB_READ_WRITE_TOKEN
   * 走对象存储，要么走「登记远端包」（带 url 的 POST）。
   */
  if (process.env.VERCEL && !process.env.SATUWORK_GATEWAY_HOME) {
    throw new HttpError(501, '函数环境没有可写磁盘：配 BLOB_READ_WRITE_TOKEN 走对象存储，或用「登记远端包」（带 url 的 POST）')
  }

  mkdirSync(botReleaseDir(), { recursive: true })
  const dest = botReleaseFile(version, kind)
  const limit = uploadLimit()
  const hash = createHash('sha256')
  let size = 0
  try {
    await pipeline(
      input.body,
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          size += chunk.length
          if (size > limit) throw new HttpError(413, `发布包超过 ${limit} 字节上限`)
          hash.update(chunk)
          yield chunk
        }
      },
      createWriteStream(dest, { flags: 'wx', mode: 0o600 }),
    )
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'EEXIST') {
      // 库里没有行、文件却在，多半是上一次传到一半进程没了。说清楚，别报成「已发布」。
      throw new HttpError(409, `${dest} 已存在但没有入库，删掉它再传`)
    }
    discard(dest)
    throw e instanceof HttpError ? e : new HttpError(400, '上传中断：' + oneLine(e))
  }

  try {
    if (size === 0) throw new HttpError(400, '发布包是空的')
    const sha256 = hash.digest('hex')
    if (expected && expected !== sha256) throw new HttpError(400, 'sha256 对不上，包在路上坏了')
    await assertBotArchive(dest, kind)
    const row: BotRelease = { kind, version, sha256, size, createdAt: Date.now(), note, url: '' }
    try {
      await db.insertBotRelease(row)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/UNIQUE|constraint/i.test(msg)) throw new HttpError(409, '这个版本已经发布过')
      throw e
    }
    return row
  } catch (e) {
    discard(dest)
    throw e
  }
}

/**
 * 收下 CI 传来的包，**边收边算、边收边传**到对象存储，不落盘。
 *
 * 校验和落盘那条一样多：大小上限、非空、sha256 对得上、入口文件在（后者靠 verifyRemote 再拉一遍
 * 头部——包在 Blob 上，本地没有文件可扫）。哪一步不过都把刚传上去的那个 blob 删掉，不留孤儿。
 * 地址带随机后缀（addRandomSuffix）：私有库本来就要 token 才拉得到，随机后缀是第二道，防同名覆盖。
 */
async function storeToBlob(
  db: Db,
  input: { kind: ReleaseKind; version: string; note: string; body: Readable; expected: string },
): Promise<BotRelease> {
  const { kind, version, note, expected } = input
  const limit = uploadLimit()
  const hash = createHash('sha256')
  let size = 0
  const ac = new AbortController()
  let tooBig: HttpError | null = null
  const counted = Readable.from(
    (async function* () {
      for await (const chunk of input.body as AsyncIterable<Buffer>) {
        size += chunk.length
        if (size > limit) {
          tooBig = new HttpError(413, `发布包超过 ${limit} 字节上限`)
          ac.abort()
          throw tooBig
        }
        hash.update(chunk)
        yield chunk
      }
    })(),
  )
  let uploaded: { url: string }
  try {
    uploaded = await put(`releases/${kind}-${version}.tgz`, Readable.toWeb(counted) as unknown as ReadableStream, {
      access: 'private',
      token: blobToken(),
      addRandomSuffix: true,
      contentType: 'application/gzip',
      abortSignal: ac.signal,
    })
  } catch (e) {
    if (tooBig) throw tooBig
    throw e instanceof HttpError ? e : new HttpError(502, '传到对象存储失败：' + oneLine(e))
  }
  const drop = () => del(uploaded.url, { token: blobToken() }).catch(() => undefined)
  try {
    if (size === 0) throw new HttpError(400, '发布包是空的')
    const sha256 = hash.digest('hex')
    if (expected && expected !== sha256) throw new HttpError(400, 'sha256 对不上，包在路上坏了')
    const probe = await verifyRemote(uploaded.url, kind, limit)
    if (probe.sha256 !== sha256 || probe.size !== size) throw new HttpError(502, '对象存储里的包和收到的不一样')
    const row: BotRelease = { kind, version, sha256, size, createdAt: Date.now(), note, url: uploaded.url }
    try {
      await db.insertBotRelease(row)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/UNIQUE|constraint/i.test(msg)) throw new HttpError(409, '这个版本已经发布过')
      throw e
    }
    return row
  } catch (e) {
    await drop()
    throw e
  }
}

/**
 * 登记一个**放在别处**的发布包。
 *
 * 和上传的区别只有「字节存不存在 Gateway 上」。校验一点没少：整包拉一遍、比对
 * 大小和 sha256、确认入口文件在——「点验证」验的就是这些。验不过不入库，因为
 * 一条指向坏包的记录会一路传染到席位机器上，而那时已经没人能上去看了。
 *
 * 拉下来的字节**不落盘**：它的意义就是不占 Gateway 的存储。下发时再取一次。
 */
export async function registerRemoteRelease(
  db: Db,
  input: { kind?: ReleaseKind; version: string; url: string; size: number; sha256: string; note?: string },
): Promise<BotRelease> {
  const kind: ReleaseKind = input.kind ?? 'bot'
  const version = parseBotVersion(input.version)
  const note = String(input.note ?? '').trim()
  const url = parseReleaseUrl(input.url)
  const wantSha = String(input.sha256 ?? '').trim().toLowerCase()
  if (!SHA256_RE.test(wantSha)) throw new HttpError(400, 'sha256 须为 64 位十六进制')
  const wantSize = Math.trunc(Number(input.size))
  if (!Number.isFinite(wantSize) || wantSize <= 0) throw new HttpError(400, 'size 须为正整数')
  if (await db.botRelease(version, kind)) throw new HttpError(409, '这个版本已经发布过')

  const probe = await verifyRemote(url, kind, uploadLimit())
  if (probe.size !== wantSize) throw new HttpError(400, `实际大小 ${probe.size} 字节，和填的 ${wantSize} 对不上`)
  if (probe.sha256 !== wantSha) throw new HttpError(400, `实际 sha256 ${probe.sha256.slice(0, 16)}… 和填的对不上`)

  const row: BotRelease = { kind, version, sha256: probe.sha256, size: probe.size, createdAt: Date.now(), note, url }
  try {
    await db.insertBotRelease(row)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/UNIQUE|constraint/i.test(msg)) throw new HttpError(409, '这个版本已经发布过')
    throw e
  }
  return row
}

/** 只收 http/https，且不许带凭据——这个地址会被存下来、传给机器、显示在界面上。 */
function parseReleaseUrl(raw: string): string {
  const text = String(raw ?? '').trim()
  if (!text) throw new HttpError(400, '下载地址不能为空')
  let u: URL
  try {
    u = new URL(text)
  } catch {
    throw new HttpError(400, '下载地址必须是完整的 http/https 地址')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, '下载地址必须是 http/https')
  if (u.username || u.password) throw new HttpError(400, '下载地址不能带用户名或口令')
  return u.toString()
}

async function verifyRemote(
  url: string,
  kind: ReleaseKind,
  limit: number,
): Promise<{ size: number; sha256: string }> {
  let res: Response
  try {
    res = await fetchRelease(url)
  } catch (e) {
    throw new HttpError(502, '取不到这个地址：' + oneLine(e))
  }
  if (!res.ok || !res.body) throw new HttpError(502, `取这个地址返回 ${res.status}`)

  // 边下边算，同时把字节喂给 tar 头扫描——只为确认入口文件在，不解包、不落盘。
  const hash = createHash('sha256')
  let size = 0
  const chunks: Buffer[] = []
  let kept = 0
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    const buf = Buffer.from(chunk)
    size += buf.length
    if (size > limit) throw new HttpError(413, `发布包超过 ${limit} 字节上限`)
    hash.update(buf)
    // tar 的入口都在头部，留前 2 MiB 足够扫到。全留会把大包整个吃进内存。
    if (kept < 2 * 1024 * 1024) {
      chunks.push(buf)
      kept += buf.length
    }
  }
  if (size === 0) throw new HttpError(400, '这个地址返回的是空文件')

  const dest = join(tmpdir(), `satuwork-verify-${randomUUID()}.tgz`)
  try {
    writeFileSync(dest, Buffer.concat(chunks))
    // 只写了前 2 MiB，gunzip 中途会断——tarHasEntry 找到入口就返回，找不到才走到断流。
    let ok = false
    try {
      ok = await tarHasEntry(dest, ENTRY[kind])
    } catch {
      ok = false
    }
    if (!ok) throw new HttpError(400, `发布包缺少 ${ENTRY[kind]}（或者不是 .tar.gz）`)
  } finally {
    discard(dest)
  }
  return { size, sha256: hash.digest('hex') }
}

/**
 * 取一个发布包的字节流。本机有文件就读文件，只登记了地址就现去取。
 *
 * 两种情况对调用方是一样的，所以下发路由不用关心包存在哪儿。
 */
export async function openRelease(row: BotRelease): Promise<Readable> {
  if (!row.url) {
    const file = botReleaseFile(row.version, row.kind)
    if (!existsSync(file)) throw new HttpError(404, '发布包文件不存在')
    return createReadStream(file)
  }
  let res: Response
  try {
    res = await fetchRelease(row.url)
  } catch (e) {
    throw new HttpError(502, '取不到发布包：' + oneLine(e))
  }
  if (!res.ok || !res.body) throw new HttpError(502, `取发布包返回 ${res.status}`)
  return Readable.fromWeb(res.body as never)
}
