import { createHash } from 'node:crypto'
import type pg from 'pg'
import { MIGRATIONS, type Migration } from './migrations/index.ts'

/**
 * 编号迁移。
 *
 * 以前只有一段幂等脚本，每次起进程整个跑一遍。那样能用，但答不出三个问题：
 * 这个库是哪一版？这条 alter 到底跑过没有？某一步失败了，停在哪儿？
 * 而这三个问题恰恰是升级线上库时唯一要问的。
 *
 * ## 存量库怎么办
 *
 * **不需要人工基线。** 0001 就是原来那段脚本，它是幂等的
 * （`create table if not exists` + `alter table ... add column if not exists`），
 * 在一个已经建满表的生产库上跑等于空转。所以第一次带着这套代码起来时：建
 * `schema_migrations`，跑 0001（对存量库是 no-op，对空库是建全套），记一行，完事。
 * 从那之后每一条新的 DDL 都是一个**新编号**，只跑一次。
 *
 * 代价是 0001 那段脚本**从此冻结**：想加一列就写 0002，不要回去改它。校验和会
 * 盯着这件事（见下面 verify）。
 *
 * ## 一次一个事务
 *
 * 每条迁移和它那行 `schema_migrations` 在同一个事务里落，所以「跑了一半」这种状态
 * 不存在——要么整条生效并记上，要么整条回滚、下次重来。
 *
 * PG 的 DDL 是事务性的，这一点和 MySQL 不一样，可以放心这么写。唯一的例外是
 * `create index concurrently`（不能在事务里跑），眼下一条都没有；真要用的时候给那条
 * 迁移加一个 `noTransaction` 标记即可。
 *
 * ## 并发起进程
 *
 * 拿一把 advisory lock 再跑。Gateway 目前是单实例（发布包只在本机磁盘上），但
 * 「同时起两个」在部署脚本里太容易发生了，而两个进程同时建表的报错很难看懂。
 */

/** advisory lock 的键。按 schema 名散列——e2e 每套用例一个 schema，互不阻塞。 */
function lockKey(schema: string): number {
  const h = createHash('sha256').update('satuwork-migrate:' + schema).digest()
  // PG 的 advisory lock 收 bigint，这里只取 31 位，省得跨语言对不上符号位。
  return h.readUInt32BE(0) & 0x7fffffff
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex').slice(0, 16)
}

/** 已应用的一行。`checksum` 用来发现「有人回头改了已经跑过的迁移」。 */
interface AppliedRow {
  id: string
  checksum: string
}

const LEDGER = `
  create table if not exists schema_migrations (
    id          text primary key,
    name        text not null,
    checksum    text not null,
    "appliedAt" bigint not null
  );
`

/**
 * 已经跑过的那些，编号必须和代码里的前缀一一对上，内容也不能变。
 *
 * 三种不一致都当场停机，不猜：
 *
 * - **改了已应用的迁移**：库里是旧形状，代码以为是新的。继续跑只会在几百行之后
 *   报一个和真正原因毫无关系的错。
 *   （`previousChecksums` 里登记过的旧版本除外，见 migrations/index.ts。）
 * - **库里有代码里没有的编号**：这个库被一个更新的版本升过，现在回滚了代码。
 *   往下跑等于让新库配旧代码，能读到不存在的列。
 *
 * （「编号撞号或者不升序」不在这里查——那是代码自身的毛病，在 migrations/index.ts
 * 加载时就会抛，不用等到连上某个库。）
 */
function verify(applied: AppliedRow[], all: Migration[]): void {
  const byId = new Map(all.map((m) => [m.id, m]))
  for (const row of applied) {
    const known = byId.get(row.id)
    if (!known) {
      throw new Error(
        `库里有迁移 ${row.id}，但这份代码里没有。多半是把代码回滚到了比库更旧的版本——` +
          '先把代码升回去，或者手工评估之后从 schema_migrations 里删掉那一行。',
      )
    }
    if (checksum(known.sql) !== row.checksum && !known.previousChecksums?.includes(row.checksum)) {
      throw new Error(
        `迁移 ${row.id}（${known.name}）在应用之后被改过：库里记的是 ${row.checksum}，` +
          `代码算出来是 ${checksum(known.sql)}。已经跑过的迁移不能改——把改动写成新的一条。`,
      )
    }
  }
}

export interface MigrateResult {
  /** 这一轮真正跑掉的编号。空数组 = 库本来就是最新的。 */
  applied: string[]
  /** 跑完之后停在哪一号。 */
  current: string | null
}

/**
 * 把这个 schema 升到最新。
 *
 * `client` 是一条**独占**连接，不是池——advisory lock 是会话级的，必须在同一条连接上
 * 拿和放。
 */
export async function migrate(client: pg.PoolClient, schema: string): Promise<MigrateResult> {
  const key = lockKey(schema)
  await client.query('select pg_advisory_lock($1)', [key])
  try {
    await client.query(LEDGER)
    const { rows } = await client.query<AppliedRow>('select id, checksum from schema_migrations order by id')
    verify(rows, MIGRATIONS)

    const done = new Set(rows.map((r) => r.id))
    const applied: string[] = []
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue
      await client.query('begin')
      try {
        await client.query(m.sql)
        await client.query(
          'insert into schema_migrations (id, name, checksum, "appliedAt") values ($1, $2, $3, $4)',
          [m.id, m.name, checksum(m.sql), Date.now()],
        )
        await client.query('commit')
      } catch (e) {
        await client.query('rollback').catch(() => {})
        throw new Error(`迁移 ${m.id}（${m.name}）失败：${(e as Error).message}`)
      }
      applied.push(m.id)
    }
    return { applied, current: MIGRATIONS.at(-1)?.id ?? null }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [key]).catch(() => {})
  }
}

/**
 * 库现在停在哪一号、代码里最新是哪一号、还差哪几条。
 *
 * 排查用，**不挂在 `/health` 上**——那条是存活探针，每次都去查一遍库是本末倒置。
 * 启动日志里已经说了这一轮跑掉哪几条（见 index.ts）。
 */
export async function migrationState(
  client: pg.PoolClient | pg.Pool,
): Promise<{ current: string | null; latest: string | null; pending: string[] }> {
  const latest = MIGRATIONS.at(-1)?.id ?? null
  let done = new Set<string>()
  try {
    const { rows } = await client.query<{ id: string }>('select id from schema_migrations order by id')
    done = new Set(rows.map((r) => r.id))
  } catch {
    // 表还不存在 = 一条都没跑过。
  }
  const ids = MIGRATIONS.map((m) => m.id)
  return {
    current: [...done].sort().at(-1) ?? null,
    latest,
    pending: ids.filter((id) => !done.has(id)),
  }
}
