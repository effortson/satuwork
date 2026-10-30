/**
 * 转人工的交接单（docs/handoff.md）。
 */
import type { Handoff, HandoffState, Role } from './types.ts'
import { handoffOf, num } from './rows.ts'
import { DbCore } from './core.ts'

export class HandoffsDb extends DbCore {
  // ── 转人工的交接单（见 docs/handoff.md）────────────────────────────────

  async handoff(id: string): Promise<Handoff | undefined> {
    const r = await this.one('select * from handoffs where id = ?', [id])
    return r ? handoffOf(r) : undefined
  }

  /**
   * 席位报上来的一张单（或它的一次状态流转）。
   *
   * **id 由席位给**，这边只 upsert：单号在会话日志里已经写下了，Gateway 再发一个自己的
   * 号，两边就再也对不上——而「点开这张单看正文」正是拿这个号去席位要的。
   *
   * `assignee` / `machineId` 是**这边算的**，不收上报方指定：前者要读公司模版和成员表，
   * 后者决定之后敲哪台机器——采信 body 等于让调用方指定这张单"属于"哪台机器。
   * 所以它们只在插入时写一次，之后的流转不覆盖（人已经接手了，指派再变没有意义）。
   *
   * **更新那一支还要认账号和公司**：id 是席位给的，一把席位票只代表一个账号，但它报
   * 上来的 id 可以是任何字符串。不带这两条判据的话，一台被拿下的席位只要报一个已经
   * 存在的单号，就能改掉别人（甚至别家公司）那张单的状态。UUID 猜不出来不是理由——
   * 那是"难以利用"，不是"拦住了"。
   */
  async upsertHandoff(input: {
    id: string
    sessionId: string
    botId: string
    accountId: string
    companyId: string
    machineId: string | null
    state: HandoffState
    assignee: string | null
    claimedBy: string | null
    blocking: boolean
    repeats: number
    reason: string
    ask: string
    createdAt: number
    updatedAt: number
  }): Promise<Handoff> {
    /**
     * **只有真的被人接手过才落 claimedAt。**
     *
     * 照「不是 open 就算接过」写的话，`expired` / `cancelled` 这些**从来没人碰过**的
     * 单子也会被写上一个 claimedAt，而 `handoffStats` 的 p50（多久有人接）正是
     * `filter (claimedAt is not null)`——于是恰恰是没人接的那些单子，把响应速度这个
     * 数字拖到最难看。
     *
     * `returned` 也算：绝大多数人是直接在对话里处理完交还的，没点过「我来接手」，
     * 那一刻就是这件事第一次落到人手上。已经有值的不会被盖掉（下面 coalesce 取先到的）。
     */
    const claimedAt = input.state === 'claimed' || input.state === 'returned' ? input.updatedAt : null
    const returnedAt = input.state === 'returned' ? input.updatedAt : null
    const closedAt = input.state === 'closed' || input.state === 'expired' || input.state === 'cancelled' ? input.updatedAt : null
    await this.run(
      `insert into handoffs (id, "sessionId", "botId", "accountId", "companyId", "machineId", state, assignee, "claimedBy",
         blocking, repeats, reason, ask, "notifyStep", "createdAt", "claimedAt", "returnedAt", "closedAt", "updatedAt")
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?)
       on conflict (id) do update set
         state = excluded.state,
         "claimedBy" = coalesce(excluded."claimedBy", handoffs."claimedBy"),
         repeats = excluded.repeats,
         "claimedAt" = coalesce(handoffs."claimedAt", excluded."claimedAt"),
         "returnedAt" = coalesce(excluded."returnedAt", handoffs."returnedAt"),
         "closedAt" = coalesce(excluded."closedAt", handoffs."closedAt"),
         "updatedAt" = excluded."updatedAt"
       where excluded."updatedAt" >= handoffs."updatedAt"
         and handoffs."accountId" = excluded."accountId"
         and handoffs."companyId" = excluded."companyId"`,
      [
        input.id, input.sessionId, input.botId, input.accountId, input.companyId, input.machineId, input.state,
        input.assignee, input.claimedBy, input.blocking, input.repeats, input.reason.slice(0, 500),
        input.ask.slice(0, 500), input.createdAt, claimedAt, returnedAt, closedAt, input.updatedAt,
      ],
    )
    // 读回真正落下去的那一行：判据挡下时它还是原来的主人，那时候要抛，不能把它回出去。
    const saved = await this.handoff(input.id)
    if (!saved || saved.accountId !== input.accountId || saved.companyId !== input.companyId) {
      throw new Error(`交接单 ${input.id} 属于别的账号，拒绝改写`)
    }
    return saved
  }

