/**
 * 0063 · 本地 Bot 最近一次来领派活是什么时候（docs/bot-tasks.md §2）。
 *
 * 远程 Bot 能不能接活，Gateway 看得见（席位部署了没有、机器配好没有、管家够不够新）；本地 Bot
 * 跑在人自己的桌面端里，Gateway 原来一样都不知道，派过去一律排队——桌面端没开、或者那颗没在跑，
 * 主 Bot 要干等十分钟才拿到「一直没人来领」。桌面端每颗本地 Bot 每几秒来领一次活，记下最近那次，
 * 派活时一看就知道它在不在。
 *
 * `botId` 是 `*` 的那一行是老桌面端（领活不带 botId）：分不出是哪颗，只知道这个账号有本地 Bot 在跑。
 */
export const SQL = `
  create table if not exists local_bot_polls (
    "accountId" text not null references accounts(id) on delete cascade,
    "botId"     text not null,
    "seenAt"    bigint not null,
    primary key ("accountId", "botId")
  );
`
