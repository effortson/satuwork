import { hostname } from 'node:os'
import { bootConfig, managerVersion, PROTOCOL, patchState, readState, watchState, type ManagerState } from './config.ts'
import { HttpError, json, listen, Router, type Req } from './http.ts'
import { attachUpgrade, proxyIntercept } from './proxy.ts'
import { bootChallenge, pairIfNeeded } from './pair.ts'
import { diagnose } from './diag.ts'
import { botUnit, clampLines, followLogs, MANAGER_UNIT, recentLogs } from './logs.ts'
import { checkLogs, defaultKeepMb, logUsage, setDesiredCapMb, startLogWatch, vacuum } from './logdisk.ts'
import { metrics, startMetrics } from './metrics.ts'
import { SeatBusy, busy, deploySeat, removeSeat, seat, seatProgress, seatsWithLiveness, waitForDeploys, type SeatSpec } from './seats.ts'
import { confirmVersion, maybeUpgrade, refreshConfirmScript, upgradeDeferred, upgradeError } from './upgrade.ts'
import { currentTimezone, maybeSetTimezone, timezoneError } from './timezone.ts'
import { standDown } from './standdown.ts'

/**
 * 机器管家。一台席位机器一个，root systemd 服务。
 *
 * 它取代了 Gateway 的 SSH 部署路径：Gateway 不再持有任何能登录这台机器的凭据，
 * 只有一把可吊销的 `smt_`；席位的 bot 口和 noVNC 口全部收回 127.0.0.1，对外只剩
 * 管家这一个端口。
 *
 * 启动顺序是**先起 HTTP 再配对**——配对时 Gateway 会立刻回拨一次确认可达，
 * 服务没起来那次回拨必然失败。
 */

let state: ManagerState | undefined
const boot = bootConfig()

const token = () => state?.token ?? ''
const gatewayUrl = () => state?.gatewayUrl ?? boot.gatewayUrl

/**
 * 控制类接口的鉴权。
 *
 * **两个头都收**：Gateway 下发部署时用 `x-satuwork-machine`（反代那条路径上要和
 * 转给 bot 的 `authorization` 区分开），而 `/health` 和手工 curl 习惯用
 * `authorization`。只认一个的后果是「/health 通、部署 401」这种极难对上的现象。
 */
function requireMachine(req: Req): void {
  const given =
    String(req.headers['x-satuwork-machine'] || '') ||
    String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  const want = token()
  if (!want || given.length !== want.length) throw new HttpError(401, 'invalid machine credential')
  let diff = 0
  for (let i = 0; i < want.length; i++) diff |= given.charCodeAt(i) ^ want.charCodeAt(i)
  if (diff !== 0) throw new HttpError(401, 'invalid machine credential')
  // 票对了才听它说地址。顺序不能反——见 adoptGatewayUrl。
  adoptGatewayUrl(req)
}

/**
 * 地址的形状。`http(s)://host[:port]`，不许带路径、查询、用户名口令。
 *
 * 这个值会被拼成心跳、拉包、自升级的 URL 前缀，所以宁可挑剔：认不出来的一律当没说，
 * **保持原样**比采信一个半通不通的地址安全得多。
 */
function originOf(raw: string): string {
  const u = new URL(raw.trim())
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol')
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash || u.username || u.password) throw new Error('shape')
  return `${u.protocol}//${u.host}`
}

