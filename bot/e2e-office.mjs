/**
 * 改 Office 文档：office_unpack / office_pack，以及它底下那几个 XML 纯函数（workspace/ooxml.ts）。
 * 探针要 tsx 才 import 得了 .ts。
 *
 * 样本全是现场用 docx / pptxgenjs / exceljs 造的，和 e2e-extract 一个理由：二进制样本没人看得懂。
 * 编辑动作照模型真会做的来——read 看到的是解包目录里那份美化过的 XML，patch 按原文片段替换，
 * 加一页按解包结果里给的「四处」一步步做。这一层坏了的表现是 Office 说「文件已损坏」，而
 * 那时候已经没人知道是哪一步，所以每一步都钉。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import JSZip from 'jszip'
import ExcelJS from 'exceljs'
import PptxGenJS from 'pptxgenjs'
import { Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun, HeadingLevel } from 'docx'
import { WorkspaceService } from './src/workspace/index.ts'
import { ToolService } from './src/tools/index.ts'
import * as fileTools from './src/tools/file.ts'
import * as officeTools from './src/tools/office.ts'
import * as terminalTools from './src/tools/terminal.ts'
import { extractDocument } from './src/workspace/extract.ts'
import { checkPackage, checkXml, condenseXml, prettyXml } from './src/workspace/ooxml.ts'

// 解包总量上限调小：要造一个「声明很小、实际很大」的炸弹，几百 MB 太慢。office.ts 每次解包时读它。
process.env.SATUWORK_OFFICE_MAX_UNPACKED = String(16 * 1024 * 1024)
const home = mkdtempSync(join(tmpdir(), 'satu-office-home-'))
process.env.SATUWORK_HOME = home
const root = mkdtempSync(join(tmpdir(), 'satu-office-'))
process.on('exit', () => {
  try { rmSync(home, { recursive: true, force: true }) } catch {}
  try { rmSync(root, { recursive: true, force: true }) } catch {}
})

const ctx = new Context()
ctx.provide('logger', { warn() {}, info() {}, error() {} })
ctx.plugin(WorkspaceService, { root })
await new Promise((r) => setTimeout(r, 50))
ctx.plugin(ToolService)
await new Promise((r) => setTimeout(r, 50))
ctx.plugin(fileTools)
ctx.plugin(officeTools)
ctx.plugin(terminalTools)
await new Promise((r) => setTimeout(r, 100))

let seq = 0
const call = async (name, args) => (await ctx.tools.execute({ callId: `c${++seq}`, name, arguments: JSON.stringify(args), sessionId: 's-1' })).text ?? ''
const callFull = (name, args) => ctx.tools.execute({ callId: `c${++seq}`, name, arguments: JSON.stringify(args), sessionId: 's-1' })
const at = (p) => join(root, p)
/** 解包结果里那个目录。 */
const dirOf = (text) => (/解到 (\S+?)\/（/.exec(text) ?? [])[1]
const zipText = async (file, part) => (await JSZip.loadAsync(readFileSync(file))).file(part)?.async('string')
const out = {}

// ── 1. 美化 / 还原：一个字不许变 ───────────────────────────────────────
{
  const sample =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
    '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t xml:space="preserve">  两个空格  </w:t></w:r><w:r><w:t></w:t></w:r>' +
    '<w:r><w:rPr><w:b/></w:rPr><w:t>A&amp;B</w:t></w:r></w:p></w:body></w:document>'
  const sheet = '<sst><si><t>第一行\n  第二行</t></si><si><t xml:space="preserve">\n</t></si></sst>'
  const attrGt = '<a x="1>2"><b/></a>'
  const nice = prettyXml(sample)
  out.pretty = {
    多行了: nice.split('\n').length > 8,
    还原一致: condenseXml(nice) === condenseXml(sample),
    // 美化之后正文一个字都不能变：w:t 里的空格、Excel 字符串里的换行。
    保留空格: nice.includes('<w:t xml:space="preserve">  两个空格  </w:t>'),
    空文本不插行: nice.includes('<w:t></w:t>'),
    字符串换行不动: condenseXml(prettyXml(sheet)) === sheet,
    属性里的大于号: condenseXml(prettyXml(attrGt)) === attrGt,
  }
}

