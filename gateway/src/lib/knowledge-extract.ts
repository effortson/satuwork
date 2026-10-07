/**
 * 把原文件变成文本（docs/knowledge-base.md §5.4）。
 *
 * 五种格式，全是纯 JS 解析——Gateway 跑在 Vercel 上，原生依赖装不了；LibreOffice 在席位
 * 机器上，而入库不能依赖某台不一定在的机器。`.doc` / `.ppt` / `.xls` 老格式不收。
 *
 * 输出是「页」的数组：PDF / PPT 一页一条，表格一张 sheet 一条（行在正文里），
 * Word / Markdown / 文本整份一条。页码只为了答案里能说「在第几页」。
 */
import { HttpError } from '../http.ts'

export interface ExtractedPage {
  page: number | null
  text: string
}

/** 收哪些格式。键是扩展名（不带点），值是展示用的 MIME（登记时浏览器报的 MIME 不一定准，按扩展名认）。 */
export const KB_FILE_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  md: 'text/markdown',
  txt: 'text/plain',
}

export function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim())
  return m ? m[1].toLowerCase() : ''
}

/** 不认的格式 415，并告诉人该另存成什么。 */
export function requireSupported(name: string): string {
  const ext = extOf(name)
  if (KB_FILE_TYPES[ext]) return ext
  if (ext === 'doc' || ext === 'ppt' || ext === 'xls') {
    throw new HttpError(415, `不支持 .${ext} 老格式，请另存为 .${ext}x 再传`)
  }
  throw new HttpError(415, `不支持的格式${ext ? `（.${ext}）` : ''}，支持 ${Object.keys(KB_FILE_TYPES).map((e) => '.' + e).join(' / ')}`)
}

/** 一句人话的失败。扫描件、空文件、坏文件都走它，`failed` 行上的 error 就是这句。 */
export class ExtractError extends Error {}

export async function extractText(bytes: Buffer, ext: string): Promise<ExtractedPage[]> {
  let pages: ExtractedPage[]
  switch (ext) {
    case 'pdf':
      pages = await fromPdf(bytes)
      break
    case 'docx':
      pages = await fromDocx(bytes)
      break
    case 'pptx':
      pages = await fromPptx(bytes)
      break
    case 'xlsx':
      pages = await fromXlsx(bytes)
      break
    case 'csv':
      pages = fromCsv(decodeText(bytes))
      break
    case 'md':
    case 'txt':
      pages = [{ page: null, text: decodeText(bytes) }]
      break
    default:
      throw new ExtractError(`不支持的格式：.${ext}`)
  }
  const kept = pages.map((p) => ({ page: p.page, text: tidy(p.text) })).filter((p) => p.text.length > 0)
  if (!kept.length) throw new ExtractError('没有可提取的文字；扫描件暂不支持')
  return kept
}

/** 控制符、零宽字符、过多空行一律收掉——这些会进模型上下文，看不见但占 token。 */
function tidy(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** UTF-8 优先；带 BOM 的 UTF-16 认一下（Excel 另存的 csv 常这样）。 */
function decodeText(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le')
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString('utf8')
  return bytes.toString('utf8')
}

async function fromPdf(bytes: Buffer): Promise<ExtractedPage[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  // 销毁要走 loading task：pdfjs 6 把 PDFDocumentProxy.destroy() 拿掉了，文档对象上只剩
  // cleanup()；worker 和未完成的请求都挂在 task 上，不销毁它进程里会攒下一个个 worker。
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true })
  let doc
  try {
    doc = await task.promise
  } catch (e) {
    await task.destroy().catch(() => undefined)
    throw new ExtractError('PDF 打不开：' + oneLine(e))
  }
  const pages: ExtractedPage[] = []
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      let text = ''
      for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
        if (typeof item.str !== 'string') continue
        text += item.str
        text += item.hasEOL ? '\n' : ' '
      }
      pages.push({ page: i, text })
      page.cleanup()
    }
  } finally {
    await task.destroy().catch(() => undefined)
  }
  return pages
}

async function fromDocx(bytes: Buffer): Promise<ExtractedPage[]> {
  const mammoth = await import('mammoth')
  let out: { value: string }
  try {
    // 走 HTML 再折成带 `#` 标题的文本，而不是 extractRawText：标题要留着，切片时才能带上
    // 「三、考勤 › 3.2 请假」这样的路径。
    out = await mammoth.convertToHtml({ buffer: bytes })
  } catch (e) {
    throw new ExtractError('Word 文件打不开：' + oneLine(e))
  }
  return [{ page: null, text: htmlToText(out.value) }]
}

