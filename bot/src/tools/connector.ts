import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { humanSize } from '../workspace/index.ts'
import { fail, registerTool } from './common.ts'

/**
 * 连接器附件：`connector_upload_file`。
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
