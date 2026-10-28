/**
 * 知识库：库、共享、文件、切块（docs/knowledge-base.md）。
 */
import { randomUUID } from 'node:crypto'
import type { KnowledgeBase, KnowledgeChunk, KnowledgeFile, KnowledgeFileStatus, KnowledgeShare } from './types.ts'
import { knowledgeBaseOf, knowledgeChunkOf, knowledgeFileOf, num, str } from './rows.ts'
import { DbCore } from './core.ts'

export class KnowledgeDb extends DbCore {
  // ── 知识库（docs/knowledge-base.md）────────────────────────────────────

  /** 这家公司没在删除中的全部库。管理员看的就是这一份。 */
  async knowledgeBasesOf(companyId: string): Promise<KnowledgeBase[]> {
    const rows = await this.many(
      'select * from knowledge_bases where "companyId" = ? and "deletingAt" is null order by "createdAt"',
      [companyId],
    )
    return rows.map(knowledgeBaseOf)
  }

  /**
   * 这颗 Bot 查得到的库：`share = 'all'` 的，加上 `share = 'bots'` 且名单里有它的。
   * 共享范围在这里判，不在席位判——目录是给模型看的提示，不是授权（§13）。
   */
  async knowledgeForBot(companyId: string, botId: string | null): Promise<KnowledgeBase[]> {
    const rows = botId
      ? await this.many(
          `select k.* from knowledge_bases k where k."companyId" = ? and k."deletingAt" is null and (
             k.share = 'all' or (k.share = 'bots' and exists (select 1 from knowledge_shares s where s."kbId" = k.id and s."botId" = ?))
           ) order by k."createdAt"`,
          [companyId, botId],
        )
      : await this.many(
          `select * from knowledge_bases where "companyId" = ? and "deletingAt" is null and share = 'all' order by "createdAt"`,
          [companyId],
        )
    return rows.map(knowledgeBaseOf)
  }

  /**
   * 成员看得见的库：共享给他**任何一颗** Bot 的（`all` 的，或名单里有他的 Bot 的）。
   * `none` 的对成员不存在（§11.2）。
   */
  async knowledgeForAccount(companyId: string, accountId: string): Promise<KnowledgeBase[]> {
    const rows = await this.many(
      `select k.* from knowledge_bases k where k."companyId" = ? and k."deletingAt" is null and (
         k.share = 'all' or (k.share = 'bots' and exists (
           select 1 from knowledge_shares s join catalog_items b on b.id = s."botId"
            where s."kbId" = k.id and b.kind = 'bot' and b."deletingAt" is null
              and (b.scope = 'global' or (b."companyId" = ? and (b.scope = 'company' or b."accountId" = ?)))
         ))
       ) order by k."createdAt"`,
      [companyId, companyId, accountId],
    )
    return rows.map(knowledgeBaseOf)
  }

  /** 含正在删的那些。只给删公司那条路用：那一刻什么都要一起清。 */
  async allKnowledgeBasesOf(companyId: string): Promise<KnowledgeBase[]> {
    const rows = await this.many('select * from knowledge_bases where "companyId" = ? order by "createdAt"', [companyId])
    return rows.map(knowledgeBaseOf)
  }

  /** 每家公司建了几个（不含正在删的），一次查齐。公司列表那一屏用，省得一家一条 count。 */
  async knowledgeCountsByCompany(): Promise<Map<string, number>> {
    const rows = await this.many('select "companyId", count(*)::int as n from knowledge_bases where "deletingAt" is null group by "companyId"')
    return new Map(rows.map((r) => [str(r.companyId), num(r.n)]))
  }

  async knowledgeBase(id: string): Promise<KnowledgeBase | undefined> {
    const r = await this.one('select * from knowledge_bases where id = ?', [id])
    return r ? knowledgeBaseOf(r) : undefined
  }

  async knowledgeBaseByName(companyId: string, name: string): Promise<KnowledgeBase | undefined> {
    const r = await this.one('select * from knowledge_bases where "companyId" = ? and name = ? and "deletingAt" is null', [companyId, name])
    return r ? knowledgeBaseOf(r) : undefined
  }

  /** 配额数的就是它：没在删除中的。正在删的那些不占名额，不然删了还要等一拍才能再建。 */
  async countKnowledgeBases(companyId: string): Promise<number> {
    const r = await this.one('select count(*)::int as n from knowledge_bases where "companyId" = ? and "deletingAt" is null', [companyId])
    return Number((r as { n?: number } | undefined)?.n ?? 0)
  }

