/**
 * 运行机器：公司侧绑定与配对码，平台侧的机器管理、发布包、装机脚本、批量升级。
 */
import type { RouteCtx } from './ctx.ts'
import { HttpError, json, type Router } from '../http.ts'
import { INSTANCE_DOWN, MIN_MANAGER_NODE, PAIRING_TTL, desiredManagerRelease, directUrlOf, gatewayBaseFor, installCommandFor, machineBase, machineCard, machineOfOrg, machineResolver, managerHostOf, normalizePairingCode, randomPairingCode, registerFromBody, sendReleaseFile } from '../lib/machines.ts'
import { LOGS_FOLLOW_GONE, MACHINE_TOMBSTONE_TTL, MIN_MANAGER_PROTOCOL, type MachineLoad, companyMachineOf, deploySeat, gatewayPublicUrl, gatewayPublicUrlExplicit, logsDirectPayload, machineLink, machineLoadOf, machineLoads, machinePaired, managerHealth, normalizeTimezone, ownerMachine, probeDirectUrl, publicSeatRuntime, rehostSeatInstances, releaseSeats } from '../deploy.ts'
import { accessUrlFor } from '../lib/catalog.ts'
import { bodyOf, intField, strField } from '../lib/validate.ts'
import { installScript } from '../install.ts'
import { proxyJson } from '../lib/runtime.ts'
import { localBotReleaseTarget, parseBotVersion, publicBotRelease, storeUploadedRelease } from '../releases.ts'
import { requireMachine, requireOrgUser, requireOwnerUser, requireReleaseAuthor } from '../lib/guards.ts'
import { MANAGER_VACUUM_TIMEOUT_MS, MAX_LOG_CAP_MB, METRIC_RETENTION_MS, MINUTE_MS } from '../lib/telemetry.ts'
import { signDesktopTicket } from '../crypto.ts'
import { type Account, type CatalogItem, type Machine, type SeatRuntime } from '../db.ts'

