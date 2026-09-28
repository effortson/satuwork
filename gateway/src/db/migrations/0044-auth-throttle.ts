/**
 * 0044 · 登录类接口的失败计数（lib/auth-throttle.ts）。
 *
 * 一行一个桶：`key` 是 `email:<归一化邮箱>` / `ip:<来源地址>` / `pw:<账号 id>`，`count` 是
 * 这一窗口里算进去的失败次数，`resetAt` 是这一窗口到期的时刻（毫秒）。固定窗口：到期之后
 * 下一次失败把它从 1 重新数起，清扫只是把没人再碰的旧行收掉（routines.ts 的 maintenanceTick）。
 *
 * 必须在库里：Vercel 上是多个函数实例、没有常驻进程，内存里的计数器每个实例各数各的，
 * 等于没限。`create ... if not exists`，两个实例同时起来也只建一次（迁移本身还有一把锁）。
 */
export const SQL = `
  create table if not exists auth_throttle (
    key text primary key,
    count integer not null default 0,
    "resetAt" bigint not null
  );
  create index if not exists auth_throttle_reset_at on auth_throttle ("resetAt");
`