// ── 2. 结构检查：手滑的几种样子都认得出来，带行号 ─────────────────────
{
  const good = prettyXml('<a><b><c>x</c></b><d/></a>')
  const lines = good.split('\n')
  const dropClose = lines.filter((l) => l.trim() !== '</b>').join('\n')
  out.check = {
    好的放过: checkXml(good) === null,
    少闭合: checkXml(dropClose),
    裸和号: checkXml('<a>\n<b>A&B</b>\n</a>'),
    多闭合: checkXml('<a></a></b>'),
    属性里裸和号: checkXml('<a x="A&B"/>'),
    实体放过: checkXml('<a x="&amp;&#10;&#x4e2d;">&lt;&gt;&quot;</a>') === null,
  }
}

// ── 3. 包级检查：漏登记类型、关系指向没有的部件 ───────────────────────
{
  const types = (extra = '') =>
    '<Types><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="r"/>' +
    '<Override PartName="/ppt/presentation.xml" ContentType="p"/><Override PartName="/ppt/slides/slide1.xml" ContentType="s"/>' +
    extra +
    '</Types>'
  const rels = (target) => `<Relationships><Relationship Id="rId1" Type="t" Target="${target}"/><Relationship Id="rId9" Type="h" Target="https://x" TargetMode="External"/></Relationships>`
  const pkg = (files) => checkPackage(Object.keys(files), (p) => files[p])
  const base = {
    '[Content_Types].xml': types(),
    '_rels/.rels': rels('ppt/presentation.xml'),
    'ppt/presentation.xml': '<p/>',
    'ppt/_rels/presentation.xml.rels': rels('slides/slide1.xml'),
    'ppt/slides/slide1.xml': '<s/>',
  }
  out.pkg = {
    好的放过: pkg(base).length === 0,
    // 新加的 slide2 光靠 Default xml 会被放过去，PowerPoint 却认不出它是幻灯片。
    漏登记: pkg({ ...base, 'ppt/slides/slide2.xml': '<s/>' }).join('\n'),
    断引用: pkg({ ...base, 'ppt/_rels/presentation.xml.rels': rels('slides/slide7.xml') }).join('\n'),
    登记了没有的: pkg({ ...base, '[Content_Types].xml': types('<Override PartName="/ppt/slides/slide3.xml" ContentType="s"/>') }).join('\n'),
  }
}

// ── 4. Word：改一个数字，别的字节一个不动 ─────────────────────────────
{
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: '二季度经营报告', heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ children: [new TextRun('本季度收入同比增长 '), new TextRun({ text: '12%', bold: true }), new TextRun('。')] }),
          new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph('地区')] }), new TableCell({ children: [new Paragraph('华东')] })] })] }),
        ],
      },
    ],
  })
  writeFileSync(at('report.docx'), await Packer.toBuffer(doc))
  const before = await JSZip.loadAsync(readFileSync(at('report.docx')))
  const unpacked = await call('office_unpack', { path: 'report.docx' })
  const dir = dirOf(unpacked)
  const docXml = readFileSync(at(`${dir}/word/document.xml`), 'utf8')
  const patched = await call('patch', { path: `${dir}/word/document.xml`, old_string: '<w:t xml:space="preserve">12%</w:t>', new_string: '<w:t xml:space="preserve">15%</w:t>' })
  const patchedPlain = patched.includes('找不到') ? await call('patch', { path: `${dir}/word/document.xml`, old_string: '>12%</w:t>', new_string: '>15%</w:t>' }) : ''
  const packed = await callFull('office_pack', { dir })
  const after = await JSZip.loadAsync(readFileSync(at('report.docx')))
  const text = (await extractDocument(at('report.docx'), 'docx')).text
  const untouched = []
  for (const name of Object.keys(before.files)) {
    if (name === 'word/document.xml' || before.files[name].dir) continue
    const a = await before.file(name).async('string')
    const b = await after.file(name)?.async('string')
    if (a !== b) untouched.push(name)
  }
  out.docx = {
    说了该看哪个文件: unpacked.includes('word/document.xml'),
    带了Word要点: unpacked.includes('Word 要点') && !unpacked.includes('PPT 要点'),
    解开是多行的: docXml.split('\n').length > 20,
    改上了: !(patched + patchedPlain).includes('找不到'),
    打包成功: (packed.text ?? '').includes('已覆盖'),
    报了产出: JSON.stringify(packed.files ?? []),
    新数字在: text.includes('15%') && !text.includes('12%'),
    表格还在: text.includes('华东'),
    别的部件没动: untouched,
    解包目录收掉了: !existsSync(at(dir)) && !existsSync(at(`${dir}.json`)),
    // 打回去的 XML 是一行的（和 Office 自己存的一样），不是美化过的那份。
    打回去是紧凑的: (await after.file('word/document.xml').async('string')).split('\n').length <= 3,
    内容类型打头: Object.keys(after.files)[0] === '[Content_Types].xml',
  }
}

