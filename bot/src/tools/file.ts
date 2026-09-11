import type { Dirent } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { humanSize, looksBinary } from '../workspace/index.ts'
import { docKindOf, extractDocument } from '../workspace/extract.ts'
import { clip, fail, registerTool, SKIPPED_DIRS, walkFiles, type ToolOut } from './common.ts'
import { fuzzyReplace } from './fuzzy.ts'
import type { ToolCall, WorkspaceFile } from './index.ts'

/**
 * file 工具集：`read_file` / `write_file` / `patch` / `search_files`。
 *
 * 这是 Bot 看文件、改文件的那套手。形状照 Hermes Agent 那一套来
 * （见 docs/file-terminal-tools.md），因为模型见过——描述与参数名越接近它熟悉的约定，
 * 调用就越准。跑命令的那把在 tools/terminal.ts。
 *
 * **根目录**：`$SATUWORK_WORK_DIR`——部署时注入的 `/home/{linuxUser}/work`，同一个员工
 * 的所有席位共用的那个共享工作区。没有这个变量（本地跑）时回落 `$SATUWORK_HOME/work`。
 * **不用 `$SATUWORK_HOME`**：那底下是会话日志和 SQLite，让模型的手伸进自己的记忆里，
 * 一条命令就能把历史抹了。
 *
 * 路径参数一律相对根目录解析，越界（`..`、绝对路径指到外面）直接拒。但要把话说清楚：
 * **这不是沙箱**——路径检查挡的是「模型手滑写错路径」，不是「模型想跑出去」。真正的
 * 边界在操作系统那层；策略性的拦截挂 `tools/pre-execute` 的 waterfall。
 */
export const name = 'satu-tools-file'
export const inject = ['tools', 'workspace']

/** 输出上限。喂回模型的东西必须有界，否则一次 `search_files .` 就能把上下文冲掉。 */
const MAX_READ_LINES = 2000
const MAX_LINE_CHARS = 2000
/**
 * 内容搜索时一行最多拿多少字符去跑正则。
 *
 * 用户写的正则是任意的，碰上压缩产物那种几十万字符的单行，回溯能把进程卡死几秒——
 * 那段时间 SSE 心跳、停止按钮全都没响应。超过这个长度的部分不测，命中在后面的就漏了。
 */
const MAX_REGEX_LINE_CHARS = 10_000
/** 内容搜索每扫多少个文件让一次事件循环，好让心跳和中止信号有机会跑。 */
const YIELD_EVERY_FILES = 200
/** 一次读回来最多多少字符。到顶就在行边界停下，带 `next_offset` 让模型接着读。 */
const READ_BUDGET = 100_000
const MAX_TEXT_CHARS = 120_000
const MAX_RESULTS = 200
const DEFAULT_RESULTS = 50
const MAX_CONTEXT_LINES = 5
const MAX_WALK_FILES = 20_000
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024
const MAX_SUBDIRS = 40
/**
 * 一次调用最多报几个「看到的文件」（`ToolResult.refs`）。
 *
 * 有上限是因为它要跟着结果一起写进会话日志：一次全库搜索能扫出两百条，条条落盘、条条
 * 重放。前几十个已经够界面把正文里提到的那几个文件名接上——正文里根本提不到第一百个。
 */
const MAX_REF_FILES = 60

/**
 * glob → 正则。支持 `**`（跨目录）、`*`、`?`。
 * 自带 glob 而不是拉个依赖：这三个元字符覆盖了模型实际会写的绝大多数模式。
 */
function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` 匹配零级或多级目录，所以 `**/*.ts` 也能命中根下的文件。
        if (glob[i + 2] === '/') {
          out += '(?:[^/]+/)*'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else if ('\\^$+.()|[]{}'.includes(c)) {
      out += `\\${c}`
    } else {
      out += c
    }
  }
  return new RegExp(`^${out}$`)
}

/** 没有 `/` 的模式按文件名匹配——`*.ts` 应该找到所有 .ts，不只是根下那几个。 */
function globMatcher(glob: string): (rel: string) => boolean {
  const re = globToRegExp(glob)
  const bare = !glob.includes('/')
  return (rel) => re.test(rel) || (bare && re.test(rel.split('/').pop() ?? rel))
}

