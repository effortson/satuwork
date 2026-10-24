import type { Context } from '@deepseek-ai/cordis'
import { gatewayToken, gatewayUrl } from '../llm/gateway.ts'
import type { SessionEventMap, TaskProgress } from '../session/types.ts'

/**
 * 主 Bot 派活：assign_task（docs/bot-tasks.md）。
 *
 * **只有主 Bot 有这把工具。** Gateway 只给这个账号的主 Bot 下发 `assignable` 名单，名单空着它就不进
 * 工具表（agent 的 toolSchemasFor）；接口那头再认一次（不是主 Bot 403）。
 *
 * **同步**（§1）：这一次调用一直等到派出去的每一件都收场才返回，主 Bot 在同一轮里接着处理。等的是
 * 这颗席位自己——每 2 秒问一次 Gateway、顺手续租；Gateway 不挂长请求，也不敲任何席位。
 *
 * **编排**（§2）：一次交一张小图，`after` 写依赖。没依赖的一起跑，有依赖的等前置做完、并把前置
 * 交回的结论附在指令末尾；同一颗 Bot 的几件自动排队；前置没做成，依赖它的跳过。
 *
 * 每一件的状态变化都写进会话（`bot/assign`），界面据此在主 Bot 的对话里画「那颗 Bot 正在执行…」
 * 和它交回的结论。
 */
export const name = 'satu-tools-assign'
export const inject = ['tools', 'catalog', 'sessions']

/** 一次最多几件。再多就不是一次派活，是一个项目——让它分几轮。 */
const MAX_TASKS = 6
/** 问 Gateway 的节拍。 */
const POLL_MS = Math.max(200, Math.trunc(Number(process.env.SATUWORK_ASSIGN_POLL_MS ?? 2_000)))
/** 最多等多久。到点不再等，没收场的结论之后以「任务结果」消息送回（§1.1 的兜底）。 */
const WAIT_MS = Math.max(10_000, Math.trunc(Number(process.env.SATUWORK_ASSIGN_WAIT_MS ?? 30 * 60_000)))
/**
 * 交给后一件的前置结论，每条最多多长；几条加起来再压在 DEP_CONTEXT_MAX 以内（Gateway 那边
 * 前置结论单独限 16000 字，留出标题的余量）。和指令分开传：指令自己就有 4000 字的上限。
 */
const DEP_RESULT_MAX = 6_000
const DEP_CONTEXT_MAX = 15_000
/** 问 Gateway 的一次请求最多等多久。 */
const HTTP_TIMEOUT_MS = Math.max(200, Math.trunc(Number(process.env.SATUWORK_ASSIGN_HTTP_TIMEOUT_MS ?? 20_000)))
/** 建任务的请求没回来（超时、断网）时重发几次、每次隔多久（第 n 次隔 n 倍）。 */
const CREATE_RETRIES = 2
const CREATE_RETRY_MS = Math.max(50, Math.trunc(Number(process.env.SATUWORK_ASSIGN_RETRY_MS ?? 1_000)))
/** 回给模型的每条结论最多多长。 */
const RESULT_MAX = 12_000

class AssignFailure extends Error {}

type State = SessionEventMap['bot/assign']['state']

interface Spec {
  key: string
  bot: { id: string; name: string }
  instruction: string
  after: string[]
}

