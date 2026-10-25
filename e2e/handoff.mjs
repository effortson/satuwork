/**
 * 转人工：**闭环真的闭上了**（见 docs/handoff.md）。
 *
 * 两段。第一段是席位内的状态机（探针在 bot/e2e-handoff.mjs）；第二段是 Gateway 这一侧
 * ——待办清单、跨人接手、交还真的打到了席位、以及**没人接的时候会发生什么**。
 *
 * 为什么值得单开一个套件：这一层坏了**不报错**。工具照样返回一句「已经交给人了」，
 * 会话日志里也照样有那条记录——而单子没报上来、通知没发出去、超时没人收，界面上和
 * 日志里看到的东西一模一样。只有对着真的 HTTP 跑一遍，才看得出「交出去」之后到底
 * 有没有人被等着。
 *
 * 席位这一头是个**假席位**：一个小 HTTP 服务，按席位的接口形状回话。真席位那一侧
 * 由探针盖住了，这里要验的是 Gateway 够不够得着它、以及够不着时会怎样。
 */
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createTls } from 'node:https'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pgClient } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'

/** 这一套自己的 schema。写死名字会被别的 worktree 的 e2e 清掉（见 pg.mjs 的 schemaOf）。 */
const SCHEMA = schemaOf('e2e_handoff')
import { createCompany } from './org.mjs'
import { publishRelease } from './release.mjs'
import { pairMachine } from './pair.mjs'
import { freePort } from './ports.mjs'
import { runProbe as sharedProbe, closeServer } from './probe.mjs'
import { startGateway } from './gateway.mjs'
import { sleep } from './harness.mjs'

const runProbe = (root) => sharedProbe(root, 'bot/e2e-handoff.mjs', { timeout: 30_000 })

const all = (obj) => Object.entries(obj).filter(([, v]) => v !== true).map(([k]) => k)

/** 假席位：只认交接那几条路由，把收到的 body 记下来给断言看。 */
function fakeSeat() {
  const calls = []
  /** 每张单各记各的接手人。用一个全局标志的话，第二张单会被第一张的记录挡住。 */
  const claimed = new Map()
  /** 席位上「还开着」的那几张。列表路由照它答，用例可以往里塞正文。 */
  const opened = new Map()
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let parsed = {}
      try {
        parsed = body ? JSON.parse(body) : {}
      } catch {}
      const m = /\/api\/sessions\/([^/]+)\/handoffs(?:\/([^/]+)\/(\w+))?$/.exec(req.url.split('?')[0])
      if (!m) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"error":"not found"}')
        return
      }
      const [, sessionId, hid, act] = m
      calls.push({ act: act || 'list', sessionId, hid, body: parsed, auth: req.headers.authorization || '' })
      const reply = (status, json) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(json))
      }
      if (!act) {
        // 席位那边才有正文（Bot 做到哪一步）。Gateway 那张表只留了 reason / ask 各一段。
        return reply(200, {
          handoffs: [...opened.values()].filter((h) => h.sessionId === sessionId),
          blocking: false,
        })
      }
      if (act === 'claim') {
        // 席位是抢单的权威：第二个人拿到的是 409 加一句「被谁接走了」。
        const who = claimed.get(hid)
        if (who) return reply(409, { error: `已经由 ${who} 接手`, handoff: { state: 'claimed' } })
        claimed.set(hid, parsed.actor?.name || '某人')
        return reply(200, {
          ok: true,
          handoff: { state: 'claimed', claimedBy: parsed.actor, updatedAt: Date.now() },
        })
      }
      if (act === 'return') return reply(200, { ok: true, handoff: { state: 'returned', updatedAt: Date.now() }, resumed: true })
      if (act === 'expire') return reply(200, { ok: true, handoff: { state: 'expired', updatedAt: Date.now() } })
      if (act === 'cancel') return reply(200, { ok: true, handoff: { state: 'cancelled', updatedAt: Date.now() } })
      return reply(400, { error: 'unknown act' })
    })
  })
  return { server, calls, claimed, opened }
}

/**
 * 假群机器人：收 webhook 的那一头。
 *
 * **必须是 https**，因为真代码只往 https 发（那条 URL 是一把凭据，见 notify）。
 * 为此现签一张自签证书，并且只给这一个子进程放开校验——把测试凑合成 http，测的就
 * 不是线上真正会跑的那条分支了。openssl 不在时退回 http，那一条断言会自己说明。
 */
