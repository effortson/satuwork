/**
 * Bot 侧工具搜索的一条龙（docs/tool-search-bot.md §14 e2e 那一行）。e2e/tool-search-bot.mjs 用。
 *
 * **走真的目录服务**：假 Gateway 只回 `/runtime/catalog`，九把连接都指向同一台 stub MCP
 * （按路径分连接），一共 325 把工具——事故那份配置的形状（§0）。然后：
 *
 *   1. 发给模型的工具表里一把 `mcp_*` 都没有，只有内置加三把桥接；清单在 tool_search 的描述里
 *   2. 中文搜得到 Drive 的 FIND_FILE，看 schema，在**指定的那把连接**上调成功，参数做了类型矫正
 *   3. 参数不对的在本地拦下，不打上游
 *   4. 要审批的那把（发邮件）经 tool_call 调，弹的是**真名**的确认卡；会话日志的 tool/call 也是真名
 *   5. `tools/list` 带着 client.toolSearch 声明；`SATUWORK_TOOL_SEARCH=off` 之后不带、工具全量进表
 */
import { createServer } from 'node:http'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { tempDir } from './e2e-lib.mjs'

const home = tempDir('satu-tsb-')
const work = tempDir('satu-tsb-work-')

// ── stub MCP：一台服务器，九把连接按路径分 ─────────────────────────────────
const schema = (props, required = []) => ({ type: 'object', properties: props, required })
function kit(named, prefix, n, what) {
  const out = named.map(([name, description, inputSchema]) => ({ name, description, inputSchema }))
  for (let i = out.length; i < n; i++) {
    out.push({ name: `${prefix}_${String(i).padStart(2, '0')}`, description: `${what} housekeeping operation ${i}.`, inputSchema: schema({ id: { type: 'string' } }) })
  }
  return out
}
const DRIVE = kit(
  [
    ['FIND_FILE', 'Search for files and folders in Google Drive by name or query.', schema({ query: { type: 'string' }, page_size: { type: 'integer' } }, ['query'])],
    ['CREATE_FILE', 'Create a new file in a folder.', schema({ name: { type: 'string' } }, ['name'])],
    ['SHARE_FILE', 'Share a file with a user by updating its permissions.', schema({ file_id: { type: 'string' }, email: { type: 'string' } }, ['file_id', 'email'])],
  ],
  'DRIVE_OP', 50, 'Drive',
)
const GMAIL = kit(
  [
    ['SEND_EMAIL', 'Send an email to one or more recipients.', schema({ recipient_email: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, ['recipient_email', 'body'])],
    ['FETCH_EMAILS', 'Fetch recent messages from the inbox.', schema({ max_results: { type: 'integer' } })],
  ],
  'GMAIL_OP', 25, 'Mailbox',
)
const CONNS = [
  { id: 'd1', name: 'Google Drive (syrius)', connector: 'googledrive', tools: DRIVE },
  { id: 'd2', name: 'Google Drive (personal)', connector: 'googledrive', tools: DRIVE },
  { id: 'd3', name: 'Google Drive (diana)', connector: 'googledrive', tools: DRIVE },
  { id: 'd4', name: 'Google Drive (team)', connector: 'googledrive', tools: DRIVE },
  { id: 'sh', name: 'Google Sheets (syrius)', connector: 'googlesheets', tools: kit([], 'SHEET_OP', 45, 'Spreadsheet') },
  { id: 'dc', name: 'Google Docs (syrius)', connector: 'googledocs', tools: kit([], 'DOC_OP', 20, 'Document') },
  { id: 'sl', name: 'Google Slides (syrius)', connector: 'googleslides', tools: kit([], 'SLIDE_OP', 10, 'Presentation') },
  { id: 'g1', name: 'Gmail (work)', connector: 'gmail', tools: GMAIL },
  { id: 'g2', name: 'Gmail (personal)', connector: 'gmail', tools: GMAIL },
]
const seen = { lists: [], calls: [] }

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}
const readJson = (req) =>
  new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        resolve({})
      }
    })
  })

const mcp = createServer(async (req, res) => {
  const body = await readJson(req)
  const conn = CONNS.find((c) => req.url === `/c/${c.id}`)
  const json = (result) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id ?? null, result }))
  }
  if (!conn) return json({})
  if (String(body.method).startsWith('notifications/')) {
    res.writeHead(204)
    return res.end()
  }
  if (body.method === 'initialize') return json({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '0' } })
  if (body.method === 'tools/list') {
    seen.lists.push({ conn: conn.id, params: body.params ?? null })
    return json({ tools: conn.tools })
  }
  if (body.method === 'tools/call') {
    seen.calls.push({ conn: conn.id, name: body.params?.name, args: body.params?.arguments })
    return json({ content: [{ type: 'text', text: `STUB-OK ${conn.id} ${body.params?.name}` }] })
  }
  json({})
})
const mcpPort = await listen(mcp)

