/**
 * 模型自己看文档：office_render（bot/src/tools/look.ts）和「工具结果带图」这一整条链。
 * 探针在 bot/e2e-look.mjs。
 *
 * 这条链上的错全是静默的：图没送进去，模型照样说「排版没问题」；图塞给了看不了图的模型，
 * 上游把整个请求拒掉，那一轮直接失败。所以请求体、同一轮、跨轮重建、看不了图、真出图各钉一遍。
 */
import { runProbe } from './probe.mjs'

export async function runOfficeLook({ root, test, assert, log }) {
  log('\n# office-look')
  let r
  await test('探针跑得完', async () => {
    r = await runProbe(root, 'bot/e2e-look.mjs', { timeout: 240_000 })
    assert(r && r.pages && r.vision && r.blind, `结果不完整：${JSON.stringify(r)}`)
  })

  await test('页码：默认前三页、范围、混写；写错了报错，超大范围不先摆出十万个数', () => {
    const p = r.pages
    assert(JSON.stringify(p.默认) === '[1,2,3]' && JSON.stringify(p.范围) === '[2,3,4]' && JSON.stringify(p.混写) === '[1,3,5]', JSON.stringify(p))
    assert(String(p.倒着写).startsWith('错') && String(p.乱写).startsWith('错'), `写错的没拦：${JSON.stringify(p)}`)
    assert(p.超大范围.长度 <= 7 && p.超大范围.毫秒 < 100, `超大范围：${JSON.stringify(p.超大范围)}`)
    // 去重之后再比上限：「1-4,2-4」只涉及四页，不能按七个数算成超了。
    assert(JSON.stringify(p.重叠) === '[1,2,3,4]', `重叠：${JSON.stringify(p.重叠)}`)
  })

  await test('OpenAI chat：tool 消息只放文本，图补在这批 tool 之后的一条用户消息里', () => {
    const o = r.openai
    // 补早了（插在两条 tool 中间）chat 协议会把整条请求拒掉。
    assert(o.角色顺序 === 'system,user,assistant,tool,tool,user,assistant', `顺序不对：${o.角色顺序}`)
    assert(o.tool消息只有文本 && o.图在补的用户消息里 && o.说明是哪次调用, JSON.stringify(o))
  })

  await test('OpenAI Responses：同样补在这批 function_call_output 之后', () => {
    assert(r.responses.顺序 === 'user,function_call,function_call,function_call_output,function_call_output,user,assistant', r.responses.顺序)
    assert(r.responses.图, '图没补上')
  })

  await test('Anthropic：图进 tool_result 里面，不另起用户消息', () => {
    for (const [k, v] of Object.entries(r.anthropic)) assert(v === true, `${k}：${JSON.stringify(r.anthropic)}`)
  })

  await test('看得了图的模型：同一轮就带图；下一轮从日志重建只带最近 6 张', () => {
    const v = r.vision
    // 同一轮 pi 用的是 bridgeTools 返回的那份，不会回头读日志——这一处漏了，模型要到下一轮才看得见。
    assert(v.同一轮每次都带图 && v.图带了字节, `同一轮没带图：${JSON.stringify(v)}`)
    assert(v.日志里记了路径 === '4,4', `日志：${v.日志里记了路径}`)
    assert(v.重建后带字节的张数 === 6 && v.太远的换成说明 && v.最近那次四张全在, `重建：${JSON.stringify(v)}`)
    assert(v.工具表里有office_render, '看得了图的模型却没拿到 office_render')
  })

  await test('看不了图的模型：一张都不塞、说清楚图在哪，工具表里也不摆 office_render', () => {
    for (const [k, v] of Object.entries(r.blind)) assert(v === true, `${k}：${JSON.stringify(r.blind)}`)
  })

  await test('换模型：说明不落进日志正文，同一句只出现一次，换成能看图的就只带图', () => {
    // 说明写进日志的话，下一轮回放时按当时的模型又补一遍：要么说两次，要么一边说「看不了」一边带图。
    for (const [k, v] of Object.entries(r.switch)) assert(v === true, `${k}：${JSON.stringify(r.switch)}`)
  })

  await test('压缩估算：看不了图只算说明，看得了图只算最近六张', () => {
    for (const [k, v] of Object.entries(r.estimate)) assert(v === true, `${k}：${JSON.stringify(r.estimate)}`)
  })

  await test('晚到的截图：结果先给模型，拍完补一条 tool/shot，落在这一轮收尾之前', () => {
    /**
     * 浏览器工具的截图要等页面画出来才拍，模型不该陪着等（ToolResult.pendingShot）。补的那条
     * 按 callId 认回那次调用；拍不成的不补；必须落在 turn/end 之前——压缩边界只切在
     * turn/end 上，晚到的一条排到后面就成了指向已被摘要掉的调用的孤儿。
     */
    for (const [k, v] of Object.entries(r.lateShot)) assert(v === true, `${k}：${JSON.stringify(r.lateShot)}`)
  })

  await test('两样都没有（pdftoppm / LibreOffice）：明说画不了', () => {
    assert(/画不出来/.test(r.real.none), `没说清楚：${r.real.none}`)
  })

  if (!r.real.hasToppm && !r.real.hasOffice) {
    log('  - 这台机器既没有 pdftoppm 也没有 LibreOffice，真出图那段跳过')
    return
  }
  const good = (x, label) => {
    assert(x.张数 === 3 && x.宽度.every((w) => w === 1024), `${label} 出图不对：${JSON.stringify(x)}`)
    assert(x.三页各不相同, `${label} 三页画成了同一张（LibreOffice 导图只认第一页那个坑）`)
    assert(x.说了共几页 && x.给人的缩略图, `${label}：${JSON.stringify(x)}`)
  }
  if (r.real.hasToppm) await test('pdftoppm：三页各画各的，宽 1024', () => good(r.real.pdftoppm, 'pdftoppm'))
  if (r.real.hasOffice) {
    await test('LibreOffice 退路：切成单页再画，三页真是三页', () => good(r.real.libreoffice, 'libreoffice'))
    await test('Word 文档：先转 PDF 再画，并说明是 LibreOffice 画的', () => {
      good(r.real.docx, 'docx')
      assert(/LibreOffice 画的/.test(r.real.docx.原话), r.real.docx.原话)
    })
  }
  await test('交出去的图另存在会话目录下：渲染缓存修剪掉，历史里的图和缩略图还在', () => {
    for (const [k, v] of Object.entries(r.real.kept)) assert(v === true, `${k}：${JSON.stringify(r.real.kept)}`)
  })

  if (r.real.hasOffice) {
    await test('pdftoppm 画不了某一页：换 LibreOffice 再试', () => {
      assert(r.real.toppmFallback.画出来了, `没退到 LibreOffice：${r.real.toppmFallback.原话}`)
    })
  }

  await test('边界：页码超了、一次太多、不是文档、部分越界都说清楚', () => {
    const e = r.real.edges
    assert(/一共 3 页/.test(e.页码超了), e.页码超了)
    assert(/最多画 6 页/.test(e.一次太多), e.一次太多)
    assert(/不是 Word/.test(e.不是文档), e.不是文档)
    assert(e.部分越界.张数 === 1 && /第 4、5 页不存在/.test(e.部分越界.原话), JSON.stringify(e.部分越界))
  })
}
