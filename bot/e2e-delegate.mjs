/**
 * 子代理委派（见 docs/delegation.md）。
 *
 * 为什么值得单开一个探针：这套东西**坏了大半都不报错**。子会话混进侧栏、档位降级没生效、
 * 子代理留下的后台进程成了孤儿、重启后那张卡永远转着——每一种的表现都是「看起来还行」，
 * 而它们各自对应的那一行代码，谁都可能在下一次重构里顺手删掉。
 *
 * 钉七件事：
 *
 *   1. **结果按 index 回，不按谁先跑完。** 模型下一句会说「第一件事的结论是…」
 *   2. **隔离是真的**：子代理的过程一条都不进主会话；子会话默认不进 sessions.list()
 *      ——那条列表的每个调用方都在问「这个人有哪几条对话」，而 ensureSession 认的是
 *      `mine[0]`，混进去就是「侧栏里的对话被换成半年前一次子任务」
 *   3. **档位逐条生效**：utility 那条真的换了模型
 *   4. **理由是 utility 的入场券**：写了 utility 却没给 model_reason 的降成 daily
 *   5. **档位写错整次不发生**：不是「当默认值处理」——那会让账单和界面一起撒谎
 *   6. **retains 的东西会移交，而且在结论里点名**：不点名的话主代理不知道自己接手了什么
 *   7. **重启后没有永远转着的卡**：healTasks 把 running 补成 lost（不是 failed，那是在编）
 *
 * 外加一条编译期的：**内置工具漏标 delegation 就抛**。它是「将来新增工具不会静默走错边」
 * 的全部保障。
 *
 * 探针要 tsx 才 import 得了 .ts，所以由 e2e/delegate.mjs 另起一个进程跑。
 */
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import * as storagePlugin from './src/storage/index.ts'
import * as sessionsPlugin from './src/session/index.ts'
import * as workspacePlugin from './src/workspace/index.ts'
import * as toolsPlugin from './src/tools/index.ts'
import * as llmPlugin from './src/llm/index.ts'
import * as agentPlugin from './src/agent/index.ts'
import * as delegatePlugin from './src/tools/delegate.ts'
import { AssistantMessageEventStream, emptyAssistant } from './src/llm/stream.ts'
import { tempDir } from './e2e-lib.mjs'

const home = tempDir('satu-delegate-')
const work = tempDir('satu-delegate-work-')

/** 假目录：这一层用到的只有 `models`（agent 的 roleModel 取 utility 就看它）。 */
class FakeCatalog extends Service {
  constructor(ctx) {
    super(ctx, 'catalog')
    this.models = { daily: { provider: 'p-daily', model: 'm-daily' }, utility: { provider: 'p-util', model: 'm-util' } }
  }
  async pull() {
    return true
  }

  get servers() {
    return []
  }
  toolNamesFor() {
    return []
  }
}

const ctx = new Context()
ctx.plugin(storagePlugin, { path: join(home, 'db.sqlite') })
ctx.plugin(sessionsPlugin, { root: join(home, 'sessions') })
ctx.plugin(workspacePlugin, { root: work })
ctx.plugin(toolsPlugin)
ctx.plugin(FakeCatalog)
ctx.plugin(llmPlugin)
ctx.plugin(agentPlugin, { provider: 'p-bot', model: 'm-bot' })
ctx.plugin(delegatePlugin)
await new Promise((r) => setTimeout(r, 300))

ctx.llm.catalog = () => [
  { provider: 'p-bot', models: [{ id: 'm-bot', contextWindow: 200000 }] },
  { provider: 'p-util', models: [{ id: 'm-util', contextWindow: 32000 }] },
]

/**
 * 假模型：说一句就收口。
 *
 * **每条子任务的耗时不一样，而且和 index 反着来**——第 3 条最快跑完。第 1 条要是排在
 * 第 3 条后面，那条「按 index 排」的断言才有意义。
 */
