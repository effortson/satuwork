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
 *      全在 routines.ts——工人只负责「发消息、等 turn/end」那一段，怎么解释结果仍由这里说了算。
 *      试跑也走这条路：Gateway 登记一条等人领的流水（requestManualRun），工人下一趟 due 时带走。
 *
 * 工人那一侧的循环：GET due → 对每条：问席位会话 id → POST started（Gateway 查有没有转人工
 * 挡着）→ 挂流、发消息、等自己那一轮的 turn/end，期间 POST renew → POST finish。
 */
import type { RouteCtx } from './ctx.ts'
import { HttpError, json, type Req, type Router } from '../http.ts'
import { bodyOf, strField } from '../lib/validate.ts'
import { requireMachine, requireSeatOnly } from '../lib/guards.ts'
import { claimDue, RUN_TIMEOUT_MS, settleRun, turnFailure } from '../routines.ts'
import type { ChannelEvent, ChargeStatus, Machine, Routine, RoutineRun } from '../db.ts'
import { accountByApiKey, fillSweptCharge, gateOr402, recordLlmCall, recordUsageOnly, settle } from '../lib/llm-billing.ts'
import type { TokenUsage } from '../lib/llm-usage.ts'
import { randomUUID } from 'node:crypto'
import {
  CHANNEL_WORKER_TUNING, approvalMarkdown, channelFiles, channelHandoffs, deliverClaimedEvent, failClaimedEvent,
  telegramDraftId, type ChannelApprovalSnapshot, type StoredSecret,
} from '../channels.ts'
import { decryptChannelSecret } from '../crypto.ts'
import { MIN_CHANNEL_WORKER_PROTOCOL } from '../deploy.ts'
import { TelegramError, telegramSendApproval, telegramSendDraft, telegramSendTyping } from '../channels/telegram.ts'

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

/**
 * 领活、started、renew、finish 四步的**身体**，和「谁在领」无关。两套门各自套一层：
 *
 *   /worker/routines/*          机器凭 smt_，machineId = 机器 id，只看本机席位上的任务
 *   /runtime/local-routines/*   桌面端里的本地 Bot 凭 sat_，machineId = `desktop:<accountId>`，
 *                               只看这个账号本地 Bot 的任务
 *
 * 流水上的 machineId 就是这一次归谁的判据：续租、回报都按它认，别人的一律 404。
 */
interface RoutineOwner {
  machineId: string
  due(now: number, limit: number): Promise<Routine[]>
  retries(now: number, limit: number): Promise<Routine[]>
  /** 这条任务的席位 id；本地 Bot 没有席位，给个固定值让工人知道是本机。 */
  seatIdOf(routine: Routine): Promise<string | null>
}

async function leaseDue(db: RouteCtx['db'], owner: RoutineOwner) {
  const now = Date.now()
  const jobs: ReturnType<typeof jobOf>[] = []
  await claimDue(
    db,
    now,
    { due: owner.due, retries: owner.retries },
    async (routine, trigger) => {
      const seatId = await owner.seatIdOf(routine)
      if (!seatId) return
      const run = await db.insertRoutineRun({
        routineId: routine.id,
        botId: routine.botId,
        accountId: routine.accountId,
        companyId: routine.companyId,
        trigger,
        machineId: owner.machineId,
        leaseUntil: now + ROUTINE_LEASE_MS,
      })
      jobs.push(jobOf(routine, run, seatId))
    },
  )
  /**
   * 登记给这一方、还没人领的试跑（routines.ts 的 requestManualRun）：流水已经在了，租约空着。
   * 填上租约就算领走，和到点的一起交出去。任务在登记之后被删了的话流水没人要，直接收场。
   */
  for (const run of await db.pickUpRoutineRuns(owner.machineId, now + ROUTINE_LEASE_MS)) {
    const routine = await db.routine(run.routineId)
    const seatId = routine ? await owner.seatIdOf(routine) : null
    if (!routine || !seatId) {
      await settleRun(db, run.routineId, run.id, run.trigger, { status: 'error', error: routine ? '这颗 Bot 已经不在这台机器上了' : '这条任务已经删了' })
      continue
    }
    jobs.push(jobOf(routine, run, seatId))
  }
  return { jobs, leaseMs: ROUTINE_LEASE_MS }
}

