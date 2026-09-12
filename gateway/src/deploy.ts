import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { canonicalTimezone, isUniqueViolation, releaseArch, type Account, type BotRelease, type Db, type Machine, type SeatRuntime } from './db.ts'
import { signLogsTicket, type JwtKeys } from './crypto.ts'
import { HttpError } from './http.ts'
import { botReleaseFile } from './releases.ts'

/** 管家握手协议。低于这个数的机器不给下发部署——字段对不上会失败得很难看。 */
export const MIN_MANAGER_PROTOCOL = 1

/**
 * 桌面反代要求的管家协议。**和 MIN_MANAGER_PROTOCOL 分开**：管家旧一点，部署、聊天、
 * 日志都还照常能用，只有「从 Gateway 同域看桌面」这一件事做不了。把总门槛抬到 2
 * 会把那些功能一起停掉，代价远大于收益。
 */
export const MIN_DESKTOP_PROTOCOL = 2

/**
 * 直连桌面要求的管家协议号。
 *
 * 4 号管家才会在浏览器直连那条路上给落地页插「关掉 noVNC 控制条」的样式、并钉
 * `frame-ancestors`。以前走 Gateway 反代时这两件事是 Gateway 做的，反代删了之后只有
 * 管家自己能做。
 *
 * **所以填了 directUrl 还不够，管家也得够新**：不够就没有桌面（novncUrlOf 给空）。
 * 少了这道闸，表现是同一块预览在有的机器上多出一条控件压着画面，而配置里看不出
 * 任何区别。
 */
export const MIN_DIRECT_DESKTOP_PROTOCOL = 4

/**
 * 对话流直连要求的管家协议号。
 *
 * 5 号管家才有 `/seats/:id/stream/*`：认浏览器的登录 JWT、换成席位票、对 Gateway 的源开
 * CORS。低于它的机器上这条路是 404，所以**不给前端直连地址**（`streamUrl` 为 null）——
 * 而 Gateway 那条 `/runtime/sessions/:id/events` 反代已经删了，没有直连地址就没有对话流。
 *
 * 这是 Gateway 从对话热路径上退下来的那一步（见 docs/adr-gateway-vercel-neon.md §7）。
 */
export const MIN_DIRECT_STREAM_PROTOCOL = 5

/**
 * 名单流直连要求的管家协议号。6 号管家才有 `/roster/stream`（manager/src/roster.ts）。
 * 低于它的机器 `rosterStreamUrl` 为 null，名单就没有实时通道——Gateway 不再扇入。
 */
export const MIN_DIRECT_ROSTER_PROTOCOL = 6

/**
 * 席位工人接管日常任务要求的管家协议号。
 *
 * ≥7 号的机器上有工人在领任务（`GET /worker/routines/due`），Gateway 的调度器**不再碰**
 * 这些机器上的任务——碰了就是两边各跑一遍。低于它的机器 Gateway **也不自己跑**：到点记一条
 * 「管家太旧」的 error、试跑直接 409（routines.ts 的 ownerOf）。以前低于它的由 Gateway 自己
 * 发消息、等结果，那条路在 Vercel 上走不通，收掉了。见 docs/adr-gateway-vercel-neon.md §7 第 4 步。
 */
export const MIN_WORKER_PROTOCOL = 7

/**
 * 席位工人接管**渠道那一轮**要求的管家协议号。和日常任务分开一个号：8 号工人才有渠道循环
 * （manager/src/worker/channels.ts），7 号机器上渠道消息仍由 Gateway 自己跑一轮。
 * 分流规则同 MIN_WORKER_PROTOCOL，见 channels.ts 的 workerOwnedBinding。
 */
export const MIN_CHANNEL_WORKER_PROTOCOL = 8

/**
 * 日志跟随直连要求的管家协议号。
 *
 * 9 号管家的 `/logs` 和 `/seats/:id/logs` 才认 `Authorization: Bearer` 里那张 Gateway 签的
 * **日志票**（crypto.ts 的 signLogsTicket）；老管家只认机器票，而机器票是管家的 root 控制面
 * 凭据，一步都不能往浏览器放。Gateway 那条 `follow=1` 的 SSE 反代已删（它是最后一条会在
 * Gateway 上挂小时级的连接），低于它的机器 `/runtime/logs/direct` 直接 409——不跟随的
 * 「最近 N 行」照旧经 Gateway，一次 JSON 往返，不受这个号限制。
 */
export const MIN_DIRECT_LOGS_PROTOCOL = 9

/**
 * 附件上传直连要求的管家协议号。
 *
 * 9 号管家的 `/seats/:id/stream/*` 才放行 `POST .../sessions/:id/files`（登录 JWT 换 `sat_`，
 * 正文原样管过去）；5～8 号在那条前缀上只开了 SSE，POST 是 405。上传动辄几十 MB，边收边转
 * 在 Vercel 函数里既占时又占请求体上限，所以 Gateway 的 `POST /runtime/sessions/:id/files` 删了，
 * 低于它的机器 `uploadUrl` 为 null，界面上就没有上传。
 */
export const MIN_DIRECT_UPLOAD_PROTOCOL = 9

/**
 * 会报安装进度（`/seats/:id/progress`）的管家协议。**只用来省一次白问**：低于它的
 * 管家上没有这条路，问了也只是一个 404，而问的时机恰恰是每两秒一次。
 *
 * 老管家上进度不是没有，只是粗一档——「已经装了几分钟」由 Gateway 自己的
 * `deployStartedAt` 算得出来，一个字都不靠机器。
 */
export const MIN_PROGRESS_PROTOCOL = 3

export interface SeatPorts {
  display: number
  vncPort: number
  novncPort: number
  botPort: number
  cdpPort: number
}

/**
 * `sw-` + first 12 hex of sha256(accountId). **一个员工一个 Linux 账号**，他名下的
 * 所有 bot 共用这个账号——这正是「同一个人的多个 bot 能看见同一批文件」的实现方式：
 * 共享靠 uid 相同，不靠任何代码。
 *
 * 前缀从 `bot-` 换成 `sw-` 是故意的：老机器上残留的 `bot-xxxxxxxx` 账号是按
 * (account, bot) 建的，两套命名不会互相覆盖，也一眼看得出哪些是待清理的旧账号。
 */
export function linuxUserOf(accountId: string): string {
  return 'sw-' + createHash('sha256').update(accountId).digest('hex').slice(0, 12)
}

/**
 * 席位标识 `<linuxUser>-<botId 前 12 hex>`：systemd 实例名、席位私有目录、
 * `XDG_RUNTIME_DIR` 都用它。
 *
 * **不能再拿 Linux 用户名当实例名**——同一个员工现在有多个席位，用户名不唯一了。
 * 单元模板里原来的 `User=%i` 改成由 drop-in 提供 `User=`，实例名和账号就此解耦。
 */
export function seatIdOf(accountId: string, botId: string): string {
  return linuxUserOf(accountId) + '-' + createHash('sha256').update(botId).digest('hex').slice(0, 12)
}

export function homeDirOf(linuxUser: string): string {
  return '/home/' + linuxUser
}

/** 共享工作区。同一员工的所有席位都挂着它——放共享资料的地方。 */
export function workDirOf(linuxUser: string): string {
  return homeDirOf(linuxUser) + '/work'
}

/** 席位私有目录。`$SATUWORK_HOME`、Chrome profile、XDG 各目录全在这底下。 */
export function seatDirOf(linuxUser: string, seatId: string): string {
  return homeDirOf(linuxUser) + '/.satuwork/' + seatId
}

