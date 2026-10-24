/**
 * 派出去的活——委派（`agent/task`，docs/delegation.md）和派活（`bot/assign`，docs/bot-tasks.md）——
 * 在界面上共用的那一层：**过程怎么读成一步一步，跑着的时候进度怎么说**。
 *
 * 两种活跑在不同的地方（子代理在本席位的子会话里，派活在另一颗 Bot 自己的会话里），但人要问的
 * 是同一组问题：它在干什么、做到哪了、卡在哪、交回了什么。所以读法只写一份，两张卡都用它。
 *
 * 席位那头（bot/src/agent/progress.ts、manager/src/worker/tasks.ts）有一份同口径的进度计算，
 * 改这里的 `callDetail` / 进度形状要一起改——它们不依赖 core，是照着这份抄的。
 */

/**
 * 跑着的时候报上来的进度。三样都是「从它自己的事件里数出来的」，**不是估的**：
 * 没列清单就没有 `todo`，一样都不编——编一个进度出来比没有更糟，人会按着那个数估还要多久。
 */
export interface TaskProgress {
  /** 有工具调用的那几步，数过的（和委派的步数上限是同一个口径）。 */
  steps: number
  /** 当前这一步（或最近一步）调的工具，和它的关键参数一句话。 */
  tool?: { name: string; detail?: string }
  /** 它自己列的清单：做完几条、一共几条、正在做的那一条原话。 */
  todo?: { done: number; total: number; now?: string }
}

/** 过程里的一行：它说的一句话，或者一次工具调用（调用和结果按 callId 配成一对）。 */
export type TraceRow =
  | { kind: 'say'; text: string }
  | {
      kind: 'tool'
      callId: string
      name: string
      /** 参数里最能说明「拿什么跑」的那一个字段，见 callDetail。 */
      detail: string
      /** running = 还没回；blocked = 行为边界 / 审批挡下的；error = 工具自己失败了。 */
      status: 'running' | 'ok' | 'blocked' | 'error'
      /** 结果的第一句（截断）。完整原文在 full 里，点开才看。 */
      out: string
      full: string
    }

/** 这几个字段最能说明一次调用拿什么跑。按顺序取第一个有值的。 */
const DETAIL_KEYS = ['url', 'urls', 'query', 'q', 'command', 'cmd', 'path', 'file', 'paths', 'goal', 'instruction', 'task', 'name', 'id', 'text']

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length <= n ? one : one.slice(0, n - 1) + '…'
}

/**
 * 一次调用的关键参数，一句话。认不出的退回原始参数串的开头——**宁可丑也不留空**，
 * 留空的话人分不清是「没参数」还是「没读出来」。
 */
export function callDetail(args: unknown): string {
  let o: unknown = args
  if (typeof args === 'string') {
    try {
      o = args ? JSON.parse(args) : {}
    } catch {
      return clip(args, 120)
    }
  }
  if (!o || typeof o !== 'object') return ''
  const rec = o as Record<string, unknown>
  for (const k of DETAIL_KEYS) {
    const v = rec[k]
    if (typeof v === 'string' && v.trim()) return clip(v, 120)
    if (Array.isArray(v) && v.length) {
      const first = v.find((x) => typeof x === 'string' && x.trim())
      if (typeof first === 'string') return clip(first + (v.length > 1 ? ` 等 ${v.length} 个` : ''), 120)
    }
  }
  if (Array.isArray(rec.todos)) return `${rec.todos.length} 条`
  const raw = JSON.stringify(rec)
  return raw === '{}' ? '' : clip(raw, 120)
}

/**
 * 结果的第一句。工具结果是写给模型的散文，开头常是一行分隔（`── url ──`）或者一段
 * `<web_content>` 原文——那些不是人要看的那句，跳过去取第一行像话的。
 */
export function resultLine(text: string): string {
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (/^──.*──$/.test(line)) continue
    if (line.startsWith('<')) continue
    return clip(line, 160)
  }
  return ''
}

/** 一段事件里最后一张清单（`todo/list` 是全量快照，取最后一条）。没列过就是 undefined。 */
function todoOf(items: unknown): TaskProgress['todo'] {
  if (!Array.isArray(items)) return undefined
  const live = items.filter((i) => i && i.status !== 'cancelled')
  if (!live.length) return undefined
  const now = live.find((i) => i.status === 'in_progress')
  return {
    done: live.filter((i) => i.status === 'completed').length,
    total: live.length,
    ...(now && now.task ? { now: clip(String(now.task), 120) } : {}),
  }
}

