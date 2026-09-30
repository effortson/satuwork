import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { childEnv } from '../workspace/index.ts'
import { fail, registerTool } from './common.ts'
import { RUN_TAG, killTree, tagChild } from './terminal.ts'

/**
 * 席位桌面上的两把手：开一个终端窗口（`desktop_terminal`）、开文件管理器
 * （`desktop_open_folder`）。
 *
 * **它们不是 terminal / read_file 的替身。** 那几把在后台跑、结果回给模型；这两把是在
 * 员工正看着的 VNC 桌面上**开一扇窗**，结果留在屏幕上给人看，模型自己读不到。用户说
 * 「打开终端」「把那个文件夹打开给我看」「在桌面上跑一下让我看着」时用它们；要拿输出
 * 继续干活，照旧用 terminal。
 *
 * 桌面栈是 slim-desktop.sh 起的那一套（xfce4-terminal、thunar，deploy-seat.sh 装的），
 * Bot 进程的 DISPLAY / XAUTHORITY 来自 bot.env——Chrome 也是靠这两条连上这块屏的。
 *
 * **只在有桌面的远程席位上挂。** 本地 Bot 跑在员工自己的电脑上，没有「席位桌面」这回事，
 * 而且那边连 terminal 都没开（见 terminal.ts 的 apply）；没有 DISPLAY 的（`pnpm dev`、没
 * 部署桌面的机器）也不挂——挂上的话模型看见两把每次都失败的工具，只会一遍遍去试。
 *
 * **窗口里跑过命令的，换版和关机时连窗口带命令一起收掉**，同 terminal 的后台进程
 * （见 terminal.ts 的 killAll）：不收的话，模型在窗口里起的服务器会跨过换版活下来，占着
 * 端口，而 `process` 看不见也杀不掉它。空终端是给人用的，不碰。
 *
 * 能力开关在模版的 `desktop.on`：关掉时这两把不进工具表（agent 的 toolSchemasFor），
 * 硬报名字也会在 policy 的 pre-execute 里被拒。窗口里跑的命令和 `terminal` 走同一套
 * 拦截（policy/shell.ts 的 SHELL_TOOLS）——这把工具不是绕开高风险确认的一条暗路。
 */
export const name = 'satu-tools-desktop'
export const inject = ['tools', 'workspace']

/**
 * 起窗口之后等多久再报成功。
 *
 * 连不上屏（cookie 过期、Xvfb 没起来）、参数不认识，这两个程序都是一启动就退出；
 * 等这一小会儿能把「窗口根本没出来」当场报回去，而不是回一句「已打开」让人去屏幕上找。
 */
const EARLY_EXIT_MS = 1500

/**
 * 窗口里跑命令的那段 shell。
 *
 * 命令经环境变量传进去，不拼进参数：拼的话要过 xfce4-terminal 和 bash 两层引号，
 * 任何一层写错都是一次注入。跑完 `exec bash` 留一个交互 shell——窗口是给人的，
 * 命令一结束就关掉的话人什么都来不及看。
 */
const RUN_IN_WINDOW = [
  'c=$SATU_DESKTOP_CMD; unset SATU_DESKTOP_CMD',
  `printf '\\033[2m$ %s\\033[0m\\n' "$c"`,
  'eval "$c"',
  `printf '\\n\\033[2m[退出码 %s]\\033[0m\\n' "$?"`,
  'exec bash',
].join('\n')

/**
 * 拉起一个桌面程序，等它要么起来、要么当场退出。
 *
 * `onStart` 在 spawn 之后**立刻**调——早于那 1.5 秒：这段时间里进程已经在跑了，恰好
 * 这时候来一次换版的话，它得已经在收尾名单上。
 */
function launch(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  onStart?: (child: ChildProcess) => void,
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { detached: true, stdio: 'ignore', env, cwd })
    onStart?.(child)
    const timer = setTimeout(() => {
      child.unref()
      resolve(null)
    }, EARLY_EXIT_MS)
    child.once('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      resolve(e.code === 'ENOENT' ? `这个席位上没有 ${bin}（桌面那套没装全，重新部署一次席位）` : `${bin} 启动失败：${e.message}`)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      // 0 是正常的：thunar 发现总线上已有一个实例时，把窗口交给它、自己退出。
      resolve(code === 0 ? null : `${bin} 一启动就退出了（${code ?? signal}），多半是连不上桌面——请用户确认桌面能打开，或者重新部署席位`)
    })
  })
}

