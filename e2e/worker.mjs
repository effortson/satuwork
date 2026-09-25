/**
 * 席位工人，**整条链路**：Gateway ← 真管家（dryRun）← 真工人进程 → 假 bot。
 *
 * routine-worker 那一套用几条 fetch 扮工人，钉的是 Gateway 的规矩；这里钉的是机器那一半：
 * 工人手上没有凭据也能领活、跑完、回报——凭据都由管家的中继口替它出示；到 bot 的票是名册
 * 里那个席位的 `sat_`，不是浏览器的、也不是 Gateway 账号的。
 */
import { createServer } from 'node:http'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { createCompany } from './org.mjs'
import { publishRelease } from './release.mjs'
import { freePorts } from './ports.mjs'
import { closeServer } from './probe.mjs'
import { TOKEN as TG_TOKEN, mockTelegram } from './channels.mjs'

const SCHEMA = schemaOf('e2e_worker')

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 假 bot：会话 id、一条历史、事件流、收消息。收到消息就往开着的事件流上吐
 * user/message → turn/start → turn/end(completed)，也就是一轮跑完的样子。
 */
function liveBot() {
  const seen = []
  const streams = []
  const channelHits = []
  const server = createServer((req, res) => {
    seen.push({ path: req.url, auth: req.headers.authorization || '', machine: req.headers['x-satuwork-machine'] || '' })
    if (/^\/api\/bots\/[^/]+\/session/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ sessionId: 's-live' }))
      return
    }
    if (req.url.startsWith('/api/sessions/s-live/history')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ events: [{ seq: 5, type: 'assistant/message' }] }))
      return
    }
    if (req.url.startsWith('/api/sessions/s-live/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': hi\n\n')
      streams.push(res)
      return
    }
    // 渠道那一轮：第一下 202「还在跑」带一帧草稿，第二下 200 给出最终回复。
    if (/^\/api\/channels\/[^/]+\/messages/.test(req.url)) {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        seen[seen.length - 1].body = JSON.parse(raw || '{}')
        channelHits.push(seen[seen.length - 1])
        // 头 1.2 秒一直说「还在跑」：草稿泵要等过 initialWaitMs 才会刷第一帧，收口太快就一帧都不发
        // （和 Gateway 自己跑时一样）。
        channelHits.firstAt ??= Date.now()
        if (Date.now() - channelHits.firstAt < 1200) {
          res.writeHead(202, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ status: 'running', draft: '我先看看' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ sessionId: 's-channel', reply: '好的，办妥了', files: [], handoffs: [] }))
      })
      return
    }
    if (req.url.startsWith('/api/sessions/s-live/messages')) {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        const body = JSON.parse(raw || '{}')
        seen[seen.length - 1].body = body
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ accepted: true }))
        setTimeout(() => {
          for (const s of streams) {
            s.write(`data: ${JSON.stringify({ type: 'user/message', seq: 6, data: { message: { content: body.text } } })}\n\n`)
            s.write(`data: ${JSON.stringify({ type: 'turn/start', seq: 7, data: { turn: 3 } })}\n\n`)
            s.write(`data: ${JSON.stringify({ type: 'turn/end', seq: 8, data: { turn: 3, reason: 'completed' } })}\n\n`)
          }
        }, 50)
      })
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, path: req.url }))
  })
  return { server, seen, streams, channelHits }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server.address().port))
  })
}

