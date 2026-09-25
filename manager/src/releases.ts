import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { managerVersion, releaseRoot } from './config.ts'
import { run } from './run.ts'

/**
 * 发布包缓存。
 *
 * 取代了原来「每部署一个席位就 scp 一遍完整安装包」：管家在本机，同一个版本拉一次、
 * 解一次，之后所有席位从 `releases/<version>/` 拷。
 *
 * `VERSION` 文件是「解完整了」的标记，最后写。中途失败留下的半个目录下次会被整个
 * 删掉重来——只判断目录存在会把半个包当成好包用。
 */

export function releaseDir(version: string): string {
  return join(releaseRoot(), version)
}

export function haveRelease(version: string): boolean {
  try {
    return readFileSync(join(releaseDir(version), 'VERSION'), 'utf8').trim() === version
  } catch {
    return false
  }
}

/** 版本号进路径，得先确认它不能往上跳。Gateway 那边也校验，这里不依赖它。 */
function safeVersion(version: string): string {
  if (!/^[A-Za-z0-9._+-]{1,64}$/.test(version) || version.startsWith('.')) {
    throw new Error(`invalid version: ${version}`)
  }
  return version
}

/**
 * 同一个版本正在下的那一次。**同版本并发只跑一趟。**
 *
 * deploySeat 天生是并发的（inFlight 是个计数器）：Gateway 把新版本铺给一台机器上的
 * 好几个席位时，几个 `PUT /seats/:id` 同时进来，各自调 ensureRelease。而这个函数用的
 * 是**共享的目录**和一个**固定名字的临时包**（`.<version>.tgz`）——两趟同时跑就会互相
 * 拆台：A 正在 untar，B 一句 `rmSync(dir)` 把它的目录端了；A 的 finally 又把 B 正在解的
 * 那个 tgz 删了。两边最后都报「untarring failed / has no bin/satuwork.mjs」，而包本身
 * 好好的，看起来像一次莫名其妙的部署故障。
 *
 * 让后来的那几趟等前一趟的结果就行——它们要的本来就是同一个目录。
 */
const inflight = new Map<string, Promise<string>>()

/**
 * 去哪儿拉包。
 *
 * `url` + `sha256` 是 Gateway 在部署规格里给的**直连地址**（GitHub Release 那种，见
 * gateway/src/releases.ts 的 directReleaseUrl）：有它就直接去取，校验值用规格里那一份。
 * 没有（包只在 Gateway 本机或私有 Blob 里）就走老路 `/internal/bot-releases/*`，校验值在
 * 响应头里。
 */
export interface ReleaseSource {
  gatewayUrl: string
  token: string
  url?: string
  sha256?: string
}

export async function ensureRelease(
  version: string,
  opts: ReleaseSource,
): Promise<string> {
  safeVersion(version)
  const running = inflight.get(version)
  if (running) return running
  const task = fetchRelease(version, opts).finally(() => inflight.delete(version))
  inflight.set(version, task)
  return task
}

async function fetchRelease(
  version: string,
  opts: ReleaseSource,
): Promise<string> {
  const dir = releaseDir(version)
  if (haveRelease(version)) return dir

  const direct = opts.url && opts.sha256 ? opts.url : ''
  const url = direct || `${opts.gatewayUrl}/internal/bot-releases/${encodeURIComponent(version)}`
  // 机器票只交给 Gateway 自己：直连地址和配对的 Gateway 不同源就裸取（同 upgrade.ts）。
  // 票是这台机器的 root 控制面凭据，不能因为规格里一行地址就寄到 GitHub 去。
  const res = await fetch(url, {
    headers: {
      ...(!direct || sameOrigin(direct, opts.gatewayUrl) ? { authorization: 'Bearer ' + opts.token } : {}),
      'user-agent': `satuwork-manager/${managerVersion()}`,
    },
    signal: AbortSignal.timeout(300_000),
  })
  if (!res.ok) throw new Error(`downloading release ${version} failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
  const bytes = Buffer.from(await res.arrayBuffer())

  // 对不上就是传输坏了、或者那个地址上换了东西——解开只会得到更难查的症状。
  // 直连时校验值是部署规格里的那一份（登记时 Gateway 自己拉一遍算的，经带机器票的通道
  // 发下来），**不看**外部主机回的任何头。走 Gateway 时在响应头里；**头缺了也不装**：那一行
  // 是入库时服务端自己算的，一次正常的下发不可能没有它。
  const want = direct ? String(opts.sha256) : String(res.headers.get('x-bot-sha256') || '').trim()
  if (!want) throw new Error(`release ${version} came without a checksum, refusing to unpack`)
  const got = createHash('sha256').update(bytes).digest('hex')
  if (got !== want) throw new Error(`release ${version} checksum mismatch: ${got.slice(0, 12)} != ${want.slice(0, 12)}`)

  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const tgz = join(releaseRoot(), `.${version}.tgz`)
  writeFileSync(tgz, bytes)
  try {
    const r = await run('tar', ['-xzf', tgz, '-C', dir], { timeout: 300_000 })
    if (r.code !== 0) throw new Error(`untarring ${version} failed: ${(r.stderr || r.stdout).slice(-300)}`)
    if (!existsSync(join(dir, 'bin', 'satuwork.mjs'))) {
      throw new Error(`release ${version} has no bin/satuwork.mjs`)
    }
    writeFileSync(join(dir, 'VERSION'), version + '\n')
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    throw e
  } finally {
    rmSync(tgz, { force: true })
  }
  return dir
}

/** 两个地址同不同源。解析不了的一律当不同源——宁可不带票。 */
export function sameOrigin(url: string, gatewayUrl: string | undefined): boolean {
  if (!gatewayUrl) return false
  try {
    return new URL(url).origin === new URL(gatewayUrl).origin
  } catch {
    return false
  }
}
