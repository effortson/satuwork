import type { Context } from '@deepseek-ai/cordis'
import { validateToolArguments } from '@earendil-works/pi-ai'
import {
  currentToolIndex,
  lookupToolId,
  shortDescription,
  signatureOf,
  type IndexedTool,
  type ToolIndex,
  type ToolPlan,
} from '../catalog/tool-index.ts'
import { agentsOf, type ToolCall, type ToolResult } from './index.ts'
import { fail, registerTool } from './common.ts'

/**
 * Bot 侧工具搜索的三把桥接工具（docs/tool-search-bot.md）：先搜、再看、才调。
 *
 * 连接器和 MCP 的工具多了之后不进发给模型的工具表（档位在 catalog/tool-index.ts 算），
 * 换成这三把。**真正的调用照旧走 `ctx.tools.execute`、用注册名**：policy、审批、确认表单、
 * 流水、计费都按真名走，`tool_call` 只是个壳（§7、§13 第 3 条）。
 */
export const name = 'satu-tools-search'
export const inject = ['tools', 'catalog']

export const TOOL_SEARCH = 'tool_search'
export const TOOL_DESCRIBE = 'tool_describe'
export const TOOL_CALL = 'tool_call'
export const BRIDGE_TOOLS = [TOOL_SEARCH, TOOL_DESCRIBE, TOOL_CALL] as const

/** 一次最多搜几条、每条最多回几个、一次最多看几个（§6）。 */
const MAX_QUERIES = 8
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 20
const MAX_DESCRIBE = 5

/** 清单前面那一段。档位不同，后面接的清单不同（§3）。 */
export const SEARCH_BASE =
  '在已连接的外部系统（连接器 / MCP）里找工具。这些工具不在你的工具表里：先用它搜到 id，' +
  '参数简单的照结果里的签名直接 tool_call，复杂的先 tool_describe 看完整参数。' +
  '用英文关键词搜效果最好（工具描述多是英文），例如 queries: ["send email", "find file"]；一次可以给几条。'

// ── 这一轮能碰哪些工具 ──────────────────────────────────────────────────────

/**
 * 一条会话这一轮的工具范围。agent 开轮时定下（agent/index.ts 的 toolViewOf），这里只读。
 *
 * - `plan`：这颗 Bot 的档位、延迟了哪些
 * - `mentioned`：这一轮点名的连接（mentionOnly 的只有点名才调得到，§8）
 * - `only`：子任务的收窄——父任务点了哪几把（§10）。没有就是不收窄
 */
export interface ToolView {
  plan: ToolPlan
  mentioned: Set<string>
  only?: Set<string>
}

/**
 * 搜得到的：被延迟的那些，加上这一轮点名的连接上不在表里的那几把（mentionOnly 的只有这一轮
 * 搜得到，§8）；子任务再按父任务给的收窄。
 */
export function searchable(index: ToolIndex, view: ToolView): IndexedTool[] {
  let out = view.plan.deferred
  if (view.mentioned.size) {
    const have = new Set(out.map((e) => e.name))
    const extra = index.entries.filter((e) => view.mentioned.has(e.serverId) && !have.has(e.name) && !view.plan.direct.has(e.name))
    if (extra.length) out = [...out, ...extra]
  }
  return view.only ? out.filter((e) => view.only!.has(e.name)) : out
}

/**
 * 调得到的：这颗 Bot 能用的服务器上的全部工具（延迟的、直出的都算），加上这一轮点名的连接。
 * mentionOnly 的只在被点名时算。
 */
export function callable(index: ToolIndex, view: ToolView, e: IndexedTool): boolean {
  if (view.only && !view.only.has(e.name)) return false
  if (view.mentioned.has(e.serverId)) return true
  if (e.mentionOnly) return false
  return view.plan.serverIds.includes(e.serverId)
}

// ── 搜索：BM25 + CJK 二元切词 + 中英意图表（§6）──────────────────────────────

const CJK = /[㐀-鿿豈-﫿]/