// ── 5. PPT：照解包结果里的「四处」复制一页 ────────────────────────────
{
  const pres = new PptxGenJS()
  pres.addSlide().addText('封面：年度总结', { x: 1, y: 1, w: 8, h: 1 })
  pres.addSlide().addText('第二页：收入', { x: 1, y: 1, w: 8, h: 1 })
  await pres.writeFile({ fileName: at('deck.pptx') })
  const unpacked = await call('office_unpack', { path: 'deck.pptx' })
  const dir = dirOf(unpacked)
  const d = (p) => at(`${dir}/${p}`)
  out.pptxOverview = {
    列了页序: /1\. \S+slide1\.xml.*封面/.test(unpacked) && /2\. \S+slide2\.xml.*第二页/.test(unpacked),
    带了PPT要点: unpacked.includes('复制一页要改四处'),
  }

  // 1. 复制文件和它的 .rels（备注页那条关系删掉）
  cpSync(d('ppt/slides/slide2.xml'), d('ppt/slides/slide3.xml'))
  writeFileSync(
    d('ppt/slides/_rels/slide3.xml.rels'),
    readFileSync(d('ppt/slides/_rels/slide2.xml.rels'), 'utf8').replace(/\n\s*<Relationship[^>]*notesSlide[^>]*\/>/g, ''),
  )
  await call('patch', { path: `${dir}/ppt/slides/slide3.xml`, old_string: '第二页：收入', new_string: '第三页：成本' })
  // 先不登记类型，直接打包：要被拦下，而且原文件不许动。
  const deckBefore = statSync(at('deck.pptx')).mtimeMs
  const early = await call('office_pack', { dir, keep: true })
  out.pptxMissingType = { 拦下了: early.includes('没有打包') && early.includes('slide3.xml') && early.includes('[Content_Types].xml'), 原文件没动: statSync(at('deck.pptx')).mtimeMs === deckBefore }

  // 2. Override
  const types = readFileSync(d('[Content_Types].xml'), 'utf8')
  const override = /<Override PartName="\/ppt\/slides\/slide2\.xml"[^>]*\/>/.exec(types)[0]
  writeFileSync(d('[Content_Types].xml'), types.replace(override, `${override}${override.replace('slide2.xml', 'slide3.xml')}`))
  // 3. 关系
  const presRels = readFileSync(d('ppt/_rels/presentation.xml.rels'), 'utf8')
  const slideRel = /<Relationship[^>]*Target="slides\/slide2\.xml"[^>]*\/>/.exec(presRels)[0]
  writeFileSync(
    d('ppt/_rels/presentation.xml.rels'),
    presRels.replace(slideRel, `${slideRel}${slideRel.replace(/Id="[^"]*"/, 'Id="rIdNew3"').replace('slide2.xml', 'slide3.xml')}`),
  )
  // 4. sldIdLst
  const presXml = readFileSync(d('ppt/presentation.xml'), 'utf8')
  const ids = [...presXml.matchAll(/<p:sldId id="(\d+)"/g)].map((m) => Number(m[1]))
  writeFileSync(d('ppt/presentation.xml'), presXml.replace('</p:sldIdLst>', `<p:sldId id="${Math.max(...ids) + 1}" r:id="rIdNew3"/></p:sldIdLst>`))
  const packed = await call('office_pack', { dir })
  const text = (await extractDocument(at('deck.pptx'), 'pptx')).text
  out.pptxAdd = { 打包成功: packed.includes('已覆盖') && packed.includes('新增 2'), 三页: text.includes('第三页：成本') && text.includes('封面'), 页数: (await extractDocument(at('deck.pptx'), 'pptx')).parts }
}

