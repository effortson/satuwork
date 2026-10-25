import type { Context } from '@deepseek-ai/cordis'
import type { SessionEventMap } from '../session/types.ts'
import { budgetToolText } from '../tools/result-budget.ts'
import { humanTime } from '../time.ts'
import { MAX_LIVE_TOOL_IMAGES } from './images.ts'
import { contentDigest, estTokens, textFrom } from './text.ts'

/** 上下文压缩：边界在哪、估多大、从哪切、摘要怎么写。 */

/** 摘要输入的上限。 */
const MAX_SUMMARY_INPUT = 60_000
/** 超限时头部至少保住这么多字符——上一次的摘要就在这里。 */
const SUMMARY_HEAD_KEEP = 20_000

/**
 * 摘要输入超限时**掐中间**，头尾都留。
 *
 * 不能简单地 slice(-N) 只留末尾：级联压缩时 toAgentMessages 把上一次的摘要放在
 * 第一条，于是「只留末尾」第一个丢掉的就是它——新摘要因此不含第一次压缩之前的任何
 * 事实，摘要链当场断掉，而且没有任何报错。头部留一段、尾部留一段，中间那截标注
 * 掉了多少：中间那些原文仍在 JSONL 里，模型需要就用 history_read 调。
 */
export function clampTranscript(text: string): string {
  if (text.length <= MAX_SUMMARY_INPUT) return text
  const head = text.slice(0, SUMMARY_HEAD_KEEP)
  const tail = text.slice(-(MAX_SUMMARY_INPUT - SUMMARY_HEAD_KEEP))
  const dropped = text.length - head.length - tail.length
  return `${head}\n\n…（中间省略约 ${dropped} 字，原文仍可用 history_read 按时间调取）…\n\n${tail}`
}

const SUMMARY_SYSTEM = [
  '你在给一段对话写摘要，它会替代原文进入后续对话的上下文。读它的是接着聊下去的 AI 助理，不是人。',
  '',
  '必须保留：',
  '- 用户交代过的事实、偏好、约束（名字、账号、口径、忌讳）',
  '- 已经做出的决定和结论，以及为什么',
  '- **没做完的事**：待办、承诺过要做的、卡住的地方',
  '- 关键的时间点，写成「8月18日 22:10」这样的绝对时间，不要写「昨天」',
  '- 产出物的位置（文件路径、链接、命令）',
  // 压缩会把 skill_view 的结果整段压掉，而模型不知道自己曾经打开过——它会照着摘要
  // 继续干，干得看起来很像那么回事。留下名字，它重新 skill_view 一次就回来了。
  '- **这一段里打开过哪些 Skill**（照抄名字，写成「用了 Skill：退款审核」）',
  '',
  '可以丢掉：寒暄、重复、工具调用的原始输出（只留结论）、已经被推翻的中间过程。',
  '',
  '用中文，分条写，不要客套，不要写「以下是摘要」这类开场白。直接从内容开始。',
].join('\n')

/**
 * content 数组压成一行，估算和摘要输入用。
 *
 * 两种形状都要收：pi 的 `toolCall` 和我们日志里的 `tool-call`。估算走的是日志事件、
 * 摘要走的是重建后的消息，漏掉一种就会把带工具的那些轮次估成 0。
 */
/**
 * 跑一次摘要模型，取出它写的文字。没写出来（出错、空回）就是空串，由调用方当「没压成」。
 *
 * 单独拎出来是为了能测：streamFn 在生产上返回 **Promise**（streamViaGateway 是 async），
 * 而 e2e 的假模型只会回错误、到不了这一步。以前这里少一个 await，`for await` 对着
 * Promise 抛「stream is not async iterable」——压缩从上线起在生产上一次都没成功过，
 * 测试却一直是绿的。e2e-compact 拿一个返回 Promise 的假 streamFn 钉住它。
 */
export async function runSummary(
  streamFn: (model: any, context: any, options?: any) => unknown,
  model: any,
  transcript: string,
  options?: Record<string, unknown>,
): Promise<string> {
  const stream = await streamFn(
    model,
    {
      systemPrompt: SUMMARY_SYSTEM,
      messages: [{ role: 'user', content: transcript, timestamp: Date.now() }],
      tools: [],
    },
    options,
  )
  for await (const event of stream as AsyncIterable<any>) {
    if (event.type !== 'done') continue
    return (event.message?.content ?? [])
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('')
      .trim()
  }
  return ''
}

