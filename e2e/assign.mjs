import { runProbe } from './probe.mjs'

/** 主 Bot 派活的那把工具（bot/src/tools/assign.ts，docs/bot-tasks.md §1、§2）。 */
export async function runAssign({ root, test, assert, log }) {
  log('\n# assign')
  const r = await runProbe(root, 'bot/e2e-assign.mjs')

  await test('工具在表里，描述里列着可派的名单', async () => {
    assert(r.schema.在表里, '工具没注册上')
    assert(r.schema.描述里有名单, '描述里没有名单')
  })

  await test('同步 + 串并混合：并行的一起派，after 的等前置并附上前置结论，同一颗 Bot 自动排队', async () => {
    const d = r.dag
    assert(d.带席位票和wait, '派活要带席位票、自己的 botId、会话和 wait')
    assert(d.并行的一起派, `没依赖的该一起派：${d.order.join(' / ')}`)
    assert(d.串行的等前置, `after 的该等前置做完：${d.order.join(' / ')}`)
    assert(d.前置结论附在指令末尾, '前置交回的结论没附给后一件')
    assert(d.同一颗Bot自动排队, `同一颗 Bot 的两件撞在一起了：${d.order.join(' / ')}`)
    assert(d.总耗时合理, '等得太久')
  })

  await test('前置没做成，依赖它的跳过；工具返回每一件的结论', async () => {
    assert(r.dag.前置没做成就跳过, '前置失败了，依赖它的还派了出去')
    assert(r.dag.结论都回给模型, `回给模型的那段不对：\n${r.dag.text}`)
  })

  await test('对方那边被人停了：这一件标成已停止（不是失败），同一批整批跟着停，做完的留着，告诉模型别重派', async () => {
    const s = r.stopThere
    assert(s, '探针没跑到这一段')
    for (const [k, v] of Object.entries(s)) if (k !== 'text') assert(v === true, `${k} 不成立：\n${s.text}`)
  })

  await test('每一件的状态都写进会话：先全部画成「等」，再一件件更新到收场，带结论', async () => {
    assert(r.dag.事件先画全部再更新, 'bot/assign 事件的顺序不对')
    assert(r.dag.事件带结论, 'bot/assign 收场那条没带结论')
    // 界面那行「正在：…」和「看过程」靠这两样（docs/bot-tasks.md §4）。
    assert(r.dag.进度写进了事件, '跑着时 Gateway 给了进度，bot/assign 里却没有')
    assert(r.dag.收场也带着对方会话, '收场那条丢了对方的会话 id 或进度——界面就取不到过程')
  })

  await test('名单上没有的、环、重复 id 整次不发生；单条简写照旧认；不是主 Bot 派不了', async () => {
    assert(r.bad.没有这颗.includes('名单上没有「行政」'), `没有的 Bot：${r.bad.没有这颗}`)
    assert(r.bad.有环.includes('绕成了一个圈'), `环：${r.bad.有环}`)
    assert(r.bad.重复id.includes('重复'), `重复 id：${r.bad.重复id}`)
    assert(r.bad.一件没发, '校验失败了还派出去了')
    assert(r.single.includes('【fin】做完了：单条'), `单条简写：${r.single}`)
    assert(r.notMain.includes('不是主 Bot'), `名单空着：${r.notMain}`)
  })
}
