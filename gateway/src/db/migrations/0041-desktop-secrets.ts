/**
 * 桌面端本地 Bot 的凭证，和席位那一套（`account_secrets`）分开存。
 *
 * 以前 `POST /runtime/bots/:id/local-bootstrap` 直接把账号那一套 `sat_` / `sk_sw_` 交给任何
 * 一张登录票，而那一套**从来不换**：改口令、管理员重置、`tokenRevokedAt` 全都作废不了它。
 * 于是一张被偷的登录票（七天有效、放在浏览器存储里）一次请求就能换成一对永久有效的凭证——
 * `sk_sw_` 拿公司的钱调模型，`sat_` 读得到 `/runtime/catalog` 里公司 MCP 的明文 token——
 * 受害者事后怎么改口令都收不回来。
 *
 * 分开存之后，这一套只发给桌面端，而且**跟登录票同生共死**：`createdAt` 早于账号的
 * `tokenRevokedAt` 就不再认（db.accountByAccessToken / accountByApiKey）。改口令、被重置
 * 之后桌面端重新登录，再要一次就是新的一套；席位那一套照旧只在服务器和席位机器上，不再
 * 经过任何浏览器。
 *
 * 一个账号一行：同一个人的几台电脑共用这一套，谁先来要谁把它换新，后来的读同一份。
 * 删账号时跟着走（on delete cascade）。
 */
export const SQL = `
  create table if not exists desktop_secrets (
    "accountId"   text primary key references accounts(id) on delete cascade,
    "apiKey"      text not null unique,
    "accessToken" text not null unique,
    "createdAt"   bigint not null
  );
`
