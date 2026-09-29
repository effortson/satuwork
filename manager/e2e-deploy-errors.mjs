/**
 * 部署失败时那句话到底说了什么。**不走 HTTP**——要钉的是纯函数 tailError 的取舍。
 *
 * 由 e2e/deploy-errors.mjs 用 `node --import tsx` 拉起，结果以 __RESULT__ 一行 JSON 回去。
 *
 * 放 manager/ 而不是 e2e/：和别的探针同一个理由，裸导入按文件所在目录往上找。
 */
import { readFileSync } from 'node:fs'
import { classifyHolder } from './src/reclaim.ts'
import { claimSeat } from './src/seat-owner.ts'
import { pruneRetired, stepOf } from './src/seats.ts'
import { run, tailError } from './src/run.ts'

/**
 * 端口被占着时，管家决定「敢不敢清」的那一步（reclaim.ts 的 classifyHolder）。
 *
 * 现场：slot 0 的席位部署失败 `exited 43`，5910 上蹲着 sw-…-7bbe43f21941 的 x11vnc
 * ——一个已经拆掉、单元停了但进程从 logind session 里逃出来的席位。四种占口的东西
 * 处置完全不同，判错任何一种的代价都不对称，所以逐种钉住。
 */
const SPEC = { seatId: 'sw-me-0001', display: 10, vncPort: 5910, novncPort: 6081, botPort: 3200 }
/** 名册里活着的另一个席位，占的是 slot 5（bot 3205 / noVNC 6086 / rfb 5915）。 */
const LIVE = { seatId: 'sw-other-0002', linuxUser: 'sw-other', botPort: 3205, novncPort: 6086 }
const holder = (seatId, cmd = 'x11vnc -rfbport 5910') => ({ pid: '68056', seatId, cmd })
/** 端口那一路的问法。 */
const atPort = (port) => [`端口 ${port}（x11vnc）`, (row) => [row.botPort, row.novncPort, 5910 + (row.botPort - 3200)].includes(port)]
/** 显示号那一路——Xvfb 不占端口，判据换成 display = 10 + slot。 */
const atDisplay = (n) => [`显示 :${n}（Xvfb）`, (row) => 10 + (row.botPort - 3200) === n]

function verdicts() {
  return {
    ownStale: classifyHolder(SPEC, [], ...atPort(5910), holder('sw-me-0001')),
    orphan: classifyHolder(SPEC, [LIVE], ...atPort(5910), holder('sw-gone-7bbe')),
    // 活席位现在的口被 Gateway 分给了我们：名册比 Gateway 旧了，以 Gateway 为准。
    staleRoster: classifyHolder({ ...SPEC, vncPort: 5915 }, [LIVE], ...atPort(5915), holder('sw-other-0002')),
    // 同一个活席位，但占的是它换槽位之前那一代的口——这个可以清，且只清这一个。
    staleGeneration: classifyHolder(SPEC, [LIVE], ...atPort(5910), holder('sw-other-0002')),
    foreign: classifyHolder(SPEC, [LIVE], ...atPort(5910), holder(null, 'x11vnc -rfbauth /home/slim/.vnc/passwd')),
    // 显示号走同一套判断：孤儿的 Xvfb 占着 :10，一个 TCP 口都不占。
    displayOrphan: classifyHolder(SPEC, [LIVE], ...atDisplay(10), holder('sw-gone-7bbe', 'Xvfb :10 -screen 0 1280x800x24')),
    // LIVE 在 slot 5（display :15），它的 Xvfb 蹲在 :10 就是上一代的残留。
    displayStaleGeneration: classifyHolder(SPEC, [LIVE], ...atDisplay(10), holder('sw-other-0002', 'Xvfb :10')),
  }
}

/**
 * 「这个进程是哪个席位的」（seat-owner.ts 的 claimSeat）。回收拿它决定停谁，判错就是停掉
 * 别人的席位。**环境变量是进程自己写的**，所以只看 cgroup / logind 会话加 uid。
 *
 * 场景：sw-a 的账号 uid 1001，sw-b 的账号 uid 1002。
 */
