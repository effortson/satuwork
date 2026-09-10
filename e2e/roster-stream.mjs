/**
 * 名单通道的过滤规则（gateway/src/lib/roster-stream.ts 的 rosterFrame）。
 *
 * 这条通道存在的全部理由就是**别把 token 洪流发给侧栏**：一轮回答几百上千条
 * `assistant/chunk`，而名单拿它只是把一个 HH:MM 的钟往前推。规则错一条，两种坏法
 * 都不会报错——该转的没转，侧栏就停在上一个状态（人以为 Bot 还在跑）；不该转的转了，
 * 洪流原样回来（而那正是这条通道要省掉的东西）。所以一条条钉住。
 */
import { readFileSync } from 'node:fs'
import { catchUpFrames, newCatchUp, remember, rosterFrame } from '../gateway/src/lib/roster-filter.ts'

const up = () => ({ botId: 'bot-a', sessionId: 's-a', after: 0, lastTick: 0, attempt: 0 })

export async function runRosterStream({ test, assert, log }) {
  log('\n# roster-stream')

  await test('管家那份 roster-filter 是 gateway 这份的逐字副本', async () => {
    // 规则在两边都要跑（名单流下沉到席位机器，见 manager/src/roster.ts），而管家 import 不到
    // gateway 的源，只能抄。抄的东西会漂，这里按字节钉住：改了 gateway 那份就整个覆盖过去。
    const gw = readFileSync(new URL('../gateway/src/lib/roster-filter.ts', import.meta.url), 'utf8')
    const mgr = readFileSync(new URL('../manager/src/roster-filter.ts', import.meta.url), 'utf8')
    assert(mgr.endsWith(gw), 'manager/src/roster-filter.ts 和 gateway 那份不一样了——把 gateway 那份整个覆盖过去（保留文件头那段说明）')
  })

  await test('名单要的那几种事件原样转出去', async () => {
    for (const type of ['turn/start', 'turn/end', 'human/handoff', 'tool/approval', 'user/message', 'assistant/message']) {
      const f = rosterFrame({ type, seq: 1, time: 1 }, up())
      assert(f && f.type === 'roster/ev', `${type} 没转出去——侧栏那一行会停在上一个状态`)
      assert(f.botId === 'bot-a' && f.ev.type === type, `${type} 转歪了：${JSON.stringify(f)}`)
    }
  })

  await test('只有正文才要的那些一律不转', async () => {
    const u = up()
    // chunk 单独测节流（下一条）；这里钉住别的几种。
    for (const type of ['tool/call', 'tool/result', 'agent/task', 'todo/list', 'session/compact', 'skill/saved']) {
      assert(rosterFrame({ type, seq: 1, time: 1 }, u) === null, `${type} 被转给侧栏了——白占带宽和主线程`)
    }
  })

  await test('chunk 折成节流过的时间戳：一轮上千条，最多每 20 秒一条', async () => {
    const u = up()
    const t0 = 1_000_000
    let sent = 0
    // 一轮答两分钟、每 50ms 一个 token：2400 条。
    for (let i = 0; i < 2400; i++) if (rosterFrame({ type: 'assistant/chunk', seq: i + 1, time: t0 + i * 50 }, u)) sent++
    // 120 秒 / 20 秒 ≈ 6 条。留一点边界余量，但绝不能是几百条。
    assert(sent >= 5 && sent <= 7, `2400 条 chunk 折出了 ${sent} 条，节流没生效`)
    const f = rosterFrame({ type: 'assistant/chunk', seq: 9999, time: t0 + 10_000_000, chunk: { text: '正文' } }, u)
    assert(f && f.ev.type === 'assistant/chunk' && f.ev.time === t0 + 10_000_000, '折出来的帧形状不对')
    assert(f.ev.chunk === undefined, '折出来的帧带上了正文——那正是要省掉的东西')
  })

  await test('游标按过滤前的 seq 走', async () => {
    const u = up()
    // 全是被滤掉的类型，游标照样要推——否则每次重连都要把最多的那一批再拉一遍。
    for (let i = 1; i <= 100; i++) rosterFrame({ type: 'tool/result', seq: i, time: 1 }, u)
    assert(u.after === 100, `游标停在 ${u.after}，重连会把已经见过的那些再灌一遍`)
  })

  await test('replay/done 只取 live，那一句是权威', async () => {
    const u = up()
    const f = rosterFrame({ type: 'replay/done', live: true, queued: [], firstSeq: 1 }, u)
    assert(f && f.type === 'roster/live' && f.live === true, `replay/done 没转成 live：${JSON.stringify(f)}`)
    // 老席位不带 live：不转，让客户端保持原样，别把状态改错。
    assert(rosterFrame({ type: 'replay/done' }, u) === null, '没有 live 的 replay/done 不该转')
  })

  await test('认不出来的事件一律不转，不是一律转', async () => {
    const u = up()
    assert(rosterFrame({ type: 'future/thing', seq: 1 }, u) === null, '默认放行的话，将来加一种高频事件就是又一次洪流')
    assert(rosterFrame({ seq: 1 }, u) === null, '没有 type 的帧不该转')
  })

  /* ── 追平集 ────────────────────────────────────────────────────────
     一套上游按账号共享之后，「中途接上」不再是边角情况——**每一次刷新都是**。通道只
     在事情发生时发帧，所以新接上的页面必须先收到一份「现在是什么样」。这几条钉住那
     份追平集：留什么、留多少、按什么顺序发。
     ────────────────────────────────────────────────────────────── */

  const ev = (type, data, seq = 1, time = 1) => rosterFrame({ type, seq, time, ...data }, up())
  const msg = (text, type = 'assistant/message') =>
    rosterFrame({ type, seq: 1, time: 1, data: { message: { content: [{ type: 'text', text }] } } }, up())

  await test('追平集：消息留最近几条，旧的挤掉', async () => {
    const cu = newCatchUp()
    for (let i = 0; i < 20; i++) remember(cu, msg('第' + i + '句'))
    const out = [...catchUpFrames(new Map([['bot-a', cu]]))]
    assert(out.length === 4, `留了 ${out.length} 条，上限该是 4——长期挂着的 hub 会一直长胖`)
    assert(JSON.stringify(out[3]).includes('第19句'), '留的不是最新那几条')
  })

  await test('追平集：交接和确认按 id 留最后一条，不解释状态', async () => {
    const cu = newCatchUp()
    remember(cu, ev('human/handoff', { data: { id: 'h1', state: 'open' } }))
    remember(cu, ev('tool/approval', { data: { callId: 'c1', state: 'pending' } }))
    // 同一张单后来收口了：**留最后那一条，而不是把它删掉**。客户端收到「已关闭」做的
    // 是 delete(id)，在一个本来就没有它的集合上删是空操作，结果一样对——这一层因此
    // 不必知道哪些状态算「还开着」，那种知识抄成两份迟早分叉。
    remember(cu, ev('human/handoff', { data: { id: 'h1', state: 'done' } }))
    const out = [...catchUpFrames(new Map([['bot-a', cu]]))]
    const hs = out.filter((f) => f.ev?.type === 'human/handoff')
    assert(hs.length === 1, `同一张单留了 ${hs.length} 条`)
    assert(hs[0].ev.data.state === 'done', '留的不是最后那一条')
    assert(out.some((f) => f.ev?.type === 'tool/approval'), '确认没留下——那颗「在等你」追不平')
  })

  await test('追平集：live 排在 turn 后面，否则那颗点会算错', async () => {
    const cu = newCatchUp()
    // 席位崩在半路：日志里有 turn/start 没 turn/end，扫事件会算成「在跑」。
    remember(cu, ev('turn/start', { data: { turn: 1 } }))
    remember(cu, rosterFrame({ type: 'replay/done', live: false }, up()))
    const out = [...catchUpFrames(new Map([['bot-a', cu]]))]
    const iTurn = out.findIndex((f) => f.ev?.type === 'turn/start')
    const iLive = out.findIndex((f) => f.type === 'roster/live')
    assert(iTurn >= 0 && iLive > iTurn, `live 没排在 turn 后面（turn=${iTurn}, live=${iLive}）：席位的权威表态会被 turn 盖掉`)
  })

  await test('追平集：tick 留最后一条，排在消息之后', async () => {
    // 一轮正跑着的时候，tick 是唯一在推「最近活动」那个钟的东西——那会儿还没有新的
    // 消息帧。不留的话，刷新出来的页面时间会退回提问那一刻，和没刷新的标签页对不上。
    const cu = newCatchUp()
    remember(cu, msg('答完了'))
    const tick = rosterFrame({ type: 'assistant/chunk', seq: 9, time: 5_000_000 }, up())
    assert(tick, '前置没成立：这一帧本该折出来')
    remember(cu, tick)
    const out = [...catchUpFrames(new Map([['bot-a', cu]]))]
    const iMsg = out.findIndex((f) => f.ev?.type === 'assistant/message')
    const iTick = out.findIndex((f) => f.ev?.type === 'assistant/chunk')
    assert(iTick >= 0, 'tick 没留下——一轮跑着时刷新，侧栏的钟会倒退')
    assert(iTick > iMsg, `tick 该排在消息之后（msg=${iMsg}, tick=${iTick}）：它比最后那条消息新`)
  })

  await test('追平集：消息帧把过期的 tick 顶掉，时间不许往回跳', async () => {
    // noteBotEvent 那一支是**无条件赋值** lastAt，所以一条比消息还旧的 tick 排在后面
    // 会把时间拽回去。这一步收口了，上一条 tick 就该作废。
    const cu = newCatchUp()
    // 时间要过得了节流那一关（lastTick 从 0 起算，见 TICK_MS），否则 rosterFrame 返回
    // null，这条测就变成在测「null 不会被留下」——那什么都没测到。
    const stale = rosterFrame({ type: 'assistant/chunk', seq: 1, time: 30_000 }, up())
    assert(stale, '前置没成立：这一帧本该折出来')
    remember(cu, stale)
    remember(cu, msg('后来又说了一句'))
    const out = [...catchUpFrames(new Map([['bot-a', cu]]))]
    assert(!out.some((f) => f.ev?.type === 'assistant/chunk'), '旧 tick 没被顶掉——它会把「最近活动」拽回到更早的时刻')
  })
}
