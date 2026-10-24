/**
 * 会话事件的信封与界面折出来的块。字段表见 docs/session-event-field-map.md。
 *
 * `data` 故意宽松：事件族几十种、每种键不同，这里要的是「信封有 seq/time/type」这一层
 * 契约，各族的键由用的那一支自己读。
 */
export interface SessionEvent {
  /** 会话日志的行号，单调递增。老日志、本地回显那条可能没有。 */
  seq?: number
  /** bot 那边 append 时打的时间（epoch 毫秒）。 */
  time?: number
  type: string
  data?: any
}

/** 用户消息正文里的一块（会话格式 v4 起）。 */
export interface MessageBlock {
  type: 'text' | 'reasoning' | 'image' | 'mention' | 'ref' | string
  text?: string
  path?: string
  mime?: string
  kind?: string
  id?: string
  label?: string
  inline?: boolean
  logo?: string
  name?: string
  seq?: number
  role?: string
  excerpt?: string
  time?: number
}

export interface Message {
  id?: string
  role?: string
  content?: string | MessageBlock[]
}

export interface Mention {
  kind: string
  id: string
  label: string
  /** 落在正文里它被打出来的位置上（会话里的 mention 块带 inline）。界面就地画成药丸，不另起一排。 */
  inline?: boolean
  /** 连接器的图标地址，点名时存进消息的。候选里查不到这条连接时照样画得出图标。 */
  logo?: string
}

export type Ref =
  | { kind: 'file'; path: string; name: string }
  | { kind: 'message'; seq: number | null; role: 'user' | 'assistant'; excerpt: string; time: number }

export interface ToolCall {
  callId: string
  name: string
  args: string
  result: string | null
  failed: boolean
  files?: any[] | null
  refs?: any[] | null
  shot?: any
}

export interface UserBlock {
  kind: 'user'
  text: string
  files: { path: string; name: string }[]
  mentions: Mention[]
  refs: Ref[]
  via: string
  raw: string
  images: { path: string; mime: string }[]
  time: number
  seq?: number
  pending?: boolean
}

export interface AssistantBlock {
  kind: 'assistant'
  text: string
  tools: ToolCall[]
  via: string
  time: number
  seq?: number
  msgSeq?: number
  endTime?: number
  tasks?: any[]
  skillNotes?: any[]
  memNotes?: any[]
  approvals?: any[]
  handoffs?: any[]
}

export interface MarkBlock {
  kind: 'mark'
  mark: 'compact' | 'reset' | 'clear' | 'model'
  time: number
  seq?: number
  [k: string]: any
}

/**
 * 主 Bot 派出去的一件活（会话里的 `bot/assign`，docs/bot-tasks.md §4）。画成一条「那颗 Bot 发的
 * 消息」，插在主 Bot 派活那段话和它拿到结论之后那段话之间。同一个 id 来多条，取最后一条。
 */
export interface TaskBlock {
  kind: 'task'
  id: string
  callId: string
  index: number
  total: number
  taskId?: string
  bot: { id: string; name: string }
  instruction: string
  after?: string[]
  state: 'waiting' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled' | 'detached'
  result?: string
  startedAt?: number
  endedAt?: number
  time: number
  seq: number
}

export type Block = UserBlock | AssistantBlock | MarkBlock | TaskBlock

export interface Folded {
  blocks: Block[]
  /** '' | 'running' | 'sending' */
  status: string
  statusAt: number
  todos: { items: any[]; seq?: number } | null
  channelVia: boolean
  modelSeq: number
}

/** 名单上一颗 Bot 的摘要：在不在跑、最近说了什么、等不等人。 */
export interface RosterSum {
  state: 'idle' | 'busy' | 'review'
  need?: '' | 'approval' | 'handoff'
  lastAt: number
  lastText: string
  busy?: boolean
  openIds?: Set<string> | null
  snapIds?: Set<string> | null
  asks?: Map<string, { callId: string; name: string; reason: string; at: number; seq: number }> | null
}

/** 本地回显的一条（发出去还没收到回执）。 */
export interface PendingMessage {
  sessionId: string
  text: string
  images?: any[]
  mentions?: Mention[]
  refs?: Ref[]
  at: number
  afterSeq: number
}

/** 每条会话的翻页状态。 */
export interface ChatPage {
  firstSeq?: number
  hasMore?: boolean
  loading?: boolean
}
