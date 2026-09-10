/**
 * 日常任务的六条路由：列、建、看、改、删、试跑。
 *
 * 归属只有一句话：**routine 属于建它的那个人在那颗 Bot 上**。所以每条路由都先按
 * accountId 认一次，不属于自己的一律当成没有（404，不是 403——「有这东西但轮不到你」
 * 本身就是一句多余的话）。
 *
 * 查看、新建、修改、试跑同时认登录 JWT 和席位票：前者是人在右栏操作，后者是当前 Bot
 * 的内置工具操作。删除仍然只认登录 JWT——Agent 没有删除工具，也不该因为共用路由顺带
 * 拿到一把会级联清掉运行流水的能力。
 * 席位票那一路还必须带 botId，并再次校验 routine.botId——账号票本身能覆盖这个人的多颗
 * Bot，只按 accountId 判断会让一颗 Bot 猜中 id 后改到另一颗 Bot 的日常任务。
 */
import type { RouteCtx } from './ctx.ts'
import { bearer, HttpError, json, type Req, type Router } from '../http.ts'
import { bodyOf, strField } from '../lib/validate.ts'
import { requireSeatOrUser, requireUser } from '../lib/guards.ts'
import { visibleBotOf } from '../lib/runtime.ts'
import { companyMachineOf } from '../deploy.ts'
import { canonicalTimezone, parseRoutineTriggers, ROUTINE_MAX_TRIGGERS, RoutineBusyError, type Account, type Db, type Routine, type RoutineModelRole, type RoutineRun } from '../db.ts'
import { nextRunAtOf } from '../lib/schedule.ts'
import { ROUTINE_RETRY_MAX, runRoutine } from '../routines.ts'

/** 名字和指令的长度。**指令不是提示词工程的画布**：真要长文，写进 Skill 里。 */
const MAX_NAME = 80
const MAX_INSTRUCTION = 4000
/** 详情里带多少条流水。侧栏那一列超过这个数就不是「最近跑得怎么样」了。 */
const RUNS_SHOWN = 10
/**
 * 进审计的指令留多长。
 *
 * **要留一点，不能只记「改了指令」。** 审计那一屏要回答的是「这个 Bot 昨晚为什么自己
 * 发了那封信」，而答案就写在指令里；只记一个 id 的话，那一行等于没写。也不留全文——
 * 审计不是内容库（见 docs/gateway-runtime.md：这里存的是「谁在何时做了什么」，不是
 * 聊天全文），头一段足够认出是哪件事。
 */
const AUDIT_INSTRUCTION = 200

/**
 * 「上一次砸了，还欠着一次补跑」这件事，界面上要说得出来。
 *
 * 只发**时刻和第几次**，不发那三档间隔：界面写的是「22:42 再试一次（第 1 次，共 3 次）」
 * ——它要的就是这两个数。把间隔表也发过去，等于让浏览器自己再算一遍同一件事，而那份
 * 算法在 Gateway 手里（`GATEWAY_ROUTINE_RETRY_MS` 一改，两边就对不上了）。
 */
function publicRetry(routine: Routine) {
  return { retryAt: routine.retryAt, retryCount: routine.retryCount, retryMax: ROUTINE_RETRY_MAX }
}

function publicRun(run: RoutineRun) {
  return {
    id: run.id,
    trigger: run.trigger,
    status: run.status,
    sessionId: run.sessionId,
    error: run.error,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    /** 哪台机器的工人跑的；null = Gateway 自己跑的。界面上用来解释「机器没回报」是哪台。 */
    machineId: run.machineId,
  }
}

function publicRoutine(routine: Routine, lastRun?: RoutineRun) {
  return {
    id: routine.id,
    botId: routine.botId,
    name: routine.name,
    instruction: routine.instruction,
    active: routine.active,
    triggers: routine.triggers,
    modelRole: routine.modelRole,
    nextRunAt: routine.nextRunAt,
    ...publicRetry(routine),
    // 列表里那一行也要能显示「上一次红了」。为此单查一条，不是把十条全带上。
    lastRun: lastRun ? publicRun(lastRun) : null,
    createdAt: routine.createdAt,
    updatedAt: routine.updatedAt,
  }
}

