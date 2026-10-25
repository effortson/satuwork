/**
 * 外部渠道：绑定、身份配对、轮询、入站事件队列。
 */
import { randomUUID } from 'node:crypto'
import type { ChannelBinding, ChannelBindingStatus, ChannelEvent, ChannelEventStatus, ChannelIdentity, ChannelKind, DueChannelScope } from './types.ts'
import { channelBindingOf, channelEventOf, channelIdentityOf } from './rows.ts'
import { DbCore } from './core.ts'

export class ChannelsDb extends DbCore {
  // ── 外部渠道。凭据只存密文；Webhook 事件按远端 id 去重。──────────

  async channelBindings(accountId: string): Promise<ChannelBinding[]> {
    return (await this.many('select * from channel_bindings where "accountId" = ? order by "createdAt"', [accountId])).map(channelBindingOf)
  }

  async channelBinding(id: string): Promise<ChannelBinding | undefined> {
    const r = await this.one('select * from channel_bindings where id = ?', [id])
    return r ? channelBindingOf(r) : undefined
  }

  async channelBindingForAccount(accountId: string, kind: ChannelKind): Promise<ChannelBinding | undefined> {
    const r = await this.one('select * from channel_bindings where "accountId" = ? and kind = ?', [accountId, kind])
    return r ? channelBindingOf(r) : undefined
  }

  async channelBindingByExternal(kind: ChannelKind, externalBotId: string): Promise<ChannelBinding | undefined> {
    const r = await this.one('select * from channel_bindings where kind = ? and "externalBotId" = ?', [kind, externalBotId])
    return r ? channelBindingOf(r) : undefined
  }

  async channelBindingByPublicId(publicId: string): Promise<ChannelBinding | undefined> {
    const r = await this.one('select * from channel_bindings where "publicId" = ?', [publicId])
    return r ? channelBindingOf(r) : undefined
  }

