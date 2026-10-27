/**
 * 工具搜索：装不下就降级成三个元工具（docs/tool-search.md）。
 *
 * 三个 toolkit 各站一档，**用的是线上的默认参数**（cap 64、清单 4000 token），不靠调小
 * 阈值把测试凑出来——阈值调小了，验的就是 mock 而不是分档本身。
 *
 *   gmail  ：3 个工具            → 第 0 档 direct，今天的行为一个字不能变
 *   jira   ：70 个短描述工具     → 第 1 档 listing，清单塞得进 SW_SEARCH 的说明
 *   github ：200 个长描述工具    → 第 2 档 search，清单也塞不下
 */
import { createServer } from 'node:http'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { schemaOf, tmpOf } from './isolate.mjs'
import { freePort } from './ports.mjs'
import { closeServer } from './probe.mjs'
import { startGateway } from './gateway.mjs'

const TOOLKITS = {
  items: [
    { slug: 'gmail', name: 'Gmail', meta: { description: '收发邮件', categories: [{ name: 'productivity' }] }, auth_schemes: [{ mode: 'OAUTH2' }] },
    { slug: 'jira', name: 'Jira', meta: { description: '工单', categories: [{ name: 'productivity' }] }, auth_schemes: [{ mode: 'OAUTH2' }] },
    { slug: 'github', name: 'GitHub', meta: { description: '代码托管', categories: [{ name: 'dev' }] }, auth_schemes: [{ mode: 'OAUTH2' }] },
    { slug: 'slack', name: 'Slack', meta: { description: '聊天', categories: [{ name: 'chat' }] }, auth_schemes: [{ mode: 'OAUTH2' }] },
  ],
}

const schema = (props) => ({ type: 'object', properties: props })

const TOOLS = {
  // slack 只给「目录拉不到」那条用：它的清单从头到尾没被成功拉过，所以不进五分钟缓存。
  slack: [{ slug: 'SLACK_POST_MESSAGE', name: 'Post message', description: '发消息', input_parameters: schema({ text: { type: 'string' } }) }],
  gmail: [
    { slug: 'GMAIL_SEND_EMAIL', name: 'Send email', description: '发一封邮件', input_parameters: schema({ to: { type: 'string' } }) },
    { slug: 'GMAIL_FETCH_EMAILS', name: 'Fetch emails', description: '拉最近的邮件', input_parameters: schema({}) },
    { slug: 'GMAIL_CREATE_DRAFT', name: 'Create draft', description: '存草稿', input_parameters: schema({}) },
  ],
  // 70 个、描述很短：超了 cap，但整份清单还塞得下 4000 token。
  jira: Array.from({ length: 70 }, (_, i) => ({
    slug: `JIRA_OP_${String(i).padStart(2, '0')}`,
    name: `Op ${i}`,
    description: `第 ${i} 号操作`,
    input_parameters: schema({ id: { type: 'string' } }),
  })),
  // 200 个、描述很长：清单本身就两万多字，只能退到摘要那一档。
  github: Array.from({ length: 200 }, (_, i) => ({
    slug: `GITHUB_OP_${String(i).padStart(3, '0')}`,
    name: `Op ${i}`,
    description: `GitHub 的第 ${i} 号操作，${'这一句是为了把描述撑长，让整份清单塞不进 4000 token 的预算里。'.repeat(2)}`,
    input_parameters: schema({ repo: { type: 'string' } }),
  })),
}
// 真正要靠关键词搜出来的那一个。名字和别人不一样，搜「pull request」只该中它。
TOOLS.github[42] = {
  slug: 'GITHUB_CREATE_PULL_REQUEST',
  name: 'Create pull request',
  description: '开一个 pull request',
  input_parameters: schema({ title: { type: 'string' } }),
}

