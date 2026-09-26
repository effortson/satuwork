import type { ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Account, ChargeStatus, Db } from './db.ts'
import type { JwtKeys } from './crypto.ts'
import { verifyJwt } from './crypto.ts'
import { HttpError, bearer, json, watchClient, type Req, type Router } from './http.ts'
import { EMPTY_USAGE, applyBodyPatch, openaiModelId, redact, type CatalogModel, type Llm, type UpstreamTarget } from './llm.ts'
import type { Meter } from './lib/meter.ts'
import { mergeUsage, openaiUsage, tokensOf, usageFromPayload, type TokenUsage } from './lib/llm-usage.ts'
import { accountByApiKey, assertUsable, gateOr402, recordLlmCall, withSettle, type RunOutcome } from './lib/llm-billing.ts'

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

/**
 * `Authorization: Bearer` 或 `x-api-key`。后者是 Anthropic SDK 的写法，
 * `/v1/messages` 的调用方基本都这么发。
 *
 * Node 把重复出现的非 set-cookie 头合成一个逗号分隔的字符串，所以这里只需要处理
 * string——以前那条 `Array.isArray` 分支永远到不了。
 */
function callerToken(req: Req): string | undefined {
  const b = bearer(req)
  if (b) return b
  const x = req.headers['x-api-key']
  if (typeof x === 'string' && x.trim()) return x.trim()
}

async function requireUser(req: Req, db: Db, keys: JwtKeys): Promise<Account> {
  const token = callerToken(req)
  if (!token) throw new HttpError(401, '需要登录')
  // access token 是席位运行时票，不能拿来调 /v1。
  if (token.startsWith('sat_')) throw new HttpError(401, '需要登录')
  // API Key 那条路和管家中继的授权接口是同一份（lib/llm-billing.ts）。
  if (token.startsWith('sk_sw_')) return accountByApiKey(db, token)
  let payload
  try {
    payload = verifyJwt(keys, token)
  } catch (e) {
    throw new HttpError(401, (e as Error).message)
  }
  const account = await db.account(payload.accountId)
  if (!account) throw new HttpError(401, '账号不存在')
  // iat 只有秒精度：同一秒内新签发的票不能被刚写下的 tokenRevokedAt 误杀。
  if (account.tokenRevokedAt && payload.iat < Math.floor(account.tokenRevokedAt / 1000)) {
    throw new HttpError(401, '登录已失效，请重新登录')
  }
  return assertUsable(db, account)
}

function bodyOf(req: Req): Record<string, unknown> {
  if (req.body == null) return {}
  if (typeof req.body !== 'object' || Array.isArray(req.body)) throw new HttpError(400, '请求体必须是对象')
  return req.body as Record<string, unknown>
}

async function publicModels(llm: Llm, companyId: string | null) {
  return (await llm.catalog(companyId)).map((m) => ({
    id: openaiModelId(m),
    object: 'model' as const,
    owned_by: m.provider,
    provider: m.provider,
    model: m.id,
    name: m.name,
    api: m.api,
    context_window: m.contextWindow,
    max_tokens: m.maxTokens,
    reasoning: m.reasoning,
    reasoning_levels: m.reasoningLevels ?? (m.reasoning ? ['off', 'minimal', 'low', 'medium', 'high'] : ['off']),
    input: m.input && m.input.length ? m.input : ['text'],
    cost: m.cost,
    // 'discovered' = 内置快照里没有、运行时从 models.dev 补进来的。页面据此打标：
    // 这类模型没经过 pi 的逐个实测，用户有权知道自己点的是哪一种。
    source: m.source,
  }))
}

async function resolveOr404(llm: Llm, companyId: string | null, raw: string, hint?: string) {
  const found = await llm.find(companyId, raw, hint)
  if (!found) throw new HttpError(404, '模型不在可见目录里', { model: raw })
  return found
}

