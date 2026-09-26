/**
 * 机器配对，以及管家/实例回连 Gateway 的那一组（心跳、ready、会话索引）。
 */
import type { RouteCtx } from './ctx.ts'
import { HttpError, json, type Router } from '../http.ts'
import { MIN_MANAGER_NODE, desiredManagerRelease, gatewayBaseFor, machineHostOf, managerHostOf, managerPackageUrl, normalizePairingCode, sendReleaseFile } from '../lib/machines.ts'
import { MIN_MANAGER_PROTOCOL, botBaseOf, managerHealth, normalizeTimezone, publicMachine } from '../deploy.ts'
import { accessUrlFor } from '../lib/catalog.ts'
import { bodyOf, intField, strField } from '../lib/validate.ts'
import { callerAccountId, requireBootstrapMachine, requireInternalCaller, requireMachine } from '../lib/guards.ts'
import { instanceHostOf, sourceIpOf } from '../lib/runtime.ts'
import { METRIC_RETENTION_MS, MINUTE_MS, egressDelta, telemetryOf } from '../lib/telemetry.ts'
import { HANDOFF_STATES, type HandoffState, type Machine } from '../db.ts'
import { resolveAssignee } from '../lib/handoff.ts'
import { notify } from '../handoff-sweep.ts'
import { auditResultHash } from '../conversation-audit.ts'

/**
 * 席位报上来的 guard / outcome 只认这两张表里的值。
 *
 * 和 `gateway/src/lib/catalog.ts` 的 BOT_GUARD_IDS 是同一套键，外加 `escalate`、
 * `browser`、`memory`——转人工不是一条开关，浏览器那道硬黑名单也不是（它谁都关不掉），
 * 记忆那个「写入前需用户确认」是记忆面板上的独立勾，也不在那三条里；但它们都和那三条
 * 走同一条上报路。分开记是为了让翻审计的人看得出**是不是开关挡的**：一条 `no-external`
 * 的记录管理员可以去把开关关掉，一条 `browser` 的关不掉。
 *
 * **这张表必须跟着 bot/src/policy/index.ts 的 `GuardId` 一起改。** 漏了的话，席位那边
 * 拦得好好的，报上来一律 400——而席位的 outbox **没有重试上限**（session/gateway.ts 的
 * `flushOutbox` 只累加 attempts，从不丢弃），于是每一次拦截都变成一行永远重发的队列，
 * 审计里却一条记录都没有。「只拦不报」正是这条上报路存在的理由要防的事。
 */
const GUARD_IDS = new Set(['high-risk', 'pii', 'no-external', 'escalate', 'browser', 'memory'])
// `noted` 是事后补记的一笔（动作跑完了才发现它发出了写请求，而当时没弹过卡片），
// 不是一次表态。混在同一张表里上报，但看审计的人要分得出来。
const GUARD_OUTCOMES = new Set(['blocked', 'approved', 'denied', 'timeout', 'redacted', 'escalated', 'noted'])

