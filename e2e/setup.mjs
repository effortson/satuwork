/**
 * 首次启动：一个 owner 都没有时，先出「创建系统管理员」那一屏。
 *
 * 这里不驱动浏览器，验的是它背后的两条接口和那条不变量——
 * **只在一个 owner 都没有时能建**，否则任何人都能再造一个 owner 出来。
 */
import { rmSync } from 'node:fs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { freePort } from './ports.mjs'
import { startGateway } from './gateway.mjs'

export async function runSetup({ gwRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = tmpOf('satuwork-e2e-setup-gw')
  const GW_PORT = await freePort()
  const gwBase = `http://127.0.0.1:${GW_PORT}`

  log('\n# setup')

  const { gw } = await startGateway({
    name: 'setup-gw',
    what: 'setup gateway',
    home: GW_HOME,
    schema: schemaOf('e2e_setup'),
    port: GW_PORT,
    env: {
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      // 关键：不播种，模拟全新部署。
      GATEWAY_SEED_OWNER: '0',
    },
  })

  try {
    await test('空库：GET /auth/state → needsSetup true，且不泄漏任何账号信息', async () => {
      const r = await req(gwBase, 'GET', '/auth/state')
      assert(r.status === 200, `state ${r.status} ${r.text}`)
      assert(r.json.needsSetup === true, `needsSetup ${r.json.needsSetup}`)
      assert(Object.keys(r.json).length === 1, `只该回 needsSetup，实际 ${JSON.stringify(r.json)}`)
    })

    await test('首页仍返回 SPA，由前端按 needsSetup 画创建页', async () => {
      const r = await req(gwBase, 'GET', '/')
      assert(r.status === 200, `spa ${r.status}`)
      assert(String(r.text).includes('<!doctype html>') || String(r.text).includes('Satuwork'), 'spa html')
    })

    await test('口令太短 → 400，不建人', async () => {
      const r = await req(gwBase, 'POST', '/auth/setup', {
        body: { email: 'owner@setup.test', password: 'short' },
      })
      assert(r.status === 400, `短口令 ${r.status} ${r.text}`)
      const st = await req(gwBase, 'GET', '/auth/state')
      assert(st.json.needsSetup === true, '失败的创建把状态改了')
    })

    let token = ''
    await test('POST /auth/setup 建出 owner，当场就是登录态', async () => {
      const r = await req(gwBase, 'POST', '/auth/setup', {
        body: { email: 'Owner@Setup.test', name: '老板', password: 'correct-horse-1' },
      })
      assert(r.status === 201, `setup ${r.status} ${r.text}`)
      assert(r.json.account.role === 'owner', `role ${r.json.account.role}`)
      assert(r.json.account.email === 'owner@setup.test', `邮箱应归一化成小写：${r.json.account.email}`)
      assert(r.json.account.name === '老板', `name ${r.json.account.name}`)
      assert(r.json.company === null, 'owner 不属于公司')
      assert(typeof r.json.token === 'string' && r.json.token.split('.').length === 3, '没给 JWT')
      assert(!JSON.stringify(r.json).includes('scrypt$'), '响应里带口令散列')
      token = r.json.token
    })

    await test('建完 needsSetup 翻成 false，且票能用', async () => {
      const st = await req(gwBase, 'GET', '/auth/state')
      assert(st.json.needsSetup === false, `needsSetup ${st.json.needsSetup}`)
      const me = await req(gwBase, 'GET', '/me', { token })
      assert(me.status === 200, `me ${me.status} ${me.text}`)
      assert(me.json.account.role === 'owner', 'me role')
    })

    await test('已经有 owner 之后再 POST /auth/setup → 409', async () => {
      const r = await req(gwBase, 'POST', '/auth/setup', {
        body: { email: 'second@setup.test', password: 'correct-horse-2' },
      })
      assert(r.status === 409, `第二个 owner ${r.status} ${r.text}`)
      const login = await req(gwBase, 'POST', '/auth/login', {
        body: { email: 'second@setup.test', password: 'correct-horse-2' },
      })
      assert(login.status === 401, `被拒的账号居然能登录 ${login.status}`)
    })

    await test('并发点两次「创建」也只成一个', async () => {
      // **必须换一个干净的库。** 在当前这个 gateway 上跑，因为上面已经建过 owner，两条
      // 请求必然都 409——断言过得去，但那条「谁先谁赢」的竞态一次都没跑到。这个测试
      // 以前就是这么空过的。
      const { gw: raceGw, base: raceBase, home: RACE_HOME } = await startGateway({
        name: 'setup-race-gw',
        what: 'setup race gateway',
        home: tmpOf('satuwork-e2e-setup-race'),
        schema: schemaOf('e2e_setup_race'),
        env: {
          GATEWAY_ACCESS_HOST: 'satuwork.com',
          GATEWAY_SEED_OWNER: '0',
        },
      })
      try {
        const r = await Promise.all([
          req(raceBase, 'POST', '/auth/setup', { body: { email: 'race1@setup.test', password: 'correct-horse-3' } }),
          req(raceBase, 'POST', '/auth/setup', { body: { email: 'race2@setup.test', password: 'correct-horse-3' } }),
        ])
        const codes = r.map((x) => x.status)
        const won = codes.filter((c) => c === 201 || c === 200)
        assert(won.length === 1, `应当**恰好一条**成功，实际 ${codes.join('/')}`)
        assert(
          codes.every((c) => won.length === 1 && (c === 201 || c === 200 || c === 409)),
          `另一条应当 409，实际 ${codes.join('/')}`,
        )
        // 真正的不变量：库里只能有一个 owner。
        const st = await req(raceBase, 'GET', '/auth/state')
        assert(st.json.needsSetup === false, '建完之后 needsSetup 还是 true')
        const winner = r.find((x) => x.status === 201 || x.status === 200)
        const me = await req(raceBase, 'GET', '/me', { token: winner.json.token })
        assert(me.status === 200 && me.json.account.role === 'owner', '赢的那条应当就是 owner')
        // 输的那个邮箱不该被建出来
        const loser = r.find((x) => x !== winner)
        const email = loser === r[0] ? 'race1@setup.test' : 'race2@setup.test'
        const login = await req(raceBase, 'POST', '/auth/login', {
          body: { email, password: 'correct-horse-3' },
        })
        assert(login.status === 401, `被拒的那个账号居然能登录 ${login.status}`)
      } finally {
        try {
          raceGw.kill()
        } catch {}
        rmSync(RACE_HOME, { recursive: true, force: true })
      }
    })
  } finally {
    gw.kill()
    try {
      rmSync(GW_HOME, { recursive: true, force: true })
    } catch {}
  }
}
