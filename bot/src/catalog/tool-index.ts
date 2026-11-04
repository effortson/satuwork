/**
 * 工具搜索的那张表：连接器 / MCP 工具的 id、按 toolkit 分组、四档（docs/tool-search-bot.md §3、§4）。
 *
 * **纯函数，不碰 cordis。** 目录服务在每次同步之后建一份 `ToolIndex`，agent 按这颗 Bot 能用的
 * 服务器算一份 `ToolPlan`；探针（bot/e2e-tool-index.mjs）直接打这里的函数。
 *
 * id 是 `<连接>:<工具 slug>`。被延迟的工具不进供应商的工具表，所以不受 64 字符、只许
 * `[a-zA-Z0-9_-]` 那些限制——不需要 `mcpToolName` 那种截断加哈希。执行时照旧用注册名。
 */

export interface IndexedTool {
  /** `google_drive_syrius:FIND_FILE`。模型看到的、`tool_call` 收的就是它。 */
  id: string
  /** `ctx.tools` 里注册的那个名字（`mcp_google_drive_syrius_find_file`）。执行、策略、流水都按它。 */
  name: string
  serverId: string
  /** id 的前半截：连接名，界面上那个名字压成小写下划线。 */
  conn: string
  /** 分组键：连接器按 toolkit 合并，公司自配的 MCP 一台一组。 */
  group: string
  /** 组名：「Google Drive」。 */
  groupLabel: string
  /** 远端原名（Gateway 列出来的那个）。 */
  remote: string
  /** 显示用的短名：远端名去掉 toolkit 前缀。 */
  slug: string
  description: string
  parameters: Record<string, unknown>
  /** 上架记录里的推荐集（§5）。 */
  recommended: boolean
  /** 「仅 @ 时可用」的服务器上的工具：不进清单、搜不到，只在点名那一轮出现（§8）。 */
  mentionOnly: boolean
}

export interface IndexServer {
  id: string
  /** 界面上那个名字：`Google Drive (syrius)`。 */
  name: string
  /** 连接器 toolkit。公司自配的 MCP 没有。 */
  connector?: string
  mentionOnly?: boolean
  /** 上架记录里的推荐集，Composio 的全名（`GMAIL_SEND_EMAIL`）或短名都认。 */
  recommendedTools?: string[]
  tools: { name: string; remote: string; description?: string; parameters?: Record<string, unknown> }[]
}

export interface ToolIndex {
  entries: IndexedTool[]
  byId: Map<string, IndexedTool>
  byName: Map<string, IndexedTool>
}

export type ToolSearchMode = 'auto' | 'on' | 'off'

export interface ToolSearchConfig {
  mode: ToolSearchMode
  /** 第 0 档的线（§11 `SATUWORK_TOOL_SEARCH_DIRECT_MAX`）。 */
  directMax: number
  /** 清单 token 上限（§11 `SATUWORK_TOOL_SEARCH_LISTING_MAX`），再和「窗口 × 5%」取小。 */
  listingMax: number
}

/** 读 §11 那三个环境变量。认不出的值按默认走。 */
export function toolSearchConfig(env: Record<string, string | undefined> = process.env): ToolSearchConfig {
  const raw = String(env.SATUWORK_TOOL_SEARCH ?? 'auto').trim().toLowerCase()
  const mode: ToolSearchMode = raw === 'on' || raw === 'off' ? raw : 'auto'
  const int = (v: string | undefined, fallback: number) => {
    const n = Math.trunc(Number(v))
    return Number.isFinite(n) && n >= 0 && String(v ?? '').trim() !== '' ? n : fallback
  }
  return {
    mode,
    directMax: int(env.SATUWORK_TOOL_SEARCH_DIRECT_MAX, 30),
    listingMax: int(env.SATUWORK_TOOL_SEARCH_LISTING_MAX, 4000),
  }
}

/** 同 tool-search.md §4：只要量级。 */
export function estTokens(text: string): number {
  return Math.ceil(text.length / 3)
}

/** 连接名：小写，字母数字（含中文）之外的压成一个下划线。 */
function connOf(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '_')
      .replace(/^_+|_+$/g, '') || 'mcp'
  )
}

