import { Service, type Context } from '@deepseek-ai/cordis'
import { browserOf, desktopOf, guardsOf, memoryOf, type BotRecord } from '../registry/index.ts'
import { agentsOf, type ToolCall, type ToolResult } from '../tools/index.ts'
import { ApprovalGate, type Verdict } from './approvals.ts'
import { formOf, unwrapCall } from './forms.ts'
import { type ActionContext, blockedHost, hostOf, siteAllowed, submitAction } from './browser.ts'
import { scanPii } from './pii.ts'
import { SHELL_TOOLS, destructiveCommand, networkCommand } from './shell.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    policy: PolicyService
  }
  interface Events {
    /**
     * 一次边界表态。审计上报挂在这里（见 session/gateway.ts），策略自己不发网络请求——
     * 它跑在工具执行的关键路径上，一次超时就是一次卡住的对话。
     */
    'policy/decision'(decision: PolicyDecision): void
  }
}

/** 三个开关的 id。和 Gateway 的 BOT_GUARD_IDS 是同一套键，改一边就要改另一边。 */
/**
 * `browser` 不是模版上的开关，是浏览器那道**谁都关不掉**的硬黑名单（回环、内网、
 * 非 http 协议）。混进这个联合是为了让它走同一条上报路，同时在审计里和三条开关分得开
 * ——见 gateway/src/routes/internal.ts 的 GUARD_IDS。
 */
/**
 * `memory` 不是模版上那三个开关之一——它对应的是记忆那一块里「写入前需用户确认」
 * 那个独立的勾。放进同一个联合里，是因为**留档的形状必须一样**：审计页按 guard 分
 * 组，一次因为记忆而弹的确认，和一次因为高风险而弹的确认，在事后要一样查得到。
 */
export type GuardId = 'high-risk' | 'pii' | 'no-external' | 'browser' | 'memory'

export interface PolicyDecision {
  sessionId: string
  botId: string
  callId: string
  tool: string
  guard: GuardId | 'escalate'
  outcome: 'blocked' | 'approved' | 'denied' | 'timeout' | 'redacted' | 'escalated' | 'noted'
  reason: string
  at: number
}

/**
 * 行为边界的执行点。
 *
 * **落在 `tools/pre-execute` 上，不落在提示词里。** 提示词里写「付款前先问一句」只是
 * 建议：模型可以照做，也可以不照做，而一次不照做就是一封已经发出去的邮件。真正的
 * 边界是这里——短路了它就没跑，跟模型怎么想没有关系（见 tools/index.ts 顶上的说明）。
 *
 * 三条开关来自公司模版，随目录同步下发到席位（catalog → roster.pin → BotRecord.guards）。
 * 模版一改，版本号 +1，这台席位一分钟内跟上，不需要为「边界生效」另造一条同步通道。
 *
 * 这个插件**不叫 guard**：`src/guard/index.ts` 是入站席位票的闸门，两件事同名只会让
 * 下一个人在错误的文件里找错误的东西。
 */
export class PolicyService extends Service {
  static inject = ['tools', 'sessions', 'roster']

  /** 高风险确认的往返。web/index.ts 那两条路由和它说话。 */
  readonly approvals: ApprovalGate

  /**
   * 这一轮里被挡下了几次。轮首清零（听 turn/start）。
   *
   * 存在的理由：模型撞墙之后的默认反应是换个写法再试一遍，而边界不会因为写法变了就
   * 放行。连着撞几次还没绕出去，说明这件事**本来就需要人**——那时候该做的是转人工，
   * 不是让它在步数硬顶里把剩下的一百步走完。
   */
  private blocks = new Map<string, number>()

  /**
   * 会话 → 它属于哪颗 Bot。**记住，不要每次都去读日志。**
   *
   * `sessions.events()` 返回的是整份事件数组的 `slice()`（见 session/index.ts），而这
   * 条路每次工具调用都要走一遍——一条只增不减的长会话攒到几万条之后，光是为了读第一条
   * 里的 botId，每次调用都要复制一遍整个数组，而且是在决定「三个开关开没开」之前。
   * 会话根事件写下就不再变，所以认一次就够。
   */
  private botIds = new Map<string, string>()

  constructor(ctx: Context) {
    super(ctx, 'policy')
    this.approvals = new ApprovalGate(ctx)
    ctx.on('session/event', (sessionId: string, event: { type: string }) => {
      // 轮首清零。不清的话，一整条长会话累计几次之后，每一次拦截都会带上转人工那句话。
      if (event.type === 'turn/start') {
        this.blocks.delete(sessionId)
        // 轮首也清一次：上一轮要是在中途硬死过，它的 turn/end 根本没写下来。
        this.approvals.clearTurn(sessionId)
      }
      /**
       * **「这一轮都批准」和「这一轮别再试了」都到这儿为止。**
       *
       * 一个 Bot 一辈子只有一条会话（registry 的 ensureSession），所以按会话记的名单
       * 等于永久生效——而按钮上写的是「这一轮」。范围必须跟着轮次收口，不然那两颗按钮
       * 就是在说一件它们做不到的事。
       */
      if (event.type === 'turn/end') this.approvals.clearTurn(sessionId)
    })
  }

  /** 连着被挡几次就该转人工。三次：够排除「第一次写错参数」，又不至于让它撞满一轮。 */
  static readonly ESCALATE_AFTER = 3