// ── 6. Excel：表名对得上文件，改一格 ─────────────────────────────────
{
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('销售')
  ws.addRow(['地区', '金额'])
  ws.addRow(['华东', 100])
  ws.getCell('B3').value = { formula: 'SUM(B2:B2)', result: 100 }
  wb.addWorksheet('备注').addRow(['说明'])
  await wb.xlsx.writeFile(at('sales.xlsx'))
  const unpacked = await call('office_unpack', { path: 'sales.xlsx' })
  const dir = dirOf(unpacked)
  const sheetFile = (/「销售」 → (\S+?sheet\d+\.xml)/.exec(unpacked) ?? [])[1]
  const xml = sheetFile ? readFileSync(at(sheetFile), 'utf8') : ''
  // 照要点里的写法：A2 换成行内字符串。
  const cell = /<c r="A2"[^>]*>[\s\S]*?<\/c>/.exec(xml)?.[0] ?? ''
  const style = /\ss="\d+"/.exec(cell)?.[0] ?? ''
  const patched = cell ? await call('patch', { path: sheetFile, old_string: cell, new_string: `<c r="A2"${style} t="inlineStr"><is><t>华南</t></is></c>` }) : '没找到 A2'
  const packed = await call('office_pack', { dir })
  const back = new ExcelJS.Workbook()
  await back.xlsx.readFile(at('sales.xlsx'))
  out.xlsx = {
    表名对上文件: Boolean(sheetFile) && unpacked.includes('「备注」'),
    带了Excel要点: unpacked.includes('Excel 要点'),
    改上了: !patched.includes('找不到') && !patched.includes('没找到'),
    打包成功: packed.includes('已覆盖'),
    新值: back.getWorksheet('销售').getCell('A2').value,
    公式还在: back.getWorksheet('销售').getCell('B3').formula,
  }
}

// ── 7. XML 写坏了：不打包，指到文件和行号 ──────────────────────────────
{
  writeFileSync(at('broken.docx'), await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('原文')] }] })))
  const before = readFileSync(at('broken.docx'))
  const dir = dirOf(await call('office_unpack', { path: 'broken.docx' }))
  const docPath = `${dir}/word/document.xml`
  await call('patch', { path: docPath, old_string: '原文', new_string: 'A&B' })
  const r = await call('office_pack', { dir })
  out.broken = {
    拦下了: r.includes('没有打包'),
    指到文件和行: /word\/document\.xml：第 \d+ 行/.test(r) && r.includes('&amp;'),
    原文件没动: Buffer.compare(before, readFileSync(at('broken.docx'))) === 0,
    目录还在能接着修: existsSync(at(dir)),
  }
}

