/**
 * 席位工人的接口：机器凭 `smt_` 来领本机的活、回报结果。
 *
 * 这是 Gateway 从「主动打进席位」退到「有事来问我」的那一层（docs/adr-gateway-vercel-neon.md
 * §2.2）。三条规矩，每一条接口都守：
 *
 *   1. **只看得到本机的。** 领任务按席位表连到 machineId；回报时按 (runId, machineId) 找，
 *      别的机器的活一律 404。`smt_` 泄一把，影响面是一台机器。
 *   2. **领取即租约。** 领到手的那一刻流水已经是 `running`、带着 leaseUntil；工人按节拍续，
 *      进程死了没人续，到点 Gateway 的清扫记成「机器没回报」并排补跑（routines.ts 的 sweepLeases）。
 *   3. **规矩只有一份。** 抢法（claimDue）、错过怎么记（noteMissed）、砸了补不补（settleRun）
 *      全是 Gateway 自己跑时的那几个函数——工人只是把「发消息、等 turn/end」那一段搬到了
 *      席位旁边，怎么解释结果仍由这里说了算。
 *
 * 工人那一侧的循环：GET due → 对每条：问席位会话 id → POST started（Gateway 查有没有转人工
 * 挡着）→ 挂流、发消息、等自己那一轮的 turn/end，期间 POST renew → POST finish。
 */
import type { RouteCtx } from './ctx.ts'
import { HttpError, json, type Req, type Router } from '../http.ts'
import { bodyOf, strField } from '../lib/validate.ts'
import { requireMachine } from '../lib/guards.ts'
import { claimDue, RUN_TIMEOUT_MS, settleRun, turnFailure } from '../routines.ts'
import type { Routine, RoutineRun } from '../db.ts'

/**
 * 租约多长。工人每隔它的三分之一续一次；Gateway 那头到期不续就收。
 *
 * 不能跟着一轮的长度走（一轮最长 RUN_TIMEOUT_MS = 20 分钟）：进程被杀之后，接管最多等
 * 一个租约，二十分钟太久。短租约靠续命，和渠道事件那把（channels.ts）同一个道理。
 */
export const ROUTINE_LEASE_MS = Math.max(1_000, Math.trunc(Number(process.env.GATEWAY_ROUTINE_LEASE_MS ?? 60_000)))

/** 交给工人的一条活。够它在本机把这一轮跑起来，不多给。 */
function jobOf(routine: Routine, run: RoutineRun, seatId: string) {
  return {
    runId: run.id,
    routineId: routine.id,
    trigger: run.trigger,
    botId: routine.botId,
    accountId: routine.accountId,
    seatId,
    name: routine.name,
    instruction: routine.instruction,
    modelRole: routine.modelRole,
    leaseMs: ROUTINE_LEASE_MS,
    /** 一轮最多等多久，和 Gateway 自己等的一样。超了记「结果不明」，不补。 */
    timeoutMs: RUN_TIMEOUT_MS,
  }
}

