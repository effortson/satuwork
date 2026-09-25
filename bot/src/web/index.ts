import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '../session/types.ts'
import { historySlice, publicSessionEvents } from '../session/replay.ts'
import { createHash, randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { WorkspaceError } from '../workspace/index.ts'
import { docKindOf, extractDocument } from '../workspace/extract.ts'
import { CommandError, QUIET_MESSAGE, type ImageRef, type Mention, type MessageSource } from '../agent/index.ts'
import { expiredMessage, returnMessage, type Disposition, type HandoffActor } from '../policy/handoff.ts'
import { clearSettledTodos, readTodos } from '../tools/todo.ts'
import {
  channelCommand, channelMentionHelp, channelModelCommand, channelModelHelp, parseChannelMentions, pickModelArg, withChannelTodos,
  type ChannelMentionCandidate,
} from './channel.ts'

/**
 * Satuwork 的 HTTP API。无头运行时：不发 SPA，未知路径 JSON 404。
 *
 * `inject` 里的服务在 apply 运行时保证就绪；它们之后消失也会连带卸载本插件，
 * 所以下面不需要任何「服务还在吗」的防御判断。
 */
export const name = 'satu-web'
export const inject = ['server', 'sessions', 'agents', 'llm', 'storage', 'roster', 'workspace', 'policy', 'handoffs', 'catalog']

export interface Config {
}

/**
 * 渠道这一轮目前已经写到哪儿。
 *
 * 一步模型调用会先落若干 assistant/chunk，收口时再落一条完整的 assistant/message；
 * 两份是同一句话，不能直接全拼起来。这里按 step 归并：有完整消息就用完整消息，否则用
 * 尚未收口的 delta。这样 Telegram 草稿既能跟着当前 token 长，也不会在每一步结束时把
 * 同一句话重复一遍。工具调用只把名称和状态放进临时草稿，不带参数/结果；正式回复发出
 * 后 Telegram 会自动清掉草稿，因此工具过程不会永久留在聊天记录里。
 */
export function channelDraft(events: SessionEvent[], eventId: string): string {
  const start = events.findIndex((event) => {
    if (event.type !== 'user/message') return false
    const source = (event.data as { source?: MessageSource }).source
    return source?.kind === 'plugin' && source.plugin === 'channel' && source.form === eventId
  })
  if (start < 0) return ''
  const turnStart = events.slice(start + 1).find((event) => event.type === 'turn/start')
  const turn = Number((turnStart?.data as { turn?: unknown } | undefined)?.turn)
  if (!Number.isFinite(turn)) return ''

  const steps = new Map<number, { chunks: string; settled?: string }>()
  const tools = new Map<string, { name: string; status: 'running' | 'done' | 'failed' }>()
  for (const event of events.slice(start + 1)) {
    const data = event.data as {
      turn?: unknown
      step?: unknown
      callId?: unknown
      name?: unknown
      failed?: unknown
      chunk?: { type?: string; text?: unknown }
      message?: { content?: unknown }
    }
    if (Number(data.turn) !== turn) continue
    const step = Number(data.step)
    if (!Number.isFinite(step)) continue
    const row = steps.get(step) || { chunks: '' }
    if (event.type === 'assistant/chunk' && data.chunk?.type === 'text-delta' && typeof data.chunk.text === 'string') {
      row.chunks += data.chunk.text
    } else if (event.type === 'assistant/message') {
      const content = data.message?.content
      row.settled = Array.isArray(content)
        ? content
          .filter((block): block is { type: 'text'; text: string } =>
            block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('')
        : ''
    } else if (event.type === 'tool/call') {
      const callId = String(data.callId ?? '').trim()
      const name = Array.from(String(data.name ?? '').replace(/\s+/g, ' ').trim()).slice(0, 80).join('')
      if (callId && name) tools.set(callId, { name, status: 'running' })
    } else if (event.type === 'tool/result') {
      const callId = String(data.callId ?? '').trim()
      const tool = tools.get(callId)
      if (tool) tool.status = data.failed ? 'failed' : 'done'
    }
    steps.set(step, row)
  }
  const text = [...steps.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, row]) => row.settled === undefined ? row.chunks : row.settled)
    .filter((text) => text.trim())
    .join('\n\n')
    .trim()
  const allTools = [...tools.values()]
  const shownTools = allTools.slice(-8)
  const activity = shownTools.length
    ? [
      '🔧 工具调用',
      ...(allTools.length > shownTools.length ? [`… 还有 ${allTools.length - shownTools.length} 项`] : []),
      ...shownTools.map((tool) => {
        const state = tool.status === 'running' ? '调用中' : tool.status === 'failed' ? '失败' : '完成'
        const icon = tool.status === 'running' ? '⏳' : tool.status === 'failed' ? '✗' : '✓'
        return `${icon} ${tool.name} · ${state}`
      }),
    ].join('\n')
    : ''
  return [text, activity].filter(Boolean).join('\n\n')
}

export interface ChannelFile {
  path: string
  name: string
}

/** Telegram 要画的转人工卡，只带交接所需的公开字段。 */
export interface ChannelHandoff {
  id: string
  state: 'open' | 'claimed'
  reason: string
  ask: string
  summary?: string
  blocking: boolean
  repeats: number
  createdAt: number
  updatedAt: number
}

/**
 * 这一条渠道消息对应的工具产出。
 *
 * Web 端直接从事件流里的 `tool/result.files` 画文件药丸；Telegram 没有那条事件流，
 * 所以在轮次收口时把同一份旁路元数据带回 Gateway。只认明确的 files，不从模型正文
 * 猜路径——正文措辞会变，也可能提到一个根本没写出来的文件。
 */
export function channelFiles(events: SessionEvent[], eventId: string): ChannelFile[] {
  const start = events.findIndex((event) => {
    if (event.type !== 'user/message') return false
    const source = (event.data as { source?: MessageSource }).source
    return source?.kind === 'plugin' && source.plugin === 'channel' && source.form === eventId
  })
  if (start < 0) return []
  const turnStart = events.slice(start + 1).find((event) => event.type === 'turn/start')
  const turn = Number((turnStart?.data as { turn?: unknown } | undefined)?.turn)
  if (!Number.isFinite(turn)) return []

  const out = new Map<string, ChannelFile>()
  for (const event of events.slice(start + 1)) {
    if (event.type !== 'tool/result') continue
    const data = event.data as { turn?: unknown; files?: unknown }
    if (Number(data.turn) !== turn || !Array.isArray(data.files)) continue
    for (const raw of data.files) {
      if (!raw || typeof raw !== 'object') continue
      const path = String((raw as { path?: unknown }).path ?? '').trim()
      const name = String((raw as { name?: unknown }).name ?? '').trim()
      if (!path || !name || path.length > 2048 || name.length > 512) continue
      out.set(path, { path, name })
    }
  }
  return [...out.values()]
}

/**
 * 这一轮新开的转人工单。
 *
 * 不能直接回 `ctx.handoffs.of(sessionId)`：会话上几天前尚未闭合的旧单也在里面，每发一
 * 条 Telegram 消息就会把旧卡再发一次。`human/handoff` 与开单工具调用落在同一轮的
 * turn/start 和 turn/end 之间，所以只取这一段，并按 id 取最后状态。
 */
export function channelHandoffs(events: SessionEvent[], eventId: string): ChannelHandoff[] {
  const messageIndex = events.findIndex((event) => {
    if (event.type !== 'user/message') return false
    const source = (event.data as { source?: MessageSource }).source
    return source?.kind === 'plugin' && source.plugin === 'channel' && source.form === eventId
  })
  if (messageIndex < 0) return []
  const startOffset = events.slice(messageIndex + 1).findIndex((event) => event.type === 'turn/start')
  if (startOffset < 0) return []
  const start = messageIndex + 1 + startOffset
  const turn = Number((events[start].data as { turn?: unknown }).turn)
  if (!Number.isFinite(turn)) return []
  const endOffset = events.slice(start + 1).findIndex((event) =>
    event.type === 'turn/end' && Number((event.data as { turn?: unknown }).turn) === turn)
  if (endOffset < 0) return []
  const end = start + 1 + endOffset
  const latest = new Map<string, ChannelHandoff | null>()
  for (const event of events.slice(start + 1, end + 1)) {
    if (event.type !== 'human/handoff') continue
    const data = event.data
    const id = String(data.id ?? '').trim()
    if (!id) continue
    if (data.state !== 'open' && data.state !== 'claimed') {
      latest.set(id, null)
      continue
    }
    latest.set(id, {
      id,
      state: data.state,
      reason: String(data.reason ?? '').trim(),
      ask: String(data.ask ?? '').trim(),
      ...(data.summary ? { summary: String(data.summary).trim() } : {}),
      blocking: data.blocking !== false,
      repeats: Math.max(0, Number(data.repeats) || 0),
      createdAt: Number(data.at) || Number(event.time) || Date.now(),
      updatedAt: Number(data.at) || Number(event.time) || Date.now(),
    })
  }
  return [...latest.values()].filter((row): row is ChannelHandoff => Boolean(row))
}

