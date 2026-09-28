/**
 * 后台进程的一生。探针要 tsx 才 import 得了 .ts。
 *
 * 这一组和别的不一样：它钉的东西**在这台机器上留得下痕迹**。一个没杀干净的后台进程
 * 会占着端口和内存活到下次重启，而所有别的信号都是绿的——所以「杀掉了」这件事一律
 * 用 `kill(pid, 0)` 去问操作系统，不看我们自己那本账。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { WorkspaceService } from './src/workspace/index.ts'
import { ToolService } from './src/tools/index.ts'
import * as terminalTools from './src/tools/terminal.ts'

const home = mkdtempSync(join(tmpdir(), 'satu-proc-home-'))
process.env.SATUWORK_HOME = home
const root = mkdtempSync(join(tmpdir(), 'satu-proc-'))
// 退出时收掉临时目录（和 e2e-memory / e2e-skills 那几个探针同一个写法）：探针是顶层 await 的
// 脚本，没有一个能包 finally 的函数体；exit 钩子在 process.exit、正常结束和未捕获异常三条路上都会跑。
process.on('exit', () => { try { rmSync(home, { recursive: true, force: true }) } catch {} try { rmSync(root, { recursive: true, force: true }) } catch {} })

const ctx = new Context()
ctx.provide('logger', { warn() {}, info() {}, error() {} })
ctx.plugin(WorkspaceService, { root })
await new Promise((r) => setTimeout(r, 50))
ctx.plugin(ToolService)
await new Promise((r) => setTimeout(r, 50))
ctx.plugin(terminalTools)
await new Promise((r) => setTimeout(r, 100))

let seq = 0
const call = (name, args, sessionId = 's-1', signal) =>
  ctx.tools.execute({ callId: `c${++seq}`, name, arguments: JSON.stringify(args), sessionId, signal })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/**
 * 这个 pid 还在不在。**问操作系统，不问我们自己那本账**——「注册表里标成已终止」和
 * 「进程真的没了」是两件事，而只有后者算数。
 *
 * 问的是 pid 不是进程组：`sleep 60 &` 出来的那个子进程跟着 bash 的组走，它自己的 pid
 * 不是一个合法的 pgid。
 */
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const idOf = (text) => (text.match(/proc_[0-9a-f]+/) ?? [])[0]

/**
 * **子角色**：被父进程真的发一次 SIGTERM 的那个进程（见 §7）。
 *
 * 为什么要另起一个进程：`process.emit('SIGTERM')` 只叫监听器，不走真正的信号投递，
 * 于是「装了监听器就把 Node 的默认退出摘掉了」这件事在探针里完全看不出来——而那正是
 * 换版时会让席位白等九十秒的那个 bug。要测它，只能真发一次信号给一个真的进程。
 */
if (process.env.SATU_PROC_CHILD) {
  const r = await call('terminal', { command: 'sleep 300 & echo $!; wait', background: true })
  await sleep(300)
  const log = await call('process', { action: 'log', session_id: idOf(r.text) })
  console.log('__PID__' + (log.text.match(/\|(\d+)/) ?? [])[1])
  // 挂住等信号。**不能自己 exit**：要测的正是「收到 SIGTERM 会不会退出」。
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}

const out = {}

// ── 1. 前台照旧 ───────────────────────────────────────────────────────
out.foreground = {
  跑得通: (await call('terminal', { command: 'echo hi' })).text.trim(),
  退出码非零不是管道故障: await (async () => {
    const r = await call('terminal', { command: 'exit 3' })
    return r.failed !== true && r.text.includes('退出码 3')
  })(),
  超时按秒算: await (async () => {
    const t0 = Date.now()
    const r = await call('terminal', { command: 'sleep 30', timeout: 1 })
    // 按毫秒理解的话这里会等满三十秒。
    return Date.now() - t0 < 5_000 && r.text.includes('超时')
  })(),
  workdir生效: (await call('terminal', { command: 'pwd', workdir: '.' })).text.trim().endsWith(root.split('/').pop()),
}

