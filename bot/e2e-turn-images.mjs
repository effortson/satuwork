/**
 * 当前这一轮发的图，模型这一轮就得看见。
 *
 * 这条路**不走历史重建**：runTurn 里的 `history` 是 append 用户消息之前取的快照，
 * 所以这一轮的消息是靠 `agent.prompt()` 单独送进去的。只传文本的话，图要等到下一轮
 * 才随历史进上下文——表现成「问第一遍它没看见，再问一句就看见了」。
 *
 * 断言的落点是 `llm.streamFn` 收到的 context：那是真正要发给模型的东西，比检查我们
 * 自己拼的中间结构可信得多。
 */
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import * as storagePlugin from './src/storage/index.ts'
import * as sessionsPlugin from './src/session/index.ts'
import * as workspacePlugin from './src/workspace/index.ts'
import * as toolsPlugin from './src/tools/index.ts'
import * as llmPlugin from './src/llm/index.ts'
import * as agentPlugin from './src/agent/index.ts'
import { AssistantMessageEventStream, emptyAssistant } from './src/llm/stream.ts'
import { tempDir } from './e2e-lib.mjs'

const home = tempDir('satu-turn-')
const work = tempDir('satu-turn-work-')

/** agent 只用到 servers / toolNamesFor，起真的目录服务要连 Gateway，不值当。 */
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

const ctx = new Context()
ctx.plugin(storagePlugin, { path: join(home, 'db.sqlite') })
ctx.plugin(sessionsPlugin, { root: join(home, 'sessions') })
ctx.plugin(workspacePlugin, { root: work })
ctx.plugin(toolsPlugin)
ctx.plugin(FakeCatalog)
ctx.plugin(llmPlugin)
ctx.plugin(agentPlugin)
await new Promise((r) => setTimeout(r, 300))

/** 捕获真正送进模型的那份 context，然后立刻把这一轮收口。 */
let captured = null
ctx.llm.streamFn = (model, context) => {
  captured = context
  const stream = new AssistantMessageEventStream()
  queueMicrotask(() => {
    stream.push({ type: 'error', reason: 'error', error: emptyAssistant(model, '探针不跑模型') })
    stream.end()
  })
  return stream
}

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001',
  'hex',
)
const saved = await ctx.workspace.saveUpload('probe', 'shot.png', new ReadableStream({
  start(c) {
    c.enqueue(PNG)
    c.close()
  },
}))

const sessionId = await ctx.sessions.create({ title: '探针', botId: 'default' })

/**
 * 内容块数组。
 *
 * pi 的 normalizePromptInput 会把字符串 prompt 也包成 `[{type:'text'}]`，所以「是不是
 * 字符串」不是个有效判据——只能看块的类型。
 */
function blocksOf(m) {
  if (!m) return []
  return typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content ?? [])
}

function lastUserBlocks() {
  const users = (captured?.messages ?? []).filter((m) => m.role === 'user')
  const last = users[users.length - 1]
  if (!last) return { 有没有用户消息: false }
  const content = blocksOf(last)
  return {
    有图: content.some((c) => c.type === 'image'),
    图带了字节: content.some((c) => c.type === 'image' && typeof c.data === 'string' && c.data.length > 0),
    正文还在: content.some((c) => c.type === 'text' && c.text.includes('这是什么')),
    盖了时间戳: content.some((c) => c.type === 'text' && /^\[/.test(c.text)),
  }
}

const out = {}

// ── 1. 第一轮就带图：模型这一轮就该看见 ───────────────────────────────
captured = null
await ctx.agents.send(sessionId, '这是什么', [{ path: saved.path, mime: 'image/png' }]).catch(() => {})
out.firstTurn = lastUserBlocks()
out.firstTurn.用户消息条数 = (captured?.messages ?? []).filter((m) => m.role === 'user').length

// ── 2. 下一轮：历史里那条也还在，图没有丢 ─────────────────────────────
captured = null
await ctx.agents.send(sessionId, '你看到图了吗').catch(() => {})
{
  const users = (captured?.messages ?? []).filter((m) => m.role === 'user')
  const withImage = users.filter((m) => blocksOf(m).some((c) => c.type === 'image'))
  out.nextTurn = {
    用户消息条数: users.length,
    带图的条数: withImage.length,
    // 这一轮的新消息本身没有图，图应该只挂在上一条上。
    最后一条没有图: !blocksOf(users[users.length - 1]).some((c) => c.type === 'image'),
  }
}

// ── 3. 不带图的一轮：不该多出图片块 ───────────────────────────────────
captured = null
const plainId = await ctx.sessions.create({ title: '纯文本', botId: 'default' })
await ctx.agents.send(plainId, '只有文字').catch(() => {})
{
  const users = (captured?.messages ?? []).filter((m) => m.role === 'user')
  const blocks = blocksOf(users[users.length - 1])
  out.plain = {
    没有图: !blocks.some((c) => c.type === 'image'),
    只有文本块: blocks.length > 0 && blocks.every((c) => c.type === 'text'),
    正文在: blocks.some((c) => c.type === 'text' && c.text.includes('只有文字')),
  }
}

console.log('__RESULT__' + JSON.stringify(out))
process.exit(0)
