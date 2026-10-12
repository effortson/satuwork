import type { AgentMessage } from '@earendil-works/pi-agent-core'

/**
 * 轮内上下文护栏：挂在 pi 的 `transformContext` 上，**每一次**调模型之前过一遍。
 *
 * 跨轮的压缩（compactOnce）只在轮首、轮末看一眼，而且切点只能落在 `turn/end` 上、
 * 至少要整轮留下最后一轮。于是有一种情形它完全够不着：**一轮之内**连着读了几十次
 * 表格、XML、网页，每次几万 token，涨着涨着就撞了窗口——provider 回一句「input
 * exceeds the context window」，这一轮作废。更糟的是这条巨型轮次成了「最后一轮」，
 * 下一句话轮首压缩也只能原样留着它，于是这条会话之后**每一句都失败**，只剩 `/new`。
 *
 * 这里的办法：快到顶时，把**模型已经看过的、较早的大块工具结果**在送出去的那份里
 * 换成一句占位（留个开头，好让模型认得出那是哪次调用）。
 *
 * · 只改送出去的那份。pi 的 transformContext 返回新数组、不碰 agent 的 state，
 *   会话日志里原文一个字不少；界面、/history、下一轮重建历史都照旧。
 * · 只动工具结果。用户的话、助手的话、摘要都不碰——那些丢了模型就不知道自己在干嘛；
 *   工具结果丢了，大不了按占位里说的重新读一次需要的那一段。
 * · 只动模型**已经看过**的（后面跟着助手消息的）。刚回来的那条一次都还没给模型看，
 *   省掉它等于这次调用白做。
 * · **一旦省了就一直省**（按 toolCallId 记）。每次从零挑的话，省掉的那一段会随着总量
 *   上下浮动，请求前缀天天变，provider 的提示词缓存一次也命中不了。
 * · 有滞回：超过 `trigger` 才动手，一动就省到 `target` 以下。否则到顶之后每一步都要
 *   多省一条，缓存同样一步一废。
 */

/** 超过窗口的这个比例才开始省。估算偏低（XML、数字串都比 3.6 字符一 token 密），留足余量。 */
const TRIGGER = 0.85
/** 一旦动手，省到这个比例以下。和 TRIGGER 之间那一段是滞回，见上。 */
const TARGET = 0.65
/** 小于这个估算 token 数的工具结果不值得省：省一条就废一段缓存，换回来的不够。 */
const MIN_ELIDE_TOKENS = 2_000
/** 占位里留多少原文开头。够认出「这是读哪个文件、哪个区间」就行。 */
const HEAD_CHARS = 400
/**
 * 本地估算往上放的倍数。只乘在「估」出来的那部分上，实测不乘。
 *
 * estTokens 按 3.6 字符一 token 算，表格 XML、数字串、base64 实际密得多；估低的代价是
 * 撞窗口、这一轮作废，估高的代价只是早省几条工具结果。省下来的量反倒**不乘**：
 * 那边估低是安全的方向（实际腾出的比算的多）。
 */
const EST_SLACK = 1.2
/** 输出预留最多占窗口的这个比例。目录里偶尔有 maxTokens 写得比窗口还大的，不能让它把额度吃光。 */
const MAX_OUTPUT_SHARE = 0.5

export interface TurnContextGuardOptions {
  /** 模型的上下文窗口（token）。 */
  window: number
  /** 模型的最大输出（token）。不少 provider 要求「输入 + 最大输出 ≤ 窗口」，所以从窗口里扣掉。 */
  maxOutput?: number
  /** system prompt + 工具表的估算。messages 里看不到它们，但第一次调用之前只能靠估。 */
  overhead: number
  /** 这一轮的消息从 messages 的第几条开始。在这之前的助手消息上的 usage 是旧的（可能在压缩之前），不认。 */
  base: number
  /**
   * 进这一轮之前，上一条上下文边界之后 provider 回报过的输入高水位（observedPromptHighWater）。
   *
   * 这一轮第一次调用时还没有本轮的实测，只能靠估——而表格 XML、数字串比估算的 3.6 字符
   * 一 token 密得多，一份实际 100 万的上下文可能只估出 70 万，护栏根本不动手。上一轮
   * 撞了窗口、这一轮一上来又撞，靠的就是这个下限拦住。
   */
  prior?: number
  /** 一组消息的估算 token 数。由调用方注入，和压缩用同一把尺子。 */
  estimate: (messages: AgentMessage[]) => number
  /** 每次新省掉一批时报一声，调用方写日志。 */
  onElide?: (info: { count: number; freed: number; projected: number; limit: number; total: number }) => void
  /** 全省完了仍然超——只能交给 provider 去拒，但要留一行日志说明不是护栏没跑。 */
  onExhausted?: (info: { projected: number; limit: number }) => void
}

