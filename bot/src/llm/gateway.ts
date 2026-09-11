import { AssistantMessageEventStream, EMPTY_USAGE, emptyAssistant, stubModel } from './stream.ts'

export function gatewayUrl(): string {
  return (process.env.GATEWAY_URL || '').replace(/\/$/, '')
}

/**
 * 模型调用（所有 `/v1/*`：目录、补全）打哪里。
 *
 * 管家部署出来的席位会多拿一个 `GATEWAY_LLM_URL`（形如 `http://127.0.0.1:8443/llm`）：
 * 模型调用由**同机的管家转发**，provider 密钥只在管家进程里，从不进 bot 进程；而
 * Gateway 搬上 Vercel 之后也不再替席位流式转发模型输出——函数有时长上限，一条
 * 几分钟的流撑不住。所以 `/v1/*` 走这里，其余（会话上传、/internal、日常任务）
 * 照旧走 `GATEWAY_URL`。鉴权头不变，还是 `Bearer GATEWAY_API_KEY`，管家原样带过去。
 *
 * 没设就退回 `GATEWAY_URL`：本地桌面 bot 和老席位一个字都不用改。
 */
export function llmBaseUrl(): string {
  return (process.env.GATEWAY_LLM_URL || process.env.GATEWAY_URL || '').replace(/\/$/, '')
}

export function gatewayToken(): string {
  return (process.env.GATEWAY_TOKEN || '').trim()
}

export function gatewayApiKey(): string {
  return (process.env.GATEWAY_API_KEY || '').trim()
}

function apiFor(provider: string) {
  if (provider === 'anthropic') return '/v1/messages'
  return '/v1/chat/completions'
}

type ReasoningLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
type GatewayStreamOptions = { signal?: AbortSignal; reasoning?: ReasoningLevel }

function reasoningLevel(options?: GatewayStreamOptions): Exclude<ReasoningLevel, 'off'> | undefined {
  const level = options?.reasoning
  return level && level !== 'off' ? level : undefined
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c === 'string' ? c : c?.text ?? c?.thinking ?? ''))
      .join('')
  }
  return content == null ? '' : String(content)
}

/**
 * 用户消息 → provider 的 content。
 *
 * 有图就必须是数组，没图就还给字符串——后者是绝大多数消息，多包一层数组只会让
 * 请求体变胖，也让抓包出来的东西不好认。
 *
 * pi 的 ImageContent 是 `{type:'image', data, mimeType}`（data 是 base64），两家
 * provider 的字段名各不相同，所以在各自的转换函数里分别摊平。
 */
function userContent(content: unknown, image: (c: any) => any): any {
  if (!Array.isArray(content)) return contentText(content)
  if (!content.some((c: any) => c?.type === 'image')) return contentText(content)
  return content
    .map((c: any) => (c?.type === 'image' ? image(c) : { type: 'text', text: c?.text ?? '' }))
    .filter((c: any) => c.type !== 'text' || c.text)
}

export function toOpenAI(context: any, model: { provider: string; id: string }, options?: GatewayStreamOptions) {
  const messages: any[] = []
  if (context.systemPrompt) messages.push({ role: 'system', content: context.systemPrompt })
  for (const m of context.messages ?? []) {
    if (m.role === 'user') {
      // OpenAI 走 data URI：`image_url.url` 里塞 `data:<mime>;base64,<...>`。
      messages.push({
        role: 'user',
        content: userContent(m.content, (c) => ({
          type: 'image_url',
          image_url: { url: `data:${c.mimeType || 'image/png'};base64,${c.data}` },
        })),
      })
    } else if (m.role === 'assistant') {
      const text = (m.content ?? [])
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('')
      const tool_calls = (m.content ?? [])
        .filter((c: any) => c.type === 'toolCall')
        .map((c: any) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}) },
        }))
      const row: any = { role: 'assistant', content: text || null }
      if (tool_calls.length) row.tool_calls = tool_calls
      messages.push(row)
    } else if (m.role === 'toolResult') {
      messages.push({
        role: 'tool',
        tool_call_id: m.toolCallId,
        content: contentText(m.content),
      })
    }
  }
  const tools = (context.tools ?? []).map((t: any) => ({
    type: 'function',
    function: { name: t.name, description: t.description ?? '', parameters: t.parameters ?? { type: 'object', properties: {} } },
  }))
  return {
    model: `${model.provider}/${model.id}`,
    provider: model.provider,
    messages,
    ...(tools.length ? { tools } : {}),
    stream: true,
    ...(reasoningLevel(options) ? { reasoning_effort: reasoningLevel(options) } : {}),
  }
}

