/** Explicitly submitted safety reports, separate from automatic conversation storage. */
export const SQL = `
  create table if not exists content_reports (
    id text primary key,
    "accountId" text not null references accounts(id) on delete cascade,
    "botId" text not null,
    "sessionId" text not null,
    seq bigint not null,
    reason text not null,
    excerpt text not null,
    note text not null,
    status text not null default 'open' check (status in ('open', 'reviewed')),
    "reviewNote" text not null default '',
    "createdAt" bigint not null,
    "reviewedAt" bigint
  );
  create index if not exists content_reports_created on content_reports ("createdAt" desc, id);
  create index if not exists content_reports_account on content_reports ("accountId", "createdAt");
`
