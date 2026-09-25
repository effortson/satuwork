/**
 * /v1 反代的用量记账。假上游，不打真模型。
 *
 * 两件事只有在真的走一遍 SSE 才看得出来：
 * 1. usage 不一定在顶层——OpenAI Responses 裹在 `response` 里，Anthropic 的输入
 *    token 裹在 message_start 的 `message` 里，输出 token 才在 message_delta 顶层。
 * 2. 多字节字符会被切在两个 chunk 中间。解码器不连续的话那一帧就 parse 不动。
 *
 * 两者都只伤记账，不伤转发，所以线上不会报错，只会账目对不上。
 */
import { createServer } from 'node:http'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { createCompany } from './org.mjs'
import { freePort } from './ports.mjs'
import { closeServer } from './probe.mjs'

/** 按 7 字节一刀切，几乎必然把 3 字节的汉字切断。 */
function sseChunks(frames) {
  const buf = Buffer.from(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(''), 'utf8')
  const out = []
  for (let i = 0; i < buf.length; i += 7) out.push(buf.subarray(i, i + 7))
  return out
}

const ANTHROPIC_TEXT = '你好，世界。这是一段中文回复。'
const OPENAI_TEXT = '中文增量内容测试'

function startFakeUpstream() {
  /**
   * 慢流那一条的现场：上游这一侧看到的连接什么时候断、有没有自己写完。
   *
   * 「客户端走了，Gateway 就掐掉上游」只能从这一侧验——客户端断开之后它什么都收不到，
   * 而 Gateway 那头继续拉流也不会报任何错，只是钱照付。
   */
  const slow = { closedAt: 0, finished: false }
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    // 请求体里带 e2e_die 就写一帧然后把连接掐了，模拟「上游中途断流」。
    // Gateway 转发时会把 body 原样带过来，所以这个标记到得了这儿。
    let die = false
    let slowMode = false
    let echo = false
    try {
      const parsed = JSON.parse(raw || '{}')
      die = Boolean(parsed.e2e_die)
      slowMode = Boolean(parsed.e2e_slow)
      echo = Boolean(parsed.e2e_echo)
    } catch {}
    if (echo) {
      // 一页纯文本的 401，把收到的密钥原样回显——上游（或它前面那层代理）真会这么干。
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`invalid api key: ${req.headers['x-api-key'] || req.headers.authorization || ''}`)
      return
    }
    if (slowMode) {
      // 二十秒的慢流，一帧 50ms。Gateway 要是不掐，它会一直写到最后一帧。
      slow.closedAt = 0
      slow.finished = false
      res.on('close', () => {
        if (!slow.finished) slow.closedAt = Date.now()
      })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ type: 'message_start', message: { id: 'mslow', usage: { input_tokens: 900, output_tokens: 1 } } })}\n\n`)
      for (let i = 0; i < 400 && !res.destroyed; i++) {
        await new Promise((r) => setTimeout(r, 50))
        if (res.destroyed) break
        res.write(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '慢' } })}\n\n`)
      }
      if (!res.destroyed) {
        slow.finished = true
        res.end()
      }
      return
    }
    if (die) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      // 只给 message_start——输入 token 在这一帧里。之后直接断，后面的
      // message_delta（输出 token）永远不会来。
      res.write(`data: ${JSON.stringify({ type: 'message_start', message: { id: 'mdie', usage: { input_tokens: 900, output_tokens: 1 } } })}\n\n`)
      await new Promise((r) => setTimeout(r, 5))
      res.destroy()
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const frames = req.url.includes('/v1/messages')
      ? [
          // Anthropic 的 input_tokens **不含**缓存那两项，各自单列。只读 input_tokens
          // 的话，命中缓存越多、账面上的提示词越小——这里给足三项，让记账把它们加齐。
          {
            type: 'message_start',
            message: {
              id: 'm1',
              usage: {
                input_tokens: 900,
                output_tokens: 1,
                cache_read_input_tokens: 400,
                cache_creation_input_tokens: 100,
              },
            },
          },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ANTHROPIC_TEXT } },
          // message_delta 再回传一次累计 input_tokens，但**不重复缓存那两项**——
          // Anthropic 部分版本就是这个行为。记账要是「后来居上」，这一帧就会把
          // message_start 合出来的 1400 覆盖成 900，缓存那 400 又漏了。
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { input_tokens: 900, output_tokens: 15 },
          },
          { type: 'message_stop' },
        ]
      : [
          { type: 'response.output_text.delta', delta: OPENAI_TEXT },
          { type: 'response.completed', response: { id: 'r1', usage: { input_tokens: 700, output_tokens: 25 } } },
        ]
    for (const c of sseChunks(frames)) {
      res.write(c)
      await new Promise((r) => setTimeout(r, 1))
    }
    res.end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, slow, url: `http://127.0.0.1:${server.address().port}` }))
  })
}

