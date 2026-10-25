/**
 * 席位部署的状态机：登记、装、等、对账、排队重铺、拆。
 *
 * 规矩写在各个函数的注释里；对外的入口是 deploySeat / startSeatDeploy / deploySeatBriefly、
 * runSeatDeployQueue / kickSeatDeployQueue / queueSeatUpdates、reconcileDeploy、releaseSeats / purgeBot。
 */
import { existsSync } from 'node:fs'
import { isUniqueViolation, releaseArch, type Account, type BotRelease, type Db, type Machine, type SeatDeployRequest, type SeatRuntime } from '../db.ts'
import type { JwtKeys } from '../crypto.ts'
import { botReleaseFile, desiredBotRelease, directReleaseUrl } from '../releases.ts'
import { afterResponse } from '../lib/background.ts'
import { MIN_MANAGER_PROTOCOL, linuxUserOf, seatIdOf, homeDirOf, workDirOf, seatDirOf, SlotsExhausted, portsOf, botBaseOf, randomVncPassword, gatewayPublicUrl, machinePaired } from './paths.ts'
import { DEPLOY_TIMEOUT_MS, type ManagerSeat, managerSeatsOf, type SeatSpec, SeatBusyError, ManagerTimeoutError, managerDeploy, managerRemoveSeat, type SeatStep, seatStepOf, tailOf, sanitizeError } from './manager.ts'
import { allocateSlot, machineForAccount } from './machines.ts'

export interface DeployResult {
  runtime: SeatRuntime
  machine: Machine
}

/**
 * 这一次部署失败了。**`busy` 是第三种结局**，不是失败的一种。
 *
 * 挑出来单独命名，是因为下面这三条路（同步部署、后台自动部署、批量更新）的调用方都
 * 要按同一套字段说话。
 */
export interface DeployFailure {
  ok: false
  status: number
  error: string
  runtime: SeatRuntime | undefined
  /**
   * 席位上有人正在说话，管家等过了也没等到，于是什么都没动。
   *
   * **必须是一个字段，不能让调用方拿 409 反推**——这条路上有六处 409（管家版本过旧、
   * 架构不匹配、槽位用尽、没有发布版本、公司没配对机器，以及这一条），含义天差地别。
   * 反推的代价是真的：批量更新会把「这台机器的管家太旧」整片报成「大家在忙，晚点再
   * 来」，而且因为一个失败都没有，那句提示还是绿的——真正的原因从此浮不出来。
   */
  busy?: boolean
  /**
   * 这个席位上已经有一次部署在进行（别的实例、别的人登记的），这次什么都没动。和 busy
   * 一样是「晚点再来」，但原因不同：busy 是席位上有人在说话，这个是机器上正在装。
   */
  inFlight?: boolean
  /**
   * 等到自己的超时了，机器上多半还在装（管家不知道调用方走了）。**那一行留在 `installing`**，
   * 结局由 reconcileDeploy 事后去管家那儿问——当场标红的话，机器上装得好好的席位会被说成失败。
   */
  pending?: boolean
}

export type DeployOutcome = { ok: true; result: DeployResult } | DeployFailure

/**
 * 「登记」这一段的产物：槽位定了、行写下了（`deploying`），机器上还一个字节没动。
 *
 * 部署被切成**登记**和**安装**两段，是为了「建完 Bot 自动装」这条路：安装要十几分钟，
 * 不可能挂在建 Bot 那条 HTTP 请求上；而登记必须在回执发出去之前做完——不然人跳进对话
 * 页的那一瞬间，库里还没有任何一行说「这颗 Bot 正在装」，界面只好照旧劝他去点「部署
 * 这个 Bot」，而机器上其实已经开工了。两个按钮打架，比慢一点糟得多。
 */
interface DeployPlan {
  account: Account
  companyId: string
  botId: string
  machine: Machine
  release: BotRelease
  version: string
  /** 刚写下的那一行（`deploying`）。 */
  row: SeatRuntime
  /** 这次之前的那一行。失败要回退成它，成功要接着它的 deployedAt。 */
  existing: SeatRuntime | undefined
  vncPassword: string
  interrupt: boolean
  drainMs: number
  timeoutMs?: number
}

type Reservation =
  /** 已经是这个版本、而且好着，这次什么都不用做。 */
  | { ok: true; done: DeployResult }
  | { ok: true; plan: DeployPlan }
  | DeployFailure

/**
 * 分配（或复用）一个槽，把这个席位部署出去。
 *
 * Stub：`SATUWORK_DEPLOY_STUB=1` 直接写 ready，不联系管家。
 * Live：`PUT {machine.host}/seats/{seatId}`，机器上的活儿全由管家做。
 *
 * **整段是同步的**：调用方要一直等到机器上装完（最长 DEPLOY_TIMEOUT_MS）。要「先回执、
 * 后台装」的那条路走 startSeatDeploy / deploySeatBriefly；Vercel 上一条请求最多活 300 秒，
 * 只有自己给了短超时的（模版下发、批量更新的队列）才该走这一条。
 */
export async function deploySeat(
  db: Db,
  _keys: JwtKeys,
  account: Account,
  opts: DeployOpts,
): Promise<DeployOutcome> {
  return await deploySeatNow(db, account, opts)
}

async function deploySeatNow(db: Db, account: Account, opts: DeployOpts): Promise<DeployOutcome> {
  const res = await reserveSeat(db, account, opts)
  if (!res.ok) return res
  if ('done' in res) return { ok: true, result: res.done }
  return await installSeat(db, res.plan)
}

export interface DeployOpts {
  botId: string
  version?: string
  update?: boolean
  force?: boolean
  /**
   * 打断正在跑的那一轮。默认跟着 `force` 走——人手工按「重新部署」时要的就是「现在
   * 就重铺」。模版下发那条路带着 force（为了穿过「版本没变就跳过」那道门）却**不**
   * 想打断谁，它显式传 false。
   */
  interrupt?: boolean
  timeoutMs?: number
}

/**
 * 在装心跳的节拍和时限。
 *
 * 推着一次部署的那个进程（installSeat）每 DEPLOY_BEAT_MS 往那一行写一次 `deployBeatAt`；
 * 超过 DEPLOY_BEAT_TTL_MS 没写，就当那个进程没了——函数实例被掐（300 秒的顶）、Gateway
 * 重启。时限取节拍的四倍：续约赶上库抖一两下，不该让别的实例以为没人在装、抢着再装一遍。
 */
export const DEPLOY_BEAT_MS = 15_000
export const DEPLOY_BEAT_TTL_MS = 60_000

