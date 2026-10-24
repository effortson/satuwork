/**
 * 主 Bot 派活（docs/bot-tasks.md）：建、领、回报、清扫，规矩只有这一份。
 *
 * 和日常任务（routines.ts / routes/worker.ts）同一种形状：Gateway 自己不敲席位，各方来领
 * （owner）、按租约干、回报。两处刻意的不同：
 *
 *  1. **一条任务两步。** run（目标席位把指令跑一轮、带回回复正文）→ deliver（主席位把结论发进
 *     主 Bot 的会话）。每一步各有自己的 owner 和租约，谁来领按那一步要敲哪颗 Bot 定。
 *  2. **目标那边砸了也要送回去。** 主 Bot 要知道「财务那颗没做成，因为席位掉线了」才能换人或
 *     告诉用户；静静地 failed 等于让它永远在等。只有送不回主 Bot 那一种才是 failed。
 */
import type { Account, BotTask, BotTaskProgress, CatalogItem, Db } from '../db.ts'
import { MIN_TASK_WORKER_PROTOCOL, machinePaired } from '../deploy.ts'
import { runtimeKindOf } from './catalog.ts'

/** 等的一方（主 Bot 的席位）每次轮询续多久。轮询是 2 秒一次，60 秒够它挺过几次网络抖动。 */
export const TASK_WAIT_LEASE_MS = Math.max(5_000, Math.trunc(Number(process.env.GATEWAY_TASK_WAIT_LEASE_MS ?? 60_000)))

/**
 * 领走派活的那一方多久续一次租。比日常任务（租约的三分之一，约 20 秒）勤得多：续租的回复里带着
 * 「已经被停了没有」，人在主 Bot 那边按了停止，目标那一轮要**立刻**跟着停（docs/bot-tasks.md §1.2）。
 */
export const TASK_CANCEL_POLL_MS = Math.max(200, Math.trunc(Number(process.env.GATEWAY_TASK_CANCEL_POLL_MS ?? 2_000)))

/** 租约、一轮最多等多久、没人领多久算没人领。和日常任务同一组环境变量，节拍一致。 */
export const TASK_LEASE_MS = Math.max(1_000, Math.trunc(Number(process.env.GATEWAY_ROUTINE_LEASE_MS ?? 60_000)))
export const TASK_TIMEOUT_MS = Math.max(60_000, Math.trunc(Number(process.env.GATEWAY_ROUTINE_TIMEOUT_MS ?? 20 * 60_000)))
const TASK_PICKUP_MS = Math.max(1_000, Math.trunc(Number(process.env.GATEWAY_TASK_PICKUP_MS ?? 10 * 60_000)))
/** 一步最多被领几次（到期没回报就放回去再领）。 */
const MAX_ATTEMPTS = 3
/** 指令最长。再长就不是一句派活，是一份文档——让它写进工作区再派。 */
export const TASK_INSTRUCTION_MAX = 4000
/**
 * 前置任务交回的结论（串行派活）最长。和指令分开算：结论是对方写的，长短由不得主 Bot，
 * 共用一个上限的话前置交回稍长一点，后一件就派不出去。席位那边每条前置已截到 6000 字。
 */
export const TASK_CONTEXT_MAX = 16_000

export type TaskPhase = 'run' | 'deliver'

/** 主 Bot 那头还有人在等吗（docs/bot-tasks.md §1.1）。 */
export function waiting(task: BotTask, now = Date.now()): boolean {
  return task.waiterUntil != null && task.waiterUntil > now
}

export function phaseOf(task: BotTask): TaskPhase | null {
  if (task.status === 'queued' || task.status === 'running') return 'run'
  if (task.status === 'reporting' || task.status === 'delivering') return 'deliver'
  return null
}

/**
 * 续租。回复里带上「已经被停了没有」：人在主 Bot 那边按了停止，领走 run 那一步的一方据此立刻停掉
 * 目标那一轮（docs/bot-tasks.md §1.2）。续不上（不归你、收场了）回 null，路由回 404。
 */
