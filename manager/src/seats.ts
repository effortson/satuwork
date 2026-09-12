import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { bootConfig, seatAssets, seatsPath } from './config.ts'
import { reclaimSeatPorts } from './reclaim.ts'
import { ensureRelease, releaseDir } from './releases.ts'
import { run, tailError } from './run.ts'

/** Gateway 下发的席位规格。字段名和 gateway/src/deploy.ts 那边一一对应。 */
export interface SeatSpec {
  seatId: string
  linuxUser: string
  homeDir: string
  workDir: string
  seatDir: string
  botId: string
  botVersion: string
  vncPassword: string
  gatewayUrl: string
  gatewayToken: string
  gatewayApiKey: string
  ports: { display: number; vncPort: number; novncPort: number; botPort: number; cdpPort: number }
  /**
   * 现在就重铺，**跳过换版前的排空**（见 drainSeat）。
   *
   * 只有人手工按的「重新部署」带它：那条路上要修的往往正是一个卡住的席位，「它在忙」
   * 恰恰是要清掉的病症，拿排空把唯一的自助修复手段挡在门外就本末倒置了。
   *
   * **和 Gateway 那个 `force` 不是一回事**，所以名字也不一样：那边的 force 是「已经
   * 是这个版本也照铺」，用来穿过 deploy.ts 里那道跳过的门——模版下发也带着它，而那条
   * 路是该等的。两件事共用一个字段，模版一改就会把所有人的会话打断。
   */
  interrupt?: boolean
  /**
   * 这次最多排空多久，毫秒。**调用方的请求预算，由它自己算**（见 gateway 的
   * deploySeat）。
   *
   * 必须有这个字段，因为这一跳是同步的：调用方拿着自己的超时在等，而排空是在这一头
   * 花时间。两个数各定各的，就会出现「等到一半被对面的超时掐断」——那时候机器上什么
   * 都没坏，库里却记下一条「联系不上机器管家」，而这边照样把席位重铺了。模版「立即
   * 下发」那条路（单席位 90 秒）撞的正是这个。
   *
   * 和本机的上限取**小**：预算是调用方的事，上限是这台机器的事，谁更紧听谁的。
   */
  drainMs?: number
}

export interface SeatRecord {
  seatId: string
  linuxUser: string
  seatDir: string
  botId: string
  botVersion: string
  botPort: number
  novncPort: number
  deployedAt: number
  status: 'ready' | 'error'
  lastError: string | null
  /**
   * 这个席位的席位票（`sat_`），也就是写进 bot.env 的那一把。
   *
   * 留一份在名册里，是给 `/seats/:id/stream/*` 用的：浏览器直连过来带的是登录 JWT，
   * bot 只认 `sat_`，管家得替它换。名册文件本来就是 0600、root 的，和 bot.env 同一个
   * 信任面。**不往外报**：`seatsWithLiveness` 出去之前摘掉。
   *
   * 可选，因为 5 号协议之前部署的席位没有它——那些席位在重新部署之前直连回 409，
   * 前端会退回 Gateway 反代。
   */
  gatewayToken?: string
}

type Registry = Record<string, SeatRecord>

