/**
 * 对话里的引用（docs/chat-references.md）。探针，结果打在 `__RESULT__` 那一行上（见 e2e/references.mjs）。
 *
 * 验的几条线：
 *
 *   1. 落盘是结构（`ref` 块），进模型是话（`[引用你 … 的回复] 全文 [引用结束]` / `[引用文件：…]`）；
 *   2. 被压缩掉的旧回复照样拿得到全文——这是引用最值钱的场景；
 *   3. 太长的截断、不在的文件写明、越界的路径拒掉、对不上的 seq 拒掉；
 *   4. 排队、插话两条岔路都带着引用。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import * as storagePlugin from './src/storage/index.ts'
import * as sessionsPlugin from './src/session/index.ts'
import * as workspacePlugin from './src/workspace/index.ts'
import * as toolsPlugin from './src/tools/index.ts'
import * as llmPlugin from './src/llm/index.ts'
import * as agentPlugin from './src/agent/index.ts'
import { AssistantMessageEventStream, emptyAssistant } from './src/llm/stream.ts'
import { refList } from './src/web/index.ts'
import { SESSION_FORMAT_VERSION } from './src/session/types.ts'

const home = mkdtempSync(join(tmpdir(), 'satu-refs-'))
const work = mkdtempSync(join(tmpdir(), 'satu-refs-work-'))
process.on('exit', () => { try { rmSync(home, { recursive: true, force: true }) } catch {} try { rmSync(work, { recursive: true, force: true }) } catch {} })

/** 假目录：agent 插件 inject 了 catalog，这里只要它不抛。 */
class FakeCatalog extends Service {
  constructor(ctx) {
    super(ctx, 'catalog')
    this.pulledAt = Date.now()
  }
  async pull() { return true }
  get servers() { return [] }
  toolNamesFor() { return [] }
}

const ctx = new Context()
ctx.plugin(storagePlugin, { path: join(home, 'db.sqlite') })
ctx.plugin(sessionsPlugin, { root: join(home, 'sessions') })
ctx.plugin(workspacePlugin, { root: work })
ctx.plugin(toolsPlugin)
ctx.plugin(FakeCatalog)
ctx.plugin(llmPlugin)
ctx.plugin(agentPlugin)
await new Promise((r) => setTimeout(r, 300))

/** 捕获真正送进模型的那一份，并控制这一轮什么时候结束。 */
let captured = null
let hold = null
ctx.llm.streamFn = (model, context) => {
  captured = context
  const stream = new AssistantMessageEventStream()
  const finish = () => {
    stream.push({ type: 'error', reason: 'error', error: emptyAssistant(model, '探针不跑模型') })
    stream.end()
  }
  if (hold) hold.then(finish)
  else queueMicrotask(finish)
  return stream
}

const out = {}
const sid = await ctx.sessions.create({ title: '探针', botId: 'default' })
const USAGE = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, reasoningTokens: 0 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const lastUserBlocks = () => {
  const users = (captured?.messages ?? []).filter((m) => m.role === 'user')
  const last = users[users.length - 1]
  if (!last) return []
  return typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : (last.content ?? [])
}
const lastUserText = () => lastUserBlocks().filter((c) => c.type === 'text').map((c) => c.text).join('\n')
const lastLoggedUser = async () => {
  const events = await ctx.sessions.events(sid)
  const users = events.filter((e) => e.type === 'user/message')
  return users[users.length - 1]
}
/** 手工摆一轮完整的问答进日志，回那条助手消息的 seq。 */
const turnOf = async (turn, question, answer) => {
  await ctx.sessions.append(sid, 'user/message', { message: { id: `u${turn}`, role: 'user', content: [{ type: 'text', text: question }] }, source: { kind: 'user' } })
  await ctx.sessions.append(sid, 'turn/start', { turn })
  const a = await ctx.sessions.append(sid, 'assistant/message', {
    turn,
    step: 1,
    message: { id: `a${turn}`, role: 'assistant', content: [{ type: 'reasoning', text: '想了想' }, { type: 'text', text: answer }] },
    usage: USAGE,
  })
  const end = await ctx.sessions.append(sid, 'turn/end', { turn, reason: 'completed' })
  return { seq: a.seq, endSeq: end.seq, time: a.time }
}

