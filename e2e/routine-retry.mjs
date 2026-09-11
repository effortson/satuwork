/**
 * 日常任务跑砸了之后**自己再来三次**（见 docs/routines.md §8）。
 *
 * 为什么值得单开一套：这一层坏了**一声不响**。界面上看到的还是一条红的运行记录，
 * 和「试过了、没成、就这样了」长得一模一样——补跑没排上、排上了没跑、或者反过来永远
 * 停不下来（每五分钟往那条会话里灌一条），都要等到有人翻运行记录才看得出来。而这三种
 * 塌法都不会让任何一条断言以外的东西变红。
 *
 * 跑的那一头是**一个总说「没跑起来」的假工人**：这一套要验的不是那一轮跑得怎么样，是
 * 「够不着席位」——真实世界里定时任务失败最常见的那一类（机器没开、正在换版、网断了
 * 一分钟），也正是重试最该管的那一类。假工人每次 `due` 领到活就回 `finish {kind: failed}`；
 * 领到几条、回了几次都记着——补跑「排上了」和补跑「真的交出去了」是两件事，只看库里那
 * 两格的话，一个排上了却永远交不出去的实现照样能把断言蒙过去。
 *
 * 旁边还挂着一个**假席位**，专门记 Gateway 有没有来敲：Gateway 自己不跑（docs/routines.md §3），
 * 一下都不该来。
 *
 * 时间全压到秒级：`GATEWAY_ROUTINE_RETRY_MS` 把 5/15/30 分钟换成几百毫秒，调度器
 * 一秒扫一次。压的是间隔，不是逻辑——排第几次、什么时候停、谁把它清掉，走的都是
 * 线上那一份代码。
 */
import { createServer } from 'node:http'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { createCompany } from './org.mjs'
import { publishRelease } from './release.mjs'
import { pairMachine } from './pair.mjs'
import { freePort } from './ports.mjs'
import { closeServer } from './probe.mjs'

/** 这一套自己的 schema。写死名字会被别的 worktree 的 e2e 清掉（见 pg.mjs 的 schemaOf）。 */
const SCHEMA = schemaOf('e2e_routine_retry')

/** 补跑那三档压到这个量级。调度器一秒扫一次，所以每一档都得比一次 tick 短。 */
const RETRY_MS = [400, 500, 600]
/** 一共补几次。就是上面那个表的长度——界面上「共 N 次」里的 N。 */
const RETRY_MAX = RETRY_MS.length

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
  })
}

/** 假席位：Gateway 要是自己来敲，就会被记下来——它一下都不该来。 */
function seatSpy() {
  const hits = []
  const server = createServer((req, res) => {
    hits.push(req.url.split('?')[0])
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: '不该来敲我' }))
  })
  return { server, hits }
}

