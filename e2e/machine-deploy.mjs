/**
 * 公司机器绑定 + 席位 stub 部署。独立 home / 端口，不碰 live 3080。
 */
import { createHash } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { join } from 'node:path'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'

/** 这一套自己的 schema。写死名字会被别的 worktree 的 e2e 清掉（见 pg.mjs 的 schemaOf）。 */
const SCHEMA = schemaOf('e2e_machine')
import { createCompany } from './org.mjs'
import { publishRelease, sha256Of, tarGz } from './release.mjs'
import { freePort } from './ports.mjs'
import { closeServer, withDeadline } from './probe.mjs'

/** 一个员工一个 Linux 账号——名下所有 bot 共用它。和 gateway/src/deploy.ts 保持一致。 */
function linuxUserOf(accountId) {
  return 'sw-' + createHash('sha256').update(accountId).digest('hex').slice(0, 12)
}

/** 席位标识：systemd 实例名与席位私有目录名。一个 bot 一个。 */
function seatIdOf(accountId, botId) {
  return linuxUserOf(accountId) + '-' + createHash('sha256').update(botId).digest('hex').slice(0, 12)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 手写一次 WebSocket 升级。不引 ws：要验的是**反代把这一跳接没接对**，不是握手协议
 * 本身；裸 socket 反而看得见回来的原始状态行。
 */
function wsUpgrade(port, path, cookie) {
  return new Promise((ok, bad) => {
    const sock = connect(port, '127.0.0.1', () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${Buffer.from('satuwork-e2e-key').toString('base64')}\r\nSec-WebSocket-Version: 13\r\n` +
          (cookie ? `Cookie: ${cookie}\r\n` : '') +
          '\r\n',
      )
    })
    let out = ''
    sock.on('data', (b) => {
      out += b.toString('utf8')
      if (out.includes('HELLO-WS') || out.length > 512) {
        sock.destroy()
        ok(out)
      }
    })
    sock.on('error', bad)
    sock.on('close', () => ok(out))
    setTimeout(() => {
      sock.destroy()
      ok(out)
    }, 3000)
  })
}

export async function runMachineDeploy({ gwRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = tmpOf('satuwork-e2e-machine-gw')
  const GW_PORT = await freePort()
  /**
   * 假管家们听的口也向内核要。8443 / 8544-8546 这几个写死的数以前在两个 worktree
   * 同时跑时必撞，而撞上的现象是「配对回拨到了别人的假管家」——断言报的东西和端口
   * 毫无关系。MGR_PORT 是配对时记下的那台「主机器」，桌面反代那条用例要在它上面起
   * 假管家；另外三条各自要一个，端口跟着传进 managerPort。
   */
  const MGR_PORT = await freePort()
  const MACHINE_TOK = 'e2e-machine-deploy'
  const PLATFORM_TOK = 'e2e-platform-deploy'
  const gwBase = `http://127.0.0.1:${GW_PORT}`
  let machineTok = ''

  rmSync(GW_HOME, { recursive: true, force: true })
  log('\n# machine-deploy')

  const gw = start('machine-gw', ['--import', 'tsx', join(gwRoot, 'src/index.ts')], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: SCHEMA,
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_MACHINE_TOKEN: MACHINE_TOK,
      GATEWAY_PLATFORM_TOKEN: PLATFORM_TOK,
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '1',
      GATEWAY_OWNER_EMAIL: 'owner@machine.test',
      GATEWAY_OWNER_PASSWORD: 'test-owner-machine',
      SATUWORK_DEPLOY_STUB: '1',
    },
  })
  // 带上 child：起不来时有用的是它的输出，不是三十秒后那句「等不到」。
  await waitHttp(gwBase + '/health', { child: gw, what: 'machine-deploy gateway' })

  try {
    const ownerLogin = await req(gwBase, 'POST', '/auth/login', {
      body: { email: 'owner@machine.test', password: 'test-owner-machine' },
    })
    assert(ownerLogin.status === 200, `owner ${ownerLogin.status} ${ownerLogin.text}`)
    const ownerTok = ownerLogin.json.token

    const reg = await createCompany(req, gwBase, {
      ownerToken: ownerTok,
      email: 'admin@machine.test',
      password: 'correct-horse',
      companyName: 'MachineCo',
      slug: 'machineco',
      seats: 3,
    })
    const adminTok = reg.token
    const orgId = reg.company.id

    const m1 = await req(gwBase, 'POST', `/orgs/${orgId}/accounts`, {
      token: adminTok,
      body: { email: 'member1@machine.test', password: 'correct-horse', role: 'member' },
    })
    assert(m1.status === 201, `member1 ${m1.status} ${m1.text}`)
    const memberId = m1.json.account.id
    const memberLogin = await req(gwBase, 'POST', '/auth/login', {
      body: { email: 'member1@machine.test', password: 'correct-horse' },
    })
    assert(memberLogin.status === 200, `member1 login ${memberLogin.status}`)
    const memberTok = memberLogin.json.token

    const m2 = await req(gwBase, 'POST', `/orgs/${orgId}/accounts`, {
      token: adminTok,
      body: { email: 'member2@machine.test', password: 'correct-horse', role: 'member' },
    })
    assert(m2.status === 201, `member2 ${m2.status} ${m2.text}`)
    const otherLogin = await req(gwBase, 'POST', '/auth/login', {
      body: { email: 'member2@machine.test', password: 'correct-horse' },
    })
    assert(otherLogin.status === 200, `member2 login ${otherLogin.status}`)
    const otherTok = otherLogin.json.token
    const member2Id = m2.json.account.id

    /**
     * 这两个用**全局 Bot**：下面要验的是「两个人部署同一个 botId，各自拿到不同的
     * linuxUser 和槽」，而员工自己建的 Bot 只有本人看得见，天然没有「同一个 botId」
     * 这回事。全局 Bot 是所有人都用得上的那一种，正合适。
     */
    const botARes = await req(gwBase, 'POST', '/platform/bots', {
      token: ownerTok,
      body: { name: '席位 Bot A' },
    })
    assert(botARes.status === 201, `botA ${botARes.status} ${botARes.text}`)
    const botA = botARes.json.bot.id
    const botBRes = await req(gwBase, 'POST', '/platform/bots', {
      token: ownerTok,
      body: { name: '席位 Bot B' },
    })
    assert(botBRes.status === 201, `botB ${botBRes.status} ${botBRes.text}`)
    const botB = botBRes.json.bot.id

    await test('POST /runtime/deploy 没有 botId → 400', async () => {
      const r = await req(gwBase, 'POST', '/runtime/deploy', { token: memberTok, body: {} })
      assert(r.status === 400, `deploy ${r.status} ${r.text}`)
    })

    await test('成员未绑机器 POST /runtime/deploy → 409', async () => {
      const r = await req(gwBase, 'POST', '/runtime/deploy', { token: memberTok, body: { botId: botA } })
      assert(r.status === 409, `deploy ${r.status} ${r.text}`)
      assert(String(r.json.error || r.text).includes('运行机器'), '409 文案')
    })

    await test('owner GET 成员 runtime 部署前 → 空数组', async () => {
      const r = await req(gwBase, 'GET', `/platform/orgs/${orgId}/accounts/${memberId}/runtime`, { token: ownerTok })
      assert(r.status === 200, `runtime ${r.status} ${r.text}`)
      assert(Array.isArray(r.json.runtimes) && r.json.runtimes.length === 0, 'empty runtimes')
    })

    await test('配对：owner 出码，机器换 smt_，一次性', async () => {
      // 还没配对时不给改地址——地址是配对的产物，不是配对的前提。
      const early = await req(gwBase, 'PUT', `/platform/orgs/${orgId}/machine`, {
        token: ownerTok,
        body: { host: 'http://10.8.0.21:8443' },
      })
      assert(early.status === 409, `edit before pair ${early.status} ${early.text}`)

      const code = await req(gwBase, 'POST', `/platform/orgs/${orgId}/pairing-code`, { token: ownerTok })
      assert(code.status === 201, `code ${code.status} ${code.text}`)
      assert(/^SW-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code.json.code), `码格式 ${code.json.code}`)
      assert(code.json.expiresAt > Date.now(), '码已过期')
      assert(String(code.json.installCommand).includes('/install-manager.sh'), '安装命令')
      assert(String(code.json.installCommand).includes(code.json.code), '安装命令要带码')

      const bad = await req(gwBase, 'POST', '/machines/pair', {
        body: { code: 'SW-0000-0000', managerPort: MGR_PORT, protocol: 1 },
      })
      assert(bad.status === 401, `坏码 ${bad.status}`)

      // 码是照着屏幕手抄到另一台机器上的，所以生成端不产 S/Z/B/O/I/L，收端把它们
      // 纠回对应数字。**前缀 SW- 里就有一个 S**，纠错只能作用在随机那一段。
      assert(!/[SZBOIL]/.test(code.json.code.slice(3)), `码里有易混字符 ${code.json.code}`)
      const typo = code.json.code.slice(3).replace(/5/g, 'S').replace(/2/g, 'Z').replace(/8/g, 'B')
      const fuzzy = await req(gwBase, 'POST', '/machines/pair', {
        body: { code: 'sw-' + typo.toLowerCase(), managerPort: MGR_PORT, hostname: 'e2e', managerVersion: '9.9.9', protocol: 1 },
      })
      assert(fuzzy.status === 201, `抄错字符也该认出来：${fuzzy.status} ${fuzzy.text}`)
      machineTok = fuzzy.json.token

      // 上面那次已经把码用掉了，后面的重放断言仍然成立；这里补配一次拿到干净状态。
      const code1b = await req(gwBase, 'POST', `/platform/orgs/${orgId}/pairing-code`, { token: ownerTok })
      assert(code1b.status === 201, 'code1b')

      const paired = await req(gwBase, 'POST', '/machines/pair', {
        body: { code: code1b.json.code, managerPort: MGR_PORT, hostname: 'e2e', managerVersion: '9.9.9', protocol: 1 },
      })
      assert(paired.status === 201, `pair ${paired.status} ${paired.text}`)
      assert(String(paired.json.token).startsWith('smt_'), 'smt_')
      // 地址取的是请求来源 IP，不是 body 里说的——body 说了不算。
      assert(paired.json.host === `http://127.0.0.1:${MGR_PORT}`, `host ${paired.json.host}`)
      // e2e 里没有管家在听，回拨必然失败；配对本身照样成立。
      assert(paired.json.reachable === false, 'reachable 应为 false')
      machineTok = paired.json.token

      const replay = await req(gwBase, 'POST', '/machines/pair', {
        body: { code: code1b.json.code, managerPort: MGR_PORT, protocol: 1 },
      })
      assert(replay.status === 401, `重放 ${replay.status}`)

      const get = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      assert(get.status === 200, `get ${get.status} ${get.text}`)
      assert(get.json.machine.paired === true, 'paired')
      assert(get.json.machine.managerVersion === '9.9.9', 'managerVersion')
      assert(get.json.machine.protocolTooOld === false, 'protocolTooOld')
      assert(String(get.json.machine.token).startsWith('smt_'), 'owner GET 应带 smt_')
      const dumped = JSON.stringify(get.json)
      for (const k of ['sshSecret', 'sshHost', 'sshUser', 'sshAuth']) {
        assert(!dumped.includes(k), `机器 JSON 仍含 ${k}`)
      }
    })

    await test('owner 不能 POST /runtime/deploy 也不能 GET /runtime/desktop', async () => {
      const r = await req(gwBase, 'POST', '/runtime/deploy', { token: ownerTok, body: { botId: botA } })
      assert(r.status === 403, `owner deploy ${r.status} ${r.text}`)
      const d = await req(gwBase, 'GET', '/runtime/desktop?botId=' + encodeURIComponent(botA), { token: ownerTok })
      assert(d.status === 403, `owner desktop ${d.status} ${d.text}`)
    })

    await test('部署前没有发布版本 → 409 还没有发布 Bot 版本', async () => {
      const r = await req(gwBase, 'POST', '/runtime/deploy', { token: memberTok, body: { botId: botA } })
      assert(r.status === 409, `deploy ${r.status} ${r.text}`)
      assert(String(r.json.error || r.text).includes('还没有发布 Bot 版本'), '409 文案')
    })

    await test('上传 0.1.0；GET 列表最新', async () => {
      const { release: rel } = await publishRelease({ req, gwBase, token: ownerTok, version: '0.1.0', note: 'e2e' })
      assert(rel.version === '0.1.0', 'version')
      assert(typeof rel.sha256 === 'string' && rel.sha256.length === 64, 'sha256')
      assert(typeof rel.size === 'number' && rel.size > 0, 'size')
      const list = await req(gwBase, 'GET', '/platform/bot-releases', { token: ownerTok })
      assert(list.status === 200, `list ${list.status} ${list.text}`)
      assert(list.json.latest === '0.1.0', `latest ${list.json.latest}`)
      assert(list.json.releases[0]?.version === '0.1.0', 'releases newest')
      assert(list.text.length < 100_000, 'list 太大，可能含文件字节')
    })

    await test('stub 部署 botA：linuxUser/seatId/slot 0 端口公式，无 CDP', async () => {
      const r = await req(gwBase, 'POST', '/runtime/deploy', { token: memberTok, body: { botId: botA } })
      assert(r.status === 200, `deploy ${r.status} ${r.text}`)
      const expectedUser = linuxUserOf(memberId)
      assert(r.json.botId === botA, `botId ${r.json.botId}`)
      assert(r.json.linuxUser === expectedUser, `linuxUser ${r.json.linuxUser} != ${expectedUser}`)
      assert(r.json.seatId === seatIdOf(memberId, botA), `seatId ${r.json.seatId}`)
      assert(r.json.sharedDir === `/home/${expectedUser}/work`, `sharedDir ${r.json.sharedDir}`)
      assert(r.json.status === 'ready', `status ${r.json.status}`)
      assert(r.json.botVersion === '0.1.0', `botVersion ${r.json.botVersion}`)
      assert(typeof r.json.vncPassword === 'string' && r.json.vncPassword.length === 16, 'vncPassword 16')
      // 桌面地址是 **Gateway 同域**的一条路径，不是管家的地址：那块屏内嵌在 iframe 里，
      // 跨站的话 SameSite=Lax 的 cookie 连存都不给存（见 gateway/src/desktop.ts）。
      assert(
        String(r.json.novncUrl).startsWith(`/desktop/${r.json.seatId}/?ticket=`),
        `novncUrl ${r.json.novncUrl}`,
      )
      assert(!String(r.json.novncUrl).includes(`127.0.0.1:${MGR_PORT}`), `桌面地址不该指向管家：${r.json.novncUrl}`)
      assert(r.json.display === 10, `display ${r.json.display}`)
      assert(r.json.vncPort === 5910, `vncPort ${r.json.vncPort}`)
      assert(r.json.novncPort === 6081, `novncPort ${r.json.novncPort}`)
      assert(!Object.prototype.hasOwnProperty.call(r.json, 'botPort'), '员工 JSON 不应含 botPort')
      assert(!Object.prototype.hasOwnProperty.call(r.json, 'slot'), '员工 JSON 不应含 slot')
      assert(!r.json.ports || r.json.ports.botPort == null, 'ports.botPort')
      assert(r.json.cdpPort == null, '员工 JSON 不应含 CDP 端口')
      assert(!r.json.ports || r.json.ports.cdpPort == null, 'ports 含 CDP')
      assert(!JSON.stringify(r.json).includes('smt_'), 'deploy 响应泄漏机器票')
      assert(!JSON.stringify(r.json).includes('sshSecret'), 'deploy 含 sshSecret')
    })

    await test('席位那台机器通不通，名册里说得出来——而 status 照样是 ready', async () => {
      /**
       * 病灶就在这两个字段的差别上：`status` 是「上一次部署走到哪一步了」，落库之后就
       * 不动了。机器断电、网线拔了、管家挂了，它照样写着 `ready`——于是平台那一页的灯
       * 已经打成「失联」，员工手上那颗 Bot 还挂着「在线」，点发送没有任何反应。
       *
       * 所以名册里要另给一格通联状态，判据和平台那盏灯**同一份**（machineLink：心跳
       * 有多久没来了），而不是让界面拿部署状态去猜。
       */
      const listOf = async () => {
        const r = await req(gwBase, 'GET', '/runtime/bots', { token: memberTok })
        assert(r.status === 200, `bots ${r.status} ${r.text}`)
        return r.json.bots.find((b) => b.id === botA)
      }

      // 这台机器配过对，但一次心跳都没来过（e2e 里没有真管家在听）→ 失联。
      const cold = await listOf()
      assert(cold && cold.runtime, '席位铺好了，名册里却没给出 runtime')
      assert(cold.runtime.status === 'ready', `部署状态该是 ready，实际 ${cold.runtime.status}`)
      assert(cold.runtime.machineLink === 'offline', `没心跳过该是 offline，得到 ${cold.runtime.machineLink}`)
      assert(cold.runtime.machineHeartbeatAge === null, `没心跳过不该给年龄：${cold.runtime.machineHeartbeatAge}`)

      // 心跳一来就该变。**不用另建一条接口**：界面每半分钟重拉一次这份名册（见
      // startSeatWatch），那盏灯跟着它走。
      const machineId = (await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })).json.machine
        .id
      const hb = await req(gwBase, 'POST', `/internal/machines/${machineId}/heartbeat`, {
        token: machineTok,
        body: { managerVersion: 'e2e', protocol: 1, seats: [] },
      })
      assert(hb.status === 200, `heartbeat ${hb.status} ${hb.text}`)

      const warm = await listOf()
      assert(warm.runtime.machineLink === 'online', `刚心跳过该是 online，得到 ${warm.runtime.machineLink}`)
      assert(
        warm.runtime.machineHeartbeatAge != null && warm.runtime.machineHeartbeatAge < 5000,
        `年龄不对：${warm.runtime.machineHeartbeatAge}`,
      )
    })

    await test('从机器页重铺一个席位：走公司那条 deploy，force 真的重铺', async () => {
      // 机器详情页那颗「重新部署」按下去就是这一条。**不另开平台接口**：这条已经做完了
      // 全部的事（挑机器、算槽位、下发、落库、写审计），owner 过 requireOrg 是直接放行的。
      const before = await req(gwBase, 'GET', '/runtime/desktop?botId=' + botA, { token: memberTok })
      const r = await req(gwBase, 'POST', `/orgs/${orgId}/accounts/${memberId}/deploy`, {
        token: ownerTok,
        body: { botId: botA, force: true },
      })
      assert(r.status === 200, `owner 重铺 ${r.status} ${r.text}`)
      assert(r.json.status === 'ready', `重铺之后 ${r.json.status}`)
      assert(r.json.deployedAt > before.json.deployedAt, 'deployedAt 没动，等于什么都没发生')
      // 重铺是「照现状再来一遍」，不是升级——版本不该被顺手换掉。
      assert(r.json.botVersion === before.json.botVersion, `版本被换了：${before.json.botVersion} → ${r.json.botVersion}`)
    })

    await test('照现状重铺整台机器：不带版本也推得动，每个席位各留各的版本', async () => {
      /**
       * 这一档要的是「版本没错，配置旧了」：席位的 bot.env 是部署那一刻写死的，Gateway
       * 换了对外地址之后那一份还指着旧地址，而版本号一个字都没变——升级那条路在这种
       * 时候什么都不做（界面上连按钮都不画）。重铺让部署脚本整份重写 bot.env。
       */
      const machineId = (await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })).json.machine.id
      const before = await req(gwBase, 'GET', '/runtime/desktop?botId=' + botA, { token: memberTok })
      const r = await req(gwBase, 'POST', `/platform/machines/${machineId}/runtime/update`, {
        token: ownerTok,
        body: { force: true },
      })
      assert(r.status === 200, `重铺 ${r.status} ${r.text}`)
      assert(r.json.force === true, `没认出这是重铺：${r.text.slice(0, 200)}`)
      // 重铺没有「统一的那个版本」。报一个就是在暗示所有席位都变成了它。
      assert(r.json.version === null, `重铺不该报一个统一版本：${r.json.version}`)
      assert(r.json.results.length >= 1, `一个席位都没推：${r.text.slice(0, 200)}`)
      const after = await req(gwBase, 'GET', '/runtime/desktop?botId=' + botA, { token: memberTok })
      assert(after.json.botVersion === before.json.botVersion, `重铺换了版本：${before.json.botVersion} → ${after.json.botVersion}`)
      assert(after.json.deployedAt > before.json.deployedAt, '整台重铺之后 deployedAt 没动')
    })

    await test('机器详情说得出「重铺会往席位里写哪个 Gateway 地址」', async () => {
      // 那一格不是装饰：席位靠这个地址拉目录、调模型、上报上线，而它来自 Gateway 进程的
      // GATEWAY_PUBLIC_URL。没配时会回落成 GATEWAY_HOST:GATEWAY_PORT（多半是 127.0.0.1），
      // 按下重铺就是把一个打不通的地址写死进席位——所以「这是猜的」必须说出来。
      const machineId = (await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })).json.machine.id
      const d = await req(gwBase, 'GET', `/platform/machines/${machineId}`, { token: ownerTok })
      assert(d.status === 200, `详情 ${d.status} ${d.text}`)
      assert(
        typeof d.json.seatGatewayUrl === 'string' && d.json.seatGatewayUrl.startsWith('http'),
        `没给出将写入的地址：${JSON.stringify(d.json.seatGatewayUrl)}`,
      )
      assert(d.json.seatGatewayUrlConfigured === false, '这个套件没配 GATEWAY_PUBLIC_URL，界面必须说这是猜的')
    })

    await test('已经 ready 就跳过；但 force 必须真的重铺一遍', async () => {
      // 「已经是这个版本、而且好着 → 不重装」是对的，可它把「重新部署」这个自助手段
      // 也一起挡掉了：接口回 200 和 ready，deployedAt 一秒没动，什么都没发生。
      // 而人按那个按钮的时候，要的恰恰是「版本没错、状态也 ready，但机器上就是不对，
      // 重新铺一遍」——VNC 口令没同步、dock 少一格、桌面服务还是老进程，全长这样。
      const before = await req(gwBase, 'GET', '/runtime/desktop?botId=' + botA, { token: memberTok })
      assert(before.status === 200, `desktop ${before.status}`)
      const at0 = before.json.deployedAt

      const skipped = await req(gwBase, 'POST', '/runtime/deploy', { token: memberTok, body: { botId: botA } })
      assert(skipped.status === 200, `再部署 ${skipped.status}`)
      assert(skipped.json.deployedAt === at0, '没带 force 时该跳过，deployedAt 不该动')

      const forced = await req(gwBase, 'POST', '/runtime/deploy', { token: memberTok, body: { botId: botA, force: true } })
      assert(forced.status === 200, `force 部署 ${forced.status} ${forced.text}`)
      assert(forced.json.status === 'ready', `force 之后 ${forced.json.status}`)
      assert(forced.json.deployedAt !== at0, `force 没真的重铺：deployedAt 仍是 ${at0}`)
      // 口令不能因为重铺就换掉——换了的话，界面上显示的和机器上的又对不上了。
      assert(forced.json.vncPassword === before.json.vncPassword, 'force 不该换 VNC 口令')
      assert(forced.json.seatId === before.json.seatId, 'force 不该换席位')
    })

    // 同一员工的第二个 bot：**账号相同**（共享文件靠这个），席位不同（屏、目录、单元靠这个）。
    await test('同一成员部署 botB → 同一 linuxUser、不同 seatId、下一槽', async () => {
      const r = await req(gwBase, 'POST', '/runtime/deploy', { token: memberTok, body: { botId: botB } })
      assert(r.status === 200, `deploy B ${r.status} ${r.text}`)
      const expectedUser = linuxUserOf(memberId)
      assert(r.json.botId === botB, 'botId B')
      assert(r.json.linuxUser === expectedUser, `linuxUser ${r.json.linuxUser} != ${expectedUser}`)
      assert(r.json.seatId === seatIdOf(memberId, botB), `seatId ${r.json.seatId}`)
      assert(r.json.seatId !== seatIdOf(memberId, botA), 'botB 撞了 botA seatId')
      assert(r.json.sharedDir === `/home/${expectedUser}/work`, 'botB 应与 botA 共享同一个工作区')
      assert(r.json.display === 11, `display ${r.json.display}`)
      assert(r.json.vncPort === 5911, `vncPort ${r.json.vncPort}`)
      assert(r.json.novncPort === 6082, `novncPort ${r.json.novncPort}`)
      assert(!Object.prototype.hasOwnProperty.call(r.json, 'botPort'), 'botB botPort')
      assert(typeof r.json.vncPassword === 'string' && r.json.vncPassword.length === 16, 'vncPassword 16')
      assert(r.json.cdpPort == null, 'botB CDP')
    })

    await test('member2 部署 botA → 不同 linuxUser/槽', async () => {
      const r = await req(gwBase, 'POST', '/runtime/deploy', { token: otherTok, body: { botId: botA } })
      assert(r.status === 200, `member2 deploy ${r.status} ${r.text}`)
      const expectedUser = linuxUserOf(member2Id)
      assert(r.json.linuxUser === expectedUser, `linuxUser ${r.json.linuxUser}`)
      assert(r.json.linuxUser !== linuxUserOf(memberId), '撞 member1 的账号')
      assert(r.json.seatId === seatIdOf(member2Id, botA), `seatId ${r.json.seatId}`)
      assert(r.json.seatId !== seatIdOf(memberId, botA), '撞 member1 botA 席位')
      assert(r.json.sharedDir !== `/home/${linuxUserOf(memberId)}/work`, '两名员工共享了同一个工作区')
      assert(r.json.display === 12, `display ${r.json.display}`)
      assert(r.json.vncPort === 5912, `vncPort ${r.json.vncPort}`)
      assert(r.json.novncPort === 6083, `novncPort ${r.json.novncPort}`)
      assert(!Object.prototype.hasOwnProperty.call(r.json, 'botPort'), 'member2 botPort')
    })

    await test('GET /runtime/desktop?botId= 本人能看到同一份密码', async () => {
      const r = await req(gwBase, 'GET', '/runtime/desktop?botId=' + encodeURIComponent(botA), { token: memberTok })
      assert(r.status === 200, `desktop ${r.status} ${r.text}`)
      assert(r.json.linuxUser === linuxUserOf(memberId), 'linuxUser')
      assert(r.json.seatId === seatIdOf(memberId, botA), 'seatId')
      assert(r.json.botId === botA, 'botId')
      assert(r.json.vncPassword && r.json.vncPassword.length === 16, 'vncPassword')
      assert(String(r.json.novncUrl).startsWith(`/desktop/${r.json.seatId}/?ticket=`), 'novncUrl 要带票')
      const miss = await req(gwBase, 'GET', '/runtime/desktop', { token: memberTok })
      assert(miss.status === 400, `desktop no botId ${miss.status}`)
      const ownerRt = await req(gwBase, 'GET', `/platform/orgs/${orgId}/accounts/${memberId}/runtime`, { token: ownerTok })
      assert(ownerRt.status === 200, `owner rt ${ownerRt.status} ${ownerRt.text}`)
      assert(Array.isArray(ownerRt.json.runtimes), 'runtimes array')
      assert(ownerRt.json.runtimes.length === 2, `runtimes ${ownerRt.json.runtimes.length}`)
      const ids = ownerRt.json.runtimes.map((x) => x.botId).sort()
      assert(ids[0] === botA && ids[1] === botB || ids[0] === botB && ids[1] === botA, `bot ids ${ids}`)
      const a = ownerRt.json.runtimes.find((x) => x.botId === botA)
      assert(a.vncPassword === r.json.vncPassword, 'owner 看到的密码应与员工同一份')
      assert(a.linuxUser === r.json.linuxUser, 'linuxUser 绑定该账号')
      assert(a.seatId === r.json.seatId, 'seatId 绑定该 pair')
      assert(a.botVersion === '0.1.0', `owner botVersion ${a.botVersion}`)
      assert(a.cdpPort == null, 'owner JSON CDP')
      assert(!JSON.stringify(ownerRt.json).includes('smt_'), 'owner runtime 泄漏机器票')
    })

    await test('另一名成员不能读这份 runtime', async () => {
      const plat = await req(gwBase, 'GET', `/platform/orgs/${orgId}/accounts/${memberId}/runtime`, { token: otherTok })
      assert(plat.status === 403 || plat.status === 404, `other platform ${plat.status} ${plat.text}`)
      const desk = await req(gwBase, 'GET', '/runtime/desktop?botId=' + encodeURIComponent(botA), { token: otherTok })
      if (desk.status === 200) {
        assert(desk.json.seatId !== seatIdOf(memberId, botA), 'other desktop 串了席位')
      } else {
        assert(desk.status === 404, `other desktop ${desk.status} ${desk.text}`)
      }
      assert(!JSON.stringify(desk.json).includes('smt_'), 'other desktop 泄漏机器票')
    })

    await test('owner GET /orgs/:id/accounts 列表含 runtimes 不含密码', async () => {
      const r = await req(gwBase, 'GET', `/orgs/${orgId}/accounts`, { token: ownerTok })
      assert(r.status === 200, `accounts ${r.status} ${r.text}`)
      const row = (r.json.members || []).find((m) => m.id === memberId)
      assert(row, '找不到成员')
      assert(Array.isArray(row.runtimes) && row.runtimes.length === 2, 'list runtimes')
      const a = row.runtimes.find((x) => x.botId === botA)
      assert(a && a.status === 'ready', 'list runtime A')
      assert(a.linuxUser === linuxUserOf(memberId), 'list linuxUser')
      assert(a.seatId === seatIdOf(memberId, botA), 'list seatId')
      assert(a.botVersion === '0.1.0', `list botVersion ${a.botVersion}`)
      // 列表里不签票：那是给管理员看的引用，点进去要走 /runtime/desktop 现签一张。
      assert(a.novncUrl === `/desktop/${a.seatId}/`, `list novncUrl ${a.novncUrl}`)
      assert(!JSON.stringify(row).includes('vncPassword'), '列表含 vncPassword')
      const dumped = JSON.stringify(r.json)
      assert(!dumped.includes('smt_'), 'accounts 泄漏机器票')
    })

    await test('再次 deploy 同一 pair 已 ready 返回当前 runtime', async () => {
      const r = await req(gwBase, 'POST', '/runtime/deploy', { token: memberTok, body: { botId: botA } })
      assert(r.status === 200, `again ${r.status} ${r.text}`)
      assert(r.json.status === 'ready', 'still ready')
      assert(r.json.linuxUser === linuxUserOf(memberId), 'same user')
      assert(r.json.seatId === seatIdOf(memberId, botA), 'same seat')
      assert(r.json.display === 10, 'same slot')
    })

    await test('GET 机器 JSON 不含 sshSecret 标记串', async () => {
      const r = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      assert(machineTok && JSON.stringify(r.json).includes(machineTok), 'owner 应看得到机器票')
      const orgMach = await req(gwBase, 'GET', `/orgs/${orgId}/machine`, { token: memberTok })
      assert(orgMach.status === 200, `org machine ${orgMach.status}`)
      assert(!JSON.stringify(orgMach.json).includes(machineTok), '公司管理员不该看到机器票')
      
      assert(!Object.prototype.hasOwnProperty.call(orgMach.json.machine || {}, 'token'), 'org machine 带 token')
      assert(!JSON.stringify(orgMach.json).includes('smt_'), 'org machine 泄漏 smt_')
    })

    await test('多机调度：填满一台再用下一台，同一账号粘住同一台', async () => {
      // 到这儿 m1 上已经有 member1 和 member2 两个账号了。容量压到 1 → 立刻算满。
      // 不驱逐已经在上面的账号：把人从机器上赶走会丢掉他的 ~/work。
      const first = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      const m1 = first.json.machines[0].machine.id
      const cap = await req(gwBase, 'PUT', `/platform/orgs/${orgId}/machines/${m1}/capacity`, {
        token: ownerTok,
        body: { maxAccounts: 1 },
      })
      assert(cap.status === 200, `capacity ${cap.status} ${cap.text}`)
      assert(cap.json.machine.id === m1, 'capacity 返回的是同一台')

      // 订阅席位和机器容量是两回事：这里要加的是前者，否则建不出新员工。
      const plan = await req(gwBase, 'PUT', `/platform/orgs/${orgId}/plan`, { token: ownerTok, body: { seats: 8 } })
      assert(plan.status === 200, `plan ${plan.status} ${plan.text}`)

      // 换个地址配对 = 新增一台，不是替换。
      const code2 = await req(gwBase, 'POST', `/platform/orgs/${orgId}/pairing-code`, { token: ownerTok })
      const pair2 = await req(gwBase, 'POST', '/machines/pair', {
        body: { code: code2.json.code, managerPort: 9443, managerVersion: '9.9.9', protocol: 1 },
      })
      assert(pair2.status === 201, `pair2 ${pair2.status} ${pair2.text}`)
      const listed = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      assert(listed.json.machines.length === 2, `应有两台：${listed.json.machines.length}`)
      const m2 = listed.json.machines.find((x) => x.machine.id !== m1).machine.id

      // 粘住：member1 已经在 m1 上，m1 满了也还得落在 m1——他的 bot 要共享同一份 ~/work。
      const again = await req(gwBase, 'POST', '/runtime/deploy', { token: memberTok, body: { botId: botB, update: true } })
      assert(again.status === 200, `member1 再部署 ${again.status} ${again.text}`)
      // 落在哪台机器上，从平台清单的每台账号数看——桌面地址现在是 Gateway 同域的
      // 路径，里面不再有机器的影子（哪台机器由 seatId 反查，见 desktop.ts）。
      const stick = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      assert(stick.json.machines.find((x) => x.machine.id === m2).accounts === 0, 'member1 不该被挪到 m2')

      // 新账号：m1 满了，只能落到 m2。
      const m3 = await req(gwBase, 'POST', `/orgs/${orgId}/accounts`, {
        token: adminTok,
        body: { email: 'member3@machine.test', password: 'correct-horse', role: 'member' },
      })
      assert(m3.status === 201, `member3 ${m3.status} ${m3.text}`)
      const tok3 = (
        await req(gwBase, 'POST', '/auth/login', { body: { email: 'member3@machine.test', password: 'correct-horse' } })
      ).json.token
      const on2 = await req(gwBase, 'POST', '/runtime/deploy', { token: tok3, body: { botId: botA } })
      assert(on2.status === 200, `member3 部署 ${on2.status} ${on2.text}`)

      const after = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      const c1 = after.json.machines.find((x) => x.machine.id === m1)
      const c2 = after.json.machines.find((x) => x.machine.id === m2)
      assert(c1.full, `m1 应算满：${c1.accounts}/${c1.maxAccounts}`)
      assert(c2.accounts === 1, `member3 应落到 m2：${c2.accounts}`)
      assert(after.json.capacity.max === c1.maxAccounts + c2.maxAccounts, '总容量是各台之和')

      // 两台都满 → 第四个账号无处可去，要给能看懂的 409。
      await req(gwBase, 'PUT', `/platform/orgs/${orgId}/machines/${m2}/capacity`, { token: ownerTok, body: { maxAccounts: 1 } })
      const m4 = await req(gwBase, 'POST', `/orgs/${orgId}/accounts`, {
        token: adminTok,
        body: { email: 'member4@machine.test', password: 'correct-horse', role: 'member' },
      })
      assert(m4.status === 201, `member4 ${m4.status} ${m4.text}`)
      const tok4 = (
        await req(gwBase, 'POST', '/auth/login', { body: { email: 'member4@machine.test', password: 'correct-horse' } })
      ).json.token
      const nope = await req(gwBase, 'POST', '/runtime/deploy', { token: tok4, body: { botId: botA } })
      assert(nope.status === 409, `都满了应 409：${nope.status} ${nope.text}`)
      assert(String(nope.json.error).includes('都满了'), `文案 ${nope.json.error}`)

      // 放开 m1 的容量，第四个人就落回 m1（已用最多、且没满的那台）。
      await req(gwBase, 'PUT', `/platform/orgs/${orgId}/machines/${m1}/capacity`, { token: ownerTok, body: { maxAccounts: 5 } })
      const ok4 = await req(gwBase, 'POST', '/runtime/deploy', { token: tok4, body: { botId: botA } })
      assert(ok4.status === 200, `放开后 ${ok4.status} ${ok4.text}`)
      const final = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      assert(final.json.machines.find((x) => x.machine.id === m1).accounts === 3, 'member4 应落在 m1')
    })

    await test('未配对的机器：不算容量，能移除；有席位的不给删', async () => {
      const before = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      const busy = before.json.machines.find((x) => x.seats > 0)
      assert(busy, '这时候该有一台带席位的机器')
      const refused = await req(gwBase, 'DELETE', `/platform/orgs/${orgId}/machines/${busy.machine.id}`, { token: ownerTok })
      assert(refused.status === 409, `有席位应拒删：${refused.status} ${refused.text}`)

      // 造一台「登记了但没配对」的：容量不该把它算进去。
      const ghost = await req(gwBase, 'POST', '/internal/machines', {
        token: MACHINE_TOK,
        body: { host: '10.9.9.9:3200' },
      })
      assert(ghost.status === 201, `ghost ${ghost.status} ${ghost.text}`)
      const claimed = await req(gwBase, 'POST', `/orgs/${orgId}/machine`, {
        token: adminTok,
        body: { id: ghost.json.machine.id },
      })
      assert(claimed.status === 201, `claim ${claimed.status} ${claimed.text}`)

      const withGhost = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      const g = withGhost.json.machines.find((x) => x.machine.id === ghost.json.machine.id)
      assert(g && !g.machine.paired, '这台不该算已配对')
      assert(
        withGhost.json.capacity.max === before.json.capacity.max,
        `未配对的机器不该贡献容量：${before.json.capacity.max} → ${withGhost.json.capacity.max}`,
      )

      const gone = await req(gwBase, 'DELETE', `/platform/orgs/${orgId}/machines/${ghost.json.machine.id}`, {
        token: ownerTok,
      })
      assert(gone.status === 200, `移除 ${gone.status} ${gone.text}`)
      const after = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      assert(!after.json.machines.some((x) => x.machine.id === ghost.json.machine.id), '没删干净')
    })

    await test('改管家地址：存得下，并且当场报可达性', async () => {
      const r = await req(gwBase, 'PUT', `/platform/orgs/${orgId}/machine`, {
        token: ownerTok,
        body: { host: '10.8.0.21:8443' },
      })
      assert(r.status === 200, `edit ${r.status} ${r.text}`)
      // 裸 host 要补上 scheme：这个值会被直接拼成 fetch 的 URL。
      assert(r.json.machine.host === 'http://10.8.0.21:8443', `host ${r.json.machine.host}`)
      assert(r.json.reachable === false, '那儿没有管家，应报不可达')
      // 改回去，后面的用例还要用。
      await req(gwBase, 'PUT', `/platform/orgs/${orgId}/machine`, {
        token: ownerTok,
        body: { host: `http://127.0.0.1:${MGR_PORT}` },
      })
    })

    await test('同一版本传第二次 → 409', async () => {
      let err = ''
      try {
        await publishRelease({ req, gwBase, token: ownerTok, version: '0.1.0' })
      } catch (e) {
        err = String(e.message)
      }
      assert(err.includes('409'), `dup ${err}`)
    })

    await test('发布 0.2.0 后成员 update deploy → botVersion 0.2.0', async () => {
      await publishRelease({ req, gwBase, token: ownerTok, version: '0.2.0' })
      const r = await req(gwBase, 'POST', '/runtime/deploy', {
        token: memberTok,
        body: { botId: botA, version: '0.2.0', update: true },
      })
      assert(r.status === 200, `update deploy ${r.status} ${r.text}`)
      assert(r.json.botVersion === '0.2.0', `botVersion ${r.json.botVersion}`)
    })

    await test('按架构选包：x64 更新，arm64 机器仍拿到 arm64 的包', async () => {
      // 发布包里带 esbuild 的原生二进制，装错架构起不来。CI 一次出两份，x64 后传所以
      // 更「新」——只按 createdAt 取的话，arm 机器每次都会拿到 x64 那份。
      await publishRelease({ req, gwBase, token: ownerTok, version: '0.3.0-arm64' })
      await publishRelease({ req, gwBase, token: ownerTok, version: '0.3.0-x64' }) // 更新

      // 机器还没报过架构：退回老行为，谁新要谁。
      const blind = await req(gwBase, 'POST', '/runtime/deploy', {
        token: memberTok,
        body: { botId: botA, update: true },
      })
      assert(blind.status === 200, `未报架构时部署 ${blind.status} ${blind.text}`)
      assert(blind.json.botVersion === '0.3.0-x64', `未报架构应取最新，实际 ${blind.json.botVersion}`)

      // 心跳报 arm64 之后，同样不指定版本，必须挑到 arm64 那份。
      const mach = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      assert(mach.status === 200, `取机器 ${mach.status} ${mach.text}`)
      const machineId = mach.json.machine.id
      const hb = await req(gwBase, `POST`, `/internal/machines/${machineId}/heartbeat`, {
        token: machineTok,
        body: { managerVersion: 'e2e', protocol: 1, arch: 'arm64', seats: [] },
      })
      assert(hb.status === 200, `heartbeat ${hb.status} ${hb.text}`)

      const aware = await req(gwBase, 'POST', '/runtime/deploy', {
        token: memberTok,
        body: { botId: botA, update: true },
      })
      assert(aware.status === 200, `按架构部署 ${aware.status} ${aware.text}`)
      assert(
        aware.json.botVersion === '0.3.0-arm64',
        `arm64 机器该拿 arm64 的包，实际 ${aware.json.botVersion}`,
      )
    })

    await test('按架构选包：显式指定错架构的版本 → 409', async () => {
      const r = await req(gwBase, 'POST', '/runtime/deploy', {
        token: memberTok,
        body: { botId: botA, version: '0.3.0-x64', update: true },
      })
      assert(r.status === 409, `错架构该被挡下，实际 ${r.status} ${r.text}`)
      assert(String(r.text).includes('arm64'), `报错该点明机器架构：${r.text}`)
      // 认不出架构的老版本号照旧放行。
      const legacy = await req(gwBase, 'POST', '/runtime/deploy', {
        token: memberTok,
        body: { botId: botA, version: '0.2.0', update: true },
      })
      assert(legacy.status === 200, `无后缀的老版本不该被拦，实际 ${legacy.status} ${legacy.text}`)
    })

    await test('重铺一个没记版本的席位：按机器架构挑包，不是按「平台上最新的那个」', async () => {
      /**
       * 席位那一行的 botVersion 可能是空的（老数据、上一次部署失败没写上）。重铺这种
       * 席位时**不能自己兜一个 latestBotRelease()**：那个查询不看架构，而 deploySeat 对
       * 显式指定的版本是要过架构关的——于是兜出来的 x64 包会被它自己 409 掉，这个席位
       * 永远重铺不了。不传版本，交给 deploySeat 按 machine.arch 去挑，才挑得对。
       *
       * 这时候的现场正好：机器自报 arm64，而平台上最新的是后传的 0.3.0-x64。
       */
      const require = createRequire(new URL('../gateway/package.json', import.meta.url))
      const pg = require('pg')
      const client = new pg.Client({ connectionString: PG_URL })
      await client.connect()
      try {
        await client.query(`set search_path to ${SCHEMA}`)
        const seat = await client.query(
          'select "machineId" from seat_runtimes where "accountId" = $1 and "botId" = $2',
          [memberId, botA],
        )
        assert(seat.rowCount === 1, `没找到 botA 的席位行：${seat.rowCount}`)
        await client.query('update seat_runtimes set "botVersion" = null where "accountId" = $1 and "botId" = $2', [
          memberId,
          botA,
        ])

        const r = await req(gwBase, 'POST', `/platform/machines/${seat.rows[0].machineId}/runtime/update`, {
          token: ownerTok,
          body: { force: true },
        })
        assert(r.status === 200, `重铺 ${r.status} ${r.text}`)
        const mine = r.json.results.find((x) => x.botId === botA && x.accountId === memberId)
        assert(mine, `结果里没有这个席位：${r.text.slice(0, 300)}`)
        assert(!mine.error, `没记版本的席位重铺失败了：${mine.error}`)
        assert(
          mine.botVersion === '0.3.0-arm64',
          `该按机器架构挑 arm64 的包，实际 ${mine.botVersion}（挑成 x64 就是自己兜了个不看架构的最新版）`,
        )
      } finally {
        await client.end().catch(() => {})
      }
    })

    /**
     * 改机器地址要**连着把席位的 instances.host 一起重铺**。
     *
     * 不重铺的话，改完之后桌面是好的（走 machines.host 现拼），聊天却还在往老地址
     * 打（走 instances.host，那一行只在部署时写过一次）。表现是「这颗 bot 挂了」，
     * 而改地址的人当场点一下桌面看不出任何问题——所以这条必须有测试兜着。
     */
    await test('改机器地址会把席位的 instances.host 一起重铺，且不碰非管家形状的', async () => {
      const require = createRequire(new URL('../gateway/package.json', import.meta.url))
      const pg = require('pg')
      const client = new pg.Client({ connectionString: PG_URL })
      await client.connect()
      try {
        await client.query(`set search_path to ${SCHEMA}`)
        const machineId = (await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })).json
          .machine.id
        const oldHost = (await req(gwBase, 'GET', `/platform/machines/${machineId}`, { token: ownerTok })).json.machine
          .host
        const hostOf = async (accountId, botId) =>
          (await client.query('select host from instances where "accountId" = $1 and "botId" = $2', [accountId, botId]))
            .rows[0]?.host

        /**
         * 先把现场摆成**生产的样子**。
         *
         * 这套 e2e 走的是 `SATUWORK_DEPLOY_STUB=1`，那条路写进 instances.host 的是
         * bot 口的回环地址（`http://127.0.0.1:<botPort>`），而生产写的是管家反代入口。
         * 要测的正是后者，所以这里显式摆一行成管家形状；member2 那行留着 stub 的原样，
         * 顺便验「不该动的没被动」。
         */
        const seatA = seatIdOf(memberId, botA)
        const stubB = await hostOf(member2Id, botB)
        await client.query('update instances set host = $3 where "accountId" = $1 and "botId" = $2', [
          memberId,
          botA,
          `${oldHost.replace(/\/$/, '')}/seats/${seatA}/bot`,
        ])

        // 换成一个语法合法但连不上的地址：这条路会去探活，探不通返回 reachable:false，
        // 但**地址和重铺照样要落库**——线上换地址时新地址常常要过几秒才通。
        const moved = await req(gwBase, 'PUT', `/platform/machines/${machineId}/host`, {
          token: ownerTok,
          body: { host: 'https://m001.satuwork.test' },
        })
        assert(moved.status === 200, `改地址 ${moved.status} ${moved.text}`)
        assert(moved.json.rehosted === 1, `该只重铺那一行管家形状的，实际 ${moved.json.rehosted}`)

        const movedA = await hostOf(memberId, botA)
        assert(
          movedA === `https://m001.satuwork.test/seats/${seatA}/bot`,
          `instances.host 没跟着改，或形状不对（聊天反代要的是 .../seats/<seatId>/bot）：${movedA}`,
        )
        assert(
          (await hostOf(member2Id, botB)) === stubB,
          `不是管家形状的那一行被改了：${await hostOf(member2Id, botB)} ≠ ${stubB}`,
        )

        // 换回去，后面的用例还要用这台假管家。
        const back = await req(gwBase, 'PUT', `/platform/machines/${machineId}/host`, {
          token: ownerTok,
          body: { host: oldHost },
        })
        assert(back.status === 200, `改回去 ${back.status} ${back.text}`)
        assert(
          (await hostOf(memberId, botA)) === `${oldHost.replace(/\/$/, '')}/seats/${seatA}/bot`,
          `改回去没跟着回：${await hostOf(memberId, botA)}`,
        )
        // stub 那行是这套 e2e 后续用例真正要用的，必须原样躺着。
        await client.query('update instances set host = $3 where "accountId" = $1 and "botId" = $2', [
          memberId,
          botA,
          `http://127.0.0.1:${(await client.query('select "botPort" from seat_runtimes where "accountId" = $1 and "botId" = $2', [memberId, botA])).rows[0].botPort}`,
        ])
      } finally {
        await client.end().catch(() => {})
      }
    })

    await test('owner POST /platform/orgs/:id/runtime/update 返回结果', async () => {
      const r = await req(gwBase, 'POST', `/platform/orgs/${orgId}/runtime/update`, {
        token: ownerTok,
        body: { version: '0.2.0' },
      })
      assert(r.status === 200, `update ${r.status} ${r.text}`)
      assert(r.json.version === '0.2.0', `version ${r.json.version}`)
      assert(Array.isArray(r.json.results), 'results')
      assert(r.json.results.length >= 2, `results ${r.json.results.length}`)
      for (const row of r.json.results) {
        assert(row.accountId && row.botId, `row ids ${JSON.stringify(row)}`)
        assert(row.botVersion === '0.2.0' || row.error, `row ${JSON.stringify(row)}`)
      }
      const ready = r.json.results.filter((x) => x.status === 'ready' && !x.error)
      assert(ready.length >= 1, 'no ready seats')
      assert(ready.every((x) => x.botVersion === '0.2.0'), 'versions match')
    })

    await test('SPA GET /releases 返回 html', async () => {
      const r = await req(gwBase, 'GET', '/releases')
      assert(r.status === 200, `spa /releases ${r.status}`)
      assert(String(r.text).includes('<!doctype html>') || String(r.text).includes('Satuwork'), 'spa html')
    })

    // ── 上传发布包（生产路径：CI 传包，Gateway 不构建）──────────────────
    const goodPack = tarGz([
      { name: './bin/satuwork.mjs', data: '#!/usr/bin/env node\nconsole.log("uploaded")\n' },
      { name: './package.json', data: '{"name":"satuwork","version":"1.0.0"}\n' },
    ])
    const relFile = (v) => join(GW_HOME, 'releases', `bot-${v}.tgz`)

    await test('CI 用平台令牌 PUT 上传发布包 → 200，sha256/size 对得上', async () => {
      const sha = sha256Of(goodPack)
      const r = await req(gwBase, 'PUT', '/platform/bot-releases/1.0.0+ci?note=uploaded', {
        token: PLATFORM_TOK,
        raw: goodPack,
        headers: { 'x-bot-sha256': sha },
      })
      assert(r.status === 200, `upload ${r.status} ${r.text}`)
      assert(r.json.release.version === '1.0.0+ci', `version ${r.json.release.version}`)
      assert(r.json.release.sha256 === sha, 'sha256 回显')
      assert(r.json.release.size === goodPack.length, `size ${r.json.release.size}`)
      assert(r.json.release.note === 'uploaded', `note ${r.json.release.note}`)
      assert(existsSync(relFile('1.0.0+ci')), '发布包没落盘')
      const one = await req(gwBase, 'GET', '/platform/bot-releases/1.0.0%2Bci', { token: ownerTok })
      assert(one.status === 200, `one ${one.status} ${one.text}`)
      assert(one.json.release.sha256 === sha, 'one sha256')
    })

    // 字节在 Gateway 磁盘上的包也必须报出一个下载地址：那台 Debian 只有这一处能看到
    // 该拉哪儿，界面上写「本机存储」等于没给。
    await test('本机存储的发布包也给下载地址，且那个地址真能拉到包', async () => {
      const one = await req(gwBase, 'GET', '/platform/bot-releases/1.0.0%2Bci', { token: ownerTok })
      const url = one.json.release.downloadUrl
      assert(one.json.release.storage === 'local', `storage ${one.json.release.storage}`)
      assert(url && url.endsWith('/internal/bot-releases/1.0.0%2Bci'), `downloadUrl ${url}`)
      assert(url.startsWith('http://'), `downloadUrl 要是绝对地址：${url}`)
      const dl = await fetch(url, { headers: { authorization: 'Bearer ' + machineTok } })
      assert(dl.status === 200, `按下载地址拉包 ${dl.status}`)
      assert(dl.headers.get('x-bot-sha256') === sha256Of(goodPack), '校验头丢了')
    })

    await test('上传的版本能部署：botVersion 跟上', async () => {
      const r = await req(gwBase, 'POST', '/runtime/deploy', {
        token: memberTok,
        body: { botId: botA, version: '1.0.0+ci', update: true },
      })
      assert(r.status === 200, `deploy uploaded ${r.status} ${r.text}`)
      assert(r.json.botVersion === '1.0.0+ci', `botVersion ${r.json.botVersion}`)
    })

    await test('没有令牌上传 → 401，不落盘', async () => {
      const r = await req(gwBase, 'PUT', '/platform/bot-releases/9.9.9', { raw: goodPack })
      assert(r.status === 401, `anon upload ${r.status} ${r.text}`)
      assert(!existsSync(relFile('9.9.9')), '匿名上传落了盘')
    })

    await test('sha256 对不上 → 400，文件和库都不留', async () => {
      const r = await req(gwBase, 'PUT', '/platform/bot-releases/1.0.1', {
        token: PLATFORM_TOK,
        raw: goodPack,
        headers: { 'x-bot-sha256': 'f'.repeat(64) },
      })
      assert(r.status === 400, `bad sha ${r.status} ${r.text}`)
      assert(String(r.json.error || '').includes('sha256'), 'sha256 文案')
      assert(!existsSync(relFile('1.0.1')), '坏包留在盘上')
      const one = await req(gwBase, 'GET', '/platform/bot-releases/1.0.1', { token: ownerTok })
      assert(one.status === 404, `bad sha 入库了 ${one.status}`)
    })

    await test('包里没有 bin/satuwork.mjs → 400', async () => {
      const bad = tarGz([{ name: './README.md', data: 'nope\n' }])
      const r = await req(gwBase, 'PUT', '/platform/bot-releases/1.0.2', { token: PLATFORM_TOK, raw: bad })
      assert(r.status === 400, `no entry ${r.status} ${r.text}`)
      assert(String(r.json.error || '').includes('bin/satuwork.mjs'), '缺入口文案')
      assert(!existsSync(relFile('1.0.2')), '坏包留在盘上')
    })

    await test('不是 gzip → 400', async () => {
      const r = await req(gwBase, 'PUT', '/platform/bot-releases/1.0.3', {
        token: PLATFORM_TOK,
        raw: Buffer.from('这不是 tar.gz'),
      })
      assert(r.status === 400, `not gz ${r.status} ${r.text}`)
      assert(!existsSync(relFile('1.0.3')), '坏包留在盘上')
    })

    await test('重复上传同一版本 → 409，原包不动', async () => {
      const before = sha256Of(goodPack)
      const r = await req(gwBase, 'PUT', '/platform/bot-releases/1.0.0+ci', { token: PLATFORM_TOK, raw: goodPack })
      assert(r.status === 409, `dup upload ${r.status} ${r.text}`)
      const one = await req(gwBase, 'GET', '/platform/bot-releases/1.0.0%2Bci', { token: ownerTok })
      assert(one.json.release.sha256 === before, '原包被改了')
    })

    await test('非法版本号 → 400', async () => {
      const r = await req(gwBase, 'PUT', '/platform/bot-releases/..%2Fetc', { token: PLATFORM_TOK, raw: goodPack })
      assert(r.status === 400, `bad version ${r.status} ${r.text}`)
    })

    await test('平台令牌也能回查发布列表（CI 传完要能确认）', async () => {
      const list = await req(gwBase, 'GET', '/platform/bot-releases', { token: PLATFORM_TOK })
      assert(list.status === 200, `list by platform token ${list.status} ${list.text}`)
      assert(list.json.releases.some((r) => r.version === '1.0.0+ci'), '列表里没有上传的版本')
      const bad = await req(gwBase, 'GET', '/platform/bot-releases', { token: 'not-a-token' })
      assert(bad.status === 401, `bogus token ${bad.status}`)
    })

    await test('Desktop local-bot 包按平台上传、探测并用 sat_ 下载', async () => {
      const version = '1.0.0+desktop-darwin-arm64'
      const sha = sha256Of(goodPack)
      const uploaded = await req(
        gwBase,
        'PUT',
        `/platform/local-bot-releases/${encodeURIComponent(version)}?note=desktop`,
        { token: PLATFORM_TOK, raw: goodPack, headers: { 'x-bot-sha256': sha } },
      )
      assert(uploaded.status === 200, `local upload ${uploaded.status} ${uploaded.text}`)
      assert(uploaded.json.release.kind === 'local-bot', `kind ${uploaded.json.release.kind}`)
      assert(
        existsSync(join(GW_HOME, 'releases', `local-bot-${version}.tgz`)),
        'Desktop 本地运行时包没落盘',
      )

      const detail = await req(gwBase, 'GET', `/platform/accounts/${memberId}`, { token: ownerTok })
      const seatAccess = detail.json.accessToken
      assert(String(seatAccess).startsWith('sat_'), '没有席位 access token')
      const manifest = await req(
        gwBase,
        'GET',
        '/runtime/local-bot-release?platform=darwin&arch=arm64&have=old',
        { token: seatAccess },
      )
      assert(manifest.status === 200, `manifest ${manifest.status} ${manifest.text}`)
      assert(manifest.json.version === version, `manifest version ${manifest.json.version}`)
      assert(manifest.json.sha256 === sha, 'manifest sha256')
      assert(manifest.json.size === goodPack.length, 'manifest size')

      const downloaded = await fetch(manifest.json.url, {
        headers: { authorization: `Bearer ${seatAccess}` },
      })
      if (downloaded.status !== 200) {
        assert(false, `local download ${downloaded.status} ${manifest.json.url}: ${await downloaded.text()}`)
      }
      assert(Buffer.compare(Buffer.from(await downloaded.arrayBuffer()), goodPack) === 0, '下载字节不一致')

      const current = await req(
        gwBase,
        'GET',
        `/runtime/local-bot-release?platform=darwin&arch=arm64&have=${encodeURIComponent(version)}`,
        { token: seatAccess },
      )
      assert(current.status === 204, `已有最新版应是 204，实际 ${current.status}`)
      const other = await req(gwBase, 'GET', '/runtime/local-bot-release?platform=linux&arch=x64', {
        token: seatAccess,
      })
      assert(other.status === 204, `没有当前目标包应是 204，实际 ${other.status}`)
    })

    await test('Desktop local-bot 发布拒绝缺少目标后缀的版本', async () => {
      const r = await req(gwBase, 'PUT', '/platform/local-bot-releases/1.0.1', {
        token: PLATFORM_TOK,
        raw: goodPack,
      })
      assert(r.status === 400, `错误目标版本 ${r.status} ${r.text}`)
    })

    /**
     * 桌面反代：`/desktop/:seatId/*` → 管家的 noVNC。
     *
     * 这条路是为「把桌面内嵌进右栏」开的。浏览器直连管家那条路仍然在（管家侧另有
     * 一组用例钉它），但 iframe 里用不了：管家发的 cookie 是 SameSite=Lax，跨站的
     * iframe 里浏览器连存都不给存，画面永远出不来而且不报错。
     *
     * 这里起一个假管家听在配对时记下的那个地址上（127.0.0.1:MGR_PORT），然后整条走一遍：
     * 票换 cookie → 静态资源 → WebSocket 升级，以及三种不该放行的情况。
     */
    await test('桌面从 Gateway 同域反代出去：票换 cookie、资源与 WebSocket 都通', async () => {
      // 像 noVNC 落地页那样有个 </head>，好验证控制条那段样式插进去了。
      const FAKE_PAGE = '<html><head><title>noVNC</title></head><body>VNC-PAGE</body></html>'
      const seen = { headers: [], paths: [] }
      const fake = createServer((req, res) => {
        seen.headers.push(req.headers)
        seen.paths.push(req.url)
        if (req.headers['x-satuwork-machine'] !== machineTok) {
          res.writeHead(401).end('no machine token')
          return
        }
        res.writeHead(200, { 'content-type': 'text/html' }).end(FAKE_PAGE)
      })
      fake.on('upgrade', (req, socket) => {
        if (req.headers['x-satuwork-machine'] !== machineTok) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n')
        socket.write('HELLO-WS')
      })
      await withDeadline(
        new Promise((ok, bad) => {
          fake.once('error', bad)
          fake.listen(MGR_PORT, '127.0.0.1', ok)
        }),
        `fake listen ${MGR_PORT}`,
        15_000,
      )
      try {
        const rt = await req(gwBase, 'GET', '/runtime/desktop?botId=' + encodeURIComponent(botA), { token: memberTok })
        assert(rt.status === 200, `desktop ${rt.status} ${rt.text}`)
        const seatId = rt.json.seatId
        const entry = rt.json.novncUrl
        assert(entry.startsWith(`/desktop/${seatId}/?ticket=`), `entry ${entry}`)

        const ticket = entry.split('ticket=')[1]
        const hop = await fetch(gwBase + entry, { redirect: 'manual' })
        assert(hop.status === 302, `入口 ${hop.status}`)
        // 票不再换 cookie，而是进路径段（`/desktop/:seatId/t/:ticket/*`）：iframe 去掉了
        // allow-same-origin，框里的源是 opaque，cookie 根本带不上；路径里的票让 noVNC
        // 自己发的静态资源和 WebSocket 升级按相对路径解析时天然都带着票。
        assert(!hop.headers.get('set-cookie'), `不该再发 cookie：${hop.headers.get('set-cookie')}`)
        const base = `/desktop/${seatId}/t/${encodeURIComponent(ticket)}`

        const loc = String(hop.headers.get('location'))
        const q = new URLSearchParams(loc.split('?')[1] || '')
        assert(loc.startsWith(`${base}/vnc.html`), `location ${loc}`)
        // noVNC 拼 WebSocket 地址的写法是 `'/' + path`，从根开始。不告诉它就会去连
        // /websockify——那个路径不属于任何席位，反代认不出来。
        assert(q.get('path') === `${base.slice(1)}/websockify`, `path ${q.get('path')}`)
        assert(q.get('autoconnect') === '1', `autoconnect ${loc}`)
        assert(q.get('password') === rt.json.vncPassword, '口令没随票转过去')

        /**
         * 管家还是 1 号协议时，这条路要**明确说「去升级管家」**，不能把管家那句
         * 「桌面票无效或已过期」原样递出去——那句话和票真的过期一字不差，人会去反复
         * 重开桌面，而那永远不会好。上面的心跳把这台机器报成了 protocol 1。
         */
        const old = await fetch(`${gwBase}${base}/vnc.html`)
        assert(old.status === 409, `旧管家应 409：${old.status}`)
        assert(String((await old.json()).error).includes('升级管家'), '没说清楚要升级管家')

        // 管家升上来（心跳自报 protocol 2）之后，同一条路就该通了。
        const machineId = (await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })).json
          .machine.id
        const hb2 = await req(gwBase, 'POST', `/internal/machines/${machineId}/heartbeat`, {
          token: machineTok,
          body: { managerVersion: 'e2e', protocol: 2, arch: 'arm64', seats: [] },
        })
        assert(hb2.status === 200, `heartbeat2 ${hb2.status} ${hb2.text}`)

        const page = await fetch(`${gwBase}${base}/vnc.html`)
        assert(page.status === 200, `静态 ${page.status}`)
        const body = await page.text()
        assert(body.includes('VNC-PAGE'), '字节没带回来')
        /**
         * 落地页要**改一处**：把 noVNC 自己的控制条关掉。那条竖条在右栏这种嵌法里
         * 和我们自己的标题栏叠在一起，还压着桌面右边一条。
         */
        assert(body.includes('#noVNC_control_bar_anchor'), '控制条那段样式没插进去')
        // 「Connected to …」那条提示也关掉，但**只关 normal 那一档**：控制条已经藏了，
        // 报错和警告是页面上唯一还会说「连不上」的地方。
        assert(body.includes('#noVNC_status.noVNC_status_normal'), '连接成功那条提示没关掉')
        assert(!body.includes('noVNC_status_error'), '不该把报错那一档也关掉')
        assert(body.indexOf('#noVNC_control_bar_anchor') < body.indexOf('</head>'), '样式要在 </head> 之前')
        // opaque 源里碰 localStorage 会抛，noVNC 初始化第一步就读设置——垫片要在 module 之前。
        assert(body.includes('localStorage'), '落地页没垫 localStorage 的替身')
        assert(page.headers.get('content-length') === String(new TextEncoder().encode(body).length), '改了内容没重算长度')
        // 反代出来的每条响应都要钉上 frame-ancestors，并放开 CORS（opaque 源取 module 要它）。
        assert(String(page.headers.get('content-security-policy')).includes("frame-ancestors 'self'"), 'CSP 没加')
        assert(page.headers.get('access-control-allow-origin') === '*', 'opaque 源取 module 需要 CORS')
        assert(seen.paths.some((p) => p.startsWith(`/seats/${seatId}/vnc/vnc.html`)), `上游路径 ${seen.paths}`)
        // 机器票只该活在 Gateway 与管家之间；浏览器那侧的 cookie 也不该漏下去。
        const last = seen.headers[seen.headers.length - 1]
        assert(last['x-satuwork-machine'] === machineTok, '没带机器票')
        assert(!last.cookie, `Gateway 的 cookie 漏给了管家：${last.cookie}`)

        // 别的资源不许被碰：只有落地页走改写那条路。
        const asset = await fetch(`${gwBase}${base}/app/ui.js`)
        assert(!(await asset.text()).includes('noVNC_control_bar_anchor'), '普通资源不该被改写')

        const anon = await fetch(`${gwBase}/desktop/${seatId}/vnc.html`)
        assert(anon.status === 401, `无票应 401：${anon.status}`)
        const stolen = await fetch(`${gwBase}/desktop/${seatId}/t/not-a-jwt/vnc.html`)
        assert(stolen.status === 401, `伪造票应 401：${stolen.status}`)
        // 别人那块屏的票，进不了这块屏：入口和带票路径两条路都要挡。
        const other = seatIdOf(member2Id, botA)
        const crossed = await fetch(`${gwBase}/desktop/${other}/?ticket=${encodeURIComponent(ticket)}`, {
          redirect: 'manual',
        })
        assert(crossed.status === 401, `串屏应 401：${crossed.status}`)
        const crossedPath = await fetch(`${gwBase}/desktop/${other}/t/${encodeURIComponent(ticket)}/vnc.html`)
        assert(crossedPath.status === 401, `带票路径串屏应 401：${crossedPath.status}`)

        const ws = await wsUpgrade(GW_PORT, `${base}/websockify`, '')
        assert(ws.includes('101'), `升级失败: ${ws.slice(0, 120)}`)
        assert(ws.includes('HELLO-WS'), '升级后字节没通')
        const wsAnon = await wsUpgrade(GW_PORT, `/desktop/${seatId}/websockify`, '')
        assert(wsAnon.includes('404') || wsAnon.includes('401'), `无票的升级应被拒: ${wsAnon.slice(0, 80)}`)
        const wsStolen = await wsUpgrade(GW_PORT, `/desktop/${seatId}/t/not-a-jwt/websockify`, '')
        assert(wsStolen.includes('401'), `伪造票的升级应 401: ${wsStolen.slice(0, 80)}`)
      } finally {
        // 走 closeServer：Gateway 那侧的反代是 keep-alive，光 close 会一直等着它自己
        // 断开——套件就停在这儿不动了。
        await closeServer(fake, '假管家')
      }
    })

    /**
     * 配了直连地址之后，桌面地址就该指向席位机器，不再是 Gateway 上那条反代路径。
     *
     * 这一条盯的是「省下来的字节到底走没走」：地址还是 `/desktop/…` 的话，像素照旧
     * 穿过 Gateway，整件事白做——而界面上一切正常，看不出任何区别。
     */
    await test('配了直连地址：桌面地址指向席位机器，清空后退回 Gateway 反代', async () => {
      const machineId = (await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })).json.machine
        .id
      const seatId = seatIdOf(memberId, botA)
      const deskUrl = async () =>
        (await req(gwBase, 'GET', `/runtime/desktop?botId=${encodeURIComponent(botA)}`, { token: memberTok })).json
          .novncUrl

      assert(
        (await deskUrl()).startsWith(`/desktop/${seatId}/`),
        `没配之前该走 Gateway 反代：${await deskUrl()}`,
      )

      // http 要当场被拒：Gateway 的页面是 https，http 的桌面会被浏览器当混合内容
      // **静默**拦掉——放它过去，人看到的就是一块永远打不开的空白。
      const insecure = await req(gwBase, 'PUT', `/platform/machines/${machineId}/direct-url`, {
        token: ownerTok,
        body: { directUrl: 'http://m001.satuwork.test' },
      })
      assert(insecure.status === 400, `http 直连地址该被拒：${insecure.status} ${insecure.text}`)
      const withPath = await req(gwBase, 'PUT', `/platform/machines/${machineId}/direct-url`, {
        token: ownerTok,
        body: { directUrl: 'https://m001.satuwork.test/seats' },
      })
      assert(withPath.status === 400, `带路径的直连地址该被拒：${withPath.status} ${withPath.text}`)

      const set = await req(gwBase, 'PUT', `/platform/machines/${machineId}/direct-url`, {
        token: ownerTok,
        body: { directUrl: 'https://m001.satuwork.test' },
      })
      assert(set.status === 200, `设直连 ${set.status} ${set.text}`)
      assert(set.json.machine.directUrl === 'https://m001.satuwork.test', `回包 ${set.text.slice(0, 200)}`)

      /**
       * **管家不够新时不许切过去。** 落地页那段「关掉 noVNC 控制条」的样式，走反代
       * 是 Gateway 插的，直连只能管家自己插——4 号管家才会。所以填了地址还不够。
       *
       * 这一段同时盯着那个状态位：没有它，人填完地址看不出任何变化（画面照常出来，
       * 因为压根没切过去），只有去数管家版本才分得出「没生效」和「生效了」。
       */
      assert(
        (await deskUrl()).startsWith(`/desktop/${seatId}/`),
        `管家还是 3 号，不该切到直连：${await deskUrl()}`,
      )
      const pendingCard = await req(gwBase, 'GET', `/platform/machines/${machineId}`, { token: ownerTok })
      assert(pendingCard.json.machine.directPending === true, `该报「填了还没生效」：${pendingCard.text.slice(0, 200)}`)

      // 管家升上来（心跳自报 protocol 4）之后，同一条路就该切过去。
      const hb4 = await req(gwBase, 'POST', `/internal/machines/${machineId}/heartbeat`, {
        token: machineTok,
        body: { managerVersion: 'e2e', protocol: 4, arch: 'arm64', seats: [] },
      })
      assert(hb4.status === 200, `heartbeat4 ${hb4.status} ${hb4.text}`)
      const settled = await req(gwBase, 'GET', `/platform/machines/${machineId}`, { token: ownerTok })
      assert(settled.json.machine.directPending === false, `升上来之后不该再报 pending：${settled.text.slice(0, 200)}`)

      const direct = await deskUrl()
      assert(
        direct.startsWith(`https://m001.satuwork.test/seats/${seatId}/vnc/?ticket=`),
        `该指向席位机器上管家的浏览器入口：${direct}`,
      )

      // 公司侧那条同义路由也要通：机器配置在公司详情页和平台机器页都改得了，
      // 容量和时区一直是这么成对的，这一条不能只做一半。
      const viaOrg = await req(gwBase, 'PUT', `/platform/orgs/${orgId}/machines/${machineId}/direct-url`, {
        token: ownerTok,
        body: { directUrl: 'https://m002.satuwork.test' },
      })
      assert(viaOrg.status === 200, `公司侧设直连 ${viaOrg.status} ${viaOrg.text}`)
      assert(
        (await deskUrl()).startsWith(`https://m002.satuwork.test/seats/${seatId}/vnc/?ticket=`),
        `公司侧那条没生效：${await deskUrl()}`,
      )

      const cleared = await req(gwBase, 'PUT', `/platform/machines/${machineId}/direct-url`, {
        token: ownerTok,
        body: { directUrl: '' },
      })
      assert(cleared.status === 200, `清空 ${cleared.status} ${cleared.text}`)
      assert(cleared.json.machine.directUrl === null, `清空后该是 null：${cleared.text.slice(0, 200)}`)
      // 退路必须真的退得回去：桌面打不开时，运维要靠清掉这一格把它救回来。
      assert(
        (await deskUrl()).startsWith(`/desktop/${seatId}/`),
        `清空后该退回 Gateway 反代：${await deskUrl()}`,
      )
    })

    /**
     * 建完 Bot 就该在装了——**不用再点一次「部署」**。
     *
     * 这条盯的是产品承诺本身：填完那张表，人下一眼看到的应该是「正在装」，而不是一块
     * 空屏加一颗按钮。所以断言分两截：建的那一下回执里就有席位（`bot.runtime` 不是
     * null），以及进度那条路答得上「它在装/装好了」。
     *
     * 这套 e2e 跑在 `SATUWORK_DEPLOY_STUB=1` 下，机器上那十几分钟被跳过了，所以回执
     * 拿到的可能已经是 `ready`——两种都算数，要钉的是「有席位」这件事。
     */
    await test('建 Bot 顺手就开装：不用再点一次部署', async () => {
      const made = await req(gwBase, 'POST', '/runtime/bots', { token: memberTok, body: { name: '自动部署的助手' } })
      assert(made.status === 201, `建 Bot ${made.status} ${made.text}`)
      const newBot = made.json.bot.id
      assert(made.json.deploy && made.json.deploy.started === true, `没有自动开装：${made.text}`)
      assert(made.json.bot.runtime, `回执里没有席位：${made.text}`)
      assert(
        ['deploying', 'ready'].includes(made.json.bot.runtime.status),
        `席位状态 ${made.json.bot.runtime.status}`,
      )

      // 进度那条路：状态、开始时刻、机器那份细进度（stub 下没有管家，step 就是 null）。
      let prog
      for (let i = 0; i < 60; i++) {
        const r = await req(gwBase, 'GET', '/runtime/deploy/progress?botId=' + encodeURIComponent(newBot), { token: memberTok })
        assert(r.status === 200, `进度 ${r.status} ${r.text}`)
        prog = r.json
        if (prog.status === 'ready' || prog.status === 'error') break
        assert(prog.status === 'deploying', `进度状态 ${prog.status}`)
        // 年龄，不是起始时刻：两台钟差几分钟是常事，界面拿绝对时刻自己减本地时钟就会
        // 在人刚按下「创建」的那一秒写出「已经装了 10 分钟」。
        assert(prog.startedAt === undefined, `不该再发绝对时刻：${r.text}`)
        assert(Number.isFinite(prog.elapsedMs) && prog.elapsedMs >= 0, `进度没有年龄：${r.text}`)
        await sleep(100)
      }
      assert(prog.status === 'ready', `装完了没有：${JSON.stringify(prog)}`)
      // 装好了才算数：席位真的在，桌面那条路给得出票。
      const desk = await req(gwBase, 'GET', '/runtime/desktop?botId=' + encodeURIComponent(newBot), { token: memberTok })
      assert(desk.status === 200, `桌面 ${desk.status} ${desk.text}`)
      assert(desk.json.seatId === seatIdOf(memberId, newBot), `seatId ${desk.json.seatId}`)
      assert(desk.json.deployPhase === null, `装完了还挂着阶段：${desk.json.deployPhase}`)

      /**
       * **装到一半没人管了。**
       *
       * 装跑在后台，Gateway 一重启，库里那一行就永远停在 `deploying`：机器上什么都没在
       * 装，而界面上那个读秒会一直往上走——人守着一屏永远不会完成的进度，手里连一颗能
       * 按的按钮都没有。库里看不出这件事（两种 `deploying` 一模一样），所以判据是「这个
       * 进程手上有没有这活儿」。这里直接把那一行改回 `deploying` 来造这个现场。
       */
      const require = createRequire(`${gwRoot}/package.json`)
      const pg = require('pg')
      const client = new pg.Client({ connectionString: PG_URL })
      await client.connect()
      try {
        await client.query(`set search_path to ${SCHEMA}`)
        await client.query(
          'update seat_runtimes set status = $2, "deployPhase" = $3, "deployStartedAt" = $4 where "botId" = $1',
          [newBot, 'deploying', 'installing', Date.now() - 600_000],
        )
        const r = await req(gwBase, 'GET', '/runtime/deploy/progress?botId=' + encodeURIComponent(newBot), { token: memberTok })
        assert(r.status === 200, `进度 ${r.status} ${r.text}`)
        assert(r.json.status === 'deploying', `状态 ${r.json.status}`)
        assert(r.json.stale === true, `没认出「没人在装」：${r.text}`)
        // 没人在装就别再去敲机器问第几步了——那是一件已经没有答案的事。
        assert(r.json.step === null, `${r.text}`)
      } finally {
        await client.end().catch(() => {})
      }

      // 收尾：这颗 Bot 是这条用例自己建的，连席位一起删掉，别影响后面的槽位账。
      const del = await req(gwBase, 'DELETE', `/runtime/bots/${newBot}`, { token: memberTok })
      assert(del.status === 200, `删 ${del.status} ${del.text}`)
    })

    await test('没有机器的时候：Bot 照建，装不成的理由说出来', async () => {
      const co = await createCompany(req, gwBase, {
        ownerToken: ownerTok,
        email: 'admin@nomachine.test',
        password: 'correct-horse',
        companyName: 'NoMachine',
        slug: 'nomachine',
      })
      const made = await req(gwBase, 'POST', '/runtime/bots', { token: co.token, body: { name: '没机器的助手' } })
      // **201，不是 409**：Bot 本身好好的，机器配好之后点一下就能装上；把建 Bot 判失败
      // 只会让人以为自己填错了什么。
      assert(made.status === 201, `建 Bot ${made.status} ${made.text}`)
      assert(made.json.bot.runtime === null, `没机器还给了席位：${made.text}`)
      assert(made.json.deploy && made.json.deploy.started === false, `deploy 字段 ${made.text}`)
      assert(String(made.json.deploy.error).includes('运行机器'), `理由没说清：${made.text}`)
    })

    /**
     * 粘住机器是不变量，不是优化。
     *
     * 以前 machineForAccount 找到这个账号的机器、发现它此刻不可用（没配对好、换过
     * 地址、token 轮换失败、正在重装），会直接往下走「填满一台再用下一台」，把这个
     * 人的新 bot 部署到**另一台机器**上。同一员工的多个 bot 共享 ~/work 靠的是同一个
     * uid 在同一台机器上，劈开之后这条就不成立了，而且没有任何告警——人只是从此
     * 看不见自己在另一台机器上的文件。
     *
     * 这里直接把那台机器的 pairedAt 抹掉来造现场：HTTP 面上没有「把一台带席位的机器
     * 变成未配对」的入口（那是好事），但库里出现这种行是完全可能的。
     */
    await test('粘住的机器坏了要报出来，不能悄悄换一台', async () => {
      const require = createRequire(`${gwRoot}/package.json`)
      const pg = require('pg')
      const client = new pg.Client({ connectionString: PG_URL })
      await client.connect()
      try {
        await client.query(`set search_path to ${SCHEMA}`)
        const mine = await client.query(
          'select distinct "machineId" from seat_runtimes where "accountId" = (select id from accounts where email = $1)',
          ['member1@machine.test'],
        )
        assert(mine.rows.length === 1, `member1 应只在一台机器上，实际 ${mine.rows.length} 台`)
        const stuck = mine.rows[0].machineId

        const before = await client.query('select "pairedAt" from machines where id = $1', [stuck])
        await client.query('update machines set "pairedAt" = null where id = $1', [stuck])
        try {
          const r = await req(gwBase, 'POST', '/runtime/deploy', {
            token: memberTok,
            body: { botId: botB, update: true },
          })
          assert(r.status === 409, `粘住的机器坏了应 409，得到 ${r.status} ${r.text}`)
          assert(String(r.json.error).includes('还没配对好'), `报错要说清楚是哪一步：${r.text}`)
          // 而且**不能**把他挪到别的机器上。
          const after = await client.query(
            'select distinct "machineId" from seat_runtimes where "accountId" = (select id from accounts where email = $1)',
            ['member1@machine.test'],
          )
          assert(after.rows.length === 1 && after.rows[0].machineId === stuck, '人被挪到别的机器上了')
        } finally {
          await client.query('update machines set "pairedAt" = $2 where id = $1', [stuck, before.rows[0].pairedAt])
        }
      } finally {
        await client.end().catch(() => {})
      }
    })

    /**
     * 删公司要把机器上的席位一起拆掉。
     *
     * deleteCompany 只是 `delete from seat_runtimes`，机器上那套 systemd 单元、noVNC、
     * 以及 3200+N / 6081+N 那组端口会继续跑，而库里再也没有指针能找回它们——机器改派
     * 给别的公司之后，allocateSlot 扫的是空表，会把同一批槽位再分出去，新席位起不来。
     *
     * 用一家**新公司**做，免得动到上面那套已经铺好的现场。部署走 stub（不联系管家），
     * 所以假管家只需要答 DELETE 那一下。
     */
    await test('删公司会把机器上的席位拆掉，不是只删库里的行', async () => {
      const seen = []
      const fake = createServer((r, res) => {
        seen.push(`${r.method} ${r.url}`)
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
      })
      const fakePort = await freePort()
      await new Promise((ok, bad) => {
        fake.once('error', bad)
        fake.listen(fakePort, '127.0.0.1', ok)
      })
      try {
        const co = await createCompany(req, gwBase, {
          ownerToken: ownerTok,
          email: 'admin@doomed.test',
          password: 'correct-horse',
          companyName: 'Doomed',
          slug: 'doomed',
          // 这家是要被真删掉的。有订单或充值就必须留档（DELETE 会 409），
          // 所以别给它充钱——它也不需要，这一条验的是拆席位，不是计费。
          topup: 0,
        })
        const code = await req(gwBase, 'POST', `/platform/orgs/${co.company.id}/pairing-code`, { token: ownerTok })
        assert(code.status === 201, `配对码 ${code.status} ${code.text}`)
        const paired = await req(gwBase, 'POST', '/machines/pair', {
          body: { code: code.json.code, managerPort: fakePort, managerVersion: '1.0.0', protocol: 1 },
        })
        assert(paired.status === 201, `配对 ${paired.status} ${paired.text}`)

        // 管理员也是员工：自己给自己建一个（公司这一层只剩模版，不再建 Bot）。
        const bot = await req(gwBase, 'POST', '/runtime/bots', {
          token: co.token,
          body: { name: '注定被删的 Bot' },
        })
        assert(bot.status === 201, `建 bot ${bot.status} ${bot.text}`)
        const deployed = await req(gwBase, 'POST', '/runtime/deploy', {
          token: co.token,
          body: { botId: bot.json.bot.id },
        })
        assert(deployed.status === 200, `部署 ${deployed.status} ${deployed.text}`)
        const seatId = deployed.json.seatId
        assert(seatId, `部署结果里没有 seatId：${deployed.text}`)

        seen.length = 0
        const gone = await req(gwBase, 'DELETE', `/orgs/${co.company.id}`, { token: ownerTok })
        assert(gone.status === 200, `删公司 ${gone.status} ${gone.text}`)
        assert(
          seen.some((x) => x === `DELETE /seats/${seatId}`),
          `管家没收到拆席位的请求，只看到 ${JSON.stringify(seen)}`,
        )
        const after = await req(gwBase, 'GET', `/orgs/${co.company.id}`, { token: ownerTok })
        assert(after.status === 404, `公司应该删掉了，得到 ${after.status}`)
      } finally {
        await closeServer(fake, '假管家')
      }
    })

    /**
     * 删一颗 Bot 要连它名下的席位一起拆。
     *
     * 只删目录项的话，机器上那套 systemd 单元还在跑、还占着 slot 和端口，而库里已经
     * 没有任何东西指向它了——下一个人的席位于是起不来，现场没有一条线索指回这次删除。
     * 全局 Bot 尤其要命：它可能被好几家公司各自部署过，按公司查会漏掉别家那些。
     */
    await test('删 Bot 会把它名下的席位一起拆掉，不是只删目录项', async () => {
      const seen = []
      const fake = createServer((r, res) => {
        seen.push(`${r.method} ${r.url}`)
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
      })
      const fakePort = await freePort()
      await new Promise((ok, bad) => {
        fake.once('error', bad)
        fake.listen(fakePort, '127.0.0.1', ok)
      })
      try {
        const co = await createCompany(req, gwBase, {
          ownerToken: ownerTok,
          email: 'admin@delbot.test',
          password: 'correct-horse',
          companyName: 'DelBot',
          slug: 'delbot',
        })
        const code = await req(gwBase, 'POST', `/platform/orgs/${co.company.id}/pairing-code`, { token: ownerTok })
        assert(code.status === 201, `配对码 ${code.status} ${code.text}`)
        const paired = await req(gwBase, 'POST', '/machines/pair', {
          body: { code: code.json.code, managerPort: fakePort, managerVersion: '1.0.0', protocol: 1 },
        })
        assert(paired.status === 201, `配对 ${paired.status} ${paired.text}`)

        const gBot = await req(gwBase, 'POST', '/platform/bots', { token: ownerTok, body: { name: '要被删的全局 Bot' } })
        assert(gBot.status === 201, `建全局 bot ${gBot.status} ${gBot.text}`)
        const deployed = await req(gwBase, 'POST', '/runtime/deploy', {
          token: co.token,
          body: { botId: gBot.json.bot.id },
        })
        assert(deployed.status === 200, `部署 ${deployed.status} ${deployed.text}`)
        const seatId = deployed.json.seatId

        seen.length = 0
        const del = await req(gwBase, 'DELETE', `/platform/bots/${gBot.json.bot.id}`, { token: ownerTok })
        assert(del.status === 200, `删 bot ${del.status} ${del.text}`)
        assert(del.json.seats === 1, `回执没说拆了几个席位：${del.text}`)
        assert(
          seen.some((x) => x === `DELETE /seats/${seatId}`),
          `管家没收到拆席位的请求，只看到 ${JSON.stringify(seen)}`,
        )
        // 库里那一行也得没：留着的话 slot 立刻会被下一个账号分走，而端口还占着。
        const rt = await req(gwBase, 'GET', `/platform/orgs/${co.company.id}/accounts/${co.account.id}/runtime`, {
          token: ownerTok,
        })
        assert(rt.status === 200, `runtime ${rt.status} ${rt.text}`)
        assert(
          !(rt.json.runtimes || []).some((x) => x.seatId === seatId),
          `席位行还在：${rt.text}`,
        )
      } finally {
        await closeServer(fake, '假管家')
      }
    })

    /**
     * 席位拆不掉时，**Bot 照样删得掉**。
     *
     * 以前是拆不掉就 502、一个字都不删。而管家拆席位的顺序是「先停单元再收拾目录」：
     * 中间任何一步出岔子（单元卡在 stopping、目录不在它该在的位置、超时），Bot 已经
     * 聊不了了，删除却每次都以同一个理由失败——界面上于是永远挂着一颗既用不了也删不
     * 掉的 Bot，机器管理里还列着它的席位。线上真出过。
     *
     * 现在拆不掉的席位留成墓碑：行留着（slot 不会被下一个人分走），Bot 和它名下的
     * 会话索引照删，机器修好之后从机器详情页点一下「清理」收尾。
     */
    await test('席位拆不掉：Bot 照删、席位留成待清理、清理入口能收尾', async () => {
      let refuse = true
      const seen = []
      const fake = createServer((r, res) => {
        seen.push(`${r.method} ${r.url}`)
        if (r.method === 'DELETE' && refuse) {
          res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"remove script exited 1"}')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
      })
      const fakePort = await freePort()
      await new Promise((ok, bad) => {
        fake.once('error', bad)
        fake.listen(fakePort, '127.0.0.1', ok)
      })
      try {
        const co = await createCompany(req, gwBase, {
          ownerToken: ownerTok,
          email: 'admin@stuck.test',
          password: 'correct-horse',
          companyName: 'Stuck',
          slug: 'stuck',
        })
        const code = await req(gwBase, 'POST', `/platform/orgs/${co.company.id}/pairing-code`, { token: ownerTok })
        assert(code.status === 201, `配对码 ${code.status} ${code.text}`)
        const paired = await req(gwBase, 'POST', '/machines/pair', {
          body: { code: code.json.code, managerPort: fakePort, managerVersion: '1.0.0', protocol: 1 },
        })
        assert(paired.status === 201, `配对 ${paired.status} ${paired.text}`)
        const machineId = paired.json.machineId

        const bot = await req(gwBase, 'POST', '/runtime/bots', { token: co.token, body: { name: '拆不掉的 Bot' } })
        assert(bot.status === 201, `建 bot ${bot.status} ${bot.text}`)
        const botId = bot.json.bot.id
        const deployed = await req(gwBase, 'POST', '/runtime/deploy', { token: co.token, body: { botId } })
        assert(deployed.status === 200, `部署 ${deployed.status} ${deployed.text}`)
        const seatId = deployed.json.seatId

        // 这一条只测拆席位失败后的墓碑；不要造会话，否则新删除协议会先要求真实 Bot
        // 完成终审，而这台假管家没有运行 Bot。无会话仍会先落一笔 empty 终审。

        // 分组里对它的引用也要跟着没：留着的话那一格指向一个不存在的 Bot，界面上
        // 是个空位，谁也说不清它原来是什么。
        const group = await req(gwBase, 'POST', `/orgs/${co.company.id}/accounts/groups`, {
          token: co.token,
          body: { name: '带 Bot 的组', role: 'member', members: [co.account.id], agents: [botId] },
        })
        assert(group.status === 201, `建分组 ${group.status} ${group.text}`)
        assert((group.json.group.agents || []).includes(botId), `分组没记住这颗 Bot：${group.text}`)

        const del = await req(gwBase, 'DELETE', `/runtime/bots/${botId}`, { token: co.token })
        assert(del.status === 200, `删 bot ${del.status} ${del.text}`)
        assert((del.json.orphans || []).length === 1, `回执没说哪个席位没拆掉：${del.text}`)
        const gone = await req(gwBase, 'GET', `/runtime/bots/${botId}`, { token: co.token })
        assert(gone.status === 404, `Bot 应该删掉了，得到 ${gone.status} ${gone.text}`)
        const roster = await req(gwBase, 'GET', `/orgs/${co.company.id}/accounts`, { token: co.token })
        assert(roster.status === 200, `名册 ${roster.status} ${roster.text}`)
        assert(
          !(roster.json.groups || []).some((g) => (g.agents || []).includes(botId)),
          `分组里还留着这颗 Bot：${roster.text}`,
        )

        // 席位那行**必须留着**：删掉的话 slot 立刻能被下一个人分走，而机器上那套
        // 单元还占着 3200+N / 6081+N。
        const detail = await req(gwBase, 'GET', `/platform/machines/${machineId}`, { token: ownerTok })
        assert(detail.status === 200, `机器详情 ${detail.status} ${detail.text}`)
        const row = (detail.json.seatList || []).find((x) => x.seatId === seatId)
        assert(row, `席位行不见了：${detail.text}`)
        assert(row.status === 'error' && row.orphan === true, `席位没标成待清理：${JSON.stringify(row)}`)

        // 活着的席位不许从机器页掀掉——那是「删 Bot」的事。
        const live = (detail.json.seatList || []).find((x) => x.orphan === false)
        if (live) {
          const denied = await req(gwBase, 'DELETE', `/platform/machines/${machineId}/seats/${live.seatId}`, {
            token: ownerTok,
          })
          assert(denied.status === 409, `Bot 还在的席位应该 409，得到 ${denied.status} ${denied.text}`)
        }

        // 机器恢复之后，清理入口把这行收掉。
        refuse = false
        seen.length = 0
        const cleaned = await req(gwBase, 'DELETE', `/platform/machines/${machineId}/seats/${seatId}`, {
          token: ownerTok,
        })
        assert(cleaned.status === 200, `清理 ${cleaned.status} ${cleaned.text}`)
        assert(
          seen.some((x) => x === `DELETE /seats/${seatId}`),
          `管家没收到重试的拆席位请求，只看到 ${JSON.stringify(seen)}`,
        )
        const after = await req(gwBase, 'GET', `/platform/machines/${machineId}`, { token: ownerTok })
        assert(
          !(after.json.seatList || []).some((x) => x.seatId === seatId),
          `席位行还在：${after.text}`,
        )
      } finally {
        await closeServer(fake, '假管家')
      }
    })

  } finally {
    if (gw && !gw._exited) {
      try {
        gw.kill('SIGTERM')
      } catch {}
      await sleep(400)
      try {
        gw.kill('SIGKILL')
      } catch {}
    }
    try {
      rmSync(GW_HOME, { recursive: true, force: true })
    } catch {}
  }
}
