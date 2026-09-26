#!/usr/bin/env node
/**
 * 打一个**能直接跑**的 Bot 发布包，给 CI 用。
 *
 * 关键是依赖：仓库里的 `bot/node_modules` 全是指向 `../../node_modules/.pnpm/…` 的
 * 软链，直接 tar 打出去，解到席位机器上就是一堆断链——机器上没有 pnpm，也没有
 * `pnpm install` 这一步。所以这里走 `pnpm deploy`：它把依赖实打实地放进一个自包含
 * 目录，里面的软链只指向自己内部的 .pnpm，tar 完照样解得开。
 *
 * devDependencies 也要进包：systemd 单元跑的是 `node --import tsx bin/satuwork.mjs`，
 * 而 src/ 是 TypeScript——tsx 是运行时依赖，不是构建工具。
 *
 *   node bot/pack.mjs                                  # → dist/bot-<version>.tgz
 *   node bot/pack.mjs --version 1.2.3+abc1234
 *   node bot/pack.mjs --upload https://gw.example.com --note nightly
 *
 * 版本号默认 `<package.json version>+<git 短 sha>`（工作区脏时再加 `-dirty`），
 * 这样一个版本号永远对应同一份代码。上传要 `GATEWAY_PLATFORM_TOKEN`。
 *
 * 注意包**不是逐字节可复现**的：tar 里带 mtime，同一个 commit 打两次 sha256 不一样。
 * 所以 sha256 是「传输有没有坏」的校验，不是「内容是不是同一份」的身份——身份靠版本号，
 * 而版本号在 Gateway 那边只能占用一次。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const botRoot = dirname(fileURLToPath(import.meta.url))
const root = dirname(botRoot)

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
  const pkg = JSON.parse(readFileSync(join(botRoot, 'package.json'), 'utf8'))
  const base = String(pkg.version || '0.0.0')
  const sha = git('rev-parse', '--short', 'HEAD')
  if (!sha) return base
  // 脏工作区打出来的包对不上任何一个 commit，名字上就说清楚。
  const dirty = git('status', '--porcelain') ? '-dirty' : ''
  return `${base}+${sha}${dirty}`
}

/**
 * 平台闸。
 *
 * tsx 依赖 esbuild 的**原生二进制**，`pnpm deploy` 只实体化当前平台那一份。在 Mac
 * 上打的包带 `@esbuild/darwin-arm64`，解到席位机器上 tsx 加载不了 esbuild，bot 起
 * 不来。报错说的是 esbuild 缺平台二进制，不是「包错了」，很难往这儿想——所以在
 * 打包这一步就拦住。
 */
function assertLinuxPack(stage) {
  let entries = []
  try {
    entries = readdirSync(join(stage, 'node_modules', '.pnpm'))
  } catch {
    return
  }
  const platforms = entries.filter((e) => e.startsWith('@esbuild+')).map((e) => e.slice('@esbuild+'.length).split('@')[0])
  if (!platforms.length || platforms.some((p) => p.startsWith('linux-'))) return
  die(
    `这个包带的是 ${platforms.join(' / ')} 的 esbuild，拿到席位机器上起不来。\n` +
      '  在 Linux 上打包：CI 推 bot-v* tag，或者过一层 Docker（见 manager/README.md）。\n' +
      '  真要出一个只在本机跑的包，加 --allow-foreign-platform。',
  )
}

const version = (arg('version') || defaultVersion()).trim()
if (!/^[A-Za-z0-9._+-]{1,64}$/.test(version)) die(`版本号 ${version} 不合法（1–64 位字母数字或 . _ + -）`)
const note = arg('note') || ''
const outPath = resolve(arg('out') || join(root, 'dist', `bot-${version}.tgz`))
const uploadTo = arg('upload')

mkdirSync(dirname(outPath), { recursive: true })
if (existsSync(outPath)) rmSync(outPath)

