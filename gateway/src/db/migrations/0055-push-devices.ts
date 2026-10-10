/**
 * 0055 · 手机推送的设备登记（lib/push.ts，docs/adr-core-package-mobile.md §2.5）。
 *
 * 一行一台设备：`token` 是 APNs 发给这台手机这个应用的设备令牌，**做主键**——同一台手机换了
 * 账号登录，这一行跟着改姓，不会留一条旧账号的令牌让上一个人的通知继续弹在新人手上。
 *
 * `environment` 分 sandbox / production：debug 构建拿到的令牌只在 APNs 的 sandbox 那头认，
 * 发错地方 APNs 回 400 BadDeviceToken。由客户端按自己的构建如实报。
 *
 * `updatedAt` 兼作「这次登录是什么时候」：发送前和账号的 tokenRevokedAt 比，登记早于票作废
 * 的那些不发（改了口令 / 被重置之后，那台手机上的登录已经死了，通知不该还往那儿送）。
 */
export const SQL = `
  create table if not exists push_devices (
    token text primary key,
    "accountId" text not null references accounts(id) on delete cascade,
    platform text not null,
    environment text not null,
    "createdAt" bigint not null,
    "updatedAt" bigint not null
  );
  create index if not exists push_devices_account on push_devices ("accountId");
`
