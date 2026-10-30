import type { MessageSource, RefBlock, Usage } from '../session/types.ts'
import type { ReassignedItem, WorkspaceFile } from '../tools/index.ts'

/** agent 对外的形状：配置、委派的子任务和结果、命令拒绝、排队消息。只有类型和常量，谁都能 import。 */

/**
 * 这一轮钉到平台的哪个模型角色上。
 *
 * 目前只有日常任务用得着：一条到点自己跑的任务，默认压在便宜的 utility 上（见
 * docs/routines.md）。`daily` 和不给这个值是同一个意思——**不覆盖**，跟这个 Bot
 * 平时聊天用的那个模型走。写成「不覆盖」而不是「钉到平台日常模型」，是因为管理员
 * 给某颗 Bot 单独挑过模型的话，那句挑选在定时任务里同样该作数。
 */
export type TurnModelRole = 'daily' | 'utility'

/**
 * 一条委派出去的子任务。**已经解析好的形状**——档位降级、工具收窄、租约分配都在
 * delegate 那把工具里做完了，`runTask` 只管跑。
 */
export interface TaskSpec {
  /** 一批里的第几条，从 0 开始。结果按它排序，不按谁先跑完。 */
  index: number
  goal: string
  /** 它需要知道的全部。**它看不见主对话**。 */
  context: string
  /** 结论里必须包含什么。 */
  deliver?: string
  /** 收窄之后的工具名单。undefined = 不收窄。 */
  tools?: string[]
  modelRole: TurnModelRole
  /** 主代理选这一档时给的理由（见 docs/delegation.md §8.3）。 */
  modelReason?: string
  /** 这一档不是主代理选的（没给理由的 utility 被降下来了）。 */
  downgraded?: boolean
  maxSteps: number
  /** 这一条拿到了哪几样独占资源的租约（今天只有 `'browser'`）。 */
  leases: string[]
  timeoutMs: number
}

/** 一条子任务跑完之后的全部产出。 */
export interface TaskOutcome {
  index: number
  taskId: string
  /** 跑在哪条子会话上。界面上「看过程」点开的就是它。 */
  child: string
  goal: string
  state: 'done' | 'capped' | 'timeout' | 'failed' | 'aborted'
  summary: string
  files: WorkspaceFile[]
  steps: number
  toolCalls: number
  usage: Usage
  model: { role: TurnModelRole; provider: string; id: string; reason?: string; downgraded?: boolean }
  /** 没做成的原因（模型报的错、没跑起来的原因）。和 summary 分开，见 session/types.ts 的 agent/task。 */
  error?: string
  /** 交接给主代理的、还活着的东西（今天只有后台进程）。见 docs/delegation.md §7.3。 */
  handedOver: ReassignedItem[]
  ms: number
}

export interface Config {
  provider?: string
  model?: string
  system?: string
  /**
   * 提示词占到上下文窗口这个比例时，轮次结束后压缩一次。优先采用 provider 回报的
   * input + cache read（边界之后最近一次）；还没有 usage 时才完全依赖本地估算。
   *
   * 留 30% 给「这一轮之后还要长的东西」：工具结果、模型的输出、以及压缩本身
   * 落地之前的那一两轮。压得太早白花摘要的钱，压得太晚就直接撞墙了。
   */
  compactAt?: number
  /** 压缩后保留的近期对话占窗口的比例。摘要之外留这么多原文。 */
  compactKeep?: number
  /**
   * 硬顶。轮次开始时估算已经超过它，就**同步**压一次再发——这一轮会因此慢几秒，
   * 但另一条路是直接被 provider 拒掉。只有在轮末那次压缩失败或没赶上时才会走到。
   */
  compactHard?: number
  /** 窗口未知时（目录没给 contextWindow）按这个 token 数当窗口。 */
  contextWindowFallback?: number
  /**
   * 一轮里最多让模型连着跑多少步（一步 = 一次模型调用加它那批工具）。
   *
   * 防的是**跑飞**：pi 的循环是「模型还在要工具就接着跑」，模型自己不停就永远不停；
   * 而上下文这条路有自动压缩兜着，撞不到窗口那堵墙——没有这个数的话，一个绕不出来的
   * 工具循环能一直烧下去，直到有人恰好看见并按停止。
   *
   * 到顶是**收口**，不是报错：这一轮的历史完整落在日志里，回一句「继续」就接着做。
   */
  maxSteps?: number
}

