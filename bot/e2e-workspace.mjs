/**
 * 工作区的边界语义。探针要 tsx 才 import 得了 .ts。
 *
 * 这里钉的几乎全是**安全边界**：路径能不能逃出工作区、上传的文件名会不会变成路径、
 * 哪些类型允许浏览器内联。这类错不会在日常使用里露面——它要等到有人专门去试才发作，
 * 所以只能靠断言守着。
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { WorkspaceService, contentTypeOf, safeName } from './src/workspace/index.ts'
import { ToolService } from './src/tools/index.ts'
import * as fileTools from './src/tools/file.ts'
import * as folderTools from './src/tools/folders.ts'
import { walkFiles } from './src/tools/common.ts'

const root = mkdtempSync(join(tmpdir(), 'satu-ws-'))
// 退出时收掉临时目录（和 e2e-memory / e2e-skills 那几个探针同一个写法）：探针是顶层 await 的
// 脚本，没有一个能包 finally 的函数体；exit 钩子在 process.exit、正常结束和未捕获异常三条路上都会跑。
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }) } catch {} })
const ctx = new Context()
ctx.plugin(WorkspaceService, { root, uploadMax: 1024 })
// plugin() 是异步生效的，等一拍再用。
await new Promise((r) => setTimeout(r, 50))
const ws = ctx.workspace

const out = {}
const throws = (fn) => {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

// ── 1. 越界 ───────────────────────────────────────────────────────────
out.escape = {
  上跳: throws(() => ws.resolve('../../../etc/passwd')),
  绕一圈上跳: throws(() => ws.resolve('a/b/../../../../etc/passwd')),
  绝对路径: throws(() => ws.resolve('/etc/passwd')),
  根自己可以: !throws(() => ws.resolve('.')),
  正常路径可以: !throws(() => ws.resolve('a/b/c.txt')),
  // 前缀相同但不是子目录的兄弟目录：`/work` 与 `/workx`，只比字符串前缀会漏掉。
  同前缀兄弟目录: throws(() => ws.resolve('../' + root.split('/').pop() + 'x/evil')),
}

// ── 2. 文件名清洗 ─────────────────────────────────────────────────────
out.names = {
  上跳变普通名: safeName('../../evil.sh'),
  反斜杠也算分隔符: safeName('..\\..\\evil.sh'),
  纯点号不留: safeName('...'),
  空名有兜底: safeName(''),
  中文原样留着: safeName('二季度报表.xlsx'),
  控制字符剔掉: safeName('a\nb\tc.txt'),
  超长截断: safeName('x'.repeat(400)).length,
}

// ── 3. 内联白名单 ─────────────────────────────────────────────────────
out.inline = {
  png: contentTypeOf('a.png').inline,
  pdf: contentTypeOf('a.pdf').inline,
  // 这两个能带 <script>，内联等于在 Gateway 的源上执行上传者的代码。
  svg: contentTypeOf('a.svg').inline,
  html: contentTypeOf('a.html').inline,
  未知格式: contentTypeOf('a.wat').inline,
  未知格式的类型: contentTypeOf('a.wat').contentType,
  大写后缀也认: contentTypeOf('A.PNG').inline,
  markdown按纯文本发: contentTypeOf('a.md').contentType,
}

// ── 4. 上传落盘 ───────────────────────────────────────────────────────
const streamOf = (...chunks) =>
  new ReadableStream({
    start(c) {
      for (const x of chunks) c.enqueue(typeof x === 'string' ? new TextEncoder().encode(x) : x)
      c.close()
    },
  })

const saved = await ws.saveUpload('sess-1', 'hello.txt', streamOf('hello ', 'world'))
out.upload = {
  路径在uploads下: saved.path,
  大小: saved.size,
  内容: readFileSync(join(root, saved.path), 'utf8'),
}

// 同名再传一次：不能覆盖前一份
const again = await ws.saveUpload('sess-1', 'hello.txt', streamOf('second'))
out.collision = {
  换了名字: again.path !== saved.path,
  新路径: again.path,
  头一份还在: readFileSync(join(root, saved.path), 'utf8'),
}

// 文件名想逃出去：只能落在 uploads 里
const evil = await ws.saveUpload('sess-2', '../../../../etc/cron.d/pwn', streamOf('x'))
out.evilName = {
  落点: evil.path,
  没跑出uploads: evil.path.startsWith('uploads/'),
  外面没被写: !existsSync('/etc/cron.d/pwn'),
}

// sessionId 想逃出去：同样只能落在 uploads 里
const evilSession = await ws.saveUpload('../../..', 'a.txt', streamOf('x'))
out.evilSession = { 落点: evilSession.path, 没跑出uploads: evilSession.path.startsWith('uploads/') }

// ── 5. 超限：中断，且不留半个文件 ─────────────────────────────────────
let tooBig = ''
const before = await readdir(join(root, 'uploads', 'sess-3')).catch(() => [])
try {
  await ws.saveUpload('sess-3', 'big.bin', streamOf('x'.repeat(2000)))
} catch (e) {
  tooBig = e.message
}
const after = await readdir(join(root, 'uploads', 'sess-3')).catch(() => [])
out.tooBig = { 报错: Boolean(tooBig), 消息: tooBig, 没留残骸: after.length === before.length }

// ── 6. 读回来预览 ─────────────────────────────────────────────────────
mkdirSync(join(root, 'sub'), { recursive: true })
writeFileSync(join(root, 'sub/pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
const opened = await ws.open('sub/pic.png')
const chunks = []
for await (const c of opened.stream) chunks.push(Buffer.from(c))
out.open = {
  类型: opened.contentType,
  能内联: opened.inline,
  大小: opened.size,
  字节读得回来: Buffer.concat(chunks).toString('hex'),
}
out.openEscape = await ws
  .open('../../../etc/passwd')
  .then(() => false)
  .catch(() => true)

// ── 7. 列目录（右栏那棵文件树） ───────────────────────────────────────
mkdirSync(join(root, 'sub/deep'), { recursive: true })
mkdirSync(join(root, 'sub/.hidden-dir'), { recursive: true })
writeFileSync(join(root, 'sub/a.txt'), 'aa')
writeFileSync(join(root, 'sub/.hidden'), 'x')
symlinkSync('/etc', join(root, 'sub/link'))
const listed = await ws.list('sub')
out.list = {
  路径: listed.path,
  条目: listed.entries.map((e) => `${e.name}${e.dir ? '/' : ''}`),
  // 目录排在文件前面：和 `ls` 工具同一个顺序，两处看到的才是同一个目录。
  目录在前: listed.entries[0]?.dir === true,
  带大小: listed.entries.find((e) => e.name === 'a.txt')?.size,
  路径可直接预览: listed.entries.find((e) => e.name === 'a.txt')?.path,
  // 符号链接能走出工作区，而这一屏是拿来点开预览的——不给它开这个出口。
  没有符号链接: !listed.entries.some((e) => e.name === 'link'),
  没有隐藏项: !listed.entries.some((e) => e.name.startsWith('.')),
}
out.listEscape = await ws
  .list('../../../etc')
  .then(() => false)
  .catch(() => true)
out.listFile = await ws
  .list('sub/a.txt')
  .then(() => false)
  .catch(() => true)

// ── 8. 只读工具报出「看到了哪些文件」 ─────────────────────────────────
/**
 * 界面把正文里的文件名接成可点开的链接，靠的就是这一条（见 tools/index.ts 的
 * `ToolResult.refs`）。**不报就没有链接**，而那时界面什么都不会说——它只会安静地
 * 少一层能力，所以这里钉死。
 */
