/**
 * 0057 · 每个人的「主 Bot」（routes/runtime.ts 的 /runtime/main-bot）。
 *
 * 一人一颗，所以按账号做主键；和名单分类（0056）一样是**个人视图**，不是 Bot 的属性——
 * 同一颗公司 Bot 可以是张三的主 Bot、不是李四的。Bot 删了这一行级联掉，名单上皇冠自然消失。
 */
export const SQL = `
  create table if not exists main_bots (
    "accountId" text primary key references accounts(id) on delete cascade,
    "botId"     text not null references catalog_items(id) on delete cascade,
    "updatedAt" bigint not null
  );
`
