/**
 * Office → PDF 渲染（workspace/render.ts）。
 *
 * 大部分断言跑在一个**假的 soffice** 上（一段 bash）：要钉的是排队、缓存、超时、
 * 缺程序这些这一层自己的行为，和 LibreOffice 转得好不好无关，而且开发机和 CI 上多半
 * 没装 LibreOffice。机器上真有 soffice 时再额外转一份真 docx，看中文和版式出得来。
 *
 * SATUWORK_HOME 要在 import 之前设好；超时每次调用时读，真 soffice 那段前再调大。
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'

const dir = mkdtempSync(join(tmpdir(), 'satu-render-'))
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })
const home = join(dir, 'home')
const log = join(dir, 'fake-log')
mkdirSync(log)
process.env.SATUWORK_HOME = home
process.env.SATUWORK_RENDER_TIMEOUT_MS = '1500'
// 找真 soffice 要赶在把 SATUWORK_SOFFICE 指向假的之前。
const realOverride = process.env.SATUWORK_SOFFICE
delete process.env.SATUWORK_SOFFICE

const { officeExecutable, renderToPdf, renderableOf, RenderError } = await import('./src/workspace/render.ts')
const real = officeExecutable()

/**
 * 假 soffice。照真货的命令行取 --outdir 和输入文件，按输入内容决定怎么表现：
 * HANG 卡住、EMPTY 退出码 0 但什么都不写（真货对读不了的文件就这样）、FAIL 非零退出，
 * LINGER 转完就退、却留一个攥着 stderr 的后台进程，HANGESC 卡住并且留一个**逃出进程组**
 * 的后代攥着 stderr，SLOW 转得慢一点（用来在排队期间改文件），
 * 其余写一份以 %PDF 开头的「PDF」，正文带上输入内容，好认出是哪份转出来的。
 *
 * 每次调用往 calls 里记一行；`running` 目录当互斥标记，撞上了记 overlap——一次只该
 * 跑一个。用户配置目录里要是还留着 .lock，记 stale-lock。
 */
const fake = join(dir, 'soffice')
writeFileSync(
  fake,
  `#!/bin/bash
LOG=${JSON.stringify(log)}
out=""; input=""; profile=""
while [ $# -gt 0 ]; do
  case "$1" in
    --outdir) out="$2"; shift ;;
    -env:UserInstallation=file://*) profile="\${1#-env:UserInstallation=file://}" ;;
    -*) ;;
    *) input="$1" ;;
  esac
  shift
done
echo "$input" >> "$LOG/calls"
[ -e "$profile/.lock" ] && echo stale >> "$LOG/stale-lock"
if ! mkdir "$LOG/running" 2>/dev/null; then echo overlap >> "$LOG/overlap"; fi
body=$(cat "$input")
case "$body" in
  HANGESC*)
    perl -MPOSIX -e 'POSIX::setsid(); sleep 30' & echo $! > "$LOG/escaped-pid"
    sleep 30 & wait $! ;;
  HANG*) sleep 30 & echo $! > "$LOG/hang-pid"; wait ;;
  LINGER*) printf '%%PDF-1.4 fake %s' "$body" > "$out/in.pdf"; sleep 30 & echo $! > "$LOG/linger-pid" ;;
  SLOW*) sleep 0.5; printf '%%PDF-1.4 fake %s' "$body" > "$out/in.pdf" ;;
  EMPTY*) ;;
  FAIL*) echo "boom: cannot load" >&2; rmdir "$LOG/running"; exit 3 ;;
  *) sleep 0.05; printf '%%PDF-1.4 fake %s' "$body" > "$out/in.pdf" ;;
esac
rmdir "$LOG/running" 2>/dev/null
exit 0
`,
)
chmodSync(fake, 0o755)

const calls = () => (existsSync(join(log, 'calls')) ? readFileSync(join(log, 'calls'), 'utf8').trim().split('\n').filter(Boolean).length : 0)
const file = (name, body) => {
  const p = join(dir, name)
  writeFileSync(p, body)
  return p
}
const failure = (e) => (e instanceof RenderError ? { reason: e.reason, message: e.message } : { other: String(e && e.message) })
const out = {}

// ── 1. 认哪些后缀 ─────────────────────────────────────────────────────
out.kinds = {
  docx: renderableOf('a.docx'),
  upper: renderableOf('a.XLSX'),
  ppt: renderableOf('a.ppt'),
  odt: renderableOf('a.odt'),
  pdf: renderableOf('a.pdf'),
  txt: renderableOf('a.txt'),
}

// ── 2. 没装 LibreOffice：明说 unavailable ─────────────────────────────
process.env.SATUWORK_SOFFICE = join(dir, 'no-such-soffice')
out.missing = await renderToPdf(file('m.docx', 'hello')).then(() => ({ rendered: true }), failure)
process.env.SATUWORK_SOFFICE = fake

