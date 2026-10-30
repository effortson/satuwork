/**
 * 0056 · 侧栏 Bot 名单的分类（routes/runtime.ts 的 /runtime/bot-folders）。
 *
 * **分类是每个人自己的视图，不是 Bot 的属性。** 名单里混着全局 Bot、公司 Bot 和自己建的，
 * 同一颗公司 Bot，销售把它放「客户」、财务把它放「报表」，互不相干；所以分类挂在账号上，
 * 归属也按（账号, Bot）记，而不是在 catalog_items 上加一列。
 *
 * `bot_folder_items` 只记「放进了哪个分类」的那些：没放的就没有行，名单上画在最前面、
 * 不带标题——「默认没有分类」就是这么来的。删分类时这些行跟着级联掉，里面的 Bot 回到没分类；
 * 删 Bot、删账号同理。
 */
export const SQL = `
  create table if not exists bot_folders (
    id          text primary key,
    "accountId" text not null references accounts(id) on delete cascade,
    name        text not null,
    position    integer not null default 0,
    "createdAt" bigint not null,
    "updatedAt" bigint not null
  );
  create index if not exists bot_folders_account on bot_folders ("accountId", position);
  create table if not exists bot_folder_items (
    "accountId" text not null references accounts(id) on delete cascade,
    "botId"     text not null references catalog_items(id) on delete cascade,
    "folderId"  text not null references bot_folders(id) on delete cascade,
    primary key ("accountId", "botId")
  );
  create index if not exists bot_folder_items_folder on bot_folder_items ("folderId");
`
