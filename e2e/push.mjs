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
import { createServer as createHttpServer } from 'node:http'
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

// FCM 令牌区分大小写、带冒号：原样存、原样发（gateway/src/lib/push.ts 的 normalizePushToken）。
const FCM_GOOD = 'cAbC123_-xyz:APA91b' + 'Qx'.repeat(70)
const FCM_DEAD = 'dEaD456_-xyz:APA91b' + 'Zz'.repeat(70)
const FCM_PROJECT = 'satuwork-e2e'
const FCM_EMAIL = 'push@satuwork-e2e.iam.gserviceaccount.com'

/**
 * 假的 Google：`/token` 是 OAuth2 换票（验服务账号私钥签的 RS256 JWT），`/v1/projects/<项目>/messages:send`
 * 是 FCM HTTP v1。FCM_DEAD 回 404 UNREGISTERED（卸载了的手机就是这么回的）。
 */
function fakeGoogle(publicKey, port) {
  const seen = { tokens: [], sends: [] }
  const server = createHttpServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      if (req.url === '/token') {
        const form = new URLSearchParams(raw)
        let ok = false
        let claims = null
        try {
          const [h, c, sig] = String(form.get('assertion') || '').split('.')
          ok = verify('sha256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(sig, 'base64url'))
          claims = JSON.parse(Buffer.from(c, 'base64url').toString())
        } catch {}
        seen.tokens.push({ grant: form.get('grant_type'), ok, claims })
        if (!ok) {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid_grant' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ access_token: 'fcm-access-1', expires_in: 3600, token_type: 'Bearer' }))
        return
      }
      let body = null
      try {
        body = JSON.parse(raw)
      } catch {}
      seen.sends.push({ url: req.url, auth: req.headers.authorization, body })
      if (body?.message?.token === FCM_DEAD) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND', message: 'Requested entity was not found.', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ name: `projects/${FCM_PROJECT}/messages/1` }))
    })
  })
  return {
    server,
    seen,
    serviceAccount: (privatePem) =>
      JSON.stringify({
        type: 'service_account',
        project_id: FCM_PROJECT,
        client_email: FCM_EMAIL,
        private_key: privatePem,
        token_uri: `http://127.0.0.1:${port}/token`,
      }),
  }
}

