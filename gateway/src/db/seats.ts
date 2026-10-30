/**
 * 席位：实例、席位运行态与部署排队、Bot 发布包。
 */
import { type BotRelease, type Instance, releaseArch, type ReleaseKind, type SeatDeployRequest, type SeatRuntime } from './types.ts'
import { botReleaseOf, groupOf, instanceOf, seatDeployRequestOf, seatRuntimeOf } from './rows.ts'
import { DbCore } from './core.ts'

export class SeatsDb extends DbCore {
  // ── 实例。(账号, botId) 一对一台 Bot 运行时。只存 host，不存聊天正文。──

  async instance(accountId: string, botId: string): Promise<Instance | undefined> {
    const r = await this.one('select * from instances where "accountId" = ? and "botId" = ?', [accountId, botId])
    return r ? instanceOf(r) : undefined
  }

  async seatRuntime(accountId: string, botId: string): Promise<SeatRuntime | undefined> {
    const r = await this.one('select * from seat_runtimes where "accountId" = ? and "botId" = ?', [accountId, botId])
    return r ? seatRuntimeOf(r) : undefined
  }

  /** 按席位 id 反查。桌面反代只认得 URL 里那个 seatId，没有 accountId/botId。 */
  async seatRuntimeBySeatId(seatId: string): Promise<SeatRuntime | undefined> {
    const r = await this.one('select * from seat_runtimes where "seatId" = ?', [seatId])
    return r ? seatRuntimeOf(r) : undefined
  }

  async seatRuntimesOf(companyId: string): Promise<SeatRuntime[]> {
    const rows = await this.many('select * from seat_runtimes where "companyId" = ? order by slot', [companyId])
    return rows.map(seatRuntimeOf)
  }

  /** 某台机器上的席位。算容量和分配槽位都靠它。 */
  async seatRuntimesOfMachine(machineId: string): Promise<SeatRuntime[]> {
    const rows = await this.many('select * from seat_runtimes where "machineId" = ? order by slot', [machineId])
    return rows.map(seatRuntimeOf)
  }

  /**
   * 部署了这一颗 Bot 的全部席位，**不分公司**。
   *
   * 删目录项之前要按它把机器上的东西拆干净。全局 Bot 可能被好几家公司各自部署过，
   * 按公司查会漏掉别家的那些——漏下的席位仍占着 slot 和端口，而库里再没有任何东西
   * 指向它们（理由见 deploy.ts 的 releaseSeats）。
   */
  async seatRuntimesOfBot(botId: string): Promise<SeatRuntime[]> {
    const rows = await this.many('select * from seat_runtimes where "botId" = ?', [botId])
    return rows.map(seatRuntimeOf)
  }

  async seatRuntimesOfAccount(accountId: string): Promise<SeatRuntime[]> {
    const rows = await this.many('select * from seat_runtimes where "accountId" = ? order by slot', [accountId])
    return rows.map(seatRuntimeOf)
  }

  /**
   * 席位报到：它现在跑的是模版第几版。
   *
   * 单独一条窄更新，不走 upsertSeatRuntime：那条是部署路径的整行覆盖，用它写这两列，
   * 等于每次重铺都拿部署那一刻的旧数字把席位刚报上来的盖掉。反过来也一样——这条
   * **只碰这两列**，正在并发跑的部署改的 status / botVersion 一个字都不动。
   *
   * 行不存在就什么都不做（0 行受影响）：席位拆了、库里的行先没了，而那个进程还在最后
   * 探一轮，这不是错误，不该让探针那条路 500。
   */
  async noteSeatTemplate(accountId: string, botId: string, version: number): Promise<void> {
    await this.run(
      'update seat_runtimes set "tplVersion" = ?, "tplSyncedAt" = ? where "accountId" = ? and "botId" = ?',
      [version, Date.now(), accountId, botId],
    )
  }

