/**
 * 平台工具配置 + 席位网页工具 + 按次计价。
 *
 * 后端用 E2E_STUB_WEB=1 顶掉（见 gateway/src/web-tools.ts）：要验的是路由、鉴权、
 * 计量和计价这条链路，真打 Tavily 只会让这套测试随别人的限流一起随机失败。
 *
 * 盯死三件事：
 * 1. **业务失败必须是 200 + ok:false**，不是 4xx——席位那头要把它原样说给模型听。
 * 2. **金额是写行那一刻的快照**，改价不能追溯改动旧行。
 * 3. **密钥不回显**，配置接口只报「配没配」。
 */
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { freePort } from './ports.mjs'
import { runProbe as sharedProbe } from './probe.mjs'

/** SSRF 闸跑在 gateway/e2e-web-guard.mjs 里——那几个函数是纯的，起一整套服务没必要。 */
const runGuardProbe = (gwRoot) => sharedProbe(gwRoot, 'e2e-web-guard.mjs')

const SCHEMA = schemaOf('e2e_webtools')

export async function runWebTools({ gwRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = tmpOf('satuwork-e2e-webtools')
  const GW_PORT = await freePort()
  const base = `http://127.0.0.1:${GW_PORT}`

  rmSync(GW_HOME, { recursive: true, force: true })
  log('\n# web-tools')

  const gw = start('webtools-gw', ['--import', 'tsx', `${gwRoot}/src/index.ts`], {
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
      E2E_STUB_WEB: '1',
    },
  })
  await waitHttp(`${base}/health`, { child: gw, what: 'web-tools gateway' })

  const require = createRequire(`${gwRoot}/package.json`)
  const pg = require('pg')
  const client = new pg.Client({ connectionString: PG_URL })
  await client.connect()
  await client.query(`set search_path to ${SCHEMA}`)

  /**
   * 一次网页调用 = 一行 web_calls（事实）+ 一行 usage_charges（钱），按 refId 串。
   *
   * 金额从账本上取，不看 `web_calls.mils`——那一列从计费账本落地之后就停写了，
   * 新行恒为 0（docs/billing.md §2）。单位也换了：厘 → 微元，1 mil = 1000 micros。
   */
  const webCalls = async () =>
    (
      await client.query(
        'select w.kind, w.backend, w.units, w."companyId", w."createdAt", coalesce(u."amountMicros", 0)::int as micros' +
          ' from web_calls w left join usage_charges u on u."refId" = w.id order by w."createdAt"',
      )
    ).rows

  try {
    let token = ''
    let adminToken = ''
    let seatToken = ''
    let companyId = ''

    await test('种数据：一家公司、一个员工席位', async () => {
      const setup = await req(base, 'POST', '/auth/setup', {
        body: { email: 'o@web.test', name: 'o', password: 'correct-horse-1' },
      })
      assert(setup.status === 201, `setup ${setup.status} ${setup.text}`)
      token = setup.json.token

      const org = await req(base, 'POST', '/platform/orgs', {
        token,
        body: {
          name: 'Acme', slug: 'acme-web',
          contactName: '张三', contactPhone: '+86 138 0000 0000', contactEmail: 'z@web.test',
          adminEmail: 'a@web.test', adminPassword: 'correct-horse-1',
        },
      })
      assert(org.status === 201, `org ${org.status} ${org.text}`)
      companyId = org.json.company.id

      const login = await req(base, 'POST', '/auth/login', {
        body: { email: 'a@web.test', password: 'correct-horse-1' },
      })
      assert(login.status === 200, `login ${login.status} ${login.text}`)
      adminToken = login.json.token

      const secrets = await client.query(
        `select s."accessToken" from account_secrets s join accounts a on a.id = s."accountId" where a.email = 'a@web.test'`,
      )
      seatToken = secrets.rows[0].accessToken
      assert(seatToken.startsWith('sat_'), `席位票不对：${seatToken}`)

      // 网页工具是要收钱的（下面配的是 8 厘一次），而余额熔断默认是开着的：
      // 没有余额的公司连搜索都发不出去。先充一笔，这一份才测得到计费本身。
      // 「余额为 0 会怎样」在 e2e/billing.mjs 里单独验。
      const topup = await req(base, 'POST', '/platform/orders', {
        token,
        body: { companyId: org.json.company.id, kind: 'topup', amount: 10, payStatus: 'paid', note: 'web e2e' },
      })
      assert(topup.status === 201, `topup ${topup.status} ${topup.text}`)
    })

    await test('工具配置只有系统管理员看得见', async () => {
      const mine = await req(base, 'GET', '/platform/tools/web', { token })
      assert(mine.status === 200, `owner ${mine.status} ${mine.text}`)
      const theirs = await req(base, 'GET', '/platform/tools/web', { token: adminToken })
      assert(theirs.status === 403, `公司管理员拿到了 ${theirs.status}`)
      const put = await req(base, 'PUT', '/platform/tools/web', { token: adminToken, body: { searchBackend: 'tavily' } })
      assert(put.status === 403, `公司管理员改得动：${put.status}`)
    })

    await test('后端能力不匹配的组合存不进去', async () => {
      // duckduckgo 只会搜索。把它设成提取后端，等于让人配出一个必然报错的组合，
      // 然后到席位那边才发现。
      const bad = await req(base, 'PUT', '/platform/tools/web', { token, body: { extractBackend: 'duckduckgo' } })
      assert(bad.status === 400, `不支持提取的后端被接受了：${bad.status} ${bad.text}`)
      const badUrl = await req(base, 'PUT', '/platform/tools/web', { token, body: { searxngUrl: 'not-a-url' } })
      assert(badUrl.status === 400, `坏地址被接受了：${badUrl.status}`)
    })

    await test('还没配后端时，席位调用是 200 + ok:false，不是 4xx', async () => {
      const r = await req(base, 'POST', '/runtime/web/search', { token: seatToken, body: { query: 'hello' } })
      assert(r.status === 200, `状态 ${r.status}，业务失败不该是 4xx`)
      assert(r.json.ok === false, `ok=${r.json.ok}`)
      assert(r.json.error.includes('工具配置'), `没指路该谁去哪配：${r.json.error}`)
      assert((await webCalls()).length === 0, '没配后端也记了一笔账')
    })

    await test('配后端与单价：密钥不回显，只报配没配', async () => {
      const cred = await req(base, 'POST', '/platform/credentials', {
        token,
        body: { provider: 'tavily', secret: 'tvly-e2e-never-leak' },
      })
      assert(cred.status === 201, `密钥 ${cred.status} ${cred.text}`)
      const saved = await req(base, 'PUT', '/platform/tools/web', {
        token,
        body: {
          searchBackend: 'tavily',
          extractBackend: 'tavily',
          pricing: { tavily: { search: 8, extract: 8 } },
        },
      })
      assert(saved.status === 200, `保存 ${saved.status} ${saved.text}`)
      assert(saved.json.web.searchBackend === 'tavily', `没存住：${JSON.stringify(saved.json.web)}`)
      assert(saved.json.web.pricing.tavily.search === 8, `单价没存住：${JSON.stringify(saved.json.web.pricing)}`)
      const tav = saved.json.backends.find((b) => b.id === 'tavily')
      assert(tav.configured === true, 'tavily 应当显示已配置')
      assert(!JSON.stringify(saved.json).includes('tvly-e2e-never-leak'), '配置接口把密钥回显了')
      // 四家后端都要列出来，各自的能力如实报——界面那两个下拉是照这个画的。
      const by = Object.fromEntries(saved.json.backends.map((b) => [b.id, b]))
      assert(by.tavily.search && by.tavily.extract, 'tavily 该是搜索+提取')
      assert(by.firecrawl.search && by.firecrawl.extract, 'firecrawl 该是搜索+提取')
      assert(by.searxng.search && !by.searxng.extract, 'searxng 只有搜索')
      assert(by.duckduckgo.search && !by.duckduckgo.extract, 'duckduckgo 只有搜索')
      assert(Object.values(by).every((b) => b.implemented), '有后端还没接入')
      assert(by.firecrawl.needsSecret && by.duckduckgo.needsSecret === false, '要不要密钥报错了')
    })

    await test('存模型配置不会把工具配置抹掉', async () => {
      // PUT /platform/settings 是整份覆盖上去的，不带着 webTools 就会顺手清空它。
      const s = await req(base, 'PUT', '/platform/settings', { token, body: { priceMultiplier: 1.2 } })
      assert(s.status === 200, `settings ${s.status} ${s.text}`)
      const after = await req(base, 'GET', '/platform/tools/web', { token })
      assert(after.json.web.searchBackend === 'tavily', '去模型配置存了一次，工具配置被抹了')
      assert(after.json.priceMultiplier === 1.2, `倍率 ${after.json.priceMultiplier}`)
    })

    await test('搜索：计价 = 单价 × 倍率，四舍五入到厘', async () => {
      const r = await req(base, 'POST', '/runtime/web/search', { token: seatToken, body: { query: 'node 24' } })
      assert(r.json.ok === true, `搜索失败：${r.text}`)
      assert(r.json.hits.length === 2, `条数 ${r.json.hits.length}`)
      const rows = await webCalls()
      assert(rows.length === 1, `账目 ${rows.length} 条`)
      // 8 厘 × 1 次 × 1.2 = 9.6 厘 = 9600 微元
      assert(rows[0].micros === 9600, `金额 ${rows[0].micros} 微元，应当是 9600`)
      assert(rows[0].units === 1 && rows[0].kind === 'search', JSON.stringify(rows[0]))
    })

    await test('零结果也是正常返回，照样记一次调用', async () => {
      const r = await req(base, 'POST', '/runtime/web/search', { token: seatToken, body: { query: 'empty thing' } })
      assert(r.json.ok === true && r.json.hits.length === 0, `不该是失败：${r.text}`)
      // 后端已经被调用过了，钱花了就得记——空结果不是「没调用」。
      assert((await webCalls()).length === 2, '零结果没记账')
    })

    await test('提取：部分失败不影响其余，units 只数抓成功的', async () => {
      const r = await req(base, 'POST', '/runtime/web/extract', {
        token: seatToken,
        body: { urls: ['https://a.test/1', 'https://a.test/2', 'https://a.test/fail', 'https://a.test/4', 'https://a.test/5'] },
      })
      assert(r.json.ok === true, `提取失败：${r.text}`)
      assert(r.json.pages.length === 5, `页数 ${r.json.pages.length}`)
      assert(r.json.pages.filter((p) => p.ok).length === 4, '成功页数不对')
      assert(r.json.pages[2].ok === false && r.json.pages[2].error.includes('404'), `失败页没写清楚：${JSON.stringify(r.json.pages[2])}`)
      const rows = await webCalls()
      const last = rows[rows.length - 1]
      assert(last.kind === 'extract' && last.units === 4, `units ${last.units}，失败那条不该算钱`)
      // 8 × 4 × 1.2 = 38.4 厘 = 38400 微元。**微元不会像厘那样把零头舍掉**——
      // 这正是账本用微元的理由。
      assert(last.micros === 38400, `金额 ${last.micros} 微元，应当是 38400`)
    })

    await test('后缀骗人的地址只收一次钱，也不把缓存那几条一起收了', async () => {
      // `.pdf` 结尾其实返回 HTML：先走文档探测（落空），再落回提取后端。
      // 旧实现用一个计数器倒推「命中缓存几条」，这一路会把它加两次，于是缓存命中
      // 被算成负数——一条 URL 收两份钱，同一次调用里真命中的那几条也跟着被收。
      await req(base, 'POST', '/runtime/web/extract', { token: seatToken, body: { urls: ['https://a.test/warm'] } })
      const before = (await webCalls()).length
      const r = await req(base, 'POST', '/runtime/web/extract', {
        token: seatToken,
        // 一条假 PDF（真打后端一次）+ 一条上面刚抓过的（命中缓存，免费）。
        body: { urls: ['https://a.test/fake-doc.pdf', 'https://a.test/warm'] },
      })
      assert(r.json.ok === true, r.text)
      const rows = await webCalls()
      assert(rows.length === before + 1, `记了 ${rows.length - before} 笔`)
      assert(rows[rows.length - 1].units === 1, `计费条数 ${rows[rows.length - 1].units}，应当只算那条真抓的`)
    })

    await test('文档记在 document 名下，按它自己那档价算', async () => {
      // PDF 是 Gateway 自己下的，提取后端一次都没被调用。记在 tavily 头上的话，
      // 统计里「按后端」那张表就在撒谎——而那张表正是用来看钱花在哪家的。
      const put = await req(base, 'PUT', '/platform/tools/web', {
        token,
        body: { pricing: { tavily: { search: 8, extract: 8 }, document: { search: 0, extract: 5 } } },
      })
      assert(put.status === 200, `定价 ${put.status} ${put.text}`)
      const doc = put.json.backends.find((b) => b.id === 'document')
      assert(doc && doc.selectable === false, 'document 不该是可选后端')

      const r = await req(base, 'POST', '/runtime/web/extract', { token: seatToken, body: { urls: ['https://a.test/real.pdf'] } })
      assert(r.json.ok === true, r.text)
      assert(r.json.pages[0].document?.base64, `没走文档那条路：${JSON.stringify(r.json.pages[0]).slice(0, 200)}`)
      const rows = await webCalls()
      const last = rows[rows.length - 1]
      assert(last.backend === 'document', `记在了 ${last.backend} 头上`)
      // 5 厘 × 1 条 × 1.2 = 6
      assert(last.units === 1 && last.micros === 6000, `文档那笔：${JSON.stringify(last)}`)
    })

    await test('一次调用里网页和文档各按各的价，分开落账', async () => {
      const before = (await webCalls()).length
      const r = await req(base, 'POST', '/runtime/web/extract', {
        token: seatToken,
        body: { urls: ['https://a.test/mixed-page', 'https://a.test/mixed.pdf'] },
      })
      assert(r.json.ok === true, r.text)
      const rows = (await webCalls()).slice(before)
      assert(rows.length === 2, `该落两笔（网页一笔、文档一笔），实际 ${rows.length}`)
      const byBackend = Object.fromEntries(rows.map((x) => [x.backend, x]))
      assert(byBackend.tavily?.units === 1, `网页那笔：${JSON.stringify(byBackend.tavily)}`)
      assert(byBackend.document?.units === 1, `文档那笔：${JSON.stringify(byBackend.document)}`)
      // 8 × 1.2 = 9.6 → 10；5 × 1.2 = 6
      assert(byBackend.tavily.micros === 9600 && byBackend.document.micros === 6000, `金额：${JSON.stringify(rows)}`)
    })

    await test('两把工具各配各的 provider，互不影响', async () => {
      // 搜索走 firecrawl、提取走 tavily。这是分开配的全部意义：查询词发给谁、正文由谁
      // 抓，本来就是两笔生意（自托管 SearXNG 搜 + 托管服务抓，是很实在的一种组合）。
      const cred = await req(base, 'POST', '/platform/credentials', { token, body: { provider: 'firecrawl', secret: 'fc-e2e-never-leak' } })
      assert(cred.status === 201 || cred.status === 200, `密钥 ${cred.status} ${cred.text}`)
      const put = await req(base, 'PUT', '/platform/tools/web', {
        token,
        body: {
          searchBackend: 'firecrawl',
          extractBackend: 'tavily',
          pricing: { tavily: { search: 8, extract: 8 }, firecrawl: { search: 20, extract: 20 }, document: { search: 0, extract: 5 } },
        },
      })
      assert(put.status === 200, `保存 ${put.status} ${put.text}`)

      const before = (await webCalls()).length
      const s1 = await req(base, 'POST', '/runtime/web/search', { token: seatToken, body: { query: '各走各家' } })
      assert(s1.json.ok === true && s1.json.backend === 'firecrawl', `搜索没走 firecrawl：${s1.text}`)
      assert(s1.json.hits[0].url.includes('fc-stub'), `拿到的不是 firecrawl 的结果：${JSON.stringify(s1.json.hits[0])}`)

      const e1 = await req(base, 'POST', '/runtime/web/extract', { token: seatToken, body: { urls: ['https://a.test/mixed'] } })
      assert(e1.json.ok === true && e1.json.backend === 'tavily', `提取没走 tavily：${e1.text}`)

      // 两笔账各记各的名义、各按各的单价：20 × 1.2 = 24；8 × 1.2 = 9.6 → 10。
      const rows = (await webCalls()).slice(before)
      assert(rows.length === 2, `该落两笔，实际 ${rows.length}`)
      const byBackend = Object.fromEntries(rows.map((x) => [x.backend, x]))
      assert(byBackend.firecrawl?.kind === 'search' && byBackend.firecrawl.micros === 24000, `firecrawl 那笔：${JSON.stringify(byBackend.firecrawl)}`)
      assert(byBackend.tavily?.kind === 'extract' && byBackend.tavily.micros === 9600, `tavily 那笔：${JSON.stringify(byBackend.tavily)}`)

      // 新配的密钥照旧不回显。
      const view = await req(base, 'GET', '/platform/tools/web', { token })
      assert(!JSON.stringify(view.json).includes('fc-e2e-never-leak'), 'firecrawl 密钥被回显了')
      await req(base, 'PUT', '/platform/tools/web', { token, body: { searchBackend: 'tavily', extractBackend: 'tavily' } })
    })

    await test('同一次调用里重复的地址只抓一次、只收一次钱', async () => {
      const before = (await webCalls()).length
      const r = await req(base, 'POST', '/runtime/web/extract', {
        token: seatToken,
        // 同一个地址写两遍：并发下两条都会绕过缓存（第一条还没回来写缓存）。
        body: { urls: ['https://a.test/dup', 'https://a.test/dup'] },
      })
      assert(r.json.ok === true, r.text)
      assert(r.json.pages.length === 1, `该只剩一条，实际 ${r.json.pages.length}`)
      const rows = (await webCalls()).slice(before)
      assert(rows.length === 1 && rows[0].units === 1, `计费条数不对：${JSON.stringify(rows)}`)
    })

    await test('参数越界当场说清楚，不发给后端', async () => {
      // 越界的两次一笔都不该有：调用前后账目条数必须一样。
      const before = (await webCalls()).length
      const many = await req(base, 'POST', '/runtime/web/extract', {
        token: seatToken,
        body: { urls: ['1', '2', '3', '4', '5', '6'].map((n) => `https://a.test/${n}`) },
      })
      assert(many.json.ok === false && many.json.error.includes('最多 5'), `没挡住 6 个地址：${many.text}`)
      const count = await req(base, 'POST', '/runtime/web/search', { token: seatToken, body: { query: 'x', count: 50 } })
      assert(count.json.ok === false && count.json.error.includes('count'), `没挡住 count=50：${count.text}`)
      const after = (await webCalls()).length
      assert(after === before, `越界的调用记了账：多了 ${after - before} 条`)
    })

    await test('改单价不动旧账', async () => {
      const rowsBefore = await webCalls()
      const put = await req(base, 'PUT', '/platform/tools/web', {
        token,
        body: { pricing: { tavily: { search: 100, extract: 100 }, document: { search: 0, extract: 5 } } },
      })
      assert(put.status === 200, `改价 ${put.status}`)
      const rowsAfter = await webCalls()
      assert(
        rowsBefore.every((r, i) => r.micros === rowsAfter[i].micros),
        `改价把历史账改了：${JSON.stringify(rowsAfter.map((r) => r.micros))}`,
      )
      // 新的一笔按新价：100 × 1.2 = 120
      await req(base, 'POST', '/runtime/web/search', { token: seatToken, body: { query: 'after' } })
      const rows = await webCalls()
      assert(rows[rows.length - 1].micros === 120000, `新价没生效：${rows[rows.length - 1].micros}`)
    })

    await test('自检不记账——那是管理员在验配置，不是公司在用', async () => {
      const before = (await webCalls()).length
      const r = await req(base, 'POST', '/platform/tools/web/test', { token, body: { kind: 'search' } })
      assert(r.status === 200 && r.json.ok === true, `自检 ${r.status} ${r.text}`)
      assert(r.json.count === 2, `自检结果条数 ${r.json.count}`)
      assert((await webCalls()).length === before, '自检记了账')
    })

    await test('缓存：同一次搜索 15 分钟内不再打后端，也不再记账', async () => {
      const before = (await webCalls()).length
      const first = await req(base, 'POST', '/runtime/web/search', { token: seatToken, body: { query: '缓存这一条' } })
      assert(first.json.ok === true && first.json.cached !== true, '第一次就说是缓存')
      const second = await req(base, 'POST', '/runtime/web/search', { token: seatToken, body: { query: '缓存这一条' } })
      assert(second.json.cached === true, '第二次没命中缓存')
      assert(second.json.amountMicros === 0, `命中缓存还报了价：${second.json.amountMicros}`)
      // 没打后端就没有这笔成本，记上去是虚报。
      assert((await webCalls()).length === before + 1, '命中缓存也记了账')
    })

    await test('缓存：提取命中的那几条不计费，没命中的照算', async () => {
      const urls = ['https://cache.test/1', 'https://cache.test/2']
      await req(base, 'POST', '/runtime/web/extract', { token: seatToken, body: { urls } })
      const before = await webCalls()
      // 一条命中缓存、一条是新的 → 只该按 1 条计费。
      const r = await req(base, 'POST', '/runtime/web/extract', {
        token: seatToken,
        body: { urls: ['https://cache.test/1', 'https://cache.test/3'] },
      })
      assert(r.json.ok === true, r.text)
      const rows = await webCalls()
      assert(rows.length === before.length + 1, `多记了账：${rows.length - before.length} 条`)
      assert(rows[rows.length - 1].units === 1, `计费条数 ${rows[rows.length - 1].units}，应当只算没命中的那一条`)
    })

    await test('缓存按公司分：别家搜过的词，这家照样打后端、照样记账', async () => {
      // 键里不带公司的话，B 公司会白拿 A 公司付过钱的结果：不记 web_calls、不落账，
      // 配额也数不到它。
      const org = await req(base, 'POST', '/platform/orgs', {
        token,
        body: {
          name: 'Beta', slug: 'beta-web',
          contactName: '李四', contactPhone: '+86 139 0000 0000', contactEmail: 'l@web.test',
          adminEmail: 'b@web.test', adminPassword: 'correct-horse-1',
        },
      })
      assert(org.status === 201, `org ${org.status} ${org.text}`)
      const otherCompany = org.json.company.id
      const topup = await req(base, 'POST', '/platform/orders', {
        token,
        body: { companyId: otherCompany, kind: 'topup', amount: 10, payStatus: 'paid', note: 'web e2e b' },
      })
      assert(topup.status === 201, `topup ${topup.status} ${topup.text}`)
      const secrets = await client.query(
        `select s."accessToken" from account_secrets s join accounts a on a.id = s."accountId" where a.email = 'b@web.test'`,
      )
      const otherSeat = secrets.rows[0].accessToken

      // A 先搜、先抓一遍，让缓存里有东西。
      await req(base, 'POST', '/runtime/web/search', { token: seatToken, body: { query: '两家都搜' } })
      await req(base, 'POST', '/runtime/web/extract', { token: seatToken, body: { urls: ['https://shared.test/1'] } })
      const again = await req(base, 'POST', '/runtime/web/search', { token: seatToken, body: { query: '两家都搜' } })
      assert(again.json.cached === true, '同一家公司第二次该命中缓存')

      const before = (await webCalls()).filter((r) => r.companyId === otherCompany).length
      const s = await req(base, 'POST', '/runtime/web/search', { token: otherSeat, body: { query: '两家都搜' } })
      assert(s.json.ok === true && s.json.cached !== true, `B 公司拿到了 A 公司的缓存：${s.text}`)
      assert(s.json.amountMicros > 0, `B 公司这一次没收钱：${s.json.amountMicros}`)
      const e = await req(base, 'POST', '/runtime/web/extract', { token: otherSeat, body: { urls: ['https://shared.test/1'] } })
      assert(e.json.ok === true && e.json.amountMicros > 0, `B 公司的提取吃了 A 的缓存：${e.text}`)
      const mine = (await webCalls()).filter((r) => r.companyId === otherCompany)
      assert(mine.length === before + 2, `B 公司该落两笔，实际 ${mine.length - before}`)
    })

    await test('提取：内网地址在交给后端之前就被拦下，也不记账', async () => {
      // 自托管 Firecrawl 在我们的内网里，替模型去打它给的地址——不过闸就等于把
      // metadata 和内网数据库交出去。假后端对任何地址都会返回 ok，所以「ok:false +
      // 内网」就说明这一条根本没到后端。
      const before = (await webCalls()).length
      const bad = [
        'http://169.254.169.254/latest/meta-data/',
        'http://10.0.0.5:5432/',
        'http://127.0.0.1:8443/',
        'http://[::ffff:a9fe:a9fe]/',
        'http://[2002:a00:5::1]/',
        'http://198.18.0.1/',
        'http://localhost:3002/',
      ]
      const r = await req(base, 'POST', '/runtime/web/extract', { token: seatToken, body: { urls: bad.slice(0, 5) } })
      assert(r.json.ok === true, r.text)
      const r2 = await req(base, 'POST', '/runtime/web/extract', { token: seatToken, body: { urls: bad.slice(5) } })
      const pages = [...r.json.pages, ...r2.json.pages]
      for (const p of pages) {
        assert(p.ok === false && /内网/.test(p.error), `${p.url} 没被拦：${JSON.stringify(p).slice(0, 200)}`)
      }
      const scheme = await req(base, 'POST', '/runtime/web/extract', { token: seatToken, body: { urls: ['file:///etc/passwd'] } })
      assert(scheme.json.pages[0].ok === false && /http\/https/.test(scheme.json.pages[0].error), `file:// 没被拦：${scheme.text}`)
      assert((await webCalls()).length === before, '被拦的地址记了账')
    })

    await test('公司配额：用满就拦住，且拦住的那次不记账', async () => {
      // 配额是按公司计的，就按这家公司的 companyId 数。以前那句「非空的条数，否则全部」
      // 在查询根本不带 companyId 的情况下永远落到「全部」——碰巧对，但没验到按公司。
      const used = (await webCalls()).filter((r) => r.companyId === companyId).length
      assert(used > 0, '这家公司到这里该已经有过网页调用')
      // 把上限设成「已经用掉的次数」，下一次必然撞线。
      const put = await req(base, 'PUT', '/platform/tools/web', { token, body: { dailyLimit: used } })
      assert(put.status === 200 && put.json.web.dailyLimit === used, `配额没存住：${put.text}`)
      const r = await req(base, 'POST', '/runtime/web/search', { token: seatToken, body: { query: '撞线' } })
      assert(r.status === 200 && r.json.ok === false, `没拦住：${r.text}`)
      assert(r.json.error.includes('用满'), `话没说清楚：${r.json.error}`)
      assert((await webCalls()).filter((r) => r.companyId === companyId).length === used, '被拦住的调用记了账')
      // 调高就该放行。
      await req(base, 'PUT', '/platform/tools/web', { token, body: { dailyLimit: 0 } })
      const ok = await req(base, 'POST', '/runtime/web/search', { token: seatToken, body: { query: '放行' } })
      assert(ok.json.ok === true, `调高上限后仍然被拦：${ok.text}`)
    })

    await test('SearXNG：能选成搜索后端，实例不通时说的是「不通」不是「没结果」', async () => {
      const put = await req(base, 'PUT', '/platform/tools/web', {
        token,
        body: { searchBackend: 'searxng', searxngUrl: 'http://127.0.0.1:19999' },
      })
      assert(put.status === 200, `选不上 SearXNG：${put.text}`)
      const r = await req(base, 'POST', '/runtime/web/search', { token: seatToken, body: { query: '打不通的实例' } })
      assert(r.json.ok === false, '实例不通却报成功')
      assert(!r.json.error.includes('没有结果'), `把「不通」说成了「没结果」：${r.json.error}`)
      // 内网地址是管理员明示的例外，闸不能把它一并拒了——那样自托管就没法用了。
      assert(!r.json.error.includes('内网'), `管理员填的自托管地址被 SSRF 闸拒了：${r.json.error}`)
      await req(base, 'PUT', '/platform/tools/web', { token, body: { searchBackend: 'tavily' } })
    })

    await test('统计里有网页那一块，金额直接求和不重算', async () => {
      const rows = await webCalls()
      const sum = rows.reduce((a, r) => a + r.micros, 0)
      const r = await req(base, 'GET', `/platform/stats?from=0&to=${Date.now() + 1000}`, { token })
      assert(r.status === 200, `stats ${r.status} ${r.text}`)
      assert(r.json.web, '统计里没有网页那一块')
      assert(r.json.web.totals.amountMicros === sum, `金额 ${r.json.web.totals.amountMicros}，账目求和是 ${sum}`)
      assert(r.json.web.byBackend.some((b) => b.backend === 'tavily'), '按后端那张表里没有 tavily')
      // token 那边的合计不能把网页的钱混进去——两者不是一个量纲。
      assert(r.json.totals.amountMicros === 0, '网页那几笔混进了模型合计')
    })

    await test('闸与限流：SSRF、跳转不带凭据、文档边读边数、压缩响应卡住会超时、DDG 排队、Firecrawl 自托管', async () => {
      const g = await runGuardProbe(gwRoot)
      for (const group of ['scheme', 'private', 'specialRanges', 'publicOk', 'redirect', 'redirectCreds', 'docLimit', 'stalledBody', 'ddgThrottle', 'firecrawl']) {
        for (const [k, v] of Object.entries(g[group])) assert(v === true, `${group}.${k} 不成立`)
      }
    })

    await test('登录 JWT 打不了席位那两个口', async () => {
      const r = await req(base, 'POST', '/runtime/web/search', { token: adminToken, body: { query: 'x' } })
      assert(r.status === 401, `席位口收了登录票：${r.status}`)
    })
  } finally {
    gw.kill()
    await client.end().catch(() => {})
    // 自己的数据目录自己收。
    rmSync(GW_HOME, { recursive: true, force: true })
  }
}