/**
 * 新触发器默认落在哪个时区。
 *
 * 优先用**浏览器报上来的那个**：人写「九点」写的是自己面前的九点。拿不到才退回这家
 * 公司运行机器的时区——那是这颗 Bot 真正在跑的地方，比服务器本地时间近一层。
 */
async function suggestTz(db: Db, account: Account, browserTz: string): Promise<string> {
  const fromBrowser = canonicalTimezone(browserTz)
  if (fromBrowser) return fromBrowser
  const machine = account.companyId ? await companyMachineOf(db, account.companyId) : undefined
  return canonicalTimezone(machine?.timezone || '') || 'UTC'
}

/** 自己那条。别人的、不存在的都是 404。 */
async function ownRoutineOf(db: Db, account: Account, id: string, botId?: string): Promise<Routine> {
  const row = await db.routine((id || '').trim())
  if (!row || row.accountId !== account.id || (botId && row.botId !== botId)) throw new HttpError(404, '没有这条日常任务')
  return row
}

/**
 * 请求体里的触发器 → 存得下去的形状。
 *
 * 解析走的是库那一份 `parseRoutineTriggers`（读库时用的也是它），**但这里要报错**：
 * 读库那一路认不出来就丢掉，因为一条脏数据不该让整个列表打不开；而人刚点的那一下，
 * 静静地少存一个触发器，等于告诉他「设好了」然后永远不跑。
 */
function triggersOf(raw: unknown, tz: string) {
  if (raw == null) return undefined
  if (!Array.isArray(raw)) throw new HttpError(400, 'triggers 必须是数组')
  if (raw.length > ROUTINE_MAX_TRIGGERS) throw new HttpError(400, `一条日常任务最多 ${ROUTINE_MAX_TRIGGERS} 个触发器`)
  const filled = raw.map((item) => {
    const o = (item ?? {}) as Record<string, unknown>
    return { ...o, tz: canonicalTimezone(String(o.tz ?? '')) || tz }
  })
  const parsed = parseRoutineTriggers(filled)
  if (parsed.length !== raw.length) throw new HttpError(400, '有触发器的形状不对')
  return parsed
}

/**
 * 用哪个模型跑。**只认 `daily` 和 `utility`，别的一律 400。**
 *
 * 库里那份 `parseRoutineModelRole` 认不出来就当 utility——读库那一路没人接得住异常，
 * 一条脏数据不该让整个列表打不开。而人刚在界面上选的那一下不能这么办：把一个拼错的
 * 值静静地存成 utility，接口回 200、界面上写着「日常模型」，跑起来却是另一个。
 */
function modelRoleOf(raw: unknown): RoutineModelRole | undefined {
  if (raw === undefined) return undefined
  const v = String(raw ?? '')
  if (v !== 'daily' && v !== 'utility') throw new HttpError(400, 'modelRole 只能是 daily 或 utility')
  return v
}

