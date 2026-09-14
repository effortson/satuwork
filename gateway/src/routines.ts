/**
 * 日常任务的**调度**：到点了把它抢过来交给该跑的那一方，跑完了把结局记进流水，砸了
 * 排补跑。
 *
 * 定义、排期在 db 与 lib/schedule.ts；这里只回答两个问题——「现在该跑哪几条、归谁」和
 * 「刚才那一条跑成没跑成、还补不补」。
 *
 * ## Gateway 自己不跑
 *
 * 以前到点了 Gateway 自己打进席位：发消息、挂着事件流等这一轮的 `turn/end`，最长二十
 * 分钟。Gateway 搬到 Vercel 之后（docs/adr-gateway-vercel-neon.md §7 第 4 步）那条路
 * 走不通了——函数一回响应就冻住，没有进程能挂二十分钟的流。所以「发消息、等结果」
 * 整段下沉到席位旁边：
 *
 *   · 远程席位：机器上的工人（manager/src/worker）凭 `smt_` 来领（routes/worker.ts）
 *   · 本地 Bot：桌面端里的 Bot 进程自己来领（bot/src/local-routines）
 *
 * Gateway 留下的是**规矩**：谁抢到（claimDue）、错过怎么记（noteMissed）、砸了补不补
 * （settleRun）、跑不了怎么写（noteUnrunnable）、试跑登记给谁（requestManualRun）。
 * 机器够不够新（协议 ≥ MIN_WORKER_PROTOCOL）不再决定「谁跑」，只决定「跑得了跑不了」。
 *
 * ## 砸了会自己再来三次
 *
 * 记下 error 之后还有一句：够得着补救的那几类失败，隔 5 分钟、15 分钟、30 分钟各补跑
 * 一次，三次都不成就停（`RETRY_DELAYS_MS`、`armRetry`）。欠着的那次补跑存在
 * `routines.retryAt`，和排期的 `nextRunAt` 各占一格——人设的「每天 21:00」不会因为
 * 一次失败就被挪走。哪些失败不补（人按了停止、等结果超时、有交接单挡着、试跑），见
 * `settleRun` 与 routes/worker.ts 的 routineFinish。
 */
import { RoutineBusyError, type Db, type Machine, type Routine, type RoutineRun, type RoutineRunTrigger } from './db.ts'
import { nextRunAtOf } from './lib/schedule.ts'
import { MIN_WORKER_PROTOCOL, machineLink } from './deploy.ts'
import { runtimeKindOf } from './lib/catalog.ts'
import { sweepHandoffs } from './handoff-sweep.ts'
import { refreshDiscovered } from './model-discovery.ts'
import { tickBotDeletions, tickConversationAudits } from './conversation-audit.ts'
import { createMeter, type Meter } from './lib/meter.ts'
import { createLlm, type Llm } from './llm.ts'
import { settle } from './lib/llm-billing.ts'

/** 调度器多久看一眼。设成 0 就不起调度器（e2e 里有几条不需要它自己跑）。 */
const TICK_MS = Math.max(0, Math.trunc(Number(process.env.GATEWAY_ROUTINE_TICK_MS ?? 30_000)))
/**
 * 一轮最多等多久。随活交给工人 / 本地 Bot（routes/worker.ts 的 jobOf），它们按这个数等。
 *
 * 这个数不是「一轮对话该有多长」，是「等到什么时候就认定它不会回来了」。定时任务里
 * 长的那种（翻一天的新闻、跑一份报表）十几分钟很正常，所以给得比人等得起的久得多；
 * 真超了也不是「失败」，而是**结果不明**，流水上会这么写。
 */
export const RUN_TIMEOUT_MS = Math.max(60_000, Math.trunc(Number(process.env.GATEWAY_ROUTINE_TIMEOUT_MS ?? 20 * 60_000)))
/** 一轮扫最多处理几条。多了就下一轮再来，别让一次 tick 卡在网络上。 */
export const BATCH = 20

