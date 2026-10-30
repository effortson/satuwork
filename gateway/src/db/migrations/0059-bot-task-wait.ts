/**
 * 0059 · 主 Bot 派活改成同步等待（docs/bot-tasks.md §1）。
 *
 * - `waiterUntil`：主 Bot 的席位在这一轮里等着，每次轮询续一次租。对方交回结论时租还在就记成
 *   `answered`（等的一方取走后 `done`）；租过期了走兜底送回（reporting → delivering）。
 * - `cancelledAt`：人按了停止。对方交回结论时据此不再送回主 Bot。
 * - 状态多两个：`answered`、`cancelled`。约束是 0058 建表时 PG 自动起的名字，按名字换掉。
 */
export const SQL = `
  alter table bot_tasks add column if not exists "waiterUntil" bigint;
  alter table bot_tasks add column if not exists "cancelledAt" bigint;
  alter table bot_tasks drop constraint if exists bot_tasks_status_check;
  alter table bot_tasks add constraint bot_tasks_status_check
    check (status in ('queued', 'running', 'answered', 'reporting', 'delivering', 'done', 'failed', 'cancelled'));
  create index if not exists bot_tasks_answered on bot_tasks ("waiterUntil") where status = 'answered';
`
