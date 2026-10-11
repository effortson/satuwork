/**
 * 手机推送（gateway/src/lib/push.ts，docs/adr-core-package-mobile.md §2.5）。
 *
 * 单起一个 Gateway，把 APNs 指到本机一个**明文 HTTP/2 的假 APNs**（GATEWAY_APNS_ENDPOINT）。
 * 假 APNs 用 Gateway 拿到的那把 EC 钥匙的公钥验 provider token，按设备令牌决定回 200 还是
 * 410，记下每一条请求的头和 payload。要钉住的是：
 *
 * - 登记只收登录 JWT、只收 iOS 的十六进制令牌；令牌换账号登录就改姓；只能删自己的。
 * - 席位报 turn-end → 推到这个人的每台设备；头（JWT、topic、push-type、collapse-id）和 payload
 *   对；**payload 里没有对话正文**；410 的令牌当场从库里摘掉。
 * - 改口令之后，旧登记不再收到推送；重新登记就恢复。
 * - 新转人工单推给接手人。
 */
import { generateKeyPairSync, verify } from 'node:crypto'
import { rmSync } from 'node:fs'
import { createServer } from 'node:http2'
import { join } from 'node:path'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { freePorts } from './ports.mjs'
import { createCompany } from './org.mjs'

export const GOOD = 'a'.repeat(64)
export const DEAD = 'b'.repeat(64)
const TEAM = 'TEAM123456'
const KID = 'KEY1234567'

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

export function fakeApns(publicKey) {
  const seen = []
  const server = createServer()
  server.on('stream', (stream, headers) => {
    let raw = ''
    stream.setEncoding('utf8')
    stream.on('data', (c) => (raw += c))
    stream.on('end', () => {
      const path = String(headers[':path'] || '')
      const token = path.split('/').pop()
      const auth = String(headers.authorization || '')
      let jwtOk = false
      let claims = null
      try {
        const [h, c, s] = auth.replace(/^bearer /, '').split('.')
        jwtOk = verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))
        claims = { head: JSON.parse(Buffer.from(h, 'base64url').toString()), body: JSON.parse(Buffer.from(c, 'base64url').toString()) }
      } catch {}
      let payload = null
      try {
        payload = JSON.parse(raw)
      } catch {}
      seen.push({ path, token, headers: { ...headers }, payload, jwtOk, claims })
      if (token === DEAD) {
        stream.respond({ ':status': 410, 'content-type': 'application/json' })
        stream.end(JSON.stringify({ reason: 'Unregistered', timestamp: Date.now() }))
        return
      }
      stream.respond({ ':status': 200, 'apns-id': 'x' })
      stream.end()
    })
  })
  return { server, seen }
}

