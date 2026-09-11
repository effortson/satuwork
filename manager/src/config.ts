import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 管家的落盘状态。
 *
 * 两份东西分开放，因为寿命不一样：
 *
 * - `/etc/satuwork/manager.env`  安装脚本写的**启动参数**（Gateway 地址、配对码、监听口）。
 *   配对成功后安装脚本会把配对码从里面抹掉。
 * - `/etc/satuwork/manager.json` 配对**结果**（machineId、smt_ 票、Gateway 的公钥）。
 *   0600，只有 root 读得到。这是机器的身份，丢了就得重新配对。
 *
 * 目录可以用 `SATUWORK_MANAGER_HOME` 整体挪走——e2e 靠它在 /tmp 里跑，不碰 /etc。
 */

/**
 * 管家协议版本。**加了 Gateway 那侧要依赖的能力就 +1。**
 *
 * 2：`/seats/:id/vnc/*` 认机器票，桌面因此能从 Gateway 同域反代出去。1 号管家在这
 * 条路上只认票和 cookie，而反代过来的请求两样都没有——表现是浏览器上一句
 * 「桌面票无效或已过期」，跟票真的过期长得一模一样。Gateway 拿这个号数把两者分开。
 *
 * 3：`/seats/:id/progress` 报「这次部署走到第几步了」。号数在这里只用来**省一次
 * 白问**：老管家没有这条路，Gateway 照它决定要不要发那个请求，界面上退回到只有
 * 「已经装了几分钟」的粗进度（见 gateway 的 MIN_PROGRESS_PROTOCOL）。
 *
 * 4：浏览器直连那条路上，落地页自己插「关掉 noVNC 控制条」的样式，并钉
 * `frame-ancestors` 到 Gateway 的源。Gateway 拿这个号数决定**要不要真的把桌面交给
 * 直连**（见 gateway 的 MIN_DIRECT_DESKTOP_PROTOCOL）：机器配了 directUrl 但管家还是
 * 3 号，桌面照旧从 Gateway 反代——那一侧会插样式。少了这个号数，升级顺序一颠倒，
 * 同一块预览就会在有的机器上多出一条控件压着画面，而配置里看不出任何区别。
 *
 * 5：`/seats/:id/stream/*` 认**浏览器的登录 JWT**，验完换成这个席位的 `sat_` 转给 bot，
 * 对 Gateway 的源开 CORS。对话那条 SSE 于是能从浏览器直连这台机器，不再经 Gateway
 * 反代（见 docs/adr-gateway-vercel-neon.md §2.3、gateway 的 MIN_DIRECT_STREAM_PROTOCOL）。
 * 号数决定 Gateway **要不要把直连地址交给前端**：机器配了 directUrl 但管家还是 4 号，
 * 前端拿到的是 null，照旧走 Gateway——4 号管家上这条路是 404，前端会白试一轮再退回。
 *
 * 6：`/roster/stream` 认登录 JWT，把这个人在本机的所有席位合成一条名单流（roster.ts）。
 * Gateway 拿这个号数决定要不要给前端 `rosterStreamUrl`（见 gateway 的
 * MIN_DIRECT_ROSTER_PROTOCOL）。
 *
 * 7：机器上有工人（satuwork-worker.service，src/worker/index.ts）在领日常任务。Gateway 拿这个
 * 号数决定**这台机器的任务归谁跑**（见 gateway 的 MIN_WORKER_PROTOCOL）：≥7 它一下都不碰，
 * 全由工人来领；否则照旧自己发消息、等结果。号数错了的后果是两边各跑一遍或谁都不跑，
 * 所以工人单元没起来的机器不该报 7——安装脚本把用户、单元、令牌一起装好才会有这个号。
 *
 * 8：工人也接渠道那一轮（src/worker/channels.ts）：Telegram 消息进来之后「每 100ms 问席位、
 * 最长 20 分钟」那段在本机跑，草稿、审批卡、最终回复由 Gateway 代发。Gateway 拿这个号数决定
 * 这台机器上还没跑出回复的渠道事件归谁（gateway 的 MIN_CHANNEL_WORKER_PROTOCOL）。
 *
 * 9：`/logs` 与 `/seats/:id/logs` 认 Gateway 签的日志票（浏览器直连跟日志）；`/seats/:id/stream`
 * 放行 `POST /sessions/:id/files`（浏览器直连上传）。Gateway 拿这个号数决定给不给前端 logs /
 * upload 的直连地址（MIN_DIRECT_LOGS_PROTOCOL / MIN_DIRECT_UPLOAD_PROTOCOL）：8 号管家上前一条
 * 只认机器票，后一条是 405，前端不再退回 Gateway，所以号数不对就是一句报错。
 */
export const PROTOCOL = 9

export interface ManagerState {
  machineId: string
  /** 该机器的 `smt_`。调 Gateway 用它，也是 Gateway 调管家时要出示的那一把。 */
  token: string
  gatewayUrl: string
  pairedAt: number
  /** Gateway 的 JWKS，验桌面 ticket 用。配对时抓一次，kid 对不上时再抓。 */
  jwks: { keys: Record<string, unknown>[] } | null
  /** 自升级成功并且**心跳通过一次**之后才写。confirm timer 靠它判断要不要回滚。 */
  confirmedVersion: string
  /**
   * 上一次换版换到了哪个版本号。
   *
   * 用来熔断死循环：如果换完重启回来，自报版本仍然不是它，说明**包里的 VERSION 和
   * Gateway 上登记的版本号对不上**——再试一万次也一样，而每次尝试都要重启一次进程、
   * 掐断一次聊天。记下来，认出这种情况就停手并把原因报上去。
   */
  lastUpgradeTo: string
  /**
   * 上一次换版是什么时候（epoch 毫秒）。
   *
   * 回滚脚本靠它分辨「新版本连不上 Gateway」和「新版本还没来得及起来」。少了它，
   * 那个每 120 秒敲一次的定时器会把撞进升级窗口的一次好升级判成失败——见
   * src/seat/manager-confirm.sh 里的宽限期那一段。
   */
  lastUpgradeAt: number
  /**
   * `lastUpgradeTo` 那个版本被回滚脚本搬回来之后，又重试了几次。
   *
   * 「被回滚」有两种成因：包里的 VERSION 对不上是确定性的，重试一万次都一样；心跳不通
   * 却可能只是那一刻网络抖了。后者允许有限次重试（见 upgrade.ts 的 ROLLBACK_RETRY_MAX），
   * 这里记的就是已经用掉几次。换到别的版本、或者版本确认成功，都归零。
   */
  upgradeRetries: number
}