/**
 * 这一行此刻有没有一个活着的 Gateway 进程在推。**看库，不看进程。**
 *
 * 以前答这件事的是进程里的一张 Map（inFlightDeploys），而 Gateway 在 Vercel 上是好几个
 * 实例：装的那个和问的那个多半不是同一个，问的那边永远看到「没人在装」——进度页改口说
 * 「上一次安装没做完」、给出「重新部署」，一按就再登记一遍、重写 deployStartedAt、再往
 * 机器上发一次 `PUT /seats/:id`。
 *
 * 只答「Gateway 这边有没有人推着」。Gateway 这边没人了、机器上还在装的那种（函数被掐了，
 * 管家不知道调用方已经走了）由 reconcileDeploy 去问管家。
 */
export function deployBeating(row: Pick<SeatRuntime, 'status' | 'deployBeatAt'>, now = Date.now()): boolean {
  return row.status === 'deploying' && row.deployBeatAt != null && now - row.deployBeatAt < DEPLOY_BEAT_TTL_MS
}

/** reserveSeat 在锁里发现别人刚登记上时用它跳出事务（不是错误，是「这次不用你装了」）。 */
class DeployInFlight extends Error {
  constructor(readonly runtime: SeatRuntime) {
    super('这个席位正在部署')
  }
}

const IN_FLIGHT_MESSAGE = '这个席位正在部署，等这一次装完再来'

/**
 * /runtime/deploy 这类「人在等」的入口等后台那一段多久。
 *
 * 在这之内装完的（stub、给已经装好桌面栈的席位重铺）照旧当场回结局，界面和脚本都不用
 * 改；装不完的（第一次装要 apt 十几分钟）回 202，界面转去轮询进度。**必须远小于函数的
 * 300 秒**：以前这里一直等到装完，首装必然 504，审计没写、界面说失败，而机器上装得好好的。
 */
export function deployWaitMs(): number {
  const raw = (process.env.GATEWAY_DEPLOY_WAIT_MS || '').trim()
  const n = Number(raw)
  return raw && Number.isFinite(n) && n >= 0 ? n : 20_000
}

/** 登记完、机器上的那段交给后台之后，调用方手上的东西。 */
export interface StartedDeploy {
  ok: true
  runtime: SeatRuntime
  machine: Machine | undefined
  /** 这一刻机器上是不是还在装（false = 已经是这个版本、什么都不用做）。 */
  installing: boolean
  /** 在装的是**别人**登记的那一次，这次什么都没登记、什么都没发。 */
  already?: boolean
  /** 后台那一段的结局。永远 resolve（异常折成 DeployFailure），没人接着也无妨。 */
  settled?: Promise<DeployOutcome>
}

/**
 * **先登记，后台装。** 登记那一段（挑机器、定槽位、写下 `deploying` 那一行）等着做完
 * 才返回，机器上那十几分钟丢进后台。
 *
 * 建完 Bot 自动部署走的就是这条：人不该为了「能用」去点第二个按钮，也不该盯着一个转
 * 十几分钟的圈等 HTTP 回执——那条请求活不了那么久，中间任何一次网络抖动都会让界面以为
 * 部署失败了，而机器上装得好好的。
 *
 * 后台那一段的结局落在席位行上（`ready` / `error` + lastError），界面照旧从
 * `/runtime/desktop` 和 `/runtime/deploy/progress` 读——**不需要有人接着这个 promise**。
 *
 * 已经有人在装（别的实例、别的人、双击）就当这次也算数：调用方要的是「它在装」，而它
 * 确实在装。**不再登记、不再发第二次 `PUT`**——判据在库里（见 reserveSeat 的认领）。
 */
export async function startSeatDeploy(
  db: Db,
  account: Account,
  opts: DeployOpts,
): Promise<StartedDeploy | DeployFailure> {
  const res = await reserveSeat(db, account, opts)
  if (!res.ok) {
    if (res.inFlight && res.runtime) {
      return { ok: true, runtime: res.runtime, machine: await db.machine(res.runtime.machineId), installing: true, already: true }
    }
    return res
  }
  if ('done' in res) return { ok: true, runtime: res.done.runtime, machine: res.done.machine, installing: false }
  const plan = res.plan
  const settled: Promise<DeployOutcome> = installSeat(db, plan).then(
    (out) => {
      // 失败已经写进席位行了（lastError），这里只留一行日志：后台没有调用方，不打的话
      // 这台机器上发生过什么在进程外一个字都看不到。
      if (!out.ok && !out.busy) console.warn(`satuwork-gateway: 席位 ${plan.row.seatId} 后台部署没成：${out.error}`)
      return out
    },
    (e): DeployFailure => {
      const error = e instanceof Error ? e.message : String(e)
      console.warn(`satuwork-gateway: 席位 ${plan.row.seatId} 后台部署异常：${error}`)
      return { ok: false, status: 500, error, runtime: undefined }
    },
  )
  /**
   * **Vercel 上要 waitUntil，否则这一段在回包之后随时会被冻住。** 函数实例回完响应就可能
   * 被挂起，后台那个 `PUT /seats/:id` 管家照样装完了，可等它回来、把 `ready` 写回库的这一段
   * 再也没人跑。waitUntil 让实例撑到这个 promise 结束（上限是函数自己的 maxDuration）；撑
   * 不住的（首装超过时限）心跳跟着断，由 reconcileDeploy 去管家那儿问结局收尾。
   */
  afterResponse(`席位 ${plan.row.seatId} 的后台部署`, settled)
  return { ok: true, runtime: plan.row, machine: plan.machine, installing: true, settled }
}

/**
 * 「人在等」的那几条部署入口（`/runtime/deploy`、公司侧替人部署）：后台装，**但先等一小会儿**。
 *
 * 等得到结局就照旧回结局（ready / 失败原因），和以前同步的那条路一个样子；等不到（首装、
 * 机器慢）就回「在装」，调用方转去轮询进度。在装的那一段不挂在这条请求上，所以请求
 * 永远在 deployWaitMs 之内回来，审计也一定写得上。
 */
export async function deploySeatBriefly(
  db: Db,
  account: Account,
  opts: DeployOpts,
  waitMs = deployWaitMs(),
): Promise<Omit<StartedDeploy, 'settled'> | DeployFailure> {
  const started = await startSeatDeploy(db, account, opts)
  if (!started.ok || !started.settled) return started
  const { settled, ...rest } = started
  const out = await within(settled, waitMs)
  if (!out) return rest
  if (out.ok) return { ok: true, runtime: out.result.runtime, machine: out.result.machine, installing: false }
  // 等超时了、机器上还在装（见 ManagerTimeoutError）：不是失败，照「在装」回。
  if (out.pending && out.runtime) return { ...rest, runtime: out.runtime }
  return out
}

