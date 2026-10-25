/**
 * 席位在机器上的身份和地址：管家协议门槛、Linux 账号与目录、端口、直连地址（桌面 / 流 / 名单 /
 * 日志 / 上传）、Gateway 对外地址。全是纯函数和常量，不碰库、不发请求。
 */
import { createHash, randomBytes } from 'node:crypto'
import type { Machine } from '../db.ts'
import { signLogsTicket, type JwtKeys } from '../crypto.ts'
import { HttpError } from '../http.ts'

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
 * 分流规则同 MIN_WORKER_PROTOCOL，判据写在 db.dueChannelEvents 的 scope 里（各方只取归自己的）。
 */
export const MIN_CHANNEL_WORKER_PROTOCOL = 8

/**
 * 席位工人接管**主 Bot 派活**（docs/bot-tasks.md）要求的管家协议号。12 号工人才有那条循环
 * （manager/src/worker/tasks.ts）；低于它的机器上派活当场记成「没跑起来：管家太旧」，不排队等。
 */
export const MIN_TASK_WORKER_PROTOCOL = 12

/**
 * 席位工作区按 bot 分格（`~/work/bots/<席位>` + 共享的 `~/work/shared`）的管家协议号。
 * **只管界面上怎么说**，不分流：部署规格里的 `workDir` 两边都还是 `~/work`，分格是管家的
 * deploy-seat.sh 自己做的。低于它的机器上照旧说「共享目录 ~/work」。
 *
 * 号数是机器的，格子是席位的：管家升到 13 之后、某个席位重铺之前，那个席位其实还是老布局。
 * 这一段只在审计页上当参考，差这一拍可以接受；要精确得让席位自己报，不值当。
 */
export const MIN_SPLIT_WORKDIR_PROTOCOL = 13

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
 * 管家自升级**直接去外部地址取包**要求的协议号。
 *
 * 3 号起（管家 0.1.22），upgrade.ts 只在包地址和配对的 Gateway 同源时才带机器票，
 * 别处的地址裸取；校验值一直是心跳里的 `sha256`、不看响应头。更老的管家对心跳给的任何
 * 地址都带着 `smt_` 去拉——给它 GitHub 地址等于把机器票寄给 GitHub，所以低于它的机器
 * 心跳里仍是 Gateway 转发地址。判据是 releases.ts 的 directReleaseUrl。
 */
export const MIN_DIRECT_MANAGER_DOWNLOAD_PROTOCOL = 3

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

/**
 * 账号级的 `~/work`。部署规格里的 `workDir` 就是它，管家照它推出两格：
 * `~/work/shared`（同一员工的所有席位共用）和 `~/work/bots/<席位>`（这个席位自己的）。
 * 见 sharedDirOf / botWorkDirOf，和管家的 deploy-seat.sh。
 */
export function workDirOf(linuxUser: string): string {
  return homeDirOf(linuxUser) + '/work'
}

/** 共享区。同一员工的所有席位都挂着它——放共享资料的地方。 */
export function sharedDirOf(linuxUser: string): string {
  return workDirOf(linuxUser) + '/shared'
}

/** 这个席位自己的工作区，也就是它那颗 Bot 的 `SATUWORK_WORK_DIR`。 */
export function botWorkDirOf(linuxUser: string, seatId: string): string {
  return workDirOf(linuxUser) + '/bots/' + seatId
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
  machine: (Pick<Machine, 'directUrl' | 'protocol'> & Partial<Pick<Machine, 'gatewayOrigin'>>) | null,
  seatId: string | null,
): { url: string; ticket: string; gatewayOrigin?: string } {
  const url = logsUrlOf(machine, seatId)
  if (!url) throw new HttpError(409, LOGS_NO_DIRECT)
  // 管家心跳自报的那个源最准（它就是按那个放行的）；老管家没报过才退回 Gateway 自己的公开地址。
  const origin = machine?.gatewayOrigin ? { gatewayOrigin: machine.gatewayOrigin } : gatewayOriginField()
  return { url, ticket: signLogsTicket(keys, seatId ? { seatId } : { manager: true }), ...origin }
}

/**
 * 管家放行跨源请求的那个源（manager/src/proxy.ts 的 corsFor：**只认配对时的 Gateway 地址**）。
 *
 * 浏览器直连管家（日志跟随这类）失败时分不出是网络不通还是跨源被拦——两种都是 fetch 抛错。
 * 后一种在本地很常见：管家按 `http://192.168.64.1:3080` 配的对，人却从 `http://localhost:3080`
 * 打开了页面，请求被浏览器拦下，界面只能说一句「连不上机器管家」。把这个源一起给出去，前端拿它
 * 和当前页面的源比，不一样就直接说清楚。只认明确配过的 GATEWAY_PUBLIC_URL：没配时那个回落值
 * 本来就是猜的，拿猜的去指点人只会更糊涂。
 */
export function gatewayOriginField(): { gatewayOrigin?: string } {
  const explicit = gatewayPublicUrlExplicit()
  if (!explicit) return {}
  try {
    return { gatewayOrigin: new URL(explicit).origin }
  } catch {
    return {}
  }
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

/** Gateway 反代聊天时打的地址。管家按 seatId 转到本机的 bot 口。 */
export function botBaseOf(managerHost: string | null, seatId: string): string {
  const base = (managerHost || '').trim().replace(/\/$/, '')
  if (!base || !seatId) return ''
  return `${base}/seats/${encodeURIComponent(seatId)}/bot`
}

export function randomVncPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const buf = randomBytes(16)
  let out = ''
  for (let i = 0; i < 16; i++) out += alphabet[buf[i]! % alphabet.length]
  return out
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
 * 这台机器装好管家并配对过了吗。
 *
 * 取代了原来的 `machineBound` + `machineHasSshAuth` 两级判断。以前「有地址」和
 * 「有登录凭据」是分开的两件事，现在配对是一次原子的事：要么两样都有，要么这台
 * 机器根本不存在。
 */
export function machinePaired(m: Machine | undefined): m is Machine {
  return Boolean(m && m.pairedAt && (m.host || '').trim() && m.token)
}
