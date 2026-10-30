import { Service, type Context } from '@deepseek-ai/cordis'
import { Agent, type AgentEvent, type AgentMessage } from '@earendil-works/pi-agent-core'
import { randomUUID } from 'node:crypto'
import type {
  MessageSource,
  RefBlock,
  SessionEventMap,
  SessionOrigin,
  StreamChunk,
} from '../session/types.ts'
// web/index.ts 那条 /messages 也要给来源打标，从这儿转一手，别让它反过来依赖 session/types。
export type { MessageSource, RefBlock }
import type { WorkspaceFile } from '../tools/index.ts'
import { turnContextGuard } from './context-guard.ts'
import { ProgressTracker } from './progress.ts'
import { isTaskInstruction } from './task-turns.ts'
import { readTodos, restoreTodos } from '../tools/todo.ts'
import { BAD_TOOL_ARGS } from '../llm/gateway.ts'
import { browserOf, desktopOf, memoryOf, type BotRecord } from '../registry/index.ts'
import { cachedMemories, cachedSkill, cachedSkills, type CachedSkill, type ReasoningEffort } from '../catalog/index.ts'
import {
  clampTranscript,
  compactionPoint,
  compactionWindow,
  contextBoundary,
  observedPromptTokens,
  runSummary,
  scopeAfterBoundary,
  summaryText,
} from './compaction.ts'
import { stampContent, stampUser, toAgentMessages, userBlocks, userContentFor } from './history.ts'
import { seesImages, toolImageBlocks } from './images.ts'
import {
  assignBlock,
  escalateBlock,
  fileOutBlock,
  knowledgeBlock,
  linkOutBlock,
  localFoldersBlock,
  mentionBotBlock,
  mentionGapBlock,
  refBlock,
  runtimeBlock,
  schedulingBlock,
  sharedFolderBlock,
  todoBlock,
  webContentBlock,
} from './prompt-blocks.ts'
import { memoryBlockOf, SKILL_TOOLS, skillSplit, type SkillSplit, skillTools } from './skills-memory.ts'
import { abortedOutcome, lastAssistantText, sumUsage, taskBlock, taskBrief, taskFiles } from './task-outcome.ts'
import { contentDigest, estMessages, estTokens, toolsText } from './text.ts'
import { filesOf, fromAgentContent, imagesOf, rawTextOf, refsOf, shotOf, textOf, toUsage } from './tool-results.ts'
import {
  CommandError,
  type CompactOutcome,
  type Config,
  type DailyChoice,
  EMPTY_USAGE,
  type ImageRef,
  type Mention,
  type QueuedMessage,
  type SessionModelState,
  type TaskOutcome,
  type TaskSpec,
  type TurnModelRole,
} from './types.ts'

// 下面这些从 agent/ 的子模块搬过去了；别的模块和探针（bot/e2e-*.mjs）照旧从这里拿。
export {
  CommandError,
  type CompactOutcome,
  type Config,
  type DailyChoice,
  type ImageRef,
  type Mention,
  type QueuedMessage,
  type SessionModelState,
  type TaskOutcome,
  type TaskSpec,
  type TurnModelRole,
} from './types.ts'
export { contentDigest } from './text.ts'
export { seesImages } from './images.ts'
export { memoryBlockOf, memoryLayersOf, pickMemories, SKILL_TOOLS, skillSplit, type SkillSplit, skillTools } from './skills-memory.ts'
export {
  clampTranscript,
  compactionPoint,
  compactionWindow,
  contextBoundary,
  observedPromptTokens,
  runSummary,
  scopeAfterBoundary,
} from './compaction.ts'
export { interleaveMentions, toAgentMessages } from './history.ts'
export { localFoldersBlock, schedulingBlock, sharedFolderBlock } from './prompt-blocks.ts'
export { blankOutcome } from './task-outcome.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agents: AgentService
  }
  interface Events {
    /**
     * 排队的消息有变（进队、出队、被取消）。
     *
     * 界面靠它把输入框顶上那一行 dock 画对。**队列的真相在实例这边**，不在浏览器：
     * 放浏览器最省事，但刷新一次就丢、两个标签页各排各的，而消息其实已经发出去了。
     */
    'queue/change'(sessionId: string, queued: QueuedMessage[]): void
  }
}

/**
 * 等一个 promise，但喊停了就不等了（resolve 成 undefined，由调用方接着看信号）。
 *
 * 被丢下的那个 promise 照样跑完；它之后要是拒绝，这里先挂一个空的 catch 接住，
 * 免得变成未处理的拒绝。
 */