const seen = []
const delayFor = (system) => {
  if (system.includes('慢')) return 120
  if (system.includes('中')) return 60
  return 5
}
ctx.llm.streamFn = (model, context) => {
  const system = String(context?.systemPrompt ?? '')
  const brief = JSON.stringify(context?.messages ?? [])
  seen.push({ provider: model.provider, model: model.id, system, brief })
  const stream = new AssistantMessageEventStream()
  /**
   * 「进度探针」「报错探针」那两条：第一步说一句、调一次 fake_probe；第二步一个说「查完了」收口，
   * 一个当场报模型错——后者正是线上那种「说了句我再核对一下就失败了」。
   */
  const scripted = brief.includes('进度探针') ? 'progress' : brief.includes('报错探针') ? 'error' : ''
  if (scripted) {
    const second = (context?.messages ?? []).some((m) => m.role === 'toolResult')
    const partial = emptyAssistant(model, second && scripted === 'error' ? 'upstream 529 overloaded' : undefined)
    setTimeout(() => {
      stream.push({ type: 'start', partial })
      if (!second) {
        partial.content.push({ type: 'text', text: '我再核对一下' })
        partial.content.push({ type: 'toolCall', id: `call_${seen.length}`, name: 'fake_probe', arguments: { url: 'https://example.com/a' } })
        partial.stopReason = 'toolUse'
        stream.push({ type: 'done', reason: 'toolUse', message: partial })
      } else if (scripted === 'error') {
        stream.push({ type: 'error', reason: 'error', error: partial })
      } else {
        partial.content.push({ type: 'text', text: '查完了' })
        partial.stopReason = 'stop'
        stream.push({ type: 'done', reason: 'stop', message: partial })
      }
      stream.end()
    }, 5)
    return stream
  }
  setTimeout(() => {
    const partial = emptyAssistant(model)
    partial.content.push({ type: 'text', text: `做完了：${model.id}` })
    partial.stopReason = 'stop'
    stream.push({ type: 'done', reason: 'stop', message: partial })
    stream.end()
  }, delayFor(brief))
  return stream
}

/** 一把假的 retains 工具：只为验移交那条链子（真的那把是 terminal 的后台进程）。 */
let handedFrom = ''
ctx.tools.register({
  name: 'fake_daemon',
  description: '探针用',
  parameters: { type: 'object', properties: {} },
  risk: ['read'],
  delegation: { retains: true },
  reassign: (from, to) => {
    if (!from.startsWith('t-')) return []
    handedFrom = `${from}->${to}`
    return [{ id: 'bg-probe', label: 'sleep 999' }]
  },
  execute: () => ({ text: 'ok' }),
})

ctx.tools.register({
  name: 'fake_probe',
  description: '探针用',
  parameters: { type: 'object', properties: { url: { type: 'string' } } },
  risk: ['read'],
  delegation: {},
  execute: () => ({ text: '抓到了' }),
})

const out = {}

// ── 漏标就抛 ──────────────────────────────────────────────────────
try {
  ctx.tools.register({ name: 'unannotated', description: 'x', parameters: {}, execute: () => ({ text: '' }) })
  out.assert = { 漏标会抛: false }
} catch (e) {
  out.assert = { 漏标会抛: true, 错误里点名了: String(e.message).includes('unannotated') }
}

const sessionId = await ctx.sessions.create({ title: '探针', botId: 'default' })
const before = (await ctx.sessions.events(sessionId)).length

// ── 一批三条 ──────────────────────────────────────────────────────
const call = {
  callId: 'c-1',
  name: 'delegate_task',
  sessionId,
  arguments: JSON.stringify({
    tasks: [
      { goal: '慢的那条', context: '慢', model_reason: '机械活', model_role: 'utility' },
      { goal: '中的那条', context: '中', model_reason: '要判断', model_role: 'daily' },
      // 写了 utility 却没给理由：降成 daily（理由是 utility 的入场券）
      { goal: '快的那条', context: '快', model_role: 'utility' },
    ],
  }),
}
const batch = await ctx.tools.execute(call)
const text = batch.text

