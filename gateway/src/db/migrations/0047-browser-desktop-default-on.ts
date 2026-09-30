/**
 * 0047 · 浏览器改成默认开、站点全放行；新增的席位桌面能力（`desktop`）一律开。
 *
 * 出厂值在 lib/catalog.ts 改了，但那只管得了以后新建的：老公司的模版和公司 / 全局 Bot
 * 早就把 `browser: { on: false, sites: [] }` 明写进了 definition——那是当时的出厂值被
 * 落了盘，分不清哪条是没人动过、哪条是管理员有意关的。产品上的决定是**一律按新默认
 * 来**，之后管理员照样能在 Bot 设置里关掉。
 *
 * 这是一次数据改写，但它和「多出 desktop 这个键」绑在一起（新键要有初值），所以放在
 * 迁移里而不是一次性脚本：新建的库跑到这一条时一行都不会命中，无害。
 *
 * **只动 bot-template 和公司 / 全局 Bot。** 用户 Bot（scope = user）的这几项现取自模版，
 * definition 里本来就没有这两个键，写进去只会多一份永远不被读的副本。
 *
 * 模版的 `version` 顺手 +1：席位靠轮询这个版本号决定要不要重拉（bot/src/catalog），
 * 不加的话已经在跑的席位要等到下一次有人改模版才会看见浏览器开了。
 */
export const SQL = `
  update catalog_items
     set definition = jsonb_set(
           jsonb_set(
             jsonb_set(definition, '{browser}', '{"on": true, "sites": ["*.*"]}'::jsonb, true),
             '{desktop}', '{"on": true}'::jsonb, true),
           '{version}',
           to_jsonb(case when (definition->>'version') ~ '^[0-9]+$' then (definition->>'version')::int + 1 else 2 end),
           true),
         "updatedAt" = (extract(epoch from now()) * 1000)::bigint
   where kind = 'bot-template';

  update catalog_items
     set definition = jsonb_set(
           jsonb_set(definition, '{browser}', '{"on": true, "sites": ["*.*"]}'::jsonb, true),
           '{desktop}', '{"on": true}'::jsonb, true),
         "updatedAt" = (extract(epoch from now()) * 1000)::bigint
   where kind = 'bot' and scope in ('company', 'global');
`
