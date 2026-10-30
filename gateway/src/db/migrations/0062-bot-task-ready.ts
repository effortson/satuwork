/**
 * 0062 · 派活的这一步最近一次「放出来等人领」是什么时候。
 *
 * 「一直没人来领」原来拿 createdAt（run）/ endedAt（deliver）算：租约到期放回去再领的那一条，
 * 这两个时刻还是最初的——跑过十分钟的活，一放回去就在同一次清扫里被判成「没人来领」，三次重领
 * 形同虚设，送回主 Bot 的原因也写错。放出来的那一刻单记一列；旧行是 null，退回原来的算法。
 */
export const SQL = `
  alter table bot_tasks add column if not exists "readyAt" bigint;
`
