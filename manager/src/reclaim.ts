import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { run, tryRun } from './run.ts'
import { seatOfPid } from './seat-owner.ts'
import type { SeatRecord } from './seats.ts'

/**
 * 部署之前，把本该属于这个席位的端口要回来。
 *
 * **这个文件存在的理由，是 systemd 停不掉它自己起的那些进程。**
 *
 * `slim-desktop@` 是 `PAMName=login` 起的，Xvfb / x11vnc / websockify 会落进 logind 的
 * session scope；而多屏部署又要求 logind 的 `KillUserProcesses=no`（否则停一块屏会连坐
 * 同一个员工的其它屏）。两条加在一起的后果是：**单元停了，进程还活着**，`systemctl
 * kill` 也够不着——它杀的是单元自己的 cgroup。
 *
 * 于是拆掉一个席位之后，5910 上可能还蹲着那个席位的 x11vnc（它启动时就打开了
 * vnc-passwd，文件被 rm 掉照样服务）。Gateway 那边行一删，槽位立刻分给下一个席位
 * ——`allocateSlot` 扫的是库，看不见机器上还在跑什么。下一次部署撞上同一个口，报
 * 「端口被别人占着」，而那个「别人」是几分钟前刚拆掉的席位。这就是线上那次
 * `exited 43`：占着 5910 的 x11vnc 属于 `sw-…-7bbe43f21941`，一个已经不在名册里的席位。
 *
 * 光靠 deploy-seat.sh 是判不了的：**该不该清，取决于占口的那个席位还在不在名册里**，
 * 而名册在管家手里，脚本没有。所以这一层放在这儿，脚本那边只留最后的自证。
 *
 * 判断分四种，处置完全不同（取舍写在 classifyHolder 上，那儿是唯一的判据）：
 *
 *   · 认不出是哪个席位 → 外面的东西（另一套 VNC、手工起的桌面）。**不动**，报出来给
 *     人看——不是我们放上去的东西，就不该由我们停。
 *   · 名册里没有这个席位 → **孤儿**，清掉（停单元 + 杀逃出去的进程）。
 *   · 名册里有，但这个口不是它现在的口 → 它换槽位之后留下的上一代进程，只杀这一个。
 *   · 名册里有，而且这正是它现在的口 → **也清掉**，并在日志里标成 stale。看着像「两个
 *     活席位撞了槽位、不该在机器上硬清」，但那种事结构上出不来（unique(machineId,
 *     slot)），真出现只说明本机名册比 Gateway 旧了。完整理由见 classifyHolder 末尾那
 *     段——那是这个文件里唯一一处会停掉一个「看起来还活着」的席位的地方。
 */

/** 这个席位该独占的东西。和 gateway/src/deploy.ts 的 portsOf 一一对应。 */
export interface SeatPortSpec {
  seatId: string
  /** X 显示号。**它不占任何 TCP 口**，光看端口看不见它——见 holderOfDisplay。 */
  display: number
  vncPort: number
  novncPort: number
  botPort: number
}

export interface ReclaimReport {
  /** 清掉了什么。写进管家日志——机器上少了什么进程，事后只有这里答得上。 */
  freed: string[]
  /**
   * 被停掉的席位。**调用方要把它们从名册里销号**：留着的话，下一次部署再撞上同一
   * 个口时，classifyHolder 会把一个已经被停掉的席位当成「名册里活着的」，判断依据
   * 就成了一份自己造出来的假象。
   */
  retired: string[]
  /** 不敢清的。这些话会原样变成部署失败的原因，一路送到浏览器上，所以得说人话。 */
  blocked: string[]
}

function cmdlineOf(pid: string): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
  } catch {
    return ''
  }
}

/*
 * 「这个进程属于哪个席位」见 seat-owner.ts 的 seatOfPid。**命令行分不出席位**（`Xvfb :10`、
 * `websockify 127.0.0.1:6081 localhost:5910` 里一个席位标识都没有，同一个员工的多块屏还共用
 * 一个 Linux 账号），**环境变量又是进程自己写的**——以前按 XDG_RUNTIME_DIR 认，别的账号伪造
 * 一条就能让这里把一个活着的席位当孤儿停掉。现在只认 cgroup / logind 会话加 uid。
 */

