/**
 * 目录（模型 / Skill / MCP / Bot）、侧栏分类、主 Bot、主 Bot 派活、Skill 标签。
 */
import { randomUUID } from 'node:crypto'
import { SWEEP_BATCH } from './sql.ts'
import type { BotFolder, BotTask, BotTaskPatch, BotTaskProgress, BotTaskStatus, CatalogItem, CatalogKind, Scope } from './types.ts'
import { botFolderOf, botTaskOf, catalogOf, str } from './rows.ts'
import { SeatsDb } from './seats.ts'

export class CatalogDb extends SeatsDb {
  // ── 目录 ──────────────────────────────────────────────────────────────

  async insertCatalog(input: {
    kind: CatalogKind
    scope: Scope
    companyId: string | null
    /** 只有 `scope: 'user'` 用得上：这条归谁。别的层级传不传都存 null。 */
    accountId?: string | null
    /** 只有私有档 Skill 用得上：这条归哪颗 Bot。见 CatalogItem.botId。 */
    botId?: string | null
    name: string
    definition?: unknown
  }): Promise<CatalogItem> {
    const now = Date.now()
    const row: CatalogItem = {
      id: randomUUID(),
      kind: input.kind,
      scope: input.scope,
      companyId: input.scope === 'global' ? null : input.companyId,
      accountId: input.scope === 'user' ? (input.accountId ?? null) : null,
      botId: input.scope === 'user' ? (input.botId ?? null) : null,
      name: input.name,
      definition: input.definition ?? {},
      deletingAt: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.run(
      'insert into catalog_items (id, kind, scope, "companyId", "accountId", "botId", name, definition, "createdAt", "updatedAt") values (?,?,?,?,?,?,?,?,?,?)',
      [row.id, row.kind, row.scope, row.companyId, row.accountId, row.botId, row.name, JSON.stringify(row.definition), row.createdAt, row.updatedAt],
    )
    return row
  }

  async catalog(id: string): Promise<CatalogItem | undefined> {
    const r = await this.one('select * from catalog_items where id = ?', [id])
    return r ? catalogOf(r) : undefined
  }

  async visibleCatalog(kind: CatalogKind, companyId: string | null): Promise<CatalogItem[]> {
    if (!companyId) {
      const rows = await this.many("select * from catalog_items where kind = ? and scope = 'global' and \"deletingAt\" is null order by name", [kind])
      return rows.map(catalogOf)
    }
    const rows = await this.many(
      "select * from catalog_items where kind = ? and \"deletingAt\" is null and (scope = 'global' or (scope = 'company' and \"companyId\" = ?)) order by scope, name",
      [kind, companyId],
    )
    return rows.map(catalogOf)
  }

  /**
   * 这颗 Bot 看得见的 Skill：全局 ∪ 本公司 ∪ **它自己攒下的那些**。
   *
   * 别的 Bot 的私有档一律不在里面——这条线由这里的 where 保证，而不是靠每个调用点
   * 自己过滤（同 botsFor：在应用层 filter 一次就够漏一次，而漏的表现是「别人的 Bot
   * 学到的东西出现在我这儿」）。
   *
   * `botId` 传空就只回全局 ∪ 公司那两档：席位没钉 botId 的时候不该看见任何私有档，
   * 而不是看见这个账号名下所有 Bot 的。
   */
  async skillsFor(companyId: string | null, accountId: string, botId: string | null): Promise<CatalogItem[]> {
    if (!companyId) {
      const rows = await this.many("select * from catalog_items where kind = 'skill' and scope = 'global' order by name")
      return rows.map(catalogOf)
    }
    if (!botId) return await this.visibleCatalog('skill', companyId)
    const rows = await this.many(
      `select * from catalog_items where kind = 'skill' and (
         scope = 'global'
         or (scope = 'company' and "companyId" = ?)
         or (scope = 'user' and "accountId" = ? and "botId" = ?)
       ) order by scope, name`,
      [companyId, accountId, botId],
    )
    return rows.map(catalogOf)
  }

  /**
   * 把一条私有档转成公司 Skill：换 scope，丢掉主人和 botId。
   *
   * **是搬，不是拷。** 拷一份的话，Bot 手上那条还在，它会继续改它自己那份，而公司里
   * 的人看着的是另一份——同一个名字两条正文，谁也不知道哪条在生效。
   */
  async promoteSkill(id: string): Promise<CatalogItem> {
    const cur = await this.catalog(id)
    if (!cur) throw new Error('目录项不存在')
    const updatedAt = Date.now()
    await this.run(
      `update catalog_items set scope = 'company', "accountId" = null, "botId" = null, "updatedAt" = ?
       where id = ?`,
      [updatedAt, id],
    )
    return { ...cur, scope: 'company', accountId: null, botId: null, updatedAt }
  }

  /**
   * 这家公司里全部的私有档，不分主人。**只给管理员那一屏**（目录页「Bot 自己写的」那一栏）。
   *
   * 正文是模型从员工的对话里写下来的，可能带着客户的名字、电话。普通成员要看的是
   * 自己那几颗 Bot 的，走下面的 accountSeatSkills。
   */
  async companySeatSkills(companyId: string): Promise<CatalogItem[]> {
    const rows = await this.many(
      `select * from catalog_items where kind = 'skill' and scope = 'user' and "companyId" = ?
       order by "updatedAt" desc`,
      [companyId],
    )
    return rows.map(catalogOf)
  }

  /** 某个员工名下全部 Bot 的私有档。主人这一维写进 where，同 botsFor。 */
  async accountSeatSkills(companyId: string, accountId: string): Promise<CatalogItem[]> {
    const rows = await this.many(
      `select * from catalog_items where kind = 'skill' and scope = 'user'
         and "companyId" = ? and "accountId" = ? order by "updatedAt" desc`,
      [companyId, accountId],
    )
    return rows.map(catalogOf)
  }

  async companyCatalog(kind: CatalogKind, companyId: string): Promise<CatalogItem[]> {
    const rows = await this.many(
      "select * from catalog_items where kind = ? and scope = 'company' and \"companyId\" = ? order by name",
      [kind, companyId],
    )
    return rows.map(catalogOf)
  }

  async updateCatalog(id: string, patch: { name?: string; definition?: unknown }): Promise<CatalogItem> {
    const cur = await this.catalog(id)
    if (!cur) throw new Error('目录项不存在')
    const next: CatalogItem = {
      ...cur,
      name: patch.name ?? cur.name,
      definition: patch.definition === undefined ? cur.definition : patch.definition,
      updatedAt: Date.now(),
    }
    await this.run('update catalog_items set name=?, definition=?, "updatedAt"=? where id=?', [
      next.name,
      JSON.stringify(next.definition),
      next.updatedAt,
      id,
    ])
    return next
  }

  /**
   * 这家公司那份 Bot 模版。一家公司恰好一条（0002 上有唯一索引）。
   *
   * 查不到不代表出错：公司是在 0003 之后建的，模版由第一次读它的人懒创建
   * （见 lib/catalog.ts 的 ensureBotTemplate）。
   */
  async botTemplate(companyId: string): Promise<CatalogItem | undefined> {
    const r = await this.one(
      'select * from catalog_items where kind = \'bot-template\' and "companyId" = ? limit 1',
      [companyId],
    )
    return r ? catalogOf(r) : undefined
  }

  /**
   * 某个员工的名册：全局 Bot ∪ 本公司的（都是 0003 停用掉的老条目）∪ **他自己建的**。
   *
   * 别人建的 Bot 一律不在里面——用户 Bot 只有主人看得见，这条线由这里的 where 保证，
   * 而不是靠每个调用点自己过滤。
   */
  async botsFor(companyId: string | null, accountId: string): Promise<CatalogItem[]> {
    if (!companyId) {
      const rows = await this.many("select * from catalog_items where kind = 'bot' and scope = 'global' and \"deletingAt\" is null order by name")
      return rows.map(catalogOf)
    }
    const rows = await this.many(
      `select * from catalog_items where kind = 'bot' and "deletingAt" is null and (
         scope = 'global'
         or (scope = 'company' and "companyId" = ?)
         or (scope = 'user' and "accountId" = ?)
       ) order by scope, name`,
      [companyId, accountId],
    )
    return rows.map(catalogOf)
  }

  /**
   * 这家公司里的全部 Bot，**不分主人**：全局 + 公司 + 每个员工自己建的。
   *
   * 只给「按 id 换个名字」这类展示用（会话索引、审计）。要判「这个人能不能用它」
   * 一律走 botsFor——那条才带主人这一维。
   */
  async companyBots(companyId: string): Promise<CatalogItem[]> {
    const rows = await this.many(
      `select * from catalog_items where kind = 'bot' and "deletingAt" is null and (
         scope = 'global' or "companyId" = ?
       ) order by scope, name`,
      [companyId],
    )
    return rows.map(catalogOf)
  }

  // ── 侧栏名单的个人分类（迁移 0056）。─────────────────────────────────

  async botFolders(accountId: string): Promise<BotFolder[]> {
    const rows = await this.many('select * from bot_folders where "accountId" = ? order by position, "createdAt"', [accountId])
    return rows.map(botFolderOf)
  }

  async botFolder(accountId: string, id: string): Promise<BotFolder | undefined> {
    const row = await this.one('select * from bot_folders where id = ? and "accountId" = ?', [id, accountId])
    return row ? botFolderOf(row) : undefined
  }

  async countBotFolders(accountId: string): Promise<number> {
    const r = await this.one('select count(*)::int as n from bot_folders where "accountId" = ?', [accountId])
    return Number((r as { n?: number } | undefined)?.n ?? 0)
  }

  /** 新分类排在最后：position 取当前最大值加一。 */
  async createBotFolder(accountId: string, name: string, now: number): Promise<BotFolder> {
    const id = randomUUID()
    await this.run(
      `insert into bot_folders (id, "accountId", name, position, "createdAt", "updatedAt")
       values (?, ?, ?, (select coalesce(max(position), 0) + 1 from bot_folders where "accountId" = ?), ?, ?)`,
      [id, accountId, name, accountId, now, now],
    )
    return (await this.botFolder(accountId, id))!
  }

  async renameBotFolder(accountId: string, id: string, name: string, now: number): Promise<BotFolder | undefined> {
    await this.run('update bot_folders set name = ?, "updatedAt" = ? where id = ? and "accountId" = ?', [name, now, id, accountId])
    return this.botFolder(accountId, id)
  }

  /** 删分类：归属行级联掉，里面的 Bot 回到没分类。只删自己名下的。 */
  async deleteBotFolder(accountId: string, id: string): Promise<boolean> {
    return (await this.run('delete from bot_folders where id = ? and "accountId" = ?', [id, accountId])) > 0
  }

  /** 这个人把哪些 Bot 放进了哪个分类：botId → folderId。没放的不在表里。 */
  async botFolderItems(accountId: string): Promise<Map<string, string>> {
    const rows = await this.many('select "botId", "folderId" from bot_folder_items where "accountId" = ?', [accountId])
    return new Map(rows.map((r) => [String(r.botId), String(r.folderId)]))
  }

  /** 把一颗 Bot 放进某个分类；folderId 为 null 就是拿出来（回到没分类）。 */
  async setBotFolder(accountId: string, botId: string, folderId: string | null): Promise<void> {
    if (!folderId) {
      await this.run('delete from bot_folder_items where "accountId" = ? and "botId" = ?', [accountId, botId])
      return
    }
    await this.run(
      `insert into bot_folder_items ("accountId", "botId", "folderId") values (?, ?, ?)
       on conflict ("accountId", "botId") do update set "folderId" = excluded."folderId"`,
      [accountId, botId, folderId],
    )
  }

  // ── 主 Bot（迁移 0057）。一人一颗，个人视图。──────────────────────────

  async mainBotOf(accountId: string): Promise<string | null> {
    const r = await this.one('select "botId" from main_bots where "accountId" = ?', [accountId])
    return r ? String(r.botId) : null
  }

  /** botId 为 null 就是取消。 */
  async setMainBot(accountId: string, botId: string | null, now: number): Promise<void> {
    if (!botId) {
      await this.run('delete from main_bots where "accountId" = ?', [accountId])
      return
    }
    await this.run(
      `insert into main_bots ("accountId", "botId", "updatedAt") values (?, ?, ?)
       on conflict ("accountId") do update set "botId" = excluded."botId", "updatedAt" = excluded."updatedAt"`,
      [accountId, botId, now],
    )
  }

  // ── 主 Bot 派活（迁移 0058，docs/bot-tasks.md）。────────────────────────

  async insertBotTask(input: {
    accountId: string
    companyId: string
    fromBotId: string
    toBotId: string
    fromSessionId: string | null
    callId: string | null
    instruction: string
    context?: string | null
    status: BotTaskStatus
    owner: string | null
    result?: string | null
    error?: string | null
    runKind?: string | null
    waiterUntil?: number | null
  }): Promise<BotTask> {
    const id = randomUUID()
    const now = Date.now()
    await this.run(
      `insert into bot_tasks (id, "accountId", "companyId", "fromBotId", "toBotId", "fromSessionId", "callId", instruction, context, status, owner, "leaseUntil", attempts, result, error, "runKind", "waiterUntil", "createdAt", "readyAt")
       values (?,?,?,?,?,?,?,?,?,?,?,null,0,?,?,?,?,?,?)`,
      [id, input.accountId, input.companyId, input.fromBotId, input.toBotId, input.fromSessionId, input.callId, input.instruction, input.context ?? null, input.status, input.owner, input.result ?? null, input.error ?? null, input.runKind ?? null, input.waiterUntil ?? null, now, now],
    )
    return (await this.botTask(id))!
  }

  async botTask(id: string): Promise<BotTask | undefined> {
    const r = await this.one('select * from bot_tasks where id = ?', [id])
    return r ? botTaskOf(r) : undefined
  }

  /** 这条会话派出去的那些，新的在前。界面画状态用。 */
  async botTasksOfSession(accountId: string, sessionId: string, limit = 20): Promise<BotTask[]> {
    const rows = await this.many(
      'select * from bot_tasks where "accountId" = ? and "fromSessionId" = ? order by "createdAt" desc limit ?',
      [accountId, sessionId, Math.max(1, Math.trunc(limit))],
    )
    return rows.map(botTaskOf)
  }

  /**
   * 同一次工具调用（callId）里、同一句指令派给同一颗、还没收场的那一条。席位那边建任务的请求超时
   * 重发时据此认回第一次建好的，不再建出第二条（见 POST /runtime/tasks）。
   */
  async openBotTaskOfCall(accountId: string, fromBotId: string, toBotId: string, callId: string, instruction: string): Promise<BotTask | undefined> {
    const r = await this.one(
      `select * from bot_tasks where "accountId" = ? and "fromBotId" = ? and "toBotId" = ? and "callId" = ? and instruction = ?
          and status not in ('done', 'failed', 'cancelled') order by "createdAt" desc limit 1`,
      [accountId, fromBotId, toBotId, callId, instruction],
    )
    return r ? botTaskOf(r) : undefined
  }

  /** 还没收场、从 from 派给 to 的。防 A 派 B、B 派 A 转圈，也防同一件事派两遍。 */
  async openBotTaskBetween(accountId: string, fromBotId: string, toBotId: string): Promise<BotTask | undefined> {
    const r = await this.one(
      `select * from bot_tasks where "accountId" = ? and "fromBotId" = ? and "toBotId" = ? and status not in ('done', 'failed', 'cancelled') order by "createdAt" desc limit 1`,
      [accountId, fromBotId, toBotId],
    )
    return r ? botTaskOf(r) : undefined
  }

  /**
   * 领活：owner 归我、还没人领的那些，**原子地**填上租约并推进状态（queued → running、
   * reporting → delivering）。同一条两个工人同时来领，只有一个拿得到：子查询 skip locked 跳过
   * 别人正领着的行，外层再判一次「还没人领」——光靠 `id in (…)`，后到的那一笔等前一笔提交之后
   * 只重查 id 对不对得上，照样改、照样交回去。
   *
   * `botId`：只领这一步要敲这颗 Bot 的（run 看目标，deliver 看主 Bot）。本地 Bot 共用一个
   * owner（desktop:<账号>），桌面端却是一颗 Bot 一个进程，不分开领就会领到别人的活。
   */
  async claimBotTasks(owner: string, leaseUntil: number, limit = 20, botId?: string): Promise<BotTask[]> {
    const due = `owner = ? and "leaseUntil" is null and status in ('queued', 'reporting')
            and ("cancelledAt" is null or status = 'reporting')`
    const mine = botId ? ` and (case status when 'queued' then "toBotId" else "fromBotId" end) = ?` : ''
    const rows = await this.many(
      `update bot_tasks set "leaseUntil" = ?, attempts = attempts + 1,
         status = case status when 'queued' then 'running' when 'reporting' then 'delivering' else status end,
         "startedAt" = case when status = 'queued' then coalesce("startedAt", ?) else "startedAt" end
       where ${due}${mine} and id in (
         select id from bot_tasks where ${due}${mine}
          order by "createdAt" limit ? for update skip locked
       )
       returning *`,
      [leaseUntil, Date.now(), owner, ...(botId ? [botId] : []), owner, ...(botId ? [botId] : []), Math.max(1, Math.trunc(limit))],
    )
    return rows.map(botTaskOf)
  }

  /** 这位领走、还在干的那一条；不是就没有，不区分「别人的」和「收场了」。 */
  async botTaskOfOwner(id: string, owner: string): Promise<BotTask | undefined> {
    const r = await this.one(
      `select * from bot_tasks where id = ? and owner = ? and "leaseUntil" is not null and status in ('running', 'delivering')`,
      [id, owner],
    )
    return r ? botTaskOf(r) : undefined
  }

  /** 续租。带了 progress 就顺手记下（不带的老领活方照旧只续租，进度保持原样）。 */
  async renewBotTask(id: string, owner: string, leaseUntil: number, progress?: BotTaskProgress): Promise<boolean> {
    const set = progress ? `"leaseUntil" = ?, progress = ?` : `"leaseUntil" = ?`
    const args = progress ? [leaseUntil, JSON.stringify(progress)] : [leaseUntil]
    return (
      (await this.run(
        `update bot_tasks set ${set} where id = ? and owner = ? and "leaseUntil" is not null and status in ('running', 'delivering')`,
        [...args, id, owner],
      )) > 0
    )
  }

  /** 改几格。只改给了的那几格；null 也是一个值（清掉租约就是把它设成 null）。 */
  async updateBotTask(id: string, patch: BotTaskPatch): Promise<boolean> {
    // 不带条件的那一种：where 只剩 id = ?，和下面那条拼出来的 SQL 一字不差。
    return this.updateBotTaskIf(id, {}, patch)
  }

  /**
   * 带条件的 updateBotTask：只有这一行**还是**调用方读到的那个样子才改，改没改成回 true / false。
   *
   * 派活的状态有好几方在写（工人回报、主 Bot 那边按停止、清扫），各自都是先读一行、算好、再写。
   * 不带条件的话，后写的拿着旧快照把先写的盖掉：清扫把工人刚写的 answered 盖回 queued（结论再送
   * 一遍），交回结论把刚按的停止盖成 answered（作废的结论照样送回主 Bot）。
   */
  async updateBotTaskIf(
    id: string,
    cond: { status?: BotTaskStatus; leaseUntil?: number | null; notCancelled?: boolean },
    patch: BotTaskPatch,
  ): Promise<boolean> {
    const sets: string[] = []
    const args: unknown[] = []
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue
      sets.push(`"${k}" = ?`)
      args.push(v)
    }
    if (!sets.length) return false
    const where = ['id = ?']
    args.push(id)
    if (cond.status !== undefined) (where.push('status = ?'), args.push(cond.status))
    if (cond.leaseUntil === null) where.push('"leaseUntil" is null')
    else if (cond.leaseUntil !== undefined) (where.push('"leaseUntil" = ?'), args.push(cond.leaseUntil))
    if (cond.notCancelled) where.push('"cancelledAt" is null')
    return (await this.run(`update bot_tasks set ${sets.join(', ')} where ${where.join(' and ')}`, args)) > 0
  }

