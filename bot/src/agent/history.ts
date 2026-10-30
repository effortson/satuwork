import type { Context } from '@deepseek-ai/cordis'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ContentBlock, Message, RefBlock, SessionEvent, SessionEventMap } from '../session/types.ts'
import { budgetToolText } from '../tools/result-budget.ts'
import { withoutTaskTurns } from './task-turns.ts'
import { humanTime } from '../time.ts'
import { contextBoundary, summaryText } from './compaction.ts'
import { loadImage, MAX_LIVE_IMAGES, MAX_LIVE_TOOL_IMAGES, replayToolImages, seesImages, stale } from './images.ts'
import { refFallback, refHead, safeParse, textFrom } from './text.ts'
import { piUsage } from './tool-results.ts'
import type { ImageRef, Mention } from './types.ts'

/** 从会话日志重建模型看到的历史：用户消息（时间、图、点名、引用）、助手消息、工具结果。 */

/**
 * 从日志重建 pi 的历史。
 *
 * 只读三种事件；推理块不回传——它是给人看的，回传既费 token 又可能干扰下一轮。
 *
 * **顺序要重排**：日志按真实时序记录，而 pi 在 `turn_end` 才给出最终助手消息，
 * 所以带 tool-call 的那条排在它自己的 tool/result 之后。直接按 seq 喂回去，
 * provider 会拒绝——「role 'tool' 必须紧跟在带 tool_calls 的消息之后」。
 * 这里把每个 step 的工具结果挂到该 step 助手消息的后面。
 *
 * **时间从事件信封上取，不是重建的时刻。** 以前这里是 `const ts = Date.now()`，
 * 一份盖在所有消息上：一条跨了三天的长会话，在模型眼里每一句都是「刚刚」说的。
 * 「我昨天跟你说了什么」于是无解——不是历史没进上下文，是历史进去了但没有时间。
 */
