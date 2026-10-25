/**
 * 一条 SSE 拆成一个个事件。原先在 gateway/ui/state.js；名册流、日志流、对话流共用。
 *
 * 分帧规则收在这一处：CRLF 归一化、`\n\n` 分帧、一帧里可能有多行 `data:`、认不出
 * JSON 的那一行跳过。这几条每一条都是「写错了不报错、只是偶尔悄悄丢一帧」的规则，
 * 抄一份就多一个悄悄丢帧的地方。
 *
 * `stop` 在每次 read 之前问一次。事件本身怎么处理、处理时抛了怎么办，由调用方管——
 * 这里只负责把字节变成事件。
 *
 * `hooks` 给对话流用（chat-stream.js 的 startChatStream）：它要在**每一块字节**上记一次脉搏
 * （`: ping` 也算，它证明这条链活着），还要知道这一块里**有没有真的 `data:` 行**——重放
 * 看门狗只认后者，脉搏和「重放在推进」是两件事。不给就和以前一样。
 */
export interface SseHooks {
  /** 读到一块字节、解析之前。返回 `false` 就当流到头了（这一块不解析）。 */
  onChunk?: () => boolean | void
  /** 这一块里切得出的帧都交完了；`sawData` = 其中有没有 `data:` 行（认不出 JSON 的也算）。 */
  onBatch?: (sawData: boolean) => void
}

export async function* sseEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  stop: () => boolean = () => false,
  hooks: SseHooks = {},
): AsyncGenerator<any, void, void> {
  const decoder = new TextDecoder()
  let buf = ''
  while (!stop()) {
    const { done, value } = await reader.read()
    if (done) return
    if (hooks.onChunk && hooks.onChunk() === false) return
    // 归一化对整个缓冲做，不只对新来的这一块：`\r` 和 `\n` 可能正好被切在两块里。
    buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n')
    let sawData = false
    let idx
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue
        sawData = true
        let ev
        try {
          ev = JSON.parse(line.slice(6))
        } catch {
          continue
        }
        yield ev
      }
    }
    if (hooks.onBatch) hooks.onBatch(sawData)
  }
}
