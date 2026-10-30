/**
 * 0072 · 本地 Bot 只属于建它的那台电脑（docs/local-bot-device.md）。
 *
 * - `catalog_items."deviceId"`：本地 Bot 绑在哪台桌面端上（桌面壳 app_data_dir 里 device.json 的 id）。
 *   单独一列，不放进 `definition`：那份 JSON 会经 publicBot 原样发给前端，而且按设备查要走索引。
 *   老的本地 Bot 留 null，不回填——哪台电脑先把它跑起来就归哪台（local-bootstrap 里认领）。
 * - `desktop_devices`：只用于展示（设备名、最后在线）和清理别的电脑上没人管的本地 Bot，
 *   可见性判断不依赖它。
 * - `bot_folders.kind`：`'local'` 是建本地 Bot 时自动放进去的那个「本地 / Local」分类。按标记找
 *   而不按名字找：切了语言、改了名都还是它。一个账号最多一个。
 */
export const SQL = `
  alter table catalog_items add column if not exists "deviceId" text;
  create index if not exists catalog_items_device on catalog_items ("accountId", "deviceId")
    where "deviceId" is not null;

  create table if not exists desktop_devices (
    id           text primary key,
    "accountId"  text not null references accounts(id) on delete cascade,
    name         text not null default '',
    platform     text not null default '',
    "createdAt"  bigint not null,
    "lastSeenAt" bigint not null
  );
  create index if not exists desktop_devices_account on desktop_devices ("accountId");

  alter table bot_folders add column if not exists kind text;
  create unique index if not exists bot_folders_local on bot_folders ("accountId") where kind = 'local';
`
