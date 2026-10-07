/**
 * 知识库：检索、入库、删除收尾（docs/knowledge-base.md §6、§7、§9）。
 *
 * 入库跑在 `/cron/tick` 的一个维护步里：一拍领**一个**文件，在 50 秒的预算里解析、切片、
 * 分批灌进 Upstash，预算用完就放手，下一拍从 `chunkDone` 接着来。Vercel 函数默认 300 秒，
 * 一拍里前面还有别的步，这一步不能把整拍吃光。
 */
import { randomUUID } from 'node:crypto'
import type { Account, Db, KnowledgeBase, KnowledgeFile } from '../db.ts'
import { KB_FAIL_STREAK_DEFAULT, parseKnowledgeSettings } from '../db.ts'
import { HttpError } from '../http.ts'
import { chunkPages } from './knowledge-chunk.ts'
import { ExtractError, extOf, extractText } from './knowledge-extract.ts'
import { readStored, removeStored } from './knowledge-store.ts'
import { KB_UPSERT_BATCH, type KbHit, deleteFileVectors, deleteKbNamespace, queryNamespace, upsertChunks, vectorConfigured } from './knowledge-vector.ts'
import type { Meter } from './meter.ts'

/** 入库租约。过了还没推进就当上一拍死了，下一拍重领。 */
export const KB_LEASE_MS = 90_000
/** 一拍里给入库的时间。 */
export const KB_TICK_BUDGET_MS = 50_000
/** `uploading` 停多久算没人管了。 */
export const KB_STALE_UPLOAD_MS = 60 * 60 * 1000
/** 并发查几个库。公司有十几个库时封顶。 */
const KB_QUERY_CONCURRENCY = 8
export const KB_SEARCH_COUNT_DEFAULT = 6
export const KB_SEARCH_COUNT_MAX = 12
/** 回给模型的整段封顶。超了从分数最低的那条开始砍——不是截尾，截尾会把一段话砍成半句。 */
export const KB_RESULT_MAX = 12_000

export function knowledgeEnabled(): boolean {
  return vectorConfigured()
}

/** 展示用的文件名：去路径分隔符和控制字符，截到 200 字符。 */
export function cleanFileName(raw: string, max = 200): string {
  const name = String(raw ?? '')
    .replace(/[\\/]+/g, '_')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
  if (!name) return '未命名'
  if (name.length <= max) return name
  const ext = extOf(name)
  return ext ? `${name.slice(0, max - ext.length - 1)}.${ext}` : name.slice(0, max)
}

export function publicKnowledgeBase(kb: KnowledgeBase, shares?: string[]) {
  return {
    id: kb.id,
    name: kb.name,
    desc: kb.desc,
    share: kb.share,
    botIds: shares ?? [],
    bytesUsed: kb.bytesUsed,
    fileCount: kb.fileCount,
    chunkCount: kb.chunkCount,
    createdBy: kb.createdBy,
    createdAt: kb.createdAt,
    updatedAt: kb.updatedAt,
  }
}

export function publicKnowledgeFile(f: KnowledgeFile) {
  return {
    id: f.id,
    kbId: f.kbId,
    name: f.name,
    mime: f.mime,
    bytes: f.bytes,
    status: f.status,
    error: f.error,
    chunkCount: f.chunkCount,
    chunkDone: f.chunkDone,
    createdBy: f.createdBy,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  }
}

// ── 检索 ────────────────────────────────────────────────────────────────

export interface KbSearchHit {
  kbId: string
  kbName: string
  fileId: string
  fileName: string
  page: number | null
  score: number
  text: string
}

export interface KbSearchOut {
  hits: KbSearchHit[]
  searched: number
  elapsedMs: number
}

/**
 * 在这几个库里查。**共享范围不在这里判**——`kbs` 是调用方按自己的身份（Bot / 成员 / 管理员）
 * 筛好的；这里只管查、合并、落账。
 */
