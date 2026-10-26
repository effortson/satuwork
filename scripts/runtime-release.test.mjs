import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign, createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { matrix, selectedKinds, runtimeVersion, verifySet, sha256, validateSelection } from './runtime-release.mjs'
import { publishRuntimes } from './publish-runtimes.mjs'
import { tarGz } from '../e2e/release.mjs'
import { removeWorkspaceSelfLink } from './pack-lib.mjs'
const { publicKey, privateKey } = generateKeyPairSync('ed25519'), id = Buffer.from('0102030405060708', 'hex')
const key = Buffer.from(`untrusted comment: test\n${Buffer.concat([Buffer.from('Ed'), id, publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)]).toString('base64')}\n`).toString('base64')
function signed(data) {
  const sig = sign(null, createHash('blake2b512').update(data).digest(), privateKey), comment = 'timestamp:123456'
  return Buffer.from(`untrusted comment: test\n${Buffer.concat([Buffer.from('ED'), id, sig]).toString('base64')}\ntrusted comment: ${comment}\n${sign(null, Buffer.concat([sig, Buffer.from(comment)]), privateKey).toString('base64')}\n`).toString('base64')
}
test('packaging removes pnpm checkout self-links without touching their target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-link-'))
  try {
    const stage = join(dir, 'stage'), external = join(dir, 'checkout')
    mkdirSync(join(stage, 'node_modules/.pnpm/node_modules'), { recursive: true });mkdirSync(external)
    writeFileSync(join(external, 'keep'), 'checkout')
    const link = join(stage, 'node_modules/.pnpm/node_modules/satuwork')
    symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir')
    removeWorkspaceSelfLink(stage, 'satuwork')
    assert.throws(() => lstatSync(link), /ENOENT/)
    assert.equal(readFileSync(join(external, 'keep'), 'utf8'), 'checkout')
    removeWorkspaceSelfLink(stage, 'satuwork')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('component selection covers both server architectures and all six local Bot targets', () => {
  assert.equal(matrix('all').include.length, 6)
  for (const kind of ['manager', 'bot']) assert.deepEqual(matrix(kind).include.map(t => t.target), ['linux-x64', 'linux-arm64'])
  assert.equal(matrix('all').include.reduce((n,t) => n + selectedKinds('all', t.target).length, 0), 10)
  assert.equal(matrix('bots').include.length, 6)
  assert.deepEqual(selectedKinds('bots', 'linux-x64'), ['bot', 'local-bot'])
  assert.deepEqual(selectedKinds('bots', 'darwin-arm64'), ['local-bot'])
  assert.equal(matrix('bots').include.reduce((n,t) => n + selectedKinds('bots', t.target).length, 0), 8)
  assert.throws(() => validateSelection('international', 'all'))
  assert.throws(() => validateSelection('main', 'all', '1.2.3;echo bad'))
  assert.throws(() => runtimeVersion('1.2.3', 'a'.repeat(40), 12, 'manager', 'darwin-arm64'))
})
for (const component of ['all', 'bots']) test(`signed ${component} inventories reject mixed branches, components, incomplete sets and altered bytes`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-test-')), sourceSha = 'a'.repeat(40), runId = '12345'
  const expected = { branch: 'develop', component, sourceSha, runId, publicKey: key }
  try {
    for (const {target} of matrix(component).include) {
      const packages = selectedKinds(component, target).map(kind => {
        const version = runtimeVersion('0.1.14', sourceSha, runId, kind, target), file = `${kind}-${version}.tgz`, bytes = Buffer.from(file)
        writeFileSync(join(dir, file), bytes)
        return { kind, target, version, file, size: bytes.length, sha256: sha256(bytes), minDesktopVersion: kind === 'local-bot' ? '0.1.0' : null }
      })
      const bytes = Buffer.from(JSON.stringify({ schema: 1, region: 'cn', branch: 'develop', component, sourceSha, runId, target, packages }))
      writeFileSync(join(dir, `runtime-${target}.json`), bytes)
      writeFileSync(join(dir, `runtime-${target}.json.sig`), signed(bytes))
    }
    const packages = verifySet(dir, expected);assert.equal(packages.length, component === 'all' ? 10 : 8)
    assert.throws(() => verifySet(dir, { ...expected, branch: 'main' }), /Mixed/)
    assert.throws(() => verifySet(dir, { ...expected, component: component === 'all' ? 'bots' : 'all' }), /Mixed/)
    assert.throws(() => verifySet(dir, { ...expected, sourceSha: 'b'.repeat(40) }), /Mixed/)
    const file = join(dir, packages[0].file), original = readFileSync(file)
    writeFileSync(file, 'altered');assert.throws(() => verifySet(dir, expected), /checksum/);writeFileSync(file, original)
    writeFileSync(join(dir, 'extra'), 'unexpected');assert.throws(() => verifySet(dir, expected), /Unexpected/);rmSync(join(dir, 'extra'))
    const manifest = join(dir, 'runtime-linux-x64.json'), saved = readFileSync(manifest)
    writeFileSync(manifest, '{}');assert.throws(() => verifySet(dir, expected), /signature/);writeFileSync(manifest, saved)
    rmSync(join(dir, 'runtime-windows-arm64.json.sig'));assert.throws(() => verifySet(dir, expected), /ENOENT/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
for (const component of ['manager', 'bots']) test(`${component} publisher preflights archives and immutable versions; retries are idempotent`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-publish-')), input = join(dir, 'input')
  const { mkdirSync } = await import('node:fs');mkdirSync(input)
  const sourceSha = 'a'.repeat(40), runId = '12345', rows = [], requests = []
  const keys = join(dir, 'keys.json'), profiles = join(dir, 'profiles.json'), receipt = join(dir, 'receipt.json')
  writeFileSync(keys, JSON.stringify({ beta: key }))
  writeFileSync(profiles, JSON.stringify({ beta: { region: 'cn', channel: 'beta', gatewayUrl: 'https://dev.example.cn' } }))
  function inventory(unsafe = false) {
    for (const {target} of matrix(component).include) {
      const packages = selectedKinds(component, target).map(kind => {
        const version = runtimeVersion('0.1.14', sourceSha, runId, kind, target), file = `${kind}-${version}.tgz`
        const bytes = tarGz([
          { name: kind === 'manager' ? 'bin/satuwork-manager.mjs' : 'bin/satuwork.mjs', data: '// entry' },
          ...(kind === 'manager' ? [{ name: 'bin/satuwork-worker.mjs', data: '// entry' }, { name: 'src/seat/deploy-seat.sh', data: 'true' }, { name: 'src/seat/manager-confirm.sh', data: 'true' }] : []),
          { name: 'VERSION', data: version }, { name: 'package.json', data: '{}' },
          { name: 'node_modules/.pnpm/tsx@1/node_modules/tsx/package.json', data: '{}' },
          ...(unsafe && target === 'linux-x64' ? [{ name: '../escaped', data: 'unsafe' }] : [])
        ])
        writeFileSync(join(input, file), bytes)
        return { kind, target, version, file, size: bytes.length, sha256: sha256(bytes), minDesktopVersion: kind === 'local-bot' ? '0.1.0' : null }
      })
      const manifest = Buffer.from(JSON.stringify({ schema: 1, region: 'cn', branch: 'develop', component, sourceSha, runId, target, packages }))
      writeFileSync(join(input, `runtime-${target}.json`), manifest);writeFileSync(join(input, `runtime-${target}.json.sig`), signed(manifest))
    }
  }
  const fetcher = async (url, options) => {
    requests.push([url, options.method || 'GET'])
    const parsed = new URL(url), kind = parsed.pathname.split('/')[2].replace(/-releases$/, '')
    if (options.method === 'PUT') {
      const version = decodeURIComponent(new URL(url).pathname.split('/').at(-1))
      rows.push({ kind, version, sha256: options.headers['x-bot-sha256'], size: options.body.length, storage: 'local', minDesktopVersion: parsed.searchParams.get('minDesktopVersion'), url: '', directUrl: null, downloadUrl: `https://dev.example.cn/internal/${kind}-releases/`+encodeURIComponent(version) })
    }
    return new Response(JSON.stringify({ releases: rows.filter(r => r.kind === kind) }), { status: 200 })
  }
  const args = [input, keys, profiles, 'develop', component, sourceSha, runId, receipt], env = { RUNTIME_LOCAL_GATEWAY: 'http://127.0.0.1:3081', GATEWAY_PLATFORM_TOKEN: 'test-only' }
  const count = component === 'bots' ? 8 : 2
  try {
    inventory(true)
    await assert.rejects(() => publishRuntimes(args, env, fetcher), /Unsafe runtime archive/)
    assert.equal(requests.length, 0, 'Signed but unsafe archives must not mutate the Gateway')
    inventory()
    const result = await publishRuntimes(args, env, fetcher)
    assert.equal(result.packages.length, count);assert.match(rows[0].version, /-arm64$/);assert.match(rows[1].version, /-x64$/)
    if (component === 'bots') {
      assert.equal(rows.filter(r => r.kind === 'bot').length, 2)
      assert.equal(rows.filter(r => r.kind === 'local-bot').length, 6)
      assert.ok(requests.every(([url]) => !url.includes('/manager-releases')))
    }
    await publishRuntimes(args, env, fetcher)
    assert.equal(requests.filter(r => r[1] === 'PUT').length, count)
    rows[1].sha256 = '0'.repeat(64)
    await assert.rejects(() => publishRuntimes(args, env, fetcher), /Immutable/)
    assert.equal(requests.filter(r => r[1] === 'PUT').length, count)
    await assert.rejects(() => publishRuntimes(args, { ...env, RUNTIME_LOCAL_GATEWAY: 'http://127.0.0.1:3080' }, fetcher), /Gateway\/branch/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