// ── 1.5 逃出进程组的后代攥着管道：超时 / 停止照样要返回 ─────────────────
/**
 * `setsid foo &` 出来的后代换了会话，`kill(-pgid)` 杀不到它，而它继承了 stdout/stderr。
 * 以前那次调用只等 `close`，管道不关就永远不返回——这一轮挂死。
 *
 * 用 perl 的 POSIX::setsid 而不是 `setsid` 命令：后者 macOS 上没有。两种形状都要：
 * `& wait` 是 shell 还活着的时候被杀，`&` 后面什么都不跟是 shell 早就退了、只剩后代。
 */
{
  const escapee = `perl -e 'use POSIX; setsid(); sleep 1000'`
  const pidsOf = (text) => [...String(text).matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]))
  const leftovers = []
  const timed = async (args, signal) => {
    const t0 = Date.now()
    const r = await call('terminal', args, 's-1', signal)
    leftovers.push(...pidsOf(r.text))
    return { ms: Date.now() - t0, r }
  }
  const waiting = await timed({ command: `${escapee} & echo pid=$!; wait`, timeout: 1 })
  const orphaned = await timed({ command: `${escapee} & echo pid=$!`, timeout: 1 })
  const ac = new AbortController()
  const stopping = timed({ command: `${escapee} & echo pid=$!; wait`, timeout: 60 }, ac.signal)
  await sleep(300)
  ac.abort()
  const stopped = await stopping
  out.escapee = {
    // 1 秒超时 + 2 秒拆管道的余量，再留一点给慢机器。
    shell还活着时超时会返回: waiting.ms < 6_000 && waiting.r.text.includes('超时'),
    shell早退了超时也会返回: orphaned.ms < 6_000 && orphaned.r.text.includes('超时'),
    停止按钮会返回: stopped.ms < 6_000,
    输出没丢: waiting.r.text.includes('pid='),
  }
  // 收掉逃出去的那几个：它们本来就不在进程组里，探针自己不收就会在机器上活一千秒。
  for (const pid of leftovers) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
}

// ── 2. 输出超限：截断，但全文捞得回来 ─────────────────────────────────
{
  const r = await call('terminal', { command: 'for i in $(seq 1 40000); do echo "第 $i 行 xxxxxxxxxxxxxxxxxxxx"; done' })
  const at = (r.text.match(/完整输出在 (\S+)，用 read_file/) ?? [])[1]
  out.spill = {
    截断了: r.text.includes('输出已截断'),
    给了路径: Boolean(at),
    路径在隐藏目录里: Boolean(at && at.startsWith('.satuwork/')),
    // 界面上那一排药丸是「Bot 产出了什么」，过程痕迹不该混进去。
    不进产出: !r.files && !r.refs,
  }
}