function untilAborted<T>(p: Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
  if (!signal) return p
  p.catch(() => {})
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise<T | undefined>((resolve, reject) => {
    const onAbort = () => resolve(undefined)
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

/**
 * 一轮的默认步数硬顶。见 `Config.maxSteps`。
 *
 * 120 是按「真干活的一轮能有多长」定的：装环境、跑测试、按报错改再跑，几十步是常态，
 * 上百步已经罕见。定得太小会把正经的长活拦腰砍断，而那比跑飞更让人恼火。
 */
const DEFAULT_MAX_STEPS = 120

/**
 * 子会话的父子索引在收口之后还留多久（见 runTask 结尾）。
 *
 * 五分钟：够接住「移交和进程结束撞在一起」那个窄窗口，又不至于让一台跑几周的席位攒下
 * 几千条永远查不到头的映射。
 */
const TASK_MEMO_TTL_MS = 5 * 60_000
/**
 * 委派跑着时，两条进度之间至少隔多久（runTask 里那个限频）。一步一条足够让人看见它在动，
 * 再密就只是往主会话里刷行。
 */
const TASK_PROGRESS_MIN_MS = Math.max(200, Math.trunc(Number(process.env.SATUWORK_TASK_PROGRESS_MS ?? 1_500)))
/**
 * 静默期里回绝新一轮时说的那句话。
 *
 * **是给人看的**：它会经 Gateway 原样回到浏览器上（见 web/index.ts 那条 409）。所以
 * 说清楚两件事——现在为什么不行，以及要等多久（几秒，不是「稍后再试」这种废话）。
 */
export const QUIET_MESSAGE = '席位正在换新版本，这几秒不接新消息；等它起来再发一次'

/**
 * Agent 循环。
 *
 * 循环本身是 `@earendil-works/pi-agent-core`——它带 steering（**工具跑到一半也能
 * 插话**）、follow-up 队列、中止、思考预算，以及 `transformContext` 这个注入外部
 * 上下文的钩子（知识库检索与长期记忆以后挂那里）。自己写这些没有收益。
 *
 * 但**持久记录仍然是我们自己的**：订阅它的事件，投影进我们的会话日志。运行时
 * 状态归它、durable 记录归我们，单向流动不会漂移。它的会话后端
 * （`pi-session-backend-sqlite-node`）刻意不用——那会把日志格式交出去。
 */
export class AgentService extends Service {
  /** 正在跑的 agent。steering 要够得着它，所以不能只是个局部变量。 */
  private live = new Map<string, Agent>()
  /**
   * 工具结果交出去之后才拍完的截图（ToolResult.pendingShot）：会话 → callId → 那张图。
   *
   * bridgeTools 收下，projector 在 `tool/result` 落盘之后取走、挂上补写 `tool/shot`。
   * 两边隔着 pi 的事件循环，所以要一个地方交接。
   */
  private laterShots = new Map<string, Map<string, Promise<WorkspaceFile | undefined>>>()
  /** 每条会话还没写完的 `tool/shot`。写 `turn/end` 之前等它们，见 settleShots。 */
  private shotWrites = new Map<string, Set<Promise<void>>>()
  /**
   * 已经开跑、但 Agent 还没造出来的会话。
   *
   * send() 里「检查在不在跑」和「登记进 live」之间隔着好几个 await（读历史、组 system、
   * 查模型）。只看 live 的话，两个并发的 send 会双双通过检查，于是同一条会话上跑起两个
   * agent：事件交错写进同一份 JSONL，用量也记两遍。占位必须在**第一个 await 之前**
   * 同步做掉。
   */
  private starting = new Set<string>()
  /**
   * 正在跑的那一轮是主 Bot 派来的活（docs/bot-tasks.md §7）。这时候进来的话不插进去——插进去
   * 就成了那件活的一部分，跟着它一起被折叠、一起不进后面的上下文；排到它后面另开一轮。
   */
  private taskTurns = new Set<string>()
  /**
   * 还在「开轮」那一段的会话各自的中止开关。
   *
   * 停止按钮以前只看 `live`：轮首那次同步压缩要跑一次模型、点名缺工具要重拉目录，
   * 那几秒里 agent 还没建出来，按停止回的是 aborted:false，然后这一轮照样整轮跑完。
   * runGuarded 一进来就登记一个，abort() 找不到 live 时掐它，runTurn 在进 live 之前的
   * 每个 await 之后看一眼。
   */
  private startingAbort = new Map<string, AbortController>()
  /**
   * 正在压缩的会话。轮末那次是后台跑的，下一轮很可能在它还没写完时就开始了——
   * 两次压缩同时算，会各自按自己看到的历史挑边界，然后写下两条互相矛盾的压缩点。
   */
  private compacting = new Map<string, Promise<CompactOutcome>>()
  /**
   * 每条会话 `/new` 过几次。压缩开工时记下这个数，写回之前再比一次（见 compactOnce）。
   *
   * 自动压缩在后台跑、要调一次模型写摘要，十几到几十秒。这期间人打了 `/new`：重置点先落盘，
   * 压缩随后写下一条 throughSeq 更小的压缩点——而上下文边界认的是**最后一条**，于是重置前的
   * 原文连同一份旧摘要全回到上下文里，`/new` 等于没做，也不报错。重置一次就作废一次在飞的压缩。
   */
  private resets = new Map<string, number>()

  constructor(
    ctx: Context,
    private config: Config = {},
  ) {
    super(ctx, 'agents')
  }

  /**
   * 生效配置：设置库 > cordis.yml > 内置默认。
   * **在使用点读取**，不在构造时缓存——界面上改完下一轮就生效。
   */
  private setting<T>(key: string, fallback: T): T {
    return this.ctx.storage.getSetting<T>('agent', key) ?? fallback
  }
  get provider() {
    return this.setting('provider', this.config.provider ?? 'deepseek')
  }
  get model() {
    return this.setting('model', this.config.model ?? 'deepseek-v4-flash')
  }
  get system() {
    return this.setting(
      'system',
      this.config.system ?? '你是 Satuwork 的 AI 员工，用简洁、专业的中文回答。',
    )
  }
  /** 设置库里塞进来的可能是字符串或负数，取到手先夹一遍——0 或负数会让每一轮开局即收口。 */
  get maxSteps(): number {
    const raw = this.setting('maxSteps', this.config.maxSteps ?? DEFAULT_MAX_STEPS)
    return Math.max(1, Math.trunc(Number(raw) || DEFAULT_MAX_STEPS))
  }

  isRunning(sessionId: string) {
    return this.live.has(sessionId) || this.starting.has(sessionId)
  }

  /** 正在跑的是不是主 Bot 派来的活。见 taskTurns。 */
  runningTask(sessionId: string): boolean {
    return this.taskTurns.has(sessionId) && this.isRunning(sessionId)
  }

  // ── 换版前的静默期 ────────────────────────────────────────────────
  //
  // 管家要重启这个进程之前，先让它**不再开新的一轮**，然后等手上这一轮跑完（见
  // manager/src/seats.ts 的 drainSeat）。没有这一道，「等到空闲」和「真的重启」之间还
  // 隔着拉包、解包、rsync 那几秒——人在那几秒里发一句，照样被拦腰砍断，而排空看上去
  // 明明成功了。
  //
  // **只挡新的一轮，不挡 steering。** 正在跑的那一轮由用户自己管，插一句话不会多开
  // 一轮；真要一直插下去，排空就等不到空闲、超时之后这次换版被拒——那个方向是安全的
  // （宁可不换版，也不打断人）。
  //
  // **只在内存里，而且带 TTL。** 进程马上就要被换掉，落盘没有意义；而管家要是在中途
  // 挂了、或者部署失败没来得及放开，这台席位不能就此变成一块永远不接活的砖。

  /** 静默到什么时候（epoch ms）。0 = 正常接活。 */
  private quietUntil = 0

  /** 上限：够一次「等空闲 + 重铺」，又不至于让一次失联把席位冻住太久。 */
  static readonly QUIET_MAX_MS = 5 * 60_000

  quiesced(): boolean {
    return this.quietUntil > Date.now()
  }

  /** TTL 到点时把静默期里攒下的队列排掉。 */
  private quietTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * 进入静默；`ttlMs: 0` 是放开（管家的 `/api/quiesce {ttlMs:0}` 走的就是这条，等同 resume）。
   * 返回实际生效到什么时候，调用方好核对自己那一头的预算。
   */
  quiesce(ttlMs: number): number {
    const ttl = Math.min(AgentService.QUIET_MAX_MS, Math.max(0, Math.trunc(Number(ttlMs) || 0)))
    clearTimeout(this.quietTimer)
    if (!ttl) {
      this.resume()
      return 0
    }
    this.quietUntil = Date.now() + ttl
    /**
     * **到点也要排一遍。** 管家中途挂了、没来得及放开，静默会自己过期；可静默期里排进来的消息
     * 没有任何东西会再来叫醒（drainQueue 那时是直接 return 的），人只能再发一条——而那一条会
     * 先跑，顺序也倒了。
     */
    this.quietTimer = setTimeout(() => {
      if (!this.quiesced()) this.resume()
    }, ttl + 50)
    this.quietTimer.unref?.()
    this.ctx.logger?.info?.(`agents: 进入换版静默 ${Math.round(ttl / 1000)} 秒，期间不开新的一轮`)
    return this.quietUntil
  }

  /** 放开，并把静默期里攒下的队列排掉。部署失败、或者根本没走到重启那一步时，管家要负责调它。 */
  resume(): void {
    clearTimeout(this.quietTimer)
    this.quietUntil = 0
    this.ctx.logger?.info?.('agents: 静默已放开，恢复接活')
    /**
     * **放开之后要主动把队列排一遍。**
     *
     * 静默期里 drainQueue 是直接 return 的（见那儿的注释：留在队列里，和进程被杀是同
     * 一个结局）。可如果管家最后没有重启这个进程、而是调 resume 放开了，那些消息就没
     * 有任何东西会再来叫醒——队列落着盘，dock 上挂着，人只能自己再发一条。
     */
    for (const sessionId of this.queuedSessions()) {
      void this.drainQueue(sessionId).catch((e) => {
        this.ctx.logger?.warn?.(`agents: 恢复后排空 ${sessionId} 失败：${(e as Error).message}`)
      })
    }
  }

  /**
   * 这个席位此刻在忙吗——**不问是哪条会话**。
   *
   * 管家要在重启这个进程之前知道这件事：换版就是 `systemctl restart`，跑到一半的那
   * 一轮会当场没命（日志里那条 turn/end 根本没写成，要等下一次读盘才由
   * healDanglingTurn 补上），而人正对着屏幕等回答。见 manager/src/seats.ts 的排空。
   *
   * **只认「在跑」，不认「排着」**，尽管排着的那几条确实也是人在等的活。理由是队列
   * 落在盘上（storage 的 message-queue），而**消费它的唯一时机是某一轮跑完**（见
   * drainQueue）：没有 turn 在跑时，队列就是不动的，这时拦下重启一件东西也保护不了。
   * 反过来，认它的代价很实在——一条在 turn 跑到一半时被杀掉（机器重启、崩溃、一次
   * 强制重铺）留下的孤儿排队行，会让这个席位从此永远自报忙，自动跟版一路 409，再也
   * 升不上去。真有活在跑时 running 一定 > 0，队列本来就顺带被盖住了。
   *
   * `queued` 照旧报出来：管家的日志里要说得出「等的是什么」，而且它是查上面那种孤儿
   * 行的唯一线索。
   *
   * 队列一条接一条跑的间隙不必担心：drainQueue 出队之后走的是 runGuarded，而它的第一
   * 句就是同步的 `starting.add`——中间只隔微任务，探活那个 HTTP 请求（宏任务）插不进去。
   */
  busy(): { running: number; queued: number } {
    const running = new Set([...this.live.keys(), ...this.starting]).size
    return { running, queued: this.queueCol().list().length }
  }

  // ── 排队 ──────────────────────────────────────────────────────────
  //
  // 带 `@` 的消息不走 steering：steering 是插进正在进行的这一轮，而那一轮的工具表
  // 早就定了——`@` 的全部意义恰恰是改工具表。两件事天生不兼容，所以它排队等下一轮。
  // 见 docs/connectors.md §7。

  private queueCol() {
    return this.ctx.storage.collection<QueuedMessage>('message-queue')
  }

  /**
   * 刚从队列里取出来、已经开跑的那几条 id。
   *
   * 有它，取消才分得清「这条不存在」和「这条已经开始执行了」——两者对用户是完全不同
   * 的消息，而出队之后行就没了，光看「找不到」是答不出来的。只留最近几十条：它唯一的
   * 用途是接住「点取消的同一刻正好被取出」这个窄窗口。
   */
  private startedIds: string[] = []

  private markStarted(id: string) {
    this.startedIds.push(id)
    if (this.startedIds.length > 50) this.startedIds.shift()
  }

  /**
   * 这一轮被 `@` 点名的连接 id。
   *
   * 工具执行时要回答「这一次调用是人点名的，还是模型自己挑的」——那是出事后第一个
   * 要问的问题，事后从会话正文里反推既慢又不一定对得上。只在这一轮里有效，轮末清掉。
   */
  private turnMentions = new Map<string, Set<string>>()

  mentionedIn(sessionId: string): Set<string> {
    const own = this.turnMentions.get(sessionId)
    if (own) return own
    /**
     * 子会话顺着往上问一层。
     *
     * 「@Gmail 帮我把这周的邮件整理成周报」正是最该被委派的一句话——点名不继承的话，
     * 那把连接对子代理**不存在**（mentionOnly 的连接平时不进默认表）。继承的作用和
     * 主代理那边一字不差：顶到表头 + 放开 mentionOnly。
     *
     * 生命周期天然对齐：turnMentions 本来就是**这一轮**的东西，而子代理整个活在这一
     * 轮里（委派是同步的，见 docs/delegation.md §11）。
     */
    const root = this.parents.get(sessionId)
    return (root ? this.turnMentions.get(root) : undefined) ?? new Set()
  }

  // ── 委派 ──────────────────────────────────────────────────────────
  //
  // 一次委派 = 主席位把一件事整个交给一个新开的、干净的它自己，它跑完只交回一段话。
  // 全部取舍见 docs/delegation.md。

  /**
   * 子会话 → 它的主会话。**只在内存里。**
   *
   * 落盘的那一份在子会话的根事件上（`parent.sessionId`），这里是它的索引——问它的地方
   * 都在热路径上（每一次工具调用要判 rebind、每一条后台进程结束要判往哪投），而那些地
   * 方读一遍整条会话是不能接受的。
   *
   * 进程重启后这张表是空的：子代理本来就不恢复（§10），而它留下的后台进程也一起没了
   * （procs 同样只在内存里）。所以「重启后 rootOf 查不到」不是缺陷，是没有东西要查。
   */
  private parents = new Map<string, string>()

  /**
   * 这条会话的主会话。**不是子会话就返回 undefined**，不是返回它自己——调用方靠这个
   * 区别决定要不要改道，回落成自己的话每一处都要再判一次「改没改」。
   */
  rootOf(sessionId: string): string | undefined {
    return this.parents.get(sessionId)
  }

  /**
   * 这条子会话是哪一条子任务。**给策略和审批用**：
   *
   *  - 审批卡片上要多一行「来自子任务《…》」。不写的话，人看到的是一次凭空出现的发信
   *    确认，而他刚才只说了一句「帮我把这周的活收个尾」
   *  - 独占资源（`leases`）的强制判定：工具表里没有它只是遮掩，模型硬报一个名字照样
   *    调得通，真正的拒绝要按这份租约来
   */
  private tasks = new Map<string, { taskId: string; goal: string; leases: string[] }>()

  taskOf(sessionId: string): { taskId: string; goal: string; leases: string[] } | undefined {
    return this.tasks.get(sessionId)
  }

  /**
   * 跑一条子任务，跑完把结论交回去。
   *
   * 和 `runTurn` 共用装配（提示词、工具表、模型、projector），但**刻意不共用的四件事**：
   *
   *  - **另一条会话**。子代理的过程一条都不进主会话——那正是委派的全部意义（§4）
   *  - **不压缩**。它活不过一轮，压缩是给长会话的
   *  - **不排队、不 drainQueue**。队列是主会话的东西，子会话上没有人在排
   *  - **有墙钟**。主轮真的 await 在这次调用上，人对着一个转圈的图标（§9）
   */
  async runTask(
    parentSessionId: string,
    callId: string,
    spec: TaskSpec,
    signal?: AbortSignal,
  ): Promise<TaskOutcome> {
    const { sessions, llm } = this.ctx
    const taskId = randomUUID()
    const startedAt = Date.now()
    /**
     * **进门先看信号。**
     *
     * 已经是 aborted 的信号**不会再发事件**，所以下面那个监听器挂上去也是死的。人按停止
     * 的那一刻，模型很可能刚发出这次 delegate_task——没有这一句，这一批会照样开出子会话、
     * 照样跑满 30 步，而屏幕上那颗停止按钮看起来毫无动静。
     *
     * 这里**什么都不建**：连子会话都不开，也就不写 agent/task。什么都没发生，界面上就
     * 不该多出一张卡。
     */
    if (signal?.aborted) {
      return abortedOutcome(spec, taskId, startedAt)
    }
    const history = await sessions.events(parentSessionId)
    const root = history.find((e) => e.type === 'session')?.data as
      | { botId?: string; agentId?: string; origin?: SessionOrigin; remoteId?: string }
      | undefined
    const bot = this.botOf(history)

    const child = await sessions.create({
      botId: root?.botId ?? root?.agentId ?? '',
      origin: root?.origin,
      remoteId: root?.remoteId,
      // 标题写清自己是什么：万一哪天回滚一版、过滤没了，它会出现在侧栏里（见
      // session/types.ts 的 kind）——那时至少读得懂。
      title: `子任务：${spec.goal.slice(0, 30)}`,
      kind: 'task',
      parent: { sessionId: parentSessionId, callId, taskId },
    })
    this.parents.set(child, parentSessionId)
    this.tasks.set(child, { taskId, goal: spec.goal, leases: spec.leases })

    const pinned = this.roleModel(spec.modelRole)
    // daily = 跟主代理这一轮同一个模型，也就是这条会话挑的那个（见 homeModelOf）。
    const home = await this.homeModelOf(parentSessionId, history)
    const provider = pinned?.provider ?? home.provider
    const modelId = pinned?.model ?? home.model
    const model = llm.modelOf(provider, modelId)
    const reasoningEffort = this.roleReasoningEffort(provider, modelId, spec.modelRole)
    const usedModel = {
      role: spec.modelRole,
      provider,
      id: modelId,
      ...(spec.modelReason ? { reason: spec.modelReason } : {}),
      // 平台没钉 utility 时 roleModel 会回落，那一档同样不是主代理选的——人要看得出来。
      ...(spec.downgraded || (spec.modelRole === 'utility' && !pinned) ? { downgraded: true } : {}),
    }

    await sessions.append(parentSessionId, 'agent/task', {
      id: taskId,
      callId,
      child,
      index: spec.index,
      goal: spec.goal,
      state: 'running',
      model: usedModel,
      startedAt,
      at: startedAt,
    })

    /**
     * 跑着的进度（docs/delegation.md §13「跑着的那几分钟」）。听子会话自己的事件、数出来，变了就在
     * 主会话上再写一条 running——界面按 id 取最后一条，卡上那行「正在：web_extract …」就是它。
     *
     * **限频**：一批三条并行、每条每步一两次工具调用，不限的话主会话 JSONL 会被这些行刷满。
     * **写入串成一条链**，终态那条等链排空再写：一条晚到的 running 盖在终态后面，卡片会永远转圈。
     */
    const tracker = new ProgressTracker()
    let progressChain: Promise<void> = Promise.resolve()
    let progressTimer: ReturnType<typeof setTimeout> | null = null
    let progressAt = 0
    let settled = false
    const writeProgress = () => {
      progressTimer = null
      if (settled) return
      progressAt = Date.now()
      const progress = tracker.snapshot()
      progressChain = progressChain
        .then(() =>
          sessions.append(parentSessionId, 'agent/task', {
            id: taskId,
            callId,
            child,
            index: spec.index,
            goal: spec.goal,
            state: 'running',
            steps: progress.steps,
            progress,
            model: usedModel,
            startedAt,
            at: Date.now(),
          }),
        )
        .then(
          () => {},
          () => {},
        )
    }
    const offProgress = this.ctx.on('session/event', (sessionId: string, event: { type?: string; data?: unknown }) => {
      if (sessionId !== child || settled || !tracker.feed(event)) return
      if (!progressTimer) progressTimer = setTimeout(writeProgress, Math.max(0, TASK_PROGRESS_MIN_MS - (Date.now() - progressAt)))
    })

    let steps = 0
    let toolCalls = 0
    let capped = false
    let state: TaskOutcome['state'] = 'done'
    let failure = ''
    /**
     * 从写下 running 到真正 `agent.prompt` 之间还有好几步会抛的：拼提示词、建工具表、
     * 写两条事件、建 agent。它们抛了的话，running 已经落在主会话上，而终态永远不会写
     * ——那张卡永远转圈，`delegate` 那边也拿不到 outcome。所以整段包进 try：抛在哪一步
     * 都记成 failed，往下照常走移交和写终态。turnStarted 记 turn/start 写没写，
     * 写了才补 turn/end。
     */
    let turnStarted = false
    try {
      const system = this.taskSystem(bot, spec)
      const toolSchemas = this.taskTools(bot, parentSessionId, spec)
      const brief = taskBrief(spec)

      await sessions.append(child, 'user/message', {
        message: { id: randomUUID(), role: 'user', content: [{ type: 'text', text: brief }] },
        source: { kind: 'plugin', plugin: 'delegate', taskId, parent: parentSessionId },
      })
      await sessions.append(child, 'turn/start', { turn: 1 })
      turnStarted = true

      const agent = new Agent({
        initialState: {
          systemPrompt: system.text,
          model,
          thinkingLevel: reasoningEffort,
          messages: [],
          tools: this.bridgeTools(child, this.forModel(toolSchemas, model), seesImages(model)),
        },
        streamFn: llm.streamFn,
        steeringMode: 'one-at-a-time',
        followUpMode: 'one-at-a-time',
        sessionId: child,
        // 子任务同样是一轮跑到底、中途没有压缩，见 contextGuardFor。
        transformContext: this.contextGuardFor(child, provider, modelId, model, system.text, this.forModel(toolSchemas, model), 0),
        shouldStopAfterTurn: ({ toolResults }: { toolResults: unknown[] }) => {
          if (!toolResults.length) return false
          steps += 1
          toolCalls += toolResults.length
          if (steps < spec.maxSteps) return false
          capped = true
          return true
        },
      } as any)

      this.live.set(child, agent)
      const off = agent.subscribe(this.projector(child, 1, this.turnMeta(provider, modelId, system, this.forModel(toolSchemas, model), reasoningEffort)))

      /**
       * 墙钟。Hermes 那边明确不设，我们必须设——他们的委派在后台，我们的主轮真的
       * `await` 在这次工具调用上（§9）。
       */
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        this.ctx.logger?.warn?.(`agents: 子任务 ${taskId} 超过 ${Math.round(spec.timeoutMs / 1000)} 秒，收口`)
        this.abort(child)
      }, spec.timeoutMs)
      /** 主轮被停 → 这一条也停。这条链子断在中间的表现就是「停止按钮点了没反应」。 */
      const onAbort = () => this.abort(child)
      signal?.addEventListener('abort', onAbort, { once: true })
      /**
       * 挂上之后**再看一次**。上面进门那一眼和这一行之间隔着读日志、建会话、写两条事件
       * ——全是真的磁盘 I/O，人按停止完全可能正落在这几十毫秒里，而那时监听器还没挂上。
       */
      if (signal?.aborted) this.abort(child)

      this.ctx.logger?.info?.(`agents: 子任务 ${taskId} 开跑（${provider}/${modelId}，最多 ${spec.maxSteps} 步）`)
      try {
        const now = Date.now()
        await agent.prompt(stampUser(brief, now))
        failure = this.aborting.has(child) ? '' : ((agent.state as any)?.errorMessage ?? '')
        if (failure) state = 'failed'
        else if (capped) state = 'capped'
      } catch (e) {
        if (this.aborting.has(child)) state = timedOut ? 'timeout' : 'aborted'
        else {
          state = 'failed'
          failure = (e as Error).message
        }
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        off()
        this.live.delete(child)
        if (this.aborting.delete(child)) state = timedOut ? 'timeout' : state === 'done' ? 'aborted' : state
        await this.settleShots(child)
        await sessions.append(child, 'turn/end', {
          turn: 1,
          reason: state === 'done' || state === 'capped' ? (capped ? 'capped' : 'completed') : state === 'failed' ? 'error' : 'aborted',
        })
      }
    } catch (e) {
      // 只有内层 try 之前那几步会走到这儿：内层自己收口了，不会再往外抛。
      state = 'failed'
      failure = (e as Error).message
      this.ctx.logger?.warn?.(`agents: 子任务 ${taskId} 没能开跑：${failure}`)
      this.live.delete(child)
      if (turnStarted) await sessions.append(child, 'turn/end', { turn: 1, reason: 'error' })
    }

    /**
     * 移交排在写终态**之前**：结论里要报出移交了什么，不报的话主代理不知道自己刚接手
     * 了什么，而它下一步很可能就要拿那个 id 去调 `process`（§7.3）。
     *
     * **被掐掉的那次也要移交**——那正是没人来得及收尾的一次。
     */
    const handedOver = await this.ctx.tools.reassign(child, parentSessionId)

    const events = await sessions.events(child)
    const summary = lastAssistantText(events)
    const files = taskFiles(events)
    const usage = sumUsage(events)
    if (state === 'done' && !summary) {
      // 撞顶时最后一步只有工具调用，一个字都没说。**编一段摘要出来是最糟的选项。**
      state = 'failed'
      failure = failure || '子任务跑完了但没有留下结论'
    }
    // 超时、被停也是「没做成」，原因要说出来；被停不算错，不写。
    if (state === 'timeout' && !failure) failure = `超过 ${Math.round(spec.timeoutMs / 1000)} 秒，收口了`
    const error = state === 'failed' || state === 'timeout' ? failure.slice(0, 1000) : ''

    const outcome: TaskOutcome = {
      index: spec.index,
      taskId,
      child,
      goal: spec.goal,
      state,
      summary: summary || '没有结论。',
      ...(error ? { error } : {}),
      files,
      steps,
      toolCalls,
      usage,
      model: usedModel,
      handedOver,
      ms: Date.now() - startedAt,
    }

    settled = true
    if (progressTimer) clearTimeout(progressTimer)
    offProgress()
    await progressChain
    await sessions.append(parentSessionId, 'agent/task', {
      id: taskId,
      callId,
      child,
      index: spec.index,
      goal: spec.goal,
      state,
      summary: outcome.summary,
      ...(error ? { error } : {}),
      ...(files.length ? { files } : {}),
      steps,
      toolCalls,
      usage,
      progress: tracker.snapshot(),
      model: usedModel,
      startedAt,
      at: Date.now(),
    })
    this.ctx.logger?.info?.(`agents: 子任务 ${taskId} 收口（${state}，${steps} 步，${outcome.ms}ms）`)
    /**
     * 两张表**过一会儿清掉**，不是留着。
     *
     * 一台席位能连着跑几周、委派几千次，而 `rootOf` 在每一次工具调用的热路径上——只进不
     * 出的话，那张表只会越查越长。
     *
     * 为什么不当场删：§7.3 那个窄窗口还要用它——子代理收口和后台进程移交之间，进程恰好
     * 在这几毫秒里结束，那条通知要靠 `rootOf` 才投得回主会话。留五分钟远远够，而 `unref`
     * 保证这个定时器不会拦着进程退出。
     */
    const forget = setTimeout(() => {
      this.parents.delete(child)
      this.tasks.delete(child)
    }, TASK_MEMO_TTL_MS)
    forget.unref?.()
    return outcome
  }

  /**
   * 子代理的系统提示词：在主代理那份上**减一段、加一段**。
   *
   * 减掉的是 escalateBlock——子代理没有那把工具，那段话是在教它用一把它没有的手
   * （条件加载原则，见 docs/context-assembly.md §2）。composeSystem 本来就按
   * `tools.has('escalate_to_human')` 判，而那个判断是**进程级**的：这颗席位上挂着它，
   * 于是子代理那份也会带上。所以这里显式切掉。
   */
  private taskSystem(
    bot: ReturnType<AgentService['botOf']>,
    spec: TaskSpec,
  ): { text: string; base: string; skills: string; memory: string } {
    // Skill 全文继承：它是「这家公司怎么做这件事」，缺了它子代理会用通用做法做完——
    // 结论看起来对、口径全错，而那比多花几千 token 贵。
    const composed = this.composeSystem({ ...(bot ?? {}), escalate: undefined })
    const base = `${composed.base}

${taskBlock(spec)}`
    /**
     * **记忆也整段继承，而且仍然排在最后。**
     *
     * 理由和上面那句 Skill 一字不差：它是「这个人是谁、这儿的口径是什么」，缺了它
     * 子代理会用通用做法做完。位置不能变——记忆是整份提示词里最常变的那一段，插到
     * 前面去就是每记一条把 Skill 正文的前缀缓存作废一次（docs/memory.md §7）。
     *
     * 这一段拼错了**不会报任何错**，只会安静地少一段：所以 composeSystem 的返回值
     * 是四段而不是把记忆混进 text——混进去的话这里从 base + skills 重拼，整段就没了。
     */
    const tail = [composed.skills, composed.memory].filter(Boolean).join('\n\n')
    return { text: tail ? `${base}

${tail}` : base, base, skills: composed.skills, memory: composed.memory }
  }

  /**
   * 子代理那张工具表。
   *
   * ```
   * 主代理这一轮的表（含 @ 点名的排序）
   *   − mode === 'root-only' 的
   *   − exclusive 资源没租到的
   *   − 调用方在 tools 参数里没点的
   * ```
   *
   * 这一层**只是遮掩**。真正的拒绝在 policy 的 pre-execute 短路上，判据同样是标注
   * （见 docs/delegation.md §6.1）。
   */
  private taskTools(
    bot: ReturnType<AgentService['botOf']>,
    parentSessionId: string,
    spec: TaskSpec,
  ) {
    const mentions: Mention[] = [...this.mentionedIn(parentSessionId)].map((id) => ({
      kind: 'connector' as const,
      id,
      label: id,
    }))
    return this.toolSchemasFor(bot, mentions).filter((t) => {
      const d = this.ctx.tools.delegationOf(t.name)
      if (d.mode === 'root-only') return false
      if (d.exclusive && !spec.leases.includes(d.exclusive)) return false
      if (spec.tools && !spec.tools.includes(t.name)) return false
      return true
    })
  }

  /**
   * 席位起来时，把上一条命留下的委派收口。
   *
   * 子代理不恢复（§10），所以主会话里最后停在 `running` 的那几条 `agent/task` 要补一条
   * `lost`。不补的话，界面上那张卡永远转着，而人唯一能做的是怀疑自己的浏览器。
   *
   * **`lost` 不是 `failed`。** 那件事做没做成，进程死的时候没人知道，事后也查不出来；
   * 写成失败是在编。
   */
  async healTasks(): Promise<void> {
    const { sessions } = this.ctx
    for (const row of await sessions.list()) {
      let events
      try {
        events = await sessions.events(row.id)
      } catch {
        continue
      }
      const last = new Map<string, SessionEventMap['agent/task']>()
      for (const e of events) {
        if (e.type === 'agent/task') last.set((e.data as SessionEventMap['agent/task']).id, e.data as SessionEventMap['agent/task'])
      }
      for (const t of last.values()) {
        if (t.state !== 'running') continue
        await sessions.append(row.id, 'agent/task', { ...t, state: 'lost', at: Date.now() })
        this.ctx.logger?.warn?.(`agents: 委派 ${t.id} 在上个进程里没收口，标为 lost`)
      }
    }
  }

  /** 这条会话排着的，按先来后到。`list()` 是按 updatedAt 倒序的，这里自己排。 */
  queued(sessionId: string): QueuedMessage[] {
    return this.queueCol()
      .list()
      .map((r) => r.value)
      .filter((v) => v.sessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** 队列里还压着消息的那几条会话。放开静默之后要挨个排空，见 resume。 */
  queuedSessions(): string[] {
    return [...new Set(this.queueCol().list().map((r) => r.value.sessionId))]
  }

  /**
   * 开机把上一条命留下的队列排掉。
   *
   * 队列是落盘的，可进程重启之后没有任何东西会来叫醒它：换版重启（最常见）之前排进来的那几条
   * 一直挂在 dock 上，要等人再发一条——而那一条会先跑，顺序也倒了。
   *
   * **等目录拉下来再排。** 刚起来时模型配置还没从 Gateway 拿到，这时开跑会以「没有模型」失败，
   * 而出队在开跑之前（见 drainQueue），那条消息就白白丢了。一直拉不到（没配 Gateway 的环境）
   * 就不排，留在队列里，人再发一条时照旧会带走。
   */
  async drainAtBoot(opts: { waitMs?: number; pollMs?: number } = {}): Promise<number> {
    /**
     * **排着的派活不接着跑。** 等它结论的那一方（机器上的工人 / 桌面端的本地派活）跟着上一条命的
     * 事件流一起断了，已经按失败报回主 Bot；这时再跑一遍，做出来的东西没人收，而人看到的是 Bot
     * 自己开始干一件早就作废的活。**先丢再等目录**：等的这段时间里人发一句，那一轮收口时就会排空队列。
     */
    for (const row of this.queueCol().list().map((r) => r.value)) {
      if (!isTaskInstruction(row.source)) continue
      this.queueCol().delete(row.id)
      this.emitQueue(row.sessionId)
      this.ctx.logger?.info?.(`agents: 丢掉上个进程里排着的派活 ${row.id}（会话 ${row.sessionId}）`)
    }
    const until = Date.now() + (opts.waitMs ?? 5 * 60_000)
    while (!this.ctx.catalog?.pulledAt) {
      if (Date.now() >= until) return 0
      // unref：没配 Gateway 的进程（探针、本地试跑）不能被这段等待拖着不退出。
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 1_000).unref?.())
    }
    const sessions = this.queuedSessions()
    for (const sessionId of sessions) {
      // 等目录的这段时间里人可能已经发了一条、开了一轮：那一轮收口时自己会排空，这里不另开。
      if (this.isRunning(sessionId)) continue
      void this.drainQueue(sessionId).catch((e) => {
        this.ctx.logger?.warn?.(`agents: 开机排空 ${sessionId} 失败：${(e as Error).message}`)
      })
    }
    if (sessions.length) this.ctx.logger?.info?.(`agents: 开机接着跑 ${sessions.length} 条会话里排着的消息`)
    return sessions.length
  }

  /** 队列深度上限。满了就明说，不静默丢——用户以为发出去了才是最糟的。 */
  get queueMax(): number {
    return Math.max(1, Math.trunc(Number(process.env.SATUWORK_QUEUE_MAX) || 5))
  }

  enqueue(
    sessionId: string,
    text: string,
    images: ImageRef[],
    mentions: Mention[],
    refs: RefBlock[] = [],
    source?: MessageSource,
    modelRole?: TurnModelRole,
  ): QueuedMessage {
    if (this.queued(sessionId).length >= this.queueMax) {
      throw new Error(`最多排 ${this.queueMax} 条，等这一轮跑完再发`)
    }
    const row: QueuedMessage = {
      id: randomUUID(),
      sessionId,
      text,
      images,
      mentions,
      ...(refs.length ? { refs } : {}),
      ...(source && source.kind !== 'user' ? { source } : {}),
      ...(modelRole ? { modelRole } : {}),
      createdAt: Date.now(),
    }
    this.queueCol().put(row.id, row)
    this.emitQueue(sessionId)
    return row
  }

  /**
   * 取消一条。
   *
   * 三种结果分开报：取消成功 / 已经开跑（409）/ 压根没这条（404）。合成一个 false
   * 的话，两个标签页各点一次取消时，后点的那个会看到「已经开始执行了」——而它其实
   * 早就被取消了，什么都没在跑。
   */
  cancelQueued(sessionId: string, id: string): 'cancelled' | 'started' | 'missing' {
    const row = this.queueCol().get(id)
    if (!row || row.sessionId !== sessionId) {
      return this.startedIds.includes(id) ? 'started' : 'missing'
    }
    const gone = this.queueCol().delete(id)
    if (!gone) return this.startedIds.includes(id) ? 'started' : 'missing'
    this.emitQueue(sessionId)
    return 'cancelled'
  }

  private emitQueue(sessionId: string) {
    this.ctx.emit('queue/change', sessionId, this.queued(sessionId))
  }

  /**
   * 这一轮跑完了，接上队首。
   *
   * **一条一条跑，不合并。** 它们是不同的指令，合并会让 `@` 的归属乱掉。
   * 整段不能抛：它跑在上一轮的收尾里，异常冒出去就是一个未处理的 Promise 拒绝。
   */
  private async drainQueue(sessionId: string): Promise<void> {
    for (;;) {
      // 静默期里不接着跑：那会开出新的一轮，排空就永远等不到空闲。**留在队列里**，
      // 和「进程在这一刻被杀掉」是同一个结局（队列本来就是落盘的）。
      if (this.quiesced()) return
      // 这条会话正在跑（resume 叫醒它的时候、或者别的 send 抢先开了一轮）：不另开一轮，
      // 那一轮收口时会自己来排空。并发两轮会交错写同一份 JSONL。
      if (this.isRunning(sessionId)) return
      const next = this.queued(sessionId)[0]
      if (!next) return
      // **先出队再跑。** 反过来的话，这一条要是每次都在同一处抛，队列就成了死循环。
      this.queueCol().delete(next.id)
      this.markStarted(next.id)
      this.emitQueue(sessionId)
      try {
        // **必须走 runGuarded。** 直接调 runTurn 的话，它走到 live.set 之前的那几个
        // await 期间既不在 live 也不在 starting 里，isRunning() 是 false——这时进来的
        // 消息会开出第二轮并发 turn，两轮交错写同一份 JSONL。
        await this.runGuarded(sessionId, next.text, next.images, next.mentions, next.source, next.modelRole, next.refs ?? [])
      } catch (e) {
        // **接着跑下一条，不是就此收工。** 一条失败就 return 的话，后面几条既不跑也不
        // 清，dock 上一直挂着，而没有任何东西会再来叫醒队列——只能等用户手动再发一条。
        // 这一条的失败已经由 runTurn 写进会话（failBeforeTurn / failAfterTurnStart）。
        this.ctx.logger?.warn?.(`agents: 排队消息 ${next.id} 跑失败，跳过：${(e as Error).message}`)
      }
    }
  }

  /**
   * 占住「这条会话正在跑」再跑一轮。
   *
   * `starting` 必须在**第一个 await 之前**同步占上：runTurn 要读日志、要重建历史，
   * 那几个 await 期间 agent 还没建出来，`live` 里没有它。少了这一层，同一条会话会被
   * 开出两个并发 agent——事件交错写进同一份 JSONL，用量也记两遍。
   */
  private async runGuarded(
    sessionId: string,
    text: string,
    images: ImageRef[],
    mentions: Mention[],
    source: MessageSource = { kind: 'user' },
    modelRole?: TurnModelRole,
    refs: RefBlock[] = [],
  ): Promise<void> {
    this.starting.add(sessionId)
    const stop = new AbortController()
    this.startingAbort.set(sessionId, stop)
    this.turnMentions.set(sessionId, new Set(mentions.filter((m) => m.kind === 'connector').map((m) => m.id)))
    // 派活那一轮动过的清单，收口时放回开跑之前的样子（见 restoreTodos）。
    const task = isTaskInstruction(source)
    const todosBefore = task ? readTodos(this.ctx, sessionId) : null
    if (task) this.taskTurns.add(sessionId)
    try {
      await this.runTurn(sessionId, text, images, mentions, source, modelRole, stop.signal, refs)
    } finally {
      if (todosBefore) {
        await restoreTodos(this.ctx, sessionId, todosBefore, `task:${String((source as { form?: unknown }).form ?? '')}`).catch((e) => {
          this.ctx.logger?.warn?.(`agents: 派活收口放回清单失败：${(e as Error).message}`)
        })
      }
      this.taskTurns.delete(sessionId)
      this.starting.delete(sessionId)
      if (this.startingAbort.get(sessionId) === stop) this.startingAbort.delete(sessionId)
      this.turnMentions.delete(sessionId)
    }
  }

  /**
   * 跑到一半插话。agent 不在跑时返回 false，由调用方决定改成普通消息。
   *
   * **读盘要排在取 agent 之前。** 带图时得先把字节读出来，而那是个 await；若先取
   * agent 再去读盘，这一轮完全可能在读盘期间跑完（runTurn 结束时会 `live.delete`），
   * 等回过神来投递，消息就交给了一个已经收口的 agent——安静地丢掉，而调用方那边
   * 早就回了「接住了」。先读后取，取和投递落在同一个 tick 里，这个窗口就不存在：
   * 轮次结束了就是 `live.get` 拿不到，如实返回 false，调用方改走 send 开新一轮。
   */
  async steer(
    sessionId: string,
    text: string,
    images: ImageRef[] = [],
    source: MessageSource = { kind: 'user' },
    refs: RefBlock[] = [],
  ): Promise<boolean> {
    // 先探一下，省得为一个根本没在跑的会话白读一遍图。
    if (!this.live.has(sessionId)) return false
    // 带引用的要读一遍日志：被引用的回复全文从那里来（见 refTextOf）。和读图一样，
    // 排在取 agent 之前。
    const content =
      images.length || refs.length
        ? await userContentFor(
            { id: '', role: 'user', content: userBlocks(text, images, [], refs) },
            this.ctx,
            undefined,
            refs.length ? await this.ctx.sessions.events(sessionId) : undefined,
          )
        : text
    const agent = this.live.get(sessionId)
    if (!agent) return false
    const at = Date.now()
    agent.steer({ role: 'user', content: stampContent(content, at), timestamp: at } as AgentMessage)
    /**
     * **插话也要落一条 `user/message`。**
     *
     * 这句话已经进了模型的消息列表，可它以前一个事件都不写——于是下一轮
     * `toAgentMessages` 从日志重建历史时它就不存在了。后果最重的是转人工：人把结果
     * 交还回来正好赶上 Bot 在跑，那段话走的就是这条插话路，进了当前这一轮之后从所有
     * 后续上下文里消失，模型过一会儿会把人已经做完的事再做一遍；界面刷新之后那句交还
     * 也不见了。docs/context-assembly.md §8-⑤ 把它记成已知缺口，这里把它补上。
     *
     * 写在 agent.steer 之后：先保证这一轮真的收到了话，再落账；反过来的话，steer 抛了
     * 会留下一条「说过但没人听见」的记录。
     */
    await this.ctx.sessions.append(sessionId, 'user/message', {
      message: { id: randomUUID(), role: 'user', content: userBlocks(text, images, [], refs) },
      source,
    })
    return true
  }

  /**
   * 记住「这条会话是被人喊停的」。
   *
   * 不靠 agent.signal 判断：那个信号在一轮结束后就没了，而这里要在 finally 里回答
   * 「刚才那一轮是跑完的还是被掐的」。turn/end 的 reason 原来永远写 completed——
   * 连被中止的那一轮也是，于是日志里根本看不出人按过停止。
   */
  private aborting = new Set<string>()

  abort(sessionId: string): boolean {
    const agent = this.live.get(sessionId)
    if (agent) {
      this.aborting.add(sessionId)
      agent.abort()
      return true
    }
    // 还在开轮：agent 没建出来，掐的是 runTurn 手上那个信号（见 startingAbort）。
    const pending = this.startingAbort.get(sessionId)
    if (!pending || pending.signal.aborted) return false
    this.aborting.add(sessionId)
    pending.abort()
    return true
  }

  /* ── 人手改上下文边界（/compact、/new）─────────────────────────────────
   *
   * 两条都是**控制指令，不是消息**：不进 user/message，不占 token，不开新的一轮，
   * 模型看不见它们。走这两个方法，各落各的会话事件，界面上画成一条分割线。
   * 设计取舍见 docs/chat-commands.md，边界本身的语义见 docs/context-assembly.md。
   *
   * **正在跑的时候两条都拒。** 压缩要读全量历史挑边界，而这一轮的事件还在往里写；
   * 重置会把边界打进一个没收口的轮次里（切在轮中间 → 无主的 tool/result → provider
   * 拒收整个请求）。而且人在一轮跑到一半时打 /new，真实意图基本是「停下来重开」——
   * 那是两个动作，该由人各做一次，不该由命令替他猜。
   */

  /** 现在就压一次。keepBudget 0 = 只留最后一整轮，理由见 compactOnce。 */
  async compactNow(sessionId: string): Promise<CompactOutcome> {
    if (this.isRunning(sessionId)) throw new CommandError('这一轮还在跑，等它跑完再压', 409)
    // 静默期里拒：它要跑一次模型，而这个进程马上就要被换掉，换来的多半是一次半路夭折。
    if (this.quiesced()) throw new CommandError(QUIET_MESSAGE, 409)

    const events = await this.ctx.sessions.events(sessionId)
    // 按这条会话挑的那个模型压：窗口和写摘要的都是它，和轮末自动压缩同一个口径。
    const { provider, model: modelId } = await this.homeModelOf(sessionId, events)
    const out = await this.maybeCompact(sessionId, provider, modelId, true, { keepBudget: 0, by: 'user' })
    if (out.compacted) return out
    // **压不动要说人话**，不能静默返回——人点了一下，界面上必须有个交代。
    if (out.reason === 'no-cut') throw new CommandError('这条对话还太短，没有可压的历史', 409)
    if (out.reason === 'no-summary') throw new CommandError('摘要没写成，上下文原样没动，过一会儿再试', 502)
    if (out.reason === 'superseded') throw new CommandError('压缩期间这条对话被 /new 重置了，这次压缩没有写下', 409)
    /**
     * 走到这儿说明 compactOnce 返回了一种这里还不认识的「没压成」。**也要抛**——
     * 返回一个 compacted:false 给调用方，换来的是界面弹一句「已压缩：0 → 0」而实际
     * 什么都没发生（路由那头照着 CompactOutcome 写响应）。将来加新的 reason 时，
     * 这一行保证它至少是个明说的失败，不是一句假的成功。
     */
    throw new CommandError(`压缩没能完成（${out.reason ?? '未知原因'}），上下文原样没动`, 500)
  }

  /**
   * 打一个上下文重置点。不跑模型，一次 append 就完。
   *
   * **日志一条不删**（不变量见 docs/context-assembly.md §9）：往上翻看得见，导出带得走。
   * 清掉的是「下一轮请求里带什么」，以及模型 history_read / history_search 的翻阅范围——
   * 翻历史工具止于最近一次重置点（replay.ts 的 historyEvents），否则人打的 `/new` 被模型
   * 一句搜索就绕过去了。
   */
  async resetContext(
    sessionId: string,
    opts: { clear?: boolean } = {},
  ): Promise<{ throughSeq: number; droppedMessages: number }> {
    /**
     * `clear` = 人打的是 `/clear`：上下文这一侧和 `/new` 一模一样，只在事件上多记一个
     * 标记，界面据此把之前的藏起来（replay.ts 的 visibleEvents；翻历史工具两条命令都切，
     * 不看这个标记）。所以下面每一道闸都照走，只有措辞和幂等那一条要分开说。
     */
    const clear = Boolean(opts.clear)
    if (this.isRunning(sessionId)) throw new CommandError('这一轮还在跑，先停下或等它跑完', 409)
    // 同步记一笔，排在任何 await 之前：在飞的压缩写回前会看到它、作废自己（见 resets）。
    this.resets.set(sessionId, (this.resets.get(sessionId) ?? 0) + 1)
    /**
     * 队里还排着的消息也要拦。
     *
     * 那些消息是冲着**旧上下文**发的（带 `@` 的才会入队，见 web/index.ts 那张三岔表），
     * 留到边界之后再执行，等于人以为清空了、Bot 却在接着回答几分钟前的事。
     */
    const queued = this.queued(sessionId).length
    if (queued) throw new CommandError(`还有 ${queued} 条消息排着队，先取消它们再${clear ? '清空' : '开新对话'}`, 409)
    /**
     * **还开着的转人工工单是同一类东西，但那道闸在路由那边**（见 web/index.ts 的
     * `/reset`）。
     *
     * 理由和上面这条一模一样：交接单也会在重置之后自动开出新的一轮——人点「交还」时
     * deliver 走 `agents.send(...)` 把结果送进会话，而那时上下文已经空了。
     *
     * 之所以不摆在这儿：这个服务的 inject 里没有 `handoffs`，加进去会把依赖链拉长到
     * 所有只搭一半应用的探针上（e2e-turn-images、e2e-mentions 那几个不装 handoff 插件，
     * agents 就永远不就绪）。而 web 那边本来就 inject 了它，那里也正是唯一的调用点。
     */

    const events = await this.ctx.sessions.events(sessionId)
    /**
     * **切在最后一条 turn/end 上，不是最后一条事件上。**
     *
     * 绝大多数时候两者之间没有东西（这个方法只在没在跑时才走到这儿）。但进程崩过的
     * 会话里存在一个永远不会有 turn/end 的残缺轮次——切在它后面，边界就落在了一轮
     * 中间，下一轮请求的开头会是一条无主的 tool/result。切在这里，那个残缺轮次留在
     * 边界之后，它本来就该被下一轮看见。
     */
    const lastEnd = [...events].reverse().find((e) => e.type === 'turn/end')
    if (!lastEnd) {
      throw new CommandError(clear ? '这条会话还没有对话记录，没有要清的' : '这条会话还没跑成过一轮，没有要清的上下文', 409)
    }

    const prior = contextBoundary(events)
    /**
     * 已经切在这儿了。再打一条只会在对话里叠出两条紧挨着的分割线，而什么都没发生。
     *
     * 唯一放行的是「`/new` 之后紧接着 `/clear`」：上下文早就空了，但人这次要的是连记录
     * 一起藏起来——那一半还没做过。反过来 `/clear` 之后再 `/new` 照样拦。
     */
    const priorCleared = prior?.type === 'session/reset' && Boolean(prior.data.clear)
    if (prior && prior.data.throughSeq >= lastEnd.seq && (!clear || priorCleared)) {
      throw new CommandError(clear && priorCleared ? '已经清空过了，没有新的记录' : '这里已经是新对话的开头了', 409)
    }

    const scope = prior ? events.filter((e) => e.seq > prior.data.throughSeq) : events
    const dropped = scope.filter((e) => e.seq <= lastEnd.seq)
    const data: SessionEventMap['session/reset'] = {
      throughSeq: lastEnd.seq,
      from: dropped[0]?.time ?? lastEnd.time,
      to: lastEnd.time,
      // 只数进得了上下文的那几种。不走 toAgentMessages：那要读图、转 base64，
      // 而这里要的只是分割线上那个「切掉了多少条」。
      droppedMessages: dropped.filter(
        (e) => e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'tool/result',
      ).length,
      by: 'user',
      ...(clear ? { clear: true } : {}),
    }
    await this.ctx.sessions.append(sessionId, 'session/reset', data)
    this.ctx.logger?.info?.(
      `agents: ${sessionId} ${clear ? '清空记录' : '上下文重置'}到 seq ${lastEnd.seq}，切掉 ${data.droppedMessages} 条消息`,
    )
    return { throughSeq: data.throughSeq, droppedMessages: data.droppedMessages }
  }

  /**
   * 开新的一轮。
   *
   * `source` 说的是**这条消息是谁发的**：人自己打的是 `user`，转人工交还那一条是
   * `plugin: 'handoff'`（见 policy/handoff.ts）。它进日志、进链路视图，让「人做完交回来」
   * 和「人自己又说了一句」在事后分得开——两者对模型的意思完全不同。
   */
  async send(
    sessionId: string,
    text: string,
    images: ImageRef[] = [],
    mentions: Mention[] = [],
    source: MessageSource = { kind: 'user' },
    modelRole?: TurnModelRole,
    refs: RefBlock[] = [],
  ): Promise<void> {
    /**
     * 静默期里不开新的一轮（见上面那段）。
     *
     * **这一道要在这里，而不是只在 HTTP 那一层**：日常任务（routines）、转人工交还回来
     * 的那一条，都是从这里进来的；只挡路由的话，一条正好踩在换版上的定时任务照样会开出
     * 一轮，然后被重启砍断。
     */
    if (this.quiesced()) {
      throw new Error(QUIET_MESSAGE)
    }
    if (this.isRunning(sessionId)) {
      // 这条以前是静默的，而它意味着**用户那句话被丢掉了**——steer 没接住、send 又
      // 拒收。界面上什么都看不出来，日志里也没有。
      this.ctx.logger?.warn?.(`agents: 会话 ${sessionId} 已在运行，这条消息没能进去`)
      throw new Error('agents: 该会话正在运行中')
    }
    // 同步占位（runGuarded 的第一行），之后才允许出现 await。
    /**
     * **这一轮抛了也要去排空队列。**
     *
     * runGuarded 在真正开轮之前那几步（botOf / modelOf / toAgentMessages 重建历史）
     * 是会抛出来的。原先 drainQueue 排在它后面直写，于是那种失败会把排在后面的消息
     * 一起晾在那儿：队列是落盘的，没有开机排空、也没有定时器，只有下一次**成功**的
     * send 才会顺手带走它们——而那时新消息已经先跑了，顺序也倒了。
     */
    try {
      await this.runGuarded(sessionId, text, images, mentions, source, modelRole, refs)
    } finally {
      // 这一轮收口了（无论成败），接上排在后面的。
      await this.drainQueue(sessionId).catch((e) => {
        this.ctx.logger?.warn?.(`agents: 排空队列失败：${(e as Error).message}`)
      })
    }
  }

  /**
   * turn/start 已经写下了才挂：补一条「出错了」再收口。
   *
   * 少了这一对，日志里留下的是一个永不结束的轮次——界面上那一轮一直转着，链路视图里
   * 是一段空白，而进程这边其实早就放弃了。
   */
  private async failAfterTurnStart(sessionId: string, turn: number, e: Error): Promise<void> {
    const { sessions } = this.ctx
    await sessions.append(sessionId, 'assistant/message', {
      turn,
      step: 0,
      message: {
        id: randomUUID(),
        role: 'assistant',
        content: [{ type: 'text', text: `出错了：${e.message}` }],
      },
      usage: EMPTY_USAGE,
    })
    await sessions.append(sessionId, 'turn/end', { turn, reason: 'error' })
  }

  /**
   * 这一轮还什么都没落盘就挂了：把用户那句话补进日志，再按上面那条收口。
   *
   * 不补的话，用户的消息只存在于那次 HTTP 请求里——而请求早就回了 accepted:true。
   * 界面上是一片空白，日志里什么都没有，事后连「他到底发没发」都查不出来。
   */
  private async failBeforeTurn(
    sessionId: string,
    history: Awaited<ReturnType<Context['sessions']['events']>>,
    text: string,
    images: ImageRef[],
    e: Error,
    mentions: Mention[] = [],
    source: MessageSource = { kind: 'user' },
    refs: RefBlock[] = [],
  ): Promise<void> {
    const { sessions } = this.ctx
    const turn = history.filter((ev) => ev.type === 'turn/start').length + 1
    await sessions.append(sessionId, 'user/message', {
      message: { id: randomUUID(), role: 'user', content: userBlocks(text, images, mentions, refs) },
      source,
    })
    await sessions.append(sessionId, 'turn/start', { turn })
    await this.failAfterTurnStart(sessionId, turn, e)
  }

  private async runTurn(
    sessionId: string,
    text: string,
    images: ImageRef[] = [],
    mentions: Mention[] = [],
    source: MessageSource = { kind: 'user' },
    modelRole?: TurnModelRole,
    signal?: AbortSignal,
    refs: RefBlock[] = [],
  ): Promise<void> {
    const { sessions, llm } = this.ctx
    let history = await sessions.events(sessionId)
    /**
     * 进 live 之前被喊停了：把这句话落下、这一轮以 aborted 收口，不再往下跑。
     *
     * 照 failBeforeTurn 的样子补齐 user/message + turn/start——HTTP 早就回了
     * accepted:true，一个字不留的话界面上这句话就凭空没了。
     */
    const stoppedBeforeTurn = async () => {
      if (!signal?.aborted) return false
      const turn = history.filter((e) => e.type === 'turn/start').length + 1
      await sessions.append(sessionId, 'user/message', {
        message: { id: randomUUID(), role: 'user', content: userBlocks(text, images, mentions, refs) },
        source,
      })
      await sessions.append(sessionId, 'turn/start', { turn })
      this.aborting.delete(sessionId)
      await sessions.append(sessionId, 'turn/end', { turn, reason: 'aborted' })
      this.ctx.logger?.info?.(`agents: 会话 ${sessionId} 第 ${turn} 轮还没开跑就被停下`)
      return true
    }
    if (await stoppedBeforeTurn()) return
    let system: { text: string; base: string; skills: string; memory: string }
    let provider: string
    let modelId: string
    let model: ReturnType<typeof llm.modelOf>
    /**
     * **这颗 Bot 自己那一对**，也就是「人和它聊天时用的那个模型」。
     *
     * 和上面那三个分开留着，是因为**上下文压缩一律按它算**（见下面 hard 那一段）：
     * 这一轮可能被钉到 utility 上，而压缩改的是这条会话本身，那条会话是人和定时任务
     * 共用的一条（一个 Bot 一条，见 registry 的 ensureSession）。
     */
    let homeProvider: string
    let homeModel: string
    /** 这一轮真的钉上了吗。装不下的时候要拿它退回去（见下面那道「装不装得下」）。 */
    let pinned: { provider: string; model: string } | null = null
    let toolSchemas: { name: string; description: string; parameters?: unknown }[]
    try {
      const bot = this.botOf(history)
      system = this.composeSystem(bot)
      // 人在对话框里给这条会话换过日常模型的话，「Bot 自己那一对」就是换过之后的那个。
      const home = await this.homeModelOf(sessionId, history, true)
      provider = home.provider
      modelId = home.model
      homeProvider = provider
      homeModel = modelId
      // 这一轮被钉到某个平台角色上（日常任务选了 utility）就换掉上面那一对。
      pinned = this.roleModel(modelRole)
      if (pinned) {
        provider = pinned.provider
        modelId = pinned.model
        await llm.ensureKnown([pinned])
      }
      model = llm.modelOf(provider, modelId)
      toolSchemas = this.toolSchemasFor(bot, mentions)
      /**
       * 点名了、工具却不在表里：**先重拉一次目录再说**。
       *
       * 最常见的一种是「刚连上就来用」——连接是几十秒前在浏览器里授权的，而席位是
       * 一分钟探一次（catalog.poll）。等下一轮探针的话，用户得到的是一句「我没有邮件
       * 工具」，然后他会以为授权失败了，回去把连接重做一遍。
       *
       * 只在有点名、且确实缺工具时才拉：这是一次额外的往返，不该摊到每一轮上。
       * 拉失败也不能连累这一轮——下面那段话照样把实情说清楚。
       */
      if (this.mentionGaps(mentions).length) {
        try {
          await untilAborted(this.ctx.catalog.pull(), signal)
        } catch (e) {
          this.ctx.logger?.warn?.(`agents: 为点名重拉目录失败 ${(e as Error).message}`)
        }
        toolSchemas = this.toolSchemasFor(this.botOf(history), mentions)
      }
      const gaps = this.mentionGaps(mentions)
      if (gaps.length) {
        // **这一行要显眼**：它说的是「有人点名了一把连接，而这台席位根本没挂上它」。
        this.ctx.logger?.warn?.(`agents: 点名的连接没有可用工具：${gaps.map((m) => m.label).join('、')}`)
        system = { ...system, text: `${system.text}\n\n${mentionGapBlock(gaps)}` }
      }
      // @ 了别的 Bot：这一轮要派活（docs/bot-tasks.md §5）。不是主 Bot 的话也要说清楚，别让它自己替人家做。
      const named = mentions.filter((m) => m.kind === 'bot')
      if (named.length) {
        system = { ...system, text: `${system.text}\n\n${mentionBotBlock(named, toolSchemas.some((t) => t.name === 'assign_task'))}` }
      }
      // 「用户引用的东西」那一段只在这一轮真带了引用时才加（条件加载，理由同 fileOutBlock）。
      if (refs.length) system = { ...system, text: `${system.text}\n\n${refBlock()}` }
    } catch (e) {
      await this.failBeforeTurn(sessionId, history, text, images, e as Error, mentions, source, refs)
      throw e
    }
    if (await stoppedBeforeTurn()) return

    // 兜底：轮末那次压缩可能失败了、也可能上个进程根本没跑到那一步。已经顶到硬顶
    // 还往上游发，换来的是一个 400，用户看到的是「出错了」。宁可这一轮多等几秒。
    //
    // **这一整段都不能连累这一轮**，判断条件也算在内。此刻 user/message 和 turn/start
    // 都还没落盘：异常从这里穿出去，用户那句话就既不在日志里、也不在 SSE 上，界面什么
    // 都不显示——而 HTTP 早就回了 accepted:true。
    //
    // 以前 try 只圈住了 maybeCompact，条件里那次 `await toAgentMessages` 露在外面。
    // 它不是纯计算：要读图、要碰 ctx.workspace。workspace 一度没进这个插件的 inject，
    // 于是**一条会话只要带过一次图，之后每条消息都在这一行静默消失**——注释写着「压缩
    // 失败不能连累这一轮」，实际连累的恰恰是这一行。inject 已经补上，这个 try 是它的
    // 第二道保险：估算上下文长度是优化，不是正确性的一部分，失败了就带着原上下文往下走。
    /**
     * **窗口按 Bot 自己那个模型算，不按这一轮钉的那个。**
     *
     * 压缩不是这一轮的私事：它把旧的那段换成摘要，**写进会话日志**，从此人和它聊天
     * 时看到的也是那份摘要。而这条会话是共用的一条。按钉上的模型算的话，一条选了
     * utility 的日常任务，会拿那个便宜模型的小窗口去压人的聊天记录——人什么都没做，
     * 第二天回来上下文就没了，摘要还是那个便宜模型写的。
     *
     * 钉的模型自己装不装得下，是另一件事，在下面单独判：那一头的答案是**退回 Bot
     * 自己的模型跑这一轮**，不是把会话压到它的尺寸。
     */
    const hard = this.compactWindowOf(homeProvider, homeModel) * (this.config.compactHard ?? 0.9)
    try {
      if (estMessages(await toAgentMessages(history, model, this.ctx)) > hard) {
        this.ctx.logger?.warn?.(`agents: ${sessionId} 已顶到上下文硬顶，先同步压一次`)
        // 喊停了就不等它：压缩在后台照样跑完落盘（它有自己的锁），这一轮先走。
        await untilAborted(this.maybeCompact(sessionId, homeProvider, homeModel, true, { atLeast: hard }), signal)
        /**
         * **压没压都要重读**，不能只在 compacted 时重读。
         *
         * 上面那个估算用的是 runTurn 开头读的那份 history。轮末那次自动压缩完全可能
         * 就在这几百毫秒里落地——那时 maybeCompact 会看在眼里（atLeast）并如实返回
         * 「不用压了」，而手上这份 history 里**还没有那条压缩事件**：只按 compacted
         * 判的话，这一轮照样把压缩前的全量历史发出去，硬顶这道闸等于没落。
         *
         * 重读是内存里的一次 slice（sessions.events 返回 state.events.slice()），不值钱。
         */
        history = await sessions.events(sessionId)
      }
    } catch (e) {
      this.ctx.logger?.warn?.(`agents: ${sessionId} 硬顶检查/同步压缩失败，带原上下文继续：${(e as Error).message}`)
    }

    /**
     * 钉的那个模型**装不下这条会话**：这一轮退回 Bot 自己的模型。
     *
     * 上面那道硬顶按 Bot 自己的窗口算，所以走到这里时，会话完全可能仍然比 utility 的
     * 窗口大（便宜的那一档窗口小得多，这正是它便宜的一部分）。剩下的三条路里只有这条
     * 站得住：
     *
     * · 照发 —— 被 provider 以超长顶回来，那条日常任务从此每天记一条 error；
     * · 压到它的尺寸 —— 就是上面那段说的，拿便宜模型的小窗口削人的聊天记录；
     * · 退回去 —— 这一轮贵一点，但它跑成了，而且人的上下文一个字没动。
     *
     * 和「平台没配 utility 就照旧跑」是同一句话：**省钱是这个开关的目的，不是它的
     * 前提**（见 roleModel、docs/routines.md §4）。日志要留一行，否则「这条任务怎么
     * 没省下钱」查无可查。
     *
     * 估算失败不能连累这一轮，同上面那道硬顶——真出不来就照钉的跑，最坏是被顶回来
     * 记一条 error，而不是这句话根本没送进去。
     */
    if (pinned) {
      try {
        const room = (this.windowOf(pinned.provider, pinned.model) ?? this.config.contextWindowFallback ?? 128_000) *
          (this.config.compactHard ?? 0.9)
        if (estMessages(await toAgentMessages(history, model, this.ctx)) > room) {
          this.ctx.logger?.warn?.(
            `agents: ${sessionId} 这条会话装不进 ${pinned.provider}/${pinned.model} 的窗口，这一轮退回 ${homeProvider}/${homeModel}`,
          )
          provider = homeProvider
          modelId = homeModel
          model = llm.modelOf(provider, modelId)
        }
      } catch (e) {
        this.ctx.logger?.warn?.(`agents: ${sessionId} 算不出钉的模型装不装得下，照钉的跑：${(e as Error).message}`)
      }
    }

    if (await stoppedBeforeTurn()) return
    const turn = history.filter((e) => e.type === 'turn/start').length + 1
    const reasoningEffort = this.roleReasoningEffort(provider, modelId, modelRole)

    await sessions.append(sessionId, 'user/message', {
      message: { id: randomUUID(), role: 'user', content: userBlocks(text, images, mentions, refs) },
      source,
    })
    await sessions.append(sessionId, 'turn/start', { turn })

    // 重建历史从 new Agent 的参数位上抽了出来，但**仍然排在上面两次 append 之后**。
    //
    // 抽出来是因为它会抛（要读图、要碰 ctx.workspace），留在参数位上一抛就是
    // turn/start 已经写下、turn/end 永远不来——日志里一个永不收口的轮次，界面上那一轮
    // 一直转着。现在失败走 failAfterTurnStart，补一条「出错了」再收口。
    //
    // 不再往前挪是因为它**慢**：最多 4 张（MAX_LIVE_IMAGES）× 3.5 MB（MAX_IMAGE_BYTES）
    // 的读盘加 base64。排在 append 前面的话，进程要是在这段窗口里硬死（OOM、systemd
    // 重启、SIGKILL），用户那句话就一个字都没留下。先落盘，慢活儿在后面。
    //
    // history 是 append 之前的快照（sessions.events() 返回 state.events.slice()），
    // 所以这两次 append 不会进 messages——这一轮的消息是靠下面 prompt() 送进去的。
    let messages: AgentMessage[]
    try {
      messages = await toAgentMessages(history, model, this.ctx)
    } catch (e) {
      await this.failAfterTurnStart(sessionId, turn, e as Error)
      throw e
    }
    /**
     * 最后一道：重建历史（读图）期间被喊停。从这里到 `live.set` 之间**没有 await**，
     * 之后再按停止走的就是 live 那条路了——中间不会有一个两边都接不住的空档。
     */
    if (signal?.aborted) {
      this.aborting.delete(sessionId)
      await sessions.append(sessionId, 'turn/end', { turn, reason: 'aborted' })
      return
    }

    // 跑飞的刹车。**数的是带工具调用的步**：模型不再要工具的那一步，循环本来就要退出，
    // 算进去的话每一轮正常结束都要白记一笔，硬顶就成了「一轮最多说 N 句话」。
    //
    // 这一轮开始时读一次就定住，中途不再看设置库：界面上把上限改小，不该把正跑着的
    // 这一轮就地掐了。
    const maxSteps = this.maxSteps
    let steps = 0
    let toolCalls = 0
    let capped = false

    const agent = new Agent({
      initialState: {
        systemPrompt: system.text,
        model,
        thinkingLevel: reasoningEffort,
        messages,
        tools: this.bridgeTools(sessionId, this.forModel(toolSchemas, model), seesImages(model)),
      },
      streamFn: llm.streamFn,
      steeringMode: 'one-at-a-time',
      followUpMode: 'one-at-a-time',
      sessionId,
      // 轮内护栏：一轮之内工具结果越堆越多、逼近窗口时，把早先的大块结果在送出去的那份里
      // 换成占位。轮首的硬顶和轮末的压缩都管不到一轮中间，见 context-guard.ts。
      //
      // base 是 messages.length：这一轮的用户消息由 prompt() 推进去，正好落在这个下标，
      // 之前那些助手消息上的 usage 属于更早的轮次（可能在压缩之前），不能拿来当实测。
      //
      // prior：上一轮撞了窗口的会话，这一轮第一次调用时本地估算可能远低于实际，拿 provider
      // 最近一次回报的输入兜底。history 在轮首硬顶那里压过的话已经重读，边界之前的不算。
      transformContext: this.contextGuardFor(sessionId, provider, modelId, model, system.text, this.forModel(toolSchemas, model), messages.length, observedPromptTokens(history)),
      // pi 唯一的刹车口。返回 true 它就发 agent_end 收工——干净退出，不是抛异常，
      // 所以 tool/result 那些事件都已经落盘，历史是完整的。
      shouldStopAfterTurn: ({ toolResults }: { toolResults: unknown[] }) => {
        if (!toolResults.length) return false
        steps += 1
        toolCalls += toolResults.length
        if (steps < maxSteps) return false
        capped = true
        return true
      },
    } as any)

    this.live.set(sessionId, agent)
    // 进了 live 就不再归开轮那个开关管。留着的话，收尾那几个 await 期间按停止会掐到它、
    // 往 aborting 里留一笔，下一轮收口时被错认成「被喊停了」。
    this.startingAbort.delete(sessionId)
    const off = agent.subscribe(this.projector(sessionId, turn, this.turnMeta(provider, modelId, system, this.forModel(toolSchemas, model), reasoningEffort)))

    let reason: 'completed' | 'error' | 'aborted' | 'capped' = 'completed'
    const startedAt = Date.now()
    this.ctx.logger?.info?.(`agents: 会话 ${sessionId} 第 ${turn} 轮开始（${provider}/${modelId}）`)
    try {
      // 盖时间的是**送进模型的那份**，不是落盘的那份：日志里存原文，信封上已经有 time。
      //
      // **这一轮的图片必须从这里进去。** 上面那份 `messages` 是从 `history` 重建的，
      // 而 `history` 是在 append 这条用户消息**之前**取的快照（sessions.events() 返回
      // 的是 state.events.slice()），所以这一轮的消息根本不在里面——它是靠这行
      // prompt() 送进去的。只传文本的话，图就要等到下一轮重建历史时才被读出来，
      // 表现成「问第一遍它没看见，再问一句就看见了」。
      const now = Date.now()
      if (images.length || mentions.length || refs.length) {
        // 走 userContentFor 而不是自己拼：base64 缓存、单张大小上限、读不到时降级成
        // 一句说明，这些都在那儿，重写一遍迟早会漂。时间戳也复用 stampContent，
        // 跟 steer 那条路盖成同一个形状。
        //
        // **点名也走这条**：它要被渲染成一行 `[本轮指定：…]` 送进模型（textFrom 干的
        // 活）。只有纯文本才走下面那条快路——那条直接拿 text，看不见任何块。
        //
        // **引用也走这条**，而且要把 `history` 递进去：被引用的回复全文按 seq 从那里读。
        // history 是 append 这条用户消息之前的快照，而引用只会指向更早的消息，够用。
        const content = await userContentFor(
          { id: '', role: 'user', content: userBlocks(text, images, mentions, refs) },
          this.ctx,
          undefined,
          refs.length ? history : undefined,
        )
        await agent.prompt({ role: 'user', content: stampContent(content, now), timestamp: now } as AgentMessage)
      } else {
        await agent.prompt(stampUser(text, now))
      }
      // pi-agent **不抛**模型侧错误，它落在 state.errorMessage / 最终消息的
      // stopReason 上。不显式检查的话，一个失败的 turn 会被记成 completed，
      // 而对话里只剩一条空的助手消息。
      const failure = this.aborting.has(sessionId) ? '' : (agent.state as any)?.errorMessage
      if (failure) {
        reason = 'error'
        await sessions.append(sessionId, 'assistant/message', {
          turn,
          step: 0,
          message: {
            id: randomUUID(),
            role: 'assistant',
            content: [{ type: 'text', text: `模型调用失败：${failure}` }],
          },
          usage: EMPTY_USAGE,
        })
      }
      // 撞顶要在对话里**看得见**。只写日志的话，用户看到的是它干着干着突然不说话了，
      // 跟卡住分不出来；而它其实停得好好的，接着说一句就能继续。
      if (capped && !failure) {
        reason = 'capped'
        await sessions.append(sessionId, 'assistant/message', {
          turn,
          step: 0,
          message: {
            id: randomUUID(),
            role: 'assistant',
            content: [
              {
                type: 'text',
                text:
                  `这一轮连着跑了 ${steps} 步、调了 ${toolCalls} 次工具，到了单轮上限（${maxSteps} 步），我先停下。\n\n` +
                  `已经做的都在上面。要接着做，回一句「继续」就行；如果是我绕进死循环了，换个说法告诉我该怎么走。`,
              },
            ],
          },
          usage: EMPTY_USAGE,
        })
        this.ctx.logger?.warn?.(
          `agents: 会话 ${sessionId} 第 ${turn} 轮撞到步数硬顶（${maxSteps} 步，工具 ${toolCalls} 次），已收口`,
        )
        // steering 的消息投在 pi 自己的队列里、不落会话日志，而收口发生在它下一次
        // 排空之前——这些插话既没进模型也没进历史。Agent 只告诉我们「还有没有」，
        // 捞不回来，至少在 journal 里留一句，别让它无声消失。
        if (agent.hasQueuedMessages()) {
          this.ctx.logger?.warn?.(`agents: 会话 ${sessionId} 撞顶时仍有插话没处理，已随这一轮丢弃`)
        }
      }
    } catch (e) {
      reason = 'error'
      // 人按了停止：pi-agent 会把这一轮抛出来，但那不是「出错」。照下面那样写一条
      // 「出错了：…」进对话，等于把用户自己的操作反诬成故障。turn/end 的 reason
      // 已经说清楚了，这里什么都不用留。
      if (this.aborting.has(sessionId)) {
        reason = 'aborted'
      } else {
        // 失败也要留在日志里，否则这个 turn 在链路视图上就是一段空白。
        await sessions.append(sessionId, 'assistant/message', {
          turn,
          step: 0,
          message: {
            id: randomUUID(),
            role: 'assistant',
            content: [{ type: 'text', text: `出错了：${(e as Error).message}` }],
          },
          usage: EMPTY_USAGE,
        })
      }
    } finally {
      off()
      this.live.delete(sessionId)
      if (this.aborting.delete(sessionId)) reason = 'aborted'
      await this.settleShots(sessionId)
      await sessions.append(sessionId, 'turn/end', { turn, reason })
      // 有这一行，「那一轮到底结束没有」就不用再猜了。
      this.ctx.logger?.info?.(
        `agents: 会话 ${sessionId} 第 ${turn} 轮结束（${reason}，${Date.now() - startedAt}ms）`,
      )
      // 压缩放在**回复送出之后**：它自己也要跑一次模型，摆在轮首用户就得干等。
      // 不 await——这一轮已经结束了，压缩失败也只是下一轮再试。
      // 同上：压缩改的是这条共用会话，一律按 Bot 自己那个模型的窗口算。
      void this.maybeCompact(sessionId, homeProvider, homeModel).catch((e: Error) =>
        this.ctx.logger?.warn?.(`agents: ${sessionId} 压缩失败 ${e.message}`),
      )
    }
  }

  /**
   * 到阈值就把旧的那一段换成摘要。
   *
   * 三件事按顺序决定：**要不要压**（估算 vs 窗口）、**压到哪**（边界必须落在
   * turn/end 上）、**摘要写什么**（跑一次模型）。任何一步不成立就原样返回——
   * 压缩是优化，不是正确性的一部分，失败了大不了这一轮多花点 token。
   */
  private async maybeCompact(
    sessionId: string,
    provider: string,
    modelId: string,
    force = false,
    opts: { keepBudget?: number; by?: 'auto' | 'user'; atLeast?: number } = {},
  ): Promise<CompactOutcome> {
    const inflight = this.compacting.get(sessionId)
    // 自动那条路不排队：等一次没意义，下一轮还会再试。
    if (inflight && !force) return { compacted: false, reason: 'inflight' }

    /**
     * 强制那条路**排在上一次后面自己再跑一次**，而不是拿它的结果交差。
     *
     * 原来是 `return await inflight`，两种叫法都错：
     *
     * · 手动 `/compact` 要的是「压到只剩最后一轮」（keepBudget 0），而在飞的那次是轮末
     *   的自动压缩，预算是 30%、`by` 是 auto。拿它交差的话，人点了一下，压出来的是别的
     *   东西，界面上那条分割线还写着「自动压缩了一次」；更常见的是自动那次返回
     *   `below-threshold`（它自己先判阈值），于是**什么都没压，而两边都以为压过了**。
     * · 轮末的自动压缩和 isRunning 是错开的：runTurn 的 finally 里先 `live.delete`、
     *   之后才 `void maybeCompact`，所以那几秒里 `isRunning()` 已经是 false——人正好在
     *   Bot 刚答完时打 /compact，必然撞上。
     *
     * 排队而不是并发：两次同时算会各自按自己看到的历史挑边界，然后写下两条互相矛盾的
     * 压缩点——那正是 `compacting` 这把锁一开始要防的。
     */
    const run = (inflight ? inflight.catch(() => {}) : Promise.resolve()).then(() =>
      this.compactOnce(sessionId, provider, modelId, force, opts),
    )
    this.compacting.set(sessionId, run)
    try {
      return await run
    } finally {
      // **只清掉自己那一条**：等待期间可能又有人排在了后面，那时表里已经是它的了。
      if (this.compacting.get(sessionId) === run) this.compacting.delete(sessionId)
    }
  }

  private async compactOnce(
    sessionId: string,
    provider: string,
    modelId: string,
    force: boolean,
    opts: { keepBudget?: number; by?: 'auto' | 'user'; atLeast?: number } = {},
  ): Promise<CompactOutcome> {
    const window = this.compactWindowOf(provider, modelId)
    const at = this.config.compactAt ?? 0.8
    const keep = this.config.compactKeep ?? 0.3
    const resetsAtStart = this.resets.get(sessionId) ?? 0
    const events = await this.ctx.sessions.events(sessionId)
    // 按这一轮真正的模型重建：看不看得了图决定工具结果里带的是图还是一句说明（见 seesImages），
    // 传 undefined 就一律当看不了，带图的会话会被估低。
    const model = this.ctx.llm.modelOf(provider, modelId)
    // 本地估算看不到 system prompt、工具 schema、provider 特殊 token，也很难准确估 CJK。
    // provider 已经回报过的 prompt 用量才是真值：input + cache read 都是本次提示词的一部分。
    // 取边界之后最近那一次（见 observedPromptTokens），避免压缩前的 usage 让新摘要反复触发压缩。
    const before = Math.max(
      estMessages(await toAgentMessages(events, model, this.ctx)),
      observedPromptTokens(events),
    )
    if (!force && before < window * at) return { compacted: false, reason: 'below-threshold' }
    /**
     * `atLeast`：force 了，但**排在别人后面等完之后先看一眼还需不需要压**。
     *
     * 只有轮首那道硬顶用它。那里的估算是拿 runTurn 开头读的那份 history 算的，而在飞的
     * 那次自动压缩很可能就在这几百毫秒里落地——等完再无条件压一次，等于白跑一次摘要
     * 模型调用，还把本来能留住的原文多切掉一段。
     *
     * 手动 `/compact` **不传它**：人明确说了「现在就压」，那就压，不去二次判断。
     */
    if (opts.atLeast !== undefined && before <= opts.atLeast) {
      return { compacted: false, reason: 'below-threshold' }
    }

    /**
     * **只在上一条上下文边界之后挑新边界**（压缩点和重置点都算，见 scopeAfterBoundary）。
     * 按全量去挑会挑到更早的位置，而 toAgentMessages 认的是最后一条边界——于是「再压
     * 一次」反而把上次压掉的原文放了回来，越压越大。
     *
     * 预算：自动压缩留 `窗口 × compactKeep`；手动 `/compact` 传 0，于是
     * compactionPoint 里没有一个切点「装得下」，落到兜底那条路 ends[maxCut]——
     * 也就是**只留最后一整轮**。人明确说了「现在太长了收拾一下」，还留三成等于没听懂。
     */
    const prior = contextBoundary(events)
    const scope = scopeAfterBoundary(events)
    const cut = compactionPoint(scope, opts.keepBudget ?? window * keep, seesImages(model))
    if (!cut) {
      // 近期那几轮自己就超预算了——没有能切的位置，切了也不省。这种情况只可能是
      // 单轮塞进了巨大的工具结果，压缩帮不上忙，交给别的手段。
      this.ctx.logger?.warn?.(`agents: ${sessionId} 到了压缩阈值，但找不到能切的轮次边界`)
      return { compacted: false, reason: 'no-cut' }
    }

    // older 从**全量**里切，不是从 scope：这样它带上了上一条压缩事件，
    // toAgentMessages 会把"上次的摘要 + 这段新对话"折成一份再交给模型去总结。
    const older = events.filter((e) => e.seq <= cut.seq)
    const olderMessages = await toAgentMessages(older, undefined, this.ctx)
    const summary = await this.summarize(olderMessages, provider, modelId)
    if (!summary) return { compacted: false, reason: 'no-summary' }
    const kept = events.filter((e) => e.seq > cut.seq)
    /**
     * 摘要抬头里那个区间的起点。**上一条边界是重置点时，它不能是会话开头。**
     *
     * 压缩点那种照旧从会话开头算：级联压缩里上一次的摘要被折进了这一次（older 从全量
     * 切，带上了那条压缩事件），所以这份摘要**真的**覆盖到最早。
     *
     * 重置点那种不是：`/new` 的意思就是前面那段不要了，toAgentMessages(older) 会在重置
     * 点处截断，摘要正文里一个字都没有它。仍写会话开头的话，summaryText 会渲染出
     * 「[对话摘要 · 8月18日 … 至 8月23日 …]」送进模型，而它同时还写着「需要原文就用
     * history_read 按时间区间调出来」——模型于是既以为自己手里这份摘要覆盖了那一周
     * （被问起时会从一份根本不含该内容的摘要里作答），又被明确指去翻**用户刚要求丢掉**
     * 的那一段。正好把 /new 反过来。
     */
    const from =
      prior?.type === 'session/reset' ? (scope[0]?.time ?? cut.time) : (events[0]?.time ?? cut.time)
    const span = { throughSeq: cut.seq, from, to: cut.time, summary }
    const data: SessionEventMap['session/compact'] = {
      ...span,
      droppedMessages: olderMessages.length,
      tokensBefore: before,
      tokensAfter:
        estTokens(summaryText({ ...span, droppedMessages: 0, tokensBefore: 0, tokensAfter: 0 })) +
        estMessages(await toAgentMessages(kept, undefined, this.ctx)),
      by: opts.by ?? 'auto',
    }
    /**
     * **写回之前再看一眼有没有人 `/new` 过。** 有就作废：这份摘要和切点都是按重置之前的日志算的，
     * 落下去会成为最后一条边界、把刚清掉的上下文放回来（见 resets）。比较和 append 之间没有 await，
     * 而 append 按调用顺序排队，所以不会再有一次重置插进这两步中间。
     */
    if ((this.resets.get(sessionId) ?? 0) !== resetsAtStart) {
      this.ctx.logger?.info?.(`agents: ${sessionId} 压缩期间上下文被重置了，这次压缩作废`)
      return { compacted: false, reason: 'superseded' }
    }
    await this.ctx.sessions.append(sessionId, 'session/compact', data)
    this.ctx.logger?.info?.(
      `agents: ${sessionId} 压缩到 seq ${cut.seq}，${data.tokensBefore} → ${data.tokensAfter} tokens（窗口 ${window}，${data.by}）`,
    )
    return {
      compacted: true,
      throughSeq: cut.seq,
      tokensBefore: data.tokensBefore,
      tokensAfter: data.tokensAfter,
    }
  }

  /**
   * 让模型给旧对话写摘要。
   *
   * 不走 pi 的 Agent：这是一次性的、无工具的调用，套一层循环没有意义。直接用
   * streamFn，读到 done 为止。
   */
  private async summarize(older: AgentMessage[], provider: string, modelId: string): Promise<string> {
    const transcript = clampTranscript(
      older
        .map((m: any) => `${m.role}: ${typeof m.content === 'string' ? m.content : contentDigest(m.content)}`)
        .join('\n'),
    )
    return runSummary(
      this.ctx.llm.streamFn,
      this.ctx.llm.modelOf(provider, modelId),
      transcript,
      { reasoning: this.roleReasoningEffort(provider, modelId) },
    )
  }

  /**
   * 把 ctx.tools 的注册表桥成 pi 的 AgentTool。
   *
   * 两边的失败约定相反：我们的 execute **永远 resolve**（业务失败写进 text），
   * pi 要求**失败抛异常**。所以只有管道层失败（`failed`）才抛——业务失败照常作为
   * 内容返回，模型读得到、能自己重试。
   */
  /**
   * 挑好的工具 → pi 认的形状。
   *
   * **收的是有序的清单，不是一个名字集合。** 顺序有意义：被 `@` 点名的排在最前，而
   * 工具表越长，模型越容易在前几个里选。传集合的话这里会退回 `ctx.tools.schemas()`
   * 的注册顺序，点名等于白点。
   */
  /**
   * 按这一轮**最终定下来的**模型筛一遍工具表：看不了图的，去掉只对视觉有用的那几把
   * （ToolDefinition.vision）。
   *
   * 不在 toolSchemasFor 里筛：挑完工具之后模型还可能换（钉的模型窗口装不下，退回主模型），
   * 筛早了就是按一颗这一轮根本不用的模型筛的。
   */
  private forModel<T extends { name: string }>(schemas: T[], model: { input?: unknown } | undefined): T[] {
    if (seesImages(model)) return schemas
    return schemas.filter((s) => !this.ctx.tools.needsVision(s.name))
  }

  private bridgeTools(sessionId: string, picked?: { name: string; description: string; parameters?: unknown }[], sees = false) {
    const schemas = picked ?? this.ctx.tools.schemas()
    return schemas.map((schema) => ({
      name: schema.name,
      label: schema.name,
      description: schema.description,
      parameters: schema.parameters,
      execute: async (toolCallId: string, params: unknown) => {
        const result = await this.ctx.tools.execute({
          callId: toolCallId,
          name: schema.name,
          // 收口时解析不了的参数（llm/gateway.ts 的 settleArgs）原样交下去，tools.execute 会回模型「参数不是合法 JSON」。
          arguments:
            params && typeof params === 'object' && BAD_TOOL_ARGS in params
              ? String((params as Record<string, unknown>)[BAD_TOOL_ARGS])
              : JSON.stringify(params ?? {}),
          sessionId,
          // **这一条不能省。** pi-agent 的文档写得明白：钩子拿到中止信号，要自己负责
          // 响应它。不往下传的话，agent.abort() 只掐得掉模型那条流，已经开跑的 terminal
          // 会一直跑到自己的超时上限（十分钟）——那期间界面上的停止按钮按下去毫无动静。
          //
          // 现取而不是构造时闭包：signal 是**每一轮**新的，bridgeTools 在建 agent 时
          // 就跑了，那时候还没有 agent，更没有这一轮的信号。
          signal: this.live.get(sessionId)?.signal,
        })
        // 后台还在拍的那张截图：交给 projector，等 `tool/result` 落完盘再补。见 laterShots。
        if (result.pendingShot) {
          let byCall = this.laterShots.get(sessionId)
          if (!byCall) this.laterShots.set(sessionId, (byCall = new Map()))
          byCall.set(toolCallId, result.pendingShot)
        }
        if (result.failed) throw new Error(result.text)
        // 给模型看的图（ToolResult.images）：这一轮的模型看得了就读成图片块跟在文字后面，
        // 看不了就换成一句说明。**这里是这一轮之内的唯一入口**——pi 在同一轮里用的是这份
        // content，不会回头去读日志；跨轮重建历史时 toAgentMessages 再按同一个规矩来一遍。
        const pictures = result.images?.length ? await toolImageBlocks(result.images, sees, this.ctx) : []
        // files/rawText 走 details 而不是 content：content 是给模型的；details 是日志与
        // 界面的旁路。rawText 尤其不能混进 content，否则预算形同虚设。
        // 自己写了什么；details 是 pi 留给「日志与界面渲染」的那一格，正好是这个用途。
        return {
          content: [{ type: 'text' as const, text: result.text }, ...pictures],
          details:
            result.files?.length || result.refs?.length || result.shot || result.rawText || result.images?.length
              ? {
                  ...(result.files?.length ? { files: result.files } : {}),
                  ...(result.refs?.length ? { refs: result.refs } : {}),
                  ...(result.shot ? { shot: result.shot } : {}),
                  ...(result.rawText ? { rawText: result.rawText } : {}),
                  ...(result.images?.length ? { images: result.images } : {}),
                }
              : undefined,
        }
      },
    })) as any
  }

  /** 会话根上的 botId → 名册里的提示词 / provider+model。没有就回落全局设置。 */
  private botOf(history: Awaited<ReturnType<Context['sessions']['events']>>) {
    const root = history.find((e) => e.type === 'session')
    const data = root?.data as { botId?: string; agentId?: string } | undefined
    const botId = data?.botId ?? data?.agentId
    if (!botId) return undefined
    type Row = {
      prompt?: string
      model?: string
      provider?: string
      skills?: string[]
      mcps?: string[]
      /** 模版上的转人工条件。composeSystem 会把它拼成提示词里的一段。 */
      escalate?: string
    }
    return this.ctx.storage.collection<Row>('bots').get(botId)
      ?? this.ctx.storage.collection<Row>('agents').get(botId)
  }

  /**
   * 把该 Bot 挂上的、且已启用的 Skill 正文拼进系统提示词。
   * 没有 skills 列表 → 本机所有启用的 Skill；空数组 → 不加。
   *
   * 返回时把两段分开留一份：上下文占比要分别报「提示词」和「Skill」，拼完再去切
   * 字符串既脆（提示词里出现同样的小标题就切错）又白算一遍。
   */
  private composeSystem(
    bot: { prompt?: string; skills?: string[]; escalate?: string; memory?: unknown } | undefined,
  ): { text: string; base: string; skills: string; memory: string } {
    // 网页那一段只在 web_extract 真的挂上时才加：没有这把工具的进程里，那三行
    // 是在教模型防一种它遇不到的东西，纯占上下文。
    /**
     * 有 web_extract **或者**浏览器工具就要有这一段。
     *
     * 早先只看 web_extract——而 `browser_*` 才是把**登录之后**的页面读进上下文的那条路，
     * 别人写得进内容的地方（工单正文、邮件、同事的评论）恰恰在登录墙后面，Bot 手上又
     * 握着员工本人的身份。少这一段，那些内容进模型时没有任何「这是数据」的定性。
     */
    const untrusted = this.ctx.tools.has('web_extract') || this.ctx.tools.has('browser_snapshot')
    const web = untrusted ? `\n\n${webContentBlock()}` : ''
    /**
     * 公司模版上的转人工条件。
     *
     * **这一段是提示词，边界不是。** 「什么时候该交给人」本来就是一句业务判断，写不成
     * 一条拦截规则；而它对应的动作（escalate_to_human）是一把真工具，调用会在日志和
     * 审计里留痕。没有条件、或者这个进程里压根没挂那把工具时不加——那等于在教模型用
     * 一把它没有的工具。
     */
    const rule = bot?.escalate?.trim()
    const escalate = rule && this.ctx.tools.has('escalate_to_human') ? `\n\n${escalateBlock(rule)}` : ''
    /**
     * 「列出来的东西要带地址」这一段，只在手上真有会返回地址的工具时才加。
     *
     * 内置的三把：搜索给的是一串候选（每条第二行就是地址），网页抓取带着自己的 url，
     * 浏览器快照里每条 link 行的行尾跟着绝对地址。连接器那边同样算——工单、页面、邮件
     * 回来的条目多半各自带着一个能打开的地址，而「列一串东西给人看」正是它们的常用法。
     *
     * 一把都没有的话不加：那是在教模型引用一种它拿不到的东西，纯占上下文，还可能诱它
     * 去编一个看起来对的地址。
     */
    const linked =
      this.ctx.tools.has('web_search') ||
      this.ctx.tools.has('web_extract') ||
      this.ctx.tools.has('browser_snapshot') ||
      this.ctx.tools.schemas().some((t) => t.name.startsWith('mcp_'))
    const cite = linked ? `\n\n${linkOutBlock()}` : ''
    /**
     * 「产出的文件点得开」这一段，只在手上真有会往工作区里落文件的工具时才加。
     *
     * **闸要按「谁会报 `files`」开，不是按「谁像是在写文件」。** 界面认的是
     * `ToolResult.files` 这个字段，不是工具名，而报这个字段的有五条路：`write_file` /
     * `patch` 自己报；`terminal` 跑完扫一遍 mtime 认出来的那些也报（tools/terminal.ts
     * 的 `producedSince`）；`web_extract(save=true)` 把网页原文落进 `web/` 之后报；
     * 浏览器工具把下载报进 `takeDownloads()`。
     *
     * 后两条一开始漏了，而漏掉的正是最该有这段话的那种 Bot：一个只挂了
     * `web_search` + `web_extract` 的调研 Bot，抓回来的 `.md` 在界面上明明是能点开的
     * 药丸，模型却还在回答里写「文件保存在工作区的 web/ 目录，自己打开看」。
     *
     * 一把都没挂上时不加：那是在教模型用一条它走不到的路。
     */
    const makes =
      this.ctx.tools.has('write_file') ||
      this.ctx.tools.has('patch') ||
      this.ctx.tools.has('terminal') ||
      this.ctx.tools.has('web_extract') ||
      this.ctx.tools.has('browser_snapshot')
    const outFiles = makes ? `\n\n${fileOutBlock()}` : ''
    /**
     * 「长活先列清单」这一段，只在 `todo` 真的挂上时才加。
     *
     * **这一段必须有，工具本身不够。** 工具表上多一把 `todo` 只告诉模型「有这么个
     * 东西」，说不出它最要紧的那两条约定：**动手之前**列（事后补一张全是 completed
     * 的表毫无用处），以及**每做完一步立刻回来标**（攒到最后一起标，中途被打断就
     * 什么都没留下——而「中途被打断」正是这把工具存在的全部理由）。
     *
     * 这一段是静态的，不带任何每轮都变的东西，所以不影响上游的前缀缓存（理由见
     * runtimeBlock 开头那段）。清单本身不进提示词：它随时在变，塞进来等于每轮都从
     * 第一个 token 重算，而模型不带参数调一次 todo 就能读回来。
     */
    const todo = this.ctx.tools.has('todo') ? `\n\n${todoBlock()}` : ''
    /**
     * 知识库那一行，**只在这颗 Bot 有可查的库时出现**，列的也只是它查得到的那几个
     * （docs/knowledge-base.md §8.3）。库的内容不进提示词——那正是知识库和 Skill 的分界：
     * Skill 常驻，资料按需。名单每分钟可能变，所以它排在这些静态段之后、Skill 之前。
     */
    const kbs = this.ctx.tools.has('knowledge_search') ? (this.ctx.catalog?.knowledge ?? []) : []
    const knowledge = kbs.length ? `\n\n${knowledgeBlock(kbs)}` : ''
    /**
     * 主 Bot 那一段：能派给谁、派出去之后该怎么说话（docs/bot-tasks.md §5）。只有名单非空时出现
     * ——名单是 Gateway 只给主 Bot 下发的，别的 Bot 这里永远是空串。
     */
    const crew = this.ctx.tools.has('assign_task') ? (this.ctx.catalog?.assignable ?? []) : []
    const assign = crew.length ? `\n\n${assignBlock(crew)}` : ''
    const base = `${bot?.prompt?.trim() || this.system}\n\n${runtimeBlock()}\n\n${schedulingBlock()}${web}${escalate}${cite}${outFiles}${todo}${knowledge}${assign}`
    const { resident, index } = this.skillsOf(bot)
    const parts = [
      ...resident.map((s) => `## Skill: ${s.displayName}\n${s.body}`),
      ...(index ? [index] : []),
    ]
    const skills = parts.join('\n\n')
    /**
     * **记忆排在最末尾，Skill 索引之后。**
     *
     * 这不是排版偏好，是那笔前缀缓存的账（docs/context-assembly.md §2：命中 54/103
     * token，冷缓存 3151）。系统提示词是整个请求的前缀，**变了的那一处之后全部要重算**
     * ——而上面那些几天不动，记忆一天动几次。插在 Skill 前面，等于每记一条就把整段
     * Skill 正文的缓存作废一次。
     */
    const memory = this.memoryBlock(bot)
    /**
     * 本地 Bot 上用户批准过的文件夹。**和记忆一样排在最末尾**：批准 / 撤销随时会发生，
     * 插在前面等于每批一次就把整段 Skill 的前缀缓存作废一次。
     */
    const folders = localFoldersBlock(this.ctx.workspace?.approvedMounts?.() ?? null, this.ctx.tools.has('request_folder_access'))
    // 共享区那段一颗 Bot 一辈子不变，排在最前面，不跟着记忆、批准文件夹一起作废缓存。
    const shared = sharedFolderBlock(Boolean(this.ctx.workspace?.shared), Boolean(this.ctx.workspace?.legacy))
    const tail = [shared, skills, memory, folders].filter(Boolean).join('\n\n')
    return { text: tail ? `${base}\n\n${tail}` : base, base, skills, memory }
  }

  /**
   * 记下的那些事实，拼成提示词最后那一段。
   *
   * 挑哪几条：**钉住的全要**（人钉的东西不该被挤掉，也不占额度），其余按模版的
   * 「记忆范围」筛层、按「记录哪些内容」筛类、扔掉过期的，最后按 `updatedAt` 倒序取
   * 前 `cap` 条。
   *
   * **排序用 `updatedAt`，不用「最近被用到」。** 那个做不了：一条记忆被注入 ≠ 被用上,
   * 中间那一步在模型脑子里，我们只看得见它进了提示词。硬做就得让模型每次汇报「用到
   * 了哪条」——那是拿一条编出来的信号去排序，比按时间排更坏（docs/memory.md §7）。
   */
  private memoryBlock(bot: { memory?: unknown } | undefined): string {
    const mem = memoryOf(bot as BotRecord | undefined)
    if ((process.env.SATUWORK_MEMORY_TOOLS || 'auto').trim() === 'off') return ''
    return memoryBlockOf(mem, cachedMemories(this.ctx))
  }

  /**
   * 这颗 Bot 挂上的 Skill，分成**常驻**和**按需**两摞，外加按需那摞的索引。
   *
   * 分档在这里算，`composeSystem` 和 `toolSchemasFor` 都调它——两处各判一次的话，
   * 会出现「提示词说去用 `skills_list`、工具表里却没有它」这种自相矛盾的一轮。
   * 它是纯函数（读同一份缓存、同一份环境变量），算两次的结果必然相同。
   */
  private skillsOf(bot: { skills?: string[] } | undefined): SkillSplit {
    const ids = bot?.skills
    /**
     * **读缓存一律过 `cachedSkillOf`**：换版之后库里躺着的是上一版写下的行，那时还没有
     * displayName / description / mode 这几个键，而下面这段和三把工具都在直接用它们。
     */
    const picked =
      ids === undefined
        ? cachedSkills(this.ctx)
        : ids.map((id) => cachedSkill(this.ctx, id)).filter((s): s is CachedSkill => !!s)
    /**
     * `off` 是退路：全部按常驻算，一把 skill 工具都不进表，也就是这套东西上线之前
     * 的样子。退路不能在同一次改动里一起删掉（docs/skills.md §12）。
     */
    if ((process.env.SATUWORK_SKILL_TOOLS || 'auto').trim() === 'off') {
      return { resident: picked, onDemand: [], index: '', listTool: false }
    }
    return skillSplit(picked)
  }

  /* ── 会话级的日常模型选择（docs/model-choice.md）───────────────────────
   *
   * 平台给一个默认的日常模型和几个备选；人在对话框里（或者打 `/model`）给自己和这颗
   * Bot 的那条会话挑一个。挑选落成一条 `session/model` 事件，这里负责三件事：
   * 列出能挑哪几个、校验并写下一次挑选、每一轮开跑前算出「这条会话现在用哪个」。
   *
   * **名单只认平台下发的那份。** 浏览器给的是 key，这里拿它去名单里找；找不到就拒。
   * 这和 /messages 只收角色名不收 provider+model 是同一个理由——这条路浏览器也走得通。
   */

  /**
   * 这条会话能挑的日常模型。第一项是默认：Bot 自己那一对（Gateway 下发时已经钉成平台
   * 的日常模型，见 lib/catalog.ts 的 defaultBotModel），后面是平台的备选，重复的去掉。
   */
  dailyChoices(bot: { provider?: string; model?: string } | undefined): DailyChoice[] {
    const found = (provider: string, model: string) =>
      this.ctx.llm.catalog().find((p) => p.provider === provider)?.models.find((m) => m.id === model)
    const one = (provider: string, model: string, isDefault: boolean): DailyChoice => {
      const m = found(provider, model)
      return {
        key: `${provider}/${model}`,
        provider,
        model,
        label: m?.name || model,
        isDefault,
        ...(typeof m?.contextWindow === 'number' ? { contextWindow: m.contextWindow } : {}),
        ...(m?.reasoning ? { reasoning: true } : {}),
      }
    }
    const provider = bot?.provider?.trim() || this.provider
    const model = bot?.model?.trim() || this.model
    const out = [one(provider, model, true)]
    for (const r of this.ctx.catalog?.models?.dailyAlternates ?? []) {
      if (!r.provider || !r.model || out.some((c) => c.provider === r.provider && c.model === r.model)) continue
      out.push(one(r.provider, r.model, false))
    }
    return out
  }

  /** 这条会话最后一次挑的是哪个。没挑过、或者挑回了默认，都是 null。 */
  private sessionPickOf(history: Awaited<ReturnType<Context['sessions']['events']>>): string | null {
    for (let i = history.length - 1; i >= 0; i--) {
      const e = history[i]
      if (e.type !== 'session/model') continue
      const key = (e.data as { key?: unknown }).key
      return typeof key === 'string' && key ? key : null
    }
    return null
  }

  /**
   * 这条会话现在的模型状态。
   *
   * **目录还没拉到时不判下架。** 那时备选名单是空的，照名单判的话，席位每次重启后的
   * 头一轮都会把人选好的模型「退回默认」、还留一条分割线——而那个模型明明还在。
   * 挑选在写下的那一刻已经校验过，拉到目录之前先信它。
   */
  sessionModelState(history: Awaited<ReturnType<Context['sessions']['events']>>): SessionModelState {
    const bot = this.botOf(history)
    const options = this.dailyChoices(bot)
    const picked = this.sessionPickOf(history)
    const def = options[0]
    if (!picked) return { picked, effective: def, options, removed: false }
    const hit = options.find((c) => c.key === picked)
    if (hit) return { picked, effective: hit, options, removed: false }
    if (this.ctx.catalog?.pulledAt == null) {
      const cut = picked.indexOf('/')
      const provider = picked.slice(0, cut)
      const model = picked.slice(cut + 1)
      if (cut > 0 && model) {
        return { picked, effective: { key: picked, provider, model, label: model, isDefault: false }, options, removed: false }
      }
    }
    return { picked, effective: def, options, removed: true }
  }

  /**
   * sessionModelState 的「先对一遍目录」版：名单里有目录还不认识的模型，先重拉目录再算
   * （见 LlmService.ensureKnown）。给人看的（选择器、`/model`）和真开跑的都走这个——
   * 不然名字、推理、窗口全是按裸 id 猜的，`/model <显示名>` 也认不出新加的那个。
   */
  async freshModelState(history: Awaited<ReturnType<Context['sessions']['events']>>): Promise<SessionModelState> {
    await this.ctx.llm.ensureKnown(this.dailyChoices(this.botOf(history)))
    return this.sessionModelState(history)
  }

  /**
   * 这条会话的全部事件；没有这条会话就是 404。
   *
   * sessions.events 对未知 id 是**抛**（读不到那个 jsonl），不是返回空数组——不接住的话
   * 路由层拿到的是一个普通 Error，回 500，界面会当它是暂时故障、每半分钟再问一遍。
   */
  async sessionHistoryOr404(sessionId: string): Promise<Awaited<ReturnType<Context['sessions']['events']>>> {
    let history: Awaited<ReturnType<Context['sessions']['events']>>
    try {
      history = await this.ctx.sessions.events(sessionId)
    } catch {
      throw new CommandError('没有这条会话', 404)
    }
    if (!history.some((e) => e.type === 'session')) throw new CommandError('没有这条会话', 404)
    return history
  }

  /**
   * 换这条会话的日常模型。`key` 为 null 或等于默认 = 回到默认。
   *
   * **跑着的时候也收**：那一轮的模型早定了，换不了，这次挑选从下一轮起生效——返回值
   * 里的 `nextTurn` 告诉界面该怎么说。排队里的那几条开跑时读的是最新的挑选。
   */
  async setSessionModel(
    sessionId: string,
    key: string | null,
    by: 'user' | 'system' = 'user',
  ): Promise<SessionModelState & { changed: boolean; nextTurn: boolean }> {
    const history = await this.sessionHistoryOr404(sessionId)
    const before = await this.freshModelState(history)
    const want = key ? before.options.find((c) => c.key === key) : before.options[0]
    if (!want) {
      const names = before.options.map((c) => c.label).join('、')
      throw new CommandError(`不能换成 ${key}：它不在平台给的日常模型名单里。能选的是：${names}`, 400)
    }
    const next = want.isDefault ? null : want.key
    if (next === before.picked) return { ...before, changed: false, nextTurn: false }
    await this.ctx.sessions.append(sessionId, 'session/model', { key: next, label: want.label, by })
    return {
      picked: next,
      effective: want,
      options: before.options,
      removed: false,
      changed: true,
      nextTurn: this.isRunning(sessionId),
    }
  }

  /**
   * 这条会话「人和它聊天时用的那个模型」：会话挑过的（还在名单里）→ Bot 自己那一对。
   *
   * 挑的那个被下架了：当场补一条 `session/model`（key: null、reason: removed）退回默认，
   * 人回来翻记录时知道从哪一轮起换了模型、为什么换。只在真正开跑一轮时才补（`settle`），
   * 读状态的那几条路不写日志。
   */
  private async homeModelOf(
    sessionId: string,
    history: Awaited<ReturnType<Context['sessions']['events']>>,
    settle = false,
  ): Promise<{ provider: string; model: string }> {
    const state = await this.freshModelState(history)
    if (state.removed && settle) {
      this.ctx.logger?.warn?.(`agents: ${sessionId} 选的 ${state.picked} 已不在日常模型名单里，退回默认 ${state.effective.key}`)
      await this.ctx.sessions.append(sessionId, 'session/model', {
        key: null,
        label: state.effective.label,
        reason: 'removed',
        from: state.picked ?? undefined,
        by: 'system',
      })
    }
    return { provider: state.effective.provider, model: state.effective.model }
  }

  /**
   * 这一轮钉的那个角色对应的模型。**取不到就返回 null，照旧用 Bot 自己的那一对。**
   *
   * 取不到是真会发生的：席位刚起来还没拉过目录，或者平台压根没配 utility。那时候
   * 「不跑」显然比「用贵一点的模型跑」糟得多——省钱是这个开关的目的，不是它的前提。
   * 但要留一行日志：静静地按原模型跑，和真的按 utility 跑，在会话里长得一模一样，
   * 而两者的账单差着一个数量级。
   */
  private roleModel(role?: TurnModelRole): { provider: string; model: string } | null {
    // `daily` = 不覆盖（见 TurnModelRole）。现在只有 utility 这一档真的换模型。
    if (role !== 'utility') return null
    const pick = this.ctx.catalog?.models?.utility
    if (pick?.provider && pick.model) return { provider: pick.provider, model: pick.model }
    this.ctx.logger?.warn?.('agents: 这一轮要用 utility 模型，但平台还没钉——按 Bot 自己的模型跑')
    return null
  }

  /**
   * 当前实际使用的模型对应哪一份平台推理档位。
   *
   * utility 是一次显式覆盖，优先取 utility；如果因为窗口不够退回了 Bot 自己的模型，
   * provider/model 对不上 utility，就自然落回 daily。普通聊天和 daily 日常任务同理。
   */
  private roleReasoningEffort(provider: string, model: string, role?: TurnModelRole): ReasoningEffort {
    const roles = this.ctx.catalog?.models
    const match = (pick: typeof roles.daily | undefined) =>
      pick?.provider === provider && pick.model === model ? pick.reasoningEffort : undefined
    if (role === 'utility') {
      const effort = match(roles?.utility)
      if (effort) return effort
    }
    // 会话换成了某个备选：备选各带各的档位，管理员在备选那一行上配的。
    return match(roles?.daily) ?? roles?.dailyAlternates?.map(match).find(Boolean) ?? 'off'
  }

  /** 压缩按的窗口：上下文窗口压到价格门槛以下，理由见 compactionWindow。 */
  private compactWindowOf(provider: string, model: string): number {
    const found = this.ctx.llm
      .catalog()
      .find((p) => p.provider === provider)
      ?.models.find((m) => m.id === model)
    return compactionWindow(this.windowOf(provider, model) ?? this.config.contextWindowFallback ?? 128_000, found?.cost)
  }

  /**
   * 一个 Agent 的轮内护栏（pi 的 transformContext）。
   *
   * 窗口取目录里的真实窗口，**不是** compactWindowOf 那个压到价格门槛的数：这道闸防的是
   * provider 拒收，不是贵——一轮中间越过价格门槛只是这一轮贵，撞上窗口是这一轮作废，
   * 而且之后每一轮都作废。
   */
  private contextGuardFor(
    sessionId: string,
    provider: string,
    modelId: string,
    model: any,
    systemText: string,
    tools: { name: string; description: string; parameters?: unknown }[],
    base: number,
    prior = 0,
  ) {
    const window = this.windowOf(provider, modelId) ?? model?.contextWindow ?? this.config.contextWindowFallback ?? 128_000
    return turnContextGuard({
      window,
      maxOutput: typeof model?.maxTokens === 'number' ? model.maxTokens : undefined,
      overhead: estTokens(systemText) + estTokens(toolsText(tools)),
      base,
      prior,
      estimate: estMessages,
      onElide: ({ count, freed, projected, limit, total }) =>
        this.ctx.logger?.warn?.(
          `agents: ${sessionId} 轮内上下文逼近窗口，省去 ${count} 条早先的工具结果（约 ${freed} token，本轮累计 ${total} 条），` +
            `预计 ${Math.round(projected)} / 上限 ${Math.round(limit)}`,
        ),
      onExhausted: ({ projected, limit }) =>
        this.ctx.logger?.warn?.(
          `agents: ${sessionId} 工具结果都省完了仍然超窗口（预计 ${Math.round(projected)} / 上限 ${Math.round(limit)}），这次调用多半会被拒`,
        ),
    })
  }

  /** 模型的上下文窗口，来自 Gateway 目录。拉不到就没有——界面那条占比会自己让位。 */
  private windowOf(provider: string, model: string): number | undefined {
    const found = this.ctx.llm
      .catalog()
      .find((p) => p.provider === provider)
      ?.models.find((m) => m.id === model)
    return typeof found?.contextWindow === 'number' ? found.contextWindow : undefined
  }

  /**
   * 内置工具始终在。MCP 工具只在成功 list 之后才注册，再按 Bot.mcps 过滤。
   *
   * **点名是「点名」，不是「限定」。** 被 `@` 的那把连接的工具排到最前，但别的工具
   * 一个都不拿掉——「@Gmail 看看邮件，然后在 Notion 建个页面」是完全正常的一句话，
   * 硬过滤会把它变成半个功能。点名唯一的**放开**作用是让 `mentionOnly` 的连接这一轮
   * 出现在表里（平时它不进默认表）。
   */
  /**
   * 点名了、但这一轮一个工具都拿不出来的那几把。
   *
   * 判据是「这台席位上有没有它的工具」，不是「Gateway 那边连没连上」——后者我们看不见，
   * 而模型能不能用它，只取决于前者。`toolNamesFor([id], [id])` 里第二个参数是「这一轮
   * 点了谁」，`mentionOnly` 的连接靠它才算数。
   */
  private mentionGaps(mentions: Mention[]): Mention[] {
    const catalog = this.ctx.catalog
    return mentions.filter((m) => m.kind === 'connector' && !catalog.toolNamesFor([m.id], [m.id]).length)
  }

  private toolSchemasFor(bot: (BotRecord | { mcps?: string[] }) | undefined, mentions: Mention[] = []) {
    const all = this.ctx.tools.schemas()
    const catalog = this.ctx.catalog
    const mentioned = mentions.filter((m) => m.kind === 'connector').map((m) => m.id)
    const assigned = bot?.mcps
    const ids = assigned === undefined ? catalog.servers.map((s) => s.id) : assigned
    const mcpNames = new Set(catalog.toolNamesFor([...ids, ...mentioned], mentioned))
    /**
     * 模版里没开浏览器，那几把工具就不进工具表。
     *
     * 这一层**只是遮掩，不是强制**——模型直接报一个没在表里的名字照样调得到，真正拦
     * 在 policy 的 checkBrowser 里。两层都要有：少了这一层，一个没开浏览器的 Bot 也
     * 会看见十来把它永远调不通的工具，然后一遍遍去试。
     */
    const browserOn = browserOf(bot as BotRecord | undefined).on
    // 席位桌面同理：关掉了就不进表，真正的拒绝在 policy 的 pre-execute 里。
    // 认不出 Bot 时不进表——policy 那边在这种情况下会拒（见 pre-execute 的 desktop_ 分支）。
    const desktopOn = !!bot && desktopOf(bot as BotRecord).on
    /**
     * `skills_list` **只在索引装不下的那一档进表**（见 skillsOf）。
     *
     * 索引已经在提示词里的时候还摆一把「列出 Skill」的工具，是在邀请模型多打一轮它
     * 不需要的往返——而它很乐意接受这个邀请。
     */
    /**
     * 三把 skill 工具各有各的进表条件，判据在 `skillTools` 那一份里（纯函数，探针直接
     * 打它）。`skill_manage` 那条还要看模版上的开关，缺字段按开算。
     */
    const allowedSkillTools = skillTools(this.skillsOf(bot as { skills?: string[] } | undefined), {
      selfSkills: (bot as BotRecord | undefined)?.selfSkills !== false,
      off: (process.env.SATUWORK_SKILL_TOOLS || 'auto').trim() === 'off',
    })
    const skillTool = (name: string) =>
      !(SKILL_TOOLS as readonly string[]).includes(name) || allowedSkillTools.has(name)
    /**
     * 记忆关掉时，两把工具一起从表里下来。
     *
     * 同 `browser_*` 和 `skill_manage` 那两层：**只是遮掩，不是强制**——真正的拒绝在
     * Gateway 那侧（写接口会判 `on`）。但这一层不能省：留着它，一个关掉了记忆的 Bot
     * 会看见一把永远返回「记忆功能已关闭」的工具，然后一遍遍去试。
     *
     * `off` 那一档是退路（同 `SATUWORK_SKILL_TOOLS`）：这套东西出问题时退回没有它的
     * 样子，而退路不能在同一次改动里一起删掉。
     */
    const memoryOff =
      (process.env.SATUWORK_MEMORY_TOOLS || 'auto').trim() === 'off' || !memoryOf(bot as BotRecord | undefined).on
    /**
     * 平台没挑生图模型时，generate_image 不进表。同上面几层，**只是遮掩**：模型照着历史里
     * 的名字报过来，工具自己会回一句「平台还没有开通生图」。
     */
    const imageOn = !!catalog.models?.image
    /**
     * 这颗 Bot 没有可查的知识库时，knowledge_search 不进表。目录是按 Bot 下发的，所以
     * 「公司有库但一个都没共享给我」和「公司没有库」在它眼里一样：没有这把工具。留着的话
     * 模型会去查、查到「没有」、然后告诉用户「知识库里没有」——而它根本没资格查。
     */
    const knowledgeOn = (catalog.knowledge?.length ?? 0) > 0
    /**
     * 不是主 Bot 就没有 assign_task（docs/bot-tasks.md §3）：目录里的派活名单只给主 Bot 下发，
     * 名单空就不进表。同样只是遮掩——接口那头不是主 Bot 一律 403。
     */
    const assignOn = (catalog.assignable?.length ?? 0) > 0
    /**
     * 工具表里一把连接器工具都没有时，`connector_upload_file` 也不进表。它只为那些工具
     * 服务；单独摆着，模型会拿它去给公司自配的 MCP 传文件，然后收一句「不是连接器的工具」。
     * 同样只是遮掩：直接报名字照样调得到，工具自己会拒。
     */
    const uploadOn = [...mcpNames].some((n) => Boolean(catalog.connectorToolOf?.(n)))
    const picked = all.filter(
      (t) =>
        (!t.name.startsWith('mcp_') || mcpNames.has(t.name)) &&
        (imageOn || t.name !== 'generate_image') &&
        (knowledgeOn || t.name !== 'knowledge_search') &&
        (assignOn || t.name !== 'assign_task') &&
        (uploadOn || t.name !== 'connector_upload_file') &&
        (browserOn || !t.name.startsWith('browser_')) &&
        (desktopOn || !t.name.startsWith('desktop_')) &&
        (!memoryOff || !t.name.startsWith('memory_')) &&
        skillTool(t.name),
    )
    // @ 了一颗 Bot = 要派活：assign_task 也顶到最前（docs/bot-tasks.md）。不是主 Bot 时没这把工具，顶也顶不出来。
    const botNamed = assignOn && mentions.some((m) => m.kind === 'bot')
    if (!mentioned.length && !botNamed) return picked
    // 顶到最前。工具表越长，模型越容易在前几个里选——点名了却排在第 40 位，等于没点。
    const front = new Set(catalog.toolNamesFor(mentioned, mentioned))
    if (botNamed) front.add('assign_task')
    return [...picked.filter((t) => front.has(t.name)), ...picked.filter((t) => !front.has(t.name))]
  }

  /**
   * pi 的事件 → 我们的会话日志。
   *
   * 名称对不上要留意：pi 的一个 **turn** 是「一次模型调用加它的工具」，也就是我们
   * 的 **step**；我们的 turn 是一次用户输入引发的全部工作。
   */
  /**
   * 送给 projector 的那份「这一轮用了什么」：模型、提示词、工具，以及提示词各段占多少。
   *
   * 主轮和子代理两条起跑路径共用。分开写过，结果是给子代理加记忆那次只改了主轮那一份，
   * 界面上子任务的 chip 一直把记忆算进 Skill 里——数字不报错，只是一直不对。
   */
  private turnMeta(
    provider: string,
    modelId: string,
    system: { text: string; base: string; skills: string; memory: string },
    toolSchemas: { name: string; description: string }[],
    reasoningEffort: ReasoningEffort,
  ) {
    const isMcp = (t: { name: string }) => t.name.startsWith('mcp_')
    return {
      provider,
      model: modelId,
      system: system.text,
      tools: toolSchemas,
      contextWindow: this.windowOf(provider, modelId),
      reasoningEffort,
      sections: {
        system: estTokens(system.base),
        skills: estTokens(system.skills),
        // 记忆单独一格：它和 Skill 都在提示词末尾，混着报的话，界面上那颗 chip
        // 说不清「今天忽然变大」是有人加了 Skill 还是 Bot 自己记了十条东西。
        memory: estTokens(system.memory),
        builtinTools: estTokens(toolsText(toolSchemas.filter((t) => !isMcp(t)))),
        mcpTools: estTokens(toolsText(toolSchemas.filter(isMcp))),
      },
    }
  }

  /**
   * 这次调用的截图还在后台拍（ToolResult.pendingShot）：拍完补一条 `tool/shot`。
   *
   * **单独一条事件，不回头改 `tool/result`。** 会话日志只追加（见 session 的 append），
   * 而且那一条早就广播出去了。界面按 callId 把这张折回那次调用（chat.js 的 fold）；
   * 老日志里 shot 在 `tool/result` 上，那条路照旧认。
   *
   * 不 await：模型不等它。写 `turn/end` 之前由 settleShots 收齐。
   */
  private followShot(sessionId: string, turn: number, step: number, callId: string): void {
    const byCall = this.laterShots.get(sessionId)
    const later = byCall?.get(callId)
    if (!byCall || !later) return
    byCall.delete(callId)
    if (!byCall.size) this.laterShots.delete(sessionId)
    const write = later
      .then(async (shot) => {
        if (shot) await this.ctx.sessions.append(sessionId, 'tool/shot', { turn, step, callId, shot })
      })
      .catch((e: Error) => this.ctx.logger?.warn?.(`agents: ${sessionId} 截图补记失败 ${e.message}`))
    let pending = this.shotWrites.get(sessionId)
    if (!pending) this.shotWrites.set(sessionId, (pending = new Set()))
    pending.add(write)
    void write.finally(() => {
      pending.delete(write)
      if (!pending.size && this.shotWrites.get(sessionId) === pending) this.shotWrites.delete(sessionId)
    })
  }

  /**
   * 写 `turn/end` 之前把这一轮后台的截图收齐。
   *
   * **这一轮的事件都要落在 `turn/end` 之前。** 压缩的边界只切在 `turn/end` 上（见 session
   * 的 throughSeq），一条晚到的 `tool/shot` 排到它后面，就成了压缩点之后指向一次已经被
   * 摘要掉的调用的孤儿。多等的只是界面上「正在处理」多亮一会儿——模型那边早就说完了；
   * 截图自己有上限（SHOT_SETTLE_MAX + SHOT_TIMEOUT），人点停止时它当场放弃。
   *
   * 没等到 `tool/result` 的（pi 半路收口，projector 没见到那次调用的结尾）直接丢掉：
   * 没有结果的调用挂一张图，界面也认不回去。
   */
  private async settleShots(sessionId: string): Promise<void> {
    this.laterShots.delete(sessionId)
    const pending = this.shotWrites.get(sessionId)
    if (pending?.size) await Promise.allSettled([...pending])
  }

  private projector(
    sessionId: string,
    turn: number,
    used: {
      provider: string
      model: string
      system: string
      tools: { name: string; description: string }[]
      contextWindow?: number
      reasoningEffort: ReasoningEffort
      sections?: { system: number; skills: number; builtinTools: number; mcpTools: number; memory?: number }
    },
  ) {
    const { sessions } = this.ctx
    let step = 0

    const chunk = (c: StreamChunk) =>
      sessions.append(sessionId, 'assistant/chunk', { turn, step, chunk: c })

    return async (event: AgentEvent) => {
      switch (event.type) {
        case 'turn_start': {
          step += 1
          await sessions.append(sessionId, 'step/start', { turn, step })
          // 每一步的有效提示词与工具表：链路视图的 SYSTEM 段读的就是这条。
          await sessions.append(sessionId, 'request/header', {
            turn,
            step,
            provider: used.provider,
            model: used.model,
            system: used.system,
            tools: used.tools.map((t) => ({ name: t.name, description: t.description })),
            contextWindow: used.contextWindow,
            reasoningEffort: used.reasoningEffort,
            sections: used.sections,
          })
          break
        }

        case 'message_update': {
          const e = event.assistantMessageEvent as any
          const index = e.contentIndex ?? 0
          if (e.type === 'text_start') await chunk({ type: 'block-start', index, kind: 'text' })
          else if (e.type === 'text_delta') await chunk({ type: 'text-delta', index, text: e.delta })
          else if (e.type === 'thinking_start')
            await chunk({ type: 'block-start', index, kind: 'reasoning' })
          else if (e.type === 'thinking_delta')
            await chunk({ type: 'reasoning-delta', index, text: e.delta })
          else if (e.type === 'text_end' || e.type === 'thinking_end')
            await chunk({ type: 'block-end', index })
          break
        }

        case 'turn_end': {
          const msg = event.message as any
          const content = fromAgentContent(msg?.content ?? [])
          // 空消息不入日志：模型调用失败时 pi 也会发一次 turn_end，内容是空的，
          // 记下来只会在对话和链路视图里留一条什么都没有的气泡。
          if (!content.length) {
            await sessions.append(sessionId, 'step/end', { turn, step })
            break
          }
          await sessions.append(sessionId, 'assistant/message', {
            turn,
            step,
            message: {
              id: msg?.id ?? randomUUID(),
              role: 'assistant',
              content,
            },
            usage: toUsage(msg?.usage),
          })
          await sessions.append(sessionId, 'step/end', { turn, step })
          break
        }

        case 'tool_execution_start':
          await sessions.append(sessionId, 'tool/call', {
            turn,
            step,
            callId: event.toolCallId,
            name: event.toolName,
            arguments: JSON.stringify(event.args ?? {}),
          })
          break

        case 'tool_execution_end':
          const modelText = textOf(event.result)
          const rawText = rawTextOf(event.result)
          await sessions.append(sessionId, 'tool/result', {
            turn,
            step,
            callId: event.toolCallId,
            text: rawText ?? modelText,
            ...(rawText !== undefined ? { modelText } : {}),
            failed: Boolean(event.isError),
            files: filesOf(event.result),
            refs: refsOf(event.result),
            shot: shotOf(event.result),
            images: imagesOf(event.result),
          })
          this.followShot(sessionId, turn, step, event.toolCallId)
          break
      }
    }
  }
}

export const name = 'satu-agent'
// 'workspace' 是给 loadImage 用的：日志里的 image 块存的是路径，重建历史时要靠
// ctx.workspace.resolve 把它变成绝对路径再读字节。**不列在这里不是「拿到 undefined」**
// ——cordis 的上下文代理对没 inject 的服务是直接抛 `cannot get property "workspace"
// without inject`，于是任何一条带图的历史都会让 toAgentMessages 抛，整轮静默丢掉。
// 装载顺序不看 cordis.yml 的行序、只看 inject（见那份文件开头的说明），所以这一行
// 就是「workspace 必须排在我前面」的全部声明，不用再动 yml。
export const inject = ['sessions', 'llm', 'tools', 'storage', 'catalog', 'workspace']

export function apply(ctx: Context, config: Config = {}) {
  ctx.plugin(AgentService, config)
  /**
   * 起来时把上一条命留下的委派收口（见 healTasks）。
   *
   * **不 await、不挡启动**：它要扫一遍会话目录，而席位得先能接活。扫失败也只是那几张
   * 卡还转着——比起因为一次读盘异常整个进程起不来，这个方向是对的。
   */
  ctx.inject(['agents'], (ctx: Context) => {
    void ctx.agents.healTasks().catch((e: Error) => ctx.logger?.warn?.(`agents: 收口遗留委派失败 ${e.message}`))
    // 上一条命留下的排队消息（见 drainAtBoot）。同样不挡启动。
    void ctx.agents.drainAtBoot().catch((e: Error) => ctx.logger?.warn?.(`agents: 开机排空队列失败 ${e.message}`))
  })
}
