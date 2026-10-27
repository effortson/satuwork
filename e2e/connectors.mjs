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
import { createHash } from 'node:crypto'
import { schemaOf, tmpOf } from './isolate.mjs'
import { freePort } from './ports.mjs'
import { closeServer, runProbe } from './probe.mjs'
import { startGateway } from './gateway.mjs'

const TOOLKITS = {
  items: [
    { slug: 'gmail', name: 'Gmail', meta: { description: '收发邮件', logo: 'https://x/gmail.png', categories: [{ name: 'productivity' }] }, auth_schemes: [{ mode: 'OAUTH2' }] },
    { slug: 'notion', name: 'Notion', meta: { description: '知识库', categories: [{ name: 'productivity' }] }, auth_schemes: [{ mode: 'OAUTH2' }] },
  ],
}
const TOOLS = {
  items: [
    {
      slug: 'GMAIL_SEND_EMAIL',
      name: 'Send email',
      description: '发一封邮件',
      input_parameters: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          // 多收件人照 Composio 的形状：第一个在 recipient_email，其余在 extra_recipients。
          // 供应商的说明里有，但模型看漏过（只填一个、其余写进正文），下发前要补一句醒目的。
          recipient_email: { type: 'string', description: 'Primary recipient' },
          extra_recipients: { type: 'array', items: { type: 'string' } },
          // 文件参数照 Composio 的形状：`file_uploadable: true` + 三个字符串。模型只看得到
          // 三个字符串，不告诉它 s3key 从哪来，它就会把本地路径填进去（线上真发生过）。
          attachment: {
            type: 'object',
            file_uploadable: true,
            description: 'File to attach',
            properties: { name: { type: 'string' }, mimetype: { type: 'string' }, s3key: { type: 'string' } },
          },
        },
      },
    },
    { slug: 'GMAIL_FETCH_EMAILS', name: 'Fetch emails', description: '拉最近的邮件', input_parameters: { type: 'object', properties: {} } },
    // **不以 toolkit 名开头的 slug。** Composio 的自定义工具就是这种形状，而按前缀猜
    // 的还原会把它拼成 GMAIL_LOCAL_GMAIL_…，工具表里有、点了永远失败。
    { slug: 'LOCAL_GMAIL_DIGEST', name: 'Digest', description: '自定义工具', input_parameters: { type: 'object', properties: {} } },
  ],
}

