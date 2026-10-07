/**
 * 知识库原文件存哪（docs/knowledge-base.md §5.1）。
 *
 * 和发布包（releases.ts）同一条规矩：**配了 `BLOB_READ_WRITE_TOKEN` 走 Vercel Blob（私有），
 * 没配落本地盘** `KB_DIR`（默认 `<data>/knowledge/`）。`KnowledgeFile.storage` 存的是 Blob url
 * 或相对路径，取的时候按形状判是哪一种。
 *
 * Blob 路径 `kb/{companyId}/{kbId}/{fileId}`——**不带用户给的文件名**。文件名是展示用的那一列；
 * 路径里放用户输入等于把路径穿越的口子留给自己。
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { del, head, put } from '@vercel/blob'
import type { KnowledgeFile } from '../db.ts'
import { gatewayHome } from '../home.ts'
import { HttpError } from '../http.ts'

export type StoreMode = 'blob' | 'disk'

function blobToken(): string {
  return (process.env.BLOB_READ_WRITE_TOKEN || '').trim()
}

/** Blob 配了就是 blob；否则本地盘。函数环境没有可写盘，那时 disk 模式的写会 501。 */
export function storeMode(): StoreMode {
  return blobToken() ? 'blob' : 'disk'
}

export function kbDir(): string {
  return (process.env.KB_DIR || '').trim() || gatewayHome('knowledge')
}

export function blobPathOf(file: Pick<KnowledgeFile, 'companyId' | 'kbId' | 'id'>): string {
  return `kb/${file.companyId}/${file.kbId}/${file.id}`
}

function isBlobUrl(storage: string): boolean {
  return /^https?:\/\//.test(storage)
}

/** 本地盘上的路径：`<kbDir>/<kbId>/<fileId>`。相对路径存进库，根目录换了也认得出。 */
function diskPathOf(storage: string): string {
  const root = resolve(kbDir())
  const full = resolve(root, storage)
  if (full !== root && !full.startsWith(root + sep)) throw new HttpError(500, '文件路径越界')
  return full
}

export const STORE_NOT_WRITABLE = '函数环境没有可写磁盘：配 BLOB_READ_WRITE_TOKEN 走对象存储'

/**
 * 原文件有没有地方放。函数环境（Vercel）只有 /tmp，不跨实例，没配 Blob 就是没地方放——
 * 这件事要在**登记**那一步就说出来，不能等到 PUT 才 501：登记已经占了容量、留了一行 uploading。
 */
export function storeWritable(): boolean {
  if (storeMode() === 'blob') return true
  return !(process.env.VERCEL && !process.env.SATUWORK_GATEWAY_HOME)
}

function assertDiskWritable(): void {
  if (!storeWritable()) throw new HttpError(501, STORE_NOT_WRITABLE)
}

export interface Stored {
  storage: string
  bytes: number
  sha256: string
}

/**
 * 边收边存。超过 `limit` 当场断掉——不是收完再量：50 MB 的上限对一条 500 MB 的流毫无意义。
 * 两种模式下都算 sha256，`KnowledgeFile.sha256` 给「同一份文件传了两遍」这类事留个把手。
 */
export async function saveStream(
  file: Pick<KnowledgeFile, 'companyId' | 'kbId' | 'id' | 'mime'>,
  body: AsyncIterable<Buffer>,
  limit: number,
): Promise<Stored> {
  const hash = createHash('sha256')
  let size = 0
  let tooBig: HttpError | null = null
  const ac = new AbortController()
  const counted = Readable.from(
    (async function* () {
      for await (const chunk of body) {
        size += chunk.length
        if (size > limit) {
          tooBig = new HttpError(413, `文件超过 ${Math.round(limit / 1024 / 1024)} MB 上限`)
          ac.abort()
          throw tooBig
        }
        hash.update(chunk)
        yield chunk
      }
    })(),
  )
  if (storeMode() === 'blob') {
    let uploaded: { url: string }
    try {
      uploaded = await put(blobPathOf(file), Readable.toWeb(counted) as unknown as ReadableStream, {
        access: 'private',
        token: blobToken(),
        addRandomSuffix: true,
        contentType: file.mime || 'application/octet-stream',
        abortSignal: ac.signal,
      })
    } catch (e) {
      if (tooBig) throw tooBig
      throw e instanceof HttpError ? e : new HttpError(502, '传到对象存储失败：' + (e as Error).message)
    }
    if (size === 0) {
      await del(uploaded.url, { token: blobToken() }).catch(() => undefined)
      throw new HttpError(400, '文件是空的')
    }
    return { storage: uploaded.url, bytes: size, sha256: hash.digest('hex') }
  }
  assertDiskWritable()
  const rel = join(file.kbId, file.id)
  const dest = diskPathOf(rel)
  mkdirSync(resolve(dest, '..'), { recursive: true })
  try {
    await pipeline(counted, createWriteStream(dest, { flags: 'w', mode: 0o600 }))
  } catch (e) {
    try {
      unlinkSync(dest)
    } catch {}
    throw e instanceof HttpError ? e : new HttpError(400, '上传中断：' + (e as Error).message)
  }
  if (size === 0) {
    try {
      unlinkSync(dest)
    } catch {}
    throw new HttpError(400, '文件是空的')
  }
  return { storage: rel, bytes: size, sha256: hash.digest('hex') }
}

