/**
 * 会话事件模型。
 *
 * 形状参考 docs/session-event-field-map.md——那是从一个生产系统的真实日志逆向出来
 * 的，省掉我们从零试错。但**格式与版本号是我们自己的**：会话历史是产品资产，不能
 * 压在别人不作兼容承诺的格式上。
 */

/** 落盘格式版本。任何破坏性结构变更都要 +1，并同时给出迁移。 */
export const SESSION_FORMAT_VERSION = 5

/** 会话根上的 Bot 来源。M1 只有 local；company / global 是物化预留。 */
export type SessionOrigin = 'local' | 'company' | 'global'

export interface ChannelSessionMeta {
  kind: 'telegram' | 'wechat_official' | 'wecom'
  bindingId: string
  conversationId: string
}

/** 每条事件共有的信封。 */
export interface EventEnvelope<T extends keyof SessionEventMap = keyof SessionEventMap> {
  /** 会话内单调递增，从 1 开始。 */
  seq: number
  /** Unix 毫秒。 */
  time: number
  type: T
  data: SessionEventMap[T]
}

/** 消息内容块。 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; callId: string; name: string; arguments: string }
  | { type: 'tool-result'; callId: string; text: string; failed?: boolean }
  /**
   * 一张给模型看的图（v4 起）。
   *
   * **存路径，不存 base64。** 一张 2 MB 的图 base64 之后是 2.7 MB，直接落进 JSONL 会让
   * 单行大到没法 grep、没法 tail，整条会话的重放也要把它搬一遍。图片本体就在工作区里，
   * 组模型请求的时候现读现转就行。
   */
  | { type: 'image'; path: string; mime: string }
  /**
   * 用户在输入框里 `@` 出来的一个东西（v5 起）。
   *
   * **存结构，不存一句话。** 降级成「用户提到了 Gmail (personal)」的纯文本，进程就
   * 分不清「用户点名了这把连接」和「用户碰巧打了这几个字」，而这两件事的后果差得很远：
   * 前者要把那把连接的工具顶到工具表最前，甚至是唯一能让 `mentionOnly` 的连接出现的
   * 方式。组模型请求时它会被渲染成一行 `[本轮指定：…]`——落盘是结构，进模型是话。
   *
   * `kind` 现在只用 `connector`，形状按三类定死（选单里还有 Bot 和 Routine）：三类各造
   * 一个块，历史会话里就会长出三种彼此不兼容的提及。
   */
  | { type: 'mention'; kind: 'connector' | 'bot' | 'routine'; id: string; label: string }

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: ContentBlock[]
}

/**
 * 消息来源。判别联合，可扩展——这是整个模型里最值钱的一处设计：
 * 注入内容的**出处**挂在这里，而不是新增事件族。知识库检索、长期记忆、
 * 运行时上下文快照都用自己的 `kind` 挂载各自的结构化载荷，
 * 「引用回溯」直接从载荷渲染。
 */
export type MessageSource =
  | { kind: 'user' }
  | { kind: 'plugin'; plugin: string; form?: string; [extra: string]: unknown }

export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  /** 美元。由模型目录的单价算出——缓存读与普通输入单价不同，别自己乘。 */
  cost?: number
}

/** 流式增量。适配器把各家协议翻译成这一套词汇。 */
export type StreamChunk =
  | { type: 'block-start'; index: number; kind: ContentBlock['type'] }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; callId?: string; name?: string; arguments?: string }
  | { type: 'block-end'; index: number }
  | { type: 'usage'; usage: Usage }
  | { type: 'finish'; reason: 'stop' | 'tool-calls' | 'length' | 'error'; error?: string }

/**
 * 事件类型到载荷的映射。加一种模型可见的输入就要在这里加一项——
 * 凡是进入模型请求的东西都必须能从日志重建，否则调用链路那屏放不出来。
 */