export function toAnthropic(context: any, model: { id: string; maxTokens?: number }, options?: GatewayStreamOptions) {
  const messages: any[] = []
  for (const m of context.messages ?? []) {
    if (m.role === 'user') {
      // Anthropic 要 source 对象，不认 data URI。
      messages.push({
        role: 'user',
        content: userContent(m.content, (c) => ({
          type: 'image',
          source: { type: 'base64', media_type: c.mimeType || 'image/png', data: c.data },
        })),
      })
    } else if (m.role === 'assistant') {
      const content: any[] = []
      for (const c of m.content ?? []) {
        if (c.type === 'text' && c.text) content.push({ type: 'text', text: c.text })
        else if (c.type === 'toolCall') content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments ?? {} })
      }
      if (!content.length) content.push({ type: 'text', text: '' })
      messages.push({ role: 'assistant', content })
    } else if (m.role === 'toolResult') {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.toolCallId,
            content: contentText(m.content),
            is_error: !!m.isError,
          },
        ],
      })
    }
  }
  const tools = (context.tools ?? []).map((t: any) => ({
    name: t.name,
    description: t.description ?? '',
    input_schema: t.parameters ?? { type: 'object', properties: {} },
  }))
  const level = reasoningLevel(options)
  const ceiling = Math.max(1, Number(model.maxTokens) || 8192)
  const wanted = level === 'minimal' ? 1024 : level === 'low' ? 2048 : level === 'medium' ? 8192 : level ? 16384 : 0
  // Anthropic 的 max_tokens 同时包住思考和正文；至少给正文留 1024 token。
  const budget = level ? Math.min(wanted, Math.max(0, ceiling - 1024)) : 0
  return {
    model: model.id,
    system: context.systemPrompt || undefined,
    messages,
    max_tokens: ceiling,
    stream: true,
    ...(tools.length ? { tools } : {}),
    ...(budget ? { thinking: { type: 'enabled', budget_tokens: budget } } : {}),
  }
}

async function* readSse(
  res: Response,
  kick: (bytes?: number) => void = () => {},
): AsyncGenerator<{ event?: string; data: string }> {
  const reader = res.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    // 判据是**收到字节**，不是收到事件：SSE 的心跳注释（`:` 开头）解析不出事件，
    // 但它恰恰是「这条连接还活着」最本分的证据。
    kick(value?.length ?? 0)
    buf += decoder.decode(value, { stream: true })
    buf = buf.replace(/\r\n/g, '\n')
    let idx
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      if (!raw.trim()) continue
      let event: string | undefined
      const data: string[] = []
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
      }
      yield { event, data: data.join('\n') }
    }
  }
}

function fail(stream: AssistantMessageEventStream, model: any, message: string) {
  const error = emptyAssistant(model, message)
  stream.push({ type: 'error', reason: 'error', error })
}

