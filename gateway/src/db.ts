import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { randomAccessToken, randomApiKey, randomMachineToken } from './crypto.ts'
import { migrate, migrationState, type MigrateResult } from './db/migrate.ts'
import { type DiscoverySnapshot, emptySnapshot, parseDiscoverySnapshot } from './model-discovery.ts'
import type { ChannelBinding, ChannelBindingStatus, ChannelEvent, ChannelEventStatus, ChannelIdentity, ChannelKind, DueChannelScope } from './db/types.ts'
import { type Handoff, type HandoffState, HANDOFF_LIVE, type Account, type AccountSecrets, type AccountStatus, type AuditEvent, type BotDeletionRequest, type BotDeletionStatus, type BotRelease, type CatalogItem, type CatalogKind, type Company, type CompanyModelUsage, type ConnectionScope, type ConnectionStatus, type ConnectorCall, type ConnectorCallStatus, type ConnectorConnection, type ConnectorInstall, type ConversationAuditBatch, type ConversationAuditBatchKind, type ConversationAuditItem, type ConversationAuditModelRole, type ConversationAuditOutcome, type CompanySettings, type Credential, DEFAULT_MAX_ACCOUNTS, type Group, type Instance, type Invite, type Invoice, type LlmCall, type LlmUsage, type Machine, type MachineMetricMinute, type MachinePairing, type Memory, type MemoryKind, type MemoryLayer, type Plan, type PlanOrder, type PlanPeriod, type PlanSku, type PlatformSettings, type ReleaseKind, type Role, type Routine, type RoutineRun, type RoutineRunTrigger, type RoutineRunStatus, ROUTINE_RUNS_KEEP, type RoutineModelRole, type RoutineTrigger, SESSION_PAGE_DEFAULT, SESSION_PAGE_MAX, type Scope, type SeatRuntime, type SessionIndex, type Topup, type UsageCharge, type ChargeKind, type ChargeStatus, CHARGE_PAGE_DEFAULT, CHARGE_PAGE_MAX, type WebCall, type WebCallKind, emptyPlatformSettings, emptySettings, parseBilling, parseConnectorPricing, parseConversationAuditSettings, parseModelPricing, parseModelRate, parsePriceMultiplier, parseReasoningEffort, parseWebTools, releaseArch } from './db/types.ts'
import { type Row, accountOf, auditOf, botDeletionRequestOf, handoffOf, botReleaseOf, catalogOf, channelBindingOf, channelEventOf, channelIdentityOf, companyOf, connectorCallOf, connectorConnectionOf, connectorInstallOf, conversationAuditBatchOf, conversationAuditItemOf, credOf, groupOf, instanceOf, inviteOf, invoiceOf, isUniqueViolation, jsonOf, llmCallOf, machineMetricMinuteOf, machineOf, machinePairingOf, memoryOf, nameFromEmail, num, numOrNull, parseDailyAlternates, parsePlatformPayload, planOf, planOrderOf, planSkuOf, routineOf, routineRunOf, seatRuntimeOf, sessionIndexOf, str, strOrNull, toPgCounted, topupOf, usageChargeOf } from './db/rows.ts'

/**
 * 类型、常量和行解析都在 `db/` 底下；这里原样再导出，调用点仍然
 * `import { type Account, type Db } from './db.ts'`，一行都不用改。
 */
export * from './db/types.ts'
export * from './db/rows.ts'

const { Pool } = pg
type PoolClient = pg.PoolClient

/**
 * 「这个 schema 归谁用」的 advisory lock 键。
 *
 * 和 db/migrate.ts 里那把**不是同一把**：那把只护住迁移那几秒，拿完就放；这把是
 * 占用标记，进程活多久握多久。盐不同，两者不会互相阻塞。
 */
function claimKey(schema: string): number {
  const h = createHash('sha256').update('satuwork-schema-claim:' + schema).digest()
  // 同 migrate.ts：只取 31 位，省得跨语言对不上符号位。
  return h.readUInt32BE(0) & 0x7fffffff
}

/**
 * 「这个 schema 上还有别人在跑」。单拎一个类型出来，是为了让 index.ts 分得清它和
 * 真正的迁移失败——那条路会先打一句「库停在哪一号」，对这个错来说是句误导。
 */
export class SchemaBusyError extends Error {}

/** schema 名只允许普通标识符：它要拼进 SQL，不能走参数。 */
export function safeSchema(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error(`不合法的 schema 名：${name}`)
  return name
}

export interface DbOptions {
  url: string
  schema?: string
}

/**
 * 函数环境（Vercel）里才认的回落名。
 *
 * Neon 的 Vercel 集成往项目里注入的是它自己那套名字（DATABASE_URL 池化、
 * DATABASE_URL_UNPOOLED 直连），一个都不叫 GATEWAY_*。不认它们的话，每加一个环境就要
 * 手抄一遍连接串，而 Neon 轮换密码之后抄的那份就成了过期的死串。
 *
 * **只在 Vercel 上回落**（process.env.VERCEL）。`DATABASE_URL` 是个太常见的名字，开发机上
 * 十有八九指着别的项目的库；无条件回落等于把「忘了配 GATEWAY_DATABASE_URL」从一条说得很
 * 清楚的报错，变成静默连上另一个库——而 scripts/migrate.ts 是会往里写 schema 的。
 */
function neonFallback(...names: string[]): string {
  if (!process.env.VERCEL) return ''
  for (const name of names) {
    const v = (process.env[name] || '').trim()
    if (v) return v
  }
  return ''
}

/**
 * 把连接串里的 `sslmode=prefer|require|verify-ca` 钉成 `verify-full`。
 *
 * pg 8 本来就把这三个当 verify-full 用，但每次解析都往 stderr 打一条 SECURITY WARNING
 * （pg 9 要改回 libpq 语义）。Vercel 按 stderr 把它记成 error，每次冷启动日志里就多一条假报错。
 * Neon 注入的串带的是 `sslmode=require`，环境变量又归集成管、会被它重新同步，所以在这儿改，
 * 不去改变量本身。写死 verify-full 就是现在的行为，pg 升到 9 也不会悄悄降成「不验证书」。
 */
function pinSslMode(url: string): string {
  return url.replace(/([?&]sslmode=)(prefer|require|verify-ca)(?=&|$)/, '$1verify-full')
}

export function databaseUrl(): string {
  const url = (process.env.GATEWAY_DATABASE_URL || '').trim() || neonFallback('DATABASE_URL')
  if (!url) {
    throw new Error(
      '未配置 GATEWAY_DATABASE_URL。示例：postgres://satuwork:satuwork@127.0.0.1:5434/satuwork（docker compose up -d postgres）',
    )
  }
  return pinSslMode(url)
}

/** 迁移要**直连**串：迁移锁是会话级 advisory lock，过 PgBouncer 的事务池会漂（ADR §5.2）。 */
export function migrateDatabaseUrl(): string {
  const url = (process.env.GATEWAY_MIGRATE_DATABASE_URL || '').trim() || neonFallback('DATABASE_URL_UNPOOLED')
  return url ? pinSslMode(url) : databaseUrl()
}

/**
 * Gateway 自己的库（PostgreSQL）。跟 Bot 的 satuwork.db 不是同一份——
 * 聊天正文永远不该出现在这里。
 *
 * 驼峰列名一律加引号：PG 不加引号会折成小写，而 `select *` 的结果直接喂给上面那些
 * mapper。加了引号，写漏的那一刻 PG 就报 column does not exist，不会静默变 undefined。
 */
/**
 * 账本按 refId 收成一行，用于所有「维度在业务表、金额在账本」的汇总。
 *
 * `usage_charges."refId"` 上只有普通索引，不是唯一约束，同一次调用完全可能挂上两行账
 * （崩在写调用和记账之间随后重算、或者一条被重放的上报）。直接 join 会把业务表那一行
 * 复制一份——calls 翻倍、token 和金额跟着翻倍。先收再 join，扇出这件事就不存在了。
 */
const LEDGER_BY_REF = '(select "refId", sum("amountMicros") as micros from usage_charges group by "refId")'

/** Bot 删除请求失败后自动重试的上限。每次隔一分钟，试满就停在 failed 上，等管理员处理。 */
export const MAX_BOT_DELETION_ATTEMPTS = 20

/** 同一条日常任务已有一条 running 流水（见迁移 0035）。路由把它翻成 409。 */
export class RoutineBusyError extends Error {
  constructor(readonly routineId: string) {
    super('上一次还在跑')
    this.name = 'RoutineBusyError'
  }
}

export class Db {
  private pool: pg.Pool
  private schema: string
  private url: string
  /** 认领这个 schema 的那条连接。只有清库模式才有，见 claimSchema。 */
  private claim: pg.Client | null = null
  /** 事务期间把 client 放这儿，`db.tx(() => db.xxx())` 里的每条语句才走同一个连接。 */
  private txClient = new AsyncLocalStorage<PoolClient>()

  constructor(opts: DbOptions | string) {
    const o = typeof opts === 'string' ? { url: opts } : opts
    this.schema = safeSchema(o.schema || process.env.GATEWAY_PG_SCHEMA || 'public')
    this.url = o.url
    // search_path 走连接启动参数，不走 connect 事件里补一条 `set`——后者不等它跑完
    // 就可能先发业务查询，是条竞态。
    //
    // **但池化连接收不了 `options`**：Neon 的 pooler（pgbouncer）见到启动包里有
    // `-c search_path=…` 就拒掉整条连接（unsupported startup parameter），函数形态下
    // 每条走库的请求都成 500。而 public 本来就在默认 search_path 里，这一条压根不用发；
    // 只有换了 schema（e2e 的隔离库）才需要，那时用的是直连串，带得动。
    const startup = this.schema === 'public' ? {} : { options: `-c search_path=${this.schema}` }
    this.pool = new Pool({
      connectionString: o.url,
      // 函数环境里实例多、每个都开 10 条会把 Neon 的连接数打满；那儿走池化串、每实例 2 条够用。
      max: Math.max(1, Math.trunc(Number(process.env.GATEWAY_PG_POOL_MAX) || 10)),
      ...startup,
      // 库那侧看得见是谁连的。撞车时报错要指名道姓，靠的就是它（见 claimSchema）。
      application_name: `satuwork-gateway[${this.schema}]`,
    })
    this.pool.on('error', (e) => {
      console.error(`satuwork-gateway: 连接池错误 ${e.message}`)
    })
  }

  private async query(text: string, params: unknown[] = []): Promise<pg.QueryResult> {
    const { sql, count } = toPgCounted(text)
    /**
     * 占位符个数和参数个数对不上，**在这儿就说清楚**。
     *
     * PG 自己也会报（`bind message supplies 3 parameters, but prepared statement
     * requires 2`），但那句话不带 SQL，而这套代码里一半的 where 是拼出来的——真出错时
     * 人拿着那句话只能一条条去数 args。这里把语句头带上，省掉那一轮。
     */
    if (count !== params.length) {
      throw new Error(`SQL 占位符 ${count} 个，给了 ${params.length} 个参数：${text.trim().slice(0, 160)}`)
    }
    const client = this.txClient.getStore()
    if (client) return client.query(sql, params)
    return this.pool.query(sql, params)
  }

  private async one(text: string, params: unknown[] = []): Promise<Row | undefined> {
    const r = await this.query(text, params)
    return r.rows[0] as Row | undefined
  }

  private async many(text: string, params: unknown[] = []): Promise<Row[]> {
    const r = await this.query(text, params)
    return r.rows as Row[]
  }

  private async run(text: string, params: unknown[] = []): Promise<number> {
    const r = await this.query(text, params)
    return r.rowCount ?? 0
  }

  /**
   * 把库升到最新。**每次起进程都跑一遍**，跑完才对外服务。
   *
   * 空库从 0001 建全套；存量库第一次带着这套代码起来时，0001 是幂等的、跑起来等于
   * 空转，然后记一行 `schema_migrations`——不需要任何人工基线（见 db/migrate.ts）。
   * 返回这一轮真正跑掉的编号，由 index.ts 打进日志。
   */
  async init(): Promise<MigrateResult> {
    if (this.schema !== 'public') {
      // e2e 每轮要干净的库。**只对非 public schema 生效**——生产跑在 public 上，
      // 这个开关碰不到它。
      if (process.env.GATEWAY_PG_RESET === '1') {
        await this.claimSchema()
        await this.pool.query(`drop schema if exists "${this.schema}" cascade`)
      }
      await this.pool.query(`create schema if not exists "${this.schema}"`)
    }
    // 独占一条连接：advisory lock 是会话级的，拿和放必须在同一条上。
    const client = await this.pool.connect()
    try {
      return await migrate(client, this.schema)
    } finally {
      client.release()
    }
  }

