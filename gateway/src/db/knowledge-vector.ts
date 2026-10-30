import { createHash } from 'node:crypto'
import { DbCore } from './core.ts'

/** 向量表是可选的，没建时查它会报 undefined_table。读和删都把这当成「什么都没有」。 */
function missingTable(e: unknown): boolean {
  return (e as { code?: string })?.code === '42P01'
}
import type { KbHit, KbVectorScope } from '../lib/knowledge-vector.ts'

/** Optional storage, initialized explicitly. The normal migrations never require pgvector. */
export class KnowledgeVectorDb extends DbCore {
  async initializeKnowledgeVectors(profile: string, model: string, dimension: number): Promise<void> {
    const extension = await this.one(`select n.nspname from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='vector'`)
    if (extension?.nspname !== 'public') throw new Error('请先由数据库管理员在 public schema 安装 vector 扩展')
    await this.tx(async () => {
      await this.xactLock('knowledge-vector-schema', 'knowledge-vector-schema:' + this.schema)
      await this.run(`create table if not exists knowledge_vector_config (
        id integer primary key check (id=1), profile text not null, model text not null, dimension integer not null check (dimension=1024)
      )`)
      await this.run(`create table if not exists knowledge_chunk_vectors (
        "chunkId" text primary key references knowledge_chunks(id) on delete cascade,
        embedding public.vector(1024) not null, "textHash" text not null
      )`)
      await this.run('create index if not exists knowledge_chunks_kb on knowledge_chunks ("kbId")')
      await this.run(`create table if not exists knowledge_embedding_usage (
        id bigint generated always as identity primary key,
        "companyId" text not null references companies(id) on delete cascade,
        profile text not null, operation text not null check (operation in ('query','ingest')),
        tokens bigint, inputs integer not null, "createdAt" bigint not null
      )`)
      await this.run('insert into knowledge_vector_config (id,profile,model,dimension) values (1,?,?,?) on conflict (id) do nothing', [profile, model, dimension])
      await this.db.assertKnowledgeVectorProfile(profile)
    })
  }

  /** 表里现有向量属于哪个空间。表还没建回 undefined（不抛：状态页要能画「未初始化」）。 */
  async knowledgeVectorConfig(): Promise<{ profile: string; model: string; dimension: number } | undefined> {
    try {
      const row = await this.one('select profile,model,dimension from knowledge_vector_config where id=1')
      return row ? { profile: String(row.profile), model: String(row.model), dimension: Number(row.dimension) } : undefined
    } catch (e) {
      if (missingTable(e)) return undefined
      throw e
    }
  }

  /**
   * 表是空的才换指纹：没有旧向量可丢，换模型不必重建。不动任何文件——已经「可用」却没有
   * 向量的文件（从旧向量库迁来的）要由管理员点「重建」重新入库，那一下要计费，得是人点的。
   */
  async adoptKnowledgeVectorProfile(profile: string, model: string, dimension: number): Promise<boolean> {
    return this.tx(async () => {
      await this.xactLock('knowledge-vector-schema', 'knowledge-vector-schema:' + this.schema)
      await this.one('select profile from knowledge_vector_config where id=1 for update')
      if (await this.one('select 1 from knowledge_chunk_vectors limit 1')) return false
      return await this.run('update knowledge_vector_config set profile=?,model=?,dimension=? where id=1', [profile, model, dimension]) > 0
    })
  }

  /** 「可用」但一个向量都没有的文件：从旧向量库迁来，或者换模型时表是空的。重建会把它们重新灌进来。 */
  async knowledgeFilesWithoutVectors(): Promise<number> {
    try {
      return Number((await this.one(`select count(*) as n from knowledge_files f join knowledge_bases k on k.id=f."kbId"
        where f.status='ready' and f."chunkCount">0 and k."deletingAt" is null
          and not exists(select 1 from knowledge_chunks c join knowledge_chunk_vectors v on v."chunkId"=c.id where c."fileId"=f.id)`))?.n || 0)
    } catch (e) {
      if (missingTable(e)) return 0
      throw e
    }
  }

  /** Refuse a new vector space until an operator explicitly rebuilds the existing vectors. */
  async assertKnowledgeVectorProfile(profile: string): Promise<void> {
    const row = await this.one('select profile from knowledge_vector_config where id=1')
    if (row?.profile !== profile) throw new Error('Embedding 模型或地址已变更，请先重建知识库向量，不能混用旧向量')
  }