// ── 2.5 命令产出的文件要能被点开 ──────────────────────────────────────
/**
 * `write_file` 报得出自己写了哪个文件，`terminal` 只有一条 shell 命令——而模型照样
 * 会用它造东西（跑脚本生成报表、curl 下附件）。产出不进 `files` 的话，界面上没有
 * 药丸、点不开预览，用户只能听模型说一句「文件在工作区里」。
 */
{
  const one = await call('terminal', { command: 'mkdir -p 产出 && printf "<h1>hi</h1>" > 产出/report.html' })
  // 一条只读命令不该报出任何产出——扫描认的是 mtime，不是「这条命令跑过」。
  const none = await call('terminal', { command: 'echo 只是看看' })
  /**
   * **别的写入方的地盘要跳掉。** `uploads/` 是用户从对话里传上来的附件，界面上早就挂
   * 在那条用户消息底下了；一条跑二十秒的命令期间用户传了张发票，那张发票不该挂到这条
   * 命令头上——还会跟着 details.files 进会话日志，重放一次错一次。
   */
  const foreign = await call('terminal', {
    command: 'mkdir -p uploads/s-1 web browser && printf x > uploads/s-1/发票.pdf && printf x > web/抓回来的.md && printf y > 真产出.txt',
  })
  // 摆得下就一个不少。以前砍到五个，而且一声不吭——人会以为一共就那五个。
  const many = await call('terminal', { command: 'mkdir -p 一批 && for i in $(seq 1 10); do echo x > 一批/g$i.txt; done' })
  // 构建 / 安装 / 切分支那种批量改动：一个都不报，但要在文本里**明说**。
  const bulk = await call('terminal', { command: 'mkdir -p 批量 && for i in $(seq 1 40); do echo x > 批量/f$i.txt; done' })
  // 退出码非零、甚至被中止的命令同样可能已经写下半个文件，那时候人最想看的就是它。
  const failed = await call('terminal', { command: 'printf half > 半截.txt; exit 3' })
  out.produced = {
    报了产出: (one.files ?? []).map((f) => f.path),
    名字是文件名: (one.files ?? [])[0]?.name,
    只读命令不报: !none.files,
    别人的地盘不算我的: (foreign.files ?? []).map((f) => f.path),
    十个全报: (many.files ?? []).map((f) => f.path),
    批量改动不报: !bulk.files,
    批量改动说了一声: bulk.text.includes('个以上的文件'),
    不该无缘无故说那句: !one.text.includes('个以上的文件'),
    失败的命令也报: (failed.files ?? []).map((f) => f.path),
    // 落盘的命令输出是过程痕迹（.satuwork 在 SKIPPED_DIRS 里），不该混进产出。
    过程痕迹不报: !(one.files ?? []).some((f) => f.path.startsWith('.satuwork')),
  }
}

// ── 2.6 连着跑：早于这条命令的写入，不许算到它头上 ─────────────────────
/**
 * 判据比的是 `mtimeMs`，所以**地板出自哪个钟**是这件事的全部。取自 `Date.now()` 就对
 * 不上：它向下取整到毫秒而 `mtimeMs` 带小数，同一毫秒里前者恒小于后者，窗口于是往回
 * 张开将近一毫秒——早于这条命令的写入成了它的产出，界面上多一颗不属于这次调用的药丸，
 * 还跟着 details.files 进会话日志。
 *
 * 上面 2.5 每种情况只跑一次，而这条窗口只有半毫秒宽：**两次写入隔得越近才越容易撞上**，
 * 隔一次工作区扫描就已经十次里中不了一次。所以这一段做两件事——把工作区先扫干净（扫描
 * 越快，两条命令挨得越紧），并且每轮在只读命令**紧挨着**从探针这边写一个文件：那是
 * 「同一个工作区里的另一个写入方」，也是这条不变量真正要挡的东西，而且它和下一条命令
 * 之间只隔着几行 JS，撞不撞得上不再看运气。
 *
 * 两个方向一起数：多报是窗口往回开了，**少报是地板抬过了头**——「往后挪一毫秒」那种
 * 凑数改法就是拿这一头换那一头，在时间戳粗一格的文件系统上会把命令头几毫秒里真写下
 * 的文件丢掉。两头都钉住，省得下次又换回去。
 */
{
  const 轮数 = 20
  // 2.5 留下的几十个文件会让每次扫描慢上一截，而这一段要的正是「两条命令挨得紧」。
  // 那些断言的结果早就取进 out 了，文件本身没人再看。
  for (const d of ['产出', '一批', '批量', 'uploads', 'web', 'browser', '真产出.txt', '半截.txt']) {
    rmSync(join(root, d), { recursive: true, force: true })
  }
  const 连跑 = { 轮数, 早先的写入泄漏: 0, 十个变多: 0, 十个变少: 0, 单个没报: 0, 样本: [] }
  for (let i = 0; i < 轮数; i++) {
    const one = await call('terminal', { command: 'mkdir -p 连跑 && printf x > 连跑/a.txt' })
    const oneFiles = (one.files ?? []).map((f) => f.path)
    if (!oneFiles.includes('连跑/a.txt')) {
      连跑.单个没报++
      连跑.样本.push(`#${i} 自己写的没报：${JSON.stringify(oneFiles)}`)
    }
    // **紧挨着**落一个不属于任何命令的文件，再跑一条只读的。地板要是往回开了，这个
    // 文件就会挂到那条 `echo` 头上——真实场景里它是用户上传、是另一个席位、是上一条
    // 命令的最后一次写入。
    writeFileSync(join(root, '连跑', '外来.txt'), 'x')
    const none = await call('terminal', { command: 'echo 只是看看' })
    if (none.files) {
      连跑.早先的写入泄漏++
      连跑.样本.push(`#${i} 只读命令报出了：${JSON.stringify(none.files.map((f) => f.path))}`)
    }
    // 再紧跟一条写十个的：十一个是把早先那个算了进来，九个是自己的丢了。
    const many = await call('terminal', { command: 'mkdir -p 连跑批 && for k in $(seq 1 10); do echo x > 连跑批/g$k.txt; done' })
    const manyFiles = (many.files ?? []).map((f) => f.path)
    if (manyFiles.length > 10) {
      连跑.十个变多++
      连跑.样本.push(`#${i} 十个变成 ${manyFiles.length}，多出来的：${JSON.stringify(manyFiles.filter((f) => !f.startsWith('连跑批/')))}`)
    } else if (manyFiles.length < 10) {
      连跑.十个变少++
      连跑.样本.push(`#${i} 十个变成 ${manyFiles.length}：${JSON.stringify(manyFiles)}`)
    }
    // 每轮扫干净：两百多个文件留在那儿，后面每一次扫描都要多走一遍。
    rmSync(join(root, '连跑'), { recursive: true, force: true })
    rmSync(join(root, '连跑批'), { recursive: true, force: true })
  }
  // 样本只留前几条：全泄漏时报错信息不该是一屏路径。
  连跑.样本 = 连跑.样本.slice(0, 5)
  out.连跑 = 连跑
}

