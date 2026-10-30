import type { Mention, MessageSource } from '../agent/index.ts'
import type { SessionEvent } from '../session/types.ts'
import type { TodoItem } from '../tools/todo.ts'

export interface ChannelMentionCandidate {
  id: string
  label: string
}

export type ChannelCommand = 'new' | 'tasks' | 'mentions'

/** Telegram 的命令可以带 Bot username（群里常见）；私聊也按同一形状兼容。 */
export function channelCommand(text: string): ChannelCommand | null {
  const hit = /^\/(new|tasks|mentions)(?:@[A-Za-z0-9_]+)?$/i.exec(String(text || '').trim())
  return hit ? hit[1].toLowerCase() as ChannelCommand : null
}

/**
 * `/model`：不带参数是列出能选的，带参数是换。参数可以是序号、`default`/`默认`、
 * `provider/model`、模型 id 或显示名——Telegram 里没有选单，人会照着上一条列表里看到的
 * 随手打一个。参数原样交给 pickModelArg 去名单里认。
 */
export function channelModelCommand(text: string): { arg: string } | null {
  const hit = /^\/model(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim())
  return hit ? { arg: (hit[1] || '').trim() } : null
}

/** 渠道命令只要这几样，不直接依赖 agents 的类型——这个文件是纯函数，探针直接 import。 */
interface ChannelModelChoice {
  key: string
  model: string
  label: string
  isDefault: boolean
}

/**
 * 把 `/model` 后面那截认成名单里的一项。认不出来返回 null，**不猜最接近的那个**——
 * 换错模型的代价是接下来每一轮都用错，比让人再打一次贵得多。
 *
 * **Web 和渠道共用这一份**：网页输入框里的 `/model 2` 也是原样交给席位（PUT 的 `arg`），
 * 由这里认。两边各写一份的话，迟早一边认得「默认」、另一边不认。
 */
export function pickModelArg<T extends ChannelModelChoice>(arg: string, options: T[]): T | null {
  const q = arg.trim().toLocaleLowerCase()
  if (!q) return null
  if (q === 'default' || q === '默认') return options.find((c) => c.isDefault) ?? null
  if (/^\d+$/.test(q)) return options[Number(q) - 1] ?? null
  const exact = options.find((c) => c.key.toLocaleLowerCase() === q)
  if (exact) return exact
  const byId = options.filter((c) => c.model.toLocaleLowerCase() === q)
  if (byId.length === 1) return byId[0]
  const byLabel = options.filter((c) => c.label.toLocaleLowerCase() === q)
  return byLabel.length === 1 ? byLabel[0] : null
}

export function channelModelHelp(state: { effective: ChannelModelChoice; options: ChannelModelChoice[] }): string {
  const lines = state.options.map((c, i) => {
    const on = c.key === state.effective.key ? ' ← 当前' : ''
    const def = c.isDefault ? '（默认）' : ''
    return `${i + 1}. ${markdownInline(c.label)}${def} \`${c.key}\`${on}`
  })
  const tail = state.options.length > 1
    ? '发送 `/model 序号` 切换，例如 `/model 2`；`/model default` 回到默认。从下一轮起生效。'
    : '平台目前只配了这一个日常模型，没有可换的。'
  return ['## 日常模型', '', ...lines, '', tail].join('\n')
}

