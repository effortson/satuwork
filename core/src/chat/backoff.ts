/**
 * 对话流与名单流的退避规则。数字和判据原先散在 gateway/ui/chat.js 里，Web 和移动端要的是
 * 同一套，所以收在这里。
 */

/**
 * 对话流断了之后退避重试到这个档位为止，之后才把「连接断开」摆到界面上。
 *
 * **6 档（约 24 秒）不够。** 它挡得住网络抖一下，挡不住一次换版：重铺一个席位要拉
 * 发布包、解包、rsync 一份 app、重启两个单元，两个端口还各自自证 30 秒——几分钟是
 * 常态。40 档 ≈ 5 分钟（前 5 档退避到 8 秒，之后每档 8 秒），够一次换版走完。
 */
export const CHAT_RETRY_MAX = 40

/** 连接活够这么久，就算「真的连上过」，退避档位归零。 */
export const CHAT_ALIVE_MS = 10_000

/** 认输之后的慢速长跑：每 30 秒试一次，只要这一页还开着就不停。 */
export const CHAT_IDLE_RETRY_MS = 30_000

/** 对话流第 attempt 次重连前等多久。 */
export function chatRetryDelay(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 8000)
}

export const ROSTER_BACKOFF = [500, 1000, 2000, 4000, 8000, 15_000, 30_000]

/** 名单流第 attempt 次重连前等多久；退避到 30 秒一档之后就一直是 30 秒。 */
export function rosterRetryDelay(attempt: number): number {
  return ROSTER_BACKOFF[Math.min(attempt, ROSTER_BACKOFF.length - 1)]
}

/**
 * 下一次重连用哪个档位，判据是**这次连接活了多久**，不是「有没有连上」。两头都要照顾：
 *
 * - 只看「连上了没有」：bot 在崩溃重启循环里（接受连接后立刻断），每次都拿到 200，
 *   档位每次归零，于是每 500ms 重连一次、永远停不下来，也永远走不到「连接断开」。
 * - 只看「一共重连过几次」：一个开着一整天的标签页，被中间那一跳定期掐断 6 次之后
 *   就再也接不回来了——可每一次它都是连上的。
 *
 * 活够 CHAT_ALIVE_MS 才算一次真连接，归零；没活够就沿用当前档位继续退避。
 */
export function aliveLongEnough(openedAt: number, now: number = Date.now()): boolean {
  return now - openedAt >= CHAT_ALIVE_MS
}

/**
 * 一条流的 HTTP 状态该怎么处置。两类，处置相反，所以必须分开：
 *
 * · **401 / 403 / 404 是「答案不会变」**：票过期了、这颗 Bot 不是你的、席位在那台
 *   机器上已经没了。重试只会白敲接口。当场认输（`dead`）。
 * · **503 和其余非 2xx 是中间这几跳的临时故障**：503 是席位此刻不在（管家对席位的 fetch
 *   抛了或没回 2xx），502 是管家反代不到席位，换版那几分钟里它就是这个样子。退避重试
 *   （`warming`）。
 */
export function classifyStreamStatus(status: number, hasBody: boolean): 'open' | 'warming' | 'dead' {
  if (status === 401 || status === 403 || status === 404) return 'dead'
  if (status >= 200 && status < 300 && hasBody) return 'open'
  return 'warming'
}