export interface SessionEventMap {
  /** 会话根记录，每个会话第一条。v3 起必须带 botId（v2 的 agentId 迁过来）。 */
  session: {
    version: number
    id: string
    createdAt: number
    title?: string
    /** 本实例内 Bot id。打开 /a/:id 靠它找回这条长会话。 */
    botId: string
    origin: SessionOrigin
    /** origin 不是 local 时，Gateway 上的定义 id。M1 用不到。 */
    remoteId?: string
    /** 外部渠道会话。Bot 来源仍由 origin/remoteId 表示，这里不能复用那两个字段。 */
    channel?: ChannelSessionMeta
    /**
     * `task` = 一次委派开出来的子会话（docs/delegation.md）。缺省按 `main` 读。
     *
     * **这是事实源，id 前缀不是。** 文件名确实以 `t-` 开头，那只是给运维 `ls` 一眼分得
     * 开；拿前缀做判断，它迟早会和这个字段分叉。
     *
     * 老日志里还有 `card`（已经下线的卡片会话）。**读它的每一处判据都要写成
     * 「是不是 `main`」**——写成「是不是 `task`」的那些
     * 会把那批老会话当成主会话，一条条报上控制面。
     */
    kind?: 'main' | 'task'
    /**
     * 谁开的。`kind` 不是 `main` 时才有。
     *
     * 委派那一档三样都要：`sessionId` 是「回到哪条主会话」（审批卡片、history_* 重绑、
     * 后台进程改挂全靠它），`callId` 是「哪一次 delegate_task」，`taskId` 是「那一批里
     * 的哪一条」。
     *
     */
    parent?: { sessionId: string; callId: string; taskId: string }
  }
  'session/title': { title: string }

  /**
   * 这条会话从这里起用哪个日常模型（对话框里的选择器、输入框和渠道里的 `/model`）。
   *
   * **落在会话上，不落在 Bot 上。** 一个 Bot 在一个席位上只有一条会话（registry 的
   * ensureSession），席位是人的——所以这就是「这个人 × 这颗 Bot」的选择；Web 和
   * Telegram 写的是同一条会话，两个入口看到的也就是同一个选择。`/new` 不清它：那是
   * 上下文边界，不是「把设置恢复默认」。
   *
   * `key` 是 `provider/model`，必须在平台的日常模型名单里（默认 + 备选），写的那一刻
   * 由 agents.setSessionModel 校验；null = 跟默认走。名单后来变了、选的那个被下架，
   * 下一轮开跑前由席位补一条 `key: null, reason: 'removed'`，界面照着画一句「已下架」。
   *
   * 加一种事件不是破坏性变更（老版本读到不认识的 type 会跳过），退化方向是「像没选过
   * 一样用默认」，所以不动 SESSION_FORMAT_VERSION。
   */
  'session/model': {
    key: string | null
    /** 写下这条时那个模型的显示名，界面画分割线用；名单后来变了也还读得懂。 */
    label?: string
    /** `removed` = 选的那个不在名单里了，席位自己退回默认。人手切的没有这个字段。 */
    reason?: 'removed'
    /** 被退掉的那个（只在 removed 时有）。 */
    from?: string
    by?: 'user' | 'system'
  }

  /**
   * 上下文压缩点。
   *
   * 一个 Bot 一条长会话，会话只增不减，而每一轮都把全量历史重建成 messages 发出去——
   * 这条路走到底必然撞上下文窗口。所以到了阈值就把**旧的那一段**换成一段摘要。
   *
   * **换的只是送进模型的那一份。** JSONL 一条不删，界面、审计、`/internal/sessions/:id`
   * 看到的仍然是全量原文；模型想看原文也调得到（history_read / history_search）。
   * 这正是这件事敢做的前提：压缩不是丢弃，是把远处的东西挪到伸手可及的地方。
   *
   * **throughSeq 必须落在 turn/end 上。** 边界切在一轮中间的话，带 tool_calls 的助手
   * 消息会被摘要吃掉、而它的 tool/result 留在后面——provider 直接拒收
   * 「role 'tool' 必须紧跟在带 tool_calls 的消息之后」。
   *
   * 加这一种事件不算破坏性变更：老版本读到不认识的 type 会跳过，退化成发全量历史，
   * 也就是加它之前的行为。所以不动 SESSION_FORMAT_VERSION。
   */
  'session/compact': {
    /** 摘要覆盖到这一条（含）为止。之后的事件照旧逐条进上下文。 */
    throughSeq: number
    /** 覆盖区间的首尾时间。摘要正文里要写出来，否则「昨天」在压缩之后就断了。 */
    from: number
    to: number
    summary: string
    /** 诊断用：压掉了多少条消息、前后各值多少 token（估算）。 */
    droppedMessages: number
    tokensBefore: number
    tokensAfter: number
    /**
     * 谁切的。老日志没有这个字段，按 `auto` 读。
     *
     * 「它自己压的」和「人在输入框里打了 /compact」在排查「怎么突然忘事了」时是两个
     * 不同的答案，而事后从别的字段反推不出来。
     */
    by?: 'auto' | 'user'
  }

