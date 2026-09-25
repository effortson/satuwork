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
  /**
   * 慢流那一条的现场（同 llm-usage.mjs 那份）：上游这一侧看到连接什么时候断、有没有写完。
   * 这一份走的是 pi-ai 那条路（`/v1/chat/completions` 的流式），和 `/v1/messages` 的直转
   * 不是同一段代码，所以两边各钉一条。
   */
  const slow = { closedAt: 0, finished: false }
  const upstream = createServer((r, res) => {
    seen.auth = r.headers.authorization
    seen.path = r.url
    let buf = ''
    r.on('data', (d) => (buf += d))
    r.on('end', () => {
      seen.body = buf
      let parsed = null
      try {
        parsed = JSON.parse(buf)
      } catch {}
      if (buf.includes('e2e_slow')) {
        // 二十秒的慢流，一帧 50ms。Gateway 要是不掐，它会一直写到最后一帧。
        slow.closedAt = 0
        slow.finished = false
        res.on('close', () => {
          if (!slow.finished) slow.closedAt = Date.now()
        })
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        const piece = (delta) =>
          `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
        res.write(piece({ role: 'assistant' }))
        void (async () => {
          for (let i = 0; i < 400 && !res.destroyed; i++) {
            await new Promise((x) => setTimeout(x, 50))
            if (res.destroyed) break
            res.write(piece({ content: '慢' }))
          }
          if (res.destroyed) return
          slow.finished = true
          res.write('data: [DONE]\n\n')
          res.end()
        })()
        return
      }
      /**
       * **用量帧只在请求里写了 `stream_options.include_usage` 时才发。**
       *
       * 真上游就是这么干的：OpenAI 兼容的流不带这一格就一个 usage 字段都不回。假上游
       * 无条件发的话，「谁来补这一格」这件事就再也测不出来了——补丢了照样绿。
       * 同一条规矩在 e2e/manager.mjs 的中继假上游里也钉着一份。
       */
      const wantUsage = parsed?.stream_options?.include_usage === true
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
  await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r))
  const baseUrl = `http://127.0.0.1:${UP_PORT}/v1`

  const SCHEMA = schemaOf('e2e_custom')
  /**
   * 起一个 Gateway。`reset` 只有第一次给——重启那条用例要的就是「库里原样还在」，
   * 再清一次就什么都验不到了。
   */
  const boot = (name, { reset = false, env = {} } = {}) =>
    start(name, ['--import', 'tsx', `${gwRoot}/src/index.ts`], {
      cwd: gwRoot,
      env: {
        SATUWORK_GATEWAY_HOME: GW_HOME,
        GATEWAY_DATABASE_URL: PG_URL,
        GATEWAY_PG_SCHEMA: SCHEMA,
        ...(reset ? { GATEWAY_PG_RESET: '1' } : {}),
        GATEWAY_HOST: '127.0.0.1',
        GATEWAY_PORT: String(GW_PORT),
        GATEWAY_ACCESS_HOST: 'satuwork.com',
        GATEWAY_SEED_OWNER: '0',
        ...env,
      },
    })
  /** 等一个子进程真的退干净。端口只有一个，上一个不死下一个就绑不上。 */
  const stop = async (child) => {
    if (!child || child._exited) return
    try {
      child.kill('SIGTERM')
    } catch {}
    for (let i = 0; i < 100 && !child._exited; i++) await new Promise((r) => setTimeout(r, 100))
  }

  let gw = boot('custom-gw', { reset: true })
  await waitHttp(`${base}/health`, { child: gw, what: 'custom gateway' })

  const model = {
    id: 'my-model', name: 'My Model', contextWindow: 65536, maxTokens: 4096,
    reasoning: false, input: ['text'], cost: { input: 1.5, output: 3, cacheRead: 0, cacheWrite: 0 },
  }

  try {
    let token = ''
    /** 「公司密钥压过平台密钥」那条里建的那家公司。重启那条还要拿它的 id 和管理员票。 */
    let kOrgId = ''
    let kAdminTok = ''
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

    await test('/v1/chat/completions 流式：客户端中途走了，Gateway 当场中止上游、记 failed', async () => {
      // 这条流由 pi-ai 发起。断开检测以前挂在 `req.on('close')` 上，请求体读完之后它就
      // 不会再响了，于是 pi-ai 那一路被一直拉到最后一帧。
      const ac = new AbortController()
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'my-llm/my-model', stream: true, messages: [{ role: 'user', content: 'e2e_slow' }] }),
        signal: ac.signal,
      })
      assert(r.status === 200, `chat ${r.status}`)
      await r.body.getReader().read()
      ac.abort()

      const deadline = Date.now() + 5000
      while (!slow.closedAt && !slow.finished && Date.now() < deadline) await new Promise((x) => setTimeout(x, 50))
      assert(!slow.finished, '上游被一直拉到了最后一帧：客户端走了 Gateway 没停')
      assert(slow.closedAt > 0, '客户端走了五秒，Gateway 到上游的连接还开着')

      // 落账在收尾之后。系统管理员的调用不归任何公司，从平台那张表上看。
      let last
      for (let i = 0; i < 30; i++) {
        const charges = await req(base, 'GET', '/platform/charges?kind=llm&limit=1', { token })
        assert(charges.status === 200, `charges ${charges.status} ${charges.text}`)
        last = charges.json.charges[0]
        if (last?.status === 'failed') break
        await new Promise((x) => setTimeout(x, 100))
      }
      assert(last?.status === 'failed', `客户端中途走了应记 failed，实际 ${last?.status}`)
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

    await test('公司配不了密钥：那四条路整条撤了，所有公司共用平台那把', async () => {
      // 供应商只由平台配。这条盯的是**两件事同时成立**：`/orgs/:id/credentials` 一条
      // 都不在了（404，不是 403——403 会让「只撤了写、GET 还开着」看起来是对的），
      // 而公司照样调得通，用的是平台那把。
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
      kOrgId = orgId
      // 裸建的公司没钱，余额闸会先一步 402；这条验的是密钥取序，先给它充上。
      const paid = await req(base, 'POST', '/platform/orders', {
        token,
        body: { companyId: orgId, kind: 'topup', amount: 100, payStatus: 'paid', note: 'e2e' },
      })
      assert(paid.status === 201, `充值 ${paid.status} ${paid.text}`)
      const login = await req(base, 'POST', '/auth/login', { body: { email: 'k@custom.test', password: 'correct-horse-1' } })
      assert(login.status === 200, `admin login ${login.status} ${login.text}`)
      const at = login.json.token
      kAdminTok = at

      // 公司调得通，上游收到的是平台那把（前面那条配的 sk-custom-123）。
      seen = { auth: null, path: null, body: null }
      const viaPlatform = await req(base, 'POST', '/v1/chat/completions', {
        token: at,
        body: { model: 'my-llm/my-model', messages: [{ role: 'user', content: 'hi' }] },
      })
      assert(viaPlatform.status === 200, `chat ${viaPlatform.status} ${viaPlatform.text}`)
      assert(seen.auth === 'Bearer sk-custom-123', `上游收到的是 ${seen.auth}`)

      // 想贴一把自己的？没有这条路了。
      const set = await req(base, 'POST', `/orgs/${orgId}/credentials`, { token: at, body: { provider: 'my-llm', secret: 'company-key' } })
      assert(set.status === 404, `配公司密钥该 404，实际 ${set.status} ${set.text}`)
      const list = await req(base, 'GET', `/orgs/${orgId}/credentials`, { token: at })
      assert(list.status === 404, `列公司密钥该 404，实际 ${list.status}`)

      // owner（不属于任何公司）走的也是同一把。
      seen = { auth: null, path: null, body: null }
      const asOwner = await req(base, 'POST', '/v1/chat/completions', {
        token,
        body: { model: 'my-llm/my-model', messages: [{ role: 'user', content: 'hi' }] },
      })
      assert(asOwner.status === 200, `owner chat ${asOwner.status} ${asOwner.text}`)
      assert(seen.auth === 'Bearer sk-custom-123', `owner 调用上游收到的是 ${seen.auth}`)
    })

    await test('库里遗留的公司密钥行：重启不许把它升成平台密钥，也不许有人用上它', async () => {
      /**
       * 开机时那段「一次性提升」原先还捎带一句 `select provider, secret from credentials`
       * ——整张表、不带公司过滤——upsert 进 platform_credentials。
       *
       * **公司那条写入路径撤掉之后，这个风险不但没消失，反而更难发现**：`credentials`
       * 表里还躺着各家当初存进去的行，可现在没有任何接口读它或写它，于是那批数据是
       * 死的——谁也看不见、谁也改不了，直到某次重启把其中一把升成全平台的兜底密钥。
       *
       * 所以这条用例**直接往表里插一行**（那正是遗留数据在真实库里的样子，接口已经
       * 造不出它了），然后真的把 Gateway 停掉再起一遍——不带 GATEWAY_PG_RESET，要的
       * 就是库里原样还在。
       */
      // 平台那把先删掉：留着的话「平台有没有多出一把」这个问题就分不清是谁留下的。
      await req(base, 'DELETE', '/platform/credentials/my-llm', { token })
      const before = await req(base, 'GET', '/platform/credentials', { token })
      assert(!(before.json.credentials || []).some((c) => c.provider === 'my-llm'), '平台密钥没删干净，这条就验不到东西了')

      const { createRequire } = await import('node:module')
      const require = createRequire(new URL('../gateway/package.json', import.meta.url))
      const pg = require('pg')
      const client = new pg.Client({ connectionString: PG_URL })
      await client.connect()
      try {
        await client.query(`set search_path to "${SCHEMA}"`)
        await client.query(
          'insert into credentials (id, "companyId", provider, secret, "createdAt", "updatedAt") values ($1,$2,$3,$4,$5,$5)',
          [`legacy-${Date.now()}`, kOrgId, 'my-llm', 'only-company-a-key', Date.now()],
        )
      } finally {
        await client.end()
      }

      await stop(gw)
      // 环境变量那把是给所有公司兜底的：重启后该落到它上面，而不是落到遗留的那把上。
      gw = boot('custom-gw-restart', { env: { SATUWORK_MY_LLM_API_KEY: 'env-fallback-key' } })
      await waitHttp(`${base}/health`, { child: gw, what: 'custom gateway restart' })

      const creds = await req(base, 'GET', '/platform/credentials', { token })
      assert(creds.status === 200, `平台密钥列表 ${creds.status} ${creds.text}`)
      const lifted = (creds.json.credentials || []).find((c) => c.provider === 'my-llm')
      assert(!lifted, `遗留的公司密钥被升成了平台密钥：${JSON.stringify(lifted)}`)

      // 那一行所属的公司自己也不许用上它——公司那一档已经从取密钥的链路里撤了。
      seen = { auth: null, path: null, body: null }
      const asA = await req(base, 'POST', '/v1/chat/completions', {
        token: kAdminTok,
        body: { model: 'my-llm/my-model', messages: [{ role: 'user', content: 'hi' }] },
      })
      assert(asA.status === 200, `chat ${asA.status} ${asA.text}`)
      assert(seen.auth !== 'Bearer only-company-a-key', '遗留的公司密钥还在被使用——公司那一档没撤干净')
      assert(seen.auth === 'Bearer env-fallback-key', `上游收到的是 ${seen.auth}`)

      // 收拾干净：后面几条用例还指着平台那把 sk-custom-123。
      const back = await req(base, 'POST', '/platform/credentials', { token, body: { provider: 'my-llm', secret: 'sk-custom-123' } })
      assert(back.status === 201, `补回平台密钥 ${back.status} ${back.text}`)
    })

    await test('日常模型备选：白名单外的 400，和默认重复的剔掉，形状不对的 400', async () => {
      // 备选就是人在对话框里能换到的全部（docs/model-choice.md），写端必须过和上架同一道闸。
      const two = await req(base, 'PUT', '/platform/providers/my-llm', {
        token,
        body: {
          name: 'My LLM', baseUrl, api: 'openai-completions',
          models: [model, { id: 'second', name: 'Second', contextWindow: 8192, maxTokens: 1024, cost: { input: 9, output: 9 } }],
        },
      })
      assert(two.status === 200, `加第二个模型 ${two.status} ${two.text}`)
      const put = await req(base, 'PUT', '/platform/settings', {
        token,
        body: {
          daily: { provider: 'my-llm', model: 'my-model' },
          dailyAlternates: [
            { provider: 'my-llm', model: 'second', reasoningEffort: 'off' },
            // 和默认同一个：不该在对话框里出现第二行。
            { provider: 'my-llm', model: 'my-model' },
            { provider: 'my-llm', model: 'second' },
          ],
        },
      })
      assert(put.status === 200, `存备选 ${put.status} ${put.text}`)
      const alts = put.json.dailyAlternates || []
      assert(alts.length === 1 && alts[0].provider === 'my-llm' && alts[0].model === 'second', `备选没收口：${JSON.stringify(alts)}`)
      const st = await req(base, 'GET', '/platform/settings', { token })
      assert((st.json.dailyAlternates || []).length === 1, `读回来不对：${JSON.stringify(st.json.dailyAlternates)}`)

      // 目录里没有的：拦下，原来那份一个字不动。
      const ghost = await req(base, 'PUT', '/platform/settings', { token, body: { dailyAlternates: [{ provider: 'my-llm', model: 'nope' }] } })
      assert(ghost.status === 400, `目录里没有的也收了：${ghost.status} ${ghost.text}`)
      // 上架名单开着、却不在名单里的：同样拦下——否则「备选」就是绕过白名单的后门。
      const fenced = await req(base, 'PUT', '/platform/settings', {
        token,
        body: { enabledModels: ['my-llm/my-model'], dailyAlternates: [{ provider: 'my-llm', model: 'second' }] },
      })
      assert(fenced.status === 400, `白名单外的备选也收了：${fenced.status} ${fenced.text}`)
      const shape = await req(base, 'PUT', '/platform/settings', { token, body: { dailyAlternates: [{ provider: 'my-llm' }] } })
      assert(shape.status === 400, `缺 model 的也收了：${shape.status} ${shape.text}`)
      const after = await req(base, 'GET', '/platform/settings', { token })
      assert(
        (after.json.dailyAlternates || []).length === 1 && (after.json.enabledModels || []).length === 0,
        `被拦下的那几次改动了设置：${JSON.stringify(after.json)}`,
      )

      // 只改别的字段时，备选原样留着（整份重写那一步漏了它的话，这里就是空的）。
      await req(base, 'PUT', '/platform/settings', { token, body: { priceMultiplier: 1 } })
      const kept = await req(base, 'GET', '/platform/settings', { token })
      assert((kept.json.dailyAlternates || []).length === 1, `改倍率把备选抹了：${JSON.stringify(kept.json.dailyAlternates)}`)

      // 只收窄上架名单：已经下架的备选跟着拿掉，不然人还能在对话框里把它挑回来。
      const narrow = await req(base, 'PUT', '/platform/settings', { token, body: { enabledModels: ['my-llm/my-model'] } })
      assert(narrow.status === 200 && (narrow.json.dailyAlternates || []).length === 0, `下架的备选还留着：${JSON.stringify(narrow.json.dailyAlternates)}`)
      await req(base, 'PUT', '/platform/settings', { token, body: { enabledModels: [] } })

      // 「设为默认」是对调：原来的默认降成备选。它当默认时从没被要求在上架名单里，
      // 降下来也不该因此被挡——否则名单一收窄，这一下对调就永远做不成。
      await req(base, 'PUT', '/platform/settings', { token, body: { dailyAlternates: [{ provider: 'my-llm', model: 'second' }], enabledModels: ['my-llm/second'] } })
      const swap = await req(base, 'PUT', '/platform/settings', {
        token,
        body: { daily: { provider: 'my-llm', model: 'second' }, dailyAlternates: [{ provider: 'my-llm', model: 'my-model' }] },
      })
      assert(swap.status === 200, `对调被挡了：${swap.status} ${swap.text}`)
      assert(swap.json.daily.model === 'second' && swap.json.dailyAlternates?.[0]?.model === 'my-model', `对调结果不对：${swap.text}`)
      await req(base, 'PUT', '/platform/settings', {
        token,
        body: { enabledModels: [], daily: { provider: 'my-llm', model: 'my-model' }, dailyAlternates: [{ provider: 'my-llm', model: 'second' }] },
      })

      // 供应商的模型清单改短了：指着被删那个的备选当场拿掉，不留一行选了就报错的。
      const shrink = await req(base, 'PUT', '/platform/providers/my-llm', {
        token,
        body: { name: 'My LLM', baseUrl, api: 'openai-completions', models: [model] },
      })
      assert(shrink.status === 200 && (shrink.json.droppedAlternates || []).includes('my-llm/second'), `改清单没报剔掉的备选：${shrink.text}`)
      const pruned = await req(base, 'GET', '/platform/settings', { token })
      assert((pruned.json.dailyAlternates || []).length === 0, `被删的模型还留在备选里：${JSON.stringify(pruned.json.dailyAlternates)}`)

      // 还原：下一条要验「删供应商时备选跟着清」，得先有一个指着它的备选。
      await req(base, 'PUT', '/platform/providers/my-llm', {
        token,
        body: {
          name: 'My LLM', baseUrl, api: 'openai-completions',
          models: [model, { id: 'second', name: 'Second', contextWindow: 8192, maxTokens: 1024, cost: { input: 9, output: 9 } }],
        },
      })
      const again = await req(base, 'PUT', '/platform/settings', { token, body: { dailyAlternates: [{ provider: 'my-llm', model: 'second' }] } })
      assert((again.json.dailyAlternates || []).length === 1, `还原备选 ${again.status} ${again.text}`)
    })

    await test('只有备选用着的供应商：删也要 409 确认，force 之后备选清掉并留痕', async () => {
      // 有人正用着这个备选聊天：删掉之后他们会被退回默认，和删掉日常模型一样值得确认一次。
      await req(base, 'PUT', '/platform/settings', { token, body: { daily: { provider: '', model: '' } } })
      const blocked = await req(base, 'DELETE', '/platform/providers/my-llm', { token })
      assert(blocked.status === 409 && /日常备选/.test(blocked.text), `只被备选用着也该 409：${blocked.status} ${blocked.text}`)
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
      // 上一条留下的那个备选也指着它：供应商没了，留着就是对话框里一行选了就报错的。
      assert(!(st.json.dailyAlternates || []).some((r) => r.provider === 'my-llm'), `备选没跟着清：${JSON.stringify(st.json.dailyAlternates)}`)
      assert((forced.json.droppedAlternates || []).includes('my-llm/second'), `响应没说清掉了哪些备选：${forced.text}`)
      assert((forced.json.clearedRoles || []).includes('日常备选'), `clearedRoles 没记备选：${forced.text}`)
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