  /**
   * 这次调用要不要人拍板；要的话返回**为什么**（那句话会印在卡片上）。
   *
   * 三条判据，从严到宽：
   *
   *  1. `terminal` 单独看命令。它的 risk 是最坏情况的并集（写 + 毁 + 外联），照着并集
   *     判的话每一条 `git status` 都要弹一张卡片——那不是收紧边界，那是让人学会闭眼
   *     点批准。
   *  2. 能不可逆地毁东西的，一律要。
   *  3. **对外的写**要（发邮件、改远端记录、付款）。工作区里的 write_file / patch
   *     不要：那是 Bot 干活的常态，界面上那句「对外发送、改写数据或付款前先征求同意」
   *     说的也是对外那一侧。
   */
  needsApproval(call: ToolCall, risk: readonly string[]): string | null {
    if (SHELL_TOOLS.has(call.name)) {
      const hit = destructiveCommand(call.arguments)
      return hit ? `这条命令会不可逆地改动系统（${hit}）` : null
    }
    /**
     * 话里说的是**剥壳之后**那把工具。
     *
     * 连接器工具太多时它们会收进 `SW_RUN`，真正的工具名在参数里。照着壳的名字写，
     * 卡片上就是「mcp_github_default_sw_run 会往外部系统写入或发送内容」——人看不出
     * 自己在批什么，而这张卡片除了「让人看清楚」没有别的用处。
     */
    /**
     * 浏览器也单独看。`browser_click` 正好是 `external + write`，照下面那条判的结果是
     * **每一次点击都弹一张卡片**——和 terminal 那条是同一个道理，同一个后果。
     */
    if (call.name.startsWith('browser_')) {
      return submitAction(call.name, call.arguments, this.actionContext(call))
    }
    const tool = unwrapCall(call).tool
    if (risk.includes('destructive')) return `${tool} 可能不可逆地删除或覆盖数据`
    if (risk.includes('external') && risk.includes('write')) return `${tool} 会往外部系统写入或发送内容`
    return null
  }

  /**
   * 这条会话属于哪颗 Bot。
   *
   * 从会话根事件读 botId 再查名册——**不信调用方**：`ToolCall` 上只有 sessionId，
   * 那是执行管道给的，模型改不了；而 botId 决定了适用哪一份边界，让它从别处进来
   * 就等于让模型自己挑一份宽松的。
   */
  async botOf(sessionId: string): Promise<BotRecord | undefined> {
    if (!sessionId) return undefined
    const known = this.botIds.get(sessionId)
    // 名册那一份是现取的：模版改了、Bot 停用了，下一次调用就该按新的算。
    // 记住的只有「这条会话属于谁」，那一件事不会变。
    if (known) return this.ctx.roster.get(known)
    try {
      const events = await this.ctx.sessions.events(sessionId)
      const root = events.find((e) => e.type === 'session')
      const data = root?.data as { botId?: string; agentId?: string } | undefined
      const botId = data?.botId ?? data?.agentId
      if (!botId) return undefined
      this.botIds.set(sessionId, botId)
      return this.ctx.roster.get(botId)
    } catch {
      // 读不到会话（文件被删、id 是编的）：按**没有 Bot** 走，下面 guardsOf 会回落
      // 到全开。宁可多拦，不能因为读不到日志就把边界一起松掉。**不记进缓存**：
      // 下一次还要再试一遍，一次读盘失败不该把这条会话永远钉在「认不出」上。
      return undefined
    }
  }

  guardsOf(bot: BotRecord | undefined): Record<string, boolean> {
    return guardsOf(bot)
  }

  /**
   * 这一轮被 `@` 点名的连接。点名会让 `mentionOnly` 的连接进这一轮的工具表，
   * 所以它也得算进「允许的外部系统」里，否则点了名照样被拦。
   *
   * 走 `reflect.get` 而不是 inject：`agents` 那边 inject 了 `catalog`，而这里要在
   * 工具执行的路径上被调到，静态依赖绕回去两边都起不来。取不到就当没点名。
   */
  private mentioned(sessionId: string): Set<string> {
    try {
      const agents = (this.ctx as unknown as { reflect?: { get?: (name: string) => unknown } }).reflect?.get?.(
        'agents',
      ) as { mentionedIn?: (id: string) => Set<string> | undefined } | undefined
      return agents?.mentionedIn?.(sessionId) ?? new Set<string>()
    } catch {
      return new Set<string>()
    }
  }

  /** 工具名 → MCP 服务器 id。同样走 reflect：catalog 可能还没起来。 */
  private serverOf(toolName: string): string | undefined {
    try {
      const catalog = (this.ctx as unknown as { reflect?: { get?: (name: string) => unknown } }).reflect?.get?.(
        'catalog',
      ) as { serverOf?: (name: string) => string | undefined } | undefined
      return catalog?.serverOf?.(toolName)
    } catch {
      return undefined
    }
  }

  /**
   * 「禁止访问未授权的外部系统」。
   *
   * 允许集合 = 这颗 Bot 挂上的 MCP（模版里勾的那些）∪ 这一轮点名的连接。
   *
   * 注意这**不是** `toolSchemasFor()` 那一层的重复：那一层只决定「工具表里出现谁」，
   * 是遮掩不是强制——模型直接报一个没在表里的名字照样能调到。这里才是拦。
   */
  /**
   * 这次浏览器动作作用在什么东西上——按钮上印的字、对话框的种类、当前页地址。
   *
   * 走 `reflect.get` 而不是 inject，和 `mentioned()` / `serverOf()` 同一条理由：浏览器
   * 服务要在工具执行的路径上被调到，静态依赖绕回去两边都起不来。取不到就当没有上下文
   * ——那时 submitAction 判不出提交（返回 null），而 checkBrowser 会因为拿不到域名而拒。
   * **两个方向都是安全的那一边**：不知道点的是什么就别弹卡（那次调用本来也会因为 ref
   * 过期失败），不知道在哪个站点就别放行。
   */
  private browserSvc():
    | {
        actionContext?: (call: ToolCall) => ActionContext | undefined
        setScope?: (sites: readonly string[], allowlist: boolean) => void
        takeWrites?: () => { method: string; url: string }[]
      }
    | undefined {
    try {
      return (this.ctx as unknown as { reflect?: { get?: (name: string) => unknown } }).reflect?.get?.('browser') as never
    } catch {
      return undefined
    }
  }

