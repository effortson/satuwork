/**
 * 转人工的待办：跨 Bot 的清单，以及接手 / 交还 / 撤销这三下（见 docs/handoff.md）。
 *
 * **和 `/runtime/sessions/:id/*` 那一组分开**，因为它们的鉴权判据不同：那一组问的是
 * 「这条会话是不是你的」，而交接的全部意义就是接手的人可能不是这颗 Bot 的主人。
 * 这里问的是「你在这家公司里够不够得着这张单」（`canActOn`）。
 *
 * **席位是状态的权威。** 这几条路由自己不改状态机：先打席位，席位说成了才把 Gateway
 * 这一行同步过去。两边各判一次抢单的话，两个人在两个标签页里各点一次，一边说"你接到了"、
 * 另一边说"他接到了"，而单子只有一张。
 */
import type { RouteCtx } from './ctx.ts'
import { HttpError, json, type Router } from '../http.ts'
import { bodyOf, strField } from '../lib/validate.ts'
import { requireUser } from '../lib/guards.ts'
import { canActOn, callSeat, decorate, seatHandoffs } from '../lib/handoff.ts'
import { HANDOFF_STATES, type Account, type Db, type Handoff, type HandoffState } from '../db.ts'

/** 席位回给我们的那张单。`claimedBy` 在那边是个带名字的对象，这边只存 accountId。 */
interface SeatHandoff {
  id?: unknown
  state?: unknown
  claimedBy?: { accountId?: unknown } | null
  repeats?: unknown
  updatedAt?: unknown
}

/**
 * 把席位那边的最新状态同步到这一行。
 *
 * 席位每次流转也会自己报一条（outbox → `/internal/handoffs`），但那条是**异步**的：
 * 人点完「接手」立刻刷新待办页，看到的会是一张还没人接的单，然后他会再点一次。
 * 所以这一跳拿到结果就顺手写一次，两条路殊途同归（upsert 按 updatedAt 收）。
 */
async function syncFromSeat(db: Db, h: Handoff, seat: SeatHandoff | undefined): Promise<Handoff> {
  if (!seat || typeof seat.state !== 'string') return h
  /**
   * 席位是状态的权威，但它回的东西**照样要验**：席位跑在客户的机器上，一台被拿下的席位
   * 回什么都行。认不出的 state 不写（写进去会让 handoffOf 之后的每一处 switch 都漏掉这行）；
   * `claimedBy` 得是**本公司**的账号——不然席位可以把单子记成别家公司的人接的。
   */
  if (!HANDOFF_STATES.includes(seat.state as HandoffState)) {
    console.warn(`handoff: 席位回了认不出的 state「${seat.state.slice(0, 40)}」（${h.id}），这一行没同步`)
    return h
  }
  let claimedBy = h.claimedBy
  if (typeof seat.claimedBy?.accountId === 'string') {
    const who = await db.account(seat.claimedBy.accountId)
    if (who && who.companyId === h.companyId) claimedBy = who.id
    else console.warn(`handoff: 席位回的 claimedBy 不是本公司的账号（${h.id}），保留原值`)
  }
  return await db.upsertHandoff({
    ...h,
    state: seat.state as HandoffState,
    claimedBy: claimedBy || null,
    repeats: typeof seat.repeats === 'number' ? seat.repeats : h.repeats,
    updatedAt: typeof seat.updatedAt === 'number' ? seat.updatedAt : Date.now(),
  })
}