// ── 3. 后台：起、poll、wait、kill ─────────────────────────────────────
const t0bg = Date.now()
const started = await call('terminal', { command: 'echo one; sleep 0.4; echo two; sleep 30', background: true })
const startedIn = Date.now() - t0bg
const bg = idOf(started.text)
out.background = {
  返回了id: Boolean(bg),
  没有阻塞: startedIn < 2_000,
  说了不随这一轮结束: started.text.includes('不随这一轮结束'),
}

await sleep(200)
const poll1 = await call('process', { action: 'poll', session_id: bg })
await sleep(500)
const poll2 = await call('process', { action: 'poll', session_id: bg })
out.poll = {
  第一次看到one: poll1.text.includes('one'),
  第一次没看到two: !poll1.text.includes('two'),
  // poll 给的是「上次之后的新输出」——再看到一遍 one 的话，模型会以为它又跑了一次。
  第二次只有two: poll2.text.includes('two') && !poll2.text.includes('one'),
  运行中: poll1.text.includes('运行中'),
}

out.list = (await call('process', { action: 'list' })).text.includes(bg)
out.prefix = (await call('process', { action: 'poll', session_id: bg.slice('proc_'.length, 'proc_'.length + 4) })).failed !== true
out.otherSession = (await call('process', { action: 'poll', session_id: bg }, 's-2')).text

// wait 超时：进程还在跑，等待本身要停得下来
{
  const t0 = Date.now()
  const r = await call('process', { action: 'wait', session_id: bg, timeout: 1 })
  out.waitTimeout = { 一秒就回来: Date.now() - t0 < 4_000, 说了还没结束: r.text.includes('还没结束') }
}

// 停止按钮掐的是这一轮，**不是**后台进程
{
  const ac = new AbortController()
  const waiting = call('process', { action: 'wait', session_id: bg, timeout: 300 }, 's-1', ac.signal)
  await sleep(100)
  ac.abort()
  const t0 = Date.now()
  await waiting
  out.abortStopsWaitNotProcess = {
    等待停得下来: Date.now() - t0 < 3_000,
    进程还活着: (await call('process', { action: 'poll', session_id: bg })).text.includes('运行中'),
  }
}

