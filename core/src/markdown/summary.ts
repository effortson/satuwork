/** 单行会话摘要：先去 Markdown 排版，再截断；不生成 HTML，也不加载图片。 */
export function markdownSummary(source: string, maxLength = 120): string {
  const held: string[] = []
  const hold = (text: string) => `\uE000${held.push(text) - 1}\uE000`
  // 占位符仅用于保护代码和转义的字面量，不能和正文里的字符相撞。
  let text = source.replace(/\uE000/g, '').replace(/\r\n?/g, '\n')

  // 围栏内的 Markdown 符号是代码正文；围栏未闭合时也保留已经收到的内容。
  let fence = ''
  let code: string[] = []
  const lines: string[] = []
  for (let line of text.split('\n')) {
    if (fence) {
      if (new RegExp('^\\s{0,3}' + fence[0] + '{' + fence.length + ',}\\s*$').test(line)) {
        lines.push(hold(code.join('\n')))
        code = []
        fence = ''
      } else code.push(line)
      continue
    }
    // 引用、嵌套列表和任务框只保留内容。
    line = line.replace(/^\s{0,3}(?:>\s*)+/, '')
    if (/^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,}|=+)\s*$/.test(line)) continue
    line = line.replace(/^\s*(?:[-*+]\s+|\d{1,9}[.)]\s+)(?:\[[ xX]\]\s+)?/, '')
    const open = /^\s{0,3}(`{3,}|~{3,})[^\n]*$/.exec(line)
    if (open) {
      fence = open[1]
      continue
    }
    if (/^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/.test(line)) continue
    line = line.replace(/^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/, '$1')
    lines.push(line)
  }
  if (fence) lines.push(hold(code.join('\n')))
  text = lines.join('\n')

  text = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _ticks, body: string) => hold(body))
  text = text.replace(/\\([\\`*{}\[\]()#+\-.!_>|~])/g, (_, char: string) => hold(char))
  // 引用链接的定义不属于摘要；已定义的链接只显示标题。
  const refs = new Set<string>()
  text = text.replace(/^\s{0,3}\[([^\]\n]+)\]:\s+\S+[^\n]*$/gm, (_, label: string) => {
    refs.add(label.trim().toLowerCase())
    return ''
  })
  text = text.replace(/!?\[([^\]\n]*)\]\[([^\]\n]*)\]/g, (all, label: string, ref: string) =>
    refs.has((ref || label).trim().toLowerCase()) ? label : all,
  )
  text = text.replace(/!?\[([^\]\n]+)\]/g, (all, label: string) => refs.has(label.trim().toLowerCase()) ? label : all)
  // 目标地址允许一层括号，如文档的 https://example.com/a_(b)。
  text = text.replace(/!?\[([^\]]*)\]\(\s*(?:<[^>]*>|(?:[^\s()]|\([^()]*\))*)(?:\s+["'][^"']*["'])?\s*\)/g, '$1')
  text = text.replace(/<((?:https?:\/\/|mailto:)[^\s<>]+)>/g, (_, url: string) => hold(url))
  text = text.replace(/https?:\/\/[^\s<>]+/g, (url) => hold(url))
  text = text.replace(/\*\*\*(?!\s)([\s\S]+?)(?<!\s)\*\*\*/g, '$1')
  text = text.replace(/(\*\*|__)(?!\s)([\s\S]+?)(?<!\s)\1/g, '$2')
  text = text.replace(/~~(?!\s)([\s\S]+?)(?<!\s)~~/g, '$1')
  text = text.replace(/\*(?!\s)([\s\S]+?)(?<!\s)\*/g, '$1')
  text = text.replace(/(^|[\s(（【「])_(?!\s)([\s\S]+?)(?<!\s)_(?=$|[\s)）】」,.，。!！?？;；:：])/g, '$1$2')
  // 表格单元格保持间隔；代码里的竖线仍由占位保护。
  text = text.replace(/^\s*\|(.+)\|\s*$/gm, (_, row: string) => row.replace(/\|/g, ' '))
  text = text.replace(/\uE000(\d+)\uE000/g, (_, index: string) => held[Number(index)] || '')
  return text.replace(/\s+/g, ' ').trim().slice(0, maxLength)
}