export const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 }

/**
 * 一次压缩的结果。
 *
 * 原来是个 boolean，够自动压缩用——它失败了只是下一轮再试，没人需要知道为什么。
 * 手动 `/compact` 不一样：人点了一下，界面上必须有个交代，而「还没到阈值」「找不到
 * 能切的地方」「摘要没写成」是三件完全不同的事，混成一个 false 只能回一句「没成功」。
 */
export interface CompactOutcome {
  compacted: boolean
  /** 没压成的原因。`inflight` = 已经有一次在跑，这次不排队。 */
  reason?: 'below-threshold' | 'no-cut' | 'no-summary' | 'inflight' | 'superseded'
  throughSeq?: number
  tokensBefore?: number
  tokensAfter?: number
}

/**
 * 人手下的那条指令没法执行。`status` 直接就是 HTTP 状态码。
 *
 * 形状照抄 WorkspaceError：路由层 `instanceof` 一下就能把状态码和原话透出去，
 * 而服务这边不用认识 HTTP。**原话要能直接给人看**——这两条命令的每一种拒绝都对应
 * 界面上的一句提示，含糊一句「操作失败」等于让人对着一个没反应的按钮反复点。
 */
export class CommandError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'CommandError'
  }
}

/** 这条会话能换到的一个日常模型。第一项永远是默认那一个。 */
export interface DailyChoice {
  /** `provider/model`，选择按它认。 */
  key: string
  provider: string
  model: string
  /** 目录里的显示名；目录还没拉到就是 model id。 */
  label: string
  isDefault: boolean
  contextWindow?: number
  reasoning?: boolean
}

/** 会话当前的模型选择，给界面、`/model` 和渠道命令共用。 */
export interface SessionModelState {
  /** 人选的那个；null = 跟默认。已经下架的选择也照实给出来，`removed` 会是 true。 */
  picked: string | null
  /** 下一轮真正会用的那个。 */
  effective: DailyChoice
  options: DailyChoice[]
  /** 选的那个已经不在名单里——下一轮开跑前会被退回默认。 */
  removed: boolean
}

/** 一张要给模型看的图。路径相对工作区。 */
export interface ImageRef {
  path: string
  mime: string
}

/** 输入框里 `@` 出来的一个东西。形状和会话里的 `mention` 块一致。 */
export interface Mention {
  kind: 'connector' | 'bot' | 'routine'
  id: string
  label: string
  /** 连接器的图标地址（Gateway 校验时附上的）。只给界面画药丸用，不进模型。 */
  logo?: string
}

/**
 * 排在队里、还没轮到的一条消息。
 *
 * **不写 JSONL。** 被取消的那条从没进过模型，写进去会破坏「进模型的内容必须能从
 * JSONL 重建」——重放时会凭空多出一条用户消息。真跑起来的那一刻它照常 append 一条
 * `user/message`，和别的消息没有区别。
 */
export interface QueuedMessage {
  id: string
  sessionId: string
  text: string
  images: ImageRef[]
  mentions: Mention[]
  /** 这条带的引用。老的排队行没有这个字段，按空读。 */
  refs?: RefBlock[]
  /**
   * 谁在说话。人打的不写（老的排队行也没有），按人读。派活的指令和派活跑着时进来的日常任务
   * 也走排队（docs/bot-tasks.md §7），身份得跟着，界面靠它画角标、上下文靠它认派活那几轮。
   */
  source?: MessageSource
  /** 日常任务钉的模型档位，同 send 的 modelRole。 */
  modelRole?: TurnModelRole
  createdAt: number
}
