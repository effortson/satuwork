/**
 * 手机推送（gateway/src/lib/push.ts，docs/adr-core-package-mobile.md §2.5）。
 *
 * 单起一个 Gateway，把 APNs 指到本机一个**明文 HTTP/2 的假 APNs**（GATEWAY_APNS_ENDPOINT）。
 * 假 APNs 用 Gateway 拿到的那把 EC 钥匙的公钥验 provider token，按设备令牌决定回 200 还是
 * 410，记下每一条请求的头和 payload。要钉住的是：
 *
 * - 登记只收登录 JWT、只收 iOS 的十六进制令牌；令牌换账号登录就改姓；只能删自己的。
 * - 席位报 turn-end → 推到这个人的每台设备；头（JWT、topic、push-type、collapse-id）和 payload
 *   对；通知正文使用有界的回复摘要；410 的令牌当场从库里摘掉。
 * - 改口令之后，旧登记不再收到推送；重新登记就恢复。
 * - 新转人工单推给接手人。
 */
import { generateKeyPairSync, verify } from 'node:crypto'
import { rmSync } from 'node:fs'
import { createServer } from 'node:http2'
import { createServer as createHttpServer } from 'node:http'
import { schemaOf, tmpOf } from './isolate.mjs'
import { freePorts } from './ports.mjs'
import { createCompany } from './org.mjs'
import { startGateway } from './gateway.mjs'
import { sleep } from './harness.mjs'
import { withPg } from './pg.mjs'
import { notificationClient } from '../gateway/test/helpers/notifications.mjs'
import { join } from 'node:path'

export const GOOD = 'a'.repeat(64)
export const DEAD = 'b'.repeat(64)
const TEAM = 'TEAM123456'
const KID = 'KEY1234567'