/**
 * 跑砸了之后隔多久再试一次：5 分钟、15 分钟、30 分钟，然后**不再试**。
 *
 * 为什么是退避而不是等距：定时任务失败最常见的原因是那一刻够不着席位——机器还没开、
 * 正在换版、网断了一分钟。这类事多半几分钟内自己就好了，所以第一次补得早；真没好，
 * 那多半不是「再等一会儿」能解决的，越往后越该拉开距离，而不是每五分钟去撞一次同一
 * 堵墙（还每次都在那条会话里留一条红的）。
 *
 * 为什么到三次就停：再往下就是「一整天都在重试」，而这条任务明天还会到点。一件事
 * 连着四次都做不成，要的是有人去看一眼，不是机器接着敲。
 *
 * 环境变量给的是**毫秒的逗号串**，只为把这几十分钟压到 e2e 等得起的量级；写坏了一律
 * 退回默认那三档，不接受「配了一个空表 = 关掉重试」——那是个太容易手滑出来的行为。
 */
const RETRY_DELAYS_MS = parseRetryDelays(process.env.GATEWAY_ROUTINE_RETRY_MS)

function parseRetryDelays(raw: string | undefined): number[] {
  const fallback = [5 * 60_000, 15 * 60_000, 30 * 60_000]
  const parts = String(raw ?? '')
    .split(',')
    .map((x) => Math.trunc(Number(x.trim())))
    .filter((n) => Number.isFinite(n) && n > 0)
  return parts.length ? parts : fallback
}

/** 最多补跑几次。界面上那句「第 N 次，共 M 次」里的 M。 */
export const ROUTINE_RETRY_MAX = RETRY_DELAYS_MS.length
/**
 * 登记之后多久没人来领就算没人了。
 *
 * 只有试跑会处在「登记了、还没人领」的状态（requestManualRun）：工人和本地 Bot 都是
 * 半分钟来一次，三分钟够它们来好几趟；过了还没领，就是机器关着、工人没起来、或者桌面端
 * 没开——记成 error 把原因写明，别让那个圈永远转着（并发判据也一直认为它还在跑）。
 */
const PICKUP_MS = Math.max(1_000, Math.trunc(Number(process.env.GATEWAY_ROUTINE_PICKUP_MS ?? 3 * 60_000)))

function sweepUnclaimed(db: Db): Promise<number> {
  return db
    .failUnclaimedRoutineRuns(Date.now() - PICKUP_MS)
    .then((n) => {
      if (n) console.log(`satuwork-gateway: 收掉了 ${n} 条没人来领的试跑`)
      return n
    })
    .catch((e: Error) => {
      console.error(`satuwork-gateway: 收尾没人领的试跑失败：${e.message}`)
      return 0
    })
}

/** 一轮没跑成，那句给人看的话。正文在对话里，这里只说是哪一类。 */
export function turnFailure(kind: string): string {
  if (kind === 'aborted') return '这一轮被中止了'
  if (kind === 'error') return '这一轮没跑完，出错的经过在对话里'
  return `这一轮以 ${kind} 结束`
}

/**
 * 这一次砸了，排下一次补跑。
 *
 * **`retryCount` 从库里现读**，不用手上那份快照：这一轮可能跑了二十分钟，中间人改过
 * 这条任务，而"补到第几次了"这一格是调度器自己在写的，快照上那个值早过期了。
 *
 * 两种情况到此为止，一格不留（`clearRoutineRetry`）：三次补跑用完了，以及跑的过程中
 * 人把这条任务停用了——它现在的意思是「别自己动」，五分钟后自己动起来正是他刚关掉的
 * 那件事。
 */
async function armRetry(db: Db, routineId: string): Promise<void> {
  const fresh = await db.routine(routineId)
  if (!fresh) return
  if (!fresh.active || fresh.retryCount >= RETRY_DELAYS_MS.length) {
    await db.clearRoutineRetry(routineId)
    return
  }
  await db.armRoutineRetry(routineId, Date.now() + RETRY_DELAYS_MS[fresh.retryCount], fresh.retryCount + 1)
}

export type SettlePatch = { status: 'ok' | 'error'; error?: string | null; sessionId?: string | null }

