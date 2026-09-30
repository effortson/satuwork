/**
 * Word / Excel / PPT 渲染成 PDF，给界面预览（bot/src/workspace/render.ts）。探针在
 * bot/e2e-render.mjs。
 *
 * 大部分跑在假 soffice 上：要钉的是这一层自己的规矩——一次只跑一个、同一份合成一次、
 * 缓存、超时收干净、转坏了说清楚。真 LibreOffice 有才跑（席位上有，开发机多半没有），
 * 那一段看的是中文出不出得来。
 */
import { runProbe } from './probe.mjs'

export async function runDocRender({ root, test, assert, log }) {
  log('\n# doc-render')
  let r
  await test('探针跑得完', async () => {
    // 真 soffice 冷启动要建用户配置，给宽一点。
    r = await runProbe(root, 'bot/e2e-render.mjs', { timeout: 180_000 })
    assert(r && r.basic && r.concurrent, `结果不完整：${JSON.stringify(r)}`)
  })

  await test('认 Office 各家格式，不认 PDF 和纯文本', () => {
    assert(r.kinds.docx && r.kinds.upper && r.kinds.ppt && r.kinds.odt, `该认的没认：${JSON.stringify(r.kinds)}`)
    assert(!r.kinds.pdf && !r.kinds.txt, 'PDF / 纯文本不该绕一趟 LibreOffice')
  })

  await test('没装 LibreOffice：回 unavailable，界面据此退回文本', () => {
    assert(r.missing.reason === 'unavailable', `没说清楚：${JSON.stringify(r.missing)}`)
  })

  await test('转一次、第二次走缓存、文件改了重转', () => {
    assert(r.basic.isPdf && r.basic.rightSource, '转出来的不是那份文件的 PDF')
    assert(r.basic.ranOnce, '一次预览跑了不止一次 soffice')
    // 实时预览会在 Bot 每次写文件后重开，不缓存就是每次都起一遍 soffice。
    assert(r.basic.cached, '同一份没改过的文件又转了一遍')
    assert(r.basic.rerendered, '文件改了还在给旧的 PDF')
  })

  await test('一次只跑一个 soffice，同一份文件同时来只转一次', () => {
    assert(r.concurrent.allOk, '并发请求里有失败的')
    // 两个 soffice 用同一份用户配置，后起的那个会什么都不产出就退出。
    assert(r.concurrent.noOverlap, '两个 soffice 同时在跑')
    assert(r.concurrent.sameFileOnce, '同一份文件被并发转了两遍')
  })

  await test('转坏了说清楚，而且不堵住后面的', () => {
    // 真 soffice 对读不了的文件常常退出码 0、什么都不写。
    assert(r.empty.reason === 'failed' && /没有转出/.test(r.empty.message), `空产出没认出来：${JSON.stringify(r.empty)}`)
    assert(r.failed.reason === 'failed' && /退出码 3/.test(r.failed.message) && /boom/.test(r.failed.message), `非零退出没带原因：${JSON.stringify(r.failed)}`)
    assert(r.afterFailure, '一次失败之后队伍断了')
  })

  await test('卡死的 soffice 按时杀掉，整组一起，留下的锁下一次清', () => {
    assert(r.hang.reason === 'failed' && /超时/.test(r.hang.message), `没报超时：${JSON.stringify(r.hang)}`)
    assert(r.hangMs < 5000, `超时没按设定来：${r.hangMs} ms`)
    // soffice 是包装脚本，干活的是它的子进程；只杀包装脚本那个会留下来一直吃内存。
    assert(r.hangChildKilled, '卡死那次的子进程还活着')
    assert(r.afterHang, '超时之后下一次转不了了')
    assert(r.staleLockCleared, '上一次留下的 .lock 没清，下一次 soffice 会直接退出')
  })

  await test('太大的文件不交给 soffice', () => {
    assert(r.big.reason === 'too-big' && /MB/.test(r.big.message), `拒绝得不清不楚：${JSON.stringify(r.big)}`)
    assert(r.bigNotRun, '超限的文件还是被转了')
  })

  await test('缓存有上限，临时目录不留', () => {
    assert(r.cache.pdfs <= 24, `缓存没修剪：${r.cache.pdfs} 份`)
    assert(r.cache.jobDirs === 0, `临时目录没收：${r.cache.jobDirs} 个`)
  })

  if (!r.real) {
    log('  - 这台机器没有 LibreOffice，真渲染那段跳过')
    return
  }
  await test('真 LibreOffice：Word 和 Excel 里的中文都出得来', () => {
    assert(!r.real.reason, `真渲染失败：${JSON.stringify(r.real)}`)
    // 席位上没装 fonts-noto-cjk 时，中文在 PDF 里是方块（文字层里也就对不上）。
    assert(r.real.chinese && r.real.latin, `Word 转出来缺字：${JSON.stringify(r.real)}`)
    assert(r.realXlsx && r.realXlsx.header && r.realXlsx.number, `Excel 转出来缺东西：${JSON.stringify(r.realXlsx)}`)
  })
}