function load(): Registry {
  try {
    const raw = JSON.parse(readFileSync(seatsPath(), 'utf8')) as Registry
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function save(reg: Registry): void {
  const path = seatsPath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

/**
 * 就地改名册：**读、改、写之间一个 `await` 都不许有**。
 *
 * 名册是整份读进来、整份写回去的。以前 `doDeploy` 在函数开头 `load()` 一次，然后跨过
 * 排空（最多 2 分钟）、拉发布包、以及 15 分钟的 `deploy-seat.sh`，最后拿那份快照
 * `save()`——中间这段时间里别人对名册做的任何改动都会被这一下**整份覆盖回去**。而并发
 * 是这里明写的设计（`inFlight` 是计数器不是布尔），所以它不是理论问题：
 *
 *  - 部署 A 的过程中 `DELETE /seats/B` 把 B 删了 → A 收尾时把 B 又写了回去，名册上于是
 *    挂着一个机器上早就不存在的席位；
 *  - 并发部署 A 和 B，两边各自快照了一份「没有对方」的名册 → 后收尾的那个把先收尾的
 *    那条抹掉。
 *
 * 抹掉一条不只是少一行：`seats()` 不再报它（心跳和 `/health` 里看不见）、`removeSeat`
 * 对它成了空操作，而 `reclaimSeatPorts` 是拿 `Object.values(reg)` 判「这个口上蹲着的是
 * 谁」的——名册里没有它，它那套还在跑的 display / VNC / bot 口就会被下一次部署当成孤儿
 * 杀掉。
 *
 * Node 是单线程的，所以只要这三步之间不让出事件循环，它就是原子的。`mutate` 返回
 * `false` 表示什么都没改，不必白写一次盘。
 */
function update(mutate: (reg: Registry) => boolean | void): void {
  const reg = load()
  if (mutate(reg) === false) return
  save(reg)
}

/** 把一行落进名册并返回它。`doDeploy` 的每一个出口都走这条。 */
function commit(seatId: string, row: SeatRecord): SeatRecord {
  update((reg) => {
    reg[seatId] = row
  })
  return row
}

export function seats(): SeatRecord[] {
  return Object.values(load()).sort((a, b) => a.seatId.localeCompare(b.seatId))
}

export function seat(seatId: string): SeatRecord | undefined {
  return load()[seatId]
}

/**
 * 部署期间不许自升级换版：换版会重启进程，把跑到一半的 `deploy-seat.sh` 连同它建了
 * 一半的席位一起打断。计数而不是布尔，因为可以有并发的多个部署。
 */
let inFlight = 0
export const busy = () => inFlight > 0

/**
 * 等手上的部署都跑完，最多等 `maxMs`。给 shutdown 用：进程半路退出会把 deploy-seat.sh
 * 建了一半的席位连同那条挂着的 PUT 一起打断。**定时器不 unref**——server 已经 close
 * 了，要是这条也不占着事件循环，Node 可能在部署结束前就自己退出去。
 */
export function waitForDeploys(maxMs: number): Promise<void> {
  const started = Date.now()
  return new Promise((resolve) => {
    const tick = () => {
      if (inFlight === 0 || Date.now() - started >= maxMs) resolve()
      else setTimeout(tick, 1000)
    }
    tick()
  })
}

/**
 * 席位正忙，这次没换版。
 *
 * **不是部署失败**，所以不写进名册、也不碰机器上的任何东西：席位还是原来那个版本，
 * 好端端地在跑。调用方（PUT /seats/:id）把它翻成 409，Gateway 据此保留原来的状态，
 * 界面上说的是「有会话在跑，这次没换」，不是一行红字。
 */
export class SeatBusy extends Error {
  constructor(
    readonly seatId: string,
    readonly running: number,
    readonly queued: number,
    readonly waitedMs: number,
  ) {
    super(
      `席位 ${seatId} 有会话在跑（${running} 轮在跑、${queued} 条排着），等了 ${Math.round(waitedMs / 1000)} 秒仍没结束，这次没有换版`,
    )
    this.name = 'SeatBusy'
  }
}

/**
 * 这台机器允许的排空上限。默认 2 分钟，`SATUWORK_SEAT_DRAIN_MS` 可调。
 *
 * 上限存在的理由是这一跳是**同步的**：Gateway 那条 PUT 一直挂着，批量重铺还要逐个
 * 席位串下去。等不到就明说「这次没换」，让人晚点再来——比把一条请求吊上十分钟、
 * 或者干脆把人的活打断都强。
 *
 * **`0` 的意思是「一次都不等」，不是「关掉排空」**：席位忙照样回 409（drainSeat 会
 * 先问一次再决定）。想要「别管忙不忙，现在就重铺」，走的是另一条路——`interrupt`，
 * 也就是界面上那颗「重新部署」。两件事分开是有意的：一个是「愿不愿意等」，一个是
 * 「愿不愿意打断」，混成一个数就没法既不等又不打断（模版下发要的恰恰是这一种）。
 */
function machineDrainCapMs(): number {
  const raw = Number(process.env.SATUWORK_SEAT_DRAIN_MS)
  return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 120_000
}

/** 这次排空的实际窗口：调用方的预算和本机的上限，谁小听谁的。 */
function drainWindowMs(spec: SeatSpec): number {
  const cap = machineDrainCapMs()
  const asked = Number(spec.drainMs)
  return Number.isFinite(asked) && asked >= 0 ? Math.min(cap, Math.trunc(asked)) : cap
}

const DRAIN_POLL_MS = 3000

/**
 * 这个席位此刻在忙吗。忙就给出计数，**不忙、答不上来、老版本不报，一律回 null**。
 *
 * 三者归一是有意的：它们对调用方是同一个决定（往下走）。分开的话，一次探活超时就能
 * 把换版永远挡住——而「拦住换版」需要的是**确凿的忙**，不是「没问出来」。
 */
export async function seatBusyNow(botPort: number, timeoutMs = 2500): Promise<{ running: number; queued: number } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${botPort}/api/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const body = (await res.json()) as { busy?: unknown; running?: unknown; queued?: unknown }
    // 老席位的 /api/health 只回 {ok:true}——没有这个字段就是「问不出来」。
    if (typeof body?.busy !== 'boolean') return null
    if (!body.busy) return null
    return { running: Number(body.running) || 0, queued: Number(body.queued) || 0 }
  } catch {
    return null
  }
}

/**
 * 换版静默：让席位**这几秒不开新的一轮**（`ttlMs: 0` = 放开）。
 *
 * 排空只等「手上这一轮跑完」是不够的——等到空闲之后，到真正 `systemctl restart` 之间
 * 还隔着拉包、解包、rsync 那几秒，人在那几秒里发一句照样被拦腰砍断，而排空看上去明明
 * 成功了。先落这道闸，那个窗口才是真的关上的。
 *
 * 要票：`/api/quiesce` 在 `/api/*` 守卫后面（只有 `/api/health` 是公开的）。席位票就在
 * 部署规格里（`spec.gatewayToken`，也就是写进 bot.env 的那一把）。
 *
 * **答不上来一律当「这版席位不认这条路」放行**：老席位没有这个接口（404），而为了一个
 * 增强去把换版整个卡死是本末倒置——那样只是退回到没有静默的老样子。
 */
async function setQuiesce(botPort: number, token: string, ttlMs: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${botPort}/api/quiesce`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: token ? `Bearer ${token}` : '' },
      body: JSON.stringify({ ttlMs }),
      signal: AbortSignal.timeout(2500),
    })
    if (!res.ok) return false
    const body = (await res.json()) as { quiesced?: unknown }
    // 认它自报的状态，不认 200：落闸和放开走的是同一条路，只有「它说的和我要的一致」
    // 才算数。老席位没有这条路（404），走不到这里。
    const want = ttlMs > 0
    return typeof body?.quiesced === 'boolean' && body.quiesced === want
  } catch {
    return false
  }
}

/**
 * 静默期的长度。
 *
 * 要盖住「等这一轮跑完 + 真的把新版本铺上去」，又不能长到「管家半路挂了，这台席位
 * 好几十分钟不接活」。席位那头还会再夹一次（AgentService.QUIET_MAX_MS，5 分钟）。
 *
 * 正常路径上它根本不会走到期：进程被 systemctl 换掉，这个标记随内存一起没了。
 */
const QUIET_TTL_MS = 4 * 60_000

/** 已经落了闸、还没放开的席位。部署结束时兜底放开（见 deploySeat 的 finally）。 */
const quieted = new Map<string, { botPort: number; token: string }>()

/** 这台机器上还有哪些席位在跑会话。管家自升级要看它（见 upgrade.ts）。 */
export async function busySeats(): Promise<{ seatId: string; running: number; queued: number }[]> {
  const rows = seats()
  const out = await Promise.all(
    rows.map(async (r) => {
      const b = await seatBusyNow(r.botPort)
      return b ? { seatId: r.seatId, ...b } : null
    }),
  )
  return out.filter((x): x is { seatId: string; running: number; queued: number } => Boolean(x))
}

/**
 * 换版前排空：等这个席位手上的活跑完。
 *
 * 部署一个已经在跑的席位 = `systemctl restart satuwork-bot@<seat>`，正跑着的那一轮
 * 当场没命：日志里那条 turn/end 根本没写成（要等下一次读盘由 healDanglingTurn 补），
 * 用过的 token 照样计费，而人正对着屏幕等回答。换版本身没有任何理由非得踩在这一刻。
 *
 * 「忙」只认在跑的轮次，不认排着的消息——理由在 bot 那侧的 agents.busy 上写着。
 */
async function drainSeat(spec: SeatSpec, current: SeatRecord): Promise<void> {
  /**
   * **探的是它现在听在哪儿，不是这次 spec 要它听哪儿。**
   *
   * 两者通常相同（Gateway 的 allocateSlot 首选原槽位），但撞上 unique 冲突时会重扫一
   * 个新槽位——那时 spec.ports.botPort 上蹲着的是**另一个席位**。拿它去问，答的是别人
   * 忙不忙：那个忙就白等一场再把本可以做的换版拒掉，那个闲就正好在本席位跑到一半时
   * 把它重启，而那正是这段代码要拦的事。
   */
  const port = current.botPort || spec.ports.botPort
  const hold = drainWindowMs(spec)
  const started = Date.now()
  /**
   * **先落闸，再等。** 顺序反过来就等于没落：等到空闲那一刻放行，紧接着人发一句、
   * 新一轮开起来，而我们已经在往下走了。落了闸之后「空闲」才是个能保住的状态。
   *
   * 落不上（老席位没这条路、票不对、超时）就照旧往下走——那只是退回到没有静默的老
   * 样子，不该因此把换版整个卡住。
   */
  if (await setQuiesce(port, spec.gatewayToken, QUIET_TTL_MS)) {
    quieted.set(spec.seatId, { botPort: port, token: spec.gatewayToken })
    console.log(`satuwork-manager: 席位 ${spec.seatId} 已进入换版静默，不再开新的一轮`)
  }
  let hit = await seatBusyNow(port)
  if (!hit) return
  // 窗口为 0 就是「一次都不等」：上面已经问过一次，忙就到此为止。
  if (hold > 0) {
    console.log(
      `satuwork-manager: 席位 ${spec.seatId} 在跑 ${hit.running} 轮、排着 ${hit.queued} 条，等它跑完再换版（最多 ${Math.round(hold / 1000)} 秒）`,
    )
    const deadline = started + hold
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, Math.min(DRAIN_POLL_MS, Math.max(0, deadline - Date.now()))))
      hit = await seatBusyNow(port)
      if (!hit) {
        console.log(`satuwork-manager: 席位 ${spec.seatId} 空下来了，开始换版（等了 ${Math.round((Date.now() - started) / 1000)} 秒）`)
        return
      }
    }
  }
  throw new SeatBusy(spec.seatId, hit.running, hit.queued, Date.now() - started)
}

/**
 * 同一个席位上的动作排队走。**部署和拆除都要排。**
 *
 * `update()` 只保证名册那一行的读改写是原子的，可这两件事真正动的是 systemd 单元和
 * 磁盘：`remove-seat.sh` 停单元、`rm -rf` 席位目录，一跑最多 120 秒；同一个 seatId 的
 * `PUT /seats/:id` 要是落在这中间，`deploy-seat.sh` 会把同一套路径和单元重新建起来，
 * 两边你拆我建，最后 systemd、磁盘、名册三份状态各说各的。
 *
 * 不同席位互不相干，照旧并发——这也是 inFlight 那个计数器还留着的原因。
 */
const seatLocks = new Map<string, Promise<unknown>>()

async function withSeatLock<T>(seatId: string, fn: () => Promise<T>): Promise<T> {
  const prev = seatLocks.get(seatId) ?? Promise.resolve()
  // 前一个失败了不该把后面的一起带倒，所以只等它「结束」，不管成败。
  const task = prev.then(fn, fn)
  // 队尾记的是「结束与否」，不带结果也不带异常——它只用来排队。
  const tail = task.then(
    () => {},
    () => {},
  )
  seatLocks.set(seatId, tail)
  void tail.then(() => {
    // 自己还是队尾时才清，否则会把后来者的那一把一起摘掉，锁就形同虚设。
    if (seatLocks.get(seatId) === tail) seatLocks.delete(seatId)
  })
  return task
}

export async function deploySeat(spec: SeatSpec, token: string): Promise<SeatRecord> {
  inFlight += 1
  try {
    return await withSeatLock(spec.seatId, () => doDeploy(spec, token))
  } finally {
    inFlight -= 1
    /**
     * 进度只在装的这段时间里有意义，**每一条出口都要清**（成功、脚本失败、排空等不到、
     * 抛异常）。留着的话下一个来问进度的人会拿到一句「正在装浏览器」，而机器上早就
     * 什么都没在跑了——而问进度的恰恰是那个盯着屏幕等的人。
     */
    progress.delete(spec.seatId)
    /**
     * 把静默放开。**每一条出口都要走到这里**：拉包失败、端口收不回来、脚本非零退出、
     * 排空等不到（SeatBusy 那一支是抛出去的），这些都停在了重启之前——闸还落着，而那台
     * 席位这会儿好端端的，不该白白几分钟不接活。
     *
     * 成功那一条上进程已经被换掉了，这一下打在**新起来的**那个进程上，是个无害的
     * no-op（它本来就没有落闸）；单元正在重启、连不上也不要紧，席位那头的 TTL 兜着。
     */
    const mark = quieted.get(spec.seatId)
    if (mark) {
      quieted.delete(spec.seatId)
      await setQuiesce(mark.botPort, mark.token, 0)
    }
  }
}

/**
 * 把回收时停掉的席位从名册里销号。改动过返回 true，调用方据此决定要不要落盘。
 *
 * **留着它们是会骗人的。** 下一次部署撞上同一个口时，classifyHolder 拿名册判「占口
 * 的那个席位还活着吗」——名册里还挂着一个已经被自己停掉的席位，判断依据就成了一份
 * 自己造出来的假象，处置会从「孤儿，清掉」滑到「名册里活着的席位」那一格。
 *
 * 逐个判在不在，不是照着 retired 数一数就落盘：回收清掉的**多半是名册里本来就没有
 * 的孤儿**（那正是这条路最常见的入口），那种情况一个字都没改，不该白写一次盘。
 */
export function pruneRetired(reg: Record<string, SeatRecord>, retired: string[]): boolean {
  let changed = false
  for (const id of retired) {
    if (!(id in reg)) continue
    delete reg[id]
    changed = true
  }
  return changed
}

/**
 * 一个正在装的席位这会儿走到哪一步了。
 *
 * **只在内存里，装完就没**：它每几秒变一次，而且过期之后一文不值——落盘只会把席位
 * 名册变成一张高频写的表，还得多一份「进程重启之后这行是不是假的」的判断。管家重启
 * 时正在跑的那次部署本来也一起没了（见 upgrade.ts 的 busy 门），进度跟着消失是对的。
 *
 * `label` 是脚本自己报的中文短句，管家一个字都不解释——加一步、改一句话只动脚本，
 * 不必两处一起改（见 deploy-seat.sh 的 step）。
 */
export interface SeatProgress {
  step: number
  total: number
  label: string
  /** 这一步是什么时候开始的。界面上「这一步已经跑了多久」靠它。 */
  at: number
}

const progress = new Map<string, SeatProgress>()

/** deploy-seat.sh 里「启动桌面与 Bot」是第几步。从这一步起两个单元已经按新端口在跑了。 */
const RESTART_STEP = 6

/** `@@step 3/7 安装浏览器` → 结构化的一步。不是这个形状的一律回 null。 */
export function stepOf(line: string): Omit<SeatProgress, 'at'> | null {
  const m = /^@@step (\d+)\/(\d+) (.+)$/.exec(line.trim())
  if (!m) return null
  const step = Number(m[1])
  const total = Number(m[2])
  if (!Number.isFinite(step) || !Number.isFinite(total) || total <= 0 || step <= 0 || step > total) return null
  return { step, total, label: m[3].slice(0, 80) }
}

/** 这个席位此刻的安装进度。没在装（或者这台管家没收到过一行 `@@step`）回 undefined。 */
export function seatProgress(seatId: string): SeatProgress | undefined {
  return progress.get(seatId)
}

async function doDeploy(spec: SeatSpec, token: string): Promise<SeatRecord> {
  /**
   * 先等这个席位手上的活跑完，再动它。
   *
   * **只对已经在册的席位**：全新席位没什么可打断的，名册里没有它、端口上也没人。
   * 手工「重新部署」那条路也不等（见 SeatSpec.interrupt）。
   *
   * 排在最前面，而不是紧挨着 `systemctl restart`：这之后的每一步——拉发布包、回收
   * 端口、rsync 一份 app——都已经在动这个席位的东西了，等到那时候再来问「你忙不忙」，
   * 该问的时刻早就过去了。dryRun 下同样跑：它是这条逻辑唯一验得到的地方（e2e 里
   * 没有 systemd，见 e2e/manager.mjs）。
   *
   * 这里读的是**这一刻**的名册，读完就丢——整个函数不再持有任何跨 await 的快照，
   * 每一处要改名册的地方都现读现写（见 update 的注释）。
   */
  const current = load()[spec.seatId]
  if (current && !spec.interrupt) await drainSeat(spec, current)
  const base: SeatRecord = {
    seatId: spec.seatId,
    linuxUser: spec.linuxUser,
    seatDir: spec.seatDir,
    botId: spec.botId,
    botVersion: spec.botVersion,
    botPort: spec.ports.botPort,
    novncPort: spec.ports.novncPort,
    deployedAt: Date.now(),
    status: 'ready',
    lastError: null,
    gatewayToken: spec.gatewayToken,
  }

  if (bootConfig().dryRun) return commit(spec.seatId, base)

  /**
   * 失败时名册上写哪一对端口，看脚本**跑到了第几步**。
   *
   * 第 6 步之前失败：机器上还在服务的（如果有）是上一轮部署的那套进程，它们听的是
   * 旧端口，名册**保留原来那一对**；换成 spec 里的新端口的话，反代和 busySeats 就会去
   * 敲一个没人听的口——席位明明还活着，界面上却成了「失联」。
   *
   * 第 6 步（启动桌面与 Bot）已经把两个单元按**新**端口 restart 过了，之后再失败
   * （第 7 步自证不过、exit 43）机器上听的就是新端口，这时反而要写 spec 里的那对，
   * 不然名册指着一对已经没人听的旧口。步数由脚本的 `@@step` 行报上来（见 stepOf）。
   *
   * 现读：这一行之前隔着排空和拉包两段等待，开头那份 current 可能已经旧了。
   */
  let stepReached = 0
  const fail = (message: string): SeatRecord => {
    const was = load()[spec.seatId]
    const keepOld = was && stepReached < RESTART_STEP
    return commit(spec.seatId, {
      ...base,
      ...(keepOld ? { botPort: was.botPort, novncPort: was.novncPort } : {}),
      status: 'error',
      lastError: message.slice(0, 500),
    })
  }

  try {
    await ensureRelease(spec.botVersion, { gatewayUrl: spec.gatewayUrl, token })
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }

  // ── 先把这三个口要回来 ──────────────────────────────────────────────
  // 单元停了、进程没死是这一层的常态（logind session scope + KillUserProcesses=no，
  // 见 reclaim.ts）。上一个席位拆掉之后留下的 x11vnc 会一直蹲在 5910 上，而 Gateway
  // 那边行一删槽位就分给了下一个人——不先清，这次部署必然撞在同一个口上。
  //
  // 该不该清只有管家判得了：脚本手里没有名册。清不动的当场失败，理由说清楚——比
  // 让 deploy-seat.sh 干等 30 秒再报一句「被别人占着」有用得多。
  const reclaimed = await reclaimSeatPorts(
    {
      seatId: spec.seatId,
      display: spec.ports.display,
      vncPort: spec.ports.vncPort,
      novncPort: spec.ports.novncPort,
      botPort: spec.ports.botPort,
    },
    // 现读：判「这个口上蹲着的是不是一个还活着的席位」要用**此刻**的名册，
    // 而这一行之前已经隔着排空和拉包两段等待了。
    Object.values(load()),
  )
  for (const line of reclaimed.freed) console.log(`satuwork-manager: 席位 ${spec.seatId} 部署前回收端口：${line}`)
  update((reg) => pruneRetired(reg, reclaimed.retired))
  if (reclaimed.blocked.length) return fail(reclaimed.blocked.join('；'))

  const r = await run('bash', [join(seatAssets(), 'deploy-seat.sh')], {
    timeout: 900_000,
    onLine: (line) => {
      const hit = stepOf(line)
      if (!hit) return
      stepReached = hit.step
      progress.set(spec.seatId, { ...hit, at: Date.now() })
    },
    env: {
      LINUX_USER: spec.linuxUser,
      SEAT_ID: spec.seatId,
      HOME_DIR: spec.homeDir,
      WORK_DIR: spec.workDir,
      SEAT_DIR: spec.seatDir,
      DISPLAY_NUM: String(spec.ports.display),
      RFB: String(spec.ports.vncPort),
      HTTP: String(spec.ports.novncPort),
      BOT_PORT: String(spec.ports.botPort),
      CDP: String(spec.ports.cdpPort),
      BOT_VERSION: spec.botVersion,
      BOT_EXTRACT: releaseDir(spec.botVersion),
      SEAT_ASSETS: seatAssets(),
      VNC_PASSWORD: spec.vncPassword,
      GATEWAY_URL: spec.gatewayUrl,
      GATEWAY_TOKEN: spec.gatewayToken,
      GATEWAY_API_KEY: spec.gatewayApiKey,
      // 协议 10：Bot 调模型不再直打 Gateway 的 /v1，而是打管家在回环地址上的 /llm/v1/*
      // （src/llm-relay.ts）。管家默认听 0.0.0.0，回环这一面总在。**SATUWORK_MANAGER_HOST
      // 钉成某一张网卡的地址就断了这条路**（Node 只绑那一个地址，127.0.0.1 不答）——
      // 真要钉网卡就得连管家一起改成多监听，目前没有这样的机器。端口用启动参数那一个：
      // selftest 那种临时起在 :0 的进程不会走到部署这里。
      MANAGER_LLM_URL: `http://127.0.0.1:${bootConfig().port}/llm`,
      // **机器票不进席位环境。** 它是管家自己的控制面凭据（PUT /seats/:id 认的就是
      // 它），而 bot.env 属于席位那个普通 Linux 用户。bot 上报 /internal/* 用席位票
      // （GATEWAY_TOKEN）就够了。`token` 在这个函数里只用于向 Gateway 拉发布包。
      SATUWORK_BOT_ID: spec.botId,
    },
  })
  if (r.code !== 0) return fail(tailError(r, `deploy script exited ${r.code}`))

  return commit(spec.seatId, base)
}

