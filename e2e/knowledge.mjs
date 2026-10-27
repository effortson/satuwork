/**
 * 公司知识库（docs/knowledge-base.md）：向量模型配置、套餐配额、共享范围、直传入库、检索、
 * 席位工具接口、换模型重建、删除。
 *
 * 向量存在 pgvector 里，库要装得上 vector 扩展（CI 的 knowledge-pgvector 那一档用
 * pgvector/pgvector 镜像）；装不上就整套跳过。向量服务用一台假的 OpenAI 兼容 `/embeddings`
 * 顶替：按几个主题词点亮固定的维度，够让「年假」查到那一段、查不到无关的。
 */
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { withPg, PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { freePort } from './ports.mjs'
import { createCompany } from './org.mjs'
import { closeServer } from './probe.mjs'
import { startGateway } from './gateway.mjs'
import { until } from './harness.mjs'

async function mockEmbeddings() {
  const seen = { queries: 0, bodies: [] }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', c => raw += c)
    req.on('end', () => {
      const body = JSON.parse(raw)
      seen.queries++
      seen.bodies.push({ model: body.model, dimensions: body.dimensions, inputs: body.input.length, auth: req.headers.authorization })
      const data = body.input.map((text, index) => {
        const embedding = Array(1024).fill(0)
        for (const [i, topic] of ['年假', '病假', '报销', '考勤'].entries()) if (text.includes(topic)) embedding[i] = 1
        if (!embedding.some(Boolean)) embedding[/^[a-z]+$/.test(text) ? 1023 : 10] = 1
        return { index, embedding }
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: data.reverse(), usage: { prompt_tokens: 10, total_tokens: 10 } }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, seen, url: `http://127.0.0.1:${server.address().port}/v1` }
}

export async function runKnowledge({ gwRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = tmpOf('satuwork-e2e-knowledge-gw')
  const GW_PORT = await freePort()
  const base = `http://127.0.0.1:${GW_PORT}`
  const schema = schemaOf('e2e_knowledge')
  log('\n# knowledge')

  // 向量表要 vector 扩展，装在 public 里（initializeKnowledgeVectors 认这个）。
  const hasVector = await withPg(null, async (c) => (await c.query(`select 1 from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='vector' and n.nspname='public'`)).rowCount > 0)
  if (!hasVector) {
    log('  - 跳过：库里没有 vector 扩展（交给 CI 的 knowledge-pgvector 那一档）')
    return
  }
  const embed = await mockEmbeddings()
  const { gw } = await startGateway({
    name: 'knowledge-gw',
    what: 'knowledge gateway',
    home: GW_HOME,
    schema,
    port: GW_PORT,
    env: {
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '0',
      // 入库跑在维护节拍上：跑快点，用例不用等半分钟。
      GATEWAY_ROUTINE_TICK_MS: '300',
      // 假向量服务听在 127.0.0.1：放行内网地址（生产上页面填的地址要过 SSRF 闸）。
      GATEWAY_KB_EMBEDDING_ALLOW_PRIVATE: '1',
    },
  })

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

    await test('向量模型：在平台页面上配，密钥不回显，存完自动建表', async () => {
      const before = await req(base, 'GET', '/platform/knowledge/embedding', { token: owner })
      assert(before.status === 200, `embedding ${before.status} ${before.text}`)
      assert(before.json.status.configured === false && before.json.status.source === 'none', `没配时该是 none：${before.text}`)
      assert(before.json.embedding.region === '', `没选过区域时不该默认中国区：${before.text}`)
      assert(before.json.presets.some((p) => p.id === 'siliconflow' && p.region === 'cn') && before.json.presets.some((p) => p.id === 'openai' && p.region === 'intl'), `预设该分区：${before.text}`)
      const off = await req(base, 'GET', orgPath('/config'), { token: admin })
      assert(off.json.enabled === false && /向量/.test(off.json.reason), `没配时知识库该关着：${off.text}`)

      const badUrl = await req(base, 'PUT', '/platform/knowledge/embedding', { token: owner, body: { provider: 'custom', baseUrl: 'http://example.com/v1', model: 'm' } })
      assert(badUrl.status === 400, `非 https 地址该 400：${badUrl.status} ${badUrl.text}`)
      const badProvider = await req(base, 'PUT', '/platform/knowledge/embedding', { token: owner, body: { provider: 'nope' } })
      assert(badProvider.status === 400, `不认识的服务该 400：${badProvider.status}`)
      const badBatch = await req(base, 'PUT', '/platform/knowledge/embedding', { token: owner, body: { region: 'intl', provider: 'custom', baseUrl: embed.url, model: 'm', batchSize: 100 } })
      assert(badBatch.status === 400 && /1 到 64/.test(badBatch.json.error), `单次条数越界该 400：${badBatch.status} ${badBatch.text}`)
      const wrongRegion = await req(base, 'PUT', '/platform/knowledge/embedding', { token: owner, body: { region: 'intl', provider: 'siliconflow' } })
      assert(wrongRegion.status === 400 && /区域/.test(wrongRegion.json.error), `国际区选国内预设该 400：${wrongRegion.status} ${wrongRegion.text}`)
      const keyFirst = await req(base, 'PUT', '/platform/knowledge/embedding/key', { token: owner, body: { provider: 'custom', secret: 'x' } })
      assert(keyFirst.status === 400, `自定义地址没存就填密钥该 400：${keyFirst.status}`)
      const notOwner = await req(base, 'PUT', '/platform/knowledge/embedding', { token: admin, body: { region: 'intl' } })
      assert(notOwner.status === 403 || notOwner.status === 401, `公司管理员不能改：${notOwner.status}`)

      const saved = await req(base, 'PUT', '/platform/knowledge/embedding', { token: owner, body: { region: 'intl', provider: 'custom', baseUrl: embed.url, model: 'e2e-embed', dimensions: true, batchSize: 4 } })
      assert(saved.status === 200, `save ${saved.status} ${saved.text}`)
      assert(saved.json.embedding.region === 'intl' && saved.json.embedding.provider === 'custom' && saved.json.embedding.batchSize === 4, `读回 ${saved.text}`)
      assert(saved.json.status.configured === false && saved.json.status.initialized === true, `没密钥也该先把表建好：${JSON.stringify(saved.json.status)}`)

      const key = await req(base, 'PUT', '/platform/knowledge/embedding/key', { token: owner, body: { provider: 'custom', secret: 'e2e-embed-secret' } })
      assert(key.status === 200 && key.json.keys.custom && key.json.status.configured === true, `key ${key.status} ${key.text}`)
      assert(!key.text.includes('e2e-embed-secret'), '密钥不该回显')
      const sneak = await req(base, 'POST', '/platform/credentials', { token: owner, body: { provider: 'kb-embedding:custom', secret: 'x' } })
      assert(sneak.status === 400, `向量密钥不能从供应商那条路存：${sneak.status}`)
      const creds = await req(base, 'GET', '/platform/credentials', { token: owner })
      assert(!creds.text.includes('kb-embedding'), `供应商清单里不该有向量密钥：${creds.text}`)

      const probe = await req(base, 'POST', '/platform/knowledge/embedding/test', { token: owner, body: {} })
      assert(probe.status === 200 && probe.json.ok === true && probe.json.dimension === 1024, `自检 ${probe.text}`)
      const last = embed.seen.bodies.at(-1)
      assert(last.model === 'e2e-embed' && last.dimensions === 1024 && last.auth === 'Bearer e2e-embed-secret', `请求形状 ${JSON.stringify(last)}`)
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

      // 直传收不下来（比登记的大得多）：413，而且登记当场撤掉、容量释放，不留一行 uploading 等清扫。
      const small = await req(base, 'POST', orgPath(`/${kbA}/files`), { token: admin, body: { name: 'too-big.txt', bytes: 10 } })
      assert(small.status === 201, `register small ${small.status} ${small.text}`)
      const over = await req(base, 'PUT', small.json.upload.url, { token: admin, raw: Buffer.alloc(5000, 97), headers: { 'content-type': 'application/octet-stream' } })
      assert(over.status === 413, `超大该 413：${over.status} ${over.text}`)
      const afterOver = await req(base, 'GET', orgPath(`/${kbA}`), { token: admin })
      assert(!afterOver.json.files.some((x) => x.id === small.json.file.id), '收不下来的登记该当场撤掉')
      assert(afterOver.json.knowledge.bytesUsed === Buffer.byteLength(handbook), `容量该释放：${afterOver.json.knowledge.bytesUsed}`)

      const ready = await until(async () => {
        const d = await req(base, 'GET', orgPath(`/${kbA}`), { token: admin })
        const f = d.json.files.find((x) => x.id === fileId)
        if (f?.status === 'failed') throw new Error(`入库失败：${f.error}`)
        return f?.status === 'ready' ? d.json : null
      }, { what: '入库完成' })
      const f = ready.files.find((x) => x.id === fileId)
      assert(f.chunkCount >= 2 && f.chunkDone === f.chunkCount, `该切成至少两片：${JSON.stringify(f)}`)
      assert(ready.knowledge.chunkCount === f.chunkCount && ready.knowledge.fileCount === 1, `计数 ${JSON.stringify(ready.knowledge)}`)
      const stored = await withPg(schema, async c => (await c.query('select c.text,f.name from knowledge_chunk_vectors v join knowledge_chunks c on c.id=v."chunkId" join knowledge_files f on f.id=c."fileId" where c."kbId"=$1',[kbA])).rows.map(r => ({data:r.text,metadata:{text:r.text,fileName:r.name}})))
      assert(stored.length === f.chunkCount, `向量库里该有 ${f.chunkCount} 条`)
      const one = stored[0]
      assert(one.metadata.fileName === '员工手册 2025.md' && typeof one.metadata.text === 'string' && one.data.includes('《员工手册 2025》'), `元数据 ${JSON.stringify(one.metadata).slice(0, 200)}`)
      // 入库落了一行账（kind = kb），金额 0（单价默认 0）。
      const charges = await req(base, 'GET', `/orgs/${orgId}/charges?kind=kb`, { token: admin })
      assert(charges.status === 200, `charges ${charges.status} ${charges.text}`)
      const rows = (charges.json.charges || charges.json.items || []).filter((c) => c.kind === 'kb')
      assert(rows.some((c) => c.subject === 'kb:ingest'), `账本里该有 kb:ingest：${charges.text.slice(0, 300)}`)
      // 单次条数跟着配置走：设的是 4，一批不该多于 4 条。
      assert(embed.seen.bodies.every((b) => b.inputs <= 4), `批量超了：${JSON.stringify(embed.seen.bodies.map((b) => b.inputs))}`)
    })

    await test('pgvector：公司隔离、模型校验、幂等写入和重建', async () => {
      const stored = await withPg(schema, async c => (await c.query('select v.embedding::text from knowledge_chunk_vectors v join knowledge_chunks c on c.id=v."chunkId" where c."fileId"=$1 order by c.no limit 1', [fileId])).rows[0].embedding)
      const code = `
        import assert from 'node:assert/strict';
        import { Db } from './src/db.ts';
        import { loadEmbeddingConfig } from './src/lib/knowledge-embedding.ts';
        const db=new Db({url:process.env.GATEWAY_DATABASE_URL,schema:process.env.GATEWAY_PG_SCHEMA});
        try {
          const kb=await db.knowledgeBase(process.env.TEST_KB);
          const chunk=(await db.knowledgeChunks(process.env.TEST_FILE,0,1))[0];
          const cfg=await loadEmbeddingConfig(db);
          const rows=[{id:chunk.id,data:chunk.text,vector:JSON.parse(process.env.TEST_VECTOR)}];
          const before=await db.knowledgeVectorCount();
          await assert.rejects(db.upsertKnowledgeVectors({...kb,companyId:'wrong-company'},cfg.profile,rows),/不属于/);
          await assert.rejects(db.upsertKnowledgeVectors(kb,'wrong-profile',rows),/已变更/);
          await db.upsertKnowledgeVectors(kb,cfg.profile,rows);
          assert.equal(await db.knowledgeVectorCount(),before);
          assert.deepEqual(await db.queryKnowledgeVectors({...kb,companyId:'wrong-company'},cfg.profile,rows[0].vector,6),[]);
          await db.deleteKnowledgeVectors({...kb,companyId:'wrong-company'});
          assert.equal(await db.knowledgeVectorCount(),before);
          await assert.rejects(db.initializeKnowledgeVectors('wrong-profile',cfg.model,1024),/变更/);
          assert.ok(await db.reindexKnowledgeVectors(cfg.profile,cfg.model,1024)>=1);
        } finally { await db.close(); }
      `
      execFileSync(process.execPath, ['--import','tsx','--input-type=module','-e',code], { cwd:gwRoot, env:{...process.env,GATEWAY_DATABASE_URL:PG_URL,GATEWAY_PG_SCHEMA:schema,TEST_KB:kbA,TEST_FILE:fileId,TEST_VECTOR:stored},stdio:'pipe' })
      await until(async () => {
        const r=await req(base,'GET',orgPath(`/${kbA}`),{token:admin})
        return r.json.files.find(f=>f.id===fileId)?.status==='ready'
      },{what:'重建后的入库完成'})
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

    await test('换模型：有旧向量时检索暂停、提示重建；重建后重新入库、检索恢复', async () => {
      const unconfirmed = await req(base, 'PUT', '/platform/knowledge/embedding', { token: owner, body: { model: 'e2e-embed-2' } })
      assert(unconfirmed.status === 409 && /重建/.test(unconfirmed.json.error), `有向量时换模型要先确认：${unconfirmed.status} ${unconfirmed.text}`)
      const still = await req(base, 'GET', '/platform/knowledge/embedding', { token: owner })
      assert(still.json.embedding.model === 'e2e-embed' && still.json.status.profileMatches === true, `没确认就不该改：${still.text}`)
      const changed = await req(base, 'PUT', '/platform/knowledge/embedding', { token: owner, body: { model: 'e2e-embed-2', confirm: true } })
      assert(changed.status === 200, `change ${changed.status} ${changed.text}`)
      const st = changed.json.status
      assert(st.profileMatches === false && st.storedModel === 'e2e-embed' && st.vectors > 0 && /重建/.test(st.error), `该提示重建：${JSON.stringify(st)}`)
      const paused = await req(base, 'POST', orgPath('/search'), { token: admin, body: { query: '年假有几天', kbIds: [kbA] } })
      assert(paused.status === 503 && /重建/.test(paused.json.error), `模型不一致时检索该暂停：${paused.status} ${paused.text}`)

      // 等重建期间新传的文件只排队：入库节拍不领它，过了好几拍（> 连续失败上限 5）也不会被标失败。
      const note = '加班：工作日加班按 1.5 倍计薪，周末 2 倍。'
      const reg = await req(base, 'POST', orgPath(`/${kbA}/files`), { token: admin, body: { name: '加班.txt', bytes: Buffer.byteLength(note), mime: 'text/plain' } })
      assert(reg.status === 201, `register ${reg.status} ${reg.text}`)
      const put = await req(base, 'PUT', reg.json.upload.url, { token: admin, raw: Buffer.from(note), headers: { 'content-type': 'application/octet-stream' } })
      assert(put.status === 200, `put ${put.status} ${put.text}`)
      await new Promise((r) => setTimeout(r, 300 * 8))
      const waiting = await req(base, 'GET', orgPath(`/${kbA}`), { token: admin })
      const extra = waiting.json.files.find((f) => f.id === reg.json.file.id)
      assert(extra.status === 'queued', `等重建时该一直排队：${JSON.stringify(extra)}`)

      const re = await req(base, 'POST', '/platform/knowledge/reindex', { token: owner, body: {} })
      assert(re.status === 200 && re.json.queued >= 1 && re.json.status.profileMatches === true && re.json.status.storedModel === 'e2e-embed-2', `reindex ${re.status} ${re.text}`)
      await until(async () => {
        const r = await req(base, 'GET', orgPath(`/${kbA}`), { token: admin })
        return r.json.files.find((f) => f.id === fileId)?.status === 'ready'
      }, { what: '换模型后重新入库' })
      assert(embed.seen.bodies.some((b) => b.model === 'e2e-embed-2'), '重建该用新模型')
      await until(async () => {
        const r = await req(base, 'GET', orgPath(`/${kbA}`), { token: admin })
        return r.json.files.find((f) => f.id === reg.json.file.id)?.status === 'ready'
      }, { what: '排队的新文件在重建后入库' })
      // 后面的用例按「库里只有那一份手册」数，把它删掉。
      const del = await req(base, 'DELETE', orgPath(`/${kbA}/files/${reg.json.file.id}`), { token: admin })
      assert(del.status === 200, `del ${del.status} ${del.text}`)
      const back = await req(base, 'POST', orgPath('/search'), { token: admin, body: { query: '年假有几天', kbIds: [kbA] } })
      assert(back.status === 200 && back.json.hits.length >= 1, `重建后该查得到：${back.text}`)
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

    await test('Bot 自己关掉一个共享过来的库：设置页看得见、目录和检索都不带它，打开又回来', async () => {
      const detail = await req(base, 'GET', `/runtime/bots/${botId}`, { token: member })
      assert(detail.status === 200, `bot ${detail.status} ${detail.text}`)
      assert(Array.isArray(detail.json.bot.knowledge) && detail.json.bot.knowledge.some((k) => k.id === kbA && k.off === false), `设置页该列出 A：${JSON.stringify(detail.json.bot.knowledge)}`)
      assert(!detail.json.bot.knowledge.some((k) => k.id === kbB), `none 的 B 不该出现：${JSON.stringify(detail.json.bot.knowledge)}`)

      // 关掉 A；顺手塞一个没共享的 B，服务端该丢掉它而不是报错。
      const off = await req(base, 'PATCH', `/runtime/bots/${botId}`, { token: member, body: { knowledgeOff: [kbA, kbB] } })
      assert(off.status === 200, `patch ${off.status} ${off.text}`)
      assert(off.json.bot.knowledgeOff.join() === kbA, `knowledgeOff ${JSON.stringify(off.json.bot.knowledgeOff)}`)
      assert(off.json.bot.knowledge.find((k) => k.id === kbA)?.off === true, `A 该标成关：${JSON.stringify(off.json.bot.knowledge)}`)
      const cat = await req(base, 'GET', `/runtime/catalog?botId=${botId}`, { token: seatTok })
      assert(cat.json.knowledge.length === 0, `关掉后目录不该再带 A：${JSON.stringify(cat.json.knowledge)}`)
      const s = await req(base, 'POST', `/runtime/knowledge/search?botId=${botId}`, { token: seatTok, body: { query: '报销' } })
      assert(s.json.ok === false, `关掉后席位该查不到：${s.text}`)

      const on = await req(base, 'PATCH', `/runtime/bots/${botId}`, { token: member, body: { knowledgeOff: [] } })
      assert(on.json.bot.knowledgeOff.length === 0, `打开 ${on.text}`)
      const back = await req(base, 'GET', `/runtime/catalog?botId=${botId}`, { token: seatTok })
      assert(back.json.knowledge.length === 1, `打开后目录该回来：${JSON.stringify(back.json.knowledge)}`)
    })

    await test('从 Upstash 迁过来：表没建时检索暂停；建表后报出没有向量的文件，点重建才重新入库', async () => {
      await withPg(schema, (c) => c.query('drop table knowledge_chunk_vectors, knowledge_vector_config'))
      const st = await req(base, 'GET', '/platform/knowledge/status', { token: owner })
      assert(st.json.initialized === false, `删表后该是未初始化：${st.text}`)
      const off = await req(base, 'POST', orgPath('/search'), { token: admin, body: { query: '年假有几天', kbIds: [kbA] } })
      assert(off.status === 503 && /没建好/.test(off.json.error), `表没建时检索该暂停：${off.status} ${off.text}`)
      const init = await req(base, 'POST', '/platform/knowledge/init', { token: owner, body: {} })
      assert(init.status === 200 && init.json.status.initialized === true && init.json.status.profileMatches === true, `init ${init.status} ${init.text}`)
      // 建表不自动重新入库（那一下要计费）：文件还是「可用」，但没有向量，状态里报出来等人点重建。
      assert(init.json.status.unindexed === 1, `该报 1 个没有向量的文件：${JSON.stringify(init.json.status)}`)
      const empty = await req(base, 'POST', orgPath('/search'), { token: admin, body: { query: '年假有几天', kbIds: [kbA] } })
      assert(empty.status === 200 && empty.json.hits.length === 0, `重建前该查不到：${empty.text}`)
      const re = await req(base, 'POST', '/platform/knowledge/reindex', { token: owner, body: {} })
      assert(re.status === 200 && re.json.queued >= 1, `reindex ${re.status} ${re.text}`)
      await until(async () => {
        const r = await req(base, 'GET', orgPath(`/${kbA}`), { token: admin })
        return r.json.files.find((f) => f.id === fileId)?.status === 'ready'
      }, { what: '重建后重新入库' })
      const hit = await req(base, 'POST', orgPath('/search'), { token: admin, body: { query: '年假有几天', kbIds: [kbA] } })
      assert(hit.status === 200 && hit.json.hits.length >= 1, `迁移后该查得到：${hit.text}`)
    })

    await test('下载原文件：带登录态的走得通，内容一致', async () => {
      const r = await req(base, 'GET', orgPath(`/${kbA}/files/${fileId}/download`), { token: member })
      assert(r.status === 200, `download ${r.status}`)
      assert(r.text === handbook, '下载回来的和传上去的不一样')
      assert(/attachment/.test(r.headers.get('content-disposition') || ''), 'disposition')
      const anon = await req(base, 'GET', orgPath(`/${kbA}/files/${fileId}/download`))
      assert(anon.status === 401, `匿名该 401：${anon.status}`)
    })

    await test('删文件：向量跟着删、容量释放；删库：列表当场消失，节拍收尾', async () => {
      const del = await req(base, 'DELETE', orgPath(`/${kbA}/files/${fileId}`), { token: admin })
      assert(del.status === 200, `del ${del.status} ${del.text}`)
      const count = await withPg(schema, async c => (await c.query('select count(*) as n from knowledge_chunk_vectors')).rows[0].n)
      assert(Number(count) === 0, '删文件后向量应全部清理')
      const d = await req(base, 'GET', orgPath(`/${kbA}`), { token: admin })
      assert(d.json.knowledge.bytesUsed === 0 && d.json.knowledge.fileCount === 0 && d.json.knowledge.chunkCount === 0, `删后计数 ${JSON.stringify(d.json.knowledge)}`)
      const catAfter = await req(base, 'GET', `/runtime/catalog?botId=${botId}`, { token: seatTok })
      assert(catAfter.json.knowledge.length === 0, `没有可用文件的库不下发：${JSON.stringify(catAfter.json.knowledge)}`)

      const gone = await req(base, 'DELETE', orgPath(`/${kbB}`), { token: admin })
      assert(gone.status === 200, `delete kb ${gone.status} ${gone.text}`)
      const list = await req(base, 'GET', orgPath(), { token: admin })
      assert(list.json.knowledge.length === 1 && list.json.used === 1, `删后列表 ${list.text}`)
      await until(() => withPg(schema, async c => (await c.query('select count(*) as n from knowledge_bases where id=$1', [kbB])).rows[0].n === '0'), { what: '删除知识库' })
      // 名额腾出来了，再建一个能成。
      const c = await req(base, 'POST', orgPath(), { token: admin, body: { name: '产品手册', share: 'all' } })
      assert(c.status === 201, `腾位后再建 ${c.status} ${c.text}`)
    })

    await test('自定义地址换了主机：旧密钥不再发出去，要重新填', async () => {
      const other = embed.url.replace('127.0.0.1', 'localhost')
      const moved = await req(base, 'PUT', '/platform/knowledge/embedding', { token: owner, body: { baseUrl: other, confirm: true } })
      assert(moved.status === 200, `move ${moved.status} ${moved.text}`)
      assert(!moved.json.keys.custom && moved.json.status.configured === false, `换主机后该没有密钥：${JSON.stringify({ keys: moved.json.keys, status: moved.json.status })}`)
      const before = embed.seen.bodies.length
      const probe = await req(base, 'POST', '/platform/knowledge/embedding/test', { token: owner, body: {} })
      assert(probe.json.ok === false && embed.seen.bodies.length === before, `没有密钥时不该发请求：${probe.text}`)
      const creds = await withPg(schema, async (c) => (await c.query(`select provider from platform_credentials where provider like 'kb-embedding:%'`)).rows.map((r) => r.provider))
      assert(!creds.some((p) => p.includes('127.0.0.1')), `旧主机的密钥该删掉：${creds}`)
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
    await closeServer(embed.server, 'mock embeddings')
  }
}
