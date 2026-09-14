/**
 * 计费：缓存怎么计价、钱从哪个桶出、余额见底之后会怎样。
 *
 * 这一份走**真实路径**——假上游 + 真 `/v1/messages` + 真 `/runtime/web/search`，
 * 因为要验的正是「一次调用该收多少钱」，而那件事只在真跑一遍的时候才发生。
 * （e2e/stats.mjs 那份手工种数据，验的是聚合，不是计价。）
 *
 * 单价用**平台覆盖**钉死，不吃 pi-ai 内置目录：目录里的价随上游调价、随依赖升级
 * 而动，钉不住的数字写进断言就是一颗定时炸弹。顺带把覆盖表本身也验了。
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { freePort } from './ports.mjs'
import { closeServer } from './probe.mjs'

const SCHEMA = schemaOf('e2e_billing')
const MODEL = 'anthropic/claude-haiku-4-5'

/**
 * 单价（每 100 万 token 多少美元）。挑成整数，好手算：
 * 输入 $10、输出 $20、缓存读 $1（便宜十倍）、缓存写 $12.5（比输入还贵）。
 */
const RATE = { input: 10, output: 20, cacheRead: 1, cacheWrite: 12.5 }

/**
 * 假上游报的用量。**Anthropic 的 input_tokens 不含缓存那两项**，各自单列。
 *
 *   未命中 100k、缓存读 900k、缓存写 40k、输出 50k
 *   提示词合计 = 100k + 900k + 40k = 1,040k
 *
 * 对的算法：100k×10 + 900k×1 + 40k×12.5 + 50k×20
 *         = 1.00 + 0.90 + 0.50 + 1.00 = $3.40 = 3,400,000 微元
 * 全按输入价：1,040k×10 + 50k×20 = $11.40（差 3 倍多）
 */
const USAGE = { input_tokens: 100_000, output_tokens: 50_000, cache_read_input_tokens: 900_000, cache_creation_input_tokens: 40_000 }
const EXPECTED_MICROS = 3_400_000

function startFakeAnthropic() {
  const server = createServer(async (req, res) => {
    for await (const _ of req) void _
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'msg_e2e',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: USAGE,
      }),
    )
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }))
  })
}