/**
 * 拆一个席位。**非零退出只有一个含义：单元还活着**（见 remove-seat.sh 的结尾）。
 *
 * 分得这么细，是因为 Gateway 那边拿这个结果决定「这颗 Bot 能不能删」。删目录、删
 * drop-in 失败只是留了点垃圾，据此报错的代价是那颗 Bot 既聊不了也删不掉；而单元
 * 没停，端口就还占着，槽位让出去下一个人的席位就起不来——只有后者值得拦。
 *
 * 脚本的警告（跳过的目录、没删掉的 drop-in）走 stderr，成功时也写进 journal：
 * 机器上留了什么垃圾，事后只有这里答得上。
 */
export async function removeSeat(seatId: string): Promise<void> {
  return withSeatLock(seatId, () => doRemoveSeat(seatId))
}

async function doRemoveSeat(seatId: string): Promise<void> {
  progress.delete(seatId)
  const row = seat(seatId)
  if (!row) return
  if (!bootConfig().dryRun) {
    const r = await run('bash', [join(seatAssets(), 'remove-seat.sh')], {
      timeout: 120_000,
      env: { LINUX_USER: row.linuxUser, SEAT_ID: seatId, SEAT_DIR: row.seatDir },
    })
    if (r.code !== 0) throw new Error(tailError(r, `remove script exited ${r.code}`))
    const warnings = r.stderr.trim()
    if (warnings) console.warn(`satuwork-manager: 席位 ${seatId} 拆掉了，但有告警：${warnings.slice(-400)}`)
  }
  // 销号在**脚本跑完之后**现读现写。拿函数开头那份快照删，会把这 120 秒里别的部署
  // 刚写下的行一起抹掉（同 doDeploy，见 update 的注释）。
  update((reg) => {
    if (!(seatId in reg)) return false
    delete reg[seatId]
  })
}

/** systemd 眼里这个席位活着吗。心跳带上它，Gateway 才知道「部署过」之外还「在跑」。 */
export async function unitActive(seatId: string): Promise<boolean> {
  if (bootConfig().dryRun) return true
  const r = await run('systemctl', ['is-active', '--quiet', `satuwork-bot@${seatId}.service`], { timeout: 10_000 })
  return r.code === 0
}

export async function seatsWithLiveness(): Promise<(Omit<SeatRecord, 'gatewayToken'> & { active: boolean })[]> {
  const rows = seats()
  // 席位票不出这个进程：它只为 stream 那条路换票用（见 SeatRecord.gatewayToken）。
  return Promise.all(rows.map(async ({ gatewayToken: _token, ...r }) => ({ ...r, active: await unitActive(r.seatId) })))
}