// ── 8. 解包之后原文件被别人改过：不许覆盖，另存可以 ───────────────────
{
  writeFileSync(at('shared.docx'), await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('v1')] }] })))
  const dir = dirOf(await call('office_unpack', { path: 'shared.docx' }))
  writeFileSync(at('shared.docx'), await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('别人改的 v2')] }] })))
  utimesSync(at('shared.docx'), new Date(), new Date(Date.now() + 5000))
  const r = await call('office_pack', { dir })
  const saved = await call('office_pack', { dir, path: 'shared-副本.docx' })
  out.conflict = {
    拦下了: r.includes('被改过'),
    别人的改动还在: (await extractDocument(at('shared.docx'), 'docx')).text.includes('别人改的 v2'),
    另存成功: saved.includes('已写出') && existsSync(at('shared-副本.docx')),
  }
}

// ── 9. keep：留着目录接着改，第二次覆盖不误报「被改过」 ─────────────────
{
  writeFileSync(at('iter.docx'), await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('第一稿')] }] })))
  const dir = dirOf(await call('office_unpack', { path: 'iter.docx' }))
  await call('patch', { path: `${dir}/word/document.xml`, old_string: '第一稿', new_string: '第二稿' })
  const first = await call('office_pack', { dir, keep: true })
  await call('patch', { path: `${dir}/word/document.xml`, old_string: '第二稿', new_string: '第三稿' })
  const second = await call('office_pack', { dir })
  out.keep = {
    第一次: first.includes('已覆盖') && first.includes('留着'),
    第二次: second.includes('已覆盖'),
    最终内容: (await extractDocument(at('iter.docx'), 'docx')).text.includes('第三稿'),
  }
}

// ── 10. 外部输入：条目带 ../ 的包不解；不是 Office 的说清楚 ────────────
{
  // JSZip 生成时会把 `../` 规整掉，所以先用同样长度的占位名生成，再在字节里换成 `../../`
  // （本地头和中央目录各一处；CRC 只算内容，不受影响）——这才是一个真带 `../` 的包。
  const evil = new JSZip()
  evil.file('[Content_Types].xml', '<Types/>')
  evil.file('XXXXXXescaped.xml', '<x/>')
  const evilBytes = await evil.generateAsync({ type: 'nodebuffer' })
  writeFileSync(at('evil.docx'), Buffer.from(evilBytes.toString('latin1').replaceAll('XXXXXXescaped.xml', '../../escaped.xml'), 'latin1'))
  const r = await call('office_unpack', { path: 'evil.docx' })
  writeFileSync(at('old.doc'), 'x')
  const old = await call('office_unpack', { path: 'old.doc' })
  out.inputs = {
    拒了: r.includes('路径不对'),
    没逃出去: !existsSync(join(root, '..', 'escaped.xml')) && !existsSync(join(root, '.satuwork', 'escaped.xml')),
    老格式指了路: old.includes('--convert-to'),
  }
}

// ── 11. 新建：terminal 里的 .cjs 脚本 require 得到这几个库 ──────────────
{
  writeFileSync(
    at('gen.cjs'),
    [
      "const fs = require('fs')",
      "const { Document, Packer, Paragraph } = require('docx')",
      "const PptxGenJS = require('pptxgenjs')",
      "const ExcelJS = require('exceljs')",
      ';(async () => {',
      "  fs.writeFileSync('made.docx', await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('脚本生成')] }] })))",
      "  const p = new PptxGenJS(); p.addSlide().addText('脚本生成', { x: 1, y: 1, w: 6, h: 1 }); await p.writeFile({ fileName: 'made.pptx' })",
      "  const wb = new ExcelJS.Workbook(); wb.addWorksheet('S').addRow(['脚本生成']); await wb.xlsx.writeFile('made.xlsx')",
      "  console.log('made ok')",
      '})()',
    ].join('\n'),
  )
  // 清掉外面的 NODE_PATH：要证明是 terminal 自己给的，不是跑探针的这个环境碰巧有。
  delete process.env.NODE_PATH
  const r = await call('terminal', { command: 'node gen.cjs' })
  out.create = {
    跑通了: r.includes('made ok'),
    三个都有: ['made.docx', 'made.pptx', 'made.xlsx'].every((f) => existsSync(at(f))),
    docx能读: existsSync(at('made.docx')) ? (await extractDocument(at('made.docx'), 'docx')).text.includes('脚本生成') : false,
    输出: r.slice(0, 300),
  }
}