export async function toAgentMessages(
  events: Awaited<ReturnType<Context['sessions']['events']>>,
  model: { api?: string; provider?: string; id?: string; input?: unknown } = {},
  ctx?: Context,
): Promise<AgentMessage[]> {
  const stepKey = (t: number, s: number) => `${t}:${s}`

  // 最后一条上下文边界之前的事件不逐条回传。只认最后一条：每次压缩都是把「摘要 +
  // 这段时间的新对话」再压一次，所以后一条必然覆盖前一条；而 /new 打下的重置点更是
  // 明说了前面的不要了。压缩点还要换成一条摘要消息（见文件末尾那一段），重置点不换。
  const boundary = contextBoundary(events)
  // 边界之前的事件不逐条回传，但**引用要能指到它们**：被压缩掉的那条回复，全文正是
  // 从这份全量里读出来的（见 refTextOf）。所以切之前留一份。
  const allEvents = events
  if (boundary) events = events.filter((e) => e.seq > boundary.data.throughSeq)
  // 主 Bot 派来的活那几轮不进上下文（见 task-turns.ts）。压缩的摘要也走这里，所以不会从摘要里漏回来。
  events = withoutTaskTurns(events)

  // 先找出每个 step 的助手消息落在哪个 seq，工具结果据此排到它后面。
  const assistantSeq = new Map<string, number>()
  /**
   * 没有名字的工具调用：连它的结果一起丢掉，不回传给模型。
   *
   * 来源是 `consumeOpenAI` 那个已经修掉的下标错位（见 llm/gateway.ts），可**已经写下
   * 的日志里还留着**。一把叫「」的工具谁也执行不了，回传它只有两种下场：好一点的是白
   * 占几个 token 外加教模型「可以有空名字的调用」，坏一点的是上游直接拒收整条请求
   * （name 空、tool_call_id 空），那这个会话从此一句话都答不了。
   *
   * 必须成对丢：只丢调用会留下一条无主的 toolResult，Anthropic 那边同样是硬拒。
   */
  const nameless = new Set<string>()
  const toolNames = new Map<string, string>()
  /**
   * 调用与结果要**成对**回传，缺哪一半都会被 provider 硬拒。
   *
   * `resultIds`：日志里有结果的那些调用。有 tool-call 没结果的（进程在工具跑到一半时
   * 死了、或者这一步被掐了），回传时补一条 error 结果，说明「被中断，没有结果」；
   * 有结果没 tool-call 的（助手消息没写下来、或者被上面 nameless 那道筛掉了），
   * 连结果一起丢——它没有锚点，放哪儿都是无主的。
   */
  const resultIds = new Set<string>()
  /** 每个 step 的下界（step/start，老日志没有它时用第一条 tool/call）：给插话挪位用，见下。 */
  const stepFrom = new Map<string, number>()
  /** 每个 step 开跑过的工具（tool/call），给下面「助手消息没落盘」那种情况补锚点用。 */
  const callsOf = new Map<string, { seq: number; time: number; calls: SessionEventMap['tool/call'][] }>()
  for (const e of events) {
    if (e.type === 'step/start' || e.type === 'tool/call') {
      const key = stepKey(e.data.turn, e.data.step)
      if (!stepFrom.has(key)) stepFrom.set(key, e.seq)
      if (e.type === 'tool/call') {
        const got = callsOf.get(key) ?? { seq: e.seq, time: e.time, calls: [] }
        got.calls.push(e.data)
        callsOf.set(key, got)
      }
    } else if (e.type === 'tool/result') {
      resultIds.add(e.data.callId)
    } else if (e.type === 'assistant/message') {
      assistantSeq.set(stepKey(e.data.turn, e.data.step), e.seq)
      for (const c of e.data.message.content) {
        if (c.type !== 'tool-call') continue
        if (!String(c.name || '').trim()) nameless.add(c.callId)
        else toolNames.set(c.callId, c.name)
      }
    }
  }
  /**
   * **这一步开跑过工具、助手消息却没落盘**：进程死在这一步中间了。
   *
   * 带 tool-call 的助手消息要等 pi 的 `turn_end`——也就是这一步**所有**工具都跑完——才写，
   * 而工具结果是一个个先落盘的。同一步并行调了 send_email（已发出、结果已写）和一个长时间的
   * terminal，这时 OOM / 重铺把进程杀了：重建时找不到这一步的助手消息，send_email 那条结果
   * 被当成无主的丢掉，下一轮模型完全不知道邮件已经发过，很可能再发一次。
   *
   * 每把工具开跑时都先写了 `tool/call`（名字、参数都在），拿它们补出这一步的助手消息，锚在
   * 第一条 tool/call 上。有结果的照常挂在后面，没结果的走下面「有调用没结果」那条补 error。
   */
  const synthesized = new Map<number, { key: string; time: number; calls: SessionEventMap['tool/call'][] }>()
  for (const [key, step] of callsOf) {
    if (assistantSeq.has(key)) continue
    const calls = step.calls.filter((c) => String(c.name || '').trim())
    if (!calls.length) continue
    assistantSeq.set(key, step.seq)
    for (const c of calls) toolNames.set(c.callId, c.name)
    synthesized.set(step.seq, { key, time: step.time, calls })
  }

  /**
   * 插话（steer）的落位。
   *
   * `steer()` 是在这一步跑到一半时把 user/message 写下来的，seq 落在这一步的 step/start
   * 和 assistant/message 之间；而 pi 实际是把它排在**这一步的助手消息和工具结果之后**才
   * 送进模型的。按 seq 原样回放，重建出来的历史会把那句话放到它其实还没说的位置上，
   * 和模型当时看到的顺序对不上。这里把落在窗口里的 user/message 排到该步助手消息及其
   * 工具结果之后（结果用的偏移都远小于 0.5）。
   */
  const steerWindows = [...assistantSeq.entries()]
    .map(([key, to]) => ({ from: stepFrom.get(key) ?? -1, to }))
    .filter((w) => w.from >= 0)
    .sort((x, y) => x.to - y.to)
  let windowIndex = 0
  let steerIndex = 0
  const userOrder = (seq: number): number => {
    while (windowIndex < steerWindows.length && steerWindows[windowIndex]!.to < seq) windowIndex++
    const w = steerWindows[windowIndex]
    return w && w.from < seq && seq < w.to ? w.to + 0.5 + 1e-6 * ++steerIndex : seq
  }

  /**
   * 哪几张图这一轮真的要带上字节。
   *
   * 不加这道闸，历史里每一张图每一轮都会被重新读盘、重新 base64、重新发给模型——
   * 开销随图片数线性涨，而且**只增不减**：十张 3 MB 的图就是每轮 30 MB 磁盘读、
   * 约 40 MB 字符串同时驻留、外加一两万 token。人真正在问的几乎总是最近那几张，
   * 更早的换成一句说明就够。
   */
  const imageKeys: string[] = []
  for (const e of events) {
    if (e.type !== 'user/message') continue
    e.data.message.content.forEach((c, i) => {
      if (c.type === 'image') imageKeys.push(`${e.seq}:${i}`)
    })
  }
  const liveImages = new Set(imageKeys.slice(-MAX_LIVE_IMAGES))
  /** 工具结果里的图同理，只是单独一份额度（见 MAX_LIVE_TOOL_IMAGES）。 */
  const toolImageKeys: string[] = []
  for (const e of events) {
    if (e.type !== 'tool/result' || !toolNames.has(e.data.callId)) continue
    e.data.images?.forEach((_, i) => toolImageKeys.push(`${e.seq}:${i}`))
  }
  const liveToolImages = new Set(toolImageKeys.slice(-MAX_LIVE_TOOL_IMAGES))
  const sees = seesImages(model)

  const entries: { order: number; message: AgentMessage }[] = []
  let resultIndex = 0

  for (const e of events) {
    const lost = synthesized.get(e.seq)
    if (lost) {
      entries.push({
        order: e.seq,
        message: {
          role: 'assistant',
          content: lost.calls.map((c) => ({ type: 'toolCall', id: c.callId, name: c.name, arguments: safeParse(c.arguments) })),
          api: model.api ?? 'unknown',
          provider: model.provider ?? 'unknown',
          model: model.id ?? 'unknown',
          usage: piUsage(undefined),
          timestamp: lost.time,
        } as any,
      })
      for (const c of lost.calls) {
        if (resultIds.has(c.callId)) continue
        entries.push({
          order: e.seq + 1e-6 * ++resultIndex,
          message: {
            role: 'toolResult',
            toolCallId: c.callId,
            toolName: '',
            content: [{ type: 'text', text: '工具执行被中断，没有结果。' }],
            isError: true,
            timestamp: lost.time,
          } as any,
        })
      }
    }
    if (e.type === 'user/message') {
      entries.push({
        order: userOrder(e.seq),
        message: {
          role: 'user',
          content: stampContent(
            await userContentFor(e.data.message, ctx, (i) => liveImages.has(`${e.seq}:${i}`), allEvents),
            e.time,
          ),
          timestamp: e.time,
        } as AgentMessage,
      })
    } else if (e.type === 'assistant/message') {
      const content = e.data.message.content
        .filter((c) => c.type !== 'reasoning')
        .filter((c) => !(c.type === 'tool-call' && nameless.has(c.callId)))
        .map((c) =>
          c.type === 'tool-call'
            ? { type: 'toolCall', id: c.callId, name: c.name, arguments: safeParse(c.arguments) }
            : { type: 'text', text: (c as { text: string }).text },
        )
      if (!content.length) continue
      // 重建的助手消息必须跟 pi 自己产出的**同形**：除了 content，还要带 usage 与
      // api/provider/model。少了 usage，pi 在后续轮次读它的 totalTokens 时会炸——
      // 症状是第一轮正常、第二轮起全部失败。
      entries.push({
        order: e.seq,
        message: {
          role: 'assistant',
          content,
          api: model.api ?? 'unknown',
          provider: model.provider ?? 'unknown',
          model: model.id ?? 'unknown',
          usage: piUsage(e.data.usage),
          timestamp: e.time,
        } as any,
      })
      // 有调用没结果的，补一条 error 结果挂在这条助手消息后面（理由见 resultIds）。
      for (const c of e.data.message.content) {
        if (c.type !== 'tool-call' || nameless.has(c.callId) || resultIds.has(c.callId)) continue
        entries.push({
          order: e.seq + 1e-6 * ++resultIndex,
          message: {
            role: 'toolResult',
            toolCallId: c.callId,
            toolName: '',
            content: [{ type: 'text', text: '工具执行被中断，没有结果。' }],
            isError: true,
            timestamp: e.time,
          } as any,
        })
      }
    } else if (e.type === 'tool/result') {
      // 没有对应 tool-call 的结果不回传：nameless 那批和助手消息缺失的都在这里一起筛掉。
      if (!toolNames.has(e.data.callId)) continue
      const anchor = assistantSeq.get(stepKey(e.data.turn, e.data.step)) ?? e.seq
      entries.push({
        // 小数偏移把结果排到锚点之后、下一条整数 seq 之前，同时保持批内先后。
        order: anchor + 1e-6 * ++resultIndex,
        message: {
          role: 'toolResult',
          toolCallId: e.data.callId,
          toolName: '',
          // 新日志直接用 modelText；老日志在回放时即时套预算，所以升级后第一轮就生效，
          // 不需要清空会话，也不需要重写历史 JSONL。
          content: [
            {
              type: 'text',
              text: e.data.modelText ?? budgetToolText(toolNames.get(e.data.callId) ?? '', e.data.text).text,
            },
            ...(e.data.images?.length ? await replayToolImages(e.seq, e.data.images, sees, liveToolImages, ctx) : []),
          ],
          isError: e.data.failed,
          timestamp: e.time,
        } as any,
      })
    }
  }

  const messages = entries.sort((a, b) => a.order - b.order).map((x) => x.message)
  // 重置点不留摘要——`/new` 的全部意思就是「前面那些不要了」。截断已经在上面做完，
  // 这里直接返回；下面那一整段是压缩点专属的。
  if (!boundary || boundary.type !== 'session/compact') return messages
  const compact = boundary

  // 摘要**并进保留段的第一条用户消息**，而不是自己单独占一条。
  //
  // 单独占一条的话前两条必然都是 user：压缩边界固定落在 turn/end 上，其后第一条
  // 一定是 user/message。Anthropic 的 messages 要求角色交替，两条连续 user 会被
  // 整个请求拒掉——症状是「一旦压缩过，这个 Bot 就再也答不了话」，而 OpenAI 兼容口
  // 完全正常，本地和 e2e 都照不出来。并进去就没有这个问题，任何家都一样。
  const first = messages.findIndex((m: any) => m.role === 'user')
  const head = summaryText(compact.data)
  if (first < 0) {
    // 保留段里一条用户消息都没有。compactionPoint 保证至少留一整轮，正常到不了这里；
    // 真到了就单独挂一条，起码不把摘要丢了。
    return [{ role: 'user', content: head, timestamp: compact.data.to } as AgentMessage, ...messages]
  }
  /**
   * **正文可能是字符串，也可能是块数组。**
   *
   * `userContentFor` 只在纯文字的时候返回字符串；这条消息一旦带图（真的图块，或者
   * `stale()` 那种占位块），返回的就是数组，`stampContent` 也照数组留着。原先这里
   * 直接套模板串，数组会被 `String()` 成 `[object Object],[object Object]`——图和正文
   * 一起没了，而且这条坏消息会跟着每一轮重发，直到下一个压缩边界。压缩边界固定落在
   * turn/end 上、其后第一条就是 user/message，而带图的用户消息一点都不罕见。
   *
   * 所以按形状分开接：字符串照旧拼，数组就在最前面插一个文字块。
   */
  const target = messages[first] as any
  const content = Array.isArray(target.content)
    ? [{ type: 'text', text: head }, ...target.content]
    : `${head}\n\n${target.content}`
  messages[first] = { ...target, content }
  return messages
}