/**
 * 记下一次运行的结局，**顺手决定还补不补**。工人、本地 Bot、跑不了那一岔（noteUnrunnable）
 * 都走这一条，补跑的规矩才只有一份。
 *
 * `retryable` 是「这件事再试一次有希望吗」，不是「它失败了吗」——够不着席位、席位那一跳
 * 报错、模型那一轮出错，都算；下面几种明写着不补：
 *
 * - **人按了停止**（`aborted`）：他要的就是别跑，五分钟后自己跑起来是最糟的回应
 * - **等结果超时**：那不是失败，是**结果不明**（见 RUN_TIMEOUT_MS）——那一轮很可能
 *   还在席位上跑着，这时候再发一条进同一条会话，就是同一件事做两遍
 * - **有一件转人工的事挡着**：五分钟后它照样挡着，而每补一次就多一张单、多一次通知
 * - **跑不了**（管家太旧、Bot 没部署）：五分钟后还是那样
 *
 * 手动那条路（试跑）**一次都不补**：人就坐在屏幕前，他要的是看这一下成没成，不是
 * 接下来五十分钟里再自己跑三遍。跑成了也不动重试那两格——他手点的这一下，不该把
 * 到点那条链子上欠着的补跑抹掉。
 */
export async function settleRun(
  db: Db,
  routineId: string,
  runId: string,
  trigger: RoutineRunTrigger,
  patch: SettlePatch,
  retryable = false,
): Promise<void> {
  await db.finishRoutineRun(runId, patch)
  if (trigger === 'manual') return
  await (patch.status === 'ok' || !retryable ? db.clearRoutineRetry(routineId) : armRetry(db, routineId)).catch((e: Error) => {
    console.error(`satuwork-gateway: 日常任务 ${routineId} 的重试没排上：${e.message}`)
  })
}

/** 试跑发不出去（Bot 没部署、机器不在线、管家太旧）。路由把它翻成 409。 */
export class RoutineUnrunnableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RoutineUnrunnableError'
  }
}

/**
 * 试跑：**登记一条等人来领的流水**，不自己发。
 *
 * 和到点跑走的是同一条路——同一个工人、同一段指令、同一个会话，区别只有流水上的
 * `trigger`。以前试跑由 Gateway 自己发进席位、挂着流等结果；那条路收掉了（见 ownerOf），
 * 试跑也不能例外，不然「试跑成功、到点不灵」又查无可查。
 *
 * 登记的样子：`status = running`、`machineId` 指向该来领的那一方、**`leaseUntil` 空着**。
 * 空着的租约就是「还没人领」：工人下一次来 `due` 时把它连同到点的一起领走（那一刻租约
 * 才开始计）；隔了 PICKUP_MS 还没人领，sweepUnclaimed 把它收成 error。
 *
 * **先看那台机器在不在线**：不在线的话立刻回 409，比让人对着一个转三分钟的圈强。
 * 本地 Bot 看不出在不在（桌面端不报心跳），只能登记了等。
 */
export async function requestManualRun(db: Db, routine: Routine): Promise<RoutineRun> {
  const owner = await ownerOf(db, routine)
  if (owner.kind === 'none') throw new RoutineUnrunnableError(owner.reason)
  if (owner.kind === 'machine') {
    const machine = await db.machine(owner.machineId)
    if (!machine || machineLink(machine) === 'offline') throw new RoutineUnrunnableError('席位所在的机器不在线')
  }
  return db.insertRoutineRun({
    routineId: routine.id,
    botId: routine.botId,
    accountId: routine.accountId,
    companyId: routine.companyId,
    trigger: 'manual',
    machineId: owner.machineId,
    leaseUntil: null,
  })
}

/**
 * 错过多久就不补了。
 *
 * 迟几分钟照跑：那多半是一次部署重启，21:00 的日报 21:03 发出来没有任何问题。迟到
 * **半小时以上**就不是「晚了」而是「错过了」——停机一整天之后，把昨天那份日报在今天
 * 上午十点发出来，既不是人要的东西，还会在重启那一刻一次涌出来一大批。
 */
export const LATE_MS = Math.max(60_000, Math.trunc(Number(process.env.GATEWAY_ROUTINE_LATE_MS ?? 30 * 60_000)))

/** 错过的那一次也要留痕：流水上记一条，否则界面上「昨晚没跑」和「跑了没事」长得一样。 */
export async function noteMissed(db: Db, routine: Routine, dueAt: number): Promise<void> {
  let run: RoutineRun
  try {
    run = await db.insertRoutineRun({
      routineId: routine.id,
      botId: routine.botId,
      accountId: routine.accountId,
      companyId: routine.companyId,
      trigger: 'schedule',
    })
  } catch (e) {
    // 正有一次在跑（迁移 0035 的唯一索引）：那次会自己收场，「错过」这条留痕就不必了。
    if (e instanceof RoutineBusyError) return
    throw e
  }
  const late = Math.round((Date.now() - dueAt) / 60_000)
  await db.finishRoutineRun(run.id, { status: 'error', error: `错过了这一次（该跑的时候 Gateway 没在跑，已经迟了 ${late} 分钟）` })
}