/** 找到这位领走、还在跑的那一条；不是就 404，不区分「别人的」和「没了」。 */
async function claimedRun(db: RouteCtx['db'], runId: string, machineId: string): Promise<RoutineRun> {
  const run = await db.routineRunOfMachine(runId, machineId)
  if (!run) throw new HttpError(404, '这一次不归你，或者已经收场了')
  return run
}

/**
 * 工人拿到了会话 id，问一句「能跑吗」。这条会话上有一张**挡着路**的交接单还没闭合就不跑
 * （理由见 runRoutine 那段），判据取自 Gateway 这张表——工人没有库，只能问。挡住的话这里
 * 直接把流水收成 error，工人收到 `blocked` 就停手，不用再回一次 finish。
 */
async function routineStarted(db: RouteCtx['db'], run: RoutineRun, machineId: string, sessionId: string) {
  const blocking = (await db.handoffsOfSession(sessionId)).find((h) => h.blocking && (h.state === 'open' || h.state === 'claimed'))
  if (blocking) {
    await settleRun(db, run.routineId, run.id, run.trigger, {
      status: 'error',
      error: `这一次没跑：还有一件转人工的事等着人处理（${blocking.ask.slice(0, 60) || '没写要做什么'}）`,
      sessionId,
    })
    return { blocked: blocking.ask.slice(0, 60) || '没写要做什么' }
  }
  await db.finishRoutineRun(run.id, { status: 'running', sessionId })
  await db.renewRoutineRun(run.id, machineId, Date.now() + ROUTINE_LEASE_MS)
  return { blocked: null }
}

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
async function routineFinish(db: RouteCtx['db'], run: RoutineRun, body: Record<string, unknown>) {
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
    await settleRun(db, run.routineId, run.id, run.trigger, { status: 'error', error: turnFailure(kind), sessionId }, kind !== 'aborted')
  }
}

export function attachWorker(router: Router, ctx: RouteCtx) {
  const { db, keys, channelKey } = ctx
  attachChannelWorker(router, db, keys, channelKey)
  attachLlmRelay(router, ctx)

  // ── 席位机器上的工人（smt_）──
  const machineOwner = (machineId: string): RoutineOwner => ({
    machineId,
    due: (n, limit) => db.dueRoutinesForMachine(machineId, n, limit),
    retries: (n, limit) => db.dueRoutineRetriesForMachine(machineId, n, limit),
    seatIdOf: async (routine) => (await db.seatRuntime(routine.accountId, routine.botId))?.seatId ?? null,
  })
  router.get('/worker/routines/due', async (req, res) => {
    const machine = await requireMachine(req, db)
    json(res, 200, await leaseDue(db, machineOwner(machine.id)))
  })
  router.post('/worker/routines/:runId/started', async (req, res) => {
    const machine = await requireMachine(req, db)
    const run = await claimedRun(db, req.params.runId, machine.id)
    json(res, 200, await routineStarted(db, run, machine.id, strField(bodyOf(req), 'sessionId', true)))
  })
  router.post('/worker/routines/:runId/renew', async (req, res) => {
    const machine = await requireMachine(req, db)
    if (!(await db.renewRoutineRun(req.params.runId, machine.id, Date.now() + ROUTINE_LEASE_MS))) {
      throw new HttpError(404, '这一次不归这台机器，或者已经收场了')
    }
    json(res, 200, { leaseMs: ROUTINE_LEASE_MS })
  })
  router.post('/worker/routines/:runId/finish', async (req, res) => {
    const machine = await requireMachine(req, db)
    const run = await claimedRun(db, req.params.runId, machine.id)
    await routineFinish(db, run, bodyOf(req))
    json(res, 200, { ok: true })
  })

  // ── 桌面端里的本地 Bot（sat_）──
  //
  // 本地 Bot 跑在员工电脑上，Gateway 连不到它，dueRoutines 把它的任务排除在外；由它自己的进程
  // 来领（bot/src/local-routines）。同一个账号所有本地 Bot 共用一个「机器」名：desktop:<accountId>。
  // 席位票只能领**自己账号**的任务：due 源按 accountId 过滤，续租和回报按 machineId 认。
  const localOwner = (accountId: string): RoutineOwner => ({
    machineId: `desktop:${accountId}`,
    due: (n, limit) => db.dueRoutinesForLocalAccount(accountId, n, limit),
    retries: (n, limit) => db.dueRoutineRetriesForLocalAccount(accountId, n, limit),
    seatIdOf: async () => 'desktop',
  })
  router.get('/runtime/local-routines/due', async (req, res) => {
    const account = await requireSeatOnly(req, db)
    json(res, 200, await leaseDue(db, localOwner(account.id)))
  })
  router.post('/runtime/local-routines/:runId/started', async (req, res) => {
    const account = await requireSeatOnly(req, db)
    const owner = localOwner(account.id)
    const run = await claimedRun(db, req.params.runId, owner.machineId)
    json(res, 200, await routineStarted(db, run, owner.machineId, strField(bodyOf(req), 'sessionId', true)))
  })
  router.post('/runtime/local-routines/:runId/renew', async (req, res) => {
    const account = await requireSeatOnly(req, db)
    if (!(await db.renewRoutineRun(req.params.runId, `desktop:${account.id}`, Date.now() + ROUTINE_LEASE_MS))) {
      throw new HttpError(404, '这一次不归你，或者已经收场了')
    }
    json(res, 200, { leaseMs: ROUTINE_LEASE_MS })
  })
  router.post('/runtime/local-routines/:runId/finish', async (req, res) => {
    const account = await requireSeatOnly(req, db)
    const run = await claimedRun(db, req.params.runId, `desktop:${account.id}`)
    await routineFinish(db, run, bodyOf(req))
    json(res, 200, { ok: true })
  })
}