ctx.plugin(ToolService)
await new Promise((r) => setTimeout(r, 50))
ctx.plugin(fileTools)
await new Promise((r) => setTimeout(r, 100))
writeFileSync(join(root, 'sub/note.md'), '# hi\nTODO here\n')
const call = (name, args) =>
  ctx.tools.execute({ callId: 'c1', name, arguments: JSON.stringify(args), sessionId: 's-1' })
const paths = (r) => (r.refs || []).map((f) => f.path)
out.refs = {
  列文件: paths(await call('search_files', { target: 'files', pattern: '*', path: 'sub' })),
  // 隐藏项默认不列（`ls` 一直是这个口径），点名了才出来。
  隐藏项要点名: paths(await call('search_files', { target: 'files', pattern: '.*', path: 'sub' })),
  读: paths(await call('read_file', { path: 'sub/note.md' })),
  搜内容: paths(await call('search_files', { pattern: 'TODO' })),
  找文件: paths(await call('search_files', { target: 'files', pattern: '*.md' })),
  // 写和改报的是 files（产出），不是 refs——界面对这两样的处理完全不同。
  写的是产出: (await call('write_file', { path: 'sub/new.txt', content: 'x' })).files?.map((f) => f.path),
  写的不报refs: !(await call('write_file', { path: 'sub/new2.txt', content: 'x' })).refs,
}