const ANSWER = '方案二：先把订单表拆成两张，再按月汇总。\n\n这条路线的好处是改动小。'
const a1 = await turnOf(1, '有哪几个方案', ANSWER)

// ── 1. 引用一条回复：校验会重算摘录；进模型是全文；落盘是结构 ─────────────
{
  let refs
  try {
    refs = await refList(ctx, sid, [{ kind: 'message', seq: a1.seq, role: 'user', excerpt: '浏览器给的摘录', time: 1 }])
  } catch (e) {
    out.message = { 校验抛了: e.message }
  }
  if (refs) {
    captured = null
    await ctx.agents.send(sid, '这条按季度重写', [], [], { kind: 'user' }, undefined, refs).catch(() => {})
    const text = lastUserText()
    const logged = await lastLoggedUser()
    const blocks = logged?.data?.message?.content ?? []
    const ref = blocks.find((c) => c.type === 'ref')
    const root = (await ctx.sessions.events(sid)).find((e) => e.type === 'session')
    out.message = {
      校验重算了摘录: refs[0].excerpt.startsWith('方案二：先把订单表拆成两张') && refs[0].role === 'assistant' && refs[0].time === a1.time,
      摘录折掉了换行: !refs[0].excerpt.includes('\n'),
      进模型有开头: text.includes('[引用你') && text.includes('的回复]'),
      进模型是全文: text.includes(ANSWER),
      进模型有结束: text.includes('[引用结束]'),
      正文跟在后面: text.indexOf('[引用结束]') < text.indexOf('这条按季度重写'),
      系统提示词讲了规矩: String(captured?.systemPrompt ?? '').includes('## 用户引用的东西'),
      '有 ref 块': Boolean(ref) && ref.kind === 'message' && ref.seq === a1.seq,
      块里的摘录是席位算的: Boolean(ref) && ref.excerpt !== '浏览器给的摘录',
      正文另存一块: blocks.some((c) => c.type === 'text' && c.text === '这条按季度重写'),
      没把那句话写进正文: !blocks.some((c) => c.type === 'text' && c.text.includes('[引用')),
      引用排在正文前: blocks.findIndex((c) => c.type === 'ref') < blocks.findIndex((c) => c.type === 'text'),
      版本号: root.data.version,
      当前版本: SESSION_FORMAT_VERSION,
    }
  }
}

// ── 2. 不带引用的那一轮：系统提示词里没有那一段（条件加载） ──────────────
{
  captured = null
  await ctx.agents.send(sid, '随便问一句').catch(() => {})
  out.plain = {
    系统提示词没有那一段: !String(captured?.systemPrompt ?? '').includes('## 用户引用的东西'),
    正文没被动过: lastUserText().includes('随便问一句') && !lastUserText().includes('[引用'),
  }
}

// ── 3. 被压缩掉的旧回复：引用照样拿到全文 ─────────────────────────────────
{
  const events = await ctx.sessions.events(sid)
  const lastEnd = [...events].reverse().find((e) => e.type === 'turn/end')
  await ctx.sessions.append(sid, 'session/compact', {
    throughSeq: lastEnd.seq,
    from: events[0].time,
    to: lastEnd.time,
    summary: '（摘要）之前聊过几个方案。',
    droppedMessages: 4,
    tokensBefore: 1000,
    tokensAfter: 100,
    by: 'auto',
  })
  const refs = await refList(ctx, sid, [{ kind: 'message', seq: a1.seq }])
  captured = null
  await ctx.agents.send(sid, '压缩之后再引用', [], [], { kind: 'user' }, undefined, refs).catch(() => {})
  const users = (captured?.messages ?? []).filter((m) => m.role === 'user')
  const text = lastUserText()
  out.compacted = {
    原文确实不在历史里了: !users.slice(0, -1).some((m) => JSON.stringify(m.content).includes('先把订单表拆成两张')),
    引用里还是全文: text.includes(ANSWER),
    正文还在: text.includes('压缩之后再引用'),
  }
}