  /**
   * 清库之前先认领这个 schema：**别的 Gateway 正用着的，一个字都不许动。**
   *
   * 出过一次，查了七轮才找出来。两份 e2e 同时在跑（两个 worktree、或者上一轮被
   * Ctrl-C 掉之后残留的进程），套件的 schema 名是写死的，于是后起的那个进程一句
   * `drop schema cascade` 把前一个正在服务的库端了。前一个进程活得好好的，只是从
   * 那一刻起：
   *
   * - 表在**重建的窗口里**查不到 → `relation "xxx" does not exist`；
   * - 重建完了，行是新的、id 是新的 → 手上那张 JWT 对应的账号「不存在」，此后每一
   *   条请求 401，而日志里没有任何一句提到有人清过库。
   *
   * 两种表现都指不回真正的原因，人只会去怀疑连接池、search_path、OID 缓存。所以这
   * 里换成一把**会话级 advisory lock，握到进程结束**：拿不到就说明有人在用，当场
   * 停机并且报出对面是谁（pid / application_name / 起始时间），而不是把它的数据抹掉。
   *
   * 只在清库模式下拿。生产（public schema）根本走不到这条路，不设 `GATEWAY_PG_RESET`
   * 的 e2e 套件（migrate）也不受影响——那些进程本来就不做破坏性动作。
   *
   * 短暂重试几秒：同一个 schema 上「杀掉旧的、立刻起新的」是 e2e 每一轮的常态，
   * 而 PG 回收上一条连接的锁需要一点时间，不等这几秒会把正常的重启也报成撞车。
   */
  private async claimSchema(): Promise<void> {
    const key = claimKey(this.schema)
    const client = new pg.Client({
      connectionString: this.url,
      application_name: `satuwork-gateway[${this.schema}]`,
    })
    await client.connect()
    try {
      const deadline = Date.now() + 5000
      for (;;) {
        const got = await client.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [key])
        if (got.rows[0]?.ok) {
          // 拿到了就一直握着——这条连接在 close() 里才断（进程被杀时由 PG 自己回收）。
          this.claim = client
          return
        }
        if (Date.now() >= deadline) break
        await new Promise((r) => setTimeout(r, 200))
      }
      // classid/objid 是那个 bigint 的高低 32 位；claimKey 只有 31 位，所以 classid 恒为 0。
      const who = await client.query<{ pid: number; application_name: string; client_addr: string | null; backend_start: Date }>(
        `select a.pid, a.application_name, host(a.client_addr) as client_addr, a.backend_start
           from pg_locks l join pg_stat_activity a on a.pid = l.pid
          where l.locktype = 'advisory' and l.classid = 0 and l.objid = $1 and l.granted`,
        [key],
      )
      const holders = who.rows
        .map((r) => `pid ${r.pid}（${r.application_name || '未署名'}${r.client_addr ? ` @ ${r.client_addr}` : ''}，起于 ${r.backend_start.toISOString()}）`)
        .join('；')
      throw new SchemaBusyError(
        `schema ${this.schema} 上还有 Gateway 在跑，拒绝 GATEWAY_PG_RESET 清库：${holders || '（对面已经不在 pg_stat_activity 里了）'}。\n` +
          '多半是两份 e2e 同时在跑（两个 worktree），或者上一轮被 Ctrl-C 之后残留了进程。' +
          '先把对面停掉，或者用 GATEWAY_PG_SCHEMA 换一个 schema 名。',
      )
    } finally {
      if (this.claim !== client) await client.end().catch(() => {})
    }
  }

  /** 库停在哪一号、代码里最新是哪一号、还差哪几条。给排查和 `/health` 用。 */
  migrations(): Promise<{ current: string | null; latest: string | null; pending: string[] }> {
    return migrationState(this.pool)
  }

  /** e2e 用：把本 schema 整个丢掉重建。生产不会走到。 */
  async dropSchema(): Promise<void> {
    if (this.schema === 'public') throw new Error('拒绝 drop public schema')
    await this.pool.query(`drop schema if exists "${this.schema}" cascade`)
  }

  async close(): Promise<void> {
    // 认领连接先断：它不像池子那样空闲就回收，留着会吊住事件循环，进程停在
    // 「端口不听了、人还没退出」那个最坏的状态上（见 index.ts 的 shutdown）。
    const claim = this.claim
    this.claim = null
    if (claim) await claim.end().catch(() => {})
    await this.pool.end()
  }

  /**
   * 事务级排他锁。**「先查一遍，没有再插」那一类要它。**
   *
   * `db.tx` 跑在 PG 默认的 READ COMMITTED 上：两条并发事务各自 `select` 到「还没有」，
   * 然后各插一行，两边都提交成功——「抢在事务里再查一遍」这句话在这个隔离级别下根本
   * 不成立，它只是把窗口缩小到看起来不会发生。CI 上那次「并发点两次创建也只成一个」
   * 报 201/201，就是窗口没缩住。
   *
   * 锁跟着事务走（commit / rollback 自动放），所以调用方不用记得解锁；**但它必须在
   * `db.tx` 里调**，事务外的 xact 锁当场就放了，等于没锁。
   *
   * 每一处各取一个常数，别复用同一个数：两件不相干的事排在一条队上，是最难查的那种慢。
   *
   * **锁是整个库的，不分 schema。** e2e 那几十套共用一个 Postgres（各占一个 schema），
   * 两份并行的 e2e 会在同一个号上互相等一下——等的是一次 insert 的工夫，可以接受；要是
   * 哪天有一处锁里带上了慢活，那时再把 schema 名折进第二个参数。
   */
  async lockExclusive(key: number): Promise<void> {
    if (!this.txClient.getStore()) throw new Error('lockExclusive 必须在 db.tx 里调——事务外的锁当场就放了')
    await this.one('select pg_advisory_xact_lock(?)', [key])
  }

  async tx<T>(fn: () => Promise<T> | T): Promise<T> {
    const existing = this.txClient.getStore()
    // 已经在事务里就直接跑，不开嵌套事务。
    if (existing) return fn()
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const out = await this.txClient.run(client, async () => fn())
      await client.query('commit')
      return out
    } catch (e) {
      try {
        await client.query('rollback')
      } catch {}
      throw e
    } finally {
      client.release()
    }
  }

  // ── 公司 ──────────────────────────────────────────────────────────────

  async insertCompany(
    input: {
      slug: string
      name: string
    } & Partial<Pick<Company, 'contactName' | 'contactPhone' | 'contactEmail' | 'address' | 'website'>>,
  ): Promise<Company> {
    const now = Date.now()
    const row: Company = {
      id: randomUUID(),
      slug: input.slug,
      name: input.name,
      status: 'active',
      contactName: input.contactName ?? '',
      contactPhone: input.contactPhone ?? '',
      contactEmail: input.contactEmail ?? '',
      address: input.address ?? '',
      website: input.website ?? '',
      machineId: null,
      accessUrl: null,
      handoffWebhook: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.run(
      'insert into companies (id, slug, name, status, "contactName", "contactPhone", "contactEmail", address, website, "machineId", "accessUrl", "createdAt", "updatedAt") values (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        row.id,
        row.slug,
        row.name,
        row.status,
        row.contactName,
        row.contactPhone,
        row.contactEmail,
        row.address,
        row.website,
        row.machineId,
        row.accessUrl,
        row.createdAt,
        row.updatedAt,
      ],
    )
    return row
  }

  async company(id: string): Promise<Company | undefined> {
    const r = await this.one('select * from companies where id = ?', [id])
    return r ? companyOf(r) : undefined
  }

  async companyBySlug(slug: string): Promise<Company | undefined> {
    const r = await this.one('select * from companies where slug = ?', [slug])
    return r ? companyOf(r) : undefined
  }

  async updateCompany(
    id: string,
    patch: Partial<
      Pick<
        Company,
        | 'name'
        | 'slug'
        | 'status'
        | 'contactName'
        | 'contactPhone'
        | 'contactEmail'
        | 'address'
        | 'website'
        | 'machineId'
        | 'accessUrl'
        | 'handoffWebhook'
      >
    >,
  ): Promise<Company> {
    const cur = await this.company(id)
    if (!cur) throw new Error('公司不存在')
    const next: Company = {
      ...cur,
      name: patch.name ?? cur.name,
      slug: patch.slug ?? cur.slug,
      status: patch.status ?? cur.status,
      contactName: patch.contactName ?? cur.contactName,
      contactPhone: patch.contactPhone ?? cur.contactPhone,
      contactEmail: patch.contactEmail ?? cur.contactEmail,
      address: patch.address ?? cur.address,
      website: patch.website ?? cur.website,
      machineId: patch.machineId === undefined ? cur.machineId : patch.machineId,
      accessUrl: patch.accessUrl === undefined ? cur.accessUrl : patch.accessUrl,
      handoffWebhook: patch.handoffWebhook === undefined ? cur.handoffWebhook : patch.handoffWebhook,
      updatedAt: Date.now(),
    }
    await this.run(
      'update companies set slug=?, name=?, status=?, "contactName"=?, "contactPhone"=?, "contactEmail"=?, address=?, website=?, "machineId"=?, "accessUrl"=?, "handoffWebhook"=?, "updatedAt"=? where id=?',
      [
        next.slug,
        next.name,
        next.status,
        next.contactName,
        next.contactPhone,
        next.contactEmail,
        next.address,
        next.website,
        next.machineId,
        next.accessUrl,
        next.handoffWebhook,
        next.updatedAt,
        id,
      ],
    )
    return next
  }

  /**
   * 硬删一家公司。**整串在一个事务里。**
   *
   * 十几条依赖删除要么一起成、要么一起不成：中途失败（连接断、后加的表带上外键、池子
   * 出错）留下的是一家「公司行还在、账号和席位已经没了」的半删公司——界面上照样列得
   * 出来，而管理员账号已经没了，没人能登进去看。
   *
   * 事务开在这儿而不是只靠调用方：`tx` 是可重入的（已经在事务里就直接跑），所以路由
   * 那侧现有的 `db.tx(() => db.deleteCompany(...))` 照旧生效，同时这条不变量不再取决于
   * 「每一个未来的调用方都记得包一层」。deleteAccount / deleteBot 也是这个写法。
   */
  async deleteCompany(id: string): Promise<void> {
    await this.tx(async () => {
    await this.run('delete from conversation_audit_items where "companyId" = ?', [id])
    await this.run('delete from conversation_audit_batches where "companyId" = ?', [id])
    await this.run('delete from bot_deletion_requests where "companyId" = ?', [id])
    await this.run('delete from channel_bindings where "companyId" = ?', [id])
    await this.run('delete from groups where "companyId" = ?', [id])
    await this.run('delete from skill_tags where "companyId" = ?', [id])
    await this.run('delete from session_index where "companyId" = ?', [id])
    await this.run('delete from instances where "companyId" = ?', [id])
    await this.run('delete from seat_runtimes where "companyId" = ?', [id])
    await this.run('delete from audit_events where "companyId" = ?', [id])
    await this.run('delete from settings where "companyId" = ?', [id])
    await this.run('delete from credentials where "companyId" = ?', [id])
    await this.run('delete from catalog_items where "companyId" = ?', [id])
    await this.run('update machines set "companyId" = null where "companyId" = ?', [id])
    // machine_pairings."companyId" 有真外键指向 companies(id)。漏了这一条，最后那句
    // `delete from companies` 对**任何配对过机器的公司**都会外键报错，整条删除永远
    // 走不通。machines 那行是解绑（机器要留着重派），配对码则是一次性的，直接删。
    await this.run('delete from machine_pairings where "companyId" = ?', [id])
    await this.run('delete from invites where "companyId" = ?', [id])
    // **用量不删。** llm_calls 属于必须留档的记录，路由那道闸已经挡住「有用量的公司
    // 不许硬删」；这里不留销毁语句，免得将来有别的调用方绕过闸把它抹掉。表上没有指向
    // companies 的外键，公司行没了这些记录照样留得住。
    await this.run('delete from account_secrets where "accountId" in (select id from accounts where "companyId" = ?)', [id])
    await this.run('delete from accounts where "companyId" = ?', [id])
    await this.run('delete from plans where "companyId" = ?', [id])
    // 账单挂在订单上，先账单后订单，否则外键把订单卡住。
    await this.run('delete from topups where "companyId" = ?', [id])
    await this.run('delete from invoices where "companyId" = ?', [id])
    await this.run('delete from plan_orders where "companyId" = ?', [id])
    await this.run('delete from companies where id = ?', [id])
    })
  }

  /**
   * 这家公司还剩多少条**要留档**的记录。
   *
   * 账单和用量有留存要求，而 deleteCompany 是硬删——两者冲突时以留档为准，
   * 所以删除路由拿它来决定是不是该改走「停用」。
   */
  async billingFootprint(id: string): Promise<{ invoices: number; orders: number; topups: number; llmCalls: number }> {
    const n = (r: Row | undefined) => Number((r as { n?: unknown } | undefined)?.n ?? 0)
    // 表名写死在四条语句里，不拼字符串——这个文件里的 SQL 一律只有占位符是变的。
    return {
      invoices: n(await this.one('select count(*)::int as n from invoices where "companyId" = ?', [id])),
      orders: n(await this.one('select count(*)::int as n from plan_orders where "companyId" = ?', [id])),
      topups: n(await this.one('select count(*)::int as n from topups where "companyId" = ?', [id])),
      llmCalls: n(await this.one('select count(*)::int as n from llm_calls where "companyId" = ?', [id])),
    }
  }

  async companies(): Promise<Company[]> {
    const rows = await this.many('select * from companies order by "createdAt"')
    return rows.map(companyOf)
  }

  // ── 账号 ──────────────────────────────────────────────────────────────

  async insertAccount(input: {
    companyId: string | null
    email: string
    passwordHash: string
    role: Role
    name?: string
    status?: AccountStatus
  }): Promise<Account> {
    let companyId = input.companyId
    if (input.role === 'owner') {
      if (companyId) throw new Error('owner 不能属于公司')
      companyId = null
    } else if (input.role === 'admin' || input.role === 'member') {
      if (!companyId) throw new Error('admin/member 必须属于公司')
    } else {
      throw new Error('未知角色')
    }
    const now = Date.now()
    const email = input.email
    const row: Account = {
      id: randomUUID(),
      companyId,
      email,
      name: (input.name ?? '').trim() || nameFromEmail(email),
      title: '',
      phone: '',
      theme: 'system',
      locale: 'zh',
      passwordHash: input.passwordHash,
      role: input.role,
      status: input.status ?? 'active',
      lastSeenAt: null,
      passwordChangedAt: null,
      tokenRevokedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.run(
      'insert into accounts (id, "companyId", email, name, title, phone, theme, locale, "passwordHash", role, status, "lastSeenAt", "passwordChangedAt", "tokenRevokedAt", "createdAt", "updatedAt") values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        row.id,
        row.companyId,
        row.email,
        row.name,
        row.title,
        row.phone,
        row.theme,
        row.locale,
        row.passwordHash,
        row.role,
        row.status,
        row.lastSeenAt,
        row.passwordChangedAt,
        row.tokenRevokedAt,
        row.createdAt,
        row.updatedAt,
      ],
    )
    if (row.role === 'admin' || row.role === 'member') await this.issueAccountSecrets(row.id)
    return row
  }

  async account(id: string): Promise<Account | undefined> {
    const r = await this.one('select * from accounts where id = ?', [id])
    return r ? accountOf(r) : undefined
  }

  async accountByEmail(email: string): Promise<Account | undefined> {
    const r = await this.one('select * from accounts where email = ?', [email])
    return r ? accountOf(r) : undefined
  }

  async accountsOf(companyId: string): Promise<Account[]> {
    const rows = await this.many('select * from accounts where "companyId" = ? order by "createdAt"', [companyId])
    return rows.map(accountOf)
  }

  async accountsAll(): Promise<Account[]> {
    const rows = await this.many('select * from accounts order by "createdAt"')
    return rows.map(accountOf)
  }

  async owners(): Promise<Account[]> {
    const rows = await this.many("select * from accounts where role = 'owner' order by \"createdAt\"")
    return rows.map(accountOf)
  }

  /** 占用席位：本公司非停用账号（owner 本来就不属于公司）。 */
  /**
   * 占席位这件事要串起来做：在事务里先锁住这家公司的套餐行，再数人、再写人。
   * 不锁的话两个请求可能同时读到「还剩一个席位」，各自放行，超出上限。
   */
  async lockPlan(companyId: string): Promise<void> {
    await this.one('select 1 from plans where "companyId" = ? for update', [companyId])
  }

  /** 占着席位的人：算 active 和 invited（邀请也占位），不算停用的，也不算 owner。 */
  async accountCount(companyId: string): Promise<number> {
    const r = await this.one(
      "select count(*) as n from accounts where \"companyId\" = ? and status != 'disabled' and role != 'owner'",
      [companyId],
    )
    return Number(r?.n ?? 0)
  }

  /** 还能管事的管理员：未停用的 admin（含待接受）。最后一个管理员靠它守门。 */
  /**
   * 还能登录的系统管理员有几个。停用最后一个之前要问它——平台账号不属于任何公司，
   * adminCount 那条按公司数的检查够不着它，而停完就再没有任何一条路能把它开回来。
   */
  async activeOwnerCount(): Promise<number> {
    const r = await this.one("select count(*) as n from accounts where role = 'owner' and status != 'disabled'")
    return Number(r?.n ?? 0)
  }

  async adminCount(companyId: string): Promise<number> {
    const r = await this.one(
      "select count(*) as n from accounts where \"companyId\" = ? and role = 'admin' and status != 'disabled'",
      [companyId],
    )
    return Number(r?.n ?? 0)
  }

  async updateAccount(
    id: string,
    patch: Partial<
      Pick<
        Account,
        | 'name'
        | 'title'
        | 'phone'
        | 'theme'
        | 'locale'
        | 'role'
        | 'status'
        | 'lastSeenAt'
        | 'passwordHash'
        | 'passwordChangedAt'
        | 'tokenRevokedAt'
      >
    >,
  ): Promise<Account> {
    const cur = await this.account(id)
    if (!cur) throw new Error('账号不存在')
    const next: Account = {
      ...cur,
      name: patch.name !== undefined ? patch.name : cur.name,
      title: patch.title !== undefined ? patch.title : cur.title,
      phone: patch.phone !== undefined ? patch.phone : cur.phone,
      theme: patch.theme ?? cur.theme,
      locale: patch.locale ?? cur.locale,
      role: patch.role ?? cur.role,
      status: patch.status ?? cur.status,
      lastSeenAt: patch.lastSeenAt !== undefined ? patch.lastSeenAt : cur.lastSeenAt,
      passwordHash: patch.passwordHash ?? cur.passwordHash,
      passwordChangedAt: patch.passwordChangedAt !== undefined ? patch.passwordChangedAt : cur.passwordChangedAt,
      tokenRevokedAt: patch.tokenRevokedAt !== undefined ? patch.tokenRevokedAt : cur.tokenRevokedAt,
      updatedAt: Date.now(),
    }
    await this.run(
      'update accounts set name=?, title=?, phone=?, theme=?, locale=?, role=?, status=?, "lastSeenAt"=?, "passwordHash"=?, "passwordChangedAt"=?, "tokenRevokedAt"=?, "updatedAt"=? where id=?',
      [
        next.name,
        next.title,
        next.phone,
        next.theme,
        next.locale,
        next.role,
        next.status,
        next.lastSeenAt,
        next.passwordHash,
        next.passwordChangedAt,
        next.tokenRevokedAt,
        next.updatedAt,
        id,
      ],
    )
    return next
  }

  async deleteAccount(id: string): Promise<void> {
    await this.tx(async () => {
      const cur = await this.account(id)
      await this.deleteInvitesForUser(id)
      await this.run('delete from session_index where "accountId" = ?', [id])
      await this.run('delete from instances where "accountId" = ?', [id])
      await this.run('delete from seat_runtimes where "accountId" = ?', [id])
      await this.run('delete from channel_bindings where "accountId" = ?', [id])
      // 同上：删员工也不销毁他的用量记录。少了它，公司的历史用量会凭空缺一块，而
      // 「谁烧了多少」正是要留档的东西。accountId 变成悬空引用，统计里按 id 显示。
      await this.run('delete from account_secrets where "accountId" = ?', [id])
      // 他自己建的 Bot 跟着他走。catalog_items."accountId" 是真外键，留着这几行的话
      // 最后那句 delete from accounts 会直接外键报错，删员工整条路走不通。
      await this.run('delete from catalog_items where scope = \'user\' and "accountId" = ?', [id])
      if (cur?.companyId) {
        for (const g of await this.groupsOf(cur.companyId)) {
          if (!g.members.includes(id)) continue
          await this.updateGroup(g.id, { members: g.members.filter((m) => m !== id) })
        }
      }
      await this.run('delete from accounts where id = ?', [id])
    })
  }

  // ── 席位密钥。明文存，详情页给 owner 看；列表接口不许带出去。────────

  async accountSecrets(accountId: string): Promise<AccountSecrets | undefined> {
    const r = await this.one('select * from account_secrets where "accountId" = ?', [accountId])
    if (!r) return undefined
    return {
      accountId: str(r.accountId),
      apiKey: str(r.apiKey),
      accessToken: str(r.accessToken),
      createdAt: num(r.createdAt),
    }
  }

  async issueAccountSecrets(accountId: string): Promise<AccountSecrets | undefined> {
    const existing = await this.accountSecrets(accountId)
    if (existing) return existing
    const account = await this.account(accountId)
    if (!account || account.role === 'owner') return undefined
    for (let i = 0; i < 8; i++) {
      const apiKey = randomApiKey()
      const accessToken = randomAccessToken()
      const createdAt = Date.now()
      try {
        await this.run(
          'insert into account_secrets ("accountId", "apiKey", "accessToken", "createdAt") values (?,?,?,?)',
          [accountId, apiKey, accessToken, createdAt],
        )
        return { accountId, apiKey, accessToken, createdAt }
      } catch (e) {
        if (!isUniqueViolation(e)) throw e
        /**
         * 冲突分两种，处理方式相反。
         *
         * `accountId` 是主键：并发的另一次调用先插进去了，重试多少次都是同一个冲突，
         * 正确结果就在库里，回读一次即可（installConnector 就是这么写的）。只有
         * apiKey / accessToken 撞了才轮得到「换一串再试」。
         */
        const raced = await this.accountSecrets(accountId)
        if (raced) return raced
        if (i === 7) throw e
      }
    }
    return undefined
  }

  /** 旧席位部署时补发。已有则原样返回。 */
  async ensureAccountSecrets(accountId: string): Promise<AccountSecrets | undefined> {
    return this.issueAccountSecrets(accountId)
  }

  /**
   * 桌面端本地 Bot 的那一套凭证（迁移 0041）。还有效就原样给，**早于 `notBefore`（账号的
   * tokenRevokedAt）的就换一套新的**——改口令、被重置之后，旧的那一套和旧登录票一起作废。
   *
   * 换新是一条带条件的 upsert：几颗本地 Bot 同时启动会并发来要，只看「查到的那份过期了」
   * 就各插一套的话，先回去的那颗拿到的票转眼就被后一套顶掉。条件落空（别人刚换过）就读回
   * 别人换好的那一份，大家拿到的是同一套。
   */
  async desktopSecrets(accountId: string, notBefore: number): Promise<AccountSecrets> {
    const read = async () => {
      const r = await this.one('select * from desktop_secrets where "accountId" = ?', [accountId])
      return r
        ? { accountId: str(r.accountId), apiKey: str(r.apiKey), accessToken: str(r.accessToken), createdAt: num(r.createdAt) }
        : undefined
    }
    const cur = await read()
    if (cur && cur.createdAt >= notBefore) return cur
    const r = await this.one(
      `insert into desktop_secrets ("accountId", "apiKey", "accessToken", "createdAt") values (?,?,?,?)
       on conflict ("accountId") do update
         set "apiKey" = excluded."apiKey", "accessToken" = excluded."accessToken", "createdAt" = excluded."createdAt"
         where desktop_secrets."createdAt" < ?
       returning *`,
      [accountId, randomApiKey(), randomAccessToken(), Math.max(Date.now(), notBefore), notBefore],
    )
    if (r) return { accountId: str(r.accountId), apiKey: str(r.apiKey), accessToken: str(r.accessToken), createdAt: num(r.createdAt) }
    const raced = await read()
    if (!raced) throw new Error('桌面端凭证写不进去')
    return raced
  }

  /**
   * 席位那一套只要对得上就认；桌面端那一套还得**不早于账号的 tokenRevokedAt**——它是拿登录票
   * 换来的，登录票作废了它也跟着作废（见迁移 0041）。
   */
  async accountByApiKey(key: string): Promise<Account | undefined> {
    if (!key) return undefined
    const r =
      (await this.one('select "accountId" from account_secrets where "apiKey" = ?', [key])) ??
      (await this.one(
        `select d."accountId" from desktop_secrets d join accounts a on a.id = d."accountId"
          where d."apiKey" = ? and d."createdAt" >= coalesce(a."tokenRevokedAt", 0)`,
        [key],
      ))
    return r ? this.account(str(r.accountId)) : undefined
  }

  async accountByAccessToken(token: string): Promise<Account | undefined> {
    if (!token) return undefined
    const r =
      (await this.one('select "accountId" from account_secrets where "accessToken" = ?', [token])) ??
      (await this.one(
        `select d."accountId" from desktop_secrets d join accounts a on a.id = d."accountId"
          where d."accessToken" = ? and d."createdAt" >= coalesce(a."tokenRevokedAt", 0)`,
        [token],
      ))
    return r ? this.account(str(r.accountId)) : undefined
  }

  /**
   * 登记一次模型调用。
   *
   * `relayMachineId`（迁移 0040）是**清扫的判据，不是业务字段**，所以它只进库、不进
   * 返回的 LlmCall：非空表示「这一行是中继授权出去的」，未结算清扫只认这一撮
   * （见 unsettledLlmCalls）。/v1 自己代理的那几条不传——它们有 withSettle 兜着收口，
   * 本来就不该被事后扫。
   */
  async insertLlmCall(input: {
    accountId: string
    companyId?: string | null
    provider: string
    model: string
    promptTokens?: number
    completionTokens?: number
    cachedTokens?: number
    cacheWriteTokens?: number
    relayMachineId?: string | null
  }): Promise<LlmCall> {
    const row: LlmCall = {
      id: randomUUID(),
      accountId: input.accountId,
      companyId: input.companyId ?? null,
      provider: input.provider,
      model: input.model,
      promptTokens: input.promptTokens ?? 0,
      completionTokens: input.completionTokens ?? 0,
      cachedTokens: input.cachedTokens ?? 0,
      cacheWriteTokens: input.cacheWriteTokens ?? 0,
      createdAt: Date.now(),
    }
    await this.run(
      'insert into llm_calls (id, "accountId", "companyId", provider, model, "promptTokens", "completionTokens", "cachedTokens", "cacheWriteTokens", "createdAt", "relayMachineId") values (?,?,?,?,?,?,?,?,?,?,?)',
      [
        row.id,
        row.accountId,
        row.companyId,
        row.provider,
        row.model,
        row.promptTokens,
        row.completionTokens,
        row.cachedTokens,
        row.cacheWriteTokens,
        row.createdAt,
        input.relayMachineId ?? null,
      ],
    )
    return row
  }

  async updateLlmCallTokens(
    id: string,
    usage: { prompt_tokens: number; completion_tokens: number; cached_tokens?: number; cache_write_tokens?: number },
  ): Promise<void> {
    await this.run(
      'update llm_calls set "promptTokens"=?, "completionTokens"=?, "cachedTokens"=?, "cacheWriteTokens"=? where id=?',
      [usage.prompt_tokens, usage.completion_tokens, usage.cached_tokens ?? 0, usage.cache_write_tokens ?? 0, id],
    )
  }

  async llmCall(id: string): Promise<LlmCall | undefined> {
    const r = await this.one('select * from llm_calls where id = ?', [id])
    return r ? llmCallOf(r) : undefined
  }

  /**
   * 这一次调用落过账没有。管家中继的结算接口靠它做幂等：管家重试、或者清扫和结算
   * 撞在一起时，第二笔只能是「已经记过了」，不能再挂一行。
   */
  async chargeExistsForRef(refId: string): Promise<boolean> {
    const r = await this.one('select 1 as n from usage_charges where "refId" = ? limit 1', [refId])
    return !!r
  }

  /**
   * `before` 之前登记、账本上却没有对应行、**而且确实是中继授权出去的**调用——管家拿了
   * 授权（grant）之后死在半路，没来得及结算的那些。清扫拿它们按 failed 收口
   * （routines.ts 的 sweepUnsettledLlmCalls）。
   *
   * **`relayMachineId is not null` 这一条不能少。** 少了它，判据就只剩「够老 + 账本上没
   * 对应行」，而 `llm_calls` 从 0001 就有、账本（`usage_charges.refId`）0007 才加——
   * 于是 0007 之前的每一行都命中，`order by createdAt asc` 又是从最老的开始捞，清扫会
   * 每拍给 200 条历史调用补一笔 failed / 0 元的假账。这有三处后果：docs/billing.md §11
   * 说死了「历史模型调用一行都不回填」；`llmUsageByCompanyModel` 的 `unledgeredCalls`
   * （管理台那条「这一段账是空的」横幅靠它）会被抹成 0；`insertUsageCharge` 盖的是当下
   * 的时间戳，几年前的调用会集体涌进本月账单页。历史行这一格全是 null，扫不到。
   */
  async unsettledLlmCalls(before: number, limit: number): Promise<LlmCall[]> {
    // not exists 走 usage_ref 那条索引；按 refId 把整张账本先聚合一遍（LEDGER_BY_REF）在
    // 这里太重——这条每半分钟跑一次。非空那一撮另有部分索引 llm_calls_unsettled（0040）。
    const rows = await this.many(
      `select l.* from llm_calls l
       where l."createdAt" < ? and l."relayMachineId" is not null
         and not exists (select 1 from usage_charges u where u."refId" = l.id)
       order by l."createdAt" asc limit ?`,
      [before, limit],
    )
    return rows.map(llmCallOf)
  }

  async insertWebCall(input: {
    accountId: string
    companyId?: string | null
    kind: WebCallKind
    backend: string
    units: number
  }): Promise<WebCall> {
    const row: WebCall = {
      id: randomUUID(),
      accountId: input.accountId,
      companyId: input.companyId ?? null,
      kind: input.kind,
      backend: input.backend,
      units: input.units,
      // 同 connector_calls：钱在账本里，这一列留给老行，新行恒为 0。
      mils: 0,
      createdAt: Date.now(),
    }
    await this.run(
      'insert into web_calls (id, "accountId", "companyId", kind, backend, units, mils, "createdAt") values (?,?,?,?,?,?,?,?)',
      [row.id, row.accountId, row.companyId, row.kind, row.backend, row.units, row.mils, row.createdAt],
    )
    return row
  }

  /** 按公司 × 后端 × 类型汇总。金额直接求和——它已经是当时的报价，不重算。 */
  async webUsageByCompanyBackend(
    range?: { from?: number; to?: number },
    companyId?: string,
  ): Promise<{ companyId: string | null; backend: string; kind: string; calls: number; units: number; amountMicros: number; lastAt: number | null }[]> {
    const r = this.llmRangeSql(range)
    const args: unknown[] = [...r.args]
    let where = `where 1=1${r.sql}`
    if (companyId) {
      where += ' and "companyId" = ?'
      args.push(companyId)
    }
    // 金额按 refId 从账本接回来。web_calls 有 backend / kind / units 这些账本里没有的
    // 维度，账本有钱——两边各出各的那一半（docs/billing.md §2）。老行的钱还在 mils 上，
    // 回填脚本会把它们翻成账本行，所以这里只认账本，不再 `sum(mils)`。
    const rows = await this.many(
      `select w."companyId", w.backend, w.kind, count(*) as calls,
              coalesce(sum(w.units), 0) as units,
              coalesce(sum(u.micros), 0) as micros,
              max(w."createdAt") as "lastAt"
       from web_calls w left join ${LEDGER_BY_REF} u on u."refId" = w.id
       ${where.replace(/"companyId"/g, 'w."companyId"').replace(/"createdAt"/g, 'w."createdAt"')}
       group by w."companyId", w.backend, w.kind`,
      args,
    )
    return rows.map((row) => ({
      companyId: strOrNull(row.companyId),
      backend: str(row.backend),
      kind: str(row.kind),
      calls: num(row.calls),
      units: num(row.units),
      amountMicros: num(row.micros),
      lastAt: row.lastAt == null ? null : num(row.lastAt),
    }))
  }

  /** 这家公司从某个时刻起用了多少次。配额闸用它，所以只数条数不取行。 */
  async webCallCountSince(companyId: string, since: number): Promise<number> {
    const r = await this.one('select count(*)::int as n from web_calls where "companyId" = ? and "createdAt" >= ?', [
      companyId,
      since,
    ])
    return num(r?.n ?? 0)
  }

  async webCallsOfCompany(companyId: string): Promise<WebCall[]> {
    const rows = await this.many('select * from web_calls where "companyId" = ? order by "createdAt" desc', [companyId])
    return rows.map((r) => ({
      id: str(r.id),
      accountId: str(r.accountId),
      companyId: strOrNull(r.companyId),
      kind: str(r.kind) as WebCallKind,
      backend: str(r.backend),
      units: num(r.units),
      mils: num(r.mils),
      createdAt: num(r.createdAt),
    }))
  }

  async llmCallsOfCompany(companyId: string): Promise<LlmCall[]> {
    const rows = await this.many('select * from llm_calls where "companyId" = ? order by "createdAt" desc', [companyId])
    return rows.map(llmCallOf)
  }

  private llmRangeSql(range?: { from?: number; to?: number }): { sql: string; args: number[] } {
    let sql = ''
    const args: number[] = []
    if (range?.from != null) {
      sql += ' and "createdAt" >= ?'
      args.push(range.from)
    }
    if (range?.to != null) {
      sql += ' and "createdAt" <= ?'
      args.push(range.to)
    }
    return { sql, args }
  }

  private async llmUsageBy(
    column: 'companyId' | 'accountId',
    value: string,
    range?: { from?: number; to?: number },
  ): Promise<LlmUsage> {
    const r = this.llmRangeSql(range)
    const total = await this.one(
      `select count(*) as calls, coalesce(sum("promptTokens"), 0) as "promptTokens", coalesce(sum("completionTokens"), 0) as "completionTokens" from llm_calls where "${column}" = ?${r.sql}`,
      [value, ...r.args],
    )
    const by = await this.many(
      `select "accountId", count(*) as calls, coalesce(sum("promptTokens"), 0) as "promptTokens", coalesce(sum("completionTokens"), 0) as "completionTokens", max("createdAt") as "lastAt" from llm_calls where "${column}" = ?${r.sql} group by "accountId"`,
      [value, ...r.args],
    )
    return {
      calls: num(total?.calls ?? 0),
      promptTokens: num(total?.promptTokens ?? 0),
      completionTokens: num(total?.completionTokens ?? 0),
      byAccount: by.map((row) => ({
        accountId: str(row.accountId),
        calls: num(row.calls),
        promptTokens: num(row.promptTokens),
        completionTokens: num(row.completionTokens),
        lastAt: numOrNull(row.lastAt),
      })),
    }
  }

  /**
   * 每日调用数，给用量屏那根日线。
   *
   * **按看的人所在时区切天。** 服务端不知道那是哪个时区（同 `/platform/stats` 的窗口
   * 一样由前端算好传上来），所以切桶之前先把时间平移 `offsetMs`——不平移的话，东八区
   * 早上八点之前的调用会落进前一天，整条日线左移一格，而这种错在图上看不出来。
   *
   * 返回的是桶号（平移之后的天序号），不是日期字符串：日期怎么写是显示的事，
   * 而且 SQL 里格式化日期还得再引入一次时区。
   */
  async llmDailyBy(
    column: 'companyId' | 'accountId',
    value: string,
    range?: { from?: number; to?: number },
    offsetMs = 0,
  ): Promise<{ bucket: number; calls: number }[]> {
    const r = this.llmRangeSql(range)
    const rows = await this.many(
      `select floor(("createdAt" + ?) / 86400000.0)::bigint as bucket, count(*) as calls
       from llm_calls where "${column}" = ?${r.sql}
       group by bucket order by bucket`,
      [offsetMs, value, ...r.args],
    )
    return rows.map((row) => ({ bucket: num(row.bucket), calls: num(row.calls) }))
  }

  llmUsageOfCompany(companyId: string, range?: { from?: number; to?: number }): Promise<LlmUsage> {
    return this.llmUsageBy('companyId', companyId, range)
  }

  llmUsageOfAccount(accountId: string, range?: { from?: number; to?: number }): Promise<LlmUsage> {
    return this.llmUsageBy('accountId', accountId, range)
  }

  /**
   * 平台统计的底表：按 (公司, 供应商, 模型) 汇总。
   *
   * 折成金额要按模型单价算，所以必须细到模型这一层再聚合——只按公司汇总的话
   * 拿不回每条调用用的是哪个模型，价就算不出来。
   * companyId 为 null 的是 owner 自己的调用，原样留着，由上层标成「平台」。
   *
   * **`cachedTokens` 必须一起汇总。** 它是 `promptTokens` 的子集，而缓存读的单价
   * 低得多（Anthropic 是输入价的十分之一）。少了这一列，上层只能把整个提示词按
   * 输入价算——一个 Bot 一条长会话、系统提示词稳定，正是缓存命中率最高的形态，
   * 于是缓存命中率越高、账面越虚，而 quotedUsd 是报给公司的价。
   */
  async llmUsageByCompanyModel(
    range?: { from?: number; to?: number },
    companyId?: string,
    accountId?: string,
  ): Promise<CompanyModelUsage[]> {
    const r = this.llmRangeSql(range)
    let where = `where 1=1${r.sql}`
    const args: (number | string)[] = [...r.args]
    if (companyId) {
      where += ' and "companyId" = ?'
      args.push(companyId)
    }
    // 员工自己那一屏按人过滤：同一段聚合，只是范围小一圈。
    if (accountId) {
      where += ' and "accountId" = ?'
      args.push(accountId)
    }
    /**
     * `unledgeredCalls`：这一组里**账本上根本没有对应行**的调用数。
     *
     * 金额只从账本来之后，「按 $0 收了」和「压根没记过账」在结果里长得一模一样，
     * 而后者恰恰是升级前所有历史调用的样子（回填脚本刻意不给模型调用补金额）。
     * 不把它数出来的话，翻上个月看到的是真实的 token 配一个 $0.00 加零句提示——
     * 那正是这套代码一直在防的「$0.00 被读成免费」。
     *
     * **账本先按 refId 收成一行再 join。** `usage_charges."refId"` 上只有一条普通索引，
     * 不是唯一约束——一次崩在 insertLlmCall 和记账之间、随后重算的调用，或者一条被重放
     * 的 outbox 上报，都会让同一个 refId 上挂两行账。直接 join 的话那一行 llm_calls 会
     * 被复制一份，calls 数成 2、每一列 token 翻倍，报给公司的 quotedUsd 跟着虚高。
     */
    const rows = await this.many(
      `select l."companyId", l.provider, l.model, count(*) as calls,
              coalesce(sum(l."promptTokens"), 0) as "promptTokens",
              coalesce(sum(l."completionTokens"), 0) as "completionTokens",
              coalesce(sum(l."cachedTokens"), 0) as "cachedTokens",
              coalesce(sum(l."cacheWriteTokens"), 0) as "cacheWriteTokens",
              coalesce(sum(case when u."refId" is null then 1 else 0 end), 0) as "unledgeredCalls",
              max(l."createdAt") as "lastAt"
       from llm_calls l left join ${LEDGER_BY_REF} u on u."refId" = l.id
       ${where.replace(/"(companyId|accountId|createdAt)"/g, 'l."$1"')}
       group by l."companyId", l.provider, l.model
       order by l."companyId", l.provider, l.model`,
      args,
    )
    return rows.map((row) => ({
      companyId: strOrNull(row.companyId),
      provider: str(row.provider),
      model: str(row.model),
      calls: num(row.calls),
      promptTokens: num(row.promptTokens),
      completionTokens: num(row.completionTokens),
      cachedTokens: num(row.cachedTokens),
      cacheWriteTokens: num(row.cacheWriteTokens),
      unledgeredCalls: num(row.unledgeredCalls),
      lastAt: numOrNull(row.lastAt),
    }))
  }

  // ── 连接器：安装、连接、调用流水。见 docs/connectors.md §10。────────

  async connectorInstalls(accountId: string): Promise<ConnectorInstall[]> {
    const rows = await this.many('select * from connector_installs where "accountId" = ? order by "createdAt"', [accountId])
    return rows.map(connectorInstallOf)
  }

  /** 一家公司谁装了什么。admin 那一屏唯一能看清攻击面的地方。 */
  async connectorInstallsOfCompany(companyId: string): Promise<ConnectorInstall[]> {
    const rows = await this.many('select * from connector_installs where "companyId" = ? order by "createdAt"', [companyId])
    return rows.map(connectorInstallOf)
  }

  async connectorInstall(connectorId: string, accountId: string): Promise<ConnectorInstall | undefined> {
    const r = await this.one('select * from connector_installs where "connectorId" = ? and "accountId" = ?', [connectorId, accountId])
    return r ? connectorInstallOf(r) : undefined
  }

  /**
   * 装一个。**已经装了就原样返回**，不报错也不重置工具开关——重复点「安装」是
   * 用户会做的事（网络慢、手抖），把它变成一次静默的配置重置就太狠了。
   */
  async installConnector(input: {
    connectorId: string
    accountId: string
    companyId: string
    /**
     * 装上默认开哪几个。空 = 写 `[]`，也就是全开。
     *
     * **`[]` = 全开这个口径不动。** 已经装好的那些存的就是 `[]`，改口径等于让现存
     * 用户的工具悄悄少掉一批。改的只是「新装的时候写什么进去」（docs/tool-search.md §2）。
     */
    enabledTools?: string[]
  }): Promise<ConnectorInstall> {
    const cur = await this.connectorInstall(input.connectorId, input.accountId)
    if (cur) return cur
    const now = Date.now()
    const row: ConnectorInstall = {
      id: randomUUID(),
      connectorId: input.connectorId,
      accountId: input.accountId,
      companyId: input.companyId,
      enabledTools: input.enabledTools ?? [],
      createdAt: now,
      updatedAt: now,
    }
    try {
      await this.run(
        'insert into connector_installs (id, "connectorId", "accountId", "companyId", "enabledTools", "createdAt", "updatedAt") values (?,?,?,?,?,?,?)',
        [row.id, row.connectorId, row.accountId, row.companyId, JSON.stringify(row.enabledTools), row.createdAt, row.updatedAt],
      )
    } catch (e) {
      // 两次点击撞在一起：唯一索引兜住，取回已有的那条。
      if (!isUniqueViolation(e)) throw e
      return (await this.connectorInstall(input.connectorId, input.accountId))!
    }
    return row
  }

  async setInstallTools(id: string, enabledTools: string[]): Promise<ConnectorInstall | undefined> {
    await this.run('update connector_installs set "enabledTools" = ?, "updatedAt" = ? where id = ?', [
      JSON.stringify(enabledTools),
      Date.now(),
      id,
    ])
    const r = await this.one('select * from connector_installs where id = ?', [id])
    return r ? connectorInstallOf(r) : undefined
  }

  async deleteConnectorInstall(id: string): Promise<void> {
    await this.run('delete from connector_installs where id = ?', [id])
  }

  async connectorConnection(id: string): Promise<ConnectorConnection | undefined> {
    const r = await this.one('select * from connector_connections where id = ?', [id])
    return r ? connectorConnectionOf(r) : undefined
  }

  /**
   * 这个账号能用的所有连接：自己的，加上本公司共用的那些。
   *
   * 合成工具表、`@` 选单、计费归属都从这一条出发——「能用哪些」只有一个来源，
   * 免得三处各写一遍再慢慢分叉。
   */
  async connectionsFor(accountId: string, companyId: string | null): Promise<ConnectorConnection[]> {
    const rows = companyId
      ? await this.many(
          'select * from connector_connections where ("accountId" = ? and scope = \'user\') or ("companyId" = ? and scope = \'company\') order by "createdAt"',
          [accountId, companyId],
        )
      : await this.many('select * from connector_connections where "accountId" = ? and scope = \'user\' order by "createdAt"', [accountId])
    return rows.map(connectorConnectionOf)
  }

  async connectionsOfCompany(companyId: string): Promise<ConnectorConnection[]> {
    const rows = await this.many('select * from connector_connections where "companyId" = ? order by "createdAt"', [companyId])
    return rows.map(connectorConnectionOf)
  }

  async insertConnectorConnection(input: {
    connectorId: string
    vendor: string
    scope: ConnectionScope
    label: string
    accountId: string | null
    companyId: string
    externalUserId: string
    mentionOnly?: boolean
  }): Promise<ConnectorConnection> {
    const now = Date.now()
    const row: ConnectorConnection = {
      id: randomUUID(),
      connectorId: input.connectorId,
      vendor: input.vendor,
      scope: input.scope,
      label: input.label,
      accountId: input.accountId,
      companyId: input.companyId,
      externalUserId: input.externalUserId,
      externalId: null,
      status: 'pending',
      mentionOnly: input.mentionOnly ?? false,
      lastError: null,
      connectedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.run(
      'insert into connector_connections (id, "connectorId", vendor, scope, label, "accountId", "companyId", "externalUserId", "externalId", status, "mentionOnly", "lastError", "connectedAt", "createdAt", "updatedAt") values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        row.id,
        row.connectorId,
        row.vendor,
        row.scope,
        row.label,
        row.accountId,
        row.companyId,
        row.externalUserId,
        row.externalId,
        row.status,
        row.mentionOnly,
        row.lastError,
        row.connectedAt,
        row.createdAt,
        row.updatedAt,
      ],
    )
    return row
  }

  async updateConnectorConnection(
    id: string,
    patch: {
      label?: string
      externalId?: string | null
      status?: ConnectionStatus
      mentionOnly?: boolean
      lastError?: string | null
      connectedAt?: number | null
    },
  ): Promise<ConnectorConnection | undefined> {
    const cur = await this.connectorConnection(id)
    if (!cur) return undefined
    const next = { ...cur, ...patch, updatedAt: Date.now() }
    await this.run(
      'update connector_connections set label=?, "externalId"=?, status=?, "mentionOnly"=?, "lastError"=?, "connectedAt"=?, "updatedAt"=? where id=?',
      [next.label, next.externalId, next.status, next.mentionOnly, next.lastError, next.connectedAt, next.updatedAt, id],
    )
    return next
  }

  async deleteConnectorConnection(id: string): Promise<void> {
    await this.run('delete from connector_connections where id = ?', [id])
  }

  async insertConnectorCall(input: {
    companyId: string | null
    accountId: string
    connectionId?: string | null
    botId?: string | null
    sessionId?: string | null
    vendor: string
    connector: string
    label?: string
    tool: string
    status: ConnectorCallStatus
    latencyMs?: number
    viaMention?: boolean
  }): Promise<ConnectorCall> {
    const row: ConnectorCall = {
      id: randomUUID(),
      companyId: input.companyId,
      accountId: input.accountId,
      connectionId: input.connectionId ?? null,
      botId: input.botId ?? null,
      sessionId: input.sessionId ?? null,
      vendor: input.vendor,
      connector: input.connector,
      label: input.label ?? '',
      tool: input.tool,
      status: input.status,
      // 钱不在这张表里了，见 docs/billing.md §2：账本（usage_charges）是唯一的钱。
      // 这两列留着是为了老行，新行恒为 0——统计要金额时按 refId 去账本上取。
      amountMicros: 0,
      bonusMicros: 0,
      latencyMs: Math.max(0, Math.trunc(input.latencyMs ?? 0)),
      viaMention: input.viaMention ?? false,
      createdAt: Date.now(),
    }
    await this.run(
      'insert into connector_calls (id, "companyId", "accountId", "connectionId", "botId", "sessionId", vendor, connector, label, tool, status, "amountMicros", "bonusMicros", "latencyMs", "viaMention", "createdAt") values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        row.id,
        row.companyId,
        row.accountId,
        row.connectionId,
        row.botId,
        row.sessionId,
        row.vendor,
        row.connector,
        row.label,
        row.tool,
        row.status,
        row.amountMicros,
        row.bonusMicros,
        row.latencyMs,
        row.viaMention,
        row.createdAt,
      ],
    )
    return row
  }

  /**
   * 连接器用量：一次查询给出四种切法。
   *
   * 按 (谁 / 连接器 / 工具 / 状态) 分别 group by，而不是把原始行拉回来在 JS 里算——
   * 一天几万行，拉回来就是拿内存换一句 SQL。
   *
   * 金额直接 `sum(amountMicros)`，**不按当前单价现折**：单价改过之后，历史账不能跟着
   * 一起变（docs/connectors.md §9）。
   */
  async connectorUsage(
    scope: { companyId?: string | null; accountId?: string },
    range?: { from?: number; to?: number },
  ): Promise<{
    total: { calls: number; amountMicros: number; lastAt: number | null }
    byStatus: { status: string; calls: number; amountMicros: number }[]
    byAccount: { accountId: string; calls: number; amountMicros: number; lastAt: number | null }[]
    byConnector: { connector: string; label: string; calls: number; amountMicros: number }[]
    byTool: { connector: string; tool: string; calls: number; amountMicros: number }[]
  }> {
    const where: string[] = ['1=1']
    const args: (string | number)[] = []
    if (scope.accountId) {
      where.push('"accountId" = ?')
      args.push(scope.accountId)
    }
    if (scope.companyId) {
      where.push('"companyId" = ?')
      args.push(scope.companyId)
    }
    if (range?.from != null) {
      where.push('"createdAt" >= ?')
      args.push(range.from)
    }
    if (range?.to != null) {
      where.push('"createdAt" <= ?')
      args.push(range.to)
    }
    // 维度在 connector_calls（label / tool / 状态），钱在账本，按 refId 接起来。
    const w = where.join(' and ').replace(/"(accountId|companyId|createdAt)"/g, 'c."$1"')
    // 账本先收成一行：refId 不是唯一键，同一次调用挂两行账会让 calls 和金额一起翻倍。
    const from =
      'from connector_calls c left join ' + LEDGER_BY_REF + ' u on u."refId" = c.id'
    const g = async (cols: string, group: string) =>
      this.many(
        `select ${cols}, count(*) as calls, coalesce(sum(u.micros), 0) as micros, max(c."createdAt") as "lastAt" ${from} where ${w} group by ${group}`,
        args,
      )

    const total = await this.one(
      `select count(*) as calls, coalesce(sum(u.micros), 0) as micros, max(c."createdAt") as "lastAt" ${from} where ${w}`,
      args,
    )
    const byStatus = await g('c.status', 'c.status')
    const byAccount = await g('c."accountId"', 'c."accountId"')
    const byConnector = await g('c.connector, c.label', 'c.connector, c.label')
    const byTool = await g('c.connector, c.tool', 'c.connector, c.tool')
    return {
      total: { calls: num(total?.calls ?? 0), amountMicros: num(total?.micros ?? 0), lastAt: numOrNull(total?.lastAt) },
      byStatus: byStatus.map((r) => ({ status: str(r.status), calls: num(r.calls), amountMicros: num(r.micros) })),
      byAccount: byAccount.map((r) => ({
        accountId: str(r.accountId),
        calls: num(r.calls),
        amountMicros: num(r.micros),
        lastAt: numOrNull(r.lastAt),
      })),
      byConnector: byConnector.map((r) => ({
        connector: str(r.connector),
        label: str(r.label || ''),
        calls: num(r.calls),
        amountMicros: num(r.micros),
      })),
      byTool: byTool.map((r) => ({
        connector: str(r.connector),
        tool: str(r.tool),
        calls: num(r.calls),
        amountMicros: num(r.micros),
      })),
    }
  }

  /** 平台统计的底表：按 (公司, 连接器) 汇总。owner 的调用 companyId 为 null，原样留着。 */
  async connectorUsageByCompany(range?: { from?: number; to?: number }): Promise<
    { companyId: string | null; connector: string; calls: number; amountMicros: number; lastAt: number | null }[]
  > {
    const where: string[] = ['1=1']
    const args: number[] = []
    if (range?.from != null) {
      where.push('"createdAt" >= ?')
      args.push(range.from)
    }
    if (range?.to != null) {
      where.push('"createdAt" <= ?')
      args.push(range.to)
    }
    // 同文件别处一样先按 refId 汇总再 join：直接 join 账本的话，一次调用落了两行账
    // （被拒一行 + 成功一行）会把 count(*) 也算成两次调用。
    const rows = await this.many(
      `select c."companyId", c.connector, count(*) as calls,
              coalesce(sum(u.micros), 0) as micros, max(c."createdAt") as "lastAt"
       from connector_calls c left join ${LEDGER_BY_REF} u on u."refId" = c.id
       where ${where.join(' and ').replace(/"createdAt"/g, 'c."createdAt"')}
       group by c."companyId", c.connector order by c."companyId", c.connector`,
      args,
    )
    return rows.map((r) => ({
      companyId: strOrNull(r.companyId),
      connector: str(r.connector),
      calls: num(r.calls),
      amountMicros: num(r.micros),
      lastAt: numOrNull(r.lastAt),
    }))
  }

  // ── 计费账本。**钱只在这张表里**，领域表只记事实。见 docs/billing.md。───

  async insertUsageCharge(input: {
    companyId: string | null
    accountId: string
    botId?: string | null
    sessionId?: string | null
    kind: ChargeKind
    subject: string
    status: ChargeStatus
    quantity?: Record<string, number>
    unitPrice?: Record<string, number>
    multiplier?: number
    amountMicros?: number
    bonusMicros?: number
    unpriced?: boolean
    refId?: string | null
    /**
     * 赠送桶的上限：本账期一共送了多少微元、账期从哪一刻起。给了它，`bonusMicros` 就
     * 不信调用方算的那个数，而是在**同一条 insert 里**按库里已扣的 sum 现算——
     * `least(amount, greatest(0, grant − sum_so_far))`。几十次并发落账各自读到同一份
     * 「还剩 $0.30」时，内存里算出来的 bonus 会把赠送桶扣穿，超出的那截本该走充值桶
     * （docs/billing.md §6.1 的公式）。要真挡住并发，调用方还得先拿 lockCompanyLedger。
     */
    bonusCap?: { grantMicros: number; since: number }
  }): Promise<UsageCharge> {
    const amount = Math.max(0, Math.trunc(input.amountMicros ?? 0))
    const row: UsageCharge = {
      id: randomUUID(),
      companyId: input.companyId,
      accountId: input.accountId,
      botId: input.botId ?? null,
      sessionId: input.sessionId ?? null,
      kind: input.kind,
      subject: input.subject,
      status: input.status,
      quantity: input.quantity ?? {},
      unitPrice: input.unitPrice ?? {},
      multiplier: input.multiplier ?? 1,
      amountMicros: amount,
      // 赠送承担的不可能超过总额——脏数据也不能算出负的「充值承担」（同 0005 的处理）。
      bonusMicros: Math.min(Math.max(0, Math.trunc(input.bonusMicros ?? 0)), amount),
      unpriced: input.unpriced === true,
      refId: input.refId ?? null,
      createdAt: Date.now(),
    }
    const cap = input.bonusCap && row.companyId ? input.bonusCap : undefined
    const bonusSql = cap
      ? 'least(?, greatest(0, ? - coalesce((select sum("bonusMicros") from usage_charges where "companyId" = ? and "createdAt" >= ?), 0)))'
      : '?'
    const bonusArgs = cap
      ? [amount, Math.max(0, Math.trunc(cap.grantMicros)), row.companyId, cap.since]
      : [row.bonusMicros]
    const r = await this.one(
      `insert into usage_charges (id, "companyId", "accountId", "botId", "sessionId", kind, subject, status, quantity, "unitPrice", multiplier, "amountMicros", "bonusMicros", unpriced, "refId", "createdAt")
       values (?,?,?,?,?,?,?,?,?,?,?,?,${bonusSql},?,?,?) returning "bonusMicros"`,
      [
        row.id,
        row.companyId,
        row.accountId,
        row.botId,
        row.sessionId,
        row.kind,
        row.subject,
        row.status,
        JSON.stringify(row.quantity),
        JSON.stringify(row.unitPrice),
        row.multiplier,
        row.amountMicros,
        ...bonusArgs,
        row.unpriced,
        row.refId,
        row.createdAt,
      ],
    )
    // 库里算出来的才是真扣掉的那份，调用方据此更新自己的余额记忆。
    if (r) row.bonusMicros = num(r.bonusMicros)
    return row
  }

  /**
   * 把清扫写下的**占位行**填成真的。**这是 docs/billing.md §2「金额写死不重算」唯一的
   * 例外**，开这个口子的理由和它的边界都在那里，动之前先读那一节。
   *
   * 场景只有一个：一次长回答跑过了 LLM_SETTLE_GRACE_MS，清扫（routines.ts 的
   * sweepUnsettledLlmCalls）先把它按 `failed` / 0 元 / unpriced 收了口；管家随后带着真实
   * 用量回来。幂等挡住的本该是「同一次调用收两笔钱」，可它连带着把**第一笔也钉成了 0**
   * ——这次调用真金白银发生过，账上却永远是 0，而且补不回来。
   *
   * 所以这里不是「改一笔已经成交的钱」，是**把一行从来没成交过的占位补成成交**。判据
   * 严到只认清扫写出来的那个形状，一格都不能松：
   *
   *   refId 指着这一次调用 · kind = llm · status = failed · unpriced · 金额 0 · 赠送 0 ·
   *   四项 token 全 0
   *
   * 少一格就可能把一笔真收过的钱盖掉：`denied`（闸拒的，是事实）、金额非 0 的（已经成交）、
   * 带用量的（已经结过）各自都会因为某一格对不上而落空。对不上就一行都不动、回 undefined，
   * 调用方退回原来的「只补 token」。
   *
   * **是 update 不是 delete + insert**：账本只增不改是这张表的性格，破一次口子也要破得最
   * 小——行还是那一行、id 还是那个 id，只是不再说假话。
   *
   * **只改一行，靠子查询挑 id，不靠 `refId` 直接筛。** `usage_charges."refId"` 上只有普通
   * 索引不是唯一约束，同一次调用挂两行账是这套代码明说过会发生的事（见 LEDGER_BY_REF
   * 那段注释，以及 routines.ts 里清扫那个「两边同时 insert」的竞态窗口）。以前无所谓：
   * 两行占位都是 0 元，`sum` 起来还是 0。可一旦补录按 `refId` 筛，两行会**各自**被填成
   * 全额——这次调用就收了两遍，而 `this.one()` 只看得见其中一行，余额记忆也只减一份。
   *
   * 外面那串判据（0 元、0 赠送、unpriced、failed）在挑中 id 之后**再查一遍**：两个并发的
   * 补录抢同一行时，第二个等到行锁之后重查会发现它已经不是 0 元了，回 0 行，退回 already。
   * 剩下那行没被选中的占位仍旧是 0 元，按 refId 汇总时和从前一样合成一行。
   *
   * `createdAt` 不动：那是清扫写下的时刻，比「管家什么时候想起来回来」更接近调用真实发生
   * 的时间，改它会把这笔钱挪到另一个账期去。
   *
   * 四项 token 那几刀转的是 `numeric` 不是 `bigint`：`kind = 'llm'` 和这几个转换之间没有
   * 求值顺序的保证，真扫到一行小数用量（上游报了 `1000.5`）时 `::bigint` 会当场报错，
   * 而 `::numeric` 认。
   */
  async fillPlaceholderCharge(input: {
    refId: string
    companyId: string | null
    status: ChargeStatus
    quantity?: Record<string, number>
    unitPrice?: Record<string, number>
    multiplier?: number
    amountMicros?: number
    unpriced?: boolean
    /** 同 insertUsageCharge。给了它，赠送那一份由库在同一条 SQL 里现算。 */
    bonusCap?: { grantMicros: number; since: number }
  }): Promise<UsageCharge | undefined> {
    const amount = Math.max(0, Math.trunc(input.amountMicros ?? 0))
    const cap = input.bonusCap && input.companyId ? input.bonusCap : undefined
    /**
     * 赠送那一份和 insertUsageCharge 同一条公式（sum 里数上自己这一行无所谓——占位行的
     * bonusMicros 一定是 0），外面多套一层 `case when u."createdAt" >= ?`。
     *
     * **那一刀是必须的。** 占位行是清扫写的，它的时间戳可能落在**上一个账期**里，而赠送
     * 桶的上限只数当期（`createdAt >= since`）。给一行上一账期的行记了 bonus，这笔 bonus
     * 不会进后续的 sum，赠送桶就被扣穿了。跨期的那种一律走充值桶。
     */
    const bonusSql = cap
      ? 'case when u."createdAt" >= ? then least(?, greatest(0, ? - coalesce((select sum(c."bonusMicros") from usage_charges c where c."companyId" = ? and c."createdAt" >= ?), 0))) else 0 end'
      : '?'
    const bonusArgs = cap
      ? [cap.since, amount, Math.max(0, Math.trunc(cap.grantMicros)), input.companyId, cap.since]
      : [0]
    const r = await this.one(
      `update usage_charges u set
         status = ?, quantity = ?, "unitPrice" = ?, multiplier = ?,
         "amountMicros" = ?, "bonusMicros" = ${bonusSql}, unpriced = ?
       where u.id = (
               select c2.id from usage_charges c2
                where c2."refId" = ? and c2.kind = 'llm' and c2.status = 'failed' and c2.unpriced = true
                  and c2."amountMicros" = 0 and c2."bonusMicros" = 0
                  and coalesce((c2.quantity->>'promptTokens')::numeric, 0) = 0
                  and coalesce((c2.quantity->>'completionTokens')::numeric, 0) = 0
                  and coalesce((c2.quantity->>'cachedTokens')::numeric, 0) = 0
                  and coalesce((c2.quantity->>'cacheWriteTokens')::numeric, 0) = 0
                order by c2."createdAt", c2.id
                limit 1
             )
         and u.kind = 'llm' and u.status = 'failed' and u.unpriced = true
         and u."amountMicros" = 0 and u."bonusMicros" = 0
       returning *`,
      [
        input.status,
        JSON.stringify(input.quantity ?? {}),
        JSON.stringify(input.unitPrice ?? {}),
        input.multiplier ?? 1,
        amount,
        ...bonusArgs,
        input.unpriced === true,
        input.refId,
      ],
    )
    return r ? usageChargeOf(r) : undefined
  }

  /**
   * 一家公司的账本锁。insertUsageCharge 的 `bonusCap` 是「读 sum 再写」——两次并发
   * 落账各自读到同一个 sum 仍会把赠送桶扣穿，所以落账那一条 insert 要排队。
   * **必须在 db.tx 里调**（同 lockExclusive）。按公司散列，不同公司互不等。
   */
  async lockCompanyLedger(companyId: string): Promise<void> {
    if (!this.txClient.getStore()) throw new Error('lockCompanyLedger 必须在 db.tx 里调——事务外的锁当场就放了')
    await this.one('select pg_advisory_xact_lock(hashtext(?::text))', [`usage_charges:${companyId}`])
  }

  /**
   * 这家公司在两个桶上各花了多少（微元）。**三条计费路一起算**——账本是唯一的钱。
   *
   * - **套餐赠送**跟着账期，到期作废，所以只统计 `bonusSince`（当前账期起点）之后的。
   * - **充值**不过期，累计全部历史。
   *
   * 合成一个数的话，套餐一到期，它已经花掉的部分会从充值余额上再扣一遍（见迁移 0005）。
   */
  async chargeSpend(companyId: string, bonusSince: number | null): Promise<{ bonusMicros: number; topupMicros: number }> {
    const topup = await this.one(
      'select coalesce(sum("amountMicros" - "bonusMicros"), 0) as spent from usage_charges where "companyId" = ?',
      [companyId],
    )
    const bonus =
      bonusSince == null
        ? undefined
        : await this.one(
            'select coalesce(sum("bonusMicros"), 0) as spent from usage_charges where "companyId" = ? and "createdAt" >= ?',
            [companyId, bonusSince],
          )
    return { bonusMicros: num(bonus?.spent ?? 0), topupMicros: num(topup?.spent ?? 0) }
  }

  /** 从某个时刻起一共扣了多少微元。账单屏的「本期已扣」用它。 */
  async chargeSpentSince(companyId: string, since: number): Promise<number> {
    const r = await this.one(
      'select coalesce(sum("amountMicros"), 0) as spent from usage_charges where "companyId" = ? and "createdAt" >= ?',
      [companyId, since],
    )
    return num(r?.spent ?? 0)
  }

  async usageCharge(id: string): Promise<UsageCharge | undefined> {
    const r = await this.one('select * from usage_charges where id = ?', [id])
    return r ? usageChargeOf(r) : undefined
  }

  /**
   * 计费明细一页。游标是 `${createdAt}:${id}`，和会话索引那套一样（routes/sessions.ts）。
   *
   * **必须接口分页。** 平台那四张长表是前端切页的（一次拉齐、切的是已经拿到的数据），
   * 理由是「问题不在拉不动，在一屏塞不下」。账本不一样：一家公司一天就能产生几千行，
   * 一次拉齐是真的拉不动。
   */
  async listUsageCharges(filter: {
    companyId?: string
    accountId?: string
    botId?: string
    kind?: ChargeKind
    status?: ChargeStatus
    from?: number
    to?: number
    limit?: number
    before?: { createdAt: number; id: string }
  }): Promise<UsageCharge[]> {
    let sql = 'select * from usage_charges where 1=1'
    const args: unknown[] = []
    // companyId 为 null 的是 owner 自己的调用。传了 companyId 就只看这一家，
    // 不传就是全平台（含平台自己那些）。
    if (filter.companyId) {
      sql += ' and "companyId" = ?'
      args.push(filter.companyId)
    }
    if (filter.accountId) {
      sql += ' and "accountId" = ?'
      args.push(filter.accountId)
    }
    if (filter.botId) {
      sql += ' and "botId" = ?'
      args.push(filter.botId)
    }
    if (filter.kind) {
      sql += ' and kind = ?'
      args.push(filter.kind)
    }
    if (filter.status) {
      sql += ' and status = ?'
      args.push(filter.status)
    }
    if (filter.from != null) {
      sql += ' and "createdAt" >= ?'
      args.push(filter.from)
    }
    if (filter.to != null) {
      sql += ' and "createdAt" <= ?'
      args.push(filter.to)
    }
    if (filter.before) {
      // 同一毫秒里可能有好几行，光比时间会漏掉或重复。带上 id 当第二把钥匙。
      sql += ' and ("createdAt", id) < (?, ?)'
      args.push(filter.before.createdAt, filter.before.id)
    }
    const limit = Math.min(Math.max(Math.trunc(filter.limit ?? CHARGE_PAGE_DEFAULT), 1), CHARGE_PAGE_MAX + 1)
    sql += ' order by "createdAt" desc, id desc limit ?'
    args.push(limit)
    return (await this.many(sql, args)).map(usageChargeOf)
  }

  /**
   * 账本汇总：按公司 × 类型。统计屏用它。
   *
   * **只 sum，不按当前单价重算**——金额在写行那一刻就定死了（docs/billing.md §2）。
   *
   * 「金额算不出来」的那些行分两格报，**不要再合回一格**：`unpricedCalls` 是目录里没有
   * 单价，owner 去配置页补上就好了；`unmeteredCalls` 是有单价但结算时没拿到用量（上游
   * 流里一个 usage 字段都没回、管家没回来结算被清扫收了口），那一次的用量已经没了，
   * 补不回来。合成一格的表现是统计屏只能挑一句话说，而这两句话要人办的事正好相反。
   */
  async chargeUsageBy(
    columns: ('companyId' | 'accountId' | 'botId' | 'kind' | 'subject')[],
    range?: { from?: number; to?: number },
    filter?: { companyId?: string; accountId?: string },
  ): Promise<{ companyId: string | null; accountId: string; botId: string | null; kind: string; subject: string; calls: number; amountMicros: number; bonusMicros: number; costMicros: number; unpricedCalls: number; unmeteredCalls: number; lastAt: number | null }[]> {
    const cols = columns.map((c) => `"${c}"`).join(', ')
    const r = this.llmRangeSql(range)
    let where = `where 1=1${r.sql}`
    const args: unknown[] = [...r.args]
    if (filter?.companyId) {
      where += ' and "companyId" = ?'
      args.push(filter.companyId)
    }
    if (filter?.accountId) {
      where += ' and "accountId" = ?'
      args.push(filter.accountId)
    }
    const rows = await this.many(
      `select ${cols}, count(*) as calls,
              coalesce(sum("amountMicros"), 0) as "amountMicros",
              coalesce(sum("bonusMicros"), 0) as "bonusMicros",
              -- 原价是**倒推**的：成交额 ÷ 当时的倍率。账本存倍率而不是原价，因为
              -- 倍率只有一个数、原价有四项；除法在这里做，历史行各按各的倍率还原。
              coalesce(sum("amountMicros" / greatest(multiplier, 0.0001)), 0) as "costMicros",
              -- unpriced 是「金额算不出来」，两种原因共用这一格，事后要分开报，因为
              -- 一种现在就能修、另一种修不了（见上面那段注释）。分界是行上那份单价
              -- 快照空不空：查不到单价时 quote 存的是空对象，查得到但没拿到用量时存
              -- 的是四项齐全的快照（lib/meter.ts 的 quote、lib/llm-billing.ts 的 settle）。
              coalesce(sum(case when unpriced and "unitPrice" = '{}'::jsonb then 1 else 0 end), 0) as "unpricedCalls",
              coalesce(sum(case when unpriced and "unitPrice" <> '{}'::jsonb then 1 else 0 end), 0) as "unmeteredCalls",
              max("createdAt") as "lastAt"
       from usage_charges ${where}
       group by ${cols}`,
      args,
    )
    return rows.map((row) => ({
      companyId: columns.includes('companyId') ? strOrNull(row.companyId) : null,
      accountId: columns.includes('accountId') ? str(row.accountId) : '',
      // 模型那条路还填不上 botId（`/v1/*` 收到的请求里没有会话这个概念，见 lib/meter.ts），
      // 所以这一维只覆盖填得上的那些调用。null 原样留着，由上层决定怎么标。
      botId: columns.includes('botId') ? strOrNull(row.botId) : null,
      kind: columns.includes('kind') ? str(row.kind) : '',
      subject: columns.includes('subject') ? str(row.subject) : '',
      calls: num(row.calls),
      amountMicros: num(row.amountMicros),
      bonusMicros: num(row.bonusMicros),
      costMicros: Math.round(num(row.costMicros)),
      unpricedCalls: num(row.unpricedCalls),
      unmeteredCalls: num(row.unmeteredCalls),
      lastAt: numOrNull(row.lastAt),
    }))
  }

  // ── 分组。全体成员是算出来的，不进这张表。──────────────────────────

  async groupsOf(companyId: string): Promise<Group[]> {
    const rows = await this.many('select * from groups where "companyId" = ? order by "createdAt"', [companyId])
    return rows.map(groupOf)
  }

  async group(id: string): Promise<Group | undefined> {
    const r = await this.one('select * from groups where id = ?', [id])
    return r ? groupOf(r) : undefined
  }

  async insertGroup(input: {
    companyId: string
    name: string
    desc?: string
    icon?: string
    role: 'admin' | 'member'
    members?: string[]
    agents?: string[]
  }): Promise<Group> {
    const row: Group = {
      id: randomUUID(),
      companyId: input.companyId,
      name: input.name,
      desc: input.desc ?? '',
      icon: input.icon || 'chat',
      role: input.role,
      members: input.members ?? [],
      agents: input.agents ?? [],
      createdAt: Date.now(),
    }
    await this.run(
      'insert into groups (id, "companyId", name, "desc", icon, role, members, agents, "createdAt") values (?,?,?,?,?,?,?,?,?)',
      [
        row.id,
        row.companyId,
        row.name,
        row.desc,
        row.icon,
        row.role,
        JSON.stringify(row.members),
        JSON.stringify(row.agents),
        row.createdAt,
      ],
    )
    return row
  }

  async updateGroup(
    id: string,
    patch: Partial<Pick<Group, 'name' | 'desc' | 'icon' | 'role' | 'members' | 'agents'>>,
  ): Promise<Group> {
    const cur = await this.group(id)
    if (!cur) throw new Error('分组不存在')
    const next: Group = {
      ...cur,
      name: patch.name !== undefined ? patch.name : cur.name,
      desc: patch.desc !== undefined ? patch.desc : cur.desc,
      icon: patch.icon !== undefined ? patch.icon : cur.icon,
      role: patch.role ?? cur.role,
      members: patch.members !== undefined ? patch.members : cur.members,
      agents: patch.agents !== undefined ? patch.agents : cur.agents,
    }
    await this.run('update groups set name=?, "desc"=?, icon=?, role=?, members=?, agents=? where id=?', [
      next.name,
      next.desc,
      next.icon,
      next.role,
      JSON.stringify(next.members),
      JSON.stringify(next.agents),
      id,
    ])
    return next
  }

  async deleteGroup(id: string): Promise<boolean> {
    return (await this.run('delete from groups where id = ?', [id])) > 0
  }

  // ── 邀请 ──────────────────────────────────────────────────────────────

  async putInvite(row: Invite): Promise<Invite> {
    await this.run(
      'insert into invites (id, "userId", "companyId", "createdBy", "createdAt", "expiresAt") values (?,?,?,?,?,?)',
      [row.id, row.userId, row.companyId, row.createdBy, row.createdAt, row.expiresAt],
    )
    return row
  }

  async invite(id: string): Promise<Invite | undefined> {
    const r = await this.one('select * from invites where id = ?', [id])
    return r ? inviteOf(r) : undefined
  }

  async deleteInvitesForUser(userId: string): Promise<void> {
    await this.run('delete from invites where "userId" = ?', [userId])
  }

  async deleteInvite(id: string): Promise<void> {
    await this.run('delete from invites where id = ?', [id])
  }

  // ── 套餐 ──────────────────────────────────────────────────────────────

  /** 套餐和到期时间是可选补丁：不传就保持原样，传 null 才是清空。 */
  async upsertPlan(
    companyId: string,
    seats: number,
    patch: { skuId?: string | null; expiresAt?: number | null } = {},
  ): Promise<Plan> {
    const now = Date.now()
    const cur = await this.plan(companyId)
    const next: Plan = {
      companyId,
      seats,
      skuId: patch.skuId === undefined ? (cur?.skuId ?? null) : patch.skuId,
      expiresAt: patch.expiresAt === undefined ? (cur?.expiresAt ?? null) : patch.expiresAt,
      updatedAt: now,
    }
    await this.run(
      'insert into plans ("companyId", seats, "skuId", "expiresAt", "updatedAt") values (?,?,?,?,?) on conflict ("companyId") do update set seats=excluded.seats, "skuId"=excluded."skuId", "expiresAt"=excluded."expiresAt", "updatedAt"=excluded."updatedAt"',
      [companyId, next.seats, next.skuId, next.expiresAt, next.updatedAt],
    )
    return next
  }

  async plan(companyId: string): Promise<Plan | undefined> {
    const r = await this.one('select * from plans where "companyId" = ?', [companyId])
    return r ? planOf(r) : undefined
  }

  // ── 套餐 SKU（价目表）────────────────────────────────────────────────

  async planSkus(): Promise<PlanSku[]> {
    const rows = await this.many('select * from plan_skus order by "amountMils", "createdAt"')
    return rows.map(planSkuOf)
  }

  async planSku(id: string): Promise<PlanSku | undefined> {
    const r = await this.one('select * from plan_skus where id = ?', [id])
    return r ? planSkuOf(r) : undefined
  }

  /** 按名字找。中英两列都查——重名要挡的是「界面上看着一样」，不分哪一列。 */
  async planSkuByName(name: string): Promise<PlanSku | undefined> {
    const r = await this.one('select * from plan_skus where name = ? or ("nameEn" <> \'\' and "nameEn" = ?)', [name, name])
    return r ? planSkuOf(r) : undefined
  }

  async insertPlanSku(input: {
    name: string
    nameEn?: string
    amountMils: number
    seats: number
    period?: PlanPeriod
    bonusMils?: number
  }): Promise<PlanSku> {
    const now = Date.now()
    const row: PlanSku = {
      id: randomUUID(),
      name: input.name,
      nameEn: input.nameEn ?? '',
      amountMils: input.amountMils,
      seats: input.seats,
      period: input.period ?? 'month',
      bonusMils: input.bonusMils ?? 0,
      createdAt: now,
      updatedAt: now,
    }
    await this.run(
      'insert into plan_skus (id, name, "nameEn", "amountMils", seats, period, "bonusMils", "createdAt", "updatedAt") values (?,?,?,?,?,?,?,?,?)',
      [row.id, row.name, row.nameEn, row.amountMils, row.seats, row.period, row.bonusMils, row.createdAt, row.updatedAt],
    )
    return row
  }

  /** 只改传进来的字段。套餐不存在返回 undefined，由上层决定报 404 还是别的。 */
  async updatePlanSku(
    id: string,
    patch: { name?: string; nameEn?: string; amountMils?: number; seats?: number; period?: PlanPeriod; bonusMils?: number },
  ): Promise<PlanSku | undefined> {
    const cur = await this.planSku(id)
    if (!cur) return undefined
    const r = await this.one(
      'update plan_skus set name=?, "nameEn"=?, "amountMils"=?, seats=?, period=?, "bonusMils"=?, "updatedAt"=? where id=? returning *',
      [
        patch.name ?? cur.name,
        patch.nameEn ?? cur.nameEn,
        patch.amountMils ?? cur.amountMils,
        patch.seats ?? cur.seats,
        patch.period ?? cur.period,
        patch.bonusMils ?? cur.bonusMils,
        Date.now(),
        id,
      ],
    )
    return r ? planSkuOf(r) : undefined
  }

  // ── 订单 ──────────────────────────────────────────────────────────────

  async planOrders(): Promise<PlanOrder[]> {
    const rows = await this.many('select * from plan_orders order by "startAt" desc, "createdAt" desc')
    return rows.map(planOrderOf)
  }

  async planOrder(id: string): Promise<PlanOrder | undefined> {
    const r = await this.one('select * from plan_orders where id = ?', [id])
    return r ? planOrderOf(r) : undefined
  }

  async planOrdersOfCompany(companyId: string): Promise<PlanOrder[]> {
    const rows = await this.many('select * from plan_orders where "companyId" = ? order by "startAt" desc', [companyId])
    return rows.map(planOrderOf)
  }

  async insertPlanOrder(input: Omit<PlanOrder, 'id' | 'createdAt' | 'updatedAt'>): Promise<PlanOrder> {
    const now = Date.now()
    const row: PlanOrder = { ...input, id: randomUUID(), createdAt: now, updatedAt: now }
    await this.run(
      `insert into plan_orders
       (id, "companyId", kind, note, "planId", "planName", "planNameEn", period, seats, "amountMils", "bonusMils", "startAt", "endAt", "payStatus", "createdAt", "updatedAt")
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        row.id, row.companyId, row.kind, row.note, row.planId, row.planName, row.planNameEn, row.period,
        row.seats, row.amountMils, row.bonusMils, row.startAt, row.endAt, row.payStatus, row.createdAt, row.updatedAt,
      ],
    )
    return row
  }

  /** 只改传进来的字段。订单不存在返回 undefined。 */
  async updatePlanOrder(id: string, patch: Partial<Omit<PlanOrder, 'id' | 'createdAt'>>): Promise<PlanOrder | undefined> {
    const cur = await this.planOrder(id)
    if (!cur) return undefined
    const next = { ...cur, ...patch, updatedAt: Date.now() }
    const r = await this.one(
      `update plan_orders set "companyId"=?, kind=?, note=?, "planId"=?, "planName"=?, "planNameEn"=?, period=?,
       seats=?, "amountMils"=?, "bonusMils"=?, "startAt"=?, "endAt"=?, "payStatus"=?, "updatedAt"=? where id=? returning *`,
      [
        next.companyId, next.kind, next.note, next.planId, next.planName, next.planNameEn, next.period,
        next.seats, next.amountMils, next.bonusMils, next.startAt, next.endAt, next.payStatus, next.updatedAt, id,
      ],
    )
    return r ? planOrderOf(r) : undefined
  }

  /**
   * 此刻生效的那条**套餐**订单：已付款、开始时间已到、结束时间未过。充值单不参与订阅。
   * 未付款的订单只是一张待收的账单，不算订阅——钱没到就别开服务。
   * 有重叠就取开始得最晚的一条——续约提前下单时，新订单一生效就顶掉旧的。
   */
  async activePaidOrder(companyId: string, at = Date.now()): Promise<PlanOrder | undefined> {
    const r = await this.one(
      `select * from plan_orders
       where "companyId" = ? and kind = 'plan' and "payStatus" = 'paid' and "startAt" <= ? and "endAt" > ?
       order by "startAt" desc limit 1`,
      [companyId, at, at],
    )
    return r ? planOrderOf(r) : undefined
  }

  /**
   * 把公司的订阅拉齐到订单：**已付款且在期内**的那条订单说了算，没有就把套餐清掉。
   * 未付款的订单只是一张待收的账单，不写订阅。
   * 席位不缩到已有账号数以下——订单少给了席位也不能把人挤掉，先按现有人数保住。
   *
   * 「清掉」也包括席位：订单给的席位跟订单一起走，到期后只按现有人数保住，不能让一份
   * 过期订阅把席位永远留在那里。但平台管理员可以不经订单直接给席位（skuId 本来就是空），
   * 那不是订单算出来的，这里不动。
   *
   * 下单/改单之后调它；起进程时也对一遍全量，把「订单到期了没人碰」和历史规则留下的
   * 脏值收干净——plans 里那几列是订单算出来的结果，不是另一份可以自己漂的真相。
   */
  async syncPlanFromOrders(companyId: string): Promise<void> {
    const active = await this.activePaidOrder(companyId)
    const used = await this.accountCount(companyId)
    const cur = await this.plan(companyId)
    if (!active) {
      if (cur?.skuId == null && cur?.expiresAt == null && cur) return
      const seats = cur?.skuId != null ? Math.max(used, 1) : (cur?.seats ?? Math.max(used, 1))
      await this.upsertPlan(companyId, seats, { skuId: null, expiresAt: null })
      return
    }
    await this.upsertPlan(companyId, Math.max(active.seats, used), { skuId: active.planId, expiresAt: active.endAt })
  }

  /** 起进程时对一遍所有公司的订阅。返回被改动的公司数，只为在日志里说一声。 */
  async syncAllPlansFromOrders(): Promise<number> {
    let changed = 0
    for (const c of await this.companies()) {
      const before = await this.plan(c.id)
      await this.syncPlanFromOrders(c.id)
      const after = await this.plan(c.id)
      if (before?.skuId !== after?.skuId || before?.expiresAt !== after?.expiresAt || before?.seats !== after?.seats) changed++
    }
    return changed
  }

  // ── 单独充值 ──────────────────────────────────────────────────────────

  async topups(): Promise<Topup[]> {
    const rows = await this.many('select * from topups order by "createdAt" desc')
    return rows.map(topupOf)
  }

  async topupsOfCompany(companyId: string): Promise<Topup[]> {
    const rows = await this.many('select * from topups where "companyId" = ? order by "createdAt" desc', [companyId])
    return rows.map(topupOf)
  }

  /** 充值总额。充值不过期，所以是从头累加，不按时间窗口切。 */
  async topupTotal(companyId: string): Promise<number> {
    const r = await this.one('select coalesce(sum("amountMils"), 0) as total from topups where "companyId" = ?', [companyId])
    return num(r?.total)
  }

  async topupByOrder(orderId: string): Promise<Topup | undefined> {
    const r = await this.one('select * from topups where "orderId" = ?', [orderId])
    return r ? topupOf(r) : undefined
  }

  async insertTopup(input: {
    companyId: string
    amountMils: number
    orderId?: string | null
    note?: string
    createdBy?: string | null
  }): Promise<Topup> {
    const row: Topup = {
      id: randomUUID(),
      companyId: input.companyId,
      orderId: input.orderId ?? null,
      amountMils: input.amountMils,
      note: input.note ?? '',
      createdBy: input.createdBy ?? null,
      createdAt: Date.now(),
    }
    await this.run(
      'insert into topups (id, "companyId", "orderId", "amountMils", note, "createdBy", "createdAt") values (?,?,?,?,?,?,?)',
      [row.id, row.companyId, row.orderId, row.amountMils, row.note, row.createdBy, row.createdAt],
    )
    return row
  }

  async updateTopup(id: string, patch: Partial<Pick<Topup, 'companyId' | 'amountMils' | 'note'>>): Promise<Topup | undefined> {
    const cur = await this.one('select * from topups where id = ?', [id])
    if (!cur) return undefined
    const next = { ...topupOf(cur), ...patch }
    const r = await this.one(
      'update topups set "companyId"=?, "amountMils"=?, note=? where id=? returning *',
      [next.companyId, next.amountMils, next.note, id],
    )
    return r ? topupOf(r) : undefined
  }

  /** 充值单退回未付款时，把开出去的那条充值记录撤掉——余额跟着掉回去。 */
  async deleteTopup(id: string): Promise<void> {
    await this.run('delete from topups where id = ?', [id])
  }

  // ── 账单 ──────────────────────────────────────────────────────────────

  async invoicesOfCompany(companyId: string): Promise<Invoice[]> {
    const rows = await this.many('select * from invoices where "companyId" = ? order by "periodStart" desc', [companyId])
    return rows.map(invoiceOf)
  }

  async invoiceByOrder(orderId: string): Promise<Invoice | undefined> {
    const r = await this.one('select * from invoices where "orderId" = ?', [orderId])
    return r ? invoiceOf(r) : undefined
  }

  async insertInvoice(input: Omit<Invoice, 'id' | 'createdAt' | 'updatedAt'>): Promise<Invoice> {
    const now = Date.now()
    const row: Invoice = { ...input, id: randomUUID(), createdAt: now, updatedAt: now }
    await this.run(
      `insert into invoices
       (id, "companyId", "orderId", "planName", "planNameEn", "amountMils", "periodStart", "periodEnd", status, "paidAt", "createdAt", "updatedAt")
       values (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        row.id, row.companyId, row.orderId, row.planName, row.planNameEn, row.amountMils,
        row.periodStart, row.periodEnd, row.status, row.paidAt, row.createdAt, row.updatedAt,
      ],
    )
    return row
  }

  async updateInvoice(id: string, patch: Partial<Omit<Invoice, 'id' | 'createdAt'>>): Promise<Invoice | undefined> {
    const cur = await this.one('select * from invoices where id = ?', [id])
    if (!cur) return undefined
    const next = { ...invoiceOf(cur), ...patch, updatedAt: Date.now() }
    const r = await this.one(
      `update invoices set "companyId"=?, "orderId"=?, "planName"=?, "planNameEn"=?, "amountMils"=?,
       "periodStart"=?, "periodEnd"=?, status=?, "paidAt"=?, "updatedAt"=? where id=? returning *`,
      [
        next.companyId, next.orderId, next.planName, next.planNameEn, next.amountMils,
        next.periodStart, next.periodEnd, next.status, next.paidAt, next.updatedAt, id,
      ],
    )
    return r ? invoiceOf(r) : undefined
  }

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
      // 新登记的机器当然在册。墓碑只由 markMachineRemoved 立。
      removedAt: null as number | null,
    }
    for (let i = 0; i < 8; i++) {
      const row: Machine = { ...base, token: randomMachineToken() }
      try {
        await this.run(
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
        await this.run('update machines set token = ? where id = ?', [randomMachineToken(), id])
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
   * 那一下正是把「你被移除了」交给它的唯一机会。调用方（心跳）要自己判 `removedAt`。
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
    }
    await this.run(
      'update machines set host=?, "directUrl"=?, "companyId"=?, "lastHeartbeatAt"=?, "pairedAt"=?, "managerVersion"=?, protocol=?, "lastError"=?, arch=?, "desiredManagerVersion"=?, "maxAccounts"=?, timezone=?, "currentTimezone"=?, telemetry=?, "telemetryAt"=?, "logCapMb"=? where id=?',
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
  /** 这台机器是不是这家公司配对进来的。认领只认自己配对的那台。 */
  async machinePairedBy(machineId: string, companyId: string): Promise<boolean> {
    const r = await this.one(
      'select 1 as n from machine_pairings where "machineId" = ? and "companyId" = ? limit 1',
      [machineId, companyId],
    )
    return Boolean(r)
  }

  async expireMachinePairings(companyId: string, now: number): Promise<void> {
    await this.run('update machine_pairings set "expiresAt" = ? where "companyId" = ? and "usedAt" is null and "expiresAt" > ?', [
      now,
      companyId,
      now,
    ])
  }

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
         "deployPhase", "deployStartedAt"
       ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
         "deployStartedAt"=excluded."deployStartedAt"`,
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
      ],
    )
    return (await this.seatRuntime(row.accountId, row.botId))!
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
      // 分组按 jsonb 反查，**不按公司**：全局 Bot 可能被好几家公司各自编进分组，
      // 只扫它自己那家会把别家的引用留成一个指向不存在 Bot 的 id。
      const rows = await this.many('select * from groups where agents @> ?::jsonb', [JSON.stringify([botId])])
      for (const g of rows.map(groupOf)) {
        await this.updateGroup(g.id, { agents: g.agents.filter((a) => a !== botId) })
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
      'insert into bot_releases (kind, version, sha256, size, "createdAt", note, url) values (?,?,?,?,?,?,?)',
      [row.kind, row.version, row.sha256, row.size, row.createdAt, row.note, row.url],
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

  /** 这家公司里全部的私有档，不分主人。界面上「Bot 自己写的」那一栏读它。 */
  async companySeatSkills(companyId: string): Promise<CatalogItem[]> {
    const rows = await this.many(
      `select * from catalog_items where kind = 'skill' and scope = 'user' and "companyId" = ?
       order by "updatedAt" desc`,
      [companyId],
    )
    return rows.map(catalogOf)
  }

  /** 这颗 Bot 的私有档，只有它自己那一档。界面上那一栏和条数上限都读它。 */
  async seatSkills(accountId: string, botId: string): Promise<CatalogItem[]> {
    const rows = await this.many(
      `select * from catalog_items where kind = 'skill' and scope = 'user'
         and "accountId" = ? and "botId" = ? order by "updatedAt" desc`,
      [accountId, botId],
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

  /** 某个员工自己建了几个。配额挡在建之前，见 routes/runtime.ts。 */
  async countUserBots(accountId: string): Promise<number> {
    const r = await this.one(
      'select count(*)::int as n from catalog_items where kind = \'bot\' and scope = \'user\' and "accountId" = ?',
      [accountId],
    )
    return Number((r as { n?: number } | undefined)?.n ?? 0)
  }

  async markBotDeleting(botId: string, deletingAt: number | null): Promise<CatalogItem | undefined> {
    const r = await this.one(
      'update catalog_items set "deletingAt" = ?, "updatedAt" = ? where id = ? and kind = \'bot\' returning *',
      [deletingAt, Date.now(), botId],
    )
    return r ? catalogOf(r) : undefined
  }

  async deleteCatalog(id: string): Promise<void> {
    await this.run('delete from catalog_items where id = ?', [id])
  }

  // ── 密钥 ──────────────────────────────────────────────────────────────

  async insertCredential(input: { companyId: string; provider: string; secret: string }): Promise<Credential> {
    const now = Date.now()
    const row: Credential = {
      id: randomUUID(),
      companyId: input.companyId,
      provider: input.provider,
      secret: input.secret,
      createdAt: now,
      updatedAt: now,
    }
    await this.run(
      'insert into credentials (id, "companyId", provider, secret, "createdAt", "updatedAt") values (?,?,?,?,?,?)',
      [row.id, row.companyId, row.provider, row.secret, row.createdAt, row.updatedAt],
    )
    return row
  }

  /**
   * 公司密钥那一组方法**全撤了**：按公司查的（credentialsOf / credentialByProvider）、
   * 写的（upsertCredential）、删的（deleteCredentialByProvider），和按 id 走的那三个
   * （credential / updateCredential / deleteCredential）。供应商只由平台配，没有任何
   * 一条路再读写 `credentials` 这张表。
   *
   * 表和历史数据留着（见 liftCompanySettingsToPlatform 下面那段），但别为了「顺手」
   * 把这几个方法加回来——它们一回来，下一步就是路由。
   */

  async platformCredential(provider: string): Promise<Credential | undefined> {
    const r = await this.one('select * from platform_credentials where provider = ?', [provider])
    if (!r) return undefined
    return {
      id: `platform:${str(r.provider)}`,
      companyId: '',
      provider: str(r.provider),
      secret: str(r.secret),
      createdAt: num(r.createdAt),
      updatedAt: num(r.updatedAt),
    }
  }

  async upsertPlatformCredential(provider: string, secret: string): Promise<Credential> {
    const now = Date.now()
    await this.run(
      'insert into platform_credentials (provider, secret, "createdAt", "updatedAt") values (?,?,?,?) on conflict (provider) do update set secret=excluded.secret, "updatedAt"=excluded."updatedAt"',
      [provider, secret, now, now],
    )
    return (await this.platformCredential(provider))!
  }

  async platformCredentials(): Promise<Credential[]> {
    const rows = await this.many('select * from platform_credentials order by provider')
    return rows.map((r) => ({
      id: `platform:${str(r.provider)}`,
      companyId: '',
      provider: str(r.provider),
      secret: str(r.secret),
      createdAt: num(r.createdAt),
      updatedAt: num(r.updatedAt),
    }))
  }

  async deletePlatformCredential(provider: string): Promise<void> {
    await this.run('delete from platform_credentials where provider = ?', [provider])
  }

  // ── 审计 ──────────────────────────────────────────────────────────────

  async audit(input: {
    companyId: string
    accountId?: string | null
    action: string
    detail?: unknown
  }): Promise<AuditEvent> {
    const row: AuditEvent = {
      id: randomUUID(),
      companyId: input.companyId,
      accountId: input.accountId ?? null,
      action: input.action,
      detail: input.detail ?? {},
      createdAt: Date.now(),
    }
    await this.run(
      'insert into audit_events (id, "companyId", "accountId", action, detail, "createdAt") values (?,?,?,?,?,?)',
      [row.id, row.companyId, row.accountId, row.action, JSON.stringify(row.detail), row.createdAt],
    )
    return row
  }

  async auditsOf(companyId: string, limit = 100): Promise<AuditEvent[]> {
    const rows = await this.many('select * from audit_events where "companyId" = ? order by "createdAt" desc limit ?', [
      companyId,
      limit,
    ])
    return rows.map(auditOf)
  }

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

  async updateChannelEvent(id: string, patch: {
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
  }): Promise<void> {
    const cur = await this.channelEvent(id)
    if (!cur) return
    const next = { ...cur, ...patch, updatedAt: Date.now() }
    await this.run(
      `update channel_events set status=?, attempts=?, "nextTryAt"=?, "leaseUntil"=?, "leaseToken"=?, "sessionId"=?, reply=?, files=?, handoffs=?,
       "lastError"=?, "updatedAt"=?, "deliveredAt"=? where id=?`,
      [next.status, next.attempts, next.nextTryAt, next.status === 'processing' ? next.leaseUntil : null,
        next.status === 'processing' ? next.leaseToken : '', next.sessionId, next.reply,
        JSON.stringify(next.files), JSON.stringify(next.handoffs), next.lastError, next.updatedAt, next.deliveredAt, id],
    )
  }

  // ── 会话索引。只存指针，不存 user/message 或 assistant/message 正文。──

  /**
   * 一行会话索引。**id 由席位给**，这边只 upsert——同 upsertHandoff。
   *
   * **更新那一支要认账号和公司。** `sessionId` 是上报方给的，可以是任何字符串，而一把
   * 席位票只代表一个账号；不带这两条判据的话，一台被拿下的席位报一个别人的 sessionId
   * 就能把那一行改到自己名下：原主人从此 `/runtime/sessions/:id/*` 一律 503
   * （seatTargetForSession 判的是 `idx.accountId !== account.id`），那条会话从他公司的
   * 列表里消失，审计上还记成了别人的。UUID 猜不出来不是理由——那是「难以利用」，
   * 不是「拦住了」（handoffs 那张表为同一件事写过同一段话）。
   *
   * 被判据挡下时**不返回库里那一行**：那是另一家公司的数据，原样回给上报方就是把
   * 刚拦住的东西从窗户递出去。直接抛，路由那边已经先回过一句 403 了，走到这里的只
   * 剩「两个请求撞在一起」这种极窄的竞态。
   */
  async upsertSessionIndex(input: {
    sessionId: string
    companyId: string
    accountId: string
    botId?: string | null
    machineId?: string | null
    origin?: string | null
    remoteId?: string | null
    messageCount?: number | null
    title?: string | null
    createdAt?: number | null
    updatedAt?: number | null
  }): Promise<SessionIndex> {
    const cur = await this.sessionIndex(input.sessionId)
    const now = Date.now()
    const row: SessionIndex = {
      sessionId: input.sessionId,
      companyId: input.companyId,
      accountId: input.accountId,
      botId: input.botId !== undefined ? input.botId : (cur?.botId ?? null),
      machineId: input.machineId !== undefined ? input.machineId : (cur?.machineId ?? null),
      origin: input.origin !== undefined ? input.origin : (cur?.origin ?? null),
      remoteId: input.remoteId !== undefined ? input.remoteId : (cur?.remoteId ?? null),
      messageCount: input.messageCount !== undefined ? input.messageCount : (cur?.messageCount ?? null),
      title: input.title !== undefined ? input.title : (cur?.title ?? null),
      createdAt: input.createdAt ?? cur?.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    }
    await this.run(
      `insert into session_index ("sessionId", "companyId", "accountId", "botId", "machineId", origin, "remoteId", "messageCount", title, "createdAt", "updatedAt")
       values (?,?,?,?,?,?,?,?,?,?,?)
       on conflict ("sessionId") do update set
         "companyId"=excluded."companyId",
         "accountId"=excluded."accountId",
         "botId"=excluded."botId",
         "machineId"=excluded."machineId",
         origin=excluded.origin,
         "remoteId"=excluded."remoteId",
         "messageCount"=excluded."messageCount",
         title=excluded.title,
         "createdAt"=excluded."createdAt",
         "updatedAt"=excluded."updatedAt"
       where session_index."accountId" = excluded."accountId"
         and session_index."companyId" = excluded."companyId"`,
      [
        row.sessionId,
        row.companyId,
        row.accountId,
        row.botId,
        row.machineId,
        row.origin,
        row.remoteId,
        row.messageCount,
        row.title,
        row.createdAt,
        row.updatedAt,
      ],
    )
    // 读回真正落下去的那一行：判据挡下时它还是原来的主人，那时候要抛，不能把它回出去。
    const saved = await this.sessionIndex(input.sessionId)
    if (!saved || saved.accountId !== input.accountId || saved.companyId !== input.companyId) {
      throw new Error(`会话 ${input.sessionId} 属于别的账号，拒绝改写`)
    }
    return saved
  }

  async sessionIndex(sessionId: string): Promise<SessionIndex | undefined> {
    const r = await this.one('select * from session_index where "sessionId" = ?', [sessionId])
    return r ? sessionIndexOf(r) : undefined
  }

  /**
   * 会话索引列表。**必须带上限**：这张表随聊天无限增长，没有 LIMIT 的话一家用了一年
   * 的公司点一次「会话」就把几十万行读进内存再序列化成 JSON 发出去。
   */
  async listSessionIndex(
    companyId: string,
    filter: {
      accountId?: string
      botId?: string
      from?: number
      to?: number
      limit?: number
      /** keyset 游标：只要**严格排在它后面**的行。来自上一页最后一行。 */
      before?: { updatedAt: number; sessionId: string }
    } = {},
  ): Promise<SessionIndex[]> {
    let sql = 'select * from session_index where "companyId" = ?'
    const args: (string | number)[] = [companyId]
    if (filter.accountId) {
      sql += ' and "accountId" = ?'
      args.push(filter.accountId)
    }
    if (filter.botId) {
      sql += ' and "botId" = ?'
      args.push(filter.botId)
    }
    if (filter.from != null) {
      sql += ' and "updatedAt" >= ?'
      args.push(filter.from)
    }
    if (filter.to != null) {
      sql += ' and "updatedAt" <= ?'
      args.push(filter.to)
    }
    if (filter.before) {
      // 用 keyset 而不是 OFFSET：两页之间有新会话上报时，OFFSET 会让行整体后移，
      // 翻页要么漏要么重。审计列表漏行是实质问题。
      sql += ' and ("updatedAt" < ? or ("updatedAt" = ? and "sessionId" < ?))'
      args.push(filter.before.updatedAt, filter.before.updatedAt, filter.before.sessionId)
    }
    // 上限放到 MAX+1：路由会多要一条用来判断 hasMore，卡在 MAX 的话最后一页永远
    // 报「没有更多」。真正对外的每页条数由 sessionPageLimit 决定。
    const limit = Math.min(Math.max(Math.trunc(filter.limit ?? SESSION_PAGE_DEFAULT), 1), SESSION_PAGE_MAX + 1)
    sql += ' order by "updatedAt" desc, "sessionId" desc limit ?'
    args.push(limit)
    const rows = await this.many(sql, args)
    return rows.map(sessionIndexOf)
  }

  // ── 自动对话审计 ────────────────────────────────────────────────────

  /** 每个 (账号, Bot) 只取最近一条主会话索引。 */
  async conversationAuditTargets(companyId?: string, botId?: string, includeDeleting = false): Promise<SessionIndex[]> {
    const where = ['s."botId" is not null', 'c.kind = \'bot\'']
    const args: unknown[] = []
    if (companyId) { where.push('s."companyId" = ?'); args.push(companyId) }
    if (botId) { where.push('s."botId" = ?'); args.push(botId) }
    if (!includeDeleting) where.push('c."deletingAt" is null')
    const rows = await this.many(
      `select distinct on (s."accountId", s."botId") s.*
       from session_index s join catalog_items c on c.id = s."botId"
       where ${where.join(' and ')}
       order by s."accountId", s."botId", s."updatedAt" desc, s."sessionId" desc`,
      args,
    )
    return rows.map(sessionIndexOf)
  }

  async insertConversationAuditBatch(input: {
    companyId: string
    accountId: string
    botId: string
    sessionId: string
    deletionRequestId?: string | null
    kind: ConversationAuditBatchKind
    windowStart: number
    windowEnd: number
    timezone: string
    fromSeq?: number
    modelRole: ConversationAuditModelRole
    provider: string
    model: string
    reasoningEffort?: string
    promptVersion?: number
  }): Promise<ConversationAuditBatch> {
    const now = Date.now()
    const id = randomUUID()
    const r = await this.one(
      `insert into conversation_audit_batches
       (id,"companyId","accountId","botId","sessionId","deletionRequestId",kind,"windowStart","windowEnd",timezone,
        "fromSeq","toSeq",status,attempts,"nextTryAt","modelRole",provider,model,"reasoningEffort","promptVersion",
        "redactionVersion","createdAt")
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       on conflict ("accountId","botId",kind,"windowStart","windowEnd") do nothing returning *`,
      [
        id, input.companyId, input.accountId, input.botId, input.sessionId, input.deletionRequestId ?? null,
        input.kind, input.windowStart, input.windowEnd, input.timezone, input.fromSeq ?? 0, 0, 'queued', 0, now,
        input.modelRole, input.provider, input.model, parseReasoningEffort(input.reasoningEffort), input.promptVersion ?? 1, 1, now,
      ],
    )
    if (r) return conversationAuditBatchOf(r)
    const existing = await this.one(
      `select * from conversation_audit_batches where "accountId"=? and "botId"=? and kind=?
       and "windowStart"=? and "windowEnd"=?`,
      [input.accountId, input.botId, input.kind, input.windowStart, input.windowEnd],
    )
    if (!existing) throw new Error('审计批次创建失败')
    return conversationAuditBatchOf(existing)
  }

  async conversationAuditBatch(id: string): Promise<ConversationAuditBatch | undefined> {
    const r = await this.one('select * from conversation_audit_batches where id = ?', [id])
    return r ? conversationAuditBatchOf(r) : undefined
  }

  async claimConversationAuditBatch(now: number, leaseMs: number): Promise<ConversationAuditBatch | undefined> {
    const r = await this.one(
      `update conversation_audit_batches set status='leased', attempts=attempts+1,
         "leaseUntil"=?, "startedAt"=coalesce("startedAt", ?), "lastError"=null
       where id = (
         select id from conversation_audit_batches
         where ((status in ('queued','retry') and ("nextTryAt" is null or "nextTryAt" <= ?))
            or (status in ('leased','processing') and "leaseUntil" < ?))
         order by "createdAt" asc for update skip locked limit 1
       ) returning *`,
      [now + leaseMs, now, now, now],
    )
    return r ? conversationAuditBatchOf(r) : undefined
  }

  /** 还在席位上跑、租约将在 `leaseEndsBefore` 之前到期的批次——续租用（见 conversation-audit.ts）。 */
  async processingConversationAuditBatches(leaseEndsBefore: number, limit = 20): Promise<ConversationAuditBatch[]> {
    const rows = await this.many(
      `select * from conversation_audit_batches where status='processing' and "leaseUntil" <= ?
       order by "leaseUntil" asc limit ?`,
      [leaseEndsBefore, Math.max(1, limit)],
    )
    return rows.map(conversationAuditBatchOf)
  }

  async markConversationAuditProcessing(id: string, leaseUntil: number): Promise<void> {
    await this.run(
      `update conversation_audit_batches set status='processing', "leaseUntil"=?
       where id=? and status in ('leased','processing')`,
      [leaseUntil, id],
    )
  }

  async retryConversationAuditBatch(id: string, error: string, nextTryAt: number, dead = false): Promise<void> {
    await this.run(
      `update conversation_audit_batches set status=?, "lastError"=?, "nextTryAt"=?, "leaseUntil"=null
       where id=? and status not in ('succeeded','empty')`,
      [dead ? 'dead' : 'retry', error.slice(0, 500), dead ? null : nextTryAt, id],
    )
  }

  async completeConversationAuditBatch(input: {
    id: string
    status: 'succeeded' | 'empty'
    fromSeq: number
    toSeq: number
    eventCount: number
    turnCount: number
    sourceHash: string
    resultHash: string
    botName: string
    accountName: string
    retentionDays: number
    /**
     * 一条审计条目的**正文**：身份（id / batchId / 那几个快照名）和时间戳由这一层
     * 自己填，调用方只给内容。
     *
     * 用 Omit 而不是把字段再抄一遍：往 ConversationAuditItem 上加一格正文字段时，
     * 这里会当场编译不过，逼调用方补上。抄一份的话加了也不报错，那一格只是在这条
     * 写入路上永远是空的。
     */
    items: Array<Omit<ConversationAuditItem, 'id' | 'batchId' | 'companyId' | 'accountId' | 'botId' | 'sessionId' | 'botNameSnapshot' | 'accountNameSnapshot' | 'createdAt' | 'expiresAt'>>
  }): Promise<ConversationAuditBatch> {
    return this.tx(async () => {
      const cur = await this.conversationAuditBatch(input.id)
      if (!cur) throw new Error('审计批次不存在')
      if (cur.status === 'succeeded' || cur.status === 'empty') {
        if (cur.resultHash !== input.resultHash || cur.sourceHash !== input.sourceHash) throw new Error('审计批次结果冲突')
        return cur
      }
      const now = Date.now()
      const expiresAt = now + Math.max(30, Math.min(3650, input.retentionDays)) * 86_400_000
      for (const item of input.items) {
        await this.run(
          `insert into conversation_audit_items
           (id,"batchId","companyId","accountId","botId","sessionId","botNameSnapshot","accountNameSnapshot",
            "itemKey","firstSeq","lastSeq","startedAt","endedAt","taskSummary",timeline,"userQuestion","modelAnswer",
            "finalResult",outcome,"modelScore","scoreBreakdown","scoreConfidence",evidence,"riskFlags","createdAt","expiresAt")
           values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict do nothing`,
          [
            randomUUID(), cur.id, cur.companyId, cur.accountId, cur.botId, cur.sessionId, input.botName, input.accountName,
            item.itemKey, item.firstSeq, item.lastSeq, item.startedAt, item.endedAt, item.taskSummary,
            JSON.stringify(item.timeline), item.userQuestion, item.modelAnswer, item.finalResult, item.outcome,
            item.modelScore, JSON.stringify(item.scoreBreakdown), item.scoreConfidence, JSON.stringify(item.evidence),
            JSON.stringify(item.riskFlags), now, expiresAt,
          ],
        )
      }
      const r = await this.one(
        `update conversation_audit_batches set status=?, "fromSeq"=?, "toSeq"=?, "eventCount"=?, "turnCount"=?,
         "sourceHash"=?, "resultHash"=?, "leaseUntil"=null, "nextTryAt"=null, "lastError"=null, "completedAt"=?
         where id=? returning *`,
        [input.status, input.fromSeq, input.toSeq, input.eventCount, input.turnCount, input.sourceHash, input.resultHash, now, cur.id],
      )
      return conversationAuditBatchOf(r!)
    })
  }

  async conversationAuditCoverage(accountId: string, botId: string): Promise<{ toSeq: number; windowEnd: number }> {
    const r = await this.one(
      `select coalesce(max("toSeq"),0) as "toSeq", coalesce(max("windowEnd"),0) as "windowEnd"
       from conversation_audit_batches where "accountId"=? and "botId"=? and status in ('succeeded','empty')`,
      [accountId, botId],
    )
    return { toSeq: num(r?.toSeq || 0), windowEnd: num(r?.windowEnd || 0) }
  }

  async conversationAuditBatchesOfDeletion(requestId: string): Promise<ConversationAuditBatch[]> {
    const rows = await this.many(
      'select * from conversation_audit_batches where "deletionRequestId"=? order by "accountId", "createdAt"',
      [requestId],
    )
    return rows.map(conversationAuditBatchOf)
  }

  async conversationAuditItems(companyId: string, filter: {
    accountId?: string
    botId?: string
    from?: number
    to?: number
    outcome?: ConversationAuditOutcome
    scoreLte?: number
    limit?: number
  } = {}): Promise<ConversationAuditItem[]> {
    const where = ['"companyId" = ?']
    const args: unknown[] = [companyId]
    if (filter.accountId) { where.push('"accountId" = ?'); args.push(filter.accountId) }
    if (filter.botId) { where.push('"botId" = ?'); args.push(filter.botId) }
    if (filter.from != null) { where.push('coalesce("endedAt","createdAt") >= ?'); args.push(filter.from) }
    if (filter.to != null) { where.push('coalesce("endedAt","createdAt") <= ?'); args.push(filter.to) }
    if (filter.outcome) { where.push('outcome = ?'); args.push(filter.outcome) }
    if (filter.scoreLte != null) { where.push('"modelScore" <= ?'); args.push(filter.scoreLte) }
    args.push(Math.min(200, Math.max(1, Math.trunc(filter.limit ?? 100))))
    const rows = await this.many(
      `select * from conversation_audit_items where ${where.join(' and ')}
       order by coalesce("endedAt","createdAt") desc, id desc limit ?`,
      args,
    )
    return rows.map(conversationAuditItemOf)
  }

  /**
   * 审计总结的筛选项来自审计快照，不从当前账号 / Bot 名册现算。
   *
   * Bot 删除后审计仍然保留；如果下拉只读 catalog，那颗已删除 Bot 的历史总结就再也
   * 筛不出来。员工离职同理。每个 id 取最近一条快照，既保留历史对象，也让改名后的
   * 显示尽量接近最后一次审计时的名字。
   */
  async conversationAuditFilterOptions(companyId: string): Promise<{
    accounts: { id: string; name: string }[]
    bots: { id: string; name: string }[]
  }> {
    const [accounts, bots] = await Promise.all([
      this.many(
        `select distinct on ("accountId") "accountId", "accountNameSnapshot"
         from conversation_audit_items where "companyId"=?
         order by "accountId", "createdAt" desc, id desc`,
        [companyId],
      ),
      this.many(
        `select distinct on ("botId") "botId", "botNameSnapshot"
         from conversation_audit_items where "companyId"=?
         order by "botId", "createdAt" desc, id desc`,
        [companyId],
      ),
    ])
    return {
      accounts: accounts
        .map((row) => ({ id: str(row.accountId), name: str(row.accountNameSnapshot) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      bots: bots
        .map((row) => ({ id: str(row.botId), name: str(row.botNameSnapshot) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }
  }

  async conversationAuditItem(id: string): Promise<ConversationAuditItem | undefined> {
    const r = await this.one('select * from conversation_audit_items where id = ?', [id])
    return r ? conversationAuditItemOf(r) : undefined
  }

  async conversationAuditCoverageOfCompany(companyId: string): Promise<ConversationAuditBatch[]> {
    const rows = await this.many(
      `select distinct on ("accountId","botId") * from conversation_audit_batches
       where "companyId"=? order by "accountId","botId","windowEnd" desc,"createdAt" desc`,
      [companyId],
    )
    return rows.map(conversationAuditBatchOf)
  }

  async deleteExpiredConversationAudits(now = Date.now()): Promise<number> {
    return await this.run('delete from conversation_audit_items where "expiresAt" < ?', [now])
  }

  // ── Bot 删除状态机 ──────────────────────────────────────────────────

  async botDeletion(id: string): Promise<BotDeletionRequest | undefined> {
    const r = await this.one('select * from bot_deletion_requests where id = ?', [id])
    return r ? botDeletionRequestOf(r) : undefined
  }

  async liveBotDeletion(botId: string): Promise<BotDeletionRequest | undefined> {
    const r = await this.one(
      `select * from bot_deletion_requests where "botId"=?
       and status in ('freezing','auditing','ready_to_purge','purging','failed') order by "requestedAt" desc limit 1`,
      [botId],
    )
    return r ? botDeletionRequestOf(r) : undefined
  }

  async createBotDeletion(input: {
    companyId: string
    accountId?: string | null
    botId: string
    botName: string
    requestedBy: string
  }): Promise<BotDeletionRequest> {
    return this.tx(async () => {
      const existing = await this.liveBotDeletion(input.botId)
      if (existing) return existing
      const now = Date.now()
      const id = randomUUID()
      const r = await this.one(
        `insert into bot_deletion_requests
         (id,"companyId","accountId","botId","botNameSnapshot","requestedBy",status,"cutoffAt",
          "targetCount","auditedCount",attempts,"nextTryAt",orphans,"requestedAt")
         values (?,?,?,?,?,?,?,?,?,?,?,?,?,?) returning *`,
        [id, input.companyId, input.accountId ?? null, input.botId, input.botName, input.requestedBy,
          'freezing', now, 0, 0, 0, now, '[]', now],
      )
      await this.run('update catalog_items set "deletingAt"=?, "updatedAt"=? where id=? and kind=\'bot\'', [now, now, input.botId])
      await this.run(
        `update conversation_audit_batches set status='dead', "lastError"='已由删除终审批次接管',
         "leaseUntil"=null, "nextTryAt"=null
         where "botId"=? and kind='scheduled' and status not in ('succeeded','empty','dead')`,
        [input.botId],
      )
      return botDeletionRequestOf(r!)
    })
  }

  async updateBotDeletion(id: string, patch: {
    status?: BotDeletionStatus
    targetCount?: number
    auditedCount?: number
    attempts?: number
    nextTryAt?: number | null
    lastError?: string | null
    orphans?: { seatId: string; error: string }[]
    auditCompletedAt?: number | null
    deletedAt?: number | null
  }): Promise<BotDeletionRequest> {
    const cur = await this.botDeletion(id)
    if (!cur) throw new Error('删除请求不存在')
    const next = { ...cur, ...patch }
    const r = await this.one(
      `update bot_deletion_requests set status=?, "targetCount"=?, "auditedCount"=?, attempts=?,
       "nextTryAt"=?, "lastError"=?, orphans=?, "auditCompletedAt"=?, "deletedAt"=? where id=? returning *`,
      [next.status, next.targetCount, next.auditedCount, next.attempts, next.nextTryAt, next.lastError,
        JSON.stringify(next.orphans), next.auditCompletedAt, next.deletedAt, id],
    )
    return botDeletionRequestOf(r!)
  }

  /** 失败的删除请求不无限重试：试满这么多次就停在 failed 上，等人来看。 */
  async dueBotDeletions(now = Date.now(), limit = 20): Promise<BotDeletionRequest[]> {
    const rows = await this.many(
      `select * from bot_deletion_requests where status in ('freezing','auditing','ready_to_purge','purging','failed')
       and attempts < ? and ("nextTryAt" is null or "nextTryAt" <= ?) order by "requestedAt" asc limit ?`,
      [MAX_BOT_DELETION_ATTEMPTS, now, limit],
    )
    return rows.map(botDeletionRequestOf)
  }

  // ── 公司模型角色（日常 / utility）。不存密钥。────────────────────────

  async settings(companyId: string): Promise<CompanySettings> {
    const r = await this.one('select payload from settings where "companyId" = ?', [companyId])
    if (!r) return emptySettings()
    const raw = (jsonOf(r.payload) ?? {}) as Partial<CompanySettings>
    return {
      daily: { provider: String(raw.daily?.provider ?? ''), model: String(raw.daily?.model ?? ''), reasoningEffort: parseReasoningEffort(raw.daily?.reasoningEffort) },
      utility: { provider: String(raw.utility?.provider ?? ''), model: String(raw.utility?.model ?? ''), reasoningEffort: parseReasoningEffort(raw.utility?.reasoningEffort) },
      conversationAudit: parseConversationAuditSettings(raw.conversationAudit),
    }
  }

  async putSettings(companyId: string, next: CompanySettings): Promise<CompanySettings> {
    const now = Date.now()
    const payload = JSON.stringify({
      daily: { provider: next.daily.provider, model: next.daily.model, reasoningEffort: parseReasoningEffort(next.daily.reasoningEffort) },
      utility: { provider: next.utility.provider, model: next.utility.model, reasoningEffort: parseReasoningEffort(next.utility.reasoningEffort) },
      conversationAudit: parseConversationAuditSettings(next.conversationAudit),
    })
    await this.run(
      'insert into settings ("companyId", payload, "updatedAt") values (?,?,?) on conflict ("companyId") do update set payload=excluded.payload, "updatedAt"=excluded."updatedAt"',
      [companyId, payload, now],
    )
    return this.settings(companyId)
  }

  async platformSettings(): Promise<PlatformSettings> {
    const r = await this.one("select payload from platform_settings where id = 'platform'")
    if (!r) return emptyPlatformSettings()
    return parsePlatformPayload(r.payload)
  }

  async putPlatformSettings(next: PlatformSettings): Promise<PlatformSettings> {
    const now = Date.now()
    const enabled = Array.isArray(next.enabledModels) ? next.enabledModels.map((x) => String(x)).filter(Boolean) : []
    const payload = JSON.stringify({
      daily: { provider: next.daily.provider, model: next.daily.model, reasoningEffort: parseReasoningEffort(next.daily.reasoningEffort) },
      utility: { provider: next.utility.provider, model: next.utility.model, reasoningEffort: parseReasoningEffort(next.utility.reasoningEffort) },
      // 同下面那一串「不能漏」：整份重写，漏了它备选就是能填、回 200、读出来永远是空。
      dailyAlternates: parseDailyAlternates(next.dailyAlternates, next.daily),
      enabledModels: enabled,
      priceMultiplier: parsePriceMultiplier(next.priceMultiplier),
      connectorPricing: parseConnectorPricing(next.connectorPricing),
      // **不能漏。** 这一行漏了整整一版：类型上有、路由层收得好好的、界面也能填，
      // 只有这里拼 payload 时把它丢了——于是 PUT 回 200、读出来永远是空。
      // 后果是「全机队钉版本」这一级完全失效：传一个包上去，所有没有逐台钉过的机器
      // 都会在下一次心跳自己升上去，而唯一能拦住它的开关，看起来能设、其实存不进去。
      managerVersion: String(next.managerVersion ?? '').trim(),
      // 同上：这一行漏了，工具配置那一屏就是「能填、回 200、读出来永远是空」。
      webTools: parseWebTools(next.webTools),
      // 同上第三次。这两项漏了的后果更重：单价覆盖存不进去，缺价的模型就永远缺价；
      // 熔断开关存不进去，`enforce` 就成了一个改不动的常量。
      modelPricing: parseModelPricing(next.modelPricing),
      // 同上第四次。漏了它的表现是：兜底单价能填、PUT 回 200、读出来永远是全 0，
      // 于是缺价的模型继续按 0 收——正是加这一项要堵的那个洞。
      defaultModelRate: parseModelRate(next.defaultModelRate),
      billing: parseBilling(next.billing),
    })
    await this.run(
      "insert into platform_settings (id, payload, \"updatedAt\") values ('platform', ?, ?) on conflict (id) do update set payload=excluded.payload, \"updatedAt\"=excluded.\"updatedAt\"",
      [payload, now],
    )
    return this.platformSettings()
  }

  /**
   * 自动发现的模型快照。
   *
   * 借 platform_settings 那张表另开一行（id='discovered'），不新建表也就不用加迁移：
   * 那张表本来就是 `(id, payload jsonb, updatedAt)` 的通用键值，platform 只是它的
   * 一个键。**不能塞进 platform 那一行**——putPlatformSettings 是整条 payload 重写的，
   * 它已经漏掉过三次字段（见那个函数里的注释），再往里加一个由后台任务写、由页面
   * 顺手覆盖的字段，就是给同一个坑再挖一遍。
   */
  async discoveredModels(): Promise<DiscoverySnapshot> {
    const r = await this.one("select payload from platform_settings where id = 'discovered'")
    if (!r) return emptySnapshot()
    return parseDiscoverySnapshot(r.payload)
  }

  async putDiscoveredModels(next: DiscoverySnapshot): Promise<DiscoverySnapshot> {
    const clean = parseDiscoverySnapshot(next)
    await this.run(
      "insert into platform_settings (id, payload, \"updatedAt\") values ('discovered', ?, ?) on conflict (id) do update set payload=excluded.payload, \"updatedAt\"=excluded.\"updatedAt\"",
      [JSON.stringify(clean), Date.now()],
    )
    return clean
  }

  /**
   * 一次性：公司日常/utility 升到平台设置（平台还空时）。开机时跑一遍（index.ts）。
   *
   * **这里曾经还把公司密钥升成平台密钥，已经删掉，不要再加回来。**
   *
   * 那半段是 `select provider, secret from credentials` —— 整张表、**不带公司过滤**，
   * 挑到谁算谁，upsert 进 platform_credentials。当初写它时 `credentials` 没有任何写入
   * 口，整张表就是单租户时代留下的那几行，「升成平台的」和「搬个家」是一回事。
   *
   * 后来那张表成了每家公司自己配密钥的地方，那半段就变成了一个跨租户漏密钥的开机
   * 自动化：任意一个公司管理员填进去的 key，重启之后成了全平台的兜底密钥。
   *
   * **现在公司那条路又撤了**（供应商只由平台配，见上面 platformCredential 前面那段），
   * 可这张表里**还躺着各家当初存进去的行**——正因为没有写入口了，那批数据反而是死的，
   * 谁也管不着、谁也改不了。把它们升成平台密钥，等于拿一家公司几个月前的 key 去给
   * 全平台供货。这道禁令因此比以前更该留着。
   *
   * 平台密钥只能由平台管理员在平台那一屏显式配置。
   */
  async liftCompanySettingsToPlatform(): Promise<{ settings: boolean }> {
    const lifted = { settings: false }
    const cur = await this.platformSettings()
    const empty = !cur.daily.provider && !cur.daily.model && !cur.utility.provider && !cur.utility.model
    if (empty) {
      const rows = await this.many('select payload from settings order by "updatedAt" desc')
      for (const row of rows) {
        const s = parsePlatformPayload(row.payload)
        if (s.daily.provider || s.daily.model || s.utility.provider || s.utility.model) {
          /**
           * **原样带上 cur 的全部字段，只覆盖要迁的那两项。**
           *
           * putPlatformSettings 是「整份重写」：漏给一项，它就按空值序列化下去。
           * 这里原先漏了 managerVersion / modelPricing / billing 三项——只要平台的
           * daily/utility 还空着（上面 `empty` 只看这四个字符串），一次开机迁移就会把
           * 钉好的机队版本、全部单价覆盖和熔断开关一起清成默认值。
           */
          await this.putPlatformSettings({ ...cur, daily: s.daily, utility: s.utility })
          lifted.settings = true
          break
        }
      }
    }
    return lifted
  }


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
    const groups = (await this.groupsOf(companyId)).filter((g) => g.members.includes(accountId))
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

  async finishRoutineRun(id: string, patch: { status: RoutineRunStatus; error?: string | null; sessionId?: string | null }): Promise<void> {
    const sets = ['status = ?', 'error = ?', '"endedAt" = ?']
    const args: unknown[] = [patch.status, patch.error ?? null, patch.status === 'running' ? null : Date.now()]
    if (patch.sessionId !== undefined) (sets.push('"sessionId" = ?'), args.push(patch.sessionId))
    args.push(id)
    await this.run(`update routine_runs set ${sets.join(', ')} where id = ?`, args)
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