  async insertChannelBinding(input: Omit<ChannelBinding, 'createdAt' | 'updatedAt' | 'lastReceivedAt' | 'lastError' | 'pollOffset' | 'pollLeaseUntil' | 'lastPolledAt' | 'pollLastError'>): Promise<ChannelBinding> {
    const now = Date.now()
    await this.run(
      `insert into channel_bindings
       (id,"companyId","accountId","botId",kind,status,"externalBotId","externalUsername","credentialCiphertext","webhookSecretHash","publicId","pairingCodeHash","pollOffset","pollLeaseUntil","lastPolledAt","pollLastError",config,"lastReceivedAt","lastError","createdAt","updatedAt")
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [input.id, input.companyId, input.accountId, input.botId, input.kind, input.status, input.externalBotId,
        input.externalUsername, input.credentialCiphertext, input.webhookSecretHash, input.publicId, input.pairingCodeHash,
        0, null, null, null, JSON.stringify(input.config || {}), null, null, now, now],
    )
    return (await this.channelBinding(input.id))!
  }

  async updateChannelBinding(id: string, patch: {
    status?: ChannelBindingStatus
    credentialCiphertext?: string
    webhookSecretHash?: string
    externalBotId?: string
    externalUsername?: string
    lastReceivedAt?: number | null
    lastError?: string | null
    config?: ChannelBinding['config']
    pairingCodeHash?: string
    pollOffset?: number
    pollLeaseUntil?: number | null
    lastPolledAt?: number | null
    pollLastError?: string | null
  }): Promise<ChannelBinding> {
    /**
     * **只写传进来的字段**，不整行读改写。
     *
     * 以前是「读一行、合并、把全部列写回去」：轮询器在这期间用 claimChannelPoll /
     * advanceChannelPollOffset / finishChannelPoll 推进的 pollOffset / pollLeaseUntil /
     * lastPolledAt 会被读到的旧值盖回去——游标倒退等于把已经处理过的 update 再收一遍，
     * 租约倒退等于两个进程同时轮询同一个 Bot。调用点传的本来就都是「改这几项」，
     * 没有谁依赖「顺手把别的列也写一遍」。
     */
    const fields: string[] = ['"updatedAt"=?']
    const values: unknown[] = [Date.now()]
    const set = (column: string, value: unknown) => {
      fields.push(`${column}=?`)
      values.push(value)
    }
    if (patch.status !== undefined) set('status', patch.status)
    if (patch.credentialCiphertext !== undefined) set('"credentialCiphertext"', patch.credentialCiphertext)
    if (patch.webhookSecretHash !== undefined) set('"webhookSecretHash"', patch.webhookSecretHash)
    if (patch.externalBotId !== undefined) set('"externalBotId"', patch.externalBotId)
    if (patch.externalUsername !== undefined) set('"externalUsername"', patch.externalUsername)
    if (patch.pairingCodeHash !== undefined) set('"pairingCodeHash"', patch.pairingCodeHash)
    if (patch.pollOffset !== undefined) set('"pollOffset"', patch.pollOffset)
    if (patch.pollLeaseUntil !== undefined) set('"pollLeaseUntil"', patch.pollLeaseUntil)
    if (patch.lastPolledAt !== undefined) set('"lastPolledAt"', patch.lastPolledAt)
    if (patch.pollLastError !== undefined) set('"pollLastError"', patch.pollLastError)
    if (patch.lastReceivedAt !== undefined) set('"lastReceivedAt"', patch.lastReceivedAt)
    if (patch.lastError !== undefined) set('"lastError"', patch.lastError)
    if (patch.config !== undefined) set('config', JSON.stringify(patch.config || {}))
    values.push(id)
    const n = await this.run(`update channel_bindings set ${fields.join(', ')} where id=?`, values)
    if (n !== 1) throw new Error('渠道不存在')
    return (await this.channelBinding(id))!
  }

  async deleteChannelBinding(id: string): Promise<void> {
    await this.run('delete from channel_bindings where id = ?', [id])
  }

  async lockChannelBinding(id: string): Promise<void> {
    if (!this.txClient.getStore()) throw new Error('lockChannelBinding 必须在事务里调用')
    await this.one('select id from channel_bindings where id = ? for update', [id])
  }

  /**
   * 收信方式对齐（setWebhook 换 secret + 存散列）按绑定串行，见 channels/inbound.ts。
   *
   * 不用上面那把行锁：锁里要等一次 Telegram（最长 20 秒），行锁会把同一绑定上的推送
   * 入库、配对一起堵住。这把是咨询锁，只和另一次对齐互斥。**必须在 db.tx 里调**。
   */
  async lockChannelInbound(id: string): Promise<void> {
    await this.xactLock('lockChannelInbound', `channel_inbound:${id}`, 'lockChannelInbound 必须在事务里调用')
  }

  /**
   * 该去长轮询的绑定。`webhookOnly = false`（webhook 模式）时挂着 webhook 的不选——它们的
   * 消息由 Telegram 推过来；模式关着时全选，好让轮询循环把残留的 webhook 删掉
   * （见 channels.ts 的 pollOne 与 channels/inbound.ts）。
   */
  async dueChannelPolls(now: number, limit = 10, includeWebhook = true): Promise<ChannelBinding[]> {
    const rows = await this.many(
      `select * from channel_bindings where kind='telegram' and status='active'
       ${includeWebhook ? '' : `and "webhookSecretHash" = ''`}
       and coalesce("pollLeaseUntil",0) <= ? order by coalesce("lastPolledAt",0), "createdAt" limit ?`,
      [now, Math.min(50, Math.max(1, limit))],
    )
    return rows.map(channelBindingOf)
  }

  async claimChannelPoll(id: string, now: number, leaseUntil: number): Promise<boolean> {
    return (await this.run(
      `update channel_bindings set "pollLeaseUntil"=?, "lastPolledAt"=?, "updatedAt"=?
       where id=? and kind='telegram' and status='active' and coalesce("pollLeaseUntil",0) <= ?`,
      [leaseUntil, now, now, id, now],
    )) === 1
  }

  async finishChannelPoll(id: string, patch: { pollOffset?: number; pollLastError?: string | null; status?: ChannelBindingStatus; lastError?: string | null; nextPollAt?: number | null }): Promise<void> {
    // pollLeaseUntil 在请求飞行时是租约，失败收口后是“最早再试时间”。dueChannelPolls 的
    // 判据本来就是 <= now，因此无需再加一列，也不会出现两套时钟彼此打架。
    const fields = ['"pollLeaseUntil"=?', '"lastPolledAt"=?', '"updatedAt"=?']
    const now = Date.now()
    const values: unknown[] = [patch.nextPollAt ?? null, now, now]
    if (patch.pollOffset !== undefined) { fields.push('"pollOffset"=greatest("pollOffset",?)'); values.push(patch.pollOffset) }
    if (patch.pollLastError !== undefined) { fields.push('"pollLastError"=?'); values.push(patch.pollLastError) }
    if (patch.status !== undefined) { fields.push('status=?'); values.push(patch.status) }
    if (patch.lastError !== undefined) { fields.push('"lastError"=?'); values.push(patch.lastError) }
    values.push(id)
    await this.run(`update channel_bindings set ${fields.join(',')} where id=?`, values)
  }

  async advanceChannelPollOffset(id: string, offset: number): Promise<void> {
    await this.run(
      'update channel_bindings set "pollOffset"=greatest("pollOffset",?), "updatedAt"=? where id=?',
      [offset, Date.now(), id],
    )
  }

  async channelIdentity(bindingId: string): Promise<ChannelIdentity | undefined> {
    const row = await this.one('select * from channel_identities where "bindingId" = ? order by "pairedAt" limit 1', [bindingId])
    return row ? channelIdentityOf(row) : undefined
  }

  async channelIdentityForUser(bindingId: string, externalUserId: string): Promise<ChannelIdentity | undefined> {
    const row = await this.one('select * from channel_identities where "bindingId" = ? and "externalUserId" = ?', [bindingId, externalUserId])
    return row ? channelIdentityOf(row) : undefined
  }

  async pairChannelIdentity(input: Omit<ChannelIdentity, 'id' | 'pairedAt' | 'lastSeenAt'>): Promise<ChannelIdentity> {
    const now = Date.now()
    await this.run('delete from channel_identities where "bindingId" = ?', [input.bindingId])
    const id = randomUUID()
    await this.run(
      `insert into channel_identities
       (id,"bindingId","externalUserId","externalUsername","externalDisplayName","pairedEventId","pairedAt","lastSeenAt")
       values (?,?,?,?,?,?,?,?)`,
      [id, input.bindingId, input.externalUserId, input.externalUsername, input.externalDisplayName, input.pairedEventId, now, now],
    )
    return (await this.channelIdentity(input.bindingId))!
  }

  async touchChannelIdentity(id: string): Promise<void> {
    await this.run('update channel_identities set "lastSeenAt" = ? where id = ?', [Date.now(), id])
  }

  async deleteChannelIdentities(bindingId: string): Promise<void> {
    await this.run('delete from channel_identities where "bindingId" = ?', [bindingId])
  }

  async insertChannelEvent(input: {
    bindingId: string
    externalEventId: string
    externalConversationId: string
    remoteUserId?: string
    remoteDisplayName?: string
    title?: string
    text: string
  }): Promise<{ event: ChannelEvent; created: boolean }> {
    const now = Date.now()
    const id = randomUUID()
    /**
     * 同一条 update 来两次（Telegram 在拿到 2xx 之前会一直重送；webhook 模式下这是常态）
     * 只能入一条。**用 `on conflict do nothing`，不能靠 catch 唯一冲突再查**：调用方在事务里
     * （processTelegramUpdate 的 db.tx），一条失败的 insert 会让 PG 把整个事务标成 aborted，
     * 之后那句 select 拿到的是「current transaction is aborted」。长轮询模式下 offset 挡住了
     * 重放，这个坑一直没露出来。
     */
    const inserted = await this.run(
      `insert into channel_events
       (id,"bindingId","externalEventId","externalConversationId","remoteUserId","remoteDisplayName",title,text,status,attempts,"nextTryAt","leaseUntil","leaseToken","sessionId",reply,files,handoffs,"lastError","createdAt","updatedAt","deliveredAt")
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       on conflict ("bindingId", "externalEventId") do nothing`,
      [id, input.bindingId, input.externalEventId, input.externalConversationId, input.remoteUserId || '',
        input.remoteDisplayName || '', input.title || '', input.text, 'pending', 0, now, null, '', null, '', '[]', '[]', null, now, now, null],
    )
    if (inserted === 0) {
      const old = await this.one('select * from channel_events where "bindingId" = ? and "externalEventId" = ?', [input.bindingId, input.externalEventId])
      return { event: channelEventOf(old!), created: false }
    }
    return { event: (await this.channelEvent(id))!, created: true }
  }

  async channelEvent(id: string): Promise<ChannelEvent | undefined> {
    const r = await this.one('select * from channel_events where id = ?', [id])
    return r ? channelEventOf(r) : undefined
  }

  /**
   * 到期、而且是自己会话里排头的那几条。
   *
   * 每个远端会话一次只放一条。前一条还没送完时，后面的消息留在 pending，避免上下文
   * 次序和 Telegram 里看到的次序分叉。
   *
   * **归谁领要在 SQL 里筛，不能取完再筛。** 这里曾经不分谁来领、一律取全平台最老的 N 条，
   * 工人那条路再按机器挑、Gateway 的扫描再跳过归工人的——被跳过的行照旧到期，下一轮还
   * 排在最前面。于是一台机器的工人一挂（它那几个会话的消息一条条堆着没人领），只要堆出
   * N 个会话，别的机器的工人就再也领不到活，Gateway 自己的投递和重试也一起停摆：一家公司
   * 的故障变成全平台的渠道都不理人。现在每一方只取归自己的，谁堆多少都挤不到别人。
   *
   * 「归工人」的判据和 channels.ts 那一侧同一条：Bot 所在机器的协议 ≥ `minProtocol`
   * （MIN_CHANNEL_WORKER_PROTOCOL）。常量由调用方传进来，是因为它在 deploy.ts，而 deploy.ts
   * 本身依赖这个文件。
   */
  async dueChannelEvents(now: number, limit: number, scope: DueChannelScope): Promise<ChannelEvent[]> {
    // 这颗 Bot 在不在一台够新、归工人跑渠道的机器上。`b` 是外层的绑定。
    const onWorker = (machineFilter: string) => `exists (
      select 1 from seat_runtimes s join machines m on m.id = s."machineId"
       where s."accountId" = b."accountId" and s."botId" = b."botId" and m.protocol >= ?${machineFilter})`
    let owned: string
    let args: unknown[]
    if (scope.owner === 'worker') {
      // 这台机器上、还要跑一轮的。已经有回复只差投递的是 Gateway 的活。
      owned = `e.reply = '' and ${onWorker(' and s."machineId" = ?')}`
      args = [scope.minProtocol, scope.machineId]
    } else if (scope.owner === 'gateway') {
      // 已经有回复只差投递的，加上 Bot 所在机器还不够新、归不了工人的。
      owned = scope.deliveriesOnly ? `e.reply <> ''` : `(e.reply <> '' or not ${onWorker('')})`
      args = scope.deliveriesOnly ? [] : [scope.minProtocol]
    } else {
      // 归工人、从没被领过、又已经等了好一阵的。
      owned = `e.reply = '' and e.attempts = 0 and coalesce(e."leaseUntil",0) = 0 and e."createdAt" <= ? and ${onWorker('')}`
      args = [scope.createdBefore, scope.minProtocol]
    }
    const rows = await this.many(
      `select e.* from channel_events e join channel_bindings b on b.id=e."bindingId"
       where b.status='active'
         and ((e.status in ('pending','retry','ready') and coalesce(e."nextTryAt",0) <= ?)
           or (e.status='processing' and coalesce(e."leaseUntil",0) <= ?))
         and not exists (
           select 1 from channel_events p
            where p."bindingId"=e."bindingId" and p."externalConversationId"=e."externalConversationId"
              and (p."createdAt" < e."createdAt" or (p."createdAt"=e."createdAt" and p.id < e.id))
              and p.status not in ('delivered','dead')
         )
         and ${owned}
       order by e."createdAt", e.id limit ?`,
      [now, now, ...args, Math.min(50, Math.max(1, limit))],
    )
    return rows.map(channelEventOf)
  }

  async claimChannelEvent(id: string, now: number, leaseUntil: number, leaseToken: string): Promise<boolean> {
    return (await this.run(
      `update channel_events set status='processing', "leaseUntil"=?, "leaseToken"=?, "updatedAt"=?
       where id=? and ((status in ('pending','retry','ready') and coalesce("nextTryAt",0) <= ?)
         or (status='processing' and coalesce("leaseUntil",0) <= ?))`,
      [leaseUntil, leaseToken, now, id, now, now],
    )) === 1
  }

  /** 短租约心跳。token 不一致说明另一进程已经接管，旧进程必须停止提交。 */
  async renewChannelEventLease(id: string, leaseToken: string, leaseUntil: number): Promise<boolean> {
    return (await this.run(
      `update channel_events set "leaseUntil"=?, "updatedAt"=?
       where id=? and status='processing' and "leaseToken"=?`,
      [leaseUntil, Date.now(), id, leaseToken],
    )) === 1
  }

  /** 只有当前事件租约持有者能登记审批提示，供重启后的接管者判断是否已经发过。 */
  async recordChannelApprovalPrompt(id: string, leaseToken: string, approvalKey: string, messageId: number): Promise<boolean> {
    return (await this.run(
      `update channel_events set "approvalKey"=?, "approvalMessageId"=?, "updatedAt"=?
       where id=? and status='processing' and "leaseToken"=?`,
      [approvalKey, messageId, Date.now(), id, leaseToken],
    )) === 1
  }

  /**
   * 投递进度往前推一段，顺带续租。只认当前租约持有者，而且只增不减：迟到的旧请求推不回去。
   * 返回 false 就是租约已经不在手里，调用方必须停手，剩下的归接管者。
   */
  async advanceChannelDelivery(id: string, leaseToken: string, deliveredParts: number, leaseUntil: number): Promise<boolean> {
    return (await this.run(
      `update channel_events set "deliveredParts"=greatest("deliveredParts", ?), "leaseUntil"=?, "updatedAt"=?
       where id=? and status='processing' and "leaseToken"=?`,
      [deliveredParts, leaseUntil, Date.now(), id, leaseToken],
    )) === 1
  }

  /**
   * 只让当前租约持有者提交结果。状态离开 processing 时同时清掉 token 和租约，避免
   * 一个迟到的旧请求在接管者之后把 delivered/retry 覆盖回去。
   */
  async updateClaimedChannelEvent(id: string, leaseToken: string, patch: {
    status: ChannelEventStatus
    attempts?: number
    nextTryAt?: number | null
    leaseUntil?: number | null
    sessionId?: string | null
    reply?: string
    files?: { path: string; name: string }[]
    handoffs?: ChannelEvent['handoffs']
    lastError?: string | null
    deliveredAt?: number | null
  }): Promise<boolean> {
    const cur = await this.channelEvent(id)
    if (!cur || cur.leaseToken !== leaseToken || cur.status !== 'processing') return false
    const next = { ...cur, ...patch, updatedAt: Date.now() }
    const keepLease = next.status === 'processing'
    return (await this.run(
      `update channel_events set status=?, attempts=?, "nextTryAt"=?, "leaseUntil"=?, "leaseToken"=?,
       "sessionId"=?, reply=?, files=?, handoffs=?, "lastError"=?, "updatedAt"=?, "deliveredAt"=?
       where id=? and status='processing' and "leaseToken"=?`,
      [next.status, next.attempts, next.nextTryAt, keepLease ? next.leaseUntil : null,
        keepLease ? leaseToken : '', next.sessionId, next.reply, JSON.stringify(next.files), JSON.stringify(next.handoffs), next.lastError, next.updatedAt,
        next.deliveredAt, id, leaseToken],
    )) === 1
  }
}
