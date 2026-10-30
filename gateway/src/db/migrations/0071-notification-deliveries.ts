/** 投递和阅读分别记；租约让重启、Cron 和并发实例能安全接着处理。 */
export const SQL = `
  create table if not exists notification_deliveries (
    "eventId" text not null references notification_events(id) on delete cascade,
    "deviceId" text not null,
    "leaseId" text not null,
    "leaseUntil" bigint not null,
    "deliveredAt" bigint,
    outcome text,
    primary key ("eventId", "deviceId")
  );
`