/**
 * 引用的回复渲染给模型时的全文上限（字符）。
 *
 * 引用的意义是**消除歧义**，所以给全文而不是摘录——摘录只能让模型去历史里找，而历史
 * 可能已经压缩了。被引用的那条还在上下文里时全文会重复一遍，4 KB 以内的重复不值一提；
 * 再长就截断，并告诉模型去 history_read 取。
 */
const MAX_REF_CHARS = 4_000

/** 一条消息里给人读的那部分：只要 text 块。助手消息里的 reasoning / tool-call 不算。 */
function plainTextOf(m: Message): string {
  return m.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
    .trim()
}

/**
 * 一个引用块渲染给模型的那段话。
 *
 * 消息：按 seq 在**全量**日志里找到那条，取全文（上限 MAX_REF_CHARS）。找不到（渠道
 * 接进来的只有原文、或 `/clear` 之后硬发的）退回摘录。
 *
 * 文件：只给路径，不读内容——模型有 read_file / office_unpack / look，让它自己决定读
 * 多少。文件已经不在工作区就写明，模型才不会去找。**在不在是渲染那一刻的事**：下一轮
 * 文件回来了，渲染就变了，这是对的，模型要看的是现在。
 */
async function refTextOf(
  c: RefBlock,
  events: readonly SessionEvent[] | undefined,
  ctx: Context | undefined,
): Promise<string> {
  if (c.kind === 'file') {
    const gone = await fileGone(c.path, ctx)
    return `[引用文件：\`${c.path}\`${gone ? '（已不在工作区）' : ''}]`
  }
  const hit =
    c.seq != null && events
      ? events.find((e) => e.seq === c.seq && (e.type === 'user/message' || e.type === 'assistant/message'))
      : undefined
  if (!hit || (hit.type !== 'user/message' && hit.type !== 'assistant/message')) return refFallback(c)
  const when = ` ${humanTime(hit.time)} `
  const role = hit.data.message.role
  const full = plainTextOf(hit.data.message)
  const body =
    full.length > MAX_REF_CHARS
      ? `${full.slice(0, MAX_REF_CHARS)}\n（全文 ${full.length} 字，这里只有开头；要看全可以 history_read ${humanTime(hit.time)} 前后）`
      : full || c.excerpt
  return `${refHead(role, when)}\n${body}\n[引用结束]`
}

