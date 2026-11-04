import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { lookup } from 'node:dns/promises'
import { basename, extname } from 'node:path'
import { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { blockedHost, hostOf, privateAddress } from '../policy/browser.ts'
import { humanSize } from '../workspace/index.ts'
import { fail, registerTool } from './common.ts'
import type { ToolCall, ToolResult, WorkspaceFile } from './index.ts'

/**
 * 连接器附件：`connector_upload_file`，以及反方向的「连接器交回来的文件落进工作区」
 * （见下面 downloadablesOf 那一段）。
 *
 * 连接器那头的工具（Composio 的 `GMAIL_SEND_EMAIL`）**不收字节，也不收路径**：附件那一格
 * 要的是一个指向供应商自己存储的句柄 `{ name, mimetype, s3key }`。工作区里的文件只在这台
 * 席位上，供应商那边永远不存在——所以要先把它送过去，换回那个句柄，再填进工具参数。
 *
 * 这把工具就是那一步，**两段**：先向 Gateway（`/mcp/connectors/:id/files`）要一个上传位
 * ——要位子要带平台密钥，而密钥不下机器（docs/connectors.md §2），Gateway 那边验的门和
 * 调工具一样一道不少；再把字节**自己** PUT 到 Gateway 回来的预签名地址。字节不经 Gateway：
 * 它跑在函数环境里，请求体有 4.5 MB 的硬顶，一份十几 MB 的手册在第一版里就是这么被
 * 413 挡掉的。
 *
 * 没有它的时候线上真发生过一次：模型把工作区路径填进 `s3key`，上游去取就是 404，它把
 * 这一步解释成「附件接口坏了」，然后把邮件改成不带附件的草稿转人工。
 */
export const name = 'satu-tools-connector'
export const inject = ['tools', 'workspace', 'catalog']

/**
 * 工具名。**Gateway 那边的 schema 说明里写的也是它**（`gateway/src/lib/connectors.ts` 的
 * `UPLOAD_TOOL_NAME`）：模型照着说明来找这把工具，两边对不上它就找不到。
 */
export const UPLOAD_TOOL = 'connector_upload_file'

/** 单份附件上限。Gateway 也有一道（`CONNECTOR_UPLOAD_MAX_BYTES`），这边先劝一句，省一次往返。 */
const MAX_BYTES = Math.max(1024, Math.trunc(Number(process.env.SATUWORK_CONNECTOR_UPLOAD_MAX_BYTES) || 25 * 1024 * 1024))
/** 要上传位那一次往返。要比 Gateway 的 `CONNECTOR_UPLOAD_TIMEOUT_MS`（30 秒）长：那边先超时，这边才拿得到它的错误原文。 */
const TICKET_TIMEOUT_MS = 60_000
/** 把字节推到对象存储。25 MB 走慢一点的出口也得给够。 */
const PUT_TIMEOUT_MS = 10 * 60_000

/** 从连接器的存储取回一份文件。和上传同一档：25 MB 走慢一点的出口也得给够。 */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000
/** 一次结果里最多自动存几份。列文件夹那种工具一次能回几十个，全下下来是在替模型做它没要的事。 */
const DOWNLOAD_MAX_FILES = 5
/** 跟几次跳转。预签名地址本来不跳，跳了也只认几步，每一步都重新过一遍 downloadBlocked。 */
const DOWNLOAD_MAX_REDIRECTS = 3

/** 三个元工具（docs/tool-search.md §5）：真正的工具名在参数里，这把工具要另问一句。 */
const META_TOOLS = new Set(['SW_SEARCH', 'SW_DESCRIBE', 'SW_RUN'])

/**
 * 扩展名 → MIME。**给收件方看的**，不是浏览器内联白名单（那张表在 workspace/index.ts，
 * 判的是「能不能在 Gateway 的源上渲染」，和这里不是一回事）。认不出的一律
 * `application/octet-stream`——收件方会按扩展名自己猜，不会因此收不到。
 */
const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.ics': 'text/calendar',
  '.eml': 'message/rfc822',
}