  async upsertSeatRuntime(row: SeatRuntime): Promise<SeatRuntime> {
    await this.run(
      `insert into seat_runtimes (
         "accountId", "botId", "companyId", "linuxUser", "seatId", "machineId", slot, display, "vncPort", "novncPort",
         "botPort", "vncPassword", status, "lastError", "deployedAt", "updatedAt", "botVersion",
         "deployPhase", "deployStartedAt", "deployBeatAt"
       ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       on conflict ("accountId", "botId") do update set
         "companyId"=excluded."companyId",
         "linuxUser"=excluded."linuxUser",
         "seatId"=excluded."seatId",
         "machineId"=excluded."machineId",
         slot=excluded.slot,
         display=excluded.display,
         "vncPort"=excluded."vncPort",
         "novncPort"=excluded."novncPort",
         "botPort"=excluded."botPort",
         "vncPassword"=excluded."vncPassword",
         status=excluded.status,
         "lastError"=excluded."lastError",
         "deployedAt"=excluded."deployedAt",
         "updatedAt"=excluded."updatedAt",
         "botVersion"=excluded."botVersion",
         "deployPhase"=excluded."deployPhase",
         "deployStartedAt"=excluded."deployStartedAt",
         -- 在装心跳**只往前走**：这一行在装的过程中会被整行写好几次（登记、改成 installing），
         -- 手上那份是登记那一刻的旧值，照抄会把心跳往回拨。落地（不是 deploying）一律清空。
         "deployBeatAt"=case when excluded.status = 'deploying'
           then greatest(excluded."deployBeatAt", seat_runtimes."deployBeatAt") else null end`,
      [
        row.accountId,
        row.botId,
        row.companyId,
        row.linuxUser,
        row.seatId,
        row.machineId,
        row.slot,
        row.display,
        row.vncPort,
        row.novncPort,
        row.botPort,
        row.vncPassword,
        row.status,
        row.lastError,
        row.deployedAt,
        row.updatedAt,
        row.botVersion,
        row.deployPhase,
        row.deployStartedAt,
        row.status === 'deploying' ? row.deployBeatAt ?? null : null,
      ],
    )
    return (await this.seatRuntime(row.accountId, row.botId))!
  }

  /**
   * 同一个席位的部署排队进这把锁：登记那一步「看一眼有没有人在装、没有就写下我在装」必须
   * 是原子的，不然两个实例同时来，各自看到没人、各自登记（理由同 lockExclusive 那段）。
   * **必须在 db.tx 里调**。按席位散列，不同席位互不等。
   */
  async lockSeatDeploy(accountId: string, botId: string): Promise<void> {
    await this.xactLock('lockSeatDeploy', `seat_deploy:${accountId}:${botId}`)
  }

  /**
   * 在装心跳：推着这次部署的进程每十几秒报一次到（见 deploy.ts 的 DEPLOY_BEAT_MS）。
   *
   * 认 `deployStartedAt`：只续**自己那一次**。自己这次已经被别人接手（心跳断过、有人重新
   * 登记）的话，那一行的开始时刻已经换了，这一句什么都不改——不能替别人的那次报到。
   */
  async beatSeatDeploy(seatId: string, startedAt: number, now = Date.now()): Promise<boolean> {
    const n = await this.run(
      `update seat_runtimes set "deployBeatAt" = ?
        where "seatId" = ? and status = 'deploying' and "deployStartedAt" = ?`,
      [now, seatId, startedAt],
    )
    return n > 0
  }

  /**
   * 给一个席位排一次部署（批量更新那两条路）。席位行别的格一个都不动。
   *
   * 已经排着的就盖掉：后排的那一次说的是「现在要的样子」，前一次没轮到就没必要做了。
   *
   * `ifIdle` 反过来：**队里已经有活就不排**，判断和写入是同一条 update。给心跳里的自动跟版
   * 用——它是背景里的例行公事，不能盖掉人手工排下的那一次。
   */
  async queueSeatDeploy(
    accountId: string,
    botId: string,
    request: SeatDeployRequest,
    opts: { ifIdle?: boolean } = {},
  ): Promise<boolean> {
    const n = await this.run(
      `update seat_runtimes set "deployQueued" = ?::jsonb where "accountId" = ? and "botId" = ?${opts.ifIdle ? ' and "deployQueued" is null' : ''}`,
      [JSON.stringify(request), accountId, botId],
    )
    return n > 0
  }

  /**
   * 领走排着的那一次：清掉并把参数交出来。**两个执行者只有一个领得到**（清和取是同一条
   * 带条件的 update），另一个拿到 undefined，就当没这回事。
   */
  async takeSeatDeploy(accountId: string, botId: string): Promise<SeatDeployRequest | undefined> {
    const r = await this.one(
      `update seat_runtimes s set "deployQueued" = null
         from (select "accountId", "botId", "deployQueued" as q from seat_runtimes
                where "accountId" = ? and "botId" = ? and "deployQueued" is not null for update) old
        where s."accountId" = old."accountId" and s."botId" = old."botId"
        returning old.q`,
      [accountId, botId],
    )
    if (!r) return undefined
    return seatDeployRequestOf(r.q) ?? {}
  }

