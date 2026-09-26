/**
 * 机器管家：配对、鉴权、部署下发、反代、桌面票。
 *
 * 这里起的是**真的管家进程**，只是带 `SATUWORK_MANAGER_DRYRUN=1`——跳过
 * `deploy-seat.sh` 和 systemd（那些要 root，也要一台 Debian），但 HTTP、配对、
 * 鉴权、反代、WebSocket 升级全都走真的。整条新接缝就是靠这一套盯住的。
 *
 * 上游 bot 用一个 mock HTTP 顶替：反代要验的是「转过去了、头对不对、流不断」，
 * 不是 bot 本身。
 */
import { createHash, sign } from 'node:crypto'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'

/** 这一套自己的 schema。写死名字会被别的 worktree 的 e2e 清掉（见 pg.mjs 的 schemaOf）。 */
const SCHEMA = schemaOf('e2e_manager')
/** `/cron/tick` 的凭证。没配这一项那条路整个关着（routes/cron.ts）。 */
const CRON_SECRET = 'manager-e2e-cron-secret'
import { freePorts } from './ports.mjs'
import { publishRelease } from './release.mjs'
import { closeServer } from './probe.mjs'

/**
 * 起一个假 bot。记下每次请求的头和路径，供断言。
 *
 * `health` 是可改的：换版前的排空要问 `/api/health` 忙不忙（见 manager/src/seats.ts），
 * 测「等它跑完」就要能让这个席位说自己在忙，跑完再改回来。
 */
function fakeBot() {
  const seen = []
  const health = { ok: true, busy: false, running: 0, queued: 0, quiesced: false }
  /** 收到过的静默指令，按先后记账：`{ ttlMs, auth }`。 */
  const quiesce = []
  /** 名单流挂着的那些事件流响应，收摊时一起关掉，别让进程退不出去。 */
  const rosterOpen = []
  const server = createServer((req, res) => {
    // 同一个对象先入账再补正文：上传那条要等 body 读完才知道字节对不对，但「打到 bot
    // 几次」的计数要在请求到达那一刻就准。
    const entry = { path: req.url, method: req.method, headers: { ...req.headers } }
    seen.push(entry)
    if (req.url.startsWith('/api/health')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(health))
      return
    }
    if (req.url.startsWith('/api/quiesce')) {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        let ttlMs = 0
        try {
          ttlMs = Number(JSON.parse(raw || '{}').ttlMs) || 0
        } catch {}
        quiesce.push({ ttlMs, auth: req.headers.authorization || '' })
        health.quiesced = ttlMs > 0
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, quiesced: health.quiesced, ...health }))
      })
      return
    }
    // 直连上传（9 号协议）：管家把正文原样管过来，这里把字节收齐记下，供断言「路上没坏」。
    if (req.method === 'POST' && /^\/api\/sessions\/[^/]+\/files$/.test(req.url)) {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        entry.body = Buffer.concat(chunks)
        const name = decodeURIComponent(String(req.headers['x-filename'] || ''))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ path: 'uploads/' + name, name, size: entry.body.length }))
      })
      return
    }
    // 名单流要先问会话 id，再开事件流（manager/src/roster.ts 的 pump）。
    if (/^\/api\/bots\/[^/]+\/session/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ sessionId: 's-roster' }))
      return
    }
    if (req.url.startsWith('/api/sessions/s-roster/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      // 一条该转的、一条该滤掉的、一条权威的 live；然后挂着不结束（名单流本来就是长连接）。
      res.write('data: {"type":"user/message","seq":1,"time":1,"data":{"text":"hi"}}\n\n')
      res.write('data: {"type":"tool/result","seq":2,"time":2}\n\n')
      res.write('data: {"type":"replay/done","live":false}\n\n')
      rosterOpen.push(res)
      return
    }
    if (req.url.startsWith('/api/sse')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"seq":1}\n\n')
      setTimeout(() => {
        res.write('data: {"seq":2}\n\n')
        res.end()
      }, 60)
      return
    }
    // 像 noVNC 落地页那样有个 </head>：管家要往那儿插「关掉控制条」的样式（4 号协议），
    // 返 JSON 的话那段改写压根不会触发，用例就成了空跑。
    if (req.url.startsWith('/vnc.html') || req.url === '/' || req.url.startsWith('/index.html')) {
      // boom=1：让落地页这条路返一个非 200，用来验管家「只改 200 的正文」那道闸。
      // 正文照样带 </head>——闸没了的话样式就会被插进这个错误页里。
      const boom = req.url.includes('boom=1')
      res.writeHead(boom ? 500 : 200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        boom
          ? '<html><head><title>boom</title></head><body>UPSTREAM-500</body></html>'
          : '<html><head><title>noVNC</title></head><body>VNC-PAGE</body></html>',
      )
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, path: req.url }))
  })
  // 顺带兼作 noVNC：WebSocket 升级要有人接。
  server.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n')
    socket.write('HELLO-WS')
  })
  return { server, seen, health, quiesce, rosterOpen }
}

function listenOn(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server.address().port))
  })
}