export function attachHandoffs(router: Router, ctx: RouteCtx) {
  const { db, keys } = ctx

  async function mine(req: Parameters<typeof requireUser>[0]): Promise<Account> {
    const account = await requireUser(req, db, keys)
    if (!account.companyId) throw new HttpError(403, '平台账号没有待办')
    return account
  }

  async function target(req: Parameters<typeof requireUser>[0], id: string): Promise<{ account: Account; h: Handoff }> {
    const account = await mine(req)
    const h = await db.handoff(id)
    // **查不到和没权限回同一句**：否则这条路由就成了一个「猜单号」的探针。
    if (!h || !canActOn(account, h)) throw new HttpError(404, '没有这张交接单')
    return { account, h }
  }

  /**
   * 我的待办。
   *
   * `scope=mine` 只看指给我的和我接的；不带就是我看得见的全部（员工是自己名下的 Bot
   * 加指名给自己的，管理员是本公司全部——管理员是所有单子的兜底接手人）。
   *
   * `count` 是顶栏那个数：**要我处理、还没处理完**的有几张。它和列表长度不是一回事
   * （列表里还有别人接走的、已经交还等 Bot 消化的），所以单独算一个，别让界面自己数。
   */
  router.get('/runtime/handoffs', async (req, res) => {
    const account = await mine(req)
    const who = { id: account.id, companyId: account.companyId!, role: account.role }
    const list = await db.handoffsFor(who, {
      live: req.query.get('state') !== 'all',
      mine: req.query.get('scope') === 'mine',
    })
    // 最近 30 天的概览。**跟清单一起给**：待办页顶上那三个数和下面那张表说的是同一
    // 件事，分两跳去取只会出现「数对不上」的一瞬间。
    const stats = await db.handoffStats(who, Date.now() - 30 * 24 * 3600_000)
    json(res, 200, {
      handoffs: await decorate(db, list),
      count: await db.openHandoffCount(who),
      stats,
    })
  })

  /**
   * 一张单，**连正文一起**。
   *
   * Gateway 那张表只留了 `reason` / `ask` 各一段（同会话索引的口径），而接手的人真正
   * 要看的是 `summary`——Bot 已经做到哪一步。那一份只有席位有，所以这一跳现去拉。
   *
   * 席位不在线就只给索引那一份（`detail: null`）：看不到全文总比整条路 503 强，
   * 界面会说明白是「席位没应答」而不是「这张单没有内容」。
   */
  router.get('/runtime/handoffs/:id', async (req, res) => {
    const { h } = await target(req, req.params.id)
    const row = (await decorate(db, [h]))[0]
    const detail = (await seatHandoffs(db, h)).find((x) => x.id === h.id) ?? null
    json(res, 200, { handoff: row, detail })
  })

  /**
   * 我来接手。
   *
   * 抢不到时席位回 409 并说清楚**被谁接走了**，这一跳原样透出去：两个人同时点是必然
   * 会撞上的竞态，回 200 的话后点的那个会以为这件事归他了，然后两个人各做一遍。
   */
  router.post('/runtime/handoffs/:id/claim', async (req, res) => {
    const { account, h } = await target(req, req.params.id)
    const r = await callSeat(db, h, 'claim', {
      actor: { accountId: account.id, name: account.name || account.email },
    })
    if (r.status === 200) await syncFromSeat(db, h, r.json.handoff as SeatHandoff)
    json(res, r.status, r.json)
  })

  /**
   * 交还。**这一下会真的把话喂给模型**（`closed` 那一档除外），席位那边负责起新一轮。
   *
   * 走 Gateway 而不是让浏览器直接打席位：接手的人可能是管理员，那颗 Bot 在别人的机器
   * 上，浏览器根本够不着——这一跳按单子上记着的 accountId + botId 取地址和两张票。
   */
  router.post('/runtime/handoffs/:id/return', async (req, res) => {
    const { account, h } = await target(req, req.params.id)
    const body = bodyOf(req)
    const disposition = strField(body, 'disposition', false) || 'done'
    const r = await callSeat(db, h, 'return', {
      disposition,
      text: strField(body, 'text', false),
      actor: { accountId: account.id, name: account.name || account.email },
    })
    if (r.status === 200) await syncFromSeat(db, h, r.json.handoff as SeatHandoff)
    json(res, r.status, r.json)
  })

  /** 撤销。不叫醒 Bot——人只是说这件事不用管了。 */
  router.post('/runtime/handoffs/:id/cancel', async (req, res) => {
    const { account, h } = await target(req, req.params.id)
    const r = await callSeat(db, h, 'cancel', {
      actor: { accountId: account.id, name: account.name || account.email },
    })
    if (r.status === 200) await syncFromSeat(db, h, r.json.handoff as SeatHandoff)
    json(res, r.status, r.json)
  })
}
