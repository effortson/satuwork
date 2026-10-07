/**
 * `connector_upload_file` 的探针（docs/connectors.md §7「附件」）。e2e/connectors.mjs 用。
 * 要 tsx 才 import 得了 .ts。
 *
 * 盯的是这把工具**自己**的那几件事，Gateway 那一侧由同一个套件里的 HTTP 用例守着：
 *
 * 1. 打到哪、带什么：`/mcp/connectors/<id>/files`，票在 authorization 里，文件是给哪个
 *    远端工具的在 `tool`，文件名在 `name`，字节原样、MIME 在 content-type
 * 2. 元工具那层壳：`SW_RUN` 的真名在参数里，这把工具要另问一句 `target`
 * 3. 回给模型的话里**原样**带着句柄，模型照抄就能填
 * 4. 拒绝各说各的话：不是连接器的工具、文件太大、越界、Gateway 判出来的 4xx
 */
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// **要在 import 之前设**：上限是模块加载那一刻读的环境变量。
process.env.SATUWORK_CONNECTOR_UPLOAD_MAX_BYTES = '2048'

const { Context } = await import('@deepseek-ai/cordis')
const { ToolService } = await import('./src/tools/index.ts')
const { WorkspaceService } = await import('./src/workspace/index.ts')
const connectorTool = await import('./src/tools/connector.ts')
const { mimeOf, uploadUrlOf } = connectorTool

const root = mkdtempSync(join(tmpdir(), 'satu-upload-'))
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }) } catch {} })

// ── 假 Gateway：记下收到的每一次，按查询串决定回什么 ───────────────────
const seen = []
const gw = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const chunks = []
  req.on('data', (d) => chunks.push(d))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    seen.push({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      auth: req.headers.authorization || '',
      contentType: req.headers['content-type'] || '',
      body,
    })
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    if (url.searchParams.get('tool') === 'GMAIL_REJECTED') return send(403, { error: '这个工具没有开启，去连接器那一屏打开它' })
    if (url.searchParams.get('tool') === 'GMAIL_BROKEN') return send(500, { error: 'internal error' })
    send(200, { file: { name: url.searchParams.get('name'), mimetype: req.headers['content-type'], s3key: `s3/${body.length}` } })
  })
})
await new Promise((r) => gw.listen(0, '127.0.0.1', r))
const gwUrl = `http://127.0.0.1:${gw.address().port}`

const ctx = new Context()
ctx.provide('logger', { warn() {}, info() {}, error() {} })
// 目录的替身：两把连接器工具、一把元工具壳、一把公司自配的 MCP（connectorToolOf 答不上）。
const servers = {
  'conn-1': { endpoint: `${gwUrl}/mcp/connectors/conn-1?botId=bot-9`, token: 'sat_seat_1', name: 'Gmail (default)' },
}
const tools = {
  mcp_gmail_default_send_email: { serverId: 'conn-1', remoteName: 'SEND_EMAIL' },
  mcp_gmail_default_sw_run: { serverId: 'conn-1', remoteName: 'SW_RUN' },
}
ctx.provide('catalog', {
  serverOf: (name) => tools[name]?.serverId ?? (name === 'mcp_corp_lookup' ? 'srv-corp' : undefined),
  connectorToolOf: (name) => {
    const t = tools[name]
    if (!t) return undefined
    const s = servers[t.serverId]
    return { serverId: t.serverId, serverName: s.name, connector: 'gmail', remoteName: t.remoteName, endpoint: s.endpoint, token: s.token }
  },
})
ctx.plugin(ToolService)
ctx.plugin(WorkspaceService, { root })
await new Promise((r) => setTimeout(r, 50))
ctx.plugin(connectorTool)
await new Promise((r) => setTimeout(r, 50))

let seq = 0
const call = (args) =>
  ctx.tools.execute({ callId: `c${++seq}`, name: 'connector_upload_file', arguments: JSON.stringify(args), sessionId: 's1' })

mkdirSync(join(root, 'docs'), { recursive: true })
const pdf = Buffer.from('%PDF-1.4 酒店版手册 ' + 'x'.repeat(300))
writeFileSync(join(root, 'docs', '酒店版手册.pdf'), pdf)
writeFileSync(join(root, 'docs', 'big.bin'), Buffer.alloc(4096, 1))
writeFileSync(join(root, 'docs', 'empty.txt'), '')