export async function renewTask(db: Db, taskId: string, owner: string, progress?: BotTaskProgress | null): Promise<{ leaseMs: number; cancelled: boolean } | null> {
  if (!(await db.renewBotTask(taskId, owner, Date.now() + TASK_LEASE_MS, progress ?? undefined))) return null
  const task = await db.botTask(taskId)
  return { leaseMs: TASK_LEASE_MS, cancelled: Boolean(task?.cancelledAt) && phaseOf(task!) === 'run' }
}

/** 这一步要敲哪颗 Bot 的会话：run 是目标，deliver 是主 Bot。 */
export function botOfPhase(task: BotTask, phase: TaskPhase): string {
  return phase === 'run' ? task.toBotId : task.fromBotId
}

/**
 * 续租时带上来的进度。**逐字段收、逐字段截**：这段是领活那一方报的，原样存进库、再原样画到
 * 主 Bot 的对话里，形状不对的一律当没报（回 null，不是 400——续租本身不能因为它失败）。
 */
export function taskProgressOf(v: unknown): BotTaskProgress | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, any>
  const steps = Math.trunc(Number(o.steps))
  if (!Number.isFinite(steps) || steps < 0) return null
  const line = (x: unknown, n: number) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, n) : undefined)
  const out: BotTaskProgress = { steps: Math.min(steps, 100_000) }
  const name = line(o.tool?.name, 80)
  if (name) {
    const detail = line(o.tool?.detail, 160)
    out.tool = { name, ...(detail ? { detail } : {}) }
  }
  const done = Math.trunc(Number(o.todo?.done))
  const total = Math.trunc(Number(o.todo?.total))
  if (Number.isFinite(done) && Number.isFinite(total) && total > 0 && done >= 0 && done <= total && total <= 1000) {
    const now = line(o.todo?.now, 160)
    out.todo = { done, total, ...(now ? { now } : {}) }
  }
  return out
}

export function publicBotTask(t: BotTask) {
  return {
    id: t.id,
    fromBotId: t.fromBotId,
    toBotId: t.toBotId,
    fromSessionId: t.fromSessionId,
    runSessionId: t.runSessionId,
    progress: t.progress,
    instruction: t.instruction,
    status: t.status,
    runKind: t.runKind,
    result: t.result,
    error: t.error,
    createdAt: t.createdAt,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    deliveredAt: t.deliveredAt,
  }
}

/**
 * 要敲这颗 Bot，该谁来领。本地 Bot 归桌面端那颗进程；远程的归它席位所在的机器——机器得配好、
 * 管家得够新。判不出来就回一句原因，调用方写进任务里，别让它排着队等一个永远不会来的人。
 */
export async function ownerFor(db: Db, account: Account, bot: CatalogItem): Promise<{ owner: string; seatId: string } | { error: string }> {
  if (runtimeKindOf(bot) === 'local') return { owner: `desktop:${account.id}`, seatId: 'desktop' }
  const rt = await db.seatRuntime(account.id, bot.id)
  if (!rt) return { error: `「${bot.name}」还没部署` }
  const machine = await db.machine(rt.machineId)
  if (!machinePaired(machine)) return { error: `「${bot.name}」所在的机器还没配好` }
  if ((machine.protocol ?? 0) < MIN_TASK_WORKER_PROTOCOL) {
    return { error: `「${bot.name}」所在机器的管家太旧（协议 ${machine.protocol ?? 0}，派活要 ≥ ${MIN_TASK_WORKER_PROTOCOL}），先升级管家` }
  }
  return { owner: machine.id, seatId: rt.seatId }
}

/**
 * 建一条。目标席位领得了就 queued；领不了（没部署、机器太旧）直接进 reporting，结论写明
 * 「没跑起来」，由主席位送回去——主 Bot 当场就能告诉用户，而不是等十分钟才发现没人领。
 */
