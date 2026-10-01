import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, Message, SessionEvent } from '../session/types.ts'
import type { ToolRisk } from './index.ts'
import { visibleEvents } from '../session/replay.ts'

/**
 * 翻自己的历史：`history_read` 按时间区间读原文，`history_search` 按关键词找。
 *
 * **为什么需要它。** 一个 Bot 一条长会话，会话只增不减，所以到了阈值就要把旧的那一段
 * 换成摘要（见 agent/index.ts 的 maybeCompact）。压缩之所以敢做，正是因为有这两个
 * 工具：原文一条没删，还躺在 JSONL 里，模型想看随时调得回来。没有它们，压缩就是
 * 有损的——摘要漏掉的东西就是真的没了。
 *
 * **只读，而且不经文件系统。** 走 `ctx.sessions` 的接口，不碰路径。工作区那套工具的
 * 根目录之所以刻意避开 `$SATUWORK_HOME`，就是不想让模型的手伸进自己的记忆里——
 * 那条理由在这里同样成立，所以这里给的是一扇窗，不是一把铲子。
 *
 * **只看当前会话。** `call.sessionId` 是执行管道给的，模型改不了。别的 Bot、别的会话
 * 都不在范围内：那是另一个人的工作台，跟"我记不记得昨天说过什么"是两件事。
 */
export const name = 'satu-tools-history'
export const inject = ['tools', 'sessions']

/** 一次返回的上限。喂回模型的东西必须有界，否则一次 history_read 就能把上下文冲掉。 */
const MAX_CHARS = 20_000
const MAX_ROWS = 200
const DEFAULT_ROWS = 50
/** 单条消息在列表里的展示上限。要看全文就缩小时间区间再读一次。 */
const MAX_ROW_CHARS = 600

class ToolFailure extends Error {}
function fail(message: string): never {
  throw new ToolFailure(message)
}

function timeZone(): string {
  return (
    process.env.SATUWORK_TZ?.trim() ||
    process.env.TZ?.trim() ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    'UTC'
  )
}

function stamp(at: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timeZone(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(at))
}

/**
 * 把 `2026-08-18` / `2026-08-18 22:00` 解析成毫秒，**按席位时区**。
 *
 * 不能直接 `Date.parse`：那会把不带时区的字符串当成 UTC（日期形式）或本机时区
 * （日期时间形式），两种还不一致。席位在 UTC+8 时，"昨天" 会整整偏出 8 小时——
 * 于是 history_read 取昨天，取回来的是前天晚上到昨天下午。
 */
export function parseAt(raw: string | undefined, key: string, endOfDay: boolean): number | undefined {
  if (raw == null || raw === '') return undefined
  const text = String(raw).trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text)
  if (!m) fail(`${key} 格式不对：${text}。要 "2026-08-18" 或 "2026-08-18 22:00"。`)
  const [, y, mo, d, hh, mm, ss] = m
  const hasTime = hh != null
  const guess = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    hasTime ? Number(hh) : endOfDay ? 23 : 0,
    hasTime ? Number(mm) : endOfDay ? 59 : 0,
    hasTime ? Number(ss ?? 0) : endOfDay ? 59 : 0,
  )
  // guess 是"把这串数字当 UTC"的结果。把它按席位时区渲染回来，跟原串的差值就是偏移，
  // 减掉即可。DST 边界上可能差一小时，对"翻聊天记录"这个用途够用了。
  const tz = timeZone()
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(guess))
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  const rendered = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
  return guess - (rendered - guess)
}

const textOf = (m: Message) => m.content.map((c) => (c.type === 'text' ? c.text : '')).join('')

function blockDigest(content: ContentBlock[]): string {
  return content
    .map((c) => {
      if (c.type === 'text') return c.text
      if (c.type === 'tool-call') return `[调用 ${c.name} ${c.arguments}]`
      // 图只报路径。翻记录时「那天发过一张图」本身就是要找的东西，不说的话
      // 这条消息在历史里看着就是空的。
      if (c.type === 'image') return `[图片 ${c.path}]`
      return ''
    })
    .join('')
}

interface Row {
  time: number
  role: string
  text: string
}