/**
 * 挑压缩边界：**从后往前**累加，直到近期这一段吃满预算，切在再往前的那个 turn/end 上。
 *
 * 只切在 `turn/end` 上，这条是硬的。切在一轮中间的话，带 tool_calls 的助手消息会被
 * 摘要吃掉，而它的 tool/result 留在后面——provider 直接拒收整个请求。切在 turn/end
 * 上，边界两侧各自都是完整的轮次。
 *
 * 返回 undefined 表示没有可切的位置：要么压根没跑完过一轮，要么最近一轮自己就超了
 * 预算（单轮塞进巨大的工具结果就会这样）。这两种情况压缩都帮不上忙。
 */
/**
 * 这条会话当前的上下文边界：最后一条压缩点（`session/compact`）或重置点
 * （`session/reset`），谁在后面算谁。
 *
 * **两种是同一类东西**——都在回答「下一轮请求从哪儿开始」，区别只在压缩点额外留了
 * 一段摘要。所以判定只能有这一份：任何一处只认 compact，`/new` 就会在那一处失效
 * （最贵的一处见 scopeAfterBoundary）。
 */
export function contextBoundary(events: Awaited<ReturnType<Context['sessions']['events']>>) {
  return [...events]
    .reverse()
    .find((e) => e.type === 'session/compact' || e.type === 'session/reset') as
    | Extract<Awaited<ReturnType<Context['sessions']['events']>>[number], { type: 'session/compact' | 'session/reset' }>
    | undefined
}

/**
 * 挑新压缩边界时能看的范围：上一条上下文边界之后的部分。
 *
 * 压过（或重置过）一次之后，前面那一段在日志里还是原样躺着。按全量去挑，挑到的位置
 * 可能比上次更早——而 toAgentMessages 认的是**最后**一条边界，于是「再压一次」反而把
 * 上次压掉的原文放了回来，越压越大。边界必须单调向前。
 *
 * **这里认两种边界，不只是压缩点。** 只认 compact 的话，`/new` 之后的第一次自动压缩
 * 会从重置点**之前**挑边界，把人刚扔掉的原文整段放回上下文——那一刀于是在几轮之后
 * 无声失效，而没有任何地方会报错。
 */
export function scopeAfterBoundary(
  events: Awaited<ReturnType<Context['sessions']['events']>>,
): Awaited<ReturnType<Context['sessions']['events']>> {
  const prior = contextBoundary(events)
  return prior ? events.filter((e) => e.seq > prior.data.throughSeq) : events
}

/**
 * 压缩按多大的「窗口」算：上下文窗口和**最低一道价格门槛**取小。
 *
 * 门槛是目录里 `cost.tiers[].inputTokensAbove`（pi-ai 内置和 models.dev 自动发现都带，
 * 和 Gateway 计价认的是同一张表，见 gateway/src/lib/pricing.ts 的 tierFor）。OpenAI 的
 * gpt-5.4 / 5.5 / 6.x 输入过 272k **整次**翻倍收，而这批模型的窗口在一百万上下——
 * 只按窗口算的话要到 84 万（× compactAt）才压，27 万到 84 万之间的每一次调用都是两倍价。
 * 2026-10-11 一条 gpt-6.1-sol 的调用输入 75.6 万、缓存零命中，一次就记了 $3.51。
 *
 * 门槛当窗口用，compactAt / compactKeep / compactHard 三个比例**原样套上去**：照旧在
 * 八成时压、留三成原文，过门槛之前留出的余量和窗口那边是同一个道理（这一轮之后还要长
 * 的工具结果和输出）。代价是这类模型压得勤一些，摘要多花一点——一次摘要调用远比一路
 * 两倍价的几十次调用便宜。
 *
 * 不碰的两处：界面上的上下文占比（那是「还装得下多少」，门槛不是装不下）和钉的模型
 * 装不装得下（同理）。窗口未知时照旧回落到 fallback；没有档位就是窗口本身。
 */
