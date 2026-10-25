/**
 * 一整段 SSE 正文 → 每条 `data:` 行解出来的 JSON，按出现顺序。
 *
 * 空行、`[DONE]`、不是 JSON 的 data 行都丢掉。给「整段读完再解析」的那几处用（生图的答复、
 * MCP 的 JSON-RPC 响应）；边读边解的流不走这里。要哪几条由调用方挑：生图全要，MCP 只要最后一条。
 */
export function ssePayloads(text: string): unknown[] {
  const out: unknown[] = []
  for (const frame of text.split(/\r?\n\r?\n/)) {
    for (const line of frame.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        out.push(JSON.parse(payload))
      } catch {}
    }
  }
  return out
}