/**
 * 欠着的那几次补跑，到点了就跑。
 *
 * 和到点那条路的三处不同：
 *
 * - **抢之前先看有没有在跑**（到点那条是先抢后看）。这一条不能反过来：抢到手就等于
 *   把 `retryAt` 抹掉了，而这一次又没跑成，那次补跑就凭空少了一回。留着不抢，等在跑
 *   的那一轮自己收场——跑成了它清掉这串，砸了它排下一次，两条路都收得干净。
 * - **迟太久的直接作废**，不像到点那条还在流水上记一笔「错过了」。停机四小时之后补上
 *   一次四小时前该做的事，和补一份昨天的日报是同一件不该做的事；而那次失败本来就
 *   在运行记录里红着，静静地不补不会让人以为一切正常。
 * - **指令空了就把这串清掉**：人把内容删干净了，等于这条任务现在什么都不做。
 */
/**
 * 「到点的从哪儿来、抢到了交给谁」。Gateway 的 tick 和工人来领，走的是同一套抢法
 * （claimDue），只是来源和去处不同：
 *
 *   · Gateway 的 tick（tickRoutines）：全表扫，**只抢谁都领不走的那些**（Bot 没部署、
 *     管家太旧），抢到就记一条「没跑」的原因。
 *   · 工人 / 本地 Bot（routes/worker.ts）：只扫自己那一份，抢到就登记一条带租约的流水交出去。
 */
export interface DueSource {
  due(now: number, limit: number): Promise<Routine[]>
  retries(now: number, limit: number): Promise<Routine[]>
  /** 这一条归不归这个来源管。不归就不抢、不动，留给另一边。 */
  owns?(routine: Routine): Promise<boolean>
}

export async function claimDue(
  db: Db,
  now: number,
  source: DueSource,
  start: (routine: Routine, trigger: 'schedule' | 'retry') => Promise<void>,
): Promise<number> {
  let fired = 0
  for (const routine of await source.due(now, BATCH)) {
    if (routine.nextRunAt == null) continue
    if (source.owns && !(await source.owns(routine))) continue
    const dueAt = routine.nextRunAt
    const next = nextRunAtOf(routine, now)
    if (!(await db.claimRoutine(routine.id, dueAt, next))) continue
    /**
     * 指令还空着就不跑，**而且什么都不记**。
     *
     * 手动那条路在接口上就回 400（见 routes/routines.ts），到点这条路不拦的话，
     * 界面上点一下「+」建出来、还没来得及写内容的那条任务，会**每天**发一次空消息、
     * 被席位以 400 顶回来、在运行记录里留一条红的——直到有人想起来删掉它。
     *
     * 这一条排在「错过了」前面：一条还没写完的任务，连「错过」都谈不上。
     */
    if (!routine.instruction.trim()) continue
    if (now - dueAt > LATE_MS) {
      await noteMissed(db, routine, dueAt).catch((e: Error) => {
        console.error(`satuwork-gateway: 日常任务 ${routine.id} 的错过记录写不下去：${e.message}`)
      })
      continue
    }
    // 上一次还没跑完就跳过这一次。定时任务撞车的默认答案是「别叠着跑」——同一个
    // 会话里两轮抢着说话，出来的东西谁也不认。
    if (await db.routineRunning(routine.id)) continue
    fired++
    await start(routine, 'schedule').catch((e: Error) => {
      console.error(`satuwork-gateway: 日常任务 ${routine.id} 起不来：${e.message}`)
    })
  }
  // 欠着的那几次补跑（三处不同见 tickRetries 原来的注释：先看在跑、迟太久作废、指令空了清掉）。
  for (const routine of await source.retries(now, BATCH)) {
    if (routine.retryAt == null) continue
    if (source.owns && !(await source.owns(routine))) continue
    if (!routine.instruction.trim() || now - routine.retryAt > LATE_MS) {
      await db.clearRoutineRetry(routine.id).catch((e: Error) => {
        console.error(`satuwork-gateway: 日常任务 ${routine.id} 的重试清不掉：${e.message}`)
      })
      continue
    }
    if (await db.routineRunning(routine.id)) continue
    if (!(await db.claimRoutineRetry(routine.id, routine.retryAt))) continue
    fired++
    await start(routine, 'retry').catch((e: Error) => {
      console.error(`satuwork-gateway: 日常任务 ${routine.id} 的重试起不来：${e.message}`)
    })
  }
  return fired
}