// ── 3. 正常转，第二次走缓存，文件改了重转 ─────────────────────────────
const a = file('a.docx', 'alpha')
const before = calls()
const pdfA = await renderToPdf(a)
const firstBody = readFileSync(pdfA, 'utf8')
const afterFirst = calls()
const pdfA2 = await renderToPdf(a)
const afterSecond = calls()
writeFileSync(a, 'alpha v2')
utimesSync(a, new Date(), new Date(Date.now() + 5000))
const pdfA3 = await renderToPdf(a)
out.basic = {
  isPdf: firstBody.startsWith('%PDF'),
  rightSource: firstBody.includes('alpha'),
  ranOnce: afterFirst - before === 1,
  cached: afterSecond === afterFirst && pdfA2 === pdfA,
  rerendered: calls() === afterSecond + 1 && readFileSync(pdfA3, 'utf8').includes('alpha v2'),
}

// ── 4. 并发：一次只跑一个，同一份文件合成一次 ─────────────────────────
const c0 = calls()
const same = file('same.pptx', 'same')
const results = await Promise.allSettled([
  renderToPdf(file('p1.docx', 'p1')),
  renderToPdf(file('p2.xlsx', 'p2')),
  renderToPdf(file('p3.pptx', 'p3')),
  renderToPdf(same),
  renderToPdf(same),
])
out.concurrent = {
  allOk: results.every((r) => r.status === 'fulfilled'),
  noOverlap: !existsSync(join(log, 'overlap')),
  sameFileOnce: calls() - c0 === 4,
}

// ── 5. 转坏了：说清楚，而且队伍不断 ───────────────────────────────────
out.empty = await renderToPdf(file('e.docx', 'EMPTY')).then(() => ({ rendered: true }), failure)
out.failed = await renderToPdf(file('f.docx', 'FAIL')).then(() => ({ rendered: true }), failure)
out.afterFailure = await renderToPdf(file('ok.docx', 'still fine')).then((p) => readFileSync(p, 'utf8').includes('still fine'), () => false)

// ── 6. 超时：报超时，整组进程收干净，上一次留下的锁下一次会清 ─────────
const t0 = Date.now()
out.hang = await renderToPdf(file('h.docx', 'HANG')).then(() => ({ rendered: true }), failure)
out.hangMs = Date.now() - t0
await new Promise((r) => setTimeout(r, 200))
/**
 * 进程还在不在。**僵尸不算活着**：它已经死了，只是没人收尸——在 PID 1 不回收僵尸的地方
 * （不带 --init 的容器）被杀的进程会一直挂成 Z，`kill(pid, 0)` 照样成功，只看它会误报。
 */
function alive(pid) {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    // /proc/<pid>/stat：「pid (comm) state ...」，comm 里可能有空格和括号，从最后一个 ) 往后取。
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z'
  } catch {
    return true // 没有 /proc（macOS）：孤儿僵尸由 launchd 马上收掉，kill 0 的结果就够了
  }
}
out.hangChildKilled = !alive(Number(readFileSync(join(log, 'hang-pid'), 'utf8')))
// 假装上一次被杀时留下了锁。
mkdirSync(join(home, 'render-cache', 'profile'), { recursive: true })
writeFileSync(join(home, 'render-cache', 'profile', '.lock'), 'x')
out.afterHang = await renderToPdf(file('after-hang.docx', 'after hang')).then(() => true, () => false)
out.staleLockCleared = !existsSync(join(log, 'stale-lock'))

const killPid = (name) => {
  try {
    process.kill(Number(readFileSync(join(log, name), 'utf8')), 'SIGKILL')
  } catch {}
}

// ── 6b. 进程退了、后代还攥着 stderr：不能永远等 close ────────────────
// 修之前只等 'close'：这一次永不结束，后面所有转换都排在它后面，整个席位的预览一起卡死。
const l0 = Date.now()
out.linger = await Promise.race([
  renderToPdf(file('linger.docx', 'LINGER')).then((p) => readFileSync(p, 'utf8').includes('LINGER'), failure),
  new Promise((r) => setTimeout(() => r('stuck'), 8000)),
])
out.lingerMs = Date.now() - l0
killPid('linger-pid')

// ── 6c. 超时、而且有个后代逃出了进程组：杀不到它也要按时报超时 ─────────
const e0 = Date.now()
out.escaped = await Promise.race([
  renderToPdf(file('esc.docx', 'HANGESC')).then(() => ({ rendered: true }), failure),
  new Promise((r) => setTimeout(() => r('stuck'), 8000)),
])
out.escapedMs = Date.now() - e0
killPid('escaped-pid')
out.afterEscaped = await renderToPdf(file('after-esc.docx', 'after escaped')).then(() => true, () => false)

// ── 6d. 排队期间文件被改：按轮到时的那份记键，内容和键对得上 ──────────
rmSync(join(log, 'running'), { recursive: true, force: true })
const slow = renderToPdf(file('slow.docx', 'SLOW first'))
const moving = file('moving.docx', 'moving v1')
const movingJob = renderToPdf(moving) // stat 到的是 v1，然后排在 SLOW 后面
writeFileSync(moving, 'moving v2')
utimesSync(moving, new Date(), new Date(Date.now() + 10_000))
await slow
const movedPdf = await movingJob
const m0 = calls()
const again = await renderToPdf(moving)
out.moved = {
  newContent: readFileSync(movedPdf, 'utf8').includes('moving v2'),
  // 修之前 v2 的内容存在 v1 的键底下，v2 再来一次还得重转。
  cachedUnderNewKey: again === movedPdf && calls() === m0,
}