/** 手搓一次 WebSocket 升级握手，只看服务端有没有把它接通。 */
function wsHandshake(port, path, cookie) {
  return new Promise((resolve) => {
    const sock = connect(port, '127.0.0.1', () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n` +
          (cookie ? `Cookie: ${cookie}\r\n` : '') +
          '\r\n',
      )
    })
    let buf = ''
    const done = (v) => {
      try {
        sock.destroy()
      } catch {}
      resolve(v)
    }
    sock.on('data', (d) => {
      buf += String(d)
      if (buf.includes('HELLO-WS') || buf.length > 2000) done(buf)
    })
    sock.on('error', (e) => done('ERR ' + e.message))
    setTimeout(() => done(buf || 'TIMEOUT'), 4000)
  })
}

export async function runManager({ root, gwRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = tmpOf('satuwork-e2e-manager-gw')
  const MGR_HOME = tmpOf('satuwork-e2e-manager-etc')
  // UP_PORT：模型中继那一组用的假上游。
  const [GW_PORT, MGR_PORT, BOT_PORT, NOVNC_PORT, UP_PORT] = await freePorts(5)
  const gwBase = `http://127.0.0.1:${GW_PORT}`
  const mgrBase = `http://127.0.0.1:${MGR_PORT}`
  const managerRoot = join(root, 'manager')

  rmSync(GW_HOME, { recursive: true, force: true })
  rmSync(MGR_HOME, { recursive: true, force: true })
  log('\n# manager')

  // 真管家在 try 里才起得来（要先拿到配对码），但收尾在 finally——先占个名字。
  let mgr
  const bot = fakeBot()
  const novnc = fakeBot()
  await listenOn(bot.server, BOT_PORT)
  await listenOn(novnc.server, NOVNC_PORT)

  const gw = start('manager-gw', ['--import', 'tsx', join(gwRoot, 'src/index.ts')], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: SCHEMA,
      GATEWAY_PG_RESET: '1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_PUBLIC_URL: gwBase,
      GATEWAY_OWNER_EMAIL: 'owner@manager.test',
      GATEWAY_OWNER_PASSWORD: 'manager-owner-1234',
      // 「跑一拍维护」这条路（routes/cron.ts）只有配了 CRON_SECRET 才开。模型中继那一组
      // 要按自己的节奏驱动 maintenanceTick（未结算清扫就在那一拍里），不能等 30 秒调度器。
      CRON_SECRET,
      SATUWORK_DEPLOY_STUB: '',
    },
  })
  await waitHttp(`${gwBase}/health`, { timeout: 40000 })

  try {
    const login = await req(gwBase, 'POST', '/auth/login', {
      body: { email: 'owner@manager.test', password: 'manager-owner-1234' },
    })
    assert(login.status === 200, `owner login ${login.status} ${login.text}`)
    const ownerTok = login.json.token

    const org = await req(gwBase, 'POST', '/platform/orgs', {
      token: ownerTok,
      body: {
        name: '管家验证公司',
        slug: 'mgrtest',
        contactName: '联系人',
        contactPhone: '+86 13800000000',
        contactEmail: 'admin@mgrtest.local',
        adminEmail: 'admin@mgrtest.local',
        adminPassword: 'manager-admin-1234',
      },
    })
    assert(org.status === 201, `org ${org.status} ${org.text}`)
    const orgId = org.json.company.id

    let code = ''
    let machineTok = ''

    await test('生成配对码：格式、有效期、安装命令', async () => {
      const r = await req(gwBase, 'POST', `/platform/orgs/${orgId}/pairing-code`, { token: ownerTok })
      assert(r.status === 201, `code ${r.status} ${r.text}`)
      assert(/^SW-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(r.json.code), `格式 ${r.json.code}`)
      assert(r.json.expiresAt > Date.now(), '已过期')
      assert(r.json.installCommand.includes(`${gwBase}/install-manager.sh`), '安装命令要带 Gateway 地址')
      code = r.json.code
    })

    await test('安装脚本公开可取，内容像个装机脚本', async () => {
      const r = await req(gwBase, 'GET', '/install-manager.sh')
      assert(r.status === 200, `install ${r.status}`)
      assert(r.text.startsWith('#!/bin/bash'), 'shebang')
      assert(r.text.includes(gwBase), '脚本里要写死 Gateway 地址')
      assert(r.text.includes('satuwork-manager.service'), '要装 systemd 单元')
      assert(r.text.includes('satuwork-manager-confirm'), '要装回滚定时器')
      assert(!r.text.includes('smt_'), '安装脚本不该含任何机器票')
      // 包以 root 跑：没有校验值、或者对不上，就不装。
      assert(r.text.includes('x-bot-sha256') && r.text.includes('sha256sum'), '安装脚本要核对管家包的 sha256')
    })

    // 管家先起来再配对：Gateway 收到配对请求会立刻回拨一次 /health。
    mgr = start('manager', ['--import', 'tsx', join(managerRoot, 'bin/satuwork-manager.mjs')], {
      cwd: managerRoot,
      env: {
        SATUWORK_MANAGER_HOME: MGR_HOME,
        SATUWORK_MANAGER_HOST: '127.0.0.1',
        SATUWORK_MANAGER_PORT: String(MGR_PORT),
        SATUWORK_MANAGER_DRYRUN: '1',
        // 排空窗口调小：默认 2 分钟是给真机上一轮真活留的，测里只需要证明「等过、
        // 到点了就明说」。顺带也验了这个环境变量真的有人读。
        SATUWORK_SEAT_DRAIN_MS: '4000',
        GATEWAY_URL: gwBase,
        SATUWORK_PAIRING_CODE: code,
      },
    })

    await test('管家自己配上了，而且 Gateway 回拨得通', async () => {
      for (let i = 0; i < 100; i++) {
        if (existsSync(join(MGR_HOME, 'manager.json'))) break
        await new Promise((r) => setTimeout(r, 200))
      }
      assert(existsSync(join(MGR_HOME, 'manager.json')), '管家没有写出配对结果')
      const m = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      assert(m.status === 200, `machine ${m.status} ${m.text}`)
      assert(m.json.machine.paired === true, 'paired')
      assert(m.json.machine.host === mgrBase, `host ${m.json.machine.host}`)
      // 回拨走 challenge 而不是 smt_：那一刻票还在 Gateway 手里。通了才说明真可达。
      assert(!m.json.machine.lastError, `回拨失败: ${m.json.machine.lastError}`)
      machineTok = m.json.machine.token
      assert(String(machineTok).startsWith('smt_'), 'smt_')
    })

    await test('管家的 /health 认票：无票 401，有票 200', async () => {
      const anon = await req(mgrBase, 'GET', '/health')
      assert(anon.status === 401, `无票 ${anon.status}`)
      const ok = await req(mgrBase, 'GET', '/health', { token: machineTok })
      assert(ok.status === 200, `有票 ${ok.status} ${ok.text}`)
      // 9 号起 /logs 认日志票、/stream 放上传的 POST；10 号起 /llm 替席位 Bot 中继模型调用
      // （manager/src/config.ts）。Gateway 按这个号决定给不给前端直连地址、要不要把
      // GATEWAY_LLM_URL 写进席位，报低了就是界面上一句「这台机器跟不了」。
      assert(ok.json.protocol >= 10, `protocol 该 ≥ 10，实际 ${ok.json.protocol}`)
      assert(ok.json.dryRun === true, 'dryRun')
    })

    await test('部署下发：无票 401，有票落进名册', async () => {
      const spec = {
        linuxUser: 'sw-test',
        homeDir: '/home/sw-test',
        workDir: '/home/sw-test/work',
        seatDir: '/home/sw-test/.satuwork/seat-1',
        botId: 'bot-1',
        botVersion: '0.0.0-e2e',
        vncPassword: 'x'.repeat(16),
        gatewayUrl: gwBase,
        gatewayToken: 'sat_e2e',
        gatewayApiKey: 'sk_sw_e2e',
        ports: { display: 10, vncPort: 5910, novncPort: NOVNC_PORT, botPort: BOT_PORT, cdpPort: 9222 },
      }
      const anon = await req(mgrBase, 'PUT', '/seats/seat-1', { body: spec })
      assert(anon.status === 401, `无票部署 ${anon.status}`)

      // **用 Gateway 真正发的那个头。** 之前这里只测了 authorization——和管家的实现
      // 一致，却和调用方不一致，于是「/health 通、部署 401」漏了过去。
      const viaHeader = await fetch(`${mgrBase}/seats/seat-1`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-satuwork-machine': machineTok },
        body: JSON.stringify(spec),
      })
      assert(viaHeader.status === 200, `x-satuwork-machine 部署 ${viaHeader.status} ${await viaHeader.text()}`)

      const ok = await req(mgrBase, 'PUT', '/seats/seat-1', { token: machineTok, body: spec })
      assert(ok.status === 200, `部署 ${ok.status} ${ok.text}`)
      assert(ok.json.seat.status === 'ready', `status ${ok.json.seat.status}`)
      const list = await req(mgrBase, 'GET', '/seats', { token: machineTok })
      assert(list.json.seats.length === 1, `名册 ${list.json.seats.length}`)
    })

    await test('安装进度：认票，没在装就明说「没有」而不是 404', async () => {
      const anon = await req(mgrBase, 'GET', '/seats/seat-1/progress')
      assert(anon.status === 401, `无票 ${anon.status}`)
      const ok = await req(mgrBase, 'GET', '/seats/seat-1/progress', { token: machineTok })
      assert(ok.status === 200, `进度 ${ok.status} ${ok.text}`)
      // 这台是 dryRun，脚本压根没跑，所以没有进度——但这**不是** 404：调用方要分得清
      // 「问不到」和「问错了」，前者照旧画粗进度，后者才是 bug。
      assert(ok.json.progress === null, `不该有进度：${ok.text}`)
      // 名册里没有的席位也照答：新席位第一次装的时候那一行还没写下（要等脚本跑完），
      // 而「第一次装」恰恰是这条路唯一真正要用的时刻——按名册拦就等于永远 404。
      const fresh = await req(mgrBase, 'GET', '/seats/seat-never-deployed/progress', { token: machineTok })
      assert(fresh.status === 200, `没登记过的席位 ${fresh.status} ${fresh.text}`)
      assert(fresh.json.progress === null, `${fresh.text}`)
    })

    /**
     * 换版前的排空。
     *
     * 部署一个已经在跑的席位 = `systemctl restart`：正跑着的那一轮当场没命，日志里那条
     * turn/end 根本没写成，而人正对着屏幕等回答。这三条钉的是三种处置：等得到就等、
     * 等不到就明说、按了强制就别拦着。
     */
    const seat1Spec = (extra = {}) => ({
      linuxUser: 'sw-test',
      homeDir: '/home/sw-test',
      workDir: '/home/sw-test/work',
      seatDir: '/home/sw-test/.satuwork/seat-1',
      botId: 'bot-1',
      botVersion: '0.0.0-e2e',
      vncPassword: 'x'.repeat(16),
      gatewayUrl: gwBase,
      gatewayToken: 'sat_e2e',
      gatewayApiKey: 'sk_sw_e2e',
      ports: { display: 10, vncPort: 5910, novncPort: NOVNC_PORT, botPort: BOT_PORT, cdpPort: 9222 },
      ...extra,
    })

    await test('席位在跑会话：换版先等它跑完，等不到就明说，不硬来', async () => {
      bot.health.busy = true
      bot.health.running = 1
      try {
        const at = Date.now()
        const r = await req(mgrBase, 'PUT', '/seats/seat-1', {
          token: machineTok,
          body: seat1Spec({ botVersion: '0.0.1-e2e' }),
        })
        const waited = Date.now() - at
        // 409 而不是 502：机器上一个字节都没动，席位还是原来那个版本、还在好好地跑。
        assert(r.status === 409, `忙着的席位该回 409，实际 ${r.status} ${r.text}`)
        assert(r.json.busy === true, `没带 busy 标记，Gateway 分不出「忙」和「失败」：${r.text}`)
        assert(String(r.json.error).includes('有会话在跑'), `理由不对：${r.json.error}`)
        // 真的等过：排空窗口 4 秒（见上面的 SATUWORK_SEAT_DRAIN_MS），当场拒是另一回事。
        // 阈值取窗口的一半：等过的会在 4 秒上下，没等的在几百毫秒内，2 秒两边都有余量，
        // 不会因为 CI 机器慢半拍就误报。
        assert(waited >= 2000, `压根没等就拒了（${waited}ms）——那不叫排空`)
        const list = await req(mgrBase, 'GET', '/seats', { token: machineTok })
        const row = list.json.seats.find((x) => x.seatId === 'seat-1')
        assert(row.botVersion === '0.0.0-e2e', `没换版却把版本号写成了新的：${row.botVersion}`)
        assert(row.status === 'ready', `没换版不该把席位标成 ${row.status}`)
      } finally {
        bot.health.busy = false
        bot.health.running = 0
      }
    })

    await test('席位跑完了，换版自己接上，不用人再来一次', async () => {
      bot.health.busy = true
      bot.health.running = 1
      // 0.8 秒后这一轮结束——排空要在 4 秒窗口内自己认出来，接着往下走。放在窗口
      // 前段，给探活的轮询间隔和慢机器留足余量：贴着窗口尾巴的话，慢一拍就成了 409。
      const done = setTimeout(() => {
        bot.health.busy = false
        bot.health.running = 0
      }, 800)
      try {
        const r = await req(mgrBase, 'PUT', '/seats/seat-1', {
          token: machineTok,
          body: seat1Spec({ botVersion: '0.0.1-e2e' }),
        })
        assert(r.status === 200, `席位空下来之后该换版，实际 ${r.status} ${r.text}`)
        assert(r.json.seat.botVersion === '0.0.1-e2e', `版本没换：${r.json.seat.botVersion}`)
      } finally {
        clearTimeout(done)
        bot.health.busy = false
        bot.health.running = 0
      }
    })

    await test('换版前先让席位不再接新活——不是等到空闲就撒手', async () => {
      /**
       * 排空只等「手上这一轮跑完」是不够的：等到空闲之后，到真正 `systemctl restart`
       * 之间还隔着拉包、解包、rsync 那几秒，人在那几秒里发一句照样被拦腰砍断，而排空
       * 看上去明明成功了。所以要先落闸（席位那头 `/api/quiesce`：不开新的一轮，但不动
       * 正在跑的那一轮），再等。
       *
       * 顺序是关键：**先落闸再等**。反过来等于没落——放行那一刻新一轮就能开起来。
       */
      bot.quiesce.length = 0
      const r = await req(mgrBase, 'PUT', '/seats/seat-1', {
        token: machineTok,
        body: seat1Spec({ botVersion: '0.1.0-e2e' }),
      })
      assert(r.status === 200, `部署 ${r.status} ${r.text}`)
      assert(bot.quiesce.length >= 1, '换版前压根没落闸——「等到空闲」和「真的重启」之间那几秒是敞着的')
      assert(bot.quiesce[0].ttlMs > 0, `第一条该是落闸，实际 ${JSON.stringify(bot.quiesce[0])}`)
      // 席位票，不是机器票：/api/quiesce 在 bot 的 /api/* 守卫后面。
      assert(bot.quiesce[0].auth === 'Bearer sat_e2e', `落闸没带席位票：${bot.quiesce[0].auth}`)
      // 落闸**排在探活之前**：先问忙不忙再落闸的话，那一问的答案马上就过期了。
      const paths = bot.seen.map((x) => x.path)
      const firstQuiesce = paths.indexOf('/api/quiesce')
      const firstHealth = paths.indexOf('/api/health')
      assert(
        firstQuiesce >= 0 && (firstHealth < 0 || firstQuiesce < firstHealth),
        `先探活后落闸，等于没落：${JSON.stringify(paths.slice(0, 4))}`,
      )
    })

    await test('部署没走到重启那一步，落下的闸要放开', async () => {
      /**
       * 席位一直不空、等到超时——这次没换版，机器上一个字节都没动。**闸必须放开**，
       * 否则这台好端端的席位会白白几分钟不接活，而人只会看到「发消息没反应」。
       *
       * 席位那头还有 TTL 兜底，但那是兜底，不该当成常规路径。
       */
      bot.quiesce.length = 0
      bot.health.busy = true
      bot.health.running = 1
      try {
        const r = await req(mgrBase, 'PUT', '/seats/seat-1', {
          token: machineTok,
          body: seat1Spec({ botVersion: '0.1.0-e2e' }),
        })
        assert(r.status === 409, `该是忙着没换版，实际 ${r.status} ${r.text}`)
        const last = bot.quiesce[bot.quiesce.length - 1]
        assert(bot.quiesce.length >= 2, `落了闸却没放开：${JSON.stringify(bot.quiesce)}`)
        assert(last && last.ttlMs === 0, `最后一条该是放开，实际 ${JSON.stringify(last)}`)
      } finally {
        bot.health.busy = false
        bot.health.running = 0
        bot.health.quiesced = false
      }
    })

    await test('席位不认这条路（老版本）：照旧换版，不许被一道落不上的闸卡住', async () => {
      // 老席位没有 /api/quiesce。为了一个增强把换版整个卡死是本末倒置——落不上就退回
      // 到没有静默的老样子，该换还得换。
      const saved = bot.quiesce.slice()
      bot.quiesce.length = 0
      const stub = createServer((rq, rs) => {
        if (rq.url.startsWith('/api/health')) {
          rs.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, busy: false, running: 0, queued: 0 }))
          return
        }
        rs.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'no such route' }))
      })
      const [oldPort] = await freePorts(1)
      await listenOn(stub, oldPort)
      try {
        // 先把名册上这个席位指到「老 bot」那个口上，再原样重铺一次。
        const point = await req(mgrBase, 'PUT', '/seats/seat-old', {
          token: machineTok,
          body: seat1Spec({
            seatDir: '/home/sw-test/.satuwork/seat-old',
            ports: { display: 14, vncPort: 5914, novncPort: NOVNC_PORT, botPort: oldPort, cdpPort: 9226 },
          }),
        })
        assert(point.status === 200, `建席位 ${point.status} ${point.text}`)
        const again = await req(mgrBase, 'PUT', '/seats/seat-old', {
          token: machineTok,
          body: seat1Spec({
            seatDir: '/home/sw-test/.satuwork/seat-old',
            botVersion: '0.1.3-e2e',
            ports: { display: 14, vncPort: 5914, novncPort: NOVNC_PORT, botPort: oldPort, cdpPort: 9226 },
          }),
        })
        assert(again.status === 200, `老席位该照旧换版，实际 ${again.status} ${again.text}`)
        assert(again.json.seat.botVersion === '0.1.3-e2e', `版本没换：${again.json.seat.botVersion}`)
      } finally {
        await req(mgrBase, 'DELETE', '/seats/seat-old', { token: machineTok })
        await closeServer(stub, '老席位替身')
        bot.quiesce.length = 0
        bot.quiesce.push(...saved)
      }
    })

    await test('排空预算由调用方给：drainMs=0 就是一次都不等，当场说清楚', async () => {
      /**
       * 这一跳是同步的：调用方拿着自己的超时在等，而排空是在管家这头花时间。两个数各
       * 定各的，就会出现「等到一半被对面的超时掐断」——模版「立即下发」给单席位 90 秒、
       * 管家默认等 120 秒，撞的正是这个：Gateway 记下一条「联系不上机器管家」并标红，
       * 而管家照样等满再把席位重铺了。所以预算跟着请求走，两边取小。
       *
       * `drainMs: 0` 是这条路的极端情况，也是模版下发想要的那一种：**不等，但也别打断
       * ——忙就当场告诉我，我下一轮再来**。它和「别管忙不忙现在就重铺」（interrupt）是
       * 两件事，不能合成一个数。
       */
      bot.health.busy = true
      bot.health.running = 1
      try {
        const at = Date.now()
        const r = await req(mgrBase, 'PUT', '/seats/seat-1', {
          token: machineTok,
          body: seat1Spec({ botVersion: '0.1.0-e2e', drainMs: 0 }),
        })
        const waited = Date.now() - at
        assert(r.status === 409, `drainMs=0 撞上忙席位该当场 409，实际 ${r.status} ${r.text}`)
        assert(r.json.busy === true, `没带 busy 标记：${r.text}`)
        // 排空窗口是 4 秒（SATUWORK_SEAT_DRAIN_MS），drainMs=0 必须明显快过它。留到
        // 3 秒是给探活那一跳的余量（机器忙时它自己就要几百毫秒），不是给「等了一轮」的：
        // 真等了一轮的会在 4 秒开外。
        assert(waited < 3000, `drainMs=0 还是等了 ${waited}ms——调用方的预算没被认`)
      } finally {
        bot.health.busy = false
        bot.health.running = 0
      }
    })

    await test('排空探的是席位现在听的那个口，不是这次 spec 要它听的口', async () => {
      /**
       * 两者通常相同（Gateway 的 allocateSlot 首选原槽位），但撞上 unique 冲突时会重扫
       * 一个新槽位——那时 spec 里的 botPort 上蹲着的是**另一个席位**。拿它去问，答的是
       * 别人忙不忙：那个闲，就正好在本席位跑到一半时把它重启，而这正是排空要拦的事。
       */
      const [emptyPort] = await freePorts(1)
      bot.health.busy = true
      bot.health.running = 1
      try {
        const r = await req(mgrBase, 'PUT', '/seats/seat-1', {
          token: machineTok,
          body: seat1Spec({
            botVersion: '0.1.2-e2e',
            // 换槽位之后的新口，上面什么都没有。
            ports: { display: 13, vncPort: 5913, novncPort: NOVNC_PORT, botPort: emptyPort, cdpPort: 9225 },
          }),
        })
        assert(
          r.status === 409,
          `探错了口：spec 的新端口上没人听，就当成「不忙」把正在跑的席位重启了（${r.status} ${r.text}）`,
        )
      } finally {
        bot.health.busy = false
        bot.health.running = 0
      }
      // 上面那次被拒了，什么都没写——名册里的端口还得是原来那个，后面反代还要用。
      const list = await req(mgrBase, 'GET', '/seats', { token: machineTok })
      const row = list.json.seats.find((x) => x.seatId === 'seat-1')
      assert(row.botPort === BOT_PORT, `被拒的部署改动了名册：botPort=${row.botPort}`)
    })

    await test('手工「重新部署」不等：要修的往往正是一个卡住的席位', async () => {
      bot.health.busy = true
      bot.health.running = 1
      try {
        const at = Date.now()
        const r = await req(mgrBase, 'PUT', '/seats/seat-1', {
          token: machineTok,
          body: seat1Spec({ botVersion: '0.0.0-e2e', interrupt: true }),
        })
        const waited = Date.now() - at
        assert(r.status === 200, `手工重新部署被忙挡住了：${r.status} ${r.text}`)
        // 同上：去排空的会等满 4 秒，没去的是一次部署的耗时；3 秒离两边都有余量。
        assert(waited < 3000, `手工重新部署也去排空了（等了 ${waited}ms）——那就没有自助修复手段了`)
      } finally {
        bot.health.busy = false
        bot.health.running = 0
      }
    })

    await test('席位规格按形状校验：路径和标识符不收外部值', async () => {
      // 管家以 root 跑 deploy-seat.sh，这些值会变成 mkdir/chown 的目标和 systemd 单元里
      // 的字段。以前只校验「是非空字符串」，于是 homeDir=/etc 就能让 root 去 chown /etc，
      // 而 homeDir 里塞个换行就能往 [Service] 里注入 ExecStartPre。
      const good = {
        linuxUser: 'sw-test',
        homeDir: '/home/sw-test',
        workDir: '/home/sw-test/work',
        seatDir: '/home/sw-test/.satuwork/seat-2',
        botId: 'bot-1',
        botVersion: '0.0.0-e2e',
        vncPassword: 'x'.repeat(16),
        gatewayUrl: gwBase,
        gatewayToken: 'sat_e2e',
        gatewayApiKey: 'sk_sw_e2e',
        ports: { display: 11, vncPort: 5911, novncPort: NOVNC_PORT, botPort: BOT_PORT, cdpPort: 9223 },
      }
      const bad = [
        ['homeDir 指到 /etc', { ...good, homeDir: '/etc', workDir: '/etc/satuwork' }],
        ['linuxUser 带换行', { ...good, linuxUser: 'sw-test\nUser=root' }],
        ['linuxUser 带斜杠', { ...good, linuxUser: '../root' }],
        ['botVersion 想跳出目录', { ...good, botVersion: '../../etc/passwd' }],
        ['botId 带换行', { ...good, botId: 'bot-1\nGATEWAY_URL=http://evil' }],
        ['端口越界', { ...good, ports: { ...good.ports, botPort: 99999 } }],
        // 直连字段（协议 11）：成对出现，地址只收 http/https 且不带凭据，校验值是 64 位十六进制。
        ['有 botUrl 没 botSha256', { ...good, botUrl: 'https://github.com/x/y.tgz' }],
        ['有 botSha256 没 botUrl', { ...good, botSha256: 'a'.repeat(64) }],
        ['botUrl 不是 http', { ...good, botUrl: 'file:///etc/passwd', botSha256: 'a'.repeat(64) }],
        ['botUrl 带口令', { ...good, botUrl: 'https://u:p@github.com/x.tgz', botSha256: 'a'.repeat(64) }],
        ['botSha256 形状不对', { ...good, botUrl: 'https://github.com/x.tgz', botSha256: 'zz' }],
        ['botUrl 带换行', { ...good, botUrl: 'https://github.com/x.tgz\nGATEWAY_URL=http://evil', botSha256: 'a'.repeat(64) }],
      ]
      for (const [why, body] of bad) {
        const r = await req(mgrBase, 'PUT', '/seats/seat-2', { token: machineTok, body })
        assert(r.status === 400, `${why}：应 400，得到 ${r.status} ${r.text}`)
      }
      // seatId 走 URL，同样要按形状拒
      const badId = await req(mgrBase, 'PUT', '/seats/' + encodeURIComponent('../../etc'), {
        token: machineTok,
        body: good,
      })
      assert(badId.status === 400 || badId.status === 404, `坏 seatId 应被拒，得到 ${badId.status}`)
      // 名册不该因为这些被拒的请求多出东西来
      const list = await req(mgrBase, 'GET', '/seats', { token: machineTok })
      assert(list.json.seats.length === 1, `被拒的部署不该进名册：${list.json.seats.length}`)
    })

    await test('bot 反代：转发到本机端口，authorization 原样到达', async () => {
      const anon = await fetch(`${mgrBase}/seats/seat-1/bot/api/hello`)
      assert(anon.status === 401, `无机器票 ${anon.status}`)
      const r = await fetch(`${mgrBase}/seats/seat-1/bot/api/hello?x=1`, {
        headers: { 'x-satuwork-machine': machineTok, authorization: 'Bearer sat_seat_token' },
      })
      assert(r.status === 200, `反代 ${r.status}`)
      const body = await r.json()
      assert(body.path === '/api/hello?x=1', `路径重写 ${body.path}`)
      const last = bot.seen[bot.seen.length - 1]
      // 席位票原样透传给 bot；机器票是给管家的，不该继续往下走。
      assert(last.headers.authorization === 'Bearer sat_seat_token', 'authorization 没透传')
      assert(!last.headers['x-satuwork-machine'], '机器票漏给了 bot')
    })

    await test('SSE 经过反代不被缓冲，一帧一帧出来', async () => {
      const r = await fetch(`${mgrBase}/seats/seat-1/bot/api/sse`, {
        headers: { 'x-satuwork-machine': machineTok },
      })
      assert(r.status === 200, `sse ${r.status}`)
      assert(String(r.headers.get('content-type')).includes('text/event-stream'), 'content-type')
      const text = await r.text()
      assert(text.includes('"seq":1') && text.includes('"seq":2'), `帧不全: ${text}`)
    })

    // ── 浏览器直连的对话流（5 号协议）────────────────────────────────────
    //
    // 路径 /seats/:id/stream/*：带登录 JWT 来，管家验完换成席位票转给 bot，对 Gateway
    // 的源开 CORS。这是 Gateway 从对话热路径上退下来的第一步（docs/adr-gateway-vercel-neon.md）。

    await test('直连流：预检只认 Gateway 的源', async () => {
      const ok = await fetch(`${mgrBase}/seats/seat-1/stream/sessions/s1/events`, {
        method: 'OPTIONS',
        headers: { origin: gwBase, 'access-control-request-method': 'GET' },
      })
      assert(ok.status === 204, `预检 ${ok.status}`)
      assert(ok.headers.get('access-control-allow-origin') === gwBase, `allow-origin=${ok.headers.get('access-control-allow-origin')}`)
      assert(String(ok.headers.get('access-control-allow-headers')).includes('authorization'), 'allow-headers 要放 authorization')
      const bad = await fetch(`${mgrBase}/seats/seat-1/stream/sessions/s1/events`, {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
      })
      assert(bad.status === 403, `别的源 ${bad.status}`)
      assert(!bad.headers.get('access-control-allow-origin'), '别的源不该拿到 allow-origin')
    })

    await test('直连流：无票 401，桌面票 401，别人的席位 403', async () => {
      const url = `${mgrBase}/seats/seat-1/stream/sessions/s1/events`
      const anon = await fetch(url, { headers: { origin: gwBase } })
      assert(anon.status === 401, `无票 ${anon.status}`)
      // 错误响应上也要有 CORS 头，否则浏览器里看到的是一句 network error，前端分不清。
      assert(anon.headers.get('access-control-allow-origin') === gwBase, '401 也要带 allow-origin')
      // 桌面票是 Gateway 签的、签名是真的，但它只对一块屏有效，不代表一个人。
      const ticket = await mintTicket(gwBase, ownerTok)
      const desk = await fetch(url, { headers: { authorization: 'Bearer ' + ticket, origin: gwBase } })
      assert(desk.status === 401, `桌面票 ${desk.status}`)
      // seat-1 的 linuxUser 是 sw-test，不是 owner 算出来的那个。
      const other = await fetch(url, { headers: { authorization: 'Bearer ' + ownerTok, origin: gwBase } })
      assert(other.status === 403, `别人的席位 ${other.status} ${await other.text()}`)
    })

    await test('直连流：自己的席位换成 sat_ 到达 bot，只放 GET 和 /sessions', async () => {
      const me = await req(gwBase, 'GET', '/me', { token: ownerTok })
      assert(me.status === 200, `/me ${me.status}`)
      const ownerId = me.json.account.id
      // 和 gateway/src/deploy.ts 的 linuxUserOf 同一个式子——名册里就是这么存的。
      const linuxUser = 'sw-' + createHash('sha256').update(ownerId).digest('hex').slice(0, 12)
      const put = await req(mgrBase, 'PUT', '/seats/seat-3', {
        token: machineTok,
        body: {
          linuxUser,
          homeDir: `/home/${linuxUser}`,
          workDir: `/home/${linuxUser}/work`,
          seatDir: `/home/${linuxUser}/.satuwork/seat-3`,
          botId: 'bot-3',
          botVersion: '0.0.0-e2e',
          vncPassword: 'x'.repeat(16),
          gatewayUrl: gwBase,
          gatewayToken: 'sat_owner_3',
          gatewayApiKey: 'sk_sw_owner_3',
          ports: { display: 12, vncPort: 5912, novncPort: NOVNC_PORT, botPort: BOT_PORT, cdpPort: 9224 },
        },
      })
      assert(put.status === 200, `部署 seat-3 ${put.status} ${put.text}`)
      // 席位票不出管家：名册接口上不该看到它。
      const listed = await req(mgrBase, 'GET', '/seats', { token: machineTok })
      assert(listed.status === 200, `seats ${listed.status}`)
      const row3 = (listed.json.seats || []).find((x) => x.seatId === 'seat-3')
      assert(row3 && !('gatewayToken' in row3), '名册接口漏出了 gatewayToken')

      // 断言砸了也要把 seat-3 拆掉，否则后面「名册应当拆空」那几条会跟着莫名其妙地坏。
      try {
      const before = bot.seen.length
      const r = await fetch(`${mgrBase}/seats/seat-3/stream/sessions/s1/events?after=7`, {
        headers: { authorization: 'Bearer ' + ownerTok, origin: gwBase, accept: 'text/event-stream' },
      })
      // 正文只读一次：模板串里的 `await r.text()` 在断言成立时也会执行，再 .json() 就读不到了。
      const text = await r.text()
      assert(r.status === 200, `直连 ${r.status} ${text}`)
      assert(r.headers.get('access-control-allow-origin') === gwBase, '响应上要有 allow-origin')
      assert(r.headers.get('cache-control') === 'no-store', 'no-store')
      const body = JSON.parse(text)
      assert(body.path === '/api/sessions/s1/events?after=7', `路径重写 ${body.path}`)
      assert(bot.seen.length === before + 1, '应当正好打到 bot 一次')
      const last = bot.seen[bot.seen.length - 1]
      assert(last.headers.authorization === 'Bearer sat_owner_3', `到 bot 的票是 ${last.headers.authorization}`)

      const post = await fetch(`${mgrBase}/seats/seat-3/stream/sessions/s1/messages`, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + ownerTok, origin: gwBase, 'content-type': 'application/json' },
        body: '{}',
      })
      assert(post.status === 405, `POST ${post.status}`)
      const outside = await fetch(`${mgrBase}/seats/seat-3/stream/health`, {
        headers: { authorization: 'Bearer ' + ownerTok, origin: gwBase },
      })
      assert(outside.status === 404, `会话之外 ${outside.status}`)
      assert(bot.seen.length === before + 1, '405 / 404 都不该打到 bot')
      } finally {
        const gone = await req(mgrBase, 'DELETE', '/seats/seat-3', { token: machineTok })
        assert(gone.status === 200, `清掉 seat-3 ${gone.status}`)
      }
    })

    /**
     * 浏览器直连上传（9 号协议）。
     *
     * 文件字节没理由经 Gateway 过一手（Vercel 函数既有时限又有请求体上限），所以 Gateway 上
     * 那条 `POST /runtime/sessions/:id/files` 删了，改从 `/seats/:id/stream` 这条前缀放行**唯一
     * 一条 POST**。钉三样：正文和 x-filename 原样到 bot、票换成了席位的 sat_、别的 POST 仍 405。
     */
    await test('直连上传：POST /sessions/:id/files 换成 sat_ 原样到达 bot，别的 POST 仍 405', async () => {
      const me = await req(gwBase, 'GET', '/me', { token: ownerTok })
      const linuxUser = 'sw-' + createHash('sha256').update(me.json.account.id).digest('hex').slice(0, 12)
      const put = await req(mgrBase, 'PUT', '/seats/seat-5', {
        token: machineTok,
        body: {
          linuxUser,
          homeDir: `/home/${linuxUser}`,
          workDir: `/home/${linuxUser}/work`,
          seatDir: `/home/${linuxUser}/.satuwork/seat-5`,
          botId: 'bot-5',
          botVersion: '0.0.0-e2e',
          vncPassword: 'x'.repeat(16),
          gatewayUrl: gwBase,
          gatewayToken: 'sat_owner_5',
          gatewayApiKey: 'sk_sw_owner_5',
          ports: { display: 14, vncPort: 5914, novncPort: NOVNC_PORT, botPort: BOT_PORT, cdpPort: 9226 },
        },
      })
      assert(put.status === 200, `部署 seat-5 ${put.status} ${put.text}`)
      try {
        const url = `${mgrBase}/seats/seat-5/stream/sessions/s1/files`
        // 预检：浏览器发 POST 前先问一句，allow-methods 里没有 POST 的话，正文压根不会发出去。
        const pre = await fetch(url, {
          method: 'OPTIONS',
          headers: {
            origin: gwBase,
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'authorization, content-type, x-filename',
          },
        })
        assert(pre.status === 204, `预检 ${pre.status}`)
        assert(pre.headers.get('access-control-allow-origin') === gwBase, `allow-origin=${pre.headers.get('access-control-allow-origin')}`)
        assert(/\bPOST\b/.test(String(pre.headers.get('access-control-allow-methods'))), `allow-methods 要放 POST：${pre.headers.get('access-control-allow-methods')}`)
        const allowHeaders = String(pre.headers.get('access-control-allow-headers')).toLowerCase()
        assert(allowHeaders.includes('x-filename') && allowHeaders.includes('content-type'), `allow-headers 要放 x-filename 和 content-type：${allowHeaders}`)

        // 挑一段跨 chunk 边界也要拼对的内容，中文名走 x-filename 一路带过去。
        const bytes = Buffer.from('报表内容\n第二行\n', 'utf8')
        const filename = encodeURIComponent('季度报表.txt')
        const before = bot.seen.length
        const r = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + ownerTok,
            origin: gwBase,
            'content-type': 'application/octet-stream',
            'x-filename': filename,
          },
          body: bytes,
        })
        const text = await r.text()
        assert(r.status === 200, `上传 ${r.status} ${text}`)
        assert(r.headers.get('access-control-allow-origin') === gwBase, '响应上要有 allow-origin')
        const body = JSON.parse(text)
        assert(body.size === bytes.length && body.name === '季度报表.txt', `bot 的回包没原样回来：${text}`)
        assert(bot.seen.length === before + 1, `应当正好打到 bot 一次，实际 ${bot.seen.length - before}`)
        const hit = bot.seen[before]
        assert(hit.method === 'POST' && hit.path === '/api/sessions/s1/files', `到 bot 的是 ${hit.method} ${hit.path}`)
        assert(hit.headers.authorization === 'Bearer sat_owner_5', `到 bot 的票是 ${hit.headers.authorization}`)
        assert(hit.headers['x-filename'] === filename, `x-filename 在路上坏了：${hit.headers['x-filename']}`)
        assert(hit.body && Buffer.compare(hit.body, bytes) === 0, `正文在路上坏了：${hit.body && hit.body.toString('utf8')}`)

        // 无票：401，而不是把匿名的字节塞给 bot。
        const anon = await fetch(url, {
          method: 'POST',
          headers: { origin: gwBase, 'content-type': 'application/octet-stream', 'x-filename': 'a.txt' },
          body: 'x',
        })
        assert(anon.status === 401, `无票上传 ${anon.status}`)
        // 发消息仍走 Gateway（那条带 @ 点名校验）：这条前缀上别的 POST 一律 405。
        const msg = await fetch(`${mgrBase}/seats/seat-5/stream/sessions/s1/messages`, {
          method: 'POST',
          headers: { authorization: 'Bearer ' + ownerTok, origin: gwBase, 'content-type': 'application/json' },
          body: '{}',
        })
        assert(msg.status === 405, `POST messages ${msg.status}`)
        // 多带一段路径也不行：只认恰好 /sessions/:id/files。
        const deeper = await fetch(`${mgrBase}/seats/seat-5/stream/sessions/s1/files/extra`, {
          method: 'POST',
          headers: { authorization: 'Bearer ' + ownerTok, origin: gwBase },
          body: 'x',
        })
        assert(deeper.status === 405, `POST files/extra ${deeper.status}`)
        assert(bot.seen.length === before + 1, '401 / 405 都不该打到 bot')
      } finally {
        const gone = await req(mgrBase, 'DELETE', '/seats/seat-5', { token: machineTok })
        assert(gone.status === 200, `清掉 seat-5 ${gone.status}`)
      }
    })

    await test('直连名单流：合成这个人在本机的席位，帧过滤过，CORS 头随响应', async () => {
      const me = await req(gwBase, 'GET', '/me', { token: ownerTok })
      const linuxUser = 'sw-' + createHash('sha256').update(me.json.account.id).digest('hex').slice(0, 12)
      const put = await req(mgrBase, 'PUT', '/seats/seat-4', {
        token: machineTok,
        body: {
          linuxUser,
          homeDir: `/home/${linuxUser}`,
          workDir: `/home/${linuxUser}/work`,
          seatDir: `/home/${linuxUser}/.satuwork/seat-4`,
          botId: 'bot-4',
          botVersion: '0.0.0-e2e',
          vncPassword: 'x'.repeat(16),
          gatewayUrl: gwBase,
          gatewayToken: 'sat_owner_4',
          gatewayApiKey: 'sk_sw_owner_4',
          ports: { display: 13, vncPort: 5913, novncPort: NOVNC_PORT, botPort: BOT_PORT, cdpPort: 9225 },
        },
      })
      assert(put.status === 200, `部署 seat-4 ${put.status} ${put.text}`)
      try {
        const pre = await fetch(`${mgrBase}/roster/stream`, {
          method: 'OPTIONS',
          headers: { origin: gwBase, 'access-control-request-method': 'GET' },
        })
        assert(pre.status === 204, `预检 ${pre.status}`)
        const anon = await fetch(`${mgrBase}/roster/stream`, { headers: { origin: gwBase } })
        assert(anon.status === 401, `无票 ${anon.status}`)

        const ac = new AbortController()
        const r = await fetch(`${mgrBase}/roster/stream`, {
          headers: { authorization: 'Bearer ' + ownerTok, origin: gwBase, accept: 'text/event-stream' },
          signal: ac.signal,
        })
        assert(r.status === 200, `名单流 ${r.status} ${r.status !== 200 ? await r.text() : ''}`)
        assert(r.headers.get('access-control-allow-origin') === gwBase, '响应上要有 allow-origin')
        assert(String(r.headers.get('content-type')).includes('text/event-stream'), 'content-type')
        // 读到 roster/live 为止：它排在最后，到了就说明前面的都到了。最多等 5 秒。
        const frames = []
        const reader = r.body.getReader()
        const deadline = setTimeout(() => ac.abort(), 5000)
        let buf = ''
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buf += Buffer.from(value).toString('utf8')
            let i
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const chunk = buf.slice(0, i)
              buf = buf.slice(i + 2)
              for (const line of chunk.split('\n')) if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)))
            }
            if (frames.some((f) => f.type === 'roster/live')) break
          }
        } catch {}
        clearTimeout(deadline)
        ac.abort()
        const types = frames.map((f) => `${f.type}:${f.ev ? f.ev.type : f.live}`)
        assert(frames.every((f) => f.botId === 'bot-4'), `帧要归到 bot-4：${types.join(',')}`)
        assert(types.includes('roster/ev:user/message'), `该转的没转：${types.join(',')}`)
        assert(!types.some((t) => t.includes('tool/result')), `该滤的转了：${types.join(',')}`)
        assert(types.includes('roster/live:false'), `没有 live：${types.join(',')}`)
        // 上游拿的是名册里那把票，不是浏览器的登录票。
        const up = bot.seen.filter((x) => x.path.startsWith('/api/sessions/s-roster/events'))
        assert(up.length >= 1 && up[up.length - 1].headers.authorization === 'Bearer sat_owner_4', '到 bot 的票要是 sat_owner_4')
      } finally {
        for (const open of bot.rosterOpen.splice(0)) {
          try {
            open.end()
          } catch {}
        }
        const gone = await req(mgrBase, 'DELETE', '/seats/seat-4', { token: machineTok })
        assert(gone.status === 200, `清掉 seat-4 ${gone.status}`)
      }
    })

    await test('未知席位 404，不暴露端口', async () => {
      const r = await fetch(`${mgrBase}/seats/no-such/bot/api/x`, {
        headers: { 'x-satuwork-machine': machineTok },
      })
      assert(r.status === 404, `未知席位 ${r.status}`)
    })

    let deskCookie = ''
    /** 落地页地址。下一条要从它的 query 里取 path——那正是 noVNC 建连的唯一依据。 */
    let deskLanding = ''

    await test('桌面票：无票 401，有效票写进路径并跳转', async () => {
      const anon = await fetch(`${mgrBase}/seats/seat-1/vnc/`, { redirect: 'manual' })
      assert(anon.status === 401, `无票 ${anon.status}`)
      const bad = await fetch(`${mgrBase}/seats/seat-1/vnc/?ticket=not-a-jwt`, { redirect: 'manual' })
      assert(bad.status === 401, `坏票 ${bad.status}`)
      // 畸形 cookie（解不开的百分号）也只是 401，不是 500：它原来在 decodeURIComponent 里抛，
      // 一路抛到路由器兜底，再往 journal 打一整段栈——谁都能不带票地拿它刷这台机器的日志。
      const junk = await fetch(`${mgrBase}/seats/seat-1/vnc/vnc.html`, { headers: { cookie: 'satu_desk_seat-1=%' } })
      assert(junk.status === 401, `畸形 cookie ${junk.status}`)

      const ticket = await mintTicket(gwBase, ownerTok)
      const r = await fetch(`${mgrBase}/seats/seat-1/vnc/?ticket=${encodeURIComponent(ticket)}`, {
        redirect: 'manual',
      })
      assert(r.status === 302, `换 cookie ${r.status}`)
      deskLanding = String(r.headers.get('location'))
      // **票落在路径里**，不是只靠 cookie：桌面端那块屏是跨站 iframe，而 WKWebView
      // （Safari 引擎）拦掉一切第三方 cookie，`SameSite=None; Secure` 也没用。少了这一条，
      // 桌面端的表现是落地页打开、之后每条资源全 401。
      assert(
        deskLanding.startsWith(`/seats/seat-1/vnc/t/${encodeURIComponent(ticket)}/vnc.html`),
        `票该写进路径：location=${deskLanding}`,
      )
      // 票里没带口令时不许凭空造一个 password 参数出来——那会让 noVNC 拿空口令去认证，
      // 直接失败，而不是老老实实弹输入框。
      assert(!deskLanding.includes('password='), `票里没口令却带了 password：${deskLanding}`)
      const setCookie = String(r.headers.get('set-cookie') || '')
      assert(setCookie.includes('HttpOnly'), 'cookie 要 HttpOnly')
      assert(setCookie.includes('Path=/seats/seat-1/vnc'), 'cookie 要限定到这个席位')
      deskCookie = setCookie.split(';')[0]
    })

    await test('拿着 cookie 能取 noVNC 静态资源，也能建 WebSocket', async () => {
      const page = await fetch(`${mgrBase}/seats/seat-1/vnc/vnc.html`, { headers: { cookie: deskCookie } })
      assert(page.status === 200, `静态 ${page.status}`)
      // **按 noVNC 自己的拼法去连**，不要照着「应该是什么路径」手写——它拼的是
      // `'/' + path`（从根开始），path 只能从落地页的 query 里来。原先这条断言直接
      // 写死了正确路径，于是「跳转没把 path 告诉 noVNC」这个 bug 一路测过去了：
      // 反代是好的，可 noVNC 压根不会往这儿连，它去连了 /websockify。
      const novncPath = new URLSearchParams(deskLanding.split('?')[1] || '').get('path')
      assert(novncPath, `落地页没带 path，noVNC 会去连 /websockify：${deskLanding}`)
      const ws = await wsHandshake(MGR_PORT, '/' + novncPath, deskCookie)
      assert(ws.includes('101'), `升级失败: ${ws.slice(0, 120)}`)
      assert(ws.includes('HELLO-WS'), '升级后字节没通')
      // **一个 cookie 都不给也要能升级**：桌面端就是这个处境（跨站 cookie 带不上），
      // 票在路径里就够。这条是那块屏在 Safari / WKWebView 里到底看不看得见的分界。
      const byPath = await wsHandshake(MGR_PORT, '/' + novncPath, '')
      assert(byPath.includes('101'), `路径里有票就该升级: ${byPath.slice(0, 120)}`)
      // 票那一段被换掉就不行——否则等于谁都能连。
      const forged = String(novncPath).replace(/\/t\/[^/]+\//, '/t/not-a-jwt/')
      const noAuth = await wsHandshake(MGR_PORT, '/' + forged, '')
      assert(noAuth.includes('401'), `坏票的升级应 401: ${noAuth.slice(0, 80)}`)
    })

    /**
     * 浏览器直连那条路上，**落地页得由管家自己改**：把 noVNC 的控制条关掉、并钉
     * frame-ancestors。走 Gateway 反代时这两件事是 Gateway 做的，直连那一跳没有它。
     *
     * 不做的表现很温和、也因此很难查：画面照常出来，只是多一条控件压着桌面右边，
     * 而两台机器的配置看不出任何区别。
     */
    await test('直连的落地页：管家自己插样式、钉 frame-ancestors，别的资源不碰', async () => {
      const page = await fetch(`${mgrBase}/seats/seat-1/vnc/vnc.html`, { headers: { cookie: deskCookie } })
      assert(page.status === 200, `落地页 ${page.status}`)
      const body = await page.text()
      assert(body.includes('VNC-PAGE'), '字节没带回来')
      assert(body.includes('#noVNC_control_bar_anchor'), '控制条那段样式没插进去')
      // 「Connected to …」只关 normal 那一档：控制条已经藏了，报错是页面上唯一还会
      // 说「连不上」的地方。
      assert(body.includes('#noVNC_status.noVNC_status_normal'), '连接成功那条提示没关掉')
      assert(!body.includes('noVNC_status_error'), '不该把报错那一档也关掉')
      assert(body.indexOf('#noVNC_control_bar_anchor') < body.indexOf('</head>'), '样式要在 </head> 之前')
      // 改了内容不重算长度，浏览器会按旧长度截断。
      assert(
        page.headers.get('content-length') === String(new TextEncoder().encode(body).length),
        '改了内容没重算长度',
      )
      // 这块屏只准 Gateway 的页面、或者桌面壳框进去——直连之后这个源是暴露在公网上的。
      const csp = String(page.headers.get('content-security-policy') || '')
      assert(csp.startsWith('frame-ancestors '), `没钉 frame-ancestors：${csp}`)
      assert(csp.includes(new URL(gwBase).origin), `frame-ancestors 该指向 Gateway 的源：${csp}`)
      // 桌面壳把界面打进了包里，页面源是 satu://localhost。少了它，桌面端右栏那块屏是
      // 一句「Refused to display … frame-ancestors」，而别的直连（对话流、名单流）都通
      // ——CORS 那边早就认这几个源了，两处必须一致。
      assert(csp.includes('satu://localhost'), `frame-ancestors 该放桌面壳的源：${csp}`)

      // 别的资源不许被碰：只有落地页走改写那条路。
      const asset = await fetch(`${mgrBase}/seats/seat-1/vnc/app/ui.js`, { headers: { cookie: deskCookie } })
      assert(!(await asset.text()).includes('noVNC_control_bar_anchor'), '普通资源不该被改写')

      /**
       * **只改 200 的正文。** 上游回 500 时把它原样送出去：错误页插一段藏控制条的
       * 样式没有任何意义，而 no-store 和重算过的 content-length 会盖掉上游自己的头，
       * 让同一块屏在直连和 Gateway 反代两条路上回出不同的现场。
       */
      const boom = await fetch(`${mgrBase}/seats/seat-1/vnc/vnc.html?boom=1`, { headers: { cookie: deskCookie } })
      assert(boom.status === 500, `状态码要原样透出：${boom.status}`)
      const boomBody = await boom.text()
      assert(boomBody.includes('UPSTREAM-500'), '正文要原样透出')
      assert(!boomBody.includes('noVNC_control_bar_anchor'), '非 200 不该被插样式')
      assert(boom.headers.get('cache-control') !== 'no-store', '非 200 不该被盖上 no-store')
      // CSP 每条都钉：框不框得住这块屏和它返 200 还是 500 没关系。
      assert(String(boom.headers.get('content-security-policy') || '').startsWith('frame-ancestors '), '非 200 也要钉 CSP')
    })

    await test('口令随票带过来时，落地页直接免密进桌面', async () => {
      // 「打开桌面」的意图是看桌面，不是打开一个还要人回去抄一遍口令的登录框。
      // Gateway 把席位口令签在票里，管家验完签转成 noVNC 认的 password 参数。
      const ticket = mintTicketWithPassword(GW_HOME, 'seat-1', 'PW-secret-9')
      const r = await fetch(`${mgrBase}/seats/seat-1/vnc/?ticket=${encodeURIComponent(ticket)}`, {
        redirect: 'manual',
      })
      assert(r.status === 302, `换 cookie ${r.status}`)
      const loc = String(r.headers.get('location'))
      const q = new URLSearchParams(loc.split('?')[1] || '')
      assert(q.get('password') === 'PW-secret-9', `口令没转过去：${loc}`)
      assert(q.get('autoconnect') === '1', `没自动连：${loc}`)
      assert(q.get('path'), `path 丢了：${loc}`)
    })

    await test('显示参数按白名单透传，path 与 password 不许被外面覆盖', async () => {
      // 右栏那块内嵌预览只有两百来像素宽，没有 resize=scale 就只看得见桌面左上角。
      // 但同一个入口不能让调用方顺手改掉连接地址和口令——那两个只能由票说了算。
      const ticket = mintTicketWithPassword(GW_HOME, 'seat-1', 'PW-secret-9')
      const q0 = new URLSearchParams({
        ticket,
        resize: 'scale',
        bell: 'false',
        path: 'evil/websockify',
        password: 'stolen',
        onload: '<script>',
      })
      const r = await fetch(`${mgrBase}/seats/seat-1/vnc/?${q0}`, { redirect: 'manual' })
      assert(r.status === 302, `换 cookie ${r.status}`)
      const q = new URLSearchParams(String(r.headers.get('location')).split('?')[1] || '')
      assert(q.get('resize') === 'scale', `resize 没透传：${q}`)
      assert(q.get('bell') === 'false', `bell 没透传：${q}`)
      // path 由管家自己拼（票在里面，见 VNC_TICKET_PATH），外面传什么都不作数。
      assert(
        q.get('path') === `seats/seat-1/vnc/t/${encodeURIComponent(ticket)}/websockify`,
        `path 被覆盖了：${q.get('path')}`,
      )
      assert(q.get('password') === 'PW-secret-9', `password 被覆盖了：${q.get('password')}`)
      assert(q.get('onload') === null, `白名单外的参数漏过去了：${q}`)
    })

    await test('席位诊断：给得出现场，而且不漏凭据', async () => {
      // 这个接口是为「没有 SSH 就看不见机器」补的洞。它最该答上的几个问题，正是今天
      // 排查里逐个靠人肉 ps/ss/journalctl 才问出来的：端口归谁、服务什么时候起的、
      // dock 项在不在、浏览器装没装。
      const anon = await fetch(`${mgrBase}/seats/seat-1/diag`)
      assert(anon.status === 401, `无票该 401，实际 ${anon.status}`)

      const r = await req(mgrBase, 'GET', '/seats/seat-1/diag', { token: machineTok })
      assert(r.status === 200, `diag ${r.status} ${r.text}`)
      const d = r.json.diag
      assert(d.seatId === 'seat-1', `seatId=${d.seatId}`)
      assert(d.seat && d.seat.linuxUser, '该带上名册里那条记录')
      // 三个端口都要有一行——「没人在听」也是结论，不能因为查不到就整条不给。
      assert(Array.isArray(d.ports) && d.ports.length === 3, `ports 应有 3 条，实际 ${JSON.stringify(d.ports)}`)
      assert(d.units.length === 2, `units 应有桌面和 bot 两条，实际 ${d.units.length}`)
      assert(Array.isArray(d.files) && d.files.some((f) => f.path.endsWith('vnc-passwd')), 'files 里该有 vnc-passwd')
      assert(Array.isArray(d.notes), 'notes 要在——「哪里不对」得写成人话，不能让人自己比对字段')
      assert('found' in d.browser, 'browser 探测结果要在')

      // **口令一个字都不能出去。** vnc-passwd 只报存在与时间；报告会经 Gateway 到浏览器。
      const blob = JSON.stringify(d)
      assert(!blob.includes('vncPassword'), '报告里不该出现 vncPassword 字段')
      const pw = d.files.find((f) => f.path.endsWith('vnc-passwd'))
      assert(pw && !('content' in pw), 'vnc-passwd 只能报存在与时间，不能报内容')
    })

    await test('运行日志：无票 401，未知席位 404，有票给得出结构', async () => {
      // diag 回答「它活着吗」，这条回答「它卡在哪一步」——这一层最贵的故障都不报错：
      // 单元 active、端口有人听，只是那一轮永远不结束。
      const anon = await fetch(`${mgrBase}/seats/seat-1/logs`)
      assert(anon.status === 401, `无票该 401，实际 ${anon.status}`)

      // unit 名是拿 seatId 拼的，所以只让名册里有的席位过去。
      const nope = await req(mgrBase, 'GET', '/seats/seat-nope/logs', { token: machineTok })
      assert(nope.status === 404, `未知席位该 404，实际 ${nope.status} ${nope.text}`)

      const r = await req(mgrBase, 'GET', '/seats/seat-1/logs?lines=5', { token: machineTok })
      assert(r.status === 200, `logs ${r.status} ${r.text}`)
      // 开发机上没有 journalctl，取不到就是空数组——但字段必须在，不能整条塌掉。
      assert(Array.isArray(r.json.lines), `lines 该是数组：${r.text.slice(0, 200)}`)
      assert(r.json.seatId === 'seat-1', `seatId=${r.json.seatId}`)
    })

    /**
     * 浏览器直连跟日志（9 号协议）。
     *
     * 机器票是管家的 root 控制面凭据，一步都不能往浏览器放；而 Gateway 上那条 `follow=1`
     * 的 SSE 反代是最后一条会在 Gateway 上挂小时级的连接，删了。剩下的路：Gateway 判完资格
     * 签一张五分钟的**日志票**（只写单元和席位），浏览器拿它直打管家。这一组钉的是两头
     * 接得上——Gateway 签的票管家认、认得对（桌面票不行、别的席位不行、没票不行），CORS
     * 头随响应；拿机器票来的那条老路一个字不变。
     */
    await test('直连日志：Gateway 签的日志票管家认，桌面票 / 别的席位 / 无票各归各的错', async () => {
      const machineId = await machineIdOf(req, gwBase, ownerTok, orgId)
      const me = await req(gwBase, 'GET', '/me', { token: ownerTok })
      assert(me.status === 200, `/me ${me.status}`)
      const auditCount = async () => {
        const a = await req(gwBase, 'GET', `/orgs/${orgId}/audit`, { token: ownerTok })
        return (a.json.events || a.json.rows || []).filter((e) => e.action === 'machine.logs').length
      }

      // follow=1 那条老路要**真的没了**（410，不是静默降级成最近 N 行）：老界面还传的话，
      // 人以为在跟，其实屏幕早停了。
      const follow = await req(gwBase, 'GET', `/platform/machines/${machineId}/logs?follow=1`, { token: ownerTok })
      assert(follow.status === 410, `follow=1 该 410，实际 ${follow.status} ${follow.text}`)
      // 一次 JSON 往返的「最近 N 行」照旧经 Gateway，不受协议号和直连地址限制。
      const plain = await req(gwBase, 'GET', `/platform/machines/${machineId}/logs?lines=5`, { token: ownerTok })
      assert(plain.status === 200 && Array.isArray(plain.json.lines), `不跟随的日志照旧：${plain.status} ${plain.text.slice(0, 200)}`)

      // 没配直连地址：409 明说，而不是签一张打不出去的票。
      const none = await req(gwBase, 'GET', `/platform/machines/${machineId}/logs/direct`, { token: ownerTok })
      assert(none.status === 409, `没配 directUrl 该 409，实际 ${none.status} ${none.text}`)

      // 直连地址必须是 https，真管家在本机是 http——所以填一个假域名让 Gateway 肯签票，
      // 请求由这里直接打到 mgrBase。验的是票，不是那个域名通不通。
      const DIRECT = 'https://mgr-e2e.satuwork.test'
      const set = await req(gwBase, 'PUT', `/platform/machines/${machineId}/direct-url`, { token: ownerTok, body: { directUrl: DIRECT } })
      assert(set.status === 200, `设直连 ${set.status} ${set.text}`)
      // 协议号由心跳自报。真管家报的就是 9（/health 那条盯着），但前面有用例拿假心跳把这台
      // 报成过 1，真管家下一轮心跳要 30 秒后才来——这里明说一次，别让用例靠时机。
      const hb = await req(gwBase, 'POST', `/internal/machines/${machineId}/heartbeat`, {
        token: machineTok,
        body: { managerVersion: 'e2e-9', protocol: 9, node: process.versions.node, seats: [] },
      })
      assert(hb.status === 200, `heartbeat ${hb.status} ${hb.text}`)

      // seat-1 是管家侧登记的假席位；Gateway 只给**这台机器上**的席位签票（seatId 会进单元名），
      // 所以在 Gateway 库里补一行，结束时删掉——后面「Gateway 下发部署」那条要靠这台机器空着。
      const { createRequire } = await import('node:module')
      const require = createRequire(new URL('../gateway/package.json', import.meta.url))
      const pg = require('pg')
      const client = new pg.Client({ connectionString: PG_URL })
      await client.connect()
      try {
        await client.query(`set search_path to ${SCHEMA}`)
        await client.query(
          `insert into seat_runtimes ("accountId","botId","companyId","linuxUser","seatId","machineId",slot,display,"vncPort","novncPort","botPort","vncPassword",status,"deployedAt","updatedAt","botVersion")
           values ($1,'bot-1',$2,'sw-test','seat-1',$3,9,19,5919,6090,3209,'pw','ready',$4,$4,'0.0.0-e2e')`,
          [me.json.account.id, orgId, machineId, Date.now()],
        )

        const audits0 = await auditCount()
        const direct = await req(gwBase, 'GET', `/platform/machines/${machineId}/logs/direct?seatId=seat-1`, { token: ownerTok })
        assert(direct.status === 200, `签席位日志票 ${direct.status} ${direct.text}`)
        assert(direct.json.url === `${DIRECT}/seats/seat-1/logs`, `席位日志的直连地址不对：${direct.json.url}`)
        const seatTicket = direct.json.ticket
        assert(typeof seatTicket === 'string' && seatTicket.split('.').length === 3, `票不像 JWT：${seatTicket}`)
        // 签票就是「看别人的日志」，和经 Gateway 看一样要留痕。
        assert((await auditCount()) === audits0 + 1, '签日志票没留审计')
        // 外来 seatId 照旧挡：票上会写死席位，签给一个不在这台机器上的席位就是给单元名开口子。
        const badSeat = await req(gwBase, 'GET', `/platform/machines/${machineId}/logs/direct?seatId=seat-not-here`, { token: ownerTok })
        assert(badSeat.status === 404, `外来 seatId 该 404，实际 ${badSeat.status} ${badSeat.text}`)
        // 公司侧那条同义路由也要通（机器页和公司详情页都有「跟日志」）。
        const viaOrg = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machines/${machineId}/logs/direct?seatId=seat-1`, { token: ownerTok })
        assert(viaOrg.status === 200 && viaOrg.json.url === direct.json.url, `公司侧签票 ${viaOrg.status} ${viaOrg.text}`)
        assert((await req(gwBase, 'GET', `/platform/machines/${machineId}/logs/direct?seatId=seat-1`)).status === 401, '无 owner 票该 401')

        const seatUrl = `${mgrBase}/seats/seat-1/logs`
        // 预检只看源，不看票——浏览器发预检时还没带 Authorization。
        const pre = await fetch(seatUrl, {
          method: 'OPTIONS',
          headers: { origin: gwBase, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
        })
        assert(pre.status === 204, `预检 ${pre.status}`)
        assert(pre.headers.get('access-control-allow-origin') === gwBase, `allow-origin=${pre.headers.get('access-control-allow-origin')}`)
        assert(String(pre.headers.get('access-control-allow-headers')).toLowerCase().includes('authorization'), 'allow-headers 要放 authorization')
        const badOrigin = await fetch(seatUrl, {
          method: 'OPTIONS',
          headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
        })
        assert(badOrigin.status === 403, `别的源预检 ${badOrigin.status}`)

        // 票对、席位对：200，CORS 头随响应，结构和拿机器票问到的一样。
        const ok = await fetch(`${seatUrl}?lines=5`, { headers: { authorization: 'Bearer ' + seatTicket, origin: gwBase } })
        const okText = await ok.text()
        assert(ok.status === 200, `日志票看席位日志 ${ok.status} ${okText}`)
        assert(ok.headers.get('access-control-allow-origin') === gwBase, '响应上要有 allow-origin')
        const okBody = JSON.parse(okText)
        assert(Array.isArray(okBody.lines) && okBody.seatId === 'seat-1', `结构不对：${okText.slice(0, 200)}`)
        // 跟着滚：同一张票开 SSE。只钉「响应头当场到、是事件流、带 CORS」，**不读正文**：
        // 真机上 journalctl -f 对一个安静的单元几十秒不吐字节，流不会自己结束；开发机上
        // 没有 journalctl，流当场带一条 error 帧就结束——两种环境下都不能等它读完。
        // 断言消息里也不能 `await sse.text()`：模板字符串是先求值的，条件成立照样会等。
        const sseAbort = new AbortController()
        const sse = await fetch(`${seatUrl}?lines=5&follow=1`, {
          headers: { authorization: 'Bearer ' + seatTicket, origin: gwBase, accept: 'text/event-stream' },
          signal: AbortSignal.any([sseAbort.signal, AbortSignal.timeout(8000)]),
        })
        assert(sse.status === 200, `follow ${sse.status}`)
        assert(String(sse.headers.get('content-type')).includes('text/event-stream'), `follow content-type ${sse.headers.get('content-type')}`)
        assert(sse.headers.get('access-control-allow-origin') === gwBase, 'SSE 响应上要有 allow-origin')
        sseAbort.abort()
        await sse.text().catch(() => '')

        // 无票 / 假票：401，错误响应上也要有 CORS 头，否则浏览器里只剩一句 network error。
        const anon = await fetch(`${seatUrl}?lines=5`, { headers: { origin: gwBase } })
        assert(anon.status === 401, `无票 ${anon.status}`)
        assert(anon.headers.get('access-control-allow-origin') === gwBase, '401 也要带 allow-origin')
        const junk = await fetch(`${seatUrl}?lines=5`, { headers: { authorization: 'Bearer not.a.jwt', origin: gwBase } })
        assert(junk.status === 401, `假票 ${junk.status}`)
        // 桌面票是 Gateway 签的、签名是真的，但一张票只开一扇门。
        const desk = await mintTicket(gwBase, ownerTok)
        const viaDesk = await fetch(`${seatUrl}?lines=5`, { headers: { authorization: 'Bearer ' + desk, origin: gwBase } })
        assert(viaDesk.status === 401, `桌面票看日志 ${viaDesk.status}`)
        // 登录 JWT 也不行：日志的资格由 Gateway 判，管家只认它签的日志票。
        const viaLogin = await fetch(`${seatUrl}?lines=5`, { headers: { authorization: 'Bearer ' + ownerTok, origin: gwBase } })
        assert(viaLogin.status === 401, `登录票看日志 ${viaLogin.status}`)
        // 票是好的，只是拿错了门：403，不是 401。
        const other = await fetch(`${mgrBase}/seats/seat-2/logs?lines=5`, { headers: { authorization: 'Bearer ' + seatTicket, origin: gwBase } })
        assert(other.status === 403, `别的席位 ${other.status} ${await other.text()}`)
        const seatOnMgr = await fetch(`${mgrBase}/logs?lines=5`, { headers: { authorization: 'Bearer ' + seatTicket, origin: gwBase } })
        assert(seatOnMgr.status === 403, `席位票看管家日志 ${seatOnMgr.status}`)

        // 管家自己的日志：不带 seatId 签出来的是 unit=manager 的票。
        const mgrDirect = await req(gwBase, 'GET', `/platform/machines/${machineId}/logs/direct`, { token: ownerTok })
        assert(mgrDirect.status === 200, `签管家日志票 ${mgrDirect.status} ${mgrDirect.text}`)
        assert(mgrDirect.json.url === `${DIRECT}/logs`, `管家日志的直连地址不对：${mgrDirect.json.url}`)
        const mgrTicket = mgrDirect.json.ticket
        const mgrOk = await fetch(`${mgrBase}/logs?lines=5`, { headers: { authorization: 'Bearer ' + mgrTicket, origin: gwBase } })
        const mgrText = await mgrOk.text()
        assert(mgrOk.status === 200, `日志票看管家日志 ${mgrOk.status} ${mgrText}`)
        assert(mgrOk.headers.get('access-control-allow-origin') === gwBase, '响应上要有 allow-origin')
        const mgrBody = JSON.parse(mgrText)
        assert(Array.isArray(mgrBody.lines) && /satuwork-manager/.test(mgrBody.unit || ''), `结构不对：${mgrText.slice(0, 200)}`)
        const mgrOnSeat = await fetch(`${seatUrl}?lines=5`, { headers: { authorization: 'Bearer ' + mgrTicket, origin: gwBase } })
        assert(mgrOnSeat.status === 403, `管家票看席位日志 ${mgrOnSeat.status}`)
        const mgrPre = await fetch(`${mgrBase}/logs`, { method: 'OPTIONS', headers: { origin: gwBase, 'access-control-request-method': 'GET' } })
        assert(mgrPre.status === 204, `管家日志预检 ${mgrPre.status}`)

        // 拿机器票来的老路一个字不变：两个头都认，不带 CORS 也照答。
        const viaMachine = await req(mgrBase, 'GET', '/seats/seat-1/logs?lines=5', { token: machineTok })
        assert(viaMachine.status === 200 && viaMachine.json.seatId === 'seat-1', `机器票 ${viaMachine.status} ${viaMachine.text}`)
        const viaHeader = await fetch(`${mgrBase}/logs?lines=5`, { headers: { 'x-satuwork-machine': machineTok } })
        assert(viaHeader.status === 200, `x-satuwork-machine ${viaHeader.status}`)
      } finally {
        await client.query('delete from seat_runtimes where "machineId" = $1 and "seatId" = $2', [machineId, 'seat-1']).catch(() => {})
        await client.end().catch(() => {})
        // 直连地址清掉：后面桌面 / 名单那些用例按「没配」的路子写的。
        const cleared = await req(gwBase, 'PUT', `/platform/machines/${machineId}/direct-url`, { token: ownerTok, body: { directUrl: '' } })
        assert(cleared.status === 200, `清直连 ${cleared.status} ${cleared.text}`)
      }
    })

    await test('席位诊断：不认识的席位给结论，不是 500', async () => {
      const r = await req(mgrBase, 'GET', '/seats/seat-nope/diag', { token: machineTok })
      assert(r.status === 200, `未知席位也该正常回，实际 ${r.status} ${r.text}`)
      assert(r.json.diag.seat === null, 'seat 该是 null')
      assert(r.json.diag.notes.length > 0, '该说清楚「名册里没有这个席位」')
    })

    await test('拆席位：名册里没了，反代跟着 404', async () => {
      const r = await req(mgrBase, 'DELETE', '/seats/seat-1', { token: machineTok })
      assert(r.status === 200, `拆 ${r.status} ${r.text}`)
      const list = await req(mgrBase, 'GET', '/seats', { token: machineTok })
      assert(list.json.seats.length === 0, '名册没清干净')
      const gone = await fetch(`${mgrBase}/seats/seat-1/bot/api/x`, {
        headers: { 'x-satuwork-machine': machineTok },
      })
      assert(gone.status === 404, `拆完还转 ${gone.status}`)
    })

    /**
     * 整条走一遍：Gateway 下发 → 管家排空 → 席位在忙 → 409 一路回到 Gateway。
     *
     * 上面那三条钉的是管家自己的行为，这一条钉的是**两边接得上**：Gateway 必须把「忙」
     * 和「失败」分开——忙的那一次机器上一个字节都没动，席位还是原来的版本、还在好好地
     * 跑，把它标成 error 会让人去查一个根本不存在的部署故障，标成 deploying 更糟（界面
     * 上永远转圈，而机器上什么都没在进行）。
     *
     * 假 bot 蹲在 3200：那是 slot 0 的席位 bot 口（见 gateway/src/deploy.ts 的 portsOf），
     * 排空要问的就是它。这台机器上此刻一个席位都没有（上一条刚把 seat-1 拆了），所以
     * Gateway 分给它的必然是 slot 0。
     */
    await test('席位有会话在跑：409 一路回到 Gateway，那一行保持原样不标红', async () => {
      const seatBot = fakeBot()
      // 3200 是 slot 0 的席位 bot 口，由 Gateway 的端口公式定死，这里没得选。占着了就
      // 直说——否则报出来的是一句光秃秃的 EADDRINUSE，没人知道该去关什么。
      await listenOn(seatBot.server, 3200).catch((e) => {
        throw new Error(`3200 被占着，起不了假席位（本机上有别的席位 bot 在跑？）：${e.message}`)
      })
      const adminLogin = await req(gwBase, 'POST', '/auth/login', {
        body: { email: 'admin@mgrtest.local', password: 'manager-admin-1234' },
      })
      assert(adminLogin.status === 200, `admin login ${adminLogin.status} ${adminLogin.text}`)
      const adminTok = adminLogin.json.token
      await publishRelease({ req, gwBase, token: ownerTok, version: '0.1.0' })
      const made = await req(gwBase, 'POST', '/platform/bots', { token: ownerTok, body: { name: '排空验证 Bot' } })
      assert(made.status === 201, `建 Bot ${made.status} ${made.text}`)
      const botId = made.json.bot.id
      try {

        const first = await req(gwBase, 'POST', '/runtime/deploy', {
          token: adminTok,
          body: { botId, version: '0.1.0' },
        })
        assert(first.status === 200, `头一次部署 ${first.status} ${first.text}`)
        assert(first.json.status === 'ready', `头一次部署之后 ${first.json.status}`)

        // 这颗席位忙起来了：正在跑一轮。
        seatBot.health.busy = true
        seatBot.health.running = 1
        const held = await req(gwBase, 'POST', '/runtime/deploy', {
          token: adminTok,
          body: { botId, version: '0.1.0', update: true },
        })
        assert(held.status === 409, `忙着的席位该回 409，实际 ${held.status} ${held.text}`)
        assert(String(held.json.error).includes('有会话在跑'), `理由没传上来：${held.text}`)
        // 席位那一行：还是 ready、还是原来的版本。deploying 会让界面永远转圈，
        // error 会让人去查一个不存在的故障。
        const rt = await req(gwBase, 'GET', `/runtime/bots/${encodeURIComponent(botId)}`, { token: adminTok })
        assert(rt.status === 200, `取席位状态 ${rt.status} ${rt.text}`)
        const mine = rt.json.bot?.runtime
        assert(mine, `名下找不到这个席位：${rt.text.slice(0, 300)}`)
        assert(mine.status === 'ready', `没换版却把席位标成了 ${mine.status}`)
        assert(mine.botVersion === '0.1.0', `没换版却动了版本号：${mine.botVersion}`)
        // 「等会儿再来」也不该写进 lastError：席位卡里那一格平时画的是版本号，出错时
        // 才画 lastError（见 ui/pages-machines.js）。摆进去就等于从此盖住「这台跑的是
        // 哪一版」——而它正是查这类问题时要看的。
        assert(!String(mine.lastError || '').includes('有会话在跑'), `把「忙」写进了 lastError：${mine.lastError}`)

        /**
         * 批量那条路要把「忙」单独摆出来。
         *
         * **不能靠状态码反推**：deploySeat 有六处 409（管家版本过旧、架构不匹配、槽位
         * 用尽、还没发布版本、公司没配对机器，以及这一条），含义天差地别。按 409 一律
         * 记成「大家在忙」的话，一台管家太旧的机器会整片报成「晚点再来」，而且因为一个
         * 失败都没有，界面上那句提示还是绿的——真正的原因从此浮不出来。
         */
        const machineId = await machineIdOf(req, gwBase, ownerTok, orgId)
        const batch = await req(gwBase, 'POST', `/platform/machines/${machineId}/runtime/update`, {
          token: ownerTok,
          body: { version: '0.1.0' },
        })
        assert(batch.status === 200, `批量更新 ${batch.status} ${batch.text}`)
        const line = (batch.json.results || []).find((x) => x.botId === botId)
        assert(line, `批量结果里没有这个席位：${batch.text.slice(0, 300)}`)
        assert(line.busy === true, `忙着的席位没被标成 busy，会被算进「失败」：${JSON.stringify(line)}`)

        /**
         * 换一种 409：显式指定一个**架构不匹配**的版本。它同样是 409，但它是永久错误，
         * 绝不能被算成「有会话在跑」。
         */
        // 机器自报的 arch 就是跑着这套测试的这台机器（管家进程的 process.arch）。
        const wrongArch = `0.1.1-${process.arch === 'arm64' ? 'x64' : 'arm64'}`
        await publishRelease({ req, gwBase, token: ownerTok, version: wrongArch })
        const mism = await req(gwBase, 'POST', '/runtime/deploy', {
          token: adminTok,
          body: { botId, version: wrongArch, update: true },
        })
        assert(mism.status === 409, `架构不匹配该是 409，实际 ${mism.status} ${mism.text}`)
        const batch2 = await req(gwBase, 'POST', `/platform/machines/${machineId}/runtime/update`, {
          token: ownerTok,
          body: { version: wrongArch },
        })
        const line2 = (batch2.json.results || []).find((x) => x.botId === botId)
        assert(line2, `批量结果里没有这个席位：${batch2.text.slice(0, 300)}`)
        assert(!line2.busy, `架构不匹配被冒充成「有会话在跑」，真正的原因就此埋掉：${JSON.stringify(line2)}`)
      } finally {
        seatBot.health.busy = false
        seatBot.health.running = 0
        /**
         * 席位收拾干净：后面「改机器归属」和「注销」两条都要求这台机器上一个席位都没有。
         * 删 Bot 会连它名下的席位一起拆（见 gateway/src/routes/catalog.ts）。
         *
         * **收尾要断言。** 静静地清不干净的话，坏掉的是后面某一条毫不相干的用例，
         * 而且一次成一次不成——查起来会一路查到那条用例自己身上去。
         */
        const cleaned = await req(gwBase, 'DELETE', `/platform/bots/${encodeURIComponent(botId)}`, { token: ownerTok })
        assert(cleaned.status === 200, `没收拾干净：删 Bot ${cleaned.status} ${cleaned.text}`)
        const left = await req(mgrBase, 'GET', '/seats', { token: machineTok })
        assert(
          (left.json.seats || []).length === 0,
          `席位没从名册里拆掉，后面的用例会莫名其妙地坏：${JSON.stringify(left.json.seats)}`,
        )
        await closeServer(seatBot.server, '席位替身')
      }
    })

    /**
     * 部署规格里的直连字段：远端登记的 bot 包带 botUrl / botSha256，本机存储的不带。
     *
     * 这套测试里的管家是 DRYRUN（seats.ts 在拉包之前就返回），看不到它真去哪儿取包，所以
     * 这里把机器地址临时指到一个**记下请求体的假管家**上，直接看 Gateway 发出去的规格。
     * 管家那一侧怎么用这两个字段，在 manager-download 那组里验。
     */
    await test('部署规格：远端登记的包带直连地址和校验值，本机存储的不带', async () => {
      const { tarGz, sha256Of } = await import('./release.mjs')
      const pkg = tarGz([
        { name: './bin/satuwork.mjs', data: '#!/usr/bin/env node\n' },
        { name: './VERSION', data: '0.1.9-remote\n' },
      ])
      const hits = []
      const host = createServer((hreq, res) => {
        hits.push(String(hreq.headers.authorization || ''))
        res.writeHead(200, { 'content-type': 'application/gzip' })
        res.end(pkg)
      })
      const hostPort = await listenOn(host, 0)
      const url = `http://127.0.0.1:${hostPort}/bot-0.1.9-remote.tgz`

      const specs = []
      const fakeMgr = createServer((mreq, res) => {
        let body = ''
        mreq.on('data', (c) => (body += c))
        mreq.on('end', () => {
          if (mreq.method === 'PUT' && mreq.url.startsWith('/seats/')) specs.push(JSON.parse(body))
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{}')
        })
      })
      const fakePort = await listenOn(fakeMgr, 0)
      const adminLogin = await req(gwBase, 'POST', '/auth/login', {
        body: { email: 'admin@mgrtest.local', password: 'manager-admin-1234' },
      })
      assert(adminLogin.status === 200, `admin login ${adminLogin.status} ${adminLogin.text}`)
      const adminTok = adminLogin.json.token
      const made = await req(gwBase, 'POST', '/platform/bots', { token: ownerTok, body: { name: '直连规格验证 Bot' } })
      assert(made.status === 201, `建 Bot ${made.status} ${made.text}`)
      const botId = made.json.bot.id
      const point = (h) => req(gwBase, 'PUT', `/platform/orgs/${orgId}/machine`, { token: ownerTok, body: { host: h } })
      try {
        const reg = await req(gwBase, 'POST', '/platform/bot-releases', {
          token: ownerTok,
          body: { version: '0.1.9-remote', url, size: pkg.length, sha256: sha256Of(pkg) },
        })
        assert(reg.status === 201, `登记 ${reg.status} ${reg.text}`)
        assert(reg.json.release.directUrl === url, `该能直连：${JSON.stringify(reg.json.release)}`)
        await publishRelease({ req, gwBase, token: ownerTok, version: '0.1.9-local' })

        const moved = await point(`http://127.0.0.1:${fakePort}`)
        assert(moved.status === 200, `改管家地址 ${moved.status} ${moved.text}`)

        const d = await req(gwBase, 'POST', '/runtime/deploy', { token: adminTok, body: { botId, version: '0.1.9-remote' } })
        assert(d.status === 200, `部署 ${d.status} ${d.text}`)
        const remote = specs.at(-1)
        assert(remote?.botVersion === '0.1.9-remote', `规格里的版本 ${remote?.botVersion}`)
        assert(remote.botUrl === url, `规格该带外部地址：${remote.botUrl}`)
        assert(remote.botSha256 === sha256Of(pkg), `规格该带校验值：${remote.botSha256}`)

        const l = await req(gwBase, 'POST', '/runtime/deploy', { token: adminTok, body: { botId, version: '0.1.9-local', update: true } })
        assert(l.status === 200, `部署本机包 ${l.status} ${l.text}`)
        const local = specs.at(-1)
        assert(local?.botVersion === '0.1.9-local', `规格里的版本 ${local?.botVersion}`)
        assert(!('botUrl' in local) && !('botSha256' in local), `本机存储的包不该给直连字段：${JSON.stringify(local)}`)

        assert(hits.every((h) => !h), `外部主机收到了凭据：${JSON.stringify(hits)}`)
      } finally {
        const back = await point(mgrBase)
        assert(back.status === 200, `管家地址没改回去，后面的用例全会坏：${back.status} ${back.text}`)
        const cleaned = await req(gwBase, 'DELETE', `/platform/bots/${encodeURIComponent(botId)}`, { token: ownerTok })
        assert(cleaned.status === 200, `没收拾干净：删 Bot ${cleaned.status} ${cleaned.text}`)
        const left = await req(mgrBase, 'GET', '/seats', { token: machineTok })
        assert(
          (left.json.seats || []).length === 0,
          `席位没从名册里拆掉，后面的用例会莫名其妙地坏：${JSON.stringify(left.json.seats)}`,
        )
        await closeServer(fakeMgr, '假管家')
        await closeServer(host, 'release host')
      }
    })

    await test('心跳带回期望版本；没发过管家包时为 null', async () => {
      const r = await req(gwBase, 'POST', `/internal/machines/${(await machineIdOf(req, gwBase, ownerTok, orgId))}/heartbeat`, {
        token: machineTok,
        body: { managerVersion: 'e2e-1', protocol: 1, node: process.versions.node, seats: [] },
      })
      assert(r.status === 200, `heartbeat ${r.status} ${r.text}`)
      assert(r.json.desiredManagerVersion === null, `期望版本 ${r.json.desiredManagerVersion}`)
      assert(r.json.minNode >= 24, 'minNode')
      assert(r.json.minProtocol >= 1, 'minProtocol')
      const m = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      assert(m.json.machine.managerVersion === 'e2e-1', '心跳应更新管家版本')
    })

    await test('机器时区：坏名字挡在 Gateway，好名字下发给机器，实际值由心跳自报', async () => {
      // 时区和管家版本走同一条路——Gateway 没有登录这台机器的凭据，只能在心跳响应里
      // 把期望值带下去。所以这条要盯的是三件事：认不认识的名字有没有就地回绝、期望值
      // 有没有真的进心跳、以及**期望和实际是不是两格**。合成一格的话，「指令下了但机器
      // 没改上」在界面上和「改好了」长得一模一样，那正是这个功能最需要看出来的状态。
      const id = await machineIdOf(req, gwBase, ownerTok, orgId)
      const tzUrl = `/platform/orgs/${orgId}/machines/${id}/timezone`

      for (const bad of ['Asia/Shanghi', '../../etc/passwd', 'Asia/Shanghai; reboot']) {
        const r = await req(gwBase, 'PUT', tzUrl, { token: ownerTok, body: { timezone: bad } })
        assert(r.status === 400, `${bad} 应 400，得到 ${r.status} ${r.text}`)
      }

      // 大小写不规范的名字要归一，否则库里同一个时区会存出好几种拼法，
      // 而「实际 == 期望」这个判断是按字符串比的。
      const set = await req(gwBase, 'PUT', tzUrl, { token: ownerTok, body: { timezone: 'asia/shanghai' } })
      assert(set.status === 200, `设时区 ${set.status} ${set.text}`)
      assert(set.json.machine.timezone === 'Asia/Shanghai', `没归一：${set.json.machine.timezone}`)
      assert(set.json.pending === true, '机器还没报回来，这一刻只能是 pending')

      const body = { managerVersion: 'e2e-1', protocol: 1, node: process.versions.node, seats: [] }
      const hb = await req(gwBase, 'POST', `/internal/machines/${id}/heartbeat`, { token: machineTok, body })
      assert(hb.json.timezone === 'Asia/Shanghai', `心跳没下发时区：${JSON.stringify(hb.json.timezone)}`)

      // 机器自报实际时区之后，pending 才落下去。
      await req(gwBase, 'POST', `/internal/machines/${id}/heartbeat`, {
        token: machineTok,
        body: { ...body, timezone: 'Asia/Shanghai' },
      })
      const card = (await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })).json.machines[0]
      assert(card.machine.currentTimezone === 'Asia/Shanghai', `实际时区 ${card.machine.currentTimezone}`)
      assert(card.timezonePending === false, '实际和期望对上了就不该再 pending')

      // 机器报一个不认识的名字：宁可当成「没报」，也不能存进去——存了的话
      // 「改上了没有」这个判断从此就是错的。
      await req(gwBase, 'POST', `/internal/machines/${id}/heartbeat`, {
        token: machineTok,
        body: { ...body, timezone: 'Mars/Olympus' },
      })
      const after = (await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })).json.machines[0]
      assert(after.machine.currentTimezone === 'Asia/Shanghai', `坏值被当真了：${after.machine.currentTimezone}`)

      // 清空 = 不再管这台机器的时区。**不是**改成 UTC——心跳里必须是 null，
      // 否则没人指定过时区的机器会被凭空改掉。
      const clear = await req(gwBase, 'PUT', tzUrl, { token: ownerTok, body: { timezone: '' } })
      assert(clear.status === 200, `清空 ${clear.status} ${clear.text}`)
      assert(clear.json.machine.timezone === null, `没清掉：${clear.json.machine.timezone}`)
      const idle = await req(gwBase, 'POST', `/internal/machines/${id}/heartbeat`, { token: machineTok, body })
      assert(idle.json.timezone === null, `清空后仍在下发：${JSON.stringify(idle.json.timezone)}`)
    })

    await test('通联指示灯：四态按心跳新旧分，编号按登记先后给', async () => {
      // 这盏灯要答的是「哪台不对」，而它唯一的判据是心跳有多久没来了。四档的边界不能
      // 只靠读代码确认——`stale` 那一档存在的理由（换版重启会断几十秒，不该闪红灯）
      // 恰恰是最容易在后来的重构里被合并掉的。
      //
      // 造一台**假机器**来测，不动真管家那台：真管家每 30 秒心跳一次，改它的
      // lastHeartbeatAt 会被下一轮覆盖，断言就成了掷骰子。
      const { createRequire } = await import('node:module')
      const require = createRequire(new URL('../gateway/package.json', import.meta.url))
      const pg = require('pg')
      const client = new pg.Client({ connectionString: PG_URL })
      await client.connect()
      const fake = '00000000-0000-4000-8000-0000000000ff'
      const linkOf = async () => {
        const r = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
        return r.json.machines.find((c) => c.machine.id === fake)
      }
      try {
        await client.query(`set search_path to ${SCHEMA}`)
        await client.query(
          `insert into machines (id, host, "companyId", "lastHeartbeatAt", "createdAt", "pairedAt", protocol, "maxAccounts", token)
           values ($1, 'http://10.0.0.99:8443', $2, $3, $3, $3, 1, 10, 'smt_e2e-link-probe')`,
          [fake, orgId, Date.now()],
        )

        const online = await linkOf()
        assert(online, '假机器没出现在列表里')
        assert(online.machine.link === 'online', `刚心跳过该是 online，得到 ${online.machine.link}`)
        assert(online.machine.heartbeatAge != null && online.machine.heartbeatAge < 5000, `heartbeatAge=${online.machine.heartbeatAge}`)

        // 3 轮心跳（90 秒）之内还算在线——换版重启就落在这个区间里，报红等于狼来了。
        const at = async (agoMs) => {
          await client.query('update machines set "lastHeartbeatAt" = $1 where id = $2', [Date.now() - agoMs, fake])
          return (await linkOf()).machine.link
        }
        assert((await at(80_000)) === 'online', '80 秒（不到 3 轮）还该是 online')
        assert((await at(5 * 60_000)) === 'stale', '5 分钟该是 stale')
        assert((await at(2 * 3600_000)) === 'offline', '2 小时该是 offline')

        // 没配对是**单独一档**，不能并进 offline：前者是还没装，后者是装了但出事了，
        // 处置完全不同（一个去跑安装脚本，一个去看机器还在不在）。
        await client.query('update machines set "pairedAt" = null where id = $1', [fake])
        assert((await linkOf()).machine.link === 'unpaired', '没配对该是 unpaired')

        // 编号按登记先后：真管家那台先配对，是 1 号；假机器后插，是 2 号。
        const all = (await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })).json.machines
        assert(all.length === 2, `该有两台，实际 ${all.length}`)
        assert(all[0].no === 1 && all[1].no === 2, `编号不对：${all.map((c) => c.no).join(',')}`)
        assert(all[1].machine.id === fake, '2 号该是后插的那台')
      } finally {
        await client.query('delete from machines where id = $1', [fake]).catch(() => {})
        await client.end().catch(() => {})
      }
    })

    await test('Gateway 换了地址：入站那一跳顺带把新地址教给管家', async () => {
      /**
       * 这条路解的是一个死结：管家手上那份 gatewayUrl 是**配对那天写死的**，Gateway
       * 换了对外地址之后，心跳就一直打向一个不存在的地方——而它唯一能被告知这件事的
       * 通道，恰恰是它自己打不出去的那一条。更糟的是这件事一个字都不报（打不通那一路
       * 是 catch{}），界面上只有一盏「失联」灯，人只能上机器去改 /etc/satuwork/manager.json。
       *
       * 所以反过来走：Gateway → 管家这一跳还通着（机器没挪窝），就从这条告诉它。
       */
      const stateFile = join(MGR_HOME, 'manager.json')
      const urlOf = () => JSON.parse(readFileSync(stateFile, 'utf8')).gatewayUrl
      const tell = (url, opts = {}) =>
        fetch(`${mgrBase}/health`, {
          headers: {
            ...(opts.anon ? {} : { authorization: 'Bearer ' + machineTok }),
            ...(url ? { 'x-satuwork-gateway-url': url } : {}),
          },
        })

      assert(urlOf() === gwBase, `起点就不对：${urlOf()}`)

      // ① 形状不对的一律不认。这个值会被拼成心跳和拉包的 URL 前缀，**保持原样**比
      //    采信一个半通不通的地址安全得多。
      for (const bad of ['not a url', 'ftp://10.0.0.9', `${gwBase}/path`, 'http://u:p@10.0.0.9', '']) {
        await tell(bad)
        assert(urlOf() === gwBase, `坏地址被采信了：${JSON.stringify(bad)} → ${urlOf()}`)
      }

      // ② 没票的说话不算数——它在 requireMachine **之后**才被读到。
      const anon = await tell('http://10.0.0.9:3080', { anon: true })
      assert(anon.status === 401, `无票该 401，实际 ${anon.status}`)
      assert(urlOf() === gwBase, `无票也改动了状态：${urlOf()}`)

      // ③ 带票 + 形状对 → 当场改、当场落盘。**落盘**是关键：重启之后还得是新地址。
      const moved = 'http://10.0.0.9:3080'
      await tell(moved)
      assert(urlOf() === moved, `没学到新地址：${urlOf()}`)

      // ④ 真实的修复路径：**没人上机器**，只是在界面上按了一下「保存并探活」——
      //    那一跳带着 GATEWAY_PUBLIC_URL 过去，管家就自己回来了。
      const machineId = (await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })).json.machine.id
      const probe = await req(gwBase, 'PUT', `/platform/machines/${machineId}/host`, {
        token: ownerTok,
        body: { host: mgrBase },
      })
      assert(probe.status === 200, `探活 ${probe.status} ${probe.text}`)
      assert(probe.json.reachable === true, `探活没通：${probe.json.error}`)
      assert(urlOf() === gwBase, `一次探活之后还没回来：${urlOf()}`)
    })

    await test('管家自己的日志：无票 401，有票给得出结构', async () => {
      // 部署失败、升级卡住、配对回拨不通，全写在管家的 journal 里——席位的日志里
      // 一个字都没有。平台端排查「这台机器怎么了」看的是这条。
      const anon = await fetch(`${mgrBase}/logs`)
      assert(anon.status === 401, `无票该 401，实际 ${anon.status}`)
      const r = await req(mgrBase, 'GET', '/logs?lines=5', { token: machineTok })
      assert(r.status === 200, `logs ${r.status} ${r.text}`)
      assert(Array.isArray(r.json.lines), `lines 该是数组：${r.text.slice(0, 200)}`)
      assert(/satuwork-manager/.test(r.json.unit || ''), `unit 不对：${r.json.unit}`)
    })

    await test('平台端看机器日志：只有 owner，席位必须是这台机器上的，且留审计', async () => {
      const machineId = await machineIdOf(req, gwBase, ownerTok, orgId)
      const base = `/platform/orgs/${orgId}/machines/${machineId}/logs`

      const anon = await req(gwBase, 'GET', base)
      assert(anon.status === 401, `无票该 401，实际 ${anon.status}`)

      const ok = await req(gwBase, 'GET', `${base}?lines=5`, { token: ownerTok })
      assert(ok.status === 200, `管家日志 ${ok.status} ${ok.text}`)
      assert(Array.isArray(ok.json.lines), `lines 该是数组：${ok.text.slice(0, 200)}`)

      // seatId 会进 systemd 单元名，只认这台机器上的——别处的值一律挡掉。
      const bad = await req(gwBase, 'GET', `${base}?seatId=seat-not-here`, { token: ownerTok })
      assert(bad.status === 404, `外来 seatId 该 404，实际 ${bad.status} ${bad.text}`)

      // 席位日志里有员工的对话正文和执行过的命令。这和「看别人的屏幕」是同一类
      // 动作，必须留痕。
      const audit = await req(gwBase, 'GET', `/orgs/${orgId}/audit`, { token: ownerTok })
      assert(audit.status === 200, `audit ${audit.status} ${audit.text}`)
      const rows = audit.json.events || audit.json.rows || []
      assert(
        rows.some((e) => e.action === 'machine.logs'),
        `审计里没有 machine.logs：${JSON.stringify(rows.map((e) => e.action)).slice(0, 300)}`,
      )
    })

    await test('管家自报机器时区，答得上「现在是什么时区」', async () => {
      const r = await req(mgrBase, 'GET', '/health', { token: machineTok })
      assert(r.status === 200, `health ${r.status}`)
      assert('timezone' in r.json, '/health 要报机器时区')
      assert('timezoneError' in r.json, '改时区失败要报得出来，不能只写日志')
    })


    await test('机器负载：管家自己采样，四项都给得出，而且认票', async () => {
      // 这条路补的是「没有 SSH 就看不见机器」剩下的最后一块：diag 答某个席位的现场，
      // logs 答它卡在哪一步，这里答的是**机器本身还剩多少余量**——而这一层的故障是
      // 先慢后崩，盘写满之后连日志都写不进去，事后连查都没得查。
      const anon = await fetch(`${mgrBase}/metrics`)
      assert(anon.status === 401, `无票该 401，实际 ${anon.status}`)

      const r = await req(mgrBase, 'GET', '/metrics', { token: machineTok })
      assert(r.status === 200, `metrics ${r.status} ${r.text}`)
      const m = r.json.metrics
      assert(m, `没给出负载：${r.text.slice(0, 200)}`)
      assert(m.cpu.cores > 0, `核数 ${m.cpu.cores}`)
      // usage 允许是 null（第一次采样只存基准），但**不能是编出来的 0**——两者在
      // 界面上完全不同：一个是「取样中」，一个是「这台机器闲着」。
      assert(m.cpu.usage === null || (m.cpu.usage >= 0 && m.cpu.usage <= 1), `CPU 占用越界：${m.cpu.usage}`)
      assert(m.memory.total > 0 && m.memory.used >= 0, `内存 ${JSON.stringify(m.memory)}`)
      assert(m.memory.usage >= 0 && m.memory.usage <= 1, `内存占用越界：${m.memory.usage}`)
      assert(Array.isArray(m.disks) && m.disks.length >= 1, `至少要报得出根分区：${JSON.stringify(m.disks)}`)
      assert(m.disks.every((d) => d.total > 0 && d.usage >= 0 && d.usage <= 1), `盘的数不对：${JSON.stringify(m.disks)}`)
      assert(m.net && 'txBytes' in m.net && 'txRate' in m.net, `出网那格缺字段：${JSON.stringify(m.net)}`)
      assert(r.json.logs && typeof r.json.logs.journalBytes === 'number', `日志占用该一起给：${r.text.slice(0, 200)}`)

      // /health 上也要有：那条是探活兼现场快照，人手工 curl 时看的就是它。
      const health = await req(mgrBase, 'GET', '/health', { token: machineTok })
      assert(health.json.metrics && health.json.logs, '/health 也该带上负载与日志占用')
    })

    await test('日志清理：认票、给得出结果，keepMb 不合法就 400', async () => {
      const anon = await fetch(`${mgrBase}/logs/vacuum`, { method: 'POST' })
      assert(anon.status === 401, `无票该 401，实际 ${anon.status}`)

      const bad = await req(mgrBase, 'POST', '/logs/vacuum', { token: machineTok, body: { keepMb: -5 } })
      assert(bad.status === 400, `负数该 400，实际 ${bad.status} ${bad.text}`)

      // 同时来三个只该跑一轮。Gateway 那边超时重试、或者人手抖多点两下时，两个
      // `journalctl --rotate` 叠着跑只会更慢，还会把 lastVacuum 搅成前一轮的 before
      // 配后一轮的 after。搭同一趟车的请求拿到的是同一个结果，`at` 因此一样。
      const burst = await Promise.all(
        [0, 1, 2].map(() => req(mgrBase, 'POST', '/logs/vacuum', { token: machineTok, body: {} })),
      )
      assert(burst.every((x) => x.status === 200), `并发清理 ${burst.map((x) => x.status).join(',')}`)
      const ats = new Set(burst.map((x) => x.json.vacuum.at))
      // 不断言恰好 1：最先那个真跑完之后才轮到的请求，本来就该另起一轮。没有单飞闸
      // 的话这里必然是 3。
      assert(ats.size <= 2, `三个并发请求跑出了 ${ats.size} 轮清理，单飞闸没起作用`)

      const r = await req(mgrBase, 'POST', '/logs/vacuum', { token: machineTok, body: {} })
      assert(r.status === 200, `vacuum ${r.status} ${r.text}`)
      const v = r.json.vacuum
      // dryRun 下不真去动开发机的 journal，但**形状必须完整**——界面就是照着这几个
      // 字段说「腾出了多少」的，少一个就只能显示空白。
      assert(v && typeof v.before === 'number' && typeof v.after === 'number' && typeof v.freed === 'number', `结果缺字段：${r.text.slice(0, 200)}`)
      assert(v.keepMb > 0, `keepMb ${v.keepMb}`)
      assert(r.json.logs.lastVacuum, '清完之后日志占用里要记着这一次')
    })

    await test('负载搭心跳上报：Gateway 存最近一份，坏值夹紧不入库', async () => {
      // 上报的是**网络数据**：它会原样进 jsonb、再原样画进浏览器。所以这条盯的不是
      // 「存没存下来」，而是「一台报疯了的机器能不能把这一页搞坏」——占用 340%、
      // 二十块盘、挂载点里带换行，这些都不该活着走到界面上。
      const { createRequire } = await import('node:module')
      const require = createRequire(new URL('../gateway/package.json', import.meta.url))
      const pg = require('pg')
      const client = new pg.Client({ connectionString: PG_URL })
      await client.connect()
      const fake = '00000000-0000-4000-8000-0000000000fe'
      const fakeTok = 'smt_e2e-telemetry-probe'
      try {
        await client.query(`set search_path to ${SCHEMA}`)
        await client.query(
          `insert into machines (id, host, "companyId", "lastHeartbeatAt", "createdAt", "pairedAt", protocol, "maxAccounts", token)
           values ($1, 'http://10.0.0.98:8443', $2, $3, $3, $3, 2, 10, $4)`,
          [fake, orgId, Date.now(), fakeTok],
        )
        // 造一台假机器来测，不动真管家那台：真管家每 30 秒心跳一次，会把断言要看的
        // 那份数据覆盖掉，断言就成了掷骰子。
        const hb = await req(gwBase, 'POST', `/internal/machines/${fake}/heartbeat`, {
          token: fakeTok,
          body: {
            managerVersion: 'e2e-1',
            protocol: 2,
            node: process.versions.node,
            seats: [],
            metrics: {
              uptime: 3600,
              cpu: { cores: 8, usage: 3.4, load1: 1.5 },
              memory: { total: 16e9, used: 8e9, usage: 0.5, swapTotal: 0, swapUsed: 0 },
              disks: Array.from({ length: 20 }, (_, i) => ({ mount: `/m${i}\nUser=root`, total: 1e9, used: 9e8, free: 1e8, usage: 0.9 })),
              net: { txBytes: 1e9, rxBytes: 2e9, txRate: -7, rxRate: 1234, interfaces: ['eth0'] },
            },
            logs: { journalBytes: 5e8, varLogBytes: 6e8, capMb: 1024, capSource: 'default', top: [], lastVacuum: null },
          },
        })
        assert(hb.status === 200, `heartbeat ${hb.status} ${hb.text}`)

        const card = await req(gwBase, 'GET', `/platform/machines/${fake}`, { token: ownerTok })
        assert(card.status === 200, `detail ${card.status} ${card.text}`)
        const tm = card.json.machine.telemetry
        assert(tm && tm.metrics && tm.logs, `自报数据没存下来：${card.text.slice(0, 300)}`)
        assert(tm.metrics.cpu.usage === 1, `占用 340% 该被夹到 1，实际 ${tm.metrics.cpu.usage}`)
        assert(tm.metrics.disks.length === 12, `盘的条数该有上限，实际 ${tm.metrics.disks.length}`)
        assert(!/[\n\r]/.test(tm.metrics.disks[0].mount), `挂载点里的换行没洗掉：${JSON.stringify(tm.metrics.disks[0].mount)}`)
        // 负的速率不是「往回发」，是计数器出了问题：宁可当成没有，也不能画一根倒着长的条。
        assert(tm.metrics.net.txRate === null, `负速率该当成没有，实际 ${tm.metrics.net.txRate}`)
        // 年龄由 Gateway 算，按**收到的时刻**——机器的钟可能是歪的，而界面上那句
        // 「3 分钟前」必须准。
        assert(typeof card.json.machine.telemetryAge === 'number' && card.json.machine.telemetryAge < 10_000, `telemetryAge=${card.json.machine.telemetryAge}`)

        // 老管家不带这两格。**整格不动**才对——写一份空的进去，会把上一轮好好的
        // 数据抹掉，界面上看着就是「这台机器突然什么都不报了」。
        await req(gwBase, 'POST', `/internal/machines/${fake}/heartbeat`, {
          token: fakeTok,
          body: { managerVersion: 'e2e-1', protocol: 2, node: process.versions.node, seats: [] },
        })
        const after = await req(gwBase, 'GET', `/platform/machines/${fake}`, { token: ownerTok })
        assert(after.json.machine.telemetry, '老管家的一轮心跳把上一份自报数据抹掉了')

        // **只报了一半的那一轮，另一半要沿用上一次。** 管家重启之后负载是同步采的、
        // 立刻就有，而日志占用要异步走一遍目录树；中间那几百毫秒里正好打了一轮心跳
        // 的话 logs 就是空的——照直存下去，机器每重启一次界面上的日志占用就空一次。
        const halfOnly = await req(gwBase, 'POST', `/internal/machines/${fake}/heartbeat`, {
          token: fakeTok,
          body: {
            managerVersion: 'e2e-1',
            protocol: 2,
            node: process.versions.node,
            seats: [],
            metrics: {
              uptime: 7200,
              cpu: { cores: 8, usage: 0.1, load1: 0.5 },
              memory: { total: 16e9, used: 4e9, usage: 0.25, swapTotal: 0, swapUsed: 0 },
              disks: [{ mount: '/', total: 1e9, used: 5e8, free: 5e8, usage: 0.5 }],
              net: { txBytes: 2e9, rxBytes: 3e9, txRate: 100, rxRate: 200, interfaces: ['eth0'] },
            },
          },
        })
        assert(halfOnly.status === 200, `半份心跳 ${halfOnly.status} ${halfOnly.text}`)
        const merged = (await req(gwBase, 'GET', `/platform/machines/${fake}`, { token: ownerTok })).json.machine.telemetry
        assert(merged.metrics.cpu.usage === 0.1, `新的那一半没写进去：${JSON.stringify(merged.metrics.cpu)}`)
        assert(merged.logs && merged.logs.journalBytes === 5e8, `没报的那一半被抹掉了：${JSON.stringify(merged.logs)}`)

        // **公司里的普通成员看不到这份数据。** `GET /orgs/:id/machine` 是给他们拿访问
        // 地址用的，而自报数据里有挂载点、网卡名、/var/log 底下的文件路径——那是运维
        // 要看的机器内情，不是员工该拿到的东西（和 arch、token 同一条线）。
        const adminLogin2 = await req(gwBase, 'POST', '/auth/login', {
          body: { email: 'admin@mgrtest.local', password: 'manager-admin-1234' },
        })
        const asOrg = await req(gwBase, 'GET', `/orgs/${orgId}/machine`, { token: adminLogin2.json.token })
        assert(asOrg.status === 200, `公司侧那条 ${asOrg.status} ${asOrg.text}`)
        assert(!('telemetry' in asOrg.json.machine), `自报数据漏给了公司成员：${asOrg.text.slice(0, 300)}`)
      } finally {
        await client.query('delete from machines where id = $1', [fake]).catch(() => {})
        await client.end().catch(() => {})
      }
    })

    await test('负载归档：心跳累进分钟格，出网记增量，重启不算负流量', async () => {
      // 日视图吃的是这张表。要盯三件事：累加是不是真的在累（而不是每轮覆盖）、
      // 峰值有没有单独留住（均值会把冲顶那五分钟抹平）、以及出网记的是**增量**——
      // 机器自报的是开机以来的累计值，直接存快照的话，一天的曲线会是一条只涨不跌的
      // 斜线，而不是「每小时走了多少」。
      const { createRequire } = await import('node:module')
      const require = createRequire(new URL('../gateway/package.json', import.meta.url))
      const pg = require('pg')
      const client = new pg.Client({ connectionString: PG_URL })
      await client.connect()
      const fake = '00000000-0000-4000-8000-0000000000fd'
      const fakeTok = 'smt_e2e-rollup-probe'
      const beat = (over) => ({
        managerVersion: 'e2e-1',
        protocol: 2,
        node: process.versions.node,
        seats: [],
        metrics: {
          uptime: 3600,
          cpu: { cores: 8, usage: 0.1, load1: 1 },
          memory: { total: 16e9, used: 4e9, usage: 0.25, swapTotal: 0, swapUsed: 0 },
          disks: [
            { mount: '/', total: 1e9, used: 3e8, free: 7e8, usage: 0.3 },
            // 两块盘时取**最吃紧的那一块**：曲线上要看的是先满的那一个。
            { mount: '/home', total: 1e9, used: 8e8, free: 2e8, usage: 0.8 },
          ],
          net: { txBytes: 1000, rxBytes: 2000, txRate: 10, rxRate: 20, interfaces: ['eth0'] },
          ...(over || {}),
        },
      })
      const minutesOf = async () =>
        (await client.query('select * from machine_metric_minutes where "machineId" = $1', [fake])).rows
      try {
        await client.query(`set search_path to ${SCHEMA}`)
        await client.query(
          `insert into machines (id, host, "companyId", "lastHeartbeatAt", "createdAt", "pairedAt", protocol, "maxAccounts", token)
           values ($1, 'http://10.0.0.97:8443', $2, $3, $3, $3, 2, 10, $4)`,
          [fake, orgId, Date.now(), fakeTok],
        )

        // 第一轮：没有上一份可比，出网增量只能是 0——不能把「开机以来的 1000 字节」
        // 一次性记到这一小时头上。
        await req(gwBase, 'POST', `/internal/machines/${fake}/heartbeat`, { token: fakeTok, body: beat() })
        let rows = await minutesOf()
        assert(rows.length === 1, `该有一格，实际 ${rows.length}`)
        assert(Number(rows[0].samples) === 1, `samples=${rows[0].samples}`)
        assert(Number(rows[0].txBytes) === 0, `第一轮没有上一份可比，出网该是 0，实际 ${rows[0].txBytes}`)
        assert(Math.abs(Number(rows[0].diskMax) - 0.8) < 1e-9, `盘该取最吃紧那块 0.8，实际 ${rows[0].diskMax}`)

        // 第二轮：CPU 冲顶，出网计数器往前走。累加要落在**同一行**上。
        await req(gwBase, 'POST', `/internal/machines/${fake}/heartbeat`, {
          token: fakeTok,
          body: beat({
            cpu: { cores: 8, usage: 0.9, load1: 7 },
            net: { txBytes: 5000, rxBytes: 6000, txRate: 10, rxRate: 20, interfaces: ['eth0'] },
          }),
        })
        rows = await minutesOf()
        // 同一分钟里的两轮心跳要落在同一行上（心跳 30 秒一轮，一分钟正好两笔）。
        assert(rows.length === 1, `还是同一分钟，不该多出一行：${rows.length}`)
        assert(Number(rows[0].samples) === 2, `samples 该累加到 2，实际 ${rows[0].samples}`)
        // 均值靠 sum/samples 算，所以库里存的是和：0.1 + 0.9。
        assert(Math.abs(Number(rows[0].cpuSum) - 1.0) < 1e-9, `cpuSum=${rows[0].cpuSum}`)
        // **峰值单独留住**：均值是 50%，而这一小时真冲到过 90%，人要找的是后者。
        assert(Math.abs(Number(rows[0].cpuMax) - 0.9) < 1e-9, `cpuMax 该是 0.9，实际 ${rows[0].cpuMax}`)
        assert(Number(rows[0].txBytes) === 4000, `出网该记增量 4000，实际 ${rows[0].txBytes}`)

        // 第三轮：机器重启，计数器归零。**那不是负流量**，这一笔当 0——把 now 整个
        // 算进去更糟，等于把开机以来的总量记到这一小时头上。
        await req(gwBase, 'POST', `/internal/machines/${fake}/heartbeat`, {
          token: fakeTok,
          body: beat({ net: { txBytes: 12, rxBytes: 20, txRate: 1, rxRate: 1, interfaces: ['eth0'] } }),
        })
        rows = await minutesOf()
        assert(Number(rows[0].txBytes) === 4000, `计数器倒退不该改动累计，实际 ${rows[0].txBytes}`)

        // CPU 报不出来的那一轮整笔不算：管家重启后的第一次采样只存基准，把它当 0
        // 记进去会在曲线上砸出一个假的谷。
        await req(gwBase, 'POST', `/internal/machines/${fake}/heartbeat`, {
          token: fakeTok,
          body: beat({ cpu: { cores: 8, usage: null, load1: 0 } }),
        })
        rows = await minutesOf()
        assert(Number(rows[0].samples) === 3, `没有 CPU 的那轮不该计入，samples=${rows[0].samples}`)

        // 读接口：范围按调用方给的算，平均值在这一层除出来。
        const now = Date.now()
        const r = await req(gwBase, 'GET', `/platform/machines/${fake}/metrics?from=${now - 3600_000}&to=${now + 60_000}`, {
          token: ownerTok,
        })
        assert(r.status === 200, `metrics ${r.status} ${r.text}`)
        assert(r.json.minutes.length === 1, `该有一格：${r.text.slice(0, 200)}`)
        assert(r.json.retentionMs === 30 * 24 * 3600_000, `保留期该一起给出去：${r.json.retentionMs}`)
        const h = r.json.minutes[0]
        // 三笔算进来的 CPU 是 0.1、0.9、0.1（计数器归零那轮的 CPU 照样算，归零只影响
        // 出网那一格），没有 CPU 的那轮整笔不算。
        assert(h.samples === 3, `samples=${h.samples}`)
        assert(Math.abs(h.cpuAvg - 1.1 / 3) < 1e-9, `cpuAvg 该是 (0.1+0.9+0.1)/3，实际 ${h.cpuAvg}`)
        assert(h.cpuMax === 0.9 && h.txBytes === 4000, `峰值/出网没带出来：${JSON.stringify(h)}`)

        const bad = await req(gwBase, 'GET', `/platform/machines/${fake}/metrics?from=${now}&to=${now}`, { token: ownerTok })
        assert(bad.status === 400, `空范围该 400，实际 ${bad.status}`)
        // 一天 1440 行，上限卡在两天：一个月就是四万多行，这张表不该一次吐出来。
        const huge = await req(gwBase, 'GET', `/platform/machines/${fake}/metrics?from=${now - 3 * 86400_000}&to=${now}`, { token: ownerTok })
        assert(huge.status === 400, `超过两天该 400，实际 ${huge.status}`)
        const anon = await req(gwBase, 'GET', `/platform/machines/${fake}/metrics?from=${now - 1000}&to=${now}`)
        assert(anon.status === 401, `无票该 401，实际 ${anon.status}`)

        // **归档写失败不该拖垮心跳。** 心跳是对这台机器唯一的下行通道（升级、时区、
        // 日志上限都搭在响应里），一个「少记一笔曲线」的毛病不该把它们一起停掉。
        // 把表改名模拟写失败——比造盘满容易，而对那条 insert 来说是同一种失败。
        //
        // 这一段会让 Gateway 打出一句 `relation "machine_metric_minutes" does not exist`。
        // **那是这条用例故意造的**，不是毛病——先说一声，否则每轮 e2e 的日志里都躺着
        // 一条看起来很像事故的红字，而查的人会以为「同一张表有的语句看得见、有的看不见」。
        log('  （下面这句 relation ... does not exist 是这条用例故意造出来的）')
        await client.query('alter table machine_metric_minutes rename to machine_metric_minutes_hidden')
        try {
          const hb = await req(gwBase, 'POST', `/internal/machines/${fake}/heartbeat`, { token: fakeTok, body: beat() })
          assert(hb.status === 200, `归档写不进去时心跳仍该是 200，实际 ${hb.status} ${hb.text}`)
          assert('desiredManagerVersion' in hb.json, `控制面那几格还得在：${hb.text.slice(0, 200)}`)
        } finally {
          await client.query('alter table machine_metric_minutes_hidden rename to machine_metric_minutes')
        }

        // 机器真被删掉时，归档要跟着走：那张表按 machineId 裸存，没有外键级联。
        //
        // **删机器有两条路**，两条都得清干净：在线的先立墓碑、等管家回执才真删；一直
        // 没回来的由墓碑清扫硬删。这里走前一条，后一条在下面那段单独验——那才是「机器
        // 再也没回来」的常态，也是最容易被漏掉的一条。
        assert((await minutesOf()).length > 0, '前面攒的行呢')
        const del = await req(gwBase, 'DELETE', `/platform/machines/${fake}`, { token: ownerTok })
        assert(del.status === 200 && del.json.pending === true, `在线的机器该先立墓碑：${del.text}`)
        assert((await minutesOf()).length > 0, '墓碑阶段机器还在册，归档不该先没')
        const receipt = await req(gwBase, 'POST', `/internal/machines/${fake}/removed`, { token: fakeTok, body: {} })
        assert(receipt.status === 200, `回执 ${receipt.status} ${receipt.text}`)
        assert((await minutesOf()).length === 0, '机器真删了，归档还留在库里')

        // 另一条：机器一直没来收信，墓碑到期被硬删——归档同样要跟着走。
        const ghost = '00000000-0000-4000-8000-0000000000fc'
        await client.query(
          `insert into machines (id, host, "companyId", "lastHeartbeatAt", "createdAt", "pairedAt", protocol, "maxAccounts", token, "removedAt")
           values ($1, 'http://10.0.0.96:8443', $2, $3, $3, $3, 2, 10, 'smt_e2e-ghost', $4)`,
          [ghost, orgId, Date.now(), Date.now() - 30 * 24 * 3600_000],
        )
        await client.query(
          'insert into machine_metric_minutes ("machineId", "minuteStart", samples) values ($1, $2, 1)',
          [ghost, Math.floor(Date.now() / 60_000) * 60_000],
        )
        // 列表那条路会顺手扫墓碑（sweepRemovedMachines）。
        await req(gwBase, 'GET', '/platform/machines', { token: ownerTok })
        const left = await client.query('select 1 from machine_metric_minutes where "machineId" = $1', [ghost])
        assert(left.rowCount === 0, `墓碑清掉了，归档还剩 ${left.rowCount} 行`)
      } finally {
        for (const id of [fake, '00000000-0000-4000-8000-0000000000fc']) {
          await client.query('delete from machine_metric_minutes where "machineId" = $1', [id]).catch(() => {})
          await client.query('delete from machines where id = $1', [id]).catch(() => {})
        }
        await client.end().catch(() => {})
      }
    })

    await test('日志上限：平台钉一个数，心跳带下去，管家真的认了', async () => {
      // 和时区、管家版本同一条路：Gateway 没有登录这台机器的凭据，只能把期望值放进
      // 心跳响应，机器自己去收敛。所以要盯的是整条链，而不只是「存住了没有」。
      const id = await machineIdOf(req, gwBase, ownerTok, orgId)
      const url = `/platform/machines/${id}/log-cap`

      // 越界和小数要拒；**类型也要拒**——只做 Number() 强转的话，`true` 变成 1、
      // `[]` 变成 0，而 0 在这里的意思是「这台机器别自动清日志」，一个空数组把清理
      // 关掉是最不该悄悄发生的那种事。
      for (const bad of ['-1', '99999999', '3.5', [], true, { mb: 900 }]) {
        const r = await req(gwBase, 'PUT', url, { token: ownerTok, body: { logCapMb: bad } })
        assert(r.status === 400, `${JSON.stringify(bad)} 该 400，实际 ${r.status} ${r.text}`)
      }

      // **数字和字符串都要收。** 界面走 FormData 给的是字符串，脚本和 curl 直接给
      // 数字——只认一种就是给调用方挖坑（同 registerFromBody 那条注释）。
      const asNumber = await req(gwBase, 'PUT', url, { token: ownerTok, body: { logCapMb: 512 } })
      assert(asNumber.status === 200, `JSON 数字该收下，实际 ${asNumber.status} ${asNumber.text}`)
      assert(asNumber.json.machine.logCapMb === 512, `没存住：${asNumber.json.machine.logCapMb}`)

      const set = await req(gwBase, 'PUT', url, { token: ownerTok, body: { logCapMb: '900' } })
      assert(set.status === 200, `设上限 ${set.status} ${set.text}`)
      assert(set.json.machine.logCapMb === 900, `没存住：${set.json.machine.logCapMb}`)
      assert(set.json.pending === true, '机器还没认，这一刻只能是 pending')

      // 真的进了心跳响应——那是机器唯一的依据。
      const hb = await req(gwBase, 'POST', `/internal/machines/${id}/heartbeat`, {
        token: machineTok,
        body: { managerVersion: 'e2e-1', protocol: 2, node: process.versions.node, seats: [] },
      })
      assert(hb.json.logCapMb === 900, `心跳没下发上限：${JSON.stringify(hb.json.logCapMb)}`)

      // 真管家下一轮心跳（≤30 秒）会把它收下。等它，别只验 Gateway 那半边——两边
      // 各自看着都对、合起来不通，是这类握手最常见的坏法。给两轮多的余量（和注销
      // 那条同一个口径）：看到就走，等满是机器真没收。
      let applied = null
      for (let i = 0; i < 140; i++) {
        const r = await req(mgrBase, 'GET', '/metrics', { token: machineTok })
        if (r.json?.logs?.capMb === 900) {
          applied = r.json.logs
          break
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      assert(applied, '管家一直没收下这个上限')
      assert(applied.capSource === 'gateway', `来源该是 gateway，实际 ${applied.capSource}`)

      // 清空 = 不再指定，**回到管家的默认**。这里必须验管家那边真的回去了：
      // 只要 Gateway 那格清了、机器上还钉着 900，界面写的「跟默认走」就是句假话。
      const clear = await req(gwBase, 'PUT', url, { token: ownerTok, body: { logCapMb: '' } })
      assert(clear.status === 200 && clear.json.machine.logCapMb === null, `清空 ${clear.status} ${clear.text}`)
      // 清空之后机器回落到自己的默认值（一个数），拿它和 null 比永远不相等——按那么
      // 算的话，「不再指定」会从此挂着一句「等机器认」，而根本没有指令在路上。
      assert(clear.json.pending === false, `清空不该是 pending：${clear.text}`)
      let reverted = null
      for (let i = 0; i < 140; i++) {
        const r = await req(mgrBase, 'GET', '/metrics', { token: machineTok })
        if (r.json?.logs?.capSource === 'default') {
          reverted = r.json.logs
          break
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      assert(reverted, '清空之后管家没回到默认上限')
      assert(reverted.capMb === 1024, `默认上限该是 1024，实际 ${reverted.capMb}`)
    })

    await test('平台端手动清理日志：只有 owner，走审计，结果回得来', async () => {
      const id = await machineIdOf(req, gwBase, ownerTok, orgId)
      const url = `/platform/machines/${id}/logs/vacuum`

      const anon = await req(gwBase, 'POST', url)
      assert(anon.status === 401, `无票该 401，实际 ${anon.status}`)
      const adminLogin = await req(gwBase, 'POST', '/auth/login', {
        body: { email: 'admin@mgrtest.local', password: 'manager-admin-1234' },
      })
      const asAdmin = await req(gwBase, 'POST', url, { token: adminLogin.json.token })
      assert(asAdmin.status === 403, `公司管理员该 403，实际 ${asAdmin.status}`)

      const r = await req(gwBase, 'POST', url, { token: ownerTok, body: {} })
      assert(r.status === 200, `清理 ${r.status} ${r.text}`)
      assert(r.json.vacuum && typeof r.json.vacuum.freed === 'number', `结果没回来：${r.text.slice(0, 200)}`)

      // 这一下会在机器上永久删掉最老的那截 journal，而那截日志正是事后复盘的材料。
      // 谁在什么时候按的，必须留得下来。
      const audit = await req(gwBase, 'GET', `/orgs/${orgId}/audit`, { token: ownerTok })
      const rows = audit.json.events || audit.json.rows || []
      assert(
        rows.some((e) => e.action === 'machine.logs.vacuum'),
        `审计里没有 machine.logs.vacuum：${JSON.stringify(rows.map((e) => e.action)).slice(0, 300)}`,
      )
    })

    await test('平台钉住的管家版本要存得住，并且真的下发给机器', async () => {
      // 这一条曾经是**假通过**的：路由层收下 managerVersion、拼进 next、返回 200，
      // 而 db.putPlatformSettings 拼 payload 时根本没写这个字段，读端也没解析它。
      // 于是「全机队钉版本」这一级完全是死的——传个包上去，所有没有逐台钉过的机器
      // 都会自己升，唯一能拦住的开关看着能设、其实存不进去。
      // 钉住的版本必须真有对应的包：desiredManagerRelease 查不到就会静悄悄回落到
      // 「最新」，那样这条用例即使在坏代码下也可能碰巧过。先传一个真包上去。
      const { tarGz, sha256Of } = await import('./release.mjs')
      const pinnedPkg = tarGz([
        { name: './bin/satuwork-manager.mjs', data: '#!/usr/bin/env node\n' },
        { name: './VERSION', data: 'pinned-9.9.9\n' },
      ])
      const up = await req(gwBase, 'PUT', '/platform/manager-releases/pinned-9.9.9', {
        token: ownerTok,
        raw: pinnedPkg,
        headers: { 'content-type': 'application/gzip', 'x-bot-sha256': sha256Of(pinnedPkg) },
      })
      assert(up.status === 200, `传包 ${up.status} ${up.text}`)

      const before = (await req(gwBase, 'GET', '/platform/settings', { token: ownerTok })).json
      try {
        const put = await req(gwBase, 'PUT', '/platform/settings', {
          token: ownerTok,
          body: { managerVersion: 'pinned-9.9.9' },
        })
        assert(put.status === 200, `PUT ${put.status} ${put.text}`)
        assert(put.json.managerVersion === 'pinned-9.9.9', `回显 ${JSON.stringify(put.json.managerVersion)}`)

        // 关键：**重新读一次**。回显对不代表落库了——原来的 bug 里回显走的是
        // 重新读库的结果，所以连回显都是空的；但换个实现回显很容易假对。
        const back = await req(gwBase, 'GET', '/platform/settings', { token: ownerTok })
        assert(back.json.managerVersion === 'pinned-9.9.9', `重读 ${JSON.stringify(back.json.managerVersion)}`)

        // 存住还不够，得真的下发到心跳里去——那才是机器唯一的依据。
        const id = await machineIdOf(req, gwBase, ownerTok, orgId)
        const hb = await req(gwBase, 'POST', `/internal/machines/${id}/heartbeat`, {
          token: machineTok,
          body: { managerVersion: 'e2e-1', protocol: 1, node: process.versions.node, seats: [] },
        })
        assert(hb.json.desiredManagerVersion === 'pinned-9.9.9', `心跳下发的是 ${JSON.stringify(hb.json.desiredManagerVersion)}`)

        // 清掉 = 回到「跟最新发布走」。
        await req(gwBase, 'PUT', '/platform/settings', { token: ownerTok, body: { managerVersion: '' } })
        const cleared = await req(gwBase, 'GET', '/platform/settings', { token: ownerTok })
        assert(!cleared.json.managerVersion, `清不掉：${JSON.stringify(cleared.json.managerVersion)}`)
      } finally {
        await req(gwBase, 'PUT', '/platform/settings', { token: ownerTok, body: before })
      }
    })

    await test('登记远端包：验证过才入库，size/sha256 对不上就拒', async () => {
      // 拿一个真的 tar.gz 挂在 mock HTTP 上，走完整的「拉下来核对」流程。
      const { tarGz, sha256Of } = await import('./release.mjs')
      const pkg = tarGz([
        { name: './bin/satuwork-manager.mjs', data: '#!/usr/bin/env node\n' },
        { name: './VERSION', data: 'remote-1\n' },
      ])
      let lateBody = null
      const host = createServer((hreq, res) => {
        res.writeHead(200, { 'content-type': 'application/gzip' })
        res.end(hreq.url === '/late.tgz' ? lateBody : pkg)
      })
      const port = await listenOn(host, 0)
      const url = `http://127.0.0.1:${port}/manager.tgz`
      try {
        const bad = await req(gwBase, 'POST', '/platform/manager-releases', {
          token: ownerTok,
          body: { version: 'remote-1', url, size: pkg.length + 1, sha256: sha256Of(pkg) },
        })
        assert(bad.status === 400 && String(bad.json.error).includes('大小'), `size 不符应 400：${bad.status} ${bad.text}`)

        const badSha = await req(gwBase, 'POST', '/platform/manager-releases', {
          token: ownerTok,
          body: { version: 'remote-1', url, size: pkg.length, sha256: 'f'.repeat(64) },
        })
        assert(badSha.status === 400 && String(badSha.json.error).includes('sha256'), `sha 不符应 400：${badSha.status}`)

        const noHost = await req(gwBase, 'POST', '/platform/manager-releases', {
          token: ownerTok,
          body: { version: 'remote-2', url: 'http://127.0.0.1:1/x.tgz', size: 10, sha256: '0'.repeat(64) },
        })
        assert(noHost.status === 502, `取不到应 502：${noHost.status}`)

        const ok = await req(gwBase, 'POST', '/platform/manager-releases', {
          token: ownerTok,
          body: { version: 'remote-1', url, size: pkg.length, sha256: sha256Of(pkg) },
        })
        assert(ok.status === 201, `登记 ${ok.status} ${ok.text}`)
        assert(ok.json.release.url === url, 'url 要存下来')
        assert(ok.json.release.storage === 'remote', 'storage')

        // 下发时从远端现取，并且校验头还在——这条决定了管家能不能验完整性。
        const dl = await fetch(`${gwBase}/internal/manager-releases/remote-1`, {
          headers: { authorization: 'Bearer ' + machineTok },
        })
        assert(dl.status === 200, `下发 ${dl.status}`)
        assert(dl.headers.get('x-bot-sha256') === sha256Of(pkg), '校验头丢了')
        assert(Buffer.from(await dl.arrayBuffer()).equals(pkg), '字节对不上')

        // 入口排在包的**后面**也要认得出。真实的包就是这样：pack.mjs 打出来的 bin/ 在几百个
        // 依赖文件之后（管家包里是第 474 个成员）。前面垫 3 MiB 随机字节（压不小），入口落在
        // 压缩流 2 MiB 之后——以前只扫前 2 MiB，这种包一个都登记不上。
        const { randomBytes } = await import('node:crypto')
        const late = tarGz([
          { name: './node_modules/pad.bin', data: randomBytes(3 * 1024 * 1024) },
          { name: './bin/satuwork-manager.mjs', data: '#!/usr/bin/env node\n' },
        ])
        assert(late.length > 3 * 1024 * 1024, `垫料被压小了：${late.length}`)
        lateBody = late
        const lateOk = await req(gwBase, 'POST', '/platform/manager-releases', {
          token: ownerTok,
          body: { version: 'remote-late-1', url: `http://127.0.0.1:${port}/late.tgz`, size: late.length, sha256: sha256Of(late) },
        })
        assert(lateOk.status === 201, `入口在后面的包登记 ${lateOk.status} ${lateOk.text}`)

        // 心跳里的升级包地址按管家协议分流：3 号起的管家裸取外部地址、用心跳里的 sha256
        // 比对；更老的对任何地址都带机器票，只能给 Gateway 转发地址。字节只在本机的包，
        // 再新的管家也只能走转发。
        const mid = await machineIdOf(req, gwBase, ownerTok, orgId)
        const hbAt = async (protocol) => {
          const r = await req(gwBase, 'POST', `/internal/machines/${mid}/heartbeat`, {
            token: machineTok,
            body: { managerVersion: 'e2e-1', protocol, node: process.versions.node, seats: [] },
          })
          assert(r.status === 200, `heartbeat ${r.status} ${r.text}`)
          return r.json
        }
        const settingsBefore = (await req(gwBase, 'GET', '/platform/settings', { token: ownerTok })).json
        try {
          await req(gwBase, 'PUT', '/platform/settings', { token: ownerTok, body: { managerVersion: 'remote-1' } })
          const old = await hbAt(2)
          assert(old.desiredManagerVersion === 'remote-1', `期望版本 ${old.desiredManagerVersion}`)
          assert(String(old.url).endsWith('/internal/manager-releases/remote-1'), `老管家该走转发：${old.url}`)
          const fresh = await hbAt(3)
          assert(fresh.url === url, `3 号管家该直连外部地址：${fresh.url}`)
          assert(fresh.sha256 === sha256Of(pkg), '直连也要带校验值')

          // 装机脚本那条路（重跑装机脚本用机器票）：能直连的 302 到外部地址，校验值挂在
          // 这一跳的头上——脚本 curl -D 记下每一跳的头，拿它比对下到的字节。
          const inst = await fetch(`${gwBase}/manager/release`, {
            headers: { authorization: 'Bearer ' + machineTok },
            redirect: 'manual',
          })
          assert(inst.status === 302, `装机脚本拉包该 302 到外部地址，实际 ${inst.status}`)
          assert(inst.headers.get('location') === url, `跳到 ${inst.headers.get('location')}`)
          assert(inst.headers.get('x-bot-sha256') === sha256Of(pkg), '302 上要挂校验值')

          await publishRelease({ req, gwBase, token: ownerTok, version: 'local-mgr-1', kind: 'manager' })
          await req(gwBase, 'PUT', '/platform/settings', { token: ownerTok, body: { managerVersion: 'local-mgr-1' } })
          const local = await hbAt(10)
          assert(String(local.url).endsWith('/internal/manager-releases/local-mgr-1'), `本机的包只能走转发：${local.url}`)
          const instLocal = await fetch(`${gwBase}/manager/release`, {
            headers: { authorization: 'Bearer ' + machineTok },
            redirect: 'manual',
          })
          assert(instLocal.status === 200, `本机的包照旧直接给字节，实际 ${instLocal.status}`)
          const localBytes = Buffer.from(await instLocal.arrayBuffer())
          assert(instLocal.headers.get('x-bot-sha256') === sha256Of(localBytes), '直接给字节也要带校验值')
        } finally {
          await req(gwBase, 'PUT', '/platform/settings', { token: ownerTok, body: settingsBefore })
        }
      } finally {
        // closeServer 先掐 keep-alive 连接再关：裸 close() 会等 Gateway 那条拉包连接自己断。
        await closeServer(host, 'release host')
      }
    })

    await test('平台机器管理：列得出所有机器，改得动配置，归属改得回来', async () => {
      // 这一组和 /platform/orgs/:id/machine 是**两个口径**，两个都要有：那条答的是
      // 「这家公司有几台」，这条答的是「这台 Gateway 上挂着哪些机器」。差别不只是
      // 入口——没派给任何公司的机器在按公司列的那条路上永远列不出来。
      const machineId = await machineIdOf(req, gwBase, ownerTok, orgId)

      const anon = await req(gwBase, 'GET', '/platform/machines')
      assert(anon.status === 401, `无票该 401，实际 ${anon.status}`)

      // 公司管理员看不到别家的机器，这一整组都是 owner 的。
      const adminLogin = await req(gwBase, 'POST', '/auth/login', {
        body: { email: 'admin@mgrtest.local', password: 'manager-admin-1234' },
      })
      assert(adminLogin.status === 200, `admin login ${adminLogin.status} ${adminLogin.text}`)
      const asAdmin = await req(gwBase, 'GET', '/platform/machines', { token: adminLogin.json.token })
      assert(asAdmin.status === 403, `公司管理员该 403，实际 ${asAdmin.status} ${asAdmin.text}`)

      const list = await req(gwBase, 'GET', '/platform/machines', { token: ownerTok })
      assert(list.status === 200, `list ${list.status} ${list.text}`)
      const row = (list.json.machines || []).find((c) => c.machine.id === machineId)
      assert(row, `列表里没有这台机器：${list.text.slice(0, 300)}`)
      assert(row.company && row.company.id === orgId, `归属公司没带出来：${JSON.stringify(row.company)}`)
      // 编号在平台这一侧必须是 null：「1 号机」是一家公司内部数出来的短号，两家公司
      // 的机器摆在同一张表里，两个「1 号机」并排会指代不清。
      assert(row.no === null, `平台侧不该有编号：${row.no}`)
      assert(list.json.totals.machines >= 1 && list.json.totals.paired >= 1, `totals 不对：${JSON.stringify(list.json.totals)}`)

      const one = await req(gwBase, 'GET', `/platform/machines/${machineId}`, { token: ownerTok })
      assert(one.status === 200, `detail ${one.status} ${one.text}`)
      assert(one.json.machine.id === machineId, 'detail 的机器不对')
      // 席位清单和「席位数」不能撞在同一个键上：撞了的话详情页上那个数字会变成
      // 一串 [object Object]，而 `有没有席位` 这类判断会因为「空数组是真值」整个翻过来。
      assert(Array.isArray(one.json.seatList), 'seatList 该是数组')
      assert(typeof one.json.seats === 'number', `seats 该是个数：${JSON.stringify(one.json.seats)}`)
      // 席位行要自带人名和 Bot 名。少了它们，界面上那一列只能显示 uuid——前端手上
      // 那份 Bot 名录是别的页面顺带装进去的，这一页从不加载。
      for (const seat of one.json.seatList) {
        assert('who' in seat && 'botName' in seat, `席位行少了名字：${JSON.stringify(seat)}`)
      }
      // 列表页只画汇总，不该为每台机器白跑一轮按席位的账号查询。
      const listRow = (await req(gwBase, 'GET', '/platform/machines', { token: ownerTok })).json.machines.find(
        (c) => c.machine.id === machineId,
      )
      assert(!('seatList' in listRow), '列表页不用席位清单，就别带上它')
      // 反过来，公司详情那条**必须**还带着它：那一页的日志选择器要靠它列出席位。
      const orgCard = (await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })).json.machines.find(
        (c) => c.machine.id === machineId,
      )
      assert(Array.isArray(orgCard.seatList), '公司侧的机器卡片把席位清单弄丢了')
      assert((one.json.companies || []).some((c) => c.id === orgId), '改归属要用的公司清单没给')
      const miss = await req(gwBase, 'GET', '/platform/machines/00000000-0000-4000-8000-00000000dead', { token: ownerTok })
      assert(miss.status === 404, `不存在的机器该 404，实际 ${miss.status}`)

      // 容量与时区：和公司侧那条改的是同一行，两边看到的必须是同一个值。
      const cap = await req(gwBase, 'PUT', `/platform/machines/${machineId}/capacity`, {
        token: ownerTok,
        body: { maxAccounts: 33 },
      })
      assert(cap.status === 200, `capacity ${cap.status} ${cap.text}`)
      const viaOrg = (await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })).json.machines.find(
        (c) => c.machine.id === machineId,
      )
      assert(viaOrg.maxAccounts === 33, `公司侧看到的容量是 ${viaOrg.maxAccounts}`)
      assert(
        (await req(gwBase, 'PUT', `/platform/machines/${machineId}/capacity`, { token: ownerTok, body: { maxAccounts: 0 } }))
          .status === 400,
        '容量 0 该 400',
      )
      await req(gwBase, 'PUT', `/platform/machines/${machineId}/capacity`, { token: ownerTok, body: { maxAccounts: 10 } })

      const badTz = await req(gwBase, 'PUT', `/platform/machines/${machineId}/timezone`, {
        token: ownerTok,
        body: { timezone: 'Asia/Shanghi' },
      })
      assert(badTz.status === 400, `坏时区该 400，实际 ${badTz.status}`)
      const tz = await req(gwBase, 'PUT', `/platform/machines/${machineId}/timezone`, {
        token: ownerTok,
        body: { timezone: 'asia/singapore' },
      })
      assert(tz.status === 200 && tz.json.machine.timezone === 'Asia/Singapore', `时区 ${tz.status} ${tz.text}`)
      await req(gwBase, 'PUT', `/platform/machines/${machineId}/timezone`, { token: ownerTok, body: { timezone: '' } })

      // 地址：改完当场探活。这台真管家在，所以 reachable 必须为真——不然「保存成功」
      // 就成了一句没人验过的话。
      const host = await req(gwBase, 'PUT', `/platform/machines/${machineId}/host`, {
        token: ownerTok,
        body: { host: mgrBase },
      })
      assert(host.status === 200, `host ${host.status} ${host.text}`)
      assert(host.json.reachable === true, `探活没通：${host.json.error}`)
      assert((await req(gwBase, 'PUT', `/platform/machines/${machineId}/host`, { token: ownerTok, body: { host: '' } })).status === 400, '空地址该 400')

      // 日志跟公司侧那条一样要留审计，也一样只认这台机器上的席位。
      const logs = await req(gwBase, 'GET', `/platform/machines/${machineId}/logs?lines=5`, { token: ownerTok })
      assert(logs.status === 200, `logs ${logs.status} ${logs.text}`)
      assert(Array.isArray(logs.json.lines), `lines 该是数组：${logs.text.slice(0, 200)}`)
      const badSeat = await req(gwBase, 'GET', `/platform/machines/${machineId}/logs?seatId=seat-not-here`, { token: ownerTok })
      assert(badSeat.status === 404, `外来 seatId 该 404，实际 ${badSeat.status}`)

      // 归属：收回来再派回去。收回之后它仍然列得出来——这正是这一页存在的理由。
      const off = await req(gwBase, 'PUT', `/platform/machines/${machineId}/company`, { token: ownerTok, body: { companyId: '' } })
      assert(off.status === 200, `收回 ${off.status} ${off.text}`)
      const orphan = (await req(gwBase, 'GET', '/platform/machines', { token: ownerTok })).json.machines.find(
        (c) => c.machine.id === machineId,
      )
      assert(orphan && orphan.company === null, `收回后该是无归属，实际 ${JSON.stringify(orphan && orphan.company)}`)
      const gone = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      assert(!gone.json.machines.some((c) => c.machine.id === machineId), '收回后不该还挂在公司名下')

      const badOrg = await req(gwBase, 'PUT', `/platform/machines/${machineId}/company`, {
        token: ownerTok,
        body: { companyId: '00000000-0000-4000-8000-00000000dead' },
      })
      assert(badOrg.status === 404, `不存在的公司该 404，实际 ${badOrg.status}`)

      // 移除：有席位也删得掉，席位的登记跟着一起没。造一台带席位的假机器来验——真管家
      // 那台后面还要用。**不能只删机器**：留下的席位行会指向一条不存在的机器记录，而
      // machineTokenFor 查不到就回落到这家公司的另一台，聊天请求会带着别的机器的票发出去。
      {
        const { createRequire } = await import('node:module')
        const require = createRequire(new URL('../gateway/package.json', import.meta.url))
        const pg = require('pg')
        const client = new pg.Client({ connectionString: PG_URL })
        await client.connect()
        const doomed = '00000000-0000-4000-8000-0000000000de'
        try {
          await client.query(`set search_path to ${SCHEMA}`)
          await client.query(
            `insert into machines (id, host, "companyId", "lastHeartbeatAt", "createdAt", "pairedAt", protocol, "maxAccounts", token)
             values ($1, 'http://10.0.0.77:8443', $2, $3, $3, $3, 1, 10, 'smt_e2e-doomed')`,
            [doomed, orgId, Date.now()],
          )
          const who = (await req(gwBase, 'GET', `/orgs/${orgId}/accounts`, { token: ownerTok })).json
          const member = (who.members || who.accounts || [])[0]
          await client.query(
            `insert into seat_runtimes ("accountId","botId","companyId","linuxUser","seatId","machineId",slot,display,"vncPort","novncPort","botPort","vncPassword",status,"deployedAt","updatedAt","botVersion")
             values ($1,'bot-doomed',$2,'sw_doomed','seat-doomed',$3,7,17,5917,6088,3207,'pw','ready',$4,$4,'0.9.0+x')`,
            [member.id, orgId, doomed, Date.now()],
          )
          await client.query(
            `insert into instances ("accountId","botId","companyId",host,"lastReadyAt") values ($1,'bot-doomed',$2,'http://10.0.0.77:8443/seats/seat-doomed/bot',$3)`,
            [member.id, orgId, Date.now()],
          )

          const del = await req(gwBase, 'DELETE', `/platform/machines/${doomed}`, { token: ownerTok })
          assert(del.status === 200, `有席位也该删得掉，实际 ${del.status} ${del.text}`)
          assert(del.json.seats === 1, `该报出连带删了几个席位，实际 ${JSON.stringify(del.json.seats)}`)
          // 这台假机器刚插进去，lastHeartbeatAt 是现在 → machineLink 判 online，
          // 所以走的是「立墓碑等它来收信」那条，而不是硬删。
          assert(del.json.pending === true, `在线的机器该留墓碑等收信，实际 pending=${del.json.pending}`)

          const seatRows = await client.query('select 1 from seat_runtimes where "machineId" = $1', [doomed])
          assert(seatRows.rowCount === 0, `席位登记没跟着删：还剩 ${seatRows.rowCount} 行`)
          // instances 一起清掉：它存的是 bot 的反代前缀，留着同样是个指向已移除机器的旧地址。
          const inst = await client.query(`select 1 from instances where "botId" = 'bot-doomed'`)
          assert(inst.rowCount === 0, `instances 没跟着删：还剩 ${inst.rowCount} 行`)

          const gone = await req(gwBase, 'GET', `/platform/machines/${doomed}`, { token: ownerTok })
          assert(gone.status === 404, `删完还查得到，实际 ${gone.status}`)
          const listed = (await req(gwBase, 'GET', '/platform/machines', { token: ownerTok })).json.machines
          assert(!listed.some((m) => m.machine.id === doomed), '墓碑不该出现在列表里')

          // ── 墓碑存在的全部意义：把「你被移除了」交到机器手上。─────────────
          //
          // **不能回 401。** 那是否定式信号（「我不认识你」），Gateway 回滚版本、库恢复
          // 到旧快照、DNS 指错，都会让整队机器同时收到它——管家据此自毁就是全机队自杀。
          const hb = await req(gwBase, 'POST', `/internal/machines/${doomed}/heartbeat`, {
            token: 'smt_e2e-doomed',
            body: { managerVersion: 'e2e-1', protocol: 1, node: process.versions.node, seats: [] },
          })
          assert(hb.status === 200, `墓碑上的心跳该是 200，实际 ${hb.status} ${hb.text}`)
          assert(hb.json.removed === true, `没把「你被移除了」带下去：${hb.text}`)
          // 不在册了就别再更新它的字段，否则墓碑看着像台活机器。
          const stillThere = await client.query('select "lastHeartbeatAt", "removedAt" from machines where id = $1', [doomed])
          assert(stillThere.rows[0]?.removedAt, '墓碑没了？')
          assert(
            Number(stillThere.rows[0].lastHeartbeatAt) < Number(stillThere.rows[0].removedAt),
            '墓碑上的心跳不该刷新 lastHeartbeatAt',
          )

          // 管家收拾完的回执 → 这一行才真的没。
          const receipt = await req(gwBase, 'POST', `/internal/machines/${doomed}/removed`, { token: 'smt_e2e-doomed', body: {} })
          assert(receipt.status === 200, `回执 ${receipt.status} ${receipt.text}`)
          const rows = await client.query('select 1 from machines where id = $1', [doomed])
          assert(rows.rowCount === 0, `收到回执之后该真删，还剩 ${rows.rowCount} 行`)
          // 票也跟着失效了：再敲就只有 401。
          const after = await req(gwBase, 'POST', `/internal/machines/${doomed}/heartbeat`, {
            token: 'smt_e2e-doomed',
            body: { protocol: 1 },
          })
          assert(after.status === 401, `行都没了还认票？实际 ${after.status}`)
        } finally {
          await client.query('delete from seat_runtimes where "machineId" = $1', [doomed]).catch(() => {})
          await client.query('delete from machines where id = $1', [doomed]).catch(() => {})
          await client.end().catch(() => {})
        }
      }

      const back = await req(gwBase, 'PUT', `/platform/machines/${machineId}/company`, { token: ownerTok, body: { companyId: orgId } })
      assert(back.status === 200, `派回 ${back.status} ${back.text}`)
      const again = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      assert(again.json.machine && again.json.machine.id === machineId, '派回之后该重新成为这家公司的默认机器')
    })

    // ── 模型中继（10 号协议）────────────────────────────────────────────
    //
    // 席位 Bot 调模型不再直打 Gateway 的 /v1，改打管家回环上的 /llm/v1/*：管家拿 Bot 的
    // sk_sw_ 去 Gateway 领授权（/worker/llm/grant），拿到密钥直接打供应商，流原样回给 Bot，
    // 收完再把 usage 报回去结算。这一组用一个假的 OpenAI 兼容上游盯住整条链：授权、密钥
    // 取序（公司 → 平台）、字节不变、记账落库、各种拒绝各归各的错。
    log('\n## 模型中继')
    {
      const PROVIDER = 'relay-llm'
      const MODEL = 'relay-model'
      /** 会推理的那颗：验「推理档被夹回这颗模型认的那几档」。 */
      const THINK_MODEL = 'relay-thinker'
      /** 走 Anthropic 协议的那家：中继改不了它的请求体形状，该退回 Gateway 的 /v1。 */
      const ANTHRO_PROVIDER = 'anthro-llm'
      const ANTHRO_MODEL = 'anthro-model'
      /** 假上游收到的每一次请求：{ auth, path, body }。 */
      const upSeen = []
      /**
       * 假上游这一次怎么答：
       *
       *   'stream'   照旧发 SSE（openai-completions 的常态）
       *   'json'     发一整包**成功**的 JSON，正文里故意含 `application/json` 这几个字
       *   'error'    发 4xx，并把收到的 Authorization 原样回显进正文（真上游就这么干）
       *
       * 后两种是给「抹密钥别把 application/json 一起抹了」那条用的，见下面那条用例。
       */
      let upMode = 'stream'
      const upstream = createServer((r, res) => {
        let buf = ''
        r.on('data', (d) => (buf += d))
        r.on('end', () => {
          let body = null
          try {
            body = JSON.parse(buf)
          } catch {}
          upSeen.push({ auth: r.headers.authorization, path: r.url, body })
          // 走 Anthropic 协议那家：这条路是 Gateway 自己的 /v1 底下 pi-ai 打过来的
          // （中继退回去了），所以要发 Messages 协议的事件流，不是 OpenAI 那种 chunk。
          if (r.url.startsWith('/anthropic/')) {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
            const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
            ev('message_start', {
              message: { id: 'msg_e2e', type: 'message', role: 'assistant', model: ANTHRO_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } },
            })
            ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
            ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } })
            ev('content_block_stop', { index: 0 })
            ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
            ev('message_stop', {})
            res.end()
            return
          }
          if (upMode === 'json' || upMode === 'error') {
            const ok = upMode === 'json'
            res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' })
            res.end(
              JSON.stringify(
                ok
                  ? { id: 'c', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: '记得把 Content-Type 设成 application/json' }, finish_reason: 'stop' }] }
                  : { error: { message: `拒了。你发来的 authorization=${r.headers.authorization}，content-type=application/json`, type: 'invalid_request_error' } },
              ),
            )
            return
          }
          /**
           * **用量帧只在请求里写了 `stream_options.include_usage` 时才发。**
           *
           * 真上游就是这么干的：OpenAI 兼容的流不带这一格就一个 usage 字段都不回，于是
           * 每一次流式调用都记成 unpriced、收 0 元。假上游无条件发的话，这整条「谁来补
           * 这一格」就再也测不出来——补丢了照样绿。同一条规矩在 e2e/custom-provider.mjs
           * 的假上游里也钉着一份。
           */
          const wantUsage = body?.stream_options?.include_usage === true
          // openai-completions 是流式的，必须发 SSE，不能发整包 JSON。
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
          const chunk = (choices, usage) =>
            `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices, ...(usage ? { usage } : {}) })}\n\n`
          res.write(chunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]))
          res.write(chunk([{ index: 0, delta: { content: 'ok' }, finish_reason: null }]))
          res.write(
            chunk(
              [{ index: 0, delta: {}, finish_reason: 'stop' }],
              wantUsage ? { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } : undefined,
            ),
          )
          res.write('data: [DONE]\n\n')
          res.end()
        })
      })
      await listenOn(upstream, UP_PORT)
      const upLast = () => upSeen[upSeen.length - 1]

      const { createRequire } = await import('node:module')
      const require = createRequire(new URL('../gateway/package.json', import.meta.url))
      const pgMod = require('pg')
      /** 开一条连到本套件 schema 的连接跑一段，跑完关掉。 */
      const withPg = async (fn) => {
        const client = new pgMod.Client({ connectionString: PG_URL })
        await client.connect()
        try {
          await client.query(`set search_path to ${SCHEMA}`)
          return await fn(client)
        } finally {
          await client.end().catch(() => {})
        }
      }
      const statOf = (usage, label) => Number(usage.json.stats.find((s) => s.label === label)?.value ?? NaN)
      /** 这一组开始前公司已有的用量；下面的断言都按增量算，别把前面用例的账算进来。 */
      let usage0 = { prompt: 0, completion: 0 }
      const rawUsage = async (token) => {
        const u = await req(gwBase, 'GET', `/orgs/${orgId}/usage`, { token })
        assert(u.status === 200, `usage ${u.status} ${u.text}`)
        return { prompt: statOf(u, '输入 Tokens'), completion: statOf(u, '输出 Tokens') }
      }
      const readUsage = async () => {
        // 结算在响应写完之后才报回 Gateway，给它两拍。
        await new Promise((r) => setTimeout(r, 400))
        const u = await rawUsage(adminTok)
        return { prompt: u.prompt - usage0.prompt, completion: u.completion - usage0.completion }
      }
      const chatBody = { model: `${PROVIDER}/${MODEL}`, messages: [{ role: 'user', content: 'hi' }], stream: true }

      const machineId = await machineIdOf(req, gwBase, ownerTok, orgId)
      let adminTok = ''
      let adminId = ''
      let apiKey = ''
      /** 另一家公司管理员的钥匙：席位不在这台机器上，用来验 403。 */
      let strangerKey = ''

      try {
        await test('模型中继：登记假上游供应商，平台配一把密钥（公司那条已经没有了）', async () => {
          const model = {
            id: MODEL, name: 'Relay Model', contextWindow: 65536, maxTokens: 4096,
            reasoning: false, input: ['text'], cost: { input: 1.5, output: 3, cacheRead: 0, cacheWrite: 0 },
          }
          // 会推理的那颗：没写 thinkingLevelMap，于是 pi-ai 认的档只到 high，`xhigh` 必须被夹下来。
          const thinker = { ...model, id: THINK_MODEL, name: 'Relay Thinker', reasoning: true }
          const made = await req(gwBase, 'POST', '/platform/providers', {
            token: ownerTok,
            body: { id: PROVIDER, name: 'Relay LLM', baseUrl: `http://127.0.0.1:${UP_PORT}/v1`, api: 'openai-completions', models: [model, thinker] },
          })
          assert(made.status === 201, `建供应商 ${made.status} ${made.text}`)
          const plat = await req(gwBase, 'POST', '/platform/credentials', { token: ownerTok, body: { provider: PROVIDER, secret: 'platform-key' } })
          assert(plat.status === 201, `平台密钥 ${plat.status} ${plat.text}`)

          // 走 Anthropic 协议的那家，单独一个供应商（一个供应商只有一个 api）。
          const anthro = await req(gwBase, 'POST', '/platform/providers', {
            token: ownerTok,
            body: {
              id: ANTHRO_PROVIDER, name: 'Anthro LLM', baseUrl: `http://127.0.0.1:${UP_PORT}/anthropic`, api: 'anthropic-messages',
              models: [{ ...model, id: ANTHRO_MODEL, name: 'Anthro Model' }],
            },
          })
          assert(anthro.status === 201, `建 Anthropic 协议供应商 ${anthro.status} ${anthro.text}`)
          const anthroKey = await req(gwBase, 'POST', '/platform/credentials', { token: ownerTok, body: { provider: ANTHRO_PROVIDER, secret: 'anthro-platform-key' } })
          assert(anthroKey.status === 201, `Anthropic 家平台密钥 ${anthroKey.status} ${anthroKey.text}`)

          const login = await req(gwBase, 'POST', '/auth/login', { body: { email: 'admin@mgrtest.local', password: 'manager-admin-1234' } })
          assert(login.status === 200, `admin login ${login.status} ${login.text}`)
          adminTok = login.json.token
          const me = await req(gwBase, 'GET', '/me', { token: adminTok })
          assert(me.status === 200, `/me ${me.status}`)
          adminId = me.json.account.id
          usage0 = await rawUsage(adminTok)
          // 这家公司是套件开头裸建的，一分钱都没充；平台默认开着余额闸，不充就是 402
          // （「额度用完了」）。402 那条路下面单独验，这里先让它有钱。
          const paid = await req(gwBase, 'POST', '/platform/orders', {
            token: ownerTok,
            body: { companyId: orgId, kind: 'topup', amount: 100, payStatus: 'paid', note: 'e2e 模型中继' },
          })
          assert(paid.status === 201, `充值 ${paid.status} ${paid.text}`)

          // 公司那条路撤了：中继取密钥和 /v1 取密钥用的是同一个 llm.secret，两边一起
          // 只剩「平台密钥 > 环境变量」。这里钉一下接口真的不在了，别让中继那几条
          // 在一个「其实还能配、只是没人配」的假前提上验取序。
          const comp = await req(gwBase, 'POST', `/orgs/${orgId}/credentials`, { token: adminTok, body: { provider: PROVIDER, secret: 'company-key' } })
          assert(comp.status === 404, `配公司密钥该 404，实际 ${comp.status} ${comp.text}`)
          const list = await req(gwBase, 'GET', `/orgs/${orgId}/credentials`, { token: adminTok })
          assert(list.status === 404, `列公司密钥该 404，实际 ${list.status} ${list.text}`)

          // Bot 手里那把 sk_sw_：owner 从平台那条能读到（部署时就是这么拿的）。
          const secrets = await req(gwBase, 'GET', `/platform/accounts/${adminId}`, { token: ownerTok })
          assert(secrets.status === 200, `读账号密钥 ${secrets.status} ${secrets.text}`)
          apiKey = secrets.json.apiKey
          assert(typeof apiKey === 'string' && apiKey.startsWith('sk_sw_'), `apiKey 不像 sk_sw_：${apiKey}`)

          // 授权只发给**这台机器上有席位**的账号：给管理员在真管家这台机器上补一行席位。
          // 真管家的名册里没有这个席位也无妨——中继不问名册，问的是 Gateway。
          await withPg((client) =>
            client.query(
              `insert into seat_runtimes ("accountId","botId","companyId","linuxUser","seatId","machineId",slot,display,"vncPort","novncPort","botPort","vncPassword",status,"deployedAt","updatedAt","botVersion")
               values ($1,'bot-llm',$2,'sw-llm','seat-llm',$3,8,18,5918,6089,3208,'pw','ready',$4,$4,'0.0.0-e2e')`,
              [adminId, orgId, machineId, Date.now()],
            ),
          )
          // 前面有用例拿假心跳把这台报成过 9；这里明说一次 10，别让后面的断言靠时机。
          const hb = await req(gwBase, 'POST', `/internal/machines/${machineId}/heartbeat`, {
            token: machineTok,
            body: { managerVersion: 'e2e-10', protocol: 10, node: process.versions.node, seats: [] },
          })
          assert(hb.status === 200, `heartbeat ${hb.status} ${hb.text}`)
        })

        await test('模型中继：Bot 打管家回环 /llm/v1/chat/completions，流原样回来，上游拿的是平台密钥', async () => {
          upSeen.length = 0
          const r = await req(mgrBase, 'POST', '/llm/v1/chat/completions', { token: apiKey, body: chatBody })
          assert(r.status === 200, `chat ${r.status} ${r.text.slice(0, 300)}`)
          assert(String(r.headers.get('content-type')).startsWith('text/event-stream'), `content-type ${r.headers.get('content-type')}`)
          assert(r.text.includes('"content":"ok"'), `流里没有上游那段 ok：${r.text.slice(0, 300)}`)
          assert(r.text.includes('data: [DONE]'), `流尾没有 [DONE]：${r.text.slice(-100)}`)
          assert(!r.text.includes('platform-key'), '密钥漏进了给 Bot 的响应')

          const up = upLast()
          assert(upSeen.length === 1 && up, `上游该收到 1 次请求，实际 ${upSeen.length}`)
          assert(up.auth === 'Bearer platform-key', `上游收到的是 ${up.auth}`)
          assert(up.path === '/v1/chat/completions', `上游路径 ${up.path}`)
          assert(up.body && up.body.model === MODEL, `上游收到的 model 是 ${JSON.stringify(up.body?.model)}——不能把 provider 那段捎上去`)
          assert(!('provider' in up.body), '上游收到的正文里多了 provider 字段')
          assert(up.body.stream === true, '上游收到的 stream 丢了')
          /**
           * **流式调用必须带 `stream_options.include_usage`。** 这一格由授权下发的 body
           * 补丁补上（gateway/src/llm.ts 的 chatBodyPatch）。以前挂在 /v1 上时是 pi-ai
           * 顺手补的，换成中继之后没人做了——上游一个 usage 字段都不回，于是每一次流式
           * 调用都记成 unpriced、收 0 元。假上游也只在看见这一格时才发用量帧，所以下面
           * 那条「usage 结算回 Gateway 记 5/1」是这一格的第二重保险。
           */
          assert(
            up.body.stream_options && up.body.stream_options.include_usage === true,
            `上游没收到 stream_options.include_usage：${JSON.stringify(up.body.stream_options)}`,
          )
        })

        await test('模型中继：usage 结算回 Gateway，llm_calls 和账本各一行', async () => {
          const u = await readUsage()
          assert(u.prompt === 5, `输入 tokens ${u.prompt}，应为 5`)
          assert(u.completion === 1, `输出 tokens ${u.completion}，应为 1`)
          await withPg(async (client) => {
            const calls = await client.query(
              'select id, "promptTokens", "completionTokens", provider, model from llm_calls where "companyId" = $1 and "accountId" = $2 order by "createdAt" desc',
              [orgId, adminId],
            )
            assert(calls.rowCount === 1, `这家公司该有 1 条 llm_calls，实际 ${calls.rowCount}`)
            const c = calls.rows[0]
            assert(Number(c.promptTokens) === 5 && Number(c.completionTokens) === 1, `llm_calls 记的是 ${c.promptTokens}/${c.completionTokens}`)
            assert(c.provider === PROVIDER && c.model === MODEL, `llm_calls 记的模型是 ${c.provider}/${c.model}`)
            const charges = await client.query(
              `select count(*)::int as n from usage_charges where kind = 'llm' and "refId" in (select id from llm_calls where "companyId" = $1)`,
              [orgId],
            )
            assert(charges.rows[0].n === 1, `账本该按 refId 挂 1 行，实际 ${charges.rows[0].n}`)
          })
        })

        await test('模型中继：第二次调用照样记账，上游还是平台那把', async () => {
          // 这条原先验的是「删掉公司密钥就落回平台密钥」。公司那一档撤掉之后取序只剩
          // 「平台密钥 > 环境变量」，没有可删的东西了；留下来的那一半仍然值得验——
          // 同一条中继连打两次，第二次的用量要单独记上，不能被第一次的账盖住。
          upSeen.length = 0
          const r = await req(mgrBase, 'POST', '/llm/v1/chat/completions', { token: apiKey, body: chatBody })
          assert(r.status === 200, `chat ${r.status} ${r.text.slice(0, 300)}`)
          assert(upLast()?.auth === 'Bearer platform-key', `上游收到的是 ${upLast()?.auth}`)
          const u = await readUsage()
          assert(u.prompt === 10 && u.completion === 2, `第二次调用没记上：${u.prompt}/${u.completion}`)
        })

        await test('模型中继：GET /llm/v1/models 转 Gateway 的目录，带着自定义模型', async () => {
          const r = await req(mgrBase, 'GET', '/llm/v1/models', { token: apiKey })
          assert(r.status === 200, `models ${r.status} ${r.text.slice(0, 300)}`)
          const m = (r.json.data || []).find((x) => x.id === `${PROVIDER}/${MODEL}`)
          assert(m, `目录里没有 ${PROVIDER}/${MODEL}：${r.text.slice(0, 300)}`)
          const anon = await req(mgrBase, 'GET', '/llm/v1/models')
          assert(anon.status === 401, `无钥匙的 models 该 401，实际 ${anon.status}`)
        })

        await test('模型中继：各种拒绝各归各的错——无钥匙 401、坏钥匙 401、别家席位 403、未知模型 404', async () => {
          upSeen.length = 0
          const anon = await req(mgrBase, 'POST', '/llm/v1/chat/completions', { body: chatBody })
          assert(anon.status === 401, `无钥匙该 401，实际 ${anon.status} ${anon.text.slice(0, 200)}`)
          const bad = await req(mgrBase, 'POST', '/llm/v1/chat/completions', { token: 'sk_sw_not-a-real-key', body: chatBody })
          assert(bad.status === 401, `坏钥匙该 401（grant 转回来的），实际 ${bad.status} ${bad.text.slice(0, 200)}`)

          // 另一家公司的管理员：钥匙是真的，但席位不在这台机器上。管家不该替别人家的 Bot 调。
          const other = await req(gwBase, 'POST', '/platform/orgs', {
            token: ownerTok,
            body: {
              name: '别家公司', slug: 'mgrtest-other',
              contactName: '联系人', contactPhone: '+86 13800000001', contactEmail: 'admin@other.local',
              adminEmail: 'admin@other.local', adminPassword: 'manager-admin-1234',
            },
          })
          assert(other.status === 201, `建别家公司 ${other.status} ${other.text}`)
          const oLogin = await req(gwBase, 'POST', '/auth/login', { body: { email: 'admin@other.local', password: 'manager-admin-1234' } })
          assert(oLogin.status === 200, `别家 admin login ${oLogin.status}`)
          const oMe = await req(gwBase, 'GET', '/me', { token: oLogin.json.token })
          const oSecrets = await req(gwBase, 'GET', `/platform/accounts/${oMe.json.account.id}`, { token: ownerTok })
          strangerKey = oSecrets.json.apiKey
          assert(typeof strangerKey === 'string' && strangerKey.startsWith('sk_sw_'), `别家 apiKey 不像 sk_sw_：${strangerKey}`)
          const stranger = await req(mgrBase, 'POST', '/llm/v1/chat/completions', { token: strangerKey, body: chatBody })
          assert(stranger.status === 403, `席位不在这台机器上该 403，实际 ${stranger.status} ${stranger.text.slice(0, 200)}`)

          const unknown = await req(mgrBase, 'POST', '/llm/v1/chat/completions', {
            token: apiKey,
            body: { ...chatBody, model: `${PROVIDER}/no-such-model` },
          })
          assert(unknown.status === 404, `未知模型该 404（grant 转回来的），实际 ${unknown.status} ${unknown.text.slice(0, 200)}`)
          assert(upSeen.length === 0, `被拒的调用不该打到上游，实际打了 ${upSeen.length} 次`)

          // 被拒的调用不记 token。
          const u = await readUsage()
          assert(u.prompt === 10 && u.completion === 2, `被拒的调用记了用量：${u.prompt}/${u.completion}`)
        })

        await test('模型中继：/llm 只收回环地址；从回环进来但带转发头的也算外人，404 不暴露有这条路', async () => {
          // 机器前面挂了反代（Caddy 反到 127.0.0.1:8443）时，外面的请求在 socket 上也是回环。
          // 本机 Bot 直连不带转发头，带了就是被代理转进来的——哪怕钥匙是对的也当没有这条路。
          upSeen.length = 0
          const cases = [
            { 'x-forwarded-for': '203.0.113.9' },
            { forwarded: 'for=203.0.113.9;proto=https' },
            { 'x-real-ip': '203.0.113.9' },
          ]
          for (const extra of cases) {
            const r = await fetch(`${mgrBase}/llm/v1/chat/completions`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, ...extra },
              body: JSON.stringify(chatBody),
            })
            const text = await r.text()
            assert(r.status === 404, `带 ${Object.keys(extra)[0]} 的该 404，实际 ${r.status} ${text.slice(0, 200)}`)
          }
          assert(upSeen.length === 0, `带转发头的调用不该打到上游，实际打了 ${upSeen.length} 次`)
          // 同一把钥匙、不带转发头，照常通——拒的是转发头，不是钥匙。
          const ok = await req(mgrBase, 'GET', '/llm/v1/models', { token: apiKey })
          assert(ok.status === 200, `不带转发头的 models 该 200，实际 ${ok.status} ${ok.text.slice(0, 200)}`)
        })

        await test('模型中继：Gateway 那半边——机器票直接领授权，钱只收一次但 token 会补正', async () => {
          const grant = await req(gwBase, 'POST', '/worker/llm/grant', {
            token: machineTok,
            body: { apiKey, route: 'chat', model: `${PROVIDER}/${MODEL}` },
          })
          assert(grant.status === 200, `grant ${grant.status} ${grant.text}`)
          const g = grant.json
          assert(typeof g.callId === 'string' && g.callId, `grant 没回 callId：${grant.text}`)
          assert(g.provider === PROVIDER && g.model === MODEL, `grant 回的模型是 ${g.provider}/${g.model}`)
          assert(g.url === `http://127.0.0.1:${UP_PORT}/v1/chat/completions`, `grant 回的 url 是 ${g.url}`)
          assert(g.headers && g.headers.authorization === 'Bearer platform-key', `grant 回的 headers 是 ${JSON.stringify(g.headers)}`)

          const settle = await req(gwBase, 'POST', `/worker/llm/${g.callId}/settle`, {
            token: machineTok,
            // usage 按 TokenUsage 的四项报（manager/src/llm-usage.ts 折好的那份形状）。
            body: { usage: { prompt_tokens: 5, completion_tokens: 1, cached_tokens: 0, cache_write_tokens: 0 }, status: 'ok' },
          })
          assert(settle.status === 200 && settle.json.settled === true, `settle ${settle.status} ${settle.text}`)
          /**
           * 第二次结算走的是幂等那一支。**钱不能再收一笔，但 token 要按新报的补正。**
           *
           * 真实的场景是：一轮长回答跑过了 30 分钟宽限期，清扫（sweepUnsettledLlmCalls）
           * 先把它收成 failed / 0 元 / unpriced；管家随后才带着真实用量回来。幂等分支
           * 只回一句 `already` 的话，llm_calls 那一行就永远停在 0/0——读起来是「这次调用
           * 什么都没发生」，而它明明发生过、还很贵。所以那一支里先走 recordUsageOnly。
           */
          const twice = await req(gwBase, 'POST', `/worker/llm/${g.callId}/settle`, {
            token: machineTok,
            body: { usage: { prompt_tokens: 7, completion_tokens: 3, cached_tokens: 0, cache_write_tokens: 0 }, status: 'ok' },
          })
          assert(twice.status === 200 && twice.json.settled === false && twice.json.reason === 'already', `第二次 settle 该 settled:false/already，实际 ${twice.status} ${twice.text}`)
          await withPg(async (client) => {
            const row = await client.query('select "promptTokens", "completionTokens" from llm_calls where id = $1', [g.callId])
            assert(row.rowCount === 1, `llm_calls 少了这一行：${row.rowCount}`)
            assert(
              Number(row.rows[0].promptTokens) === 7 && Number(row.rows[0].completionTokens) === 3,
              `幂等那一支没补正 token：${row.rows[0].promptTokens}/${row.rows[0].completionTokens}`,
            )
            const charges = await client.query('select count(*)::int as n from usage_charges where "refId" = $1', [g.callId])
            assert(charges.rows[0].n === 1, `同一次调用挂了 ${charges.rows[0].n} 笔账——钱被重收了`)
          })
          const u = await readUsage()
          assert(u.prompt === 17 && u.completion === 5, `补正后的用量不对：${u.prompt}/${u.completion}`)
        })

        await test('模型中继：推理档由 Gateway 夹好，`xhigh` 不会原样打到上游', async () => {
          /**
           * `xhigh` / `max` 是 pi-ai 自己的抽象档，上游多数不认，原样打过去就是 400。
           * 以前挂在 /v1 上时这一夹是 pi-ai 顺手做的，下沉到中继之后归授权
           * （gateway/src/llm.ts 的 chatBodyPatch），管家只照着改。两种落法都要钉：
           * 这颗模型压根不会推理 → 整个字段删掉；会推理但认的档不到 xhigh → 夹到 high。
           */
          upSeen.length = 0
          const dumb = await req(mgrBase, 'POST', '/llm/v1/chat/completions', {
            token: apiKey,
            body: { ...chatBody, reasoning_effort: 'xhigh' },
          })
          assert(dumb.status === 200, `不会推理的模型 ${dumb.status} ${dumb.text.slice(0, 300)}`)
          const dumbBody = upLast()?.body || {}
          assert(!('reasoning_effort' in dumbBody), `模型不会推理，reasoning_effort 该整个删掉，实际 ${JSON.stringify(dumbBody.reasoning_effort)}`)

          upSeen.length = 0
          const smart = await req(mgrBase, 'POST', '/llm/v1/chat/completions', {
            token: apiKey,
            body: { ...chatBody, model: `${PROVIDER}/${THINK_MODEL}`, reasoning_effort: 'xhigh' },
          })
          assert(smart.status === 200, `会推理的模型 ${smart.status} ${smart.text.slice(0, 300)}`)
          const smartBody = upLast()?.body || {}
          assert(smartBody.reasoning_effort !== 'xhigh', 'xhigh 原样打到上游了——真上游会当场 400')
          assert(smartBody.reasoning_effort === 'high', `该夹到 high，实际 ${JSON.stringify(smartBody.reasoning_effort)}`)
        })

        await test('模型中继：responses 路由的推理档在 `reasoning.effort`，同样由 Gateway 夹好', async () => {
          /**
           * `api: 'openai-responses'` 的模型 Bot 改走 /v1/responses（gpt-5.6-sol 这一批在 chat
           * 口上「工具 + reasoning_effort」直接 400）。推理档换了个位置，夹法不能跟着丢：
           * 管家要把 `reasoning.effort` 报给授权，Gateway 的 responsesBodyPatch 按目录夹。
           */
          const resBody = { model: `${PROVIDER}/${MODEL}`, input: [{ role: 'user', content: 'hi' }], stream: true, store: false }
          upSeen.length = 0
          const dumb = await req(mgrBase, 'POST', '/llm/v1/responses', {
            token: apiKey,
            body: { ...resBody, reasoning: { effort: 'xhigh' } },
          })
          assert(dumb.status === 200, `不会推理的模型 ${dumb.status} ${dumb.text.slice(0, 300)}`)
          const dumbSeen = upLast()
          assert(dumbSeen?.path === '/v1/responses', `该打上游的 /v1/responses，实际 ${dumbSeen?.path}`)
          assert(!('reasoning' in (dumbSeen.body || {})), `模型不会推理，reasoning 该整个删掉，实际 ${JSON.stringify(dumbSeen.body?.reasoning)}`)

          upSeen.length = 0
          const smart = await req(mgrBase, 'POST', '/llm/v1/responses', {
            token: apiKey,
            body: { ...resBody, model: `${PROVIDER}/${THINK_MODEL}`, reasoning: { effort: 'xhigh' } },
          })
          assert(smart.status === 200, `会推理的模型 ${smart.status} ${smart.text.slice(0, 300)}`)
          const smartBody = upLast()?.body || {}
          assert(smartBody.reasoning?.effort === 'high', `该夹到 high，实际 ${JSON.stringify(smartBody.reasoning)}`)
          assert(!('provider' in smartBody) && smartBody.model === THINK_MODEL, `model/provider 没换：${smartBody.model} ${smartBody.provider}`)
        })

        await test('模型中继：抹密钥别把 application/json 一起抹了', async () => {
          /**
           * 抹密钥那条规矩曾经是「授权头里的值长到 16 个字符就抹」，而
           * `content-type: application/json` 里的 `application/json` 正好 16 个字符——
           * 于是模型答复里凡是提到它的地方（教人写 curl 的回答天天有）都成了
           * `[redacted]`，而且那是压在**成功**响应上、抹的是模型正文。
           *
           * 现在的规矩：成功的答复一个字不动；只有出错时才抹，抹的是这一次授权头里的
           * 那几个值（PUBLIC_HEADERS 里的除外）。两头都要钉。
           */
          upMode = 'json'
          try {
            upSeen.length = 0
            const ok = await req(mgrBase, 'POST', '/llm/v1/chat/completions', {
              token: apiKey,
              body: { model: `${PROVIDER}/${MODEL}`, messages: [{ role: 'user', content: 'hi' }] },
            })
            assert(ok.status === 200, `非流式成功 ${ok.status} ${ok.text.slice(0, 300)}`)
            assert(ok.text.includes('application/json'), `成功的正文被抹了：${ok.text.slice(0, 300)}`)
            assert(!ok.text.includes('[redacted]'), `成功的正文不该出现 [redacted]：${ok.text.slice(0, 300)}`)

            upMode = 'error'
            const bad = await req(mgrBase, 'POST', '/llm/v1/chat/completions', {
              token: apiKey,
              body: { model: `${PROVIDER}/${MODEL}`, messages: [{ role: 'user', content: 'hi' }] },
            })
            assert(bad.status === 400, `上游 4xx 该原样转 400，实际 ${bad.status} ${bad.text.slice(0, 300)}`)
            assert(!bad.text.includes('platform-key'), `上游回显的密钥漏给 Bot 了：${bad.text.slice(0, 300)}`)
            assert(bad.text.includes('[redacted]'), `密钥没被抹掉：${bad.text.slice(0, 300)}`)
            assert(bad.text.includes('application/json'), `同一段错误文本里的 application/json 被连累抹掉了：${bad.text.slice(0, 300)}`)
          } finally {
            upMode = 'stream'
          }
        })

        await test('模型中继：中继不了的那几家退回 Gateway 的 /v1，调用照样通', async () => {
          /**
           * 走 Anthropic 协议的模型被打到 chat 路由：Gateway 没法把一份 OpenAI body 改写成
           * Anthropic body，所以授权回 `409 {relayable:false}`——**这不是错，是「这条路我走
           * 不了」**。管家不把这个 409 摆给 Bot 看，而是把整通调用原样交回 Gateway 的 /v1，
           * 那正是中继出现之前它们走的路（底下 pi-ai 按 api 分发，这些全都认）。
           *
           * 内置目录里有九家 `api: 'anthropic-messages'` 但名字不叫 anthropic（minimax、
           * kimi-coding、fireworks、github-copilot…），其中四家**只**开这一条口。这条断言
           * 一旦松掉，它们一句话都说不出来。
           */
          // 先确认 Gateway 那头确实是按 409 + relayable:false 说这件事的。
          const grant = await req(gwBase, 'POST', '/worker/llm/grant', {
            token: machineTok,
            body: { apiKey, route: 'chat', model: `${ANTHRO_PROVIDER}/${ANTHRO_MODEL}` },
          })
          assert(grant.status === 409, `Anthropic 协议走 chat 路由该 409，实际 ${grant.status} ${grant.text}`)
          assert(grant.json && grant.json.relayable === false, `409 的正文该写 relayable:false：${grant.text}`)

          upSeen.length = 0
          const r = await req(mgrBase, 'POST', '/llm/v1/chat/completions', {
            token: apiKey,
            body: { model: `${ANTHRO_PROVIDER}/${ANTHRO_MODEL}`, messages: [{ role: 'user', content: 'hi' }], stream: true },
          })
          assert(r.status === 200, `退回 /v1 之后该照样通，实际 ${r.status} ${r.text.slice(0, 300)}`)
          assert(r.text.includes('"content":"ok"'), `没把上游那段 ok 带回来：${r.text.slice(0, 300)}`)
          assert(r.text.includes('data: [DONE]'), `流尾没有 [DONE]：${r.text.slice(-120)}`)
          assert(!r.text.includes('anthro-platform-key'), '密钥漏进了给 Bot 的响应')
          // 真的走到假上游了，而且打的是 Messages 协议那条路径。
          const up = upSeen.find((x) => String(x.path).includes('/anthropic/'))
          assert(up, `没打到 Anthropic 家的假上游：${JSON.stringify(upSeen.map((x) => x.path))}`)
          assert(String(up.path).endsWith('/v1/messages'), `打的路径是 ${up.path}`)
        })

        await test('/v1 的原生协议口按模型的 api 判路，不按供应商名字', async () => {
          /**
           * `/v1/responses` 和 `/v1/messages` 原先按 `found.provider` 的**名字**夹死成内置的
           * openai / anthropic。那道闸撤了（gateway/src/v1.ts）：地址和鉴权头现在都由
           * upstreamTargetOf 从**同一个** found 算出来，「拿 A 家的 key 打 B 家写死的地址」
           * 那条错配路不存在了；而按名字夹会把走 Anthropic 协议却不叫 anthropic 的那九家
           * （minimax、kimi-coding、fireworks、vercel-ai-gateway…）一律 400，中继那条路
           * （同一个 upstreamTargetOf）却放行——两条路对同一颗模型给两种答案。
           *
           * 留下的判据是**协议**。这条钉的就是它：两家都配了平台密钥，所以真的走得到那道
           * 闸（没密钥的话先撞上 402，协议这句话根本轮不到），措辞也一并钉住。
           * e2e/run.mjs 那条「无密钥 provider → 402」钉的是取密钥那一步，两条各管一段。
           */
          const wrongMessages = await req(gwBase, 'POST', '/v1/messages', {
            token: ownerTok,
            body: { model: `${PROVIDER}/${MODEL}`, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
          })
          assert(wrongMessages.status === 400, `OpenAI 系的模型打 /v1/messages 该 400，实际 ${wrongMessages.status} ${wrongMessages.text}`)
          assert(
            String(wrongMessages.json.error || '').includes('Anthropic'),
            `话没说清是协议对不上：${wrongMessages.text}`,
          )

          const wrongResponses = await req(gwBase, 'POST', '/v1/responses', {
            token: ownerTok,
            body: { model: `${ANTHRO_PROVIDER}/${ANTHRO_MODEL}`, input: 'hi' },
          })
          assert(wrongResponses.status === 400, `Anthropic 协议的模型打 /v1/responses 该 400，实际 ${wrongResponses.status} ${wrongResponses.text}`)
          assert(
            String(wrongResponses.json.error || '').includes('OpenAI'),
            `话没说清是协议对不上：${wrongResponses.text}`,
          )

          // 反过来：协议对得上就不该被名字挡住。`anthro-llm` 不叫 anthropic，但它走的就是
          // Messages 协议——这正是按名字夹会误伤的那九家。
          upSeen.length = 0
          const right = await req(gwBase, 'POST', '/v1/messages', {
            token: ownerTok,
            body: { model: `${ANTHRO_PROVIDER}/${ANTHRO_MODEL}`, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], stream: true },
          })
          assert(right.status === 200, `名字不叫 anthropic 但协议对得上，该放行，实际 ${right.status} ${right.text.slice(0, 300)}`)
          const up = upSeen.find((x) => String(x.path).includes('/anthropic/'))
          assert(up && String(up.path).endsWith('/v1/messages'), `没打到 Messages 那条路：${JSON.stringify(upSeen.map((x) => x.path))}`)
        })

        await test('模型中继：未结算清扫只收中继授权过的那一撮', async () => {
          /**
           * 清扫的判据里 `relayMachineId is not null` 这一条不能少（迁移 0040）。少了它，
           * 判据就只剩「够老 + 账本上没对应行」——而账本是 0007 才有的，0007 之前的历史
           * 调用条条命中，这条清扫会掉头去回填历史，每拍 200 行假账。docs/billing.md §11
           * 写死了「历史模型调用一行都不回填」。
           */
          const old = Date.now() - 6 * 3600_000
          await withPg(async (client) => {
            for (const [id, relay] of [['e2e-sweep-plain', null], ['e2e-sweep-relay', machineId]]) {
              await client.query(
                `insert into llm_calls (id,"accountId","companyId",provider,model,"promptTokens","completionTokens","cachedTokens","cacheWriteTokens","createdAt","relayMachineId")
                 values ($1,$2,$3,$4,$5,0,0,0,0,$6,$7)`,
                [id, adminId, orgId, PROVIDER, MODEL, old, relay],
              )
            }
          })
          const tick = await req(gwBase, 'GET', '/cron/tick', { token: CRON_SECRET })
          assert(tick.status === 200, `跑一拍 ${tick.status} ${tick.text}`)

          await withPg(async (client) => {
            const plain = await client.query('select id, status from usage_charges where "refId" = $1', ['e2e-sweep-plain'])
            assert(plain.rowCount === 0, `没经中继授权的老调用被回填了 ${plain.rowCount} 笔账——这就是「掉头刷历史」`)
            const relayed = await client.query('select status, "amountMicros", unpriced, "unitPrice" from usage_charges where "refId" = $1', ['e2e-sweep-relay'])
            assert(relayed.rowCount === 1, `中继授权过的那条该被收口成 1 行，实际 ${relayed.rowCount}`)
            const row = relayed.rows[0]
            assert(row.status === 'failed', `收口的账该记 failed，实际 ${row.status}`)
            assert(Number(row.amountMicros) === 0, `用量不知道就不该编钱，实际 ${row.amountMicros}`)
            /**
             * 金额是 0、`unpriced` 是 true，但**单价快照必须是齐的**。
             *
             * `unpriced` 只有一格，两种「算不出来」都写它：目录里没这个模型的价，和有价
             * 但没拿到用量。统计屏把它们分开报，靠的就是这份快照空不空
             * （routes/platform.ts 的 unpricedModels / unmeteredModels）。清扫图省事传
             * `cost: undefined` 的话，配着价的模型也会留下一份空快照，界面就会一口咬定
             * 「目录里没有单价」——人跑去配置页找一个并不存在的问题。
             */
            assert(row.unpriced === true, `用量不知道的那一行该标 unpriced，实际 ${row.unpriced}`)
            assert(
              Number(row.unitPrice?.input) === 1.5 && Number(row.unitPrice?.output) === 3,
              `清扫没把目录里的单价查出来，快照是 ${JSON.stringify(row.unitPrice)}`,
            )
          })
        })

        await test('模型中继：清扫按 0 元收下的那一行，管家回来时补成真的成交', async () => {
          /**
           * docs/billing.md §2.1 唯一的那条例外。**改的不是一笔成交价，是一行从来没成交过
           * 的占位**：一次跑过 30 分钟宽限期的长回答先被清扫按 0 元收了口，管家随后才带着
           * 真实用量回来。幂等一挡到底的话，这通真金白银发生过的调用账上永远是 0，而且事后
           * 补不回来——用量只存在于管家这一次回调里，错过就没了。
           *
           * 四件事一起钉：补得上（回 `filled`）、**不多挂一行账**、`createdAt` 不动（挪了
           * 这笔钱就换了账期）、以及补完之后**不许再被当成占位补第二遍**。
           */
          const before = await withPg(async (client) => {
            const r = await client.query('select "amountMicros", unpriced, "createdAt" from usage_charges where "refId" = $1', ['e2e-sweep-relay'])
            assert(r.rowCount === 1, `上一条用例应当留下一行占位，实际 ${r.rowCount}`)
            return r.rows[0]
          })
          assert(Number(before.amountMicros) === 0 && before.unpriced === true, `这不是一行占位：${JSON.stringify(before)}`)

          const filled = await req(gwBase, 'POST', '/worker/llm/e2e-sweep-relay/settle', {
            token: machineTok,
            body: { usage: { prompt_tokens: 1000, completion_tokens: 500, cached_tokens: 0, cache_write_tokens: 0 }, status: 'ok' },
          })
          assert(filled.status === 200, `补录 ${filled.status} ${filled.text}`)
          assert(filled.json.settled === true && filled.json.reason === 'filled', `该回 filled，实际 ${filled.text}`)

          await withPg(async (client) => {
            const r = await client.query(
              'select status, "amountMicros", "bonusMicros", unpriced, quantity, "createdAt" from usage_charges where "refId" = $1',
              ['e2e-sweep-relay'],
            )
            assert(r.rowCount === 1, `补录不许多挂一行账，实际 ${r.rowCount} 行`)
            const row = r.rows[0]
            assert(row.status === 'ok', `补完该是 ok，实际 ${row.status}`)
            assert(row.unpriced === false, '补完还标着 unpriced')
            // 目录价 $1.5 入 / $3 出，倍率 1：1000 × 1.5 + 500 × 3 = 3000 微元。
            assert(Number(row.amountMicros) === 3000, `金额 ${row.amountMicros} 微元，应当是 3000`)
            assert(Number(row.quantity?.promptTokens) === 1000 && Number(row.quantity?.completionTokens) === 500, `用量没补上：${JSON.stringify(row.quantity)}`)
            assert(Number(row.createdAt) === Number(before.createdAt), '补录把 createdAt 挪了——这笔钱会换一个账期')
            const call = await client.query('select "promptTokens", "completionTokens" from llm_calls where id = $1', ['e2e-sweep-relay'])
            assert(
              Number(call.rows[0].promptTokens) === 1000 && Number(call.rows[0].completionTokens) === 500,
              `llm_calls 那边没跟着补：${JSON.stringify(call.rows[0])}`,
            )
          })

          // 补完就是一笔真账了。**再来一次不许再补**——那才叫「一次调用只有一个金额」。
          const twice = await req(gwBase, 'POST', '/worker/llm/e2e-sweep-relay/settle', {
            token: machineTok,
            body: { usage: { prompt_tokens: 9, completion_tokens: 9, cached_tokens: 0, cache_write_tokens: 0 }, status: 'ok' },
          })
          assert(twice.status === 200 && twice.json.settled === false && twice.json.reason === 'already', `第二次该是 already，实际 ${twice.text}`)
          await withPg(async (client) => {
            const r = await client.query('select "amountMicros" from usage_charges where "refId" = $1', ['e2e-sweep-relay'])
            assert(r.rowCount === 1 && Number(r.rows[0].amountMicros) === 3000, `真账被第二次结算动过了：${JSON.stringify(r.rows)}`)
          })
        })

        await test('模型中继：机器票那道闸——无票 401、别家 403、坏钥匙 401、未知模型 404、没密钥 402', async () => {
          // 机器票那道闸：无票 401；别家席位的钥匙 403；坏钥匙 401；未知模型 404；没密钥的供应商 402。
          const noTok = await req(gwBase, 'POST', '/worker/llm/grant', { body: { apiKey, route: 'chat', model: `${PROVIDER}/${MODEL}` } })
          assert(noTok.status === 401, `无机器票该 401，实际 ${noTok.status}`)
          const badKey = await req(gwBase, 'POST', '/worker/llm/grant', { token: machineTok, body: { apiKey: 'sk_sw_nope', route: 'chat', model: `${PROVIDER}/${MODEL}` } })
          assert(badKey.status === 401, `坏钥匙该 401，实际 ${badKey.status} ${badKey.text}`)
          const foreign = await req(gwBase, 'POST', '/worker/llm/grant', { token: machineTok, body: { apiKey: strangerKey, route: 'chat', model: `${PROVIDER}/${MODEL}` } })
          assert(foreign.status === 403, `别家席位该 403，实际 ${foreign.status} ${foreign.text}`)
          const noModel = await req(gwBase, 'POST', '/worker/llm/grant', { token: machineTok, body: { apiKey, route: 'chat', model: `${PROVIDER}/nope` } })
          assert(noModel.status === 404, `未知模型该 404，实际 ${noModel.status} ${noModel.text}`)
          await req(gwBase, 'DELETE', `/platform/credentials/${PROVIDER}`, { token: ownerTok })
          const noSecret = await req(gwBase, 'POST', '/worker/llm/grant', { token: machineTok, body: { apiKey, route: 'chat', model: `${PROVIDER}/${MODEL}` } })
          assert(noSecret.status === 402, `没密钥该 402，实际 ${noSecret.status} ${noSecret.text}`)
          const relayNoSecret = await req(mgrBase, 'POST', '/llm/v1/chat/completions', { token: apiKey, body: chatBody })
          assert(relayNoSecret.status === 402, `管家那头没密钥也该 402 转回来，实际 ${relayNoSecret.status} ${relayNoSecret.text.slice(0, 200)}`)
        })

        await test('模型中继：席位的 bot.env 会多一行 GATEWAY_LLM_URL 指向管家回环', async () => {
          // dryRun 不跑 deploy-seat.sh，bot.env 不会真的写出来；能钉的是「脚本写这一行」和
          // 「管家把回环地址按自己的口传给脚本」这两半，真机上合起来就是那一行。
          const script = readFileSync(join(managerRoot, 'src', 'seat', 'deploy-seat.sh'), 'utf8')
          assert(/^GATEWAY_LLM_URL=\$MANAGER_LLM_URL$/m.test(script), 'deploy-seat.sh 没把 GATEWAY_LLM_URL 写进 bot.env')
          const seats = readFileSync(join(managerRoot, 'src', 'seats.ts'), 'utf8')
          assert(seats.includes('MANAGER_LLM_URL: `http://127.0.0.1:${bootConfig().port}/llm`'), 'seats.ts 没把 http://127.0.0.1:<port>/llm 传给部署脚本')
        })
      } finally {
        await closeServer(upstream, '模型中继假上游')
        // 补的那行席位删掉：后面「注销」那条要看真管家自己拆的是它名册里的席位。
        await withPg((client) => client.query('delete from seat_runtimes where "machineId" = $1 and "seatId" = $2', [machineId, 'seat-llm'])).catch(() => {})
      }
    }

    await test('配对码一次性：同一个码换不了第二把票', async () => {
      const r = await req(gwBase, 'POST', '/machines/pair', {
        body: { code, managerPort: MGR_PORT, protocol: 1 },
      })
      assert(r.status === 401, `重放 ${r.status}`)
    })

    // **这一条放最后**：它把真管家注销掉了，之后那台机器就不再听话了。
    await test('注销：平台移除之后，管家自己拆席位、清配对、回执', async () => {
      // 前面那条 DELETE 测的是 Gateway 半边（墓碑、心跳带信、回执删行），用的是假机器。
      // 这一条测的是**另外半边**：真管家进程收到 removed 之后到底做不做事。两边各自
      // 看着都对、合起来不通，是这类握手最常见的坏法。
      const machineId = await machineIdOf(req, gwBase, ownerTok, orgId)

      /**
       * **先确认它此刻还在。**
       *
       * 下面那条断言只看「文件在不在」，而「不在」有两个原因：管家真的注销了，或者
       * 它压根就没被写出来 / 早被别的东西端了。少了这一句，后一种情况下「清掉了」
       * 照样绿，红的会变成后面那条回执——现场于是长成「管家清了配对却没发注销回执」，
       * 而回执在 standDown 里排在 `rmSync(statePath())` **之前**，这个组合按管家的
       * 代码根本不可能出现。查的人会一路去翻 standDown 里那段顺序，翻不出东西来。
       *
       * 拿它当前置条件写，这一类现场当场红在这里，而且消息直说是现场不对。
       */
      const stateFile = join(MGR_HOME, 'manager.json')
      assert(existsSync(stateFile), `移除之前 ${stateFile} 就已经没了——现场被别的东西动过，后面的断言都不作数`)

      const del = await req(gwBase, 'DELETE', `/platform/machines/${machineId}`, { token: ownerTok })
      assert(del.status === 200, `移除 ${del.status} ${del.text}`)
      assert(del.json.pending === true, `管家在线，该等它收信，实际 pending=${del.json.pending}`)

      // 管家最多 30 秒一轮心跳，给它两轮的余量。
      let cleared = false
      for (let i = 0; i < 140; i++) {
        if (!existsSync(stateFile)) {
          cleared = true
          break
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      assert(cleared, '管家没有清掉 manager.json——重启回来它还会去敲一个不认识它的 Gateway')

      // 回执到了，那一行才真的没。墓碑 TTL 是兜底，不该是常规路径。
      const { createRequire } = await import('node:module')
      const require = createRequire(new URL('../gateway/package.json', import.meta.url))
      const pg = require('pg')
      const client = new pg.Client({ connectionString: PG_URL })
      await client.connect()
      try {
        await client.query(`set search_path to ${SCHEMA}`)
        let rows = 1
        for (let i = 0; i < 20; i++) {
          rows = (await client.query('select 1 from machines where id = $1', [machineId])).rowCount
          if (!rows) break
          await new Promise((r) => setTimeout(r, 500))
        }
        assert(rows === 0, '管家没回执，或者 Gateway 收到回执没删行')
      } finally {
        await client.end().catch(() => {})
      }
    })
  } finally {
    gw.kill()
    mgr?.kill()
    await closeServer(bot.server, 'bot 替身')
    await closeServer(novnc.server, 'noVNC 替身')
    rmSync(GW_HOME, { recursive: true, force: true })
    rmSync(MGR_HOME, { recursive: true, force: true })
  }
}