export async function createBotTask(
  db: Db,
  account: Account,
  from: CatalogItem,
  to: CatalogItem,
  input: { instruction: string; context?: string | null; sessionId: string | null; callId: string | null; wait?: boolean },
): Promise<BotTask> {
  const base = {
    accountId: account.id,
    companyId: account.companyId!,
    fromBotId: from.id,
    toBotId: to.id,
    fromSessionId: input.sessionId,
    callId: input.callId,
    instruction: input.instruction,
    context: input.context || null,
    // 主 Bot 的席位在这一轮里等着（同步派活）：建的那一刻就挂上等待租约。
    waiterUntil: input.wait ? Date.now() + TASK_WAIT_LEASE_MS : null,
  }
  const target = await ownerFor(db, account, to)
  if ('owner' in target) return db.insertBotTask({ ...base, status: 'queued', owner: target.owner })
  // 有人在等：没跑起来的原因当场交给它，不必绕兜底送回那一圈。
  if (input.wait) {
    return db.insertBotTask({ ...base, status: 'answered', owner: null, result: `没跑起来：${target.error}`, error: target.error, runKind: 'failed' })
  }
  const back = await ownerFor(db, account, from)
  if ('owner' in back) {
    return db.insertBotTask({ ...base, status: 'reporting', owner: back.owner, result: `没跑起来：${target.error}`, error: target.error })
  }
  return db.insertBotTask({ ...base, status: 'failed', owner: null, result: `没跑起来：${target.error}`, error: `${target.error}；而且送不回主 Bot：${back.error}` })
}

/** 发进目标 Bot 的全文。要自足：对方看不见主 Bot 的对话。 */
export function instructionText(task: BotTask, fromName: string): string {
  const context = (task.context || '').trim()
  return (
    `【主 Bot「${fromName}」派来的任务】\n${task.instruction}\n\n` +
    (context ? `—— 前置任务交回的结论 ——\n${context}\n\n` : '') +
    '（做完把结果直接写在回复里，回复会原样交回主 Bot；需要人拍板的事写进结论，不要在这儿等。）'
  )
}

/** 发进主 Bot 的全文。自带原任务的一句摘要——结论落在新的一轮里，它要靠这句想起为什么派。 */
export function resultText(task: BotTask, toName: string): string {
  const brief = task.instruction.replace(/\s+/g, ' ').slice(0, 60) + (task.instruction.length > 60 ? '…' : '')
  const ok = task.runKind === 'completed' && !task.error
  // 对方那边被人停了（§1.3）：不是没做成，是人不要它做了。
  const stopped = task.runKind === 'aborted'
  const head = ok
    ? `【任务结果】@${toName} 做完了（任务：${brief}）`
    : stopped
      ? `【任务结果】@${toName} 那边停止了（任务：${brief}）`
      : `【任务结果】@${toName} 没做成（任务：${brief}）`
  return `${head}\n${(task.result || '').trim() || (ok ? '（对方没有写结论）' : task.error || '原因不明')}`
}

/** 交给工人的一条活。够它在本机把这一步做完，不多给。 */
export function jobOf(task: BotTask, phase: TaskPhase, seatId: string, names: { from: string; to: string }) {
  const botId = botOfPhase(task, phase)
  return {
    taskId: task.id,
    phase,
    botId,
    accountId: task.accountId,
    seatId,
    instruction: phase === 'run' ? instructionText(task, names.from) : resultText(task, names.to),
    /** 原样塞进席位 /messages 的 `task` 字段：界面按它画角标。 */
    task: {
      id: task.id,
      phase: phase === 'run' ? 'instruction' : 'result',
      from: phase === 'run' ? { id: task.fromBotId, name: names.from } : { id: task.toBotId, name: names.to },
    },
    leaseMs: TASK_LEASE_MS,
    timeoutMs: TASK_TIMEOUT_MS,
    /** 续租的节拍。续租的回复里带 `cancelled`，工人据此立刻停掉目标那一轮。 */
    cancelPollMs: TASK_CANCEL_POLL_MS,
  }
}

export type TaskJob = ReturnType<typeof jobOf>

/** 两头的名字，一次查齐。删掉的 Bot 用 id 顶上——话要说得通，不能空着。 */
async function namesOf(db: Db, task: BotTask): Promise<{ from: string; to: string }> {
  const [from, to] = await Promise.all([db.catalog(task.fromBotId), db.catalog(task.toBotId)])
  return { from: from?.name || task.fromBotId, to: to?.name || task.toBotId }
}