// ── 渠道那一轮（见 manager/src/worker/channels.ts 文件头：跟席位说话在工人，跟 Telegram 说话在这儿）──

/**
 * 三条接口，一条领、一条报进度、一条收场。租约用的是 channel_events 现成的 leaseToken：领的
 * 时候 Gateway 生成、随活交给工人，之后每次回报都带着，`updateClaimedChannelEvent` 那套
 * fencing 原样生效——工人死过、租约被别人接走之后，旧工人的回报一律 404。
 */
function attachChannelWorker(router: Router, db: RouteCtx['db'], keys: RouteCtx['keys'], channelKey: Buffer) {
  /** 本机领走、还在处理、且租约对得上的那条事件。三样缺一样 404，不区分。 */
  async function claimed(req: Req, machineId: string): Promise<{ event: ChannelEvent; binding: NonNullable<Awaited<ReturnType<typeof db.channelBinding>>> }> {
    const lease = strField(bodyOf(req), 'lease', true)
    const event = await db.channelEvent(req.params.eventId)
    if (!event || event.status !== 'processing' || event.leaseToken !== lease) throw new HttpError(404, '这条事件不归这台机器，或者已经收场了')
    const binding = await db.channelBinding(event.bindingId)
    if (!binding) throw new HttpError(404, '这条事件不归这台机器，或者已经收场了')
    const rt = await db.seatRuntime(binding.accountId, binding.botId)
    if (rt?.machineId !== machineId) throw new HttpError(404, '这条事件不归这台机器，或者已经收场了')
    return { event, binding }
  }

  router.get('/worker/channels/events/due', async (req, res) => {
    const machine = await requireMachine(req, db)
    const now = Date.now()
    const jobs: unknown[] = []
    /**
     * 只取**这台机器上、还要跑一轮**的（已经有回复、只差投递的归 Gateway 自己，几次短请求）。
     * 筛在 SQL 里：以前取的是全平台最老的 20 条再按机器挑，别的机器堆着的活会一直占着那
     * 20 个名额，这台机器就再也领不到自己的（见 db.dueChannelEvents）。
     */
    for (const event of await db.dueChannelEvents(now, 20, { owner: 'worker', machineId: machine.id, minProtocol: MIN_CHANNEL_WORKER_PROTOCOL })) {
      const binding = await db.channelBinding(event.bindingId)
      if (!binding || binding.status !== 'active') continue
      const rt = await db.seatRuntime(binding.accountId, binding.botId)
      if (rt?.machineId !== machine.id) continue
      const lease = randomUUID()
      if (!(await db.claimChannelEvent(event.id, now, now + CHANNEL_WORKER_TUNING.leaseMs, lease))) continue
      jobs.push({
        eventId: event.id,
        bindingId: binding.id,
        botId: binding.botId,
        seatId: rt.seatId,
        lease,
        externalEventId: event.externalEventId,
        conversationId: event.externalConversationId,
        title: event.title,
        text: event.text,
        ...CHANNEL_WORKER_TUNING,
      })
    }
    json(res, 200, { jobs })
  })

  /**
   * 进度：续租，顺带替工人跟 Telegram 说一句。
   *   renew     只续租
   *   typing    sendChatAction typing（失败不算错，只是没有那个小动画）
   *   draft     一帧临时草稿。Telegram 的 429 / retry_after 和不可重试的 4xx 原样回给工人的草稿泵
   *   approval  一张审批卡。按 approvalKey 去重（工人重启、接管都可能再报一次）
   */
  router.post('/worker/channels/events/:eventId/progress', async (req, res) => {
    const machine = await requireMachine(req, db)
    const { event, binding } = await claimed(req, machine.id)
    if (!(await db.renewChannelEventLease(event.id, event.leaseToken, Date.now() + CHANNEL_WORKER_TUNING.leaseMs))) {
      throw new HttpError(404, '这条事件不归这台机器，或者已经收场了')
    }
    const body = bodyOf(req)
    const kind = strField(body, 'kind', true)
    const secret = decryptChannelSecret<StoredSecret>(channelKey, binding.credentialCiphertext)
    if (kind === 'typing') {
      await telegramSendTyping(secret.token, event.externalConversationId).catch(() => undefined)
    } else if (kind === 'draft') {
      const text = strField(body, 'text', true)
      try {
        await telegramSendDraft(secret.token, event.externalConversationId, telegramDraftId(event.externalEventId), text)
      } catch (e) {
        const tg = e instanceof TelegramError ? e : null
        json(res, 200, { retryAfterMs: tg?.retryAfterMs || 0, stop: Boolean(tg && tg.status >= 400 && tg.status < 500 && tg.status !== 429) })
        return
      }
    } else if (kind === 'approval') {
      const approval = (body.approval ?? null) as ChannelApprovalSnapshot | null
      if (!approval || typeof approval.key !== 'string' || !approval.key) throw new HttpError(400, 'approval 缺 key')
      const latest = await db.channelEvent(event.id)
      if (!(latest?.approvalKey === approval.key && latest.approvalMessageId != null)) {
        const messageId = await telegramSendApproval(secret.token, event.externalConversationId, approvalMarkdown(approval), approval.key)
        if (!(await db.recordChannelApprovalPrompt(event.id, event.leaseToken, approval.key, messageId))) {
          throw new HttpError(404, '渠道事件租约已经转交')
        }
      }
    } else if (kind !== 'renew') {
      throw new HttpError(400, '不认识的进度')
    }
    json(res, 200, { ok: true })
  })

  /**
   * 收场。带 reply 就是跑完了：Gateway 投递（回复、产出文件预览、转人工卡）并收成 delivered；
   * 带 error 就是砸了：按老规矩排重试或记 dead。投递失败也走同一条 fail 路。
   */
  router.post('/worker/channels/events/:eventId/finish', async (req, res) => {
    const machine = await requireMachine(req, db)
    const { event, binding } = await claimed(req, machine.id)
    const body = bodyOf(req)
    if (body.error != null) {
      await failClaimedEvent(db, event, binding, event.leaseToken, new Error(strField(body, 'error', false) || '工人没说原因'), {
        sessionId: event.sessionId,
        reply: event.reply,
      })
      json(res, 200, { ok: true })
      return
    }
    const result = {
      sessionId: strField(body, 'sessionId', true),
      reply: body.reply == null ? '' : strField(body, 'reply', false),
      files: channelFiles(body.files),
      handoffs: channelHandoffs(body.handoffs),
    }
    try {
      await deliverClaimedEvent(db, channelKey, keys, event, binding, event.leaseToken, result)
    } catch (e) {
      await failClaimedEvent(db, event, binding, event.leaseToken, e, { sessionId: result.sessionId, reply: result.reply })
    }
    json(res, 200, { ok: true })
  })
}

