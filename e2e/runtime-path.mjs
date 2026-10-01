/**
 * Gateway 配置的 Skill / MCP / Bot 被实例加载并进入对话。
 * 自己的 home / 端口，不碰 live 3080，不碰 run.mjs 那套 /tmp/satuwork-e2e-gw。
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createCompany } from './org.mjs'
import { startMockMcp } from './mock-mcp.mjs'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { publishRelease } from './release.mjs'
import { pairMachine } from './pair.mjs'
import { freePorts } from './ports.mjs'

/**
 * **一律用桩模型。** 以前这里会去读本机 live 库（一个写死的 sqlite 路径）把真实的
 * 平台密钥灌进测试 Gateway：那台机器上有 key 就真的打上游、没有就走桩——同一套用例
 * 在两台机器上验的是两条路，而且把线上密钥复制进 /tmp 下的测试目录里。e2e 不出网，
 * 也不该碰任何 live 数据。
 */
const STUB_LLM = true

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

export async function runRuntimePath({ root, gwRoot, botRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = tmpOf('satuwork-e2e-runtime-gw')
  const BOT_HOME = tmpOf('satuwork-e2e-runtime-bot')
  const [GW_PORT, BOT_PORT] = await freePorts(2)
  const MACHINE_TOK = 'e2e-runtime-machine'
  const PLATFORM_TOK = 'e2e-runtime-platform'
  const gwBase = `http://127.0.0.1:${GW_PORT}`
  const botBase = `http://127.0.0.1:${BOT_PORT}`

  log('\n# runtime-path')
  rmSync(GW_HOME, { recursive: true, force: true })
  rmSync(BOT_HOME, { recursive: true, force: true })

  const gw = start('runtime-gw', ['--import', 'tsx', join(gwRoot, 'src/index.ts')], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: schemaOf('e2e_runtime'),
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_MACHINE_TOKEN: MACHINE_TOK,
      GATEWAY_PLATFORM_TOKEN: PLATFORM_TOK,
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '1',
      GATEWAY_OWNER_EMAIL: 'owner@runtime.test',
      GATEWAY_OWNER_PASSWORD: 'test-owner-runtime',
      SATUWORK_DEPLOY_STUB: '1',
    },
  })
  // 带上 child：起不来时有用的是它的输出，不是三十秒后那句「等不到」。
  await waitHttp(gwBase + '/health', { child: gw, what: 'runtime gateway' })

  let mock
  let botChild
  try {
    await test('Gateway 配置的 Skill/MCP/Bot 被实例加载并进入对话', async () => {
      const reg = await createCompany(req, gwBase, {
        ownerEmail: 'owner@runtime.test',
        ownerPassword: 'test-owner-runtime',
        email: 'admin@runtime.test',
        password: 'correct-horse',
        companyName: 'RuntimeCo',
        slug: 'runtimeco',
        seats: 2,
      })
      const adminTok = reg.token
      const orgId = reg.company.id
      const ownerTok = reg.ownerToken
      const adminId = reg.account.id
      const seat = await req(gwBase, 'GET', `/platform/accounts/${adminId}`, { token: ownerTok })
      assert(seat.status === 200, `seat secrets ${seat.status} ${seat.text}`)
      const seatAccess = seat.json.accessToken
      const seatApiKey = seat.json.apiKey
      assert(typeof seatAccess === 'string' && seatAccess.startsWith('sat_'), 'access token')
      assert(typeof seatApiKey === 'string' && seatApiKey.startsWith('sk_sw_'), 'api key')
      const machineTok = (await pairMachine({ req, gwBase, ownerTok, orgId })).token
      assert(typeof machineTok === 'string' && machineTok.startsWith('smt_'), 'smt_')
      const stubLlm = STUB_LLM

      const skill = await req(gwBase, 'POST', `/orgs/${orgId}/skills`, {
        token: adminTok,
        body: {
          name: 'e2e-skill-marker',
          body: 'SKILL-OK-9C2E\n\n- 第一步确认标记\n- 第二步按步骤执行',
          tags: ['自动化'],
        },
      })
      assert(skill.status === 201, `skill ${skill.status} ${skill.text}`)
      const skillId = skill.json.skill.id
      assert(skill.json.skill.body.includes('SKILL-OK-9C2E'), 'skill body')

      mock = await startMockMcp()
      const mcp = await req(gwBase, 'POST', `/orgs/${orgId}/mcp-servers`, {
        token: adminTok,
        body: {
          name: 'e2e-mcp',
          kind: 'HTTP',
          endpoint: `http://127.0.0.1:${mock.port}`,
          perm: '只读',
        },
      })
      assert(mcp.status === 201, `mcp ${mcp.status} ${mcp.text}`)
      const mcpId = mcp.json.server.id
      assert(!Object.prototype.hasOwnProperty.call(mcp.json.server, 'token'), 'admin 回了 token')

      const catMcp = await req(gwBase, 'GET', '/catalog/mcp', { token: adminTok })
      assert(catMcp.status === 200, `catalog mcp ${catMcp.status}`)
      for (const item of catMcp.json.items || []) {
        assert(!item.definition || item.definition.token == null, 'catalog/mcp 泄漏 token 字段')
      }

      /**
       * 人设和能力挂在**公司模版**上，Bot 由这个人自己建。
       *
       * 下面整条链路（席位实例拉目录 → 提示词进上下文 → Skill/MCP 进工具表）验的就是
       * 「员工建的 Bot 长在公司模版上」这件事真的走通了，不是只在接口层面对得上。
       */
      const prompt = '你是 Runtime 探针助理。只回答 ping。PROMPT-OK-RUNTIME'
      const tpl = await req(gwBase, 'PUT', `/orgs/${orgId}/bot-template`, {
        token: adminTok,
        body: { prompt, skills: [skillId, 'no-such-skill'], mcps: [mcpId, 'no-such-mcp'] },
      })
      assert(tpl.status === 200, `模版 ${tpl.status} ${tpl.text}`)
      assert(tpl.json.template.skills.length === 1 && tpl.json.template.skills[0] === skillId, 'skills ids')
      assert(tpl.json.template.mcps.length === 1 && tpl.json.template.mcps[0] === mcpId, 'mcps ids')

      const created = await req(gwBase, 'POST', '/runtime/bots', {
        token: adminTok,
        body: { name: 'Runtime 探针', description: 'e2e runtime path' },
      })
      assert(created.status === 201, `bot ${created.status} ${created.text}`)
      assert(created.json.bot.prompt === prompt, `没继承模版的人设：${created.json.bot.prompt}`)
      assert(created.json.bot.skillCount === 1 && created.json.bot.mcpCount === 1, 'counts')
      const remoteBotId = created.json.bot.id

      // 席位 sat_ 才拿得到这份目录——它带 MCP 明文 token。
      const rt = await req(gwBase, 'GET', '/runtime/catalog', { token: seatAccess })
      assert(rt.status === 200, `runtime catalog ${rt.status} ${rt.text}`)
      assert(rt.json.bots.some((b) => b.id === remoteBotId), 'runtime bots')
      assert(rt.json.skills.some((s) => s.id === skillId && String(s.body).includes('SKILL-OK-9C2E')), 'runtime skills')
      const srv = rt.json.servers.find((s) => s.id === mcpId)
      assert(srv, 'runtime server')
      assert(typeof srv.token === 'string', 'runtime token field')

      /**
       * **只下发 Bot 用得到的 MCP。** 下发里带着明文 token 和 env，而一张 sat_ 不难拿——任何成员
       * 都能给自己建一颗本地 Bot、领一张桌面票。以前下发的是公司看得见的全部，等于「成员 = 能读走
       * 公司全部 MCP 的密钥」，包括他的 Bot 根本没被授权用的那些。
       */
      const unused = await req(gwBase, 'POST', `/orgs/${orgId}/mcp-servers`, {
        token: adminTok,
        body: { name: 'e2e-mcp-unused', kind: 'HTTP', endpoint: 'http://127.0.0.1:9/', perm: '只读', token: 'UNUSED-SECRET-7Q' },
      })
      assert(unused.status === 201, `第二台 mcp ${unused.status} ${unused.text}`)
      const scoped = await req(gwBase, 'GET', `/runtime/catalog?botId=${remoteBotId}`, { token: seatAccess })
      assert(scoped.status === 200, `runtime catalog ${scoped.status} ${scoped.text}`)
      assert(scoped.json.servers.some((s) => s.id === mcpId), 'Bot 用到的那台没下发')
      assert(!scoped.json.servers.some((s) => s.id === unused.json.server.id), 'Bot 没用到的那台也下发了')
      assert(!scoped.text.includes('UNUSED-SECRET-7Q'), '没用到的那台的 token 漏进了下发')
      // 探针按同一份口径算指纹：对不上的话席位要么每分钟白拉整份目录，要么改了永远判「没变」。
      const probe = await req(gwBase, 'GET', `/runtime/catalog/version?botId=${remoteBotId}`, { token: seatAccess })
      assert(probe.status === 200 && probe.json.stamp === scoped.json.stamp, `指纹对不上：${probe.json.stamp} vs ${scoped.json.stamp}`)

      const rtJwt = await req(gwBase, 'GET', '/runtime/catalog', { token: adminTok })
      assert(rtJwt.status === 401, `runtime 不该收 JWT ${rtJwt.status}`)

      const unauth = await req(gwBase, 'GET', '/runtime/catalog')
      assert(unauth.status === 401, `runtime unauth ${unauth.status}`)

await publishRelease({ req, gwBase, token: ownerTok, version: '0.1.0', note: 'e2e-runtime' })
      const dep = await req(gwBase, 'POST', '/runtime/deploy', {
        token: adminTok,
        body: { botId: remoteBotId },
      })
      assert(dep.status === 200, `stub deploy ${dep.status} ${dep.text}`)

      await test('席位票上报会话索引：不带 botId 也要落到席位所在的机器上', async () => {
        // 回归防护。machineId 一度只在 body 带 botId 时才推导，不带就落 null——而会话
        // 根事件的 botId 本来就可能缺（bot 那边是 `data.botId || null`）。落 null 之后
        // 拉全文会回落到「公司默认机器」，多机公司必然拿错票，管家 401；现象只是
        // 「拉不到全文」，从这里一点也看不出来。账号粘住机器，所以按账号查一定查得到。
        const now = Date.now()
        const r = await req(gwBase, 'POST', '/internal/sessions/index', {
          token: seatAccess,
          body: {
            sessionId: 's-seat-no-botid',
            // 故意不带 botId；也不带 accountId——席位票只能报自己，body 里给了也不算
            title: '无 botId 的会话',
            createdAt: now,
            updatedAt: now,
            messageCount: 1,
          },
        })
        assert(r.status === 200, `席位票上报 ${r.status} ${r.text}`)
        assert(
          typeof r.json.session.machineId === 'string' && r.json.session.machineId,
          `machineId 该由服务端按席位算出来，实际 ${JSON.stringify(r.json.session.machineId)}`,
        )
        assert(r.json.session.accountId === adminId, `席位票只能报自己，实际 ${r.json.session.accountId}`)
      })

      await test('席位票替别人上报会被拒', async () => {
        const now = Date.now()
        const r = await req(gwBase, 'POST', '/internal/sessions/index', {
          token: seatAccess,
          body: {
            sessionId: 's-seat-impersonate',
            accountId: 'some-other-account',
            createdAt: now,
            updatedAt: now,
            messageCount: 1,
          },
        })
        // body 里的 accountId 对席位票不作数：要么被忽略（记成自己），要么直接拒。
        assert(r.status !== 200 || r.json.session.accountId === adminId, `冒名上报 ${r.status} ${r.text}`)
      })

      botChild = start('runtime-bot', ['--import', 'tsx', join(botRoot, 'e2e-boot.mjs')], {
        cwd: botRoot,
        env: {
          SATUWORK_HOME: BOT_HOME,
          SATUWORK_PORT: String(BOT_PORT),
          SATUWORK_BOT_ID: remoteBotId,
          GATEWAY_URL: gwBase,
          GATEWAY_TOKEN: seatAccess,
          GATEWAY_API_KEY: seatApiKey,
          // 生产上是一分钟一探。这里调快，好在几秒内看到模版改动落到实例上。
          SATUWORK_CATALOG_POLL_MS: '1000',
          ...(stubLlm ? { E2E_STUB_LLM: '1' } : {}),
        },
      })
      await waitHttp(botBase + '/api/health', { timeout: 45000 })
      assert(!botChild._exited, 'bot 启动后就退出了')

      const unauthStatus = await req(botBase, 'GET', '/api/runtime/status')
      assert(unauthStatus.status === 401, `unauth status ${unauthStatus.status} ${unauthStatus.text}`)

      const deadline = Date.now() + 20000
      let status
      let last
      while (Date.now() < deadline) {
        const r = await req(botBase, 'GET', '/api/runtime/status', { token: seatAccess })
        last = r
        if (r.status === 200) {
          status = r.json
          const hasBot = (status.bots || []).some((b) => b.remoteId === remoteBotId || b.id === remoteBotId)
          const hasSkill = (status.skills || []).some((s) => s.id === skillId)
          const mcpOk = (status.servers || []).some(
            (s) => s.id === mcpId && s.connected && (s.tools || []).some((t) => String(t).includes('secret_marker')),
          )
          if (hasBot && hasSkill && mcpOk) break
        }
        status = null
        await sleep(200)
      }
      assert(status, `runtime/status 未就绪 ${JSON.stringify(last?.json || last?.text)}`)
      assert(
        (status.bots || []).some((b) => b.origin === 'company' && (b.remoteId === remoteBotId || b.id === remoteBotId)),
        `bots ${JSON.stringify(status.bots)}`,
      )
      assert(
        (status.servers || []).some((s) => s.connected && (s.tools || []).some((t) => String(t).includes('secret_marker'))),
        `servers ${JSON.stringify(status.servers)}`,
      )

      // bot 认的唯一一把入站凭据就是席位票（GATEWAY_TOKEN），和 Gateway 反代时发的
      // 是同一把。以前这里先 POST /api/auth/setup 建个本地管理员再拿 cookie，
      // 那套账号体系已经删了。
      const list = await req(botBase, 'GET', '/api/bots', { token: seatAccess })
      assert(list.status === 200, `bots ${list.status} ${list.text}`)
      const bots = list.json.bots || []
      assert(bots.length === 1, `Gateway 钉住的名册应只有 1 颗，实际 ${bots.length} ${JSON.stringify(bots)}`)
      assert(!bots.some((b) => b.id === 'default'), 'Gateway 钉住的实例不该有 default')
      const pinned = bots.find((b) => b.id === remoteBotId || b.remoteId === remoteBotId)
      assert(pinned, `名册未见公司 bot ${JSON.stringify(bots)}`)
      assert(pinned.id === remoteBotId, `id ${pinned.id} != SATUWORK_BOT_ID ${remoteBotId}`)
      assert(pinned.origin === 'company', `origin ${pinned.origin}`)
      assert(pinned.remoteId === remoteBotId, `remoteId ${pinned.remoteId}`)
      assert(pinned.prompt === prompt, 'prompt mismatch')

      /**
       * **模版一改，跑着的席位自己跟上。**
       *
       * 这是「公司改一次口径，所有人的 Bot 一起变」的落地点。没有这一段，改模版只
       * 是改了 Gateway 上的一行 JSON——机器上那个进程还端着启动时拉的那一份，要等到
       * 下一次重新部署才知道，而重新部署会断掉正在进行的对话。
       */
      const nextPrompt = '你是 Runtime 探针助理 v2。PROMPT-OK-ROLLED'
      const rolled = await req(gwBase, 'PUT', `/orgs/${orgId}/bot-template`, {
        token: adminTok,
        body: { prompt: nextPrompt },
      })
      assert(rolled.status === 200, `改模版 ${rolled.status} ${rolled.text}`)
      const wantVersion = rolled.json.template.version

      const rollDeadline = Date.now() + 20000
      let rolledPrompt = ''
      let seenVersion = 0
      while (Date.now() < rollDeadline) {
        const st = await req(botBase, 'GET', '/api/runtime/status', { token: seatAccess })
        seenVersion = st.json?.templateVersion || 0
        const cur = await req(botBase, 'GET', '/api/bots', { token: seatAccess })
        rolledPrompt = (cur.json?.bots || []).find((b) => b.id === remoteBotId)?.prompt || ''
        if (seenVersion === wantVersion && rolledPrompt === nextPrompt) break
        await sleep(300)
      }
      assert(seenVersion === wantVersion, `实例还停在模版 v${seenVersion}，Gateway 已经是 v${wantVersion}`)
      assert(rolledPrompt === nextPrompt, `名册里的人设没跟着换：${rolledPrompt}`)

      /**
       * **反过来这条也得通：席位跟上了，平台那边看得见。**
       *
       * 上面验的是「席位换没换」，问的人是探针自己。管理员手上没有探针——他在
       * 「Bot 模版」那一页上看到的是 Gateway 记下来的那个数（席位捎在探针上报回来的，
       * 见 0013 那条迁移）。这两个数字断在中间的话，界面会一直显示「未同步」，而实际
       * 早就换好了——比不显示更糟，因为它会让人去按「立即下发」，把所有人正在进行的
       * 对话掐掉。
       */
      const syncDeadline = Date.now() + 20000
      let sync = null
      while (Date.now() < syncDeadline) {
        const page = await req(gwBase, 'GET', `/orgs/${orgId}/bot-template`, { token: adminTok })
        sync = page.json?.sync || null
        if (sync && sync.synced === sync.total && sync.total > 0) break
        await sleep(300)
      }
      assert(sync, '模版接口没给出同步状态')
      assert(sync.total === 1, `已部署席位数 ${sync.total}`)
      assert(sync.synced === 1, `平台还认为没席位跟上：${JSON.stringify(sync.seats)}`)
      assert(sync.seats[0].version === wantVersion, `平台记下的版本 v${sync.seats[0].version}，实际 v${wantVersion}`)
      assert(sync.seats[0].syncedAt > 0, '没记下汇报时刻')

      /**
       * **`have` 是外面来的数，得当外面来的数看。**
       *
       * 这一列在库里是 int。越界的值直接送进去会让 PG 抛 22003，整条探针 500——而这条路
       * 是席位判断「目录变了没有」的唯一入口，500 之后它这一轮既拿不到 stamp 也不会重拉，
       * 等于一个畸形参数就能把一台席位卡住，界面上却只显示它一直落后。
       *
       * 认不出来的值当没带：照常回 200，库里那个数一个字都不动。
       */
      for (const bad of ['99999999999', '5.5', '-1', 'abc']) {
        const probe = await req(
          gwBase,
          'GET',
          `/runtime/catalog/version?botId=${encodeURIComponent(remoteBotId)}&have=${encodeURIComponent(bad)}`,
          { token: seatAccess },
        )
        assert(probe.status === 200, `have=${bad} 把探针打成了 ${probe.status} ${probe.text}`)
      }
      const afterBad = await req(gwBase, 'GET', `/orgs/${orgId}/bot-template`, { token: adminTok })
      assert(
        afterBad.json?.sync?.seats?.[0]?.version === wantVersion,
        `畸形的 have 改动了库里的版本：${JSON.stringify(afterBad.json?.sync?.seats)}`,
      )

      /**
       * **行为边界也一样跟着跑。**
       *
       * 上面那一段验的是提示词。三个开关走的是同一条路（目录探针 → 指纹变了 → 重拉 →
       * roster.pin），但它有两处单独的失败可能：
       *
       *  - **只改开关、不动提示词**时指纹变不变。指纹里带的是模版的 version，而每一次
       *    保存都 +1——所以这里故意只发 `guards` 和 `escalate`，不碰 prompt：变了就说明
       *    「改开关」这条路自己就够，不是搭了提示词的便车。
       *  - 席位收没收下这两个字段。它们是这一版才加进 `RemoteBot` 的；在那之前
       *    Gateway 一直在发，而席位读进来就丢——开关拨了等于没拨，而界面上看不出来。
       *
       * 断言看的是席位自己报的那一份（`/api/runtime/status` 的 bots[].guards），
       * 也就是策略在 `tools/pre-execute` 里真正拿去判断的那一份（同一条 roster 记录）。
       */
      const escalateRule = '涉及退款、或者客户明确要求转人工时'
      const guarded = await req(gwBase, 'PUT', `/orgs/${orgId}/bot-template`, {
        token: adminTok,
        body: { guards: { 'high-risk': false, pii: true, 'no-external': false }, escalate: escalateRule },
      })
      assert(guarded.status === 200, `改开关 ${guarded.status} ${guarded.text}`)
      const guardVersion = guarded.json.template.version
      assert(guardVersion === wantVersion + 1, `只改开关也该 +1，实际 v${guardVersion}`)

      const guardDeadline = Date.now() + 20000
      let seatGuards = null
      let seatEscalate = ''
      let guardSeen = 0
      while (Date.now() < guardDeadline) {
        const st = await req(botBase, 'GET', '/api/runtime/status', { token: seatAccess })
        guardSeen = st.json?.templateVersion || 0
        const row = (st.json?.bots || []).find((b) => b.id === remoteBotId)
        seatGuards = row?.guards || null
        seatEscalate = row?.escalate || ''
        if (guardSeen === guardVersion && seatGuards && seatGuards['high-risk'] === false) break
        await sleep(300)
      }
      assert(guardSeen === guardVersion, `实例还停在 v${guardSeen}，Gateway 已经是 v${guardVersion}`)
      assert(seatGuards, `席位没报出行为边界：${JSON.stringify(seatGuards)}`)
      assert(
        seatGuards['high-risk'] === false && seatGuards.pii === true && seatGuards['no-external'] === false,
        `开关没跟着换：${JSON.stringify(seatGuards)}`,
      )
      assert(seatEscalate === escalateRule, `转人工的条件没跟着换：${seatEscalate}`)

      // 关回去：这条用例后面还在跑，别把边界留在「两条关着」的状态上。
      const restored = await req(gwBase, 'PUT', `/orgs/${orgId}/bot-template`, {
        token: adminTok,
        body: { guards: { 'high-risk': true, pii: true, 'no-external': true } },
      })
      assert(restored.status === 200, `关回去 ${restored.status} ${restored.text}`)
      const backDeadline = Date.now() + 20000
      let back = null
      while (Date.now() < backDeadline) {
        const st = await req(botBase, 'GET', '/api/runtime/status', { token: seatAccess })
        back = (st.json?.bots || []).find((b) => b.id === remoteBotId)?.guards || null
        if (back && back['high-risk'] === true && back['no-external'] === true) break
        await sleep(300)
      }
      assert(back && back['high-risk'] === true && back['no-external'] === true, `关回去没跟上：${JSON.stringify(back)}`)
      // 提示词没跟着这次保存变——只发了 guards，别的字段该沿用原值。
      const afterGuards = await req(botBase, 'GET', '/api/bots', { token: seatAccess })
      assert(
        (afterGuards.json?.bots || []).find((b) => b.id === remoteBotId)?.prompt === nextPrompt,
        '只改开关那次把人设也冲掉了',
      )

      const sess = await req(botBase, 'GET', `/api/bots/${pinned.id}/session`, { token: seatAccess })
      assert(sess.status === 200, `session ${sess.status} ${sess.text}`)
      const sessionId = sess.json.sessionId
      assert(sessionId, 'sessionId')

      const msg = await req(botBase, 'POST', `/api/sessions/${sessionId}/messages`, {
        token: seatAccess,
        body: { text: 'ping' },
      })
      assert(msg.status === 200, `message ${msg.status} ${msg.text}`)
      assert(msg.json.accepted === true || msg.json.steered === true, 'accepted')

      const file = join(BOT_HOME, 'sessions', `${sessionId}.jsonl`)
      const jsonlDeadline = Date.now() + 20000
      let header
      let lines = []
      while (Date.now() < jsonlDeadline) {
        if (existsSync(file)) {
          lines = readFileSync(file, 'utf8')
            .split('\n')
            .filter((l) => l.trim())
            .map((l) => {
              try {
                return JSON.parse(l)
              } catch {
                return null
              }
            })
            .filter(Boolean)
          header = lines.find((e) => e.type === 'request/header')
          if (header) break
        }
        await sleep(150)
      }
      assert(header, `没有 request/header：${lines.map((e) => e.type).join(',')}`)
      const system = String(header.data?.system || '')
      assert(system.includes('SKILL-OK-9C2E'), `system 无技能标记：${system.slice(0, 400)}`)
      assert(system.includes('e2e-skill-marker'), `system 无技能名：${system.slice(0, 400)}`)
      const toolNames = (header.data?.tools || []).map((t) => t.name).join(',')
      assert(
        toolNames.includes('secret_marker'),
        `tools 无 MCP 工具：${toolNames}`,
      )
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
    if (mock) {
      try {
        await mock.close()
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
