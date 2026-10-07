/**
 * `connector_upload_file` 的探针（docs/connectors.md §7「附件」）。e2e/connectors.mjs 用。
 * 要 tsx 才 import 得了 .ts。
 *
 * 盯的是这把工具**自己**的那几件事，Gateway 那一侧由同一个套件里的 HTTP 用例守着：
 *
 * 1. 两段：先向 `/mcp/connectors/<id>/files` 要位子（JSON：工具、文件名、MIME、md5、大小，
 *    票在 authorization 里），再把字节**自己** PUT 到票里的地址、照票里的头发
 * 2. 去重命中（票里 `upload` 为 null）就不再 PUT
 * 3. 元工具那层壳：`SW_RUN` 的真名在参数里，这把工具要另问一句 `target`
 * 4. 回给模型的话里**原样**带着句柄，模型照抄就能填
 * 5. 拒绝各说各的话：不是连接器的工具、文件太大、越界、Gateway 判出来的 4xx、存储拒收
 */
import { createHash } from 'node:crypto'
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

// ── 假 Gateway + 假对象存储（同一台）：记下收到的每一次，按参数决定回什么 ──────────
const seen = []
let n = 0
const gw = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const chunks = []
  req.on('data', (d) => chunks.push(d))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    const entry = {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      auth: req.headers.authorization || '',
      contentType: req.headers['content-type'] || '',
      blobType: req.headers['x-ms-blob-type'] || '',
      body,
    }
    seen.push(entry)
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    // 对象存储那一条：按 key 决定收不收。
    if (req.method === 'PUT' && url.pathname.startsWith('/s3/')) {
      if (url.pathname.endsWith('reject')) {
        res.writeHead(403)
        return res.end('<Error>SignatureDoesNotMatch</Error>')
      }
      res.writeHead(200)
      return res.end()
    }
    let json = {}
    try { json = JSON.parse(body.toString('utf8') || '{}') } catch {}
    entry.json = json
    if (json.tool === 'GMAIL_REJECTED') return send(403, { error: '这个工具没有开启，去连接器那一屏打开它' })
    if (json.tool === 'GMAIL_BROKEN') return send(500, { error: 'internal error' })
    const file = { name: json.name, mimetype: json.mimetype, s3key: `req-${++n}` }
    if (json.tool === 'GMAIL_DEDUP') return send(200, { file, upload: null })
    const key = json.tool === 'GMAIL_S3_REJECT' ? 'reject' : file.s3key
    send(200, { file, upload: { url: `http://127.0.0.1:${gw.address().port}/s3/${key}`, headers: { 'content-type': json.mimetype, 'x-ms-blob-type': 'BlockBlob' } } })
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
  const u = new URL(uploadUrlOf('https://gw.example.com/mcp/connectors/c1?botId=b1'))
  out.url = { path: u.pathname, botId: u.searchParams.get('botId') }
}

// ── 2. 正常上传：先要位子（JSON），再自己 PUT 字节 ─────────────────────
{
  const r = await call({ tool: 'mcp_gmail_default_send_email', path: 'docs/酒店版手册.pdf' })
  const ticket = seen.at(-2)
  const put = seen.at(-1)
  out.upload = {
    不算失败: r.failed !== true,
    要位子的路径: ticket?.path === '/mcp/connectors/conn-1/files' && ticket?.method === 'POST',
    要位子是JSON: ticket?.contentType.startsWith('application/json'),
    票: ticket?.auth,
    远端工具: ticket?.json?.tool,
    文件名: ticket?.json?.name,
    归因: ticket?.query.botId,
    MIME: ticket?.json?.mimetype,
    md5对: ticket?.json?.md5 === createHash('md5').update(pdf).digest('hex'),
    大小对: ticket?.json?.size === pdf.length,
    // 字节走的是票里那条地址，不是 Gateway；头照票里的发。
    PUT地址: put?.path,
    PUT头: put?.contentType,
    PUT带了票里的头: put?.blobType === 'BlockBlob',
    字节原样: put ? put.body.equals(pdf) : false,
    话里带句柄: r.text.includes('"s3key":"req-1"') && r.text.includes('"mimetype":"application/pdf"'),
    话里点名远端工具: r.text.includes('SEND_EMAIL'),
    引用了那份文件: Array.isArray(r.refs) && r.refs[0]?.path === 'docs/酒店版手册.pdf',
  }
}

// ── 2b. 去重命中：票里 upload 为 null，不再 PUT ─────────────────────────
{
  const before = seen.length
  const r = await call({ tool: 'mcp_gmail_default_sw_run', target: 'GMAIL_DEDUP', path: 'docs/酒店版手册.pdf' })
  out.dedup = {
    不再PUT: seen.length === before + 1,
    不算失败: r.failed !== true,
    话里带句柄: r.text.includes('"s3key":"req-'),
  }
}

// ── 3. 元工具壳：没说 target 要问，说了就按 target 传 ──────────────────
{
  const before = seen.length
  const ask = await call({ tool: 'mcp_gmail_default_sw_run', path: 'docs/酒店版手册.pdf' })
  const ok = await call({ tool: 'mcp_gmail_default_sw_run', path: 'docs/酒店版手册.pdf', target: 'GMAIL_CREATE_EMAIL_DRAFT' })
  out.meta = {
    没说target不打网络: seen.length === before + 2,
    没说target的话: ask.text,
    说了target按它传: seen.at(-2)?.json?.tool,
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

// ── 5. Gateway 判出来的拒绝原话给模型；5xx 当管道故障；存储拒收是业务失败 ──
{
  const rejected = await call({ tool: 'mcp_gmail_default_sw_run', target: 'GMAIL_REJECTED', path: 'docs/酒店版手册.pdf' })
  const broken = await call({ tool: 'mcp_gmail_default_sw_run', target: 'GMAIL_BROKEN', path: 'docs/酒店版手册.pdf' })
  const s3 = await call({ tool: 'mcp_gmail_default_sw_run', target: 'GMAIL_S3_REJECT', path: 'docs/酒店版手册.pdf' })
  out.gateway = {
    四xx原话: rejected.text,
    四xx不置failed: rejected.failed !== true,
    五xx是管道故障: broken.failed === true,
    存储拒收是业务失败: s3.failed !== true,
    存储拒收的话: s3.text,
  }
}

gw.close()
console.log('__RESULT__' + JSON.stringify(out))
process.exit(0)
