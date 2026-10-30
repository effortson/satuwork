/**
 * 图片一路走到 provider 请求体里。探针要 tsx 才 import 得了 .ts。
 *
 * 这条链上有**三处**会把用户消息拍成字符串（bot 的 toOpenAI / toAnthropic，Gateway 的
 * v1）。任何一处漏了，图都会安静地消失：不报错、不告警，模型只是看不见它，然后一本
 * 正经地答一个跟图无关的答案。所以三处各钉一遍。
 */
import { Context } from '@deepseek-ai/cordis'
import { toAnthropic, toOpenAI } from './src/llm/gateway.ts'
import { userContent as gatewayUserContent } from '../gateway/src/v1.ts'
import { WorkspaceService } from './src/workspace/index.ts'
import { toAgentMessages } from './src/agent/index.ts'
import { SESSION_FORMAT_VERSION } from './src/session/types.ts'
import { tempDir } from './e2e-lib.mjs'

const out = {}
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001',
  'hex',
)
const B64 = PNG.toString('base64')

// ── 1. bot → OpenAI：data URI ─────────────────────────────────────────
{
  const ctx = {
    messages: [{ role: 'user', content: [{ type: 'image', data: B64, mimeType: 'image/png' }, { type: 'text', text: '这是什么' }] }],
  }
  const body = toOpenAI(ctx, { provider: 'p', id: 'm' })
  const parts = body.messages[0].content
  out.openai = {
    是数组: Array.isArray(parts),
    有图: Array.isArray(parts) && parts.some((c) => c.type === 'image_url'),
    是dataURI: Array.isArray(parts) && String(parts.find((c) => c.type === 'image_url')?.image_url?.url ?? '').startsWith('data:image/png;base64,'),
    带上了字节: Array.isArray(parts) && String(parts.find((c) => c.type === 'image_url')?.image_url?.url ?? '').includes(B64),
    正文还在: Array.isArray(parts) && parts.some((c) => c.type === 'text' && c.text === '这是什么'),
  }
}

// 没有图的消息仍然是字符串——绝大多数消息走这条，不该被这次改动带胖。
{
  const body = toOpenAI({ messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }] }, { provider: 'p', id: 'm' })
  out.openaiPlain = { 还是字符串: typeof body.messages[0].content === 'string', 值: body.messages[0].content }
}

// ── 2. bot → Anthropic：source 对象，不认 data URI ────────────────────
{
  const ctx = {
    messages: [{ role: 'user', content: [{ type: 'image', data: B64, mimeType: 'image/png' }, { type: 'text', text: '这是什么' }] }],
  }
  const body = toAnthropic(ctx, { id: 'm' })
  const parts = body.messages[0].content
  const img = Array.isArray(parts) ? parts.find((c) => c.type === 'image') : null
  out.anthropic = {
    是数组: Array.isArray(parts),
    有图: Boolean(img),
    用source: img?.source?.type === 'base64',
    媒体类型对: img?.source?.media_type === 'image/png',
    带上了字节: img?.source?.data === B64,
    正文还在: Array.isArray(parts) && parts.some((c) => c.type === 'text' && c.text === '这是什么'),
  }
}

{
  const body = toAnthropic({ messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }] }, { id: 'm' })
  out.anthropicPlain = { 还是字符串: typeof body.messages[0].content === 'string' }
}

// 同一层还负责把 Agent 的通用推理档位翻成两种上游协议。
{
  const ctx = { messages: [{ role: 'user', content: '想一想' }] }
  const openai = toOpenAI(ctx, { provider: 'p', id: 'm' }, { reasoning: 'high' })
  const openaiOff = toOpenAI(ctx, { provider: 'p', id: 'm' }, { reasoning: 'off' })
  const anthropic = toAnthropic(ctx, { id: 'm', maxTokens: 10000 }, { reasoning: 'medium' })
  const anthropicOff = toAnthropic(ctx, { id: 'm', maxTokens: 10000 }, { reasoning: 'off' })
  out.reasoningTransport = {
    openai档位: openai.reasoning_effort === 'high',
    openai关闭时不发送: !('reasoning_effort' in openaiOff),
    anthropic档位: anthropic.thinking?.type === 'enabled' && anthropic.thinking?.budget_tokens === 8192,
    anthropic给正文留空间: anthropic.max_tokens === 10000 && anthropic.thinking.budget_tokens < anthropic.max_tokens,
    anthropic关闭时不发送: !('thinking' in anthropicOff),
  }
}

