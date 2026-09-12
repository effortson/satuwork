import type { IncomingMessage, ServerResponse } from 'node:http'
import { json } from './http.ts'
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
 *                            │    Gateway 验钥、选模型、扣额度、开一条 llm_calls，回 {callId, url, headers}
 *                            │ 2. 拿 headers 里的密钥直接打供应商，字节原样流回 Bot，顺手数 usage
 *                            │ 3. POST {gateway}/worker/llm/:callId/settle：把 usage 和结局报回去
 *                            ▼
 *                          供应商
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
/** 上游只管到响应头为止的预算（理由见 relayCall 里 headerTimer 那段）。 */
const UPSTREAM_HEADER_MS = 120_000
/** 结算失败之后隔多久再试一次。 */
const SETTLE_RETRY_MS = 2_000

type Settlement = 'ok' | 'failed' | 'error' | 'timeout'

interface Grant {
  callId: string
  provider: string
  model: string
  url: string
  headers: Record<string, string>
}

export interface LlmRelayDeps {
  machineToken: () => string
  gatewayUrl: () => string
}

/** 和 relay.ts 那份一样；单独抄一遍是为了不让两条中继口互相 import。 */
export function isLoopback(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress || ''
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
}

/** Bot 的钥匙。两种写法都收：OpenAI 风格的 Bearer，和 Anthropic 风格的 x-api-key。 */
function apiKeyOf(req: IncomingMessage): string {
  const h = String(req.headers.authorization || '')
  if (/^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim()
  return String(req.headers['x-api-key'] || '').trim()
}

function headerStr(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name]
  return typeof v === 'string' && v ? v : undefined
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const want = name.toLowerCase()
  return Object.keys(headers).some((k) => k.toLowerCase() === want)
}

/**
 * 把授权头里的每一个值从文本里抹掉。上游报错时会把请求头回显在正文里（Anthropic 的 401
 * 就这么干），不抹的话密钥就顺着错误文本流到 Bot 的日志里。太短的值（比如 anthropic-version
 * 的日期）不抹：那不是秘密，而且会把正常文本抠得面目全非。
 */
function redact(text: string, headers: Record<string, string>): string {
  let out = text
  for (const v of Object.values(headers)) {
    if (!v || v.length < 16) continue
    out = out.split(v).join('[redacted]')
    // 「Bearer xxx」这种写法，值本身就带前缀，上面那一刀已经覆盖；再抹一次裸密钥。
    const bare = v.replace(/^Bearer\s+/i, '')
    if (bare !== v && bare.length >= 16) out = out.split(bare).join('[redacted]')
  }
  return out
}

