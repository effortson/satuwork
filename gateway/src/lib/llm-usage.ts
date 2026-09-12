/**
 * 模型调用的用量解析：把 pi-ai / OpenAI / Anthropic 三种形状的 usage 折成同一份
 * `TokenUsage`，逐帧累积。**纯函数，不碰库、不碰网络。**
 *
 * 从 v1.ts 里抽出来，是因为同一份规矩要在两个进程里跑：Gateway 自己代理 /v1 时
 * （本地 Bot、还没重新部署的席位），和席位机器上的管家替 Bot 调上游时
 * （manager/src/llm-usage.ts 是这份的逐字副本，e2e 按字节钉着）。规矩错一条，两边
 * 的账就对不上——缓存那几项尤其容易漏，注释里记着每一次漏过的形状。
 */
const nonNegInt = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * pi 的 usage → OpenAI 线上格式。
 *
 * **`prompt_tokens` 报整个提示词，命中缓存的那部分也算在内。** pi 的 `input` 是
 * 未命中的那一截，上游一开前缀缓存它就只剩零头——实测一次约 2600 token 的提示词
 * 记成了 308，而 llm_calls 记的就是这个数，用量和账单跟着一起矮下去。
 *
 * 细分放 `prompt_tokens_details.cached_tokens`，跟 OpenAI 的约定一致。缓存读单价
 * 更低，但**不在这里折价**：目录里有单价，折算是计价那一层的事。
 */
export function openaiUsage(u: any) {
  if (!u) return undefined
  // pi 的形状（有 input/output）和已经是 OpenAI 形状的载荷（有 prompt_tokens）
  // 对「含不含缓存」的约定相反，必须分开处理，否则要么漏掉、要么加两遍。
  const isPi = u.input != null || u.output != null
  const cached_tokens = nonNegInt(isPi ? u.cacheRead : u.prompt_tokens_details?.cached_tokens)
  // 写进缓存的那一截也是**这次真发出去的提示词**，和缓存读一样要加回总量。
  // 只加缓存读的话，`fresh = prompt − cached − written` 会把一部分未命中的输入
  // 当成缓存写来计价——而缓存写比输入还贵。OpenAI 那一侧没有这个概念，也不需要加。
  const cache_write = isPi ? nonNegInt(u.cacheWrite) : 0
  const prompt = isPi ? u.input : u.prompt_tokens
  const completion = isPi ? u.output : u.completion_tokens
  if (prompt == null && completion == null) return undefined
  const prompt_tokens = nonNegInt(prompt) + (isPi ? cached_tokens + cache_write : 0)
  const completion_tokens = nonNegInt(completion)
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
    ...(cached_tokens ? { prompt_tokens_details: { cached_tokens } } : {}),
  }
}

export type TokenUsage = {
  prompt_tokens: number
  completion_tokens: number
  cached_tokens: number
  /**
   * prompt_tokens 里**这次写进缓存**的那一截。
   *
   * 不上线（`openaiUsage` 不返回它）：OpenAI 的 usage 里没有这个字段，往响应里塞一个
   * 自造的键，下游按 OpenAI 口径解析的东西会看到一个它不认识的数。它只走内部——
   * 落库、计价。缓存写比普通输入还贵（Anthropic 1.25 倍），漏掉它就是每次都少收。
   */
  cache_write_tokens: number
}

/** 一帧只报了一半是常事，所以缺的字段是 undefined，不是 0——0 会把上一帧盖掉。 */
export type PartialUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  cached_tokens?: number
  cache_write_tokens?: number
}

/**
 * pi / Anthropic 的 usage 里那一截「写进缓存」的 token。
 *
 * 单独一个函数，是因为它**不能**跟着 `openaiUsage` 上线（见 TokenUsage 的注释），
 * 所以取原始 usage 再捞一次。OpenAI 没有这个概念，取不到就是 0。
 */
export function cacheWriteOf(u: any): number {
  if (!u) return 0
  return nonNegInt(u.cacheWrite ?? u.cache_creation_input_tokens)
}

export function tokensOf(u: ReturnType<typeof openaiUsage>, raw?: unknown): TokenUsage | undefined {
  if (!u) return undefined
  return {
    prompt_tokens: u.prompt_tokens,
    completion_tokens: u.completion_tokens,
    cached_tokens: u.prompt_tokens_details?.cached_tokens ?? 0,
    cache_write_tokens: cacheWriteOf(raw),
  }
}

