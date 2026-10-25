/**
 * e2e 连的 PostgreSQL。
 *
 * 每个 Gateway 实例一个 schema（GATEWAY_PG_SCHEMA），起来时带 GATEWAY_PG_RESET=1
 * 把自己那份 drop 掉重建——各套用例互不干扰，也不用各自准备一个库。
 *
 * schema 名一律走 isolate.mjs 的 schemaOf，别写死：写死的名字会被别的 worktree 的
 * e2e 清掉。
 *
 *   docker compose up -d postgres
 */
import { createRequire } from 'node:module'

export const PG_URL =
  process.env.E2E_DATABASE_URL || 'postgres://satuwork:satuwork@127.0.0.1:5434/satuwork'

/** pg 装在 gateway 包里，仓库根目录解析不到，从那边的 package.json 起解。 */
function loadPg() {
  return createRequire(new URL('../gateway/package.json', import.meta.url))('pg')
}

/**
 * 连上库，给了 schema 就把 search_path 指过去。**用完自己 end**——要一路用到套件结束的
 * 那种连接走这个；一次性的查询走下面的 withPg。
 */
export async function pgClient(schema) {
  const pg = loadPg()
  const client = new pg.Client({ connectionString: PG_URL })
  await client.connect()
  if (schema) await client.query(`set search_path to ${schema}`)
  return client
}

/** 连一次、跑 fn、关掉。关的时候出的错不盖住 fn 自己的。 */
export async function withPg(schema, fn) {
  const pg = loadPg()
  const client = new pg.Client({ connectionString: PG_URL })
  await client.connect()
  try {
    if (schema) await client.query(`set search_path to ${schema}`)
    return await fn(client)
  } finally {
    await client.end().catch(() => {})
  }
}

/** 起 Gateway 前先探一下，省得每个子用例各报一次「连不上」。 */
export async function requirePg() {
  const pg = loadPg()
  const client = new pg.Client({ connectionString: PG_URL, connectionTimeoutMillis: 4000 })
  try {
    await client.connect()
    await client.query('select 1')
    await client.end()
  } catch (e) {
    throw new Error(
      `连不上 PostgreSQL（${PG_URL.replace(/\/\/[^@]*@/, '//')}）：${e.message}\n` +
        '先起库：docker compose up -d postgres\n' +
        '或用 E2E_DATABASE_URL 指到别处。',
    )
  }
}