  /** 排着队的席位，先排的在前。队列那一段按机器分组、每台一个一个来。 */
  async queuedSeatDeploys(): Promise<SeatRuntime[]> {
    const rows = await this.many(
      'select * from seat_runtimes where "deployQueued" is not null order by "machineId", "updatedAt", "seatId"',
      [],
    )
    return rows.map(seatRuntimeOf)
  }

  /**
   * 拆掉**一个** Bot 的席位，连同它的实例地址和会话索引。
   *
   * 员工删自己建的 Bot 走这条。**没有「按账号删全部席位」那条**——原来有过，全仓没有
   * 调用点，而它会把这个人名下别的 Bot 一起抹掉：slot 立刻能被下一个人分走，而机器上
   * 那几套 systemd 单元还占着端口（理由见 deploy.ts 的 releaseSeats）。
   *
   * 会话索引一起删：全文本来就在席位目录里，管家拆席位时跟着没了，留着索引只会让
   * 管理员点进一条永远打不开的会话。
   */
  async deleteSeatRuntimeOf(accountId: string, botId: string): Promise<void> {
    await this.tx(async () => {
      await this.run('delete from seat_runtimes where "accountId" = ? and "botId" = ?', [accountId, botId])
      await this.run('delete from instances where "accountId" = ? and "botId" = ?', [accountId, botId])
      await this.run('delete from session_index where "accountId" = ? and "botId" = ?', [accountId, botId])
    })
  }

  /**
   * 拆不掉的席位：**行留着，但把它和 Bot 之间的东西全清掉**。
   *
   * 机器不在线、或者管家把单元停了却没收拾干净时走这条。行不能删——slot 一空出来
   * 就会被下一个人分走，而那台机器上的单元还占着 3200+N / 6081+N（理由见 deploy.ts
   * 的 releaseSeats）。行留着，机器详情页上就是一条「出错、没有 Bot 名」的席位，
   * 平台侧点一下「清理」重试拆除即可。
   *
   * 实例地址和会话索引照删：Bot 已经删了，它们指向的东西再也打不开。
   */
  async orphanSeatRuntime(accountId: string, botId: string, reason: string): Promise<void> {
    await this.tx(async () => {
      await this.run(
        'update seat_runtimes set status = ?, "lastError" = ?, "updatedAt" = ? where "accountId" = ? and "botId" = ?',
        ['error', reason.slice(0, 500), Date.now(), accountId, botId],
      )
      await this.run('delete from instances where "accountId" = ? and "botId" = ?', [accountId, botId])
      await this.run('delete from session_index where "accountId" = ? and "botId" = ?', [accountId, botId])
    })
  }