/** `Google Drive (syrius)` → `Google Drive`。合成出来的连接名都是这个形状。 */
function labelOf(serverName: string): string {
  return serverName.replace(/\s*\([^()]*\)\s*$/, '').trim() || serverName
}

function prefixOf(toolkit: string): string {
  return `${toolkit.toUpperCase().replace(/-/g, '_')}_`
}

/** 远端名去掉 toolkit 前缀：`GOOGLEDRIVE_FIND_FILE` → `FIND_FILE`。Gateway 列出来的多半已经去过了。 */
function slugOf(remote: string, toolkit: string | undefined): string {
  if (!toolkit) return remote
  const prefix = prefixOf(toolkit)
  return remote.toUpperCase().startsWith(prefix) && remote.length > prefix.length ? remote.slice(prefix.length) : remote
}

/**
 * 建表。**顺序确定**：同一份目录建出来的 id、分组、排序一个字节都不差（§13 第 1 条）。
 *
 * 两把连接压出同一个连接名时（「Gmail (a b)」和「Gmail (a_b)」），后来的按服务器 id 排序
 * 补 `_2`、`_3`。撞名不能静默丢——那就是「某个工具时有时无」。
 */
export function buildToolIndex(servers: IndexServer[]): ToolIndex {
  const sorted = [...servers].sort((a, b) => (a.name === b.name ? cmp(a.id, b.id) : cmp(a.name, b.name)))
  const usedConn = new Map<string, number>()
  const entries: IndexedTool[] = []
  for (const s of sorted) {
    const base = connOf(s.name)
    const seen = usedConn.get(base) ?? 0
    usedConn.set(base, seen + 1)
    const conn = seen ? `${base}_${seen + 1}` : base
    const toolkit = s.connector || undefined
    const rec = new Set(
      (s.recommendedTools ?? []).map((r) => String(r).trim().toUpperCase()).filter(Boolean).map((r) => slugOf(r, toolkit).toUpperCase()),
    )
    for (const t of s.tools) {
      const slug = slugOf(t.remote, toolkit)
      entries.push({
        id: `${conn}:${slug}`,
        name: t.name,
        serverId: s.id,
        conn,
        group: toolkit ? `kit:${toolkit}` : `srv:${s.id}`,
        groupLabel: toolkit ? labelOf(s.name) : s.name,
        remote: t.remote,
        slug,
        description: String(t.description ?? '').trim(),
        parameters: t.parameters && typeof t.parameters === 'object' ? t.parameters : { type: 'object', properties: {} },
        recommended: rec.has(slug.toUpperCase()),
        mentionOnly: s.mentionOnly === true,
      })
    }
  }
  entries.sort((a, b) => cmp(a.groupLabel, b.groupLabel) || cmp(a.group, b.group) || cmp(a.slug, b.slug) || cmp(a.conn, b.conn))
  const byId = new Map<string, IndexedTool>()
  const byName = new Map<string, IndexedTool>()
  for (const e of entries) {
    if (!byId.has(e.id)) byId.set(e.id, e)
    byName.set(e.name, e)
  }
  return { entries, byId, byName }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * 模型写的 id → 表里那一把。大小写不敏感；slug 写成远端全名（带 toolkit 前缀）也认。
 * 认不出回 undefined，由调用方说清是写错了还是连接没了。
 */
export function lookupToolId(index: ToolIndex, raw: string): IndexedTool | undefined {
  const id = String(raw ?? '').trim()
  if (!id) return undefined
  const exact = index.byId.get(id)
  if (exact) return exact
  const cut = id.indexOf(':')
  if (cut <= 0) return undefined
  const conn = id.slice(0, cut).trim().toLowerCase()
  const tool = id.slice(cut + 1).trim().toUpperCase()
  return index.entries.find((e) => {
    if (e.conn !== conn) return false
    if (e.slug.toUpperCase() === tool || e.remote.toUpperCase() === tool) return true
    // 带着 toolkit 前缀写的（`GOOGLEDRIVE_FIND_FILE`）也认。
    return e.group.startsWith('kit:') && tool === `${prefixOf(e.group.slice(4))}${e.slug.toUpperCase()}`
  })
}

// ── 进程内那一份 ────────────────────────────────────────────────────────────

let published: ToolIndex = buildToolIndex([])

/** 目录同步之后换上新的一份（catalog 的 connectMcp）。 */
export function publishToolIndex(index: ToolIndex): void {
  published = index
}

export function currentToolIndex(): ToolIndex {
  return published
}

/**
 * id → 注册名。确认卡、事件投影、上传附件那几处要「真名」，而它们手上只有 `tool_call` 的参数。
 * 走进程内那一份，不经 cordis：`policy/forms.ts` 是纯函数，探针也直接打它。
 */
export function resolveToolId(id: string): string | undefined {
  return lookupToolId(published, id)?.name
}

// ── 档位 ──────────────────────────────────────────────────────────────────

export type ToolTier = 0 | 1 | 2 | 3

export interface GroupSummary {
  key: string
  label: string
  conns: string[]
  /** 去重之后的工具数（同一 slug 在几个连接上算一个）。 */
  tools: number
}

export interface ToolPlan {
  tier: ToolTier
  /** 留在工具表里的连接器 / MCP 工具（注册名）。第 0 档就是今天那一份；别的档只有推荐集。 */
  direct: Set<string>
  /** 被延迟、搜得到的那些（不含 mentionOnly）。 */
  deferred: IndexedTool[]
  /** `tool_search` 描述里那段清单。第 0 档为空。 */
  listing: string
  listingTokens: number
  groups: GroupSummary[]
  /** 这份计划算的是哪几台服务器。 */
  serverIds: string[]
}

export interface PlanInput {
  serverIds: string[]
  config: ToolSearchConfig
  /** 这一轮模型的上下文窗口。没有就只按 listingMax。 */
  window?: number
}

/** 清单预算：`min(窗口 × 5%, listingMax)`（§3）。 */
export function listingBudget(config: ToolSearchConfig, window?: number): number {
  return typeof window === 'number' && window > 0 ? Math.min(Math.floor(window * 0.05), config.listingMax) : config.listingMax
}

/**
 * 算档（§3）。**只看输入**：同一份表、同一组服务器、同一个预算，出来的工具表和清单逐字节一样。
 *
 * `n` 是能用的连接器 / MCP 工具（mentionOnly 的也算——点名那一轮它们照样要进第 0 档的表），
 * 扣掉推荐集。
 */
export function planTools(index: ToolIndex, input: PlanInput): ToolPlan {
  const allow = new Set(input.serverIds)
  const usable = index.entries.filter((e) => allow.has(e.serverId))
  const serverIds = [...allow].sort()
  const all = new Set(usable.filter((e) => !e.mentionOnly).map((e) => e.name))
  const recommended = usable.filter((e) => e.recommended && !e.mentionOnly)
  const n = usable.length - recommended.length
  const { mode, directMax } = input.config
  if (mode === 'off' || (mode === 'auto' && n <= directMax) || !usable.length) {
    return { tier: 0, direct: all, deferred: [], listing: '', listingTokens: 0, groups: [], serverIds }
  }

  // 推荐集直出。合起来超过线时，连接多的 toolkit 先退回延迟（§5）。
  const direct = new Set(recommended.map((e) => e.name))
  if (direct.size > directMax) {
    const byGroup = new Map<string, IndexedTool[]>()
    for (const e of recommended) byGroup.set(e.group, [...(byGroup.get(e.group) ?? []), e])
    const order = [...byGroup.entries()].sort(
      (a, b) => new Set(b[1].map((e) => e.conn)).size - new Set(a[1].map((e) => e.conn)).size || cmp(a[0], b[0]),
    )
    for (const [, list] of order) {
      if (direct.size <= directMax) break
      for (const e of list) direct.delete(e.name)
    }
  }
  const deferred = usable.filter((e) => !e.mentionOnly && !direct.has(e.name))
  const groups = groupsOf(deferred)
  const budget = listingBudget(input.config, input.window)
  const { tier, text } = renderListing(groups, budget)
  return { tier, direct, deferred, listing: text, listingTokens: estTokens(text), groups: groups.map(summaryOf), serverIds }
}

interface MergedTool {
  slug: string
  description: string
  conns: string[]
  ids: string[]
}

interface Group {
  key: string
  label: string
  conns: string[]
  tools: MergedTool[]
}

/** 同一 toolkit 的几个连接合成一组，同一 slug 合成一行（§4）。 */
function groupsOf(entries: IndexedTool[]): Group[] {
  const map = new Map<string, Group>()
  for (const e of entries) {
    let g = map.get(e.group)
    if (!g) map.set(e.group, (g = { key: e.group, label: e.groupLabel, conns: [], tools: [] }))
    if (!g.conns.includes(e.conn)) g.conns.push(e.conn)
    let t = g.tools.find((x) => x.slug === e.slug)
    if (!t) g.tools.push((t = { slug: e.slug, description: e.description, conns: [], ids: [] }))
    t.conns.push(e.conn)
    t.ids.push(e.id)
  }
  const out = [...map.values()]
  for (const g of out) {
    g.conns.sort(cmp)
    g.tools.sort((a, b) => cmp(a.slug, b.slug))
    for (const t of g.tools) t.conns.sort(cmp)
  }
  return out.sort((a, b) => cmp(a.label, b.label) || cmp(a.key, b.key))
}

function summaryOf(g: Group): GroupSummary {
  return { key: g.key, label: g.label, conns: g.conns, tools: g.tools.length }
}

/** 一句话：描述的第一句，最多 80 字。 */
export function shortDescription(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const first = flat.split(/(?<=[.!?。！？])\s/)[0] ?? flat
  return first.length > 80 ? `${first.slice(0, 79)}…` : first
}

function only(t: MergedTool, g: Group): string {
  return t.conns.length < g.conns.length ? `（仅 ${t.conns.join('、')}）` : ''
}

function groupHead(g: Group): string {
  return `${g.label} — 连接：${g.conns.join('、')}`
}

function fullBlock(g: Group): string {
  return [groupHead(g), ...g.tools.map((t) => `  ${t.slug}${t.description ? ` — ${shortDescription(t.description)}` : ''}${only(t, g)}`)].join('\n')
}

function namesBlock(g: Group): string {
  return [groupHead(g), `  ${g.tools.map((t) => `${t.slug}${only(t, g)}`).join('、')}`].join('\n')
}

function lineOf(g: Group): string {
  return `${g.label}（${g.conns.length} 个连接，${g.tools.length} 个工具）— 连接：${g.conns.join('、')}`
}

/**
 * 第 1 档全带描述；放不下就逐组退成只有名字（工具多的组先退）；名字也放不下就每组一行。
 */
function renderListing(groups: Group[], budget: number): { tier: ToolTier; text: string } {
  const full = groups.map(fullBlock)
  const join = (blocks: string[]) => blocks.join('\n')
  if (estTokens(join(full)) <= budget) return { tier: 1, text: join(full) }
  const blocks = [...full]
  const order = groups.map((g, i) => ({ g, i })).sort((a, b) => b.g.tools.length - a.g.tools.length || a.i - b.i)
  for (const { g, i } of order) {
    blocks[i] = namesBlock(g)
    if (estTokens(join(blocks)) <= budget) return { tier: 2, text: join(blocks) }
  }
  return { tier: 3, text: groups.map(lineOf).join('\n') }
}

/**
 * 一行参数签名（§6）：`(q*: string, folder_id?: string, page_size?: integer)`。
 * 只列顶层；嵌套对象写 `object`，数组写 `T[]`。
 */
export function signatureOf(parameters: Record<string, unknown>): string {
  const props = (parameters?.properties ?? {}) as Record<string, Record<string, unknown>>
  const required = new Set(Array.isArray(parameters?.required) ? (parameters.required as unknown[]).map(String) : [])
  const parts = Object.keys(props).map((key) => `${key}${required.has(key) ? '*' : '?'}: ${typeOf(props[key])}`)
  return `(${parts.join(', ')})`
}

function typeOf(schema: Record<string, unknown> | undefined): string {
  if (!schema || typeof schema !== 'object') return 'any'
  const t = schema.type
  if (Array.isArray(t)) return t.filter((x) => x !== 'null').map(String).join('|') || 'any'
  if (t === 'array') {
    const items = schema.items as Record<string, unknown> | undefined
    const inner = items && typeof items === 'object' ? typeOf(items) : 'any'
    return `${inner.includes('|') ? `(${inner})` : inner}[]`
  }
  if (typeof t === 'string') return t
  if (Array.isArray(schema.enum)) return 'enum'
  if (schema.anyOf || schema.oneOf) return 'any'
  if (schema.properties) return 'object'
  return 'any'
}