/** 引用的文件还在不在。拿不到工作区（测试里的裸 ctx）就当在——不为这件事抛。 */
async function fileGone(path: string, ctx: Context | undefined): Promise<boolean> {
  if (!ctx) return false
  try {
    const ws = ctx.workspace
    if (!ws) return false
    const { stat } = await import('node:fs/promises')
    const info = await stat(ws.resolve(path)).catch(() => null)
    return !info?.isFile()
  } catch {
    return false
  }
}

/**
 * 把一条消息里所有引用块先解析好，交给 textFrom 用。
 *
 * 解析是异步的（读日志、stat 文件），textFrom 是同步的；分开之后 estTokens 那种只要
 * 估个数的调用方不必为引用去读盘。
 */
async function refResolver(
  m: Message,
  ctx: Context | undefined,
  events: readonly SessionEvent[] | undefined,
): Promise<(c: RefBlock) => string> {
  const refs = m.content.filter((c): c is RefBlock => c.type === 'ref')
  if (!refs.length) return refFallback
  const rendered = new Map<RefBlock, string>()
  for (const c of refs) rendered.set(c, await refTextOf(c, events, ctx))
  return (c) => rendered.get(c) ?? refFallback(c)
}

/**
 * 用户这一条消息的内容块：点名 → 引用 → 图片 → 正文，先给材料再给指令。
 *
 * 引用排在图片前面：引用的图片文件会同时以 image 块进来（界面把它并进 `images`），
 * 两块挨着，渲染出来是「[引用文件：x.png]」紧跟那张图。
 */
