import { posix } from 'node:path'

/**
 * OOXML（docx / xlsx / pptx）解包之后那堆 XML 的几件纯函数：美化、还原、检查。
 * 工具本身在 tools/office.ts。
 *
 * **为什么要美化**：Office 存出来的 XML 是一整行，一份 document.xml 常常几百 KB 挤在
 * 一行里。read_file 按行分页、patch 靠唯一的原文片段定位，对着一行几十万字符两样都
 * 用不了。拆成一个标签一行，模型才读得了、改得准。
 *
 * **美化不能改意思**。XML 里标签之间插空白，插进的是一个「只有空白的文本节点」：
 * 在 `<w:p>`、`<w:r>` 这种只装元素的地方它无关紧要，但在 `<w:t>`（Word 的文字）、
 * `<a:t>`（PPT 的文字）、`<t>`（Excel 的字符串）里它就是正文——多一个换行，文档里就
 * 多一个换行。所以这几种「文本元素」和带 `xml:space="preserve"` 的元素里面一律不插、
 * 不删；还原时也只删**带换行**的纯空白段（美化插进去的都带换行，原文里元素之间
 * 出现换行空白的情况在 Office 存的文件里没有）。
 */

/** 里面的空白算正文的元素（按本地名，不管前缀）。 */
const TEXT_ELEMENTS = new Set(['t', 'instrText', 'delText', 'delInstrText', 'v', 'f'])

/**
 * 标签、注释、CDATA、处理指令、DOCTYPE。
 *
 * 标签那一支**逐个吃属性**，不用 `<[^>]*>`：属性值里允许出现未转义的 `>`，按第一个
 * `>` 切会把标签切断，后面整段都乱掉。
 */
const TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![A-Za-z][^>]*>|<\/?[A-Za-z_][^\s/>]*(?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*\/?>/g

interface Tag {
  kind: 'open' | 'close' | 'empty' | 'other'
  name: string
  /** 带 xml:space="preserve"。 */
  preserve: boolean
}

function tagOf(token: string): Tag {
  if (token.startsWith('<!') || token.startsWith('<?')) return { kind: 'other', name: '', preserve: false }
  const close = token.startsWith('</')
  const name = /^<\/?([^\s/>]+)/.exec(token)?.[1] ?? ''
  if (close) return { kind: 'close', name, preserve: false }
  return {
    kind: token.endsWith('/>') ? 'empty' : 'open',
    name,
    preserve: /\sxml:space\s*=\s*["']preserve["']/.test(token),
  }
}

function localName(name: string): string {
  const i = name.indexOf(':')
  return i === -1 ? name : name.slice(i + 1)
}

/** 这个元素里面的空白是不是正文。 */
function isTextual(tag: Tag): boolean {
  return tag.preserve || TEXT_ELEMENTS.has(localName(tag.name))
}

/** 一个标签一行，两格缩进。文本元素和 preserve 元素里面原样不动。 */
export function prettyXml(xml: string): string {
  const out: string[] = []
  const stack: Tag[] = []
  let depth = 0
  let last = 0
  let first = true
  for (const m of xml.matchAll(TOKEN)) {
    const token = m[0]
    const text = xml.slice(last, m.index)
    last = m.index + token.length
    const tag = tagOf(token)
    const inText = stack.length > 0 && isTextual(stack[stack.length - 1])
    if (tag.kind === 'close') depth = Math.max(0, depth - 1)
    // 只在「两个标签紧挨着」的地方断行：中间有文字就说明这里是正文，不动。
    if (text) out.push(text)
    else if (!first && !inText) out.push('\n' + '  '.repeat(depth))
    out.push(token)
    first = false
    if (tag.kind === 'open') {
      stack.push(tag)
      depth++
    } else if (tag.kind === 'close') {
      stack.pop()
    }
  }
  out.push(xml.slice(last))
  return out.join('')
}

/** prettyXml 的逆操作：删掉非文本元素里「带换行的纯空白」。模型自己加的缩进也一并收掉。 */
export function condenseXml(xml: string): string {
  const out: string[] = []
  const stack: Tag[] = []
  let last = 0
  for (const m of xml.matchAll(TOKEN)) {
    const token = m[0]
    const text = xml.slice(last, m.index)
    last = m.index + token.length
    const inText = stack.length > 0 && isTextual(stack[stack.length - 1])
    if (!(text && !inText && /^\s*$/.test(text) && text.includes('\n'))) out.push(text)
    out.push(token)
    const tag = tagOf(token)
    if (tag.kind === 'open') stack.push(tag)
    else if (tag.kind === 'close') stack.pop()
  }
  const tail = xml.slice(last)
  out.push(/^\s*$/.test(tail) ? '' : tail)
  return out.join('')
}

const ENTITY = /&(?:[A-Za-z_][\w.-]*|#\d+|#x[0-9A-Fa-f]+);/y

/** 位置 → 行号（1 起）。只在出错时算，不在热路径上。 */
function lineAt(xml: string, index: number): number {
  let n = 1
  for (let i = 0; i < index; i++) if (xml.charCodeAt(i) === 10) n++
  return n
}

/** 一段文字（或属性值）里有没有没转义的 `&` / `<`。有就回它在这段里的下标。 */
function badChar(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '<') return i
    if (c === '&') {
      ENTITY.lastIndex = i
      if (!ENTITY.test(s)) return i
    }
  }
  return -1
}

/**
 * 结构检查：标签配对、只有一个根、文字和属性值里没有裸 `&` / `<`。
 *
 * 不是完整的 XML 解析器——命名空间、DTD、字符范围都不管。它要拦的是模型手改时最常见的
 * 那几种错：少写一个闭合标签、多删半个标签、文字里直接写了 `A&B`。这几种 Office 打开时
 * 只会说一句「文件已损坏」，不告诉你是哪儿。回的是第一处错，带行号。
 */
export function checkXml(xml: string): string | null {
  const stack: { name: string; at: number }[] = []
  let roots = 0
  let last = 0
  for (const m of xml.matchAll(TOKEN)) {
    const token = m[0]
    const text = xml.slice(last, m.index)
    const bad = badChar(text)
    if (bad !== -1) {
      const c = text[bad]
      return `第 ${lineAt(xml, last + bad)} 行：文字里有没转义的 \`${c}\`（要写成 ${c === '&' ? '&amp;' : '&lt;'}），或者这里有个没写完整的标签`
    }
    if (!stack.length && text.trim()) return `第 ${lineAt(xml, last)} 行：根元素外面有文字`
    last = m.index + token.length
    const tag = tagOf(token)
    if (tag.kind === 'other') continue
    if (tag.kind !== 'close') {
      for (const v of token.matchAll(/=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        const value = v[1] ?? v[2] ?? ''
        if (badChar(value) !== -1) return `第 ${lineAt(xml, m.index)} 行：<${tag.name}> 的属性值里有没转义的 & 或 <`
      }
      if (!stack.length) {
        roots++
        if (roots > 1) return `第 ${lineAt(xml, m.index)} 行：出现了第二个根元素 <${tag.name}>（前面的根已经闭合了）`
      }
      if (tag.kind === 'open') stack.push({ name: tag.name, at: m.index })
      continue
    }
    const top = stack.pop()
    if (!top) return `第 ${lineAt(xml, m.index)} 行：多出来一个 </${tag.name}>，前面没有对应的开始标签`
    if (top.name !== tag.name) {
      return `第 ${lineAt(xml, m.index)} 行：</${tag.name}> 对不上第 ${lineAt(xml, top.at)} 行的 <${top.name}>（少了 </${top.name}>，或者多了这个闭合标签）`
    }
  }
  const tail = xml.slice(last)
  if (badChar(tail) !== -1 || (tail.trim() && !stack.length)) return `第 ${lineAt(xml, last)} 行：文件末尾有残缺的内容`
  if (stack.length) {
    const top = stack[stack.length - 1]
    return `第 ${lineAt(xml, top.at)} 行的 <${top.name}> 一直没有闭合`
  }
  if (!roots) return '没有根元素'
  return null
}

/** `a/b/_rels/c.xml.rels` → 它描述的那个部件 `a/b/c.xml`；包级的 `_rels/.rels` → ''。 */
function ownerOfRels(relsPath: string): string {
  const dir = posix.dirname(posix.dirname(relsPath))
  const base = posix.basename(relsPath).replace(/\.rels$/, '')
  return dir === '.' ? base : `${dir}/${base}`
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag)
  return m ? (m[1] ?? m[2]) : undefined
}

function unescapeAttr(v: string): string {
  return v
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
}

/**
 * 包级检查：两种「每个 XML 都对、合起来 Office 还是说损坏」的错。
 *
 * 1. **部件没登记类型**：加了一页幻灯片、一张工作表，却没在 `[Content_Types].xml` 里加
 *    Override（或按扩展名的 Default）。
 * 2. **关系指向不存在的部件**：删了一个部件，某个 `.rels` 还引用着它；或者 Target 写错。
 *
 * `parts` 是包里全部路径（posix，无前导 `/`），`read` 取某个部件的文本。回的是问题列表。
 */
export function checkPackage(parts: string[], read: (path: string) => string | undefined): string[] {
  const problems: string[] = []
  const have = new Set(parts)
  const types = read('[Content_Types].xml')
  if (types === undefined) return ['包里没有 [Content_Types].xml']
  const defaults = new Set<string>()
  const overrides = new Set<string>()
  for (const m of types.matchAll(/<(?:\w+:)?Default\b[^>]*>/g)) {
    const ext = attr(m[0], 'Extension')
    if (ext) defaults.add(ext.toLowerCase())
  }
  for (const m of types.matchAll(/<(?:\w+:)?Override\b[^>]*>/g)) {
    const name = attr(m[0], 'PartName')
    if (!name) continue
    const part = decodeURI(name.replace(/^\//, ''))
    overrides.add(part.toLowerCase())
    if (!have.has(part) && !parts.some((p) => p.toLowerCase() === part.toLowerCase())) {
      problems.push(`[Content_Types].xml 里登记了 /${part}，但包里没有这个部件（删掉那条 Override）`)
    }
  }
  /**
   * 「同类部件」：同一目录、去掉数字之后同名（slide1.xml / slide7.xml、sheet2.xml）。
   *
   * 光看 Default 不够：几乎每个包都有 `Default Extension="xml"`，一页漏了 Override 的新
   * 幻灯片会被它当成普通 XML 放过去，而 PowerPoint 认的是 Override 里那个具体类型。所以
   * 同类部件都登记了、唯独它没有，才是真漏了。
   */
  const kindOf = (p: string) => `${posix.dirname(p)}/${posix.basename(p).replace(/\d+/g, '#')}`.toLowerCase()
  const registeredKinds = new Set(parts.filter((p) => overrides.has(p.toLowerCase())).map(kindOf))
  for (const part of parts) {
    if (part === '[Content_Types].xml') continue
    // 不用 extname：`_rels/.rels` 这种点开头的文件名它认成「没有扩展名」。
    const ext = (/\.([^./]+)$/.exec(part)?.[1] ?? '').toLowerCase()
    const registered = overrides.has(part.toLowerCase())
    if (!registered && (!defaults.has(ext) || registeredKinds.has(kindOf(part)))) {
      problems.push(`${part} 在 [Content_Types].xml 里没有登记类型（照同类部件加一条 <Override PartName="/${part}" ContentType="…"/>）`)
    }
  }
  for (const rels of parts.filter((p) => p.endsWith('.rels'))) {
    const text = read(rels)
    if (text === undefined) continue
    const owner = ownerOfRels(rels)
    const base = posix.dirname(owner)
    for (const m of text.matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) {
      if (attr(m[0], 'TargetMode') === 'External') continue
      const raw = attr(m[0], 'Target')
      if (!raw) continue
      const target = unescapeAttr(raw).split('#')[0]
      if (!target) continue
      let resolved: string
      try {
        resolved = decodeURI(target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join(base === '.' ? '' : base, target)))
      } catch {
        resolved = target
      }
      if (!have.has(resolved)) {
        problems.push(`${rels} 里 Id="${attr(m[0], 'Id') ?? '?'}" 指向 ${resolved}，包里没有这个部件`)
      }
    }
  }
  return problems
}
