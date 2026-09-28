/**
 * 编号迁移。
 *
 * 这一套要答的是升级线上库时唯一要问的那几个问题：存量库能不能自动接上、
 * 跑过的会不会再跑一遍、有人回头改了已发布的迁移会怎样。
 *
 * **最要紧的是「存量库自动基线」那条**：生产库早就有全套表、但没有
 * `schema_migrations`。如果那种库上来就被当成空库、或者干脆报错停机，这套机制
 * 就是负收益——它要解决的正是这个场景。
 */
import { readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { freePort } from './ports.mjs'
import { runProbe as sharedProbe } from './probe.mjs'

const SCHEMA = schemaOf('e2e_migrate')
const GW_HOME = tmpOf('satuwork-e2e-migrate')

/**
 * 0001 那段 SQL，直接从源码里读。
 *
 * 拿它来造一个「迁移机制之前的库」——那正是生产库现在的样子。写死一份副本的话，
 * 这条用例过几个月就会在测一个和线上无关的形状。
 */
/**
 * 代码里一共有几条迁移。**从源码数出来，不写死**——写死的话每加一条迁移都要回来改
 * 这个文件，改着改着就会有人图省事把断言删掉，而这几条断言正是「迁移真的只跑一遍」
 * 的唯一证据。
 */
function migrationIds(gwRoot) {
  const src = readFileSync(join(gwRoot, 'src/db/migrations/index.ts'), 'utf8')
  const body = src.slice(src.indexOf('export const MIGRATIONS'))
  return [...body.matchAll(/\{\s*id:\s*'([^']+)'/g)].map((m) => m[1])
}

function initialSql(gwRoot) {
  const src = readFileSync(join(gwRoot, 'src/db/migrations/0001-initial.ts'), 'utf8')
  // 从 `export const SQL = ` 之后那个反引号开始数——文件抬头的注释里也有反引号。
  const mark = 'export const SQL = `'
  const a = src.indexOf(mark)
  const b = src.lastIndexOf('`')
  if (a < 0 || b <= a) throw new Error('0001-initial.ts 里找不到那段模板字符串')
  return src.slice(a + mark.length, b)
}

/** 跑一个要 tsx 的探针，把它 `__RESULT__` 那一行解出来。 */
// schema 名也要带上本 checkout 的后缀，否则两个 worktree 的探针会互相清库。
const runProbe = (gwRoot, file) =>
  sharedProbe(gwRoot, file, { env: { E2E_DATABASE_URL: PG_URL, E2E_MIGRATE_SCHEMA: schemaOf('e2e_migrate_race') } })

function waitExit(child, ms = 20000) {
  return new Promise((ok, bad) => {
    if (child._exited) return ok(child._exited)
    const t = setTimeout(() => bad(new Error(`进程 ${ms}ms 内没退出，输出：\n${child._out}`)), ms)
    child.on('exit', (code, sig) => {
      clearTimeout(t)
      ok({ code, sig })
    })
  })
}

async function stop(child) {
  if (!child || child._exited) return
  try {
    child.kill('SIGTERM')
  } catch {}
  await waitExit(child, 5000).catch(() => {})
}

export async function runMigrate({ gwRoot, test, start, waitHttp, assert, log }) {
  const GW_PORT = await freePort()
  const base = `http://127.0.0.1:${GW_PORT}`
  rmSync(GW_HOME, { recursive: true, force: true })
  log('\n# migrate')

  const require = createRequire(`${gwRoot}/package.json`)
  const pg = require('pg')
  const client = new pg.Client({ connectionString: PG_URL })
  await client.connect()

  const fresh = async () => {
    await client.query(`drop schema if exists ${SCHEMA} cascade`)
    await client.query(`create schema ${SCHEMA}`)
    await client.query(`set search_path to ${SCHEMA}`)
  }
  const ledger = async () => {
    const r = await client.query('select id, name, checksum from schema_migrations order by id')
    return r.rows
  }
  const boot = (name) =>
    start(name, ['--import', 'tsx', `${gwRoot}/src/index.ts`], {
      cwd: gwRoot,
      env: {
        SATUWORK_GATEWAY_HOME: GW_HOME,
        GATEWAY_DATABASE_URL: PG_URL,
        GATEWAY_PG_SCHEMA: SCHEMA,
        // **不设 GATEWAY_PG_RESET**：这一套要的就是「库里原来有什么」。
        GATEWAY_HOST: '127.0.0.1',
        GATEWAY_PORT: String(GW_PORT),
        GATEWAY_ACCESS_HOST: 'satuwork.com',
        GATEWAY_SEED_OWNER: '0',
      },
    })

  let gw
  try {
    const ALL = migrationIds(gwRoot)

    /**
     * 每条用例的 boot / stop 都包在 try/finally 里。
     *
     * 这一套的进程全听同一个口：某条断言先炸、进程没停，下一条 boot 就绑不上端口，
     * `waitHttp` 探到的是上一个残留进程——接着整套一起红，报的全是和迁移无关的东西。
     * waitHttp 带上 child：起不来时有用的是它的输出。
     */
    await test('空库：建全套并按顺序记上每一条', async () => {
      await fresh()
      gw = boot('migrate-fresh')
      try {
        await waitHttp(`${base}/health`, { child: gw, what: 'migrate-fresh' })
        const rows = await ledger()
        assert(rows.length === ALL.length, `应有 ${ALL.length} 条迁移，实际 ${rows.length}：${JSON.stringify(rows)}`)
        assert(rows.map((r) => r.id).join(',') === ALL.join(','), `编号或顺序不对：${rows.map((r) => r.id)}`)
        assert(rows[0].checksum && rows[0].checksum.length === 16, `校验和形状不对：${rows[0].checksum}`)
        // 表真的建出来了，不是只记了一行账。
        const t = await client.query(
          `select count(*)::int as n from information_schema.tables where table_schema = '${SCHEMA}' and table_name = 'companies'`,
        )
        assert(t.rows[0].n === 1, 'companies 表没建出来')
        const removed = await client.query(
          `select table_name from information_schema.tables where table_schema = '${SCHEMA}' and table_name in ('tasks','task_events','task_extract_logs')`,
        )
        assert(removed.rows.length === 0, `任务看板的表仍然存在：${removed.rows.map((r) => r.table_name).join(',')}`)
        assert(gw._out.includes(`已应用 ${ALL.length} 条迁移`), `启动日志没说跑了哪几条：\n${gw._out.slice(-400)}`)
      } finally {
        await stop(gw)
      }
    })

    await test('再起一次：不重复应用，日志说「已是最新」', async () => {
      gw = boot('migrate-again')
      try {
        await waitHttp(`${base}/health`, { child: gw, what: 'migrate-again' })
        const rows = await ledger()
        assert(rows.length === ALL.length, `迁移被重复应用了：${JSON.stringify(rows)}`)
        assert(gw._out.includes('已是最新'), `没说「已是最新」：\n${gw._out.slice(-400)}`)
      } finally {
        await stop(gw)
      }
    })

    /**
     * 这条是这套机制存在的理由。
     *
     * 生产库现在的样子：全套表都在，但没有 schema_migrations——它是被那段幂等脚本
     * 一次次跑出来的。带着迁移机制的新版本起上去时，必须自己认出「这库已经是 0001
     * 的形状了」，记一行账就走，**不能重建、更不能报错停机**。
     *
     * 靠的是 0001 本身幂等：在一个已经建满表的库上跑它等于空转。
     */
    await test('存量库：自动接上基线，数据一行不动', async () => {
      await fresh()
      // 造一个「迁移机制之前」的库：直接跑 0001 的 SQL，不建 schema_migrations。
      await client.query(initialSql(gwRoot))
      const before = await client.query('select table_name from information_schema.tables where table_schema = $1', [SCHEMA])
      assert(before.rows.length > 10, `存量库该有一堆表，实际 ${before.rows.length}`)
      const has = await client.query(
        `select count(*)::int as n from information_schema.tables where table_schema = '${SCHEMA}' and table_name = 'schema_migrations'`,
      )
      assert(has.rows[0].n === 0, '造出来的存量库不该已经有 schema_migrations')

      // 塞一行真数据。迁移绝不能把它弄丢。
      const now = Date.now()
      await client.query(
        'insert into companies (id, slug, name, "createdAt", "updatedAt") values ($1,$2,$3,$4,$5)',
        ['co-legacy', 'legacy', '存量公司', now, now],
      )

      gw = boot('migrate-legacy')
      try {
        await waitHttp(`${base}/health`, { child: gw, what: 'migrate-legacy' })
        const rows = await ledger()
        // 0001 在存量库上是空转（它幂等），后面几条是真跑的——账本上一条都不能少。
        assert(rows.map((r) => r.id).join(',') === ALL.join(','), `没接上基线：${JSON.stringify(rows)}`)
        const kept = await client.query('select name from companies where id = $1', ['co-legacy'])
        assert(kept.rows.length === 1 && kept.rows[0].name === '存量公司', '存量数据被弄丢了')
        const after = await client.query('select table_name from information_schema.tables where table_schema = $1', [SCHEMA])
        const names = new Set(after.rows.map((r) => r.table_name))
        /**
         * 存量库里已有的表**一张都不能少**，并且多出 schema_migrations。
         *
         * 这里原来断言的是「正好多一张」，但那把「后续迁移不许建新表」也一起钉死了——
         * 0004 加了三张连接器的表，这条就红了，而它想守的其实是「0001 的表没被重建、
         * 没被删」。所以改成集合包含：新增多少张不管，少一张就是错。
         */
        for (const row of before.rows) assert(names.has(row.table_name), `存量表不见了：${row.table_name}`)
        assert(names.has('schema_migrations'), '没记账本')
      } finally {
        await stop(gw)
      }
    })

    await test('已发布的迁移被改过：当场停机，不往下跑', async () => {
      // 库里记的校验和和代码算出来的对不上 = 有人回头编辑了已经跑过的迁移。
      // 继续跑只会在几百行之后报一个和真正原因毫无关系的错。
      await client.query(`update schema_migrations set checksum = 'deadbeefdeadbeef' where id = '0001-initial'`)
      const bad = boot('migrate-tampered')
      try {
        const exit = await waitExit(bad)
        assert(exit.code !== 0, `应该起不来，实际退出码 ${exit.code}`)
        assert(bad._out.includes('在应用之后被改过'), `报错没说清楚原因：\n${bad._out.slice(-600)}`)
        assert(bad._out.includes('0001-initial'), '报错没说是哪一条')
        // 失败时还要说清楚库停在哪儿——那是运维当场最想知道的一件事：
        // 升级挂了，库是升过的还是没升过的？回滚代码安不安全？
        assert(bad._out.includes('库停在'), `没报出库当前停在哪一号：\n${bad._out.slice(-600)}`)
      } finally {
        // 「应该起不来」的那个要是居然起来了，也不能让它占着口。
        await stop(bad)
      }
    })

    await test('库比代码新：当场停机，别拿旧代码配新库', async () => {
      // 上一条把校验和改坏了。清空账本、借一次成功启动把真值写回去，
      // 这一条才是在测「库里有代码没有的编号」，而不是继续测上一条。
      await client.query(`delete from schema_migrations`)
      const ok = boot('migrate-restore')
      try {
        await waitHttp(`${base}/health`, { child: ok, what: 'migrate-restore' })
      } finally {
        await stop(ok)
      }

      await client.query(
        'insert into schema_migrations (id, name, checksum, "appliedAt") values ($1,$2,$3,$4)',
        ['9999-from-the-future', '未来的迁移', '0'.repeat(16), Date.now()],
      )
      const bad = boot('migrate-rollback')
      try {
        const exit = await waitExit(bad)
        assert(exit.code !== 0, `应该起不来，实际退出码 ${exit.code}`)
        assert(bad._out.includes('但这份代码里没有'), `报错没说清楚原因：\n${bad._out.slice(-600)}`)
        assert(bad._out.includes('9999-from-the-future'), '报错没说是哪一条')
      } finally {
        await stop(bad)
      }
    })

    /**
     * 这条钉的是那次「查了七轮才找出来」的事故。
     *
     * 两份 e2e 同时在跑（两个 worktree），套件的 schema 名写死，于是后起的进程一句
     * `drop schema cascade` 把前一个正在服务的库端了。前一个进程活得好好的，只是从那
     * 一刻起表在重建窗口里查不到、账号 id 全换了新的——两种表现都指不回真正的原因。
     */
    await test('别的 Gateway 正用着这个 schema：拒绝清库，人家的数据一行不动', async () => {
      const SHARED = schemaOf('e2e_migrate_claim')
      const holderPort = await freePort()
      const intruderPort = await freePort()
      const reset = (name, port) =>
        start(name, ['--import', 'tsx', `${gwRoot}/src/index.ts`], {
          cwd: gwRoot,
          env: {
            SATUWORK_GATEWAY_HOME: `${GW_HOME}-${name}`,
            GATEWAY_DATABASE_URL: PG_URL,
            GATEWAY_PG_SCHEMA: SHARED,
            GATEWAY_PG_RESET: '1',
            GATEWAY_HOST: '127.0.0.1',
            GATEWAY_PORT: String(port),
            GATEWAY_ACCESS_HOST: 'satuwork.com',
            GATEWAY_SEED_OWNER: '0',
          },
        })
      let holder
      let intruder
      try {
        holder = reset('claim-holder', holderPort)
        await waitHttp(`http://127.0.0.1:${holderPort}/health`, { child: holder, what: 'claim-holder' })
        // 占着的那位手上有一行真数据。撞车的老毛病正是把它连同整个 schema 一起抹掉。
        const now = Date.now()
        await client.query(`set search_path to ${SHARED}`)
        await client.query(
          'insert into companies (id, slug, name, "createdAt", "updatedAt") values ($1,$2,$3,$4,$5)',
          ['co-claim', 'claim', '占着的公司', now, now],
        )

        intruder = reset('claim-intruder', intruderPort)
        const exit = await waitExit(intruder)
        assert(exit.code !== 0, `第二个应该起不来，实际退出码 ${exit.code}`)
        assert(intruder._out.includes('拒绝 GATEWAY_PG_RESET 清库'), `报错没说是撞了车：\n${intruder._out.slice(-600)}`)
        assert(intruder._out.includes(SHARED), '报错没说是哪个 schema')
        // 对面是谁要报得出来——不然人只知道「有人占着」，不知道该去杀哪个进程。
        assert(/pid \d+/.test(intruder._out), `报错没指出占着的是谁：\n${intruder._out.slice(-600)}`)
        // 「库停在哪一号」是迁移失败才该打的，这个错里打它只会把人往迁移那边引。
        assert(!intruder._out.includes('库停在'), `不该按迁移失败来报：\n${intruder._out.slice(-600)}`)

        // 最要紧的一条：占着的那位一个字都没少，而且还活着。
        const kept = await client.query('select name from companies where id = $1', ['co-claim'])
        assert(kept.rows.length === 1, '数据被闯进来的那个进程抹掉了')
        const alive = await fetch(`http://127.0.0.1:${holderPort}/health`)
        assert(alive.ok, `占着的 Gateway 被带塌了：${alive.status}`)
      } finally {
        await stop(holder)
        // 「应该起不来」的那个要是居然起来了，也不能让它留着。
        await stop(intruder)
        await client.query(`drop schema if exists ${SHARED} cascade`).catch(() => {})
        await client.query(`set search_path to ${SCHEMA}`).catch(() => {})
        rmSync(`${GW_HOME}-claim-holder`, { recursive: true, force: true })
        rmSync(`${GW_HOME}-claim-intruder`, { recursive: true, force: true })
      }
    })

    /**
     * 0035 建的是「每条任务最多一条 running」的唯一索引。它要防的正是「已经并发出了两条」，
     * 存量库里真有这种行的话，裸建索引当场失败、Gateway 起不来。所以 0035 先去重。
     *
     * 造法：整套跑完之后把索引和 0035 那行账抹掉、塞进三条同一任务的 running，再起一次——
     * 这时只有 0035 会重跑，跑的正是「存量库带着脏数据升级」那一刻。
     */
    await test('0035 遇上同一任务的多条 running：先去重再建索引，只留最新一条', async () => {
      await fresh()
      gw = boot('migrate-0035-base')
      try {
        await waitHttp(`${base}/health`, { child: gw, what: 'migrate-0035-base' })
      } finally {
        await stop(gw)
      }
      await client.query('drop index if exists routine_runs_one_running')
      await client.query(`delete from schema_migrations where id = '0035-routine-one-running'`)
      // 流水表外键连着 routines → catalog / accounts / companies，这里只关心流水本身：
      // 本会话里关掉外键触发器，省得为了三行流水造一整家公司。
      await client.query(`set session_replication_role = replica`)
      try {
        const ins = (id, routineId, startedAt) =>
          client.query(
            `insert into routine_runs (id, "routineId", "botId", "accountId", "companyId", trigger, status, "startedAt") values ($1,$2,'b','a','c','manual','running',$3)`,
            [id, routineId, startedAt],
          )
        await ins('run-old', 'rt-dup', 1000)
        await ins('run-mid', 'rt-dup', 2000)
        await ins('run-new', 'rt-dup', 3000)
        await ins('run-solo', 'rt-solo', 1500)
      } finally {
        await client.query(`set session_replication_role = origin`)
      }
      gw = boot('migrate-0035-dedupe')
      try {
        await waitHttp(`${base}/health`, { child: gw, what: 'migrate-0035-dedupe' })
        /**
         * 按 error 文案认是谁收的：进程起来之后 sweepUnclaimed 会把这几条没有租约的试跑
         * 一并收掉（它们本来就没人领），状态看不出迁移留下了哪条，文案看得出。
         */
        const r = await client.query(`select id, status, error, "endedAt" from routine_runs order by id`)
        const by = Object.fromEntries(r.rows.map((x) => [x.id, x]))
        const dedupedByMigration = (x) => x.status === 'error' && String(x.error).includes('升级时只保留最新一条')
        assert(!dedupedByMigration(by['run-new']), `最新那条不该被迁移收掉：${JSON.stringify(r.rows)}`)
        assert(!dedupedByMigration(by['run-solo']), `别的任务的 running 不该被动：${JSON.stringify(r.rows)}`)
        for (const id of ['run-old', 'run-mid']) {
          assert(dedupedByMigration(by[id]) && by[id].endedAt != null, `${id} 应被迁移收成 error 并记上结束时刻：${JSON.stringify(by[id])}`)
        }
        const idx = await client.query(
          `select 1 from pg_indexes where schemaname = $1 and indexname = 'routine_runs_one_running'`,
          [SCHEMA],
        )
        assert(idx.rows.length === 1, '唯一索引没建出来')
      } finally {
        await stop(gw)
      }
    })

    await test('0035 旧版本（没有去重那一步）跑过的库：认旧校验和，照常起来', async () => {
      // 发布后给 0035 补了去重，已经跑过旧版本的库校验和对不上新代码——不能因此起不来。
      await client.query(`update schema_migrations set checksum = 'c321a7b2686a50d1' where id = '0035-routine-one-running'`)
      gw = boot('migrate-0035-legacy')
      try {
        await waitHttp(`${base}/health`, { child: gw, what: 'migrate-0035-legacy' })
        assert(gw._out.includes('已是最新'), `没说「已是最新」：\n${gw._out.slice(-400)}`)
      } finally {
        await stop(gw)
      }
    })

    await test('两个进程同时起：迁移只跑一遍，锁还得放开', async () => {
      // 滚动重启、compose 起两个副本、有人手滑跑了两次 start——这个场景在部署脚本里
      // 太容易出现，而两个连接同时 create table 的报错很难看懂。
      const r = await runProbe(gwRoot, 'e2e-migrate-race.mjs')
      assert(r.exactlyOneApplied, `应该恰好一边跑了：${JSON.stringify(r.applied)}`)
      assert(r.noDuplicate, `schema_migrations 有 ${r.ledgerRows} 行，应该是 ${r.expectedRows} 行`)
      assert(r.tables > 10, `表没建全，只有 ${r.tables} 张`)
      // 锁没放开的话，下一个起来的进程会永远卡在 pg_advisory_lock 上——
      // 那是最难查的一种「起不来」：没有报错，就是不动。
      assert(r.lockReleased, 'advisory lock 没放开')
      assert(r.thirdApplied === 0, `第三次不该再跑，实际跑了 ${r.thirdApplied} 条`)
    })
  } finally {
    await stop(gw)
    try {
      await client.query(`drop schema if exists ${SCHEMA} cascade`)
    } catch {}
    try {
      await client.end()
    } catch {}
    try {
      rmSync(GW_HOME, { recursive: true, force: true })
    } catch {}
  }
}