// ── 9. file 工具集的形状 ──────────────────────────────────────────────
/**
 * 这几条钉的是**换掉七把老工具时不许丢的东西**：行号格式（patch 要靠它剥前缀）、
 * 目录可见性（`ls` 的那半个用途）、以及旧名字有没有出路。
 */
// 顺带钉住「父目录自动创建」：没有它，模型每写一个新目录下的文件都要先跑一条 mkdir。
const deep = await call('write_file', { path: 'sub/deep/inner.txt', content: 'x\n' })
const readOut = await call('read_file', { path: 'sub/note.md' })
const filesOut = await call('search_files', { target: 'files', pattern: '*.md', path: '.' })
out.file = {
  行号格式: readOut.text.split('\n')[0],
  父目录自动建: existsSync(join(root, 'sub/deep/inner.txt')) && !deep.failed,
  目录看得见: filesOut.text.includes('sub/'),
  目录不是文件: !filesOut.text.split('\n').some((l) => l.trim() === 'sub'),
  只列匹配的: filesOut.text.includes('sub/note.md'),
  按名字数: (await call('search_files', { pattern: 'TODO', output_mode: 'count' })).text.trim(),
  带上下文: (await call('search_files', { pattern: 'TODO', context: 1 })).text.includes('-1- # hi'),
  目录不能读: (await call('read_file', { path: 'sub' })).text.includes('search_files'),
  旧名字有出路: (await call('grep', { pattern: 'TODO' })).text,
  没注册的还是没注册: (await call('赫尔墨斯', {})).text,
}

// ── 9b. 翻页时 refs 只报**真的摆出来了**的那些文件 ────────────────────
/**
 * 被 offset 整个翻过去的文件一行都没进正文。把它们算进「来自 N 个文件」是虚报；更要紧
 * 的是它们会进 refs，界面于是在正文底下摆出一颗指向正文根本没提过的文件的药丸——而
 * refs 存在的全部意义就是「正文里这个文件名指哪个文件」。
 */
writeFileSync(join(root, 'sub/一.txt'), 'MARK\n')
writeFileSync(join(root, 'sub/二.txt'), 'MARK\n')
const mark1 = await call('search_files', { pattern: 'MARK', path: 'sub', limit: 1 })
const mark2 = await call('search_files', { pattern: 'MARK', path: 'sub', limit: 1, offset: 1 })
out.paging2 = {
  第一页一个文件: (mark1.refs || []).length === 1,
  第二页也只有一个: (mark2.refs || []).length === 1,
  两页不是同一个: (mark1.refs || [])[0]?.path !== (mark2.refs || [])[0]?.path,
  第二页正文里就是那个文件: mark2.text.includes((mark2.refs || [])[0]?.path ?? ' '),
}

// ── 10. read_file 的分页 ─────────────────────────────────────────────
/**
 * 大文件是**必然**要分页的，而分页的唯一出口是末尾那句话里的 offset。它算错一位，
 * 模型要么漏一行要么重复一行，而两种都看不出来——它只会照着读下去。
 */
