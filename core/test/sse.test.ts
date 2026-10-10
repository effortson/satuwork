import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sseEvents } from '../src/chat/sse.ts'

function readerOf(chunks: string[]) {
  const enc = new TextEncoder()
  let i = 0
  return {
    read: async () => (i < chunks.length ? { done: false as const, value: enc.encode(chunks[i++]) } : { done: true as const, value: undefined }),
  } as unknown as ReadableStreamDefaultReader<Uint8Array>
}

async function collect(reader: ReadableStreamDefaultReader<Uint8Array>, stop?: () => boolean) {
  const out: any[] = []
  for await (const ev of sseEvents(reader, stop)) out.push(ev)
  return out
}

test('分帧：CRLF 归一、帧跨分片、一帧多行 data、ping 与坏 JSON 跳过', async () => {
  const out = await collect(readerOf(['data: {"a":1}\r\n\r\n: ping\n\ndata: {"b":', '2}\ndata: {"c":3}\n\ndata: not json\n\n']))
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }, { c: 3 }])
})

test('尾巴没有空行的那一帧不算（流还没完）；stop 在下一次 read 前生效', async () => {
  assert.deepEqual(await collect(readerOf(['data: {"a":1}\n'])), [])
  let n = 0
  const out = await collect(readerOf(['data: {"a":1}\n\n', 'data: {"b":2}\n\n']), () => n++ >= 1)
  assert.deepEqual(out, [{ a: 1 }])
})