/**
 * 目标那一步收了场：把结论写上，交给主席位去送。送回去的那一方领不了（主 Bot 没部署了）就
 * failed——那时没有任何一轮能消化它。
 */
async function toReporting(db: Db, task: BotTask, input: { result: string; runKind: string; error?: string | null; sessionId?: string | null }): Promise<void> {
  const common0 = {
    result: input.result,
    runKind: input.runKind,
    error: input.error ?? null,
    endedAt: Date.now(),
    leaseUntil: null,
    ...(input.sessionId !== undefined ? { runSessionId: input.sessionId } : {}),
  }
  // 现读一次：等待租约、停止标记都是别的请求在写，手上这一行是领活时的快照。
  const fresh = (await db.botTask(task.id)) ?? task
  // 人按了停止：结论不再送回主 Bot（docs/bot-tasks.md §1.2）。
  if (fresh.cancelledAt) {
    await db.updateBotTask(task.id, { ...common0, status: 'cancelled', owner: null })
    return
  }
  // 主 Bot 的席位还在等：结论交给它，下一次轮询取走（§1.1）。
  if (waiting(fresh)) {
    await db.updateBotTask(task.id, { ...common0, status: 'answered', owner: null })
    return
  }
  const account = await db.account(task.accountId)
  const from = await db.catalog(task.fromBotId)
  const back = account && from ? await ownerFor(db, account, from) : { error: '主 Bot 已经不在了' }
  const common = {
    result: input.result,
    runKind: input.runKind,
    error: input.error ?? null,
    endedAt: Date.now(),
    ...(input.sessionId !== undefined ? { runSessionId: input.sessionId } : {}),
  }
  if ('owner' in back) {
    await db.updateBotTask(task.id, { ...common, status: 'reporting', owner: back.owner, leaseUntil: null, attempts: 0 })
  } else {
    await db.updateBotTask(task.id, { ...common, status: 'failed', owner: null, leaseUntil: null, error: `${input.error ? `${input.error}；` : ''}送不回主 Bot：${back.error}` })
  }
}

/** 这一步彻底没做成：run 进 reporting（告诉主 Bot），deliver 收成 failed。 */
async function stepLost(db: Db, task: BotTask, reason: string): Promise<void> {
  const phase = phaseOf(task)
  if (phase === 'run') {
    await toReporting(db, task, { result: `没做成：${reason}`, runKind: 'failed', error: reason })
  } else {
    await db.updateBotTask(task.id, { status: 'failed', owner: null, leaseUntil: null, error: `结论送不回主 Bot：${reason}`, deliveredAt: null })
  }
}

/**
 * 领活。`seatIdOf` 回这一步要敲的那颗 Bot 在领活方手里的席位 id；回 null 就是「这颗不在我这儿」
 * （席位刚被挪走、或本地 Bot 没在跑），当场按没做成处理，别让它占着租约。
 */
export async function leaseDueTasks(db: Db, owner: string, seatIdOf: (task: BotTask, botId: string) => Promise<string | null>, botId?: string) {
  const jobs: TaskJob[] = []
  for (const task of await db.claimBotTasks(owner, Date.now() + TASK_LEASE_MS, 20, botId)) {
    const phase = phaseOf(task)
    if (!phase) continue
    const seatId = await seatIdOf(task, botOfPhase(task, phase))
    if (!seatId) {
      await stepLost(db, task, phase === 'run' ? '目标 Bot 的席位不在这台机器上了' : '主 Bot 的席位不在这台机器上了')
      continue
    }
    jobs.push(jobOf(task, phase, seatId, await namesOf(db, task)))
  }
  return { jobs, leaseMs: TASK_LEASE_MS }
}

/**
 * 工人拿到了会话 id，问一句「能跑吗」。只有 run 那一步看转人工：目标 Bot 的会话上有一张挡路的
 * 交接单就不发——发了也是排在人后面没人理。挡住的直接当没做成送回主 Bot，工人收到 blocked 就停手。
 */