function selfSigned() {
  const dir = mkdtempSync(join(tmpdir(), 'satuwork-hook-'))
  const key = join(dir, 'k.pem')
  const cert = join(dir, 'c.pem')
  const r = spawnSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1',
     '-addext', 'subjectAltName=IP:127.0.0.1'],
    { stdio: 'ignore' },
  )
  if (r.status !== 0) return null
  return { dir, key: readFileSync(key), cert: readFileSync(cert) }
}

function fakeHook(tls) {
  const posts = []
  const handler = (req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try {
        posts.push(JSON.parse(body))
      } catch {
        posts.push({ raw: body })
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  }
  const server = tls ? createTls({ key: tls.key, cert: tls.cert }, handler) : createServer(handler)
  return { server, posts, secure: Boolean(tls) }
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
  })
}

export async function runHandoff({ root, gwRoot, test, req, start, waitHttp, assert, log, skip }) {
  log('\n# handoff')

  // ── 第一段：席位内的状态机 ─────────────────────────────────────────
  const p = await runProbe(root)

  await test('开单：状态、事件、上报、挡住日常任务', () => {
    const bad = all(p.opened)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })

  await test('同一件事只开一张单', () => {
    const bad = all(p.dedupe)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })

  await test('抢单：一个人接到，另一个人知道被谁接走了', () => {
    const bad = all(p.claim)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })

  await test('交还：进「已交还」，等 Bot 消化完才闭合', () => {
    const bad = all(p.finish).concat(all(p.closed))
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })

  await test('交还给模型的话说得出谁做了什么、接下来做什么', () => {
    // 含糊成一句「已处理」的话，模型下一步多半是把人刚做完的事再做一遍。
    const bad = all(p.message)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })

  await test('没人接也有终态，而且会告诉 Bot 别再等', () => {
    const bad = all(p.expire)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })

  await test('单子活过席位重启', () => {
    // 这是它和高风险确认最大的差别：那一个是纯内存的，丢了的方向是多问一次；
    // 这一个丢了，就是一件没人做、也没人知道没人做的事。
    const bad = all(p.restart)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })

  await test('两头的路径对得上：Gateway 打的那几下席位都认', () => {
    /**
     * **假席位盖不住这一条。** 上面那半段用的是我们自己写的 mock，它当然认得出
     * Gateway 发过来的路径；真席位那几条路由是另一份代码，改一个名字这边不会红——
     * 而症状是运行时一个 404：人点「接手」什么都不发生，日志里只有一行 404。
     *
     * 所以直接对着两边的源码比一次：Gateway 用到的每一个动作，席位都必须注册过。
     */
    const seatSrc = readFileSync(join(root, 'bot/src/web/index.ts'), 'utf8')
    const gwSrc = readFileSync(join(root, 'gateway/src/routes/handoffs.ts'), 'utf8')
    const sweepSrc = readFileSync(join(root, 'gateway/src/handoff-sweep.ts'), 'utf8')
    const registered = new Set(
      [...seatSrc.matchAll(/'\/api\/sessions\/:id\/handoffs\/:hid\/(\w+)'/g)].map((m) => m[1]),
    )
    assert(registered.size >= 4, `席位注册的动作太少：${[...registered]}`)
    const used = new Set([...`${gwSrc}${sweepSrc}`.matchAll(/callSeat\(db, h, '(\w+)'/g)].map((m) => m[1]))
    assert(used.size >= 4, `Gateway 用到的动作太少：${[...used]}`)
    const missing = [...used].filter((a) => !registered.has(a))
    assert(!missing.length, `席位不认这几下：${missing.join('、')}`)
    // 会话那条 GET 也要在（界面刷新后靠它核对）。
    assert(seatSrc.includes("'/api/sessions/:id/handoffs'"), '席位少了那条列表路由')
  })

  // ── 第二段：Gateway 这一侧 ─────────────────────────────────────────
  const GW_HOME = tmpOf('satuwork-e2e-handoff')
  const GW_PORT = await freePort()
  const gwBase = `http://127.0.0.1:${GW_PORT}`

  const seat = fakeSeat()
  const tls = selfSigned()
  const hook = fakeHook(tls)
  const seatUrl = await listen(seat.server)
  const hookUrl = (hook.secure ? 'https' : 'http') + '://' + (await listen(hook.server)).split('://')[1]

  /** 放进 try 里起：起不来时下面的 finally 照样收掉这一套自己开的假服务。 */
  let gw

  try {
    gw = (await startGateway({
      name: 'handoff-gw',
      what: 'handoff gateway',
      home: GW_HOME,
      schema: SCHEMA,
      port: GW_PORT,
      env: {
        GATEWAY_ACCESS_HOST: 'satuwork.com',
        GATEWAY_SEED_OWNER: '1',
        GATEWAY_OWNER_EMAIL: 'owner@handoff.test',
        GATEWAY_OWNER_PASSWORD: 'test-owner-handoff',
        SATUWORK_DEPLOY_STUB: '1',
        // 自签证书只对这一个子进程放开。测 https 那条分支的代价就是这一行。
        ...(hook.secure ? { NODE_TLS_REJECT_UNAUTHORIZED: '0' } : {}),
        // 假群机器人听在本机：SSRF 闸对这一个子进程放开，生产没有这个变量。
        GATEWAY_HANDOFF_WEBHOOK_ALLOW_PRIVATE: '1',
        // 催办那两档压到秒级，否则这一段要等半小时。下限是 1 秒（见 handoff-sweep.ts）。
        GATEWAY_ROUTINE_TICK_MS: '1000',
        GATEWAY_HANDOFF_NUDGE_MS: '1000',
        GATEWAY_HANDOFF_EXPIRE_MS: '2000',
      },
    })).gw
    const reg = await createCompany(req, gwBase, {
      ownerEmail: 'owner@handoff.test',
      ownerPassword: 'test-owner-handoff',
      email: 'admin@handoff.test',
      password: 'correct-horse',
      companyName: 'HandoffCo',
      slug: 'handoffco',
      seats: 3,
    })
    const adminTok = reg.token
    const ownerTok = reg.ownerToken
    const orgId = reg.company.id

    for (const email of ['alice@handoff.test', 'bob@handoff.test']) {
      const r = await req(gwBase, 'POST', `/orgs/${orgId}/accounts`, {
        token: adminTok,
        body: { email, password: 'correct-horse', role: 'member' },
      })
      assert(r.status === 201, `account ${email} ${r.status} ${r.text}`)
    }
    const login = async (email) => {
      const r = await req(gwBase, 'POST', '/auth/login', { body: { email, password: 'correct-horse' } })
      assert(r.status === 200, `login ${email} ${r.status}`)
      return r.json.token
    }
    const aliceTok = await login('alice@handoff.test')
    const bobTok = await login('bob@handoff.test')
    const aliceMe = await req(gwBase, 'GET', '/me', { token: aliceTok })
    const aliceId = aliceMe.json.account.id
    const aliceSeat = await req(gwBase, 'GET', `/platform/accounts/${aliceId}`, { token: ownerTok })
    assert(aliceSeat.status === 200, `seat secrets ${aliceSeat.status} ${aliceSeat.text}`)
    const aliceAccess = aliceSeat.json.accessToken

    // Alice 建一颗自己的 Bot，部署（stub），再把「席位地址」指到假席位上。
    const madeBot = await req(gwBase, 'POST', '/runtime/bots', { token: aliceTok, body: { name: '跑腿助手' } })
    assert(madeBot.status === 201, `建 Bot ${madeBot.status} ${madeBot.text}`)
    const botId = madeBot.json.bot.id

    await pairMachine({ req, gwBase, ownerTok, orgId })
    await publishRelease({ req, gwBase, token: ownerTok, version: '0.1.0', note: 'e2e-handoff' })
    const dep = await req(gwBase, 'POST', '/runtime/deploy', { token: aliceTok, body: { botId } })
    assert(dep.status === 200, `deploy ${dep.status} ${dep.text}`)
    const ready = await req(gwBase, 'POST', `/internal/instances/${aliceId}/ready`, {
      token: aliceAccess,
      body: { host: seatUrl, botId },
    })
    assert(ready.status === 200, `ready ${ready.status} ${ready.text}`)

    const sessionId = 's-handoff-1'
    const report = (body) =>
      req(gwBase, 'POST', '/internal/handoffs', { token: aliceAccess, body: { sessionId, botId, ...body } })

    let hid = ''

    await test('席位报一张单：落库、指派给 Bot 的主人', async () => {
      hid = 'h-' + Date.now()
      const r = await report({
        id: hid,
        state: 'open',
        reason: '这笔付款超出我的权限',
        ask: '去财务系统里把这笔付了',
        blocking: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      assert(r.status === 200, `报单 ${r.status} ${r.text}`)
      assert(r.json.handoff.state === 'open', `state ${r.json.handoff.state}`)
      // 模版默认 escalateTo = owner：这颗 Bot 的主人就是接手人。
      assert(r.json.handoff.assignee === aliceId, `assignee ${r.json.handoff.assignee}`)
      // machineId 是服务端算的，不收 body——它决定之后敲哪台机器。
      assert(r.json.handoff.machineId, 'machineId 没算出来')
    })

    await test('待办清单：本人看得见，管理员看得见，别的员工看不见', async () => {
      const mine = await req(gwBase, 'GET', '/runtime/handoffs', { token: aliceTok })
      assert(mine.status === 200, `alice ${mine.status} ${mine.text}`)
      assert((mine.json.handoffs || []).some((h) => h.id === hid), 'Alice 看不到自己的单')
      assert(mine.json.count === 1, `count ${mine.json.count}`)
      // 名字要能显示出来，否则待办页上「谁的 Bot」是一串 uuid。
      const row = mine.json.handoffs.find((h) => h.id === hid)
      assert(row.ownerName, 'ownerName 空')

      const asAdmin = await req(gwBase, 'GET', '/runtime/handoffs', { token: adminTok })
      assert((asAdmin.json.handoffs || []).some((h) => h.id === hid), '管理员看不到本公司的单')

      const asBob = await req(gwBase, 'GET', '/runtime/handoffs', { token: bobTok })
      assert(!(asBob.json.handoffs || []).some((h) => h.id === hid), 'Bob 看到了不该看的单')
      const peek = await req(gwBase, 'GET', `/runtime/handoffs/${hid}`, { token: bobTok })
      assert(peek.status === 404, `Bob 拉到了别人的单：${peek.status}`)
    })

    await test('通知地址只收 https，乱填的挡下', async () => {
      // 这条 URL 是一把凭据（拿到就能往那个群里发东西），走明文等于交给路上的每一跳。
      const plain = await req(gwBase, 'PATCH', `/orgs/${orgId}`, {
        token: adminTok,
        body: { handoffWebhook: 'http://127.0.0.1:9/hook' },
      })
      assert(plain.status === 400, `http 的 webhook 居然收下了：${plain.status}`)
      const bad = await req(gwBase, 'PATCH', `/orgs/${orgId}`, { token: adminTok, body: { handoffWebhook: 'not-a-url' } })
      assert(bad.status === 400, `乱填的 webhook 收下了：${bad.status}`)
    })

    // 没有 openssl 就签不出自签证书，送达那条路（只收 https）验不了。**记成 skip，
    // 不进 test()**：以前在用例里静默 return 会算成一条 ok，看清单的人以为送达验过了。
    if (!hook.secure) skip('handoff 送达断言：本机没有 openssl，签不出自签证书')
    else await test('开单就往群里推一条，正文说得出要人做什么', async () => {
      const set = await req(gwBase, 'PATCH', `/orgs/${orgId}`, { token: adminTok, body: { handoffWebhook: hookUrl } })
      assert(set.status === 200, `设 webhook ${set.status} ${set.text}`)
      const id = 'h-notify-' + Date.now()
      const r = await report({
        id,
        state: 'open',
        reason: '要退款，超出我的权限',
        ask: '去后台把这笔退了',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      assert(r.status === 200, `报单 ${r.status} ${r.text}`)
      const deadline = Date.now() + 8000
      while (Date.now() < deadline && !hook.posts.length) await sleep(200)
      assert(hook.posts.length >= 1, '群里没收到任何东西——浏览器关着的时候就没人知道了')
      const first = hook.posts[0]
      const text = String(first.text || '')
      assert(text.includes('去后台把这笔退了'), `正文里没有「要人做什么」：${text}`)
      // 三家的字段一起发，各家只认自己那一份。
      assert(first.msg_type === 'text' && first.msgtype === 'text' && first.content?.text, `字段不全：${JSON.stringify(first)}`)
      // 收拾干净：这张单不该影响后面几条用例的计数。
      await req(gwBase, 'POST', `/runtime/handoffs/${id}/cancel`, { token: adminTok })
    })

    await test('管理员接手：不是他的 Bot 也够得着，抢不到的那个知道被谁接走', async () => {
      const first = await req(gwBase, 'POST', `/runtime/handoffs/${hid}/claim`, { token: adminTok })
      assert(first.status === 200, `管理员接手 ${first.status} ${first.text}`)
      // 真的打到了席位上，而且带上了「谁在操作」——席位只认得自己那一个账号。
      const seen = seat.calls.filter((c) => c.act === 'claim')
      assert(seen.length === 1, `席位收到 ${seen.length} 次 claim`)
      assert(seen[0].body.actor && seen[0].body.actor.accountId, 'claim 没带 actor')
      assert(seen[0].auth.startsWith('Bearer sat_'), `席位票没带上：${seen[0].auth.slice(0, 12)}`)

      const second = await req(gwBase, 'POST', `/runtime/handoffs/${hid}/claim`, { token: aliceTok })
      assert(second.status === 409, `第二个人 ${second.status} ${second.text}`)
      assert(String(second.json.error || '').includes('接手'), `409 文案：${second.text}`)

      const list = await req(gwBase, 'GET', '/runtime/handoffs', { token: aliceTok })
      const row = (list.json.handoffs || []).find((h) => h.id === hid)
      assert(row && row.state === 'claimed', `状态没跟上：${row && row.state}`)
      assert(row.claimedName, 'claimedName 空——待办页上「谁在处理」会是空的')
    })

    await test('交还：话真的发到了席位上', async () => {
      const r = await req(gwBase, 'POST', `/runtime/handoffs/${hid}/return`, {
        token: adminTok,
        body: { disposition: 'done', text: '付好了，流水号 88231' },
      })
      assert(r.status === 200, `交还 ${r.status} ${r.text}`)
      const sent = seat.calls.find((c) => c.act === 'return')
      assert(sent, '席位没收到交还')
      assert(sent.body.text.includes('88231'), `正文没带过去：${JSON.stringify(sent.body)}`)
      assert(sent.body.actor.accountId, '交还没带 actor')
      const list = await req(gwBase, 'GET', '/runtime/handoffs', { token: aliceTok })
      const row = (list.json.handoffs || []).find((h) => h.id === hid)
      assert(row && row.state === 'returned', `状态没跟上：${row && row.state}`)
      // 「已交还」不算欠着的事：顶栏那个数要落回 0。
      assert(list.json.count === 0, `count ${list.json.count}`)
    })

    await test('没人接：催办推出去，超时收单并告诉 Bot', async () => {
      const stale = 'h-stale-' + Date.now()
      const r = await report({
        id: stale,
        state: 'open',
        reason: '没人管的事',
        ask: '看一眼这个',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      assert(r.status === 200, `报单 ${r.status} ${r.text}`)
      // 催办 1 秒、超时 2 秒，扫描每秒一轮：给它 15 秒足够了。
      const deadline = Date.now() + 15000
      let row
      while (Date.now() < deadline) {
        const list = await req(gwBase, 'GET', '/runtime/handoffs', { token: adminTok })
        row = (list.json.handoffs || []).find((h) => h.id === stale)
        if (!row) break
        await sleep(500)
      }
      // 收掉之后它就不在「还没闭合」的清单里了。
      assert(!row, `超时之后单子还挂着：${row && row.state}`)
      const expired = seat.calls.filter((c) => c.act === 'expire' && c.hid === stale)
      assert(expired.length >= 1, '席位没收到 expire——那句「没人接手」永远到不了模型')
      assert(Number(expired[0].body.hours) > 0, 'expire 没带上等了多久')

      /**
       * **没人接过的单子不许留下 claimedAt。**
       *
       * 留了的话，「多久有人接」那个中位数会把它算成「24 小时才有人接」——恰恰是没人
       * 接的那些单子，把响应速度这个数字拖到最难看。直接查库，因为接口上看不见这一格。
       */
      const client = await pgClient(SCHEMA)
      try {
        const row = await client.query('select state, "claimedAt" from handoffs where id = $1', [stale])
        assert(row.rows[0]?.state === 'expired', `库里状态 ${row.rows[0]?.state}`)
        assert(row.rows[0]?.claimedAt === null, `没人接过却写了 claimedAt=${row.rows[0]?.claimedAt}`)
      } finally {
        await client.end().catch(() => {})
      }
    })

    await test('接了手却一直没交还的，也会被收掉——不然它永远挡着日常任务', async () => {
      /**
       * 只扫 `open` 的话，一张被人点过「我来接手」然后再没动静的单子既不会被催、也不会
       * 转 expired：blocking 的那些会让这颗 Bot 的日常任务天天被跳过，而模型永远等不到
       * 那句话。文档 §14 不变量 2 说的「一张开着的单子必然有终态」，缺的就是这一半。
       */
      const held = 'h-held-' + Date.now()
      const r = await report({
        id: held,
        state: 'open',
        reason: '接了没下文的事',
        ask: '看一眼这个',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      assert(r.status === 200, `报单 ${r.status} ${r.text}`)
      const took = await req(gwBase, 'POST', `/runtime/handoffs/${held}/claim`, { token: adminTok })
      assert(took.status === 200, `接手 ${took.status} ${took.text}`)

      const deadline = Date.now() + 15000
      let seen = false
      while (Date.now() < deadline) {
        if (seat.calls.some((c) => c.act === 'expire' && c.hid === held)) {
          seen = true
          break
        }
        await sleep(500)
      }
      assert(seen, '接过手的单子永远不会被收掉——它会一直挡着这颗 Bot 的日常任务')
    })

    await test('看一张单：正文（Bot 做到哪一步）是现去席位拉的', async () => {
      /**
       * 待办页上「就地处理」那张卡靠它——接手的人得先看见 Bot 已经做到哪一步，否则
       * 他会从头再做一遍。Gateway 那张表只留了 reason / ask 各一段（同会话索引的口径）。
       */
      const withText = 'h-detail-' + Date.now()
      const r = await report({
        id: withText,
        state: 'open',
        reason: '要退款',
        ask: '去后台把这笔退了',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      assert(r.status === 200, `报单 ${r.status} ${r.text}`)
      seat.opened.set(withText, { id: withText, sessionId, state: 'open', ask: 'x', reason: 'y', summary: '已经查到订单号 A-991' })

      const one = await req(gwBase, 'GET', `/runtime/handoffs/${withText}`, { token: adminTok })
      assert(one.status === 200, `拉一张单 ${one.status} ${one.text}`)
      assert(one.json.handoff.id === withText, '索引那一份没给')
      assert(one.json.detail && one.json.detail.summary.includes('A-991'), `正文没拉到：${one.text}`)

      // 席位不在线时只给索引那一份，**不是整条路 503**：看不到全文总比看不到这张单强。
      seat.opened.delete(withText)
      const gone = await req(gwBase, 'GET', `/runtime/handoffs/${withText}`, { token: adminTok })
      assert(gone.status === 200 && gone.json.detail === null, `席位没这张单时该给 null：${gone.text}`)
      await req(gwBase, 'POST', `/runtime/handoffs/${withText}/cancel`, { token: adminTok })
    })

    await test('统计跟着可见范围走：看不到别人的单子，也就不该看到别人的数', async () => {
      // 一律按公司算的话，员工顶上写着「近 30 天开出 N」，下面的表格却是空的——
      // 他要么以为页面坏了，要么开始数别人的活。
      const mine = await req(gwBase, 'GET', '/runtime/handoffs', { token: bobTok })
      assert(mine.status === 200, `bob ${mine.status} ${mine.text}`)
      assert((mine.json.handoffs || []).length === 0, 'Bob 看到了不该看的单')
      assert(mine.json.stats.opened === 0, `Bob 的统计算进了别人的单：${JSON.stringify(mine.json.stats)}`)
      const asAdmin = await req(gwBase, 'GET', '/runtime/handoffs', { token: adminTok })
      assert(asAdmin.json.stats.opened > 0, '管理员那边反倒空了')
    })

    await test('统计投影：开了几张、几张没人接', async () => {
      const list = await req(gwBase, 'GET', '/runtime/handoffs', { token: adminTok })
      assert(list.status === 200, `清单 ${list.status}`)
      assert(list.json.stats && typeof list.json.stats.opened === 'number', '统计没出来')
      assert(list.json.stats.opened >= 2, `近 30 天开出 ${list.json.stats.opened}`)
      assert(list.json.stats.expired >= 1, `没人接手的计数 ${list.json.stats.expired}`)
    })

    await test('席位不在线：交接动作如实报 503，不假装成功', async () => {
      const gone = 'h-offline-' + Date.now()
      await report({ id: gone, state: 'open', reason: 'x', ask: 'y', createdAt: Date.now(), updatedAt: Date.now() })
      await closeServer(seat.server, '席位替身')
      const r = await req(gwBase, 'POST', `/runtime/handoffs/${gone}/claim`, { token: adminTok })
      assert(r.status === 503, `席位掉线时 ${r.status} ${r.text}`)
    })
  } finally {
    gw?.kill()
    await closeServer(seat.server, '席位替身')
    await closeServer(hook.server, '催办回调替身')
    if (tls) rmSync(tls.dir, { recursive: true, force: true })
    rmSync(GW_HOME, { recursive: true, force: true })
  }
}
