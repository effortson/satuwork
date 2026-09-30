import { Service, type Context } from '@deepseek-ai/cordis'
import type { ToolSchema } from '../llm/index.ts'
import { budgetToolText } from './result-budget.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: ToolService
  }
  interface Events {
    /**
     * 执行前。**waterfall**：调 next() 放行，不调直接短路——策略在这里表态。
     * 审批、权限、沙箱都挂这里，工具本身不需要知道有策略存在。
     */
    'tools/pre-execute'(call: ToolCall, next: () => Promise<ToolResult>): Promise<ToolResult>
    /** 环绕执行。**waterfall**：超时、重试、计时这类横切关注点挂这里。 */
    'tools/execute'(call: ToolCall, next: () => Promise<ToolResult>): Promise<ToolResult>
    /** 执行后。**waterfall**：改写结果、脱敏、截断。 */
    'tools/post-execute'(call: ToolCall, result: ToolResult, next: () => Promise<ToolResult>): Promise<ToolResult>
  }
}

export interface ToolCall {
  callId: string
  name: string
  /** 原始 JSON 字符串，不预先解析——解析失败是这个工具的业务失败，不是管道故障。 */
  arguments: string
  sessionId: string
  /**
   * 这一轮的中止信号。**跑得久的工具必须自己响应它**——pi-agent 的 abort() 掐的是
   * 模型那条流，管不到已经开跑的工具。
   *
   * 没有这个信号时，界面上那颗停止按钮在最需要它的时候是失效的：模型刚发起一条
   * `terminal`，人看出来跑错了想喊停，而它的超时上限是十分钟——按钮按下去，日志里
   * 那一轮照样跑到底，看起来就是「点了没反应」。
   */
  signal?: AbortSignal
}

/** 工具产出（或改动）的一个文件。路径相对工作区根目录。 */
export interface WorkspaceFile {
  path: string
  name: string
}

export interface ToolResult {
  /** 给模型看的文本。业务失败也写在这里，用工具自己的语义表达。 */
  text: string
  /**
   * 结果超过上下文预算时的完整原文。只落会话日志、给人审计，绝不能送进模型。
   * 没发生瘦身时不写，避免把正常结果复制一份。
   */
  rawText?: string
  /**
   * **管道层**失败：抛异常、超时、执行前被拒。
   * 命令退出码非零、查询没结果这类**业务失败**不置位——它们是正常返回。
   */
  failed?: boolean
  /**
   * 这次调用落地的文件。**给人看的，不给模型看**——它已经从 text 里知道自己写了什么。
   *
   * 存在的理由是「用户怎么发现 Bot 生成的东西」：没有它，界面只能去正则扫工具结果
   * 的文本找路径，而那段文本是给模型写的散文，措辞一改就扫不出来了。让产出文件的
   * 那个工具直接报出来，是这条链路上唯一不靠猜的一环。
   */
  files?: WorkspaceFile[]
  /**
   * 这次调用**看到**的工作区文件。**给人看的，不给模型看**。
   *
   * 和 files 分开，是因为它们回答的是两个问题：files 是「Bot 产出了什么」，值得在
   * 消息底下单独摆一排；refs 是「这段正文里提到的文件名分别指哪个文件」——`ls` 列出来
   * 的那一屏、`grep` 命中的那几个，界面拿它把正文里出现的文件名变成能点开预览的链接。
   * 混进 files 的话，一次 `ls` 就能在底下摆出几十颗药丸，真正的产出被埋掉。
   *
   * 同样**不靠扫文本猜**：路径由列出它们的那个工具直接报出来（理由见上面 files）。
   */
  refs?: WorkspaceFile[]
  /**
   * 这次调用之后页面长什么样，一张落在工作区里的截图。**给人看，不给模型看**——
   * 默认那个对话模型没有视觉，而它手上已经有一份文本快照。
   *
   * **和 files 分开，不是随手多摆一个字段。** files 那一排是「Bot 产出了什么」，一次
   * 多步浏览要往里塞十几张过程截图，真正的产出（它写的那份报告、下载的那个附件）会被
   * 挤得找不着。截图是**过程痕迹**，属于它那一步，界面另摆一条。
   */
  shot?: WorkspaceFile
  /**
   * 给**模型**看的图，路径相对工作区根目录。和 shot 正好反过来：那张是给人看的过程截图，
   * 这几张是模型自己要看的东西（office_render 把文档某几页画出来，让它检查排版）。
   *
   * 工具只管报路径。送不送进模型由 agent 那一层按**这一轮的模型**决定：看得了图的，
   * 读出字节作为图片块跟在结果后面；看不了的换成一句说明——把图塞给纯文本模型，上游
   * 会把整个请求拒掉。
   */
  images?: { path: string; mime: string }[]
}