/**
 * 这一次该归谁跑。
 *
 *   · `machine` —— 席位所在机器的工人来领（routes/worker.ts 的 /worker/routines/*）
 *   · `local`   —— 桌面端里的本地 Bot 自己来领（/runtime/local-routines/*）
 *   · `none`    —— 谁都跑不了，`reason` 是给人看的那句话：Bot 还没部署、机器不在了、
 *                  管家太旧（协议 < MIN_WORKER_PROTOCOL，工人单元还没有）
 *
 * **Gateway 自己不跑。** 以前机器不够新时 Gateway 会自己去敲席位、挂着流等二十分钟；
 * 那条路在 Vercel 上根本走不通（函数一回响应就冻住），在 Debian 上也只是给还没升级的
 * 老机器兜底。收掉之后规矩只有一份：到点的活由机器来领，Gateway 只负责抢、记、补。
 *
 * `cache` 让一次 tick 里同一台机器只查一遍。
 */
type RunOwner = { kind: 'machine' | 'local'; machineId: string } | { kind: 'none'; reason: string }

async function ownerOf(db: Db, routine: Routine, cache = new Map<string, Machine | null>()): Promise<RunOwner> {
  const item = await db.catalog(routine.botId)
  if (item && runtimeKindOf(item) === 'local') return { kind: 'local', machineId: `desktop:${routine.accountId}` }
  const rt = await db.seatRuntime(routine.accountId, routine.botId)
  if (!rt?.machineId) return { kind: 'none', reason: '这颗 Bot 还没部署到机器上，没有会话可以发' }
  let machine = cache.get(rt.machineId)
  if (machine === undefined) {
    machine = (await db.machine(rt.machineId)) ?? null
    cache.set(rt.machineId, machine)
  }
  if (!machine) return { kind: 'none', reason: '席位所在的机器已经不在了' }
  if ((machine.protocol ?? 0) < MIN_WORKER_PROTOCOL) {
    return {
      kind: 'none',
      reason: `这台机器的管家太旧（协议 ${machine.protocol ?? 0}，日常任务要 ≥ ${MIN_WORKER_PROTOCOL}），先升级管家`,
    }
  }
  return { kind: 'machine', machineId: machine.id }
}

/**
 * 到点了却没人能跑：流水上记一条 error 把原因写明，**不补**。
 *
 * 静静地跳过不行——界面上和「从来没到点」长得一样，人会以为时间设错了。补也没用：
 * 五分钟后管家还是那个版本。等人把机器升级了，下一次到点自然归工人。
 */
async function noteUnrunnable(db: Db, routine: Routine, trigger: 'schedule' | 'retry', reason: string): Promise<void> {
  let run: RoutineRun
  try {
    run = await db.insertRoutineRun({
      routineId: routine.id,
      botId: routine.botId,
      accountId: routine.accountId,
      companyId: routine.companyId,
      trigger,
    })
  } catch (e) {
    if (e instanceof RoutineBusyError) return
    throw e
  }
  await settleRun(db, routine.id, run.id, trigger, { status: 'error', error: `这一次没跑：${reason}` })
}

/**
 * Gateway 这一拍只碰**谁都领不走**的那些：归工人的一下不动（那台机器自己会来领，
 * routes/worker.ts），本地 Bot 的连 dueRoutines 都不会给出来。剩下的抢过来、记一条
 * 「没跑」的原因，让人看得见。
 */
export async function tickRoutines(db: Db, now = Date.now()): Promise<number> {
  const machines = new Map<string, Machine | null>()
  const reasons = new Map<string, string>()
  return claimDue(
    db,
    now,
    {
      due: (n, limit) => db.dueRoutines(n, limit),
      retries: (n, limit) => db.dueRoutineRetries(n, limit),
      owns: async (routine) => {
        const owner = await ownerOf(db, routine, machines)
        if (owner.kind !== 'none') return false
        reasons.set(routine.id, owner.reason)
        return true
      },
    },
    (routine, trigger) => noteUnrunnable(db, routine, trigger, reasons.get(routine.id) ?? '没有机器能跑它'),
  )
}

