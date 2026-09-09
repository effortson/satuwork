/**
 * 连接器 M1：供应商层 + 上架 + 市场可见性。
 *
 * 上游用一个本地假 Composio（`COMPOSIO_BASE_URL` 指过来），因为这条路要验的是
 * **我们**的形状：密钥不回显、authConfigId 不外泄、同一个 toolkit 不能上架两次、
 * 上架的东西员工那边看得见。真打 backend.composio.dev 既要密钥又不稳定。
 */
import { createServer } from 'node:http'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { freePort } from './ports.mjs'
import { closeServer } from './probe.mjs'

const TOOLKITS = {
  items: [
    { slug: 'gmail', name: 'Gmail', meta: { description: '收发邮件', logo: 'https://x/gmail.png', categories: [{ name: 'productivity' }] }, auth_schemes: [{ mode: 'OAUTH2' }] },
    { slug: 'notion', name: 'Notion', meta: { description: '知识库', categories: [{ name: 'productivity' }] }, auth_schemes: [{ mode: 'OAUTH2' }] },
  ],
}
const TOOLS = {
  items: [
    { slug: 'GMAIL_SEND_EMAIL', name: 'Send email', description: '发一封邮件', input_parameters: { type: 'object', properties: { to: { type: 'string' } } } },
    { slug: 'GMAIL_FETCH_EMAILS', name: 'Fetch emails', description: '拉最近的邮件', input_parameters: { type: 'object', properties: {} } },
    // **不以 toolkit 名开头的 slug。** Composio 的自定义工具就是这种形状，而按前缀猜
    // 的还原会把它拼成 GMAIL_LOCAL_GMAIL_…，工具表里有、点了永远失败。
    { slug: 'LOCAL_GMAIL_DIGEST', name: 'Digest', description: '自定义工具', input_parameters: { type: 'object', properties: {} } },
  ],
}

