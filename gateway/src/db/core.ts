/**
 * 库的底座：连接池、语句、事务、锁、迁移和 schema 认领。
 *
 * 业务方法不放这里。它们按领域分在同一目录下的十来个文件里，一层层 extends 上来
 * （顺序就是 db.ts 里列的那条链），最后在 db.ts 收成唯一的 `Db`。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import pg from 'pg'
import { migrate, type MigrateResult, migrationState } from './migrate.ts'
import { type Row, toPgCounted } from './rows.ts'

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

export class DbCore {
  protected pool: pg.Pool
  protected schema: string
  protected url: string
  /** 认领这个 schema 的那条连接。只有清库模式才有，见 claimSchema。 */
  protected claim: pg.Client | null = null
  /** 事务期间把 client 放这儿，`db.tx(() => db.xxx())` 里的每条语句才走同一个连接。 */
  protected txClient = new AsyncLocalStorage<PoolClient>()
  /** 保存点起名用，见 savepoint。 */
  protected savepointSeq = 0

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

  protected async query(text: string, params: unknown[] = []): Promise<pg.QueryResult> {
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

  protected async one(text: string, params: unknown[] = []): Promise<Row | undefined> {
    const r = await this.query(text, params)
    return r.rows[0] as Row | undefined
  }

  protected async many(text: string, params: unknown[] = []): Promise<Row[]> {
    const r = await this.query(text, params)
    return r.rows as Row[]
  }

  protected async run(text: string, params: unknown[] = []): Promise<number> {
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
  protected async claimSchema(): Promise<void> {
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
   * 号统一登记在 db/locks.ts，加新的去那儿挑。
   *
   * **锁是整个库的，不分 schema。** e2e 那几十套共用一个 Postgres（各占一个 schema），
   * 两份并行的 e2e 会在同一个号上互相等一下——等的是一次 insert 的工夫，可以接受；要是
   * 哪天有一处锁里带上了慢活，那时再把 schema 名折进第二个参数。
   */
  /**
   * 带 `sub` 时锁的是「这一处 × 这一个对象」（两参数形式的 advisory lock，第二个数取
   * `hashtext(sub)`）：同一颗 Bot 的并发写互相排队，不同 Bot 之间不必等。哈希撞了只是
   * 两颗不相干的 Bot 偶尔排一次队，不影响对错。
   */
  async lockExclusive(key: number, sub?: string): Promise<void> {
    this.requireTx('lockExclusive')
    if (sub === undefined) await this.one('select pg_advisory_xact_lock(?)', [key])
    else await this.one('select pg_advisory_xact_lock(?::int, hashtext(?))', [key, sub])
  }

  /** 事务外拿事务级锁是写错了代码：锁当场就放了，什么都没护住。宁可当场炸。 */
  protected requireTx(who: string, msg = `${who} 必须在 db.tx 里调——事务外的锁当场就放了`): void {
    if (!this.txClient.getStore()) throw new Error(msg)
  }

  /**
   * 按名字散列的事务级咨询锁（公司管理员、账本、结算、部署、渠道对齐那几把）。键本身就是
   * `用途:对象`，不同用途天然撞不上；数字号的那一组见 db/locks.ts + lockExclusive。
   */
  protected async xactLock(who: string, key: string, msg?: string): Promise<void> {
    this.requireTx(who, msg)
    await this.one('select pg_advisory_xact_lock(hashtext(?::text))', [key])
  }

  async tx<T>(fn: () => Promise<T> | T): Promise<T> {
    const existing = this.txClient.getStore()
    // 已经在事务里就直接跑，不开嵌套事务。
    if (existing) return fn()
    const client = await this.pool.connect()
    // rollback 本身失败时，这条连接停在什么状态没人说得清（事务可能还开着、连接可能半断），
    // 不能原样还回池子给下一个请求用——带着错误 release，pg 会直接销毁它。
    let broken: Error | undefined
    try {
      await client.query('begin')
      const out = await this.txClient.run(client, async () => fn())
      await client.query('commit')
      return out
    } catch (e) {
      try {
        await client.query('rollback')
      } catch (re) {
        broken = re instanceof Error ? re : new Error(String(re))
      }
      throw e
    } finally {
      client.release(broken)
    }
  }

  /**
   * 「撞了唯一约束就换一串再插」那一类用它包住**那一条会撞的语句**。
   *
   * 事务里任何一条语句报错，PG 就把整个事务标成 aborted，之后每条语句都是
   * `current transaction is aborted`——catch 住 23505 再重试在事务里根本走不通。
   * 在事务里时这里套一层 SAVEPOINT：出错回滚到保存点，事务照常可用；不在事务里就直接跑。
   */
  protected async savepoint<T>(fn: () => Promise<T>): Promise<T> {
    const client = this.txClient.getStore()
    if (!client) return fn()
    const name = `sp_${++this.savepointSeq}`
    await client.query(`savepoint ${name}`)
    try {
      const out = await fn()
      await client.query(`release savepoint ${name}`)
      return out
    } catch (e) {
      await client.query(`rollback to savepoint ${name}`)
      throw e
    }
  }
}
