import type { Context } from '@deepseek-ai/cordis'
import { fail, registerTool } from './common.ts'

/**
 * 一把工具：`todo`，这条会话的任务清单。
 *
 * **为什么需要它。** 一轮最多能连跑 120 步（agent 的 maxSteps），而模型在第 40 步时
 * 唯一能依靠的「我本来打算做什么」是它自己几十条消息之前说过的一段话——那段话在
 * 上下文里越来越靠后，被压缩之后干脆就没了（session/compact）。于是长活的典型死法
 * 不是做错，是**做漏**：五件事做完三件，收口时说得像五件都做了。清单把这份意图从
 * 「对话里的一句话」挪成「一份读得回来的状态」。
 *
 * **名字和形状照 Hermes / Claude Code 那套来**（理由同 tools/web.ts：模型见过这个
 * 名字，schema 越接近它熟悉的约定，调用就越准）。一把工具两种用法：不带参数 = 读，
 * 带 `todos` = 写。
 *
 * **存 SQLite，不存会话日志。** 它是一份**会被改写**的状态，而会话日志是只增不减的
 * 事件流；把每次勾选都写成事件，历史里就会躺着同一张表的几十个版本，而模型重建
 * 历史时会把它们全看一遍。放 documents 表里按 sessionId 存一份最新的，跨重启还在，
 * 上下文压掉了也还在——这正是「拿不准做到哪儿了就调一次 todo」敢这么说的前提。
 *
 * **只看自己这条会话。** `call.sessionId` 由执行管道给，模型改不了（理由同
 * tools/history.ts）。
 */
export const name = 'satu-tools-todo'
/**
 * `sessions` 只为一件事：每次改动之后往日志里补一条 `todo/list` 快照，好让输入框上面
 * 那块 dock 跟着变（见 session/types.ts 里那一段）。**清单本身不存在事件里**，理由见
 * 上面。
 */
export const inject = ['tools', 'storage', 'sessions']

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export interface TodoItem {
  /** 列表里 `[n]` 那个编号。整表替换时按位置重发，merge 靠它定位。 */
  id: string
  task: string
  status: TodoStatus
}

const STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed', 'cancelled']

const MARK: Record<TodoStatus, string> = {
  pending: '☐',
  in_progress: '▶',
  completed: '☑',
  cancelled: '✗',
}

/**
 * 清单要有界：它每次写入都整份回给模型，一张两百条的表能把一轮的上下文吃掉一大块。
 * 而真需要两百步的活，正确的做法是先拆成几件大的，不是列两百行。
 */
const MAX_ITEMS = 50
/** 单条的长度。一句话说清一步就够，细节留到做那一步的时候。 */
const MAX_TASK = 200

/** documents 表里的集合名。key 是 sessionId。 */
const COLLECTION = 'todos'

/**
 * 这条会话现在的清单。
 *
 * 导出给席位的 HTTP 那一跳用（`GET /api/sessions/:id/todos`）：`todo/list` 事件只解决
 * 「盯着看的时候它会动」，解决不了「刚打开这一页」——流上只垫最近一轮，而一张三天前
 * 列出来、还没做完的表恰恰不在里面。集合名只有这一个地方知道。
 */
export function readTodos(ctx: Context, sessionId: string): TodoItem[] {
  return ctx.storage.collection<TodoItem[]>(COLLECTION).get(sessionId) ?? []
}

/**
 * 新一轮真正开始时收掉上一轮已经结束的清单。
 *
 * 未完成清单必须跨轮保留；全部 completed / cancelled 的清单则只在收口那次展示一次，
 * 下一条消息进来便清掉。Telegram 和 Web 共用主会话，所以同时补一条空快照，让 Web
 * 输入框上方的任务 dock 也立即消失，而不是等刷新后才跟持久化状态一致。
 */
export async function clearSettledTodos(ctx: Context, sessionId: string, callId: string): Promise<boolean> {
  const col = ctx.storage.collection<TodoItem[]>(COLLECTION)
  const items = col.get(sessionId) ?? []
  if (!items.length || items.some((item) => item.status === 'pending' || item.status === 'in_progress')) return false
  col.delete(sessionId)
  try {
    await ctx.sessions.append(sessionId, 'todo/list', { callId, items: [] })
  } catch (e) {
    ctx.logger?.warn?.(`todo: 已结束清单清空后，快照事件没写进去 ${(e as Error).message}`)
  }
  return true
}

