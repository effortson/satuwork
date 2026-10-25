import type { Context } from '@deepseek-ai/cordis'
import { gatewayToken, gatewayUrl, isLocalRuntime } from './env.ts'
import { gatewayFetch } from './gateway-api.ts'

/**
 * local-routines 和 local-tasks 共用的管道：打 Gateway、打自己的 HTTP 口、读 SSE。
 *
 * 只收管道。两条循环本身**故意是两份**（见 local-tasks 的文件头）：领的是两张表、回报的是两套接口。
 */

/** Gateway 说这一次（这一步）已经不归本机了（404）：租约被别人接走，什么都别再回报。 */
export class LostError extends Error {}

/** 和 Gateway 那边的缺省一致（gateway/src/routines.ts）：一轮最多等 20 分钟，租约 60 秒。 */
export const DEFAULT_TIMEOUT_MS = 20 * 60_000
export const DEFAULT_LEASE_MS = 60_000

/** 网上来的数字不可信：不是有限正数就用缺省，否则 NaN 会变成 1 毫秒的定时器。 */
export function num(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** 本地模式、而且配了 Gateway 才启用；配不全时说一声 `missing`。 */
export function localReady(ctx: Context, missing: string): boolean {
  if (!isLocalRuntime()) return false
  if (!gatewayUrl() || !gatewayToken()) {
    ctx.logger?.warn?.(missing)
    return false
  }
  return true
}

/** `/runtime/<base>/*` 那组接口。有 body 就 POST。404 → LostError(`lost`)。 */
export function localGateway(base: string, lost: string) {
  return async (path: string, body?: unknown): Promise<unknown> => {
    const r = await gatewayFetch(body === undefined ? 'GET' : 'POST', `${base}${path}`, body, 20_000, { accept: 'application/json' })
    const text = await r.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {}
    if (r.status === 404) throw new LostError(lost)
    if (!r.ok) throw new Error(`Gateway ${r.status}：${(json as { error?: string } | null)?.error ?? ''}`)
    return json
  }
}

/** 打自己的 HTTP 口，票就是自己那把（守卫认的正是它）。 */
export function selfClient(ctx: Context) {
  const self = () => String(ctx.server.baseUrl || `http://127.0.0.1:${ctx.server.port}`).replace(/\/$/, '')
  const selfHeaders = () => ({ authorization: `Bearer ${gatewayToken()}`, accept: 'application/json' })
  async function selfJson(path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
    const r = await fetch(`${self()}${path}`, {
      method: init?.method ?? 'GET',
      headers: { ...selfHeaders(), ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    })
    const text = await r.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {}
    if (!r.ok) throw new Error((json as { error?: string } | null)?.error || `HTTP ${r.status}`)
    return json
  }
  return { self, selfHeaders, selfJson }
}

export async function* sseEvents<T>(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<T> {
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    let idx: number
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue
        try {
          yield JSON.parse(line.slice(6)) as T
        } catch {}
      }
    }
  }
}
