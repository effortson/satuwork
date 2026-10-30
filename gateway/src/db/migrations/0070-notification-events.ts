/** 可重放的通知元数据；同一业务事件重报不会创建第二条。 */
export const SQL = `
  create table if not exists notification_events (
    id text primary key,
    "accountId" text not null references accounts(id) on delete cascade,
    "botId" text not null references catalog_items(id) on delete cascade,
    "sessionId" text not null,
    seq bigint not null check (seq > 0),
    kind text not null check (kind in ('turn-end', 'approval', 'handoff')),
    "actionId" text not null default '',
    "createdAt" bigint not null,
    "dueAt" bigint not null,
    "expiresAt" bigint not null,
    "resolvedAt" bigint,
    unique ("accountId", "botId", "sessionId", seq, kind)
  );
  create index if not exists notification_events_account on notification_events ("accountId", "botId", "sessionId", seq);
  create index if not exists notification_events_due on notification_events ("dueAt") where "resolvedAt" is null;
`
