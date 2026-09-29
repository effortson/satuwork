/**
 * 0035 · 同一条日常任务同一时刻最多一条 `running` 流水。
 *
 * 「试跑」按钮和调度器都是先查 `routineRunning` 再插流水，两步之间没有锁——并发点两下
 * 就会有两条 running 进同一个会话。把判据做进库里，插入撞上唯一索引就是「上一次还在跑」，
 * 路由和 tick 都不必再自己上锁。
 *
 * **建索引之前先去重。** 这条迁移要防的正是「已经并发出两条 running」，存量库里真有这种
 * 行的话，裸建唯一索引当场失败，Gateway 就起不来了。每条任务只留最新的一条 running，
 * 其余的记成 error（它们本来也不会再有人去收尾）。已经跑过这一条的库不受影响——
 * 旧版本的校验和记在 index.ts 的 `previousChecksums` 里。
 */
export const SQL = `
  update routine_runs r
     set status = 'error',
         error = '同一条任务同时有多条运行中的流水，升级时只保留最新一条',
         "endedAt" = (extract(epoch from clock_timestamp()) * 1000)::bigint
   where r.status = 'running'
     and exists (
       select 1 from routine_runs n
        where n."routineId" = r."routineId"
          and n.status = 'running'
          and (n."startedAt" > r."startedAt" or (n."startedAt" = r."startedAt" and n.id > r.id))
     );
  create unique index if not exists routine_runs_one_running
    on routine_runs ("routineId") where status = 'running';
`