async function consumeOpenAI(
  res: Response,
  stream: AssistantMessageEventStream,
  model: any,
  kick: (bytes?: number) => void = () => {},
) {
  let partial: any = emptyAssistant(model)
  let started = false
  let textIndex = -1
  /**
   * 上游 `tool_calls[].index` → 我们 `content[]` 里的下标。
   *
   * **两个下标不是一回事。** 上游那个是「这是第几把工具」，我们这个数组里还躺着正文
   * 块。拿前者当后者用会出两种事故，线上都见过：
   *
   * - 正文先来（`content[0]` 是文字），随后 `index:0` 的工具增量落到**正文块**上，
   *   第一把工具就此消失——界面上不留任何痕迹，模型却以为自己调了。
   * - 反过来，正文走的是 `reasoning_content`（这一路我们不收进 content），而上游按
   *   整条消息给下标，工具从 `index:1` 起：`while` 循环为了填到 1，先在 0 位补出一个
   *   **空壳** `{name:'', id:''}`。它照样会被 pi 拿去执行，找不到叫「」的工具，于是
   *   每一轮开头都挂一颗红色的「tool · 失败」，点开里面什么都没有。
   *
   * 改成按 key 记账：**有增量才建块**，块建在数组末尾，两个下标各归各的。
   */
  const toolSlot = new Map<number, number>()
  const start = () => {
    if (started) return
    started = true
    stream.push({ type: 'start', partial })
  }
  /**
   * 收口了，但**先不推 done**——等这条流真的读完。
   *
   * 上游在流已经开着的时候出事（限流、过载、供应商 5xx），Gateway 那边是**先写一个
   * finish 块、再写错误帧**（见 gateway/src/v1.ts 的 case 'error'）：读到 finish 就
   * return 的话，那一帧永远读不到，一次上游报错在这儿变成「正常收口的空回答」——
   * errorMessage 没人置，runTurn 查不出失败，空消息又不入日志，最后按 completed 落库。
   */
  let finished: { reason: string; message: any } | null = null
  for await (const ev of readSse(res, kick)) {
    if (ev.data === '[DONE]') break
    let chunk: any
    try {
      chunk = JSON.parse(ev.data)
    } catch {
      continue
    }
    if (chunk.error) {
      fail(stream, model, chunk.error.message || JSON.stringify(chunk.error))
      return
    }
    // 收口之后只等错误帧，别的一概不看。
    if (finished) continue
    const choice = chunk.choices?.[0] ?? {}
    const delta = choice.delta ?? {}
    if (delta.role) start()
    if (typeof delta.content === 'string' && delta.content) {
      start()
      if (textIndex < 0) {
        textIndex = partial.content.length
        partial = { ...partial, content: [...partial.content, { type: 'text', text: '' }] }
        stream.push({ type: 'text_start', contentIndex: textIndex, partial })
      }
      partial.content[textIndex].text += delta.content
      partial = { ...partial, content: [...partial.content] }
      stream.push({ type: 'text_delta', contentIndex: textIndex, delta: delta.content, partial })
    }
    if (Array.isArray(delta.tool_calls)) {
      start()
      for (const tc of delta.tool_calls) {
        // 没给 index 的（一次给全的非流式风格）按到达顺序排，各占一格。
        const key = typeof tc.index === 'number' ? tc.index : toolSlot.size
        let idx = toolSlot.get(key)
        if (idx === undefined) {
          // Number()：partial 是 any，直接赋值不会把 idx 从 number|undefined 收窄。
          idx = Number(partial.content.length)
          toolSlot.set(key, idx)
          partial.content.push({ type: 'toolCall', id: '', name: '', arguments: {} })
          stream.push({ type: 'toolcall_start', contentIndex: idx, partial })
        }
        const block = partial.content[idx]
        if (tc.id) block.id = tc.id
        if (tc.function?.name) block.name = tc.function.name
        if (tc.function?.arguments) {
          const prev = typeof block._raw === 'string' ? block._raw : ''
          block._raw = prev + tc.function.arguments
          try {
            block.arguments = JSON.parse(block._raw)
          } catch {
            block.arguments = {}
          }
          stream.push({ type: 'toolcall_delta', contentIndex: idx, delta: tc.function.arguments, partial })
        }
      }
    }
    if (choice.finish_reason) {
      if (textIndex >= 0) {
        stream.push({ type: 'text_end', contentIndex: textIndex, content: partial.content[textIndex].text, partial })
      }
      for (let i = 0; i < partial.content.length; i++) {
        if (partial.content[i].type === 'toolCall') {
          delete partial.content[i]._raw
          stream.push({ type: 'toolcall_end', contentIndex: i, toolCall: partial.content[i], partial })
        }
      }
      const reason = choice.finish_reason === 'tool_calls' ? 'toolUse' : choice.finish_reason === 'length' ? 'length' : 'stop'
      const u = chunk.usage
      if (u) {
        // Gateway 报的 prompt_tokens 是**整个提示词**，命中缓存的那截在
        // prompt_tokens_details.cached_tokens 里单列。pi 的 input 按约定不含缓存，
        // 所以要减掉——不减的话「上下文占了多少」那条会把缓存部分算两遍。
        const cacheRead = Math.max(0, Number(u.prompt_tokens_details?.cached_tokens ?? 0) || 0)
        const prompt = Math.max(0, Number(u.prompt_tokens ?? 0) || 0)
        partial.usage = {
          input: Math.max(0, prompt - cacheRead),
          output: u.completion_tokens ?? 0,
          cacheRead,
          cacheWrite: 0,
          totalTokens: u.total_tokens ?? 0,
          cost: { ...EMPTY_USAGE.cost },
        }
      }
      partial.stopReason = reason
      finished = { reason, message: partial }
      continue
    }
  }
  if (finished) {
    stream.push({ type: 'done', reason: finished.reason, message: finished.message })
    return
  }
  if (!started) {
    fail(stream, model, 'empty stream')
    return
  }
  stream.push({ type: 'done', reason: 'stop', message: partial })
}