  private actionContext(call: ToolCall): ActionContext | undefined {
    try {
      return this.browserSvc()?.actionContext?.(call)
    } catch {
      return undefined
    }
  }

  /**
   * 这一轮里哪几次调用**问过人**。事后审计要靠它区分「批过的写」和「没人看见的写」。
   *
   * 只留 callId，轮末不清也无所谓（一次调用一个 id，不会重复用）；但为了不让它在
   * 常驻进程里无限涨，超过一千条就整体丢掉——丢掉的后果只是多记几条 noted。
   */
  private asked = new Set<string>()

  /**
   * 浏览器工具的准入。**分两半，一半不受任何开关控制。**
   *
   *  1. 能力开关（模版里的 `browser.on`）与硬黑名单（回环、内网、非 http）——谁都关不掉。
   *     它们防的不是「越权访问外部系统」，是**用浏览器回头打自己**（见 browser.ts）。
   *  2. 公司站点白名单——那才是「禁止访问未授权的外部系统」这条开关管的事，管理员关掉
   *     它就等于说「可以去名单外的地方」。
   *
   * `allowlist` 传的就是第 2 条要不要生效。
   */
  checkBrowser(
    bot: BotRecord | undefined,
    call: ToolCall,
    allowlist: boolean,
  ): { ok: true } | { ok: false; guard: GuardId; reason: string } {
    // 查不到 Bot 就拒。和 mcp_ 那条同一个理由：最该保守的几种情况不能一路放行。
    if (!bot) return { ok: false, guard: 'browser', reason: '认不出这条会话属于哪个 Bot，不能确认浏览器是否被授权' }
    const browser = browserOf(bot)
    if (!browser.on) {
      /**
       * **本机自建的那种要单独说一句。**
       *
       * 它压根没有公司模版（`mcps` 那条分支为同一件事明写过例外），照通用措辞回一句
       * 「模版里没有开」，等于让人去一个不存在的地方找一个开关——而这类 Bot 只在本地
       * 开发时出现，也就是最需要话说清楚的场合。
       *
       * 注意这里**只改措辞，不放行**：浏览器是模版授予的能力，没有模版就没有它。
       * 要在本地试这几把工具，得接上 Gateway 用一颗公司 Bot。
       */
      if (bot.origin === 'local') {
        return {
          ok: false,
          guard: 'browser',
          reason: '本机自建的 Bot 没有公司模版，也就拿不到浏览器这项能力（这几把工具要接上 Gateway、用一颗公司 Bot 才有）',
        }
      }
      return { ok: false, guard: 'browser', reason: '这个 Bot 的模版里没有开浏览器这项能力' }
    }

    const cx = this.actionContext(call)
    /**
     * 判哪个地址：navigate 看它要去哪，其余几把看**当前停在哪一页**——它们作用在那一页
     * 上。页内跳转到名单外的站由服务那侧的请求拦截兜住（本文档 §5.2），这里管不到。
     */
    const target = call.name === 'browser_navigate' ? urlArgOf(call.arguments) : cx?.url
    if (!target) {
      // 还没开过页面就想点：那次调用本来也会失败，但先在这儿说清楚，模型才知道要先 navigate。
      return { ok: false, guard: 'browser', reason: '还没有打开任何页面' }
    }
    const host = hostOf(target)
    const blocked = blockedHost(host)
    if (blocked) return { ok: false, guard: 'browser', reason: blocked }

    /**
     * **把这次允许的范围推给浏览器服务。**
     *
     * 这里判的是「动手之前停在哪一页」，而一次调用当中页面还会动：navigate 撞上 302、
     * 点一下开出新标签页、页内脚本自己跳走。判过之后读回来的那一页，可能已经不是判的
     * 时候那一页了——服务那边拿着同一份名单，在读内容之前再判一次。
     */
    this.browserSvc()?.setScope?.(browser.sites, allowlist)

    if (!allowlist) return { ok: true }
    if (siteAllowed(host!, browser.sites)) return { ok: true }
    return { ok: false, guard: 'no-external', reason: `${host} 不在这个 Bot 允许打开的站点里` }
  }

  /** 这次调用问过人没有。给事后审计用。 */
  markAsked(callId: string): void {
    if (this.asked.size > 1000) this.asked.clear()
    this.asked.add(callId)
  }

  hasAsked(callId: string): boolean {
    return this.asked.has(callId)
  }

