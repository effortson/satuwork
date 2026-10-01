/**
 * historySlice 的语义。纯函数，不起服务——探针要 tsx 才 import 得了 .ts。
 */
import { historySlice, visibleEvents } from './src/session/replay.ts'

let seq = 0
const ev = (type, data) => ({ seq: ++seq, time: 1, type, data })
const msg = (text) => ({ content: text ? [{ type: 'text', text }] : [] })

/** 造 n 轮完整对话，每轮：提问 → turn/start → 5 个 chunk → 最终消息 → turn/end。 */
function conversation(n) {
  seq = 0
  const out = [ev('session', { version: 2, id: 's', createdAt: 1, botId: 'b' })]
  for (let turn = 1; turn <= n; turn++) {
    out.push(ev('user/message', { message: msg('问题' + turn), source: { kind: 'user' } }))
    out.push(ev('turn/start', { turn }))
    for (let i = 0; i < 5; i++) out.push(ev('assistant/chunk', { turn, step: 0, chunk: { type: 'text-delta', text: 'x' } }))
    out.push(ev('assistant/message', { turn, step: 0, message: msg('回答' + turn) }))
    out.push(ev('turn/end', { turn, reason: 'completed' }))
  }
  return out
}

const out = {}

// 1. 作废的 chunk 要丢掉
{
  const all = conversation(3)
  const r = historySlice(all, { turns: 0 })
  out.dropChunks = {
    原始: all.length,
    剩下: r.events.length,
    还有chunk: r.events.some((e) => e.type === 'assistant/chunk'),
    正文条数: r.events.filter((e) => e.type === 'assistant/message').length,
  }
}

// 2. 正在跑的那一步，chunk 要留着（还没有最终正文盖它）
{
  const all = conversation(1)
  all.push(ev('user/message', { message: msg('问题2'), source: { kind: 'user' } }))
  all.push(ev('turn/start', { turn: 2 }))
  all.push(ev('assistant/chunk', { turn: 2, step: 0, chunk: { type: 'text-delta', text: '正在' } }))
  const r = historySlice(all, { turns: 0 })
  out.keepLive = { 留下的chunk: r.events.filter((e) => e.type === 'assistant/chunk').length }
}