/** 等一个 promise 至多 ms 毫秒；等不到是 undefined（promise 本身照旧跑下去）。 */
async function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const gate = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([p, gate])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 登记：挑机器、挑版本、定槽位，把席位行写成 `deploying`。**不碰机器。**
 *
 * 六个 4xx 出口全在这一段——所有「这次根本装不成」的理由（没配对机器、管家太旧、架构
 * 不对、没发布包、槽位用尽、没有这颗 Bot）在这里就答得出来，所以后台那条路也能当场
 * 把它们原样回给调用方。
 */
async function reserveSeat(db: Db, account: Account, opts: DeployOpts): Promise<Reservation> {
  const companyId = account.companyId
  if (!companyId) return { ok: false, status: 403, error: '没有公司席位', runtime: undefined }
  const botId = (opts.botId || '').trim()
  if (!botId) return { ok: false, status: 400, error: 'botId 不能为空', runtime: undefined }
  // 按**主人**取名册：员工自己建的 Bot 只有他自己部署得了，别人拿到 id 也不行。
  const visible = await db.botsFor(companyId, account.id)
  if (!visible.some((b) => b.id === botId)) {
    return { ok: false, status: 404, error: '没有这个 Bot', runtime: undefined }
  }
  const picked = await machineForAccount(db, companyId, account.id)
  if (!picked.ok) return { ok: false, status: picked.status, error: picked.error, runtime: undefined }
  const machine = picked.machine
  if (machine.protocol < MIN_MANAGER_PROTOCOL) {
    return { ok: false, status: 409, error: '这台机器的管家版本过旧，等它自己升级或重跑安装脚本', runtime: undefined }
  }

  /**
   * 要不要打断席位上正在跑的那一轮。默认跟着 force 走——人按「重新部署」时要的就是
   * 「现在就重铺」；模版下发也带 force（为了穿过下面那道「版本没变就跳过」的门），
   * 但它显式传 interrupt:false，因为它没有理由把所有人的会话一起掐掉。
   */
  const interrupt = opts.interrupt ?? opts.force === true
  /**
   * 允许管家花在「等这一轮跑完」上的时间。
   *
   * **从这次请求自己的超时里切一半**，剩下一半留给真正的重铺。这样「排空到一半被自己
   * 的超时掐断」在结构上就不可能发生——而它真的发生过：模版「立即下发」给单席位 90 秒，
   * 管家那边默认等 120 秒，于是每一个忙着的席位都会在 90 秒时被 Gateway abort，库里记
   * 下一条「联系不上机器管家」并标红，而管家根本不知道调用方走了，照样等满 120 秒再把
   * 席位重铺重启。机器好好的，状态却是假的。
   *
   * 管家那头还会和本机上限取小（见 manager/src/seats.ts 的 drainWindowMs），所以这个数
   * 只会让排空更短，不会越过机器自己的界。
   */
  const drainMs = Math.floor((opts.timeoutMs ?? DEPLOY_TIMEOUT_MS) / 2)

  const requested = (opts.version || '').trim()
  let release: BotRelease
  if (requested) {
    let rel = await db.botRelease(requested)
    if (!rel) return { ok: false, status: 404, error: '没有这个 Bot 版本', runtime: await db.seatRuntime(account.id, botId) }
    // 显式指定也要挡：包里带 esbuild 的原生二进制，装错架构的后果是席位「部署成功」
    // 但 bot 起不来，表现是聊天 503——从部署结果上完全看不出来。两边架构都认得出来
    // 且不一样才拦，认不出来的（老版本号没后缀）放行。
    //
    // 拦之前先找**同一次发布的另一份包**（`…-x64` ↔ `…-arm64`），和管家钉版本同一套
    // （lib/machines.ts 的 managerReleaseFor）：钉版本的人只写得了一个字符串，照着发下去，
    // 另一种架构的机器就全部署不了。兄弟包也没有才 409。
    const want = machine.arch?.trim()
    const got = releaseArch(rel.version)
    if (want && got && got !== want) {
      const sibling = rel.version.replace(/-(x64|arm64)$/, '') + '-' + want
      const alt = await db.botRelease(sibling)
      if (!alt) {
        return {
          ok: false,
          status: 409,
          error: `这台机器是 ${want}，而 ${rel.version} 是 ${got} 的包，也没有同版本的 ${want} 包`,
          runtime: await db.seatRuntime(account.id, botId),
        }
      }
      rel = alt
    }
    release = rel
  } else {
    // 不指定版本 = 平台钉的那一版（没钉就是最新）。直接取最新的话，钉版本时新铺的席位会
    // 装上最新，十分钟后又被心跳里的跟版拉回钉的那版——白装一遍，人还看得见它来回跳。
    const target = await desiredBotRelease(db, machine.arch)
    if (!target) return { ok: false, status: 409, error: '还没有发布 Bot 版本', runtime: await db.seatRuntime(account.id, botId) }
    release = target
  }
  const version = release.version

  const linuxUser = linuxUserOf(account.id)
  const seatId = seatIdOf(account.id, botId)
  let existing = await db.seatRuntime(account.id, botId)
  /**
   * **已经有一次在装，就不再登记第二次。**
   *
   * 判据全在库里（在装心跳，见 deployBeating），不在进程里——Gateway 在 Vercel 上是好几个
   * 实例，双击、刷新、另一个实例上的进度页按下的「重新部署」都可能落在不是装的那个实例上。
   * Gateway 这边没人推了的，再问一次管家（reconcileDeploy）：机器上还在装就照样算在装；
   * 管家那边已经有结局的顺手落库，这次照常往下走。
   */
  if (existing?.status === 'deploying') {
    const rec = await reconcileDeploy(db, existing, existing.machineId === machine.id ? { machine } : {})
    if (rec.live) return { ok: false, status: 409, error: IN_FLIGHT_MESSAGE, runtime: rec.runtime, inFlight: true }
    existing = rec.runtime
  }
  // 已经是这个版本、而且好着 → 不重装。**但 force 必须能穿过这道门。**
  //
  // 界面上「重新部署」按钮发的就是不带 force 的请求，于是它一直什么都没做：确认框写
  // 着「会把席位重装一遍并重启」，接口返回 200 和 ready，deployedAt 一秒都没动。
  // 而人按这个按钮的时候，要的恰恰是「现在这台机器上的东西不对，重新铺一遍」——
  // 席位状态 ready、版本没变，正是那种情况最典型的样子（VNC 口令没同步、dock 少一格、
  // 桌面服务还是老进程）。这道门把唯一的自助修复手段变成了一个安慰剂。
  if (existing?.status === 'ready' && existing.botVersion === version && !opts.update && !opts.force) {
    return { ok: true, done: { runtime: existing, machine } }
  }

  const vncPassword = existing?.vncPassword || randomVncPassword()
  let row: SeatRuntime | undefined
  try {
    for (let i = 0; i < 8; i++) {
      try {
        row = await db.tx(async () => {
          // 「看一眼没人在装、写下我在装」要在同一把锁里：上面那次查是在锁外，两个实例
          // 同时来的话都会看到没人。锁是按席位的，别的席位不排这条队。
          await db.lockSeatDeploy(account.id, botId)
          const cur = await db.seatRuntime(account.id, botId)
          if (cur && deployBeating(cur)) throw new DeployInFlight(cur)
          const slot = await allocateSlot(db, machine.id, i === 0 ? existing?.slot : undefined)
          const ports = portsOf(slot)
          const now = Date.now()
          return await db.upsertSeatRuntime({
            accountId: account.id,
            botId,
            companyId,
            linuxUser,
            seatId,
            machineId: machine.id,
            slot,
            display: ports.display,
            vncPort: ports.vncPort,
            novncPort: ports.novncPort,
            botPort: ports.botPort,
            vncPassword,
            status: 'deploying',
            lastError: null,
            deployedAt: existing?.deployedAt ?? null,
            updatedAt: now,
            botVersion: existing?.botVersion ?? null,
            // 席位自报的那两列不由这条路写（见 db.noteSeatTemplate）。带上旧值只是为了
            // 让这个对象是一整行；upsert 的列表里没有它们，写不进去也盖不掉。
            tplVersion: existing?.tplVersion ?? null,
            tplSyncedAt: existing?.tplSyncedAt ?? null,
            /**
             * 进度从这一刻开始计时。**每次重铺都重写**——界面上那句「已经装了 X 分钟」
             * 说的是这一次，接着上一次的时刻算出来的数字只会吓人。
             */
            deployPhase: 'queued',
            deployStartedAt: now,
            // 登记这一刻就算报到：从这里到 installSeat 起心跳之间还隔着几次查库。
            deployBeatAt: now,
          })
        })
        break
      } catch (e) {
        // 槽位是 unique(machineId, slot)：并发部署撞号了就重扫一遍再试。
        if (i === 7 || !isUniqueViolation(e)) throw e
      }
    }
  } catch (e) {
    if (e instanceof SlotsExhausted) return { ok: false, status: 409, error: e.message, runtime: existing }
    if (e instanceof DeployInFlight) return { ok: false, status: 409, error: IN_FLIGHT_MESSAGE, runtime: e.runtime, inFlight: true }
    throw e
  }
  if (!row) return { ok: false, status: 500, error: '无法分配席位槽', runtime: existing }

  return {
    ok: true,
    plan: { account, companyId, botId, machine, release, version, row, existing, vncPassword, interrupt, drainMs, timeoutMs: opts.timeoutMs },
  }
}

