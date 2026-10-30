import { randomUUID } from 'node:crypto'
import { DbCore } from './core.ts'

export class ContentReportsDb extends DbCore {
  async insertContentReport(accountId: string, input: { botId: string; sessionId: string; seq: number; reason: string; excerpt: string; note: string }) {
    return this.tx(async () => {
      await this.xactLock('contentReport', accountId)
      const count = await this.one('select count(*)::int as n from content_reports where "accountId" = ? and "createdAt" > ?', [accountId, Date.now() - 3600_000])
      if (Number(count?.n) >= 20) return null
      const id = randomUUID()
      await this.run('insert into content_reports (id, "accountId", "botId", "sessionId", seq, reason, excerpt, note, "createdAt") values (?,?,?,?,?,?,?,?,?)',
        [id, accountId, input.botId, input.sessionId, input.seq, input.reason, input.excerpt, input.note, Date.now()])
      return id
    })
  }

  async contentReports(before = Date.now() + 1, beforeId = '') {
    // Bound retention on reads as well: expired report text is never exposed to the review queue.
    await this.pruneContentReports()
    return this.many('select * from content_reports where ("createdAt" < ? or ("createdAt" = ? and id < ?)) order by "createdAt" desc, id desc limit 50', [before, before, beforeId])
  }

  async pruneContentReports() {
    await this.run('delete from content_reports where "createdAt" < ?', [Date.now() - 180 * 86400_000])
  }

  async reviewContentReport(id: string, note: string) {
    return this.one('update content_reports set status = ?, "reviewNote" = ?, "reviewedAt" = ? where id = ? returning id', ['reviewed', note, Date.now(), id])
  }
}