type Ev = { type?: string; data?: any }

/**
 * 一段事件读成一步一步。
 *
 * **按 callId 配对，不按先后。** 它一次并行发几个调用时，结果回来的顺序和发出去的顺序不一样——
 * 按先后排，「搜到 10 条」就会挂在下一个 web_extract 底下，看着像是 web_extract 的结果。
 *
 * 被挡下的单独标出来：`tool/result.failed` 只说「没跑成」，分不出是边界挡的还是工具自己坏了，
 * 而这两件事人的处置完全不同（前者去改模版授权，后者看报错）。`tool/policy` 说得清。
 */
export function traceRows(events: Ev[]): TraceRow[] {
  const rows: TraceRow[] = []
  const byCall = new Map<string, Extract<TraceRow, { kind: 'tool' }>>()
  const blocked = new Set<string>()
  for (const ev of events || []) {
    const d = ev.data || {}
    if (ev.type === 'tool/policy' && d.callId && (d.outcome === 'blocked' || d.outcome === 'denied' || d.outcome === 'timeout')) {
      blocked.add(d.callId)
      const hit = byCall.get(d.callId)
      if (hit && hit.status === 'error') hit.status = 'blocked'
    }
  }
  for (const ev of events || []) {
    const d = ev.data || {}
    if (ev.type === 'assistant/message') {
      const content = d.message && d.message.content
      const text = Array.isArray(content)
        ? content.map((b: any) => (b && b.type === 'text' ? b.text || '' : '')).join('')
        : typeof content === 'string'
          ? content
          : ''
      if (text.trim()) rows.push({ kind: 'say', text: text.trim() })
    } else if (ev.type === 'tool/call') {
      const row: Extract<TraceRow, { kind: 'tool' }> = {
        kind: 'tool',
        callId: String(d.callId || ''),
        name: String(d.name || ''),
        detail: callDetail(d.arguments),
        status: 'running',
        out: '',
        full: '',
      }
      rows.push(row)
      if (row.callId) byCall.set(row.callId, row)
    } else if (ev.type === 'tool/result') {
      const hit = d.callId ? byCall.get(d.callId) : undefined
      if (!hit) continue
      hit.full = String(d.text || '')
      hit.out = resultLine(hit.full)
      hit.status = d.failed ? (blocked.has(hit.callId) ? 'blocked' : 'error') : 'ok'
    }
  }
  return rows
}

/** 从一段事件里数出进度。和席位那头报上来的是同一个口径（见文件头）。 */
export function progressOf(events: Ev[]): TaskProgress {
  const steps = new Set<string>()
  let tool: TaskProgress['tool']
  let todo: TaskProgress['todo']
  for (const ev of events || []) {
    const d = ev.data || {}
    if (ev.type === 'tool/call') {
      steps.add(`${d.turn ?? ''}:${d.step ?? ''}`)
      tool = { name: String(d.name || ''), detail: callDetail(d.arguments) }
    } else if (ev.type === 'todo/list') {
      todo = todoOf(d.items)
    }
  }
  return { steps: steps.size, ...(tool ? { tool } : {}), ...(todo ? { todo } : {}) }
}

/**
 * 派活那一件在对方会话里的那一段：从带着这个任务 id 的那条指令起，到它那一轮收口为止。
 *
 * 对方是一颗有自己对话的 Bot，那条会话里还有人跟它的日常来往——整段拿来当「过程」，人会
 * 以为那些也是这件活的一部分。指令插进了它正在跑的那一轮（steered）时，那一轮剩下的也算进来：
 * 它就是在那一轮里接着做的。
 */
export function assignSlice(events: Ev[], taskId: string): Ev[] {
  const list = events || []
  const at = list.findIndex(
    (ev) => ev.type === 'user/message' && ev.data?.source?.plugin === 'task' && ev.data?.source?.form === taskId && ev.data?.source?.phase !== 'result',
  )
  if (at < 0) return []
  const out: Ev[] = []
  let turn: number | null = null
  for (let i = at + 1; i < list.length; i++) {
    const ev = list[i]
    if (ev.type === 'turn/start' && turn === null) turn = Number(ev.data?.turn)
    out.push(ev)
    if (ev.type === 'turn/end' && (turn === null || Number(ev.data?.turn) === turn)) break
  }
  return out
}
