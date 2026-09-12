import type { IncomingMessage, ServerResponse } from 'node:http'
import { bearer, isLoopback, json, readRaw } from './http.ts'
import { mergeUsage, usageFromPayload, type TokenUsage } from './llm-usage.ts'

/**
 * 管家替本机 Bot 调模型（协议 10）。
 *
 * 以前 Bot 直接打 Gateway 的 `/v1/*`，Gateway 拿着供应商密钥替它调上游，整条流从上游经
 * Gateway 再到 Bot。Gateway 搬到 Vercel 之后这条长连接留不住（见 docs/adr-gateway-vercel-neon.md），
 * 所以调模型这一跳下沉到席位机器上：
 *
 *   Bot ──(回环, sk_sw_)──▶ 管家 /llm/v1/*
 *                            │ 1. POST {gateway}/worker/llm/grant（smt_）：把 Bot 的 sk_sw_ 交上去，
 *                            │    Gateway 验钥、选模型、扣额度、开一条 llm_calls，回
 *                            │    {callId, url, headers, body:{set,unset}}
 *                            │ 2. 按 body 补丁改请求体、拿 headers 里的密钥直接打供应商，
 *                            │    字节原样流回 Bot，顺手数 usage
 *                            │ 3. POST {gateway}/worker/llm/:callId/settle：把 usage 和结局报回去
 *                            ▼
 *                          供应商
 *
 * **请求体怎么改是 Gateway 说了算**（第 2 步的 `body` 补丁）：哪个模型要补
 * `stream_options.include_usage` 才会回用量、哪家的 `reasoning_effort` 要钳到什么档，这些
 * 只有目录那头知道，而且会随目录变。管家不猜，只照单先删后盖——同一份规矩也就只有一处。
 *
 * **有些家中继不了**（Anthropic 协议的模型被打到 chat 路由、压根没有 OpenAI 兼容端点的
 * API）。Gateway 用 `409 {relayable:false}` 说这件事，管家不把这个 409 摆给 Bot 看，而是
 * 把整通调用原样交回 Gateway 自己的 `/v1`——那正是中继出现之前它们走的路。
 *
 * **密钥只活在这一次调用的内存里**：不落盘、不进日志、不回显（错误文本里把它抹掉）。
 * Bot 的 sk_sw_ 管家也不验，原样交给 Gateway 去验——机器上不该多出一份「谁是谁」的判断。
 *
 * 两道闸：只收回环地址（不是回环直接 404，不暴露有这条路）；每个请求都要带 Bot 的钥匙
 * （`Authorization: Bearer sk_sw_…` 或 `x-api-key`）。
 *
 * 结算**不挡 Bot 的响应**：响应收完（或断掉）之后才报，报不上重试一次，再不行只留一行日志——
 * Gateway 会定期把没结算的调用扫掉。
 */

type Route = 'chat' | 'messages' | 'responses'

const ROUTES: Record<string, Route> = {
  '/llm/v1/chat/completions': 'chat',
  '/llm/v1/messages': 'messages',
  '/llm/v1/responses': 'responses',
}

/** 请求体上限。对话历史里塞图片是常事，4 MB 那档（http.ts）不够；32 MB 之上就不是正常请求了。 */
const BODY_LIMIT = 32 * 1024 * 1024
/** 打 Gateway（grant / settle / models）的预算：都是小 JSON。 */
const GATEWAY_TIMEOUT_MS = 20_000
/** 上游只管到响应头为止的预算（理由见 headerDeadline）。 */
const UPSTREAM_HEADER_MS = 120_000
/** 结算失败之后隔多久再试一次。 */
const SETTLE_RETRY_MS = 2_000

type Settlement = 'ok' | 'failed' | 'error' | 'timeout'

/** Gateway 下发的请求体补丁：先按 `unset` 删，再拿 `set` 盖。 */
interface BodyPatch {
  set: Record<string, unknown>
  unset: string[]
}

interface Grant {
  callId: string
  provider: string
  model: string
  url: string
  headers: Record<string, string>
  body: BodyPatch
}

export interface LlmRelayDeps {
  machineToken: () => string
  gatewayUrl: () => string
}

/** Bot 的钥匙。两种写法都收：OpenAI 风格的 Bearer，和 Anthropic 风格的 x-api-key。 */
function apiKeyOf(req: IncomingMessage): string {
  return bearer(req) || String(req.headers['x-api-key'] || '').trim()
}