// ── 12. 原文件本来就带缩进的部件：没碰过就原字节放回 ────────────────
{
  const base = await JSZip.loadAsync(await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('缩进样本')] }] })))
  // styles.xml 换成带 CRLF 缩进的版本（别的生成器就这么存）；再加一个 Excel 批注那种不合格的 VML。
  const styles = await base.file('word/styles.xml').async('string')
  base.file('word/styles.xml', prettyXml(styles).replace(/\n/g, '\r\n'))
  base.file('word/vmlDrawing1.vml', '<xml xmlns:v="urn:v">\r\n <v:shape>\r\n  <div>第一行<br>第二行</div>\r\n </v:shape>\r\n</xml>')
  const types = await base.file('[Content_Types].xml').async('string')
  base.file('[Content_Types].xml', types.replace('<Default ', '<Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/><Default '))
  writeFileSync(at('indented.docx'), await base.generateAsync({ type: 'nodebuffer' }))
  const before = await JSZip.loadAsync(readFileSync(at('indented.docx')))
  const dir = dirOf(await call('office_unpack', { path: 'indented.docx' }))
  await call('patch', { path: `${dir}/word/document.xml`, old_string: '缩进样本', new_string: '改过了' })
  const packed = await call('office_pack', { dir })
  const after = await JSZip.loadAsync(readFileSync(at('indented.docx')))
  const changed = []
  for (const name of Object.keys(before.files)) {
    if (name === 'word/document.xml' || before.files[name].dir) continue
    const a = await before.file(name).async('nodebuffer')
    const b = await after.file(name)?.async('nodebuffer')
    if (!b || Buffer.compare(a, b) !== 0) changed.push(name)
  }
  out.byteIdentical = {
    打包成功: packed.includes('已覆盖'),
    改的那处在: (await extractDocument(at('indented.docx'), 'docx')).text.includes('改过了'),
    没碰过的原字节: changed,
    // JSZip 默认会补 `word/` 这样的目录条目，Office 自己存的包里没有。
    没有目录条目: !Object.keys(after.files).some((n) => n.endsWith('/')),
    原字节目录收掉了: !existsSync(at(`${dir}.orig`)),
  }
}

// ── 13. 扩展名：xlsm 不许存成 xlsx ─────────────────────────────────────
{
  const wb = new ExcelJS.Workbook()
  wb.addWorksheet('S').addRow(['宏'])
  await wb.xlsx.writeFile(at('macro.xlsm'))
  const dir = dirOf(await call('office_unpack', { path: 'macro.xlsm' }))
  const r = await call('office_pack', { dir, path: 'macro-copy.xlsx', keep: true })
  const ok = await call('office_pack', { dir, path: 'macro-copy.xlsm' })
  out.ext = { 拒了: r.includes('扩展名要和原文件一样') && !existsSync(at('macro-copy.xlsx')), 同扩展名可以: ok.includes('已写出') }
}

// ── 14. 炸弹：中央目录声明很小、实际解开很大，流着解、超了当场停 ────────
{
  const bomb = new JSZip()
  bomb.file('[Content_Types].xml', '<Types/>')
  bomb.file('word/big.xml', Buffer.alloc(40 * 1024 * 1024, 0x20))
  const bytes = await bomb.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  // 把 word/big.xml 在本地头（偏移 22）和中央目录（偏移 24）里声明的解压大小都改成 1000。
  const lie = (sig, nameLenAt, nameAt, sizeAt) => {
    for (let i = bytes.indexOf(sig); i !== -1; i = bytes.indexOf(sig, i + 4)) {
      const len = bytes.readUInt16LE(i + nameLenAt)
      if (bytes.subarray(i + nameAt, i + nameAt + len).toString() === 'word/big.xml') bytes.writeUInt32LE(1000, i + sizeAt)
    }
  }
  lie(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 26, 30, 22)
  lie(Buffer.from([0x50, 0x4b, 0x01, 0x02]), 28, 46, 24)
  writeFileSync(at('bomb.docx'), bytes)
  const r = await call('office_unpack', { path: 'bomb.docx' })
  const left = existsSync(at('.satuwork/office')) ? readdirSync(at('.satuwork/office')).filter((n) => n.startsWith('bomb')) : []
  out.bomb = { 拦下了: r.includes('超过了上限'), 没留半截: left.length === 0, 原话: r.slice(0, 200) }
}