/**
 * 工人租约到期没续的那些：流水已经记成「机器没回报」，这里把补跑排上。
 *
 * 和「没跑起来」是同一种失败——够不着席位——所以同样补三次；试跑不补（settleRun 那条
 * 规矩，人就坐在屏幕前）。
 */
function sweepLeases(db: Db): Promise<void> {
  return db
    .failExpiredRoutineLeases(Date.now())
    .then(async (runs) => {
      for (const run of runs) {
        if (run.trigger === 'manual') continue
        await armRetry(db, run.routineId).catch((e: Error) => {
          console.error(`satuwork-gateway: 日常任务 ${run.routineId} 的重试没排上：${e.message}`)
        })
      }
      if (runs.length) console.log(`satuwork-gateway: 收掉了 ${runs.length} 条工人没回报的日常任务`)
    })
    .catch((e: Error) => {
      console.error(`satuwork-gateway: 收尾工人租约失败：${e.message}`)
    })
}

/**
 * 一拍要做的全部事。Debian 上由 startRoutineScheduler 每 30 秒调一次；Vercel 上由 Cron 打
 * `/cron/tick`（routes/cron.ts）每分钟调一次。**两边同一份**，节拍不同而已。
 *
 * 顺序里的每一项都是可重入、无状态的扫描（各有自己的 claim / lease），叠着跑不会做两遍。
 */
export async function maintenanceTick(db: Db): Promise<void> {
  await Promise.resolve()
    .then(() => tickRoutines(db))
    // 没人来领的试跑跟着每一轮收（见 sweepUnclaimed）。
    .then(() => sweepUnclaimed(db))
    .then(() => sweepLeases(db))
    // 管家拿了模型调用的授权却没回来结算的，同一个节拍收（见 sweepUnsettledLlmCalls）。
    .then(() => sweepUnsettledLlmCalls(db))
    /**
     * 转人工的催办跟着同一个节拍走（见 handoff-sweep.ts）。
     *
     * **不新起一个定时器**：两件事的周期一样（半分钟量级的粗节拍），而多一个
     * 定时器就多一处要在关停时记得清的东西——忘了清的表现是进程不退出。
     */
    .then(() => sweepHandoffs(db))
    // 自动对话审计与删除终审复用同一个粗节拍。批次和删除请求都在库里，tick 只负责推进。
    .then(() => tickConversationAudits(db))
    .then(() => tickBotDeletions(db))
    /**
     * 模型目录的自动发现（见 model-discovery.ts）。**同样不新起定时器**——理由和
     * 上面两处一样。它自己按 GATEWAY_MODEL_DISCOVERY_MS 节流（默认 6 小时），
     * 所以挂在这个半分钟的粗节拍上不会真的每半分钟去拉一次。
     */
    .then(() => refreshDiscovered(db).then((r) => {
      if (r.error) console.error(`satuwork-gateway: 模型目录刷新失败：${r.error}`)
      else if (r.ran) console.log(`satuwork-gateway: 模型目录已刷新，models.dev 收录 ${r.added} 个可用模型`)
    }))
    .catch((e: Error) => console.error(`satuwork-gateway: 日常任务扫描失败：${e.message}`))
}

/**
 * 管家拿了授权（`POST /worker/llm/grant`）之后多久没结算就算它死了。
 *
 * 一次调用最长是多长没有硬上限（长回答带工具调用能跑几分钟），所以这个数只能取
 * 「远长于任何一次正常调用」：半小时。取短了会把还在流的那一次先收成 failed，管家随后
 * 来结算时撞上幂等，真实用量就丢了。
 */
const LLM_SETTLE_GRACE_MS = 30 * 60_000