// ── 4. 太长的回复：截断，并告诉模型去 history_read ──────────────────────
{
  const long = '长'.repeat(5000)
  const a2 = await turnOf(5, '来一段长的', long)
  const refs = await refList(ctx, sid, [{ kind: 'message', seq: a2.seq }])
  captured = null
  await ctx.agents.send(sid, '太长了', [], [], { kind: 'user' }, undefined, refs).catch(() => {})
  const text = lastUserText()
  out.long = {
    截到上限: !text.includes(long) && text.includes('长'.repeat(4000)),
    说了全文多长: text.includes('全文 5000 字'),
    指了去哪看: text.includes('history_read'),
    摘录也截到三百字: refs[0].excerpt.length === 300,
  }
}

// ── 5. 引用文件：路径校验、在不在是渲染那一刻的事 ────────────────────────
{
  mkdirSync(join(work, '报表'), { recursive: true })
  writeFileSync(join(work, '报表', '二季度.xlsx'), 'xlsx-bytes')
  const refs = await refList(ctx, sid, [{ kind: 'file', path: '报表/二季度.xlsx' }, { kind: 'file', path: '报表/二季度.xlsx', name: '重复的' }])
  captured = null
  await ctx.agents.send(sid, '加一列同比', [], [], { kind: 'user' }, undefined, refs).catch(() => {})
  const text = lastUserText()
  const logged = await lastLoggedUser()
  const ref = (logged?.data?.message?.content ?? []).find((c) => c.type === 'ref')
  let escaped = ''
  try {
    await refList(ctx, sid, [{ kind: 'file', path: '../../etc/passwd' }])
  } catch (e) {
    escaped = e.message
  }
  const gone = await refList(ctx, sid, [{ kind: 'file', path: '报表/没有这份.xlsx' }])
  captured = null
  await ctx.agents.send(sid, '这份呢', [], [], { kind: 'user' }, undefined, gone).catch(() => {})
  const goneText = lastUserText()
  out.file = {
    同一个文件只留一条: refs.length === 1,
    名字从路径里来: refs[0].name === '二季度.xlsx',
    进模型只给路径: text.includes('[引用文件：`报表/二季度.xlsx`]'),
    在的不标已不在: !text.includes('已不在工作区'),
    没读文件内容: !text.includes('xlsx-bytes'),
    '落盘是 ref 块': Boolean(ref) && ref.kind === 'file' && ref.path === '报表/二季度.xlsx',
    越界拒掉: Boolean(escaped),
    不在的照收: gone.length === 1,
    不在的写明: goneText.includes('[引用文件：`报表/没有这份.xlsx`（已不在工作区）]'),
  }
}

