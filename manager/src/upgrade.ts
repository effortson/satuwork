import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installRoot, managerVersion, patchState, readState, seatAssets } from './config.ts'
import { sameOrigin } from './releases.ts'
import { run } from './run.ts'
import { busy, busySeats } from './seats.ts'

/**
 * 自升级。
 *
 * 删掉 SSH 之后这是必做项：管家不能自己换版，就意味着每次更新都要有人跑到每台机器
 * 前面。心跳驱动而不是 Gateway 推送——推送要求推的那一刻机器在线且可达，心跳驱动
 * 只要机器最终上线就会收敛，灰度也只是改一个数字。
 *
 *   /opt/satuwork/manager/releases/<version>/
 *   /opt/satuwork/manager/current  -> releases/X   systemd ExecStart 指这里
 *   /opt/satuwork/manager/previous -> releases/W   回滚指回它
 *
 * 每一步失败都就地放弃、把原因报回心跳、**不动 current**。
 */

export interface UpgradeOffer {
  desiredManagerVersion?: string
  url?: string
  sha256?: string
  minNode?: number
}

let lastError = ''
let upgrading = false

/**
 * 被回滚脚本搬回来之后最多再试几次。
 *
 * 只对「新版本起来了、宽限期内没连上 Gateway」这一种成因：那多半是网络在那几分钟里
 * 抖了，再试一次很可能就过。VERSION 对不上是确定性的，一次都不重试。次数记在
 * state.upgradeRetries 里，重启也丢不掉。
 */
const ROLLBACK_RETRY_MAX = 3

export const upgradeError = () => lastError

/**
 * 有席位在跑会话时，换版最多推迟多久。默认 30 分钟，`SATUWORK_UPGRADE_DEFER_MS` 可调，
 * 0 = 不等。
 *
 * **必须有个头。** 管家换版会重启自己，而 Gateway 到席位的每一跳都从它身上过——正在
 * 说的那句话会断（浏览器那头会自己接回来，见 gateway/ui/chat.js 的退避重连，但那一
 * 下人是看得见的）。所以能等就等。可是一台天天有人用的机器上，「所有席位都空着」的
 * 时刻可能整天都不出现，无限等下去就等于这台机器再也不升级了——而升级里往往正躺着
 * 修这类问题的补丁。到点就换，并且把「等过、没等到」写进 journal。
 */
function deferWindowMs(): number {
  const raw = Number(process.env.SATUWORK_UPGRADE_DEFER_MS)
  return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 30 * 60_000
}

/** 正在为哪个版本等、从什么时候开始等。换了目标版本要重新计时。 */
let deferring: { version: string; since: number; seats: string[] } | null = null

/** 界面/curl 看得见的那份「在等什么」。**不进 lastError**：等不是错。 */
export const upgradeDeferred = () =>
  deferring ? { version: deferring.version, sinceMs: Date.now() - deferring.since, seats: deferring.seats } : null

/**
 * 现在能不能换版：席位上有活就先不换。
 *
 * 等到 deferWindowMs 为止。**探不出来不算忙**（见 seatBusyNow）——一次超时不该把这台
 * 机器永远钉在旧版本上。
 */
async function seatsIdleEnough(want: string): Promise<boolean> {
  const hold = deferWindowMs()
  if (hold === 0) return true
  const hits = await busySeats()
  if (!hits.length) {
    if (deferring) {
      console.log(`satuwork-manager: 席位都空下来了，接着换到 ${deferring.version}（等了 ${Math.round((Date.now() - deferring.since) / 1000)} 秒）`)
      deferring = null
    }
    return true
  }
  // 换了目标版本就重新计时：新的那个包可能正是来修眼下这件事的。
  if (!deferring || deferring.version !== want) deferring = { version: want, since: Date.now(), seats: [] }
  deferring.seats = hits.map((h) => h.seatId)
  const waited = Date.now() - deferring.since
  if (waited >= hold) {
    console.warn(
      `satuwork-manager: 等了 ${Math.round(waited / 1000)} 秒，席位 ${deferring.seats.join('、')} 还在跑会话；不再等了，现在换到 ${want}`,
    )
    deferring = null
    return true
  }
  // 每一轮心跳都打一行会把 journal 灌满（30 秒一轮）。只在开始等的那一轮说一次。
  if (waited < 1000) {
    console.log(`satuwork-manager: 席位 ${deferring.seats.join('、')} 有会话在跑，等它们跑完再换到 ${want}`)
  }
  return false
}

function nodeMajor(): number {
  return Number((process.versions.node || '0').split('.')[0]) || 0
}

