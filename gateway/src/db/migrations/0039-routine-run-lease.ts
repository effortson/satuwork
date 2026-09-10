/**
 * 日常任务可以由席位机器上的工人来跑（docs/adr-gateway-vercel-neon.md §3、§7 第 4 步）。
 *
 * Gateway 从此不再主动打进席位：机器够新（协议 ≥ MIN_WORKER_PROTOCOL）时，到点的任务由
 * 那台机器的工人来领（`GET /worker/routines/due`），在本机跑完再回报。流水上因此多两格：
 *
 * - `machineId` —— 这一次是哪台机器领走的。null = Gateway 自己跑的（老机器、试跑）。
 * - `leaseUntil` —— 工人的租约到什么时候。工人跑的时候按节拍续；进程死了没人续，到点
 *   Gateway 的清扫把它记成「机器没回报」并排补跑。**这是「机器离线导致漏跑」的记法**：
 *   下沉之后 Gateway 不再等结果，没有这一格，一台掉线的机器领走的任务会永远 `running`。
 *
 * Gateway 自己跑的那些没有租约，仍按 `startedAt` 划线收（failStaleRoutineRuns），两条规矩
 * 互不干扰：一条看 leaseUntil 非空，一条看 leaseUntil 为空。
 */
export const SQL = `
  alter table routine_runs add column if not exists "machineId" text;
  alter table routine_runs add column if not exists "leaseUntil" bigint;
  create index if not exists routine_runs_lease on routine_runs ("leaseUntil") where status = 'running' and "leaseUntil" is not null;
`
