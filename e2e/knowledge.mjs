/**
 * 公司知识库（docs/knowledge-base.md）：套餐配额、共享范围、直传入库、检索、席位工具接口、删除。
 *
 * Upstash 用一台假服务顶替：按 SDK 的请求形状（POST `/<命令>[/<命名空间>]`，JSON 体，回
 * `{ result }`）回包，相似度按查询词和正文的二元组重合率算——够让「年假」查到那一段、
 * 查不到无关的。
 */
import { createServer } from 'node:http'
import { rmSync } from 'node:fs'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { freePort } from './ports.mjs'
import { createCompany } from './org.mjs'
import { closeServer } from './probe.mjs'

function bigrams(s) {
  const t = String(s || '').replace(/\s+/g, '')
  const out = new Set()
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2))
  return out
}

/** 二元组重合率和单字重合率取大的：中文短句的二元组太稀，「年假有几天」对「年假 5 天」只中一个。 */
function similarity(query, text) {
  const q = bigrams(query)
  if (!q.size) return 0
  const t = bigrams(text)
  let hit = 0
  for (const g of q) if (t.has(g)) hit++
  const chars = [...new Set(String(query).replace(/\s+/g, ''))]
  const body = new Set(String(text))
  const single = chars.filter((c) => body.has(c)).length / Math.max(1, chars.length)
  return Math.max(hit / q.size, single * 0.8)
}

async function mockUpstash() {
  const spaces = new Map()
  const seen = { upserts: 0, queries: 0, deletes: [], deletedNamespaces: [] }
  const space = (ns) => {
    if (!spaces.has(ns)) spaces.set(ns, new Map())
    return spaces.get(ns)
  }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      let body = null
      try { body = JSON.parse(raw || 'null') } catch {}
      const [cmd, ns = ''] = req.url.replace(/^\//, '').split('/')
      const send = (result, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(status === 200 ? { result } : { error: result }))
      }
      if (!/^Bearer /.test(req.headers.authorization || '')) return send('unauthorized', 401)
      if (cmd === 'upsert-data') {
        const rows = Array.isArray(body) ? body : [body]
        for (const r of rows) space(ns).set(String(r.id), { data: r.data, metadata: r.metadata })
        seen.upserts += rows.length
        return send('Success')
      }
      if (cmd === 'query-data') {
        seen.queries++
        const rows = [...space(ns).entries()]
          .map(([id, v]) => ({ id, score: similarity(body.data, v.data), ...(body.includeMetadata ? { metadata: v.metadata } : {}) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, body.topK || 10)
        return send(rows)
      }
      if (cmd === 'delete') {
        let n = 0
        const s = space(ns)
        if (body?.prefix) for (const id of [...s.keys()]) if (id.startsWith(body.prefix)) { s.delete(id); n++ }
        if (Array.isArray(body?.ids)) for (const id of body.ids) if (s.delete(String(id))) n++
        seen.deletes.push({ ns, body })
        return send({ deleted: n })
      }
      if (cmd === 'delete-namespace') {
        spaces.delete(ns)
        seen.deletedNamespaces.push(ns)
        return send('Success')
      }
      if (cmd === 'info') {
        let vectorCount = 0
        for (const s of spaces.values()) vectorCount += s.size
        return send({ vectorCount, pendingVectorCount: 0, indexSize: 0, dimension: 1024, similarityFunction: 'COSINE', namespaces: {} })
      }
      if (cmd === 'list-namespaces') return send([...spaces.keys()])
      send(`unknown command ${cmd}`, 400)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, seen, spaces, url: `http://127.0.0.1:${server.address().port}` }
}

async function until(fn, { timeout = 20000, every = 300, what = '条件' } = {}) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const v = await fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, every))
  }
  throw new Error(`${what} 在 ${timeout}ms 内没成`)
}