/**
 * 词。英文按字母数字切、去复数 s；中文按连续段切二元（单字段就是那一个字）。
 * 工具名里的下划线也是分隔：`FIND_FILE` → find、file。
 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  const lower = String(text ?? '').toLowerCase()
  for (const m of lower.matchAll(/[a-z0-9]+|[㐀-鿿豈-﫿]+/g)) {
    const w = m[0]
    if (CJK.test(w)) {
      if (w.length === 1) out.push(w)
      for (let i = 0; i + 1 < w.length; i++) out.push(w.slice(i, i + 2))
    } else {
      out.push(stem(w))
    }
  }
  return out
}

function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
  return w
}

/**
 * 常见的中文动作和对象 → 英文。Composio 的描述都是英文，模型却常用中文搜。
 *
 * 放在代码里、不做成可配（§6）：几十条够用，零命中的查询进日志，按它补。
 * 长的排前面：「发邮件」先于「邮件」认。
 */
const INTENTS: [string, string][] = [
  ['发邮件', 'send email'],
  ['发送邮件', 'send email'],
  ['写邮件', 'send email draft'],
  ['回邮件', 'reply email'],
  ['回复', 'reply'],
  ['转发', 'forward'],
  ['邮件', 'email mail message'],
  ['邮箱', 'email mail inbox'],
  ['收件箱', 'inbox email'],
  ['草稿', 'draft'],
  ['附件', 'attachment'],
  ['电子表格', 'sheet spreadsheet'],
  ['表格', 'sheet spreadsheet table'],
  ['单元格', 'cell'],
  ['幻灯片', 'slide presentation'],
  ['演示文稿', 'slide presentation'],
  ['演示', 'slide presentation'],
  ['文档', 'document doc'],
  ['文件夹', 'folder'],
  ['目录', 'folder directory'],
  ['文件', 'file'],
  ['共享', 'share permission'],
  ['分享', 'share permission'],
  ['权限', 'permission'],
  ['上传', 'upload'],
  ['下载', 'download'],
  ['日程', 'calendar event'],
  ['日历', 'calendar event'],
  ['会议', 'meeting event calendar'],
  ['查找', 'find search'],
  ['搜索', 'search find'],
  ['找', 'find search'],
  ['列出', 'list'],
  ['列表', 'list'],
  ['创建', 'create'],
  ['新建', 'create new'],
  ['删除', 'delete remove'],
  ['修改', 'update edit modify'],
  ['更新', 'update'],
  ['编辑', 'edit update'],
  ['复制', 'copy duplicate'],
  ['移动', 'move'],
  ['重命名', 'rename'],
  ['读取', 'read get fetch'],
  ['获取', 'get fetch'],
  ['查看', 'get read view'],
  ['发消息', 'send message'],
  ['消息', 'message'],
  ['频道', 'channel'],
  ['联系人', 'contact'],
  ['待办', 'task todo'],
  ['任务', 'task'],
  ['评论', 'comment'],
  ['页面', 'page'],
  ['数据库', 'database'],
  ['工单', 'issue ticket'],
  ['仓库', 'repository repo'],
  ['标签', 'label tag'],
  ['归档', 'archive'],
  ['回收站', 'trash'],
  ['导出', 'export'],
  ['图片', 'image photo'],
  ['链接', 'link url'],
  ['客户', 'customer contact'],
  ['发票', 'invoice'],
]

/** 一个「概念」：查询里的一个词，或者一条意图（它的几个英文说法任中一个都算）。 */
interface Concept {
  alts: string[]
  /** 意图扩出来的不参与「最稀有的词必须命中」那条（§6），它们是同义词，不是用户的原话。 */
  intent: boolean
  /**
   * 弱词：纯数字（「找 7-11 方案」里的 7、11，多半是数据）和英文虚词（the、to、in……）。
   * 它们不是在说要哪把工具，只按很低的权重计分，不参与「最稀有」和「命中一半」那两条——
   * 不然一个碰巧带着 11 或 the 的工具会把 FIND_FILE、LIST_FILES 挤掉。
   */
  weak: boolean
}

/** 弱词的分数打几折。 */
const WEAK_WEIGHT = 0.25

/** 英文虚词。小池子里它们完全可能是「最稀有」的那个词。过一遍 stem，和切出来的词同一个形状。 */
const STOPWORDS = new Set(
  'a an the to of in on at for from by with and or into onto my me i it its this that these those is are be all any some please'
    .split(' ')
    .map((w) => stem(w)),
)