/** 谁在听这些口。`ss -ltnp` 要 root 才给得出 pid——管家正是以 root 跑的。 */
async function listeners(): Promise<Map<number, string>> {
  const out = await tryRun('ss', ['-ltnp'])
  const map = new Map<number, string>()
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/)
    // State Recv-Q Send-Q Local Peer Process
    if (cols.length < 4 || cols[0] === 'State') continue
    const local = cols[3]
    const port = Number(local.slice(local.lastIndexOf(':') + 1))
    if (!Number.isInteger(port) || port <= 0) continue
    const pid = (/pid=(\d+)/.exec(line) || [])[1]
    if (!pid) continue
    // 同一个口可能出现两行（v4 一行 v6 一行），后面那行是同一个进程，留先到的就行。
    if (!map.has(port)) map.set(port, pid)
  }
  return map
}

/**
 * 名册里这个席位现在占着哪三个口。
 *
 * vncPort 名册里没记，按 slot 反推：slot = botPort - 3200，vncPort = 5910 + slot
 * （和 diag.ts 那处同一个算式，源头都是 gateway/src/deploy.ts 的 portsOf）。
 */
function portsOfSeat(row: SeatRecord): number[] {
  const slot = row.botPort - 3200
  return [row.botPort, row.novncPort, 5910 + slot]
}

/** 同上，显示号：display = 10 + slot。 */
function displayOfSeat(row: SeatRecord): number {
  return 10 + (row.botPort - 3200)
}

/** X 的锁和 socket。**没带席位号**，只能按显示号认——purge-machine.sh 那处同理。 */
function xLockPaths(display: number): string[] {
  return [`/tmp/.X${display}-lock`, `/tmp/.X11-unix/X${display}`]
}

/** 进程的真实 uid（/proc/<pid>/status 的 Uid 第一格）。读不到是 null。 */
function uidOfPid(pid: string): number | null {
  try {
    const m = /^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}

/**
 * 这个进程是不是某个显示号上的 X 服务器，是的话是哪一个（`Xvfb :15 …` → 15）。
 *
 * **只看命令行，不看环境变量**：DISPLAY 是进程自己写的，任何账号都能起一个
 * `DISPLAY=:11 sleep inf` 冒充；而一个显示号的锁只该归真正起在它上面的那个 X 服务器。
 */
export function xDisplayOf(cmdline: string): number | null {
  const m = /^\S*\/?X(?:vfb|vnc|org|wayland|tigervnc)?\s+:(\d+)(?:\s|$)/.exec(cmdline)
  return m ? Number(m[1]) : null
}

/** 锁文件的属主。不在或读不了是 null。lstat：它要是个链接，看的是链接本身。 */
function lockOwner(display: number): number | null {
  try {
    return lstatSync(xLockPaths(display)[0]).uid
  } catch {
    return null
  }
}

/**
 * 删掉一个显示号的锁和 socket。**必须由管家（root）来删。**
 *
 * slim-desktop.sh 里也有一句 `rm -f /tmp/.X$N-lock`，但那是**以席位用户**跑的：
 * /tmp 带 sticky 位，删不掉别人建的文件，`rm -f` 连报错都被 `|| true` 吞了。于是
 * 上一个席位属于另一个员工（另一个 Linux 账号）时，端口清干净了，锁还在——Xvfb 报
 * 「Server is already active for display 10」起不来，桌面单元进重启循环，而部署那边
 * 只会留下一句「30 秒还没起来」的告警，不算失败。**又是一次「装作成功」。**
 */
function dropXLock(display: number): void {
  for (const f of xLockPaths(display)) {
    try {
      rmSync(f, { force: true })
    } catch {}
  }
}

function alive(pid: string): boolean {
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 先 TERM 再 KILL。
 *
 * 直接 KILL 也能腾出端口，但 x11vnc / websockify 收到 TERM 会自己关掉 socket 和
 * X 连接；KILL 之后内核回收虽然也快，中间那一段 TIME_WAIT 和残留的 X lock 会让下
 * 一轮 Xvfb 起得更磕巴。给它 5 秒体面退出，不退再补刀。
 */
async function killPids(pids: string[]): Promise<void> {
  for (const p of pids) {
    try {
      process.kill(Number(p), 'SIGTERM')
    } catch {}
  }
  for (let i = 0; i < 20 && pids.some(alive); i++) await sleep(250)
  for (const p of pids) {
    if (!alive(p)) continue
    try {
      process.kill(Number(p), 'SIGKILL')
    } catch {}
  }
}

/** 这个席位逃出单元的那些进程（以及还在单元里的）。认领的判据见 seat-owner.ts。 */
function pidsOfSeat(seatId: string): string[] {
  const out: string[] = []
  let names: string[]
  try {
    names = readdirSync('/proc')
  } catch {
    return out
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    if (seatOfPid(name) === seatId) out.push(name)
  }
  return out
}

/**
 * 把一个孤儿席位从机器上抹掉。
 *
 * **顺序不能反**：先 disable 单元，再杀进程。反过来的话，`Restart=on-failure` 会在
 * 进程一死的瞬间把它拉起来，端口眨眼又被占上，而日志里看着像「杀了但没杀掉」。
 */
async function retireSeat(seatId: string): Promise<string[]> {
  await run('systemctl', ['disable', '--now', `slim-desktop@${seatId}.service`, `satuwork-bot@${seatId}.service`], {
    timeout: 60_000,
  })
  const pids = pidsOfSeat(seatId)
  // 杀之前先记下它开在哪个显示号上。**杀完就问不出来了**，而那个锁不清掉，下一轮
  // Xvfb 起不来（见 dropXLock）。Xvfb 收到 TERM 通常会自己收拾，但走到 SIGKILL 那
  // 一步就不会了——不能指望它。
  //
  // **显示号只从这个席位自己的 X 服务器上取**（命令行里的 `:N`），不读 DISPLAY 环境变量：
  // 那是进程自己写的，席位用户起一个 `DISPLAY=:11 setsid sleep inf`，拆它的时候 root
  // 就会去删别的员工那块屏的锁和 socket。锁文件的属主也得是这个 X 服务器的用户，对不上的不碰。
  const displays = new Map<number, number | null>()
  for (const pid of pids) {
    const d = xDisplayOf(cmdlineOf(pid))
    if (d !== null) displays.set(d, uidOfPid(pid))
  }
  await killPids(pids)
  for (const [d, uid] of displays) {
    const owner = lockOwner(d)
    if (owner === null || owner === uid) dropXLock(d)
  }
  return pids
}

/** 端口松手了没有。 */
async function waitFree(port: number, timeoutMs = 15_000): Promise<boolean> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const out = await tryRun('ss', ['-ltn'])
    if (!new RegExp(`[:.]${port}\\b`).test(out)) return true
    if (Date.now() >= until) return false
    await sleep(250)
  }
}