/** 这一次请求能带多少输入 token。 */
export function inputLimit(window: number, maxOutput?: number): number {
  const reserve = Math.min(maxOutput && maxOutput > 0 ? maxOutput : 0, window * MAX_OUTPUT_SHARE)
  return Math.max(0, window - reserve)
}

export function turnContextGuard(opts: TurnContextGuardOptions) {
  const limit = inputLimit(opts.window, opts.maxOutput)
  const trigger = limit * TRIGGER
  const target = limit * TARGET
  /** toolCallId → 换上去的占位文本。按 id 记，不按对象：pi 哪天开始拷贝消息也不会失忆。 */
  const elided = new Map<string, string>()
  /** 最近一次实测用量所在的消息下标，以及那之后又省掉了多少（实测里还含着它们）。 */
  let observedAt = -1
  let freedSinceObserved = 0
  /** 这一轮一共省掉多少。prior 是进轮之前量的，本轮所有省略都要从它里面扣。 */
  let freedTotal = 0
  let exhaustedReported = false

  const apply = (messages: AgentMessage[]): AgentMessage[] =>
    elided.size
      ? messages.map((m: any) =>
          m?.role === 'toolResult' && elided.has(m.toolCallId)
            ? ({ ...m, content: [{ type: 'text', text: elided.get(m.toolCallId)! }] } as AgentMessage)
            : m,
        )
      : messages

  /**
   * 这次请求大概多大。
   *
   * 有这一轮里的实测（上一步 provider 回报的输入 + 它自己的输出）就用实测打底，只估
   * 那之后新增的部分——实测含 system、工具表、provider 的特殊 token，比本地估准得多。
   * 没有（这一轮第一次调用）就整份估，再拿 prior 兜底。prior 不总在：轮首那次同步压缩
   * 一落盘，边界之后就还没有实测了，所以整份估的那条也要放余量（EST_SLACK）。
   */
  const project = (messages: AgentMessage[]): number => {
    for (let i = messages.length - 1; i >= opts.base; i--) {
      const m: any = messages[i]
      if (m?.role !== 'assistant') continue
      const u = m.usage
      const seen = (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0)
      if (!seen) continue
      if (i !== observedAt) {
        observedAt = i
        freedSinceObserved = 0
      }
      return seen + (u?.output ?? 0) + EST_SLACK * opts.estimate(apply(messages.slice(i + 1))) - freedSinceObserved
    }
    return Math.max(EST_SLACK * (opts.overhead + opts.estimate(apply(messages))), (opts.prior ?? 0) - freedTotal)
  }

  return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    // 契约：不许抛。算挂了就原样放行，最坏是 provider 拒收——跟没有护栏时一样。
    try {
      let projected = project(messages)
      if (projected <= trigger) return apply(messages)

      // 模型看过的边界：最后一条助手消息之前的工具结果都已经送进去过至少一次。
      let lastAssistant = -1
      for (let i = messages.length - 1; i >= 0; i--) {
        if ((messages[i] as any)?.role === 'assistant') {
          lastAssistant = i
          break
        }
      }
      let count = 0
      let freed = 0
      for (let i = 0; i < lastAssistant && projected > target; i++) {
        const m: any = messages[i]
        if (m?.role !== 'toolResult' || !m.toolCallId || elided.has(m.toolCallId)) continue
        const size = opts.estimate([m])
        if (size < MIN_ELIDE_TOKENS) continue
        const text = placeholder(m, size)
        const saved = size - opts.estimate([{ ...m, content: [{ type: 'text', text }] }])
        if (saved <= 0) continue
        elided.set(m.toolCallId, text)
        projected -= saved
        freedSinceObserved += saved
        freedTotal += saved
        freed += saved
        count += 1
      }
      if (count) opts.onElide?.({ count, freed, projected, limit, total: elided.size })
      if (projected > limit && !exhaustedReported) {
        exhaustedReported = true
        opts.onExhausted?.({ projected, limit })
      }
      return apply(messages)
    } catch {
      return messages
    }
  }
}

function placeholder(m: any, size: number): string {
  const text = (Array.isArray(m.content) ? m.content : [])
    .filter((c: any) => c?.type === 'text')
    .map((c: any) => c.text ?? '')
    .join('')
  const images = (Array.isArray(m.content) ? m.content : []).filter((c: any) => c?.type === 'image').length
  const head = text.length > HEAD_CHARS ? text.slice(0, HEAD_CHARS) + '…' : text
  return (
    `[这条工具结果原有约 ${size.toLocaleString('en-US')} token${images ? `（含 ${images} 张图）` : ''}，` +
    '这一轮上下文快装满了，已从送给你的上下文里省去；会话记录里原文还在。' +
    '还需要其中的内容就重新调用工具，只读需要的那一段。开头是：]\n' +
    head
  )
}