// 杀之前先确认它真的在跑：起一条把子进程 pid 打出来的命令，拿它去问操作系统。
{
  const r = await call('terminal', { command: 'sleep 60 & echo $!; wait', background: true })
  const id = idOf(r.text)
  await sleep(300)
  const log = await call('process', { action: 'log', session_id: id })
  const childPid = Number((log.text.match(/\|(\d+)/) ?? [])[1])
  const before = childPid ? alive(childPid) : false
  await call('process', { action: 'kill', session_id: id })
  await sleep(300)
  out.killTree = {
    杀之前fork出去的活着: before,
    // 只杀 bash 的话，`sleep 60 &` 会留下来，端口和 CPU 一起占着。
    杀之后整族都没了: childPid ? !alive(childPid) : false,
    状态变了: (await call('process', { action: 'poll', session_id: id })).text.includes('已被终止'),
  }
}

out.killed = (await call('process', { action: 'kill', session_id: bg })).text.includes('已终止')

// ── 4. 并发上限 ───────────────────────────────────────────────────────
{
  const ids = []
  for (let i = 0; i < 8; i++) {
    ids.push(idOf((await call('terminal', { command: 'sleep 30', background: true }, 's-cap')).text))
  }
  const ninth = await call('terminal', { command: 'sleep 30', background: true }, 's-cap')
  out.cap = {
    第九个被拒: ninth.text.includes('上限'),
    // 没有清单的话，模型只知道「不让起」，不知道是自己起了八个。
    拒绝时列出了前八个: ids.filter(Boolean).every((id) => ninth.text.includes(id)),
    // 会话之间不互相挤：上限是按会话算的。
    别的会话不受影响: (await call('terminal', { command: 'sleep 30', background: true }, 's-other')).text.includes('已在后台启动'),
  }
  for (const id of ids) await call('process', { action: 'kill', session_id: id }, 's-cap')
}

// ── 5. 结束通知走 agents ──────────────────────────────────────────────
/**
 * `notify_on_complete` 的整个意义是「不用轮询」。它落成一条 `user/message`——不变量 7：
 * 进入模型的那句话必须在 JSONL 里，重放才对得上。
 */
{
  const sent = []
  ctx.provide('agents', {
    isRunning: () => false,
    steer: async () => false,
    send: async (sessionId, text, images, mentions, source) => {
      sent.push({ sessionId, text, source })
    },
  })
  await sleep(50)
  await call('terminal', { command: 'echo 干完了; exit 0', background: true, notify_on_complete: true }, 's-notify')
  for (let i = 0; i < 40 && !sent.length; i++) await sleep(100)
  out.notify = {
    自己来了一条: sent.length === 1,
    进的是那条会话: sent[0]?.sessionId === 's-notify',
    出处写着process: sent[0]?.source?.plugin === 'process',
    带了退出码: Boolean(sent[0]?.text?.includes('退出码 0')),
    带了最后几行: Boolean(sent[0]?.text?.includes('干完了')),
  }
  // 不设 notify_on_complete 就不该有第二条：永不退出的服务器不需要被通知。
  const before = sent.length
  await call('terminal', { command: 'echo 安静', background: true }, 's-notify')
  await sleep(600)
  out.notify.没设的就不通知 = sent.length === before

  /**
   * **自己动手杀的不通知。** kill 是模型刚发起的那次调用，结果它从返回值里已经知道了。
   * 照样通知的话，那一轮要是已经收口，send 会为此单独开一轮——用户看到一条没来由的
   * 「已被终止」冒出来，账上还多一次模型调用。
   */
  const r = await call('terminal', { command: 'sleep 60', background: true, notify_on_complete: true }, 's-notify')
  await sleep(200)
  await call('process', { action: 'kill', session_id: idOf(r.text) }, 's-notify')
  await sleep(800)
  out.notify.自己杀的不通知 = sent.length === before
}

