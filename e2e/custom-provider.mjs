/**
 * 自定义供应商：建 → 配密钥 → 真的能调 → 删。
 *
 * 关键不是「列表里出现了」，而是**调得通**。之前 catalog 里那种自定义模型只在
 * 列表里露脸，pi-ai 的注册表里根本没有，probe 和 /v1/* 一律「模型不在可见目录里」。
 * 所以这里挂一个假的 OpenAI 兼容上游，断言请求真的打到了它身上、带着对的密钥。
 */
import { createServer } from 'node:http'
import { rmSync } from 'node:fs'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { freePorts } from './ports.mjs'
import { closeServer } from './probe.mjs'

export async function runCustomProvider({ gwRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = tmpOf('satuwork-e2e-custom')
  const [GW_PORT, UP_PORT] = await freePorts(2)
  const base = `http://127.0.0.1:${GW_PORT}`

  rmSync(GW_HOME, { recursive: true, force: true })
  log('\n# custom-provider')

  let seen = { auth: null, path: null, body: null }
  const upstream = createServer((r, res) => {
    seen.auth = r.headers.authorization
    seen.path = r.url
    let buf = ''
    r.on('data', (d) => (buf += d))
    r.on('end', () => {
      seen.body = buf
      // openai-completions 是流式的，必须发 SSE，不能发整包 JSON。
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const chunk = (choices, usage) =>
        `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices, ...(usage ? { usage } : {}) })}\n\n`
      res.write(chunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]))
      res.write(chunk([{ index: 0, delta: { content: 'ok' }, finish_reason: null }]))
      res.write(chunk([{ index: 0, delta: {}, finish_reason: 'stop' }], { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 }))
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r))
  const baseUrl = `http://127.0.0.1:${UP_PORT}/v1`

  const gw = start('custom-gw', ['--import', 'tsx', `${gwRoot}/src/index.ts`], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: schemaOf('e2e_custom'),
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '0',
    },
  })
  await waitHttp(`${base}/health`, { child: gw, what: 'custom gateway' })

  const model = {
    id: 'my-model', name: 'My Model', contextWindow: 65536, maxTokens: 4096,
    reasoning: false, input: ['text'], cost: { input: 1.5, output: 3, cacheRead: 0, cacheWrite: 0 },
  }

  try {
    let token = ''
    await test('建自定义供应商：形状就是 pi-ai createProvider 的入参', async () => {
      const setup = await req(base, 'POST', '/auth/setup', {
        body: { email: 'o@custom.test', name: 'o', password: 'correct-horse-1' },
      })
      assert(setup.status === 201, `setup ${setup.status} ${setup.text}`)
      token = setup.json.token
      const r = await req(base, 'POST', '/platform/providers', {
        token,
        body: { id: 'my-llm', name: 'My LLM', baseUrl, api: 'openai-completions', models: [model] },
      })
      assert(r.status === 201, `create ${r.status} ${r.text}`)
      assert(r.json.provider.api === 'openai-completions', 'api 没存下')
    })

    await test('内置 id 顶不掉；坏 id / 坏 baseUrl 是 400 不是 500', async () => {
      const clash = await req(base, 'POST', '/platform/providers', { token, body: { id: 'openai', baseUrl } })
      assert(clash.status === 409, `内置 id ${clash.status} ${clash.text}`)
      const badUrl = await req(base, 'POST', '/platform/providers', { token, body: { id: 'bad-a', baseUrl: 'not-a-url' } })
      assert(badUrl.status === 400, `坏 baseUrl ${badUrl.status}`)
      const badId = await req(base, 'POST', '/platform/providers', { token, body: { id: 'Bad Id!', baseUrl } })
      assert(badId.status === 400, `坏 id ${badId.status}`)
      const badApi = await req(base, 'POST', '/platform/providers', { token, body: { id: 'bad-b', baseUrl, api: 'made-up' } })
      assert(badApi.status === 400, `坏 api ${badApi.status}`)
    })

    await test('自定义模型进 /v1/models，带着单价和窗口', async () => {
      const r = await req(base, 'GET', '/v1/models', { token })
      const m = (r.json.data || []).find((x) => x.id === 'my-llm/my-model')
      assert(m, '自定义模型没出现在 /v1/models')
      assert(m.cost?.input === 1.5, `单价 ${JSON.stringify(m.cost)}`)
      assert(m.context_window === 65536, `窗口 ${m.context_window}`)
    })

    await test('没密钥 402；配上之后 probe 真的打到上游', async () => {
      const noKey = await req(base, 'POST', '/platform/llm/test', { token, body: { provider: 'my-llm', model: 'my-model' } })
      assert(noKey.status === 402, `没密钥 ${noKey.status} ${noKey.text}`)

      await req(base, 'POST', '/platform/credentials', { token, body: { provider: 'my-llm', secret: 'sk-custom-123' } })
      seen = { auth: null, path: null, body: null }
      const probe = await req(base, 'POST', '/platform/llm/test', { token, body: { provider: 'my-llm', model: 'my-model' } })
      assert(probe.status === 200 && probe.json.ok === true, `probe ${probe.status} ${probe.text}`)
      assert(seen.auth === 'Bearer sk-custom-123', `上游收到的密钥是 ${seen.auth}`)
      assert(String(seen.path).includes('/v1/chat/completions'), `打的路径是 ${seen.path}`)
      assert(!probe.text.includes('sk-custom-123'), 'probe 响应里漏了密钥')
    })

    await test('/v1/chat/completions 能用这个模型——这才叫「模型可用」', async () => {
      const r = await req(base, 'POST', '/v1/chat/completions', {
        token,
        body: { model: 'my-llm/my-model', messages: [{ role: 'user', content: 'hi' }] },
      })
      assert(r.status === 200, `chat ${r.status} ${r.text}`)
    })

    await test('模型 id 带斜杠：openrouter 那种 vendor/model 能录、能测、能调', async () => {
      const slashed = { ...model, id: 'vendor/model-1', name: 'Slashed' }
      const upd = await req(base, 'PUT', '/platform/providers/my-llm', {
        token,
        body: { name: 'My LLM', baseUrl, api: 'openai-completions', models: [model, slashed] },
      })
      assert(upd.status === 200, `带斜杠的模型没存下 ${upd.status} ${upd.text}`)

      const list = await req(base, 'GET', '/v1/models', { token })
      const m = (list.json.data || []).find((x) => x.id === 'my-llm/vendor/model-1')
      assert(m, '带斜杠的模型没进 /v1/models')
      // 复合 id 只在第一个斜杠上切，model 那一段必须是完整的模型 id。
      assert(m.model === 'vendor/model-1', `model 字段被切坏了：${m.model}`)

      // probe 传的是「provider + 裸 id」，切的那一刀会落在模型 id 自己的斜杠上，得能找回来。
      const probe = await req(base, 'POST', '/platform/llm/test', {
        token,
        body: { provider: 'my-llm', model: 'vendor/model-1' },
      })
      assert(probe.status === 200 && probe.json.ok === true, `probe ${probe.status} ${probe.text}`)
      assert(probe.json.model === 'vendor/model-1', `probe 回的 model 是 ${probe.json.model}`)

      seen = { auth: null, path: null, body: null }
      const chat = await req(base, 'POST', '/v1/chat/completions', {
        token,
        body: { model: 'my-llm/vendor/model-1', messages: [{ role: 'user', content: 'hi' }] },
      })
      assert(chat.status === 200, `chat ${chat.status} ${chat.text}`)
      // 上游要收到模型自己的 id，不能把 provider 那一段也捎上去。
      const upModel = JSON.parse(seen.body || '{}').model
      assert(upModel === 'vendor/model-1', `上游收到的 model 是 ${upModel}`)
    })

    await test('斜杠只能夹在中间：开头、结尾、连着两个都拦掉', async () => {
      for (const bad of ['/lead', 'trail/', 'a//b', 'a/ /b']) {
        const r = await req(base, 'PUT', '/platform/providers/my-llm', {
          token,
          body: { name: 'My LLM', baseUrl, api: 'openai-completions', models: [{ ...model, id: bad }] },
        })
        assert(r.status === 400, `坏 id ${JSON.stringify(bad)} 被收下了：${r.status} ${r.text}`)
      }
    })

    await test('改定义后注册表跟着变：新模型立刻能用，删掉的立刻不能用', async () => {
      const upd = await req(base, 'PUT', '/platform/providers/my-llm', {
        token,
        body: {
          name: 'My LLM', baseUrl, api: 'openai-completions',
          models: [model, { id: 'second', name: 'Second', contextWindow: 8192, maxTokens: 1024, cost: { input: 9, output: 9 } }],
        },
      })
      assert(upd.status === 200, `update ${upd.status} ${upd.text}`)
      const two = await req(base, 'GET', '/v1/models', { token })
      assert((two.json.data || []).some((m) => m.id === 'my-llm/second'), '新模型没生效')

      await req(base, 'PUT', '/platform/providers/my-llm', {
        token,
        body: { name: 'My LLM', baseUrl, api: 'openai-completions', models: [model] },
      })
      const gone = await req(base, 'POST', '/platform/llm/test', { token, body: { provider: 'my-llm', model: 'second' } })
      assert(gone.status === 404, `删掉的模型还能测：${gone.status} ${gone.text}`)
    })

    await test('模型 id 重复要拦下来', async () => {
      const dup = await req(base, 'PUT', '/platform/providers/my-llm', {
        token,
        body: { name: 'My LLM', baseUrl, api: 'openai-completions', models: [model, model] },
      })
      assert(dup.status === 400, `重复 id ${dup.status} ${dup.text}`)
    })

    await test('公司密钥压过平台密钥：Gateway 直连 /v1 也按「公司 → 平台」取密钥', async () => {
      // 中继落到管家之后，Gateway 自己的 /v1 仍给本地 Bot 用。取密钥的次序两边必须同一份：
      // 公司配了自己的 key 就用公司的，没配才落到平台的——否则同一家公司走两条路记两家账。
      const org = await req(base, 'POST', '/platform/orgs', {
        token,
        body: {
          name: 'K', slug: 'k-custom',
          contactName: '李四', contactPhone: '+86 138 0000 0001', contactEmail: 'k@custom.test',
          adminEmail: 'k@custom.test', adminPassword: 'correct-horse-1',
        },
      })
      assert(org.status === 201, `org ${org.status} ${org.text}`)
      const orgId = org.json.company.id
      // 裸建的公司没钱，余额闸会先一步 402；这条验的是密钥取序，先给它充上。
      const paid = await req(base, 'POST', '/platform/orders', {
        token,
        body: { companyId: orgId, kind: 'topup', amount: 100, payStatus: 'paid', note: 'e2e' },
      })
      assert(paid.status === 201, `充值 ${paid.status} ${paid.text}`)
      const login = await req(base, 'POST', '/auth/login', { body: { email: 'k@custom.test', password: 'correct-horse-1' } })
      assert(login.status === 200, `admin login ${login.status} ${login.text}`)
      const at = login.json.token

      // 只有平台密钥时公司也能调，上游收到的是平台那把（前面那条配的 sk-custom-123）。
      seen = { auth: null, path: null, body: null }
      const viaPlatform = await req(base, 'POST', '/v1/chat/completions', {
        token: at,
        body: { model: 'my-llm/my-model', messages: [{ role: 'user', content: 'hi' }] },
      })
      assert(viaPlatform.status === 200, `没公司密钥时 chat ${viaPlatform.status} ${viaPlatform.text}`)
      assert(seen.auth === 'Bearer sk-custom-123', `没公司密钥时上游收到的是 ${seen.auth}`)

      const set = await req(base, 'POST', `/orgs/${orgId}/credentials`, { token: at, body: { provider: 'my-llm', secret: 'company-key' } })
      assert(set.status === 201, `配公司密钥 ${set.status} ${set.text}`)
      assert(!set.text.includes('company-key'), '配公司密钥的响应把密钥回显了')
      const list = await req(base, 'GET', `/orgs/${orgId}/credentials`, { token: at })
      assert(list.status === 200, `列公司密钥 ${list.status} ${list.text}`)
      const row = (list.json.credentials || []).find((c) => c.provider === 'my-llm')
      assert(row && row.configured === true && row.scope === 'company', `公司密钥没标成 company：${JSON.stringify(row)}`)

      seen = { auth: null, path: null, body: null }
      const viaCompany = await req(base, 'POST', '/v1/chat/completions', {
        token: at,
        body: { model: 'my-llm/my-model', messages: [{ role: 'user', content: 'hi' }] },
      })
      assert(viaCompany.status === 200, `有公司密钥时 chat ${viaCompany.status} ${viaCompany.text}`)
      assert(seen.auth === 'Bearer company-key', `公司配了密钥，上游收到的却是 ${seen.auth}`)

      // 公司密钥不影响别家：owner（不属于任何公司）仍走平台那把。
      seen = { auth: null, path: null, body: null }
      const asOwner = await req(base, 'POST', '/v1/chat/completions', {
        token,
        body: { model: 'my-llm/my-model', messages: [{ role: 'user', content: 'hi' }] },
      })
      assert(asOwner.status === 200, `owner chat ${asOwner.status} ${asOwner.text}`)
      assert(seen.auth === 'Bearer sk-custom-123', `owner 调用上游收到的是 ${seen.auth}`)

      // 删掉公司密钥就落回平台的；再删一次是 404，不是 200 假装删了。
      const del = await req(base, 'DELETE', `/orgs/${orgId}/credentials/my-llm`, { token: at })
      assert(del.status === 200, `删公司密钥 ${del.status} ${del.text}`)
      const again = await req(base, 'DELETE', `/orgs/${orgId}/credentials/my-llm`, { token: at })
      assert(again.status === 404, `重复删该 404，实际 ${again.status} ${again.text}`)
      seen = { auth: null, path: null, body: null }
      const back = await req(base, 'POST', '/v1/chat/completions', {
        token: at,
        body: { model: 'my-llm/my-model', messages: [{ role: 'user', content: 'hi' }] },
      })
      assert(back.status === 200, `删掉公司密钥后 chat ${back.status} ${back.text}`)
      assert(seen.auth === 'Bearer sk-custom-123', `删掉公司密钥后上游收到的是 ${seen.auth}`)
    })

    await test('在用时删要 409；force 之后密钥和角色一起清掉', async () => {
      await req(base, 'PUT', '/platform/settings', { token, body: { daily: { provider: 'my-llm', model: 'my-model' } } })
      const blocked = await req(base, 'DELETE', '/platform/providers/my-llm', { token })
      assert(blocked.status === 409, `在用时删 ${blocked.status} ${blocked.text}`)

      const forced = await req(base, 'DELETE', '/platform/providers/my-llm?force=1', { token })
      assert(forced.status === 200, `force 删 ${forced.status} ${forced.text}`)

      const models = await req(base, 'GET', '/v1/models', { token })
      assert(!(models.json.data || []).some((m) => String(m.id).startsWith('my-llm/')), '删完模型还在')
      const creds = await req(base, 'GET', '/platform/credentials', { token })
      assert(!(creds.json.credentials || []).some((c) => c.provider === 'my-llm'), '密钥没跟着删')
      const st = await req(base, 'GET', '/platform/settings', { token })
      assert(st.json.daily.provider === '', `日常角色没清空：${JSON.stringify(st.json.daily)}`)
    })

    await test('非 owner 碰不到自定义供应商', async () => {
      // 建公司时连管理员一起开，省得再单独建账号。
      const org = await req(base, 'POST', '/platform/orgs', {
        token,
        body: {
          name: 'C', slug: 'c-custom',
          contactName: '张三', contactPhone: '+86 138 0000 0000', contactEmail: 'z@custom.test',
          adminEmail: 'a@custom.test', adminPassword: 'correct-horse-1',
        },
      })
      assert(org.status === 201, `org ${org.status} ${org.text}`)
      const login = await req(base, 'POST', '/auth/login', { body: { email: 'a@custom.test', password: 'correct-horse-1' } })
      const at = login.json.token
      const list = await req(base, 'GET', '/platform/providers', { token: at })
      assert(list.status === 403, `admin 读到了 ${list.status}`)
      const create = await req(base, 'POST', '/platform/providers', { token: at, body: { id: 'sneaky', baseUrl } })
      assert(create.status === 403, `admin 建成了 ${create.status}`)
    })
  } finally {
    gw.kill()
    // closeServer 先掐 keep-alive 连接再关：裸 close() 会等 Gateway 那条连接自己断，那永远不来。
    await closeServer(upstream, 'custom provider upstream')
    try {
      rmSync(GW_HOME, { recursive: true, force: true })
    } catch {}
  }
}
