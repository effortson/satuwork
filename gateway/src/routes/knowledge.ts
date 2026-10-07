/**
 * 公司知识库（docs/knowledge-base.md §12）。挂在 `/orgs/:id/knowledge` 底下，和公司设置、
 * 成员那几条一个位置——知识库是公司的东西，不是账号的。
 *
 * 管理员：建库、改共享范围、传文件、删；成员：只看得见共享给自己任何一颗 Bot 的库。
 * `none` 的库对成员不存在：列表里没有，直接输地址 404——不是 403，403 等于承认它存在。
 */
import type { ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import type { RouteCtx } from './ctx.ts'
import { HttpError, json, type Req, type Router } from '../http.ts'
import { KB_BYTES_MAX, KB_DESC_MAX, KB_FILES_MAX, KB_FILE_MAX, KB_NAME_MAX, KNOWLEDGE_SHARES, type Account, type KnowledgeBase, type KnowledgeFile, type KnowledgeShare } from '../db.ts'
import { afterResponse } from '../lib/background.ts'
import { originOf, requireOrgUser } from '../lib/guards.ts'
import { bodyOf, strField } from '../lib/validate.ts'
import { KB_FILE_TYPES, requireSupported } from '../lib/knowledge-extract.ts'
import { STORE_NOT_WRITABLE, blobPathOf, openStored, saveStream, storeMode, storeWritable, verifyBlobUpload } from '../lib/knowledge-store.ts'
import { VECTOR_NOT_CONFIGURED, vectorConfigured } from '../lib/knowledge-vector.ts'
import { cleanFileName, deleteKnowledgeFileNow, publicKnowledgeBase, publicKnowledgeFile, retryKnowledgeFile, searchKnowledge, tickKnowledge } from '../lib/knowledge.ts'

/** 配额那把锁（同 USER_BOT_QUOTA_LOCK 那套 advisory lock）：按公司排队数库。 */
export const KB_QUOTA_LOCK = 0x4b4251
/** 容量那把锁：按库排队扣字节。 */
export const KB_BYTES_LOCK = 0x4b4242

export function attachKnowledge(router: Router, ctx: RouteCtx) {
  const { db, keys, meter } = ctx

  function shareOf(v: unknown): KnowledgeShare {
    const s = String(v ?? 'all')
    if (!(KNOWLEDGE_SHARES as string[]).includes(s)) throw new HttpError(400, 'share 只能是 all / bots / none')
    return s as KnowledgeShare
  }

  function nameOf(body: Record<string, unknown>, key: string, max: number, required = true): string {
    const v = strField(body, key, required)
    if (v.length > max) throw new HttpError(400, `${key} 最多 ${max} 个字`)
    return v
  }

  /** 没配向量库，写接口一律 501：界面上那句「平台未开通知识库」就是从这儿来的。 */
  function requireVector(): void {
    if (!vectorConfigured()) throw new HttpError(501, VECTOR_NOT_CONFIGURED)
  }

  /** 原文件没地方放（Vercel 上没配 Blob）同样是「没开通」：建库和登记文件都拦在门口。 */
  function requireStore(): void {
    if (!storeWritable()) throw new HttpError(501, STORE_NOT_WRITABLE)
  }

  function enabled(): boolean {
    return vectorConfigured() && storeWritable()
  }

  function disabledReason(): string {
    return !vectorConfigured() ? VECTOR_NOT_CONFIGURED : !storeWritable() ? STORE_NOT_WRITABLE : ''
  }

  function isAdmin(account: Account): boolean {
    return account.role === 'owner' || account.role === 'admin'
  }

  /** 这个账号看得见的库。管理员全部；成员只有共享给他 Bot 的。 */
  async function visibleKnowledge(account: Account, companyId: string): Promise<KnowledgeBase[]> {
    return isAdmin(account) ? db.knowledgeBasesOf(companyId) : db.knowledgeForAccount(companyId, account.id)
  }

  async function visibleOne(account: Account, companyId: string, kbId: string): Promise<KnowledgeBase> {
    const kb = await db.knowledgeBase(kbId)
    if (!kb || kb.companyId !== companyId || kb.deletingAt) throw new HttpError(404, '没有这个知识库')
    if (!isAdmin(account)) {
      const mine = await db.knowledgeForAccount(companyId, account.id)
      if (!mine.some((k) => k.id === kb.id)) throw new HttpError(404, '没有这个知识库')
    }
    return kb
  }

  async function adminKb(req: Req, orgId: string): Promise<{ account: Account; kb: KnowledgeBase }> {
    const account = await requireOrgUser(req, db, keys, orgId, true)
    const kb = await db.knowledgeBase(req.params.kbId)
    if (!kb || kb.companyId !== orgId || kb.deletingAt) throw new HttpError(404, '没有这个知识库')
    return { account, kb }
  }

  async function fileOf(kb: KnowledgeBase, fileId: string): Promise<KnowledgeFile> {
    const f = await db.knowledgeFile(fileId)
    if (!f || f.kbId !== kb.id) throw new HttpError(404, '没有这个文件')
    return f
  }

  /** 到期只拦新增：建库、传文件。检索照常（§4.2）。 */
  async function requireNotExpired(companyId: string): Promise<void> {
    const plan = await db.plan(companyId)
    if (plan?.expiresAt != null && plan.expiresAt < Date.now()) throw new HttpError(409, '套餐已到期，续费后才能继续添加')
  }

  async function quotaOf(companyId: string) {
    const plan = await db.plan(companyId)
    return { quota: plan?.knowledgeBases ?? 0, used: await db.countKnowledgeBases(companyId) }
  }

  function kick(): void {
    afterResponse('知识库入库', tickKnowledge(db, meter))
  }

  // ── 固定段的几条要排在 /:kbId 前面 ─────────────────────────────────

  router.get('/orgs/:id/knowledge/config', async (req, res) => {
    await requireOrgUser(req, db, keys, req.params.id)
    json(res, 200, {
      enabled: enabled(),
      reason: disabledReason(),
      upload: storeMode() === 'blob' ? 'blob-client' : 'direct',
      limits: { bytesMax: KB_BYTES_MAX, fileMax: KB_FILE_MAX, filesMax: KB_FILES_MAX, nameMax: KB_NAME_MAX, descMax: KB_DESC_MAX },
      types: Object.keys(KB_FILE_TYPES),
      ...(await quotaOf(req.params.id)),
    })
  })

  /** 共享名单用的 Bot 列表：这家公司全部 Bot + 主人的名字。 */
  router.get('/orgs/:id/knowledge/bots', async (req, res) => {
    await requireOrgUser(req, db, keys, req.params.id, true)
    const bots = await db.companyBots(req.params.id)
    const owners = new Map<string, { id: string; name: string; email: string }>()
    for (const b of bots) {
      if (!b.accountId || owners.has(b.accountId)) continue
      const a = await db.account(b.accountId)
      if (a) owners.set(a.id, { id: a.id, name: a.name, email: a.email })
    }
    json(res, 200, {
      bots: bots.map((b) => ({
        id: b.id,
        name: b.name,
        scope: b.scope,
        owner: b.accountId ? owners.get(b.accountId) ?? null : null,
      })),
    })
  })

  /** 试搜。管理员不看共享范围；成员只能查看得见的库。 */
  router.post('/orgs/:id/knowledge/search', async (req, res) => {
    const account = await requireOrgUser(req, db, keys, req.params.id)
    requireVector()
    const body = bodyOf(req)
    const all = await visibleKnowledge(account, req.params.id)
    const ids = Array.isArray(body.kbIds) ? new Set(body.kbIds.map(String)) : null
    const kbs = ids ? all.filter((k) => ids.has(k.id)) : all
    json(res, 200, await searchKnowledge(db, meter, account, { kbs, query: String(body.query ?? ''), count: body.count == null ? undefined : Number(body.count) }))
  })

  router.get('/orgs/:id/knowledge', async (req, res) => {
    const account = await requireOrgUser(req, db, keys, req.params.id)
    const list = await visibleKnowledge(account, req.params.id)
    const shares = isAdmin(account) ? await db.knowledgeSharesOfMany(list.map((k) => k.id)) : new Map<string, string[]>()
    json(res, 200, {
      enabled: enabled(),
      reason: disabledReason(),
      knowledge: list.map((k) => publicKnowledgeBase(k, shares.get(k.id) ?? [])),
      ...(await quotaOf(req.params.id)),
    })
  })

  router.post('/orgs/:id/knowledge', async (req, res) => {
    const account = await requireOrgUser(req, db, keys, req.params.id, true)
    requireVector()
    requireStore()
    await requireNotExpired(req.params.id)
    const body = bodyOf(req)
    const name = nameOf(body, 'name', KB_NAME_MAX)
    const desc = nameOf(body, 'desc', KB_DESC_MAX, false)
    const share = shareOf(body.share)
    const botIds = share === 'bots' ? await botIdsOf(req.params.id, body.botIds) : []
    // 建的时候数，不是用的时候数：锁后面数到的才是对的数（§4.2）。
    const kb = await db.tx(async () => {
      await db.lockExclusive(KB_QUOTA_LOCK, req.params.id)
      const { quota, used } = await quotaOf(req.params.id)
      if (used >= quota) {
        throw new HttpError(409, quota ? `知识库已达套餐上限（${used}/${quota}），先删掉用不上的或升级套餐` : '当前套餐不含知识库，请联系平台升级套餐', { quota, used })
      }
      if (await db.knowledgeBaseByName(req.params.id, name)) throw new HttpError(409, `已经有一个叫「${name}」的知识库了`)
      const row = await db.insertKnowledgeBase({ companyId: req.params.id, name, desc, share, createdBy: account.id })
      if (botIds.length) await db.setKnowledgeShares(row.id, botIds)
      return row
    })
    await db.audit({ companyId: req.params.id, accountId: account.id, action: 'knowledge.create', detail: { id: kb.id, name, share, botIds } })
    json(res, 201, { knowledge: publicKnowledgeBase(kb, botIds) })
  })

  /** 名单只能填本公司的 Bot。有一个不是就整单 400，不悄悄丢——那会让管理员以为存上了。 */
  async function botIdsOf(companyId: string, raw: unknown): Promise<string[]> {
    if (!Array.isArray(raw)) throw new HttpError(400, 'botIds 必须是数组')
    const ids = [...new Set(raw.map((x) => String(x ?? '').trim()).filter(Boolean))]
    if (ids.length > 200) throw new HttpError(400, '名单最多 200 颗 Bot')
    const known = new Set((await db.companyBots(companyId)).map((b) => b.id))
    for (const id of ids) if (!known.has(id)) throw new HttpError(400, `Bot ${id} 不是这家公司的`)
    return ids
  }

  router.get('/orgs/:id/knowledge/:kbId', async (req, res) => {
    const account = await requireOrgUser(req, db, keys, req.params.id)
    const kb = await visibleOne(account, req.params.id, req.params.kbId)
    const files = await db.knowledgeFiles(kb.id)
    json(res, 200, {
      knowledge: publicKnowledgeBase(kb, isAdmin(account) ? await db.knowledgeShares(kb.id) : []),
      files: files.map(publicKnowledgeFile),
      enabled: enabled(),
      reason: disabledReason(),
      canEdit: isAdmin(account),
    })
  })

  router.patch('/orgs/:id/knowledge/:kbId', async (req, res) => {
    const { account, kb } = await adminKb(req, req.params.id)
    const body = bodyOf(req)
    const name = 'name' in body ? nameOf(body, 'name', KB_NAME_MAX) : kb.name
    const desc = 'desc' in body ? nameOf(body, 'desc', KB_DESC_MAX, false) : kb.desc
    if (name !== kb.name) {
      const clash = await db.knowledgeBaseByName(req.params.id, name)
      if (clash && clash.id !== kb.id) throw new HttpError(409, `已经有一个叫「${name}」的知识库了`)
    }
    const next = await db.updateKnowledgeBase(kb.id, { name, desc })
    if (!next) throw new HttpError(404, '没有这个知识库')
    await db.audit({ companyId: req.params.id, accountId: account.id, action: 'knowledge.update', detail: { id: kb.id, name, desc } })
    json(res, 200, { knowledge: publicKnowledgeBase(next, await db.knowledgeShares(kb.id)) })
  })

  /** 整份覆盖，不做增删。`share ≠ 'bots'` 时名单清空（§16 不变量 7）。 */
  router.put('/orgs/:id/knowledge/:kbId/share', async (req, res) => {
    const { account, kb } = await adminKb(req, req.params.id)
    const body = bodyOf(req)
    const share = shareOf(body.share)
    const botIds = share === 'bots' ? await botIdsOf(req.params.id, body.botIds ?? []) : []
    await db.tx(async () => {
      await db.updateKnowledgeBase(kb.id, { share })
      await db.setKnowledgeShares(kb.id, botIds)
    })
    await db.audit({ companyId: req.params.id, accountId: account.id, action: 'knowledge.share', detail: { id: kb.id, share, botIds } })
    const next = (await db.knowledgeBase(kb.id)) ?? kb
    json(res, 200, { knowledge: publicKnowledgeBase(next, botIds) })
  })

  /** 标删除，立刻回；真正的清理在 tick 里（§9）。 */
  router.delete('/orgs/:id/knowledge/:kbId', async (req, res) => {
    const { account, kb } = await adminKb(req, req.params.id)
    await db.markKnowledgeDeleting(kb.id)
    await db.audit({ companyId: req.params.id, accountId: account.id, action: 'knowledge.delete', detail: { id: kb.id, name: kb.name, files: kb.fileCount } })
    kick()
    json(res, 200, { deleted: true, id: kb.id })
  })

  // ── 文件 ──────────────────────────────────────────────────────────────

  /**
   * 登记 + 预留容量。容量在这一步就扣：两份文件同时传、各自看到「还剩 150 MB」、各传 120 MB，
   * 传完才发现超了——那时文件已经在 Blob 上了（§5.2）。
   */
  router.post('/orgs/:id/knowledge/:kbId/files', async (req, res) => {
    const { account, kb } = await adminKb(req, req.params.id)
    requireVector()
    requireStore()
    await requireNotExpired(req.params.id)
    const body = bodyOf(req)
    const name = cleanFileName(strField(body, 'name'))
    const ext = requireSupported(name)
    const bytes = Math.trunc(Number(body.bytes))
    if (!Number.isFinite(bytes) || bytes <= 0) throw new HttpError(400, 'bytes 必须是正整数')
    if (bytes > KB_FILE_MAX) throw new HttpError(413, `单个文件最多 ${Math.round(KB_FILE_MAX / 1024 / 1024)} MB，这份有 ${(bytes / 1024 / 1024).toFixed(1)} MB，建议拆开`)
    const mime = KB_FILE_TYPES[ext]
    const file = await db.tx(async () => {
      await db.lockExclusive(KB_BYTES_LOCK, kb.id)
      const cur = (await db.knowledgeBase(kb.id)) ?? kb
      if (cur.fileCount >= KB_FILES_MAX) throw new HttpError(409, `一个知识库最多 ${KB_FILES_MAX} 个文件`)
      if (cur.bytesUsed + bytes > KB_BYTES_MAX) {
        const left = Math.max(0, KB_BYTES_MAX - cur.bytesUsed)
        throw new HttpError(413, `这个知识库还剩 ${(left / 1024 / 1024).toFixed(1)} MB，放不下这份 ${(bytes / 1024 / 1024).toFixed(1)} MB 的文件`, { left, bytes })
      }
      const row = await db.insertKnowledgeFile({ kbId: kb.id, companyId: kb.companyId, name, mime, bytes, createdBy: account.id })
      await db.refreshKnowledgeCounters(kb.id)
      return row
    })
    const mode = storeMode()
    json(res, 201, {
      file: publicKnowledgeFile(file),
      upload:
        mode === 'blob'
          ? { mode: 'blob-client', pathname: blobPathOf(file), tokenUrl: `/orgs/${encodeURIComponent(kb.companyId)}/knowledge/${encodeURIComponent(kb.id)}/files/token`, doneUrl: `/orgs/${encodeURIComponent(kb.companyId)}/knowledge/${encodeURIComponent(kb.id)}/files/${encodeURIComponent(file.id)}/done` }
          : { mode: 'direct', url: `/orgs/${encodeURIComponent(kb.companyId)}/knowledge/${encodeURIComponent(kb.id)}/files/${encodeURIComponent(file.id)}/content` },
    })
  })

  /**
   * Blob 客户端 token（只在对象存储模式下有）。`handleUpload` 两种事件都走这条：签 token，
   * 以及 Blob 传完的回调。回调在本机开发时到不了（Blob 打不到 localhost），所以浏览器传完
   * 还会自己打一次 `/done`——两条路都把文件标成 queued，谁先到谁算。
   */
  router.post('/orgs/:id/knowledge/:kbId/files/token', async (req, res) => {
    if (storeMode() !== 'blob') throw new HttpError(400, '当前不是对象存储模式，直接 PUT 文件内容')
    const body = bodyOf(req) as unknown as HandleUploadBody
    const kbId = req.params.kbId
    const orgId = req.params.id
    // 回调那一跳是 Blob 打过来的，不带我们的登录票；签 token 那一跳必须是管理员。
    if (body?.type === 'blob.generate-client-token') await adminKb(req, orgId)
    const out = await handleUpload({
      request: req,
      body,
      token: (process.env.BLOB_READ_WRITE_TOKEN || '').trim(),
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        let payload: { fileId?: string } = {}
        try {
          payload = JSON.parse(clientPayload || '{}')
        } catch {}
        const file = await db.knowledgeFile(String(payload.fileId || ''))
        if (!file || file.kbId !== kbId || file.companyId !== orgId || file.status !== 'uploading') throw new HttpError(404, '没有这个待上传的文件')
        if (pathname !== blobPathOf(file)) throw new HttpError(400, '上传路径不对')
        return {
          maximumSizeInBytes: Math.min(KB_FILE_MAX, file.bytes + 1024),
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ fileId: file.id }),
          callbackUrl: `${originOf(req)}/orgs/${encodeURIComponent(orgId)}/knowledge/${encodeURIComponent(kbId)}/files/token`,
        }
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        let payload: { fileId?: string } = {}
        try {
          payload = JSON.parse(tokenPayload || '{}')
        } catch {}
        const file = await db.knowledgeFile(String(payload.fileId || ''))
        if (!file || file.kbId !== kbId || file.status !== 'uploading') return
        await finishBlobUpload(file, blob.url)
      },
    })
    json(res, 200, out)
  })

  /** 浏览器直传完了自己来报：核一下 Blob 上真有、路径对得上，然后排队。 */
  router.post('/orgs/:id/knowledge/:kbId/files/:fileId/done', async (req, res) => {
    const { kb } = await adminKb(req, req.params.id)
    const file = await fileOf(kb, req.params.fileId)
    if (file.status !== 'uploading') {
      json(res, 200, { file: publicKnowledgeFile(file) })
      return
    }
    const url = strField(bodyOf(req), 'url')
    const next = await finishBlobUpload(file, url)
    kick()
    json(res, 200, { file: publicKnowledgeFile(next) })
  })

  async function finishBlobUpload(file: KnowledgeFile, url: string): Promise<KnowledgeFile> {
    const meta = await verifyBlobUpload(file, url)
    if (meta.size > KB_FILE_MAX) {
      await db.updateKnowledgeFile(file.id, { storage: url, bytes: meta.size, status: 'failed', error: '文件比登记的大，超过单文件上限' })
      await db.refreshKnowledgeCounters(file.kbId)
      throw new HttpError(413, '文件比登记的大，超过单文件上限')
    }
    const next = await db.updateKnowledgeFile(file.id, { storage: url, bytes: meta.size || file.bytes, status: 'queued', error: '' })
    await db.refreshKnowledgeCounters(file.kbId)
    return next ?? file
  }

  /** 自托管那条路：流式 PUT 到 Gateway，边收边写盘。 */
  router.putRaw('/orgs/:id/knowledge/:kbId/files/:fileId/content', async (req, res) => {
    const { kb } = await adminKb(req, req.params.id)
    const file = await fileOf(kb, req.params.fileId)
    if (file.status !== 'uploading') throw new HttpError(409, '这份文件已经传过了')
    // 比登记的多给一点余量：浏览器报的 size 和真正的字节数偶尔差一个 BOM。
    let stored
    try {
      stored = await saveStream(file, req as unknown as AsyncIterable<Buffer>, Math.min(KB_FILE_MAX, file.bytes + 1024))
    } catch (e) {
      // 收不下来的（超大、半路断了）当场把登记撤掉：留一行 uploading 等一小时后的清扫，
      // 这一小时里它占着容量、界面上还一直「上传中」。
      await db.deleteKnowledgeFile(file.id)
      await db.refreshKnowledgeCounters(kb.id)
      throw e
    }
    const next = await db.updateKnowledgeFile(file.id, { ...stored, status: 'queued', error: '' })
    await db.refreshKnowledgeCounters(kb.id)
    kick()
    json(res, 200, { file: publicKnowledgeFile(next ?? file) })
  })

  router.post('/orgs/:id/knowledge/:kbId/files/:fileId/retry', async (req, res) => {
    const { account, kb } = await adminKb(req, req.params.id)
    requireVector()
    const file = await fileOf(kb, req.params.fileId)
    if (file.status !== 'failed') throw new HttpError(409, '只有失败的文件能重试')
    if (!file.storage) throw new HttpError(409, '原文件丢失，请删掉重新上传')
    const next = await retryKnowledgeFile(db, file)
    await db.audit({ companyId: req.params.id, accountId: account.id, action: 'knowledge.file.retry', detail: { id: file.id, kbId: kb.id, name: file.name } })
    kick()
    json(res, 200, { file: publicKnowledgeFile(next) })
  })

  /** 原文件。Blob 的走 Gateway 代理：私有 Blob 的 token 不能发给浏览器。 */
  router.get('/orgs/:id/knowledge/:kbId/files/:fileId/download', async (req, res) => {
    const account = await requireOrgUser(req, db, keys, req.params.id)
    const kb = await visibleOne(account, req.params.id, req.params.kbId)
    const file = await fileOf(kb, req.params.fileId)
    if (!file.storage) throw new HttpError(404, '原文件还没传完')
    const { body, length } = await openStored(file)
    sendFile(res, file, length)
    await pipeline(body, res).catch(() => undefined)
  })

  function sendFile(res: ServerResponse, file: KnowledgeFile, length: number | null): void {
    const ascii = file.name.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '')
    res.writeHead(200, {
      'content-type': file.mime || 'application/octet-stream',
      'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      ...(length != null ? { 'content-length': String(length) } : {}),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store',
    })
  }

  router.delete('/orgs/:id/knowledge/:kbId/files/:fileId', async (req, res) => {
    const { account, kb } = await adminKb(req, req.params.id)
    const file = await fileOf(kb, req.params.fileId)
    try {
      await deleteKnowledgeFileNow(db, file)
    } catch (e) {
      if (e instanceof HttpError) throw e
      throw new HttpError(502, `删文件没成功，再点一次：${(e as Error).message}`)
    }
    await db.audit({ companyId: req.params.id, accountId: account.id, action: 'knowledge.file.delete', detail: { id: file.id, kbId: kb.id, name: file.name, bytes: file.bytes } })
    json(res, 200, { deleted: true, id: file.id })
  })

}
