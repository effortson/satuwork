import { markdownSummary } from '../markdown/summary.ts'

/** 上报前先截短；完整的回复不会进入通知队列。 */
export function notificationExcerpt(source: unknown): string {
  if (typeof source !== 'string') return ''
  const chars = Array.from(source.trim())
  return chars.length > 240 ? chars.slice(0, 239).join('') + '…' : chars.join('')
}

/** 通知仅带简短的纯文本摘要；不含工具输出、图片或推理块，不拆开 Unicode 字符。 */
export function notificationPreview(source: unknown): string {
  if (typeof source !== 'string') return ''
  const plain = markdownSummary(source.slice(0, 4000)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g, ''), 1000)
  return notificationExcerpt(plain)
}