export async function searchKnowledge(
  db: Db,
  meter: Meter,
  account: Account,
  input: { kbs: KnowledgeBase[]; query: string; count?: number; botId?: string | null },
): Promise<KbSearchOut> {
  const query = String(input.query ?? '').trim()
  if (!query) throw new HttpError(400, '搜索词不能为空')
  if (query.length > 1000) throw new HttpError(400, '搜索词太长了（最多 1000 字）')
  const count = Math.max(1, Math.min(KB_SEARCH_COUNT_MAX, Math.trunc(Number(input.count) || KB_SEARCH_COUNT_DEFAULT)))
  const kbs = input.kbs.filter((k) => k.chunkCount > 0)
  const startedAt = Date.now()
  if (!kbs.length) return { hits: [], searched: 0, elapsedMs: 0 }
  const gate = await meter.gate(account, { kind: 'kb', kbOp: 'query' })
  if (!gate.ok) {
    await meter.charge(
      { kind: 'kb', account, botId: input.botId ?? null, status: 'denied', kbOp: 'query', units: 0 },
      { amountMicros: 0, unitPrice: {}, multiplier: 1, unpriced: false },
    )
    throw new HttpError(402, gate.reason)
  }
  const settings = parseKnowledgeSettings((await db.platformSettings()).knowledge)
  const byId = new Map(kbs.map((k) => [k.id, k]))
  const results: Array<{ kbId: string; hit: KbHit }> = []
  let failed = 0
  // 一个库一次查询，并发封顶——Upstash 没有跨命名空间的一次查，而并发查几个库和查一个差不多快。
  for (let i = 0; i < kbs.length; i += KB_QUERY_CONCURRENCY) {
    await Promise.all(
      kbs.slice(i, i + KB_QUERY_CONCURRENCY).map(async (kb) => {
        try {
          for (const hit of await queryNamespace(kb.id, query, count)) results.push({ kbId: kb.id, hit })
        } catch (e) {
          failed++
          console.warn(`satuwork-gateway: 知识库 ${kb.id} 查询失败：${(e as Error).message}`)
        }
      }),
    )
  }
  const status = failed === kbs.length ? 'failed' : 'ok'
  // 查询词**不进账本**：那是员工问的问题，和对话内容一个敏感级（§13）。
  await meter.charge({ kind: 'kb', account, botId: input.botId ?? null, status, kbOp: 'query', units: kbs.length - failed, refId: randomUUID() })
  if (failed === kbs.length) throw new HttpError(502, '知识库暂时查不了，稍后再试')
  const hits = results
    .filter((r) => r.hit.score >= settings.scoreMin)
    .sort((a, b) => b.hit.score - a.hit.score)
    .slice(0, count)
    .map((r) => {
      const kb = byId.get(r.kbId)!
      const m = r.hit.metadata
      return {
        kbId: kb.id,
        kbName: kb.name,
        fileId: String(m.fileId ?? ''),
        fileName: String(m.fileName ?? ''),
        page: m.page == null ? null : Number(m.page),
        score: Math.round(r.hit.score * 1000) / 1000,
        text: String(m.text ?? ''),
      }
    })
  return { hits: trimToBudget(hits), searched: kbs.length - failed, elapsedMs: Date.now() - startedAt }
}

function trimToBudget(hits: KbSearchHit[]): KbSearchHit[] {
  let total = hits.reduce((n, h) => n + h.text.length, 0)
  const out = [...hits]
  while (out.length > 1 && total > KB_RESULT_MAX) {
    const dropped = out.pop()!
    total -= dropped.text.length
  }
  return out
}

// ── 入库 ────────────────────────────────────────────────────────────────

/**
 * 一拍：收没人管的上传、收尾正在删的库、然后领一个文件入库。
 * 每一段各自兜错：一段持续报错不能让后面那段每一拍都被跳过（同 runMaintenanceSteps）。
 */
export async function tickKnowledge(db: Db, meter: Meter, now = Date.now()): Promise<number> {
  let did = 0
  did += await sweepStaleUploads(db, now).catch((e: Error) => {
    console.warn(`satuwork-gateway: 收知识库上传没做成：${e.message}`)
    return 0
  })
  did += await sweepDeletingKnowledge(db).catch((e: Error) => {
    console.warn(`satuwork-gateway: 删知识库没做成：${e.message}`)
    return 0
  })
  if (!vectorConfigured()) return did
  did += await ingestOne(db, meter, now).catch((e: Error) => {
    console.warn(`satuwork-gateway: 知识库入库没做成：${e.message}`)
    return 0
  })
  return did
}

async function sweepStaleUploads(db: Db, now: number): Promise<number> {
  const stale = await db.staleUploadingKnowledgeFiles(now - KB_STALE_UPLOAD_MS)
  for (const f of stale) {
    await removeStored(f).catch(() => undefined)
    await db.deleteKnowledgeFile(f.id)
    await db.refreshKnowledgeCounters(f.kbId)
  }
  return stale.length
}

async function sweepDeletingKnowledge(db: Db): Promise<number> {
  const list = await db.deletingKnowledgeBases()
  let n = 0
  for (const kb of list) {
    await cleanupKnowledgeBase(db, kb)
    n++
  }
  return n
}

/**
 * 真正删一个库：Upstash 命名空间 → 原文件 → 表里的行。任何一步失败下一拍重来；
 * `deleteNamespace` 对不存在的命名空间回成功，所以重来是幂等的。
 */
export async function cleanupKnowledgeBase(db: Db, kb: KnowledgeBase): Promise<void> {
  if (vectorConfigured()) await deleteKbNamespace(kb.id)
  for (const f of await db.knowledgeFiles(kb.id)) {
    await removeStored(f)
  }
  await db.deleteKnowledgeBase(kb.id)
}

/**
 * 删一份文件：三条调用，几百毫秒，同步做。表里的行**最后删**：前两步失败行还在，
 * 重点一次就是重做，不留半删的状态。
 */
export async function deleteKnowledgeFileNow(db: Db, file: KnowledgeFile): Promise<void> {
  if (file.chunkDone > 0 || file.status === 'ready') {
    if (vectorConfigured()) await deleteFileVectors(file.kbId, file.id)
  }
  await removeStored(file)
  await db.deleteKnowledgeFile(file.id)
  await db.refreshKnowledgeCounters(file.kbId)
}

