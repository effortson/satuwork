import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import type { SessionEvent } from '../session/types.ts'
import { CommandError } from '../agent/index.ts'
import { clearSettledTodos, readTodos } from '../tools/todo.ts'
import {
  channelCommand, channelDraft, channelFiles, channelHandoffs, channelMentionHelp, channelModelCommand, channelModelHelp, channelReply,
  isChannelMessage, parseChannelMentions, pickModelArg, withChannelTodos,
  type ChannelFile, type ChannelHandoff, type ChannelMentionCandidate,
} from './channel.ts'
import { openHandoffs } from './http.ts'

/**
 * 渠道（Telegram）那条路的运行时：一条渠道消息落进这颗 Bot 的主会话、等这一轮跑完、把回复带回
 * Gateway 的 Dispatcher。状态（会话映射、去重表、在途的那几条）在 apply 一开头建，路由在原来
 * 那个位置挂——拆成两步是为了路由注册的先后不变。
 */
export function channelRuntime(ctx: Context) {
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
        if (!isChannelMessage(event, active.eventId)) continue
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
        const state = await ctx.agents.freshModelState(history)
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
        const open = openHandoffs(ctx, mapped.sessionId)
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

  return { channelInflight, channelKey, channelApprovalKey, runChannelMessage }
}

export function channelRoutes(ctx: Context, { channelInflight, channelKey, channelApprovalKey, runChannelMessage }: ReturnType<typeof channelRuntime>) {
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
}
