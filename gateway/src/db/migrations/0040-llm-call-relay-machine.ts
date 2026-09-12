/**
 * 给 `llm_calls` 记一格「这一行是中继授权出去的，谁领走的」，好让未结算清扫**只扫它该扫的**。
 *
 * 清扫（routines.ts 的 sweepUnsettledLlmCalls）要收的是「管家拿了 grant 却没回来结算」的调用。
 * 它原先的判据只有两条：登记时间够老、账本上没有对应行。问题是 `llm_calls` 从 0001 就有，而
 * 账本（`usage_charges.refId`）是 0007 才加的——**0007 之前的每一行都同时满足这两条**，于是
 * 升级后的第一拍开始，清扫按 createdAt 升序一路往回刷历史，每拍给 200 条老调用补一行
 * `failed` / 0 元 / unpriced 的账。
 *
 * 三样东西一起坏掉：
 *
 * - docs/billing.md §11 写死了「历史模型调用一行都不回填」——按今天的单价去补一段从来没收过
 *   的钱，补出来的是凭空的欠账，所以当初连回填脚本都刻意不碰模型调用。清扫绕过这条规矩。
 * - `unledgeredCalls`（db.ts 的 llmUsageByCompanyModel）数的正是「账本上没有对应行」的调用，
 *   管理台那条横幅靠它提示「这一段账是空的」。全给补上之后这个信号恒为 0，再也提示不出来。
 * - `insertUsageCharge` 盖的是**当下**的时间戳，于是几年前的调用集体落在本月账单页上。
 *
 * 所以判据改成「中继真的授权过」：`relayMachineId` 非空。这一格由 grant 那条路写（worker.ts
 * 领授权时带上机器 id），/v1 自己代理的那几条不写——它们有 withSettle 兜着，本来也不该被扫。
 * 历史行这一格全是 null，从此再也匹配不上。
 *
 * 部分索引只收非空那一撮：清扫每半分钟跑一拍，不能让它去全表扫一张只会越来越长的流水表。
 */
export const SQL = `
  alter table llm_calls add column if not exists "relayMachineId" text;
  create index if not exists llm_calls_unsettled on llm_calls ("createdAt") where "relayMachineId" is not null;
`
