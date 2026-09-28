import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tryRun } from './run.ts'
import { seat, type SeatRecord } from './seats.ts'

/**
 * 一个席位的现场快照。
 *
 * **这个文件存在的理由，是「没有 SSH」这个设计决定留下的窟窿。**
 *
 * 席位机器上没有登录入口，出了状况谁也看不见里面。而这一层最常见的故障恰恰都是
 * **不报错的**——单元 active、部署返回 ready、界面显示成功，可实际不对：
 *
 *   · 端口被同机另一套 VNC 占着 → 画面连得上，口令却永远是别人那一份
 *   · `systemctl restart` 杀不到 logind session 里的进程 → 换了配置却还是老进程在服务
 *   · dock 少一格 → plank 不认某个 .desktop，没有任何日志
 *   · 浏览器没装上 → 一句被吞掉的 apt 失败
 *
 * 这些全都只能靠 `ps` / `ss` / `journalctl` 看出来。没有这个接口，每查一次都得请人
 * 去机器前面敲命令、把输出贴回来——一来一回几分钟，而中间那些"猜一版、发一版"的
 * 代价要高得多。
 *
 * 所以这里**只读、尽力而为**：每一项独立收集，失败就记下失败原因，绝不让某一条命令
 * 缺失（老镜像没有 ss、没有 journalctl）把整份报告拖垮。
 *
 * **不返回任何凭据。** vnc-passwd 只报存在性和 mtime，不报内容；journal 出去之前过一
 * 遍脱敏。这份报告的读者是运维，不是攻击者，但它经由 Gateway 转给浏览器，得按会泄漏
 * 来设计。
 */

export interface DiagResult {
  seatId: string
  at: number
  seat: SeatRecord | null
  units: UnitInfo[]
  ports: PortInfo[]
  processes: ProcInfo[]
  files: FileInfo[]
  browser: { found: string | null; candidates: string[] }
  journal: string[]
  notes: string[]
}

interface UnitInfo {
  unit: string
  active: string
  sub: string
  /** 主进程起于何时。**重新部署之后这个值没变，就说明服务根本没重启。** */
  since: string
  mainPid: string
  restarts: string
  error?: string
}

interface PortInfo {
  port: number
  what: string
  listening: boolean
  pid?: string
  user?: string
  cmd?: string
  /**
   * 占着这个口的是不是**本席位**（不是「本席位那个用户」——见 portOf）。
   * false = 撞上了别人的东西，undefined = 认不出来（进程刚退、environ 读不到）。
   */
  mine?: boolean
}

interface ProcInfo {
  pid: string
  user: string
  started: string
  cmd: string
  /** 是不是本席位的。同机多席位时，光看命令行分不出来——见 ownsSeat。 */
  mine?: boolean
}

interface FileInfo {
  path: string
  exists: boolean
  size?: number
  mtime?: string
  note?: string
}

/**
 * 日志脱敏。
 *
 * 部署脚本的环境里有席位票、API key、VNC 口令，任何一个被打进 journal 都会跟着这份
 * 报告跑到浏览器里。宁可多盖几个字，也不能漏一个。
 */
export function scrub(line: string): string {
  return line
    .replace(/\b(sat_|smt_|sk_sw_|sk-|Bearer\s+)[A-Za-z0-9._-]{8,}/g, '$1***')
    .replace(/\b(GATEWAY_TOKEN|GATEWAY_API_KEY|VNC_PASSWORD|password|passwd)\s*[=:]\s*\S+/gi, '$1=***')
    .replace(/\beyJ[A-Za-z0-9._-]{20,}/g, 'eyJ***')
}

async function unitOf(unit: string): Promise<UnitInfo> {
  const out = await tryRun('systemctl', [
    'show',
    unit,
    '--property=ActiveState,SubState,ExecMainStartTimestamp,MainPID,NRestarts',
    '--no-pager',
  ])
  if (!out) return { unit, active: '?', sub: '?', since: '?', mainPid: '?', restarts: '?', error: 'systemctl 读不到' }
  const kv = new Map(
    out
      .split('\n')
      .map((l) => l.split('='))
      .filter((p) => p.length >= 2)
      .map((p) => [p[0], p.slice(1).join('=')] as [string, string]),
  )
  return {
    unit,
    active: kv.get('ActiveState') || '?',
    sub: kv.get('SubState') || '?',
    since: kv.get('ExecMainStartTimestamp') || '',
    mainPid: kv.get('MainPID') || '',
    restarts: kv.get('NRestarts') || '0',
  }
}