export function fakeApns(publicKey) {
  const seen = []
  let failures = 0
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
      if (failures > 0) {
        failures--
        stream.respond({ ':status': 500 })
        stream.end(JSON.stringify({ reason: 'InternalServerError' }))
        return
      }
      if (token === DEAD) {
        stream.respond({ ':status': 410, 'content-type': 'application/json' })
        stream.end(JSON.stringify({ reason: 'Unregistered', timestamp: Date.now() }))
        return
      }
      stream.respond({ ':status': 200, 'apns-id': 'x' })
      stream.end()
    })
  })
  return { server, seen, failOnce: () => { failures++ } }
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
  log('\n# push')

  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const apns = fakeApns(publicKey)
  await new Promise((r) => apns.server.listen(APNS_PORT, '127.0.0.1', r))
  const fcmKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const google = fakeGoogle(fcmKeys.publicKey, FCM_PORT)
  await new Promise((r) => google.server.listen(FCM_PORT, '127.0.0.1', r))

  /** 放进 try 里起：起不来时下面的 finally 照样收掉这一套自己开的假服务。 */
  let gw, gatewayEnv

  try {
    const launched = await startGateway({
      name: 'push-gw',
      what: 'push gateway',
      home: GW_HOME,
      schema: schemaOf('e2e_push'),
      port: GW_PORT,
      env: {
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
    gw = launched.gw
    gatewayEnv = launched.env
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
    let noticeSeq = 0
    const report = async (body, tok = seatTok) => {
      const expected = await withPg(schemaOf('e2e_push'), async (c) => Number((await c.query(
        'select count(*) as n from push_devices p join accounts a on a.id = p."accountId" where p."accountId" = $1 and p."updatedAt" > coalesce(a."tokenRevokedAt", 0)', [reg.account.id])).rows[0].n))
      const r = await req(base, 'POST', '/internal/push', { token: tok,
        body: { sessionId: 'push-session', seq: ++noticeSeq, time: Date.now(), ...body } })
      if (r.status !== 202) return r
      const deadline = Date.now() + 8000
      let rows = []
      while (Date.now() < deadline) {
        rows = await withPg(schemaOf('e2e_push'), async (c) => (await c.query(
          'select outcome from notification_deliveries where "eventId" = $1 and "deliveredAt" is not null', [r.json.id])).rows)
        if (rows.length >= expected) break
        await sleep(40)
      }
      assert(rows.length === expected, `通知队列没完成：${JSON.stringify(rows)} / ${expected}`)
      r.delivery = { sent: rows.filter((x) => x.outcome === 'sent').length,
        dropped: rows.filter((x) => x.outcome === 'dropped').length, failed: rows.filter((x) => x.outcome === 'failed').length }
      return r
    }

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
      assert(r.status === 202 && r.json.queued, `push ${r.status} ${r.text}`)
      assert(r.delivery.sent === 1 && r.delivery.dropped === 1 && r.delivery.failed === 0, `结果 ${r.text}`)
      assert(apns.seen.length === 2, `假 APNs 收到 ${apns.seen.length} 条`)
      const hit = apns.seen.find((s) => s.token === GOOD)
      assert(hit, '没打到 GOOD')
      assert(hit.path === `/3/device/${GOOD}`, `path ${hit.path}`)
      assert(hit.jwtOk, 'provider token 验不过签名')
      assert(hit.claims.head.alg === 'ES256' && hit.claims.head.kid === KID && hit.claims.body.iss === TEAM, `JWT ${JSON.stringify(hit.claims)}`)
      assert(hit.headers['apns-topic'] === 'sg.dami.satuwork.mobile', `topic ${hit.headers['apns-topic']}`)
      assert(hit.headers['apns-push-type'] === 'alert', 'push-type')
      assert(hit.headers['apns-collapse-id'] === `turn-end:${botId}`, `collapse ${hit.headers['apns-collapse-id']}`)
      // 过期时刻：一小时后（push.ts 的 PUSH_TTL_SECONDS）。手机离线再久，过了这个点 APNs 就不补发了。
      const exp = Number(hit.headers['apns-expiration']) - Math.floor(Date.now() / 1000)
      assert(exp > 3500 && exp <= 3600, `apns-expiration 不是一小时后：${hit.headers['apns-expiration']}`)
      assert(hit.payload.aps.alert.title === '推送 Bot', `title ${hit.payload.aps.alert.title}`)
      assert(hit.payload.aps.alert.body === '回复好了', `body ${hit.payload.aps.alert.body}`)
      assert(hit.payload.botId === botId && hit.payload.kind === 'turn-end', `data ${JSON.stringify(hit.payload)}`)
      // 点击定位字段保持不变，摘要只放在 alert.body 中。
      assert(Object.keys(hit.payload).sort().join(',') === 'aps,botId,kind,notificationId,seq,sessionId', `payload 多了东西：${JSON.stringify(hit.payload)}`)

      apns.seen.length = 0
      const again = await report({ kind: 'turn-end', botId })
      assert(again.delivery.sent === 1 && again.delivery.dropped === 0 && apns.seen.length === 1, `摘掉之后 ${again.text} / ${apns.seen.length}`)
    })

    await test('上报：kind 不认识 400、Bot 不存在 404、席位票只能报自己', async () => {
      assert((await report({ kind: 'whatever', botId })).status === 400, 'kind')
      assert((await report({ kind: 'approval', botId: 'no-such-bot' })).status === 404, 'botId')
      // 席位票带别人的 accountId 也只算自己的：成员没登记设备，这里推到的是 admin 的 GOOD。
      apns.seen.length = 0
      const r = await report({ kind: 'approval', botId, accountId: 'someone-else' })
      assert(r.status === 202 && r.delivery.sent === 1 && apns.seen[0]?.token === GOOD, `${r.text}`)
      assert(apns.seen[0].payload.aps.alert.body === '在等你批准一个操作', '审批文案')
    })

    await test('同一台手机换成员登录：令牌改姓，admin 不再收到；删只能删自己的', async () => {
      assert((await put(memberTok, { token: GOOD, platform: 'ios', environment: 'production' })).status === 200, '成员登记')
      const r = await report({ kind: 'turn-end', botId })
      assert(r.delivery.sent === 0 && r.json.queued === true, `admin 还收到：${r.text}`)
      assert(r.json.queued === true, '没有手机也要保存共享未读事件')
      const notMine = await req(base, 'DELETE', `/me/push-device/${GOOD}`, { token: adminTok })
      assert(notMine.status === 200 && notMine.json.removed === false, `admin 删得动成员的：${notMine.text}`)
      const mine = await req(base, 'DELETE', `/me/push-device/${GOOD}`, { token: memberTok })
      assert(mine.json.removed === true, `成员删不掉自己的：${mine.text}`)
    })

    await test('改口令之后旧登记不推，重新登记就恢复', async () => {
      assert((await put(adminTok, { token: GOOD, platform: 'ios', environment: 'production' })).status === 200, '登记')
      assert((await report({ kind: 'turn-end', botId })).delivery.sent === 1, '改口令前该推')
      // tokenRevokedAt 和登记时刻都是毫秒；隔开一点，别落在同一毫秒里。
      await sleep(5)
      const pw = await req(base, 'POST', '/me/password', { token: adminTok, body: { current: 'correct-horse', next: 'correct-horse-2' } })
      assert(pw.status === 200, `改口令 ${pw.status} ${pw.text}`)
      adminTok = pw.json.token
      const after = await report({ kind: 'turn-end', botId })
      assert(after.delivery.sent === 0, `改口令后还推了：${after.text}`)
      await sleep(5)
      assert((await put(adminTok, { token: GOOD, platform: 'ios', environment: 'production' })).status === 200, '重新登记')
      assert((await report({ kind: 'turn-end', botId })).delivery.sent === 1, '重新登记后该推')
    })

    await test('新转人工单推给接手人', async () => {
      apns.seen.length = 0
      const h = await req(base, 'POST', '/internal/handoffs', {
        token: seatTok,
        body: { id: 'h-push-1', sessionId: 's-1', notificationSeq: 1, botId, state: 'open', reason: '要人看', ask: '帮我确认一下' },
      })
      assert(h.status === 200, `handoff ${h.status} ${h.text}`)
      const deadline = Date.now() + 5000
      while (Date.now() < deadline && !apns.seen.length) await sleep(50)
      const hit = apns.seen[0]
      assert(hit && hit.payload.kind === 'handoff', `没收到转人工推送：${JSON.stringify(apns.seen)}`)
      assert(hit.payload.aps.alert.body === '帮我确认一下', '转人工通知没有展示具体待办')
    })

    await test('Android：FCM 令牌原样登记；一条推送 APNs 和 FCM 各发，换票一次，UNREGISTERED 当场摘掉', async () => {
      assert((await put(adminTok, { token: 'has space:APA91b' + 'x'.repeat(40), platform: 'android', environment: 'production' })).status === 400, '带空格的令牌该 400')
      assert((await put(adminTok, { token: FCM_GOOD, platform: 'ios', environment: 'production' })).status === 400, 'FCM 令牌报成 ios 该 400')
      assert((await put(adminTok, { token: GOOD, platform: 'android', environment: 'production' })).status === 400, 'APNs 令牌报成 android 该 400')
      // environment 报错了也收：FCM 不分环境，存成 production。
      assert((await put(adminTok, { token: FCM_GOOD, platform: 'android', environment: 'sandbox' })).status === 200, '登记 FCM_GOOD')
      assert((await put(adminTok, { token: FCM_DEAD, platform: 'android', environment: 'production' })).status === 200, '登记 FCM_DEAD')
      apns.seen.length = 0
      google.seen.sends.length = 0
      const r = await report({ kind: 'turn-end', botId })
      assert(r.status === 202 && r.json.queued, `push ${r.status} ${r.text}`)
      // admin 还登记着一台 iOS（改口令那条最后重新登记的 GOOD）。
      assert(r.delivery.sent === 2 && r.delivery.dropped === 1 && r.delivery.failed === 0, `结果 ${r.text}`)
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
      assert(m.data.kind === 'turn-end' && m.data.botId === botId && m.data.notificationId && m.data.sessionId === 'push-session', `data ${JSON.stringify(m.data)}`)
      assert(m.android.collapse_key === `turn-end:${botId}` && m.android.notification.tag === `satu:${m.data.notificationId}`, `android ${JSON.stringify(m.android)}`)
      assert(m.android.ttl === '3600s', `android.ttl ${m.android.ttl}`)
      assert(Object.keys(m).sort().join(',') === 'android,data,notification,token', `message 多了东西：${JSON.stringify(m)}`)

      google.seen.sends.length = 0
      const again = await report({ kind: 'turn-end', botId })
      assert(again.delivery.sent === 2 && again.delivery.dropped === 0, `摘掉之后 ${again.text}`)
      assert(google.seen.sends.length === 1, `FCM 第二轮收到 ${google.seen.sends.length} 条`)
      assert(google.seen.tokens.length === 1, `access token 没缓存：换了 ${google.seen.tokens.length} 次`)

      apns.seen.length = 0
      google.seen.sends.length = 0
      const preview = '## 发票整理完成\n\n已核对 **3 张**发票，合计 RM 1,250。代码：`*原样*`'
      const expectedPreview = '发票整理完成 已核对 3 张发票，合计 RM 1,250。代码：*原样*'
      const withPreview = await report({ kind: 'turn-end', botId, preview })
      assert(withPreview.delivery.sent === 2, '摘要通知没有发到两个平台')
      assert(apns.seen[0].payload.aps.alert.body === expectedPreview, 'APNs 没有实际回复摘要')
      assert(google.seen.sends[0].body.message.notification.body === expectedPreview, 'FCM 没有实际回复摘要')
      const notices = await req(base, 'GET', '/me/notifications', { token: adminTok })
      assert(notices.json.events.find((e) => e.id === withPreview.json.id)?.preview === expectedPreview, '桌面 / 网页快照没有相同摘要')
      const retry = await req(base, 'POST', '/internal/push', { token: seatTok,
        body: { kind: 'turn-end', botId, sessionId: 'push-session', seq: noticeSeq, time: Date.now(), preview: '重试不能换成另一轮的回复' } })
      assert(retry.json.id === withPreview.json.id, '摘要重试没有去重')
      const stored = await withPg(schemaOf('e2e_push'), async (c) => (await c.query('select preview from notification_events where id = $1', [retry.json.id])).rows[0])
      assert(stored.preview === expectedPreview, '同一事件的重试覆盖了原回复')

      const unicode = await report({ kind: 'turn-end', botId, preview: '😀'.repeat(300) })
      const unicodeBody = apns.seen.at(-1).payload.aps.alert.body
      assert(unicode.delivery.sent === 2 && Array.from(unicodeBody).length === 240 && unicodeBody.endsWith('…'), 'Unicode 摘要没正确截断')
      assert(google.seen.sends.at(-1).body.message.notification.body === unicodeBody, '两个平台的 Unicode 摘要不一致')

      const del = await req(base, 'DELETE', `/me/push-device/${encodeURIComponent(FCM_GOOD)}`, { token: adminTok })
      assert(del.json.removed === true, `FCM 令牌按原样删不掉：${del.text}`)
    })
    const snapshot = () => req(base, 'GET', '/me/notifications', { token: adminTok })
    const markRead = (sessionId, seq, token = adminTok) => req(base, 'PUT', '/me/notifications/read', { token, body: { botId, sessionId, seq } })
    const queue = (sessionId, seq, extra = {}) => req(base, 'POST', '/internal/push', { token: seatTok,
      body: { kind: 'turn-end', botId, sessionId, seq, time: Date.now(), ...extra } })
    const claim = (id, deviceId = 'web:notification_device_1234', token = adminTok) => req(base, 'POST', `/me/notifications/${id}/claim`, { token, body: { deviceId } })
    const clearUnread = async () => {
      const positions = await withPg(schemaOf('e2e_push'), async (c) => (await c.query(
        'select "sessionId", max(seq) as seq from notification_events where "accountId" = $1 group by "sessionId"', [reg.account.id])).rows)
      for (const row of positions) assert((await markRead(row.sessionId, Number(row.seq))).status === 200, '清除测试已有未读')
    }
    await clearUnread()

    await test('真 HTTP 三端同步：网页读过后，手机不推、桌面不弹，三端角标归零', async () => {
      const server = { api: async (_account, method, path, body) => {
        const r = await req(base, method, path, { token: adminTok, body })
        if (r.status >= 400) throw Object.assign(new Error(r.text), { status: r.status })
        return r.json
      } }
      const web = notificationClient(server, { focused: true })
      const mobile = notificationClient(server, { platform: 'mobile' })
      const desktop = notificationClient(server, { platform: 'desktop' })
      for (const ui of [web, mobile, desktop]) {
        ui.state.me.account.id = reg.account.id
        ui.state.runtimeBots = [{ id: botId, name: '推送 Bot' }]
        await ui.start()
      }
      apns.seen.length = 0
      const r = await queue('three-clients', 10)
      assert(r.status === 202 && r.json.queued, r.text)
      await Promise.all([web.poll(), mobile.poll(), desktop.poll()])
      for (const ui of [web, mobile, desktop]) assert(ui.document.title.startsWith('(1)'), `没同步未读：${ui.document.title}`)
      web.state.path = '/a/' + botId; web.state.chatBotId = botId; web.state.chatSessionId = 'three-clients'; web.state.chatEvents = [{ type: 'turn/end', seq: 10 }]
      web.read(); await web.poll()
      await sleep(2400)
      await Promise.all([mobile.poll(), desktop.poll()])
      for (const ui of [web, mobile, desktop]) assert(!ui.document.title.startsWith('('), `未读没有清掉：${ui.document.title}`)
      assert(apns.seen.length === 0, `已读仍推送：${apns.seen.length}`)
      assert(desktop.sent.length === 0, '已读仍弹桌面通知')
      assert(mobile.cleared.flat().includes(r.json.id), '手机没有收到清理已读通知指令')
      for (const ui of [web, mobile, desktop]) ui.context.resetDesktopNotifications()
    })

    await test('读取先于通知登记也能抑制推送；旧游标不能倒退，新会话不受影响', async () => {
      apns.seen.length = 0
      assert((await markRead('read-before-report', 30)).status === 200, '先报已读')
      const old = await markRead('read-before-report', 15)
      assert(old.json.read.lastReadSeq === 30, `游标倒退：${old.text}`)
      const a = await queue('read-before-report', 20)
      const b = await queue('new-session', 1)
      assert((await markRead('new-session', 1)).status === 200, '清新会话')
      assert(a.status === 202 && b.status === 202, '上报失败')
      const current = await snapshot()
      assert(current.json.counts.length === 0, current.text)
      await sleep(2400)
      assert(apns.seen.length === 0, '先读后到的通知不该推送')
      assert((await claim(a.json.id)).json.claimed === false, '已读还能领取')
    })

    await test('读过审批和转人工只清未读，待处理状态保持；处理终态先到也不会被旧 pending 复活', async () => {
      const sessionId = 'pending-work'
      const h = await req(base, 'POST', '/internal/handoffs', { token: seatTok,
        body: { id: 'h-notification-read', botId, sessionId, notificationSeq: 10, state: 'open', reason: '要人看', ask: '确认' } })
      assert(h.status === 200, h.text)
      const a = await queue(sessionId, 11, { kind: 'approval', actionId: 'approval-read' })
      assert(a.status === 202, a.text)
      assert((await snapshot()).json.counts[0]?.count === 2, '两项都应未读')
      assert((await markRead(sessionId, 11)).status === 200, '读过')
      const state = await withPg(schemaOf('e2e_push'), async (c) => ({
        handoff: (await c.query('select state from handoffs where id = $1', ['h-notification-read'])).rows[0],
        pending: (await c.query('select "resolvedAt" from notification_events where id = $1', [a.json.id])).rows[0],
      }))
      assert(state.handoff.state === 'open', '读过不该关闭交接单')
      assert(state.pending.resolvedAt === null, '读过不该批准操作或把它标成已处理')
      assert((await snapshot()).json.counts.length === 0, '未读没清')
      const resolved = await queue('out-of-order-approval', 5, { kind: 'approval', actionId: 'approval-order', resolved: true })
      const pending = await queue('out-of-order-approval', 5, { kind: 'approval', actionId: 'approval-order' })
      assert(resolved.json.id === pending.json.id, '业务标识不一致')
      assert((await snapshot()).json.counts.length === 0, '旧 pending 复活了已处理提醒')
    })

    await test('本地 Bot 也共享通知状态，但不向无法打开本地会话的手机推送', async () => {
      // 本地 Bot 只属于建它的那台电脑：建它、替它上报都得带这台的设备头（docs/local-bot-device.md）。
      const device = { 'x-satuwork-device': 'e2e-push-local-desk-01' }
      const made = await req(base, 'POST', '/runtime/bots', { token: adminTok, headers: device, body: { name: '本地通知助手', runtimeKind: 'local' } })
      assert(made.status === 201, made.text)
      const localId = made.json.bot.id
      const postLocal = (body, token = adminTok, headers = device) => req(base, 'POST', '/me/notifications/local', { token, headers,
        body: { botId: localId, sessionId: 'local-notices', kind: 'approval', actionId: 'local-approval', time: Date.now(), ...body } })
      apns.seen.length = 0
      const pending = await postLocal({ seq: 5 })
      assert(pending.status === 200, pending.text)
      assert((await postLocal({ seq: 5 }, memberTok)).status === 404, '能上报别人的本地 Bot')
      assert((await postLocal({ seq: 5 }, adminTok, { 'x-satuwork-device': 'e2e-push-other-desk-1' })).status === 404, '别的电脑能替这台的本地 Bot 上报')
      assert((await postLocal({ seq: 5, botId })).status === 400, '客户端冒充远程席位上报')
      assert((await snapshot()).json.counts.some((r) => r.botId === localId && r.count === 1), '本地事件没有共享未读')
      const mobileSnapshot = await req(base, 'GET', '/me/notifications?platform=mobile', { token: adminTok })
      assert(!mobileSnapshot.json.counts.some((r) => r.botId === localId), '手机显示了无法打开的本地 Bot 未读')
      await sleep(2300)
      assert(apns.seen.length === 0, '本地 Bot 不应向手机推送无法打开的会话')
      assert((await claim(pending.json.id, 'desktop:local_notice_device_1234')).json.claimed, '桌面不能领取本地提醒')
      const read = await req(base, 'PUT', '/me/notifications/read', { token: adminTok, body: { botId: localId, sessionId: 'local-notices', seq: 5 } })
      assert(read.status === 200, read.text)
      // 重连后只见到终态，也能按 actionId 清掉旧卡，且终态先到不会被旧 pending 复活。
      const terminal = await postLocal({ sessionId: 'local-reconnect', seq: 9, resolved: true })
      const late = await postLocal({ sessionId: 'local-reconnect', seq: 7 })
      assert(terminal.status === 200 && late.status === 200, '终态登记失败')
      assert(!(await snapshot()).json.counts.some((r) => r.botId === localId), '晚到的本地 pending 复活')
      await withPg(schemaOf('e2e_push'), (c) => c.query('delete from catalog_items where id = $1', [localId]))
      const remaining = await withPg(schemaOf('e2e_push'), (c) => c.query('select 1 from notification_events where "botId" = $1', [localId]))
      assert(remaining.rowCount === 0, '删除 Bot 后留下永久未读')
    })

    await test('并发上报只创建一条；设备并发领取只成功一次，其他账号不能领取', async () => {
      const replies = await Promise.all(Array.from({ length: 8 }, () => queue('idempotent', 1)))
      const id = replies[0].json.id
      assert(replies.every((r) => r.status === 202 && r.json.id === id), '上报没有幂等')
      assert((await snapshot()).json.counts[0]?.count === 1, '重复累计未读')
      assert((await claim(id)).json.claimed === false, '缓冲未到就能领取')
      await sleep(2200)
      const claims = await Promise.all(Array.from({ length: 8 }, () => claim(id)))
      assert(claims.filter((r) => r.json.claimed).length === 1, '同一设备重复领取')
      assert((await claim(id, 'desktop:notification_device_1234')).json.claimed === true, '第二台设备应能领取未读')
      assert((await claim(id, 'web:other_account_device_1234', memberTok)).json.claimed === false, '跨账号领取')
      await markRead('idempotent', 1)
      assert((await claim(id, 'web:another_device_123456')).json.claimed === false, '已读后还可领取')
      assert((await claim(id, 'push:forged_device_token_12345')).status === 400, '客户端冒充系统推送设备')
    })

    await test('离线旧消息保留未读，不补发过期推送；未登录和席位票不能修改阅读状态', async () => {
      apns.seen.length = 0
      const expired = await queue('expired-notice', 7, { time: Date.now() - 7200_000 })
      assert(expired.status === 202, expired.text)
      const state = await snapshot()
      assert(state.json.counts[0]?.count === 1, '过期推送不该抹掉未读')
      assert(!state.json.events.some((e) => e.id === expired.json.id), '过期提醒还会弹出')
      assert((await claim(expired.json.id)).json.claimed === false, '过期仍能领取')
      for (const token of ['', seatTok]) assert((await markRead('expired-notice', 7, token)).status === 401, '阅读状态必须使用本人登录票')
      assert((await markRead('expired-notice', -1)).status === 400, '非法序号')
      await sleep(2200)
      assert(apns.seen.length === 0, '旧提醒被补推')
      await markRead('expired-notice', 7)
    })

    await test('部分设备失败后按设备重试，成功设备不重复；重试前已读则取消', async () => {
      assert((await put(adminTok, { token: FCM_GOOD, platform: 'android', environment: 'production' })).status === 200, '登记 Android')
      apns.seen.length = 0; google.seen.sends.length = 0; apns.failOnce()
      const queued = await queue('partial-retry', 1)
      const deliveries = () => withPg(schemaOf('e2e_push'), async (c) => (await c.query(
        'select outcome from notification_deliveries where "eventId" = $1', [queued.json.id])).rows)
      let rows = [], deadline = Date.now() + 6000
      while (Date.now() < deadline) {
        rows = await deliveries()
        if (rows.some((r) => r.outcome === 'failed') && rows.some((r) => r.outcome === 'sent')) break
        await sleep(40)
      }
      assert(rows.some((r) => r.outcome === 'failed'), '没有记录失败')
      await withPg(schemaOf('e2e_push'), (c) => c.query(
        'update notification_deliveries set "leaseUntil" = 0 where "eventId" = $1 and outcome = \'failed\'', [queued.json.id]))
      deadline = Date.now() + 4000
      while (Date.now() < deadline && (await deliveries()).filter((r) => r.outcome === 'sent').length !== 2) await sleep(40)
      assert((await deliveries()).filter((r) => r.outcome === 'sent').length === 2, '租约到期没有补投')
      assert(apns.seen.length === 2 && google.seen.sends.length === 1, '成功的设备也被重发了')
      await markRead('partial-retry', 1)

      apns.failOnce()
      const cancel = await queue('cancel-retry', 1)
      deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        const failed = await withPg(schemaOf('e2e_push'), (c) => c.query(
          'select 1 from notification_deliveries where "eventId" = $1 and outcome = \'failed\'', [cancel.json.id]))
        if (failed.rowCount) break
        await sleep(40)
      }
      await markRead('cancel-retry', 1)
      const before = apns.seen.length
      await withPg(schemaOf('e2e_push'), (c) => c.query(
        'update notification_deliveries set "leaseUntil" = 0 where "eventId" = $1', [cancel.json.id]))
      await sleep(1300)
      assert(apns.seen.length === before, '已读后仍重试失败的推送')
      await req(base, 'DELETE', `/me/push-device/${encodeURIComponent(FCM_GOOD)}`, { token: adminTok })
    })

    await test('Gateway 重启后从数据库恢复调度，已读游标也保留', async () => {
      apns.seen.length = 0
      const queued = await queue('restart-notice', 1)
      assert(queued.status === 202, queued.text)
      const previous = gw
      const stopped = new Promise((resolve) => previous.once('exit', resolve))
      previous.kill('SIGKILL'); await stopped
      gw = start('push-gw-restarted', ['--import', 'tsx', join(gwRoot, 'src/index.ts')], {
        cwd: gwRoot, env: { ...gatewayEnv, GATEWAY_PG_RESET: '0' },
      })
      await waitHttp(`${base}/health`, { child: gw, what: 'restarted notification gateway' })
      const deadline = Date.now() + 6000
      while (Date.now() < deadline && !apns.seen.some((e) => e.payload.notificationId === queued.json.id)) await sleep(50)
      assert(apns.seen.filter((e) => e.payload.notificationId === queued.json.id).length === 1, '重启没有恢复或重复投递')
      const state = await snapshot()
      assert(state.json.reads.some((r) => r.sessionId === 'read-before-report' && r.lastReadSeq === 30), '重启丢已读')
      await markRead('restart-notice', 1)
    })

  } finally {
    gw?.kill()
    await new Promise((r) => apns.server.close(r))
    await new Promise((r) => google.server.close(r))
    try {
      rmSync(GW_HOME, { recursive: true, force: true })
    } catch {}
  }
}
