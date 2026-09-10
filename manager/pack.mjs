#!/usr/bin/env node
/**
 * 打一个能直接跑的机器管家发布包。
 *
 * 和 bot/pack.mjs 是同一件事、同样的理由：仓库里的 `manager/node_modules` 全是指向
 * `../../node_modules/.pnpm/…` 的软链，直接 tar 出去解到 Debian 上就是一堆断链，
 * 而那台机器上没有 pnpm。`pnpm deploy` 会把依赖实打实放进一个自包含目录。
 *
 * devDependencies 也要进包：systemd 跑的是 `node --import tsx bin/satuwork-manager.mjs`，
 * src/ 是 TypeScript——tsx 是运行时依赖，不是构建工具。
 *
 *   node manager/pack.mjs
 *   node manager/pack.mjs --upload https://gw.example.com --note nightly
 *
 * 上传要 GATEWAY_PLATFORM_TOKEN，进的是 /platform/manager-releases/:version。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = dirname(fileURLToPath(import.meta.url))
const root = dirname(pkgRoot)

function arg(name) {
  const i = process.argv.indexOf('--' + name)
  return i === -1 ? undefined : process.argv[i + 1]
}

function die(msg) {
  console.error('pack: ' + msg)
  process.exit(1)
}

function git(...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : ''
}

function defaultVersion() {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
  const base = String(pkg.version || '0.0.0')
  const sha = git('rev-parse', '--short', 'HEAD')
  if (!sha) return base
  const dirty = git('status', '--porcelain') ? '-dirty' : ''
  return `${base}+${sha}${dirty}`
}

/**
 * 平台闸。
 *
 * tsx 依赖 esbuild 的**原生二进制**，而 `pnpm deploy` 只会把当前平台那一份实体化
 * 进包里。在 Mac 上打的包带的是 `@esbuild/darwin-arm64`，解到 Debian 上 tsx 加载
 * 不了 esbuild，管家起不来——而那台机器上已经没有 SSH 可以救。
 *
 * 症状极难认（报的是 esbuild 找不到平台二进制，不是「包错了」），所以在这里拦住，
 * 而不是等它到现场爆炸。要在 Mac 上出包只能过 Docker，见 README。
 */
function assertLinuxPack(stage) {
  const dir = join(stage, 'node_modules', '.pnpm')
  let entries = []
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  const platforms = entries.filter((e) => e.startsWith('@esbuild+')).map((e) => e.slice('@esbuild+'.length).split('@')[0])
  if (!platforms.length) return
  if (platforms.some((p) => p.startsWith('linux-'))) return
  die(
    `这个包带的是 ${platforms.join(' / ')} 的 esbuild，拿到 Debian 上起不来。\n` +
      '  在 Linux 上打包：CI 推 manager-v* tag，或者\n' +
      "  docker run --rm -v \"$PWD\":/src -w /w node:24-bookworm-slim bash -c \\\n" +
      "    'corepack enable && cp -r /src /w && cd /w && pnpm install --frozen-lockfile && node manager/pack.mjs --out /src/dist/manager-linux.tgz'\n" +
      '  真要出一个只在本机跑的包，加 --allow-foreign-platform。',
  )
}

const version = (arg('version') || defaultVersion()).trim()
if (!/^[A-Za-z0-9._+-]{1,64}$/.test(version)) die(`版本号 ${version} 不合法（1–64 位字母数字或 . _ + -）`)
const note = arg('note') || ''
const outPath = resolve(arg('out') || join(root, 'dist', `manager-${version}.tgz`))
const uploadTo = arg('upload')

mkdirSync(dirname(outPath), { recursive: true })
if (existsSync(outPath)) rmSync(outPath)

const tmp = mkdtempSync(join(tmpdir(), 'satuwork-manager-pack-'))
const stage = join(tmp, 'manager')
try {
  console.log(`pack: 版本 ${version}`)
  console.log('pack: pnpm deploy 中…')
  const dep = spawnSync('pnpm', ['--filter', 'satuwork-manager', 'deploy', '--legacy', stage], {
    cwd: root,
    stdio: 'inherit',
    encoding: 'utf8',
  })
  if (dep.status !== 0) die('pnpm deploy 失败')
  if (!existsSync(join(stage, 'bin', 'satuwork-manager.mjs'))) die('staging 里没有 bin/satuwork-manager.mjs')
  // 工人和管家同一个包（satuwork-worker.service 的 ExecStart 指它）。少了它机器上工人起不来，
  // 而管家照旧报 7 号协议，Gateway 会以为任务归工人——没人领，只剩「机器没回报」。
  if (!existsSync(join(stage, 'bin', 'satuwork-worker.mjs'))) die('staging 里没有 bin/satuwork-worker.mjs')
  if (!existsSync(join(stage, 'node_modules', 'tsx'))) die('staging 里没有 tsx，包跑不起来')
  if (!process.argv.includes('--allow-foreign-platform')) assertLinuxPack(stage)
  // 席位脚本必须跟着走：管家靠它们建账号、起屏、起 bot。
  // manager-confirm.sh 也在这张单子里：它是自升级的兜底，装机脚本从包里拷它，管家每次
  // 启动也照包里这份刷新一遍。漏进包里的话，兜底会在下一次升级之后静悄悄消失。
  // purge-machine.sh 也在单子上：它是人上去还原机器时唯一的那份工具，而需要它的时候
  // 机器多半已经连不上 Gateway 了——那时候没法再传一份进去。
  for (const f of [
    'deploy-seat.sh',
    'remove-seat.sh',
    'slim-desktop.sh',
    'satuwork-bot.sh',
    'manager-confirm.sh',
    'purge-machine.sh',
  ]) {
    if (!existsSync(join(stage, 'src', 'seat', f))) die(`staging 里没有 src/seat/${f}`)
  }

  writeFileSync(join(stage, 'VERSION'), version + '\n')

  console.log('pack: tar 中…')
  const tar = spawnSync(
    'tar',
    ['-czf', outPath, '--exclude=node_modules/.cache', '--exclude=*.log', '-C', stage, '.'],
    { encoding: 'utf8' },
  )
  if (tar.status !== 0) die('tar 失败: ' + String(tar.stderr || '').slice(0, 400))
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

const bytes = readFileSync(outPath)
const sha256 = createHash('sha256').update(bytes).digest('hex')
const size = statSync(outPath).size
console.log(`pack: ${outPath}`)
console.log(`pack: ${size} 字节  sha256 ${sha256}`)

if (process.env.GITHUB_OUTPUT) {
  writeFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nsha256=${sha256}\npath=${outPath}\nsize=${size}\n`, {
    flag: 'a',
  })
}

if (uploadTo) {
  const token = process.env.GATEWAY_PLATFORM_TOKEN || ''
  if (!token) die('要上传得给 GATEWAY_PLATFORM_TOKEN')
  const base = uploadTo.replace(/\/$/, '')
  const url = `${base}/platform/manager-releases/${encodeURIComponent(version)}${note ? '?note=' + encodeURIComponent(note) : ''}`
  console.log(`pack: PUT ${base}/platform/manager-releases/${version}`)
  const r = await fetch(url, {
    method: 'PUT',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/gzip', 'x-bot-sha256': sha256 },
    body: bytes,
  })
  const text = await r.text()
  console.log(`pack: ${r.status} ${text.slice(0, 400)}`)
  if (!r.ok) process.exit(1)
}