export async function runLlmUsage({ gwRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = tmpOf('satuwork-e2e-usage-gw')
  const GW_PORT = await freePort()
  const gwBase = `http://127.0.0.1:${GW_PORT}`

  rmSync(GW_HOME, { recursive: true, force: true })
  log('\n# llm-usage')

  const upstream = await startFakeUpstream()
  const gw = start('usage-gw', ['--import', 'tsx', join(gwRoot, 'src/index.ts')], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: schemaOf('e2e_usage'),
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_MACHINE_TOKEN: 'e2e-machine-usage',
      GATEWAY_PLATFORM_TOKEN: 'e2e-platform-usage',
      GATEWAY_SEED_OWNER: '1',
      GATEWAY_OWNER_EMAIL: 'owner@usage.test',
      GATEWAY_OWNER_PASSWORD: 'test-owner-usage',
      ANTHROPIC_BASE_URL: upstream.url,
      OPENAI_BASE_URL: upstream.url,
      ANTHROPIC_API_KEY: 'fake-anthropic-key',
      OPENAI_API_KEY: 'fake-openai-key',
    },
  })
  await waitHttp(`${gwBase}/health`, { child: gw, what: 'usage gateway' })

  try {
    const reg = await createCompany(req, gwBase, {
      ownerEmail: 'owner@usage.test',
      ownerPassword: 'test-owner-usage',
      email: 'admin@usage.test',
      password: 'correct-horse-1',
      companyName: 'Usage',
      slug: 'usage',
      seats: 2,
    })
    const token = reg.token
    const orgId = reg.company.id

    const models = await req(gwBase, 'GET', '/v1/models', { token })
    assert(models.status === 200, `models ${models.status}`)
    const anthropicModel = models.json.data.find((m) => m.provider === 'anthropic')
    const openaiModel = models.json.data.find((m) => m.provider === 'openai')
    assert(anthropicModel && openaiModel, '目录里缺 anthropic / openai 模型')

    const statOf = (usage, label) => Number(usage.json.stats.find((s) => s.label === label).value)
    const readUsage = async () => {
      // 记账在响应写完之后落库，给它一拍。
      await new Promise((r) => setTimeout(r, 200))
      const u = await req(gwBase, 'GET', `/orgs/${orgId}/usage`, { token })
      assert(u.status === 200, `usage ${u.status} ${u.text}`)
      return { prompt: statOf(u, '输入 Tokens'), completion: statOf(u, '输出 Tokens') }
    }

    await test('/v1/messages 流式：输入 token 在 message_start 里，缓存那两项也要加进提示词', async () => {
      const r = await req(gwBase, 'POST', '/v1/messages', {
        token,
        body: {
          model: anthropicModel.id,
          stream: true,
          max_tokens: 64,
          messages: [{ role: 'user', content: '你好' }],
        },
      })
      assert(r.status === 200, `messages ${r.status} ${r.text.slice(0, 200)}`)
      assert(r.text.includes(ANTHROPIC_TEXT), '转发的中文被切坏了')
      const u = await readUsage()
      // 900 未命中 + 400 命中缓存 + 100 写缓存。只记 900 就是把命中的那截白送。
      assert(u.prompt === 1400, `输入 tokens ${u.prompt}，应为 1400`)
      assert(u.completion === 15, `输出 tokens ${u.completion}，应为 15`)
    })

    await test('/v1/responses 流式：usage 裹在 response 里也要记上', async () => {
      const r = await req(gwBase, 'POST', '/v1/responses', {
        token,
        body: { model: openaiModel.id, stream: true, input: '你好' },
      })
      assert(r.status === 200, `responses ${r.status} ${r.text.slice(0, 200)}`)
      assert(r.text.includes(OPENAI_TEXT), '转发的中文被切坏了')
      const u = await readUsage()
      assert(u.prompt === 2100, `累计输入 tokens ${u.prompt}，应为 2100`)
      assert(u.completion === 40, `累计输出 tokens ${u.completion}，应为 40`)
    })

    await test('有用量记录的公司删不掉——用量也要留档', async () => {
      // 上面几条已经在这家公司名下压了真实的 llm_calls。留档口径里用量算数，所以硬删
      // 必须被挡下来，改走「停用」。这条挡住了，才谈得上「用量记录不会被一次删除抹掉」。
      const ownerLogin = await req(gwBase, 'POST', '/auth/login', {
        body: { email: 'owner@usage.test', password: 'test-owner-usage' },
      })
      assert(ownerLogin.status === 200, `owner 登录 ${ownerLogin.status} ${ownerLogin.text}`)
      const ownerTok = ownerLogin.json.token
      const del = await req(gwBase, 'DELETE', `/orgs/${orgId}`, { token: ownerTok })
      assert(del.status === 409, `有用量却删成了 ${del.status} ${del.text}`)
      assert(Number(del.json.llmCalls) > 0, `409 该带上 footprint 说明卡在哪，实际 ${del.text}`)
      const still = await req(gwBase, 'GET', `/orgs/${orgId}`, { token: ownerTok })
      assert(still.status === 200, `公司不该被删掉，实际 ${still.status}`)
      // 用量也确实还在
      const u2 = await readUsage()
      assert(u2.prompt === 2100, `删除被拒之后用量不该变，实际 ${u2.prompt}`)
    })

    await test('上游中途断流：已经收到的 token 仍要记上账', async () => {
      // 读流循环一度在 try/catch 外面：中途任何失败（120s 超时会连响应体一起中止）
      // 都会一路抛出去，updateLlmCallTokens 不执行，**这一次调用累计到的 token 全丢**。
      // 假上游只发 message_start（输入 900、输出 1）就掐断，账必须还在。
      const before = await readUsage()
      let failed = false
      try {
        await req(gwBase, 'POST', '/v1/messages', {
          token,
          body: {
            model: anthropicModel.id,
            stream: true,
            max_tokens: 64,
            messages: [{ role: 'user', content: '断给我看' }],
            e2e_die: true,
          },
        })
      } catch {
        // 断在半路，客户端侧报错也算正常——这条测的是账，不是转发。
        failed = true
      }
      void failed
      const after = await readUsage()
      assert(
        after.prompt === before.prompt + 900,
        `断流前 ${before.prompt}，断流后应为 ${before.prompt + 900}，实际 ${after.prompt}`,
      )
      assert(
        after.completion === before.completion + 1,
        `输出 token 应记到断流那一刻的 1，实际增量 ${after.completion - before.completion}`,
      )
    })

    await test('上游回一页 text/plain 的错误页、里面回显了密钥：转出去之前要抹掉', async () => {
      // 以前只按类型判流：`text/plain` 算流式，于是这种错误页走边收边转那一支，一个字节
      // 都不过 redact，平台的供应商密钥就原样交给了调用方。
      const r = await req(gwBase, 'POST', '/v1/messages', {
        token,
        body: {
          model: anthropicModel.id,
          stream: true,
          max_tokens: 64,
          messages: [{ role: 'user', content: '你好' }],
          e2e_echo: true,
        },
      })
      assert(r.status === 401, `上游的 401 应原样透出，实际 ${r.status} ${r.text.slice(0, 200)}`)
      assert(r.text.includes('invalid api key'), `错误页正文没转出来：${r.text.slice(0, 200)}`)
      assert(!r.text.includes('fake-anthropic-key'), `错误页里的供应商密钥没抹：${r.text.slice(0, 200)}`)
    })

    await test('客户端中途走了：Gateway 当场掐掉上游，已经花掉的输入 token 照记、状态记 failed', async () => {
      // 断开检测以前挂在 `req.on('close')` 上，而路由器早把请求体读完了——那个 close 在
      // 请求体读完那一刻就发过了，之后客户端怎么断都不会再响。于是上游被一直拉到最后
      // 一帧，写进一个没人读的 socket，钱照付。
      const before = await readUsage()
      const ac = new AbortController()
      const r = await fetch(`${gwBase}/v1/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: anthropicModel.id,
          stream: true,
          max_tokens: 64,
          messages: [{ role: 'user', content: '慢慢说' }],
          e2e_slow: true,
        }),
        signal: ac.signal,
      })
      assert(r.status === 200, `messages ${r.status}`)
      // 等到第一帧：上游确实在流了，再走。
      await r.body.getReader().read()
      ac.abort()

      const deadline = Date.now() + 5000
      while (!upstream.slow.closedAt && !upstream.slow.finished && Date.now() < deadline) {
        await new Promise((x) => setTimeout(x, 50))
      }
      assert(!upstream.slow.finished, '上游被一直拉到了最后一帧：客户端走了 Gateway 没停')
      assert(upstream.slow.closedAt > 0, '客户端走了五秒，Gateway 到上游的连接还开着')

      // 账：message_start 里那 900 个输入 token 是真发出去的，照记。落账在收尾之后，轮询等它。
      let after = before
      for (let i = 0; i < 30 && after.prompt === before.prompt; i++) after = await readUsage()
      assert(after.prompt === before.prompt + 900, `输入 tokens 应增加 900，实际增加 ${after.prompt - before.prompt}`)
      const charges = await req(gwBase, 'GET', `/orgs/${orgId}/charges?kind=llm&limit=1`, { token })
      assert(charges.status === 200, `charges ${charges.status} ${charges.text}`)
      const last = charges.json.charges[0]
      assert(last?.status === 'failed', `客户端中途走了应记 failed，实际 ${last?.status}`)
    })

    await test('删掉的员工留下的用量，要有「已离职员工」一行兜住', async () => {
      // 删员工时他的 llm_calls 按留档要求留着，于是公司总数里一直含着这笔，而
      // 「按成员」只列现有成员——不兜这一行，顶部总数就大于各行相加，差额没有出处。
      const made = await req(gwBase, 'POST', `/orgs/${orgId}/accounts`, {
        token,
        body: { email: 'leaver@usage.test', password: 'correct-horse-9', role: 'member' },
      })
      assert(made.status === 201, `建成员 ${made.status} ${made.text}`)
      const leaverId = made.json.account.id
      const leaverLogin = await req(gwBase, 'POST', '/auth/login', {
        body: { email: 'leaver@usage.test', password: 'correct-horse-9' },
      })
      assert(leaverLogin.status === 200, `成员登录 ${leaverLogin.status} ${leaverLogin.text}`)

      // 让这位成员自己烧一次 token
      const call = await req(gwBase, 'POST', '/v1/messages', {
        token: leaverLogin.json.token,
        body: {
          model: anthropicModel.id,
          stream: true,
          max_tokens: 64,
          messages: [{ role: 'user', content: '离职前的最后一次调用' }],
        },
      })
      assert(call.status === 200, `成员调用 ${call.status} ${call.text.slice(0, 200)}`)
      await new Promise((r) => setTimeout(r, 200))

      const del = await req(gwBase, 'DELETE', `/orgs/${orgId}/accounts/${leaverId}`, { token })
      assert(del.status === 200, `删成员 ${del.status} ${del.text}`)

      const usage = await req(gwBase, 'GET', `/orgs/${orgId}/usage`, { token })
      assert(usage.status === 200, `usage ${usage.status} ${usage.text}`)
      const stat = (label) => Number(usage.json.stats.find((x) => x.label === label).value)
      const total = stat('输入 Tokens') + stat('输出 Tokens')
      const rows = usage.json.byMember || []
      const summed = rows.reduce((n, m) => n + Number(m.tokens), 0)
      // 这条才是重点：加起来必须等于顶部那个数。
      assert(summed === total, `按成员相加 ${summed}，公司总数 ${total}，对不上`)
      const gone = rows.filter((m) => m.departed)
      assert(gone.length === 1, `该有且只有一行「已离职员工」，实际 ${gone.length}`)
      assert(Number(gone[0].tokens) > 0, '离职行的 token 不该是 0')
      assert(gone[0].count === 1, `离职人数应为 1，实际 ${gone[0].count}`)
    })
  } finally {
    gw.kill()
    await closeServer(upstream.server, '上游替身')
    try {
      rmSync(GW_HOME, { recursive: true, force: true })
    } catch {}
  }
}