  /**
   * 一次浏览器动作跑完之后的补记。
   *
   * 提交判据是启发式，**一定会漏**——一个只有图标、连 aria-label 都没有的按钮就漏了。
   * 漏掉的那次不该在日志里什么都不剩：这里看它到底有没有发出非幂等请求，发了就记一条
   * `noted`。这不是拦截，是让事后查得到。
   */
  async noteWrites(call: ToolCall, bot: BotRecord | undefined): Promise<void> {
    /**
     * **先取空，再决定记不记。**
     *
     * 反过来写（问过人就直接 return）会把这次的写请求留在缓冲里，然后算到**下一次**
     * 工具调用头上——于是日志里出现一条「browser_snapshot 发出了 1 个写请求」，
     * 而那次快照什么都没发。
     */
    let writes: { method: string; url: string }[] = []
    try {
      writes = this.browserSvc()?.takeWrites?.() ?? []
    } catch {
      return
    }
    if (this.hasAsked(call.callId)) return
    if (!writes.length) return
    const shown = writes.slice(0, 3).map((w) => `${w.method} ${w.url}`).join('、')
    await this.record({
      sessionId: call.sessionId,
      botId: bot?.id ?? '',
      callId: call.callId,
      tool: call.name,
      guard: 'browser',
      outcome: 'noted',
      reason: `这次操作发出了 ${writes.length} 个写请求（${shown}${writes.length > 3 ? '…' : ''}），但没有触发确认`,
      at: Date.now(),
    })
  }

  checkExternal(bot: BotRecord | undefined, call: ToolCall): { ok: true } | { ok: false; reason: string } {
    const name = call.name
    if (name.startsWith('mcp_')) {
      const serverId = this.serverOf(name)
      // 认不出属于哪台服务器：拒。这只可能是目录刚卸掉它、而模型还攥着上一轮的工具表。
      if (!serverId) return { ok: false, reason: `${name} 不属于任何已授权的 MCP 服务器` }
      /**
       * **查不到 Bot 就拒。**
       *
       * 这里以前写的是 `bot?.mcps === undefined → 放行`，本意是「本机自建的 Bot 没有
       * 模版管它」。但 `bot` 自己是 undefined 时（会话根事件读不到、名册里没有这颗
       * Bot、botId 是上一版留下的）走的是同一条分支——于是最该保守的那几种情况反而
       * 一路放行。缺省必须是全拦，`local` 是那条**明写出来**的例外。
       */
      if (!bot) return { ok: false, reason: `认不出这条会话属于哪个 Bot，不能确认 ${name} 是否被授权` }
      const assigned = bot.mcps
      if (assigned === undefined) {
        // 本机自建：没有公司模版，也就没有「授权名单」这回事。
        if (bot.origin === 'local') return { ok: true }
        this.ctx.logger?.warn?.(`policy: ${bot.id} 是公司 Bot 却没有 mcps 名单，按未授权处理`)
        return { ok: false, reason: `这个 Bot 还没拿到外部系统的授权名单` }
      }
      if (assigned.includes(serverId)) return { ok: true }
      if (this.mentioned(call.sessionId).has(serverId)) return { ok: true }
      return { ok: false, reason: `这个 Bot 没有被授权使用 ${name} 所在的外部系统` }
    }
    /**
     * 网页搜索与抓取：**放行**。
     *
     * 它们的出口在 Gateway（`/runtime/web/*`），密钥也在那边，席位这侧拿不到任何
     * 凭据；平台开没开这项能力由平台决定。把它算成「未授权的外部系统」，这条边界
     * 一打开 Bot 就查不了任何资料，而那跟「别碰没授权的业务系统」不是一回事。
     */
    if (name === 'web_search' || name === 'web_extract') return { ok: true }
    /**
     * 知识库：**放行**，理由同上。出口在 Gateway（`/runtime/knowledge/search`），共享范围
     * 也在那边判；它查的是公司自己传的资料，不是「没授权的业务系统」。
     */
    if (name === 'knowledge_search') return { ok: true }
    /**
     * 生图：**放行**，理由同上。出口是模型那条路（管家 / Gateway），密钥在那边，用哪颗
     * 生图模型由平台挑；它和「别碰没授权的业务系统」同样不是一回事。
     */
    if (name === 'generate_image') return { ok: true }
    /**
     * 浏览器：**这里放行，真正的判在 checkBrowser 里**。
     *
     * 它有一半（能力开关、硬黑名单）不受这条开关控制，所以整块挪到钩子里更前面的位置
     * 单独跑。在这儿再判一次只会出现两份都得改的判据。
     */
    if (name.startsWith('browser_')) return { ok: true }
    if (SHELL_TOOLS.has(name)) {
      const hit = networkCommand(call.arguments)
      if (hit) return { ok: false, reason: `命令里的 ${hit} 会连到外部网络` }
      return { ok: true }
    }
    // 到这儿还带 external 的，是一把没人认识的工具（UNKNOWN_RISK 兜底的那种）。
    return { ok: false, reason: `${name} 会访问外部系统，而它不在已授权的名单里` }
  }

