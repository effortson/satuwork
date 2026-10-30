/**
 * 目标 Bot 里，主 Bot 派来的活那几轮不进后续上下文（docs/bot-tasks.md §7）。探针在
 * bot/e2e-task-turns.mjs（纯函数，要 tsx）。
 */
import { runProbe } from './probe.mjs'

export async function runTaskTurns({ root, test, assert, log }) {
  log('\n# task-turns')
  const r = await runProbe(root, 'bot/e2e-task-turns.mjs')

  await test('派来的活被停了：人下一句话的上下文里没有那件活，只有人自己聊的', () => {
    assert(r.afterStop.count === 2, `只该剩人那一问一答：${r.afterStop.count} 条 ${r.afterStop.text}`)
    assert(r.afterStop.text.includes('帮我看看这个配色') && r.afterStop.text.includes('配色偏冷'), `人自己的对话丢了：${r.afterStop.text}`)
    for (const bit of ['派来的任务', 'web_search', '第 1 轮搜完了']) {
      assert(!r.afterStop.text.includes(bit), `那件活漏进了上下文（${bit}）：${r.afterStop.text}`)
    }
  })

  await test('老席位插进人那一轮的派活：只去掉指令那一句，人那一轮原样留着', () => {
    assert(JSON.stringify(r.steeredKept) === JSON.stringify([1, 2, 3, 5, 6]), `留下的不对：${JSON.stringify(r.steeredKept)}`)
  })

  await test('派活那一轮中间落的压缩点留着：上下文边界不能跟着丢', () => {
    assert(JSON.stringify(r.compactKept) === JSON.stringify(['session/compact']), `只该剩压缩点：${JSON.stringify(r.compactKept)}`)
  })

  await test('送回主 Bot 的「任务结果」照常进上下文：那是主 Bot 自己要处理的', () => {
    assert(r.resultKept === 4, `任务结果那一轮被误当成派活去掉了：留下 ${r.resultKept} 条`)
  })

  await test('上一轮没收口（只有 turn/start）之后派来的活：紧挨着开了自己的一轮，照样不进上下文', () => {
    assert(JSON.stringify(r.danglingKept) === JSON.stringify([1, 2]), `派来的那一轮漏进来了：${JSON.stringify(r.danglingKept)}`)
  })

  await test('下一件派来的活看不见上一件，但看得见人前面聊的', () => {
    assert(r.secondTask.includes('这周主推蓝色'), `人前面聊的丢了：${r.secondTask}`)
    assert(!r.secondTask.includes('第一件'), `上一件活漏进来了：${r.secondTask}`)
  })
}
