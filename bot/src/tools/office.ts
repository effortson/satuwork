import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { basename, dirname, extname, join, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { humanSize } from '../workspace/index.ts'
import { attr, checkPackage, checkXml, condenseXml, prettyXml, relationships } from '../workspace/ooxml.ts'
import { ToolFailure, fail, registerTool } from './common.ts'
import { MAX_PATCH_BYTES } from './file.ts'
import { newGuide, type NewKind } from './office-new.ts'

/**
 * Office 工具集：`office_unpack` / `office_pack`——改已有的 Word / Excel / PPT，**原格式不丢**。
 *
 * 做法照 OOXML 的本来面目：docx / xlsx / pptx 都是一个 zip，里面是一堆 XML。解开、把 XML
 * 拆成一个标签一行（ooxml.ts 的 prettyXml），模型就能用现成的 read_file / patch 去改；
 * 改完打回 zip。样式、页眉页脚、母版、图表这些模型没碰的东西一个字节都不动——这是它比
 * 「读进某个库、改完再写出来」强的地方：exceljs 写回会丢图表和透视表，docx 库根本读不了
 * 已有文档。
 *
 * **新建文档不走这里**：在 terminal 里写 .cjs 脚本，require('docx') / require('pptxgenjs') /
 * require('exceljs') 生成（terminal 给 node 设好了 NODE_PATH，见 tools/terminal.ts）。写之前
 * 调 `office_guide` 拿那种格式的要点和一份能跑的模板（内容在 office-new.ts）。
 *
 * **格式要点跟着解包结果走**，不常驻：解开 docx 才带回 docx 那份（段、run、修订怎么写），
 * 解开 pptx 才带回复制一页要改哪四处。新建的要点同理，调 office_guide 才给。常驻在提示词里的
 * 只有三把工具的描述。
 *
 * 解出来的东西放在工作区的 `.satuwork/office/` 下：`.satuwork` 本来就不进文件树、不算
 * Bot 的产出（common.ts 的 SKIPPED_DIRS），人看到的只有原文件和打包出来的那一份。
 *
 * 打包前把关：每个 XML 的结构（标签配对、`&` 转义），以及包级的两种错——部件没在
 * `[Content_Types].xml` 里登记、关系指向不存在的部件。这几种错 Office 打开时只说一句
 * 「文件已损坏」，不告诉你是哪儿；这里要指到文件和行号。
 */
export const name = 'satu-tools-office'
export const inject = ['tools', 'workspace']

type Kind = 'docx' | 'xlsx' | 'pptx'

const KINDS: Record<string, Kind> = { '.docx': 'docx', '.xlsx': 'xlsx', '.xlsm': 'xlsx', '.pptx': 'pptx' }

/** 肯解的文件大小。再大的 Office 文档多半是塞满了图片，XML 那部分用不着这么大。 */
const MAX_SOURCE_BYTES = 50 * 1024 * 1024
/**
 * 解开之后的总量上限：zip 炸弹挡在这儿，不等写满磁盘、撑爆内存。
 *
 * 每次解包时读：环境变量只给 e2e 用（造一个几百 MB 的炸弹太慢），而探针的静态 import
 * 先于它设环境变量的那一行执行，模块加载时读就读不到。
 */
function maxUnpacked(): number {
  return Math.max(1024 * 1024, Number(process.env.SATUWORK_OFFICE_MAX_UNPACKED) || 300 * 1024 * 1024)
}
const MAX_ENTRIES = 5000
/**
 * 多大的 XML 还美化。再大的留成一行，说明里讲清楚这份只能用 search_files 找、terminal 改。
 *
 * 美化**之后**还要再看一眼：缩进会让文件涨一截，嵌套深的能翻好几倍。超过 patch 能改的
 * 上限（file.ts 的 MAX_PATCH_BYTES）就不美化——不然解包结果说「改这个文件」，patch 却说
 * 「文件太大」。
 */
const MAX_PRETTY_BYTES = 4 * 1024 * 1024
/** 一次最多报几条错。修完这些再打包，会看到下一批。 */
const MAX_PROBLEMS = 12

interface Manifest {
  /** 原文件，工作区相对路径。 */
  source: string
  kind: Kind
  /** 解包时原文件的样子。打包要覆盖原文件时拿来比：对不上说明别人改过。 */
  mtimeMs: number
  size: number
  /** zip 里原来的顺序。打回去照这个排，新加的排在后面。 */
  order: string[]
  /**
   * 被美化过的那些 → 美化后那份的哈希。
   *
   * 打包时磁盘上那份和哈希对得上，说明模型没碰它，**直接放回原字节**（存在旁边的
   * `<目录>.orig/` 里）；对不上才还原美化。只靠「美化再还原」的话，原文件里本来就带
   * 缩进的部件（Excel 批注的 VML、别的生成器存的 XML）会被顺手压成一行——没碰过的部件
   * 也变了。
   */
  pretty: Record<string, string>
  /**
   * 原文件**本来就有**的问题：包级检查的原话，以及本来就不合格的 XML 部件。
   *
   * 生成器不都那么规矩（pptxgenjs 会登记一个根本不存在的 slideMaster2.xml），而 Office
   * 照样打得开。这些不是模型改出来的，拦着它打包只会让一份文件永远存不回去。打包时
   * 只报**新出现**的问题。
   */
  baseline: string[]
  brokenParts: string[]
}

const isXmlPart = (name: string) => /\.(xml|rels|vml)$/i.test(name)

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

/** 两个路径是不是同一个文件。比 inode，不比字符串：macOS / Windows 上 Report.docx 和 report.docx 是同一个。 */
const sameFile = (a: Stats | null, b: Stats | null) => Boolean(a && b && a.dev === b.dev && a.ino === b.ino)

/** 标签里指向关系的那个 `r:id`（前缀不一定是 r）。不认不带前缀的 `id`——`<p:sldId id="256">` 那个是页号。 */
const relIdOf = (tag: string) => /\s\w+:id\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag)?.slice(1).find((v) => v !== undefined)

