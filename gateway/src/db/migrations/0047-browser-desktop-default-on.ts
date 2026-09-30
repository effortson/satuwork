/**
 * 0047 · 浏览器改成默认开、站点全放行；新增的席位桌面能力（`desktop`）一律开。
 *
 * 出厂值在 lib/catalog.ts 改了，但那只管得了以后新建的：老公司的模版和公司 / 全局 Bot
 * 早就把 `browser: { on: false, sites: [] }` 明写进了 definition——那是当时的出厂值被
 * 落了盘，分不清哪条是没人动过、哪条是管理员有意关的。产品上的决定是**关着的一律按新
 * 默认打开**，之后管理员照样能在 Bot 设置里关掉。
 *
 * **已经开着的不动，站点名单原样保留。** 开着的那些一定是管理员自己点开的，名单是他
 * 按公司真在用的系统一条条填的；改成 `*.*` 等于悄悄把一份收窄过的授权放宽到整个公网，
 * 而且没有任何地方留痕。
 *
 * `desktop` 是新键：没有才补 `{ on: true }`，有了（这条迁移的早先版本写过）不碰。
 *
 * 这是一次数据改写，但它和「多出 desktop 这个键」绑在一起（新键要有初值），所以放在
 * 迁移里而不是一次性脚本：新建的库跑到这一条时一行都不会命中，无害。
 *
 * **只动 bot-template 和公司 / 全局 Bot。** 用户 Bot（scope = user）的这几项现取自模版，
 * definition 里本来就没有这两个键，写进去只会多一份永远不被读的副本。
 *
 * 模版的 `version` 顺手 +1、`definition.updatedAt` 跟着换：席位靠轮询这个版本号决定要不要
 * 重拉（bot/src/catalog），不加的话已经在跑的席位要等到下一次有人改模版才会看见；
 * 「更新于」读的是 definition 里那一份（botTemplateOf），不换的话界面上看不出它刚被改过。
 */
const STAMP = `(extract(epoch from now()) * 1000)::bigint`
const BROWSER = `case when definition->'browser'->>'on' = 'true' then definition->'browser'
                      else '{"on": true, "sites": ["*.*"]}'::jsonb end`
const DESKTOP = `case when definition ? 'desktop' then definition->'desktop' else '{"on": true}'::jsonb end`

export const SQL = `
  update catalog_items
     set definition = definition || jsonb_build_object(
           'browser', ${BROWSER},
           'desktop', ${DESKTOP},
           'version', case when (definition->>'version') ~ '^[0-9]+$' then (definition->>'version')::int + 1 else 2 end,
           'updatedAt', ${STAMP}),
         "updatedAt" = ${STAMP}
   where kind = 'bot-template';

  update catalog_items
     set definition = definition || jsonb_build_object('browser', ${BROWSER}, 'desktop', ${DESKTOP}),
         "updatedAt" = ${STAMP}
   where kind = 'bot' and scope in ('company', 'global');
`