/**
 * 每台机器的槽位上限（0..MAX_SLOT）。
 *
 * 端口全是从槽位算出来的，四段基址里挨得最近的两段只差 171——RFB 5910+N 和
 * noVNC 6081+N。于是 slot 171 的 vncPort 正好等于 slot 0 的 novncPort：两个席位抢同
 * 一个口，先起的赢，后起的那个桌面连不上，而两边的记录看着都正常。槽位必须卡在这
 * 个差值之内，并且要在**分配的时候**就报错，不能等到机器上端口冲突了才发现。
 */
export const MAX_SLOT = 170

/** 槽位用尽。deploySeat 把它翻成 409，不让它变成一个 500。 */
export class SlotsExhausted extends Error {
  constructor() {
    super(`这台机器的席位槽位已用满（每台上限 ${MAX_SLOT + 1} 个）`)
  }
}

/** Slot N=0..MAX_SLOT DISPLAY=10+N RFB=5910+N HTTP=6081+N CDP=9222+N Bot=3200+N */
export function portsOf(slot: number): SeatPorts {
  const n = Math.max(0, Math.trunc(slot))
  return {
    display: 10 + n,
    vncPort: 5910 + n,
    novncPort: 6081 + n,
    botPort: 3200 + n,
    cdpPort: 9222 + n,
  }
}

/**
 * 这台机器给浏览器直连用的地址前缀（去掉尾斜杠），管家不够新就是空串。
 *
 * 每条直连路各有自己的最低协议号（上面那串 MIN_DIRECT_*），判法却是同一句：填了
 * `directUrl` **且** 管家 ≥ 那个号。以前四处各抄一遍，改一处漏三处，收成一个。
 */
export function directBaseOf(machine: Pick<Machine, 'directUrl' | 'protocol'> | null, minProtocol: number): string {
  return (machine?.protocol ?? 0) >= minProtocol ? (machine?.directUrl || '').trim().replace(/\/$/, '') : ''
}

/**
 * 桌面地址。**机器的直连地址，`{directUrl}/seats/:id/vnc/`；没有直连就没有桌面（空串）。**
 *
 * 一路走过来：先是 `http://<sshHost>:<6081+N>/vnc.html`（每个席位一个对外端口，明
 * 文），然后收成 `{machine.host}/seats/:id/vnc/`（noVNC 回到 127.0.0.1，浏览器只打
 * 管家一个口），中间有一阵收到 Gateway 同域的 `/desktop/:seatId/` 由 Gateway 反代，现在
 * 那层反代删了，回到直接打管家。
 *
 * **为什么删掉同域反代。** Gateway 要跑在 Vercel 上：桌面是一条 WebSocket，函数里它被钉
 * 在一个实例上、受 300 秒上限；而且像素是整条链上最贵的一股流量（1280×800 下 Bot 一滚
 * 页面就是 4 MB/s），全从 Gateway 过一遍既贵又慢。直连之后席位机器发给浏览器的字节和以前
 * 发给 Gateway 的一样多，省掉的是 Gateway 的收发两份。
 *
 * 代价是 **没配 `directUrl`、或管家低于 MIN_DIRECT_DESKTOP_PROTOCOL 的机器没有桌面**：
 * 内网、还没铺证书的机器，浏览器连不到它的管家，这里也不再有退路可退。同域反代当初解决的
 * 那个 cookie 问题（管家的 `SameSite=Lax` cookie 在跨站 iframe 里存不下）由「directUrl 和
 * Gateway 同一个可注册域」这条前提解决（见 db/types.ts 的 Machine.directUrl）。
 *
 * `machine.host` 为空表示这块屏还没落到任何一台机器上，同样没有地址可给。没有票时只返回
 * 入口地址，给 owner 在后台看一眼用，点不进去。
 */
export function novncUrlOf(
  machine: Pick<Machine, 'host' | 'directUrl' | 'protocol'> | null,
  seatId: string,
  ticket?: string,
): string {
  if (!(machine?.host || '').trim() || !seatId) return ''
  /**
   * 打的是管家那条浏览器入口（见 manager/src/proxy.ts 的路由表）：`?ticket=` 进去，
   * 管家验完签换一张 path 限定的 cookie，再 302 到 vnc.html。票仍由 Gateway 签
   * （desktopTicketFor），管家拿 Gateway 的公钥验。
   */
  const direct = directBaseOf(machine, MIN_DIRECT_DESKTOP_PROTOCOL)
  if (!direct) return ''
  const url = `${direct}/seats/${encodeURIComponent(seatId)}/vnc/`
  return ticket ? `${url}?ticket=${encodeURIComponent(ticket)}` : url
}

/**
 * 对话流的直连前缀：`{directUrl}/seats/{seatId}/stream`。前端在后面接 `/sessions/:id/events`。
 *
 * 三个前提缺一条就是空串，前端就没有对话流可开：机器填了 `directUrl`、管家 ≥5 号、席位
 * 已经在这台机器上。Gateway 不再反代这条 SSE。
 */
export function streamUrlOf(machine: Pick<Machine, 'host' | 'directUrl' | 'protocol'> | null, seatId: string): string {
  if (!(machine?.host || '').trim() || !seatId) return ''
  const direct = directBaseOf(machine, MIN_DIRECT_STREAM_PROTOCOL)
  return direct ? `${direct}/seats/${encodeURIComponent(seatId)}/stream` : ''
}

/**
 * 名单流的直连地址：`{directUrl}/roster/stream`。按**机器**给，不按席位——一个人的所有
 * 席位 Bot 都在同一台机器上（§3.0），一条流就答全了。三个前提同 streamUrlOf。
 */
export function rosterUrlOf(machine: Pick<Machine, 'host' | 'directUrl' | 'protocol'> | null): string {
  if (!(machine?.host || '').trim()) return ''
  const direct = directBaseOf(machine, MIN_DIRECT_ROSTER_PROTOCOL)
  return direct ? `${direct}/roster/stream` : ''
}

/**
 * 日志跟随的直连地址：席位的是 `{directUrl}/seats/{seatId}/logs`，管家自己的是
 * `{directUrl}/logs`（`seatId` 传 null）。浏览器在后面接 `?lines=&follow=1`，头上带日志票。
 *
 * 不判 `machine.host`：这条路不经 Gateway，管家在不在线由那条流自己答。
 */
export function logsUrlOf(machine: Pick<Machine, 'directUrl' | 'protocol'> | null, seatId: string | null): string {
  const direct = directBaseOf(machine, MIN_DIRECT_LOGS_PROTOCOL)
  if (!direct) return ''
  return seatId ? `${direct}/seats/${encodeURIComponent(seatId)}/logs` : `${direct}/logs`
}

/** 跟随那条 SSE 已经不经 Gateway 了：老界面还传 `follow=1` 就用这一句拒掉，别静默降级成「最近 N 行」。 */
export const LOGS_FOLLOW_GONE = '日志跟随改为直连机器：先取 …/logs/direct'
/** 机器没配 `directUrl`、或管家 < 9 号（`/logs` 还不认日志票）。界面上就说清楚「这台机器跟不了」。 */
export const LOGS_NO_DIRECT = '这台机器没有配直连地址（或管家太旧），日志跟随打不开'