/** 先建临时链接再 rename：换版这一步必须是原子的，否则断电会留下一个指向空处的 current。 */
function relink(name: string, target: string): void {
  const root = installRoot()
  const tmp = join(root, `.${name}.tmp`)
  rmSync(tmp, { force: true })
  symlinkSync(target, tmp)
  renameSync(tmp, join(root, name))
}

/**
 * 把回滚脚本刷成自己包里的这一份。
 *
 * **这是让这类兜底脚本修得动的唯一办法。** 它装在 /usr/local/bin，由装机脚本写下——
 * 也就是说机器装好那天是什么样，以后就一直是什么样。里面出过一个竞态（见
 * src/seat/manager-confirm.sh 开头），要是只改装机脚本，现有机器得**重装**才拿得到
 * 修复，而重装是这套架构里最不想做的事。跟着包走、每次启动刷一遍，一次正常升级就
 * 到位了。
 *
 * 只在内容不同时写，省掉每次启动一次无谓的写盘；写不动（只读根、权限不对）就算了，
 * 记一行日志——它是兜底，不该反过来把管家启动搞挂。
 */
export function refreshConfirmScript(): void {
  const src = join(seatAssets(), 'manager-confirm.sh')
  const dst = '/usr/local/bin/satuwork-manager-confirm.sh'
  try {
    const want = readFileSync(src, 'utf8')
    let have = ''
    try {
      have = readFileSync(dst, 'utf8')
    } catch {
      /* 还没有就是要写。 */
    }
    if (have === want) return
    writeFileSync(dst, want, { mode: 0o755 })
    console.log('satuwork-manager: 已更新回滚脚本 ' + dst)
  } catch (e) {
    console.error('satuwork-manager: 回滚脚本没刷成：' + (e instanceof Error ? e.message : String(e)))
  }
}

/** 回滚脚本留下的记号：它把 current 从哪个版本搬回去了。见 src/seat/manager-confirm.sh。 */
function rolledBackPath(): string {
  return join(installRoot(), 'rolled-back')
}

function rolledBackFrom(): string {
  try {
    return readFileSync(rolledBackPath(), 'utf8').trim()
  } catch {
    return ''
  }
}

function currentTarget(): string {
  try {
    return readlinkSync(join(installRoot(), 'current'))
  } catch {
    return ''
  }
}