function headerStr(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name]
  return typeof v === 'string' && v ? v : undefined
}

/**
 * 授权里这些头的值**不是**秘密，别抹。除此之外的一律当密钥看（见 secretsOf）。
 *
 * 名单摆成「除了这几个都算秘密」而不是反过来，是因为自定义供应商的头名字是运营填的：
 * 见过 `x-goog-api-key`、`api-key`、`x-portkey-api-key`，也见过干脆叫 `token` 的。
 * 白名单一定漏，而漏一个的后果是密钥顺着上游的错误正文流进 Bot 的日志。
 */
const PUBLIC_HEADERS = new Set(['content-type', 'accept', 'accept-encoding', 'content-length', 'host', 'user-agent', 'anthropic-version', 'openai-beta'])

/**
 * 这一次调用要抹掉的值：授权头里除了上面那几个之外的原值，外加去掉 `Bearer ` 之后的
 * 裸密钥（有些上游回显的是裸值）。
 *
 * **不按长度认。** 上一版是「值长到 16 个字符就抹」，那条规矩会把
 * `content-type: application/json` 整个抹掉——它正好 16 个字符——于是模型答复里凡是提到
 * `Content-Type: application/json` 的地方（教人写 curl 的回答天天有）都变成
 * `Content-Type: [redacted]`；而且它还压在非流式的**成功**响应上，抹的是模型的正文。
 *
 * 只留一个下限防自伤：拿一个三五个字符的串去 split 整篇文本，抠出来的是一堆
 * `[redacted]` 碎片，比不抹还难看；而真密钥没有那么短的。
 */
const SECRET_MIN = 8

function secretsOf(headers: Record<string, string>): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(headers)) {
    if (!v || PUBLIC_HEADERS.has(k.toLowerCase())) continue
    if (v.length >= SECRET_MIN) out.push(v)
    const bare = v.replace(/^Bearer\s+/i, '')
    if (bare !== v && bare.length >= SECRET_MIN) out.push(bare)
  }
  return out
}

function redact(text: string, secrets: string[]): string {
  let out = text
  for (const s of secrets) out = out.split(s).join('[redacted]')
  return out
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * **这 120 秒只管到响应头为止。** 罩住整次请求的话，一次开大 max_tokens 或带扩展思考的
 * 生成流上两分钟是常事，到点被掐断，Bot 收到的是一条没有结束帧也没有错误帧的半截回答，
 * 而账上按正常调用记着。所以计时器只防「连上了但迟迟不给响应头」，拿到头就撤；正文
 * 期间只剩「Bot 走了」这一个中断条件。
 */
function headerDeadline(ac: AbortController, reason: Error): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => ac.abort(reason), UPSTREAM_HEADER_MS)
  return () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }
}

/**
 * 「Bot 还在不在」。断了就别再拉上游：那边按 token 计费，没人读的字节一样要付钱。
 *
 * **不能只看 req 的 close。** Node 16 起「请求体读完」也算 req 的 close（Node 24 上实测：
 * 正常请求和中途取消的请求，在那一刻的 `req.destroyed` / `req.complete` 一模一样，都是
 * true/true），所以 req 那条 close 分不出「读完了」和「走了」。分得清的是 **res**：res 的
 * close 来时我们自己还没 end 过，那就是对面先断的。req 那条只剩一个用处——请求体**没读完**
 * 就断（上传到一半关掉标签页）。
 *
 * 监听要在**读请求体之前**就挂上，见 relayCall 里的调用点。
 */
interface ClientWatch {
  readonly ac: AbortController
  gone(): boolean
  /** 每条出口都要调，否则就是在 req/res 上攒监听器。 */
  release(): void
}

function watchClient(req: IncomingMessage, res: ServerResponse): ClientWatch {
  const ac = new AbortController()
  let gone = false
  const check = () => {
    if (gone) return
    if (res.writableEnded) return // 这一头是我们自己收的
    if (!(res.destroyed || (req.destroyed && !req.complete))) return
    gone = true
    ac.abort()
  }
  req.on('close', check)
  res.on('close', check)
  // 挂之前就已经断了的也要认：从这里到真正打上游，中间隔着读体和要授权，最长二十几秒。
  check()
  return {
    ac,
    gone: () => gone,
    release: () => {
      req.off('close', check)
      res.off('close', check)
    },
  }
}

