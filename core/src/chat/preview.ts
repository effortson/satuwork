/**
 * 工作区文件用哪种方式预览：按扩展名分。原先在 gateway/ui/chat.js，只碰字符串；
 * 取文件、画预览那一半还在那边。
 */

/**
 * 文本类的扩展名。这几种取回来直接当文字看，比塞进 iframe 强——iframe 里的纯文本
 * 不会换行、没有主题色、也没法选中复制成一段。
 */
export const PREVIEW_TEXT_EXT = new Set([
  'txt', 'log', 'csv', 'tsv', 'json', 'yml', 'yaml', 'xml', 'ini', 'toml', 'conf',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'sh', 'bash', 'zsh', 'py',
  'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'sql', 'env', 'gitignore', 'diff', 'patch',
])

/**
 * 这几种在浏览器里没有原生渲染，得靠席位那边：先要一份渲染好的 PDF（chat.js 的 fetchDocPdf，
 * 席位上的 LibreOffice 转），要不到再退回提取文本（fetchDocText）。
 *
 * 老格式（.doc / .xls / .ppt）和 ODF 只有 PDF 那条路——文本提取那套库不认它们。
 */
export const PREVIEW_DOC_EXT = new Set(['docx', 'xlsx', 'xlsm', 'pptx', 'doc', 'xls', 'ppt', 'rtf', 'odt', 'ods', 'odp'])

/**
 * 要不到 PDF 时（席位 / 这台电脑没装 LibreOffice——桌面端的本地 Bot 多半如此），这几种还能在
 * 浏览器里渲染（gateway/ui/office-view.html）。老格式和 ODF 这几个前端库不认，只剩提取文本。
 */
export const PREVIEW_WEB_KIND: Record<string, string> = { docx: 'docx', xlsx: 'xlsx', xlsm: 'xlsx', pptx: 'pptx' }

/** 小写扩展名；没有、或者整个名字就是个点开头的（`.env`）回空串。 */
export function extOf(name: unknown): string {
  const base = String(name || '').split('/').pop() || ''
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}

export type PreviewKind = 'image' | 'pdf' | 'markdown' | 'html' | 'text' | 'doc' | ''

/**
 * 这个文件用哪种方式看。
 *
 * **按扩展名判，不按 content-type**：席位那边对不在内联白名单里的一律回
 * `application/octet-stream`（HTML、docx 都是），光看类型什么都分不出来。
 */
export function previewKindOf(name: unknown, type?: unknown): PreviewKind {
  const ext = extOf(name)
  if (String(type || '').startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'].includes(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'html' || ext === 'htm') return 'html'
  if (PREVIEW_TEXT_EXT.has(ext)) return 'text'
  if (PREVIEW_DOC_EXT.has(ext)) return 'doc'
  return ''
}
