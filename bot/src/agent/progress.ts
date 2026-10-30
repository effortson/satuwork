import type { TaskProgress } from '../session/types.ts'

/**
 * 派出去的活跑着的时候，从它那一轮的事件里数出进度（docs/delegation.md §13「跑着的那几分钟」）。
 *
 * 两处在用：委派（agent/index.ts 的 runTask 听子会话的事件）和本地 Bot 领的派活
 * （local-tasks 读目标那一轮的事件流）。机器上的工人（manager/src/worker/tasks.ts）有一份同口径的，
 * 界面那份在 core/src/chat/task.ts——**改口径三处一起改**。
 *
 * 只数三样：有工具调用的步数、最近一次调了什么、它自己列的清单。没列清单就没有 todo——
 * 不编进度，编出来的数人会拿去估还要等多久。
 */

/** 这几个字段最能说明一次调用拿什么跑。按顺序取第一个有值的。 */
const DETAIL_KEYS = ['url', 'urls', 'query', 'q', 'command', 'cmd', 'path', 'file', 'paths', 'goal', 'instruction', 'task', 'name', 'id', 'text']

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length <= n ? one : one.slice(0, n - 1) + '…'
}

/** 一次调用的关键参数，一句话。认不出的退回原始参数串的开头。 */
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

type Ev = { type?: string; data?: any }

export class ProgressTracker {
  private steps = new Set<string>()
  private tool: TaskProgress['tool']
  private todo: TaskProgress['todo']
  private sig = ''

  /** 喂一条事件。进度变了回 true。 */
  feed(ev: Ev): boolean {
    const d = ev.data || {}
    if (ev.type === 'tool/call') {
      this.steps.add(`${d.turn ?? ''}:${d.step ?? ''}`)
      this.tool = { name: String(d.name || ''), detail: callDetail(d.arguments) }
    } else if (ev.type === 'todo/list' && Array.isArray(d.items)) {
      const live = d.items.filter((i: any) => i && i.status !== 'cancelled')
      const now = live.find((i: any) => i.status === 'in_progress')
      this.todo = live.length
        ? { done: live.filter((i: any) => i.status === 'completed').length, total: live.length, ...(now?.task ? { now: clip(String(now.task), 120) } : {}) }
        : undefined
    } else return false
    const sig = JSON.stringify(this.snapshot())
    if (sig === this.sig) return false
    this.sig = sig
    return true
  }

  snapshot(): TaskProgress {
    return { steps: this.steps.size, ...(this.tool ? { tool: this.tool } : {}), ...(this.todo ? { todo: this.todo } : {}) }
  }
}