/**
 * 顺路认一下「Gateway 现在在哪」。
 *
 * **这是一个死结的唯一解法。** 管家手上那份 `gatewayUrl` 是配对那天写死的
 * （/etc/satuwork/manager.json）。Gateway 换了对外地址之后，心跳就一直打向一个不存在
 * 的地方——而更糟的是这件事**一个字都不会报**：打不通那一路是 `catch {}`（见
 * heartbeat），journal 里干干净净，界面上只有一盏「失联」灯。要告诉它新地址，唯一还
 * 通着的通道恰恰是它自己打不出去的那条的反方向：Gateway → 管家。那就从这条说。
 *
 * **信任面没有变大。** 这个头只有过了上面那道 `requireMachine` 才会被读到，也就是说
 * 说话的人拿得出 `smt_`；而部署请求的 body 里本来就带着 `gatewayUrl`，管家一直原样把
 * 它写进席位的 bot.env（见 seats.ts 的 deploySeat）。差别只是这一次它也写给自己。
 *
 * **改了就立刻敲一次门**：不然最坏要等满一轮心跳（低频那一档是 5 分钟）界面上才会
 * 变绿，而按按钮的人正盯着那盏灯。顺带把 401 计数清掉——换地址之后，之前那些拒收
 * 是上一任 Gateway 的事。
 */
function adoptGatewayUrl(req: Req): void {
  const raw = String(req.headers['x-satuwork-gateway-url'] || '').trim()
  if (!raw || !state) return
  let next: string
  try {
    next = originOf(raw)
  } catch {
    return
  }
  if (next === state.gatewayUrl) return
  const prev = state.gatewayUrl
  /**
   * **先落盘，再改内存。**
   *
   * 反过来的话，一次写不进去（盘满是这类机器上真会发生的事，logdisk.ts 存在的理由就是
   * 它）会留下最难查的那种状态：内存里已经是新地址、下一次调用因此提前 return，于是
   * **再也不会有第二次尝试**；界面上看着好了，重启回来 manager.json 还是旧地址，机器
   * 又一次静默失联——正是这条路要消灭的那类故障。
   *
   * 而且失败不该把调用方那次部署打成 500：那会让人去查一个根本不存在的部署故障。
   * 喊一句，然后当这次没听见——下一次调用还会再试。
   */
  // 走 patchState 而不是拿内存里那份整份写回：这份 state 是启动时读的，隔着不知多少
  // 轮心跳；整份写回会把 confirmVersion 刚落盘的 confirmedVersion 抹回旧值，回滚脚本
  // 随即把一次好端端的升级搬回去。补丁只动 gatewayUrl，内存由 watchState 那条同步。
  try {
    if (!patchState((s) => (s.gatewayUrl === next ? undefined : { gatewayUrl: next }))) return
  } catch (e) {
    console.error(
      `satuwork-manager: 收到新的 Gateway 地址 ${next}，但写不进 manager.json（${e instanceof Error ? e.message : String(e)}）。` +
        '这次不改，仍按旧地址心跳；盘满或文件系统只读的话先处理那个。',
    )
    return
  }
  authFails = 0
  if (idled) {
    idled = false
    retime(HEARTBEAT_MS)
  }
  console.log(`satuwork-manager: Gateway 换地址了 ${prev} → ${next}（由一次带机器票的入站调用告知），立刻按新地址敲一次心跳`)
  void heartbeat()
}