const tmp = mkdtempSync(join(tmpdir(), 'satuwork-pack-'))
const stage = join(tmp, 'bot')
try {
  console.log(`pack: 版本 ${version}`)
  console.log('pack: pnpm deploy 中（把依赖实体化进 staging 目录）…')
  /**
   * Windows 上的 pnpm 是 `pnpm.cmd`，不走 shell 起不来（spawnSync 回一个 ENOENT、status 为
   * null）——桌面端的 local-bot 包在 Windows runner 上就是卡在这一步。走 shell 时参数是
   * 拼成一整行交给 cmd 的，路径要自己加引号（临时目录可能带空格）。
   */
  const win = process.platform === 'win32'
  const dep = spawnSync('pnpm', ['--filter', 'satuwork', 'deploy', '--legacy', win ? `"${stage}"` : stage], {
    cwd: root,
    stdio: 'inherit',
    encoding: 'utf8',
    shell: win,
  })
  if (dep.status !== 0) die(`pnpm deploy 失败（status=${dep.status}${dep.error ? `，${dep.error.message}` : ''}）`)
  if (!existsSync(join(stage, 'bin', 'satuwork.mjs'))) die('staging 里没有 bin/satuwork.mjs')
  if (!existsSync(join(stage, 'node_modules', 'tsx'))) die('staging 里没有 tsx，包跑不起来')
  if (!process.argv.includes('--allow-foreign-platform')) assertLinuxPack(stage)

  writeFileSync(join(stage, 'VERSION'), version + '\n')

  console.log('pack: tar 中…')
  /**
   * **只给 tar 相对路径**：在临时目录里打成 `bot.tgz`，再复制到输出位置。Windows runner 的
   * Git Bash 里是 GNU tar，它把 `D:\…` 这种带盘符的绝对路径当成「主机:路径」去连远程，
   * 直接 exit 2；而输出目录和临时目录常常不在同一个盘上，凑不出相对路径。GNU tar 的
   * `--force-local` 能治，但 macOS 和 Windows 自带的 bsdtar 不认它。
   */
  const tar = spawnSync(
    'tar',
    [
      '-czf',
      'bot.tgz',
      '--exclude=node_modules/.cache',
      '--exclude=.data',
      '--exclude=*.log',
      '--exclude=cordis.e2e.yml',
      '-C',
      'bot',
      '.',
    ],
    { cwd: tmp, encoding: 'utf8' },
  )
  if (tar.status !== 0) die('tar 失败: ' + String(tar.stderr || tar.error?.message || '').slice(0, 400))
  copyFileSync(join(tmp, 'bot.tgz'), outPath)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

const bytes = readFileSync(outPath)
const sha256 = createHash('sha256').update(bytes).digest('hex')
const size = statSync(outPath).size
console.log(`pack: ${outPath}`)
console.log(`pack: ${size} 字节  sha256 ${sha256}`)

// GitHub Actions 里把这几个值传给后续 step。
if (process.env.GITHUB_OUTPUT) {
  writeFileSync(
    process.env.GITHUB_OUTPUT,
    `version=${version}\nsha256=${sha256}\npath=${outPath}\nsize=${size}\n`,
    { flag: 'a' },
  )
}

if (uploadTo) {
  const token = process.env.GATEWAY_PLATFORM_TOKEN || ''
  if (!token) die('要上传得给 GATEWAY_PLATFORM_TOKEN')
  const base = uploadTo.replace(/\/$/, '')
  const url = `${base}/platform/bot-releases/${encodeURIComponent(version)}${note ? '?note=' + encodeURIComponent(note) : ''}`
  console.log(`pack: PUT ${base}/platform/bot-releases/${version}`)
  const r = await fetch(url, {
    method: 'PUT',
    headers: {
      authorization: 'Bearer ' + token,
      'content-type': 'application/gzip',
      'x-bot-sha256': sha256,
    },
    body: bytes,
  })
  const text = await r.text()
  console.log(`pack: ${r.status} ${text.slice(0, 400)}`)
  if (!r.ok) process.exit(1)
}