const BOT = 'bot-ts'
const gw = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
  if (url.pathname === '/runtime/catalog') {
    return send(200, {
      templateVersion: 1,
      stamp: 'tsb-1',
      bots: [
        {
          id: BOT,
          name: '工具搜索',
          origin: 'company',
          mcps: CONNS.map((c) => c.id),
          // 只开「高风险需确认」：要看的就是经 tool_call 弹出来的那张卡。
          guards: { 'high-risk': true, pii: false, 'no-external': true },
          memory: { on: false, scope: 'bot', kinds: [], ttl: 'forever', cap: 0, confirm: false, pii: false },
        },
      ],
      skills: [],
      memories: [],
      servers: CONNS.map((c) => ({
        id: c.id,
        name: c.name,
        kind: 'HTTP',
        endpoint: `http://127.0.0.1:${mcpPort}/c/${c.id}`,
        perm: '只读',
        enabled: true,
        token: 'tok',
        connector: c.connector,
      })),
      models: { daily: { provider: 'probe', model: 'probe-model' } },
    })
  }
  send(404, { error: 'no' })
})
const gwPort = await listen(gw)

process.env.GATEWAY_URL = `http://127.0.0.1:${gwPort}`
process.env.GATEWAY_TOKEN = 'sat_probe'
process.env.SATUWORK_BOT_ID = BOT
process.env.SATUWORK_APPROVAL_TIMEOUT_MS = '8000'
delete process.env.SATUWORK_TOOL_SEARCH

// 环境变量要在 import 之前设：有几处是模块加载那一刻读的。
const storagePlugin = await import('./src/storage/index.ts')
const sessionsPlugin = await import('./src/session/index.ts')
const workspacePlugin = await import('./src/workspace/index.ts')
const toolsPlugin = await import('./src/tools/index.ts')
const builtinPlugin = await import('./src/tools/builtin.ts')
const registryPlugin = await import('./src/registry/index.ts')
const { CatalogService } = await import('./src/catalog/index.ts')
const llmPlugin = await import('./src/llm/index.ts')
const agentPlugin = await import('./src/agent/index.ts')
const handoffPlugin = await import('./src/policy/handoff.ts')
const policyPlugin = await import('./src/policy/index.ts')
const connectorPlugin = await import('./src/tools/connector.ts')
const toolSearchPlugin = await import('./src/tools/tool-search.ts')
const { AssistantMessageEventStream, emptyAssistant } = await import('./src/llm/stream.ts')

/** registry 要挂几条路由；这里不起 HTTP，给一个什么都接、什么都不干的替身。 */
class FakeServer extends Service {
  constructor(ctx) {
    super(ctx, 'server')
  }
  get() {}
  post() {}
  put() {}
  patch() {}
  delete() {}
  all() {}
  use() {}
}

const ctx = new Context()
/** cordis 自带 logger，接一个 exporter 把行收下来：档位那一行、零命中那一行都要看得见（§12）。 */
const logs = []
ctx.logger.exporter({ colors: 0, levels: { default: 3 }, export: (m) => logs.push(m.args.map(String).join(' ')) })
ctx.plugin(FakeServer)
ctx.plugin(storagePlugin, { path: join(home, 'db.sqlite') })
ctx.plugin(sessionsPlugin, { root: join(home, 'sessions') })
ctx.plugin(workspacePlugin, { root: work })
ctx.plugin(toolsPlugin)
ctx.plugin(builtinPlugin)
ctx.plugin(registryPlugin)
ctx.plugin(CatalogService)
ctx.plugin(llmPlugin)
ctx.plugin(agentPlugin)
ctx.plugin(handoffPlugin)
ctx.plugin(policyPlugin)
ctx.plugin(connectorPlugin)
ctx.plugin(toolSearchPlugin)
await new Promise((r) => setTimeout(r, 400))

const out = {}
const pulled = await ctx.catalog.pull()
out.pull = { ok: pulled, error: ctx.catalog.lastError, servers: ctx.catalog.servers.filter((s) => s.connected).length }
out.declared = seen.lists.length > 0 && seen.lists.every((l) => l.params?.client?.toolSearch === 1)
out.tierLog = logs.find((l) => l.includes('工具搜索：第')) ?? null
out.status = ctx.catalog.status().toolSearch

