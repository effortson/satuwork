/**
 * 原地打转：同一个调用连着撞同一句报错，这一轮当场停，不等步数硬顶。
 *
 * 本地实测过一次：模型调 skill_manage 不带 name，工具回「缺少 name」，它原样再调，一轮
 * 撞了 50 多次——每一步都带着整份上下文按输入计费。步数硬顶（120）管的是「活儿太长」，
 * 管不住这个。判据在 agent/repeat-guard.ts。
 *
 * 走真的 AgentService（同 e2e-turn-recall.mjs），假模型每一步都调一把注定失败的工具：
 *   - 同一个参数 → 同一句报错 → 第 4 步停，留一句说清撞的是什么；
 *   - 每次换一个参数 → 报错每次不同 → 不算打转，照常跑到步数硬顶。
 */
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import * as storagePlugin from './src/storage/index.ts'
import * as sessionsPlugin from './src/session/index.ts'
import * as workspacePlugin from './src/workspace/index.ts'
import * as toolsPlugin from './src/tools/index.ts'
import * as llmPlugin from './src/llm/index.ts'
import * as agentPlugin from './src/agent/index.ts'
import { failureStreak } from './src/agent/repeat-guard.ts'
import { fail, registerTool } from './src/tools/common.ts'
import { AssistantMessageEventStream, emptyAssistant } from './src/llm/stream.ts'
import { tempDir } from './e2e-lib.mjs'

const home = tempDir('satu-loop-')
const work = tempDir('satu-loop-work-')

class FakeCatalog extends Service {
  constructor(ctx) {
    super(ctx, 'catalog')
  }

  get servers() {
    return []
  }
  toolNamesFor() {
    return []
  }
}

const MAX_STEPS = 8
const ctx = new Context()
ctx.plugin(storagePlugin, { path: join(home, 'db.sqlite') })
ctx.plugin(sessionsPlugin, { root: join(home, 'sessions') })
ctx.plugin(workspacePlugin, { root: work })
ctx.plugin(toolsPlugin)
ctx.plugin(FakeCatalog)
ctx.plugin(llmPlugin)
ctx.plugin(agentPlugin, { maxSteps: MAX_STEPS })
await new Promise((r) => setTimeout(r, 300))

/** 注定失败的工具，报错原文带着参数：参数不变，报错就不变。 */
registerTool(
  ctx,
  {
    name: 'probe_open',
    description: '探针用：打开一个永远不存在的东西',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    risk: ['read'],
    delegation: {},
  },
  ({ path }) => fail(`找不到 ${path}`),
)

/** 每一步都要一次 probe_open；`pathOf(n)` 决定第 n 步开哪个。 */
let pathOf = () => '没有这个文件.txt'
let calls = 0
ctx.llm.streamFn = (model) => {
  const n = ++calls
  const stream = new AssistantMessageEventStream()
  const partial = emptyAssistant(model)
  queueMicrotask(() => {
    stream.push({ type: 'start', partial })
    partial.content.push({ type: 'toolCall', id: `c${n}`, name: 'probe_open', arguments: { path: pathOf(n) } })
    stream.push({ type: 'toolcall_start', contentIndex: 0, partial })
    stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: partial.content[0], partial })
    partial.stopReason = 'toolUse'
    stream.push({ type: 'done', reason: 'toolUse', message: partial })
  })
  return stream
}

async function run(title, text) {
  calls = 0
  const id = await ctx.sessions.create({ title, botId: 'default' })
  await Promise.race([
    ctx.agents.send(id, text).catch(() => {}),
    new Promise((_, reject) => setTimeout(() => reject(new Error('一轮没能在 20 秒内收口')), 20_000)),
  ])
  const events = await ctx.sessions.events(id)
  const results = events.filter((e) => e.type === 'tool/result')
  const said = events.filter((e) => e.type === 'assistant/message' && e.data.step === 0)
  return {
    toolResults: results.length,
    // 业务拒绝不置 failed（那一位是管道故障的语义），这里看的是报错原文。
    allRefused: results.every((e) => String(e.data.text).startsWith('找不到 ')),
    reason: events.filter((e) => e.type === 'turn/end').at(-1)?.data.reason,
    closing: said.map((e) => e.data.message.content.map((c) => c.text ?? '').join('')).join('\n'),
  }
}

const out = {}
pathOf = () => '没有这个文件.txt'
out.same = await run('打转', '读一下那个文件')
pathOf = (n) => `没有这个文件-${n}.txt`
out.varied = await run('换着试', '读一下那几个文件')

/** 状态机本身：中间成功一步、或者报错换了，都从头数。 */
const bad = (text, toolName = 'skill_manage') => ({ toolName, isError: false, details: { refused: true }, content: [{ type: 'text', text }] })
const ok = { toolName: 'skill_manage', isError: false, content: [{ type: 'text', text: '已保存' }] }
/** 管道层失败（pi 的 isError）同样算。 */
const broken = (text) => ({ toolName: 'terminal', isError: true, content: [{ type: 'text', text }] })
{
  const s = failureStreak(3)
  out.unit = {
    third: [s.see([bad('缺少 name')]), s.see([bad('缺少 name')]), s.see([bad('缺少 name')])],
  }
  const r = failureStreak(3)
  out.unit.resetByOk = [r.see([bad('缺少 name')]), r.see([bad('缺少 name')]), r.see([ok]), r.see([bad('缺少 name')])]
  const c = failureStreak(3)
  out.unit.changed = [c.see([bad('缺少 name')]), c.see([bad('缺少 body')]), c.see([bad('缺少 name')])]
  // 一步里有成功也有失败：不算打转（它在推进）。
  const m = failureStreak(2)
  out.unit.mixed = [m.see([bad('缺少 name'), ok]), m.see([bad('缺少 name'), ok])]
  const pipe = failureStreak(2)
  out.unit.pipe = [pipe.see([broken('超时')]), pipe.see([broken('超时')])]
  const off = failureStreak(0)
  out.unit.off = [off.see([bad('x')]), off.see([bad('x')]), off.see([bad('x')])]
  out.unit.meta = { count: s.count, tool: s.tool, error: s.error }
}

console.log('__RESULT__' + JSON.stringify(out))
process.exit(0)