// ── 模型调用的中继（管家在席位机器上直接打上游；Gateway 只授权和结算）──

const GRANT_ROUTES = new Set(['chat', 'messages', 'responses'])
const SETTLE_STATUSES = new Set<ChargeStatus>(['ok', 'failed', 'error', 'timeout'])

/** 这台机器上有没有这个账号的席位。授权和结算都按它认：别的机器的账号一律 403。 */
async function seatOnMachine(db: RouteCtx['db'], machine: Machine, accountId: string): Promise<boolean> {
  return (await db.seatRuntimesOfMachine(machine.id)).some((r) => r.accountId === accountId)
}

/**
 * 两条接口，一条**授权**、一条**结算**。管家每次调模型都先来要授权，拿到上游地址和
 * 鉴权头（含供应商密钥，只在那一次调用期间留在内存里），自己打上游、把流给 bot，完了
 * 报用量。Gateway 留下的是规矩本身：API Key 认谁、模型怎么解析、密钥归谁、余额够不够、
 * 这一次记在哪一行、收多少钱——全和 /v1 同一份代码（lib/llm-billing.ts）。
 *
 * **错误的状态码和文案要和 /v1 一样。** 管家把这里的非 2xx 原样回给 bot，bot 再原样变成
 * 一条失败消息给用户看；两边不一致的话，同一个账号在旧席位（走 /v1）和新席位上看到的
 * 是两种说法。
 *
 * 结算是幂等的，**但幂等只管「不收第二笔钱」，不等于「第二次什么都不做」**——回的是三种：
 *
 *   { settled: true }                     头一次结算，落一行账
 *   { settled: true, reason: 'filled' }   清扫先按 0 元收了口，这一次把那行占位补成真的
 *                                         （docs/billing.md §2 唯一的例外）
 *   { settled: false, reason: 'already' } 上一次已经真结过了，只把 token 补正，账本不动
 *
 * 管家不看这三种的区别（结不结得成都照常继续），但 e2e 钉着它们：少了中间那一种，
 * 跑过 LLM_SETTLE_GRACE_MS 的长回答就会永远记成 0 元，而且事后补不回来。
 *
 * ── 授权的收发形状（管家和 e2e 都钉着它，改之前先改那两边）──
 *
 *   请求  { apiKey, route: 'chat'|'messages'|'responses', model,
 *           provider?, anthropicVersion?, openaiBeta?,
 *           stream?: boolean,          // 请求体里的 `stream`
 *           reasoningEffort?: string } // chat 的 `reasoning_effort` / responses 的 `reasoning.effort`
 *   200   { callId, provider, model, url, headers,
 *           body: { set: Record<string, unknown>, unset: string[] } }
 *         `body` **一定在**，且 `set.model` / `unset` 里的 `provider` 一定在。管家照
 *         「先删 unset、再 Object.assign(body, set)」的顺序改自己手里那份请求体，不再
 *         自己动手改 model / provider。`headers` 整份都当密文：里面有供应商密钥，也可能
 *         有运营在自定义供应商定义里写的私货，一个字都不该落日志。这份 headers **保证
 *         不含 content-type / content-length / transfer-encoding / host**（见 llm.ts 的
 *         BODY_FRAMING_HEADERS），管家可以放心地 `{ ...headers, 'content-type': … }`——
 *         少了这条保证，运营写一句大写的 `Content-Type` 就能让 fetch 把两份折成一个逗号
 *         连起来的值，上游当场 400。
 *   409   { error, relayable: false }
 *         **不是错，是「这条中继走不了，退回 /v1」**：模型走的不是 OpenAI 兼容协议
 *         （一批 `api: 'anthropic-messages'` 但 provider 不叫 anthropic 的：minimax、
 *         kimi-coding、fireworks、github-copilot、vercel-ai-gateway、opencode、
 *         cloudflare-ai-gateway…），或者没有 HTTP 上游地址（bedrock / vertex）。这些在
 *         /v1 上一直是好的（底下的 pi-ai 按 `api` 分发），所以管家看见 `relayable: false`
 *         就把整通调用改打 Gateway 的 /v1（chat → /v1/chat/completions、messages →
 *         /v1/messages、responses → /v1/responses），带 Bot 自己的 sk_sw_，**不结算**
 *         ——那条路 Gateway 自己记账。这里也因此**不登记 llm_calls**。
 *         没有别的接口用 409，管家可以只认状态码，但 `relayable: false` 这一格是权威。
 *   4xx   其余照旧（401/402/403/404/400），文案和 /v1 一样，管家原样转给 bot。
 */