export async function taskStarted(db: Db, task: BotTask, owner: string, sessionId: string): Promise<{ blocked: string | null; cancelled?: boolean }> {
  const phase = phaseOf(task)
  // 领走之后、开跑之前人就按了停止：指令一个字都别发进去。
  if (phase === 'run' && task.cancelledAt) {
    await db.updateBotTask(task.id, { status: 'cancelled', owner: null, leaseUntil: null, endedAt: Date.now(), runSessionId: sessionId })
    return { blocked: '主 Bot 那边停止了', cancelled: true }
  }
  if (phase === 'run') {
    const blocking = (await db.handoffsOfSession(sessionId)).find((h) => h.blocking && (h.state === 'open' || h.state === 'claimed'))
    if (blocking) {
      const ask = blocking.ask.slice(0, 60) || '没写要做什么'
      await toReporting(db, task, { result: `没做成：它那边还有一件转人工的事等着人处理（${ask}）`, runKind: 'failed', error: `转人工挡着：${ask}`, sessionId })
      return { blocked: ask }
    }
    await db.updateBotTask(task.id, { runSessionId: sessionId })
  }
  await db.renewBotTask(task.id, owner, Date.now() + TASK_LEASE_MS)
  return { blocked: null }
}

/**
 * 收场。run：`kind` 是目标那一轮怎么结束的（和日常任务同一套词），`result` 是回复正文；
 * deliver：发进去了就 done，没发进去放回去再送，三次不成才 failed。
 */
export async function taskFinish(db: Db, task: BotTask, body: { kind: string; result?: string; error?: string; sessionId?: string | null }): Promise<void> {
  const phase = phaseOf(task)
  if (phase === 'run') {
    const sessionId = body.sessionId === undefined ? undefined : body.sessionId || null
    if (body.kind === 'completed') {
      await toReporting(db, task, { result: (body.result || '').trim(), runKind: 'completed', sessionId })
    } else if (body.kind === 'timeout') {
      await toReporting(db, task, { result: '没做成：等结果超时，结果不明（它那一轮可能还在跑，去它的对话里看）', runKind: 'timeout', error: '等结果超时', sessionId })
    } else if (body.kind === 'failed') {
      const why = (body.error || '没跑起来').slice(0, 300)
      await toReporting(db, task, { result: `没做成：${why}`, runKind: 'failed', error: why, sessionId })
    } else if (body.kind === 'aborted') {
      /**
       * 那一轮被中止了。主 Bot 那边按的停止在 toReporting 里认（cancelledAt），走到那儿记成 cancelled；
       * 剩下的就是**有人在目标 Bot 的对话里按了停止**（docs/bot-tasks.md §1.3）。那是人明说不要它做了，
       * 不是没做成：话要说成「已停止、作废」，主 Bot 才不会把它当失败去重派或自己接着做。
       */
      const why = '有人在它的对话里把这一轮停了'
      await toReporting(db, task, { result: `已停止：${why}，这件活作废（别重派、别自己接着做；要不要重新做问人）。`, runKind: 'aborted', error: why, sessionId })
    } else {
      /**
       * 出错的那一轮，席位会在对话里补一句「模型调用失败：…」/「出错了：…」，领活的一方当结论原样送上来。
       * 把它带上：光说「出错了」，主 Bot 和人都分不清是网络断了一下（再派一次就好）还是每次都会撞的错。
       * 只认这两种开头——进程死在半路时补的 turn/end 前面没有这句，最后一条可能是一段正常的话。
       */
      const said = (body.result || '').trim()
      const cause = /^(模型调用失败|出错了)[：:]/.test(said) ? said.split('\n')[0].slice(0, 300) : ''
      const why =
        body.kind === 'error'
          ? cause
            ? `它那一轮出错了（${cause}）`
            : '它那一轮出错了，经过在它的对话里'
          : `它那一轮以 ${body.kind} 结束`
      await toReporting(db, task, { result: `没做成：${why}`, runKind: body.kind, error: why, sessionId })
    }
    return
  }
  if (phase === 'deliver') {
    if (body.kind === 'completed' || body.kind === 'delivered') {
      await db.updateBotTask(task.id, { status: 'done', leaseUntil: null, deliveredAt: Date.now() })
    } else if (task.attempts < MAX_ATTEMPTS) {
      await db.updateBotTask(task.id, { status: 'reporting', leaseUntil: null, error: (body.error || body.kind).slice(0, 300) })
    } else {
      await stepLost(db, task, (body.error || body.kind).slice(0, 300))
    }
  }
}