  /**
   * 一颗 Bot 名下的全部东西，**账本除外**。
   *
   * 「删掉」得是真的删掉：会话索引、实例地址、分组里对它的引用、目录项自己，一条
   * 都不留。留一半的后果上一次已经见过——目录项还在，界面上那颗 Bot 照常列着，
   * 点进去却聊不了，谁也说不清它是什么。
   *
   * **席位不在这里拆**：那要先和机器说话，删不删得掉库里这行取决于机器答不答应，
   * 由调用点决定（见 deploy.ts 的 purgeBot）。
   *
   * **账本一个字都不动**：usage_charges / llm_calls / connector_calls / web_calls 是
   * 要留档的钱，botId 变成悬空引用没关系，统计里按 id 显示。audit_events 同理——它
   * 记的是「谁在什么时候删了这颗 Bot」，跟着 Bot 一起消失就没有审计可言了。
   */
  async deleteBot(botId: string): Promise<void> {
    await this.tx(async () => {
      // 物理删除只有删除状态机能走。这样未来新增调用点时，漏掉终审不是“靠 code review
      // 发现”的约定，而是数据库入口当场拒绝的不变量。
      const authorized = await this.one(
        `select d.id from bot_deletion_requests d where d."botId"=? and d.status='purging'
         and exists (
           select 1 from conversation_audit_batches b where b."deletionRequestId"=d.id and b.kind='pre_delete'
         )
         and not exists (
           select 1 from conversation_audit_batches b where b."deletionRequestId"=d.id
           and b.status not in ('succeeded','empty')
         ) order by d."requestedAt" desc limit 1`,
        [botId],
      )
      if (!authorized) throw new Error('Bot 删除前审计尚未完成')
      await this.run('delete from session_index where "botId" = ?', [botId])
      await this.run('delete from instances where "botId" = ?', [botId])
      // 知识库共享名单里它那一行跟着走：留着一个不存在的 id 不会出错（查不到就是查不到），
      // 但界面上会画出一颗「未知 Bot」，没人删得掉它（docs/knowledge-base.md §9）。
      await this.run('delete from knowledge_shares where "botId" = ?', [botId])
      // 分组按 jsonb 反查，**不按公司**：全局 Bot 可能被好几家公司各自编进分组，
      // 只扫它自己那家会把别家的引用留成一个指向不存在 Bot 的 id。
      const rows = await this.many('select * from groups where agents @> ?::jsonb', [JSON.stringify([botId])])
      for (const g of rows.map(groupOf)) {
        await this.db.updateGroup(g.id, { agents: g.agents.filter((a) => a !== botId) })
      }
      /**
       * **它自己攒下的那些 Skill 跟着走。**
       *
       * 私有档只对这一颗 Bot 有意义（`skillsFor` 的 where 里带着 botId）。Bot 没了还
       * 留着，它们就成了谁也看不见、谁也删不掉的行——界面上那一栏按 botId 认主人，
       * 认不出来就不显示。列上没有外键正是为了这一刻：该做的是一起删掉，不是拒绝删 Bot。
       */
      await this.run('delete from catalog_items where kind = \'skill\' and scope = \'user\' and "botId" = ?', [botId])
      await this.run('delete from catalog_items where id = ? and kind = \'bot\'', [botId])
    })
  }

  // ── Bot 发布包。只存元数据，tarball 在 $SATUWORK_GATEWAY_HOME/releases。──

  async insertBotRelease(row: BotRelease): Promise<BotRelease> {
    await this.run(
      'insert into bot_releases (kind, version, sha256, size, "createdAt", note, url, "minDesktopVersion") values (?,?,?,?,?,?,?,?)',
      [row.kind, row.version, row.sha256, row.size, row.createdAt, row.note, row.url, row.minDesktopVersion],
    )
    return row
  }

  async botRelease(version: string, kind: ReleaseKind = 'bot'): Promise<BotRelease | undefined> {
    const r = await this.one('select * from bot_releases where kind = ? and version = ?', [kind, version])
    return r ? botReleaseOf(r) : undefined
  }

  async botReleases(kind: ReleaseKind = 'bot'): Promise<BotRelease[]> {
    const rows = await this.many('select * from bot_releases where kind = ? order by "createdAt" desc', [kind])
    return rows.map(botReleaseOf)
  }

  /**
   * 最新的发布包，**按架构挑**。
   *
   * `arch` 给了就先找同架构的最新一版；没有同架构的，退回「认不出架构」的版本
   * （老版本号没有后缀，比如 `0.0.1`）；**绝不返回另一个已知架构的包**——那正是
   * 这个参数要挡的事。不给 `arch` 就是老行为：谁新要谁。
   */
  async latestBotRelease(kind: ReleaseKind = 'bot', arch?: string | null): Promise<BotRelease | undefined> {
    if (!arch) {
      const r = await this.one('select * from bot_releases where kind = ? order by "createdAt" desc limit 1', [kind])
      return r ? botReleaseOf(r) : undefined
    }
    const rows = await this.botReleases(kind) // 已按 createdAt desc 排好
    return rows.find((r) => releaseArch(r.version) === arch) ?? rows.find((r) => !releaseArch(r.version))
  }

  async upsertInstance(input: {
    accountId: string
    botId: string
    companyId?: string | null
    host: string
  }): Promise<Instance> {
    const now = Date.now()
    const companyId = input.companyId === undefined ? null : input.companyId
    await this.run(
      `insert into instances ("accountId", "botId", "companyId", host, "lastReadyAt") values (?,?,?,?,?)
       on conflict ("accountId", "botId") do update set
         "companyId"=excluded."companyId",
         host=excluded.host,
         "lastReadyAt"=excluded."lastReadyAt"`,
      [input.accountId, input.botId, companyId, input.host, now],
    )
    return { accountId: input.accountId, botId: input.botId, companyId, host: input.host, lastReadyAt: now }
  }
}
