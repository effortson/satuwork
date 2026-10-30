/**
 * 0068 · 管家自动配域名 https 的编排状态（协议 14，见 gateway/src/deploy/https.ts）。
 *
 * 一格 jsonb 而不是拆成好几列：这是一段**有始有终的流程**（下发 → 机器配好 → 外面验过、换地址
 * → 只听回环 → 完成 / 撤回），字段跟着阶段走，拆成列只会多出一堆大部分时候是空的东西。空 =
 * 这台机器从没走过这条路（手工配的、或者根本没配 https），心跳回包里也就不带 `https`。
 */
export const SQL = `
  alter table machines add column if not exists https jsonb;
`
