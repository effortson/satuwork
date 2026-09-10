/**
 * Gateway 的函数形态（gateway/src/serverless.ts）：没有监听、没有定时器、没有迁移，密钥来自
 * 环境变量。Vercel 上就是这个形态（docs/adr-gateway-vercel-neon.md §5）。
 *
 * 钉三件事：迁移 CLI 单独能跑；函数形态起来能答请求、JWKS 的 kid 就是环境变量里那把钥匙；
 * /cron/tick 认 CRON_SECRET。esbuild 打出来的那个包（api/gateway.mjs）也起一遍——线上跑的是它，
 * 不是 tsx 转的源码。
 */
import { generateKeyPairSync, randomBytes, createHash } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { freePorts } from './ports.mjs'

export async function runServerless({ root, gwRoot, test, req, start, waitHttp, assert, log }) {
  log('\n# serverless')
  const schema = schemaOf('e2e_serverless')
  const HOME = tmpOf('satuwork-e2e-serverless')
  rmSync(HOME, { recursive: true, force: true })
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const kid = createHash('sha256').update(pair.publicKey).digest('hex').slice(0, 16)
  const env = {
    GATEWAY_DATABASE_URL: PG_URL,
    GATEWAY_PG_SCHEMA: schema,
    GATEWAY_ACCESS_HOST: 'satuwork.com',
    SATUWORK_GATEWAY_HOME: HOME,
    // PEM 按环境变量里常见的样子给：换行压成字面 \n。
    GATEWAY_JWT_PRIVATE_KEY: pair.privateKey.replace(/\n/g, '\\n'),
    GATEWAY_JWT_PUBLIC_KEY: pair.publicKey.replace(/\n/g, '\\n'),
    GATEWAY_CHANNEL_KEY: randomBytes(32).toString('base64'),
    CRON_SECRET: 'cron-e2e-secret',
    GATEWAY_TRUST_FORWARDED: '1',
    GATEWAY_PG_POOL_MAX: '2',
  }

  await test('迁移 CLI 单独跑得完：从空 schema 建到最新', async () => {
    // 先清掉上一轮的 schema（迁移 CLI 自己不清库——它是给生产 build 用的）。
    const { createRequire } = await import('node:module')
    const pg = createRequire(new URL('../gateway/package.json', import.meta.url))('pg')
    const c = new pg.Client({ connectionString: PG_URL })
    await c.connect()
    await c.query(`drop schema if exists "${schema}" cascade`)
    await c.query(`create schema "${schema}"`)
    await c.end()
    const r = spawnSync(process.execPath, ['--import', 'tsx', join(gwRoot, 'scripts/migrate.ts')], { cwd: gwRoot, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120000 })
    assert(r.status === 0, `迁移 CLI 退出码 ${r.status}：${r.stderr}`)
    assert(/已应用 \d+ 条迁移/.test(r.stdout), `迁移 CLI 没报应用了什么：${r.stdout}`)
    const again = spawnSync(process.execPath, ['--import', 'tsx', join(gwRoot, 'scripts/migrate.ts')], { cwd: gwRoot, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120000 })
    assert(again.status === 0 && again.stdout.includes('已是最新'), `第二次该说已是最新：${again.stdout} ${again.stderr}`)
  })

  const [PORT_SRC, PORT_BUNDLE] = await freePorts(2)
  const probe = async (base, label) => {
    const health = await req(base, 'GET', '/health')
    assert(health.status === 200 && health.json.ok === true, `${label} /health ${health.status}`)
    const jwks = await req(base, 'GET', '/.well-known/jwks.json')
    assert(jwks.status === 200 && jwks.json.keys?.[0]?.kid === kid, `${label} JWKS 的 kid 不是环境变量那把：${jwks.text}`)
    const state = await req(base, 'GET', '/auth/state')
    assert(state.status === 200, `${label} /auth/state ${state.status}`)
    const page = await fetch(`${base}/`, { headers: { accept: 'text/html' } })
    assert(page.status === 200 && (await page.text()).includes('<html'), `${label} 首页没发出来`)
    const noCron = await req(base, 'GET', '/cron/tick')
    assert(noCron.status === 401, `${label} 无凭证的 cron 该 401：${noCron.status}`)
    const cron = await req(base, 'GET', '/cron/tick', { token: 'cron-e2e-secret' })
    assert(cron.status === 200 && cron.json.ok === true, `${label} cron ${cron.status} ${cron.text}`)
  }

  const src = start('serverless-src', ['--import', 'tsx', join(gwRoot, 'scripts/serve-serverless.mjs')], {
    cwd: gwRoot,
    env: { ...env, GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: String(PORT_SRC) },
  })
  try {
    await test('函数形态（源码）：答请求、JWKS 用环境变量的钥匙、cron 认 CRON_SECRET', async () => {
      await waitHttp(`http://127.0.0.1:${PORT_SRC}/health`, { child: src, what: 'serverless gateway (src)' })
      await probe(`http://127.0.0.1:${PORT_SRC}`, 'src')
      assert(!existsSync(join(HOME, 'keys')), '函数形态不该往磁盘写密钥')
    })
  } finally {
    src.kill('SIGTERM')
  }

  let bundle = null
  try {
    await test('esbuild 打出来的那个包也起得来，行为一样', async () => {
      const b = spawnSync(process.execPath, [join(gwRoot, 'scripts/build-vercel.mjs')], { cwd: gwRoot, encoding: 'utf8', timeout: 180000 })
      assert(b.status === 0, `打包失败：${b.stderr.slice(-800)}`)
      const out = join(root, 'api/gateway.mjs')
      assert(existsSync(out), '没有 api/gateway.mjs')
      bundle = start('serverless-bundle', [join(gwRoot, 'scripts/serve-serverless.mjs')], {
        cwd: root,
        env: { ...env, SATUWORK_SERVERLESS_ENTRY: out, GATEWAY_UI_DIR: join(gwRoot, 'ui'), GATEWAY_HOST: '127.0.0.1', GATEWAY_PORT: String(PORT_BUNDLE) },
      })
      await waitHttp(`http://127.0.0.1:${PORT_BUNDLE}/health`, { child: bundle, what: 'serverless gateway (bundle)' })
      await probe(`http://127.0.0.1:${PORT_BUNDLE}`, 'bundle')
    })
  } finally {
    bundle?.kill('SIGTERM')
  }
}