/**
 * 这把工具会干出什么性质的事。**策略据此判断要不要拦**——没有它，「高风险操作需确认」
 * 只能靠工具名去猜，而 MCP 的工具名是远端起的，猜到的永远是上一版。
 *
 *  - `read`：只看，不改任何东西
 *  - `write`：改数据（本地文件、远端记录、发出去一封邮件）
 *  - `external`：出这台席位，打别人家的系统
 *  - `destructive`：能不可逆地毁掉东西
 */
export type ToolRisk = 'read' | 'write' | 'external' | 'destructive'

/**
 * 没标注的工具按什么算。**最高风险**，不是最低。
 *
 * 反过来（不标注 = 只读）意味着任何一把新注册的工具默认绕过全部边界，而新工具恰恰是
 * 最没被审视过的那些。宁可多问一次。
 */
export const UNKNOWN_RISK: ToolRisk[] = ['external', 'write']

/**
 * 拿 agents 服务，**不经 inject**。
 *
 * cordis 的上下文代理对没 inject 的服务是**直接抛**（`cannot get property "agents"
 * without inject`），不是给 undefined——所以 `ctx.agents?.rootOf?.()` 这种写法在
 * tools / policy 这些没 inject 它的地方会当场炸，而且炸在工具执行的关键路径上。
 *
 * 而 inject 它是不行的：agents 那边 inject 了 tools，静态依赖绕回来两边都起不来
 * （terminal.ts 的 notifyExit 上写过同一段）。取不到就当没有——委派没开的进程里本来
 * 就没有子会话，所有判定退化成「就是它自己」，也就是加委派之前的行为。
 *
 * 探针（e2e-guards.mjs 那种只装了 policy 没装 agents 的）走的也是这条路。
 */
export function agentsOf(ctx: Context):
  | {
      rootOf?: (id: string) => string | undefined
      taskOf?: (id: string) => { taskId: string; goal: string; leases: string[] } | undefined
    }
  | undefined {
  try {
    return (ctx as unknown as { reflect?: { get?: (name: string) => unknown } }).reflect?.get?.('agents') as never
  } catch {
    return undefined
  }
}

/**
 * 一样被移交出去的东西。见 `ToolDefinition.reassign`。
 *
 * **要能直接给人和模型看**：它会原样出现在子代理的结论里（「接手的后台进程：…」），
 * 而主代理下一步很可能就要拿这个 id 去调 `process`。
 */
export interface ReassignedItem {
  /** 主代理拿它就能接着操作（后台进程就是它的 session_id）。 */
  id: string
  /** 一句话说清这是什么。命令原文之类。 */
  label: string
}

/**
 * 这把工具在**子代理**手里是什么待遇（见 docs/delegation.md §6.1）。
 *
 * 四个问题各自独立，答哪个填哪个。**内置工具必须写**（`register` 会拦），`mcp_*` 不写
 * = 全默认——那些工具是远端起的，几百个，名字和语义都不归我们管，而它们的共性恰好让
 * 默认安全：一把 MCP 工具就是「打别人家的系统」，主代理干和子代理干没有区别。
 *
 * **判据挂在工具身上，不写成一张名单。** 名单当天就会过期（内置工具集还在长），而漏一
 * 条的表现是静默的：子代理多一把不该有的手，或少一把本该有的手，两种都要等线上出事才
 * 被看见。
 */
export interface ToolDelegation {
  /** 子代理有没有它。`root-only` = 只有主代理有。默认 `inherit`。 */
  mode?: 'inherit' | 'root-only'
  /**
   * 它要占一样**席位级的独占资源**，写资源的名字（今天只有 `'browser'`）。
   * 同名资源在一批委派里只发一份租约。
   */
  exclusive?: string
  /**
   * 它按 sessionId 摸的那份东西**属于这场对话**（而不是属于这次执行），所以要改摸
   * 主会话的那一份。今天只有 `history_*`。
   *
   * **判据不是「它用不用 sessionId」**——照那个判，`todo` 也该标上，而标上就是子代理
   * 一开工就把主代理的清单整份覆盖掉（`todo` 是整表替换），人正看着的那块 dock 当场
   * 变成子任务的步骤。对话只有一场，计划每次执行各有一份。
   */
  rebind?: boolean
  /**
   * 它会**留下**按 sessionId 记账、而且还活着的东西——后台进程、订阅、定时器。
   * 子代理收口时这些改挂主会话，见 docs/delegation.md §7.3。
   *
   * 标了它就必须实现 `reassign`（`register` 会拦）。
   */
  retains?: boolean
}