  /**
   * 上下文重置点（人在输入框里打了 `/new`，见 docs/chat-commands.md）。
   *
   * 和 `session/compact` 是同一类东西——**决定下一轮请求从哪儿开始**——区别只在这一条
   * 不留摘要。两者共用一套判定（agent/index.ts 的 contextBoundary），任何「找最后一条
   * 压缩点」的地方都必须同时认它，否则 `/new` 之后的第一次自动压缩会从重置点**之前**
   * 挑边界，把刚扔掉的原文又放回上下文——人点过的 `/new` 会在几轮之后无声失效。
   *
   * **不新建会话。** 一个 Bot 一条长会话是架构不变量（侧栏摘要、会话索引、工作区归属、
   * 跨轮认单的转人工都挂在上面），而人要的只是「别把前面带上」——那是上下文边界，
   * 不是会话边界。
   *
   * **throughSeq 同样必须落在 turn/end 上**，理由和压缩点一字不差。
   *
   * 加一种事件不是破坏性变更（老版本读到不认识的 type 会跳过），所以不动
   * SESSION_FORMAT_VERSION。要留意的是**退化的方向**：老席位读到它会把前文全带回
   * 上下文，也就是「像没执行过 /new 一样」——多带不是少带，方向是安全的，但回滚一次
   * 版本，这一刀的效果就消失了。
   */
  'session/reset': {
    /** 这一条（含）之前的事件不再进上下文。 */
    throughSeq: number
    /** 被切掉那一段的首尾时间。界面上那条分割线要写出来。 */
    from: number
    to: number
    /** 切掉了多少条消息（估算口径同 compact 的 droppedMessages）。 */
    droppedMessages: number
    /** 只有人能触发。留着这个字段是为了跟 compact 的 by 对齐，将来真有自动重置也不用改形状。 */
    by: 'user'
  }

  'turn/start': { turn: number }
  /** `capped`：撞上一轮的步数硬顶，被我们收的口——不是模型自己说完了，也不是出错。 */
  'turn/end': { turn: number; reason: 'completed' | 'error' | 'aborted' | 'capped' }
  'step/start': { turn: number; step: number }
  'step/end': { turn: number; step: number }

  /** 每次模型请求的有效提示词与工具表；调用链路的 SYSTEM 段读这里。 */
  'request/header': {
    turn: number
    step: number
    provider: string
    model: string
    system: string
    tools: { name: string; description: string }[]
    /** 这个模型的上下文窗口。目录没拉到就没有这个字段。 */
    contextWindow?: number
    /** 这一步实际使用的推理强度。老日志没有时按 off。 */
    reasoningEffort?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    /**
     * 提示词各段占多少 token（估算）。
     *
     * **只有 bot 这边算得了**：事件里的 `tools` 只留了名字和描述，而参数表通常比描述
     * 还大，界面拿这份去估会把工具那段算漏一大半；`system` 里的 Skill 正文同理，拼完
     * 再切字符串既脆又白算一遍。所以在拼提示词的地方顺手量一次，量完带出来。
     *
     * 老日志没有这个字段——界面会退回只报总量，不编一个分段出来。
     */
    sections?: { system: number; skills: number; builtinTools: number; mcpTools: number; memory?: number }
  }

