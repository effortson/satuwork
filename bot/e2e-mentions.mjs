/**
 * `@` 点名与排队。探针，结果打在 `__RESULT__` 那一行上（见 e2e/mentions.mjs）。
 *
 * 验四件事：
 *
 *   1. 点名落进 JSONL 是**结构**（`mention` 块），进模型是**一句话**（`[本轮指定：…]`）；
 *   2. `mentionOnly` 的连接平时不在工具表里，被点名那一轮才在；
 *   3. 点名不是过滤：别的工具一个都没少，被点的排最前；
 *   4. 上一轮还在跑时，带 `@` 的消息**排队**而不是插话，跑完自动接上，也能取消。
 */
import { mkdtempSync, rmSync } from 'node:fs'
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
import { viaMentionOf } from './src/catalog/index.ts'
import { SESSION_FORMAT_VERSION } from './src/session/types.ts'

const home = mkdtempSync(join(tmpdir(), 'satu-mention-'))
const work = mkdtempSync(join(tmpdir(), 'satu-mention-work-'))
// 退出时收掉临时目录（和 e2e-memory / e2e-skills 那几个探针同一个写法）：探针是顶层 await 的
// 脚本，没有一个能包 finally 的函数体；exit 钩子在 process.exit、正常结束和未捕获异常三条路上都会跑。
process.on('exit', () => { try { rmSync(home, { recursive: true, force: true }) } catch {} try { rmSync(work, { recursive: true, force: true }) } catch {} })

/**
 * 假目录：两台「服务器」，personal 那台是「仅 @ 时可用」。
 *
 * 真的 CatalogService 要连 Gateway，这里只用到 servers / toolNamesFor 两处。
 */
class FakeCatalog extends Service {
  constructor(ctx) {
    super(ctx, 'catalog')
    this.tools = {
      'conn-default': ['mcp_gmail_default_send_email'],
      'conn-personal': ['mcp_gmail_person_send_email'],
      'srv-notion': ['mcp_notion_create_page'],
    }
    this.mentionOnlyIds = new Set(['conn-personal'])
    /** 重拉了几次。点名却没工具时 agent 会补拉一次目录（见 agent/index.ts）。 */
    this.pulls = 0
    /** 这一把「重拉之后才出现」——刚在浏览器里授权完、席位还没同步到的那个时序。 */
    this.appearOnPull = ''
    /** 给了就让 pull 等它——模拟「重拉目录要好几秒」，测开轮那一段能不能喊停。 */
    this.gate = null
  }
  /** 真的 CatalogService 会去打 Gateway；这里只记一笔，顺便把「迟到的那把」放出来。 */
  async pull() {
    this.pulls += 1
    if (this.gate) await this.gate
    const late = this.appearOnPull
    if (!late) return true
    this.appearOnPull = ''
    const name = `mcp_${late.replace(/-/g, '_')}_send_email`
    this.tools[late] = [name]
    this.ctx.tools.register({ name, description: name, parameters: { type: 'object', properties: {} }, execute: async () => ({ text: 'ok' }) })
    return true
  }

