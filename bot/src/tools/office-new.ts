/**
 * 新建 Word / Excel / PPT 的要点和最小模板：`office_guide` 返回的就是这里的东西（注册在 office.ts）。
 *
 * 改已有文档的要点跟着 office_unpack 的结果走（office.ts 的 GUIDE）；新建没有「解包」这一步
 * 可以挂，所以单开一把工具，要写脚本之前调一次。常驻提示词里只多一句工具描述。
 *
 * 模板不是示意：e2e 探针（bot/e2e-office.mjs）把每一份原样写进工作区、用 terminal 跑出来，
 * 再解一遍查包——库一升级、API 一变，这里跟着红。模板里别用反引号和 `${}`，这里是 TS 模板串。
 *
 * 写进要点的坑都是真跑出来的：日期差一天、字体被整个换掉、表格没宽度挤成一团、文字框
 * 不会自己缩字。没踩过的别往里加，每多一行模型每次都要读。
 */

export type NewKind = 'docx' | 'xlsx' | 'pptx'

/** 三种格式都一样的那部分。 */
const COMMON = [
  '通用：',
  '- 脚本写成 .cjs 放在 .satuwork/scripts/ 下（不进文件树，不算交付物），terminal 里 `node .satuwork/scripts/xxx.cjs` 跑。',
  '  必须是 .cjs + require：这几个库靠 NODE_PATH 找到，ESM 的 import 不认 NODE_PATH，.mjs 会报找不到模块。',
  '- 内容（标题、段落、表格数据）放在脚本最上面的常量里；用户要改字、改数，改常量重跑，比解包改生成出来的文件省事。' +
    '但文件已经交出去、用户可能自己动过的，别重跑覆盖，走 office_unpack。',
  '- 中文字体统一给 Microsoft YaHei。颜色写 6 位十六进制、不带 #（exceljs 例外，见下）。',
  '- 跑完先用 read_file 读一遍产物，确认内容都在；有 office_render 就再画一两页看排版（溢出、挤压、中文方块），有问题改脚本重跑。',
].join('\n')

const DOCX_POINTS = [
  'Word（docx 库）要点：',
  '- 单位：字号是半磅（size: 24 = 12pt 小四，21 = 五号）；页边距、缩进、表格宽度是 twip（1 厘米 ≈ 567）。默认 A4、四边 2.54 厘米，版心宽 9026。',
  '- 一个 Paragraph 就是一段，文字里的 \\n 不会换行：分段就多建几个 Paragraph，段内换行用 new TextRun({ text, break: 1 })。',
  '- 标题用 heading: HeadingLevel.HEADING_1 / HEADING_2，别只靠加粗放大：导航窗格和目录只认标题样式。',
  '- 无序列表 bullet: { level: 0 } 直接能用；有序列表要先在 Document 的 numbering.config 里定义，段落上用 numbering: { reference, level }（见模板）。',
  '- 表格一定给宽度：Table 上 width + columnWidths，每个 TableCell 上 width，单位都是 twip、合起来等于版心宽。不给的话 Word 里列宽乱跳，别的软件里挤成一团。',
  '- 单元格底色 shading 一定带 type: ShadingType.CLEAR；用 SOLID 格子是黑的。',
  '- 分页：new Paragraph({ pageBreakBefore: true, ... })。图片：new ImageRun({ type: "png", data: fs.readFileSync(路径), transformation: { width, height } })，type 必填、宽高是像素，照原图比例算。',
  '- 输出：Packer.toBuffer(doc).then((b) => fs.writeFileSync(路径, b))。',
].join('\n')

const DOCX_TEMPLATE = String.raw`const fs = require('fs')
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, LevelFormat,
  Table, TableRow, TableCell, WidthType, ShadingType, Footer, PageNumber,
} = require('docx')

const OUT = process.argv[2] || '计划.docx'
const COLS = [3000, 3013, 3013] // twip，合计 9026 = A4 版心宽
const ROWS = [['项目', '预算', '负责人'], ['官网改版', '12 万', '张三'], ['客服系统', '8 万', '李四']]

const cell = (text, col, head) => new TableCell({
  width: { size: COLS[col], type: WidthType.DXA },
  shading: head ? { fill: 'D9E2F3', type: ShadingType.CLEAR, color: 'auto' } : undefined,
  children: [new Paragraph({ children: [new TextRun({ text, bold: head })] })],
})

const doc = new Document({
  styles: { default: { document: { run: { font: { ascii: 'Arial', hAnsi: 'Arial', eastAsia: 'Microsoft YaHei' }, size: 22 } } } },
  numbering: { config: [{ reference: 'steps', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START }] }] },
  sections: [{
    footers: {
      default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: ['第 ', PageNumber.CURRENT, ' 页'] })] })] }),
    },
    children: [
      new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun('2026 年第四季度计划')] }),
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('一、目标')] }),
      new Paragraph({ children: [new TextRun('正文一段，'), new TextRun({ text: '这几个字加粗', bold: true }), new TextRun('。')] }),
      new Paragraph({ bullet: { level: 0 }, children: [new TextRun('无序要点')] }),
      new Paragraph({ numbering: { reference: 'steps', level: 0 }, children: [new TextRun('第一步')] }),
      new Paragraph({ numbering: { reference: 'steps', level: 0 }, children: [new TextRun('第二步')] }),
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('二、预算')] }),
      new Table({
        width: { size: 9026, type: WidthType.DXA },
        columnWidths: COLS,
        rows: ROWS.map((r, i) => new TableRow({ tableHeader: i === 0, children: r.map((t, j) => cell(t, j, i === 0)) })),
      }),
    ],
  }],
})

Packer.toBuffer(doc).then((b) => fs.writeFileSync(OUT, b))
`

