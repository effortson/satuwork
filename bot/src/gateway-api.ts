import { gatewayToken, gatewayUrl } from './env.ts'

/**
 * 凭席位票打 Gateway 的 JSON 接口（`/runtime/*`）。
 *
 * 发请求这一段各处一模一样，**怎么解释回来的东西不一样**——所以底下一个 `gatewayFetch`，
 * 上面几层薄的按调用方的口径分开：
 *
 * - `gatewayJson`：4xx 里那句话是业务失败（memory / skill / routine）；
 * - `gatewayOk`：`ok:false` 是业务失败，非 2xx 一律管道故障（knowledge / web-search）；
 * - `gatewayRaw`：原样交回 status / json / text，调用方自己判（assign）。
 *
 * 文案和超时都由调用方给，这里不替谁定口径。
 */

/** 只管发：有 body 就是 JSON。连不上时 fetch 的原始异常原样抛出（local-* 要的就是这个）。 */
export function gatewayFetch(
  method: string,
  path: string,
  body: unknown,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<Response> {
  return fetch(`${gatewayUrl()}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${gatewayToken()}`,
      ...headers,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
}

export interface GatewayCall {
  timeoutMs: number
  /** 没配 GATEWAY_URL / GATEWAY_TOKEN 时抛的那个（各工具的业务失败类型不同）。 */
  unconfigured: () => Error
}

/** 没配就是业务失败；连不上 Gateway 是**管道故障**——模型改什么都没用。 */
async function reach(method: string, path: string, body: unknown, opt: GatewayCall): Promise<Response> {
  if (!gatewayUrl() || !gatewayToken()) throw opt.unconfigured()
  try {
    return await gatewayFetch(method, path, body, opt.timeoutMs)
  } catch (e) {
    throw new Error(`连不上 Gateway：${(e as Error).message}`)
  }
}

function httpError(status: number, text: string): Error {
  return new Error(`Gateway 返回 HTTP ${status}${text ? ` ${text.slice(0, 200)}` : ''}`)
}

/** Gateway 的 4xx 是参数或权限问题，原话（`error`）交给 `rejected`；5xx 才是管道故障。 */
export async function gatewayJson<T>(
  method: string,
  path: string,
  body: unknown,
  opt: GatewayCall & { rejected: (message: string) => Error },
): Promise<T> {
  const r = await reach(method, path, body, opt)
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    let hint = ''
    try {
      hint = String((JSON.parse(text) as { error?: unknown })?.error ?? '')
    } catch {
      hint = ''
    }
    // 4xx 是「这次请求不对」，说得清；5xx 是那头出事了，模型改不动。
    if (r.status >= 400 && r.status < 500) throw opt.rejected(hint || `Gateway 拒绝了这次操作（HTTP ${r.status}）`)
    throw httpError(r.status, text)
  }
  return (await r.json()) as T
}

/** POST 一份 JSON。`ok:false` 是 Gateway 那头判出来的业务失败，`error` 原话交给 `failure`。 */
export async function gatewayOk<T>(
  path: string,
  body: unknown,
  opt: GatewayCall & { failure: (error: string | undefined) => Error },
): Promise<{ ok?: boolean; error?: string } & T> {
  const r = await reach('POST', path, body, opt)
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw httpError(r.status, text)
  }
  const data = (await r.json()) as { ok?: boolean; error?: string } & T
  if (data?.ok === false) throw opt.failure(data.error)
  return data
}

/** 原样交回，怎么解释由调用方定。正文不是 JSON 时 `json` 为 null。 */
export async function gatewayRaw(
  method: string,
  path: string,
  body: unknown,
  opt: GatewayCall,
): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
  const r = await reach(method, path, body, opt)
  const text = await r.text().catch(() => '')
  let json: Record<string, unknown> | null = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {}
  return { status: r.status, json, text }
}
