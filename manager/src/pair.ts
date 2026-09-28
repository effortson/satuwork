import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { gatewayUrlProblem, managerVersion, PROTOCOL, readState, writeState, type BootConfig, type ManagerState } from './config.ts'

/**
 * 配对：拿一次性配对码换这台机器的长期 `smt_`。
 *
 * 为什么不是 IP 绑定：IP 会变、会撞，也证明不了「这台机器是这家公司的」。码是
 * 一次性、30 分钟过期、可吊销的。机器的地址由 Gateway 从 socket 源地址取，
 * owner 之后可以在界面上改。
 */

/**
 * 配对回调的挑战串。
 *
 * Gateway 收到配对请求后要**立刻回拨一次**，确认自己真能打到这台机器——不然
 * 「配对成功但 Gateway 打不到」会拖到第一次部署才暴露，那时人已经离开机器了。
 *
 * 回拨不能用 `smt_` 鉴权：那一刻票还在 Gateway 手里，管家还没收到响应。所以管家
 * 在配对请求里带一个随机串，回拨带着它来，对得上才算数。进程活着期间不变。
 */
export const bootChallenge = randomBytes(18).toString('base64url')

export interface PairResult {
  state: ManagerState
  reachable: boolean
  message: string
}

/**
 * 配对码在，就**一定**拿它去换一次身份——哪怕 /etc/satuwork/manager.json 已经在了。
 *
 * 原来这里第一句是 `if (existing) return 'already paired'`，配对码看都不看。于是
 * 「机器在平台上被删掉、装机脚本带着新码重跑一遍」这条最自然的自救路走不通：本地
 * 那份 manager.json 还在，管家一秒就说自己已配对，Gateway 那边一次 `POST
 * /machines/pair` 都没收到（配对码的 usedAt 至今是空的），而管家正拿着一个已经不存在
 * 的 machineId 发心跳、收 401——**而 401 是被刻意设计成不据此自毁的**（库回滚一次就
 * 能带走整个机队），所以它会一直安静地重试下去。两边谁都不吭声，人只看到装机脚本
 * 打了「Paired」，界面上却始终没有这台机器。真跑出来过。
 *
 * 脚本注释里那句「Safe to re-run: an already paired machine stays paired」没写错——
 * **但它只在没带 `--code` 时成立**。人显式给了一张一次性、30 分钟过期的码，意思就是
 * 「按这张码重配」，那是意图，不是噪音。
 *
 * **先换后弃，不是先弃后换。** 拿新码去配，成了才覆盖 manager.json；配不上（码用过
 * 了、过期了、网不通）就退回原来那个身份，只吼一声。反过来做——先把本地身份删掉再
 * 去配——一张打错的码就能把一台好好的机器变成没人认领的孤儿，而这台机器没有 SSH。
 *
 * 顺带堵掉一个循环：装机脚本配对成功后会把 SATUWORK_PAIRING_CODE 从 manager.env 里
 * 删掉，但脚本要是在那一步之前被打断，码就留在盘上了。每次开机都会拿它再试一次，
 * Gateway 回「无效或已过期」——退回旧身份、写一行日志，不炸。
 */
export async function pairIfNeeded(boot: BootConfig): Promise<PairResult | undefined> {
  const existing = readState()
  if (existing && !boot.pairingCode) return { state: existing, reachable: true, message: 'already paired' }
  if (!boot.gatewayUrl) throw new Error('GATEWAY_URL is unset; cannot pair')
  if (!boot.pairingCode) throw new Error('SATUWORK_PAIRING_CODE is unset; cannot pair')
  if (existing) {
    console.log(`satuwork-manager: 本地已有身份（${existing.machineId}），但拿到了配对码，按码重配`)
  }

  try {
    return await pairWithCode(boot)
  } catch (e) {
    // 没有可退回的身份，就还是原来那样：让它炸，装机脚本会把 journalctl 那句话打给人看。
    if (!existing) throw e
    console.error(
      `satuwork-manager: 按配对码重配没成功（${e instanceof Error ? e.message : String(e)}），` +
        `继续用本地这个身份 ${existing.machineId}`,
    )
    return { state: existing, reachable: true, message: 'repairing with the code failed; kept the existing identity' }
  }
}

/** 拿配对码换一份身份，成了才落盘。失败一律抛——退不退回由上面那层决定。 */
async function pairWithCode(boot: BootConfig): Promise<PairResult> {
  // 配对请求换回来的就是 smt_：明文 http 上走这一趟，票当场就不只是我们的了。
  const problem = gatewayUrlProblem(boot.gatewayUrl)
  if (problem) throw new Error(problem)
  const res = await fetch(`${boot.gatewayUrl}/machines/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: boot.pairingCode,
      managerPort: boot.port,
      hostname: hostname(),
      managerVersion: managerVersion(),
      protocol: PROTOCOL,
      challenge: bootChallenge,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {}
  if (!res.ok) throw new Error(`pairing failed ${res.status}: ${String(body.error || text).slice(0, 300)}`)
  if (!body.machineId || !body.token) throw new Error('pairing response is missing machineId or token')

  const state: ManagerState = {
    machineId: String(body.machineId),
    token: String(body.token),
    gatewayUrl: boot.gatewayUrl,
    pairedAt: Date.now(),
    jwks: null,
    confirmedVersion: managerVersion(),
    lastUpgradeTo: '',
    lastUpgradeAt: 0,
    upgradeRetries: 0,
  }
  // 桌面 ticket 要用它验签。现在抓一次，省得第一个员工点开桌面时才发现拿不到。
  try {
    const jr = await fetch(`${boot.gatewayUrl}/.well-known/jwks.json`, { signal: AbortSignal.timeout(8000) })
    if (jr.ok) state.jwks = (await jr.json()) as { keys: Record<string, unknown>[] }
  } catch {}
  // **落盘放在最后一步。** 前面任何一处失败，manager.json 都还是原来那份——一张打错
  // 的码不该把一台好好的机器变成孤儿。
  writeState(state)

  const reachable = body.reachable === true
  return {
    state,
    reachable,
    message: reachable
      ? 'paired; the Gateway can reach this machine'
      : `paired, but the Gateway cannot reach port ${boot.port} on this machine - open it, then restart satuwork-manager`,
  }
}