  async insertKnowledgeBase(input: { companyId: string; name: string; desc: string; share: KnowledgeShare; createdBy: string | null }): Promise<KnowledgeBase> {
    const now = Date.now()
    const row: KnowledgeBase = {
      id: randomUUID(),
      companyId: input.companyId,
      name: input.name,
      desc: input.desc,
      share: input.share,
      bytesUsed: 0,
      fileCount: 0,
      chunkCount: 0,
      deletingAt: null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    }
    await this.run(
      'insert into knowledge_bases (id, "companyId", name, "desc", share, "bytesUsed", "fileCount", "chunkCount", "deletingAt", "createdBy", "createdAt", "updatedAt") values (?,?,?,?,?,?,?,?,?,?,?,?)',
      [row.id, row.companyId, row.name, row.desc, row.share, 0, 0, 0, null, row.createdBy, now, now],
    )
    return row
  }

  async updateKnowledgeBase(id: string, patch: { name?: string; desc?: string; share?: KnowledgeShare }): Promise<KnowledgeBase | undefined> {
    const cur = await this.knowledgeBase(id)
    if (!cur) return undefined
    const r = await this.one(
      'update knowledge_bases set name=?, "desc"=?, share=?, "updatedAt"=? where id=? returning *',
      [patch.name ?? cur.name, patch.desc ?? cur.desc, patch.share ?? cur.share, Date.now(), id],
    )
    return r ? knowledgeBaseOf(r) : undefined
  }

  /** 写 deletingAt：列表里当场消失，真正的清理由 tick 做（§9）。 */
  async markKnowledgeDeleting(id: string): Promise<void> {
    await this.run('update knowledge_bases set "deletingAt" = ?, "updatedAt" = ? where id = ? and "deletingAt" is null', [Date.now(), Date.now(), id])
  }

  /** 正在删的库，给 tick 收尾用。 */
  async deletingKnowledgeBases(): Promise<KnowledgeBase[]> {
    const rows = await this.many('select * from knowledge_bases where "deletingAt" is not null order by "deletingAt" limit 20')
    return rows.map(knowledgeBaseOf)
  }

  /** 硬删。三张从表 cascade。向量跟着分片级联删；只有 tick 在原文件清掉之后才调。 */
  async deleteKnowledgeBase(id: string): Promise<void> {
    await this.run('delete from knowledge_bases where id = ?', [id])
  }

  /** 重算三个计数列。文件增删、入库完成后调。 */
  async refreshKnowledgeCounters(kbId: string): Promise<void> {
    await this.run(
      `update knowledge_bases set
         "bytesUsed"  = (select coalesce(sum(bytes), 0) from knowledge_files where "kbId" = ?),
         "fileCount"  = (select count(*) from knowledge_files where "kbId" = ?),
         "chunkCount" = (select coalesce(sum("chunkCount"), 0) from knowledge_files where "kbId" = ? and status = 'ready'),
         "updatedAt"  = ?
       where id = ?`,
      [kbId, kbId, kbId, Date.now(), kbId],
    )
  }

  async knowledgeShares(kbId: string): Promise<string[]> {
    const rows = await this.many('select "botId" from knowledge_shares where "kbId" = ? order by "createdAt"', [kbId])
    return rows.map((r) => str(r.botId))
  }

  async knowledgeSharesOfMany(kbIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>()
    if (!kbIds.length) return out
    const rows = await this.many('select "kbId", "botId" from knowledge_shares where "kbId" = any(?::text[]) order by "createdAt"', [kbIds])
    for (const r of rows) {
      const k = str(r.kbId)
      const list = out.get(k) ?? []
      list.push(str(r.botId))
      out.set(k, list)
    }
    return out
  }

  /** 整份覆盖，不做增删。`share ≠ 'bots'` 时名单清空（§16 不变量 7）。 */
  async setKnowledgeShares(kbId: string, botIds: string[]): Promise<void> {
    await this.tx(async () => {
      await this.run('delete from knowledge_shares where "kbId" = ?', [kbId])
      const now = Date.now()
      for (const botId of [...new Set(botIds)]) {
        await this.run('insert into knowledge_shares ("kbId", "botId", "createdAt") values (?,?,?)', [kbId, botId, now])
      }
    })
  }

  // 文件

  async knowledgeFiles(kbId: string): Promise<KnowledgeFile[]> {
    const rows = await this.many('select * from knowledge_files where "kbId" = ? order by "createdAt" desc', [kbId])
    return rows.map(knowledgeFileOf)
  }

  async knowledgeFile(id: string): Promise<KnowledgeFile | undefined> {
    const r = await this.one('select * from knowledge_files where id = ?', [id])
    return r ? knowledgeFileOf(r) : undefined
  }