/**
 * 起点可以是文件（搜单个文件）也可以是目录。
 *
 * `path` 直接指到一个文件时不看隐藏与否——那是模型明确点名要的那一个。
 */
async function* filesUnder(target: string, hidden: boolean, approvedLink?: (path: string) => boolean): AsyncGenerator<string> {
  const info = await stat(target).catch(() => fail(`路径不存在：${target}`))
  if (info.isFile()) {
    yield target
    return
  }
  yield* walkFiles(target, { left: MAX_WALK_FILES }, hidden, approvedLink)
}

/** 模式是不是在点名要隐藏文件。看的是最后一段——`src/.env` 也算。 */
function wantsHidden(glob?: string): boolean {
  return Boolean(glob && (glob.split('/').pop() ?? '').startsWith('.'))
}

/**
 * `path` 这一层底下有哪些子目录。
 *
 * `search_files(target='files')` 只返回**文件**，而 `ls` 今天还回答另一个问题：这层
 * 底下有哪些目录。少了它，模型看不见空目录，也不知道该往哪一层钻。一行的成本，`ls`
 * 的那半个用途就回来了。
 */
async function subdirsOf(dir: string, approvedLink?: (path: string) => boolean): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[])
  return entries
    .filter((e) => (e.isDirectory() || (e.isSymbolicLink() && approvedLink?.(join(dir, e.name)))) && !SKIPPED_DIRS.has(e.name) && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_SUBDIRS)
}