/**
 * 主 Bot 派来的活收口时，把清单放回它开跑之前的样子（docs/bot-tasks.md §7）。
 *
 * 清单是整条会话一份，派活那一轮列的步骤会留在这里：活被停了，输入框上面还挂着「正在执行 0/4」，
 * 而提示词又叫模型「拿不准做到哪儿了就读一次 todo」——上下文里去掉了那一轮，它照样从清单里把
 * 作废的活读回来接着做。派活那一轮的清单只属于那一轮。没变过就不动。
 */
export async function restoreTodos(ctx: Context, sessionId: string, before: TodoItem[], callId: string): Promise<boolean> {
  const col = ctx.storage.collection<TodoItem[]>(COLLECTION)
  const now = col.get(sessionId) ?? []
  if (JSON.stringify(now) === JSON.stringify(before)) return false
  if (before.length) col.put(sessionId, before)
  else col.delete(sessionId)
  try {
    await ctx.sessions.append(sessionId, 'todo/list', { callId, items: before })
  } catch (e) {
    ctx.logger?.warn?.(`todo: 派活收口放回清单之后，快照事件没写进去 ${(e as Error).message}`)
  }
  return true
}

/**
 * 状态别名。
 *
 * 通常的口径是「模型写错了参数就告诉它，让它改」（见 tools/common.ts），但这几个
 * 不属于写错：`done` / `doing` 跟 `completed` / `in_progress` 指的是同一件事，没有
 * 第二种解释，为它们回一次失败纯粹是让模型多跑一轮。**有歧义的仍然拒**。
 */
const ALIAS: Record<string, TodoStatus> = {
  todo: 'pending',
  open: 'pending',
  doing: 'in_progress',
  active: 'in_progress',
  done: 'completed',
  complete: 'completed',
  canceled: 'cancelled',
  skipped: 'cancelled',
}

function readStatus(raw: unknown, whose: string): TodoStatus {
  if (raw == null || raw === '') return 'pending'
  const key = String(raw).trim().toLowerCase().replace(/[\s-]+/g, '_')
  if ((STATUSES as string[]).includes(key)) return key as TodoStatus
  // `hasOwn` 不是讲究：`ALIAS[key]` 查的是原型链，而 `constructor` 和 `__proto__`
  // 本来就是小写，上面那次 toLowerCase 拦不住。命中的话会返回一个函数 / 一个对象当
  // 状态，落库时 JSON.stringify 又把它整个丢掉——那条待办从此没有 status：回给模型的
  // 行是 `[1] undefined 任务名`，完成计数和「只能一条 in_progress」都不再看见它。
  if (Object.hasOwn(ALIAS, key)) return ALIAS[key]
  fail(`${whose}的 status 不认识：${String(raw)}。只能是 ${STATUSES.join(' / ')}。`)
}

function readTask(raw: unknown, whose: string): string {
  const task = String(raw ?? '').replace(/\s+/g, ' ').trim()
  if (!task) fail(`${whose}缺少 task（要做的那件事，一句祈使句）。`)
  if (task.length > MAX_TASK) {
    fail(`${whose}的 task 太长（${task.length} 字符，上限 ${MAX_TASK}）。一句话说清一步就够，细节留到做那一步的时候。`)
  }
  return task
}

/** 模型给的一条。`content` 是 Claude Code 那套 TodoWrite 的字段名，一并认下来。 */
interface TodoInput {
  id?: unknown
  task?: unknown
  content?: unknown
  status?: unknown
}

const hasTask = (row: TodoInput) => row.task !== undefined || row.content !== undefined

function capacity(count: number): void {
  if (count > MAX_ITEMS) {
    fail(`清单最多 ${MAX_ITEMS} 条，这次会变成 ${count} 条。先把它拆成几件大的，别把每个细节都列成一行。`)
  }
}

/**
 * 整表替换：`todos` 就是列表接下来的全部内容。
 *
 * **id 按位置重发**，不保留旧编号。清单是工作台不是台账，条目没有需要跨版本追踪的
 * 身份；而位置编号和渲染出来的 `[n]` 永远一致——模型下一次 merge 报的那个 id，就是
 * 它刚刚在结果里读到的那个。
 */
