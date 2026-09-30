import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readdir, rename, rm, stat, utimes } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { satuworkHome } from '../home.ts'

/**
 * 把 Word / Excel / PPT 渲染成 PDF，给界面预览用。
 *
 * extract.ts 那条只抽文字：给模型读正合适，给人看就不够了——表格的框线、字号、图、
 * 幻灯片的版式全没了，而人点开一份刚生成的报告，想确认的恰恰是「它长什么样」。浏览器
 * 自己不认这几种格式，前端库还原得又差（PPT 尤其），所以交给 LibreOffice 转一份 PDF，
 * 界面上走现成的 PDF 阅读器。
 *
 * **LibreOffice 是可选的。** 席位上由 deploy-seat.sh 装；桌面端本地 Bot 那台电脑上
 * 装了就用，没装就回 `unavailable`，界面退回到提取文本那一版——两边都不是硬依赖。
 *
 * 几条约束：
 *
 * - **一次只跑一个 soffice。** 同一份用户配置目录不能被两个进程同时用（后起的那个会
 *   直接把活交给前一个然后退出，什么都不产出），而且它一个就要吃几百 MB。串成一队，
 *   同一份文件同时来的请求合成一次。
 * - **结果落盘缓存**，键是「路径 + mtime + 大小」：文件改了自然不命中，不用额外失效。
 *   PDF 可能好几 MB，不放内存。
 * - **先拷一份再转**：Bot 可能正在往原文件里写，拿半截文件去转只会得到一个解析失败；
 *   拷贝也让输出文件名固定（soffice 按输入的文件名起输出名）。
 */

/** LibreOffice 转得动、而且值得在界面上渲染的扩展名。老二进制格式和 ODF 一并收下。 */
const RENDERABLE = new Set(['docx', 'doc', 'rtf', 'odt', 'xlsx', 'xlsm', 'xls', 'ods', 'pptx', 'ppt', 'odp'])

export function renderableOf(name: string): boolean {
  return RENDERABLE.has(extname(name).slice(1).toLowerCase())
}

/**
 * 肯渲染的文件大小上限。和 extract.ts 的 MAX_DOC_BYTES 同一个数、同一个理由：
 * soffice 也是整份读进内存，一个几十 MB 的表格能把这个席位的内存吃光。
 */
const MAX_RENDER_BYTES = 25 * 1024 * 1024

/**
 * 一次转换最多等多久。冷启动（第一次建用户配置）要十来秒，一份几十页的 PPT 再加十来秒；
 * 真卡死的 soffice 不会自己退，必须有个头。
 */
function renderTimeoutMs(): number {
  return Math.max(1_000, Math.trunc(Number(process.env.SATUWORK_RENDER_TIMEOUT_MS) || 90_000))
}

/** 缓存留几份、最多占多少。全是缓存，删了下次再转就是。 */
const CACHE_MAX_FILES = 24
const CACHE_MAX_BYTES = 256 * 1024 * 1024

export type RenderFailure = 'unavailable' | 'too-big' | 'failed'

export class RenderError extends Error {
  readonly reason: RenderFailure
  constructor(reason: RenderFailure, message: string) {
    super(message)
    this.reason = reason
  }
}

/**
 * 找 soffice。`SATUWORK_SOFFICE` 优先，其次 PATH，再其次各平台的默认安装位置
 * （找浏览器那段的同一个写法，见 browser/index.ts 的 localBrowserExecutable）。
 */
export function officeExecutable(): string | null {
  const override = process.env.SATUWORK_SOFFICE?.trim()
  if (override) return existsSync(override) ? override : null
  const names = process.platform === 'win32' ? ['soffice.exe'] : ['soffice', 'libreoffice']
  const onPath = names.flatMap((name) =>
    (process.env.PATH || '').split(delimiter).filter(Boolean).map((dir) => join(dir, name)),
  )
  const candidates =
    process.platform === 'darwin'
      ? [
          '/Applications/LibreOffice.app/Contents/MacOS/soffice',
          join(homedir(), 'Applications/LibreOffice.app/Contents/MacOS/soffice'),
          ...onPath,
        ]
      : process.platform === 'win32'
        ? [
            ...onPath,
            ...(process.env.PROGRAMFILES ? [join(process.env.PROGRAMFILES, 'LibreOffice/program/soffice.exe')] : []),
            ...(process.env['PROGRAMFILES(X86)']
              ? [join(process.env['PROGRAMFILES(X86)'], 'LibreOffice/program/soffice.exe')]
              : []),
          ]
        : ['/usr/bin/soffice', '/usr/bin/libreoffice', ...onPath]
  return candidates.find((c) => existsSync(c)) ?? null
}

function cacheDir(...segments: string[]): string {
  return satuworkHome('render-cache', ...segments)
}

/** 同一份文件同时来的几次请求合成一次。 */
const inflight = new Map<string, Promise<string>>()
/** 所有转换排成的那一队的队尾。 */
let queue: Promise<unknown> = Promise.resolve()