// ── 6. 中文输出不许出现替换字符 ───────────────────────────────────────
/**
 * 一个汉字三个字节，而 chunk 的边界落在哪儿只看内核什么时候把数据递上来。切在字符中间
 * 时两半各自解码，出来的就是 `�`——前台那次最多是屏幕上花一下，后台那份还会**落进
 * proc/<id>.log**，原字节再也捞不回来。这个产品的命令输出以中文为主。
 */
{
  const cmd = 'for i in $(seq 1 20000); do echo "第 $i 行 中文中文中文中文中文中文中文"; done'
  const fg = await call('terminal', { command: cmd })
  const r = await call('terminal', { command: cmd, background: true }, 's-utf8')
  const id = idOf(r.text)
  await call('process', { action: 'wait', session_id: id, timeout: 30 }, 's-utf8')
  const log = await call('process', { action: 'log', session_id: id, offset: 1, limit: 2000 }, 's-utf8')
  const poll = await call('process', { action: 'poll', session_id: id }, 's-utf8')
  out.utf8 = {
    前台没有替换字符: !fg.text.includes('�'),
    后台日志没有替换字符: !log.text.includes('�'),
    poll没有替换字符: !poll.text.includes('�'),
    真的是中文: log.text.includes('中文中文'),
  }
}

// ── 6b. 日志有上限，log 只读要的那几行 ───────────────────────────────
/**
 * 以前日志只增不减：一个刷屏的 `pnpm dev` 跑满 24 小时能把盘写满；`log` 还整份 readFile，
 * 几百 MB 的日志一次摆进内存。现在一段 8 MB 就滚一次，盘上最多两段；行号从第一行输出
 * 数起，滚掉的那截照样算进去——翻页的 offset 不因为滚段而错位。
 */
{
  // 20 万行、每行百来个字节，一共 20 MB 出头：要滚两次。
  const cmd = `yes ${'x'.repeat(90)} | head -n 200000 | nl -ba -w8 -nrz`
  const r = await call('terminal', { command: cmd, background: true }, 's-cap')
  const id = idOf(r.text)
  await call('process', { action: 'wait', session_id: id, timeout: 30 }, 's-cap')
  await sleep(300)
  const { statSync } = await import('node:fs')
  const sizeOf = (f) => { try { return statSync(f).size } catch { return -1 } }
  const cur = sizeOf(join(home, 'proc', `${id}.log`))
  const prev = sizeOf(join(home, 'proc', `${id}.log.1`))
  const tail = (await call('process', { action: 'log', session_id: id, limit: 3 }, 's-cap')).text
  const total = Number((tail.match(/共 (\d+) 行/) ?? [])[1])
  const lastLine = tail.split('\n').pop() ?? ''
  const head = (await call('process', { action: 'log', session_id: id, offset: 1, limit: 2 }, 's-cap')).text
  const near = (await call('process', { action: 'log', session_id: id, offset: total - 1, limit: 5 }, 's-cap')).text
  out.logCap = {
    当前段有上限: cur > 0 && cur <= 9 * 1024 * 1024,
    滚出来的那段也有上限: prev > 0 && prev <= 9 * 1024 * 1024,
    盘上加起来比输出少: cur + prev < 20 * 1024 * 1024,
    行号从第一行数起: total === 200000,
    末行行号和内容对得上: /^200000\|00200000\t/.test(lastLine),
    滚掉的那截说清楚: /已经滚掉了/.test(head),
    翻到最后照样接得上: near.split('\n')[1]?.startsWith('199999|00199999') && !/还有/.test(near),
    raw: { cur, prev, tail: tail.slice(0, 300), head: head.slice(0, 300), near: near.slice(0, 400) },
  }
}

// ── 7. callId 洗过再拼路径 ────────────────────────────────────────────
/**
 * callId 是 provider 在响应里给的，一路透传到落盘那一步，没有任何一层校验过它长什么样。
 * 上传文件名和 sessionId 早就走 safeName / safeSegment 了，这条新路不该是例外。
 */
{
  const r = await ctx.tools.execute({
    callId: '../../../evil',
    name: 'terminal',
    arguments: JSON.stringify({ command: 'for i in $(seq 1 40000); do echo xxxxxxxxxxxxxxxxxxxx; done' }),
    sessionId: 's-1',
  })
  const at = (r.text.match(/完整输出在 (\S+)，用 read_file/) ?? [])[1]
  out.callId = {
    落在了工作区里: Boolean(at && at.startsWith('.satuwork/out/')),
    没跑出去: !existsSync(join(dirname(root), 'evil.log')) && !existsSync(join(root, '..', '..', 'evil.log')),
    // 洗完还得真的写成了：一句「没跑出去」如果是因为压根没写，那这条断言什么都没证明。
    文件真的在: Boolean(at && existsSync(join(root, at))),
  }
}