  'user/message': { message: Message; source: MessageSource }
  'assistant/chunk': { turn: number; step: number; chunk: StreamChunk }
  'assistant/message': { turn: number; step: number; message: Message; usage: Usage }

  /**
   * 一次**行为边界的表态**（v5.1 起）。
   *
   * 拦下来的调用在 `tool/result` 上已经是一条 failed 了，但那条只说「这次没跑成」，
   * 说不出「是公司的哪条边界挡的、谁批的、批的时候是什么理由」。合规要问的恰恰是
   * 后面这些，而它们必须能从日志重建——审计那一屏、以后的季度报表都从这里派生，
   * 不从工具结果的散文里正则。
   *
   * 加一种事件不是破坏性变更（同 `session/compact` 的理由：老版本读到不认识的 type
   * 会跳过），所以不动 SESSION_FORMAT_VERSION。
   */
  'tool/policy': {
    callId: string
    /** 工具名。审计里「拦了什么」就靠它，别指望事后从 callId 反查。 */
    name: string
    /**
     * 哪条边界表的态。三条开关之外还有三个：`escalate`（转人工，不是开关），
     * `browser`（浏览器那道谁都关不掉的硬黑名单），`memory`（记忆那一块里「写入前
     * 需用户确认」那个独立的勾）。分开记才看得出**是不是开关挡的**。
     *
     * **加一个新值就要同时改 `gateway/src/routes/internal.ts` 的 `GUARD_IDS`**：那是
     * 一张白名单，认不出来的一律 400，而席位的 outbox 没有重试上限——漏改的表现是
     * 拦截照样发生、审计里一条都没有，外加一行永远重发的队列。
     */
    guard: 'high-risk' | 'pii' | 'no-external' | 'escalate' | 'browser' | 'memory'
    /**
     * `noted` 是**事后**记的一笔，不是一次表态：动作已经跑完了，只是它引发了写请求
     * 而当时没有弹过卡片。提交判据是启发式（一个只有图标的删除按钮就没有名字），
     * 漏掉的那次至少要在日志里留得下。
     */
    outcome: 'blocked' | 'approved' | 'denied' | 'timeout' | 'redacted' | 'escalated' | 'noted'
    reason: string
  }

  /**
   * 一次**等人拍板**的高风险调用（v5.1 起）。
   *
   * 和上面那条 `tool/policy` 分开，因为它们回答的是两个问题：`tool/policy` 是留档
   * （拦了什么、为什么），这一条是**界面上的一次交互**——一张带「批准 / 拒绝」的卡片，
   * 而卡片必须能从日志重建：刷新页面、换个标签页、断线重连之后，那次还在等的确认
   * 不能就此消失（工具那边还在 await，人这边却再也看不到入口）。
   *
   * 同一个 callId 会出现两条：先 `pending`，人点了之后再来一条终态。界面按 callId
   * 认，取最后一条。
   */
  'tool/approval': {
    callId: string
    name: string
    /** 参数原串。**给人看的**，卡片上要显示「到底拿什么跑」。 */
    arguments: string
    /** 为什么需要确认，一句话。「这会往外发东西」和「这会删掉文件」不是一回事。 */
    reason: string
    state: 'pending' | 'approved' | 'denied' | 'timeout' | 'aborted'
    /**
     * 这次用哪张卡、卡上有哪几格（见 bot/src/policy/forms.ts）。
     *
     * **界面照着它画，不自己认工具。** 「这是一封要发出去的邮件」这个判断需要知道
     * 工具的参数长什么样、元工具那层壳怎么剥——那是席位这边的知识，搬进浏览器只会
     * 变成两份会各自漂的规则。认不出的 kind 一律退回通用卡。
     */
    form?: {
      kind: string
      tool: string
      fields: { key: string; label: string; value: string; editable?: boolean; multiline?: boolean }[]
    }
    /** 人在卡片上改过哪几格（标签）。终态事件里的 arguments / form 已经是改后的那份。 */
    edited?: string[]
    /**
     * 批准的范围：只这一次，还是**这一轮里**同一把工具都放行。
     *
     * 早先这里是 `'session'`（这条会话都放行），那是错的：一个 Bot 一辈子只有一条
     * 会话，等于永久通行证。老日志里可能还留着 `'session'`，界面不渲染这一格，
     * 当成 `'turn'` 读即可。
     */
    scope?: 'once' | 'turn'
    /**
     * pending 事件上带：过了这个时刻席位自动按不执行处理，并补一条终态事件。
     *
     * **界面不拿它判卡片死活**：那是席位的钟，浏览器那边是另一台机器的钟，两边差几十
     * 秒是常态。判据用日志行号（seq），见 gateway/ui/chat.js 的 approvalDead。
     */
    expiresAt?: number
  }