export function userBlocks(text: string, images: ImageRef[], mentions: Mention[] = [], refs: RefBlock[] = []): ContentBlock[] {
  const { body, leading } = interleaveMentions(text, mentions)
  const blocks: ContentBlock[] = leading.map((m) => ({ type: 'mention' as const, kind: m.kind, id: m.id, label: m.label, ...(m.logo ? { logo: m.logo } : {}) }))
  for (const r of refs) blocks.push({ ...r, type: 'ref' as const })
  for (const img of images) blocks.push({ type: 'image' as const, path: img.path, mime: img.mime })
  // 只有图（或只有点名）的消息也成立：「这张图什么意思」本来就常常没有正文。
  if (body.length) blocks.push(...body)
  else if (text || !blocks.length) blocks.push({ type: 'text', text })
  return blocks
}

/**
 * 点名和正文混排：按 `@名字` 在正文里的位置把正文切开，点名块落在它原来的位置上
 * （「打开 @Gmail 邮件，让 @客户经理 处理」= text · mention · text · mention · text）。
 *
 * 这一句话的意思全在位置里——谁去打开、谁来处理。只在最前面摆一排点名的话，模型看到的
 * 是「Gmail、客户经理，打开邮件，让处理」，指代关系丢了。
 *
 * 正文里找不到 `@名字` 的（Telegram 那条路、老界面发来的）照旧放在最前（`leading`），
 * 老格式。名字长的先认：「客户经理」和「客户经理助理」同时点了，不能把后者认成前者。
 */