function replaceWith(rows: TodoInput[]): TodoItem[] {
  capacity(rows.length)
  return rows.map((row, i) => {
    const whose = `第 ${i + 1} 条`
    if (row?.id !== undefined && String(row.id).trim()) {
      // 带 id 却没开 merge：多半是想改某一条，结果整张表被这一条盖掉了。这是**静默
      // 丢数据**的那一类错，宁可拦下来问一句。
      fail(
        `${whose}带了 id，但这次是整表替换——那会把清单里其他条目全部删掉。` +
          `只想改某几条就加 merge=true；确实要整表重写就把 id 去掉，重发完整的一份。`,
      )
    }
    return {
      id: String(i + 1),
      task: readTask(row?.task ?? row?.content, whose),
      status: readStatus(row?.status, whose),
    }
  })
}

/**
 * 增量：只动 `todos` 里点到的那几条。有 id 的按 id 改，没 id 的追加，其余原样不动。
 *
 * 改一条的状态是这把工具最高频的用法（「第 3 条做完了」），而整表替换要求模型把
 * 整张表原样重发一遍——它每重发一次，就有一次抄错、抄漏的机会。
 */
function mergeInto(current: TodoItem[], rows: TodoInput[]): TodoItem[] {
  if (!rows.length) fail('merge=true 但 todos 是空的，没有要改的东西。清空清单请用整表替换（不带 merge，todos 给空数组）。')
  const next = current.map((item) => ({ ...item }))
  rows.forEach((row, i) => {
    const whose = `第 ${i + 1} 条`
    const id = row?.id == null ? '' : String(row.id).trim()
    if (!id) {
      next.push({ id: '', task: readTask(row?.task ?? row?.content, whose), status: readStatus(row?.status, whose) })
      return
    }
    const hit = next.find((item) => item.id === id)
    if (!hit) {
      const ids = next.map((item) => item.id).join('、')
      fail(`${whose}的 id=${id} 不在清单里。现有编号：${ids || '（清单是空的）'}。要加新条目就别给 id。`)
    }
    if (hasTask(row)) hit.task = readTask(row.task ?? row.content, whose)
    if (row?.status !== undefined) hit.status = readStatus(row.status, whose)
  })
  capacity(next.length)
  // 追加进来的接着最大号往下发。**不重排老条目**——merge 的全部前提就是编号不动。
  let seq = next.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0)
  for (const item of next) if (!item.id) item.id = String(++seq)
  return next
}

/**
 * 渲染整张表回给模型。**每次都整份回**，不只回改动的那一条：模型下一步要照着它
 * 决定做什么，而「它以为的表」和「真正的表」一旦分叉，后面每一次 merge 都是错的。
 */
function render(items: TodoItem[]): string {
  const done = items.filter((i) => i.status === 'completed').length
  const lines = [`待办 ${done}/${items.length} 完成：`]
  for (const item of items) lines.push(`[${item.id}] ${MARK[item.status]} ${item.task}`)
  const running = items.find((i) => i.status === 'in_progress')
  const open = items.filter((i) => i.status === 'pending')
  lines.push('')
  if (running) lines.push(`当前在做：[${running.id}] ${running.task}`)
  else if (open.length) {
    lines.push(`还没有进行中的条目。动手做哪一条，先把它标成 in_progress：merge=true，只报那一条的 id 和 status。`)
  } else lines.push('全部收口了。')
  return lines.join('\n')
}