  /**
   * 一次**转人工的交接**（见 docs/handoff.md）。
   *
   * 和 `tool/policy`（`guard: 'escalate'`）分开，因为它们回答的是两个问题：那一条是
   * 留档「这次表态是什么」，这一条是待办「这件事现在到哪儿了」。审计那一屏在用前者，
   * 合并的话「上个月转了几次人工」和「现在还有几张没人接」会挤成同一个数。
   *
   * 同一张单会来多条（open → claimed → returned → closed）。界面按 `id` 认，取最后
   * 一条——和 `tool/approval` 是同一套读法。
   *
   * 加一种事件不是破坏性变更（老版本读到不认识的 type 会跳过），所以不动
   * `SESSION_FORMAT_VERSION`。
   */
  'human/handoff': {
    /** 单号。 */
    id: string
    /** 开这张单的那次工具调用。和 `tool/policy` 那条对得上。 */
    callId: string
    state: 'open' | 'claimed' | 'returned' | 'closed' | 'expired' | 'cancelled'
    /** 为什么要人接。 */
    reason: string
    /** 要人**做什么**，一句祈使句。没有它，一张单就是一句抱怨。 */
    ask: string
    /** 已经做到哪一步、卡在什么地方。接手的人靠它不用从头问一遍。 */
    summary?: string
    /** 人不处理，这件事是不是就停在这儿。定时任务据此决定跳不跳过。 */
    blocking: boolean
    /** 谁接的。`open` 态没有。 */
    claimedBy?: { accountId: string; name: string }
    /** 人交还时给的结论。 */
    result?: {
      disposition: 'done' | 'instructions' | 'closed'
      text: string
      by?: { accountId: string; name: string }
    }
    /** 同一件事被合并进来几次（模型换个措辞又撞了一次）。 */
    repeats?: number
    at: number
  }

  /**
   * 这条会话的**待办清单在这一刻的样子**（v5.2 起，见 docs/todo-tool.md）。
   *
   * **清单本身不在日志里，在 SQLite 里**（它是一份会被反复改写的状态，写成事件流会
   * 让同一张表在历史里躺下几十个版本）。这条事件只为一件事存在：**输入框上面那块
   * dock 要跟着变**。没有它，界面只能去轮询席位，而人恰恰是在盯着它看的那几秒里
   * 期待它动。
   *
   * **全量快照，不是增量。** 界面按 seq 取最后一条就是当前状态，不必把整条会话重放
   * 一遍去推算；而增量还要求一条都不能漏，那是这条链路给不了的保证（流上只垫最近
   * 一轮，见 session/replay.ts）。
   *
   * **不进模型上下文。** toAgentMessages 只认 user/assistant/tool-result 三种，认不出
   * 的一律跳过——模型要读清单有自己的路（不带参数调一次 `todo`）。所以这条事件的
   * 全部代价就是 JSONL 里多几行。
   *
   * 加一种事件不是破坏性变更（同 `session/compact` 的理由），所以不动
   * SESSION_FORMAT_VERSION：老版本读到不认识的 type 会跳过，退化成「没有这块 dock」。
   */
  'todo/list': {
    /** 改动这张表的那次工具调用。 */
    callId: string
    items: { id: string; task: string; status: 'pending' | 'in_progress' | 'completed' | 'cancelled' }[]
  }