  /**
   * 我看得见的那几张。
   *
   * - `member`：自己名下的 Bot 开的，加上指名给自己的
   * - `admin`：本公司全部（管理员是所有单子的兜底接手人）
   *
   * **不分页。** 待办不是流水：一家公司同时挂着几十张没人接的单，那是要去救火的信号，
   * 不是要翻第二页的信号。
   */
  async handoffsFor(
    who: { id: string; companyId: string; role: Role },
    opts: { live?: boolean; mine?: boolean; limit?: number } = {},
  ): Promise<Handoff[]> {
    const where: string[] = ['"companyId" = ?']
    const args: unknown[] = [who.companyId]
    if (who.role === 'member') {
      where.push('("accountId" = ? or assignee = ? or "claimedBy" = ?)')
      args.push(who.id, who.id, who.id)
    }
    if (opts.mine) {
      /**
       * 「要我处理的」。
       *
       * 管理员多算一类：`assignee is null` 是「模版上指给管理员」，谁都可以接——把它
       * 排除掉的话，顶栏那个数（`openHandoffCount` 是算进去的）和这一页的清单会对不上，
       * 而人只会以为其中一处坏了。
       */
      // 判据和 openHandoffCount 逐字一致（那边的注释写了为什么）。
      if (who.role === 'member') {
        where.push('(assignee = ? or "claimedBy" = ? or (assignee is null and "accountId" = ?))')
        args.push(who.id, who.id, who.id)
      } else {
        where.push('(assignee = ? or assignee is null or "claimedBy" = ?)')
        args.push(who.id, who.id)
      }
    }
    if (opts.live !== false) where.push(`state in ('open','claimed','returned')`)
    args.push(Math.max(1, Math.trunc(opts.limit ?? 200)))
    const rows = await this.many(
      `select * from handoffs where ${where.join(' and ')} order by "createdAt" desc limit ?`,
      args,
    )
    return rows.map(handoffOf)
  }

  /** 这条会话上还没闭合的那几张。会话卡片和「挡不挡日常任务」都问它。 */
  async handoffsOfSession(sessionId: string): Promise<Handoff[]> {
    const rows = await this.many(
      `select * from handoffs where "sessionId" = ? and state in ('open','claimed','returned') order by "createdAt"`,
      [sessionId],
    )
    return rows.map(handoffOf)
  }

  /**
   * 顶栏那个计数：要我处理、还没处理完的有几张。
   *
   * 管理员多算一类——`assignee is null` 是「模版上指给管理员」，谁都可以接。
   */
  async openHandoffCount(who: { id: string; companyId: string; role: Role }): Promise<number> {
    // **和 handoffsFor(mine) 是同一条判据，改一处就要改另一处。** 这两处曾经写岔：
    // 计数认「指给我的 + 我名下且没指人的」，清单认「指给我的 + 我接手的」——于是
    // 自己的 Bot 开出一张没指人的单时，红点是 1、点进去清单却是空的。
    const mine =
      who.role === 'member'
        ? '(assignee = ? or "claimedBy" = ? or ("assignee" is null and "accountId" = ?))'
        : '(assignee = ? or assignee is null or "claimedBy" = ?)'
    const r = await this.one(
      `select count(*)::int as n from handoffs where "companyId" = ? and state in ('open','claimed') and ${mine}`,
      who.role === 'member' ? [who.companyId, who.id, who.id, who.id] : [who.companyId, who.id, who.id],
    )
    return r ? num(r.n) : 0
  }

