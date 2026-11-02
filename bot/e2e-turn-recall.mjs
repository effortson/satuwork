/**
 * 补捞的记忆：这一轮送进模型的那份，和下一轮从日志重建的那份必须一字不差。
 *
 * 补捞拼在**用户消息末尾**，不进系统提示词——系统提示词是整条会话的前缀，每轮按这句话
 * 换一次，前缀缓存就整段作废。代价是它得跟着那条消息落进日志（`user/message.recall`），
 * 下一轮重建历史时原样拼回去；两边差一个换行，前缀缓存就从这条消息断开，而且不报任何错。
 *
 * 断言落在 `llm.streamFn` 收到的 context 上（同 e2e-turn-images.mjs）。
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

const home = tempDir('satu-recall-')
const work = tempDir('satu-recall-work-')

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

let captured = null
/** 收口前先等多久。测插话时要让这一轮多活一会儿，插话才够得着它。 */
let holdMs = 0
ctx.llm.streamFn = (model, context) => {
  captured = context
  const stream = new AssistantMessageEventStream()
  setTimeout(() => {
    stream.push({ type: 'error', reason: 'error', error: emptyAssistant(model, '探针不跑模型') })
    stream.end()
  }, holdMs)
  return stream
}

/**
 * 出厂策略注入上限 20：塞 20 条更新的，再塞一条最老的「Uclub」——它一定被挤在系统提示词外面。
 */
const col = ctx.storage.collection('memories')
const row = (id, text, updatedAt) => ({
  id, layer: 'bot', kind: '事实', text, by: 'agent', pii: [], pinned: false, expiresAt: null, createdAt: updatedAt, updatedAt,
})
for (let i = 0; i < 20; i++) col.put(`n${i}`, row(`n${i}`, `新近的第 ${i} 条笔记`, 2_000_000 + i))
col.put('old', row('old', 'Uclub 的发票抄送 enxi.liu@uclubgroup.com.sg', 1_000))

const text = (m) =>
  typeof m?.content === 'string' ? m.content : (m?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
const users = () => (captured?.messages ?? []).filter((m) => m.role === 'user')

const sessionId = await ctx.sessions.create({ title: '探针', botId: 'default' })
const out = {}

captured = null
await ctx.agents.send(sessionId, '给 Uclub 回封邮件').catch(() => {})
const live = users().at(-1)
out.first = {
  system: String(captured?.systemPrompt ?? ''),
  user: text(live),
}

captured = null
await ctx.agents.send(sessionId, '天气怎么样').catch(() => {})
const rebuilt = users().at(-2)
out.next = {
  rebuilt: text(rebuilt),
  // 比文字，不比形状：pi 会把这一轮的字符串 prompt 包成 `[{type:'text'}]`，重建出来的是
  // 字符串——这在补捞之前就是这样（同 e2e-turn-images 的 blocksOf），发给供应商时是同一份。
  sameAsLive: text(rebuilt) === text(live),
  user: text(users().at(-1)),
}
out.logged = (await ctx.sessions.events(sessionId)).filter((e) => e.type === 'user/message').map((e) => e.data.recall ?? null)

// ── 人把那条记忆删了：下一轮重建时，旧消息上那段补捞也该一起去掉 ──────────
col.delete('old')
captured = null
await ctx.agents.send(sessionId, '好的').catch(() => {})
out.afterDelete = text(users().find((m) => text(m).includes('给 Uclub 回封邮件')))

// ── 跑到一半插进来的话也补捞，并且同样落进日志 ─────────────────────────
col.put('old', row('old', 'Uclub 的发票抄送 enxi.liu@uclubgroup.com.sg', 1_000))
const steerId = await ctx.sessions.create({ title: '插话', botId: 'default' })
holdMs = 400
const running = ctx.agents.send(steerId, '先帮我起草个大纲').catch(() => {})
let steered = false
for (let i = 0; i < 50 && !steered; i++) {
  await new Promise((r) => setTimeout(r, 20))
  steered = await ctx.agents.steer(steerId, '顺便抄送 Uclub 那边')
}
await running
holdMs = 0
out.steer = {
  steered,
  logged: (await ctx.sessions.events(steerId)).filter((e) => e.type === 'user/message').map((e) => e.data.recall?.map((r) => r.id) ?? null),
}

console.log('__RESULT__' + JSON.stringify(out))
process.exit(0)