export function attachMachines(router: Router, ctx: RouteCtx) {
  const { db, keys } = ctx

  router.get('/platform/orgs/:id/machine', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const loads = await machineLoads(db, company.id)
    const botLatest = (await db.latestBotRelease('bot'))?.version ?? null
    const managerLatest = (await db.latestBotRelease('manager'))?.version ?? null
    // 编号按登记先后给，和 machinesOfCompany 的排序是同一个（order by createdAt）。
    const machines = await Promise.all(
      loads.map((l, i) => machineCard(db, l, { botLatest, managerLatest }, i + 1)),
    )
    json(res, 200, {
      machines,
      botLatest,
      managerLatest,
      // **只算已配对的机器。** 没配对的那行提供不了任何账号位，把它的 maxAccounts
      // 计进去，界面就会声称有一批根本不存在的容量。
      capacity: {
        accounts: machines.reduce((n, m) => n + m.accounts, 0),
        max: machines.filter((m) => m.machine.paired).reduce((n, m) => n + m.maxAccounts, 0),
        machines: machines.filter((m) => m.machine.paired).length,
      },
      // 老界面读的是单个 machine，多机之后留一个「默认那台」兼容。取公司指定的那台，
      // 不是列表里的第一台——两者在多机时会分叉，而调用方以为拿到的是「这家公司的
      // 机器」。
      machine: (machines.find((m) => m.machine.id === company.machineId) ?? machines[0])?.machine ?? null,
    })
  })

  /**
   * 平台端看机器上的日志：不带 seatId 是**管家自己**的，带了是那个席位上 bot 的。
   *
   * 两者回答的问题不一样，缺一不可：部署失败、升级卡住、配对回拨不通只写在管家的
   * journal 里；某一轮为什么不结束只写在 bot 的。
   *
   * **走审计。** 席位的日志里有员工的对话正文和 bot 执行过的命令——这和「看别人的
   * 屏幕」是同一类动作，那条已经在审计里了，这条没有理由例外。
   *
   * seatId 必须是**这台机器上**的：它会进 systemd 单元名，不能拿别处的值来拼。
   *
   * **`follow=1` 不在这里了**：跟着滚改成浏览器直连管家（下面那条 `/logs/direct` 签票），
   * Gateway 不再扛这条小时级的 SSE。老界面还传的话回 410，不静默降级成最近 N 行。
   */
  router.get('/platform/orgs/:id/machines/:machineId/logs', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    if (req.query.get('follow') === '1') throw new HttpError(410, LOGS_FOLLOW_GONE)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const machine = await machineOfOrg(db, company.id, req.params.machineId)
    if (!machine?.host) throw new HttpError(503, INSTANCE_DOWN)
    const seatId = await seatOnMachine(machine, req.query.get('seatId'))
    const lines = Math.min(2000, Math.max(1, Math.trunc(Number(req.query.get('lines')) || 200)))
    const base = machineBase(machine.host)
    const path = seatId ? `/seats/${encodeURIComponent(seatId)}/logs` : '/logs'
    await db.audit({
      companyId: company.id,
      accountId: account.id,
      action: 'machine.logs',
      detail: { machineId: machine.id, seatId: seatId || null, follow: false },
    })
    const url = `${base}${path}?lines=${lines}`
    await proxyJson(res, 'GET', url, undefined, undefined, machine.token || undefined)
  })

  /**
   * 日志跟随的直连入口（公司侧）：鉴权、席位归属检查、审计和上面那条逐字一样，只是不
   * 转字节，而是回 `{ url, ticket }` 让浏览器自己去打管家。带 seatId 签席位票，不带签
   * **管家自己**的票（`unit: 'manager'`）——这一种只有 owner 拿得到。
   */
  router.get('/platform/orgs/:id/machines/:machineId/logs/direct', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const machine = await machineOfOrg(db, company.id, req.params.machineId)
    if (!machine?.host) throw new HttpError(503, INSTANCE_DOWN)
    const seatId = await seatOnMachine(machine, req.query.get('seatId'))
    await db.audit({
      companyId: company.id,
      accountId: account.id,
      action: 'machine.logs',
      detail: { machineId: machine.id, seatId: seatId || null, follow: true, direct: true },
    })
    json(res, 200, logsDirectPayload(keys, machine, seatId || null))
  })

  /**
   * 移除一台机器的登记。
   *
   * **只是从 Gateway 上抹掉这条记录**，不碰机器本身——那上面的管家还跑着，要停得
   * 上去停。有席位就拒绝：删掉之后那些席位会指向一台不存在的机器，聊天和桌面都会
   * 打到空处，而且再也找不回来是哪台。
   */
  router.delete('/platform/orgs/:id/machines/:machineId', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const machine = await machineOfOrg(db, company.id, req.params.machineId)
    const seats = await db.seatRuntimesOfMachine(machine.id)
    if (seats.length) throw new HttpError(409, `这台机器上还有 ${seats.length} 个席位，先把它们拆掉`)
    await db.deleteMachine(machine.id)
    if (company.machineId === machine.id) {
      const rest = await db.machinesOfCompany(company.id)
      await db.updateCompany(company.id, { machineId: rest[0]?.id ?? null })
    }
    await db.audit({
      companyId: company.id,
      accountId: account.id,
      action: 'machine.remove',
      detail: { machineId: machine.id, host: machine.host },
    })
    json(res, 200, { ok: true })
  })

  /** 改一台机器的账号容量。调小到低于当前占用不拦——已经在上面的账号不会被赶走。 */
  router.put('/platform/orgs/:id/machines/:machineId/capacity', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const machine = await machineOfOrg(db, req.params.id, req.params.machineId)
    const maxAccounts = intField(bodyOf(req), 'maxAccounts')
    if (maxAccounts == null || maxAccounts < 1 || maxAccounts > 1000) {
      throw new HttpError(400, 'maxAccounts 须为 1–1000')
    }
    const next = await db.updateMachine(machine.id, { maxAccounts })
    await db.audit({
      companyId: req.params.id,
      accountId: account.id,
      action: 'machine.capacity',
      detail: { machineId: machine.id, maxAccounts },
    })
    json(res, 200, { machine: ownerMachine(next) })
  })

  /**
   * 设这台机器的桌面直连地址（公司侧入口）。平台侧那条是
   * `PUT /platform/machines/:id/direct-url`，两条同义——机器的配置在公司详情页和
   * 平台机器页都改得了，容量和时区也是这么成对的。
   */
  router.put('/platform/orgs/:id/machines/:machineId/direct-url', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const machine = await machineOfOrg(db, req.params.id, req.params.machineId)
    const directUrl = directUrlOf(strField(bodyOf(req), 'directUrl', false) || '')
    const next = await db.updateMachine(machine.id, { directUrl })
    await db.audit({
      companyId: req.params.id,
      accountId: account.id,
      action: 'machine.direct-url',
      detail: { machineId: machine.id, directUrl },
    })
    // **探活不带机器票**，理由见 probeDirectUrl：这个地址是手输的公网域名。
    const probe = directUrl ? await probeDirectUrl(directUrl) : null
    json(res, 200, {
      machine: ownerMachine(next),
      reachedManager: probe ? probe.ok : null,
      error: probe && !probe.ok ? probe.error : null,
    })
  })

  /**
   * 设这台机器的时区。
   *
   * **只是把期望值钉在这里**，真正 `timedatectl set-timezone` 的是机器上的管家——
   * 和钉管家版本一条路：Gateway 没有登录这台机器的凭据，能做的只有在心跳响应里
   * 把期望值带下去，机器自己去收敛。所以按下之后 `pending` 为真，直到下一轮心跳
   * 自报的实际时区和它对上。
   *
   * 传空串 = 不再管这台机器的时区（不会把机器改回去，只是不再下发）。
   */
  router.put('/platform/orgs/:id/machines/:machineId/timezone', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const machine = await machineOfOrg(db, req.params.id, req.params.machineId)
    const timezone = normalizeTimezone(strField(bodyOf(req), 'timezone', false))
    if (timezone === undefined) throw new HttpError(400, '不认识这个时区，要填 IANA 名，例如 Asia/Shanghai')
    const next = await db.updateMachine(machine.id, { timezone })
    await db.audit({
      companyId: req.params.id,
      accountId: account.id,
      action: 'machine.timezone',
      detail: { machineId: machine.id, timezone },
    })
    json(res, 200, {
      machine: ownerMachine(next),
      // 说清楚这一步只是下了指令：机器还没心跳回来之前，界面别显示成「已生效」。
      pending: Boolean(timezone) && next.currentTimezone !== timezone,
    })
  })

  /**
   * 把这台机器（或这家公司的席位）升到某个版本。
   *
   * 管家和 bot 是两件事，所以两个按钮：
   *
   * - `kind: 'manager'` 只是**钉一个期望版本**到这台机器上。真正换版由机器自己在
   *   下一轮心跳里做——它要挑不忙的时候、要自检、失败要回滚，这些只有机器上做得了。
   * - `kind: 'bot'` 走已有的批量重部署，逐个席位推过去。
   */
  router.post('/platform/orgs/:id/machines/:machineId/upgrade', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const machine = await machineOfOrg(db, company.id, req.params.machineId)
    if (!machinePaired(machine)) throw new HttpError(409, '这台机器还没有配对')
    const body = bodyOf(req)
    const requested = strField(body, 'version', false)
    const rel = requested
      ? await db.botRelease(parseBotVersion(requested), 'manager')
      : await db.latestBotRelease('manager')
    if (!rel) throw new HttpError(requested ? 404 : 409, requested ? '没有这个管家版本' : '还没有发布管家版本')
    const next = await db.updateMachine(machine.id, { desiredManagerVersion: rel.version })
    await db.audit({
      companyId: company.id,
      accountId: account.id,
      action: 'machine.upgrade',
      detail: { machineId: machine.id, version: rel.version },
    })
    json(res, 200, {
      machine: ownerMachine(next),
      version: rel.version,
      // 说清楚这一步只是下了指令：界面上别显示成「已升级」。
      pending: next.managerVersion !== rel.version,
    })
  })

  /**
   * 改机器地址。**只改地址，没有任何凭据字段**——机器的身份是配对时签发的 `smt_`，
   * 不是这里填进去的东西。换 IP、换端口时用它；换机器请重新配对。
   */
  router.put('/platform/orgs/:id/machine', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    const raw = strField(body, 'host', false)
    const wanted = strField(body, 'machineId', false)
    const cur = wanted ? await machineOfOrg(db, company.id, wanted) : await companyMachineOf(db, company.id)
    if (!cur) throw new HttpError(409, '这家公司还没有配对过机器，请先生成配对码')
    if (!raw) throw new HttpError(400, 'host 不能为空')
    const host = managerHostOf(raw)
    let rehosted = 0
    const machine = await db.tx(async () => {
      const row = await db.updateMachine(cur.id, { host, lastError: null })
      if (company.machineId !== row.id) {
        await db.updateCompany(company.id, {
          machineId: row.id,
          accessUrl: company.accessUrl ?? accessUrlFor(company.slug),
        })
      }
      // 聊天读的是 instances.host，不会跟着 machines.host 走——见 rehostSeatInstances。
      // 和改地址在同一个事务里：不能出现「地址改了、席位还指着老地址」这个中间态。
      rehosted = await rehostSeatInstances(db, row.id, host)
      await db.audit({ companyId: company.id, accountId: account.id, action: 'machine.update', detail: { host, rehosted } })
      return row
    })
    const probe = await managerHealth(host, { token: machine.token })
    json(res, 200, { machine: ownerMachine(machine), reachable: probe.ok, error: probe.error ?? null, rehosted })
  })

  /**
   * 生成配对码。装机时贴给安装脚本，它拿去换这台机器的 `smt_`。
   *
   * 一家公司同时只该有一张有效的票，所以先把之前没用掉的作废掉——桌上躺着两张
   * 都能用的码，谁也说不清哪台机器是拿哪张进来的。
   */
  router.post('/platform/orgs/:id/pairing-code', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const now = Date.now()
    await db.expireMachinePairings(company.id, now)
    const row = await db.insertMachinePairing({
      code: randomPairingCode(),
      companyId: company.id,
      createdBy: account.id,
      createdAt: now,
      expiresAt: now + PAIRING_TTL,
      usedAt: null,
      machineId: null,
    })
    await db.audit({
      companyId: company.id,
      accountId: account.id,
      action: 'machine.pairing-code',
      detail: { expiresAt: row.expiresAt },
    })
    json(res, 201, {
      code: row.code,
      expiresAt: row.expiresAt,
      installCommand: installCommandFor(req, row.code),
    })
  })

  // ── 平台侧的机器管理。──────────────────────────────────────────────
  //
  // 上面那一组是「**这家公司**的机器」，进得去的前提是先挑一家公司。平台这一侧要
  // 答的是另一个问题：**这台 Gateway 上现在挂着哪些机器、哪台出事了**。两者的差别
  // 不只是入口——没派给任何公司的机器（刚配对完还没分、原公司被删之后落单的）在
  // 按公司列的那条路上**永远列不出来**，而它们恰恰最需要被人看见。
  //
  // 所以这一组路由一律以 machineId 为主键，不带 orgId；公司只是机器上的一个属性。

  /** 取一台机器，不问归属。跨公司在这一侧不是越权——owner 本来就管着全部。 */
  async function machineOr404(id: string): Promise<Machine> {
    const machine = await db.machine(id)
    if (!machine) throw new HttpError(404, '没有这台机器')
    return machine
  }

  /**
   * 平台侧的一张机器卡：`machineCard` 那一套，外加归属公司。
   *
   * 编号（「几号机」）在这里是 null：那个短号是**一家公司内部**数出来的，平台这一
   * 侧把两家公司的机器摆在一张表里，两个「1 号机」并排会指代不清。这里认 id。
   */
  async function platformMachineCard(load: MachineLoad, latest: { botLatest: string | null; managerLatest: string | null }) {
    // 不要 machineCard 那份席位清单：列表页只画汇总，详情页在下面自己重建一份更全的
    // 盖上去。带着它等于每台机器白跑一轮按席位的账号查询。
    const card = await machineCard(db, load, latest, 0, { seatList: false })
    const company = load.machine.companyId ? await db.company(load.machine.companyId) : undefined
    return {
      ...card,
      no: null,
      company: company ? { id: company.id, name: company.name, slug: company.slug, status: company.status } : null,
    }
  }

  async function releaseLatest() {
    return {
      botLatest: (await db.latestBotRelease('bot'))?.version ?? null,
      managerLatest: (await db.latestBotRelease('manager'))?.version ?? null,
    }
  }

  /**
   * 机器上的操作写审计。
   *
   * **没派给公司的机器写不进去**：`audit_events.companyId` 是 not null，而审计是按
   * 公司分档看的，塞一个假 id 进去只会污染某家公司的账。这种机器上的动作只在
   * Gateway 日志里留痕——它们还没有归属，也就没有该看到这条记录的人。
   */
  async function auditMachine(machine: Machine, accountId: string, action: string, detail: unknown) {
    if (!machine.companyId) return
    await db.audit({ companyId: machine.companyId, accountId, action, detail })
  }

  /**
   * 日志路由共用的一句：seatId 必须是**这台机器上**的席位，它会进 systemd 单元名，不能拿
   * 别处的值来拼。空串就是「看管家自己的」。
   */
  async function seatOnMachine(machine: Machine, raw: string | null): Promise<string> {
    const seatId = (raw || '').trim()
    if (!seatId) return ''
    const rows = await db.seatRuntimesOfMachine(machine.id)
    if (!rows.some((r) => r.seatId === seatId)) throw new HttpError(404, '这台机器上没有这个席位')
    return seatId
  }

  /**
   * 席位行 + 人名和 Bot 名。
   *
   * 详情页的席位表是这一页的正题，出事时要看得见**是谁的、哪个槽位、上次部署报了
   * 什么**，所以列比 `listSeatRuntime` 多。
   *
   * Bot 名由这里给，不留给前端查：前端那份 `state.bots` 是别的页面（公司详情、Bot
   * 名录）顺带装进去的，机器详情页从不加载它——靠它的话，直接打开 /machines/:id
   * 时整列会是一串 uuid，而先逛过某家公司再进来又变成名字，同一页两种结果。
   *
   * 账号和 Bot 都**按 id 去重后各查一次**：一个员工在同一台机器上常有好几个席位。
   */
  async function withSeatNames(rows: SeatRuntime[]) {
    const accounts = new Map<string, Account | undefined>()
    for (const id of new Set(rows.map((r) => r.accountId))) accounts.set(id, await db.account(id))
    const bots = new Map<string, CatalogItem | undefined>()
    for (const id of new Set(rows.map((r) => r.botId))) bots.set(id, await db.catalog(id))
    return rows.map((r) => {
      const who = accounts.get(r.accountId)
      return {
        accountId: r.accountId,
        who: who?.email ?? r.accountId,
        whoName: who?.name || null,
        botId: r.botId,
        // Bot 被删掉之后席位还在（拆席位是另一件事），名字就没了——退回 id，
        // 至少还指得出是哪一个。
        botName: bots.get(r.botId)?.name || null,
        // 没有主人的席位。**单独一个字段，不让界面拿 botName 是不是空来猜**：
        // 那一列将来完全可能因为别的原因取不到名字，而「能不能从这里清掉」是权限
        // 判断，不能建在一个显示字段上。
        orphan: !bots.get(r.botId),
        seatId: r.seatId,
        linuxUser: r.linuxUser,
        slot: r.slot,
        status: r.status,
        botVersion: r.botVersion ?? null,
        // 席位自报的模版版本。这一页排查的是「那台机器上的东西不对」，而「装的包是新的、
        // 跑的模版是三版之前的」正是其中一种，光看 botVersion 看不出来。
        tplVersion: r.tplVersion ?? null,
        tplSyncedAt: r.tplSyncedAt ?? null,
        lastError: r.lastError,
        deployedAt: r.deployedAt,
      }
    })
  }

  /** 平台上所有机器。列表页一次拉齐，不分页——机器是几十台的量级，不是几万条。 */
  router.get('/platform/machines', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    await db.sweepRemovedMachines(Date.now() - MACHINE_TOMBSTONE_TTL)
    const latest = await releaseLatest()
    const rows = await db.allMachines()
    const machines = await Promise.all(
      rows.map(async (m) => platformMachineCard(await machineLoadOf(db, m), latest)),
    )
    json(res, 200, {
      machines,
      ...latest,
      // 只把已配对的机器算进容量：没配对那行提供不了任何账号位，计进去就是在报一批
      // 根本不存在的余量。在线台数另算，它答的是「现在有多少台真的在」。
      totals: {
        machines: machines.length,
        paired: machines.filter((m) => m.machine.paired).length,
        online: machines.filter((m) => m.machine.link === 'online').length,
        accounts: machines.reduce((n, m) => n + m.accounts, 0),
        max: machines.filter((m) => m.machine.paired).reduce((n, m) => n + m.maxAccounts, 0),
        seats: machines.reduce((n, m) => n + m.seats, 0),
      },
    })
  })

  /**
   * 一台机器的详情。
   *
   * 顺带把公司清单给出去——详情页要能改这台机器的归属，而那个下拉总不能让人手打
   * 公司 id。清单只有 id / 名字 / slug，没有别的。
   */
  router.get('/platform/machines/:id', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    const machine = await machineOr404(req.params.id)
    const latest = await releaseLatest()
    const load = await machineLoadOf(db, machine)
    const card = await platformMachineCard(load, latest)
    // 席位清单用的键名就是 `seatList`，和 machineCard 那份同名同义（这里是它的超集），
    // 不另起一个。
    //
    // **不叫 `seats`**：那个键是席位**数**，撞上就出过事——详情页的「席位 2」画成了
    // `[object Object],[object Object]`，而 `card.seats ?` 这类判断也跟着翻（空数组是
    // 真值），一台一个席位都没有的机器会被判成「还有席位，改不了归属」。
    //
    // 账号和 Bot 名字**按 id 去重后各查一次**：一个员工在同一台机器上往往有好几个
    // 席位，逐行查等于把同一行数据反复取回来。
    const seatList = await withSeatNames(load.seatRows)
    const companies = (await db.companies()).map((c) => ({ id: c.id, name: c.name, slug: c.slug }))
    json(res, 200, {
      ...card,
      ...latest,
      seatList,
      companies,
      /**
       * 重铺一个席位会往它的 bot.env 里写哪个 Gateway 地址。
       *
       * **摆在按钮旁边，不是装饰。** 那一格的值就是这个进程的 `GATEWAY_PUBLIC_URL`；
       * 没配的话它会回落成 `GATEWAY_HOST:GATEWAY_PORT`（多半是 127.0.0.1:3080），
       * 而按下「重新部署」就是把那个打不通的地址写死进席位。这件事必须在按之前
       * 看得见，所以连「是不是明确配过」一起给出去。
       */
      seatGatewayUrl: gatewayPublicUrl(),
      seatGatewayUrlConfigured: Boolean(gatewayPublicUrlExplicit()),
    })
  })

  /**
   * 改机器地址。和公司侧那条同义：**只改地址，没有任何凭据字段**——机器的身份是
   * 配对时签发的 `smt_`。换 IP、换端口用它；换机器请重新配对。
   */
  router.put('/platform/machines/:id/host', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const machine = await machineOr404(req.params.id)
    const raw = strField(bodyOf(req), 'host', false)
    if (!raw) throw new HttpError(400, 'host 不能为空')
    const host = managerHostOf(raw)
    let rehosted = 0
    const next = await db.tx(async () => {
      const row = await db.updateMachine(machine.id, { host, lastError: null })
      // 聊天读的是 instances.host，不会跟着 machines.host 走——见 rehostSeatInstances。
      rehosted = await rehostSeatInstances(db, row.id, host)
      return row
    })
    await auditMachine(next, account.id, 'machine.update', { machineId: next.id, host, rehosted })
    // 存下来还不够：地址写错了要当场知道，不能等到第一次部署。
    const probe = await managerHealth(host, { token: next.token })
    json(res, 200, { machine: ownerMachine(next), reachable: probe.ok, error: probe.error ?? null, rehosted })
  })

  /**
   * 设这台机器的公网直连地址：桌面、对话流、名单流都从这里拼（见迁移 0038、deploy.ts 的
   * novncUrlOf / streamUrlOf / rosterUrlOf）。传空串就是撤回——这台机器上的席位从此
   * 没有桌面和实时流，Gateway 不再有反代退路。
   *
   * **和 host 分成两条路，不合并。** 两者要求完全不同（一个是 Gateway 打机器、可以
   * 是内网 http；一个是浏览器打机器、必须公网 https），而且撤回是一个独立的、出事时
   * 要能单独按下去的动作，不该被迫连 host 一起动。
   *
   * 探活**不带机器票**（见 probeDirectUrl）：这个地址是手输的公网域名，敲错一个字母
   * 就把票送给了别人。不带票判得反而更准——管家的 /health 没票就是 401，所以 401 才是
   * 「对面真是一台管家」的证据。
   *
   * 回包那个字段只说明**Gateway 摸到的是一台管家**，不说明员工的浏览器连得上（证书、
   * 解析、防火墙都可能只对其中一边成立）。别在界面上写成「已验证」。
   */
  router.put('/platform/machines/:id/direct-url', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const machine = await machineOr404(req.params.id)
    const directUrl = directUrlOf(strField(bodyOf(req), 'directUrl', false) || '')
    const next = await db.updateMachine(machine.id, { directUrl })
    await auditMachine(next, account.id, 'machine.direct-url', { machineId: next.id, directUrl })
    // **探活不带机器票**，理由见 probeDirectUrl：这个地址是手输的公网域名。
    const probe = directUrl ? await probeDirectUrl(directUrl) : null
    json(res, 200, {
      machine: ownerMachine(next),
      reachedManager: probe ? probe.ok : null,
      error: probe && !probe.ok ? probe.error : null,
    })
  })

  /** 改账号容量。调小到低于当前占用不拦——已经在上面的账号不会被赶走。 */
  router.put('/platform/machines/:id/capacity', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const machine = await machineOr404(req.params.id)
    const maxAccounts = intField(bodyOf(req), 'maxAccounts')
    if (maxAccounts == null || maxAccounts < 1 || maxAccounts > 1000) {
      throw new HttpError(400, 'maxAccounts 须为 1–1000')
    }
    const next = await db.updateMachine(machine.id, { maxAccounts })
    await auditMachine(next, account.id, 'machine.capacity', { machineId: next.id, maxAccounts })
    json(res, 200, { machine: ownerMachine(next) })
  })

  /** 设时区。只是把期望值钉在这里，真正改的是机器上的管家，下一轮心跳才知道成没成。 */
  router.put('/platform/machines/:id/timezone', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const machine = await machineOr404(req.params.id)
    const timezone = normalizeTimezone(strField(bodyOf(req), 'timezone', false))
    if (timezone === undefined) throw new HttpError(400, '不认识这个时区，要填 IANA 名，例如 Asia/Shanghai')
    const next = await db.updateMachine(machine.id, { timezone })
    await auditMachine(next, account.id, 'machine.timezone', { machineId: next.id, timezone })
    json(res, 200, { machine: ownerMachine(next), pending: Boolean(timezone) && next.currentTimezone !== timezone })
  })

  /**
   * 这台机器一段时间里的负载归档，**按分钟**。日视图吃它。
   *
   * **范围由界面按浏览器时区圈好了传上来**（`from`/`to`，epoch 毫秒）：格子按 UTC 整分
   * 存，「今天」是哪 24 小时得由看的人那本日历说了算。服务端不猜时区——猜错的表现是
   * 曲线整体错位几小时，而那种错最难被认出来是时区问题。
   *
   * 没有数据的分钟**不会有行**。前端据此画空档，不是画 0——一台没在报的机器和一台
   * 闲着的机器，结论正相反。
   */
  router.get('/platform/machines/:id/metrics', async (req, res) => {
    await requireOwnerUser(req, db, keys)
    const machine = await machineOr404(req.params.id)
    const from = Math.trunc(Number(req.query.get('from')))
    const to = Math.trunc(Number(req.query.get('to')))
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new HttpError(400, 'from/to 不合法')
    // 一天是 1440 行。**上限卡在两天**：日视图最长的一天也就 25 小时（夏令时那天），
    // 再大的范围这张表不该一次吐出来——那既不是这一页会问的问题，也不是它扛得住的
    // 返回体（一个月就是四万多行）。
    if (to - from > 2 * 24 * 60 * MINUTE_MS) throw new HttpError(400, '时间范围太大，一次最多两天')
    // **这里不扫保留期。** 清理挂在心跳上（每台机器整点那一分钟扫一次，见
    // internal.ts 的 rollUp）——写入是自动的，清理也得是自动的；挂在「有人打开这一
    // 页」上的话，没人看图的部署里那张表只涨不清。
    const rows = await db.machineMetricMinutes(machine.id, from, to)
    json(res, 200, {
      from,
      to,
      // 保留期一起给出去：界面据此说得清「那天太久了，归档已经清掉」，而不是含混地
      // 显示一片空白让人以为机器那天没开。
      retentionMs: METRIC_RETENTION_MS,
      minutes: rows.map((r) => ({
        minuteStart: r.minuteStart,
        samples: r.samples,
        // 平均值在这一层除出来：库里存的是 sum，累加才能是纯 `+`（见迁移 0012）。
        cpuAvg: r.samples ? r.cpuSum / r.samples : null,
        cpuMax: r.cpuMax,
        memAvg: r.samples ? r.memSum / r.samples : null,
        memMax: r.memMax,
        diskAvg: r.samples ? r.diskSum / r.samples : null,
        diskMax: r.diskMax,
        txBytes: r.txBytes,
        rxBytes: r.rxBytes,
      })),
    })
  })

  /**
   * 日志相关的那两个「多少 MB」。**数字和字符串都收**。
   *
   * 界面走 FormData 拿到的是字符串，脚本和 curl 直接给数字——让一个数值字段只认
   * 字符串，是给调用方挖坑（同 registerFromBody 里那条注释）。`intField` 在这儿不
   * 合用：它对 3.5 静默取整，而这两个值一个是「盘上留多少日志」、一个是「清到多
   * 少」，写错了不该被悄悄改成另一个数。
   *
   * 返回 undefined = 没填（上限那条据此清空，清理那条据此用管家的默认目标）。
   * **空串和 0 是两回事**，所以空串在这里变成 undefined，0 原样留下。
   */
  function logMbField(body: Record<string, unknown>, key: string): number | undefined {
    const raw = body[key]
    if (raw == null) return undefined
    // **只收数字和字符串两种类型**，别的一律 400。不卡类型直接丢给 `Number()` 的话，
    // `true` 会变成 1、`[]` 会变成 0、`["512"]` 会变成 512——而 0 在这里的意思是
    // 「这台机器别自动清日志」，一个空数组把清理关掉，是最不该悄悄发生的那种事。
    if (typeof raw !== 'number' && typeof raw !== 'string') {
      throw new HttpError(400, `${key} 须为 0–${MAX_LOG_CAP_MB} 的整数`)
    }
    const v = typeof raw === 'string' ? raw.trim() : raw
    if (v === '') return undefined
    const n = typeof v === 'number' ? v : Number(v)
    if (!Number.isInteger(n) || n < 0 || n > MAX_LOG_CAP_MB) {
      throw new HttpError(400, `${key} 须为 0–${MAX_LOG_CAP_MB} 的整数`)
    }
    return n
  }

  /**
   * 设这台机器的 journal 上限，MB。
   *
   * 和时区、管家版本同一条路：**这里只是把期望值钉住**，真正 `journalctl
   * --vacuum-size` 的是机器上的管家，下一轮心跳把这个数带下去，超了它自己清。
   *
   * 传空串 = 不再指定，跟管家的默认走（1 GB）；传 `0` = 明确不要它动 journal。
   * **这两者不是一回事**，所以空串存 null 而不是 0——把「没指定」当成 0，等于在
   * 谁也没按过的机器上把清理静默关掉，而盘写满时连日志都写不进去，事后连查都没得查。
   */
  router.put('/platform/machines/:id/log-cap', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const machine = await machineOr404(req.params.id)
    const logCapMb = logMbField(bodyOf(req), 'logCapMb') ?? null
    const next = await db.updateMachine(machine.id, { logCapMb })
    await auditMachine(next, account.id, 'machine.log-cap', { machineId: next.id, logCapMb })
    json(res, 200, {
      machine: ownerMachine(next),
      // 机器认没认得等下一轮心跳。界面据此把话说全，别写成「已生效」。
      //
      // **清空那一支永远不是 pending。** 清空之后机器回落到自己的默认值（一个数），
      // 拿它和 null 比永远不相等——照那么算，「不再指定」会从此挂着一句「等机器认」，
      // 而根本没有指令在路上。
      pending: logCapMb != null && next.telemetry?.logs?.capMb !== logCapMb,
    })
  })

  /**
   * 立刻清一次这台机器的日志。
   *
   * 平时不用按——超过上限时管家自己会清。它存在是为了两种时候：盘已经快满了，等不
   * 到下一轮检查（半小时一次）；以及刚把上限调小，想当场看到效果。
   *
   * **走审计。** 这一下会在机器上永久删掉最老的那截 journal，而那截日志正是事后
   * 复盘的材料——谁在什么时候按的，得留得下来。
   */
  router.post('/platform/machines/:id/logs/vacuum', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const machine = await machineOr404(req.params.id)
    if (!machine.host) throw new HttpError(503, INSTANCE_DOWN)
    const keepMb = logMbField(bodyOf(req), 'keepMb')
    await auditMachine(machine, account.id, 'machine.logs.vacuum', { machineId: machine.id, keepMb: keepMb ?? null })
    await proxyJson(
      res,
      'POST',
      `${machineBase(machine.host)}/logs/vacuum`,
      keepMb === undefined ? {} : { keepMb },
      undefined,
      machine.token || undefined,
      undefined,
      // **不能用默认的 15 秒。** 这一头是真活儿：先 rotate 再删文件，管家自己给的
      // 预算是 60 + 120 秒。按 15 秒掐断的话，一台 journal 攒到几个 G 的机器上会回
      // 一句「实例还没上线」——而清理正干得好好的。人看着报错就再点一次，于是同一
      // 台机器上叠着跑两轮 journalctl（管家那边另有一道单飞闸，见 logdisk.ts）。
      MANAGER_VACUUM_TIMEOUT_MS,
    )
  })

  /** 钉一个管家版本。换版、自检、失败回滚都在机器上做，这里只下指令。 */
  router.post('/platform/machines/:id/upgrade', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const machine = await machineOr404(req.params.id)
    if (!machinePaired(machine)) throw new HttpError(409, '这台机器还没有配对')
    const requested = strField(bodyOf(req), 'version', false)
    const rel = requested
      ? await db.botRelease(parseBotVersion(requested), 'manager')
      : await db.latestBotRelease('manager')
    if (!rel) throw new HttpError(requested ? 404 : 409, requested ? '没有这个管家版本' : '还没有发布管家版本')
    const next = await db.updateMachine(machine.id, { desiredManagerVersion: rel.version })
    await auditMachine(next, account.id, 'machine.upgrade', { machineId: next.id, version: rel.version })
    json(res, 200, { machine: ownerMachine(next), version: rel.version, pending: next.managerVersion !== rel.version })
  })

  /**
   * 把**这台机器上**的席位统统重铺到某个 bot 版本。
   *
   * 和公司侧那条 `runtime/update` 是两个口径，两个都要有：公司侧答的是「让这家公司
   * 的人都用上新版」，这一条答的是「这台机器上的东西都是新的」——排查一台机器时，
   * 按公司升级会连带动到别的机器上的席位，那不是这时候想要的。
   *
   * 逐个席位串着推：部署要在机器上解包、建目录、起 systemd，并发推一台机器只会
   * 让它更慢，还把失败搅在一起看不清是哪一个。
   */
  router.post('/platform/machines/:id/runtime/update', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const machine = await machineOr404(req.params.id)
    const body = bodyOf(req)
    /**
     * **两种活儿，一条路。**
     *
     * - 不带 `force`：升级。所有席位铺到同一个版本（指定的那个，或最新的那个）。
     * - 带 `force`：**照现状重铺**——每个席位仍然是它自己那一版，只是重新走一遍部署。
     *
     * 后者要解的是「版本没错，配置旧了」：席位的 `bot.env` 是部署那一刻写死的，
     * Gateway 换了对外地址之后，那一份还指着旧地址，而版本号一个字都没变——升级那条
     * 路在这种时候什么都不做（`botOutdated` 为假，界面上连按钮都不画）。重铺会让
     * 部署脚本整份重写 bot.env，配置跟着回到 Gateway 现在这一份。
     */
    const force = body.force === true
    const requested = strField(body, 'version', false)
    let version = ''
    if (requested) {
      parseBotVersion(requested)
      const rel = await db.botRelease(requested)
      if (!rel) throw new HttpError(404, '没有这个 Bot 版本')
      version = rel.version
    } else if (!force) {
      const latest = await db.latestBotRelease()
      if (!latest) throw new HttpError(409, '还没有发布 Bot 版本')
      version = latest.version
    }
    const seats = (await db.seatRuntimesOfMachine(machine.id)).filter((r) => r.status !== 'none')
    /**
     * `busy` 是**第三种结局**，不是一种失败：席位上有人正在说话，管家等过了也没等到
     * 这一轮结束，于是什么都没动（见 manager/src/seats.ts 的排空）。界面上要分开数——
     * 混进「失败」里，一次「今天中午大家都在用」会被报成一片红，人会去查根本不存在
     * 的部署故障。
     */
    const results: { accountId: string; botId: string; status: string; botVersion: string | null; error?: string; busy?: boolean }[] = []
    for (const seat of seats) {
      const row = await db.account(seat.accountId)
      if (!row) {
        results.push({
          accountId: seat.accountId,
          botId: seat.botId,
          status: seat.status,
          botVersion: seat.botVersion ?? null,
          error: '账号不存在',
        })
        continue
      }
      /**
       * 重铺用**这个席位自己那一版**；它没记版本（老数据、上一次部署失败）就干脆不传，
       * 交给 deploySeat 去挑。
       *
       * **不能在这里自己兜一个 `latestBotRelease()`。** 那个查询不看架构，而 deploySeat
       * 对**显式指定**的版本是要过架构关的：平台上最新的是 x64 包、这台机器是 arm64 时，
       * 兜出来的那个版本会被它自己 409 掉（「这台机器是 arm64，而 X 是 x64 的包」），
       * 于是那个席位永远重铺不了。不传版本走的是 `latestBotRelease('bot', machine.arch)`
       * ——真的没有可用发布包时它照样会回一句「还没有发布 Bot 版本」，落进 results，
       * 信息一点没少，还挑对了包。
       */
      const target = version || seat.botVersion || undefined
      /**
       * 重铺**不打断正在跑的那一轮**（`interrupt: false`）。
       *
       * `force` 默认是带打断的——人在员工那一侧按「重新部署」时要的就是「现在就重铺」。
       * 但这条是整台机器一次推过去：真打断的话，一次点击会掐掉那台机器上所有人正在
       * 进行的对话。让它照常排空，忙的席位回 `busy`（第三种结局，见下），过会儿再来
       * 一次就是了。
       */
      const out = await deploySeat(
        db,
        keys,
        row,
        force
          ? { botId: seat.botId, version: target, force: true, interrupt: false }
          : { botId: seat.botId, version: target, update: true },
      )
      results.push(
        out.ok
          ? {
              accountId: row.id,
              botId: seat.botId,
              status: out.result.runtime.status,
              botVersion: out.result.runtime.botVersion ?? null,
            }
          : {
              accountId: row.id,
              botId: seat.botId,
              status: out.runtime?.status ?? 'error',
              botVersion: out.runtime?.botVersion ?? null,
              error: out.error,
              // 席位有会话在跑，这次没换（见上面 results 的注释）。**认 out.busy，不认
              // 状态码**：deploySeat 有六处 409，含义各不相同。
              ...(out.busy ? { busy: true } : {}),
            },
      )
    }
    await auditMachine(machine, account.id, 'runtime.update', {
      machineId: machine.id,
      // 重铺时没有「统一的那个版本」——每个席位各是各的，写 null 比写一个假的准。
      version: version || null,
      force,
      count: results.length,
    })
    json(res, 200, { version: version || null, force, results })
  })

  /**
   * 改这台机器的归属公司。传空 = 收回，让它变成一台待分配的机器。
   *
   * **有席位就拒绝。** 席位是按公司建的账号和目录，改归属并不会把它们搬走，只会让
   * 一台 A 公司的机器名义上属于 B 公司，而上面跑着 A 的人——那时谁看到谁的桌面就
   * 说不清了。要改归属，先把席位拆干净。
   */
  router.put('/platform/machines/:id/company', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const machine = await machineOr404(req.params.id)
    const wanted = strField(bodyOf(req), 'companyId', false)
    const target = wanted ? await db.company(wanted) : undefined
    if (wanted && !target) throw new HttpError(404, '公司不存在')
    const nextCompanyId = target?.id ?? null
    if (nextCompanyId === machine.companyId) {
      json(res, 200, { machine: ownerMachine(machine) })
      return
    }
    const seats = await db.seatRuntimesOfMachine(machine.id)
    if (seats.length) throw new HttpError(409, `这台机器上还有 ${seats.length} 个席位，先把它们拆掉再改归属`)
    const next = await db.tx(async () => {
      const row = await db.updateMachine(machine.id, { companyId: nextCompanyId })
      // 老东家把它当默认机器的话，得改指向别处——留着一个指向别人家机器的
      // companies.machineId，部署会一路打到不该去的地方。
      if (machine.companyId) {
        const prev = await db.company(machine.companyId)
        if (prev?.machineId === machine.id) {
          const rest = (await db.machinesOfCompany(prev.id)).filter((m) => m.id !== machine.id)
          await db.updateCompany(prev.id, { machineId: rest[0]?.id ?? null })
        }
      }
      // 新东家一台都没有的话，这台就是它的默认机器。已经有默认的就不动——默认那台
      // 是它自己挑的，不该被一次「加一台」悄悄换掉。
      //
      // accessUrl 跟着一起补：另外三条把机器挂到公司名下的路（配对回拨、公司认领、
      // 平台改地址）都会顺手补上它，漏了这一条的话，一家从没配过机器的公司在这里
      // 被指派了机器、却在自己的详情页上看到一个空的「访问地址」。
      if (target && !target.machineId) {
        await db.updateCompany(target.id, {
          machineId: row.id,
          accessUrl: target.accessUrl ?? accessUrlFor(target.slug),
        })
      }
      return row
    })
    if (machine.companyId) {
      await db.audit({
        companyId: machine.companyId,
        accountId: account.id,
        action: 'machine.unassign',
        detail: { machineId: machine.id, to: nextCompanyId },
      })
    }
    await auditMachine(next, account.id, 'machine.assign', { machineId: next.id, from: machine.companyId })
    json(res, 200, { machine: ownerMachine(next) })
  })

  /**
   * 看这台机器上的日志：不带 seatId 是**管家自己**的，带了是那个席位上 bot 的。
   *
   * 走审计，理由和公司侧那条一样：席位的日志里有员工的对话正文和 bot 执行过的命令。
   */
  router.get('/platform/machines/:id/logs', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    if (req.query.get('follow') === '1') throw new HttpError(410, LOGS_FOLLOW_GONE)
    const machine = await machineOr404(req.params.id)
    if (!machine.host) throw new HttpError(503, INSTANCE_DOWN)
    const seatId = await seatOnMachine(machine, req.query.get('seatId'))
    const lines = Math.min(2000, Math.max(1, Math.trunc(Number(req.query.get('lines')) || 200)))
    const path = seatId ? `/seats/${encodeURIComponent(seatId)}/logs` : '/logs'
    await auditMachine(machine, account.id, 'machine.logs', { machineId: machine.id, seatId: seatId || null, follow: false })
    const url = `${machineBase(machine.host)}${path}?lines=${lines}`
    await proxyJson(res, 'GET', url, undefined, undefined, machine.token || undefined)
  })

  /** 日志跟随的直连入口（平台侧）。同上面公司侧那条，只是机器按 id 找、审计按机器所属公司记。 */
  router.get('/platform/machines/:id/logs/direct', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const machine = await machineOr404(req.params.id)
    if (!machine.host) throw new HttpError(503, INSTANCE_DOWN)
    const seatId = await seatOnMachine(machine, req.query.get('seatId'))
    await auditMachine(machine, account.id, 'machine.logs', { machineId: machine.id, seatId: seatId || null, follow: true, direct: true })
    json(res, 200, logsDirectPayload(keys, machine, seatId || null))
  })

  /**
   * 移除一台机器的登记。
   *
   * **只是从 Gateway 上抹掉记录，不碰机器本身**：那台 Debian 上的管家、systemd 单元、
   * `~/work` 里的文件一样不动，要停得上去停。机器票随行没了而失效，管家下一轮心跳
   * 会拿到 401。
   *
   * **上面的席位登记一起抹掉，有席位也照删。** 这两件事必须同进同出——只删机器的话，
   * 席位行会留着一个指向不存在机器的 machineId，而 `machineTokenFor` 查不到就回落到
   * 这家公司的另一台机器，聊天请求于是带着别的机器的票发出去，静默打到错的地方。
   *
   * 代价说在前面，界面上也是这么写的：那些席位的进程还在原机器上跑着，员工再进来
   * 时是「未部署」，重新部署会落到别的机器上（`~/work` 不会跟过去）。而这台机器
   * **将来重新配对回来时，老单元还占着 3200+N / 6081+N 那组端口**，新席位从 slot 0
   * 重新分配就会撞上——所以重新配对之前得先上去把旧席位清干净。
   */
  router.delete('/platform/machines/:id', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const machine = await machineOr404(req.params.id)
    const seats = await db.seatRuntimesOfMachine(machine.id)
    // 机器还在线才立墓碑：它下一轮心跳（≤30 秒）就会收到信，自己停席位、停自己、
    // 回执。不在线的（没配对、失联、没票）没人来收信，留墓碑只是让它在库里躺满
    // TTL，直接硬删。
    const notify = machineLink(machine) === 'online' && Boolean(machine.token)
    await db.tx(async () => {
      // 席位登记**立刻**清掉，不等机器收信：Gateway 侧的引用必须马上断，否则
      // machineTokenFor 那一路会把聊天请求发到这家公司的另一台机器上。机器上的
      // 进程由管家收到信之后自己停。
      await db.deleteSeatRuntimesOfMachine(machine.id)
      if (notify) await db.markMachineRemoved(machine.id, Date.now())
      else await db.deleteMachine(machine.id)
      if (machine.companyId) {
        const company = await db.company(machine.companyId)
        if (company?.machineId === machine.id) {
          const rest = await db.machinesOfCompany(company.id)
          await db.updateCompany(company.id, { machineId: rest[0]?.id ?? null })
        }
      }
    })
    // 顺手收掉一直没来收信的旧墓碑。不开定时器：这条路和列表页的频率都远高于 TTL。
    await db.sweepRemovedMachines(Date.now() - MACHINE_TOMBSTONE_TTL)
    // 席位数进审计：这条记录事后要能回答「那几个人的席位是哪一次没的」。
    await auditMachine(machine, account.id, 'machine.remove', {
      machineId: machine.id,
      host: machine.host,
      seats: seats.length,
      notified: notify,
    })
    // pending = 机器还得收一次信才算收拾干净。界面据此把话说全，别写成「已经停了」。
    json(res, 200, { ok: true, seats: seats.length, pending: notify })
  })

  /**
   * 清理一条**没有主人的席位**：Bot 已经删了，机器上那套单元当时没拆掉。
   *
   * 删 Bot 时拆不掉的席位会留成墓碑（见 deploy.ts 的 purgeBot），行留着是为了占住
   * slot——机器上那组端口（3200+N / 6081+N）还被老单元占着，把 slot 让出去，下一个
   * 人的席位就起不来。机器修好之后总得有人来收这一行，这条路就是那把扫帚。
   *
   * **只清理 Bot 已经不在的那些。** 还有主人的席位不能从这里拆：那是「删 Bot」或者
   * 「重新部署」的事，从机器页把一个活着的席位掀掉，员工那边只会看到聊天忽然 503，
   * 界面上却什么都没变。
   */
  router.delete('/platform/machines/:id/seats/:seatId', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const machine = await machineOr404(req.params.id)
    const seat = await db.seatRuntimeBySeatId(req.params.seatId)
    if (!seat || seat.machineId !== machine.id) throw new HttpError(404, '这台机器上没有这个席位')
    if (await db.catalog(seat.botId)) {
      throw new HttpError(409, '这个席位的 Bot 还在，请去 Bot 那边删除，或者让本人重新部署')
    }
    try {
      await releaseSeats(db, [seat])
    } catch (e) {
      throw new HttpError(502, (e as Error).message)
    }
    await db.deleteSeatRuntimeOf(seat.accountId, seat.botId)
    await auditMachine(machine, account.id, 'machine.seat.remove', {
      machineId: machine.id,
      seatId: seat.seatId,
      botId: seat.botId,
      accountId: seat.accountId,
    })
    json(res, 200, { ok: true, seatId: seat.seatId })
  })

  // 读发布列表跟上传同一套凭证：CI 传完要能回查，人在发布页看的是同一份数据。
  // 这里没有秘密——版本号、sha256、大小、说明。
  router.get('/platform/bot-releases', async (req, res) => {
    await requireReleaseAuthor(req, db, keys)
    const releases = await db.botReleases()
    json(res, 200, {
      releases: releases.map((r) => publicBotRelease(r, gatewayBaseFor(req))),
      latest: releases[0]?.version ?? null,
    })
  })

  router.get('/platform/bot-releases/:version', async (req, res) => {
    await requireReleaseAuthor(req, db, keys)
    const row = await db.botRelease(req.params.version)
    if (!row) throw new HttpError(404, '没有这个 Bot 版本')
    json(res, 200, { release: publicBotRelease(row, gatewayBaseFor(req)) })
  })

  /**
   * 上传发布包。body 就是 tgz 本身，不解析成 JSON（`putRaw`）。
   *
   *   curl -sf -X PUT "$GW/platform/bot-releases/1.2.3+abc1234?note=nightly" \
   *     -H "Authorization: Bearer $GATEWAY_PLATFORM_TOKEN" \
   *     -H "X-Bot-Sha256: $(shasum -a 256 bot.tgz | cut -d' ' -f1)" \
   *     --data-binary @bot.tgz
   */
  router.putRaw('/platform/bot-releases/:version', async (req, res) => {
    const accountId = await requireReleaseAuthor(req, db, keys)
    const version = parseBotVersion(req.params.version)
    const note = (req.query.get('note') || '').trim()
    const sha256 = String(req.headers['x-bot-sha256'] || '').trim()
    const release = await storeUploadedRelease(db, { version, note, body: req, sha256 })
    await db.audit({
      companyId: '',
      accountId: accountId || null,
      action: 'bot-release.upload',
      detail: { version: release.version, sha256: release.sha256, size: release.size },
    })
    json(res, 200, { release: publicBotRelease(release, gatewayBaseFor(req)) })
  })

  // ── Desktop 本地 Bot 发布包。按 darwin/windows/linux + x64/arm64 分开。──

  router.get('/platform/local-bot-releases', async (req, res) => {
    await requireReleaseAuthor(req, db, keys)
    const releases = await db.botReleases('local-bot')
    json(res, 200, {
      releases: releases.map((r) => publicBotRelease(r, gatewayBaseFor(req))),
      latestByTarget: Object.fromEntries(releases.flatMap((release) => {
        const target = localBotReleaseTarget(release.version)
        if (!target) return []
        const key = `${target.platform}-${target.arch}`
        return releases.find((row) => {
          const candidate = localBotReleaseTarget(row.version)
          return candidate && `${candidate.platform}-${candidate.arch}` === key
        }) === release ? [[key, release.version]] : []
      })),
    })
  })

  router.putRaw('/platform/local-bot-releases/:version', async (req, res) => {
    const accountId = await requireReleaseAuthor(req, db, keys)
    const version = parseBotVersion(req.params.version)
    if (!localBotReleaseTarget(version)) {
      throw new HttpError(400, '本地 Bot 版本必须带 darwin/windows/linux 与 x64/arm64 目标后缀')
    }
    const note = (req.query.get('note') || '').trim()
    const sha256 = String(req.headers['x-bot-sha256'] || '').trim()
    const release = await storeUploadedRelease(db, {
      version, note, body: req, sha256, kind: 'local-bot',
    })
    await db.audit({
      companyId: '', accountId: accountId || null, action: 'local-bot-release.upload',
      detail: { version: release.version, sha256: release.sha256, size: release.size },
    })
    json(res, 200, { release: publicBotRelease(release, gatewayBaseFor(req)) })
  })

  /**
   * 替某个席位签一张桌面票。owner 的支持入口——员工那边打不开桌面时，不用去问
   * VNC 口令，也不用登机器。
   *
   * 走审计：这是「看别人的屏幕」，必须留痕。票只活五分钟。
   */
  router.get('/platform/desktop-ticket', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const seatId = (req.query.get('seatId') || '').trim()
    if (!seatId) throw new HttpError(400, 'seatId 不能为空')
    /**
     * **认得出这个席位就把口令带上、把审计记到那家公司名下；认不出也照签。**
     *
     * 原先两样都没做：签票时不传 vncPassword，于是 noVNC 还是弹口令框——正好让这条路由
     * 存在的理由（上面那句「不用去问 VNC 口令」）落空；审计一律落在
     * `companyId: 'platform'`，被看屏幕的那家公司在自己的审计里一条记录都看不到，而
     * `machine.logs` 那条正是为这个理由改成按公司记的。
     *
     * **但不能因为库里没有这一行就拒签。** 这是一条救急入口：席位在机器上跑着、Gateway
     * 库里却没有对应的 seat_runtimes（登记丢了、库回滚过、或者干脆是管家侧自己登记的），
     * 恰恰是最需要它的时候。那种情况下退回原来的行为——签一张不带口令的票，审计记在
     * platform 名下——总比让人没法看屏幕强。
     */
    const row = await db.seatRuntimeBySeatId(seatId)
    await db.audit({
      companyId: row?.companyId ?? 'platform',
      accountId: account.id,
      action: 'desktop.ticket',
      detail: { seatId, byPlatform: true, ...(row ? {} : { unknownSeat: true }) },
    })
    json(res, 200, { ticket: signDesktopTicket(keys, seatId, row?.vncPassword ?? '') })
  })

  // ── 管家发布包。和 bot 那套同一个表、同一套校验，只是 kind 不同。──

  router.get('/platform/manager-releases', async (req, res) => {
    await requireReleaseAuthor(req, db, keys)
    const releases = await db.botReleases('manager')
    const settings = await db.platformSettings()
    json(res, 200, {
      releases: releases.map((r) => publicBotRelease(r, gatewayBaseFor(req))),
      latest: releases[0]?.version ?? null,
      // 空 = 跟最新走。机器按这个数字自己换版，改它就是发起一轮灰度。
      desired: settings.managerVersion ?? '',
      minNode: MIN_MANAGER_NODE,
      minProtocol: MIN_MANAGER_PROTOCOL,
    })
  })

  router.putRaw('/platform/manager-releases/:version', async (req, res) => {
    const accountId = await requireReleaseAuthor(req, db, keys)
    const version = parseBotVersion(req.params.version)
    const note = (req.query.get('note') || '').trim()
    const sha256 = String(req.headers['x-bot-sha256'] || '').trim()
    const release = await storeUploadedRelease(db, { version, note, body: req, sha256, kind: 'manager' })
    await db.audit({
      companyId: '',
      accountId: accountId || null,
      action: 'manager-release.upload',
      detail: { version: release.version, sha256: release.sha256, size: release.size },
    })
    json(res, 200, { release: publicBotRelease(release, gatewayBaseFor(req)) })
  })

  /**
   * 登记一个放在别处的发布包。界面上「新增版本」走这条。
   *
   * 和上传的区别只有字节存不存在 Gateway 上；校验一点没少（整包拉一遍比对 size 和
   * sha256、确认入口文件在），验不过不入库。
   */
  router.post('/platform/bot-releases', async (req, res) => {
    await requireReleaseAuthor(req, db, keys)
    json(res, 201, { release: publicBotRelease(await registerFromBody(db, req, 'bot'), gatewayBaseFor(req)) })
  })

  router.post('/platform/manager-releases', async (req, res) => {
    await requireReleaseAuthor(req, db, keys)
    json(res, 201, { release: publicBotRelease(await registerFromBody(db, req, 'manager'), gatewayBaseFor(req)) })
  })

  router.post('/platform/local-bot-releases', async (req, res) => {
    await requireReleaseAuthor(req, db, keys)
    const body = bodyOf(req)
    const version = strField(body, 'version')
    if (!localBotReleaseTarget(version)) {
      throw new HttpError(400, '本地 Bot 版本缺少平台与架构后缀')
    }
    json(res, 201, {
      release: publicBotRelease(await registerFromBody(db, req, 'local-bot'), gatewayBaseFor(req)),
    })
  })

  /**
   * 装机脚本。**公开**——它不含任何秘密，配对码是装机的人从命令行传进去的。
   *
   * 脚本里的 Gateway 地址按请求的 Host 填好，所以复制粘贴那条命令就能跑，不用再
   * 让人手填一遍地址（填错地址是这一步最常见的事故）。
   */
  router.get('/install-manager.sh', async (req, res) => {
    const script = installScript(gatewayBaseFor(req))
    res.writeHead(200, { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'no-store' })
    res.end(script)
  })

  /**
   * 装机脚本下载管家包。**两种凭据，按机器有没有配过对分**：
   *
   * · 头一回装：**配对码**——那时还没有 `smt_`，它要配对之后才有。码在这里只用来看
   *   「是不是一张有效的票」，不消费它：真正的认领在 /machines/pair。下错了包可以重来，
   *   认领错了要重新生成码。
   * · **已经配过对的机器：机器票**。重跑装机脚本是这套东西的修复手段（补一个缺掉的
   *   `satuwork-worker` 单元、救一次卡住的自升级、换地址之后重铺一遍，见 manager/README.md），
   *   而那时手上早就没有配对码了。只认码的话，重跑会死在这条 401 上——README 承诺的
   *   「重跑一次就是修复手段」就成了一句脚本兑现不了的话。
   */
  router.get('/manager/release', async (req, res) => {
    const code = normalizePairingCode(req.query.get('code') || '')
    /**
     * **认出是哪台机器就要把它带上**：`desiredManagerRelease` 靠 machine 认两件事——
     * 这台机器钉的版本（`desiredManagerVersion`），以及**架构**。少了它，取的是
     * `latestBotRelease('manager', null)`，而 CI 是 arm64 先、x64 后串行上传的，「最新」
     * 通常是 x64 包——一台 arm 机器重跑装机脚本就会装上一个起不起来的架构，而重跑
     * 正是这条分支存在的理由。钉了版本的机器同样会被绕过去：装成最新之后，下一次
     * 心跳 Gateway 又按 pin 把它换回来，白重启一轮管家和工人。
     *
     * 配对码那条路没有机器可带（记录还不存在、也不知道 arch），只能按平台默认给。
     */
    let machine: Machine | undefined
    if (code) {
      const pairing = await db.machinePairing(code)
      if (!pairing || pairing.usedAt || pairing.expiresAt <= Date.now()) throw new HttpError(401, '配对码无效或已过期')
    } else {
      // 没给码就必须拿得出机器票。两样都没有仍然是 401，和以前一样。
      machine = await requireMachine(req, db)
    }
    const desired = await desiredManagerRelease(db, machine)
    if (!desired) throw new HttpError(409, '还没有发布机器管家版本')
    await sendReleaseFile(res, 'manager', desired.version, db)
  })

  router.post('/platform/orgs/:id/runtime/update', async (req, res) => {
    const actor = await requireOrgUser(req, db, keys, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    const requested = strField(body, 'version', false)
    let version: string
    if (requested) {
      parseBotVersion(requested)
      const rel = await db.botRelease(requested)
      if (!rel) throw new HttpError(404, '没有这个 Bot 版本')
      version = rel.version
    } else {
      const latest = await db.latestBotRelease()
      if (!latest) throw new HttpError(409, '还没有发布 Bot 版本')
      version = latest.version
    }
    const seats = (await db.seatRuntimesOf(company.id)).filter((r) => r.status !== 'none')
    /**
     * `busy` 是**第三种结局**，不是一种失败：席位上有人正在说话，管家等过了也没等到
     * 这一轮结束，于是什么都没动（见 manager/src/seats.ts 的排空）。界面上要分开数——
     * 混进「失败」里，一次「今天中午大家都在用」会被报成一片红，人会去查根本不存在
     * 的部署故障。
     */
    const results: { accountId: string; botId: string; status: string; botVersion: string | null; error?: string; busy?: boolean }[] = []
    for (const seat of seats) {
      const row = await db.account(seat.accountId)
      if (!row) {
        results.push({
          accountId: seat.accountId,
          botId: seat.botId,
          status: seat.status,
          botVersion: seat.botVersion ?? null,
          error: '账号不存在',
        })
        continue
      }
      const out = await deploySeat(db, keys, row, { botId: seat.botId, version, update: true })
      if (out.ok) {
        results.push({
          accountId: row.id,
          botId: seat.botId,
          status: out.result.runtime.status,
          botVersion: out.result.runtime.botVersion ?? null,
        })
      } else {
        results.push({
          accountId: row.id,
          botId: seat.botId,
          status: out.runtime?.status ?? 'error',
          botVersion: out.runtime?.botVersion ?? null,
          error: out.error,
          // 认 out.busy，不认状态码：deploySeat 有六处 409（见它的返回类型）。
          ...(out.busy ? { busy: true } : {}),
        })
      }
    }
    await db.audit({
      companyId: company.id,
      accountId: actor.id,
      action: 'runtime.update',
      detail: { version, count: results.length },
    })
    json(res, 200, { version, results })
  })

  router.get('/platform/orgs/:id/accounts/:accountId/runtime', async (req, res) => {
    const account = await requireOwnerUser(req, db, keys)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const row = await db.account(req.params.accountId)
    if (!row || row.companyId !== company.id) throw new HttpError(404, '账号不存在')
    const machineOf = machineResolver(db)
    const botId = (req.query.get('botId') || '').trim()
    if (botId) {
      const runtime = await db.seatRuntime(row.id, botId)
      if (!runtime) throw new HttpError(404, '还没有部署')
      json(res, 200, { runtimes: [publicSeatRuntime(runtime, (await machineOf(runtime)) ?? null, { includePassword: true })] })
      return
    }
    const runtimes = await Promise.all(
      (await db.seatRuntimesOfAccount(row.id)).map(async (rt) =>
        publicSeatRuntime(rt, (await machineOf(rt)) ?? null, { includePassword: true }),
      ),
    )
    json(res, 200, { runtimes })
  })
}