/**
 * 把这份文件渲染成 PDF，回缓存里那份 PDF 的路径。
 *
 * 调用方自己打开它往外送。缓存修剪只删最旧的，刚转出来的这份一定是最新的。
 */
export async function renderToPdf(file: string): Promise<string> {
  if (!renderableOf(file)) throw new RenderError('failed', '这种格式不能渲染成 PDF')
  const info = await stat(file)
  if (info.size > MAX_RENDER_BYTES) {
    throw new RenderError(
      'too-big',
      `这个文件有 ${(info.size / 1024 / 1024).toFixed(1)} MB，超过了渲染预览的上限（${MAX_RENDER_BYTES / 1024 / 1024} MB）。`,
    )
  }
  const key = createHash('sha256').update(`${file}|${info.mtimeMs}|${info.size}`).digest('hex').slice(0, 32)
  const out = cacheDir(`${key}.pdf`)
  if (existsSync(out)) {
    // 碰一下 mtime：修剪按它排，常看的那几份不该被挤掉。
    const now = new Date()
    await utimes(out, now, now).catch(() => {})
    return out
  }
  const running = inflight.get(key)
  if (running) return running
  const bin = officeExecutable()
  if (!bin) throw new RenderError('unavailable', '这台机器上没有 LibreOffice，渲染不了。')
  const job = queue.then(() => convert(bin, file, out))
  // 队伍不能因为一次失败就断掉：后面排着的照样要跑。
  queue = job.catch(() => {})
  inflight.set(key, job)
  try {
    return await job
  } finally {
    inflight.delete(key)
  }
}

async function convert(bin: string, file: string, out: string): Promise<string> {
  await mkdir(cacheDir(), { recursive: true })
  const dir = await mkdtemp(cacheDir('job-'))
  try {
    const input = join(dir, `in${extname(file).toLowerCase()}`)
    await copyFile(file, input)
    const profile = cacheDir('profile')
    // 用户配置目录是这一队独占的（一次只跑一个，见上面）。上一次被超时杀掉的话会留下
    // 一把 .lock，不清的话下一次 soffice 以为有人在用，直接退出、什么都不产出。
    await rm(join(profile, '.lock'), { force: true })
    await run(bin, [
      '--headless',
      '--norestore',
      '--nolockcheck',
      '--nodefault',
      '--nologo',
      // 自己的一份配置：不碰这台电脑上人自己在用的 LibreOffice（桌面端），第一次冷启动之后
      // 也不用每次重新初始化。
      `-env:UserInstallation=${pathToFileURL(profile).href}`,
      '--convert-to',
      'pdf',
      '--outdir',
      dir,
      input,
    ])
    const produced = join(dir, 'in.pdf')
    const size = await stat(produced).then((s) => s.size).catch(() => 0)
    // soffice 碰到读不了的文件常常是**退出码 0、什么也不写**，所以不能只看退出码。
    if (!size) throw new RenderError('failed', 'LibreOffice 没有转出东西来（文件可能损坏，或者格式不对）。')
    await rename(produced, out)
    await prune().catch(() => {})
    return out
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const group = process.platform !== 'win32'
    // detached：拿到自己的进程组。soffice 在 Linux 上是个包装脚本，真正干活的
    // soffice.bin 是它的子进程，超时只杀包装脚本的话那个会留下来（同 tools/terminal.ts）。
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: group, windowsHide: true })
    let stderr = ''
    child.stderr?.on('data', (b: Buffer) => {
      if (stderr.length < 4000) stderr += b.toString('utf8')
    })
    let timedOut = false
    const limit = renderTimeoutMs()
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (group && child.pid) process.kill(-child.pid, 'SIGKILL')
        // Windows 没有进程组：soffice.exe 也只是个启动器，干活的 soffice.bin 要连树一起杀。
        else if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        else child.kill('SIGKILL')
      } catch {}
    }, limit)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new RenderError('failed', `LibreOffice 起不来：${e.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) return reject(new RenderError('failed', `渲染超时（${Math.round(limit / 1000)} 秒）。`))
      if (code !== 0) {
        const tail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300)
        return reject(new RenderError('failed', `LibreOffice 退出码 ${code}${tail ? `：${tail}` : ''}`))
      }
      resolve()
    })
  })
}

/** 按 mtime 从新到旧留，份数和总量哪个先超就从最旧的删起。 */
async function prune() {
  const names = (await readdir(cacheDir())).filter((n) => n.endsWith('.pdf'))
  const files = await Promise.all(
    names.map(async (n) => {
      const s = await stat(cacheDir(n))
      return { path: cacheDir(n), mtime: s.mtimeMs, size: s.size }
    }),
  )
  files.sort((a, b) => b.mtime - a.mtime)
  let total = 0
  for (const [i, f] of files.entries()) {
    total += f.size
    // 最新那份（刚转出来、调用方正要去读的）无论如何不删。
    if (i > 0 && (i >= CACHE_MAX_FILES || total > CACHE_MAX_BYTES)) await rm(f.path, { force: true })
  }
}