/**
 * 谁在听这个端口。`ss -ltnp` 要 root 才给得出 pid——管家正是以 root 跑的。
 *
 * **`mine` 按席位判，不按 Linux 用户名判。** 一个员工的所有席位共用一个账号，按用户
 * 名判的话，同账号下另一块屏的 x11vnc 蹲在这个口上会被认成「是本席位的」——而那正
 * 是这份报告要抓的头号故障（连得上、口令永远不对）。判据和 processesOf 里的 mine
 * 是同一条：席位目录逐席位唯一，用户名不是。
 */
async function portOf(port: number, what: string, seatDir: string): Promise<PortInfo> {
  const out = await tryRun('ss', ['-ltnp'])
  const line = out.split('\n').find((l) => new RegExp(`[:.]${port}\\b`).test(l))
  if (!line) return { port, what, listening: false }
  const pid = (/pid=(\d+)/.exec(line) || [])[1]
  if (!pid) return { port, what, listening: true }
  const ps = await tryRun('ps', ['-o', 'user:32=,cmd=', '-p', pid])
  const [user, ...rest] = ps.trim().split(/\s+/)
  return {
    port,
    what,
    listening: true,
    pid,
    user: user || '?',
    cmd: scrub(rest.join(' ')).slice(0, 200),
    mine: ownsSeat(pid, seatDir),
  }
}

/**
 * 这个席位相关的进程。
 *
 * **按 display 和端口筛，不能只按名字。** 同一台机器上、甚至同一个 Linux 用户名下都
 * 可能有好几个席位，`ps | grep x11vnc` 会把别人的也捞进来——今天那次排查，一眼看去
 * 四个 VNC 进程，分不清哪个是这个席位的，正是卡住的地方。
 *
 * display 和端口都是从 slot 算出来的（见 deploy.ts 的 portsOf），slot 由 botPort 反推。
 */
async function processesOf(row: SeatRecord): Promise<ProcInfo[]> {
  const out = await tryRun('ps', ['-eo', 'pid=,user:32=,lstart=,cmd='])
  if (!out) return []
  const slot = row.botPort - 3200
  const wanted = [
    new RegExp(`Xvfb :${10 + slot}\\b`),
    new RegExp(`x11vnc .*-rfbport ${5910 + slot}\\b`),
    new RegExp(`websockify .*:${row.novncPort}\\b`),
    new RegExp(`slim-desktop\\.sh ${row.seatId}\\b`),
    new RegExp(`satuwork.*${row.seatId}\\b`),
    // plank / xfwm4 的命令行里没有席位标识，只能先全收，再靠 /proc/<pid>/environ 认领
    // （见下面的 mine 标记）。**只按命令行匹配会骗人**：同机另一个席位的 plank 也叫
    // `plank --name dock1`，于是「本席位的 dock 进程没了」会被它顶掉，报告说一切正常。
    /\bplank\b/,
    /\bxfwm4\b/,
  ]
  const rows: ProcInfo[] = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    if (!wanted.some((re) => re.test(line))) continue
    const m = /^\s*(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line)
    const row2: ProcInfo = m
      ? { pid: m[1], user: m[2], started: m[3], cmd: scrub(m[4]).slice(0, 200) }
      : { pid: '?', user: '?', started: '?', cmd: scrub(line).slice(0, 200) }
    row2.mine = ownsSeat(row2.pid, row.seatDir)
    rows.push(row2)
  }
  return rows.slice(0, 40)
}

/**
 * 这个进程属不属于本席位。
 *
 * 靠 `/proc/<pid>/environ` 里的 XDG_CONFIG_HOME——席位目录是逐席位唯一的，而命令行
 * 不是（同机另一个席位的 plank 长得一模一样）。管家以 root 跑，读得到别人的 environ。
 */
function ownsSeat(pid: string, seatDir: string): boolean | undefined {
  if (!/^\d+$/.test(pid)) return undefined
  try {
    const env = readFileSync(`/proc/${pid}/environ`, 'utf8')
    if (!env) return undefined
    return env.split('\0').some((kv) => kv.startsWith('XDG_CONFIG_HOME=') && kv.includes(seatDir))
  } catch {
    return undefined
  }
}

function fileOf(path: string, note?: string): FileInfo {
  if (!existsSync(path)) return { path, exists: false, note }
  try {
    const st = statSync(path)
    return { path, exists: true, size: st.size, mtime: new Date(st.mtimeMs).toISOString(), note }
  } catch {
    return { path, exists: true, note: note ? note + '（stat 失败）' : 'stat 失败' }
  }
}