// 3. 最终消息是空的，盖不住，chunk 得留
{
  const all = conversation(0)
  all.push(ev('turn/start', { turn: 1 }))
  all.push(ev('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'text-delta', text: 'a' } }))
  all.push(ev('assistant/message', { turn: 1, step: 0, message: msg('') }))
  const r = historySlice(all, { turns: 0 })
  out.emptyFinal = { 留下的chunk: r.events.filter((e) => e.type === 'assistant/chunk').length }
}

// 4. 只取最近 N 轮，且提问要跟着回答走
{
  const all = conversation(10)
  const r = historySlice(all, { turns: 3 })
  out.tail = {
    轮数: r.events.filter((e) => e.type === 'turn/start').length,
    第一条: r.events[0]?.type,
    还有更早的: r.hasMore,
    firstSeq: r.firstSeq,
  }
}

// 5. 往前翻一页：接着上一页的 firstSeq 往前
{
  const all = conversation(10)
  const page1 = historySlice(all, { turns: 3 })
  const page2 = historySlice(all, { turns: 3, before: page1.firstSeq })
  const seqs1 = page1.events.map((e) => e.seq)
  const seqs2 = page2.events.map((e) => e.seq)
  out.paging = {
    第二页轮数: page2.events.filter((e) => e.type === 'turn/start').length,
    不重叠: Math.max(...seqs2) < Math.min(...seqs1),
    还有更早的: page2.hasMore,
  }
}

// 6. 翻到头：hasMore 该是 false
{
  const all = conversation(2)
  const r = historySlice(all, { turns: 5 })
  out.exhausted = { hasMore: r.hasMore, 轮数: r.events.filter((e) => e.type === 'turn/start').length }
}

// ── SSE：重放期间断开，监听器照样摘掉 ─────────────────────────────────
/**
 * close 的监听器以前挂在重放**之后**：重放慢、客户端在那期间断开的话，close 早就发过了，
 * off()/offQueue() 从此没人调——每次重连在进程里留一个死监听器。流也没有 cancel。
 * 拿一个假 ctx 起真的 sse()，数监听器。
 */
{
  const { EventEmitter } = await import('node:events')
  const { sse } = await import('./src/web/index.ts')
  const fakeCtx = (gate) => {
    const listeners = new Set()
    return {
      listeners,
      ctx: {
        logger: { info() {}, warn() {} },
        on(_name, fn) {
          listeners.add(fn)
          return () => listeners.delete(fn)
        },
        sessions: {
          async events() {
            await gate
            return conversation(2)
          },
        },
        agents: { isRunning: () => false, queued: () => [] },
      },
    }
  }
  const tick = (ms) => new Promise((r) => setTimeout(r, ms))

  // 1. 重放中途断开（socket 先断、close 先发）。
  let release
  const a = fakeCtx(new Promise((r) => (release = r)))
  const resA = new EventEmitter()
  const bodyA = sse(a.ctx, 's', 0, { _res: resA }, 5).body
  await tick(20)
  const duringA = a.listeners.size
  resA.destroyed = true
  resA.emit('close')
  release()
  await tick(20)

  // 2. 读的那头 cancel（fetch 被 abort）。
  let releaseB
  const b = fakeCtx(new Promise((r) => (releaseB = r)))
  const resB = new EventEmitter()
  const bodyB = sse(b.ctx, 's', 0, { _res: resB }, 5).body
  await tick(20)
  await bodyB.cancel()
  const afterCancel = b.listeners.size
  releaseB()
  await tick(20)

  // 3. 正常放完、之后才断开：照旧摘掉。
  const c = fakeCtx(Promise.resolve())
  const resC = new EventEmitter()
  const bodyC = sse(c.ctx, 's', 0, { _res: resC }, 5).body
  const reader = bodyC.getReader()
  let text = ''
  while (!text.includes('replay/done')) {
    const { value, done } = await reader.read()
    if (done) break
    text += new TextDecoder().decode(value)
  }
  const liveC = c.listeners.size
  resC.emit('close')
  await tick(10)

  out.sseClose = {
    重放时挂着两个监听: duringA === 2,
    重放中途断开也摘掉了: a.listeners.size === 0,
    cancel也摘掉了: afterCancel === 0 && b.listeners.size === 0,
    正常放完时还挂着: liveC === 2,
    放完之后断开也摘掉了: c.listeners.size === 0,
  }
}

// /clear：清除点之前的不再给界面，也翻不回去（docs/chat-commands.md §15）。
{
  const all = conversation(2)
  const cut = all.at(-1).seq // 切在最后一条 turn/end 上，和 resetContext 一样
  all.push(ev('session/reset', { throughSeq: cut, from: 1, to: 1, droppedMessages: 4, by: 'user', clear: true }))
  // conversation() 会把 seq 计数归零，接在后面的那一轮要自己续号。
  let next = all.at(-1).seq
  for (const e of conversation(1).slice(1)) all.push({ ...e, seq: ++next })
  const page = historySlice(all, { turns: 20 })
  const older = historySlice(all, { turns: 20, before: cut + 1 })
  // 只打 /new 不藏：同一个位置的普通重置点，之前的照样给。
  const plain = all.map((e) => (e.type === 'session/reset' ? { ...e, data: { ...e.data, clear: undefined } } : e))
  out.clear = {
    清除点之前一条不给: page.events.every((e) => e.seq > cut),
    清除点那条留着画线: page.events[0]?.type === 'session/reset',
    清除之后的轮次都在: page.events.filter((e) => e.type === 'turn/end').length === 1,
    不给加载更多: page.hasMore === false,
    往前翻也翻不出来: older.events.length === 0 && older.hasMore === false,
    翻历史工具同一口径: visibleEvents(all).every((e) => e.seq > cut),
    普通重置不藏: visibleEvents(plain).length === plain.length,
  }
}

console.log('__RESULT__' + JSON.stringify(out))