function attachLlmRelay(router: Router, { db, llm, meter }: RouteCtx) {
  router.post('/worker/llm/grant', async (req, res) => {
    const machine = await requireMachine(req, db)
    const body = bodyOf(req)
    const route = strField(body, 'route')
    if (!GRANT_ROUTES.has(route)) throw new HttpError(400, 'route 只能是 chat / messages / responses')
    const account = await accountByApiKey(db, strField(body, 'apiKey'))
    // 只能替本机席位上的账号要授权。smt_ 泄一把，能拿到的密钥也只是这台机器上那几家的。
    if (!(await seatOnMachine(db, machine, account.id))) throw new HttpError(403, '这个账号的席位不在这台机器上')
    const modelRaw = strField(body, 'model')
    const provider = body.provider == null ? '' : strField(body, 'provider', false)
    // 和 /v1 的两条透传路由一样：没给 provider 时按路由的原生厂商猜。
    const hint = provider || (route === 'messages' ? 'anthropic' : route === 'responses' ? 'openai' : undefined)
    const found = await llm.find(account.companyId, modelRaw, hint)
    if (!found) throw new HttpError(404, '模型不在可见目录里', { model: modelRaw })
    const secret = await llm.secret(account.companyId, found.provider)
    if (!secret) throw new HttpError(402, `没有 ${found.provider} 的密钥`, { provider: found.provider })
    await gateOr402(meter, account, found)
    const target = llm.upstreamTargetOf(found, route as 'chat' | 'messages' | 'responses', secret, {
      anthropicVersion: body.anthropicVersion == null ? undefined : strField(body, 'anthropicVersion', false) || undefined,
      openaiBeta: body.openaiBeta == null ? undefined : strField(body, 'openaiBeta', false) || undefined,
      stream: body.stream === true,
      reasoningEffort: body.reasoningEffort == null ? undefined : strField(body, 'reasoningEffort', false) || undefined,
    })
    // 目标算不出来就不登记调用：没打上游，没有账可记。两种拒法分开，见文件头那段——
    // `relayable: false` 是「退回 /v1」的暗号，回 400 的话管家会把它当错转给 bot。
    if ('error' in target) throw new HttpError(target.relayable ? 400 : 409, target.error, target.relayable ? {} : { relayable: false })
    const callId = await recordLlmCall(db, account, found, machine.id)
    json(res, 200, {
      callId,
      provider: found.provider,
      model: target.model,
      url: target.url,
      headers: target.headers,
      body: target.body,
    })
  })

  router.post('/worker/llm/:callId/settle', async (req, res) => {
    const machine = await requireMachine(req, db)
    const call = await db.llmCall(req.params.callId)
    if (!call) throw new HttpError(404, '没有这一次调用')
    if (!(await seatOnMachine(db, machine, call.accountId))) throw new HttpError(403, '这个账号的席位不在这台机器上')
    const body = bodyOf(req)
    const status = body.status == null ? undefined : strField(body, 'status', false)
    if (status !== undefined && !SETTLE_STATUSES.has(status as ChargeStatus)) throw new HttpError(400, 'status 只能是 ok / failed / error / timeout')
    const usage = usageOf(body.usage)
    /**
     * 这一次按什么价收。**只从目录里取 `cost`，provider / model 用这次调用自己的那一份**
     * ——理由和清扫那边一字不差，见 routines.ts 的 sweepUnsettledLlmCalls：`llm.find` 的
     * 裸 id 回落可能命中另一家供应商的同名模型，拿它的名字落账会让账本 subject 和
     * `llm_calls` 分家，统计屏那个 join 就取不到钱了。目录里已经没有这个模型了（平台
     * 下架、公司条目删了）也走这条：账照记，只是没有单价，settle 记成 unpriced。
     */
    const pricedOf = async () => ({
      provider: call.provider,
      id: call.model,
      cost: (await llm.find(call.companyId, `${call.provider}/${call.model}`))?.cost,
    })
    if (await db.chargeExistsForRef(call.id)) {
      /**
       * 已经有账了。**钱仍然不重记**——一次调用只该有一个金额，重算等于给同一行挂两个数。
       * 但「已经有账」在中继这条路上有两种来路，结局不该一样：
       *
       * 一、**清扫写的占位行。** 一次跑过 LLM_SETTLE_GRACE_MS 的长回答会先被收成
       *     `failed` / 0 元 / unpriced，管家随后才带着真实用量回来。那一行**从来没有
       *     成交过**，钉着它不放的结果是：这通调用真金白银发生过，账上永远是 0，而且
       *     补不回来（用量只在管家这一次回调里）。所以把它补成真的——docs/billing.md §2
       *     唯一的例外，判据严到只认清扫写出来的那个形状，见 db.fillPlaceholderCharge。
       *
       * 二、**上一次已经真结过了**（管家自己重试、或者两边撞在一起）。这种一行都不动，
       *     只把 token 补正：不补的话 llm_calls 永远停在 0/0，那一行读起来像「这次调用
       *     什么都没发生」，而它明明发生过、还很贵。
       */
      if (usage) {
        /**
         * 账号和目录只在**真要补录**的时候才查。放到分支外面去查过一版，代价是：账号被
         * 硬删掉之后（删公司 / 删员工都会 `delete from accounts`，而 `llm_calls` 上没有
         * 外键、调用行不跟着走），管家重试上报会从 `200 already` 变成 `404 账号不存在`
         * ——一个本来幂等成功的空操作变成了错误。补不了就补不了，账本原样不动，这条路
         * 仍旧回 already。
         */
        const account = await db.account(call.accountId)
        if (account && (await fillSweptCharge(db, meter, account, await pricedOf(), call.id, usage, status as ChargeStatus | undefined))) {
          json(res, 200, { settled: true, reason: 'filled' })
          return
        }
        await recordUsageOnly(db, call.id, usage)
      }
      json(res, 200, { settled: false, reason: 'already' })
      return
    }
    const account = await db.account(call.accountId)
    if (!account) throw new HttpError(404, '账号不存在')
    await settle(db, meter, account, await pricedOf(), call.id, usage, status as ChargeStatus | undefined)
    json(res, 200, { settled: true })
  })
}

/**
 * 结算报上来的 usage：管家那头已经按 TokenUsage 的四项折好了（manager/src/llm-usage.ts 是
 * Gateway 这份的逐字副本，逐帧累计的规矩一样）。形状不对、四项都没有就当没报，settle
 * 记 unpriced；负数和小数不认。
 */
function usageOf(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.prompt_tokens !== 'number' && typeof o.completion_tokens !== 'number') return undefined
  const n = (k: string) => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? Math.max(0, Math.trunc(o[k] as number)) : 0)
  return {
    prompt_tokens: n('prompt_tokens'),
    completion_tokens: n('completion_tokens'),
    cached_tokens: n('cached_tokens'),
    cache_write_tokens: n('cache_write_tokens'),
  }
}
