/**
 * 登录类接口的失败限流（gateway/src/lib/auth-throttle.ts）。
 *
 * 单起一个 Gateway，把窗口缩到几秒、上限调小，好在一轮 e2e 里把「锁住 → 等 → 解开」走完。
 * 所有请求都从 127.0.0.1 来，所以 IP 桶在这里是一个桶——最后一条专门验它。
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { freePort } from './ports.mjs'

const WINDOW_MS = 10000
const MAX_ACCOUNT = 5
const MAX_IP = 15

export async function runAuthThrottle({ gwRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = tmpOf('satuwork-e2e-auth-throttle-gw')
  const GW_PORT = await freePort()
  const base = `http://127.0.0.1:${GW_PORT}`
  rmSync(GW_HOME, { recursive: true, force: true })
  log('\n# auth-throttle')

  const gw = start('auth-throttle-gw', ['--import', 'tsx', join(gwRoot, 'src/index.ts')], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: schemaOf('e2e_auth_throttle'),
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '0',
      GATEWAY_AUTH_WINDOW_MS: String(WINDOW_MS),
      GATEWAY_AUTH_MAX_ACCOUNT_FAILS: String(MAX_ACCOUNT),
      GATEWAY_AUTH_MAX_IP_FAILS: String(MAX_IP),
    },
  })
  await waitHttp(`${base}/health`, { child: gw, what: 'auth-throttle gateway' })

  const email = 'owner@throttle.test'
  const password = 'correct-horse-9'
  const login = (e, p) => req(base, 'POST', '/auth/login', { body: { email: e, password: p } })
  // 这一窗口里 IP 桶已经记了几次失败，最后一条按它算还差几次。
  let ipFails = 0

  try {
    await test('建 owner（/auth/setup）', async () => {
      const r = await req(base, 'POST', '/auth/setup', { body: { email, password } })
      assert(r.status === 201, `setup ${r.status} ${r.text}`)
    })

    let retryAfter = 0
    await test(`同一邮箱错 ${MAX_ACCOUNT} 次都是 401，再错一次 → 429 带 Retry-After`, async () => {
      for (let i = 0; i < MAX_ACCOUNT; i++) {
        const r = await login(email, 'wrong-password-' + i)
        assert(r.status === 401, `第 ${i + 1} 次 ${r.status} ${r.text}`)
        ipFails += 1
      }
      const r = await login(email, 'wrong-password-x')
      assert(r.status === 429, `超了之后 ${r.status} ${r.text}`)
      retryAfter = Number(r.headers.get('retry-after'))
      assert(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= WINDOW_MS / 1000, `Retry-After ${r.headers.get('retry-after')}`)
      assert(r.json.retryAfter === retryAfter, `body.retryAfter ${r.json.retryAfter}`)
      assert(/尝试次数太多/.test(r.json.error), `文案 ${r.json.error}`)
    })

    await test('锁住期间口令对了也不放行', async () => {
      const r = await login(email, password)
      assert(r.status === 429, `正确口令 ${r.status} ${r.text}`)
      assert(!r.json.token, '锁住期间签出了票')
    })

    await test('别的邮箱不受影响（被挡下的那几次也没记到 IP 桶上）', async () => {
      const r = await login('ghost@throttle.test', 'wrong-password')
      assert(r.status === 401, `别的邮箱 ${r.status} ${r.text}`)
      ipFails += 1
    })

    await test('过了窗口自动解开；登录成功清掉之前的失败', async () => {
      await new Promise((r) => setTimeout(r, retryAfter * 1000 + 500))
      const ok = await login(email, password)
      assert(ok.status === 200 && ok.json.token, `窗口过后 ${ok.status} ${ok.text}`)
      // 窗口已经翻过，IP 桶也从头数。
      ipFails = 0
      // 清过了：再错 MAX_ACCOUNT 次仍然是 401，不会第一次就 429。
      for (let i = 0; i < MAX_ACCOUNT - 1; i++) {
        const r = await login(email, 'wrong-again-' + i)
        assert(r.status === 401, `清零后第 ${i + 1} 次 ${r.status} ${r.text}`)
        ipFails += 1
      }
      const back = await login(email, password)
      assert(back.status === 200, `没到上限时正确口令 ${back.status} ${back.text}`)
    })

    await test('并发打同一个邮箱：只放 MAX 次去验，其余 429', async () => {
      const n = MAX_ACCOUNT + 3
      const rs = await Promise.all(Array.from({ length: n }, (_, i) => login('race@throttle.test', 'wrong-' + i)))
      const s401 = rs.filter((r) => r.status === 401).length
      const s429 = rs.filter((r) => r.status === 429).length
      assert(s401 === MAX_ACCOUNT && s429 === n - MAX_ACCOUNT, `401×${s401} 429×${s429}：${rs.map((r) => r.status).join(',')}`)
      ipFails += s401
    })

    await test('IP 桶：登录和领邀请的失败算在一起，满了换邮箱也 429', async () => {
      let i = 0
      while (ipFails < MAX_IP) {
        const r = i % 2
          ? await req(base, 'POST', `/invites/no-such-token-${i}/accept`, { body: { password: 'whatever-long-1' } })
          : await login(`spray${i}@throttle.test`, 'wrong-password')
        assert(r.status === (i % 2 ? 400 : 401), `第 ${ipFails + 1} 次失败 ${r.status} ${r.text}`)
        ipFails += 1
        i += 1
      }
      const r = await login('fresh@throttle.test', 'wrong-password')
      assert(r.status === 429 && Number(r.headers.get('retry-after')) >= 1, `IP 满了之后登录 ${r.status} ${r.text}`)
      const inv = await req(base, 'POST', '/invites/no-such-token-final/accept', { body: { password: 'whatever-long-1' } })
      assert(inv.status === 429, `IP 满了之后领邀请 ${inv.status} ${inv.text}`)
    })
  } finally {
    gw.kill()
    try {
      rmSync(GW_HOME, { recursive: true, force: true })
    } catch {}
  }
}