async function secretOr402(llm: Llm, companyId: string | null, provider: string): Promise<string> {
  const secret = await llm.secret(companyId, provider)
  if (!secret) throw new HttpError(402, `没有 ${provider} 的密钥`, { provider })
  return secret
}

/**
 * 这两条路由是**厂商原生协议**的透传口。它们原先按 `found.provider` 的**名字**夹死成内置
 * 的 openai / anthropic，理由是上游地址当时是写死的：地址和密钥两边各算各的，
 * `{"model":"anthropic/claude-…"}` 打到 `/v1/responses` 就会把 ANTHROPIC_API_KEY 发给
 * api.openai.com，落进另一家厂商的请求日志，只能轮换。
 *
 * 现在地址、头、请求体全由 `upstreamTargetOf` 从**同一个** `found` 算出来，错配那条路
 * 不存在了；而它判的是模型的**协议**（`api`），不是供应商叫什么名字。所以按名字夹的那道闸
 * 撤掉——留着反而是个 bug：走 Anthropic 协议但不叫 anthropic 的供应商有九家（minimax、
 * kimi-coding、fireworks、vercel-ai-gateway…），Bot 按协议选路把它们送到这条路上，
 * 按名字夹会把它们一律 400，而中继那条路（同一个 upstreamTargetOf）放行。
 * 协议对不上仍然是 400，由 upstreamOr400 给出，措辞在 upstreamTargetOf 里。
 */

/**
 * upstreamTargetOf 的 /v1 版：算不出目标就是 400。
 *
 * 那边的 `relayable` 是**给管家中继看的**——「这条中继走不了，退回 /v1 打」。这里就是
 * /v1，没有再往下退的地方了，所以两种拒法在这条路上都只是一个 400。
 */
function upstreamOr400(
  llm: Llm,
  found: CatalogModel,
  route: 'chat' | 'messages' | 'responses',
  secret: string,
  req: { anthropicVersion?: string; openaiBeta?: string; reasoningEffort?: string },
): UpstreamTarget {
  const target = llm.upstreamTargetOf(found, route, secret, req)
  if ('error' in target) throw new HttpError(400, target.error)
  return target
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c
        if (c && typeof c === 'object' && 'text' in c) return String((c as { text?: unknown }).text ?? '')
        return ''
      })
      .join('')
  }
  return content == null ? '' : String(content)
}

function safeParse(s: unknown): unknown {
  if (s && typeof s === 'object') return s
  if (typeof s !== 'string') return {}
  try {
    return s.trim() ? JSON.parse(s) : {}
  } catch {
    return {}
  }
}

/**
 * 用户消息 → pi 的 content。
 *
 * **这一层最容易被漏掉**：Bot 那边把图片发对了，到这儿再被 contentText() 拍成字符串，
 * 图就没了——而且没有任何报错，模型只是看不见它。
 *
 * 进来的是 OpenAI 口径的 content 数组（`image_url.url` 里是 data URI），出去的是 pi 的
 * `{type:'image', data, mimeType}`。没有图就还给字符串，跟以前一样。
 */
export function userContent(content: unknown): any {
  if (!Array.isArray(content)) return contentText(content)
  if (!content.some((c: any) => c?.type === 'image_url' || c?.type === 'image')) return contentText(content)
  const out: any[] = []
  for (const c of content as any[]) {
    if (c?.type === 'image_url') {
      const url = String(c.image_url?.url ?? '')
      const m = /^data:([^;,]+);base64,(.*)$/s.exec(url)
      // 只收内联的 base64。远程 URL 得由这一层去取，那是一个可以被指使去打内网的
      // 出站请求（SSRF），不做。
      if (m) out.push({ type: 'image', mimeType: m[1], data: m[2] })
      continue
    }
    if (c?.type === 'image' && typeof c.data === 'string') {
      out.push({ type: 'image', mimeType: c.mimeType || 'image/png', data: c.data })
      continue
    }
    const t = typeof c === 'string' ? c : (c?.text ?? '')
    if (t) out.push({ type: 'text', text: t })
  }
  return out.length ? out : contentText(content)
}

