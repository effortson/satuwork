/**
 * 0058 · 主 Bot 派活（docs/bot-tasks.md）。
 *
 * 一行一次派活：主 Bot 把一件事交给名单上另一颗 Bot，对方在自己的席位上做完，结论再送回主 Bot
 * 的对话。两颗席位之间唯一的公共点就是这张表——Gateway 不敲任何席位，各方来领（owner）、
 * 按租约干（leaseUntil）、回报结果（result）。状态只往前走：
 *
 *   queued → running → reporting → delivering → done
 *                                             ↘ failed（只有「送不回主 Bot」这一种）
 *
 * 归属是 accountId：两头都是这个人名下的席位。删 Bot、删账号级联掉。
 */
export const SQL = `
  create table if not exists bot_tasks (
    id              text primary key,
    "accountId"     text not null references accounts(id) on delete cascade,
    "companyId"     text not null,
    "fromBotId"     text not null references catalog_items(id) on delete cascade,
    "toBotId"       text not null references catalog_items(id) on delete cascade,
    "fromSessionId" text,
    "callId"        text,
    instruction     text not null,
    status          text not null check (status in ('queued', 'running', 'reporting', 'delivering', 'done', 'failed')),
    owner           text,
    "leaseUntil"    bigint,
    attempts        integer not null default 0,
    "runSessionId"  text,
    "runKind"       text,
    result          text,
    error           text,
    "createdAt"     bigint not null,
    "startedAt"     bigint,
    "endedAt"       bigint,
    "deliveredAt"   bigint
  );
  create index if not exists bot_tasks_owner on bot_tasks (owner, "createdAt") where status in ('queued', 'reporting') and "leaseUntil" is null;
  create index if not exists bot_tasks_lease on bot_tasks ("leaseUntil") where status in ('running', 'delivering');
  create index if not exists bot_tasks_session on bot_tasks ("accountId", "fromSessionId", "createdAt" desc);
`