function strField(body: unknown, key: string): string {
  const v = (body as Record<string, unknown>)?.[key]
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${key} is required`)
  return v.trim()
}

/**
 * 标识符的形状。**不是**照抄 Gateway 的 sha256 命名（那样两边就得锁版本升级），
 * 只保证它能安全地当目录名和 systemd 单元实例名用：没有 `/`、没有 `.`（也就没有
 * `..`）、没有空白和 shell 元字符、长度有上限。
 */
const IDENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
/** botId 是 Gateway 的 catalog id（randomUUID 或 `default`），允许点但不许 `..`。 */
const BOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** 和 releases.ts 的 safeVersion 同一套口径。 */
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/

/**
 * 单行字符串。这些值最后会被 heredoc 原样写进 `bot.env`，**一个换行就能在里面多插
 * 一行环境变量**（比如再塞一个 GATEWAY_URL 把上报引到别处），所以控制字符一律不收。
 */
function line(body: unknown, key: string, max = 512): string {
  const v = strField(body, key)
  if (v.length > max || /[\u0000-\u001f\u007f]/.test(v)) throw new HttpError(400, `${key} is invalid`)
  return v
}

function shaped(value: string, re: RegExp, key: string): string {
  if (!re.test(value) || value.includes('..')) throw new HttpError(400, `${key} is invalid`)
  return value
}

/**
 * 请求体 → 席位规格。
 *
 * 这是**网络边界**，不是 Gateway 的内部函数调用：管家以 root 跑 `deploy-seat.sh`，
 * 下面每个值都会变成 root 的 mkdir/chown 目标、systemd 单元里的字段、或者 bot.env
 * 里的一行。所以：标识符按形状校验，**路径一律不收外部值**、由已校验的标识符重新
 * 推出来（和 gateway/src/deploy.ts 的 homeDirOf/workDirOf/seatDirOf 同一套规则）。
 *
 * 以前这里只有「是非空字符串」，`homeDir: "/etc"` 就能让 root 去 chown /etc。
 */
function specOf(rawSeatId: string, body: unknown): SeatSpec {
  const b = (body ?? {}) as Record<string, unknown>
  const ports = (b.ports ?? {}) as Record<string, unknown>
  const port = (k: string) => {
    const n = Number(ports[k])
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new HttpError(400, `ports.${k} is invalid`)
    return n
  }
  const seatId = shaped(rawSeatId.trim(), IDENT_RE, 'seatId')
  const linuxUser = shaped(line(b, 'linuxUser', 64), IDENT_RE, 'linuxUser')
  const homeDir = `/home/${linuxUser}`
  const workDir = `${homeDir}/work`
  const seatDir = `${homeDir}/.satuwork/${seatId}`
  // 路径由上面推出来，body 里那三个字段只用来**对账**：对得上就往下走，对不上就 400。
  // 不采信是安全底线；但也不能默默忽略——Gateway 哪天改了目录布局，静默忽略会把席位
  // 建到一个双方都以为不是那儿的地方，报错才看得见。deploy-seat.sh 里那三条 [ ] 判断
  // 是同一套规则的第二层，给手工调用兜底。
  const expect: Record<string, string> = { homeDir, workDir, seatDir }
  for (const [key, want] of Object.entries(expect)) {
    const got = line(b, key)
    if (got !== want) throw new HttpError(400, `${key} must be ${want}`)
  }
  return {
    seatId,
    linuxUser,
    homeDir,
    workDir,
    seatDir,
    botId: shaped(line(b, 'botId', 64), BOT_ID_RE, 'botId'),
    botVersion: shaped(line(b, 'botVersion', 64), VERSION_RE, 'botVersion'),
    vncPassword: line(b, 'vncPassword', 256),
    gatewayUrl: line(b, 'gatewayUrl'),
    gatewayToken: line(b, 'gatewayToken'),
    gatewayApiKey: line(b, 'gatewayApiKey'),
    ports: {
      display: port('display'),
      vncPort: port('vncPort'),
      novncPort: port('novncPort'),
      botPort: port('botPort'),
      cdpPort: port('cdpPort'),
    },
    // 人手工按的「重新部署」。只有它能跳过换版前的排空——自动跟版、模版下发都跳不过去。
    interrupt: b.interrupt === true,
    // 调用方给的排空预算（毫秒）。**不校验形状**，drainWindowMs 收到非数就回落到本机
    // 上限，而且两者取小——这个字段只能让排空更短，越不了机器自己的界。
    ...(b.drainMs == null ? {} : { drainMs: Number(b.drainMs) }),
  }
}

/**
 * 最后一道兜底：**一条请求处理不了，不该把管家带走。**
 *
 * 同 gateway/src/index.ts 那段。这里更要紧一点：管家是这台机器上所有席位的控制面，
 * 它一退出，部署、日志、桌面、心跳全断，而席位自己还跑着——从 Gateway 看过去就是
 * 「整台机器失联」，最难查的那种。
 *
 * 只记不退。真正坏掉的状态会在各自的路径上暴露，不靠进程自杀来通知人。
 */
process.on('unhandledRejection', (reason) => {
  const e = reason as Error
  console.error(`satuwork-manager: 未处理的 rejection ${e?.stack ?? String(reason)}`)
})
process.on('uncaughtException', (e) => {
  console.error(`satuwork-manager: 未捕获异常 ${e.stack ?? e.message}`)
})

const router = new Router()
router.intercept(proxyIntercept({ machineToken: token, gatewayUrl }))

router.get('/health', async (req, res) => {
  // 配对回拨走 challenge，不走 smt_：那一刻票还在 Gateway 手里，管家还没收到响应。
  const challenge = req.query.get('challenge')
  if (!challenge || challenge !== bootChallenge) requireMachine(req)
  json(res, 200, {
    ok: true,
    managerVersion: managerVersion(),
    protocol: PROTOCOL,
    node: process.versions.node,
    hostname: hostname(),
    paired: Boolean(state),
    dryRun: boot.dryRun,
    upgradeError: upgradeError() || null,
    // 换版在等席位把会话跑完（见 upgrade.ts 的 seatsIdleEnough）。**和 upgradeError
    // 分开报**：等不是错，混进 lastError 会在界面上变成一行红字，而这台机器好好的。
    // 没在等就是 null——「界面上说 pending，机器上什么也没发生」得有个地方答得上。
    upgradeDeferred: upgradeDeferred(),
    // 时区分两件事报：机器现在是什么时区、上一次改时区为什么没改上。合成一个字段
    // 的话，「没指定过」和「指定了但改失败」在外面看着一样。
    timezone: currentTimezone() || null,
    timezoneError: timezoneError() || null,
    // 负载和日志占用都读**最近一次采样**，不现算：CPU 和出网速率是两次采样之差，
    // 现算给不出数；量一遍 /var/log 要走几千个文件，不该挂在一条探活路由上。
    metrics: metrics() ?? null,
    logs: logUsage() ?? null,
    seats: await seatsWithLiveness(),
  })
})

/**
 * 机器负载与日志占用。
 *
 * 心跳里已经带着同一份了——这条路给的是「我现在就想看」：心跳 30 秒一轮，而人盯着
 * 一台正在出事的机器时，等下一轮和等一分钟没区别。
 */
router.get('/metrics', async (req, res) => {
  requireMachine(req)
  json(res, 200, { metrics: metrics() ?? null, logs: logUsage() ?? null })
})

/**
 * 立刻清一次日志。平时不需要按——超过上限时看守自己会清（见 logdisk.ts）。
 *
 * 它存在是为了两种时候：盘已经快满了，等不了下一轮检查；以及刚把上限调小，想当场
 * 看到效果。`keepMb` 不给就用和自动清理同一个目标，免得两条路清出两种结果。
 */
router.post('/logs/vacuum', async (req, res) => {
  requireMachine(req)
  const raw = (req.body as { keepMb?: unknown })?.keepMb
  const keep = raw == null ? defaultKeepMb() : Number(raw)
  if (!Number.isFinite(keep) || keep < 0) throw new HttpError(400, 'keepMb is invalid')
  json(res, 200, { vacuum: await vacuum(keep), logs: logUsage() ?? null })
})

router.get('/seats', async (req, res) => {
  requireMachine(req)
  json(res, 200, { seats: await seatsWithLiveness() })
})

/**
 * 一个席位的现场快照。**只读**，见 diag.ts 开头。
 *
 * 没有 SSH 的代价就是「机器上到底怎么了」谁也看不见，而这一层最贵的故障恰恰都不报错
 * （端口被别人占、服务没真重启、dock 少一格）。这条路让那些只能靠 ps/ss/journal 看出
 * 来的东西，隔着 Gateway 也能拿到。
 */
router.get('/seats/:seatId/diag', async (req, res) => {
  requireMachine(req)
  const lines = Number(req.query.get('lines') || 40)
  json(res, 200, { diag: await diagnose(req.params.seatId, Number.isFinite(lines) ? lines : 40) })
})

/**
 * 这个席位这会儿装到第几步了。**装的过程中问，装完就没有了。**
 *
 * 不认名册（和 diag / logs 那两条不同）：新席位第一次装的时候名册里**本来就还没有
 * 它**——那一行要等脚本跑完才写下（见 doDeploy 的 commit）。而「第一次装」恰恰是这条
 * 路唯一真正要用的时刻，按名册拦就等于永远 404。
 *
 * 没在装（或者这台机器上那个脚本还没报出第一行）回 `progress: null`，不是 404：调用
 * 方要分得清「问不到」和「问错了」，前者照旧画粗进度，后者才是个 bug。
 */
router.get('/seats/:seatId/progress', async (req, res) => {
  requireMachine(req)
  json(res, 200, { seatId: req.params.seatId, progress: seatProgress(req.params.seatId) ?? null })
})

/**
 * 席位 bot 的运行日志。`?follow=1` 跟着滚（SSE），否则给最近 N 行。
 *
 * diag 那条能回答「它活着吗」，回答不了「它卡在哪一步」——而这一层最贵的故障恰恰
 * 都不报错：单元 active、端口有人听，只是那一轮永远不结束。没有这条路，每查一次都
 * 得请人登机器。
 *
 * seatId 先在名册里查，查不到就 404：unit 名是拿它拼的，只让已知席位过去，就不存在
 * 「拼出别的单元」这件事（spawn 本来也走参数数组，不过 shell）。
 */
router.get('/seats/:seatId/logs', async (req, res) => {
  requireMachine(req)
  const seatId = req.params.seatId
  if (!seat(seatId)) throw new HttpError(404, '没有这个席位')
  const lines = clampLines(req.query.get('lines'))
  if (req.query.get('follow') === '1') return followLogs(botUnit(seatId), lines, res)
  json(res, 200, { seatId, lines: await recentLogs(botUnit(seatId), lines) })
})

/**
 * 管家自己的日志。平台端排查「这台机器怎么了」看的是它——部署失败、升级卡住、
 * 配对回拨不通，这些都写在管家的 journal 里，席位的日志里一个字都没有。
 */
router.get('/logs', async (req, res) => {
  requireMachine(req)
  const lines = clampLines(req.query.get('lines'))
  if (req.query.get('follow') === '1') return followLogs(MANAGER_UNIT, lines, res)
  json(res, 200, { unit: MANAGER_UNIT, lines: await recentLogs(MANAGER_UNIT, lines) })
})

router.put('/seats/:seatId', async (req, res) => {
  requireMachine(req)
  try {
    const row = await deploySeat(specOf(req.params.seatId, req.body), token())
    json(res, row.status === 'ready' ? 200 : 502, { seat: row })
  } catch (e) {
    /**
     * 席位上还有会话在跑，等过了也没等到它结束。**这不是失败**：机器上一个字节都没
     * 动，席位还是原来那个版本、还在好好地跑。所以回 409（不是 502），并且带一个
     * `busy: true` 让 Gateway 认得出来——它据此保留原来的状态，而不是把这一行标红。
     */
    if (e instanceof SeatBusy) {
      json(res, 409, { error: e.message, busy: true, seat: seat(req.params.seatId) ?? null })
      return
    }
    throw e
  }
})

router.delete('/seats/:seatId', async (req, res) => {
  requireMachine(req)
  if (!seat(req.params.seatId)) throw new HttpError(404, 'no such seat')
  await removeSeat(req.params.seatId)
  json(res, 200, { ok: true })
})

/**
 * 自检模式：起一次、答一次、退出。自升级换版之前由**旧**管家跑新版本的这一条，
 * 用来挡住「包坏了 / 语法错 / 依赖缺失」。它不连 Gateway，也不碰任何持久状态。
 */
if (process.argv.includes('--selftest')) {
  const server = listen(router, '127.0.0.1', 0)
  await new Promise((r) => server.once('listening', r))
  const port = (server.address() as { port: number }).port
  const res = await fetch(`http://127.0.0.1:${port}/health?challenge=${encodeURIComponent(bootChallenge)}`)
  server.close()
  if (!res.ok) {
    console.error(`satuwork-manager: selftest failed ${res.status}`)
    process.exit(1)
  }
  console.log(`satuwork-manager: selftest ok ${managerVersion()}`)
  process.exit(0)
}