export function mimeOf(filename: string): string {
  return MIME[extname(filename).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * 服务器的 MCP 地址 → 这把连接的 `/files` 地址。
 *
 * 目录下发的 endpoint 长这样：`https://gw/mcp/connectors/<id>?botId=<bot>`。路径后面接
 * `/files`，查询串原样保留（`botId` 是统计归因要的）。文件名走 body，不进查询串。
 */
export function uploadUrlOf(endpoint: string): string {
  const u = new URL(endpoint)
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/files`
  return u.toString()
}

/**
 * ── 反方向：连接器**交回来**的文件 ──────────────────────────────────────────
 *
 * 供应商的工具产出文件时（`GOOGLEDRIVE_DOWNLOAD_FILE`、导出成 CSV / PDF 那一类），结果里
 * 给的不是字节，是一个指向它自己存储的临时地址——Composio 叫 `FileDownloadable`：
 *
 *   { "name": "报价", "mimetype": "text/csv", "s3url": "https://…预签名…" }
 *
 * 这个地址模型自己是拿不到的：终端的 curl 在「禁止访问未授权的外部系统」开着的时候会被
 * 拦（那条边界本来就该拦它），`web_extract` 和浏览器读不了附件下载。线上真发生过：模型
 * 试了五种办法，最后转人工，请管理员「放开工作区的外网权限」——为了读一张表开整个终端的
 * 外网，口子开错了地方。
 *
 * 所以由**交回地址的那一次调用**顺手取回来：字节落进工作区 `downloads/`，结果最前面
 * 说一声存在了哪儿。它已经过了那把连接器工具自己的门（授权、外发判据），取回的是那次调用
 * 自己的产出，和上传那一段直接 PUT 预签名地址是同一个道理。字节同样**不经 Gateway**：
 * Vercel 函数的 4.5 MB 请求体硬顶在上传那边已经踩过一次。
 */

/** Composio 的 `FileDownloadable`：认 `s3url` + `mimetype` 两格都在的对象，只有一格的不算——别的数据里碰巧有个 s3url 字段的，不替它下。 */
interface Downloadable {
  name?: unknown
  mimetype: string
  s3url: string
  [k: string]: unknown
}

/** 在一份结果里找出所有可下载的文件对象。找到一个就不再往它里面钻；层数有底，结果再怪也不会走不完。 */
export function downloadablesOf(data: unknown, out: Downloadable[] = [], depth = 0): Downloadable[] {
  if (depth > 12 || !data || typeof data !== 'object') return out
  if (Array.isArray(data)) {
    for (const item of data) downloadablesOf(item, out, depth + 1)
    return out
  }
  const o = data as Record<string, unknown>
  if (typeof o.s3url === 'string' && o.s3url && typeof o.mimetype === 'string') {
    out.push(o as Downloadable)
    return out
  }
  for (const v of Object.values(o)) downloadablesOf(v, out, depth + 1)
  return out
}

/** MIME → 扩展名，取 MIME 表里的第一个（`.jpg` 先于 `.jpeg`、`.html` 先于 `.htm`）。 */
function extOf(mimetype: string): string | undefined {
  const bare = mimetype.split(';')[0].trim().toLowerCase()
  return Object.entries(MIME).find(([, m]) => m === bare)?.[0]
}

/**
 * 落盘用的文件名。供应商给的 `name` 常常不带扩展名（Drive 导出的表格就叫「Syrius SEA Lead
 * Development」），而工作区里认文件、预览、office 工具挑格式都看扩展名，所以按 MIME 补一个。
 * 清洗和重名不覆盖在 workspace.saveBytes 里。
 */
export function downloadNameOf(name: unknown, mimetype: string, url: string): string {
  let base = typeof name === 'string' ? basename(name.trim()) : ''
  if (!base) {
    try {
      base = basename(decodeURIComponent(new URL(url).pathname))
    } catch {
      base = ''
    }
  }
  base ||= 'file'
  if (!MIME[extname(base).toLowerCase()]) {
    const ext = extOf(mimetype)
    if (ext) base += ext
  }
  return base
}

/**
 * 这条地址能不能由席位去取。挡的是「结果里有个地址就去取」变成一条打内网的路：只认
 * https，主机名的判据和浏览器那道是同一份（`blockedHost`：IP 字面量的内网段、`localhost`、
 * 内网后缀、不带点的主机名）。解析到哪儿另由 resolvesPrivate 判。
 *
 * `SATUWORK_CONNECTOR_DOWNLOAD_ALLOW_LOCAL=1` 只给探针用：假存储起在 127.0.0.1 上。**只放
 * 回环的 http**，别的地址照常判——这个变量误带到席位上，也开不出一条打内网的路。
 */
export function downloadBlocked(raw: string): string | undefined {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return '地址不合法'
  }
  if (testLoopback(u)) return undefined
  if (u.protocol !== 'https:') return '只取 https 地址'
  return blockedHost(hostOf(raw)) ?? undefined
}

function testLoopback(u: URL): boolean {
  if (process.env.SATUWORK_CONNECTOR_DOWNLOAD_ALLOW_LOCAL !== '1' || u.protocol !== 'http:') return false
  return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
}

/**
 * 主机名解析出来落在内网吗。字面量那道挡不住「一个正常的域名指向 10.x / 169.254.169.254」。
 * 解析失败返回 undefined：取的时候自然会失败，这里不替它编一个原因。
 *
 * 判完到真正连上之间还有一次解析，DNS 重绑定挡不住——这一道挡的是「本来就指向内网」的名字。
 */
export async function resolvesPrivate(
  raw: string,
  resolve: (host: string) => Promise<{ address: string }[]> = (host) => lookup(host, { all: true }),
): Promise<string | undefined> {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return undefined
  }
  if (testLoopback(u)) return undefined
  const host = hostOf(raw)
  if (!host) return undefined
  let found: { address: string }[]
  try {
    found = await resolve(host)
  } catch {
    return undefined
  }
  for (const one of found) {
    if (privateAddress(one.address)) return `它解析到了内网地址 ${one.address}`
  }
  return undefined
}

/** 边读边数，超过上限就地中断。跳转手动跟，每一跳都重新过 downloadBlocked 和 resolvesPrivate。 */
async function fetchCapped(url: string, signal: AbortSignal): Promise<Buffer> {
  let at = url
  for (let hop = 0; ; hop++) {
    const blocked = downloadBlocked(at) ?? (await resolvesPrivate(at))
    if (blocked) throw new Error(blocked)
    const r = await fetch(at, { redirect: 'manual', signal })
    const location = r.headers.get('location')
    if (r.status >= 300 && r.status < 400 && location) {
      await r.body?.cancel().catch(() => {})
      if (hop >= DOWNLOAD_MAX_REDIRECTS) throw new Error('跳转太多次')
      at = new URL(location, at).toString()
      continue
    }
    if (!r.ok) {
      await r.body?.cancel().catch(() => {})
      // 预签名地址过期是 403：再调一次那把工具就有新地址。
      throw new Error(r.status === 403 ? '地址已经过期（HTTP 403）' : `HTTP ${r.status}`)
    }
    const declared = Number(r.headers.get('content-length'))
    if (declared > MAX_BYTES) {
      await r.body?.cancel().catch(() => {})
      throw new Error(`有 ${humanSize(declared)}，超过上限 ${humanSize(MAX_BYTES)}`)
    }
    const chunks: Buffer[] = []
    let size = 0
    if (r.body) {
      for await (const chunk of Readable.fromWeb(r.body as any)) {
        size += (chunk as Buffer).length
        if (size > MAX_BYTES) throw new Error(`超过上限 ${humanSize(MAX_BYTES)}`)
        chunks.push(chunk as Buffer)
      }
    }
    return Buffer.concat(chunks)
  }
}

/**
 * 取 policy 服务，**不经 inject**（理由同 tools/index.ts 的 agentsOf：policy 那边 inject 了
 * tools，静态依赖绕回来两边都起不来）。没有就不记——审计缺一条不能让下载失败。
 */
function policyOf(ctx: Context):
  | {
      botOf?: (sessionId: string) => Promise<{ id?: string } | undefined>
      record?: (d: Record<string, unknown>) => Promise<void>
    }
  | undefined {
  try {
    return (ctx as unknown as { reflect?: { get?: (name: string) => unknown } }).reflect?.get?.('policy') as never
  } catch {
    return undefined
  }
}

/**
 * 把一次连接器调用的结果里能下的文件取回来，结果里说一声「已经在工作区里」。
 *
 * **原文一个字都不动**：说明和落盘清单拼成两个键（`_satuwork_notice` / `_satuwork_files`，
 * 和 result-budget 用的是同一个约定）插在 JSON 最前面，顶层是数组的包一层 `result`。
 * 这样结果仍是合法 JSON——超了预算还能按结构瘦身，说明在最前面不会被截掉；也不经过一次
 * parse / stringify，大整数 ID 不会被改掉；临时地址留在原处，用户要的就是链接时还给得出。
 *
 * 几份**并行**取，每份各自计时；落盘按顺序来，重名不覆盖靠的是一份一份地挑名字。
 */
async function landDownloads(
  ctx: Context,
  call: ToolCall,
  result: ToolResult,
): Promise<ToolResult> {
  if (result.failed || !result.text.includes('s3url')) return result
  let data: unknown
  try {
    data = JSON.parse(result.text)
  } catch {
    return result
  }
  const found = downloadablesOf(data)
  if (!found.length) return result

  const taken = found.slice(0, DOWNLOAD_MAX_FILES)
  const got = await Promise.all(
    taken.map(async (f) => {
      const timer = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
      try {
        return { bytes: await fetchCapped(f.s3url, AbortSignal.any([timer, ...(call.signal ? [call.signal] : [])])) }
      } catch (e) {
        return { error: timer.aborted && !call.signal?.aborted ? '超时' : (e as Error).message }
      }
    }),
  )

  const saved: WorkspaceFile[] = []
  const listing: Record<string, unknown>[] = []
  const savedLines: string[] = []
  const missedLines: string[] = []
  let bytesIn = 0
  for (const [i, f] of found.entries()) {
    const fileName = downloadNameOf(f.name, f.mimetype, f.s3url)
    const one = got[i]
    let error = one ? one.error : `一次最多自动存 ${DOWNLOAD_MAX_FILES} 份，这份没存`
    if (one?.bytes) {
      try {
        const file = await ctx.workspace.saveBytes('downloads', fileName, one.bytes)
        bytesIn += file.size
        saved.push({ path: file.path, name: file.name })
        listing.push({ name: fileName, saved_to: file.path, size: file.size })
        savedLines.push(`- ${file.path}（${humanSize(file.size)}，${f.mimetype}）`)
        continue
      } catch (e) {
        error = (e as Error).message
      }
    }
    listing.push({ name: fileName, download_error: error })
    missedLines.push(`- ${fileName}：${error}`)
  }

  const head: string[] = []
  if (savedLines.length) {
    head.push(
      '这次调用交回来的文件已经存进工作区，直接读这几份（read_file；表格和文档也可以用 office 工具）。' +
        '结果里的临时地址只在要把下载链接给人时用，不要再拿去下载：',
      ...savedLines,
    )
  }
  if (missedLines.length) {
    head.push(
      '这几份没能自动存下来（地址还留在结果里，但终端和浏览器多半取不到它）：',
      ...missedLines,
      '地址过期或超时就重新调用一次这把工具；太大的换个导出格式或者只取一部分。',
    )
  }

  // 审计：开着「禁止访问未授权的外部系统」时，这是席位自己发出去的请求，管理员要看得到。
  const hosts = [...new Set(taken.map((f) => hostOf(f.s3url) ?? '?'))].join('、')
  try {
    const policy = policyOf(ctx)
    if (policy?.record) {
      const bot = await policy.botOf?.(call.sessionId)
      await policy.record({
        sessionId: call.sessionId,
        botId: bot?.id ?? '',
        callId: call.callId,
        tool: call.name,
        guard: 'no-external',
        outcome: 'noted',
        reason:
          `席位从 ${hosts} 取回连接器交回的文件：存下 ${saved.length} 份（${humanSize(bytesIn)}）进 downloads/` +
          (missedLines.length ? `，${missedLines.length} 份没存` : ''),
        at: Date.now(),
      })
    }
  } catch (e) {
    ctx.logger?.warn?.(`connector: 下载审计没记上 ${(e as Error).message}`)
  }

  const extra =
    `"_satuwork_notice":${JSON.stringify(head.join('\n'))},` + `"_satuwork_files":${JSON.stringify(listing)}`
  const raw = result.text.trim()
  const text = raw.startsWith('{') ? `{${extra},${raw.slice(1)}` : `{${extra},"result":${raw}}`
  return {
    ...result,
    text,
    files: saved.length ? [...(result.files ?? []), ...saved] : result.files,
  }
}

/** Gateway 回来的那张票。 */
interface Ticket {
  file?: { name?: unknown; mimetype?: unknown; s3key?: unknown }
  upload?: { url?: unknown; headers?: unknown } | null
}

interface Args {
  tool?: string
  path?: string
  target?: string
}

export function apply(ctx: Context) {
  /**
   * 连接器交回来的文件（见 landDownloads）。挂 post-execute：要看的是结果，而且得在
   * ToolService 按预算瘦身**之前**——瘦身之后那段 JSON 可能已经被截断，解析不出来。
   * 只认目录说得出连接的那几把（`connectorToolOf`）：公司自配的 MCP 不是 Composio 的格式。
   * 出了任何意外都原样交回结果：那次调用已经跑完了，取不回文件不能把它变成失败。
   */
  ctx.on(
    'tools/post-execute',
    async (call: ToolCall, _result: ToolResult, next: () => Promise<ToolResult>) => {
      const out = await next()
      if (!call.name.startsWith('mcp_')) return out
      try {
        if (!ctx.catalog.connectorToolOf(call.name)) return out
        return await landDownloads(ctx, call, out)
      } catch (e) {
        ctx.logger?.warn?.(`connector: 取回连接器文件失败 ${(e as Error).message}`)
        return out
      }
    },
  )

  registerTool(
    ctx,
    {
      name: UPLOAD_TOOL,
      description:
        '把工作区里的一份文件上传给某个连接器工具当附件（例如发邮件时的 attachment）。' +
        '连接器的工具不收本地路径：先用它上传，再把返回的 { name, mimetype, s3key } 原样填进那个工具的文件参数。' +
        '暂存只在几分钟内有效，上传完马上调用那个工具。',
      parameters: {
        type: 'object',
        properties: {
          tool: {
            type: 'string',
            description:
              '接下来要调用的那把连接器工具的名字，例如 mcp_gmail_default_send_email。' +
              '它是 SW_RUN 那种元工具时，再用 target 说明真正要调的工具。',
          },
          path: { type: 'string', description: '工作区里的文件路径，相对工作区根目录' },
          target: {
            type: 'string',
            description: '只在 tool 是 SW_RUN 时填：真正要调的工具名，例如 GMAIL_SEND_EMAIL',
          },
        },
        required: ['tool', 'path'],
      },
      /**
       * `external`，不带 `write`。
       *
       * 它确实把字节送出了这台席位，所以「关掉外发」的 Bot 要拦得住它（policy 的
       * checkExternal 按参数里那把工具的连接来判）。但**不弹确认卡**：文件到了供应商的
       * 暂存区还没到任何人手里，真正把它发出去的是接下来那把工具，而那一把自己有卡。
       * 同一封邮件弹两张卡，人学到的是闭眼点批准。
       */
      risk: ['external'],
      delegation: {},
    },
    async (args: Args, call) => {
      const toolName = String(args.tool ?? '').trim()
      const path = String(args.path ?? '').trim()
      if (!toolName) fail('要说明这份文件是给哪把连接器工具用的（tool）。')
      if (!path) fail('要说明传哪份文件（path）。')

      const info = ctx.catalog.connectorToolOf(toolName)
      if (!info) {
        fail(
          `${toolName} 不是连接器的工具（或者这台席位上现在没有它）。tool 要填你接下来调用的那把 mcp_* 工具的名字，` +
            `照工具表里的写。`,
        )
      }
      let remoteTool = info.remoteName
      if (META_TOOLS.has(remoteTool.toUpperCase())) {
        const target = String(args.target ?? '').trim()
        if (!target) {
          fail(`${toolName} 是元工具，真正的工具名在它的参数里。再传一次，用 target 说明文件是给哪个工具的（例如 GMAIL_SEND_EMAIL）。`)
        }
        remoteTool = target
      }
      if (!remoteTool) fail(`认不出 ${toolName} 对应的远端工具名，先重新拉一次目录再试。`)

      const abs = ctx.workspace.resolve(path)
      const shown = ctx.workspace.show(abs)
      const st = await stat(abs)
      if (!st.isFile()) fail(`${shown} 不是一个文件。`)
      if (st.size === 0) fail(`${shown} 是空文件，没有东西可以上传。`)
      if (st.size > MAX_BYTES) {
        fail(`${shown} 有 ${humanSize(st.size)}，超过附件上限 ${humanSize(MAX_BYTES)}。压缩一下，或者换个方式分享（比如上传到网盘再发链接）。`)
      }
      const filename = basename(abs)
      const mimetype = mimeOf(filename)
      const bytes = await readFile(abs)
      const md5 = createHash('md5').update(bytes).digest('hex')
      const signals = call.signal ? [call.signal] : []

      // ── 第一段：向 Gateway 要上传位 ───────────────────────────────────
      let r: Response
      try {
        r = await fetch(uploadUrlOf(info.endpoint), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${info.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ tool: remoteTool, name: filename, mimetype, md5, size: st.size }),
          signal: AbortSignal.any([AbortSignal.timeout(TICKET_TIMEOUT_MS), ...signals]),
        })
      } catch (e) {
        // 连不上是管道故障，模型改什么都没用——照常抛，ToolService 标 failed。
        throw new Error(`连不上 Gateway：${(e as Error).message}`)
      }
      const text = await r.text().catch(() => '')
      if (!r.ok) {
        let hint = ''
        try {
          hint = String((JSON.parse(text) as { error?: unknown })?.error ?? '')
        } catch {
          hint = ''
        }
        /**
         * 4xx 和 502 里那句话是 Gateway 判出来的、能照着改的东西（工具没开、文件太大、
         * 供应商拒收），原话给模型；别的当管道故障。（同 tools/memory.ts 的 callGateway）
         */
        if ((r.status >= 400 && r.status < 500) || r.status === 502) {
          fail(hint || `Gateway 拒绝了这次上传（HTTP ${r.status}）`)
        }
        throw new Error(`Gateway 返回 HTTP ${r.status}${text ? ` ${text.slice(0, 200)}` : ''}`)
      }
      let ticket: Ticket
      try {
        ticket = JSON.parse(text) as Ticket
      } catch {
        ticket = {}
      }
      const file = ticket.file
      if (!file || typeof file.s3key !== 'string' || !file.s3key) {
        throw new Error(`Gateway 没有返回文件句柄：${text.slice(0, 200)}`)
      }

      // ── 第二段：字节自己推到预签名地址。null = 供应商按 md5 去重命中，已经有这份了。──
      const upload = ticket.upload
      if (upload && typeof upload.url === 'string' && upload.url) {
        const headers: Record<string, string> = {}
        if (upload.headers && typeof upload.headers === 'object') {
          for (const [k, v] of Object.entries(upload.headers as Record<string, unknown>)) {
            if (typeof v === 'string') headers[k.toLowerCase()] = v
          }
        }
        if (!headers['content-type']) headers['content-type'] = mimetype
        let put: Response
        try {
          put = await fetch(upload.url, {
            method: 'PUT',
            headers,
            body: new Uint8Array(bytes),
            signal: AbortSignal.any([AbortSignal.timeout(PUT_TIMEOUT_MS), ...signals]),
          })
        } catch (e) {
          throw new Error(`传不到连接器的存储：${(e as Error).message}`)
        }
        await put.arrayBuffer().catch(() => undefined)
        if (!put.ok) {
          /**
           * 存储拒收**是业务失败**：预签名过期（拿到票之后等太久）、地址被改过、文件比
           * 报的大小还大。都是能照着话重来一次的事，不是管道坏了。
           */
          fail(`连接器的存储拒收了这份文件（HTTP ${put.status}）。重新调用一次这把工具再试；要是一直这样，换个方式分享。`)
        }
      }

      const handle = { name: String(file.name || filename), mimetype: String(file.mimetype || mimetype), s3key: file.s3key }
      return {
        text:
          `已上传 ${shown}（${humanSize(st.size)}，${handle.mimetype}），给 ${remoteTool} 用。` +
          `把下面这段原样填进它的文件参数（通常叫 attachment）：\n${JSON.stringify(handle)}\n` +
          `暂存只在几分钟内有效，现在就调用那把工具；之后要再发一次得重新上传。`,
        refs: [{ path: shown, name: filename }],
      }
    },
  )
}