export function toPiContext(body: Record<string, unknown>, provider: string, modelId: string) {
  const messagesIn = Array.isArray(body.messages) ? body.messages : []
  let systemPrompt: string | undefined
  const messages: any[] = []
  for (const raw of messagesIn) {
    const m = raw as Record<string, any>
    const role = m.role
    if (role === 'system' || role === 'developer') {
      const t = contentText(m.content)
      systemPrompt = [systemPrompt, t].filter(Boolean).join('\n')
      continue
    }
    if (role === 'user') {
      messages.push({ role: 'user', content: userContent(m.content), timestamp: Date.now() })
      continue
    }
    if (role === 'assistant') {
      const content: any[] = []
      const text = contentText(m.content)
      if (text) content.push({ type: 'text', text })
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          content.push({
            type: 'toolCall',
            id: tc.id,
            name: tc.function?.name ?? tc.name,
            arguments: safeParse(tc.function?.arguments ?? tc.arguments),
          })
        }
      }
      messages.push({
        role: 'assistant',
        content,
        api: 'openai-completions',
        provider,
        model: modelId,
        usage: EMPTY_USAGE,
        stopReason: 'stop',
        timestamp: Date.now(),
      })
      continue
    }
    if (role === 'tool') {
      messages.push({
        role: 'toolResult',
        toolCallId: m.tool_call_id ?? m.toolCallId,
        toolName: m.name ?? '',
        content: [{ type: 'text', text: contentText(m.content) }],
        isError: false,
        timestamp: Date.now(),
      })
    }
  }
  const tools = Array.isArray(body.tools)
    ? body.tools.map((t: any) => {
        const fn = t.function ?? t
        return {
          name: fn.name,
          description: fn.description ?? '',
          parameters: fn.parameters ?? t.input_schema ?? { type: 'object', properties: {} },
        }
      })
    : undefined
  return { systemPrompt, messages, tools }
}

/** OpenAI 兼容入参里的推理档位，转成 pi-ai 的通用档位。off 等同于不传。 */
function reasoningOf(body: Record<string, unknown>): 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  const raw = body.reasoning_effort
  return raw === 'minimal' || raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'xhigh' || raw === 'max'
    ? raw
    : undefined
}

function chunk(id: string, model: string, delta: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: extra.finish_reason ?? null }],
    ...('usage' in extra ? { usage: extra.usage } : {}),
  }
}

function writeSse(res: ServerResponse, payload: unknown) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