export function apply(ctx: Context) {
  // 根目录和越界检查都在 workspace 服务上——上传和预览走的是同一份，
  // 各写一份 resolve 迟早会有一条写松。
  const resolveIn = (path?: string) => ctx.workspace.resolve(path)
  const show = (path: string) => ctx.workspace.show(path).split(sep).join('/')
  /** 把一串「相对工作区根」的路径收成 refs（见 tools/index.ts 的 `ToolResult.refs`）。 */
  const refsOf = (paths: string[]): WorkspaceFile[] =>
    paths.slice(0, MAX_REF_FILES).map((path) => ({ path, name: path.split('/').pop() || path }))
  const tool = (
    def: Parameters<typeof registerTool>[1],
    execute: Parameters<typeof registerTool>[2],
  ) => registerTool(ctx, def, execute)

  // ── read_file ────────────────────────────────────────────────────────

  tool(
    {
      name: 'read_file',
      delegation: {},
      risk: ['read'],
      description:
        '读取工作区里的一个文本文件，按行返回，输出格式是 `行号|内容`。终端里的 cat / head / tail 用它代替。' +
        'PDF、Word（.docx）、Excel（.xlsx）会先转成文本再读，同样按行分页。' +
        '大文件用 offset 与 limit 分页；一次读得太多时会在行边界停下，末尾那句话里带着接着读的 offset，照它调下一次。' +
        '改文件之前先读——patch 的 old_string 虽然容得下空白差异，但字要对得上。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径，相对工作区根目录，也可用绝对路径（须在工作区内）。' },
          offset: { type: 'number', description: '从第几行开始读（1 起）。默认 1。' },
          limit: { type: 'number', description: `最多读多少行。默认 ${MAX_READ_LINES}。` },
        },
        required: ['path'],
      },
    },
    async ({ path, offset, limit }: { path?: string; offset?: number; limit?: number }) => {
      if (!path) fail('缺少 path 参数')
      const target = resolveIn(path)
      const info = await stat(target)
      if (info.isDirectory()) fail(`${show(target)} 是目录，用 search_files 列它的内容。`)
      /**
       * 读到的这一个就是 refs。
       *
       * 读完之后模型常常只说「已读取《某某报告》」——用的是文档标题，不是文件名，
       * 界面拿正文一个字也接不上。有这一条，那份报告才在消息底下留下一个能点开的入口。
       */
      const me = refsOf([show(target)])

      /**
       * PDF / Word / Excel 先转成文本，再照常按行分页。
       *
       * 放在 looksBinary 之前：这几种格式**都是二进制**，交给下面那一关只会得到
       * 「不能按文本读」——而它们恰恰是人最想让 Bot 读的东西。
       */
      const kind = docKindOf(target)
      let text: string | undefined
      if (kind) {
        const doc = await extractDocument(target, kind).catch((e: Error) => {
          fail(`${show(target)} 解析失败：${e.message}。文件可能是坏的，或者加了密。`)
        })
        text =
          `${show(target)}（${kind.toUpperCase()}，${doc.parts} ${doc.unit}${doc.truncated ? '，太长已截断' : ''}）\n` +
          '以下是转成文本之后的内容，行号是转换后的行号，不是原文件里的。\n' +
          doc.text
      }

      const buf = text === undefined ? await readFile(target) : Buffer.alloc(0)
      if (text === undefined) {
        if (!buf.length) return { text: `${show(target)} 是空文件。`, refs: me }
        // 二进制读不成文本，但**照样报 refs**：界面能预览的恰恰是这一类（图片、PDF）。
        if (looksBinary(buf)) {
          return { text: `${show(target)} 是二进制文件（${humanSize(info.size)}），不能按文本读。`, refs: me }
        }
      }

      const lines = (text ?? buf.toString('utf8')).split('\n')
      const start = Math.max(1, Math.floor(offset ?? 1))
      const count = Math.max(1, Math.min(Math.floor(limit ?? MAX_READ_LINES), MAX_READ_LINES))
      if (start > lines.length) fail(`offset ${start} 超出文件长度（共 ${lines.length} 行）`)

      const width = String(Math.min(start + count - 1, lines.length)).length
      const picked: string[] = []
      let budget = READ_BUDGET
      let at = start - 1
      for (; at < lines.length && picked.length < count; at++) {
        const body = clip(lines[at], MAX_LINE_CHARS)
        // 第一行无论多长都收下：不然一个超长单行文件会返回空，模型看不出为什么。
        if (picked.length && body.length + width + 1 > budget) break
        budget -= body.length + width + 1
        picked.push(`${String(at + 1).padStart(width, ' ')}|${body}`)
      }

      const left = lines.length - at
      const tail = left > 0 ? `\n…（还有 ${left} 行，用 offset=${at + 1} 接着读）` : ''
      return { text: clip(picked.join('\n'), MAX_TEXT_CHARS) + tail, refs: me }
    },
  )

  // ── write_file ───────────────────────────────────────────────────────

  tool(
    {
      name: 'write_file',
      delegation: {},
      risk: ['write'],
      description:
        '把内容整体写入一个文件，已存在就覆盖，父目录自动创建。终端里的 echo / cat heredoc 用它代替。' +
        '**它覆盖整个文件**——只改一处时用 patch，别用它重写整份内容。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径，相对工作区根目录。' },
          content: { type: 'string', description: '文件的完整内容。' },
        },
        required: ['path', 'content'],
      },
    },
    async ({ path, content }: { path?: string; content?: unknown }) => {
      if (!path) fail('缺少 path 参数。重发一次，path 和 content 两个都要带上。')
      /**
       * `content` 缺失单独说。
       *
       * 带了 path 却没带 content，几乎总是上下文压力下的掉参数——模型自己看不出来，
       * 收到一句「缺少 content 参数」多半会原样再调一次。要明说：把完整内容重发一遍。
       */
      if (content === undefined) {
        fail('缺少 content 参数：这次调用带了 path 却没带内容。把完整的文件内容放进 content 重发一次。')
      }
      if (typeof content !== 'string') fail(`content 必须是字符串，收到的是 ${typeof content}。`)
      const target = resolveIn(path)
      const existed = await stat(target).then(
        (s) => (s.isDirectory() ? fail(`${show(target)} 是目录，不能当文件写。`) : true),
        () => false,
      )
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, 'utf8')
      const bytes = Buffer.byteLength(content)
      return {
        text:
          `${existed ? '已覆盖' : '已创建'} ${show(target)}（${content.split('\n').length} 行，${humanSize(bytes)}）。` +
          '内容已经落盘，不用再读一遍确认。',
        files: [{ path: show(target), name: basename(target) }],
      }
    },
  )

  // ── patch ────────────────────────────────────────────────────────────

  tool(
    {
      name: 'patch',
      delegation: {},
      risk: ['write'],
      description:
        '把文件里的一段文本替换成另一段。终端里的 sed / awk 用它代替。' +
        '匹配是模糊的：空白、缩进、中文排版字符（全角空格、弯引号、破折号）对不上也能命中，但字要一个不差。' +
        'old_string 必须在文件里唯一——不唯一就多带几行上下文，或者置 replace_all。返回统一差异格式。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径，相对工作区根目录。' },
          old_string: { type: 'string', description: '要被替换的原文。从 read_file 的输出里复制时，行号前缀会被自动剥掉。' },
          new_string: { type: 'string', description: '替换成的新文本。传空串表示删除。' },
          replace_all: { type: 'boolean', description: '替换全部出现处。默认 false，只允许唯一匹配。' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
    async ({
      path,
      old_string: oldString,
      new_string: newString,
      replace_all: replaceAll,
    }: { path?: string; old_string?: string; new_string?: string; replace_all?: boolean }) => {
      if (!path) fail('缺少 path 参数')
      if (typeof oldString !== 'string' || !oldString) fail('缺少 old_string 参数')
      if (typeof newString !== 'string') fail('缺少 new_string 参数')

      const target = resolveIn(path)
      const buf = await readFile(target)
      if (looksBinary(buf)) fail(`${show(target)} 是二进制文件，不能编辑。`)

      const r = fuzzyReplace(show(target), buf.toString('utf8'), oldString, newString, Boolean(replaceAll))
      // 「这次编辑已经在文件里了」不是失败：模型的意图是「让文件里有这段话」，而它已经
      // 有了。报失败会让它回去重读、再改一次。
      if (!r.ok) return r.message
      await writeFile(target, r.text, 'utf8')

      /**
       * 命中的策略要报出来，但只在**不是 exact 时**报。
       *
       * 非 exact 意味着我们放宽了排版去凑——模型该知道自己手里那份原文和文件里的对不上，
       * 下一次直接照文件里的写。每次都报的话这句话就成了背景噪音，谁也不会读。
       */
      const how = r.strategy === 'exact' ? '' : `（空白/排版有出入，按 ${r.strategy} 对上的）`
      return {
        text: `已修改 ${show(target)}，替换 ${r.count} 处${how}\n\n${r.diff}`,
        files: [{ path: show(target), name: basename(target) }],
      }
    },
  )

  // ── search_files ─────────────────────────────────────────────────────

  tool(
    {
      name: 'search_files',
      delegation: {},
      risk: ['read'],
      description:
        '搜文件内容，或者按名字找文件。终端里的 grep / rg / find / ls 用它代替。\n' +
        "内容搜索（target='content'，默认）：pattern 是正则，在文件里逐行搜，返回 `路径:行号: 内容`。" +
        "output_mode 可换成 files_only（只列文件）或 count（每个文件命中几条）；context 带上下文行。\n" +
        "文件搜索（target='files'）：pattern 是 glob（如 `*.md`、`src/**/*.ts`），按修改时间从新到旧返回，" +
        '末尾附上这一层的子目录。\n' +
        '二进制文件与 node_modules、.git、dist 这类目录一律跳过；结果多时用 offset 翻页。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '内容搜索时是 JavaScript 正则；文件搜索时是 glob。' },
          target: { type: 'string', enum: ['content', 'files'], description: "搜内容还是找文件。默认 'content'。" },
          path: { type: 'string', description: '从哪个文件或目录开始，相对工作区根目录。默认根目录。' },
          file_glob: { type: 'string', description: '内容搜索时只搜匹配这个 glob 的文件，如 "*.ts"。' },
          output_mode: {
            type: 'string',
            enum: ['content', 'files_only', 'count'],
            description: "内容搜索的输出形态。默认 'content'。",
          },
          context: { type: 'number', description: `内容搜索时每条命中前后各带几行。默认 0，上限 ${MAX_CONTEXT_LINES}。` },
          ignore_case: { type: 'boolean', description: '内容搜索时忽略大小写。默认 false。' },
          limit: { type: 'number', description: `最多返回多少条。默认 ${DEFAULT_RESULTS}，上限 ${MAX_RESULTS}。` },
          offset: { type: 'number', description: '跳过前 N 条，用来翻页。默认 0。' },
        },
        required: ['pattern'],
      },
    },
    async ({
      pattern,
      target,
      path,
      file_glob: fileGlob,
      output_mode: outputMode,
      context,
      ignore_case: ignoreCase,
      limit,
      offset,
    }: {
      pattern?: string
      target?: string
      path?: string
      file_glob?: string
      output_mode?: string
      context?: number
      ignore_case?: boolean
      limit?: number
      offset?: number
    }, call: ToolCall): Promise<ToolOut | string> => {
      if (!pattern) fail('缺少 pattern 参数')
      const mode = target === 'files' ? 'files' : 'content'
      const base = resolveIn(path)
      const cap = Math.max(1, Math.min(Math.floor(limit ?? DEFAULT_RESULTS), MAX_RESULTS))
      const skip = Math.max(0, Math.floor(offset ?? 0))

      if (mode === 'files') {
        const info = await stat(base)
        if (!info.isDirectory()) fail(`${show(base)} 不是目录，找文件要从目录开始。`)
        const match = globMatcher(pattern)
        const found: { rel: string; mtime: number }[] = []
        for await (const file of walkFiles(base, { left: MAX_WALK_FILES }, wantsHidden(pattern), (path) => ctx.workspace.isApprovedLink(path))) {
          // 模式按「相对搜索起点」匹配，展示按「相对工作区根」——前者是模型写模式时
          // 心里想的，后者才能直接喂回 read_file。
          if (!match(relative(base, file).split(sep).join('/'))) continue
          const s = await stat(file).catch(() => undefined)
          found.push({ rel: show(file), mtime: s?.mtimeMs ?? 0 })
        }
        found.sort((a, b) => b.mtime - a.mtime)
        const page = found.slice(skip, skip + cap)
        const dirs = await subdirsOf(base, (path) => ctx.workspace.isApprovedLink(path))
        const foot = dirs.length ? `\n这一层的子目录：${dirs.map((d) => `${d}/`).join('、')}` : ''
        if (!page.length) {
          const why = found.length
            ? `offset ${skip} 超出了结果数（共 ${found.length} 个）`
            : `没有匹配 ${pattern} 的文件`
          return `${why}（起点 ${show(base)}）。${foot}`
        }
        const more =
          found.length > skip + page.length
            ? `\n…（共 ${found.length} 个，这一页 ${skip + 1}–${skip + page.length}，用 offset=${skip + page.length} 看下一页）`
            : ''
        return { text: page.map((f) => f.rel).join('\n') + more + foot, refs: refsOf(page.map((f) => f.rel)) }
      }

      let re: RegExp
      try {
        re = new RegExp(pattern, ignoreCase ? 'i' : '')
      } catch (e) {
        fail(`正则写错了：${(e as Error).message}`)
      }
      const shape = outputMode === 'files_only' || outputMode === 'count' ? outputMode : 'content'
      const around = Math.max(0, Math.min(Math.floor(context ?? 0), MAX_CONTEXT_LINES))
      const match = fileGlob ? globMatcher(fileGlob) : undefined

      /** 命中的文件，按扫到的顺序；`hits` 是这个文件里命中几行。 */
      const files: { rel: string; hits: number }[] = []
      const blocks: string[] = []
      let total = 0
      let stopped = false

      let scanned = 0
      outer: for await (const file of filesUnder(base, wantsHidden(fileGlob), (path) => ctx.workspace.isApprovedLink(path))) {
        if (call.signal?.aborted) break
        if (++scanned % YIELD_EVERY_FILES === 0) await new Promise((r) => setImmediate(r))
        // 起点本身就是个文件时，「相对起点」的路径是空串，什么模式都配不上——那就拿文件名去配。
        if (match && !match(file === base ? basename(file) : relative(base, file).split(sep).join('/'))) continue
        const s = await stat(file).catch(() => undefined)
        if (!s || s.size > MAX_GREP_FILE_BYTES) continue
        const buf = await readFile(file).catch(() => undefined)
        if (!buf || looksBinary(buf)) continue

        const rel = show(file)
        const lines = buf.toString('utf8').split('\n')
        let hits = 0
        /** 这个文件真的往结果里摆了几段。**和 hits 不是一回事**——见下面收尾那一步。 */
        let shown = 0
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i].length > MAX_REGEX_LINE_CHARS ? lines[i].slice(0, MAX_REGEX_LINE_CHARS) : lines[i])) continue
          hits++
          if (shape === 'content') {
            total++
            if (total > skip && blocks.length < cap) {
              const rows: string[] = []
              for (let j = Math.max(0, i - around); j < i; j++) rows.push(`${rel}-${j + 1}- ${clip(lines[j].trim(), MAX_LINE_CHARS)}`)
              rows.push(`${rel}:${i + 1}: ${clip(lines[i].trim(), MAX_LINE_CHARS)}`)
              for (let j = i + 1; j <= Math.min(lines.length - 1, i + around); j++) {
                rows.push(`${rel}-${j + 1}- ${clip(lines[j].trim(), MAX_LINE_CHARS)}`)
              }
              blocks.push(rows.join('\n'))
              shown++
            } else if (blocks.length >= cap) {
              stopped = true
              // 还要不要接着扫：只为了报一个准确的总数不值得把整个工作区读一遍。
              if (shown) files.push({ rel, hits })
              break outer
            }
          }
          if (shape === 'files_only') break
        }
        /**
         * 内容搜索按**摆出来了几段**记这个文件，不按命中几行。
         *
         * 被 offset 整个翻过去的那些文件一行都没进正文，把它们算进「来自 N 个文件」是
         * 虚报；更要紧的是它们会进 `refs`，界面于是在正文底下摆出一颗指向正文根本没提
         * 过的文件的药丸——而 refs 存在的全部意义就是「正文里这个文件名指哪个文件」。
         */
        if (shape === 'content' ? !shown : !hits) continue
        files.push({ rel, hits })
        if (shape !== 'content' && files.length >= skip + cap) {
          stopped = true
          break
        }
      }

      if (shape === 'files_only') {
        const page = files.slice(skip, skip + cap)
        if (!page.length) return `没有文件匹配 ${pattern}（范围 ${show(base)}）。`
        return {
          text: page.map((f) => f.rel).join('\n') + (stopped ? `\n…（已达 ${cap} 条上限，用 offset 翻页）` : ''),
          refs: refsOf(page.map((f) => f.rel)),
        }
      }
      if (shape === 'count') {
        const page = files.slice(skip, skip + cap)
        if (!page.length) return `没有文件匹配 ${pattern}（范围 ${show(base)}）。`
        return {
          text: page.map((f) => `${f.rel}: ${f.hits}`).join('\n') + (stopped ? `\n…（已达 ${cap} 条上限，用 offset 翻页）` : ''),
          refs: refsOf(page.map((f) => f.rel)),
        }
      }
      if (!blocks.length) {
        const why = total ? `offset ${skip} 超出了结果数（共 ${total} 条）` : `没有匹配 ${pattern} 的内容`
        return `${why}（范围 ${show(base)}）。`
      }
      const sep_ = around ? '\n--\n' : '\n'
      const more = stopped
        ? `\n…（已达 ${cap} 条上限，用 offset=${skip + blocks.length} 看下一页，或者缩小范围、加 file_glob）`
        : ''
      return {
        text:
          `${blocks.length} 条匹配，来自 ${files.length} 个文件：\n${blocks.join(sep_)}${more}`,
        refs: refsOf(files.map((f) => f.rel)),
      }
    },
  )
}