export function apply(ctx: Context) {
  if ((process.env.SATUWORK_RUNTIME_KIND || '').trim() === 'local') return
  if (!(process.env.DISPLAY || '').trim()) {
    ctx.logger?.info?.('desktop: 没有 DISPLAY，席位桌面工具不注册')
    return
  }

  /**
   * 跑过命令的窗口。**只在内存里**，同 terminal 的 procs：进程被换掉时它们本来也要一起没。
   * 窗口自己关掉（人点了 ×、命令里 exit）就从这里摘掉。
   */
  const windows = new Set<ChildProcess>()
  const closeAll = () => {
    for (const child of windows) killTree(child)
    windows.clear()
  }
  /**
   * 两道都要有，理由同 terminal.ts：`ctx.effect` 管插件卸载，信号处理管 systemd 重启。
   * **杀完摘掉自己再把信号重发一次**——装了监听器就摘掉了 Node 的默认退出，不重发的话
   * 进程要等 systemd 的 90 秒超时。
   */
  const onSignal = (sig: NodeJS.Signals) => {
    closeAll()
    process.off('SIGTERM', onSignal)
    process.off('SIGINT', onSignal)
    process.kill(process.pid, sig || 'SIGTERM')
  }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)
  ctx.effect(() => () => {
    process.off('SIGTERM', onSignal)
    process.off('SIGINT', onSignal)
    closeAll()
  })

  const show = (path: string) => ctx.workspace.show(path)
  /** 没有 DISPLAY 就是没部署桌面（e2e、开发机上直接跑 bot）。说清楚，别让它去猜。 */
  const display = () => {
    const d = (process.env.DISPLAY || '').trim()
    if (!d) fail('这台席位没有桌面（Bot 进程没拿到 DISPLAY）。这件事改用 terminal / read_file 做，或者请管理员重新部署席位。')
    return d
  }

  registerTool(
    ctx,
    {
      name: 'desktop_terminal',
      /**
       * 桌面是席位单例，员工正看着：一批委派里只给一个子代理，同浏览器（docs/delegation.md §7.1）。
       * 不标的话三个并行子代理各开一串窗口叠在同一块屏上，人分不清哪条命令是谁跑的。
       */
      delegation: { exclusive: 'desktop' },
      // 同 terminal：窗口里能跑任何命令。真正按命令判的在 policy（SHELL_TOOLS）。
      risk: ['write', 'destructive', 'external'],
      description:
        '在席位的远程桌面（用户在右栏看得到的那块屏）上打开一个终端窗口，可以顺带在里面跑一条命令。' +
        '用户说「打开终端 / 命令行 / cmd」「在桌面上跑给我看」、或者要跑一个需要人来交互的程序（要输入、要确认、全屏界面）时用它。\n' +
        '**窗口里的输出你读不到**，它只留在屏幕上给用户看。你要拿结果接着干活的命令，用 terminal，不要用这把。\n' +
        '**不要用它起服务器或长时间跑的任务**——那种用 terminal(background=true)，process 才管得到；' +
        '窗口里跑过命令的，Bot 换版或重启时会连窗口一起关掉。\n' +
        '命令跑完窗口不会关，会留一个 shell 给用户继续用。',
      parameters: {
        type: 'object',
        properties: {
          workdir: { type: 'string', description: '终端打开时所在的目录，相对工作区根目录。默认工作区根目录。' },
          command: { type: 'string', description: '打开后立刻在窗口里执行的命令。不填就只开一个空终端。' },
        },
      },
    },
    async (args: { workdir?: string; command?: string }) => {
      display()
      const dir = ctx.workspace.resolve(args.workdir)
      const info = await stat(dir).catch(() => fail(`目录不存在：${show(dir)}`))
      if (!info.isDirectory()) fail(`${show(dir)} 不是目录。`)
      const command = String(args.command || '').trim()
      const env = childEnv()
      const argv = ['--disable-server', `--working-directory=${dir}`]
      let track: ((child: ChildProcess) => void) | undefined
      if (command) {
        env.SATU_DESKTOP_CMD = command
        argv.push('-x', 'bash', '-c', RUN_IN_WINDOW)
        // 同 terminal 的 spawnShell：标签跟着每一代后代走，窗口退了也认得出它起的东西。
        const tag = randomBytes(9).toString('base64url')
        env[RUN_TAG] = tag
        track = (child) => {
          tagChild(child, tag)
          windows.add(child)
          child.once('exit', () => windows.delete(child))
        }
      }
      const err = await launch('xfce4-terminal', argv, env, dir, track)
      if (err) fail(err)
      return command
        ? `已在桌面上打开终端（${show(dir)}），正在跑：${command}\n输出只在那个窗口里，你看不到；跑完窗口会留着给用户。`
        : `已在桌面上打开终端（${show(dir)}）。`
    },
  )

  registerTool(
    ctx,
    {
      name: 'desktop_open_folder',
      delegation: { exclusive: 'desktop' },
      risk: ['read'],
      description:
        '在席位的远程桌面上用文件管理器打开一个文件夹，给用户看。' +
        '用户说「打开文件夹」「让我看看生成的文件」「打开下载目录」时用它。传的是文件的话，打开它所在的文件夹。\n' +
        '它只是开窗口给人看，不返回目录内容——你自己要看目录，用 search_files。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '要打开的文件夹（或其中的某个文件），相对工作区根目录。默认工作区根目录。' },
        },
      },
    },
    async (args: { path?: string }) => {
      display()
      let dir = ctx.workspace.resolve(args.path)
      const info = await stat(dir).catch(() => fail(`路径不存在：${show(dir)}`))
      if (!info.isDirectory()) dir = dirname(dir)
      const err = await launch('thunar', [dir], childEnv(), dir)
      if (err) fail(err)
      return `已在桌面上打开文件夹：${show(dir)}`
    },
  )
}