/**
 * 占口的这个东西该怎么处置。**判断和动作分开**：判断是这一层全部的取舍所在，而
 * 动作要 root、要 /proc、要真去杀进程——分开之后判断这半边能单独钉住（见
 * manager/e2e-deploy-errors.mjs）。
 */
export type HolderVerdict =
  /** 自己上一轮的残留。交给 slim-desktop.sh 的 kill_stale，这里不抢它的活。 */
  | { action: 'ours' }
  /**
   * 孤儿席位：停单元 + 杀干净。`stale` = 它还挂在本机名册上（名册比 Gateway 旧了），
   * 这一种要在日志里说得更响一点。
   */
  | { action: 'retire-seat'; seatId: string; stale: boolean }
  /** 活席位换槽位之后留下的上一代进程：只杀这一个。 */
  | { action: 'kill-pid'; seatId: string }
  /** 不敢动。reason 会原样变成部署失败的原因，一路送到浏览器上。 */
  | { action: 'blocked'; reason: string }

export function classifyHolder(
  spec: SeatPortSpec,
  roster: SeatRecord[],
  /** 报错和日志里怎么称呼它：「端口 5910（x11vnc）」「显示 :10（Xvfb）」。 */
  where: string,
  /** 名册里这个席位现在正该占着它吗。占的是别的，说明这是它换槽位之前那一代。 */
  ownsHere: (row: SeatRecord) => boolean,
  holder: { pid: string; seatId: string | null; cmd: string },
): HolderVerdict {
  // 自己上一轮留下的：slim-desktop.sh 起来时那段 kill_stale 就是干这个的。在这儿
  // 抢着清没有好处——万一后面 apt 那段失败了，本来还在服务的桌面白死一回。
  if (holder.seatId === spec.seatId) return { action: 'ours' }

  if (!holder.seatId) {
    return {
      action: 'blocked',
      reason:
        `${where}被进程 ${holder.pid} 占着，它不是任何一个 satuwork 席位（${holder.cmd}）` +
        `——这台机器上有别的 VNC/桌面在跑，确认无用后停掉它再重新部署`,
    }
  }

  const row = roster.find((r) => r.seatId === holder.seatId)
  // 名册里有，但它现在该占的不是这个：它换过槽位，这是上一代逃出来的进程。
  // **只杀这一个**——按席位杀会把它现在正在服务的那一套一起带走。
  if (row && !ownsHere(row)) return { action: 'kill-pid', seatId: holder.seatId }

  // 到这里，占着的要么不在名册里（孤儿），要么在名册里、而且占的正是它自己该占的
  // 那一份。**两种都清**，理由是同一条：**槽位归 Gateway 说了算，而 Gateway 刚把这个
  // 槽位给了我们。**
  //
  // 后一种看着像「两个活席位撞了槽位，不该在机器上硬清」，但那种事结构上出不来：
  // `seat_runtimes` 上有 unique(machineId, slot)，Gateway 不可能把同一个槽位同时记
  // 在两行活着的席位上（见 gateway/src/deploy.ts 的 allocateSlot 和它那圈唯一约束
  // 重试）。所以这一格真出现，只有一个解释：**本机名册比 Gateway 旧了**——占口的
  // 那个席位在 Gateway 眼里已经不存在（拆掉了、机器重新配对换了 machineId、或者
  // 那次拆除的回执没送到），只是管家这边没销号。
  //
  // 那能不能保守一点，报个错让人去处理？**不能，那是个死局。** 心跳里不带席位清
  // 单（见 gateway/src/routes/internal.ts 的 heartbeat），Gateway 不知道这个席位存在，
  // 界面上也就没有任何一个按钮能动它；而这台机器没有 SSH——那正是整套设计的前提。
  // 报错的结果是这个槽位从此谁也部署不上，永远。清错的代价是一个席位的桌面断一次、
  // 重新部署一遍就回来；两边不对称得很明显。
  //
  // 清之前留足痕迹：freed 里那句话会进管家日志，谁被停了、为什么停，事后查得到。
  return { action: 'retire-seat', seatId: holder.seatId, stale: Boolean(row) }
}