  async upsertKnowledgeVectors(scope: KbVectorScope, profile: string, rows: Array<{ id: string; data: string; vector: number[] }>): Promise<void> {
    const payload = rows.map((row) => ({ id: row.id, embedding: JSON.stringify(row.vector), hash: createHash('md5').update(row.data).digest('hex') }))
    await this.tx(async () => {
      const config = await this.one('select profile from knowledge_vector_config where id=1 for share')
      if (config?.profile !== profile) throw new Error('Embedding 模型已变更，拒绝写入旧模型向量')
      const written = await this.run(`insert into knowledge_chunk_vectors ("chunkId",embedding,"textHash")
        select c.id,r.embedding::public.vector,r.hash
        from jsonb_to_recordset(?::jsonb) as r(id text, embedding text, hash text)
        join knowledge_chunks c on c.id=r.id and md5(c.text)=r.hash
        join knowledge_bases k on k.id=c."kbId"
        where k.id=? and k."companyId"=? and k."deletingAt" is null
        on conflict ("chunkId") do update set embedding=excluded.embedding,"textHash"=excluded."textHash"`,
      [JSON.stringify(payload), scope.id, scope.companyId])
      if (written !== rows.length) throw new Error('知识库分片已变更或不属于当前公司，拒绝写入向量')
    })
  }

  async queryKnowledgeVectors(scope: KbVectorScope, profile: string, vector: number[], topK: number): Promise<KbHit[]> {
    const rows = await this.many(`select c.id,c."fileId",c.no,c.page,c.text,f.name,
        1-(v.embedding OPERATOR(public.<=>) ?::public.vector) as score
      from knowledge_chunk_vectors v join knowledge_chunks c on c.id=v."chunkId"
      join knowledge_files f on f.id=c."fileId" join knowledge_bases k on k.id=c."kbId"
      cross join knowledge_vector_config cfg
      where k.id=? and k."companyId"=? and k."deletingAt" is null and f.status='ready'
        and v."textHash"=md5(c.text) and cfg.id=1 and cfg.profile=?
      order by score desc,c.id limit ?`, [JSON.stringify(vector), scope.id, scope.companyId, profile, topK])
    return rows.map((row) => ({ id: String(row.id), score: Number(row.score), metadata: {
      kbId: scope.id, fileId: String(row.fileId), fileName: String(row.name), no: Number(row.no),
      page: row.page == null ? null : Number(row.page), text: String(row.text),
    } }))
  }

  /** 表还没建就没东西可删：删库、删文件不能因为向量表没初始化而卡住。不在事务里调（报错会废掉事务）。 */
  async deleteKnowledgeVectors(scope: KbVectorScope, fileId?: string): Promise<void> {
    try {
      await this.deleteKnowledgeVectorRows(scope, fileId)
    } catch (e) {
      if (!missingTable(e)) throw e
    }
  }

  private async deleteKnowledgeVectorRows(scope: KbVectorScope, fileId?: string): Promise<void> {
    await this.run(`delete from knowledge_chunk_vectors v using knowledge_chunks c,knowledge_bases k
      where v."chunkId"=c.id and c."kbId"=k.id and k.id=? and k."companyId"=?${fileId ? ' and c."fileId"=?' : ''}`,
    fileId ? [scope.id, scope.companyId, fileId] : [scope.id, scope.companyId])
  }

  async knowledgeVectorCount(): Promise<number> {
    try {
      return Number((await this.one('select count(*) as n from knowledge_chunk_vectors'))?.n || 0)
    } catch (e) {
      if (missingTable(e)) return 0
      throw e
    }
  }

  async recordKnowledgeEmbeddingUsage(companyId: string, profile: string, operation: 'query' | 'ingest', tokens: number | null, inputs: number): Promise<void> {
    await this.run('insert into knowledge_embedding_usage ("companyId",profile,operation,tokens,inputs,"createdAt") values (?,?,?,?,?,?)',
      [companyId, profile, operation, tokens, inputs, Date.now()])
  }

  /**
   * 换模型后的重建：旧向量是派生数据，原文件和文本分片都留着，文件重新排队入库。
   * 平台管理员在「工具配置 → 知识库」点，或运维跑 scripts/reindex-knowledge-vectors.ts。
   */
  async reindexKnowledgeVectors(profile: string, model: string, dimension: number): Promise<number> {
    return this.tx(async () => {
      await this.xactLock('knowledge-vector-schema', 'knowledge-vector-schema:' + this.schema)
      await this.one('select profile from knowledge_vector_config where id=1 for update')
      await this.run('delete from knowledge_chunk_vectors')
      await this.run('update knowledge_vector_config set profile=?,model=?,dimension=? where id=1', [profile, model, dimension])
      return this.run(`update knowledge_files f set status='queued',"chunkDone"=0,attempts=0,error='',"leaseUntil"=null,"updatedAt"=?
        where f."chunkCount">0 and f.status in ('ready','failed','processing','queued')
          and exists(select 1 from knowledge_bases k where k.id=f."kbId" and k."deletingAt" is null)`, [Date.now()])
    })
  }
}