type Entry = { name: string; internalStream(type: 'nodebuffer'): JSZipStream }
interface JSZipStream {
  on(event: 'data', cb: (chunk: Buffer) => void): JSZipStream
  on(event: 'error', cb: (e: Error) => void): JSZipStream
  on(event: 'end', cb: () => void): JSZipStream
  resume(): JSZipStream
  pause(): JSZipStream
}

/**
 * 解一个条目，**边解边数**。
 *
 * 不能先看声明的大小再 `async('nodebuffer')`：中央目录里那个大小是文件自己写的，能造假；
 * `async` 会把整个条目解进内存才回来——一个声明几 KB、实际解开几 GB 的条目，进程在检查
 * 生效之前就已经 OOM 了。流着解，超了当场停。
 */
function inflate(entry: Entry, budget: { left: number; limit: number }, shown: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let done = false
    const stream = entry.internalStream('nodebuffer')
    stream
      .on('data', (chunk) => {
        if (done) return
        budget.left -= chunk.length
        if (budget.left < 0) {
          done = true
          stream.pause()
          reject(new ToolFailure(`${shown} 解开超过了上限 ${humanSize(budget.limit)}，不解。`))
          return
        }
        chunks.push(chunk)
      })
      .on('error', (e) => {
        if (done) return
        done = true
        reject(new ToolFailure(`${shown} 里的 ${entry.name} 解不开：${e.message}`))
      })
      .on('end', () => {
        if (done) return
        done = true
        resolve(Buffer.concat(chunks))
      })
      .resume()
  })
}

/** zip 条目名是外部输入：绝对路径、`..`、反斜杠一律不收，不然解包就是往工作区外面写。 */
function safeEntry(name: string): boolean {
  if (!name || name.startsWith('/') || name.includes('\\') || /^[A-Za-z]:/.test(name)) return false
  return !name.split('/').some((seg) => seg === '..')
}