export function conceptsOf(query: string): Concept[] {
  const q = String(query ?? '').toLowerCase()
  const out: Concept[] = []
  const seen = new Set<string>()
  let rest = q
  for (const [zh, en] of INTENTS) {
    if (!rest.includes(zh)) continue
    rest = rest.split(zh).join(' ')
    const alts = tokenize(en)
    const key = alts.join(' ')
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ alts, intent: true, weak: false })
  }
  // 原话里剩下的词：英文词照常；中文按二元（公司自己挂的 MCP 常有中文描述）。意图认过的那几个字不再切。
  for (const t of tokenize(rest)) {
    if (seen.has(t)) continue
    seen.add(t)
    out.push({ alts: [t], intent: false, weak: /^\d+$/.test(t) || STOPWORDS.has(t) })
  }
  return out
}

interface Doc {
  /** 合并之后的一行：同一组、同一 slug。 */
  entries: IndexedTool[]
  tf: Map<string, number>
  len: number
}

/** 字段权重（§6）：slug 最高。按重复次数近似 BM25F。 */
const WEIGHTS = { slug: 3, group: 1, description: 1, params: 1 }

function docOf(entries: IndexedTool[]): Doc {
  const e = entries[0]!
  const tf = new Map<string, number>()
  let len = 0
  const add = (text: string, w: number) => {
    for (const t of tokenize(text)) {
      tf.set(t, (tf.get(t) ?? 0) + w)
      len += w
    }
  }
  add(e.slug.replace(/_/g, ' '), WEIGHTS.slug)
  add(`${e.groupLabel} ${e.group.replace(/^kit:|^srv:/, '')} ${[...new Set(entries.map((x) => x.conn))].join(' ')}`, WEIGHTS.group)
  add(e.description, WEIGHTS.description)
  add(Object.keys((e.parameters?.properties ?? {}) as object).join(' '), WEIGHTS.params)
  return { entries, tf, len }
}

export interface SearchIndex {
  docs: Doc[]
  df: Map<string, number>
  avgLen: number
}

/** 同一组、同一 slug 合成一条（§4）：四个 Google Drive 的 FIND_FILE 是一个结果，不是四个。 */
export function buildSearchIndex(entries: IndexedTool[]): SearchIndex {
  const merged = new Map<string, IndexedTool[]>()
  for (const e of entries) {
    const key = `${e.group}\u0000${e.slug}`
    merged.set(key, [...(merged.get(key) ?? []), e])
  }
  const docs = [...merged.values()].map(docOf)
  const df = new Map<string, number>()
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1)
  const avgLen = docs.length ? docs.reduce((n, d) => n + d.len, 0) / docs.length : 1
  return { docs, df, avgLen }
}

const K1 = 1.2
const B = 0.75

export interface Hit {
  entries: IndexedTool[]
  score: number
}

/**
 * 搜一条。规矩照 Hermes（§6）：
 *
 * - 精确的 id 或 slug 一律命中，排最前
 * - 结果必须含查询里最稀有的那个词（只算索引里有的词；意图扩出来的同义词不算）
 * - 四个概念以上的查询，至少命中一半
 */
export function searchTools(index: SearchIndex, query: string, limit = DEFAULT_LIMIT): Hit[] {
  const raw = String(query ?? '').trim()
  if (!raw || !index.docs.length) return []
  const lower = raw.toLowerCase()
  const exact = index.docs.filter((d) =>
    d.entries.some((e) => e.id.toLowerCase() === lower || e.slug.toLowerCase() === lower || e.remote.toLowerCase() === lower),
  )
  const n = index.docs.length
  const idf = (t: string) => {
    const df = index.df.get(t) ?? 0
    return Math.log(1 + (n - df + 0.5) / (df + 0.5))
  }
  const concepts = conceptsOf(raw).filter((c) => c.alts.some((t) => index.df.has(t)))
  const dfOf = (c: Concept) => index.docs.filter((d) => c.alts.some((t) => d.tf.has(t))).length
  const plain = concepts.filter((c) => !c.intent && !c.weak)
  const rarest = plain.length ? plain.reduce((a, b) => (dfOf(b) < dfOf(a) ? b : a)) : undefined
  const words = concepts.filter((c) => !c.weak).length
  const scored: Hit[] = []
  for (const d of index.docs) {
    if (exact.includes(d)) continue
    let matched = 0
    let score = 0
    for (const c of concepts) {
      let best = 0
      for (const t of c.alts) {
        const f = d.tf.get(t)
        if (!f) continue
        const s = (idf(t) * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / index.avgLen))
        if (s > best) best = s
      }
      if (best > 0) {
        if (!c.weak) matched++
        score += c.weak ? best * WEAK_WEIGHT : best
      }
    }
    if (!matched) continue
    if (rarest && !rarest.alts.some((t) => d.tf.has(t))) continue
    if (words >= 4 && matched * 2 < words) continue
    scored.push({ entries: d.entries, score })
  }
  scored.sort((a, b) => b.score - a.score || (a.entries[0]!.id < b.entries[0]!.id ? -1 : 1))
  return [...exact.map((d) => ({ entries: d.entries, score: Infinity })), ...scored].slice(0, Math.max(1, limit))
}

