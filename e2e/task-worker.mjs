import { runProbe } from './probe.mjs'

/** 管家工人跑派活时的「停止」：停在哪一刻就按哪一刻办，不砍人自己那一轮（manager/src/worker/tasks.ts）。 */
export async function runTaskWorker({ root, test, assert, log }) {
  log('\n# task-worker')
  const { seen, out } = await runProbe(root, 'manager/e2e-task-worker.mjs')
  const finishOf = (id) => seen.find((s) => s.path === `/w-local/gateway/worker/tasks/${id}/finish`)
  const aborts = seen.filter((s) => s.path.endsWith('/abort'))

  await test('三件都收得了场，没卡住', async () => {
    assert(!Object.keys(out).length, `有的卡住或抛错了：${JSON.stringify(out)}`)
  })

  await test('指令发出去之前被停：不调中止（对方跑着的是人那一轮），指令不发，报 aborted', async () => {
    const msg = seen.find((s) => s.path.endsWith('/messages') && s.body?.task?.id === 'tk-a')
    assert(!msg, '被停了还把指令发了进去')
    assert(finishOf('tk-a')?.body?.kind === 'aborted', `该报 aborted：${JSON.stringify(finishOf('tk-a'))}`)
  })

  await test('排着时被停、第一次撤队列席位没应：下一拍再撤，不退回去中止当前那一轮', async () => {
    const dels = seen.filter((s) => s.method === 'DELETE' && s.path.endsWith('/queue/q-b'))
    assert(dels.length === 2, `该撤两次（第一次 500）：${dels.length} 次`)
    assert(finishOf('tk-b')?.body?.kind === 'aborted', `该报 aborted：${JSON.stringify(finishOf('tk-b'))}`)
  })

  await test('排着时被停、队列里已经没有这一条（人撤了）：不调中止，报 aborted', async () => {
    assert(seen.some((s) => s.method === 'DELETE' && s.path.endsWith('/queue/q-c')), '没去撤')
    assert(finishOf('tk-c')?.body?.kind === 'aborted', `该报 aborted：${JSON.stringify(finishOf('tk-c'))}`)
  })

  await test('三件里一次「中止」都不该调', async () => {
    assert(!aborts.length, `不该中止任何一轮：${aborts.length} 次`)
  })
}