export async function maybeUpgrade(offer: UpgradeOffer, token: string): Promise<void> {
  const want = (offer.desiredManagerVersion || '').trim()
  if (!want || want === managerVersion() || upgrading) return
  if (!/^[A-Za-z0-9._+-]{1,64}$/.test(want) || want.startsWith('.')) return
  // 部署跑到一半换版会重启进程，把建了一半的席位一起打断。等下一轮心跳。
  if (busy()) return

  // 熔断：上次已经换到过这个版本，重启回来自报的却还是别的。再试也是一样的结果，
  // 而每试一次就重启一次、掐断一次聊天。停手，把原因报上去。
  //
  // **原因有两种，处置完全不同，所以必须分开说。** 早先这里一律报成「发布包里的
  // VERSION 写错了」，而更常见的其实是另一种：回滚脚本把 current 搬回去了。那时人
  // 会照着这句话去查打包链路，怎么查都是对的——真正该看的是那台机器连不连得上
  // Gateway。分不出来就不要猜：回滚脚本会留一个记号，认它。
  //
  // 回滚这一种再细分：心跳不通可能只是网络抖了几分钟，允许 ROLLBACK_RETRY_MAX 次重试
  // （次数在 state 里，见 config.ts 的 upgradeRetries）；VERSION 对不上才是一次都不再试。
  const state = readState()
  let retrying = false
  if (state?.lastUpgradeTo === want) {
    if (rolledBackFrom() !== want) {
      lastError = `已换到 ${want} 但进程自报 ${managerVersion()}：发布包里的 VERSION 和登记的版本号不一致，不再重试`
      return
    }
    if (state.upgradeRetries >= ROLLBACK_RETRY_MAX) {
      lastError = `升级到 ${want} 之后被回滚了 ${state.upgradeRetries + 1} 次：新版本起来了，但没能在宽限期内连上 Gateway。现在跑的是 ${managerVersion()}，不再自动重试——先查这台机器到 Gateway 的网络。`
      return
    }
    retrying = true
    console.warn(`satuwork-manager: 升级到 ${want} 之后被回滚过（第 ${state.upgradeRetries + 1} 次），再试一次，最多 ${ROLLBACK_RETRY_MAX} 次`)
  }

  // Node 太老就**不升**。升到起不来比不升坏得多——没有 SSH 可以救。
  if (offer.minNode && nodeMajor() < offer.minNode) {
    lastError = `needs Node ${offer.minNode}+, this box has ${process.versions.node}; re-run the installer`
    return
  }
  if (!offer.url) return
  /**
   * 席位上有人正在说话就先不换。
   *
   * **排在最后一道闸**：上面那几条（熔断、Node 太老、没有包）压根不会换版，为一个
   * 换不了的版本去等半小时，只会让 journal 里多出一串看不懂的「在等」。
   */
  if (!(await seatsIdleEnough(want))) return

  upgrading = true
  try {
    const root = installRoot()
    const dir = join(root, 'releases', want)
    mkdirSync(join(root, 'releases'), { recursive: true })

    // 机器票只交给 Gateway 自己：包地址是心跳回包里给的，origin 和配对的 gatewayUrl
    // 对不上就裸拉——票是这台机器的身份，不能因为一行回包就寄到别处去。
    const res = await fetch(offer.url, {
      headers: sameOrigin(offer.url, state?.gatewayUrl) ? { authorization: 'Bearer ' + token } : {},
      signal: AbortSignal.timeout(300_000),
    })
    if (!res.ok) throw new Error(`downloading the manager package failed: ${res.status}`)
    const bytes = Buffer.from(await res.arrayBuffer())
    // **没有校验和就不装。** 这个包解开之后是以 root 跑的，而自检只证明它起得来、
    // 证明不了它是我们发的那一个。Gateway 侧 sha256 是入库时自己算的（见
    // gateway/src/releases.ts），一条正常的升级要约必然带着它——空的意味着这一跳上
    // 有人把它拿掉了，或者上游根本不是我们以为的那个。
    if (!offer.sha256) throw new Error('the manager package came without a checksum, refusing to install')
    const got = createHash('sha256').update(bytes).digest('hex')
    if (got !== offer.sha256) throw new Error('manager package checksum mismatch')

    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const tgz = join(root, `.${want}.tgz`)
    writeFileSync(tgz, bytes)
    try {
      const untar = await run('tar', ['-xzf', tgz, '-C', dir], { timeout: 300_000 })
      if (untar.code !== 0) throw new Error('cannot untar the manager package')
    } finally {
      rmSync(tgz, { force: true })
    }

    const entry = join(dir, 'bin', 'satuwork-manager.mjs')
    if (!existsSync(entry)) throw new Error('manager package has no bin/satuwork-manager.mjs')

    // 自检：让新版本自己起一次、答一次 /health、退出。挡掉「包坏了 / 语法错 /
    // 依赖缺失」这一类——占换版事故的绝大多数。它证明不了「能连上 Gateway」，
    // 那一层由 confirm timer 兜。
    const self = await run(process.execPath, ['--import', 'tsx', entry, '--selftest'], {
      timeout: 60_000,
      // cwd 必须是新版本自己的目录：`--import tsx` 是裸说明符，Node 按工作目录解析，
      // 不按脚本位置。少了这一行，自检会以 ERR_MODULE_NOT_FOUND 失败，而真正的原因
      // 和包本身没关系——换版会被永远挡在这一步。
      cwd: dir,
      env: { SATUWORK_MANAGER_PORT: '0', SATUWORK_MANAGER_HOST: '127.0.0.1' },
    })
    if (self.code !== 0) throw new Error(`selftest of the new build failed: ${(self.stderr || self.stdout).slice(-200)}`)

    // 下载、解包、自检加起来能有几分钟，这期间完全可能来了一条部署。动 current 之前
    // 再问一次：换了链接就要重启，把跑了一半的 deploy-seat.sh 打断。放弃这一轮，
    // 下一轮心跳再来（包会重拉一次，比打断一次部署便宜得多）。不算错，不进 lastError。
    if (busy()) {
      console.log(`satuwork-manager: ${want} 已经自检通过，但此刻有席位在部署，这轮先不换`)
      return
    }

    const prev = currentTarget()
    if (prev) relink('previous', prev)
    /**
     * **先真的换，再记账。**
     *
     * 原来的顺序是反的：`lastUpgradeTo = want` 先落盘，然后才 `relink('current')`。
     * 那一步要是抛了（盘满、权限、目录被人动过），库里记着「已经换到 want」而
     * `current` 还指着旧的——下一次心跳走到上面那道熔断，看到「说是换到了 want、进程
     * 自报的却是旧版本」，于是把这个版本永久拉黑，而它其实一次都没被换上过。
     *
     * 反过来记的风险是「换成功了但没记上」：那种情况下一次心跳只会再试一遍同一个
     * 版本，收敛得掉。宁可重试，不要假的黑名单。
     */
    relink('current', dir)
    // 时刻是给回滚脚本用的——它靠这个才分得出「连不上 Gateway」和「还没来得及起来」。
    // patchState 现读现写：这里离函数开头那次 readState 已经隔了好几分钟，整份写回会把
    // 期间落盘的别的字段（confirmedVersion、gatewayUrl）抹掉。重试计数只在「同一个版本
    // 被回滚后再试」时加一，换了目标版本就归零。
    // 记下改之前的两个值：下面发不出重启的话要原样放回去。
    let wasTo = ''
    let wasRetries = 0
    patchState((s) => {
      wasTo = s.lastUpgradeTo
      wasRetries = s.upgradeRetries
      return {
        lastUpgradeTo: want,
        lastUpgradeAt: Date.now(),
        upgradeRetries: retrying && s.lastUpgradeTo === want ? s.upgradeRetries + 1 : 0,
      }
    })

    // 重启必须由**分离的**单元发起：管家的子进程去 systemctl restart 会连自己一起
    // 被杀（同一个 cgroup），命令根本发不出去。瞬态单元跳出去。
    // 工人和管家同一个包、同一份 current 软链，一起重启。老机器上没有工人单元：systemctl
    // 对不存在的单元只是报一句、别的照常，管家自己的重启不受影响。
    //
    // `--collect`：瞬态单元要是失败了，systemd 默认把它留在 failed 态，同名的下一次
    // systemd-run 会以「单元已存在」被拒——从此每一轮换版都发不出重启。收掉它。
    // 前面再 reset-failed 一次是给老机器兜底（没带 --collect 的旧版本留下的残骸）；
    // 单元不存在时它只是报一句，不算错。
    await run('systemctl', ['reset-failed', 'satuwork-manager-restart.service'], { timeout: 10_000 }).catch(() => {})
    const r = await run('systemd-run', [
      '--on-active=2s',
      '--collect',
      '--unit=satuwork-manager-restart',
      'systemctl',
      'restart',
      'satuwork-manager.service',
      'satuwork-worker.service',
    ], { timeout: 15_000 })
    if (r.code !== 0) {
      /**
       * 重启没发出去，进程还是旧版本在跑。**把机器放回换之前的样子**：current 指回
       * 旧目录，lastUpgradeTo / upgradeRetries 放回原值，回滚记号也没动（它在下面才清）。
       *
       * 不能只报错不回退：state 里记着「已换到 want」而进程自报旧版本，下一次心跳走到
       * 上面那道熔断就成了「VERSION 不一致，不再重试」——把一个只是 systemd-run 抽了
       * 一下的版本永久拉黑。放回去之后，下一次心跳会把这轮从头再来一遍（包重拉一次），
       * 收敛得掉。
       */
      if (prev) relink('current', prev)
      patchState(() => ({ lastUpgradeTo: wasTo, upgradeRetries: wasRetries }))
      throw new Error(`systemd-run for the restart failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(-200)}`)
    }
    // 上一次回滚的记号跟这次无关了，清掉；留着会让下一次熔断报出错的原因。
    // 排在重启真的发出去之后：发不出去的那条路要靠它才认得出「这是回滚后的重试」。
    rmSync(rolledBackPath(), { force: true })
    lastError = ''
    console.log(`satuwork-manager: swapped to ${want}, restarting in 2s`)
  } catch (e) {
    lastError = (e instanceof Error ? e.message : String(e)).slice(0, 300)
    console.error('satuwork-manager: upgrade failed: ' + lastError)
  } finally {
    upgrading = false
  }
}

