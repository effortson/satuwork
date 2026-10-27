/** 账号级已读游标。序号只在同一 Bot 的同一会话内比较，正文仍在席位。 */
export const SQL = `
  create table if not exists notification_reads (
    "accountId" text not null references accounts(id) on delete cascade,
    "botId" text not null references catalog_items(id) on delete cascade,
    "sessionId" text not null,
    "lastReadSeq" bigint not null default 0 check ("lastReadSeq" >= 0),
    version bigint not null default 1,
    "updatedAt" bigint not null,
    primary key ("accountId", "botId", "sessionId")
  );
`
