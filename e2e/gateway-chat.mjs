/**
 * Gateway 对话反代：Bot 无头运行时登记 host，Gateway 反代 SSE / 发消息。
 * 独立 home / 端口，不碰 live 3080，不碰 run.mjs 那套 /tmp/satuwork-e2e-gw。
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { createCompany } from './org.mjs'
import { publishRelease } from './release.mjs'
import { pairMachine } from './pair.mjs'
import { freePorts } from './ports.mjs'
import { closeServer } from './probe.mjs'

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function readSse(url, { token, timeout = 8000, until } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeout)
  const r = await fetch(url, {
    headers: {
      accept: 'text/event-stream',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    signal: ac.signal,
  })
  const events = []
  let text = ''
  if (!r.ok || !r.body) {
    text = await r.text().catch(() => '')
    clearTimeout(timer)
    return { status: r.status, events, text }
  }
  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let idx
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data: ')) continue
          try {
            events.push(JSON.parse(line.slice(6)))
          } catch {}
        }
        if (until && until(events)) {
          clearTimeout(timer)
          ac.abort()
          return { status: r.status, events, text }
        }
      }
    }
  } catch {
    /* abort / timeout */
  } finally {
    clearTimeout(timer)
    try {
      ac.abort()
    } catch {}
  }
  return { status: r.status, events, text }
}