/** 装完之后这一行还在吗。不在 = 部署期间这颗 Bot 被删了（见 installSeat 的收尾）。 */
async function seatStillThere(db: Db, plan: DeployPlan): Promise<boolean> {
  const row = await db.seatRuntime(plan.account.id, plan.botId)
  return Boolean(row && row.seatId === plan.row.seatId)
}

/**
 * 安装：把规格发给管家，等它把机器上的事做完，然后落一行结局。
 *
 * 这一段可以跑十几分钟（第一次要 apt 装一整套桌面栈），所以 `deployPhase` 在发出去之前
 * 就写成 `installing`——界面上那句「正在装」和机器上真的在装，指的必须是同一段时间。
 */
async function installSeat(db: Db, plan: DeployPlan): Promise<DeployOutcome> {
  /**
   * 装多久就报到多久（见 deployBeating）。**进程没了心跳就跟着断**——那正是别的实例要认出来
   * 的事；不会有人替一个死掉的进程续上。续不上（库抖了一下）只记一笔：TTL 是节拍的四倍。
   */
  const startedAt = plan.row.deployStartedAt ?? 0
  const beat = setInterval(() => {
    db.beatSeatDeploy(plan.row.seatId, startedAt).catch((e) => {
      console.warn(`satuwork-gateway: 席位 ${plan.row.seatId} 的在装心跳没写上：${e instanceof Error ? e.message : String(e)}`)
    })
  }, DEPLOY_BEAT_MS)
  beat.unref?.()
  try {
    return await installSeatOnce(db, plan)
  } finally {
    clearInterval(beat)
  }
}