/** 失败重跑：改回排队、清掉已有分片和向量，从头来。 */
export async function retryKnowledgeFile(db: Db, file: KnowledgeFile): Promise<KnowledgeFile> {
  if (vectorConfigured() && file.chunkDone > 0) await deleteFileVectors(file.kbId, file.id)
  await db.deleteKnowledgeChunks(file.id)
  const next = await db.updateKnowledgeFile(file.id, { status: 'queued', error: '', chunkCount: 0, chunkDone: 0, attempts: 0, leaseUntil: null })
  await db.refreshKnowledgeCounters(file.kbId)
  return next ?? file
}

async function ingestOne(db: Db, meter: Meter, now: number): Promise<number> {
  const file = await db.claimKnowledgeFile(now, KB_LEASE_MS)
  if (!file) return 0
  const deadline = now + KB_TICK_BUDGET_MS
  const kb = await db.knowledgeBase(file.kbId)
  if (!kb || kb.deletingAt) {
    // 库没了（或正在删）：文件跟着走，别一拍一拍地领一个孤儿。
    await db.deleteKnowledgeFile(file.id)
    return 1
  }
  try {
    let cur = file
    if (cur.chunkCount === 0) {
      const bytes = await readStored(cur)
      const pages = await extractText(bytes, extOf(cur.name))
      const chunks = chunkPages(cur.name, pages)
      if (!chunks.length) throw new ExtractError('没有可提取的文字；扫描件暂不支持')
      // 一个事务整份落下：解析到一半被冻住，下一拍看到 chunkCount = 0 就从头来。
      await db.replaceKnowledgeChunks(cur.id, cur.kbId, chunks.map((c) => ({ no: c.no, page: c.page, text: c.text })))
      cur = (await db.knowledgeFile(cur.id)) ?? cur
    }
    const startDone = cur.chunkDone
    let done = cur.chunkDone
    while (done < cur.chunkCount) {
      if (Date.now() > deadline) break
      const batch = await db.knowledgeChunks(cur.id, done, KB_UPSERT_BATCH)
      if (!batch.length) break
      await upsertChunks(
        cur.kbId,
        batch.map((c) => ({
          id: c.id,
          data: c.text,
          metadata: { fileId: cur.id, fileName: cur.name, kbId: cur.kbId, no: c.no, page: c.page, text: c.text },
        })),
      )
      done = batch[batch.length - 1].no + 1
      // 每批成功就推进，顺手续租：下一拍看到的是真实进度。
      await db.updateKnowledgeFile(cur.id, { chunkDone: done, attempts: 0, leaseUntil: Date.now() + KB_LEASE_MS })
    }
    if (done >= cur.chunkCount) {
      await db.updateKnowledgeFile(cur.id, { status: 'ready', error: '', chunkDone: done, attempts: 0, leaseUntil: null })
      await db.refreshKnowledgeCounters(cur.kbId)
      const account = cur.createdBy ? await db.account(cur.createdBy) : undefined
      // 入库完成落一行：计量是几次 upsert 请求（分片数 ÷ 100 向上取整）。没有操作人（账号删了）就不记。
      if (account) {
        await meter.charge({
          kind: 'kb',
          account,
          status: 'ok',
          kbOp: 'ingest',
          units: Math.ceil(cur.chunkCount / KB_UPSERT_BATCH),
          refId: cur.id,
        })
      }
    } else if (done === startDone) {
      // 这一拍一片都没灌进去（多半是 Upstash 报错）：记一笔，连着几拍没推进才标失败。
      const attempts = cur.attempts + 1
      const streak = KB_FAIL_STREAK_DEFAULT
      if (attempts >= streak) {
        await db.updateKnowledgeFile(cur.id, { status: 'failed', error: '向量库暂时不可用，稍后点重试', attempts, leaseUntil: null })
        await db.refreshKnowledgeCounters(cur.kbId)
      } else {
        await db.updateKnowledgeFile(cur.id, { attempts, leaseUntil: null })
      }
    }
    return 1
  } catch (e) {
    if (e instanceof ExtractError || e instanceof HttpError) {
      await db.updateKnowledgeFile(file.id, { status: 'failed', error: e.message, leaseUntil: null })
      await db.refreshKnowledgeCounters(file.kbId)
      return 1
    }
    // 别的错（网络、Upstash）：不标失败，租约到期下一拍重来；连着几拍没推进再标（上面那支）。
    const attempts = file.attempts + 1
    if (attempts >= KB_FAIL_STREAK_DEFAULT) {
      await db.updateKnowledgeFile(file.id, { status: 'failed', error: `入库失败：${oneLine(e)}`, attempts, leaseUntil: null })
      await db.refreshKnowledgeCounters(file.kbId)
    } else {
      await db.updateKnowledgeFile(file.id, { attempts, leaseUntil: null })
    }
    console.warn(`satuwork-gateway: 知识库文件 ${file.id} 入库出错（第 ${attempts} 次）：${oneLine(e)}`)
    return 1
  }
}

function oneLine(e: unknown): string {
  return String((e as Error)?.message ?? e)
    .replace(/\s+/g, ' ')
    .slice(0, 200)
}