const server = listen(router, boot.host, boot.port)
attachUpgrade(server, { machineToken: token, gatewayUrl })

state = readState()
// 磁盘是唯一的真相：谁通过 patchState 改了 manager.json，内存这份就跟着换。少了这条，
// 三处各自写盘的老毛病只是换了个地方——内存里的旧快照下一次照样覆盖回去。
watchState((s) => {
  state = s
})
if (!state) {
  try {
    const out = await pairIfNeeded(boot)
    state = out?.state
    console.log('satuwork-manager: ' + (out?.message ?? 'not paired'))
  } catch (e) {
    console.error('satuwork-manager: ' + (e instanceof Error ? e.message : String(e)))
  }
} else {
  console.log(`satuwork-manager: paired machineId=${state.machineId} -> ${state.gatewayUrl}`)
}

// 兜底脚本跟着包走，每次启动刷一遍——它装在 /usr/local/bin，不刷的话机器装好那天是
// 什么样就一直是什么样，改了也只有重装才拿得到。dryRun 下不碰宿主机的 /usr/local/bin。
if (!boot.dryRun) refreshConfirmScript()

// 负载采样和日志看守**在配对之前就起**：这两件事只关乎这台机器本身，不需要 Gateway
// 同意。一台还没配上（或者被移除之后还没人来收拾）的机器，日志照样在涨。
startMetrics()
startLogWatch()