async function installSeatOnce(db: Db, plan: DeployPlan): Promise<DeployOutcome> {
  const { account, companyId, botId, machine, release, version, row, existing, vncPassword } = plan

  if (process.env.SATUWORK_DEPLOY_STUB === '1') {
    /**
     * 仅供 e2e：让 stub 也「装」一会儿。不给的话 stub 一瞬间就 ready，「装的过程中又来了一次」
     * 「批量更新在后台往前走」这些时序一条都钉不住。
     */
    const stubMs = Math.max(0, Number(process.env.SATUWORK_DEPLOY_STUB_MS) || 0)
    if (stubMs) {
      await db.upsertSeatRuntime({ ...row, updatedAt: Date.now(), deployPhase: 'installing' })
      await new Promise((r) => setTimeout(r, stubMs))
    }
    const ready = await db.upsertSeatRuntime({
      ...row,
      status: 'ready',
      lastError: null,
      deployedAt: Date.now(),
      updatedAt: Date.now(),
      botVersion: version,
      deployPhase: null,
      deployStartedAt: null,
    })
    await db.upsertInstance({
      accountId: account.id,
      botId,
      companyId,
      host: `http://127.0.0.1:${row.botPort}`,
    })
    return { ok: true, result: { runtime: ready, machine } }
  }

  // `url` 非空 = 只登记了地址、字节不在本机（registerRemoteRelease 那种）。这种包由
  // openRelease 在下发时现取，本机**本来就没有** .tgz。以前这里无条件 existsSync，
  // 于是一旦最新版本是远程登记的，所有席位的部署都会卡在「发布包文件不存在」。
  if (!release.url && !existsSync(botReleaseFile(version))) {
    return await failSeat(db, plan, 502, '发布包文件不存在')
  }

  const secrets = await db.ensureAccountSecrets(account.id)
  if (!secrets) return await failSeat(db, plan, 500, '没有席位密钥')
  // 只用来写工作区那一格的名牌，查不到就不带，不为它挡部署。
  const botName = (await db.catalog(botId).catch(() => undefined))?.name?.trim()

  const spec: SeatSpec = {
    seatId: row.seatId,
    linuxUser: row.linuxUser,
    homeDir: homeDirOf(row.linuxUser),
    workDir: workDirOf(row.linuxUser),
    seatDir: seatDirOf(row.linuxUser, row.seatId),
    botId,
    // 13 号管家写进 ~/work/bots/<席位>/.bot-name，人在桌面上认得出这一格是谁的；老管家不认，忽略。
    ...(botName ? { botName } : {}),
    botVersion: version,
    // 能直连就把外部地址和校验值一起给：11 号起的管家直接去取、不带机器票、按 botSha256
    // 比对（manager/src/releases.ts）。老管家不认这两个字段，照旧从 Gateway 转发拉。
    ...directBotPackage(release),
    vncPassword,
    gatewayUrl: gatewayPublicUrl(),
    gatewayToken: secrets.accessToken,
    gatewayApiKey: secrets.apiKey,
    ports: portsOf(row.slot),
    // 人手工按的「重新部署」才打断正在跑的那一轮，别的（自动跟版、模版下发）都要等
    // 席位把手上的活干完，见 manager/src/seats.ts 的 drainSeat。
    ...(plan.interrupt ? { interrupt: true } : { drainMs: plan.drainMs }),
  }
  const sending = await db.upsertSeatRuntime({ ...row, updatedAt: Date.now(), deployPhase: 'installing' })
  try {
    await managerDeploy(machine, spec, plan.timeoutMs)
  } catch (e) {
    /**
     * 席位上有会话在跑，管家等过了也没等到它结束。**这不是失败**：机器上一个字节都
     * 没动，席位还是原来那个版本、还在好好地跑。
     *
     * 所以状态要**放回去**，不能留在登记那一步写下的 `deploying`——那一行会让界面
     * 一直显示「部署中」，而机器上根本没有任何事情在进行；也不能标成 `error`，那是
     * 一行红字加一个「重新部署」的暗示，而正确的动作是「等会儿再来，或者按强制」。
     */
    if (e instanceof SeatBusyError) {
      const kept = await db.upsertSeatRuntime({
        ...sending,
        status: existing?.status ?? 'ready',
        // **这一句不写进 lastError。** 席位卡里那一格出错时画的是 lastError、平时画的是
        // 版本号（见 ui/pages-machines.js），把一句「等会儿再来」摆进去，会在之后的每
        // 一天里都盖着「这台跑的是哪一版」——而它恰恰是查这类问题时要看的。这次的结局
        // 不会因此丢掉：批量那条路逐个席位报 `busy`（界面上单独数一格），单个那条路
        // 当场就是一句 409，管家的 journal 里还有一整行。
        lastError: existing?.lastError ?? null,
        deployedAt: existing?.deployedAt ?? null,
        updatedAt: Date.now(),
        botVersion: existing?.botVersion ?? null,
        deployPhase: null,
        deployStartedAt: null,
      })
      return { ok: false, status: 409, error: e.message, runtime: kept, busy: true }
    }
    /**
     * 等到自己的超时了。**机器上多半还在装**：管家不知道调用方走了，照样装完、照样记进它的
     * 名册。当场标红就是「界面说失败、机器好好的」——所以那一行留在 `installing`，心跳随着
     * 这一段结束而断，结局由 reconcileDeploy 去管家那儿问（进度页、每分钟那一拍都会问）。
     */
    if (e instanceof ManagerTimeoutError) {
      return { ok: false, status: 504, error: e.message, runtime: sending, pending: true }
    }
    return await failSeat(db, plan, 502, sanitizeError(e, [machine.token, secrets.accessToken, secrets.apiKey, vncPassword]))
  }

  /**
   * **装的过程中这颗 Bot 被删了。**
   *
   * 后台部署把这个窗口从「零点几秒」拉长到十几分钟，于是它从理论问题变成了会真的发生
   * 的事：人建完一颗 Bot、看着进度觉得建错了、当场删掉，而机器上那一套正装到一半。
   * 删除那条路（purgeBot）拆的是它当时看得见的席位行，拆完行就没了；这里要是照旧把
   * `ready` 写回去，库里会凭空长出一行指向一颗不存在的 Bot 的席位，机器上那套 systemd
   * 单元也永远没人来收——占着槽位和端口，而再没有任何东西指向它。
   *
   * 所以：行不在了就把机器上刚铺好的那套拆掉，什么都不写。
   */
  if (!(await seatStillThere(db, plan))) {
    await managerRemoveSeat(machine, row.seatId).catch((e) => {
      console.warn(`satuwork-gateway: 席位 ${row.seatId} 部署途中 Bot 被删，拆除失败：${e instanceof Error ? e.message : String(e)}`)
    })
    return { ok: false, status: 409, error: '这个 Bot 在部署过程中被删掉了', runtime: undefined }
  }

  const ready = await markSeatReady(db, { ...sending, accountId: account.id, botId, companyId }, version, machine)
  return { ok: true, result: { runtime: ready, machine } }
}

/**
 * 装好了：那一行落成 `ready`，并登记 bot 的反代地址。
 *
 * 两处用：installSeat 等到管家回包之后，以及 reconcileDeploy 事后从管家那儿问到结局时。
 * 两边写的必须是同一件事，不然「自己等到的」和「事后补上的」会是两种 ready。
 */
async function markSeatReady(db: Db, row: SeatRuntime, version: string, machine: Machine): Promise<SeatRuntime> {
  const ready = await db.upsertSeatRuntime({
    ...row,
    status: 'ready',
    lastError: null,
    deployedAt: Date.now(),
    updatedAt: Date.now(),
    botVersion: version,
    deployPhase: null,
    deployStartedAt: null,
  })
  await db.upsertInstance({
    accountId: row.accountId,
    botId: row.botId,
    companyId: row.companyId,
    // 反代地址，不是 bot 的直连地址。席位端口只听 127.0.0.1，只有管家够得着。
    host: botBaseOf(machine.host, row.seatId),
  })
  return ready
}

/**
 * Gateway 和管家的钟差多少还认。管家名册里那一行的 `deployedAt` 是管家自己的钟，拿去和
 * 库里的 `deployStartedAt`（Gateway 的钟）比；差个几秒是常事，差出半分钟就该去修 NTP 了。
 */
const DEPLOY_CLOCK_SLACK_MS = 30_000

/**
 * **没人等着的那次部署，结局去管家那儿问。**
 *
 * 在 Vercel 上，「后台装、装完回写」那一段会随函数实例一起被冻住或掐掉（见 startSeatDeploy
 * 的 waitUntil），在装心跳也跟着断了（见 deployBeating）。于是库里那一行停在 `installing`，
 * 而机器上早就装好了（或者装砸了、或者还在装）。Gateway 这边还有人推着的不用问。
 *
 * 只收 `installing` 的：`queued` 说明 `PUT /seats/:id` 还没发出去，机器上什么都没有，
 * 那就是真的没做完，照旧给「重新部署」。
 *
 * - 管家报得出这一步装到哪了 → 机器上还在装：`live`，接着等。
 * - 管家名册里有这个席位，而且是**这一次**装的（它开始装的时刻不早于库里记的开始时刻）
 *   → 按它的结局落 `ready` / `error`，和 installSeat 自己等到的一样。
 * - 别的（问不到、名册里没有、那一行是上一次的）→ 不知道，原样返回，`live: false`。
 */