/** 事件流 → 可读的对话行。推理块不出现——它是给人看的，翻记录不需要。 */
export function rowsOf(events: SessionEvent[]): Row[] {
  const out: Row[] = []
  for (const e of events) {
    if (e.type === 'user/message') out.push({ time: e.time, role: '用户', text: blockDigest(e.data.message.content) })
    else if (e.type === 'assistant/message') {
      const text = blockDigest(e.data.message.content.filter((c) => c.type !== 'reasoning'))
      if (text.trim()) out.push({ time: e.time, role: '助理', text })
    } else if (e.type === 'tool/result') {
      out.push({ time: e.time, role: e.data.failed ? '工具(失败)' : '工具', text: e.data.text })
    }
  }
  return out
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/** 渲染成行，整体也要有界——行数够了字符数不一定够。 */
function render(rows: Row[], note: string): string {
  if (!rows.length) return '这个范围内没有记录。'
  const lines: string[] = []
  let chars = 0
  let shown = 0
  for (const r of rows) {
    const line = `[${stamp(r.time)}] ${r.role}：${clip(r.text, MAX_ROW_CHARS)}`
    if (chars + line.length > MAX_CHARS) break
    lines.push(line)
    chars += line.length
    shown++
  }
  const cut = shown < rows.length ? `\n…（还有 ${rows.length - shown} 条没显示，缩小时间区间或调小 limit）` : ''
  return `${note}\n${lines.join('\n')}${cut}`
}

export function apply(ctx: Context) {
  const tool = (
    def: { name: string; description: string; parameters: Record<string, unknown>; risk?: ToolRisk[] },
    execute: (args: any, sessionId: string) => Promise<string>,
  ) => {
    ctx.tools.register({
      ...def,
      /**
       * **重绑到主会话。** 这两把摸的是「这场对话」，而对话只有一场——就是主会话那条。
       *
       * 子代理靠它补上隔离的代价：主代理的 `context` 经常写不全，而逼它写一篇交底书
       * 只是把失败点从「忘了说」挪到「说漏了」。给一把按需检索的手更可靠，拉回来的又是
       * 有界的几十条（MAX_ROWS），不违反「全量历史不进每一次子请求」。
       *
       * 换 sessionId 的动作在管道里做（tools/index.ts 的 run），不在这儿——第二把
       * 「读这条会话」的工具出现时不用记得再写一遍。见 docs/delegation.md §6.3。
       */
      delegation: { rebind: true },
      async execute(args, call) {
        try {
          return { text: await execute((args ?? {}) as any, call.sessionId) }
        } catch (e) {
          if (e instanceof ToolFailure) return { text: e.message }
          throw e
        }
      },
    })
  }

  /**
   * 当前会话的事件。**不看压缩点**——翻记录要的就是压缩掉的那一段。
   *
   * 但**看清除点**：人打过 `/clear`，要的就是「之前那些别再提了」，模型自己翻回去
   * 等于没清（docs/chat-commands.md §15）。
   */
  const allEvents = async (sessionId: string) => {
    try {
      return visibleEvents(await ctx.sessions.events(sessionId))
    } catch {
      fail('读不到这条会话的记录。')
    }
  }

  tool(
    {
      name: 'history_read',
      risk: ['read'],
      description:
        '按时间区间读回这条会话更早的原始对话。上下文里那段“对话摘要”覆盖的内容、或者要核对用户当时的原话时用它。时间按本机时区。',
      parameters: {
        type: 'object',
        properties: {
          since: { type: 'string', description: '起点，含。"2026-08-18" 或 "2026-08-18 22:00"。不给就从会话开头。' },
          until: { type: 'string', description: '终点，含。只给日期时算到当天 23:59:59。不给就到最新。' },
          limit: { type: 'number', description: `最多返回多少条。默认 ${DEFAULT_ROWS}，上限 ${MAX_ROWS}。` },
          from_end: { type: 'boolean', description: '条数超出上限时保留最后 N 条而不是前 N 条。默认 true。' },
        },
      },
    },
    async ({ since, until, limit, from_end }, sessionId) => {
      const a = parseAt(since, 'since', false)
      const b = parseAt(until, 'until', true)
      if (a != null && b != null && a > b) fail('since 比 until 还晚。')
      const cap = Math.max(1, Math.min(Math.floor(limit || DEFAULT_ROWS), MAX_ROWS))
      const all = rowsOf(await allEvents(sessionId)).filter(
        (r) => (a == null || r.time >= a) && (b == null || r.time <= b),
      )
      const tail = from_end !== false
      const picked = all.length <= cap ? all : tail ? all.slice(-cap) : all.slice(0, cap)
      const scope = `${since ? stamp(a!) : '会话开头'} 至 ${until ? stamp(b!) : '最新'}`
      const note =
        all.length <= cap
          ? `${scope}，共 ${all.length} 条：`
          : `${scope}，共 ${all.length} 条，显示${tail ? '最后' : '最前'} ${cap} 条：`
      return render(picked, note)
    },
  )

  tool(
    {
      name: 'history_search',
      risk: ['read'],
      description:
        '在这条会话的全部历史里按关键词找，包括已经被摘要压缩掉的那一段。找到之后可以用 history_read 把那个时间点前后的原文调出来。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要找的文字。普通子串匹配，不区分大小写，不是正则。' },
          since: { type: 'string', description: '只在这个时间之后找。格式同 history_read。' },
          until: { type: 'string', description: '只在这个时间之前找。' },
          limit: { type: 'number', description: `最多返回多少条命中。默认 ${DEFAULT_ROWS}，上限 ${MAX_ROWS}。` },
        },
        required: ['query'],
      },
    },
    async ({ query, since, until, limit }, sessionId) => {
      const q = String(query ?? '').trim()
      if (!q) fail('缺少 query 参数。')
      const a = parseAt(since, 'since', false)
      const b = parseAt(until, 'until', true)
      const cap = Math.max(1, Math.min(Math.floor(limit || DEFAULT_ROWS), MAX_ROWS))
      const needle = q.toLowerCase()
      const hits = rowsOf(await allEvents(sessionId)).filter(
        (r) =>
          (a == null || r.time >= a) &&
          (b == null || r.time <= b) &&
          r.text.toLowerCase().includes(needle),
      )
      if (!hits.length) return `没找到「${q}」。`
      // 命中取最近的：翻记录十有八九是想找最近说的那次。
      const picked = hits.length <= cap ? hits : hits.slice(-cap)
      const note =
        hits.length <= cap
          ? `「${q}」命中 ${hits.length} 条：`
          : `「${q}」命中 ${hits.length} 条，显示最近 ${cap} 条：`
      return render(picked, note)
    },
  )
}
