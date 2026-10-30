import type { Context } from '@deepseek-ai/cordis'
import { historySlice } from '../session/replay.ts'
import { searchSession } from '../session/search.ts'
import { CommandError, QUIET_MESSAGE, type ImageRef, type MessageSource, type RefBlock } from '../agent/index.ts'
import { isTaskInstruction } from '../agent/task-turns.ts'
import { expiredMessage, returnMessage, type Disposition, type HandoffActor } from '../policy/handoff.ts'
import { readTodos } from '../tools/todo.ts'
import { pickModelArg } from './channel.ts'
import { channelRoutes, channelRuntime } from './channel-runtime.ts'
import { openHandoffs, replyCommandError } from './http.ts'
import { imageRefs, mentionList, refList } from './refs.ts'
import { INSTANCE_ID, sse, STARTED_AT } from './sse.ts'
import { workspaceRoutes } from './workspace-routes.ts'

// 这些搬去了 web/ 的子模块；探针（e2e-telegram-channel / e2e-references / e2e-replay）仍从这里拿。
export { channelDraft, channelFiles, channelHandoffs, type ChannelFile, type ChannelHandoff } from './channel.ts'
export { refExcerptOf, refList } from './refs.ts'
export { sse } from './sse.ts'

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

export function apply(ctx: Context, _config: Config = {}) {
  // 渠道（Telegram）那条路的状态：会话映射、去重表、在途的那几条（见 channel-runtime.ts）。
  const channels = channelRuntime(ctx)

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
   * 只有管家会调（它手上有席位票，见 deploy-seat.sh 写进 /etc/satuwork/seats/<席位>/secrets.env 的 GATEWAY_TOKEN）。
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

  channelRoutes(ctx, channels)

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
   * 在这条会话里按关键词找消息和文件（docs/chat-search.md）。语义在 session/search.ts；
   * 这里只收参数。`q` 空就是空结果，不是 400——界面上人把搜索框清空的那一下也会打过来。
   */
  ctx.server.get('/api/sessions/:id/search', async (req, res) => {
    const q = String(req.query.get('q') ?? '')
    const limit = Number(req.query.get('limit') ?? 0)
    const before = Number(req.query.get('before') ?? 0)
    try {
      const all = await ctx.sessions.events(req.params.id)
      res.json(searchSession(all, { q, limit: limit > 0 ? limit : undefined, before: before > 0 ? before : undefined }))
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
      /** 引用的消息 / 文件，形状见 session/types.ts 的 ref 块去掉 type。 */
      refs?: unknown
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
      /**
       * 主 Bot 派活（docs/bot-tasks.md §4）：工人替主 Bot 发进目标会话的指令（phase=instruction），
       * 或替目标 Bot 发回主会话的结论（phase=result）。身份只让界面画角标；正文自带那行标题。
       */
      task?: unknown
    }
    const modelRole = body.modelRole === 'utility' || body.modelRole === 'daily' ? body.modelRole : undefined
    const routine = body.routine && typeof body.routine === 'object' ? (body.routine as { id?: unknown; name?: unknown }) : null
    const task = body.task && typeof body.task === 'object' ? (body.task as { id?: unknown; phase?: unknown; from?: unknown }) : null
    // 谁在说话。kind 认得出「不是人打的」——界面照 source.plugin 画角标（见 chat.js 的 fold）。
    const source = routine
      ? ({ kind: 'plugin', plugin: 'routine', form: String(routine.id ?? '') } as MessageSource)
      : task
        ? ({
            kind: 'plugin',
            plugin: 'task',
            form: String(task.id ?? ''),
            phase: task.phase === 'result' ? 'result' : 'instruction',
            from: task.from && typeof task.from === 'object' ? task.from : null,
          } as MessageSource)
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
    /**
     * 引用（docs/chat-references.md §5.1）。和图片一样在这一层校验：文件路径是浏览器
     * 传上来的，工作区边界不在这里做就等于没有；消息 seq 是界面从事件上抄的，对不上
     * 就是界面的 bug 或别的会话的 seq，收下只会落一条指向错处的记录。
     */
    let refs: RefBlock[]
    try {
      refs = await refList(ctx, req.params.id, body.refs)
    } catch (e) {
      res.status = 400
      res.json({ error: (e as Error).message })
      return
    }
    // 带图的消息可以没有正文——「这张图什么意思」本来就常常只有一张图。
    if (!body.text?.trim() && !images.length && !mentions.length && !refs.length) {
      res.status = 400
      res.json({ error: 'text 不能为空' })
      return
    }
    /**
     * 席位正在换版：**这一条当场回绝，而不是收下再被重启砍掉**。
     *
     * 收下的后果是最坏的那一种：界面上画着一条已经发出去的消息，几秒后进程没了，那一轮
     * 连 turn/end 都没写成——人只会以为「发出去了但它不理我」。回绝则明白得多，草稿也
     * 原样退回去（见 ui/chat-composer.js 的 sendChat 那个 catch），过几秒重发就是。
     *
     * **在跑的那一轮不受影响**：steering 照旧插得进去（静默只挡新一轮）。
     *
     * 但**带 `@` 的那种要一起挡**：它走的是排队（这一轮跑完自动接上），而静默期里
     * drainQueue 停手、紧接着进程就被换掉了——收下它等于开一张不会兑现的空头支票，
     * 那条消息会一直躺在队列里，直到某天另一轮跑完才被想起来。
     */
    /**
     * **派活不插话，派活跑着的时候也不插话**（docs/bot-tasks.md §7）。
     *
     * 派活那几轮是替主 Bot 跑的一次性差事，折起来画、不进后面的上下文。主 Bot 派来的指令
     * 插进人正在跑的那一轮，就成了人那一轮的一部分，既拆不出来也停不掉；人在派活跑着时说的话
     * 插进去，就跟着那件活一起被折叠、一起从上下文里消失。两种都排到当前这一轮后面，各开一轮。
     */
    const mustQueue = mentions.length > 0 || isTaskInstruction(source) || ctx.agents.runningTask(req.params.id)
    if (ctx.agents.quiesced() && mustQueue) {
      refuseQuiet(res)
      return
    }
    if (ctx.agents.isRunning(req.params.id)) {
      /**
       * **人在这一轮跑着的时候接着说的话，排到这一轮后面，不插话。**
       *
       * 插进去的话，模型会在半截工具链里读到它、当场改口回应——人只是补一句「你好」，那一轮
       * 却被带偏了，屏幕上还看不出哪句是在回哪条。排着的会画在输入框顶上，这一轮收口后各开一轮。
       * 要真打断就按停止。
       *
       * 静默期里例外：排了也接不上（drainQueue 停手、进程马上换掉），退回插话，总比回绝强。
       */
      if (mustQueue || !ctx.agents.quiesced()) {
        try {
          const row = ctx.agents.enqueue(req.params.id, body.text ?? '', images, mentions, refs, source, modelRole)
          res.json({ queued: true, queueId: row.id, refs: refs.length })
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
      if (await ctx.agents.steer(req.params.id, body.text ?? '', images, source, refs)) {
        res.json({ steered: true, refs: refs.length })
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
    void ctx.agents.send(req.params.id, body.text ?? '', images, mentions, source, modelRole, refs).catch((e: Error) => {
      console.error(`satuwork: agents.send 失败：${e.message}`)
      ctx.logger?.warn?.(`agents.send 失败：${e.message}`)
    })
    // `refs` 回几条：界面靠它分辨「席位认不认这个字段」——老席位的响应里没有它，
    // 那条消息已经不带引用地发出去了，界面要提示人更新 Bot 版本。
    res.json({ accepted: true, refs: refs.length })
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
      /** 「退回修改」时的修改意见，只跟着 deny 走（见 policy/approvals.ts 的 decide）。 */
      feedback?: unknown
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
    const feedback = typeof body.feedback === 'string' ? body.feedback : undefined
    const r = ctx.policy.approvals.decide(req.params.id, req.params.callId, decision, scope, edits, feedback)
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
      replyCommandError(res, e)
    }
  })

  /**
   * `/new` 和 `/clear` 共用的那道闸：还开着的转人工工单。拦的时候回 409 + 原话，
   * 返回 true；放行返回 false。
   */
  const openHandoffsBlock = (sessionId: string, res: { status: number; json: (v: unknown) => void }, what: string) => {
    const open = openHandoffs(ctx, sessionId)
    if (!open.length) return false
    res.status = 409
    res.json({ error: `还有 ${open.length} 张转人工的单子没结，先处理掉、或等它交回来再${what}` })
    return true
  }

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
      if (openHandoffsBlock(req.params.id, res, '开新对话')) return
      const r = await ctx.agents.resetContext(req.params.id)
      res.json({ reset: true, throughSeq: r.throughSeq, droppedMessages: r.droppedMessages })
    } catch (e) {
      replyCommandError(res, e)
    }
  })

  /**
   * `/clear`：在 `/new` 之上再把之前的记录从界面上拿掉（docs/chat-commands.md §15）。
   *
   * 落的还是 `session/reset`，带 `clear: true`。日志一条不删，审计照旧；看不见的是
   * 聊天历史、SSE 重放和模型的 history_read / history_search。转人工那道闸照抄 `/reset`：
   * 单子交回来时 Bot 要接着干的那段活，已经从它能翻到的地方消失了。
   */
  ctx.server.post('/api/sessions/:id/clear', async (req, res) => {
    try {
      if (openHandoffsBlock(req.params.id, res, '清空')) return
      const r = await ctx.agents.resetContext(req.params.id, { clear: true })
      res.json({ cleared: true, throughSeq: r.throughSeq, droppedMessages: r.droppedMessages })
    } catch (e) {
      replyCommandError(res, e)
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
      res.json(await ctx.agents.freshModelState(await ctx.agents.sessionHistoryOr404(req.params.id)))
    } catch (e) {
      replyCommandError(res, e)
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
        const state = await ctx.agents.freshModelState(await ctx.agents.sessionHistoryOr404(req.params.id))
        const hit = pickModelArg(body.arg, state.options)
        if (!hit) {
          const names = state.options.map((c, i) => `${i + 1}. ${c.label}`).join('  ')
          throw new CommandError(`没有「${body.arg.trim()}」这个模型。能选的是：${names}`, 400)
        }
        key = hit.isDefault ? null : hit.key
      }
      res.json(await ctx.agents.setSessionModel(req.params.id, key))
    } catch (e) {
      replyCommandError(res, e)
    }
  })

  // 上传附件、工作区文件树、预览、删除（见 workspace-routes.ts）。
  workspaceRoutes(ctx)

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