export async function reconcileDeploy(
  db: Db,
  runtime: SeatRuntime,
  known: { machine?: Machine; seats?: ManagerSeat[] } = {},
): Promise<{ runtime: SeatRuntime; live: boolean; step?: SeatStep }> {
  const live = deployBeating(runtime)
  if (runtime.status !== 'deploying' || live) return { runtime, live }
  if (runtime.deployPhase !== 'installing' || runtime.deployStartedAt == null) return { runtime, live: false }
  const machine = known.machine ?? (await db.machine(runtime.machineId))
  if (!machine || !machinePaired(machine)) return { runtime, live: false }

  const step = await seatStepOf(machine, runtime.seatId)
  if (step) return { runtime, live: true, step }

  const seats = known.seats ?? (await managerSeatsOf(machine))
  const rec = seats?.find((x) => x?.seatId === runtime.seatId)
  if (!rec || !(Number(rec.deployedAt) >= runtime.deployStartedAt - DEPLOY_CLOCK_SLACK_MS)) return { runtime, live: false }

  if (rec.status === 'ready') {
    // 版本以管家装上的为准：库里那一行在装的过程中还记着上一版（见 reserveSeat）。
    const version = typeof rec.botVersion === 'string' && /^[A-Za-z0-9._+-]{1,64}$/.test(rec.botVersion)
      ? rec.botVersion
      : runtime.botVersion ?? ''
    return { runtime: await markSeatReady(db, runtime, version, machine), live: false }
  }
  const failed = await db.upsertSeatRuntime({
    ...runtime,
    status: 'error',
    lastError: tailOf(String(rec.lastError || '管家报告部署失败'), 900),
    updatedAt: Date.now(),
    deployPhase: null,
    deployStartedAt: null,
  })
  return { runtime: failed, live: false }
}

/**
 * 定时扫一遍：停在 `installing` 超过一分钟、又没有哪个 Gateway 进程还在推着的席位，挨台
 * 去问管家。
 *
 * 进度那条路（/runtime/deploy/progress）只在有人开着那一屏时才会问；没人看的那些——建完
 * Bot 就关了页面、批量铺的——靠这里收尾。心跳还新鲜的是别的实例正在正常等回包，那次会
 * 自己写，不去抢。
 */
export async function reconcileStuckDeploys(db: Db): Promise<number> {
  let settled = 0
  const now = Date.now()
  for (const machine of await db.allMachines()) {
    if (!machinePaired(machine)) continue
    const stuck = (await db.seatRuntimesOfMachine(machine.id)).filter(
      (r) =>
        r.status === 'deploying' &&
        r.deployPhase === 'installing' &&
        r.deployStartedAt != null &&
        now - r.deployStartedAt > 60_000 &&
        !deployBeating(r, now),
    )
    if (!stuck.length) continue
    const seats = await managerSeatsOf(machine)
    if (!seats) continue
    for (const row of stuck) {
      const out = await reconcileDeploy(db, row, { machine, seats })
      if (out.runtime.status !== 'deploying') settled++
    }
  }
  return settled
}

/**
 * 批量更新的队列里，一个席位允许花多久。
 *
 * 队列那一段跑在函数里（批量更新那条请求的 waitUntil，或者每分钟那一拍），函数最多活
 * 300 秒；排空给一半（见 reserveSeat 的 drainMs），剩下的够给已经装好桌面栈的席位重铺。
 * 真的超了（这个席位要首装）也不算失败：那一行留在 `installing`，由 reconcileDeploy 收尾。
 */
export const QUEUE_SEAT_TIMEOUT_MS = 240_000

/**
 * 队列一次跑多久就收手、剩下的留给下一拍。算的是「再开一个席位会不会越过这条线」：
 * 开到一半被函数掐掉，那一个席位的结局就只能等对账了。
 */
const QUEUE_WINDOW_MS = 270_000

/** 队列里一个席位的结局，和批量更新那两条路回给界面的那一行同形。 */
export interface QueuedDeployResult {
  accountId: string
  botId: string
  seatId: string
  status: string
  botVersion: string | null
  error?: string
  busy?: boolean
  /** 还没有结局：还在排队，或者机器上还在装。 */
  queued?: boolean
}

function queuedResultOf(seat: SeatRuntime, out: DeployOutcome): QueuedDeployResult {
  const base = { accountId: seat.accountId, botId: seat.botId, seatId: seat.seatId }
  if (out.ok) return { ...base, status: out.result.runtime.status, botVersion: out.result.runtime.botVersion ?? null }
  return {
    ...base,
    status: out.runtime?.status ?? 'error',
    botVersion: out.runtime?.botVersion ?? null,
    error: out.error,
    // 认 out.busy，不认状态码：deploySeat 有六处 409（见它的返回类型）。
    ...(out.busy ? { busy: true } : {}),
    ...(out.pending ? { queued: true } : {}),
  }
}

/**
 * 把排着队的部署往前推一段。**同一台机器一个一个来，不同机器并排走。**
 *
 * 批量更新以前是在请求里串着 `await deploySeat`，一个最长 15 分钟：Vercel 上推不到几个
 * 函数就被掐了——剩下的没升级、`runtime.update` 的审计没写、调用方拿到 504，正在装的那个
 * 停在 `installing`。现在请求只排队（db.queueSeatDeploy），推它的是这里：批量更新那条
 * 请求的 waitUntil 先推一段，没推完的由每分钟那一拍（maintenanceTick）接着推。
 *
 * 几个执行者可以同时在跑（两个实例、请求和那一拍），靠库里的两道闸不撞车：
 * - 领一个席位是一条带条件的 update（db.takeSeatDeploy），同一个只有一个人领得到；
 * - 一台机器上已经有谁在装（在装心跳新鲜），这一台这一轮先不动——排队本来就是为了
 *   不同时往一台机器上铺好几个。
 *
 * `only` 给了就只推这几个席位（批量更新那条请求只管自己排下的）；`onResult` 每落一个结局
 * 就报一次，调用方等不到整段跑完时也拿得到已经有的那些。
 */