function mockComposio() {
  // `toolsDown` 打开之后 /tools 回 500：验「目录拉不到」和「清单里没有」是两回事。
  const seen = { executed: [], toolsDown: false, failedArgs: null }
  const accounts = new Map()
  let n = 0
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/toolkits') return send(200, TOOLKITS)
    if (url.pathname === '/tools') {
      if (seen.toolsDown) return send(500, { error: { message: '上游炸了' } })
      const kit = (url.searchParams.get('toolkit_slug') || '').toLowerCase()
      return send(200, { items: TOOLS[kit] || [] })
    }
    // 授权走 /connected_accounts/link，且一上来就是 ACTIVE——这一套验的是工具表，
    // 不是授权流程，那条路在 connectors.mjs 里已经守着了。
    if (url.pathname === '/connected_accounts/link' && req.method === 'POST') {
      let raw = ''
      req.on('data', (d) => (raw += d))
      req.on('end', () => {
        const id = `ca_${++n}`
        accounts.set(id, 'ACTIVE')
        send(200, { connected_account_id: id, redirect_url: `https://accounts.example.com/o?ca=${id}` })
      })
      return
    }
    const m = /^\/connected_accounts\/(.+)$/.exec(url.pathname)
    if (m && req.method === 'GET') {
      const st = accounts.get(m[1])
      return st ? send(200, { id: m[1], status: st }) : send(404, { error: { message: 'no such account' } })
    }
    if (m && req.method === 'DELETE') {
      accounts.delete(m[1])
      return send(200, { deleted: true })
    }
    const ex = /^\/tools\/execute\/(.+)$/.exec(url.pathname)
    if (ex && req.method === 'POST') {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        const body = JSON.parse(raw || '{}')
        const tool = decodeURIComponent(ex[1])
        seen.executed.push({ tool, account: body.connected_account_id, args: body.arguments })
        // 少了必填参数，上游是 **2xx + successful:false**——跑过了、要收钱的那一档。
        if (tool === 'GITHUB_CREATE_PULL_REQUEST' && !body.arguments?.title) {
          return send(200, { successful: false, error: '缺少必填参数 title' })
        }
        send(200, { successful: true, data: { ok: true } })
      })
      return
    }
    send(404, { error: { message: url.pathname } })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` }),
    )
  })
}

export async function runToolSearch({ root, gwRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = tmpOf('satuwork-e2e-tool-search')
  // 端口向内核要（见 ports.mjs）：写死的数迟早撞上别的套件或别的 worktree。
  const GW_PORT = await freePort()
  const base = `http://127.0.0.1:${GW_PORT}`

  log('\n# tool-search')

  const mock = await mockComposio()
  const { gw } = await startGateway({
    name: 'tool-search-gw',
    what: 'tool-search gateway',
    home: GW_HOME,
    schema: schemaOf('e2e_tool_search'),
    port: GW_PORT,
    env: {
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '0',
      COMPOSIO_BASE_URL: mock.url,
      // 不缓存清单：缓存一热，「供应商挂了」那几条验的就是缓存而不是行为。
      CONNECTOR_TOOL_TTL_MS: '1',
    },
  })

  let owner = ''
  let adminTok = ''
  let memberTok = ''
  let memberId = ''
  let orgId = ''
  let seatTok = ''
  const connectorOf = {}
  const pathOf = {}

  /** 打某一把连接的 MCP 端点。 */
  const rpc = (kit, method, params, id = 1) =>
    req(base, 'POST', pathOf[kit], {
      token: seatTok,
      body: { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) },
    })

  const callsOf = async () => (await req(base, 'GET', '/me/connector-stats', { token: memberTok })).json.total.calls

  try {
    await test('三个 toolkit 上架、员工装上、各连一把', async () => {
      const setup = await req(base, 'POST', '/auth/setup', {
        body: { email: 'o@ts.test', name: 'o', password: 'correct-horse-1' },
      })
      assert(setup.status === 201 || setup.status === 200, `setup ${setup.status} ${setup.text}`)
      owner = setup.json.token
      await req(base, 'PUT', '/platform/connector-vendors/composio', { token: owner, body: { secret: 'ck_ts' } })

      for (const kit of ['gmail', 'jira', 'github']) {
        const made = await req(base, 'POST', '/platform/connectors', {
          token: owner,
          body: { vendor: 'composio', toolkit: kit, name: kit, authConfigId: `ac_${kit}`, perm: '可写' },
        })
        assert(made.status === 201, `publish ${kit} ${made.status} ${made.text}`)
        connectorOf[kit] = made.json.connector.id
      }

      const org = await req(base, 'POST', '/platform/orgs', {
        token: owner,
        body: {
          name: 'Acme', slug: 'acme-ts',
          contactName: '张三', contactPhone: '+86 138 0000 0000', contactEmail: 'z@acme.test',
          adminEmail: 'a@ts.test', adminPassword: 'correct-horse-1',
        },
      })
      assert(org.status === 201, `org ${org.status} ${org.text}`)
      orgId = org.json.company.id
      adminTok = (await req(base, 'POST', '/auth/login', { body: { email: 'a@ts.test', password: 'correct-horse-1' } })).json.token
      await req(base, 'PUT', `/platform/orgs/${orgId}/plan`, { token: owner, body: { seats: 3 } })

      const made = await req(base, 'POST', `/orgs/${orgId}/accounts`, {
        token: adminTok,
        body: { email: 'm@ts.test', name: '小王', password: 'correct-horse-1', role: 'member' },
      })
      assert(made.status === 201, `member ${made.status} ${made.text}`)
      memberId = made.json.account.id
      memberTok = (await req(base, 'POST', '/auth/login', { body: { email: 'm@ts.test', password: 'correct-horse-1' } })).json.token

      for (const kit of ['gmail', 'jira', 'github']) {
        await req(base, 'POST', `/me/connectors/${connectorOf[kit]}/install`, { token: memberTok })
        const conn = await req(base, 'POST', `/me/connectors/${connectorOf[kit]}/connections`, {
          token: memberTok,
          body: { label: 'default' },
        })
        assert(conn.status === 201, `connect ${kit} ${conn.status} ${conn.text}`)
        // 详情页那条路会 refreshPending，把刚建的连接从 pending 翻成 active。
        const detail = await req(base, 'GET', `/me/connectors/${connectorOf[kit]}`, { token: memberTok })
        assert(detail.status === 200, `detail ${kit} ${detail.status} ${detail.text}`)
      }

      seatTok = (await req(base, 'GET', `/platform/accounts/${memberId}`, { token: owner })).json.accessToken
      const cat = await req(base, 'GET', '/runtime/catalog', { token: seatTok })
      for (const kit of ['gmail', 'jira', 'github']) {
        const server = cat.json.servers.find((x) => x.connector === kit)
        assert(server, `${kit} 没出现在席位目录里：${cat.text}`)
        pathOf[kit] = new URL(server.endpoint).pathname
      }
    })

    await test('第 0 档：工具不多的照旧全量下发，一个元工具都不该冒出来', async () => {
      const list = await rpc('gmail', 'tools/list')
      const names = list.json.result.tools.map((x) => x.name)
      assert(names.length === 3, `gmail 该全量下发，实际 ${names.length} 个`)
      assert(names.includes('SEND_EMAIL'), `还是要去 toolkit 前缀：${JSON.stringify(names)}`)
      assert(!names.some((n) => n.startsWith('SW_')), `不该降级：${JSON.stringify(names)}`)
    })

    await test('第 2 档：200 个工具只出三个元工具，且不带 truncated', async () => {
      const list = await rpc('github', 'tools/list')
      const tools = list.json.result.tools
      const names = tools.map((x) => x.name)
      assert(names.length === 3, `该降到三个元工具，实际 ${names.length}：${JSON.stringify(names)}`)
      assert(
        names.includes('SW_SEARCH') && names.includes('SW_DESCRIBE') && names.includes('SW_RUN'),
        `元工具名不对：${JSON.stringify(names)}`,
      )
      // **降级不是截断**：一个工具都没丢，所以不该有 truncated。带上它会让人以为丢了东西。
      assert(list.json.result.truncated === undefined, `降级不该报截断：${list.text}`)
      const search = tools.find((x) => x.name === 'SW_SEARCH')
      assert(search.description.includes('200'), `说明里要写清一共多少个：${search.description}`)
      // 第 2 档连清单都塞不下，说明里就不该出现整份清单。
      assert(!search.description.includes('GITHUB_OP_100'), '第 2 档不该嵌清单')
    })

    await test('第 1 档：清单塞得下就嵌进 SW_SEARCH 的说明里', async () => {
      const list = await rpc('jira', 'tools/list')
      const tools = list.json.result.tools
      assert(tools.length === 3, `该降到三个元工具，实际 ${tools.length}`)
      const search = tools.find((x) => x.name === 'SW_SEARCH')
      // 有清单，模型是在「认」工具；没清单，它是在「猜」查询词。这一档不能省。
      assert(search.description.includes('JIRA_OP_00'), `清单没嵌进来：${search.description.slice(0, 300)}`)
      assert(search.description.includes('JIRA_OP_69'), '清单要是完整的，不是前几条')
    })

    await test('SW_SEARCH 搜得到，且搜索本身不进流水、不计费', async () => {
      const before = await callsOf()
      const hit = await rpc('github', 'tools/call', { name: 'SW_SEARCH', arguments: { query: 'pull request' } }, 2)
      const text = hit.json.result.content[0].text
      assert(!hit.json.result.isError, `搜索不该报错：${hit.text}`)
      assert(text.includes('GITHUB_CREATE_PULL_REQUEST'), `没搜到该搜到的：${text.slice(0, 300)}`)
      // 搜和描述不产生上游执行，跟 tools/list 同一档；落进流水表还会把
      // 「按工具统计次数」搅浑——SW_SEARCH 会变成调用量最大的那个「工具」。
      assert((await callsOf()) === before, 'SW_SEARCH 不该落进 connector_calls')
      assert(mock.seen.executed.length === 0, 'SW_SEARCH 不该打上游')
    })

    await test('搜不到时说人话，不回空结果', async () => {
      const miss = await rpc('github', 'tools/call', { name: 'SW_SEARCH', arguments: { query: '发工资' } }, 3)
      const text = miss.json.result.content[0].text
      // 空结果在模型眼里等于「这个工具不存在」，它会转头告诉用户做不到——
      // 这就是静默截断换了个马甲。三样东西必须都在：一共多少个、刚才搜的是什么、下一步怎么办。
      assert(text.includes('200'), `没说一共多少个：${text}`)
      assert(text.includes('发工资'), `没把原查询回给模型：${text}`)
      assert(text.includes('英文'), `没给下一步的建议：${text}`)
    })

    await test('SW_DESCRIBE 给出完整 schema', async () => {
      const d = await rpc('github', 'tools/call', { name: 'SW_DESCRIBE', arguments: { tool: 'GITHUB_CREATE_PULL_REQUEST' } }, 4)
      const text = d.json.result.content[0].text
      assert(!d.json.result.isError, `describe 不该报错：${d.text}`)
      assert(text.includes('title'), `参数没出来：${text.slice(0, 300)}`)
      const ghost = await rpc('github', 'tools/call', { name: 'SW_DESCRIBE', arguments: { tool: 'GITHUB_NOPE' } }, 5)
      assert(ghost.json.result.isError, '不存在的工具该报错')
      assert(ghost.json.result.content[0].text.includes('SW_SEARCH'), '要指路去搜，不是干说一句没有')
    })

    await test('SW_RUN 打到上游，流水里落的是真实 slug', async () => {
      const before = await callsOf()
      const run = await rpc(
        'github',
        'tools/call',
        { name: 'SW_RUN', arguments: { tool: 'GITHUB_CREATE_PULL_REQUEST', args: { title: '改一行' } } },
        6,
      )
      assert(!run.json.result.isError, `SW_RUN 该跑通：${run.text}`)
      const ran = mock.seen.executed.at(-1)
      assert(ran.tool === 'GITHUB_CREATE_PULL_REQUEST', `上游收到的工具名不对：${ran.tool}`)
      // args 要从 SW_RUN 的第二个参数里拆出来，不能把 { tool, args } 整个塞给上游。
      assert(ran.args?.title === '改一行', `参数没拆开：${JSON.stringify(ran.args)}`)
      assert((await callsOf()) === before + 1, 'SW_RUN 就是一次 tools/call，该落一行账')

      const stats = await req(base, 'GET', '/me/connector-stats', { token: memberTok })
      const byTool = stats.json.byTool.map((x) => x.tool)
      assert(byTool.includes('GITHUB_CREATE_PULL_REQUEST'), `统计里该是真实 slug：${JSON.stringify(byTool)}`)
      assert(!byTool.some((x) => String(x).startsWith('SW_')), `元工具混进了统计：${JSON.stringify(byTool)}`)
    })

    await test('关掉的工具，SW_RUN 也调不动——元工具不是绕过开关的后门', async () => {
      await req(base, 'PUT', `/me/connectors/${connectorOf.github}/tools`, {
        token: memberTok,
        body: { enabledTools: ['GITHUB_OP_001'] },
      })
      const before = mock.seen.executed.length
      const run = await rpc(
        'github',
        'tools/call',
        { name: 'SW_RUN', arguments: { tool: 'GITHUB_CREATE_PULL_REQUEST', args: {} } },
        7,
      )
      assert(run.json.result.isError, '关掉的工具该被拒')
      assert(mock.seen.executed.length === before, '被拒的不该打到上游')

      // 搜和描述也只在开着的那些里面走：给模型一份它永远调不动的 schema，它会反复重试。
      const hit = await rpc('github', 'tools/call', { name: 'SW_SEARCH', arguments: { query: 'pull request' } }, 8)
      assert(!hit.json.result.content[0].text.includes('GITHUB_CREATE_PULL_REQUEST'), '关掉的不该被搜出来')
      const d = await rpc('github', 'tools/call', { name: 'SW_DESCRIBE', arguments: { tool: 'GITHUB_CREATE_PULL_REQUEST' } }, 9)
      assert(d.json.result.isError, '关掉的工具不该描述得出来')

      // 只剩一个开着 → 回到第 0 档，元工具收起来。档位是每次 tools/list 重算的。
      const list = await rpc('github', 'tools/list')
      const names = list.json.result.tools.map((x) => x.name)
      assert(names.length === 1 && names[0] === 'OP_001', `关到剩一个就该直连：${JSON.stringify(names)}`)

      await req(base, 'PUT', `/me/connectors/${connectorOf.github}/tools`, { token: memberTok, body: { enabledTools: [] } })
    })

    await test('推荐工具集：上架时挑好，装上就是那几个，不是全开', async () => {
      // 防线一被默认值架空了才有这一格：默认全开的界面上，员工要点四百多次才关得完。
      const patch = await req(base, 'PATCH', `/platform/connectors/${connectorOf.github}`, {
        token: owner,
        // 大小写不同的同一个只算一次。写错的 slug 是另一条用例（当场 400）。
        body: { recommendedTools: ['GITHUB_OP_001', 'GITHUB_OP_002', 'github_op_002'] },
      })
      assert(patch.status === 200, `patch ${patch.status} ${patch.text}`)
      assert(
        JSON.stringify(patch.json.connector.recommendedTools) === JSON.stringify(['GITHUB_OP_001', 'GITHUB_OP_002']),
        `大小写要归一、重复要去掉：${JSON.stringify(patch.json.connector.recommendedTools)}`,
      )

      // 换一个人来装，看新装的那份写进去的是什么。
      const other = await req(base, 'POST', `/orgs/${orgId}/accounts`, {
        token: adminTok,
        body: { email: 'm2@ts.test', name: '小李', password: 'correct-horse-1', role: 'member' },
      })
      assert(other.status === 201, `member2 ${other.status} ${other.text}`)
      const otherTok = (await req(base, 'POST', '/auth/login', { body: { email: 'm2@ts.test', password: 'correct-horse-1' } })).json.token
      const install = await req(base, 'POST', `/me/connectors/${connectorOf.github}/install`, { token: otherTok })
      assert(install.status === 201, `install ${install.status} ${install.text}`)
      assert(
        JSON.stringify(install.json.install.enabledTools) === JSON.stringify(['GITHUB_OP_001', 'GITHUB_OP_002']),
        `装上该只开推荐的那几个：${JSON.stringify(install.json.install.enabledTools)}`,
      )
      // 只开两个 → 直连，连降级都用不上。这才是防线一好用的样子。
      const detail = await req(base, 'GET', `/me/connectors/${connectorOf.github}`, { token: otherTok })
      assert(detail.json.toolMode === 'direct', `挑过之后该直连，实际 ${detail.json.toolMode}`)

      // **已经装好的那个人不受影响。** 他存的是 []（= 全开），改口径等于让他的工具悄悄少一批。
      const mine = await req(base, 'GET', `/me/connectors/${connectorOf.github}`, { token: memberTok })
      assert(mine.json.install.enabledTools.length === 0, `老的安装被改动了：${JSON.stringify(mine.json.install.enabledTools)}`)
      assert(mine.json.toolMode === 'search', `老的安装该还是全开、还是搜索模式，实际 ${mine.json.toolMode}`)

      // **没动推荐集的编辑不该被拖去核清单。** 供应商这会儿不可达时，改个说明也该存得下——
      // 否则一次上游抖动会把整个上架页面锁死，而那和这次编辑毫无关系。
      mock.seen.toolsDown = true
      const rename = await req(base, 'PATCH', `/platform/connectors/${connectorOf.github}`, {
        token: owner,
        body: { description: '只改说明' },
      })
      assert(rename.status === 200, `没动推荐集的编辑不该被挡：${rename.status} ${rename.text}`)
      assert(rename.json.connector.description === '只改说明', `说明没改上：${rename.text}`)
      assert(
        JSON.stringify(rename.json.connector.recommendedTools) === JSON.stringify(['GITHUB_OP_001', 'GITHUB_OP_002']),
        `推荐集被顺手清掉了：${JSON.stringify(rename.json.connector.recommendedTools)}`,
      )
      // 但真要改推荐集，清单拉不到就得挡住——放行等于把没核过的东西写进去。
      const blind = await req(base, 'PATCH', `/platform/connectors/${connectorOf.github}`, {
        token: owner,
        body: { recommendedTools: ['GITHUB_OP_003'] },
      })
      mock.seen.toolsDown = false
      assert(blind.status === 502, `核不了就该挡住，实际 ${blind.status} ${blind.text}`)
      const kept = await req(base, 'GET', `/platform/connectors/${connectorOf.github}`, { token: owner })
      assert(
        JSON.stringify(kept.json.connector.recommendedTools) === JSON.stringify(['GITHUB_OP_001', 'GITHUB_OP_002']),
        `被挡下的那次改动了存量：${kept.text}`,
      )

      await req(base, 'PATCH', `/platform/connectors/${connectorOf.github}`, { token: owner, body: { recommendedTools: [] } })
    })

    await test('SW_RUN 把参数平铺在顶层也认，不静默变成空参数', async () => {
      // 两层结构模型经常写错。只认 args 的话会带着空参数打上游，上游 2xx + successful:false
      // 是「跑过了」那一档——照收钱，模型再试一次再收一次。
      const before = mock.seen.executed.length
      const flat = await rpc(
        'github',
        'tools/call',
        { name: 'SW_RUN', arguments: { tool: 'GITHUB_CREATE_PULL_REQUEST', title: '平铺写法' } },
        20,
      )
      assert(!flat.json.result.isError, `平铺写法该照样跑通：${flat.text}`)
      assert(mock.seen.executed.length === before + 1, '该打一次上游')
      assert(mock.seen.executed.at(-1).args?.title === '平铺写法', `参数没捡起来：${JSON.stringify(mock.seen.executed.at(-1).args)}`)

      // args 被整个 JSON 字符串化，也认。
      const str = await rpc(
        'github',
        'tools/call',
        { name: 'SW_RUN', arguments: { tool: 'GITHUB_CREATE_PULL_REQUEST', args: '{"title":"字符串写法"}' } },
        21,
      )
      assert(!str.json.result.isError, `字符串化的 args 该认：${str.text}`)
      assert(mock.seen.executed.at(-1).args?.title === '字符串写法', `字符串 args 没解开：${JSON.stringify(mock.seen.executed.at(-1).args)}`)

      // 真的无参工具不受影响：捡起来的是空对象，不是把 tool 也塞进去。
      const bare = await rpc('github', 'tools/call', { name: 'SW_RUN', arguments: { tool: 'GITHUB_OP_001' } }, 22)
      assert(!bare.json.result.isError, `无参工具该跑通：${bare.text}`)
      assert(
        JSON.stringify(mock.seen.executed.at(-1).args) === '{}',
        `不该把 tool 混进参数：${JSON.stringify(mock.seen.executed.at(-1).args)}`,
      )
    })

    await test('目录拉不到时说的是「目录拉不到」，不是「没有这个工具」', async () => {
      /**
       * **整套流程都在 toolsDown 里走完**：`toolsOf` 只在成功时写缓存，所以 slack 的清单
       * 从头到尾没进过那五分钟的缓存，MCP 那边每次都会真的去打、真的会失败。
       */
      mock.seen.toolsDown = true
      try {
      const made = await req(base, 'POST', '/platform/connectors', {
        token: owner,
        body: { vendor: 'composio', toolkit: 'slack', name: 'slack', authConfigId: 'ac_slack', perm: '可写' },
      })
      assert(made.status === 201, `publish slack ${made.status} ${made.text}`)
      const slackId = made.json.connector.id
      await req(base, 'POST', `/me/connectors/${slackId}/install`, { token: memberTok })
      const conn = await req(base, 'POST', `/me/connectors/${slackId}/connections`, { token: memberTok, body: { label: 'default' } })
      assert(conn.status === 201, `connect slack ${conn.status} ${conn.text}`)
      const detail = await req(base, 'GET', `/me/connectors/${slackId}`, { token: memberTok })
      assert(detail.json.toolsError, `这一步就该拉不到清单：${detail.text}`)

      const cat = await req(base, 'GET', '/runtime/catalog', { token: seatTok })
      const path = new URL(cat.json.servers.find((x) => x.connector === 'slack').endpoint).pathname
      const call = (name, args, id) =>
        req(base, 'POST', path, { token: seatTok, body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } } })

      // 混成一个空数组的话这里会说「没有开着的 SLACK_POST_MESSAGE」，模型转头告诉用户
      // 这个能力不存在——而同一时刻 SW_RUN 是通的。同一个故障两种相反结论，最难查。
      const d = await call('SW_DESCRIBE', { tool: 'SLACK_POST_MESSAGE' }, 30)
      const dText = d.json.result.content[0].text
      assert(dText.includes('目录'), `该说是目录的问题：${dText}`)
      assert(dText.includes('不是没有这个工具'), `不许说成工具不存在：${dText}`)

      const sr = await call('SW_SEARCH', { query: 'post message' }, 31)
      const sText = sr.json.result.content[0].text
      assert(sText.includes('目录'), `搜索也该说是目录的问题：${sText}`)
      assert(!sText.includes('有 0 个工具'), `不许说成这把连接一个工具都没有：${sText}`)

      // 而 SW_RUN 这条路不依赖目录（resolveToolSlug 拉不到清单会退回猜前缀），必须还通。
      const before = mock.seen.executed.length
      const run = await call('SW_RUN', { tool: 'SLACK_POST_MESSAGE', args: { text: 'hi' } }, 32)
      assert(!run.json.result.isError, `目录挂了 SW_RUN 也该通：${run.text}`)
      assert(mock.seen.executed.length === before + 1, '该真的打到上游')
      assert(mock.seen.executed.at(-1).tool === 'SLACK_POST_MESSAGE', `工具名不对：${mock.seen.executed.at(-1).tool}`)
      } finally {
        // **必须 finally。** 这一条中途断掉时如果 toolsDown 留在 true，后面每一条都会
        // 报「拉不到清单」——三条误报盖住一条真错，是最难查的那种测试。
        mock.seen.toolsDown = false
      }
    })

    await test('推荐工具集写错 slug：当场挡住，不留到员工装上才炸', async () => {
      const bad = await req(base, 'PATCH', `/platform/connectors/${connectorOf.github}`, {
        token: owner,
        body: { recommendedTools: ['GITHUB_OP_001', 'GITHUB_CREATE_ISSUE'] },
      })
      assert(bad.status === 400, `写错的 slug 该当场 400，实际 ${bad.status} ${bad.text}`)
      assert(bad.text.includes('GITHUB_CREATE_ISSUE'), `要点名是哪一个错了：${bad.text}`)
      assert(!bad.text.includes('GITHUB_OP_001'), `对的那个不该被点名：${bad.text}`)

      // 挡住之后原来的值不能被改动——别把「不给存」做成了「顺手清掉」。
      const cur = await req(base, 'GET', `/platform/connectors/${connectorOf.github}`, { token: owner })
      assert(cur.json.connector.recommendedTools.length === 0, `被挡下的那次改动了存量：${cur.text}`)

      // 大小写不敏感地对，存回去的是清单里那个写法。
      const ok = await req(base, 'PATCH', `/platform/connectors/${connectorOf.github}`, {
        token: owner,
        body: { recommendedTools: ['github_op_001'] },
      })
      assert(ok.status === 200, `大小写不同该认，实际 ${ok.status} ${ok.text}`)
      assert(
        JSON.stringify(ok.json.connector.recommendedTools) === JSON.stringify(['GITHUB_OP_001']),
        `该归一成清单里的写法：${JSON.stringify(ok.json.connector.recommendedTools)}`,
      )
      await req(base, 'PATCH', `/platform/connectors/${connectorOf.github}`, { token: owner, body: { recommendedTools: [] } })
    })

    await test('开着的工具在清单里没了：数字要说实话，界面要给红字', async () => {
      // 供应商改名或下线一个工具之后，存着的 slug 既不下发也不报错。
      await req(base, 'PUT', `/me/connectors/${connectorOf.gmail}/tools`, {
        token: memberTok,
        body: { enabledTools: ['GMAIL_SEND_EMAIL', 'GMAIL_RENAMED_AWAY'] },
      })
      const detail = await req(base, 'GET', `/me/connectors/${connectorOf.gmail}`, { token: memberTok })
      // 存了 2 个，只有 1 个是真的。数「存了几个」的话界面会写 2，而 Bot 只拿到 1 个。
      assert(detail.json.enabledCount === 1, `该只数真的，实际 ${detail.json.enabledCount}`)
      assert(
        JSON.stringify(detail.json.unknownTools) === JSON.stringify(['GMAIL_RENAMED_AWAY']),
        `对不上的要点名：${JSON.stringify(detail.json.unknownTools)}`,
      )

      const { loadApp } = await import('./ui-dom.mjs')
      const ui = loadApp({ appPath: join(root, 'gateway/ui/app.js'), base, token: memberTok })
      await ui.boot()
      ui.state.path = `/plugins/${connectorOf.gmail}`
      ui.state.connectorDetail = detail.json
      ui.render()
      const html = ui.html()
      assert(html.includes('GMAIL_RENAMED_AWAY'), `界面该点名对不上的那个：${html.slice(html.indexOf('已开启') - 200, html.indexOf('已开启') + 600)}`)
      assert(html.includes('1 / 3'), `数字该说实话（1 个真的 / 一共 3 个）：${html.slice(html.indexOf('已开启') - 60, html.indexOf('已开启') + 10)}`)

      await req(base, 'PUT', `/me/connectors/${connectorOf.gmail}/tools`, { token: memberTok, body: { enabledTools: [] } })
    })

    await test('界面：搜索模式是一句说明，不是一条红字', async () => {
      const { loadApp } = await import('./ui-dom.mjs')
      const ui = loadApp({ appPath: join(root, 'gateway/ui/app.js'), base, token: memberTok })
      await ui.boot()
      ui.state.path = `/plugins/${connectorOf.github}`
      ui.state.connectorDetail = {
        connector: { id: connectorOf.github, name: 'GitHub', toolkit: 'github', blocked: false },
        install: { id: 'i1', enabledTools: [] },
        connections: [{ id: 'x1', label: 'default', scope: 'user', status: 'active', mentionOnly: false }],
        tools: [{ slug: 'A' }, { slug: 'B' }, { slug: 'C' }],
        toolCap: 2,
        toolMode: 'search',
      }
      ui.render()
      const html = ui.html()
      // 降级之后**没有东西被丢掉**，说成「不会下发」就是吓人。语气和事实要对得上。
      assert(html.includes('搜索模式'), `该说清切到了搜索模式：${html.slice(html.indexOf('工具'), html.indexOf('工具') + 400)}`)
      assert(!html.includes('不会下发'), '降级不是截断，别说成丢东西')
      assert(html.includes('gw-flash-note'), '这是一句说明，不该用红字那一档')
    })

    await test('详情页拿得到 toolMode，界面不用自己推', async () => {
      const gh = await req(base, 'GET', `/me/connectors/${connectorOf.github}`, { token: memberTok })
      assert(gh.json.toolMode === 'search', `github 该是 search，实际 ${gh.json.toolMode}`)
      const jira = await req(base, 'GET', `/me/connectors/${connectorOf.jira}`, { token: memberTok })
      assert(jira.json.toolMode === 'listing', `jira 该是 listing，实际 ${jira.json.toolMode}`)
      const gmail = await req(base, 'GET', `/me/connectors/${connectorOf.gmail}`, { token: memberTok })
      assert(gmail.json.toolMode === 'direct', `gmail 该是 direct，实际 ${gmail.json.toolMode}`)
    })
  } finally {
    // closeServer 先掐 keep-alive 连接再关：裸 close() 会等 Gateway 反代那条连接自己断，那永远不来。
    await closeServer(mock.server, 'composio mock')
    gw.kill()
    // 自己的数据目录自己收。
    rmSync(GW_HOME, { recursive: true, force: true })
  }
}
