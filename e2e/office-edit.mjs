/**
 * 改 Office 文档：office_unpack / office_pack（bot/src/tools/office.ts）和它底下的 XML 纯函数
 * （bot/src/workspace/ooxml.ts）。探针在 bot/e2e-office.mjs。
 *
 * 这一层坏了的样子是 Office 说「文件已损坏」、或者更糟——打得开，但正文里多了换行、
 * 少了空格、图表没了。两种都不会有人报到「是哪一步」，所以每一步单独钉。
 */
import { runProbe } from './probe.mjs'

export async function runOfficeEdit({ root, test, assert, log }) {
  log('\n# office-edit')
  let r
  await test('探针跑得完', async () => {
    r = await runProbe(root, 'bot/e2e-office.mjs', { timeout: 180_000 })
    assert(r && r.docx && r.pptxAdd && r.xlsx, `结果不完整：${JSON.stringify(r)}`)
  })

  await test('美化再还原一个字不变，正文里的空白一律不碰', () => {
    for (const [k, v] of Object.entries(r.pretty)) assert(v === true, `${k}：${JSON.stringify(r.pretty)}`)
  })

  await test('XML 手滑：少闭合、裸 &、多闭合、属性里裸 & 都认得出，带行号', () => {
    assert(r.check.好的放过 && r.check.实体放过, `把好的判成坏的：${JSON.stringify(r.check)}`)
    assert(/第 5 行.*<\/a>.*第 2 行.*<b>/.test(r.check.少闭合), `少闭合：${r.check.少闭合}`)
    assert(/第 2 行.*&amp;/.test(r.check.裸和号), `裸 &：${r.check.裸和号}`)
    assert(/多出来一个 <\/b>/.test(r.check.多闭合), `多闭合：${r.check.多闭合}`)
    assert(/属性值/.test(r.check.属性里裸和号), `属性：${r.check.属性里裸和号}`)
  })

  await test('包级检查：新页漏登记、关系断了、登记了不存在的，都拦', () => {
    assert(r.pkg.好的放过, '把好的包判成坏的')
    // 光看 Default xml 会把漏了 Override 的新幻灯片放过去。
    assert(/slide2\.xml.*没有登记类型/.test(r.pkg.漏登记), `漏登记：${r.pkg.漏登记}`)
    assert(!/_rels\/\.rels/.test(r.pkg.漏登记), `.rels 被误报：${r.pkg.漏登记}`)
    assert(/slide7\.xml.*没有这个部件/.test(r.pkg.断引用), `断引用：${r.pkg.断引用}`)
    assert(/slide3\.xml.*包里没有/.test(r.pkg.登记了没有的), `登记了没有的：${r.pkg.登记了没有的}`)
  })

  await test('Word：解包 → patch 改一个数字 → 打包，别的部件字节不动', () => {
    const d = r.docx
    assert(d.说了该看哪个文件 && d.带了Word要点 && d.解开是多行的, `解包结果不对：${JSON.stringify(d)}`)
    assert(d.改上了 && d.打包成功 && d.新数字在, `没改上：${JSON.stringify(d)}`)
    assert(d.表格还在, '表格丢了')
    assert(d.别的部件没动.length === 0, `没碰过的部件变了：${d.别的部件没动.join('，')}`)
    assert(d.打回去是紧凑的 && d.内容类型打头, '打回去的包形状不对')
    assert(d.解包目录收掉了, '解包目录没收')
    // 产出要报给界面：实时预览、消息底下的文件入口都靠它。
    assert(d.报了产出.includes('report.docx'), `没报产出：${d.报了产出}`)
  })

  await test('PPT：页序按 sldIdLst 列出来；照「四处」复制一页得到三页', () => {
    assert(r.pptxOverview.列了页序 && r.pptxOverview.带了PPT要点, `解包结果不对：${JSON.stringify(r.pptxOverview)}`)
    assert(r.pptxAdd.打包成功 && r.pptxAdd.三页 && r.pptxAdd.页数 === 3, `加页失败：${JSON.stringify(r.pptxAdd)}`)
  })

  await test('PPT：新页漏登记类型要拦下，原文件不许动；原文件自带的毛病不拦', () => {
    assert(r.pptxMissingType.拦下了, '漏了 Override 还打包了')
    assert(r.pptxMissingType.原文件没动, '拦下了却还是写了文件')
    // pptxgenjs 生成的文件本来就登记了一个不存在的 slideMaster2.xml；那不是模型改的，
    // 拦着它就永远存不回去——上面「三页」那条能过，就说明没拦。
  })

  await test('Excel：工作表名对得上文件；改一格，公式不丢', () => {
    const x = r.xlsx
    assert(x.表名对上文件 && x.带了Excel要点, `解包结果不对：${JSON.stringify(x)}`)
    assert(x.改上了 && x.打包成功 && x.新值 === '华南', `没改上：${JSON.stringify(x)}`)
    assert(x.公式还在 === 'SUM(B2:B2)', `公式丢了：${x.公式还在}`)
  })

  await test('XML 写坏了：不打包，指到文件和行号，原文件不动，目录留着接着修', () => {
    for (const [k, v] of Object.entries(r.broken)) assert(v === true, `${k}：${JSON.stringify(r.broken)}`)
  })

  await test('解包之后原文件被别人改过：不许覆盖，另存可以', () => {
    for (const [k, v] of Object.entries(r.conflict)) assert(v === true, `${k}：${JSON.stringify(r.conflict)}`)
  })

  await test('keep：留着目录接着改，第二次覆盖不误报', () => {
    for (const [k, v] of Object.entries(r.keep)) assert(v === true, `${k}：${JSON.stringify(r.keep)}`)
  })

  await test('外部输入：带 ../ 的包不解，老格式指条路', () => {
    for (const [k, v] of Object.entries(r.inputs)) assert(v === true, `${k}：${JSON.stringify(r.inputs)}`)
  })

  await test('新建：terminal 里 node 跑 .cjs，require 得到 docx / pptxgenjs / exceljs', () => {
    const c = r.create
    assert(c.跑通了 && c.三个都有 && c.docx能读, `脚本没跑通：${JSON.stringify(c)}`)
  })

  await test('原文件本来就带缩进的部件（CRLF 缩进的 styles、不合格的 VML）：没碰过就原字节放回', () => {
    const b = r.byteIdentical
    assert(b.打包成功 && b.改的那处在, `打包失败：${JSON.stringify(b)}`)
    // 只靠「美化再还原」的话，这两份会被压成一行——没碰过的部件也变了。
    assert(b.没碰过的原字节.length === 0, `没碰过的部件变了：${b.没碰过的原字节.join('，')}`)
    assert(b.没有目录条目, '包里多了 word/ 这样的目录条目')
    assert(b.原字节目录收掉了, '.orig 目录没收')
  })

  await test('扩展名要一样：.xlsm 不许存成 .xlsx', () => {
    assert(r.ext.拒了, '宏工作簿被存成了 .xlsx，Excel 打不开')
    assert(r.ext.同扩展名可以, '同扩展名另存被拦了')
  })

  await test('炸弹：声明很小、实际很大的条目，流着解、超了当场停，不留半截', () => {
    // 先看声明的大小是挡不住的——那个数是文件自己写的。
    assert(r.bomb.拦下了, `没拦下：${r.bomb.原话}`)
    assert(r.bomb.没留半截, '解到一半的目录没收')
  })

  await test('写不进去（文件被占着）：说清楚，不留临时文件', () => {
    for (const [k, v] of Object.entries(r.renameFail)) assert(v === true, `${k}：${JSON.stringify(r.renameFail)}`)
  })

  await test('美化之后超过 patch 上限的不拆行，并且明说', () => {
    for (const [k, v] of Object.entries(r.tooWide)) assert(v === true, `${k}：${JSON.stringify(r.tooWide)}`)
  })

  await test('部件名里的裸百分号不让整份文件解不开', () => {
    assert(Array.isArray(r.percent) && r.percent.length === 0, `出错了：${JSON.stringify(r.percent)}`)
  })

  await test('换个大小写指向原文件，也认得出、也拦「解包后被改过」', () => {
    if (r.caseFold === null) return log('  - 盘是大小写敏感的，这条不适用')
    for (const [k, v] of Object.entries(r.caseFold)) assert(v === true, `${k}：${JSON.stringify(r.caseFold)}`)
  })

  await test('NODE_PATH 只放行那四个库，Bot 自己的别的依赖漏不出去', () => {
    assert(r.narrow.四个库都在, `库 require 不到：${r.narrow.原话}`)
    assert(r.narrow.别的不漏, `tsx 也 require 得到：${r.narrow.原话}`)
  })

  await test('新建的要点：office_guide 认格式，给的模板原样跑得出来、包是干净的', () => {
    const g = r.guide
    assert(g.认错格式 && g.带点大写也认, `格式参数：${JSON.stringify(g)}`)
    for (const kind of ['docx', 'xlsx', 'pptx']) {
      const k = g[kind]
      assert(k.模板原样在要点里, `${kind}：要点里的模板和 office-new.ts 的对不上`)
      assert(k.跑出来了 && k.读得出内容, `${kind} 模板没跑通：${k.输出}`)
      assert(k.包的问题.length === 0, `${kind} 生成的包有问题：${k.包的问题.join('；')}`)
    }
    // 要点里写了的两个坑，模板自己得先躲开。
    assert(g.xlsx.日期没差一天, 'xlsx 模板的日期差了一天：要用 Date.UTC')
    assert(g.xlsx.打开时重算, 'xlsx 模板没设 fullCalcOnLoad')
  })

  if (!r.real) {
    log('  - 这台机器没有 LibreOffice，改完真打开看那段跳过')
    return
  }
  await test('真 LibreOffice：改过的三份都打得开，PPT 是三页', () => {
    assert(r.real.docx >= 1 && r.real.xlsx >= 1, `打不开：${JSON.stringify(r.real)}`)
    assert(r.real.pptx === 3, `PPT 页数不对：${JSON.stringify(r.real)}`)
  })
  await test('真 LibreOffice：新建模板出的三份都打得开，PPT 是四页', () => {
    const n = r.realNew
    assert(n.docx >= 1 && n.xlsx >= 1, `打不开：${JSON.stringify(n)}`)
    assert(n.pptx === 4, `PPT 页数不对：${JSON.stringify(n)}`)
  })
}