/**
 * 这个口现在被谁占着。认不出来（或者没人占）就是 null。
 *
 * **每个口现查一次，不能共用一份快照。** 这个模块中间会去停席位、杀进程，机器的
 * 状态在两个口之间就变了：一个孤儿席位同时占着 5910 和 6081（slim-desktop.sh 起的
 * 就是这两个），清掉它之后轮到 6081，快照里那个 pid 已经被自己杀掉了——environ 和
 * cmdline 双双读空，看着和「外面的东西」一模一样，于是把刚清干净的口判成外来占用，
 * 部署照样失败，而报出来的话还是空的。要修的正是这个场景，不能栽在这儿。
 *
 * 同一个坑的小一号版本：ss 那一眼和读 /proc 之间隔着一次系统调用，进程恰好在这中
 * 间退掉，两样也都读空。认不出席位时先确认它真的还在，不在就重查一遍——ss 会告诉
 * 我们这个口已经空了。
 */
async function holderOf(port: number): Promise<{ pid: string; seatId: string | null; cmd: string } | null> {
  for (let i = 0; i < 3; i++) {
    const pid = (await listeners()).get(port)
    if (!pid) return null
    const seatId = seatOfPid(pid)
    if (seatId || alive(pid)) return { pid, seatId, cmd: cmdlineOf(pid).slice(0, 160) }
    await sleep(250)
  }
  // 连着三轮都是「有人占着，但那个 pid 已经不在了」。别据此判定外来占用——那句话
  // 是要报成部署失败的。放过去，deploy-seat.sh 末尾那道自证会兜住真出问题的情况。
  return null
}

/**
 * 显示号被谁占着。**Xvfb 不听任何 TCP 口**，所以上面那套按端口找的办法看不见它。
 *
 * 认领靠 `/tmp/.X<n>-lock`——X 服务器自己写的，里面就是它的 pid。这一格必须查：
 * 上一个席位的 x11vnc 和 websockify 都死了、只剩 Xvfb 活着的时候，三个端口全是空
 * 的，回收什么都不做，而新席位的 Xvfb 照样起不来（display 和端口一样是从 slot 算
 * 出来的，撞的是同一个槽位）。表现是部署「成功」、桌面永远黑着。
 */
