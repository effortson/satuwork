// Generic regional runtime artifacts. Deployment addresses and credentials stay outside Git.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, lstatSync, openSync, readSync, closeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { verifyUpdater } from '../desktop/scripts/distribution-artifacts.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const TARGETS = [
  { target: 'linux-x64', platform: 'linux', arch: 'x64', runner: 'ubuntu-latest' },
  { target: 'linux-arm64', platform: 'linux', arch: 'arm64', runner: 'ubuntu-24.04-arm' },
  { target: 'darwin-arm64', platform: 'darwin', arch: 'arm64', runner: 'macos-14' },
  { target: 'darwin-x64', platform: 'darwin', arch: 'x64', runner: 'macos-15-intel' },
  { target: 'windows-x64', platform: 'win32', arch: 'x64', runner: 'windows-latest' },
  { target: 'windows-arm64', platform: 'win32', arch: 'arm64', runner: 'windows-11-arm' },
]
export function validateSelection(branch, component, version = '') {
  if (!['main', 'develop'].includes(branch) || !['all', 'manager', 'bot', 'local-bot'].includes(component)) throw Error('Unsupported source branch/component')
  if (version && !/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(version)) throw Error('Version must be X.Y.Z, or empty for package version')
}
export function selectedKinds(component, target) {
  if (!TARGETS.some(t => t.target === target)) throw Error('Unknown native target')
  return ['manager', 'bot', 'local-bot'].filter(k => (component === 'all' || component === k) && (k === 'local-bot' || target.startsWith('linux-')))
}
export function matrix(component) {
  validateSelection('main', component)
  return { include: TARGETS.filter(t => selectedKinds(component, t.target).length) }
}
export function runtimeVersion(base, sha, runId, kind, target) {
  validateSelection('main', kind, base)
  if (!/^[a-f0-9]{40}$/.test(sha) || !/^[1-9]\d{0,14}$/.test(String(runId))) throw Error('Invalid build provenance')
  const suffix = kind === 'local-bot' ? target : target.split('-')[1]
  const value = `${base}+cn.${sha.slice(0, 12)}.${runId}-${suffix}`
  if (value.length > 64 || !selectedKinds(kind, target).length) throw Error('Invalid version/target')
  return value
}
export const sha256 = data => createHash('sha256').update(data).digest('hex')
function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { stdio: 'inherit', ...options })
  if (result.error || result.status !== 0) throw Error(`${executable} failed (${result.status ?? 'spawn'})`)
}
function machOs(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name), st = lstatSync(path)
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) machOs(path, files)
    else if (st.isFile() && st.size >= 8) {
      const data = Buffer.alloc(8), fd = openSync(path, 'r')
      try { readSync(fd, data, 0, 8, 0) } finally { closeSync(fd) }
      const magic = data.readUInt32BE(0)
      if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic) || ([0xcafebabe, 0xbebafeca].includes(magic) && data.readUInt32BE(4) < 20)) files.push(path)
    }
  }
  return files
}
function inspectAndSign(archive, kind, version) {
  const temp = mkdtempSync(join(tmpdir(), 'satu-runtime-check-'))
  try {
    command('tar', ['-xzf', archive, '-C', temp])
    if (readFileSync(join(temp, 'VERSION'), 'utf8').trim() !== version) throw Error('Packed VERSION differs')
    const entry = kind === 'manager' ? 'bin/satuwork-manager.mjs' : 'bin/satuwork.mjs'
    readFileSync(join(temp, entry))
    if (process.platform === 'darwin') {
      const identity = process.env.SATUWORK_CODESIGN_IDENTITY, keychain = process.env.SATUWORK_CODESIGN_KEYCHAIN
      if (!identity || !keychain) throw Error('Missing protected Apple signing identity')
      for (const path of machOs(temp)) {
        command('codesign', ['--force', '--sign', identity, '--keychain', keychain, '--options', 'runtime', '--timestamp', path])
        command('codesign', ['--verify', '--strict', path])
      }
      const repacked = join(temp, '..', `signed-${process.pid}.tgz`)
      try {
        command('tar', ['-czf', repacked, '-C', temp, '.'])
        writeFileSync(archive, readFileSync(repacked))
      } finally { rmSync(repacked, { force: true }) }
    }
    // Exercise the deployed dependency tree, not the workspace's node_modules.
    command(process.execPath, ['--input-type=module', '-e', `import {createRequire} from 'node:module'; const r=createRequire(process.cwd()+'/package.json');const t=createRequire(r.resolve('tsx'));const e=t('esbuild');if(!e.transformSync('const a: number = 1',{loader:'ts'}).code)throw Error('esbuild failed');console.log('Native dependency smoke test passed',process.platform,process.arch)`], { cwd: temp, timeout: 60000 })
    if (kind === 'manager') {
      command(process.execPath, ['--import', 'tsx', entry, '--selftest'], { cwd: temp, timeout: 60000, env: { ...process.env, SATUWORK_MANAGER_HOME: join(temp, '.smoke-state'), SATUWORK_MANAGER_PORT: '0' } })
    }
  } finally { rmSync(temp, { recursive: true, force: true }) }
}
export function build() {
  const branch = process.env.GITHUB_REF_NAME, component = process.env.RUNTIME_COMPONENT, requested = process.env.RUNTIME_VERSION || ''
  validateSelection(branch, component, requested)
  const target = process.env.RUNTIME_TARGET, native = TARGETS.find(t => t.target === target)
  if (!native || native.platform !== process.platform || native.arch !== process.arch) throw Error('Runner architecture/platform mismatch')
  const sha = process.env.GITHUB_SHA, runId = process.env.GITHUB_RUN_ID
  const out = join(root, 'out'); mkdirSync(out, { recursive: true })
  const packages = []
  for (const kind of selectedKinds(component, target)) {
    const pkg = JSON.parse(readFileSync(join(root, kind === 'manager' ? 'manager/package.json' : 'bot/package.json')))
    const version = runtimeVersion(requested || pkg.version, sha, runId, kind, target)
    const file = `${kind}-${version}.tgz`, path = join(out, file)
    command(process.execPath, [join(root, kind === 'manager' ? 'manager/pack.mjs' : 'bot/pack.mjs'), '--version', version, '--out', path, ...(kind === 'local-bot' ? ['--allow-foreign-platform'] : [])], { cwd: root })
    inspectAndSign(path, kind, version)
    const bytes = readFileSync(path)
    const minimum = kind === 'local-bot' ? String(pkg.minDesktopVersion || '0.1.0') : null
    if (minimum !== null && !/^\d+\.\d+\.\d+$/.test(minimum)) throw Error('Invalid minDesktopVersion')
    packages.push({ kind, target, version, file, size: bytes.length, sha256: sha256(bytes), minDesktopVersion: minimum })
  }
  writeFileSync(join(out, `runtime-${target}.json`), JSON.stringify({ schema: 1, region: 'cn', branch, component, sourceSha: sha, runId: String(runId), target, packages }, null, 2) + '\n')
}
export function verifySet(input, { branch, component, sourceSha, runId, publicKey }) {
  validateSelection(branch, component)
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || !/^[1-9]\d{0,14}$/.test(String(runId))) throw Error('Invalid expected provenance')
  const targets = matrix(component).include.map(t => t.target), packages = []
  const allowed = new Set()
  for (const target of targets) {
    const file = `runtime-${target}.json`, sigFile = file + '.sig'
    const bytes = readFileSync(join(input, file))
    verifyUpdater(bytes, readFileSync(join(input, sigFile), 'utf8'), publicKey)
    const m = JSON.parse(bytes)
    if (m.schema !== 1 || m.region !== 'cn' || m.branch !== branch || m.component !== component || m.sourceSha !== sourceSha || m.runId !== String(runId) || m.target !== target) throw Error('Mixed region/source/component build')
    const kinds = selectedKinds(component, target)
    if (!Array.isArray(m.packages) || m.packages.length !== kinds.length) throw Error('Incomplete native packages')
    const seen = new Set()
    for (const p of m.packages) {
      if (!kinds.includes(p.kind) || seen.has(p.kind) || p.target !== target || p.file !== `${p.kind}-${p.version}.tgz` || !/^[A-Za-z0-9_+.-]+$/.test(p.file)) throw Error('Invalid artifact identity')
      const base = p.version.split('+')[0]
      if (p.version !== runtimeVersion(base, sourceSha, runId, p.kind, target)) throw Error('Version does not bind source/run/target')
      if (p.kind === 'local-bot' ? !/^\d+\.\d+\.\d+$/.test(p.minDesktopVersion || '') : p.minDesktopVersion !== null) throw Error('Invalid runtime compatibility metadata')
      const path = join(input, p.file)
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw Error('Artifact must be a regular file')
      const data = readFileSync(path)
      if (data.length !== p.size || !p.size || p.size > 256 * 1024 ** 2 || sha256(data) !== p.sha256) throw Error('Package size/checksum mismatch')
      seen.add(p.kind);allowed.add(p.file);packages.push(p)
    }
    allowed.add(file);allowed.add(sigFile)
  }
  if (readdirSync(input).some(name => !allowed.has(name))) throw Error('Unexpected files in runtime artifact set')
  return packages
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'matrix') {
    validateSelection(process.env.GITHUB_REF_NAME, process.env.RUNTIME_COMPONENT, process.env.RUNTIME_VERSION || '')
    console.log(JSON.stringify(matrix(process.env.RUNTIME_COMPONENT)))
  } else if (process.argv[2] === 'build') build()
  else throw Error('Expected matrix or build')
}