export async function runKnowledge({ gwRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = tmpOf('satuwork-e2e-knowledge-gw')
  const GW_PORT = await freePort()
  const base = `http://127.0.0.1:${GW_PORT}`
  const schema = schemaOf('e2e_knowledge')
  rmSync(GW_HOME, { recursive: true, force: true })
  log('\n# knowledge')

  const upstash = await mockUpstash()
  const gw = start('knowledge-gw', ['--import', 'tsx', `${gwRoot}/src/index.ts`], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: schema,
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '0',
      // 入库跑在维护节拍上：跑快点，用例不用等半分钟。
      GATEWAY_ROUTINE_TICK_MS: '300',
      UPSTASH_VECTOR_REST_URL: upstash.url,
      UPSTASH_VECTOR_REST_TOKEN: 'e2e-token',
    },
  })
  await waitHttp(`${base}/health`, { child: gw, what: 'knowledge gateway' })

  let owner = ''
  let orgId = ''
  let admin = ''
  let member = ''
  let memberId = ''
  let seatTok = ''
  let botId = ''
  let skuId = ''
  let kbA = ''
  let kbB = ''
  let fileId = ''
  const orgPath = (extra) => `/orgs/${orgId}/knowledge${extra || ''}`

  try {
    await test('套餐 SKU 带知识库个数，下单付款后落到公司的 plan 上', async () => {
      const setup = await req(base, 'POST', '/auth/setup', { body: { email: 'owner@kb.test', name: 'owner', password: 'correct-horse-1' } })
      assert(setup.status === 201, `setup ${setup.status} ${setup.text}`)
      owner = setup.json.token
      const sku = await req(base, 'POST', '/platform/plans', {
        token: owner,
        body: { name: '知识版', amount: 99, seats: 3, period: 'month', bonusTokens: 0, knowledgeBases: 2 },
      })
      assert(sku.status === 201, `sku ${sku.status} ${sku.text}`)
      assert(sku.json.plan.knowledgeBases === 2, `sku.knowledgeBases ${sku.text}`)
      skuId = sku.json.plan.id
      const bad = await req(base, 'POST', '/platform/plans', { token: owner, body: { name: '坏的', amount: 1, seats: 1, knowledgeBases: -1 } })
      assert(bad.status === 400, `负数该 400：${bad.status}`)

      const company = await createCompany(req, base, {
        ownerToken: owner, email: 'admin@kb.test', password: 'correct-horse-2', companyName: 'KB Co', slug: 'kb-co', topup: 0,
      })
      orgId = company.company.id
      admin = company.token
      const before = await req(base, 'GET', `/orgs/${orgId}`, { token: admin })
      assert(before.json.plan.knowledgeBases === 0 && before.json.plan.knowledgeUsed === 0, `建公司时配额该是 0：${before.text}`)

      const order = await req(base, 'POST', '/platform/orders', {
        token: owner,
        body: { companyId: orgId, kind: 'plan', planId: skuId, payStatus: 'paid' },
      })
      assert(order.status === 201, `order ${order.status} ${order.text}`)
      assert(order.json.order.knowledgeBases === 2, `订单没抄到个数：${order.text}`)
      const after = await req(base, 'GET', `/orgs/${orgId}`, { token: admin })
      assert(after.json.plan.knowledgeBases === 2, `付款后 plan.knowledgeBases 该是 2：${after.text}`)
      assert(after.json.plan.seats === 3, `seats ${after.text}`)
    })

    await test('配置：向量库已配、自托管走直传', async () => {
      const cfg = await req(base, 'GET', orgPath('/config'), { token: admin })
      assert(cfg.status === 200, `config ${cfg.status} ${cfg.text}`)
      assert(cfg.json.enabled === true, `enabled ${cfg.text}`)
      assert(cfg.json.upload === 'direct', `upload ${cfg.json.upload}`)
      assert(cfg.json.limits.bytesMax === 200 * 1024 * 1024, `bytesMax ${cfg.json.limits.bytesMax}`)
      assert(cfg.json.quota === 2 && cfg.json.used === 0, `quota ${cfg.text}`)
      const st = await req(base, 'GET', '/platform/knowledge/status', { token: owner })
      assert(st.status === 200 && st.json.configured === true && st.json.dimension === 1024, `status ${st.text}`)
    })

    await test('建库：成员建不了，管理员建到第三个被配额拦住，重名 409', async () => {
      const made = await req(base, 'POST', `/orgs/${orgId}/accounts`, {
        token: admin, body: { email: 'm@kb.test', name: '小王', password: 'correct-horse-1', role: 'member' },
      })
      assert(made.status === 201, `member ${made.status} ${made.text}`)
      memberId = made.json.account.id
      member = (await req(base, 'POST', '/auth/login', { body: { email: 'm@kb.test', password: 'correct-horse-1' } })).json.token
      seatTok = (await req(base, 'GET', `/platform/accounts/${memberId}`, { token: owner })).json.accessToken
      assert(seatTok?.startsWith('sat_'), '没拿到席位票')
      const bot = await req(base, 'POST', '/runtime/bots', { token: member, body: { name: '客服助手' } })
      assert(bot.status === 201, `bot ${bot.status} ${bot.text}`)
      botId = bot.json.bot.id

      const denied = await req(base, 'POST', orgPath(), { token: member, body: { name: '偷建', share: 'all' } })
      assert(denied.status === 403, `成员建库该 403：${denied.status}`)

      const a = await req(base, 'POST', orgPath(), { token: admin, body: { name: '员工手册', desc: '制度与考勤', share: 'all' } })
      assert(a.status === 201, `A ${a.status} ${a.text}`)
      assert(a.json.knowledge.share === 'all', `share ${a.text}`)
      kbA = a.json.knowledge.id
      const dup = await req(base, 'POST', orgPath(), { token: admin, body: { name: '员工手册', share: 'all' } })
      assert(dup.status === 409, `重名该 409：${dup.status} ${dup.text}`)
      const b = await req(base, 'POST', orgPath(), { token: admin, body: { name: '内部价目', desc: '只给销售', share: 'none' } })
      assert(b.status === 201, `B ${b.status} ${b.text}`)
      kbB = b.json.knowledge.id
      const c = await req(base, 'POST', orgPath(), { token: admin, body: { name: '第三个', share: 'all' } })
      assert(c.status === 409, `第三个该 409：${c.status} ${c.text}`)
      assert(/上限/.test(c.json.error || ''), `文案 ${c.text}`)
      const list = await req(base, 'GET', orgPath(), { token: admin })
      assert(list.json.used === 2 && list.json.quota === 2 && list.json.knowledge.length === 2, `list ${list.text}`)
    })

    await test('往下调配额要先腾位', async () => {
      const r = await req(base, 'PUT', `/platform/orgs/${orgId}/plan`, { token: owner, body: { knowledgeBases: 1 } })
      assert(r.status === 409, `往下调该 409：${r.status} ${r.text}`)
      const ok = await req(base, 'PUT', `/platform/orgs/${orgId}/plan`, { token: owner, body: { knowledgeBases: 3 } })
      assert(ok.status === 200 && ok.json.knowledgeBases === 3, `往上调 ${ok.status} ${ok.text}`)
      const back = await req(base, 'PUT', `/platform/orgs/${orgId}/plan`, { token: owner, body: { knowledgeBases: 2 } })
      assert(back.status === 200 && back.json.knowledgeBases === 2, `调回 ${back.status} ${back.text}`)
    })

    await test('共享范围：成员只看得见共享给自己 Bot 的库，none 的库 404', async () => {
      const list = await req(base, 'GET', orgPath(), { token: member })
      assert(list.status === 200, `member list ${list.status} ${list.text}`)
      assert(list.json.knowledge.length === 1 && list.json.knowledge[0].id === kbA, `成员该只看见 A：${list.text}`)
      const hidden = await req(base, 'GET', orgPath(`/${kbB}`), { token: member })
      assert(hidden.status === 404, `none 的库对成员该 404：${hidden.status}`)

      // 把 B 共享给小王那颗 Bot：名单里填别家的 id 整单 400；填对了成员就看得见。
      const bad = await req(base, 'PUT', orgPath(`/${kbB}/share`), { token: admin, body: { share: 'bots', botIds: [botId, 'not-a-bot'] } })
      assert(bad.status === 400, `坏名单该 400：${bad.status} ${bad.text}`)
      const ok = await req(base, 'PUT', orgPath(`/${kbB}/share`), { token: admin, body: { share: 'bots', botIds: [botId] } })
      assert(ok.status === 200 && ok.json.knowledge.share === 'bots' && ok.json.knowledge.botIds[0] === botId, `share ${ok.text}`)
      const now = await req(base, 'GET', orgPath(`/${kbB}`), { token: member })
      assert(now.status === 200 && now.json.canEdit === false, `共享后成员该看得见、不能改：${now.status} ${now.text}`)
      const bots = await req(base, 'GET', orgPath('/bots'), { token: admin })
      assert(bots.status === 200 && bots.json.bots.some((b) => b.id === botId && b.owner?.name === '小王'), `bots ${bots.text}`)
      // 改回 none，名单清空。
      const none = await req(base, 'PUT', orgPath(`/${kbB}/share`), { token: admin, body: { share: 'none' } })
      assert(none.json.knowledge.botIds.length === 0, `改回 none 名单该清空：${none.text}`)
    })

    await test('登记文件：格式、单文件上限、容量都在登记那一步拦', async () => {
      const r415 = await req(base, 'POST', orgPath(`/${kbA}/files`), { token: admin, body: { name: 'x.doc', bytes: 100 } })
      assert(r415.status === 415, `.doc 该 415：${r415.status} ${r415.text}`)
      const r413 = await req(base, 'POST', orgPath(`/${kbA}/files`), { token: admin, body: { name: 'big.pdf', bytes: 60 * 1024 * 1024 } })
      assert(r413.status === 413, `60 MB 该 413：${r413.status} ${r413.text}`)
      const cap = await req(base, 'POST', orgPath(`/${kbA}/files`), { token: admin, body: { name: 'a.pdf', bytes: 199 * 1024 * 1024 } })
      assert(cap.status === 413, `199 MB 单文件先撞单文件上限：${cap.status}`)
      const member403 = await req(base, 'POST', orgPath(`/${kbA}/files`), { token: member, body: { name: 'a.txt', bytes: 10 } })
      assert(member403.status === 403, `成员传文件该 403：${member403.status}`)
    })

    const handbook = [
      '# 员工手册',
      '',
      '## 一、入职',
      '新员工入职当天到人事处领取工牌和电脑，三个工作日内完成信息安全培训。',
      '',
      '## 三、考勤',
      '### 3.2 请假',
      '年假：入职满一年的员工每年享有 5 天带薪年假，满三年 10 天，满十年 15 天。年假在自然年内休完，不跨年。',
      '病假：凭医院证明，每年累计不超过 30 天，病假期间按基本工资的 80% 发放。',
      '',
      '## 五、报销',
      '差旅报销在出差结束后 10 个工作日内提交，超过 30 天不予受理。报销单要附发票原件和行程单，由部门负责人签字后交财务。',
      '住宿标准：一线城市每晚 500 元以内，其他城市 350 元以内；超标部分自理。',
      '',
      '## 六、信息安全',
      '公司电脑不得安装未经批准的软件；客户资料不得拷贝到个人设备；离职当天交还全部设备并注销账号。',
      '发现安全事件（账号被盗、钓鱼邮件、设备丢失）须在一小时内报告 IT 部门，不得自行处理。',
      '',
      '## 七、培训',
      '每位员工每年至少完成 16 小时的岗位培训，培训记录由人事部门登记，作为年度考核的一部分。',
      '新晋升的管理者须在上任三个月内完成管理培训课程。',
      '',
      '## 八、离职',
      '员工辞职须提前 30 天书面通知；试用期内提前 3 天。离职交接清单由直属上级确认后，人事办理手续。',
      '',
      '## 附录 常见问题',
      // 中文一个字一个字符，上面几节加起来还不到 800 字；附录把全文推过一片的长度，好看见它真的会切。
      ...Array.from({ length: 14 }, (_, i) => `问题 ${i + 1}：关于制度第 ${i + 1} 条的执行细则，请以人事部门当年发布的最新通知为准，口头说明一律不作为依据。`),
    ].join('\n')

    await test('直传 + 入库：传完排队，维护节拍把它灌进向量库，状态变可用', async () => {
      const reg = await req(base, 'POST', orgPath(`/${kbA}/files`), {
        token: admin, body: { name: '员工手册 2025.md', bytes: Buffer.byteLength(handbook), mime: 'text/markdown' },
      })
      assert(reg.status === 201, `register ${reg.status} ${reg.text}`)
      assert(reg.json.upload.mode === 'direct' && reg.json.upload.url, `upload ${reg.text}`)
      assert(reg.json.file.status === 'uploading', `status ${reg.text}`)
      fileId = reg.json.file.id
      // 预留：登记那一刻容量就占上了。
      const reserved = await req(base, 'GET', orgPath(`/${kbA}`), { token: admin })
      assert(reserved.json.knowledge.bytesUsed === Buffer.byteLength(handbook), `预留 ${reserved.text}`)

      const put = await req(base, 'PUT', reg.json.upload.url, { token: admin, raw: Buffer.from(handbook), headers: { 'content-type': 'application/octet-stream' } })
      assert(put.status === 200, `put ${put.status} ${put.text}`)
      assert(['queued', 'processing', 'ready'].includes(put.json.file.status), `put status ${put.text}`)
      const again = await req(base, 'PUT', reg.json.upload.url, { token: admin, raw: Buffer.from('x'), headers: { 'content-type': 'application/octet-stream' } })
      assert(again.status === 409, `重传该 409：${again.status}`)

      const ready = await until(async () => {
        const d = await req(base, 'GET', orgPath(`/${kbA}`), { token: admin })
        const f = d.json.files.find((x) => x.id === fileId)
        if (f?.status === 'failed') throw new Error(`入库失败：${f.error}`)
        return f?.status === 'ready' ? d.json : null
      }, { what: '入库完成' })
      const f = ready.files.find((x) => x.id === fileId)
      assert(f.chunkCount >= 2 && f.chunkDone === f.chunkCount, `该切成至少两片：${JSON.stringify(f)}`)
      assert(ready.knowledge.chunkCount === f.chunkCount && ready.knowledge.fileCount === 1, `计数 ${JSON.stringify(ready.knowledge)}`)
      assert(upstash.spaces.get(`kb:${kbA}`)?.size === f.chunkCount, `向量库里该有 ${f.chunkCount} 条`)
      const one = [...upstash.spaces.get(`kb:${kbA}`).values()][0]
      assert(one.metadata.fileName === '员工手册 2025.md' && typeof one.metadata.text === 'string' && one.data.includes('《员工手册 2025》'), `元数据 ${JSON.stringify(one.metadata).slice(0, 200)}`)
      // 入库落了一行账（kind = kb），金额 0（单价默认 0）。
      const charges = await req(base, 'GET', `/orgs/${orgId}/charges?kind=kb`, { token: admin })
      assert(charges.status === 200, `charges ${charges.status} ${charges.text}`)
      const rows = (charges.json.charges || charges.json.items || []).filter((c) => c.kind === 'kb')
      assert(rows.some((c) => c.subject === 'kb:ingest'), `账本里该有 kb:ingest：${charges.text.slice(0, 300)}`)
    })

    await test('试搜：相关的查得到、带文件名和标题路径；无关的查不到', async () => {
      const r = await req(base, 'POST', orgPath('/search'), { token: admin, body: { query: '年假有几天', kbIds: [kbA] } })
      assert(r.status === 200, `search ${r.status} ${r.text}`)
      assert(r.json.hits.length >= 1, `该有命中：${r.text}`)
      const top = r.json.hits[0]
      assert(top.fileName === '员工手册 2025.md' && top.kbName === '员工手册', `命中 ${JSON.stringify(top)}`)
      assert(top.text.includes('年假') && top.text.includes('3.2 请假'), `段落该带标题路径：${top.text}`)
      const m = await req(base, 'POST', orgPath('/search'), { token: member, body: { query: '病假工资怎么发' } })
      assert(m.status === 200 && m.json.hits.length >= 1 && m.json.hits[0].text.includes('病假'), `成员试搜 ${m.text}`)
      const none = await req(base, 'POST', orgPath('/search'), { token: admin, body: { query: 'zzqqxx' } })
      assert(none.status === 200 && none.json.hits.length === 0, `无关词该零命中：${none.text}`)
      const empty = await req(base, 'POST', orgPath('/search'), { token: admin, body: { query: '  ' } })
      assert(empty.status === 400, `空词该 400：${empty.status}`)
    })

    await test('席位：目录按 Bot 下发知识库，工具接口查得到；没共享的库查不到', async () => {
      const cat = await req(base, 'GET', `/runtime/catalog?botId=${botId}`, { token: seatTok })
      assert(cat.status === 200, `catalog ${cat.status} ${cat.text}`)
      assert(Array.isArray(cat.json.knowledge) && cat.json.knowledge.length === 1 && cat.json.knowledge[0].name === '员工手册', `目录 ${JSON.stringify(cat.json.knowledge)}`)
      assert(cat.json.knowledge[0].fileCount === 1 && cat.json.knowledge[0].desc === '制度与考勤', `目录字段 ${JSON.stringify(cat.json.knowledge)}`)
      const ver = await req(base, 'GET', `/runtime/catalog/version?botId=${botId}`, { token: seatTok })
      assert(ver.status === 200 && ver.json.stamp === cat.json.stamp, `指纹两边要一样：${ver.text} vs ${cat.json.stamp}`)

      const s = await req(base, 'POST', `/runtime/knowledge/search?botId=${botId}`, { token: seatTok, body: { query: '差旅报销期限' } })
      assert(s.status === 200 && s.json.ok === true, `seat search ${s.status} ${s.text}`)
      assert(s.json.hits[0].text.includes('报销'), `seat hit ${s.text}`)
      const byName = await req(base, 'POST', `/runtime/knowledge/search?botId=${botId}`, { token: seatTok, body: { query: '报销', kbNames: ['内部价目'] } })
      assert(byName.status === 200 && byName.json.ok === false && /可查的有/.test(byName.json.error), `没共享的库该查不到：${byName.text}`)
      const noBot = await req(base, 'POST', '/runtime/knowledge/search', { token: seatTok, body: { query: '报销' } })
      assert(noBot.status === 400, `不带 botId 该 400：${noBot.status}`)
      const jwt = await req(base, 'POST', `/runtime/knowledge/search?botId=${botId}`, { token: member, body: { query: '报销' } })
      assert(jwt.status === 401, `登录票走不了席位接口：${jwt.status}`)

      // 共享范围一改，指纹就变——席位下一次探针会重拉。
      await req(base, 'PUT', orgPath(`/${kbA}/share`), { token: admin, body: { share: 'none' } })
      const ver2 = await req(base, 'GET', `/runtime/catalog/version?botId=${botId}`, { token: seatTok })
      assert(ver2.json.stamp !== ver.json.stamp, '改共享范围后指纹该变')
      const gone = await req(base, 'POST', `/runtime/knowledge/search?botId=${botId}`, { token: seatTok, body: { query: '报销' } })
      assert(gone.json.ok === false, `none 之后席位该查不到：${gone.text}`)
      await req(base, 'PUT', orgPath(`/${kbA}/share`), { token: admin, body: { share: 'all' } })
    })

    await test('下载原文件：带登录态的走得通，内容一致', async () => {
      const r = await req(base, 'GET', orgPath(`/${kbA}/files/${fileId}/download`), { token: member })
      assert(r.status === 200, `download ${r.status}`)
      assert(r.text === handbook, '下载回来的和传上去的不一样')
      assert(/attachment/.test(r.headers.get('content-disposition') || ''), 'disposition')
      const anon = await req(base, 'GET', orgPath(`/${kbA}/files/${fileId}/download`))
      assert(anon.status === 401, `匿名该 401：${anon.status}`)
    })

    await test('删文件：向量按前缀删、容量释放；删库：列表当场消失，节拍删掉命名空间', async () => {
      const del = await req(base, 'DELETE', orgPath(`/${kbA}/files/${fileId}`), { token: admin })
      assert(del.status === 200, `del ${del.status} ${del.text}`)
      assert(upstash.seen.deletes.some((d) => d.ns === `kb:${kbA}` && d.body.prefix === `${fileId}:`), `该按前缀删：${JSON.stringify(upstash.seen.deletes)}`)
      const d = await req(base, 'GET', orgPath(`/${kbA}`), { token: admin })
      assert(d.json.knowledge.bytesUsed === 0 && d.json.knowledge.fileCount === 0 && d.json.knowledge.chunkCount === 0, `删后计数 ${JSON.stringify(d.json.knowledge)}`)
      const catAfter = await req(base, 'GET', `/runtime/catalog?botId=${botId}`, { token: seatTok })
      assert(catAfter.json.knowledge.length === 0, `没有可用文件的库不下发：${JSON.stringify(catAfter.json.knowledge)}`)

      const gone = await req(base, 'DELETE', orgPath(`/${kbB}`), { token: admin })
      assert(gone.status === 200, `delete kb ${gone.status} ${gone.text}`)
      const list = await req(base, 'GET', orgPath(), { token: admin })
      assert(list.json.knowledge.length === 1 && list.json.used === 1, `删后列表 ${list.text}`)
      await until(() => upstash.seen.deletedNamespaces.includes(`kb:${kbB}`), { what: '删命名空间' })
      // 名额腾出来了，再建一个能成。
      const c = await req(base, 'POST', orgPath(), { token: admin, body: { name: '产品手册', share: 'all' } })
      assert(c.status === 201, `腾位后再建 ${c.status} ${c.text}`)
    })

    await test('平台设置：知识库单价和门槛能存、能读回', async () => {
      const r = await req(base, 'PUT', '/platform/settings', { token: owner, body: { knowledge: { pricing: { queryMils: 5, ingestMils: 2 }, scoreMin: 0.5 } } })
      assert(r.status === 200, `settings ${r.status} ${r.text}`)
      assert(r.json.knowledge.pricing.queryMils === 5 && r.json.knowledge.scoreMin === 0.5, `读回 ${JSON.stringify(r.json.knowledge)}`)
      const back = await req(base, 'GET', '/platform/settings', { token: owner })
      assert(back.json.knowledge.pricing.ingestMils === 2, `GET 读回 ${JSON.stringify(back.json.knowledge)}`)
    })
  } finally {
    gw.kill('SIGTERM')
    await closeServer(upstash.server, 'mock upstash')
  }
}