export interface ToolDefinition extends ToolSchema {
  /** 见 ToolRisk。不写 = UNKNOWN_RISK。 */
  risk?: ToolRisk[]
  /** 见 ToolDelegation。内置工具必须写。 */
  delegation?: ToolDelegation
  /**
   * 这把工具**只对看得了图的模型有用**（office_render：画出来的图就是它全部的结果）。
   *
   * agent 按这一轮的模型挑工具：看不了图的模型根本看不到它——摆在表里只会被调一次、
   * 拿回一句「看不了图」，白花一步，还多占一段工具描述。
   */
  vision?: boolean
  /**
   * 把这把工具留下的、还活着的东西从一条会话改挂到另一条。返回移交了什么。
   *
   * 只有 `delegation.retains` 的工具要实现。**只动记账那一行，不碰东西本身**——
   * 一个后台进程换个主人不影响它在跑什么。
   */
  reassign?(from: string, to: string): ReassignedItem[] | Promise<ReassignedItem[]>
  execute(args: unknown, call: ToolCall): Promise<ToolResult> | ToolResult
}

/**
 * 内置工具的旧名字 → 新名字。
 *
 * 一个 Bot 一辈子只有一条会话，只增不减，而每一轮都把历史重建成一次模型请求。换完名字
 * 之后，模型会在自己的历史里看见几百次对 `read` / `grep` 的调用，然后照着再调一次。
 *
 * **不注册兼容壳**：那等于工具表长一倍。上下文多花是小事，**模型在更长的表里选得更差**
 * 才是要害。改在这里——只在真的调错时才花一次，而且那一次的失败文本里就带着出路。
 *
 * 历史里的旧调用被摘要压掉之后（两三个版本），这张表可以删。
 */
const RENAMED: Record<string, string> = {
  read: 'read_file',
  write: 'write_file',
  edit: 'patch',
  ls: 'search_files',
  find: 'search_files',
  grep: 'search_files',
  bash: 'terminal',
}

/**
 * 工具注册表与执行管道。
 *
 * 决策必须在做出它的那个操作里强制执行：拒绝只能来自 pre-execute 短路，
 * 不能靠「不把 schema 给模型看」——那不是强制，是遮掩，直接调用照样能绕过去。
 */
export class ToolService extends Service {
  private defs = new Map<string, ToolDefinition>()

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  register(def: ToolDefinition) {
    if (this.defs.has(def.name)) throw new Error(`tools: ${def.name} 已注册`)
    /**
     * **内置工具没标 `delegation` 就抛，进程起不来。**
     *
     * 看着很凶，但它拦的是**开发期**的错误：这件事只可能发生在有人刚写完一把新工具、
     * 第一次把席位跑起来的那一刻，而那正是最该被拦住的时刻——生产上不可能出现，那一版
     * 早就起来过了。换成 `logger.warn` 的话，它会被启动时那几十行滚屏吃掉，然后这把
     * 工具带着一个错误的默认待遇上线（见 docs/delegation.md §6.1）。
     *
     * `mcp_*` 免于此：那些名字是远端起的，我们标不了。
     */
    if (!def.name.startsWith('mcp_') && !def.delegation) {
      throw new Error(
        `tools: ${def.name} 没有 delegation 标注。新增内置工具时必须回答「子代理拿不拿得到它」，` +
          `全默认就写 {}（见 docs/delegation.md §6.1）`,
      )
    }
    if (def.delegation?.retains && !def.reassign) {
      throw new Error(`tools: ${def.name} 标了 retains 却没有 reassign——子代理收口时它留下的东西会成孤儿`)
    }
    this.defs.set(def.name, def)
    return this.ctx.effect(() => () => {
      this.defs.delete(def.name)
    })
  }

  unregister(name: string) {
    this.defs.delete(name)
  }

