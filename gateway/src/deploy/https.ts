/**
 * 管家自动给域名配 https 的编排（协议 14，机器那一侧在 manager/src/https.ts）。
 *
 * 手工那一套（manager/README.md「用 Caddy 给管家配 https」）最要命的是顺序：先让管家只听回环、
 * 再改 Gateway 上的地址，机器当场失联，只能上机器去删 drop-in。这里把四步排死：
 *
 *   1. provision  回包让管家装 Caddy、写配置、本机自检。它报 ready 之后，Gateway 从**外面**经
 *                 域名敲 `/ingress-check?nonce=`——不带机器票，对上 nonce 才证明「这个域名后面
 *                 就是这台管家」；然后才带票探一次活，再把管家地址和桌面直连地址换成域名。
 *   2. lockdown   回包让管家只听 127.0.0.1。它报「已只听回环」之后经域名带票探活。
 *   3. done       通了。
 *   *. rollback   只听回环之后从外面连不上：两个地址放回去，回包让管家重新对外听。
 *
 * **兜底靠的是心跳的方向。** 心跳是管家主动打 Gateway 的，入站怎么断都不影响它；所以哪一步
 * 走坏了，下一轮心跳回包照样能把「撤回」送到机器上。整个流程也因此全部挂在心跳上推进，
 * 不靠后台任务——Gateway 跑在 Vercel 上，没有常驻进程可以等。
 */
import { randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import type { Db, Machine, MachineHttps } from '../db.ts'
import { HttpError } from '../http.ts'
import { MIN_HTTPS_PROTOCOL, machinePaired } from './paths.ts'
import { managerHealth } from './manager.ts'
import { rehostSeatInstances } from './machines.ts'

/** 管家装 Caddy 加申请证书，本机自检就等 5 分钟；给足余量，超了算失败。 */
const PROVISION_TIMEOUT_MS = 20 * 60_000
/** 只听回环之后多久还连不上就撤回。管家重启要几秒，加上一两轮心跳。 */
const LOCKDOWN_GRACE_MS = 3 * 60_000
/** 撤回之后管家一直没报「已重新对外听」：不再等，落到 failed，人去看日志。 */
const ROLLBACK_TIMEOUT_MS = 10 * 60_000

/** 和 manager/src/https.ts 的 domainOf 同一套口径：这个值会被原样写进机器上的 Caddyfile。 */
export function httpsDomainOf(raw: string): string {
  const d = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '')
  if (
    d.length < 4 ||
    d.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(d)
  ) {
    throw new HttpError(400, '域名格式不对，只填域名本身，例如 m001.example.com（不要端口和路径，也不能是 IP）')
  }
  return d
}

/** 界面能不能按「启用 https」。不能按的时候说为什么。 */
export function httpsBlocker(m: Machine): string | null {
  if (!machinePaired(m)) return '这台机器还没有配对'
  if (m.protocol < MIN_HTTPS_PROTOCOL) return `管家版本太旧（协议 ${m.protocol}，要 ${MIN_HTTPS_PROTOCOL}），等它自升级上来`
  return null
}

/**
 * 开始（或重新开始）一次。
 *
 * 先查一下域名解析得到：没解析过来的话，管家那边要白装一遍 Caddy、再等五分钟证书超时才报
 * 出来；这里一秒就能说清楚。**只查解析得到，不比对 IP**——Gateway 不知道这台机器的公网
 * 地址（管家地址可能是内网的），比对只会误伤。
 */