export function apply(ctx: Context, _config: Config = {}) {

  interface ChannelSessionRow { sessionId: string; botId: string; bindingId: string; conversationId: string }
  interface ChannelResultRow {
    sessionId: string
    reply: string
    files?: ChannelFile[]
    handoffs?: ChannelHandoff[]
  }
  const channelSessions = ctx.storage.collection<ChannelSessionRow>('channel-sessions')
  const channelResults = ctx.storage.collection<ChannelResultRow>('channel-results')
  interface ChannelInflightRow {
    sessionId: string
    eventId: string
    collecting: boolean
    events: SessionEvent[]
    run: Promise<ChannelResultRow>
  }
  const channelInflight = new Map<string, ChannelInflightRow>()

  // 每条渠道请求只留自己这一轮的事件。202 状态查询因此不必每 500ms 复制并扫描整条长会话。
  ctx.on('session/event', (sessionId: string, event: SessionEvent) => {
    for (const active of channelInflight.values()) {
      if (active.sessionId !== sessionId) continue
      if (!active.collecting) {
        if (event.type !== 'user/message') continue
        const source = (event.data as { source?: MessageSource }).source
        if (source?.kind !== 'plugin' || source.plugin !== 'channel' || source.form !== active.eventId) continue
        active.collecting = true
      }
      active.events.push(event)
    }
  })

  const channelKey = (bindingId: string, conversationId: string) => `${bindingId}\u0000${conversationId}`

  /** callback_data 只有 64 bytes；把不定长 callId 收成稳定的、不可猜原文的短键。 */
  const channelApprovalKey = (callId: string) => createHash('sha256')
    .update(`satuwork-channel-approval:${callId}`)
    .digest('base64url')
    .slice(0, 22)

  const channelMentionCandidates = (): ChannelMentionCandidate[] => ctx.catalog.servers
    // 与 Web 的 /mentions 一致：只列当前账号的连接器，不把公司原生 MCP 暴露成 @ 候选。
    .filter((server) => server.enabled && server.connected && server.connector)
    .map((server) => ({ id: server.id, label: server.name }))

  /**
   * 渠道回复的去重表有上限：每条渠道消息都写一行、从来不删的话，这张表跟着聊天量只增
   * 不减。只留最近 CHANNEL_RESULTS_MAX 条（按写入时间淘汰）——它的用处只是挡住渠道
   * 短时间内的重投，几百条早就够了。
   */
  const CHANNEL_RESULTS_MAX = 500
  const saveChannelResult = (key: string, result: ChannelResultRow): ChannelResultRow => {
    channelResults.put(key, result)
    // list() 按 updatedAt 倒序，尾巴上就是最老的。
    for (const row of channelResults.list().slice(CHANNEL_RESULTS_MAX)) channelResults.delete(row.id)
    return result
  }

  function channelReply(events: SessionEvent[], eventId: string): string | null {
    const start = events.findIndex((e) => {
      if (e.type !== 'user/message') return false
      const source = (e.data as { source?: MessageSource }).source
      return source?.kind === 'plugin' && source.plugin === 'channel' && source.form === eventId
    })
    if (start < 0) return null
    const turnStart = events.slice(start + 1).find((e) => e.type === 'turn/start')
    const turn = Number((turnStart?.data as { turn?: unknown } | undefined)?.turn)
    if (!Number.isFinite(turn)) return null
    const ended = events.some((e) => e.type === 'turn/end' && Number((e.data as { turn?: unknown }).turn) === turn)
    if (!ended) return null
    return events
      .filter((e) => e.type === 'assistant/message' && Number((e.data as { turn?: unknown }).turn) === turn)
      .flatMap((e) => {
        const content = (e.data as { message?: { content?: unknown } }).message?.content
        return Array.isArray(content)
          ? content.filter((b): b is { type: 'text'; text: string } => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text)
          : []
      })
      .join('\n')
      .trim()
  }

  async function runChannelMessage(input: {
    bindingId: string; botId: string; eventId: string; conversationId: string; title: string; text: string
  }, onSession?: (sessionId: string) => void): Promise<ChannelResultRow> {
    const resultKey = channelKey(input.bindingId, input.eventId)
    const saved = channelResults.get(resultKey)
    if (saved) return saved
    const mapKey = channelKey(input.bindingId, input.conversationId)
    let mapped = channelSessions.get(mapKey)
    const bot = ctx.roster.get(input.botId)
    if (!bot) throw new Error(`没有这个助理：${input.botId}`)
    /**
     * Telegram 和 Web 是同一个用户的两个入口，不是两颗 Bot。两边都写这颗 Bot
     * 唯一的主会话，这样 Web 立即看到 Telegram 消息，Telegram 下一轮也能带上
     * Web 里的上下文。旧版曾为渠道另建 session；下一条渠道消息到来时将映射
     * 改指主会话，旧文件留作历史，不会丢或重放进模型。
     */
    const primary = await ctx.roster.ensureSession(bot.id)
    if (!mapped || mapped.sessionId !== primary.sessionId) {
      mapped = {
        sessionId: primary.sessionId,
        botId: bot.id,
        bindingId: input.bindingId,
        conversationId: input.conversationId,
      }
      channelSessions.put(mapKey, mapped)
    }
    onSession?.(mapped.sessionId)
    /**
     * `/model` 和 Web 选择器写的是同一条会话上的同一个事件：Telegram 里换了，Web 那边
     * 选择器当场跟着变，反过来也一样。不开新的一轮、不进 user/message，模型看不见它。
     */
    const modelCmd = channelModelCommand(input.text)
    if (modelCmd) {
      let reply = ''
      try {
        const history = await ctx.sessions.events(mapped.sessionId)
        const state = ctx.agents.sessionModelState(history)
        if (!modelCmd.arg) reply = channelModelHelp(state)
        else {
          const want = pickModelArg(modelCmd.arg, state.options)
          if (!want) reply = `没有「${modelCmd.arg}」这个日常模型。\n\n${channelModelHelp(state)}`
          else {
            const r = await ctx.agents.setSessionModel(mapped.sessionId, want.key)
            reply = !r.changed
              ? `已经在用 ${want.label}。`
              : `已切换到 ${want.label}${r.nextTurn ? '，这一轮跑完后生效' : ''}。`
          }
        }
      } catch (e) {
        // 同下面那几条命令：拒绝是给人看的结果，不能抛给 Dispatcher 让它无限重试。
        reply = e instanceof CommandError ? e.message : `无法切换模型：${(e as Error).message}`
      }
      return saveChannelResult(resultKey, { sessionId: mapped.sessionId, reply })
    }
    const command = channelCommand(input.text)
    if (command) {
      let reply = ''
      if (command === 'tasks') {
        reply = withChannelTodos('当前任务列表：', readTodos(ctx, mapped.sessionId))
        if (!readTodos(ctx, mapped.sessionId).length) reply = '当前没有任务。'
      } else if (command === 'mentions') {
        if (!channelMentionCandidates().length) await ctx.catalog.pull().catch(() => false)
        reply = channelMentionHelp(channelMentionCandidates())
      } else {
        const open = ctx.handoffs.of(mapped.sessionId).filter((h) => h.state === 'open' || h.state === 'claimed')
        if (open.length) reply = `还有 ${open.length} 张转人工的单子没结，先处理掉、或等它交回来再开新对话。`
        else {
          try {
            const reset = await ctx.agents.resetContext(mapped.sessionId)
            await clearSettledTodos(ctx, mapped.sessionId, `channel:${input.eventId}`)
            reply = `已开始新对话；上面的记录仍然保留，但接下来的上下文不再带入之前的 ${reset.droppedMessages} 条消息。`
          } catch (e) {
            // 命令拒绝是给用户看的业务结果，不能抛给 Dispatcher 让它无限重试。
            reply = e instanceof CommandError ? e.message : `无法开始新对话：${(e as Error).message}`
          }
        }
        reply = withChannelTodos(reply, readTodos(ctx, mapped.sessionId))
      }
      return saveChannelResult(resultKey, { sessionId: mapped.sessionId, reply })
    }
    let parsed = parseChannelMentions(input.text, channelMentionCandidates())
    if (parsed.unknown) {
      // 目录最多一分钟刷新一次；用户刚连好连接器就发 @ 时，主动追一次最新目录。
      await ctx.catalog.pull().catch(() => false)
      parsed = parseChannelMentions(input.text, channelMentionCandidates())
    }
    if (parsed.unknown) {
      const help = channelMentionHelp(channelMentionCandidates())
      return saveChannelResult(resultKey, {
        sessionId: mapped.sessionId,
        reply: `没有这个 @ 连接：${parsed.unknown}\n\n${help}`,
      })
    }
    // 上一代可能已经跑完，只来不及把结果写进 SQLite。日志里的 eventId 是幂等事实源。
    const recoveredHistory = await ctx.sessions.events(mapped.sessionId)
    const recovered = channelReply(recoveredHistory, input.eventId)
    if (recovered !== null) {
      const result: ChannelResultRow = {
        sessionId: mapped.sessionId,
        reply: recovered,
        files: channelFiles(recoveredHistory, input.eventId),
        handoffs: channelHandoffs(recoveredHistory, input.eventId),
      }
      result.reply = withChannelTodos(result.reply, readTodos(ctx, mapped.sessionId))
      return saveChannelResult(resultKey, result)
    }
    if (ctx.agents.isRunning(mapped.sessionId)) throw new Error('这条渠道会话仍在处理上一条消息')
    await clearSettledTodos(ctx, mapped.sessionId, `channel:${input.eventId}`)
    let failure: Error | null = null
    try {
      await ctx.agents.send(mapped.sessionId, parsed.text, [], parsed.mentions, {
        kind: 'plugin', plugin: 'channel', form: input.eventId,
        channel: 'telegram', bindingId: input.bindingId, conversationId: input.conversationId,
      })
    } catch (e) {
      // send 的失败路径通常也会写一条可见的 assistant/message；先从日志回收它。
      failure = e as Error
    }
    const history = await ctx.sessions.events(mapped.sessionId)
    const reply = channelReply(history, input.eventId)
    if (reply === null) throw failure || new Error('渠道消息没有完成')
    return saveChannelResult(resultKey, {
      sessionId: mapped.sessionId,
      reply: withChannelTodos(reply, readTodos(ctx, mapped.sessionId)),
      files: channelFiles(history, input.eventId),
      handoffs: channelHandoffs(history, input.eventId),
    })
  }

  /** 运行时地址。真正听在哪个端口由 server 服务说了算。 */
  console.log(`satuwork: runtime ${ctx.server.baseUrl}`)

  /**
   * 谁在操作。**由 Gateway 填**：席位只认得自己那一个账号，而接手的人可能是公司管理员。
   * 认不出就不写——日志上宁可少一个名字，也不要写一个编出来的。
   */
  function actorOf(body: unknown): HandoffActor | undefined {
    const a = (body as { actor?: { accountId?: unknown; name?: unknown } } | null)?.actor
    if (!a || typeof a !== 'object') return undefined
    const accountId = String(a.accountId ?? '').trim()
    const name = String(a.name ?? '').trim()
    if (!accountId && !name) return undefined
    return { accountId, name: name || accountId }
  }

  /**
   * 把交还的那段话送进会话。
   *
   * 正在跑就插话，没在跑就开新一轮——和界面发消息那条路是同一套三岔（少了 `@` 那一岔，
   * 交还不点名工具）。插话那一岔是要紧的：人交还的同一刻这颗 Bot 完全可能正被别人问着话，
   * 直接 send 会撞上「该会话正在运行中」，那句交还就丢了。
   */
  async function deliver(sessionId: string, hid: string, text: string): Promise<void> {
    // 插话也落 user/message 了（见 agents.steer），source 要如实写成交还，
    // 否则日志里那句话看起来像用户自己说的。
    if (ctx.agents.isRunning(sessionId) && (await ctx.agents.steer(sessionId, text, [], { kind: 'plugin', plugin: 'handoff' }))) {
      // 插进了正在跑的那一轮：等它收口，单子就完了。
      ctx.handoffs.waitFor(hid, true)
      return
    }
    /**
     * 另起一轮。**先说清楚要等一次 turn/start 再收口**——这一句必须在 send 之前，
     * 否则上一轮那条紧随其后的 `turn/end` 会把单子提前收掉（见 handoff.ts 的 awaitStart）。
     */
    ctx.handoffs.waitFor(hid, false)
    void ctx.agents
      .send(sessionId, text, [], [], { kind: 'plugin', plugin: 'handoff' })
      .catch((e: Error) => ctx.logger?.warn?.(`handoff: 交还没能进会话 ${e.message}`))
  }

  /**
   * 探活。**不要票**（见 guard/index.ts 的 PUBLIC），因为它是管家判断「这个席位起来
   * 没有」的唯一依据，而管家手上只有机器票。
   *
   * 顺带报「在不在忙」：管家换 bot 版本就是 `systemctl restart`，跑到一半的那一轮会
   * 当场没命——它必须先知道这个席位闲不闲（见 manager/src/seats.ts 的排空）。只给两
   * 个计数，不给会话 id 和正文：这条路没有票，能少说一句是一句。
   *
   * **`busy` 只看 running**（理由见 agents.busy）：排着的那几条没有 turn 在跑时根本
   * 不会动，拦下重启保护不了它们，却会被一条孤儿排队行永久钉住。`queued` 只作诊断。
   */
  /**
   * 换版静默期里，凡是「要叫醒 Bot」的路都先问一句它。
   *
   * **判据是「会不会因此开新的一轮」**：这一轮还在跑的话，交还/超时那段话是插进去的
   * （deliver 里的 steer），静默不拦；没在跑就得开新一轮，而这几秒之后进程就被换掉了。
   *
   * 拦要拦在**动状态之前**：`handoffs.finish()` 一旦落下去，那张单就成了「已交还」，
   * 而 deliver 这时才发现开不了新一轮——单子从此卡在「已交还、Bot 正在接着做」上，
   * 可根本没人在做。回绝掉，单子留着，人几秒后再点一次就是。
   */
  const quietBlocks = (sessionId: string) => ctx.agents.quiesced() && !ctx.agents.isRunning(sessionId)
  const refuseQuiet = (res: { status: number; json: (v: unknown) => void }) => {
    res.status = 409
    res.json({ error: QUIET_MESSAGE, quiesced: true })
  }

  ctx.server.get('/api/health', async (req, res) => {
    const load = ctx.agents.busy()
    // `quiesced` 让管家核对「那道闸真的落下来了」——它自己刚发的指令，不该只靠 200
    // 就当成生效了（老版本席位没有这条路，200 也可能是别的东西答的）。
    res.json({
      ok: true,
      busy: load.running > 0,
      quiesced: ctx.agents.quiesced(),
      // 和 SSE 第一帧同一份身份：排错时「它是不是换过进程」在这条路上也答得出来。
      instanceId: INSTANCE_ID,
      startedAt: STARTED_AT,
      ...load,
    })
  })

  /**
   * 换版前的静默：**这几秒不开新的一轮**，好让管家等手上这一轮干净地跑完再重启。
   *
   * 只有管家会调（它手上有席位票，见 deploy-seat.sh 写进 bot.env 的 GATEWAY_TOKEN）。
   * 语义见 agent/index.ts 上那段：只挡新一轮，不挡 steering；只在内存里，带 TTL，
   * 所以管家中途挂了也不会把这台席位冻成一块砖。
   *
   * `ttlMs: 0` = 放开。
   */
  ctx.server.post('/api/quiesce', async (req, res) => {
    const body = (await req.json().catch(() => ({}))) as { ttlMs?: unknown }
    const until = ctx.agents.quiesce(Number(body?.ttlMs ?? 0))
    const load = ctx.agents.busy()
    res.json({ ok: true, quiesced: ctx.agents.quiesced(), until, ...load })
  })

  /**
   * 模型目录。来自 Gateway /v1/models 的缓存。本机没有密钥。
   */
  ctx.server.get('/api/models', async (req, res) => {
    const catalog = await ctx.llm.refresh()
    res.json({
      catalog,
      configured: [],
      available: await ctx.llm.available(),
      gateway: ctx.llm.url || null,
    })
  })

  /** 生效设置。只读：改模型 / 提示词在 Gateway。 */
  ctx.server.get('/api/settings', async (req, res) => {
    res.json({
      provider: ctx.agents.provider,
      model: ctx.agents.model,
      system: ctx.agents.system,
    })
  })

  ctx.server.put('/api/settings', async (req, res) => {
    res.status = 410
    res.json({ error: '模型配置在 Gateway' })
  })

  ctx.server.put('/api/credentials/:provider', async (req, res) => {
    res.status = 410
    res.json({ error: 'credentials live on Gateway' })
  })

  ctx.server.get('/api/sessions', async (req, res) => {
    res.json(await ctx.sessions.list())
  })

  ctx.server.post('/api/sessions', async (req, res) => {
    const body = (await req.json().catch(() => ({}))) as { title?: string; botId?: string; agentId?: string }
    const botId = body.botId || body.agentId
    if (!botId) {
      res.status = 400
      res.json({ error: 'botId 不能为空' })
      return
    }
    const bot = ctx.roster.get(botId)
    if (!bot) {
      res.status = 404
      res.json({ error: `没有这个助理：${botId}` })
      return
    }
    res.json({
      id: await ctx.sessions.create({
        title: body.title ?? bot.name,
        botId: bot.id,
        origin: bot.origin,
        remoteId: bot.remoteId,
      }),
    })
  })

  /**
   * Gateway 的渠道 Dispatcher 调这条。Telegram 长轮询的 update 先落库再进 Dispatcher，
   * 所以这里可以等模型整轮完成后再返回。
   */
  ctx.server.post('/api/channels/:bindingId/messages', async (req, res) => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const input = {
      bindingId: req.params.bindingId,
      botId: String(body.botId ?? '').trim(),
      eventId: String(body.eventId ?? '').trim(),
      conversationId: String(body.conversationId ?? '').trim(),
      title: String(body.title ?? '').trim().slice(0, 160),
      text: String(body.text ?? '').trim(),
    }
    if (!input.botId || !input.eventId || !input.conversationId || !input.text) {
      res.status = 400
      res.json({ error: '渠道消息缺字段' })
      return
    }
    const key = channelKey(input.bindingId, input.eventId)
    let active = channelInflight.get(key)
    if (!active) {
      active = {
        sessionId: '', eventId: input.eventId, collecting: false, events: [],
        run: Promise.resolve({ sessionId: '', reply: '' }),
      }
      active.run = runChannelMessage(input, (sessionId) => { active!.sessionId = sessionId })
        .finally(() => channelInflight.delete(key))
      channelInflight.set(key, active)
    }
    try {
      const snapshot = await Promise.race([
        active.run.then((result) => ({ done: true as const, result }), (error) => ({ done: true as const, error })),
        new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), 250)),
      ])
      if (snapshot.done) {
        if ('error' in snapshot) throw snapshot.error
        res.json(snapshot.result)
        return
      }
      const pending = active.sessionId ? ctx.policy.approvals.list(active.sessionId)[0] : undefined
      res.status = 202
      res.json({
        status: pending ? 'approval' : 'running',
        sessionId: active.sessionId || undefined,
        draft: channelDraft(active.events, input.eventId),
        ...(pending ? { approval: { ...pending, key: channelApprovalKey(pending.callId) } } : {}),
      })
    } catch (e) {
      res.status = 503
      res.json({ error: (e as Error).message })
    }
  })

  /**
   * Telegram 内联按钮的决定。Gateway 只带短键回来；真正的 callId 和等待中的 Promise
   * 都留在席位里，决定仍由现有 ApprovalGate 在工具执行点强制。
   */
  ctx.server.post('/api/channels/:bindingId/approvals/:approvalKey', async (req, res) => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const botId = String(body.botId ?? '').trim()
    const decision = body.decision === 'approve' ? 'approve' : body.decision === 'deny' ? 'deny' : ''
    const scope = body.scope === 'turn' ? 'turn' : 'once'
    if (!botId || !decision) {
      res.status = 400
      res.json({ error: '渠道审批缺少 botId 或合法 decision' })
      return
    }
    const bot = ctx.roster.get(botId)
    if (!bot) {
      res.status = 404
      res.json({ error: `没有这个助理：${botId}` })
      return
    }
    const primary = await ctx.roster.ensureSession(bot.id)
    const pending = ctx.policy.approvals.list(primary.sessionId)
      .find((item) => channelApprovalKey(item.callId) === req.params.approvalKey)
    if (!pending || ctx.policy.approvals.decide(primary.sessionId, pending.callId, decision, scope) !== 'ok') {
      res.status = 409
      res.json({ error: '这条确认已经结束了' })
      return
    }
    res.json({ ok: true, decision, scope, sessionId: primary.sessionId })
  })

  ctx.server.get('/api/sessions/:id/events', async (req, res) =>
    sse(ctx, req.params.id, Number(req.query.get('after') ?? 0), res, Number(req.query.get('tail') ?? 0)),
  )

  /**
   * 往前翻历史。一页几轮，游标是上一页最靠前那条的 seq。
   *
   * 走普通 HTTP 而不是塞进那条流：翻页是**人点出来的一次性动作**，和「跟着看新消息」
   * 不是一回事。混在一条流里，既要发明一套请求帧，又会让重连的游标语义变浑。
   */
  ctx.server.get('/api/sessions/:id/history', async (req, res) => {
    const before = Number(req.query.get('before') ?? 0)
    const turns = Math.min(50, Math.max(1, Number(req.query.get('turns') ?? 20)))
    try {
      const all = await ctx.sessions.events(req.params.id)
      res.json(historySlice(all, { turns, before: before > 0 ? before : undefined }))
    } catch (e) {
      res.status = 404
      res.json({ error: (e as Error).message })
    }
  })

  /**
   * 一次委派的子会话全文（见 docs/delegation.md）。
   *
   * **为什么不直接走上面那条 `/api/sessions/:child/history`：** 子会话不进控制面的会话
   * 索引（它不是「这个人的一条对话」，是某条对话里一次工具调用的内部过程），而 Gateway
   * 的授权正是查那张索引——按 id 直取会换回一个 503，而那个 503 长得像「席位掉线了」。
   *
   * 所以它经**主会话**的授权取：路径上的 `:id` 是主会话（Gateway 认得它），`:child` 是
   * 子会话，而这里要**核对父子关系**——不核对的话，这条路等于「拿任意一个 id 就能读这台
   * 席位上任意一条会话」。
   */
  ctx.server.get('/api/sessions/:id/tasks/:child/history', async (req, res) => {
    const turns = Math.min(50, Math.max(1, Number(req.query.get('turns') ?? 50)))
    const before = Number(req.query.get('before') ?? 0)
    try {
      const events = await ctx.sessions.events(req.params.child)
      const root = events.find((e) => e.type === 'session')?.data as
        | { kind?: string; parent?: { sessionId?: string } }
        | undefined
      if (root?.kind !== 'task' || root.parent?.sessionId !== req.params.id) {
        res.status = 404
        res.json({ error: '这条子会话不属于该会话' })
        return
      }
      res.json(historySlice(events, { turns, before: before > 0 ? before : undefined }))
    } catch (e) {
      res.status = 404
      res.json({ error: (e as Error).message })
    }
  })

  /**
   * 发消息。三岔，不是两岔：
   *
   * | 情况 | 走法 |
   * |---|---|
   * | 没在跑 | 新一轮 |
   * | 在跑、消息**不带** `@` | steering——工具跑到一半也能插话 |
   * | 在跑、消息**带** `@` | 入队，这一轮跑完自动接上 |
   *
   * 第三岔是必须的：steering 是插进正在进行的那一轮，而那一轮的工具表早就定了，
   * 而 `@` 的全部意义就是改工具表。插进去的话点名会静静地不起作用。
   *
   * **前端需要知道走了哪一岔**（原来那句「不需要知道」不成立了）：排队的那条要画成
   * 输入框顶上的一行 dock，不是消息气泡。
   */
  ctx.server.post('/api/sessions/:id/messages', async (req, res) => {
    const body = (await req.json().catch(() => ({}))) as {
      text?: string
      images?: unknown
      mentions?: unknown
      /**
       * 这一轮钉到平台的哪个模型角色上（现在只有日常任务会给：见 docs/routines.md）。
       *
       * **收的是角色名，不是 provider + model。** 后者等于给这条路开一个「这一轮用
       * 哪个模型」的入口，而这条路浏览器也走得通——任何人都能借它绕开管理员放开的
       * 白名单。认不出来的值当没给（照 Bot 自己的模型跑），不回 400：这是一个纯优化
       * 的开关，为它把一条本该跑起来的定时任务顶回去不划算。
       */
      modelRole?: unknown
      /**
       * 日常任务（Gateway 的调度器发来的）带身份：这一条要被画成「日常任务」而不是
       * 人打的一句话。看板卡不走 /messages——它有自己的一条路，标识在席位那头打。
       */
      routine?: unknown
    }
    const modelRole = body.modelRole === 'utility' || body.modelRole === 'daily' ? body.modelRole : undefined
    const routine = body.routine && typeof body.routine === 'object' ? (body.routine as { id?: unknown; name?: unknown }) : null
    // 谁在说话。kind 认得出「不是人打的」——界面照 source.plugin 画角标（见 chat.js 的 fold）。
    const source = routine
      ? ({ kind: 'plugin', plugin: 'routine', form: String(routine.id ?? '') } as MessageSource)
      : ({ kind: 'user' } as MessageSource)
    let images: ImageRef[]
    try {
      images = await imageRefs(ctx, body.images)
    } catch (e) {
      res.status = 400
      res.json({ error: (e as Error).message })
      return
    }
    const mentions = mentionList(body.mentions)
    // 带图的消息可以没有正文——「这张图什么意思」本来就常常只有一张图。
    if (!body.text?.trim() && !images.length && !mentions.length) {
      res.status = 400
      res.json({ error: 'text 不能为空' })
      return
    }
    /**
     * 席位正在换版：**这一条当场回绝，而不是收下再被重启砍掉**。
     *
     * 收下的后果是最坏的那一种：界面上画着一条已经发出去的消息，几秒后进程没了，那一轮
     * 连 turn/end 都没写成——人只会以为「发出去了但它不理我」。回绝则明白得多，草稿也
     * 原样退回去（见 ui/chat.js 的 sendChat 那个 catch），过几秒重发就是。
     *
     * **在跑的那一轮不受影响**：steering 照旧插得进去（静默只挡新一轮）。
     *
     * 但**带 `@` 的那种要一起挡**：它走的是排队（这一轮跑完自动接上），而静默期里
     * drainQueue 停手、紧接着进程就被换掉了——收下它等于开一张不会兑现的空头支票，
     * 那条消息会一直躺在队列里，直到某天另一轮跑完才被想起来。
     */
    if (ctx.agents.quiesced() && mentions.length) {
      refuseQuiet(res)
      return
    }
    if (ctx.agents.isRunning(req.params.id)) {
      if (mentions.length) {
        try {
          const row = ctx.agents.enqueue(req.params.id, body.text ?? '', images, mentions)
          res.json({ queued: true, queueId: row.id })
        } catch (e) {
          // 队满。**明说**，不静默丢——用户以为发出去了才是最糟的。
          res.status = 429
          res.json({ error: (e as Error).message })
        }
        return
      }
      /**
       * **插话这一岔用不上 `modelRole`**：那一轮的模型早在开跑时就定了，换不了。
       *
       * 日常任务会走到这里（人正好在和这个 Bot 说话），于是那一次不是按 utility 跑的。
       * 不为它另开一轮：一条会话里两轮抢着说话，出来的东西谁也不认（见 routines.ts），
       * 而这个开关是省钱，不是正确性。
       */
      if (await ctx.agents.steer(req.params.id, body.text ?? '', images, source)) {
        res.json({ steered: true })
        return
      }
      // 刚好在这几毫秒里跑完了：落回下面开新一轮，别把这条丢掉。
    }
    /**
     * 开新一轮之前的最后一道闸——**位置就得在这儿**。
     *
     * 早先这一道放在最前面，按「没在跑就回绝」判。可上面那条 steering 会落空：这一轮
     * 正好在那几毫秒里跑完了，于是掉到这里来开新一轮——而这会儿是静默期，`send` 会抛，
     * 抛在一个 `void ... .catch()` 里，而 HTTP 那头**早已经回了 `accepted: true`**。
     * 用户看到「发出去了」，实际上一个字都没跑，日志里只有一行 warn。
     *
     * 挪到真正要开新一轮的这一刻判，那个缝就没了。
     */
    if (ctx.agents.quiesced()) {
      refuseQuiet(res)
      return
    }
    // 不等 turn 跑完就返回：结果通过 SSE 推，HTTP 只负责「收到了」。
    void ctx.agents.send(req.params.id, body.text ?? '', images, mentions, source, modelRole).catch((e: Error) => {
      console.error(`satuwork: agents.send 失败：${e.message}`)
      ctx.logger?.warn?.(`agents.send 失败：${e.message}`)
    })
    res.json({ accepted: true })
  })

  /** 排着的消息。刷新页面之后 dock 靠它恢复。 */
  ctx.server.get('/api/sessions/:id/queue', async (req, res) => {
    res.json({ queued: ctx.agents.queued(req.params.id) })
  })

  /**
   * 取消一条排队的消息。
   *
   * 已经出队开跑的返回 **409**，不是静默成功：用户点取消的同一刻这一轮正好结束、队首
   * 被取出开跑，是必然会撞上的竞态。回 200 的话他会以为取消成功了，然后眼看着它跑起来。
   */
  ctx.server.delete('/api/sessions/:id/queue/:queueId', async (req, res) => {
    const r = ctx.agents.cancelQueued(req.params.id, req.params.queueId)
    if (r === 'cancelled') {
      res.json({ cancelled: true })
      return
    }
    // 两种失败分开报：**「已经开跑」和「压根没这条」对用户是完全不同的两句话**。
    // 合成一句「已经开始执行」的话，两个标签页各点一次取消，后点的那个会以为自己
    // 拦不住一条其实早就被取消掉的消息。
    res.status = r === 'started' ? 409 : 404
    res.json({ error: r === 'started' ? '已经开始执行' : '没有这条排队消息' })
  })

  /**
   * 还等着人拍板的高风险调用。
   *
   * **刷新页面之后要能回到那张卡片。** 卡片本身是从会话事件里折出来的（`tool/approval`
   * 的 pending），但「它现在还等不等」只有这个进程知道：等待方是一个内存里的 Promise，
   * 进程重启、或者已经超时之后，日志上那条 pending 还在，点它却什么都不会发生。所以
   * 界面拿这条路核对一次——列表里没有的，那张卡片就该画成灰的。
   */
  ctx.server.get('/api/sessions/:id/approvals', async (req, res) => {
    res.json({
      pending: ctx.policy.approvals.list(req.params.id),
      granted: ctx.policy.approvals.grantedIn(req.params.id),
      blocked: ctx.policy.approvals.blockedIn(req.params.id),
    })
  })

  /**
   * 批准 / 拒绝一次调用。**这一下直接放行那次工具执行**，不是发一句话给模型再由它决定。
   *
   * 已经结束的那条回 **409**，不是静默成功：两个标签页各点一次、或者点的同时正好超时，
   * 是必然会撞上的竞态。回 200 的话人会以为自己批准了什么，而那次调用其实早就被按
   * 拒绝处理掉了。
   */
  ctx.server.post('/api/sessions/:id/approvals/:callId', async (req, res) => {
    const body = (await req.json().catch(() => ({}))) as {
      decision?: string
      scope?: string
      /**
       * 人在卡片上改过的那几格：`{ 'args.body': '改后的正文' }`。
       *
       * **收下不等于照单全收**：哪几格能改由席位这边的表单说了算（见 policy/forms.ts
       * 的 applyEdits），这里只负责把原样送到那儿。
       */
      edits?: Record<string, unknown>
    }
    const decision = body.decision === 'approve' ? 'approve' : body.decision === 'deny' ? 'deny' : ''
    if (!decision) {
      res.status = 400
      res.json({ error: 'decision 只能是 approve 或 deny' })
      return
    }
    // `session` 是老前端的叫法，收下来按 `turn` 处理——那颗按钮的语义从来就是「这一轮」，
    // 只是名字起错过一次。
    const scope = body.scope === 'turn' || body.scope === 'session' ? 'turn' : 'once'
    const edits = body.edits && typeof body.edits === 'object' && !Array.isArray(body.edits) ? body.edits : undefined
    const r = ctx.policy.approvals.decide(req.params.id, req.params.callId, decision, scope, edits)
    if (r === 'ok') {
      res.json({ ok: true, decision, scope })
      return
    }
    res.status = 409
    res.json({ error: '这条确认已经结束了' })
  })

  /**
   * 这条会话现在的待办清单（见 docs/todo-tool.md）。
   *
   * **和 `todo/list` 事件不是重复的两条路，是两个问题。** 事件解决「盯着看的时候它
   * 跟着动」；这一跳解决「刚打开这一页」——流上只垫最近一轮（session/replay.ts），
   * 而一张三天前列出来、还没做完的表恰恰不在里面，而那正是最该被看见的一张。
   *
   * 真相在 SQLite 里，不在日志里：清单是一份会被反复改写的状态。
   */
  ctx.server.get('/api/sessions/:id/todos', async (req, res) => {
    res.json({ todos: readTodos(ctx, req.params.id) })
  })

  /**
   * 这条会话上还没闭合的交接单（见 docs/handoff.md）。
   *
   * 和确认那条路的区别：**这里的真相在磁盘上，不在内存里**。确认要拿这条路核对
   * 「它现在还等不等」，因为等待方是个内存里的 Promise；交接单活过重启，所以刷新之后
   * 直接照着它画就行。
   *
   * `blocking` 那一格给 Gateway 的调度器看：有一张挡着路的单没闭合时，这颗 Bot 的
   * 日常任务这一次跳过——不拦的话，一件卡住的事会每小时重跑一遍、每小时开一张新单。
   */
  ctx.server.get('/api/sessions/:id/handoffs', async (req, res) => {
    const open = ctx.handoffs.of(req.params.id)
    res.json({ handoffs: open, blocking: open.some((h) => h.blocking && h.state !== 'returned') })
  })

  /**
   * 我来接手。
   *
   * 抢不到回 **409**，并且**说清楚被谁接走了**：两个人同时点是必然会撞上的竞态，
   * 回 200 的话后点的那个会以为这件事归他了，然后两个人各做一遍。
   */
  ctx.server.post('/api/sessions/:id/handoffs/:hid/claim', async (req, res) => {
    const actor = actorOf(await req.json().catch(() => ({})))
    // 接手必须有名字。没有的话待办页上「谁接的」是一片空白，而那一栏正是这颗按钮的全部意义。
    if (!actor) {
      res.status = 400
      res.json({ error: '缺少 actor：接手的人是谁必须写下来' })
      return
    }
    const r = await ctx.handoffs.claim(req.params.hid, actor)
    if (r.result === 'ok') {
      res.json({ ok: true, handoff: r.handoff })
      return
    }
    res.status = 409
    res.json({
      error: r.result === 'taken' ? `已经由 ${r.handoff?.claimedBy?.name || '别人'} 接手` : '这张交接单已经不在了',
      handoff: r.handoff ?? null,
    })
  })

  /**
   * 交还。
   *
   * **这一下会真的把话喂给模型**，不是改一个状态位。`closed` 那一档除外——人说这件事
   * 到此为止，就不该再叫醒 Bot 说一遍。
   *
   * 送进去的是一条带 `source: plugin/handoff` 的消息，正文是拼好的结构（谁、做了什么、
   * 结论、接下来做什么）。含糊成一句「已处理」的话，模型下一步多半是把人刚做完的事
   * 再做一遍。
   */
  ctx.server.post('/api/sessions/:id/handoffs/:hid/return', async (req, res) => {
    const body = (await req.json().catch(() => ({}))) as { disposition?: unknown; text?: unknown; actor?: unknown }
    const disposition: Disposition =
      body.disposition === 'instructions' ? 'instructions' : body.disposition === 'closed' ? 'closed' : 'done'
    const text = String(body.text ?? '').trim()
    if (!text && disposition !== 'closed') {
      // 空的交还等于把「我处理完了」四个字扔给模型——它接着要做什么全靠猜。
      res.status = 400
      res.json({ error: '写一句你做了什么、结论是什么，Bot 要靠它接着做' })
      return
    }
    // 静默期里开不了新的一轮（见 quietBlocks）。`closed` 不叫醒 Bot，不受影响。
    if (disposition !== 'closed' && quietBlocks(req.params.id)) {
      refuseQuiet(res)
      return
    }
    const actor = actorOf(body)
    const r = await ctx.handoffs.finish(req.params.hid, disposition, text, actor)
    if (r.result !== 'ok' || !r.handoff) {
      res.status = 409
      res.json({ error: '这张交接单已经不在了' })
      return
    }
    if (disposition !== 'closed') {
      await deliver(req.params.id, r.handoff.id, returnMessage(r.handoff, disposition, text, actor))
    }
    res.json({ ok: true, handoff: r.handoff, resumed: disposition !== 'closed' })
  })

  /** 撤销。人自己说这件事不用管了——不叫醒 Bot。 */
  ctx.server.post('/api/sessions/:id/handoffs/:hid/cancel', async (req, res) => {
    const actor = actorOf(await req.json().catch(() => ({})))
    const r = await ctx.handoffs.cancel(req.params.hid, actor)
    if (r.result === 'ok') {
      // 把最终那张单带回去：Gateway 那一行要跟着改，而它只认这一条响应（见 routes/handoffs.ts）。
      res.json({ ok: true, handoff: r.handoff })
      return
    }
    res.status = 409
    res.json({ error: '这张交接单已经不在了' })
  })

  /**
   * 超时没人接。**由 Gateway 调**，席位自己不看表——机器可能整夜关着，而那正是没人
   * 接手的一半原因。
   *
   * 它按一次交还处理：告诉模型没人接、别再等了。少了这半句，这张单就和转人工原来那条
   * 日志一样悬着。
   */
  ctx.server.post('/api/sessions/:id/handoffs/:hid/expire', async (req, res) => {
    const body = (await req.json().catch(() => ({}))) as { hours?: unknown }
    const hours = Math.max(1, Math.round(Number(body.hours) || 24))
    // 同交还：静默期里叫不醒 Bot，就别先把单子改成「已过期」。Gateway 那边的清扫是
    // 周期性的（见 handoff-sweep.ts），下一轮再来时席位早就换完了。
    if (quietBlocks(req.params.id)) {
      refuseQuiet(res)
      return
    }
    const r = await ctx.handoffs.expire(req.params.hid)
    if (r.result !== 'ok' || !r.handoff) {
      res.status = 409
      res.json({ error: '这张交接单已经不在了' })
      return
    }
    await deliver(req.params.id, r.handoff.id, expiredMessage(r.handoff, hours))
    res.json({ ok: true, handoff: r.handoff })
  })

  /** 中止当前这一轮。 */
  ctx.server.post('/api/sessions/:id/abort', async (req, res) => {
    res.json({ aborted: ctx.agents.abort(req.params.id) })
  })

  /* ── 人手改上下文边界 ──────────────────────────────────────────────────
   *
   * 界面上是输入框里的 `/compact` 和 `/new`（见 docs/chat-commands.md）。**它们不是
   * 消息**：不进 user/message、不占 token、不开新的一轮，模型看不见它们。所以走这两条
   * 单独的路，而不是塞进 /messages 让模型自己去理解——那样它可能不照做，而且事后从
   * 日志里分不清「人点了压缩」和「人打了 compact 这几个字」。
   *
   * 两条都可能被拒（正在跑、太短、排着队），拒的原因是 CommandError 上那句原话，
   * 原样透出去——界面照着它给提示，别翻成一句「操作失败」。
   */

  /** 现在就压一次。会跑一次模型写摘要，几秒。 */
  ctx.server.post('/api/sessions/:id/compact', async (req, res) => {
    try {
      const r = await ctx.agents.compactNow(req.params.id)
      // `compacted` 照抄返回值，**不写死 true**：写死的话，一个 compacted:false 的结果
      // 会带着一串 undefined 的数字变成「成功」，界面上就是一句「已压缩：0 → 0」而
      // 什么都没发生。compactNow 现在压不成一律抛，这里是第二道保险。
      res.json({
        compacted: r.compacted,
        throughSeq: r.throughSeq,
        tokensBefore: r.tokensBefore,
        tokensAfter: r.tokensAfter,
      })
    } catch (e) {
      res.status = e instanceof CommandError ? e.status : 500
      res.json({ error: (e as Error).message })
    }
  })

  /** 从这里起不再带前文。一次 append，不跑模型。 */
  ctx.server.post('/api/sessions/:id/reset', async (req, res) => {
    try {
      /**
       * 还开着的转人工工单要拦，理由和 resetContext 里拦排队消息的那条一模一样：
       * 它也会在重置**之后**自动开出新的一轮——人点「交还」时上面那个 deliver 走
       * `agents.send(...)` 把结果送进会话。区别只在时间尺度：排队消息是秒级，交接单是
       * 分钟到天（见 docs/handoff.md）。所以漏掉它的后果反而更难看：几小时后人做完交
       * 回来，Bot 收到一句「做完了，结论是 X」，却完全不知道当初交出去的是什么活——
       * 而那时已经没人记得中间点过一次 /new。
       *
       * 拦得住是因为有出口：单子能在待办里取消，也可以等它回来之后再开新对话。
       *
       * **闸在这儿而不在 agents 里**：那个服务的 inject 没有 handoffs，加进去会连累
       * 一批只搭半个应用的探针；而这里本来就有它，也正是 resetContext 唯一的调用点。
       */
      const open = ctx.handoffs.of(req.params.id).filter((h) => h.state === 'open' || h.state === 'claimed')
      if (open.length) {
        res.status = 409
        res.json({ error: `还有 ${open.length} 张转人工的单子没结，先处理掉、或等它交回来再开新对话` })
        return
      }
      const r = await ctx.agents.resetContext(req.params.id)
      res.json({ reset: true, throughSeq: r.throughSeq, droppedMessages: r.droppedMessages })
    } catch (e) {
      res.status = e instanceof CommandError ? e.status : 500
      res.json({ error: (e as Error).message })
    }
  })

  /**
   * 这条会话用哪个日常模型（docs/model-choice.md）。
   *
   * GET 给界面画选择器：能挑哪几个、现在是哪个。PUT 只收 `key`（`provider/model`，
   * null = 回默认）——**不收 provider + model 两个字段**，理由同 /messages 的 modelRole：
   * 这条路浏览器也走得通，收一对任意的值就是给白名单开了个后门。名单外的 key 回 400，
   * 那句原话列出能选的是哪几个。
   */
  ctx.server.get('/api/sessions/:id/model', async (req, res) => {
    try {
      res.json(ctx.agents.sessionModelState(await ctx.agents.sessionHistoryOr404(req.params.id)))
    } catch (e) {
      res.status = e instanceof CommandError ? e.status : 500
      res.json({ error: (e as Error).message })
    }
  })

  /**
   * `key` 是界面上点选的那一项；`arg` 是输入框里 `/model` 后面打的那截（序号、default、
   * 模型 id、显示名），由席位按和 Telegram 同一份规则认（pickModelArg）。两个都只能落到
   * 名单里的某一项上，认不出来回 400、原话列出能选的。
   */
  ctx.server.put('/api/sessions/:id/model', async (req, res) => {
    const body = (await req.json().catch(() => ({}))) as { key?: unknown; arg?: unknown }
    const bad = (v: unknown) => v !== null && v !== undefined && typeof v !== 'string'
    if (bad(body.key) || bad(body.arg)) {
      res.status = 400
      res.json({ error: 'key 必须是 provider/model 字符串或 null（回到默认），arg 必须是字符串' })
      return
    }
    try {
      let key = (body.key as string | null | undefined) || null
      if (typeof body.arg === 'string' && body.arg.trim()) {
        const state = ctx.agents.sessionModelState(await ctx.agents.sessionHistoryOr404(req.params.id))
        const hit = pickModelArg(body.arg, state.options)
        if (!hit) {
          const names = state.options.map((c, i) => `${i + 1}. ${c.label}`).join('  ')
          throw new CommandError(`没有「${body.arg.trim()}」这个模型。能选的是：${names}`, 400)
        }
        key = hit.isDefault ? null : hit.key
      }
      res.json(await ctx.agents.setSessionModel(req.params.id, key))
    } catch (e) {
      res.status = e instanceof CommandError ? e.status : 500
      res.json({ error: (e as Error).message })
    }
  })

  /**
   * 上传附件。裸字节进 body，文件名走 `x-filename`（URL 编码）。
   *
   * **不用 multipart**：这条路只传一个文件，multipart 要么拉个解析依赖，要么自己写一个
   * 状态机去切 boundary——都是为了一个这里根本用不上的「多部分」语义付钱。
   *
   * 文件落进工作区（`uploads/<sessionId>/`），返回相对路径。之后模型用 read_file 读它，
   * 浏览器用下面那条 GET 预览它——**同一份字节，没有第二处副本**。
   */
  ctx.server.post('/api/sessions/:id/files', async (req, res) => {
    const sessionId = req.params.id
    // 会话必须真的存在。Gateway 那边已经按账号校过一遍，这里再挡一次是因为
    // 「往哪个目录写」是这条路唯一的副作用，不该由一个没人认领的 id 决定。
    try {
      await ctx.sessions.events(sessionId)
    } catch {
      res.status = 404
      res.json({ error: `没有这个会话：${sessionId}` })
      return
    }
    const raw = req.headers.get('x-filename') ?? ''
    let filename = raw
    try {
      filename = decodeURIComponent(raw)
    } catch {
      // 不是合法的百分号编码就按原样用，safeName 会再洗一遍。
    }
    try {
      const saved = await ctx.workspace.saveUpload(sessionId, filename, req.body)
      ctx.logger?.info?.(`upload: ${sessionId} ← ${saved.path}（${saved.size} 字节）`)
      res.json(saved)
    } catch (e) {
      if (e instanceof WorkspaceError) {
        res.status = 400
        res.json({ error: e.message })
        return
      }
      throw e
    }
  })

  /**
   * 列工作区里的一层目录，给界面右栏那棵文件树用。
   *
   * **一次一层**（见 workspace/index.ts 的 list）：展开哪个目录就取哪个目录。
   * 点开某个文件走的仍是下面那条预览——两处看到的是同一个工作区、同一份字节。
   */
  ctx.server.get('/api/workspace/list', async (req, res) => {
    try {
      res.json(await ctx.workspace.list(req.query.get('path') ?? ''))
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      res.status = e instanceof WorkspaceError ? 400 : err?.code === 'ENOENT' ? 404 : 500
      res.json({
        error: e instanceof WorkspaceError ? e.message : err?.code === 'ENOENT' ? '目录不存在' : '列不出来',
      })
    }
  })

  /**
   * 预览工作区里的一个文件。上传进来的和 Bot 自己写出来的走的是同一条路——
   * 它们本来就在同一个目录里，没有理由分两套。
   *
   * `?download=1` 强制另存。除此之外，能不能内联由**扩展名白名单**说了算
   * （见 workspace/index.ts 的 INLINE）：SVG 和 HTML 不在里面，它们能带脚本。
   */
  ctx.server.get('/api/workspace/file', async (req, res) => {
    const path = req.query.get('path') ?? ''
    if (!path.trim()) {
      res.status = 400
      res.json({ error: 'path 不能为空' })
      return
    }
    /**
     * `?as=text`：把 Word / Excel / PPT / PDF 提取成文本回给界面预览。
     *
     * 浏览器打不开这几种格式，而对一份刚生成的报表说「下载下来看吧」是很差的答复。
     * 走的是 `read` 工具用的**同一套提取**（workspace/extract.ts），所以界面上看到的
     * 和模型读到的是同一份东西——内容对不上时，能一眼看出是提取的问题还是模型的问题。
     *
     * **摆在 open() 前面**：open() 会当场开一个读流，而这条路根本不读字节，
     * 放在后面等于每次预览都漏一个 fd。
     */
    if (req.query.get('as') === 'text') {
      const kind = docKindOf(path)
      if (!kind) {
        res.status = 415
        res.json({ error: '这种格式没法提取成文本' })
        return
      }
      try {
        const out = await extractDocument(ctx.workspace.resolve(path), kind)
        res.json({ text: out.text, note: out.truncated ? `内容较长，只提取了前 ${out.parts} ${out.unit}。` : '' })
      } catch (e) {
        const err = e as NodeJS.ErrnoException
        res.status = e instanceof WorkspaceError ? 400 : err?.code === 'ENOENT' ? 404 : 500
        res.json({
          error:
            e instanceof WorkspaceError ? e.message : err?.code === 'ENOENT' ? '文件不存在' : `提取失败：${(e as Error).message}`,
        })
      }
      return
    }
    let file: Awaited<ReturnType<typeof ctx.workspace.open>>
    try {
      file = await ctx.workspace.open(path)
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      res.status = e instanceof WorkspaceError ? 400 : err?.code === 'ENOENT' ? 404 : 500
      res.json({ error: e instanceof WorkspaceError ? e.message : err?.code === 'ENOENT' ? '文件不存在' : '读不出来' })
      return
    }
    const inline = file.inline && req.query.get('download') !== '1'
    return new Response(file.stream, {
      status: 200,
      headers: {
        'content-type': file.contentType,
        'content-length': String(file.size),
        'content-disposition': `${inline ? 'inline' : 'attachment'}; ${dispositionName(file.name)}`,
        // 声明的类型就是最终类型。允许嗅探，等于让一个改名成 .png 的 HTML
        // 重新变回 HTML——白名单当场作废。
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
      },
    })
  })

  /**
   * 删掉工作区里的一个文件或目录（界面右栏那棵树上，鼠标移上去出来的那颗）。
   *
   * 和上面那两条同一个工作区、同一道越界检查（workspace 服务），差别只在这条是
   * **有副作用**的：删掉就没了，工作区里没有回收站。所以确认在界面上做（那颗按钮
   * 弹一次框），这里不再问第二遍——两处都问的话，人只会把第二问当成噪音点掉。
   */
  ctx.server.delete('/api/workspace/file', async (req, res) => {
    const path = req.query.get('path') ?? ''
    if (!path.trim()) {
      res.status = 400
      res.json({ error: 'path 不能为空' })
      return
    }
    try {
      const gone = await ctx.workspace.remove(path)
      // 记一笔。删除是这个目录上唯一不可逆的操作，出了事「谁在什么时候删的」只能从
      // 这儿找回来——上传那条也是同一个理由记的。
      ctx.logger?.info?.(`delete: ${gone.path}${gone.dir ? '/（整个目录）' : ''}`)
      res.json(gone)
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      res.status = e instanceof WorkspaceError ? 400 : err?.code === 'ENOENT' ? 404 : 500
      res.json({
        error: e instanceof WorkspaceError ? e.message : err?.code === 'ENOENT' ? '文件不存在' : '删不掉',
      })
    }
  })

  // 未知的 /api/* 必须是 JSON 404，不能掉进下面的 SPA 兜底——否则前端 fetch
  // 拿到一段 HTML，报错会指向 JSON 解析而不是真正的路由缺失。
  //
  // **先放行再兜底**：路由按注册顺序匹配，而插件是并发挂载的，这条路由没法保证
  // 自己排在最后。写死成「匹配即 404」会把后挂上来的那些屏自己的 API 一并吞掉，
  // 而且吞得毫无痕迹。
  ctx.server.all('/api/{*rest}', async (req, res, next) => {
    const response = await next()
    if (response || res.claimed) return response
    res.status = 404
    res.json({ error: 'unknown endpoint', path: req.path })
  })

  ctx.server.all('/internal/{*rest}', async (req, res, next) => {
    const response = await next()
    if (response || res.claimed) return response
    res.status = 404
    res.json({ error: 'unknown endpoint', path: req.path })
  })

  ctx.server.get('/', async (req, res) => {
    res.status = 404
    res.json({ error: 'unknown endpoint', path: req.path || '/' })
  })

  /**
   * 未知路径 JSON 404，不再回 index.html。
   */
  ctx.server.all('/{*path}', async (req, res, next) => {
    const response = await next()
    if (response || res.claimed) return response
    res.status = 404
    res.json({ error: 'unknown endpoint', path: req.path })
  })

}