async function consumeAnthropic(
  res: Response,
  stream: AssistantMessageEventStream,
  model: any,
  kick: (bytes?: number) => void = () => {},
) {
  let partial: any = emptyAssistant(model)
  let started = false
  const start = () => {
    if (started) return
    started = true
    stream.push({ type: 'start', partial })
  }
  for await (const ev of readSse(res, kick)) {
    if (!ev.data || ev.data === '[DONE]') continue
    let chunk: any
    try {
      chunk = JSON.parse(ev.data)
    } catch {
      continue
    }
    const type = ev.event || chunk.type
    if (type === 'message_start') {
      start()
      continue
    }
    if (type === 'content_block_start') {
      start()
      const block = chunk.content_block ?? {}
      const index = chunk.index ?? partial.content.length
      if (block.type === 'tool_use') {
        while (partial.content.length <= index) partial.content.push({ type: 'toolCall', id: '', name: '', arguments: {} })
        partial.content[index] = { type: 'toolCall', id: block.id, name: block.name, arguments: block.input ?? {}, _raw: '' }
        stream.push({ type: 'toolcall_start', contentIndex: index, partial })
      } else {
        while (partial.content.length <= index) partial.content.push({ type: 'text', text: '' })
        partial.content[index] = { type: 'text', text: block.text ?? '' }
        stream.push({ type: 'text_start', contentIndex: index, partial })
      }
      continue
    }
    if (type === 'content_block_delta') {
      const index = chunk.index ?? 0
      const delta = chunk.delta ?? {}
      if (delta.type === 'text_delta' && delta.text) {
        if (!partial.content[index]) partial.content[index] = { type: 'text', text: '' }
        partial.content[index].text += delta.text
        stream.push({ type: 'text_delta', contentIndex: index, delta: delta.text, partial })
      } else if (delta.type === 'input_json_delta' && delta.partial_json) {
        const block = partial.content[index]
        if (block) {
          block._raw = (block._raw || '') + delta.partial_json
          try {
            block.arguments = JSON.parse(block._raw)
          } catch {
            block.arguments = {}
          }
          stream.push({ type: 'toolcall_delta', contentIndex: index, delta: delta.partial_json, partial })
        }
      }
      continue
    }
    if (type === 'content_block_stop') {
      const index = chunk.index ?? 0
      const block = partial.content[index]
      if (block?.type === 'text') stream.push({ type: 'text_end', contentIndex: index, content: block.text, partial })
      else if (block?.type === 'toolCall') {
        delete block._raw
        stream.push({ type: 'toolcall_end', contentIndex: index, toolCall: block, partial })
      }
      continue
    }
    if (type === 'message_delta') {
      const stop = chunk.delta?.stop_reason
      if (stop === 'tool_use') partial.stopReason = 'toolUse'
      else if (stop === 'max_tokens') partial.stopReason = 'length'
      else partial.stopReason = 'stop'
      const u = chunk.usage
      if (u) {
        // Anthropic 的 input_tokens **不含**缓存的两项，各自单列，直接照搬即可。
        const input = u.input_tokens ?? 0
        const cacheRead = u.cache_read_input_tokens ?? 0
        const cacheWrite = u.cache_creation_input_tokens ?? 0
        partial.usage = {
          input,
          output: u.output_tokens ?? 0,
          cacheRead,
          cacheWrite,
          totalTokens: input + cacheRead + cacheWrite + (u.output_tokens ?? 0),
          cost: { ...EMPTY_USAGE.cost },
        }
      }
      continue
    }
    if (type === 'message_stop') {
      const reason = partial.stopReason === 'toolUse' ? 'toolUse' : partial.stopReason === 'length' ? 'length' : 'stop'
      stream.push({ type: 'done', reason, message: partial })
      return
    }
    if (type === 'error' || chunk.error) {
      fail(stream, model, chunk.error?.message || chunk.message || 'anthropic error')
      return
    }
  }
  if (!started) fail(stream, model, 'empty stream')
  else stream.push({ type: 'done', reason: 'stop', message: partial })
}

/**
 * 一条模型流「多久没动静就判死」。
 *
 * 原来一个超时都没有：fetch 不带 timeout，读循环是 `for await (readSse(res))`，也没有
 * 空闲上限。上游静默断掉时——中间那一跳掐了连接却不发 FIN，长连接上很常见——这个
 * 循环**永远不会返回**，往下是一串多米诺：
 *
 *   stream.end() 不会被调 → agent.prompt() 不返回 → runTurn 的 finally 不跑
 *   → 没有 turn/end 写进日志、live 表里那条也不删
 *   → isRunning() 永远是真 → 界面上永远挂着「正在处理」，等多久都不变。
 *
 * 而且这个死法最难查：进程活着、端口听着、systemd 说 active，什么都没报错。
 *
 * 判据是「多久没收到**任何字节**」，不是「一共跑了多久」——一轮长回答可以正当地跑
 * 很久，但正当的流不会两分钟一个字节都不吐。推理模型出第一个 token 前的静默也在这
 * 个量级之内。要调就改 SATUWORK_LLM_IDLE_MS。
 */
