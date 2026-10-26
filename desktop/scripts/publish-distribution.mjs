// Run on the regional host. The platform token is read from its existing private environment.
import { readFileSync, writeFileSync, copyFileSync, chmodSync, symlinkSync, mkdirSync, renameSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { assemble } from './distribution-artifacts.mjs'
import { validateProfile } from './distribution.mjs'

const [input, profilePath, keyPath, output, channel, sourceSha] = process.argv.slice(2)
const p = validateProfile(JSON.parse(readFileSync(profilePath))[channel])
if (p.channel !== channel) throw Error('Channel mismatch')
const release = assemble(resolve(input), p, JSON.parse(readFileSync(keyPath, 'utf8'))[channel], sourceSha)
process.umask(0o022)
const version = release.latest.version, publicDir = resolve(output, channel, 'desktop')
const latestPath = join(publicDir, 'latest.json')
function versionParts(v) { return v.split(/\.|-beta\./).map(Number) }
if (existsSync(latestPath)) {
  const current = JSON.parse(readFileSync(latestPath))
  const a = versionParts(version), b = versionParts(current.version)
  const diff = a.findIndex((n, i) => n !== b[i])
  if (diff >= 0 && a[diff] < b[diff]) throw Error('Refusing to downgrade this channel')
}
const releaseDir = join(publicDir, 'releases', version)
const publicFiles = [...new Set(release.inventories.flatMap(i => [i.installer, i.updater, `${i.updater}.sig`]))]
if (existsSync(releaseDir)) {
  for (const f of publicFiles) {
    if (!readFileSync(join(releaseDir, f)).equals(readFileSync(join(input, f)))) throw Error('Immutable release already exists with different bytes')
  }
}
const token = process.env.GATEWAY_PLATFORM_TOKEN
const gateway = process.env.DISTRIBUTION_LOCAL_GATEWAY
if (!token || !/^http:\/\/127\.0\.0\.1:(3080|3081)$/.test(gateway || '')) throw Error('Missing private local publishing configuration')
if ((channel === 'stable' && !gateway.endsWith(':3080')) || (channel === 'beta' && !gateway.endsWith(':3081'))) throw Error('Gateway/channel mismatch')
// Verify all desktop signatures and file hashes before updating any runtime records.
const headers = { Authorization: `Bearer ${token}` }
const response = await fetch(`${gateway}/platform/local-bot-releases`, { headers, redirect: 'error' })
if (!response.ok) throw Error(`Cannot read local runtime releases: HTTP ${response.status}`)
const existing = (await response.json()).releases
for (const i of release.inventories) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+\+[a-f0-9]{16}-(darwin|windows)-(arm64|x64)$/.test(i.botVersion) || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(i.minDesktopVersion)) throw Error('Invalid runtime metadata')
  const file = release.files.find(f => f.file === i.runtime)
  const old = existing.find(r => r.version === i.botVersion)
  if (old) {
    if (old.sha256 !== file.sha256 || old.size !== file.size) throw Error('Immutable runtime already differs')
    continue
  }
  const url = `${gateway}/platform/local-bot-releases/${encodeURIComponent(i.botVersion)}?minDesktopVersion=${encodeURIComponent(i.minDesktopVersion)}&note=${encodeURIComponent(`${p.productName} ${version}`)}`
  const uploaded = await fetch(url, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/gzip', 'x-bot-sha256': file.sha256 }, body: readFileSync(join(input, i.runtime)), redirect: 'error' })
  if (!uploaded.ok) throw Error(`Runtime upload failed: HTTP ${uploaded.status}`)
  console.log(`Registered runtime ${i.botVersion}`)
}
mkdirSync(join(publicDir, 'releases'), { recursive: true, mode: 0o755 })
const stage = join(publicDir, 'releases', `.stage-${process.pid}`)
try {
  if (!existsSync(releaseDir)) {
    mkdirSync(stage, { mode: 0o755 })
    for (const f of publicFiles) { copyFileSync(join(input, f), join(stage, f)); chmodSync(join(stage, f), 0o644) }
    writeFileSync(join(stage, 'build.json'), JSON.stringify(release.downloads, null, 2) + '\n', { mode: 0o644 })
    renameSync(stage, releaseDir)
  }
  const atomic = (file, content) => { const temp = join(publicDir, `.${file}.${process.pid}`); writeFileSync(temp, content, { mode: 0o644 }); renameSync(temp, join(publicDir, file)) }
  const labels = { 'darwin-aarch64': 'macOS · Apple 芯片', 'darwin-x86_64': 'macOS · Intel', 'windows-x86_64': 'Windows · 64 位' }
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${p.productName} 下载</title><link rel="stylesheet" href="download.css"><main><h1>${p.productName}</h1><p>中国区${channel === 'beta' ? '测试版' : '正式版'} · ${version}</p><p>连接 ${new URL(p.gatewayUrl).hostname}</p><ul>${release.downloads.downloads.map(d => `<li><a href="${d.url}">${labels[d.target]}</a><small>${(d.size / 1048576).toFixed(1)} MB · SHA256 <code>${d.sha256}</code></small></li>`).join('')}</ul><p>首次使用中国区版本，请手动安装。中国区与国际版、正式版与测试版的数据各自独立。</p><p>macOS 安装包已签名并通过 Apple 公证。Windows 安装包目前没有代码签名，系统可能提示未知发布者；更新包仍会验证 Tauri 签名。</p><p><a href="downloads.json">下载信息与 SHA256</a> · <a href="${p.gatewayUrl}">打开中国区工作台</a></p></main></html>`
  // Fixed installer links for the Gateway landing page; updater URLs remain immutable.
  const aliases = { 'darwin-aarch64': 'Satuwork_aarch64.dmg', 'darwin-x86_64': 'Satuwork_x64.dmg', 'windows-x86_64': 'Satuwork_x64-setup.exe' }
  for (const d of release.downloads.downloads) {
    const temp = join(publicDir, `.installer-${d.target}-${process.pid}`)
    symlinkSync(`releases/${version}/${d.file}`, temp)
    renameSync(temp, join(publicDir, aliases[d.target]))
  }
  atomic('download.css', 'body{font:16px/1.6 system-ui,sans-serif;background:#faf9f5;color:#292826;margin:0}main{max-width:760px;margin:8vh auto;padding:24px}li{margin:22px 0}a{color:#a84420}small{display:block;overflow-wrap:anywhere}code{font-size:11px}')
  atomic('index.html', html)
  atomic('downloads.json', JSON.stringify(release.downloads, null, 2) + '\n')
  // Publish the manifest last. Every URL already resolves to a complete immutable file.
  atomic('latest.json', JSON.stringify(release.latest, null, 2) + '\n')
  console.log(`Published ${p.productName} ${version}: ${p.downloadBase}/`)
} finally { rmSync(stage, { recursive: true, force: true }) }
