// Regional host only. Trusted keys and platform credentials never come from artifacts.
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { verifySet } from './runtime-release.mjs'

export async function publishRuntimes([input, keyPath, profilePath, branch, component, sourceSha, runId, receipt], env = process.env, fetcher = fetch) {
  const channel = branch === 'main' ? 'stable' : 'beta'
  const publicKey = JSON.parse(readFileSync(keyPath))[channel]
  const profile = JSON.parse(readFileSync(profilePath))[channel]
  if (profile.region !== 'cn' || profile.channel !== channel || new URL(profile.gatewayUrl).protocol !== 'https:') throw Error('Invalid trusted regional profile')
  const packages = verifySet(resolve(input), { branch, component, sourceSha, runId, publicKey })
  const checked = spawnSync('python3', [join(dirname(fileURLToPath(import.meta.url)), 'check-runtime-archives.py'), input, JSON.stringify(packages)], { encoding: 'utf8', timeout: 120000 })
  if (checked.error || checked.status !== 0) throw Error('Unsafe runtime archive: ' + checked.stderr?.slice(-800))
  const gateway = env.RUNTIME_LOCAL_GATEWAY, token = env.GATEWAY_PLATFORM_TOKEN
  const expected = 'http://127.0.0.1:' + (branch === 'main' ? '3080' : '3081')
  if (gateway !== expected || !token) throw Error('Gateway/branch private configuration mismatch')
  const headers = { Authorization: `Bearer ${token}` }, catalogs = new Map()
  const list = async kind => {
    const response = await fetcher(`${gateway}/platform/${kind}-releases`, { headers, redirect: 'error' })
    if (!response.ok) throw Error(`Cannot read ${kind}: HTTP ${response.status}`)
    const data = await response.json()
    if (!Array.isArray(data.releases)) throw Error('Invalid release catalog')
    return data.releases
  }
  const assertSame = (old, p) => {
    if (old.sha256 !== p.sha256 || old.size !== p.size || old.minDesktopVersion !== p.minDesktopVersion || old.storage !== 'local' || old.url || old.directUrl) throw Error('Immutable runtime differs or is not stored locally')
  }
  // Complete signature, archive and existing-release checks precede the first mutation.
  for (const kind of new Set(packages.map(p => p.kind))) catalogs.set(kind, await list(kind))
  for (const p of packages) {
    const old = catalogs.get(p.kind).find(r => r.version === p.version)
    if (old) assertSame(old, p)
  }
  // Keep the x64 server package last for the legacy architecture-free bootstrap endpoint.
  const order = p => `${p.kind}-${p.target.endsWith('arm64') ? '0' : '1'}-${p.target}`
  packages.sort((a, b) => order(a).localeCompare(order(b)))
  for (const p of packages) {
    if (catalogs.get(p.kind).some(r => r.version === p.version)) continue
    const query = new URLSearchParams({ note: `China ${branch} ${p.target}; source ${sourceSha}; run ${runId}` })
    if (p.minDesktopVersion) query.set('minDesktopVersion', p.minDesktopVersion)
    const response = await fetcher(`${gateway}/platform/${p.kind}-releases/${encodeURIComponent(p.version)}?${query}`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/gzip', 'x-bot-sha256': p.sha256 }, body: readFileSync(join(input, p.file)), redirect: 'error' })
    if (!response.ok) throw Error(`Upload ${p.kind}/${p.target} failed: HTTP ${response.status}`)
    console.log(`Registered China ${branch} ${p.kind} ${p.target} ${p.version}`)
  }
  const verified = []
  for (const kind of catalogs.keys()) {
    const rows = await list(kind)
    for (const p of packages.filter(p => p.kind === kind)) {
      const row = rows.find(r => r.version === p.version)
      if (!row) throw Error('Published release missing')
      assertSame(row, p)
      if (new URL(row.downloadUrl).origin !== new URL(profile.gatewayUrl).origin) throw Error('Published download points to another region/environment')
      verified.push({ ...p, downloadUrl: row.downloadUrl, storage: row.storage })
    }
  }
  const result = { schema: 1, region: 'cn', branch, component, sourceSha, runId, publishedAt: new Date().toISOString(), packages: verified }
  writeFileSync(receipt, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  console.log(`Verified ${verified.length} China ${branch} runtime releases`)
  return result
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await publishRuntimes(process.argv.slice(2))