/**
 * 三条 `/logs/direct` 的**同一个尾巴**：算地址、算不出就 409、算得出就连一张日志票一起给。
 *
 * 抽出来是因为公司侧、平台侧、席位侧各抄了一遍，而三份已经开始漂——runtime.ts 那份把
 * 两句文案写成了字面量，其中 410 那句还和 machines.ts 的常量不一样（`/runtime/logs/direct`
 * 对 `…/logs/direct`）。**鉴权和审计不进来**：三条路谁能调、记不记账各不相同，那一段
 * 必须留在各自的路由里，进来了就会有人以为「调了这个就算查过权限」。
 *
 * 票的种类跟着 seatId 走：带席位签席位票，不带签**管家自己**的票（`manager: true`）——
 * 后者是管家的 root 控制面凭据，只有 owner 那两条路会传 null。
 */
export function logsDirectPayload(
  keys: JwtKeys,
  machine: Pick<Machine, 'directUrl' | 'protocol'> | null,
  seatId: string | null,
): { url: string; ticket: string } {
  const url = logsUrlOf(machine, seatId)
  if (!url) throw new HttpError(409, LOGS_NO_DIRECT)
  return { url, ticket: signLogsTicket(keys, seatId ? { seatId } : { manager: true }) }
}

/**
 * 附件上传的直连前缀：`{directUrl}/seats/{seatId}/stream`，前端在后面接 `/sessions/:id/files`。
 *
 * 和 `streamUrlOf` 是同一个前缀，却**单独给一格**：5～8 号管家在这条前缀上只放 SSE，
 * POST 回 405。前端要是拿 `streamUrl` 拼上传地址，在老机器上就是「对话流好好的、传文件
 * 却失败」，而配置里看不出区别。两格各自按自己的号判，null 就是「这个席位没有这条路」。
 */
export function uploadUrlOf(machine: Pick<Machine, 'host' | 'directUrl' | 'protocol'> | null, seatId: string): string {
  if (!(machine?.host || '').trim() || !seatId) return ''
  const direct = directBaseOf(machine, MIN_DIRECT_UPLOAD_PROTOCOL)
  return direct ? `${direct}/seats/${encodeURIComponent(seatId)}/stream` : ''
}

/**
 * 单个席位的部署超时。第一次部署要 apt 装一整套桌面栈，十五分钟是给它的。
 *
 * 重铺一个已经 ready 的席位用不了这么久，批量那条路自己传一个短的（见 managerDeploy）。
 */
export const DEPLOY_TIMEOUT_MS = 900_000

/** Gateway 反代聊天时打的地址。管家按 seatId 转到本机的 bot 口。 */
export function botBaseOf(managerHost: string | null, seatId: string): string {
  const base = (managerHost || '').trim().replace(/\/$/, '')
  if (!base || !seatId) return ''
  return `${base}/seats/${encodeURIComponent(seatId)}/bot`
}

/**
 * 机器地址改了之后，把这台机器上所有席位的 `instances.host` 重铺一遍。
 *
 * **不做这件事，改地址会把聊天打断，而桌面看着一切正常。**
 *
 * 两条路读的不是同一个地方：桌面和诊断走 `managerTargetFor`，每次现从
 * `machines.host` 拼；聊天走 `instanceHostFor`，读的是 `instances.host`——而那一行
 * 只在部署时由 `upsertInstance` 写下，之后没有任何人碰它。于是把机器换到新地址
 * （典型场景：前面加一层 nginx 终结 TLS，管家跟着收回 127.0.0.1）之后，存量席位的
 * 聊天还在往那个已经不听的老地址打，右栏的桌面却是好的。
 *
 * 表现是「这颗 bot 挂了」，不是「地址改错了」——最难查的那一类，而且改地址的人当场
 * 看不出来：他改完点一下桌面，一切正常。
 *
 * **只改本来就指着管家的那些。** `instances.host` 不止一种形状：
 *
 *   - `botBaseOf(machine.host, seatId)` —— 管家反代，也就是这里要跟着改的那种
 *   - `http://127.0.0.1:<botPort>` —— 只有 `SATUWORK_DEPLOY_STUB=1` 那条路会写
 *   - 本地 Bot（桌面端）**没有这一行**：Gateway 连不到员工的电脑，对话由桌面端直连本机（见 ui/data.js 的 localRoute）
 *
 * 后两种和机器地址没有关系，无差别盖成管家形状等于把它们打断。所以逐行比对形状，
 * 对不上就跳过——宁可少改一行让人再点一次，也不能把一条本来好的路改坏。
 *
 * `upsertInstance` 会顺带把 `lastReadyAt` 刷成现在。那一列全库只写不读（没有任何
 * 查询或界面用它），所以这里不为它单开一个方法。
 *
 * 返回真正改了几行，好让调用方写进审计、也回给界面。
 */
export async function rehostSeatInstances(db: Db, machineId: string, host: string): Promise<number> {
  const seats = await db.seatRuntimesOfMachine(machineId)
  let changed = 0
  for (const seat of seats) {
    const next = botBaseOf(host, seat.seatId)
    if (!next) continue
    const cur = await db.instance(seat.accountId, seat.botId)
    // 尾巴是 `/seats/<seatId>/bot` 才算「本来就指着管家」——前面那截正是要换掉的老地址。
    if (!cur?.host.endsWith(`/seats/${encodeURIComponent(seat.seatId)}/bot`)) continue
    if (cur.host === next) continue
    await db.upsertInstance({
      accountId: seat.accountId,
      botId: seat.botId,
      companyId: seat.companyId,
      host: next,
    })
    changed++
  }
  return changed
}

export function randomVncPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const buf = randomBytes(16)
  let out = ''
  for (let i = 0; i < 16; i++) out += alphabet[buf[i]! % alphabet.length]
  return out
}

/**
 * 管家的心跳周期。**和 manager/src/index.ts 的 `HEARTBEAT_MS` 是同一个数**，改一边
 * 要改另一边——下面「多久算失联」全是按它的倍数定的，两边分叉的话灯会在机器好好的
 * 时候变黄。
 */
export const MANAGER_HEARTBEAT_MS = 30_000

/**
 * 墓碑最多躺多久。
 *
 * 移除一台在线的机器时，Gateway 留一行 `removedAt` 不删，等管家下一轮心跳来取信、
 * 收拾完回执了才真删。机器要是再也不回来（已经关机、网线拔了、重装过），这一行不
 * 能永远躺着——超过这个时限就当它收不到了，扫掉。
 *
 * 10 分钟 = 20 轮心跳。够一次重启加一段网络抖动，又不至于让人在列表里等太久才看到
 * 那台机器彻底消失（其实界面上第一时间就看不见它了，墓碑只对库可见）。
 */
export const MACHINE_TOMBSTONE_TTL = 10 * 60_000

/** 通联状态。界面上那盏灯只认这四个值。 */
export type MachineLink = 'unpaired' | 'online' | 'stale' | 'offline'

/**
 * 这台机器现在通不通。
 *
 * 判据只有一个：**最近一次心跳有多久了**。不看 `lastError`——那是「机器说它自己哪儿
 * 不对」，能报错恰恰说明线是通的；把两件事混进一盏灯，管理员就分不出「机器失联」和
 * 「机器在线但升级失败」，而这两种的处置完全不同。
 *
 * 三级而不是两级，是因为**换版重启本身就会断一下**：`systemd-run --on-active=2s` 加
 * 上进程起来、跑完第一轮心跳，几十秒很正常。一超时就报「失联」会让每次自升级都闪一
 * 次红灯，几次之后没人再信这盏灯。所以中间留一档 `stale`：过了 3 轮心跳还没消息，
 * 值得看一眼，但还不到「这台机器没了」。
 */