const out = {}

// ── 1. 纯函数 ─────────────────────────────────────────────────────────
out.mime = {
  pdf: mimeOf('a.PDF'),
  docx: mimeOf('报价.docx'),
  unknown: mimeOf('x.whatever'),
}
{
  const u = new URL(uploadUrlOf('https://gw.example.com/mcp/connectors/c1?botId=b1', 'SEND_EMAIL', '报 价%41.pdf'))
  out.url = {
    path: u.pathname,
    botId: u.searchParams.get('botId'),
    tool: u.searchParams.get('tool'),
    // 名字里的空格和 `%41` 要原样到对面：这边编一次、那边只解一次。
    name: u.searchParams.get('name'),
  }
}

// ── 2. 正常上传：打对地方、带对东西、回的话里有句柄 ────────────────────
{
  const r = await call({ tool: 'mcp_gmail_default_send_email', path: 'docs/酒店版手册.pdf' })
  const hit = seen.at(-1)
  out.upload = {
    不算失败: r.failed !== true,
    路径: hit?.path,
    方法: hit?.method,
    票: hit?.auth,
    远端工具: hit?.query.tool,
    文件名: hit?.query.name,
    归因: hit?.query.botId,
    MIME: hit?.contentType,
    字节原样: hit ? hit.body.equals(pdf) : false,
    话里带句柄: r.text.includes('"s3key":"s3/' + pdf.length + '"') && r.text.includes('"mimetype":"application/pdf"'),
    话里点名远端工具: r.text.includes('SEND_EMAIL'),
    引用了那份文件: Array.isArray(r.refs) && r.refs[0]?.path === 'docs/酒店版手册.pdf',
  }
}

// ── 3. 元工具壳：没说 target 要问，说了就按 target 传 ──────────────────
{
  const before = seen.length
  const ask = await call({ tool: 'mcp_gmail_default_sw_run', path: 'docs/酒店版手册.pdf' })
  const ok = await call({ tool: 'mcp_gmail_default_sw_run', path: 'docs/酒店版手册.pdf', target: 'GMAIL_CREATE_EMAIL_DRAFT' })
  out.meta = {
    没说target不打网络: seen.length === before + 1,
    没说target的话: ask.text,
    说了target按它传: seen.at(-1)?.query.tool,
    不算失败: ok.failed !== true,
  }
}

// ── 4. 拒绝各说各的话 ─────────────────────────────────────────────────
{
  const before = seen.length
  const notConnector = await call({ tool: 'mcp_corp_lookup', path: 'docs/酒店版手册.pdf' })
  const unknown = await call({ tool: 'read_file', path: 'docs/酒店版手册.pdf' })
  const tooBig = await call({ tool: 'mcp_gmail_default_send_email', path: 'docs/big.bin' })
  const empty = await call({ tool: 'mcp_gmail_default_send_email', path: 'docs/empty.txt' })
  const escape = await call({ tool: 'mcp_gmail_default_send_email', path: '../../etc/passwd' })
  const missing = await call({ tool: 'mcp_gmail_default_send_email', path: 'docs/没有这份.pdf' })
  out.refused = {
    这些都不该打网络: seen.length === before,
    不是连接器: notConnector.text,
    不是MCP: unknown.text,
    太大: tooBig.text,
    空文件: empty.text,
    越界: escape.text,
    不存在: missing.text,
    // 业务失败，不是管道故障：模型要照着话改参数，不是重试。
    都不置failed: [notConnector, unknown, tooBig, empty, escape, missing].every((r) => r.failed !== true),
  }
}

// ── 5. Gateway 判出来的拒绝原话给模型；5xx 当管道故障 ─────────────────
{
  const rejected = await call({ tool: 'mcp_gmail_default_sw_run', target: 'GMAIL_REJECTED', path: 'docs/酒店版手册.pdf' })
  const broken = await call({ tool: 'mcp_gmail_default_sw_run', target: 'GMAIL_BROKEN', path: 'docs/酒店版手册.pdf' })
  out.gateway = {
    四xx原话: rejected.text,
    四xx不置failed: rejected.failed !== true,
    五xx是管道故障: broken.failed === true,
  }
}

gw.close()
console.log('__RESULT__' + JSON.stringify(out))
process.exit(0)
