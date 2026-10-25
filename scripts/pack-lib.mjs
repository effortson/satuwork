/**
 * bot/pack.mjs 和 manager/pack.mjs 共用的那一半：参数、默认版本号、平台闸、出包之后的
 * sha256 / GITHUB_OUTPUT / 上传。两边各自只留 `pnpm deploy`、包里该有什么、怎么 tar——
 * 那几步两个包确实不一样（bot 要在 Windows runner 上跑，管家只在 Linux 上出）。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = dirname(dirname(fileURLToPath(import.meta.url)))

export function arg(name) {
  const i = process.argv.indexOf('--' + name)
  return i === -1 ? undefined : process.argv[i + 1]
}

export function die(msg) {
  console.error('pack: ' + msg)
  process.exit(1)
}

function git(...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : ''
}

function defaultVersion(pkgRoot) {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
  const base = String(pkg.version || '0.0.0')
  const sha = git('rev-parse', '--short', 'HEAD')
  if (!sha) return base
  // 脏工作区打出来的包对不上任何一个 commit，名字上就说清楚。
  const dirty = git('status', '--porcelain') ? '-dirty' : ''
  return `${base}+${sha}${dirty}`
}

/**
 * 读参数、定版本号和输出路径，并把输出位置腾出来。`name` 是默认文件名的前缀（bot / manager）。
 */
export function prepare(pkgRoot, name) {
  const version = (arg('version') || defaultVersion(pkgRoot)).trim()
  if (!/^[A-Za-z0-9._+-]{1,64}$/.test(version)) die(`版本号 ${version} 不合法（1–64 位字母数字或 . _ + -）`)
  const note = arg('note') || ''
  const outPath = resolve(arg('out') || join(root, 'dist', `${name}-${version}.tgz`))
  const uploadTo = arg('upload')

  mkdirSync(dirname(outPath), { recursive: true })
  if (existsSync(outPath)) rmSync(outPath)
  return { version, note, outPath, uploadTo }
}

/**
 * 平台闸：staging 里实体化的 esbuild 一个 linux- 的都没有时，返回它们是哪些平台；否则 null。
 *
 * tsx 依赖 esbuild 的**原生二进制**，`pnpm deploy` 只实体化当前平台那一份。在 Mac 上打的
 * 包带 `@esbuild/darwin-arm64`，解到席位机器上 tsx 加载不了 esbuild，进程起不来。报错说的
 * 是 esbuild 缺平台二进制，不是「包错了」，很难往这儿想——所以在打包这一步就拦住。
 * 怎么说、往哪儿指路，两个包各自不同，由调用方 die。
 */
export function foreignEsbuild(stage) {
  if (process.argv.includes('--allow-foreign-platform')) return null
  let entries = []
  try {
    entries = readdirSync(join(stage, 'node_modules', '.pnpm'))
  } catch {
    return null
  }
  const platforms = entries.filter((e) => e.startsWith('@esbuild+')).map((e) => e.slice('@esbuild+'.length).split('@')[0])
  if (!platforms.length || platforms.some((p) => p.startsWith('linux-'))) return null
  return platforms
}

/**
 * 包已经落在 outPath 之后：报 sha256 和大小，交给 GitHub Actions 的后续 step，按需上传到
 * `<gateway>/platform/<releases>/:version`（releases 是 bot-releases / manager-releases）。
 */
export async function finish({ version, note, outPath, uploadTo }, releases) {
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
    const url = `${base}/platform/${releases}/${encodeURIComponent(version)}${note ? '?note=' + encodeURIComponent(note) : ''}`
    console.log(`pack: PUT ${base}/platform/${releases}/${version}`)
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
}
