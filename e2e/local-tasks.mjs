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
    // 只认自己那一轮，而且只取最后一条：「我先查一下」这种过程话不是结论（docs/bot-tasks.md §2）。
    assert(finish.body.result === '月报做好了：合计 20 万。', `带回的正文不对：${JSON.stringify(finish.body.result)}`)
  })

  await test('deliver 那一步：结论发进主 Bot 的会话（带 result 身份），发进去就报 delivered', async () => {
    const msg = result.own.find((x) => x.path.endsWith('/messages') && x.body.task?.phase === 'result')
    assert(msg && msg.body.text.startsWith('【任务结果】@财务 做完了') && msg.body.task.from.name === '财务', `送回去的消息不对：${JSON.stringify(msg && msg.body)}`)
    const finish = seen.find((s) => s.path === '/runtime/local-tasks/tk-2/finish')
    assert(finish && finish.body.kind === 'delivered', `deliver 的 finish 不对：${JSON.stringify(finish)}`)
    // deliver 不挂流、不读历史：只发消息。
    // 只看送回那条消息到下一件任务开头（它自己问会话 id）之间：后面那件 run 当然要挂流。
    const after = result.own.indexOf(msg)
    const nextJob = result.own.findIndex((x, i) => i > after && x.path.endsWith('/session'))
    const between = result.own.slice(after + 1, nextJob < 0 ? undefined : nextJob)
    assert(!between.some((x) => x.path.endsWith('/events')), 'deliver 那一步不该再挂流')
  })

  await test('主 Bot 那边停了：续租一说停，就立刻调中止停掉目标那一轮，报 aborted', async () => {
    const renews = seen.filter((s) => s.path === '/runtime/local-tasks/tk-3/renew')
    assert(renews.length >= 2, `第三件该勤快地续租（cancelPollMs 200ms）：${renews.length} 次`)
    const abort = result.own.find((x) => x.path.endsWith('/abort'))
    assert(abort && abort.auth === 'Bearer sat_local_probe', `没调中止，或者票不对：${JSON.stringify(abort)}`)
    const fin = seen.find((s) => s.path === '/runtime/local-tasks/tk-3/finish')
    assert(fin && fin.body.kind === 'aborted', `停了该报 aborted：${JSON.stringify(fin && fin.body)}`)
  })

  await test('跑着的时候：自己那一轮做到哪了随续租报上去（主 Bot 那张卡画「正在：…」）', async () => {
    const p = seen.filter((s) => s.path === '/runtime/local-tasks/tk-3/renew').map((s) => s.body?.progress).find(Boolean)
    assert(p, '续租里一次进度都没报')
    assert(p.steps === 1 && p.tool?.name === 'web_search' && p.tool?.detail === 'eth etf', `工具那一格不对：${JSON.stringify(p)}`)
    assert(p.todo?.done === 0 && p.todo?.total === 2 && p.todo?.now === '查数据', `清单那一格不对：${JSON.stringify(p.todo)}`)
  })
}