async function streamChatCompletions(
  res: ServerResponse,
  llm: Llm,
  found: { provider: string; id: string },
  secret: string,
  body: Record<string, unknown>,
): Promise<RunOutcome> {
  const modelId = openaiModelId(found)
  const id = `chatcmpl-${randomUUID()}`
  const piModel = llm.piModel(found.provider, found.id)
  if (!piModel) {
    throw new HttpError(404, '模型不在可见目录里', { model: modelId })
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  })
  const context = toPiContext(body, found.provider, found.id)
  /**
   * 客户端一走就得停下来。以前没有这一条：浏览器关了标签页，Gateway 还在把上游的
   * token 一个个拉完——写进一个没人读的 socket，钱照付。后来补过一条 `req.on('close')`，
   * 可它挂在请求体读完之后，一次都没响过（见 http.ts 的 watchClient）。
   *
   * 信号直接交给 pi-ai：它当场中止底层请求，不必等下一帧到了才 break——扩展思考那种
   * 半天不来一帧的流，「等下一帧」就等于白付那一段。
   */
  const watch = watchClient(res)
  const stream = llm.models.streamSimple(piModel as any, context as any, {
    apiKey: secret,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : undefined,
    reasoning: reasoningOf(body),
    signal: watch.signal,
  })
  let usage: TokenUsage | undefined
  /**
   * 这次有没有正常收口。断流、上游报错时以前 usage 是 undefined，settle 记成一行
   * 金额 0 的 failed——可上游在第一帧（Anthropic 的 message_start）就报了输入 token，
   * 那些提示词是真发出去、真收了钱的。所以每一帧都从 `partial.usage` 里把已知的
   * 用量累计下来（取大，同 mergeUsage），断了就按已知的那部分落账。
   */
  let outcome: ChargeStatus | undefined
  const noteUsage = (raw: unknown) => {
    const u = tokensOf(openaiUsage(raw), raw)
    if (u && (u.prompt_tokens || u.completion_tokens)) usage = mergeUsage(usage, u)
  }
  try {
    for await (const event of stream) {
      // 先记用量，再看人走没走：中止收尾的那一帧（`error`，reason 是 aborted）带着的正是
      // 到此为止已经问上游要过的那些 token。
      if ('partial' in event) noteUsage(event.partial?.usage)
      else if (event.type === 'error') noteUsage(event.error?.usage)
      // break 会调 for-await 的 .return()；底层请求已经由上面那个信号中止了。
      if (watch.gone()) break
      switch (event.type) {
        case 'start':
          writeSse(res, chunk(id, modelId, { role: 'assistant' }))
          break
        case 'text_delta':
          writeSse(res, chunk(id, modelId, { content: event.delta }))
          break
        case 'thinking_delta':
          writeSse(res, chunk(id, modelId, { reasoning_content: event.delta }))
          break
        case 'toolcall_start': {
          const tc = (event.partial?.content?.[event.contentIndex] as any) ?? {}
          writeSse(
            res,
            chunk(id, modelId, {
              tool_calls: [
                {
                  index: event.contentIndex,
                  id: tc.id ?? `call_${event.contentIndex}`,
                  type: 'function',
                  function: { name: tc.name ?? '', arguments: '' },
                },
              ],
            }),
          )
          break
        }
        case 'toolcall_delta':
          writeSse(
            res,
            chunk(id, modelId, {
              tool_calls: [{ index: event.contentIndex, function: { arguments: event.delta } }],
            }),
          )
          break
        case 'done': {
          const reason = event.reason === 'toolUse' ? 'tool_calls' : event.reason === 'length' ? 'length' : 'stop'
          const u = openaiUsage(event.message?.usage)
          if (u) usage = tokensOf(u, event.message?.usage)
          writeSse(res, chunk(id, modelId, {}, { finish_reason: reason, usage: u }))
          break
        }
        case 'error': {
          // 报错那一帧带的是到此为止的 AssistantMessage，usage 在循环开头已经记过了。
          outcome = 'error'
          const msg = redact(event.error?.errorMessage || 'model error', secret)
          // **错误帧在前，finish 块在后。** 反过来写的话，任何一个「读到 finish_reason
          // 就收工」的客户端（我们自己的 bot 就是）永远读不到错误那一帧，一次上游报错
          // 在它眼里就成了一次正常收口的空回答。finish 块本身还得留着——只认
          // finish_reason 的客户端少了它会一直挂着。
          writeSse(res, { error: { message: msg, type: 'upstream_error' } })
          writeSse(res, chunk(id, modelId, { content: '' }, { finish_reason: 'stop' }))
          break
        }
      }
    }
  } catch (e) {
    // 中止也可能以抛出的形式收场：那是客户端走了，不是上游报错。
    outcome = watch.gone() ? 'failed' : 'error'
    const msg = redact((e as Error).message || 'upstream error', secret)
    if (!watch.gone()) writeSse(res, { error: { message: msg, type: 'upstream_error' } })
  } finally {
    watch.release()
  }
  // 客户端已经走了就别再往 socket 里写；但 usage 要照常返回——已经问上游要过的
  // token 是花掉了的，不记账等于白送。
  const gone = watch.gone()
  if (!gone) res.write('data: [DONE]\n\n')
  // 走了也 end 一下：对已经断开的响应是空操作，但路由器就不会再往上补一个 204。
  res.end()
  // 客户端中途走了记 failed，上游报错记 error。账本的 status 只有 ok / failed / timeout /
  // denied / error（迁移 0007 的 check），没有 aborted——要加得开一条新迁移，这里先用
  // 现有的两档；已知的 usage 照常计价，一点都没拿到时 settle 会标 unpriced。
  if (gone && !outcome) outcome = 'failed'
  return outcome ? { usage, status: outcome } : usage
}