export async function runSeatDeployQueue(
  db: Db,
  opts: { only?: Set<string>; onResult?: (r: QueuedDeployResult) => void } = {},
): Promise<QueuedDeployResult[]> {
  const t0 = Date.now()
  const results: QueuedDeployResult[] = []
  const push = (r: QueuedDeployResult) => {
    results.push(r)
    opts.onResult?.(r)
  }
  const queued = (await db.queuedSeatDeploys()).filter((r) => !opts.only || opts.only.has(r.seatId))
  const byMachine = new Map<string, SeatRuntime[]>()
  for (const r of queued) byMachine.set(r.machineId, [...(byMachine.get(r.machineId) ?? []), r])
  await Promise.all(
    [...byMachine].map(async ([machineId, list]) => {
      for (const seat of list) {
        if (Date.now() - t0 + QUEUE_SEAT_TIMEOUT_MS > QUEUE_WINDOW_MS) return
        const onMachine = await db.seatRuntimesOfMachine(machineId)
        if (onMachine.some((r) => deployBeating(r))) return
        const request = await db.takeSeatDeploy(seat.accountId, seat.botId)
        if (!request) continue
        const account = await db.account(seat.accountId)
        if (!account) {
          push({ accountId: seat.accountId, botId: seat.botId, seatId: seat.seatId, status: seat.status, botVersion: seat.botVersion ?? null, error: '账号不存在' })
          continue
        }
        const out = await deploySeatNow(db, account, { botId: seat.botId, ...request, timeoutMs: QUEUE_SEAT_TIMEOUT_MS }).catch(
          (e): DeployFailure => ({ ok: false, status: 500, error: e instanceof Error ? e.message : String(e), runtime: undefined }),
        )
        // 这一刻有人抢先在装（员工自己按了部署、另一个执行者）：放回队里，下一拍再来。
        if (!out.ok && out.inFlight) {
          await db.queueSeatDeploy(seat.accountId, seat.botId, request)
          return
        }
        push(queuedResultOf(seat, out))
      }
    }),
  )
  return results
}

/**
 * 自动跟版：同一个席位两次尝试之间至少隔多久。
 *
 * 心跳 30 秒一轮，没有这道间隔的话，一个一直有人在说话的席位会被每一轮排一次——每次
 * 管家都要落闸排空（见 manager/src/seats.ts 的 drainSeat），那个人看到的是 Bot 隔三差
 * 五「暂停接新活」。看的是席位行的 `updatedAt`：排空没等到（busy）那一支会把它刷成现在。
 */
export const BOT_FOLLOW_RETRY_MS = 10 * 60_000

/**
 * 心跳里顺手做的 Bot 自动跟版：把这台机器上**不在目标版本上**的席位排进部署队列。
 *
 * 和管家自升级同一个道理：推送要求推的那一刻机器在线，心跳驱动只要机器最终上线就会
 * 收敛——关机期间发的版，开机后第一轮心跳就排上。真正去装的是每一拍的队列
 * （runSeatDeployQueue），这里只排队，不在心跳请求里等任何部署。
 *
 * 目标是 desiredBotRelease：平台钉的那一版，没钉就是这台机器架构的最新包。比的是
 * 「不相等」而不是「更旧」——回滚就是把钉的版本改回上一版，席位跟着退回去。也因此
 * 单个席位手工装的别的版本会在 BOT_FOLLOW_RETRY_MS 之后被拉回目标版本：全机队的版本
 * 只有「钉」这一个开关，不另设逐席位的例外。
 *
 * 只排这些席位，别的一律不碰：
 * - `ready`：出错的留给人看。自动重试一个装不上的版本只会每十分钟再红一次；
 * - 队里没有别的活：已经排着的多半是人手工排的（重铺、指定版本），盖掉它就是替人改了主意。
 *   这一条**在库里判**（queueSeatDeploy 的 ifIdle），不看手上这份快照——人可能就在
 *   读完快照、写队列之间按下了「全部重铺」；
 * - 上次动它已经过了 BOT_FOLLOW_RETRY_MS。
 *
 * 整台跳过的两种：
 * - 管家自己还没换到期望版本（`managerPending`）：管家换版会重启自己，赶在那之前铺下去的
 *   席位会被半路掐断，等它换完下一轮心跳再来。调用方要把「换版在报错」排除在外——换不
 *   上去的管家不会重启，不能拿它把 Bot 也一起卡住；
 * - 机器没报过架构：不知道架构就挑不对包，而这里给的是**显式版本**，deploySeat 对显式
 *   版本的架构关只在两边都认得出来时才拦，会放一个错架构的包过去。
 */
export async function queueBotFollow(db: Db, machine: Machine, opts: { managerPending?: boolean; now?: number } = {}): Promise<number> {
  if (!machine.pairedAt || !machine.arch || opts.managerPending) return 0
  if (machine.protocol < MIN_MANAGER_PROTOCOL) return 0
  const target = await desiredBotRelease(db, machine.arch)
  if (!target) return 0
  const now = opts.now ?? Date.now()
  let n = 0
  for (const seat of await db.seatRuntimesOfMachine(machine.id)) {
    // botVersion 为空（老数据、上一次没写上）也算没跟上：它恰恰最可能是旧的。
    if (seat.status !== 'ready' || seat.deployQueued || seat.botVersion === target.version) continue
    if (now - seat.updatedAt < BOT_FOLLOW_RETRY_MS) continue
    const request = { version: target.version, update: true }
    if (await db.queueSeatDeploy(seat.accountId, seat.botId, request, { ifIdle: true })) n++
  }
  if (n) console.log(`satuwork-gateway: 机器 ${machine.id.slice(0, 8)} 有 ${n} 个席位不在 ${target.version} 上，已排队跟版`)
  return n
}

/** 这个进程里是不是已经有一段在推队列。只是省一次白跑，真正防撞车的是库里那两道闸。 */
let queueRunning = false

/**
 * 每一拍顺手推一段队列（maintenanceTick 调它）。**不等**：一段最长几分钟，而那一拍里别的
 * 事都在秒级；等它的话 Debian 上的调度节拍会被拖住，函数形态的 /cron/tick 会撞 maxDuration。
 * 用 afterResponse 挂着：Vercel 上实例撑到它跑完，Debian 上照旧在进程里跑。
 */
export function kickSeatDeployQueue(db: Db): void {
  if (queueRunning) return
  queueRunning = true
  afterResponse(
    '席位部署队列',
    runSeatDeployQueue(db)
      .then((rs) => {
        if (rs.length) console.log(`satuwork-gateway: 部署队列推完 ${rs.length} 个席位`)
      })
      .finally(() => {
        queueRunning = false
      }),
  )
}

/**
 * 批量更新那两条路（按公司、按机器）共用的一段：排队、推一段、等一小会儿、报结局。
 *
 * 等得到的照旧逐个报结局（和以前同步那条路一个样子）；等不到的报 `queued`，界面转去看
 * 席位列表。**不论等没等到，这条请求都在 deployWaitMs 之内回来**，审计一定写得上。
 */