  /**
   * Bot 给自己记下了一条 Skill（见 docs/skills.md §13）。
   *
   * 存在的理由只有一个：**员工要在事情发生的当下看见它**。私有档会持续改变这颗 Bot
   * 之后的行为，而事后去 Skill 页面翻等于没有——那一屏没人会没事去看。
   *
   * **不靠界面去扫工具结果的文本**：那段文本是写给模型的散文，措辞一改就扫不出来
   * （同 `ToolResult.files` 那条注释里的道理）。写下它的那把工具直接报出来。
   *
   * **不进模型上下文**（toAgentMessages 只认三种 role），所以它的全部代价是 JSONL 里
   * 多一行。加一种事件不是破坏性变更，不动 SESSION_FORMAT_VERSION：老界面读到不认识
   * 的 type 会跳过，退化成「少一张卡」——工具结果里那句「已保存」还在。
   */
  'skill/saved': {
    /** 写下它的那次工具调用。 */
    callId: string
    /** 目录里的 id。界面拿它去开详情、或者删掉。 */
    id: string
    /** 模型看到的那个名字（重名时带序号）。 */
    name: string
    action: 'create' | 'update' | 'remove'
    /** 这颗 Bot 自己记下的还剩几条，以及上限。界面上那句「7/30」。 */
    used?: number
    max?: number
  }

  /**
   * Bot 记下（或改掉、删掉）了一条长期记忆（见 docs/memory.md §9）。
   *
   * 存在的理由和 `skill/saved` 一字不差，只是更急一档：**员工要在事情发生的当下看见
   * 它**。一条记忆此后每一轮都摆在提示词里影响回答，而事后去 Bot 设置里翻等于没有
   * ——那一屏没人会没事去看。
   *
   * **不靠界面去扫工具结果的文本**：那段文本是写给模型的散文，措辞一改就扫不出来
   * （同 `ToolResult.files` 那条注释里的道理）。写下它的那把工具直接报出来。
   *
   * **开了「写入前需用户确认」的 Bot 不落这一条**：审批卡刚刚才摆在那儿、人亲手点的
   * 批准，紧接着再来一张「已保存」是同一件事说两遍。记忆的写入频率比 Skill 高得多，
   * 两张卡叠着刷会把对话挤成流水账。
   *
   * **不进模型上下文**（toAgentMessages 只认三种 role），所以它的全部代价是 JSONL 里
   * 多一行。加一种事件不是破坏性变更，不动 SESSION_FORMAT_VERSION：老界面读到不认识
   * 的 type 会跳过，退化成「少一张卡」——工具结果里那句「已记下」还在。
   */
  'memory/saved': {
    /** 写下它的那次工具调用。 */
    callId: string
    /** 库里的 id。界面拿它去删。 */
    id: string
    /** 正文。**删掉的那条也带着**——不然卡片上只剩一个 id，人不知道刚没了什么。 */
    text: string
    action: 'add' | 'replace' | 'remove'
    /** 这颗 Bot 自己记的还剩几条，以及上限。界面上那句「18/40」。 */
    used?: number
    max?: number
  }