  /**
   * 记一笔并生成给模型看的那句话。
   *
   * `failed: true` 是有意的：`ToolResult.failed` 的定义里就写着「执行前被拒」算管道层
   * 失败。文本要说清楚**是什么挡的、下一步能干什么**——模型读到一句没有出路的拒绝，
   * 多半会原样再调一次，然后在步数硬顶里空转到底。
   */
  async deny(call: ToolCall, bot: BotRecord | undefined, guard: GuardId, reason: string, hint: string): Promise<ToolResult> {
    await this.record({
      sessionId: call.sessionId,
      botId: bot?.id ?? '',
      callId: call.callId,
      tool: call.name,
      guard,
      outcome: 'blocked',
      reason,
      at: Date.now(),
    })
    const hits = (this.blocks.get(call.sessionId) ?? 0) + 1
    this.blocks.set(call.sessionId, hits)
    let tail = ''
    if (hits >= PolicyService.ESCALATE_AFTER) {
      /**
       * **子会话里这句话是死路**：子代理没有 escalate_to_human（它面前没有人，见
       * docs/delegation.md §3）。照原话劝下去，它只会去调一把不存在的工具，然后把剩下
       * 的步数耗在这上面。
       */
      const agents = agentsOf(this.ctx)
      const inTask = !!agents?.taskOf?.(call.sessionId)
      tail = inTask
        ? `\n\n这一轮已经被挡下 ${hits} 次了。别再换写法重试——你是子代理，问不了人：` +
          `现在停下来，把卡在哪儿、已经排除了什么写进结论交回去，由主代理去处理。`
        : `\n\n这一轮已经被挡下 ${hits} 次了。别再换写法重试——这件事需要人来处理：` +
          `调用 escalate_to_human 说明卡在哪儿，然后停下来等人接手。`
      await this.record({
        sessionId: call.sessionId,
        botId: bot?.id ?? '',
        callId: call.callId,
        tool: call.name,
        guard: 'escalate',
        outcome: 'escalated',
        reason: `这一轮连着被边界挡下 ${hits} 次`,
        at: Date.now(),
      })
    }
    return { text: `这次调用被公司的行为边界挡下了：${reason}。${hint}${tail}`, failed: true }
  }

  /** 落一条会话事件 + 广播。审计上报由监听者去做，策略自己不碰网络。 */
  async record(decision: PolicyDecision): Promise<void> {
    try {
      await this.ctx.sessions.append(decision.sessionId, 'tool/policy', {
        callId: decision.callId,
        name: decision.tool,
        guard: decision.guard,
        outcome: decision.outcome,
        reason: decision.reason,
      })
    } catch (e) {
      // 会话写不进去也不能让这次拦截失效——拦是拦住了，只是这条记录没留下。
      this.ctx.logger?.warn?.(`policy: 记录失败 ${(e as Error).message}`)
    }
    this.ctx.emit('policy/decision', decision)
  }
}

export const name = 'satu-policy'
export const inject = ['tools', 'sessions', 'roster']