// ── 6. 消息引用的校验 ────────────────────────────────────────────────────
{
  const tryList = async (raw) => {
    try {
      return { ok: await refList(ctx, sid, raw) }
    } catch (e) {
      return { err: e.message }
    }
  }
  const events = await ctx.sessions.events(sid)
  const turnStart = events.find((e) => e.type === 'turn/start')
  const missing = await tryList([{ kind: 'message', seq: 999999 }])
  const notMessage = await tryList([{ kind: 'message', seq: turnStart.seq }])
  const noSeq = await tryList([{ kind: 'message', excerpt: '  渠道带来的   原文 ', role: 'assistant' }])
  const nothing = await tryList([{ kind: 'message' }])
  const tooMany = await tryList(Array.from({ length: 11 }, () => ({ kind: 'file', path: 'x' })))
  const unknown = await tryList([{ kind: 'tool', id: 'x' }])
  const notArray = await tryList({ kind: 'file' })
  const none = await tryList(undefined)
  out.validate = {
    不存在的seq拒掉: missing.err === '引用的消息不存在',
    指到非消息事件拒掉: notMessage.err === '引用的消息不存在',
    没seq有摘录的收下: Boolean(noSeq.ok) && noSeq.ok[0].excerpt === '渠道带来的 原文' && noSeq.ok[0].seq == null,
    没seq没摘录拒掉: Boolean(nothing.err),
    超过十条拒掉: Boolean(tooMany.err),
    不认识的kind拒掉: Boolean(unknown.err),
    不是数组拒掉: Boolean(notArray.err),
    没给就是空: Array.isArray(none.ok) && none.ok.length === 0,
  }
  // 没 seq 的那种渲染给模型：只有摘录，并且说明了只有开头。
  captured = null
  await ctx.agents.send(sid, '渠道那条', [], [], { kind: 'user' }, undefined, noSeq.ok).catch(() => {})
  const text = lastUserText()
  out.validate.没seq的渲染成只有开头 = text.includes('（只有开头）') && text.includes('渠道带来的 原文') && text.includes('[引用结束]')
}

// ── 7. 引用一张图，同时走 images：模型既看到图，也看到那行路径 ───────────
{
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
  writeFileSync(join(work, '图.png'), png)
  const refs = await refList(ctx, sid, [{ kind: 'file', path: '图.png' }])
  captured = null
  await ctx.agents.send(sid, '这张图里是什么', [{ path: '图.png', mime: 'image/png' }], [], { kind: 'user' }, undefined, refs).catch(() => {})
  const blocks = lastUserBlocks()
  out.image = {
    有图: blocks.some((c) => c.type === 'image'),
    有那行路径: blocks.some((c) => c.type === 'text' && c.text.includes('[引用文件：`图.png`]')),
    正文还在: blocks.some((c) => c.type === 'text' && c.text.includes('这张图里是什么')),
  }
}

// ── 8. 插话与排队两条岔路都带着引用 ──────────────────────────────────────
{
  const fileRef = await refList(ctx, sid, [{ kind: 'file', path: '报表/二季度.xlsx' }])
  let release
  hold = new Promise((r) => (release = r))
  captured = null
  const running = ctx.agents.send(sid, '这一轮会卡住').catch(() => {})
  // 插话只接 live 里的那一轮；isRunning 在 starting 阶段就是 true，要等到模型真被调到。
  for (let i = 0; i < 100 && !captured; i++) await sleep(20)
  const steered = await ctx.agents.steer(sid, '等会按这份再来一遍', [], { kind: 'user' }, fileRef)
  const steerLogged = await lastLoggedUser()
  const steerBlocks = steerLogged?.data?.message?.content ?? []

  const row = ctx.agents.enqueue(sid, '排队的这句', [], [], fileRef)
  const queuedRow = ctx.agents.queued(sid)[0]

  captured = null
  release()
  hold = null
  await running
  for (let i = 0; i < 100 && ctx.agents.queued(sid).length; i++) await sleep(20)
  await sleep(200)
  const queueText = lastUserText()
  const queueLogged = await lastLoggedUser()
  out.paths = {
    插话接住了: steered === true,
    插话落盘带ref块: steerBlocks.some((c) => c.type === 'ref' && c.kind === 'file'),
    插话正文另存: steerBlocks.some((c) => c.type === 'text' && c.text === '等会按这份再来一遍'),
    排队行带着引用: Array.isArray(row.refs) && row.refs.length === 1 && Array.isArray(queuedRow.refs),
    排队那条跑了: queueText.includes('排队的这句'),
    排队那条进模型带引用: queueText.includes('[引用文件：`报表/二季度.xlsx`]'),
    排队那条落盘带ref块: (queueLogged?.data?.message?.content ?? []).some((c) => c.type === 'ref'),
  }
}

console.log('__RESULT__' + JSON.stringify(out))
process.exit(0)