export async function runPush({ gwRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = tmpOf('satuwork-e2e-push-gw')
  const [GW_PORT, APNS_PORT, FCM_PORT] = await freePorts(3)
  const base = `http://127.0.0.1:${GW_PORT}`
  rmSync(GW_HOME, { recursive: true, force: true })
  log('\n# push')

  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const apns = fakeApns(publicKey)
  await new Promise((r) => apns.server.listen(APNS_PORT, '127.0.0.1', r))
  const fcmKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const google = fakeGoogle(fcmKeys.publicKey, FCM_PORT)
  await new Promise((r) => google.server.listen(FCM_PORT, '127.0.0.1', r))

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
      // 服务账号 JSON 原文（不是 base64）：验另一种读法。
      GATEWAY_FCM_SERVICE_ACCOUNT: google.serviceAccount(fcmKeys.privateKey.export({ type: 'pkcs8', format: 'pem' })),
      GATEWAY_FCM_ENDPOINT: `http://127.0.0.1:${FCM_PORT}`,
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

    await test('登记：没登录 401、席位票 401、坏令牌 / 不认识的平台 / 坏环境 400', async () => {
      assert((await put('', { token: GOOD, platform: 'ios', environment: 'production' })).status === 401, '没登录')
      assert((await put(seatTok, { token: GOOD, platform: 'ios', environment: 'production' })).status === 401, '席位票不该能登记设备')
      for (const body of [
        { token: 'not-hex', platform: 'ios', environment: 'production' },
        { token: GOOD, platform: 'windows', environment: 'production' },
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

    await test('Android：FCM 令牌原样登记；一条推送 APNs 和 FCM 各发，换票一次，UNREGISTERED 当场摘掉', async () => {
      assert((await put(adminTok, { token: 'has space:APA91b' + 'x'.repeat(40), platform: 'android', environment: 'production' })).status === 400, '带空格的令牌该 400')
      assert((await put(adminTok, { token: FCM_GOOD, platform: 'ios', environment: 'production' })).status === 400, 'FCM 令牌报成 ios 该 400')
      // environment 报错了也收：FCM 不分环境，存成 production。
      assert((await put(adminTok, { token: FCM_GOOD, platform: 'android', environment: 'sandbox' })).status === 200, '登记 FCM_GOOD')
      assert((await put(adminTok, { token: FCM_DEAD, platform: 'android', environment: 'production' })).status === 200, '登记 FCM_DEAD')
      apns.seen.length = 0
      google.seen.sends.length = 0
      const r = await report({ kind: 'turn-end', botId })
      assert(r.status === 200, `push ${r.status} ${r.text}`)
      // admin 还登记着一台 iOS（改口令那条最后重新登记的 GOOD）。
      assert(r.json.sent === 2 && r.json.dropped === 1 && r.json.failed === 0, `结果 ${r.text}`)
      assert(apns.seen.length === 1, `APNs 收到 ${apns.seen.length} 条`)
      assert(google.seen.tokens.length === 1, `换票 ${google.seen.tokens.length} 次`)
      const t = google.seen.tokens[0]
      assert(t.ok && t.grant === 'urn:ietf:params:oauth:grant-type:jwt-bearer', `换票 ${JSON.stringify(t)}`)
      assert(t.claims.iss === FCM_EMAIL && t.claims.scope === 'https://www.googleapis.com/auth/firebase.messaging', `claims ${JSON.stringify(t.claims)}`)
      assert(google.seen.sends.length === 2, `FCM 收到 ${google.seen.sends.length} 条`)
      const hit = google.seen.sends.find((x) => x.body?.message?.token === FCM_GOOD)
      assert(hit, `FCM 没收到原样的令牌：${JSON.stringify(google.seen.sends.map((x) => x.body?.message?.token))}`)
      assert(hit.url === `/v1/projects/${FCM_PROJECT}/messages:send`, `url ${hit.url}`)
      assert(hit.auth === 'Bearer fcm-access-1', `auth ${hit.auth}`)
      const m = hit.body.message
      assert(m.notification.title === '推送 Bot' && m.notification.body === '回复好了', `notification ${JSON.stringify(m.notification)}`)
      assert(JSON.stringify(m.data) === JSON.stringify({ kind: 'turn-end', botId }), `data ${JSON.stringify(m.data)}`)
      assert(m.android.collapse_key === `turn-end:${botId}` && m.android.notification.tag === `turn-end:${botId}`, `android ${JSON.stringify(m.android)}`)
      assert(Object.keys(m).sort().join(',') === 'android,data,notification,token', `message 多了东西：${JSON.stringify(m)}`)

      google.seen.sends.length = 0
      const again = await report({ kind: 'turn-end', botId })
      assert(again.json.sent === 2 && again.json.dropped === 0, `摘掉之后 ${again.text}`)
      assert(google.seen.sends.length === 1, `FCM 第二轮收到 ${google.seen.sends.length} 条`)
      assert(google.seen.tokens.length === 1, `access token 没缓存：换了 ${google.seen.tokens.length} 次`)

      const del = await req(base, 'DELETE', `/me/push-device/${encodeURIComponent(FCM_GOOD)}`, { token: adminTok })
      assert(del.json.removed === true, `FCM 令牌按原样删不掉：${del.text}`)
    })
  } finally {
    gw.kill()
    await new Promise((r) => apns.server.close(r))
    await new Promise((r) => google.server.close(r))
    try {
      rmSync(GW_HOME, { recursive: true, force: true })
    } catch {}
  }
}