/**
 * 浏览器直传 Blob 之后，核一下那个地址上真有这份文件、路径对得上、多大。
 * **路径前缀必须是我们给这份文件签的那一个**：不然随便一个 Blob 地址都能登记成「传完了」。
 */
export async function verifyBlobUpload(file: Pick<KnowledgeFile, 'companyId' | 'kbId' | 'id'>, url: string): Promise<{ size: number; contentType: string }> {
  if (storeMode() !== 'blob') throw new HttpError(400, '当前不是对象存储模式')
  let meta: { size: number; pathname: string; contentType: string }
  try {
    meta = await head(url, { token: blobToken() })
  } catch (e) {
    throw new HttpError(400, '对象存储里没有这份文件：' + (e as Error).message)
  }
  const expected = blobPathOf(file)
  // addRandomSuffix 会在文件名后面接一段随机串：`kb/c/k/f-AbC123`。按前缀比。
  if (meta.pathname !== expected && !meta.pathname.startsWith(expected + '-')) {
    throw new HttpError(400, '这个地址不是给这份文件签的')
  }
  return { size: Number(meta.size) || 0, contentType: meta.contentType || '' }
}

async function fetchBlob(url: string): Promise<Response> {
  const r = await fetch(url, {
    headers: { authorization: `Bearer ${blobToken()}` },
    signal: AbortSignal.timeout(300_000),
  })
  if (!r.ok || !r.body) throw new HttpError(502, `取原文件失败：HTTP ${r.status}`)
  return r
}

/** 整份读进内存。解析器要的是 Buffer；上限 50 MB，装得下。 */
export async function readStored(file: Pick<KnowledgeFile, 'storage'>): Promise<Buffer> {
  if (!file.storage) throw new HttpError(404, '原文件丢失，请重新上传')
  if (isBlobUrl(file.storage)) {
    const r = await fetchBlob(file.storage)
    return Buffer.from(await r.arrayBuffer())
  }
  try {
    return await readFile(diskPathOf(file.storage))
  } catch {
    throw new HttpError(404, '原文件丢失，请重新上传')
  }
}

/** 下载用：流和长度。 */
export async function openStored(file: Pick<KnowledgeFile, 'storage'>): Promise<{ body: Readable; length: number | null }> {
  if (!file.storage) throw new HttpError(404, '原文件丢失')
  if (isBlobUrl(file.storage)) {
    const r = await fetchBlob(file.storage)
    const len = r.headers.get('content-length')
    return { body: Readable.fromWeb(r.body as unknown as import('node:stream/web').ReadableStream), length: len ? Number(len) : null }
  }
  const full = diskPathOf(file.storage)
  let size: number
  try {
    size = statSync(full).size
  } catch {
    throw new HttpError(404, '原文件丢失')
  }
  return { body: createReadStream(full), length: size }
}

/** 删原文件。不存在当成功：删除是要收敛的，不是要报错的。 */
export async function removeStored(file: Pick<KnowledgeFile, 'storage'>): Promise<void> {
  if (!file.storage) return
  if (isBlobUrl(file.storage)) {
    await del(file.storage, { token: blobToken() })
    return
  }
  try {
    unlinkSync(diskPathOf(file.storage))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}
