// A public build profile contains addresses and application identity, never credentials.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export function validateProfile(p) {
  const keys = ['region', 'channel', 'productName', 'identifier', 'gatewayUrl', 'updateUrl', 'downloadBase']
  if (!p || typeof p !== 'object' || Object.keys(p).some(k => !keys.includes(k)) || keys.some(k => typeof p[k] !== 'string')) throw Error('Invalid public distribution profile')
  if (p.region !== 'cn' || !['stable', 'beta'].includes(p.channel)) throw Error('Unsupported distribution')
  const beta = p.channel === 'beta'
  if (p.productName !== (beta ? 'Satuwork-CN-Beta' : 'Satuwork-CN') || p.identifier !== (beta ? 'sg.dami.satuwork.cn.beta' : 'sg.dami.satuwork.cn')) throw Error('Distribution application identity must be isolated')
  for (const k of ['gatewayUrl', 'updateUrl', 'downloadBase']) {
    const u = new URL(p[k])
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.href.replace(/\/$/, '') !== p[k].replace(/\/$/, '')) throw Error(`Invalid public HTTPS URL: ${k}`)
  }
  if (new URL(p.gatewayUrl).pathname !== '/') throw Error('Gateway must be an origin')
  if (new URL(p.updateUrl).origin !== new URL(p.downloadBase).origin || !p.updateUrl.startsWith(p.downloadBase + '/')) throw Error('Update manifest must be in the domestic download directory')
  return p
}
export function validateVersion(v, channel) {
  const n = '(0|[1-9][0-9]*)'
  const base = `${n}\\.${n}\\.${n}`
  if (!new RegExp(channel === 'stable' ? `^${base}$` : `^${base}-beta\\.${n}$`).test(v)) throw Error('Version must match its stable/beta channel')
  return v
}
export function configure(profile, version, configPath = resolve(root, 'desktop/src-tauri/tauri.conf.json'), envPath = process.env.GITHUB_ENV) {
  const p = validateProfile(profile)
  validateVersion(version, p.channel)
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  Object.assign(config, { productName: p.productName, identifier: p.identifier, version })
  config.plugins.updater.endpoints = [p.updateUrl]
  config.bundle.createUpdaterArtifacts = true
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
  const env = { SATUWORK_BUILD_REGION: p.region, SATUWORK_BUILD_CHANNEL: p.channel, SATUWORK_BUILD_GATEWAY_URL: p.gatewayUrl, SATUWORK_BUILD_UPDATE_URL: p.updateUrl, SATUWORK_BUNDLE_UI_LIBS: '1' }
  if (envPath) appendFileSync(envPath, Object.entries(env).map(([k, v]) => `${k}=${v}\n`).join(''))
  return env
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const profiles = JSON.parse(process.env.DESKTOP_DISTRIBUTION_CONFIG || readFileSync(process.argv[2], 'utf8'))
  const p = profiles[process.env.DISTRIBUTION_CHANNEL]
  configure(p, process.env.DISTRIBUTION_VERSION)
  console.log(`Configured ${p.productName} (${p.channel})`)
}