/**
 * 等的一方来问（GET /runtime/tasks/:id）：续等待租约；已经答了的当场记成 done 交出结论。
 */
export async function pollBotTask(db: Db, task: BotTask): Promise<BotTask> {
  const now = Date.now()
  if (task.status === 'answered') return (await db.takeAnsweredBotTask(task.id, now)) ?? ((await db.botTask(task.id)) as BotTask)
  if ((task.status === 'queued' || task.status === 'running') && !task.cancelledAt) {
    await db.updateBotTask(task.id, { waiterUntil: now + TASK_WAIT_LEASE_MS })
    return { ...task, waiterUntil: now + TASK_WAIT_LEASE_MS }
  }
  return task
}

/**
 * 人按了停止（POST /runtime/tasks/:id/cancel）。还没被领走的直接作废；已经在对方那边跑的
 * 停不下来，记下时刻，交回结论时不再送回；已经答了还没取的也作废。
 */
export async function cancelBotTask(db: Db, task: BotTask): Promise<BotTask> {
  const now = Date.now()
  if (task.status === 'queued' && task.leaseUntil == null) {
    await db.updateBotTask(task.id, { status: 'cancelled', cancelledAt: now, waiterUntil: null, owner: null, endedAt: now, error: '主 Bot 那边停止了' })
  } else if (task.status === 'answered') {
    await db.updateBotTask(task.id, { status: 'cancelled', cancelledAt: now, waiterUntil: null })
  } else if (task.status === 'queued' || task.status === 'running') {
    await db.updateBotTask(task.id, { cancelledAt: now, waiterUntil: null })
  }
  return (await db.botTask(task.id)) as BotTask
}

/**
 * 清扫：领走了没回报的放回去再领（三次为限），排着队一直没人来领的按没做成处理。
 * 挂在维护节拍上（routines.ts 的 MAINTENANCE_STEPS）。
 */
export async function sweepBotTasks(db: Db): Promise<void> {
  const now = Date.now()
  for (const task of await db.expiredBotTasks(now)) {
    const phase = phaseOf(task)
    if (!phase) continue
    // 人已经按了停止：领走它的那一方没回报，就别再放回去让人领了。
    if (task.cancelledAt && phase === 'run') {
      await db.updateBotTask(task.id, { status: 'cancelled', owner: null, leaseUntil: null, endedAt: now })
      continue
    }
    if (task.attempts < MAX_ATTEMPTS) {
      await db.updateBotTask(task.id, { status: phase === 'run' ? 'queued' : 'reporting', leaseUntil: null })
    } else {
      await stepLost(db, task, '机器没回报（工人的租约到期了：机器离线、工人没起来、或者中途被杀）')
    }
  }
  // 已经答了、等的一方却没来取：它多半被重启了，结论走兜底送回，不能丢。
  for (const task of await db.orphanedAnsweredBotTasks(now)) {
    const account = await db.account(task.accountId)
    const from = await db.catalog(task.fromBotId)
    const back = account && from ? await ownerFor(db, account, from) : { error: '主 Bot 已经不在了' }
    if ('owner' in back) await db.updateBotTask(task.id, { status: 'reporting', owner: back.owner, leaseUntil: null, attempts: 0, waiterUntil: null })
    else await db.updateBotTask(task.id, { status: 'failed', owner: null, waiterUntil: null, error: `${task.error ? `${task.error}；` : ''}送不回主 Bot：${back.error}` })
  }
  for (const task of await db.unclaimedBotTasksBefore(now - TASK_PICKUP_MS)) {
    await stepLost(db, task, phaseOf(task) === 'run' ? '一直没人来领：目标 Bot 的席位没在跑' : '一直没人来领：主 Bot 的席位没在跑')
  }
}