export function apply(ctx: Context) {
  ctx.plugin(PolicyService)

  /**
   * 转人工那把工具**单独一个 inject**，不和下面的拦截共用一个。
   *
   * 它要 `handoffs`（交接单那个服务），而拦截只要 `policy`。写在同一个 `ctx.inject`
   * 里的话，交接单没起来 = **整条 `tools/pre-execute` 不注册**，三条行为边界一起静默
   * 消失：工具照跑、日志干净、类型检查也过——正是这一层最怕的那种坏法。
   *
   * 反过来的降级是安全的：没有交接单时这把工具压根不注册，而提示词里那段「什么时候
   * 转人工」本来就看 `tools.has('escalate_to_human')`（见 agent/index.ts），两边一致。
   */
  ctx.inject(['policy', 'handoffs'], (ctx: Context) => {
    /**
     * 转人工。
     *
     * **必须是一把工具，不能只是提示词里的一句话。** 提示词能让模型「说」它要转人工，
     * 但说完它照样会接着自己干；而这一把调用会在会话日志和审计里留下一条明确的记录，
     * 那才是「这件事已经交出去了」的凭据。
     *
     * 它自己 `risk: ['read']`——转人工这个动作本身不该被任何一条边界挡住，否则模型
     * 撞墙之后连唯一的出口也没有了。
     *
     * **它开的是一张有状态的单，不是一条日志**（见 docs/handoff.md）：单子有归属、有
     * 通知、有交还。光记一笔的话，"等待人工接手"这句话是对的，只是没有任何人被等着。
     */
    ctx.tools.register({
      name: 'escalate_to_human',
      /**
       * 子代理面前没有人（docs/delegation.md §3 口径三）。一张单要挂在人看得见的会话上，
       * 而子会话在侧栏里没有位置；就算开出来，人处理完交还时那条子会话早就收口了，没有
       * 任何一轮能消化它。子代理卡住的出路是把卡在哪儿写进结论交回去。
       */
      delegation: { mode: 'root-only' },
      risk: ['read'],
      description:
        '把这件事转给人处理。满足公司规定的转人工条件、或者你连着被行为边界挡下、没法在权限内推进时调用它。' +
        '调用之后就停下来，在回复里把情况和已经做到哪一步说清楚，不要再想办法绕过去。' +
        '人处理完会把结果交回来，你到时候接着做。',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: '为什么需要人接手，一句话。' },
          /**
           * **必填。** 没有它，一张单就是一句抱怨——人打开之后第一件事是回来问
           * 「所以你要我干嘛」，而那时你已经停了。
           */
          ask: { type: 'string', description: '要人做什么，一句祈使句。接手的人打开就看这一行。' },
          summary: { type: 'string', description: '已经做到哪一步、卡在什么地方。接手的人要靠它继续。' },
          blocking: {
            type: 'boolean',
            description: '人不处理这件事是不是就停在这儿。默认 true；只是想让人知道一声就填 false。',
          },
        },
        required: ['reason', 'ask'],
      },
      execute: async (args, call) => {
        const a = (args ?? {}) as { reason?: unknown; ask?: unknown; summary?: unknown; blocking?: unknown }
        const reason = String(a.reason ?? '').trim() || '没有说明原因'
        const ask = String(a.ask ?? '').trim() || '接手处理这件事'
        const summary = String(a.summary ?? '').trim()
        const bot = await ctx.policy.botOf(call.sessionId)
        // 留档那一条照旧写：审计那一屏在用它，两条回答的是不同的问题。
        await ctx.policy.record({
          sessionId: call.sessionId,
          botId: bot?.id ?? '',
          callId: call.callId,
          tool: 'escalate_to_human',
          guard: 'escalate',
          outcome: 'escalated',
          reason,
          at: Date.now(),
        })
        const { handoff, deduped } = await ctx.handoffs.open({
          sessionId: call.sessionId,
          botId: bot?.id ?? '',
          callId: call.callId,
          reason,
          ask,
          ...(summary ? { summary } : {}),
          blocking: a.blocking !== false,
        })
        /**
         * 回给模型的话要**带上单号和现在的状态**。
         *
         * 它接下来那句总结是人在对话里唯一会读到的东西；只回一句「已记录」的话，
         * 它写出来的也只能是「已记录」——而人想知道的是"这件事交给谁了、我要等什么"。
         */
        const who = handoff.claimedBy ? `已经由 ${handoff.claimedBy.name} 接手` : '还没有人接手'
        return {
          text:
            (deduped
              ? `这件事之前已经交出去了（单号 ${handoff.id.slice(0, 8)}，${who}），这次并进同一张单，没有重复打扰人。`
              : `已经开出一张交接单（单号 ${handoff.id.slice(0, 8)}），${who}。人处理完会把结果交回来。`) +
            '现在停下来：在回复里把原因、已经做完的部分和卡住的地方说清楚，让接手的人不用从头问一遍。' +
            '不要再尝试绕过刚才那道边界，也不要反复调这把工具。',
        }
      },
    })
  })

  ctx.inject(['policy'], (ctx: Context) => {
    /**
     * **prepend。** 这条要排在别的 pre-execute 监听者（以后的审批、限流、沙箱）前面：
     * 边界拦下来的调用，不该先被别的横切关注点跑一遍副作用。
     */
    ctx.on(
      'tools/pre-execute',
      async (call: ToolCall, next: () => Promise<ToolResult>) => {
        // 压根没注册的工具交给 run() 去答「未知工具」——在这里拦，模型收到的是一句
        // 「边界挡下了」，而它其实只是名字打错了。
        if (!ctx.tools.has(call.name)) return next()

        /**
         * 子代理的两道**强制**（见 docs/delegation.md §6.1、§7.1）。
         *
         * 排在最前，而且**按标注判、不按工具名判**：写成 `if (name === 'delegate_task')`
         * 的话，第二把 root-only 的工具出现时没有任何东西会提醒你这里也要改。
         *
         * 「不给 schema」不是强制，是遮掩：模型硬报一个没在表里的名字照样调得通。所以
         * 拒绝必须来自这里的短路——tools/index.ts 开头那段注释写的就是这件事。
         */
        const task = agentsOf(ctx)?.taskOf?.(call.sessionId)
        if (task) {
          const d = ctx.tools.delegationOf(call.name)
          if (d.mode === 'root-only') {
            return {
              text:
                `${call.name} 只有主代理有，子任务里调不了。` +
                (call.name === 'delegate_task'
                  ? '委派的深度是 1：要拆得更细，把它写进你的结论，由主代理再派一次。'
                  : '需要人拍板的事，把卡在哪儿写进结论交回去，由主代理去问人。'),
              failed: true,
            }
          }
          if (d.exclusive && !task.leases.includes(d.exclusive)) {
            return {
              text:
                `${call.name} 要占「${d.exclusive}」，而这一批委派里它租给了别的子任务——` +
                '一台席位只有一份（同一颗浏览器、同一块员工正看着的屏）。这一条用别的路子做，或者把它写进结论。',
              failed: true,
            }
          }
        }

        const bot = await ctx.policy.botOf(call.sessionId)
        const guards = ctx.policy.guardsOf(bot)
        const risk = ctx.tools.riskOf(call.name)

        /**
         * **浏览器排在最前，而且不看任何开关。**
         *
         * 它有一半是「这个 Bot 有没有这项能力」和「这个地址是不是这台机器自己」——
         * 那两件事跟管理员把哪条边界关掉了没有关系。放在 no-external 底下的话，
         * 关掉那条开关就等于把回环地址一起放开了。
         */
        /**
         * 席位桌面（`desktop_*`）：模版上关了就拒。工具表那一层只是遮掩，同 browser_*。
         *
         * **不走 deny、不记 guard 事件**：这不是一道边界，是一项没开的能力，和上面子代理
         * 那两道一样直接回一句话。多一个 guard 类别就得 Gateway 那张 GUARD_IDS 先认——
         * 席位先升级的话，每一次拦截都会变成一行永远重发的 outbox。
         */
        if (call.name.startsWith('desktop_')) {
          /**
           * **查不到 Bot 就拒**，同 checkBrowser / checkExternal：会话根读不到、名册里没有
           * 这颗 Bot 的时候，没法确认它的模版有没有关掉这项能力。`desktopOf` 缺字段按开，
           * 那说的是「Bot 在、只是老 Gateway 没下发这一格」，不是「连 Bot 都认不出来」。
           */
          if (!bot) {
            return {
              text: `${call.name} 用不了：认不出这条会话属于哪个 Bot，不能确认它能不能操作席位桌面。这件事改用 terminal / read_file 做。`,
              failed: true,
            }
          }
          if (!desktopOf(bot).on) {
            return {
              text: `${call.name} 用不了：这个 Bot 的模版里关掉了「操作席位桌面」这项能力。这件事改用 terminal / read_file 做，或者请管理员在 Bot 设置里打开它。`,
              failed: true,
            }
          }
        }

        if (call.name.startsWith('browser_')) {
          const v = ctx.policy.checkBrowser(bot, call, guards['no-external'] === true)
          if (!v.ok) {
            return await ctx.policy.deny(
              call,
              bot,
              v.guard,
              v.reason,
              v.guard === 'browser'
                ? '这条拦截跟行为边界的开关无关，关掉开关也不会放行——换一个能公开访问的地址，或者请管理员在 Bot 模版里开这项能力。'
                : '换一个已经授权的站点，或者请管理员把这个域名加进 Bot 模版的站点清单。',
            )
          }
        }

        if (guards['no-external'] && risk.includes('external')) {
          const verdict = ctx.policy.checkExternal(bot, call)
          if (!verdict.ok) {
            return await ctx.policy.deny(
              call,
              bot,
              'no-external',
              verdict.reason,
              '换一条已经授权的路子，或者请用户在 Bot 模版里放开它。',
            )
          }
        }

        /**
         * 「拦截个人敏感信息」。**扫的是出去的那一份**（工具参数），不是回来的。
         *
         * 顺序在高风险确认**之前**：一次注定要被拦的调用，不该先把人叫来点一次头。
         */
        if (guards.pii && outboundOf(call, risk)) {
          const kinds = scanPii(call.arguments)
          if (kinds.length) {
            return await ctx.policy.deny(
              call,
              bot,
              'pii',
              `参数里有${kinds.join('、')}，按公司边界不外发`,
              '把它去掉再试；确实需要带上的话，请用户自己去做这一步，或者请管理员在 Bot 模版里放开这条。',
            )
          }
        }

        /**
         * 记忆写入的确认。**不走下面 high-risk 那条判据**，两个原因：
         *
         * 1. 那条要 `external + write`，而 `memory_write` 不带 `external`——带了的话，
         *    「关掉外发」的 Bot 连自己的记忆都写不进去（同 skill_manage）；
         * 2. 它在界面上是一个**独立的勾**（「写入前需用户确认」），不是风险面的推论。
         *    管理员把 high-risk 关掉、把这个开着，就该是这个意思。
         *
         * **只拦 add / replace，不拦 remove。** 界面上那句副文案写的是「Agent 提议
         * 记住某条信息时先征求同意」——记住。删一条本来就会在对话里出一张卡，人看得见；
         * 为它再弹一次确认，换来的是一个学会闭眼点批准的用户。
         */
        if (call.name === 'memory_write') {
          const mem = memoryOf(bot)
          const args = unwrapCall(call).args
          const op = String(args.op ?? '')
          /**
           * **敏感信息这一道要排在确认前面。**
           *
           * 理由和上面 `guards.pii` 那一段一字不差：一次注定要被拦的调用，不该先把人
           * 叫来点一次头。摆在后面的话，人读完卡片、点了批准，工具才回一句「这条里有
           * 手机号，没记」——那次点击白花了，而且他会以为是自己批错了什么。
           *
           * **判据只有这一处**（`scanPii`，同 policy/pii.ts）。工具那边照旧扫一遍，
           * 但那一次是**报给 Gateway 存档**用的（只存不判），不是拿来拒绝的。
           *
           * `memory_write` 不带 `external` 位（否则外发闸一关，Bot 连自己的记忆都写不
           * 进去），所以上面 `outboundOf` 那道闸够不着它——这一道得单独挂。
           */
          if (mem.pii && (op === 'add' || op === 'replace')) {
            const kinds = scanPii(String(args.text ?? ''))
            if (kinds.length) {
              return await ctx.policy.deny(
                call,
                bot,
                'pii',
                `要记下的这句里有${kinds.join('、')}，这个 Bot 不记敏感信息`,
                '去掉它再记，或者换个说法——比如「他的手机号在通讯录里」。',
              )
            }
          }
          if (mem.confirm && (op === 'add' || op === 'replace')) {
            const why = op === 'add' ? '它要记下一条跨对话的事实' : '它要改掉一条已经记下的事实'
            ctx.policy.markAsked(call.callId)
            const why2 = provenance(ctx, call, why)
            const { verdict, viaBlock } = await askAndRecord(ctx, call, bot, 'memory', why2)
            if (verdict !== 'approved') return blockedByUser(verdict, why, viaBlock)
          }
        }

        if (guards['high-risk']) {
          const why = ctx.policy.needsApproval(call, risk)
          if (why) {
            // 问过就记一笔：事后审计只补记**没问过**的那些（见 noteWrites）。
            ctx.policy.markAsked(call.callId)
            /**
             * 子代理发起的确认，卡片上要说清出处。
             *
             * 不写的话，人看到的是一次凭空出现的发信确认——而他刚才只说了一句「帮我把
             * 这周的活收个尾」，中间隔着一次他没看见的委派。
             */
            const why2 = provenance(ctx, call, why)
            const { verdict, viaBlock } = await askAndRecord(ctx, call, bot, 'high-risk', why2)
            if (verdict !== 'approved') return blockedByUser(verdict, why, viaBlock)
          }
        }

        return next()
      },
      true,
    )

    /**
     * 事后补记。**挂 post-execute，不挂 pre-execute**：要看的是这次动作**已经**发出了
     * 什么请求，那在执行之前还不存在。
     *
     * 只管浏览器：别的工具的写都在自己的协议里看得见（MCP 有工具名，terminal 有命令行），
     * 只有网页上的一次点击是黑盒——点之前只知道按钮上印着什么，而按钮可以什么都不印。
     */
    ctx.on(
      'tools/post-execute',
      async (call: ToolCall, result: ToolResult, next: () => Promise<ToolResult>) => {
        if (!call.name.startsWith('browser_')) return next()
        const out = await next()
        try {
          await ctx.policy.noteWrites(call, await ctx.policy.botOf(call.sessionId))
        } catch (e) {
          // 补记失败不能影响这次调用的结果——它已经跑完了。
          ctx.logger?.warn?.(`policy: 浏览器写请求补记失败 ${(e as Error).message}`)
        }
        return out
      },
    )
  })
}

