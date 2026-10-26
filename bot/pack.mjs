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
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { die, finish, foreignEsbuild, prepare, removeWorkspaceSelfLink, root } from '../scripts/pack-lib.mjs'

const botRoot = dirname(fileURLToPath(import.meta.url))
const pack = prepare(botRoot, 'bot')
const { version, outPath } = pack

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
  const foreign = foreignEsbuild(stage)
  if (foreign) {
    die(
      `这个包带的是 ${foreign.join(' / ')} 的 esbuild，拿到席位机器上起不来。\n` +
        '  在 Linux 上打包：CI 推 bot-v* tag，或者过一层 Docker（见 manager/README.md）。\n' +
        '  真要出一个只在本机跑的包，加 --allow-foreign-platform。',
    )
  }

  removeWorkspaceSelfLink(stage, 'satuwork')
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

await finish(pack, 'bot-releases')