// ── 8. 开机扫掉没主人的日志 ───────────────────────────────────────────
/**
 * 删日志靠的是进程退出后那个三十分钟的定时器，而定时器活在内存里——席位换一次版、崩
 * 一次，正跑着的那些后台进程连同定时器一起没，日志留在盘上再也没有主人。
 */
{
  const dir = join(home, 'proc')
  mkdirSync(dir, { recursive: true })
  const stale = join(dir, 'stale.log')
  const recent = join(dir, 'recent.log')
  writeFileSync(stale, 'x')
  writeFileSync(recent, 'x')
  const longAgo = new Date(Date.now() - 5 * 24 * 3600_000)
  utimesSync(stale, longAgo, longAgo)
  // 再挂一次插件 = 再「开一次机」。扫的是同一个 $SATUWORK_HOME/proc。
  const ctx2 = new Context()
  ctx2.provide('logger', { warn() {}, info() {}, error() {} })
  ctx2.plugin(WorkspaceService, { root })
  await sleep(50)
  ctx2.plugin(ToolService)
  await sleep(50)
  ctx2.plugin(terminalTools)
  await sleep(400)
  out.sweep = { 过期的删了: !existsSync(stale), 新的留着: existsSync(recent) }
}

// ── 9. 关机：进程自己退出，而且不留孤儿 ───────────────────────────────
/**
 * 管家换版走的是 `systemctl restart`（SIGTERM），**排空只等模型那一轮跑完，管不到后台
 * 进程**。两件事都要成立：后台进程被杀干净，**并且这个进程自己真的退出**——给 SIGTERM
 * 装了监听器就把 Node 的默认退出摘掉了，不重发信号的话它会一直活到 systemd 那九十秒
 * 的硬杀。所以这一段发的是真信号，收信的是一个真进程（见文件上方的子角色）。
 */
{
  const self = fileURLToPath(import.meta.url)
  const child = spawn(process.execPath, ['--import', 'tsx', self], {
    // cwd 钉在 bot/：`--import tsx` 是按 cwd 解析的，从别处跑这个探针时子进程会以
    // ERR_MODULE_NOT_FOUND 当场死掉，而那看起来跟「进程不肯退出」一模一样。
    cwd: dirname(self),
    env: { ...process.env, SATU_PROC_CHILD: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let buf = ''
  let err = ''
  child.stderr.on('data', (d) => (err += d))
  const inner = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`子进程没报出 pid\n${err || buf}`)), 30_000)
    child.stdout.on('data', (d) => {
      buf += d
      const m = buf.match(/__PID__(\d+)/)
      if (m) {
        clearTimeout(t)
        resolve(Number(m[1]))
      }
    })
    // 子进程直接夭折（比如解析不到 tsx）时不要干等三十秒。
    child.on('exit', (code) => {
      clearTimeout(t)
      reject(new Error(`子进程还没报出 pid 就退了（${code}）\n${err || buf}`))
    })
    child.on('error', reject)
  })
  const before = alive(inner)
  const exited = new Promise((r) => child.on('exit', () => r(true)))
  child.kill('SIGTERM')
  const quit = await Promise.race([exited, sleep(6_000).then(() => false)])
  await sleep(300)
  out.shutdown = {
    信号之前活着: before,
    进程自己退出了: quit === true,
    孤儿也没了: !alive(inner),
  }
  if (quit !== true) child.kill('SIGKILL')
}

console.log('__RESULT__' + JSON.stringify(out))
process.exit(0)
