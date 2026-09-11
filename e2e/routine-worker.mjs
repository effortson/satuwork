/**
 * 日常任务由席位工人来领（docs/adr-gateway-vercel-neon.md §7 第 4 步；gateway/src/routes/worker.ts）。
 *
 * 机器协议 ≥ 7 之后，Gateway 的调度器**不再碰**那台机器上的任务，改由机器凭 `smt_` 来领、
 * 跑完回报。这里没有真的工人，用几条 fetch 扮演它——要钉住的是 Gateway 这一半的规矩：
 *
 *   · 归工人的任务 Gateway 一下都不动；机器不够新时 Gateway **也不自己跑**，记一条「管家太旧」
 *   · 试跑只登记，工人下一趟 due 连同到点的一起领走；没人来领的到点收掉
 *   · 领取即租约；started 那一步查转人工；finish 按 kind 解释
 *   · 租约到期没续 → 记成「机器没回报」并排补跑
 *   · 别的机器的活 404
 *
 * 时间全压到秒级：租约 1.5 秒、调度器一秒扫一次。
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

const SCHEMA = schemaOf('e2e_routine_worker')
const LEASE_MS = 1500
const RETRY_MS = [400, 500, 600]
/** 试跑登记之后多久没人来领就收掉。线上是三分钟；这里压到工人一两趟的量级。 */
const PICKUP_MS = 1500

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
  })
}

/** 假席位：Gateway 要是自己去敲它，就会被记下来——归工人的任务它一下都不该敲。 */
function seatSpy() {
  const hits = []
  const server = createServer((req, res) => {
    hits.push(req.url.split('?')[0])
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: '不该来敲我' }))
  })
  return { server, hits }
}