/**
 * 模型真能看的图片格式。
 *
 * 是白名单不是黑名单：不在里面的（TIFF、SVG、HEIC）各家 provider 支持不一，发过去
 * 多半换回一个 400，而那个 400 长得像我们自己的 bug，查起来要绕一大圈。不如在这儿
 * 就说清楚。
 */
const MODEL_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/**
 * 请求里的图片 → 校验过的引用。
 *
 * 三件事一起做：路径必须落在工作区内（`resolve` 越界即抛）、文件必须真的在、格式必须
 * 是模型看得懂的。**路径是浏览器传上来的**，这一层不做，工作区边界就等于没有。
 */
async function imageRefs(ctx: Context, raw: unknown): Promise<ImageRef[]> {
  if (raw == null) return []
  if (!Array.isArray(raw)) throw new Error('images 必须是数组')
  if (raw.length > 10) throw new Error('一条消息最多带 10 张图')
  const out: ImageRef[] = []
  for (const item of raw) {
    const path = typeof item?.path === 'string' ? item.path.trim() : ''
    const mime = typeof item?.mime === 'string' ? item.mime.trim().toLowerCase() : ''
    if (!path) throw new Error('images 里有一项缺 path')
    if (!MODEL_IMAGE_MIME.has(mime)) throw new Error(`这种图片格式模型看不了：${mime || '(空)'}`)
    const file = ctx.workspace.resolve(path)
    const info = await stat(file).catch(() => null)
    if (!info?.isFile()) throw new Error(`图片不存在：${path}`)
    out.push({ path: ctx.workspace.show(file), mime })
  }
  return out
}

