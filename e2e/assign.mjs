import { runProbe } from './probe.mjs'

/** 主 Bot 派活的那把工具（bot/src/tools/assign.ts，docs/bot-tasks.md §6.1）。 */
export async function runAssign({ root, test, assert, log }) {
  log('\n# assign')
  const r = await runProbe(root, 'bot/e2e-assign.mjs')

  await test('工具在表里，描述里列着可派的名单', async () => {
    assert(r.schema.在表里, '工具没注册上')
    assert(r.schema.描述里有名单, '描述里没有名单')
  })

  await test('按名字派：带自己的 botId、会话和 callId 去 Gateway 记一条；回话让模型先告诉用户、别等', async () => {
    const p = r.ok.posted
    assert(p && p.auth === 'Bearer sat_assign_probe', `票不对：${JSON.stringify(p)}`)
    assert(p.body.fromBotId === 'bot-main' && p.body.toBot === 'fin' && p.body.instruction === '做一份本月费用月报', `记的内容不对：${JSON.stringify(p.body)}`)
    assert(p.body.sessionId === 's-main' && p.body.callId === 'c-1', `没带会话 / callId：${JSON.stringify(p.body)}`)
    assert(r.ok.text.includes('已派给 @财务') && r.ok.text.includes('不要在这儿等'), `回话不对：${r.ok.text}`)
  })

  await test('名单上没有的、空指令、Gateway 说派不了的，原话回给模型；不是主 Bot 就派不了', async () => {
    assert(r.nobody.includes('名单上没有「法务」') && r.nobody.includes('「财务」'), `没有的 Bot：${r.nobody}`)
    assert(r.empty.includes('指令不能为空'), `空指令：${r.empty}`)
    assert(r.busy.startsWith('派不了：') && r.busy.includes('还没做完'), `409 的话：${r.busy}`)
    assert(r.notMain.includes('不是主 Bot'), `名单空着：${r.notMain}`)
    assert(r.calls === 2, `只有两次该真打到 Gateway，打了 ${r.calls} 次`)
  })
}