export async function runRoutineWorker({ gwRoot, test, req, start, waitHttp, assert, log }) {
  log('\n# routine-worker')

  const GW_HOME = tmpOf('satuwork-e2e-routine-worker')
  const GW_PORT = await freePort()
  const gwBase = `http://127.0.0.1:${GW_PORT}`
  rmSync(GW_HOME, { recursive: true, force: true })

  const seat = seatSpy()
  const seatUrl = await listen(seat.server)

  const gw = start('routine-worker-gw', ['--import', 'tsx', join(gwRoot, 'src/index.ts')], {
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
      GATEWAY_OWNER_EMAIL: 'owner@worker.test',
      GATEWAY_OWNER_PASSWORD: 'test-owner-worker',
      SATUWORK_DEPLOY_STUB: '1',
      GATEWAY_ROUTINE_TICK_MS: '1000',
      GATEWAY_ROUTINE_LEASE_MS: String(LEASE_MS),
      GATEWAY_ROUTINE_RETRY_MS: RETRY_MS.join(','),
      GATEWAY_ROUTINE_PICKUP_MS: String(PICKUP_MS),
    },
  })

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
    await waitHttp(gwBase + '/health', { child: gw, what: 'routine-worker gateway' })

    const reg = await createCompany(req, gwBase, {
      ownerEmail: 'owner@worker.test',
      ownerPassword: 'test-owner-worker',
      email: 'admin@worker.test',
      password: 'correct-horse',
      companyName: 'WorkerCo',
      slug: 'workerco',
      seats: 2,
    })
    const adminTok = reg.token
    const ownerTok = reg.ownerToken
    const orgId = reg.company.id
    const me = await req(gwBase, 'GET', '/me', { token: adminTok })
    const accountId = me.json.account.id
    const secrets = await req(gwBase, 'GET', `/platform/accounts/${accountId}`, { token: ownerTok })
    const seatAccess = secrets.json.accessToken

    const madeBot = await req(gwBase, 'POST', '/runtime/bots', { token: adminTok, body: { name: '每日简报' } })
    assert(madeBot.status === 201, `建 Bot ${madeBot.status} ${madeBot.text}`)
    const botId = madeBot.json.bot.id

    const machine = await pairMachine({ req, gwBase, ownerTok, orgId })
    const machineTok = machine.token
    await publishRelease({ req, gwBase, token: ownerTok, version: '0.1.0', note: 'e2e-routine-worker' })
    const dep = await req(gwBase, 'POST', '/runtime/deploy', { token: adminTok, body: { botId } })
    assert(dep.status === 200, `deploy ${dep.status} ${dep.text}`)
    const ready = await req(gwBase, 'POST', `/internal/instances/${accountId}/ready`, {
      token: seatAccess,
      body: { host: seatUrl, botId },
    })
    assert(ready.status === 200, `ready ${ready.status} ${ready.text}`)

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

    const detail = async () => {
      const r = await req(gwBase, 'GET', `/runtime/routines/${routineId}`, { token: adminTok })
      assert(r.status === 200, `详情 ${r.status} ${r.text}`)
      return r.json
    }
    const makeDue = () => withPg((c) => c.query('update routines set "nextRunAt" = $1 where id = $2', [Date.now() - 1000, routineId]))
    const heartbeat = (protocol) =>
      req(gwBase, 'POST', `/internal/machines/${machine.machineId}/heartbeat`, { token: machineTok, body: { protocol, managerVersion: 'e2e' } })
    const due = () => req(gwBase, 'GET', '/worker/routines/due', { token: machineTok })
    const post = (runId, act, body = {}) => req(gwBase, 'POST', `/worker/routines/${runId}/${act}`, { token: machineTok, body })
    const settled = async (what) => {
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        const d = await detail()
        if (!(d.runs || []).some((x) => x.status === 'running')) return d
        await sleep(100)
      }
      assert(false, `${what}：一直有一轮在跑`)
    }

    await test('机器不够新：Gateway 不自己跑，记一条「管家太旧」，不补；工人来领拿到空表', async () => {
      const hb = await heartbeat(6)
      assert(hb.status === 200, `心跳 ${hb.status} ${hb.text}`)
      const empty = await due()
      assert(empty.status === 200 && empty.json.jobs.length === 0, `6 号机器不该领到活：${empty.text}`)
      await makeDue()
      await sleep(2500)
      const d = await settled('管家太旧')
      const run = (d.runs || [])[0]
      assert(run && run.status === 'error', `该记一条 error：${JSON.stringify(d.runs)}`)
      assert(String(run.error).includes('管家太旧'), `原因该写明是管家太旧：${run.error}`)
      assert(run.machineId === null, `没人领走的不该带 machineId：${JSON.stringify(run)}`)
      assert(d.routine.retryAt === null, '跑不了的不该补：五分钟后管家还是那个版本')
      // **Gateway 自己一下都没去敲席位**：以前机器不够新它会自己打进去等二十分钟，那条路收掉了。
      assert(seat.hits.length === 0, `Gateway 敲了席位 ${seat.hits.length} 下：${seat.hits.join(' ')}`)
      const manual = await req(gwBase, 'POST', `/runtime/routines/${routineId}/run`, { token: adminTok, body: {} })
      assert(manual.status === 409 && String(manual.json.error).includes('管家太旧'), `不够新的机器试跑该 409 并说明原因：${manual.status} ${manual.text}`)
    })

    await test('机器升到 7 号：Gateway 一下都不动，工人领到带租约的活', async () => {
      const hb = await heartbeat(7)
      assert(hb.status === 200, `心跳 ${hb.status}`)
      // 先把上一条留下的补跑清掉，别混进这一条的计数里。
      await withPg((c) => c.query('update routines set "retryAt" = null, "retryCount" = 0 where id = $1', [routineId]))
      const before = seat.hits.length
      await makeDue()
      await sleep(2500)
      assert(seat.hits.length === before, `归工人的任务 Gateway 还在敲席位：多了 ${seat.hits.length - before} 下`)
      const d0 = await detail()
      assert(!(d0.runs || []).some((x) => x.status === 'running'), 'Gateway 不该给归工人的任务开流水')

      const anon = await req(gwBase, 'GET', '/worker/routines/due')
      assert(anon.status === 401, `无票 ${anon.status}`)
      const got = await due()
      assert(got.status === 200, `due ${got.status} ${got.text}`)
      assert(got.json.jobs.length === 1, `该领到 1 条，领到 ${got.json.jobs.length}`)
      const job = got.json.jobs[0]
      assert(job.routineId === routineId && job.botId === botId && job.instruction === '把今天的事说一遍', `活的内容不对：${JSON.stringify(job)}`)
      assert(job.seatId && job.leaseMs === LEASE_MS && job.timeoutMs > 0, `活上缺字段：${JSON.stringify(job)}`)
      const again = await due()
      assert(again.json.jobs.length === 0, '同一条不该领两次')
      const d1 = await detail()
      const run = (d1.runs || []).find((x) => x.id === job.runId)
      assert(run && run.status === 'running' && run.machineId === machine.machineId, `流水该是 running 且归这台机器：${JSON.stringify(run)}`)

      const started = await post(job.runId, 'started', { sessionId: 's-worker-1' })
      assert(started.status === 200 && started.json.blocked === null, `started ${started.status} ${started.text}`)
      const renewed = await post(job.runId, 'renew')
      assert(renewed.status === 200, `renew ${renewed.status}`)
      const fin = await post(job.runId, 'finish', { kind: 'completed', sessionId: 's-worker-1' })
      assert(fin.status === 200, `finish ${fin.status} ${fin.text}`)
      const d2 = await detail()
      const done = (d2.runs || []).find((x) => x.id === job.runId)
      assert(done.status === 'ok' && done.sessionId === 's-worker-1', `该记成 ok：${JSON.stringify(done)}`)
      assert(d2.routine.retryAt === null, '跑成了不该欠补跑')
      const late = await post(job.runId, 'renew')
      assert(late.status === 404, `收场之后再续该 404：${late.status}`)
    })

    await test('工人说没跑起来：记 error 并排补跑；补跑也由工人来领', async () => {
      await makeDue()
      await sleep(1200)
      const got = await due()
      assert(got.json.jobs.length === 1, `该领到 1 条：${got.text}`)
      const job = got.json.jobs[0]
      const fin = await post(job.runId, 'finish', { kind: 'failed', error: '席位没起来' })
      assert(fin.status === 200, `finish ${fin.status}`)
      const d = await detail()
      const run = (d.runs || []).find((x) => x.id === job.runId)
      assert(run.status === 'error' && run.error === '席位没起来', `失败原因没照实记：${JSON.stringify(run)}`)
      assert(d.routine.retryAt !== null && d.routine.retryCount === 1, `该排上第 1 次补跑：${JSON.stringify(d.routine)}`)
      await sleep(RETRY_MS[0] + 300)
      const retry = await due()
      assert(retry.json.jobs.length === 1 && retry.json.jobs[0].trigger === 'retry', `补跑该由工人领到：${retry.text}`)
      const fin2 = await post(retry.json.jobs[0].runId, 'finish', { kind: 'aborted' })
      assert(fin2.status === 200, `finish ${fin2.status}`)
      const d2 = await detail()
      assert(d2.routine.retryAt === null, '人按了停止的那一轮不该再补')
    })

    await test('租约到期没续：记成「机器没回报」并排补跑', async () => {
      await makeDue()
      await sleep(1200)
      const got = await due()
      assert(got.json.jobs.length === 1, `该领到 1 条：${got.text}`)
      const job = got.json.jobs[0]
      // 不续、不回报，等 Gateway 的清扫来收。租约 1.5 秒 + 一个 tick。
      await sleep(LEASE_MS + 1500)
      const d = await detail()
      const run = (d.runs || []).find((x) => x.id === job.runId)
      assert(run && run.status === 'error' && String(run.error).includes('机器没回报'), `该被收成「机器没回报」：${JSON.stringify(run)}`)
      assert(d.routine.retryAt !== null, '收掉之后该排补跑')
      const stale = await post(job.runId, 'finish', { kind: 'completed' })
      assert(stale.status === 404, `被收掉的活再回报该 404：${stale.status}`)
      await withPg((c) => c.query('update routines set "retryAt" = null, "retryCount" = 0 where id = $1', [routineId]))
    })

    await test('转人工挡着：started 直接收成 error，不补', async () => {
      await withPg((c) =>
        c.query(
          `insert into handoffs (id, "companyId", "accountId", "botId", "sessionId", ask, reason, blocking, state, "createdAt", "updatedAt")
           values ('h-block', $1, $2, $3, 's-worker-2', '要人签字', '没权限', true, 'open', $4, $4)`,
          [orgId, accountId, botId, Date.now()],
        ),
      )
      await makeDue()
      await sleep(1200)
      const got = await due()
      assert(got.json.jobs.length === 1, `该领到 1 条：${got.text}`)
      const job = got.json.jobs[0]
      const started = await post(job.runId, 'started', { sessionId: 's-worker-2' })
      assert(started.status === 200 && started.json.blocked, `该被挡住：${started.text}`)
      const d = await detail()
      const run = (d.runs || []).find((x) => x.id === job.runId)
      assert(run.status === 'error' && String(run.error).includes('转人工'), `流水该写明是转人工挡的：${JSON.stringify(run)}`)
      assert(d.routine.retryAt === null, '转人工挡着的不该补')
    })

    await test('试跑只登记：界面立刻拿到转圈的流水，工人下一趟 due 连同到点的一起领走', async () => {
      // 再报一次心跳：登记那一步先看机器在不在线，上一次心跳离现在要是超过三轮就成「离线」了。
      assert((await heartbeat(7)).status === 200, '心跳')
      const r = await req(gwBase, 'POST', `/runtime/routines/${routineId}/run`, { token: adminTok, body: {} })
      assert(r.status === 200, `试跑 ${r.status} ${r.text}`)
      const run0 = r.json.run
      assert(run0.status === 'running' && run0.trigger === 'manual' && run0.sessionId === null, `登记的流水不对：${r.text}`)
      assert(run0.machineId === machine.machineId, `该登记给这台机器：${run0.machineId}`)
      const twice = await req(gwBase, 'POST', `/runtime/routines/${routineId}/run`, { token: adminTok, body: {} })
      assert(twice.status === 409, `没人领走之前再点一下该 409：${twice.status}`)
      const before = seat.hits.length
      const got = await due()
      assert(got.json.jobs.length === 1, `工人该领到那条试跑：${got.text}`)
      const job = got.json.jobs[0]
      assert(job.runId === run0.id && job.trigger === 'manual' && job.instruction === '把今天的事说一遍', `活的内容不对：${JSON.stringify(job)}`)
      assert((await due()).json.jobs.length === 0, '同一条试跑不该领两次')
      const started = await post(job.runId, 'started', { sessionId: 's-manual' })
      assert(started.status === 200 && started.json.blocked === null, `started ${started.status} ${started.text}`)
      const fin = await post(job.runId, 'finish', { kind: 'failed', error: '席位挂了' })
      assert(fin.status === 200, `finish ${fin.status}`)
      const d = await detail()
      const done = (d.runs || []).find((x) => x.id === job.runId)
      assert(done.status === 'error' && done.error === '席位挂了' && done.sessionId === 's-manual', `该照实记：${JSON.stringify(done)}`)
      assert(d.routine.retryAt === null, '试跑砸了不补')
      assert(seat.hits.length === before, 'Gateway 不该自己去敲席位')
    })

    await test('登记了一直没人来领的试跑：到点收成 error，话说明是没人领', async () => {
      const r = await req(gwBase, 'POST', `/runtime/routines/${routineId}/run`, { token: adminTok, body: {} })
      assert(r.status === 200, `试跑 ${r.status} ${r.text}`)
      // 不领。等过 PICKUP_MS 再加一个 tick。
      await sleep(PICKUP_MS + 1500)
      const d = await detail()
      const run = (d.runs || []).find((x) => x.id === r.json.run.id)
      assert(run && run.status === 'error' && String(run.error).includes('没有机器来领'), `该被收成「没人来领」：${JSON.stringify(run)}`)
      assert((await due()).json.jobs.length === 0, '收掉的试跑不该再交出去')
    })

    await test('别的机器领不到、也回报不了这台机器的活', async () => {
      const other = await pairMachine({ req, gwBase, ownerTok, orgId, managerPort: 18998 })
      const got = await req(gwBase, 'GET', '/worker/routines/due', { token: other.token })
      assert(got.status === 200 && got.json.jobs.length === 0, `别的机器不该领到活：${got.text}`)
      await makeDue()
      await sleep(1200)
      const mine = await due()
      assert(mine.json.jobs.length === 1, `该领到 1 条：${mine.text}`)
      const job = mine.json.jobs[0]
      const steal = await req(gwBase, 'POST', `/worker/routines/${job.runId}/finish`, { token: other.token, body: { kind: 'completed' } })
      assert(steal.status === 404, `别的机器回报该 404：${steal.status}`)
      const fin = await post(job.runId, 'finish', { kind: 'completed' })
      assert(fin.status === 200, `自己回报 ${fin.status}`)
    })
  } finally {
    gw.kill('SIGTERM')
    await closeServer(seat.server)
  }
}