  /**
   * 等的一方取结论（docs/bot-tasks.md §1.1）：**原子地**把 answered 记成 done 并交出这一行。
   * 两次轮询撞在一起只有一次拿得到——另一次看到的是 done，照样有结论，只是不再改状态。
   */
  async takeAnsweredBotTask(id: string, now: number): Promise<BotTask | undefined> {
    const r = await this.one(
      `update bot_tasks set status = 'done', "deliveredAt" = ?, "waiterUntil" = null where id = ? and status = 'answered' returning *`,
      [now, id],
    )
    return r ? botTaskOf(r) : undefined
  }

  /** 已经答了、等的一方却没来取（租过期了）。维护节拍把它们转成兜底送回。 */
  async orphanedAnsweredBotTasks(nowMs: number): Promise<BotTask[]> {
    const rows = await this.many(
      `select * from bot_tasks where status = 'answered' and ("waiterUntil" is null or "waiterUntil" < ?) order by "createdAt" limit ?`,
      [nowMs, SWEEP_BATCH],
    )
    return rows.map(botTaskOf)
  }

  /**
   * 本地 Bot 来领了一次派活（迁移 0063）。每几秒一次，**最多二十秒写一回**：在不在线只要分钟级的准头，
   * 不必每拍都改一行。`botId` 是 `*` = 老桌面端，领活不带 botId。
   */
  async noteLocalPoll(accountId: string, botId: string, now: number): Promise<void> {
    await this.run(
      `insert into local_bot_polls ("accountId", "botId", "seenAt") values (?, ?, ?)
       on conflict ("accountId", "botId") do update set "seenAt" = excluded."seenAt"
       where local_bot_polls."seenAt" < excluded."seenAt" - 20000`,
      [accountId, botId, now],
    )
  }