export async function runRoutineRetry({ gwRoot, test, req, start, waitHttp, assert, log }) {
  log('\n# routine-retry')

  const GW_HOME = tmpOf('satuwork-e2e-routine-retry')
  const GW_PORT = await freePort()
  const gwBase = `http://127.0.0.1:${GW_PORT}`
  rmSync(GW_HOME, { recursive: true, force: true })

  const seat = seatSpy()
  const seatUrl = await listen(seat.server)

  const gw = start('routine-retry-gw', ['--import', 'tsx', join(gwRoot, 'src/index.ts')], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: SCHEMA,
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '1',
      GATEWAY_OWNER_EMAIL: 'owner@retry.test',
      GATEWAY_OWNER_PASSWORD: 'test-owner-retry',
      SATUWORK_DEPLOY_STUB: '1',
      GATEWAY_ROUTINE_TICK_MS: '1000',
      GATEWAY_ROUTINE_RETRY_MS: RETRY_MS.join(','),
    },
  })

  /** 直接改库：把这条任务的「下一次」拨到刚刚过去，好让下一个 tick 当场抢到它。 */
  const withPg = async (fn) => {
    const { createRequire } = await import('node:module')
    const require = createRequire(new URL('../gateway/package.json', import.meta.url))
    const pg = require('pg')
    const client = new pg.Client({ connectionString: PG_URL })
    await client.connect()
    try {
      await client.query(`set search_path to ${SCHEMA}`)
      return await fn(client)
    } finally {
      await client.end().catch(() => {})
    }
  }

  try {
    await waitHttp(gwBase + '/health', { child: gw, what: 'routine-retry gateway' })

    const reg = await createCompany(req, gwBase, {
      ownerEmail: 'owner@retry.test',
      ownerPassword: 'test-owner-retry',
      email: 'admin@retry.test',
      password: 'correct-horse',
      companyName: 'RetryCo',
      slug: 'retryco',
      seats: 2,
    })
    const adminTok = reg.token
    const ownerTok = reg.ownerToken
    const orgId = reg.company.id

    const me = await req(gwBase, 'GET', '/me', { token: adminTok })
    const accountId = me.json.account.id
    const secrets = await req(gwBase, 'GET', `/platform/accounts/${accountId}`, { token: ownerTok })
    assert(secrets.status === 200, `席位凭证 ${secrets.status} ${secrets.text}`)
    const seatAccess = secrets.json.accessToken

    const madeBot = await req(gwBase, 'POST', '/runtime/bots', { token: adminTok, body: { name: '每日简报' } })
    assert(madeBot.status === 201, `建 Bot ${madeBot.status} ${madeBot.text}`)
    const botId = madeBot.json.bot.id

    const machine = await pairMachine({ req, gwBase, ownerTok, orgId })
    const machineTok = machine.token
    await publishRelease({ req, gwBase, token: ownerTok, version: '0.1.0', note: 'e2e-routine-retry' })
    const dep = await req(gwBase, 'POST', '/runtime/deploy', { token: adminTok, body: { botId } })
    assert(dep.status === 200, `deploy ${dep.status} ${dep.text}`)
    const ready = await req(gwBase, 'POST', `/internal/instances/${accountId}/ready`, {
      token: seatAccess,
      body: { host: seatUrl, botId },
    })
    assert(ready.status === 200, `ready ${ready.status} ${ready.text}`)
    // 机器够新，任务归工人。心跳顺带把「在线」点亮——不在线的机器试跑会被 409 挡在门口。
    const hb = await req(gwBase, 'POST', `/internal/machines/${machine.machineId}/heartbeat`, {
      token: machineTok,
      body: { protocol: 8, managerVersion: 'e2e' },
    })
    assert(hb.status === 200, `心跳 ${hb.status} ${hb.text}`)

    const made = await req(gwBase, 'POST', `/runtime/bots/${botId}/routines`, {
      token: adminTok,
      body: {
        name: '每日简报',
        instruction: '把今天的事说一遍',
        tz: 'UTC',
        triggers: [{ kind: 'schedule', every: 'day', at: '09:00', weekday: 1, day: 1 }],
      },
    })
    assert(made.status === 201, `建任务 ${made.status} ${made.text}`)
    const routineId = made.json.routine.id
    assert(made.json.routine.retryAt === null, `新建的就欠着补跑：${made.json.routine.retryAt}`)
    assert(made.json.routine.retryMax === RETRY_MAX, `retryMax ${made.json.routine.retryMax} != ${RETRY_MAX}`)

    const detail = async () => {
      const r = await req(gwBase, 'GET', `/runtime/routines/${routineId}`, { token: adminTok })
      assert(r.status === 200, `详情 ${r.status} ${r.text}`)
      return r.json
    }
    /** 把「下一次」拨到刚刚过去，等下一个 tick 把它抢走。 */
    const makeDue = async () => {
      await withPg((c) => c.query('update routines set "nextRunAt" = $1 where id = $2', [Date.now() - 1000, routineId]))
    }
    const runsOf = (d, trigger) => (d.runs || []).filter((x) => x.trigger === trigger)

    /**
     * 假工人：来领一趟，领到的每一条都回「没跑起来」。返回这一趟领到的活。
     *
     * `failed` 是「压根没跑起来」那一档——够不着席位、席位那一跳报错——Gateway 记 error 并排补跑
     * （routes/worker.ts 的 routineFinish）。
     */
    const failed = []
    const workOnce = async () => {
      const got = await req(gwBase, 'GET', '/worker/routines/due', { token: machineTok })
      assert(got.status === 200, `due ${got.status} ${got.text}`)
      for (const job of got.json.jobs) {
        const fin = await req(gwBase, 'POST', `/worker/routines/${job.runId}/finish`, {
          token: machineTok,
          body: { kind: 'failed', error: '席位挂了' },
        })
        assert(fin.status === 200, `finish ${fin.status} ${fin.text}`)
        failed.push(job)
      }
      return got.json.jobs
    }
    /** 一边扮工人一边等，直到 `until(详情)` 成立。 */
    const workUntil = async (what, until, ms = 15000) => {
      const deadline = Date.now() + ms
      let d = await detail()
      while (Date.now() < deadline && !until(d)) {
        await workOnce()
        await sleep(150)
        d = await detail()
      }
      assert(until(d), `${what}：${JSON.stringify(d.routine)} ${JSON.stringify(d.runs)}`)
      return d
    }

    await test('试跑砸了不排补跑：人就坐在屏幕前，他要的是这一下的结果', async () => {
      const r = await req(gwBase, 'POST', `/runtime/routines/${routineId}/run`, { token: adminTok, body: {} })
      assert(r.status === 200, `试跑 ${r.status} ${r.text}`)
      assert(r.json.run.status === 'running' && r.json.run.machineId === machine.machineId, `登记的流水不对：${r.text}`)
      const jobs = await workOnce()
      assert(jobs.length === 1 && jobs[0].trigger === 'manual' && jobs[0].runId === r.json.run.id, `工人该领到那条试跑：${JSON.stringify(jobs)}`)
      const d = await detail()
      const last = (d.runs || [])[0]
      assert(last && last.status === 'error', `试跑该记成 error：${JSON.stringify(last)}`)
      assert(String(last.error || '').includes('席位挂了'), `失败原因没照实记：${last.error}`)
      assert(d.routine.retryAt === null, `手点的一下排上了补跑：${d.routine.retryAt}`)
      // 多等两个 tick、多领两趟：排没排上看的是库里那一格，而"排上了但没人跑"看的是这里。
      await sleep(1200)
      await workOnce()
      await sleep(1200)
      await workOnce()
      const after = await detail()
      assert(runsOf(after, 'retry').length === 0, '试跑之后冒出了补跑')
    })

    await test('到点砸了：排下第一次补跑，时刻在未来、次数是 1', async () => {
      const before = failed.length
      await makeDue()
      /**
       * 等的是**补跑排上了**（retryAt 有值），不是「没有在跑的」。
       *
       * 那一轮记成 error 和 `armRetry` 写回 retryAt 之间隔着一次 db 往返，只看「没有在跑的」
       * 正好落进那一两毫秒就会看到「跑完了、但还没排补跑」——retryAt 断言于是在实现完全
       * 正确的情况下报「补跑没排上」。
       */
      const d = await workUntil('到点那一次', (x) => runsOf(x, 'schedule').length === 1 && x.routine.retryAt)
      assert(failed.length > before, '到点那一次没交给工人')
      /**
       * **补跑排在 `retryAt` 上，`nextRunAt` 一动不动。**
       *
       * 写回 `nextRunAt` 的话，一次失败会把人设的「每天 09:00」挪成「09:05」，界面上
       * 那行「下一次」跟着变——他看到的是自己设的时间被系统改掉了。
       */
      assert(d.routine.retryAt > Date.now() - 1000, `补跑没排上：${d.routine.retryAt}`)
      assert(d.routine.retryCount === 1, `第几次不对：${d.routine.retryCount}`)
      const nextDay = new Date(d.routine.nextRunAt)
      assert(
        nextDay.getUTCHours() === 9 && nextDay.getUTCMinutes() === 0,
        `下一次被补跑挪走了：${nextDay.toISOString()}`,
      )
    })

    await test('三次补完就停：不是两次，也不是没完没了', async () => {
      const d = await workUntil('补跑', (x) => runsOf(x, 'retry').length >= RETRY_MAX && !x.routine.retryAt, 20000)
      assert(d.routine.retryAt === null, `补跑停不下来：${d.routine.retryAt}`)
      assert(runsOf(d, 'retry').length === RETRY_MAX, `补了 ${runsOf(d, 'retry').length} 次，该是 ${RETRY_MAX} 次`)
      // 三次之后再领几趟：停不下来的实现要在这儿露头，不然它会每 5 分钟往那条
      // 会话里灌一条，直到有人删了这条任务。
      for (let i = 0; i < 3; i++) {
        await sleep(1000)
        const jobs = await workOnce()
        assert(jobs.length === 0, `停了之后又交出来了：${JSON.stringify(jobs)}`)
      }
      const after = await detail()
      assert(runsOf(after, 'retry').length === RETRY_MAX, `停了之后又补了：${runsOf(after, 'retry').length} 次`)
      assert(after.routine.retryAt === null, `又排上了：${after.routine.retryAt}`)
      // 每一次补跑都真的交给了工人（不是只在库里记了一笔）：试跑 1 + 到点 1 + 补跑 3。
      assert(failed.filter((j) => j.trigger === 'retry').length === RETRY_MAX, `工人只领到 ${failed.length} 条`)
    })

    await test('拨开关把欠着的补跑收掉：关掉的意思就是别自己动', async () => {
      await makeDue()
      const d = await workUntil('新的一次补跑排上', (x) => Boolean(x.routine.retryAt))
      // 到点跑的那一次把上一串一笔勾销：从第 1 次重新数，不是接着第 3 次往下。
      assert(d.routine.retryCount === 1, `到点那一次没把上一串清掉：retryCount=${d.routine.retryCount}`)
      const off = await req(gwBase, 'PATCH', `/runtime/routines/${routineId}`, { token: adminTok, body: { active: false } })
      assert(off.status === 200, `停用 ${off.status} ${off.text}`)
      assert(off.json.routine.retryAt === null, `停用了还欠着补跑：${off.json.routine.retryAt}`)
      const runsBefore = ((await detail()).runs || []).length
      for (let i = 0; i < 3; i++) {
        await sleep(800)
        const jobs = await workOnce()
        assert(jobs.length === 0, `停用之后还交出来了：${JSON.stringify(jobs)}`)
      }
      const after = await detail()
      assert((after.runs || []).length === runsBefore, '停用之后还自己跑了一次')
      assert(after.routine.retryAt === null, `停用之后又排上了：${after.routine.retryAt}`)
    })

    await test('把时间删光也收掉补跑：界面上写着「还没有设定时间」，它就不能再自己动', async () => {
      /**
       * 判据是「重算出来的下一次是不是 null」，不是「有没有拨开关」——这两条路在人那边
       * 是同一句话。少了这一条的表现最难看：21:00 那次失败排下 21:05 的补跑，人 21:02
       * 把唯一那个时间删掉，21:05 这个 Bot 照样自己把指令发了出去，而那一刻这条任务在
       * 列表上写的是「还没有设定时间」。
       */
      const on = await req(gwBase, 'PATCH', `/runtime/routines/${routineId}`, { token: adminTok, body: { active: true } })
      assert(on.status === 200 && on.json.routine.nextRunAt, `重新启用 ${on.status} ${on.text}`)
      await makeDue()
      await workUntil('补跑排上', (x) => Boolean(x.routine.retryAt))
      const bare = await req(gwBase, 'PATCH', `/runtime/routines/${routineId}`, { token: adminTok, body: { triggers: [] } })
      assert(bare.status === 200, `删光时间 ${bare.status} ${bare.text}`)
      assert(bare.json.routine.nextRunAt === null, `下一次没跟着清掉：${bare.json.routine.nextRunAt}`)
      assert(bare.json.routine.retryAt === null, `时间删光了还欠着补跑：${bare.json.routine.retryAt}`)
      // 这条任务还是「启用」的，所以只有那一格真的清干净了才不会再跑。
      const runsBefore = ((await detail()).runs || []).length
      for (let i = 0; i < 3; i++) {
        await sleep(800)
        const jobs = await workOnce()
        assert(jobs.length === 0, `时间删光之后还交出来了：${JSON.stringify(jobs)}`)
      }
      const after = await detail()
      assert((after.runs || []).length === runsBefore, '时间删光之后它还是自己跑了一次')
    })

    await test('Gateway 自己一下都没去敲席位', async () => {
      assert(seat.hits.length === 0, `Gateway 敲了席位 ${seat.hits.length} 下：${seat.hits.join(' ')}`)
    })
  } finally {
    /**
     * **先杀进程，再删它的数据目录。**
     *
     * 不杀的话它活到整场 e2e 的最后一刻（run.mjs 收尾那次 killAll 才轮得到它）：每秒
     * tick 一次、占着 PG 连接、日志混进后面每一个套件的输出里——而它的数据目录已经在
     * 下面这一行里被删掉了。
     */
    gw.kill()
    await closeServer(seat.server, '席位替身')
    try {
      rmSync(GW_HOME, { recursive: true, force: true })
    } catch {}
  }
}