export function machineLink(m: Machine, now = Date.now()): MachineLink {
  // 没配对就没有心跳可言——这一档要和「配对过但失联」分开：前者是还没装，后者是出事了。
  if (!machinePaired(m)) return 'unpaired'
  if (!m.lastHeartbeatAt) return 'offline'
  const age = now - m.lastHeartbeatAt
  if (age <= MANAGER_HEARTBEAT_MS * 3) return 'online'
  if (age <= MANAGER_HEARTBEAT_MS * 20) return 'stale'
  return 'offline'
}

export function publicMachine(m: Machine) {
  const now = Date.now()
  return {
    id: m.id,
    host: m.host,
    paired: Boolean(m.pairedAt && m.host),
    pairedAt: m.pairedAt,
    managerVersion: m.managerVersion,
    protocol: m.protocol,
    protocolTooOld: Boolean(m.pairedAt) && m.protocol < MIN_MANAGER_PROTOCOL,
    lastError: m.lastError,
    lastHeartbeatAt: m.lastHeartbeatAt,
    link: machineLink(m, now),
    /**
     * 距最近一次心跳多少毫秒。没心跳过就是 null。
     *
     * 界面**不能**拿 `lastHeartbeatAt` 自己减本地时钟：管理员的机器和 Gateway 差几分钟
     * 是常事，那样会显示出「-3 分钟前」这种东西，而这盏灯要答的恰恰是时间问题。
     * 算好了给它。
     */
    heartbeatAge: m.lastHeartbeatAt ? Math.max(0, now - m.lastHeartbeatAt) : null,
    // 期望时区和机器自报的实际时区都给出去：只给一个的话，界面分不出「已经改上了」
    // 和「指令下了、机器还没心跳回来」。
    timezone: m.timezone,
    currentTimezone: m.currentTimezone,
  }
}

/**
 * IANA 时区名的校验与归一。空串 = 清掉，表示「不管这台机器的时区」。
 *
 * 两道关，缺一不可：
 *
 * - **形状**。这个值会一路传到管家、变成 `timedatectl set-timezone` 的参数，还会被
 *   当成 `/usr/share/zoneinfo` 底下的路径去查。所以先卡死字符集，并挡掉 `..`。
 * - **认不认识**。形状对但不存在的名字（`Asia/Shanghi`）过了 Gateway 这关，就只能
 *   在机器上失败——而那里的错误要等一轮心跳才看得见。用 Intl 当权威表，就地回绝。
 *
 * 返回 `undefined` = 不合法，调用方去报 400。
 */
export function normalizeTimezone(raw: string): string | null | undefined {
  const tz = raw.trim()
  if (!tz) return null
  // 形状与「Intl 认不认」这两关都在 canonicalTimezone 里（日常任务的触发器用的是
  // 同一个）。分两份写的话，两条路对同一个名字给出不同答案只是时间问题。
  //
  // 归一到规范拼写的代价是别名会被换掉（`Asia/Calcutta` → `Asia/Kolkata`），而规范名
  // 有的是 tzdata 的 backward 链接。Debian 的 tzdata 是全的；真裁过的机器上，管家会先
  // 查 /usr/share/zoneinfo 并把「这台机器上没有这个时区」报回心跳，不会静默改不上。
  return canonicalTimezone(tz) || undefined
}

/**
 * owner 机器详情：像账号密钥一样带一次 token。公司 admin 的 publicMachine 永不带。
 *
 * `arch` 也只在这一侧给：它是选发布包的依据（包里带原生二进制，架构不对就起不来），
 * 平台侧排查「为什么这台升不上去」第一眼看的就是它。公司管理员用不着，也不该看。
 *
 * **负载和日志占用同理，也只在这一侧。** `GET /orgs/:id/machine` 是给公司里任何一个
 * 成员看的（他们要拿访问地址），而那份自报数据里有挂载点、网卡名、`/var/log` 底下
 * 的文件路径——运维要看的机器内情，不是员工该拿到的东西。
 */
export function ownerMachine(m: Machine) {
  const now = Date.now()
  return {
    ...publicMachine(m),
    /**
     * 公网直连地址。**只在 owner 这一侧给。**
     *
     * 它不是员工要用的东西——员工拿到的桌面地址已经由 novncUrlOf 拼好了。而这一列是
     * 运维配置：没填或填错了整块屏就没有，值得和 host 一样放在平台侧管。
     */
    directUrl: m.directUrl,
    /**
     * 地址填了、但管家还不够新，桌面**还开不了**（novncUrlOf 给空）。
     *
     * 这一格必须有：没有它，人填完地址只看到桌面打不开，而「填了没生效」和「地址填错」
     * 在界面上长得一模一样，只有去数管家版本才分得出来。
     */
    directPending: Boolean(m.directUrl) && m.protocol < MIN_DIRECT_DESKTOP_PROTOCOL,
    arch: m.arch,
    telemetry: m.telemetry,
    telemetryAt: m.telemetryAt,
    /**
     * 这份自报数据收到多久了。
     *
     * 年龄由这里算，不留给界面拿 telemetryAt 去减本地时钟——理由和 heartbeatAge 一样：
     * 管理员的机器和 Gateway 差几分钟是常事，而这一格答的恰恰是「这份数还新不新」，
     * 算错了整块就是在骗人。
     */
    telemetryAge: m.telemetryAt ? Math.max(0, now - m.telemetryAt) : null,
    /**
     * 期望的日志上限。空 = 没人指定过，跟管家默认走；0 = 明确不清。
     *
     * 机器**实际**在用的那个数在 `telemetry.logs.capMb` 里——两格分开，界面才说得清
     * 「指令下了」和「机器认了」（机器上还可以用 SATUWORK_LOG_CAP_MB 本地钉死，那时
     * 两个数就是对不上的，而那正是要看得见的事）。
     */
    logCapMb: m.logCapMb,
    token: m.token || null,
  }
}

export function publicSeatRuntime(
  row: SeatRuntime,
  /**
   * **收整台机器，不是只收一个 host。** 桌面地址现在要同时看 host（有没有落到机器上）
   * 和 directUrl（走不走直连），两处各查各的迟早会漂——这个文件里 machineTokenFor
   * 那段注释记过同一类事故：host 按席位解析、票按公司默认机器取，多机公司必然错配。
   */
  machine: Pick<Machine, 'host' | 'directUrl' | 'protocol'> | null,
  opts: { includePassword: boolean; ticket?: string },
  now = Date.now(),
) {
  const ports = portsOf(row.slot)
  return {
    accountId: row.accountId,
    botId: row.botId,
    companyId: row.companyId,
    linuxUser: row.linuxUser,
    seatId: row.seatId,
    // 员工要知道往哪儿放共享文件：同一个账号下的所有 bot 都看得见这个目录。
    sharedDir: workDirOf(row.linuxUser),
    display: row.display,
    vncPort: row.vncPort,
    novncPort: row.novncPort,
    // 没有直连就没有桌面：和 listSeatRuntime 一样给 null，前端一处判断。
    novncUrl: novncUrlOf(machine, row.seatId, opts.ticket) || null,
    status: row.status,
    lastError: row.lastError,
    deployedAt: row.deployedAt,
    updatedAt: row.updatedAt,
    botVersion: row.botVersion ?? null,
    /**
     * 正在装的话，装到哪一档、**已经装了多久**（毫秒）。装完（ready / error）都是 null。
     *
     * **给年龄，不给时刻**——和 heartbeatAge / telemetryAge 一个规矩（理由见
     * publicMachine 里那段）：员工的电脑和 Gateway 差几分钟是常事，而这一格恰恰是个
     * 时间问题。发绝对时刻、让界面自己减本地时钟的话，一台快十分钟的电脑会在人刚按下
     * 「创建」的那一秒写出「已经装了 10:03」——正好是这一屏要打消的那个念头。
     *
     * 界面拿到之后**自己锚一次**（`Date.now() - deployAge`），此后每秒往前走的是它自己
     * 的时钟差值，不再和 Gateway 比对——那样既准又不会每两秒跳一下。
     */
    deployPhase: row.deployPhase,
    deployAge: row.deployStartedAt == null ? null : Math.max(0, now - row.deployStartedAt),
    // 席位自报的模版版本。和 botVersion 并排给出来，界面上那两个「版本」问的是两件事：
    // 装的是哪个发布包、跑的是哪一版模版。
    tplVersion: row.tplVersion ?? null,
    tplSyncedAt: row.tplSyncedAt ?? null,
    ...(opts.includePassword ? { vncPassword: row.vncPassword } : {}),
    ports: {
      display: ports.display,
      vncPort: ports.vncPort,
      novncPort: ports.novncPort,
    },
  }
}

