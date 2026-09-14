/**
 * 平台统计：窗口过滤、按公司/模型聚合、金额从账本汇总。
 *
 * 时间窗是前端按用户时区算好传进来的（from/to 毫秒），所以这里直接构造窗口，
 * 不去猜服务端会怎么切天。
 *
 * **这一份测的是聚合，不是计价。** token 来自 `llm_calls`，钱来自 `usage_charges`，
 * 两张表在这里都是手工种进去的——「一次调用该收多少钱」由 e2e/billing.mjs 走真实
 * 路径去验，那才是计价发生的地方。
 *
 * 金额这块要盯死两件事：改倍率不会追溯改动历史账；目录里没单价的模型不能悄悄按
 * $0 混进金额——那会让报表少算钱还看不出来。
 */
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { freePort } from './ports.mjs'

const SCHEMA = schemaOf('e2e_stats')

export async function runStats({ gwRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = tmpOf('satuwork-e2e-stats')
  const GW_PORT = await freePort()
  const base = `http://127.0.0.1:${GW_PORT}`

  rmSync(GW_HOME, { recursive: true, force: true })
  log('\n# stats')

  const gw = start('stats-gw', ['--import', 'tsx', `${gwRoot}/src/index.ts`], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: SCHEMA,
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '0',
    },
  })
  await waitHttp(`${base}/health`, { child: gw, what: 'stats gateway' })

  const require = createRequire(`${gwRoot}/package.json`)
  const pg = require('pg')
  const client = new pg.Client({ connectionString: PG_URL })
  await client.connect()
  await client.query(`set search_path to ${SCHEMA}`)

  const now = Date.now()
  const d = new Date()
  const startOfToday = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const DAY = 86400000
  const q = (from, to, companyId) =>
    `/platform/stats?from=${from}&to=${to}${companyId ? `&companyId=${encodeURIComponent(companyId)}` : ''}`

  try {
    let token = ''
    let orgId = ''
    let accountId = ''
    await test('种数据：一家公司、有价模型和无价模型各若干条调用', async () => {
      const setup = await req(base, 'POST', '/auth/setup', {
        body: { email: 'o@stats.test', name: 'o', password: 'correct-horse-1' },
      })
      assert(setup.status === 201, `setup ${setup.status} ${setup.text}`)
      token = setup.json.token

      const org = await req(base, 'POST', '/platform/orgs', {
        token,
        body: {
          name: 'Acme', slug: 'acme-stats',
          contactName: '张三', contactPhone: '+86 138 0000 0000', contactEmail: 'z@stats.test',
          adminEmail: 'a@stats.test', adminPassword: 'correct-horse-1',
        },
      })
      assert(org.status === 201, `org ${org.status} ${org.text}`)
      orgId = org.json.company.id

      // 一个单价全 0 的自定义供应商：模拟 pi-ai 没收录价格的那类模型。
      const prov = await req(base, 'POST', '/platform/providers', {
        token,
        body: {
          id: 'noprice', name: 'NoPrice', baseUrl: 'https://noprice.test/v1', api: 'openai-completions',
          models: [{ id: 'free-model', name: 'Free', contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0 } }],
        },
      })
      assert(prov.status === 201, `provider ${prov.status} ${prov.text}`)

      const acc = await client.query(`select id from accounts where email = 'a@stats.test'`)
      accountId = acc.rows[0].id
      /**
       * 一次调用 = 一行 llm_calls（事实）+ 一行 usage_charges（钱）。
       * 真实路径上这两行由 v1.ts 一起落，这里手工种，形状要一样。
       */
      const charge = (id, provider, model, micros, at, opts = {}) =>
        client.query(
          'insert into usage_charges (id, "companyId", "accountId", kind, subject, status, quantity, "unitPrice", multiplier, "amountMicros", "bonusMicros", unpriced, "refId", "createdAt")' +
            " values ($1,$2,$3,'llm',$4,'ok','{}','{}',$5,$6,0,$7,$8,$9)",
          [`c-${id}`, orgId, accountId, `${provider}/${model}`, opts.multiplier ?? 1, micros, opts.unpriced === true, id, at],
        )
      const insert = async (id, provider, model, pt, ct, at, micros, opts) => {
        await client.query(
          'insert into llm_calls (id, "accountId", "companyId", provider, model, "promptTokens", "completionTokens", "createdAt") values ($1,$2,$3,$4,$5,$6,$7,$8)',
          [id, accountId, orgId, provider, model, pt, ct, at],
        )
        await charge(id, provider, model, micros, at, opts)
      }
      // 「今天」的两条要落在 [startOfToday, now] 里。**不能写死 startOfToday + N 小时**：
      // 凌晨跑的时候那个时刻还没到，查询窗口是 [今天零点, 此刻]，行会被排除在外，
      // 于是这一套断言在 00:00–02:00 之间必然失败。往回退、并且不早于今天零点。
      const todayA = Math.max(startOfToday, now - 3600_000)
      const todayB = Math.max(startOfToday, now - 7200_000)
      // gpt-4.1 是 $2/1M 入、$8/1M 出。今天：1M 入 + 0.5M 出 = $2 + $4 = $6。
      await insert('s1', 'openai', 'gpt-4.1', 1_000_000, 500_000, todayA, 6_000_000)
      // 10 天前：9M 入 + 9M 出 = $18 + $72 = $90。
      await insert('s2', 'openai', 'gpt-4.1', 9_000_000, 9_000_000, now - 10 * DAY, 90_000_000)
      // 今天，没单价的模型：3M token，一分钱都不该加进去，但要标出来。
      await insert('s3', 'noprice', 'free-model', 2_000_000, 1_000_000, todayB, 0, { unpriced: true })
    })

    await test('今日：只数今天的，金额按单价折算', async () => {
      const r = await req(base, 'GET', q(startOfToday, now), { token })
      assert(r.status === 200, `${r.status} ${r.text}`)
      assert(r.json.totals.calls === 2, `调用数 ${r.json.totals.calls}`)
      assert(r.json.totals.promptTokens === 3_000_000, `输入 ${r.json.totals.promptTokens}`)
      assert(r.json.totals.completionTokens === 1_500_000, `输出 ${r.json.totals.completionTokens}`)
      assert(r.json.totals.amountMicros === 6_000_000, `已扣 ${r.json.totals.amountMicros}，应当是 6000000`)
    })

    await test('近 7 天不含 10 天前那条；30 天窗口才含', async () => {
      const seven = await req(base, 'GET', q(startOfToday - 6 * DAY, now), { token })
      assert(seven.json.totals.calls === 2, `近 7 天 ${seven.json.totals.calls}`)
      const wide = await req(base, 'GET', q(now - 30 * DAY, now), { token })
      assert(wide.json.totals.calls === 3, `30 天 ${wide.json.totals.calls}`)
      assert(wide.json.totals.amountMicros === 96_000_000, `30 天已扣 ${wide.json.totals.amountMicros}，应当是 96000000`)
    })

    await test('没单价的模型不按 $0 混进金额，要单独标出来', async () => {
      const r = await req(base, 'GET', q(startOfToday, now), { token })
      assert(r.json.unpricedModels.includes('noprice/free-model'), `没标出来：${JSON.stringify(r.json.unpricedModels)}`)
      assert(r.json.byCompany[0].unpricedCalls === 1, `未计价调用数 ${r.json.byCompany[0].unpricedCalls}`)
      const m = r.json.byModel.find((x) => x.model === 'free-model')
      assert(m && m.priced === false, '按模型那行没标 priced=false')
      // 它有 3M token，但一分钱都不该加进去。
      assert(r.json.totals.amountMicros === 6_000_000, '没单价的模型把金额算进去了')
    })

    await test('有单价、只是没拿到用量的调用另报一格，不能说成「目录里没有单价」', async () => {
      /**
       * 来路是真的：上游的流一个 usage 字段都没回，或者管家没回来结算、被清扫按 0 元
       * 收了口（routines.ts 的 sweepUnsettledLlmCalls）。账本上的表现是 unpriced = true、
       * 金额 0，**但单价快照是齐的**——两种「金额算不出来」就靠这一格分开。
       *
       * 混成一格的表现：单价明明配着，统计屏却一口咬定「目录里没有单价」，人会跑去
       * 配置页找一个并不存在的问题。
       */
      const at = now - 65 * DAY
      await client.query(
        'insert into llm_calls (id, "accountId", "companyId", provider, model, "promptTokens", "completionTokens", "createdAt") values ($1,$2,$3,$4,$5,$6,$7,$8)',
        ['s-nousage', accountId, orgId, 'openai', 'gpt-4.1', 0, 0, at],
      )
      await client.query(
        'insert into usage_charges (id, "companyId", "accountId", kind, subject, status, quantity, "unitPrice", multiplier, "amountMicros", "bonusMicros", unpriced, "refId", "createdAt")' +
          " values ($1,$2,$3,'llm','openai/gpt-4.1','failed','{}',$4,1,0,0,true,'s-nousage',$5)",
        ['c-s-nousage', orgId, accountId, JSON.stringify({ input: 2, output: 8, cacheRead: 2, cacheWrite: 2 }), at],
      )
      // 自己的窗口，和上面几条互不打扰。
      const r = await req(base, 'GET', q(now - 70 * DAY, now - 60 * DAY), { token })
      assert(r.status === 200, `${r.status} ${r.text}`)
      assert(r.json.unmeteredModels.includes('openai/gpt-4.1'), `没进「没拿到用量」那一格：${JSON.stringify(r.json.unmeteredModels)}`)
      assert(!r.json.unpricedModels.includes('openai/gpt-4.1'), `配着单价的模型被报成了「目录里没有单价」：${JSON.stringify(r.json.unpricedModels)}`)
      assert(r.json.totals.unmeteredCalls === 1, `没拿到用量的调用数 ${r.json.totals.unmeteredCalls}`)
      assert(r.json.totals.unpricedCalls === 0, `不该有「没单价」的调用：${r.json.totals.unpricedCalls}`)
      // 单价是有的，所以「原价」那一列照样画得出来。
      const m = r.json.byModel.find((x) => x.model === 'gpt-4.1')
      assert(m && m.priced === true, '有单价的模型被标成了 priced=false')
    })

    await test('缓存那两截要汇总出来，它们是提示词的子集不是加项', async () => {
      // 缓存读的单价比输入低一个数量级，缓存写反而更高。统计屏上要能看见这两截，
      // 否则「token 涨了金额没怎么涨」这件事在界面上没有任何解释。
      const at = now - 45 * DAY
      await client.query(
        'insert into llm_calls (id, "accountId", "companyId", provider, model, "promptTokens", "completionTokens", "cachedTokens", "cacheWriteTokens", "createdAt")' +
          ' values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        ['s-cache', accountId, orgId, 'anthropic', 'claude-haiku-4-5', 1_000_000, 0, 900_000, 50_000, at],
      )
      await client.query(
        'insert into usage_charges (id, "companyId", "accountId", kind, subject, status, quantity, "unitPrice", multiplier, "amountMicros", "bonusMicros", unpriced, "refId", "createdAt")' +
          " values ($1,$2,$3,'llm','anthropic/claude-haiku-4-5','ok','{}','{}',1,$4,0,false,'s-cache',$5)",
        ['c-s-cache', orgId, accountId, 202_500, at],
      )
      // 自己的窗口，和上面几条互不打扰。
      const r = await req(base, 'GET', q(now - 50 * DAY, now - 40 * DAY), { token })
      assert(r.status === 200, `${r.status} ${r.text}`)
      assert(r.json.totals.calls === 1, `这个窗口应只有 1 条，实际 ${r.json.totals.calls}`)
      assert(r.json.totals.cachedTokens === 900_000, `缓存读没汇总：${r.json.totals.cachedTokens}`)
      assert(r.json.totals.cacheWriteTokens === 50_000, `缓存写没汇总：${r.json.totals.cacheWriteTokens}`)
      assert(r.json.totals.amountMicros === 202_500, `已扣 ${r.json.totals.amountMicros}`)
      const m = r.json.byModel.find((x) => x.model === 'claude-haiku-4-5')
      assert(m && m.cachedTokens === 900_000, `按模型那行缺缓存 token：${JSON.stringify(m)}`)
    })

    await test('缓存 token 比提示词还多时按提示词封顶，不报出负的未命中量', async () => {
      // 脏数据防线：上游改口径、或者旧行没这一列的时候，界面上不能出现负数。
      const at = now - 46 * DAY
      await client.query(
        'insert into llm_calls (id, "accountId", "companyId", provider, model, "promptTokens", "completionTokens", "cachedTokens", "createdAt")' +
          ' values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        ['s-cache-bad', accountId, orgId, 'anthropic', 'claude-haiku-4-5', 100_000, 0, 999_000_000, at],
      )
      const r = await req(base, 'GET', q(now - 47 * DAY, now - 45.5 * DAY), { token })
      assert(r.json.totals.calls === 1, `窗口里应只有那条脏数据，实际 ${r.json.totals.calls}`)
      assert(r.json.totals.cachedTokens === 100_000, `没按提示词封顶：${r.json.totals.cachedTokens}`)
      assert(r.json.totals.promptTokens - r.json.totals.cachedTokens >= 0, '算出了负的未命中量')
    })

    await test('改倍率不追溯改动历史账；原价按各行自己的倍率倒推', async () => {
      // 这是账本口径的核心：金额在写行那一刻定死。以前这里是查询时现折，
      // 于是改一次倍率，上个月的账单跟着变。
      const put = await req(base, 'PUT', '/platform/settings', { token, body: { priceMultiplier: 1.5 } })
      assert(put.status === 200, `settings ${put.status} ${put.text}`)
      const r = await req(base, 'GET', q(startOfToday, now), { token })
      assert(r.json.multiplier === 1.5, `倍率 ${r.json.multiplier}`)
      assert(r.json.totals.amountMicros === 6_000_000, `改倍率把历史账改了：${r.json.totals.amountMicros}`)
      // 那几行落账时倍率是 1，所以原价 = 已扣。
      assert(r.json.totals.costMicros === 6_000_000, `原价 ${r.json.totals.costMicros}`)

      // 再种一行「倍率 1.5 时收的」，原价应当倒推回 2。
      const at = now - 61 * DAY
      await client.query(
        'insert into llm_calls (id, "accountId", "companyId", provider, model, "promptTokens", "completionTokens", "createdAt") values ($1,$2,$3,$4,$5,$6,$7,$8)',
        ['s-mult', accountId, orgId, 'openai', 'gpt-4.1', 1_000_000, 0, at],
      )
      await client.query(
        'insert into usage_charges (id, "companyId", "accountId", kind, subject, status, quantity, "unitPrice", multiplier, "amountMicros", "bonusMicros", unpriced, "refId", "createdAt")' +
          " values ('c-s-mult', $1, $2, 'llm', 'openai/gpt-4.1', 'ok', '{}', '{}', 1.5, 3000000, 0, false, 's-mult', $3)",
        [orgId, accountId, at],
      )
      const later = await req(base, 'GET', q(now - 62 * DAY, now - 60 * DAY), { token })
      assert(later.json.totals.amountMicros === 3_000_000, `已扣 ${later.json.totals.amountMicros}`)
      assert(later.json.totals.costMicros === 2_000_000, `原价该倒推成 2000000，实际 ${later.json.totals.costMicros}`)
      await req(base, 'PUT', '/platform/settings', { token, body: { priceMultiplier: 1 } })
    })

    await test('账本上没有对应行的调用要单独标出来，别让 $0 看着像免费', async () => {
      /**
       * 金额只从账本来之后，「按 $0 收了」和「压根没记过账」在数字上长得一样，
       * 而后者正是升级前所有历史调用的样子（回填脚本刻意不给模型调用补金额）。
       * 不把它数出来，翻上个月看到的就是真实的 token 配一个 $0.00 加零句提示。
       */
      // 位置要避开别的用例：45/46 天是缓存那两条，61 天是倍率那条，70–90 天留给「空窗口」。
      const at = now - 55 * DAY
      await client.query(
        'insert into llm_calls (id, "accountId", "companyId", provider, model, "promptTokens", "completionTokens", "createdAt") values ($1,$2,$3,$4,$5,$6,$7,$8)',
        ['s-noledger', accountId, orgId, 'openai', 'gpt-4.1', 1_000_000, 0, at],
      )
      const r = await req(base, 'GET', q(now - 56 * DAY, now - 54 * DAY), { token })
      assert(r.status === 200, `${r.status} ${r.text}`)
      assert(r.json.totals.calls === 1, `窗口里应只有那一条，实际 ${r.json.totals.calls}`)
      assert(r.json.totals.amountMicros === 0, `没账本行却算出了金额：${r.json.totals.amountMicros}`)
      assert(r.json.totals.unledgeredCalls === 1, `没数出来：${r.json.totals.unledgeredCalls}`)
      assert(r.json.unledgeredModels.includes('openai/gpt-4.1'), `没列出来：${JSON.stringify(r.json.unledgeredModels)}`)
      // 「没单价」和「没账本行」是两回事：前者去配置页能补，后者补不回来。别混成一句话。
      assert(!r.json.unpricedModels.includes('openai/gpt-4.1'), 'gpt-4.1 有单价，不该报成没单价')
      const m = r.json.byModel.find((x) => x.model === 'gpt-4.1')
      assert(m && m.unledgeredCalls === 1, `按模型那行缺这个数：${JSON.stringify(m)}`)

      // 有账本行的那些窗口不该被误标。
      const priced = await req(base, 'GET', q(startOfToday, now), { token })
      assert(priced.json.totals.unledgeredCalls === 0, `有账本行的也被标了：${priced.json.totals.unledgeredCalls}`)
    })

    await test('金额卡是三条路的合计：模型 + 连接器 + 网页', async () => {
      /**
       * 上面那两张金额卡报的是**账单口径**——月底从余额里扣掉的是三条路的和。
       * 只报模型那一份的话，卡上的数比账单小，而少掉的那截在这一屏上找不出来。
       *
       * 同时钉住另一半：`totals` 里的金额仍然只是模型那一条（按公司 / 按模型两张表
       * 用的就是它）。两个数不一样是故意的，不能哪天有人把它们合成一个。
       */
      // 位置避开别的用例：45/46 缓存、55 没账本行、61 倍率、70–90 空窗口。
      const at = now - 65 * DAY
      const charge = (id, kind, subject, micros, mult, refId) =>
        client.query(
          'insert into usage_charges (id, "companyId", "accountId", kind, subject, status, quantity, "unitPrice", multiplier, "amountMicros", "bonusMicros", unpriced, "refId", "createdAt")' +
            " values ($1,$2,$3,$4,$5,'ok','{}','{}',$6,$7,0,false,$8,$9)",
          [id, orgId, accountId, kind, subject, mult, micros, refId, at],
        )
      await client.query(
        'insert into llm_calls (id, "accountId", "companyId", provider, model, "promptTokens", "completionTokens", "createdAt") values ($1,$2,$3,$4,$5,$6,$7,$8)',
        ['s-mix', accountId, orgId, 'openai', 'gpt-4.1', 100_000, 0, at],
      )
      await charge('c-s-mix', 'llm', 'openai/gpt-4.1', 1_000_000, 1, 's-mix')
      // 连接器：落账时倍率 1.5，所以原价该倒推成 200000。
      await client.query(
        'insert into connector_calls (id, "companyId", "accountId", vendor, connector, label, tool, status, "createdAt") values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        ['n-mix', orgId, accountId, 'composio', 'gmail', 'default', 'GMAIL_SEND_EMAIL', 'ok', at],
      )
      await charge('c-n-mix', 'connector', 'gmail:GMAIL_SEND_EMAIL', 300_000, 1.5, 'n-mix')
      await client.query(
        'insert into web_calls (id, "accountId", "companyId", kind, backend, units, mils, "createdAt") values ($1,$2,$3,$4,$5,$6,$7,$8)',
        ['w-mix', accountId, orgId, 'search', 'searxng', 4, 0, at],
      )
      await charge('c-w-mix', 'web', 'searxng', 500_000, 1, 'w-mix')

      const r = await req(base, 'GET', q(now - 66 * DAY, now - 64 * DAY), { token })
      assert(r.status === 200, `${r.status} ${r.text}`)
      assert(r.json.totals.amountMicros === 1_000_000, `totals 该只有模型那一条：${r.json.totals.amountMicros}`)
      assert(r.json.money.llm.amountMicros === 1_000_000, `模型 ${r.json.money.llm.amountMicros}`)
      assert(r.json.money.connector.amountMicros === 300_000, `连接器 ${r.json.money.connector.amountMicros}`)
      assert(r.json.money.web.amountMicros === 500_000, `网页 ${r.json.money.web.amountMicros}`)
      assert(r.json.money.all.amountMicros === 1_800_000, `合计 ${r.json.money.all.amountMicros}`)
      // 原价按各行自己的倍率倒推：1000000 + 300000/1.5 + 500000。
      assert(r.json.money.all.costMicros === 1_700_000, `合计原价 ${r.json.money.all.costMicros}`)

      assert(r.json.connector.totals.calls === 1, `连接器调用数 ${r.json.connector.totals.calls}`)
      assert(r.json.connector.totals.amountMicros === 300_000, `连接器已扣 ${r.json.connector.totals.amountMicros}`)
      const g = r.json.connector.byConnector.find((x) => x.connector === 'gmail')
      assert(g && g.calls === 1 && g.amountMicros === 300_000, `按连接器那行不对：${JSON.stringify(r.json.connector.byConnector)}`)
      assert(r.json.web.totals.units === 4, `网页条数 ${r.json.web.totals.units}`)

      // 公司过滤要一起管住这两条路，否则筛完公司卡上的钱还是全平台的。
      const one = await req(base, 'GET', q(now - 66 * DAY, now - 64 * DAY, orgId), { token })
      assert(one.json.money.all.amountMicros === 1_800_000, `按公司过滤后 ${one.json.money.all.amountMicros}`)
      const other = await req(base, 'GET', q(now - 66 * DAY, now - 64 * DAY, 'no-such-company'), { token })
      assert(other.status === 404, `不存在的公司 ${other.status}`)
    })

    await test('按公司过滤；公司不存在是 404', async () => {
      const one = await req(base, 'GET', q(now - 30 * DAY, now, orgId), { token })
      assert(one.json.byCompany.length === 1, `过滤后 ${one.json.byCompany.length} 行`)
      assert(one.json.byCompany[0].companyId === orgId, '过滤到了别家')
      const bad = await req(base, 'GET', q(now - 30 * DAY, now, 'no-such-company'), { token })
      assert(bad.status === 404, `不存在的公司 ${bad.status}`)
    })

    await test('空窗口给 0，不报错', async () => {
      const r = await req(base, 'GET', q(now - 90 * DAY, now - 70 * DAY), { token })
      assert(r.status === 200, `${r.status} ${r.text}`)
      assert(r.json.totals.calls === 0 && r.json.byCompany.length === 0, `空窗口 ${JSON.stringify(r.json.totals)}`)
    })

    await test('只有 owner 能看；无票 401，公司管理员 403', async () => {
      const unauth = await req(base, 'GET', q(startOfToday, now))
      assert(unauth.status === 401, `无票 ${unauth.status}`)
      const login = await req(base, 'POST', '/auth/login', { body: { email: 'a@stats.test', password: 'correct-horse-1' } })
      const denied = await req(base, 'GET', q(startOfToday, now), { token: login.json.token })
      assert(denied.status === 403, `公司管理员 ${denied.status}`)
    })

    await test('from 不是数字要 400', async () => {
      const bad = await req(base, 'GET', '/platform/stats?from=昨天', { token })
      assert(bad.status === 400, `坏 from ${bad.status} ${bad.text}`)
    })
  } finally {
    gw.kill()
    try {
      await client.end()
    } catch {}
    try {
      rmSync(GW_HOME, { recursive: true, force: true })
    } catch {}
  }
}