const tasks = (await ctx.sessions.events(sessionId)).filter((e) => e.type === 'agent/task')
const finals = new Map()
for (const e of tasks) finals.set(e.data.id, e.data)
const byIndex = [...finals.values()].sort((a, b) => a.index - b.index)

out.batch = {
  三条都跑了: byIndex.length === 3,
  都收口了: byIndex.every((t) => t.state === 'done'),
  // 结果按 index 排，不按谁先跑完：第 3 条最快，但它必须排在最后。
  按index排: /慢的那条[\s\S]*中的那条[\s\S]*快的那条/.test(text),
  每条都有子会话: byIndex.every((t) => typeof t.child === 'string' && t.child.startsWith('t-')),
  跑之前先报running: tasks.some((e) => e.data.state === 'running'),
}

// ── 档位 ──────────────────────────────────────────────────────────
out.model = {
  utility真的换了模型: byIndex[0].model.provider === 'p-util' && byIndex[0].model.id === 'm-util',
  daily不覆盖: byIndex[1].model.provider === 'p-bot' && byIndex[1].model.id === 'm-bot',
  没理由的utility降成daily: byIndex[2].model.role === 'daily' && byIndex[2].model.id === 'm-bot',
  降级标出来了: byIndex[2].model.downgraded === true,
  理由留在事件上: byIndex[0].model.reason === '机械活',
  档位出现在给模型的文本里: text.includes('utility') && text.includes('daily'),
}

// ── 隔离 ──────────────────────────────────────────────────────────
const child0 = byIndex[0].child
const childEvents = await ctx.sessions.events(child0)
const mainEvents = await ctx.sessions.events(sessionId)
const listed = await ctx.sessions.list()
const listedAll = await ctx.sessions.list({ tasks: true })
out.isolation = {
  子代理的step不在主会话: !mainEvents.some((e) => e.type === 'step/start'),
  子会话里有完整过程: childEvents.some((e) => e.type === 'request/header') && childEvents.some((e) => e.type === 'turn/end'),
  子会话标了task: childEvents.find((e) => e.type === 'session').data.kind === 'task',
  子会话记得主会话: childEvents.find((e) => e.type === 'session').data.parent?.sessionId === sessionId,
  list默认不含子会话: listed.every((s) => s.id === sessionId),
  list带tasks才含: listedAll.length === 4,
  rootOf查得到: ctx.agents.rootOf(child0) === sessionId,
  主会话只多了agent_task和工具那两条: mainEvents.length - before === tasks.length,
  // 子代理拿不到 delegate_task：深度定死 1。
  子代理工具表里没有委派: !(childEvents.find((e) => e.type === 'request/header')?.data.tools ?? []).some(
    (t) => t.name === 'delegate_task',
  ),
}

// ── 移交 ──────────────────────────────────────────────────────────
out.retains = {
  移交跑了: handedFrom.startsWith('t-') && handedFrom.endsWith(sessionId),
  结论里点名了: text.includes('接手的后台进程：bg-probe'),
}

// ── 档位写错：整次委派不发生 ──────────────────────────────────────
const sessionsBefore = (await ctx.sessions.list({ tasks: true })).length
const bad = await ctx.tools.execute({
  callId: 'c-2',
  name: 'delegate_task',
  sessionId,
  arguments: JSON.stringify({ tasks: [{ goal: 'x', context: 'y', model_reason: 'z', model_role: 'util' }] }),
})
out.badRole = {
  说清楚了: bad.text.includes('只能是 daily 或 utility'),
  整次没发生: (await ctx.sessions.list({ tasks: true })).length === sessionsBefore,
}

// ── 已经按了停止：什么都不该发生 ──────────────────────────────────
//
// 已经是 aborted 的信号**不会再发事件**，所以「先挂监听器」这个写法接不住它。人按停止
// 的那一刻模型很可能刚发出这次调用——接不住就是子代理照跑满 30 步，而屏幕上那颗停止
// 按钮看起来毫无动静。
{
  const before = (await ctx.sessions.list({ tasks: true })).length
  const ac = new AbortController()
  ac.abort()
  const r = await ctx.agents.runTask(sessionId, 'c-3', {
    index: 0,
    goal: '不该跑起来的',
    context: 'x',
    modelRole: 'daily',
    maxSteps: 30,
    leases: [],
    timeoutMs: 60000,
  }, ac.signal)
  out.aborted = {
    当场收口: r.state === 'aborted',
    // 连子会话都不该开：什么都没发生，界面上就不该多出一张卡。
    没开子会话: (await ctx.sessions.list({ tasks: true })).length === before && !r.child,
    没花钱: r.steps === 0,
  }
}

