/**
 * 运行机器：登记与机器票、负载归档、配对码；外加登录失败计数和手机推送登记。
 */
import { randomUUID } from 'node:crypto'
import { randomMachineToken } from '../crypto.ts'
import { DEFAULT_MAX_ACCOUNTS, type Machine, type MachineMetricMinute, type MachinePairing } from './types.ts'
import { isUniqueViolation, machineMetricMinuteOf, machineOf, machinePairingOf } from './rows.ts'
import { DbCore } from './core.ts'

export class MachinesDb extends DbCore {
  // ── 机器 ──────────────────────────────────────────────────────────────

  async insertMachine(input: {
    id?: string
    host?: string | null
    companyId?: string | null
    pairedAt?: number | null
    managerVersion?: string | null
    protocol?: number
    maxAccounts?: number
  }): Promise<Machine> {
    const base = {
      id: input.id ?? randomUUID(),
      host: input.host ?? null,
      // 直连地址由管理员在铺好证书之后单独填（见迁移 0038）。配对这一刻填不了：
      // 那时机器上还没有 nginx，也还没有域名。
      directUrl: null as string | null,
      companyId: input.companyId ?? null,
      lastHeartbeatAt: null as number | null,
      createdAt: Date.now(),
      pairedAt: input.pairedAt ?? null,
      managerVersion: input.managerVersion ?? null,
      protocol: input.protocol ?? 0,
      lastError: null as string | null,
      // 配对时还不知道架构，等第一次心跳带上来。
      arch: null as string | null,
      desiredManagerVersion: null as string | null,
      maxAccounts: input.maxAccounts ?? DEFAULT_MAX_ACCOUNTS,
      // 时区默认不管：没人指定之前，机器装成什么样就是什么样。
      timezone: null as string | null,
      currentTimezone: null as string | null,
      // 自报数据等第一次心跳；日志上限空着 = 跟管家的默认走（**不是** 0，0 是「别清」）。
      telemetry: null as Machine['telemetry'],
      telemetryAt: null as number | null,
      logCapMb: null as number | null,
      // 管家认的 Gateway 源也等第一次心跳报上来。
      gatewayOrigin: null as string | null,
      // 域名 https 由人在机器页上按下去才开始。
      https: null as Machine['https'],
      // 新登记的机器当然在册。墓碑只由 markMachineRemoved 立。
      removedAt: null as number | null,
    }
    for (let i = 0; i < 8; i++) {
      const row: Machine = { ...base, token: randomMachineToken() }
      try {
        await this.savepoint(() =>
          this.run(
            'insert into machines (id, host, "companyId", "lastHeartbeatAt", "createdAt", "pairedAt", "managerVersion", protocol, "lastError", arch, "desiredManagerVersion", "maxAccounts", timezone, "currentTimezone", "logCapMb", token) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            [
              row.id,
              row.host,
              row.companyId,
              row.lastHeartbeatAt,
              row.createdAt,
              row.pairedAt,
              row.managerVersion,
              row.protocol,
              row.lastError,
              row.arch,
              row.desiredManagerVersion,
              row.maxAccounts,
              row.timezone,
              row.currentTimezone,
              row.logCapMb,
              row.token,
            ],
          ),
        )
        return row
      } catch (e) {
        if (i === 7 || !isUniqueViolation(e)) throw e
      }
    }
    throw new Error('无法签发机器凭证')
  }

  /**
   * 换一把新的机器票。重新配对时用——旧管家（或者捡到旧票的人）立刻失效。
   * `insertMachine` 那边 token 是不可更新的，这里是唯一的轮换口子。
   */
  async rotateMachineToken(id: string): Promise<Machine | undefined> {
    for (let i = 0; i < 8; i++) {
      try {
        await this.savepoint(() => this.run('update machines set token = ? where id = ?', [randomMachineToken(), id]))
        return this.machine(id)
      } catch (e) {
        if (i === 7 || !isUniqueViolation(e)) throw e
      }
    }
    throw new Error('无法签发机器凭证')
  }

  /**
   * 按 id 取一台**在册**的机器。墓碑当不存在——它对界面来说已经被移除了。
   *
   * 唯一看得见墓碑的是 `machineByToken`（心跳要靠它把「你被移除了」送下去）。
   */
  async machine(id: string): Promise<Machine | undefined> {
    const r = await this.one('select * from machines where id = ? and "removedAt" is null', [id])
    return r ? machineOf(r) : undefined
  }

  /**
   * 按机器票取，**墓碑也返回**。
   *
   * 这是整个库里唯一看得见墓碑的查询，而且必须看得见：移除之后管家还会照常心跳，
   * 那一下正是把「你被移除了」交给它的唯一机会。`requireMachine` 默认把墓碑挡在外面，
   * 只有心跳和收尾回执显式放行（`allowRemoved`），别的地方不要直接拿它鉴权。
   */
  async machineByToken(token: string): Promise<Machine | undefined> {
    if (!token) return undefined
    const r = await this.one('select * from machines where token = ?', [token])
    return r ? machineOf(r) : undefined
  }

  /** 立墓碑。席位登记和公司默认机器的指向由调用方在同一个事务里先处理掉。 */
  async markMachineRemoved(id: string, at: number): Promise<void> {
    await this.run('update machines set "removedAt" = ? where id = ?', [at, id])
  }

  /**
   * 收掉过期的墓碑。
   *
   * 管家一直不来收信（机器已经关机、网线拔了、被重装了）时，墓碑不能永远躺着。
   * 不开定时器：读列表和删机器时各扫一次就够——这两处的频率远高于 TTL，而代价是
   * 一条走主键之外单列的 delete。
   */
  async sweepRemovedMachines(before: number): Promise<number> {
    // 归档先走。**这条路才是常态**——机器一直没回来收信的，最后都是从这儿被硬删掉
    // 的；只在 deleteMachine 里清的话，恰恰是「再也没回来那台」的四万多行永远留着。
    // 先删归档再删机器行：反过来的话，机器行没了就再也定位不到它的归档（同
    // deleteSeatRuntimesOfMachine 里 instances 排在前面的理由）。
    await this.run(
      'delete from machine_metric_minutes where "machineId" in (select id from machines where "removedAt" is not null and "removedAt" < ?)',
      [before],
    )
    return this.run('delete from machines where "removedAt" is not null and "removedAt" < ?', [before])
  }

  /**
   * 平台上登记过的所有机器，登记先后。
   *
   * **包括没派给任何公司的那些**（`companyId is null`）：机器管理页要答的是「平台上
   * 现在有哪些机器」，而一台刚配对完还没分配、或者原公司被删之后落单的机器，恰恰是
   * 最需要被人看见的——按公司去列永远列不到它们。
   */
  async allMachines(): Promise<Machine[]> {
    const rows = await this.many('select * from machines where "removedAt" is null order by "createdAt"')
    return rows.map(machineOf)
  }

  /** 这家公司的所有机器，登记先后。多机调度按这个顺序做兜底排序。 */
  async machinesOfCompany(companyId: string): Promise<Machine[]> {
    const rows = await this.many('select * from machines where "companyId" = ? and "removedAt" is null order by "createdAt"', [companyId])
    return rows.map(machineOf)
  }

  /** 按管家基址找机器。重跑装机脚本时靠它认出「还是那一台」，而不是凭空多一台。 */
  async machineByHost(companyId: string, host: string): Promise<Machine | undefined> {
    if (!host) return undefined
    const r = await this.one('select * from machines where "companyId" = ? and host = ? and "removedAt" is null', [companyId, host])
    return r ? machineOf(r) : undefined
  }

  async machineOfCompany(companyId: string): Promise<Machine | undefined> {
    // 公司名下不止一台时要有确定的答案：没有 order by 的话，PG 给哪一行取决于物理顺序，
    // 两次调用可能答两台不同的机器。取最早配对的那台，和 machinesOfCompany 的兜底顺序一致。
    const r = await this.one(
      'select * from machines where "companyId" = ? and "removedAt" is null order by "pairedAt" nulls last, "createdAt", id limit 1',
      [companyId],
    )
    return r ? machineOf(r) : undefined
  }

  /** 只删登记，不碰机器。上面还有席位的话，先走 deleteSeatRuntimesOfMachine。 */
  async deleteMachine(id: string): Promise<void> {
    // 归档跟着一起走。表上没有外键级联（那张表是按 machineId 裸存的），不在这儿删
    // 的话，一台被移除的机器会在库里留下四万多行没人认领的曲线——保留期最终会收掉
    // 它们，但那是三十天之后的事，而且中间谁也查不出这些行属于谁。
    await this.run('delete from machine_metric_minutes where "machineId" = ?', [id])
    await this.run('delete from machines where id = ?', [id])
  }

  /**
   * 抹掉这台机器上所有席位的**登记**（不碰机器上的进程）。
   *
   * 跟 deleteMachine 是一对，必须同进同出：只删机器不删席位的话，那些行会留着一个
   * 指向不存在机器的 machineId，而 machineTokenFor 查不到就会**回落到这家公司的另
   * 一台机器**——聊天请求于是带着别的机器的票发出去，静默打到错的地方。
   *
   * instances 要一起删，而且**得在 seat_runtimes 之前**：那张表没有 machineId，只能
   * 顺着席位行去找；先删席位就没法定位了。它存的是 bot 的反代前缀，留着同样是一个
   * 指向已移除机器的旧地址。
   *
   * 会话索引同理：正文在那台机器的席位目录里，机器没了索引就成了永远打不开的入口
   * （跟 deleteSeatRuntimeOf 一个道理）。session_index 自己带 machineId，直接按它删。
   */
  async deleteSeatRuntimesOfMachine(machineId: string): Promise<number> {
    if (!machineId) return 0
    return this.tx(async () => {
      await this.run(
        'delete from instances i using seat_runtimes s where s."machineId" = ? and i."accountId" = s."accountId" and i."botId" = s."botId"',
        [machineId],
      )
      await this.run('delete from session_index where "machineId" = ?', [machineId])
      return this.run('delete from seat_runtimes where "machineId" = ?', [machineId])
    })
  }

  /**
   * 只在 `https` 还是调用方读到的那一份（nonce 和 stage 都对得上）时才写，返回写上没有。
   *
   * 心跳推进域名 https 时要先做十来秒的网络探测（deploy/https.ts）。这期间有人在机器页上按了
   * 「重新开始」或「撤掉」，updateMachine 那种整格写回会拿探测前读到的旧记录把它盖掉——撤掉的
   * 流程被复活，管家还会被叫去只听回环。条件写让后来的人按的那一下赢。
   */
  async casMachineHttps(id: string, expect: { nonce: string; stage: string }, next: Machine['https']): Promise<boolean> {
    const n = await this.run(
      `update machines set https = ? where id = ? and "removedAt" is null and https->>'nonce' = ? and https->>'stage' = ?`,
      [next == null ? null : JSON.stringify(next), id, expect.nonce, expect.stage],
    )
    return n === 1
  }

  async updateMachine(
    id: string,
    patch: Partial<
      Pick<
        Machine,
        | 'host'
        | 'directUrl'
        | 'companyId'
        | 'lastHeartbeatAt'
        | 'pairedAt'
        | 'managerVersion'
        | 'protocol'
        | 'lastError'
        | 'arch'
        | 'desiredManagerVersion'
        | 'maxAccounts'
        | 'timezone'
        | 'currentTimezone'
        | 'telemetry'
        | 'telemetryAt'
        | 'logCapMb'
        | 'gatewayOrigin'
        | 'https'
      >
    >,
  ): Promise<Machine> {
    const cur = await this.machine(id)
    if (!cur) throw new Error('机器不存在')
    const next: Machine = {
      ...cur,
      host: patch.host === undefined ? cur.host : patch.host,
      directUrl: patch.directUrl === undefined ? cur.directUrl : patch.directUrl,
      companyId: patch.companyId === undefined ? cur.companyId : patch.companyId,
      lastHeartbeatAt: patch.lastHeartbeatAt === undefined ? cur.lastHeartbeatAt : patch.lastHeartbeatAt,
      pairedAt: patch.pairedAt === undefined ? cur.pairedAt : patch.pairedAt,
      managerVersion: patch.managerVersion === undefined ? cur.managerVersion : patch.managerVersion,
      protocol: patch.protocol === undefined ? cur.protocol : patch.protocol,
      lastError: patch.lastError === undefined ? cur.lastError : patch.lastError,
      arch: patch.arch === undefined ? cur.arch : patch.arch,
      desiredManagerVersion:
        patch.desiredManagerVersion === undefined ? cur.desiredManagerVersion : patch.desiredManagerVersion,
      maxAccounts: patch.maxAccounts === undefined ? cur.maxAccounts : patch.maxAccounts,
      timezone: patch.timezone === undefined ? cur.timezone : patch.timezone,
      currentTimezone: patch.currentTimezone === undefined ? cur.currentTimezone : patch.currentTimezone,
      telemetry: patch.telemetry === undefined ? cur.telemetry : patch.telemetry,
      telemetryAt: patch.telemetryAt === undefined ? cur.telemetryAt : patch.telemetryAt,
      logCapMb: patch.logCapMb === undefined ? cur.logCapMb : patch.logCapMb,
      gatewayOrigin: patch.gatewayOrigin === undefined ? cur.gatewayOrigin : patch.gatewayOrigin,
      https: patch.https === undefined ? cur.https : patch.https,
    }
    await this.run(
      'update machines set host=?, "directUrl"=?, "companyId"=?, "lastHeartbeatAt"=?, "pairedAt"=?, "managerVersion"=?, protocol=?, "lastError"=?, arch=?, "desiredManagerVersion"=?, "maxAccounts"=?, timezone=?, "currentTimezone"=?, telemetry=?, "telemetryAt"=?, "logCapMb"=?, "gatewayOrigin"=?, https=? where id=?',
      [
        next.host,
        next.directUrl,
        next.companyId,
        next.lastHeartbeatAt,
        next.pairedAt,
        next.managerVersion,
        next.protocol,
        next.lastError,
        next.arch,
        next.desiredManagerVersion,
        next.maxAccounts,
        next.timezone,
        next.currentTimezone,
        // jsonb 那一列要的是文本，pg 的参数绑定不会替我们把对象序列化。
        next.telemetry == null ? null : JSON.stringify(next.telemetry),
        next.telemetryAt,
        next.logCapMb,
        next.gatewayOrigin,
        next.https == null ? null : JSON.stringify(next.https),
        id,
      ],
    )
    return next
  }

  // ── 负载归档。心跳每 30 秒往当前那一分钟的格子里累一笔（见迁移 0012）。──

  /**
   * 把这一轮心跳累进它所属的那一分钟。
   *
   * **一条 upsert，不读不算**：累加是纯 `+`、峰值取 `greatest`，两轮心跳撞在一起也
   * 不会互相盖掉。读出来再改写的话，同一台机器重连时那两笔就会丢一笔。
   *
   * `tx`/`rx` 收的是**这一段时间走了多少字节**（增量），不是计数器快照——调用方拿
   * 相邻两轮的差算，计数器倒退（机器重启）时给 0。
   */
  async addMachineMetricSample(
    machineId: string,
    minuteStart: number,
    s: { cpu: number; mem: number; disk: number; tx: number; rx: number },
  ): Promise<void> {
    await this.run(
      `insert into machine_metric_minutes
         ("machineId", "minuteStart", samples, "cpuSum", "cpuMax", "memSum", "memMax", "diskSum", "diskMax", "txBytes", "rxBytes")
       values (?,?,1,?,?,?,?,?,?,?,?)
       on conflict ("machineId", "minuteStart") do update set
         samples   = machine_metric_minutes.samples + 1,
         "cpuSum"  = machine_metric_minutes."cpuSum"  + excluded."cpuSum",
         "cpuMax"  = greatest(machine_metric_minutes."cpuMax",  excluded."cpuMax"),
         "memSum"  = machine_metric_minutes."memSum"  + excluded."memSum",
         "memMax"  = greatest(machine_metric_minutes."memMax",  excluded."memMax"),
         "diskSum" = machine_metric_minutes."diskSum" + excluded."diskSum",
         "diskMax" = greatest(machine_metric_minutes."diskMax", excluded."diskMax"),
         "txBytes" = machine_metric_minutes."txBytes" + excluded."txBytes",
         "rxBytes" = machine_metric_minutes."rxBytes" + excluded."rxBytes"`,
      [machineId, minuteStart, s.cpu, s.cpu, s.mem, s.mem, s.disk, s.disk, Math.round(s.tx), Math.round(s.rx)],
    )
  }

  /** 一段时间里的分钟格，按时间升序。**没有数据的分钟不会有行**——那是空档，不是 0。 */
  async machineMetricMinutes(machineId: string, from: number, to: number): Promise<MachineMetricMinute[]> {
    const rows = await this.many(
      'select * from machine_metric_minutes where "machineId" = ? and "minuteStart" >= ? and "minuteStart" < ? order by "minuteStart"',
      [machineId, from, to],
    )
    return rows.map(machineMetricMinuteOf)
  }

  /**
   * 收掉过保留期的归档。
   *
   * 一台机器一天 1440 行，三十天四万多行——**这个量必须真的被清**，不像别处那些顺手
   * 扫一扫的表。所以调用点挂在**心跳**上（每台机器整点那一分钟一次，见 internal.ts
   * 的 rollUp），不挂在任何一条要人点开才会走的路上：写入是每 30 秒自动的，清理要是
   * 得等人打开日视图，那句「只留 30 天」在没人看图的部署上就是空话。
   */
  async sweepMachineMetricMinutes(before: number): Promise<number> {
    return this.run('delete from machine_metric_minutes where "minuteStart" < ?', [before])
  }

  // ── 登录类接口的失败计数（lib/auth-throttle.ts，迁移 0046）。──
  //
  // 一次登录同时碰「邮箱桶」和「IP 桶」两行，而且是分两条语句碰的（先记、后退）。**这里每一条
  // 碰多行的语句都按 `key collate "C"` 的顺序拿行锁**，一个都不能例外：
  //
  // 原来记一次是 `values (email), (ip)`——按传进来的顺序锁 email 再锁 ip；退回去是
  // `update ... where key = any(...)`——这张表小，走顺序扫描，按行在堆里的物理位置锁。IP 行
  // 被反复改写、新版本在页里前后挪，于是时而先 ip 后 email，和前者正好反过来：同一个邮箱
  // 并发打进来一批，一条在记、一条在退，互相等对方手里那一行，PG 判死锁、杀掉其中一条，
  // 用户拿到 500，计数还漏记 / 多记一笔（CI 上间歇性挂在 auth-throttle 那组，本地一批 20
  // 并发十轮能撞七轮）。
  //
  // 定序只能在库里定：`insert ... select ... order by` 按排好的次序逐行 upsert；更新和删除
  // 先 `select ... order by ... for update` 把行按次序锁上，外层语句再动这些已经锁住的行。
  // 显式写 `collate "C"`，不跟着库的默认排序规则走，几条语句保证是同一个次序。

  /**
   * 给这几个桶各记一次，**一条语句、原子地**拿回记完之后的数。
   *
   * 先记后验：并发打进来的 N 条请求各自拿到 1..N，不会都读到「还差一次」然后一起放行。
   * 窗口到期的行就地从 1 重新数起，不依赖清扫是否已经跑过。
   */
  async bumpAuthThrottle(keys: string[], now: number, windowMs: number): Promise<{ key: string; count: number; resetAt: number }[]> {
    if (!keys.length) return []
    const rows = await this.many(
      `insert into auth_throttle (key, count, "resetAt")
       select k, 1, ?::bigint from unnest(?::text[]) as k order by k collate "C"
       on conflict (key) do update set
         count = case when auth_throttle."resetAt" <= ? then 1 else auth_throttle.count + 1 end,
         "resetAt" = case when auth_throttle."resetAt" <= ? then excluded."resetAt" else auth_throttle."resetAt" end
       returning key, count, "resetAt"`,
      [now + windowMs, [...new Set(keys)], now, now],
    )
    return rows.map((r) => ({ key: String(r.key), count: Number(r.count), resetAt: Number(r.resetAt) }))
  }

  /** 把先记上的那一次退回去（这次没被评判，或者评判结果是对的）。 */
  async refundAuthThrottle(keys: string[]): Promise<void> {
    if (!keys.length) return
    await this.run(
      `update auth_throttle t set count = greatest(t.count - 1, 0)
       from (select key from auth_throttle where key = any(?::text[]) order by key collate "C" for update) l
       where t.key = l.key`,
      [keys],
    )
  }

  /** 整个桶清零：口令对了，这个邮箱之前的失败一笔勾销。 */
  async clearAuthThrottle(keys: string[]): Promise<void> {
    if (!keys.length) return
    await this.run(
      `delete from auth_throttle t
       using (select key from auth_throttle where key = any(?::text[]) order by key collate "C" for update) l
       where t.key = l.key`,
      [keys],
    )
  }

  /** 清扫到期的桶。正被登录碰着的行跳过（skip locked），下一轮再收，清扫不去和登录抢锁。 */
  async sweepAuthThrottle(now: number): Promise<number> {
    return this.run(
      `delete from auth_throttle t
       using (select key from auth_throttle where "resetAt" <= ? order by key collate "C" for update skip locked) l
       where t.key = l.key`,
      [now],
    )
  }

  // ── 手机推送的设备登记（0055，lib/push.ts）。令牌是主键：换账号登录就改姓。──

  async upsertPushDevice(d: { token: string; accountId: string; platform: string; environment: string }, now: number): Promise<void> {
    await this.run(
      `insert into push_devices (token, "accountId", platform, environment, "createdAt", "updatedAt")
       values (?, ?, ?, ?, ?, ?)
       on conflict (token) do update set
         "accountId" = excluded."accountId", platform = excluded.platform,
         environment = excluded.environment, "updatedAt" = excluded."updatedAt"`,
      [d.token, d.accountId, d.platform, d.environment, now, now],
    )
  }

  /** 只删自己名下的那一行：令牌是客户端报的，别人的令牌不该能被这条路摘掉。 */
  async deletePushDevice(accountId: string, token: string): Promise<boolean> {
    return (await this.run(`delete from push_devices where token = ? and "accountId" = ?`, [token, accountId])) > 0
  }

  /** APNs 说这个令牌已经作废（410 / BadDeviceToken）：不问是谁的，直接摘。 */
  async dropPushDevice(token: string): Promise<void> {
    await this.run(`delete from push_devices where token = ?`, [token])
  }

  async pushDevicesOf(accountId: string): Promise<{ token: string; platform: string; environment: string; updatedAt: number }[]> {
    const rows = await this.many(
      `select token, platform, environment, "updatedAt" from push_devices where "accountId" = ? order by "updatedAt" desc`,
      [accountId],
    )
    return rows.map((r) => ({ token: String(r.token), platform: String(r.platform), environment: String(r.environment), updatedAt: Number(r.updatedAt) }))
  }

  // ── 配对码。一次性、30 分钟过期，装管家时拿它换这台机器的 smt_。──

  async insertMachinePairing(row: MachinePairing): Promise<MachinePairing> {
    await this.run(
      'insert into machine_pairings (code, "companyId", "createdBy", "createdAt", "expiresAt", "usedAt", "machineId") values (?,?,?,?,?,?,?)',
      [row.code, row.companyId, row.createdBy, row.createdAt, row.expiresAt, row.usedAt, row.machineId],
    )
    return row
  }

  async machinePairing(code: string): Promise<MachinePairing | undefined> {
    if (!code) return undefined
    const r = await this.one('select * from machine_pairings where code = ?', [code])
    return r ? machinePairingOf(r) : undefined
  }

  /**
   * 认领一个配对码。**未用过才认领得到**——`usedAt is null` 写在 where 里，两台机器
   * 同时拿同一个码时数据库来裁决，不靠先查后写那种竞态。
   */
  async claimMachinePairing(code: string, machineId: string, now: number): Promise<boolean> {
    const n = await this.run(
      'update machine_pairings set "usedAt" = ?, "machineId" = ? where code = ? and "usedAt" is null and "expiresAt" > ?',
      [now, machineId, code, now],
    )
    return n > 0
  }

  /** 同一家公司再生成一个码时，把之前没用掉的作废——桌上不该同时躺着两张有效的票。 */
  async expireMachinePairings(companyId: string, now: number): Promise<void> {
    await this.run('update machine_pairings set "expiresAt" = ? where "companyId" = ? and "usedAt" is null and "expiresAt" > ?', [
      now,
      companyId,
      now,
    ])
  }
}
