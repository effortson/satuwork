/**
 * `POST /runtime/bots/:id/local-bootstrap`：桌面端本地 Bot 的那一套凭证。
 *
 * 以前这里直接交出账号那一套席位凭证（`sat_` / `sk_sw_`），而那一套从来不换——改口令、
 * 管理员重置都作废不了它。一张被偷的登录票于是一次请求就能换成一对永久有效的凭证。
 * 现在给的是单独一套（迁移 0041），跟登录票同生共死。钉四件事：
 *
 *   · 给出去的不是席位那一套；
 *   · 这一套能干本地 Bot 该干的事（拉目录、调模型）；
 *   · 改口令之后它和旧登录票一起作废，重新要到的是新的一套；席位那一套照旧能用；
 *   · 几颗本地 Bot 同时来要（换新那一刻），拿到的是同一套。
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { createCompany } from './org.mjs'
import { freePort } from './ports.mjs'

export async function runLocalBootstrap({ gwRoot, test, req, start, waitHttp, assert, log }) {
  log('\n# local-bootstrap')
  const GW_HOME = tmpOf('satuwork-e2e-local-bootstrap')
  rmSync(GW_HOME, { recursive: true, force: true })
  const GW_PORT = await freePort()
  const base = `http://127.0.0.1:${GW_PORT}`
  const gw = start('local-bootstrap-gw', ['--import', 'tsx', join(gwRoot, 'src/index.ts')], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: schemaOf('e2e_local_bootstrap'),
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '1',
      GATEWAY_OWNER_EMAIL: 'owner@local.test',
      GATEWAY_OWNER_PASSWORD: 'test-owner-local',
    },
  })

  try {
    await waitHttp(`${base}/health`, { child: gw, what: 'local-bootstrap gateway' })
    const reg = await createCompany(req, base, {
      ownerEmail: 'owner@local.test',
      ownerPassword: 'test-owner-local',
      email: 'admin@local.test',
      password: 'correct-horse-1',
      companyName: 'LocalCo',
      slug: 'localco',
    })
    let adminTok = reg.token
    const me = await req(base, 'GET', '/me', { token: adminTok })
    const accountId = me.json.account.id
    const seat = await req(base, 'GET', `/platform/accounts/${accountId}`, { token: reg.ownerToken })
    assert(seat.status === 200 && seat.json.accessToken, `席位凭证 ${seat.status} ${seat.text}`)

    const made = await req(base, 'POST', '/runtime/bots', { token: adminTok, body: { name: '本地助手', runtimeKind: 'local' } })
    assert(made.status === 201, `建本地 Bot ${made.status} ${made.text}`)
    const botId = made.json.bot.id
    const bootstrap = (tok) => req(base, 'POST', `/runtime/bots/${botId}/local-bootstrap`, { token: tok, body: {} })

    let first
    await test('给出去的是桌面那一套，不是席位那一套；这一套能拉目录、能调模型', async () => {
      const r = await bootstrap(adminTok)
      assert(r.status === 200, `bootstrap ${r.status} ${r.text}`)
      first = r.json
      assert(first.accessToken.startsWith('sat_') && first.apiKey.startsWith('sk_sw_'), `前缀不对：${r.text}`)
      assert(first.accessToken !== seat.json.accessToken, '交出去的还是席位那把 sat_')
      assert(first.apiKey !== seat.json.apiKey, '交出去的还是席位那把 sk_sw_')
      const again = await bootstrap(adminTok)
      assert(again.json.accessToken === first.accessToken, '没换登录票，再要一次该是同一套')

      const catalog = await req(base, 'GET', `/runtime/catalog?botId=${botId}`, { token: first.accessToken })
      assert(catalog.status === 200, `桌面那把 sat_ 拉不了目录：${catalog.status} ${catalog.text}`)
      const models = await req(base, 'GET', '/v1/models', { token: first.apiKey })
      assert(models.status === 200, `桌面那把 sk_sw_ 调不了 /v1：${models.status} ${models.text}`)
    })

    await test('改口令：桌面那一套跟旧登录票一起作废，重新要到新的一套；席位那一套照旧', async () => {
      // 作废按秒比（登录票的 iat）；桌面凭证按毫秒比，但先跨过这一秒，两边的结论都是确定的。
      await new Promise((r) => setTimeout(r, 1100))
      const changed = await req(base, 'POST', '/me/password', {
        token: adminTok,
        body: { current: 'correct-horse-1', next: 'correct-horse-2' },
      })
      assert(changed.status === 200, `改口令 ${changed.status} ${changed.text}`)
      adminTok = changed.json.token

      const catalog = await req(base, 'GET', `/runtime/catalog?botId=${botId}`, { token: first.accessToken })
      assert(catalog.status === 401, `改口令之后旧的桌面 sat_ 还能用：${catalog.status}`)
      const models = await req(base, 'GET', '/v1/models', { token: first.apiKey })
      assert(models.status === 401, `改口令之后旧的桌面 sk_sw_ 还能用：${models.status}`)

      const seatCatalog = await req(base, 'GET', '/runtime/catalog', { token: seat.json.accessToken })
      assert(seatCatalog.status === 200, `席位那一套不该受影响：${seatCatalog.status} ${seatCatalog.text}`)

      // 几颗本地 Bot 同时来要：先回去的那颗拿到的票不能转眼就被后一套顶掉。
      const [a, b, c] = await Promise.all([bootstrap(adminTok), bootstrap(adminTok), bootstrap(adminTok)])
      assert(a.status === 200 && b.status === 200 && c.status === 200, `并发要票 ${a.status} ${b.status} ${c.status}`)
      assert(a.json.accessToken === b.json.accessToken && b.json.accessToken === c.json.accessToken, '并发要到了不同的几套')
      assert(a.json.accessToken !== first.accessToken, '改口令之后要到的还是旧的那一套')
      const fresh = await req(base, 'GET', `/runtime/catalog?botId=${botId}`, { token: a.json.accessToken })
      assert(fresh.status === 200, `新的一套拉不了目录：${fresh.status} ${fresh.text}`)
    })
  } finally {
    gw.kill('SIGTERM')
    try {
      rmSync(GW_HOME, { recursive: true, force: true })
    } catch {}
  }
}