function mockComposio() {
  const seen = { keys: new Set(), initiated: [], deleted: [], executed: [] }
  // 授权状态由测试说了算：默认 INITIATED，测试调 seen.activate(id) 之后才 ACTIVE。
  const accounts = new Map()
  let n = 0
  const server = createServer((req, res) => {
    seen.keys.add(req.headers['x-api-key'] || '')
    const url = new URL(req.url, 'http://x')
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/toolkits') return send(200, TOOLKITS)
    if (url.pathname === '/tools') return send(200, TOOLS)
    // 老的那条对「Composio 托管的 OAuth」已经不受理了，照着上游的原话打回——
    // 我们要是又走回去，测试立刻红，而不是等到线上有人点「添加账号」才看见那句英文。
    if (url.pathname === '/connected_accounts' && req.method === 'POST') {
      return send(400, {
        error: {
          message:
            'Creating connections on this endpoint for Composio-managed OAuth auth configs is no longer supported. Use POST /api/v3/connected_accounts/link instead.',
        },
      })
    }
    if (url.pathname === '/connected_accounts/link' && req.method === 'POST') {
      let raw = ''
      req.on('data', (d) => { raw += d })
      req.on('end', () => {
        const body = JSON.parse(raw || '{}')
        const id = `ca_${++n}`
        accounts.set(id, 'INITIATED')
        seen.initiated.push({
          id,
          userId: body.user_id,
          callback: body.callback_url,
          authConfigId: body.auth_config_id,
          allowMultiple: body.allow_multiple === true,
        })
        send(200, { connected_account_id: id, redirect_url: `https://accounts.example.com/o/oauth2?ca=${id}` })
      })
      return
    }
    const ex = /^\/tools\/execute\/(.+)$/.exec(url.pathname)
    if (ex && req.method === 'POST') {
      let raw = ''
      req.on('data', (d) => { raw += d })
      req.on('end', () => {
        const body = JSON.parse(raw || '{}')
        const tool = decodeURIComponent(ex[1])
        seen.executed.push({ tool, userId: body.user_id, account: body.connected_account_id, args: body.arguments })
        if (tool === 'GMAIL_BOOM') return send(500, { error: { message: '上游炸了' } })
        // 永远不回：用来验超时那一档（客户端的 AbortSignal 会先掐断）。
        if (tool === 'GMAIL_HANG') return
        send(200, { successful: true, data: { ok: true, tool } })
      })
      return
    }
    const m = /^\/connected_accounts\/(.+)$/.exec(url.pathname)
    if (m && req.method === 'GET') {
      const st = accounts.get(m[1])
      return st ? send(200, { id: m[1], status: st }) : send(404, { error: { message: 'no such account' } })
    }
    if (m && req.method === 'DELETE') {
      seen.deleted.push(m[1])
      accounts.delete(m[1])
      return send(200, { deleted: true })
    }
    return send(404, { error: { message: 'nope' } })
  })
  seen.activate = (id) => accounts.set(id, 'ACTIVE')
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` }))
  })
}

export async function runConnectors({ root, gwRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = tmpOf('satuwork-e2e-connectors')
  // 端口向内核要（见 ports.mjs）：写死的数迟早撞上别的套件或别的 worktree。
  const GW_PORT = await freePort()
  const base = `http://127.0.0.1:${GW_PORT}`

  rmSync(GW_HOME, { recursive: true, force: true })
  log('\n# connectors')

  const mock = await mockComposio()
  const gw = start('connectors-gw', ['--import', 'tsx', `${gwRoot}/src/index.ts`], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: schemaOf('e2e_connectors'),
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '0',
      COMPOSIO_BASE_URL: mock.url,
      // 超时那一档要验，45 秒等不起。
      CONNECTOR_UPSTREAM_TIMEOUT_MS: '1500',
    },
  })
  await waitHttp(`${base}/health`, { child: gw, what: 'connectors gateway' })

  let owner = ''
  let adminTok = ''
  let memberTok = ''
  let orgId = ''
  let connectorId = ''
  let firstConnId = ''
  let firstExternal = ''
  let memberId = ''
  let seatTok = ''
  let secondConnId = ''

  try {
    await test('没配密钥时：市场是空的，拉 toolkit 得到 402 而不是一个栈', async () => {
      const setup = await req(base, 'POST', '/auth/setup', {
        body: { email: 'o@conn.test', name: 'o', password: 'correct-horse-1' },
      })
      assert(setup.status === 201 || setup.status === 200, `setup ${setup.status} ${setup.text}`)
      owner = setup.json.token

      const vendors = await req(base, 'GET', '/platform/connector-vendors', { token: owner })
      assert(vendors.status === 200, `vendors ${vendors.status}`)
      const composio = vendors.json.vendors.find((v) => v.vendor === 'composio')
      assert(composio, 'composio 这一家应该出现在列表里')
      assert(composio.configured === false, '还没配密钥')
      assert(composio.caps.multiAccount === true, 'composio 支持多账号')

      const toolkits = await req(base, 'GET', '/platform/connector-toolkits', { token: owner })
      assert(toolkits.status === 402, `没密钥应该 402，实际 ${toolkits.status}`)
    })

    await test('配上密钥能拉到 toolkit 与工具清单，密钥不回显', async () => {
      const put = await req(base, 'PUT', '/platform/connector-vendors/composio', {
        token: owner,
        body: { secret: 'ck_e2e_never_leak' },
      })
      assert(put.status === 201, `put secret ${put.status} ${put.text}`)
      assert(!put.text.includes('ck_e2e_never_leak'), '密钥不能回显')

      const ping = await req(base, 'POST', '/platform/connector-vendors/composio/ping', { token: owner })
      assert(ping.status === 200 && ping.json.ok === true, `ping ${ping.status} ${ping.text}`)

      const toolkits = await req(base, 'GET', '/platform/connector-toolkits', { token: owner })
      assert(toolkits.status === 200, `toolkits ${toolkits.status} ${toolkits.text}`)
      const gmail = toolkits.json.toolkits.find((t) => t.slug === 'gmail')
      assert(gmail && gmail.name === 'Gmail', 'gmail 应该在清单里')
      assert(gmail.categories.includes('productivity'), `分组没解出来：${JSON.stringify(gmail.categories)}`)

      const tools = await req(base, 'GET', '/platform/connector-toolkits/gmail/tools', { token: owner })
      assert(tools.status === 200, `tools ${tools.status}`)
      assert(tools.json.tools.length === 3, `工具数 ${tools.json.tools.length}`)
      assert(tools.json.tools[0].inputSchema.type === 'object', 'inputSchema 要原样带出来')
      assert(mock.seen.keys.has('ck_e2e_never_leak'), '上游应该收到平台密钥')
    })

    await test('连接器供应商不算模型供应商：不进密钥清单，也不从那条路存', async () => {
      // 两类密钥同住 platform_credentials 一张表。composio 漏进「供应商」那一屏的话，
      // 那里会多出一个 0 个模型、测不了、删了还会从连接器页再冒出来的假供应商——而
      // 「供应商」讲的是模型，一行里每一列对它都答不上来。
      const plat = await req(base, 'GET', '/platform/credentials', { token: owner })
      assert(plat.status === 200, `credentials ${plat.status}`)
      assert(
        !plat.json.credentials.some((c) => c.provider === 'composio'),
        `composio 混进了模型供应商清单：${JSON.stringify(plat.json.credentials)}`,
      )
      // 存也只有一个存法：这条路收下的话，同一把密钥会有两个入口、两处状态。
      const wrongDoor = await req(base, 'POST', '/platform/credentials', {
        token: owner,
        body: { provider: 'composio', secret: 'ck_should_not_land_here' },
      })
      assert(wrongDoor.status === 400, `从供应商那条路存 composio 应该 400，实际 ${wrongDoor.status}`)
      assert(String(wrongDoor.json.error).includes('连接器'), `没指路该去哪存：${wrongDoor.text}`)
      // 挡下来之后，连接器那头原来那把密钥必须还在——别把「不给存」做成了「顺手清掉」。
      const ping = await req(base, 'POST', '/platform/connector-vendors/composio/ping', { token: owner })
      assert(ping.status === 200 && ping.json.ok === true, `密钥被误伤了：${ping.text}`)
      assert(!mock.seen.keys.has('ck_should_not_land_here'), '被挡下的那把密钥居然发到了上游')
    })

    await test('上架一条，同一个 toolkit 不能上架两次', async () => {
      const made = await req(base, 'POST', '/platform/connectors', {
        token: owner,
        body: { vendor: 'composio', toolkit: 'gmail', name: 'Gmail', authConfigId: 'ac_secret_123', category: 'productivity', perm: '可写' },
      })
      assert(made.status === 201, `publish ${made.status} ${made.text}`)
      assert(!made.text.includes('ac_secret_123'), 'authConfigId 不能出现在响应里')
      assert(made.json.connector.authReady === true, '配了 authConfig 就该报 ready')
      connectorId = made.json.connector.id

      const dup = await req(base, 'POST', '/platform/connectors', {
        token: owner,
        body: { vendor: 'composio', toolkit: 'gmail', name: 'Gmail 副本', authConfigId: 'ac_x' },
      })
      assert(dup.status === 409, `重复上架应该 409，实际 ${dup.status}`)
    })

    await test('vendor / toolkit 建完不给改', async () => {
      const patch = await req(base, `PATCH`, `/platform/connectors/${connectorId}`, {
        token: owner,
        body: { toolkit: 'slack', vendor: 'other', description: '改说明' },
      })
      assert(patch.status === 200, `patch ${patch.status} ${patch.text}`)
      assert(patch.json.connector.toolkit === 'gmail', `toolkit 被改掉了：${patch.json.connector.toolkit}`)
      assert(patch.json.connector.vendor === 'composio', 'vendor 被改掉了')
      assert(patch.json.connector.description === '改说明', '说明没改上')
    })

    await test('员工在市场里看得见上架的那一条，且看不到 authConfigId', async () => {
      const org = await req(base, 'POST', '/platform/orgs', {
        token: owner,
        body: {
          name: 'Acme', slug: 'acme-conn',
          contactName: '张三', contactPhone: '+86 138 0000 0000', contactEmail: 'z@acme.test',
          adminEmail: 'a@acme-conn.test', adminPassword: 'correct-horse-1',
        },
      })
      assert(org.status === 201, `org ${org.status} ${org.text}`)
      orgId = org.json.company.id
      const login = await req(base, 'POST', '/auth/login', {
        body: { email: 'a@acme-conn.test', password: 'correct-horse-1' },
      })
      adminTok = login.json.token

      // 建公司只给一席（admin 自己占掉了），加员工前先把套餐调大。
      const plan = await req(base, 'PUT', `/platform/orgs/${orgId}/plan`, { token: owner, body: { seats: 3 } })
      assert(plan.status === 200, `plan ${plan.status} ${plan.text}`)

      // 连接器是「我这个人有哪些账号」，所以主角是员工，不是管理员。
      const made = await req(base, 'POST', `/orgs/${orgId}/accounts`, {
        token: adminTok,
        body: { email: 'm@acme-conn.test', name: '小王', password: 'correct-horse-1', role: 'member' },
      })
      assert(made.status === 201, `member ${made.status} ${made.text}`)
      memberId = made.json.account.id
      const mLogin = await req(base, 'POST', '/auth/login', {
        body: { email: 'm@acme-conn.test', password: 'correct-horse-1' },
      })
      assert(mLogin.status === 200, `member login ${mLogin.status} ${mLogin.text}`)
      memberTok = mLogin.json.token

      const market = await req(base, 'GET', '/me/connectors', { token: adminTok })
      assert(market.status === 200, `market ${market.status} ${market.text}`)
      assert(market.json.connectors.length === 1, `市场里应该有一条，实际 ${market.json.connectors.length}`)
      assert(market.json.connectors[0].toolkit === 'gmail', 'market 里那条应该是 gmail')
      assert(market.json.connectors[0].blocked === false, '默认放行')
      assert(!market.text.includes('ac_secret_123'), 'authConfigId 不能进员工那一屏')
    })

    await test('公司管理员改不动上架记录', async () => {
      const patch = await req(base, 'PATCH', `/platform/connectors/${connectorId}`, {
        token: adminTok,
        body: { name: '我改的' },
      })
      assert(patch.status === 403, `admin 改上架记录应该 403，实际 ${patch.status}`)
    })

    await test('员工自己装：装了才连得上，没装先连是 409', async () => {
      const early = await req(base, 'POST', `/me/connectors/${connectorId}/connections`, {
        token: memberTok,
        body: { label: 'default' },
      })
      assert(early.status === 409, `没装就连应该 409，实际 ${early.status} ${early.text}`)

      const install = await req(base, 'POST', `/me/connectors/${connectorId}/install`, { token: memberTok })
      assert(install.status === 201, `install ${install.status} ${install.text}`)
      // 重复点安装不该报错，也不该把工具开关重置掉。
      const again = await req(base, 'POST', `/me/connectors/${connectorId}/install`, { token: memberTok })
      assert(again.status === 201 && again.json.install.id === install.json.install.id, '重复安装应该幂等')
    })

    await test('连两个账号：各自一把，label 不能重', async () => {
      const first = await req(base, 'POST', `/me/connectors/${connectorId}/connections`, {
        token: memberTok,
        body: { label: 'default' },
      })
      assert(first.status === 201, `connect ${first.status} ${first.text}`)
      assert(first.json.redirectUrl.startsWith('https://accounts.example.com/'), '没给出授权地址')
      assert(first.json.connection.status === 'pending', '刚发起应该是 pending')
      const sent = mock.seen.initiated.at(-1)
      assert(sent.authConfigId === 'ac_secret_123', `authConfigId 没带上：${sent.authConfigId}`)
      assert(sent.userId.startsWith('sw_'), `externalUserId 应该是 sw_ 前缀，实际 ${sent.userId}`)
      assert(!sent.userId.includes('@'), '不能拿邮箱当 externalUserId')
      assert(sent.callback.includes('/oauth/connectors/callback?c='), `回调地址不对：${sent.callback}`)
      // 不带 allow_multiple 的话，第二把 link 会把同一个 connected account 还回来——
      // 两行本地记录共用一个 externalId，断开其中一个另一个跟着废。
      assert(sent.allowMultiple === true, '没带 allow_multiple')

      const dup = await req(base, 'POST', `/me/connectors/${connectorId}/connections`, {
        token: memberTok,
        body: { label: 'default' },
      })
      assert(dup.status === 409, `同名账号应该 409，实际 ${dup.status}`)

      const second = await req(base, 'POST', `/me/connectors/${connectorId}/connections`, {
        token: memberTok,
        body: { label: 'personal' },
      })
      assert(second.status === 201, `第二个账号 ${second.status} ${second.text}`)
      firstConnId = first.json.connection.id
      firstExternal = mock.seen.initiated[0].id
      secondConnId = second.json.connection.id

      const bad = await req(base, 'POST', `/me/connectors/${connectorId}/connections`, {
        token: memberTok,
        body: { label: 'Company Mail!' },
      })
      assert(bad.status === 400, `非法 label 应该 400，实际 ${bad.status}`)
    })

    await test('回调不信参数：上游还没 ACTIVE 就仍然是 pending', async () => {
      const cb = await fetch(`${base}/oauth/connectors/callback?c=${encodeURIComponent(firstConnId)}&status=success`, {
        redirect: 'manual',
      })
      // 授权是在新开的那一页里做的，这一页的正事是关掉自己——不再跳回应用（跳回去等于
      // 在旁边多开一个副本，而人正看着的那一页在另一个标签里）。
      assert(cb.status === 200, `回调该自己渲染一页，实际 ${cb.status}`)
      assert(!cb.headers.get('location'), `还在往回跳：${cb.headers.get('location')}`)
      const page = await cb.text()
      assert(page.includes('window.close'), '这一页不会关掉自己')
      // 还没 ACTIVE 就别说「授权完成」，也别自动关——那句话得留在屏幕上让人读完。
      assert(!page.includes('授权完成'), '上游还没确认就说成功了')
      assert(!page.includes('setTimeout'), '没成功还自动关，人来不及看那句说明')
      const detail = await req(base, 'GET', `/me/connectors/${connectorId}`, { token: memberTok })
      const one = detail.json.connections.find((c) => c.id === firstConnId)
      assert(one.status === 'pending', `上游没 ACTIVE，我们不能自己变 active：${one.status}`)
    })

    await test('上游 ACTIVE 之后回调把它转正', async () => {
      mock.seen.activate(firstExternal)
      const cb = await fetch(`${base}/oauth/connectors/callback?c=${encodeURIComponent(firstConnId)}`, { redirect: 'manual' })
      const page = await cb.text()
      assert(page.includes('授权完成'), '成了却没说成了')
      assert(page.includes('setTimeout'), '成了就该自己关掉，别让人再点一次')
      const detail = await req(base, 'GET', `/me/connectors/${connectorId}`, { token: memberTok })
      const one = detail.json.connections.find((c) => c.id === firstConnId)
      assert(one.status === 'active', `应该转正了，实际 ${one.status}`)
      assert(one.connectedAt > 0, '没记连接时间')
      assert(detail.json.tools.length === 3, `详情该带工具清单，实际 ${detail.json.tools.length}`)
      assert(detail.json.install, '详情该带安装记录')
    })

    await test('mentionOnly 改得动，别人的连接改不动', async () => {
      const patch = await req(base, 'PATCH', `/me/connectors/${connectorId}/connections/${firstConnId}`, {
        token: memberTok,
        body: { mentionOnly: true },
      })
      assert(patch.status === 200 && patch.json.connection.mentionOnly === true, `patch ${patch.status} ${patch.text}`)

      const other = await req(base, 'PATCH', `/me/connectors/${connectorId}/connections/${firstConnId}`, {
        token: adminTok,
        body: { mentionOnly: false },
      })
      assert(other.status === 404, `别人的连接应该 404，实际 ${other.status}`)

      // 关回去：后面几条验的是「默认工具表里有它」，别让这条的副作用漏下去。
      await req(base, 'PATCH', `/me/connectors/${connectorId}/connections/${firstConnId}`, {
        token: memberTok,
        body: { mentionOnly: false },
      })
    })

    await test('工具开关：存开着的那些，空数组等于全开', async () => {
      const put = await req(base, 'PUT', `/me/connectors/${connectorId}/tools`, {
        token: memberTok,
        body: { enabledTools: ['GMAIL_SEND_EMAIL', 'GMAIL_SEND_EMAIL'] },
      })
      assert(put.status === 200, `tools ${put.status} ${put.text}`)
      assert(put.json.install.enabledTools.length === 1, `重复的要去掉：${JSON.stringify(put.json.install.enabledTools)}`)
      // 还原成「全开」：后面几条验的是完整工具表，别让这条的副作用漏下去。
      await req(base, 'PUT', `/me/connectors/${connectorId}/tools`, { token: memberTok, body: { enabledTools: [] } })
    })

    await test('席位拉目录：一把连接一条 MCP 记录，挂到每一颗 Bot 上', async () => {
      const detail = await req(base, 'GET', `/platform/accounts/${memberId}`, { token: owner })
      seatTok = detail.json.accessToken
      assert(seatTok.startsWith('sat_'), `拿不到席位票：${detail.text}`)

      const cat = await req(base, 'GET', '/runtime/catalog', { token: seatTok })
      assert(cat.status === 200, `catalog ${cat.status} ${cat.text}`)
      const synth = cat.json.servers.filter((x) => x.connector === 'gmail')
      // personal 那把还是 pending（只 activate 了第一把），所以只有 default 出现。
      assert(synth.length === 1, `应该只有一条已连接的，实际 ${synth.length}`)
      assert(synth[0].name.includes('default'), `名字要带 label：${synth[0].name}`)
      assert(synth[0].endpoint.includes('/mcp/connectors/'), `endpoint 不对：${synth[0].endpoint}`)
      assert(synth[0].timeoutMs === 60000, `要下发超时，实际 ${synth[0].timeoutMs}`)
      assert(synth[0].token === seatTok, '票要原样带回去，席位才连得上')
    })

    await test('mentionOnly：照样下发（带标记），但不挂到 Bot 的 mcps 上', async () => {
      await req(base, 'PATCH', `/me/connectors/${connectorId}/connections/${firstConnId}`, {
        token: memberTok,
        body: { mentionOnly: true },
      })
      const cat = await req(base, 'GET', '/runtime/catalog', { token: seatTok })
      const one = cat.json.servers.find((x) => x.connector === 'gmail')
      // **要下发**：真被点名时再去握手就晚了，那一轮已经在组请求。
      assert(one && one.mentionOnly === true, `mentionOnly 的也该下发并带标记：${JSON.stringify(one)}`)
      for (const bot of cat.json.bots) {
        assert(!(bot.mcps || []).includes(one.id), '仅 @ 时可用的不该挂到 Bot 的 mcps 上')
      }
      await req(base, 'PATCH', `/me/connectors/${connectorId}/connections/${firstConnId}`, {
        token: memberTok,
        body: { mentionOnly: false },
      })
    })

    await test('/mentions：只列我自己已连上的，带 mentionOnly 标记', async () => {
      const r = await req(base, 'GET', '/mentions', { token: memberTok })
      assert(r.status === 200, `mentions ${r.status} ${r.text}`)
      const one = r.json.mentions.find((m) => m.id === firstConnId)
      assert(one, `自己连上的那把该在选单里：${r.text}`)
      assert(one.label.includes('default'), `label 要带账号名，实际 ${one.label}`)
      assert(one.kind === 'connector', 'kind 要定死')

      // 别人的连接不该出现在我的选单里。
      const other = await req(base, 'GET', '/mentions', { token: adminTok })
      assert(!other.json.mentions.some((m) => m.id === firstConnId), '别人的连接漏进了选单')

      const filtered = await req(base, 'GET', '/mentions?q=zzz', { token: memberTok })
      assert(filtered.json.mentions.length === 0, '搜索没生效')
    })

    await test('指纹跟着连接走：装了、连了、改了开关都要变', async () => {
      const before = (await req(base, 'GET', '/runtime/catalog/version', { token: seatTok })).json.stamp
      await req(base, 'PATCH', `/me/connectors/${connectorId}/connections/${firstConnId}`, {
        token: memberTok,
        body: { label: 'work' },
      })
      const after = (await req(base, 'GET', '/runtime/catalog/version', { token: seatTok })).json.stamp
      assert(before !== after, `指纹没变，席位就永远看不到这次改动：${before}`)
      await req(base, 'PATCH', `/me/connectors/${connectorId}/connections/${firstConnId}`, {
        token: memberTok,
        body: { label: 'default' },
      })
    })

    await test('席位打 MCP 端点：握手、列工具、调一次', async () => {
      const cat = await req(base, 'GET', '/runtime/catalog', { token: seatTok })
      const server = cat.json.servers.find((x) => x.connector === 'gmail')
      const path = new URL(server.endpoint).pathname
      const rpc = (method, params, id = 1) =>
        req(base, 'POST', path, { token: seatTok, body: { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) } })

      const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} })
      assert(init.json.result?.protocolVersion, `initialize 没回：${init.text}`)

      const list = await rpc('tools/list')
      const names = list.json.result.tools.map((x) => x.name)
      // 工具名去掉了 toolkit 前缀：席位那边还会再拼一次服务器名。
      assert(names.includes('SEND_EMAIL'), `工具名要去前缀：${JSON.stringify(names)}`)
      assert(list.json.result.tools[0].inputSchema.type === 'object', 'schema 要原样带出去')

      const call = await rpc('tools/call', { name: 'SEND_EMAIL', arguments: { to: 'a@b.c' } })
      assert(!call.json.result.isError, `调用应该成功：${call.text}`)
      const ran = mock.seen.executed.at(-1)
      assert(ran.tool === 'GMAIL_SEND_EMAIL', `短名要还原成全名，实际 ${ran.tool}`)
      assert(ran.account === firstExternal, `要指定是哪一把连接，实际 ${ran.account}`)
    })

    await test('不带 toolkit 前缀的 slug 也调得动（按真清单还原，不靠猜前缀）', async () => {
      const cat = await req(base, 'GET', '/runtime/catalog', { token: seatTok })
      const path = new URL(cat.json.servers.find((x) => x.connector === 'gmail').endpoint).pathname
      const list = await req(base, 'POST', path, { token: seatTok, body: { jsonrpc: '2.0', id: 20, method: 'tools/list' } })
      const names = list.json.result.tools.map((x) => x.name)
      assert(names.includes('LOCAL_GMAIL_DIGEST'), `自定义工具该原样出现：${JSON.stringify(names)}`)

      const call = await req(base, 'POST', path, {
        token: seatTok,
        body: { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'LOCAL_GMAIL_DIGEST', arguments: {} } },
      })
      assert(!call.json.result.isError, `自定义工具该调得通：${call.text}`)
      const ran = mock.seen.executed.at(-1)
      // 靠猜前缀会拼成 GMAIL_LOCAL_GMAIL_DIGEST——工具表里有、点了永远失败。
      assert(ran.tool === 'LOCAL_GMAIL_DIGEST', `slug 被猜歪了：${ran.tool}`)
    })

    await test('viaMention 一路带到流水行上', async () => {
      const cat = await req(base, 'GET', '/runtime/catalog', { token: seatTok })
      const path = new URL(cat.json.servers.find((x) => x.connector === 'gmail').endpoint).pathname
      const call = await req(base, 'POST', path, {
        token: seatTok,
        body: {
          jsonrpc: '2.0',
          id: 22,
          method: 'tools/call',
          // 席位靠 MCP 的 _meta 这一格送「这一次是用户 @ 点名的」。
          params: { name: 'SEND_EMAIL', arguments: {}, _meta: { viaMention: true } },
        },
      })
      assert(!call.json.result.isError, `调用该成功：${call.text}`)
      const stats = await req(base, 'GET', `/orgs/${orgId}/connector-stats`, { token: adminTok })
      assert(stats.status === 200, `stats ${stats.status}`)
    })

    await test('「仅 @ 时可用」：服务端也拦，但席位没表态时放行', async () => {
      /**
       * 这道门以前只在席位那一侧（工具表里不放它），那是遮掩不是强制——模型直接报出
       * 工具名照样调得到。补上服务端这一道之后，判据只能是**席位明确说了没点名**：
       * `viaMention` 是席位自报的，取不到 `agents` 时它报的是「不知道」，老席位干脆
       * 不发这个字段。把「没说」当成「没点名」的话，一次取不到服务就会让用户明明
       * `@` 了自己的邮箱、却每次都被回一句「这一轮没有点名它」。
       */
      await req(base, 'PATCH', `/me/connectors/${connectorId}/connections/${firstConnId}`, {
        token: memberTok,
        body: { mentionOnly: true },
      })
      const cat = await req(base, 'GET', '/runtime/catalog', { token: seatTok })
      const path = new URL(cat.json.servers.find((x) => x.connector === 'gmail').endpoint).pathname
      const send = (id, meta) =>
        req(base, 'POST', path, {
          token: seatTok,
          body: {
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name: 'SEND_EMAIL', arguments: {}, ...(meta ? { _meta: meta } : {}) },
          },
        })

      const before = mock.seen.executed.length
      const notNamed = await send(40, { viaMention: false })
      assert(notNamed.json.result.isError, '席位说了没点名，还是让它调了')
      assert(mock.seen.executed.length === before, '被拒的不该打到上游')

      const named = await send(41, { viaMention: true })
      assert(!named.json.result.isError, `点了名的该放行：${named.text}`)

      // 老席位 / 席位那一刻答不上来：字段整个不出现。放行，只在日志里留一行。
      const silent = await send(42, undefined)
      assert(!silent.json.result.isError, `席位没表态时不该拦：${silent.text}`)

      await req(base, 'PATCH', `/me/connectors/${connectorId}/connections/${firstConnId}`, {
        token: memberTok,
        body: { mentionOnly: false },
      })
      const plain = await send(43, undefined)
      assert(!plain.json.result.isError, `关掉 mentionOnly 之后该照常调：${plain.text}`)
    })

    await test('工具不在子集里：拒掉，且不打上游', async () => {
      await req(base, 'PUT', `/me/connectors/${connectorId}/tools`, {
        token: memberTok,
        body: { enabledTools: ['GMAIL_FETCH_EMAILS'] },
      })
      const cat = await req(base, 'GET', '/runtime/catalog', { token: seatTok })
      const path = new URL(cat.json.servers.find((x) => x.connector === 'gmail').endpoint).pathname
      const before = mock.seen.executed.length
      const call = await req(base, 'POST', path, {
        token: seatTok,
        body: { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'SEND_EMAIL', arguments: {} } },
      })
      assert(call.json.result.isError, '没开启的工具应该被拒')
      assert(mock.seen.executed.length === before, '被拒的不该打到上游')

      const list = await req(base, 'POST', path, { token: seatTok, body: { jsonrpc: '2.0', id: 10, method: 'tools/list' } })
      assert(list.json.result.tools.length === 1, `子集之外的不该出现在工具表里：${JSON.stringify(list.json.result.tools)}`)
      await req(base, 'PUT', `/me/connectors/${connectorId}/tools`, { token: memberTok, body: { enabledTools: [] } })
    })

    await test('别人的连接：401/404，打不动', async () => {
      const adminDetail = await req(base, 'GET', `/platform/accounts/${memberId}`, { token: owner })
      const path = `/mcp/connectors/${firstConnId}`
      // 登录 JWT 不认——这条路跑的是公司的真实数据操作。
      const asUser = await req(base, 'POST', path, { token: memberTok, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })
      assert(asUser.status === 401, `登录票不该能调 MCP 端点，实际 ${asUser.status}`)
      assert(adminDetail.status === 200, 'admin detail')
    })

    await test('流水：成功记 ok，上游 500 记 error 且不收钱', async () => {
      const usage = await req(base, 'GET', `/orgs/${orgId}/connector-stats`, { token: adminTok })
      assert(usage.status === 200, `stats ${usage.status} ${usage.text}`)
      assert(usage.json.total.calls >= 2, `流水条数不对：${JSON.stringify(usage.json.total)}`)
      const denied = usage.json.byStatus.find((x) => x.status === 'denied')
      assert(denied && denied.calls >= 1, `被拒的也要落一行：${JSON.stringify(usage.json.byStatus)}`)
    })

    await test('计费：按次扣，余额耗尽之后是一句人话而不是错误堆栈', async () => {
      // 一次调用 0.5 美元（500000 微元），充 1 美元 —— 两次之后就该没了。
      const price = await req(base, 'PUT', '/platform/settings', {
        token: owner,
        body: { connectorPricing: { defaultMicros: 500000, byToolkit: { gmail: 500000 } } },
      })
      assert(price.status === 200, `settings ${price.status} ${price.text}`)
      assert(price.json.connectorPricing.byToolkit.gmail === 500000, `单价没存住：${price.text}`)

      const topup = await req(base, 'POST', '/platform/orders', {
        token: owner,
        body: { companyId: orgId, kind: 'topup', amount: 1, payStatus: 'paid', note: 'e2e' },
      })
      assert(topup.status === 201, `topup ${topup.status} ${topup.text}`)

      const cat = await req(base, 'GET', '/runtime/catalog', { token: seatTok })
      const path = new URL(cat.json.servers.find((x) => x.connector === 'gmail').endpoint).pathname
      const call = (id) =>
        req(base, 'POST', path, {
          token: seatTok,
          body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'SEND_EMAIL', arguments: {} } },
        })

      const one = await call(101)
      assert(!one.json.result.isError, `第一次该成功：${one.text}`)
      const two = await call(102)
      assert(!two.json.result.isError, `第二次该成功：${two.text}`)

      // 两次 × 0.5 = 1 美元，正好花光。第三次要被挡下。
      const three = await call(103)
      assert(three.json.result.isError, '余额光了还能调，那计费就是摆设')
      const text = three.json.result.content[0].text
      assert(text.includes('额度用完了'), `要给一句人话，实际：${text}`)
      assert(!text.includes('Error') && !text.includes('at '), `不能把栈丢给模型：${text}`)

      const stats = await req(base, 'GET', `/orgs/${orgId}/connector-stats`, { token: adminTok })
      assert(stats.json.total.amountMicros === 1000000, `一共该收 1 美元，实际 ${stats.json.total.amountMicros}`)
      assert(stats.json.total.amount === 1, `折美元不对：${stats.json.total.amount}`)

      const mine = await req(base, 'GET', '/me/connector-stats', { token: memberTok })
      assert(mine.status === 200 && mine.json.total.calls >= 3, `员工自己的统计：${mine.text}`)

      const plat = await req(base, 'GET', '/platform/connector-stats', { token: owner })
      assert(plat.status === 200, `platform stats ${plat.status}`)
      assert(plat.json.byCompany.some((c) => c.companyId === orgId), '平台统计里要按公司分开')

      // 单价改回 0，后面的用例不受影响。历史流水的金额**不跟着变**——那是这套口径的重点。
      await req(base, 'PUT', '/platform/settings', { token: owner, body: { connectorPricing: { defaultMicros: 0, byToolkit: {} } } })
      const after = await req(base, 'GET', `/orgs/${orgId}/connector-stats`, { token: adminTok })
      assert(after.json.total.amountMicros === 1000000, `改单价不该改动历史账，实际 ${after.json.total.amountMicros}`)
    })

    await test('超时照收钱，并且记成 timeout 而不是 error', async () => {
      // 上游挂住不回，Gateway 的 45 秒上限太长，用一个短得多的探针值把它压下来。
      // 这一档最容易被写成不收钱——而那等于给「超时的写操作」免单，邮件可能已经发出去了。
      const price = await req(base, 'PUT', '/platform/settings', {
        token: owner,
        body: { connectorPricing: { defaultMicros: 1000, byToolkit: {} } },
      })
      assert(price.status === 200, `settings ${price.status}`)
      const top = await req(base, 'POST', '/platform/orders', {
        token: owner,
        body: { companyId: orgId, kind: 'topup', amount: 1, payStatus: 'paid', note: 'timeout' },
      })
      assert(top.status === 201, `topup ${top.status} ${top.text}`)

      const before = await req(base, 'GET', `/orgs/${orgId}/connector-stats`, { token: adminTok })
      const beforeMicros = before.json.total.amountMicros

      const cat = await req(base, 'GET', '/runtime/catalog', { token: seatTok })
      const path = new URL(cat.json.servers.find((x) => x.connector === 'gmail').endpoint).pathname
      const call = await req(base, 'POST', path, {
        token: seatTok,
        body: { jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'GMAIL_HANG', arguments: {} } },
      })
      assert(call.json.result.isError, '超时该报错给模型')
      assert(String(call.json.result.content[0].text).includes('超时'), `要说清是超时：${call.json.result.content[0].text}`)

      const after = await req(base, 'GET', `/orgs/${orgId}/connector-stats`, { token: adminTok })
      const timeout = after.json.byStatus.find((x) => x.status === 'timeout')
      assert(timeout && timeout.calls === 1, `该记成 timeout：${JSON.stringify(after.json.byStatus)}`)
      assert(
        after.json.total.amountMicros === beforeMicros + 1000,
        `超时要照收钱：${beforeMicros} → ${after.json.total.amountMicros}`,
      )
      await req(base, 'PUT', '/platform/settings', { token: owner, body: { connectorPricing: { defaultMicros: 0, byToolkit: {} } } })
    })

    await test('上游 5xx 不收钱，记成 error', async () => {
      await req(base, 'PUT', '/platform/settings', {
        token: owner,
        body: { connectorPricing: { defaultMicros: 1000, byToolkit: {} } },
      })
      const before = await req(base, 'GET', `/orgs/${orgId}/connector-stats`, { token: adminTok })
      const cat = await req(base, 'GET', '/runtime/catalog', { token: seatTok })
      const path = new URL(cat.json.servers.find((x) => x.connector === 'gmail').endpoint).pathname
      const call = await req(base, 'POST', path, {
        token: seatTok,
        body: { jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'GMAIL_BOOM', arguments: {} } },
      })
      assert(call.json.result.isError, '5xx 该报错给模型')
      const after = await req(base, 'GET', `/orgs/${orgId}/connector-stats`, { token: adminTok })
      assert(
        after.json.total.amountMicros === before.json.total.amountMicros,
        `没跑成就不该收钱：${before.json.total.amountMicros} → ${after.json.total.amountMicros}`,
      )
      const err = after.json.byStatus.find((x) => x.status === 'error')
      assert(err && err.calls >= 1, `该记成 error：${JSON.stringify(after.json.byStatus)}`)
      await req(base, 'PUT', '/platform/settings', { token: owner, body: { connectorPricing: { defaultMicros: 0, byToolkit: {} } } })
    })

    await test('套餐赠送到期之后，已经花掉的那部分不会再从充值余额里扣一遍', async () => {
      /**
       * 这一条守的是分桶记账。合成一个数（(赠送+充值) − 全部历史花费）的话：
       * 赠送一到期就归零，但它**已经花掉的部分仍然留在花费里**，等于从充值余额上再扣
       * 一遍——刚充过钱的公司当场被判成欠费，所有调用被拒。
       */
      const sku = await req(base, 'POST', '/platform/plans', {
        token: owner,
        body: { name: '连接器测试套餐', amount: 1, seats: 3, period: 'month', bonus: 1 },
      })
      assert(sku.status === 201, `plan sku ${sku.status} ${sku.text}`)
      const order = await req(base, 'POST', '/platform/orders', {
        token: owner,
        body: { companyId: orgId, kind: 'plan', planId: sku.json.plan.id, payStatus: 'paid' },
      })
      assert(order.status === 201, `plan order ${order.status} ${order.text}`)

      await req(base, 'PUT', '/platform/settings', {
        token: owner,
        body: { connectorPricing: { defaultMicros: 500000, byToolkit: {} } },
      })
      const cat = await req(base, 'GET', '/runtime/catalog', { token: seatTok })
      const path = new URL(cat.json.servers.find((x) => x.connector === 'gmail').endpoint).pathname
      const call = (id) =>
        req(base, 'POST', path, {
          token: seatTok,
          body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'SEND_EMAIL', arguments: {} } },
        })

      // 把这一期的赠送（$1）正好花光：两次 × $0.5。
      const a = await call(40)
      const b = await call(41)
      assert(!a.json.result.isError && !b.json.result.isError, `赠送额度内该跑得通：${a.text} ${b.text}`)

      // 套餐失效（改成未付款 = 没有生效订单，等同于到期）。赠送归零。
      const off = await req(base, 'PUT', `/platform/orders/${order.json.order.id}`, {
        token: owner,
        body: { payStatus: 'unpaid' },
      })
      assert(off.status === 200, `order off ${off.status} ${off.text}`)

      // 现在充 $1。这笔钱一分没花过，必须能用。
      const topup = await req(base, 'POST', '/platform/orders', {
        token: owner,
        body: { companyId: orgId, kind: 'topup', amount: 1, payStatus: 'paid', note: 'after-expiry' },
      })
      assert(topup.status === 201, `topup ${topup.status} ${topup.text}`)

      const after = await call(42)
      assert(
        !after.json.result.isError,
        `刚充过钱就被判欠费了——上一期的赠送花费被算到充值头上：${after.json.result.content?.[0]?.text}`,
      )
      await req(base, 'PUT', '/platform/settings', { token: owner, body: { connectorPricing: { defaultMicros: 0, byToolkit: {} } } })
    })

    await test('admin 禁掉之后：员工装不了，市场里写明原因', async () => {
      const block = await req(base, 'PUT', `/orgs/${orgId}/connectors/${connectorId}/block`, {
        token: adminTok,
        body: { blocked: true, reason: '合规未过' },
      })
      assert(block.status === 200, `block ${block.status} ${block.text}`)

      const market = await req(base, 'GET', '/me/connectors', { token: memberTok })
      const one = market.json.connectors.find((c) => c.id === connectorId)
      assert(one.blocked === true && one.blockedReason === '合规未过', `禁令没生效：${JSON.stringify(one)}`)

      const install = await req(base, 'POST', `/me/connectors/${connectorId}/install`, { token: memberTok })
      assert(install.status === 403, `被禁的应该装不了，实际 ${install.status}`)

      const un = await req(base, 'PUT', `/orgs/${orgId}/connectors/${connectorId}/block`, {
        token: adminTok,
        body: { blocked: false },
      })
      assert(un.status === 200, `unblock ${un.status}`)
      const after = await req(base, 'GET', '/me/connectors', { token: memberTok })
      assert(after.json.connectors.find((c) => c.id === connectorId).blocked === false, '解禁没生效')
    })

    await test('admin 看得到本公司谁装了什么', async () => {
      const r = await req(base, 'GET', `/orgs/${orgId}/connectors`, { token: adminTok })
      assert(r.status === 200, `org connectors ${r.status} ${r.text}`)
      const one = r.json.connectors.find((c) => c.id === connectorId)
      assert(one.installs === 1, `装机量应该是 1，实际 ${one.installs}`)
      assert(one.connections === 1, `活跃连接应该是 1，实际 ${one.connections}`)
      assert(!r.text.includes('ac_secret_123'), 'authConfigId 不能进公司那一屏')
    })

    await test('卸载连带断开：本地没了，供应商那边也被断了', async () => {
      const del = await req(base, 'DELETE', `/me/connectors/${connectorId}/install`, { token: memberTok })
      assert(del.status === 200, `uninstall ${del.status} ${del.text}`)
      assert(mock.seen.deleted.includes(firstExternal), `供应商那边没断：${JSON.stringify(mock.seen.deleted)}`)
      const detail = await req(base, 'GET', `/me/connectors/${connectorId}`, { token: memberTok })
      assert(detail.json.install === null, '安装记录还在')
      assert(detail.json.connections.length === 0, `连接没清干净：${detail.json.connections.length}`)
    })

    await test('界面：owner 那一屏画得出供应商卡与上架列表', async () => {
      const { loadApp } = await import('./ui-dom.mjs')
      const ui = loadApp({ appPath: join(root, 'gateway/ui/app.js'), base, token: owner })
      await ui.boot()
      ui.state.path = '/connectors'
      ui.state.connectorVendors = [{ vendor: 'composio', configured: true, caps: { multiAccount: true }, credential: {} }]
      ui.state.connectors = [
        { id: connectorId, vendor: 'composio', toolkit: 'gmail', name: 'Gmail', description: '收发邮件', category: 'productivity', authReady: true, enabled: true },
      ]
      ui.render()
      const html = ui.html()
      assert(html.includes('Composio'), '供应商卡没画出来')
      assert(html.includes('Gmail'), '上架列表没画出来')
      assert(html.includes('conn-publish-open'), '「上架连接器」按钮没画出来')
      assert(ui.pathAllowed('/connectors'), 'owner 应该进得了 /connectors')
    })

    await test('界面：员工那一屏是市场卡片，禁用的写明原因', async () => {
      const { loadApp } = await import('./ui-dom.mjs')
      // 用**员工**的票：管理员那一屏是禁令和账，不是市场（两屏分开是有意的）。
      const ui = loadApp({ appPath: join(root, 'gateway/ui/app.js'), base, token: memberTok })
      await ui.boot()
      ui.state.path = '/connectors'
      ui.state.market = [
        { id: 'c1', toolkit: 'gmail', name: 'Gmail', description: '收发邮件', category: 'productivity', blocked: false },
        { id: 'c2', toolkit: 'notion', name: 'Notion', description: '知识库', category: 'productivity', blocked: true, blockedReason: '合规未过' },
      ]
      ui.render()
      const html = ui.html()
      assert(html.includes('Gmail') && html.includes('Notion'), '市场卡片没画出来')
      assert(html.includes('合规未过'), '被禁的没写出原因')
      assert(!html.includes('conn-publish-open'), '员工不该看到「上架」')
      assert(ui.pathAllowed('/connectors'), '员工应该进得了 /connectors')
    })

    await test('界面：取不到 logo 时的兜底缩写不会漏成正文', async () => {
      // 这里原来挂的是一段**写在 HTML 属性里的 JS**（`onerror="…createContextualFragment(…)"`），
      // 只 JSON.stringify 一次不够：反斜杠对 HTML 解析器没有意义，`\"` 里的引号会把属性
      // 收掉，后面半截 `GI"))">` 直接显示在名字后面——市场里每张带 logo 的卡片都挂一串乱码。
      //
      // 现在名字原样放在 data-mark 上，替换由 shell.js 的 mediaFallback 用 textContent 做，
      // 只剩属性这一层要转义，那个坑没有了。所以这条断言的是新形状：**属性里不许再有 JS**。
      const { loadApp } = await import('./ui-dom.mjs')
      const ui = loadApp({ appPath: join(root, 'gateway/ui/app.js'), base, token: memberTok })
      await ui.boot()
      ui.state.path = '/connectors'
      ui.state.market = [{ id: 'c1', toolkit: 'github', name: 'GitHub "Inc"', description: '代码托管', logo: 'https://x/gh.png', blocked: false }]
      ui.render()
      const html = ui.html()
      assert(html.includes('data-onerror="mark"'), 'logo 的兜底没画出来')
      assert(html.includes('data-mark="GitHub &quot;Inc&quot;"'), `名字没按 HTML 属性转义：${html.slice(html.indexOf('data-mark'), html.indexOf('data-mark') + 120)}`)
      assert(!html.includes('\\"'), '属性里漏出了反斜杠转义')
      assert(!/(^|[\s"])onerror=/.test(html), '又出现了内联 onerror——CSP 的 script-src 不带 unsafe-inline，它跑不起来')
    })

    /**
     * 整套界面里**一行内联脚本都不能有**。
     *
     * CSP 的 script-src 不带 `'unsafe-inline'`（gateway/src/http.ts 的 CSP），所以任何
     * 一个 `onclick=` / `onerror=` 或者 index.html 里的一段 `<script>…</script>` 都会
     * 被浏览器直接拒执行——而拒的方式是静默的：那颗按钮点了没反应、那张图挂了不换兜底。
     * 这类错在 DOM 垫片里跑不出来（垫片不管 CSP），所以按源码扫一遍。
     */
    await test('界面：没有内联脚本，也没有内联事件处理器（CSP 的前提）', async () => {
      const { readFileSync, readdirSync } = await import('node:fs')
      const uiDir = join(root, 'gateway/ui')
      const bad = []
      for (const name of readdirSync(uiDir)) {
        if (!/\.(js|html)$/.test(name)) continue
        const text = readFileSync(join(uiDir, name), 'utf8')
        for (const m of text.matchAll(/(^|[\s"'`])on[a-z]+\s*=\s*["'][^"']*["']/g)) {
          // data-onload / data-onerror 是我们自己那套委派标记，不是内联处理器。
          if (/(^|[\s"'`])data-on/.test(m[0])) continue
          bad.push(`${name}: ${m[0].trim().slice(0, 60)}`)
        }
        if (name.endsWith('.html') && /<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(text)) {
          bad.push(`${name}: 内联 <script> 块`)
        }
      }
      assert(bad.length === 0, `这些地方 CSP 会挡掉：\n  ${bad.join('\n  ')}`)
    })

    await test('界面：插件弹窗——按钮在名单底下，点 Add 就装上，装完不跳页', async () => {
      const { loadApp, el } = await import('./ui-dom.mjs')
      const ui = loadApp({ appPath: join(root, 'gateway/ui/app.js'), base, token: memberTok })
      await ui.boot()
      assert(ui.html().includes('data-act="plugins-open"'), '侧栏没有「插件」按钮')
      assert(!/data-href="\/connectors"/.test(ui.html()), '菜单里还留着「连接器」那一行，和插件按钮重了')

      await ui.fire('click', el('button', { 'data-act': 'plugins-open' }))
      let html = ui.html()
      assert(html.includes('gw-plugins'), '弹窗没开')
      assert(html.includes('Gmail'), '弹窗里没有市场清单')
      assert(html.includes(`data-act="conn-install" data-id="${connectorId}"`), '没装的应该给「添加」')

      await ui.fire('click', el('button', { 'data-act': 'conn-install', 'data-id': connectorId }))
      html = ui.html()
      assert(ui.state.path === '/', `装完不该跳页，现在在 ${ui.state.path}`)
      assert(html.includes('gw-plugins'), '装完弹窗被关掉了')
      assert(ui.state.plugins.id === connectorId, '装完没落到详情上')
      assert(html.includes('data-act="conn-add-account"'), '详情里没有「添加账号」——装完就该能连')
      assert(html.includes('GMAIL_SEND_EMAIL'), '详情里没有工具开关')
      // 弹窗和 /connectors/:id 两份详情分开存，否则关掉弹窗后底下那页画的是别人的账号。
      assert(ui.state.connectorDetail == null, '弹窗把页面那份详情盖掉了')

      await ui.fire('click', el('button', { 'data-act': 'plugins-close' }))
      assert(!ui.html().includes('gw-plugins'), '关不掉')

      // 装回去的这一笔要还原：下面还有测试在数装机量。
      const del = await req(base, 'DELETE', `/me/connectors/${connectorId}/install`, { token: memberTok })
      assert(del.status === 200, `复原卸载 ${del.status}`)
    })

    await test('界面：加账号开新标签页去授权，不把当前这一页顶掉', async () => {
      const { loadApp, el } = await import('./ui-dom.mjs')
      const ui = loadApp({ appPath: join(root, 'gateway/ui/app.js'), base, token: memberTok })
      await ui.boot()
      await ui.fire('click', el('button', { 'data-act': 'plugins-open' }))
      await ui.fire('click', el('button', { 'data-act': 'conn-install', 'data-id': connectorId }))
      const before = ui.location.href

      await ui.fire('click', el('button', { 'data-act': 'conn-add-account', 'data-id': connectorId }))
      assert(ui.windowOpens.length === 1, `该开一个新标签页，实际开了 ${ui.windowOpens.length} 个`)
      const tab = ui.windowOpens[0]
      assert(tab.location.href.startsWith('https://accounts.example.com/'), `新页没送到授权地址：${tab.location.href}`)
      assert(!tab.closed, '新页被关掉了')
      // 反向标签劫持：授权页拿着 opener 就能把我们这一页换成钓鱼页。
      assert(tab.opener === null, 'opener 没断')
      // 这一边必须原封不动——弹窗多半盖在对话上，顶掉就等于把草稿和滚动位置一起扔了。
      assert(ui.location.href === before, `当前这一页被顶掉了：${ui.location.href}`)
      assert(ui.html().includes('gw-plugins'), '弹窗被关掉了')

      // 复原：断掉刚发起的那把，再卸载。下面还有测试在数装机量和连接数。
      const detail = await req(base, 'GET', `/me/connectors/${connectorId}`, { token: memberTok })
      for (const c of detail.json.connections || []) {
        await req(base, 'DELETE', `/me/connectors/${connectorId}/connections/${c.id}`, { token: memberTok })
      }
      const del = await req(base, 'DELETE', `/me/connectors/${connectorId}/install`, { token: memberTok })
      assert(del.status === 200, `复原卸载 ${del.status}`)
    })

    await test('界面：关掉弹窗要把底下那页刷新；晚到的详情不许落盘', async () => {
      const { loadApp, el } = await import('./ui-dom.mjs')
      // 只把「取这个连接器的详情」这一条拖慢，其余照打真 Gateway。
      let hold = 0
      const fetchImpl = (path, init) => {
        const go = () => fetch(base + path, init)
        if (hold && path === `/me/connectors/${connectorId}`) return new Promise((r) => setTimeout(() => r(go()), hold))
        return go()
      }
      const ui = loadApp({ appPath: join(root, 'gateway/ui/app.js'), base, token: memberTok, fetchImpl })
      await ui.boot()

      // 弹窗盖在这个连接器的详情页上，而页面手上那份是过期的（多一把已经断掉的连接）。
      // 弹窗里的改动只落在它自己那一份上，关掉时不补一次，那一行就会一直画着。
      ui.state.path = `/connectors/${connectorId}`
      ui.state.connectorDetail = {
        connector: { id: connectorId, name: 'Gmail', toolkit: 'gmail', description: '', blocked: false },
        install: { id: 'i1', enabledTools: [] },
        connections: [{ id: 'ghost', label: '已经断掉的', scope: 'user', status: 'active', mentionOnly: false }],
        tools: [],
      }
      await ui.fire('click', el('button', { 'data-act': 'plugins-open' }))
      await ui.fire('click', el('button', { 'data-act': 'plugins-close' }))
      assert(!ui.html().includes('已经断掉的'), '关掉弹窗之后，底下那页还画着弹窗里已经改掉的东西')

      // 详情还在飞的时候退回清单：晚到的那一份不许写进来。写了就和 p.id 对不上，
      // 弹窗永远停在「加载中…」，而且已经没有请求在飞，只能退出去重进。
      hold = 300
      await ui.fire('click', el('button', { 'data-act': 'plugins-open' }))
      const inflight = ui.fire('click', el('button', { 'data-act': 'plugins-detail', 'data-id': connectorId }))
      await ui.fire('click', el('button', { 'data-act': 'plugins-back' }))
      await inflight
      assert(ui.state.pluginDetail == null, '晚到的详情盖进来了')
      assert(ui.html().includes('gw-plugins') && !ui.html().includes('加载中'), '弹窗停在「加载中…」')
    })

    await test('界面：员工的详情页画得出账号行、工具开关与「仅 @ 时可用」', async () => {
      const { loadApp } = await import('./ui-dom.mjs')
      const ui = loadApp({ appPath: join(root, 'gateway/ui/app.js'), base, token: memberTok })
      await ui.boot()
      ui.state.path = `/connectors/${connectorId}`
      ui.state.connectorDetail = {
        connector: { id: connectorId, name: 'Gmail', description: '收发邮件', toolkit: 'gmail', blocked: false },
        install: { id: 'i1', enabledTools: ['GMAIL_SEND_EMAIL'] },
        connections: [
          { id: 'x1', label: 'default', scope: 'user', status: 'active', mentionOnly: false },
          { id: 'x2', label: 'personal', scope: 'user', status: 'active', mentionOnly: true },
          { id: 'x3', label: 'company', scope: 'company', status: 'active', mentionOnly: false },
        ],
        tools: [
          { slug: 'GMAIL_SEND_EMAIL', description: '发一封邮件' },
          { slug: 'GMAIL_FETCH_EMAILS', description: '拉最近的邮件' },
        ],
      }
      ui.render()
      const html = ui.html()
      assert(html.includes('default') && html.includes('personal'), '两把连接都要画出来')
      assert(html.includes('仅 @ 时可用'), '「仅 @ 时可用」开关没画出来')
      assert(html.includes('GMAIL_SEND_EMAIL'), '工具清单没画出来')
      assert(html.includes('1 / 2 个已开启'), `工具计数不对：${html.match(/\d+ \/ \d+ 个已开启/)?.[0]}`)
      // 公司共用那把不给员工断，也不给他改 mentionOnly。
      const companyRow = html.slice(html.indexOf('company'))
      assert(!companyRow.includes('conn-disconnect" data-id="x3"'), '公司共用那把不该有断开按钮')
      assert(ui.pathAllowed(`/connectors/${connectorId}`), '详情页应该进得去')
    })

    await test('界面：admin 那一屏是禁令 + 谁装了什么，不是市场', async () => {
      const { loadApp } = await import('./ui-dom.mjs')
      const ui = loadApp({ appPath: join(root, 'gateway/ui/app.js'), base, token: adminTok })
      await ui.boot()
      ui.state.path = '/connectors'
      ui.state.orgConnectors = [
        { id: connectorId, name: 'Gmail', toolkit: 'gmail', installs: 1, connections: 1, blocked: false },
      ]
      ui.state.connectorStats = {
        total: { calls: 3, amount: 1, amountMicros: 1000000 },
        installs: [{ connectorId, connector: 'gmail', name: 'Gmail', accountId: 'a', accountName: '小王' }],
      }
      ui.render()
      const html = ui.html()
      assert(html.includes('小王'), '「谁装了什么」没画出来')
      assert(html.includes('conn-block'), '禁用按钮没画出来')
      assert(!html.includes('conn-install'), 'admin 那一屏不该是市场')
    })

    await test('界面：owner 的单价卡按美元显示，存的是微元', async () => {
      const { loadApp } = await import('./ui-dom.mjs')
      const ui = loadApp({ appPath: join(root, 'gateway/ui/app.js'), base, token: owner })
      await ui.boot()
      ui.state.path = '/connectors'
      ui.state.connectorVendors = [{ vendor: 'composio', configured: true, caps: {}, credential: {} }]
      ui.state.connectors = [{ id: connectorId, vendor: 'composio', toolkit: 'gmail', name: 'Gmail', authReady: true, enabled: true }]
      ui.state.settings = { ...(ui.state.settings || {}), connectorPricing: { defaultMicros: 2000, byToolkit: { gmail: 500000 } } }
      ui.render()
      const html = ui.html()
      assert(html.includes('按次单价'), '单价卡没画出来')
      assert(html.includes('value="0.002"'), `默认单价该折成美元：${html.match(/data-input="price-default"[^>]*/)?.[0]}`)
      assert(html.includes('value="0.5"'), 'toolkit 覆盖价没折成美元')
    })

    await test('界面：@ 只在词首触发，邮箱地址不会把选单弹出来', async () => {
      const { loadApp, el } = await import('./ui-dom.mjs')
      const ui = loadApp({
        appPath: join(root, 'gateway/ui/app.js'),
        base,
        token: memberTok,
        stubIds: ['chat-queue', 'chat-mentions', 'chat-mentionpick'],
      })
      await ui.boot()

      const hit = ui.mentionQueryAt(el('textarea', {}, '看看 @gm'))
      assert(hit && hit.q === 'gm', `词首的 @ 该触发：${JSON.stringify(hit)}`)
      // 这一条是重点：邮箱里的 @ 前面挨着字母，不该弹选单——否则打一个邮箱地址，
      // 选单会一路跟着蹦。
      assert(ui.mentionQueryAt(el('textarea', {}, '发给 a@b.c')) === null, '邮箱地址不该触发选单')
      assert(ui.mentionQueryAt(el('textarea', {}, '@gm 之后又打了空格 ')) === null, '空格之后就不再是这个词了')
      assert(ui.mentionQueryAt(el('textarea', {}, '没有艾特')) === null, '没有 @ 却触发了')
    })

    await test('界面：药丸和排队 dock 画得出，dock 只有一行字', async () => {
      const { loadApp } = await import('./ui-dom.mjs')
      const ui = loadApp({
        appPath: join(root, 'gateway/ui/app.js'),
        base,
        token: memberTok,
        stubIds: ['chat-queue', 'chat-mentions', 'chat-mentionpick'],
      })
      await ui.boot()

      ui.state.chatMentions = [{ kind: 'connector', id: 'c1', label: 'Gmail (personal)' }]
      ui.paintChatMentions()
      const pills = ui.stubs.get('chat-mentions').innerHTML
      assert(pills.includes('Gmail (personal)'), `药丸没画出来：${pills}`)
      assert(pills.includes('chat-mention-drop'), '药丸上没有移除按钮')

      ui.state.chatSessionId = 's1'
      ui.chatQueues.set('s1', [
        { id: 'q1', text: '排队的第一句', mentions: [{ id: 'c1', label: 'Gmail (personal)' }], images: [{ path: 'a.png' }] },
        { id: 'q2', text: '排队的第二句', mentions: [] },
      ])
      ui.paintChatQueue()
      const dock = ui.stubs.get('chat-queue').innerHTML
      assert(dock.includes('排队的第一句') && dock.includes('排队的第二句'), `dock 没画出来：${dock}`)
      assert(dock.includes('chat-queue-cancel'), 'dock 上没有取消')
      // **不展开附件**：图片不出缩略图，@ 出来的药丸也不画。它是提醒，不是气泡的预演。
      assert(!dock.includes('a.png'), 'dock 把附件也画上了')
      assert(!dock.includes('Gmail (personal)'), 'dock 把点名的药丸也画上了')
    })

    await test('界面：工具开多了给红字，别静默截断', async () => {
      const { loadApp } = await import('./ui-dom.mjs')
      const ui = loadApp({ appPath: join(root, 'gateway/ui/app.js'), base, token: memberTok })
      await ui.boot()
      ui.state.path = `/connectors/${connectorId}`
      ui.state.connectorDetail = {
        connector: { id: connectorId, name: 'Gmail', toolkit: 'gmail', blocked: false },
        install: { id: 'i1', enabledTools: ['A', 'B', 'C'] },
        connections: [{ id: 'x1', label: 'default', scope: 'user', status: 'active', mentionOnly: false }],
        tools: [{ slug: 'A' }, { slug: 'B' }, { slug: 'C' }],
        toolCap: 2,
      }
      ui.render()
      const html = ui.html()
      // 超过上限时多出来的不会下发。静默截断的表现是「某个工具时有时无」，最难查。
      assert(html.includes('超过上限'), `该给一条红字：${html.slice(html.indexOf('工具'), html.indexOf('工具') + 400)}`)
      assert(html.includes('不会下发'), '没说清后果')
    })

    await test('下架之后市场里就没有了', async () => {
      const del = await req(base, 'DELETE', `/platform/connectors/${connectorId}`, { token: owner })
      assert(del.status === 200, `unpublish ${del.status}`)
      const market = await req(base, 'GET', '/me/connectors', { token: adminTok })
      assert(market.json.connectors.length === 0, `下架后市场应该空，实际 ${market.json.connectors.length}`)
    })
  } finally {
    // closeServer 先掐 keep-alive 连接再关：裸 close() 会等 Gateway 反代那条连接自己断，那永远不来。
    await closeServer(mock.server, 'composio mock')
    gw.kill()
    // 自己的数据目录自己收。
    rmSync(GW_HOME, { recursive: true, force: true })
  }
}