export function listSeatRuntime(row: SeatRuntime, machine: Machine | null, now = Date.now()) {
  return {
    botId: row.botId,
    status: row.status,
    linuxUser: row.linuxUser,
    seatId: row.seatId,
    // 列表里不签票：这是给管理员看的引用，点进去要走 /runtime/desktop 现签一张。
    novncUrl: novncUrlOf(machine, row.seatId) || null,
    /**
     * 对话流直连地址；null = 这个席位没有对话流（机器没配 directUrl 或管家太旧）。前端拿它
     * 开那条 SSE，带的是登录 JWT（管家那头验完换成席位票）。Gateway 不再反代这条流，所以
     * 这里也不判机器通不通——通不通由那条 SSE 自己答。
     */
    streamUrl: streamUrlOf(machine, row.seatId) || null,
    /**
     * 附件上传的直连前缀；null = 这个席位传不了文件（管家 < 9 号或没配 directUrl）。和
     * `streamUrl` 分开给：老管家那条前缀只开 SSE、拒 POST，见 uploadUrlOf。Gateway 的
     * `POST /runtime/sessions/:id/files` 已删。
     */
    uploadUrl: uploadUrlOf(machine, row.seatId) || null,
    botVersion: row.botVersion ?? null,
    tplVersion: row.tplVersion ?? null,
    tplSyncedAt: row.tplSyncedAt ?? null,
    /**
     * **这个席位所在那台机器通不通。**
     *
     * `status` 答不了这件事：它是「上一次部署走到哪一步了」，落库之后就不动了——机器
     * 断电、网线拔了、管家挂了，这一行照样写着 `ready`。于是平台那一页已经把灯打成
     * 「失联」，员工手上那颗 Bot 还挂着「在线」，点发送没有任何反应。两边说的是同一
     * 台机器，判据却一个来自部署记录、一个来自心跳。
     *
     * 判据就用平台那一份（`machineLink`），一个字都不另算——同一台机器在两个页面上
     * 说两种话，比少一个字段糟得多。
     *
     * **是席位那台机器，不是公司的默认机器。** 公司配了第二台之后，员工的席位完全
     * 可能落在 M2 上，而 `companies.machineId` 指着 M1：拿默认机器的心跳去答「我这颗
     * Bot 通不通」，正好在多机的时候开始骗人。
     */
    machineLink: machine ? machineLink(machine, now) : 'unpaired',
    /**
     * 距最近一次心跳多少毫秒；没心跳过是 null。
     *
     * 界面**不能**拿 lastHeartbeatAt 自己减本地时钟（理由见 publicMachine 里那段）：
     * 员工的电脑和 Gateway 差几分钟是常事，而这一格答的恰恰是时间问题。
     */
    machineHeartbeatAge: machine?.lastHeartbeatAt ? Math.max(0, now - machine.lastHeartbeatAt) : null,
  }
}


/**
 * **明确配置过的**对外地址。没配就是空串。
 *
 * 和 `gatewayPublicUrl()` 分开，是因为「猜出来的地址」和「有人写下来的地址」能承担的
 * 责任不一样：猜出来的多半是 `GATEWAY_HOST:GATEWAY_PORT`，而那两个值通常是
 * `127.0.0.1:3080`——对席位机器来说是个打不通的地址。写进 bot.env 已经够糟（那至少
 * 只发生在一次明确的部署动作里），拿它去教管家改自己的心跳地址就是当场把机器打死。
 * 所以 `managerHeaders` 只在这一份非空时才说话。
 */
export function gatewayPublicUrlExplicit(): string {
  return (process.env.GATEWAY_PUBLIC_URL || '').trim().replace(/\/$/, '')
}

export function gatewayPublicUrl(): string {
  const explicit = gatewayPublicUrlExplicit()
  if (explicit) return explicit
  const host = process.env.GATEWAY_HOST || '127.0.0.1'
  const port = process.env.GATEWAY_PORT || '3080'
  return `http://${host}:${port}`
}

/**
 * 发往**管家自己**那几条控制接口的头：机器票，外加一句「Gateway 现在在哪」。
 *
 * 第二个头是给管家学地址用的（见 manager/src/index.ts 的 adoptGatewayUrl）。它要解的
 * 是一个死结：Gateway 换了地址之后，管家手上那份 `gatewayUrl` 还是配对那天写死的，
 * 心跳打向一个不存在的地方——而它唯一能被告知这件事的通道，恰恰是它**打不出去**的
 * 那一条。入站这条还通着（机器没挪窝），那就从这条告诉它。
 *
 * **信任面没有变大**：这个头只有过了 `requireMachine` 的调用方才会被采信，也就是拿得出
 * `smt_` 的那一个；而部署请求的 body 里本来就带着 `gatewayUrl`，管家一直原样把它写进
 * 席位的 bot.env。差别只是这次它也写给自己。
 *
 * **反代那条路上带了也没用**：管家转发给 bot 的请求走的是它自己那道 machineTokenOk，
 * 不经过 requireMachine，所以聊天流量不会 adopt。真正的入口是控制类那几条（探活、
 * 部署、取日志）——反正它们才是「有人在平台上动了这台机器」的时刻。
 *
 * **只在明确配置过时才带**，理由见 gatewayPublicUrlExplicit。
 */
export function managerHeaders(machineToken?: string): Record<string, string> {
  const url = gatewayPublicUrlExplicit()
  return {
    ...(machineToken ? { 'x-satuwork-machine': machineToken } : {}),
    ...(url ? { 'x-satuwork-gateway-url': url } : {}),
  }
}

/** 槽位**按机器**分配，不是按公司：端口从槽位算出来，两台机器上的 slot 0 互不冲突。 */
async function allocateSlot(db: Db, machineId: string, keep?: number): Promise<number> {
  if (keep != null && keep >= 0) return keep
  const used = new Set((await db.seatRuntimesOfMachine(machineId)).map((r) => r.slot))
  let i = 0
  while (used.has(i)) i += 1
  if (i > MAX_SLOT) throw new SlotsExhausted()
  return i
}

/** 一台机器上「激活账号」的数量：有已部署席位的不同账号。 */
export function activeAccountsOf(seats: SeatRuntime[]): Set<string> {
  return new Set(seats.filter((r) => r.status !== 'none').map((r) => r.accountId))
}

