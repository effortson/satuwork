#!/usr/bin/env node
/**
 * 给已安装的 Desktop 打一份可热替换的本地 Bot 运行时。
 *
 * 包不带 Node：Node 随 Desktop 安装器分发；这里只放 bot + 已实体化依赖。tsx/esbuild
 * 含原生模块，所以平台和架构必须进入版本号，Gateway 才能给每台机器选对包。
 *
 * 这版运行时要求的最低 Desktop 版本写在 bot/package.json 的 `minDesktopVersion`：bot 代码
 * 开始依赖某一版壳才有的东西（新的环境变量、参数、桥接命令）时，把它抬到那一版。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = dirname(dirname(fileURLToPath(import.meta.url)))
const root = dirname(desktop)

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

function die(message) {
  console.error(`local-runtime-pack: ${message}`)
  process.exit(1)
}

const platform = { darwin: 'darwin', win32: 'windows', linux: 'linux' }[process.platform]
const arch = { x64: 'x64', arm64: 'arm64' }[process.arch]
if (!platform || !arch) die(`暂不支持 ${process.platform}-${process.arch}`)

const pkg = JSON.parse(readFileSync(join(root, 'bot/package.json'), 'utf8'))
const base = String(arg('version') || pkg.version || '').trim()
const version = `${base}-${platform}-${arch}`
if (!/^[A-Za-z0-9._+-]{1,64}$/.test(version)) {
  die(`版本号 ${version} 不合法或超过 64 位`)
}

// 这版运行时至少要哪一版 Desktop。登记时（register-release.yml / 本地 PUT）从同一处读，
// 这里先验一遍格式：Gateway 只收严格的 x.y.z，别等打完六个包、到登记那一步才发现。
const minDesktop = String(pkg.minDesktopVersion || '0.1.0')
if (!/^\d+\.\d+\.\d+$/.test(minDesktop)) die(`bot/package.json 的 minDesktopVersion「${minDesktop}」须为 x.y.z`)

const out = resolve(arg('out') || join(root, 'dist', `local-bot-${version}.tgz`))
const packed = spawnSync(
  process.execPath,
  [
    join(root, 'bot/pack.mjs'),
    '--allow-foreign-platform',
    '--version',
    version,
    '--out',
    out,
  ],
  { cwd: root, stdio: 'inherit' },
)
if (packed.status !== 0) process.exit(packed.status || 1)
console.log(`local-runtime-pack: ${out}（最低 Desktop ${minDesktop}）`)
