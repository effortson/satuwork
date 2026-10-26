import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, createHash, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { validateProfile, validateVersion, configure } from './distribution.mjs'
import { verifyUpdater, assemble, sha256 } from './distribution-artifacts.mjs'
import { desktopDownloadMeta } from '../../gateway/src/desktop-distribution.ts'
import { publishDistribution } from './publish-distribution.mjs'

const p = { region: 'cn', channel: 'stable', productName: 'Satuwork-CN', identifier: 'sg.dami.satuwork.cn', gatewayUrl: 'https://gateway.example.cn', updateUrl: 'https://download.example.cn/desktop/latest.json', downloadBase: 'https://download.example.cn/desktop', updaterPublicKey: Buffer.from('test public key '.repeat(8)).toString('base64') }
test('download mirror metadata rejects credentials and insecure or executable URLs', () => {
  assert.match(desktopDownloadMeta(p.downloadBase), /name="satu-desktop-download"/)
  for (const bad of ['javascript:alert(1)', 'http://example.cn', 'https://user:secret@example.cn', 'https://example.cn/?token=secret', 'broken']) assert.equal(desktopDownloadMeta(bad), '')
  assert.doesNotMatch(desktopDownloadMeta('https://example.cn/"/><script>'), /<script>/)
})
test('regional profiles isolate identity, HTTPS addresses and release channel', () => {
  assert.equal(validateProfile(p), p)
  for (const change of [{ apiKey: 'secret' }, { identifier: 'sg.dami.satuwork' }, { gatewayUrl: 'http://host' }, { gatewayUrl: 'https://user:password@host' }, { updateUrl: 'https://github.com/latest.json' }]) assert.throws(() => validateProfile({ ...p, ...change }))
  assert.equal(validateVersion('0.1.16', 'stable'), '0.1.16')
  assert.equal(validateVersion('0.1.16-beta.1', 'beta'), '0.1.16-beta.1')
  for (const v of ['01.1.1', '0.1.16-beta.1', '0.1.16\nKEY=value']) assert.throws(() => validateVersion(v, 'stable'))
})
test('configuration retains the signing public key and configures unique application data', () => {
  const temp = mkdtempSync(join(tmpdir(), 'distribution-test-'))
  try {
    const file = join(temp, 'tauri.json'), env = join(temp, 'env')
    writeFileSync(file, JSON.stringify({ plugins: { updater: { pubkey: 'unchanged' } }, bundle: {} }))
    configure(p, '0.1.16', file, env)
    const config = JSON.parse(readFileSync(file))
    assert.equal(config.identifier, p.identifier)
    assert.equal(config.plugins.updater.pubkey, p.updaterPublicKey)
    assert.deepEqual(config.plugins.updater.endpoints, [p.updateUrl])
    assert.match(readFileSync(env, 'utf8'), /SATUWORK_BUNDLE_UI_LIBS=1/)
  } finally { rmSync(temp, { recursive: true, force: true }) }
})
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const keyId = Buffer.from('0102030405060708', 'hex')
const pubkey = Buffer.from(`untrusted comment: test\n${Buffer.concat([Buffer.from('Ed'), keyId, publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)]).toString('base64')}\n`).toString('base64')
function signature(data) {
  const sig = sign(null, createHash('blake2b512').update(data).digest(), privateKey), comment = 'timestamp:123456'
  return Buffer.from(`untrusted comment: test\n${Buffer.concat([Buffer.from('ED'), keyId, sig]).toString('base64')}\ntrusted comment: ${comment}\n${sign(null, Buffer.concat([sig, Buffer.from(comment)]), privateKey).toString('base64')}\n`).toString('base64')
}
test('updater verification rejects modified payloads and trusted comments', () => {
  const data = Buffer.from('signed package'), sig = signature(data)
  verifyUpdater(data, sig, pubkey)
  assert.throws(() => verifyUpdater(Buffer.from('changed'), sig, pubkey))
  const changed = Buffer.from(Buffer.from(sig, 'base64').toString().replace('123456', '987654')).toString('base64')
  assert.throws(() => verifyUpdater(data, changed, pubkey))
})
test('publication requires a complete set from one source, promotes complete files, and rejects mutations', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'distribution-test-')), sha = 'a'.repeat(40)
  try {
    for (const [target, name] of [['darwin-aarch64', 'macos-arm64'], ['darwin-x86_64', 'macos-x64'], ['windows-x86_64', 'windows-x64']]) {
      const botVersion = `0.1.14+${'a'.repeat(16)}-${target.replace('aarch64', 'arm64').replace('x86_64', 'x64')}`
      const updater = `${name}.tgz`, runtime = `local-bot-${botVersion}.tgz`, data = Buffer.from(name), sig = signature(data)
      writeFileSync(join(temp, updater), data); writeFileSync(join(temp, runtime), data); writeFileSync(join(temp, updater + '.sig'), sig)
      const files = [updater, runtime, updater + '.sig'].map(file => { const bytes = readFileSync(join(temp, file)); return { file, size: bytes.length, sha256: sha256(bytes) } })
      writeFileSync(join(temp, `distribution-${name}.json`), JSON.stringify({ schema: 1, profile: p, version: '0.1.16', sourceSha: sha, target, updater, installer: updater, runtime, botVersion, minDesktopVersion: '0.1.0', signature: sig, files }))
    }
    const release = assemble(temp, p, pubkey, sha)
    assert.equal(Object.keys(release.latest.platforms).length, 3)
    assert.ok(Object.values(release.latest.platforms).every(p => p.url.startsWith('https://download.example.cn/desktop/releases/0.1.16/')))
    assert.throws(() => assemble(temp, p, pubkey, 'b'.repeat(40)))
    const profilePath = join(temp, 'profiles.json'), keyPath = join(temp, 'keys.json'), output = join(temp, 'public')
    writeFileSync(profilePath, JSON.stringify({ stable: p }))
    writeFileSync(keyPath, JSON.stringify({ stable: pubkey }))
    const requests = []
    const fetcher = async (url, options) => {
      requests.push([url, options])
      return new Response(JSON.stringify({ releases: [] }), { status: 200 })
    }
    const args = [temp, profilePath, keyPath, output, 'stable', sha]
    await publishDistribution(args, { GATEWAY_PLATFORM_TOKEN: 'test-only', DISTRIBUTION_LOCAL_GATEWAY: 'http://127.0.0.1:3080' }, fetcher)
    assert.equal(requests.length, 4)
    const latestPath = join(output, 'stable/desktop/latest.json'), latest = readFileSync(latestPath, 'utf8')
    assert.equal(JSON.parse(latest).version, '0.1.16')
    assert.equal(readFileSync(join(output, 'stable/desktop/Satuwork_x64.dmg'), 'utf8'), 'macos-x64')
    writeFileSync(join(temp, 'macos-x64.tgz'), 'tampered')
    assert.throws(() => assemble(temp, p, pubkey, sha))
    await assert.rejects(() => publishDistribution(args, { GATEWAY_PLATFORM_TOKEN: 'test-only', DISTRIBUTION_LOCAL_GATEWAY: 'http://127.0.0.1:3080' }, fetcher))
    assert.equal(readFileSync(latestPath, 'utf8'), latest)
    assert.equal(requests.length, 4, 'Rejected files must not change runtime records')
  } finally { rmSync(temp, { recursive: true, force: true }) }
})
