/**
 * 会话级的日常模型选择（见 docs/model-choice.md）。
 *
 * 这一层坏了多半**不报错**：选择器上写着 A，每一轮照样跑成、照样出话，只是进模型的是 B
 * ——要发现它，得有人去翻账单或者对比回答的风格。所以钉的全是「真正送进模型的是哪个」：
 *
 *   1. 名单：默认（Bot 自己那一对）排第一，后面是平台备选，和默认重复的不出现；
 *   2. 挑了备选，下一轮送进模型的就是它，推理强度用备选自己的那一档；
 *   3. 名单外的 key 拒掉，挑选原样不动——这条路浏览器也走得通，收任意值就是白名单的后门；
 *   4. 跑着的时候也能挑：这一轮不变，下一轮才换，并且如实回 nextTurn；
 *   5. 定时任务选 daily（「和聊天时一样」）跟着会话的挑选走，选 utility 的不受影响；
 *   6. 挑的那个被下架：下一轮退回默认，会话里补一条 reason: removed 的事件；
 *      目录还没拉到时不判下架（否则席位每次重启都会把人的选择冲掉）；
 *   7. 渠道里 `/model` 的解析：序号、default、key、模型 id；认不出来不猜。
 *
 * 探针要 tsx 才 import 得了 .ts，所以由 e2e/model-choice.mjs 另起一个进程跑。
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
import { channelModelCommand, channelModelHelp, pickModelArg } from './src/web/channel.ts'
import { AssistantMessageEventStream, emptyAssistant } from './src/llm/stream.ts'

const home = mkdtempSync(join(tmpdir(), 'satu-mchoice-'))
const work = mkdtempSync(join(tmpdir(), 'satu-mchoice-work-'))
process.on('exit', () => { try { rmSync(home, { recursive: true, force: true }) } catch {} try { rmSync(work, { recursive: true, force: true }) } catch {} })

/** 假目录：两个角色、两个备选（其中一个和默认重复，名单里不该出现第二次）。 */
class FakeCatalog extends Service {
  constructor(ctx) {
    super(ctx, 'catalog')
    this.pulledAt = Date.now()
    this.models = {
      daily: { provider: 'p-bot', model: 'm-bot', reasoningEffort: 'low' },
      utility: { provider: 'p-util', model: 'm-util', reasoningEffort: 'off' },
      dailyAlternates: [
        { provider: 'p-alt', model: 'm-alt', reasoningEffort: 'high' },
        { provider: 'p-bot', model: 'm-bot', reasoningEffort: 'low' },
        { provider: 'p-two', model: 'vendor/m-two', reasoningEffort: 'off' },
      ],
    }
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
// Bot 自己那一对 = 默认。
ctx.plugin(agentPlugin, { provider: 'p-bot', model: 'm-bot' })
await new Promise((r) => setTimeout(r, 300))

ctx.llm.catalog = () => [
  { provider: 'p-bot', models: [{ id: 'm-bot', name: 'Bot 默认', contextWindow: 200000 }] },
  { provider: 'p-alt', models: [{ id: 'm-alt', name: 'Alt 大模型', contextWindow: 200000, reasoning: true }] },
  { provider: 'p-two', models: [{ id: 'vendor/m-two', name: 'Two', contextWindow: 100000 }] },
  { provider: 'p-util', models: [{ id: 'm-util', contextWindow: 200000 }] },
]

/**
 * 捕获送进模型的每一次。`gate` 给「跑着的时候挑」那一条用：挂着它，这一轮就一直算在跑。
 */
let calls = []
let gate = null
ctx.llm.streamFn = (model, _context, options) => {
  calls.push({ provider: model.provider, model: model.id, reasoning: options?.reasoning || 'off' })
  const stream = new AssistantMessageEventStream()
  const finish = () => {
    stream.push({ type: 'error', reason: 'error', error: emptyAssistant(model, '探针不跑模型') })
    stream.end()
  }
  if (gate) gate.then(finish)
  else queueMicrotask(finish)
  return stream
}

const sessionId = await ctx.sessions.create({ title: '探针', botId: 'default' })

async function turnWith(modelRole, text = '你好') {
  calls = []
  await ctx.agents.send(sessionId, text, [], [], { kind: 'user' }, modelRole).catch(() => {})
  return calls[calls.length - 1] ?? null
}

const stateNow = async () => ctx.agents.sessionModelState(await ctx.sessions.events(sessionId))
const modelEvents = async () => (await ctx.sessions.events(sessionId)).filter((e) => e.type === 'session/model')

const out = {}

// ── 1. 名单
const first = await stateNow()
out.options = {
  默认排第一: first.options[0]?.key === 'p-bot/m-bot' && first.options[0]?.isDefault === true,
  备选跟在后面: first.options[1]?.key === 'p-alt/m-alt' && first.options[2]?.key === 'p-two/vendor/m-two',
  和默认重复的不出现: first.options.filter((c) => c.key === 'p-bot/m-bot').length === 1,
  显示名来自目录: first.options[1]?.label === 'Alt 大模型',
  没挑过就是默认: first.picked === null && first.effective.key === 'p-bot/m-bot',
}
const before = await turnWith(undefined)
out.options.没挑过按默认跑 = before?.provider === 'p-bot' && before?.model === 'm-bot'

// ── 2. 挑备选
const set = await ctx.agents.setSessionModel(sessionId, 'p-alt/m-alt')
const alt = await turnWith(undefined)
const ev = (await modelEvents()).at(-1)
out.pick = {
  回的是新的: set.changed === true && set.picked === 'p-alt/m-alt' && set.effective.key === 'p-alt/m-alt',
  没在跑就不是下一轮: set.nextTurn === false,
  下一轮真用上了: alt?.provider === 'p-alt' && alt?.model === 'm-alt',
  推理强度用备选自己的: alt?.reasoning === 'high',
  事件带显示名: ev?.data?.key === 'p-alt/m-alt' && ev?.data?.label === 'Alt 大模型' && ev?.data?.by === 'user',
  // model id 里带斜杠：key 按第一个斜杠切，provider 名里没有斜杠。
  带斜杠的模型也认: (await ctx.agents.setSessionModel(sessionId, 'p-two/vendor/m-two')).effective.model === 'vendor/m-two',
}
const two = await turnWith(undefined)
out.pick.带斜杠的模型真用上了 = two?.provider === 'p-two' && two?.model === 'vendor/m-two'
const same = await ctx.agents.setSessionModel(sessionId, 'p-two/vendor/m-two')
out.pick.挑同一个不写事件 = same.changed === false && (await modelEvents()).length === 2

// ── 3. 名单外的拒掉
let rejected = null
try {
  await ctx.agents.setSessionModel(sessionId, 'p-evil/m-evil')
} catch (e) {
  rejected = e
}
out.reject = {
  回400: rejected?.status === 400,
  原话列出能选的: /Alt 大模型/.test(rejected?.message || ''),
  挑选没动: (await stateNow()).picked === 'p-two/vendor/m-two',
}

// ── 4. 跑着的时候挑
let release
gate = new Promise((r) => { release = r })
calls = []
const running = ctx.agents.send(sessionId, '慢慢来', [], [], { kind: 'user' }).catch(() => {})
// 等到模型真的被调起来：光看 isRunning 的话，那一刻这一轮可能还在组请求。
for (let i = 0; i < 100 && !calls.length; i++) await new Promise((r) => setTimeout(r, 20))
const mid = await ctx.agents.setSessionModel(sessionId, 'p-alt/m-alt')
const duringCall = calls[0]
release()
gate = null
await running
const afterRun = await turnWith(undefined)
out.running = {
  跑着也收: mid.changed === true,
  如实说下一轮生效: mid.nextTurn === true,
  这一轮没被换掉: duringCall?.model === 'vendor/m-two',
  下一轮换上了: afterRun?.model === 'm-alt',
}

// ── 5. 定时任务：daily 跟会话的挑选，utility 不受影响
const routineDaily = await turnWith('daily', '到点了')
const routineUtil = await turnWith('utility', '到点了')
out.routine = {
  daily跟着会话的挑选: routineDaily?.model === 'm-alt',
  utility不受影响: routineUtil?.provider === 'p-util' && routineUtil?.model === 'm-util',
}

// ── 6. 下架
const kept = ctx.catalog.models.dailyAlternates
ctx.catalog.models.dailyAlternates = [{ provider: 'p-two', model: 'vendor/m-two', reasoningEffort: 'off' }]
const peek = await stateNow()
const eventsBefore = (await modelEvents()).length
const fallback = await turnWith(undefined)
const removedEv = (await modelEvents()).at(-1)
const afterRemove = await stateNow()
out.removed = {
  读状态时如实说下架了: peek.removed === true && peek.effective.key === 'p-bot/m-bot',
  读状态不写日志: eventsBefore === (await modelEvents()).length - 1,
  下一轮退回默认: fallback?.provider === 'p-bot' && fallback?.model === 'm-bot',
  补了一条事件: removedEv?.data?.key === null && removedEv?.data?.reason === 'removed' && removedEv?.data?.from === 'p-alt/m-alt',
  之后就是默认: afterRemove.picked === null && afterRemove.removed === false,
}

// 目录没拉到（重启后头一轮）：名单是空的，但挑选照信，不判下架。
ctx.catalog.models.dailyAlternates = kept
await ctx.agents.setSessionModel(sessionId, 'p-alt/m-alt')
ctx.catalog.pulledAt = null
ctx.catalog.models.dailyAlternates = []
const cold = await turnWith(undefined)
out.cold = {
  照信挑选: cold?.model === 'm-alt',
  没退回默认: (await stateNow()).picked === 'p-alt/m-alt',
}
ctx.catalog.pulledAt = Date.now()
ctx.catalog.models.dailyAlternates = kept

// null = 回默认
const back = await ctx.agents.setSessionModel(sessionId, null)
const homeTurn = await turnWith(undefined)
out.reset = {
  回默认: back.changed === true && back.picked === null,
  下一轮用默认: homeTurn?.model === 'm-bot',
  挑默认那一项也是回默认: (await ctx.agents.setSessionModel(sessionId, 'p-bot/m-bot')).changed === false,
}

// 没有这条会话：404，不是一个普通错误（那会被路由当成 500，界面每半分钟重试一次）。
let missing = null
try {
  await ctx.agents.setSessionModel('no-such-session', null)
} catch (e) {
  missing = e
}
let missingGet = null
try {
  await ctx.agents.sessionHistoryOr404('no-such-session')
} catch (e) {
  missingGet = e
}
out.reset.未知会话是404 = missing?.status === 404 && missingGet?.status === 404

// ── 7. 渠道命令
const opts = (await stateNow()).options
out.channel = {
  认出model: channelModelCommand('/model')?.arg === '' && channelModelCommand('/model@satu_bot 2')?.arg === '2',
  别的命令不是它: channelModelCommand('/models') === null && channelModelCommand('/new') === null,
  序号: pickModelArg('2', opts)?.key === 'p-alt/m-alt',
  默认: pickModelArg('default', opts)?.isDefault === true && pickModelArg('默认', opts)?.isDefault === true,
  key和id: pickModelArg('p-two/vendor/m-two', opts)?.model === 'vendor/m-two' && pickModelArg('m-alt', opts)?.key === 'p-alt/m-alt',
  显示名: pickModelArg('alt 大模型', opts)?.key === 'p-alt/m-alt',
  认不出来不猜: pickModelArg('alt', opts) === null && pickModelArg('9', opts) === null,
  清单标出当前: /Bot 默认（默认） `p-bot\/m-bot` ← 当前/.test(channelModelHelp({ effective: opts[0], options: opts })),
}

console.log('__RESULT__' + JSON.stringify(out))
process.exit(0)
