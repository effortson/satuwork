/**
 * 改 Office 文档：office_unpack / office_pack，以及它底下那几个 XML 纯函数（workspace/ooxml.ts）。
 * 探针要 tsx 才 import 得了 .ts。
 *
 * 样本全是现场用 docx / pptxgenjs / exceljs 造的，和 e2e-extract 一个理由：二进制样本没人看得懂。
 * 编辑动作照模型真会做的来——read 看到的是解包目录里那份美化过的 XML，patch 按原文片段替换，
 * 加一页按解包结果里给的「四处」一步步做。这一层坏了的表现是 Office 说「文件已损坏」，而
 * 那时候已经没人知道是哪一步，所以每一步都钉。
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
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

// ── 12. 真 LibreOffice（有才跑）：改过的三份都打得开，PPT 是三页 ──────────
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
  } else {
    out.real = null
  }
}

console.log('__RESULT__' + JSON.stringify(out))