export interface MachineLoad {
  machine: Machine
  /**
   * 这台机器上的席位行。
   *
   * **算负载的时候本来就查过一遍**，所以顺手带出来：下游要画席位清单的地方（机器
   * 卡片）不必再查一次同一批行。少一次往返事小，两份可能对不上的数据事大——负载
   * 数字和席位清单出自同一次查询，界面上「账号位 3/10」和底下那张表就永远一致。
   */
  seatRows: SeatRuntime[]
  accounts: number
  seats: number
  full: boolean
}

export async function machineLoads(db: Db, companyId: string): Promise<MachineLoad[]> {
  const machines = await db.machinesOfCompany(companyId)
  return Promise.all(machines.map((machine) => machineLoadOf(db, machine)))
}

/** 单台机器的负载。多机公司走 machineLoads，平台侧按 id 拿单台的走这条。 */
export async function machineLoadOf(db: Db, machine: Machine): Promise<MachineLoad> {
  const seatRows = await db.seatRuntimesOfMachine(machine.id)
  const accounts = activeAccountsOf(seatRows).size
  return { machine, seatRows, accounts, seats: seatRows.length, full: accounts >= machine.maxAccounts }
}

/**
 * 这个账号该落在哪台机器上。
 *
 * 两条规则：
 *
 * 1. **粘住。** 账号已经有席位了就还用那台机器——同一个员工的所有 bot 共用一个 uid
 *    和 `~/work`，拆到两台机器上「共享文件」就不成立了。
 * 2. **填满一台再用下一台。** 在没满的机器里挑**已用最多**的那台（并列按登记先后）。
 *    不是最闲优先——那样会把账号摊平到所有机器上，谁也没满，反而没法把空机器腾出来
 *    下线或者转给别的公司。
 */
export async function machineForAccount(
  db: Db,
  companyId: string,
  accountId: string,
): Promise<{ ok: true; machine: Machine } | { ok: false; status: number; error: string }> {
  const loads = await machineLoads(db, companyId)
  const paired = loads.filter((l) => machinePaired(l.machine))
  if (!paired.length) return { ok: false, status: 409, error: '公司还没有配对任何运行机器' }

  /**
   * 粘住是**不变量，不是优化**。
   *
   * 以前这里只有 `if (hit) return …`：找到了这个账号的机器、但它此刻不可用
   * （没配对好、换过地址、token 轮换失败、正在重装），就直接往下走「填满一台再用
   * 下一台」，把这个人的新 bot 部署到另一台机器上。共享 `~/work` 靠的是同一个 uid
   * 在同一台机器上，劈开之后这条就不成立了——而且没有任何告警，人只是从此看不见
   * 自己在另一台机器上的文件。
   *
   * 更糟的是下一次：seatRuntimesOfAccount 按 slot 排序，而 slot 是**按机器**分配的，
   * 跨机器排序没有语义——一旦劈开，挑哪台就变成任意的。
   *
   * 所以找到了就必须用那台；那台不行就报出来，让人先去修机器。
   */
  const mine = (await db.seatRuntimesOfAccount(accountId)).find((r) => r.machineId)
  if (mine) {
    const hit = paired.find((l) => l.machine.id === mine.machineId)
    // 粘住的机器就算已经满了也继续用：它的容量早就把这个账号算进去了。
    if (hit) return { ok: true, machine: hit.machine }
    const stale = loads.find((l) => l.machine.id === mine.machineId)?.machine
    return {
      ok: false,
      status: 409,
      error: stale
        ? `这个账号的席位在机器 ${stale.id.slice(0, 8)}（${stale.host || '地址未知'}）上，那台还没配对好。` +
          '先把它修好再部署——换一台会让这个人的共享文件对不上。'
        : '这个账号的席位所在的机器已经不在这家公司名下了。先把它派回来，或者删掉这个账号的旧席位。',
    }
  }

  const open = paired.filter((l) => !l.full).sort((a, b) => b.accounts - a.accounts || a.machine.createdAt - b.machine.createdAt)
  if (!open.length) {
    const total = paired.reduce((n, l) => n + l.machine.maxAccounts, 0)
    return { ok: false, status: 409, error: `所有运行机器都满了（${paired.length} 台，共 ${total} 个账号位）` }
  }
  return { ok: true, machine: open[0].machine }
}

export async function companyMachineOf(db: Db, companyId: string): Promise<Machine | undefined> {
  const company = await db.company(companyId)
  if (!company) return
  if (company.machineId) {
    const m = await db.machine(company.machineId)
    if (m) return m
  }
  return db.machineOfCompany(companyId)
}

/**
 * 这台机器装好管家并配对过了吗。
 *
 * 取代了原来的 `machineBound` + `machineHasSshAuth` 两级判断。以前「有地址」和
 * 「有登录凭据」是分开的两件事，现在配对是一次原子的事：要么两样都有，要么这台
 * 机器根本不存在。
 */
export function machinePaired(m: Machine | undefined): m is Machine {
  return Boolean(m && m.pairedAt && (m.host || '').trim() && m.token)
}

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
 * 后台装」的那条路走 startSeatDeploy。
 */
