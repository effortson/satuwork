/**
 * 主 Gateway 套件（从 run.mjs 搬出来的 runGateway）：起一个带种子 owner 的 Gateway，
 * 把账号、组织、Bot、审计这些主干接口挨个过一遍。
 */
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { PG_URL } from './pg.mjs'
import { schemaOf } from './isolate.mjs'
import { createCompany } from './org.mjs'
import { closeServer } from './probe.mjs'
import { uiSource } from './ui-dom.mjs'
import { dumpHas, listenMock, treeHas } from './harness.mjs'

const MACHINE_TOK = 'e2e-machine-token'
const PLATFORM_TOK = 'e2e-platform-token'

export async function runGateway({ gwRoot, botRoot, gwHome: GW_HOME, gwPort: GW_PORT, test, req, start, waitHttp, assert, log }) {
  log('\n# gateway')
  rmSync(GW_HOME, { recursive: true, force: true })
  const base = `http://127.0.0.1:${GW_PORT}`
  const child = start('gateway', ['--import', 'tsx', join(gwRoot, 'src/index.ts')], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: schemaOf('e2e_main'),
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_MACHINE_TOKEN: MACHINE_TOK,
      GATEWAY_PLATFORM_TOKEN: PLATFORM_TOK,
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '1',
      GATEWAY_OWNER_EMAIL: 'owner@satuwork.test',
      GATEWAY_OWNER_PASSWORD: 'test-owner-3080',
    },
  })
  // 带上 child：起不来时有用的是它的输出，不是三十秒后那句「等不到」。
  await waitHttp(base + '/health', { child, what: 'gateway' })

  let token
  let orgId
  let memberTok
  let ownerTok
  let botId
  let skillId
  let orgMachineTok
  const secret = 'sk-e2e-never-leak'

  await test('建公司走 owner 那条路：公司 + 管理员 + 席位', async () => {
    // 以前这条打的是 `POST /auth/register`——一次无鉴权请求建出公司加 admin。
    // 那条路没有任何产品入口用，却默认开着，已经删了；这里走界面真正走的那条。
    const made = await createCompany(req, base, {
      ownerEmail: 'owner@satuwork.test',
      ownerPassword: 'test-owner-3080',
      email: 'admin@acme.test',
      password: 'correct-horse',
      companyName: 'Acme',
      slug: 'acme',
      seats: 2,
    })
    assert(typeof made.token === 'string' && made.token.split('.').length === 3, 'jwt')
    assert(made.account.role === 'admin', 'admin')
    assert(made.company.slug === 'acme', 'company')
    assert(made.account.email === 'admin@acme.test', 'email')
    assert(!dumpHas(made.account, 'passwordHash'), '口令哈希不得出现')
    token = made.token
    orgId = made.company.id
    ownerTok = made.ownerToken

    // 没票打不开这家公司——建公司这条本来就是 owner-only 的。
    const anon = await req(base, 'GET', `/orgs/${orgId}`)
    assert(anon.status === 401, `无票读公司应 401，得到 ${anon.status}`)
  })

  await test('POST /auth/login → JWT', async () => {
    const r = await req(base, 'POST', '/auth/login', {
      body: { email: 'admin@acme.test', password: 'correct-horse' },
    })
    assert(r.status === 200, `login ${r.status} ${r.text}`)
    assert(typeof r.json.token === 'string' && r.json.token.split('.').length === 3, 'jwt')
    token = r.json.token
  })

  await test('GET /me → account, company, accessUrl（派机器之后）', async () => {
    const before = await req(base, 'GET', '/me', { token })
    assert(before.status === 200, `me ${before.status}`)
    assert(before.json.account.role === 'admin', 'account')
    assert(before.json.company.id === orgId, 'company')
    assert(before.json.plan.seats === 2, 'plan')
    assert(before.json.company.accessUrl == null, '派机器前不该有 accessUrl')

    // 机器地址是平台的事：管理员写 host 会被挡下，否则他能把 Gateway 的服务端拉取
    // 指到自己的服务器上，连 smt_ 一起送过去。
    const machHost = await req(base, 'POST', `/orgs/${orgId}/machine`, {
      token,
      body: { host: '10.0.0.1' },
    })
    assert(machHost.status === 403, `admin 写 host ${machHost.status} ${machHost.text}`)

    // 建机器、认领没归属的机器是平台的事：管理员不带 id、带一个不存在的 id、带一台
    // 预登记还没派给本公司的机器，都不该成——以前后两种会就地建一行空机器 / 抢先认走。
    const noId = await req(base, 'POST', `/orgs/${orgId}/machine`, { token, body: {} })
    assert(noId.status === 400, `admin 不带 id ${noId.status} ${noId.text}`)
    const ghostId = await req(base, 'POST', `/orgs/${orgId}/machine`, { token, body: { id: 'no-such-machine' } })
    assert(ghostId.status === 404, `admin 给不存在的 id ${ghostId.status} ${ghostId.text}`)
    const pre = await req(base, 'POST', '/internal/machines', { token: MACHINE_TOK, body: {} })
    assert(pre.status === 201, `预登记 ${pre.status} ${pre.text}`)
    const grab = await req(base, 'POST', `/orgs/${orgId}/machine`, { token, body: { id: pre.json.machine.id } })
    assert(grab.status === 403, `admin 认领预登记机器 ${grab.status} ${grab.text}`)
    const viaPatch = await req(base, 'PATCH', `/orgs/${orgId}`, { token, body: { machineId: pre.json.machine.id } })
    assert(viaPatch.status === 403, `admin 走 PATCH 认领 ${viaPatch.status} ${viaPatch.text}`)
    const noRow = await req(base, 'GET', `/orgs/${orgId}/machine`, { token })
    assert(noRow.status === 200 && noRow.json.machine == null, `被拒之后不该留下机器：${noRow.text}`)

    const mach = await req(base, 'POST', `/orgs/${orgId}/machine`, { token: ownerTok, body: {} })
    assert(mach.status === 201, `machine ${mach.status} ${mach.text}`)
    assert(mach.json.company.accessUrl === 'https://acme.satuwork.com', 'accessUrl')
    assert(!mach.json.machine.token, 'admin assign 带了 token')
    assert(!JSON.stringify(mach.json).includes('smt_'), 'admin assign 泄漏 smt_')

    const me = await req(base, 'GET', '/me', { token })
    assert(me.status === 200, `me2 ${me.status}`)
    assert(me.json.account.id, 'account')
    assert(me.json.company.id === orgId, 'company')
    assert(me.json.company.accessUrl === 'https://acme.satuwork.com', 'me.accessUrl')
  })

  await test('GET /jwks', async () => {
    const r = await req(base, 'GET', '/jwks')
    assert(r.status === 200, `jwks ${r.status}`)
    assert(Array.isArray(r.json.keys) && r.json.keys[0]?.kty === 'RSA', 'RSA jwk')
  })

  await test('席位用满后再加账号 → 409', async () => {
    const a = await req(base, 'POST', `/orgs/${orgId}/accounts`, {
      token,
      body: { email: 'member@acme.test', password: 'correct-horse', role: 'member' },
    })
    assert(a.status === 201, `member ${a.status} ${a.text}`)
    const full = await req(base, 'POST', `/orgs/${orgId}/accounts`, {
      token,
      body: { email: 'third@acme.test', password: 'correct-horse' },
    })
    assert(full.status === 409, `seat ${full.status} ${full.text}`)
    assert(full.json.error === '席位已满', '席位已满')
    const login = await req(base, 'POST', '/auth/login', {
      body: { email: 'member@acme.test', password: 'correct-horse' },
    })
    assert(login.status === 200, 'member login')
    memberTok = login.json.token
  })

  await test('自己建 Bot / 管理员 CRUD 公司 skill；目录可见；成员不能写 skill', async () => {
    // Bot 现在是**每个人自己的**：管理员也走这条，公司那一层只剩一份模版。
    const created = await req(base, 'POST', '/runtime/bots', {
      token,
      body: { name: '公司助手' },
    })
    assert(created.status === 201, `bot ${created.status} ${created.text}`)
    assert(created.json.bot.scope === 'user', 'user bot')
    botId = created.json.bot.id

    const patched = await req(base, 'PATCH', `/runtime/bots/${botId}`, {
      token,
      body: { name: '公司助手改' },
    })
    assert(patched.status === 200, `patch bot ${patched.status}`)
    assert(patched.json.bot.name === '公司助手改', 'renamed')

    const got = await req(base, 'GET', `/runtime/bots/${botId}`, { token })
    assert(got.status === 200 && got.json.bot.name === '公司助手改', 'get bot')

    const skill = await req(base, 'POST', `/orgs/${orgId}/skills`, {
      token,
      body: { name: '内部技能', body: '步骤' },
    })
    assert(skill.status === 201, `skill ${skill.status} ${skill.text}`)
    assert(skill.json.skill && skill.json.skill.name === '内部技能', 'skill shape')
    skillId = skill.json.skill.id
    const skillPatch = await req(base, 'PATCH', `/orgs/${orgId}/skills/${skillId}`, {
      token,
      body: { name: '内部技能改' },
    })
    assert(skillPatch.status === 200, 'patch skill')
    assert(skillPatch.json.skill && skillPatch.json.skill.name === '内部技能改', 'patched skill')
    const skills = await req(base, 'GET', '/catalog/skills', { token })
    assert(skills.json.items.some((i) => i.id === skillId), 'catalog 看见 skill')

    // 员工建自己的 Bot 是**允许**的；不许的是碰公司这一层的东西。
    const ownBot = await req(base, 'POST', '/runtime/bots', {
      token: memberTok,
      body: { name: '员工自己的' },
    })
    assert(ownBot.status === 201, `member bot ${ownBot.status} ${ownBot.text}`)
    const denySkill = await req(base, 'POST', `/orgs/${orgId}/skills`, {
      token: memberTok,
      body: { name: '不该成功' },
    })
    assert(denySkill.status === 403, `member skill ${denySkill.status}`)
    // 但改不了别人那一个：这条是「只有主人看得见」的另一面。
    const denyPatch = await req(base, 'PATCH', `/runtime/bots/${botId}`, {
      token: memberTok,
      body: { name: '不该成功' },
    })
    assert(denyPatch.status === 404, `member patch ${denyPatch.status}`)
    await req(base, 'DELETE', `/runtime/bots/${ownBot.json.bot.id}`, { token: memberTok })

    const del = await req(base, 'DELETE', `/runtime/bots/${botId}`, { token })
    assert(del.status === 200 && del.json.deleted === true, 'delete bot')
    const delS = await req(base, 'DELETE', `/orgs/${orgId}/skills/${skillId}`, { token })
    assert(delS.status === 200 && delS.json.deleted === true, 'delete skill')
  })

  await test('owner platform credentials；公司那条 /orgs/:id/credentials 已经整条撤了', async () => {
    const ownerLogin = await req(base, 'POST', '/auth/login', {
      body: { email: 'owner@satuwork.test', password: 'test-owner-3080' },
    })
    assert(ownerLogin.status === 200, `owner login ${ownerLogin.status} ${ownerLogin.text}`)
    ownerTok = ownerLogin.json.token
    const platMach = await req(base, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
    assert(platMach.status === 200, `plat machine ${platMach.status} ${platMach.text}`)
    assert(typeof platMach.json.machine.token === 'string' && platMach.json.machine.token.startsWith('smt_'), 'owner 应看见 smt_')
    orgMachineTok = platMach.json.machine.token
    const orgMach = await req(base, 'GET', `/orgs/${orgId}/machine`, { token })
    assert(orgMach.status === 200, `org machine ${orgMach.status}`)
    assert(!orgMach.json.machine.token, '公司 machine JSON 带了 token')
    assert(!JSON.stringify(orgMach.json).includes(orgMachineTok), '公司 JSON 泄漏 smt_')

    const created = await req(base, 'POST', '/platform/credentials', {
      token: ownerTok,
      body: { provider: 'deepseek', secret },
    })
    assert(created.status === 201, `cred ${created.status} ${created.text}`)
    assert(created.json.credential.configured === true, 'create configured')
    assert(created.json.credential.provider === 'deepseek', 'provider')
    assert(!dumpHas(created.json, secret), 'create 泄漏 secret')
    assert(!Object.prototype.hasOwnProperty.call(created.json.credential, 'secret'), 'create 带 secret 字段')

    const put = await req(base, 'PUT', '/platform/credentials/deepseek', {
      token: ownerTok,
      body: { secret: 'sk-e2e-rotated-never-leak' },
    })
    assert(put.status === 200, `put ${put.status} ${put.text}`)
    assert(put.json.credential.configured === true, 'put configured')
    assert(!dumpHas(put.json, secret), 'put 泄漏旧 secret')
    assert(!dumpHas(put.json, 'sk-e2e-rotated-never-leak'), 'put 泄漏新 secret')

    const plat = await req(base, 'GET', '/platform/credentials', { token: ownerTok })
    assert(plat.status === 200, `plat list ${plat.status}`)
    assert(plat.json.credentials.some((c) => c.provider === 'deepseek' && c.configured === true), 'plat list deepseek')
    assert(!dumpHas(plat.json, secret), 'plat list 泄漏')
    assert(!dumpHas(plat.json, 'sk-e2e-rotated-never-leak'), 'plat list 泄漏新 secret')

    /**
     * **公司那一层撤了。** 这里曾经验的是「公司管理员配得了自家密钥、压过平台那把，
     * 普通成员只能看」。现在供应商只由平台配：`/orgs/:id/credentials` 这四条路由
     * （列表、详情、POST/PUT、DELETE）一条都不在了。
     *
     * 断言的是 **404 而不是 403**：403 的意思是「这条路在，只是你不配走」，那会让
     * 半条路（比如只撤了写、GET 还开着）看起来是对的。整条撤干净只有 404 能证明。
     *
     * 管理员和普通成员都验一遍：这不是权限收紧，是接口没了，谁来都一样。
     */
    for (const [who, tok] of [['admin', token], ['member', memberTok]]) {
      const ls = await req(base, 'GET', `/orgs/${orgId}/credentials`, { token: tok })
      assert(ls.status === 404, `${who} GET 公司密钥该 404，实际 ${ls.status} ${ls.text}`)
      const one = await req(base, 'GET', `/orgs/${orgId}/credentials/deepseek`, { token: tok })
      assert(one.status === 404, `${who} GET 单条该 404，实际 ${one.status}`)
      const post = await req(base, 'POST', `/orgs/${orgId}/credentials`, { token: tok, body: { provider: 'openai', secret } })
      assert(post.status === 404, `${who} POST 该 404，实际 ${post.status} ${post.text}`)
      const put = await req(base, 'PUT', `/orgs/${orgId}/credentials/openai`, { token: tok, body: { secret } })
      assert(put.status === 404, `${who} PUT 该 404，实际 ${put.status}`)
      const del = await req(base, 'DELETE', `/orgs/${orgId}/credentials/openai`, { token: tok })
      assert(del.status === 404, `${who} DELETE 该 404，实际 ${del.status}`)
    }

    // 连通性探测的公司那条同样撤了——它探的是「这家公司打得通吗」，而密钥归平台之后
    // 答案对所有公司都一样，该在 POST /platform/llm/test 问。
    const probe = await req(base, 'POST', `/orgs/${orgId}/llm/test`, { token, body: { provider: 'deepseek' } })
    assert(probe.status === 404, `公司侧 llm/test 该 404，实际 ${probe.status} ${probe.text}`)
  })

  await test('缺 GATEWAY_MACHINE_TOKEN 的 /internal/* → 401', async () => {
    const a = await req(base, 'POST', '/internal/machines', { body: { host: '10.0.0.2' } })
    assert(a.status === 401, `machines ${a.status}`)
    const b = await req(base, 'POST', '/internal/machines/x/heartbeat')
    assert(b.status === 401, `heartbeat ${b.status}`)
    const c = await req(base, 'POST', '/internal/sessions/index', { body: {} })
    assert(c.status === 401, `sessions ${c.status}`)
  })

  await test('登记机器时 host 要是干净的 http/https 地址', async () => {
    // host 会被 Gateway 带着 smt_ 去 fetch，路径 / 凭证 / 别的协议一律不收。
    for (const host of [
      'http://127.0.0.1:9/internal/sessions/x',
      'http://user:pw@127.0.0.1:9',
      'file:///etc/passwd',
      'http://127.0.0.1:9?a=1',
    ]) {
      const bad = await req(base, 'POST', '/internal/machines', { token: MACHINE_TOK, body: { host } })
      assert(bad.status === 400, `host ${host} 应 400，得到 ${bad.status} ${bad.text}`)
    }
    const ok = await req(base, 'POST', '/internal/machines', {
      token: MACHINE_TOK,
      body: { host: 'http://127.0.0.1:9' },
    })
    assert(ok.status === 201, `干净 host ${ok.status} ${ok.text}`)
    assert(ok.json.machine.host === 'http://127.0.0.1:9', `host 归一化 ${ok.json.machine.host}`)
    const bare = await req(base, 'POST', '/internal/machines', { token: MACHINE_TOK, body: { host: '10.0.0.7:3200' } })
    assert(bare.status === 201, `裸 host ${bare.status} ${bare.text}`)
    assert(bare.json.machine.host === '10.0.0.7:3200', `裸 host 应原样保留 ${bare.json.machine.host}`)
  })

  await test('引导票只能登记机器；心跳/索引/ready/用量要 smt_', async () => {
    const reg = await req(base, 'POST', '/internal/machines', { token: MACHINE_TOK, body: {} })
    assert(reg.status === 201, `register ${reg.status} ${reg.text}`)
    assert(typeof reg.json.machine.token === 'string' && reg.json.machine.token.startsWith('smt_'), '登记应返回 smt_')
    const smt = reg.json.machine.token
    const mid = reg.json.machine.id
    const publicReg = { ...reg.json.machine }
    delete publicReg.token
    assert(!JSON.stringify(publicReg).includes('smt_'), '登记公开字段含 smt_')

    const hbBoot = await req(base, 'POST', `/internal/machines/${mid}/heartbeat`, { token: MACHINE_TOK })
    assert(hbBoot.status === 401, `bootstrap heartbeat ${hbBoot.status}`)
    const idxBoot = await req(base, 'POST', '/internal/sessions/index', {
      token: MACHINE_TOK,
      body: { sessionId: 's-boot', companyId: orgId, accountId: 'x' },
    })
    assert(idxBoot.status === 401, `bootstrap index ${idxBoot.status}`)
    const readyBoot = await req(base, 'POST', '/internal/instances/no-such/ready', {
      token: MACHINE_TOK,
      body: { host: 'http://127.0.0.1:9', botId: 'b' },
    })
    assert(readyBoot.status === 401, `bootstrap ready ${readyBoot.status}`)

    const bind = await req(base, 'POST', `/orgs/${orgId}/machine`, { token: ownerTok, body: { id: mid } })
    assert(bind.status === 201, `bind ${bind.status} ${bind.text}`)
    assert(!bind.json.machine.token, 'bind 响应带 token')
    orgMachineTok = smt

    const hb = await req(base, 'POST', `/internal/machines/${mid}/heartbeat`, { token: smt })
    assert(hb.status === 200, `smt heartbeat ${hb.status} ${hb.text}`)
    const hbWrong = await req(base, 'POST', '/internal/machines/no-such/heartbeat', { token: smt })
    assert(hbWrong.status === 403, `heartbeat id mismatch ${hbWrong.status}`)
  })

  await test('GET /orgs/:id/audit 管理员能看操作记录；成员 403', async () => {
    const deny = await req(base, 'GET', `/orgs/${orgId}/audit`, { token: memberTok })
    assert(deny.status === 403, `member audit ${deny.status} ${deny.text}`)
    const r = await req(base, 'GET', `/orgs/${orgId}/audit`, { token })
    assert(r.status === 200, `audit ${r.status} ${r.text}`)
    assert(Array.isArray(r.json.events) && r.json.events.length > 0, '空操作记录')
    assert(r.json.events.some((e) => e.action === 'platform.org.create' || e.action === 'auth.login' || e.action === 'machine.assign'), '缺已知事件')
  })

  await test('对话审计：索引上报、筛选、成员 403、离线拉全文、不落正文', async () => {
    const UNIQUE = 'UNIQUE-BODY-MUST-NOT-LAND-ON-GATEWAY'
    const adminMe = await req(base, 'GET', '/me', { token })
    assert(adminMe.status === 200, `admin me ${adminMe.status}`)
    const memberMe = await req(base, 'GET', '/me', { token: memberTok })
    assert(memberMe.status === 200, `member me ${memberMe.status}`)
    const adminId = adminMe.json.account.id
    const memberId = memberMe.json.account.id
    const t1 = 1_700_000_000_000
    const t2 = 1_700_000_100_000

    assert(orgMachineTok && orgMachineTok.startsWith('smt_'), 'need bound machine token')
    const plat = await req(base, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
    const deadId = plat.json.machine.id
    assert(plat.json.machine.token === orgMachineTok, 'owner token 应对上')

    const a = await req(base, 'POST', '/internal/sessions/index', {
      token: orgMachineTok,
      body: {
        sessionId: 's-audit-early',
        companyId: orgId,
        accountId: adminId,
        botId: 'bot-audit',
        machineId: deadId,
        title: '早会话',
        origin: 'company',
        remoteId: 'bot-audit',
        messageCount: 3,
        createdAt: t1,
        updatedAt: t1,
        events: [{ type: 'user/message', data: { message: { content: [{ type: 'text', text: UNIQUE }] } } }],
      },
    })
    assert(a.status === 200, `index a ${a.status} ${a.text}`)
    assert(a.json.session.sessionId === 's-audit-early', 'sessionId a')
    assert(a.json.session.updatedAt === t1, 'updatedAt a')
    assert(!dumpHas(a.json, UNIQUE), 'index 响应带正文')

    const b = await req(base, 'POST', '/internal/sessions/index', {
      token: orgMachineTok,
      body: {
        sessionId: 's-audit-late',
        companyId: orgId,
        accountId: memberId,
        title: '晚会话',
        createdAt: t2,
        updatedAt: t2,
        machineId: deadId,
      },
    })
    assert(b.status === 200, `index b ${b.status} ${b.text}`)

    const listed = await req(base, 'GET', `/orgs/${orgId}/sessions`, { token })
    assert(listed.status === 200, `list ${listed.status} ${listed.text}`)
    assert(Array.isArray(listed.json.sessions) && listed.json.sessions.length >= 2, '应有两条')
    const ids = listed.json.sessions.map((x) => x.sessionId)
    assert(ids.includes('s-audit-early') && ids.includes('s-audit-late'), '缺会话')
    const early = listed.json.sessions.find((x) => x.sessionId === 's-audit-early')
    assert(early.accountId === adminId, 'early account')
    assert(early.accountName, 'accountName')
    assert(early.title === '早会话', 'title')
    assert(early.origin === 'company', 'origin')
    assert(early.remoteId === 'bot-audit', 'remoteId')
    assert(early.messageCount === 3, 'messageCount')
    assert(!dumpHas(listed.json, UNIQUE), 'list 带正文')
    assert(!Object.prototype.hasOwnProperty.call(early, 'events'), 'list 带 events')

    const one = await req(base, 'GET', `/orgs/${orgId}/sessions?accountId=${encodeURIComponent(adminId)}`, { token })
    assert(one.status === 200, `filter account ${one.status}`)
    assert(one.json.sessions.length === 1, `account filter ${one.json.sessions.length}`)
    assert(one.json.sessions[0].sessionId === 's-audit-early', 'account filter id')

    const byBot = await req(base, 'GET', `/orgs/${orgId}/sessions?botId=${encodeURIComponent('bot-audit')}`, { token })
    assert(byBot.status === 200, `filter bot ${byBot.status}`)
    assert(byBot.json.sessions.length === 1 && byBot.json.sessions[0].sessionId === 's-audit-early', 'bot filter')

    const ranged = await req(base, 'GET', `/orgs/${orgId}/sessions?from=${t1 + 1}&to=${t2}`, { token })
    assert(ranged.status === 200, `range ${ranged.status}`)
    assert(ranged.json.sessions.length === 1, `range len ${ranged.json.sessions.length}`)
    assert(ranged.json.sessions[0].sessionId === 's-audit-late', 'range id')

    const denyList = await req(base, 'GET', `/orgs/${orgId}/sessions`, { token: memberTok })
    assert(denyList.status === 403, `member list ${denyList.status} ${denyList.text}`)
    const denyOne = await req(base, 'GET', `/orgs/${orgId}/sessions/s-audit-early`, { token: memberTok })
    assert(denyOne.status === 403, `member get ${denyOne.status}`)

    const missing = await req(base, 'GET', `/orgs/${orgId}/sessions/s-not-here`, { token })
    assert(missing.status === 404, `missing ${missing.status} ${missing.text}`)

    const pulled = await req(base, 'GET', `/orgs/${orgId}/sessions/s-audit-early`, { token })
    assert(pulled.status === 200, `pull offline ${pulled.status} ${pulled.text}`)
    assert(pulled.json.session && pulled.json.session.sessionId === 's-audit-early', 'pull session')
    assert(pulled.json.events === null, 'events should be null')
    assert(pulled.json.pullError === '机器不在线，全文拉不下来', `pullError ${pulled.json.pullError}`)
    assert(!dumpHas(pulled.json, UNIQUE), 'pull 响应编造正文')
    assert(!treeHas(GW_HOME, UNIQUE), 'Gateway home 含正文')

    const audit = await req(base, 'GET', `/orgs/${orgId}/audit`, { token })
    assert(audit.status === 200, `audit after pull ${audit.status}`)
    const pullEv = audit.json.events.find((e) => e.action === 'session.pull')
    assert(pullEv, '缺 session.pull')
    assert(pullEv.detail && pullEv.detail.sessionId === 's-audit-early', 'pull detail sessionId')
    assert(!dumpHas(pullEv, UNIQUE), '审计里有正文')
  })

  await test('行为边界的表态落进审计', async () => {
    const adminMe = await req(base, 'GET', '/me', { token })
    const adminId = adminMe.json.account.id

    const ok = await req(base, 'POST', '/internal/guard-events', {
      token: orgMachineTok,
      body: {
        companyId: orgId,
        accountId: adminId,
        sessionId: 's-audit-early',
        botId: 'bot-audit',
        callId: 'call-1',
        tool: 'mcp_gmail_send_email',
        guard: 'no-external',
        outcome: 'blocked',
        reason: '这个 Bot 没有被授权使用 mcp_gmail_send_email 所在的外部系统',
        at: 1_700_000_200_000,
      },
    })
    assert(ok.status === 200, `guard-events ${ok.status} ${ok.text}`)

    const audit = await req(base, 'GET', `/orgs/${orgId}/audit`, { token })
    const hit = (audit.json.events || []).find((e) => e.action === 'bot.guard.blocked')
    assert(hit, '拦截没进审计')
    // 「拦了什么、哪条边界拦的」是管理员唯一会问的两个问题，两样都得在详情里。
    assert(hit.detail && hit.detail.guard === 'no-external', `guard ${JSON.stringify(hit.detail)}`)
    assert(hit.detail.tool === 'mcp_gmail_send_email', `tool ${JSON.stringify(hit.detail)}`)
    assert(hit.accountId === adminId, `accountId ${hit.accountId}`)

    // action 是按白名单拼的，不是原样收 body——那一栏进检索面，让上报方自己定义
    // 动作名的话，迟早会长出十几种拼写。
    const bogus = await req(base, 'POST', '/internal/guard-events', {
      token: orgMachineTok,
      body: { companyId: orgId, accountId: adminId, guard: '我自己编的', outcome: 'blocked', tool: 'x' },
    })
    assert(bogus.status === 400, `不认识的 guard 拿到 ${bogus.status}`)
    const bogusOutcome = await req(base, 'POST', '/internal/guard-events', {
      token: orgMachineTok,
      body: { companyId: orgId, accountId: adminId, guard: 'pii', outcome: '随便写的', tool: 'x' },
    })
    assert(bogusOutcome.status === 400, `不认识的 outcome 拿到 ${bogusOutcome.status}`)

    /**
     * **席位认识的每一条边界，这边都得收得下。**
     *
     * 两张表分处两个包：席位的 `GuardId`（bot/src/policy/index.ts）和 Gateway 的白名单
     * `GUARD_IDS`（routes/internal.ts）。加一条只改一边的后果不是报错——是席位拦得
     * 好好的、报上来一律 400，而席位的 outbox **没有重试上限**，于是每次拦截都留下
     * 一行永远重发的队列，审计里却一条记录都没有。「只拦不报」正是这条路要防的事。
     *
     * 所以这里**从席位源码里把那个联合类型读出来**逐个试，而不是手抄一份名单——
     * 手抄的那份下次照样会漏（同 bot/e2e-mounted.mjs 的工具名单）。
     */
    const guardSrc = readFileSync(join(botRoot, 'src/policy/index.ts'), 'utf8')
    const guardIds = [...(/export type GuardId =([^\n]+(?:\n\s*\|[^\n]+)*)/.exec(guardSrc)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
    assert(guardIds.length >= 4, `没从席位源码里读出 GuardId：${JSON.stringify(guardIds)}`)
    for (const g of guardIds) {
      const r = await req(base, 'POST', '/internal/guard-events', {
        token: orgMachineTok,
        body: { companyId: orgId, accountId: adminId, guard: g, outcome: 'blocked', tool: 'x' },
      })
      assert(r.status === 200, `席位认识的边界「${g}」Gateway 收不下（${r.status} ${r.text}）——两张名单漏了同步`)
    }

    // 别家公司的账号：报不进来。租户边界和会话索引那条是同一套口径。
    const outsider = await req(base, 'POST', '/internal/guard-events', {
      token: orgMachineTok,
      body: {
        companyId: orgId,
        accountId: '00000000-0000-4000-8000-000000000000',
        guard: 'pii',
        outcome: 'blocked',
        tool: 'x',
      },
    })
    assert(outsider.status === 403, `跨公司上报拿到 ${outsider.status}`)
  })

  await test('会话列表翻页：不漏行不重复，同一毫秒也分得开', async () => {
    const adminMe = await req(base, 'GET', '/me', { token })
    const adminId = adminMe.json.account.id
    // 三条 updatedAt 完全相同——只拿 updatedAt 当游标的话，这里要么漏要么无限循环。
    const SAME = 1_700_000_500_000
    const ids = ['s-page-a', 's-page-b', 's-page-c']
    for (const sessionId of ids) {
      const r = await req(base, 'POST', '/internal/sessions/index', {
        token: orgMachineTok,
        body: {
          sessionId,
          companyId: orgId,
          accountId: adminId,
          botId: 'bot-page',
          title: sessionId,
          messageCount: 1,
          createdAt: SAME,
          updatedAt: SAME,
        },
      })
      assert(r.status === 200, `建 ${sessionId} ${r.status} ${r.text}`)
    }

    const seen = []
    let cursor = ''
    let pages = 0
    for (; pages < 10; pages++) {
      const qs = `?botId=bot-page&limit=1${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`
      const r = await req(base, 'GET', `/orgs/${orgId}/sessions${qs}`, { token })
      assert(r.status === 200, `翻页 ${r.status} ${r.text}`)
      assert(r.json.sessions.length <= 1, `limit=1 却回了 ${r.json.sessions.length} 条`)
      seen.push(...r.json.sessions.map((x) => x.sessionId))
      if (!r.json.hasMore) break
      assert(r.json.nextCursor, 'hasMore 为真却没给 nextCursor')
      cursor = r.json.nextCursor
    }
    assert(pages < 10, '翻页没有终点，游标可能没在推进')
    assert(seen.length === ids.length, `应当正好 ${ids.length} 条，实际 ${seen.length}：${seen.join(',')}`)
    assert(new Set(seen).size === seen.length, `翻页翻出重复行：${seen.join(',')}`)
    for (const id of ids) assert(seen.includes(id), `翻页漏了 ${id}`)

    // 不带 cursor 时一次到底，并且明确说「没有更多」。
    const all = await req(base, 'GET', `/orgs/${orgId}/sessions?botId=bot-page`, { token })
    assert(all.status === 200, `整页 ${all.status} ${all.text}`)
    assert(all.json.sessions.length === ids.length, `整页应 ${ids.length} 条，实际 ${all.json.sessions.length}`)
    assert(all.json.hasMore === false, 'hasMore 应为 false')
    assert(all.json.nextCursor === null, 'nextCursor 应为 null')
    assert(typeof all.json.limit === 'number' && all.json.limit > 0, 'limit 应当带回去')
  })

  await test('对话审计：mock 机器在线时按需拉全文，Gateway 不落盘', async () => {
    const HELLO = 'AUDIT-OK-HELLO'
    let liveTok = ''
    const mock = await listenMock((req, res) => {
      // 这个 mock 演的是**管家**：它认 x-satuwork-machine 上的机器票，authorization 上
      // 那把是给 bot 的席位票，原样透传、管家不解读。两个头两把票，不再是同一把。
      if (
        req.url &&
        req.url.startsWith('/internal/sessions/') &&
        req.headers['x-satuwork-machine'] === liveTok &&
        String(req.headers.authorization || '').startsWith('Bearer sat_')
      ) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            events: [{ type: 'user/message', data: { message: { content: [{ type: 'text', text: HELLO }] } } }],
          }),
        )
        return
      }
      res.writeHead(404)
      res.end()
    })
    try {
      const adminMe = await req(base, 'GET', '/me', { token })
      const mach = await req(base, 'POST', '/internal/machines', {
        token: MACHINE_TOK,
        body: { host: mock.url },
      })
      assert(mach.status === 201, `mock machine ${mach.status} ${mach.text}`)
      liveTok = mach.json.machine.token
      assert(typeof liveTok === 'string' && liveTok.startsWith('smt_'), 'live smt_')
      const bind = await req(base, 'POST', `/orgs/${orgId}/machine`, { token: ownerTok, body: { id: mach.json.machine.id } })
      assert(bind.status === 201, `bind live ${bind.status} ${bind.text}`)
      orgMachineTok = liveTok
      const idx = await req(base, 'POST', '/internal/sessions/index', {
        token: liveTok,
        body: {
          sessionId: 's-audit-live',
          companyId: orgId,
          accountId: adminMe.json.account.id,
          machineId: mach.json.machine.id,
          title: '在线会话',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      })
      assert(idx.status === 200, `live index ${idx.status} ${idx.text}`)
      const pulled = await req(base, 'GET', `/orgs/${orgId}/sessions/s-audit-live`, { token })
      assert(pulled.status === 200, `live pull ${pulled.status} ${pulled.text}`)
      assert(Array.isArray(pulled.json.events) && pulled.json.events[0]?.type === 'user/message', 'events')
      assert(dumpHas(pulled.json, HELLO), '缺 AUDIT-OK-HELLO')
      assert(!pulled.json.pullError, '不应有 pullError')
      assert(!treeHas(GW_HOME, HELLO), 'Gateway home 含拉下来的正文')
    } finally {
      await closeServer(mock.server, '审计源替身')
    }
  })

  await test('SPA GET /audit 与 /audit/:id 返回 html', async () => {
    const a = await req(base, 'GET', '/audit')
    assert(a.status === 200, `spa /audit ${a.status}`)
    assert(String(a.text).includes('<!doctype html>') || String(a.text).includes('Satuwork'), 'spa html')
    const b = await req(base, 'GET', '/audit/s-audit-early')
    assert(b.status === 200, `spa /audit/:id ${b.status}`)
    assert(String(b.text).includes('<!doctype html>') || String(b.text).includes('Satuwork'), 'spa detail html')
  })

  await test('SPA GET /chat 与 /a/default 返回 html', async () => {
    const a = await req(base, 'GET', '/chat')
    assert(a.status === 200, `spa /chat ${a.status}`)
    assert(String(a.text).includes('<!doctype html>') || String(a.text).includes('Satuwork'), 'spa /chat html')
    const b = await req(base, 'GET', '/a/default')
    assert(b.status === 200, `spa /a ${b.status}`)
    assert(String(b.text).includes('<!doctype html>') || String(b.text).includes('Satuwork'), 'spa /a html')
  })

  await test('owner GET /runtime/bots → 403；成员无实例 → 200 名册', async () => {
    const owner = await req(base, 'GET', '/runtime/bots', { token: ownerTok })
    assert(owner.status === 403, `owner ${owner.status} ${owner.text}`)
    const member = await req(base, 'GET', '/runtime/bots', { token: memberTok })
    assert(member.status === 200, `member ${member.status} ${member.text}`)
    assert(Array.isArray(member.json.bots), 'bots array')
  })

  await test('GET /v1/models 要登录票或 API Key；目录无 secret', async () => {
    const unauth = await req(base, 'GET', '/v1/models')
    assert(unauth.status === 401, `unauth models ${unauth.status}`)
    const r = await req(base, 'GET', '/v1/models', { token })
    assert(r.status === 200, `models ${r.status} ${r.text}`)
    assert(r.json.object === 'list', 'object list')
    assert(Array.isArray(r.json.data) && r.json.data.length > 0, '空目录')
    assert(r.json.data.some((m) => m.owned_by === 'deepseek' || m.provider === 'deepseek'), '缺 deepseek')
    assert(!dumpHas(r.json, secret), 'models 泄漏 secret')
    assert(!dumpHas(r.json, 'sk-e2e-rotated-never-leak'), 'models 泄漏 rotated')
  })

  await test('建管理员/员工默认有 API Key 和 access token；列表不泄漏；详情 owner 可见', async () => {
    const adminMe = await req(base, 'GET', '/me', { token })
    assert(adminMe.status === 200, `admin me ${adminMe.status}`)
    const adminId = adminMe.json.account.id
    const memberMe = await req(base, 'GET', '/me', { token: memberTok })
    assert(memberMe.status === 200, `member me ${memberMe.status}`)
    const memberId = memberMe.json.account.id

    const login = await req(base, 'POST', '/auth/login', {
      body: { email: 'admin@acme.test', password: 'correct-horse' },
    })
    assert(login.status === 200, `relogin ${login.status}`)

    const list = await req(base, 'GET', '/platform/accounts', { token: ownerTok })
    assert(list.status === 200, `list ${list.status} ${list.text}`)
    for (const a of list.json.accounts || []) {
      assert(!Object.prototype.hasOwnProperty.call(a, 'apiKey'), '列表带 apiKey 字段')
      assert(!Object.prototype.hasOwnProperty.call(a, 'accessToken'), '列表带 accessToken 字段')
    }
    const ownerRow = list.json.accounts.find((a) => a.role === 'owner')
    assert(ownerRow && ownerRow.id, '缺 owner')

    const missing = await req(base, 'GET', '/platform/accounts/no-such-account', { token: ownerTok })
    assert(missing.status === 404, `missing ${missing.status}`)

    const adminDetail = await req(base, 'GET', `/platform/accounts/${adminId}`, { token: ownerTok })
    assert(adminDetail.status === 200, `admin detail ${adminDetail.status} ${adminDetail.text}`)
    assert(typeof adminDetail.json.apiKey === 'string' && adminDetail.json.apiKey.startsWith('sk_sw_'), 'admin apiKey')
    assert(typeof adminDetail.json.accessToken === 'string' && adminDetail.json.accessToken.startsWith('sat_'), 'admin accessToken')
    assert(adminDetail.json.account && adminDetail.json.account.id === adminId, 'admin account')
    assert(adminDetail.json.company && adminDetail.json.company.id === orgId, 'admin company')

    const memberDetail = await req(base, 'GET', `/platform/accounts/${memberId}`, { token: ownerTok })
    assert(memberDetail.status === 200, `member detail ${memberDetail.status} ${memberDetail.text}`)
    assert(typeof memberDetail.json.apiKey === 'string' && memberDetail.json.apiKey.startsWith('sk_sw_'), 'member apiKey')
    assert(typeof memberDetail.json.accessToken === 'string' && memberDetail.json.accessToken.startsWith('sat_'), 'member accessToken')

    const ownerDetail = await req(base, 'GET', `/platform/accounts/${ownerRow.id}`, { token: ownerTok })
    assert(ownerDetail.status === 200, `owner detail ${ownerDetail.status} ${ownerDetail.text}`)
    assert(ownerDetail.json.apiKey === null, 'owner apiKey')
    assert(ownerDetail.json.accessToken === null, 'owner accessToken')

    const apiKey = adminDetail.json.apiKey
    const accessToken = adminDetail.json.accessToken
    assert(!dumpHas(list.json, apiKey), '列表泄漏 apiKey')
    assert(!dumpHas(list.json, accessToken), '列表泄漏 accessToken')
    assert(!dumpHas(login.json, apiKey), 'login 泄漏 apiKey')
    assert(!dumpHas(login.json, accessToken), 'login 泄漏 accessToken')
    assert(!dumpHas(adminMe.json, apiKey), '/me 泄漏 apiKey')
    assert(!dumpHas(adminMe.json, accessToken), '/me 泄漏 accessToken')

    const spaUsers = await req(base, 'GET', '/users')
    assert(spaUsers.status === 200, `spa /users ${spaUsers.status}`)
    assert(String(spaUsers.text).includes('<!doctype html>') || String(spaUsers.text).includes('Satuwork'), 'spa /users html')
    const spaDetail = await req(base, 'GET', `/users/${adminId}`)
    assert(spaDetail.status === 200, `spa /users/:id ${spaDetail.status}`)
    assert(String(spaDetail.text).includes('<!doctype html>') || String(spaDetail.text).includes('Satuwork'), 'spa detail html')
    const appJs = uiSource(join(gwRoot, 'ui'))
    assert(appJs.includes('function userDetailPage'), '缺 userDetailPage')
  })

  await test('平台侧改账号状态：停用当场断票，启用回得来，自己改不动', async () => {
    /**
     * 「用户」那一页上的「停用 / 启用」。它**不能**走公司侧那条
     * `/orgs/:id/accounts/:accountId`——那一页列的是全平台的人，包括不属于任何公司的
     * 平台账号，那条路根本够不着。
     *
     * 另起一家公司做这件事：停用会把那个人手上的票当场作废（tokenRevokedAt），拿主用例
     * 里那几个共用账号来试，后面所有用例的票都会跟着死。
     */
    const org = await req(base, 'POST', '/platform/orgs', {
      token: ownerTok,
      body: {
        name: 'UserStatus', slug: 'userstatus', contactName: '钱七',
        contactPhone: '+86 13800000001', contactEmail: 'c@userstatus.test',
        adminEmail: 'admin@userstatus.test', adminPassword: 'correct-horse-2',
      },
    })
    assert(org.status === 201, `建公司 ${org.status} ${org.text}`)
    const orgId2 = org.json.company.id
    const up = await req(base, 'PUT', `/platform/orgs/${orgId2}/plan`, { token: ownerTok, body: { seats: 3 } })
    assert(up.status === 200, `加席位 ${up.status} ${up.text}`)
    /**
     * 要停的是**第二个成员**，不是那家公司唯一的管理员——后者会被「至少要留一个管理员」
     * 挡下（这条规矩两条路共用，公司侧的用例里已经验过）。这条用例问的是另一件事：
     * 平台这条路本身通不通。
     */
    const made = await req(base, 'POST', `/orgs/${orgId2}/accounts`, {
      token: ownerTok,
      body: { email: 'staff@userstatus.test', password: 'correct-horse-3', name: '员工', role: 'member' },
    })
    assert(made.status === 201, `建成员 ${made.status} ${made.text}`)
    const theirAccountId = made.json.account.id
    const login = await req(base, 'POST', '/auth/login', {
      body: { email: 'staff@userstatus.test', password: 'correct-horse-3' },
    })
    assert(login.status === 200, `登录 ${login.status} ${login.text}`)
    const theirTok = login.json.token

    // 非 owner 碰不到这条路：它是平台那一页的入口，公司管理员不该能改别家公司的人。
    const denied = await req(base, 'PATCH', `/platform/accounts/${theirAccountId}`, {
      token: theirTok,
      body: { status: 'disabled' },
    })
    assert(denied.status === 403, `非 owner 也能改 ${denied.status} ${denied.text}`)

    const off = await req(base, 'PATCH', `/platform/accounts/${theirAccountId}`, {
      token: ownerTok,
      body: { status: 'disabled' },
    })
    assert(off.status === 200 && off.json.account.status === 'disabled', `停用 ${off.status} ${off.text}`)
    // 停用的**当下**就该断，不是等票过期：手上那张 JWT 还没到期，但它必须不好使了。
    const stale = await req(base, 'GET', '/me', { token: theirTok })
    assert(stale.status === 401, `停用之后旧票还能用 ${stale.status}`)
    const reLogin = await req(base, 'POST', '/auth/login', {
      body: { email: 'staff@userstatus.test', password: 'correct-horse-3' },
    })
    assert(reLogin.status !== 200, `停用之后还登得进来 ${reLogin.status} ${reLogin.text}`)

    const on = await req(base, 'PATCH', `/platform/accounts/${theirAccountId}`, {
      token: ownerTok,
      body: { status: 'active' },
    })
    assert(on.status === 200 && on.json.account.status === 'active', `启用 ${on.status} ${on.text}`)
    const backIn = await req(base, 'POST', '/auth/login', {
      body: { email: 'staff@userstatus.test', password: 'correct-horse-3' },
    })
    assert(backIn.status === 200, `启用之后登不回来 ${backIn.status} ${backIn.text}`)

    // 自己改不动：一个人在这一页上把自己停掉，下一次请求就 401，谁也开不回来。
    const ownerRow = (await req(base, 'GET', '/platform/accounts', { token: ownerTok })).json.accounts.find(
      (a) => a.role === 'owner',
    )
    const self = await req(base, 'PATCH', `/platform/accounts/${ownerRow.id}`, {
      token: ownerTok,
      body: { status: 'disabled' },
    })
    assert(self.status === 400, `owner 把自己停掉了 ${self.status} ${self.text}`)

    // 待接受的不能被管理员直接激活——口令得由本人用邀请链接设。规矩和公司侧那条共用
    // 一份（lib/org.ts 的 patchAccount），这里验的是平台这条路也走的是那一份。
    const invited = await req(base, 'POST', `/orgs/${orgId2}/accounts/members`, {
      token: ownerTok,
      body: { email: 'pending@userstatus.test', name: '待接受', role: 'member' },
    })
    assert(invited.status === 201, `邀请 ${invited.status} ${invited.text}`)
    const force = await req(base, 'PATCH', `/platform/accounts/${invited.json.user.id}`, {
      token: ownerTok,
      body: { status: 'active' },
    })
    assert(force.status === 400, `待接受被直接激活了 ${force.status} ${force.text}`)

    const missing = await req(base, 'PATCH', '/platform/accounts/no-such-account', {
      token: ownerTok,
      body: { status: 'disabled' },
    })
    assert(missing.status === 404, `不存在的账号 ${missing.status}`)
  })

  await test('两个管理员同时互相降级 / 互删：总得留下一个管理员', async () => {
    /**
     * 「至少留一个管理员」是先数再写。以前数和写之间没有锁：两个管理员同时把对方降成成员，
     * 两边都数到 2、都放行，公司就一个管理员都不剩了。现在数和写在同一个事务里排队
     * （lib/org.ts 的 patchAccount、company.ts 的删账号），并发的两下里必然有一下 409。
     */
    const org = await req(base, 'POST', '/platform/orgs', {
      token: ownerTok,
      body: {
        name: 'AdminRace', slug: 'adminrace', contactName: '孙八',
        contactPhone: '+86 13800000002', contactEmail: 'c@adminrace.test',
        adminEmail: 'a@adminrace.test', adminPassword: 'correct-horse-4',
      },
    })
    assert(org.status === 201, `建公司 ${org.status} ${org.text}`)
    const raceOrg = org.json.company.id
    const up = await req(base, 'PUT', `/platform/orgs/${raceOrg}/plan`, { token: ownerTok, body: { seats: 5 } })
    assert(up.status === 200, `加席位 ${up.status} ${up.text}`)
    const madeB = await req(base, 'POST', `/orgs/${raceOrg}/accounts`, {
      token: ownerTok,
      body: { email: 'b@adminrace.test', password: 'correct-horse-5', name: '管理员乙', role: 'admin' },
    })
    assert(madeB.status === 201, `建第二个管理员 ${madeB.status} ${madeB.text}`)
    const idB = madeB.json.account.id
    const tokA = (await req(base, 'POST', '/auth/login', { body: { email: 'a@adminrace.test', password: 'correct-horse-4' } })).json.token
    const tokB = (await req(base, 'POST', '/auth/login', { body: { email: 'b@adminrace.test', password: 'correct-horse-5' } })).json.token
    const idA = (await req(base, 'GET', '/me', { token: tokA })).json.account.id
    const admins = async () =>
      (await req(base, 'GET', `/orgs/${raceOrg}/accounts`, { token: ownerTok })).json.members.filter(
        (m) => m.role === 'admin' && m.status !== 'disabled',
      )

    const [ab, ba] = await Promise.all([
      req(base, 'PATCH', `/orgs/${raceOrg}/accounts/${idB}`, { token: tokA, body: { role: 'member' } }),
      req(base, 'PATCH', `/orgs/${raceOrg}/accounts/${idA}`, { token: tokB, body: { role: 'member' } }),
    ])
    const codes = [ab.status, ba.status].sort()
    assert(codes[0] !== 200 || codes[1] !== 200, `两下互相降级都成了：${ab.text} / ${ba.text}`)
    assert((await admins()).length >= 1, '互相降级之后一个管理员都不剩了')

    // 再来一轮：把两个人都拉回管理员，然后一边删甲、一边停用乙。删账号那条路也得排同一把锁。
    for (const id of [idA, idB]) {
      const r = await req(base, 'PATCH', `/orgs/${raceOrg}/accounts/${id}`, { token: ownerTok, body: { role: 'admin', status: 'active' } })
      assert(r.status === 200, `拉回管理员 ${r.status} ${r.text}`)
    }
    assert((await admins()).length === 2, '两个管理员没拉回来')
    const [del, off] = await Promise.all([
      req(base, 'DELETE', `/orgs/${raceOrg}/accounts/${idA}`, { token: ownerTok }),
      req(base, 'PATCH', `/orgs/${raceOrg}/accounts/${idB}`, { token: ownerTok, body: { status: 'disabled' } }),
    ])
    assert(del.status !== 200 || off.status !== 200, `删甲、停乙两下都成了：${del.text} / ${off.text}`)
    assert([del.status, off.status].includes(409), `该有一下 409：${del.status} ${off.status}`)
    assert((await admins()).length >= 1, '删 + 停用之后一个管理员都不剩了')
  })

  await test('API Key 调 /v1/models；access token 调 /me；交叉 401', async () => {
    const adminMe = await req(base, 'GET', '/me', { token })
    const adminId = adminMe.json.account.id
    const detail = await req(base, 'GET', `/platform/accounts/${adminId}`, { token: ownerTok })
    assert(detail.status === 200, `detail ${detail.status} ${detail.text}`)
    const apiKey = detail.json.apiKey
    const accessToken = detail.json.accessToken
    assert(typeof apiKey === 'string' && apiKey.startsWith('sk_sw_'), 'apiKey')
    assert(typeof accessToken === 'string' && accessToken.startsWith('sat_'), 'accessToken')

    const byBearer = await req(base, 'GET', '/v1/models', { token: apiKey })
    assert(byBearer.status === 200, `apiKey bearer ${byBearer.status} ${byBearer.text}`)
    assert(byBearer.json.object === 'list', 'apiKey list')

    const byHeader = await req(base, 'GET', '/v1/models', { headers: { 'x-api-key': apiKey } })
    assert(byHeader.status === 200, `x-api-key ${byHeader.status} ${byHeader.text}`)
    assert(byHeader.json.object === 'list', 'x-api-key list')

    const satOnV1 = await req(base, 'GET', '/v1/models', { token: accessToken })
    assert(satOnV1.status === 401, `sat /v1 ${satOnV1.status} ${satOnV1.text}`)

    const meSat = await req(base, 'GET', '/me', { token: accessToken })
    assert(meSat.status === 200, `sat /me ${meSat.status} ${meSat.text}`)
    assert(meSat.json.account && meSat.json.account.id === adminId, 'sat /me id')

    const meKey = await req(base, 'GET', '/me', { token: apiKey })
    assert(meKey.status === 401, `apiKey /me ${meKey.status} ${meKey.text}`)

    const jwtModels = await req(base, 'GET', '/v1/models', { token })
    assert(jwtModels.status === 200, `jwt /v1 ${jwtModels.status}`)
    const jwtMe = await req(base, 'GET', '/me', { token })
    assert(jwtMe.status === 200 && jwtMe.json.account.id === adminId, 'jwt /me')

    const catSat = await req(base, 'GET', '/runtime/catalog', { token: accessToken })
    assert(catSat.status === 200, `sat catalog ${catSat.status} ${catSat.text}`)
    const patchSat = await req(base, 'PATCH', '/me', { token: accessToken, body: { name: '不该成功' } })
    assert(patchSat.status === 401, `sat PATCH /me ${patchSat.status}`)
    const depSat = await req(base, 'POST', '/runtime/deploy', { token: accessToken, body: { botId: 'x' } })
    assert(depSat.status === 401, `sat deploy ${depSat.status}`)
    const accSat = await req(base, 'GET', `/orgs/${orgId}/accounts`, { token: accessToken })
    assert(accSat.status === 401, `sat accounts ${accSat.status}`)
    const useSat = await req(base, 'GET', `/orgs/${orgId}/usage`, { token: accessToken })
    assert(useSat.status === 401, `sat usage ${useSat.status}`)
    const dashKey = await req(base, 'GET', `/orgs/${orgId}/accounts`, { token: apiKey })
    assert(dashKey.status === 401, `sk_sw_ dashboard ${dashKey.status}`)
  })

  await test('per-machine ready：未部署 404；跨公司 403；用量上报', async () => {
    const adminMe = await req(base, 'GET', '/me', { token })
    const adminId = adminMe.json.account.id
    const missBot = await req(base, 'POST', `/internal/instances/${adminId}/ready`, {
      token: orgMachineTok,
      body: { host: 'http://127.0.0.1:9' },
    })
    assert(missBot.status === 400, `missing botId ${missBot.status} ${missBot.text}`)
    const never = await req(base, 'POST', `/internal/instances/${adminId}/ready`, {
      token: orgMachineTok,
      body: { host: 'http://127.0.0.1:9', botId: 'never-deployed-bot' },
    })
    assert(never.status === 404, `never deployed ${never.status} ${never.text}`)
    assert(String(never.json.error || never.text).includes('还没有部署'), '404 文案')

    const other = await createCompany(req, base, {
      ownerEmail: 'owner@satuwork.test',
      ownerPassword: 'test-owner-3080',
      email: 'admin@other.test',
      password: 'correct-horse',
      companyName: 'OtherCo',
      slug: 'otherco',
    })
    const otherOrg = other.company.id
    const otherMach = await req(base, 'POST', '/internal/machines', { token: MACHINE_TOK, body: {} })
    assert(otherMach.status === 201, `other machine ${otherMach.status}`)
    const otherSmt = otherMach.json.machine.token
    const bindOther = await req(base, 'POST', `/orgs/${otherOrg}/machine`, {
      token: ownerTok,
      body: { id: otherMach.json.machine.id },
    })
    assert(bindOther.status === 201, `bind other ${bindOther.status} ${bindOther.text}`)

    const crossReady = await req(base, 'POST', `/internal/instances/${adminId}/ready`, {
      token: otherSmt,
      body: { host: 'http://127.0.0.1:9', botId: 'x' },
    })
    assert(crossReady.status === 403, `cross ready ${crossReady.status} ${crossReady.text}`)

    const crossIdx = await req(base, 'POST', '/internal/sessions/index', {
      token: otherSmt,
      body: { sessionId: 's-cross', companyId: orgId, accountId: adminId },
    })
    assert(crossIdx.status === 403, `cross index ${crossIdx.status} ${crossIdx.text}`)

    // 用量**只在 /v1 代理那一侧记一次**（见 llm-usage 那套）。`/internal/usage` 是
    // 旧版 bot 每轮再报一遍的入口，同一次调用记两遍、账面直接翻倍；它先被改成
    // 「收下不写库」，现在整条拆掉了。这里钉的是「端点真的没了，而且用量不受影响」。
    const before = await req(base, 'GET', `/orgs/${orgId}/usage`, { token })
    assert(before.status === 200, `org usage before ${before.status}`)
    const callsOf = (r) => Number((r.json.stats || []).find((x) => x.label === '任务执行')?.value ?? 0)
    const promptOf = (r) => Number((r.json.stats || []).find((x) => x.label === '输入 Tokens')?.value ?? 0)
    const usage = await req(base, 'POST', '/internal/usage', {
      token: orgMachineTok,
      body: { accountId: adminId, provider: 'deepseek', model: 'deepseek-v4-flash', promptTokens: 11, completionTokens: 7 },
    })
    assert(usage.status === 404, `/internal/usage 应该已经没了，得到 ${usage.status} ${usage.text}`)
    const stats = await req(base, 'GET', `/orgs/${orgId}/usage`, { token })
    assert(stats.status === 200, `org usage after ${stats.status}`)
    assert(callsOf(stats) === callsOf(before), `调用数不该变：${callsOf(before)} → ${callsOf(stats)}`)
    assert(promptOf(stats) === promptOf(before), `输入 tokens 不该变：${promptOf(before)} → ${promptOf(stats)}`)
  })

  await test('POST /v1/chat/completions|/v1/responses|/v1/messages 无票 → 401', async () => {
    const a = await req(base, 'POST', '/v1/chat/completions', { body: { model: 'deepseek/deepseek-v4-flash', messages: [] } })
    assert(a.status === 401, `chat ${a.status}`)
    const b = await req(base, 'POST', '/v1/responses', { body: { model: 'openai/gpt-4o', input: 'hi' } })
    assert(b.status === 401, `responses ${b.status}`)
    const c = await req(base, 'POST', '/v1/messages', { body: { model: 'claude-3-5-sonnet-latest', max_tokens: 16, messages: [] } })
    assert(c.status === 401, `messages ${c.status}`)
  })

  await test('POST /v1/* 未知模型 → 404；无密钥 provider → 402（不打上游）', async () => {
    const miss = await req(base, 'POST', '/v1/chat/completions', {
      token,
      body: { model: 'no-such-provider/no-such-model', messages: [{ role: 'user', content: 'hi' }] },
    })
    assert(miss.status === 404, `unknown ${miss.status} ${miss.text}`)
    const fake = await req(base, 'POST', '/catalog/models', {
      token: PLATFORM_TOK,
      body: { name: 'e2e-missing', definition: { provider: 'e2e-fake', id: 'missing-key' } },
    })
    assert(fake.status === 201, `catalog model ${fake.status} ${fake.text}`)
    const chat = await req(base, 'POST', '/v1/chat/completions', {
      token,
      body: { model: 'e2e-fake/missing-key', messages: [{ role: 'user', content: 'hi' }] },
    })
    assert(chat.status === 402, `chat 402 ${chat.status} ${chat.text}`)
    assert(!String(chat.json.error || '').includes('stack'), 'chat stack')
    /**
     * `/v1/responses` 和 `/v1/messages` 是**厂商原生协议**的透传口。
     *
     * 这里原先钉的是「按 provider 名字夹死成 openai / anthropic，而且要在选密钥之前就
     * 400 掉」——理由是那会儿上游地址写死，不夹的话 Gateway 会把这个 provider 的 key
     * 发到写死的那家去（ANTHROPIC_API_KEY 发给 api.openai.com）。
     *
     * **那条理由已经不成立了**：地址和鉴权头现在都由 upstreamTargetOf 从**同一个**
     * `found` 算出来（gateway/src/v1.ts），错配那条路不存在；而按名字夹会把走 Anthropic
     * 协议却不叫 anthropic 的那九家（minimax、kimi-coding、fireworks…）一律 400。所以
     * 那道闸撤了，判据换成模型的**协议**。
     *
     * 于是这颗没密钥的 `e2e-fake` 在三条路上都停在取密钥那一步：402。这条钉的就是
     * 「取密钥那一步拦得住，一个字节都不打上游」。**协议那道闸单独在 e2e/manager.mjs
     * 的「/v1 的原生协议口按模型的 api 判路」里钉**——那边两家供应商都配了平台密钥，
     * 才走得到协议这一句；没密钥的话它根本轮不到。
     */
    const resp = await req(base, 'POST', '/v1/responses', {
      token,
      body: { model: 'e2e-fake/missing-key', input: 'hi' },
    })
    assert(resp.status === 402, `responses 无密钥应 402，得到 ${resp.status} ${resp.text}`)
    assert(String(resp.json.error || '').includes('e2e-fake'), `responses 文案没说清是哪家没密钥：${resp.text}`)
    const msg = await req(base, 'POST', '/v1/messages', {
      token,
      body: { model: 'e2e-fake/missing-key', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
    })
    assert(msg.status === 402, `messages 无密钥应 402，得到 ${msg.status} ${msg.text}`)
    assert(String(msg.json.error || '').includes('e2e-fake'), `messages 文案没说清是哪家没密钥：${msg.text}`)
  })

  await test('POST /platform/llm/test：无票 401；公司管理员和成员 403；未设角色 400；无密钥 402；不泄漏 secret', async () => {
    /**
     * 这条原先打的是 `POST /orgs/:id/llm/test`。公司那条撤了——它探的是「这家公司用
     * 这个供应商打得通吗」，而密钥归平台之后答案对所有公司都一样。同一组边界搬到
     * 平台那条上继续验，**并且多验一格**：公司管理员在这儿也是 403，不是只有成员。
     */
    const unauth = await req(base, 'POST', '/platform/llm/test', { body: { role: 'daily' } })
    assert(unauth.status === 401, `unauth ${unauth.status}`)
    for (const [who, tok] of [['admin', token], ['member', memberTok]]) {
      const deny = await req(base, 'POST', '/platform/llm/test', { token: tok, body: { role: 'daily' } })
      assert(deny.status === 403, `${who} 该 403，实际 ${deny.status}`)
    }
    const unset = await req(base, 'POST', '/platform/llm/test', { token: ownerTok, body: { role: 'daily' } })
    assert(unset.status === 400, `unset ${unset.status} ${unset.text}`)
    const fake = await req(base, 'POST', '/platform/llm/test', { token: ownerTok, body: { provider: 'e2e-fake' } })
    assert(fake.status === 402, `fake ${fake.status} ${fake.text}`)
    assert(!dumpHas(fake.json, secret), 'test 泄漏 secret')
    assert(!dumpHas(fake.json, 'sk-e2e-rotated-never-leak'), 'test 泄漏 rotated')
  })

  await test('seeded owner GET /me：role owner、company null、settings 对象', async () => {
    const login = await req(base, 'POST', '/auth/login', {
      body: { email: 'owner@satuwork.test', password: 'test-owner-3080' },
    })
    assert(login.status === 200, `owner login ${login.status} ${login.text}`)
    assert(login.json.account.role === 'owner', 'login role')
    assert(login.json.company === null, 'login company')
    ownerTok = login.json.token
    const me = await req(base, 'GET', '/me', { token: ownerTok })
    assert(me.status === 200, `me ${me.status} ${me.text}`)
    assert(me.json.account.role === 'owner', 'me role')
    assert(me.json.company === null, 'me company')
    assert(me.json.settings && typeof me.json.settings === 'object', 'me settings')
    assert(me.json.settings.daily && me.json.settings.utility, 'me daily/utility')
  })

  await test('owner GET /platform/orgs 看见已注册公司', async () => {
    const r = await req(base, 'GET', '/platform/orgs', { token: ownerTok })
    assert(r.status === 200, `orgs ${r.status} ${r.text}`)
    assert(r.json.orgs.some((c) => c.id === orgId && c.slug === 'acme'), 'missing acme')
  })

  let contosoId
  await test('owner POST /platform/orgs：联系人必填、地址网站可选、席位不在建公司时定', async () => {
    const miss = await req(base, 'POST', '/platform/orgs', {
      token: ownerTok,
      body: { name: 'NoContact', slug: 'nocontact', adminEmail: 'a@nocontact.test', adminPassword: 'correct-horse-1' },
    })
    assert(miss.status === 400, `缺联系人 ${miss.status} ${miss.text}`)

    const badPhone = await req(base, 'POST', '/platform/orgs', {
      token: ownerTok,
      body: {
        name: 'BadPhone',
        slug: 'badphone',
        contactName: '王五',
        contactPhone: '打我电话',
        contactEmail: 'c@badphone.test',
        adminEmail: 'a@badphone.test',
        adminPassword: 'correct-horse-1',
      },
    })
    assert(badPhone.status === 400, `电话 ${badPhone.status} ${badPhone.text}`)

    // 不带国家区号的号码也不收——界面上那个区号下拉不是摆设。
    const noCode = await req(base, 'POST', '/platform/orgs', {
      token: ownerTok,
      body: {
        name: 'NoCode',
        slug: 'nocode',
        contactName: '王五',
        contactPhone: '13800000000',
        contactEmail: 'c@nocode.test',
        adminEmail: 'a@nocode.test',
        adminPassword: 'correct-horse-1',
      },
    })
    assert(noCode.status === 400, `缺区号 ${noCode.status} ${noCode.text}`)

    const r = await req(base, 'POST', '/platform/orgs', {
      token: ownerTok,
      body: {
        name: 'Contoso',
        slug: 'contoso',
        contactName: '张三',
        contactPhone: '+86 138 0000 0000',
        contactEmail: 'zhangsan@contoso.test',
        // 网站不带 scheme，服务端补 https；地址留空就是留空。
        website: 'contoso.test',
        adminEmail: 'admin@contoso.test',
        adminPassword: 'correct-horse-1',
        // 建公司不收席位：给了也不算数，先开一个管理员席位。
        seats: 9,
      },
    })
    assert(r.status === 201, `create ${r.status} ${r.text}`)
    assert(r.json.company.contactName === '张三', `contactName ${r.json.company.contactName}`)
    assert(r.json.company.contactPhone === '+86 138 0000 0000', `contactPhone ${r.json.company.contactPhone}`)
    assert(r.json.company.contactEmail === 'zhangsan@contoso.test', `contactEmail ${r.json.company.contactEmail}`)
    assert(r.json.company.address === '', `address ${r.json.company.address}`)
    assert(r.json.company.website === 'https://contoso.test', `website ${r.json.company.website}`)
    assert(r.json.plan.seats === 1 && r.json.plan.used === 1, `plan ${JSON.stringify(r.json.plan)}`)

    // 席位仍然由套餐接口调整，跟建公司分开。
    const plan = await req(base, 'PUT', `/platform/orgs/${r.json.company.id}/plan`, { token: ownerTok, body: { seats: 4 } })
    assert(plan.status === 200 && plan.json.seats === 4, `plan ${plan.status} ${plan.text}`)

    const patched = await req(base, 'PATCH', `/orgs/${r.json.company.id}`, {
      token: ownerTok,
      body: { contactName: '李四', address: '新加坡 048624', website: '' },
    })
    assert(patched.status === 200, `patch ${patched.status} ${patched.text}`)
    assert(patched.json.company.contactName === '李四', `patch contactName ${patched.json.company.contactName}`)
    assert(patched.json.company.address === '新加坡 048624', `patch address ${patched.json.company.address}`)
    assert(patched.json.company.website === '', `patch website ${patched.json.company.website}`)
    assert(patched.json.company.status === 'active', `新建的公司应是启用态 ${patched.json.company.status}`)
    contosoId = r.json.company.id
  })

  await test('owner 定套餐与到期时间：列表和公司详情都能看到', async () => {
    const skus = await req(base, 'GET', '/platform/plans', { token: ownerTok })
    assert(skus.status === 200, `plans ${skus.status} ${skus.text}`)
    let sku = (skus.json.plans || [])[0]
    if (!sku) {
      const made = await req(base, 'POST', '/platform/plans', {
        token: ownerTok,
        body: { name: '标准版', nameEn: 'Standard', amount: 9.9, seats: 6 },
      })
      assert(made.status === 201, `create sku ${made.status} ${made.text}`)
      sku = made.json.plan
    }

    const bad = await req(base, 'PUT', `/platform/orgs/${contosoId}/plan`, {
      token: ownerTok,
      body: { skuId: sku.id, expiresAt: '不是日期' },
    })
    assert(bad.status === 400, `坏日期 ${bad.status} ${bad.text}`)

    // 只给套餐不给席位：席位跟着套餐走。
    const set = await req(base, 'PUT', `/platform/orgs/${contosoId}/plan`, {
      token: ownerTok,
      body: { skuId: sku.id, expiresAt: '2031-06-30' },
    })
    assert(set.status === 200, `set plan ${set.status} ${set.text}`)
    assert(set.json.skuId === sku.id, `skuId ${set.json.skuId}`)
    assert(set.json.skuName === sku.name, `skuName ${set.json.skuName}`)
    assert(set.json.seats === sku.seats, `seats 应跟着套餐 ${set.json.seats} ≠ ${sku.seats}`)
    assert(new Date(set.json.expiresAt).toISOString().slice(0, 10) === '2031-06-30', `expiresAt ${set.json.expiresAt}`)

    const listed = await req(base, 'GET', '/platform/orgs', { token: ownerTok })
    const row = (listed.json.orgs || []).find((o) => o.id === contosoId)
    assert(row && row.plan && row.plan.skuName === sku.name, `列表缺套餐 ${JSON.stringify(row && row.plan)}`)
    assert(row.plan.expiresAt === set.json.expiresAt, `列表到期时间 ${row.plan.expiresAt}`)
    assert(row.contactName === '李四' && row.contactPhone && row.contactEmail, '列表缺联系人字段')

    const detail = await req(base, 'GET', `/orgs/${contosoId}`, { token: ownerTok })
    assert(detail.json.plan.skuName === sku.name, `详情套餐 ${detail.json.plan.skuName}`)
    assert(detail.json.plan.expiresAt === set.json.expiresAt, `详情到期 ${detail.json.plan.expiresAt}`)

    // 清空：套餐传空串就是不订，到期传空就是不限期。
    const cleared = await req(base, 'PUT', `/platform/orgs/${contosoId}/plan`, {
      token: ownerTok,
      body: { skuId: '', expiresAt: '', seats: 2 },
    })
    assert(cleared.status === 200, `clear ${cleared.status} ${cleared.text}`)
    assert(cleared.json.skuId === null && cleared.json.expiresAt === null, `clear ${JSON.stringify(cleared.json)}`)
    assert(cleared.json.seats === 2, `clear seats ${cleared.json.seats}`)
  })

  await test('停用公司：整家登不进来，启用回来又能进', async () => {
    const login = await req(base, 'POST', '/auth/login', {
      body: { email: 'admin@contoso.test', password: 'correct-horse-1' },
    })
    assert(login.status === 200, `login ${login.status} ${login.text}`)
    const adminTok = login.json.token

    // 公司管理员不能自己停自己。
    const selfOff = await req(base, 'PATCH', `/orgs/${contosoId}`, { token: adminTok, body: { status: 'disabled' } })
    assert(selfOff.status === 403, `admin 停自己 ${selfOff.status} ${selfOff.text}`)

    const bad = await req(base, 'PATCH', `/orgs/${contosoId}`, { token: ownerTok, body: { status: '停' } })
    assert(bad.status === 400, `坏状态 ${bad.status} ${bad.text}`)

    const off = await req(base, 'PATCH', `/orgs/${contosoId}`, { token: ownerTok, body: { status: 'disabled' } })
    assert(off.status === 200 && off.json.company.status === 'disabled', `disable ${off.status} ${off.text}`)

    // 手上那张票也失效，不用等它过期。
    const withToken = await req(base, 'GET', '/me', { token: adminTok })
    assert(withToken.status === 403, `停用后旧票 ${withToken.status} ${withToken.text}`)
    const reLogin = await req(base, 'POST', '/auth/login', {
      body: { email: 'admin@contoso.test', password: 'correct-horse-1' },
    })
    assert(reLogin.status === 403, `停用后登录 ${reLogin.status} ${reLogin.text}`)

    const on = await req(base, 'PATCH', `/orgs/${contosoId}`, { token: ownerTok, body: { status: 'active' } })
    assert(on.status === 200 && on.json.company.status === 'active', `enable ${on.status} ${on.text}`)
    const back = await req(base, 'POST', '/auth/login', {
      body: { email: 'admin@contoso.test', password: 'correct-horse-1' },
    })
    assert(back.status === 200, `启用后登录 ${back.status} ${back.text}`)
  })

  await test('下单：生成公司订阅 + 一条账单，生效中的那条订单说了算', async () => {
    const skus = await req(base, 'GET', '/platform/plans', { token: ownerTok })
    const sku = (skus.json.plans || [])[0]
    assert(sku, '没有套餐可下单')

    const today = new Date().toISOString().slice(0, 10)
    // 未付款：只开账单，不动公司的订阅。
    const created = await req(base, 'POST', '/platform/orders', {
      token: ownerTok,
      body: { companyId: contosoId, planId: sku.id, startAt: today },
    })
    assert(created.status === 201, `order ${created.status} ${created.text}`)
    const order = created.json.order
    assert(order.payStatus === 'unpaid', `默认应是未付款 ${order.payStatus}`)
    assert(created.json.invoice && created.json.invoice.orderId === order.id, `账单没跟着开 ${created.text}`)
    assert(created.json.invoice.status === 'unpaid' && created.json.invoice.paidAt === null, '未付款不该记付款时间')

    const unpaid = await req(base, 'GET', `/orgs/${contosoId}`, { token: ownerTok })
    assert(unpaid.json.plan.skuId === null, `未付款不该写订阅 ${JSON.stringify(unpaid.json.plan)}`)
    assert(unpaid.json.plan.expiresAt === null, `未付款不该写到期时间 ${unpaid.json.plan.expiresAt}`)
    // 单子在库里，但客户那边的账单只列已付款的：没付的不算成交。
    const unpaidBilling = await req(base, 'GET', `/orgs/${contosoId}/billing`, { token: ownerTok })
    assert(unpaidBilling.json.invoices.length === 0, `未付款不该出现在账单里 ${JSON.stringify(unpaidBilling.json.invoices)}`)
    assert(unpaidBilling.json.plan.status === '未订阅', `未付款订阅状态 ${unpaidBilling.json.plan.status}`)

    // 改成已付款：这时才写公司的订阅。
    const paid = await req(base, 'PUT', `/platform/orders/${order.id}`, { token: ownerTok, body: { payStatus: 'paid' } })
    assert(paid.status === 200 && paid.json.order.payStatus === 'paid', `pay ${paid.status} ${paid.text}`)
    assert(paid.json.invoice.id === created.json.invoice.id, '付款不该再开一张账单')
    assert(paid.json.invoice.status === 'paid' && paid.json.invoice.paidAt, '账单没记付款')

    const detail = await req(base, 'GET', `/orgs/${contosoId}`, { token: ownerTok })
    assert(detail.json.plan.skuId === sku.id, `订阅套餐 ${detail.json.plan.skuId}`)
    assert(detail.json.plan.expiresAt === order.endAt, `到期时间 ${detail.json.plan.expiresAt} ≠ ${order.endAt}`)
    assert(detail.json.plan.seats === order.seats, `席位 ${detail.json.plan.seats} ≠ ${order.seats}`)

    const billing = await req(base, 'GET', `/orgs/${contosoId}/billing`, { token: ownerTok })
    assert(billing.status === 200, `billing ${billing.status} ${billing.text}`)
    assert(billing.json.invoices.length === 1, `账单条数 ${billing.json.invoices.length}`)
    assert(billing.json.invoices[0].status === '已付款', `账单状态 ${billing.json.invoices[0].status}`)
    assert(billing.json.plan.name === sku.name, `账单页套餐 ${billing.json.plan.name}`)

    const bad = await req(base, 'PUT', `/platform/orders/${order.id}`, { token: ownerTok, body: { payStatus: '给钱了' } })
    assert(bad.status === 400, `坏付款状态 ${bad.status} ${bad.text}`)

    // 改回未付款：订阅当场撤掉，账单还在（还是那一张）。
    const moved = await req(base, 'PUT', `/platform/orders/${order.id}`, {
      token: ownerTok,
      body: { startAt: '2031-01-01', payStatus: 'unpaid' },
    })
    assert(moved.status === 200, `move ${moved.status} ${moved.text}`)
    assert(moved.json.invoice.id === created.json.invoice.id, '改单不该再开一张账单')
    assert(moved.json.invoice.status === 'unpaid' && moved.json.invoice.paidAt === null, '账单没跟着改回未付款')

    const after = await req(base, 'GET', `/orgs/${contosoId}`, { token: ownerTok })
    assert(after.json.plan.skuId === null && after.json.plan.expiresAt === null, `订阅没清 ${JSON.stringify(after.json.plan)}`)
    assert(after.json.plan.seats >= after.json.plan.used, '席位不能少于在册人数')

    // 退回未付款：账单那条记录还在库里（还是同一张），但客户端不再列出来。
    const billing2 = await req(base, 'GET', `/orgs/${contosoId}/billing`, { token: ownerTok })
    assert(billing2.json.invoices.length === 0, `退回未付款还列着 ${JSON.stringify(billing2.json.invoices)}`)
  })

  await test('单独充值：不过期，跟套餐赠送分开算', async () => {
    // 起点：没有生效套餐（上一条用例把订单挪到了未来），赠送额度是 0。
    const before = await req(base, 'GET', `/orgs/${contosoId}`, { token: ownerTok })
    assert(before.json.balance, '公司详情缺 balance')
    assert(before.json.balance.planBonusMils === 0, `没生效套餐时赠送应为 0，实际 ${before.json.balance.planBonusMils}`)
    const topupBefore = before.json.balance.topupMils

    const zero = await req(base, 'POST', '/platform/orders', {
      token: ownerTok,
      body: { kind: 'topup', companyId: contosoId, amount: 0 },
    })
    assert(zero.status === 400, `0 元充值 ${zero.status} ${zero.text}`)

    // 未付款的充值单：只有单子，没有充值记录，余额不动。
    const draft = await req(base, 'POST', '/platform/orders', {
      token: ownerTok,
      body: { kind: 'topup', companyId: contosoId, amount: 12.5, note: '线下转账' },
    })
    assert(draft.status === 201, `topup order ${draft.status} ${draft.text}`)
    assert(draft.json.order.kind === 'topup' && draft.json.order.payStatus === 'unpaid', `单据 ${JSON.stringify(draft.json.order)}`)
    assert(draft.json.topup === null, `未付款不该有充值记录 ${JSON.stringify(draft.json.topup)}`)
    assert(draft.json.balance.topupMils === topupBefore, `未付款余额被动了 ${draft.json.balance.topupMils}`)
    const noRecord = await req(base, 'GET', `/orgs/${contosoId}/topups`, { token: ownerTok })
    assert(noRecord.json.topups.length === 0, `未付款不该有记录 ${JSON.stringify(noRecord.json.topups)}`)

    // 改成已付款：这时才开充值记录，余额才涨。
    const made = await req(base, 'PUT', `/platform/orders/${draft.json.order.id}`, {
      token: ownerTok,
      body: { payStatus: 'paid' },
    })
    assert(made.status === 200, `pay topup ${made.status} ${made.text}`)
    assert(made.json.topup && made.json.topup.amountMils === 12500, `充值记录 ${JSON.stringify(made.json.topup)}`)
    assert(made.json.balance.topupMils === topupBefore + 12500, `充值余额 ${made.json.balance.topupMils}`)
    assert(made.json.balance.planBonusMils === 0, '充值不该混进套餐赠送')

    // 充值单也在同一张订单表里，跟套餐单并排列出来。
    const listed = await req(base, 'GET', '/platform/orders', { token: ownerTok })
    assert(listed.status === 200, `list ${listed.status} ${listed.text}`)
    const row = (listed.json.orders || []).find((x) => x.id === draft.json.order.id)
    assert(row && row.kind === 'topup' && row.note === '线下转账', `订单表里的充值单 ${JSON.stringify(row)}`)
    assert((listed.json.orders || []).some((x) => x.kind === 'plan'), '套餐单也该在同一张表里')

    // 退回未付款：记录撤掉，余额掉回去；再付回来记录重新出现。
    const back = await req(base, 'PUT', `/platform/orders/${draft.json.order.id}`, {
      token: ownerTok,
      body: { payStatus: 'unpaid' },
    })
    assert(back.status === 200 && back.json.topup === null, `退回未付款 ${back.text}`)
    assert(back.json.balance.topupMils === topupBefore, `退回后余额 ${back.json.balance.topupMils}`)
    const repaid = await req(base, 'PUT', `/platform/orders/${draft.json.order.id}`, {
      token: ownerTok,
      body: { payStatus: 'paid' },
    })
    assert(repaid.status === 200 && repaid.json.balance.topupMils === topupBefore + 12500, `再付款 ${repaid.text}`)

    // 充值单不是订阅：它不该把公司的套餐顶掉。
    const notPlan = await req(base, 'GET', `/orgs/${contosoId}`, { token: ownerTok })
    assert(notPlan.json.plan.skuId === null, `充值单不该变成订阅 ${JSON.stringify(notPlan.json.plan)}`)

    // 改充值单（界面就是这个形状：不带 kind），改完还得是充值单，记录跟着改。
    const day = new Date().toISOString().slice(0, 10)
    const amend = await req(base, 'PUT', `/platform/orders/${draft.json.order.id}`, {
      token: ownerTok,
      body: { companyId: contosoId, amount: 20, note: '改成 20', startAt: day, payStatus: 'paid' },
    })
    assert(amend.status === 200, `改充值单 ${amend.status} ${amend.text}`)
    assert(amend.json.order.kind === 'topup', `改完变成了 ${amend.json.order.kind}`)
    assert(amend.json.topup.amountMils === 20000 && amend.json.topup.note === '改成 20', `记录没跟着改 ${JSON.stringify(amend.json.topup)}`)
    assert(amend.json.balance.topupMils === topupBefore + 20000, `余额 ${amend.json.balance.topupMils}`)

    // 类型不给改：想换就另开一单。
    const anySku = ((await req(base, 'GET', '/platform/plans', { token: ownerTok })).json.plans || [])[0]
    const swap = await req(base, 'PUT', `/platform/orders/${draft.json.order.id}`, {
      token: ownerTok,
      body: { kind: 'plan', planId: anySku.id },
    })
    assert(swap.status === 400, `类型居然能改 ${swap.status} ${swap.text}`)
    const stillTopup = await req(base, 'GET', `/platform/orders/${draft.json.order.id}`, { token: ownerTok })
    assert(stillTopup.json.order.kind === 'topup', `被改成了 ${stillTopup.json.order.kind}`)

    // 改回 12.5，后面几条断言按这个数来。
    await req(base, 'PUT', `/platform/orders/${draft.json.order.id}`, {
      token: ownerTok,
      body: { companyId: contosoId, amount: 12.5, note: '线下转账', startAt: day, payStatus: 'paid' },
    })

    // 让套餐重新生效并带上赠送额度：赠送出现，充值余额不受影响。
    const today = new Date().toISOString().slice(0, 10)
    const orders = await req(base, 'GET', '/platform/orders', { token: ownerTok })
    const order = (orders.json.orders || []).find((o) => o.companyId === contosoId && o.kind === 'plan')
    assert(order, '缺这家公司的套餐单')
    const paid = await req(base, 'PUT', `/platform/orders/${order.id}`, {
      token: ownerTok,
      body: { startAt: today, payStatus: 'paid', bonusTokens: 5 },
    })
    assert(paid.status === 200, `pay ${paid.status} ${paid.text}`)
    assert(paid.json.order.bonusMils === 5000, `订单赠送额度 ${paid.json.order.bonusMils}`)

    const after = await req(base, 'GET', `/orgs/${contosoId}`, { token: ownerTok })
    assert(after.json.balance.planBonusMils === 5000, `赠送余额 ${after.json.balance.planBonusMils}`)
    assert(after.json.balance.planBonusExpiresAt === paid.json.order.endAt, '赠送余额的到期时间要跟着套餐')
    assert(after.json.balance.topupMils === topupBefore + 12500, `充值余额被套餐动了 ${after.json.balance.topupMils}`)

    // 套餐再次失效：赠送清零，充值仍在。
    const off = await req(base, 'PUT', `/platform/orders/${order.id}`, { token: ownerTok, body: { payStatus: 'unpaid' } })
    assert(off.status === 200, `unpay ${off.status} ${off.text}`)
    const cleared = await req(base, 'GET', `/orgs/${contosoId}`, { token: ownerTok })
    assert(cleared.json.balance.planBonusMils === 0, `套餐失效后赠送要清零 ${cleared.json.balance.planBonusMils}`)
    assert(cleared.json.balance.topupMils === topupBefore + 12500, `充值不该跟着清 ${cleared.json.balance.topupMils}`)

    // 公司管理员看得到自己家的明细，但充值这件事只有 owner 能做。
    const own = await req(base, 'GET', `/orgs/${contosoId}/topups`, { token: ownerTok })
    assert(own.status === 200 && own.json.topups.length >= 1, `明细 ${own.status} ${own.text}`)
    const login = await req(base, 'POST', '/auth/login', {
      body: { email: 'admin@contoso.test', password: 'correct-horse-1' },
    })
    assert(login.status === 200, `login ${login.status} ${login.text}`)
    const ownDetail = await req(base, 'GET', `/orgs/${contosoId}/topups`, { token: login.json.token })
    assert(ownDetail.status === 200 && ownDetail.json.balance, `管理员看自己家 ${ownDetail.status} ${ownDetail.text}`)
    const notOwner = await req(base, 'POST', '/platform/orders', {
      token: login.json.token,
      body: { kind: 'topup', companyId: contosoId, amount: 1 },
    })
    assert(notOwner.status === 403, `公司管理员不能下单充值 ${notOwner.status}`)

    // 公司管理员的账单页：充值记录看得到，两笔余额分开列。
    const bill = await req(base, 'GET', `/orgs/${contosoId}/billing`, { token: login.json.token })
    assert(bill.status === 200, `billing ${bill.status} ${bill.text}`)
    assert(bill.json.topups.length >= 1, `账单页缺充值记录 ${JSON.stringify(bill.json.topups)}`)
    const t0 = bill.json.topups[0]
    assert(t0.amount === '$12.50' && t0.note === '线下转账' && /^\d{4}-\d{2}-\d{2}$/.test(t0.time), `充值记录 ${JSON.stringify(t0)}`)
    assert(bill.json.balance.topup === '$12.50', `充值余额 ${bill.json.balance.topup}`)
    // 上面刚把订单改回未付款，赠送这时应该是 0，且两笔不混在一起。
    assert(bill.json.balance.planBonus === '$0.00', `赠送余额 ${bill.json.balance.planBonus}`)
    assert(bill.json.balance.amount === '$12.50', `合计 ${bill.json.balance.amount}`)
  })

  await test('激活人数不能超过席位：满了激活失败，加席位或停人之后才放行', async () => {
    const org = await req(base, 'POST', '/platform/orgs', {
      token: ownerTok,
      body: {
        name: 'SeatCap',
        slug: 'seatcap',
        contactName: '赵六',
        contactPhone: '+86 13800000000',
        contactEmail: 'c@seatcap.test',
        adminEmail: 'admin@seatcap.test',
        adminPassword: 'correct-horse-1',
      },
    })
    assert(org.status === 201, `create org ${org.status} ${org.text}`)
    const id = org.json.company.id
    assert(org.json.plan.seats === 1 && org.json.plan.used === 1, `起步 ${JSON.stringify(org.json.plan)}`)

    // 1 个席位已被管理员占满，再邀人应当被挡。
    const overflow = await req(base, 'POST', `/orgs/${id}/accounts/members`, {
      token: ownerTok,
      body: { email: 'm1@seatcap.test', name: '甲', role: 'member' },
    })
    assert(overflow.status === 409, `席位满还能邀人 ${overflow.status} ${overflow.text}`)

    const up = await req(base, 'PUT', `/platform/orgs/${id}/plan`, { token: ownerTok, body: { seats: 2 } })
    assert(up.status === 200 && up.json.seats === 2, `加席位 ${up.status} ${up.text}`)

    const m1 = await req(base, 'POST', `/orgs/${id}/accounts/members`, {
      token: ownerTok,
      body: { email: 'm1@seatcap.test', name: '甲', role: 'member' },
    })
    assert(m1.status === 201, `邀请 ${m1.status} ${m1.text}`)
    const m1Id = m1.json.user.id

    // 待接受也占位：第 3 个人进不来。
    const m2 = await req(base, 'POST', `/orgs/${id}/accounts/members`, {
      token: ownerTok,
      body: { email: 'm2@seatcap.test', name: '乙', role: 'member' },
    })
    assert(m2.status === 409, `超席位还能邀 ${m2.status} ${m2.text}`)

    // 停用之后腾出席位，别人进得来。
    const off = await req(base, 'PATCH', `/orgs/${id}/accounts/${m1Id}`, { token: ownerTok, body: { status: 'disabled' } })
    assert(off.status === 200 && off.json.account.status === 'disabled', `停用 ${off.status} ${off.text}`)
    const m2Again = await req(base, 'POST', `/orgs/${id}/accounts/members`, {
      token: ownerTok,
      body: { email: 'm2@seatcap.test', name: '乙', role: 'member' },
    })
    assert(m2Again.status === 201, `腾了席位还邀不进来 ${m2Again.status} ${m2Again.text}`)

    // 席位又满了：把停用的人激活回来要被挡住。
    const back = await req(base, 'PATCH', `/orgs/${id}/accounts/${m1Id}`, { token: ownerTok, body: { status: 'active' } })
    assert(back.status === 409, `席位满还能激活 ${back.status} ${back.text}`)
    assert(String(back.text).includes('席位'), `报错该提席位 ${back.text}`)
    const still = await req(base, 'GET', `/orgs/${id}/accounts/${m1Id}`, { token: ownerTok })
    assert(still.json.account.status === 'disabled', `没激活成却改了状态 ${still.json.account.status}`)

    // 加席位之后才放行。
    const up3 = await req(base, 'PUT', `/platform/orgs/${id}/plan`, { token: ownerTok, body: { seats: 3 } })
    assert(up3.status === 200, `加到 3 席 ${up3.status} ${up3.text}`)
    const ok = await req(base, 'PATCH', `/orgs/${id}/accounts/${m1Id}`, { token: ownerTok, body: { status: 'active' } })
    assert(ok.status === 200 && ok.json.account.status === 'active', `加了席位还激活不了 ${ok.status} ${ok.text}`)

    const listed = await req(base, 'GET', `/orgs/${id}/accounts`, { token: ownerTok })
    assert(listed.json.seats.used === 3 && listed.json.seats.total === 3, `席位统计 ${JSON.stringify(listed.json.seats)}`)

    // 并发激活不能一起挤进来：先腾出一个席位，两个请求同时抢。
    await req(base, 'PATCH', `/orgs/${id}/accounts/${m1Id}`, { token: ownerTok, body: { status: 'disabled' } })
    const m2Id = m2Again.json.user.id
    await req(base, 'PATCH', `/orgs/${id}/accounts/${m2Id}`, { token: ownerTok, body: { status: 'disabled' } })
    const down = await req(base, 'PUT', `/platform/orgs/${id}/plan`, { token: ownerTok, body: { seats: 2 } })
    assert(down.status === 200, `降到 2 席 ${down.status} ${down.text}`)
    const both = await Promise.all([
      req(base, 'PATCH', `/orgs/${id}/accounts/${m1Id}`, { token: ownerTok, body: { status: 'active' } }),
      req(base, 'PATCH', `/orgs/${id}/accounts/${m2Id}`, { token: ownerTok, body: { status: 'active' } }),
    ])
    const okCount = both.filter((r) => r.status === 200).length
    assert(okCount === 1, `并发激活应只成一个，实际 ${both.map((r) => r.status).join('/')}`)
    const after = await req(base, 'GET', `/orgs/${id}/accounts`, { token: ownerTok })
    assert(after.json.seats.used <= after.json.seats.total, `超卖了 ${JSON.stringify(after.json.seats)}`)
  })

  await test('owner 公司列表弹窗 + 详情 SPA；成员/订阅 API 按 path id', async () => {
    const appJs = uiSource(join(gwRoot, 'ui'))
    assert(appJs.includes('data-act="org-create-open"'), '缺 新建公司 按钮')
    assert(appJs.includes('orgCreateOpen'), '缺 orgCreateOpen')
    assert(appJs.includes('function companyDetailPage'), '缺 companyDetailPage')
    assert(appJs.includes('function companyIdOfPath'), '缺 companyIdOfPath')
    assert(appJs.includes('function orgCreateModal'), '缺 orgCreateModal')
    assert(!/function companiesPage\(\)[\s\S]*?<form id="create-org-form" class="satu-panel"/.test(appJs), '列表页仍有内联新建表单')

    const spa = await req(base, 'GET', '/companies')
    assert(spa.status === 200, `spa /companies ${spa.status}`)
    assert(String(spa.text).includes('<!doctype html>') || String(spa.text).includes('Satuwork'), 'spa /companies html')
    assert(!String(spa.text).includes('<form id="create-org-form"'), 'shell 含静态新建表单')

    const detail = await req(base, 'GET', `/companies/${orgId}`)
    assert(detail.status === 200, `spa /companies/:id ${detail.status}`)
    assert(String(detail.text).includes('<!doctype html>') || String(detail.text).includes('Satuwork'), 'spa detail html')

    const org = await req(base, 'GET', `/orgs/${orgId}`, { token: ownerTok })
    assert(org.status === 200, `owner org ${org.status} ${org.text}`)
    assert(org.json.company && org.json.company.id === orgId, 'company')
    assert(org.json.plan && typeof org.json.plan.seats === 'number', 'plan.seats')

    const acc = await req(base, 'GET', `/orgs/${orgId}/accounts`, { token: ownerTok })
    assert(acc.status === 200, `owner accounts ${acc.status} ${acc.text}`)
    assert(Array.isArray(acc.json.members) && acc.json.members.some((m) => m.email === 'admin@acme.test' && m.role === 'admin'), '缺管理员')

    const bill = await req(base, 'GET', `/orgs/${orgId}/billing`, { token: ownerTok })
    assert(bill.status === 200, `owner billing ${bill.status} ${bill.text}`)
    assert(bill.json.plan && bill.json.plan.seats === `${org.json.plan.seats} 个席位`, `seats ${bill.json.plan && bill.json.plan.seats}`)
    assert(bill.json.plan.used === org.json.plan.used, `used ${bill.json.plan && bill.json.plan.used}`)

    const memberSpa = await req(base, 'GET', '/companies')
    assert(memberSpa.status === 200, `member spa /companies ${memberSpa.status}`)
    assert(String(memberSpa.text).includes('<!doctype html>') || String(memberSpa.text).includes('Satuwork'), 'member spa html')
  })

  await test('公司管理员 PUT /platform/settings → 403', async () => {
    const r = await req(base, 'PUT', '/platform/settings', {
      token,
      body: { daily: { provider: 'deepseek', model: 'deepseek-v4-flash' } },
    })
    assert(r.status === 403, `admin settings ${r.status} ${r.text}`)
  })

  await test('成员 GET /platform/orgs → 403', async () => {
    const r = await req(base, 'GET', '/platform/orgs', { token: memberTok })
    assert(r.status === 403, `member orgs ${r.status} ${r.text}`)
  })

  await test('GET /me 给管理员的 settings 是平台设置', async () => {
    const put = await req(base, 'PUT', '/platform/settings', {
      token: ownerTok,
      body: {
        daily: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
        utility: { provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'low' },
      },
    })
    assert(put.status === 200, `owner put ${put.status} ${put.text}`)
    const me = await req(base, 'GET', '/me', { token })
    assert(me.status === 200, `admin me ${me.status}`)
    assert(me.json.settings.daily.provider === 'deepseek', 'daily provider')
    assert(me.json.settings.daily.model === 'deepseek-chat', 'daily model')
    assert(me.json.settings.daily.reasoningEffort === 'high', 'daily reasoning effort')
    assert(me.json.settings.utility.model === 'deepseek-v4-flash', 'utility model')
    assert(me.json.settings.utility.reasoningEffort === 'low', 'utility reasoning effort')

    const bad = await req(base, 'PUT', '/platform/settings', {
      token: ownerTok,
      body: { utility: { provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'turbo' } },
    })
    assert(bad.status === 400, `非法推理强度没有被拦：${bad.status} ${bad.text}`)
  })

  let inviteOrg
  let inviteAdminTok
  let inviteAdminId
  let invitedEmail
  let inviteToken
  let invitedId
  let invitedTok

  await test('邀请成员：建号为 invited，返回一次性链接', async () => {
    const reg = await createCompany(req, base, {
      ownerEmail: 'owner@satuwork.test',
      ownerPassword: 'test-owner-3080',
      email: 'boss@invite.test',
      password: 'correct-horse',
      companyName: 'InviteCo',
      slug: 'inviteco',
      seats: 5,
      // 这家专门用来验「没下过单的公司，账单屏上全是真的 0」。充了钱就没得验了。
      topup: 0,
    })
    inviteOrg = reg.company.id
    inviteAdminTok = reg.token
    inviteAdminId = reg.account.id

    const list = await req(base, 'GET', `/orgs/${inviteOrg}/accounts`, { token: inviteAdminTok })
    assert(list.status === 200, `list ${list.status} ${list.text}`)
    assert(Array.isArray(list.json.members), 'members')
    assert(list.json.seats && list.json.seats.total === 5, 'seats.total')
    assert(list.json.seats.used === 1, 'seats.used')
    assert(list.json.me && list.json.me.id === inviteAdminId, 'me')
    assert(!dumpHas(list.json, 'passwordHash'), 'list 泄漏哈希')

    invitedEmail = 'joiner@invite.test'
    const inv = await req(base, 'POST', `/orgs/${inviteOrg}/accounts/members`, {
      token: inviteAdminTok,
      body: { email: invitedEmail, name: '加入者', role: 'member', ttlDays: 7 },
    })
    assert(inv.status === 201, `invite ${inv.status} ${inv.text}`)
    assert(inv.json.user.status === 'invited', 'status invited')
    assert(inv.json.user.email === invitedEmail, 'email')
    assert(inv.json.user.name === '加入者', 'name')
    assert(typeof inv.json.invite.url === 'string' && inv.json.invite.url.includes('/join/'), 'invite url')
    assert(typeof inv.json.invite.expiresAt === 'number', 'expiresAt')
    assert(!dumpHas(inv.json, 'passwordHash'), 'invite 泄漏哈希')
    invitedId = inv.json.user.id
    inviteToken = inv.json.invite.url.split('/join/')[1]
    assert(inviteToken, 'token from url')

    const listed = await req(base, 'GET', `/orgs/${inviteOrg}/accounts`, { token: inviteAdminTok })
    assert(listed.json.members.some((m) => m.id === invitedId && m.status === 'invited'), 'list shows invited')
    assert(listed.json.seats.used === 2, 'invited occupies a seat')
  })

  await test('GET 邀请有效 → 接受 → 成员可登录；待接受不能登录', async () => {
    const blocked = await req(base, 'POST', '/auth/login', {
      body: { email: invitedEmail, password: 'correct-horse' },
    })
    assert(blocked.status === 401 || blocked.status === 403, `invited login ${blocked.status}`)
    assert(String(blocked.json.error).includes('邀请') || String(blocked.json.error).includes('口令'), 'invited 文案')

    const peek = await req(base, 'GET', `/invites/${inviteToken}`)
    assert(peek.status === 200, `peek ${peek.status} ${peek.text}`)
    assert(peek.json.valid === true, 'valid')
    assert(peek.json.email === invitedEmail, 'peek email')
    assert(peek.json.name === '加入者', 'peek name')

    const spa = await req(base, 'GET', `/join/${inviteToken}`)
    assert(spa.status === 200, `spa ${spa.status}`)
    assert(String(spa.text).includes('<!doctype html>') || String(spa.text).includes('Satuwork'), 'spa html')

    const miss = await req(base, 'GET', '/invites/not-a-real-token')
    assert(miss.status === 200 && miss.json.valid === false, 'invalid invite')

    const acc = await req(base, 'POST', `/invites/${inviteToken}/accept`, {
      body: { name: '加入者', password: 'joiner-pass-10' },
    })
    assert(acc.status === 200, `accept ${acc.status} ${acc.text}`)
    assert(typeof acc.json.token === 'string', 'accept jwt')
    assert(acc.json.account.status === 'active', 'active')
    assert(!dumpHas(acc.json, 'passwordHash'), 'accept 泄漏哈希')

    const reuse = await req(base, 'GET', `/invites/${inviteToken}`)
    assert(reuse.status === 200 && reuse.json.valid === false, 'used invite invalid')

    const login = await req(base, 'POST', '/auth/login', {
      body: { email: invitedEmail, password: 'joiner-pass-10' },
    })
    assert(login.status === 200, `member login ${login.status} ${login.text}`)
    invitedTok = login.json.token
  })

  await test('管理员重置口令：旧登录、旧口令当场作废；接受链接回来的票当场能用', async () => {
    // 作废按毫秒比（票里的 iatMs）：刚登录拿的票和重置落在同一秒也得作废，不用先跨过这一秒。
    const reset = await req(base, 'POST', `/orgs/${inviteOrg}/accounts/${invitedId}/reset`, { token: inviteAdminTok })
    assert(reset.status === 200, `reset ${reset.status} ${reset.text}`)
    const resetToken = String(reset.json.invite?.url || '').split('/join/')[1]
    assert(resetToken, `重置没给出链接：${reset.text}`)

    const stale = await req(base, 'GET', '/me', { token: invitedTok })
    assert(stale.status === 401, `重置之后旧票该 401，实际 ${stale.status}`)
    // 只作废票不作废口令等于没重置：知道旧口令的人（泄露正是要重置的原因）能立刻再登一次，
    // 拿到一张签发在作废之后、活满七天的新票。
    const oldPw = await req(base, 'POST', '/auth/login', { body: { email: invitedEmail, password: 'joiner-pass-10' } })
    assert(oldPw.status === 401, `重置之后旧口令还能登录：${oldPw.status} ${oldPw.text}`)

    // 接受那一步会再作废一次；它自己签出来的那张票得当场能用，不能把自己也作废了。
    // 口令设回原来那个：后面几条用例还拿它登录。
    const acc = await req(base, 'POST', `/invites/${resetToken}/accept`, { body: { password: 'joiner-pass-10' } })
    assert(acc.status === 200, `accept ${acc.status} ${acc.text}`)
    const fresh = await req(base, 'GET', '/me', { token: acc.json.token })
    assert(fresh.status === 200, `接受链接回来的票不能用：${fresh.status} ${fresh.text}`)
    const relogin = await req(base, 'POST', '/auth/login', { body: { email: invitedEmail, password: 'joiner-pass-10' } })
    assert(relogin.status === 200, `设好新口令之后登不进：${relogin.status} ${relogin.text}`)
    invitedTok = relogin.json.token
  })

  await test('公司账单：SPA + 真席位 + 空发票/充值，不编假钱', async () => {
    const spa = await req(base, 'GET', '/billing')
    assert(spa.status === 200, `spa /billing ${spa.status}`)
    assert(String(spa.text).includes('<!doctype html>') || String(spa.text).includes('Satuwork'), 'spa /billing html')
    const alias = await req(base, 'GET', '/costs')
    assert(alias.status === 200, `spa /costs ${alias.status}`)
    assert(String(alias.text).includes('<!doctype html>') || String(alias.text).includes('Satuwork'), 'spa /costs html')

    const plan = await req(base, 'GET', `/orgs/${inviteOrg}/plan`, { token: inviteAdminTok })
    assert(plan.status === 200, `plan ${plan.status} ${plan.text}`)
    const r = await req(base, 'GET', `/orgs/${inviteOrg}/billing`, { token: inviteAdminTok })
    assert(r.status === 200, `billing ${r.status} ${r.text}`)
    assert(r.json.plan && r.json.plan.name === '席位套餐', 'plan.name')
    // 这家没下过单：订阅状态就是「未订阅」，不假装生效中。
    assert(r.json.plan.status === '未订阅', `plan.status ${r.json.plan.status}`)
    assert(r.json.plan.seats === `${plan.json.seats} 个席位`, `seats ${r.json.plan.seats}`)
    assert(r.json.plan.used === plan.json.used, `used ${r.json.plan.used}`)
    assert(r.json.plan.cycle === '—' && r.json.plan.period === '—' && r.json.plan.renew === '—' && r.json.plan.amount === '—', 'unwired plan fields')
    assert(r.json.plan.autoRenew === false, 'autoRenew')
    assert(Array.isArray(r.json.invoices) && r.json.invoices.length === 0, 'invoices empty')
    assert(Array.isArray(r.json.topups) && r.json.topups.length === 0, 'topups empty')
    // 这家没订单也没充值，两笔额度都是真的 0；已用和预警线还没接，仍是 —。
    assert(r.json.balance && r.json.balance.amount === '$0.00', `balance.amount ${r.json.balance && r.json.balance.amount}`)
    assert(r.json.balance.planBonus === '$0.00' && r.json.balance.planBonusExpires === '—', `planBonus ${r.json.balance.planBonus}`)
    assert(r.json.balance.topup === '$0.00', `topup ${r.json.balance.topup}`)
    // 已扣是真数（一分没花就是 $0.00），余额也是真数。预警线还没有设置项，仍是 —。
    assert(r.json.balance.spentThisPeriod === '$0.00', `spentThisPeriod ${r.json.balance.spentThisPeriod}`)
    assert(r.json.balance.left === '$0.00' && r.json.balance.leftMicros === 0, `left ${r.json.balance.left}`)
    assert(r.json.balance.alertAt === '—', 'alertAt 未接')
    // 余额是 0 而熔断默认开着：这一屏得说得出「调用会被停下来」。
    assert(r.json.balance.enforce === true, `enforce ${r.json.balance.enforce}`)
    assert(r.json.mock !== true, 'mock:true')
    assert(!dumpHas(r.json, '$286'), '$286')
    assert(!dumpHas(r.json, '$1,150'), '$1,150')
    assert(!dumpHas(r.json, 'mock'), 'mock 字样')

    const member = await req(base, 'GET', `/orgs/${inviteOrg}/billing`, { token: invitedTok })
    assert(member.status === 403, `member billing ${member.status} ${member.text}`)

    const unauth = await req(base, 'GET', `/orgs/${inviteOrg}/billing`)
    assert(unauth.status === 401, `unauth billing ${unauth.status}`)
    const miss = await req(base, 'GET', '/orgs/no-such-org/billing', { token: ownerTok })
    assert(miss.status === 404, `missing org ${miss.status} ${miss.text}`)
  })

  await test('公司用量：SPA + 真成员名/席位 + 次数费用为 0/—，不编假数', async () => {
    const spa = await req(base, 'GET', '/usage')
    assert(spa.status === 200, `spa /usage ${spa.status}`)
    assert(String(spa.text).includes('<!doctype html>') || String(spa.text).includes('Satuwork'), 'spa /usage html')

    const r = await req(base, 'GET', `/orgs/${inviteOrg}/usage`, { token: inviteAdminTok })
    assert(r.status === 200, `usage ${r.status} ${r.text}`)
    assert(r.json.mock !== true, 'mock:true')
    assert(!dumpHas(r.json, 'mock'), 'mock 字样')
    const numbers = { stats: r.json.stats, daily: r.json.daily, byAgent: r.json.byAgent, byModel: r.json.byModel, quota: r.json.quota }
    assert(!dumpHas(numbers, '$286'), '$286')
    assert(!dumpHas(numbers, '895'), '895')
    assert(!dumpHas(numbers, '48.2M'), '48.2M')
    assert(Array.isArray(r.json.stats) && r.json.stats.length === 4, 'stats')
    for (const s of r.json.stats) {
      // 「费用」这一格现在是真数了（账本上一分没有就是 $0.00），不再是那个万能的 —。
      const want = s.label === '费用' ? ['$0.00'] : ['0', '—']
      assert(want.includes(s.value), `stat ${s.label}=${s.value}`)
      assert(s.delta === '—' || s.delta == null, `delta ${s.label}=${s.delta}`)
    }
    assert(Array.isArray(r.json.daily) && r.json.daily.length === 0, 'daily empty')
    assert(Array.isArray(r.json.byModel) && r.json.byModel.length === 0, 'byModel empty')
    assert(Array.isArray(r.json.quota) && r.json.quota.length === 0, 'quota empty')
    assert(Array.isArray(r.json.byAgent), 'byAgent array')
    assert(r.json.byAgent.length === 0, 'byAgent 应空，不编 0 次')
    assert(r.json.seats === 5, `seats ${r.json.seats}`)
    assert(Array.isArray(r.json.byMember) && r.json.byMember.length >= 1, 'byMember')
    const joiner = r.json.byMember.find((m) => m.id === invitedId || m.name === '加入者')
    assert(joiner, 'missing employee 加入者')
    assert(joiner.tasks === '0', `tasks ${joiner.tasks}`)
    assert(joiner.tokens === '0', `tokens ${joiner.tokens}`)
    // 「失败率」那一列从来没接过，永远是 —。换成账本上真扣了多少。
    assert(joiner.amount === '$0.00', `amount ${joiner.amount}`)
    assert(joiner.fail === undefined, `fail 该没了：${joiner.fail}`)
    assert(joiner.last === '—', `last ${joiner.last}`)
    assert(joiner.initial === '加', `initial ${joiner.initial}`)

    const member = await req(base, 'GET', `/orgs/${inviteOrg}/usage`, { token: invitedTok })
    assert(member.status === 403, `member usage ${member.status} ${member.text}`)
    const meStats = await req(base, 'GET', '/me/stats', { token: invitedTok })
    assert(meStats.status === 200, `me/stats ${meStats.status} ${meStats.text}`)
    assert(Array.isArray(meStats.json.stats) && meStats.json.stats.length === 4, 'me stats')
    assert(!meStats.json.byMember, 'me/stats 不应带全员 byMember')
    const meTasks = (meStats.json.stats || []).find((x) => x.label === '任务执行')
    assert(meTasks && meTasks.value === '0', `self tasks ${meTasks && meTasks.value}`)
    const adminStats = await req(base, 'GET', '/me/stats', { token: inviteAdminTok })
    assert(adminStats.status === 200, `admin me/stats ${adminStats.status}`)

    const unauth = await req(base, 'GET', `/orgs/${inviteOrg}/usage`)
    assert(unauth.status === 401, `unauth usage ${unauth.status}`)
    const miss = await req(base, 'GET', '/orgs/no-such-org/usage', { token: ownerTok })
    assert(miss.status === 404, `missing org ${miss.status} ${miss.text}`)
  })

  await test('停用成员不能登录；成员不能邀请', async () => {
    const dis = await req(base, 'PATCH', `/orgs/${inviteOrg}/accounts/${invitedId}`, {
      token: inviteAdminTok,
      body: { status: 'disabled' },
    })
    assert(dis.status === 200, `disable ${dis.status} ${dis.text}`)
    assert(dis.json.account.status === 'disabled', 'disabled')

    const login = await req(base, 'POST', '/auth/login', {
      body: { email: invitedEmail, password: 'joiner-pass-10' },
    })
    assert(login.status === 403, `disabled login ${login.status} ${login.text}`)
    assert(String(login.json.error).includes('停用'), '停用文案')

    const still = await req(base, 'GET', `/orgs/${inviteOrg}/accounts`, { token: invitedTok })
    assert(still.status === 401, `revoked jwt ${still.status} ${still.text}`)

    const en = await req(base, 'PATCH', `/orgs/${inviteOrg}/accounts/${invitedId}`, {
      token: inviteAdminTok,
      body: { status: 'active' },
    })
    assert(en.status === 200 && en.json.account.status === 'active', 're-enable')
    const relogin = await req(base, 'POST', '/auth/login', {
      body: { email: invitedEmail, password: 'joiner-pass-10' },
    })
    assert(relogin.status === 200, `relogin ${relogin.status}`)
    invitedTok = relogin.json.token

    const deny = await req(base, 'POST', `/orgs/${inviteOrg}/accounts/members`, {
      token: invitedTok,
      body: { email: 'nope@invite.test', name: 'Nope', role: 'member', ttlDays: 1 },
    })
    assert(deny.status === 403, `member invite ${deny.status} ${deny.text}`)
  })

  await test('不能删除自己', async () => {
    const r = await req(base, 'DELETE', `/orgs/${inviteOrg}/accounts/${inviteAdminId}`, { token: inviteAdminTok })
    assert(r.status === 400 || r.status === 403, `delete self ${r.status} ${r.text}`)
    assert(String(r.json.error).includes('自己'), '自己 文案')
  })

  await test('并发改账号：停用不被登录 / 接受邀请盖回去，同一条链接只能接受一次，改口令输给重置', async () => {
    // 这几条以前都是「整行读出来、合并、整行写回去」：谁后写谁赢，停用可以被一次恰好在
    // 验口令的登录改回 active。下面每一条都让两件事同时发生，只看最后落下的状态——
    // 不管谁先谁后，这个状态都得是对的。
    const email = 'race@invite.test'
    const inv = await req(base, 'POST', `/orgs/${inviteOrg}/accounts/members`, {
      token: inviteAdminTok,
      body: { email, name: '并发', role: 'member', ttlDays: 7 },
    })
    assert(inv.status === 201, `invite ${inv.status} ${inv.text}`)
    const id = inv.json.user.id
    const tokenOf = (url) => String(url || '').split('/join/')[1]
    const patch = (status) =>
      req(base, 'PATCH', `/orgs/${inviteOrg}/accounts/${id}`, { token: inviteAdminTok, body: { status } })
    const statusNow = async () => (await req(base, 'GET', `/orgs/${inviteOrg}/accounts/${id}`, { token: inviteAdminTok })).json.account.status
    const login = (password) => req(base, 'POST', '/auth/login', { body: { email, password } })

    // 同一条链接两个人一起接受：只能成一个，口令是成的那个设的。
    const link = tokenOf(inv.json.invite.url)
    const [a, b] = await Promise.all([
      req(base, 'POST', `/invites/${link}/accept`, { body: { password: 'race-pass-aaa' } }),
      req(base, 'POST', `/invites/${link}/accept`, { body: { password: 'race-pass-bbb' } }),
    ])
    const codes = [a.status, b.status].sort()
    assert(codes[0] === 200 && codes[1] === 400, `两次接受该一成一败：${a.status} ${b.status}`)
    const won = a.status === 200 ? 'race-pass-aaa' : 'race-pass-bbb'
    const lost = a.status === 200 ? 'race-pass-bbb' : 'race-pass-aaa'
    assert((await login(won)).status === 200, '接受成功的那个口令登不进')
    assert((await login(lost)).status === 401, '接受失败的那个口令也能登录')

    // 登录和停用前后脚：停用必须留下来，登录不许把 active 写回去。
    for (let i = 0; i < 4; i++) {
      if ((await statusNow()) !== 'active') assert((await patch('active')).status === 200, 're-enable')
      const [, dis] = await Promise.all([login(won), patch('disabled')])
      assert(dis.status === 200, `disable ${dis.status} ${dis.text}`)
      assert((await statusNow()) === 'disabled', `第 ${i + 1} 轮：停用被并发的登录改回去了`)
      assert((await login(won)).status === 403, '停用之后还能登录')
    }

    // 停用的人手上有重置链接：接受不了，也不会被接受改回 active。
    const reset = await req(base, 'POST', `/orgs/${inviteOrg}/accounts/${id}/reset`, { token: inviteAdminTok })
    assert(reset.status === 200, `reset ${reset.status} ${reset.text}`)
    const dead = await req(base, 'POST', `/invites/${tokenOf(reset.json.invite.url)}/accept`, { body: { password: 'race-pass-ccc' } })
    assert(dead.status === 400, `停用账号接受邀请该 400，实际 ${dead.status} ${dead.text}`)
    assert((await statusNow()) === 'disabled', '停用账号被接受邀请改回 active')

    // 接受和停用前后脚：一样，停用得留下来。
    assert((await patch('active')).status === 200, 're-enable')
    const reset2 = await req(base, 'POST', `/orgs/${inviteOrg}/accounts/${id}/reset`, { token: inviteAdminTok })
    const [, dis2] = await Promise.all([
      req(base, 'POST', `/invites/${tokenOf(reset2.json.invite.url)}/accept`, { body: { password: won } }),
      patch('disabled'),
    ])
    assert(dis2.status === 200, `disable ${dis2.status}`)
    assert((await statusNow()) === 'disabled', '停用被并发的接受邀请改回去了')

    // 改口令和管理员重置前后脚：重置得赢，旧口令、新口令最后都登不进。
    assert((await patch('active')).status === 200, 're-enable')
    const reset3 = await req(base, 'POST', `/orgs/${inviteOrg}/accounts/${id}/reset`, { token: inviteAdminTok })
    const acc = await req(base, 'POST', `/invites/${tokenOf(reset3.json.invite.url)}/accept`, { body: { password: 'race-pass-ddd' } })
    assert(acc.status === 200, `accept ${acc.status} ${acc.text}`)
    await new Promise((r) => setTimeout(r, 1100))
    const [chg, rs] = await Promise.all([
      req(base, 'POST', '/me/password', { token: acc.json.token, body: { current: 'race-pass-ddd', next: 'race-pass-eee' } }),
      req(base, 'POST', `/orgs/${inviteOrg}/accounts/${id}/reset`, { token: inviteAdminTok }),
    ])
    assert(rs.status === 200, `reset ${rs.status}`)
    assert(chg.status === 200 || chg.status === 401, `改口令 ${chg.status} ${chg.text}`)
    assert((await login('race-pass-ddd')).status === 401, '重置之后旧口令还能登录')
    assert((await login('race-pass-eee')).status === 401, '改口令盖掉了并发的重置')

    const del = await req(base, 'DELETE', `/orgs/${inviteOrg}/accounts/${id}`, { token: inviteAdminTok })
    assert(del.status === 200, `delete ${del.status} ${del.text}`)
  })

  let groupId

  await test('GET accounts 含 builtin 全体成员（含管理员）', async () => {
    const list = await req(base, 'GET', `/orgs/${inviteOrg}/accounts`, { token: inviteAdminTok })
    assert(list.status === 200, `list ${list.status} ${list.text}`)
    assert(Array.isArray(list.json.groups), 'groups')
    const all = list.json.groups.find((g) => g.id === 'all')
    assert(all && all.builtin === true, 'builtin all')
    assert(all.name === '全体成员', 'name')
    assert(all.icon === 'users', 'icon')
    assert(all.role === null, 'all role')
    assert(Array.isArray(all.members) && all.members.includes(inviteAdminId), 'admin in all')
    assert(all.members.includes(invitedId), 'invited in all')
    assert(Array.isArray(all.agents), 'agents')
  })

  await test('POST group → 201，出现在列表', async () => {
    const r = await req(base, 'POST', `/orgs/${inviteOrg}/accounts/groups`, {
      token: inviteAdminTok,
      body: { name: '客服组', desc: '一线', icon: 'chat', role: 'member', members: [inviteAdminId, invitedId] },
    })
    assert(r.status === 201, `create ${r.status} ${r.text}`)
    assert(r.json.group && r.json.group.builtin === false, 'group')
    assert(r.json.group.name === '客服组', 'name')
    assert(r.json.group.icon === 'chat', 'icon')
    assert(r.json.group.role === 'member', 'role')
    assert(r.json.group.members.includes(inviteAdminId), 'members')
    assert(r.json.group.members.includes(invitedId), 'members invited')
    assert(Array.isArray(r.json.group.agents), 'agents')
    assert(!Object.prototype.hasOwnProperty.call(r.json.group, 'companyId'), 'omit companyId')
    groupId = r.json.group.id
    assert(groupId && groupId !== 'all', 'id')
    const list = await req(base, 'GET', `/orgs/${inviteOrg}/accounts`, { token: inviteAdminTok })
    assert(
      list.json.groups.some((g) => g.id === groupId && g.name === '客服组' && g.builtin === false),
      'list',
    )
  })

  await test('PATCH group 改名和成员', async () => {
    const r = await req(base, 'PATCH', `/orgs/${inviteOrg}/accounts/groups/${groupId}`, {
      token: inviteAdminTok,
      body: { name: '客服组改', members: [invitedId] },
    })
    assert(r.status === 200, `patch ${r.status} ${r.text}`)
    assert(r.json.group.name === '客服组改', 'name')
    assert(r.json.group.members.length === 1 && r.json.group.members[0] === invitedId, 'members')
  })

  await test('不能 PATCH/DELETE all；成员不能 POST；空名 400', async () => {
    const patchAll = await req(base, 'PATCH', `/orgs/${inviteOrg}/accounts/groups/all`, {
      token: inviteAdminTok,
      body: { name: 'x' },
    })
    assert(patchAll.status === 400, `patch all ${patchAll.status} ${patchAll.text}`)
    const delAll = await req(base, 'DELETE', `/orgs/${inviteOrg}/accounts/groups/all`, { token: inviteAdminTok })
    assert(delAll.status === 400, `delete all ${delAll.status} ${delAll.text}`)
    const deny = await req(base, 'POST', `/orgs/${inviteOrg}/accounts/groups`, {
      token: invitedTok,
      body: { name: '不该成功' },
    })
    assert(deny.status === 403, `member post ${deny.status} ${deny.text}`)
    const empty = await req(base, 'POST', `/orgs/${inviteOrg}/accounts/groups`, {
      token: inviteAdminTok,
      body: { name: '   ' },
    })
    assert(empty.status === 400, `empty ${empty.status} ${empty.text}`)
  })

  await test('DELETE group', async () => {
    const r = await req(base, 'DELETE', `/orgs/${inviteOrg}/accounts/groups/${groupId}`, { token: inviteAdminTok })
    assert(r.status === 200 && r.json.ok === true, `delete ${r.status} ${r.text}`)
    const list = await req(base, 'GET', `/orgs/${inviteOrg}/accounts`, { token: inviteAdminTok })
    assert(!list.json.groups.some((g) => g.id === groupId), 'gone')
    assert(list.json.groups.some((g) => g.id === 'all' && g.builtin === true), 'all remains')
  })

  await test('GET /me 含 title/phone/theme/locale', async () => {
    const r = await req(base, 'GET', '/me', { token: inviteAdminTok })
    assert(r.status === 200, `me ${r.status} ${r.text}`)
    const a = r.json.account
    assert(typeof a.title === 'string', 'title')
    assert(typeof a.phone === 'string', 'phone')
    assert(a.theme === 'light' || a.theme === 'dark' || a.theme === 'system', `theme ${a.theme}`)
    assert(a.locale === 'zh' || a.locale === 'en', `locale ${a.locale}`)
  })

  await test('PATCH /me 姓名/职位/手机/外观/语言会落库', async () => {
    const r = await req(base, 'PATCH', '/me', {
      token: inviteAdminTok,
      body: { name: '老板改', title: '运营负责人', phone: '13800000000', theme: 'dark', locale: 'en' },
    })
    assert(r.status === 200, `patch ${r.status} ${r.text}`)
    assert(r.json.account.name === '老板改', 'name')
    assert(r.json.account.title === '运营负责人', 'title')
    assert(r.json.account.phone === '13800000000', 'phone')
    assert(r.json.account.theme === 'dark', 'theme')
    assert(r.json.account.locale === 'en', 'locale')
    assert(!dumpHas(r.json, 'passwordHash'), 'patch 泄漏哈希')
    const me = await req(base, 'GET', '/me', { token: inviteAdminTok })
    assert(me.json.account.name === '老板改', 'persisted name')
    assert(me.json.account.title === '运营负责人', 'persisted title')
    assert(me.json.account.phone === '13800000000', 'persisted phone')
    assert(me.json.account.theme === 'dark', 'persisted theme')
    assert(me.json.account.locale === 'en', 'persisted locale')
  })

  await test('成员也能 PATCH /me（个人设置，不是管理员接口）', async () => {
    const r = await req(base, 'PATCH', '/me', {
      token: invitedTok,
      body: { name: '加入者改', title: '一线客服', phone: '', theme: 'light', locale: 'zh' },
    })
    assert(r.status === 200, `member patch ${r.status} ${r.text}`)
    assert(r.json.account.name === '加入者改', 'member name')
    assert(r.json.account.title === '一线客服', 'member title')
    assert(r.json.account.theme === 'light', 'member theme')
    const me = await req(base, 'GET', '/me', { token: invitedTok })
    assert(me.json.account.title === '一线客服', 'member persisted')
  })

  await test('SPA GET /profile 返回 html', async () => {
    const r = await req(base, 'GET', '/profile')
    assert(r.status === 200, `spa ${r.status}`)
    assert(String(r.text).includes('<!doctype html>') || String(r.text).includes('Satuwork'), 'spa html')
  })

  await test('POST /me/password 当前口令不对 → 400', async () => {
    const r = await req(base, 'POST', '/me/password', {
      token: inviteAdminTok,
      body: { current: 'wrong-horse', next: 'new-password-10' },
    })
    assert(r.status === 400, `wrong ${r.status} ${r.text}`)
    assert(String(r.json.error).includes('当前口令不对'), '文案')
  })

  await test('POST /me/password 新口令与当前相同 → 400', async () => {
    const r = await req(base, 'POST', '/me/password', {
      token: inviteAdminTok,
      body: { current: 'correct-horse', next: 'correct-horse' },
    })
    assert(r.status === 400, `same ${r.status} ${r.text}`)
    assert(String(r.json.error).includes('相同'), '文案')
  })

  await test('POST /me/password 成功 → 新票可用、旧票 401', async () => {
    // 不等跨秒：作废按毫秒 iatMs 比，同一秒里先签的旧票也得死，改完当场发的新票得活。
    // 紧挨着改口令之前再登一次——以前按秒比，这张和作废点多半落在同一秒，会活满七天。
    const justBefore = await req(base, 'POST', '/auth/login', { body: { email: 'boss@invite.test', password: 'correct-horse' } })
    assert(justBefore.status === 200, `login ${justBefore.status} ${justBefore.text}`)
    const r = await req(base, 'POST', '/me/password', {
      token: inviteAdminTok,
      body: { current: 'correct-horse', next: 'new-horse-10' },
    })
    const sameSec = await req(base, 'GET', '/me', { token: justBefore.json.token })
    assert(sameSec.status === 401, `改口令前一刻签的票还能用 ${sameSec.status} ${sameSec.text}`)
    assert(r.status === 200, `ok ${r.status} ${r.text}`)
    assert(r.json.ok === true, 'ok')
    assert(typeof r.json.token === 'string' && r.json.token.split('.').length === 3, 'new jwt')
    const old = await req(base, 'GET', '/me', { token: inviteAdminTok })
    assert(old.status === 401, `old token ${old.status} ${old.text}`)
    const neu = await req(base, 'GET', '/me', { token: r.json.token })
    assert(neu.status === 200, `new token ${neu.status} ${neu.text}`)
    assert(neu.json.account.id === inviteAdminId, 'same account')
  })

  await test('我的 Bot：创建、改、只进自己的名册、删除、SPA', async () => {
    const login = await req(base, 'POST', '/auth/login', {
      body: { email: 'boss@invite.test', password: 'new-horse-10' },
    })
    assert(login.status === 200, `relogin ${login.status} ${login.text}`)
    const adminTok = login.json.token

    const empty = await req(base, 'GET', `/orgs/${inviteOrg}/bots`, { token: adminTok })
    assert(empty.status === 200, `list ${empty.status} ${empty.text}`)
    assert(Array.isArray(empty.json.bots) && empty.json.bots.length === 0, 'starts empty')

    const created = await req(base, 'POST', '/runtime/bots', {
      token: adminTok,
      body: { name: '客服助手', description: '客服' },
    })
    assert(created.status === 201, `create ${created.status} ${created.text}`)
    assert(created.json.bot.scope === 'user', 'scope')
    assert(created.json.bot.enabled === true, 'enabled')
    assert(created.json.bot.name === '客服助手', 'name')
    assert(created.json.bot.description === '客服', 'description')
    assert(typeof created.json.bot.provider === 'string' && created.json.bot.provider, 'provider')
    assert(typeof created.json.bot.model === 'string' && created.json.bot.model, 'model')
    const id = created.json.bot.id

    // 自建的**不进**公司管理目录：那一页列的是全局项和停用掉的老公司 Bot。
    const list = await req(base, 'GET', `/orgs/${inviteOrg}/bots`, { token: adminTok })
    assert(!list.json.bots.some((b) => b.id === id), '自建 Bot 漏进了管理目录')
    const mine = await req(base, 'GET', '/runtime/bots', { token: adminTok })
    assert(mine.json.bots.some((b) => b.id === id && b.name === '客服助手'), '自己的名册里没有')
    assert(mine.json.quota && mine.json.quota.max >= 1, `没给配额 ${mine.text}`)

    const patched = await req(base, 'PATCH', `/runtime/bots/${id}`, {
      token: adminTok,
      // 头像改版后键换了一套。老键仍然收，映射到新的那一个存下来。
      body: { greeting: '你好，我是客服。', enabled: false, icon: 'chat' },
    })
    assert(patched.status === 200, `patch ${patched.status} ${patched.text}`)
    assert(patched.json.bot.greeting === '你好，我是客服。', 'greeting')
    assert(patched.json.bot.enabled === false, 'enabled false')
    assert(patched.json.bot.icon === 'c-chat', `icon ${patched.json.bot.icon}`)

    const emptyName = await req(base, 'POST', '/runtime/bots', {
      token: adminTok,
      body: { name: '   ' },
    })
    assert(emptyName.status === 400, `empty ${emptyName.status} ${emptyName.text}`)
    assert(String(emptyName.json.error).includes('助理要有名字'), 'empty name 文案')

    const spaList = await req(base, 'GET', '/bots')
    assert(spaList.status === 200, `spa list ${spaList.status}`)
    assert(String(spaList.text).includes('<!doctype html>') || String(spaList.text).includes('Satuwork'), 'spa html')
    const spaOne = await req(base, 'GET', `/bots/${id}`)
    assert(spaOne.status === 200, `spa one ${spaOne.status}`)
    assert(String(spaOne.text).includes('<!doctype html>') || String(spaOne.text).includes('Satuwork'), 'spa detail html')

    const del = await req(base, 'DELETE', `/runtime/bots/${id}`, { token: adminTok })
    assert(del.status === 200 && del.json.deleted === true && del.json.id === id, 'delete')
    const gone = await req(base, 'GET', `/runtime/bots/${id}`, { token: adminTok })
    assert(gone.status === 404, `gone ${gone.status}`)
    const after = await req(base, 'GET', '/runtime/bots', { token: adminTok })
    assert(!after.json.bots.some((b) => b.id === id), 'list gone')
  })

  await test('模版的行为边界与记忆：存得下、读得回、越界的收口，自建 Bot 跟着走', async () => {
    const login = await req(base, 'POST', '/auth/login', {
      body: { email: 'boss@invite.test', password: 'new-horse-10' },
    })
    const tok = login.json.token

    const fresh = await req(base, 'GET', `/orgs/${inviteOrg}/bot-template`, { token: tok })
    assert(fresh.status === 200, `模版 ${fresh.status} ${fresh.text}`)
    const tpl = fresh.json.template
    // 新公司就带全套默认，不是 undefined——前端照着画，缺了就得各自兜底。
    assert(tpl.guards && tpl.guards['high-risk'] === true && tpl.guards.pii === true, `默认守卫 ${JSON.stringify(tpl.guards)}`)
    assert(tpl.memory && tpl.memory.on === true && tpl.memory.scope === '所属分组', `默认记忆 ${JSON.stringify(tpl.memory)}`)
    assert(tpl.memory.cap === 20 && tpl.memory.ttl === '90 天', `默认上限/时长 ${JSON.stringify(tpl.memory)}`)
    /**
     * 浏览器**默认开着、站点全放行**（`*.*`），席位桌面也默认开。
     *
     * 以前浏览器默认关、名单空，装完 Bot 就说自己没有浏览器工具，而没人会去找一个自己
     * 没听说过的开关。回环 / 内网那层不受名单影响，一直在席位上拦着。
     */
    assert(tpl.browser && tpl.browser.on === true, `浏览器默认该是开的 ${JSON.stringify(tpl.browser)}`)
    assert(JSON.stringify(tpl.browser.sites) === '["*.*"]', `站点默认该是全放行 ${JSON.stringify(tpl.browser)}`)
    assert(tpl.desktop && tpl.desktop.on === true, `席位桌面默认该是开的 ${JSON.stringify(tpl.desktop)}`)

    const saved = await req(base, 'PUT', `/orgs/${inviteOrg}/bot-template`, {
      token: tok,
      body: {
        escalate: '连续 3 次说不清就转人工',
        // 只传改动的那一个开关，另外两个不该被带回默认。
        guards: { pii: false },
        // 认不出的记录类型丢掉；注入上限按 5–50 收口。
        memory: { scope: '全公司', kinds: ['流程', '瞎写的'], ttl: '永久保留', cap: 999, confirm: false },
        // 站点这一栏收的是人随手粘进来的东西：整条 URL、带 *. 的写法、大小写混着。
        // 本机和内网地址无论怎么写都不许进——那不是「外部系统」。
        browser: {
          on: true,
          sites: [
            'https://App.Example.com/inbox?x=1',
            '*.foo.cn',
            'erp-*.corp.com',
            // 后缀放开、全局放开：开多宽是管理员的决定，这一层不拦。
            'mycompany.*',
            '*',
            '127.0.0.1',
            'localhost',
            'nas.local',
            'erp',
            'app.example.com',
          ],
        },
        // 席位桌面能关：关掉之后要落库、要被自建 Bot 继承。
        desktop: { on: false },
      },
    })
    assert(saved.status === 200, `存 ${saved.status} ${saved.text}`)
    assert(saved.json.template.desktop && saved.json.template.desktop.on === false, `席位桌面没关上 ${JSON.stringify(saved.json.template.desktop)}`)
    assert(saved.json.template.version === tpl.version + 1, `版本号没加一：${saved.json.template.version}`)
    const g = saved.json.template.guards
    assert(g.pii === false && g['high-risk'] === true && g['no-external'] === true, `守卫合并 ${JSON.stringify(g)}`)
    const br = saved.json.template.browser
    assert(br.on === true, `浏览器没开起来 ${JSON.stringify(br)}`)
    assert(br.sites.includes('app.example.com'), `整条 URL 没收成域名 ${JSON.stringify(br.sites)}`)
    /**
     * 通配符**留着**，不再像早先那样把 `*.` 一剥了事。
     *
     * 剥掉的话 `*.foo.cn` 会被悄悄放宽成 `foo.cn`——管理员写 `*` 是想收紧（只要子域，
     * 不要主站），而系统的处理是把它改成更宽的那个意思，界面上还照样显示成他写的样子。
     */
    assert(br.sites.includes('*.foo.cn'), `通配符被剥掉了 ${JSON.stringify(br.sites)}`)
    assert(br.sites.includes('erp-*.corp.com'), `段内通配没收下 ${JSON.stringify(br.sites)}`)
    assert(br.sites.includes('mycompany.*'), `后缀放开没收下 ${JSON.stringify(br.sites)}`)
    /**
     * 单个 `*` 归一到 `*.*`：两种写法是同一个意思，存成一种，界面上和审计里才只有一个
     * 样子——否则同一件事在不同公司的配置里长得不一样，翻记录的人得先认出它们是一回事。
     */
    assert(br.sites.includes('*.*') && !br.sites.includes('*'), `单个 * 没归一到 *.* ${JSON.stringify(br.sites)}`)
    // 重复的只留一条：同一个域名写两遍（一次带协议一次不带）是最常见的粘贴结果。
    assert(br.sites.filter((x) => x === 'app.example.com').length === 1, `没去重 ${JSON.stringify(br.sites)}`)
    for (const bad of ['127.0.0.1', 'localhost', 'nas.local', 'erp']) {
      assert(!br.sites.includes(bad), `${bad} 不该进白名单 ${JSON.stringify(br.sites)}`)
    }
    const m = saved.json.template.memory
    assert(m.scope === '全公司' && m.ttl === '永久保留', `记忆 ${JSON.stringify(m)}`)
    assert(m.kinds.length === 1 && m.kinds[0] === '流程', `认不出的类型没丢 ${JSON.stringify(m.kinds)}`)
    assert(m.cap === 50, `注入上限没收口：${m.cap}`)
    assert(m.confirm === false && m.pii === true, `没传的那几项被带回默认了 ${JSON.stringify(m)}`)

    // 真落库了才算数：回执对、重新拉一次也对。
    const back = await req(base, 'GET', `/orgs/${inviteOrg}/bot-template`, { token: tok })
    assert(back.json.template.escalate.includes('转人工'), `升级条件 ${back.json.template.escalate}`)
    assert(back.json.template.guards.pii === false, '守卫没落库')
    assert(back.json.template.memory.cap === 50 && back.json.template.memory.scope === '全公司', '记忆没落库')
    assert(back.json.template.browser.on === true && back.json.template.browser.sites.includes('*.foo.cn'), '浏览器那两格没落库')

    // 自建的 Bot 不存自己的一份——读出来就是模版这一份。
    const made = await req(base, 'POST', '/runtime/bots', { token: tok, body: { name: '记忆助手' } })
    assert(made.status === 201, `建 ${made.status} ${made.text}`)
    assert(made.json.bot.guards.pii === false, `没继承守卫 ${JSON.stringify(made.json.bot.guards)}`)
    assert(made.json.bot.memory.cap === 50, `没继承记忆 ${JSON.stringify(made.json.bot.memory)}`)
    assert(made.json.bot.escalate.includes('转人工'), '没继承升级条件')
    assert(made.json.bot.browser && made.json.bot.browser.on === true, `没继承浏览器能力 ${JSON.stringify(made.json.bot.browser)}`)
    assert(made.json.bot.desktop && made.json.bot.desktop.on === false, `没继承席位桌面开关 ${JSON.stringify(made.json.bot.desktop)}`)
    await req(base, 'DELETE', `/runtime/bots/${made.json.bot.id}`, { token: tok })
  })

  await test('Bot 用平台指定的模型：自己挑不了，平台换了就跟着换', async () => {
    const login = await req(base, 'POST', '/auth/login', {
      body: { email: 'boss@invite.test', password: 'new-horse-10' },
    })
    const tok = login.json.token

    // 动的是平台设置，后面的用例还要用——先抄一份，走完放回去。
    const before = (await req(base, 'GET', '/platform/settings', { token: ownerTok })).json
    await req(base, 'PUT', '/platform/settings', {
      token: ownerTok,
      body: { daily: { provider: 'e2e-fake', model: 'pinned-one' } },
    })
    const made = await req(base, 'POST', '/runtime/bots', {
      token: tok,
      // 建的时候就想指一个别的，不能得逞。
      body: { name: '挑模型的', provider: 'openai', model: 'gpt-9-ultra' },
    })
    assert(made.status === 201, `create ${made.status} ${made.text}`)
    assert(made.json.bot.model === 'pinned-one', `建出来是 ${made.json.bot.model}`)
    assert(made.json.bot.provider === 'e2e-fake', `建出来的供应商是 ${made.json.bot.provider}`)
    const botId = made.json.bot.id

    const patched = await req(base, 'PATCH', `/runtime/bots/${botId}`, {
      token: tok,
      body: { provider: 'openai', model: 'gpt-9-ultra' },
    })
    assert(patched.json.bot.model === 'pinned-one', `改完变成了 ${patched.json.bot.model}`)

    // 平台换一个：这个 Bot 从头到尾没再被保存过，读出来也得跟着换。
    await req(base, 'PUT', '/platform/settings', {
      token: ownerTok,
      body: { daily: { provider: 'e2e-fake', model: 'pinned-two' } },
    })
    const back = await req(base, 'GET', `/runtime/bots/${botId}`, { token: tok })
    assert(back.json.bot.model === 'pinned-two', `平台换了之后还是 ${back.json.bot.model}`)
    const listed = (await req(base, 'GET', '/runtime/bots', { token: tok })).json.bots.find((b) => b.id === botId)
    assert(listed.model === 'pinned-two', `列表里还是 ${listed.model}`)

    await req(base, 'DELETE', `/runtime/bots/${botId}`, { token: tok })
    await req(base, 'PUT', '/platform/settings', { token: ownerTok, body: { daily: before.daily, utility: before.utility } })
  })

  await test('公司 Skill / MCP：列表、步骤摘要、token 不回传、权限、SPA', async () => {
    const login = await req(base, 'POST', '/auth/login', {
      body: { email: 'boss@invite.test', password: 'new-horse-10' },
    })
    assert(login.status === 200, `relogin ${login.status} ${login.text}`)
    const adminTok = login.json.token

    const empty = await req(base, 'GET', `/orgs/${inviteOrg}/skills`, { token: adminTok })
    assert(empty.status === 200, `list ${empty.status} ${empty.text}`)
    assert(Array.isArray(empty.json.skills) && empty.json.skills.length === 0, 'skills empty')
    assert(Array.isArray(empty.json.servers) && empty.json.servers.length === 0, 'servers empty')
    assert(Array.isArray(empty.json.tags) && empty.json.tags.includes('客服'), 'default tags')

    const created = await req(base, 'POST', `/orgs/${inviteOrg}/skills`, {
      token: adminTok,
      body: { name: '工单归类', body: '处理工单。\n\n- 读取来信\n- 归类\n- 回复', tags: ['客服'] },
    })
    assert(created.status === 201, `create ${created.status} ${created.text}`)
    assert(created.json.skill.name === '工单归类', 'name')
    assert(created.json.skill.steps === 3, `steps ${created.json.skill.steps}`)
    assert(created.json.skill.summary === '处理工单。', `summary ${created.json.skill.summary}`)
    assert(created.json.skill.enabled === true, 'enabled')
    assert(created.json.skill.source === '手动编写', 'source')
    const skillId = created.json.skill.id

    const patched = await req(base, 'PATCH', `/orgs/${inviteOrg}/skills/${skillId}`, {
      token: adminTok,
      body: { tags: ['客服', '自动化'], enabled: false },
    })
    assert(patched.status === 200, `patch ${patched.status} ${patched.text}`)
    assert(patched.json.skill.enabled === false, 'enabled false')
    assert(patched.json.skill.tags.includes('自动化'), 'tags')

    const one = await req(base, 'GET', `/orgs/${inviteOrg}/skills/${skillId}`, { token: adminTok })
    assert(one.status === 200 && one.json.skill.id === skillId, 'get skill')
    assert(one.json.skill.steps === 3, 'get steps')

    const zip = await req(base, 'POST', `/orgs/${inviteOrg}/skills`, {
      token: adminTok,
      body: {
        name: 'zip-skill',
        source: 'ZIP 包',
        files: [
          { path: 'SKILL.md', text: '从包来。\n\n- 一步\n- 两步' },
          { path: 'bin.dat', base64: 'aaaa' },
        ],
      },
    })
    assert(zip.status === 201, `zip ${zip.status} ${zip.text}`)
    assert(zip.json.skill.body.includes('从包来'), 'zip body from SKILL.md')
    assert(zip.json.skill.steps === 2, 'zip steps')
    assert(zip.json.skill.fileCount === 1, `fileCount ${zip.json.skill.fileCount}`)
    const zipId = zip.json.skill.id

    const mcp = await req(base, 'POST', `/orgs/${inviteOrg}/mcp-servers`, {
      token: adminTok,
      body: {
        name: 'zendesk-mcp',
        kind: 'SSE',
        endpoint: 'https://mcp.example.com/sse',
        perm: '只读',
        token: 'secret-mcp-token',
        env: { API_KEY: 'mcp-env-secret-value' },
      },
    })
    assert(mcp.status === 201, `mcp ${mcp.status} ${mcp.text}`)
    assert(mcp.json.server.name === 'zendesk-mcp', 'mcp name')
    assert(mcp.json.server.hasToken === true, 'hasToken')
    assert(mcp.json.server.hasEnv === true, 'hasEnv')
    assert(!Object.prototype.hasOwnProperty.call(mcp.json.server, 'token'), 'no token field on create')
    assert(!dumpHas(mcp.json, 'secret-mcp-token'), 'create 泄漏 token')
    assert(!dumpHas(mcp.json, 'mcp-env-secret-value'), 'create 泄漏 env')
    if (mcp.json.server.env) {
      for (const v of Object.values(mcp.json.server.env)) assert(v === '', `env value ${v}`)
    }
    const serverId = mcp.json.server.id

    const mcpList = await req(base, 'GET', `/orgs/${inviteOrg}/mcp-servers`, { token: adminTok })
    assert(mcpList.status === 200, `mcp list ${mcpList.status}`)
    assert(!dumpHas(mcpList.json, 'mcp-env-secret-value'), 'list 泄漏 env')
    assert(!dumpHas(mcpList.json, 'secret-mcp-token'), 'list 泄漏 token')

    const mcpGet = await req(base, 'GET', `/orgs/${inviteOrg}/mcp-servers/${serverId}`, { token: adminTok })
    assert(mcpGet.status === 200, `mcp get ${mcpGet.status}`)
    assert(mcpGet.json.server.hasToken === true, 'get hasToken')
    assert(!Object.prototype.hasOwnProperty.call(mcpGet.json.server, 'token'), 'no token field on get')
    assert(!dumpHas(mcpGet.json, 'secret-mcp-token'), 'get 泄漏 token')
    assert(!dumpHas(mcpGet.json, 'mcp-env-secret-value'), 'get 泄漏 env')

    const mcpPatch = await req(base, 'PATCH', `/orgs/${inviteOrg}/mcp-servers/${serverId}`, {
      token: adminTok,
      body: { token: 'rotated-mcp-token' },
    })
    assert(mcpPatch.status === 200, `mcp patch ${mcpPatch.status} ${mcpPatch.text}`)
    assert(mcpPatch.json.server.hasToken === true, 'patch hasToken')
    assert(!Object.prototype.hasOwnProperty.call(mcpPatch.json.server, 'token'), 'no token field on patch')
    assert(!dumpHas(mcpPatch.json, 'rotated-mcp-token'), 'patch 泄漏 token')

    const afterTok = await req(base, 'GET', `/orgs/${inviteOrg}/mcp-servers/${serverId}`, { token: adminTok })
    assert(afterTok.json.server.hasToken === true, 'still hasToken')
    assert(!dumpHas(afterTok.json, 'rotated-mcp-token'), 'later get 泄漏 token')

    const denySkill = await req(base, 'POST', `/orgs/${inviteOrg}/skills`, {
      token: invitedTok,
      body: { name: '不该成功' },
    })
    assert(denySkill.status === 403, `member skill ${denySkill.status}`)
    const denyMcp = await req(base, 'POST', `/orgs/${inviteOrg}/mcp-servers`, {
      token: invitedTok,
      body: { name: '不该成功', endpoint: 'https://x' },
    })
    assert(denyMcp.status === 403, `member mcp ${denyMcp.status}`)

    const emptyName = await req(base, 'POST', `/orgs/${inviteOrg}/skills`, {
      token: adminTok,
      body: { name: '   ' },
    })
    assert(emptyName.status === 400, `empty ${emptyName.status} ${emptyName.text}`)
    assert(String(emptyName.json.error).includes('要有名字'), 'empty name 文案')

    const noEndpoint = await req(base, 'POST', `/orgs/${inviteOrg}/mcp-servers`, {
      token: adminTok,
      body: { name: 'no-url', kind: 'HTTP' },
    })
    assert(noEndpoint.status === 400, `endpoint ${noEndpoint.status}`)
    assert(String(noEndpoint.json.error).includes('要有服务器地址'), 'endpoint 文案')

    const spa = await req(base, 'GET', '/skills')
    assert(spa.status === 200, `spa ${spa.status}`)
    assert(String(spa.text).includes('<!doctype html>') || String(spa.text).includes('Satuwork'), 'spa html')

    const delS = await req(base, 'DELETE', `/orgs/${inviteOrg}/skills/${skillId}`, { token: adminTok })
    assert(delS.status === 200 && delS.json.deleted === true && delS.json.id === skillId, 'delete skill')
    const goneS = await req(base, 'GET', `/orgs/${inviteOrg}/skills/${skillId}`, { token: adminTok })
    assert(goneS.status === 404, `gone skill ${goneS.status}`)
    assert(String(goneS.json.error).includes('没有这个 Skill'), '404 skill 文案')

    const delZ = await req(base, 'DELETE', `/orgs/${inviteOrg}/skills/${zipId}`, { token: adminTok })
    assert(delZ.status === 200 && delZ.json.deleted === true, 'delete zip skill')

    const delM = await req(base, 'DELETE', `/orgs/${inviteOrg}/mcp-servers/${serverId}`, { token: adminTok })
    assert(delM.status === 200 && delM.json.deleted === true && delM.json.id === serverId, 'delete mcp')
    const goneM = await req(base, 'GET', `/orgs/${inviteOrg}/mcp-servers/${serverId}`, { token: adminTok })
    assert(goneM.status === 404, `gone mcp ${goneM.status}`)
    assert(String(goneM.json.error).includes('没有这个 MCP 服务器'), '404 mcp 文案')
  })

  await test('模版持久化 skills/mcps ids；未知 id 忽略；成员改不动', async () => {
    const login = await req(base, 'POST', '/auth/login', {
      body: { email: 'boss@invite.test', password: 'new-horse-10' },
    })
    assert(login.status === 200, `relogin ${login.status} ${login.text}`)
    const adminTok = login.json.token

    const skill = await req(base, 'POST', `/orgs/${inviteOrg}/skills`, {
      token: adminTok,
      body: { name: '挂载技能', body: '一步' },
    })
    assert(skill.status === 201, `skill ${skill.status} ${skill.text}`)
    const skillId = skill.json.skill.id
    const mcp = await req(base, 'POST', `/orgs/${inviteOrg}/mcp-servers`, {
      token: adminTok,
      body: {
        name: '挂载mcp',
        kind: 'HTTP',
        endpoint: 'http://127.0.0.1:9',
        token: 'bind-secret-token',
        env: { API_KEY: 'mcp-env-runtime-secret' },
      },
    })
    assert(mcp.status === 201, `mcp ${mcp.status} ${mcp.text}`)
    const mcpId = mcp.json.server.id
    assert(!dumpHas(mcp.json, 'bind-secret-token'), 'create 泄漏 token')
    assert(!dumpHas(mcp.json, 'mcp-env-runtime-secret'), 'create 泄漏 env')

    const cat = await req(base, 'GET', '/catalog/mcp', { token: adminTok })
    assert(cat.status === 200, `catalog mcp ${cat.status}`)
    assert(!dumpHas(cat.json, 'bind-secret-token'), 'catalog/mcp 泄漏 token')
    for (const item of cat.json.items || []) {
      assert(!item.definition || item.definition.token == null, 'definition.token')
    }

    // 挂载在**模版**上，不在某一个 Bot 上：认识的收下，不认识的丢掉。
    const created = await req(base, 'PUT', `/orgs/${inviteOrg}/bot-template`, {
      token: adminTok,
      body: { skills: [skillId, 'no-such'], mcps: [mcpId, 'nope'] },
    })
    assert(created.status === 200, `create ${created.status} ${created.text}`)
    assert(JSON.stringify(created.json.template.skills) === JSON.stringify([skillId]), `skills ${JSON.stringify(created.json.template.skills)}`)
    assert(JSON.stringify(created.json.template.mcps) === JSON.stringify([mcpId]), `mcps ${JSON.stringify(created.json.template.mcps)}`)

    const bot = await req(base, 'POST', '/runtime/bots', { token: adminTok, body: { name: '带挂载' } })
    assert(bot.status === 201, `建 ${bot.status} ${bot.text}`)
    assert(bot.json.bot.skillCount === 1, 'skillCount')
    assert(bot.json.bot.mcpCount === 1, 'mcpCount')
    const id = bot.json.bot.id

    const got = await req(base, 'GET', `/runtime/bots/${id}`, { token: adminTok })
    assert(got.status === 200, `get ${got.status}`)
    assert(got.json.bot.skills[0] === skillId && got.json.bot.mcps[0] === mcpId, 'get ids')

    // /runtime/catalog 会带出 MCP 明文 token 与 env，只给席位 sat_，不给浏览器 JWT。
    const rtJwt = await req(base, 'GET', '/runtime/catalog', { token: adminTok })
    assert(rtJwt.status === 401, `runtime 不该收 JWT ${rtJwt.status} ${rtJwt.text}`)
    assert(!dumpHas(rtJwt.json, 'bind-secret-token'), 'JWT 拿到了 MCP token')
    assert(!dumpHas(rtJwt.json, 'mcp-env-runtime-secret'), 'JWT 拿到了 MCP env')
    const orgMcp = await req(base, 'GET', `/orgs/${inviteOrg}/mcp-servers/${mcpId}`, { token: adminTok })
    assert(!dumpHas(orgMcp.json, 'bind-secret-token'), 'org get 泄漏 token')
    assert(!dumpHas(orgMcp.json, 'mcp-env-runtime-secret'), 'org get 泄漏 env')
    const meAdmin = await req(base, 'GET', '/me', { token: adminTok })
    const platAcc = await req(base, 'GET', `/platform/accounts/${meAdmin.json.account.id}`, { token: ownerTok })
    const satRt = await req(base, 'GET', '/runtime/catalog', { token: platAcc.json.accessToken })
    assert(satRt.status === 200, `sat runtime ${satRt.status} ${satRt.text}`)
    const satSrv = (satRt.json.servers || []).find((x) => x.id === mcpId)
    assert(satSrv && satSrv.token === 'bind-secret-token', 'sat runtime 应带 token')
    assert(satSrv.env && satSrv.env.API_KEY === 'mcp-env-runtime-secret', 'sat runtime 应带 env')
    const rtKey = await req(base, 'GET', '/runtime/catalog', { token: platAcc.json.apiKey })
    assert(rtKey.status === 401, `runtime 不该收 sk_sw_ ${rtKey.status}`)

    const patched = await req(base, 'PUT', `/orgs/${inviteOrg}/bot-template`, {
      token: adminTok,
      body: { skills: [], mcps: [mcpId] },
    })
    assert(patched.status === 200, `patch ${patched.status} ${patched.text}`)
    assert(Array.isArray(patched.json.template.skills) && patched.json.template.skills.length === 0, 'cleared skills')
    // 已经建好的那个 Bot 跟着变，不用碰它。
    const after = await req(base, 'GET', `/runtime/bots/${id}`, { token: adminTok })
    assert(after.json.bot.skillCount === 0, `skillCount 0，实际 ${after.json.bot.skillCount}`)
    assert(after.json.bot.mcpCount === 1, 'mcpCount stays')

    const deny = await req(base, 'PUT', `/orgs/${inviteOrg}/bot-template`, {
      token: invitedTok,
      body: { skills: [skillId] },
    })
    assert(deny.status === 403, `member patch ${deny.status}`)

    const opts = await req(base, 'GET', `/orgs/${inviteOrg}/bot-template`, { token: adminTok })
    assert(opts.status === 200, `options ${opts.status}`)
    assert(opts.json.options.skills.some((s) => s.id === skillId && s.name === '挂载技能'), 'options skills')
    assert(opts.json.options.mcps.some((s) => s.id === mcpId && s.name === '挂载mcp'), 'options mcps')
    await req(base, 'DELETE', `/runtime/bots/${id}`, { token: adminTok })
  })

  child.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 400))
  try {
    child.kill('SIGKILL')
  } catch {}
}
