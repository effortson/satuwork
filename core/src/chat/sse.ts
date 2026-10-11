/**
 * 一条 SSE 拆成一个个事件。原先在 gateway/ui/state.js；名册流、日志流、移动端的对话流共用。
 *
 * 分帧规则收在这一处：CRLF 归一化、`\n\n` 分帧、一帧里可能有多行 `data:`、认不出
 * JSON 的那一行跳过。这几条每一条都是「写错了不报错、只是偶尔悄悄丢一帧」的规则，
 * 抄一份就多一个悄悄丢帧的地方。
 *
 * 和 gateway/src/lib/runtime.ts 里那个同名函数是同一套语义，但**不能共用**：那边是
 * 服务端模块。改分帧规则时两边一起改。
 *
 * `stop` 在每次 read 之前问一次。事件本身怎么处理、处理时抛了怎么办，由调用方管——
 * 这里只负责把字节变成事件。
 */
export async function* sseEvents(reader: ReadableStreamDefaultReader<Uint8Array>, stop: () => boolean = () => false): AsyncGenerator<any, void, void> {
  const decoder = new TextDecoder()
  let buf = ''
  while (!stop()) {
    const { done, value } = await reader.read()
    if (done) return
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    let idx
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue
        let ev
        try {
          ev = JSON.parse(line.slice(6))
        } catch {
          continue
        }
        yield ev
      }
    }
  }
}
