import { readFileSync, writeFileSync, copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { root, validateProfile, validateVersion } from './distribution.mjs'

export const sha256 = data => createHash('sha256').update(data).digest('hex')
export function verifyUpdater(data, signature, publicKey) {
  // Same Ed25519 + Blake2b-512 protocol as tauri-plugin-updater / minisign-verify.
  const keyLines = Buffer.from(publicKey, 'base64').toString('utf8').trim().split(/\r?\n/)
  const key = Buffer.from(keyLines[1] || '', 'base64')
  const lines = Buffer.from(signature.trim(), 'base64').toString('utf8').trim().split(/\r?\n/)
  const sig = Buffer.from(lines[1] || '', 'base64'), global = Buffer.from(lines[3] || '', 'base64')
  if (key.length !== 42 || key.subarray(0, 2).toString() !== 'Ed' || sig.length !== 74 || !['Ed', 'ED'].includes(sig.subarray(0, 2).toString()) || !key.subarray(2, 10).equals(sig.subarray(2, 10)) || !lines[2]?.startsWith('trusted comment: ') || global.length !== 64) throw Error('Invalid updater signature encoding/key')
  const pub = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]), format: 'der', type: 'spki' })
  const message = sig.subarray(0, 2).toString() === 'ED' ? createHash('blake2b512').update(data).digest() : data
  if (!verify(null, message, pub, sig.subarray(10)) || !verify(null, Buffer.concat([sig.subarray(10), Buffer.from(lines[2].slice(17))]), pub, global)) throw Error('Updater signature verification failed')
}
export function collect(p, version, os, arch, out) {
  validateProfile(p); validateVersion(version, p.channel)
  if (!['macos-arm64', 'macos-x64', 'windows-x64'].includes(`${os}-${arch}`)) throw Error('Unsupported target')
  const cfg = JSON.parse(readFileSync(join(root, 'desktop/src-tauri/tauri.conf.json')))
  if (cfg.identifier !== p.identifier || cfg.version !== version || cfg.plugins.updater.endpoints[0] !== p.updateUrl) throw Error('Build profile mismatch')
  const a = arch === 'arm64' ? 'aarch64' : 'x64', b = join(root, 'desktop/src-tauri/target/release/bundle')
  const name = `${p.productName}_${version}_${a}`
  mkdirSync(out, { recursive: true })
  const take = (source, file) => { copyFileSync(source, join(out, file)); return file }
  let installer, updater
  if (os === 'macos') {
    installer = take(join(b, `dmg/${name}.dmg`), `${name}.dmg`)
    updater = take(join(b, `macos/${p.productName}.app.tar.gz`), `${name}.app.tar.gz`)
    take(join(b, `macos/${p.productName}.app.tar.gz.sig`), `${updater}.sig`)
  } else {
    installer = updater = take(join(b, `nsis/${name}-setup.exe`), `${name}-setup.exe`)
    take(join(b, `nsis/${name}-setup.exe.sig`), `${updater}.sig`)
  }
  const signature = readFileSync(join(out, `${updater}.sig`), 'utf8').trim()
  verifyUpdater(readFileSync(join(out, updater)), signature, cfg.plugins.updater.pubkey)
  const bot = JSON.parse(readFileSync(join(root, 'bot/package.json')))
  const botData = readFileSync(join(root, 'desktop/src-tauri/runtime/bot.tgz'))
  const botVersion = `${bot.version}+${sha256(botData).slice(0, 16)}-${os === 'macos' ? 'darwin' : 'windows'}-${arch}`
  const runtime = `local-bot-${botVersion}.tgz`
  writeFileSync(join(out, runtime), botData)
  const files = [...new Set([installer, updater, `${updater}.sig`, runtime])].map(file => {
    const data = readFileSync(join(out, file))
    return { file, size: data.length, sha256: sha256(data) }
  })
  const inventory = { schema: 1, profile: p, version, sourceSha: process.env.GITHUB_SHA, target: os === 'macos' ? `darwin-${a === 'x64' ? 'x86_64' : 'aarch64'}` : 'windows-x86_64', installer, updater, signature, runtime, botVersion, minDesktopVersion: bot.minDesktopVersion, files }
  if (!/^[a-f0-9]{40}$/.test(inventory.sourceSha || '')) throw Error('Missing source commit')
  writeFileSync(join(out, `distribution-${os}-${arch}.json`), JSON.stringify(inventory, null, 2) + '\n')
}
export function assemble(input, p, publicKey, expectedSha) {
  validateProfile(p)
  const inventories = readdirSync(input).filter(f => /^distribution-(macos-(arm64|x64)|windows-x64)\.json$/.test(f)).map(f => JSON.parse(readFileSync(join(input, f))))
  if (inventories.length !== 3) throw Error('All three desktop targets are required')
  const targets = new Set(), files = new Map(), platforms = {}, downloads = []
  const version = validateVersion(inventories[0].version, p.channel)
  for (const i of inventories) {
    if (i.schema !== 1 || JSON.stringify(i.profile) !== JSON.stringify(p) || i.version !== version || i.sourceSha !== expectedSha || !/^[a-f0-9]{40}$/.test(expectedSha) || !['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64'].includes(i.target) || targets.has(i.target)) throw Error('Mixed distribution/source/target artifacts')
    targets.add(i.target)
    for (const f of i.files) {
      if (!/^[A-Za-z0-9_+.-]+$/.test(f.file) || files.has(f.file)) throw Error('Unsafe or duplicate artifact')
      const path = join(input, f.file), data = readFileSync(path)
      if (!statSync(path).isFile() || data.length !== f.size || sha256(data) !== f.sha256) throw Error(`Artifact checksum mismatch: ${f.file}`)
      files.set(f.file, f)
    }
    for (const name of [i.installer, i.updater, `${i.updater}.sig`, i.runtime]) if (!files.has(name)) throw Error('Incomplete artifacts')
    if (readFileSync(join(input, `${i.updater}.sig`), 'utf8').trim() !== i.signature) throw Error('Signature inventory mismatch')
    verifyUpdater(readFileSync(join(input, i.updater)), i.signature, publicKey)
    const url = file => `${p.downloadBase}/releases/${version}/${file}`
    platforms[i.target] = { signature: i.signature, url: url(i.updater) }
    downloads.push({ target: i.target, url: url(i.installer), ...files.get(i.installer) })
  }
  return { latest: { version, notes: `${p.productName} ${version}`, pub_date: new Date().toISOString(), platforms }, downloads: { version, channel: p.channel, sourceSha: expectedSha, downloads }, inventories, files: [...files.values()] }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const profiles = JSON.parse(process.env.DESKTOP_DISTRIBUTION_CONFIG)
  collect(profiles[process.env.DISTRIBUTION_CHANNEL], process.env.DISTRIBUTION_VERSION, process.env.TARGET_OS, process.env.TARGET_ARCH, resolve('out'))
}