/** mammoth 出的 HTML 形状很简单（p / h1-6 / ul / ol / li / table / tr / td），正则折成文本够用。 */
function htmlToText(html: string): string {
  return unescapeXml(
    html
      .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${'#'.repeat(Number(n))} ${t.replace(/<[^>]+>/g, '')}\n\n`)
      .replace(/<\/(p|li|tr|table|ul|ol)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/t[dh]>/gi, ' | ')
      .replace(/<[^>]+>/g, ''),
  )
}

async function fromPptx(bytes: Buffer): Promise<ExtractedPage[]> {
  const JSZip = (await import('jszip')).default
  let zip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch (e) {
    throw new ExtractError('PPT 文件打不开：' + oneLine(e))
  }
  const slides = Object.keys(zip.files)
    .map((name) => ({ name, m: /^ppt\/slides\/slide(\d+)\.xml$/.exec(name) }))
    .filter((x): x is { name: string; m: RegExpExecArray } => !!x.m)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]))
  const pages: ExtractedPage[] = []
  for (const s of slides) {
    const xml = await zip.file(s.name)!.async('string')
    pages.push({ page: Number(s.m[1]), text: slideText(xml) })
  }
  return pages
}

/** `<a:p>` 一段一行，`<a:t>` 是文字。不引 XML 解析器：形状固定，正则够用。 */
function slideText(xml: string): string {
  const paras = xml.match(/<a:p\b[\s\S]*?<\/a:p>/g) ?? []
  return paras
    .map((p) => (p.match(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g) ?? []).map((t) => unescapeXml(t.replace(/<[^>]+>/g, ''))).join(''))
    .filter((line) => line.trim())
    .join('\n')
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
}

async function fromXlsx(bytes: Buffer): Promise<ExtractedPage[]> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(bytes as unknown as ArrayBuffer)
  } catch (e) {
    throw new ExtractError('Excel 文件打不开：' + oneLine(e))
  }
  const pages: ExtractedPage[] = []
  wb.eachSheet((ws, sheetId) => {
    const rows: string[][] = []
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = []
      row.eachCell({ includeEmpty: true }, (cell) => {
        cells.push(cellText(cell.value))
      })
      rows.push(cells)
    })
    const text = tableText(ws.name, rows)
    if (text) pages.push({ page: sheetId, text })
  })
  return pages
}

function cellText(v: unknown): string {
  if (v == null) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'object') {
    const o = v as { text?: unknown; result?: unknown; richText?: Array<{ text: string }>; hyperlink?: string }
    if (Array.isArray(o.richText)) return o.richText.map((r) => r.text).join('')
    if (o.result != null) return cellText(o.result)
    if (o.text != null) return String(o.text)
    if (o.hyperlink) return String(o.hyperlink)
    return ''
  }
  return String(v)
}

/**
 * 表格 → 文本：第一行当表头，每一行写成「列名: 值 | 列名: 值」，行首带行号。
 * 一行一条，切片那边按行边界切、绝不拆一行（docs/knowledge-base.md §6.4）。
 */
function tableText(sheet: string, rows: string[][]): string {
  if (!rows.length) return ''
  const header = rows[0].map((h, i) => h.trim() || `列${i + 1}`)
  const lines = [`# ${sheet}`]
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]
    const parts: string[] = []
    for (let c = 0; c < Math.max(header.length, cells.length); c++) {
      const v = (cells[c] ?? '').trim()
      if (!v) continue
      parts.push(`${header[c] ?? `列${c + 1}`}: ${v}`)
    }
    if (parts.length) lines.push(`第 ${r + 1} 行 · ${parts.join(' | ')}`)
  }
  return lines.length > 1 ? lines.join('\n') : ''
}

/** 够用的 CSV：引号、引号里的逗号和换行、`""` 转义。分隔符按第一行猜（逗号 / 分号 / 制表）。 */
function fromCsv(text: string): ExtractedPage[] {
  const first = text.split('\n', 1)[0] ?? ''
  const sep = [',', ';', '\t'].sort((a, b) => first.split(b).length - first.split(a).length)[0]
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === sep) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else if (ch !== '\r') cell += ch
  }
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  const text2 = tableText('表格', rows.filter((r) => r.some((c) => c.trim())))
  return text2 ? [{ page: null, text: text2 }] : []
}

function oneLine(e: unknown): string {
  return String((e as Error)?.message ?? e)
    .replace(/\s+/g, ' ')
    .slice(0, 200)
}