/**
 * Content-Disposition 里的文件名。
 *
 * 两份一起给：`filename=` 是 ASCII 兜底，`filename*=` 按 RFC 5987 带 UTF-8 原名。
 * 中文名只给前者会变成乱码，只给后者老浏览器不认。ASCII 那份把引号和反斜杠也换掉——
 * 它在引号里，不换就能把这个 header 撑破。
 */
function dispositionName(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/**
 * 这个 bot 进程的身份。**每次起来都是新的一份。**
 *
 * 换版就是 `systemctl restart`：席位换了一个进程，而浏览器那头毫不知情——它手上那条
 * SSE 只是「断了」，和网络抖一下长得一模一样。于是它按老样子退避重连、拿着换版前的
 * 游标续传，界面上那些从旧进程攒下来的状态（正在跑的那一轮、排队的 dock、目录里的
 * 工具）就都成了旧闻，而没有任何东西会来纠正它。
 *
 * 所以每条流一开口就先自报家门：`instanceId` 变了 = 这不是你上次连的那个进程，客户端
 * 据此整条会话重来（见 gateway/ui/chat.js 的 runtime/hello）。**这是「重启信号」唯一
 * 送得出去的时刻**——进程死掉的那一刻它已经没法说话了，只能在重新连上的第一帧补说。
 */
const INSTANCE_ID = randomUUID()
const STARTED_AT = Date.now()

function sse(
  ctx: Context,
  sessionId: string,
  after: number,
  res: { _res?: { on?: Function } },
  tail = 0,
) {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      async start(controller) {
        const send = (event: SessionEvent) => {
          const safe = publicSessionEvents([event])[0]
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(safe)}\n\n`))
        }
        /** 直播（含快照后补发的队列）走这条：发过的不再发，见下面 lastSeq。 */
        const sendLive = (event: SessionEvent) => {
          if (event.seq <= lastSeq) return
          lastSeq = event.seq
          send(event)
        }

        /**
         * **第一帧：我是谁、从什么时候开始的。**
         *
         * 排在重放之前，不是之后：重放可能很长，而客户端要先知道「这是不是上次那个
         * 进程」才好决定这一批事件是接着看还是全部作废。它不是会话事件，不进事件桶
         * （和 replay/done、queue/change 一样按 type 分流）。
         */
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: 'runtime/hello', instanceId: INSTANCE_ID, startedAt: STARTED_AT, version: process.env.SATUWORK_VERSION || '' })}\n\n`,
          ),
        )

        let queue: SessionEvent[] | null = []
        const off = ctx.on('session/event', (id: string, event: SessionEvent) => {
          if (id !== sessionId) return
          if (queue) queue.push(event)
          else sendLive(event)
        })
        /**
         * 排队的消息有变。
         *
         * 走同一条流，因为界面要画的是同一屏；而且**队列的真相在这边**——浏览器刷新
         * 之后必须能把 dock 恢复出来，靠它自己记就会出现「界面上没有但它还是跑了」。
         * 帧的形状和 `replay/done` 一样是个非会话事件，客户端按 type 分流。
         */
        const offQueue = ctx.on('queue/change', (id: string, queued: unknown) => {
          if (id !== sessionId) return
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'queue/change', queued })}\n\n`))
          } catch {
            /* 流已经关了，下一次心跳会清掉 */
          }
        })

        let replayed = 0
        let firstSeq: number | null = null
        let hasMore = false
        /**
         * 已经发出去的最大 seq。
         *
         * 监听器挂在快照之前，而 SessionService.append 是先把事件推进内存、落盘之后
         * 才广播——落盘那一瞬间连上来的流会把这条事件既从快照里重放一遍，又从队列里
         * 再收一遍。所以排队的和后来直播的都拿它把关：小于等于它的就是已经发过的。
         */
        let lastSeq = after
        try {
          if (after > 0) {
            // 断线续传：从游标之后原样发，不切也不筛——那是「补上错过的」，
            // 和「打开页面看最近几轮」是两件事。
            for (const event of publicSessionEvents(await ctx.sessions.events(sessionId, after))) {
              send(event)
              replayed++
              if (event.seq > lastSeq) lastSeq = event.seq
            }
          } else {
            // 头一次连上：只发最近 tail 轮，并且丢掉已经作废的流式 chunk（见 replay.ts）。
            const slice = historySlice(await ctx.sessions.events(sessionId), { turns: tail })
            for (const event of slice.events) {
              send(event)
              replayed++
              if (event.seq > lastSeq) lastSeq = event.seq
            }
            firstSeq = slice.firstSeq
            hasMore = slice.hasMore
          }
        } catch (e) {
          ctx.logger?.warn?.(`sse: 会话 ${sessionId} 读不出来：${(e as Error).message}`)
          controller.enqueue(
            encoder.encode(`event: error\ndata: ${JSON.stringify({ error: (e as Error).message })}\n\n`),
          )
          off()
          offQueue()
          return controller.close()
        }

        /**
         * 历史放完了。
         *
         * 这条标记**必须有**：历史和实时走的是同一个通道、同样的 `data:` 帧，客户端
         * 收到一条 `turn/start` 时没法知道它是「几小时前那一轮开始了」还是「刚刚开始
         * 了一轮」。于是重放一段长会话时，界面会一路挂着「正在处理」，直到重放出那个
         * 配对的 `turn/end`——会话越长挂得越久，而那期间什么都没在跑。
         *
         * 有了这条，客户端就能把标记之前的一律当历史，只认之后的状态。
         *
         * `live` 是**这条会话此刻到底在不在跑**，由 agents 直接给。带上它，是因为客户端
         * 原来只能从事件顺序里猜：从头扫，遇 turn/start 算在跑、遇 turn/end 算跑完，最后
         * 一个说了算。这个猜法有个前提——历史必须完整——而它经常不成立：
         *
         *   · 流断在重放中途，客户端手上就只剩半截，尾巴那条 turn/end 没到；
         *   · 进程半路没了（崩溃、机器重启、每一次「重新部署」），日志里那条 turn/end
         *     根本没写成——healDanglingTurn 要等下一次从磁盘读这条会话才补得上。
         *
         * 两种情况下界面都会一直挂着「正在处理」，而那边什么都没在跑，等多久都不会变。
         * 少几条消息是看得出来的，假装在跑不是——所以这件事不该猜，让知道的人说。
         */
        const live = ctx.agents.isRunning(sessionId)
        // 「界面为什么一直显示正在处理」全靠这一行断案：live 是 true 就是真在跑，
        // 是 false 而界面还挂着，那就是前端的事。
        /**
         * **续传那一支不报「还有更早的」。**
         *
         * `firstSeq` / `hasMore` 只有「打开页面取最近几轮」那一支算得出来；续传时它们
         * 停在初始的 `null` / `false`，照着打就是一句**假结论**——日志上写着
         * 「还有更早的=false」，而那条会话前面明明还有几千条。排查刷新卡顿时，这一行
         * 会把人引到「是不是重放了全部消息」上去，而续传只发了游标之后的那几条。
         *
         * 帧里也一并省掉：客户端那边 `noteChatPage` 是按「有没有带这两个值」判的
         * （见 gateway/ui/chat.js），不带就不会覆盖它已经知道的分页游标。
         */
        const resuming = after > 0
        ctx.logger?.info?.(
          `sse: 会话 ${sessionId} 接上，after=${after}，tail=${tail}，重放 ${replayed} 条，live=${live}` +
            (resuming ? '（续传）' : `，还有更早的=${hasMore}`),
        )
        controller.enqueue(
          encoder.encode(
            // 队列一起带上：刷新页面之后 dock 要能原样回来。
            `data: ${JSON.stringify({
              type: 'replay/done',
              live,
              ...(resuming ? {} : { firstSeq, hasMore }),
              queued: ctx.agents.queued(sessionId),
            })}\n\n`,
          ),
        )

        const pending = queue
        queue = null
        for (const event of pending) sendLive(event)

        /**
         * 心跳。
         *
         * **尾巴会卡在缓冲里。** 上面那些 `send()` 是 `controller.enqueue`，不阻塞——
         * 它只把事件塞进队列，什么时候真的写到浏览器由下游决定。而浏览器在 fetch 流
         * 上会攒够一定量才交付（Safari 尤其明显），于是一条安静下来的会话，最后几十
         * 条事件连同 `replay/done` 就一直压在那儿，再也没有新字节把它们顶出去。
         *
         * 实测长这样：bot 报「重放 1078 条」，客户端手上只有 1054 条，`replay/done`
         * 从没到达，而连接看着还开着、也不会重连——历史缺一截，界面因为拿不到那句
         * 「在不在跑」而永远挂着「正在处理」。哪条会话中招取决于它的字节数落在缓冲
         * 边界的哪一侧，所以刷一次换一个，看着像见了鬼。
         *
         * 一条 `: ping` 注释就够：它不是事件，客户端解析时直接跳过，但它是新字节，
         * 会把压着的那一截一起冲出去。顺带也让掉线被及时发现。
         */
        const beat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(': ping\n\n'))
          } catch {
            clearInterval(beat)
          }
        }, 15000)

        // 长连接不该等到插件卸载才释放。ctx.on 是 effect，那只是兜底。
        res._res?.on?.('close', () => {
          clearInterval(beat)
          off()
          offQueue()
          try {
            controller.close()
          } catch {}
        })
      },
    }),
    {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      },
    },
  )
}

/**
 * 请求体里的 mentions → 结构。
 *
 * **不做归属校验**：这一条是 Gateway 的活（它才知道这把连接属不属于这个账号）。
 * 席位这边只认形状——它信的是那张 `sat_` 票，票背后是谁由 Gateway 说了算。
 */
function mentionList(raw: unknown): Mention[] {
  if (!Array.isArray(raw)) return []
  const out: Mention[] = []
  for (const item of raw.slice(0, 10)) {
    const o = (item ?? {}) as Record<string, unknown>
    const id = String(o.id ?? '').trim()
    const kind = String(o.kind ?? 'connector')
    if (!id) continue
    if (kind !== 'connector' && kind !== 'bot' && kind !== 'routine') continue
    out.push({ kind, id, label: String(o.label ?? '').slice(0, 64) })
  }
  return out
}
