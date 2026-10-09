/**
 * 0054 · 账本行可以被平台**人工改金额 / 按当前单价重算**，改过的行要留痕。
 *
 * docs/billing.md §2 说金额写死不重算，§2.2 开了这一个口子：owner 在明细页上显式操作，
 * 改之前的金额留在 `originalAmountMicros`（只记第一次改之前的那份，改几次都不覆盖），谁改的、
 * 什么时候改的、为什么改各一格。没改过的行这几格是 null / 空串——界面靠 `originalAmountMicros`
 * 是不是 null 判断要不要画「已调整」。
 */
export const SQL = `
  alter table usage_charges add column if not exists "originalAmountMicros" bigint;
  alter table usage_charges add column if not exists "adjustedAt" bigint;
  alter table usage_charges add column if not exists "adjustedBy" text;
  alter table usage_charges add column if not exists "adjustNote" text not null default '';
`
