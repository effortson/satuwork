import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, readdirSync, readFileSync, renameSync, type WriteStream } from 'node:fs'
import { mkdir, open, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { StringDecoder } from 'node:string_decoder'
import { childEnv, humanSize, safeName } from '../workspace/index.ts'
import { satuworkHome } from '../home.ts'
import { fail, registerTool, SKIPPED_DIRS, walkFiles, type WalkBudget } from './common.ts'
import type { ReassignedItem, ToolCall, WorkspaceFile } from './index.ts'

/**
 * terminal 工具集：`terminal` 跑命令，`process` 管它起在后台的那些。
 *
 * 看文件、改文件、找文件那四把在 tools/file.ts（file 工具集）。
 *
 * **根目录**：`$SATUWORK_WORK_DIR`——部署时注入的 `/home/{linuxUser}/work`。没有这个
 * 变量（本地跑）时回落 `$SATUWORK_HOME/work`。**不用 `$SATUWORK_HOME`**：那底下是会话
 * 日志和 SQLite，让模型的手伸进自己的记忆里，一条 `rm -rf` 就能把历史抹了。
 *
 * 但要把话说清楚：**这不是沙箱**。`terminal` 拿到的是一个真 shell，它 `cd /` 就出去了，
 * 符号链接也能指到外面。路径检查挡的是「模型手滑写错路径」，不是「模型想跑出去」。
 * 真正的边界在操作系统那层——专用系统用户、systemd 的 ProtectSystem/ReadWritePaths、
 * 或者容器；策略性的拦截（审批、白名单）挂 `tools/pre-execute` 的 waterfall，那里
 * 短路才是强制执行。别指望这里的 resolve() 顶那两层的用。
 */
export const name = 'satu-tools-terminal'
export const inject = ['tools', 'workspace']

export interface Config {
  /** 默认超时（**秒**）。 */
  timeout?: number
}

/** 喂回模型的输出上限。超出的部分落盘（见 OUT_DIR），不是丢掉。 */
const MAX_OUTPUT_CHARS = 30_000
const DEFAULT_TIMEOUT = 120
const MAX_TIMEOUT = 600

/**
 * 前台命令输出超限时，全文落在哪儿。
 *
 * **必须落在工作区里**，模型才读得到（`$SATUWORK_HOME` 底下它够不着）。放在一个点开头
 * 的目录里，`search_files` 默认跳过它——那是过程痕迹，不是员工的文件，不该混进列目录
 * 的那一屏，也不进 `files` / `refs`（界面上那一排药丸是「Bot 产出了什么」）。
 */
const OUT_DIR = '.satuwork/out'
/** 落盘的输出留几天。不清的话，一年之后工作区里躺着几千个没人看的 .log。 */
const OUT_TTL_MS = 3 * 24 * 3600_000

/* ── 命令产出了什么 ────────────────────────────────────────────────────
   `write_file` / `patch` 报得出自己写了哪个文件，`terminal` 报不出——它拿到的是一条
   shell 命令，写没写文件只有文件系统知道。而模型**照样会用它造东西**：跑一个生成
   报表的脚本、`curl -O` 下一个附件、`ffmpeg` 转一段音频。这些产出以前一个都不进
   `ToolResult.files`，于是界面上没有药丸、点不开预览，模型只能在正文里写一句
   「文件在工作区根目录，双击打开」——而用户手上根本没有那台机器的文件管理器。

   所以命令跑完扫一遍工作区，按 mtime 认出这一条命令期间落地的文件。**扫描是唯一
   不靠猜的一环**：解析命令行去猜重定向目标（`> a.html`、`-o b.pdf`）措辞一改就散架，
   那正是 `files` 那个字段当初存在的理由。 */

/**
 * 别的工具的地盘。**在产出扫描里跳掉，和 SKIPPED_DIRS 一起。**
 *
 * 这三层目录里的文件都有自己的报出口：`uploads/` 是用户从对话里传上来的附件（界面上
 * 早就挂在那条用户消息底下了），`web/` 是 `web_extract(save=true)` 落的原文，`browser/`
 * 是浏览器工具的下载与过程截图——三把工具各自把它们报进了自己那次调用的 `files`。
 *
 * 不跳掉的话，一条 `sleep 20` 期间用户传了张发票，那张发票就会挂到 `sleep` 那颗药丸
 * 底下，而且跟着 `details.files` 进会话日志，重放一次错一次。
 *
 * **只在工作区第一层跳。** 底下某个项目里叫 `web` 的目录是员工自己的东西，照扫。
 */
const FOREIGN_DIRS = new Set(['uploads', 'web', 'browser'])

/**
 * 改动数超过这个就一个都不报，并且**明说**。
 *
 * `pnpm install`、`git checkout`、一次构建，动辄改上百个文件——那是**过程**，不是
 * 「Bot 产出了什么」，逐个摆出来会把真正的产出埋掉。但闷声不报也不行：一条真的生成了
 * 三十份文件的命令，界面上一颗药丸都没有，和「这次什么都没产出」长得一模一样。所以
 * 超限时往结果文本里加一句，让模型知道自己该开口说。
 */
const BULK_CHANGES = 24
/**
 * 扫描的遍历预算。
 *
 * 比 `search_files` 的两万小得多：那一把是模型点名要找东西，这一条是每次跑命令都白扫
 * 一遍。`SKIPPED_DIRS` 已经把 node_modules / .git / dist 挡在外面，剩下的量级是员工
 * 真正的文件，几千个到顶。
 */
const OUT_WALK_BUDGET = 4000
/**
 * 扫描的时间闸。
 *
 * 预算按**文件数**卡，可真正会卡住的是慢盘和网络挂载：四千次 stat 在本地盘上是几十
 * 毫秒，在一个 NFS 上能是几秒——而这几秒加在**每一条命令**后面，包括那些什么都没写的。
 * 到点就收手，宁可这一次不报。
 */
const OUT_SCAN_MS = 400
/** stat 一批发多少个。串行发四千次是四千个来回；成批交给 libuv 的线程池快一个量级。 */
const OUT_STAT_BATCH = 64

/** 产出扫描的结果。`partial` 是「这一趟没看全」，`bulk` 是「改动太多，一个都不报」。 */
interface Produced {
  files: string[]
  bulk: boolean
  partial: boolean
}

/**
 * 哨兵最多重写几次，等文件系统的钟往前走一格。每次之间歇一毫秒。
 *
 * 十六次是给「钟停了」留的兜底，不是常态：ext4 / APFS 上第一次重写就变大，Debian 那种
 * 一个 tick 4ms 的 coarse 时钟也就四五次。走不动就回落，不在这儿死等。
 */
const MARK_SPINS = 16

/**
 * 产出扫描的时间地板：**问文件系统的钟，别问 `Date.now()`。**
 *
 * 判据比的是 `mtimeMs`——文件系统写下的那个时间。地板要是取自 `Date.now()`，两个钟就
 * 得对得上，而它们对不上，两个方向各错一次：
 *
 * - `Date.now()` 向下取整到毫秒，`mtimeMs` 带小数，同一毫秒里前者恒小于后者。窗口于是
 *   往回张开将近一毫秒，把**上一条命令**刚写下的文件算成这一条的产出（探针连着跑六十
 *   轮，泄漏三十二轮）。
 * - Linux 的文件时间戳取自 coarse 时钟，一个 tick 才更新一次（Debian 上 4ms），
 *   `mtimeMs` 可以比真正的写入时刻**早**好几毫秒——这一条命令头几毫秒里真写下的文件，
 *   盖上的是一个比起点还早的戳。
 *
 * 起点往后挪一格能挡住第一种，挡不住第二种，而且正是拿第二种换来的。哨兵两种都不用管：
 * 它的 mtime 就是文件系统自己说的「此刻」，和被扫的那些文件出自同一个钟——工作区挂在
 * NFS 上、时间戳来自服务器时也照样成立。
 *
 * **要等到这个钟真的往前走一格。** 只写一次的话，上一条命令的文件可能和哨兵同处一个
 * tick，`>=` 判据下照旧漏进来。写到 mtime 严格变大为止，地板就严格大于此前所有文件的
 * mtime，而这条命令之后写下的一律不小于它——两头都不含糊，也不必牺牲头一毫秒。
 *
 * 哨兵落在 `.satuwork/` 底下（在 `SKIPPED_DIRS` 里，而且第一层就跳点开头的条目），扫描
 * 看不见它；用完就删。**写不进去不算故障**：回落到 `Date.now() + 1`，宁可少报一颗药丸，
 * 也不为一个哨兵让命令跑不成。
 */
async function scanFloor(root: string): Promise<number> {
  const dir = join(root, '.satuwork')
  const mark = join(dir, `mark-${randomBytes(6).toString('hex')}`)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(mark, '')
    const t0 = (await stat(mark)).mtimeMs
    for (let i = 0; i < MARK_SPINS; i++) {
      await writeFile(mark, '')
      const at = (await stat(mark)).mtimeMs
      if (at > t0) return at
      await new Promise((r) => setTimeout(r, 1))
    }
    // 十几毫秒里这个钟一格没动过。不该发生，真发生了就按「宁可少报」那一边取整。
    return t0 + 1
  } catch {
    return Date.now() + 1
  } finally {
    await unlink(mark).catch(() => {})
  }
}