/** 读整个请求体。超过上限就中止读取并回 413，不把剩下的字节收进内存。 */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let n = 0
    let tooBig = false
    req.on('data', (c: Buffer) => {
      if (tooBig) return
      n += c.length
      if (n > limit) {
        tooBig = true
        resolve(undefined)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!tooBig) resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
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
    await relayCall(deps, route, apiKey, req, res)
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

/**
 * 向 Gateway 要这一次调用的授权。
 *
 * 回 `grant` 表示放行；回 `relayed` 表示 Gateway 拒了（400/401/402/403/404），状态和正文已经
 * 原样转给 Bot——Bot 那边渲染 `error.message || error`，所以正文一个字都不改。
 */
async function askGrant(
  deps: LlmRelayDeps,
  body: Record<string, unknown>,
  res: ServerResponse,
): Promise<{ grant: Grant } | { relayed: true }> {
  let r: Response
  try {
    r = await fetch(`${deps.gatewayUrl()}/worker/llm/grant`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${deps.machineToken()}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    })
  } catch (e) {
    json(res, 503, { error: 'Gateway 够不着: ' + errMsg(e) })
    return { relayed: true }
  }
  const text = await r.text()
  if (!r.ok) {
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
  return {
    grant: {
      callId: String(grant.callId),
      provider: String(grant.provider || ''),
      model: String(grant.model || ''),
      url: String(grant.url),
      headers: grant.headers as Record<string, string>,
    },
  }
}

async function relayCall(deps: LlmRelayDeps, route: Route, apiKey: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const t0 = Date.now()
  let raw: Buffer | undefined
  try {
    raw = await readBody(req, BODY_LIMIT)
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
  const provider = typeof body.provider === 'string' && body.provider.trim() ? body.provider.trim() : undefined
  const anthropicVersion = headerStr(req, 'anthropic-version')
  const openaiBeta = headerStr(req, 'openai-beta')

  const asked = await askGrant(deps, { apiKey, route, model, provider, anthropicVersion, openaiBeta }, res)
  if ('relayed' in asked) return
  const { grant } = asked

  // 和 Gateway 自己代理时一样：`model` 换成目录里的正名，`provider` 只是选路提示，上游不认。
  body.model = grant.model || model
  delete body.provider
  const headers: Record<string, string> = { ...grant.headers, 'content-type': 'application/json' }
  // Bot 指定的版本头优先级低于授权里的：Gateway 要钉死版本时（比如上游换了默认）以它为准。
  if (route === 'messages' && anthropicVersion && !hasHeader(headers, 'anthropic-version')) headers['anthropic-version'] = anthropicVersion
  if (route === 'responses' && openaiBeta && !hasHeader(headers, 'openai-beta')) headers['openai-beta'] = openaiBeta

  const out = await proxyUpstream(req, res, { url: grant.url, headers, body })
  const ms = Date.now() - t0
  const u = out.usage
  console.log(
    `satuwork-manager: llm ${route} ${grant.provider}/${body.model} ${out.status}` +
      ` upstream=${out.httpStatus ?? '-'} prompt=${u?.prompt_tokens ?? 0} completion=${u?.completion_tokens ?? 0}` +
      ` cached=${u?.cached_tokens ?? 0} cache_write=${u?.cache_write_tokens ?? 0} ${ms}ms`,
  )
  // 结算不挡响应：响应已经收尾了，这里只是往 Gateway 报一声。
  void settle(deps, grant.callId, u, out.status)
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
 */
async function proxyUpstream(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { url: string; headers: Record<string, string>; body: unknown },
): Promise<UpstreamOutcome> {
  // Bot 断了就别再拉上游：那边按 token 计费，没人读的字节一样要付钱。
  const ac = new AbortController()
  let clientGone = false
  const onClose = () => {
    clientGone = true
    ac.abort()
  }
  req.on('close', onClose)
  /**
   * **这 120 秒只管到响应头为止。** 罩住整次请求的话，一次开大 max_tokens 或带扩展思考的
   * 生成流上两分钟是常事，到点被掐断，Bot 收到的是一条没有结束帧也没有错误帧的半截回答，
   * 而账上按正常调用记着。所以计时器只防「连上了但迟迟不给响应头」，拿到头就撤；正文
   * 期间只剩「Bot 走了」这一个中断条件。
   */
  const timedOut = new Error('upstream did not send headers in 120s')
  let headerTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => ac.abort(timedOut), UPSTREAM_HEADER_MS)
  const clearHeaderTimer = () => {
    if (headerTimer !== undefined) {
      clearTimeout(headerTimer)
      headerTimer = undefined
    }
  }
  let upstream: Response
  try {
    upstream = await fetch(opts.url, {
      method: 'POST',
      headers: opts.headers,
      body: JSON.stringify(opts.body),
      signal: ac.signal,
    })
  } catch (e) {
    clearHeaderTimer()
    req.off('close', onClose)
    const status: Settlement = ac.signal.reason === timedOut ? 'timeout' : clientGone ? 'failed' : 'error'
    if (!clientGone && !res.headersSent) {
      json(res, status === 'timeout' ? 504 : 503, { error: redact(errMsg(e) || 'upstream unreachable', opts.headers) })
    }
    return { status, usage: undefined }
  }
  clearHeaderTimer()
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
    req.off('close', onClose)
    if (!res.writableEnded) res.end()
    const status: Settlement = broke ? (clientGone ? 'failed' : 'error') : upstream.ok ? 'ok' : 'failed'
    return { status, usage, httpStatus }
  }
  let text: string
  try {
    text = redact(await upstream.text(), opts.headers)
  } catch {
    req.off('close', onClose)
    if (!clientGone && !res.headersSent) json(res, 502, { error: '读上游响应失败' })
    return { status: clientGone ? 'failed' : 'error', usage: undefined, httpStatus }
  }
  req.off('close', onClose)
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
