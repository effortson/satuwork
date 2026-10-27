import assert from 'node:assert/strict'
import { test } from 'node:test'

// dryRun：不碰 apt、systemd、/etc，只走状态。要在 import 之前设好——bootConfig 每次现读环境变量。
process.env.SATUWORK_MANAGER_DRYRUN = '1'
const { caddyfileFor, caddyfileIsOurs, domainOf, httpsReport, httpsWantOf, ingressCheck, maybeHttps } = await import('../src/https.ts')

test('domain shape: only plain hostnames reach the Caddyfile', () => {
  assert.equal(domainOf(' M1.Example.COM '), 'm1.example.com')
  for (const bad of ['1.2.3.4', 'localhost', 'a.com {\nimport x\n}', 'a.com:443', '-a.com', 'a..com', 123]) {
    assert.equal(domainOf(bad), null, String(bad))
  }
})

test('reply parsing: a malformed domain means "not said", never "tear down"', () => {
  assert.equal(httpsWantOf(null), null)
  assert.equal(httpsWantOf({ domain: 'bad domain', loopbackOnly: true }), null)
  assert.deepEqual(httpsWantOf({ domain: null, loopbackOnly: false, nonce: null }), { domain: null, loopbackOnly: false, nonce: null })
  assert.equal(httpsWantOf({ domain: 'a.example.com', nonce: 'short' })?.nonce, null)
})

test('Caddyfile ownership: ours, empty, or the Debian stock file; anything hand-written is left alone', () => {
  const stock = `# The Caddyfile is an easy way to configure your Caddy web server.
:80 {
	# Set this path to your site's directory.
	root * /usr/share/caddy

	# Enable the static file server.
	file_server

	# Another common task is to set up a reverse proxy:
	# reverse_proxy localhost:8080
}
`
  assert.equal(caddyfileIsOurs(stock), true)
  assert.equal(caddyfileIsOurs(''), true)
  assert.equal(caddyfileIsOurs(caddyfileFor('a.example.com', 8443)), true)
  assert.equal(caddyfileIsOurs('mgr.example.com {\n\treverse_proxy 127.0.0.1:8443\n}\n'), false)
  const ours = caddyfileFor('a.example.com', 9000)
  assert.match(ours, /^a\.example\.com \{$/m)
  assert.match(ours, /reverse_proxy 127\.0\.0\.1:9000/)
  assert.match(ours, /@local_only path \/llm\/\* \/w-local\/\*/)
})

test('dryRun walk-through: configure → nonce check → loopback only → reopen', async () => {
  const nonce = 'x'.repeat(32)
  assert.equal(ingressCheck(nonce), false, 'no nonce before Gateway sends one')
  await maybeHttps({ domain: 'a.example.com', loopbackOnly: false, nonce })
  // configure 在后台跑；dryRun 下是同步落到 ready 的，让出一拍就够。
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(httpsReport(), { domain: 'a.example.com', phase: 'ready', error: null, loopbackOnly: false, nonce })
  assert.equal(ingressCheck(nonce), true)
  assert.equal(ingressCheck('y'.repeat(32)), false)

  // 期望换了域名：这一轮只重新配，不许拿上一个域名的 ready 去锁回环。
  await maybeHttps({ domain: 'b.example.com', loopbackOnly: true, nonce })
  await new Promise((r) => setImmediate(r))
  assert.equal(httpsReport().domain, 'b.example.com')
  await maybeHttps({ domain: 'b.example.com', loopbackOnly: true, nonce })
  assert.equal(httpsReport().loopbackOnly, true)

  await maybeHttps({ domain: null, loopbackOnly: false, nonce: null })
  assert.equal(httpsReport().loopbackOnly, false)
})

test('the report names the nonce its phase belongs to; a new nonce for an already-ready domain is adopted without redoing the work', async () => {
  const a = 'a'.repeat(32)
  const b = 'b'.repeat(32)
  await maybeHttps({ domain: 'c.example.com', loopbackOnly: false, nonce: a })
  await new Promise((r) => setImmediate(r))
  assert.equal(httpsReport().phase, 'ready')
  assert.equal(httpsReport().nonce, a)

  const logs: string[] = []
  const realLog = console.log
  console.log = (s: string) => logs.push(s)
  try {
    await maybeHttps({ domain: 'c.example.com', loopbackOnly: false, nonce: b })
    await new Promise((r) => setImmediate(r))
  } finally {
    console.log = realLog
  }
  assert.equal(httpsReport().nonce, b, 'Gateway now accepts this ready for its new attempt')
  assert.equal(httpsReport().phase, 'ready')
  assert.ok(!logs.some((l) => l.includes('当作已配好')), 'no reconfigure for the same domain')
})