writeFileSync(join(root, 'big.txt'), Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 行`).join('\n'))
const page1 = (await call('read_file', { path: 'big.txt', limit: 5 })).text
const page2 = (await call('read_file', { path: 'big.txt', offset: 6, limit: 3 })).text
// 单行超长（压成一行的 JSON、日志）：那一行按字符截断，但**行还在**，后面的行也照读。
// 整份内容不返回、或者卡在第一行，模型都看不出为什么。
writeFileSync(join(root, 'wide.txt'), 'x'.repeat(400_000) + '\nsecond\n')
const wide = (await call('read_file', { path: 'wide.txt' })).text
out.paging = {
  首页最后一行: page1.split('\n')[4],
  接着读的提示: page1.split('\n').pop(),
  第二页第一行: page2.split('\n')[0],
  越界: (await call('read_file', { path: 'big.txt', offset: 999 })).text,
  超长单行不空: wide.startsWith('1|xxx'),
  超长单行被截断: wide.includes('已截断，共 400000 字符'),
  截断之后后面的行还在: wide.includes('2|second'),
}

// ── 遍历预算：走满 ≠ 走不完 ───────────────────────────────────────────
/**
 * `walkFiles` 是「要 yield 之前先减」，所以正好走满预算的那一趟会以 `left === 0`
 * **干干净净地结束**。调用方要是按 `left <= 0` 判「这趟没走完」，就会把一份完整的
 * 结果当成残缺的丢掉——差一个文件，而且是静默的：terminal 的产出扫描正是靠这个判据
 * 决定报不报，判错了整个功能在那种大小的工作区上永远不出声。
 */
{
  const walkRoot = join(root, 'walk')
  mkdirSync(walkRoot, { recursive: true })
  for (let i = 1; i <= 5; i++) writeFileSync(join(walkRoot, `w${i}.txt`), 'x')
  const run = async (left) => {
    const budget = { left }
    const seen = []
    for await (const f of walkFiles(walkRoot, budget, false)) seen.push(f)
    return { got: seen.length, truncated: budget.truncated === true, left: budget.left }
  }
  const exact = await run(5)
  const short = await run(3)
  const roomy = await run(50)
  out.walkBudget = {
    正好走满不算截断: exact.got === 5 && !exact.truncated,
    正好走满也确实归零: exact.left === 0,
    真没走完才算截断: short.got === 3 && short.truncated,
    预算有富余不算截断: roomy.got === 5 && !roomy.truncated,
  }
}

// ── 10b. 大文件与非普通文件 ────────────────────────────────────────
/**
 * read_file 以前整份 `readFile` 再 `split`：一份 1.5 GB 的日志要摆出好几 GB，进程 OOM；
 * 工作区里一个命名管道则让 readFile 一直等写端，中止也叫不醒。这里钉住流着读的口径
 * （跨块的行号、跨块的超长行）、非普通文件一律拒、patch 的大小上限和中止信号。
 */
{
  // 3 MB 出头、跨三四个读块，末行在最后一块里——行号数错一位就对不上。
  const n = 300_000
  writeFileSync(join(root, 'huge.log'), Array.from({ length: n }, (_, i) => `line-${i + 1}-${'y'.repeat(4)}`).join('\n') + '\n')
  const tailPage = (await call('read_file', { path: 'huge.log', offset: n - 1, limit: 5 })).text
  const midPage = (await call('read_file', { path: 'huge.log', offset: 150_000, limit: 2 })).text
  // 一整行比读块还长：截断提示里报的字符数得是整行的，不是第一块的。
  writeFileSync(join(root, 'wide2.txt'), 'z'.repeat(3 * 1024 * 1024) + '\nafter\n')
  const wide2 = (await call('read_file', { path: 'wide2.txt' })).text
  const { execFileSync } = await import('node:child_process')
  let fifoRead = ''
  let fifoPatch = ''
  try {
    execFileSync('mkfifo', [join(root, 'pipe')])
    // 挂住的话 race 那一头会先到——测的就是「不会挂」。
    const hung = new Promise((r) => setTimeout(() => r({ text: '挂住了' }), 3000))
    fifoRead = (await Promise.race([call('read_file', { path: 'pipe' }), hung])).text
    fifoPatch = (await Promise.race([call('patch', { path: 'pipe', old_string: 'a', new_string: 'b' }), hung])).text
  } catch (e) {
    fifoRead = fifoPatch = `mkfifo 失败：${e.message}`
  }
  writeFileSync(join(root, 'fat.txt'), 'q'.repeat(9 * 1024 * 1024))
  const fatPatch = (await call('patch', { path: 'fat.txt', old_string: 'qqq', new_string: 'r' })).text
  const ac = new AbortController()
  ac.abort()
  const aborted = await ctx.tools
    .execute({ callId: 'c2', name: 'read_file', arguments: JSON.stringify({ path: 'huge.log' }), sessionId: 's-1', signal: ac.signal })
    .then((r) => r.text)
    .catch((e) => `抛了：${e.message}`)
  out.bigFiles = {
    跨块末行对得上: tailPage.split('\n')[0] === `${n - 1}|line-${n - 1}-yyyy` && tailPage.split('\n')[1] === `${n}|line-${n}-yyyy`,
    末尾空行照旧算一行: tailPage.split('\n')[2] === `${n + 1}|`,
    中间一页对得上: midPage.split('\n')[0] === '150000|line-150000-yyyy',
    中间一页的提示: midPage.split('\n').pop() === `…（还有 ${n + 1 - 150_001} 行，用 offset=150002 接着读）`,
    超长行跨块也报整行长度: wide2.includes(`已截断，共 ${3 * 1024 * 1024} 字符`) && wide2.includes('2|after'),
    管道读不挂: /不是普通文件/.test(fifoRead),
    管道改不挂: /不是普通文件/.test(fifoPatch),
    太大的不给patch: /超过 patch 能编辑的上限/.test(fatPatch),
    中止了就不读: /已中止/.test(aborted),
    raw: { tailPage, midTail: midPage.split('\n').pop(), fifoRead, fifoPatch, fatPatch, aborted },
  }
}

// ── 11. 删（右栏那棵树上的那颗按钮） ─────────────────────────────────
/**
 * 这一组和上面那些同一个理由：删除是这个目录上**唯一不可逆**的操作，写松了不会有人
 * 报 bug——功能照跑，直到有人拿 `..` 或者一条符号链接去试。
 */
{
  const delRoot = join(root, 'del')
  mkdirSync(join(delRoot, '里面'), { recursive: true })
  writeFileSync(join(delRoot, 'a.txt'), 'x')
  writeFileSync(join(delRoot, '里面/b.txt'), 'x')
  symlinkSync('/etc', join(delRoot, 'link'))
  // 工作区**外面**的一份东西，外加一条指过去的链接：删除得挡住穿过它的那种路径。
  const outside = mkdtempSync(join(tmpdir(), 'satu-out-'))
  writeFileSync(join(outside, 'keep.txt'), 'x')
  mkdirSync(join(outside, '里屋'), { recursive: true })
  symlinkSync(outside, join(delRoot, 'out'))
  const goneFile = await ws.remove('del/a.txt')
  const goneDir = await ws.remove('del/里面')
  out.remove = {
    删得掉文件: !existsSync(join(delRoot, 'a.txt')),
    报出删了什么: goneFile.path,
    目录连里面一起删: !existsSync(join(delRoot, '里面')),
    说清楚删的是目录: goneDir.dir === true,
    // 越界、根、符号链接：三条各挡各的。根那条尤其要紧——`resolve('')` 合法地落在
    // 根上，不单独挡的话一次手滑就是把整个工作区清空。
    越界拦得住: await ws.remove('../../../etc/passwd').then(() => false).catch(() => true),
    根删不掉: await ws.remove('').then(() => false).catch(() => true),
    点号也是根: await ws.remove('.').then(() => false).catch(() => true),
    // 跟着它能走出工作区，而 list 一开始就不列它——树上点不到的东西，这里也不该删得掉。
    符号链接不给删: await ws.remove('del/link').then(() => false).catch(() => true),
    符号链接指的目录还在: existsSync('/etc'),
    // **路上那几段也要认**：只认最后一段的话，`out/keep.txt` 里的 out 是链接、
    // keep.txt 是个规规矩矩的文件，上面那道判断一声不响，删掉的是工作区外面那一份。
    穿过链接的不给删: await ws.remove('del/out/keep.txt').then(() => false).catch(() => true),
    外面那份还在: existsSync(join(outside, 'keep.txt')),
    穿过链接删目录也不给: await ws.remove('del/out/里屋').then(() => false).catch(() => true),
    外面那个目录还在: existsSync(join(outside, '里屋')),
    // 已经不在了要回 ENOENT（上面那层据此回 404）。安静地报成功的话，人看着那一行
    // 消失会以为是自己刚才那一下删的。
    不存在的报ENOENT: await ws.remove('del/没有这个.txt').then(() => '').catch((e) => e.code),
    // 工作区自己还在：删完一层不能把根一起带走。
    工作区还在: existsSync(root),
  }
}

// ── 12. 本地模式：悬空的符号链接 ────────────────────────────────────
/**
 * 本地 Bot（SATUWORK_RUNTIME_KIND=local）没有专用系统用户兜底，resolve 会逐段拒绝
 * 符号链接。这里钉的是**悬空**的那种：链接指向一个还不存在的外部文件（仓库里提交的
 * `cfg -> ~/Library/LaunchAgents/x.plist`）。existsSync 跟着链接走、说它不存在，
 * 检查要是据此提前收手，write_file 就会顺着链接在工作区外面新建出那个文件。
 */
{
  const prevKind = process.env.SATUWORK_RUNTIME_KIND
  process.env.SATUWORK_RUNTIME_KIND = 'local'
  const outside = mkdtempSync(join(tmpdir(), 'satu-dangle-'))
  mkdirSync(join(root, 'dangle'), { recursive: true })
  symlinkSync(join(outside, 'x.plist'), join(root, 'dangle/cfg'))
  symlinkSync(join(outside, '还没有的目录'), join(root, 'dangle/dir'))
  // 先问 resolve：后面那几次写一旦漏过去，链接就不再悬空，这两条也就测不出东西了。
  const resolveFile = throws(() => ws.resolve('dangle/cfg'))
  const resolveThrough = throws(() => ws.resolve('dangle/dir/a.txt'))
  const patched = await call('patch', { path: 'dangle/cfg', old_string: 'a', new_string: 'b' })
  const wroteFile = await call('write_file', { path: 'dangle/cfg', content: 'evil' })
  const wroteThrough = await call('write_file', { path: 'dangle/dir/a.txt', content: 'evil' })
  mkdirSync(join(root, 'uploads/sess-dangle'), { recursive: true })
  symlinkSync(join(outside, 'up.txt'), join(root, 'uploads/sess-dangle/up.txt'))
  const up = await ws.saveUpload('sess-dangle', 'up.txt', streamOf('x')).catch(() => undefined)
  out.dangling = {
    resolve拒绝悬空链接: resolveFile,
    resolve拒绝穿过悬空链接: resolveThrough,
    写悬空链接被拒: /越界/.test(wroteFile.text || ''),
    外面没被写出文件: !existsSync(join(outside, 'x.plist')),
    穿过悬空目录链接被拒: /越界/.test(wroteThrough.text || ''),
    外面没被建出目录: !existsSync(join(outside, '还没有的目录')),
    改悬空链接被拒: /越界/.test(patched.text || ''),
    正常新文件照写: !throws(() => ws.resolve('dangle/新文件.txt')),
    上传不顺着悬空链接写: Boolean(up) && up.path !== 'uploads/sess-dangle/up.txt' && !existsSync(join(outside, 'up.txt')),
  }
  if (prevKind === undefined) delete process.env.SATUWORK_RUNTIME_KIND
  else process.env.SATUWORK_RUNTIME_KIND = prevKind
  rmSync(outside, { recursive: true, force: true })
}

// ── 13. 本地模式：用户批准的文件夹 ──────────────────────────────────
/**
 * 批准过的文件夹（清单 + `External/<名字>` 链接两头都对上）要**真的访问得到**：挂载路径、
 * 模型直接写的绝对路径、`~/` 路径都行；没批准的一样越界。再用一个假的 policy 把
 * request_folder_access 从开卡到返回走一遍：询问那一刻模拟 Desktop 往清单里记一行、建一条
 * 链接，工具要把**新批准的那一个**报回去。
 */
{
  const prevKind = process.env.SATUWORK_RUNTIME_KIND
  const prevDirs = process.env.SATUWORK_APPROVED_DIRS
  const prevHome = process.env.HOME
  process.env.SATUWORK_RUNTIME_KIND = 'local'
  const home = mkdtempSync(join(tmpdir(), 'satu-home-'))
  const dl = join(home, 'Downloads')
  mkdirSync(join(dl, 'sub'), { recursive: true })
  writeFileSync(join(dl, 'a.txt'), '下载里的文件\n')
  writeFileSync(join(dl, 'sub/b.txt'), '深一层 TODO\n')
  const secret = join(home, 'Secret')
  mkdirSync(secret)
  writeFileSync(join(secret, 's.txt'), '不该看到\n')
  const manifest = join(home, 'approved-dirs.json')
  writeFileSync(manifest, JSON.stringify([realpathSync(dl)]))
  process.env.SATUWORK_APPROVED_DIRS = manifest
  process.env.HOME = home
  mkdirSync(join(root, 'External'), { recursive: true })
  symlinkSync(dl, join(root, 'External/Downloads'))
  // 只有链接、不在清单里：既不列，也不给进
  symlinkSync(secret, join(root, 'External/Secret'))

  const mounts = ws.approvedMounts()
  const readAbs = await call('read_file', { path: join(realpathSync(dl), 'a.txt') })
  const readTilde = await call('read_file', { path: '~/Downloads/sub/b.txt' })
  const readMount = await call('read_file', { path: 'External/Downloads/a.txt' })
  const readSecretAbs = await call('read_file', { path: join(realpathSync(secret), 's.txt') })
  const readSecretMount = await call('read_file', { path: 'External/Secret/s.txt' })
  const search = await call('search_files', { pattern: 'TODO', path: 'External/Downloads' })

  let asked = null
  let behave = () => ({ verdict: 'denied', scope: 'once' })
  folderTools.apply({
    tools: ctx.tools,
    workspace: ws,
    policy: { approvals: { ask: async (_call, reason, form) => { asked = asked || { reason, form }; return behave() } } },
  })
  const denied = await call('request_folder_access', { reason: '整理发票', suggested: '~/Desktop' })
  const desk = join(home, 'Desktop')
  mkdirSync(desk)
  behave = () => {
    writeFileSync(manifest, JSON.stringify([realpathSync(dl), realpathSync(desk)]))
    symlinkSync(desk, join(root, 'External/Desktop'))
    return { verdict: 'approved', scope: 'once' }
  }
  const approved = await call('request_folder_access', { reason: '整理发票', suggested: '~/Desktop' })
  behave = () => ({ verdict: 'approved', scope: 'once' })
  const approvedNothing = await call('request_folder_access', { reason: '再来一个' })

  out.folders = {
    列出批准的: JSON.stringify(mounts) === JSON.stringify([{ mount: 'External/Downloads', path: realpathSync(dl) }]),
    绝对路径读得到: /下载里的文件/.test(readAbs.text || ''),
    波浪号路径读得到: /深一层/.test(readTilde.text || ''),
    挂载路径读得到: /下载里的文件/.test(readMount.text || ''),
    没批准的绝对路径照样越界: /越界/.test(readSecretAbs.text || '') && !/不该看到/.test(readSecretAbs.text || ''),
    没批准的挂载照样越界: /越界/.test(readSecretMount.text || '') && !/不该看到/.test(readSecretMount.text || ''),
    搜得进批准的文件夹: /b\.txt/.test(search.text || ''),
    开的是文件夹卡: asked?.form?.kind === 'folder' && asked.form.fields.some((f) => f.key === 'suggested' && f.value === '~/Desktop'),
    拒绝如实说: /拒绝/.test(denied.text || ''),
    批准后只报新入口: /External\/Desktop/.test(approved.text || '') && !/External\/Downloads/.test(approved.text || ''),
    批准了没选说清楚: /没有选新的文件夹/.test(approvedNothing.text || ''),
  }
  // 系统提示里那一段：模型得知道 External/Downloads 就是用户说的「下载目录」。
  const { localFoldersBlock } = await import('./src/agent/index.ts')
  const listed = localFoldersBlock([{ mount: 'External/Downloads', path: '/Users/me/Downloads' }], true)
  const none = localFoldersBlock([], true)
  out.folders.提示词列出入口 = listed.includes('`External/Downloads` → /Users/me/Downloads') && listed.includes('request_folder_access')
  out.folders.没批准时教它申请 = none.includes('request_folder_access') && !none.includes('External/')
  out.folders.远程席位不出现 = localFoldersBlock(null, false) === '' && localFoldersBlock([], false) === ''
  for (const [k, v] of [['SATUWORK_RUNTIME_KIND', prevKind], ['SATUWORK_APPROVED_DIRS', prevDirs], ['HOME', prevHome]]) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(home, { recursive: true, force: true })
}

console.log('__RESULT__' + JSON.stringify(out))