async function completeChatCompletions(
  res: ServerResponse,
  llm: Llm,
  found: { provider: string; id: string },
  secret: string,
  body: Record<string, unknown>,
): Promise<RunOutcome> {
  const modelId = openaiModelId(found)
  const piModel = llm.piModel(found.provider, found.id)
  if (!piModel) throw new HttpError(404, '模型不在可见目录里', { model: modelId })
  const context = toPiContext(body, found.provider, found.id)
  // 同流式那一岔：人走了就中止上游，不等它把一整段回答生成完再白付钱。
  const watch = watchClient(res)
  let message: any
  try {
    message = await llm.models.completeSimple(piModel as any, context as any, {
      apiKey: secret,
      temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
      // 同流式那一岔：新版 OpenAI SDK 发的是 max_completion_tokens，只认 max_tokens 会把上限静静丢掉。
      maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : undefined,
      reasoning: reasoningOf(body),
      signal: watch.signal,
    })
  } catch (e) {
    if (!watch.gone()) throw new HttpError(503, redact((e as Error).message || 'upstream error', secret))
  } finally {
    watch.release()
  }
  // 客户端中途走了：没人收这份回答，按已知的用量记 failed（同流式那一岔）。
  if (watch.gone()) {
    res.end()
    return { usage: tokensOf(openaiUsage(message?.usage), message?.usage), status: 'failed' }
  }
  if (message?.stopReason === 'error' || message?.errorMessage) {
    throw new HttpError(503, redact(String(message.errorMessage || 'model error'), secret))
  }
  const text = Array.isArray(message?.content)
    ? message.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
    : ''
  const toolCalls = Array.isArray(message?.content)
    ? message.content
        .filter((c: any) => c.type === 'toolCall')
        .map((c: any) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
        }))
    : []
  json(res, 200, {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
      },
    ],
    usage: openaiUsage(message?.usage) ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  })
  return tokensOf(openaiUsage(message?.usage), message?.usage)
}