// ── 15. 写不进去：不留临时文件，说人话 ────────────────────────────────
{
  writeFileSync(at('locked.docx'), await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('x')] }] })))
  const dir = dirOf(await call('office_unpack', { path: 'locked.docx' }))
  // 输出位置是个非空目录：rename 一定失败（和 Windows 上文件被 Word 占着是同一条路）。
  mkdirSync(at('taken.docx'))
  writeFileSync(at('taken.docx/inside.txt'), 'x')
  const r = await call('office_pack', { dir, path: 'taken.docx' })
  out.renameFail = {
    说了写不进: r.includes('写不进'),
    没留临时文件: !readdirSync(root).some((n) => n.startsWith('.taken.docx.') && n.endsWith('.tmp')),
  }
}

// ── 16. 美化后超过 patch 上限的不拆行，并且明说 ───────────────────────
{
  const base = await JSZip.loadAsync(await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('深')] }] })))
  // 嵌套 300 层、最里面两万个空元素：原文件才一百多 KB，美化之后每个元素前面都是六百个空格。
  base.file('word/deep.xml', '<a>'.repeat(300) + '<b/>'.repeat(20000) + '</a>'.repeat(300))
  writeFileSync(at('deep.docx'), await base.generateAsync({ type: 'nodebuffer' }))
  const r = await call('office_unpack', { path: 'deep.docx' })
  const dir = dirOf(r)
  out.tooWide = {
    明说了: /太大没拆行.*word\/deep\.xml/.test(r),
    磁盘上是原样: dir ? readFileSync(at(`${dir}/word/deep.xml`), 'utf8').split('\n').length === 1 : false,
  }
}

// ── 17. 部件名里的百分号：不许把整份文件搞到解不开 ────────────────────
out.percent = (() => {
  try {
    const files = {
      '[Content_Types].xml': '<Types><Default Extension="xml" ContentType="x"/><Default Extension="rels" ContentType="r"/><Override PartName="/word/100%.xml" ContentType="y"/></Types>',
      'word/100%.xml': '<a/>',
      '_rels/.rels': '<Relationships><Relationship Id="r1" Type="t" Target="word/100%.xml"/></Relationships>',
    }
    return checkPackage(Object.keys(files), (p) => files[p])
  } catch (e) {
    return `抛了：${e.message}`
  }
})()

// ── 18. 大小写不敏感的盘上，换个大小写也认得出是原文件 ────────────────
{
  writeFileSync(at('case.docx'), await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('v1')] }] })))
  if (existsSync(at('CASE.docx'))) {
    const dir = dirOf(await call('office_unpack', { path: 'case.docx' }))
    writeFileSync(at('case.docx'), await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('别人改的')] }] })))
    utimesSync(at('case.docx'), new Date(), new Date(Date.now() + 5000))
    const r = await call('office_pack', { dir, path: 'CASE.docx' })
    out.caseFold = { 拦下了: r.includes('被改过'), 别人的改动还在: (await extractDocument(at('case.docx'), 'docx')).text.includes('别人改的') }
  } else {
    out.caseFold = null // 大小写敏感的盘（Linux）：两个名字就是两个文件，这条不适用
  }
}