export function attachRoutines(router: Router, ctx: RouteCtx) {
  const { db, keys } = ctx

  /**
   * 人和 Bot 共用路由，但席位票必须把当前 botId 钉回来。
   *
   * 列表 / 新建的 botId 在路径上；按 routine id 操作时由工具放在 query 里。登录 JWT 不用
   * 这一格——人可以在同一个页面切换自己名下的 Bot，而席位进程永远只代表部署时钉的那颗。
   */
  async function caller(req: Req, pathBotId?: string): Promise<{ account: Account; seatBotId?: string; by: 'user' | 'bot' }> {
    const token = bearer(req)
    const account = await requireSeatOrUser(req, db, keys)
    if (!token?.startsWith('sat_')) return { account, by: 'user' }
    const seatBotId = (pathBotId || req.query.get('botId') || '').trim()
    if (!seatBotId) throw new HttpError(400, '席位操作日常任务时要带 botId')
    await visibleBotOf(db, account, seatBotId)
    return { account, seatBotId, by: 'bot' }
  }

  router.get('/runtime/bots/:id/routines', async (req, res) => {
    const { account } = await caller(req, req.params.id)
    const bot = await visibleBotOf(db, account, req.params.id)
    const rows = await db.routinesOf(account.id, bot.id)
    const withRuns = await Promise.all(
      rows.map(async (r) => publicRoutine(r, (await db.routineRuns(r.id, 1))[0])),
    )
    json(res, 200, { routines: withRuns })
  })

  router.post('/runtime/bots/:id/routines', async (req, res) => {
    const { account, by } = await caller(req, req.params.id)
    const bot = await visibleBotOf(db, account, req.params.id)
    const body = bodyOf(req)
    const tz = await suggestTz(db, account, strField(body, 'tz', false))
    const triggers = triggersOf(body.triggers, tz) ?? []
    const routine = await db.insertRoutine({
      botId: bot.id,
      accountId: account.id,
      companyId: account.companyId!,
      name: strField(body, 'name', false).slice(0, MAX_NAME),
      instruction: strField(body, 'instruction', false).slice(0, MAX_INSTRUCTION),
      triggers,
      modelRole: modelRoleOf(body.modelRole),
      nextRunAt: nextRunAtOf({ active: true, triggers }),
    })
    await db.audit({
      companyId: account.companyId!,
      accountId: account.id,
      action: 'routine.create',
      detail: { id: routine.id, botId: bot.id, name: routine.name, by },
    })
    json(res, 201, { routine: publicRoutine(routine) })
  })

  router.get('/runtime/routines/:rid', async (req, res) => {
    const { account, seatBotId } = await caller(req)
    const routine = await ownRoutineOf(db, account, req.params.rid, seatBotId)
    const runs = await db.routineRuns(routine.id, RUNS_SHOWN)
    json(res, 200, { routine: publicRoutine(routine, runs[0]), runs: runs.map(publicRun) })
  })

  /**
   * 改一条。**只改传了的字段**：界面上改名字、改指令、拨开关是三次独立的保存，
   * 整行覆盖会让慢到的那一次把先到的抹掉。
   *
   * 触发器或者开关一动，下一次的时间当场重算——不重算的话，人把时间从九点改成七点，
   * 今晚仍然会在九点跑，而界面上写着七点。
   */
  router.patch('/runtime/routines/:rid', async (req, res) => {
    const { account, seatBotId, by } = await caller(req)
    const routine = await ownRoutineOf(db, account, req.params.rid, seatBotId)
    const body = bodyOf(req)
    const tz = await suggestTz(db, account, strField(body, 'tz', false))
    const patch: Parameters<Db['updateRoutine']>[1] = {}
    if (body.name !== undefined) patch.name = strField(body, 'name', false).slice(0, MAX_NAME)
    if (body.instruction !== undefined) patch.instruction = strField(body, 'instruction', false).slice(0, MAX_INSTRUCTION)
    if (body.active !== undefined) patch.active = body.active === true
    const modelRole = modelRoleOf(body.modelRole)
    if (modelRole !== undefined) patch.modelRole = modelRole
    const triggers = triggersOf(body.triggers, tz)
    if (triggers !== undefined) patch.triggers = triggers
    if (patch.active !== undefined || patch.triggers !== undefined) {
      patch.nextRunAt = nextRunAtOf({
        active: patch.active ?? routine.active,
        triggers: patch.triggers ?? routine.triggers,
      })
    }
    /**
     * **这条任务从此不再自己动了，就把欠着的那次补跑一起收掉。**
     *
     * 判据是**重算出来的下一次是不是 null**，不是「有没有拨开关」。两条路都到得了这个
     * 状态，而它们在人那边是同一句话「别再自己跑了」：
     *
     * - 拨到停用
     * - **把时间一个不剩地删光**（界面上删掉最后一个触发器发的就是 `triggers: []`）
     *
     * 少了后半句的话：21:00 那次失败排下 21:05 的补跑，人 21:02 把唯一那个时间删掉，
     * 21:05 这个 Bot 照样自己把指令发了出去——而那一刻界面上写着「还没有设定时间」。
     *
     * 反过来重新打开时也清（`toggled` 那一半）：不清的话，停用期间攒下的旧时刻会在打开
     * 的一瞬间就到点，人拨一下开关，屏幕上当场多出一次没头没脑的运行。
     *
     * 改指令、把时间从九点改成七点**不清**——那两下说的是「以后怎么跑」，这条任务还是
     * 会自己动，而这次补跑欠的是刚才那一次。
     */
    const unscheduled = patch.nextRunAt === null
    const toggled = patch.active !== undefined && patch.active !== routine.active
    if (unscheduled || toggled) {
      patch.retryAt = null
      patch.retryCount = 0
    }
    const next = await db.updateRoutine(routine.id, patch)
    // 读到之后、写下去之前被另一个标签页删掉了：update 影响 0 行，读回来是空。
    // 这里不 `!` 断言一下了事——那是一个 500，而这件事的真相就是「没有这条」。
    if (!next) throw new HttpError(404, '没有这条日常任务')
    /**
     * 只有两件事进审计：**这个 Bot 会不会自己动**（开关），以及**它自己动的时候做
     * 什么**（指令）。改个名字不记——那一栏要是被每一次失焦保存刷满，真正要紧的两行
     * 就淹了。
     */
    if (patch.active !== undefined && patch.active !== routine.active) {
      await db.audit({
        companyId: account.companyId!,
        accountId: account.id,
        action: 'routine.active',
        detail: { id: routine.id, name: next.name, active: next.active, by },
      })
    }
    if (patch.instruction !== undefined && patch.instruction !== routine.instruction) {
      await db.audit({
        companyId: account.companyId!,
        accountId: account.id,
        action: 'routine.update',
        detail: { id: routine.id, name: next.name, instruction: next.instruction.slice(0, AUDIT_INSTRUCTION), by },
      })
    }
    json(res, 200, { routine: publicRoutine(next) })
  })

  router.delete('/runtime/routines/:rid', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const routine = await ownRoutineOf(db, account, req.params.rid)
    await db.deleteRoutine(routine.id)
    await db.audit({
      companyId: account.companyId!,
      accountId: account.id,
      action: 'routine.delete',
      detail: { id: routine.id, botId: routine.botId, name: routine.name, by: 'user' },
    })
    json(res, 200, { deleted: true, id: routine.id })
  })

  /**
   * 试跑。和到点跑走的是同一条路（同一个会话、同一段指令），区别只有流水上的
   * `trigger` 一个字——**否则「试跑成功、到点不灵」就查无可查**。
   *
   * 停用的也能试跑：那正是人调这段指令时的状态。
   */
  router.post('/runtime/routines/:rid/run', async (req, res) => {
    const { account, seatBotId } = await caller(req)
    const routine = await ownRoutineOf(db, account, req.params.rid, seatBotId)
    if (!routine.instruction.trim()) throw new HttpError(400, '先写清楚它每次要做什么')
    if (await db.routineRunning(routine.id)) throw new HttpError(409, '上一次还在跑')
    // 先查只是少一次报错；并发点两下真正靠库里的部分唯一索引挡（迁移 0035）。
    let run: RoutineRun
    try {
      run = await runRoutine(db, routine, 'manual')
    } catch (e) {
      if (e instanceof RoutineBusyError) throw new HttpError(409, '上一次还在跑')
      throw e
    }
    json(res, 200, { run: publicRun(run) })
  })
}