  async insertKnowledgeFile(input: { kbId: string; companyId: string; name: string; mime: string; bytes: number; createdBy: string | null; status?: KnowledgeFileStatus; storage?: string }): Promise<KnowledgeFile> {
    const now = Date.now()
    const row: KnowledgeFile = {
      id: randomUUID(),
      kbId: input.kbId,
      companyId: input.companyId,
      name: input.name,
      mime: input.mime,
      bytes: input.bytes,
      storage: input.storage ?? '',
      sha256: '',
      status: input.status ?? 'uploading',
      error: '',
      chunkCount: 0,
      chunkDone: 0,
      attempts: 0,
      leaseUntil: null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    }
    await this.run(
      'insert into knowledge_files (id, "kbId", "companyId", name, mime, bytes, storage, sha256, status, error, "chunkCount", "chunkDone", attempts, "leaseUntil", "createdBy", "createdAt", "updatedAt") values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [row.id, row.kbId, row.companyId, row.name, row.mime, row.bytes, row.storage, row.sha256, row.status, row.error, 0, 0, 0, null, row.createdBy, now, now],
    )
    return row
  }

  async updateKnowledgeFile(
    id: string,
    patch: Partial<Pick<KnowledgeFile, 'bytes' | 'storage' | 'sha256' | 'status' | 'error' | 'chunkCount' | 'chunkDone' | 'attempts' | 'leaseUntil'>>,
  ): Promise<KnowledgeFile | undefined> {
    const cur = await this.knowledgeFile(id)
    if (!cur) return undefined
    const next = { ...cur, ...patch, updatedAt: Date.now() }
    const r = await this.one(
      'update knowledge_files set bytes=?, storage=?, sha256=?, status=?, error=?, "chunkCount"=?, "chunkDone"=?, attempts=?, "leaseUntil"=?, "updatedAt"=? where id=? returning *',
      [next.bytes, next.storage, next.sha256, next.status, next.error, next.chunkCount, next.chunkDone, next.attempts, next.leaseUntil, next.updatedAt, id],
    )
    return r ? knowledgeFileOf(r) : undefined
  }

  async deleteKnowledgeFile(id: string): Promise<void> {
    await this.run('delete from knowledge_files where id = ?', [id])
  }

  /**
   * 领一个要入库的文件：排队的，或者在跑但租约过期的（上一拍没跑完）。
   * `for update skip locked` 让两个实例同一拍各领各的，不会抢同一份。
   */
  async claimKnowledgeFile(now: number, leaseMs: number): Promise<KnowledgeFile | undefined> {
    const r = await this.one(
      `update knowledge_files set status = 'processing', "leaseUntil" = ?, "updatedAt" = ?
        where id = (
          select id from knowledge_files
           where status = 'queued' or (status = 'processing' and ("leaseUntil" is null or "leaseUntil" < ?))
           order by "createdAt" limit 1 for update skip locked
        ) returning *`,
      [now + leaseMs, now, now],
    )
    return r ? knowledgeFileOf(r) : undefined
  }

  /** 停在 uploading 太久的（浏览器关了、Blob 回调没来），给 tick 收掉。 */
  async staleUploadingKnowledgeFiles(before: number): Promise<KnowledgeFile[]> {
    const rows = await this.many(`select * from knowledge_files where status = 'uploading' and "createdAt" < ? order by "createdAt" limit 50`, [before])
    return rows.map(knowledgeFileOf)
  }

  // 分片

  /** 一个事务里整份落下：解析到一半被冻住，下一拍看到 chunkCount = 0 就从头来。 */
  async replaceKnowledgeChunks(fileId: string, kbId: string, chunks: Array<{ no: number; page: number | null; text: string }>): Promise<void> {
    await this.tx(async () => {
      await this.run('delete from knowledge_chunks where "fileId" = ?', [fileId])
      const size = 200
      for (let i = 0; i < chunks.length; i += size) {
        const batch = chunks.slice(i, i + size)
        const values = batch.map(() => '(?,?,?,?,?,?)').join(',')
        const params: unknown[] = []
        for (const c of batch) params.push(`${fileId}:${c.no}`, fileId, kbId, c.no, c.page, c.text)
        await this.run(`insert into knowledge_chunks (id, "fileId", "kbId", no, page, text) values ${values}`, params)
      }
      await this.run('update knowledge_files set "chunkCount" = ?, "chunkDone" = 0, "updatedAt" = ? where id = ?', [chunks.length, Date.now(), fileId])
    })
  }

  async knowledgeChunks(fileId: string, from: number, limit: number): Promise<KnowledgeChunk[]> {
    const rows = await this.many('select * from knowledge_chunks where "fileId" = ? and no >= ? order by no limit ?', [fileId, from, limit])
    return rows.map(knowledgeChunkOf)
  }

  async deleteKnowledgeChunks(fileId: string): Promise<void> {
    await this.run('delete from knowledge_chunks where "fileId" = ?', [fileId])
  }
}