interface Item extends Spec {
  index: number
  state: State
  taskId?: string
  result?: string
  /** 对方那一轮跑在哪条会话（Gateway 给的 runSessionId），界面「看过程」去那里取。 */
  runSessionId?: string
  /** 领活的一方随续租报上来的进度。 */
  progress?: TaskProgress
  startedAt?: number
  endedAt?: number
  /** 有人在对方的对话里按了停止（§1.3）。状态记 cancelled，和主 Bot 这边停的分开说。 */
  stoppedThere?: boolean
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

function human(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字）`
}

/** 等一拍。到点了要把挂在 signal 上的监听摘掉：一轮里每 2 秒等一拍，三十分钟能攒下九百个。 */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(t)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const t = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })

async function gateway(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
  const base = gatewayUrl()
  const token = gatewayToken()
  if (!base || !token) throw new AssignFailure('这台机器没有配 Gateway，派不了活。')
  let r: Response
  try {
    r = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
  } catch (e) {
    throw new Error(`连不上 Gateway：${(e as Error).message}`)
  }
  const text = await r.text().catch(() => '')
  let json: Record<string, unknown> | null = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {}
  return { status: r.status, json, text }
}

/**
 * 把参数收成一张图。错的一律整次不发生，原话回给模型（§2）。
 * 单条简写 `{ bot, instruction }` 照旧认。
 */
function parse(args: unknown, roster: { id: string; name: string }[]): Spec[] {
  const a = (args ?? {}) as { tasks?: unknown; bot?: unknown; instruction?: unknown }
  const raw: unknown[] = Array.isArray(a.tasks) ? a.tasks : a.bot || a.instruction ? [{ bot: a.bot, instruction: a.instruction }] : []
  const names = roster.map((b) => `「${b.name}」`).join('、')
  if (!raw.length) throw new AssignFailure(`要派什么？用 tasks 列出来。可派的 Bot：${names}。`)
  if (raw.length > MAX_TASKS) throw new AssignFailure(`一次最多派 ${MAX_TASKS} 件。多的分几次派。`)
  const specs: Spec[] = raw.map((x, i) => {
    const o = (x ?? {}) as Record<string, unknown>
    const want = str(o.bot)
    const instruction = str(o.instruction)
    if (!want) throw new AssignFailure(`第 ${i + 1} 件没写派给谁。可派的 Bot：${names}。`)
    if (!instruction) throw new AssignFailure(`第 ${i + 1} 件（派给「${want}」）没写要做什么。`)
    const lower = want.replace(/^@/, '').toLowerCase()
    const bot = roster.find((b) => b.id === want) || roster.find((b) => b.name.toLowerCase() === lower)
    if (!bot) throw new AssignFailure(`名单上没有「${want}」。可派的 Bot：${names}。`)
    const key = str(o.id) || String(i + 1)
    const after = Array.isArray(o.after) ? o.after.map((d) => str(d)).filter(Boolean) : []
    return { key, bot, instruction, after }
  })
  const keys = new Set<string>()
  for (const s of specs) {
    if (keys.has(s.key)) throw new AssignFailure(`id「${s.key}」重复了，每件的 id 要不一样。`)
    keys.add(s.key)
  }
  for (const s of specs) {
    for (const d of s.after) {
      if (!keys.has(d)) throw new AssignFailure(`「${s.key}」的 after 里写了「${d}」，没有这一件。`)
      if (d === s.key) throw new AssignFailure(`「${s.key}」不能等它自己。`)
    }
  }
  // 环：按依赖反复剥掉没有前置的，剥不完就是有环。
  const left = new Map(specs.map((s) => [s.key, new Set(s.after)]))
  while (left.size) {
    const free = [...left].filter(([, deps]) => ![...deps].some((d) => left.has(d))).map(([k]) => k)
    if (!free.length) throw new AssignFailure(`依赖绕成了一个圈（${[...left.keys()].join('、')}），没法排。`)
    for (const k of free) left.delete(k)
  }
  return specs
}

/** 渲染回给模型的那段。按 tasks 的顺序排，不按谁先跑完（同 delegate_task 的理由）。 */
function render(items: Item[]): string {
  const total = items.length
  return items
    .map((it) => {
      const took = it.startedAt && it.endedAt ? human(it.endedAt - it.startedAt) : '-'
      const head = `[${it.index + 1}/${total} ${it.state} · @${it.bot.name} · ${took}] ${it.instruction.replace(/\s+/g, ' ').slice(0, 80)}`
      const body =
        it.state === 'done'
          ? `  结论：${clip(it.result || '（对方没有写结论）', RESULT_MAX).split('\n').join('\n  ')}`
          : it.stoppedThere
            ? `  已停止：有人在 @${it.bot.name} 的对话里把它停了，这件活作废。不要重派，也不要自己接着做；如实告诉人它被停了，要不要重新做由人决定。`
            : it.state === 'detached'
            ? '  还在跑：等太久先不等了，它做完会以「任务结果」消息送回这条对话。'
            : `  ${it.result || '没做成'}`
      return `${head}\n${body}`
    })
    .join('\n\n')
}

export function apply(ctx: Context) {
  ctx.tools.register({
    name: 'assign_task',
    /**
     * 只有主代理有。子代理（delegate_task 开出来的那份干净的自己）**不许**再往外派：一层
     * 委派里再套一层派活，谁也说不清结论该回到哪一轮。
     */
    delegation: { mode: 'root-only' },
    // 出席位（打 Gateway 记一条），但它自己不改任何东西；外发闸放行它（policy 的 checkExternal）。
    risk: ['external'],
    get description() {
      const list = ctx.catalog?.assignable ?? []
      const names = list.length ? list.map((b) => (b.desc ? `「${b.name}」（${b.desc}）` : `「${b.name}」`)).join('、') : '（当前没有）'
      return (
        '把事情派给名单上别的 Bot 去做，**等它们做完、拿到结论**再接着处理（你是主 Bot，只有你能派）。' +
        `可派的 Bot：${names}。` +
        '对方跑在自己的席位上，有自己的人设、能力和连接，看不见这条对话——每件的 instruction 要写得自足：背景、要求、交付形式都写进去。' +
        '一次可以派好几件，用 tasks 列出来，并用 after 安排顺序：没有 after 的一起跑（并行）；after 写了谁，就等谁做完再跑（串行），' +
        '前置任务交回的结论会自动附在它的指令末尾。同一颗 Bot 的几件会自动排队。前置没做成，依赖它的会跳过。' +
        '某一件在对方那边被人停止了，就是人不要这件事了：同一批的整批跟着停，停掉的都不要重派，也不要自己接着做。' +
        '这次调用会一直等到所有任务收场才返回，返回的是每一件的结论；拿到之后汇总、核对或决定下一步，不要再问用户要不要等。'
      )
    },
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: `要派的活，最多 ${MAX_TASKS} 件。`,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '这一件的短名（如 mail、bill），给 after 引用。不写就按序号。' },
              bot: { type: 'string', description: '派给谁：名单上的名字。' },
              instruction: { type: 'string', description: '交给对方的原话，要自足，最多 4000 字。' },
              after: { type: 'array', items: { type: 'string' }, description: '要等哪几件（写它们的 id）做完再开始。不写就立刻开始。' },
            },
            required: ['bot', 'instruction'],
          },
        },
      },
      required: ['tasks'],
    },
    async execute(args, call) {
      const roster = ctx.catalog?.assignable ?? []
      if (!roster.length) return { text: '你现在不是主 Bot，派不了活。' }
      let specs: Spec[]
      try {
        specs = parse(args, roster)
      } catch (e) {
        if (e instanceof AssignFailure) return { text: e.message }
        throw e
      }
      const fromBotId = (process.env.SATUWORK_BOT_ID || '').trim()
      const sessionId = call.sessionId
      const signal = call.signal
      const total = specs.length
      const items: Item[] = specs.map((s, index) => ({ ...s, index, state: 'waiting' as State }))
      const byKey = new Map(items.map((it) => [it.key, it]))
      /**
       * 同一颗 Bot 的几件自动排队：一颗 Bot 一条主会话，两件同时发进去就是两轮抢着说话。
       *
       * 排法是「按显式 after 排出来的先后里，前面那件同 Bot 的」做隐含前置——**不能按 tasks 里写的
       * 顺序**：`[{a, X, after:[b]}, {b, X}]` 按书写顺序排是 b 等 a、a 又等 b，两件互等到超时。
       * 先按 after 拓扑排一遍（parse 已经保证没有环，同一层按书写顺序），隐含前置只往前指，和显式的
       * 合起来也成不了环。
       *
       * 隐含前置只管**先后**，不管**成败**：前一件没做成，后一件照样跑——它俩本来互不相干，只是
       * 恰好派给了同一颗 Bot。跳过只看显式 after。
       */
      const order: Item[] = []
      {
        const placed = new Set<string>()
        while (order.length < items.length) {
          const next = items.find((it) => !placed.has(it.key) && it.after.every((d) => placed.has(d)))!
          placed.add(next.key)
          order.push(next)
        }
      }
      const implicit = new Map<string, string[]>()
      order.forEach((it, i) => {
        const prev = order.slice(0, i).filter((x) => x.bot.id === it.bot.id)
        implicit.set(it.key, prev.length ? [prev[prev.length - 1].key] : [])
      })

      const emit = async (it: Item) => {
        try {
          await ctx.sessions.append(sessionId, 'bot/assign', {
            id: `${call.callId}:${it.key}`,
            callId: call.callId,
            index: it.index,
            total,
            ...(it.taskId ? { taskId: it.taskId } : {}),
            bot: it.bot,
            instruction: it.instruction,
            ...(it.after.length ? { after: it.after } : {}),
            state: it.state,
            ...(it.result ? { result: it.result } : {}),
            ...(it.runSessionId ? { runSessionId: it.runSessionId } : {}),
            ...(it.progress ? { progress: it.progress } : {}),
            ...(it.startedAt ? { startedAt: it.startedAt } : {}),
            ...(it.endedAt ? { endedAt: it.endedAt } : {}),
            at: Date.now(),
          })
        } catch (e) {
          ctx.logger?.warn?.(`assign: 写 bot/assign 失败：${(e as Error).message}`)
        }
      }
      const settle = async (it: Item, state: State, result?: string) => {
        it.state = state
        if (result !== undefined) it.result = result
        it.endedAt = Date.now()
        await emit(it)
      }

      // 一上来全部画出来：人立刻看得见派给了谁、谁在等谁。
      for (const it of items) await emit(it)

      const start = async (it: Item) => {
        // 前置交回的结论一起交过去：对方看不见主 Bot 的对话，不附的话「按邮件里提到的账单」它无从下手。
        // 单独放进 context，不拼进指令——指令有 4000 字的上限，前置一长后一件就派不出去。
        const deps = it.after.map((k) => byKey.get(k)!).filter((d) => d.state === 'done')
        const each = deps.length ? Math.min(DEP_RESULT_MAX, Math.floor(DEP_CONTEXT_MAX / deps.length) - 80) : 0
        const context = deps.map((d) => `【${d.key} · @${d.bot.name}】\n${clip(d.result || '', each)}`).join('\n\n')
        it.startedAt = Date.now()
        let r
        /**
         * 请求没回来（超时、断网）不等于没建成：Gateway 可能已经建好、只是响应慢了。重发同一份——
         * Gateway 按 callId + 目标 + 指令认回还没收场的那一条，不会建出第二条（POST /runtime/tasks）。
         * 当场判「没派出去」的话，对方照跑，结论之后以「任务结果」兜底送回，主 Bot 还可能再派一遍。
         */
        const body = {
          fromBotId,
          toBot: it.bot.id,
          instruction: it.instruction,
          ...(context ? { context } : {}),
          sessionId,
          callId: call.callId,
          wait: true,
        }
        for (let n = 0; ; n++) {
          try {
            r = await gateway('POST', '/runtime/tasks', body)
            break
          } catch (e) {
            if (e instanceof AssignFailure || n >= CREATE_RETRIES || signal?.aborted) {
              await settle(it, 'failed', `没派出去：${(e as Error).message}`)
              return
            }
            await sleep(CREATE_RETRY_MS * (n + 1), signal)
          }
        }
        const task = (r.json?.task ?? null) as { id?: unknown } | null
        if (r.status !== 201 || typeof task?.id !== 'string') {
          await settle(it, 'failed', `没派出去：${String(r.json?.error ?? r.text ?? '').slice(0, 300) || `HTTP ${r.status}`}`)
          return
        }
        it.taskId = task.id
        it.state = 'running'
        await emit(it)
      }

      const poll = async (it: Item) => {
        let r
        try {
          r = await gateway('GET', `/runtime/tasks/${encodeURIComponent(it.taskId!)}`)
        } catch {
          return // 网络抖一下不算什么，下一拍再问；等待租约有 60 秒。
        }
        if (r.status === 404) {
          await settle(it, 'failed', '没做成：Gateway 上找不到这件任务了')
          return
        }
        const t = (r.json?.task ?? null) as {
          status?: string
          result?: string | null
          error?: string | null
          runKind?: string | null
          runSessionId?: string | null
          progress?: TaskProgress | null
        } | null
        if (!t) return
        // 进度和对方会话 id 先收下：收场那条事件也要带着它们（界面靠 runSessionId 取过程）。
        const runSessionId = t.runSessionId || it.runSessionId
        const progress = t.progress || it.progress
        const moved = runSessionId !== it.runSessionId || JSON.stringify(progress) !== JSON.stringify(it.progress)
        it.runSessionId = runSessionId || undefined
        it.progress = progress || undefined
        if ((t.status === 'done' || t.status === 'answered') && t.runKind === 'aborted') {
          // 对方那边有人按了停止（§1.3）：这一件停下、作废，不当失败。
          it.stoppedThere = true
          await settle(it, 'cancelled', `有人在 @${it.bot.name} 的对话里把它停了。`)
        } else if (t.status === 'done' || t.status === 'answered') {
          const ok = t.runKind === 'completed' && !t.error
          await settle(it, ok ? 'done' : 'failed', ok ? String(t.result || '').trim() : String(t.result || t.error || '没做成').trim())
        } else if (t.status === 'failed' || t.status === 'cancelled') {
          await settle(it, t.status === 'cancelled' ? 'cancelled' : 'failed', String(t.result || t.error || '没做成').trim())
        } else if (t.status === 'reporting' || t.status === 'delivering') {
          // 租约断过一次，Gateway 已经转了兜底送回：结论会以消息送回这条对话。
          await settle(it, 'detached', '等的过程中断过一次，结论会以「任务结果」消息送回这条对话。')
        } else if (moved) {
          // 还在跑、进度变了：再写一条 running，界面那行「正在：…」跟着动。没变就不写，省得每 2 秒刷一行。
          await emit(it)
        }
      }

      const deadline = Date.now() + WAIT_MS
      const terminal = (s: State) => s !== 'waiting' && s !== 'running'
      try {
        for (;;) {
          if (signal?.aborted) {
            for (const it of items) {
              if (it.state === 'running' && it.taskId) await gateway('POST', `/runtime/tasks/${encodeURIComponent(it.taskId)}/cancel`, {}).catch(() => {})
              if (!terminal(it.state)) await settle(it, 'cancelled', '主 Bot 这边停止了。')
            }
            return { text: `已停止。\n\n${render(items)}` }
          }
          // 能开跑的开跑；显式前置没做成的跳过。隐含前置（同一颗 Bot 排队）只等它收场，不看成败。
          for (const it of items) {
            if (it.state !== 'waiting') continue
            const deps = it.after.map((k) => byKey.get(k)!)
            const bad = deps.find((d) => terminal(d.state) && d.state !== 'done')
            if (bad) {
              const why = bad.stoppedThere ? '被人停止了' : bad.state === 'detached' ? '还没做完（等太久先不等了）' : '没做成'
              await settle(it, 'skipped', `跳过：前置「${bad.key} · @${bad.bot.name}」${why}。`)
              continue
            }
            const queued = (implicit.get(it.key) ?? []).map((k) => byKey.get(k)!)
            if (deps.every((d) => d.state === 'done') && queued.every((d) => terminal(d.state))) await start(it)
          }
          if (items.every((it) => terminal(it.state))) break
          if (Date.now() > deadline) {
            for (const it of items) {
              if (it.state === 'running') await settle(it, 'detached', '等太久先不等了，它做完会以「任务结果」消息送回这条对话。')
              else if (it.state === 'waiting') await settle(it, 'skipped', '跳过：等前置等太久了。')
            }
            break
          }
          await sleep(POLL_MS, signal)
          for (const it of items) if (it.state === 'running' && it.taskId) await poll(it)
          /**
           * 有一件在对方那边被人停了（§1.3）：**整批跟着停**。人按停止是在说「这件事别做了」，而同一次
           * 派出去的几件是同一件事拆开的——剩下的接着跑，做出来的是一件被人叫停的事的其余部分。
           * 在跑的走和主 Bot 这边按停止同一条路（cancel → 领走的一方中止对方那一轮），等着的直接作废；
           * 已经做完的结论留着。
           */
          const halt = items.find((it) => it.stoppedThere)
          if (halt) {
            for (const it of items) {
              if (terminal(it.state)) continue
              if (it.state === 'running' && it.taskId) await gateway('POST', `/runtime/tasks/${encodeURIComponent(it.taskId)}/cancel`, {}).catch(() => {})
              await settle(it, 'cancelled', `跟着停了：同一批里 @${halt.bot.name} 那边有人按了停止，整批不再往下做。`)
            }
            break
          }
        }
      } catch (e) {
        if (e instanceof AssignFailure) return { text: e.message }
        throw e
      }
      const done = items.filter((it) => it.state === 'done').length
      const halt = items.find((it) => it.stoppedThere)
      if (halt) {
        return {
          text:
            `@${halt.bot.name} 那边有人按了停止，同一批派出去的 ${total} 件整批跟着停了（停之前做完 ${done} 件）。` +
            '停掉的这几件都作废：不要重派，也不要自己接着做；做完的结论照常可用。如实告诉人哪件被停、哪些跟着停了，要不要重新做由人决定。' +
            `\n\n${render(items)}`,
        }
      }
      return { text: `派出去的 ${total} 件收场了（做完 ${done} 件）。\n\n${render(items)}` }
    },
  })
}