// ── 假模型：照剧本一步一步来 ─────────────────────────────────────────────
let firstTools = null
let firstSearchDesc = ''
const said = []
let script = []
let step = 0
const lastResult = (context) => {
  const msgs = (context.messages ?? []).filter((m) => m.role === 'toolResult')
  const last = msgs[msgs.length - 1]
  return last ? (last.content ?? []).map((c) => c.text ?? '').join('') : ''
}
let lastContext = null
ctx.llm.streamFn = (model, context) => {
  lastContext = context
  if (!firstTools) {
    firstTools = (context.tools ?? []).map((t) => t.name)
    firstSearchDesc = (context.tools ?? []).find((t) => t.name === 'tool_search')?.description ?? ''
  }
  const prev = lastResult(context)
  if (step > 0) said.push(prev)
  const next = script[step++]
  const stream = new AssistantMessageEventStream()
  const partial = emptyAssistant(model)
  queueMicrotask(() => {
    stream.push({ type: 'start', partial })
    if (!next || next.text) {
      partial.content.push({ type: 'text', text: next?.text ?? '完成' })
      partial.stopReason = 'stop'
      stream.push({ type: 'done', reason: 'stop', message: partial })
      stream.end()
      return
    }
    const args = typeof next.args === 'function' ? next.args(prev) : next.args
    partial.content.push({ type: 'toolCall', id: `c${step}`, name: next.tool, arguments: args })
    stream.push({ type: 'toolcall_start', contentIndex: 0, partial })
    stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: partial.content[0], partial })
    partial.stopReason = 'toolUse'
    stream.push({ type: 'done', reason: 'toolUse', message: partial })
    stream.end()
  })
  return stream
}

const { sessionId } = await ctx.roster.ensureSession(BOT)

/** 自动批准：看到确认卡就记下卡上写的是谁，然后点「批准」。 */
const cards = []
let watching = true
;(async () => {
  while (watching) {
    for (const p of ctx.policy.approvals.list(sessionId)) {
      if (cards.some((c) => c.callId === p.callId)) continue
      cards.push({ callId: p.callId, name: p.name, formTool: p.form.tool, formKind: p.form.kind, reason: p.reason, arguments: p.arguments })
      ctx.policy.approvals.decide(sessionId, p.callId, 'approve', 'once')
    }
    await new Promise((r) => setTimeout(r, 20))
  }
})()