export function llmRelayIntercept(deps: LlmRelayDeps) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (!url.pathname.startsWith('/llm/')) return false
    // 不是本机来的连接：装作没有这条路。它是给本机 Bot 的，外面的人不该知道它在。
    if (!isLoopback(req)) {
      json(res, 404, { error: 'not found' })
      return true
    }
    const apiKey = apiKeyOf(req)
    if (!apiKey) {
      json(res, 401, { error: '缺席位 API Key（Authorization: Bearer sk_sw_… 或 x-api-key）' })
      return true
    }
    if (url.pathname === '/llm/v1/models') {
      if (req.method !== 'GET') {
        json(res, 405, { error: 'method not allowed' })
        return true
      }
      await relayModels(deps, apiKey, res)
      return true
    }
    const route = ROUTES[url.pathname]
    if (!route) {
      json(res, 404, { error: 'not found' })
      return true
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return true
    }
    // 退回 Gateway 时要打同一条路径：`/llm/v1/chat/completions` → `/v1/chat/completions`。
    await relayCall(deps, route, url.pathname.slice('/llm'.length), apiKey, req, res)
    return true
  }
}

/** `GET /llm/v1/models`：目录在 Gateway 手里，原样转一趟。Bot 的钥匙也原样带过去。 */
async function relayModels(deps: LlmRelayDeps, apiKey: string, res: ServerResponse): Promise<void> {
  try {
    const r = await fetch(`${deps.gatewayUrl()}/v1/models`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    })
    const text = await r.text()
    res.writeHead(r.status, {
      'content-type': r.headers.get('content-type') || 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(text)
  } catch (e) {
    if (!res.headersSent) json(res, 503, { error: 'Gateway 够不着: ' + errMsg(e) })
    else res.end()
  }
}

/** grant 请求体。Gateway 那头按这几项决定上游地址、鉴权头和请求体补丁。 */
interface GrantAsk {
  apiKey: string
  route: Route
  model: string
  provider?: string
  anthropicVersion?: string
  openaiBeta?: string
  /** 这次是不是流式。Gateway 靠它决定要不要补 `stream_options.include_usage`。 */
  stream?: boolean
  /** Bot 报的 `reasoning_effort`。钳到哪一档由 Gateway 按目录定。 */
  reasoningEffort?: string
}

/** 409 的正文里写着 `relayable: false` 吗——「这家中继不了」和「这次不给过」是两回事。 */
function notRelayable(text: string): boolean {
  try {
    const o: unknown = JSON.parse(text)
    return !!o && typeof o === 'object' && (o as Record<string, unknown>).relayable === false
  } catch {
    return false
  }
}

function patchOf(raw: unknown): BodyPatch | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  const set = o.set && typeof o.set === 'object' && !Array.isArray(o.set) ? (o.set as Record<string, unknown>) : {}
  const unset = Array.isArray(o.unset) ? o.unset.filter((k): k is string => typeof k === 'string') : []
  return { set, unset }
}

/**
 * 向 Gateway 要这一次调用的授权。
 *
 * 回 `grant` 表示放行；回 `fallback` 表示这家中继不了（409 `relayable:false`），调用方改走
 * Gateway 的 `/v1`；回 `relayed` 表示 Gateway 拒了（400/401/402/403/404…），状态和正文已经
 * 原样转给 Bot——Bot 那边渲染 `error.message || error`，所以正文一个字都不改。
 */