export async function startHttps(db: Db, m: Machine, domain: string): Promise<Machine> {
  const blocker = httpsBlocker(m)
  if (blocker) throw new HttpError(409, blocker)
  if (m.https && (m.https.stage === 'lockdown' || m.https.stage === 'rollback')) {
    throw new HttpError(409, '正在切换监听，等这一步跑完再改')
  }
  // 已经用别的域名配好了：管家一写新的 Caddyfile，老域名当场就不再服务，而管家地址还是老域名——
  // 新域名要是没走通，这台机器就只剩心跳一条路。让人先把管家地址改回能直连的那个再来。
  if (m.https?.stage === 'done' && m.https.domain !== domain && m.host === `https://${m.https.domain}`) {
    throw new HttpError(
      409,
      `这台机器已经用 ${m.https.domain} 配好了。换域名前先把「管家地址」改回能直连的地址（例如 http://<IP>:8443）并撤掉这一条，再用新域名重新开始`,
    )
  }
  try {
    await lookup(domain)
  } catch {
    throw new HttpError(400, `${domain} 现在还解析不到，先把它的 A 记录指到这台机器的公网 IP`)
  }
  const now = Date.now()
  const https: MachineHttps = {
    domain,
    stage: 'provision',
    nonce: randomBytes(24).toString('base64url'),
    prevHost: null,
    prevDirectUrl: null,
    error: null,
    machinePhase: null,
    machineLoopback: false,
    startedAt: now,
    stageAt: now,
  }
  return db.updateMachine(m.id, { https })
}

/** 撤掉这条记录。切换中途不许撤：那时候撤，两个地址和监听状态就没人收拾了。 */
export async function clearHttps(db: Db, m: Machine): Promise<Machine> {
  if (m.https && (m.https.stage === 'lockdown' || m.https.stage === 'rollback')) {
    throw new HttpError(409, '正在切换监听，等这一步跑完再撤')
  }
  return db.updateMachine(m.id, { https: null })
}

/**
 * 心跳回包里的 `https`。
 *
 * 记录为空就是 null（管家什么都不动）。failed 时 domain 给 null：管家不重试，但 loopbackOnly
 * 仍明确给 false——撤回之后的那次 failed 要靠它让管家删掉自己写的 drop-in。
 */
export function httpsReplyOf(m: Machine) {
  const h = m.https
  if (!h) return null
  if (h.stage === 'failed') return { domain: null, loopbackOnly: false, nonce: null }
  return {
    domain: h.domain,
    loopbackOnly: h.stage === 'lockdown' || h.stage === 'done',
    nonce: h.nonce,
  }
}

export interface HttpsReport {
  domain: string | null
  phase: string
  error: string | null
  loopbackOnly: boolean
}

/** 心跳里管家自报的那一份。来自网络，按形状收；认不出就当没报。 */
export function httpsReportOf(raw: unknown): HttpsReport | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const phase = typeof r.phase === 'string' && /^(idle|working|ready|error)$/.test(r.phase) ? r.phase : undefined
  if (!phase) return undefined
  return {
    domain: typeof r.domain === 'string' ? r.domain.slice(0, 253) : null,
    phase,
    error: typeof r.error === 'string' ? r.error.slice(0, 500) : null,
    loopbackOnly: r.loopbackOnly === true,
  }
}

/**
 * 心跳里推一步。返回推过之后的机器（没变就是原样）。
 *
 * **出错只记进 https.error，不抛**：心跳是这台机器唯一的控制通道，这条附带的流程不能把它带成
 * 500。外面敲不通在 provision 里不算失败——证书刚下来、解析还在传播，下一轮再试，直到超时。
 */