// ── tools 里写了认不出的名字 ──────────────────────────────────────
//
// 不校验的话，一个旧名字（read / grep / bash 那一套刚改过，而模型自己的历史里还全是
// 它们）会把工具表过滤成空的——子代理拿着空表只能干说，最后交回一段「我什么都做不了」。
{
  const before = (await ctx.sessions.list({ tasks: true })).length
  const bad = await ctx.tools.execute({
    callId: 'c-4',
    name: 'delegate_task',
    sessionId,
    arguments: JSON.stringify({
      tasks: [{ goal: 'x', context: 'y', model_reason: 'z', model_role: 'daily', tools: ['grep', 'read_file'] }],
    }),
  })
  out.badTools = {
    点名了是哪个: bad.text.includes('grep'),
    整次没发生: (await ctx.sessions.list({ tasks: true })).length === before,
  }
}

// ── 跑着的进度、没做成的原因 ──────────────────────────────────────
//
// 线上那次：三条都「失败」，点开只看得到它停下前那句「我再核对一下」，原因被那句话顶掉了。
{
  const r = await ctx.tools.execute({
    callId: 'c-5',
    name: 'delegate_task',
    sessionId,
    arguments: JSON.stringify({
      tasks: [
        { goal: '进度那条', context: '进度探针', model_reason: '要判断', model_role: 'daily' },
        { goal: '报错那条', context: '报错探针', model_reason: '要判断', model_role: 'daily' },
      ],
    }),
  })
  const evs = (await ctx.sessions.events(sessionId)).filter((e) => e.type === 'agent/task' && e.data.callId === 'c-5')
  const ofGoal = (g) => evs.filter((e) => e.data.goal === g).map((e) => e.data)
  const ok = ofGoal('进度那条')
  const bad = ofGoal('报错那条')
  const okLast = ok[ok.length - 1]
  const badLast = bad[bad.length - 1]
  const mid = ok.find((d) => d.state === 'running' && d.progress)
  out.progress = {
    跑着时报了进度: Boolean(mid) && mid.progress.tool?.name === 'fake_probe',
    进度带关键参数: mid?.progress.tool?.detail === 'https://example.com/a',
    进度数了步数: mid?.progress.steps === 1,
    终态排在最后: okLast?.state === 'done' && badLast?.state === 'failed',
    带开跑时刻: typeof okLast?.startedAt === 'number' && okLast.startedAt === ok[0].startedAt,
  }
  out.failure = {
    原因单独记了: String(badLast?.error || '').includes('upstream 529'),
    结论还是它最后那句: badLast?.summary === '我再核对一下',
    原因进了给模型的文本: r.text.includes('失败原因：') && r.text.includes('upstream 529'),
    做成的那条没有原因: !okLast?.error,
  }
}

// ── 重启后没有永远转着的卡 ────────────────────────────────────────
await ctx.sessions.append(sessionId, 'agent/task', {
  id: 'orphan',
  callId: 'c-old',
  child: 't-gone',
  index: 0,
  goal: '上个进程留下的',
  state: 'running',
  at: Date.now(),
})
await ctx.agents.healTasks()
const healed = [...(await ctx.sessions.events(sessionId))].reverse().find(
  (e) => e.type === 'agent/task' && e.data.id === 'orphan',
)
out.heal = {
  补成了lost: healed?.data.state === 'lost',
  // 写成 failed 是在编：那件事做没做成，进程死的时候没人知道。
  不是failed: healed?.data.state !== 'failed',
}

console.log('__RESULT__' + JSON.stringify(out))
process.exit(0)