export function compactionWindow(window: number, cost: unknown): number {
  const tiers = (cost as { tiers?: unknown } | null | undefined)?.tiers
  let cliff = Infinity
  if (Array.isArray(tiers)) {
    for (const t of tiers) {
      const above = Number((t as { inputTokensAbove?: unknown } | null)?.inputTokensAbove)
      if (Number.isFinite(above) && above > 0 && above < cliff) cliff = above
    }
  }
  return Math.min(window, cliff)
}

/**
 * 最后一条上下文边界真正落盘之后，provider **最近一次**回报的 prompt token 数（input + cache read）。
 *
 * 用 boundary.seq，不用 throughSeq：compact 事件会保留几轮原文，而这些原文上的 usage
 * 仍描述“压缩前的整份请求”。只有 compact/reset 事件之后新写的 assistant/message，
 * 才代表当前上下文形状。
 *
 * **取最近一次，不取最大值。** 以前取的是高水位，默认上下文在两条边界之间只涨不跌——可它会跌：
 * 重建历史的规则一变（2026-09 起超大工具结果重放时瘦身、派活那几轮不进后续上下文、只有最后几张
 * 图带字节），同一段日志重建出来就小得多，而边界一条都没新增。线上编程大师那条会话：8 月 29 日
 * 一次读了一大块工具结果，那次调用报了 67 万；之后每次实际只有五六万，高水位却一直是 67 万，
 * 轮内护栏每轮开头都喊「超窗口、多半会被拒」，而压缩又因为 67 万没到窗口的八成，永远不压、永远清不掉。
 *
 * 最近那次之后又长出来的部分，护栏和压缩各自另有本地估算兜着；最近那次要是派活那一轮里的
 * （之后不进上下文），只是往高估了一轮，下一次调用就量回来了。用量为 0 的（出错补的那条、老日志）跳过。
 *
 * **「最近一次」按轮算：取最近那一轮里的最大值，不取它的最后一步。** 一轮之内上下文只涨不跌，
 * 唯一的例外是轮内护栏（context-guard.ts）省掉了早先的工具结果——它只改送出去的那份，日志里原文
 * 一个字不少，下一轮重建时全部回来。逼近窗口的那一轮，最后几步量到的是省过之后的（比如 0.65），
 * 拿它当下一轮的 prior、当轮末压缩的依据，压缩不动手（没到 0.8），下一轮一开口就是 0.9 以上，
 * 撞窗口被拒——正是 prior 要拦的那种。同一轮里省之前那一步量到的才是重建之后的真实大小。
 */
export function observedPromptTokens(
  events: Awaited<ReturnType<Context['sessions']['events']>>,
): number {
  const boundary = contextBoundary(events)
  let turn: number | undefined
  let high = 0
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (boundary && event.seq <= boundary.seq) break
    if (event.type !== 'assistant/message') continue
    const usage = event.data.usage
    const seen = (usage?.inputTokens ?? 0) + (usage?.cacheReadTokens ?? 0)
    if (!seen) continue
    if (turn === undefined) turn = event.data.turn
    else if (event.data.turn !== turn) break
    high = Math.max(high, seen)
  }
  return high
}