function owners() {
  const uids = { 'sw-a': 1001, 'sw-b': 1002 }
  const sessions = { 7: 'login', 9: 'sshd' }
  const look = { sessionService: (id) => sessions[id] ?? null, seatUid: (id) => uids[id] ?? null }
  const unit = (u) => `0::/system.slice/system-${u.split('@')[0].replace(/-/g, '\\x2d')}.slice/${u}`
  const scope = (uid, n) => `0::/user.slice/user-${uid}.slice/session-${n}.scope`
  const env = (dir) => [`DISPLAY=:10`, `XDG_RUNTIME_DIR=${dir}`]
  const claim = (cgroup, environ, uid) => claimSeat({ cgroup, environ, uid }, look)
  return {
    ownBot: claim(unit('satuwork-bot@sw-a.service'), [], 1001),
    // bot 单元里的进程自报成别的席位：以 cgroup 为准，环境不算数。
    botForgesOther: claim(unit('satuwork-bot@sw-a.service'), env('/run/satuwork/sw-b'), 1001),
    ownDesktopUnit: claim(unit('slim-desktop@sw-a.service'), [], 1001),
    // 桌面单元是 PAMName=login：x11vnc 落在 login 会话的 scope 里，按环境里的候选认，再核 uid。
    desktopInScope: claim(scope(1001, 7), env('/run/satuwork/sw-a'), 1001),
    desktopLegacyDir: claim(scope(1001, 7), env('/tmp/xdg-runtime-sw-a'), 1001),
    // 别的账号在自己的 login 会话里冒充 sw-a：uid 对不上。
    otherUserForges: claim(scope(1002, 7), env('/run/satuwork/sw-a'), 1002),
    // ssh 进来的会话里冒充：会话不是 login 开的。
    sshForges: claim(scope(1001, 9), env('/run/satuwork/sw-a'), 1001),
    // 不在任何单元、任何会话里（比如 user@.service 底下）带一条伪造的环境：一律不认。
    noScopeForges: claim('0::/user.slice/user-1002.slice/user@1002.service/app.slice/x.service', env('/run/satuwork/sw-a'), 1002),
    // 单元对得上但 uid 不对（不该出现，出现了就不认）。
    unitWrongUid: claim(unit('slim-desktop@sw-a.service'), [], 0),
    // 名册、drop-in 里都查不到账号的席位：认不出来。
    unknownSeat: claim(unit('satuwork-bot@sw-zz.service'), [], 1001),
  }
}

/** 回收停掉一个席位之后，名册要跟着销号——不销号，下一轮的判断依据就是假的。 */
function pruning() {
  const row = (seatId, botPort) => ({ seatId, linuxUser: 'sw-x', seatDir: `/home/sw-x/.satuwork/${seatId}`, botId: 'b', botVersion: '1', botPort, novncPort: botPort + 2881, deployedAt: 0, status: 'ready', lastError: null })
  const reg = { 'sw-me-0001': row('sw-me-0001', 3200), 'sw-old-0009': row('sw-old-0009', 3201) }
  const changed = pruneRetired(reg, ['sw-old-0009'])
  // 孤儿那一路：清掉的席位名册里本来就没有，一个字都没改，不该白写一次盘。
  const untouched = pruneRetired(reg, ['sw-never-seen'])
  return { pruneChanged: changed, pruneLeft: Object.keys(reg), pruneNoop: untouched }
}

/**
 * 安装进度：脚本报的那几行，管家读得出来吗。
 *
 * **半行切分是这条路最容易错的地方**：一次 stdout 事件切在行中间是常态，按 \n 直接
 * 切会把那一行劈成两半——而进度那条恰恰是整行才有意义的。所以这里故意把一行切开发。
 */
async function progress() {
  const seen = []
  const script = 'printf "@@step 1/7 创建席位账号\n@@st"; sleep 0.05; printf "ep 2/7 安装桌面组件\nchrome: 已在位\n"'
  const r = await run('bash', ['-c', script], {
    timeout: 10_000,
    onLine: (line) => {
      const hit = stepOf(line)
      if (hit) seen.push(`${hit.step}/${hit.total} ${hit.label}`)
    },
  })
  return {
    steps: seen,
    stepCode: r.code,
    // 不是这个形状的一律不认：报进度这条路宁可什么都不说，也不能说一个编出来的数。
    stepBad: [stepOf('随便一行'), stepOf('@@step 9/7 越界'), stepOf('@@step x/7 坏数'), stepOf('@@step 1/0 零总数')],
  }
}

/**
 * 脚本里那几个 `step` 调用和 `STEPS` 对不对得上。
 *
 * 加一步却忘了改 `STEPS`，进度条会在中途就走到头然后停住——那正是它要治的病。这条
 * 检查很便宜，而它防的是一个只在真机上装十分钟才看得见的错。
 */
function scriptSteps() {
  const src = readFileSync(new URL('./src/seat/deploy-seat.sh', import.meta.url), 'utf8')
  const total = Number(/^STEPS=(\d+)$/m.exec(src)?.[1])
  const nums = [...src.matchAll(/^step (\d+) "([^"]+)"$/gm)].map((m) => Number(m[1]))
  return { scriptTotal: total, scriptNums: nums }
}

const long = (tag, n) => Array.from({ length: n }, (_, i) => `${tag}-${i}`).join(' ')

const out = {
  // 失败的那条命令什么都没打印，前面全是正常进度——真实发生过的形状。
  silentFailure: tailError({ code: 3, stdout: '建用户 … chrome: 已在位', stderr: '' }, 'deploy script exited 3'),
  // 两个流都空：只剩退出码。
  bothEmpty: tailError({ code: 137, stdout: '', stderr: '' }, 'deploy script exited 137'),
  // stderr 有东西时也不能把 stdout 整个丢掉——「走到哪儿了」在 stdout 里。
  bothStreams: tailError({ code: 1, stdout: '进度A 进度B', stderr: '第 42 行失败' }, 'x'),
  // 超长输出留尾不留头：原因在最后。
  longTail: tailError({ code: 1, stdout: long('OUT', 400) + ' 最后一句', stderr: '' }, 'x'),
  code0: tailError({ code: 0, stdout: '', stderr: '' }, '兜底'),
  ...verdicts(),
  ...owners(),
  ...pruning(),
  ...scriptSteps(),
  ...(await progress()),
}
console.log('__RESULT__' + JSON.stringify(out))