  /** 这颗本地 Bot（或者这个账号上的老桌面端）在 since 之后来领过活没有。 */
  async localPolledSince(accountId: string, botId: string, since: number): Promise<boolean> {
    const r = await this.one(
      `select 1 as ok from local_bot_polls where "accountId" = ? and "botId" in (?, '*') and "seenAt" >= ? limit 1`,
      [accountId, botId, since],
    )
    return Boolean(r)
  }

  /** 领走了却到期没续的。 */
  async expiredBotTasks(nowMs: number): Promise<BotTask[]> {
    const rows = await this.many(
      `select * from bot_tasks where status in ('running', 'delivering') and "leaseUntil" is not null and "leaseUntil" < ? order by "leaseUntil" limit ?`,
      [nowMs, SWEEP_BATCH],
    )
    return rows.map(botTaskOf)
  }

  /**
   * 排着队一直没人来领的：从这一步最近一次放出来（readyAt）算——租约到期放回去的那一条要重新计时，
   * 不能拿最初建的时刻，否则一放回去就在同一次清扫里被判成没人领。旧行没有 readyAt：queued 看
   * createdAt，reporting 看 endedAt（目标那一步收场的时刻）。
   */
  async unclaimedBotTasksBefore(beforeMs: number): Promise<BotTask[]> {
    const rows = await this.many(
      `select * from bot_tasks where "leaseUntil" is null and status in ('queued', 'reporting') and coalesce(
         "readyAt", case when status = 'reporting' then coalesce("endedAt", "createdAt") else "createdAt" end
       ) < ? order by "createdAt" limit ?`,
      [beforeMs, SWEEP_BATCH],
    )
    return rows.map(botTaskOf)
  }

  /** 某个员工自己建了几个。配额挡在建之前，见 routes/runtime.ts。 */
  async countUserBots(accountId: string): Promise<number> {
    const r = await this.one(
      'select count(*)::int as n from catalog_items where kind = \'bot\' and scope = \'user\' and "accountId" = ?',
      [accountId],
    )
    return Number((r as { n?: number } | undefined)?.n ?? 0)
  }

  async deleteCatalog(id: string): Promise<void> {
    await this.run('delete from catalog_items where id = ?', [id])
  }

  // ── Skill 标签。稿子上那八个是初值，建了新的就进这张表。──────────────

  async skillTags(companyId: string): Promise<string[]> {
    const rows = await this.many('select tag from skill_tags where "companyId" = ? order by seq', [companyId])
    return rows.map((r) => str(r.tag))
  }

  async insertSkillTag(companyId: string, tag: string): Promise<void> {
    await this.run('insert into skill_tags ("companyId", tag) values (?, ?) on conflict do nothing', [companyId, tag])
  }

  async deleteSkillTag(companyId: string, tag: string): Promise<boolean> {
    return (await this.run('delete from skill_tags where "companyId" = ? and tag = ?', [companyId, tag])) > 0
  }
}
