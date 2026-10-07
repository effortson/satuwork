/**
 * 切片（docs/knowledge-base.md §6.4）。纯函数，带版本号：将来改策略，重灌脚本按版本号找要重做的。
 *
 * - 目标 800 字符一片，前后重叠 100 字符，按段落 / 标题边界切，不在句子中间断
 * - 每片开头带上文件名和（有的话）标题路径：`《员工手册》› 三、考勤 › 3.2 请假`——
 *   向量是按这一片的文本算的，没有上下文的一段「满三年给十天」查不出来是年假
 * - 表格每行一条（解析那边已经一行一行给了），只按行边界切，绝不拆一行
 * - 一段超过 `hard` 硬切
 */
import type { ExtractedPage } from './knowledge-extract.ts'

export const CHUNKER_VERSION = 1

export interface Chunk {
  no: number
  page: number | null
  text: string
}

export interface ChunkOptions {
  size: number
  overlap: number
  hard: number
}

export const CHUNK_DEFAULTS: ChunkOptions = { size: 800, overlap: 100, hard: 8 * 1024 }

export function chunkPages(fileName: string, pages: ExtractedPage[], opts: Partial<ChunkOptions> = {}): Chunk[] {
  const o = { ...CHUNK_DEFAULTS, ...opts }
  const out: Chunk[] = []
  const title = `《${fileName.replace(/\.[a-z0-9]+$/i, '')}》`
  let headings: string[] = []
  /** 这一片开头时的标题路径。一片可能跨几个小节（小节都短时会合并），面包屑要按它开头那节算。 */
  let startCrumb = title
  let tail = ''

  const crumbNow = () => (headings.length ? `${title}› ${headings.join(' › ')}` : title)
  const flush = (page: number | null, body: string) => {
    const text = body.trim()
    if (!text) return
    out.push({ no: out.length, page, text: `${startCrumb}\n${text}` })
    tail = text.slice(-o.overlap)
  }
  const append = (buf: string, piece: string): string => {
    if (!buf) startCrumb = crumbNow()
    return buf ? `${buf}\n${piece}` : piece
  }

  for (const p of pages) {
    tail = ''
    let buf = ''
    for (const para of paragraphs(p.text)) {
      const h = headingOf(para)
      if (h) {
        headings = [...headings.slice(0, h.level - 1), h.text]
        // 攒得够多就在标题前放掉：标题是一片的天然边界。攒得还少（几个短小节）就合在一片里，
        // 标题行留在正文里，不然合并之后小节结构就没了。
        if (buf.length >= o.size / 2) {
          flush(p.page, buf)
          buf = ''
        } else if (buf) {
          buf = append(buf, `${'#'.repeat(h.level)} ${h.text}`)
        }
        continue
      }
      for (const piece of split(para, o)) {
        if (buf && buf.length + piece.length + 1 > o.size) {
          flush(p.page, buf)
          buf = ''
          buf = append(buf, tail ? `…${tail}\n${piece}` : piece)
        } else {
          buf = append(buf, piece)
        }
      }
    }
    flush(p.page, buf)
  }
  return out
}

/** 段落：空行分开；表格文本没有空行，按行就是段。 */
function paragraphs(text: string): string[] {
  const blocks = text.split(/\n\s*\n/)
  const out: string[] = []
  for (const b of blocks) {
    const t = b.trim()
    if (!t) continue
    // 一块里有多行且每行都是「第 n 行 ·」这种表格行，或者块很长，就按行拆。
    const lines = t.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length > 1 && (lines.every((l) => /^第 \d+ 行 · /.test(l)) || t.length > CHUNK_DEFAULTS.size)) out.push(...lines)
    else out.push(lines.join('\n'))
  }
  return out
}

function headingOf(para: string): { level: number; text: string } | null {
  if (para.includes('\n')) return null
  const m = /^(#{1,6})\s+(.+?)\s*#*$/.exec(para)
  if (m) return { level: m[1].length, text: m[2].trim() }
  // 「三、考勤」「3.2 请假」这类中文文档常见的编号标题：短、不以句号结尾。
  if (para.length <= 40 && /^([一二三四五六七八九十]+[、.．]|\d+(\.\d+)*[、.．\s])\S/.test(para) && !/[。！？.!?]$/.test(para)) {
    const level = /^\d+\.\d+/.test(para) ? 2 : 1
    return { level, text: para }
  }
  return null
}

/** 一段太长就按句子拼到 size；单句超过 hard 才硬切。 */
function split(para: string, o: ChunkOptions): string[] {
  if (para.length <= o.size) return [para]
  const sentences = para.match(/[^。！？.!?\n]+[。！？.!?\n]?/g) ?? [para]
  const out: string[] = []
  let buf = ''
  for (const s of sentences) {
    if (s.length > o.hard) {
      if (buf) out.push(buf)
      buf = ''
      for (let i = 0; i < s.length; i += o.hard) out.push(s.slice(i, i + o.hard))
      continue
    }
    if (buf && buf.length + s.length > o.size) {
      out.push(buf)
      buf = s
    } else buf += s
  }
  if (buf) out.push(buf)
  return out.map((x) => x.trim()).filter(Boolean)
}