/**
 * 这条命令跑的这段时间里，工作区里哪些文件是新的或者被改过的。
 *
 * 判据是 mtime ≥ 命令起跑的时刻。起点在 `spawn` 之前取，而且**取自文件系统自己的钟**
 * ——落一个哨兵文件、拿它的 mtime 当地板，见 `scanFloor`。
 *
 * **这不是一条能做到精确的判据，做不到的那部分要说清楚。** 文件系统只回答「这个文件
 * 什么时候被改的」，不回答「谁改的」。同一个工作区在这段时间里还可能有别的写入方：
 * 上一条 `background=true` 起的进程、同一个员工另一个席位上的 Bot（`/home/{用户}/work`
 * 是共用的）。`FOREIGN_DIRS` 把**成系统的**那几个写入方（用户上传、网页抓取、浏览器
 * 下载）整个排除掉了，剩下的两种在这一层拿不到任何信号——真要分得清，得是 fanotify /
 * ptrace 那个层面的东西，不是一次 stat 能给的。
 *
 * **任何一步出错都当没扫到**：少一排药丸是遗憾，让一次正常的命令因为扫描失败而报错不是。
 */
async function producedSince(root: string, since: number): Promise<Produced> {
  const none: Produced = { files: [], bulk: false, partial: false }
  const budget: WalkBudget = { left: OUT_WALK_BUDGET }
  const deadline = Date.now() + OUT_SCAN_MS
  const cands: string[] = []
  try {
    /**
     * 第一层自己走，因为 `FOREIGN_DIRS` 只在这一层生效——而且要在**下去之前**拦掉：
     * `uploads/` 底下可能有几百个附件，扫完再扔等于白扫。
     */
    for (const entry of await readdir(root, { withFileTypes: true })) {
      // 这一层也要认预算和表。**`walkFiles` 只管它自己那棵子树**——根底下直接躺着五千
      // 个文件时，不在这儿拦就一个都拦不住，四千那道闸等于没写。
      if (budget.left <= 0 || Date.now() > deadline) {
        budget.truncated = true
        break
      }
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const full = join(root, entry.name)
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name) || FOREIGN_DIRS.has(entry.name)) continue
        for await (const file of walkFiles(full, budget, false)) cands.push(file)
      } else if (entry.isFile()) {
        budget.left -= 1
        cands.push(full)
      }
    }
  } catch {
    return none
  }

  const hits: { path: string; at: number }[] = []
  // 成批 stat。串行 await 一次一个来回，四千个文件在慢盘上就是实打实的几秒。
  for (let i = 0; i < cands.length; i += OUT_STAT_BATCH) {
    const chunk = cands.slice(i, i + OUT_STAT_BATCH)
    const infos = await Promise.all(chunk.map((f) => stat(f).catch(() => null)))
    for (let j = 0; j < chunk.length; j++) {
      const info = infos[j]
      if (!info || info.mtimeMs < since) continue
      hits.push({ path: chunk[j], at: info.mtimeMs })
    }
    // 一批一批地看表：**批内不看**，否则一次 stat 的抖动就能把整趟扫描判掉。
    if (hits.length > BULK_CHANGES) return { files: [], bulk: true, partial: false }
    if (Date.now() > deadline) return { files: [], bulk: false, partial: true }
  }
  /**
   * 走不完就不报。
   *
   * 判据是 `budget.truncated`（还有下一个条目要看却看不了），不是 `left <= 0`——正好
   * 走满预算的那一趟是**完整**的，按后者判会把一份好结果丢掉（见 WalkBudget 那段）。
   */
  if (budget.truncated) return { files: [], bulk: false, partial: true }
  hits.sort((a, b) => b.at - a.at)
  return { files: hits.map((h) => h.path), bulk: false, partial: false }
}

/**
 * 「工作区太大，产出扫不动」只说一次。
 *
 * 说一次是为了让运维看得见——这个功能在这台席位上是**关着**的，而它关得悄无声息，
 * 界面上和「这条命令确实没产出」一模一样。每条命令都喊一遍就成了刷屏，谁也不会读。
 */
let warnedPartial = false

// ── 后台进程 ────────────────────────────────────────────────────────────

/**
 * 一条会话同时最多几个后台进程。
 *
 * 满了就拒，并且**把当前这份清单摆出来**——让模型看见是自己起了八个服务器，而不是
 * 收到一句没有出路的失败。
 */
const MAX_PROCS = 8
/** 单个后台进程最长活多久。忘掉的 `pnpm dev` 不能占着端口过周末。 */
const MAX_LIFETIME_MS = 24 * 3600_000
/**
 * 退出之后记录还留多久。
 *
 * `poll` 得到「已退出，退出码 N」要有一段窗口期——进程一没就查无此事的话，模型只能
 * 从「没有这个进程」里去猜它是跑完了还是从来没起来。
 */
const KEEP_AFTER_EXIT_MS = 30 * 60_000
/**
 * 盘上的后台进程日志留几天。
 *
 * 上面那个 30 分钟只管**干净退出**的那条路。进程被换版杀掉时定时器跟着内存一起没，
 * 日志就成了没主人的文件——这一条是它们唯一的出口（见 apply 里那段开机清扫）。
 */
const PROC_LOG_TTL_MS = 3 * 24 * 3600_000
/** 内存里留多少尾巴给 `poll`。全文在磁盘上，`log` 从那儿翻。 */
const MAX_TAIL_CHARS = 256 * 1024
/** `log` 不给 offset 时给最后多少行。 */
const LOG_TAIL_LINES = 200
/** 通知里带最后几行。不带的话模型的下一步一定是 `process(action='log')`，白花一步。 */
const NOTIFY_TAIL_LINES = 20
/**
 * 一段日志写到多大就滚一次：当前这段改名成 `<id>.log.1`（顶掉更早的那段），再开一段新的。
 *
 * 盘上于是最多两段。以前是只增不减：一个刷屏的 `pnpm dev` 跑满 24 小时能把盘写满，
 * 而人要看的几乎总是最近那一截。
 */
const LOG_SEGMENT_BYTES = 8 * 1024 * 1024
/**
 * 写流里积压超过这么多就丢，不再往里塞。
 *
 * 盘慢（或者满了在重试）时 `write` 不会失败，只会把数据攒在 WriteStream 的缓冲里——
 * 不设上限的话积压全在内存里涨。丢掉的量记下来，等缓冲下去了在日志里补一句。
 */
const MAX_LOG_PENDING = 2 * 1024 * 1024

/**
 * 当下生效的积压上限。`SATUWORK_LOG_MAX_PENDING` 只给测试用：滚段那条 e2e 一口气吐 20 MB，
 * CI 的盘慢一点就会触发上面的丢弃，丢掉的几千行不进行号，断言「共 200000 行」就时过时不过
 * ——那条测的是滚段和行号，不是丢弃，得把这道闸挪开。每次现读：探针 import 这个模块早于它
 * 设环境变量。
 */
