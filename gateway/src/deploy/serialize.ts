/**
 * 机器和席位对外的样子：在线判断、给公司 / owner 看的机器卡、席位运行态。
 */
import { canonicalTimezone, type Machine, type SeatRuntime } from '../db.ts'
import { MIN_MANAGER_PROTOCOL, MIN_DIRECT_DESKTOP_PROTOCOL, MIN_SPLIT_WORKDIR_PROTOCOL, workDirOf, sharedDirOf, botWorkDirOf, portsOf, novncUrlOf, streamUrlOf, uploadUrlOf, machinePaired } from './paths.ts'

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
    // 员工要知道往哪儿放共享文件：同一个账号下的所有 bot 都看得见这个目录。老管家上整个
    // ~/work 就是共享的，也没有分到这个席位的那一格（见 MIN_SPLIT_WORKDIR_PROTOCOL）。
    ...((machine?.protocol ?? 0) >= MIN_SPLIT_WORKDIR_PROTOCOL
      ? { sharedDir: sharedDirOf(row.linuxUser), workDir: botWorkDirOf(row.linuxUser, row.seatId) }
      : { sharedDir: workDirOf(row.linuxUser), workDir: null }),
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