export async function deploySeat(
  db: Db,
  keys: JwtKeys,
  account: Account,
  opts: DeployOpts,
): Promise<DeployOutcome> {
  // **从登记就开始记**，不是等到真的开装：这中间隔着几次查库，而进度那条路每两秒问一
  // 次，问在这个缝里就会得到一句「没人在装」——界面据此改口，人手上多出一颗不该点的
  // 「重新部署」。
  const release = markDeploying(seatKeyOf(account.id, (opts.botId || '').trim()))
  try {
    const res = await reserveSeat(db, account, opts)
    if (!res.ok) return res
    if ('done' in res) return { ok: true, result: res.done }
    return await installSeat(db, res.plan)
  } finally {
    release()
  }
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
 * 这一刻**这个进程里**正在装的席位。key 是 `accountId:botId`。
 *
 * 两个用处，缺一个都会在界面上变成一句假话：
 *
 * 1. **挡住重复的自动部署**（见 startSeatDeploy）。建 Bot 那一屏上双击一下、或者人在
 *    装到一半时刷新页面又触发一次，两次登记会各自分一个槽、各自往机器上铺同一个
 *    seatId——管家那头虽然按 seatId 排队（withSeatLock），但库里已经先被后写的那次盖
 *    过一遍了，进度和结局都会开始骗人。
 * 2. **认出「装到一半没人管了」**（见 deployInFlight 和 `/runtime/deploy/progress`）。
 *    装现在跑在后台，Gateway 一重启，那一行就永远停在 `deploying`：机器上什么都没在
 *    装，而界面上那个读秒会一直往上走，人守着一屏永远不会完成的进度，连一颗能按的
 *    按钮都没有。库里看不出这件事——`deploying` 那一行在两种情况下长得一模一样，只有
 *    进程自己知道手上有没有这活儿。
 */
const inFlightDeploys = new Map<string, number>()

/**
 * 标记「这个席位这会儿有人在装」。**计数，不是布尔**：手工重铺和自动部署完全可能叠在
 * 一起，用布尔的话先结束的那个会把还在跑的那个也一起抹掉——而那正好会让界面把一个装
 * 得好好的席位说成「装到一半没人管了」。
 */
function markDeploying(key: string): () => void {
  inFlightDeploys.set(key, (inFlightDeploys.get(key) ?? 0) + 1)
  let done = false
  return () => {
    if (done) return
    done = true
    const n = (inFlightDeploys.get(key) ?? 1) - 1
    if (n > 0) inFlightDeploys.set(key, n)
    else inFlightDeploys.delete(key)
  }
}

const seatKeyOf = (accountId: string, botId: string) => accountId + ':' + botId

/**
 * **先登记，后台装。** 登记那一段（挑机器、定槽位、写下 `deploying` 那一行）等着做完
 * 才返回，机器上那十几分钟丢进后台。
 *
 * 建完 Bot 自动部署走的就是这条：人不该为了「能用」去点第二个按钮，也不该盯着一个转
 * 十几分钟的圈等 HTTP 回执——那条请求活不了那么久，中间任何一次网络抖动都会让界面以为
 * 部署失败了，而机器上装得好好的。
 *
 * 后台那一段的结局落在席位行上（`ready` / `error` + lastError），界面照旧从
 * `/runtime/desktop` 读——**不需要有人接着这个 promise**。
 */
export async function startSeatDeploy(
  db: Db,
  account: Account,
  opts: DeployOpts,
): Promise<{ ok: true; runtime: SeatRuntime; installing: boolean } | DeployFailure> {
  const botId = (opts.botId || '').trim()
  const key = seatKeyOf(account.id, botId)
  if (inFlightDeploys.has(key)) {
    const row = await db.seatRuntime(account.id, botId)
    // 已经在装了就当这次也算数：调用方要的是「它在装」，而它确实在装。
    if (row) return { ok: true, runtime: row, installing: true }
  }
  const release = markDeploying(key)
  let handedOff = false
  try {
    const res = await reserveSeat(db, account, opts)
    if (!res.ok) return res
    if ('done' in res) return { ok: true, runtime: res.done.runtime, installing: false }
    const plan = res.plan
    handedOff = true
    void installSeat(db, plan)
      .then((out) => {
        if (!out.ok) {
          // 失败已经写进席位行了（lastError），这里只留一行日志：后台没有调用方，
          // 不打的话这台机器上发生过什么在进程外一个字都看不到。
          console.warn(`satuwork-gateway: 席位 ${plan.row.seatId} 自动部署失败：${out.error}`)
        }
      })
      .catch((e) => {
        console.warn(`satuwork-gateway: 席位 ${plan.row.seatId} 自动部署异常：${e instanceof Error ? e.message : String(e)}`)
      })
      // 后台那一段跑完才松手——「有没有人在装」这个问题，答的就是它。
      .finally(release)
    return { ok: true, runtime: plan.row, installing: true }
  } finally {
    if (!handedOff) release()
  }
}

/**
 * 这个席位此刻有没有一次部署真的在跑（**这个进程里**）。
 *
 * 进度那条路靠它把两种 `deploying` 分开：一种是机器上正在装，另一种是上一次装到一半、
 * Gateway 重启了，库里那一行再也没人来收。前者要接着等，后者要当场说清楚并给一颗
 * 「重新部署」——两者在库里长得一模一样。
 */
export function deployInFlight(accountId: string, botId: string): boolean {
  return inFlightDeploys.has(seatKeyOf(accountId, botId))
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
    const rel = await db.botRelease(requested)
    if (!rel) return { ok: false, status: 404, error: '没有这个 Bot 版本', runtime: await db.seatRuntime(account.id, botId) }
    // 显式指定也要挡：包里带 esbuild 的原生二进制，装错架构的后果是席位「部署成功」
    // 但 bot 起不来，表现是聊天 503——从部署结果上完全看不出来。两边架构都认得出来
    // 且不一样才拦，认不出来的（老版本号没后缀）放行。
    const want = machine.arch?.trim()
    const got = releaseArch(rel.version)
    if (want && got && got !== want) {
      return {
        ok: false,
        status: 409,
        error: `这台机器是 ${want}，而 ${rel.version} 是 ${got} 的包`,
        runtime: await db.seatRuntime(account.id, botId),
      }
    }
    release = rel
  } else {
    const latest = await db.latestBotRelease('bot', machine.arch)
    if (!latest) return { ok: false, status: 409, error: '还没有发布 Bot 版本', runtime: await db.seatRuntime(account.id, botId) }
    release = latest
  }
  const version = release.version

  const linuxUser = linuxUserOf(account.id)
  const seatId = seatIdOf(account.id, botId)
  const existing = await db.seatRuntime(account.id, botId)
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
  const { account, companyId, botId, machine, release, version, row, existing, vncPassword } = plan

  if (process.env.SATUWORK_DEPLOY_STUB === '1') {
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

  const spec: SeatSpec = {
    seatId: row.seatId,
    linuxUser: row.linuxUser,
    homeDir: homeDirOf(row.linuxUser),
    workDir: workDirOf(row.linuxUser),
    seatDir: seatDirOf(row.linuxUser, row.seatId),
    botId,
    botVersion: version,
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

  const ready = await db.upsertSeatRuntime({
    ...sending,
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
    // 反代地址，不是 bot 的直连地址。席位端口只听 127.0.0.1，只有管家够得着。
    host: botBaseOf(machine.host, row.seatId),
  })
  return { ok: true, result: { runtime: ready, machine } }
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

/** Gateway 下发给管家的席位规格。字段和 manager/src/seats.ts 的 SeatSpec 一一对应。 */
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
  ports: SeatPorts
  /**
   * 现在就重铺，别等席位把这一轮跑完（见 manager/src/seats.ts 的 drainSeat）。
   *
   * **不等于本地那个 `force`**：force 是「已经是这个版本也照铺」，模版下发也带着它，
   * 而那条路恰恰是该等的。只有人手工按的「重新部署」才把这个字段发下去。
   */
  interrupt?: boolean
  /** 允许管家花在排空上的毫秒数。由这次请求的超时算出来，见 deploySeat 里的 drainMs。 */
  drainMs?: number
}

/**
 * 管家说「席位正忙，这次没换版」。
 *
 * 单独一个类型，因为它和「部署失败」的处置完全相反：那边要把席位标红、留一行错误等人
 * 来看；这边什么都没发生，席位照旧在跑，人该做的只是晚点再来（或者按「重新部署」）。
 */
export class SeatBusyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SeatBusyError'
  }
}

/**
 * 把一个席位交给管家去建。
 *
 * 这一整个函数取代了原来的 scp + ssh：发布包不再逐席位推过去，管家自己按版本从
 * Gateway 拉一次、全机共享；`smt_` 走 `x-satuwork-machine` 头，和管家转发给 bot 的
 * `authorization` 分开——两层鉴权互不干扰。
 *
 * 15 分钟超时：第一次部署要 apt 装一整套桌面栈，慢是正常的。
 *
 * 批量重铺那条路（模版的「立即下发」）会传一个**短得多**的超时：那些席位都已经
 * ready，桌面栈早装好了，不该让一台卡住的机器把整条请求拖到十五分钟。
 */