const LLM_IDLE_MS = Math.max(1_000, Number(process.env.SATUWORK_LLM_IDLE_MS) || 120_000)

export async function streamViaGateway(model: any, context: any, options?: GatewayStreamOptions) {
  const stream = new AssistantMessageEventStream()
  // 计时从**建连之前**就开始：连不上、或者连上了迟迟不给响应头，一样得有人叫停。
  const idle = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  /**
   * 超时到了就**自己收口**，不等连接真断。
   *
   * 只 abort 是不够的：实测上游静默时，abort 之后那个 `reader.read()` 还要等到对端
   * keep-alive 到期（5 秒）才真的醒过来——而「等 socket 自己死掉」恰恰就是这个 bug
   * 本身。要保的是「这一轮一定会结束」，不是「连接一定关得掉」，所以先把流收了，
   * abort 只是顺手把资源放掉。
   *
   * push 之后 EventStream 就 done 了，之后迟到的事件和 end() 都会被它自己忽略。
   */
  let closed = false
  let bytes = 0
  const at = Date.now()
  const giveUp = () => {
    if (closed) return
    closed = true
    // **这一行要显眼**：它说的是「有一轮本来会永远卡住，被我掐了」。没有它，
    // 界面上只会看到一句莫名其妙的错误，谁也不会想到是上游静默断开。
    console.error(
      `[WARN] llm: ${model?.provider}/${model?.id} 静默 ${Math.round(LLM_IDLE_MS / 1000)}s 判定断开` +
        `（已收 ${bytes} 字节，起于 ${Math.round((Date.now() - at) / 1000)}s 前）`,
    )
    fail(stream, model, `模型流 ${Math.round(LLM_IDLE_MS / 1000)} 秒没有任何数据，判定上游已断开`)
    stream.end()
    idle.abort()
  }
  const kick = (n = 0) => {
    bytes += n
    clearTimeout(timer)
    timer = setTimeout(giveUp, LLM_IDLE_MS)
  }
  /**
   * 失败原因。自己叫停的一律说成超时。
   *
   * 静默有两种，落点不一样：连上了迟迟不给响应头，abort 落在 fetch 的 catch 里；
   * 头给了、正文半路不来了，落在读循环。两条路都得说清是「上游没了」——原样报
   * abort 的话，界面上只有一句「This operation was aborted」，看不出是超时还是
   * 人点了停止。
   */
  const reasonOf = (e: unknown, prefix = '') =>
    idle.signal.aborted
      ? `模型流 ${Math.round(LLM_IDLE_MS / 1000)} 秒没有任何数据，判定上游已断开`
      : prefix + (e as Error).message
  kick()
  const signal = options?.signal ? AbortSignal.any([options.signal, idle.signal]) : idle.signal
  const run = async () => {
    const base = llmBaseUrl()
    if (!base) {
      fail(stream, model, '未配置 GATEWAY_LLM_URL / GATEWAY_URL')
      return
    }
    const apiKey = gatewayApiKey()
    if (!apiKey) {
      fail(stream, model, '未配置 GATEWAY_API_KEY')
      return
    }
    const provider = model.provider || 'deepseek'
    const path = apiFor(provider)
    const body = path === '/v1/messages' ? toAnthropic(context, model, options) : toOpenAI(context, model, options)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    }
    if (path === '/v1/messages') headers['anthropic-version'] = '2023-06-01'
    let res: Response
    try {
      res = await fetch(base + path, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      })
    } catch (e) {
      fail(stream, model, reasonOf(e, 'Gateway 不可达：'))
      return
    }
    const ctype = res.headers.get('content-type') || ''
    if (!res.ok && !ctype.includes('text/event-stream')) {
      const text = await res.text()
      let msg = text
      try {
        const j = JSON.parse(text)
        msg = j.error?.message || j.error || text
      } catch {}
      fail(stream, model, typeof msg === 'string' ? msg : JSON.stringify(msg))
      return
    }
    if (path === '/v1/messages') await consumeAnthropic(res, stream, model, kick)
    else await consumeOpenAI(res, stream, model, kick)
    console.log(`[INFO] llm: ${model?.provider}/${model?.id} 收流结束（${bytes} 字节，${Date.now() - at}ms）`)
  }
  void run()
    .catch((e) => fail(stream, model, reasonOf(e)))
    .finally(() => {
      clearTimeout(timer)
      stream.end()
    })
  return stream
}

export { stubModel }