function lineCount(text: string): number {
  let n = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

/** 一份 .rels 里 Id → 目标部件（相对包根）。 */
function relTargets(texts: Map<string, string>, relsPath: string): Map<string, string> {
  return new Map(relationships(relsPath, texts.get(relsPath)).map((r) => [r.id, r.part]))
}

/** 一页里的前几段文字，给「第几页是哪个文件」那张表认页用。 */
function snippet(xml: string | undefined): string {
  const text = [...(xml ?? '').matchAll(/<a:t>([^<]*)<\/a:t>/g)]
    .map((m) => m[1].trim())
    .filter(Boolean)
    .join(' / ')
  return text.length > 40 ? `${text.slice(0, 40)}…` : text
}

/** 解包结果里「这个文件长什么样」那一段：哪些文件要看、各多少行。 */
function overview(kind: Kind, texts: Map<string, string>, dir: string): string {
  const lines = (p: string) => (texts.has(p) ? `（${lineCount(texts.get(p)!)} 行）` : '')
  const at = (p: string) => `${dir}/${p}`
  const out: string[] = []
  if (kind === 'docx') {
    out.push(`正文：${at('word/document.xml')}${lines('word/document.xml')}`)
    const extra = [...texts.keys()].filter((p) => /^word\/(header|footer|footnotes|endnotes|comments)\d*\.xml$/.test(p)).sort()
    if (extra.length) out.push(`页眉页脚 / 脚注 / 批注：${extra.map((p) => `${p}${lines(p)}`).join('，')}`)
    out.push(`样式：${at('word/styles.xml')}`)
  } else if (kind === 'xlsx') {
    const targets = relTargets(texts, 'xl/_rels/workbook.xml.rels')
    out.push('工作表：')
    for (const m of (texts.get('xl/workbook.xml') ?? '').matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
      const part = targets.get(relIdOf(m[0]) ?? '')
      out.push(`  · 「${attr(m[0], 'name') ?? '?'}」 → ${part ? `${at(part)}${lines(part)}` : '（找不到对应文件）'}`)
    }
    if (texts.has('xl/sharedStrings.xml')) out.push(`共享字符串：${at('xl/sharedStrings.xml')}${lines('xl/sharedStrings.xml')}`)
  } else {
    const targets = relTargets(texts, 'ppt/_rels/presentation.xml.rels')
    out.push('页序（按 ppt/presentation.xml 的 <p:sldIdLst>，文件名里的数字不代表第几页）：')
    let n = 0
    for (const m of (texts.get('ppt/presentation.xml') ?? '').matchAll(/<p:sldId\b[^>]*>/g)) {
      const part = targets.get(relIdOf(m[0]) ?? '')
      n++
      const said = part ? snippet(texts.get(part)) : ''
      out.push(`  ${n}. ${part ? `${at(part)}${lines(part)}` : '（找不到对应文件）'}${said ? `「${said}」` : ''}`)
    }
  }
  return out.join('\n')
}

const GUIDE: Record<Kind, string> = {
  docx: [
    'Word 要点：',
    '- 一段是一个 <w:p>；段里的文字按格式切成若干 <w:r>（run），格式在 <w:rPr>，文字在 <w:t>。',
    '- 同一句话常被切在好几个 run 里（拼写检查、改过格式都会切）。先 read_file 看清整段，在 run 里面改；要跨 run 改，就把后面几个 run 的文字并进第一个、删掉其余的（留第一个的 <w:rPr>）。',
    '- 文字首尾有空格时 <w:t> 要带 xml:space="preserve"。文字里的 & < > 写成 &amp; &lt; &gt;。',
    '- 加一段：复制相邻的一整个 <w:p>…</w:p> 再改字，段落样式（<w:pPr>）和字体就跟着走。标题靠 <w:pStyle w:val="…"/>，样式定义在 word/styles.xml。',
    '- 表格：<w:tbl> → <w:tr>（行）→ <w:tc>（格），每格里至少一个 <w:p>。加一行就复制整行 <w:tr>。',
    '- 用户要「修订 / 留痕」时：删的包成 <w:del w:id="…" w:author="…" w:date="…"><w:r><w:delText>旧</w:delText></w:r></w:del>，加的包成 <w:ins …><w:r><w:t>新</w:t></w:r></w:ins>，w:id 不重复。',
    '- w:rsid 之类的属性不用管，别删也别改。',
    '- 别在 XML 里新加图片（要同时动关系、媒体文件、类型登记三处）；要加图就用脚本重新生成。',
  ].join('\n'),
  xlsx: [
    'Excel 要点：',
    '- 单元格 <c r="B3" …>。t="s" 表示 <v> 里是共享字符串的序号（xl/sharedStrings.xml 里第几个 <si>，从 0 数）；数字直接写 <c r="B3"><v>12.5</v></c>。',
    '- 写新文字最省事的是行内字符串：<c r="B3" t="inlineStr"><is><t>文字</t></is></c>，不用去动共享字符串表。',
    '- 公式：<c r="B10"><f>SUM(B2:B9)</f></c>，不写 <v>（旧的缓存值删掉），并在 xl/workbook.xml 的 <calcPr …/> 上加 fullCalcOnLoad="1"，打开时会重算。',
    '- 只改了被公式引用的数（没动公式那一格）也一样要加 fullCalcOnLoad="1"：公式格里存的 <v> 还是改之前算出来的，Excel 不重算就一直显示旧的合计。',
    '- 一行是 <row r="3">，行按行号从小到大排，行里的格按列从左到右排；新格子要插在对的位置。',
    '- 格式靠 s="数字"（xl/styles.xml 里 <cellXfs> 的第几个）。新格子照抄同列相邻格子的 s，格式就一致。',
    '- 合并单元格、条件格式、数据有效性里都有区域引用；大段插行删行会让它们错位，别在 XML 里做。',
    '- 只改数据、而且表里没有图表 / 透视表时，用 exceljs 脚本读进来改完写回更省事（terminal 里 node 跑 .cjs，require(\'exceljs\')）；有图表或透视表的，exceljs 写回会把它们丢掉，只能走解包这条路。',
  ].join('\n'),
  pptx: [
    'PPT 要点：',
    '- 文字在 <p:sp>（形状）→ <p:txBody> → <a:p>（段）→ <a:r>（run）→ <a:t>，格式在 <a:rPr>。和 Word 一样，一句话可能被切成几个 run。',
    '- 标题、正文这类占位符带 <p:ph type="…"/>，位置和字号多半继承自版式（ppt/slideLayouts/）；幻灯片里没写的就别硬加。',
    '- 复制一页要改四处：',
    '  1. 复制 ppt/slides/slideN.xml 成 slideM.xml（M 取没用过的数字），连同 ppt/slides/_rels/slideN.xml.rels 复制成 slideM.xml.rels；',
    '  2. [Content_Types].xml 里照 slideN 加一条 <Override PartName="/ppt/slides/slideM.xml" …/>；',
    '  3. ppt/_rels/presentation.xml.rels 加一条 Relationship（新 Id，Target="slides/slideM.xml"，Type 照抄已有 slide 那条）；',
    '  4. ppt/presentation.xml 的 <p:sldIdLst> 里在想要的位置加 <p:sldId id="…" r:id="新 Id"/>，id 比现有最大的大（不小于 256）。',
    '  复制来的 .rels 里要是有 notesSlide（备注页）那条关系，删掉它，不然两页共用一份备注。',
    '- 删一页：从 <p:sldIdLst> 和 presentation.xml.rels 里去掉，再删掉文件本身、它的 .rels 和那条 Override。',
    '- 调页序只动 <p:sldIdLst> 里 <p:sldId> 的先后。',
  ].join('\n'),
}

/** 递归列出目录下的全部文件（posix 相对路径）。隐藏文件也要：`_rels/.rels` 就是隐藏的。 */
async function listFiles(root: string, rel = ''): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...(await listFiles(root, p)))
    else if (e.isFile()) out.push(p)
  }
  return out
}

