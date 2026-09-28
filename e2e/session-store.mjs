/**
 * 会话日志的并发读写。探针直接调 SessionService，不走 HTTP——
 * 「同一条会话还没进缓存时被并发碰到」这件事在 HTTP 层复现不稳。
 *
 * 探针要 tsx 才能 import .ts，所以另起一个进程跑。
 */
import { runProbe as sharedProbe } from './probe.mjs'

const runProbe = (root) => sharedProbe(root, 'bot/e2e-session-store.mjs')

export async function runSessionStore({ root, test, assert, log }) {
  log('\n# session-store')
  const r = await runProbe(root)

  await test('并发追加同一条未缓存会话：seq 不重复、事件不丢', async () => {
    const a = r.concurrentAppend
    // seq 撞了就意味着两份 SessionState 各记各的：SSE 的 after=seq 增量拉取会整段漏掉。
    assert(a.uniqueSeqs === a.expectedSeqs, `seq 去重后 ${a.uniqueSeqs}，应为 ${a.expectedSeqs}`)
    assert(a.fileLines === a.expectedEvents, `落盘行数 ${a.fileLines}，应为 ${a.expectedEvents}`)
    assert(a.reloadedEvents === a.expectedEvents, `重读事件数 ${a.reloadedEvents}，应为 ${a.expectedEvents}`)
    assert(a.distinctTexts === a.expectedSeqs, `正文条数 ${a.distinctTexts}，应为 ${a.expectedSeqs}`)
  })

  await test('旧格式迁移与并发追加同时发生：不丢事件、不留半个文件', async () => {
    const b = r.migrateUnderLoad
    assert(b.uniqueSeqs === b.expectedSeqs, `seq 去重后 ${b.uniqueSeqs}，应为 ${b.expectedSeqs}`)
    // 跟着当前格式版本走，别写死数字：每升一版都要来改一次测试，改着改着就有人
    // 直接把断言删了。
    assert(b.rootVersion === b.currentVersion, `迁移后 version ${b.rootVersion}，当前格式是 ${b.currentVersion}`)
    assert(b.rootBotId === 'default', `迁移后 botId ${b.rootBotId}`)
    assert(b.keptLegacyBody, '迁移把旧正文弄丢了')
    assert(b.fileLines === b.expectedEvents, `落盘行数 ${b.fileLines}，应为 ${b.expectedEvents}`)
    assert(b.reloadedEvents === b.expectedEvents, `重读事件数 ${b.reloadedEvents}，应为 ${b.expectedEvents}`)
    // 重写走 .tmp + rename，正常结束不该留下临时文件。
    assert(b.strays.length === 0, `留下非 .jsonl 文件 ${b.strays.join(',')}`)
  })

  await test('上个进程死在一轮中间：重新载入时把 turn 收口', async () => {
    const d = r.danglingTurn
    // 不补的话界面永远停在「正在处理」，而那边什么都没在跑——等多久都不会变。
    assert(d.healedType === 'turn/end', `末条应是 turn/end，实际 ${d.healedType}`)
    assert(d.healedTurn === 7, `轮次号应沿用 7，实际 ${d.healedTurn}`)
    assert(d.healedReason === 'error', `收口原因应为 error，实际 ${d.healedReason}`)
    assert(d.healedSeq === 4, `seq 应接着发到 4，实际 ${d.healedSeq}`)
    assert(d.persisted === 4, `补的那条要落盘，文件应有 4 行，实际 ${d.persisted}`)
  })

  await test('收口只做一次，正常结束的会话不动', async () => {
    const d = r.danglingTurn
    assert(d.stableOnReload === 1, `重载后 turn/end 应仍只有 1 条，实际 ${d.stableOnReload}`)
    assert(d.untouchedDone === 3, `已收口的会话不该被加东西，实际 ${d.untouchedDone} 条`)
  })

  await test('缓存被挤满时正跑着的子会话一轮：不补假的 turn/end', async () => {
    const d = r.liveTurnUnderChurn
    // 多出来的那条 reason:error 会让审计、界面、交接、审批各自当成这轮已经结束。
    assert(d.turnEnds === 1, `turn/end 应只有真的那 1 条，实际 ${d.turnEnds}`)
    assert(d.endReason === 'completed', `turn/end 应为 completed，实际 ${d.endReason}`)
    assert(d.listedTotal === d.expectedTotal, `列表应有 ${d.expectedTotal} 条，实际 ${d.listedTotal}`)
    assert(d.cacheAfterList === 0, `list() 不该往缓存里放东西，实际放了 ${d.cacheAfterList} 条`)
  })

  await test('挤缓存的同时并发追加：seq 唯一且严格递增', async () => {
    const e = r.appendUnderChurn
    assert(e.uniqueSeqs === e.expectedSeqs, `seq 去重后 ${e.uniqueSeqs}，应为 ${e.expectedSeqs}`)
    assert(e.increasing, '返回的 seq 没按调用顺序递增')
    assert(e.fileUnique && e.fileIncreasing, '落盘的 seq 有重复或乱序')
    assert(e.fileLines === e.expectedLines, `落盘行数 ${e.fileLines}，应为 ${e.expectedLines}`)
  })
}
