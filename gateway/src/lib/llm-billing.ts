/**
 * 一次模型调用在 Gateway 这一侧的**账务骨架**：认 API Key、余额闸、登记调用、收口落账。
 *
 * 从 v1.ts 抽出来，因为同一份规矩现在有两个入口：Gateway 自己代理的 `/v1/*`（桌面端的
 * 本地 Bot、还没换到新管家的席位），和管家中继（routes/worker.ts 的 grant / settle）——
 * 管家在席位机器上直接打上游，只回来问「能不能调」和报「用了多少」。两边各写一份的话，
 * 「什么时候算花了钱」这个问题迟早答出两个数。
 */
import type { Account, ChargeStatus, Db } from '../db.ts'
import { HttpError } from '../http.ts'
import type { CatalogModel } from '../llm.ts'
import type { Billable, Meter } from './meter.ts'
import { gateAccount, gateCompany } from './guards.ts'
import type { TokenUsage } from './llm-usage.ts'

/** settle 只用得着这三样。管家结算时目录里可能已经没有这个模型了，那时只有这三样。 */
type Billed = Pick<CatalogModel, 'provider' | 'id' | 'cost'>

/**
 * 账号本身能不能用：停用 / 还没接受邀请 / 公司被停用。API Key 和登录 JWT 两条路共用，
 * 文案要能直接给调用方看——bot 会把它原样变成一条失败消息。
 *
 * **就是控制台那两道闸**（guards.ts 的 gateAccount + gateCompany），所以直接叫它们，不
 * 再抄一份：这里原先是逐字重写的同一套状态码和同一句中文，而「/v1 的规矩」和「控制台的
 * 规矩」一旦分成两份，下次改其中一句的人不会知道还有另一份。
 */
export async function assertUsable(db: Db, account: Account | undefined): Promise<Account> {
  return await gateCompany(db, gateAccount(account))
}

/**
 * 席位 API Key（`sk_sw_`）→ 账号。不是这个前缀一律 401：`sat_` 是席位运行时票，登录 JWT
 * 走 /v1 自己那条路，都不能拿来当 API Key。
 */
export async function accountByApiKey(db: Db, token: string): Promise<Account> {
  if (!token || !token.startsWith('sk_sw_')) throw new HttpError(401, '需要登录')
  const account = await db.accountByApiKey(token)
  if (!account) throw new HttpError(401, '需要登录')
  return assertUsable(db, account)
}

/**
 * 打上游之前先登记这一次调用，返回 callId（结算时的 refId）。
 *
 * `machineId` 只有**中继**那条路要传（worker.ts 的 grant：授权给哪台机器）。它落在
 * `llm_calls.relayMachineId` 上，是未结算清扫唯一的判据——Gateway 不在中继调用的路径
 * 上，兜不住半路死掉的那些，只能事后扫；而 /v1 自己代理的那几条有 withSettle 收口，
 * 不传（默认 null），也就永远不会被扫到。判据从「账本上没有对应行」收紧成这一格的
 * 缘由见 db.ts 的 unsettledLlmCalls。
 */
export async function recordLlmCall(
  db: Db,
  account: Account,
  found: { provider: string; id: string },
  machineId: string | null = null,
): Promise<string> {
  const row = await db.insertLlmCall({
    accountId: account.id,
    companyId: account.companyId,
    provider: found.provider,
    model: found.id,
    relayMachineId: machineId,
  })
  return row.id
}

/**
 * **只补用量，不动账本。**
 *
 * 结算是按 refId 幂等的（chargeExistsForRef），而「已经记过账了」这件事在中继这条路上
 * 有一种正常的到法：一次长流跑过了 LLM_SETTLE_GRACE_MS，清扫先把它按 failed / 0 元收了，
 * 管家随后带着真实 usage 回来结算。幂等挡住的是**第二笔钱**，可 settle 里写 token 的那
 * 一句在它后面，于是连 token 一起被挡掉——`llm_calls` 上那一行永远停在 0/0，明细里这次
 * 调用看着像没发生过。
 *
 * 所以把「写用量」单拎出来：账本原样不动（不补收、不改状态——那笔钱当时按什么口径记的
 * 就还是什么口径，事后追记会让同一次调用在账上出现两个数），只把 token 改成真的。对账
 * 时这一行的表现是「有用量、金额 0 且 unpriced」，而 unpriced 本来就读作「算不出来」。
 */
export async function recordUsageOnly(db: Db, callId: string, usage: TokenUsage): Promise<void> {
  await db.updateLlmCallTokens(callId, usage)
}

/**
 * 余额闸。**402，不是 403**：这是「要付钱」，不是「不许你来」。
 *
 * Bot 那边（`bot/src/llm/gateway.ts`）会把非 2xx 的 `error` 原样变成一条失败消息给
 * 用户看，所以这句话要能直接读。
 */
