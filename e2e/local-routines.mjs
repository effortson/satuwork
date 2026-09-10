import { runProbe } from './probe.mjs'

/** 本地 Bot 自己领、自己跑日常任务（bot/src/local-routines）。 */
export async function runLocalRoutines({ root, test, assert, log }) {
  log('\n# local-routines')
  const result = await runProbe(root, 'bot/e2e-local-routines.mjs')

  await test('凭席位票去 Gateway 领活，领到就 started、renew、finish 各来一次', async () => {
    const due = result.seen.filter((s) => s.path === '/runtime/local-routines/due')
    assert(due.length >= 1 && due.every((s) => s.auth === 'Bearer sat_local_probe'), `领活的票不对：${JSON.stringify(due)}`)
    const started = result.seen.find((s) => s.path.endsWith('/run-1/started'))
    assert(started && started.body.sessionId === 's-local', `started 没带会话 id：${JSON.stringify(started)}`)
    const finish = result.seen.find((s) => s.path.endsWith('/run-1/finish'))
    assert(finish && finish.body.kind === 'completed' && finish.body.sessionId === 's-local', `finish 不对：${JSON.stringify(finish)}`)
  })

  await test('消息发进自己的会话：带席位票、routine 身份和 utility 角色；先挂流再发消息', async () => {
    const msg = result.own.find((x) => x.path.endsWith('/messages'))
    assert(msg && msg.auth === 'Bearer sat_local_probe', `到自己会话的票不对：${JSON.stringify(msg)}`)
    assert(msg.body.text === '把今天的事说一遍' && msg.body.routine?.id === 'rt-1' && msg.body.modelRole === 'utility', `消息内容不对：${JSON.stringify(msg.body)}`)
    const order = result.own.map((x) => x.path.split('/').pop())
    assert(order.indexOf('events') < order.indexOf('messages'), `要先挂流再发消息：${order.join(',')}`)
  })

  await test('别人的那一轮先收口也不算，只认自己那一轮的 turn/end', async () => {
    // 假流里先来一轮别人的、以 aborted 收口；认错了 finish 就是 aborted。
    const finish = result.seen.find((s) => s.path.endsWith('/run-1/finish'))
    assert(finish && finish.body.kind === 'completed', `认了别人那一轮：${JSON.stringify(finish && finish.body)}`)
  })
}