// ── 6e. 私有配置目录里写好了「挡外链、禁宏」 ─────────────────────────
const xcu = join(home, 'render-cache', 'profile', 'user', 'registrymodifications.xcu')
const hardening = existsSync(xcu) ? readFileSync(xcu, 'utf8') : ''
out.hardening = {
  blockLinks: /BlockUntrustedRefererLinks[^]*?<value>true<\/value>/.test(hardening),
  noMacros: /DisableMacrosExecution[^]*?<value>true<\/value>/.test(hardening),
}

// ── 7. 太大：不交给 soffice ───────────────────────────────────────────
const big = join(dir, 'big.xlsx')
writeFileSync(big, '')
truncateSync(big, 26 * 1024 * 1024)
const b0 = calls()
out.big = await renderToPdf(big).then(() => ({ rendered: true }), failure)
out.bigNotRun = calls() === b0

// ── 8. 缓存有上限，临时目录不留 ───────────────────────────────────────
for (let i = 0; i < 30; i++) await renderToPdf(file(`many-${i}.docx`, `many ${i}`))
const cacheFiles = readdirSync(join(home, 'render-cache'))
out.cache = {
  pdfs: cacheFiles.filter((n) => n.endsWith('.pdf')).length,
  jobDirs: cacheFiles.filter((n) => n.startsWith('job-')).length,
}

// ── 9. 真 LibreOffice（有才跑）：中文要能出来 ──────────────────────────
if (real || realOverride) {
  process.env.SATUWORK_SOFFICE = realOverride || real
  process.env.SATUWORK_RENDER_TIMEOUT_MS = '120000'
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  )
  zip.folder('_rels').file(
    '.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  )
  zip.folder('word').file(
    'document.xml',
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      '<w:p><w:r><w:t>二季度经营报告</w:t></w:r></w:p><w:p><w:r><w:t>Revenue grew 12%.</w:t></w:r></w:p>' +
      '</w:body></w:document>',
  )
  const realDoc = join(dir, 'real.docx')
  writeFileSync(realDoc, await zip.generateAsync({ type: 'nodebuffer' }))
  try {
    const t = Date.now()
    const pdf = await renderToPdf(realDoc)
    const { extractText, getDocumentProxy } = await import('unpdf')
    const doc = await getDocumentProxy(new Uint8Array(readFileSync(pdf)))
    const { text } = await extractText(doc, { mergePages: true })
    out.real = { ms: Date.now() - t, pages: doc.numPages, chinese: String(text).includes('二季度经营报告'), latin: String(text).includes('Revenue') }
    // Excel：表头和数字都得出来。
    const { default: ExcelJS } = await import('exceljs')
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('销售')
    ws.addRow(['地区', '金额'])
    ws.addRow(['华东', 12345])
    const realXlsx = join(dir, 'real.xlsx')
    await wb.xlsx.writeFile(realXlsx)
    const xdoc = await getDocumentProxy(new Uint8Array(readFileSync(await renderToPdf(realXlsx))))
    const { text: xtext } = await extractText(xdoc, { mergePages: true })
    out.realXlsx = { header: String(xtext).includes('地区'), number: String(xtext).includes('12345') }

    // 外链：docx 里一张指向本机 HTTP 的链接图片。转换时不该有人来取。
    const { createServer } = await import('node:http')
    const hits = []
    const server = createServer((req, res) => {
      hits.push(req.url)
      res.end()
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const port = server.address().port
    const linked = new JSZip()
    linked.file(
      '[Content_Types].xml',
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    )
    linked.folder('_rels').file(
      '.rels',
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    )
    linked.folder('word/_rels').file(
      'document.xml.rels',
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="rImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="http://127.0.0.1:${port}/linked.png" TargetMode="External"/></Relationships>`,
    )
    linked.folder('word').file(
      'document.xml',
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
        'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
        'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:r>' +
        '<w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="p"/><a:graphic>' +
        '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
        '<pic:nvPicPr><pic:cNvPr id="1" name="p"/><pic:cNvPicPr/></pic:nvPicPr>' +
        '<pic:blipFill><a:blip r:link="rImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
        '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr>' +
        '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:body></w:document>',
    )
    const linkedDoc = join(dir, 'linked.docx')
    writeFileSync(linkedDoc, await linked.generateAsync({ type: 'nodebuffer' }))
    const linkedOk = await renderToPdf(linkedDoc).then(() => true, () => false)
    server.close()
    // LibreOffice 退出时会重写配置文件：加固项得还在。
    const after = readFileSync(join(home, 'render-cache', 'profile', 'user', 'registrymodifications.xcu'), 'utf8')
    out.realLinks = { rendered: linkedOk, hits: hits.length, hardeningKept: /BlockUntrustedRefererLinks/.test(after) }
  } catch (e) {
    out.real = failure(e)
  }
} else {
  out.real = null
}

console.log('__RESULT__' + JSON.stringify(out))
