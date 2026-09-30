import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { childEnv } from '../workspace/index.ts'
import { fail, registerTool } from './common.ts'

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
 * **只在远程席位上挂。** 本地 Bot 跑在员工自己的电脑上，没有「席位桌面」这回事，
 * 而且那边连 terminal 都没开（见 terminal.ts 的 apply）。
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

/** 拉起一个桌面程序，等它要么起来、要么当场退出。返回 null 表示起来了。 */
function launch(bin: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { detached: true, stdio: 'ignore', env, cwd })
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
      delegation: {},
      // 同 terminal：窗口里能跑任何命令。真正按命令判的在 policy（SHELL_TOOLS）。
      risk: ['write', 'destructive', 'external'],
      description:
        '在席位的远程桌面（用户在右栏看得到的那块屏）上打开一个终端窗口，可以顺带在里面跑一条命令。' +
        '用户说「打开终端 / 命令行 / cmd」「在桌面上跑给我看」、或者要跑一个需要人来交互的程序（要输入、要确认、全屏界面）时用它。\n' +
        '**窗口里的输出你读不到**，它只留在屏幕上给用户看。你要拿结果接着干活的命令，用 terminal，不要用这把。\n' +
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
      if (command) {
        env.SATU_DESKTOP_CMD = command
        argv.push('-x', 'bash', '-c', RUN_IN_WINDOW)
      }
      const err = await launch('xfce4-terminal', argv, env, dir)
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
      delegation: {},
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
