import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { advanceHttps, clearHttps, httpsDomainOf, httpsReplyOf, httpsReportOf, startHttps } from '../src/deploy/https.ts'
import type { Db, Machine, MachineHttps } from '../src/db.ts'

/**
 * 只实现 advanceHttps 碰得到的那几个方法。updateMachine 照真的那样合并 patch；casMachineHttps
 * 照真的那样只在 nonce + stage 对得上时才写。
 */
function fakeDb(start: Machine) {
  let row = start
  const audits: unknown[] = []
  const db = {
    updateMachine: async (_id: string, patch: Partial<Machine>) => {
      row = { ...row, ...patch }
      return row
    },
    casMachineHttps: async (_id: string, expect: { nonce: string; stage: string }, next: MachineHttps | null) => {
      if (row.https?.nonce !== expect.nonce || row.https?.stage !== expect.stage) return false
      row = { ...row, https: next }
      return true
    },
    machine: async () => row,
    tx: async <T>(fn: () => Promise<T>) => fn(),
    seatRuntimesOfMachine: async () => [],
    audit: async (a: unknown) => {
      audits.push(a)
    },
  } as unknown as Db
  return { db, row: () => row, set: (m: Machine) => (row = m), audits }
}

function machine(https: Partial<MachineHttps> | null, over: Partial<Machine> = {}): Machine {
  const now = Date.now()
  return {
    id: 'm1',
    host: 'http://10.0.0.5:8443',
    directUrl: null,
    companyId: 'c1',
    pairedAt: now,
    protocol: 14,
    token: 'smt_test',
    https: https && {
      domain: 'm1.example.com',
      stage: 'provision',
      nonce: 'n'.repeat(32),
      prevHost: null,
      prevDirectUrl: null,
      error: null,
      machinePhase: null,
      machineLoopback: false,
      startedAt: now,
      stageAt: now,
      ...https,
    },
    ...over,
  } as Machine
}