  /**
   * 一段时间里的交接单概览。
   *
   * **从这张表投影，不从会话日志正则**：日志里那句话是写给模型看的散文，措辞一改
   * 统计就变。这里回答三个问题——开了几张、多久有人接、最后怎么收的场。
   *
   * `p50ClaimMs` 用中位数不用平均：一张挂了两天没人接的单会把平均值拖到没法看，
   * 而人想知道的是「一般多久有人应」。
   */
  async handoffStats(
    who: { id: string; companyId: string; role: Role },
    since: number,
  ): Promise<{
    opened: number
    waiting: number
    expired: number
    p50ClaimMs: number | null
  }> {
    /**
     * **统计的范围要和清单一样**（见 handoffsFor）。
     *
     * 一律按公司算的话，员工打开待办页看到的是「近 30 天开出 42」，而下面的表格只有
     * 他自己那一行——他要么以为页面坏了，要么开始数别人的活。顺带也把别人 Bot 的
     * 工作量泄漏给了每一个员工。
     */
    const scope = who.role === 'member' ? ' and ("accountId" = ? or assignee = ? or "claimedBy" = ?)' : ''
    const args = who.role === 'member' ? [who.companyId, since, who.id, who.id, who.id] : [who.companyId, since]
    const r = await this.one(
      `select
         count(*)::int as opened,
         count(*) filter (where state in ('open','claimed'))::int as waiting,
         count(*) filter (where state = 'expired')::int as expired,
         percentile_disc(0.5) within group (order by "claimedAt" - "createdAt")
           filter (where "claimedAt" is not null) as p50
       from handoffs where "companyId" = ? and "createdAt" >= ?${scope}`,
      args,
    )
    return {
      opened: r ? num(r.opened) : 0,
      waiting: r ? num(r.waiting) : 0,
      expired: r ? num(r.expired) : 0,
      p50ClaimMs: r && r.p50 != null ? num(r.p50) : null,
    }
  }

  /** 催办扫描：还没人接、又过了这个时刻的那几张。 */
  async handoffsNeedingNudge(step: number, before: number, limit = 50): Promise<Handoff[]> {
    const rows = await this.many(
      `select * from handoffs where state = 'open' and "notifyStep" = ? and "createdAt" <= ? order by "createdAt" limit ?`,
      [step, before, Math.max(1, Math.trunc(limit))],
    )
    return rows.map(handoffOf)
  }

  /**
   * 该收掉的那几张：**open 和 claimed 都算**。
   *
   * 只扫 open 的话，一张被人点过「我来接手」然后再没动静的单子既不会被催、也不会转
   * `expired`——它永远停在 claimed，而 blocking 的那些会让这颗 Bot 的日常任务天天被
   * 跳过（见 routines.ts 的抑制），模型也永远等不到那句「没人接手」。文档 §14 不变量 2
   * 说的「一张开着的单子必然有终态」，缺的就是这一半。
   *
   * `notifyStep < 2` 而不是 `= 1`：claimed 的那些多半在第一档催办之前就被接走了，
   * 计数还停在 0。
   */
  async staleHandoffs(before: number, limit = 50): Promise<Handoff[]> {
    const rows = await this.many(
      `select * from handoffs where state in ('open','claimed') and "notifyStep" < 2 and "createdAt" <= ?
       order by "createdAt" limit ?`,
      [before, Math.max(1, Math.trunc(limit))],
    )
    return rows.map(handoffOf)
  }

  /**
   * 催到第几档了。**带旧值的 CAS**：升级换版那几十秒里新旧两代进程都会扫到同一张单，
   * 没有这一句，同一条催办会推两遍——而催办本身就是打扰人的东西。
   */
  async bumpHandoffNotify(id: string, from: number, to: number): Promise<boolean> {
    const n = await this.run(
      'update handoffs set "notifyStep" = ?, "updatedAt" = ? where id = ? and "notifyStep" = ?',
      [to, Date.now(), id, from],
    )
    return n > 0
  }
}