async function askGrant(
  deps: LlmRelayDeps,
  ask: GrantAsk,
  res: ServerResponse,
): Promise<{ grant: Grant } | { fallback: true } | { relayed: true }> {
  let r: Response
  try {
    r = await fetch(`${deps.gatewayUrl()}/worker/llm/grant`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${deps.machineToken()}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(ask),
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    })
  } catch (e) {
    json(res, 503, { error: 'Gateway 够不着: ' + errMsg(e) })
    return { relayed: true }
  }
  const text = await r.text()
  if (!r.ok) {
    // 认的是正文里的 `relayable: false`，不是 409 这个数——状态码是 Gateway 的实现细节，
    // 「这家中继不了」这句话才是约定。
    if (notRelayable(text)) return { fallback: true }
    res.writeHead(r.status, {
      'content-type': r.headers.get('content-type') || 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(text)
    return { relayed: true }
  }
  let grant: Partial<Grant>
  try {
    grant = JSON.parse(text) as Partial<Grant>
  } catch {
    json(res, 502, { error: 'Gateway 的授权答复不是 JSON' })
    return { relayed: true }
  }
  if (!grant.callId || !grant.url || !grant.headers || typeof grant.headers !== 'object') {
    json(res, 502, { error: 'Gateway 的授权答复缺字段' })
    return { relayed: true }
  }
  // 补丁是必给的（`set.model` 一定有，`unset` 一定含 `provider`），缺了就是答复不成形。
  // **不给它补一个空补丁兜底**：那样请求体一个字不改就打上游，`provider` 原样漏过去、
  // 用量收不齐，而表面上一切正常——宁可当场 502 说清楚。
  const patch = patchOf(grant.body)
  if (!patch) {
    json(res, 502, { error: 'Gateway 的授权答复缺 body 补丁' })
    return { relayed: true }
  }
  return {
    grant: {
      callId: String(grant.callId),
      provider: String(grant.provider || ''),
      model: String(grant.model || ''),
      url: String(grant.url),
      headers: grant.headers as Record<string, string>,
      body: patch,
    },
  }
}

async function relayCall(
  deps: LlmRelayDeps,
  route: Route,
  suffix: string,
  apiKey: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const t0 = Date.now()
  /**
   * **监听挂在读体之前**：读请求体加要授权最长能有二十几秒，等到 proxyUpstream 里再挂就
   * 晚了——那时 req 早就 close 过，后挂的监听器一辈子不会响，于是「Bot 已经走了」这件事
   * 谁都不知道：照样打上游（真花钱）、把流灌进一个死掉的 res、末了还记一笔 `ok`。
   */
  const watch = watchClient(req, res)
  try {
    let raw: Buffer | undefined
    try {
      raw = await readRaw(req, BODY_LIMIT)
    } catch (e) {
      json(res, 400, { error: '读请求体失败: ' + errMsg(e) })
      return
    }
    if (!raw) {
      json(res, 413, { error: `请求体超过 ${BODY_LIMIT / 1024 / 1024} MB` })
      return
    }
    let body: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(raw.toString('utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      body = { ...(parsed as Record<string, unknown>) }
    } catch {
      json(res, 400, { error: 'malformed JSON' })
      return
    }
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!model) {
      json(res, 400, { error: 'model 不能为空' })
      return
    }
    const ask: GrantAsk = {
      apiKey,
      route,
      model,
      provider: typeof body.provider === 'string' && body.provider.trim() ? body.provider.trim() : undefined,
      anthropicVersion: headerStr(req, 'anthropic-version'),
      openaiBeta: headerStr(req, 'openai-beta'),
      stream: body.stream === true,
      reasoningEffort: typeof body.reasoning_effort === 'string' ? body.reasoning_effort : undefined,
    }

    const asked = await askGrant(deps, ask, res)
    if ('relayed' in asked) return
    if ('fallback' in asked) {
      await fallbackToGateway(deps, route, suffix, model, apiKey, raw, req, watch, res, t0)
      return
    }
    const { grant } = asked

    // 授权这一趟是整条路上最长的一段空档（最多 20 秒），回来时 Bot 可能已经不在了。
    // 上游还没打，这里掉头最便宜：一分钱不花。但 grant 已经在 Gateway 那边开了一行
    // llm_calls，所以还是要结一笔 failed 把它收口，不然只能等清扫。
    if (watch.gone() || res.destroyed || res.writableEnded) {
      console.log(`satuwork-manager: llm ${route} ${grant.provider}/${grant.model} Bot 在授权期间断了，没打上游 ${Date.now() - t0}ms`)
      void settle(deps, grant.callId, undefined, 'failed')
      return
    }

    // 请求体怎么改由 Gateway 定（见文件头）：先按 unset 删，再拿 set 盖。`model` 换成目录里
    // 的正名、`provider` 这个只是选路提示的字段被删掉，都在这份补丁里，管家不自己动手。
    for (const k of grant.body.unset) delete body[k]
    Object.assign(body, grant.body.set)
    const headers: Record<string, string> = { ...grant.headers, 'content-type': 'application/json' }

    const out = await proxyUpstream(res, watch, { url: grant.url, headers, body, secrets: secretsOf(grant.headers) })
    const ms = Date.now() - t0
    const u = out.usage
    console.log(
      `satuwork-manager: llm ${route} ${grant.provider}/${grant.model || model} ${out.status}` +
        ` upstream=${out.httpStatus ?? '-'} prompt=${u?.prompt_tokens ?? 0} completion=${u?.completion_tokens ?? 0}` +
        ` cached=${u?.cached_tokens ?? 0} cache_write=${u?.cache_write_tokens ?? 0} ${ms}ms`,
    )
    // 结算不挡响应：响应已经收尾了，这里只是往 Gateway 报一声。
    void settle(deps, grant.callId, u, out.status)
  } finally {
    watch.release()
  }
}

/**
 * 这家中继不了（Gateway 回 409 `relayable: false`）：整通调用原样交回 Gateway 自己的 `/v1`。
 *
 * 为什么不把那个 409 摆给 Bot 看：Bot 没做错什么，也没有第二条路可换，看到的只会是一条
 * 莫名其妙的失败。中继出现之前这些模型走的就是 Gateway 的 `/v1`——Anthropic 协议的模型
 * 打到 chat 路由、没有 OpenAI 兼容端点的 API，都属于这一类——那就让它们继续走。
 *
 * 请求体**一个字不改**（Gateway 那头自己会规范化），Bot 的 `sk_sw_` 原样带过去（那头本来
 * 就是认它的），版本头也带上：`/v1` 的透传路由要看它们挑上游。
 *
 * **不结算。** 这条路上根本没有 grant，也没有我们开的那行 llm_calls；账是 Gateway 在 `/v1`
 * 里自己记的，这边再报一笔就是重复。
 */
async function fallbackToGateway(
  deps: LlmRelayDeps,
  route: Route,
  suffix: string,
  model: string,
  apiKey: string,
  raw: Buffer,
  req: IncomingMessage,
  watch: ClientWatch,
  res: ServerResponse,
  t0: number,
): Promise<void> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    accept: String(req.headers.accept || 'application/json'),
  }
  const anthropicVersion = headerStr(req, 'anthropic-version')
  if (anthropicVersion) headers['anthropic-version'] = anthropicVersion
  const openaiBeta = headerStr(req, 'openai-beta')
  if (openaiBeta) headers['openai-beta'] = openaiBeta

  const timedOut = new Error('Gateway did not send headers in 120s')
  const clearDeadline = headerDeadline(watch.ac, timedOut)
  let up: Response
  try {
    up = await fetch(`${deps.gatewayUrl()}${suffix}`, {
      method: 'POST',
      headers,
      body: new Uint8Array(raw),
      signal: watch.ac.signal,
    })
  } catch (e) {
    clearDeadline()
    console.log(`satuwork-manager: llm ${route} ${model} 退回 Gateway /v1（这家中继不了）打不通 ${Date.now() - t0}ms`)
    if (!watch.gone() && !res.headersSent) {
      json(res, watch.ac.signal.reason === timedOut ? 504 : 503, { error: 'Gateway 够不着: ' + errMsg(e) })
    } else if (!res.writableEnded) res.end()
    return
  }
  clearDeadline()
  const ctype = up.headers.get('content-type') || 'application/json; charset=utf-8'
  const streaming = ctype.includes('text/event-stream') || ctype.includes('text/plain')
  res.writeHead(
    up.status,
    streaming
      ? { 'content-type': ctype, 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' }
      : { 'content-type': ctype, 'cache-control': 'no-store' },
  )
  let broke = false
  if (up.body) {
    try {
      const reader = up.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(value)
      }
    } catch {
      broke = true
    }
  }
  if (!res.writableEnded) res.end()
  console.log(
    `satuwork-manager: llm ${route} ${model} 退回 Gateway /v1（这家中继不了，Gateway 回了 relayable:false）` +
      ` upstream=${up.status}${broke ? ' 断流' : ''} ${Date.now() - t0}ms`,
  )
}