export function compactionPoint(
  events: Awaited<ReturnType<Context['sessions']['events']>>,
  keepBudget: number,
  /** 这一轮的模型看不看得了图。默认 true：估高只是早压一轮，估低是撞窗口。 */
  sees = true,
): { seq: number; time: number } | undefined {
  // 每条事件进模型时值多少 token，一次算完；再求后缀和，于是「切在这里之后还剩多少」
  // 是 O(1)。挨个切点重跑一遍 toAgentMessages 是 O(n²)，长会话上会明显卡一下。
  const liveTool = liveToolImageKeys(events)
  const cost = events.map((e) => estEvent(e, sees, liveTool))
  const suffix = new Array<number>(events.length + 1).fill(0)
  for (let i = events.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + cost[i]

  const ends: { seq: number; time: number; after: number }[] = []
  for (let i = 0; i < events.length; i++) {
    if (events[i].type === 'turn/end') ends.push({ seq: events[i].seq, time: events[i].time, after: suffix[i + 1] })
  }
  // 至少要压掉一轮、也至少要留一轮，所以可切的位置是 ends[0 .. length-2]。
  if (ends.length < 2) return undefined

  const maxCut = ends.length - 2
  // 从最早的切点往后找第一个「保留部分装得下」的：越早切保留得越多，第一个装得下的
  // 就是在预算内能留住最多原文的那个。
  for (let i = 0; i <= maxCut; i++) {
    if (ends[i].after <= keepBudget) return { seq: ends[i].seq, time: ends[i].time }
  }
  // 一个都装不下——连只留最后一轮都超预算。那就切在最靠后的允许位置，能省多少省多少。
  return { seq: ends[maxCut].seq, time: ends[maxCut].time }
}

/**
 * 一张图进上下文时按多少 token 算。
 *
 * 各家按分块数算，一张常见截图落在一两千之间。这个数字只用来决定「什么时候该压」，
 * 宁可估高一点：估低的代价是撞窗口，估高的代价只是早压一轮。
 */
const EST_TOKENS_PER_IMAGE = 1_500

/**
 * 工具结果里**这一轮会带字节**的那几张图（`seq:下标`），和 toAgentMessages 里 liveToolImages
 * 同一个口径：按顺序数，只留最后 MAX_LIVE_TOOL_IMAGES 张。
 */
function liveToolImageKeys(events: Awaited<ReturnType<Context['sessions']['events']>>): Set<string> {
  const keys: string[] = []
  for (const e of events) {
    if (e.type === 'tool/result') e.data.images?.forEach((_, i) => keys.push(`${e.seq}:${i}`))
  }
  return new Set(keys.slice(-MAX_LIVE_TOOL_IMAGES))
}

/** 一句「看不了图 / 离太远」的说明大约值多少 token。 */
const EST_TOKENS_PER_IMAGE_NOTE = 40

/**
 * 单条事件进模型时的估算大小。不进上下文的事件（chunk、header…）算 0。
 *
 * 工具结果里的图按**这一轮实际会送进去的**算：看不了图的模型只收到一句说明，能看图的也
 * 只有最近几张带字节（liveTool），其余都是一句话。全按图算的话，一个看不了图、却调过几次
 * office_render 的会话会被估高几万 token，压缩提前触发，白白丢掉还装得下的原文。
 */
function estEvent(e: Awaited<ReturnType<Context['sessions']['events']>>[number], sees = true, liveTool?: Set<string>): number {
  if (e.type === 'user/message') {
    // 图片按张计，别按 textFrom 的结果算——textFrom 只取文本块，一条「看看这张图」
    // 会被估成十几个 token，而它实际值一两千。带图的会话会因此一路估不到阈值，
    // 等真撞上窗口时压缩根本没触发过。
    const images = e.data.message.content.filter((c) => c.type === 'image').length
    return estTokens(textFrom(e.data.message)) + 12 + images * EST_TOKENS_PER_IMAGE // 12 ≈ [时间] 前缀
  }
  if (e.type === 'assistant/message') return estTokens(contentDigest(e.data.message.content)) + 4
  if (e.type === 'tool/result') {
    let images = 0
    e.data.images?.forEach((_, i) => {
      images += sees && (!liveTool || liveTool.has(`${e.seq}:${i}`)) ? EST_TOKENS_PER_IMAGE : EST_TOKENS_PER_IMAGE_NOTE
    })
    return estTokens(e.data.modelText ?? budgetToolText('', e.data.text).text) + 4 + images
  }
  return 0
}

/** 摘要消息的正文。**必须写出覆盖区间**，否则压缩之后「昨天」就断了。 */
export function summaryText(d: SessionEventMap['session/compact']): string {
  return [
    `[对话摘要 · ${humanTime(d.from)} 至 ${humanTime(d.to)}]`,
    '这一段是更早的对话被压缩后的摘要，不是用户说的话。',
    '原始对话一条没删：需要原文就用 history_read 按时间区间调出来，找具体某句话用 history_search。',
    '',
    d.summary,
  ].join('\n')
}
