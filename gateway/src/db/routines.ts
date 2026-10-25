/**
 * 长期记忆、日常任务（定义、排期、流水）、席位工人领任务。
 */
import { randomUUID } from 'node:crypto'
import { type Memory, type MemoryKind, type MemoryLayer, type Routine, ROUTINE_RUNS_KEEP, type RoutineModelRole, type RoutineRun, type RoutineRunStatus, type RoutineRunTrigger, type RoutineTrigger } from './types.ts'
import { isUniqueViolation, memoryOf, routineOf, routineRunOf } from './rows.ts'
import { DbCore } from './core.ts'

/** 同一条日常任务已有一条 running 流水（见迁移 0035）。路由把它翻成 409。 */
export class RoutineBusyError extends Error {
  constructor(readonly routineId: string) {
    super('上一次还在跑')
    this.name = 'RoutineBusyError'
  }
}

export class RoutinesDb extends DbCore {
  // ── 长期记忆（docs/memory.md）────────────────────────────────────────

  /**
   * 这颗 Bot 读得到的全部记忆。
   *
   * **可见性写进 where，不在调用点过滤**——`botsFor` 的注释已经把这条立成规矩，私有档
   * Skill 照办过一次，这里是第三次。在应用层 filter 一次就够漏一次，而漏的表现是
   * 「别人的 Bot 记的东西出现在我这儿」。
   *
   * 四层拼在一条 SQL 里：
   *
   * - `bot`：这个人 + **这一颗** Bot；`botId` 为空时这一层整个不取（没有 botId 就不知道
   *   该给谁的，同 `skillsFor` 的口径）
   * - `self`：这个人，跨他所有 Bot
   * - `group`：他在的那几个分组（分组成员表是一个 jsonb 数组，解算在下面那半段）
   * - `company`：这家公司
   *
   * **不在这儿按 scope 裁**：模版上「记忆范围」那三个 pill 决定注入时读哪几层，那是
   * 席位装配提示词时的事。这里给的是"看得见的全部"，`memory_list` 也要靠它——一条
   * `company` 层的记忆正在影响这颗 Bot，藏起来的话「它怎么知道这件事的」就没有出处。
   */
  async memoriesFor(companyId: string, accountId: string, botId: string | null): Promise<Memory[]> {
    const groups = (await this.db.groupsOf(companyId)).filter((g) => g.members.includes(accountId))
    const where: string[] = ['(layer = \'self\' and "accountId" = ?)', '(layer = \'company\' and "companyId" = ?)']
    const args: (string | number)[] = [accountId, companyId]
    if (botId) {
      where.unshift('(layer = \'bot\' and "accountId" = ? and "botId" = ?)')
      args.unshift(accountId, botId)
    }
    if (groups.length) {
      where.push(`(layer = 'group' and "groupId" in (${groups.map(() => '?').join(',')}))`)
      args.push(...groups.map((g) => g.id))
    }
    const rows = await this.many(
      `select * from memories where ${where.join(' or ')} order by pinned desc, "updatedAt" desc`,
      args,
    )
    return rows.map(memoryOf)
  }

  async memory(id: string): Promise<Memory | undefined> {
    const r = await this.one('select * from memories where id = ?', [(id || '').trim()])
    return r ? memoryOf(r) : undefined
  }

