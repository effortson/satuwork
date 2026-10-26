import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign, createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { matrix, selectedKinds, runtimeVersion, verifySet, sha256, validateSelection } from './runtime-release.mjs'
const { publicKey, privateKey } = generateKeyPairSync('ed25519'), id = Buffer.from('0102030405060708', 'hex')
const key = Buffer.from(`untrusted comment: test\n${Buffer.concat([Buffer.from('Ed'), id, publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)]).toString('base64')}\n`).toString('base64')
function signed(data) {
  const sig = sign(null, createHash('blake2b512').update(data).digest(), privateKey), comment = 'timestamp:123456'
  return Buffer.from(`untrusted comment: test\n${Buffer.concat([Buffer.from('ED'), id, sig]).toString('base64')}\ntrusted comment: ${comment}\n${sign(null, Buffer.concat([sig, Buffer.from(comment)]), privateKey).toString('base64')}\n`).toString('base64')
}
test('component selection covers both server architectures and all six local Bot targets', () => {
  assert.equal(matrix('all').include.length, 6)
  for (const kind of ['manager', 'bot']) assert.deepEqual(matrix(kind).include.map(t => t.target), ['linux-x64', 'linux-arm64'])
  assert.equal(matrix('all').include.reduce((n,t) => n + selectedKinds('all', t.target).length, 0), 10)
  assert.throws(() => validateSelection('international', 'all'))
  assert.throws(() => validateSelection('main', 'all', '1.2.3;echo bad'))
  assert.throws(() => runtimeVersion('1.2.3', 'a'.repeat(40), 12, 'manager', 'darwin-arm64'))
})
test('signed inventories reject mixed branches, incomplete sets, altered package bytes and undeclared files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-test-')), sourceSha = 'a'.repeat(40), runId = '12345'
  const expected = { branch: 'develop', component: 'all', sourceSha, runId, publicKey: key }
  try {
    for (const {target} of matrix('all').include) {
      const packages = selectedKinds('all', target).map(kind => {
        const version = runtimeVersion('0.1.14', sourceSha, runId, kind, target), file = `${kind}-${version}.tgz`, bytes = Buffer.from(file)
        writeFileSync(join(dir, file), bytes)
        return { kind, target, version, file, size: bytes.length, sha256: sha256(bytes), minDesktopVersion: kind === 'local-bot' ? '0.1.0' : null }
      })
      const bytes = Buffer.from(JSON.stringify({ schema: 1, region: 'cn', branch: 'develop', component: 'all', sourceSha, runId, target, packages }))
      writeFileSync(join(dir, `runtime-${target}.json`), bytes)
      writeFileSync(join(dir, `runtime-${target}.json.sig`), signed(bytes))
    }
    const packages = verifySet(dir, expected);assert.equal(packages.length, 10)
    assert.throws(() => verifySet(dir, { ...expected, branch: 'main' }), /Mixed/)
    assert.throws(() => verifySet(dir, { ...expected, sourceSha: 'b'.repeat(40) }), /Mixed/)
    const file = join(dir, packages[0].file), original = readFileSync(file)
    writeFileSync(file, 'altered');assert.throws(() => verifySet(dir, expected), /checksum/);writeFileSync(file, original)
    writeFileSync(join(dir, 'extra'), 'unexpected');assert.throws(() => verifySet(dir, expected), /Unexpected/);rmSync(join(dir, 'extra'))
    const manifest = join(dir, 'runtime-linux-x64.json'), saved = readFileSync(manifest)
    writeFileSync(manifest, '{}');assert.throws(() => verifySet(dir, expected), /signature/);writeFileSync(manifest, saved)
    rmSync(join(dir, 'runtime-windows-arm64.json.sig'));assert.throws(() => verifySet(dir, expected), /ENOENT/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