function maxLogPending(): number {
  const n = Number(process.env.SATUWORK_LOG_MAX_PENDING)
  return Number.isFinite(n) && n > 0 ? n : MAX_LOG_PENDING
}
/** `log` 读回来时一行最多多少字符。进度条那种几 MB 不换行的输出，整行摆回去只会冲掉上下文。 */
const MAX_LOG_LINE_CHARS = 2000
/** 读日志一次从盘上拿多少字节。 */
const LOG_READ_CHUNK = 1024 * 1024

interface Proc {
  id: string
  sessionId: string
  command: string
  workdir: string
  startedAt: number
  endedAt?: number
  code: number | null
  signal: NodeJS.Signals | null
  child: ChildProcess
  log: WriteStream
  logPath: string
  /** 当前这段写了多少字节、多少个换行；`.1` 那段有多少个换行；滚掉的段里一共多少个换行。 */
  segBytes: number
  segLines: number
  prevLines: number
  goneLines: number
  /** 因为写流积压而丢掉、还没在日志里交代的字节数。 */
  logDropped: number
  /** 内存里的尾巴，以及它在整条输出流里的起点——`poll` 靠这两个算「上次之后的新输出」。 */
  tail: string
  tailFrom: number
  bytes: number
  /** `poll` 上次看到哪儿（整条流的绝对偏移）。 */
  cursor: number
  notify: boolean
  /** 被谁杀的。`undefined` = 自己跑完的。 */
  killedBy?: 'model' | 'ttl' | 'shutdown'
  waiters: (() => void)[]
  timers: NodeJS.Timeout[]
}

/**
 * 杀完之后最多再等多久输出管道自己关上。过了这个点就把我们这一头的管道拆掉。
 *
 * 两秒：进程组里的进程吃了 SIGKILL，管道在几毫秒内就会关；还没关，说明拿着写端的
 * 是一个逃出了进程组的后代（见 killTree），它不会再自己关了。
 */
const PIPE_GRACE_MS = 2_000

/**
 * 这个进程的所有后代 pid（只在 Linux 上走得通，读 /proc）。
 *
 * `setsid foo &` 出来的那个换了会话、也换了进程组，`kill(-pgid)` 够不着它；但在 shell
 * 还活着的时候，它的 ppid 还指着这条链，顺着 ppid 找得到。shell 已经退了的话它被过继
 * 给了 init，这条路就找不回来了——那种由 taggedPids 按标签补上。
 */
function descendantsOf(root: number): number[] {
  if (process.platform !== 'linux') return []
  const children = new Map<number, number[]>()
  try {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      try {
        // stat 的第二格是带括号的进程名，里面可以有空格和括号，从最后一个 `)` 往后切。
        const raw = readFileSync(`/proc/${name}/stat`, 'utf8')
        const ppid = Number(raw.slice(raw.lastIndexOf(')') + 2).split(' ')[1])
        const list = children.get(ppid) ?? []
        list.push(Number(name))
        children.set(ppid, list)
      } catch {
        /* 进程在读的这一瞬间没了 */
      }
    }
  } catch {
    return []
  }
  const out: number[] = []
  const queue = [root]
  while (queue.length) {
    for (const pid of children.get(queue.shift()!) ?? []) {
      out.push(pid)
      queue.push(pid)
    }
  }
  return out
}

/**
 * 每条命令一个随机标签，放进它的环境（`SATUWORK_RUN=<tag>`）。环境会被每一代子孙继承，
 * `setsid` 也换不掉它——所以 shell 退了、后代被过继给 init、顺着 ppid 已经找不回来的时候，
 * 还能按标签把它们认出来（见 taggedPids）。
 *
 * 不是边界：进程自己 `env -i` 或 `unset SATUWORK_RUN` 就能躲过去。它补的是「模型顺手写了
 * 一句 `setsid foo &`」这种常见的漏网，不是故意藏起来的进程。
 */
export const RUN_TAG = 'SATUWORK_RUN'
const runTags = new WeakMap<ChildProcess, string>()

/**
 * 登记一个别处起的子进程的标签，让 `killTree` 也能按标签把它的后代找全。
 *
 * 给 desktop_terminal 用：窗口里那条命令同样可能 `setsid foo &`，窗口进程自己退了之后
 * 顺着 ppid 就找不回来了。
 */
export function tagChild(child: ChildProcess, tag: string): void {
  runTags.set(child, tag)
}

/**
 * 环境里带着这个标签的所有进程（只在 Linux 上走得通）。
 *
 * `/proc/<pid>/environ` 只有同一个用户（或 root）读得到，别人的进程读不出来、自然也不会
 * 被误杀。读到的是进程**启动时**的环境，正是要的那一份：子孙是带着它 exec 起来的。
 */
function taggedPids(tag: string): number[] {
  if (process.platform !== 'linux') return []
  const needle = Buffer.from(`\0${RUN_TAG}=${tag}\0`)
  const first = Buffer.from(`${RUN_TAG}=${tag}\0`)
  const out: number[] = []
  let names: string[]
  try {
    names = readdirSync('/proc')
  } catch {
    return []
  }
  for (const name of names) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue
    try {
      const env = readFileSync(`/proc/${name}/environ`)
      if (env.includes(needle) || env.subarray(0, first.length).equals(first)) out.push(Number(name))
    } catch {
      /* 别人的进程读不了，或者在读的这一瞬间没了 */
    }
  }
  return out
}

/**
 * 杀整个进程组。只杀 shell 的话，它 fork 出去的会留下来，端口和 CPU 一起占着。
 *
 * **杀完还要保证 `close` 一定会来。** 前台那次调用、后台的 finish 都挂在 `close` 上，
 * 而 `close` 要等 stdout/stderr 两条管道都关——管道的写端是会被继承的。模型写一句
 * `setsid some-server &`，那个后代换了会话，`kill(-pgid)` 杀不到它，它手里攥着管道，
 * `close` 永远不来：超时、停止按钮都停不下这次调用，这一轮一直挂着、isRunning 一直是真。
 * 所以进程本身退出（`exit`）之后再等一小会儿，管道还开着就把我们这一头拆掉——
 * 拆掉之后 Node 照常发 `close`，带的还是真实的退出码和信号。
 */