// ── 19. NODE_PATH 只放行那几个库，不把 Bot 的整个 node_modules 漏出去 ──
{
  const r = await call('terminal', {
    command: `node -e "require('docx');require('pptxgenjs');require('exceljs');require('jszip');try{require('tsx');console.log('LEAK')}catch(e){console.log('NARROW')}"`,
  })
  out.narrow = { 四个库都在: !r.includes('Cannot find module') , 别的不漏: r.includes('NARROW') && !r.includes('LEAK'), 原话: r.slice(0, 200) }
}

// ── 20. 新建的要点：office_guide 给的模板原样写进工作区，terminal 跑得出来，包是干净的 ──
// 模板是要点里最占地方、也最容易跟着库升级悄悄坏掉的那部分；照模型真会做的来一遍。
{
  const { NEW_TEMPLATES } = await import('./src/tools/office-new.ts')
  out.guide = {
    认错格式: (await call('office_guide', { format: 'pdf' })).includes('只能是'),
    带点大写也认: (await call('office_guide', { format: '.DOCX' })).includes('Word（docx 库）要点'),
  }
  const expect = { docx: '第二步', xlsx: '市场活动', pptx: '季度收入' }
  for (const kind of ['docx', 'xlsx', 'pptx']) {
    const guide = await call('office_guide', { format: kind })
    const script = `.satuwork/scripts/new-${kind}.cjs`
    await call('write_file', { path: script, content: NEW_TEMPLATES[kind] })
    const run = await call('terminal', { command: `node ${script} new.${kind}` })
    const file = at(`new.${kind}`)
    const made = existsSync(file)
    let problems = ['没生成']
    if (made) {
      const zip = await JSZip.loadAsync(readFileSync(file))
      const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir)
      const texts = new Map()
      for (const n of names) if (/\.(xml|rels)$/i.test(n)) texts.set(n, await zip.file(n).async('string'))
      // pptxgenjs 自己会登记几个不存在的 slideMasterN.xml（页越多越多，见 office.ts 的 Manifest.baseline），
      // PowerPoint 照开，不算模板的错。
      problems = checkPackage(names, (n) => texts.get(n)).filter((l) => !/登记了 \/ppt\/slideMasters\/slideMaster\d+\.xml，但包里没有/.test(l))
      for (const [n, t] of texts) {
        const bad = checkXml(t)
        if (bad) problems.push(`${n}：${bad}`)
      }
    }
    out.guide[kind] = {
      模板原样在要点里: guide.includes(NEW_TEMPLATES[kind].trimEnd()),
      跑出来了: made,
      读得出内容: made ? (await extractDocument(file, kind)).text.includes(expect[kind]) : false,
      包的问题: problems,
      输出: run.slice(0, 300),
    }
  }
  if (existsSync(at('new.xlsx'))) {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(at('new.xlsx'))
    const d = wb.getWorksheet('预算').getCell('B2').value
    out.guide.xlsx.日期没差一天 = d instanceof Date && d.toISOString().startsWith('2026-10-08')
    out.guide.xlsx.打开时重算 = /fullCalcOnLoad="1"/.test(await zipText(at('new.xlsx'), 'xl/workbook.xml'))
  }
}

// ── 21. 真 LibreOffice（有才跑）：改过的三份都打得开，PPT 是三页；新建模板出的三份也打得开 ──
{
  const { officeExecutable, renderToPdf } = await import('./src/workspace/render.ts')
  if (officeExecutable()) {
    process.env.SATUWORK_RENDER_TIMEOUT_MS = '120000'
    const { getDocumentProxy } = await import('unpdf')
    const pages = async (f) => {
      try {
        return (await getDocumentProxy(new Uint8Array(readFileSync(await renderToPdf(at(f)))))).numPages
      } catch (e) {
        return String(e && e.message)
      }
    }
    out.real = { docx: await pages('report.docx'), pptx: await pages('deck.pptx'), xlsx: await pages('sales.xlsx') }
    out.realNew = { docx: await pages('new.docx'), pptx: await pages('new.pptx'), xlsx: await pages('new.xlsx') }
  } else {
    out.real = null
  }
}

console.log('__RESULT__' + JSON.stringify(out))
