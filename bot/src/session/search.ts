import type { ContentBlock, SessionEvent } from './types.ts'
import { visibleEvents } from './replay.ts'

/**
 * 在一条会话里按关键词找消息和文件——给**界面**用的那一把（`GET /api/sessions/:id/search`）。
 *
 * 模型自己翻记录的 `history_search`（tools/history.ts）和这里是两回事，口径也不同：
 *
 * | | 模型那把 | 这一把 |
 * |---|---|---|
 * | 范围 | 最近一次 `/new` 或 `/clear` 之后 | 最近一次 `/clear` 之后（和界面往上翻看得见的一致） |
 * | 搜什么 | 用户、助手、工具原文 | 用户、助手正文，外加文件名 |
 * | 结果 | 一段给模型读的文本 | 带 seq 的命中列表，界面拿它跳到那条消息 |
 *
 * **分块规则照抄界面的 fold（core/src/chat/fold.ts）。** 命中要能跳到屏幕上那条气泡，
 * 而气泡是按 fold 的规则拼出来的：一条 user/message 一个块；之后到下一条 user/message
 * 之前的所有助手事件合成一个块，正文取**最后一条有字的** assistant/message，壳上的
 * `data-seq` 是**最后一条** assistant/message 的 seq（fold 里的 msgSeq）。这里要是按
 * 事件逐条命中，一轮里穿插工具的那几条中间消息会命中到界面上根本不存在的东西。
 *
 * **文件只认结构化字段，不扫文本猜路径**——和界面一条规矩：用户上传的那段固定格式
 * （splitUploads）、`image` 块、`ref` 文件块、工具报的 `files`、委派任务报的 `files`。
 */

export interface SearchHit {
  /** 这一块的游标（块里第一条事件的 seq，唯一），翻下一页用。 */
  seq: number
  /** 界面上那条气泡壳的 `data-seq`。助手块没有 assistant/message 时退回到提问那条。 */
  anchor: number
  role: 'user' | 'assistant'
  time: number
  /** 命中处前后的一小段，已经压成一行。 */
  snippet: string
}

export interface SearchFileHit {
  path: string
  name: string
  /** 它出现在哪条消息里（同 SearchHit.anchor）。 */
  anchor: number
  role: 'user' | 'assistant'
  time: number
}

export interface SearchResult {
  query: string
  terms: string[]
  hits: SearchHit[]
  files: SearchFileHit[]
  /** 正文命中的总数（不受 before / limit 影响），界面上那句「共 N 条」。 */
  total: number
  fileTotal: number
  hasMore: boolean
  /** 下一页的 `before`。没有更多就是 null。 */
  nextBefore: number | null
}

export interface SearchOptions {
  q: string
  limit?: number
  before?: number
}

export const SEARCH_LIMIT_DEFAULT = 20
export const SEARCH_LIMIT_MAX = 100
export const SEARCH_FILES_MAX = 50
/** 关键词最多拆几个、每个多长。再多就不是在找东西了。 */
const TERMS_MAX = 8
const TERM_CHARS_MAX = 100
const QUERY_CHARS_MAX = 200
/** 摘录：命中点往前留多少、往后留多少。 */
const SNIPPET_BEFORE = 60
const SNIPPET_AFTER = 120

interface Block {
  seq: number
  anchor: number
  role: 'user' | 'assistant'
  time: number
  text: string
  files: { path: string; name: string }[]
  /** 委派任务按 id 去重：同一个 id 会来多条（running → 终态），文件以最后一条为准。 */
  tasks?: Map<string, { path: string; name: string }[]>
}

/**
 * 用户消息开头那段「我上传了文件，在工作区里：」是网页端自己拼的（chat.js 的
 * composeChatBody），格式由它定死；这里照 core/src/chat/events.ts 的 splitUploads 认
 * 回来。bot 不依赖 core 包，所以是一份镜像——两边的判据必须一样：首行整句相等，随后
 * 是连续的 `` - `uploads/…` `` 行。
 */
const UPLOAD_LEADS = ['我上传了文件，在工作区里：', 'I uploaded some files. They are in the workspace at:']

