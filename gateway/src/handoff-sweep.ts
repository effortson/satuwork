/**
 * 转人工的**对外通知**与**催办**（见 docs/handoff.md §6）。
 *
 * 站内那两层（会话里的卡片、侧栏那颗点、顶栏的计数）只在有人开着浏览器时成立，
 * 而最需要被叫醒的恰恰是没人看着的时候——日常任务是浏览器关着跑的，它卡住开出来的
 * 单子，站内的红点一个人也叫不来。
 *
 * 所以这里做两件事：
 *
 * 1. **开单就发一条 webhook**（飞书 / 企微 / Slack 机器人那种 URL）；
 * 2. **到点催办**：`T1` 没人接再推一次，`T2` 还没人接就升级给管理员、并把单子
 *    收成 `expired`——**同时告诉 Bot「没人接手」**。少了最后半句，这张单会和转人工
 *    原来那条日志一样悬着，而那正是这一整套东西要修的毛病。
 *
 * 扫描挂在已有的调度节拍上（同 routines 那一条），不新起一个定时器。
 */
import type { Db, Handoff } from './db.ts'
import { callSeat } from './lib/handoff.ts'
import { safeFetch } from './web-tools.ts'

/**
 * 多久没人接就再推一次。30 分钟：够一次会议，又不至于让人下班了才看见。
 *
 * 下限 1 秒而不是「一个像样的分钟数」：e2e 要在十几秒里跑完催办和超时两档，
 * 而给它一个假的时钟就意味着测的不是真正跑在线上的那段代码。线上没人会把它设成 1 秒
 * ——真设了，人收到的是一条每分钟催一次的骚扰，那是一眼能看出来的错。
 */
const NUDGE_MS = Math.max(1_000, Math.trunc(Number(process.env.GATEWAY_HANDOFF_NUDGE_MS) || 30 * 60_000))
/** 多久没人接就认定没人会接了。24 小时：跨过一个夜班，也跨过一个周末的半天。 */
const EXPIRE_MS = Math.max(NUDGE_MS * 2, Math.trunc(Number(process.env.GATEWAY_HANDOFF_EXPIRE_MS) || 24 * 60 * 60_000))
/** 一轮最多处理几张。多了下一轮再来，别让一次 tick 卡在网络上。 */
const BATCH = 20
/** webhook 等多久。它在扫描的关键路径上，一条挂死的地址不能拖住整轮。 */
const POST_TIMEOUT_MS = 8000

export type NudgeKind = 'new' | 'nudge' | 'expired'

/**
 * 推给群机器人的那条消息。
 *
 * **三家的格式凑成一条**：飞书吃 `{msg_type:'text', content:{text}}`，企微吃
 * `{msgtype:'text', text:{content}}`，Slack 吃 `{text}`。三个字段一起发，各家只认自己
 * 那一份、忽略别的——比让人在界面上先选一家供应商省事得多，而选错的代价是一条谁也
 * 收不到的通知。
 */
export function webhookPayload(text: string): Record<string, unknown> {
  return {
    text,
    msg_type: 'text',
    content: { text },
    msgtype: 'text',
  }
}