/**
 * 这次调用会不会把参数**送出这台席位**。
 *
 * 和 `risk.includes('external')` 差在 `terminal` 上：它那份 risk 是最坏情况的并集，
 * 照着判的话 `grep 13800138000 客户.txt` 也算外发——而那句命令从头到尾没离开工作区。
 * 一次这样的误伤，用户学到的就是「把这个开关关掉」，比一开始就没有它更糟。
 * 所以 terminal 看它到底联不联网。
 */
/** 取 navigate 的 url 参数。参数不是合法 JSON 时返回空——那次调用本来就会失败。 */
function urlArgOf(raw: string): string {
  try {
    const parsed = JSON.parse(raw || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const url = (parsed as Record<string, unknown>).url
      return typeof url === 'string' ? url.trim() : ''
    }
  } catch {
    /* 不是 JSON 就当没有 */
  }
  return ''
}

function outboundOf(call: ToolCall, risk: readonly string[]): boolean {
  if (SHELL_TOOLS.has(call.name)) return Boolean(networkCommand(call.arguments))
  return risk.includes('external')
}

/**
 * 弹一次审批卡，把结果原样记进审计。记忆确认和高风险确认走的是同一套。
 *
 * 合成一个函数，是因为**留档那句 `reason` 的口径必须两边一样**：审计页按 guard 分组，
 * 一次因为记忆弹的确认和一次因为高风险弹的确认，事后要一样查得到、一样读得懂。
 * 分开写的时候，「本会话都批准」之后的放行在其中一边只留下一条光秃秃的 approved，
 * 事后翻记录的人会以为有人一次次点过头。
 *
 * 表单在**席位这边**算：剥元工具的壳、认字段、定哪几格能改，全在 forms.ts。
 */
