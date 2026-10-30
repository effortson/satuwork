/**
 * 0064 · 管家认的 Gateway 源（心跳自报）。
 *
 * 管家只放行配对时那个 Gateway 地址的跨源请求（manager/src/proxy.ts 的 corsFor）。浏览器直连管家失败时，
 * 前端拿「管家认的源」和页面的源比，不一致就直说该换哪个（gateway/ui/chat.js 的 directFailText）。原来
 * 拿的是 Gateway 自己的 GATEWAY_PUBLIC_URL——可管家完全可能是按另一个地址配的对（内网地址对公网地址），
 * 那时界面会叫人换成一个管家根本不认的地址。改成管家心跳自报；老管家不报，退回 GATEWAY_PUBLIC_URL。
 */
export const SQL = `
  alter table machines add column if not exists "gatewayOrigin" text;
`