  /**
   * 一次**委派**的状态（见 docs/delegation.md §12.2）。
   *
   * 和 `tool/call` / `tool/result` 分开，因为它们回答的是两个问题：那两条是「模型调了
   * 一把叫 delegate_task 的工具，拿回一段文本」，这一条是**界面上的一张卡**——而卡片
   * 必须能从日志重建：刷新页面、换标签页、断线重连之后，一次还在跑的委派不能就此消失。
   *
   * 同一个 `id` 会来多条（`running` → 终态），界面按 id 认，取最后一条。读法和
   * `tool/approval` / `human/handoff` 是同一套。
   *
   * 加一种事件不是破坏性变更（同 `session/compact` 的理由），所以不动
   * SESSION_FORMAT_VERSION。退化方向：老席位读到它当没看见，那次委派在界面上只剩一次
   * 普通的工具调用——**少一张卡，不丢正文**（结论在 tool/result 里）。
   */
  'agent/task': {
    /** 这一条委派。同一个 id 会来多条，取最后一条。 */
    id: string
    /** 开出这一批的那次工具调用。一批 N 条共用同一个 callId。 */
    callId: string
    /** 跑在哪条子会话上。界面上「看过程」点开的就是它。 */
    child: string
    /**
     * 一批里的第几条，从 0 开始。
     *
     * **结果按它排序，不按谁先跑完。** 模型下一句会说「第一件事的结论是…」，而完成
     * 顺序是随机的——谁先跑完谁排前面，等于让它每次都指错。
     */
    index: number
    /** 原样的 goal。卡片上那一行标题。 */
    goal: string
    /** `lost` = 进程重启，这一条的死活没人知道。写成 failed 是在编。 */
    state: 'running' | 'done' | 'capped' | 'timeout' | 'failed' | 'aborted' | 'lost'
    /** 结论。`done` 是全文；别的态放它停下来之前最后说的那段。 */
    summary?: string
    /** 它产出的文件，路径相对工作区根。界面照 tool/result 那套渲染。 */
    files?: { path: string; name: string }[]
    steps?: number
    toolCalls?: number
    /** 这一条花了多少。子会话的 assistant/message 累加出来的，不新增记账路径。 */
    usage?: Usage
    /**
     * 这一条实际跑在哪个模型上。
     *
     * **role 和 provider/id 都要留。** 只记 role 的话，平台没钉 utility 那段时间里的
     * 委派会显示成「按便宜的跑」，而它其实回落到了主模型上——账单和这行字对不上，
     * 而对不上的那几天恰恰是要查的那几天。
     */
    model?: {
      role: 'daily' | 'utility'
      provider: string
      id: string
      /** 主代理选这一档时给的理由（见 §8.3）。降过级就写降级后那一档的实情。 */
      reason?: string
      /** 降过级：写了 utility 却没给理由，或平台没钉 utility。人要看得出这一档不是主代理选的。 */
      downgraded?: boolean
    }
    at: number
  }

  'tool/call': { turn: number; step: number; callId: string; name: string; arguments: string }
  'tool/result': {
    turn: number
    step: number
    callId: string
    text: string
    /**
     * 工具原文过大时，text 仍保存完整审计内容；模型回放只使用这份受控文本。
     * 老日志没有该字段，回放层会即时套同一套预算。
     */
    modelText?: string
    /** 管道层失败（抛异常、超时、执行前被拒）。业务失败请写进 text。 */
    failed: boolean
    /**
     * 这次调用落地的文件，路径相对工作区根目录。界面据此给出可点开的预览。
     *
     * 可选字段，老日志没有——界面退回只显示工具名，**不去正则扫 text 猜路径**：
     * 那段文本是写给模型看的散文，措辞一改就扫不出来了。
     */
    files?: { path: string; name: string }[]
    /**
     * 这次调用**看到**的文件（`ls` 列出来的那一屏、`grep` 命中的那几个、`read` 读的
     * 那一个），路径相对工作区根目录。界面拿它把正文里出现的文件名变成能点开的链接。
     *
     * 和 files 分开：那一排是「产出了什么」，值得单独摆出来；这一条只是「正文里那个
     * 名字指的是哪个文件」，混进去的话一次 `ls` 就能把真正的产出埋掉。老日志没有，
     * 那就没有链接——同样**不去扫 text 猜路径**。
     */
    refs?: { path: string; name: string }[]
    /**
     * 这次调用之后页面长什么样（浏览器工具拍的，路径相对工作区根目录）。界面据此在
     * 这条消息底下摆一条缩略图。
     *
     * 和 files 分开：那一排是「产出了什么」，这一张是「过程中看到了什么」。老日志没有
     * 这个字段，界面照旧不显示。
     */
    shot?: { path: string; name: string }
  }
}

export type SessionEvent = {
  [T in keyof SessionEventMap]: EventEnvelope<T>
}[keyof SessionEventMap]
