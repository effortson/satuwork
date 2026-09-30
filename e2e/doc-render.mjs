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

  await test('进程退了、后代还攥着 stderr：照常交差，不等一个永远不来的 close', () => {
    // 只等 close 的话这一次永不结束，而后面所有转换都排在它后面——整个席位的预览一起卡死。
    assert(r.linger === true, `没交差：${JSON.stringify(r.linger)}`)
    assert(r.lingerMs < 5000, `等太久了：${r.lingerMs} ms`)
  })

  await test('超时且有后代逃出进程组：杀不到它也按时报超时，队伍不堵', () => {
    assert(r.escaped !== 'stuck', '超时之后这一次一直没结束')
    assert(r.escaped.reason === 'failed' && /超时/.test(r.escaped.message), `没报超时：${JSON.stringify(r.escaped)}`)
    assert(r.escapedMs < 6000, `报得太晚：${r.escapedMs} ms`)
    assert(r.afterEscaped, '之后的转换被堵住了')
  })

  await test('排队期间文件被改：转的是新内容，键也记在新内容上', () => {
    assert(r.moved.newContent, '转出来的不是最新那份')
    // 键按请求进来时的 stat 记，新内容就存在旧键底下，新内容再来一次还得重转。
    assert(r.moved.cachedUnderNewKey, '新内容没按新键缓存')
  })

  await test('私有配置目录里写好了「挡外链、禁宏、表格总是重算」，老配置目录会补齐', () => {
    assert(r.hardening.blockLinks && r.hardening.noMacros && r.hardening.recalc, `配置项没写全：${JSON.stringify(r.hardening)}`)
    // 只看一个标记的话，这一版之前建的配置目录永远补不上后加的项。
    assert(r.hardeningUpgraded, '老配置目录没补上重算项')
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

  await test('真 LibreOffice：公式格里存着旧结果时，渲染出来的是重算后的值', () => {
    // 默认它信文件里存的结果；模型改了被引用的数、没动公式格，渲染出来就是旧合计，拿图核对时会被骗过去。
    assert(r.realRecalc && r.realRecalc.重算了 && r.realRecalc.没用旧值, `没重算：${JSON.stringify(r.realRecalc)}`)
  })

  await test('真 LibreOffice：文档里的外链图片不会被取，加固项活过了它的重写', () => {
    // 工作区里的文档可能是从网上下来的，转换时去取外链就是从席位发出的请求。
    assert(r.realLinks && r.realLinks.rendered, `带外链的文档没转出来：${JSON.stringify(r.realLinks)}`)
    assert(r.realLinks.hits === 0, `转换时取了外链：${r.realLinks.hits} 次`)
    assert(r.realLinks.hardeningKept, `LibreOffice 退出时把配置项冲掉了：${(r.realLinks.lost || []).join('、')}`)
  })
}