export function splitUploads(src: string): { text: string; files: { path: string; name: string }[] } {
  const lead = UPLOAD_LEADS.find((x) => src.startsWith(x + '\n'))
  if (!lead) return { text: src, files: [] }
  const lines = src.slice(lead.length + 1).split('\n')
  const files: { path: string; name: string }[] = []
  let i = 0
  for (; i < lines.length; i++) {
    const m = /^- `(uploads\/[^`]+)`$/.exec(lines[i])
    if (!m) break
    files.push({ path: m[1], name: m[1].split('/').pop() || m[1] })
  }
  if (!files.length) return { text: src, files: [] }
  return { text: lines.slice(i).join('\n').trim(), files }
}

function textOf(content: ContentBlock[] | undefined): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => (c && c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n')
}

function nameOf(path: string): string {
  return path.split('/').pop() || path
}

function fileList(x: unknown): { path: string; name: string }[] {
  if (!Array.isArray(x)) return []
  const out: { path: string; name: string }[] = []
  for (const f of x) {
    const o = (f ?? {}) as { path?: unknown; name?: unknown }
    if (typeof o.path !== 'string' || !o.path) continue
    out.push({ path: o.path, name: typeof o.name === 'string' && o.name ? o.name : nameOf(o.path) })
  }
  return out
}

/** 用户消息里挂着的文件：上传那段、图片块、引用的文件。 */
function userFiles(content: ContentBlock[] | undefined, uploads: { path: string; name: string }[]): { path: string; name: string }[] {
  const out = uploads.slice()
  for (const c of Array.isArray(content) ? content : []) {
    if (!c) continue
    if (c.type === 'image' && typeof c.path === 'string' && c.path) out.push({ path: c.path, name: nameOf(c.path) })
    else if (c.type === 'ref' && c.kind === 'file' && typeof c.path === 'string' && c.path) {
      out.push({ path: c.path, name: c.name || nameOf(c.path) })
    }
  }
  return out
}

/**
 * 这条 user/message 界面上画不画。照 fold：真人（`kind` 空或 `user`）、渠道、以及
 * 看板 / 日常任务 / 转人工那几种插件消息画；系统提示快照、Skill 目录之类的注入不画。
 */
function shownUser(source: unknown): boolean {
  const src = (source ?? {}) as { kind?: string; plugin?: string }
  if (!src.kind || src.kind === 'user' || src.kind === 'channel') return true
  return src.kind === 'plugin' && (src.plugin === 'kanban' || src.plugin === 'routine' || src.plugin === 'handoff')
}

/** 事件 → 界面上的气泡块。只保留搜索要用的几样：正文、文件、锚点。 */
export function blocksOf(events: readonly SessionEvent[]): Block[] {
  const blocks: Block[] = []
  let assistant: Block | null = null
  let lastUserSeq = 0
  const ensureAssistant = (ev: SessionEvent): Block => {
    if (!assistant) {
      assistant = { seq: ev.seq, anchor: lastUserSeq, role: 'assistant', time: ev.time, text: '', files: [] }
      blocks.push(assistant)
    }
    return assistant
  }
  for (const ev of events) {
    const data = (ev.data ?? {}) as Record<string, any>
    if (ev.type === 'user/message') {
      if (!shownUser(data.source)) continue
      assistant = null
      lastUserSeq = ev.seq
      const content = data.message?.content as ContentBlock[] | undefined
      const up = splitUploads(textOf(content))
      blocks.push({ seq: ev.seq, anchor: ev.seq, role: 'user', time: ev.time, text: up.text, files: userFiles(content, up.files) })
    } else if (ev.type === 'assistant/message') {
      const b = ensureAssistant(ev)
      const text = textOf(data.message?.content)
      if (text) b.text = text
      // 壳上的 data-seq 是最后一条 assistant/message 的（fold 的 msgSeq），有没有字都算。
      b.anchor = ev.seq
      b.time = ev.time
    } else if (ev.type === 'assistant/chunk') {
      const chunk = data.chunk ?? {}
      if (chunk.type === 'text-delta' && chunk.text) ensureAssistant(ev)
    } else if (ev.type === 'tool/call') {
      if (String(data.name ?? '').trim()) ensureAssistant(ev)
    } else if (ev.type === 'tool/result') {
      // 只认工具自己报的产出（files）。看到的（refs）、截图（shot）、喂给模型的图（images）
      // 都不是「这轮产出了什么」，列进去一次 ls 就把真正的文件埋掉了。
      if (assistant) (assistant as Block).files.push(...fileList(data.files))
    } else if (ev.type === 'agent/task') {
      const b = ensureAssistant(ev)
      const tasks = b.tasks || (b.tasks = new Map())
      tasks.set(String(data.id ?? ''), fileList(data.files))
    }
  }
  for (const b of blocks) {
    if (!b.tasks) continue
    for (const files of b.tasks.values()) b.files.push(...files)
    delete b.tasks
  }
  return blocks
}

export function termsOf(q: string): string[] {
  const out: string[] = []
  for (const raw of String(q ?? '').slice(0, QUERY_CHARS_MAX).toLowerCase().split(/\s+/)) {
    const term = raw.slice(0, TERM_CHARS_MAX)
    if (!term || out.includes(term)) continue
    out.push(term)
    if (out.length >= TERMS_MAX) break
  }
  return out
}

/** 所有词都出现才算命中（不区分大小写的子串）。空格隔开的多个词是「都要有」，不是「任一」。 */
function matches(lower: string, terms: string[]): boolean {
  for (const term of terms) if (!lower.includes(term)) return false
  return true
}

/** 命中点前后的一小段。多个词时取出现得最靠前的那个。 */
export function snippetOf(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const lower = flat.toLowerCase()
  let at = -1
  for (const term of terms) {
    const i = lower.indexOf(term)
    if (i >= 0 && (at < 0 || i < at)) at = i
  }
  if (at < 0) at = 0
  const start = Math.max(0, at - SNIPPET_BEFORE)
  const end = Math.min(flat.length, at + SNIPPET_AFTER)
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '')
}

export function searchSession(all: readonly SessionEvent[], opts: SearchOptions): SearchResult {
  const query = String(opts.q ?? '').trim().slice(0, QUERY_CHARS_MAX)
  const terms = termsOf(query)
  const limit = Math.min(SEARCH_LIMIT_MAX, Math.max(1, Math.trunc(opts.limit ?? SEARCH_LIMIT_DEFAULT) || SEARCH_LIMIT_DEFAULT))
  const before = Math.max(0, Math.trunc(opts.before ?? 0) || 0)
  const empty: SearchResult = { query, terms, hits: [], files: [], total: 0, fileTotal: 0, hasMore: false, nextBefore: null }
  if (!terms.length) return empty

  // `/clear` 之前的不搜：界面上往上翻也看不见，命中了也跳不过去。
  const blocks = blocksOf(visibleEvents(all))

  // 新的在前：翻记录十有八九是找最近说过的那次。
  const textHits: SearchHit[] = []
  const fileByPath = new Map<string, SearchFileHit>()
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (b.text && matches(b.text.toLowerCase(), terms)) {
      textHits.push({ seq: b.seq, anchor: b.anchor, role: b.role, time: b.time, snippet: snippetOf(b.text, terms) })
    }
    for (const f of b.files) {
      // 同一个文件在几条消息里出现过（传上来、又被改了一版），只留最近那一次。
      if (fileByPath.has(f.path)) continue
      if (!matches(`${f.path}\n${f.name}`.toLowerCase(), terms)) continue
      fileByPath.set(f.path, { path: f.path, name: f.name, anchor: b.anchor, role: b.role, time: b.time })
    }
  }

  const paged = before ? textHits.filter((h) => h.seq < before) : textHits
  const hasMore = paged.length > limit
  const hits = hasMore ? paged.slice(0, limit) : paged
  const files = [...fileByPath.values()]
  return {
    query,
    terms,
    hits,
    files: files.slice(0, SEARCH_FILES_MAX),
    total: textHits.length,
    fileTotal: files.length,
    hasMore,
    nextBefore: hasMore && hits.length ? hits[hits.length - 1].seq : null,
  }
}
