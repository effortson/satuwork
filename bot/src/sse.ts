/**
 * bot 这一侧读 SSE 的两种姿势，规则收在这一处：CRLF 归一、`\n\n` 分帧、`data:` 行取冒号后面
 * 那段（去掉两头空白）、空的和 `[DONE]` 跳过、认不出 JSON 的那一行丢掉。
 *
 * 这几条每一条都是「写错了不报错、只是偶尔悄悄丢一帧」的规则，抄一份就多一个悄悄丢帧的地方。
 * 浏览器那份在 core/src/chat/sse.ts——那边是给 UI 打的包，这边不依赖它，改分帧规则时两边一起改。
 */

/** 一行里的 data 载荷；不是 data 行、空的、`[DONE]` 给 undefined。 */
function dataOf(line: string): string | undefined {
  if (!line.startsWith('data:')) return undefined
  const payload = line.slice(5).trim()
  return payload && payload !== '[DONE]' ? payload : undefined
}

/**
 * 一整段 SSE 正文 → 每条 `data:` 行解出来的 JSON，按出现顺序。给「整段读完再解析」的那几处用
 * （生图的答复、MCP 的 JSON-RPC 响应）。要哪几条由调用方挑：生图全要，MCP 只要最后一条。
 */
export function ssePayloads(text: string): unknown[] {
  const out: unknown[] = []
  for (const frame of text.replace(/\r\n/g, '\n').split('\n\n')) {
    for (const line of frame.split('\n')) {
      const payload = dataOf(line)
      if (payload === undefined) continue
      try {
        out.push(JSON.parse(payload))
      } catch {}
    }
  }
  return out
}

/** 边读边解：一条流 → 一个个事件（local-routines / local-tasks 盯自己那一轮用）。 */
export async function* sseEvents<T>(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<T> {
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    // 归一化对整个缓冲做，不只对新来的这一块：`\r` 和 `\n` 可能正好被切在两块里。
    buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n')
    let idx: number
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      for (const line of frame.split('\n')) {
        const payload = dataOf(line)
        if (payload === undefined) continue
        try {
          yield JSON.parse(payload) as T
        } catch {}
      }
    }
  }
}