interface UpstreamOutcome {
  status: Settlement
  usage: TokenUsage | undefined
  /** 上游的 HTTP 状态；没拿到响应头就是 undefined。 */
  httpStatus?: number
}

/**
 * gateway/src/v1.ts 的 `proxyUpstream` 移植过来的：行为要一模一样，Bot 那边分不出是谁在代理。
 *
 * 不抛错、只回结局：错误已经写给 Bot 了（能写的话），调用方拿 `status` 去结算。
 * 「Bot 还在不在」由调用方传进来的 `watch` 说了算（挂监听的时机见 relayCall）。
 */
async function proxyUpstream(
  res: ServerResponse,
  watch: ClientWatch,
  opts: { url: string; headers: Record<string, string>; body: unknown; secrets: string[] },
): Promise<UpstreamOutcome> {
  const timedOut = new Error('upstream did not send headers in 120s')
  const clearDeadline = headerDeadline(watch.ac, timedOut)
  let upstream: Response
  try {
    upstream = await fetch(opts.url, {
      method: 'POST',
      headers: opts.headers,
      body: JSON.stringify(opts.body),
      signal: watch.ac.signal,
    })
  } catch (e) {
    clearDeadline()
    const status: Settlement = watch.ac.signal.reason === timedOut ? 'timeout' : watch.gone() ? 'failed' : 'error'
    if (!watch.gone() && !res.headersSent) {
      json(res, status === 'timeout' ? 504 : 503, { error: redact(errMsg(e) || 'upstream unreachable', opts.secrets) })
    }
    return { status, usage: undefined }
  }
  clearDeadline()
  const httpStatus = upstream.status
  const ctype = upstream.headers.get('content-type') || 'application/json; charset=utf-8'
  const streaming = ctype.includes('text/event-stream') || ctype.includes('text/plain')
  if (streaming) {
    res.writeHead(upstream.status, {
      'content-type': ctype,
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    })
    let usage: TokenUsage | undefined
    let buf = ''
    // 一个解码器从头用到尾：多字节字符会被切在两个 chunk 之间，每次新建解码器会把它解成
    // 替换字符，那一帧的 JSON 就 parse 不动，用量跟着丢。
    const decoder = new TextDecoder()
    const take = (piece: Uint8Array) => {
      // 字节**原样**写给 Bot——数 usage 只看副本，不改流。
      res.write(piece)
      buf += decoder.decode(piece, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          try {
            const u = usageFromPayload(JSON.parse(payload))
            if (u) usage = mergeUsage(usage, u)
          } catch {}
        }
      }
    }
    // 读流放在 try 里：中途失败（Bot 走了、上游掐了）不能把已经累计的 usage 一起丢掉。
    // 断流是断流，账还是要记。
    let broke = false
    if (upstream.body) {
      try {
        const reader = upstream.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          take(value)
        }
      } catch {
        broke = true
      }
    }
    if (!res.writableEnded) res.end()
    const status: Settlement = broke ? (watch.gone() ? 'failed' : 'error') : upstream.ok ? 'ok' : 'failed'
    return { status, usage, httpStatus }
  }
  let text: string
  try {
    text = await upstream.text()
  } catch {
    if (!watch.gone() && !res.headersSent) json(res, 502, { error: '读上游响应失败' })
    return { status: watch.gone() ? 'failed' : 'error', usage: undefined, httpStatus }
  }
  // 成功的答复**一个字不动**地给 Bot；只有出错时才抹（上游的 4xx/5xx 会把请求头回显在
  // 正文里，密钥就在那里面）。
  if (!upstream.ok) text = redact(text, opts.secrets)
  res.writeHead(upstream.status, {
    'content-type': ctype.includes('json') ? 'application/json; charset=utf-8' : ctype,
    'cache-control': 'no-store',
  })
  res.end(text)
  let usage: TokenUsage | undefined
  try {
    const u = usageFromPayload(JSON.parse(text))
    if (u) usage = mergeUsage(undefined, u)
  } catch {}
  return { status: upstream.ok ? 'ok' : 'failed', usage, httpStatus }
}

/**
 * 把结局报给 Gateway。网络层失败隔两秒再试一次；再不行留一行日志就算了——Gateway 那边幂等，
 * 而且会定期把没结算的调用扫掉，这里不值得为它排队。Gateway 明确拒了（4xx）不重试：再报
 * 一遍也是同一个答案。
 */
async function settle(deps: LlmRelayDeps, callId: string, usage: TokenUsage | undefined, status: Settlement): Promise<void> {
  const target = `${deps.gatewayUrl()}/worker/llm/${encodeURIComponent(callId)}/settle`
  const payload = JSON.stringify({ usage, status })
  let lastErr = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, SETTLE_RETRY_MS))
    try {
      const r = await fetch(target, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${deps.machineToken()}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: payload,
        signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      })
      if (r.ok) return
      const text = await r.text().catch(() => '')
      lastErr = `HTTP ${r.status} ${text.slice(0, 200)}`
      if (r.status >= 400 && r.status < 500) break
    } catch (e) {
      lastErr = errMsg(e)
    }
  }
  console.error(`satuwork-manager: llm 结算 ${callId} 没报上（${lastErr}），等 Gateway 自己扫`)
}