export function attachWorker(router: Router, { db }: RouteCtx) {
  router.get('/worker/routines/due', async (req, res) => {
    const machine = await requireMachine(req, db)
    const now = Date.now()
    const jobs: ReturnType<typeof jobOf>[] = []
    await claimDue(
      db,
      now,
      {
        due: (n, limit) => db.dueRoutinesForMachine(machine.id, n, limit),
        retries: (n, limit) => db.dueRoutineRetriesForMachine(machine.id, n, limit),
      },
      async (routine, trigger) => {
        const rt = await db.seatRuntime(routine.accountId, routine.botId)
        if (!rt) return
        const run = await db.insertRoutineRun({
          routineId: routine.id,
          botId: routine.botId,
          accountId: routine.accountId,
          companyId: routine.companyId,
          trigger,
          machineId: machine.id,
          leaseUntil: now + ROUTINE_LEASE_MS,
        })
        jobs.push(jobOf(routine, run, rt.seatId))
      },
    )
    json(res, 200, { jobs, leaseMs: ROUTINE_LEASE_MS })
  })

  /** 找到本机领走、还在跑的那一条；不是就 404，不区分「别人的」和「没了」。 */
  async function runOf(req: Req, machineId: string): Promise<RoutineRun> {
    const run = await db.routineRunOfMachine(req.params.runId, machineId)
    if (!run) throw new HttpError(404, '这一次不归这台机器，或者已经收场了')
    return run
  }

  /**
   * 工人拿到了会话 id，问一句「能跑吗」。
   *
   * 这条会话上有一张**挡着路**的交接单还没闭合就不跑（理由见 runRoutine 那段），判据取自
   * Gateway 这张表——工人没有库，只能问。挡住的话这里直接把流水收成 error，工人收到
   * `blocked` 就停手，不用再回一次 finish。
   */
  router.post('/worker/routines/:runId/started', async (req, res) => {
    const machine = await requireMachine(req, db)
    const run = await runOf(req, machine.id)
    const sessionId = strField(bodyOf(req), 'sessionId', true)
    const blocking = (await db.handoffsOfSession(sessionId)).find(
      (h) => h.blocking && (h.state === 'open' || h.state === 'claimed'),
    )
    if (blocking) {
      await settleRun(db, run.routineId, run.id, run.trigger, {
        status: 'error',
        error: `这一次没跑：还有一件转人工的事等着人处理（${blocking.ask.slice(0, 60) || '没写要做什么'}）`,
        sessionId,
      })
      json(res, 200, { blocked: blocking.ask.slice(0, 60) || '没写要做什么' })
      return
    }
    await db.finishRoutineRun(run.id, { status: 'running', sessionId })
    await db.renewRoutineRun(run.id, machine.id, Date.now() + ROUTINE_LEASE_MS)
    json(res, 200, { blocked: null })
  })

  router.post('/worker/routines/:runId/renew', async (req, res) => {
    const machine = await requireMachine(req, db)
    const ok = await db.renewRoutineRun(req.params.runId, machine.id, Date.now() + ROUTINE_LEASE_MS)
    if (!ok) throw new HttpError(404, '这一次不归这台机器，或者已经收场了')
    json(res, 200, { leaseMs: ROUTINE_LEASE_MS })
  })

  /**
   * 收场。`kind` 是这一轮怎么结束的，和 Gateway 自己等 turn/end 拿到的是同一套词：
   *
   *   completed        跑成了
   *   aborted          人按了停止 —— 不补
   *   timeout          等结果超时，结果不明 —— 不补（那一轮可能还在跑，再发一条就是做两遍）
   *   failed           压根没跑起来（够不着席位、席位那一跳报错），`error` 里是原话 —— 补
   *   其余（error…）   这一轮以别的原因收场 —— 补
   *
   * 解释权在这里，不在工人：两边各解释一遍迟早分叉。
   */
  router.post('/worker/routines/:runId/finish', async (req, res) => {
    const machine = await requireMachine(req, db)
    const run = await runOf(req, machine.id)
    const body = bodyOf(req)
    const kind = strField(body, 'kind', true)
    const error = body.error == null ? '' : strField(body, 'error', false)
    const sessionId = body.sessionId == null ? undefined : strField(body, 'sessionId', false) || null
    if (kind === 'completed') {
      await settleRun(db, run.routineId, run.id, run.trigger, { status: 'ok', error: null, sessionId })
    } else if (kind === 'timeout') {
      await settleRun(db, run.routineId, run.id, run.trigger, { status: 'error', error: '等结果超时，这一次的结果不明', sessionId })
    } else if (kind === 'failed') {
      await settleRun(db, run.routineId, run.id, run.trigger, { status: 'error', error: (error || '没跑起来').slice(0, 300), sessionId }, true)
    } else {
      await settleRun(
        db,
        run.routineId,
        run.id,
        run.trigger,
        { status: 'error', error: turnFailure(kind), sessionId },
        kind !== 'aborted',
      )
    }
    json(res, 200, { ok: true })
  })
}
