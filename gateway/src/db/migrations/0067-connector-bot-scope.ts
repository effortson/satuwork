/**
 * 0067 · 插件账号的 Bot 可见范围（docs/connector-bot-scope.md）。
 *
 * 一个人给一把连接设「哪些 Bot 用得上它」。**没有这一行 = all**（默认，也是迁移之前的
 * 行为），所以老数据一行都不用补。
 *
 * 按 (连接, 账号) 存、不在 connector_connections 上加列：公司共用那把是一行连接、全公司
 * 共用，而范围是每个人对自己 Bot 的选择，放在连接行上就只剩一份。
 *
 * `mode` 和名单分开存，不用「名单为空 = 全部」：名单里的 Bot 删光之后，空名单被读成全部
 * 的话，一把只给私人助理的个人邮箱就悄悄对所有 Bot 开放了。有了 `mode`，删光了是「谁都
 * 不给」。名单是 jsonb，读的时候和这个人当前的 Bot 名单取交集，删掉的 id 自然失效。
 */
export const SQL = `
  create table if not exists connector_bot_scopes (
    "connectionId" text not null references connector_connections(id) on delete cascade,
    "accountId"    text not null references accounts(id) on delete cascade,
    mode           text not null check (mode in ('all', 'bots')),
    "botIds"       jsonb not null default '[]',
    "updatedAt"    bigint not null,
    primary key ("connectionId", "accountId")
  );
  create index if not exists connector_bot_scopes_account on connector_bot_scopes ("accountId");
`