export function apply(ctx: Context) {
  registerTool(
    ctx,
    {
      name: 'todo',
      /**
       * **不标 rebind**，尽管它按 sessionId 存东西。
       *
       * 清单属于**这次执行**，不属于这场对话：子代理是一次独立的执行，它当然该有自己的
       * 一份。标上 rebind 的话，子代理一开工就把主代理的清单整份覆盖掉（这里是整表替换），
       * 人正看着的那块 dock 当场变成子任务的步骤。见 docs/delegation.md §6.1。
       */
      delegation: {},
      /**
       * 它确实改了会落盘的状态，所以是 `write` 而不是 `read`——风险标注宁可往严了写
       * （见 tools/index.ts 的 UNKNOWN_RISK）。这不会带来一张确认卡片：要人拍板的是
       * 「对外的写」和「能不可逆毁东西的」，工作区内的写本来就是干活的常态
       * （见 policy/index.ts 的 needsApproval）。
       */
      risk: ['write'],
      description:
        '管理这条会话的任务清单。**三步以上的复杂任务、或者用户一次交代了好几件事**时用它：动手之前先把步骤列出来，每做完一步立刻回来更新。' +
        '不带任何参数调用 = 读回当前清单（它跨轮、跨重启都在，前面的对话被摘要压掉之后也还在，拿不准做到哪儿了就调一次）。' +
        '带 todos 数组 = 写入。一两步就能做完的活不要列，那只是噪音。',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description:
              '要写入的条目。不给这个参数就是只读。默认**整表替换**：这个数组就是清单接下来的全部内容，给空数组等于清空。',
            items: {
              type: 'object',
              properties: {
                id: {
                  type: 'string',
                  description: '已有条目的编号（清单里 `[n]` 那个）。只在 merge=true 时用；追加新条目时不要给。',
                },
                task: { type: 'string', description: `要做的一件事，一句祈使句，${MAX_TASK} 字符以内。` },
                status: {
                  type: 'string',
                  enum: STATUSES,
                  description: '默认 pending。同一时刻最多只能有一条 in_progress。做不成或不用做了的标 cancelled，不要标 completed。',
                },
              },
            },
          },
          merge: {
            type: 'boolean',
            description:
              '默认 false（整表替换）。true = 只动 todos 里点到的那几条：有 id 的按 id 更新，没 id 的追加，其余原样不动。' +
              '改某一条的状态时用它，不必把整张表重发一遍。',
          },
        },
      },
    },
    async (args: { todos?: unknown; merge?: unknown }, call) => {
      const col = ctx.storage.collection<TodoItem[]>(COLLECTION)
      const current = col.get(call.sessionId) ?? []

      /**
       * **只有真的什么都没带才是「读」。** 带了别的键却没有 todos（字段名写错了、参数没解析出来），
       * 照「读」处理的话它拿到一句「清单是空的，带 todos 再调一次」，再调一次还是一样——一轮里
       * 原地连调几十次。明说没认出 todos，它才知道是参数的事。
       */
      if (args.todos === undefined) {
        const keys = Object.keys(args ?? {}).filter((k) => k !== 'merge')
        if (keys.length) {
          fail(`没认出 todos 参数（收到的是：${keys.join('、')}）。写清单要用 todos 数组；只想读当前清单就什么参数都不带。`)
        }
        if (!current.length) return '清单是空的。要列一张就带 todos 数组再调一次；一两步能做完的活不用列。'
        return render(current)
      }
      // 有的模型把数组写成了一段 JSON 字符串。意思没有歧义，照数组认。
      if (typeof args.todos === 'string') {
        try {
          args = { ...args, todos: JSON.parse(args.todos) }
        } catch {
          fail('todos 要是一个数组，这次给的是一段解析不了的字符串。')
        }
      }
      if (!Array.isArray(args.todos)) {
        fail('todos 要是一个数组。只想看当前清单的话，不要带任何参数调用。')
      }

      const rows = args.todos as TodoInput[]
      const next = args.merge === true ? mergeInto(current, rows) : replaceWith(rows)

      /**
       * 「同一时刻只有一件在做」是这张表**唯一**的硬约束，因为它是唯一一条能被违反
       * 得悄无声息的：三条同时 in_progress 的表看起来完全正常，而它表达的是「我同时
       * 在做三件事」——那句话没有意义，模型只有一条执行线。
       *
       * 拦在落盘之前：被拒的这次写入不留下任何痕迹，清单还是上一份完整的。
       */
      const running = next.filter((i) => i.status === 'in_progress')
      if (running.length > 1) {
        fail(
          `同一时刻只能有一条 in_progress，这次有 ${running.length} 条（${running.map((i) => i.task).join('、')}）。` +
            '挑一条开始做，其余留在 pending。清单没有改动。',
        )
      }

      col.put(call.sessionId, next)
      /**
       * 补一条快照事件给界面。**落库之后才发**，顺序不能倒：dock 是照着这条事件画的，
       * 而下一秒人可能就点开了它——先广播再落库的话，那一瞬间界面上的表比库里的新。
       *
       * **发不出去不算这次调用失败**：清单已经是持久的了，模型手上那份结果也是对的，
       * 少的只是界面上那块 dock 的一次刷新（下次改动、或者重新打开这一页时会补回来）。
       * 为它把一次成功的写入报成失败，是拿真东西去赔一个装饰。
       */
      try {
        await ctx.sessions.append(call.sessionId, 'todo/list', { callId: call.callId, items: next })
      } catch (e) {
        ctx.logger?.warn?.(`todo: 快照事件没写进去 ${(e as Error).message}`)
      }
      if (!next.length) return '清单已清空。'
      return render(next)
    },
  )
}
