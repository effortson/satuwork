/**
 * 转人工的交接单：**状态机真的走完了一圈**（见 docs/handoff.md）。
 *
 * 为什么值得单开一个探针：这一层坏了同样**不报错**。工具照样返回一句「已经交给人了」，
 * 会话日志里也有那条 `tool/policy`——而如果单子没开出来、或者接手之后交还没把话喂回
 * 模型，界面上看到的仍然是一模一样的一句话。断言盯的是三件事：单子的状态真的变了、
 * 抢单只有一个人能成、**交还真的产生了一次新的输入**。
 *
 * 探针要 tsx 才 import 得了 .ts。
 */
import { Context } from '@deepseek-ai/cordis'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from './e2e-lib.mjs'

const home = tempDir('satuwork-handoff-')
process.env.SATUWORK_HOME = home

const { StorageService } = await import('./src/storage/index.ts')
const handoffMod = await import('./src/policy/handoff.ts')
const { returnMessage, expiredMessage } = handoffMod

/** 会话日志的替身：只要 append，交接用到的就这一个。 */
const appended = []
const sessions = {
  async events() {
    return [{ seq: 1, time: Date.now(), type: 'session', data: { botId: 'b1' } }]
  },
  async append(sessionId, type, data) {
    appended.push({ sessionId, type, data })
    return { seq: appended.length, time: Date.now(), type, data }
  },
}

const ctx = new Context()
ctx.provide('logger', { warn() {}, info() {}, error() {} })
ctx.provide('sessions', sessions)
ctx.plugin(StorageService, { path: join(home, 'probe.db') })
await new Promise((r) => setTimeout(r, 50))

/** 上报的那一路（session/gateway.ts 监听的就是它）。这里只数有没有发出来。 */
const changes = []
ctx.on('handoff/change', (h) => changes.push({ id: h.id, state: h.state }))

ctx.plugin(handoffMod)
await new Promise((r) => setTimeout(r, 50))

const out = {}
const base = { sessionId: 's1', botId: 'b1', callId: 'c1', reason: '要付款，超出我的权限', ask: '去财务系统里把这笔付了' }

// ── 1. 开单 ───────────────────────────────────────────────────────────
const first = await ctx.handoffs.open(base)
out.opened = {
  开出来了: first.handoff.state === 'open',
  不是重复: first.deduped === false,
  默认挡路: first.handoff.blocking === true,
  落了事件: appended.some((e) => e.type === 'human/handoff' && e.data.state === 'open'),
  上报了: changes.some((c) => c.state === 'open'),
  会话上查得到: ctx.handoffs.of('s1').length === 1,
  挡着日常任务: Boolean(ctx.handoffs.blockingOf('s1')),
}

// ── 2. 去重：同一件事换个措辞再撞一次，不该开第二张 ─────────────────
const again = await ctx.handoffs.open({ ...base, callId: 'c2' })
out.dedupe = {
  并进了同一张: again.deduped === true && again.handoff.id === first.handoff.id,
  记了次数: again.handoff.repeats === 1,
  没开出第二张: ctx.handoffs.of('s1').length === 1,
  // 换一件真正不同的事就要另开一张。
  另一件事另开一张: (await ctx.handoffs.open({ ...base, callId: 'c3', reason: '别的事', ask: '别的活' })).deduped === false,
}
// 把刚才那张多出来的收掉，后面几段只看第一张。
for (const h of ctx.handoffs.of('s1')) if (h.id !== first.handoff.id) await ctx.handoffs.cancel(h.id)

// ── 3. 抢单：两个人同时点，只有一个人能接到 ───────────────────────────
const id = first.handoff.id
const a = await ctx.handoffs.claim(id, { accountId: 'u1', name: '张三' })
const b = await ctx.handoffs.claim(id, { accountId: 'u2', name: '李四' })
out.claim = {
  第一个人接到了: a.result === 'ok' && a.handoff.claimedBy.name === '张三',
  第二个人被挡: b.result === 'taken',
  // **这一条是重点**：后点的那个必须知道是谁接走了，否则两个人各做一遍同一件事。
  说得出被谁接走: b.handoff?.claimedBy?.name === '张三',
  状态变了: ctx.handoffs.get(id).state === 'claimed',
}

// ── 4. 交还 ───────────────────────────────────────────────────────────
const done = await ctx.handoffs.finish(id, 'done', '付好了，流水号 88231', { accountId: 'u1', name: '张三' })
out.finish = {
  收下了: done.result === 'ok',
  // **交还不是终态**：Bot 还没消化。提前收口的话，界面上单子已经没了而它还在跑。
  进了已交还: done.handoff.state === 'returned',
  留了结论: done.handoff.result.text.includes('88231'),
  重复交还被挡: (await ctx.handoffs.finish(id, 'done', '再来一次')).result === 'gone',
  不再挡日常任务: !ctx.handoffs.blockingOf('s1'),
}