export async function runWorker({ root, gwRoot, test, req, start, waitHttp, assert, log }) {
  log('\n# worker')

  const managerRoot = join(root, 'manager')
  const GW_HOME = tmpOf('satuwork-e2e-worker-gw')
  const MGR_HOME = tmpOf('satuwork-e2e-worker-mgr')
  const [GW_PORT, MGR_PORT, BOT_PORT] = await freePorts(3)
  const gwBase = `http://127.0.0.1:${GW_PORT}`
  const mgrBase = `http://127.0.0.1:${MGR_PORT}`
  rmSync(GW_HOME, { recursive: true, force: true })
  rmSync(MGR_HOME, { recursive: true, force: true })

  const bot = liveBot()
  await listen(bot.server, BOT_PORT)
  const telegram = await mockTelegram()

  const gw = start('worker-gw', ['--import', 'tsx', join(gwRoot, 'src/index.ts')], {
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
      GATEWAY_OWNER_EMAIL: 'owner@wk.test',
      GATEWAY_OWNER_PASSWORD: 'test-owner-wk',
      SATUWORK_DEPLOY_STUB: '1',
      GATEWAY_ROUTINE_TICK_MS: '1000',
      GATEWAY_ROUTINE_LEASE_MS: '3000',
      TELEGRAM_API_BASE: telegram.url,
      // 渠道扫描调快：归工人的事件 Gateway 不碰，但要它快点把「已跑完只差投递」的和别的收掉。
      GATEWAY_CHANNEL_TICK_MS: '500',
      GATEWAY_CHANNEL_POLL_SCAN_MS: '600000',
    },
  })
  let mgr = null
  let worker = null

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
    await waitHttp(gwBase + '/health', { child: gw, what: 'worker gateway' })
    const reg = await createCompany(req, gwBase, {
      ownerEmail: 'owner@wk.test',
      ownerPassword: 'test-owner-wk',
      email: 'admin@wk.test',
      password: 'correct-horse',
      companyName: 'WkCo',
      slug: 'wkco',
      seats: 2,
    })
    const adminTok = reg.token
    const ownerTok = reg.ownerToken
    const orgId = reg.company.id

    // 真管家：自己配对（Gateway 会回拨 /health），心跳自报 7 号协议。
    const code = await req(gwBase, 'POST', `/platform/orgs/${orgId}/pairing-code`, { token: ownerTok })
    assert(code.status === 201, `pairing-code ${code.status}`)
    mgr = start('worker-mgr', ['--import', 'tsx', join(managerRoot, 'bin/satuwork-manager.mjs')], {
      cwd: managerRoot,
      env: {
        SATUWORK_MANAGER_HOME: MGR_HOME,
        SATUWORK_MANAGER_HOST: '127.0.0.1',
        SATUWORK_MANAGER_PORT: String(MGR_PORT),
        SATUWORK_MANAGER_DRYRUN: '1',
        GATEWAY_URL: gwBase,
        SATUWORK_PAIRING_CODE: code.json.code,
      },
    })
    let machineTok = ''
    await test('管家配上了、报的是 7 号协议、写出了工人的令牌', async () => {
      for (let i = 0; i < 100 && !existsSync(join(MGR_HOME, 'manager.json')); i++) await sleep(200)
      assert(existsSync(join(MGR_HOME, 'manager.json')), '管家没配上')
      const m = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      assert(m.status === 200 && m.json.machine.paired, `machine ${m.status} ${m.text}`)
      machineTok = m.json.machine.token
      assert(m.json.machine.protocol >= 7, `协议 ${m.json.machine.protocol}`)
      assert(existsSync(join(MGR_HOME, 'worker.env')), '没写 worker.env')
      const env = readFileSync(join(MGR_HOME, 'worker.env'), 'utf8')
      assert(/SATUWORK_WORKER_TOKEN=swk_/.test(env) && env.includes(`SATUWORK_MANAGER_LOCAL=http://127.0.0.1:${MGR_PORT}`), `worker.env 内容不对：${env}`)
    })

    const envOf = () => Object.fromEntries(readFileSync(join(MGR_HOME, 'worker.env'), 'utf8').split('\n').filter(Boolean).map((l) => l.split('=')))

    await test('中继口只认本机工人的令牌，而且只转 /worker 底下', async () => {
      const anon = await fetch(`${mgrBase}/w-local/gateway/worker/routines/due`)
      assert(anon.status === 401, `无令牌 ${anon.status}`)
      const wrong = await fetch(`${mgrBase}/w-local/gateway/worker/routines/due`, { headers: { 'x-satuwork-worker': 'swk_nope' } })
      assert(wrong.status === 401, `错令牌 ${wrong.status}`)
      const tok = envOf().SATUWORK_WORKER_TOKEN
      const ok = await fetch(`${mgrBase}/w-local/gateway/worker/routines/due`, { headers: { 'x-satuwork-worker': tok } })
      const okText = await ok.text()
      assert(ok.status === 200, `中继领活 ${ok.status} ${okText}`)
      const body = JSON.parse(okText)
      assert(Array.isArray(body.jobs), `中继回来的不是领活的形状：${JSON.stringify(body)}`)
      const elsewhere = await fetch(`${mgrBase}/w-local/gateway/internal/machines`, { headers: { 'x-satuwork-worker': tok } })
      assert(elsewhere.status === 404, `/worker 之外的路径不该被转：${elsewhere.status}`)
    })

    // 建 Bot、部署（stub），把管家名册里对应的席位指到假 bot。
    const me = await req(gwBase, 'GET', '/me', { token: adminTok })
    const accountId = me.json.account.id
    const madeBot = await req(gwBase, 'POST', '/runtime/bots', { token: adminTok, body: { name: '每日简报' } })
    assert(madeBot.status === 201, `建 Bot ${madeBot.status} ${madeBot.text}`)
    const botId = madeBot.json.bot.id
    await publishRelease({ req, gwBase, token: ownerTok, version: '0.1.0', note: 'e2e-worker' })
    const dep = await req(gwBase, 'POST', '/runtime/deploy', { token: adminTok, body: { botId } })
    assert(dep.status === 200, `deploy ${dep.status} ${dep.text}`)
    const bots = await req(gwBase, 'GET', '/runtime/bots', { token: adminTok })
    const seatId = bots.json.bots.find((b) => b.id === botId).runtime.seatId
    assert(seatId, `没有 seatId：${bots.text}`)
    const linuxUser = seatId.split('-').slice(0, 2).join('-')
    const put = await req(mgrBase, 'PUT', `/seats/${seatId}`, {
      token: machineTok,
      body: {
        linuxUser,
        homeDir: `/home/${linuxUser}`,
        workDir: `/home/${linuxUser}/work`,
        seatDir: `/home/${linuxUser}/.satuwork/${seatId}`,
        botId,
        botVersion: '0.1.0',
        vncPassword: 'x'.repeat(16),
        gatewayUrl: gwBase,
        gatewayToken: 'sat_e2e_worker',
        gatewayApiKey: 'sk_sw_e2e_worker',
        ports: { display: 10, vncPort: 5910, novncPort: BOT_PORT, botPort: BOT_PORT, cdpPort: 9222 },
      },
    })
    assert(put.status === 200, `管家名册登记席位 ${put.status} ${put.text}`)

    const made = await req(gwBase, 'POST', `/runtime/bots/${botId}/routines`, {
      token: adminTok,
      body: { name: '每日简报', instruction: '把今天的事说一遍', tz: 'UTC', triggers: [{ kind: 'schedule', every: 'day', at: '09:00', weekday: 1, day: 1 }] },
    })
    assert(made.status === 201, `建任务 ${made.status} ${made.text}`)
    const routineId = made.json.routine.id
    const detail = async () => (await req(gwBase, 'GET', `/runtime/routines/${routineId}`, { token: adminTok })).json

    await test('工人进程：没有任何凭据，凭本机令牌领活、跑完、回报 ok', async () => {
      const env = envOf()
      worker = start('worker', ['--import', 'tsx', join(managerRoot, 'bin/satuwork-worker.mjs')], {
        cwd: managerRoot,
        env: { SATUWORK_WORKER_TOKEN: env.SATUWORK_WORKER_TOKEN, SATUWORK_MANAGER_LOCAL: env.SATUWORK_MANAGER_LOCAL, SATUWORK_WORKER_TICK_MS: '1000' },
      })
      await withPg((c) => c.query('update routines set "nextRunAt" = $1 where id = $2', [Date.now() - 1000, routineId]))
      let run = null
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        const d = await detail()
        run = (d.runs || [])[0]
        if (run && run.status !== 'running') break
        await sleep(200)
      }
      assert(run, '没有流水')
      assert(run.status === 'ok', `该跑成：${JSON.stringify(run)}`)
      assert(run.sessionId === 's-live', `会话 id 没回报：${JSON.stringify(run)}`)
      const m = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      assert(run.machineId === m.json.machine.id, `该归这台机器：${run.machineId}`)
      // 到 bot 的每一条都是名册里那把席位票；没有一条带机器票，也没有一条是 Gateway 账号的票。
      assert(bot.seen.length >= 4, `bot 收到的太少：${JSON.stringify(bot.seen.map((x) => x.path))}`)
      for (const x of bot.seen) {
        assert(x.auth === 'Bearer sat_e2e_worker', `到 bot 的票不对：${x.path} ${x.auth}`)
        assert(!x.machine, `机器票漏到了 bot：${x.path}`)
      }
      const msg = bot.seen.find((x) => x.path.startsWith('/api/sessions/s-live/messages'))
      assert(msg && msg.body.text === '把今天的事说一遍' && msg.body.routine && msg.body.routine.name === '每日简报', `消息内容不对：${JSON.stringify(msg && msg.body)}`)
      // 默认是 daily = 不覆盖，所以这一条什么都不带（见 docs/routines.md §4）。
      assert(msg.body.modelRole === undefined, `默认该按 daily 跑、不带 modelRole：${JSON.stringify(msg.body)}`)
    })

    await test('渠道那一轮由工人跑：进度经 Gateway 代发到 Telegram，最终回复投递、事件收成 delivered', async () => {
      const m = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      assert(m.json.machine.protocol >= 8, `协议 ${m.json.machine.protocol}`)
      const bound = await req(gwBase, 'POST', '/channels/telegram', { token: adminTok, body: { token: TG_TOKEN } })
      assert(bound.status === 201, `绑定 ${bound.status} ${bound.text}`)
      const bindingId = bound.json.channel.id
      const chBotId = bound.json.channel.botId || (await withPg((c) => c.query('select "botId" from channel_bindings where id = $1', [bindingId]))).rows[0].botId
      // 绑渠道顺手部署了那颗 Bot（stub）；把管家名册里对应的席位指到假 bot。
      const list = await req(gwBase, 'GET', '/runtime/bots', { token: adminTok })
      const chSeat = list.json.bots.find((b) => b.id === chBotId).runtime.seatId
      assert(chSeat, `渠道 Bot 没有 seatId：${list.text}`)
      const lu = chSeat.split('-').slice(0, 2).join('-')
      const put = await req(mgrBase, 'PUT', `/seats/${chSeat}`, {
        token: machineTok,
        body: {
          linuxUser: lu, homeDir: `/home/${lu}`, workDir: `/home/${lu}/work`, seatDir: `/home/${lu}/.satuwork/${chSeat}`,
          botId: chBotId, botVersion: '0.1.0', vncPassword: 'x'.repeat(16), gatewayUrl: gwBase,
          gatewayToken: 'sat_e2e_channel', gatewayApiKey: 'sk_sw_e2e_channel',
          ports: { display: 11, vncPort: 5911, novncPort: BOT_PORT, botPort: BOT_PORT, cdpPort: 9223 },
        },
      })
      assert(put.status === 200, `登记渠道席位 ${put.status} ${put.text}`)
      // 直接造一个已配对身份和一条待处理事件，省掉 Telegram 那几步往返（那些在 channels 套件里钉）。
      const now = Date.now()
      await withPg((c) =>
        c.query(
          `insert into channel_identities (id,"bindingId","externalUserId","externalUsername","externalDisplayName","pairedEventId","pairedAt","lastSeenAt")
           values ('id-1',$1,'456','alice','Alice','tg:0',$2,$2)`,
          [bindingId, now],
        ),
      )
      await withPg((c) =>
        c.query(
          `insert into channel_events (id,"bindingId","externalEventId","externalConversationId","remoteUserId","remoteDisplayName",title,text,status,attempts,"nextTryAt","leaseUntil","leaseToken","sessionId",reply,files,handoffs,"lastError","createdAt","updatedAt","deliveredAt")
           values ('ev-1',$1,'tg:100','456','456','Alice','', '帮我办件事','pending',0,$2,null,'',null,'','[]','[]',null,$2,$2,null)`,
          [bindingId, now],
        ),
      )
      let row = null
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        row = (await withPg((c) => c.query('select status, reply, "sessionId", "lastError" from channel_events where id = $1', ['ev-1']))).rows[0]
        if (row && (row.status === 'delivered' || row.status === 'dead')) break
        await sleep(250)
      }
      assert(row && row.status === 'delivered', `事件该 delivered：${JSON.stringify(row)}`)
      assert(row.reply === '好的，办妥了' && row.sessionId === 's-channel', `结果没记对：${JSON.stringify(row)}`)
      // 席位那一跳是工人打的：带名册里那把票，问了两次（202 → 200）。
      assert(bot.channelHits.length >= 2, `席位该被问不止一次，实际 ${bot.channelHits.length}`)
      for (const h of bot.channelHits) assert(h.auth === 'Bearer sat_e2e_channel', `到席位的票不对：${h.auth}`)
      assert(bot.channelHits[0].body.eventId === 'tg:100' && bot.channelHits[0].body.text === '帮我办件事', `发给席位的内容不对：${JSON.stringify(bot.channelHits[0].body)}`)
      // Telegram 那一跳是 Gateway 打的：typing、草稿、最终回复都到了。
      assert(telegram.seen.chatActions.some((a) => String(a.chat_id) === '456'), '没发 typing')
      assert(telegram.seen.drafts.some((d) => String(d.chat_id) === '456' && String(d.text || '').includes('我先看看')), `没发草稿：${JSON.stringify(telegram.seen.drafts)}`)
      const final = telegram.seen.sent.find((s) => String(s.chat_id) === '456')
      assert(final && String(final.text || (final.rich_message && final.rich_message.markdown) || '').includes('好的，办妥了'), `最终回复没到：${JSON.stringify(telegram.seen.sent)}`)
    })
  } finally {
    await closeServer(telegram.server).catch(() => {})
    for (const s of bot.streams) {
      try {
        s.end()
      } catch {}
    }
    worker?.kill('SIGTERM')
    mgr?.kill('SIGTERM')
    gw.kill('SIGTERM')
    await closeServer(bot.server)
  }
}
