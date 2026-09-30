import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { findExecutable } from '../executable.ts'
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
 * - **先拷一份再转**，拷之前、拷之后各 stat 一次：两次对不上说明 Bot 正在往里写，拷到的
 *   是半截，直接报「正在改写」，不拿它去转。缓存键也按拷之前那次算——请求进来时 stat 到的
 *   那份在排队期间可能已经变了，按它记键会把新内容存到旧键底下。拷贝还让输出文件名固定
 *   （soffice 按输入的文件名起输出名）。
 * - **不让它往外连**：工作区里的文档可能是从网上下来的。LibreOffice 7.4 默认转换时不取
 *   外链（实测 docx 外链图片、ODT 外链图片、Calc 的 WEBSERVICE 都没发请求），但这靠的是
 *   它的默认值和版本；这份配置目录是我们自己的，所以把「挡外链、禁宏」显式写进去
 *   （见 HARDENING）。
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

/**
 * 进程退出之后，最多再等多久让 stderr 管道关上。
 *
 * soffice 的某个后代要是换了会话、手里还攥着 stderr 的写端，`close` 就永远不来——
 * 杀进程组也杀不到它（同 tools/terminal.ts 的 killTree 那段）。只等 `close` 的话，这一次
 * 永不结束，而后面所有转换都排在它后面，整个席位的预览一起卡死。
 */
const PIPE_GRACE_MS = 1_000

/**
 * 写进私有配置目录的加固项（`user/registrymodifications.xcu`）。
 *
 * - BlockUntrustedRefererLinks：文档里引用的外部图片 / 链接不去取。
 * - MacroSecurityLevel 3 + DisableMacrosExecution：宏一律不跑（.xlsm 这类带宏的也收）。
 *
 * LibreOffice 退出时会重写这个文件、保留这些项；每次转换前看一眼标记，没有就整份写回。
 */
const HARDENING_MARK = 'BlockUntrustedRefererLinks'
const HARDENING = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
</oor:items>
`

export type RenderFailure = 'unavailable' | 'too-big' | 'failed'

export class RenderError extends Error {
  readonly reason: RenderFailure
  constructor(reason: RenderFailure, message: string) {
    super(message)
    this.reason = reason
  }
}

/**
 * 找 soffice。`SATUWORK_SOFFICE` 优先，其次各平台的默认安装位置，再其次 PATH
 * （和找浏览器共用 executable.ts）。
 */
export function officeExecutable(): string | null {
  const names = process.platform === 'win32' ? ['soffice.exe'] : ['soffice', 'libreoffice']
  const fixed =
    process.platform === 'darwin'
      ? [
          '/Applications/LibreOffice.app/Contents/MacOS/soffice',
          join(homedir(), 'Applications/LibreOffice.app/Contents/MacOS/soffice'),
        ]
      : process.platform === 'win32'
        ? [
            ...(process.env.PROGRAMFILES ? [join(process.env.PROGRAMFILES, 'LibreOffice/program/soffice.exe')] : []),
            ...(process.env['PROGRAMFILES(X86)']
              ? [join(process.env['PROGRAMFILES(X86)'], 'LibreOffice/program/soffice.exe')]
              : []),
          ]
        : ['/usr/bin/soffice', '/usr/bin/libreoffice']
  return findExecutable(process.env.SATUWORK_SOFFICE, names, fixed)
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
  const key = cacheKey(file, info)
  const hit = await cached(key)
  if (hit) return hit
  const running = inflight.get(key)
  if (running) return running
  const bin = officeExecutable()
  if (!bin) throw new RenderError('unavailable', '这台机器上没有 LibreOffice，渲染不了。')
  const job = queue.then(() => convert(bin, file))
  // 队伍不能因为一次失败就断掉：后面排着的照样要跑。
  queue = job.catch(() => {})
  inflight.set(key, job)
  try {
    return await job
  } finally {
    inflight.delete(key)
  }
}

function cacheKey(file: string, info: Stats): string {
  return createHash('sha256').update(`${file}|${info.mtimeMs}|${info.size}`).digest('hex').slice(0, 32)
}

/** 缓存里有这份就回它的路径，顺手碰一下 mtime：修剪按它排，常看的那几份不该被挤掉。 */
async function cached(key: string): Promise<string | null> {
  const out = cacheDir(`${key}.pdf`)
  if (!existsSync(out)) return null
  const now = new Date()
  await utimes(out, now, now).catch(() => {})
  return out
}

async function convert(bin: string, file: string): Promise<string> {
  await mkdir(cacheDir(), { recursive: true })
  // 排队期间文件可能又被改过：按轮到时的这份算键，改过的话也许别人已经替它转好了。
  const before = await stat(file)
  const key = cacheKey(file, before)
  const hit = await cached(key)
  if (hit) return hit
  const out = cacheDir(`${key}.pdf`)
  const dir = await mkdtemp(cacheDir('job-'))
  try {
    const input = join(dir, `in${extname(file).toLowerCase()}`)
    await copyFile(file, input)
    const after = await stat(file)
    if (after.mtimeMs !== before.mtimeMs || after.size !== before.size) {
      throw new RenderError('failed', '文件正在被改写，稍后再预览。')
    }
    const profile = cacheDir('profile')
    // 用户配置目录是这一队独占的（一次只跑一个，见上面）。上一次被超时杀掉的话会留下
    // 一把 .lock，不清的话下一次 soffice 以为有人在用，直接退出、什么都不产出。
    await rm(join(profile, '.lock'), { force: true })
    await harden(profile)
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

/** 配置目录里没有加固项（第一次用，或者是这版之前建的）就整份写进去。 */
async function harden(profile: string) {
  const file = join(profile, 'user', 'registrymodifications.xcu')
  const now = await readFile(file, 'utf8').catch(() => '')
  if (now.includes(HARDENING_MARK)) return
  await mkdir(join(profile, 'user'), { recursive: true })
  await writeFile(file, HARDENING)
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
    const limit = renderTimeoutMs()
    let timedOut = false
    let settled = false
    let grace: ReturnType<typeof setTimeout> | undefined
    /**
     * 只结一次账。`close`、`exit` 之后的宽限、超时之后的宽限，三条路谁先到都算；
     * 结账时把 stderr 拆掉，攥着它的那个后代就不会让这个 child 对象一直挂着。
     */
    const settle = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(grace)
      child.stderr?.destroy()
      if (timedOut) return reject(new RenderError('failed', `渲染超时（${Math.round(limit / 1000)} 秒）。`))
      if (code !== 0) {
        const tail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300)
        return reject(new RenderError('failed', `LibreOffice 退出码 ${code}${tail ? `：${tail}` : ''}`))
      }
      resolve()
    }
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (group && child.pid) process.kill(-child.pid, 'SIGKILL')
        // Windows 没有进程组：soffice.exe 也只是个启动器，干活的 soffice.bin 要连树一起杀。
        // taskkill 起不来是异步的 'error' 事件，外面这层 try 接不住，不挂监听会把整个进程带走。
        else if (child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill('SIGKILL'))
        } else child.kill('SIGKILL')
      } catch {}
      // 杀完连 exit 都等不来（杀不到的后代、平台差异），也不能让这一队永远等下去。
      grace = setTimeout(() => settle(null), PIPE_GRACE_MS)
    }, limit)
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(grace)
      reject(new RenderError('failed', `LibreOffice 起不来：${e.message}`))
    })
    child.on('exit', (code) => {
      clearTimeout(grace)
      grace = setTimeout(() => settle(code), PIPE_GRACE_MS)
    })
    child.on('close', (code) => settle(code))
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
