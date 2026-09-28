/**
 * 0044 · 「这个席位此刻有没有人在装」和「批量更新还没轮到的」都记进库里。
 *
 * 原来前一件事靠进程里的一张 Map（deploy.ts 的 inFlightDeploys）回答。Gateway 进了 Vercel
 * 之后同时跑着好几个实例，那张表只对自己那个实例有效：进度轮询落在另一个实例上就看到
 * 「没人在装」，界面给出「重新部署」，一按就再登记一遍、再发一次 `PUT /seats/:id`。
 *
 * - `deployBeatAt`：推着这次部署的那个进程最近一次报到的时刻。登记时写一次，装的过程中
 *   每十几秒续一次；超过一分钟没续就是那个进程没了（函数被掐、Gateway 重启）。
 *   **只在 `status = 'deploying'` 期间有意义**，落地时和 deployPhase 一起清空。
 * - `deployQueued`：批量更新排下、还没轮到的那一次部署的参数（版本、force、update）。
 *   席位行本身不动（还是 ready、还是旧版本），轮到它时由队列那一段照这份参数去装。
 *
 * 两列都可空；老行没有这两格，行为和「没人在装、没有排队」一样。
 */
export const SQL = `
  alter table seat_runtimes add column if not exists "deployBeatAt" bigint;
  alter table seat_runtimes add column if not exists "deployQueued" jsonb;
  create index if not exists seat_runtimes_deploy_queued on seat_runtimes ("machineId") where "deployQueued" is not null;
`