/**
 * 一个结果（§6）：带签名，合并过的写「也在」。
 *
 * ```
 * google_drive_a:FIND_FILE(q*: string, folder_id?: string)
 *   Search files by name or query.   也在：google_drive_b、google_drive_c
 * ```
 */
export function renderHit(entries: IndexedTool[]): string {
  const [first, ...rest] = entries
  const head = `${first!.id}${signatureOf(first!.parameters)}`
  const desc = shortDescription(first!.description) || first!.slug
  const also = rest.length ? `   也在：${rest.map((e) => e.conn).join('、')}` : ''
  return `${head}\n  ${desc}${also}`
}

// ── 工具本身 ────────────────────────────────────────────────────────────────

/** 搜不到时那句话：已连接的来源和各自的工具数（§6）。 */
function renderMiss(plan: ToolPlan, query: string): string {
  const sources = plan.groups.map((g) => `${g.label}（${g.conns.length} 个连接，${g.tools} 个工具）`).join('、')
  return (
    `没搜到和「${query}」相关的工具。已连接的来源：${sources || '（没有）'}。` +
    '换个英文关键词再搜（动作 + 对象，例如 "list files"、"send email"），或者照清单里的名字用 tool_describe 直接看。'
  )
}

/** 最像的三个 id：写错了 id 时给模型一条出路（§7）。 */
function closest(ids: string[], want: string): string[] {
  const w = want.toLowerCase()
  return ids
    .map((id) => ({ id, d: distance(id.toLowerCase(), w) }))
    .sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1))
    .slice(0, 3)
    .map((x) => x.id)
}

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = up
    }
  }
  return prev[b.length]!
}

type CatalogLike = {
  toolIndex?: ToolIndex
  toolPlan?: (serverIds: string[], window?: number) => ToolPlan
  servers?: { id: string; connected?: boolean; mentionOnly?: boolean }[]
}