export async function runPush({ gwRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = tmpOf('satuwork-e2e-push-gw')
  const [GW_PORT, APNS_PORT] = await freePorts(2)
  const base = `http://127.0.0.1:${GW_PORT}`
  rmSync(GW_HOME, { recursive: true, force: true })
  log('\n# push')

  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const apns = fakeApns(publicKey)
  await new Promise((r) => apns.server.listen(APNS_PORT, '127.0.0.1', r))

  const gw = start('push-gw', ['--import', 'tsx', join(gwRoot, 'src/index.ts')], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: schemaOf('e2e_push'),
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '1',
      GATEWAY_OWNER_EMAIL: 'owner@push.test',
      GATEWAY_OWNER_PASSWORD: 'test-owner-push',
      // 整段 base64：验「放不下换行的平台」那条读法。
      GATEWAY_APNS_KEY: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64'),
      GATEWAY_APNS_KEY_ID: KID,
      GATEWAY_APNS_TEAM_ID: TEAM,
      GATEWAY_APNS_ENDPOINT: `http://127.0.0.1:${APNS_PORT}`,
    },
  })

  try {
    await waitHttp(`${base}/health`, { child: gw, what: 'push gateway' })
    const reg = await createCompany(req, base, {
      ownerEmail: 'owner@push.test',
      ownerPassword: 'test-owner-push',
      email: 'admin@push.test',
      password: 'correct-horse',
      companyName: 'PushCo',
      slug: 'pushco',
      seats: 2,
    })
    let adminTok = reg.token
    const orgId = reg.company.id
    const member = await req(base, 'POST', `/orgs/${orgId}/accounts`, {
      token: adminTok,
      body: { email: 'member@push.test', password: 'correct-horse', role: 'member' },
    })
    assert(member.status === 201, `member ${member.status} ${member.text}`)
    const memberTok = (await req(base, 'POST', '/auth/login', { body: { email: 'member@push.test', password: 'correct-horse' } })).json.token
    const seat = await req(base, 'GET', `/platform/accounts/${reg.account.id}`, { token: reg.ownerToken })
    assert(seat.status === 200, `seat ${seat.status} ${seat.text}`)
    const seatTok = seat.json.accessToken
    const bot = await req(base, 'POST', '/platform/bots', { token: reg.ownerToken, body: { name: '推送 Bot' } })
    assert(bot.status === 201, `bot ${bot.status} ${bot.text}`)
    const botId = bot.json.bot.id

    const put = (tok, body) => req(base, 'PUT', '/me/push-device', { token: tok, body })
    const report = (body, tok = seatTok) => req(base, 'POST', '/internal/push', { token: tok, body })

    await test('登记：没登录 401、席位票 401、坏令牌 / 非 iOS / 坏环境 400', async () => {
      assert((await put('', { token: GOOD, platform: 'ios', environment: 'production' })).status === 401, '没登录')
      assert((await put(seatTok, { token: GOOD, platform: 'ios', environment: 'production' })).status === 401, '席位票不该能登记设备')
      for (const body of [
        { token: 'not-hex', platform: 'ios', environment: 'production' },
        { token: GOOD, platform: 'android', environment: 'production' },
        { token: GOOD, platform: 'ios', environment: 'staging' },
      ]) {
        const r = await put(adminTok, body)
        assert(r.status === 400, `${JSON.stringify(body)} → ${r.status} ${r.text}`)
      }
    })

    await test('席位报 turn-end：两台设备各一条，头和 payload 对，410 的令牌当场摘掉', async () => {
      assert((await put(adminTok, { token: GOOD, platform: 'ios', environment: 'production' })).status === 200, '登记 GOOD')
      assert((await put(adminTok, { token: DEAD.toUpperCase(), platform: 'ios', environment: 'sandbox' })).status === 200, '登记 DEAD（大写也收）')
      apns.seen.length = 0
      const r = await report({ kind: 'turn-end', botId })
      assert(r.status === 200, `push ${r.status} ${r.text}`)
      assert(r.json.sent === 1 && r.json.dropped === 1 && r.json.failed === 0, `结果 ${r.text}`)
      assert(apns.seen.length === 2, `假 APNs 收到 ${apns.seen.length} 条`)
      const hit = apns.seen.find((s) => s.token === GOOD)
      assert(hit, '没打到 GOOD')
      assert(hit.path === `/3/device/${GOOD}`, `path ${hit.path}`)
      assert(hit.jwtOk, 'provider token 验不过签名')
      assert(hit.claims.head.alg === 'ES256' && hit.claims.head.kid === KID && hit.claims.body.iss === TEAM, `JWT ${JSON.stringify(hit.claims)}`)
      assert(hit.headers['apns-topic'] === 'sg.dami.satuwork.mobile', `topic ${hit.headers['apns-topic']}`)
      assert(hit.headers['apns-push-type'] === 'alert', 'push-type')
      assert(hit.headers['apns-collapse-id'] === `turn-end:${botId}`, `collapse ${hit.headers['apns-collapse-id']}`)
      assert(hit.payload.aps.alert.title === '推送 Bot', `title ${hit.payload.aps.alert.title}`)
      assert(hit.payload.aps.alert.body === '回复好了', `body ${hit.payload.aps.alert.body}`)
      assert(hit.payload.botId === botId && hit.payload.kind === 'turn-end', `data ${JSON.stringify(hit.payload)}`)
      // 只有这几个键：对话正文不该出现在推送里。
      assert(Object.keys(hit.payload).sort().join(',') === 'aps,botId,kind', `payload 多了东西：${JSON.stringify(hit.payload)}`)

      apns.seen.length = 0
      const again = await report({ kind: 'turn-end', botId })
      assert(again.json.sent === 1 && again.json.dropped === 0 && apns.seen.length === 1, `摘掉之后 ${again.text} / ${apns.seen.length}`)
    })

    await test('上报：kind 不认识 400、Bot 不存在 404、席位票只能报自己', async () => {
      assert((await report({ kind: 'whatever', botId })).status === 400, 'kind')
      assert((await report({ kind: 'approval', botId: 'no-such-bot' })).status === 404, 'botId')
      // 席位票带别人的 accountId 也只算自己的：成员没登记设备，这里推到的是 admin 的 GOOD。
      apns.seen.length = 0
      const r = await report({ kind: 'approval', botId, accountId: 'someone-else' })
      assert(r.status === 200 && r.json.sent === 1 && apns.seen[0]?.token === GOOD, `${r.text}`)
      assert(apns.seen[0].payload.aps.alert.body === '在等你批准一个操作', '审批文案')
    })

    await test('同一台手机换成员登录：令牌改姓，admin 不再收到；删只能删自己的', async () => {
      assert((await put(memberTok, { token: GOOD, platform: 'ios', environment: 'production' })).status === 200, '成员登记')
      const r = await report({ kind: 'turn-end', botId })
      assert(r.json.sent === 0 && r.json.skipped === '没有登记设备', `admin 还收到：${r.text}`)
      const notMine = await req(base, 'DELETE', `/me/push-device/${GOOD}`, { token: adminTok })
      assert(notMine.status === 200 && notMine.json.removed === false, `admin 删得动成员的：${notMine.text}`)
      const mine = await req(base, 'DELETE', `/me/push-device/${GOOD}`, { token: memberTok })
      assert(mine.json.removed === true, `成员删不掉自己的：${mine.text}`)
    })

    await test('改口令之后旧登记不推，重新登记就恢复', async () => {
      assert((await put(adminTok, { token: GOOD, platform: 'ios', environment: 'production' })).status === 200, '登记')
      assert((await report({ kind: 'turn-end', botId })).json.sent === 1, '改口令前该推')
      // tokenRevokedAt 和登记时刻都是毫秒；隔开一点，别落在同一毫秒里。
      await sleep(5)
      const pw = await req(base, 'POST', '/me/password', { token: adminTok, body: { current: 'correct-horse', next: 'correct-horse-2' } })
      assert(pw.status === 200, `改口令 ${pw.status} ${pw.text}`)
      adminTok = pw.json.token
      const after = await report({ kind: 'turn-end', botId })
      assert(after.json.sent === 0, `改口令后还推了：${after.text}`)
      await sleep(5)
      assert((await put(adminTok, { token: GOOD, platform: 'ios', environment: 'production' })).status === 200, '重新登记')
      assert((await report({ kind: 'turn-end', botId })).json.sent === 1, '重新登记后该推')
    })

    await test('新转人工单推给接手人', async () => {
      apns.seen.length = 0
      const h = await req(base, 'POST', '/internal/handoffs', {
        token: seatTok,
        body: { id: 'h-push-1', sessionId: 's-1', botId, state: 'open', reason: '要人看', ask: '帮我确认一下' },
      })
      assert(h.status === 200, `handoff ${h.status} ${h.text}`)
      const deadline = Date.now() + 5000
      while (Date.now() < deadline && !apns.seen.length) await sleep(50)
      const hit = apns.seen[0]
      assert(hit && hit.payload.kind === 'handoff', `没收到转人工推送：${JSON.stringify(apns.seen)}`)
      assert(!JSON.stringify(hit.payload).includes('帮我确认一下'), '转人工的推送带上了 ask 原文')
    })
  } finally {
    gw.kill()
    await new Promise((r) => apns.server.close(r))
    try {
      rmSync(GW_HOME, { recursive: true, force: true })
    } catch {}
  }
}