export async function runBilling({ gwRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = tmpOf('satuwork-e2e-billing')
  const GW_PORT = await freePort()
  const base = `http://127.0.0.1:${GW_PORT}`

  rmSync(GW_HOME, { recursive: true, force: true })
  log('\n# billing')

  const upstream = await startFakeAnthropic()
  const gw = start('billing-gw', ['--import', 'tsx', join(gwRoot, 'src/index.ts')], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: SCHEMA,
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_SEED_OWNER: '0',
      ANTHROPIC_BASE_URL: upstream.url,
      ANTHROPIC_API_KEY: 'fake-anthropic-key',
      E2E_STUB_WEB: '1',
    },
  })
  await waitHttp(`${base}/health`, { child: gw, what: 'billing gateway' })

  const require = createRequire(`${gwRoot}/package.json`)
  const pg = require('pg')
  const client = new pg.Client({ connectionString: PG_URL })
  await client.connect()
  await client.query(`set search_path to ${SCHEMA}`)

  /** 账本行，最近的在前。计价断言全看它——`llm_calls` 那边只有 token。 */
  const charges = async (companyId) =>
    (
      await client.query(
        'select kind, subject, status, "amountMicros"::int as amount, "bonusMicros"::int as bonus, unpriced, quantity, "unitPrice", multiplier' +
          ' from usage_charges where "companyId" = $1 order by "createdAt" desc, id desc',
        [companyId],
      )
    ).rows

  /**
   * 一次模型调用。
   *
   * **落账在响应写完之后**——`/v1/messages` 是把上游的字节边收边转出去的，转完才知道
   * 用量、才谈得上计价。客户端这边 fetch 一 resolve 就去查库的话，多半查了个空。
   * 所以这里等账本上真的多出一行再返回。
   */
  const ask = async (token, companyId) => {
    const before = companyId ? (await charges(companyId)).length : 0
    const r = await req(base, 'POST', '/v1/messages', {
      token,
      body: { model: MODEL, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
    })
    if (companyId) await settled(companyId, before + 1)
    return r
  }

  /** 跑一次回填脚本，把退出码和全部输出都拿回来——错误界面本身就是要验的东西。 */
  const spawnScript = (env) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [`${gwRoot}/scripts/backfill-charges.mjs`], {
        env: { ...process.env, GATEWAY_DATABASE_URL: PG_URL, GATEWAY_PG_SCHEMA: SCHEMA, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (out += d))
      child.on('exit', (code) => resolve({ code, out }))
    })

  /** 跑成功的那条路：非 0 退出直接抛，省得每处都判一遍。 */
  const backfill = async () => {
    const r = await spawnScript({})
    if (r.code !== 0) throw new Error(`回填脚本退出 ${r.code}：${r.out}`)
    return r.out
  }

  /** 等账本长到 want 行。等不到就让断言自己去报差在哪，别在这儿吞掉。 */
  const settled = async (companyId, want) => {
    for (let i = 0; i < 60; i++) {
      if ((await charges(companyId)).length >= want) return
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  try {
    let owner = ''
    let orgA = ''
    let tokenA = ''
    let seatA = ''
    let orgB = ''
    let tokenB = ''

    await test('种数据：两家公司，A 有赠送 + 充值，B 只有一分钱', async () => {
      const setup = await req(base, 'POST', '/auth/setup', {
        body: { email: 'o@bill.test', name: 'o', password: 'correct-horse-1' },
      })
      assert(setup.status === 201, `setup ${setup.status} ${setup.text}`)
      owner = setup.json.token

      // 单价钉死在覆盖表上，顺带验一遍覆盖表本身走得通。
      const put = await req(base, 'PUT', '/platform/settings', { token: owner, body: { modelPricing: { [MODEL]: RATE } } })
      assert(put.status === 200, `settings ${put.status} ${put.text}`)
      assert(put.json.modelPricing[MODEL].cacheWrite === 12.5, `覆盖没存住：${put.text}`)

      const mkOrg = async (slug, email) => {
        const r = await req(base, 'POST', '/platform/orgs', {
          token: owner,
          body: {
            name: slug, slug,
            contactName: '张三', contactPhone: '+86 138 0000 0000', contactEmail: email,
            adminEmail: email, adminPassword: 'correct-horse-1',
          },
        })
        assert(r.status === 201, `org ${r.status} ${r.text}`)
        const login = await req(base, 'POST', '/auth/login', { body: { email, password: 'correct-horse-1' } })
        return { id: r.json.company.id, token: login.json.token }
      }
      const a = await mkOrg('bill-a', 'a@bill.test')
      orgA = a.id
      tokenA = a.token
      const b = await mkOrg('bill-b', 'b@bill.test')
      orgB = b.id
      tokenB = b.token

      // A：套餐赠送 $2（跟着账期）+ 充值 $50（不过期）。充值给得宽裕些——这一份里
      // A 是「有钱的那家」，它的作用是当对照组，不该在中途自己烧穿。
      const sku = await req(base, 'POST', '/platform/plans', {
        token: owner,
        body: { name: '测试包', nameEn: 'Test', amount: 100, seats: 5, period: 'month', bonusTokens: 2 },
      })
      assert(sku.status === 201, `sku ${sku.status} ${sku.text}`)
      const plan = await req(base, 'POST', '/platform/orders', {
        token: owner,
        body: { companyId: orgA, planId: sku.json.plan.id, payStatus: 'paid' },
      })
      assert(plan.status === 201, `plan order ${plan.status} ${plan.text}`)
      const top = await req(base, 'POST', '/platform/orders', {
        token: owner,
        body: { companyId: orgA, kind: 'topup', amount: 50, payStatus: 'paid', note: 'e2e' },
      })
      assert(top.status === 201, `topup ${top.status} ${top.text}`)

      // B：一分钱。够放行一次（熔断是「拒绝下一次」，不是预扣），不够第二次。
      const tiny = await req(base, 'POST', '/platform/orders', {
        token: owner,
        body: { companyId: orgB, kind: 'topup', amount: 0.01, payStatus: 'paid', note: 'tiny' },
      })
      assert(tiny.status === 201, `tiny topup ${tiny.status} ${tiny.text}`)

      const secrets = await client.query(
        `select s."accessToken" from account_secrets s join accounts a on a.id = s."accountId" where a.email = 'a@bill.test'`,
      )
      seatA = secrets.rows[0].accessToken
    })

    await test('缓存那三截各按各的单价算，不是整个提示词按输入价', async () => {
      const r = await ask(tokenA, orgA)
      assert(r.status === 200, `messages ${r.status} ${r.text.slice(0, 200)}`)
      const rows = await charges(orgA)
      assert(rows.length === 1, `账本 ${rows.length} 行`)
      const c = rows[0]
      assert(c.kind === 'llm' && c.subject === MODEL, JSON.stringify(c))
      assert(
        c.amount === EXPECTED_MICROS,
        `金额 ${c.amount} 微元，应当是 ${EXPECTED_MICROS}（整个提示词按输入价算会得到 11400000）`,
      )
      // 计量和单价都要留在行上——「为什么收这么多」全靠这两列复核。
      assert(c.quantity.promptTokens === 1_040_000, `提示词 ${c.quantity.promptTokens}，缓存那两截没加进去`)
      assert(c.quantity.cachedTokens === 900_000, `缓存读 ${c.quantity.cachedTokens}`)
      assert(c.quantity.cacheWriteTokens === 40_000, `缓存写 ${c.quantity.cacheWriteTokens}`)
      assert(c.unitPrice.cacheRead === 1 && c.unitPrice.cacheWrite === 12.5, `单价快照 ${JSON.stringify(c.unitPrice)}`)
    })

    await test('llm_calls 也记下缓存写那一截', async () => {
      const rows = (await client.query('select "promptTokens"::int p, "cachedTokens"::int r, "cacheWriteTokens"::int w from llm_calls')).rows
      assert(rows.length === 1, `llm_calls ${rows.length} 行`)
      assert(rows[0].p === 1_040_000 && rows[0].r === 900_000 && rows[0].w === 40_000, JSON.stringify(rows[0]))
    })

    await test('先扣套餐赠送，再扣充值', async () => {
      // 这一笔 $3.40：赠送只有 $2，剩下的 $1.40 走充值。
      const rows = await charges(orgA)
      assert(rows[0].bonus === 2_000_000, `赠送承担 ${rows[0].bonus} 微元，应当是 2000000`)
      assert(rows[0].amount - rows[0].bonus === 1_400_000, `充值承担 ${rows[0].amount - rows[0].bonus}`)
      const bill = await req(base, 'GET', `/orgs/${orgA}/billing`, { token: tokenA })
      assert(bill.status === 200, `billing ${bill.status} ${bill.text}`)
      // 赠送已经吃光，充值还剩 $50 − $1.40 = $48.60。
      assert(bill.json.balance.planBonusLeft === '$0.00', `赠送余额 ${bill.json.balance.planBonusLeft}`)
      assert(bill.json.balance.topupLeft === '$48.60', `充值余额 ${bill.json.balance.topupLeft}`)
      assert(bill.json.balance.spentThisPeriod === '$3.40', `本期已扣 ${bill.json.balance.spentThisPeriod}`)
    })

    await test('只填一项的单价覆盖：其余几项仍然用目录价，不会被清零', async () => {
      /**
       * 这条盯的是一个安静的漏钱路径。改价弹层的四个框默认留空（故意不预填目录价），
       * 于是「只想修缓存读单价」是最自然的用法。覆盖曾经是**整份顶掉**的：那样一存，
       * input/output 变成 0，这个模型从此按 $0 计费，而且 unpriced 是 false——
       * 所有「金额不完整」的提示都不会响，界面上只是那一行的单价画成了「—」。
       */
      const models = await req(base, 'GET', '/v1/models', { token: tokenA })
      assert(models.status === 200, `models ${models.status}`)
      const catalog = models.json.data.find((m) => m.id === MODEL)?.cost || {}
      assert(Number(catalog.input) > 0 && Number(catalog.output) > 0, `目录里没有 ${MODEL} 的价，这条验不了：${JSON.stringify(catalog)}`)

      const put = await req(base, 'PUT', '/platform/settings', {
        token: owner,
        body: { modelPricing: { [MODEL]: { cacheRead: 0.5 } } },
      })
      assert(put.status === 200, `settings ${put.status} ${put.text}`)

      const r = await ask(tokenA, orgA)
      assert(r.status === 200, `messages ${r.status} ${r.text.slice(0, 200)}`)
      const c = (await charges(orgA))[0]
      assert(c.unitPrice.cacheRead === 0.5, `覆盖那一项没生效：${JSON.stringify(c.unitPrice)}`)
      assert(
        c.unitPrice.input === Number(catalog.input) && c.unitPrice.output === Number(catalog.output),
        `没填的那几项被清零了：${JSON.stringify(c.unitPrice)}，目录是 ${JSON.stringify(catalog)}`,
      )
      assert(c.amount > 0 && c.unpriced === false, `按 $0 收还不报警：${JSON.stringify(c)}`)

      // 目录里也没有缓存写价时回落到 input，回落链是「覆盖 → 目录 → input」。
      assert(
        c.unitPrice.cacheWrite === Number(catalog.cacheWrite) || c.unitPrice.cacheWrite === Number(catalog.input),
        `缓存写没按回落链走：${JSON.stringify(c.unitPrice)}`,
      )
      await req(base, 'PUT', '/platform/settings', { token: owner, body: { modelPricing: { [MODEL]: RATE } } })
    })

    await test('查不到单价的模型按兜底价收，不按 $0 收', async () => {
      /**
       * 这条盯的是一条**安静漏钱**的路：目录里没收录价格的模型（pi-ai 对 zai 那批一律
       * 填 0），单价查不到，于是金额记 0 + `unpriced`。那个 0 的本意是「算不出来」，
       * 可它在账单上和「免费」长得一模一样——月底真扣的钱就少了那一截，而少掉的那截
       * 没有任何一屏对得出来。兜底价（platformSettings.defaultModelRate）就是来接这一批的。
       *
       * 三件事一起钉：没设兜底时照旧记 unpriced（不能凭空开始收钱）；设上之后这批模型
       * 按兜底价收、`unpriced` 转 false；**已经有价的模型一分钱都不受影响**——兜底是压在
       * 目录价下面的第三层，不是盖在上面（docs/billing.md §3.3）。
       */
      const created = await req(base, 'POST', '/platform/providers', {
        token: owner,
        body: {
          id: 'noprice-llm', name: 'No Price LLM', baseUrl: upstream.url, api: 'anthropic-messages',
          // **不给 cost**：这就是「目录里查不到单价」的那一批。
          models: [{ id: 'noprice-model', name: 'No Price Model', contextWindow: 65536, maxTokens: 4096, reasoning: false, input: ['text'] }],
        },
      })
      assert(created.status === 201, `建供应商 ${created.status} ${created.text}`)
      const cred = await req(base, 'POST', '/platform/credentials', { token: owner, body: { provider: 'noprice-llm', secret: 'noprice-key' } })
      assert(cred.status === 201, `配密钥 ${cred.status} ${cred.text}`)

      const askNoPrice = async () => {
        const before = (await charges(orgA)).length
        const r = await req(base, 'POST', '/v1/messages', {
          token: tokenA,
          body: { model: 'noprice-llm/noprice-model', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
        })
        assert(r.status === 200, `messages ${r.status} ${r.text.slice(0, 200)}`)
        await settled(orgA, before + 1)
        return (await charges(orgA))[0]
      }

      // 一、没设兜底：照旧记 0 + unpriced。这一格不能因为加了兜底就自己变了。
      const zero = await askNoPrice()
      assert(zero.amount === 0 && zero.unpriced === true, `没设兜底时该记 unpriced：${JSON.stringify(zero)}`)

      // 二、设上兜底：同一个模型、同一份用量，收的钱和拿 RATE 当单价一模一样。
      const put = await req(base, 'PUT', '/platform/settings', { token: owner, body: { defaultModelRate: RATE } })
      assert(put.status === 200, `settings ${put.status} ${put.text}`)
      assert(put.json.defaultModelRate?.input === RATE.input, `兜底没存住：${put.text}`)
      const paid = await askNoPrice()
      assert(paid.unpriced === false, `按兜底收了就不该再标 unpriced：${JSON.stringify(paid)}`)
      assert(paid.amount === EXPECTED_MICROS, `兜底价算出来是 ${paid.amount} 微元，应当是 ${EXPECTED_MICROS}`)
      assert(paid.unitPrice.input === RATE.input && paid.unitPrice.cacheWrite === RATE.cacheWrite, `快照里不是兜底价：${JSON.stringify(paid.unitPrice)}`)

      // 三、**已经有价的模型不受影响**：兜底压在目录价下面，不是盖在上面。
      const priced = (await (async () => {
        const r = await ask(tokenA, orgA)
        assert(r.status === 200, `messages ${r.status} ${r.text.slice(0, 200)}`)
        return (await charges(orgA))[0]
      })())
      assert(priced.subject === MODEL, `拿错行了：${JSON.stringify(priced)}`)
      assert(priced.amount === EXPECTED_MICROS, `有覆盖价的模型被兜底改了价：${priced.amount}`)

      // 四、撤掉兜底（四项全 0），行为退回第一步——「不兜底」得是个撤得掉的开关。
      const off = await req(base, 'PUT', '/platform/settings', {
        token: owner,
        body: { defaultModelRate: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      })
      assert(off.status === 200, `撤兜底 ${off.status} ${off.text}`)
      const again = await askNoPrice()
      assert(again.amount === 0 && again.unpriced === true, `撤掉兜底之后该退回 unpriced：${JSON.stringify(again)}`)
    })

    await test('改倍率不追溯改动已经落账的金额', async () => {
      // 快照**所有**已经落账的行，不是只看最新那一条：改价不追溯是对整段历史的承诺。
      const rows = await charges(orgA)
      const before = new Map(rows.map((r) => [`${r.subject}|${r.amount}|${r.multiplier}`, r]))
      /**
       * 行数拿的是**数组长度**，不是那张 Map 的 size：两行「同一个模型、同样的金额、
       * 同样的倍率」是完全正常的（同一个模型连调两次就是），它们在 Map 里只占一格。
       * 拿 size 当行数的话，凡是出现过重复的那一刻这条用例就红，而红的原因和改价无关。
       */
      const beforeCount = rows.length
      const put = await req(base, 'PUT', '/platform/settings', { token: owner, body: { priceMultiplier: 2 } })
      assert(put.status === 200, `settings ${put.status} ${put.text}`)
      const after = await charges(orgA)
      assert(after.length === beforeCount, `行数变了：${beforeCount} → ${after.length}`)
      for (const r of after) {
        assert(before.has(`${r.subject}|${r.amount}|${r.multiplier}`), `这一行被改价动过：${JSON.stringify(r)}`)
      }
      // 新的一次按新倍率收，且倍率跟着行走。
      const r = await ask(tokenA, orgA)
      assert(r.status === 200, `messages ${r.status} ${r.text.slice(0, 200)}`)
      const fresh = (await charges(orgA))[0]
      assert(fresh.amount === EXPECTED_MICROS * 2, `新价没生效：${fresh.amount}`)
      assert(Number(fresh.multiplier) === 2, `倍率没落在行上：${fresh.multiplier}`)
      await req(base, 'PUT', '/platform/settings', { token: owner, body: { priceMultiplier: 1 } })
    })

    await test('倍率 1.2 存进去读回来还是 1.2，不是 1.2000000476837158', async () => {
      // 账本那一列原来是 real（float4），存不下 1.2；而这个值会原样画到计费明细上。
      // 迁移 0009 换成了 double precision。上一条用的是 2——float4 里恰好精确，测不出来。
      await req(base, 'PUT', '/platform/settings', { token: owner, body: { priceMultiplier: 1.2 } })
      const r = await ask(tokenA, orgA)
      assert(r.status === 200, `messages ${r.status} ${r.text.slice(0, 200)}`)
      const c = (await charges(orgA))[0]
      assert(Number(c.multiplier) === 1.2, `倍率读回来是 ${c.multiplier}`)
      assert(c.amount === Math.round(EXPECTED_MICROS * 1.2), `金额 ${c.amount}`)
      await req(base, 'PUT', '/platform/settings', { token: owner, body: { priceMultiplier: 1 } })
    })

    await test('余额见底：先放行一次（不预扣），下一次 402 并落一行 denied', async () => {
      const first = await ask(tokenB, orgB)
      assert(first.status === 200, `第一次该放行（熔断不是预扣）：${first.status} ${first.text.slice(0, 200)}`)
      const second = await ask(tokenB, orgB)
      assert(second.status === 402, `余额光了还能调：${second.status}`)
      assert(String(second.json.error).includes('额度'), `文案要是一句人话：${second.text}`)
      const rows = await charges(orgB)
      assert(rows[0].status === 'denied' && rows[0].amount === 0, `被拒那行 ${JSON.stringify(rows[0])}`)
      assert(rows.length === 2, `账本 ${rows.length} 行：放行那次和被拒那次都要在`)
    })

    await test('熔断是全局的：同一家公司的网页搜索也一起停', async () => {
      const cred = await req(base, 'POST', '/platform/credentials', { token: owner, body: { provider: 'tavily', secret: 'stub' } })
      assert(cred.status === 201, `tavily 密钥 ${cred.status} ${cred.text}`)
      const web = await req(base, 'PUT', '/platform/tools/web', {
        token: owner,
        body: { searchBackend: 'tavily', pricing: { tavily: { search: 8, extract: 8 } } },
      })
      assert(web.status === 200, `web 配置 ${web.status} ${web.text}`)

      const secrets = await client.query(
        `select s."accessToken" from account_secrets s join accounts a on a.id = s."accountId" where a.email = 'b@bill.test'`,
      )
      const seatB = secrets.rows[0].accessToken
      const r = await req(base, 'POST', '/runtime/web/search', { token: seatB, body: { query: 'anything' } })
      // 业务失败，不是 4xx：席位那头要把这句话原样交给模型。
      assert(r.status === 200, `状态 ${r.status}，业务失败不该是 4xx`)
      assert(r.json.ok === false && String(r.json.error).includes('额度'), `没被熔断挡下：${r.text}`)

      // A 家还有钱，同一时刻照常能搜——熔断是按公司的，不是全平台。
      const beforeA = (await charges(orgA)).length
      const ok = await req(base, 'POST', '/runtime/web/search', { token: seatA, body: { query: 'node 24' } })
      assert(ok.json.ok === true, `有余额的公司被误伤：${ok.text}`)
      await settled(orgA, beforeA + 1)
      const rows = await charges(orgA)
      assert(rows[0].kind === 'web' && rows[0].subject === 'tavily:search', JSON.stringify(rows[0]))
      // 8 厘 × 1 次 × 倍率 1 = 8000 微元。
      assert(rows[0].amount === 8000, `网页那笔 ${rows[0].amount} 微元`)
    })

    await test('充一笔钱，当场恢复——不用等缓存过期', async () => {
      const top = await req(base, 'POST', '/platform/orders', {
        token: owner,
        body: { companyId: orgB, kind: 'topup', amount: 20, payStatus: 'paid', note: 'rescue' },
      })
      assert(top.status === 201, `topup ${top.status} ${top.text}`)
      const r = await ask(tokenB, orgB)
      assert(r.status === 200, `充完还被拦着：${r.status} ${r.text.slice(0, 200)}`)
    })

    await test('单价为 0 的调用不熔断——拦住一个不花钱的调用保护不了任何人', async () => {
      await req(base, 'PUT', '/platform/settings', { token: owner, body: { modelPricing: {} } })
      // 把 B 的钱烧光：现在没有覆盖单价了，走目录价。先确认它确实还在计费……
      const cleared = await req(base, 'GET', '/platform/settings', { token: owner })
      assert(Object.keys(cleared.json.modelPricing || {}).length === 0, `覆盖没撤掉：${cleared.text}`)
      // ……再把单价改成 0（四项全 0 = 撤掉覆盖，所以这里改的是网页那一档，形状更简单）。
      await req(base, 'PUT', '/platform/tools/web', { token: owner, body: { pricing: { tavily: { search: 0, extract: 0 } } } })
      const secrets = await client.query(
        `select s."accessToken" from account_secrets s join accounts a on a.id = s."accountId" where a.email = 'b@bill.test'`,
      )
      const seatB = secrets.rows[0].accessToken
      // 先把 B 的余额清成负的：直接落一行大额账，比反复调用快。
      await client.query(
        'insert into usage_charges (id, "companyId", "accountId", kind, subject, status, quantity, "unitPrice", multiplier, "amountMicros", "bonusMicros", unpriced, "createdAt")' +
          " values ('drain', $1, (select id from accounts where email = 'b@bill.test'), 'llm', 'x/y', 'ok', '{}', '{}', 1, 999000000, 0, false, $2)",
        [orgB, Date.now()],
      )
      const r = await req(base, 'POST', '/runtime/web/search', { token: seatB, body: { query: 'free' } })
      assert(r.json.ok === true, `不收钱的调用被熔断挡了：${r.text}`)
      await req(base, 'PUT', '/platform/tools/web', { token: owner, body: { pricing: { tavily: { search: 8, extract: 8 } } } })
    })

    await test('提取的余额闸也看 document 那一档，不只看提取后端', async () => {
      /**
       * 「提取后端不收钱、自取文档收钱」是个完全合理的组合（HTML 自己抓、PDF 费带宽）。
       * 闸只问提取后端的话，那种配置下余额归零的公司能一直抓 PDF 往负数走——
       * 熔断在这条路上永远不触发。
       */
      await req(base, 'PUT', '/platform/tools/web', {
        token: owner,
        body: { extractBackend: 'tavily', pricing: { tavily: { search: 8, extract: 0 }, document: { search: 0, extract: 20 } } },
      })
      const secrets = await client.query(
        `select s."accessToken" from account_secrets s join accounts a on a.id = s."accountId" where a.email = 'b@bill.test'`,
      )
      const seatB = secrets.rows[0].accessToken
      // B 的余额早就是负的（上面那条把它抽干了）。
      const r = await req(base, 'POST', '/runtime/web/extract', { token: seatB, body: { urls: ['https://a.test/paper.pdf'] } })
      assert(r.status === 200, `状态 ${r.status}`)
      assert(r.json.ok === false && String(r.json.error).includes('额度'), `document 那一档收钱却没被熔断挡下：${r.text}`)
      await req(base, 'PUT', '/platform/tools/web', {
        token: owner,
        body: { pricing: { tavily: { search: 8, extract: 8 }, document: { search: 0, extract: 0 } } },
      })
    })

    await test('影子计费：关掉 enforce 之后照记不拦', async () => {
      const put = await req(base, 'PUT', '/platform/settings', { token: owner, body: { billing: { enforce: false } } })
      assert(put.status === 200, `settings ${put.status} ${put.text}`)
      assert(put.json.billing.enforce === false, `开关没存住：${put.text}`)
      const secrets = await client.query(
        `select s."accessToken" from account_secrets s join accounts a on a.id = s."accountId" where a.email = 'b@bill.test'`,
      )
      const before = (await charges(orgB)).length
      const r = await req(base, 'POST', '/runtime/web/search', { token: secrets.rows[0].accessToken, body: { query: 'shadow' } })
      assert(r.json.ok === true, `enforce 关着还拦：${r.text}`)
      await settled(orgB, before + 1)
      assert((await charges(orgB)).length === before + 1, '影子计费该照记不误')
      await req(base, 'PUT', '/platform/settings', { token: owner, body: { billing: { enforce: true } } })
    })

    await test('计费明细：翻页不重不漏，公司只看得见自己家', async () => {
      const seen = new Set()
      let cursor = ''
      let pages = 0
      let budget = null
      while (pages < 30) {
        const r = await req(base, 'GET', `/orgs/${orgA}/charges?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, {
          token: tokenA,
        })
        assert(r.status === 200, `charges ${r.status} ${r.text}`)
        budget = r.json.budget
        for (const row of r.json.charges) {
          assert(!seen.has(row.id), `翻页重了：${row.id}`)
          seen.add(row.id)
          assert(row.companyId === orgA, `看到了别家的账：${row.companyId}`)
        }
        pages += 1
        if (!r.json.hasMore) break
        cursor = r.json.nextCursor
      }
      const total = (await charges(orgA)).length
      assert(seen.size === total, `翻页拿到 ${seen.size} 行，库里有 ${total} 行`)
      assert(pages > 1, '这些行应该不止一页')
      assert(budget && typeof budget.left === 'number', `没带余额：${JSON.stringify(budget)}`)
    })

    await test('按类型筛选；员工只看得见自己的', async () => {
      const web = await req(base, 'GET', `/orgs/${orgA}/charges?kind=web`, { token: tokenA })
      assert(web.status === 200 && web.json.charges.every((c) => c.kind === 'web'), `筛选没生效：${web.text}`)
      const bad = await req(base, 'GET', `/orgs/${orgA}/charges?kind=nope`, { token: tokenA })
      assert(bad.status === 400, `坏 kind ${bad.status}`)
      const mine = await req(base, 'GET', '/me/charges', { token: tokenA })
      assert(mine.status === 200, `me ${mine.status} ${mine.text}`)
      assert(mine.json.charges.every((c) => c.accountId === mine.json.charges[0].accountId), '看到了别人的账')
      const cross = await req(base, 'GET', `/orgs/${orgB}/charges`, { token: tokenA })
      assert(cross.status === 403 || cross.status === 404, `跨公司拿到了 ${cross.status}`)
    })

    await test('回填脚本：老行的钱翻成账本行，跑两遍不会翻倍', async () => {
      /**
       * 这一条盯的是**只会跑一次、而且是对着生产库跑**的那段代码。
       *
       * 造两条「老行」：钱还在领域表自己的列上，账本上没有对应的行——正是升级前
       * 那些行的样子。web_calls 记的是**厘**，账本是微元，×1000 是这套里唯一要换算
       * 的地方，最容易在真正跑的时候才发现搞反了。
       */
      const accountId = (await client.query(`select id from accounts where email = 'a@bill.test'`)).rows[0].id
      const at = Date.now() - 86400000
      await client.query(
        'insert into connector_calls (id, "companyId", "accountId", vendor, connector, label, tool, status, "amountMicros", "bonusMicros", "latencyMs", "createdAt")' +
          " values ('legacy-conn', $1, $2, 'composio', 'gmail', 'default', 'GMAIL_SEND_EMAIL', 'ok', 500000, 200000, 12, $3)",
        [orgA, accountId, at],
      )
      await client.query(
        'insert into web_calls (id, "accountId", "companyId", kind, backend, units, mils, "createdAt")' +
          " values ('legacy-web', $1, $2, 'extract', 'tavily', 4, 38, $3)",
        [accountId, orgA, at],
      )


      const first = await backfill()
      assert(first.includes('连接器 1 行'), `第一遍没认出那条连接器老行：${first}`)
      assert(first.includes('网页工具 1 行'), `第一遍没认出那条网页老行：${first}`)

      const rows = await charges(orgA)
      const conn = rows.find((r) => r.subject === 'gmail:GMAIL_SEND_EMAIL')
      assert(conn && conn.amount === 500000 && conn.bonus === 200000, `连接器老行没原样搬过来：${JSON.stringify(conn)}`)
      const web = rows.find((r) => r.quantity?.units === 4 && r.kind === 'web')
      // 38 厘 = 38000 微元。**这一步搞反了就是整整一千倍的账。**
      assert(web && web.amount === 38000, `厘没换成微元：${JSON.stringify(web)}`)

      // 再跑一遍：已经有账本行的老行要被跳过，不能翻倍。
      const before = (await charges(orgA)).length
      const second = await backfill()
      assert(second.includes('连接器 0 行') && second.includes('网页工具 0 行'), `第二遍又插了一遍：${second}`)
      assert((await charges(orgA)).length === before, '重复跑把账翻倍了')
    })

    await test('回填脚本撞上没升级的库：给一句人话和退出码，不是 pg 的堆栈', async () => {
      /**
       * 「先起进程跑迁移，再回填」这个顺序最容易搞反，而搞反的那一刻脚本会撞上一张
       * 不存在的表。默认行为是把 pg 的原始错误对象打出来——那堆栈里一个字都没说
       * 该干什么。这条钉住的是**错误界面**，不是查询本身。
       */
      const missing = await spawnScript({ GATEWAY_PG_SCHEMA: schemaOf('e2e_billing_not_migrated') })
      assert(missing.code === 1, `退出码 ${missing.code}`)
      assert(!missing.out.includes('at process.processTicksAndRejections'), `甩了堆栈出来：${missing.out}`)
      assert(missing.out.includes('schema'), `没说清是哪儿的问题：${missing.out}`)

      const unreachable = await spawnScript({ GATEWAY_DATABASE_URL: 'postgres://x:x@127.0.0.1:5999/x' })
      assert(unreachable.code === 1, `连不上时退出码 ${unreachable.code}`)
      assert(unreachable.out.includes('连不上数据库'), `连不上时没说人话：${unreachable.out}`)
      // 连接串里有口令，报错时**不能原样回显**。
      assert(!unreachable.out.includes('x:x@'), `把口令打出来了：${unreachable.out}`)
    })

    await test('用量屏那几块维度都填得上：日线、按类型、按模型', async () => {
      /**
       * 这四块以前是写死的空数组，界面上四块永远写着「还没有用量」，而同一屏底下的
       * 计费明细一屏都是——两个说法互相打脸。现在都从已有的两张表来：次数和 token 在
       * `llm_calls`，钱在账本，和平台那一屏同一个口径。
       */
      const to = Date.now()
      const from = to - 6 * 86400000
      const q = `from=${from}&to=${to}&tz=480`
      const r = await req(base, 'GET', `/orgs/${orgA}/usage?${q}`, { token: tokenA })
      assert(r.status === 200, `usage ${r.status} ${r.text}`)

      // 日线：窗口里**每天一根**，包括一次调用都没有的那几天——只画有数的那几天，
      // 横轴会被悄悄压缩，「周末没人用」和「天天在用」就长得一样了。
      assert(r.json.daily.length === 7, `日线该是 7 根，实际 ${r.json.daily.length}`)
      assert(r.json.daily.every((d) => /^\d{2}\/\d{2}$/.test(d.label)), `日期格式不对：${JSON.stringify(r.json.daily[0])}`)
      assert(r.json.daily.reduce((n, d) => n + d.value, 0) > 0, '这家公司这几天有调用，日线却全是 0')

      // 按类型：钱就是从这三处出去的，这一维要盖得全。
      const kinds = r.json.byKind.map((x) => x.name)
      assert(kinds.includes('模型'), `按类型里没有模型：${JSON.stringify(r.json.byKind)}`)
      assert(kinds.includes('网页'), `按类型里没有网页：${JSON.stringify(r.json.byKind)}`)
      assert(r.json.byKind.every((x) => x.value.includes('次') && x.value.includes('$')), `按类型缺次数或金额：${JSON.stringify(r.json.byKind)}`)

      assert(r.json.byModel.length > 0, '按模型是空的')
      assert(r.json.byModel[0].name.includes('/'), `按模型的名字该是 provider/model：${r.json.byModel[0].name}`)
      assert(r.json.byModel[0].value.includes('token'), `按模型缺 token：${r.json.byModel[0].value}`)
      assert(r.json.byModel[0].pct === 100, `占比该以最大的那条为 100，实际 ${r.json.byModel[0].pct}`)
      // 套餐额度**仍然是空的**：当前套餐只约束席位，编一个分母出来会被当成真在生效。
      assert(Array.isArray(r.json.quota) && r.json.quota.length === 0, 'quota 不该凭空冒出来')

      // 员工自己那一屏走的是同一套维度，只是范围小一圈。
      const me = await req(base, 'GET', `/me/stats?${q}`, { token: tokenA })
      assert(me.status === 200, `me/stats ${me.status} ${me.text}`)
      assert(me.json.daily.length === 7, `自己那屏的日线 ${me.json.daily.length} 根`)
      assert(Array.isArray(me.json.byKind) && Array.isArray(me.json.byModel), '自己那屏缺维度')

      // tz 只影响切天，坏值不许把日线整体推走，更不许 500。
      const bad = await req(base, 'GET', `/orgs/${orgA}/usage?from=${from}&to=${to}&tz=不知道`, { token: tokenA })
      assert(bad.status === 400, `坏 tz ${bad.status}`)
      const wild = await req(base, 'GET', `/orgs/${orgA}/usage?from=${from}&to=${to}&tz=99999`, { token: tokenA })
      assert(wild.status === 200 && wild.json.daily.length === 7, `离谱的 tz 把日线弄坏了：${wild.status} ${wild.json.daily?.length}`)
    })

    await test('单价和倍率只下发给平台：公司侧连字段都没有', async () => {
      /**
       * 单价 + 倍率 = 我们的成本价和加价率。只在界面上不画的话，翻开 devtools 就都在，
       * 所以这一刀切在**响应里**：非 owner 拿到的行上根本没有这两个键。
       * 计量和金额照给——那是客户自己的消耗和真扣掉的钱。
       *
       * **这一条只管账本行**（`/orgs/:id/charges`、`/me/charges`）。定价还有第二条出口：
       * `publicSettings()` 拼的那份 settings，走 `GET /me` 和 `GET /orgs/:id/settings`。
       * 那条由下一条用例盯着——两条路各切一刀，少哪一刀都等于没切。
       */
      const mine = await req(base, 'GET', `/orgs/${orgA}/charges?limit=5`, { token: tokenA })
      assert(mine.status === 200, `charges ${mine.status} ${mine.text}`)
      const row = mine.json.charges[0]
      assert(row, '这家公司应当已经有账了')
      assert(!('unitPrice' in row) && !('multiplier' in row), `公司管理员看到了定价：${JSON.stringify(row)}`)
      // 整个响应体里都不许出现，防止哪天有人塞个 null 回去。
      assert(!mine.text.includes('"unitPrice"') && !mine.text.includes('"multiplier"'), '响应体里还带着定价字段')
      assert(row.quantity !== undefined, '计量不该跟着一起藏掉')
      assert(typeof row.amountMicros === 'number', '金额不该跟着一起藏掉')

      const me = await req(base, 'GET', '/me/charges', { token: tokenA })
      assert(me.status === 200, `me ${me.status} ${me.text}`)
      assert(!me.text.includes('"unitPrice"') && !me.text.includes('"multiplier"'), '自己那份里还带着定价字段')

      // 平台自己照给：这一列的意义就是让人乘一遍对得上金额。
      const plat = await req(base, 'GET', '/platform/charges?limit=5', { token: owner })
      const p0 = plat.json.charges[0]
      assert(p0 && p0.unitPrice && typeof p0.multiplier === 'number', `平台侧丢了定价：${JSON.stringify(p0)}`)
      // owner 在公司详情页上看的是同一条 /orgs/:id/charges，他那份要带着。
      const asOwner = await req(base, 'GET', `/orgs/${orgA}/charges?limit=5`, { token: owner })
      const o0 = asOwner.json.charges[0]
      assert(o0 && o0.unitPrice && typeof o0.multiplier === 'number', `owner 看公司详情时丢了定价：${JSON.stringify(o0)}`)
    })

    await test('定价不下发给公司侧：/me 和 /orgs/:id/settings 里也没有', async () => {
      /**
       * 上面那条切的是**账本行**。定价还有第二条出口：`publicSettings()` 拼出来的那份
       * settings——`GET /me` 对任何账号都带着它，`GET /orgs/:id/settings` 是 requireOrgUser。
       * 界面上不画它没有用，翻开 devtools 就是平台的覆盖价、倍率、连接器单价。
       * 所以这一刀也切在响应里：公司侧那份只有模型角色（画角色面板要用），定价一项不给。
       */
      const SECRET_KEYS = ['priceMultiplier', 'modelPricing', 'connectorPricing', 'billing', 'managerVersion']
      const clean = (text, who) => {
        for (const k of SECRET_KEYS) assert(!text.includes(`"${k}"`), `${who} 拿到了 ${k}：${text}`)
      }

      const me = await req(base, 'GET', '/me', { token: tokenA })
      assert(me.status === 200, `me ${me.status} ${me.text}`)
      assert(me.json.settings, '/me 该带 settings')
      clean(JSON.stringify(me.json.settings), '公司管理员的 /me')
      // 模型角色照给：前端拿 settings 主要就是为了画这几样。
      assert(me.json.settings.daily && me.json.settings.utility, '模型角色不该跟着一起藏掉')
      assert(Array.isArray(me.json.settings.enabledModels), 'enabledModels 不该跟着一起藏掉')

      // 席位票也走 /me。它比管理员更不该看到定价。
      const seat = await req(base, 'GET', '/me', { token: seatA })
      if (seat.status === 200) clean(JSON.stringify(seat.json.settings || {}), '席位的 /me')

      const org = await req(base, 'GET', `/orgs/${orgA}/settings`, { token: tokenA })
      assert(org.status === 200, `org settings ${org.status} ${org.text}`)
      clean(org.text, '公司管理员的 /orgs/:id/settings')
      assert(org.json.daily && org.json.utility, '模型角色不该跟着一起藏掉')

      /**
       * owner 两条路上都照给：平台那几屏（单价、倍率、连接器计费、期望管家版本）就靠它画。
       *
       * 这里只验**键在不在**，不验具体数字——上面几条用例改过又撤过覆盖表和倍率，
       * 钉一个值在这儿等于把这条用例绑在前面的执行顺序上。
       */
      const hasAll = (obj, who) => {
        for (const k of SECRET_KEYS) assert(obj[k] !== undefined, `${who} 丢了 ${k}：${JSON.stringify(obj)}`)
      }
      const ownerMe = await req(base, 'GET', '/me', { token: owner })
      assert(ownerMe.status === 200, `owner me ${ownerMe.status} ${ownerMe.text}`)
      hasAll(ownerMe.json.settings, 'owner 的 /me')
      // owner 在公司详情页上看的是同一条 /orgs/:id/settings，他那份要带着。
      const ownerOrg = await req(base, 'GET', `/orgs/${orgA}/settings`, { token: owner })
      assert(ownerOrg.status === 200, `owner org settings ${ownerOrg.status} ${ownerOrg.text}`)
      hasAll(ownerOrg.json, 'owner 看公司详情时')

      // 顺手验一遍这一刀切的是**下发**，不是存储：覆盖价写进去，owner 读回来还看得见。
      await req(base, 'PUT', '/platform/settings', { token: owner, body: { modelPricing: { [MODEL]: RATE } } })
      const after = await req(base, 'GET', '/me', { token: owner })
      assert(after.json.settings.modelPricing[MODEL].cacheWrite === 12.5, `owner 的 /me 丢了覆盖价：${after.text}`)
      const stillHidden = await req(base, 'GET', '/me', { token: tokenA })
      clean(JSON.stringify(stillHidden.json.settings), '写了覆盖价之后公司管理员的 /me')
      await req(base, 'PUT', '/platform/settings', { token: owner, body: { modelPricing: {} } })
    })

    await test('平台明细看得见所有公司，无票 401，公司管理员 403', async () => {
      const all = await req(base, 'GET', '/platform/charges?limit=50', { token: owner })
      assert(all.status === 200, `platform charges ${all.status} ${all.text}`)
      const orgs = new Set(all.json.charges.map((c) => c.companyId))
      assert(orgs.has(orgA) && orgs.has(orgB), `只看到 ${[...orgs]}`)
      const unauth = await req(base, 'GET', '/platform/charges')
      assert(unauth.status === 401, `无票 ${unauth.status}`)
      const denied = await req(base, 'GET', '/platform/charges', { token: tokenA })
      assert(denied.status === 403, `公司管理员 ${denied.status}`)
    })
  } finally {
    gw.kill()
    try {
      await client.end()
    } catch {}
    await closeServer(upstream.server, '上游替身')
    try {
      rmSync(GW_HOME, { recursive: true, force: true })
    } catch {}
  }
}