export function killTree(child: ChildProcess) {
  const pid = child.pid
  if (pid) {
    // 顺着 ppid 找（shell 还活着时找得全），再按标签补一遍（shell 已经退了、后代被过继走的）。
    const tag = runTags.get(child)
    const doomed = new Set([...descendantsOf(pid), ...(tag ? taggedPids(tag) : [])])
    doomed.delete(pid)
    for (const d of doomed) {
      try {
        process.kill(d, 'SIGKILL')
      } catch {
        /* 已经没了 */
      }
    }
  }
  try {
    process.kill(-pid!, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
  const release = () => {
    const t = setTimeout(() => {
      child.stdout?.destroy()
      child.stderr?.destroy()
    }, PIPE_GRACE_MS)
    t.unref?.()
    child.once('close', () => clearTimeout(t))
  }
  // shell 可能早就退了（`foo &` 之后 bash 马上结束，只剩后代攥着管道）：那时 exit 不会再来。
  if (child.exitCode !== null || child.signalCode !== null) release()
  else child.once('exit', release)
}

function lastLines(text: string, n: number): string {
  const lines = text.replace(/\s+$/, '').split('\n')
  return lines.slice(-n).join('\n')
}

function since(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}

/**
 * Bot 自己带的那批 node 库（exceljs / docx / pptxgenjs / jszip）。
 *
 * 模型新建 Word / PPT / Excel 的办法是在 terminal 里写一段 .cjs 脚本 require 它们
 * （见 tools/office.ts）。席位上的包是 `pnpm deploy` 出来的，这些库就在 app/node_modules
 * 里；给 NODE_PATH 指过去，脚本放在工作区哪儿都 require 得到，不用每次 npm install。
 *
 * **追加，不覆盖**：人自己的 NODE_PATH 排在前面。NODE_PATH 只是 require 找不到时的
 * 最后一站，工作区里自己装过依赖的项目照旧用它自己的那份。只对 CommonJS 生效（ESM 的
 * import 不认 NODE_PATH），所以说明里一律让写 .cjs。
 */
const BOT_MODULES = fileURLToPath(new URL('../../node_modules', import.meta.url))

/**
 * 跑 Bot 的这个 node 所在的目录，**接在** PATH 最后。
 *
 * 桌面端的本地 Bot 用的是壳子里带的 node，那台电脑上未必另装了 node；不接上的话，
 * 模型写好的脚本 `node x.cjs` 一句 command not found。接在最后：机器上本来有 node 的，
 * 照旧用它自己的那个。
 */
function scriptEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const join2 = (a: string | undefined, b: string) => (a ? `${a}${delimiter}${b}` : b)
  return { ...env, NODE_PATH: join2(env.NODE_PATH, BOT_MODULES), PATH: join2(env.PATH, dirname(process.execPath)) }
}

/**
 * detached：拿到自己的进程组。否则超时只杀得掉 bash，它 fork 出去的
 * （`npm run dev &`、管道里的子进程）会活下来。
 */
function spawnShell(command: string, cwd: string): ChildProcess {
  const tag = randomBytes(9).toString('base64url')
  const child = spawn('bash', ['-c', command], {
    cwd,
    // 不递整份 process.env：里面有 Gateway 凭据和 SATUWORK_* 内部配置，见 childEnv。
    // 唯一加回去的 SATUWORK_* 是这条命令的标签：一串随机字，不是配置（见 RUN_TAG）。
    env: { ...scriptEnv(childEnv()), [RUN_TAG]: tag },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  runTags.set(child, tag)
  return child
}

/**
 * 把子进程的两条输出流接到一个回调上，**每条流各自一个 UTF-8 解码器**。
 *
 * 不能对每个 chunk 单独 `buf.toString('utf8')`：一个汉字三个字节，而 chunk 的边界落在
 * 哪儿只看内核什么时候把数据递上来。切在字符中间时两半各自解码，出来的是两个 `�`——
 * 前台那次调用最多是屏幕上花一下，后台那份还会**落进 proc/<id>.log**，原字节再也捞不
 * 回来。这个产品的命令输出以中文为主，这不是边角情况。
 *
 * 回调拿到解码后的文本和这一块的**字节数**（截断判据看的是字节，不是字符）。
 */
function countNewlines(text: string): number {
  let n = 0
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++
  return n
}

/**
 * 把几段日志当成一整条流按行读，只留要的那几行。
 *
 * 以前是整份 `readFile` 再 `split`：几百 MB 的日志一次摆进内存，大到超过字符串上限时
 * 直接 ERR_STRING_TOO_LONG。现在按块扫、一行最多留 MAX_LOG_LINE_CHARS 个字符，内存里
 * 只有这一页。`from` 给了就取 `[from, from+cap)`，没给就取最后 `cap` 行（从 1 数）。
 * 末尾换行之后那个空行不算一行。一段都读不到时返回 undefined。
 */
async function readLogLines(paths: string[], from: number | undefined, cap: number) {
  const picked: { no: number; text: string }[] = []
  let line = 1
  let parts: Buffer[] = []
  let kept = 0
  /** 当前这一行一共多少字节（不管留没留）——判「末尾是不是空行」要看它。 */
  let cur = 0
  let long = false
  let any = false
  const keep = (no: number) => (from === undefined ? true : no >= from && no < from + cap)
  const finish = () => {
    if (keep(line)) {
      let text = Buffer.concat(parts).toString('utf8')
      if (long || text.length > MAX_LOG_LINE_CHARS) text = `${text.slice(0, MAX_LOG_LINE_CHARS)}…（这一行太长，截断了）`
      picked.push({ no: line, text })
      if (from === undefined && picked.length > cap + 1) picked.shift()
    }
    parts = []
    kept = 0
    cur = 0
    long = false
  }
  const buf = Buffer.alloc(LOG_READ_CHUNK)
  for (const path of paths) {
    const fh = await open(path, 'r').catch(() => undefined)
    if (!fh) continue
    any = true
    try {
      for (;;) {
        const { bytesRead: n } = await fh.read(buf, 0, buf.length, null)
        if (!n) break
        let pos = 0
        while (pos < n) {
          const nl = buf.indexOf(10, pos)
          const stop = nl === -1 || nl >= n ? n : nl
          cur += stop - pos
          if (keep(line)) {
            const room = MAX_LOG_LINE_CHARS * 4 - kept
            if (stop - pos > room) long = true
            if (room > 0) {
              const slice = Buffer.from(buf.subarray(pos, Math.min(stop, pos + room)))
              parts.push(slice)
              kept += slice.length
            }
          }
          if (stop === n) break
          finish()
          line++
          pos = stop + 1
        }
      }
    } finally {
      await fh.close()
    }
  }
  if (!any) return undefined
  // 最后一行没有换行收尾；是空的就是末尾换行之后那一个，不算。
  const lastEmpty = !cur
  finish()
  let total = line
  if (lastEmpty) {
    total--
    if (picked.length && picked[picked.length - 1].no === line) picked.pop()
  }
  if (from === undefined && picked.length > cap) picked.shift()
  return { picked, total }
}

function pipeInto(child: ChildProcess, onText: (text: string, bytes: number) => void) {
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue
    const decoder = new StringDecoder('utf8')
    stream.on('data', (buf: Buffer) => onText(decoder.write(buf), buf.length))
    // 流结束时把解码器里剩的半个字符吐出来，否则末尾那个字会凭空消失。
    stream.on('end', () => {
      const rest = decoder.end()
      if (rest) onText(rest, 0)
    })
  }
}

/**
 * 跑一条前台命令。永远 resolve；退出码非零是业务结果，由调用方写进文本。
 *
 * `abort` 是这一轮的中止信号（界面上那颗停止按钮）。**必须在这里响应**：不接的话，
 * 一条跑十分钟的命令按了停止也停不下来，而那正是人最想停它的时候。
 */
function runForeground(command: string, cwd: string, timeoutMs: number, abort?: AbortSignal) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string; full: string; bytes: number; timedOut: boolean; aborted: boolean; error?: string }>(
    (done) => {
      const child = spawnShell(command, cwd)
      let out = ''
      let full = ''
      let bytes = 0
      let timedOut = false
      let aborted = false
      const collect = (text: string) => {
        if (out.length < MAX_OUTPUT_CHARS) out += text
        // 全文另收一份，超限时落盘给模型自己翻。**不无限收**：一条疯掉的命令能吐几个
        // GB，而那时该做的是让它撞上限，不是把席位的内存吃光。
        if (full.length < MAX_OUTPUT_CHARS * 100) full += text
      }
      // 每条流一个解码器（见 pipeInto）。
      pipeInto(child, (text, n) => {
        bytes += n
        collect(text)
      })
      const timer = setTimeout(() => {
        timedOut = true
        killTree(child)
      }, timeoutMs)
      const onAbort = () => {
        aborted = true
        killTree(child)
      }
      // 已经是 aborted 的信号不会再发事件——那种情况要当场杀，否则这条命令会在一个
      // 早就被喊停的轮次里安安静静跑满十分钟。
      if (abort) {
        if (abort.aborted) onAbort()
        else abort.addEventListener('abort', onAbort, { once: true })
      }
      const settle = (r: { code: number | null; signal: NodeJS.Signals | null; error?: string }) => {
        clearTimeout(timer)
        abort?.removeEventListener('abort', onAbort)
        done({ ...r, out, full, bytes, timedOut, aborted })
      }
      child.on('error', (e) => settle({ code: null, signal: null, error: e.message }))
      child.on('close', (code, signal) => settle({ code, signal }))
    },
  )
}