  async insertMemory(input: {
    layer: MemoryLayer
    companyId: string
    accountId?: string | null
    botId?: string | null
    groupId?: string | null
    kind: MemoryKind
    text: string
    by: 'agent' | 'user'
    sourceSessionId?: string | null
    pii?: string[]
    pinned?: boolean
    expiresAt?: number | null
  }): Promise<Memory> {
    const now = Date.now()
    const row: Memory = {
      id: randomUUID(),
      layer: input.layer,
      companyId: input.companyId,
      /**
       * **上面两层强制不带 accountId / botId。**
       *
       * 它们不是"顺手留个来源"：`memoriesFor` 的 where 是按 (layer, accountId) 认的,
       * 一条 `company` 层却挂着 accountId 的记录，会同时被 company 这一支和别处的
       * 判断认领。写进去的那一刻不裁掉，之后任何一处读的地方都得记得裁一次。
       */
      accountId: input.layer === 'bot' || input.layer === 'self' ? (input.accountId ?? null) : null,
      // **只有 bot 层挂 botId。** self 层挂了的话，删掉那颗 Bot 会把它一起 cascade 掉
      // ——而它本该跨这个人所有的 Bot（docs/memory.md §12 ④）。
      botId: input.layer === 'bot' ? (input.botId ?? null) : null,
      groupId: input.layer === 'group' ? (input.groupId ?? null) : null,
      kind: input.kind,
      text: input.text,
      by: input.by,
      sourceSessionId: input.sourceSessionId ?? null,
      pii: input.pii ?? [],
      pinned: input.pinned ?? false,
      expiresAt: input.expiresAt ?? null,
      createdAt: now,
      updatedAt: now,
    }
    await this.run(
      'insert into memories (id, layer, "companyId", "accountId", "botId", "groupId", kind, text, "by", "sourceSessionId", pii, pinned, "expiresAt", "createdAt", "updatedAt") values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        row.id,
        row.layer,
        row.companyId,
        row.accountId,
        row.botId,
        row.groupId,
        row.kind,
        row.text,
        row.by,
        row.sourceSessionId,
        JSON.stringify(row.pii),
        row.pinned,
        row.expiresAt,
        row.createdAt,
        row.updatedAt,
      ],
    )
    return row
  }

  /**
   * 改一条。**层改不了**——升层是搬家（换归属列），走 `liftMemory`，不是改一个字段。
   */
  async updateMemory(
    id: string,
    patch: {
      kind?: MemoryKind
      text?: string
      pii?: string[]
      pinned?: boolean
      expiresAt?: number | null
      by?: 'agent' | 'user'
    },
  ): Promise<Memory | undefined> {
    const sets: string[] = []
    const args: (string | number | boolean | null)[] = []
    if (patch.kind !== undefined) {
      sets.push('kind = ?')
      args.push(patch.kind)
    }
    if (patch.text !== undefined) {
      sets.push('text = ?')
      args.push(patch.text)
    }
    if (patch.pii !== undefined) {
      sets.push('pii = ?')
      args.push(JSON.stringify(patch.pii))
    }
    if (patch.pinned !== undefined) {
      sets.push('pinned = ?')
      args.push(patch.pinned)
    }
    if (patch.expiresAt !== undefined) {
      sets.push('"expiresAt" = ?')
      args.push(patch.expiresAt)
    }
    if (patch.by !== undefined) {
      sets.push('"by" = ?')
      args.push(patch.by)
    }
    if (!sets.length) return this.memory(id)
    sets.push('"updatedAt" = ?')
    args.push(Date.now(), id)
    await this.run(`update memories set ${sets.join(', ')} where id = ?`, args)
    return this.memory(id)
  }

  /**
   * 升层：把一条 `self` 记忆推给分组或全公司。
   *
   * **是搬家不是复制**，同私有档 Skill 的「晋升」（docs/skills.md §7）：留一份在原处的
   * 话，两份会各自被编辑，然后在某一天说不同的话，而人不知道自己在改哪一份。
   *
   * 归属列跟着一起换：升上去之后 `accountId` / `botId` 必须清空，理由见 insertMemory。
   */
  async liftMemory(id: string, to: 'group' | 'company', groupId?: string | null): Promise<Memory | undefined> {
    await this.run(
      'update memories set layer = ?, "groupId" = ?, "accountId" = null, "botId" = null, "updatedAt" = ? where id = ?',
      [to, to === 'group' ? (groupId ?? null) : null, Date.now(), id],
    )
    return this.memory(id)
  }

  async deleteMemory(id: string): Promise<boolean> {
    return (await this.run('delete from memories where id = ?', [id])) > 0
  }

  // ── 日常任务：定义、排期与流水 ────────────────────────────────────────

  /** 这个人在这颗 Bot 上的全部日常任务。侧栏那一列就是它。 */
  async routinesOf(accountId: string, botId: string): Promise<Routine[]> {
    const rows = await this.many('select * from routines where "accountId" = ? and "botId" = ? order by "createdAt"', [accountId, botId])
    return rows.map(routineOf)
  }

  async routine(id: string): Promise<Routine | undefined> {
    const r = await this.one('select * from routines where id = ?', [id])
    return r ? routineOf(r) : undefined
  }

  async insertRoutine(input: {
    botId: string
    accountId: string
    companyId: string
    name: string
    instruction?: string
    triggers?: RoutineTrigger[]
    modelRole?: RoutineModelRole
    nextRunAt?: number | null
  }): Promise<Routine> {
    const now = Date.now()
    const row: Routine = {
      id: randomUUID(),
      botId: input.botId,
      accountId: input.accountId,
      companyId: input.companyId,
      name: input.name,
      instruction: input.instruction ?? '',
      active: true,
      triggers: input.triggers ?? [],
      // 没指定就是 daily：和人自己问它时同一个模型（见 RoutineModelRole）。
      modelRole: input.modelRole ?? 'daily',
      nextRunAt: input.nextRunAt ?? null,
      // 新建的一条不欠任何重试。这两格明写出来，不靠库里的 default——返回的这个对象
      // 就是调用方拿去用的那一份，少一格就是一个 undefined 混进业务里。
      retryAt: null,
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    }
    await this.run(
      'insert into routines (id, "botId", "accountId", "companyId", name, instruction, active, triggers, "modelRole", "nextRunAt", "retryAt", "retryCount", "createdAt", "updatedAt") values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [row.id, row.botId, row.accountId, row.companyId, row.name, row.instruction, row.active, JSON.stringify(row.triggers), row.modelRole, row.nextRunAt, row.retryAt, row.retryCount, row.createdAt, row.updatedAt],
    )
    return row
  }

  /**
   * 改一条。**只改传了的字段**——界面上改名字和改触发时间是两次独立的保存，
   * 整行覆盖会让后到的那次把前一次的输入抹掉。
   */
  async updateRoutine(
    id: string,
    patch: {
      name?: string
      instruction?: string
      active?: boolean
      triggers?: RoutineTrigger[]
      modelRole?: RoutineModelRole
      nextRunAt?: number | null
      retryAt?: number | null
      retryCount?: number
    },
  ): Promise<Routine | undefined> {
    const sets: string[] = []
    const args: unknown[] = []
    if (patch.name !== undefined) (sets.push('name = ?'), args.push(patch.name))
    if (patch.instruction !== undefined) (sets.push('instruction = ?'), args.push(patch.instruction))
    if (patch.active !== undefined) (sets.push('active = ?'), args.push(patch.active))
    if (patch.triggers !== undefined) (sets.push('triggers = ?'), args.push(JSON.stringify(patch.triggers)))
    if (patch.modelRole !== undefined) (sets.push('"modelRole" = ?'), args.push(patch.modelRole))
    if (patch.nextRunAt !== undefined) (sets.push('"nextRunAt" = ?'), args.push(patch.nextRunAt))
    if (patch.retryAt !== undefined) (sets.push('"retryAt" = ?'), args.push(patch.retryAt))
    if (patch.retryCount !== undefined) (sets.push('"retryCount" = ?'), args.push(patch.retryCount))
    sets.push('"updatedAt" = ?')
    args.push(Date.now(), id)
    await this.run(`update routines set ${sets.join(', ')} where id = ?`, args)
    return this.routine(id)
  }

  async deleteRoutine(id: string): Promise<boolean> {
    return (await this.run('delete from routines where id = ?', [id])) > 0
  }

  /** 到点该跑的那几条。调度器每一轮问一次。 */
  /**
   * 本地 Bot（桌面端）的任务**不在这里**：Gateway 连不到员工的电脑，抢到也跑不了，只会每次
   * 记一条「实例还没上线」再补跑三次。它们等桌面端自己的调度器（ADR §4），在那之前静静排着。
   * 排除放在 SQL 里而不是抢到再跳过：跳过的那些每一拍都会把 limit 占满，远程的排不进来。
   */
  async dueRoutines(nowMs: number, limit = 20): Promise<Routine[]> {
    const rows = await this.many(
      `select r.* from routines r
        where r.active and r."nextRunAt" is not null and r."nextRunAt" <= ?
          and not exists (select 1 from catalog_items c where c.id = r."botId" and c.definition->>'runtimeKind' = 'local')
        order by r."nextRunAt" limit ?`,
      [nowMs, Math.max(1, Math.trunc(limit))],
    )
    return rows.map(routineOf)
  }

  /**
   * 抢一条到点的任务：把 `nextRunAt` 从「刚才读到的那个值」换成下一次。
   *
   * **条件里必须带上旧值**，不能只按 id 更新。两个 Gateway 进程（升级时的新旧两代、
   * 或者以后多开）会在同一秒读到同一条，谁都觉得该自己跑——CAS 之后只有一个人的
   * `rowCount` 是 1，另一个拿到 0 就跳过。少了这一句，每天九点的日报会发两份。
   */
  async claimRoutine(id: string, expectedNextRunAt: number, nextRunAt: number | null): Promise<boolean> {
    // **抢到新的一次，就把欠着的那次重试一笔勾销**（见 routines.ts 的重试那一节）。
    // 不勾销的话，21:00 那次失败排下的 21:05 重试，会和 22:00 到点的那一次一起排着
    // ——而 22:00 这一次做的就是同一件事，重试已经没有意义了。
    const n = await this.run(
      'update routines set "nextRunAt" = ?, "retryAt" = null, "retryCount" = 0, "updatedAt" = ? where id = ? and "nextRunAt" = ?',
      [nextRunAt, Date.now(), id, expectedNextRunAt],
    )
    return n > 0
  }

  /** 欠着重试、而且到点了的那几条。和 dueRoutines 分开问：两条路的处置完全不同。 */
  async dueRoutineRetries(nowMs: number, limit = 20): Promise<Routine[]> {
    const rows = await this.many(
      `select r.* from routines r
        where r.active and r."retryAt" is not null and r."retryAt" <= ?
          and not exists (select 1 from catalog_items c where c.id = r."botId" and c.definition->>'runtimeKind' = 'local')
        order by r."retryAt" limit ?`,
      [nowMs, Math.max(1, Math.trunc(limit))],
    )
    return rows.map(routineOf)
  }

  /**
   * 抢一次重试：把 `retryAt` 抹掉，**但留着 `retryCount`**——它记的是「这一串补跑到
   * 第几次了」，抢的时候归零就等于每次都从 5 分钟重新数，永远停不下来。
   *
   * 同 claimRoutine，条件里带旧值：两个 Gateway 进程同时扫到同一条时只有一个抢得到。
   */
  async claimRoutineRetry(id: string, expectedRetryAt: number): Promise<boolean> {
    const n = await this.run('update routines set "retryAt" = null, "updatedAt" = ? where id = ? and "retryAt" = ?', [
      Date.now(),
      id,
      expectedRetryAt,
    ])
    return n > 0
  }

  /** 排下一次重试。`retryCount` 由调用方算，因为「还剩几次」的规矩在调度器那边。 */
  async armRoutineRetry(id: string, retryAt: number, retryCount: number): Promise<void> {
    await this.run('update routines set "retryAt" = ?, "retryCount" = ?, "updatedAt" = ? where id = ?', [
      retryAt,
      Math.max(0, Math.trunc(retryCount)),
      Date.now(),
      id,
    ])
  }

  /** 这一串补跑结束了（跑成了、停用了、或者不该再补）：两格一起清干净。 */
  async clearRoutineRetry(id: string): Promise<void> {
    await this.run('update routines set "retryAt" = null, "retryCount" = 0, "updatedAt" = ? where id = ?', [Date.now(), id])
  }

  async insertRoutineRun(input: {
    routineId: string
    botId: string
    accountId: string
    companyId: string
    trigger: RoutineRunTrigger
    sessionId?: string | null
    /** 该由谁跑、租约到几点。试跑登记时只填 machineId、租约空着（等人来领）；跑不了的两格都空。 */
    machineId?: string | null
    leaseUntil?: number | null
  }): Promise<RoutineRun> {
    const row: RoutineRun = {
      id: randomUUID(),
      routineId: input.routineId,
      botId: input.botId,
      accountId: input.accountId,
      companyId: input.companyId,
      trigger: input.trigger,
      status: 'running',
      sessionId: input.sessionId ?? null,
      error: null,
      startedAt: Date.now(),
      endedAt: null,
      machineId: input.machineId ?? null,
      leaseUntil: input.leaseUntil ?? null,
    }
    try {
      await this.run(
        'insert into routine_runs (id, "routineId", "botId", "accountId", "companyId", trigger, status, "sessionId", error, "startedAt", "endedAt", "machineId", "leaseUntil") values (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [row.id, row.routineId, row.botId, row.accountId, row.companyId, row.trigger, row.status, row.sessionId, row.error, row.startedAt, row.endedAt, row.machineId, row.leaseUntil],
      )
    } catch (e) {
      // 0035 的部分唯一索引：同一条任务已有 running 流水。调用方先查 `routineRunning` 只是
      // 让常见路径少一次报错，真正的判据在这里，并发也挡得住。
      if (isUniqueViolation(e)) throw new RoutineBusyError(input.routineId)
      throw e
    }
    // 只留最近几十条。这张表是「昨晚跑没跑」，留全量只会让侧栏那一列越查越慢。
    await this.run(
      'delete from routine_runs where "routineId" = ? and id not in (select id from routine_runs where "routineId" = ? order by "startedAt" desc limit ?)',
      [input.routineId, input.routineId, ROUTINE_RUNS_KEEP],
    )
    return row
  }

  /**
   * 改一条流水的状态。**只改还在 running 的那一条**，返回改没改到。
   *
   * 以前按 id 无条件改：租约清扫（failExpiredRoutineLeases）刚把它收成 error 并排了补跑，
   * 同一刻工人报「开跑了」就把它写回 running，一次已收场的运行被复活；两次并发的收尾都
   * 过了 claimedRun，armRetry 连跑两次、少补一次。收过场的流水一律不再动，调用方看返回值。
   */
  async finishRoutineRun(id: string, patch: { status: RoutineRunStatus; error?: string | null; sessionId?: string | null }): Promise<boolean> {
    const sets = ['status = ?', 'error = ?', '"endedAt" = ?']
    const args: unknown[] = [patch.status, patch.error ?? null, patch.status === 'running' ? null : Date.now()]
    if (patch.sessionId !== undefined) (sets.push('"sessionId" = ?'), args.push(patch.sessionId))
    args.push(id)
    return (await this.run(`update routine_runs set ${sets.join(', ')} where id = ? and status = 'running'`, args)) > 0
  }

  async routineRuns(routineId: string, limit = 10): Promise<RoutineRun[]> {
    const rows = await this.many('select * from routine_runs where "routineId" = ? order by "startedAt" desc limit ?', [
      routineId,
      Math.max(1, Math.trunc(limit)),
    ])
    return rows.map(routineRunOf)
  }

  /** 这条任务还有没有一次没跑完的。同一条任务不并发跑两次，靠它判。 */
  async routineRunning(routineId: string): Promise<RoutineRun | undefined> {
    const r = await this.one('select * from routine_runs where "routineId" = ? and status = \'running\' order by "startedAt" desc limit 1', [
      routineId,
    ])
    return r ? routineRunOf(r) : undefined
  }

  /**
   * 收掉登记之后一直没人来领的试跑。
   *
   * 没有租约（`leaseUntil` 为空）的 `running` 只有一种：试跑登记了、等工人或本地 Bot 来领
   * （routines.ts 的 requestManualRun）。领走的那一刻租约才开始计；隔了这么久还没人领，就是
   * 机器关着、工人没起来、或者桌面端没开——记成 error 把话说明，别让那个圈永远转着，
   * 也别让并发判据一直认为它还在跑。
   *
   * 划线按 `startedAt`（登记时刻），位置由调用方给（PICKUP_MS）。
   */
  async failUnclaimedRoutineRuns(startedBefore: number): Promise<number> {
    return this.run(
      "update routine_runs set status = 'error', error = ?, \"endedAt\" = ? where status = 'running' and \"leaseUntil\" is null and \"startedAt\" < ?",
      ['没有机器来领这一次（管家离线、工人没起来，或者桌面端没开）', Date.now(), startedBefore],
    )
  }

  // ── 席位工人领任务（见迁移 0039、routes/worker.ts）────────────────────

  /**
   * 这台机器上到点的任务。**按席位表连出来**：任务归 (accountId, botId)，席位表记着这一对
   * 落在哪台机器上。没部署过的 Bot 连不出来——它也没有会话可发，本来就不该跑。
   */
  async dueRoutinesForMachine(machineId: string, nowMs: number, limit = 20): Promise<Routine[]> {
    const rows = await this.many(
      `select r.* from routines r
         join seat_runtimes s on s."accountId" = r."accountId" and s."botId" = r."botId"
        where s."machineId" = ? and r.active and r."nextRunAt" is not null and r."nextRunAt" <= ?
        order by r."nextRunAt" limit ?`,
      [machineId, nowMs, Math.max(1, Math.trunc(limit))],
    )
    return rows.map(routineOf)
  }

  async dueRoutineRetriesForMachine(machineId: string, nowMs: number, limit = 20): Promise<Routine[]> {
    const rows = await this.many(
      `select r.* from routines r
         join seat_runtimes s on s."accountId" = r."accountId" and s."botId" = r."botId"
        where s."machineId" = ? and r.active and r."retryAt" is not null and r."retryAt" <= ?
        order by r."retryAt" limit ?`,
      [machineId, nowMs, Math.max(1, Math.trunc(limit))],
    )
    return rows.map(routineOf)
  }

  /**
   * 这个账号的**本地 Bot**（桌面端）到点的任务。dueRoutines 把本地 Bot 排除在外（Gateway 连不到
   * 员工的电脑），它们由桌面端里的 Bot 进程自己来领（routes/worker.ts 的 /runtime/local-routines）。
   */
  async dueRoutinesForLocalAccount(accountId: string, nowMs: number, limit = 20): Promise<Routine[]> {
    const rows = await this.many(
      `select r.* from routines r join catalog_items c on c.id = r."botId"
        where r."accountId" = ? and c.definition->>'runtimeKind' = 'local'
          and r.active and r."nextRunAt" is not null and r."nextRunAt" <= ?
        order by r."nextRunAt" limit ?`,
      [accountId, nowMs, Math.max(1, Math.trunc(limit))],
    )
    return rows.map(routineOf)
  }

  async dueRoutineRetriesForLocalAccount(accountId: string, nowMs: number, limit = 20): Promise<Routine[]> {
    const rows = await this.many(
      `select r.* from routines r join catalog_items c on c.id = r."botId"
        where r."accountId" = ? and c.definition->>'runtimeKind' = 'local'
          and r.active and r."retryAt" is not null and r."retryAt" <= ?
        order by r."retryAt" limit ?`,
      [accountId, nowMs, Math.max(1, Math.trunc(limit))],
    )
    return rows.map(routineOf)
  }

  /** 这台机器领走、还在跑的那一条。别的机器的、已经收场的一律 undefined——工人拿不到别人的活。 */
  async routineRunOfMachine(runId: string, machineId: string): Promise<RoutineRun | undefined> {
    const r = await this.one('select * from routine_runs where id = ? and "machineId" = ? and status = \'running\'', [runId, machineId])
    return r ? routineRunOf(r) : undefined
  }

  /**
   * 领走登记给这一方、还没人领的试跑（requestManualRun 登记的那些：machineId 指向它、租约空着）。
   * 把租约填上就是领走了；`returning` 交回行，调用方拼成活。
   */
  async pickUpRoutineRuns(machineId: string, leaseUntil: number, limit = 20): Promise<RoutineRun[]> {
    const rows = await this.many(
      `update routine_runs set "leaseUntil" = ?
        where id in (
          select id from routine_runs
           where "machineId" = ? and status = 'running' and "leaseUntil" is null
           order by "startedAt" limit ?
        )
        returning *`,
      [leaseUntil, machineId, Math.max(1, Math.trunc(limit))],
    )
    return rows.map(routineRunOf)
  }

  /** 续租。回 false = 这条已经不归你了（租约到期被收掉、或早已收场），工人该停手。 */
  async renewRoutineRun(runId: string, machineId: string, leaseUntil: number): Promise<boolean> {
    const n = await this.run(
      'update routine_runs set "leaseUntil" = ? where id = ? and "machineId" = ? and status = \'running\'',
      [leaseUntil, runId, machineId],
    )
    return n > 0
  }

  /**
   * 租约到期没续的那些：记成「机器没回报」，把行交回去让调度器排补跑。
   *
   * 走 `returning`：调用方要按 routineId 排重试，光一个计数不够。
   */
  async failExpiredRoutineLeases(nowMs: number): Promise<RoutineRun[]> {
    const rows = await this.many(
      `update routine_runs set status = 'error', error = ?, "endedAt" = ?
        where status = 'running' and "leaseUntil" is not null and "leaseUntil" < ?
        returning *`,
      ['机器没回报（工人的租约到期了：机器离线、工人没起来、或者中途被杀）', Date.now(), nowMs],
    )
    return rows.map(routineRunOf)
  }
}