async function askAndRecord(ctx: Context, call: ToolCall, bot: BotRecord | undefined, guard: GuardId, why: string) {
  const { verdict, viaGrant, viaBlock, edited } = await ctx.policy.approvals.ask(call, why, formOf(call))
  await ctx.policy.record({
    sessionId: call.sessionId,
    botId: bot?.id ?? '',
    callId: call.callId,
    tool: call.name,
    guard,
    outcome: verdict === 'approved' ? 'approved' : verdict === 'timeout' ? 'timeout' : 'denied',
    // 出处（`来自子任务《…》`）跟着进审计。卡片上说了、留档里不说的话，事后翻记录的
    // 人看到的是一次凭空出现的发信确认——而那正是最该问出处的一种。
    // terminal 的放行只认同一条命令（approvals.ts 的 grantKey），留档的话要跟着说准。
    reason: viaGrant
      ? `${why}（这一轮此前已批准${SHELL_TOOLS.has(call.name) ? '同一条命令' : '同一把工具'}）`
      : viaBlock
        ? `${why}（这一轮此前已拒绝同一把工具，没有再问）`
        : edited?.length
          ? `${why}（批准时改过：${edited.join('、')}）`
          : why,
    at: Date.now(),
  })
  return { verdict, viaBlock }
}

/**
 * 审批卡上那句「这次调用从哪儿来的」。
 *
 * 不写的话，人看到的是一次凭空出现的发信确认——而他刚才只说了一句「帮我把这周的活收个
 * 尾」，中间隔着一次他没看见的委派。
 */
function provenance(ctx: Context, call: ToolCall, why: string): string {
  const agents = agentsOf(ctx)
  const task = agents?.taskOf?.(call.sessionId)
  if (task) return `来自子任务《${task.goal.slice(0, 24)}》：${why}`
  return why
}

/**
 * 没批准时给模型的那句话。
 *
 * 三种不批准分开说：**「他说不行」和「他没看见」不是一回事**。前者模型该换个做法，
 * 后者它该在对话里把这件事重新提一遍——合成一句「操作被拒绝」，第二种情况下用户回来
 * 看到的是一条毫无线索的失败。
 */
function blockedByUser(verdict: Verdict, why: string, viaBlock?: boolean): ToolResult {
  /**
   * 人这一轮说过「别再试了」。
   *
   * **要说清楚是「这一轮」而不是「永远」**，也要说清楚该往哪走：不这么说的话，模型的
   * 下一步多半是换个措辞再调一次——而它每换一次，人就得再看一条失败。
   */
  if (viaBlock) {
    return {
      text:
        `用户这一轮已经拒绝过这把工具（${why}），并且说了这一轮别再试。` +
        `换一条不需要它的路子；实在绕不开就把话说清楚交给他，等他下一句话再说。`,
      failed: true,
    }
  }
  if (verdict === 'aborted') {
    return { text: `这次调用还没等到确认，用户就点了停止（${why}）。`, failed: true }
  }
  if (verdict === 'timeout') {
    return {
      text: `这次调用需要用户确认（${why}），但一直没人回应，已经按不执行处理。在对话里说明你要做什么、为什么需要它，等用户回来再说。`,
      failed: true,
    }
  }
  return {
    text: `用户拒绝了这次调用（${why}）。别再用同一个办法重试——问清楚他顾虑的是哪一点，或者换一条不需要这项权限的路子。`,
    failed: true,
  }
}