export function objectAt(o: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = o[key]
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

/**
 * usage 可能在顶层，也可能裹一层：OpenAI Responses 是 `response.usage`，
 * Anthropic 的 message_start 是 `message.usage`。只看顶层就会把输入 token 丢光。
 */
export function usageCandidates(obj: unknown): Record<string, unknown>[] {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return []
  const o = obj as Record<string, unknown>
  const out: Record<string, unknown>[] = []
  const push = (v: Record<string, unknown> | undefined) => {
    if (v) out.push(v)
  }
  push(objectAt(o, 'usage'))
  for (const key of ['response', 'message']) {
    const inner = objectAt(o, key)
    if (inner) push(objectAt(inner, 'usage'))
  }
  out.push(o)
  return out
}

/**
 * 从原样透传的上游响应里捞 usage。
 *
 * **缓存那几项要单独加回去。** Anthropic 的 `input_tokens` 不含
 * `cache_read_input_tokens` / `cache_creation_input_tokens`，只读前者就等于把命中缓存
 * 的提示词当成没发生过。OpenAI 的 `prompt_tokens` 相反，本来就是含缓存的总数，
 * 细分在 `prompt_tokens_details.cached_tokens` 里——所以两边不能用同一套加法。
 */
export function usageFromPayload(obj: unknown): PartialUsage | undefined {
  for (const raw of usageCandidates(obj)) {
    const openaiPrompt = raw.prompt_tokens
    const anthropicPrompt = raw.input_tokens ?? raw.input
    const prompt = openaiPrompt ?? anthropicPrompt
    const completion = raw.completion_tokens ?? raw.output_tokens ?? raw.output
    if (prompt == null && completion == null) continue
    /**
     * 三种形状，两套口径：
     *
     * - Chat Completions：`prompt_tokens` + `prompt_tokens_details.cached_tokens`；
     * - Responses API：`input_tokens` + `input_tokens_details.cached_tokens`——字段名和
     *   Anthropic 撞了，但口径跟 Chat 一样，`input_tokens` **已含**缓存命中；
     * - Anthropic：`input_tokens` + `cache_read_input_tokens` / `cache_creation_input_tokens`，
     *   `input_tokens` **不含**缓存，要加回去。
     *
     * 以前只按「有没有 prompt_tokens」二分，Responses 走进了 Anthropic 分支：读的是
     * 不存在的 `cache_read_input_tokens`，命中缓存的那截就按全价记了。
     * 判据是 `input_tokens_details` 这个对象在不在——Anthropic 的 usage 里没有它。
     */
    const chatDetails = objectAt(raw, 'prompt_tokens_details')
    const responsesDetails = objectAt(raw, 'input_tokens_details')
    const openaiShape = openaiPrompt != null || responsesDetails != null
    const readRaw = openaiPrompt != null ? chatDetails?.cached_tokens : responsesDetails != null ? responsesDetails.cached_tokens : raw.cache_read_input_tokens
    const writeRaw = openaiShape ? undefined : raw.cache_creation_input_tokens
    const cacheRead = nonNegInt(readRaw)
    // 写缓存的那部分也是这次真发出去的提示词，算进总量；但它不是「读到的缓存」，
    // 不进 cached_tokens——两者单价不同，而且缓存写**比普通输入还贵**。
    const cacheWrite = nonNegInt(writeRaw)
    const out: PartialUsage = {}
    const pt = Number(prompt)
    const ct = Number(completion)
    if (prompt != null && Number.isFinite(pt)) {
      out.prompt_tokens = openaiShape ? pt : pt + cacheRead + cacheWrite
      // **这一帧没带缓存字段就别写这个键。** 写成 0 的话，mergeUsage 取 next 优先，
      // 会把前面帧里记下的缓存 token 抹掉：Anthropic 的 message_start 报了
      // input 900 + cache_read 400，后面某个 message_delta 只回传累计 input_tokens
      // 而不重复缓存字段，最终就落库成 900/0——正是这次要修的那个漏记又回来了。
      if (readRaw != null) out.cached_tokens = cacheRead
      // 同上：这一帧没带就别写这个键，写成 0 会在 mergeUsage 里把前面帧记下的抹掉。
      if (writeRaw != null) out.cache_write_tokens = cacheWrite
    }
    if (completion != null && Number.isFinite(ct)) out.completion_tokens = ct
    if (out.prompt_tokens != null || out.completion_tokens != null) return out
  }
  return undefined
}

/**
 * 逐帧累积，不整块替换。Anthropic 把输入 token 放在 message_start、输出 token 放在
 * message_delta——整块替换的话最后一帧会把输入抹成 0。
 *
 * **取较大值，不是后来居上。** 一次请求的提示词大小是定值，各帧只是报得完整程度不同：
 * message_start 给 input 900 + cache_read 400（合成 1300），而某些版本的 message_delta
 * 会再回传一次累计 input_tokens 却不重复缓存字段（算出 900）。后来居上就会把 1300
 * 覆盖成 900，缓存那截又漏掉了。输出 token 在流式里是累计上报的，取大同样成立。
 */
export function mergeUsage(cur: TokenUsage | undefined, next: PartialUsage): TokenUsage {
  const pick = (a: number | undefined, b: number | undefined) => Math.max(a ?? 0, b ?? 0)
  return {
    prompt_tokens: pick(next.prompt_tokens, cur?.prompt_tokens),
    completion_tokens: pick(next.completion_tokens, cur?.completion_tokens),
    cached_tokens: pick(next.cached_tokens, cur?.cached_tokens),
    cache_write_tokens: pick(next.cache_write_tokens, cur?.cache_write_tokens),
  }
}
