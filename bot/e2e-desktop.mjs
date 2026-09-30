/**
 * 席位桌面那两把（desktop_terminal / desktop_open_folder）。探针要 tsx 才 import 得了 .ts。
 *
 * 真的 Xvfb + xfce4-terminal 只在席位机器上有，所以这里在 PATH 最前面垫两个**假的**
 * `xfce4-terminal` / `thunar`：它们把收到的参数、工作目录和几条环境变量记下来。
 * 假终端遇到 `-x` 会把后面那段真的用 bash 跑一遍（stdin 是 /dev/null，末尾的
 * `exec bash` 读到 EOF 就退），于是「命令真的在窗口里跑了」和「没把凭据带进窗口」
 * 都看得见。
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { WorkspaceService } from './src/workspace/index.ts'
import { ToolService } from './src/tools/index.ts'

const home = mkdtempSync(join(tmpdir(), 'satu-desk-home-'))
const root = mkdtempSync(join(tmpdir(), 'satu-desk-'))
const bin = mkdtempSync(join(tmpdir(), 'satu-desk-bin-'))
const rec = join(bin, 'rec')
process.on('exit', () => {
  for (const d of [home, root, bin]) try { rmSync(d, { recursive: true, force: true }) } catch {}
})

// 假终端：记参数、cwd、DISPLAY 和一条不该带进来的凭据；`-x` 之后的照跑。
writeFileSync(
  join(bin, 'xfce4-terminal'),
  `#!/bin/bash
{ printf 'argv'; printf ' [%s]' "$@"; printf '\\n'; echo "cwd $PWD"; echo "display $DISPLAY"; echo "token \${GATEWAY_TOKEN:-none}"; } >> "${rec}/term"
while [ $# -gt 0 ]; do
  if [ "$1" = -x ]; then shift; echo "cmd $$" >> "${rec}/pids"; "$@" < /dev/null >> "${rec}/term-out" 2>&1; exit 0; fi
  shift
done
# 空终端：像真窗口一样一直开着，等人来关。
echo "plain $$" >> "${rec}/pids"
exec sleep 60
`,
)
// 假文件管理器：记下开的是哪个目录。退 0——真 thunar 把窗口交给已有实例时也是这样。
writeFileSync(join(bin, 'thunar'), `#!/bin/bash\necho "open $1" >> "${rec}/files"\n`)
// 一个连不上屏的：一启动就非零退出。
mkdirSync(join(bin, 'broken'))
writeFileSync(join(bin, 'broken', 'thunar'), '#!/bin/bash\necho "cannot open display" >&2\nexit 1\n')
for (const f of ['xfce4-terminal', 'thunar', 'broken/thunar']) chmodSync(join(bin, f), 0o755)
mkdirSync(rec)

process.env.SATUWORK_HOME = home
process.env.GATEWAY_TOKEN = 'secret-should-not-leak'
const basePath = process.env.PATH
process.env.PATH = `${bin}:${basePath}`

const desktopTools = await import('./src/tools/desktop.ts')
const boot = async () => {
  const c = new Context()
  c.provide('logger', { warn() {}, info() {}, error() {} })
  c.plugin(WorkspaceService, { root })
  await new Promise((r) => setTimeout(r, 50))
  c.plugin(ToolService)
  await new Promise((r) => setTimeout(r, 50))
  const fork = c.plugin(desktopTools)
  await new Promise((r) => setTimeout(r, 100))
  return { c, fork }
}

const out = {}

// ── 0. 没有 DISPLAY 就不注册：模型不该看见两把每次都失败的工具 ───────────
delete process.env.DISPLAY
{
  const { c } = await boot()
  out.unregistered = { 终端没挂: !c.tools.has('desktop_terminal'), 文件夹没挂: !c.tools.has('desktop_open_folder') }
}

process.env.DISPLAY = ':42'
const { c: ctx, fork } = await boot()

let seq = 0
const call = (name, args) => ctx.tools.execute({ callId: `c${++seq}`, name, arguments: JSON.stringify(args), sessionId: 's-1' })
const read = (f) => (existsSync(join(rec, f)) ? readFileSync(join(rec, f), 'utf8') : '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

mkdirSync(join(root, 'out', 'deep'), { recursive: true })
writeFileSync(join(root, 'out', 'report.md'), '# hi')

// ── 1. 注册之后 DISPLAY 没了：不拉起任何东西，说清楚是没桌面 ──────────────
delete process.env.DISPLAY
{
  const r = await call('desktop_terminal', {})
  out.noDisplay = { 失败: r.failed === true || /没有桌面/.test(r.text), 说了原因: /DISPLAY/.test(r.text), 没拉起: read('term') === '' }
}
process.env.DISPLAY = ':42'

// ── 2. 空终端：开在工作区里，不带 -x ─────────────────────────────────
{
  const r = await call('desktop_terminal', { workdir: 'out' })
  await sleep(200)
  const t = read('term')
  out.plain = {
    成功: r.failed !== true && /已在桌面上打开终端/.test(r.text),
    工作目录对: t.includes(`[--working-directory=${join(root, 'out')}]`),
    不抢已有实例: t.includes('[--disable-server]'),
    没带命令: !t.includes('[-x]'),
    DISPLAY带到了: t.includes('display :42'),
    凭据没带进窗口: t.includes('token none'),
  }
}

// ── 3. 带命令：命令经环境变量进去，真在窗口里跑，引号不被拆 ─────────────
{
  const cmd = `echo "a b" 'c;d' && pwd`
  const r = await call('desktop_terminal', { command: cmd })
  for (let i = 0; i < 40 && !read('term-out').includes('退出码'); i++) await sleep(100)
  const o = read('term-out')
  out.command = {
    成功: r.failed !== true && r.text.includes(cmd),
    命令原样跑了: o.includes('a b c;d'),
    在工作区根里跑: o.includes(root),
    回显了命令: o.includes(`$ ${cmd}`),
    报了退出码: o.includes('[退出码 0]'),
  }
}

// ── 4. 越界的目录拒绝，不拉起 ─────────────────────────────────────────
{
  const before = read('term')
  const r = await call('desktop_terminal', { workdir: '../..' })
  out.escape = { 拒了: /越界/.test(r.text), 没拉起: read('term') === before }
}

// ── 5. 文件夹：目录照开，文件开它所在的目录 ───────────────────────────
{
  const a = await call('desktop_open_folder', {})
  const b = await call('desktop_open_folder', { path: 'out/report.md' })
  const c = await call('desktop_open_folder', { path: 'nope' })
  const f = read('files')
  out.folder = {
    根目录: a.failed !== true && f.includes(`open ${root}\n`),
    文件开所在目录: b.failed !== true && f.includes(`open ${join(root, 'out')}\n`),
    不存在的说清楚: /不存在/.test(c.text),
  }
}

// ── 6. 程序一启动就退出（连不上屏）：报失败，不说「已打开」 ──────────────
process.env.PATH = `${join(bin, 'broken')}:${basePath}`
{
  const r = await call('desktop_open_folder', {})
  out.broken = { 没说已打开: !/已在桌面上打开/.test(r.text), 说了退出: /退出/.test(r.text) }
}
// ── 7. 程序压根没装 ─────────────────────────────────────────────────
process.env.PATH = basePath
{
  const r = await call('desktop_terminal', {})
  out.missing = { 说了没装: /没有 xfce4-terminal/.test(r.text) }
}

// 放在最后：dispose 之后两把工具就从表里下去了。
// ── 8. 收尾：跑过命令的窗口连命令一起收掉，空终端留给人 ─────────────────
process.env.PATH = `${bin}:${basePath}`
{
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
  const pidsOf = (kind) => read('pids').split('\n').filter((l) => l.startsWith(kind + ' ')).map((l) => Number(l.split(' ')[1]))
  const beforeCmd = pidsOf('cmd').length
  await call('desktop_terminal', { command: 'sleep 60' })
  for (let i = 0; i < 20 && pidsOf('cmd').length === beforeCmd; i++) await sleep(50)
  const cmdPid = pidsOf('cmd').at(-1)
  const plainPid = pidsOf('plain').at(-1)
  const before = { 命令窗口在: alive(cmdPid), 空终端在: alive(plainPid) }
  fork.dispose()
  await sleep(300)
  out.shutdown = {
    ...before,
    命令窗口被收掉: !alive(cmdPid),
    空终端没被碰: alive(plainPid),
  }
  for (const pid of pidsOf('plain')) try { process.kill(pid, 'SIGKILL') } catch {}
}

console.log('__RESULT__' + JSON.stringify(out))
process.exit(0)