/**
 * 收「授权了、没结算」的模型调用。
 *
 * 管家死在半路（进程被杀、机器断网）时，llm_calls 里留下一行 token 全 0、账本上没有对应
 * 行的记录——正是 settle 的注释里说要避免的「查不到账的调用」。/v1 那边有 withSettle 兜
 * 着，中继这边 Gateway 不在调用的路径上，兜不住，只能事后扫。收成 `failed`、金额 0 且标
 * unpriced：用量不知道，不编数；管家真回来结算时 chargeExistsForRef 会挡住第二笔。
 *
 * **只扫中继真的授权过的那一撮**（`llm_calls.relayMachineId` 非空，迁移 0040）。判据里
 * 少了这一条就成了「够老 + 账本上没对应行」，而账本是 0007 才有的，0007 之前的历史调用
 * 条条命中——这条清扫会掉头去回填历史，每拍 200 行假账。docs/billing.md §11 写死了
 * 「历史模型调用一行都不回填」，理由在那里，别绕过它。详见 db.ts 的 unsettledLlmCalls。
 *
 * 管家带着真实用量回来结算时撞上幂等的那种情况（长流超过下面这个宽限期，这里先收了），
 * **这一行会被补成真的成交**——它从来没成交过，钉着它不放就是把一通真金白银发生过的调用
 * 永久记成 0，而且事后补不回来。那一步在 worker.ts 的已结算分支里走 fillSweptCharge，
 * 判据和边界见 docs/billing.md §2.1。补不上（上一次已经真结过了）才退回 recordUsageOnly，
 * 只把 token 改对，否则这一行的用量就永远停在 0/0。
 *
 * `meter` / `llm` 不从 RouteCtx 拿：这里跑在调度器 / Cron 里，没有路由上下文。单独起一个也
 * 无妨——这条路记的全是 0 元行，Meter 那份「每家公司的余额记忆」根本不会被它扣到。
 *
 * **单价要照样查。** 这条路收的行金额一定是 0（用量不知道），所以单价查不查都不影响收多少；
 * 影响的是账本上那一行**为什么**是 0。`unpriced` 只有一格，两种「算不出来」都写它：目录里
 * 没这个模型的价，和有价但没拿到用量。事后把这两种分开，靠的是行上那份单价快照空不空
 * （见 routes/platform.ts 的 unpricedModels / unmeteredModels）。这里图省事传 cost: undefined
 * 的话，有价的模型也会留下一份空快照，统计屏就会把它报成「目录里没有单价」，让人跑去配置
 * 页找一个不存在的问题。
 */
export async function sweepUnsettledLlmCalls(
  db: Db,
  meter: Meter = createMeter(db),
  now = Date.now(),
  llm?: Llm,
): Promise<number> {
  const due = await db.unsettledLlmCalls(now - LLM_SETTLE_GRACE_MS, 200)
  // 绝大多数拍是空的。Llm 建一个要把内置目录整份铺开，没行要收就别建。
  if (!due.length) return 0
  const catalog = llm ?? createLlm(db)
  let n = 0
  for (const call of due) {
    const account = await db.account(call.accountId)
    if (!account) continue
    // 幂等：查和记之间管家可能刚结算完。settle 之前再看一眼，能省掉大多数重复行；剩下的
    // 竞态窗口（两边同时 insert）账本按 refId 汇总时会合成一行，不至于翻倍。
    if (await db.chargeExistsForRef(call.id)) continue
    try {
      // 目录里可能已经没有这个模型了（平台下架、公司条目删了），和 worker.ts 的结算分支
      // 同一个兜底：查不到就按「没有价」记。
      const found = (await catalog.find(call.companyId, `${call.provider}/${call.model}`)) ??
        { provider: call.provider, id: call.model, cost: undefined }
      await settle(db, meter, account, found, call.id, undefined, 'failed')
      n++
    } catch (e) {
      console.error(`satuwork-gateway: 收未结算的模型调用 ${call.id} 失败：${(e as Error).message}`)
    }
  }
  if (n) console.log(`satuwork-gateway: 收了 ${n} 次管家没回来结算的模型调用`)
  return n
}

/**
 * 起调度器。返回停它的那个函数。
 *
 * 起来的第一件事是把上一代留下的「正在跑」收干净：等结果的 watcher 活在内存里，
 * 进程一停，库里那条 `running` 就再也没人来改了。
 */
export function startRoutineScheduler(db: Db): () => void {
  if (!TICK_MS) {
    console.log('satuwork-gateway: 日常任务调度器没起（GATEWAY_ROUTINE_TICK_MS=0）')
    return () => {}
  }
  void sweepUnclaimed(db)
  let running = false
  const timer = setInterval(() => {
    // 上一轮还没扫完就跳过这一轮：扫的过程里有网络，慢起来会叠。
    if (running) return
    running = true
    void maintenanceTick(db).finally(() => {
      running = false
    })
  }, TICK_MS)
  // 只有它一个定时器的话，进程会因为它一直不退出。
  timer.unref?.()
  return () => clearInterval(timer)
}
