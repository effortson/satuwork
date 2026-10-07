/**
 * 0051 · 公司知识库（docs/knowledge-base.md）。
 *
 * 四张新表：
 * - knowledge_bases：一家公司的若干个库。`share` 是共享范围（all / bots / none），
 *   `deletingAt` 非空 = 正在删，由 tick 收尾（§9）。
 * - knowledge_shares：share = 'bots' 时的名单，一行一颗 Bot。
 * - knowledge_files：原文件。`status` 走 uploading → queued → processing → ready / failed；
 *   `chunkDone` 记灌进 Upstash 多少片，入库可从这儿接着来（§6.3）。
 * - knowledge_chunks：切出来的文本段，是向量库之外的那份真相（§3）。
 *
 * 套餐三张表各加一列 `knowledgeBases`：一家公司能建几个库。**默认 0**——配额是卖出去的
 * 东西，不是默认送的（§4.3）。存量公司要 owner 在价目表或公司详情里填。
 *
 * 计数列（bytesUsed / fileCount / chunkCount）是从 knowledge_files 算出来的结果，每次
 * 文件增删后重算（db.refreshKnowledgeCounters），不是另一份可以自己漂的真相。
 */
export const SQL = `
  alter table plan_skus add column if not exists "knowledgeBases" integer not null default 0;
  alter table plan_orders add column if not exists "knowledgeBases" integer not null default 0;
  alter table plans add column if not exists "knowledgeBases" integer not null default 0;

  create table if not exists knowledge_bases (
    id           text primary key,
    "companyId"  text not null references companies(id),
    name         text not null,
    "desc"       text not null default '',
    share        text not null default 'all' check (share in ('all', 'bots', 'none')),
    "bytesUsed"  bigint not null default 0,
    "fileCount"  integer not null default 0,
    "chunkCount" integer not null default 0,
    "deletingAt" bigint,
    "createdBy"  text,
    "createdAt"  bigint not null,
    "updatedAt"  bigint not null
  );
  create index if not exists knowledge_bases_company on knowledge_bases ("companyId");

  create table if not exists knowledge_shares (
    "kbId"      text not null references knowledge_bases(id) on delete cascade,
    "botId"     text not null,
    "createdAt" bigint not null,
    primary key ("kbId", "botId")
  );
  create index if not exists knowledge_shares_bot on knowledge_shares ("botId");

  create table if not exists knowledge_files (
    id           text primary key,
    "kbId"       text not null references knowledge_bases(id) on delete cascade,
    "companyId"  text not null,
    name         text not null,
    mime         text not null default '',
    bytes        bigint not null default 0,
    storage      text not null default '',
    sha256       text not null default '',
    status       text not null default 'uploading'
                 check (status in ('uploading', 'queued', 'processing', 'ready', 'failed')),
    error        text not null default '',
    "chunkCount" integer not null default 0,
    "chunkDone"  integer not null default 0,
    attempts     integer not null default 0,
    "leaseUntil" bigint,
    "createdBy"  text,
    "createdAt"  bigint not null,
    "updatedAt"  bigint not null
  );
  create index if not exists knowledge_files_kb on knowledge_files ("kbId", "createdAt");
  create index if not exists knowledge_files_queue on knowledge_files (status, "createdAt")
    where status in ('queued', 'processing', 'uploading');

  create table if not exists knowledge_chunks (
    id       text primary key,
    "fileId" text not null references knowledge_files(id) on delete cascade,
    "kbId"   text not null,
    no       integer not null,
    page     integer,
    text     text not null
  );
  create index if not exists knowledge_chunks_file on knowledge_chunks ("fileId", no);
`