async function proxyUpstream(
  res: ServerResponse,
  opts: { url: string; headers: Record<string, string>; body: unknown; secret: string },
): Promise<RunOutcome> {
  // 客户端断了就别再拉上游：那边是按 token 计费的，没人读的字节一样要付钱。
  // 和 120s 超时合成一个信号——两个条件里先到的那个生效。「断了」看的是 res，
  // 不是 req（见 http.ts 的 watchClient）。
  const ac = new AbortController()
  const watch = watchClient(res, () => ac.abort())
  /** 人已经走了：没有人收这份响应，账按已知的那部分记 failed（同 streamChatCompletions）。 */
  const abandoned = (usage: TokenUsage | undefined): RunOutcome => {
    if (!res.writableEnded) res.end()
    return { usage, status: 'failed' }
  }
  /**
   * **这 120 秒只管到响应头为止。**
   *
   * 原先是 `AbortSignal.any([ac.signal, AbortSignal.timeout(120_000)])` 交给 fetch，
   * 而那个信号罩着的是**整次请求，正文也算**：一次 max_tokens 开大、或者带扩展思考的
   * 生成流上两分钟是常事，到点就被掐断——流式那边的读错误是刻意吞掉的（要保住已累计
   * 的 usage），于是客户端收到的是一条没有 message_stop、也没有任何错误帧的半截回答，
   * 而账上按一次正常调用记着。
   *
   * 所以计时器只用来防「连上了但迟迟不给响应头」，拿到头就撤掉；正文期间只剩下
   * 「客户端走了」这一个中断条件。
   */
  let headerTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => ac.abort(new Error('upstream did not send headers in 120s')),
    120_000,
  )
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
    watch.release()
    // 响应头还没到人就走了：没东西可转，也没有用量可记。
    if (watch.gone()) return abandoned(undefined)
    throw new HttpError(503, redact((e as Error).message || 'upstream unreachable', opts.secret))
  }
  clearHeaderTimer()
  const ctype = upstream.headers.get('content-type') || 'application/json; charset=utf-8'
  /**
   * **只有 2xx 才边收边转。**
   *
   * 非 2xx 是一页错误，不是回答：它得整页收下、过一遍 redact 再转出去——上游（或者它前面
   * 那层代理）的错误页常常把请求原样回显，而 `text/plain` 恰恰是这类错误页最常见的形状。
   * 以前只按类型判，这种错误页会走流式那一支，一个字节都不抹，密钥就原样交给了调用方。
   */
  const streaming = upstream.ok && (ctype.includes('text/event-stream') || ctype.includes('text/plain'))
  if (streaming) {
    res.writeHead(upstream.status, {
      'content-type': ctype,
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    })
    let usage: TokenUsage | undefined
    let buf = ''
    // 一个解码器从头用到尾：多字节字符会被切在两个 chunk 之间，每次新建解码器会把
    // 它解成替换字符，那一帧的 JSON 就 parse 不动，用量记录跟着丢。
    const decoder = new TextDecoder()
    const take = (piece: string | Buffer) => {
      const bytes = typeof piece === 'string' ? piece : Buffer.from(piece)
      res.write(bytes)
      buf += typeof piece === 'string' ? piece : decoder.decode(piece, { stream: true })
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
    // 读流放在 try 里：以前它在外面，任何中途失败（120s 超时会连响应体一起中止）都会
    // 一路抛出去，`res.end()` 和外层的 updateLlmCallTokens 都不执行——**这一次调用已经
    // 累计到的 token 全部丢掉**。断流是断流，账还是要记。
    if (upstream.body) {
      try {
        const reader = (upstream.body as any).getReader?.()
        if (reader) {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            take(typeof value === 'string' ? value : Buffer.from(value))
          }
        } else {
          for await (const chunk of upstream.body as any) {
            take(typeof chunk === 'string' ? chunk : Buffer.from(chunk))
          }
        }
      } catch {
        /* 中途断了：保留已经累计的 usage，下面照常收尾。 */
      }
    }
    watch.release()
    // 客户端中途走了：读流是被上面那个信号中止的，已经累计到的 usage 照记，状态记 failed。
    if (watch.gone()) return abandoned(usage)
    if (!res.writableEnded) res.end()
    return usage
  }
  let text: string
  try {
    text = redact(await upstream.text(), opts.secret)
  } catch (e) {
    if (watch.gone()) return abandoned(undefined)
    throw new HttpError(503, redact((e as Error).message || 'upstream error', opts.secret))
  } finally {
    watch.release()
  }
  res.writeHead(upstream.status, {
    'content-type': ctype.includes('json') ? 'application/json; charset=utf-8' : ctype,
    'cache-control': 'no-store',
  })
  res.end(text)
  try {
    const u = usageFromPayload(JSON.parse(text))
    return u ? mergeUsage(undefined, u) : undefined
  } catch {
    return undefined
  }
}

/**
 * OpenAI / Anthropic 兼容的模型代理。鉴权是席位 API Key（sk_sw_）或登录 JWT；
 * 上游供应商密钥只在 Gateway 里，响应永不回显。
 */
