import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import * as storagePlugin from './src/storage/index.ts'
import * as sessionsPlugin from './src/session/index.ts'
import * as workspacePlugin from './src/workspace/index.ts'
import * as toolsPlugin from './src/tools/index.ts'
import * as llmPlugin from './src/llm/index.ts'
import * as agentPlugin from './src/agent/index.ts'
import { replyLanguageBlock, replyLocaleOf } from './src/agent/reply-language.ts'
import { AssistantMessageEventStream, emptyAssistant } from './src/llm/stream.ts'
import { tempDir } from './e2e-lib.mjs'
import { apply as webRoutes } from './src/web/index.ts'

class FakeCatalog extends Service {
  constructor(ctx) {
    super(ctx, 'catalog')
    this.models = {}
  }
  get servers() { return [] }
  toolNamesFor() { return [] }
}

const home = tempDir('satu-reply-language-')
const ctx = new Context()
ctx.plugin(storagePlugin, { path: join(home, 'db.sqlite') })
ctx.plugin(sessionsPlugin, { root: join(home, 'sessions') })
ctx.plugin(workspacePlugin, { root: join(home, 'work') })
ctx.plugin(toolsPlugin)
ctx.plugin(FakeCatalog)
ctx.plugin(llmPlugin)
ctx.plugin(agentPlugin, { provider: 'probe', model: 'reply-language' })
await new Promise(resolve => setTimeout(resolve, 300))
assert(ctx.agents, 'agent service did not start')
ctx.llm.catalog = () => [{ provider: 'probe', models: [{ id: 'reply-language', contextWindow: 200000 }] }]

const prompts = []
ctx.llm.streamFn = (model, context) => {
  prompts.push(context.systemPrompt)
  const stream = new AssistantMessageEventStream()
  queueMicrotask(() => {
    const message = emptyAssistant(model)
    message.content = [{ type: 'text', text: 'probe reply' }]
    message.stopReason = 'stop'
    stream.push({ type: 'start', partial: message })
    stream.push({ type: 'done', reason: 'stop', message })
    stream.end()
  })
  return stream
}

// An existing bot still has the old Chinese-only persona; no data migration is required.
ctx.storage.collection('bots').put('legacy', {
  id: 'legacy', name: 'Designer', provider: 'probe', model: 'reply-language',
  prompt: '你是 Satuwork 的 AI 员工。用简洁、专业的中文回答。',
})
const session = await ctx.sessions.create({ title: 'Reply language', botId: 'legacy' })
async function send(source, text = 'hello') {
  const before = prompts.length
  await ctx.agents.send(session, text, [], [], source)
  assert.equal(prompts.length, before + 1, 'the message must reach the model')
  return prompts.at(-1)
}

assert.match(await send({ kind: 'user', locale: 'en' }), /Reply in English by default/)
assert.match(prompts.at(-1), /takes precedence over language defaults in the bot persona/)
assert.match(prompts.at(-1), /If the user explicitly requests another language or a translation, follow that request/)
assert.equal((await ctx.sessions.events(session)).find(e => e.type === 'user/message').data.source.locale, 'en')
assert.match(await send({ kind: 'user', locale: 'zh' }), /Reply in Simplified Chinese by default/)
assert.match(await send({ kind: 'user', locale: 'en' }), /Reply in English by default/)

// Queue rows must retain the locale, including across the storage round-trip.
const queued = ctx.agents.enqueue(session, 'hello from the queue', [], [], [], { kind: 'user', locale: 'zh' })
assert.equal(ctx.storage.collection('message-queue').get(queued.id).source.locale, 'zh')
await ctx.agents.send(session, 'hello before the queued message', [], [], { kind: 'user', locale: 'en' })
assert.match(prompts.at(-2), /Reply in English by default/)
assert.match(prompts.at(-1), /Reply in Simplified Chinese by default/)
assert.equal(ctx.agents.queued(session).length, 0)

// Continuations inherit only this session's latest preference, not a process-wide setting.
assert.match(await send({ kind: 'plugin', plugin: 'handoff' }), /Reply in Simplified Chinese by default/)
const other = await ctx.sessions.create({ title: 'Other user', botId: 'legacy' })
await ctx.agents.send(other, 'hello', [], [], { kind: 'user', locale: 'en' })
assert.match(prompts.at(-1), /Reply in English by default/)
assert.match(await send({ kind: 'plugin', plugin: 'handoff' }), /Reply in Simplified Chinese by default/)

assert.equal(replyLocaleOf({ kind: 'user', locale: 'invalid' }, []), undefined)
assert.match(replyLanguageBlock(), /reply in the language of the user’s message/)

// Exercise the real request parser: only supported locale values may enter message metadata.
const routes = new Map()
const server = { baseUrl: 'probe' }
for (const method of ['get', 'post', 'put', 'delete', 'all']) {
  server[method] = (path, handler) => routes.set(method + ' ' + path, handler)
}
const sources = []
webRoutes({
  server, storage: ctx.storage, on: () => () => {},
  agents: {
    quiesced: () => false, isRunning: () => false, runningTask: () => false,
    send: async (...args) => { sources.push(args[4]) },
  },
})
for (const locale of ['en', 'zh', 'invalid', undefined]) {
  await routes.get('post /api/sessions/:id/messages')(
    { params: { id: session }, json: async () => ({ text: 'hello', locale }) },
    { json: result => assert.equal(result.accepted, true) },
  )
}
assert.deepEqual(sources, [{ kind: 'user', locale: 'en' }, { kind: 'user', locale: 'zh' }, { kind: 'user' }, { kind: 'user' }])
console.log('__RESULT__' + JSON.stringify({ passed: true, modelCalls: prompts.length }))
process.exit(0)
