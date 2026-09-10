/**
 * 转人工交接单在 Gateway 这一侧的几件事：**指派解算**、**够到席位**、**对外通知**。
 *
 * 单子本身的状态机在席位上（bot/src/policy/handoff.ts），这边只做那三件席位做不了的：
 * 它不知道公司里有谁、够不着别人的机器、也不该自己往外发通知。
 *
 * 见 docs/handoff.md。
 */
import type { Account, Db, Handoff } from '../db.ts'
import { botTemplateOf } from './catalog.ts'
import { machineHeader } from './runtime.ts'

/**
 * 这张单该谁处理。
 *
 * 返回 `null` 的意思是**全体管理员**，不是"没人"——那正是模版上 `admin` 那一档，
 * 也是所有解算不出来的情况的落点（指定的人离职了、换了公司）。丢给管理员总好过
 * 丢给一个已经不在的人：后者的表现是一张永远没人看的单，而它长得和正常的一模一样。
 */
export async function resolveAssignee(db: Db, companyId: string, ownerAccountId: string): Promise<string | null> {
  const tpl = botTemplateOf(await db.botTemplate(companyId))
  const to = tpl.escalateTo || 'owner'
  if (to === 'admin') return null
  if (to === 'owner') return ownerAccountId
  const id = to.startsWith('member:') ? to.slice('member:'.length) : ''
  if (!id) return ownerAccountId
  const who = await db.account(id)
  if (!who || who.companyId !== companyId || who.status !== 'active') return null
  return who.id
}

/**
 * 这个人能不能动这张单。**管理员是所有单子的兜底接手人**，这条线只在这里判一次。
 *
 * 平台账号（`owner`）不在这里出现：他没有 companyId，第一行就把他挡了——待办是公司
 * 内部的事，平台管的是公司、机器和钱。
 */
export function canActOn(account: Account, h: Handoff): boolean {
  if (!account.companyId || account.companyId !== h.companyId) return false
  if (account.role === 'admin') return true
  return h.accountId === account.id || h.assignee === account.id || h.claimedBy === account.id
}

/**
 * 敲这张单所属的那台席位。
 *
 * **不能走 `seatTargetForSession`**：那一条按「这条会话是不是你的」判，而交接的全部
 * 意义就是接手的人可能不是这颗 Bot 的主人。所以按单子上记着的 accountId + botId 取
 * 席位地址和两张票——权限在上面 `canActOn` 判过了，这里只负责够得着。
 */
export async function seatOf(db: Db, h: Handoff): Promise<{ host: string; bearer: string; machineToken?: string }> {
  const instance = await db.instance(h.accountId, h.botId)
  const host = (instance?.host || '').replace(/\/$/, '')
  const secrets = await db.accountSecrets(h.accountId)
  const machine = h.machineId ? await db.machine(h.machineId) : undefined
  return { host, bearer: secrets?.accessToken ?? '', machineToken: machine?.token || undefined }
}

/**
 * 往席位发一条交接动作（接手 / 交还 / 撤销 / 超时）。
 *
 * 席位那边回什么就是什么：409「这张单已经不在了」要原样透给界面，别在这一跳把它
 * 变成 200——那样人会以为自己接到了一张早就被别人处理完的单。
 */
export async function callSeat(
  db: Db,
  h: Handoff,
  path: string,
  body: unknown,
  timeoutMs = 15_000,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const seat = await seatOf(db, h)
  if (!seat.host) return { status: 503, json: { error: '实例还没上线' } }
  const url = `${seat.host}/api/sessions/${encodeURIComponent(h.sessionId)}/handoffs/${encodeURIComponent(h.id)}/${path}`
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${seat.bearer}`,
        'content-type': 'application/json',
        ...machineHeader(seat.machineToken),
      },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await r.text().catch(() => '')
    let parsed: Record<string, unknown> = {}
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    } catch {
      parsed = { error: text.slice(0, 200) || `HTTP ${r.status}` }
    }
    return { status: r.status, json: parsed }
  } catch (e) {
    return { status: 503, json: { error: `席位没应答：${(e as Error).message}` } }
  }
}

/**
 * 去席位拉这条会话上还开着的那几张单（**带正文**）。
 *
 * Gateway 那张表只留了 `reason` / `ask` 各一段（同会话索引的口径），而接手的人真正
 * 要看的是 `summary`——Bot 已经做到哪一步、卡在哪。那一份只有席位有。
 *
 * 拉不到就返回空数组，不抛：看不到全文总比整条路 503 强，界面会说明白是「席位没应答」
 * 而不是「这张单没有内容」。
 */
export async function seatHandoffs(db: Db, h: Handoff, timeoutMs = 10_000): Promise<Record<string, unknown>[]> {
  const seat = await seatOf(db, h)
  if (!seat.host) return []
  const url = `${seat.host}/api/sessions/${encodeURIComponent(h.sessionId)}/handoffs`
  try {
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${seat.bearer}`, ...machineHeader(seat.machineToken) },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!r.ok) return []
    const body = (await r.json()) as { handoffs?: unknown }
    return Array.isArray(body.handoffs) ? (body.handoffs as Record<string, unknown>[]) : []
  } catch {
    return []
  }
}

/** 一张单在界面上要显示的名字。名字从账号表现取，不在单子上存一份会漂的副本。 */
export async function decorate(db: Db, list: Handoff[]): Promise<Record<string, unknown>[]> {
  const ids = new Set<string>()
  for (const h of list) {
    ids.add(h.accountId)
    if (h.assignee) ids.add(h.assignee)
    if (h.claimedBy) ids.add(h.claimedBy)
  }
  const names = new Map<string, string>()
  for (const id of ids) {
    const a = await db.account(id)
    if (a) names.set(id, a.name || a.email)
  }
  return list.map((h) => ({
    ...h,
    ownerName: names.get(h.accountId) ?? '',
    assigneeName: h.assignee ? (names.get(h.assignee) ?? '') : '',
    claimedName: h.claimedBy ? (names.get(h.claimedBy) ?? '') : '',
  }))
}