export function interleaveMentions(text: string, mentions: Mention[]): { body: ContentBlock[]; leading: Mention[] } {
  if (!mentions.length || !text) return { body: [], leading: mentions }
  const hits: { at: number; end: number; m: Mention }[] = []
  const placed = new Set<Mention>()
  const byLength = [...mentions].sort((a, b) => b.label.length - a.label.length)
  for (const m of byLength) {
    const needle = `@${m.label}`
    let from = 0
    for (;;) {
      const at = text.indexOf(needle, from)
      if (at < 0) break
      const end = at + needle.length
      from = end
      if (hits.some((h) => at < h.end && end > h.at)) continue
      hits.push({ at, end, m })
      placed.add(m)
    }
  }
  if (!hits.length) return { body: [], leading: mentions }
  hits.sort((a, b) => a.at - b.at)
  const body: ContentBlock[] = []
  let cur = 0
  for (const h of hits) {
    if (h.at > cur) body.push({ type: 'text', text: text.slice(cur, h.at) })
    body.push({ type: 'mention', kind: h.m.kind, id: h.m.id, label: h.m.label, inline: true, ...(h.m.logo ? { logo: h.m.logo } : {}) })
    cur = h.end
  }
  if (cur < text.length) body.push({ type: 'text', text: text.slice(cur) })
  return { body, leading: mentions.filter((m) => !placed.has(m)) }
}

/**
 * 日志里的用户消息 → 喂给 pi 的内容。
 *
 * 没有图片时返回**字符串**，跟以前一模一样——绝大多数消息走的是这条路，没必要为了
 * 统一形状让每条消息都变成数组。
 *
 * 有图片时现读现转 base64：日志里存的是路径（见 session/types.ts 的 image 块）。
 * 读不到就退化成一句说明，不让整轮对话因为一张图没了而失败。
 *
 * `isLive` 决定这一张要不要真的带字节（见 MAX_LIVE_IMAGES）。不给就全带——steer
 * 那条路只有当下这一条消息，没有「太靠前」可言。
 */
export async function userContentFor(
  m: Message,
  ctx?: Context,
  isLive?: (index: number) => boolean,
  /** 引用要查的那份日志（全量，不是切过边界的）。不给就只渲染摘录。 */
  events?: readonly SessionEvent[],
): Promise<any> {
  const refText = await refResolver(m, ctx, events)
  const picked = m.content
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.type === 'image') as { c: { type: 'image'; path: string; mime: string }; i: number }[]
  if (!picked.length) return textFrom(m, refText)
  const out: any[] = []
  for (const { c, i } of picked) {
    const part = isLive && !isLive(i) ? stale(c) : await loadImage(c, ctx)
    out.push(part)
    /**
     * 真带上了字节的那几张，**跟一行它在工作区的路径**。模型看得见图，却不知道它叫什么——
     * 要拿它去改（generate_image 的 images）、或者交给别的工具读，都得有个名字。没带上字节
     * 的那两种（太靠前、读不出来）说明里本来就写着路径。
     */
    if (part.type === 'image') out.push({ type: 'text', text: `[附图 ${c.path}]` })
  }
  const text = textFrom(m, refText)
  if (text) out.push({ type: 'text', text })
  return out
}

/**
 * 给用户消息盖上时间。
 *
 * **必须写进正文**：pi 的 `timestamp` 字段停在 pi 那一层，`llm/gateway.ts` 的
 * toOpenAI / toAnthropic 往请求体里只放 role 和 content，时间戳一个字都不会到
 * 模型手上。所以「只把 timestamp 改对」是不够的——那修好的是我们自己的日志，
 * 不是模型的认知。
 *
 * 只盖用户消息：助手消息的时间模型能从相邻的用户消息推出来，每条都盖是白花 token。
 */
export function stampUser(text: string, at: number): string {
  return `[${humanTime(at)}]\n${text}`
}

/**
 * 给用户消息的内容盖时间，**带图的那种也要盖**。
 *
 * userContentFor 没图时返回字符串、有图时返回内容块数组（图在前、正文在后）。
 * 只处理字符串的话，凡是带图的消息就没有时间——而带图那几条往往正是之后会被问起的
 * 「上周发你的那张图」。数组形式下时间单独作为第一个文本块，不去改正文那一块，
 * 免得把它跟图的先后关系弄乱。
 */
export function stampContent(content: unknown, at: number): any {
  if (typeof content === 'string') return stampUser(content, at)
  if (!Array.isArray(content)) return stampUser(String(content ?? ''), at)
  return [{ type: 'text', text: `[${humanTime(at)}]` }, ...content]
}