/**
 * 心跳成功一次之后调它。confirm timer 靠这个标记判断新版本到底活没活过来——
 * 自检只能证明「能起来」，证明不了「能跟 Gateway 说上话」，而后者失败 = 机器失联。
 */
export function confirmVersion(): void {
  const v = managerVersion()
  let wrote = false
  // 现读现写（见 patchState）：这个函数每轮心跳都跑，正是被别处整份覆盖时最容易受害的那个。
  patchState((s) => {
    if (s.confirmedVersion === v) return
    wrote = true
    // 版本对上了，熔断标记和重试计数也就没用了，一并清掉。
    return { confirmedVersion: v, lastUpgradeTo: s.lastUpgradeTo === v ? '' : s.lastUpgradeTo, upgradeRetries: 0 }
  })
  if (!wrote) return
  // previous 只在「确认之前」有用（回滚脚本靠它判断有没有一次待确认的换版，见
  // manager-confirm.sh 开头那行 -L 判断），所以换版成功那一刻**不能**删；确认落盘之后
  // 它就只剩一个会误导人的旧链接了，删掉。删不掉不要紧，脚本看到 confirmedVersion
  // 对得上也会 keep。
  try {
    rmSync(join(installRoot(), 'previous'), { force: true })
  } catch {
    /* 只读根之类。留着无害，别让它把心跳那一轮的后半截（removed、时区、升级）吞掉。 */
  }
}

/** 包地址和配对的 Gateway 是不是同一个 origin。任一边解析不了都算不是。 */