export function attachInternal(router: Router, ctx: RouteCtx) {
  const { db } = ctx

  /**
   * 配对。**这条路由没有登录态**——配对码本身就是凭据，装机的人手里只有它。
   *
   * 做完三件事：签一把 `smt_`、把机器地址记成请求的来源 IP、**立刻回拨一次**确认
   * Gateway 真能打到这台机器。最后那一下不能省：不然「配对成功但打不通」会拖到第
   * 一次部署才暴露，那时装机的人已经离开机器了。
   *
   * 回拨用 challenge 而不是 `smt_`：那一刻票还在我们手里，管家还没收到响应。
   */
  router.post('/machines/pair', async (req, res) => {
    const body = bodyOf(req)
    const code = normalizePairingCode(strField(body, 'code'))
    const port = intField(body, 'managerPort') ?? 8443
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'managerPort 不合法')
    // int4 装得下才收。越界的值会让 PG 抛 22003，整条配对 500——和 runtime.ts 里
    // 那道 `have=99999999999` 的闸同一个道理。
    const protocolRaw = intField(body, 'protocol') ?? 0
    const protocol = Number.isInteger(protocolRaw) && protocolRaw >= 0 && protocolRaw <= 2_147_483_647 ? protocolRaw : 0
    const managerVersion = strField(body, 'managerVersion', false) || null
    const challenge = strField(body, 'challenge', false)

    const now = Date.now()
    const pairing = await db.machinePairing(code)
    // 不存在 / 用过 / 过期一律同一句话：区分了就是在帮人猜码。
    if (!pairing || pairing.usedAt || pairing.expiresAt <= now) throw new HttpError(401, '配对码无效或已过期')
    const company = await db.company(pairing.companyId)
    if (!company) throw new HttpError(404, '公司不存在')

    // 过了反代之后 socket 另一头是 127.0.0.1；sourceIpOf 只在 socket 源地址落在
    // GATEWAY_TRUSTED_PROXIES 名单里时才看 x-forwarded-for（见 lib/runtime.ts）。
    const ip = sourceIpOf(req)
    if (!ip) throw new HttpError(400, '取不到来源地址，无法配对')
    const host = managerHostOf(`${ip.includes(':') ? `[${ip}]` : ip}:${port}`)

    // 一家公司可以有多台机器。**同一个地址算同一台**——重跑装机脚本是修复手段，
    // 不该凭空多出一台机器；地址不同才是新增。重配会换一把新票，旧管家立刻失效。
    const existing = await db.machineByHost(company.id, host)
    const machine = await db.tx(async () => {
      let row: Machine
      if (existing) {
        await db.rotateMachineToken(existing.id)
        row = (await db.updateMachine(existing.id, {
          host,
          companyId: company.id,
          pairedAt: now,
          managerVersion,
          protocol,
          lastError: null,
        }))!
        row = (await db.machine(existing.id))!
      } else {
        row = await db.insertMachine({ companyId: company.id, host, pairedAt: now, managerVersion, protocol })
      }
      if (!(await db.claimMachinePairing(code, row.id, now))) throw new HttpError(401, '配对码无效或已过期')
      // machineId 现在只是「默认那台」，多机之后调度由 machineForAccount 决定。
      // 第一台配上时顺手把它设成默认，并补上访问地址。
      if (!company.machineId) {
        await db.updateCompany(company.id, {
          machineId: row.id,
          accessUrl: company.accessUrl ?? accessUrlFor(company.slug),
        })
      }
      await db.audit({
        companyId: company.id,
        accountId: pairing.createdBy,
        action: existing ? 'machine.repair' : 'machine.pair',
        detail: { machineId: row.id, host, managerVersion, protocol },
      })
      return row
    })

    const probe = challenge ? await managerHealth(host, { challenge }) : { ok: false, error: '没有 challenge，跳过回拨' }
    if (!probe.ok) await db.updateMachine(machine.id, { lastError: `Gateway 打不到 ${host}：${probe.error}` })
    json(res, 201, {
      machineId: machine.id,
      token: machine.token,
      host,
      reachable: probe.ok,
      error: probe.ok ? null : probe.error,
      protocolTooOld: protocol < MIN_MANAGER_PROTOCOL,
    })
  })

  // ── 机器服务凭证。登记用引导票；心跳 / ready / 索引 / 用量用每台机器的 smt_。──

  router.post('/internal/machines', async (req, res) => {
    requireBootstrapMachine(req)
    const body = bodyOf(req)
    const id = body.id != null ? strField(body, 'id', false) || undefined : undefined
    const rawHost = body.host != null ? strField(body, 'host', false) : ''
    const host = rawHost ? machineHostOf(rawHost) : null
    if (id && await db.machine(id)) throw new HttpError(409, '这台机器已经登记')
    const machine = await db.insertMachine({ id, host })
    json(res, 201, { machine: { ...publicMachine(machine), token: machine.token } })
  })

  /**
   * 心跳。也是自升级的下发通道。
   *
   * **升级是心跳驱动，不是 Gateway 推送**：推送要求推的那一刻机器在线且可达，
   * 心跳驱动只要机器最终上线就会收敛，灰度也只是改一个数字。响应里带上期望版本，
   * 管家发现和自己不一样就去换——换不换、什么时候换，由管家自己决定（部署跑到
   * 一半时它会跳过这一轮）。
   */
  /**
   * 管家的收尾回执：「席位停完了，我也要退出了」。收到就真删那一行。
   *
   * 收不到也不会卡住——墓碑有 TTL，sweepRemovedMachines 会收掉。回执的意义是让常见
   * 情况（机器活着、收到了信）当场干净收场，而不是干等十分钟。
   */
  router.post('/internal/machines/:id/removed', async (req, res) => {
    const machine = await requireMachine(req, db)
    if (machine.id !== req.params.id) throw new HttpError(403, '机器凭证与路径不符')
    if (!machine.removedAt) throw new HttpError(409, '这台机器没有被移除')
    await db.deleteMachine(machine.id)
    json(res, 200, { ok: true })
  })

  /** 上一次为哪台机器报过归档写失败。限流靠它，见 warnRollup。 */
  const rollupWarnedAt = new Map<string, number>()

  /**
   * 把一轮心跳累进它所属的那一分钟格。
   *
   * **CPU 报不出来的那一轮整笔不算。** 管家重启后的第一次采样只存基准（见
   * metrics.ts），那时 `cpu.usage` 是 null——把它当 0 记进去，重启就会在曲线上砸出
   * 一个假的谷；只补内存和盘的话，同一行里三个数就不是同一批采样了。一轮 30 秒，
   * 漏一笔比记错一笔便宜得多。
   *
   * 出网记的是**增量**：拿这一轮和上一轮的计数器相减（见 egressDelta）。
   *
   * **整块吞掉异常。** 心跳是 Gateway 对这台机器唯一的下行通道——升级版本、时区、
   * 日志上限都搭在它的响应里。归档写不进去（盘满、锁等超时）就让整轮心跳 500 的话，
   * 一个「少记一笔曲线」的毛病会连着把自升级和时区下发一起停掉，而界面上那盏灯还是
   * 绿的（lastHeartbeatAt 在这之前已经更新过了），谁也看不出控制面断了。
   */
  async function rollUp(before: Machine, after: Machine, telemetry: ReturnType<typeof telemetryOf>): Promise<void> {
    const m = telemetry?.metrics
    if (!m || m.cpu.usage == null) return
    const prevNet = before.telemetry?.metrics?.net
    const gap = before.telemetryAt ? (after.telemetryAt ?? Date.now()) - before.telemetryAt : 0
    // 盘取**最吃紧的那一块**：一台机器好几块盘，曲线上要看的是先满的那一块。
    const disk = m.disks.reduce((worst, d) => Math.max(worst, d.usage), 0)
    const minuteStart = Math.floor((after.telemetryAt ?? Date.now()) / MINUTE_MS) * MINUTE_MS
    // 这个 try 底下有**两条**碰 machine_metric_minutes 的路，而它们坏起来的原因不一样
    // （写不进去 vs 删不掉）。报错里带上是哪一条，否则日志上只剩一句 pg 的原话，查的人
    // 得回来数代码才知道该往哪儿看。
    let step = 'addMachineMetricSample'
    try {
      await db.addMachineMetricSample(after.id, minuteStart, {
        cpu: m.cpu.usage,
        mem: m.memory.usage,
        disk,
        tx: egressDelta(m.net.txBytes, prevNet?.txBytes, gap),
        rx: egressDelta(m.net.rxBytes, prevNet?.rxBytes, gap),
      })
      // 保留期在这里收，**不挂在「有人打开日视图」上**：写入是每 30 秒自动的，清理
      // 要是得等人去点一下，那句「只留 30 天」在没人看图的部署上就是空话。整点那一
      // 分钟扫一次，一台机器一小时一次，绝大多数时候是条没删到东西的索引删除。
      step = 'sweepMachineMetricMinutes'
      if (minuteStart % (60 * MINUTE_MS) === 0) await db.sweepMachineMetricMinutes(Date.now() - METRIC_RETENTION_MS)
    } catch (e) {
      warnRollup(after.id, step, e)
    }
  }

  /**
   * 归档写失败时说一句，但**别每 30 秒刷一遍**。
   *
   * 这类故障要么一瞬间过去、要么持续几小时（盘满），而后者按机器数乘以每分钟两轮，
   * 能把日志淹掉——真正要看的那几行反而被挤没了。同一台机器五分钟内只说一次。
   */
  function warnRollup(machineId: string, step: string, e: unknown): void {
    const now = Date.now()
    if (now - (rollupWarnedAt.get(machineId) ?? 0) < 5 * 60_000) return
    rollupWarnedAt.set(machineId, now)
    console.warn(
      `satuwork-gateway: 机器 ${machineId} 的负载归档写失败（心跳照常，${step}）：${e instanceof Error ? e.message : String(e)}`,
    )
  }

  router.post('/internal/machines/:id/heartbeat', async (req, res) => {
    const machine = await requireMachine(req, db)
    if (machine.id !== req.params.id) throw new HttpError(403, '机器凭证与路径不符')
    // 这台机器已经在平台上被移除了，这一下心跳就是把消息交给它的机会。
    //
    // **不更新任何字段**：它不在册了，写 lastHeartbeatAt 只会让墓碑看起来还活着。
    // 也不回 401——那是否定式信号，管家分不出「我被移除了」和「Gateway 那边出了
    // 状况」，据此自毁的话一次库回滚就能带走整个机队。见 Machine.removedAt。
    if (machine.removedAt) {
      json(res, 200, { removed: true, minNode: MIN_MANAGER_NODE, minProtocol: MIN_MANAGER_PROTOCOL })
      return
    }
    const body = (bodyOf(req) ?? {}) as Record<string, unknown>
    const managerVersion = typeof body.managerVersion === 'string' ? body.managerVersion.trim() : ''
    const protocol = Number(body.protocol)
    const upgradeError = typeof body.upgradeError === 'string' ? body.upgradeError.slice(0, 500) : null
    // 管家自报的 process.arch。只收认识的两个值——它决定给这台机器发哪个包，
    // 收一个乱七八糟的字符串只会让选包静默退回「按未知处理」。
    const rawArch = typeof body.arch === 'string' ? body.arch.trim() : ''
    const arch = rawArch === 'x64' || rawArch === 'arm64' ? rawArch : undefined
    // 管家自报的机器实际时区。**过一遍同一个校验器**——它来自网络，最后会显示在
    // 界面上；不认识的名字宁可当成「没报」，也不要存一个假的实际值进去，那会让
    // 「改上了没有」这个判断永远错。老管家不报，那时保持原样。
    const reportedTz = typeof body.timezone === 'string' ? normalizeTimezone(body.timezone) : undefined
    // 负载与日志占用。**整份按形状收**（见 lib/telemetry.ts）——它来自网络，会原样
    // 存进 jsonb 再画进浏览器。两份都没有（老管家）时 telemetryOf 给 undefined，
    // 那一格就不动：写一份空的进去会把上一轮好好的数据抹掉。
    const telemetry = telemetryOf(body, machine.telemetry)
    const next = await db.updateMachine(machine.id, {
      lastHeartbeatAt: Date.now(),
      // 采样时刻按**收到的时刻**记，不采信机器自报的 at：机器的钟可能是歪的，而
      // 界面上那句「3 分钟前」必须准。同一个理由见 publicMachine 的 heartbeatAge。
      ...(telemetry ? { telemetry, telemetryAt: Date.now() } : {}),
      ...(managerVersion ? { managerVersion } : {}),
      // 同上：越界的 protocol 一律不写。心跳是这台机器唯一的控制通道，让它 500
      // 等于把机器锁死在原地，而界面上那盏灯还亮着。
      ...(Number.isInteger(protocol) && protocol >= 0 && protocol <= 2_147_483_647 ? { protocol } : {}),
      ...(arch ? { arch } : {}),
      ...(reportedTz === undefined ? {} : { currentTimezone: reportedTz }),
      lastError: upgradeError,
    })
    // 把这一轮累进它所属的那一分钟。日视图从这张表来——`machines.telemetry` 只有
    // 「现在怎么样」，答不了「今天忙不忙、下午那阵卡是几点」。
    await rollUp(machine, next, telemetry)

    const desired = await desiredManagerRelease(db, next)
    json(res, 200, {
      machine: { id: next.id, lastHeartbeatAt: next.lastHeartbeatAt },
      desiredManagerVersion: desired?.version ?? null,
      url: desired ? managerPackageUrl(desired, next.protocol, gatewayBaseFor(req)) : null,
      sha256: desired?.sha256 ?? null,
      // 期望时区。空 = 没人指定过，管家什么都不做——**不是**「改成 UTC」。
      timezone: next.timezone,
      // journal 上限，MB。和时区一条路：这里只是下指令，清不清、什么时候清由管家
      // 决定。null = 没人指定过，管家跟自己的默认走；0 = 明确不要它动 journal。
      logCapMb: next.logCapMb,
      minNode: MIN_MANAGER_NODE,
      minProtocol: MIN_MANAGER_PROTOCOL,
    })
  })

  /** 管家自升级拉包。和 bot 发布包同一套鉴权：这台机器的 `smt_`。 */
  router.get('/internal/manager-releases/:version', async (req, res) => {
    await requireMachine(req, db)
    await sendReleaseFile(res, 'manager', req.params.version, db)
  })

  /**
   * 管家按版本拉 bot 发布包。**取代了原来逐席位 scp 一遍完整安装包**——同一版本
   * 一台机器只拉一次，解在 /opt/satuwork/releases 下全机共享。
   */
  router.get('/internal/bot-releases/:version', async (req, res) => {
    await requireMachine(req, db)
    await sendReleaseFile(res, 'bot', req.params.version, db)
  })

  /** Desktop 用自己的 sat_ 席位票拉本机运行包；机器管家票同样可用于发布自检。 */
  router.get('/internal/local-bot-releases/:version', async (req, res) => {
    await requireInternalCaller(req, db)
    await sendReleaseFile(res, 'local-bot', req.params.version, db)
  })

  router.post('/internal/instances/:accountId/ready', async (req, res) => {
    const caller = await requireInternalCaller(req, db)
    const account = await db.account(req.params.accountId)
    if (!account) throw new HttpError(404, '账号不存在')
    if (!account.companyId) throw new HttpError(403, '没有公司席位')
    if (account.companyId !== caller.companyId) throw new HttpError(403, '机器不属于这家公司')
    // 席位票只能报自己上线，不能替同公司的别人报。
    if (caller.kind === 'seat' && caller.account.id !== account.id) throw new HttpError(403, '席位票只能上报自己')
    const body = bodyOf(req)
    const botId = strField(body, 'botId')
    // 先校验 body.host 再查席位：它仍然是这条接口的输入契约，格式不对要 400，
    // 不能因为「席位还没部署」这个更靠后的原因把 400 盖成 404。
    const reportedHost = instanceHostOf(strField(bodyOf(req), 'host'))
    const seat = await db.seatRuntime(account.id, botId)
    if (!seat) throw new HttpError(404, '还没有部署')
    // 机器票只能替**自己机器上的**席位说话：同公司的另一台机器报上来，会把这个席位的
    // 反代入口改写成它自己的地址，之后 Gateway 就一直敲错机器。
    if (caller.kind === 'machine' && seat.machineId !== caller.machine.id) throw new HttpError(403, '这个席位不在这台机器上')
    // **不再采信 body.host。** bot 报的是自己看到的地址，而它只听 127.0.0.1；那个
    // 地址对管家是对的，对 Gateway 是打不通的。以前采信它，结果是 bot 一上线就把
    // Gateway 写好的地址覆盖成 loopback，之后 Gateway 再也打不到这个 bot。
    // 现在只认管家的反代入口，这条上报的意义只剩「我起来了」。
    //
    // 例外只有 stub：那条路径上根本没有管家，bot 自报是唯一的地址来源。
    const reported = process.env.SATUWORK_DEPLOY_STUB === '1' ? reportedHost : ''
    // 反代入口来自**席位实际所在**的那台机器。管家自己报时就是它自己；bot 用席位票
    // 报时按 seat.machineId 查——不能回落到公司默认机器，多机公司会写出错的地址。
    const machine = caller.kind === 'machine' ? caller.machine : await db.machine(seat.machineId)
    const instance = await db.upsertInstance({
      accountId: account.id,
      botId,
      companyId: account.companyId,
      host: reported || botBaseOf(machine?.host ?? null, seat.seatId),
    })
    json(res, 200, { instance })
  })

  router.post('/internal/sessions/index', async (req, res) => {
    const caller = await requireInternalCaller(req, db)
    const companyId = caller.companyId
    const body = bodyOf(req)
    const sessionId = strField(body, 'sessionId')
    const accountId = callerAccountId(caller, () => strField(body, 'accountId'))
    const bodyCompany = strField(body, 'companyId', false)
    if (bodyCompany && bodyCompany !== companyId) throw new HttpError(403, '机器不属于这家公司')
    const account = await db.account(accountId)
    if (!account || account.companyId !== companyId) throw new HttpError(403, '账号不属于这家公司')
    /**
     * 这条会话已经在册、而且不是这个人的：拒。
     *
     * `sessionId` 是上报方给的，可以是任何字符串。少了这一句，一台被拿下的席位报一个
     * 别人的 sessionId 就能把那一行改到自己名下——原主人从此打不开自己的会话
     * （seatTargetForSession 判的是 `idx.accountId !== account.id`），而他公司的会话
     * 列表和审计里那条也跟着改姓。db.upsertSessionIndex 的 where 是同一条判据的第二层
     * （竞态兜底）；这一句在这儿，是为了让正常情况回一句说得清的 403 而不是 500。
     */
    const known = await db.sessionIndex(sessionId)
    if (known && (known.accountId !== accountId || known.companyId !== companyId)) {
      throw new HttpError(403, '这条会话不属于这个账号')
    }
    const botIdRaw = body.botId == null ? undefined : strField(body, 'botId', false)
    const titleRaw = body.title == null ? undefined : strField(body, 'title', false)
    const originRaw = body.origin == null ? undefined : strField(body, 'origin', false)
    const remoteIdRaw = body.remoteId == null ? undefined : strField(body, 'remoteId', false)
    // machineId **一律服务端算**，不收 body。它决定了之后拉全文时 Gateway 去敲哪台
    // 机器、带哪把票；采信 body 等于让调用方指定这条会话「属于」哪台机器。
    // 席位票那条按**账号**查机器，不按 botId：会话根事件不一定带 botId（`data.botId ||
    // null`），按 botId 查的话这种会话就落不到机器上，拉全文时又回落到公司默认机器——
    // 正是 machineTokenFor 修掉的那个 host/token 错配。账号粘住机器（见
    // docs/gateway-runtime.md §3.0），所以取该账号任意一个席位的机器都是对的。
    const seatsOfAccount = await db.seatRuntimesOfAccount(accountId)
    // 机器票那条同样只认自己机器上的账号：这个人的席位一个都不在这台机器上，那这条
    // 索引就不是它该报的——写进去的 machineId 会让拉全文时敲到一台没有这条会话的机器。
    // 一个席位都没有的账号（老数据 / stub）放过，那时没有依据可核。
    if (caller.kind === 'machine' && seatsOfAccount.length && !seatsOfAccount.some((s) => s.machineId === caller.machine.id)) {
      throw new HttpError(403, '这个账号的席位不在这台机器上')
    }
    const machineId =
      caller.kind === 'machine'
        ? caller.machine.id
        : seatsOfAccount[0]?.machineId ?? null
    const session = await db.upsertSessionIndex({
      sessionId,
      companyId,
      accountId,
      botId: botIdRaw === undefined ? undefined : botIdRaw || null,
      machineId: machineId ?? undefined,
      origin: originRaw === undefined ? undefined : originRaw || null,
      remoteId: remoteIdRaw === undefined ? undefined : remoteIdRaw || null,
      messageCount: intField(body, 'messageCount'),
      title: titleRaw === undefined ? undefined : titleRaw || null,
      createdAt: intField(body, 'createdAt'),
      updatedAt: intField(body, 'updatedAt'),
    })
    json(res, 200, { session })
  })

  /**
   * 席位完成一个自动审计批次后，把有长度上限的结构化派生物报回来。
   * 原始事件不进这个接口；批次归属、模型与窗口全部以 Gateway 预先创建的那行回答为准。
   */
  router.put('/internal/conversation-audits/:jobId/result', async (req, res) => {
    const caller = await requireInternalCaller(req, db)
    const batch = await db.conversationAuditBatch(req.params.jobId)
    if (!batch) throw new HttpError(404, '审计批次不存在')
    if (batch.status === 'dead') throw new HttpError(409, '这个定时批次已由删除终审接管')
    if (caller.companyId !== batch.companyId) throw new HttpError(403, '批次不属于这家公司')
    const body = bodyOf(req)
    const accountId = callerAccountId(caller, () => strField(body, 'accountId'))
    if (accountId !== batch.accountId) throw new HttpError(403, '席位票只能上报自己的审计')
    if (strField(body, 'botId') !== batch.botId || strField(body, 'sessionId') !== batch.sessionId) {
      throw new HttpError(403, '审计目标与批次不一致')
    }
    const fromSeq = intField(body, 'fromSeq') ?? 0
    const toSeq = intField(body, 'toSeq') ?? 0
    const eventCount = intField(body, 'eventCount') ?? 0
    const turnCount = intField(body, 'turnCount') ?? 0
    if (fromSeq !== batch.fromSeq || toSeq < fromSeq || eventCount < 0 || turnCount < 0) {
      throw new HttpError(400, '审计覆盖范围不合法')
    }
    const sourceHash = strField(body, 'sourceHash', false)
    if (!/^[a-f0-9]{64}$/.test(sourceHash)) throw new HttpError(400, 'sourceHash 不合法')
    const rawItems = Array.isArray(body.items) ? body.items : []
    if (rawItems.length > 100) throw new HttpError(413, '一个审计批次最多 100 条')
    // 席位已经脱敏一次，但它是网络调用方，Gateway 落库前仍按字段值再做一道。
    const text = (v: unknown, max: number) => String(v ?? '').trim()
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已脱敏]')
      .replace(/(?<!\d)(?:\+?\d[\s-]?){8,15}(?!\d)/g, '[号码已脱敏]')
      .replace(/(?<!\d)\d{15,19}(?!\d)/g, '[长号码已脱敏]')
      .replace(/\b(?:sk|sat|smt)_[A-Za-z0-9_-]{8,}\b/g, '[凭证已脱敏]')
      .slice(0, max)
    const finite = (v: unknown, fallback = 0) => {
      const n = Number(v)
      return Number.isFinite(n) ? n : fallback
    }
    const outcomes = new Set(['completed', 'partial', 'failed', 'blocked', 'answered', 'unknown'])
    // 席位按派活时给的语言写（见 conversation-audit.ts 的 postAuditJob）并原样回报。老席位
    // 不回这一格——它们的提示词只会写中文，按 zh 记正好。
    const locale = body.locale === 'en' ? 'en' as const : 'zh' as const
    const items = rawItems.map((raw, index) => {
      const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
      const firstSeq = Math.trunc(finite(o.firstSeq, fromSeq))
      const lastSeq = Math.trunc(finite(o.lastSeq, toSeq))
      if (firstSeq < fromSeq || lastSeq < firstSeq || lastSeq > toSeq) throw new HttpError(400, '审计条目的 seq 越界')
      const timelineRaw = Array.isArray(o.timeline) ? o.timeline : []
      const timeline = timelineRaw.slice(0, 20).map((x) => {
        const row = x && typeof x === 'object' ? x as Record<string, unknown> : {}
        return { at: Math.trunc(finite(row.at)), action: text(row.action, 200) }
      })
      const breakdownRaw = o.scoreBreakdown && typeof o.scoreBreakdown === 'object' && !Array.isArray(o.scoreBreakdown)
        ? o.scoreBreakdown as Record<string, unknown> : {}
      const scoreBreakdown = Object.fromEntries(
        Object.entries(breakdownRaw).slice(0, 10).map(([k, v]) => [text(k, 40), Math.max(0, Math.min(100, finite(v)))]),
      )
      // 原因只收分项里有的那几个键：多出来的键没有分数可对，界面上也没地方摆。
      const reasonsRaw = o.scoreReasons && typeof o.scoreReasons === 'object' && !Array.isArray(o.scoreReasons)
        ? o.scoreReasons as Record<string, unknown> : {}
      const scoreReasons = Object.fromEntries(
        Object.entries(reasonsRaw)
          .map(([k, v]) => [text(k, 40), text(v, 400)] as const)
          // hasOwn 而不是 in：模型输出不可信，`in` 会把 toString / constructor 这类原型上的键也放过去。
          .filter(([k, v]) => v && Object.hasOwn(scoreBreakdown, k)),
      )
      // 每一项的满分：席位按它评分时用的规则写（不是模型填的）。同样只收分项里有的键。
      const maxRaw = o.scoreMax && typeof o.scoreMax === 'object' && !Array.isArray(o.scoreMax)
        ? o.scoreMax as Record<string, unknown> : {}
      const scoreMax = Object.fromEntries(
        Object.entries(maxRaw)
          .map(([k, v]) => [text(k, 40), Math.trunc(finite(v))] as const)
          .filter(([k, v]) => v > 0 && v <= 100 && Object.hasOwn(scoreBreakdown, k)),
      )
      const rawScore = o.modelScore == null ? null : Math.trunc(finite(o.modelScore))
      const rawConfidence = o.scoreConfidence == null ? null : finite(o.scoreConfidence)
      return {
        itemKey: text(o.itemKey, 100) || `item-${index + 1}`,
        firstSeq, lastSeq,
        startedAt: o.startedAt == null ? null : Math.trunc(finite(o.startedAt)),
        endedAt: o.endedAt == null ? null : Math.trunc(finite(o.endedAt)),
        taskSummary: text(o.taskSummary, 500), timeline,
        userQuestion: text(o.userQuestion, 500), modelAnswer: text(o.modelAnswer, 1000),
        finalResult: text(o.finalResult, 500),
        outcome: outcomes.has(String(o.outcome)) ? String(o.outcome) as any : 'unknown' as const,
        modelScore: rawScore == null ? null : Math.max(0, Math.min(100, rawScore)),
        scoreBreakdown,
        scoreReasons,
        scoreMax,
        scoreConfidence: rawConfidence == null ? null : Math.max(0, Math.min(1, rawConfidence)),
        evidence: (Array.isArray(o.evidence) ? o.evidence : []).slice(0, 10).map((x) => text(x, 200)),
        riskFlags: (Array.isArray(o.riskFlags) ? o.riskFlags : []).slice(0, 10).map((x) => text(x, 80)),
        locale,
      }
    })
    const resultHash = auditResultHash({ fromSeq, toSeq, eventCount, turnCount, sourceHash, items })
    if ((batch.status === 'succeeded' || batch.status === 'empty') && batch.resultHash !== resultHash) {
      throw new HttpError(409, '这个批次已经提交过不同的结果')
    }
    const account = await db.account(batch.accountId)
    const bot = await db.catalog(batch.botId)
    const settings = (await db.settings(batch.companyId)).conversationAudit
    const saved = await db.completeConversationAuditBatch({
      id: batch.id,
      status: items.length ? 'succeeded' : 'empty',
      fromSeq, toSeq, eventCount, turnCount, sourceHash, resultHash,
      botName: bot?.name || batch.botId,
      accountName: account?.name || account?.email || batch.accountId,
      retentionDays: settings.retentionDays,
      items,
    })
    json(res, 200, { batch: { id: saved.id, status: saved.status, resultHash: saved.resultHash } })
  })

  /**
   * 行为边界的表态。席位那边每拦一次、每批一次都往这里报一条。
   *
   * **它是这三个开关对管理员的全部价值。** 只拦不报的话，界面上开关开着、
   * 而没有任何一处回答得了「上个月拦了几次、拦的是谁、批的是谁」——那时候它是个
   * 心理安慰，不是一条合规证据。
   *
   * 用 `requireInternalCaller`：席位票 `sat_` 只能报自己那个账号（body 里的 accountId
   * 对它不作数），管家的机器票能替本机任意席位报。和会话索引那条是同一套口径。
   *
   * **落审计，不落新表。** 审计表已经有公司、账号、动作、详情、时间这五样，
   * 而这条记录要的就是这五样；另起一张表意味着「操作记录」那一屏要查两处，
   * 而人不会记得去第二处翻。
   */
  router.post('/internal/guard-events', async (req, res) => {
    const caller = await requireInternalCaller(req, db)
    const body = bodyOf(req)
    const accountId = callerAccountId(caller, () => strField(body, 'accountId'))
    const account = await db.account(accountId)
    if (!account || account.companyId !== caller.companyId) throw new HttpError(403, '账号不属于这家公司')

    const guard = strField(body, 'guard')
    const outcome = strField(body, 'outcome')
    // 白名单，不是原样收下：`action` 会进审计的检索面，让上报方自己定义动作名，
    // 那一栏迟早会长出十几种拼写。
    if (!GUARD_IDS.has(guard)) throw new HttpError(400, 'guard 不认识')
    if (!GUARD_OUTCOMES.has(outcome)) throw new HttpError(400, 'outcome 不认识')

    const event = await db.audit({
      companyId: caller.companyId,
      accountId,
      action: `bot.guard.${outcome}`,
      detail: {
        guard,
        tool: strField(body, 'tool', false),
        botId: strField(body, 'botId', false),
        sessionId: strField(body, 'sessionId', false),
        callId: strField(body, 'callId', false),
        // **理由是席位那边生成的一句中文，不含被拦下来的原值**（见 policy/pii.ts）。
        // 把刚拦住的号码抄进审计，等于挡了门又从窗户递出去。
        reason: strField(body, 'reason', false).slice(0, 500),
        at: intField(body, 'at') ?? Date.now(),
      },
    })
    json(res, 200, { event })
  })

  /**
   * 席位报一张交接单，或者它的一次状态流转（见 docs/handoff.md）。
   *
   * **id 由席位给。** 单号在会话日志里已经写下了，Gateway 再发一个自己的号，两边就
   * 再也对不上——而"点开这张单看正文"正是拿这个号去席位要的。
   *
   * **assignee 和 machineId 这边算，不收 body。** 前者要读公司模版和成员表（席位只
   * 认得自己那一个账号），后者决定之后敲哪台机器——采信 body 等于让调用方指定这张单
   * 属于哪台机器。和会话索引那条是同一套口径。
   *
   * 落**新表**而不是审计：审计答的是"上个月转了几次人工"，这张表答的是"现在还有几张
   * 没人接"。混在一起的话，待办页要在一堆历史记录里筛出当前状态，而那正是它每次打开
   * 都要做的事。留档那一条（`bot.guard.escalated`）照旧由 `/internal/guard-events` 写。
   */
  router.post('/internal/handoffs', async (req, res) => {
    const caller = await requireInternalCaller(req, db)
    const body = bodyOf(req)
    const accountId = callerAccountId(caller, () => strField(body, 'accountId'))
    const account = await db.account(accountId)
    if (!account || account.companyId !== caller.companyId) throw new HttpError(403, '账号不属于这家公司')

    const state = strField(body, 'state') as HandoffState
    if (!HANDOFF_STATES.includes(state)) throw new HttpError(400, 'state 不认识')

    const id = strField(body, 'id')
    /**
     * 这张单已经在册、而且不是这个人的：拒。和会话根那条同一个道理——`id` 是上报方
     * 给的，可以是任何字符串。少了这一句，一台被拿下的席位报一个别人的单号，下面
     * `known` 就成了别家公司那一行，它的 assignee / machineId 会被拿去复用，而
     * db.upsertHandoff 的 where 虽然挡得住写入，读回来那一行仍是原主人的。
     */
    const known = await db.handoff(id)
    if (known && (known.accountId !== accountId || known.companyId !== caller.companyId)) {
      throw new HttpError(403, '这张交接单不属于这个账号')
    }
    // 已经在册的不重算指派：人都接手了，模版这时候改了也不该把这张单从他手上挪走。
    const assignee = known ? known.assignee : await resolveAssignee(db, caller.companyId, accountId)
    const machineId =
      known?.machineId ??
      (caller.kind === 'machine'
        ? caller.machine.id
        : ((await db.seatRuntimesOfAccount(accountId))[0]?.machineId ?? null))

    /**
     * `claimedBy` 也得校验。
     *
     * 它和 accountId 一样是上报方给的，却一直没人查——一台被拿下的席位报一句
     * `state: 'claimed', claimedBy: '<某个管理员的 accountId>'`，审计里那条
     * `handoff.claimed` 就记在了那个管理员头上，待办页上的「谁接的」也跟着改姓。
     * 认不出的一律当没有：宁可丢掉一个署名，不能记错一个人。
     */
    const claimedByRaw = strField(body, 'claimedBy', false) || null
    let claimedBy: string | null = null
    if (claimedByRaw) {
      const who = await db.account(claimedByRaw)
      if (who && who.companyId === caller.companyId) claimedBy = who.id
    }

    const handoff = await db.upsertHandoff({
      id,
      sessionId: strField(body, 'sessionId'),
      botId: strField(body, 'botId', false),
      accountId,
      companyId: caller.companyId,
      machineId,
      state,
      assignee,
      claimedBy,
      blocking: body.blocking !== false,
      repeats: intField(body, 'repeats') ?? 0,
      reason: strField(body, 'reason', false),
      ask: strField(body, 'ask', false),
      createdAt: intField(body, 'createdAt') ?? Date.now(),
      updatedAt: intField(body, 'updatedAt') ?? Date.now(),
    })
    /**
     * 头一次见到这张单就往外推一条。
     *
     * **不 await**：席位那边在等这一跳的回执，而回执晚一秒，人点「接手」就晚一秒
     * 得到反馈。通知发失败也不该让上报失败——那张单已经落库了，站内照样看得见，
     * 而 outbox 那头会因为一个 500 把同一张单反复重报。
     */
    if (!known && handoff.state === 'open') void notify(db, handoff, 'new')
    /**
     * 状态流转进审计。
     *
     * 和 `bot.guard.escalated` 那条**并存，不合并**：那一条答的是「上个月转了几次
     * 人工」，这几条答的是「谁接的、什么时候接的、最后怎么收的场」。合成一条的话，
     * 一次转人工在审计里会变成一串长得差不多的行，而真正要问的那两个问题都答不了。
     *
     * `closed` 不记：那只是 Bot 把交还消化完了，不是人做的事。审计这一栏被机器动作
     * 刷满，人做的那几行就淹了。
     */
    if (handoff.state !== 'closed' && known?.state !== handoff.state) {
      await db.audit({
        companyId: caller.companyId,
        accountId: claimedBy || accountId,
        action: `handoff.${handoff.state}`,
        detail: {
          handoffId: handoff.id,
          botId: handoff.botId,
          sessionId: handoff.sessionId,
          ownerId: handoff.accountId,
          ask: handoff.ask.slice(0, 200),
          reason: handoff.reason.slice(0, 200),
        },
      })
    }
    json(res, 200, { handoff })
  })

  /**
   * 这里以前还有一条 `POST /internal/usage`：收下、查一遍租户边界、**不写库**。
   *
   * 它是旧版 bot 的兼容层——那时候 bot 在轮次结束时把这一轮的 token 报上来，
   * 而模型调用本来就是走 `/v1/chat/completions` 从 Gateway 出去的，那条路上
   * `recordLlmCall` 已经按请求记了一行 llm_calls。两边都记，用量直接翻倍。
   * 新版 bot 早就不发了（见 bot/src/session/gateway.ts），端点留着只是为了不让
   * 旧席位的本地重试队列卡死。旧版已经清理，这条一并拆掉。
   */
}