function mockComposio() {
  const seen = { keys: new Set(), initiated: [], deleted: [], executed: [], staged: [], puts: [], proxied: [] }
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
    // 附件暂存的两步：先要地址，再 PUT 字节。预签名地址指回这台假服务器自己。
    if (url.pathname === '/files/upload/request' && req.method === 'POST') {
      let raw = ''
      req.on('data', (d) => { raw += d })
      req.on('end', () => {
        const body = JSON.parse(raw || '{}')
        seen.staged.push(body)
        const key = `req/${body.toolkit_slug}/${body.md5}`
        send(200, { id: `f_${seen.staged.length}`, key, new_presigned_url: `http://127.0.0.1:${server.address().port}/s3/${encodeURIComponent(key)}`, metadata: { storage_backend: 's3' } })
      })
      return
    }
    const s3 = /^\/s3\/(.+)$/.exec(url.pathname)
    if (s3 && req.method === 'PUT') {
      // 这条**不带 x-api-key**：它是对象存储的地址，不是 Composio 的 API。
      const chunks = []
      req.on('data', (d) => chunks.push(d))
      req.on('end', () => {
        seen.puts.push({ key: decodeURIComponent(s3[1]), apiKey: req.headers['x-api-key'] || '', contentType: req.headers['content-type'] || '', body: Buffer.concat(chunks) })
        res.writeHead(200)
        res.end()
      })
      return
    }
    // 代理：上游替我们带上令牌去打那条地址。只认验证用的那一条，别的一律 403（真上游
    // 也不放行跨域）。**不是工具执行**，不进 seen.executed。
    if (url.pathname === '/tools/execute/proxy' && req.method === 'POST') {
      let raw = ''
      req.on('data', (d) => { raw += d })
      req.on('end', () => {
        const body = JSON.parse(raw || '{}')
        seen.proxied.push(body)
        if (!accounts.has(body.connected_account_id) || !String(body.endpoint).endsWith('/users/me/profile')) return send(200, { status: 403, data: {} })
        send(200, { status: 200, headers: {}, data: { emailAddress: `${body.connected_account_id}@gmail.test`, messagesTotal: 3 } })
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
      if (!st) return send(404, { error: { message: 'no such account' } })
      // 连上之后的记录照上游真实的样子：令牌挨着一份**打了码的** id_token（认不出人），
      // 外加一条验证用的地址。是谁要经代理打那条地址才知道；令牌一个字都不能漏出去。
      const live = st === 'ACTIVE'
        ? {
            state: { authScheme: 'OAUTH2', val: { status: 'ACTIVE', access_token: 'ya29.secret-access', id_token: 'REDACTED' } },
            test_request_endpoint: 'https://www.googleapis.com/gmail/v1/users/me/profile',
          }
        : {}
      return send(200, { id: m[1], status: st, ...live })
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

  log('\n# connectors')

  const mock = await mockComposio()
  const { gw } = await startGateway({
    name: 'connectors-gw',
    what: 'connectors gateway',
    home: GW_HOME,
    schema: schemaOf('e2e_connectors'),
    port: GW_PORT,
    env: {
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '0',
      COMPOSIO_BASE_URL: mock.url,
      // 超时那一档要验，45 秒等不起。
      CONNECTOR_UPSTREAM_TIMEOUT_MS: '1500',
      // 附件上限压到 4 KB：413 那一档要验，25 MB 的字节不值得在 e2e 里真传。
      CONNECTOR_UPLOAD_MAX_BYTES: '4096',
    },
  })

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
      // 账号名是人起的，连的是哪个邮箱要从上游认出来（迁移 0065）；令牌绝不能跟着出来。
      assert(one.accountName === `${firstExternal}@gmail.test`, `没认出连的是哪个账号：${JSON.stringify(one.accountName)}`)
      assert(!detail.text.includes('secret-access'), '上游的令牌漏进了详情')
      const probe = mock.seen.proxied.find((p) => p.connected_account_id === firstExternal)
      assert(probe?.method === 'GET', `该经代理 GET 记录里那条验证地址：${JSON.stringify(mock.seen.proxied)}`)
      // 认出来就存下：再进一次详情页不再去问。
      const n = mock.seen.proxied.length
      await req(base, 'GET', `/me/connectors/${connectorId}`, { token: memberTok })
      assert(mock.seen.proxied.length === n, '认出来之后每次进详情页还在重问')
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

    await test('/mentions：设了主 Bot 之后名单上别的 Bot 也进选单，带 mainBotId', async () => {
      const before = await req(base, 'GET', '/mentions', { token: memberTok })
      assert(!before.json.mentions.some((m) => m.kind === 'bot') && !before.json.mainBotId, '没设主 Bot 就不该列 Bot')
      const a = await req(base, 'POST', '/runtime/bots', { token: memberTok, body: { name: '助手' } })
      const b = await req(base, 'POST', '/runtime/bots', { token: memberTok, body: { name: '财务' } })
      assert(a.status === 201 && b.status === 201, `建 Bot ${a.status} ${b.status}`)
      const set = await req(base, 'PUT', '/runtime/main-bot', { token: memberTok, body: { botId: a.json.bot.id } })
      assert(set.status === 200, `设主 Bot ${set.status} ${set.text}`)
      const r = await req(base, 'GET', '/mentions', { token: memberTok })
      assert(r.json.mainBotId === a.json.bot.id, `mainBotId 不对：${r.json.mainBotId}`)
      const fin = r.json.mentions.find((m) => m.kind === 'bot' && m.id === b.json.bot.id)
      assert(fin && fin.label === '财务' && fin.icon && fin.origin === 'company', `别的 Bot 该在选单里：${JSON.stringify(fin)}`)
      assert(!r.json.mentions.some((m) => m.kind === 'bot' && m.id === a.json.bot.id), '主 Bot 自己不该在选单里')
      // 连接器那部分照旧在。
      assert(r.json.mentions.some((m) => m.id === firstConnId), '加了 Bot 之后连接器不见了')
      const q = await req(base, 'GET', '/mentions?q=财', { token: memberTok })
      assert(q.json.mentions.some((m) => m.id === b.json.bot.id) && !q.json.mentions.some((m) => m.id === firstConnId), '搜索对 Bot 没生效')
      await req(base, 'PUT', '/runtime/main-bot', { token: memberTok, body: { botId: null } })
    })

    await test('可用 Bot：收窄到指定 Bot 之后，别的 Bot 目录里没有、点不到、调不动；删光了是谁都不给', async () => {
      // docs/connector-bot-scope.md。default 那把收窄到 A：B 的目录里不该有它。
      const a = await req(base, 'POST', '/runtime/bots', { token: memberTok, body: { name: '私人助理' } })
      const b = await req(base, 'POST', '/runtime/bots', { token: memberTok, body: { name: '客服' } })
      assert(a.status === 201 && b.status === 201, `建 Bot ${a.status} ${b.status}`)
      const A = a.json.bot.id
      const B = b.json.bot.id
      const bots = (body, token = memberTok) =>
        req(base, 'PUT', `/me/connectors/${connectorId}/connections/${firstConnId}/bots`, { token, body })
      const servedTo = async (botId) => {
        const cat = await req(base, 'GET', `/runtime/catalog${botId ? `?botId=${botId}` : ''}`, { token: seatTok })
        assert(cat.status === 200, `catalog ${cat.status} ${cat.text}`)
        const server = cat.json.servers.find((x) => x.id === firstConnId)
        const onBot = botId ? (cat.json.bots[0].mcps || []).includes(firstConnId) : null
        return { server, onBot }
      }

      // 默认：所有 Bot 都有，没按 Bot 拉的也有。
      const detail0 = await req(base, 'GET', `/me/connectors/${connectorId}`, { token: memberTok })
      const row0 = detail0.json.connections.find((c) => c.id === firstConnId)
      assert(row0.bots && row0.bots.mode === 'all', `默认该是所有 Bot：${JSON.stringify(row0.bots)}`)
      assert(detail0.json.bots.some((x) => x.id === A && x.name === '私人助理'), `详情该带候选 Bot：${JSON.stringify(detail0.json.bots)}`)
      assert((await servedTo(B)).onBot, '默认 B 就该用得上')

      // 校验：空名单、别人的 Bot、乱写的 mode、别人的连接。
      assert((await bots({ mode: 'bots', botIds: [] })).status === 400, '空名单该 400')
      assert((await bots({ mode: 'bots', botIds: ['bot-not-mine'] })).status === 400, '不是自己的 Bot 该 400')
      assert((await bots({ mode: 'some' })).status === 400, '认不出的 mode 该 400')
      assert((await bots({ mode: 'all' }, adminTok)).status === 404, '别人的连接该 404')

      const before = (await req(base, 'GET', `/runtime/catalog/version?botId=${B}`, { token: seatTok })).json.stamp
      const put = await bots({ mode: 'bots', botIds: [A, A] })
      assert(put.status === 200, `收窄 ${put.status} ${put.text}`)
      assert(
        put.json.connection.bots.mode === 'bots' && put.json.connection.bots.botIds.length === 1 && put.json.connection.bots.botIds[0] === A,
        `重复的要去掉：${JSON.stringify(put.json.connection.bots)}`,
      )
      const after = (await req(base, 'GET', `/runtime/catalog/version?botId=${B}`, { token: seatTok })).json.stamp
      assert(before !== after, '改了范围指纹没变，B 那边永远看不到这次改动')

      // 目录：A 有、B 没有（整条不下发），不按 Bot 拉的也没有。
      const forA = await servedTo(A)
      assert(forA.server && forA.onBot, `A 该拿到这把：${JSON.stringify(forA)}`)
      const forB = await servedTo(B)
      assert(!forB.server && !forB.onBot, 'B 不在名单上，目录里却还有这把')
      assert(!(await servedTo('')).server, '没按 Bot 拉目录的，收窄过的一律不给')

      // @ 选单：带 botId 就按它筛；不带（老页面）照旧全列，发消息那一跳再剔。
      const mB = await req(base, 'GET', `/mentions?botId=${B}`, { token: memberTok })
      assert(!mB.json.mentions.some((m) => m.id === firstConnId), 'B 的选单里不该有这把')
      const mA = await req(base, 'GET', `/mentions?botId=${A}`, { token: memberTok })
      assert(mA.json.mentions.some((m) => m.id === firstConnId), 'A 的选单里该有这把')

      // MCP 端点兜底：席位拿 B 的名义来打，列表是空的，调用是一句话，上游一次都不碰。
      const path = new URL(forA.server.endpoint).pathname
      const rpc = (botId, method, params, id = 1) =>
        req(base, 'POST', `${path}?botId=${botId}`, { token: seatTok, body: { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) } })
      const list = await rpc(B, 'tools/list')
      assert(list.json.result && list.json.result.tools.length === 0, `B 列工具该是空表：${list.text}`)
      const ran = mock.seen.executed.length
      const call = await rpc(B, 'tools/call', { name: 'SEND_EMAIL', arguments: {} }, 2)
      assert(call.json.result?.isError && call.json.result.content[0].text.includes('没有开放给这颗 Bot'), `B 调用该被拦：${call.text}`)
      assert(mock.seen.executed.length === ran, '被拦的调用打到了上游')
      // 元工具也一样：列表是空的，SW_SEARCH / SW_DESCRIBE 不能把工具和 schema 漏出来。
      for (const [n, name, args] of [[4, 'SW_SEARCH', { query: 'mail' }], [5, 'SW_DESCRIBE', { tool: 'SEND_EMAIL' }]]) {
        const meta = await rpc(B, 'tools/call', { name, arguments: args }, n)
        assert(meta.json.result?.isError && meta.json.result.content[0].text.includes('没有开放给这颗 Bot'), `B 调 ${name} 该被拦：${meta.text}`)
      }
      const noBot = await req(base, 'POST', path, { token: seatTok, body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'SEND_EMAIL', arguments: {} } } })
      assert(noBot.json.result?.isError, `没带 botId 的也该拦：${noBot.text}`)
      const files = await req(base, 'POST', `${path}/files?botId=${B}`, {
        token: seatTok,
        body: { tool: 'SEND_EMAIL', name: 'a.txt', mimetype: 'text/plain', md5: 'd41d8cd98f00b204e9800998ecf8427e', size: 1 },
      })
      assert(files.status === 403, `B 要附件上传位该 403，实际 ${files.status} ${files.text}`)
      const okList = await rpc(A, 'tools/list')
      assert(okList.json.result.tools.length > 0, `A 照常列得出工具：${okList.text}`)

      // 名单里的 Bot 删光了：谁都不给，**不是**回到全部。
      const del = await req(base, 'DELETE', `/runtime/bots/${A}`, { token: memberTok })
      assert(del.status === 200 || del.status === 202, `删 Bot ${del.status} ${del.text}`)
      const detail1 = await req(base, 'GET', `/me/connectors/${connectorId}`, { token: memberTok })
      const row1 = detail1.json.connections.find((c) => c.id === firstConnId)
      assert(row1.bots.mode === 'bots' && row1.bots.botIds.length === 0 && row1.bots.missing === 1, `删光之后该是空名单 + missing：${JSON.stringify(row1.bots)}`)
      assert(!(await servedTo(B)).server, '名单删光之后变回了所有 Bot')

      // 改回所有 Bot：B 又有了。后面的用例验的是默认行为，别让这条的副作用漏下去。
      const back = await bots({ mode: 'all' })
      assert(back.status === 200 && back.json.connection.bots.mode === 'all', `改回 ${back.status} ${back.text}`)
      assert((await servedTo(B)).onBot, '改回所有 Bot 之后 B 还是没有')
      await req(base, 'DELETE', `/runtime/bots/${B}`, { token: memberTok })
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

    await test('日常模型备选：跟着目录下发给席位，改了指纹要变', async () => {
      // 席位按这份名单认会话的挑选（docs/model-choice.md）。不进指纹的话，管理员下架一个
      // 备选，跑着的席位永远不重拉目录，选了它的会话会一直打那个已经不给用的模型。
      const models = await req(base, 'GET', '/v1/models', { token: owner })
      const ids = (models.json.data || []).map((m) => String(m.id)).filter((id) => id.indexOf('/') > 0)
      assert(ids.length >= 1, `目录里没有模型可挑：${models.text.slice(0, 200)}`)
      const [provider, ...rest] = ids[0].split('/')
      const one = { provider, model: rest.join('/'), reasoningEffort: 'off' }
      const before = (await req(base, 'GET', '/runtime/catalog/version', { token: seatTok })).json.stamp
      const put = await req(base, 'PUT', '/platform/settings', { token: owner, body: { dailyAlternates: [one] } })
      assert(put.status === 200, `存备选 ${put.status} ${put.text}`)
      const after = (await req(base, 'GET', '/runtime/catalog/version', { token: seatTok })).json.stamp
      assert(before !== after, `加了备选指纹没变，席位看不到这次改动：${before}`)
      const cat = await req(base, 'GET', '/runtime/catalog', { token: seatTok })
      const got = (cat.json.models && cat.json.models.dailyAlternates) || []
      assert(got.length === 1 && got[0].provider === one.provider && got[0].model === one.model, `席位没拿到备选：${JSON.stringify(cat.json.models)}`)
      // 公司侧（员工）读 /me 也看得到名单：对话框要画它。
      const me = await req(base, 'GET', '/me', { token: memberTok })
      assert((me.json.settings?.dailyAlternates || []).length === 1, `员工读不到备选：${JSON.stringify(me.json.settings)}`)

      await req(base, 'PUT', '/platform/settings', { token: owner, body: { dailyAlternates: [] } })
      const cleared = (await req(base, 'GET', '/runtime/catalog/version', { token: seatTok })).json.stamp
      assert(cleared === before, `清空之后指纹该回到原样（没有备选时和老格式一致）：${before} → ${cleared}`)
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

    await test('附件：文件参数的说明里写明先上传', async () => {
      const cat = await req(base, 'GET', '/runtime/catalog', { token: seatTok })
      const path = new URL(cat.json.servers.find((x) => x.connector === 'gmail').endpoint).pathname
      const list = await req(base, 'POST', path, { token: seatTok, body: { jsonrpc: '2.0', id: 40, method: 'tools/list' } })
      const send = list.json.result.tools.find((x) => x.name === 'SEND_EMAIL')
      const att = send?.inputSchema?.properties?.attachment
      assert(att, `SEND_EMAIL 的 attachment 不见了：${JSON.stringify(send)}`)
      // 形状原样（三个字符串还在、标记还在），只在说明里补一句。
      assert(att.file_uploadable === true && att.properties.s3key, `形状被改了：${JSON.stringify(att)}`)
      assert(att.description.startsWith('File to attach'), `原来的说明要留着：${att.description}`)
      assert(att.description.includes('connector_upload_file'), `没告诉模型先上传：${att.description}`)
      assert(att.description.includes('不要自己编 s3key'), `没把那条坑写进去：${att.description}`)
      // 没有文件参数的工具一个字节都不动。
      const fetch_ = list.json.result.tools.find((x) => x.name === 'FETCH_EMAILS')
      assert(JSON.stringify(fetch_.inputSchema) === JSON.stringify({ type: 'object', properties: {} }), `别的 schema 不该动：${JSON.stringify(fetch_.inputSchema)}`)
    })

    await test('多收件人：recipient_email 和 extra_recipients 的说明里写明怎么分', async () => {
      const cat = await req(base, 'GET', '/runtime/catalog', { token: seatTok })
      const path = new URL(cat.json.servers.find((x) => x.connector === 'gmail').endpoint).pathname
      const list = await req(base, 'POST', path, { token: seatTok, body: { jsonrpc: '2.0', id: 41, method: 'tools/list' } })
      const send = list.json.result.tools.find((x) => x.name === 'SEND_EMAIL')
      const to = send?.inputSchema?.properties?.recipient_email
      const extra = send?.inputSchema?.properties?.extra_recipients
      assert(to && extra, `字段不见了：${JSON.stringify(send?.inputSchema)}`)
      // 形状原样，原说明留着，提示补在后面。
      assert(to.type === 'string' && extra.type === 'array' && extra.items.type === 'string', `形状被改了：${JSON.stringify({ to, extra })}`)
      assert(to.description.startsWith('Primary recipient'), `原来的说明要留着：${to.description}`)
      assert(to.description.includes('extra_recipients') && to.description.includes('【多个收件人】'), `没告诉模型其余收件人放哪：${to.description}`)
      assert(extra.description.includes('【多个收件人】'), `extra_recipients 没补说明：${JSON.stringify(extra)}`)
      // 没有 extra_recipients 的工具一个字节都不动（上一条已验 FETCH_EMAILS）。
    })

    await test('附件：席位要上传位，Gateway 只转交供应商，字节由席位自己 PUT，不计费', async () => {
      const cat = await req(base, 'GET', '/runtime/catalog', { token: seatTok })
      const path = new URL(cat.json.servers.find((x) => x.connector === 'gmail').endpoint).pathname
      const bytes = Buffer.from('%PDF-1.4 酒店版手册 ' + 'x'.repeat(500))
      const md5 = createHash('md5').update(bytes).digest('hex')
      const callsBefore = (await req(base, 'GET', '/me/connector-stats', { token: memberTok })).json.total.calls
      const putsBefore = mock.seen.puts.length

      const up = await req(base, 'POST', `${path}/files`, {
        token: seatTok,
        body: { tool: 'SEND_EMAIL', name: '酒店版手册.pdf', mimetype: 'application/pdf', md5, size: bytes.length },
      })
      assert(up.status === 200, `要上传位 ${up.status} ${up.text}`)
      const file = up.json.file
      assert(file && file.name === '酒店版手册.pdf' && file.mimetype === 'application/pdf', `句柄不对：${up.text}`)
      assert(typeof file.s3key === 'string' && file.s3key.startsWith('req/gmail/'), `s3key 要是供应商给的那个 key：${up.text}`)
      // 票里带预签名地址和要照发的头；**Gateway 自己一个字节都没推**。
      assert(up.json.upload && typeof up.json.upload.url === 'string' && up.json.upload.url.includes('/s3/'), `要给预签名地址：${up.text}`)
      assert(up.json.upload.headers['content-type'] === 'application/pdf', `PUT 要带 MIME：${JSON.stringify(up.json.upload.headers)}`)
      assert(mock.seen.puts.length === putsBefore, 'Gateway 不该自己去 PUT 字节——那是席位的事，函数环境的请求体顶不住')

      // 向供应商要位子：toolkit / 真实 slug / 文件名 / MIME / md5 一样不少——md5 是上游去重用的。
      const staged = mock.seen.staged.at(-1)
      assert(staged.toolkit_slug === 'gmail' && staged.tool_slug === 'GMAIL_SEND_EMAIL', `要说清文件给谁用：${JSON.stringify(staged)}`)
      assert(staged.filename === '酒店版手册.pdf' && staged.mimetype === 'application/pdf', `文件名和 MIME：${JSON.stringify(staged)}`)
      assert(staged.md5 === md5, `md5 要原样转交：${staged.md5}`)

      // 席位照票 PUT：地址能用、key 对得上。
      const put = await fetch(up.json.upload.url, { method: 'PUT', headers: up.json.upload.headers, body: bytes })
      assert(put.status === 200, `照票 PUT 该成功，实际 ${put.status}`)
      const landed = mock.seen.puts.at(-1)
      assert(landed && landed.body.equals(bytes) && landed.key === file.s3key, `字节没到对象存储或 key 不一致：${landed?.key} vs ${file.s3key}`)
      assert(landed.apiKey === '', '平台 key 漏到对象存储那条路上去了')

      // 不是一次执行：没打 tools/execute，流水里也不多一行。
      const callsAfter = (await req(base, 'GET', '/me/connector-stats', { token: memberTok })).json.total.calls
      assert(callsAfter === callsBefore, `要上传位不该计次：${callsBefore} → ${callsAfter}`)
    })

    await test('附件：门和调工具一样——关掉的工具拿不到位子，登录票不认，太大 413，参数不全 400', async () => {
      const cat = await req(base, 'GET', '/runtime/catalog', { token: seatTok })
      const path = new URL(cat.json.servers.find((x) => x.connector === 'gmail').endpoint).pathname
      const ok = { tool: 'SEND_EMAIL', name: 'a.txt', mimetype: 'text/plain', md5: 'a'.repeat(32), size: 5 }
      const stagedBefore = mock.seen.staged.length

      const asUser = await req(base, 'POST', `${path}/files`, { token: memberTok, body: ok })
      assert(asUser.status === 401, `登录票不该能要上传位，实际 ${asUser.status}`)

      for (const [label, bad] of [
        ['没文件名', { ...ok, name: '' }],
        ['没说给谁用', { ...ok, tool: '' }],
        ['md5 不对', { ...ok, md5: 'xyz' }],
        ['没大小', { ...ok, size: 0 }],
      ]) {
        const r = await req(base, 'POST', `${path}/files`, { token: seatTok, body: bad })
        assert(r.status === 400, `${label}该 400，实际 ${r.status} ${r.text}`)
      }

      // 文件名只留最后一段：工作区的目录结构不该带出去。
      const nested = await req(base, 'POST', `${path}/files`, { token: seatTok, body: { ...ok, name: 'docs/2024/报价.pdf' } })
      assert(nested.status === 200 && nested.json.file.name === '报价.pdf', `该只留文件名：${nested.text}`)

      // 超限在要位子**之前**就拒：供应商那边不该为一份发不出去的文件开位子。
      const big = await req(base, 'POST', `${path}/files`, { token: seatTok, body: { ...ok, size: 8192 } })
      assert(big.status === 413, `超限该 413，实际 ${big.status} ${big.text}`)

      await req(base, 'PUT', `/me/connectors/${connectorId}/tools`, { token: memberTok, body: { enabledTools: ['GMAIL_FETCH_EMAILS'] } })
      const off = await req(base, 'POST', `${path}/files`, { token: seatTok, body: ok })
      assert(off.status === 403, `关掉的工具不该拿到位子，实际 ${off.status} ${off.text}`)
      await req(base, 'PUT', `/me/connectors/${connectorId}/tools`, { token: memberTok, body: { enabledTools: [] } })

      // 被拒的那几次一次都没到供应商那边。
      assert(mock.seen.staged.length === stagedBefore + 1, `被拒的也打到上游了：${mock.seen.staged.length - stagedBefore - 1} 次`)
    })

    await test('附件：席位那把 connector_upload_file 先要位子、再自己 PUT 字节', async () => {
      const r = await runProbe(root, 'bot/e2e-connector-upload.mjs')
      assert(r.mime.pdf === 'application/pdf' && r.mime.unknown === 'application/octet-stream', `MIME：${JSON.stringify(r.mime)}`)
      assert(r.url.path === '/mcp/connectors/c1/files' && r.url.botId === 'b1', `地址：${JSON.stringify(r.url)}`)

      const bad = Object.entries(r.upload).filter(([, v]) => v === false).map(([k]) => k)
      assert(!bad.length, `上传这几条不对：${bad.join('、')}\n${JSON.stringify(r.upload)}`)
      assert(r.upload.票 === 'Bearer sat_seat_1', `票：${r.upload.票}`)
      assert(r.upload.远端工具 === 'SEND_EMAIL' && r.upload.文件名 === '酒店版手册.pdf' && r.upload.归因 === 'bot-9', `要位子的 body：${JSON.stringify(r.upload)}`)
      assert(r.upload.MIME === 'application/pdf' && r.upload.md5对 && r.upload.大小对, `md5 / 大小 / MIME：${JSON.stringify(r.upload)}`)
      assert(r.upload.PUT地址 === '/s3/req-1' && r.upload.PUT头 === 'application/pdf', `PUT：${JSON.stringify(r.upload)}`)

      assert(r.dedup.不再PUT && r.dedup.不算失败 && r.dedup.话里带句柄, `去重命中：${JSON.stringify(r.dedup)}`)

      assert(r.meta.没说target不打网络 && r.meta.没说target的话.includes('target'), `元工具要问 target：${JSON.stringify(r.meta)}`)
      assert(r.meta.说了target按它传 === 'GMAIL_CREATE_EMAIL_DRAFT' && r.meta.不算失败, `元工具按 target 传：${JSON.stringify(r.meta)}`)

      assert(r.refused.这些都不该打网络 && r.refused.都不置failed, `拒绝：${JSON.stringify(r.refused)}`)
      assert(r.refused.不是连接器.includes('不是连接器的工具'), r.refused.不是连接器)
      assert(r.refused.不是MCP.includes('不是连接器的工具'), r.refused.不是MCP)
      assert(r.refused.太大.includes('超过附件上限'), r.refused.太大)
      assert(r.refused.空文件.includes('空文件'), r.refused.空文件)
      assert(r.refused.越界.includes('越界'), r.refused.越界)
      assert(r.refused.不存在.includes('不存在'), r.refused.不存在)

      assert(r.gateway.四xx原话.includes('没有开启') && r.gateway.四xx不置failed, `4xx 原话：${JSON.stringify(r.gateway)}`)
      assert(r.gateway.五xx是管道故障, `5xx：${JSON.stringify(r.gateway)}`)
      assert(r.gateway.存储拒收是业务失败 && r.gateway.存储拒收的话.includes('拒收'), `存储拒收：${JSON.stringify(r.gateway)}`)
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

    await test('界面：员工的插件页是市场卡片，禁用的写明原因', async () => {
      const { loadApp } = await import('./ui-dom.mjs')
      // 用**员工**的票：管理员那一屏是禁令和账，不是市场（两屏分开是有意的）。
      const ui = loadApp({ appPath: join(root, 'gateway/ui/app.js'), base, token: memberTok })
      await ui.boot()
      ui.state.path = '/plugins'
      ui.state.market = [
        { id: 'c1', toolkit: 'gmail', name: 'Gmail', description: '收发邮件', category: 'productivity', blocked: false },
        { id: 'c2', toolkit: 'notion', name: 'Notion', description: '知识库', category: 'productivity', blocked: true, blockedReason: '合规未过' },
      ]
      ui.render()
      const html = ui.html()
      assert(html.includes('Gmail') && html.includes('Notion'), '市场卡片没画出来')
      assert(html.includes('合规未过'), '被禁的没写出原因')
      assert(!html.includes('conn-publish-open'), '员工不该看到「上架」')
      assert(ui.pathAllowed('/plugins'), '员工应该进得了 /plugins')
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
      ui.state.path = '/plugins'
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

    await test('界面：插件是内置页——「更多」里跳 /plugins，点「添加」装上后落到详情', async () => {
      const { loadApp, el } = await import('./ui-dom.mjs')
      const ui = loadApp({ appPath: join(root, 'gateway/ui/app.js'), base, token: memberTok })
      await ui.boot()
      // go() 换页之后的取数是在后台跑的（enterPath 不返回那个 promise），点完要等它画完再看。
      const settle = async () => {
        await ui.loadPage()
        ui.render()
      }
      assert(ui.html().includes('data-href="/plugins"'), '侧栏没有「插件」入口')
      assert(!ui.html().includes('plugins-open'), '还留着开弹窗的老动作')
      assert(!/data-href="\/connectors"/.test(ui.html()), '菜单里还留着「连接器」那一行，和插件入口重了')

      await ui.fire('click', el('button', { 'data-act': 'go', 'data-href': '/plugins' }))
      await settle()
      assert(ui.state.path === '/plugins', `没跳到插件页，现在在 ${ui.state.path}`)
      let html = ui.html()
      assert(!html.includes('gw-modal'), '插件页不该再是弹窗')
      assert(html.includes('Gmail'), '插件页里没有市场清单')
      assert(html.includes(`data-act="conn-install" data-id="${connectorId}"`), '没装的应该给「添加」')

      await ui.fire('click', el('button', { 'data-act': 'conn-install', 'data-id': connectorId }))
      await settle()
      html = ui.html()
      assert(ui.state.path === `/plugins/${connectorId}`, `装完该落到详情页，现在在 ${ui.state.path}`)
      assert(ui.location.pathname === `/plugins/${connectorId}`, `地址栏没跟上：${ui.location.pathname}`)
      assert(html.includes('data-act="conn-add-open"'), '详情里没有「添加账号」——装完就该能连')
      assert(html.includes('GMAIL_SEND_EMAIL'), '详情里没有工具开关')
      assert(html.includes('还没连上账号'), '没连账号时该明说 Bot 用不了')

      // 退回清单：刚装的那个在「已安装」里，标着还没连账号，按钮直接写「去连接」。
      await ui.fire('click', el('button', { 'data-act': 'go', 'data-href': '/plugins' }))
      await settle()
      html = ui.html()
      assert(html.includes('待连接账号') && html.includes('连接账号'), '装了没连的那一个没标出来')
      assert(!html.includes(`data-act="conn-install" data-id="${connectorId}"`), '装过的还在给「添加」')

      // 装回去的这一笔要还原：下面还有测试在数装机量。
      const del = await req(base, 'DELETE', `/me/connectors/${connectorId}/install`, { token: memberTok })
      assert(del.status === 200, `复原卸载 ${del.status}`)
    })

    await test('界面：加账号开新标签页去授权，不把当前这一页顶掉', async () => {
      const { loadApp, el } = await import('./ui-dom.mjs')
      const ui = loadApp({ appPath: join(root, 'gateway/ui/app.js'), base, token: memberTok })
      await ui.boot()
      await ui.fire('click', el('button', { 'data-act': 'go', 'data-href': '/plugins' }))
      await ui.loadPage()
      await ui.fire('click', el('button', { 'data-act': 'conn-install', 'data-id': connectorId }))
      await ui.loadPage()
      ui.render()
      const before = ui.location.href

      // 「添加账号」先开弹窗，账号名在弹窗里填；去授权是那张表单的 submit。
      await ui.fire('click', el('button', { 'data-act': 'conn-add-open', 'data-id': connectorId }))
      assert(ui.html().includes('id="conn-add-form"'), '「添加账号」没开出弹窗')
      assert(ui.windowOpens.length === 0, '还没点「去授权」就开了新页')
      const form = el('form', { 'data-id': connectorId })
      form.id = 'conn-add-form'
      await ui.fire('submit', form)
      // 授权是在后台那一趟里发起的（submit 不等它），等它落定。
      for (let i = 0; i < 50 && ui.state.connAdd?.phase !== 'waiting'; i++) await new Promise((r) => setTimeout(r, 20))
      assert(ui.windowOpens.length === 1, `该开一个新标签页，实际开了 ${ui.windowOpens.length} 个`)
      const tab = ui.windowOpens[0]
      assert(tab.location.href.startsWith('https://accounts.example.com/'), `新页没送到授权地址：${tab.location.href}`)
      assert(!tab.closed, '新页被关掉了')
      // 反向标签劫持：授权页拿着 opener 就能把我们这一页换成钓鱼页。
      assert(tab.opener === null, 'opener 没断')
      // 这一边必须原封不动——顶掉的话，勾到一半的工具和填好的账号名都没了。
      assert(ui.location.href === before, `当前这一页被顶掉了：${ui.location.href}`)
      assert(ui.state.path === `/plugins/${connectorId}`, `人被带离了详情页：${ui.state.path}`)
      assert(ui.state.connAdd?.phase === 'waiting', `开出新页之后弹窗该停在「等你授权」：${JSON.stringify(ui.state.connAdd)}`)
      assert(ui.html().includes('conn-add-done'), '等授权那一屏没有「我已完成授权」')

      // 复原：断掉刚发起的那把，再卸载。下面还有测试在数装机量和连接数。
      const detail = await req(base, 'GET', `/me/connectors/${connectorId}`, { token: memberTok })
      for (const c of detail.json.connections || []) {
        await req(base, 'DELETE', `/me/connectors/${connectorId}/connections/${c.id}`, { token: memberTok })
      }
      const del = await req(base, 'DELETE', `/me/connectors/${connectorId}/install`, { token: memberTok })
      assert(del.status === 200, `复原卸载 ${del.status}`)
    })

    await test('界面：老地址折到插件页——员工的 /connectors 和 /connectors/:id，管理员的不动', async () => {
      // /connectors/:id 是以前发出去的深链，也是 OAuth 授权完那一页上的兜底链接（老版本）。
      const { loadApp } = await import('./ui-dom.mjs')
      const member = loadApp({ appPath: join(root, 'gateway/ui/app.js'), base, token: memberTok })
      await member.boot()
      member.state.path = `/connectors/${connectorId}`
      await member.loadPage()
      assert(member.state.path === `/plugins/${connectorId}`, `详情的老地址没折过去：${member.state.path}`)
      assert(member.location.pathname === `/plugins/${connectorId}`, `地址栏没跟上：${member.location.pathname}`)
      assert(member.state.connectorDetail?.connector?.id === connectorId, '折过去之后详情没取')
      member.state.path = '/connectors'
      await member.loadPage()
      assert(member.state.path === '/plugins', `员工的 /connectors 没折到 /plugins：${member.state.path}`)

      // 管理员的 /connectors 是禁令和账那一屏，不是他自己的插件。
      const admin = loadApp({ appPath: join(root, 'gateway/ui/app.js'), base, token: adminTok })
      await admin.boot()
      admin.state.path = '/connectors'
      await admin.loadPage()
      assert(admin.state.path === '/connectors', `管理员的 /connectors 被折走了：${admin.state.path}`)
      assert(admin.pathAllowed('/plugins'), '管理员也有席位，插件页该进得去')
    })

    await test('界面：员工的详情页画得出账号行、工具开关、「仅 @ 时可用」与「可用 Bot」', async () => {
      const { loadApp } = await import('./ui-dom.mjs')
      const ui = loadApp({ appPath: join(root, 'gateway/ui/app.js'), base, token: memberTok })
      await ui.boot()
      ui.state.path = `/plugins/${connectorId}`
      ui.state.connectorDetail = {
        connector: { id: connectorId, name: 'Gmail', description: '收发邮件', toolkit: 'gmail', blocked: false },
        install: { id: 'i1', enabledTools: ['GMAIL_SEND_EMAIL'] },
        connections: [
          { id: 'x1', label: 'default', scope: 'user', status: 'active', mentionOnly: false, bots: { mode: 'all', botIds: [], missing: 0 } },
          { id: 'x2', label: 'personal', scope: 'user', status: 'active', mentionOnly: true, bots: { mode: 'bots', botIds: ['bA'], missing: 0 } },
          { id: 'x3', label: 'company', scope: 'company', status: 'active', mentionOnly: false, bots: { mode: 'bots', botIds: [], missing: 1 } },
        ],
        bots: [
          { id: 'bA', name: '私人助理', icon: '', origin: 'company' },
          { id: 'bB', name: '客服', icon: '', origin: 'company' },
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
      // 「可用 Bot」：三把各画一格，公司共用那把也有；名单删光了要红字说出来。
      assert(html.includes('可用 Bot：所有 Bot'), '默认那把该写「所有 Bot」')
      assert(html.includes('可用 Bot：私人助理'), '只给一颗的该写出它的名字')
      assert(html.includes('可用 Bot：没有 Bot 可用'), '名单删光了该写「没有 Bot 可用」')
      assert(html.includes('data-act="conn-bots-open" data-id="x3"'), '公司共用那把也该能设可用 Bot')
      ui.state.connBotsOpen = 'x2'
      ui.render()
      const open = ui.html()
      assert(open.includes('data-conn-bots="x2"') && open.includes('指定 Bot') && open.includes('客服'), '弹窗里该画两档单选和 Bot 名单')
      assert(/data-bot="bA" checked/.test(open) && !/data-bot="bB" checked/.test(open), '名单里的该勾上、别的不勾')
      assert(open.includes('data-conn-bots-root') && open.includes('role="dialog" aria-modal="true"'), '可用 Bot 应在独立设置弹窗里')
      assert(open.includes('aria-haspopup="dialog"'), '账号行应声明会打开弹窗')
      assert(open.includes('aria-label="搜索 Bot"') && open.includes('已选 1 个'), '名单应可搜索，并显示已选数量')
      assert(open.indexOf('data-conn-bots-root') > open.indexOf('GMAIL_FETCH_EMAILS'), '弹窗不应嵌在账号行中挤压工具设置')
      ui.state.connBotsOpen = 'x3'
      ui.render()
      const missing = ui.html()
      assert(missing.includes('请至少选择一个 Bot 后保存。') && missing.includes('此前选择的 Bot 已被删除'), '空名单和已删除的 Bot 都应解释清楚')
      assert(/data-act="conn-bots-save"[^>]+disabled/.test(missing), '指定 Bot 为空时不能保存')
      ui.state.connBotsOpen = 'x2'
      ui.state.connBotsDraft = { id: 'x2', connectorId, mode: 'bots', botIds: ['bB'], query: '客服', error: '保存失败，请重试', busy: false }
      ui.render()
      const draft = ui.html()
      assert(/data-bot="bB" checked/.test(draft) && !/data-bot="bA" checked/.test(draft), '重绘弹窗应保留未保存的选择')
      assert(draft.includes('value="客服"') && draft.includes('保存失败，请重试'), '重绘弹窗应保留搜索和失败提示')
      ui.state.connBotsDraft = null
      ui.state.connBotsOpen = null
      assert(ui.pathAllowed(`/plugins/${connectorId}`), '详情页应该进得去')
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

      // 点名以正文为准：正文里留着 `@名字` 的留下，删掉的就是不点了——上面那排不再摆「发不出去的」药丸。
      const gmail = { kind: 'connector', id: 'c1', label: 'Gmail (personal)' }
      const slack = { kind: 'connector', id: 'c2', label: 'Slack' }
      ui.state.chatDraft = '用 @Gmail (personal) 查一下'
      ui.state.chatMentions = [gmail, slack]
      ui.paintChatMentions()
      assert(ui.stubs.get('chat-mentions').hidden === true, '上面那排该收着')
      assert(JSON.stringify(ui.state.chatMentions.map((m) => m.id)) === '["c1"]', `正文里没有的该拿掉，留着的不能动：${JSON.stringify(ui.state.chatMentions)}`)
      // 删掉的能再选回来：选单不再把它当「已选」滤掉。
      ui.state.mentionOptions = [gmail, slack]
      ui.state.mentionPick = { open: true, q: '', index: 0 }
      ui.paintMentionPick()
      const pick = ui.stubs.get('chat-mentionpick').innerHTML
      assert(pick.includes('Slack') && !pick.includes('Gmail (personal)'), `选单该能再选 Slack、不再给已点的 Gmail：${pick}`)
      ui.state.chatDraft = '不点了'
      ui.paintMentionPick()
      assert(ui.stubs.get('chat-mentionpick').innerHTML.includes('Gmail (personal)'), '正文里删掉 @Gmail 之后选单里该能再选它')
      ui.state.mentionPick = null

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
      ui.state.path = `/plugins/${connectorId}`
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