async function machineIdOf(req, gwBase, ownerTok, orgId) {
  const m = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
  return m.json.machine.id
}

/** 弄一张桌面票。走 owner 的支持入口——它就是为「替员工打开桌面」存在的。 */
async function mintTicket(gwBase, ownerTok) {
  const r = await fetch(`${gwBase}/platform/desktop-ticket?seatId=seat-1`, {
    headers: { authorization: 'Bearer ' + ownerTok },
  })
  if (!r.ok) throw new Error(`签票失败 ${r.status} ${await r.text()}`)
  return (await r.json()).ticket
}

/**
 * 自己签一张**带 VNC 口令**的桌面票。
 *
 * 为什么不走 /platform/desktop-ticket：那个接口只按 seatId 签，拿不到口令——真正带口令
 * 的是「打开桌面」那条路（desktopTicketFor），而它要求 Gateway 库里有这个席位的
 * seat_runtimes 行。本套件的 seat-1 是管家侧登记的假席位，Gateway 那边没有。
 *
 * 所以直接用 Gateway 落盘的私钥签一张，形状和 signDesktopTicket 完全一致。验的是管家
 * 那半边：**票里带了口令，落地页就该把它交给 noVNC**。
 */
function mintTicketWithPassword(gwHome, seatId, vnc) {
  const priv = readFileSync(join(gwHome, 'keys', 'jwt-private.pem'), 'utf8')
  const pub = readFileSync(join(gwHome, 'keys', 'jwt-public.pem'), 'utf8')
  const kid = createHash('sha256').update(pub).digest('hex').slice(0, 16)
  const now = Math.floor(Date.now() / 1000)
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const h = b64({ alg: 'RS256', typ: 'JWT', kid })
  const p = b64({ typ: 'satu-desktop', seatId, iat: now, exp: now + 300, vnc })
  return `${h}.${p}.${sign('sha256', Buffer.from(`${h}.${p}`), priv).toString('base64url')}`
}