export async function gateOr402(meter: Meter, account: Account, found: CatalogModel): Promise<void> {
  const gate = await meter.gate(account, {
    kind: 'llm',
    provider: found.provider,
    model: found.id,
    cost: found.cost,
  })
  if (gate.ok) return
  // 被拒的也落一行（金额 0）。「为什么我的 Bot 停了」这个问题得有一个地方答得了，
  // 而它和「谁调了」应当在同一张表上——分两个地方查的东西，最后总有一个没人看。
  await meter.charge({
    kind: 'llm',
    account,
    status: 'denied',
    provider: found.provider,
    model: found.id,
    tokens: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 },
    cost: found.cost,
  }, { amountMicros: 0, unitPrice: {}, multiplier: 1, unpriced: false })
  throw new HttpError(402, gate.reason)
}

/**
 * 收尾：把用量写回 `llm_calls`，再落一行账。
 *
 * /v1 的四条路和管家的结算接口都在这里收口，是因为「什么时候算花了钱」这件事每条路
 * 各有各的坑，只有这里是共同的终点：
 *
 * - **上游没报 usage 也要落账。** 静默不落的话，账本上查不到这次调用，而 `llm_calls`
 *   里躺着一行 token 全 0 的记录——对账时说不清它是没花钱还是没记上。这种行金额记 0
 *   且标 `unpriced`：那个 0 是「算不出来」，不是「免费」。
 * - **断流照落账。** `proxyUpstream` 已经保证中途断开时保留已累计的 usage；pi 那条流
 *   （`streamChatCompletions`）从每一帧的 `partial.usage` 里累计，上游报错、客户端
 *   中途走了都带着已知的输入 token 落账，状态记 `error` / `failed`。**真拿不到**
 *   （第一帧都没到）时金额 0 且标 `unpriced`——那个 0 是「算不出来」，不是「免费」。
 * - **客户端提前走了也照落账。** 已经问上游要过的 token 是花掉了的，不记等于白送。
 */
export async function settle(
  db: Db,
  meter: Meter,
  account: Account,
  found: Billed,
  callId: string,
  usage: TokenUsage | undefined,
  status?: ChargeStatus,
): Promise<void> {
  if (usage) await db.updateLlmCallTokens(callId, usage)
  const billable: Billable = {
    kind: 'llm',
    account,
    // 没拿到用量不等于调用没发生：上游回了，只是没报数。记成 failed 而不是 ok，
    // 是为了让「这次到底花没花钱」在明细里一眼看得出来。断流 / 上游报错的那条路
    // 会自己指定 status（见 streamChatCompletions）。
    status: status ?? (usage ? 'ok' : 'failed'),
    provider: found.provider,
    model: found.id,
    tokens: {
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      cachedTokens: usage?.cached_tokens ?? 0,
      cacheWriteTokens: usage?.cache_write_tokens ?? 0,
    },
    cost: found.cost,
    refId: callId,
  }
  const quote = await meter.quote(billable)
  // 没拿到用量就没有金额可言。硬按 0 收会让这一行看着像一次免费调用。
  await meter.charge(billable, usage ? quote : { ...quote, amountMicros: 0, unpriced: true })
}

/**
 * 一次上游调用收口时交给 settle 的东西。多数路只回 usage；流式那条在断流 / 报错时
 * 还要说明「这次没正常收口」——账本的 status 由它定，usage 是到断开为止已知的那部分。
 */
export type RunOutcome = TokenUsage | { usage: TokenUsage | undefined; status: ChargeStatus } | undefined

/**
 * 跑一次上游调用，**无论成败都收口**。
 *
 * `recordLlmCall` 是在打上游之前写下的，而失败路径（503、404、上游连不通）都是直接
 * 抛出去的——settle 于是永远没跑，库里留下一行 token 全 0、账本上没有对应行的
 * llm_calls。settle 自己的注释写着这种「查不到账的调用」正是要避免的东西（它甚至为
 * 「上游没报 usage」专门留了 unpriced 这条路），只是抛异常那几条路绕开了它。
 *
 * settle 自己再出错时，以原始错误为准：那一个才是调用方需要看到的。
 */
export async function withSettle(
  db: Db,
  meter: Meter,
  account: Account,
  found: CatalogModel,
  callId: string,
  run: () => Promise<RunOutcome>,
): Promise<void> {
  let usage: TokenUsage | undefined
  let status: ChargeStatus | undefined
  let failed: unknown
  try {
    const out = await run()
    if (out && 'status' in out) {
      usage = out.usage
      status = out.status
    } else {
      usage = out
    }
  } catch (e) {
    failed = e
  }
  try {
    await settle(db, meter, account, found, callId, usage, status)
  } catch (e) {
    if (!failed) throw e
  }
  if (failed) throw failed
}