const XLSX_POINTS = [
  'Excel（exceljs）要点：',
  '- 数存成数字、日期存成 Date，再用 numFmt 管显示（"#,##0.00"、"0.0%"、"yyyy-mm-dd"）。别把 "1,234" "12%" 存成字符串，那样求不了和、排不了序。',
  '- 日期用 new Date(Date.UTC(年, 月-1, 日))：exceljs 按 UTC 写，new Date(年, 月-1, 日) 在东八区会早一天。',
  '- 公式写 { formula: "SUM(C2:C4)" }：不带 =，英文函数名，逗号分隔。exceljs 不算结果，所以一定设 wb.calcProperties.fullCalcOnLoad = true，打开时重算。',
  '- font / fill / border 是整个换掉，不是合并：只写 { bold: true } 会把字体名、字号也丢了。先定一个 FONT 常量，用 { ...FONT, bold: true }。',
  '- 颜色是 8 位 argb，前面多两位 FF：{ argb: "FF1F3864" }。',
  '- 列宽按字符数算，一个汉字算 2。表头冻结 ws.views = [{ state: "frozen", ySplit: 1 }]，加筛选 ws.autoFilter = "A1:D1"，合并 ws.mergeCells("A1:D1")。',
  '- 工作表名不超过 31 个字，不能有 : \\ / ? * [ ]。',
  '- exceljs 做不了图表和透视表。用户要图表就说清楚：数据表照样给，图表可以另做进 PPT（pptxgenjs 的 addChart）。',
  '- 输出：await wb.xlsx.writeFile(路径)，写在 async 函数里。',
].join('\n')

const XLSX_TEMPLATE = String.raw`const ExcelJS = require('exceljs')

const OUT = process.argv[2] || '预算.xlsx'
const FONT = { name: 'Microsoft YaHei', size: 11 }
const DATA = [
  ['官网改版', new Date(Date.UTC(2026, 9, 8)), 120000],
  ['客服系统', new Date(Date.UTC(2026, 10, 1)), 80000],
  ['市场活动', new Date(Date.UTC(2026, 11, 15)), 50000],
]

async function main() {
  const wb = new ExcelJS.Workbook()
  wb.calcProperties.fullCalcOnLoad = true
  const ws = wb.addWorksheet('预算')
  ws.columns = [
    { header: '项目', key: 'name', width: 20 },
    { header: '日期', key: 'date', width: 14, style: { font: FONT, numFmt: 'yyyy-mm-dd' } },
    { header: '金额（元）', key: 'amount', width: 16, style: { font: FONT, numFmt: '#,##0.00' } },
    { header: '占比', key: 'share', width: 10, style: { font: FONT, numFmt: '0.0%' } },
  ]
  const first = 2
  const last = first + DATA.length - 1
  const total = last + 1
  DATA.forEach(([name, date, amount], i) => {
    const r = first + i
    ws.addRow({ name, date, amount, share: { formula: 'C' + r + '/C$' + total } })
  })
  ws.addRow({ name: '合计', amount: { formula: 'SUM(C' + first + ':C' + last + ')' } }).font = { ...FONT, bold: true }

  const header = ws.getRow(1)
  header.font = { ...FONT, bold: true, color: { argb: 'FFFFFFFF' } }
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } }
  ws.views = [{ state: 'frozen', ySplit: 1 }]
  ws.autoFilter = 'A1:D1'

  await wb.xlsx.writeFile(OUT)
}

main()
`

