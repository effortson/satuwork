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
 * 这把工具就是那一步。它**打的是 Gateway**（`/mcp/connectors/:id/files`），不直连供应商：
 * 暂存要带平台密钥，而密钥不下机器（docs/connectors.md §2）。Gateway 那边验的门和调工具
 * 一样一道不少——关掉的工具，附件也传不上去。
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
/** 要比 Gateway 的 `CONNECTOR_UPLOAD_TIMEOUT_MS`（90 秒）长：那边先超时，这边才拿得到它的错误原文。 */
const TIMEOUT_MS = 120_000

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
 * `/files`，查询串原样保留（`botId` 是统计归因要的），再加上 `tool` 和 `name`。
 * **用 URLSearchParams 编码，Gateway 那边不再 decode**——两边各编解一次，名字里本来
 * 就有的 `%` 会被吃掉。
 */
export function uploadUrlOf(endpoint: string, remoteTool: string, filename: string): string {
  const u = new URL(endpoint)
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/files`
  u.searchParams.set('tool', remoteTool)
  u.searchParams.set('name', filename)
  return u.toString()
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

      const signals = [AbortSignal.timeout(TIMEOUT_MS), ...(call.signal ? [call.signal] : [])]
      let r: Response
      try {
        r = await fetch(uploadUrlOf(info.endpoint, remoteTool, filename), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${info.token}`,
            'content-type': mimetype,
          },
          body: new Uint8Array(bytes),
          signal: AbortSignal.any(signals),
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
      let file: { name?: unknown; mimetype?: unknown; s3key?: unknown } | undefined
      try {
        file = (JSON.parse(text) as { file?: typeof file }).file
      } catch {
        file = undefined
      }
      if (!file || typeof file.s3key !== 'string' || !file.s3key) {
        throw new Error(`Gateway 没有返回文件句柄：${text.slice(0, 200)}`)
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
