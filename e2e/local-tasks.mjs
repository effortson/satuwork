import { runProbe } from './probe.mjs'

/** 本地 Bot 自己领主 Bot 派的活（bot/src/local-tasks）。 */
export async function runLocalTasks({ root, test, assert, log }) {
  log('\n# local-tasks')
  const result = await runProbe(root, 'bot/e2e-local-tasks.mjs')
  const seen = result.seen

  await test('run 那一步：凭席位票领活，指令发进自己的会话带 task 身份，finish 带回自己那一轮的正文', async () => {
    const due = seen.filter((s) => s.path === '/runtime/local-tasks/due')
    assert(due.length >= 1 && due.every((s) => s.auth === 'Bearer sat_local_probe'), `领活的票不对：${JSON.stringify(due)}`)
    const started = seen.find((s) => s.path === '/runtime/local-tasks/tk-1/started')
    assert(started && started.body.sessionId === 's-local', `started 没带会话 id：${JSON.stringify(started)}`)
    const msg = result.own.find((x) => x.path.endsWith('/messages') && x.body.task?.phase === 'instruction')
    assert(msg && msg.auth === 'Bearer sat_local_probe', `到自己会话的票不对：${JSON.stringify(msg)}`)
    assert(msg.body.text.includes('做月报') && msg.body.task.id === 'tk-1' && msg.body.task.from.name === '助手', `指令内容不对：${JSON.stringify(msg.body)}`)
    const order = result.own.map((x) => x.path.split('/').pop())
    assert(order.indexOf('events') < order.indexOf('messages'), `要先挂流再发消息：${order.join(',')}`)
    const finish = seen.find((s) => s.path === '/runtime/local-tasks/tk-1/finish')
    assert(finish && finish.body.kind === 'completed' && finish.body.sessionId === 's-local', `finish 不对：${JSON.stringify(finish)}`)
    // 只认自己那一轮：别人的回复不进结论，自己那一轮的几段拼在一起。
    assert(finish.body.result === '我先查一下。\n\n月报做好了：合计 20 万。', `带回的正文不对：${JSON.stringify(finish.body.result)}`)
  })

  await test('deliver 那一步：结论发进主 Bot 的会话（带 result 身份），发进去就报 delivered', async () => {
    const msg = result.own.find((x) => x.path.endsWith('/messages') && x.body.task?.phase === 'result')
    assert(msg && msg.body.text.startsWith('【任务结果】@财务 做完了') && msg.body.task.from.name === '财务', `送回去的消息不对：${JSON.stringify(msg && msg.body)}`)
    const finish = seen.find((s) => s.path === '/runtime/local-tasks/tk-2/finish')
    assert(finish && finish.body.kind === 'delivered', `deliver 的 finish 不对：${JSON.stringify(finish)}`)
    // deliver 不挂流、不读历史：只发消息。
    const after = result.own.indexOf(msg)
    assert(!result.own.slice(after + 1).some((x) => x.path.endsWith('/events')), 'deliver 那一步不该再挂流')
  })
}