// ── 3. Gateway 的 /v1：最容易漏的那一层 ───────────────────────────────
{
  const parts = gatewayUserContent([
    { type: 'image_url', image_url: { url: `data:image/png;base64,${B64}` } },
    { type: 'text', text: '这是什么' },
  ])
  out.gatewayV1 = {
    是数组: Array.isArray(parts),
    有图: Array.isArray(parts) && parts.some((c) => c.type === 'image'),
    媒体类型对: Array.isArray(parts) && parts.find((c) => c.type === 'image')?.mimeType === 'image/png',
    带上了字节: Array.isArray(parts) && parts.find((c) => c.type === 'image')?.data === B64,
    正文还在: Array.isArray(parts) && parts.some((c) => c.type === 'text' && c.text === '这是什么'),
  }
  out.gatewayV1Plain = { 还是字符串: typeof gatewayUserContent('你好') === 'string' }
  // 远程 URL 不去取：那是一个能被指使去打内网的出站请求。
  const remote = gatewayUserContent([{ type: 'image_url', image_url: { url: 'http://169.254.169.254/latest/meta-data/' } }])
  out.gatewaySsrf = {
    没有图: !(Array.isArray(remote) && remote.some((c) => c.type === 'image')),
    没带出地址: !JSON.stringify(remote).includes('169.254'),
  }
}

// ── 4. 日志里存路径，不存 base64 ──────────────────────────────────────
{
  const root = tempDir('satu-vis-')
  const ctx = new Context()
  ctx.plugin(WorkspaceService, { root })
  await new Promise((r) => setTimeout(r, 50))
  const saved = await ctx.workspace.saveUpload('s1', 'shot.png', new ReadableStream({
    start(c) {
      c.enqueue(PNG)
      c.close()
    },
  }))
  // 会话事件里该长什么样：路径 + mime，没有字节。
  const block = { type: 'image', path: saved.path, mime: 'image/png' }
  const line = JSON.stringify({ seq: 1, type: 'user/message', data: { message: { content: [block] } } })
  out.logShape = {
    存了路径: line.includes(saved.path),
    没存base64: !line.includes(B64),
    一行够短: line.length < 300,
    // 2 MB 的图 base64 之后是 2.7 MB，直接落进 JSONL 会让这一行没法 grep、没法 tail。
    对比_如果存字节的长度: JSON.stringify({ data: B64 }).length,
  }
  out.formatVersion = SESSION_FORMAT_VERSION
}

// ── 5. 历史里的图：只有最近几张真的带字节 ─────────────────────────────
{
  const root = tempDir('satu-win-')
  const ctx = new Context()
  ctx.plugin(WorkspaceService, { root })
  await new Promise((r) => setTimeout(r, 50))

  // 造 6 张图、6 条带图的用户消息。
  const paths = []
  for (let i = 0; i < 6; i++) {
    const saved = await ctx.workspace.saveUpload('s', `p${i}.png`, new ReadableStream({
      start(c) {
        c.enqueue(PNG)
        c.close()
      },
    }))
    paths.push(saved.path)
  }
  let seq = 0
  const events = [{ seq: ++seq, time: 1, type: 'session', data: { version: 4, id: 's', createdAt: 1, botId: 'b' } }]
  for (const p of paths) {
    events.push({
      seq: ++seq,
      time: 1,
      type: 'user/message',
      data: { message: { id: 'm', role: 'user', content: [{ type: 'image', path: p, mime: 'image/png' }, { type: 'text', text: '看这个' }] }, source: { kind: 'user' } },
    })
  }

  const msgs = await toAgentMessages(events, {}, ctx)
  const users = msgs.filter((m) => m.role === 'user')
  const withBytes = users.filter((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'image'))
  const stale = users.filter(
    (m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'text' && c.text.includes('离现在太远')),
  )
  out.window = {
    用户消息数: users.length,
    带字节的: withBytes.length,
    降级成说明的: stale.length,
    // 带字节的必须是**最后**那几条，不能是最早的。
    最后一条带字节: Array.isArray(users[users.length - 1].content)
      && users[users.length - 1].content.some((c) => c.type === 'image'),
    第一条已降级: Array.isArray(users[0].content)
      && !users[0].content.some((c) => c.type === 'image'),
  }
}

console.log('__RESULT__' + JSON.stringify(out))