/** 通知正文。**要人做什么**排在最前面：群里的人扫一眼就得知道这条跟自己有没有关系。 */
export function noticeText(h: Handoff, kind: NudgeKind, who: string, link: string): string {
  const head =
    kind === 'new'
      ? '【转人工】有一件事需要人处理'
      : kind === 'nudge'
        ? '【转人工·催办】这件事还没有人接'
        : '【转人工·超时】没有人接手，已经关掉并告诉了 Bot'
  return [
    head,
    `要做什么：${h.ask || '（没写）'}`,
    `为什么：${h.reason || '（没写）'}`,
    `谁的 Bot：${who}`,
    link ? `去处理：${link}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 发一条。**失败只记一笔，不抛**：通知发不出去不该影响单子本身的状态流转——
 * 那张单已经开出来了，站内照样看得见。
 */
/** 仅供 e2e：让转人工 webhook 可以指向本机（写入校验和发送侧共用）。生产别开。 */
export const HANDOFF_WEBHOOK_ALLOW_PRIVATE = process.env.GATEWAY_HANDOFF_WEBHOOK_ALLOW_PRIVATE === '1'

export async function notify(db: Db, h: Handoff, kind: NudgeKind): Promise<boolean> {
  const company = await db.company(h.companyId)
  const url = (company?.handoffWebhook || '').trim()
  if (!url || !/^https:\/\//i.test(url)) return false
  const owner = await db.account(h.accountId)
  const base = (company?.accessUrl || '').replace(/\/$/, '')
  const text = noticeText(h, kind, owner?.name || owner?.email || h.accountId, base ? `${base}/handoffs` : '')
  try {
    // 走 web-tools 那道 SSRF 闸（内网、link-local、云 metadata 一律拒，跳转逐跳重查、
    // IP 钉死）。这个地址是公司管理员填的，而 Gateway 手里有库和平台凭证——裸 fetch
    // 等于让任何一个管理员拿 Gateway 去打它够不着的内网服务。
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(webhookPayload(text)),
    }
    // e2e 的假群机器人听在本机，SSRF 闸会拒它；只有那个开关打开时才走裸 fetch。
    const r = HANDOFF_WEBHOOK_ALLOW_PRIVATE
      ? await fetch(url, { ...init, signal: AbortSignal.timeout(POST_TIMEOUT_MS) })
      : await safeFetch(url, { ...init, timeoutMs: POST_TIMEOUT_MS })
    // 3xx 到最后一跳、正文用不上：排空，别把连接挂着。
    await r.body?.cancel().catch(() => {})
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return true
  } catch (e) {
    console.warn(`handoff: 通知没发出去（${h.id}）：${(e as Error).message}`)
    return false
  }
}

/**
 * 席位的回话是不是「这张单已经不在了」那一类——再敲也是同一句，不该退回重来。
 * 5xx、网络（callSeat 折成 503）和静默期的 409 都不算，那些是「等会儿再来」。
 */
function terminalRefusal(r: { status: number; json: Record<string, unknown> }): boolean {
  if (r.status === 409) return r.json.quiesced !== true
  return r.status === 400 || r.status === 404 || r.status === 410
}

/**
 * 扫一轮：该催的催，该收的收。
 *
 * **两档都用带旧值的 CAS 记账**（`bumpHandoffNotify`）：升级换版那几十秒里新旧两代
 * 进程都会扫到同一张单，没有这一句，同一条催办会推两遍——而催办本身就是打扰人的东西。
 */
export async function sweepHandoffs(db: Db, now = Date.now()): Promise<{ nudged: number; expired: number }> {
  let nudged = 0
  let expired = 0

  // 第一档：还没催过、又过了 T1 的。
  for (const h of await db.handoffsNeedingNudge(0, now - NUDGE_MS, BATCH)) {
    if (!(await db.bumpHandoffNotify(h.id, 0, 1))) continue
    if (await notify(db, h, 'nudge')) nudged++
  }

  /**
   * 第二档：过了 T2 还没闭合的，收掉**并且**把话带回给 Bot。
   *
   * **`open` 和 `claimed` 都要收**（见 db.staleHandoffs）：一张被人点过「我来接手」
   * 然后再没动静的单子，如果只扫 open 就永远没有终态——blocking 的那些会让这颗 Bot
   * 的日常任务天天被跳过，而模型永远等不到那句话。接过手的那种，席位给模型的措辞
   * 不一样（见 expiredMessage）：人可能已经做了一半，不该让它从头再来一遍。
   */
  for (const h of await db.staleHandoffs(now - EXPIRE_MS, BATCH)) {
    // 带旧值的 CAS：升级换版那几十秒里新旧两代都会扫到同一张单。
    if (!(await db.bumpHandoffNotify(h.id, h.notifyStep, 2))) continue
    const hours = Math.max(1, Math.round(EXPIRE_MS / 3_600_000))
    const r = await callSeat(db, h, 'expire', { hours })
    if (r.status === 200) {
      await db.upsertHandoff({ ...h, state: 'expired', updatedAt: Date.now() })
      expired++
      await notify(db, h, 'expired')
    } else if (terminalRefusal(r)) {
      /**
       * 席位**明确说了这张单不在了**：409 是它的 expire 回的「已经不在了」（bot 的
       * /handoffs/:hid/expire），404 是老版本席位没有这条路或会话没了，400 / 410 同理。
       * 这几种下一轮再敲还是同一句话——以前和「席位不在线」混在一起退回重来，于是
       * 这张单每一拍都去撞一次，永远收不掉，blocking 的那些就一直拦着这颗 Bot 的日常任务。
       *
       * Gateway 这边直接收成 `expired`：那句话没法带给模型了（席位那边的单子已经没了，
       * 也就没有会话在等它），但这一行的终态必须落下（不变量 2）。
       *
       * **静默期那种 409 不算**：席位换版时会用 409 + `quiesced: true` 顶回来（refuseQuiet），
       * 那是「等会儿再来」，不是「没有这张单」。
       */
      await db.upsertHandoff({ ...h, state: 'expired', updatedAt: Date.now() })
      expired++
      console.warn(`handoff: ${h.id} 席位那边已经不在了（HTTP ${r.status}），Gateway 这边直接收成 expired`)
    } else {
      /**
       * 席位不在线（机器关着的整夜正是没人接手的一半原因），或者正在换版（静默期）。
       *
       * **退回原来那一档重来**，不是就此放过：这张单的最终态必须落下（不变量 2），
       * 而唯一能把那句话说给模型听的地方就是那台席位。下一轮再试。
       */
      await db.bumpHandoffNotify(h.id, 2, h.notifyStep)
      console.warn(`handoff: ${h.id} 超时收不掉，席位没应答：${String(r.json.error ?? r.status)}`)
    }
  }
  return { nudged, expired }
}