  get servers() {
    return Object.keys(this.tools).map((id) => ({ id, name: id, kind: 'HTTP', enabled: true, connected: true, tools: this.tools[id] }))
  }
  toolNamesFor(ids, mentioned = []) {
    const allow = new Set(ids)
    const named = new Set(mentioned)
    const out = []
    for (const [id, names] of Object.entries(this.tools)) {
      if (!allow.has(id)) continue
      if (this.mentionOnlyIds.has(id) && !named.has(id)) continue
      out.push(...names)
    }
    return out
  }
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

// 三个工具都注册上，好让 toolSchemasFor 有东西可挑。
for (const name of ['mcp_gmail_default_send_email', 'mcp_gmail_person_send_email', 'mcp_notion_create_page']) {
  ctx.tools.register({ name, description: name, parameters: { type: 'object', properties: {} }, execute: async () => ({ text: 'ok' }) })
}

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
const sessionId = await ctx.sessions.create({ title: '探针', botId: 'default' })
const toolNames = () => (captured?.tools ?? []).map((t) => t.name)
const lastUser = () => {
  const users = (captured?.messages ?? []).filter((m) => m.role === 'user')
  const last = users[users.length - 1]
  if (!last) return []
  return typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : (last.content ?? [])
}

// ── 1. 不点名：mentionOnly 的那台不在工具表里 ─────────────────────────
captured = null
await ctx.agents.send(sessionId, '看看我的邮件').catch(() => {})
out.plain = {
  有默认那把: toolNames().includes('mcp_gmail_default_send_email'),
  没有仅点名那把: !toolNames().includes('mcp_gmail_person_send_email'),
  有别的工具: toolNames().includes('mcp_notion_create_page'),
}

// ── 2. 点名：那把进来了，别的一个没少，而且排在最前 ───────────────────
captured = null
await ctx.agents
  .send(sessionId, '查看最新邮件', [], [{ kind: 'connector', id: 'conn-personal', label: 'Gmail (personal)' }])
  .catch(() => {})
{
  const names = toolNames()
  const blocks = lastUser()
  out.mentioned = {
    仅点名那把进来了: names.includes('mcp_gmail_person_send_email'),
    别的工具没被拿掉: names.includes('mcp_notion_create_page') && names.includes('mcp_gmail_default_send_email'),
    被点的排最前: names[0] === 'mcp_gmail_person_send_email',
    进模型的是一句话: blocks.some((c) => c.type === 'text' && c.text.includes('[本轮指定：Gmail (personal)]')),
    正文还在: blocks.some((c) => c.type === 'text' && c.text.includes('查看最新邮件')),
  }
}

// ── 3. 落盘是结构，不是那句话 ─────────────────────────────────────────
{
  const events = await ctx.sessions.events(sessionId)
  const users = events.filter((e) => e.type === 'user/message')
  const blocks = users[users.length - 1].data.message.content
  const root = events.find((e) => e.type === 'session')
  out.jsonl = {
    '有 mention 块': blocks.some((c) => c.type === 'mention' && c.id === 'conn-personal'),
    '块里带 label': blocks.some((c) => c.type === 'mention' && c.label === 'Gmail (personal)'),
    正文另存一块: blocks.some((c) => c.type === 'text' && c.text === '查看最新邮件'),
    没把那句话写进正文: !blocks.some((c) => c.type === 'text' && c.text.includes('[本轮指定')),
    版本号: root.data.version,
    当前版本: SESSION_FORMAT_VERSION,
  }
}

// ── 4. 上一轮还在跑：带 @ 的排队，不插话 ──────────────────────────────
{
  let release
  hold = new Promise((r) => (release = r))
  const running = ctx.agents.send(sessionId, '这一轮会卡住').catch(() => {})
  // 等它真的开跑（streamFn 已经被调到）。
  for (let i = 0; i < 50 && !ctx.agents.isRunning(sessionId); i++) await new Promise((r) => setTimeout(r, 20))
  out.queue = { 在跑: ctx.agents.isRunning(sessionId) }

  const row = ctx.agents.enqueue(sessionId, '排队的这句', [], [{ kind: 'connector', id: 'conn-personal', label: 'Gmail (personal)' }])
  out.queue.排进去了 = ctx.agents.queued(sessionId).length === 1
  out.queue.取消不存在的会说没这条 = ctx.agents.cancelQueued(sessionId, 'no-such-id') === 'missing'

  const second = ctx.agents.enqueue(sessionId, '第二条', [], [])
  out.queue.能排两条 = ctx.agents.queued(sessionId).length === 2
  out.queue.取消得掉 = ctx.agents.cancelQueued(sessionId, second.id) === 'cancelled'
  out.queue.取消之后剩一条 = ctx.agents.queued(sessionId).length === 1
  out.queue.先进的排在前 = ctx.agents.queued(sessionId)[0].id === row.id

  captured = null
  release()
  await running
  // 队列在上一轮收口之后自己接上，给它一点时间跑完。
  for (let i = 0; i < 100 && ctx.agents.queued(sessionId).length; i++) await new Promise((r) => setTimeout(r, 20))
  await new Promise((r) => setTimeout(r, 200))
  out.queue.队列清空了 = ctx.agents.queued(sessionId).length === 0
  const blocks = lastUser()
  out.queue.排队那条真的跑了 = blocks.some((c) => c.type === 'text' && c.text.includes('排队的这句'))
  out.queue.排队那条带着点名 = toolNames().includes('mcp_gmail_person_send_email')

  /**
   * 「这个席位忙不忙」的判据：**只认在跑的轮次，不认排着的消息**。
   *
   * 管家换 bot 版本之前拿它决定要不要等（见 manager/src/seats.ts 的排空）。队列是落盘
   * 的，而消费它的唯一时机是「某一轮跑完」（drainQueue）——一条在 turn 跑到一半时被杀掉
   * 留下的孤儿排队行，会在重启之后一直躺在盘上没人碰。认它的话，这个席位从此永远自报
   * 忙，自动跟版一路 409，再也升不上去；而拦下这次重启一件东西也保护不了：根本没有
   * turn 在跑，队列本来就不会动。
   */
  const orphan = 's-orphan'
  const left = ctx.agents.enqueue(orphan, '上一次被杀掉时留下的那条', [], [])
  const gate = ctx.agents.busy()
  out.busyGate = {
    盘上确实还排着一条: ctx.agents.queued(orphan).length === 1,
    没有轮次在跑: gate.running === 0,
    queued照旧报得出来: gate.queued >= 1,
  }
  ctx.agents.cancelQueued(orphan, left.id)

  /**
   * 换版静默：**不开新的一轮，但不动正在跑的那一轮。**
   *
   * 管家等到「此刻没人在跑」之后，到真的 `systemctl restart` 之间还隔着拉包、解包、
   * rsync 那几秒。没有这道闸，人在那几秒里发一句照样被拦腰砍断，而排空看上去明明成功
   * 了——这一条钉的就是那个窗口真的关上了。
   */
  const quiet = 's-quiet'
  ctx.agents.quiesce(60_000)
  let refused = ''
  try {
    await ctx.agents.send(quiet, '换版期间发的这一句', [], [])
  } catch (e) {
    refused = e.message
  }
  const stillIdle = !ctx.agents.isRunning(quiet)
  ctx.agents.resume()
  let after = ''
  try {
    // 放开之后必须立刻恢复接活：这道闸只该管那几秒。llm 那头在这份探针里是假的，
    // 跑得起来就说明闸开了（跑不跑得完不在这一条的范围内）。
    await ctx.agents.send(quiet, '放开之后这一句该跑得起来', [], [])
  } catch (e) {
    after = e.message
  }
  out.quiet = {
    静默期回绝了新一轮: refused.includes('席位正在换新版本'),
    回绝之后没留下半个轮次: stillIdle,
    放开之后又接活了: !after.includes('席位正在换新版本'),
    // TTL 是硬上限：管家半路挂了也不能把席位冻成一块砖。
    上限夹得住: ctx.agents.quiesce(999 * 60_000) - Date.now() <= 5 * 60_000 + 1000,
  }
  ctx.agents.resume()
}

// ── 5. 出队之后、agent 建出来之前，isRunning 必须一直是 true ─────────
//
// runTurn 走到 live.set 之前有好几个 await（读日志、重建历史、两次 append）。那期间
// 要是 isRunning() 返回 false，同一条会话就会被开出第二轮并发 agent——事件交错写进
// 同一份 JSONL，用量也记两遍。这里把 sessions.events 卡住，正好停在那个窗口上。
{
  const origEvents = ctx.sessions.events.bind(ctx.sessions)
  let gate = null
  ctx.sessions.events = async (...args) => {
    if (gate) await gate
    return origEvents(...args)
  }

  let release
  hold = new Promise((r) => (release = r))
  const running = ctx.agents.send(sessionId, '卡住这一轮').catch(() => {})
  for (let i = 0; i < 50 && !ctx.agents.isRunning(sessionId); i++) await new Promise((r) => setTimeout(r, 20))

  ctx.agents.enqueue(sessionId, '接在后面的那条', [], [])
  let openGate
  gate = new Promise((r) => (openGate = r))
  hold = null
  release()
  /**
   * **不能在这里 await running**：send() 的最后一步是 drainQueue，而队列里那条正卡在
   * gate 上，这个 promise 要等到闸放开才会落地。
   *
   * 等的是「队列已经出队」——那一刻 runTurn 正停在 sessions.events 上，也就是 agent
   * 还没建出来的那个窗口，正是要检查的地方。
   */
  for (let i = 0; i < 100 && ctx.agents.queued(sessionId).length; i++) await new Promise((r) => setTimeout(r, 10))
  await new Promise((r) => setTimeout(r, 50))
  out.window = { 出队之后仍然算在跑: ctx.agents.isRunning(sessionId) }
  openGate()
  gate = null
  await running
  ctx.sessions.events = origEvents
}

// ── 6. 队列里一条跑失败，后面的照跑 ──────────────────────────────────
{
  const failId = await ctx.sessions.create({ title: '失败探针', botId: 'default' })
  let release
  hold = new Promise((r) => (release = r))
  const running = ctx.agents.send(failId, '卡住').catch(() => {})
  for (let i = 0; i < 50 && !ctx.agents.isRunning(failId); i++) await new Promise((r) => setTimeout(r, 20))

  // 第一条排队的必然失败：图片路径不存在，toAgentMessages 会抛。
  ctx.agents.enqueue(failId, '这条会失败', [{ path: 'nope/missing.png', mime: 'image/png' }], [])
  ctx.agents.enqueue(failId, '这条应该照跑', [], [])
  hold = null
  release()
  await running
  for (let i = 0; i < 150 && ctx.agents.queued(failId).length; i++) await new Promise((r) => setTimeout(r, 20))
  await new Promise((r) => setTimeout(r, 300))
  const events = await ctx.sessions.events(failId)
  const texts = JSON.stringify(events)
  out.keepGoing = {
    队列清空了: ctx.agents.queued(failId).length === 0,
    失败那条不挡后面的: texts.includes('这条应该照跑'),
  }
}

// ── 7. 取消要分得清「没这条」和「已经开跑」 ──────────────────────────
{
  const cancelId = await ctx.sessions.create({ title: '取消探针', botId: 'default' })
  let release
  hold = new Promise((r) => (release = r))
  const running = ctx.agents.send(cancelId, '卡住').catch(() => {})
  for (let i = 0; i < 50 && !ctx.agents.isRunning(cancelId); i++) await new Promise((r) => setTimeout(r, 20))
  const row = ctx.agents.enqueue(cancelId, '要被取消的', [], [])
  out.cancelKinds = {
    没这条: ctx.agents.cancelQueued(cancelId, 'never-existed') === 'missing',
    取消成功: ctx.agents.cancelQueued(cancelId, row.id) === 'cancelled',
    取消过的再取消还是没这条: ctx.agents.cancelQueued(cancelId, row.id) === 'missing',
  }
  const started = ctx.agents.enqueue(cancelId, '会被跑掉的', [], [])
  hold = null
  release()
  await running
  for (let i = 0; i < 100 && ctx.agents.queued(cancelId).length; i++) await new Promise((r) => setTimeout(r, 20))
  await new Promise((r) => setTimeout(r, 200))
  // 已经出队开跑的那条：不能报「没这条」，那会让用户以为自己拦住了。
  out.cancelKinds.已经开跑 = ctx.agents.cancelQueued(cancelId, started.id) === 'started'
}

// ── 8. 队列不进 JSONL：取消掉的那条一个字都不留 ───────────────────────
{
  const events = await ctx.sessions.events(sessionId)
  const all = JSON.stringify(events)
  out.cancelled = { 取消的那条没进日志: !all.includes('第二条') }
}

// ── 9. 点名了却没工具：先补拉一次目录，还是没有就把实情说给模型听 ────
{
  const say = async (id, label) => {
    captured = null
    await ctx.agents.send(sessionId, '查看邮件', [], [{ kind: 'connector', id, label }]).catch(() => {})
    return { tools: toolNames(), system: captured?.systemPrompt ?? '' }
  }

  // 9a. 刚授权完、席位还没同步：补拉一次就该有了，也就不用跟模型解释什么。
  ctx.catalog.appearOnPull = 'conn-late'
  const before = ctx.catalog.pulls
  const late = await say('conn-late', 'Gmail (late)')
  out.late = {
    补拉了一次: ctx.catalog.pulls === before + 1,
    工具补回来了: late.tools.includes('mcp_conn_late_send_email'),
    不用再跟模型解释: !late.system.includes('本轮被点名、但没挂上的连接'),
  }

  // 9b. 补拉了还是没有：**必须说出来**。不说的话模型会自己编一个替代方案——
  // 线上真发生过，它开始教用户用虚拟桌面里的 Chrome 登邮箱。
  const at = ctx.catalog.pulls
  const ghost = await say('conn-ghost', 'Gmail (ghost)')
  out.gap = {
    也补拉了一次: ctx.catalog.pulls === at + 1,
    跟模型说清楚了: ghost.system.includes('本轮被点名、但没挂上的连接'),
    点了名的那把写出来了: ghost.system.includes('Gmail (ghost)'),
    这一轮照样跑: ghost.tools.includes('mcp_notion_create_page'),
  }
}

// ── 10. 「这一次是不是点名调的」这个标记，绝不许把工具调用弄失败 ─────
//
// 线上就是这么坏的：目录插件不能 inject agents（会绕出依赖环），原来写成
// `ctx.agents?.mentionedIn?.()`，以为 `?.` 能兜住——可 cordis 的守卫是在**取属性那一刻**
// 抛的，`?.` 挡的是取到之后的 null。于是 Gmail 的每一次调用都返回一句
// `cannot get property "agents" without inject`，一个流水上的附加标记把整把工具打死了。
{
  const poisoned = { get agents() { throw new Error('cannot get property "agents" without inject') } }
  const viaThrows = { reflect: { get() { throw new Error('炸') } } }
  const viaOk = { reflect: { get: (n) => (n === 'agents' ? { mentionedIn: () => new Set(['srv-1']) } : undefined) } }
  const noReflect = {}
  // 抛出来也要接住：不接的话探针自己先死了，报出来的是「读不到 viaMention」，
  // 而真正的失败（它抛了）反倒看不见。
  const call = (c, sid, srv) => {
    try {
      return viaMentionOf(c, sid, srv)
    } catch (e) {
      return 'THROW: ' + e.message
    }
  }
  /**
   * **三态，不是两态。** 取不到 agents 时返回的是 `undefined`——「我这会儿答不上来」，
   * 不是「人没点名」。这个区别有后果：Gateway 拿这个标记强制「仅 @ 时可用」的连接
   * （gateway/src/routes/mcp.ts），报 false 就等于替用户说他没点名，于是上面那次故障的
   * 后果会从「流水少个标记」升级成「这把连接彻底用不了」。
   *
   * 不变的那一条仍然是这几行的主题：**无论如何都不许抛**。
   */
  out.viaMention = {
    取不到时是undefined: call(poisoned, 's1', 'srv-1') === undefined,
    reflect自己炸了也不许抛: call(viaThrows, 's1', 'srv-1') === undefined,
    没有reflect也不许抛: call(noReflect, 's1', 'srv-1') === undefined,
    一次都没抛出来: [poisoned, viaThrows, noReflect].every(
      (c) => !String(call(c, 's1', 'srv-1')).startsWith('THROW'),
    ),
    点了名的照样认得出: call(viaOk, 's1', 'srv-1') === true,
    没点那台不算: call(viaOk, 's1', 'srv-2') === false,
  }
}

// ── 开轮那几秒里按停止 ───────────────────────────────────────────────
/**
 * 停止按钮以前只看 live：点名缺工具要重拉目录、轮首要同步压缩，那几秒里 agent 还没
 * 建出来，按停止回 aborted:false，然后这一轮照样整轮跑完。拿一次慢的重拉卡在开轮那一段。
 */
{
  const sid = await ctx.sessions.create({ title: '开轮时停止', botId: 'default' })
  let release
  ctx.catalog.gate = new Promise((r) => (release = r))
  const pullsBefore = ctx.catalog.pulls
  captured = null
  hold = null
  let settled = false
  const sending = ctx.agents
    .send(sid, '帮我发封邮件', [], [{ kind: 'connector', id: 'conn-ghost', label: '没挂上的' }])
    .then(() => (settled = true), () => (settled = true))
  for (let i = 0; i < 100 && ctx.catalog.pulls === pullsBefore; i++) await new Promise((r) => setTimeout(r, 10))
  const wasRunning = ctx.agents.isRunning(sid)
  const aborted = ctx.agents.abort(sid)
  for (let i = 0; i < 100 && !settled; i++) await new Promise((r) => setTimeout(r, 10))
  const settledBeforeRelease = settled
  release()
  ctx.catalog.gate = null
  await sending
  const events = await ctx.sessions.events(sid)
  const end = events.filter((e) => e.type === 'turn/end').pop()
  out.abortStarting = {
    卡在重拉目录上: ctx.catalog.pulls === pullsBefore + 1,
    开轮时算在跑: wasRunning,
    停得下来: aborted === true,
    不等目录拉完就收口: settledBeforeRelease,
    模型一次没调: captured === null,
    这一轮记成aborted: end?.data?.reason === 'aborted',
    那句话还在: events.some((e) => e.type === 'user/message' && JSON.stringify(e.data).includes('帮我发封邮件')),
    收口之后不在跑: !ctx.agents.isRunning(sid),
    再按一次是false: ctx.agents.abort(sid) === false,
  }
  // 下一轮不许被错认成「被喊停了」：aborting 里不能留一笔。
  await ctx.agents.send(sid, '再来一次').catch(() => {})
  const next = (await ctx.sessions.events(sid)).filter((e) => e.type === 'turn/end').pop()
  out.abortStarting.下一轮不受影响 = next?.data?.reason !== 'aborted' && captured !== null
}

hold = null

/**
 * 开机排空：上一条命留下的队列，等目录拉下来就接着跑。**放在最后**：后台那次开机排空一直在
 * 等 pulledAt，这里一设，它会把当时所有排着的消息都跑掉，放前面会搅了别的段。
 */
{
  const sid = 's-boot-queue'
  // drainAtBoot 的等待定时器是 unref 的（不拖住进程退出）；探针里没有别的东西占着事件循环，
  // 这里挂一个占位的，不然 Node 会以「顶层 await 永远等不到」直接退出。
  const keepAlive = setInterval(() => {}, 1_000)
  ctx.agents.enqueue(sid, '换版重启之前排进来的', [], [])
  // 目录还没拉下来：等满就放弃，一条都不动——这时开跑会以「没有模型」失败，消息白丢。
  const notYet = await ctx.agents.drainAtBoot({ waitMs: 100, pollMs: 20 })
  const keptWhileNotReady = ctx.agents.queued(sid).length === 1
  ctx.catalog.pulledAt = Date.now()
  const ran = await ctx.agents.drainAtBoot({ waitMs: 100, pollMs: 20 })
  await new Promise((r) => setTimeout(r, 50))
  const drained = ctx.agents.queued(sid).length === 0
  for (let i = 0; i < 100 && ctx.agents.isRunning(sid); i++) await new Promise((r) => setTimeout(r, 50))
  clearInterval(keepAlive)
  out.bootDrain = {
    目录没好时一条不动: notYet === 0 && keptWhileNotReady,
    目录好了就接着跑: ran >= 1 && drained,
  }
}

console.log('__RESULT__' + JSON.stringify(out))
process.exit(0)