export function apply(ctx: Context) {
  const resolveIn = (path?: string) => ctx.workspace.resolve(path)
  const show = (path: string) => ctx.workspace.show(path).split(sep).join('/')
  /** 解包的落点。按原文件的绝对路径取短哈希：同一个文件再解，落在同一个地方。 */
  const workRoot = () => join(ctx.workspace.root, '.satuwork', 'office')
  const workDirOf = (source: string) => {
    const stem = basename(source).replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 60)
    const hash = createHash('sha256').update(source).digest('hex').slice(0, 8)
    return join(workRoot(), `${stem}-${hash}`)
  }

  registerTool(
    ctx,
    {
      name: 'office_unpack',
      delegation: {},
      risk: ['read', 'write'],
      description:
        '要改一份已有的 Word（.docx）/ Excel（.xlsx）/ PPT（.pptx），并且保留它原来的格式时用：把它解成一堆 XML（已拆成一个标签一行），' +
        '然后用 read_file / patch 改，改完调 office_pack 打回原文件。结果里会列出该看哪几个文件，并附上这种格式的改法要点。' +
        '只是读内容用 read_file 就行，不用解包。**新建文档不用它**：先调 office_guide 拿到那种格式的要点和模板，' +
        '再在 terminal 里写 .cjs 脚本生成。同一个文件再解一次会丢掉还没打包的改动。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '要改的文件，相对工作区根目录。' },
        },
        required: ['path'],
      },
    },
    async ({ path }: { path?: string }) => {
      if (!path) fail('缺少 path 参数')
      const source = resolveIn(path)
      const kind = KINDS[extname(source).toLowerCase()]
      if (!kind) {
        fail(
          `${show(source)} 不是 .docx / .xlsx / .pptx。老格式（.doc / .xls / .ppt）要先转成新格式：` +
            '机器上有 LibreOffice 的话，terminal 里 `soffice --headless --convert-to docx 文件` 这样转。',
        )
      }
      const info = await stat(source)
      if (!info.isFile()) fail(`${show(source)} 不是文件。`)
      if (info.size > MAX_SOURCE_BYTES) fail(`${show(source)} 有 ${humanSize(info.size)}，超过了解包的上限 ${humanSize(MAX_SOURCE_BYTES)}。`)

      const { default: JSZip } = await import('jszip')
      let zip: InstanceType<typeof JSZip>
      try {
        zip = await JSZip.loadAsync(await readFile(source))
      } catch (e) {
        fail(`${show(source)} 打不开（${(e as Error).message}）：文件可能是坏的，或者加了密码。`)
      }
      const entries = Object.values(zip.files).filter((f) => !f.dir)
      if (entries.length > MAX_ENTRIES) fail(`${show(source)} 里有 ${entries.length} 个部件，超过上限 ${MAX_ENTRIES}。`)
      // 解压前先看声明的大小，挡掉老实的大包；声明可以造假，真正的闸在 inflate 里边解边数。
      const limit = maxUnpacked()
      const declared = entries.reduce((n, f) => n + Number((f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0), 0)
      if (declared > limit) fail(`${show(source)} 解开有 ${humanSize(declared)}，超过上限 ${humanSize(limit)}。`)
      // JSZip 加载时会把 `../x` 这种名字规整掉、原名放在 unsafeOriginalName 里——两个都看：
      // 名字被人动过手脚的包，规整之后能解也不该解。
      const rawName = (f: (typeof entries)[number]) => (f as unknown as { unsafeOriginalName?: string }).unsafeOriginalName ?? f.name
      const bad = entries.find((f) => !safeEntry(f.name) || !safeEntry(rawName(f)))
      if (bad) fail(`${show(source)} 里有路径不对的部件（${rawName(bad)}），不解。`)

      const dir = workDirOf(source)
      /** 美化过的部件，原字节存在这儿：打包时没被改过的就原样放回去（见 Manifest.pretty）。 */
      const orig = `${dir}.orig`
      for (const p of [dir, orig, `${dir}.json`]) await rm(p, { recursive: true, force: true })
      await mkdir(dir, { recursive: true })
      const texts = new Map<string, string>()
      const pretty: Record<string, string> = {}
      const big: string[] = []
      const budget = { left: limit, limit }
      try {
        for (const f of entries) {
          const bytes = await inflate(f as unknown as Entry, budget, show(source))
          const target = join(dir, ...f.name.split('/'))
          await mkdir(dirname(target), { recursive: true })
          if (isXmlPart(f.name)) {
            const text = bytes.toString('utf8')
            const nice = bytes.length <= MAX_PRETTY_BYTES ? prettyXml(text) : null
            if (nice !== null && Buffer.byteLength(nice) <= MAX_PATCH_BYTES) {
              texts.set(f.name, nice)
              pretty[f.name] = sha(nice)
              await writeFile(target, nice, 'utf8')
              const kept = join(orig, ...f.name.split('/'))
              await mkdir(dirname(kept), { recursive: true })
              await writeFile(kept, bytes)
              continue
            }
            big.push(f.name)
            texts.set(f.name, text)
          }
          await writeFile(target, bytes)
        }
      } catch (e) {
        // 解到一半停下（炸弹、坏条目）：半截目录不留，免得下一次 office_pack 拿它打包。
        await rm(dir, { recursive: true, force: true })
        await rm(orig, { recursive: true, force: true })
        throw e
      }
      const brokenParts = [...texts].filter(([, text]) => checkXml(text) !== null).map(([name]) => name)
      const manifest: Manifest = {
        source: show(source),
        kind,
        mtimeMs: info.mtimeMs,
        size: info.size,
        order: entries.map((f) => f.name),
        pretty,
        baseline: checkPackage(entries.map((f) => f.name), (p) => texts.get(p)),
        brokenParts,
      }
      await writeFile(`${dir}.json`, JSON.stringify(manifest))
      const at = show(dir)
      return {
        text: [
          `已把 ${show(source)} 解到 ${at}/（${entries.length} 个部件）。`,
          overview(kind, texts, at),
          big.length ? `这几个太大没拆行，只能用 search_files 找、terminal 改：${big.join('，')}` : '',
          '',
          GUIDE[kind],
          '',
          `改完调 office_pack（dir="${at}"）打回 ${show(source)}；想另存就给 path。打包前会检查每个 XML 的结构和包里的登记与引用，有错会指到文件和行号。`,
        ]
          .filter((l) => l !== '')
          .join('\n'),
        refs: [{ path: show(source), name: basename(source) }],
      }
    },
  )

  registerTool(
    ctx,
    {
      name: 'office_guide',
      delegation: {},
      risk: ['read'],
      description:
        '要**新建**一份 Word / Excel / PPT 时，写脚本之前先调：返回用脚本生成这种文件的要点（单位、字体、' +
        '常见的坑）和一份能直接跑的最小模板。改已有的文件不用它，用 office_unpack。',
      parameters: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['docx', 'xlsx', 'pptx'], description: '要做的文件类型。' },
        },
        required: ['format'],
      },
    },
    ({ format }: { format?: string }) => {
      const kind = String(format ?? '').toLowerCase().replace(/^\./, '')
      if (kind !== 'docx' && kind !== 'xlsx' && kind !== 'pptx') fail('format 只能是 docx / xlsx / pptx。')
      return newGuide(kind as NewKind)
    },
  )

  registerTool(
    ctx,
    {
      name: 'office_pack',
      delegation: {},
      risk: ['write'],
      description:
        '把 office_unpack 解出来、改好的目录打回 .docx / .xlsx / .pptx。默认覆盖原文件，给 path 就另存。' +
        '打包前检查每个 XML 的结构，以及部件的类型登记和相互引用；有错不写文件，报出是哪个文件第几行。',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'office_unpack 返回的那个目录。' },
          path: { type: 'string', description: '输出到哪儿，相对工作区根目录。不给就覆盖原文件。扩展名要和原文件同类。' },
          keep: { type: 'boolean', description: '打包之后留着解包目录，还要接着改时用。默认 false：打完就删。' },
        },
        required: ['dir'],
      },
    },
    async ({ dir, path, keep }: { dir?: string; path?: string; keep?: boolean }) => {
      if (!dir) fail('缺少 dir 参数：给 office_unpack 返回的那个目录。')
      const work = resolveIn(dir.replace(/\/+$/, ''))
      if (!work.startsWith(workRoot() + sep)) fail(`${dir} 不是 office_unpack 解出来的目录（那些都在 .satuwork/office/ 下）。`)
      const manifest = await readFile(`${work}.json`, 'utf8').then(
        (t) => JSON.parse(t) as Manifest,
        () => fail(`${show(work)} 不是 office_unpack 解出来的目录，或者已经打过包、被收掉了。重新 office_unpack。`),
      )
      const source = resolveIn(manifest.source)
      const out = path ? resolveIn(path) : source
      // 扩展名要**一样**，不是「同类」就行：.xlsm 的主部件是带宏的类型，存成 .xlsx 的话
      // Excel 会说「文件格式或扩展名无效」、直接不开；反过来也一样。
      if (extname(out).toLowerCase() !== extname(source).toLowerCase()) {
        fail(`输出文件的扩展名要和原文件一样（${extname(source)}），收到的是 ${extname(out) || '没有扩展名'}。`)
      }
      const [sourceNow, outNow] = await Promise.all([stat(source).catch(() => null), stat(out).catch(() => null)])
      const overwriting = out === source || sameFile(sourceNow, outNow)
      if (overwriting) {
        const now = sourceNow
        if (now && (now.mtimeMs !== manifest.mtimeMs || now.size !== manifest.size)) {
          fail(
            `${manifest.source} 在解包之后被改过（人或者别的工具），覆盖会把那些改动丢掉。` +
              '给 path 另存一份，或者重新 office_unpack 再改。',
          )
        }
      }

      const names = await listFiles(work)
      if (!names.includes('[Content_Types].xml')) fail(`${show(work)} 里没有 [Content_Types].xml，这不是一个完整的 Office 包。`)
      const problems: string[] = []
      const texts = new Map<string, string>()
      /** 没被改过的美化部件 → 原字节。打包时放它，不放「美化再还原」的那份。 */
      const untouched = new Map<string, Buffer>()
      for (const name of names.filter(isXmlPart)) {
        const text = await readFile(join(work, ...name.split('/')), 'utf8')
        const hash = manifest.pretty[name]
        if (hash && sha(text) === hash) {
          const bytes = await readFile(join(`${work}.orig`, ...name.split('/'))).catch(() => null)
          if (bytes) {
            untouched.set(name, bytes)
            texts.set(name, bytes.toString('utf8'))
            continue
          }
        }
        // 检查的是磁盘上那份（美化过的），行号才对得上 read_file 看到的。原文件里本来就
        // 不合格的部件不查（见 Manifest.baseline）。
        const err = manifest.brokenParts?.includes(name) ? null : checkXml(text)
        if (err) problems.push(`${show(work)}/${name}：${err}`)
        texts.set(name, hash ? condenseXml(text) : text)
      }
      if (!problems.length) {
        const before = new Set(manifest.baseline ?? [])
        problems.push(...checkPackage(names, (p) => texts.get(p)).filter((p) => !before.has(p)))
      }
      if (problems.length) {
        const shown = problems.slice(0, MAX_PROBLEMS)
        fail(
          `没有打包，先修这些${problems.length > shown.length ? `（共 ${problems.length} 处，先列前 ${shown.length} 处）` : ''}：\n` +
            shown.map((p) => `- ${p}`).join('\n'),
        )
      }

      const { default: JSZip } = await import('jszip')
      const zip = new JSZip()
      // [Content_Types].xml 打头，其余照原来的顺序，新加的排在最后。有的读取器只认第一项是它。
      const known = new Set(manifest.order)
      const ordered = [
        '[Content_Types].xml',
        ...manifest.order.filter((n) => n !== '[Content_Types].xml' && names.includes(n)),
        ...names.filter((n) => !known.has(n)).sort(),
      ]
      for (const name of ordered) {
        const content = untouched.get(name) ?? texts.get(name) ?? (await readFile(join(work, ...name.split('/'))))
        // createFolders: false——JSZip 默认会给每一级目录补一个 `word/` 这样的目录条目，
        // Office 自己存的包里没有这种东西，严一点的读取器会把它当成没登记的部件。
        zip.file(name, content, { createFolders: false })
      }
      const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
      await mkdir(dirname(out), { recursive: true })
      // 先写旁边再换名：写到一半出错，原文件还是好的。
      const tmp = join(dirname(out), `.${basename(out)}.${randomUUID().slice(0, 8)}.tmp`)
      try {
        await writeFile(tmp, bytes)
        await rename(tmp, out)
      } catch (e) {
        await rm(tmp, { force: true }).catch(() => {})
        const code = (e as NodeJS.ErrnoException).code
        fail(
          `写不进 ${show(out)}：` +
            (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
              ? '文件可能正被别的程序（比如 Word / Excel / PowerPoint）打开着，请用户关掉它再试，或者给 path 另存一份。'
              : (e as Error).message),
        )
      }
      if (!keep) {
        for (const p of [work, `${work}.orig`, `${work}.json`]) await rm(p, { recursive: true, force: true })
      } else if (overwriting) {
        // 留着接着改：这一份现在就是新的「原文件」，下一次覆盖别再报「被别人改过」。
        const now = await stat(out)
        await writeFile(`${work}.json`, JSON.stringify({ ...manifest, mtimeMs: now.mtimeMs, size: now.size }))
      }
      const added = names.filter((n) => !known.has(n)).length
      const removed = manifest.order.filter((n) => !names.includes(n)).length
      return {
        text:
          `已${overwriting ? '覆盖' : '写出'} ${show(out)}（${ordered.length} 个部件${added ? `，新增 ${added}` : ''}${removed ? `，删掉 ${removed}` : ''}，${humanSize(bytes.length)}）。` +
          (keep ? `解包目录 ${show(work)}/ 留着。` : ''),
        files: [{ path: show(out), name: basename(out) }],
      }
    },
  )
}

