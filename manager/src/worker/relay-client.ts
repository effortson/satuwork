/**
 * 工人打管家中继口的那几个帮手（见 index.ts 文件头「它手上什么都没有」）。
 * 日常任务和渠道两条循环共用；令牌和地址从 worker.env 来。
 */
export const LOCAL = (process.env.SATUWORK_MANAGER_LOCAL || '').trim().replace(/\/$/, '')
export const TOKEN = (process.env.SATUWORK_WORKER_TOKEN || '').trim()

export function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-satuwork-worker': TOKEN, ...extra }
}

export async function relayJson(
  path: string,
  init?: { method?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number },
): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${LOCAL}${path}`, {
    method: init?.method ?? 'GET',
    headers: headers({
      accept: 'application/json',
      ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
    }),
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: init?.signal ?? AbortSignal.timeout(init?.timeoutMs ?? 20_000),
  })
  const text = await r.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: r.status, json }
}

/** Gateway 说「这一次已不归你」（404）。拿到它就停手，别再回报。 */
export class LostError extends Error {}

/** 打 Gateway 的 /worker/*（经管家中继）。非 2xx 抛错，404 抛 LostError。 */
export async function gw(path: string, body?: unknown): Promise<unknown> {
  const { status, json } = await relayJson(`/w-local/gateway/worker${path}`, body === undefined ? undefined : { method: 'POST', body })
  if (status === 404) throw new LostError('这一次已不归本机')
  if (status < 200 || status >= 300) throw new Error(`Gateway ${status}：${(json as { error?: string } | null)?.error ?? ''}`)
  return json
}

/** 跟本机的一个 bot 说话（经管家中继，管家换成席位票）。返回状态码和正文，由调用方判。 */
export function seatRaw(seatId: string, path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number }) {
  return relayJson(`/w-local/seats/${encodeURIComponent(seatId)}/bot${path}`, init)
}

/** 同 seatRaw，但非 2xx 直接抛。 */
export async function seatJson(seatId: string, path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
  const { status, json } = await seatRaw(seatId, path, init)
  if (status < 200 || status >= 300) throw new Error((json as { error?: string } | null)?.error || `HTTP ${status}`)
  return json
}

export function seatEventsUrl(seatId: string, sessionId: string, afterSeq: number): string {
  return `${LOCAL}/w-local/seats/${encodeURIComponent(seatId)}/bot/api/sessions/${encodeURIComponent(sessionId)}/events?after=${afterSeq}`
}