export async function queueSeatUpdates(
  db: Db,
  seats: SeatRuntime[],
  requestOf: (seat: SeatRuntime) => SeatDeployRequest,
  waitMs = deployWaitMs(),
): Promise<{ results: QueuedDeployResult[]; queued: number }> {
  const results: QueuedDeployResult[] = []
  const mine = new Set<string>()
  for (const seat of seats) {
    if (!(await db.account(seat.accountId))) {
      results.push({ accountId: seat.accountId, botId: seat.botId, seatId: seat.seatId, status: seat.status, botVersion: seat.botVersion ?? null, error: '账号不存在' })
      continue
    }
    if (await db.queueSeatDeploy(seat.accountId, seat.botId, requestOf(seat))) mine.add(seat.seatId)
  }
  if (!mine.size) return { results, queued: 0 }
  const done = new Map<string, QueuedDeployResult>()
  const job = runSeatDeployQueue(db, { only: mine, onResult: (r) => done.set(r.seatId, r) })
  afterResponse('批量更新的部署队列', job)
  await within(job, waitMs)
  let queued = 0
  for (const seat of seats) {
    if (!mine.has(seat.seatId)) continue
    const r = done.get(seat.seatId)
    if (r) {
      results.push(r)
      if (r.queued) queued++
      continue
    }
    queued++
    results.push({ accountId: seat.accountId, botId: seat.botId, seatId: seat.seatId, status: seat.status, botVersion: seat.botVersion ?? null, queued: true })
  }
  return { results, queued }
}

/** 失败的那一行：状态标红、写清理由、进度清空。 */
async function failSeat(db: Db, plan: DeployPlan, status: number, message: string): Promise<DeployFailure> {
  const failed = await db.upsertSeatRuntime({
    ...plan.row,
    status: 'error',
    lastError: message,
    updatedAt: Date.now(),
    deployPhase: null,
    deployStartedAt: null,
  })
  return { ok: false, status, error: message, runtime: failed }
}

/** 部署规格里那两个直连字段（见 SeatSpec.botUrl）。不能直连就什么都不加。 */
function directBotPackage(release: BotRelease): Pick<SeatSpec, 'botUrl' | 'botSha256'> {
  const url = directReleaseUrl(release)
  return url ? { botUrl: url, botSha256: release.sha256 } : {}
}

/**
 * 把一批席位从它们所在的机器上拆掉。**删账号和删公司走的是同一条**。
 *
 * 为什么不能只删库里的行：`seat_runtimes` 一没，slot 立刻能被下一个账号分走
 * （`allocateSlot` 就是扫这张表找第一个空号），而机器上那套 systemd 单元还在跑、
 * 还占着同一组端口（3200+N / 6081+N）。下一个人的席位于是起不来，现象是「新员工
 * 的 bot 一直起不来」，谁也不会想到是几个月前删掉的那家公司留下的。
 *
 * 拆不掉就抛，由调用方翻成 502 并劝人先「停用」——那是现成的非破坏性动作，机器
 * 回来之后再删也不迟。硬删下去只会留下一批谁也看不见、还占着端口的席位。
 *
 * 没配对的机器（还没装管家、或者已经注销）跳过：那上面本来就没有我们放上去的东西。
 *
 * **删 Bot 不走这条**，走下面的 purgeBot：那条路上「拆不掉」不该把删除一起否掉。
 */
export async function releaseSeats(db: Db, seats: SeatRuntime[]): Promise<void> {
  const { failed } = await releaseSeatsBestEffort(db, seats)
  if (failed.length) throw new Error(failed[0].error)
}

/** 拆不掉的那些。`error` 已经脱敏，可以原样给人看。 */
export interface SeatReleaseResult {
  released: SeatRuntime[]
  failed: { seat: SeatRuntime; error: string }[]
}

/**
 * 同上，但**逐个记账而不是第一个失败就停**。
 *
 * 删 Bot 走这条：那条路上「拆席位」失败不能把「删 Bot」一起否掉。管家拆席位的顺序
 * 是先停单元再收拾目录，中间任何一步出岔子（单元卡在 stopping、目录不在它该在的
 * 位置、120 秒超时），Bot 都已经聊不了了，而删除每次都以同一个理由失败——那颗 Bot
 * 于是既用不了也删不掉，界面上还一直列着。这是真发生过的现场。
 *
 * 拆不掉的席位由调用方留成墓碑（见 db.orphanSeatRuntime）：行留着，slot 就不会被
 * 下一个人分走，而 Bot 那边该删的全删。
 */
export async function releaseSeatsBestEffort(db: Db, seats: SeatRuntime[]): Promise<SeatReleaseResult> {
  const out: SeatReleaseResult = { released: [], failed: [] }
  // 一台机器查一次，别为同一台机器上的每个席位都去 db.machine() 一趟。
  const machines = new Map<string, Machine | undefined>()
  /**
   * 已经答不上话的机器。**同一台不再逐个席位重试**：管家那一跳等 120 秒，一台躺着
   * 的机器上有十个席位就是二十分钟，而第一次的答案已经够了。
   */
  const dead = new Map<string, string>()
  for (const seat of seats) {
    // 没配对的机器（还没装管家、或者已经注销）跳过：那上面本来就没有我们放上去的
    // 东西，算「拆掉了」。
    if (!seat.machineId) {
      out.released.push(seat)
      continue
    }
    if (!machines.has(seat.machineId)) machines.set(seat.machineId, await db.machine(seat.machineId))
    const machine = machines.get(seat.machineId)
    if (!machinePaired(machine)) {
      out.released.push(seat)
      continue
    }
    const seen = dead.get(seat.machineId)
    if (seen !== undefined) {
      out.failed.push({ seat, error: `席位 ${seat.seatId}：${seen}` })
      continue
    }
    try {
      await managerRemoveSeat(machine, seat.seatId)
      out.released.push(seat)
    } catch (e) {
      const why = `机器拆不掉（${sanitizeError(e, [machine.token])}）。先把它「停用」，等机器恢复后再删除。`
      dead.set(seat.machineId, why)
      out.failed.push({ seat, error: `席位 ${seat.seatId} 所在的${why}` })
    }
  }
  return out
}

/**
 * 删一颗 Bot：**先拆机器上的席位，再把库里跟它有关的东西清干净**。
 *
 * 两件事的成败是分开的。席位拆掉了就连行一起删；拆不掉就把那行留成墓碑（状态
 * 出错、写明原因），slot 因此不会被下一个人分走，而 Bot 本身照删不误——「删了」和
 * 「界面上还列着但聊不了」之间，用户要的永远是前者。
 *
 * 按 botId 查席位、不按公司：全局 Bot 可能被好几家公司各自部署过。
 */
export async function purgeBot(db: Db, botId: string): Promise<SeatReleaseResult> {
  const seats = await db.seatRuntimesOfBot(botId)
  const result = await releaseSeatsBestEffort(db, seats)
  for (const seat of result.released) await db.deleteSeatRuntimeOf(seat.accountId, seat.botId)
  for (const f of result.failed) await db.orphanSeatRuntime(f.seat.accountId, f.seat.botId, f.error)
  await db.deleteBot(botId)
  return result
}