const HEARTBEAT_MS = 30_000

/**
 * 连续多少次 401 之后认定「Gateway 不认这台机器了」。10 轮 = 5 分钟。
 *
 * **401 只降频加报警，不自毁**：它是否定式信号，分不出「我被移除了」和「Gateway
 * 那边出了状况」。真正的移除走的是心跳回包里的 `removed: true`（见 standDown）。
 * 这一路是兜底——Gateway 要是老版本、或者那行记录被人直接从库里删了，管家至少不会
 * 每 30 秒空敲到天荒地老，而且 journal 里有一句说得清的话。
 */
const AUTH_FAIL_LIMIT = 10
/** 认定失联之后的心跳间隔。不彻底停：Gateway 恢复了还能自己接回来。 */
const IDLE_HEARTBEAT_MS = 5 * 60_000
let authFails = 0
let idled = false

async function heartbeat(): Promise<void> {
  if (!state) return
  try {
    const res = await fetch(`${state.gatewayUrl}/internal/machines/${encodeURIComponent(state.machineId)}/heartbeat`, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + state.token, 'content-type': 'application/json' },
      body: JSON.stringify({
        managerVersion: managerVersion(),
        protocol: PROTOCOL,
        node: process.versions.node,
        // Gateway 按它挑发布包。包里带 esbuild 的原生二进制，架构不对就起不来。
        arch: process.arch,
        // 自报**实际**时区。Gateway 拿它和期望时区比，界面上才分得出「已经改上了」
        // 和「指令下了、还没改上」。
        timezone: currentTimezone() || null,
        // 升级和改时区都可能失败，而 Gateway 只有一格 lastError。升级失败更要命
        // （机器版本会卡住），所以它优先；两者都好的时候这里是 null。
        upgradeError: upgradeError() || timezoneError() || null,
        // 负载和日志占用**搭心跳上报**，不另开一条上行：机器本来就每 30 秒敲一次门，
        // 再加一条定时 POST 只是多一个会失败、会重试、会被防火墙拦住的东西。
        metrics: metrics() ?? null,
        logs: logUsage() ?? null,
        seats: await seatsWithLiveness(),
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      // 401/403 = Gateway 不认这把票了。别的状态码（5xx、502）是它自己的毛病，
      // 不该算在这个账上，否则一次 Gateway 重启就会把整队机器推进「失联」。
      if (res.status === 401 || res.status === 403) onAuthFail()
      return
    }
    authFails = 0
    if (idled) {
      idled = false
      retime(HEARTBEAT_MS)
      console.log('satuwork-manager: Gateway 又认得这台机器了，心跳恢复正常间隔')
    }
    // 心跳通了才算「这个版本活过来了」。confirm timer 看的就是这个标记。
    confirmVersion()
    const reply = (await res.json()) as { timezone?: string | null; removed?: boolean; logCapMb?: number | null }
    // 被移除了：停席位、清配对、停自己。这一支之后不再做别的活儿。
    if (reply.removed) {
      clearInterval(timer)
      await standDown(state, boot.dryRun)
      return
    }
    // 日志上限改了就当场量一遍：把上限从 4G 调到 500M 的人，等的就是那一下，
    // 而定时检查半小时才轮一次。没改就不动——每轮心跳都走一遍 /var/log 太贵。
    if (setDesiredCapMb(reply as Record<string, unknown>)) await checkLogs()
    // 时区在前：它便宜、不重启进程，而 maybeUpgrade 成功那一支会把自己重启掉，
    // 排在它后面的活儿这一轮就不一定跑得到了。
    await maybeSetTimezone(reply.timezone)
    await maybeUpgrade(reply as Record<string, never>, state.token)
  } catch {
    /* 网络抖动不值得刷屏；下一轮再试。 */
  }
}

void heartbeat()
let timer = setInterval(() => void heartbeat(), HEARTBEAT_MS)

/** 换心跳间隔。`timer` 是 let，shutdown 那边照旧 clearInterval 得到当前这一个。 */
function retime(ms: number): void {
  clearInterval(timer)
  timer = setInterval(() => void heartbeat(), ms)
}

/**
 * 连着被拒了几次。到阈值就说一句话、把心跳降到低频。
 *
 * 只说一次：每 5 分钟往 journal 刷同一行，等于没说。
 */
function onAuthFail(): void {
  authFails += 1
  if (authFails !== AUTH_FAIL_LIMIT) return
  idled = true
  retime(IDLE_HEARTBEAT_MS)
  console.error(
    'satuwork-manager: Gateway 连续拒收心跳（401）。多半是这台机器已经在平台上被移除，' +
      '或者这把机器票被吊销了。席位还在跑，不会自动停——要下线这台机器，' +
      '在上面跑 `systemctl disable --now satuwork-manager` 并拆掉席位；要重新接回去，重跑一次配对。' +
      `心跳已降到 ${IDLE_HEARTBEAT_MS / 60_000} 分钟一次。`,
  )
}

let closing = false
/**
 * 有部署在跑时最多等多久再退出。
 *
 * deploy-seat.sh 一跑十几分钟，进程半路退出会把建了一半的席位连同那条挂着的 PUT 一起
 * 打断——而 KillMode=process 意味着脚本本身还会作为孤儿跑完，只是没人收结果、名册上
 * 也不会落那一行。**注意 unit 里的 TimeoutStopSec 得跟着放大**（模板在
 * gateway/src/install.ts，现在是 15 秒）：systemd 到点就 SIGKILL，这里等多久都没用。
 */
const SHUTDOWN_DEPLOY_WAIT_MS = 20 * 60_000
function shutdown() {
  if (closing) return
  closing = true
  clearInterval(timer)
  // 短暂 drain：停止接受新连接，给在途请求几秒。换版重启时聊天 SSE 会断，UI 侧靠
  // ?after=N 游标自己接回来。
  server.close()
  void (async () => {
    // 没有部署在跑时行为和以前一模一样：3 秒后退出。
    if (busy()) {
      console.log(`satuwork-manager: 收到停止信号，但有席位部署还在跑，等它结束（最多 ${SHUTDOWN_DEPLOY_WAIT_MS / 60_000} 分钟）再退出`)
      await waitForDeploys(SHUTDOWN_DEPLOY_WAIT_MS)
    }
    setTimeout(() => process.exit(0), 3000).unref()
  })()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