/** 按 URL 路径给回包。没列到的一律当连不上。`during` 在每次请求时跑一下，用来模拟探测途中别人改了库。 */
const realFetch = globalThis.fetch
function stubFetch(routes: Record<string, number>, during?: () => void) {
  const seen: { url: string; auth: string | null }[] = []
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const auth = new Headers(init?.headers).get('authorization')
    seen.push({ url, auth })
    during?.()
    const path = new URL(url).pathname
    const status = routes[path]
    if (status == null) throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
    return new Response(JSON.stringify({ ok: status < 300 }), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return seen
}
afterEach(() => {
  globalThis.fetch = realFetch
})

const NONCE = 'n'.repeat(32)
const ready = { domain: 'm1.example.com', phase: 'ready', error: null, loopbackOnly: false, nonce: NONCE }

test('domain shape: strips scheme, lowercases, rejects IPs and junk that would break the Caddyfile', () => {
  assert.equal(httpsDomainOf('https://NG1.Example.com/'), 'ng1.example.com')
  for (const bad of ['1.2.3.4', 'localhost', 'a.com {\n}', 'a .com', 'a.com:443', 'a.com/x']) {
    assert.throws(() => httpsDomainOf(bad), undefined, bad)
  }
})

test('reply: nothing without a record; failed keeps loopback off and stops the manager retrying', () => {
  assert.equal(httpsReplyOf(machine(null)), null)
  assert.deepEqual(httpsReplyOf(machine({ stage: 'provision' })), { domain: 'm1.example.com', loopbackOnly: false, nonce: 'n'.repeat(32) })
  assert.equal(httpsReplyOf(machine({ stage: 'lockdown' }))?.loopbackOnly, true)
  assert.equal(httpsReplyOf(machine({ stage: 'done' }))?.loopbackOnly, true)
  assert.equal(httpsReplyOf(machine({ stage: 'rollback' }))?.loopbackOnly, false)
  assert.deepEqual(httpsReplyOf(machine({ stage: 'failed' })), { domain: null, loopbackOnly: false, nonce: null })
})

test('report parsing ignores unknown phases', () => {
  assert.equal(httpsReportOf({ phase: 'pwned' }), undefined)
  assert.equal(httpsReportOf(null), undefined)
  assert.deepEqual(httpsReportOf({ domain: 'a.com', phase: 'ready', loopbackOnly: true }), { domain: 'a.com', phase: 'ready', error: null, loopbackOnly: true, nonce: null })
})

test('provision → lockdown only after the nonce check passes, and the token never goes out before it', async () => {
  const f = fakeDb(machine({}))
  const seen = stubFetch({ '/ingress-check': 404, '/health': 200 })
  const after = await advanceHttps(f.db, f.row(), ready)
  assert.equal(after.https?.stage, 'provision', 'wrong nonce → stay')
  assert.match(after.https?.error ?? '', /不像是这台机器/)
  assert.equal(after.host, 'http://10.0.0.5:8443')
  assert.ok(seen.every((s) => !s.auth), 'no machine token sent to an unverified domain')

  const seen2 = stubFetch({ '/ingress-check': 200, '/health': 200 })
  const next = await advanceHttps(f.db, f.row(), ready)
  assert.equal(next.https?.stage, 'lockdown')
  assert.equal(next.host, 'https://m1.example.com')
  assert.equal(next.directUrl, 'https://m1.example.com')
  assert.equal(next.https?.prevHost, 'http://10.0.0.5:8443')
  assert.equal(seen2[0].url, `https://m1.example.com/ingress-check?nonce=${'n'.repeat(32)}`)
  assert.equal(seen2[0].auth, null)
  assert.equal(seen2[1].auth, 'Bearer smt_test')
  assert.equal(f.audits.length, 1)
})

test('provision: manager error → failed; timeout → failed', async () => {
  const f = fakeDb(machine({}))
  const out = await advanceHttps(f.db, f.row(), { ...ready, phase: 'error', error: 'apt 装不上 caddy' })
  assert.equal(out.https?.stage, 'failed')
  assert.equal(out.https?.error, 'apt 装不上 caddy')

  const old = Date.now() - 21 * 60_000
  const g = fakeDb(machine({ stageAt: old, startedAt: old }))
  const t = await advanceHttps(g.db, g.row(), { ...ready, phase: 'working' })
  assert.equal(t.https?.stage, 'failed')
})

test('provision ignores a report about a different domain', async () => {
  const f = fakeDb(machine({}))
  stubFetch({ '/ingress-check': 200, '/health': 200 })
  const out = await advanceHttps(f.db, f.row(), { ...ready, domain: 'other.example.com' })
  assert.equal(out.https?.stage, 'provision')
})

test('lockdown → done once the manager is loopback-only and reachable through the domain', async () => {
  const f = fakeDb(machine({ stage: 'lockdown', prevHost: 'http://10.0.0.5:8443' }, { host: 'https://m1.example.com' }))
  stubFetch({ '/health': 200 })
  const wait = await advanceHttps(f.db, f.row(), { ...ready, loopbackOnly: false })
  assert.equal(wait.https?.stage, 'lockdown', 'still listening publicly → keep waiting')
  const done = await advanceHttps(f.db, f.row(), { ...ready, loopbackOnly: true })
  assert.equal(done.https?.stage, 'done')
})

test('lockdown unreachable past the grace period → rollback restores both addresses, then failed once the manager reopens', async () => {
  const old = Date.now() - 4 * 60_000
  const f = fakeDb(
    machine(
      { stage: 'lockdown', stageAt: old, loopbackAt: old, prevHost: 'http://10.0.0.5:8443', prevDirectUrl: null },
      { host: 'https://m1.example.com', directUrl: 'https://m1.example.com' },
    ),
  )
  stubFetch({})
  const rb = await advanceHttps(f.db, f.row(), { ...ready, loopbackOnly: true })
  assert.equal(rb.https?.stage, 'rollback')
  assert.equal(rb.host, 'http://10.0.0.5:8443')
  assert.equal(rb.directUrl, null)
  assert.equal(httpsReplyOf(rb)?.loopbackOnly, false, 'the next heartbeat reply tells the manager to reopen')

  const still = await advanceHttps(f.db, f.row(), { ...ready, loopbackOnly: true })
  assert.equal(still.https?.stage, 'rollback')
  const failed = await advanceHttps(f.db, f.row(), { ...ready, loopbackOnly: false })
  assert.equal(failed.https?.stage, 'failed')
  assert.match(failed.https?.error ?? '', /已撤回/)
})

test('switching a finished machine to another domain is refused while its address still depends on the old one', async () => {
  const f = fakeDb(machine({ stage: 'done' }, { host: 'https://m1.example.com' }))
  await assert.rejects(startHttps(f.db, f.row(), 'm2.example.com'), /已经用 m1\.example\.com 配好了/)
})

test('lockdown unreachable within the grace period → keep waiting, addresses untouched', async () => {
  const f = fakeDb(machine({ stage: 'lockdown', prevHost: 'http://10.0.0.5:8443' }, { host: 'https://m1.example.com' }))
  stubFetch({})
  const out = await advanceHttps(f.db, f.row(), { ...ready, loopbackOnly: true })
  assert.equal(out.https?.stage, 'lockdown')
  assert.equal(out.host, 'https://m1.example.com')
})

test('retrying the same domain is not killed by the previous attempt\'s error still in the heartbeat', async () => {
  // 上一次失败（nonce=old）；人又按了一次，记录里是新 nonce。管家这一轮报的还是旧的那份。
  const f = fakeDb(machine({ nonce: 'm'.repeat(32) }))
  const stale = { ...ready, phase: 'error', error: '证书没拿到', nonce: 'o'.repeat(32) }
  const out = await advanceHttps(f.db, f.row(), stale)
  assert.equal(out.https?.stage, 'provision')
  // 管家拿到新 nonce 之后报的 error 才算数。
  const real = await advanceHttps(f.db, f.row(), { ...stale, nonce: 'm'.repeat(32) })
  assert.equal(real.https?.stage, 'failed')
})

test('lockdown: manager reports it could not lock → rollback right away', async () => {
  const f = fakeDb(machine({ stage: 'lockdown', prevHost: 'http://10.0.0.5:8443' }, { host: 'https://m1.example.com', directUrl: 'https://m1.example.com' }))
  const out = await advanceHttps(f.db, f.row(), { ...ready, error: '改成只听回环失败：EROFS' })
  assert.equal(out.https?.stage, 'rollback')
  assert.equal(out.host, 'http://10.0.0.5:8443')
  assert.match(out.https?.error ?? '', /EROFS/)
})

test('lockdown: manager never locks (offline, busy, downgraded) → rollback after the timeout, and clear becomes possible', async () => {
  const fresh = fakeDb(machine({ stage: 'lockdown' }, { host: 'https://m1.example.com' }))
  await assert.rejects(clearHttps(fresh.db, fresh.row()), /正在切换监听/)
  const wait = await advanceHttps(fresh.db, fresh.row(), ready)
  assert.equal(wait.https?.stage, 'lockdown')

  const old = Date.now() - 31 * 60_000
  const f = fakeDb(machine({ stage: 'lockdown', stageAt: old, prevHost: 'http://10.0.0.5:8443' }, { host: 'https://m1.example.com' }))
  const rb = await advanceHttps(f.db, f.row(), ready)
  assert.equal(rb.https?.stage, 'rollback')
  assert.equal(rb.host, 'http://10.0.0.5:8443')

  // 心跳根本不来的话推不动它：超时之后放人手动撤。
  const g = fakeDb(machine({ stage: 'lockdown', stageAt: old }))
  const cleared = await clearHttps(g.db, g.row())
  assert.equal(cleared.https, null)
})

test('lockdown grace counts from the first loopback report, not from entering lockdown', async () => {
  // 进 lockdown 已经 10 分钟（管家在等部署跑完），这一轮才第一次报只听回环、探活又慢了一下。
  const old = Date.now() - 10 * 60_000
  const f = fakeDb(machine({ stage: 'lockdown', stageAt: old, prevHost: 'http://10.0.0.5:8443' }, { host: 'https://m1.example.com' }))
  stubFetch({})
  const out = await advanceHttps(f.db, f.row(), { ...ready, loopbackOnly: true })
  assert.equal(out.https?.stage, 'lockdown')
  assert.ok(out.https?.loopbackAt && Date.now() - out.https.loopbackAt < 5000)
  assert.equal(out.host, 'https://m1.example.com')
})

test('a PUT that lands during the probes wins: the heartbeat does not resurrect a cleared record or switch addresses', async () => {
  const f = fakeDb(machine({}))
  // 探测途中有人按了「撤掉」。
  stubFetch({ '/ingress-check': 200, '/health': 200 }, () => f.set({ ...f.row(), https: null }))
  const out = await advanceHttps(f.db, f.row(), ready)
  assert.equal(out.https, null)
  assert.equal(f.row().https, null)
  assert.equal(f.row().host, 'http://10.0.0.5:8443')
  assert.equal(f.audits.length, 0)

  // 探测途中有人按了「重新开始」（换了 nonce）：旧这一轮的结论不写回去。
  const g = fakeDb(machine({}))
  stubFetch({}, () => g.set({ ...g.row(), https: { ...g.row().https!, nonce: 'z'.repeat(32) } }))
  await advanceHttps(g.db, g.row(), ready)
  assert.equal(g.row().https?.nonce, 'z'.repeat(32))
  assert.equal(g.row().https?.error, null)
})

test('starting over on a machine already done with the same domain is refused', async () => {
  const f = fakeDb(machine({ stage: 'done' }, { host: 'https://m1.example.com' }))
  await assert.rejects(startHttps(f.db, f.row(), 'm1.example.com'), /不用重来/)
})

test('heartbeat probes are capped so two in a row stay under the manager\'s 15s heartbeat timeout', async () => {
  const f = fakeDb(machine({}))
  const timeouts: number[] = []
  const realTimeout = AbortSignal.timeout
  AbortSignal.timeout = (ms: number) => {
    timeouts.push(ms)
    return realTimeout.call(AbortSignal, ms)
  }
  try {
    stubFetch({ '/ingress-check': 200, '/health': 200 })
    await advanceHttps(f.db, f.row(), ready)
  } finally {
    AbortSignal.timeout = realTimeout
  }
  assert.equal(timeouts.length, 2)
  assert.ok(timeouts.reduce((a, b) => a + b, 0) < 15_000, `probes total ${timeouts.join('+')}ms`)
})