async function managerDeploy(machine: Machine, spec: SeatSpec, timeoutMs = DEPLOY_TIMEOUT_MS): Promise<void> {
  const url = `${machine.host!.replace(/\/$/, '')}/seats/${encodeURIComponent(spec.seatId)}`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'PUT',
      // 两个头都带：`x-satuwork-machine` 是反代那条路径上用来和 bot 的 `authorization`
      // 区分开的；控制类调用没有这个冲突，带上 `authorization` 让 curl 和旧版管家也认。
      headers: {
        'content-type': 'application/json',
        ...managerHeaders(machine.token),
        authorization: 'Bearer ' + machine.token,
      },
      body: JSON.stringify(spec),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    throw new Error('联系不上机器管家: ' + (e instanceof Error ? e.message : String(e)))
  }
  if (res.ok) return
  /**
   * **先读完再解析，最后才截。** 原先是 `text().slice(0, 400)` 之后再 JSON.parse——
   * 而真出错时这个响应体一定超过 400 字（里面整个席位记录都在），于是 JSON 被砍断、
   * parse 必然失败、回退成「把那段残缺 JSON 当错误存起来」。也就是说：**越是有内容的
   * 错误，越是拿不到内容**，界面上看到的是半句话加一个没闭合的花括号。真发生过。
   *
   * 上限放到 16 KiB：管家那侧已经把输出裁到 500 字级别，这里只需要够装下整个 JSON。
   */
  const text = (await res.text()).slice(0, 16_000)
  let message = text
  let busy = false
  try {
    const body = JSON.parse(text) as { error?: string; busy?: boolean; seat?: { lastError?: string } }
    busy = body.busy === true
    // 忙的那一条里 seat 是**没动过的**那一行（lastError 多半是上一次部署留下的），
    // 会把「有会话在跑」盖掉。这种时候只认 error。
    message = busy ? body.error || text : body.seat?.lastError || body.error || text
  } catch {}
  if (busy && res.status === 409) throw new SeatBusyError(tailOf(message, 900))
  throw new Error(`管家部署失败 ${res.status}: ${tailOf(message, 900)}`)
}

/** 拆席位：停单元、删 drop-in、删席位目录。账号和 ~/work 留着，别的席位还在用。 */
export async function managerRemoveSeat(machine: Machine, seatId: string): Promise<void> {
  if (!machinePaired(machine)) return
  const url = `${machine.host!.replace(/\/$/, '')}/seats/${encodeURIComponent(seatId)}`
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { ...managerHeaders(machine.token), authorization: 'Bearer ' + machine.token },
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok && res.status !== 404) throw new Error(`管家拆席位失败 ${res.status}`)
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

/** 问管家还活着吗。配对回拨和界面上的「检查连通」都走它。 */
export async function managerHealth(
  host: string,
  opts: { token?: string; challenge?: string; timeoutMs?: number },
): Promise<{ ok: boolean; body?: Record<string, unknown>; error?: string }> {
  const base = host.replace(/\/$/, '')
  const q = opts.challenge ? `?challenge=${encodeURIComponent(opts.challenge)}` : ''
  try {
    const res = await fetch(`${base}/health${q}`, {
      // 探活也捎上「Gateway 现在在哪」：界面上那颗「保存并探活」于是顺带把地址教给
      // 管家——换了 Gateway 地址之后，那正是人第一个会去按的按钮。
      headers: opts.token ? { authorization: 'Bearer ' + opts.token, ...managerHeaders() } : {},
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    })
    if (!res.ok) return { ok: false, error: `管家返回 ${res.status}` }
    return { ok: true, body: (await res.json()) as Record<string, unknown> }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 探一下这个**公网直连地址**后面是不是一台管家。
 *
 * **绝不带机器票。** 这是它和 managerHealth 唯一也是最要紧的区别：`directUrl` 是
 * 管理员手输的公网域名，敲错一个字母就落到别人的服务器上——而 managerHealth 会把
 * `Authorization: Bearer smt_…` 和 Gateway 的公网地址一起送过去，等于把这台机器完整
 * 可用、可吊销的机器票交给那个域名的持有者。host 那条路上填的是内网地址，写错通常
 * 解析不到；这一条按定义就是公网域名，笔误落到真实第三方手里的概率高得多。
 *
 * 不带票反而**判得更准**：管家的 `/health` 没有票就是 401（见 manager/src/index.ts），
 * 所以「401」恰恰是「对面真是一台管家」的证据，而 200 / 404 / 连不上都说明这个地址
 * 指错了地方。比带着票去换一个 200 更能抓住笔误，还不用付出任何凭据。
 *
 * 只是给人看的提示，不作为任何判定的依据——浏览器连不连得上仍然只有真开一次桌面
 * 才知道。
 */
export async function probeDirectUrl(url: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(8000) })
    if (res.status === 401) return { ok: true }
    return { ok: false, error: `这个地址回的是 ${res.status}，不像是席位机器上的管家` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 管家报上来的一步：脚本自己写的中文短句，Gateway 一个字都不解释。 */
export interface SeatStep {
  step: number
  total: number
  label: string
  at: number
}

/**
 * 问管家「这个席位装到第几步了」。**问不到一律回 undefined**，不是错误。
 *
 * 这条路上「问不到」有一大把正常成因：管家太旧（没这条路）、脚本还没报出第一行、这一
 * 刻机器上根本没在装、网络抖了一下。它们对调用方是同一个决定——退回到粗进度，照旧
 * 把「已经装了几分钟」画出来。分开报只会让一屏等待的界面上多出几种吓人的说法。
 *
 * 超时压到 3 秒：这是每两秒问一次的东西，等一个卡住的管家没有任何意义。
 */
export async function seatStepOf(machine: Machine, seatId: string, timeoutMs = 3000): Promise<SeatStep | undefined> {
  if (!machinePaired(machine) || machine.protocol < MIN_PROGRESS_PROTOCOL) return undefined
  try {
    const res = await fetch(`${machine.host!.replace(/\/$/, '')}/seats/${encodeURIComponent(seatId)}/progress`, {
      headers: { ...managerHeaders(machine.token), authorization: 'Bearer ' + machine.token },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return undefined
    const body = (await res.json()) as { progress?: unknown }
    const p = body?.progress as Record<string, unknown> | null | undefined
    if (!p) return undefined
    const step = Number(p.step)
    const total = Number(p.total)
    const at = Number(p.at)
    if (!Number.isFinite(step) || !Number.isFinite(total) || total <= 0 || step <= 0 || step > total) return undefined
    return { step, total, label: String(p.label ?? '').slice(0, 80), at: Number.isFinite(at) ? at : Date.now() }
  } catch {
    return undefined
  }
}

/**
 * 太长就砍头，不砍尾。
 *
 * 这些消息里装的是脚本输出：进度在前，原因在后。从头截等于把唯一有用的那一段扔掉。
 */
function tailOf(text: string, max: number): string {
  const s = (text || '').replace(/\s+/g, ' ').trim()
  return s.length <= max ? s : '…' + s.slice(-max)
}

export function sanitizeError(e: unknown, secrets: string[] = []): string {
  const raw = e instanceof Error ? e.message : String(e)
  return tailOf(stripSecrets(raw, secrets), 900) || '部署失败'
}
function stripSecrets(text: string, secrets: string | string[] = []): string {
  let s = text
  const list = typeof secrets === 'string' ? (secrets ? [secrets] : []) : secrets
  for (const secret of list) {
    if (secret) s = s.split(secret).join('***')
  }
  s = s.replace(/SSHPASS=\S+/g, 'SSHPASS=***')
  s = s.replace(/gatewayToken[=:]\S+/gi, 'gatewayToken=***')
  s = s.replace(/gatewayApiKey[=:]\S+/gi, 'gatewayApiKey=***')
  s = s.replace(/machineToken[=:]\S+/gi, 'machineToken=***')
  s = s.replace(/vncPassword[=:]\S+/gi, 'vncPassword=***')
  s = s.replace(/\bsat_[A-Za-z0-9_-]+/g, 'sat_***')
  s = s.replace(/\bsk_sw_[A-Za-z0-9_-]+/g, 'sk_sw_***')
  s = s.replace(/\bsmt_[A-Za-z0-9_-]+/g, 'smt_***')
  return s
}
