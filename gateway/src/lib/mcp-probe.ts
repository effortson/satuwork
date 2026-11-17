/**
 * 公司自配 MCP 的两件小事：token 归一，和 Gateway 这一侧的握手试连。
 *
 * 都是同一次排查留下的：管理员把 `Bearer re0_sk_…` 连前缀一起填进了 token 栏，席位再补一个
 * `Bearer `，对端回 401——而这句 401 只写在席位日志里，管理界面上那台服务器看起来一切正常。
 */
import { WebToolError, readCapped, safeFetch } from '../web-tools.ts'

/**
 * 只留密钥本身：去掉开头多填的 `Bearer `。
 *
 * 席位发请求时自己会加这个前缀（bot/src/catalog/mcp.ts 的 headersOf），所以存下来的必须是
 * 裸的。反复剥是给 `Bearer Bearer xxx` 这种的——既然要收口就收干净。
 */
export function bareToken(v: unknown): string {
  let s = typeof v === 'string' ? v.trim() : ''
  for (;;) {
    const next = s.replace(/^bearer(\s+|$)/i, '').trim()
    if (next === s) return s
    s = next
  }
}

export type McpProbe =
  /** 握上了，`tools/list` 也回了。 */
  | { status: 'ok'; tools: number; names: string[] }
  /** 对端明确回了不行，或者根本打不通。`error` 是给管理员看的原话。 */
  | { status: 'failed'; error: string }
  /** Gateway 这一侧试不了，不代表席位连不上（stdio、内网地址）。 */
  | { status: 'skipped'; reason: string }

/** 和席位那边对公司 MCP 的单次时限一致（bot/src/catalog/mcp.ts 的 DEFAULT_TIMEOUT_MS）。 */
const PROBE_TIMEOUT_MS = 8000
/** 响应最多读这么多。一份工具清单到不了这个数，超了多半不是 MCP。 */
const MAX_BODY = 2 * 1024 * 1024
/** 回给界面的工具名最多这么多个，够认出「连对了没有」。 */
const MAX_NAMES = 50

type Fetcher = (url: string, init: RequestInit & { timeoutMs?: number }) => Promise<Response>

/** JSON 或 SSE 里的最后一条 JSON-RPC 响应。口径同席位那份 readBody。 */
function rpcBodyOf(ctype: string, text: string): unknown {
  if (!text.trim()) return undefined
  if (!ctype.includes('text/event-stream')) return JSON.parse(text)
  let last: unknown
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      last = JSON.parse(payload)
    } catch {
      /* 认不出的那一行丢掉 */
    }
  }
  if (last === undefined) throw new Error('SSE 里没有 JSON-RPC 响应')
  return last
}

/**
 * 照席位的走法握一次手：`initialize` → `notifications/initialized` → `tools/list`。
 *
 * **走 SSRF 闸**（safeFetch）：地址是管理员填的，Gateway 手里有库和平台凭证，不能照着就打。
 * 代价是内网里的 MCP 在这里试不了——那种回 `skipped`，不回 `failed`：席位在公司网里，
 * 它连得上，界面不该说「连不上」。
 *
 * 不抛：三种结果都是结果，调用方只管照着显示。`fetcher` 留给测试换掉。
 */
export async function probeMcp(
  server: { kind: string; endpoint: string; token?: string },
  fetcher: Fetcher = safeFetch,
): Promise<McpProbe> {
  if (server.kind === 'stdio') return { status: 'skipped', reason: 'stdio 服务器由席位在本机启动，这里试不了' }
  const token = bareToken(server.token)
  let sessionId = ''
  let nextId = 1
  const rpc = async (method: string, params?: unknown, notification = false): Promise<unknown> => {
    const body: Record<string, unknown> = { jsonrpc: '2.0', method }
    if (!notification) body.id = nextId++
    if (params !== undefined) body.params = params
    const res = await fetcher(server.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify(body),
      timeoutMs: PROBE_TIMEOUT_MS,
    })
    sessionId = res.headers.get('mcp-session-id') || sessionId
    if (notification) {
      await res.body?.cancel().catch(() => {})
      return undefined
    }
    const text = (await readCapped(res, MAX_BODY)).toString('utf8')
    if (!res.ok) throw new Error(`HTTP ${res.status}${text ? ` ${text.slice(0, 200)}` : ''}`)
    let parsed: { result?: unknown; error?: { message?: string; code?: number } } | undefined
    try {
      parsed = rpcBodyOf(res.headers.get('content-type') || '', text) as typeof parsed
    } catch (e) {
      throw new Error(e instanceof SyntaxError ? `回的不是 JSON：${text.slice(0, 120)}` : (e as Error).message)
    }
    if (!parsed || typeof parsed !== 'object') throw new Error('空响应')
    if (parsed.error) throw new Error(parsed.error.message || `rpc error ${parsed.error.code}`)
    return parsed.result
  }
  try {
    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'satuwork', version: '0.1.0' },
    })
    // 有的服务器不认这条通知，席位那边也是吞掉的。
    await rpc('notifications/initialized', {}, true).catch(() => undefined)
    const listed = (await rpc('tools/list')) as { tools?: { name?: unknown }[] } | undefined
    const names = (Array.isArray(listed?.tools) ? listed.tools : []).map((x) => String(x?.name ?? '')).filter(Boolean)
    return { status: 'ok', tools: names.length, names: names.slice(0, MAX_NAMES) }
  } catch (e) {
    if (e instanceof WebToolError) {
      // 内网地址：闸拦的，不是对端拒的。
      if (/^private ip|EPRIVATEIP/i.test(e.message) || e.hint.startsWith('拒绝访问内网地址')) {
        return { status: 'skipped', reason: '这是内网地址，Gateway 这边试不了；以席位实际连接为准' }
      }
      return { status: 'failed', error: e.hint }
    }
    return { status: 'failed', error: (e as Error).message || '握手失败' }
  }
}