export async function runGatewayChat({ gwRoot, botRoot, test, req, start, waitHttp, assert, log, treeHas }) {
  const GW_HOME = tmpOf('satuwork-e2e-chat-gw')
  const BOT_HOME = tmpOf('satuwork-e2e-chat-bot')
  const [GW_PORT, BOT_PORT, STUB_PORT] = await freePorts(3)
  const MACHINE_TOK = 'e2e-chat-machine'
  const PLATFORM_TOK = 'e2e-chat-platform'
  const gwBase = `http://127.0.0.1:${GW_PORT}`
  const botBase = `http://127.0.0.1:${BOT_PORT}`
  const MARKER = 'CHAT-BODY-MUST-NOT-LAND-ON-GATEWAY-7F3A'

  rmSync(GW_HOME, { recursive: true, force: true })
  rmSync(BOT_HOME, { recursive: true, force: true })

  let gw
  let botChild
  log('\n# gateway-chat')

  try {
    gw = start('chat-gw', ['--import', 'tsx', join(gwRoot, 'src/index.ts')], {
      cwd: gwRoot,
      env: {
        SATUWORK_GATEWAY_HOME: GW_HOME,
        GATEWAY_DATABASE_URL: PG_URL,
        GATEWAY_PG_SCHEMA: schemaOf('e2e_chat'),
        GATEWAY_PG_RESET: '1',
        GATEWAY_HOST: '127.0.0.1',
        GATEWAY_PORT: String(GW_PORT),
        GATEWAY_MACHINE_TOKEN: MACHINE_TOK,
        GATEWAY_PLATFORM_TOKEN: PLATFORM_TOK,
        GATEWAY_ACCESS_HOST: 'satuwork.com',
        GATEWAY_SEED_OWNER: '1',
        GATEWAY_OWNER_EMAIL: 'owner@chat.test',
        GATEWAY_OWNER_PASSWORD: 'test-owner-chat',
        SATUWORK_DEPLOY_STUB: '1',
      },
    })
    // 带上 child：起不来时有用的是它的输出，不是三十秒后那句「等不到」。
    await waitHttp(gwBase + '/health', { child: gw, what: 'chat gateway' })

    const reg = await createCompany(req, gwBase, {
      ownerEmail: 'owner@chat.test',
      ownerPassword: 'test-owner-chat',
      email: 'admin@chat.test',
      password: 'correct-horse',
      companyName: 'ChatCo',
      slug: 'chatco',
      seats: 2,
    })
    const adminTok = reg.token
    const orgId = reg.company.id

    const memberCreate = await req(gwBase, 'POST', `/orgs/${orgId}/accounts`, {
      token: adminTok,
      body: { email: 'member@chat.test', password: 'correct-horse', role: 'member' },
    })
    assert(memberCreate.status === 201, `member ${memberCreate.status} ${memberCreate.text}`)
    const memberLogin = await req(gwBase, 'POST', '/auth/login', {
      body: { email: 'member@chat.test', password: 'correct-horse' },
    })
    assert(memberLogin.status === 200, `member login ${memberLogin.status}`)
    const memberTok = memberLogin.json.token

    const ownerTok = reg.ownerToken
    const adminId = reg.account.id
    const seat = await req(gwBase, 'GET', `/platform/accounts/${adminId}`, { token: ownerTok })
    assert(seat.status === 200, `seat secrets ${seat.status} ${seat.text}`)
    const seatAccess = seat.json.accessToken
    const seatApiKey = seat.json.apiKey

    /**
     * 用**全局 Bot**：下面几条要验的是「同一颗 Bot 在管理员和员工两边都在名册里」，
     * 而员工自己建的 Bot 只有本人看得见（公司这一层现在是一份模版，不再有共享 Bot）。
     */
    const createdBot = await req(gwBase, 'POST', '/platform/bots', {
      token: ownerTok,
      body: { name: '对话 Bot' },
    })
    assert(createdBot.status === 201, `global bot ${createdBot.status} ${createdBot.text}`)
    const catalogBotId = createdBot.json.bot.id
    let machineTok

    await test('owner GET /runtime/bots → 403', async () => {
      const r = await req(gwBase, 'GET', '/runtime/bots', { token: ownerTok })
      assert(r.status === 403, `owner ${r.status} ${r.text}`)
    })

    await test('成员无实例 GET /runtime/bots → 200 名册有 bot、runtime 空', async () => {
      const r = await req(gwBase, 'GET', '/runtime/bots', { token: memberTok })
      assert(r.status === 200, `member ${r.status} ${r.text}`)
      assert(Array.isArray(r.json.bots), 'bots array')
      const hit = (r.json.bots || []).find((b) => b.id === catalogBotId)
      assert(hit, '名册没有那颗全局 Bot')
      assert(hit.runtime == null, 'member runtime 应为空')
    })

    await test('管理员无实例 GET /runtime/bots → 200', async () => {
      const r = await req(gwBase, 'GET', '/runtime/bots', { token: adminTok })
      assert(r.status === 200, `admin ${r.status} ${r.text}`)
      const hit = (r.json.bots || []).find((b) => b.id === catalogBotId)
      assert(hit, 'admin 名册没有公司 Bot')
      assert(hit.runtime == null, 'admin runtime 应为空')
    })

    await test('无实例 GET /runtime/bots/:id/session → 503 实例还没上线', async () => {
      const r = await req(gwBase, 'GET', `/runtime/bots/${catalogBotId}/session`, { token: adminTok })
      assert(r.status === 503, `session ${r.status} ${r.text}`)
      assert(String(r.json.error || r.text).includes('实例还没上线'), '503 文案')
    })

    const paired = await pairMachine({ req, gwBase, ownerTok, orgId })
    machineTok = paired.token
    assert(typeof machineTok === 'string' && machineTok.startsWith('smt_'), 'smt_')

    await test('POST /internal/instances/:id/ready 校验 host / 账号 / botId', async () => {
      const orgMach = await req(gwBase, 'GET', `/orgs/${orgId}/machine`, { token: adminTok })
      assert(!Object.prototype.hasOwnProperty.call(orgMach.json.machine || {}, 'token'), 'admin machine 带 token')

      const me = await req(gwBase, 'GET', '/me', { token: adminTok })
      const accountId = me.json.account.id
      const boot = await req(gwBase, 'POST', `/internal/instances/${accountId}/ready`, {
        token: MACHINE_TOK,
        body: { host: 'http://127.0.0.1:9', botId: catalogBotId },
      })
      assert(boot.status === 401, `bootstrap ready ${boot.status}`)
      const missBot = await req(gwBase, 'POST', `/internal/instances/${accountId}/ready`, {
        token: machineTok,
        body: { host: 'http://127.0.0.1:9' },
      })
      assert(missBot.status === 400, `missing botId ${missBot.status}`)
      const miss = await req(gwBase, 'POST', '/internal/instances/no-such/ready', {
        token: machineTok,
        body: { host: 'http://127.0.0.1:9', botId: catalogBotId },
      })
      assert(miss.status === 404, `missing account ${miss.status}`)
      const bad = await req(gwBase, 'POST', `/internal/instances/${accountId}/ready`, {
        token: machineTok,
        body: { host: 'ftp://127.0.0.1:9', botId: catalogBotId },
      })
      assert(bad.status === 400, `bad proto ${bad.status}`)
      const pathHost = await req(gwBase, 'POST', `/internal/instances/${accountId}/ready`, {
        token: machineTok,
        body: { host: 'http://127.0.0.1:9/api', botId: catalogBotId },
      })
      assert(pathHost.status === 400, `path host ${pathHost.status}`)
      const never = await req(gwBase, 'POST', `/internal/instances/${accountId}/ready`, {
        token: machineTok,
        body: { host: botBase, botId: catalogBotId },
      })
      assert(never.status === 404, `never deployed ${never.status} ${never.text}`)
      assert(String(never.json.error || never.text).includes('还没有部署'), '404 文案')
    })

    await publishRelease({ req, gwBase, token: ownerTok, version: '0.1.0', note: 'e2e-chat' })
    const dep = await req(gwBase, 'POST', '/runtime/deploy', {
      token: adminTok,
      body: { botId: catalogBotId },
    })
    assert(dep.status === 200, `stub deploy ${dep.status} ${dep.text}`)
    assert(!Object.prototype.hasOwnProperty.call(dep.json, 'botPort'), 'deploy 含 botPort')

    botChild = start('chat-bot', ['--import', 'tsx', join(botRoot, 'e2e-boot.mjs')], {
      cwd: botRoot,
      env: {
        SATUWORK_HOME: BOT_HOME,
        SATUWORK_PORT: String(BOT_PORT),
        SATUWORK_BOT_ID: catalogBotId,
        GATEWAY_URL: gwBase,
        GATEWAY_TOKEN: seatAccess,
        GATEWAY_API_KEY: seatApiKey,
        E2E_STUB_LLM: '1',
      },
    })
    await waitHttp(botBase + '/api/health', { timeout: 45000 })
    assert(!botChild._exited, 'bot 启动后就退出了')

    const botId = catalogBotId
    let sessionId

    await test('Bot 上报 ready 后 GET /runtime/bots/:id/session → sessionId', async () => {
      const deadline = Date.now() + 20000
      let last
      while (Date.now() < deadline) {
        const r = await req(gwBase, 'GET', `/runtime/bots/${botId}/session`, { token: adminTok })
        last = r
        if (r.status === 200 && typeof r.json.sessionId === 'string' && r.json.sessionId) {
          sessionId = r.json.sessionId
          return
        }
        await sleep(200)
      }
      assert(false, `ready 未到 ${last?.status} ${last?.text}`)
    })

    await test('POST /runtime/sessions/:id/messages ping → accepted/steered', async () => {
      const r = await req(gwBase, 'POST', `/runtime/sessions/${sessionId}/messages`, {
        token: adminTok,
        body: { text: `ping ${MARKER}` },
      })
      assert(r.status === 200, `message ${r.status} ${r.text}`)
      assert(r.json.accepted === true || r.json.steered === true, 'accepted/steered')
    })

    await test('斜杠命令那两条经 Gateway 转得到席位，拒绝的原话原样透回', async () => {
      /**
       * 这一跳只验**通道**：要票、找得到席位、席位的判断（含 4xx 和那句中文原话）
       * 一个字不改地回到浏览器。业务判断全在席位那边，Gateway 这层什么都不该懂。
       *
       * 状态码按席位那头的判断钉死（bot/src/agent/index.ts 的 compactNow / resetContext）：
       *
       * - compact：这条会话到这里只有一轮，要么还在跑（409「还在跑」），要么太短没有
       *   可压的历史（409「太短」）——两条路都是 409，且都带一句中文原话。
       * - reset：跑完了那一轮就切得动（200，reset:true）；还在跑就是 409。哪一种由那个
       *   假模型什么时候收口决定，但**只能是这两种**，而且拒的那条必须带 error。
       *
       * 以前只挡 5xx，等于「随便回什么都行」。
       */
      for (const act of ['compact', 'reset']) {
        const anon = await req(gwBase, 'POST', `/runtime/sessions/${sessionId}/${act}`)
        assert(anon.status === 401, `${act} 无票该 401，实际 ${anon.status} ${anon.text}`)

        const r = await req(gwBase, 'POST', `/runtime/sessions/${sessionId}/${act}`, { token: adminTok })
        if (act === 'compact') {
          assert(r.status === 409, `compact 在只有一轮的会话上该 409，实际 ${r.status} ${r.text}`)
        } else {
          assert(r.status === 200 || r.status === 409, `reset 只能是 200 或 409，实际 ${r.status} ${r.text}`)
          if (r.status === 200) assert(r.json && r.json.reset === true, `reset 200 却没带 reset:true：${r.text}`)
        }
        if (r.status !== 200) {
          assert(r.json && typeof r.json.error === 'string' && r.json.error, `${act} 被拒了却没说为什么：${r.status} ${r.text}`)
        }
      }
    })

    await test('@ 点名：Gateway 把失效的剔掉，不让它进席位', async () => {
      /**
       * 这一条守的是不变量：**席位收到什么就注入什么**——它信的是那张 `sat_` 票，
       * 票背后是谁由 Gateway 说了算。所以浏览器编一个连接 id 上来，必须在这一跳被
       * 挡掉，而不是让整条消息失败：用户那句话没有错，错的是一个已经失效的点名。
       */
      const r = await req(gwBase, 'POST', `/runtime/sessions/${sessionId}/messages`, {
        token: adminTok,
        body: {
          text: `mention ${MARKER}`,
          mentions: [{ kind: 'connector', id: 'conn-not-mine', label: '别人的 Gmail' }],
        },
      })
      assert(r.status === 200, `message ${r.status} ${r.text}`)
      assert(Array.isArray(r.json.droppedMentions), `该说明剔掉了什么：${r.text}`)
      assert(r.json.droppedMentions.includes('conn-not-mine'), `没剔掉伪造的点名：${r.text}`)
      assert(r.json.accepted === true || r.json.steered === true || r.json.queued === true, `这条消息本身该照发：${r.text}`)
      // 剔干净了就等于没点名，所以走的是 steering / 新一轮，不是排队。
      assert(r.json.queued !== true, '点名全被剔掉了还排队，那用户就白等一轮')
    })

    // ── 附件反代。这一跳是 proxyUpload / proxyDownload：字节从浏览器流到席位，
    //    再流回来。前面几组都是直连 bot，只有这里能验「Gateway 中间那段没把它弄坏」。
    let gwPath

    await test('经 Gateway 上传附件：落到席位的工作区', async () => {
      // 挑一段跨 chunk 边界也要拼对的内容，顺带把中文名一路带过去。
      const bytes = Buffer.from('报表内容\n第二行\n', 'utf8')
      const r = await req(gwBase, 'POST', `/runtime/sessions/${sessionId}/files`, {
        token: adminTok,
        raw: bytes,
        headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent('季度报表.txt') },
      })
      assert(r.status === 200, `upload ${r.status} ${r.text}`)
      assert(typeof r.json.path === 'string' && r.json.path.startsWith('uploads/'), `落点不对：${r.text}`)
      assert(r.json.name === '季度报表.txt', `文件名在路上坏了：${r.json.name}`)
      assert(r.json.size === bytes.length, `大小对不上：${r.json.size} ≠ ${bytes.length}`)
      gwPath = r.json.path
      // 正文只在席位磁盘上——Gateway 不该留副本，这条和「Gateway home 不含对话正文」是同一条纪律。
      assert(existsSync(join(BOT_HOME, 'work', gwPath)), '席位磁盘上没有这个文件')
      assert(!treeHas(GW_HOME, '报表内容'), 'Gateway 落了一份附件正文')
    })

    await test('经 Gateway 预览：字节一个不差，安全头齐全', async () => {
      const r = await req(gwBase, 'GET', `/runtime/sessions/${sessionId}/files?path=${encodeURIComponent(gwPath)}`, {
        token: adminTok,
      })
      assert(r.status === 200, `preview ${r.status} ${r.text}`)
      assert(r.text === '报表内容\n第二行\n', `内容对不上：${JSON.stringify(r.text)}`)
      assert(r.headers.get('x-content-type-options') === 'nosniff', '少了 nosniff')
      // 这段字节是用户传的，却挂在 Gateway 的源上。没有 sandbox，一个带脚本的附件
      // 就能在登录态里跑起来。
      const csp = String(r.headers.get('content-security-policy') || '')
      assert(csp.includes('sandbox'), `少了 CSP sandbox：${csp}`)
    })

    await test('经 Gateway 列工作区：右栏那棵树看得见刚传上去的文件', async () => {
      // 这一跳是右栏文件树的全部数据来源（见 chat.js 的 workspacePanel）。它和上面
      // 那条预览必须给出**同一个 path**，否则树上点开就是 404。
      const dir = gwPath.split('/').slice(0, -1).join('/')
      const r = await req(gwBase, 'GET', `/runtime/sessions/${sessionId}/workspace?path=${encodeURIComponent(dir)}`, {
        token: adminTok,
      })
      assert(r.status === 200, `list ${r.status} ${r.text}`)
      const hit = (r.json.entries || []).find((e) => e.path === gwPath)
      assert(hit, `列表里没有刚传的那个文件：${r.text}`)
      assert(hit.dir === false && hit.size > 0, `条目不对：${JSON.stringify(hit)}`)
      const root = await req(gwBase, 'GET', `/runtime/sessions/${sessionId}/workspace`, { token: adminTok })
      assert(root.status === 200, `list root ${root.status} ${root.text}`)
      assert((root.json.entries || []).some((e) => e.name === 'uploads' && e.dir), `根目录里没有 uploads：${root.text}`)
      // 和预览同一道门：不是自己的会话、没登录，一律进不来。
      const other = await req(gwBase, 'GET', `/runtime/sessions/${sessionId}/workspace`, { token: memberTok })
      assert(other.status >= 400, `成员列到了管理员会话的工作区：${other.status}`)
      const anon = await req(gwBase, 'GET', `/runtime/sessions/${sessionId}/workspace`)
      assert(anon.status === 401, `未登录列目录 ${anon.status}`)
    })

    await test('附件反代也认账号：别人的会话碰不到', async () => {
      const r = await req(gwBase, 'GET', `/runtime/sessions/${sessionId}/files?path=${encodeURIComponent(gwPath)}`, {
        token: memberTok,
      })
      assert(r.status >= 400, `成员读到了管理员的附件：${r.status} ${r.text}`)
      const up = await req(gwBase, 'POST', `/runtime/sessions/${sessionId}/files`, {
        token: memberTok,
        raw: Buffer.from('x'),
        headers: { 'content-type': 'application/octet-stream', 'x-filename': 'a.txt' },
      })
      assert(up.status >= 400, `成员往管理员的会话里传了文件：${up.status} ${up.text}`)
      const anon = await req(gwBase, 'GET', `/runtime/sessions/${sessionId}/files?path=${encodeURIComponent(gwPath)}`)
      assert(anon.status === 401, `未登录预览 ${anon.status}`)
    })

    await test('SSE 含 user/message ping（或 request/header）', async () => {
      const sse = await readSse(`${gwBase}/runtime/sessions/${encodeURIComponent(sessionId)}/events`, {
        token: adminTok,
        timeout: 8000,
        until: (events) =>
          events.some((e) => e.type === 'user/message' || e.type === 'request/header'),
      })
      assert(sse.status === 200, `sse ${sse.status} ${sse.text}`)
      const types = sse.events.map((e) => e.type)
      const user = sse.events.find((e) => e.type === 'user/message')
      const header = sse.events.find((e) => e.type === 'request/header')
      assert(user || header, `缺 user/message 与 request/header：${types.join(',')}`)
      if (user) {
        const blob = JSON.stringify(user)
        assert(blob.includes('ping') && blob.includes(MARKER), `user/message 无 ping：${blob.slice(0, 400)}`)
      }
    })

    await test('replay/done 带着「在不在跑」，而且是真 bot 给的', async () => {
      // 界面判断「正在处理」原来只能扫事件：从头扫，遇 turn/start 算在跑、遇 turn/end
      // 算跑完。这个猜法要求历史完整，而它经常不完整（流断在重放中途、或者进程半路
      // 没了、那条 turn/end 根本没写成），于是界面一直挂着「正在处理」。所以让知道的
      // 人说：bot 在 replay/done 上带 live。这里要验的是它真的一路走到了 Gateway 出口。
      const sse = await readSse(`${gwBase}/runtime/sessions/${encodeURIComponent(sessionId)}/events`, {
        token: adminTok,
        timeout: 8000,
        until: (events) => events.some((e) => e.type === 'replay/done'),
      })
      assert(sse.status === 200, `sse ${sse.status} ${sse.text}`)
      const done = sse.events.find((e) => e.type === 'replay/done')
      assert(done, `没有 replay/done：${sse.events.map((e) => e.type).join(',')}`)
      assert(typeof done.live === 'boolean', `replay/done 没带 live：${JSON.stringify(done)}`)
      // 标记必须排在历史**后面**——它的意思就是「前面那些都是历史」。
      const at = sse.events.indexOf(done)
      assert(
        sse.events.slice(0, at).some((e) => e.type === 'session'),
        'replay/done 跑到历史前面去了，那它就不再是「历史放完了」的意思',
      )
    })

    await test('历史那条路：不带 before 就是「最新的一页」，和流是同一份事件', async () => {
      // 打开对话时前端并发发两个请求：历史走这条 HTTP，实时走 SSE（只垫一轮）。整块
      // 设计压在一个前提上——`?turns=N` 不带 `before` 返回的是**最近** N 轮，而不是
      // 最早的 N 轮。切片函数本身有 replay-slice 那几条钉着，这里钉的是它经 Gateway
      // 反代之后那一路：路径、鉴权、游标字段都得原样出来。
      const r = await req(gwBase, 'GET', `/runtime/sessions/${encodeURIComponent(sessionId)}/history?turns=20`, {
        token: adminTok,
      })
      assert(r.status === 200, `history ${r.status} ${JSON.stringify(r.json)}`)
      const events = (r.json && r.json.events) || []
      assert(events.length > 0, `历史是空的：${JSON.stringify(r.json).slice(0, 300)}`)
      assert(typeof r.json.hasMore === 'boolean', `没带 hasMore（「加载更早」全靠它）：${JSON.stringify(r.json).slice(0, 200)}`)
      assert(
        r.json.firstSeq === events[0].seq,
        `firstSeq 和头一条对不上（它是往前翻的游标）：${r.json.firstSeq} vs ${events[0].seq}`,
      )
      // seq 必须单调——归并靠的就是这个（进桶「比尾巴大才收」、补历史「比头小才收」）。
      for (let i = 1; i < events.length; i++) {
        assert(events[i].seq > events[i - 1].seq, `seq 不单调：${events[i - 1].seq} → ${events[i].seq}`)
      }
      // 和流上那份是同一批事件：这一路上的 ping 在两边都得找得到。
      const blob = JSON.stringify(events)
      assert(blob.includes(MARKER), `历史里没有这一轮的 ping，多半取成了最早那几轮：${blob.slice(0, 400)}`)
    })

    await test('历史那条路也认账号：别人的会话拉不到', async () => {
      const r = await req(gwBase, 'GET', `/runtime/sessions/${encodeURIComponent(sessionId)}/history?turns=20`, {
        token: memberTok,
      })
      assert(r.status !== 200, `成员把管理员的历史拉走了：${r.status} ${JSON.stringify(r.json).slice(0, 200)}`)
    })

    await test('bot 真的会写日志——那 16 处 ?.warn?.() 不能又是空转', async () => {
      // 挂上 logger 服务之前，cordis.yml 里没有任何 logger 插件，ctx.logger 是
      // undefined，代码里那 16 处可选链一条都没输出过。席位的 journal 里除了 systemd
      // 和启动那两行什么都没有，查问题只能靠猜。**这条测的就是「日志真的出来了」。**
      const sse = await readSse(`${gwBase}/runtime/sessions/${encodeURIComponent(sessionId)}/events`, {
        token: adminTok,
        timeout: 8000,
        until: (events) => events.some((e) => e.type === 'replay/done'),
      })
      assert(sse.status === 200, `sse ${sse.status}`)
      // 日志是异步刷出去的，给它一拍。
      await new Promise((r) => setTimeout(r, 300))
      const out = botChild._out || ''
      assert(/\[INFO\]/.test(out), `bot 一行日志都没有，logger 多半又没挂上：${out.slice(-400)}`)
      assert(
        /sse: 会话 .*live=(true|false)/.test(out),
        `没写出接流那行（live 是断案的关键）：${out.slice(-500)}`,
      )
    })

    await test('Bot GET / → JSON 404，不是 HTML SPA', async () => {
      const r = await req(botBase, 'GET', '/')
      assert(r.status === 404, `bot / ${r.status} ${r.text}`)
      assert(typeof r.json === 'object' && r.json && r.json.error, `not json ${r.text.slice(0, 120)}`)
      assert(!String(r.text).toLowerCase().includes('<!doctype html>'), 'bot 仍发 SPA')
      assert(!String(r.text).includes('<html'), 'bot 仍发 html')
    })

    await test('Gateway SPA GET /chat 与 /a/:id 返回 HTML', async () => {
      const a = await req(gwBase, 'GET', '/chat')
      assert(a.status === 200, `spa /chat ${a.status}`)
      assert(String(a.text).includes('<!doctype html>') || String(a.text).includes('Satuwork'), 'spa /chat html')
      const b = await req(gwBase, 'GET', `/a/${botId}`)
      assert(b.status === 200, `spa /a ${b.status}`)
      assert(String(b.text).includes('<!doctype html>') || String(b.text).includes('Satuwork'), 'spa /a html')
    })

    await test('成员在管理员实例上线后名册仍 200，session 503', async () => {
      const r = await req(gwBase, 'GET', '/runtime/bots', { token: memberTok })
      assert(r.status === 200, `member after ready ${r.status} ${r.text}`)
      const hit = (r.json.bots || []).find((b) => b.id === botId)
      assert(hit, '成员名册没有 bot')
      assert(hit.runtime == null, '成员不该看到管理员的 runtime')
      const sess = await req(gwBase, 'GET', `/runtime/bots/${botId}/session`, { token: memberTok })
      assert(sess.status === 503, `member session ${sess.status} ${sess.text}`)
    })

    await test('Gateway home 不含对话正文', async () => {
      assert(!treeHas(GW_HOME, MARKER), 'Gateway home 含聊天正文')
    })

    await test('席位凭证可直连 Bot JSON API', async () => {
      const r = await req(botBase, 'GET', '/api/bots', { token: seatAccess })
      assert(r.status === 200, `machine bots ${r.status} ${r.text}`)
      assert(Array.isArray(r.json.bots) && r.json.bots.length >= 1, 'empty')
    })

    await test('Gateway 钉住的实例名册只有 SATUWORK_BOT_ID，没有 default', async () => {
      const r = await req(botBase, 'GET', '/api/bots', { token: seatAccess })
      assert(r.status === 200, `machine bots ${r.status} ${r.text}`)
      const bots = r.json.bots || []
      assert(bots.length === 1, `bots.length ${bots.length} ${JSON.stringify(bots)}`)
      assert(bots[0].id === catalogBotId, `id ${bots[0] && bots[0].id} != ${catalogBotId}`)
      assert(!bots.some((b) => b.id === 'default'), '不该有 default')
    })

    await test('未登录 GET /api/runtime/status → 401', async () => {
      const r = await req(botBase, 'GET', '/api/runtime/status')
      assert(r.status === 401, `unauth status ${r.status} ${r.text}`)
    })

    await test('席位凭证 GET /api/runtime/status → 200 且只钉一颗', async () => {
      const r = await req(botBase, 'GET', '/api/runtime/status', { token: seatAccess })
      assert(r.status === 200, `status ${r.status} ${r.text}`)
      const bots = r.json.bots || []
      assert(bots.length === 1, `status bots ${bots.length}`)
      assert(bots[0].id === catalogBotId, `status id ${bots[0] && bots[0].id}`)
      assert(!bots.some((b) => b.id === 'default'), 'status 不该有 default')
    })

    // ── 日常任务 ────────────────────────────────────────────────────
    //
    // 定时那一半（到点自己跑）不在这里验：调度器最快也是秒级轮询，为它等一分钟不
    // 值得。这里验的是**除了「谁来敲这一下」以外的整条路**——排期算得对不对、试跑
    // 是不是真的把消息送进了席位的会话、跑完有没有记成 ok。到点那一下走的是同一个
    // runRoutine，区别只有流水上的 trigger 一个字。
    let routineId = ''

    await test('建一条日常任务：没给时间就不排，给了才排在未来', async () => {
      // 接口不替人发明时间：没有触发器 = 不排（`nextRunAt` 是 null）。界面上「新建」
      // 那一下会带一个「每天 09:00」过来，那是界面的默认值，不是接口的。
      const bare = await req(gwBase, 'POST', `/runtime/bots/${botId}/routines`, { token: adminTok, body: { name: '空的' } })
      assert(bare.status === 201, `bare ${bare.status} ${bare.text}`)
      assert((bare.json.routine.triggers || []).length === 0, `bare triggers ${JSON.stringify(bare.json.routine.triggers)}`)
      assert(bare.json.routine.nextRunAt === null, `bare nextRunAt ${bare.json.routine.nextRunAt}`)
      await req(gwBase, 'DELETE', `/runtime/routines/${bare.json.routine.id}`, { token: adminTok })

      // 同一条路也要认当前 Bot 的席位票：Agent 的 routine_manage 就从这里进。
      const r = await req(gwBase, 'POST', `/runtime/bots/${botId}/routines`, {
        token: seatAccess,
        body: { name: '每日简报', tz: 'UTC', triggers: [{ kind: 'schedule', every: 'day', at: '09:00', weekday: 1, day: 1 }] },
      })
      assert(r.status === 201, `create ${r.status} ${r.text}`)
      routineId = r.json.routine.id
      const triggers = r.json.routine.triggers || []
      assert(triggers.length === 1 && triggers[0].every === 'day' && triggers[0].at === '09:00', `triggers ${JSON.stringify(triggers)}`)
      // 触发器自己没写时区，就落在请求带来的那个上（界面报的是浏览器时区）。
      assert(triggers[0].tz === 'UTC', `tz ${triggers[0].tz}`)
      assert(r.json.routine.nextRunAt > Date.now(), `nextRunAt ${r.json.routine.nextRunAt}`)
      assert(r.json.routine.active === true, 'active')
    })

    await test('改时间：下一次跟着重算，算的是那个时区的那个点', async () => {
      const r = await req(gwBase, 'PATCH', `/runtime/routines/${routineId}?botId=${encodeURIComponent(botId)}`, {
        token: seatAccess,
        body: { instruction: 'ping', triggers: [{ kind: 'schedule', every: 'day', at: '21:30', weekday: 1, day: 1, tz: 'UTC' }] },
      })
      assert(r.status === 200, `patch ${r.status} ${r.text}`)
      assert(r.json.routine.instruction === 'ping', `instruction ${r.json.routine.instruction}`)
      // 期望值在这儿**另算一遍**，不复用被测的那套：抄同一段代码来对答案，等于什么都没验。
      const now = new Date()
      const want = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 21, 30)
      const expect = want > now.getTime() ? want : want + 86400000
      assert(r.json.routine.nextRunAt === expect, `nextRunAt ${new Date(r.json.routine.nextRunAt).toISOString()} != ${new Date(expect).toISOString()}`)
    })

    await test('席位票只管理当前 Bot 的日常任务', async () => {
      const list = await req(gwBase, 'GET', `/runtime/bots/${botId}/routines`, { token: seatAccess })
      assert(list.status === 200 && (list.json.routines || []).some((x) => x.id === routineId), `席位列表 ${list.status} ${list.text}`)
      // 按 routine id 的路由没有 botId 就拒：账号的席位票能覆盖多颗 Bot，不能只按 accountId 猜。
      const missing = await req(gwBase, 'GET', `/runtime/routines/${routineId}`, { token: seatAccess })
      assert(missing.status === 400, `席位没带 botId 不该放行 ${missing.status} ${missing.text}`)
      const wrong = await req(gwBase, 'GET', `/runtime/routines/${routineId}?botId=${encodeURIComponent('not-this-bot')}`, { token: seatAccess })
      assert(wrong.status === 404, `席位冒充别的 Bot 不该放行 ${wrong.status} ${wrong.text}`)
      const own = await req(gwBase, 'GET', `/runtime/routines/${routineId}?botId=${encodeURIComponent(botId)}`, { token: seatAccess })
      assert(own.status === 200 && own.json.routine.id === routineId, `席位看自己的详情 ${own.status} ${own.text}`)
      const noDelete = await req(gwBase, 'DELETE', `/runtime/routines/${routineId}?botId=${encodeURIComponent(botId)}`, { token: seatAccess })
      assert(noDelete.status === 401, `席位票不该获得删除能力 ${noDelete.status} ${noDelete.text}`)
    })

    await test('停用就不排下一次，重新启用又排上', async () => {
      const off = await req(gwBase, 'PATCH', `/runtime/routines/${routineId}`, { token: adminTok, body: { active: false } })
      assert(off.status === 200, `off ${off.status} ${off.text}`)
      assert(off.json.routine.nextRunAt === null, `off nextRunAt ${off.json.routine.nextRunAt}`)
      // 名字和指令没传，就不该被这一下抹掉。
      assert(off.json.routine.instruction === 'ping', `off instruction ${off.json.routine.instruction}`)
      const on = await req(gwBase, 'PATCH', `/runtime/routines/${routineId}`, { token: adminTok, body: { active: true } })
      assert(on.json.routine.nextRunAt > Date.now(), `on nextRunAt ${on.json.routine.nextRunAt}`)
    })

    await test('触发器形状不对 → 400，而且没把已有的那个改坏', async () => {
      const bad = await req(gwBase, 'PATCH', `/runtime/routines/${routineId}`, {
        token: adminTok,
        body: { triggers: [{ kind: 'slack', channel: '#general' }] },
      })
      assert(bad.status === 400, `bad trigger ${bad.status} ${bad.text}`)
      const still = await req(gwBase, 'GET', `/runtime/routines/${routineId}`, { token: adminTok })
      assert((still.json.routine.triggers || []).length === 1, '原来那个触发器没了')
    })

    await test('字段越界也要 400，不能静静地换成默认值', async () => {
      // `weekday: 7`（把周日写成 7）是最自然的手滑，本项目 0 才是周日。静默改成周一的
      // 话，接口回 200、界面写着「每周一」，人只会以为自己记错了。
      for (const trigger of [
        { kind: 'schedule', every: 'week', at: '09:00', weekday: 7, day: 1 },
        { kind: 'schedule', every: 'month', at: '09:00', weekday: 1, day: 99 },
        { kind: 'schedule', every: 'day', at: '随便写写', weekday: 1, day: 1 },
      ]) {
        const r = await req(gwBase, 'PATCH', `/runtime/routines/${routineId}`, { token: adminTok, body: { triggers: [trigger] } })
        assert(r.status === 400, `${JSON.stringify(trigger)} → ${r.status} ${r.text}`)
      }
      // 反过来：**没写**的字段照旧给默认值，别逼调用方为「每天」填一个假的 weekday。
      const ok = await req(gwBase, 'PATCH', `/runtime/routines/${routineId}`, {
        token: adminTok,
        body: { triggers: [{ kind: 'schedule', every: 'day', at: '21:30', tz: 'UTC' }] },
      })
      assert(ok.status === 200, `省略字段 ${ok.status} ${ok.text}`)
      assert(ok.json.routine.triggers[0].weekday === 1 && ok.json.routine.triggers[0].day === 1, '默认值没给上')
    })

    await test('用哪个模型跑：默认 utility，拨得回去，乱写的值顶回来', async () => {
      // **默认那一档是省钱的那个**（见 docs/routines.md §4）。这条断言看着琐碎，
      // 但默认值一旦被谁顺手改成 daily，账单上多出来的那笔没有任何人会察觉。
      const fresh = await req(gwBase, 'POST', `/runtime/bots/${botId}/routines`, { token: adminTok, body: { name: '默认那一档' } })
      assert(fresh.status === 201, `create ${fresh.status} ${fresh.text}`)
      assert(fresh.json.routine.modelRole === 'utility', `默认不是 utility：${fresh.json.routine.modelRole}`)
      await req(gwBase, 'DELETE', `/runtime/routines/${fresh.json.routine.id}`, { token: adminTok })

      const now = await req(gwBase, 'GET', `/runtime/routines/${routineId}`, { token: adminTok })
      assert(now.json.routine.modelRole === 'utility', `旧的那条不是 utility：${now.json.routine.modelRole}`)
      const to = await req(gwBase, 'PATCH', `/runtime/routines/${routineId}`, { token: adminTok, body: { modelRole: 'daily' } })
      assert(to.status === 200 && to.json.routine.modelRole === 'daily', `拨到 daily ${to.status} ${to.text}`)
      // 改模型不动别的：这一路和改名字、改触发器是三次独立的保存。
      assert(to.json.routine.instruction === 'ping', `instruction 被带没了 ${to.json.routine.instruction}`)
      assert((to.json.routine.triggers || []).length === 1, `triggers 被带没了 ${JSON.stringify(to.json.routine.triggers)}`)
      // 拼错的值**不能静静地存成 utility**：接口回 200、界面写着「日常模型」，跑起来
      // 却是另一个，人只会以为自己记错了。
      const bad = await req(gwBase, 'PATCH', `/runtime/routines/${routineId}`, { token: adminTok, body: { modelRole: 'Daily' } })
      assert(bad.status === 400, `乱写的值 ${bad.status} ${bad.text}`)
      const back = await req(gwBase, 'PATCH', `/runtime/routines/${routineId}`, { token: adminTok, body: { modelRole: 'utility' } })
      assert(back.status === 200 && back.json.routine.modelRole === 'utility', `拨回来 ${back.status} ${back.text}`)
    })

    /**
     * 试跑走的是工人那条路（docs/routines.md §8b）：Gateway 只登记一条流水，机器上的工人来领、
     * 发进席位、等这一轮收口、回报。这里没有真的工人，测试自己扮一个——要钉的是**整条链**：
     * 登记 → 领走 → 消息真的进了这颗 Bot 的会话 → 那一轮的结局照实回到流水上。
     */
    const asWorker = {
      due: () => req(gwBase, 'GET', '/worker/routines/due', { token: machineTok }),
      post: (runId, act, body = {}) => req(gwBase, 'POST', `/worker/routines/${runId}/${act}`, { token: machineTok, body }),
      lastSeq: async () => {
        const r = await req(gwBase, 'GET', `/runtime/sessions/${encodeURIComponent(sessionId)}/history?turns=1`, { token: adminTok })
        return Math.max(0, ...((r.json && r.json.events) || []).map((e) => Number(e.seq) || 0))
      },
      /** 等自己那一轮的 turn/end（seq 在发消息之前的游标之后），回它的 reason。 */
      turnEnd: async (afterSeq) => {
        const deadline = Date.now() + 30000
        while (Date.now() < deadline) {
          const r = await req(gwBase, 'GET', `/runtime/sessions/${encodeURIComponent(sessionId)}/history?turns=3`, { token: adminTok })
          const hit = ((r.json && r.json.events) || []).find((e) => e.seq > afterSeq && e.type === 'turn/end')
          if (hit) return String((typeof hit.data?.reason === 'string' ? hit.data.reason : hit.data?.reason?.kind) || 'completed')
          await sleep(300)
        }
        assert(false, '那一轮一直没收口')
      },
    }

    await test('试跑：登记给工人，消息真的进了席位的会话，那一轮的结局照实记下来', async () => {
      // 机器够新、在线：试跑登记那一步先看这两样（routines.ts 的 requestManualRun）。
      const hb = await req(gwBase, 'POST', `/internal/machines/${paired.machineId}/heartbeat`, { token: machineTok, body: { protocol: 8, managerVersion: 'e2e' } })
      assert(hb.status === 200, `心跳 ${hb.status} ${hb.text}`)
      const started = await req(gwBase, 'POST', `/runtime/routines/${routineId}/run?botId=${encodeURIComponent(botId)}`, { token: seatAccess, body: {} })
      assert(started.status === 200, `run ${started.status} ${started.text}`)
      const run0 = started.json.run
      assert(run0.status === 'running' && run0.trigger === 'manual' && run0.machineId === paired.machineId, `run ${JSON.stringify(run0)}`)

      const got = await asWorker.due()
      assert(got.status === 200 && got.json.jobs.length === 1 && got.json.jobs[0].runId === run0.id, `工人该领到那条试跑：${got.text}`)
      const job = got.json.jobs[0]
      assert(job.instruction === 'ping' && job.routineId === routineId, `活的内容不对：${JSON.stringify(job)}`)
      const ok = await asWorker.post(job.runId, 'started', { sessionId })
      assert(ok.status === 200 && ok.json.blocked === null, `started ${ok.status} ${ok.text}`)
      const afterSeq = await asWorker.lastSeq()
      const sent = await req(gwBase, 'POST', `/runtime/sessions/${sessionId}/messages`, {
        token: adminTok,
        body: { text: job.instruction, routine: { id: job.routineId, name: job.name } },
      })
      assert(sent.status === 200, `发消息 ${sent.status} ${sent.text}`)
      // **这里就该是 error。** 桩模型（E2E_STUB_LLM）不假装成功，那一轮的 `turn/end` 带的是
      // `reason: 'error'`；工人如实回报，流水必须照实记——曾经它只认 `reason.kind`，于是失败的
      // 轮次一律记成了绿勾。
      const kind = await asWorker.turnEnd(afterSeq)
      assert(kind === 'error', `桩模型那一轮该以 error 收口：${kind}`)
      const fin = await asWorker.post(job.runId, 'finish', { kind, sessionId })
      assert(fin.status === 200, `finish ${fin.status} ${fin.text}`)
      const r = await req(gwBase, 'GET', `/runtime/routines/${routineId}`, { token: adminTok })
      const run = (r.json.runs || []).find((x) => x.id === run0.id)
      assert(run && run.status === 'error', `run 结束成 ${run && run.status}：${run && run.error}`)
      assert(String(run.error || '').includes('这一轮'), `error 文案 ${run.error}`)
      assert(run.sessionId === sessionId, `run.sessionId ${run.sessionId} != ${sessionId}`)
      assert(r.json.routine.retryAt === null, '试跑砸了不补')
    })

    await test('一条任务不会同时跑两轮', async () => {
      const first = await req(gwBase, 'POST', `/runtime/routines/${routineId}/run`, { token: adminTok, body: {} })
      assert(first.status === 200, `first ${first.status} ${first.text}`)
      // 登记了、还没人领走，第二下必须被挡住（库里那条部分唯一索引，迁移 0035）。
      const second = await req(gwBase, 'POST', `/runtime/routines/${routineId}/run`, { token: adminTok, body: {} })
      assert(second.status === 409, `second ${second.status} ${second.text}`)
      const detail = await req(gwBase, 'GET', `/runtime/routines/${routineId}`, { token: adminTok })
      const running = (detail.json.runs || []).filter((r) => r.status === 'running')
      assert(running.length === 1, `同时有 ${running.length} 轮在跑`)
      // 收掉这一条，别让它挡着后面的用例：工人领走、说没跑起来。
      const got = await asWorker.due()
      assert(got.json.jobs.length === 1, `该领到那一条：${got.text}`)
      const fin = await asWorker.post(got.json.jobs[0].runId, 'finish', { kind: 'aborted' })
      assert(fin.status === 200, `finish ${fin.status}`)
    })

    await test('别人的日常任务看不见也删不掉 → 404', async () => {
      const peek = await req(gwBase, 'GET', `/runtime/routines/${routineId}`, { token: memberTok })
      assert(peek.status === 404, `peek ${peek.status} ${peek.text}`)
      const kill = await req(gwBase, 'DELETE', `/runtime/routines/${routineId}`, { token: memberTok })
      assert(kill.status === 404, `kill ${kill.status} ${kill.text}`)
      const mine = await req(gwBase, 'GET', `/runtime/bots/${botId}/routines`, { token: adminTok })
      assert((mine.json.routines || []).some((x) => x.id === routineId), '自己的那条应该还在')
    })

    await test('审计留得下「这个 Bot 会不会自己动、自己动的时候做什么」', async () => {
      const r = await req(gwBase, 'GET', `/orgs/${orgId}/audit`, { token: adminTok })
      assert(r.status === 200, `审计 ${r.status} ${r.text}`)
      const events = r.json.events || r.json.items || []
      assert(events.some((e) => e.action === 'routine.create'), '建日常任务没进审计')
      // 开关和指令都要留痕：admin 事后要能回答「它昨晚为什么自己发了那封信」。
      assert(events.some((e) => e.action === 'routine.active'), '开关没进审计')
      const edited = events.find((e) => e.action === 'routine.update')
      assert(edited && String(edited.detail?.instruction || '').includes('ping'), `指令改动没留下内容 ${JSON.stringify(edited)}`)
      // 改名字不该进去，否则每一次失焦保存都刷一行，真正要紧的两行就淹了。
      assert(!events.some((e) => e.action === 'routine.rename'), '改名字不该进审计')
    })

    await test('删掉之后就真的没有了，再改它是 404 不是 500', async () => {
      const gone = await req(gwBase, 'DELETE', `/runtime/routines/${routineId}`, { token: adminTok })
      assert(gone.status === 200, `delete ${gone.status} ${gone.text}`)
      const after = await req(gwBase, 'GET', `/runtime/routines/${routineId}`, { token: adminTok })
      assert(after.status === 404, `after ${after.status}`)
      // 另一个标签页还开着这一条，失焦保存了一下：得是「没有这条」，不是一个 500。
      const stale = await req(gwBase, 'PATCH', `/runtime/routines/${routineId}`, { token: adminTok, body: { name: '改个名' } })
      assert(stale.status === 404, `stale patch ${stale.status} ${stale.text}`)
      const list = await req(gwBase, 'GET', `/runtime/bots/${botId}/routines`, { token: adminTok })
      assert(!(list.json.routines || []).some((x) => x.id === routineId), '列表里还留着')
    })

    /**
     * 席位说「没有这个助理」→ 转出去必须是 503，不能是 404。
     *
     * 席位进程起来了、端口也听上了，但公司目录还没拉回来（catalog 首次 pull 是
     * fire-and-forget），名册里于是暂时没有这颗 Bot——一次全新部署必然有几秒到几十秒
     * 落在这个窗口里。这跟「这颗 Bot 不是你的 / 已经删了」（visibleBotOf 的 404）在
     * 界面上是两件相反的事：前者「再等等」，后者「等一万年也一样」。原样把席位的 404
     * 转出去，调用方就只能在两种含义相反的 404 之间猜——猜错哪一边都有代价：当成永久
     * 错误就是「刚部署完点发送没反应，只能刷新」，当成还在热身就是对着一颗已经删掉的
     * Bot 白等一分钟。
     *
     * 这一条放在最后：它要把实例地址临时指到一个假席位上，跑完再指回去。
     */
    await test('席位还不认识这颗 Bot：/runtime/bots/:id/session 折成 503，不是 404', async () => {
      const stub = createServer((r, res) => {
        res
          .writeHead(404, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: `没有这个助理：${botId}` }))
      })
      await new Promise((ok, bad) => {
        stub.once('error', bad)
        stub.listen(STUB_PORT, '127.0.0.1', ok)
      })
      const me = await req(gwBase, 'GET', '/me', { token: adminTok })
      const accountId = me.json.account.id
      try {
        const point = await req(gwBase, 'POST', `/internal/instances/${accountId}/ready`, {
          token: machineTok,
          body: { host: `http://127.0.0.1:${STUB_PORT}`, botId },
        })
        assert(point.status === 200, `指向假席位 ${point.status} ${point.text}`)

        const r = await req(gwBase, 'GET', `/runtime/bots/${botId}/session`, { token: adminTok })
        assert(r.status === 503, `席位的 404 该折成 503，实际 ${r.status} ${r.text}`)
        const msg = String(r.json?.error || r.text)
        assert(msg.includes('实例还没上线'), `503 文案不对：${msg}`)
        // 席位自己那句话要留在 body 里：curl 排错时「还没就绪」和「为什么还没就绪」
        // 是两个问题，折了状态码不该把后一个也折掉。
        assert(msg.includes('没有这个助理'), `席位原话没留下：${msg}`)
      } finally {
        // 指回真席位：后面还有 finally 里的收尾，别留一个指向已关端口的实例行。
        await req(gwBase, 'POST', `/internal/instances/${accountId}/ready`, {
          token: machineTok,
          body: { host: botBase, botId },
        })
        await closeServer(stub, '席位替身')
      }
    })

  } finally {
    if (botChild && !botChild._exited) {
      try {
        botChild.kill('SIGTERM')
      } catch {}
      await sleep(400)
      try {
        botChild.kill('SIGKILL')
      } catch {}
    }
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
    try {
      rmSync(BOT_HOME, { recursive: true, force: true })
    } catch {}
  }
}