async function holderOfDisplay(display: number): Promise<{ pid: string; seatId: string | null; cmd: string } | null> {
  const lock = xLockPaths(display)[0]
  if (!existsSync(lock)) return null
  let pid = ''
  try {
    pid = readFileSync(lock, 'utf8').trim()
  } catch {
    return null
  }
  if (!/^\d+$/.test(pid)) return null
  /**
   * **锁里的 pid 是谁写的都行**——/tmp 世界可写，任何账号都能建一把 `/tmp/.X15-lock`，
   * 里面填别的员工 bot 的 pid（下面就会以「换过槽位的残留」为由由 root 杀掉它），或者填 1
   * （这个槽位从此永远 blocked）。所以这个 pid 必须真是**这个显示号上的 X 服务器**，而且锁
   * 就是它自己建的（属主同一个用户）。对不上就是一把假锁或者旧锁，挡着新的 Xvfb 却没有真
   * 主人——和下面「写锁的进程没了」同一个处理：root 删掉它。
   */
  if (alive(pid) && (xDisplayOf(cmdlineOf(pid)) !== display || lockOwner(display) !== uidOfPid(pid))) {
    dropXLock(display)
    return null
  }
  // 锁在、写锁的进程没了：**这是一把死锁，但它照样挡着新的 Xvfb**（跨用户删不掉，
  // 见 dropXLock）。没有主人可判，也不必判——直接清掉，这正是 slim-desktop.sh 里
  // 那句 rm 想做而做不到的事。
  if (!alive(pid)) {
    dropXLock(display)
    return null
  }
  return { pid, seatId: seatOfPid(pid), cmd: cmdlineOf(pid).slice(0, 160) }
}

export async function reclaimSeatPorts(spec: SeatPortSpec, roster: SeatRecord[]): Promise<ReclaimReport> {
  const report: ReclaimReport = { freed: [], retired: [], blocked: [] }

  /**
   * 一份「本该归这个席位独占的东西」的处置。端口和显示号走的是同一套判断，只是
   * 「谁占着」和「松手了没有」的问法不同。
   */
  const reclaim = async (
    where: string,
    ownsHere: (row: SeatRecord) => boolean,
    resolve: () => Promise<{ pid: string; seatId: string | null; cmd: string } | null>,
    free: () => Promise<boolean>,
  ): Promise<void> => {
    // **现查，不用快照。** 理由见 holderOf——这个函数中间会去停席位、杀进程。
    const holder = await resolve()
    if (!holder) return
    const verdict = classifyHolder(spec, roster, where, ownsHere, holder)
    if (verdict.action === 'ours') return
    if (verdict.action === 'blocked') {
      report.blocked.push(verdict.reason)
      return
    }
    if (verdict.action === 'kill-pid') {
      await killPids([holder.pid])
      report.freed.push(`${where}上是席位 ${verdict.seatId} 换槽位之前留下的进程 ${holder.pid}，已清掉`)
    } else {
      const pids = await retireSeat(verdict.seatId)
      report.freed.push(
        verdict.stale
          ? `${where}被席位 ${verdict.seatId} 占着，它还挂在本机名册上，` +
            `但 Gateway 把这个槽位给了 ${spec.seatId}——以 Gateway 为准，已停掉它的单元并清掉 ${pids.length} 个进程。` +
            `若这个席位其实还该在跑，重新部署它一次即可`
          : `${where}被已经不在名册里的席位 ${verdict.seatId} 占着（单元停了、进程没死），` +
            `已停掉它的单元并清掉 ${pids.length} 个进程`,
      )
      report.retired.push(verdict.seatId)
    }
    if (!(await free())) {
      report.blocked.push(`${where}清过之后 15 秒还没松手，先别继续部署——再来一次多半就好了`)
    }
  }

  // **先显示号，后端口。** Xvfb 是这一套的根：清掉它会顺带带走挂在它上面的 x11vnc
  // 和 picom/plank，后面几个口多半就已经空了。反过来先清端口的话，同一个孤儿席位
  // 要被 retireSeat 停两回。
  await reclaim(
    `显示 :${spec.display}（Xvfb）`,
    (row) => displayOfSeat(row) === spec.display,
    () => holderOfDisplay(spec.display),
    async () => {
      const h = await holderOfDisplay(spec.display)
      return h === null
    },
  )

  const ports: [number, string][] = [
    [spec.vncPort, 'x11vnc'],
    [spec.novncPort, 'websockify'],
    [spec.botPort, 'bot'],
  ]
  for (const [port, what] of ports) {
    await reclaim(
      `端口 ${port}（${what}）`,
      (row) => portsOfSeat(row).includes(port),
      () => holderOf(port),
      () => waitFree(port),
    )
  }
  return report
}