function markdownInline(text: string): string {
  return String(text || '').replace(/([\\`*_[\]<>~])/g, '\\$1')
}

/** Telegram 里可直接输入的、不含空格和标点的 @ 名字。 */
export function channelMentionAlias(label: string): string {
  return String(label || '')
    .normalize('NFKC')
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
}

interface AliasRow { alias: string; candidate: ChannelMentionCandidate }

function canonicalAliases(candidates: ChannelMentionCandidate[]): AliasRow[] {
  const bases = candidates.map((candidate) => channelMentionAlias(candidate.label) || 'connection')
  const totals = new Map<string, number>()
  for (const base of bases) totals.set(base.toLocaleLowerCase(), (totals.get(base.toLocaleLowerCase()) || 0) + 1)
  const seen = new Map<string, number>()
  return candidates.map((candidate, i) => {
    const base = bases[i]
    const key = base.toLocaleLowerCase()
    const nth = (seen.get(key) || 0) + 1
    seen.set(key, nth)
    return { alias: (totals.get(key) || 0) > 1 ? `${base}_${nth}` : base, candidate }
  })
}

function aliasesOf(candidates: ChannelMentionCandidate[]): AliasRow[] {
  const byAlias = new Map<string, ChannelMentionCandidate[]>()
  const add = (alias: string, candidate: ChannelMentionCandidate) => {
    const key = alias.trim().toLocaleLowerCase()
    if (!key) return
    const list = byAlias.get(key) || []
    if (!list.some((x) => x.id === candidate.id)) list.push(candidate)
    byAlias.set(key, list)
  }
  for (const candidate of candidates) {
    add(candidate.label, candidate)
    add(channelMentionAlias(candidate.label), candidate)
    // `Gmail (personal)` 只有一把时允许简写 @Gmail；有两把时因歧义不会加入。
    add(candidate.label.replace(/\s*[（(][^）)]*[）)]\s*$/, ''), candidate)
  }
  // 标签完全相同也必须各有一个可输入的名字；编号只在这种冲突时出现。
  for (const row of canonicalAliases(candidates)) add(row.alias, row.candidate)
  return [...byAlias.entries()]
    .filter(([, rows]) => rows.length === 1)
    .map(([alias, rows]) => ({ alias, candidate: rows[0] }))
    .sort((a, b) => b.alias.length - a.alias.length)
}

function boundary(rest: string, length: number): boolean {
  const next = rest.slice(length, length + 1)
  return !next || /[\s,，。.!！?？:：;；]/u.test(next)
}

/**
 * Telegram 没有 Web 的 @ 选单药丸，约定点名写在消息开头：
 * `@Gmail_personal @Notion 查邮件并建页`。解析后仍传结构化 Mention，不把名字混进正文。
 */
export function parseChannelMentions(text: string, candidates: ChannelMentionCandidate[]): {
  text: string
  mentions: Mention[]
  unknown: string
} {
  let rest = String(text || '').trim()
  const aliases = aliasesOf(candidates)
  const mentions: Mention[] = []
  let unknown = ''
  while (rest.startsWith('@')) {
    const lower = rest.slice(1).toLocaleLowerCase()
    const hit = aliases.find((row) => lower.startsWith(row.alias) && boundary(lower, row.alias.length))
    if (!hit) {
      unknown = /^@([^\s,，。.!！?？:：;；]+)/u.exec(rest)?.[1] || rest.slice(1)
      break
    }
    if (!mentions.some((m) => m.id === hit.candidate.id)) {
      mentions.push({ kind: 'connector', id: hit.candidate.id, label: hit.candidate.label })
    }
    rest = rest.slice(hit.alias.length + 1).replace(/^[\s,，:：;；]+/u, '')
  }
  return { text: rest, mentions, unknown }
}

export function channelMentionHelp(candidates: ChannelMentionCandidate[]): string {
  if (!candidates.length) return '当前没有可用的 @ 连接。请先在 Web 的「连接器」页面完成连接。'
  return [
    '## 可用的 @ 连接',
    '',
    ...canonicalAliases(candidates).map((row) => `- \`@${row.alias}\` — ${markdownInline(row.candidate.label)}`),
    '',
    '把一个或多个 @ 名字写在消息开头，然后接正文。',
  ].join('\n')
}

/** Web 用固定 dock；Telegram 在每轮最终回复底部发送同一份持久化任务状态。 */
export function channelTodoMarkdown(items: TodoItem[]): string {
  if (!items.length) return ''
  const done = items.filter((item) => item.status === 'completed').length
  const mark: Record<TodoItem['status'], string> = {
    pending: '',
    in_progress: '▶ ',
    completed: '',
    cancelled: '✗ ',
  }
  return [
    `## 任务 · ${done}/${items.length} 已完成`,
    '',
    ...items.map((item) => {
      const checked = item.status === 'completed' ? 'x' : ' '
      const task = markdownInline(item.task)
      return `- [${checked}] ${mark[item.status]}${item.status === 'cancelled' ? `~~${task}~~` : task}`
    }),
  ].join('\n')
}

export function withChannelTodos(reply: string, items: TodoItem[]): string {
  const list = channelTodoMarkdown(items)
  return list ? `${String(reply || '').trim()}\n\n---\n\n${list}`.trim() : String(reply || '').trim()
}

/** 这一条是不是这条渠道消息（`eventId`）落下的那条 user/message。 */
export function isChannelMessage(event: SessionEvent, eventId: string): boolean {
  if (event.type !== 'user/message') return false
  const source = (event.data as { source?: MessageSource }).source
  return source?.kind === 'plugin' && source.plugin === 'channel' && source.form === eventId
}

/**
 * 这条渠道消息开的那一轮：消息在哪（`message`）、它后面第一个 turn/start 在哪（`start`）、轮号。
 * 消息没找到、还没开轮、轮号不是数，都是 null。
 */
function channelTurn(events: SessionEvent[], eventId: string): { message: number; start: number; turn: number } | null {
  const message = events.findIndex((event) => isChannelMessage(event, eventId))
  if (message < 0) return null
  const offset = events.slice(message + 1).findIndex((event) => event.type === 'turn/start')
  if (offset < 0) return null
  const start = message + 1 + offset
  const turn = Number((events[start].data as { turn?: unknown } | undefined)?.turn)
  return Number.isFinite(turn) ? { message, start, turn } : null
}

/**
 * 渠道这一轮目前已经写到哪儿——给 Telegram 的 sendMessageDraft 用。
 *
 * **只往后长，不回头改。** Telegram 客户端给同一个 draft_id 的草稿做打字动画：新的一帧以
 * 上一帧开头，它只播长出来的那一截；不是的话从分叉处（常常就是开头）重播。以前这里把
 * 「🔧 工具调用」那张状态表固定压在末尾——于是工具一出现，下一步的正文插在它**前面**、
 * ⏳ 改成 ✓ 改的是已经发出去的那几行，每一帧都在中间变，用户看到的就是「前面那段一遍
 * 遍重打，直到最后才完整」。
 *
 * 所以按事件**发生的顺序**拼：正文的 text-delta 一路往后接；工具调用在它发生的位置接一行
 * 「🔧 名字」，之后不再回头改它的状态（完成与否看最终回复，Web 上有完整痕迹），参数和
 * 结果一概不进草稿。一步收口时那条 assistant/message 和前面的 delta 是同一句话：只拿它
 * 补齐 delta 缺掉的尾巴（比如不流式、只落一条完整消息的模型），以已接上的 delta 开头才补，
 * 否则不动——宁可草稿少几个字，也不能把已经发出去的改掉。正式回复发出后 Telegram 自动清掉
 * 草稿，工具过程不会留在记录里。
 */
export function channelDraft(events: SessionEvent[], eventId: string): string {
  const at = channelTurn(events, eventId)
  if (!at) return ''
  const { message: start, turn } = at

  let draft = ''
  // 上一段接的是什么：换一种（正文 ↔ 工具）或者换了一步，先空一行再接；连着几个工具各占
  // 一行。分隔符只加在**新内容之前**，草稿末尾永远不挂着等下一段的空行——那样的空行会被
  // 两头的 trim 吃掉又长回来，同样破坏「以上一帧开头」。
  let last: { kind: 'text' | 'tool'; step: number } | null = null
  const stepText = new Map<number, string>()
  const put = (kind: 'text' | 'tool', step: number, piece: string) => {
    if (!piece) return
    if (draft && last) {
      // 先收掉末尾的空白再接分隔：正文自己带的换行加上这里的空行会叠成两三行。发出去的
      // 每一帧本来就是 trim 过的（草稿泵），收掉之后仍以上一帧开头。
      if (last.kind === 'tool' && kind === 'tool') draft = draft.trimEnd() + '\n'
      else if (last.kind !== kind || last.step !== step) draft = draft.trimEnd() + '\n\n'
    }
    draft += piece
    last = { kind, step }
  }
  for (const event of events.slice(start + 1)) {
    const data = event.data as {
      turn?: unknown
      step?: unknown
      name?: unknown
      chunk?: { type?: string; text?: unknown }
      message?: { content?: unknown }
    }
    if (Number(data.turn) !== turn) continue
    const step = Number(data.step)
    if (!Number.isFinite(step)) continue
    if (event.type === 'assistant/chunk' && data.chunk?.type === 'text-delta' && typeof data.chunk.text === 'string') {
      const have = stepText.get(step) ?? ''
      // 一步的第一段 delta 前面的空白不要：它会变成两段之间多出来的空行。
      const piece = have ? data.chunk.text : data.chunk.text.replace(/^\s+/, '')
      stepText.set(step, have + piece)
      put('text', step, piece)
    } else if (event.type === 'assistant/message') {
      const content = data.message?.content
      const settled = Array.isArray(content)
        ? content
          .filter((block): block is { type: 'text'; text: string } =>
            block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('')
          .replace(/^\s+/, '')
        : ''
      const have = stepText.get(step) ?? ''
      // 只补尾巴：完整消息以已经接上的 delta 开头才补；收口时改了措辞的不动。
      if (settled.length > have.length && settled.startsWith(have)) {
        stepText.set(step, settled)
        put('text', step, settled.slice(have.length))
      }
    } else if (event.type === 'tool/call') {
      const name = Array.from(String(data.name ?? '').replace(/\s+/g, ' ').trim()).slice(0, 80).join('')
      if (name) put('tool', step, `🔧 ${name}`)
    }
  }
  return draft.trimEnd()
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
  const at = channelTurn(events, eventId)
  if (!at) return []
  const { message: start, turn } = at

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
  const at = channelTurn(events, eventId)
  if (!at) return []
  const { start, turn } = at
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

/** 这条渠道消息那一轮的最终回复（各条 assistant/message 的正文拼起来）。那一轮还没收口就是 null。 */
export function channelReply(events: SessionEvent[], eventId: string): string | null {
  const turn = channelTurn(events, eventId)?.turn
  if (turn === undefined) return null
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