// 喂给模型的那段话。**结构要在**：谁、做了什么、接下来做什么。
const msg = returnMessage(done.handoff, 'done', '付好了，流水号 88231', { accountId: 'u1', name: '张三' })
out.message = {
  带上了谁做的: msg.includes('张三'),
  带上了原委: msg.includes('要付款'),
  带上了结论: msg.includes('88231'),
  说了接着做: msg.includes('接着往下做'),
  换做法那一档不一样: returnMessage(done.handoff, 'instructions', 'x').includes('不要再用原来那个'),
}

// ── 5. 一轮收口，单子才算完 ───────────────────────────────────────────
//
// **要盯住是「哪一轮」**：人点交还的同一刻，这颗 Bot 完全可能正被别人问着话。那时
// 交还是另起一轮送进去的，而上一轮的 turn/end 紧接着就到——它根本没看到交还的内容，
// 照着它收口的话，卡片当场消失、而 Bot 这时才刚开始读。
ctx.handoffs.waitFor(id, false) // deliver 走的是「另起一轮」那一岔
ctx.emit('session/event', 's1', { type: 'turn/end', data: { turn: 1, reason: 'completed' } })
await new Promise((r) => setTimeout(r, 60))
const stillOpen = ctx.handoffs.get(id)
ctx.emit('session/event', 's1', { type: 'turn/start', data: { turn: 2 } })
ctx.emit('session/event', 's1', { type: 'turn/end', data: { turn: 2, reason: 'completed' } })
await new Promise((r) => setTimeout(r, 60))
out.closed = {
  上一轮的收口不算: Boolean(stillOpen) && stillOpen.state === 'returned',
  轮末收口: ctx.handoffs.get(id) === undefined || ctx.handoffs.get(id).state === 'closed',
  会话上不再挂着: ctx.handoffs.of('s1').length === 0,
  落了终态事件: appended.some((e) => e.type === 'human/handoff' && e.data.state === 'closed'),
}

// 插话那一岔相反：交还进了正在跑的那一轮，它收口就该收单。
{
  const inflight = await ctx.handoffs.open({ ...base, sessionId: 's1b', callId: 'c1b' })
  await ctx.handoffs.finish(inflight.handoff.id, 'done', '顺手办了')
  ctx.handoffs.waitFor(inflight.handoff.id, true)
  ctx.emit('session/event', 's1b', { type: 'turn/end', data: { turn: 9, reason: 'completed' } })
  await new Promise((r) => setTimeout(r, 60))
  out.closed.插话那一岔当轮收口 = ctx.handoffs.of('s1b').length === 0
}

// ── 6. 超时没人接：必须有终态，而且**要把话带回给模型** ─────────────
const stale = await ctx.handoffs.open({ ...base, sessionId: 's2', callId: 'c9' })
const gone = await ctx.handoffs.expire(stale.handoff.id)
out.expire = {
  收成了没人接: gone.result === 'ok' && gone.handoff.state === 'expired',
  不再挂着: ctx.handoffs.of('s2').length === 0,
  给模型的话说清了别再等: expiredMessage(gone.handoff, 24).includes('没有人接手'),
  给模型的话给了出路: expiredMessage(gone.handoff, 24).includes('换一条'),
}

// **接过手但一直没交还的也得能收**，而且那句话要跟「没人接」分开：人可能已经做了
// 一半，说成没人管的话，模型会把同事正在做的事再做一遍。
{
  const held = await ctx.handoffs.open({ ...base, sessionId: 's2b', callId: 'c9b' })
  await ctx.handoffs.claim(held.handoff.id, { accountId: 'u7', name: '王五' })
  const shut = await ctx.handoffs.expire(held.handoff.id)
  const msg = shut.handoff ? expiredMessage(shut.handoff, 24) : ''
  out.expire.接过手的也收得掉 = shut.result === 'ok' && shut.handoff.state === 'expired'
  out.expire.接过手的措辞不一样 = msg.includes('王五') && !msg.includes('没有人接手')
  out.expire.提醒别重做一遍 = msg.includes('不要把可能已经做过的事再做一遍')
}

// ── 7. 活过重启：单子在磁盘上，不在内存里 ─────────────────────────────
//
// 这一条是它和高风险确认最大的差别（那一个是纯内存的，丢了的方向是多问一次）。
const kept = await ctx.handoffs.open({ ...base, sessionId: 's3', callId: 'c10' })
const ctx2 = new Context()
ctx2.provide('logger', { warn() {}, info() {}, error() {} })
ctx2.provide('sessions', sessions)
ctx2.plugin(StorageService, { path: join(home, 'probe.db') })
await new Promise((r) => setTimeout(r, 50))
ctx2.plugin(handoffMod)
await new Promise((r) => setTimeout(r, 50))
out.restart = {
  重启后还在: ctx2.handoffs.of('s3').some((h) => h.id === kept.handoff.id),
  重启后还能接: (await ctx2.handoffs.claim(kept.handoff.id, { accountId: 'u3', name: '王五' })).result === 'ok',
}

console.log('__RESULT__' + JSON.stringify(out))
rmSync(home, { recursive: true, force: true })
process.exit(0)