async function browserOf(): Promise<{ found: string | null; candidates: string[] }> {
  const candidates = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']
  for (const c of candidates) {
    if (await tryRun('command', ['-v', c])) return { found: c, candidates }
    const which = await tryRun('which', [c])
    if (which.trim()) return { found: c, candidates }
  }
  return { found: null, candidates }
}

export async function diagnose(seatId: string, lines = 40): Promise<DiagResult> {
  const row = seat(seatId) ?? null
  const notes: string[] = []
  const at = Date.now()
  if (!row) {
    return {
      seatId,
      at,
      seat: null,
      units: [],
      ports: [],
      processes: [],
      files: [],
      browser: { found: null, candidates: [] },
      journal: [],
      notes: ['名册里没有这个席位——它要么没部署过，要么已经被拆了'],
    }
  }

  const desktopUnit = `slim-desktop@${seatId}.service`
  const botUnit = `satuwork-bot@${seatId}.service`
  // 端口是按 slot 算出来的，slot 从 botPort 反推：botPort = 3200 + slot。
  const slot = row.botPort - 3200
  const rfb = 5910 + slot

  const [units, ports, processes, browser, journalRaw] = await Promise.all([
    Promise.all([unitOf(desktopUnit), unitOf(botUnit)]),
    Promise.all([
      portOf(rfb, 'x11vnc', row.seatDir),
      portOf(row.novncPort, 'websockify', row.seatDir),
      portOf(row.botPort, 'bot', row.seatDir),
    ]),
    processesOf(row),
    browserOf(),
    tryRun('journalctl', ['-u', desktopUnit, '-n', String(Math.min(200, Math.max(1, lines))), '--no-pager'], 12000),
  ])

  const launchers = join(row.seatDir, 'config/plank/dock1/launchers')
  const files: FileInfo[] = [
    fileOf(join(row.seatDir, 'vnc-passwd'), '只报存在与时间，不报内容'),
    fileOf(join(row.seatDir, 'desktop.env')),
    fileOf(launchers, 'dock 项目录'),
    fileOf(join(launchers, 'chrome.dockitem')),
    fileOf(join(launchers, 'files.dockitem')),
    fileOf(join(launchers, 'terminal.dockitem')),
    fileOf(join(row.seatDir, 'share/applications/seat-chrome.desktop')),
    fileOf(join(row.seatDir, 'share/applications/seat-files.desktop')),
    fileOf(join(row.seatDir, 'share/applications/seat-terminal.desktop')),
    // bot 程序在 root 的目录里，不在 seatDir（见 deploy-seat.sh step 5）。
    fileOf(join('/opt/satuwork/seats', row.seatId, 'app/VERSION')),
  ]

  // ── 把「一眼能看出的不对劲」直接写成人话，别让人自己去比对上面那堆字段 ──
  for (const p of ports) {
    if (!p.listening) notes.push(`端口 ${p.port}（${p.what}）没人在听`)
    else if (p.mine === false) notes.push(`端口 ${p.port}（${p.what}）被 ${p.user} 的进程 ${p.pid} 占着，不是本席位的（同一个员工的另一块屏也算）——这正是「连得上但口令不对」的典型成因`)
  }
  const desktop = units[0]
  if (desktop.active !== 'active') notes.push(`${desktopUnit} 不是 active（${desktop.active}/${desktop.sub}）`)
  if (Number(desktop.restarts) > 3) notes.push(`${desktopUnit} 重启过 ${desktop.restarts} 次，多半在起不来的循环里`)
  if (!browser.found) notes.push('这台机器上没找到任何浏览器，dock 上会少一格')
  if (!files.find((f) => f.path.endsWith('files.dockitem'))?.exists) notes.push('files.dockitem 不在，dock 上不会有文件管理器')
  // 认本席位的那一个。同机另一个席位的 plank 会把这条检查骗过去——它正是这次
  // 「dock 不见了」查了好几轮才找到的原因（两块屏共用一条 dbus，第二个 plank 自己退了）。
  if (!processes.some((p) => /\bplank\b/.test(p.cmd) && p.mine)) {
    notes.push('本席位的 plank 没在跑——整条 dock 都不会显示（同机别的席位有 plank 也不算）')
  }
  if (!processes.some((p) => /\bxfwm4\b/.test(p.cmd) && p.mine)) {
    notes.push('本席位的 xfwm4（窗口管理器）没在跑')
  }

  return {
    seatId,
    at,
    seat: row,
    units,
    ports,
    processes,
    files,
    browser,
    journal: journalRaw.split('\n').filter(Boolean).map(scrub).slice(-lines),
    notes,
  }
}