  schemas(): ToolSchema[] {
    return [...this.defs.values()].map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }))
  }

  has(name: string) {
    return this.defs.has(name)
  }

  /** 见 ToolDefinition.vision。 */
  needsVision(name: string): boolean {
    return this.defs.get(name)?.vision === true
  }

  /**
   * 这把工具的风险面。**认不出的按最高风险算**（见 UNKNOWN_RISK）。
   *
   * 「认不出」有两种，都必须往严了算：工具压根没注册（模型编了个名字，那次调用会被
   * run() 判失败，但策略在它之前就要表态），以及注册了却没标注 risk。
   */
  riskOf(name: string): ToolRisk[] {
    const def = this.defs.get(name)
    if (!def || !Array.isArray(def.risk) || !def.risk.length) return UNKNOWN_RISK
    return def.risk
  }

  /** 这把工具在子代理手里的待遇。没标就是全默认（见 ToolDelegation）。 */
  delegationOf(name: string): ToolDelegation {
    return this.defs.get(name)?.delegation ?? {}
  }

  /**
   * 把 `retains` 的工具留下的东西从一条会话改挂到另一条，返回移交了什么。
   *
   * 子代理收口时调一次。**按标注遍历，不按工具名**：今天只有后台进程有这个性质，但
   * 「留下一样按 sessionId 记账的东西」是个会重复出现的形状（订阅、定时器、没下完的
   * 下载），它们出现时该自动落进这里，而不是等谁想起来。
   */
  async reassign(from: string, to: string): Promise<ReassignedItem[]> {
    const out: ReassignedItem[] = []
    for (const def of this.defs.values()) {
      if (!def.delegation?.retains || !def.reassign) continue
      try {
        out.push(...(await def.reassign(from, to)))
      } catch (e) {
        // 一把工具移交失败不能连累其余的，也不能连累这次委派的收口。
        this.ctx.logger?.warn?.(`tools: ${def.name} 移交 ${from} → ${to} 失败：${(e as Error).message}`)
      }
    }
    return out
  }

  /**
   * 跑完整条管道。**永远 resolve**，不 reject——报告失败是调用方的职责，
   * 不是异常路径；异常会让 agent 循环没法把结果写回日志。
   */
  async execute(call: ToolCall): Promise<ToolResult> {
    const run = async (): Promise<ToolResult> => {
      const def = this.defs.get(call.name)
      if (!def) {
        const now = RENAMED[call.name]
        // 认得出是旧名字就把新名字告诉它。见 RENAMED 上面那段。
        if (now && this.defs.has(now)) {
          return { text: `未知工具 ${call.name}。它已经改名为 ${now}，参数同名，直接用新名字重调一次。`, failed: true }
        }
        return { text: `未知工具 ${call.name}`, failed: true }
      }
      let args: unknown
      try {
        args = call.arguments.trim() ? JSON.parse(call.arguments) : {}
      } catch (e) {
        // 参数不是合法 JSON 是模型的问题，告诉它，让它重试——不算管道故障。
        return { text: `参数不是合法 JSON：${(e as Error).message}` }
      }
      /**
       * 重绑（见 ToolDelegation.rebind）。**做在这里，不做在工具里。**
       *
       * 位置有讲究：**策略之后、execute 之前**。策略要看见这次调用真正来自哪条会话
       * （root-only 的判定、审批卡片上那句「来自子任务」都靠它），而工具要摸的是主
       * 会话那一份。
       *
       * 做在工具里的话，第二把「读这条会话」的工具出现时要自己记得也写一遍，而漏写的
       * 表现是它读回来一片空白——一个看起来像「这段历史不存在」的 bug。
       */
      const root = def.delegation?.rebind ? agentsOf(this.ctx)?.rootOf?.(call.sessionId) : undefined
      return await def.execute(args, root && root !== call.sessionId ? { ...call, sessionId: root } : call)
    }

    try {
      const result = await this.ctx.waterfall('tools/pre-execute', call, async () => {
        const result = await this.ctx.waterfall('tools/execute', call, run)
        return await this.ctx.waterfall('tools/post-execute', call, result, async () => result)
      })
      const budgeted = budgetToolText(call.name, result.text)
      return budgeted.rawText
        ? { ...result, text: budgeted.text, rawText: result.rawText ?? budgeted.rawText }
        : result
    } catch (e) {
      return { text: `工具执行失败：${(e as Error).message}`, failed: true }
    }
  }
}

export const name = 'satu-tools'

export function apply(ctx: Context) {
  ctx.plugin(ToolService)
}
