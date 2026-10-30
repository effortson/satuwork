import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '../session/types.ts'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { ImageRef, Mention, RefBlock } from '../agent/index.ts'

/** /messages 请求体里的图片、引用、点名 → 校验过的结构。浏览器传上来的一律不信，在这里重算。 */

/**
 * 模型真能看的图片格式。
 *
 * 是白名单不是黑名单：不在里面的（TIFF、SVG、HEIC）各家 provider 支持不一，发过去
 * 多半换回一个 400，而那个 400 长得像我们自己的 bug，查起来要绕一大圈。不如在这儿
 * 就说清楚。
 */
const MODEL_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/**
 * 请求里的图片 → 校验过的引用。
 *
 * 三件事一起做：路径必须落在工作区内（`resolve` 越界即抛）、文件必须真的在、格式必须
 * 是模型看得懂的。**路径是浏览器传上来的**，这一层不做，工作区边界就等于没有。
 */
export async function imageRefs(ctx: Context, raw: unknown): Promise<ImageRef[]> {
  if (raw == null) return []
  if (!Array.isArray(raw)) throw new Error('images 必须是数组')
  if (raw.length > 10) throw new Error('一条消息最多带 10 张图')
  const out: ImageRef[] = []
  for (const item of raw) {
    const path = typeof item?.path === 'string' ? item.path.trim() : ''
    const mime = typeof item?.mime === 'string' ? item.mime.trim().toLowerCase() : ''
    if (!path) throw new Error('images 里有一项缺 path')
    if (!MODEL_IMAGE_MIME.has(mime)) throw new Error(`这种图片格式模型看不了：${mime || '(空)'}`)
    const file = ctx.workspace.resolve(path)
    const info = await stat(file).catch(() => null)
    if (!info?.isFile()) throw new Error(`图片不存在：${path}`)
    out.push({ path: ctx.workspace.show(file), mime })
  }
  return out
}

/** 引用里摘录的上限（字符）。给界面画卡用的，不是给模型的——模型看全文（agent 的 refTextOf）。 */
const REF_EXCERPT_CHARS = 300

/** 一条消息的摘录：只要 text 块，空白折成一个空格，截到上限。 */
export function refExcerptOf(message: { content: { type: string; text?: string }[] }): string {
  const text = message.content
    .filter((c) => c.type === 'text')
    .map((c) => String(c.text ?? ''))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
  return (text || '（无正文）').slice(0, REF_EXCERPT_CHARS)
}

/**
 * 请求里的引用 → 校验过的块（docs/chat-references.md §5.1）。
 *
 * 文件：路径必须落在工作区内（`resolve` 越界即抛）。**在不在不查**——落盘时查了也挡
 * 不住之后被删，文件在不在是组模型请求那一刻的事。
 *
 * 消息：给了 seq 就必须在本会话里、且是一条 user/message 或 assistant/message；对上了
 * 就从那条事件**重算** excerpt / role / time，不信浏览器那份。没给 seq 的（外部渠道只有
 * 原文）才用请求里的 excerpt，而且不能为空。
 */
export async function refList(ctx: Context, sessionId: string, raw: unknown): Promise<RefBlock[]> {
  if (raw == null) return []
  if (!Array.isArray(raw)) throw new Error('refs 必须是数组')
  if (raw.length > 10) throw new Error('一条消息最多带 10 个引用')
  const out: RefBlock[] = []
  let events: SessionEvent[] | null = null
  for (const item of raw) {
    const o = (item ?? {}) as Record<string, unknown>
    const kind = String(o.kind ?? '')
    if (kind === 'file') {
      const path = typeof o.path === 'string' ? o.path.trim() : ''
      if (!path) throw new Error('refs 里有一个文件引用缺 path')
      const shown = ctx.workspace.show(ctx.workspace.resolve(path))
      if (out.some((r) => r.kind === 'file' && r.path === shown)) continue
      const name = (typeof o.name === 'string' && o.name.trim()) || basename(shown)
      out.push({ type: 'ref', kind: 'file', path: shown, name: name.slice(0, 255) })
    } else if (kind === 'message') {
      if (o.seq != null) {
        const seq = Number(o.seq)
        if (!Number.isSafeInteger(seq) || seq <= 0) throw new Error('引用的消息 seq 不对')
        events ??= await ctx.sessions.events(sessionId)
        const hit = events.find((e) => e.seq === seq)
        if (!hit || (hit.type !== 'user/message' && hit.type !== 'assistant/message')) {
          throw new Error('引用的消息不存在')
        }
        if (out.some((r) => r.kind === 'message' && r.seq === seq)) continue
        out.push({
          type: 'ref',
          kind: 'message',
          seq,
          role: hit.data.message.role,
          excerpt: refExcerptOf(hit.data.message),
          time: hit.time,
        })
      } else {
        const excerpt = String(o.excerpt ?? '').replace(/\s+/g, ' ').trim().slice(0, REF_EXCERPT_CHARS)
        if (!excerpt) throw new Error('引用的消息既没有 seq 也没有 excerpt')
        const role = o.role === 'user' ? 'user' : 'assistant'
        const time = Number(o.time) || Date.now()
        out.push({ type: 'ref', kind: 'message', role, excerpt, time })
      }
    } else {
      throw new Error(`refs 里有一项 kind 不认识：${kind || '(空)'}`)
    }
  }
  return out
}

/**
 * 请求体里的 mentions → 结构。
 *
 * **不做归属校验**：这一条是 Gateway 的活（它才知道这把连接属不属于这个账号）。
 * 席位这边只认形状——它信的是那张 `sat_` 票，票背后是谁由 Gateway 说了算。
 */
export function mentionList(raw: unknown): Mention[] {
  if (!Array.isArray(raw)) return []
  const out: Mention[] = []
  for (const item of raw.slice(0, 10)) {
    const o = (item ?? {}) as Record<string, unknown>
    const id = String(o.id ?? '').trim()
    const kind = String(o.kind ?? 'connector')
    if (!id) continue
    if (kind !== 'connector' && kind !== 'bot' && kind !== 'routine') continue
    // 图标地址只认 https、只留一个长度：它会落进会话日志，也会被界面拿去当 <img src>。
    const logo = typeof o.logo === 'string' && /^https:\/\/\S{1,400}$/.test(o.logo) ? o.logo : ''
    out.push({ kind, id, label: String(o.label ?? '').slice(0, 64), ...(logo ? { logo } : {}) })
  }
  return out
}
