/**
 * bot 那几个 e2e 探针共用的小件。
 *
 * **这里不 import 任何 src/ 下的东西**：不少探针要先把 SATUWORK_HOME 之类的环境变量
 * 设好，再动态 import bot 模块（模块顶层就读环境）。这个文件被静态 import，会先于探针
 * 正文求值——它要是牵进了 bot 模块，那些模块就会在环境变量设好之前被读进来。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 系统临时目录下新建一个目录，进程退出时收掉。
 *
 * 探针是顶层 await 的脚本，没有一个能包 finally 的函数体；exit 钩子在 process.exit、
 * 正常结束和未捕获异常三条路上都会跑。每个目录各挂一个钩子、各自 try：一个删不掉
 * 不耽误别的。
 */
export function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  process.on('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })
  return dir
}

/**
 * 造一个最小的、带真文字层的 PDF，一页一段文字。**现场造，不放 checked-in 的二进制**——
 * 二进制样本没人看得懂，review 时只能看见「一坨变了」。
 */
export function buildPdf(pages) {
  const objs = []
  const streams = pages.map((t) => `BT /F1 14 Tf 40 700 Td (${t}) Tj ET`)
  const n = pages.length
  const pageIds = pages.map((_, i) => 3 + i)
  const contentIds = pages.map((_, i) => 3 + n + i)
  const fontId = 3 + 2 * n
  objs[1] = `<</Type/Catalog/Pages 2 0 R>>`
  objs[2] = `<</Type/Pages/Kids[${pageIds.map((id) => `${id} 0 R`).join(' ')}]/Count ${n}>>`
  pageIds.forEach((id, i) => {
    objs[id] = `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${contentIds[i]} 0 R/Resources<</Font<</F1 ${fontId} 0 R>>>>>>`
  })
  contentIds.forEach((id, i) => {
    objs[id] = `<</Length ${streams[i].length}>>\nstream\n${streams[i]}\nendstream`
  })
  objs[fontId] = `<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>`
  let s = '%PDF-1.4\n'
  const offsets = []
  for (let i = 1; i < objs.length; i++) {
    if (!objs[i]) continue
    offsets[i] = s.length
    s += `${i} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xrefAt = s.length
  const count = objs.length
  s += `xref\n0 ${count}\n0000000000 65535 f \n`
  for (let i = 1; i < count; i++) {
    s += objs[i] ? `${String(offsets[i]).padStart(10, '0')} 00000 n \n` : `0000000000 65535 f \n`
  }
  s += `trailer\n<</Size ${count}/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`
  return Buffer.from(s, 'latin1')
}