export function apply(ctx: Context, config: Config = {}) {
  // 本地 Bot 的文件工具受 workspace.resolve() 约束；真 shell 可以 `cd /` 绕过它。
  // 在 OS 沙箱与“跨目录批准”代理完成前，本地模式不注册 terminal/process。
  if ((process.env.SATUWORK_RUNTIME_KIND || '').trim() === 'local') {
    ctx.logger?.info?.('terminal: 本地 Bot 已禁用 shell，只开放受工作区约束的文件工具')
    return
  }
  const resolveIn = (path?: string) => ctx.workspace.resolve(path)
  const show = (path: string) => ctx.workspace.show(path)
  const defaultTimeout = Math.min(Math.max(1, Math.trunc(config.timeout || DEFAULT_TIMEOUT)), MAX_TIMEOUT)

  /** 后台进程注册表。只在内存里——进程被换掉时它们本来也要一起没（见下面的 killAll）。 */
  const procs = new Map<string, Proc>()

  /**
   * 把一条会话名下**还活着**的后台进程改挂到另一条。子代理收口时由 ToolService 调
   * （见 tools/index.ts 的 reassign，以及 docs/delegation.md §7.3）。
   *
   * **只动记账那一行，不碰进程本身。** 它的 cwd 在共享工作区里，换个主人不影响它在跑
   * 什么；而杀掉的话，「委派去把开发服务器起起来」这件事整个做不成——那是委派最自然的
   * 用法之一。更隐蔽的一层：杀的动作发生在结论回来之前，主代理会拿到「服务已启动」的
   * 结论，去用，发现没有。
   *
   * **已经结束的不移交**（`endedAt` 有值）：它的输出早就在子会话里了，移交过去只会让
   * 主代理的 `process` 列表里多一堆历史。
   */
  const handOver = (from: string, to: string): ReassignedItem[] => {
    const moved: ReassignedItem[] = []
    for (const p of procs.values()) {
      if (p.sessionId !== from || p.endedAt) continue
      p.sessionId = to
      moved.push({ id: p.id, label: p.command })
    }
    if (moved.length) ctx.logger?.info?.(`terminal: ${moved.length} 个后台进程从 ${from} 改挂到 ${to}`)
    return moved
  }

  /**
   * 后台进程的日志落在 `$SATUWORK_HOME/proc/`，**不在工作区**。
   *
   * 和前台那份截断全文（OUT_DIR）正相反：那一份是模型要自己 `read_file` 的，这一份
   * 由 `process(action='log')` 替它读。会话侧的运行数据不该出现在员工的共享 `~/work` 里。
   */
  const procDir = satuworkHome('proc')

  /**
   * 起来时先扫一遍 `proc/`，把过期的日志删掉。
   *
   * 不扫的话它们**只增不减**：删日志靠的是进程退出后那个三十分钟的定时器，而定时器活在
   * 内存里——席位换一次版、崩一次，正跑着的那些后台进程连同定时器一起没，日志留在盘上
   * 再也没有主人。工作区那份落盘输出（OUT_DIR）有 TTL 扫，这一份当初漏了。
   *
   * 只在启动时扫一次：这一刻注册表是空的，盘上每一个都是上一条命的遗物。
   */
  void (async () => {
    try {
      await mkdir(procDir, { recursive: true })
      const now = Date.now()
      for (const entry of await readdir(procDir).catch(() => [] as string[])) {
        const at = join(procDir, entry)
        const s = await stat(at).catch(() => undefined)
        if (s?.isFile() && now - s.mtimeMs > PROC_LOG_TTL_MS) await unlink(at).catch(() => {})
      }
    } catch (e) {
      ctx.logger?.warn?.(`terminal: 清理旧的后台进程日志失败：${(e as Error).message}`)
    }
  })()

  /**
   * 把超限的全文落进工作区，返回相对路径；写不成就返回空（那只是少一条线索，不该让
   * 整次调用失败）。顺手扫掉过期的。
   */
  const spill = async (callId: string, text: string): Promise<string> => {
    try {
      const dir = resolveIn(OUT_DIR)
      await mkdir(dir, { recursive: true })
      const now = Date.now()
      for (const entry of await readdir(dir).catch(() => [] as string[])) {
        const at = join(dir, entry)
        const s = await stat(at).catch(() => undefined)
        if (s && now - s.mtimeMs > OUT_TTL_MS) await unlink(at).catch(() => {})
      }
      /**
       * **callId 要洗过再拼路径。** 它是 provider 在响应里给的，一路透传到这儿，没有
       * 任何一层校验过它长什么样；带一个 `/` 就写不进去（只建了 OUT_DIR），带 `..` 就
       * 写出工作区。上传文件名和 sessionId 早就走 `safeName` / `safeSegment` 了，这条
       * 新路不该是例外。`resolveIn` 再兜一道越界检查。
       */
      const target = resolveIn(`${OUT_DIR}/${safeName(callId || String(now))}.log`)
      await writeFile(target, text, 'utf8')
      return show(target)
    } catch {
      return ''
    }
  }

  /**
   * 进程结束了要不要说一声。
   *
   * 走 `reflect.get` 而不是 inject：`agents` 那边 inject 了 `tools`，静态依赖绕回来
   * 两边都起不来（policy 够 agents 是同一条理由）。取不到就只留一行日志——通知没送到
   * 比整个进程崩掉好，模型还可以自己 `process(action='poll')`。
   *
   * **两条路**：那一轮还在跑就插话（steering 在工具跑到一半时也插得进），已经结束就
   * 开新的一轮。两种都落成一条 `user/message`——不变量 7，进入模型的那句话必须在
   * JSONL 里，重放才对得上。
   */
  const notifyExit = async (p: Proc) => {
    const text = exitNotice(p)
    try {
      const agents = (ctx as unknown as { reflect?: { get?: (n: string) => unknown } }).reflect?.get?.('agents') as
        | {
            isRunning?: (id: string) => boolean
            rootOf?: (id: string) => string | undefined
            steer?: (id: string, text: string, images: never[], source: unknown) => Promise<boolean>
            send?: (id: string, text: string, images: never[], mentions: never[], source: unknown) => Promise<void>
          }
        | undefined
      if (!agents) throw new Error('agents 服务没起来')
      const source = { kind: 'plugin', plugin: 'process' }
      /**
       * **steer 那一跳一个字都不能改。** 子代理还在跑时，进程结束的通知就该插进**它
       * 自己**那一轮——它才是起这个进程的人，它在等这个结果。改投主会话的话，主代理会
       * 收到一条关于它没起过的命令的通知，而真正在等的那个子代理什么都没等到。
       */
      if (agents.isRunning?.(p.sessionId) && (await agents.steer?.(p.sessionId, text, [], source))) return
      /**
       * 接不住了：**投给它的主人**。
       *
       * 不走 rootOf 的话，这一句会在一条没有任何人看着的子会话上 `send` 出全新的一轮
       * ——真跑、真调工具、真花钱，而产出没有任何一条路回到人手上。
       *
       * 绝大多数情况这条回退根本不会触发：子代理收口时已经把进程改挂到主会话了
       * （reassign），那时 `p.sessionId` 本来就是主会话。留着它是为了那个窄窗口——
       * 收口和移交之间，进程恰好在这几毫秒里结束。子会话没有主人时 rootOf 回落成它
       * 自己，也就是今天的行为。见 docs/delegation.md §7.3。
       */
      const to = agents.rootOf?.(p.sessionId) ?? p.sessionId
      await agents.send?.(to, text, [], [], source)
    } catch (e) {
      ctx.logger?.warn?.(`terminal: ${p.id} 的结束通知没能进会话：${(e as Error).message}`)
    }
  }

  const exitNotice = (p: Proc): string => {
    const how =
      p.killedBy === 'model'
        ? '已被终止'
        : p.killedBy === 'ttl'
          ? `活过了 ${Math.round(MAX_LIFETIME_MS / 3600_000)} 小时上限，已被终止`
          : p.code === null
            ? `被信号 ${p.signal} 终止`
            : `退出码 ${p.code}`
    const head = `[后台进程 ${p.id} 已结束] ${p.command} · ${how} · 用时 ${since((p.endedAt ?? Date.now()) - p.startedAt)}`
    const body = lastLines(p.tail, NOTIFY_TAIL_LINES)
    return body ? `${head}\n最后 ${NOTIFY_TAIL_LINES} 行输出：\n${body}` : `${head}\n（没有输出）`
  }

  const finish = (p: Proc, code: number | null, signal: NodeJS.Signals | null) => {
    if (p.endedAt) return
    p.endedAt = Date.now()
    p.code = code
    p.signal = signal
    p.log.end()
    for (const t of p.timers) clearTimeout(t)
    p.timers = []
    for (const w of p.waiters.splice(0)) w()
    // 退出之后再留一会儿：poll 得到「已退出」要有窗口期。
    const gone = setTimeout(() => {
      procs.delete(p.id)
      void unlink(p.logPath).catch(() => {})
      void unlink(`${p.logPath}.1`).catch(() => {})
    }, KEEP_AFTER_EXIT_MS)
    gone.unref?.()
    p.timers.push(gone)
    /**
     * **自己动手杀的不通知。**
     *
     * `kill` 是模型刚发起的那次调用，它已经从返回值里知道结果了。照样通知的话，那一轮
     * 要是已经收口，`agents.send` 会为此**单独开一轮**——用户看到一条没来由的「已被终止」
     * 冒出来，账上还多一次模型调用。关机同理：进程马上就没了，没有人在等这句话。
     */
    if (p.notify && p.killedBy !== 'shutdown' && p.killedBy !== 'model') void notifyExit(p)
  }

  const openLog = (p: Proc) => {
    const log = createWriteStream(p.logPath)
    // 写日志失败（盘满）不该把进程带走：少一份全文，poll 那条尾巴还在。
    log.on('error', (e) => ctx.logger?.warn?.(`terminal: ${p.id} 的日志写不下去：${e.message}`))
    return log
  }

  /**
   * 当前这段滚成 `.1`，开一段新的。
   *
   * 先改名再 end：旧流里还没落盘的那点数据跟着 fd 走，照样写进改完名的那个文件。
   * 改名失败（文件还没来得及打开）就先不滚，接着写这一段，下一次写再试。
   */
  const rotate = (p: Proc) => {
    try {
      renameSync(p.logPath, `${p.logPath}.1`)
    } catch {
      return
    }
    p.log.end()
    p.goneLines += p.prevLines
    p.prevLines = p.segLines
    p.segLines = 0
    p.segBytes = 0
    p.log = openLog(p)
  }

  const put = (p: Proc, text: string) => {
    p.log.write(text)
    p.segBytes += Buffer.byteLength(text)
    p.segLines += countNewlines(text)
    if (p.segBytes >= LOG_SEGMENT_BYTES) rotate(p)
  }

  /** 往日志里写一截输出：有上限（滚段）、有背压（积压太多就丢，丢多少记着）。 */
  const writeLog = (p: Proc, text: string) => {
    if (!text || p.log.writableEnded) return
    if (p.log.writableLength > maxLogPending()) {
      p.logDropped += Buffer.byteLength(text)
      return
    }
    if (p.logDropped) {
      const note = `\n…（这里有 ${humanSize(p.logDropped)} 输出来不及落盘，丢了；最近的输出 poll 里可能还有）\n`
      p.logDropped = 0
      put(p, note)
    }
    put(p, text)
  }

  const start = async (sessionId: string, command: string, cwd: string, notify: boolean): Promise<Proc> => {
    await mkdir(procDir, { recursive: true })
    const id = `proc_${randomBytes(4).toString('hex')}`
    const logPath = join(procDir, `${id}.log`)
    const child = spawnShell(command, cwd)
    const p: Proc = {
      id,
      sessionId,
      command,
      workdir: show(cwd),
      startedAt: Date.now(),
      code: null,
      signal: null,
      child,
      log: undefined as unknown as WriteStream,
      logPath,
      segBytes: 0,
      segLines: 0,
      prevLines: 0,
      goneLines: 0,
      logDropped: 0,
      tail: '',
      tailFrom: 0,
      bytes: 0,
      cursor: 0,
      notify,
      waiters: [],
      timers: [],
    }
    p.log = openLog(p)
    pipeInto(child, (text, n) => {
      p.bytes += n
      writeLog(p, text)
      p.tail += text
      if (p.tail.length > MAX_TAIL_CHARS) {
        const drop = p.tail.length - MAX_TAIL_CHARS
        p.tail = p.tail.slice(drop)
        p.tailFrom += drop
      }
    })
    child.on('error', (e) => {
      p.tail += `\n（启动失败：${e.message}）`
      finish(p, null, null)
    })
    child.on('close', (code, signal) => finish(p, code, signal))
    const ttl = setTimeout(() => {
      p.killedBy = 'ttl'
      killTree(child)
    }, MAX_LIFETIME_MS)
    ttl.unref?.()
    p.timers.push(ttl)
    procs.set(id, p)
    return p
  }

  /**
   * 换版和关机时把它们全杀掉。
   *
   * 管家重启这个进程之前会先让它静默、排空，但**排空只等模型那一轮跑完，管不到后台
   * 进程**。不在这里杀，换一次版就在席位上漏一批孤儿：端口占着、内存占着，而下一个
   * 版本起来时那个端口已经被占了。
   */
  const killAll = () => {
    for (const p of procs.values()) {
      if (p.endedAt) continue
      p.killedBy = 'shutdown'
      killTree(p.child)
      p.log.end()
    }
  }
  /**
   * 两道都要有：`ctx.effect` 管插件卸载，信号处理管 systemd 重启——后者走的是 SIGTERM，
   * 根本不会触发卸载。而席位换版恰恰是后者。
   *
   * **杀完必须把信号重新发给自己。** Node 的规矩是：一旦给 SIGTERM / SIGINT 装了监听器，
   * 它的默认行为（结束进程）就被摘掉了。这个进程在这之前一个信号监听器都没有，靠的正是
   * 那个默认行为退出；只在这儿挂一个不退出的监听器，`systemctl restart` 之后进程会一直
   * 活着，直到 systemd 等满 `DefaultTimeoutStopSec`（90 秒，单元里没另设）再 SIGKILL
   * ——每次换版白等一分半，排空那条路还可能直接超时。
   *
   * 摘掉自己再重发：别的监听器（探针里那些）照跑，一个都没有时就落回默认行为。
   */
  const onSignal = (sig: NodeJS.Signals) => {
    killAll()
    process.off('SIGTERM', onSignal)
    process.off('SIGINT', onSignal)
    process.kill(process.pid, sig || 'SIGTERM')
  }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)
  ctx.effect(() => () => {
    process.off('SIGTERM', onSignal)
    process.off('SIGINT', onSignal)
    killAll()
  })

  /** 按 id 或**唯一前缀**找。模型抄长 id 会抄错，而「没有这个进程」它排查不出来。 */
  const find = (sessionId: string, raw: string): Proc => {
    const key = String(raw || '').trim()
    if (!key) fail('缺少 session_id 参数。用 process(action="list") 看有哪些。')
    const mine = [...procs.values()].filter((p) => p.sessionId === sessionId)
    const exact = mine.find((p) => p.id === key)
    if (exact) return exact
    const bare = key.replace(/^proc_/, '')
    // 只剩前缀 `proc_`（或空）时不做前缀匹配：空串谁都 startsWith，只有一个进程时会
    // 「恰好」命中它，模型抄漏了 id 也就杀错了进程。当成没找到。
    if (!bare) fail(`${key} 不是一个完整的 session_id。用 process(action="list") 看有哪些。`)
    const hit = mine.filter((p) => p.id.slice('proc_'.length).startsWith(bare))
    if (hit.length === 1) return hit[0]
    if (hit.length > 1) fail(`${key} 对应 ${hit.length} 个进程（${hit.map((p) => p.id).join('、')}），写全一点。`)
    fail(`没有 ${key} 这个后台进程。用 process(action="list") 看有哪些——退出超过 ${Math.round(KEEP_AFTER_EXIT_MS / 60_000)} 分钟的会被清掉。`)
  }

  const stateOf = (p: Proc): string =>
    p.endedAt
      ? p.killedBy === 'model'
        ? '已被终止'
        : p.killedBy === 'ttl'
          ? '超过存活上限被终止'
          : p.code === null
            ? `被信号 ${p.signal} 终止`
            : `已退出（退出码 ${p.code}）`
      : `运行中（已 ${since(Date.now() - p.startedAt)}）`

  // ── terminal ─────────────────────────────────────────────────────────

  registerTool(
    ctx,
    {
      name: 'terminal',
      /**
       * `background=true` 起的进程按 sessionId 记账，而子会话一收口就没人看得见、
       * 也没人杀得掉了。收口时改挂主会话，见下面的 reassign 和 docs/delegation.md §7.3。
       */
      delegation: { retains: true },
      reassign: (from, to) => handOver(from, to),
      /**
       * **三样都占。** 一条命令能写文件、能 rm -rf、也能 curl 出去——它是这台席位上
       * 唯一一把「什么都做得到」的工具，标成只写就等于给所有边界开了条暗路。
       *
       * `background=true` 没有在这上面开口子：它仍然是 `terminal` 的一次调用，
       * `tools/pre-execute` 上那条命令扫描照常跑。
       */
      risk: ['write', 'destructive', 'external'],
      description:
        `在工作区里执行一条 shell 命令，返回标准输出与标准错误。默认工作目录是工作区根目录，默认超时 ${defaultTimeout} 秒（前台上限 ${MAX_TIMEOUT}）。` +
        '命令一跑完就立刻返回，超时设大一点不会让你多等。\n' +
        '读文件用 read_file、搜内容与找文件用 search_files、改文件用 patch 或 write_file——' +
        '不要用 cat / head / tail / grep / rg / find / ls / sed / awk / echo 重复它们，那几把工具的输出更适合阅读。' +
        'terminal 留给构建、安装、git、进程、脚本、包管理器这些真的需要 shell 的事。\n' +
        '**不要把构建或测试命令管道给 tail / head**（`pnpm build | tail -20`）：输出本来就会自动截断、超出的部分会落盘，' +
        '而管道会让退出码变成管道里最后一条命令的（tail 的 0），真失败被盖掉。`cmd || echo failed` 同理。\n' +
        '跑得久的（服务器、长构建）设 background=true，它会立刻返回一个 session_id，之后用 process 查看和终止；' +
        '有明确终点的（构建、测试、部署）再加 notify_on_complete=true，跑完会自动告诉你，不用轮询。' +
        '**不要用 nohup / setsid / 结尾 &** 自己甩到后台——那样起的进程 process 管不到。\n' +
        '后台进程**不随这一轮结束**，用户点停止也不会停掉它们，要停就调 process(action="kill")。\n' +
        '命令是非交互执行的，不要跑需要输入的程序。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令，如 "git status --short"。' },
          workdir: { type: 'string', description: '这条命令的工作目录，相对工作区根目录。默认工作区根目录。' },
          timeout: { type: 'number', description: `前台最多等多少**秒**，上限 ${MAX_TIMEOUT}。默认 ${defaultTimeout}。background=true 时无效。` },
          background: { type: 'boolean', description: '放到后台跑，立刻返回 session_id。默认 false。' },
          notify_on_complete: {
            type: 'boolean',
            description: '配合 background=true：进程结束时自动通知你，不用轮询。有明确终点的任务都该设它；永不退出的服务器不用。默认 false。',
          },
        },
        required: ['command'],
      },
    },
    async (
      {
        command,
        workdir,
        timeout,
        background,
        notify_on_complete: notifyOnComplete,
      }: {
        command?: string
        workdir?: string
        timeout?: number
        background?: boolean
        notify_on_complete?: boolean
      },
      call: ToolCall,
    ) => {
      if (!command?.trim()) fail('缺少 command 参数')
      const dir = resolveIn(workdir)
      const info = await stat(dir).catch(() => fail(`工作目录不存在：${show(dir)}`))
      if (!info.isDirectory()) fail(`${show(dir)} 不是目录。`)

      if (background) {
        const mine = [...procs.values()].filter((p) => p.sessionId === call.sessionId && !p.endedAt)
        if (mine.length >= MAX_PROCS) {
          // 拒绝要带着清单：让模型看见是自己起了八个，而不是收到一句没有出路的失败。
          const list = mine.map((p) => `  ${p.id}  ${p.command}`).join('\n')
          fail(`后台进程已经有 ${mine.length} 个（上限 ${MAX_PROCS}），先用 process(action="kill") 停掉不用的：\n${list}`)
        }
        const p = await start(call.sessionId, command, dir, notifyOnComplete === true)
        const hint = p.notify
          ? '跑完会自动告诉你。'
          : '用 process(action="poll", session_id="…") 看进展。'
        return (
          `已在后台启动：${p.id}\n命令：${command}\n工作目录：${p.workdir}\n${hint}\n` +
          '它不随这一轮结束，要停就 process(action="kill")。'
        )
      }

      const seconds = Math.max(1, Math.min(Math.floor(timeout || defaultTimeout), MAX_TIMEOUT))
      /**
       * 产出扫描的起点。**要在 spawn 之前取**：命令写下的文件 mtime 一定晚于这一刻。
       *
       * 这一刻由一个哨兵文件给出，不是 `Date.now()`——那两个钟对不上，理由在 `scanFloor`。
       */
      const startedAt = await scanFloor(resolveIn())
      const r = await runForeground(command, dir, seconds * 1000, call?.signal)
      if (r.error) fail(`无法执行：${r.error}`)

      /**
       * 这条命令落地了什么。**超时、被中止、退出码非零的也扫**——它们同样可能已经写下
       * 半个文件，而「跑到一半留下了什么」正是那几种情况下人最想看的东西。
       */
      const made = await producedSince(resolveIn(), startedAt)
      const files: WorkspaceFile[] = made.files.map((full) => ({ path: show(full), name: basename(full) }))
      if (made.partial && !warnedPartial) {
        warnedPartial = true
        ctx.logger?.warn?.(
          `terminal: 工作区文件太多（超过 ${OUT_WALK_BUDGET} 个或者扫描超过 ${OUT_SCAN_MS}ms），` +
            '命令产出的文件不再自动摆到界面上。这条只说一次。',
        )
      }
      /**
       * 改动太多的那次要**明说**。
       *
       * 一条真的生成了三十份文件的命令，界面上一颗药丸都没有，和「这次什么都没产出」
       * 在屏幕上长得一模一样。模型是这条链路上唯一还能开口的一环，所以话说给它听。
       * 走不完（`partial`）反过来**不说**：那是席位的状况，不是这条命令的结果，而它会
       * 出现在**每一条**命令后面——那就成了背景噪音。
       */
      const bulk = made.bulk ? `\n（这条命令改动了 ${BULK_CHANGES} 个以上的文件，没有逐个列出。要给用户看具体某个，自己点名。）` : ''
      // 空数组不带出去：`!r.files` 是「这次没产出」的判据，给个 [] 会让它变成真值。
      const withFiles = (text: string) => (files.length ? { text: text + bulk, files } : text + bulk)

      const body = r.out.trim() || '（没有输出）'
      let cut = ''
      if (r.bytes > Buffer.byteLength(r.out)) {
        /**
         * 截断的同时把全文落盘。
         *
         * 上面那句「不要 `| tail`」只有配上这一条才站得住：既然禁止模型自己截短输出，
         * 就得给它一条把全文捞回来的路，否则它下一步一定是再跑一遍加管道。
         */
        const at = await spill(call?.callId, r.full)
        cut = at
          ? `\n…（输出已截断，共 ${humanSize(r.bytes)}。完整输出在 ${at}，用 read_file 翻）`
          : `\n…（输出已截断，共 ${humanSize(r.bytes)}）`
      }
      // 退出码非零是**业务**结果，不是管道故障：模型要看到它并自己决定下一步。
      // 被中止要单独说：让模型知道这条命令没跑完，别拿半截输出当结论。
      if (r.aborted) return withFiles(`命令已被中止（用户点了停止）。已经产生的输出：\n${body}${cut}`)
      if (r.timedOut) {
        return withFiles(`命令超时（${seconds} 秒）已被终止。跑得久的用 background=true。\n${body}${cut}`)
      }
      if (r.code === 0) return withFiles(`${body}${cut}`)
      const how = r.code === null ? `被信号 ${r.signal} 终止` : `退出码 ${r.code}`
      return withFiles(`命令${how}。\n${body}${cut}`)
    },
  )

  // ── process ──────────────────────────────────────────────────────────

  registerTool(
    ctx,
    {
      name: 'process',
      /**
       * **不标 retains。** 留下东西的是 `terminal`，`process` 只是在管它起的那几个；
       * 两把都标的话移交会跑两遍（第二遍必然空手），而空跑一遍的代价是以后没人说得清
       * 到底是谁在移交。
       */
      delegation: {},
      /**
       * **不要审批。** 后台进程会不会干坏事，在 `terminal` 起它的那一刻就已经按同一条
       * 命令扫过一遍了；`process` 只是在管自己起的那几个。再判一次的结果是每一次 poll
       * 都弹一张卡片——那不是收紧边界，是让人学会闭眼点批准。
       */
      risk: ['write'],
      description:
        '管理 terminal(background=true) 起的后台进程。\n' +
        "list：列出这条会话的全部后台进程。poll：看状态和**上次之后的新输出**（轮询用这个）。" +
        'log：完整输出，带分页。wait：阻塞到结束或超时。kill：终止（连它 fork 出去的一起）。\n' +
        'session_id 写唯一前缀就行（`4dae` 能指到 `proc_4dae56ca`）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'poll', 'log', 'wait', 'kill'], description: '要做什么。' },
          session_id: { type: 'string', description: 'terminal 返回的那个进程 id，唯一前缀也认。除 list 外必填。' },
          timeout: { type: 'number', description: 'wait 最多阻塞多少秒。超时返回已有的输出。' },
          offset: { type: 'number', description: `log 从第几行开始（1 起）。不给就给最后 ${LOG_TAIL_LINES} 行。` },
          limit: { type: 'number', description: 'log 最多返回多少行。' },
        },
        required: ['action'],
      },
    },
    async (
      {
        action,
        session_id: sessionId,
        timeout,
        offset,
        limit,
      }: { action?: string; session_id?: string; timeout?: number; offset?: number; limit?: number },
      call: ToolCall,
    ) => {
      const mine = () => [...procs.values()].filter((p) => p.sessionId === call.sessionId)

      if (action === 'list') {
        const all = mine()
        if (!all.length) return '这条会话没有后台进程。'
        return all
          .map((p) => `${p.id}  ${stateOf(p)}\n  命令：${p.command}\n  目录：${p.workdir}`)
          .join('\n')
      }

      if (action === 'poll') {
        const p = find(call.sessionId, sessionId ?? '')
        const end = p.tailFrom + p.tail.length
        // 缓冲滚过去的那一段说清楚。悄悄跳过会让模型以为它看到了全部输出。
        const dropped = p.cursor < p.tailFrom ? p.tailFrom - p.cursor : 0
        const from = Math.max(p.cursor, p.tailFrom)
        const fresh = p.tail.slice(from - p.tailFrom)
        p.cursor = end
        const head = `${p.id}  ${stateOf(p)}`
        const skipped = dropped ? `\n（中间有 ${humanSize(dropped)} 输出滚出了缓冲，完整的用 action="log" 看）` : ''
        if (!fresh.trim()) return `${head}${skipped}\n（上次之后没有新输出）`
        return `${head}${skipped}\n新输出：\n${fresh.replace(/\s+$/, '')}`
      }

      if (action === 'log') {
        const p = find(call.sessionId, sessionId ?? '')
        const cap = Math.max(1, Math.min(Math.floor(limit || LOG_TAIL_LINES), 2000))
        /**
         * 行号是**从这个进程第一行输出数起**的：滚掉的段里有多少行记着（goneLines），
         * 盘上这两段接在它后面数。offset 指到已经滚掉的那一截时，从还留着的第一行给起。
         */
        const gone = p.goneLines
        const want = offset ? Math.max(1, Math.floor(offset)) : undefined
        const local = want === undefined ? undefined : Math.max(1, want - gone)
        const read =
          (await readLogLines([`${p.logPath}.1`, p.logPath], local, cap).catch(() => undefined)) ??
          (() => {
            const lines = p.tail.replace(/\s+$/, '').split('\n')
            const at = local ?? Math.max(1, lines.length - cap + 1)
            return { picked: lines.slice(at - 1, at - 1 + cap).map((text, i) => ({ no: at + i, text })), total: lines.length }
          })()
        const total = gone + read.total
        if (!total) return `${p.id}  ${stateOf(p)}\n（还没有输出）`
        if (!read.picked.length) return `${p.id} 一共 ${total} 行，offset ${want ?? 1} 超出了。`
        const startAt = gone + read.picked[0].no
        const lastAt = gone + read.picked[read.picked.length - 1].no
        const left = total - lastAt
        const width = String(lastAt).length
        const body = read.picked.map((l) => `${String(gone + l.no).padStart(width, ' ')}|${l.text}`).join('\n')
        const rolled =
          want !== undefined && want < startAt
            ? `\n（前 ${startAt - 1} 行已经滚掉了——日志只留最近的约 ${humanSize(LOG_SEGMENT_BYTES * 2)}，从第 ${startAt} 行给起）`
            : ''
        return (
          `${p.id}  ${stateOf(p)}  共 ${total} 行${rolled}\n${body}` +
          (left > 0 ? `\n…（还有 ${left} 行，用 offset=${lastAt + 1} 接着看）` : '')
        )
      }

      if (action === 'wait') {
        const p = find(call.sessionId, sessionId ?? '')
        if (!p.endedAt) {
          const seconds = Math.max(1, Math.min(Math.floor(timeout || 60), MAX_TIMEOUT))
          await new Promise<void>((resolve) => {
            let done = false
            const settle = () => {
              if (done) return
              done = true
              clearTimeout(timer)
              call?.signal?.removeEventListener('abort', settle)
              // 从等待队列里摘掉自己。超时和中止这两条路 finish() 永远走不到，不摘的话
              // 一个长命进程上反复 wait 会让这个数组一直涨（连着闭包一起留着）。
              const at = p.waiters.indexOf(settle)
              if (at >= 0) p.waiters.splice(at, 1)
              resolve()
            }
            const timer = setTimeout(settle, seconds * 1000)
            timer.unref?.()
            p.waiters.push(settle)
            // 停止按钮要停得掉这次等待——进程照旧在跑，那是它该有的样子。
            call?.signal?.addEventListener('abort', settle, { once: true })
          })
        }
        const tail = lastLines(p.tail, NOTIFY_TAIL_LINES)
        const head = `${p.id}  ${stateOf(p)}`
        if (!p.endedAt) return `${head}\n还没结束，等待已到时间。最后 ${NOTIFY_TAIL_LINES} 行：\n${tail}`
        return `${head}  用时 ${since(p.endedAt - p.startedAt)}\n最后 ${NOTIFY_TAIL_LINES} 行：\n${tail || '（没有输出）'}`
      }

      if (action === 'kill') {
        const p = find(call.sessionId, sessionId ?? '')
        if (p.endedAt) return `${p.id} 已经结束了（${stateOf(p)}），没有可终止的。`
        p.killedBy = 'model'
        killTree(p.child)
        return `已终止 ${p.id}（连同它 fork 出去的进程）。命令：${p.command}`
      }

      fail(`action 只能是 list / poll / log / wait / kill，收到的是 ${JSON.stringify(action)}。`)
    },
  )
}