export async function advanceHttps(db: Db, m: Machine, report: HttpsReport | undefined): Promise<Machine> {
  const h = m.https
  if (!h || h.stage === 'done' || h.stage === 'failed') {
    // 终态也把机器自报的那一份记下来，界面上才看得出「done 了但有人把 drop-in 删了」。
    if (h && report && (report.phase !== h.machinePhase || report.loopbackOnly !== h.machineLoopback)) {
      return db.updateMachine(m.id, { https: { ...h, machinePhase: report.phase, machineLoopback: report.loopbackOnly } })
    }
    return m
  }
  const now = Date.now()
  const mine = report && report.domain === h.domain ? report : undefined
  let next: MachineHttps = {
    ...h,
    machinePhase: mine?.phase ?? report?.phase ?? h.machinePhase,
    machineLoopback: report?.loopbackOnly ?? h.machineLoopback,
  }
  const to = (stage: MachineHttps['stage'], error: string | null): MachineHttps => ({ ...next, stage, error, stageAt: now })
  let hostChange: { host: string | null; directUrl: string | null } | undefined

  if (h.stage === 'provision') {
    if (mine?.phase === 'error') {
      next = to('failed', mine.error || '管家没配上，原因没报上来')
    } else if (mine?.phase === 'ready') {
      const base = `https://${h.domain}`
      const seen = await ingressSeen(base, h.nonce)
      if (seen !== true) {
        next = { ...next, error: `管家在机器上配好了，但从外面经域名还连不上：${seen}` }
      } else {
        // nonce 对上了，域名后面确实是这台管家，这才敢带票。
        const probe = await managerHealth(base, { token: m.token })
        if (!probe.ok) {
          next = { ...next, error: `经域名带票探活没通：${probe.error ?? '无响应'}` }
        } else {
          hostChange = { host: base, directUrl: base }
          next = { ...to('lockdown', null), prevHost: m.host, prevDirectUrl: m.directUrl }
        }
      }
    }
    if (next.stage === 'provision' && now - h.stageAt > PROVISION_TIMEOUT_MS) {
      next = to('failed', `${PROVISION_TIMEOUT_MS / 60_000} 分钟还没走通。${next.error ?? `管家最近报的是 ${next.machinePhase ?? '还没报'}`}`)
    }
  } else if (h.stage === 'lockdown') {
    if (report?.loopbackOnly) {
      const probe = await managerHealth(`https://${h.domain}`, { token: m.token })
      if (probe.ok) next = to('done', null)
      else if (now - h.stageAt > LOCKDOWN_GRACE_MS) {
        hostChange = { host: h.prevHost, directUrl: h.prevDirectUrl }
        next = to('rollback', `只听回环之后经域名连不上（${probe.error ?? '无响应'}），已撤回`)
      } else next = { ...next, error: `只听回环之后还没探通：${probe.error ?? '无响应'}，再等一轮` }
    } else if (report?.error) {
      next = { ...next, error: report.error }
    }
  } else if (h.stage === 'rollback') {
    if (report && !report.loopbackOnly) next = to('failed', h.error)
    else if (now - h.stageAt > ROLLBACK_TIMEOUT_MS) {
      next = to('failed', `${h.error ?? ''}；撤回后管家一直没报「重新对外听」，看一眼管家日志`)
    }
  }

  if (!hostChange) {
    if (JSON.stringify(next) === JSON.stringify(h)) return m
    return db.updateMachine(m.id, { https: next })
  }
  const change = hostChange
  return db.tx(async () => {
    const row = await db.updateMachine(m.id, { https: next, ...change })
    // 聊天读的是 instances.host，不跟着 machines.host 走——和机器页上改地址同一个事务里一起换。
    if (change.host) await rehostSeatInstances(db, row.id, change.host)
    // 地址是 Gateway 自己换的，没有哪个人按了按钮——审计里记成没有操作人。待分配的机器没有
    // 公司可挂，那就不记（和 auditMachine 一样）。
    if (row.companyId) {
      await db.audit({
        companyId: row.companyId,
        accountId: null,
        action: 'machine.https',
        detail: { machineId: row.id, domain: h.domain, stage: next.stage, host: change.host, directUrl: change.directUrl },
      })
    }
    return row
  })
}

/**
 * 从外面经域名认人：`/ingress-check?nonce=` 回 200 就是这台管家。不是的话回一句人话。
 *
 * 跟 probeDirectUrl 一样**绝不带机器票**——走到这一步之前，没人能保证这个域名指向的是我们的
 * 机器。
 */
async function ingressSeen(base: string, nonce: string): Promise<true | string> {
  try {
    const res = await fetch(`${base}/ingress-check?nonce=${encodeURIComponent(nonce)}`, {
      signal: AbortSignal.timeout(8000),
      redirect: 'manual',
    })
    if (res.ok) return true
    return `回的是 ${res.status}，这个域名后面不像是这台机器的管家`
  } catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string } })?.cause
    return cause?.code || cause?.message || (e instanceof Error ? e.message : String(e))
  }
}

/** 给界面的那一份：不带 nonce（它是认人的口令，浏览器用不着）。 */
export function publicHttps(m: Machine) {
  const h = m.https
  return {
    https: h
      ? {
          domain: h.domain,
          stage: h.stage,
          error: h.error,
          machinePhase: h.machinePhase,
          machineLoopback: h.machineLoopback,
          startedAt: h.startedAt,
          stageAt: h.stageAt,
        }
      : null,
    httpsBlocker: httpsBlocker(m),
  }
}