let foundId = ''
script = [
  { tool: 'tool_search', args: { queries: ['在 Drive 里找文件', 'send email', 'zzzz qqqq'] } },
  {
    tool: 'tool_describe',
    args: (prev) => {
      foundId = (prev.match(/(\S+:FIND_FILE)\(/) ?? [])[1] ?? ''
      return { ids: [foundId] }
    },
  },
  // 指定连接：不用搜索结果里排第一的那把，换成 personal。
  { tool: 'tool_call', args: { id: 'google_drive_personal:FIND_FILE', arguments: { query: '7-11 方案', page_size: '5' } } },
  // 少了必填的 recipient_email / body：本地就拦，不打上游。
  { tool: 'tool_call', args: { id: 'gmail_work:SEND_EMAIL', arguments: { subject: '方案' } } },
  { tool: 'tool_call', args: { id: 'gmail_work:SEND_EMAIL', arguments: { recipient_email: 'a@b.c', subject: '方案', body: '见附件' } } },
  { tool: 'tool_call', args: { id: 'google_drive_personl:FIND_FILE', arguments: {} } },
  { text: '完成' },
]
await Promise.race([
  ctx.agents.send(sessionId, '去 Drive 里找 7-11 方案，然后发邮件给 a@b.c'),
  new Promise((_, reject) => setTimeout(() => reject(new Error('一轮没能在 30 秒内收口')), 30_000)),
])
watching = false

const events = await ctx.sessions.events(sessionId)
const toolCalls = events.filter((e) => e.type === 'tool/call').map((e) => e.data)
const headers = events.filter((e) => e.type === 'request/header').map((e) => e.data)
out.table = {
  mcpInTable: firstTools.filter((n) => n.startsWith('mcp_')).length,
  bridges: ['tool_search', 'tool_describe', 'tool_call'].every((n) => firstTools.includes(n)),
  total: firstTools.length,
  listingHasDrive: firstSearchDesc.includes('Google Drive — 连接：google_drive_diana、google_drive_personal、google_drive_syrius、google_drive_team'),
  listingHasGmail: firstSearchDesc.includes('Gmail — 连接：gmail_personal、gmail_work'),
  // 清单在工具描述里，不在系统提示词里（§13 第 4 条）。
  systemClean: !String(headers[0]?.system ?? '').includes('FIND_FILE'),
}
out.sections = headers[0]?.sections ?? null
out.search = said[0] ?? ''
out.describe = said[1] ?? ''
out.findCall = seen.calls.find((c) => c.name === 'FIND_FILE') ?? null
out.findResult = said[2] ?? ''
out.badArgs = { text: said[3] ?? '', upstreamHits: seen.calls.filter((c) => c.name === 'SEND_EMAIL' && !c.args?.recipient_email).length }
out.send = { result: said[4] ?? '', upstream: seen.calls.find((c) => c.name === 'SEND_EMAIL') ?? null }
out.typo = said[5] ?? ''
out.cards = cards
out.foundId = foundId
out.toolCallEvents = toolCalls.map((c) => ({ name: c.name, arguments: c.arguments, via: c.via?.name ?? null }))
out.searchLogged = logs.some((l) => l.includes('tool_search：「在 Drive 里找文件」命中'))
out.zeroHitLogged = logs.some((l) => l.includes('tool_search：零命中「zzzz qqqq」'))

// ── 第二轮：重建历史不能炸（tool/call 记真名，历史照 via 还原）────────────
script = [{ text: '好的' }]
step = 0
firstTools = null
await ctx.agents.send(sessionId, '谢谢')
out.secondTurn = (await ctx.sessions.events(sessionId)).filter((e) => e.type === 'turn/end').map((e) => e.data.reason)

// ── 点名：工具表一个字节都不动，那几把的签名补在这条用户消息里（§8）──────────
const toolsJson = (c) => JSON.stringify((c?.tools ?? []).map((t) => [t.name, t.description, t.parameters]))
const before = toolsJson(lastContext)
const userText = (c) => {
  const users = (c?.messages ?? []).filter((m) => m.role === 'user')
  const last = users[users.length - 1]
  return typeof last?.content === 'string' ? last.content : (last?.content ?? []).map((x) => x.text ?? '').join('\n')
}
script = [{ text: '好的' }]
step = 0
await ctx.agents.send(sessionId, '看看最新邮件，再看看幻灯片', [], [
  { kind: 'connector', id: 'g2', label: 'Gmail (personal)' },
  { kind: 'connector', id: 'sl', label: 'Google Slides (syrius)' },
])
const mentionedUser = userText(lastContext)
out.mention = {
  tableUnchanged: toolsJson(lastContext) === before,
  block: mentionedUser.includes('[本轮指定连接器：Gmail (personal)（gmail_personal）。可直接 tool_call 的工具：'),
  // 10 把不多于 20：全列，带签名。
  slidesListed: mentionedUser.includes('google_slides_syrius:SLIDE_OP_00(id?: string)') && mentionedUser.includes('google_slides_syrius:SLIDE_OP_09'),
  // 25 把多于 20：只列推荐集（这里没有），其余让它搜。
  restHint: mentionedUser.includes('其余 25 把用 tool_search 搜') && !mentionedUser.includes('gmail_personal:SEND_EMAIL('),
  stored: (await ctx.sessions.events(sessionId)).some((e) => e.type === 'user/message' && String(e.data.mentionTools ?? '').includes('gmail_personal')),
}
// 下一轮重建历史：那一段原样拼回去，前缀不变。
script = [{ text: '好的' }]
step = 0
await ctx.agents.send(sessionId, '好')
out.mention.replayed = (lastContext?.messages ?? []).some(
  (m) => m.role === 'user' && (typeof m.content === 'string' ? m.content : m.content.map((x) => x.text ?? '').join('\n')).includes('[本轮指定连接器：Gmail (personal)'),
)

// ── 关掉：SATUWORK_TOOL_SEARCH=off，回到今天的样子 ───────────────────────
process.env.SATUWORK_TOOL_SEARCH = 'off'
seen.lists.length = 0
await ctx.catalog.pull()
out.offDeclared = seen.lists.some((l) => l.params?.client?.toolSearch)
script = [{ text: '好的' }]
step = 0
firstTools = null
await ctx.agents.send(sessionId, '再看看')
out.off = {
  mcpInTable: firstTools.filter((n) => n.startsWith('mcp_')).length,
  bridges: firstTools.filter((n) => ['tool_search', 'tool_describe', 'tool_call'].includes(n)).length,
}

console.log('__RESULT__' + JSON.stringify(out))
mcp.close()
gw.close()
process.exit(0)
