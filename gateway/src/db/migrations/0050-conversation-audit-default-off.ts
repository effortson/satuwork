/**
 * 0050 · 自动审计改成默认关，存量公司一律关掉。
 *
 * 出厂值在 db/types.ts 改了，但老公司的 settings.payload 里早就写着 `enabled: true`——
 * 任何一次 putSettings 都会把整份 conversationAudit 原样落盘，当时的出厂值就这么存了下来。
 * 到这一版为止，界面和接口都没有能改 `enabled` 的地方，所以这些 true **没有一条是管理员
 * 自己选的**，按新默认一律改成 false。要审计的公司在审计页把开关打开即可。
 *
 * 这是一次数据改写，放在迁移里是为了每个库只跑一次、跟着这一版一起上；新库一行都不会命中。
 */
export const SQL = `
  update settings
     set payload = jsonb_set(payload, '{conversationAudit,enabled}', 'false'::jsonb),
         "updatedAt" = (extract(epoch from now()) * 1000)::bigint
   where payload->'conversationAudit'->>'enabled' = 'true';
`