export function attachV1(router: Router, db: Db, keys: JwtKeys, llm: Llm, meter: Meter) {
  router.get('/v1/models', async (req, res) => {
    const account = await requireUser(req, db, keys)
    json(res, 200, { object: 'list', data: await publicModels(llm, account.companyId) })
  })

  router.post('/v1/chat/completions', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const body = bodyOf(req)
    const modelRaw = str(body.model)
    if (!modelRaw) throw new HttpError(400, 'model 不能为空')
    const hint = str(body.provider) || undefined
    const found = await resolveOr404(llm, account.companyId, modelRaw, hint)
    const secret = await secretOr402(llm, account.companyId, found.provider)
    await gateOr402(meter, account, found)
    const callId = await recordLlmCall(db, account, found)
    const stream = body.stream === true
    if (stream) {
      await withSettle(db, meter, account, found, callId, () => streamChatCompletions(res, llm, found, secret, body))
      return
    }
    await withSettle(db, meter, account, found, callId, () => completeChatCompletions(res, llm, found, secret, body))
  })

  router.post('/v1/responses', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const body = { ...bodyOf(req) }
    const modelRaw = str(body.model)
    if (!modelRaw) throw new HttpError(400, 'model 不能为空')
    const found = await resolveOr404(llm, account.companyId, modelRaw, str(body.provider) || 'openai')
    const secret = await secretOr402(llm, account.companyId, found.provider)
    const beta = req.headers['openai-beta']
    // 地址、头、请求体上改哪几处，全从 upstreamTargetOf 来——和管家中继同一份。这里
    // 以前是手搓的另一份（写死的主机 + 现拼的头），两份已经漂了：那一份不认 pi-ai 的
    // Model.baseUrl，也不带自定义供应商的 headers。走不走得通由它按**协议**判（见上面
    // 那段：按供应商名字夹的那道闸已经撤了）。
    //
    // **算目标排在 recordLlmCall 之前**：协议对不上是 400，压根没打上游，也就没有账
    // 可记。反过来的话每一次打错路由都在 llm_calls 里留一行 0 token、账本上没有对应行
    // 的孤儿——那正是 unledgeredCalls 那条横幅要数的东西，会被一个走错路的客户端刷高。
    // 授权那条路（routes/worker.ts 的 grant）本来就是这个顺序。
    const reasoning = body.reasoning as { effort?: unknown } | undefined
    const target = upstreamOr400(llm, found, 'responses', secret, {
      openaiBeta: typeof beta === 'string' && beta ? beta : undefined,
      reasoningEffort: typeof reasoning?.effort === 'string' ? reasoning.effort : undefined,
    })
    await gateOr402(meter, account, found)
    const callId = await recordLlmCall(db, account, found)
    applyBodyPatch(body, target.body)
    await withSettle(db, meter, account, found, callId, () =>
      proxyUpstream(res, {
        url: target.url,
        headers: { ...target.headers, 'content-type': 'application/json' },
        body,
        secret,
      }),
    )
  })

  router.post('/v1/messages', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const body = { ...bodyOf(req) }
    const modelRaw = str(body.model)
    if (!modelRaw) throw new HttpError(400, 'model 不能为空')
    const found = await resolveOr404(llm, account.companyId, modelRaw, str(body.provider) || 'anthropic')
    const secret = await secretOr402(llm, account.companyId, found.provider)
    const versionHeader = req.headers['anthropic-version']
    // 同 /v1/responses：地址和头一律走 upstreamTargetOf，不再在这里手搓一份；缺省的
    // `anthropic-version` 也归它（ANTHROPIC_VERSION 就在那边）。算目标同样排在
    // recordLlmCall 之前，理由见那条路由。
    const target = upstreamOr400(llm, found, 'messages', secret, {
      anthropicVersion: typeof versionHeader === 'string' && versionHeader ? versionHeader : undefined,
    })
    await gateOr402(meter, account, found)
    const callId = await recordLlmCall(db, account, found)
    applyBodyPatch(body, target.body)
    await withSettle(db, meter, account, found, callId, () =>
      proxyUpstream(res, {
        url: target.url,
        headers: { ...target.headers, 'content-type': 'application/json' },
        body,
        secret,
      }),
    )
  })
}