export function managerHome(...segments: string[]): string {
  const root = process.env.SATUWORK_MANAGER_HOME
    ? resolve(process.env.SATUWORK_MANAGER_HOME)
    : '/etc/satuwork'
  return segments.length ? join(root, ...segments) : root
}

export const statePath = () => managerHome('manager.json')

/** 席位名册。反代要靠它把 seatId 翻成端口，重启之后不能丢，所以落盘不放内存。 */
export const seatsPath = () => managerHome('seats.json')

/** 管家自己的安装根。`current` 符号链接指向当前版本，自升级换的就是它。 */
export function installRoot(): string {
  return resolve(process.env.SATUWORK_MANAGER_ROOT || '/opt/satuwork/manager')
}

/** 发布包缓存。bot 的 tgz 按版本解在这儿，全机共享——同一版本第二个席位不再重解。 */
export function releaseRoot(): string {
  return resolve(process.env.SATUWORK_RELEASE_ROOT || '/opt/satuwork/releases')
}

/** 本包里的 seat 资源目录（两个 .service 模板、两个启动脚本、两个部署脚本）。 */
export function seatAssets(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'seat')
}

/** 包自带的 VERSION 文件（pack.mjs 写的）。开发树里没有，回落到 dev。 */
export function managerVersion(): string {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  try {
    return readFileSync(join(root, 'VERSION'), 'utf8').trim() || 'dev'
  } catch {
    return 'dev'
  }
}

export function readState(): ManagerState | undefined {
  const path = statePath()
  if (!existsSync(path)) return
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<ManagerState>
    if (!raw.machineId || !raw.token || !raw.gatewayUrl) return
    return {
      machineId: raw.machineId,
      token: raw.token,
      gatewayUrl: raw.gatewayUrl.replace(/\/$/, ''),
      pairedAt: Number(raw.pairedAt) || 0,
      jwks: raw.jwks ?? null,
      confirmedVersion: raw.confirmedVersion ?? '',
      lastUpgradeTo: raw.lastUpgradeTo ?? '',
      lastUpgradeAt: Number(raw.lastUpgradeAt) || 0,
      upgradeRetries: Number(raw.upgradeRetries) || 0,
    }
  } catch {
    return
  }
}

/** 先写临时文件再 rename：断电或并发都不会留下半个 JSON，而半个 JSON = 机器失联。 */
export function writeState(state: ManagerState): void {
  const path = statePath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

/** patchState 每次落盘之后叫一下：index.ts 用它把内存里那份 state 跟磁盘对齐。 */
let onPatched: ((state: ManagerState) => void) | undefined
export function watchState(fn: (state: ManagerState) => void): void {
  onPatched = fn
}

/**
 * 就地改 manager.json：**现读磁盘、打补丁、写回**，读改写之间一个 await 都没有。
 *
 * 以前有三处各自「readState → 隔着一段 await → 整份 writeState」（adoptGatewayUrl、
 * maybeUpgrade、jwksOf），互相之间是整份覆盖的：adoptGatewayUrl 手里那份快照是启动时
 * 读的，等它落盘时会把 confirmVersion 刚写进磁盘的 confirmedVersion 抹回旧值——
 * 回滚脚本随即看到「current 是新版、confirmedVersion 还是旧版」，把一次好端端的升级搬
 * 回去并熔断。照 seats.ts 的 update() 那个写法：Node 单线程，三步之间不让出事件循环
 * 就是原子的。`patch` 回 undefined 表示这次不用改，不白写一次盘；写完（或者不用写）
 * 都把最终那份交给 watchState 登记的回调，内存里的 state 因此永远等于磁盘。
 *
 * 没配对（读不到 state）回 undefined，什么都不做。写盘失败照样抛出去，让调用方自己
 * 决定怎么说。
 */
export function patchState(patch: (state: ManagerState) => Partial<ManagerState> | undefined): ManagerState | undefined {
  const cur = readState()
  if (!cur) return
  const delta = patch(cur)
  const next = delta ? { ...cur, ...delta } : cur
  if (delta) writeState(next)
  onPatched?.(next)
  return next
}

export interface BootConfig {
  gatewayUrl: string
  pairingCode: string
  host: string
  port: number
  /** 跳过 deploy-seat.sh 与 systemd，用内存里的假席位状态作答。e2e 用。 */
  dryRun: boolean
}

export function bootConfig(): BootConfig {
  return {
    gatewayUrl: (process.env.GATEWAY_URL || '').trim().replace(/\/$/, ''),
    pairingCode: (process.env.SATUWORK_PAIRING_CODE || '').trim(),
    // 默认听所有网卡：Gateway 在别的机器上，这一个口就是全部对外面。
    host: process.env.SATUWORK_MANAGER_HOST || '0.0.0.0',
    port: Number(process.env.SATUWORK_MANAGER_PORT || 8443),
    dryRun: process.env.SATUWORK_MANAGER_DRYRUN === '1',
  }
}