export function apply(ctx: Context) {
  const catalog = () => ctx.catalog as unknown as CatalogLike
  const indexOf = (): ToolIndex => catalog().toolIndex ?? currentToolIndex()

  /**
   * 这条会话这一轮的范围。agent 那边开轮时定下；取不到（探针、或者一次没经过 agent 的调用）
   * 就按「连上的、不是仅点名的那些服务器」算一份——policy 那边照样按 Bot 的授权名单拦。
   */
  const viewOf = (sessionId: string): ToolView | undefined => {
    const own = (agentsOf(ctx) as { toolViewOf?: (id: string) => ToolView | undefined } | undefined)?.toolViewOf?.(sessionId)
    if (own) return own
    const c = catalog()
    if (!c.toolPlan) return undefined
    const ids = (c.servers ?? []).filter((s) => s.connected !== false && !s.mentionOnly).map((s) => s.id)
    return { plan: c.toolPlan(ids), mentioned: new Set() }
  }

  /** 搜索索引跟着 plan 走：同一份 plan 只建一次。 */
  const searchIndexes = new WeakMap<ToolPlan, SearchIndex>()
  const searchIndexOf = (view: ToolView, pool: IndexedTool[]): SearchIndex => {
    if (pool !== view.plan.deferred) return buildSearchIndex(pool)
    let got = searchIndexes.get(view.plan)
    if (!got) searchIndexes.set(view.plan, (got = buildSearchIndex(pool)))
    return got
  }

  registerTool(
    ctx,
    {
      name: TOOL_SEARCH,
      // 清单在 agent 出表时接在后面（toolSchemasFor），这里只是底稿。
      description: SEARCH_BASE,
      parameters: {
        type: 'object',
        properties: {
          queries: {
            type: 'array',
            items: { type: 'string' },
            description: `要搜的几条，每条一个意图（动作 + 对象），最多 ${MAX_QUERIES} 条，例如 ["find file", "share file"]`,
          },
          limit: { type: 'integer', description: `每条最多回几个，默认 ${DEFAULT_LIMIT}，最多 ${MAX_LIMIT}` },
        },
        required: ['queries'],
      },
      risk: ['read'],
      // 子任务里也要搜得到父任务给的那几把（§10），范围由 toolViewOf 管。
      delegation: {},
    },
    (args: { queries?: unknown; query?: unknown; limit?: unknown }, call) => {
      const raw = Array.isArray(args.queries) ? args.queries : typeof args.queries === 'string' ? [args.queries] : args.query ? [args.query] : []
      const queries = raw.map((q) => String(q ?? '').trim()).filter(Boolean).slice(0, MAX_QUERIES)
      if (!queries.length) fail('queries 不能为空：给一到几条英文关键词，例如 ["send email"]。')
      const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(Number(args.limit) || DEFAULT_LIMIT)))
      const view = viewOf(call.sessionId)
      const pool = view ? searchable(indexOf(), view) : []
      if (!view || !pool.length) {
        return '这颗 Bot 现在没有可以搜的外部工具（没有连接器 / MCP，或者都已经在你的工具表里了）。'
      }
      const index = searchIndexOf(view, pool)
      const blocks: string[] = []
      for (const q of queries) {
        const hits = searchTools(index, q, limit)
        // 每次都记一条；零命中的要捞得出来，意图表靠它补（§12）。
        if (hits.length) ctx.logger?.info?.(`tool_search：「${q}」命中 ${hits.length} 个`)
        else ctx.logger?.info?.(`tool_search：零命中「${q}」`)
        const head = queries.length > 1 ? `## ${q}\n` : ''
        blocks.push(head + (hits.length ? hits.map((h) => renderHit(h.entries)).join('\n') : renderMiss(view.plan, q)))
      }
      return `${blocks.join('\n\n')}\n\n用 tool_call({ id, arguments }) 调用；参数复杂的先 tool_describe({ ids }) 看完整参数。`
    },
  )

  registerTool(
    ctx,
    {
      name: TOOL_DESCRIBE,
      description: `看外部工具的完整参数（JSON Schema）。ids 是 tool_search 结果里的 id，一次最多 ${MAX_DESCRIBE} 个。`,
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: '工具 id，形如 google_drive_work:FIND_FILE' },
        },
        required: ['ids'],
      },
      risk: ['read'],
      delegation: {},
    },
    (args: { ids?: unknown; id?: unknown }, call) => {
      const raw = Array.isArray(args.ids) ? args.ids : typeof args.ids === 'string' ? [args.ids] : args.id ? [args.id] : []
      const ids = raw.map((x) => String(x ?? '').trim()).filter(Boolean)
      if (!ids.length) fail('ids 不能为空：填 tool_search 结果里的 id。')
      if (ids.length > MAX_DESCRIBE) fail(`一次最多看 ${MAX_DESCRIBE} 个，这次给了 ${ids.length} 个。分几次看。`)
      const index = indexOf()
      const view = viewOf(call.sessionId)
      return ids
        .map((id) => {
          const e = lookupToolId(index, id)
          if (!e || !view || !callable(index, view, e)) return `${id}：${missText(index, view, id)}`
          const others = index.entries.filter((x) => x.group === e.group && x.slug === e.slug && x.id !== e.id && view && callable(index, view, x))
          return [
            `${e.id} — ${e.description || e.slug}`,
            ...(others.length ? [`也在：${others.map((x) => x.id).join('、')}（换连接就换 id 的前半截）`] : []),
            `参数（JSON Schema）：\n${JSON.stringify(e.parameters, null, 2)}`,
          ].join('\n')
        })
        .join('\n\n')
    },
  )

  /** id 认不出时说清楚：是写错了（给三个最像的），还是这把连接现在没连上（§7）。 */
  const missText = (index: ToolIndex, view: ToolView | undefined, id: string): string => {
    const e = lookupToolId(index, id)
    if (e) return '这把工具不在这颗 Bot（或这一轮）能用的范围里。'
    const cut = id.indexOf(':')
    const conn = cut > 0 ? id.slice(0, cut).trim().toLowerCase() : ''
    if (conn && !index.entries.some((x) => x.conn === conn)) {
      const conns = [...new Set(index.entries.filter((x) => !view || callable(index, view, x)).map((x) => x.conn))]
      return `连接 ${conn} 现在没连上（或者已经移除了）。现在连着的：${conns.join('、') || '（没有）'}。`
    }
    const pool = index.entries.filter((x) => !view || callable(index, view, x)).map((x) => x.id)
    const near = closest(pool, id)
    return `没有这个 id。${near.length ? `最像的：${near.join('、')}。` : ''}不确定就先 tool_search。`
  }

  ctx.tools.register({
    name: TOOL_CALL,
    description:
      '调用一把外部工具（连接器 / MCP）。id 是 tool_search 结果里的 id，arguments 是那把工具的参数对象。' +
      '一次调一把；要并行就在同一步里发几个 tool_call。要审批的照样会弹确认卡。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '工具 id，形如 google_drive_work:FIND_FILE' },
        arguments: { type: 'object', description: '那把工具的参数，照 tool_search 的签名或 tool_describe 的 schema 填' },
      },
      required: ['id'],
    },
    /**
     * 壳本身只读：它自己什么都不干，真正的风险由里面那次 `ctx.tools.execute` 按真名判。
     * 标成别的，同一次发信会弹两张卡——壳一张、真名一张。
     */
    risk: ['read'],
    delegation: {},
    async execute(args, call): Promise<ToolResult> {
      const a = (args ?? {}) as { id?: unknown; arguments?: unknown }
      const id = String(a.id ?? '').trim()
      if (!id) return { text: 'id 不能为空：填 tool_search 结果里的 id。', refused: true }
      const index = indexOf()
      const view = viewOf(call.sessionId)
      const e = lookupToolId(index, id)
      if (!e || !view || !callable(index, view, e) || !ctx.tools.has(e.name)) {
        return { text: `调不了 ${id}：${missText(index, view, id)}`, refused: true }
      }
      let inner: unknown = a.arguments ?? {}
      // 有的模型把参数整个 JSON 字符串化。
      if (typeof inner === 'string') {
        try {
          inner = inner.trim() ? JSON.parse(inner) : {}
        } catch {
          return { text: 'arguments 要是一个 JSON 对象（不是字符串）。', refused: true }
        }
      }
      if (!inner || typeof inner !== 'object' || Array.isArray(inner)) {
        return { text: 'arguments 要是一个 JSON 对象。', refused: true }
      }
      /**
       * **本地校验**（§7）：按真实 schema 校，顺手做类型矫正（"5" → 5）。不过就把错误原样
       * 交回模型，不打上游——上游那一趟要计费，回来的错误还常常比这里的含糊。
       */
      let checked: unknown
      try {
        checked = validateToolArguments(
          { name: e.name, description: e.description, parameters: e.parameters as never },
          { type: 'toolCall', id: call.callId, name: e.name, arguments: structuredClone(inner) as Record<string, unknown> },
        )
      } catch (err) {
        return {
          text: `${e.id} 的参数没通过校验：${(err as Error).message}\n照 tool_describe({ ids: ["${e.id}"] }) 的 schema 改了再调。`,
          refused: true,
        }
      }
      return await executeAs(ctx, call, e.name, checked)
    },
  })
}

/**
 * 用真名再走一遍执行管道。**同一个 callId**：审批卡、工具卡、流水都挂在模型发起的那一次调用上。
 */
function executeAs(ctx: Context, call: ToolCall, name: string, args: unknown): Promise<ToolResult> {
  return ctx.tools.execute({
    callId: call.callId,
    name,
    arguments: JSON.stringify(args ?? {}),
    sessionId: call.sessionId,
    ...(call.signal ? { signal: call.signal } : {}),
  })
}