const PPTX_POINTS = [
  'PPT（pptxgenjs）要点：',
  '- pres.layout = "LAYOUT_WIDE" 是 13.33 × 7.5 英寸（16:9）。位置和大小全是英寸，字号是磅。',
  '- 文字框不会自己缩字，也不会自己长高（fit: "shrink" 要在 PowerPoint 里动一下才生效），放不下就是溢出，得自己算：',
  '  一个汉字宽约 字号/72 英寸，一行放得下 w × 72 / 字号 个字；一行高约 字号 × 1.2 / 72 英寸。',
  '  参考：标题 28–36pt，正文 18–24pt；一页 3–6 条要点，一条不超过两行；表格一页不超过 8 行，多了拆页。',
  '- 多条要点放进同一个 addText：传数组，每条 { text, options: { bullet: true, breakLine: true } }。不带 breakLine 会连成一段。',
  '- 表格 addTable(rows, { x, y, w, colW: [...] })，colW 合起来等于 w；格子可以是字符串，也可以是 { text, options } 单独设样式。',
  '- 图表 addChart(pres.charts.BAR / LINE / PIE, [{ name, labels, values }], { x, y, w, h })，柱状图竖着要 barDir: "col"。',
  '- 图片 addImage({ path, x, y, w, h })，按原图比例算 w、h，不然会被拉变形。备注 slide.addNotes("...")。',
  '- x、y 可以是负的（出血到页面外），w、h 不能：往右上、左下画的线和箭头，w、h 照样写正数，再加 flipV: true（或 flipH: true）。' +
    '写成负数 LibreOffice 照样画得出来，PowerPoint 却会报「已修复」并把这个形状删掉。',
  '- 阴影之类的选项对象会被库原地改掉，别在几次调用之间复用同一个对象：写成函数，每次返回一个新的。',
  '- 输出：pres.writeFile({ fileName: 路径 })。',
].join('\n')

const PPTX_TEMPLATE = String.raw`const pptxgen = require('pptxgenjs')

const OUT = process.argv[2] || '计划.pptx'
const FONT = 'Microsoft YaHei'
const pres = new pptxgen()
pres.layout = 'LAYOUT_WIDE'

const title = (slide, text) =>
  slide.addText(text, { x: 0.6, y: 0.4, w: 12.1, h: 0.9, fontFace: FONT, fontSize: 32, bold: true, color: '1F3864' })

// 封面
let s = pres.addSlide()
s.background = { color: '1F3864' }
s.addText('2026 年第四季度计划', { x: 0.8, y: 2.6, w: 11.7, h: 1.2, fontFace: FONT, fontSize: 44, bold: true, color: 'FFFFFF' })
s.addText('市场部 · 10 月', { x: 0.8, y: 3.9, w: 11.7, h: 0.6, fontFace: FONT, fontSize: 20, color: 'D9E2F3' })

// 要点
s = pres.addSlide()
title(s, '三个目标')
s.addText(
  ['新客户 +30%', '续约率到 90%', '客服响应 2 小时内'].map((t) => ({ text: t, options: { bullet: true, breakLine: true } })),
  { x: 0.8, y: 1.6, w: 11.7, h: 4.5, fontFace: FONT, fontSize: 24, color: '333333', paraSpaceAfter: 12, valign: 'top' },
)
s.addNotes('先讲第一条的来由。')

// 表格
s = pres.addSlide()
title(s, '预算')
const head = () => ({ bold: true, color: 'FFFFFF', fill: { color: '1F3864' } })
s.addTable(
  [
    [{ text: '项目', options: head() }, { text: '预算', options: head() }, { text: '负责人', options: head() }],
    ['官网改版', '12 万', '张三'],
    ['客服系统', '8 万', '李四'],
  ],
  { x: 0.8, y: 1.6, w: 11.7, colW: [5.7, 3, 3], fontFace: FONT, fontSize: 18, border: { type: 'solid', pt: 0.5, color: 'BFBFBF' } },
)

// 图表
s = pres.addSlide()
title(s, '季度收入（万元）')
s.addChart(pres.charts.BAR, [{ name: '收入', labels: ['Q1', 'Q2', 'Q3', 'Q4'], values: [120, 150, 170, 210] }], {
  x: 0.8, y: 1.6, w: 11.7, h: 5.2, barDir: 'col', chartColors: ['2E75B6'], showValue: true,
  catAxisLabelFontFace: FONT, valAxisLabelFontFace: FONT,
})

pres.writeFile({ fileName: OUT })
`

/** 模板本身，e2e 探针原样拿去跑。 */
export const NEW_TEMPLATES: Record<NewKind, string> = { docx: DOCX_TEMPLATE, xlsx: XLSX_TEMPLATE, pptx: PPTX_TEMPLATE }

const POINTS: Record<NewKind, string> = { docx: DOCX_POINTS, xlsx: XLSX_POINTS, pptx: PPTX_POINTS }

/** `office_guide` 的全部输出。 */
export function newGuide(kind: NewKind): string {
  return [
    POINTS[kind],
    '',
    COMMON,
    '',
    '能直接跑的最小模板（照着改，别从零写）：',
    '```js',
    NEW_TEMPLATES[kind].trimEnd(),
    '```',
  ].join('\n')
}
